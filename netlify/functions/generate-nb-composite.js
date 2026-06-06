/**
 * Netlify Function: generate-nb-composite
 * Generates a Nano Banana composite image using Gemini 2.0 Flash image generation.
 *
 * Takes:
 *   - avatarB64      — base64 avatar photo (Photo 1)
 *   - avatarMime     — MIME type of avatar (default: image/jpeg)
 *   - frameB64       — base64 reference frame (Photo 2, optional)
 *   - frameMime      — MIME type of frame (default: image/jpeg)
 *   - instruction    — NB Pro instruction text from the segment's nbPrompt
 *
 * Returns: { imageB64, mime }
 *
 * Required env vars:
 *   GEMINI_API_KEY   — Google Gemini API key
 *   SUPABASE_URL     — for auth
 *   SUPABASE_ANON    — for auth
 */

const https = require('https');

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
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'GEMINI_API_KEY not configured.' }) };
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

  const { instruction, avatarB64, avatarMime = 'image/jpeg', frameB64 = null, frameMime = 'image/jpeg' } = body;

  // ── Build images array — accept new {images:[{b64,mime}]} OR old avatarB64/frameB64 format ──
  let images = [];
  if (Array.isArray(body.images) && body.images.length > 0) {
    // New format: up to 5 images from Studio tab
    images = body.images.filter(img => img && img.b64).slice(0, 5);
  } else if (avatarB64) {
    // Legacy format: NB composite / replicator calls
    images = [{ b64: avatarB64, mime: avatarMime }];
    if (frameB64) images.push({ b64: frameB64, mime: frameMime });
  }

  if (!instruction || images.length === 0) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'instruction and at least one image are required.' }) };
  }

  // ── Build Gemini request ───────────────────────────────────────────────────
  const photoLabels = images.map((_, i) => `Photo ${i + 1}`).join(', ');
  const photoGuide = images.length === 1
    ? 'Use Photo 1 as the style reference for the person\'s appearance, clothing, and accessories.'
    : `Reference photos provided: ${photoLabels}. Use Photo 1 as the primary person/character reference. Additional photos are scene, product, or style references — incorporate them as instructed.`;

  const userText = `Generate an image of: ${instruction}

${photoGuide}
Output a single vertical 9:16 lifestyle photograph. No text overlays.`.trim();

  const userParts = [{ text: userText }];
  images.forEach(img => {
    userParts.push({ inline_data: { mime_type: img.mime || 'image/jpeg', data: img.b64 } });
  });

  const requestBody = JSON.stringify({
    contents: [{ role: 'user', parts: userParts }],
  });

  // gemini-3.1-flash-image (Nano Banana 2) — stable image-in/image-out model, uses v1
  const apiPath = `/v1/models/gemini-3.1-flash-image:generateContent?key=${geminiKey}`;

  console.log(`generate-nb-composite: user=${user.id}, images=${images.length}, instrLen=${instruction.length}`);

  let result;
  try {
    result = await httpsRequest({
      hostname: 'generativelanguage.googleapis.com',
      path:     apiPath,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(requestBody),
      },
    }, requestBody);
  } catch(e) {
    console.error('generate-nb-composite: fetch error:', e.message);
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Could not reach Gemini API: ' + e.message }) };
  }

  console.log('generate-nb-composite: Gemini status:', result.status);

  if (!result.data) {
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'No response from Gemini API. Status: ' + result.status }) };
  }

  if (result.status !== 200 || result.data.error) {
    const errMsg = result.data?.error?.message || `Gemini API error (HTTP ${result.status})`;
    console.error('generate-nb-composite: Gemini error:', errMsg);
    // FIX: Normalize upstream error codes to 502 — avoids leaking Gemini's 401/403 to the
    // frontend where they would be misinterpreted as the user's session being expired.
    const clientStatus = (result.status === 429) ? 429 : 502;
    return { statusCode: clientStatus, headers: CORS, body: JSON.stringify({ error: errMsg }) };
  }

  // ── Extract image from response ────────────────────────────────────────────
  // Gemini REST API returns camelCase keys (inlineData, mimeType) in responses,
  // but proto3 JSON also accepts snake_case — handle both to be safe.
  const candidates = result.data.candidates || [];
  for (const candidate of candidates) {
    for (const part of (candidate.content?.parts || [])) {
      const blob = part.inlineData || part.inline_data;
      if (blob?.data) {
        const mime = blob.mimeType || blob.mime_type || 'image/png';
        console.log('generate-nb-composite: image generated, mime:', mime);
        return {
          statusCode: 200,
          headers: { ...CORS, 'Content-Type': 'application/json' },
          body: JSON.stringify({ imageB64: blob.data, mime }),
        };
      }
    }
  }

  // No image in response — log full details for debugging
  const finishReasons = candidates.map(c => c.finishReason || 'unknown').join(', ');
  const textParts = candidates.flatMap(c => (c.content?.parts || []).filter(p => p.text).map(p => p.text)).join(' ');
  console.error('generate-nb-composite: no image. finishReasons:', finishReasons, '| parts:', JSON.stringify(candidates.flatMap(c => (c.content?.parts || []).map(p => Object.keys(p))).slice(0,5)), '| text:', textParts.slice(0, 300));
  const errDetail = finishReasons ? `(finishReason: ${finishReasons})` : '';
  return {
    statusCode: 502,
    headers: CORS,
    body: JSON.stringify({ error: `Gemini returned no image ${errDetail}. ${textParts.slice(0, 150)}`.trim() }),
  };
};
