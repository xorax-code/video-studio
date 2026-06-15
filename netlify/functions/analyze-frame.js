/**
 * Netlify function: analyze-frame
 *
 * Vertex AI Gemini 2.5 Flash vision analysis for the replicator's NB-prompt builder.
 * Takes a prompt + a single frame image and returns the model's JSON text.
 *
 * WHY THIS EXISTS: the frontend used to call OpenAI gpt-4o directly for frame
 * analysis, which refuses on some legitimate frames with no way to override. Gemini
 * on Vertex lets us set safetySettings to BLOCK_NONE on the adjustable categories,
 * so it refuses far less for legitimate content analysis. The frontend keeps gpt-4o
 * as a fallback if this returns nothing.
 *
 * Required env: GOOGLE_SERVICE_ACCOUNT_JSON, GOOGLE_CLOUD_PROJECT_ID,
 *               SUPABASE_URL, SUPABASE_ANON_KEY (or SUPABASE_ANON).
 */

const https  = require('https');
const crypto = require('crypto');

const VERTEX_MODEL    = 'gemini-2.5-flash';
const VERTEX_LOCATION = 'us-central1';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) });
        } catch (e) {
          resolve({ status: res.statusCode, data: null, raw: Buffer.concat(chunks).toString() });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// OAuth2: service account → access token (Vertex AI).
async function getAccessToken(saJson) {
  const sa  = typeof saJson === 'string' ? JSON.parse(saJson) : saJson;
  const now = Math.floor(Date.now() / 1000);
  const claim = { iss: sa.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform', aud: 'https://oauth2.googleapis.com/token', exp: now + 3600, iat: now };
  const header   = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload  = Buffer.from(JSON.stringify(claim)).toString('base64url');
  const unsigned = `${header}.${payload}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  const sig = signer.sign(sa.private_key, 'base64url');
  const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${unsigned}.${sig}`;
  const res = await httpsRequest({
    hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
  }, body);
  if (res.data && res.data.access_token) return res.data.access_token;
  throw new Error('Token exchange failed');
}

async function getAuthUser(jwt) {
  const url = new URL(`${process.env.SUPABASE_URL}/auth/v1/user`);
  const result = await httpsRequest({
    hostname: url.hostname, path: url.pathname, method: 'GET',
    headers: { 'Authorization': `Bearer ${jwt}`, 'apikey': process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_ANON },
  });
  if (result.status !== 200 || !result.data?.id) return null;
  return result.data;
}

// Adjustable categories set to BLOCK_NONE so legitimate frame analysis isn't refused.
// Core non-adjustable harms (e.g. child safety) remain enforced by Google regardless.
const SAFETY_SETTINGS = [
  { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
];

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  const jwt = (event.headers.authorization || event.headers.Authorization || '').replace(/^Bearer\s+/i, '');
  if (!jwt) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Missing authorization token.' }) };
  let user;
  try { user = await getAuthUser(jwt); } catch (e) { user = null; }
  if (!user) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Invalid or expired session.' }) };

  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON || !process.env.GOOGLE_CLOUD_PROJECT_ID) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Vertex not configured.' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { body = {}; }
  const promptText = (body.promptText || '').trim();
  const imageB64   = body.imageB64 || '';
  const imageMime  = body.imageMime || 'image/jpeg';
  if (!promptText || !imageB64) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'promptText and imageB64 are required.' }) };
  }

  let token;
  try { token = await getAccessToken(process.env.GOOGLE_SERVICE_ACCOUNT_JSON); }
  catch (e) { return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Vertex auth failed: ' + e.message }) }; }

  const reqJson = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: promptText }, { inlineData: { mimeType: imageMime, data: imageB64 } }] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.3, maxOutputTokens: 1200 },
    safetySettings: SAFETY_SETTINGS,
  });
  const host = `${VERTEX_LOCATION}-aiplatform.googleapis.com`;
  const path = `/v1/projects/${process.env.GOOGLE_CLOUD_PROJECT_ID}/locations/${VERTEX_LOCATION}/publishers/google/models/${VERTEX_MODEL}:generateContent`;

  let r;
  try {
    r = await httpsRequest({ hostname: host, path, method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(reqJson) } }, reqJson);
  } catch (e) {
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Vertex request failed: ' + e.message }) };
  }

  if (!r.data || r.status !== 200) {
    const msg = (r.data && r.data.error && r.data.error.message) || ('Vertex error ' + r.status);
    return { statusCode: r.status === 429 ? 429 : 502, headers: CORS, body: JSON.stringify({ error: msg }) };
  }

  const cand = (r.data.candidates && r.data.candidates[0]) || null;
  const text = cand && cand.content && Array.isArray(cand.content.parts)
    ? cand.content.parts.map(p => (p && p.text) || '').join('').trim()
    : '';
  if (!text) {
    // No usable text (e.g. blocked by a non-adjustable category, or empty candidate).
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ text: '', finishReason: (cand && cand.finishReason) || 'EMPTY' }) };
  }

  return { statusCode: 200, headers: CORS, body: JSON.stringify({ text }) };
};
