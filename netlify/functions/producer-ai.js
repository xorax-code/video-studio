/**
 * Netlify Function: producer-ai
 * ------------------------------
 * The creative brain for Video Producer 2.0. Runs Gemini on **Vertex AI**
 * (higher rate limits than the Developer API) reusing the SAME service-account
 * auth already used by generate-veo-clip.js — no new secrets required.
 *
 * Model routing:
 *   - task 'segment'  -> Gemini 2.5 Pro   (creative direction; quality matters)
 *   - task 'revise'   -> Gemini 2.5 Pro   (rewrites the script from user notes)
 *   - task 'write'    -> Gemini 2.5 Pro   (writes a first-draft script)
 *   (plumbing/Veo-prompt steps stay on Flash elsewhere)
 *
 * Required env vars (all already set for Veo):
 *   GOOGLE_SERVICE_ACCOUNT_JSON   — service account key JSON (string)
 *   GOOGLE_CLOUD_PROJECT_ID       — GCP project id
 *   SUPABASE_URL                  — https://xxx.supabase.co
 *   SUPABASE_ANON / SUPABASE_ANON_KEY — anon key for JWT validation
 *
 * POST body (JSON):
 *   { task: 'segment'|'revise'|'write',
 *     script?: string, notes?: string, product?: string,
 *     targetSeconds?: number, character?: string }
 *
 * Authorization header: Bearer <supabase_jwt>
 */

const https  = require('https');
const crypto = require('crypto');

const LOCATION    = 'us-central1';
const MODEL_PRO   = 'gemini-2.5-pro';
const MODEL_FLASH = 'gemini-2.5-flash';
const CREDIT_COST = 1; // credits per script/segment AI call (tune as needed)

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// ── Generic HTTPS helper ──────────────────────────────────────────────────────
function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch (e) { resolve({ status: res.statusCode, data: null, raw: Buffer.concat(chunks).toString() }); }
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

