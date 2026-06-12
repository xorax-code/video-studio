/**
 * Netlify Function: generate-nb-composite
 *
 * ── PIPELINE ─────────────────────────────────────────────────────────────────
 *
 * Stage 1 — Pose Analysis  (gemini-2.0-flash via Gemini Developer API, text-only)
 *   Analyzes the scene frame: arm positions, prop details, lighting, background.
 *
 * Stage 2 — Appearance Transfer  (gemini-3.1-flash-image via Gemini Developer API)
 *   Nano Banana 2 — Google's model with native character consistency.
 *   Photo 1 = scene frame  (base image — background, arms, prop all locked)
 *   Photo 2 = avatar       (face, hair, clothing to apply to the person in Photo 1)
 *
 * Requires env var: GEMINI_API_KEY  (from aistudio.google.com/apikey)
 */

const https  = require('https');
const crypto = require('crypto');

const MODEL                 = 'gemini-3.1-flash-image';     // default (Flash) — now runs on Vertex AI (Gemini Dev API = fallback)
const PRO_MODEL             = 'gemini-3-pro-image-preview'; // "Max Quality" (Nano Banana Pro) — Vertex AI
const ANALYSIS_MODEL        = 'gemini-2.0-flash';          // pose analysis on the Gemini Dev API (fallback only)
const VERTEX_ANALYSIS_MODEL = 'gemini-2.0-flash-001';      // pose analysis on Vertex AI (primary)
const GEMINI_HOST           = 'generativelanguage.googleapis.com';
const VERTEX_LOCATION       = 'us-central1';
const CREDIT_COST     = 2; // credits per composite frame, default Flash quality
const CREDIT_COST_PRO = 5; // credits per composite frame, Max Quality (Pro) — ~2x the real cost
// Vertex-only mode: while burning the Google Cloud credit, do NOT fall back to the
// (empty) Gemini Developer API key. Flip to true to re-enable the Gemini safety net.
const ALLOW_GEMINI_FALLBACK = false;

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

// ── OAuth2: service account → access token (for Vertex AI / Pro image) ────────
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

function _hasImage(data) {
  return ((data && data.candidates) || []).some(c => ((c && c.content && c.content.parts) || []).some(p => p && p.inlineData && p.inlineData.data));
}

// Generic Vertex AI generateContent call (Bearer token). Returns { status, data }.
async function vertexGenerateContent(modelId, reqJson, token, location) {
  const loc  = location || VERTEX_LOCATION;
  const path = `/v1/projects/${process.env.GOOGLE_CLOUD_PROJECT_ID}/locations/${loc}/publishers/google/models/${modelId}:generateContent`;
  return httpsRequest({
    hostname: `${loc}-aiplatform.googleapis.com`, path, method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(reqJson) },
  }, reqJson);
}

// Send the image request to the chosen model.
//  - wantPro  → Nano Banana Pro on Vertex first.
//  - default  → Flash (gemini-3.1-flash-image) on Vertex first (higher limits, one billing
//               lane with Veo). The Gemini Developer API is only a fallback now.
// `vtxToken` is a pre-fetched Vertex access token (or null). Returns { status, data, usedPro }.
async function callImageModel(requestObj, apiKey, wantPro, vtxToken) {
  const reqJson = JSON.stringify(requestObj);

  // 1) Vertex Pro (only when Max Quality requested)
  if (wantPro && vtxToken && process.env.GOOGLE_CLOUD_PROJECT_ID) {
    try {
      const r = await vertexGenerateContent(PRO_MODEL, reqJson, vtxToken);
      if (r.status === 200 && _hasImage(r.data)) return { status: 200, data: r.data, usedPro: true };
      console.warn('generate-nb-composite: Vertex Pro unavailable, trying Vertex Flash —', r.status, (r.data && r.data.error && r.data.error.message) || '');
    } catch (e) {
      console.warn('generate-nb-composite: Vertex Pro error, trying Vertex Flash —', e.message);
    }
  }

  // 2) Vertex Flash (the default path for every standard frame)
  let lastVertex = null;
  if (vtxToken && process.env.GOOGLE_CLOUD_PROJECT_ID) {
    try {
      const r = await vertexGenerateContent(MODEL, reqJson, vtxToken);
      if (r.status === 200 && _hasImage(r.data)) return { status: 200, data: r.data, usedPro: false };
      lastVertex = r;
      console.warn('generate-nb-composite: Vertex Flash unavailable —', r.status, (r.data && r.data.error && r.data.error.message) || '');
    } catch (e) {
      console.warn('generate-nb-composite: Vertex Flash error —', e.message);
    }
  }

  // 3) Fallback: Flash on the Gemini Developer API — disabled in Vertex-only mode
  if (ALLOW_GEMINI_FALLBACK && apiKey) {
    const r2 = await httpsRequest({
      hostname: GEMINI_HOST, path: `/v1beta/models/${MODEL}:generateContent?key=${apiKey}`, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(reqJson) },
    }, reqJson);
    return { status: r2.status, data: r2.data, usedPro: false };
  }

  // Vertex-only: surface the Vertex outcome (or a clear error) instead of the empty key.
  if (lastVertex) return { status: lastVertex.status || 502, data: lastVertex.data, usedPro: false };
  return { status: 502, data: { error: { message: 'Vertex image generation unavailable (Gemini fallback disabled).' } }, usedPro: false };
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

