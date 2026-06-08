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

  // ── Stage 2: Composite generation (single-stage, original frame as reference) ─
  // Photo 2 is always the original scene frame — never inpainted. The pose analysis
  // block (LOCK / ARM / PROP STATE format) gives the model explicit text instructions
  // so it knows exactly what to preserve vs. replace without needing a clean background.
  const photo_guide = hasFrame
    ? 'Photo 1 = Scene reference frame (the base image — background and composition to preserve). Photo 2 = Avatar (the replacement person — face, body, clothing, accessories to use).'
    : `Generate a photorealistic portrait of ${avatarDesc || 'the person shown in Photo 2'}.`;

  const coreNegatives = 'ghosting, double exposure, semi-transparent person, two people, floating hands, disembodied arms, extra hands, ghost limbs, arms at sides when they should be raised, arms hanging down, text overlay, text from reference frame, labels from reference, numbers on body, captions, composite seam, edge halo, color fringing, wrong background, avatar background';
  const allNegatives = [coreNegatives, negativePrompt].filter(Boolean).join(', ');
  const negLine = `\n\nAVOID IN OUTPUT: ${allNegatives}`;
  const fullPrompt = `${photo_guide}\n\n${enrichedInstruction}${negLine}`;

  const parts = [];
  if (hasFrame) {
    // Scene frame is Photo 1 — model treats the first image as the base to modify
    parts.push({ text: 'Photo 1 (scene reference frame — base image, background and composition to preserve):' });
    parts.push({ inlineData: { mimeType: frameImg.mime, data: frameImg.b64 } });
  }
  // Avatar is Photo 2 — replacement person reference
  parts.push({ text: 'Photo 2 (avatar — the replacement person):' });
  parts.push({ inlineData: { mimeType: avatarImg.mime, data: avatarImg.b64 } });
  parts.push({ text: fullPrompt });

  const systemRules = hasFrame
    ? `You are a professional photo compositor. Your task is PERSON REPLACEMENT.

Photo 1 = the scene reference frame. This is the BASE IMAGE. Start from Photo 1 and modify it.
Photo 2 = the avatar (replacement person — face, body, clothing, accessories).

MANDATORY RULES:
1. BASE IMAGE: Photo 1 is the starting point. Its background — walls, shelves, furniture, objects, colors, flags, windows, lighting — must be preserved exactly in the output. Do NOT use Photo 2's background.
2. REPLACE PERSON: Remove the person in Photo 1 completely. Replace them with the Photo 2 avatar at the same position, scale, and pose. No ghosting, no blending, no transparency of the original person.
3. FOLLOW LOCK INSTRUCTIONS: The instruction contains explicit LOCK, ARM, PROP STATE, and LIGHT directives. Follow each one exactly.
4. PROP: If PROP or PROP STATE describes an object being held, the avatar MUST hold that same object in the same hand at the same position and orientation as the original person in Photo 1.
5. ONE PERSON ONLY: Only the Photo 2 avatar in the output. No other people, no floating hands, no ghost limbs.
6. LIGHTING: Light the avatar to match Photo 1's scene lighting exactly.`
    : `Generate a photorealistic portrait of the person in Photo 2 as described in the instruction.`;

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
  const mode = hasFrame ? (poseAnalysis ? 'composite+analysis' : 'composite') : 'generate-only';

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