// ── OAuth2: service account → access token (same as generate-veo-clip.js) ─────
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
  const header   = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload  = Buffer.from(JSON.stringify(claim)).toString('base64url');
  const unsigned = `${header}.${payload}`;
  const signer   = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  const sig = signer.sign(sa.private_key, 'base64url');
  const jwt = `${unsigned}.${sig}`;
  const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'oauth2.googleapis.com',
      path:     '/token',
      method:   'POST',
      headers: {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          if (data.access_token) resolve(data.access_token);
          else reject(new Error('Token exchange failed: ' + JSON.stringify(data)));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Call a Gemini model on Vertex AI ──────────────────────────────────────────
async function callVertexGemini(model, systemText, userText, accessToken, opts = {}) {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID;
  const generationConfig = {
    temperature:     opts.temperature ?? 0.7,
    maxOutputTokens: opts.maxOutputTokens ?? 2048,
  };
  if (opts.json) generationConfig.responseMimeType = 'application/json';
  if (opts.responseSchema) generationConfig.responseSchema = opts.responseSchema;

  const reqBody = JSON.stringify({
    systemInstruction: { parts: [{ text: systemText }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig,
  });

  const path = `/v1/projects/${projectId}/locations/${LOCATION}/publishers/google/models/${model}:generateContent`;
  const res = await httpsRequest({
    hostname: `${LOCATION}-aiplatform.googleapis.com`,
    path,
    method:  'POST',
    headers: {
      'Authorization':  `Bearer ${accessToken}`,
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(reqBody),
    },
  }, reqBody);

  if (res.status === 429) throw Object.assign(new Error('Vertex AI rate limit — please retry.'), { code: 429 });
  if (res.status !== 200 || !res.data || res.data.error) {
    throw new Error(res.data?.error?.message || `Vertex Gemini error (HTTP ${res.status})`);
  }
  return res.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

function parseJsonLoose(raw) {
  const cleaned = String(raw || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  return JSON.parse(cleaned);
}

// ── Prompts ───────────────────────────────────────────────────────────────────
const SEGMENT_SYSTEM = `You are a short-form video director for AI avatar (UGC) ads. Split the user's script into scenes for an AI avatar to perform, one scene per generated video clip.

RULES:
1. Each scene = ONE coherent visual beat. Cut on meaning — never mid-thought.
2. Each scene is 6 or 8 seconds of spoken delivery. Budget words: 8s ≈ up to 18 words, 6s ≈ up to 12 words. Use 8 for fuller lines, 6 for short/punchy lines.
3. "spoken" must be the EXACT words from the script, verbatim — never paraphrase, add, or drop words. Together the scenes must cover the entire script in order with no words lost.
4. "action": a SPECIFIC physical action + camera note for the avatar in this scene (e.g. "holds the product label-forward at chest height, slight lean toward camera, soft push-in"). One continuous shot — no cuts or "then".
5. "shot": framing — one of close-up, medium close-up, medium, or wide.
6. "emphasis": the single most important word in the line to stress.
7. Keep the avatar in ONE consistent setting across all scenes unless the script clearly changes location.

Return JSON: {"scenes":[{"spoken","seconds","action","shot","emphasis"}, ...]}.`;

const WRITE_SYSTEM = `You are a direct-response UGC scriptwriter for affiliate marketing short-form videos (TikTok/Reels/Shorts). Write a single spoken-word script for one person talking to camera about the product. Open with a scroll-stopping hook in the first line, build desire with a concrete benefit or mechanism, and close with a clear call to action. Keep it natural and conversational — the way a real creator talks, not an ad read. Target the requested length. Return ONLY the script text, no headings, no scene labels, no quotes.`;

const REVISE_SYSTEM = `You are a UGC script editor. Rewrite the user's script applying their revision notes. Keep it a single spoken-word script for one person talking to camera. Preserve what works; change what the notes ask for. Keep it natural and conversational, suitable for a short-form video. Return ONLY the revised script text — no commentary, no headings, no quotes.`;

const SEGMENT_SCHEMA = {
  type: 'object',
  properties: {
    scenes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          spoken:   { type: 'string'  },
          seconds:  { type: 'integer' },
          action:   { type: 'string'  },
          shot:     { type: 'string'  },
          emphasis: { type: 'string'  },
        },
        required: ['spoken', 'seconds', 'action'],
      },
    },
  },
  required: ['scenes'],
};

// ── Handler ───────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  try {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
    if (event.httpMethod !== 'POST')
      return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

    const saJson    = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID;
    if (!saJson || !projectId)
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Vertex AI not configured (service account / project id missing).' }) };

    // Auth
    const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
    const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    if (!jwt) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Missing authorization token.' }) };
    let user;
    try { user = await getAuthUser(jwt); }
    catch (e) { return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Auth check failed: ' + e.message }) }; }
    if (!user) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Invalid or expired session.' }) };

    // ── Credit gate (check upfront; deduct after a successful generation) ──────
    let _paBalance = 0;
    {
      const adminUser = await getAdminUser(user.id);
      if (!adminUser) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Could not read account data.' }) };
      _paBalance = adminUser.app_metadata?.credits_balance ?? 0;
      if (_paBalance < CREDIT_COST) {
        return { statusCode: 402, headers: CORS, body: JSON.stringify({ error: 'insufficient_credits', message: `You're out of credits (${CREDIT_COST} per AI script action). Balance: ${_paBalance}.`, balance: _paBalance, cost: CREDIT_COST }) };
      }
    }
    async function _chargePa() {
      const ok = await updateUserMeta(user.id, { credits_balance: _paBalance - CREDIT_COST });
      if (!ok) console.error(`producer-ai: credit deduction failed for user ${user.id}`);
    }

    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON body.' }) }; }

    const task          = body.task || 'segment';
    const script        = (body.script  || '').trim();
    const notes         = (body.notes   || '').trim();
    const product       = (body.product || '').trim();
    const character     = (body.character || '').trim();
    const targetSeconds = Number(body.targetSeconds) || 45;

    let accessToken;
    try { accessToken = await getAccessToken(saJson); }
    catch (e) { return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Vertex auth failed: ' + e.message }) }; }

    // ── Route ──
    if (task === 'segment') {
      if (!script) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'script is required for segment.' }) };
      const ctx = [
        product   ? `Product: ${product}` : '',
        character ? `The avatar/character: ${character}` : '',
        `Target total length: about ${targetSeconds} seconds.`,
        '',
        'SCRIPT:',
        script,
      ].filter(Boolean).join('\n');

      let raw;
      try {
        raw = await callVertexGemini(MODEL_PRO, SEGMENT_SYSTEM, ctx, accessToken,
          { temperature: 0.6, maxOutputTokens: 2048, json: true, responseSchema: SEGMENT_SCHEMA });
      } catch (e) {
        const sc = e.code === 429 ? 429 : 502;
        return { statusCode: sc, headers: CORS, body: JSON.stringify({ error: e.message }) };
      }
      let parsed;
      try { parsed = parseJsonLoose(raw); } catch (e) {
        console.error('producer-ai segment: parse failed. Raw:', String(raw).slice(0, 300));
        return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Could not parse scene breakdown from the model.' }) };
      }
      const scenes = Array.isArray(parsed?.scenes) ? parsed.scenes : [];
      // Normalize: clamp seconds to 6 or 8, trim fields
      const clean = scenes.map(s => ({
        spoken:   String(s.spoken || '').trim(),
        seconds:  (Number(s.seconds) >= 7) ? 8 : 6,
        action:   String(s.action || '').trim(),
        shot:     String(s.shot || 'medium').trim(),
        emphasis: String(s.emphasis || '').trim(),
      })).filter(s => s.spoken);
      if (!clean.length) return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Model returned no scenes.' }) };
      console.log(`producer-ai segment: user=${user.id}, scenes=${clean.length}`);
      await _chargePa();
      return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenes: clean, model: MODEL_PRO, creditsDeducted: CREDIT_COST }) };
    }

    if (task === 'write' || task === 'revise') {
      const isWrite = task === 'write';
      if (!isWrite && !script) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'script is required for revise.' }) };
      const sys = isWrite ? WRITE_SYSTEM : REVISE_SYSTEM;
      const userText = isWrite
        ? [ product ? `Product: ${product}` : '', character ? `Creator/character: ${character}` : '',
            `Target length: about ${targetSeconds} seconds of speech.`, notes ? `Direction: ${notes}` : '' ].filter(Boolean).join('\n')
        : [ notes ? `Revision notes: ${notes}` : 'Revision notes: tighten and improve it.', '', 'CURRENT SCRIPT:', script ].join('\n');

      let text;
      try {
        text = await callVertexGemini(MODEL_PRO, sys, userText, accessToken,
          { temperature: 0.8, maxOutputTokens: 1024 });
      } catch (e) {
        const sc = e.code === 429 ? 429 : 502;
        return { statusCode: sc, headers: CORS, body: JSON.stringify({ error: e.message }) };
      }
      const out = String(text || '').trim();
      if (!out) return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Model returned no script.' }) };
      console.log(`producer-ai ${task}: user=${user.id}, chars=${out.length}`);
      await _chargePa();
      return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ script: out, model: MODEL_PRO, creditsDeducted: CREDIT_COST }) };
    }

    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Unknown task: ' + task }) };

  } catch (topErr) {
    console.error('producer-ai: unhandled exception:', topErr.message, topErr.stack);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Internal error: ' + topErr.message }) };
  }
};