// ── Supabase admin (credits) ──────────────────────────────────────────────────
async function getAdminUser(userId) {
  const url = new URL(`${process.env.SUPABASE_URL}/auth/v1/admin/users/${userId}`);
  const k   = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const r   = await httpsRequest({ hostname: url.hostname, path: url.pathname, method: 'GET',
    headers: { 'Authorization': `Bearer ${k}`, 'apikey': k } });
  return r.status === 200 ? r.data : null;
}
async function updateUserMeta(userId, meta) {
  const url = new URL(`${process.env.SUPABASE_URL}/auth/v1/admin/users/${userId}`);
  const k   = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const b   = JSON.stringify({ app_metadata: meta });
  const r   = await httpsRequest({ hostname: url.hostname, path: url.pathname, method: 'PUT',
    headers: { 'Authorization': `Bearer ${k}`, 'apikey': k, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) } }, b);
  return r.status === 200;
}

// ── Stage 1: Pose analysis ────────────────────────────────────────────────────
async function analyzeFramePose(frameImg, apiKey, vtxToken) {
  const prompt = `You are analyzing a video frame for photo compositing. A person is visible.

Return ONLY a valid JSON object with these exact fields (no markdown, raw JSON only):
{
  "camera_angle": "shot description — e.g. 'straight-on chest height, medium shot'",
  "visible_person": "which parts of the person are actually in frame — choose the closest single phrase: 'hands only', 'arms only', 'arms and torso, no face', 'face and upper body', or 'full body'",
  "face_in_frame": "boolean true or false — is a human FACE or HEAD actually visible in this frame? Answer false when only a hand, arm, forearm, or torso is shown (a hand holding a product with no face = false).",
  "full_body_in_frame": "boolean true or false — is a full standing/seated body visible (not just hands/arms)?",
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
      responseSchema: {
        type: 'object',
        properties: {
          camera_angle:       { type: 'string' },
          visible_person:     { type: 'string' },
          face_in_frame:      { type: 'boolean' },
          full_body_in_frame: { type: 'boolean' },
          background:         { type: 'string' },
          arm_instruction:    { type: 'string' },
          prop:               { type: 'string' },
          prop_state:         { type: 'string' },
          lighting:           { type: 'string' },
        },
        required: ['visible_person', 'face_in_frame', 'full_body_in_frame', 'background', 'arm_instruction', 'prop', 'lighting'],
      },
    },
  });

  // Pull the structured JSON out of a generateContent response (shared by both paths)
  function _parsePose(res, src) {
    if (!res || res.status !== 200 || !res.data) { console.warn('analyzeFramePose: ' + src + ' non-200:', res && res.status); return null; }
    const raw = (res.data.candidates && res.data.candidates[0] && res.data.candidates[0].content
      && res.data.candidates[0].content.parts && res.data.candidates[0].content.parts[0]
      && res.data.candidates[0].content.parts[0].text) || '';
    if (!raw) return null;
    try {
      const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
      const parsed = JSON.parse(cleaned);
      console.log('analyzeFramePose: OK (' + src + ') — prop:', parsed.prop, '| arm:', parsed.arm_instruction);
      return parsed;
    } catch(e) { console.warn('analyzeFramePose: parse error (' + src + '):', e.message); return null; }
  }

  // 1) Vertex AI first (gemini-2.0-flash-001) — same billing lane as the images
  if (vtxToken && process.env.GOOGLE_CLOUD_PROJECT_ID) {
    try {
      const rv = await vertexGenerateContent(VERTEX_ANALYSIS_MODEL, reqBody, vtxToken);
      const pv = _parsePose(rv, 'vertex');
      if (pv) return pv;
      console.warn('analyzeFramePose: vertex returned no usable result, falling back to Gemini Dev API');
    } catch(e) { console.warn('analyzeFramePose: vertex error, falling back to Gemini Dev API:', e.message); }
  }

  // 2) Fallback: Gemini Developer API — disabled in Vertex-only mode (pose analysis
  //    is optional, so returning null just skips the lock block, no hard failure).
  if (!ALLOW_GEMINI_FALLBACK || !apiKey) return null;
  try {
    const res = await httpsRequest({
      hostname: GEMINI_HOST,
      path: `/v1beta/models/${ANALYSIS_MODEL}:generateContent?key=${apiKey}`, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(reqBody) },
    }, reqBody);
    return _parsePose(res, 'gemini-api');
  } catch(e) {
    console.warn('analyzeFramePose: error:', e.message);
    return null;
  }
}

// ── Build LOCK instruction block from pose analysis ───────────────────────────
function buildLockBlock(pa, skipProp) {
  const lines = [];
  if (pa.background)                             lines.push(`lock background: ${pa.background}.`);
  if (pa.arm_instruction)                        lines.push(`lock arms: ${pa.arm_instruction} — do not move these arms.`);
  if (skipProp) {
    // Product is being replaced — keep the hand/grip but NOT the original object.
    lines.push(`hand & grip: keep the exact hand position, grip, finger placement, and arm pose — but the held object itself will be swapped (see PRODUCT REPLACE).`);
  } else {
    if (pa.prop && pa.prop !== 'none')             lines.push(`lock prop: ${pa.prop} — keep exactly as held, same grip and orientation.`);
    if (pa.prop_state && pa.prop_state !== 'none') lines.push(`prop state: ${pa.prop_state}.`);
  }
  if (pa.lighting)                               lines.push(`lock light: ${pa.lighting}.`);
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

  const apiKey = process.env.GEMINI_API_KEY || '';
  const _vertexConfigured = !!(process.env.GOOGLE_SERVICE_ACCOUNT_JSON && process.env.GOOGLE_CLOUD_PROJECT_ID);
  if (!apiKey && !_vertexConfigured) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'No image backend configured (set GEMINI_API_KEY or a Vertex service account).' }) };
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

  // Max Quality (Nano Banana Pro on Vertex) — costs more credits than the default Flash frame
  const wantPro     = (body.quality === 'pro' || body.maxQuality === true);
  const composeCost = wantPro ? CREDIT_COST_PRO : CREDIT_COST;

  // Pre-fetch a Vertex access token once — shared by the image model and the pose
  // analysis. Null if Vertex isn't configured or the token exchange fails; both
  // calls then fall back to the Gemini Developer API.
  let vtxToken = null;
  if (_vertexConfigured) {
    try { vtxToken = await getAccessToken(process.env.GOOGLE_SERVICE_ACCOUNT_JSON); }
    catch(e) { console.warn('generate-nb-composite: Vertex token exchange failed, using Gemini Dev API —', e.message); }
  }

  // ── Credit gate (check upfront; deduct the ACTUAL cost after a frame is produced) ──
  let _composeBalance = 0;
  {
    const adminUser = await getAdminUser(user.id);
    if (!adminUser) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Could not read account data.' }) };
    _composeBalance = adminUser.app_metadata?.credits_balance ?? 0;
    if (_composeBalance < composeCost) {
      return { statusCode: 402, headers: CORS, body: JSON.stringify({ error: 'insufficient_credits', message: `You're out of credits for image generation (${composeCost} per ${wantPro ? 'max-quality ' : ''}frame). Balance: ${_composeBalance}.`, balance: _composeBalance, cost: composeCost }) };
    }
  }
  async function _chargeCompose(cost) {
    const c = (typeof cost === 'number') ? cost : composeCost;
    const ok = await updateUserMeta(user.id, { credits_balance: _composeBalance - c });
    if (!ok) console.error(`generate-nb-composite: credit deduction failed for user ${user.id}`);
  }

  const {
    instruction    = '',
    avatarDesc     = '',
    negativePrompt = '',
    avatarB64,
    avatarMime     = 'image/jpeg',
    frameB64       = null,
    frameMime      = 'image/jpeg',
    productB64     = null,
    productMime    = 'image/jpeg',
    handRefB64     = null,
    handRefMime    = 'image/jpeg',
    creative       = false,
  } = body;

  let avatarImg = null, frameImg = null, productImg = null, handRefImg = null;
  if (Array.isArray(body.images) && body.images.length > 0) {
    const imgs = body.images.filter(img => img && img.b64);
    if (imgs[0]) avatarImg  = imgs[0];
    if (imgs[1]) frameImg   = imgs[1];
    if (imgs[2]) productImg = imgs[2];
  } else if (avatarB64) {
    avatarImg = { b64: avatarB64, mime: avatarMime };
    if (frameB64)   frameImg   = { b64: frameB64, mime: frameMime };
    if (productB64) productImg = { b64: productB64, mime: productMime };
    if (handRefB64) handRefImg = { b64: handRefB64, mime: handRefMime };
  }
  // The locked hand reference applies only when compositing onto a real frame.
  const hasHandRef = !!(frameImg && handRefImg);

  if (!avatarImg) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Avatar image is required.' }) };
  }

  const hasFrame   = !!frameImg;
  // Two product modes:
  //   swap — compositing on a real frame: REPLACE the held product (Replicator).
  //   gen  — no frame: the generated avatar HOLDS this exact product (Producer).
  const hasProductSwap = !!(frameImg && productImg);
  const hasProductGen  = !!(!frameImg && productImg);
  const hasProduct     = hasProductSwap; // back-compat alias for the swap path below

  // ── Creative mode (Studio tab) — skip pose analysis, use open system prompt ─
  if (creative) {
    const creativeParts = [];
    for (const img of [avatarImg, frameImg].filter(Boolean)) {
      creativeParts.push({ inlineData: { mimeType: img.mime, data: img.b64 } });
    }
    creativeParts.push({ text: instruction || 'Generate a high-quality image based on the reference photos.' });

    const creativeReq = {
      systemInstruction: { parts: [{ text: 'You are a professional photo editor and image generator. Follow the user\'s instruction exactly and creatively. Use any provided reference photos as visual guides.' }] },
      contents: [{ role: 'user', parts: creativeParts }],
      generationConfig: { responseModalities: ['IMAGE', 'TEXT'], temperature: 0.7 },
    };

    // Routes Vertex-first (Flash, or Pro when Max Quality), Gemini Dev API fallback.
    let creativeResult;
    try {
      creativeResult = await callImageModel(creativeReq, apiKey, wantPro, vtxToken);
    } catch(e) {
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Could not reach image model: ' + e.message }) };
    }

    if (creativeResult.status === 429) return { statusCode: 429, headers: CORS, body: JSON.stringify({ error: 'Rate limit — please wait and retry.' }) };
    if (!creativeResult.data || creativeResult.status !== 200 || creativeResult.data.error) {
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: (creativeResult.data && creativeResult.data.error && creativeResult.data.error.message) || ('Image model error ' + creativeResult.status) }) };
    }
    for (const candidate of creativeResult.data.candidates || []) {
      for (const part of candidate?.content?.parts || []) {
        if (part.inlineData?.data) {
          const _cc = creativeResult.usedPro ? CREDIT_COST_PRO : CREDIT_COST;
          await _chargeCompose(_cc);
          return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ imageB64: part.inlineData.data, mime: part.inlineData.mimeType || 'image/png', creditsDeducted: _cc, quality: creativeResult.usedPro ? 'pro' : 'flash' }) };
        }
      }
    }
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Model returned no image.' }) };
  }

  // ── Stage 1: Pose analysis ────────────────────────────────────────────────
  let poseAnalysis = null;
  if (hasFrame) {
    poseAnalysis = await analyzeFramePose(frameImg, apiKey, vtxToken);
  }

  // ── Stage 2: Appearance transfer via Nano Banana 2 ───────────────────────
  // Photo 1 = scene frame (base — background, arms, prop locked)
  // Photo 2 = avatar      (appearance source: face, hair, clothing)

  const lockBlock = (hasFrame && poseAnalysis) ? buildLockBlock(poseAnalysis, hasProduct) : '';

  // What's actually visible in the source frame — drives how much of the person to replace.
  // Prefer the explicit boolean from analysis; fall back to a phrase regex; default to
  // face-visible (full replace) when analysis is entirely missing, to preserve old behavior.
  const _vp = ((poseAnalysis && poseAnalysis.visible_person) || '').toLowerCase();
  const _faceBool = poseAnalysis ? poseAnalysis.face_in_frame : undefined;
  const _faceBoolIsFalse = (_faceBool === false || _faceBool === 'false' || _faceBool === 'no');
  const faceOutOfFrameRegex = /hands?\s*only|arms?\s*only|no\s*face|without.*face|faceless|below\s*(the\s*)?(neck|chin|shoulders)|forearm|wrist|hands?\s*(and|&)\s*arms?\s*only/.test(_vp);
  const faceOutOfFrame = hasFrame && (_faceBoolIsFalse || faceOutOfFrameRegex);
  const faceVisible = hasFrame && !faceOutOfFrame;

  // Person handling — the MAIN image model decides from Photo 1's actual content, so this
  // works even if the secondary analysis fails. Analysis (when available) is appended as a hint.
  const _analysisHint = !hasFrame ? ''
    : faceOutOfFrame ? ' [Analysis of Photo 1: HAND/ARM-ONLY, no person — apply Case B.]'
    : (faceVisible && poseAnalysis) ? ' [Analysis of Photo 1: a person is visible — apply Case A.]'
    : '';
  const faceReplaceDirective = !hasFrame ? '' :
