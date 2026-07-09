/**
 * Netlify Function: generate-veo-clip  (Vertex AI version — no RPD cap)
 * Validates auth → checks/deducts credits → starts Vertex AI Veo generation.
 * Returns the Vertex AI operation name so the frontend can poll via poll-veo-clip.js.
 *
 * Required env vars:
 *   GOOGLE_SERVICE_ACCOUNT_JSON   — full service account key JSON (as a string)
 *   GOOGLE_CLOUD_PROJECT_ID       — your GCP project ID
 *   GOOGLE_CLOUD_STORAGE_BUCKET   — GCS bucket for output, e.g. gs://my-veo-outputs
 *   SUPABASE_URL                  — https://xxx.supabase.co
 *   SUPABASE_ANON                 — anon/public key
 *   SUPABASE_SERVICE_ROLE_KEY     — service role key
 *
 * POST body (JSON):
 *   { prompt, durationSecs, model: 'lite'|'fast', startImageB64?, startImageMime?, frameB64?, frameMime? }
 *   frameB64/frameMime — optional reference video frame; if provided, Gemini 2.0 Flash analyzes
 *   it and injects a [SCENE GROUND TRUTH] block into the prompt before sending to Veo.
 */

const https  = require('https');
const crypto = require('crypto');

// ── Credit costs ──────────────────────────────────────────────────────────────
const CREDIT_COSTS = {
  lite:     15,
  fast:     30,
  standard: 80,
};

// Vertex AI model IDs — fast is GA (-001), lite and standard are preview
const MODEL_IDS = {
  lite:     'veo-3.1-lite-generate-001',
  fast:     'veo-3.1-fast-generate-001',
  standard: 'veo-3.1-generate-001',
};

const LOCATION       = 'us-central1';
const ANALYSIS_MODEL = 'gemini-2.0-flash-001'; // fast vision model for scene analysis (separate quota)

// ── Scene frame analysis ──────────────────────────────────────────────────────
// Sends the reference video frame to Gemini 2.0 Flash and returns a structured
// scene description. Injected into the Veo prompt as [SCENE GROUND TRUTH] so Veo
// matches the original video's visual context: setting, camera, lighting, props.
// Fails silently — if null, the original prompt is used unchanged.
const _sceneAnalysisCache = new Map(); // memo: identical frame (continuation extras / regens) reuses the analysis
async function analyzeSceneFrame(frameB64, frameMime, accessToken) {
  if (!frameB64) return null;
  const _scKey = frameB64.length + ':' + frameB64.slice(0, 24) + frameB64.slice(-24);
  if (_sceneAnalysisCache.has(_scKey)) return _sceneAnalysisCache.get(_scKey);
  const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID;
  const prompt = `You are analyzing a video frame for professional video production.
Examine this image carefully. Return ONLY a valid JSON object with these exact fields (no markdown, no explanation, raw JSON only):
{
  "setting": "detailed description of the location/environment — walls, furniture, props on shelves, visible objects, overall space type",
  "camera_angle": "shot type (close-up/medium/wide/full-body) and camera angle (eye level/slightly below/above/tilted)",
  "lighting": "lighting direction (left/right/front/overhead/window), quality (soft/hard/diffused), color temperature (warm/cool/neutral)",
  "subject_position": "where subject stands in frame (center/left/right), approximate vertical coverage (e.g. waist up, full body)",
  "props": "any objects the subject is holding or prominently displayed — exact description of shape, size, what it is",
  "color_palette": "dominant colors in the scene — 3 to 5 colors",
  "visual_style": "overall aesthetic (cinematic/raw/bright/dark/natural/studio etc.)"
}`;

  const reqBody = JSON.stringify({
    contents: [{ role: 'user', parts: [
      { inlineData: { mimeType: frameMime, data: frameB64 } },
      { text: prompt },
    ]}],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 500,
      responseMimeType: 'application/json',
    },
  });

  const path = `/v1/projects/${projectId}/locations/${LOCATION}/publishers/google/models/${ANALYSIS_MODEL}:generateContent`;
  let res;
  try {
    res = await httpsRequest({
      hostname: `${LOCATION}-aiplatform.googleapis.com`,
      path,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(reqBody),
      },
    }, reqBody);
  } catch(e) {
    console.warn('generate-veo-clip: analyzeSceneFrame request error:', e.message);
    return null;
  }

  if (res.status !== 200 || !res.data) {
    console.warn('generate-veo-clip: analyzeSceneFrame non-200:', res.status,
      res.data?.error?.message || '');
    return null;
  }

  const raw = res.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  if (!raw) { console.warn('generate-veo-clip: analyzeSceneFrame empty response'); return null; }

  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed = JSON.parse(cleaned);
    console.log('generate-veo-clip: scene analysis OK — setting:', (parsed.setting || '').slice(0, 80));
    if (_sceneAnalysisCache.size > 200) _sceneAnalysisCache.clear();
    _sceneAnalysisCache.set(_scKey, parsed);
    return parsed;
  } catch(e) {
    console.warn('generate-veo-clip: analyzeSceneFrame JSON parse failed. Raw:', raw.slice(0, 200));
    return null;
  }
}

