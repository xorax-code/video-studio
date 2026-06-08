/**
 * Netlify Function: generate-nb-composite
 *
 * ── PIPELINE ─────────────────────────────────────────────────────────────────
 *
 * Stage 1 — Pose Analysis  (gemini-2.0-flash-001, text-only, ~1–2s)
 *   Analyzes the scene frame: arm positions, prop details, lighting, background.
 *   Separate quota from the image model. Fails gracefully.
 *
 * Stage 2 — Appearance Transfer  (gemini-2.5-flash-image, single call)
 *   Photo 1 = scene frame  (base image — background, arms, prop all locked)
 *   Photo 2 = avatar       (face, hair, clothing to apply to the person in Photo 1)
 *
 *   Task: appearance transfer, not person replacement.
 *   The original person's pose, arm positions, and prop grip are preserved.
 *   Only their face, hair, headwrap, clothing and jewelry change.
 *
 * Takes:
 *   - avatarB64      — base64 avatar photo
 *   - avatarMime     — MIME type of avatar
 *   - frameB64       — base64 source video frame
 *   - frameMime      — MIME type of frame
 *   - instruction    — NB Pro generation instruction from 17-nb-api.js
 *   - avatarDesc     — text description of the avatar's appearance
 *   - negativePrompt — things to avoid
 *
 * Returns: { imageB64, mime }
 */

const https  = require('https');
const crypto = require('crypto');

const LOCATION       = 'us-central1';
const MODEL          = 'gemini-3.1-flash-image-preview';
const ANALYSIS_MODEL = 'gemini-2.0-flash-001';

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
      'apikey':        process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_ANON,
    },
  });
  if (result.status !== 200 || !result.data?.id) return null;
  return result.data;
}

// ── Stage 1: Pose analysis ────────────────────────────────────────────────────
async function analyzeFramePose(frameImg, accessToken, projectId) {
  const prompt = `You are analyzing a video frame for photo compositing. A person is visible.

Return ONLY a valid JSON object with these exact fields (no markdown, raw JSON only):
{
  "camera_angle": "shot description — e.g. 'straight-on chest height, medium shot'",
  "background": "precise description of everything visible behind the person — room type, wall color, shelves, objects, window, flags, decor",
  "arm_instruction": "single sentence describing both arms and hands — e.g. 'right hand holds large open mouth model extended toward camera, left hand supports from below'",
  "prop": "if a prop/object is held: exact name, shape, size, color, which hand, orientation. If none: 'none'",
  "prop_state": "visible state of the prop — e.g. 'mouth model open, facing camera, showing teeth'. If no prop: 'none'",
  "lighting": "lighting description — e.g. 'warm ambient light from above, soft shadows'"
}`;

  const reqBody = JSON.stringify({
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { mimeType: frameImg.mime, data: frameImg.b64 } },
        { text: prompt },
      ],
    }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 600,
      responseMimeType: 'application/json',
    },
  });

  const path = `/v1/projects/${projectId}/locations/${LOCATION}/publishers/google/models/${ANALYSIS_MODEL}:generateContent`;
  try {
    const res = await httpsRequest({
      hostname: `${LOCATION}-aiplatform.googleapis.com`,
      path, method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(reqBody),
      },
    }, reqBody);

    if (res.status !== 200 || !res.data) { console.warn('analyzeFramePose: non-200:', res.status); return null; }
    const raw = res.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!raw) return null;
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed = JSON.parse(cleaned);
    console.log('analyzeFramePose: OK — prop:', parsed.prop, '| arm:', parsed.arm_instruction);
    return parsed;
  } catch(e) {
    console.warn('analyzeFramePose: error:', e.message);
    return null;
  }
}

