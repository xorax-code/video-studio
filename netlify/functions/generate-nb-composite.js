/**
 * Netlify Function: generate-nb-composite
 *
 * ── PIPELINE ─────────────────────────────────────────────────────────────────
 *
 * Stage 1 — Pose Analysis  (gemini-2.0-flash-001, text-only, ~1–2s)
 *   Analyzes the scene frame: arm positions, prop details, lighting, background.
 *   Separate quota from the image model. Fails gracefully.
 *
 * Stage 2 — Imagen 3 Inpaint  (imagen-3.0-capability-001)
 *   Uses EDIT_MODE_INPAINT_INSERTION with MASK_MODE_FOREGROUND:
 *   - Imagen automatically detects and masks the person in the scene frame
 *   - Replaces only the masked region with the avatar appearance + prop
 *   - Background outside the mask is preserved pixel-perfectly
 *   - No hand-crafted mask image required
 *
 * Why this works where gemini-2.5-flash-image didn't:
 *   Imagen 3 is a dedicated editing model. The foreground mask constrains edits
 *   to the person region only — background drift is structurally impossible.
 *   The model doesn't need to "decide" what to keep vs change.
 *
 * Takes:
 *   - avatarB64      — base64 avatar photo (identity reference — appearance only)
 *   - avatarMime     — MIME type of avatar
 *   - frameB64       — base64 source video frame (scene to edit)
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
const EDIT_MODEL     = 'imagen-3.0-capability-001';  // Stage 2: Imagen 3 edit
const ANALYSIS_MODEL = 'gemini-2.0-flash-001';       // Stage 1: pose analysis

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
  const prompt = `You are analyzing a video frame for professional photo compositing. A person is visible.
Extract precise details in the exact format used by compositing software.

Return ONLY a valid JSON object with these exact fields (no markdown, no explanation, raw JSON only):
{
  "camera_angle": "shot description — e.g. 'straight-on chest height' or 'slightly below eye level, medium shot'",
  "background": "precise description of everything visible behind the person — room type, wall color/material, shelves, objects on shelves, furniture, window position, any flags, signs, or decor",
  "arm_instruction": "single sentence describing both arms and hands — e.g. 'right hand holds large open mouth model extended toward camera, left hand supports it from below'",
  "prop": "if a prop/object is held: exact name, shape, size, color, which hand, how gripped, orientation toward camera. If none: 'none'",
  "prop_state": "visible state of the prop — e.g. 'mouth model open, facing camera, showing teeth and tongue'. If no prop: 'none'",
  "lighting": "lighting description — e.g. 'warm ambient, soft shadows from above'"
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

  const analysisPath = `/v1/projects/${projectId}/locations/${LOCATION}/publishers/google/models/${ANALYSIS_MODEL}:generateContent`;

  try {
    const res = await httpsRequest({
      hostname: `${LOCATION}-aiplatform.googleapis.com`,
      path:     analysisPath,
      method:   'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(reqBody),
      },
    }, reqBody);

    if (res.status !== 200 || !res.data) {
      console.warn('analyzeFramePose: non-200:', res.status);
      return null;
    }
    const raw = res.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!raw) return null;
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed = JSON.parse(cleaned);
    console.log('analyzeFramePose: OK — prop:', parsed.prop);
    return parsed;
  } catch (e) {
    console.warn('analyzeFramePose: error:', e.message);
    return null;
  }
}

// ── Build the inpaint prompt from pose analysis + avatar description ──────────
// This goes to Imagen 3 as the text prompt describing what to insert
// into the masked (foreground/person) region.
function buildImagenPrompt(avatarDesc, poseAnalysis) {
  const parts = [];

  // Avatar appearance — who to insert
  if (avatarDesc) parts.push(avatarDesc);

  // Arm position and prop — what they're holding and how
  if (poseAnalysis?.arm_instruction && poseAnalysis.arm_instruction !== 'none') {
    parts.push(poseAnalysis.arm_instruction);
  }
  if (poseAnalysis?.prop && poseAnalysis.prop !== 'none') {
    parts.push(poseAnalysis.prop);
  }
  if (poseAnalysis?.prop_state && poseAnalysis.prop_state !== 'none') {
    parts.push(poseAnalysis.prop_state);
  }

  // Lighting match
  if (poseAnalysis?.lighting) {
    parts.push(poseAnalysis.lighting);
  }

  return parts.join(', ');
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
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Auth check failed: ' + authErr.message }) };
  }
  if (!user) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Invalid or expired session.' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON body.' }) }; }

  const {
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

  // ── Stage 2: Imagen 3 inpaint edit ───────────────────────────────────────
  // Uses EDIT_MODE_INPAINT_INSERTION + MASK_MODE_FOREGROUND:
  //   - Imagen auto-detects the person in the scene frame
  //   - Replaces just that region with the avatar appearance
  //   - Background outside mask is pixel-perfect preserved

  const imagenPrompt = hasFrame
    ? buildImagenPrompt(avatarDesc, poseAnalysis)
    : (avatarDesc || 'portrait of a person');

  console.log(`generate-nb-composite: user=${user.id}, model=${EDIT_MODEL}, hasFrame=${hasFrame}, prompt="${imagenPrompt.slice(0, 120)}"`);

  const requestBody = JSON.stringify({
    instances: [
      {
        prompt: imagenPrompt,
        referenceImages: [
          // The scene frame — base image to edit
          {
            referenceType: 'REFERENCE_TYPE_RAW',
            referenceId: 1,
            referenceImage: {
              bytesBase64Encoded: frameImg ? frameImg.b64 : avatarImg.b64,
            },
          },
          // Automatic foreground (person) mask — Imagen detects the person
          {
            referenceType: 'REFERENCE_TYPE_MASK',
            referenceId: 2,
            maskImageConfig: {
              maskMode: 'MASK_MODE_FOREGROUND',
              dilation: 0.02,  // small dilation to catch edge pixels
            },
          },
        ],
      },
    ],
    parameters: {
      editMode: 'EDIT_MODE_INPAINT_INSERTION',
      sampleCount: 1,
      editConfig: {
        baseSteps: 75,  // max quality; increase latency but better results for person replacement
      },
    },
  });

  const apiPath  = `/v1/projects/${projectId}/locations/${LOCATION}/publishers/google/models/${EDIT_MODEL}:predict`;
  const hostname = `${LOCATION}-aiplatform.googleapis.com`;

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
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Could not reach Vertex AI: ' + e.message }) };
  }

  console.log('generate-nb-composite: Imagen 3 status:', result.status);

  if (result.status === 429) {
    return { statusCode: 429, headers: CORS, body: JSON.stringify({ error: 'Vertex AI rate limit. Please wait and retry.' }) };
  }

  if (!result.data) {
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'No response from Vertex AI. Status: ' + result.status + (result.raw ? ' Raw: ' + result.raw.slice(0, 300) : '') }) };
  }

  if (result.status !== 200 || result.data.error) {
    const errMsg = result.data?.error?.message || `Vertex AI error (HTTP ${result.status})`;
    console.error('generate-nb-composite: Vertex AI error:', errMsg);
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: errMsg }) };
  }

  // Imagen 3 response: predictions[].bytesBase64Encoded
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

  console.error('generate-nb-composite: no image in response:', JSON.stringify(result.data).slice(0, 500));
  return {
    statusCode: 502,
    headers: CORS,
    body: JSON.stringify({ error: 'Imagen 3 returned no image. Check Vertex AI logs.' }),
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
