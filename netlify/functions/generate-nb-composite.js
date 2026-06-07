/**
 * Netlify Function: generate-nb-composite
 * Generates a Nano Banana scene image using a two-stage hybrid pipeline.
 *
 * ── HYBRID PIPELINE (approximates Google Flow's NARWHAL model) ───────────────
 *
 * Stage 1 — Pose Analysis (gemini-2.0-flash-001, text only, ~1–2s)
 *   Sends the scene reference frame to a fast vision model and gets back a
 *   structured JSON description of: arm positions, hand grip, prop detail,
 *   elbow height, body placement, facing direction, and lighting.
 *   Uses a SEPARATE quota bucket from the image model — no quota competition.
 *   Fails gracefully: if analysis fails for any reason, Stage 2 runs as-is.
 *
 * Stage 2 — Composite Generation (gemini-2.5-flash-image, ~15–20s)
 *   The Stage 1 pose analysis is injected at the TOP of the NB Pro instruction
 *   as a [POSE GROUND TRUTH] block. The model now reads explicit text describing
 *   the exact pose BEFORE it sees the ARM section from the NB prompt — this is
 *   what NARWHAL does internally (vision pass → text map → render).
 *
 *   Photo ordering matches Google Flow's Nano Banana 2 agent:
 *     Photo 1 (avatar)  → FIRST — the identity to composite
 *     Photo 2 (frame)   → SECOND — the background scene to preserve
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

const LOCATION       = 'us-central1';
const MODEL          = 'gemini-2.5-flash-image';  // Stage 2: image compositing
const ANALYSIS_MODEL = 'gemini-2.0-flash-001';    // Stage 1: fast pose analysis (separate quota)

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
// Sends the scene frame to a fast text-only vision model and returns a
// structured pose description. This is what NARWHAL does internally before
// rendering — we replicate it with a cheap separate API call.
//
// Uses gemini-2.0-flash-001 (separate DSQ quota from gemini-2.5-flash-image).
// Returns null on any failure — caller falls back to original instruction.
async function analyzeFramePose(frameImg, accessToken, projectId) {
  const prompt = `You are analyzing a scene reference frame for professional photo compositing.
Examine this image carefully. A person is visible — describe their exact physical pose.

Return ONLY a valid JSON object with these exact fields (no markdown, no explanation, raw JSON only):
{
  "left_arm": "left arm position — angle from body (e.g. 45° forward), bent or extended, raised or lowered",
  "right_arm": "right arm position — angle from body, bent or extended, raised or lowered",
  "left_hand": "what left hand is doing — gripping/supporting/open/at side, describe any object held and how",
  "right_hand": "what right hand is doing — gripping/supporting/open/at side, describe any object held and how",
  "elbow_height": "height of elbows — below waist / at waist / at chest / at shoulder / above shoulder",
  "arms_extended": "are arms stretched away from body or held close to torso",
  "prop": "any object being held or interacted with — exact shape, size, which hand holds it, orientation facing camera",
  "body_in_frame": "person placement in frame — left/center/right, approximate % of vertical frame height they fill",
  "facing": "body orientation — straight toward camera / angled left / angled right / profile",
  "lighting": "main light — direction (left/right/above/front/window), color temperature (warm/cool/neutral)"
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
      responseMimeType: 'application/json', // forces valid JSON output, no markdown wrapping
    },
  });

  const analysisPath = `/v1/projects/${projectId}/locations/${LOCATION}/publishers/google/models/${ANALYSIS_MODEL}:generateContent`;

  let res;
  try {
    res = await httpsRequest({
      hostname: `${LOCATION}-aiplatform.googleapis.com`,
      path:     analysisPath,
      method:   'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(reqBody),
      },
    }, reqBody);
  } catch (e) {
    console.warn('analyzeFramePose: request error:', e.message);
    return null;
  }

  if (res.status !== 200 || !res.data) {
    console.warn('analyzeFramePose: non-200 from Vertex:', res.status,
      res.data?.error?.message || res.raw?.slice(0, 200) || '');
    return null;
  }

  const raw = res.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  if (!raw) {
    console.warn('analyzeFramePose: empty response text');
    return null;
  }

  try {
    // Strip any markdown fences in case responseMimeType hint was ignored
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed = JSON.parse(cleaned);
    console.log('analyzeFramePose: OK — prop:', parsed.prop, '| right_arm:', parsed.right_arm);
    return parsed;
  } catch (e) {
    console.warn('analyzeFramePose: JSON parse failed. Raw:', raw.slice(0, 300));
    return null;
  }
}

// ── Build pose injection block from analysis result ───────────────────────────
// Prepended to the NB Pro instruction so the model reads ground-truth pose
// data BEFORE it encounters the ARM section. Mirrors NARWHAL's internal flow.
function buildPoseBlock(pa) {
  return [
    '[POSE GROUND TRUTH — EXTRACTED FROM SCENE FRAME — READ FIRST, OVERRIDE ANY DEFAULTS]',
    `LEFT ARM:        ${pa.left_arm  || 'not specified'}`,
    `RIGHT ARM:       ${pa.right_arm || 'not specified'}`,
    `LEFT HAND:       ${pa.left_hand  || 'not specified'}`,
    `RIGHT HAND:      ${pa.right_hand || 'not specified'}`,
    `ELBOW HEIGHT:    ${pa.elbow_height    || 'not specified'}`,
    `ARMS EXTENDED:   ${pa.arms_extended   || 'not specified'}`,
    `PROP IN HANDS:   ${pa.prop           || 'none'}`,
    `BODY IN FRAME:   ${pa.body_in_frame  || 'not specified'}`,
    `FACING:          ${pa.facing         || 'not specified'}`,
    `SCENE LIGHTING:  ${pa.lighting       || 'not specified'}`,
    'CRITICAL: Avatar\'s arms and hands MUST replicate this pose exactly.',
    '  — Arms are NOT at the avatar\'s sides.',
    '  — Match the elbow height, arm extension, and hand grip described above.',
    '  — The prop must be in the exact hand and orientation described above.',
    '[END POSE GROUND TRUTH]',
    '',
  ].join('\n');
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

  const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID;

  let accessToken;
  try {
    accessToken = await getAccessToken(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  } catch(e) {
    console.error('generate-nb-composite: getAccessToken failed:', e.message);
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Could not authenticate with Vertex AI.' }) };
  }

  const hasFrame = !!frameImg;

  // ── Stage 1: Pose analysis (only when compositing into a scene frame) ─────────
  // Uses gemini-2.0-flash-001 to extract a text map of the scene pose.
  // Result is prepended to the instruction so Stage 2 reads explicit pose data
  // before it encounters the ARM section — same internal logic as NARWHAL.
  // Fails silently: if null, Stage 2 proceeds with the original instruction.
  let enrichedInstruction = instruction;
  if (hasFrame) {
    const poseAnalysis = await analyzeFramePose(frameImg, accessToken, projectId);
    if (poseAnalysis) {
      enrichedInstruction = buildPoseBlock(poseAnalysis) + instruction;
      console.log('generate-nb-composite: Stage 1 pose analysis injected — instruction now', enrichedInstruction.length, 'chars');
    } else {
      console.log('generate-nb-composite: Stage 1 pose analysis unavailable — proceeding without it');
    }
  }

  // ── Stage 2: Composite generation (mirrors Google Flow's Nano Banana 2 format) ─
  // Photo 1 = avatar (identity) FIRST, Photo 2 = scene frame (canvas) SECOND.
  // photo_guide matches the Flow JSON convention exactly.
  // No editPrefix — it conflicts with the NB Pro instruction format.
  const photo_guide = hasFrame
    ? 'Photo 1 = your avatar (person to composite). Photo 2 = Scene reference frame (background/composition to match).'
    : `Generate a photorealistic portrait of ${avatarDesc || 'the person shown in Photo 1'}.`;

  const negLine = negativePrompt ? `\n\nAVOID IN OUTPUT: ${negativePrompt}` : '';
  const fullPrompt = `${photo_guide}\n\n${enrichedInstruction}${negLine}`;

  const parts = [];
  parts.push({ text: 'Photo 1:' });
  parts.push({ inlineData: { mimeType: avatarImg.mime, data: avatarImg.b64 } });
  if (hasFrame) {
    parts.push({ text: 'Photo 2:' });
    parts.push({ inlineData: { mimeType: frameImg.mime, data: frameImg.b64 } });
  }
  parts.push({ text: fullPrompt });

  const requestBody = JSON.stringify({
    systemInstruction: {
      parts: [{ text: 'You are a professional photo compositor. When given Photo 1 (avatar) and Photo 2 (scene reference frame), composite the Photo 1 person into the Photo 2 background exactly as instructed. Preserve every background element in Photo 2 pixel-perfectly. Replace all human body parts in Photo 2 with the Photo 1 person. Output a single photorealistic image.' }],
    },
    contents: [{ role: 'user', parts }],
    generationConfig: {
      responseModalities: ['IMAGE', 'TEXT'],
      temperature: 0.5,
    },
  });

  const apiPath  = `/v1/projects/${projectId}/locations/${LOCATION}/publishers/google/models/${MODEL}:generateContent`;
  const hostname = `${LOCATION}-aiplatform.googleapis.com`;
  const mode     = hasFrame ? 'composite' : 'generate-only';

  console.log(`generate-nb-composite: user=${user.id}, model=${MODEL}, mode=${mode}, promptLen=${fullPrompt.length}`);

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
    console.error('generate-nb-composite: Vertex fetch error:', e.message);
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Could not reach Vertex AI: ' + e.message }) };
  }

  console.log('generate-nb-composite: Vertex AI status:', result.status);

  // FIX: check 429 BEFORE the !result.data guard — if Vertex returns a 429 with a
  // non-JSON body (e.g. from an intermediate proxy), data is null and the 502 path
  // would fire instead of the correct 429, causing the client retry logic to break.
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
