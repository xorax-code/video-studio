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

const MODEL          = 'gemini-3.1-flash-image';
const ANALYSIS_MODEL = 'gemini-2.0-flash';
const GEMINI_HOST    = 'generativelanguage.googleapis.com';

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
async function analyzeFramePose(frameImg, apiKey) {
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

  const path = `/v1beta/models/${ANALYSIS_MODEL}:generateContent?key=${apiKey}`;
  try {
    const res = await httpsRequest({
      hostname: GEMINI_HOST,
      path, method: 'POST',
      headers: {
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
  if (pa.background)                             lines.push(`LOCK BACKGROUND: ${pa.background}.`);
  if (pa.arm_instruction)                        lines.push(`LOCK ARMS: ${pa.arm_instruction} — do not move these arms.`);
  if (pa.prop && pa.prop !== 'none')             lines.push(`LOCK PROP: ${pa.prop} — keep exactly as held, same grip and orientation.`);
  if (pa.prop_state && pa.prop_state !== 'none') lines.push(`PROP STATE: ${pa.prop_state}.`);
  if (pa.lighting)                               lines.push(`LOCK LIGHT: ${pa.lighting}.`);
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

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'GEMINI_API_KEY not configured.' }) };
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
    creative       = false,
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

  const hasFrame = !!frameImg;

  // ── Creative mode (Studio tab) — skip pose analysis, use open system prompt ─
  if (creative) {
    const creativeParts = [];
    for (const img of [avatarImg, frameImg].filter(Boolean)) {
      creativeParts.push({ inlineData: { mimeType: img.mime, data: img.b64 } });
    }
    creativeParts.push({ text: instruction || 'Generate a high-quality image based on the reference photos.' });

    const creativeBody = JSON.stringify({
      systemInstruction: { parts: [{ text: 'You are a professional photo editor and image generator. Follow the user\'s instruction exactly and creatively. Use any provided reference photos as visual guides.' }] },
      contents: [{ role: 'user', parts: creativeParts }],
      generationConfig: { responseModalities: ['IMAGE', 'TEXT'], temperature: 0.7 },
    });

    let creativeResult;
    try {
      creativeResult = await httpsRequest({
        hostname: GEMINI_HOST,
        path: `/v1beta/models/${MODEL}:generateContent?key=${apiKey}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(creativeBody) },
      }, creativeBody);
    } catch(e) {
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Could not reach Gemini API: ' + e.message }) };
    }

    if (creativeResult.status === 429) return { statusCode: 429, headers: CORS, body: JSON.stringify({ error: 'Rate limit — please wait and retry.' }) };
    if (!creativeResult.data || creativeResult.status !== 200 || creativeResult.data.error) {
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: creativeResult.data?.error?.message || 'Gemini error ' + creativeResult.status }) };
    }
    for (const candidate of creativeResult.data.candidates || []) {
      for (const part of candidate?.content?.parts || []) {
        if (part.inlineData?.data) {
          return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ imageB64: part.inlineData.data, mime: part.inlineData.mimeType || 'image/png' }) };
        }
      }
    }
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Model returned no image.' }) };
  }

  // ── Stage 1: Pose analysis ────────────────────────────────────────────────
  let poseAnalysis = null;
  if (hasFrame) {
    poseAnalysis = await analyzeFramePose(frameImg, apiKey);
  }

  // ── Stage 2: Appearance transfer via Nano Banana 2 ───────────────────────
  // Photo 1 = scene frame (base — background, arms, prop locked)
  // Photo 2 = avatar      (appearance source: face, hair, clothing)

  const lockBlock = (hasFrame && poseAnalysis) ? buildLockBlock(poseAnalysis) : '';

  const systemInstruction = hasFrame
    ? `You are a professional photo editor. You have been given two photos:

Photo 1 — the base scene (background, setting, props, lighting).
Photo 2 — the appearance reference (person whose look, face, clothing, or style may be applied).

Follow the user's instruction exactly. The instruction tells you what to do — whether that is replacing the person, changing appearance, adding someone, adjusting a pose, or something else entirely. Do not assume any action that is not stated in the instruction.

Always remove any burned-in text, captions, or subtitles from the output image.`
    : `You are a professional photo editor. Follow the user's instruction exactly using the provided reference photo(s).`;

  const userPrompt = hasFrame
    ? `${lockBlock}${instruction}`
    : `${instruction || ('Portrait of ' + (avatarDesc || 'the person shown.'))}`;

  const negLine = `\n\nAVOID: composite seam, edge halo, floating limbs, face placed inside any held object or prop. Remove any burned-in text, captions, or subtitles from the output.`;
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

  const apiPath = `/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;
  const mode    = hasFrame ? (poseAnalysis ? 'appearance-transfer+analysis' : 'appearance-transfer') : 'generate-only';

  console.log(`generate-nb-composite: user=${user.id}, model=${MODEL}, mode=${mode}, promptLen=${fullPrompt.length}`);

  let result;
  try {
    result = await httpsRequest({
      hostname: GEMINI_HOST,
      path: apiPath, method: 'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(requestBody),
      },
    }, requestBody);
  } catch(e) {
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Could not reach Gemini API: ' + e.message }) };
  }

  console.log('generate-nb-composite: Gemini API status:', result.status);

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
