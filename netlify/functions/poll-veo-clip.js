/**
 * Netlify Function: poll-veo-clip
 * Polls a Gemini Veo operation for completion — lightweight, called repeatedly by frontend.
 * No credit changes happen here — credits are deducted at generation start.
 *
 * Required env vars:
 *   GEMINI_API_KEY             — Google AI Studio key with Veo access
 *   SUPABASE_URL               — https://xxx.supabase.co
 *   SUPABASE_ANON_KEY          — anon/public key (for JWT validation)
 *
 * POST body (JSON):
 *   { operationName: string }   — e.g. "operations/xxx"
 *
 * Authorization header: Bearer <supabase_jwt>
 *
 * Returns:
 *   { done: false }
 *   { done: true, videoUrl: string, mimeType: string }
 *   { error: string }
 */

const https = require('https');

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

function httpsGet(path, apiKey) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path:     path,
      method:   'GET',
      headers:  { 'x-goog-api-key': apiKey },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) });
        } catch (e) {
          resolve({ status: res.statusCode, data: null });
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// Lightweight JWT validation — just confirm the token is valid via Supabase
async function validateJwt(jwt) {
  return new Promise((resolve) => {
    const url = new URL(`${process.env.SUPABASE_URL}/auth/v1/user`);
    const req = https.request({
      hostname: url.hostname,
      path:     url.pathname,
      method:   'GET',
      headers: {
        'Authorization': `Bearer ${jwt}`,
        'apikey':        process.env.SUPABASE_ANON || '',
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          resolve(res.statusCode === 200 && !!data.id);
        } catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.end();
  });
}

exports.handler = async (event) => {
  const CORS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  if (!process.env.GEMINI_API_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Server configuration error.' }) };
  }

  // ── Auth ───────────────────────────────────────────────────────────────────
  const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
  const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!jwt) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Missing authorization token.' }) };
  }
  const valid = await validateJwt(jwt);
  if (!valid) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Invalid or expired session.' }) };
  }

  // ── Parse body ─────────────────────────────────────────────────────────────
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON.' }) }; }

  const { operationName } = body;
  if (!operationName || typeof operationName !== 'string') {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'operationName is required.' }) };
  }

  // ── Poll Gemini ────────────────────────────────────────────────────────────
  const apiKey   = process.env.GEMINI_API_KEY;
  const pollPath = `/v1beta/${operationName}`;

  let pollResult;
  try {
    pollResult = await httpsGet(pollPath, apiKey);
  } catch (e) {
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Could not reach generation service.' }) };
  }

  const pd = pollResult.data;

  if (!pd || pollResult.status >= 400) {
    const errMsg = pd?.error?.message || `Poll error (HTTP ${pollResult.status})`;
    return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ done: false, error: errMsg }) };
  }

  if (pd.error) {
    return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ done: false, error: pd.error.message || 'Generation failed on server.' }) };
  }

  if (!pd.done) {
    return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ done: false }) };
  }

  // ── Done — extract video URI ───────────────────────────────────────────────
  const samples = pd.response?.generateVideoResponse?.generatedSamples;
  if (!samples || !samples.length) {
    return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ done: false, error: 'Generation finished but no video returned.' }) };
  }

  const videoUrl = samples[0]?.video?.uri || '';
  const mimeType = samples[0]?.video?.mimeType || 'video/mp4';
  if (!videoUrl) {
    return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ done: false, error: 'Video URI missing from response.' }) };
  }

  // Append API key to video URI so the frontend can fetch the blob directly
  const sep = videoUrl.includes('?') ? '&' : '?';
  const signedUrl = `${videoUrl}${sep}key=${process.env.GEMINI_API_KEY}`;

  return {
    statusCode: 200,
    headers: { ...CORS, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      done:     true,
      videoUrl: signedUrl,
      mimeType: mimeType,
    }),
  };
};
