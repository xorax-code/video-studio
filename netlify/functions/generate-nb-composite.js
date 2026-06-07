/**
 * Netlify Function: generate-nb-composite
 * Generates a Nano Banana scene image using Imagen 3 via Vertex AI.
 *
 * Model: imagen-3.0-capability-001 (Imagen 3 editing/capability endpoint)
 * Endpoint: :predict (NOT :generateContent — that's Gemini)
 *
 * Reference image strategy (replicates how Google Flow generates NB scenes):
 *   SUBJECT reference — avatar photo → locks NanaBanana's face, skin, hair, clothing
 *   LAYOUT reference  — source video frame → locks scene structure, background, props,
 *                       camera angle, lighting (exact pixel-level spatial preservation)
 *
 * The model GENERATES NanaBanana into the scene — it does NOT composite or blend.
 * The instruction from 17-nb-api.js is passed through as-is (already structured for Imagen 3).
 *
 * Takes:
 *   - avatarB64      — base64 avatar photo (NanaBanana identity reference)
 *   - avatarMime     — MIME type of avatar (default: image/jpeg)
 *   - frameB64       — base64 source video frame (scene layout reference, optional)
 *   - frameMime      — MIME type of frame (default: image/jpeg)
 *   - instruction    — NB Pro generation instruction (scene/pose/action/framing detail)
 *   - avatarDesc     — text description of NanaBanana (reinforces SUBJECT reference)
 *   - negativePrompt — things to avoid
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
const MODEL    = 'imagen-3.0-capability-001';

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
    avatarDesc     = '',
    negativePrompt = '',
    avatarB64,
    avatarMime     = 'image/jpeg',
    frameB64       = null,
    frameMime      = 'image/jpeg',
  } = body;

  // ── Resolve images — support both {images:[]} and old avatarB64/frameB64 ──
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

  // ── Build Imagen 3 :predict request ───────────────────────────────────────
  //
  // Strategy: dual reference images replicating Google Flow's NB generation.
  //
  // SUBJECT reference (avatar photo):
  //   Locks NanaBanana's identity — face, skin tone, hair color/texture, clothing.
  //   subjectType: PERSON tells Imagen 3 this is a human identity reference.
  //
  // LAYOUT reference (source video frame):
  //   Locks the scene structure — exact background, prop positions, camera angle,
  //   lighting direction. This is why Flow produces pixel-exact backgrounds.
  //   Unlike STYLE (which preserves color/mood loosely), LAYOUT preserves spatial
  //   composition precisely.
  //
  // The instruction from 17-nb-api.js is already formatted for Imagen 3 with
  // NB Pro structured sections (LOCK, ARM, HAIR LOCK, etc.) — pass through as-is.

  const hasFrame = !!frameImg;

  // Build the text prompt:
  // Lead with subject description, then the full structured instruction,
  // then scene lock reminder if we have a frame, then negatives.
  const subjectLine = avatarDesc
    ? `Photorealistic portrait of ${avatarDesc}.`
    : 'Photorealistic portrait of the person in the subject reference image.';

  const layoutReminder = hasFrame
    ? 'Replicate the exact background, props, lighting, and spatial composition from the layout reference image. Do not alter or remove any background elements.'
    : '';

  const negLine = negativePrompt ? `Avoid: ${negativePrompt}` : '';

  const prompt = [subjectLine, instruction, layoutReminder, negLine]
    .filter(Boolean)
    .join(' ');

  // Build referenceImages array
  const referenceImages = [
    {
      referenceType: 'SUBJECT',
      referenceId:   1,
      referenceImage: { bytesBase64Encoded: avatarImg.b64 },
      subjectImageConfig: { subjectType: 'PERSON' },
    },
  ];

  if (hasFrame) {
    referenceImages.push({
      referenceType: 'LAYOUT',
      referenceId:   2,
      referenceImage: { bytesBase64Encoded: frameImg.b64 },
    });
  }

  const requestBody = JSON.stringify({
    instances: [{
      prompt,
      referenceImages,
    }],
    parameters: {
      sampleCount:      1,
      aspectRatio:      '9:16',
      personGeneration: 'allow_all',
    },
  });

  const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID;
  const apiPath   = `/v1/projects/${projectId}/locations/${LOCATION}/publishers/google/models/${MODEL}:predict`;
  const hostname  = `${LOCATION}-aiplatform.googleapis.com`;

  console.log(`generate-nb-composite: user=${user.id}, model=${MODEL}, hasFrame=${hasFrame}, avatarDescLen=${avatarDesc.length}, instrLen=${instruction.length}, promptLen=${prompt.length}`);

  // ── Vertex AI call ────────────────────────────────────────────────────────
  const vertexOptions = {
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
    result = await httpsRequest(vertexOptions, requestBody);
  } catch(e) {
    console.error('generate-nb-composite: fetch error:', e.message);
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Could not reach Vertex AI: ' + e.message }) };
  }

  console.log('generate-nb-composite: Vertex AI status:', result.status);

  if (!result.data) {
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'No response from Vertex AI. Status: ' + result.status + (result.raw ? ' Raw: ' + result.raw.slice(0, 300) : '') }) };
  }

  if (result.status !== 200 || result.data.error) {
    const errMsg = result.data?.error?.message || `Vertex AI error (HTTP ${result.status})`;
    console.error('generate-nb-composite: Vertex AI error:', errMsg);
    const clientStatus = result.status === 429 ? 429 : 502;
    return { statusCode: clientStatus, headers: CORS, body: JSON.stringify({ error: errMsg }) };
  }

  // ── Extract image from Imagen 3 :predict response ─────────────────────────
  // Response shape: { predictions: [{ bytesBase64Encoded: "...", mimeType: "image/png" }] }
  const predictions = result.data.predictions || [];
  for (const pred of predictions) {
    if (pred.bytesBase64Encoded) {
      const mime = pred.mimeType || 'image/png';
      console.log('generate-nb-composite: image generated, mime:', mime);
      return {
        statusCode: 200,
        headers: { ...CORS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageB64: pred.bytesBase64Encoded, mime }),
      };
    }
  }

  // No image in predictions — log for debugging
  console.error('generate-nb-composite: no image in predictions. Full response:', JSON.stringify(result.data).slice(0, 500));
  return {
    statusCode: 502,
    headers: CORS,
    body: JSON.stringify({ error: 'Imagen 3 returned no image. Check Vertex AI logs.' }),
  };
};