`PERSON HANDLING (critical — first LOOK at Photo 1, then apply the ONE matching case):

CASE A — Photo 1 shows a person's FACE or BODY: Completely replace that person's identity AND their clothing with the Photo 2 avatar — exact face, skin tone, hair, hands, body type, and OUTFIT. The person in the output must look like Photo 2 and must be wearing the avatar's OWN clothing (for example her tank top), NOT the original person's shirt. Match the avatar's gender and skin: if the avatar is a woman, give her smooth, feminine, hairless arms and hands — remove any arm hair, coarse hair, stubble, or masculine features from the original person. Integrate them so they look genuinely PHOTOGRAPHED in this scene, not pasted: match Photo 1's lighting direction and color temperature, shadow softness, grain/noise, perspective, and depth of field; add natural contact shadows and blended edges; no cut-out halo or sticker look.

CASE B — Photo 1 shows ONLY a hand or arm holding the product (NO face, NO body, no person): Keep it as ONLY that hand/arm, but REPLACE its appearance to match the Photo 2 avatar — skin tone, gender, and clothing color. If the avatar is a woman, it MUST be a smooth, hairless, feminine hand and forearm: REMOVE all arm hair, coarse hair, knuckle hair, stubble, and masculine features from the original Photo 1 arm — do NOT keep the original person's hairy or male-looking arm. Photo 2 is ONLY a skin/appearance reference here — it is NOT a person to insert. Do NOT add, draw, or place a face, head, hair, or any standing/seated person ANYWHERE in the image, including the background. Keep the EXACT same crop and framing as Photo 1 — output only the same hand/arm holding the product.

In BOTH cases: NEVER add a second person, a duplicate, or any extra human figure that was not already in Photo 1.${_analysisHint}\n\n`;

  // Hand-lock directive — when a locked hand reference is provided, the hand/wrist
  // appearance (skin tone, bracelet, sleeve cuff) must match it on EVERY frame for
  // consistency, while the hand POSE/grip still comes from Photo 1.
  const handRefDirective = hasHandRef
    ? `HAND LOCK (critical): A separate photo labeled "HAND REFERENCE" shows the correct hand, wrist, and arm. The hand/forearm in the output MUST match that HAND REFERENCE EXACTLY — same skin tone, same smoothness, the SAME wrist jewelry as the reference (if the reference wrist is BARE, keep it bare — do NOT invent or add any bracelet, bangle, cuff, watch, or ring), and the SAME arm covering as the reference: if the reference arm is BARE (tank top / sleeveless), keep it bare and do NOT add any sleeve or cuff; only show a sleeve if the reference actually has one. The arm must look like the reference's gender — if it is a woman's smooth, hairless arm, then REMOVE all arm hair, coarse hair, knuckle hair, stubble, and masculine features from the original Photo 1 arm. Keep the hand POSE, grip, finger positions, and arm angle from Photo 1, but the hand and arm appearance come ENTIRELY from the HAND REFERENCE. Never output a bare/different hand, the original person's hairy or male-looking arm, or an invented sleeve.\n\n`
    : '';

  // Product replacement directive — only when a product reference (Photo 3) is provided
  const productReplaceDirective = hasProduct
    ? `PRODUCT REPLACE (critical): Photo 3 is the PRODUCT reference. The object held in the hand in Photo 1 must be COMPLETELY replaced with the product from Photo 3. Keep the same hand, grip, finger positions, scale, and arm pose from Photo 1 — but the held product's shape, color, packaging, label, and text must match Photo 3 exactly. Do NOT keep, blend, or retain the original product that was in Photo 1.\n\n`
    : '';

  // Generate-mode product directive — the generated avatar holds this exact product
  const productGenDirective = hasProductGen
    ? `EXACT PRODUCT (critical): The final reference image labeled "PRODUCT" shows the exact product for this scene. Whenever the avatar holds, shows, or displays a product in this image, it MUST be that exact product — match its shape, color, packaging, label, and text precisely. Do NOT invent, substitute, or restyle a different product. If the scene's action does not involve holding a product, do not add one.\n\n`
    : '';

  const systemInstruction = hasFrame
    ? `You are a professional photo compositor. You receive Photo 1 (a base scene/frame) and Photo 2 (an appearance reference for ONE person)${hasProduct ? ' and Photo 3 (a product reference)' : ''}.

Your task depends on what Photo 1 actually contains:
- If Photo 1 contains a visible person (face and/or body): replace ONLY that person's identity with Photo 2's appearance, and integrate them so they look genuinely photographed in the scene — match the lighting, color, grain, shadows, perspective and depth of field; do not let them look pasted or cut-out.
- If Photo 1 shows only a hand/arm holding a product (no face or body): keep it as just that hand/arm, matching only the skin tone and clothing to Photo 2. Do NOT add a face, head, hair, or any person — including in the background.

Hard rules for BOTH cases: never add a second person or any human figure that was not already in Photo 1; preserve Photo 1's background, framing, and lighting.${hasProduct ? ' Replace the product held in the hand with the exact product from Photo 3 (same hand, grip, and scale).' : ''} Always remove any burned-in text, captions, or subtitles.`
    : `You are a professional photo editor and image generator. Follow the user's instruction exactly using the provided reference photo(s).${hasProductGen ? ' One reference photo is labeled "PRODUCT" — when the scene shows the avatar holding or displaying a product, it must be that exact product (same shape, color, packaging, label, and text). Do not invent a different product.' : ''}`;

  const userPrompt = hasFrame
    ? `${faceReplaceDirective}${handRefDirective}${productReplaceDirective}${lockBlock}${instruction}`
    : `${productGenDirective}${instruction || ('Portrait of ' + (avatarDesc || 'the person shown.'))}`;

  // Merge the NB JSON's negative_prompt (sent as negativePrompt) with our hardcoded avoids
  const negLine = `\n\nAVOID: ${negativePrompt ? negativePrompt + ', ' : ''}preserving any face, skin tone, hair, or hand appearance from Photo 1 — those must be completely replaced with Photo 2. Avoid composite seam, edge halo, floating limbs, face placed inside any held object or prop. Avoid adding a second person, a duplicate of the subject, or any extra human figure standing or seated in the background that was not already in Photo 1. Avoid male/masculine arm hair, hairy forearms, knuckle hair, or a man's hand/arm when the avatar is a woman; avoid keeping the original person's shirt or clothing on the avatar. Remove any burned-in text, captions, or subtitles from the output.${faceOutOfFrame ? ' This frame is a hand/arm shot with NO person — avoid adding any face, head, hair, full body, or background person; avoid zooming out, re-framing, or changing the crop. Show only the same hand/arm holding the product.' : ''}`;
  // Push for a crisp, photorealistic result ONLY in Max Quality mode. This "shot on a real
  // camera / not AI" push is exactly what trips Veo's real-person safety filter on face
  // shots, so for the default (non-pro) path we leave it off — that's the state that
  // reliably passes Veo for talking-head frames.
  const qualityLine = wantPro
    ? '\n\nQUALITY: ultra-sharp focus and fine natural detail; realistic skin with visible pores, texture, and subtle imperfections (never plastic, waxy, airbrushed, or over-smoothed); crisp, legible product label text; true-to-life color and lighting; shot on a professional camera, high resolution. Avoid blur, softness, low detail, banding, or an obviously AI-generated look.'
    : '';
  const fullPrompt = userPrompt + negLine + qualityLine;

  const parts = [];
  if (hasFrame) {
    parts.push({ text: 'Photo 1 — BASE SCENE / FRAME (match its background, framing, lighting, and any hand/arm/prop shown). Look at this photo to decide: does it contain a person, or only a hand/arm?:' });
    parts.push({ inlineData: { mimeType: frameImg.mime, data: frameImg.b64 } });
  }
  parts.push({ text: 'Photo 2 — APPEARANCE REFERENCE for the person (use it to set the identity/face/skin/hair IF a person is visible in Photo 1, or ONLY the skin/hand tone if Photo 1 shows only a hand/arm). Do NOT add this person as an extra or background figure:' });
  parts.push({ inlineData: { mimeType: avatarImg.mime, data: avatarImg.b64 } });
  if (hasProductSwap) {
    parts.push({ text: 'Photo 3 — REPLACEMENT PRODUCT (the object held in the hand in the output must be this exact product — match its shape, color, packaging, label, and text):' });
    parts.push({ inlineData: { mimeType: productImg.mime, data: productImg.b64 } });
  } else if (hasProductGen) {
    parts.push({ text: 'PRODUCT — the exact product for this scene (if the avatar holds or displays a product, it must be this one — match its shape, color, packaging, label, and text):' });
    parts.push({ inlineData: { mimeType: productImg.mime, data: productImg.b64 } });
  }
  if (hasHandRef) {
    parts.push({ text: 'HAND REFERENCE — the correct hand, wrist, and arm for this person (match the output to this exactly: skin tone, the SAME wrist jewelry shown here — and a BARE wrist with no bracelet/watch/ring if this reference shows none, never invent one — and the SAME arm covering — bare arm if this reference is bare/sleeveless, sleeve only if it has one). Keep the hand POSE/grip from Photo 1, but the hand and arm appearance come from here:' });
    parts.push({ inlineData: { mimeType: handRefImg.mime, data: handRefImg.b64 } });
  }
  parts.push({ text: fullPrompt });

  const requestObj = {
    systemInstruction: { parts: [{ text: systemInstruction }] },
    contents: [{ role: 'user', parts }],
    generationConfig: {
      responseModalities: ['IMAGE', 'TEXT'],
      temperature: 0.1,
    },
  };

  const mode = hasFrame ? (poseAnalysis ? 'appearance-transfer+analysis' : 'appearance-transfer') : 'generate-only';
  console.log(`generate-nb-composite: user=${user.id}, mode=${mode}, wantPro=${wantPro}, promptLen=${fullPrompt.length}`);

  let result;
  try {
    result = await callImageModel(requestObj, apiKey, wantPro, vtxToken);
  } catch(e) {
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Could not reach image model: ' + e.message }) };
  }

  console.log('generate-nb-composite: image model status:', result.status, '| usedPro:', result.usedPro);

  if (result.status === 429) {
    return { statusCode: 429, headers: CORS, body: JSON.stringify({ error: 'Gemini API rate limit. Please wait and retry.' }) };
  }
  if (!result.data) {
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'No response from Gemini API. Status: ' + result.status }) };
  }
  if (result.status !== 200 || result.data.error) {
    const errMsg = result.data?.error?.message || `Gemini API error (HTTP ${result.status})`;
    console.error('generate-nb-composite: error:', errMsg);
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: errMsg }) };
  }

  const candidates = result.data.candidates || [];
  for (const candidate of candidates) {
    const responseParts = candidate?.content?.parts || [];
    for (const part of responseParts) {
      if (part.inlineData?.data) {
        const mime = part.inlineData.mimeType || 'image/png';
        const _cost = result.usedPro ? CREDIT_COST_PRO : CREDIT_COST;
        console.log('generate-nb-composite: image generated, mime:', mime, '| usedPro:', result.usedPro, '| cost:', _cost);
        await _chargeCompose(_cost);
        return {
          statusCode: 200,
          headers: { ...CORS, 'Content-Type': 'application/json' },
          body: JSON.stringify({ imageB64: part.inlineData.data, mime, creditsDeducted: _cost, quality: result.usedPro ? 'pro' : 'flash' }),
        };
      }
    }
  }

  console.error('generate-nb-composite: no image in response:', JSON.stringify(result.data).slice(0, 500));
  return {
    statusCode: 502,
    headers: CORS,
    body: JSON.stringify({ error: 'Model returned no image. Check Gemini API logs.' }),
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
