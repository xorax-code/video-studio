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
const SEGMENT_SYSTEM = `You are a senior short-form (TikTok/Reels/Shorts) UGC ad DIRECTOR for AI-avatar videos. Do three jobs: (A) define the single physical set, (B) split the script into scenes (one per generated clip), and (C) direct each scene like a shot list that maximizes watch-time retention and conversions.

(A) SETTING — define ONCE, reused identically in every scene:
- Choose ONE specific, real, lived-in themed space that fits the script's topic and makes the avatar a believable authority. Examples: a warm traditional home kitchen / apothecary (wood counter, shelves of real glass jars and ingredients, a plant, soft window daylight) for a home remedy; a bright skincare studio with product shelves and a vanity for a skincare routine; a farmers-market stall for food/wellness; a rustic ranch table for outdoor/natural topics.
- It MUST read as a REAL place a real person actually lives or works in — concrete props, natural window light, lived-in detail. NEVER a generic, empty, sterile "AI studio" backdrop, and never a clinical/medical room unless the script is explicitly clinical.
- There is always a counter or table directly in front of the avatar — the stage where the props sit and the demo happens.
- Return it as one rich, specific "setting" string.

(B) SCENE SPLIT:
1. Each scene = ONE coherent visual beat. Cut on meaning — never mid-thought.
2. Each scene is 6 or 8 seconds of spoken delivery. Budget: 8s ≈ up to 18 words, 6s ≈ up to 12 words.
3. "spoken" = the EXACT words from the script, verbatim — never paraphrase, add, or drop words. The scenes together cover the whole script in order, no words lost.

(C) DIRECTION — the shot list (one object per scene):
4. "beat": one of hook | problem | solution | proof | cta. Map the video to this arc IN ORDER — the first scene is the hook, the last is the cta.
5. "action": SPECIFIC physical staging for THIS scene.
   - GROUNDING (critical): only use props/objects/ingredients the script actually NAMES or clearly implies. NEVER invent objects (no rollers, pads, tools, gadgets, devices) that aren't in the script.
   - If the script is a RECIPE / DEMO (mixing, applying, step-by-step): lay the named ingredients out TOGETHER on the counter in EVERY scene (same items, same spots), using real recognizable retail packaging named concretely (e.g. a blue Vaseline petroleum-jelly jar, an orange Arm & Hammer baking-soda box, a bottle of olive oil, a tub of coconut oil). Only the avatar's action changes per scene (scoops, mixes, applies).
   - If the script is a person TALKING ABOUT a product (NOT a recipe/demo): the avatar talks to camera with natural, VARIED gestures and posture — DO NOT invent props or ingredients. Hold the ACTUAL product ONLY on the product-reveal beat (solution/proof). Do not add tools or objects the script never mentions.
   - The avatar is always doing something believable — never frozen, never just standing stiff.
   - Follow the arc: hook (problem / attention) → problem → solution (the product) → proof → cta (final scene: hold the product up to camera, label forward, well-lit, direct to camera).
6. "shot": one of close | medium | wide | product-insert.  SHOT GRAMMAR (for variety AND to stay inside the video model's limits):
   - NEVER use the same shot on two consecutive scenes — change the framing every scene.
   - Bias to STRAIGHT-ON or only slight (<=20°) angles. Do NOT use hard profile or strong three-quarter FACE angles — the avatar's identity drifts and the video filter trips on those.
   - Use "product-insert" (camera on the product, face small or out of frame) on the product-reveal beat.
   - Keep any FACE no larger than ~25% of frame height — no tight face close-ups (a large face trips the person filter). "close" = a closer framing of hands/product, not the face.
   - "medium" and "wide" are safe; favor medium so the room and props stay visible.
7. "framing": ONE concise sentence describing THIS scene's camera/composition (angle, distance, where the subject sits), consistent with "shot" and the rules above.
8. "isProductMoment": true ONLY on scenes where the product is shown/held to camera; false otherwise.
9. "onScreenText": a punchy 6–10 word caption for THIS scene — hook tease early, benefit in the middle, CTA at the end. Plain text, no quotes, no emojis.
10. "emphasis": the single most important word in the line to stress.

CONTINUITY: the SAME person, wardrobe, setting and lighting in EVERY scene — only the camera angle, pose and action change.

SELF-CHECK before returning (fix any violations silently): no two consecutive identical shots; every scene has a beat; the first scene is the hook and the last is the cta; no invented props; total length ≈ the target.

USER DIRECTION: if the message includes a required STRUCTURE/framework, an ANGLE, or WINNING PATTERNS from past hits, honor them — map the script onto the structure, deliver it in that angle, and bias toward the winning hooks/shot patterns when they genuinely fit the script (never force a pattern that doesn't fit).

Return JSON: {"setting":"<one rich, real, specific setting>","scenes":[{"spoken","seconds","beat","action","shot","framing","isProductMoment","onScreenText","emphasis"}, ...]}.`;

const WRITE_SYSTEM = `You are a direct-response UGC scriptwriter for affiliate marketing short-form videos (TikTok/Reels/Shorts). Write a single spoken-word script for one person talking to camera about the product. Open with a scroll-stopping hook in the first line, build desire with a concrete benefit or mechanism, and close with a clear call to action. Keep it natural and conversational — the way a real creator talks, not an ad read. Target the requested length. Return ONLY the script text, no headings, no scene labels, no quotes.`;

const REVISE_SYSTEM = `You are a UGC script editor. Rewrite the user's script applying their revision notes. Keep it a single spoken-word script for one person talking to camera. Preserve what works; change what the notes ask for. Keep it natural and conversational, suitable for a short-form video. Return ONLY the revised script text — no commentary, no headings, no quotes.`;

