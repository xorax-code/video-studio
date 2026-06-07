/**
 * Netlify Function: generate-nb-composite
 * Generates a Nano Banana composite image using Gemini 2.5 Flash Image via Vertex AI.
 *
 * Uses generateContent (not predict) with interleaved text + inlineData parts.
 * Photo 1 = avatar identity to PLACE into the scene.
 * Photo 2 = source video frame — background/scene to PRESERVE.
 *
 * The model sees both images with explicit role labels and generates a new image
 * where the avatar person is composited into the scene background.
 *
 * Takes:
 *   - avatarB64      — base64 avatar photo (person identity)
 *   - avatarMime     — MIME type of avatar (default: image/jpeg)
 *   - frameB64       — base64 source video frame (scene background, optional)
 *   - frameMime      — MIME type of frame (default: image/jpeg)
 *   - instruction    — full NB Pro generation instruction (all scene/pose/framing detail)
 *   - avatarDesc     — text description of avatar (reinforces identity in prompt)
 *   - negativePrompt — things to avoid (folded into prompt text — Gemini has no native neg prompt)
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
// gemini-2.5-flash-image supports generateContent with image input/output
// and multi-image reference for character consistency.
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

  const {
    instruction,
    avatarDesc    = '',
    negativePrompt = '',
    avatarB64,
    avatarMime    = 'image/jpeg',
    frameB64      = null,
    frameMime     = 'image/jpeg',
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

  // ── Build Gemini generateContent request ───────────────────────────────────
  //
  // Strategy: interleave text labels + inlineData images so the model knows
  // EXACTLY what each photo is for — not blending, not merging, but compositing.
  //
  // Photo 1 (avatar): the person whose face/body/appearance must be preserved.
  // Photo 2 (frame):  the source video frame — background scene to keep intact.
  //
  // The prompt is the control mechanism. It must be crystal clear:
  //   "Avatar FROM Photo 1 → placed INTO Scene FROM Photo 2"
  //   "Do NOT use the original person from Photo 2"
  //   "Do NOT blend these images"

  const avDesc = avatarDesc ? ` (${avatarDesc})` : '';
  const hasFrame = !!frameImg;

  // Build preamble — strict compositing framing
  const preamble = [
    'You are a photorealistic image compositor. You will generate ONE new image.',
    '',
    hasFrame
      ? `PHOTO 1 — AVATAR IDENTITY: This is the person${avDesc} you must place into the scene. Preserve their face, skin tone, hair color, hair texture, and body exactly. This is WHO appears in the output.`
      : `AVATAR IDENTITY: The person${avDesc} to generate.`,
  ].join('\n');

  const sceneLabel = hasFrame
    ? 'PHOTO 2 — BACKGROUND SCENE: This is the source video frame. Preserve the background environment, set design, props, lighting, and camera angle exactly as shown. This is WHERE the Avatar appears in the output.'
    : null;

  const compositeRule = hasFrame
    ? [
        '',
        'COMPOSITING RULE (CRITICAL):',
        '- Place the Avatar (Photo 1) INTO the Scene (Photo 2).',
        '- The Avatar REPLACES the original person from the Scene — do NOT use the original person from Photo 2.',
        '- Do NOT blend, merge, or double-expose these two images.',
        '- Do NOT carry over the Avatar\'s background — use the Scene background only.',
        '- The Avatar\'s face and appearance must look exactly like Photo 1.',
        '- The Scene background must look exactly like Photo 2.',
        '',
      ].join('\n')
    : '\n';

  const avoid = negativePrompt
    ? `\nAVOID: ${negativePrompt}`
    : '';

  const fullPrompt = [preamble, compositeRule, instruction, avoid].filter(Boolean).join('\n');

  // Assemble parts: text → avatar image → (optional) scene label text → frame image → instruction
  const parts = [];

  parts.push({ text: preamble + '\n' });
  parts.push({ inlineData: { mimeType: avatarImg.mime || 'image/jpeg', data: avatarImg.b64 } });

  if (hasFrame && sceneLabel) {
    parts.push({ text: '\n' + sceneLabel + '\n' });
    parts.push({ inlineData: { mimeType: frameImg.mime || 'image/jpeg', data: frameImg.b64 } });
  }

  parts.push({ text: compositeRule + instruction + avoid });

  const requestBody = JSON.stringify({
    contents: [{ role: 'user', parts }],
    generationConfig: {
      responseModalities: ['IMAGE'],
    },
  });

  const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID;
  // generateContent endpoint (not :predict — that's for Imagen)
  const apiPath   = `/v1/projects/${projectId}/locations/${LOCATION}/publishers/google/models/${MODEL}:generateContent`;
  const hostname  = `${LOCATION}-aiplatform.googleapis.com`;

  console.log(`generate-nb-composite: user=${user.id}, model=${MODEL}, hasFrame=${hasFrame}, avatarDescLen=${avatarDesc.length}, instrLen=${instruction.length}`);

  // ── Vertex AI call — no server-side retry; client handles 429 backoff ─────
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
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'No response from Vertex AI. Status: ' + result.status + (result.raw ? ' Raw: ' + result.raw.slice(0,200) : '') }) };
  }

  if (result.status !== 200 || result.data.error) {
    const errMsg = result.data?.error?.message || `Vertex AI error (HTTP ${result.status})`;
    console.error('generate-nb-composite: Vertex AI error:', errMsg);
    const clientStatus = (result.status === 429) ? 429 : 502;
    return { statusCode: clientStatus, headers: CORS, body: JSON.stringify({ error: errMsg }) };
  }

  // ── Extract image from Gemini generateContent response ────────────────────
  // Response shape: { candidates: [{ content: { parts: [{ inlineData: { data, mimeType } }] } }] }
  const candidates = result.data.candidates || [];
  for (const candidate of candidates) {
    for (const part of (candidate.content?.parts || [])) {
      if (part.inlineData?.data) {
        const mime = part.inlineData.mimeType || 'image/jpeg';
        console.log('generate-nb-composite: image generated, mime:', mime);
        return {
          statusCode: 200,
          headers: { ...CORS, 'Content-Type': 'application/json' },
          body: JSON.stringify({ imageB64: part.inlineData.data, mime }),
        };
      }
    }
  }

  // No image — log details for debugging
  const finishReasons = candidates.map(c => c.finishReason || 'unknown').join(', ');
  const safetyRatings = candidates.map(c => JSON.stringify(c.safetyRatings || [])).join(', ');
  console.error('generate-nb-composite: no image in candidates. finishReasons:', finishReasons, '| safetyRatings:', safetyRatings.slice(0, 300));
  return {
    statusCode: 502,
    headers: CORS,
    body: JSON.stringify({ error: `Image generation returned no image. FinishReason: ${finishReasons}`.trim() }),
  };
};