// ── Build LOCK instruction block from pose analysis ───────────────────────────
function buildLockBlock(pa) {
  const lines = [];
  if (pa.background)                          lines.push(`LOCK BACKGROUND: ${pa.background}.`);
  if (pa.arm_instruction)                     lines.push(`LOCK ARMS: ${pa.arm_instruction} — do not move these arms.`);
  if (pa.prop && pa.prop !== 'none')          lines.push(`LOCK PROP: ${pa.prop} — keep exactly as held, same grip and orientation.`);
  if (pa.prop_state && pa.prop_state !== 'none') lines.push(`PROP STATE: ${pa.prop_state}.`);
  if (pa.lighting)                            lines.push(`LOCK LIGHT: ${pa.lighting}.`);
  lines.push('');
  return lines.join('\n');
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
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Server configuration error.' }) };
  }

  const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
  const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!jwt) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Missing authorization token.' }) };

  let user;
  try { user = await getAuthUser(jwt); } catch(e) {
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Auth check failed: ' + e.message }) };
  }
  if (!user) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Invalid or expired session.' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON body.' }) }; }

  const {
    instruction    = '',
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

  if (!avatarImg) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Avatar image is required.' }) };
  }

  const hasFrame  = !!frameImg;
  const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID;

  let accessToken;
  try {
    accessToken = await getAccessToken(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  } catch(e) {
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Could not authenticate with Vertex AI.' }) };
  }

  // ── Stage 1: Pose analysis ────────────────────────────────────────────────
  let poseAnalysis = null;
  if (hasFrame) {
    poseAnalysis = await analyzeFramePose(frameImg, accessToken, projectId);
  }

  // ── Stage 2: Appearance transfer ─────────────────────────────────────────
  // Photo 1 = scene frame (base image — the model edits this)
  // Photo 2 = avatar      (appearance source: face, hair, clothing)
  //
  // The person's pose, arms, and prop in Photo 1 are locked.
  // Only their appearance (face, hair, headwrap, clothing, jewelry) changes.

  const lockBlock = (hasFrame && poseAnalysis) ? buildLockBlock(poseAnalysis) : '';

  const systemInstruction = hasFrame ? `You are a photo editor performing APPEARANCE TRANSFER.

Photo 1 = BASE SCENE — edit this image. The background, arm positions, prop grip, body scale and position are all locked.
Photo 2 = APPEARANCE SOURCE — apply this person's face, hair, headwrap, clothing and jewelry to the person in Photo 1.

WHAT TO CHANGE (take from Photo 2):
- Face and skin tone: apply Photo 2's face (elderly woman, dark brown skin, weathered features)
- Hair: replace with Photo 2's long grey dreadlocks
- Head covering: apply Photo 2's colorful headwrap/turban
- Clothing: replace with Photo 2's white dress with gold trim
- Jewelry: add Photo 2's amber bead necklaces and cowrie shells
- Body silhouette: reshape toward Photo 2's female figure — softer shoulders, feminine form

WHAT TO LOCK (keep from Photo 1 exactly):
- Background: every wall, shelf, jar, flag, window — pixel-perfect
- Arm positions and hand grip: exactly as they appear in Photo 1
- Prop/product: same object, same position, same grip, same orientation
- Subject scale and position in frame
- Scene lighting and shadows` : `Generate a photorealistic portrait with the appearance of the person in Photo 1.`;

  const userPrompt = hasFrame
    ? `${lockBlock}APPEARANCE TRANSFER: Apply Photo 2's face, hair, headwrap, clothing and jewelry to the person in Photo 1. Keep all LOCK items unchanged.\n\n${instruction}`
    : `Portrait of ${avatarDesc || 'the person shown'}.`;

  const negLine = `\n\nAVOID: changed background, wrong background, avatar background, moved arms, moved prop, prop replaced with different object, floating prop, ghost limbs, two people, composite seam, text overlay`;
  const fullPrompt = userPrompt + negLine;

  const parts = [];
  if (hasFrame) {
    parts.push({ text: 'Photo 1 — BASE SCENE (edit this — background, arms, and prop are all locked):' });
    parts.push({ inlineData: { mimeType: frameImg.mime, data: frameImg.b64 } });
  }
  parts.push({ text: 'Photo 2 — APPEARANCE SOURCE (face, hair, headwrap, clothing, jewelry to apply):' });
  parts.push({ inlineData: { mimeType: avatarImg.mime, data: avatarImg.b64 } });
  parts.push({ text: fullPrompt });

  const requestBody = JSON.stringify({
    systemInstruction: { parts: [{ text: systemInstruction }] },
    contents: [{ role: 'user', parts }],
    generationConfig: {
      responseModalities: ['IMAGE', 'TEXT'],
      temperature: 0.1,
    },
  });

  const apiPath  = `/v1/projects/${projectId}/locations/${LOCATION}/publishers/google/models/${MODEL}:generateContent`;
  const hostname = `${LOCATION}-aiplatform.googleapis.com`;
  const mode     = hasFrame ? (poseAnalysis ? 'appearance-transfer+analysis' : 'appearance-transfer') : 'generate-only';

  console.log(`generate-nb-composite: user=${user.id}, model=${MODEL}, mode=${mode}, promptLen=${fullPrompt.length}`);

  let result;
  try {
    result = await httpsRequest({
      hostname, path: apiPath, method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(requestBody),
      },
    }, requestBody);
  } catch(e) {
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Could not reach Vertex AI: ' + e.message }) };
  }

  console.log('generate-nb-composite: Vertex AI status:', result.status);

  if (result.status === 429) {
    return { statusCode: 429, headers: CORS, body: JSON.stringify({ error: 'Vertex AI rate limit. Please wait and retry.' }) };
  }
  if (!result.data) {
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'No response from Vertex AI. Status: ' + result.status }) };
  }
  if (result.status !== 200 || result.data.error) {
    const errMsg = result.data?.error?.message || `Vertex AI error (HTTP ${result.status})`;
    console.error('generate-nb-composite: error:', errMsg);
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: errMsg }) };
  }

  const candidates = result.data.candidates || [];
  for (const candidate of candidates) {
    const responseParts = candidate?.content?.parts || [];
    for (const part of responseParts) {
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

  console.error('generate-nb-composite: no image in response:', JSON.stringify(result.data).slice(0, 500));
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
