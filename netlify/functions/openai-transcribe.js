/**
 * Netlify Function: openai-transcribe
 * Proxies audio/video transcription requests to OpenAI /v1/audio/transcriptions.
 *
 * Uses Node.js built-in https module and manually-built multipart/form-data
 * to avoid Blob/FormData compatibility issues in the Node.js Lambda runtime.
 *
 * Payload limit: ~4 MB raw file (base64 adds ~33% overhead, Lambda cap is 6 MB).
 *
 * Required env vars:
 *   OPENAI_API_KEY    -- OpenAI secret key
 *   SUPABASE_URL      -- https://xxx.supabase.co
 *   SUPABASE_ANON_KEY -- anon key for JWT validation
 */

const https = require('https');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Api-Key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const CREDIT_COST = 2; // credits per transcription (tune as needed)

// Read balance via Supabase admin API; spend atomically via spend_credits RPC.
// The credit gate in the handler now fails CLOSED if the balance can't be verified.
async function _readBalance(userId) {
  const svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!svc || !process.env.SUPABASE_URL) return null;
  try {
    const r = await fetch(process.env.SUPABASE_URL + '/auth/v1/admin/users/' + userId, { headers: { 'Authorization': 'Bearer ' + svc, 'apikey': svc } });
    if (!r.ok) return null;
    const d = await r.json();
    return d?.app_metadata?.credits_balance ?? 0;
  } catch(_) { return null; }
}
// Atomic credit spend via the spend_credits RPC — no read-modify-write race, and it
// can't clobber a concurrent charge. Returns new balance, -1 if insufficient, null on error.
async function _spend(userId, amount) {
  const svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!svc || !process.env.SUPABASE_URL) return null;
  try {
    const r = await fetch(process.env.SUPABASE_URL + '/rest/v1/rpc/spend_credits', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + svc, 'apikey': svc, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_user: userId, p_amount: amount }),
    });
    if (!r.ok) return null;
    const n = await r.json();
    const v = (typeof n === 'number') ? n : parseInt(n, 10);
    return Number.isFinite(v) ? v : null;
  } catch(_) { return null; }
}

