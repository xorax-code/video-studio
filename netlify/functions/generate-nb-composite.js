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
  const prompt = `You are analyzing a video frame for professional photo compositing. A person is visible.
Extract precise details in the exact format used by compositing software.

Return ONLY a valid JSON object with these exact fields (no markdown, no explanation, raw JSON only):
{
  "person_position": "where the person stands in frame and how much they fill it — e.g. 'center, ~80% frame height' or 'center-left, waist-up'",
  "camera_angle": "shot description — e.g. 'straight-on chest height' or 'slightly below eye level, medium shot'",
  "background": "precise description of everything visible behind the person — room type, wall color/material, shelves, objects on shelves, furniture, window position, any flags, signs, or decor",
  "arm_instruction": "single sentence describing both arms and hands for compositing — e.g. 'right hand holds large open mouth model extended toward camera, left hand supports it from below' or 'both arms at sides, hands relaxed'",
  "prop": "if a prop/object is held: exact name, shape, size, color, which hand, how gripped, orientation toward camera. If none: 'none'",
  "prop_state": "visible state of the prop — e.g. 'mouth model open, facing camera, showing teeth and tongue' or 'dark glass bottle with label facing camera'. If no prop: 'none'",
  "lighting": "lighting description — e.g. 'warm ambient, soft shadows from above' or 'bright natural light from right window, cool tone'",
  "body_in_frame": "simple tag for close-up detection only — e.g. 'torso up' or 'full body' or 'face only'"
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
      maxOutputTokens: 800,
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
    console.log('analyzeFramePose: OK — prop:', parsed.prop, '| arm:', parsed.arm_instruction);
    return parsed;
  } catch (e) {
    console.warn('analyzeFramePose: JSON parse failed. Raw:', raw.slice(0, 300));
    return null;
  }
}

// ── Build scene-grounded instruction prefix from analysis result ──────────────
// Produces LOCK / ARM / PROP STATE lines in the same format the Veo agent uses.
// Prepended to the incoming instruction so compositing keywords appear first.
function buildPoseBlock(pa) {
  const lines = [];
  if (pa.person_position) lines.push(`[FULL PERSON] REPLACE: target person — ${pa.person_position}. Camera angle: ${pa.camera_angle || 'straight-on'}.`);
  if (pa.background)      lines.push(`LOCK: background — ${pa.background}.`);
  if (pa.arm_instruction) lines.push(`ARM: ${pa.arm_instruction}.`);
  if (pa.prop && pa.prop !== 'none') lines.push(`PROP: ${pa.prop}.`);
  if (pa.prop_state && pa.prop_state !== 'none') lines.push(`PROP STATE: ${pa.prop_state}.`);
  if (pa.lighting)        lines.push(`LIGHT: ${pa.lighting}.`);
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

  // ── Stage 1: Pose analysis ────────────────────────────────────────────────────
  // Uses gemini-2.0-flash-001 to extract a text map of the scene pose.
  // Fails silently: if null, Stage 3 proceeds with the original instruction.
  let enrichedInstruction = instruction;
  let poseAnalysis = null;
  if (hasFrame) {
    poseAnalysis = await analyzeFramePose(frameImg, accessToken, projectId);
    if (poseAnalysis) {
      enrichedInstruction = buildPoseBlock(poseAnalysis) + instruction;
      console.log('generate-nb-composite: Stage 1 pose analysis injected — instruction now', enrichedInstruction.length, 'chars');
    } else {
      console.log('generate-nb-composite: Stage 1 pose analysis unavailable — proceeding without it');
    }
  }

  // ── Stage 2: Inpainting pass ─────────────────────────────────────────────────
  // Remove the person from the scene frame to get a clean background.
  // Stage 3 then places the avatar into this clean scene — no ghosting possible.
  let cleanBgImg = frameImg; // fallback: original frame
  let inpaintSucceeded = false;

  if (hasFrame) {
    const inpaintBody = JSON.stringify({
      systemInstruction: { parts: [{ text: `You are a photo inpainting expert. Remove the person from this photo but KEEP any object they are holding.

