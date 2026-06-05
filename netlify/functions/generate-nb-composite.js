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

  const {
    instruction,
    avatarB64,
    avatarMime = 'image/jpeg',
    frameB64   = null,
    frameMime  = 'image/jpeg',
  } = body;

  if (!instruction || !avatarB64) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'instruction and avatarB64 are required.' }) };
  }

  // ── Build Gemini request ───────────────────────────────────────────────────
  // System instruction: keep character consistent, photorealistic 9:16
  const systemText = `You are a photorealistic image compositor. Generate a single vertical 9:16 image exactly as instructed.
The person in Photo 1 is the avatar — preserve their face, skin tone, hair, clothing, and accessories EXACTLY as shown.
Do not alter their appearance in any way.
If a reference frame (Photo 2) is provided, match its background, lighting, and scene composition.
Output a single photorealistic image. No text, no watermarks, no collages.`;

  const parts = [
    { text: systemText + '\n\n' + instruction },
    { inline_data: { mime_type: avatarMime, data: avatarB64 } },
  ];

  if (frameB64) {
    parts.push({ inline_data: { mime_type: frameMime, data: frameB64 } });
  }

  const requestBody = JSON.stringify({
    contents: [{ role: 'user', parts }],
    generationConfig: {
      responseModalities: ['IMAGE', 'TEXT'],
    },
  });

  // gemini-3.1-flash-image (Nano Banana 2) — stable image-in/image-out model, uses v1
  const apiPath = `/v1/models/gemini-3.1-flash-image:generateContent?key=${geminiKey}`;

  console.log(`generate-nb-composite: user=${user.id}, hasFrame=${!!frameB64}, instrLen=${instruction.length}`);

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
  const candidates = result.data.candidates || [];
  for (const candidate of candidates) {
    for (const part of (candidate.content?.parts || [])) {
      if (part.inline_data?.data) {
        console.log('generate-nb-composite: image generated, mime:', part.inline_data.mime_type);
        return {
          statusCode: 200,
          headers: { ...CORS, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            imageB64: part.inline_data.data,
            mime:     part.inline_data.mime_type || 'image/png',
          }),
        };
      }
    }
  }

  // No image in response — log what we got
  const textParts = candidates.flatMap(c => (c.content?.parts || []).filter(p => p.text).map(p => p.text)).join(' ');
  console.error('generate-nb-composite: no image in response. Text:', textParts.slice(0, 300));
  return {
    statusCode: 502,
    headers: CORS,
    body: JSON.stringify({ error: 'Gemini did not return an image. Response: ' + textParts.slice(0, 200) }),
  };
};