// FIX: Added JWT auth -- previously this was an open proxy; any caller could
// make unlimited Whisper transcription calls billed to the account.
function getAuthUser(jwt) {
  return new Promise((resolve) => {
    const url = new URL((process.env.SUPABASE_URL || '') + '/auth/v1/user');
    const req = https.request({
      hostname: url.hostname,
      path:     url.pathname,
      method:   'GET',
      headers: {
        'Authorization': 'Bearer ' + jwt,
        'apikey':        process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_ANON || '',
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          resolve(res.statusCode === 200 && data.id ? data : null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: { message: 'Method not allowed' } }),
    };
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: { message: 'OpenAI API key not configured on server.' } }),
    };
  }

  // Auth: require valid Supabase JWT
  if (!process.env.SUPABASE_URL) {
    return {
      statusCode: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: { message: 'Server configuration error.' } }),
    };
  }
  const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
  const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!jwt) {
    return {
      statusCode: 401,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: { message: 'Authentication required.' } }),
    };
  }
  const authUser = await getAuthUser(jwt);
  if (!authUser) {
    return {
      statusCode: 401,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: { message: 'Invalid or expired session.' } }),
    };
  }

  // Credit gate — fail CLOSED: if the balance can't be verified, refuse rather than
  // hand out un-metered transcription calls.
  const _bal = await _readBalance(authUser.id);
  if (_bal == null) {
    return { statusCode: 503, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: { message: 'Could not verify credit balance. Please retry.' } }) };
  }
  if (_bal < CREDIT_COST) {
    return { statusCode: 402, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: { message: 'Out of credits.' }, balance: _bal, cost: CREDIT_COST }) };
  }

  let parsed;
  try {
    parsed = JSON.parse(event.body || '{}');
  } catch {
    return {
      statusCode: 400,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: { message: 'Invalid JSON body.' } }),
    };
  }

  const { audioBase64, fileName, model, response_format, timestamp_granularities, language } = parsed;

  if (!audioBase64) {
    return {
      statusCode: 400,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: { message: 'Missing audioBase64 field.' } }),
    };
  }

  try {
    const audioBuffer = Buffer.from(audioBase64, 'base64');

    // Map file extension -> MIME type (Whisper accepts audio + video containers)
    // Sanitize filename: strip special chars to prevent Content-Disposition header injection
    const rawName  = fileName || 'audio.mp4';
    const sanitized = rawName.replace(/[^\w.\-]/g, '_').slice(0, 100) || 'audio.mp4';
    const mimeMap = {
      mp4:  'video/mp4',  mov:  'video/quicktime', webm: 'audio/webm',
      mp3:  'audio/mpeg', wav:  'audio/wav',        m4a:  'audio/m4a',
      ogg:  'audio/ogg',  flac: 'audio/flac',       mpeg: 'audio/mpeg',
    };
    // Extract extension; if missing or unrecognised, default to mp4.
    // Whisper determines format from the filename extension in the multipart
    // Content-Disposition -- a missing or unknown extension causes the
    // "UNRECOGNIZED FILE FORMAT" error even when the bytes are valid MP4.
    const rawExt = sanitized.includes('.') ? sanitized.split('.').pop().toLowerCase() : '';
    const ext = (rawExt && mimeMap[rawExt]) ? rawExt : 'mp4';
    // Ensure the filename that reaches Whisper always carries a known extension.
    const safeFileName = (rawExt && mimeMap[rawExt])
      ? sanitized
      : (sanitized.replace(/\.[^.]*$/, '') || 'audio') + '.' + ext;
    const mimeType = mimeMap[ext];

    // Build multipart/form-data manually -- avoids Blob/FormData Node.js quirks
    const boundary = '----OpenAIBoundary' + Date.now().toString(36) + Math.random().toString(36).slice(2);
    const CRLF = '\r\n';

    const parts = [];

    // file field
    parts.push(Buffer.from(
      '--' + boundary + CRLF +
      'Content-Disposition: form-data; name="file"; filename="' + safeFileName + '"' + CRLF +
      'Content-Type: ' + mimeType + CRLF + CRLF,
      'utf8'
    ));
    parts.push(audioBuffer);
    parts.push(Buffer.from(CRLF, 'utf8'));

    // model field
    parts.push(Buffer.from(
      '--' + boundary + CRLF +
      'Content-Disposition: form-data; name="model"' + CRLF + CRLF +
      (model || 'whisper-1') + CRLF,
      'utf8'
    ));

    // response_format field
    if (response_format) {
      parts.push(Buffer.from(
        '--' + boundary + CRLF +
        'Content-Disposition: form-data; name="response_format"' + CRLF + CRLF +
        response_format + CRLF,
        'utf8'
      ));
    }

    // language field — force the transcription language (e.g. 'en') when provided so
    // Whisper doesn't auto-detect and mis-guess (e.g. Malay) on accented/noisy audio.
    if (language && /^[a-z]{2}$/i.test(String(language))) {
      parts.push(Buffer.from(
        '--' + boundary + CRLF +
        'Content-Disposition: form-data; name="language"' + CRLF + CRLF +
        String(language).toLowerCase() + CRLF,
        'utf8'
      ));
    }

    // timestamp_granularities field (array syntax required by OpenAI)
    if (timestamp_granularities) {
      const granularities = Array.isArray(timestamp_granularities)
        ? timestamp_granularities
        : [timestamp_granularities];
      for (const g of granularities) {
        parts.push(Buffer.from(
          '--' + boundary + CRLF +
          'Content-Disposition: form-data; name="timestamp_granularities[]"' + CRLF + CRLF +
          g + CRLF,
          'utf8'
        ));
      }
    }

    // closing boundary
    parts.push(Buffer.from('--' + boundary + '--' + CRLF, 'utf8'));

    const body = Buffer.concat(parts);

    // Forward to OpenAI using Node.js built-in https (always available, no fetch needed)
    const result = await new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: 'api.openai.com',
          path:     '/v1/audio/transcriptions',
          method:   'POST',
          headers: {
            'Authorization': 'Bearer ' + apiKey,
            'Content-Type':  'multipart/form-data; boundary=' + boundary,
            'Content-Length': body.length,
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () =>
            resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') })
          );
        }
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    // Parse and forward OpenAI response
    let data;
    try {
      data = JSON.parse(result.body);
    } catch {
      return {
        statusCode: 502,
        headers: { ...CORS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: { message: 'Unexpected response from OpenAI: ' + result.body.slice(0, 200) } }),
      };
    }

    if (result.status >= 200 && result.status < 300) await _spend(authUser.id, CREDIT_COST);

    return {
      statusCode: result.status,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: { message: 'Proxy error: ' + err.message } }),
    };
  }
};
