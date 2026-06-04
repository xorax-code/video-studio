/**
 * Netlify Function: generate-veo-clip
 * Validates auth → checks/deducts credits → starts Gemini Veo generation.
 * Returns the Gemini operation name so the frontend can poll via poll-veo-clip.js.
 *
 * Required env vars:
 *   GEMINI_API_KEY             — Google AI Studio key with Veo access
 *   SUPABASE_URL               — https://xxx.supabase.co
 *   SUPABASE_ANON_KEY          — anon/public key (for JWT validation)
 *   SUPABASE_SERVICE_ROLE_KEY  — service role key (for reading/writing app_metadata)
 *
 * POST body (JSON):
 *   { prompt: string, durationSecs: 6|8, model: 'lite'|'fast' }
 *
 * Authorization header: Bearer <supabase_jwt>
 */

const https = require('https');

// ── Credit costs per model ────────────────────────────────────────────────────
const CREDIT_COSTS = {
  lite: 15,   // veo-3.1-lite-generate-preview
  fast: 30,   // veo-3.1-fast-generate-preview
};

const MODEL_IDS = {
  lite: 'veo-3.1-lite-generate-preview',
  fast: 'veo-3.1-fast-generate-preview',
};

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) });
        } catch (e) {
          resolve({ status: res.statusCode, data: null });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── Validate JWT and return user (including app_metadata) ─────────────────────
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

// ── Read full user from admin API (includes app_metadata) ─────────────────────
async function getAdminUser(userId) {
  const url = new URL(`${process.env.SUPABASE_URL}/auth/v1/admin/users/${userId}`);
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
  if (result.status !== 200) return null;
  return result.data;
}

// ── Update user app_metadata (merge-patch) ────────────────────────────────────
async function updateUserMeta(userId, meta) {
  const url    = new URL(`${process.env.SUPABASE_URL}/auth/v1/admin/users/${userId}`);
  const svcKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const body   = JSON.stringify({ app_metadata: meta });
  const result = await httpsRequest({
    hostname: url.hostname,
    path:     url.pathname,
    method:   'PATCH',
    headers: {
      'Authorization':  `Bearer ${svcKey}`,
      'apikey':         svcKey,
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  }, body);
  return result.status === 200;
}

// ── Start Gemini Veo generation (returns operation name) ─────────────────────
async function startGeminiGeneration(prompt, durationSecs, modelId) {
  const apiKey = process.env.GEMINI_API_KEY;
  const path   = `/v1beta/models/${modelId}:predictLongRunning`;
  const body   = JSON.stringify({
    instances: [{ prompt: prompt }],
    parameters: {
      aspectRatio:     '9:16',
      durationSeconds: durationSecs,
    },
  });
  const result = await httpsRequest({
    hostname: 'generativelanguage.googleapis.com',
    path:     path,
    method:   'POST',
    headers: {
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(body),
      'x-goog-api-key': apiKey,
    },
  }, body);
  return result;
}

// ── Main handler ──────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const CORS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // ── Env check ──────────────────────────────────────────────────────────────
  const _missingVars = ['GEMINI_API_KEY','SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','SUPABASE_ANON']
    .filter(k => !process.env[k]);
  if (_missingVars.length) {
    console.error('generate-veo-clip: missing env vars:', _missingVars.join(', '));
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Server configuration error.' }) };
  }
  console.log('generate-veo-clip: env check passed');

  // ── Auth ───────────────────────────────────────────────────────────────────
  const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
  const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!jwt) {
    console.error('generate-veo-clip: no JWT in request');
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Missing authorization token.' }) };
  }
  console.log('generate-veo-clip: JWT present, validating with Supabase...');

  const anonUser = await getAuthUser(jwt);
  console.log('generate-veo-clip: getAuthUser result:', anonUser ? `uid=${anonUser.id}` : 'NULL (auth failed)');
  if (!anonUser) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Invalid or expired session. Please log in again.' }) };
  }

  const userId = anonUser.id;

  // ── Parse request body ─────────────────────────────────────────────────────
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON body.' }) }; }

  const { prompt, durationSecs, model = 'lite' } = body;
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'prompt is required.' }) };
  }
  const dur = (durationSecs === 8) ? 8 : 6;
  const modelKey = (model === 'fast') ? 'fast' : 'lite';
  const cost = CREDIT_COSTS[modelKey];
  const modelId = MODEL_IDS[modelKey];

  // ── Credit check ───────────────────────────────────────────────────────────
  const adminUser = await getAdminUser(userId);
  if (!adminUser) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Could not read account data.' }) };
  }

  const currentBalance = adminUser.app_metadata?.credits_balance ?? 0;
  if (currentBalance < cost) {
    return {
      statusCode: 402,
      headers: CORS,
      body: JSON.stringify({
        error:          'insufficient_credits',
        message:        `This clip costs ${cost} credits. You have ${currentBalance}.`,
        balance:        currentBalance,
        cost,
      }),
    };
  }

  // ── Deduct credits upfront ─────────────────────────────────────────────────
  const newBalance = currentBalance - cost;
  const deducted = await updateUserMeta(userId, { credits_balance: newBalance });
  if (!deducted) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Could not reserve credits. Try again.' }) };
  }

  // ── Start Gemini generation ────────────────────────────────────────────────
  let geminiResult;
  try {
    geminiResult = await startGeminiGeneration(prompt.trim(), dur, modelId);
  } catch (e) {
    // Refund credits on network error
    await updateUserMeta(userId, { credits_balance: currentBalance });
    console.error('generate-veo-clip: Gemini start failed', e.message);
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Could not reach generation service. Credits refunded.' }) };
  }

  // Log full Gemini response for debugging
  console.log('generate-veo-clip: Gemini HTTP status:', geminiResult.status);
  console.log('generate-veo-clip: Gemini response body:', JSON.stringify(geminiResult.data));

  if (!geminiResult.data?.name) {
    // Refund credits — generation didn't start
    await updateUserMeta(userId, { credits_balance: currentBalance });

    const errMsg = geminiResult.data?.error?.message || `Gemini API error (HTTP ${geminiResult.status})`;
    if (geminiResult.status === 401 || geminiResult.status === 403) {
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Generation API key not authorized. Contact support.' }) };
    }
    if (geminiResult.status === 429) {
      return { statusCode: 429, headers: CORS, body: JSON.stringify({ error: 'Generation rate limit hit. Wait a moment and try again. Credits refunded.' }) };
    }
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: errMsg + '. Credits refunded.' }) };
  }

  console.log(`generate-veo-clip: user ${userId} started op ${geminiResult.data.name}, ${cost} credits deducted (balance: ${newBalance})`);

  return {
    statusCode: 200,
    headers: { ...CORS, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      operationName:   geminiResult.data.name,
      creditsDeducted: cost,
      newBalance,
      model:           modelKey,
      durationSecs:    dur,
    }),
  };
};