RULES:
1. Remove the person's body — face, head, hair, neck, torso, arms, wrists, hands, fingers, legs, feet, clothing. This includes fingertips and any partial limbs at the edges.
2. KEEP any product or object the person was holding (bottle, model, device, etc.). Let it float in mid-air at the same position — that is intentional.
3. Fill the erased person area with a seamless continuation of the surrounding background — walls, shelves, floor, furniture.
4. Do NOT remove, alter, or move the held prop/product. Its position, orientation, and appearance must be exactly preserved.
5. Preserve all other background elements exactly as-is — shelves, wall colors, flags, windows, decor.
6. Output: same room, no person, prop floating in place at the exact same position and orientation.` }] },
      contents: [{ role: 'user', parts: [
        { text: 'Remove the person from this photo but keep any object they were holding floating in place:' },
        { inlineData: { mimeType: frameImg.mime, data: frameImg.b64 } },
        { text: 'Output: same room, person removed and filled with background, held object preserved floating at exact same position.' },
      ]}],
      generationConfig: { responseModalities: ['IMAGE', 'TEXT'], temperature: 0.1 },
    });

    const inpaintPath = `/v1/projects/${projectId}/locations/${LOCATION}/publishers/google/models/${MODEL}:generateContent`;
    try {
      const inpaintResult = await httpsRequest({
        hostname: `${LOCATION}-aiplatform.googleapis.com`,
        path: inpaintPath, method: 'POST',
        headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(inpaintBody) },
      }, inpaintBody);

      if (inpaintResult?.status === 429) {
        return { statusCode: 429, headers: CORS, body: JSON.stringify({ error: 'Vertex AI rate limit (inpaint stage). Please wait and retry.' }) };
      }
      for (const c of (inpaintResult?.data?.candidates || [])) {
        for (const p of (c?.content?.parts || [])) {
          if (p.inlineData?.data) {
            cleanBgImg = { b64: p.inlineData.data, mime: p.inlineData.mimeType || 'image/png' };
            inpaintSucceeded = true;
            console.log('generate-nb-composite: inpaint success — clean background ready');
            break;
          }
        }
        if (inpaintSucceeded) break;
      }
      if (!inpaintSucceeded) console.warn('generate-nb-composite: inpaint returned no image — using original frame');
    } catch(e) {
      console.warn('generate-nb-composite: inpaint error:', e.message, '— using original frame');
    }
  }

  // ── Composite pass ────────────────────────────────────────────────────────
  // Photo 1 = avatar (always).
  // Photo 2 = clean background from inpaint (if succeeded) OR omitted (if failed).
  // Photo 3 = original frame — prop/position/scale reference (always, if hasFrame).
  //
  // IMPORTANT: when inpaint failed, Photo 2 is omitted entirely.
  // We never label the original frame (with person still in it) as "clean background" —
  // that would be a lie to the model and produce bad results.
  let photo_guide, systemRules;
  if (!hasFrame) {
    photo_guide  = `Generate a photorealistic portrait of ${avatarDesc || 'the person shown in Photo 1'}.`;
    systemRules  = `Generate a photorealistic portrait of the person in Photo 1 as described in the instruction.`;
  } else if (inpaintSucceeded) {
    // 3-photo mode: avatar | background-with-floating-prop | original frame (scale reference)
    photo_guide  = 'Photo 1 = avatar (the person to place). Photo 2 = scene with person removed — the real prop/product is already floating in it at its correct position. Photo 3 = original scene — reference ONLY for subject scale and camera distance.';
    systemRules  = `You are a professional photo compositor placing an avatar into a scene.

Photo 1 = AVATAR — the person to insert (face, body, clothing, accessories).
Photo 2 = SCENE WITH FLOATING PROP — the background with the person removed. The real product/prop is already visible floating in mid-air at exactly the right position. Use this as the background.
Photo 3 = ORIGINAL SCENE — reference only for how large/close the subject was to the camera.

