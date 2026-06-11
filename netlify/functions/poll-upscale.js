/**
 * Netlify Function: poll-upscale
 * Checks the status of a Cloud Video Transcoder job.
 * When SUCCEEDED, generates a V4 signed URL for the 1080p output file.
 *
 * Required env vars:
 *   GOOGLE_SERVICE_ACCOUNT_JSON   — full service account key JSON (as a string)
 *   GOOGLE_CLOUD_PROJECT_ID       — your GCP project ID
 *   SUPABASE_URL                  — https://xxx.supabase.co
 *   SUPABASE_ANON                 — anon/public key
 *
 * POST body (JSON):
 *   { jobName: "projects/.../jobs/xxx", outputGcsUri: "gs://bucket/upscaled/xxx/" }
 *
 * Response:
 *   { state: "PROCESSING" }                  — still running
 *   { state: "SUCCEEDED", downloadUrl: "..." } — done, signed URL for sd.mp4
 *   { state: "FAILED", error: "..." }         — job failed
 */

const https  = require('https');
const crypto = require('crypto');

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

// ── Generic HTTPS helper ──────────────────────────────────────────────────────
function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) });
        } catch(e) {
          resolve({ status: res.statusCode, data: null });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── Supabase auth check ───────────────────────────────────────────────────────
async function getAuthUser(jwt) {
  const url = new URL(`${process.env.SUPABASE_URL}/auth/v1/user`);
  const result = await httpsRequest({
    hostname: url.hostname,
    path:     url.pathname,
    method:   'GET',
    headers: {
      'Authorization': `Bearer ${jwt}`,
      'apikey':        process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_ANON,
    },
  });
  if (result.status !== 200 || !result.data?.id) return null;
  return result.data;
}

// ── V4 signed URL for a GCS object (1-hour expiry) ───────────────────────────
function createSignedUrl(gcsUri, sa, expiresInSeconds) {
  const exp   = expiresInSeconds || 3600;
  const match = gcsUri.match(/^gs:\/\/([^/]+)\/(.+)$/);
  if (!match) throw new Error('Invalid GCS URI: ' + gcsUri);
  const bucket = match[1];
  const object = match[2];
  const now      = new Date();
  const dateStr  = now.toISOString().slice(0, 10).replace(/-/g, '');
  const timeStr  = now.toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const credentialScope = dateStr + '/auto/storage/goog4_request';
  const credential      = sa.client_email + '/' + credentialScope;
  const encodedObject   = object.split('/').map(encodeURIComponent).join('/');
  const queryParams = [
    'X-Goog-Algorithm=GOOG4-RSA-SHA256',
    'X-Goog-Credential=' + encodeURIComponent(credential),
    'X-Goog-Date=' + timeStr,
    'X-Goog-Expires=' + exp,
    'X-Goog-SignedHeaders=host',
  ].join('&');
  const canonicalRequest = [
    'GET',
    '/' + bucket + '/' + encodedObject,
    queryParams,
    'host:storage.googleapis.com\n',
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const canonicalHash = crypto.createHash('sha256').update(canonicalRequest).digest('hex');
  const stringToSign  = ['GOOG4-RSA-SHA256', timeStr, credentialScope, canonicalHash].join('\n');
  const signer2 = crypto.createSign('RSA-SHA256');
  signer2.update(stringToSign);
  const signature = signer2.sign(sa.private_key, 'hex');
  return 'https://storage.googleapis.com/' + bucket + '/' + encodedObject + '?' + queryParams + '&X-Goog-Signature=' + signature;
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

  // ── Env check ─────────────────────────────────────────────────────────────
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON || !process.env.GOOGLE_CLOUD_PROJECT_ID) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Server configuration error.' }) };
  }

  // ── Auth ──────────────────────────────────────────────────────────────────
  const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
  const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!jwt) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Missing authorization token.' }) };

  const user = await getAuthUser(jwt);
  if (!user) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Invalid or expired session.' }) };

  // ── Parse body ────────────────────────────────────────────────────────────
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON body.' }) }; }

  const { jobName, outputGcsUri } = body;
  if (!jobName) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'jobName is required.' }) };
  if (!outputGcsUri) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'outputGcsUri is required.' }) };

  // ── Get access token ──────────────────────────────────────────────────────
  let accessToken;
  try {
    accessToken = await getAccessToken(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  } catch(e) {
    console.error('poll-upscale: getAccessToken failed:', e.message);
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Could not authenticate with GCP.' }) };
  }

  // ── Poll Transcoder job ───────────────────────────────────────────────────
  // jobName looks like: projects/{project}/locations/{location}/jobs/{jobId}
  let result;
  try {
    result = await httpsRequest({
      hostname: 'transcoder.googleapis.com',
      path:     `/v1/${jobName}`,
      method:   'GET',
      headers:  { 'Authorization': `Bearer ${accessToken}` },
    });
  } catch(e) {
    console.error('poll-upscale: Transcoder GET error:', e.message);
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Could not reach Transcoder API.' }) };
  }

  console.log('poll-upscale: job status HTTP', result.status, JSON.stringify(result.data));

  if (result.status !== 200 || !result.data) {
    const errMsg = result.data?.error?.message || `Transcoder error (HTTP ${result.status})`;
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: errMsg }) };
  }

  const state = result.data.state; // PENDING | RUNNING | SUCCEEDED | FAILED

  if (state === 'FAILED') {
    const failErr = result.data.error?.message || 'Transcoder job failed.';
    console.error('poll-upscale: job FAILED:', failErr);
    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'FAILED', error: failErr }),
    };
  }

  if (state !== 'SUCCEEDED') {
    // Still PENDING or RUNNING
    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'PROCESSING' }),
    };
  }

  // ── Job SUCCEEDED — generate signed download URL ───────────────────────────
  // Output file is at: {outputGcsUri}sd.mp4 (keyed by the muxStream "sd")
  const outputFileUri = outputGcsUri.replace(/\/?$/, '') + '/sd.mp4';

  let downloadUrl;
  try {
    const sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    downloadUrl = createSignedUrl(outputFileUri, sa, 3600); // 1-hour expiry
    console.log('poll-upscale: signed URL generated for', outputFileUri);
  } catch(e) {
    console.error('poll-upscale: signed URL error:', e.message);
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Could not generate download URL: ' + e.message }) };
  }

  return {
    statusCode: 200,
    headers: { ...CORS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: 'SUCCEEDED', downloadUrl }),
  };
};
