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
  "visible_person": "which parts of the person are actually in frame — choose the closest single phrase: 'hands only', 'arms only', 'arms and torso, no face', 'face and upper body', or 'full body'",
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
    productB64     = null,
    productMime    = 'image/jpeg',
    creative       = false,
  } = body;

  let avatarImg = null, frameImg = null, productImg = null;
  if (Array.isArray(body.images) && body.images.length > 0) {
    const imgs = body.images.filter(img => img && img.b64);
    if (imgs[0]) avatarImg  = imgs[0];
    if (imgs[1]) frameImg   = imgs[1];
    if (imgs[2]) productImg = imgs[2];
  } else if (avatarB64) {
    avatarImg = { b64: avatarB64, mime: avatarMime };
    if (frameB64)   frameImg   = { b64: frameB64, mime: frameMime };
    if (productB64) productImg = { b64: productB64, mime: productMime };
  }

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

  const lockBlock = (hasFrame && poseAnalysis) ? buildLockBlock(poseAnalysis, hasProduct) : '';

  // What's actually visible in the source frame — drives how much of the person to replace.
  // Default to face-visible (full replace) when analysis is missing, to preserve old behavior.
  const _vp = ((poseAnalysis && poseAnalysis.visible_person) || '').toLowerCase();
  const faceOutOfFrame = hasFrame && /hands?\s*only|arms?\s*only|no\s*face|without.*face|faceless|below\s*(the\s*)?(neck|chin|shoulders)|hands?\s*(and|&)\s*arms?\s*only/.test(_vp);
  const faceVisible = hasFrame && !faceOutOfFrame;

  // Person replacement directive — adapts to the source frame's crop.
  const faceReplaceDirective = !hasFrame
    ? ''
    : faceVisible
      ? `FACE REPLACE (critical): Completely remove the Photo 1 person's face, skin tone, hair, and hands. Replace them entirely with the Photo 2 avatar's exact face, skin tone, hair, and hands. The person in the final image must look like Photo 2, not Photo 1. Do NOT blend, partially preserve, or retain any facial features, skin color, or hand appearance from Photo 1.\n\n`
      : `BODY-PART MATCH (critical): In Photo 1 the person's face and head are OUT OF FRAME — only their ${_vp || 'hands/arms'} are visible. KEEP THE EXACT SAME CROP AND FRAMING. Do NOT add, reveal, zoom out to, or invent a face, head, or hair. Replace ONLY the visible skin, hands, arms, and clothing so they match the Photo 2 avatar's skin tone, hands, and outfit. The output must show the SAME body parts as Photo 1 and nothing more — no face appears anywhere in the image.\n\n`;

  // Product replacement directive — only when a product reference (Photo 3) is provided
  const productReplaceDirective = hasProduct
    ? `PRODUCT REPLACE (critical): Photo 3 is the PRODUCT reference. The object held in the hand in Photo 1 must be COMPLETELY replaced with the product from Photo 3. Keep the same hand, grip, finger positions, scale, and arm pose from Photo 1 — but the held product's shape, color, packaging, label, and text must match Photo 3 exactly. Do NOT keep, blend, or retain the original product that was in Photo 1.\n\n`
    : '';

  // Generate-mode product directive — the generated avatar holds this exact product
  const productGenDirective = hasProductGen
    ? `EXACT PRODUCT (critical): The final reference image labeled "PRODUCT" shows the exact product for this scene. Whenever the avatar holds, shows, or displays a product in this image, it MUST be that exact product — match its shape, color, packaging, label, and text precisely. Do NOT invent, substitute, or restyle a different product. If the scene's action does not involve holding a product, do not add one.\n\n`
    : '';

  const systemInstruction = hasFrame
    ? `You are a professional photo editor performing a ${faceVisible ? 'FULL PERSON REPLACEMENT' : 'PARTIAL (BODY-PART) REPLACEMENT'}${hasProduct ? ' and a PRODUCT REPLACEMENT' : ''}.

Photo 1 — the base scene: background, setting, lighting, arm positions${faceVisible ? '' : ', and the exact crop/framing'} are preserved from this photo.${hasProduct ? ' The held object is NOT preserved — it will be replaced.' : ' Props and held objects are also preserved from this photo.'}
Photo 2 — the appearance source: ${faceVisible
      ? 'this person\'s face, skin tone, hair, head, hands, clothing, and accessories must appear in the final image. The person in the output MUST look like the person in Photo 2 — not the person in Photo 1.'
      : 'use this person\'s skin tone, hands, arms, and clothing. IMPORTANT: the person\'s face and head are OUT OF FRAME in Photo 1 — do NOT add, reveal, or invent a face, head, or hair. Only the body parts already visible in Photo 1 are replaced.'}${hasProduct ? '\nPhoto 3 — the replacement product: the object held in the hand must be replaced with this exact product (match its shape, color, packaging, label, and text). Keep the same hand and grip from Photo 1.' : ''}

CRITICAL: ${faceVisible
      ? 'The person in Photo 1 is being REPLACED. Their face, skin tone, hair, and hands must NOT appear in the output. Replace them completely with the face, skin tone, hair, and hands of the Photo 2 person.'
      : 'Keep the EXACT same crop as Photo 1 — show only the same body parts (no face/head if none is shown). Replace only the visible skin, hands, arms, and clothing to match Photo 2.'} Preserve the background, arm positions, and lighting from Photo 1${hasProduct ? ', but replace the held product with the Photo 3 product.' : ', and keep the held prop as in Photo 1.'}

Always remove any burned-in text, captions, or subtitles from the output image.`
    : `You are a professional photo editor and image generator. Follow the user's instruction exactly using the provided reference photo(s).${hasProductGen ? ' One reference photo is labeled "PRODUCT" — when the scene shows the avatar holding or displaying a product, it must be that exact product (same shape, color, packaging, label, and text). Do not invent a different product.' : ''}`;

  const userPrompt = hasFrame
    ? `${faceReplaceDirective}${productReplaceDirective}${lockBlock}${instruction}`
    : `${productGenDirective}${instruction || ('Portrait of ' + (avatarDesc || 'the person shown.'))}`;

  // Merge the NB JSON's negative_prompt (sent as negativePrompt) with our hardcoded avoids
  const negLine = `\n\nAVOID: ${negativePrompt ? negativePrompt + ', ' : ''}preserving any face, skin tone, hair, or hand appearance from Photo 1 — those must be completely replaced with Photo 2. Avoid composite seam, edge halo, floating limbs, face placed inside any held object or prop. Remove any burned-in text, captions, or subtitles from the output.${faceOutOfFrame ? ' Avoid adding any face, head, hair, or body parts that are not already visible in Photo 1; avoid zooming out, re-framing, or changing the crop.' : ''}`;
  const fullPrompt = userPrompt + negLine;

  const parts = [];
  if (hasFrame) {
    parts.push({ text: 'Photo 1 — BASE SCENE (keep only: background, arms, prop, lighting — the PERSON in this photo is being fully replaced):' });
    parts.push({ inlineData: { mimeType: frameImg.mime, data: frameImg.b64 } });
  }
  parts.push({ text: 'Photo 2 — REPLACEMENT PERSON (use this person\'s face, skin tone, hair, hands, clothing, and accessories in the output — this is who must appear in the final image):' });
  parts.push({ inlineData: { mimeType: avatarImg.mime, data: avatarImg.b64 } });
  if (hasProductSwap) {
    parts.push({ text: 'Photo 3 — REPLACEMENT PRODUCT (the object held in the hand in the output must be this exact product — match its shape, color, packaging, label, and text):' });
    parts.push({ inlineData: { mimeType: productImg.mime, data: productImg.b64 } });
  } else if (hasProductGen) {
    parts.push({ text: 'PRODUCT — the exact product for this scene (if the avatar holds or displays a product, it must be this one — match its shape, color, packaging, label, and text):' });
    parts.push({ inlineData: { mimeType: productImg.mime, data: productImg.b64 } });
  }
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
