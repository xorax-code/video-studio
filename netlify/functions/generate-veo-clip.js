/**
 * Netlify Function: generate-veo-clip  (Vertex AI version — no RPD cap)
 * Validates auth → checks/deducts credits → starts Vertex AI Veo generation.
 * Returns the Vertex AI operation name so the frontend can poll via poll-veo-clip.js.
 *
 * Required env vars:
 *   GOOGLE_SERVICE_ACCOUNT_JSON   — full service account key JSON (as a string)
 *   GOOGLE_CLOUD_PROJECT_ID       — e.g. gen-lang-client-0657577212
 *   GOOGLE_CLOUD_STORAGE_BUCKET   — GCS bucket for output, e.g. gs://my-veo-outputs
 *   SUPABASE_URL                  — https://xxx.supabase.co
 *   SUPABASE_ANON                 — anon/public key
 *   SUPABASE_SERVICE_ROLE_KEY     — service role key
 *
 * POST body (JSON):
 *   { prompt, durationSecs, model: 'lite'|'fast', startImageB64?, startImageMime? }
 */

const https  = require('https');
const crypto = require('crypto');

// ── Credit costs ──────────────────────────────────────────────────────────────
const CREDIT_COSTS = {
  lite: 15,
  fast: 30,
};

// Vertex AI model IDs — fast is GA (-001), lite is still preview
const MODEL_IDS = {
  lite: 'veo-3.1-lite-generate-preview',
  fast: 'veo-3.1-fast-generate-001',
};

const LOCATION = 'us-central1';

// ── OAuth2: service account → access token ────────────────────────────────────
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
      'apikey':        process.env.SUPABASE_ANON,
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
    method:   'PUT',
    headers: {
      'Authorization':  `Bearer ${svcKey}`,
      'apikey':         svcKey,
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  }, body);
  return result.status === 200;
}

// ── Start Vertex AI Veo generation ────────────────────────────────────────────
async function startVertexGeneration(prompt, durationSecs, modelId, startImageB64, startImageMime, accessToken) {
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
      aspectRatio:     '9:16',
      durationSeconds: durationSecs,
      storageUri:      gcsBucket,   // GCS bucket for output videos
      generateAudio:   true,        // include synchronized audio in output
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
                    'SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','SUPABASE_ANON'];
  const missing  = required.filter(k => !process.env[k]);
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

  const { prompt, durationSecs, model = 'lite', startImageB64 = null, startImageMime = null } = body;
  if (!prompt?.trim()) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'prompt is required.' }) };

  const dur      = (durationSecs === 8) ? 8 : 6;
  const modelKey = (model === 'fast') ? 'fast' : 'lite';
  const cost     = CREDIT_COSTS[modelKey];
  const modelId  = MODEL_IDS[modelKey];

  console.log(`generate-veo-clip: model=${modelKey} (${modelId}), dur=${dur}s, cost=${cost} credits`);

  // ── Credit check ──────────────────────────────────────────────────────────
  const adminUser = await getAdminUser(userId);
  if (!adminUser) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Could not read account data.' }) };

  const currentBalance = adminUser.app_metadata?.credits_balance ?? 0;
  if (currentBalance < cost) {
    return {
      statusCode: 402, headers: CORS,
      body: JSON.stringify({ error: 'insufficient_credits', message: `This clip costs ${cost} credits. You have ${currentBalance}.`, balance: currentBalance, cost }),
    };
  }

  // ── Deduct credits upfront ────────────────────────────────────────────────
  const newBalance = currentBalance - cost;
  const deducted   = await updateUserMeta(userId, { credits_balance: newBalance });
  if (!deducted) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Could not reserve credits. Try again.' }) };

  // ── Get Vertex AI access token ────────────────────────────────────────────
  let accessToken;
  try {
    accessToken = await getAccessToken(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    console.log('generate-veo-clip: access token obtained');
  } catch(e) {
    await updateUserMeta(userId, { credits_balance: currentBalance });
    console.error('generate-veo-clip: getAccessToken failed:', e.message);
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Could not authenticate with generation service. Credits refunded.' }) };
  }

  // ── Start Vertex AI generation ────────────────────────────────────────────
  let vtxResult;
  try {
    vtxResult = await startVertexGeneration(prompt.trim(), dur, modelId, startImageB64, startImageMime, accessToken);
  } catch(e) {
    await updateUserMeta(userId, { credits_balance: currentBalance });
    console.error('generate-veo-clip: Vertex AI start failed:', e.message);
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Could not reach generation service. Credits refunded.' }) };
  }

  console.log('generate-veo-clip: Vertex AI HTTP status:', vtxResult.status);
  console.log('generate-veo-clip: Vertex AI response:', JSON.stringify(vtxResult.data));

  if (!vtxResult.data?.name) {
    await updateUserMeta(userId, { credits_balance: currentBalance });
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
