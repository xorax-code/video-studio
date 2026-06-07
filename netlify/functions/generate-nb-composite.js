/**
 * Netlify Function: generate-nb-composite
 * Generates a Nano Banana composite image using Imagen 3 via Vertex AI.
 *
 * Takes:
 *   - avatarB64      — base64 avatar photo (SUBJECT reference — person identity)
 *   - avatarMime     — MIME type of avatar (default: image/jpeg)
 *   - frameB64       — base64 reference frame (STYLE reference — background/environment, optional)
 *   - frameMime      — MIME type of frame (default: image/jpeg)
 *   - instruction    — full generation instruction built from all NB prompt JSON fields
 *   - avatarDesc     — text description of the avatar (reinforces SUBJECT reference)
 *   - negativePrompt — negative prompt from NB prompt JSON
 *
 * Returns: { imageB64, mime }
 *
 * Required env vars:
 *   GOOGLE_SERVICE_ACCOUNT_JSON  — full service account key JSON
 *   GOOGLE_CLOUD_PROJECT_ID      — your GCP project ID
 *   SUPABASE_URL                 — for auth
 *   SUPABASE_ANON                — for auth
 */

const https  = require('https');
const crypto = require('crypto');

const LOCATION = 'us-central1';
const MODEL    = 'imagen-3.0-generate-001';

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) });
        } catch(e) {
          resolve({ status: res.statusCode, data: null, raw: Buffer.concat(chunks).toString() });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── Service account → Vertex AI access token ─────────────────────────────────
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
  const unsigned = header + '.' + payload;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  const sig = signer.sign(sa.private_key, 'base64url');
  const jwt = unsigned + '.' + sig;
  const body = 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt;
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'oauth2.googleapis.com',
      path:     '/token',
      method:   'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
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

// ── Supabase auth check ───────────────────────────────────────────────────────
async function getAuthUser(jwt) {
  const url = new URL(`${process.env.SUPABASE_URL}/auth/v1/user`);
  const result = await httpsRequest({
    hostname: url.hostname,
    path:     url.pathname,
    method:   'GET',
    headers: {
      'Authorization': `Bearer ${jwt}`,
      'apikey':        process.env.SUPABASE_ANON,
    },
  });
  if (result.status !== 200 || !result.data?.id) return null;
  return result.data;
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

  // ── Env check ──────────────────────────────────────────────────────────────
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON || !process.env.GOOGLE_CLOUD_PROJECT_ID) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Server configuration error: Vertex AI credentials not set.' }) };
  }

  // ── Auth ───────────────────────────────────────────────────────────────────
  const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
  const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!jwt) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Missing authorization token.' }) };

  const user = await getAuthUser(jwt);
  if (!user) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Invalid or expired session.' }) };

  // ── Parse body ─────────────────────────────────────────────────────────────
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON body.' }) }; }

  const {
    instruction,
    avatarDesc    = '',
    negativePrompt = '',
    avatarB64,
    avatarMime    = 'image/jpeg',
    frameB64      = null,
    frameMime     = 'image/jpeg',
  } = body;

  // ── Build images array — accept new {images:[{b64,mime}]} OR old avatarB64/frameB64 format ──
  let avatarImg = null, frameImg = null;
  if (Array.isArray(body.images) && body.images.length > 0) {
    const imgs = body.images.filter(img => img && img.b64);
    if (imgs[0]) avatarImg = imgs[0];
    if (imgs[1]) frameImg  = imgs[1];
  } else if (avatarB64) {
    avatarImg = { b64: avatarB64, mime: avatarMime };
    if (frameB64) frameImg = { b64: frameB64, mime: frameMime };
  }

  if (!instruction || !avatarImg) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'instruction and avatar image are required.' }) };
  }

  // ── Get Vertex AI access token ─────────────────────────────────────────────
  let accessToken;
  try {
    accessToken = await getAccessToken(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  } catch(e) {
    console.error('generate-nb-composite: getAccessToken failed:', e.message);
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Could not authenticate with Vertex AI.' }) };
  }

  // ── Build Imagen 3 request ─────────────────────────────────────────────────
  // Avatar → SUBJECT reference: Imagen 3 uses this to lock the person's identity.
  // Frame  → STYLE reference: applies the background environment's aesthetic/lighting.
  // The prompt text drives pose, scene, framing, and expression.

  const referenceImages = [
    {
      referenceType:  'SUBJECT',
      referenceId:    1,
      referenceImage: {
        bytesBase64Encoded: avatarImg.b64,
        mimeType:           avatarImg.mime || 'image/jpeg',
      },
    },
  ];

  if (frameImg) {
    referenceImages.push({
      referenceType:  'STYLE',
      referenceId:    2,
      referenceImage: {
        bytesBase64Encoded: frameImg.b64,
        mimeType:           frameImg.mime || 'image/jpeg',
      },
    });
  }

  // Build the prompt — instruction carries all scene/pose/framing detail;
  // avatarDesc reinforces the SUBJECT reference in text.
  const promptParts = [];
  if (avatarDesc) promptParts.push('Person to generate: ' + avatarDesc + '.');
  promptParts.push(instruction);
  if (negativePrompt) promptParts.push('Do not include: ' + negativePrompt);
  const promptText = promptParts.join('\n\n');

  const parameters = {
    sampleCount:    1,
    aspectRatio:    '9:16',
    outputMimeType: 'image/jpeg',
  };
  if (negativePrompt) parameters.negativePrompt = negativePrompt;

  const requestBody = JSON.stringify({
    instances:  [{ prompt: promptText, referenceImages }],
    parameters,
  });

  const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID;
  const apiPath   = `/v1/projects/${projectId}/locations/${LOCATION}/publishers/google/models/${MODEL}:predict`;
  const hostname  = `${LOCATION}-aiplatform.googleapis.com`;

  console.log(`generate-nb-composite: user=${user.id}, model=${MODEL}, hasFrame=${!!frameImg}, avatarDescLen=${avatarDesc.length}, instrLen=${instruction.length}`);

  // ── Vertex AI call — no server-side sleep/retry; client handles 429 backoff ─
  const _vertexOptions = {
    hostname,
    path:   apiPath,
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(requestBody),
    },
  };

  let result;
  try {
    result = await httpsRequest(_vertexOptions, requestBody);
  } catch(e) {
    console.error('generate-nb-composite: fetch error:', e.message);
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Could not reach Vertex AI: ' + e.message }) };
  }

  console.log('generate-nb-composite: Vertex AI status:', result.status);

  if (!result.data) {
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'No response from Vertex AI. Status: ' + result.status }) };
  }

  if (result.status !== 200 || result.data.error) {
    const errMsg = result.data?.error?.message || `Vertex AI error (HTTP ${result.status})`;
    console.error('generate-nb-composite: Vertex AI error:', errMsg);
    const clientStatus = (result.status === 429) ? 429 : 502;
    return { statusCode: clientStatus, headers: CORS, body: JSON.stringify({ error: errMsg }) };
  }

  // ── Extract image from Imagen 3 response ───────────────────────────────────
  // Imagen 3 returns { predictions: [{ bytesBase64Encoded, mimeType }] }
  const predictions = result.data.predictions || [];
  for (const pred of predictions) {
    if (pred.bytesBase64Encoded) {
      const mime = pred.mimeType || 'image/jpeg';
      console.log('generate-nb-composite: image generated, mime:', mime);
      return {
        statusCode: 200,
        headers: { ...CORS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageB64: pred.bytesBase64Encoded, mime }),
      };
    }
  }

  // No image — log details
  const filterReasons = predictions.map(p => p.raiFilteredReason || p.safetyAttributes?.categories || 'unknown').join(', ');
  console.error('generate-nb-composite: no image in predictions. filterReasons:', filterReasons, '| predictions:', JSON.stringify(predictions).slice(0, 300));
  return {
    statusCode: 502,
    headers: CORS,
    body: JSON.stringify({ error: `Image generation returned no image. ${filterReasons ? '(Filtered: ' + filterReasons + ')' : ''}`.trim() }),
  };
};