MANDATORY RULES:
1. BACKGROUND: Use Photo 2 as the entire background. Preserve every wall, shelf, flag, window, and the floating prop exactly as-is. Never use Photo 1's background.
2. SCALE: Match the subject's scale and camera distance from Photo 3. If Photo 3 shows a medium-close shot where the person fills most of the frame height, the avatar must appear at the same scale and distance — not smaller.
3. PLACE AVATAR: Insert the Photo 1 avatar at the same position as the person in Photo 3, so that her hand(s) naturally reach the floating prop in Photo 2.
4. GRIP THE PROP: The prop/product already floating in Photo 2 is the real object — do NOT redraw or replace it. Render the avatar's hand(s) gripping it naturally. The prop stays exactly where it is; only the hand wraps around it.
5. ONE PERSON: Only the Photo 1 avatar in the output. No ghost limbs, no floating hands disconnected from her body.
6. LIGHTING: Match Photo 2's scene lighting exactly.`;
  } else {
    // 2-photo fallback mode (inpaint failed): avatar | original frame
    // Can't pretend Photo 2 is clean — it's not. Use it as scene reference only.
    photo_guide  = 'Photo 1 = avatar (the replacement person — use their face, body, clothing, accessories). Photo 2 = original scene — use its background exactly but replace the person with the Photo 1 avatar at the same scale and position.';
    systemRules  = `You are a professional photo compositor replacing a person in a scene.

Photo 1 = AVATAR — the replacement person (face, body, clothing, accessories to use).
Photo 2 = ORIGINAL SCENE — the background and composition to preserve. Replace the person in Photo 2 with the Photo 1 avatar.

MANDATORY RULES:
1. BACKGROUND: Preserve Photo 2's background exactly — walls, shelves, objects, colors, flags, windows. Never use Photo 1's background.
2. SCALE: The avatar must appear at the same size and camera distance as the person in Photo 2. Match their scale exactly — not smaller, not farther away.
3. REPLACE PERSON: Remove the person in Photo 2 completely. Place the Photo 1 avatar at the same position and scale.
4. PROP: If PROP / PROP STATE lines describe a held object, the avatar MUST hold that same object at the same position. Her hands must be physically connected to her body gripping the prop — no floating hands.
5. ONE PERSON: Only the Photo 1 avatar in the output. No ghosting of the original person, no floating limbs.
6. LIGHTING: Match Photo 2's scene lighting.`;
  }

  const coreNegatives = 'ghosting, double exposure, semi-transparent person, two people, floating hands, severed hands, hands not connected to body, disembodied arms, extra hands, ghost limbs, hands copied from reference photo, arms at sides when they should be raised, arms hanging down, subject too small, subject far away, wide shot when original was medium-close, text overlay, text from reference frame, labels from reference, numbers on body, captions, composite seam, edge halo, color fringing, wrong background, avatar background';
  const allNegatives = [coreNegatives, negativePrompt].filter(Boolean).join(', ');
  const negLine = `\n\nAVOID IN OUTPUT: ${allNegatives}`;
  const fullPrompt = `${photo_guide}\n\n${enrichedInstruction}${negLine}`;

  const parts = [];
  parts.push({ text: 'Photo 1 — AVATAR (the person to place into the scene):' });
  parts.push({ inlineData: { mimeType: avatarImg.mime, data: avatarImg.b64 } });
  if (hasFrame && inpaintSucceeded) {
    parts.push({ text: 'Photo 2 — SCENE WITH FLOATING PROP (person removed, real product/prop preserved floating at correct position — use this as the scene, grip the floating prop):' });
    parts.push({ inlineData: { mimeType: cleanBgImg.mime, data: cleanBgImg.b64 } });
    parts.push({ text: 'Photo 3 — ORIGINAL SCENE (reference ONLY for subject scale and camera distance — do NOT copy the person from this photo):' });
    parts.push({ inlineData: { mimeType: frameImg.mime, data: frameImg.b64 } });
  } else if (hasFrame) {
    // inpaint failed — Photo 2 only (original frame), used as scene reference
    parts.push({ text: 'Photo 2 — ORIGINAL SCENE (background and composition reference — replace the person with the Photo 1 avatar):' });
    parts.push({ inlineData: { mimeType: frameImg.mime, data: frameImg.b64 } });
  }
  parts.push({ text: fullPrompt });

  const requestBody = JSON.stringify({
    systemInstruction: { parts: [{ text: systemRules }] },
    contents: [{ role: 'user', parts }],
    generationConfig: {
      responseModalities: ['IMAGE', 'TEXT'],
      temperature: 0.1,
    },
  });

  const apiPath  = `/v1/projects/${projectId}/locations/${LOCATION}/publishers/google/models/${MODEL}:generateContent`;
  const hostname = `${LOCATION}-aiplatform.googleapis.com`;
  const mode = !hasFrame ? 'generate-only' : (inpaintSucceeded ? (poseAnalysis ? '3photo+analysis' : '3photo') : (poseAnalysis ? '2photo-fallback+analysis' : '2photo-fallback'));

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
