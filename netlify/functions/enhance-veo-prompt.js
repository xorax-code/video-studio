/**
 * Netlify Function: enhance-veo-prompt
 *
 * Rewrites a casual user prompt into a precise Veo 3 JSON prompt using
 * Gemini 2.5 Flash via the Gemini Developer API.
 *
 * ── TWO MODES ────────────────────────────────────────────────────────────────
 *
 * WITH frame image (multimodal):
 *   Gemini 2.5 Flash sees the actual start frame + the user's intent.
 *   It grounds the action in the real scene — correct camera angle, lighting,
 *   subject position, props — and writes a single-shot Veo 3 action description.
 *
 * WITHOUT frame (text-only):
 *   Gemini 2.5 Flash rewrites the casual prompt into precise Veo 3 language.
 *   Better than gpt-4o-mini for understanding Veo's motion/camera vocabulary.
 *
 * ── REQUEST BODY ─────────────────────────────────────────────────────────────
 *   {
 *     casual:    string   — user's raw prompt text  (required)
 *     frameB64:  string   — base64 start frame      (optional)
 *     frameMime: string   — MIME of frame           (default: "image/jpeg")
 *     duration:  number   — clip duration in secs   (default: 6)
 *   }
 *
 * ── RESPONSE ─────────────────────────────────────────────────────────────────
 *   { action, speech, negative_prompt }
 *
 * Requires env var: GEMINI_API_KEY
 */

const https  = require('https');
const crypto = require('crypto');

const MODEL           = 'gemini-2.5-flash'; // same model id on Vertex AI and the Gemini Dev API
const GEMINI_HOST     = 'generativelanguage.googleapis.com';
const VERTEX_LOCATION = 'us-central1';
// Vertex-only while burning the Google Cloud credit; set true to re-enable the Gemini key fallback.
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

// ── OAuth2: service account → Vertex access token ────────────────────────────
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
  const reqBody = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${unsigned}.${sig}`;
  const res = await httpsRequest({
    hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(reqBody) },
  }, reqBody);
  if (res.data && res.data.access_token) return res.data.access_token;
  throw new Error('Token exchange failed');
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

// ── System prompt ─────────────────────────────────────────────────────────────
const SYSTEM_TEXT_ONLY = `You are a Veo 3 video prompt engineer. Your job is to rewrite the user's casual description into a precise Veo 3 clip prompt.

STRICT RULES:
1. ONE continuous shot — no cuts, no transitions, no scene changes, no "then", no phases, no "first...then", no "as...".
2. Describe only what physically happens in a single moment or sustained action.
3. The action field: one unbroken sentence of movement and camera description, under 60 words. No transition language.
4. The speech field: exact words the person says out loud, written in all lowercase — NEVER use capital letters in speech (capitals cause the API to spell out letters instead of speaking words), or empty string if none.
5. Use Veo 3's vocabulary: cinematic terms, specific camera movements (slow push-in, rack focus, dolly, handheld), lighting descriptors.

Return ONLY valid JSON — no markdown, no explanation:
{"action":"<single continuous movement and camera, under 60 words>","speech":"<exact spoken words or empty string>","negative_prompt":"text overlays, captions, watermarks, subtitles, jump cuts, scene changes, transitions, multiple scenes, blurry"}`;

const SYSTEM_WITH_FRAME = `You are a Veo 3 video prompt engineer. You have been given a reference image — this is the STARTING FRAME of the video clip. Analyze it carefully, then rewrite the user's casual description into a precise Veo 3 clip prompt that is grounded in what you see.

STRICT RULES:
1. ONE continuous shot — no cuts, no transitions, no scene changes, no "then", no phases.
2. Ground the action in the actual scene: match the camera angle, lighting, subject position, and props you see in the frame.
3. The action field: one unbroken sentence describing what happens from this exact starting point, under 60 words. No transitions.
4. The speech field: exact words the person says out loud, written in all lowercase — NEVER use capital letters in speech (capitals cause the API to spell out letters instead of speaking words), or empty string if none.
5. Use Veo 3's vocabulary: cinematic camera terms, specific movements, lighting descriptors.
6. Do NOT describe the frame itself as the action — describe what HAPPENS next from this starting point.