const SEGMENT_SCHEMA = {
  type: 'object',
  properties: {
    setting: { type: 'string' },
    scenes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          spoken:         { type: 'string'  },
          seconds:        { type: 'integer' },
          beat:           { type: 'string'  },
          action:         { type: 'string'  },
          shot:           { type: 'string'  },
          framing:        { type: 'string'  },
          isProductMoment:{ type: 'boolean' },
          onScreenText:   { type: 'string'  },
          emphasis:       { type: 'string'  },
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

    // Parse the body up front so no-cost tasks (remember_win) can route BEFORE the
    // credit gate and the Vertex token exchange.
    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON body.' }) }; }

    const task          = body.task || 'segment';
    const script        = (body.script  || '').trim();
    const notes         = (body.notes   || '').trim();
    const product       = (body.product || '').trim();
    const character     = (body.character || '').trim();
    const angle         = (body.angle   || '').trim();
    const structure     = (body.structure || '').trim();
    const targetSeconds = Number(body.targetSeconds) || 45;

    // ── Feedback loop: remember a winning video (no credit cost, no Vertex call) ──
    // Appends a compact pattern to the user's per-account playbook in app_metadata
    // (merged, not replaced — credits_balance is preserved). The 'segment' task reads
    // this back and biases future plans toward what has worked for this creator.
    if (task === 'remember_win') {
      const au   = await getAdminUser(user.id);
      const meta = (au && au.app_metadata) || {};
      let pb     = Array.isArray(meta.producer_playbook) ? meta.producer_playbook : [];
      const w    = body.win || {};
      const entry = {
        hook:    String(w.hook    || '').slice(0, 160),
        angle:   String(w.angle   || angle).slice(0, 40),
        product: String(w.product || product).slice(0, 60),
        beats:   String(w.beats   || '').slice(0, 140),
        shots:   String(w.shots   || '').slice(0, 140),
        at:      Date.now(),
      };
      if (!entry.hook && !entry.beats && !entry.shots) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Nothing to remember.' }) };
      }
      pb.unshift(entry);
      pb = pb.slice(0, 15); // keep the 15 most recent wins
      const ok = await updateUserMeta(user.id, { producer_playbook: pb });
      return { statusCode: ok ? 200 : 502, headers: { ...CORS, 'Content-Type': 'application/json' },
        body: JSON.stringify(ok ? { saved: true, count: pb.length } : { error: 'Could not save winner.' }) };
    }

    // ── Credit gate (check upfront; deduct after a successful generation) ──────
    // Also reads the per-user playbook here (same admin call) for the 'segment' task.
    let _paBalance = 0, _playbook = [];
    {
      const adminUser = await getAdminUser(user.id);
      if (!adminUser) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Could not read account data.' }) };
      _paBalance = adminUser.app_metadata?.credits_balance ?? 0;
      _playbook  = Array.isArray(adminUser.app_metadata?.producer_playbook) ? adminUser.app_metadata.producer_playbook : [];
      if (_paBalance < CREDIT_COST) {
        return { statusCode: 402, headers: CORS, body: JSON.stringify({ error: 'insufficient_credits', message: `You're out of credits (${CREDIT_COST} per AI script action). Balance: ${_paBalance}.`, balance: _paBalance, cost: CREDIT_COST }) };
      }
    }
    async function _chargePa() {
      const ok = await updateUserMeta(user.id, { credits_balance: _paBalance - CREDIT_COST });
      if (!ok) console.error(`producer-ai: credit deduction failed for user ${user.id}`);
    }

    let accessToken;
    try { accessToken = await getAccessToken(saJson); }
    catch (e) { return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Vertex auth failed: ' + e.message }) }; }

    // ── Route ──
    if (task === 'segment') {
      if (!script) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'script is required for segment.' }) };
      const _pbBlock = (_playbook && _playbook.length)
        ? '\nWINNING PATTERNS — from this creator\'s past hits. Favor these hooks/angles/shot patterns when they fit the script:\n'
          + _playbook.slice(0, 6).map((p, n) => `${n + 1}. hook:"${p.hook || ''}" · angle:${p.angle || '—'} · shots:${p.shots || '—'}`).join('\n')
        : '';
      const ctx = [
        product   ? `Product: ${product}` : '',
        character ? `The avatar/character: ${character}` : '',
        (structure && structure.toLowerCase() !== 'auto') ? `Required STRUCTURE/framework: ${structure}. Map the script onto this arc.` : '',
        angle ? `Creative ANGLE: ${angle}.` : '',
        `Target total length: about ${targetSeconds} seconds.`,
        _pbBlock,
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
      const _beats = ['hook', 'problem', 'solution', 'proof', 'cta'];
      const clean = scenes.map((s, _i) => {
        const beat = _beats.includes(String(s.beat || '').toLowerCase().trim())
          ? String(s.beat).toLowerCase().trim() : '';
        return {
          spoken:          String(s.spoken || '').trim(),
          seconds:         (Number(s.seconds) >= 7) ? 8 : 6,
          beat,
          action:          String(s.action || '').trim(),
          shot:            String(s.shot || 'medium').trim(),
          framing:         String(s.framing || '').trim(),
          isProductMoment: s.isProductMoment === true,
          onScreenText:    String(s.onScreenText || '').trim(),
          emphasis:        String(s.emphasis || '').trim(),
        };
      }).filter(s => s.spoken);
      if (!clean.length) return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Model returned no scenes.' }) };
      console.log(`producer-ai segment: user=${user.id}, scenes=${clean.length}`);
      await _chargePa();
      return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ setting: String(parsed.setting || '').trim(), scenes: clean, model: MODEL_PRO, creditsDeducted: CREDIT_COST }) };
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
