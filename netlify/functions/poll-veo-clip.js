/**
 * Netlify Function: poll-veo-clip  (Vertex AI version — no RPD cap)
 * Polls a Vertex AI operation for completion.
 * When done, generates a V4 signed GCS URL so the frontend can fetch the video.
 *
 * Required env vars:
 *   GOOGLE_SERVICE_ACCOUNT_JSON   — full service account key JSON (as a string)
 *   GOOGLE_CLOUD_PROJECT_ID       — e.g. gen-lang-client-0657577212
 *   SUPABASE_URL                  — https://xxx.supabase.co
 *   SUPABASE_ANON                 — anon/public key
 *
 * POST body:  { operationName: string }
 * Auth header: Bearer <supabase_jwt>
 */

const https  = require('https');
const crypto = require('crypto');

const LOCATION = 'us-central1';

// ── OAuth2: service account → access token ────────────────────────────────────
async function getAccessToken(saJson) {
  const sa  = typeof saJson === 'string' ? JSON.parse(saJson) : saJson;
  const now = Math.floor(Date.now() / 1000);

  const claim = {
    iss:   sa.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud:   'https://oauth2.googleapis.com/token',
    exp:   now + 3600,
    iat:   now,
  };

  const header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claim)).toString('base64url');
  const unsigned = `${header}.${payload}`;

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  const sig = signer.sign(sa.private_key, 'base64url');
  const jwt = `${unsigned}.${sig}`;

  const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'oauth2.googleapis.com',
      path:     '/token',
      method:   'POST',
      headers: {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          if (data.access_token) resolve(data.access_token);
          else reject(new Error('Token exchange failed: ' + JSON.stringify(data)));
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── V4 Signed URL for GCS object ──────────────────────────────────────────────
function createSignedUrl(gcsUri, sa, expiresInSeconds) {
  const exp   = expiresInSeconds || 3600;
  const match = gcsUri.match(/^gs:\/\/([^\/]+)\/(.+)$/);
  if (!match) throw new Error('Invalid GCS URI: ' + gcsUri);
  const bucket = match[1];
  const object = match[2];

  const now      = new Date();
  const dateStr  = now.toISOString().slice(0,10).replace(/-/g,'');
  const timeStr  = now.toISOString().replace(/[-:]/g,'').slice(0,15) + 'Z';
  const datetime = timeStr;

  const credentialScope = `${dateStr}/auto/storage/goog4_request`;
  const credential      = `${sa.client_email}/${credentialScope}`;

  const encodedObject = object.split('/').map(encodeURIComponent).join('/');
  const queryParams = [
    `X-Goog-Algorithm=GOOG4-RSA-SHA256`,
    `X-Goog-Credential=${encodeURIComponent(credential)}`,
    `X-Goog-Date=${datetime}`,
    `X-Goog-Expires=${exp}`,
    `X-Goog-SignedHeaders=host`,
  ].join('&');

  const canonicalRequest = [
    'GET',
    `/${bucket}/${encodedObject}`,
    queryParams,
    `host:storage.googleapis.com\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const canonicalHash = crypto.createHash('sha256').update(canonicalRequest).digest('hex');

  const stringToSign = [
    'GOOG4-RSA-SHA256',
    datetime,
    credentialScope,
    canonicalHash,
  ].join('\n');

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(stringToSign);
  const signature = signer.sign(sa.private_key, 'hex');

  return `https://storage.googleapis.com/${bucket}/${encodedObject}?${queryParams}&X-Goog-Signature=${signature}`;
}

// ── Poll Vertex AI operation ──────────────────────────────────────────────────
function pollOperation(operationName, accessToken) {
  // operationName is a full resource path like:
  // projects/{p}/locations/{l}/publishers/google/models/{m}/operations/{id}
  // Vertex AI operations are polled at: /v1/{operationName}
  const path = `/v1/${operationName}`;

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: `${LOCATION}-aiplatform.googleapis.com`,
      path,
      method:   'GET',
      headers: { 'Authorization': `Bearer ${accessToken}` },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) });
        } catch(e) { resolve({ status: res.statusCode, data: null }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── JWT validation via Supabase ───────────────────────────────────────────────
function validateJwt(jwt) {
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

// ── Main handler ──────────────────────────────────────────────────────────────
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

  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON || !process.env.GOOGLE_CLOUD_PROJECT_ID) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Server configuration error.' }) };
  }

  // ── Auth ──────────────────────────────────────────────────────────────────
  const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
  const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!jwt) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Missing authorization token.' }) };

  const valid = await validateJwt(jwt);
  if (!valid) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Invalid or expired session.' }) };

  // ── Parse body ────────────────────────────────────────────────────────────
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON.' }) }; }

  const { operationName } = body;
  if (!operationName || typeof operationName !== 'string') {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'operationName is required.' }) };
  }

  // ── Get access token ──────────────────────────────────────────────────────
  let accessToken;
  try {
    accessToken = await getAccessToken(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  } catch(e) {
    console.error('poll-veo-clip: getAccessToken failed:', e.message);
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Could not authenticate with generation service.' }) };
  }

  // ── Poll Vertex AI ────────────────────────────────────────────────────────
  let pollResult;
  try {
    pollResult = await pollOperation(operationName, accessToken);
  } catch(e) {
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

  // ── Done — extract GCS video URI ──────────────────────────────────────────
  const samples = pd.response?.generateVideoResponse?.generatedSamples;
  if (!samples?.length) {
    return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ done: false, error: 'Generation finished but no video returned.' }) };
  }

  const gcsUri  = samples[0]?.video?.gcsUri || '';
  const mimeType = samples[0]?.video?.mimeType || 'video/mp4';

  if (!gcsUri) {
    return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ done: false, error: 'Video GCS URI missing from response.' }) };
  }

  // ── Generate V4 signed URL (1 hour) so frontend can fetch the video ───────
  let signedUrl;
  try {
    const sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    signedUrl = createSignedUrl(gcsUri, sa, 3600);
    console.log('poll-veo-clip: generated signed URL for', gcsUri);
  } catch(e) {
    console.error('poll-veo-clip: signed URL failed:', e.message);
    // Fall back to returning the raw GCS URI — frontend may not be able to fetch it
    // but at least the operation was successful
    signedUrl = gcsUri;
  }

  return {
    statusCode: 200,
    headers: { ...CORS, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      done:     true,
      videoUrl: signedUrl,
      mimeType,
    }),
  };
};