Return ONLY valid JSON — no markdown, no explanation:
{"action":"<single continuous shot grounded in the frame, under 60 words>","speech":"<exact spoken words or empty string>","negative_prompt":"text overlays, captions, watermarks, subtitles, jump cuts, scene changes, transitions, multiple scenes, blurry"}`;

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
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'No text backend configured (set GEMINI_API_KEY or a Vertex service account).' }) };
  }

  // Auth
  const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
  const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!jwt) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Missing authorization token.' }) };

  let user;
  try { user = await getAuthUser(jwt); } catch(e) {
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Auth check failed: ' + e.message }) };
  }
  if (!user) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Invalid or expired session.' }) };

  // Credit gate — block users with no credits (fail-open if admin key unavailable)
  const _svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const _COST = 1;
  let _bal = null;
  if (_svc && process.env.SUPABASE_URL) {
    try {
      const _r = await fetch(process.env.SUPABASE_URL + '/auth/v1/admin/users/' + user.id, { headers: { 'Authorization': 'Bearer ' + _svc, 'apikey': _svc } });
      if (_r.ok) { const _d = await _r.json(); _bal = _d?.app_metadata?.credits_balance ?? 0; }
    } catch(_) {}
  }
  if (_bal != null && _bal < _COST) {
    return { statusCode: 402, headers: CORS, body: JSON.stringify({ error: 'insufficient_credits', message: 'Out of credits.', balance: _bal, cost: _COST }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON body.' }) }; }

  const {
    casual    = '',
    frameB64  = null,
    frameMime = 'image/jpeg',
    duration  = 6,
  } = body;

  if (!casual.trim()) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'casual prompt is required.' }) };
  }

  const hasFrame = !!(frameB64 && frameB64.length > 100);
  const systemText = hasFrame ? SYSTEM_WITH_FRAME : SYSTEM_TEXT_ONLY;

  // Build user parts
  const userParts = [];
  if (hasFrame) {
    userParts.push({ text: 'Reference start frame:' });
    userParts.push({ inlineData: { mimeType: frameMime, data: frameB64 } });
    userParts.push({ text: `User intent: ${casual.trim()}\n\nDuration: ${duration} seconds.\n\nWrite the Veo 3 JSON prompt grounded in this frame.` });
  } else {
    userParts.push({ text: `User intent: ${casual.trim()}\n\nDuration: ${duration} seconds.\n\nWrite the Veo 3 JSON prompt.` });
  }

  const reqBody = JSON.stringify({
    systemInstruction: { parts: [{ text: systemText }] },
    contents: [{ role: 'user', parts: userParts }],
    generationConfig: {
      temperature:      0.4,
      maxOutputTokens:  400,
      responseMimeType: 'application/json',
      thinkingConfig:   { thinkingBudget: 0 }, // disable thinking — overkill for prompt rewriting, avoids parts ordering issue
    },
  });

  const apiPath = `/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;

  console.log(`enhance-veo-prompt: user=${user.id}, model=${MODEL}, hasFrame=${hasFrame}, casual="${casual.slice(0,80)}"`);

  let result = null;
  // 1) Vertex AI first (same model id, one billing lane with the rest of the app)
  if (_vertexConfigured) {
    try {
      const token = await getAccessToken(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
      const vpath = `/v1/projects/${process.env.GOOGLE_CLOUD_PROJECT_ID}/locations/${VERTEX_LOCATION}/publishers/google/models/${MODEL}:generateContent`;
      const rv = await httpsRequest({
        hostname: `${VERTEX_LOCATION}-aiplatform.googleapis.com`, path: vpath, method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(reqBody) },
      }, reqBody);
      if (rv.status === 200 && rv.data && !rv.data.error) result = rv;
      else console.warn('enhance-veo-prompt: Vertex non-200/err, falling back to Gemini Dev API —', rv.status, (rv.data && rv.data.error && rv.data.error.message) || '');
    } catch(e) {
      console.warn('enhance-veo-prompt: Vertex error, falling back to Gemini Dev API —', e.message);
    }
  }
  // 2) Fallback: Gemini Developer API — disabled in Vertex-only mode
  if (!result) {
    if (!ALLOW_GEMINI_FALLBACK || !apiKey) {
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Vertex unavailable (Gemini fallback disabled).' }) };
    }
    try {
      result = await httpsRequest({
        hostname: GEMINI_HOST,
        path:     apiPath,
        method:   'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(reqBody) },
      }, reqBody);
    } catch(e) {
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Could not reach the text model: ' + e.message }) };
    }
  }

  if (result.status === 429) {
    return { statusCode: 429, headers: CORS, body: JSON.stringify({ error: 'Gemini API rate limit — please wait and retry.' }) };
  }
  if (!result.data || result.status !== 200 || result.data.error) {
    const errMsg = result.data?.error?.message || `Gemini API error (HTTP ${result.status})`;
    console.error('enhance-veo-prompt: error:', errMsg);
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: errMsg }) };
  }

  // Parse the JSON response from Gemini
  const raw = result.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  if (!raw) {
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Gemini returned no content.' }) };
  }

  let parsed;
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    parsed = JSON.parse(cleaned);
  } catch(e) {
    console.error('enhance-veo-prompt: JSON parse failed. Raw:', raw.slice(0, 300));
    // Graceful fallback — return the raw casual prompt so generation can still proceed
    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action:          casual.trim(),
        speech:          '',
        negative_prompt: 'text overlays, captions, watermarks, subtitles, jump cuts, scene changes, transitions, blurry',
        fallback:        true,
      }),
    };
  }

  console.log(`enhance-veo-prompt: OK — action: "${(parsed.action || '').slice(0, 80)}"`);

  if (_svc && _bal != null) {
    try { await fetch(process.env.SUPABASE_URL + '/auth/v1/admin/users/' + user.id, { method: 'PUT', headers: { 'Authorization': 'Bearer ' + _svc, 'apikey': _svc, 'Content-Type': 'application/json' }, body: JSON.stringify({ app_metadata: { credits_balance: _bal - _COST } }) }); } catch(_) {}
  }

  return {
    statusCode: 200,
    headers: { ...CORS, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action:          parsed.action          || casual.trim(),
      speech:          parsed.speech          || '',
      negative_prompt: parsed.negative_prompt || 'text overlays, captions, watermarks, subtitles, jump cuts, scene changes, transitions, blurry',
      fallback:        false,
    }),
  };

  } catch(topErr) {
    console.error('enhance-veo-prompt: unhandled exception:', topErr.message, topErr.stack);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: 'Internal error: ' + topErr.message }),
    };
  }
};