// ── Build [SCENE GROUND TRUTH] block ─────────────────────────────────────────
function buildSceneBlock(sa) {
  return [
    '[scene reference — match this exactly]',
    `setting: ${sa.setting         || 'not specified'}`,
    `camera angle: ${sa.camera_angle    || 'not specified'}`,
    `lighting: ${sa.lighting        || 'not specified'}`,
    `subject position: ${sa.subject_position || 'not specified'}`,
    `props: ${sa.props           || 'none'}`,
    `color palette: ${sa.color_palette   || 'not specified'}`,
    `visual style: ${sa.visual_style    || 'not specified'}`,
    'preserve the setting, lighting, camera angle, and color palette exactly.',
    '[end scene reference]',
    '',
  ].join('\n');
}

// ── OAuth2: service account → access token ────────────────────────────────────
let _vtxTokenCache = { token: null, exp: 0 };
async function getAccessToken(saJson) {
  if (_vtxTokenCache.token && Date.now() < _vtxTokenCache.exp) return _vtxTokenCache.token;
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
  const unsigned = `${header}.${payload}`;

  const signer = crypto.createSign('RSA-SHA256');
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
          if (data.access_token) { _vtxTokenCache = { token: data.access_token, exp: Date.now() + 3300000 }; resolve(data.access_token); }
          else reject(new Error('Token exchange failed: ' + JSON.stringify(data)));
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Generic HTTPS helper ──────────────────────────────────────────────────────
function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) });
        } catch(e) {
          resolve({ status: res.statusCode, data: null });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── Supabase helpers ──────────────────────────────────────────────────────────
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

async function getAdminUser(userId) {
  const url    = new URL(`${process.env.SUPABASE_URL}/auth/v1/admin/users/${userId}`);
  const svcKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const result = await httpsRequest({
    hostname: url.hostname,
    path:     url.pathname,
    method:   'GET',
    headers: {
      'Authorization': `Bearer ${svcKey}`,
      'apikey':        svcKey,
    },
  });
  return result.status === 200 ? result.data : null;
}

async function updateUserMeta(userId, meta) {
  const url    = new URL(`${process.env.SUPABASE_URL}/auth/v1/admin/users/${userId}`);
  const svcKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const body   = JSON.stringify({ app_metadata: meta });
  const result = await httpsRequest({
    hostname: url.hostname,
    path:     url.pathname,
    method:   'PUT', // Supabase Admin API merges app_metadata fields — PUT is correct here
    headers: {
      'Authorization':  `Bearer ${svcKey}`,
      'apikey':         svcKey,
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  }, body);
  return result.status === 200;
}

// Atomic credit spend via the spend_credits() SQL function — no read-modify-write
// race. Returns the NEW balance, or -1 if insufficient / user missing, or null on error.
async function spendCredits(userId, amount) {
  const url = new URL(`${process.env.SUPABASE_URL}/rest/v1/rpc/spend_credits`);
  const svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const body = JSON.stringify({ p_user: userId, p_amount: amount });
  const r = await httpsRequest({ hostname: url.hostname, path: url.pathname, method: 'POST',
    headers: { 'Authorization': `Bearer ${svc}`, 'apikey': svc, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, body);
  if (r.status !== 200) return null;
  const n = (typeof r.data === 'number') ? r.data : parseInt(r.data, 10);
  return Number.isFinite(n) ? n : null;
}

// Atomic refund/grant via add_credits(). Returns true on success.
async function addCredits(userId, amount) {
  const url = new URL(`${process.env.SUPABASE_URL}/rest/v1/rpc/add_credits`);
  const svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const body = JSON.stringify({ p_user: userId, p_amount: amount });
  const r = await httpsRequest({ hostname: url.hostname, path: url.pathname, method: 'POST',
    headers: { 'Authorization': `Bearer ${svc}`, 'apikey': svc, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, body);
  return r.status === 200;
}

// Register a paid operation so the poller can verify ownership (close the IDOR)
// and refund the cost if the job is filtered/fails. This row is what makes refunds
// possible, so a failed write would mean an un-refundable charge — we RETRY it a few
// times with backoff and return whether it ultimately succeeded so the caller can
// fail-closed (refund) if every attempt fails.
async function registerVeoOp(opName, userId, cost, kind) {
  const url = new URL(`${process.env.SUPABASE_URL}/rest/v1/veo_operations`);
  const svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const body = JSON.stringify({ op_name: opName, user_id: userId, cost: cost, kind: kind || 'clip', status: 'pending' });
  const WAITS = [0, 400, 1200]; // up to 3 attempts
  for (let a = 0; a < WAITS.length; a++) {
    if (WAITS[a]) await new Promise(r => setTimeout(r, WAITS[a]));
    try {
      const res = await httpsRequest({ hostname: url.hostname, path: url.pathname, method: 'POST',
        headers: { 'Authorization': `Bearer ${svc}`, 'apikey': svc, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates,return=minimal', 'Content-Length': Buffer.byteLength(body) } }, body);
      if (res && res.status >= 200 && res.status < 300) return true;
      console.error(`registerVeoOp attempt ${a + 1} for ${opName}: HTTP ${res && res.status}`);
    } catch (e) {
      console.error(`registerVeoOp attempt ${a + 1} failed for ${opName}:`, e && e.message);
    }
  }
  return false;
}

// ── Start Vertex AI Veo generation ────────────────────────────────────────────
async function startVertexGeneration(prompt, durationSecs, modelId, startImageB64, startImageMime, accessToken, aspectRatio) {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID;
  const gcsBucket = process.env.GOOGLE_CLOUD_STORAGE_BUCKET; // e.g. gs://my-veo-outputs
  const path      = `/v1/projects/${projectId}/locations/${LOCATION}/publishers/google/models/${modelId}:predictLongRunning`;

  const instance = { prompt };
  if (startImageB64 && startImageMime) {
    instance.image = { bytesBase64Encoded: startImageB64, mimeType: startImageMime };
    console.log('generate-veo-clip: using starting frame (' + startImageMime + ', ~' + Math.round(startImageB64.length * 0.75 / 1024) + 'KB)');
  } else {
    console.log('generate-veo-clip: text-only generation');
  }

  const body = JSON.stringify({
    instances:  [instance],
    parameters: {
      aspectRatio:      (aspectRatio === '16:9') ? '16:9' : '9:16',
      durationSeconds:  durationSecs,
      storageUri:       gcsBucket,   // GCS bucket for output videos
      generateAudio:    true,        // include synchronized audio in output
      personGeneration: 'allow_adult', // permit generating adult people (documented Vertex param)
    },
  });

  return httpsRequest({
    hostname: `${LOCATION}-aiplatform.googleapis.com`,
    path,
    method: 'POST',
    headers: {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(body),
      'Authorization':  `Bearer ${accessToken}`,
    },
  }, body);
}

// ── Main handler ──────────────────────────────────────────────────────────────
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

  // ── Env check ─────────────────────────────────────────────────────────────
  const required = ['GOOGLE_SERVICE_ACCOUNT_JSON','GOOGLE_CLOUD_PROJECT_ID','GOOGLE_CLOUD_STORAGE_BUCKET',
                    'SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY'];
  const missing  = required.filter(k => !process.env[k]);
  // SUPABASE_ANON is optional — SUPABASE_ANON_KEY is the fallback; at least one must be set
  if (!process.env.SUPABASE_ANON_KEY && !process.env.SUPABASE_ANON) missing.push('SUPABASE_ANON / SUPABASE_ANON_KEY');
  if (missing.length) {
    console.error('generate-veo-clip: missing env vars:', missing.join(', '));
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Server configuration error.' }) };
  }

  // ── Auth ──────────────────────────────────────────────────────────────────
  const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
  const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!jwt) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Missing authorization token.' }) };

  const anonUser = await getAuthUser(jwt);
  if (!anonUser) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Invalid or expired session. Please log in again.' }) };
  const userId = anonUser.id;

  // ── Parse body ────────────────────────────────────────────────────────────
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON body.' }) }; }

  const {
    prompt,
    durationSecs,
    model         = 'lite',
    startImageB64 = null,
    startImageMime = null,
    frameB64      = null,   // optional reference frame for scene analysis
    frameMime     = 'image/jpeg',
    aspectRatio   = '9:16', // Veo supports '9:16' (vertical) or '16:9' (landscape)
    provider      = null,   // per-generation speed pref: 'vertex' = skip kie (faster, pricier)
  } = body;
  if (!prompt?.trim()) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'prompt is required.' }) };

  // Veo 3 only accepts these two ratios; anything else falls back to vertical.
  const aspect   = (aspectRatio === '16:9') ? '16:9' : '9:16';
  const dur      = (durationSecs === 8) ? 8 : 6;
  const modelKey = (model === 'fast') ? 'fast' : (model === 'standard') ? 'standard' : 'lite';
  const cost     = CREDIT_COSTS[modelKey];
  const modelId  = MODEL_IDS[modelKey];

  console.log(`generate-veo-clip: model=${modelKey} (${modelId}), dur=${dur}s, cost=${cost} credits`);

  // ── Credit check ──────────────────────────────────────────────────────────
  const adminUser = await getAdminUser(userId);
  if (!adminUser) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Could not read account data.' }) };

  const currentBalance = adminUser.app_metadata?.credits_balance ?? 0;

  // ── Deduct credits atomically (insufficient-funds check + decrement in one
  //    locked step — no read-modify-write race with concurrent generations). ──
  const newBalance = await spendCredits(userId, cost);
  if (newBalance === -1) {
    return {
      statusCode: 402, headers: CORS,
      body: JSON.stringify({ error: 'insufficient_credits', message: `This clip costs ${cost} credits. You have ${currentBalance}.`, balance: currentBalance, cost }),
    };
  }
  if (newBalance === null) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Could not reserve credits. Try again.' }) };
  }

  // kie.ai provider (flagged) - primary, Vertex fallback on submit failure.
  // Credits are already reserved above. If kie accepts the job we return its taskId
  // (prefixed "kie:") so poll-veo-clip routes to kie. If kie submit fails, we fall
  // through to the Vertex path below WITHOUT re-charging (same reserved credits).
  const _kie = require('./_kie-veo');
  if (_kie.enabled() && provider !== 'vertex') {
    let kr;
    try {
      kr = await _kie.submit({ prompt: prompt.trim(), modelKey, aspect, startImageB64, startImageMime, userId });
    } catch (e) {
      kr = { ok: false, error: e && e.message };
    }
    if (kr && kr.ok) {
      const opName = 'kie:' + kr.taskId;
      const _regK = await registerVeoOp(opName, userId, cost, 'clip');
      if (!_regK) {
        const _rfK = await addCredits(userId, cost);
        if (!_rfK) console.error('generate-veo-clip: CRITICAL - refund failed after kie op-registration failure for ' + userId);
        return { statusCode: 503, headers: CORS, body: JSON.stringify({ error: 'Could not start tracking this clip. Credits refunded - please try again.' }) };
      }
      console.log('generate-veo-clip: user ' + userId + ' started KIE op ' + opName + ', ' + cost + ' credits (balance ' + newBalance + ')');
      return {
        statusCode: 200,
        headers: { ...CORS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ operationName: opName, creditsDeducted: cost, newBalance, model: modelKey, durationSecs: dur }),
      };
    }
    console.warn('generate-veo-clip: kie submit failed - falling back to Vertex:', kr && kr.error);
  }

  // ── Get Vertex AI access token ────────────────────────────────────────────
  let accessToken;
  try {
    accessToken = await getAccessToken(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    console.log('generate-veo-clip: access token obtained');
  } catch(e) {
    // FIX: log if the refund itself fails so ops can remediate
    const refunded1 = await addCredits(userId, cost);
    if (!refunded1) console.error(`generate-veo-clip: CRITICAL — credit refund failed for user ${userId} after token error; balance may be wrong`);
    console.error('generate-veo-clip: getAccessToken failed:', e.message);
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Could not authenticate with generation service. Credits refunded.' }) };
  }

  // ── Scene frame analysis (optional) ──────────────────────────────────────
  // If a reference frame was provided, analyze it with Gemini 2.0 Flash and
  // prepend a [SCENE GROUND TRUTH] block to the prompt. This grounds Veo in
  // the original video's setting, camera angle, lighting, and props.
  let finalPrompt = prompt.trim();
  if (frameB64) {
    const sceneAnalysis = await analyzeSceneFrame(frameB64, frameMime, accessToken);
    if (sceneAnalysis) {
      finalPrompt = buildSceneBlock(sceneAnalysis) + finalPrompt;
      console.log('generate-veo-clip: scene analysis injected — prompt now', finalPrompt.length, 'chars');
    } else {
      console.log('generate-veo-clip: scene analysis unavailable — using original prompt');
    }
  }

  // ── Start Vertex AI generation ────────────────────────────────────────────
  let vtxResult;
  try {
    vtxResult = await startVertexGeneration(finalPrompt, dur, modelId, startImageB64, startImageMime, accessToken, aspect);
  } catch(e) {
    const refunded2 = await addCredits(userId, cost);
    if (!refunded2) console.error(`generate-veo-clip: CRITICAL — credit refund failed for user ${userId} after Vertex start error; balance may be wrong`);
    console.error('generate-veo-clip: Vertex AI start failed:', e.message);
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Could not reach generation service. Credits refunded.' }) };
  }

  console.log('generate-veo-clip: Vertex AI HTTP status:', vtxResult.status);
  console.log('generate-veo-clip: Vertex AI response:', JSON.stringify(vtxResult.data));

  if (!vtxResult.data?.name) {
    const refunded3 = await addCredits(userId, cost);
    if (!refunded3) console.error(`generate-veo-clip: CRITICAL — credit refund failed for user ${userId} after Vertex response error; balance may be wrong`);
    const errMsg = vtxResult.data?.error?.message || `Vertex AI error (HTTP ${vtxResult.status})`;
    if (vtxResult.status === 401 || vtxResult.status === 403) {
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Service account not authorized. Check IAM permissions. Credits refunded.' }) };
    }
    if (vtxResult.status === 429) {
      return { statusCode: 429, headers: CORS, body: JSON.stringify({ error: 'Rate limit hit. Wait a moment and try again. Credits refunded.' }) };
    }
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: errMsg + '. Credits refunded.' }) };
  }

  console.log(`generate-veo-clip: user ${userId} started op ${vtxResult.data.name}, ${cost} credits deducted (balance: ${newBalance})`);

  // Register the op so poll-veo-clip can verify ownership (close IDOR) and refund
  // the cost if Google's safety filter blocks the clip. Retried internally.
  const _registered = await registerVeoOp(vtxResult.data.name, userId, cost, 'clip');
  if (!_registered) {
    // Couldn't record the op after retries → it can't be tracked or auto-refunded if
    // it's later filtered. Fail closed: refund now and abort rather than leave an
    // un-refundable charge. (The Vertex job is orphaned and expires on its own.)
    const refunded4 = await addCredits(userId, cost);
    if (!refunded4) console.error(`generate-veo-clip: CRITICAL — credit refund failed for user ${userId} after op-registration failure; balance may be wrong`);
    console.error(`generate-veo-clip: op ${vtxResult.data.name} could not be registered after retries — refunded and aborted.`);
    return { statusCode: 503, headers: CORS, body: JSON.stringify({ error: 'Could not start tracking this clip. Credits refunded — please try again.' }) };
  }

  return {
    statusCode: 200,
    headers: { ...CORS, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      operationName:   vtxResult.data.name,
      creditsDeducted: cost,
      newBalance,
      model:           modelKey,
      durationSecs:    dur,
    }),
  };
};
