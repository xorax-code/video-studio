/**
 * Netlify Function: generate-nb-composite
 * Generates a Nano Banana composite image using Gemini image generation via Vertex AI.
 *
 * Takes:
 *   - avatarB64      — base64 avatar photo (Photo 1)
 *   - avatarMime     — MIME type of avatar (default: image/jpeg)
 *   - frameB64       — base64 reference frame (Photo 2, optional)
 *   - frameMime      — MIME type of frame (default: image/jpeg)
 *   - instruction    — NB Pro instruction text from the segment's nbPrompt
 *
 * Returns: { imageB64, mime }
 *
 * Required env vars:
 *   GOOGLE_SERVICE_ACCOUNT_JSON  — full service account key JSON (same as Veo functions)
 *   GOOGLE_CLOUD_PROJECT_ID      — your GCP project ID
 *   SUPABASE_URL                 — for auth
 *   SUPABASE_ANON                — for auth
 */

const https  = require('https');
const crypto = require('crypto');

const LOCATION = 'us-central1';
const MODEL    = 'gemini-2.5-flash-image';

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

  const { instruction, negativePrompt = '', avatarB64, avatarMime = 'image/jpeg', frameB64 = null, frameMime = 'image/jpeg' } = body;

  // ── Build images array — accept new {images:[{b64,mime}]} OR old avatarB64/frameB64 format ──
  let images = [];
  if (Array.isArray(body.images) && body.images.length > 0) {
    // New format: up to 5 images from Studio tab
    images = body.images.filter(img => img && img.b64).slice(0, 5);
  } else if (avatarB64) {
    // Legacy format: NB composite / replicator calls
    images = [{ b64: avatarB64, mime: avatarMime }];
    if (frameB64) images.push({ b64: frameB64, mime: frameMime });
  }

  if (!instruction || images.length === 0) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'instruction and at least one image are required.' }) };
  }

  // ── Get Vertex AI access token ─────────────────────────────────────────────
  let accessToken;
  try {
    accessToken = await getAccessToken(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  } catch(e) {
    console.error('generate-nb-composite: getAccessToken failed:', e.message);
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Could not authenticate with Vertex AI.' }) };
  }

  // ── Build request ──────────────────────────────────────────────────────────
  const hasFrameRef = images.length >= 2;

  const photoGuide = hasFrameRef
    ? [
        'PHOTO REFERENCE RULES:',
        '• Photo 1 = the avatar/person to generate. Copy this person\'s face, hair, skin tone, clothing, and body exactly.',
        '• Photo 2 = the background scene reference ONLY. Use its room, environment, furniture, props, and lighting as the backdrop.',
        '• The person visible in Photo 2 is the ORIGINAL creator — do NOT generate them. Completely replace any person in Photo 2 with the Photo 1 person.',
        '• Do NOT use Photo 1\'s background — only Photo 2\'s background.',
      ].join('\n')
    : 'PHOTO REFERENCE RULES:\n• Photo 1 = the avatar/person to generate. Reproduce their face, hair, clothing, and appearance exactly.';

  const negSection = negativePrompt
    ? `\n\nDo NOT include in the output: ${negativePrompt}, original person from background photo, multiple people, second person`
    : '\n\nDo NOT include: multiple people, second person, original person from background';

  const userText = [
    instruction,
    '',
    photoGuide,
    negSection,
  ].join('\n').trim();

  const userParts = [{ text: userText }];
  images.forEach(img => {
    userParts.push({ inline_data: { mime_type: img.mime || 'image/jpeg', data: img.b64 } });
  });

  const requestBody = JSON.stringify({
    contents: [{ role: 'user', parts: userParts }],
  });

  // Vertex AI endpoint for Gemini generateContent
  const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID;
  const apiPath = `/v1/projects/${projectId}/locations/${LOCATION}/publishers/google/models/${MODEL}:generateContent`;
  const hostname = `${LOCATION}-aiplatform.googleapis.com`;

  console.log(`generate-nb-composite: user=${user.id}, images=${images.length}, instrLen=${instruction.length}`);
  console.log(`generate-nb-composite: Vertex AI → ${hostname}${apiPath}`);

  // ── Vertex AI call — no server-side sleep/retry; client handles 429 backoff ─
  // Function timeout is 26s. A 12s sleep + second call would exceed it.
  // The client (js/17-nb-api.js) already retries up to 3× with 30s/60s/120s backoff.
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

  // ── Extract image from response ────────────────────────────────────────────
  // Vertex AI returns the same generateContent response shape as the Gemini API.
  const candidates = result.data.candidates || [];
  for (const candidate of candidates) {
    for (const part of (candidate.content?.parts || [])) {
      const blob = part.inlineData || part.inline_data;
      if (blob?.data) {
        const mime = blob.mimeType || blob.mime_type || 'image/png';
        console.log('generate-nb-composite: image generated, mime:', mime);
        return {
          statusCode: 200,
          headers: { ...CORS, 'Content-Type': 'application/json' },
          body: JSON.stringify({ imageB64: blob.data, mime }),
        };
      }
    }
  }

  // No image in response — log full details for debugging
  const finishReasons = candidates.map(c => c.finishReason || 'unknown').join(', ');
  const textParts = candidates.flatMap(c => (c.content?.parts || []).filter(p => p.text).map(p => p.text)).join(' ');
  console.error('generate-nb-composite: no image. finishReasons:', finishReasons, '| parts:', JSON.stringify(candidates.flatMap(c => (c.content?.parts || []).map(p => Object.keys(p))).slice(0,5)), '| text:', textParts.slice(0, 300));
  const errDetail = finishReasons ? `(finishReason: ${finishReasons})` : '';
  return {
    statusCode: 502,
    headers: CORS,
    body: JSON.stringify({ error: `Image generation returned no image ${errDetail}. ${textParts.slice(0, 150)}`.trim() }),
  };
};
