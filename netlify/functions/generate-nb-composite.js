/**
 * Netlify Function: generate-nb-composite
 * Generates a Nano Banana scene image using Gemini 2.5 Flash image generation.
 *
 * Model: gemini-2.5-flash-image
 * Endpoint: :generateContent (Gemini multimodal API)
 *
 * Strategy — mirrors Google Flow's Nano Banana 2 agent format exactly:
 *   Photo 1 (avatar)  → FIRST in parts array — the identity to composite
 *   Photo 2 (frame)   → SECOND in parts array — the background scene to preserve
 *   photo_guide       → "Photo 1 = your avatar. Photo 2 = Scene reference frame."
 *   instruction       → NB Pro structured command (LOCK, HAIR LOCK, GENDER LOCK, etc.)
 *                       from 17-nb-api.js — sent as-is, no editPrefix stacked on top
 *   systemInstruction → primes the model for compositing before any user content
 *
 * Takes:
 *   - avatarB64      — base64 avatar photo (NanaBanana identity)
 *   - avatarMime     — MIME type of avatar (default: image/jpeg)
 *   - frameB64       — base64 source video frame (scene canvas)
 *   - frameMime      — MIME type of frame (default: image/jpeg)
 *   - instruction    — NB Pro generation instruction from 17-nb-api.js
 *   - avatarDesc     — text description of NanaBanana
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

  try {

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON || !process.env.GOOGLE_CLOUD_PROJECT_ID) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Server configuration error: Vertex AI credentials not set.' }) };
  }

  const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
  const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!jwt) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Missing authorization token.' }) };

  let user;
  try {
    user = await getAuthUser(jwt);
  } catch(authErr) {
    console.error('generate-nb-composite: getAuthUser threw:', authErr.message);
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Auth check failed: ' + authErr.message }) };
  }
  if (!user) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Invalid or expired session.' }) };

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

  let accessToken;
  try {
    accessToken = await getAccessToken(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  } catch(e) {
    console.error('generate-nb-composite: getAccessToken failed:', e.message);
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Could not authenticate with Vertex AI.' }) };
  }

  const hasFrame = !!frameImg;

  // ── Mirror the exact format Flow's Nano Banana 2 agent uses ─────────────────
  // Photo 1 = avatar (SUBJECT identity) — FIRST in parts array.
  // Photo 2 = scene frame (background canvas) — SECOND.
  // The NB Pro instruction from 17-nb-api.js is self-contained (LOCK/ARM/HAIR LOCK/
  // GENDER LOCK/TRANSFER BLOCK/LIGHTING MATCH). We do NOT stack any editPrefix on
  // top of it — that was causing two conflicting instruction formats to fight each
  // other and produce wrong results. The photo_guide is the only context header needed.

  const photo_guide = hasFrame
    ? 'Photo 1 = your avatar (person to composite). Photo 2 = Scene reference frame (background/composition to match).'
    : `Generate a photorealistic portrait of ${avatarDesc || 'the person shown in Photo 1'}.`;

  const negLine = negativePrompt ? `\n\nAVOID IN OUTPUT: ${negativePrompt}` : '';

  // fullPrompt = photo_guide + NB Pro instruction + negative prompt
  // (no editPrefix — same structure as the Flow JSON: photo_guide + instruction + negative_prompt)
  const fullPrompt = `${photo_guide}\n\n${instruction}${negLine}`;

  const parts = [];
  // Photo 1 FIRST: avatar
  parts.push({ text: 'Photo 1:' });
  parts.push({ inlineData: { mimeType: avatarImg.mime, data: avatarImg.b64 } });
  if (hasFrame) {
    // Photo 2 SECOND: scene frame
    parts.push({ text: 'Photo 2:' });
    parts.push({ inlineData: { mimeType: frameImg.mime, data: frameImg.b64 } });
  }
  parts.push({ text: fullPrompt });

  const requestBody = JSON.stringify({
    // systemInstruction primes the model for person-replacement compositing —
    // mirrors the system prompt Nano Banana 2 has baked in as an agent.
    systemInstruction: {
      parts: [{ text: 'You are a professional photo compositor. When given Photo 1 (avatar) and Photo 2 (scene reference frame), composite the Photo 1 person into the Photo 2 background exactly as instructed. Preserve every background element in Photo 2 pixel-perfectly. Replace all human body parts in Photo 2 with the Photo 1 person. Output a single photorealistic image.' }],
    },
    contents: [{ role: 'user', parts }],
    generationConfig: {
      responseModalities: ['IMAGE', 'TEXT'],
      temperature: 0.5,
      // NOTE: seed is NOT a valid Gemini generationConfig field (that's Imagen 3).
      // Including it would cause Vertex AI to return a 400, breaking all generation.
    },
  });

  const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID;
  const apiPath   = `/v1/projects/${projectId}/locations/${LOCATION}/publishers/google/models/${MODEL}:generateContent`;
  const hostname  = `${LOCATION}-aiplatform.googleapis.com`;

  const mode = hasFrame ? 'edit-swap' : 'generate-only';
  console.log(`generate-nb-composite: user=${user.id}, model=${MODEL}, mode=${mode}, hasFrame=${hasFrame}, promptLen=${fullPrompt.length}`);

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

  if (result.status === 429) {
    return { statusCode: 429, headers: CORS, body: JSON.stringify({ error: 'Vertex AI rate limit. Please wait and retry.' }) };
  }

  if (result.status !== 200 || result.data.error) {
    const errMsg = result.data?.error?.message || `Vertex AI error (HTTP ${result.status})`;
    console.error('generate-nb-composite: Vertex AI error:', errMsg);
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: errMsg }) };
  }

  const candidates = result.data.candidates || [];
  for (const candidate of candidates) {
    const parts = candidate?.content?.parts || [];
    for (const part of parts) {
      if (part.inlineData?.data) {
        const mime = part.inlineData.mimeType || 'image/png';
        console.log('generate-nb-composite: image generated, mime:', mime);
        return {
          statusCode: 200,
          headers: { ...CORS, 'Content-Type': 'application/json' },
          body: JSON.stringify({ imageB64: part.inlineData.data, mime }),
        };
      }
    }
  }

  console.error('generate-nb-composite: no image in response. Full:', JSON.stringify(result.data).slice(0, 500));
  return {
    statusCode: 502,
    headers: CORS,
    body: JSON.stringify({ error: 'Model returned no image. Check Vertex AI logs.' }),
  };

  } catch(topErr) {
    console.error('generate-nb-composite: unhandled exception:', topErr.message, topErr.stack);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: 'Internal error: ' + topErr.message }),
    };
  }
};
