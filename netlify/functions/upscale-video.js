/**
 * Netlify Function: upscale-video
 * Submits a Cloud Video Transcoder job to re-encode a GCS video at 1080p (1080×1920).
 * Returns immediately with { jobName, outputGcsUri } so the frontend can poll via poll-upscale.js.
 *
 * Required env vars:
 *   GOOGLE_SERVICE_ACCOUNT_JSON   — full service account key JSON (as a string)
 *   GOOGLE_CLOUD_PROJECT_ID       — your GCP project ID
 *   GOOGLE_CLOUD_STORAGE_BUCKET   — GCS bucket for output, e.g. gs://my-veo-outputs
 *   SUPABASE_URL                  — https://xxx.supabase.co
 *   SUPABASE_ANON                 — anon/public key
 *
 * POST body (JSON):
 *   { gcsUri: "gs://bucket/path/to/video.mp4" }
 *
 * Response:
 *   { jobName: "projects/.../jobs/xxx", outputGcsUri: "gs://bucket/upscaled/xxx/" }
 */

const https  = require('https');
const crypto = require('crypto');

const LOCATION = 'us-central1';
const CREDIT_COST = 8; // credits per 1080p upscale (tune as needed)

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
// Atomic spend: returns new balance, -1 if insufficient/missing, null on error.
async function spendCredits(userId, amount) {
  const url = new URL(`${process.env.SUPABASE_URL}/rest/v1/rpc/spend_credits`);
  const k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const b = JSON.stringify({ p_user: userId, p_amount: amount });
  const r = await httpsRequest({ hostname: url.hostname, path: url.pathname, method: 'POST',
    headers: { 'Authorization': `Bearer ${k}`, 'apikey': k, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) } }, b);
  if (r.status !== 200) return null;
  const n = (typeof r.data === 'number') ? r.data : parseInt(r.data, 10);
  return Number.isFinite(n) ? n : null;
}
async function registerVeoOp(opName, userId, cost, kind) {
  try {
    const url = new URL(`${process.env.SUPABASE_URL}/rest/v1/veo_operations`);
    const k = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const b = JSON.stringify({ op_name: opName, user_id: userId, cost: cost, kind: kind || 'upscale', status: 'pending' });
    await httpsRequest({ hostname: url.hostname, path: url.pathname, method: 'POST',
      headers: { 'Authorization': `Bearer ${k}`, 'apikey': k, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates,return=minimal', 'Content-Length': Buffer.byteLength(b) } }, b);
  } catch (e) { console.error('registerVeoOp failed for ' + opName + ':', e && e.message); }
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
  const required = ['GOOGLE_SERVICE_ACCOUNT_JSON', 'GOOGLE_CLOUD_PROJECT_ID', 'GOOGLE_CLOUD_STORAGE_BUCKET',
                    'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
  const missing  = required.filter(k => !process.env[k]);
  if (!process.env.SUPABASE_ANON_KEY && !process.env.SUPABASE_ANON) missing.push('SUPABASE_ANON / SUPABASE_ANON_KEY');
  if (missing.length) {
    console.error('upscale-video: missing env vars:', missing.join(', '));
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Server configuration error.' }) };
  }

  // ── Auth ──────────────────────────────────────────────────────────────────
  const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
  const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!jwt) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Missing authorization token.' }) };

  const user = await getAuthUser(jwt);
  if (!user) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Invalid or expired session.' }) };

  // ── Credit gate (check upfront; deduct after the job is submitted) ──────────
  const adminUser = await getAdminUser(user.id);
  if (!adminUser) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Could not read account data.' }) };
  const currentBalance = adminUser.app_metadata?.credits_balance ?? 0;
  if (currentBalance < CREDIT_COST) {
    return { statusCode: 402, headers: CORS, body: JSON.stringify({ error: 'insufficient_credits', message: `A 1080p upscale costs ${CREDIT_COST} credits. You have ${currentBalance}.`, balance: currentBalance, cost: CREDIT_COST }) };
  }

  // ── Parse body ────────────────────────────────────────────────────────────
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON body.' }) }; }

  let { gcsUri, videoUrl } = body;

  // Accept either a gs:// URI or the HTTPS signed URL from storage.googleapis.com
  // (poll-veo-clip returns signed HTTPS URLs, not gs:// URIs, to the frontend)
  if (!gcsUri && videoUrl) {
    try {
      // https://storage.googleapis.com/{bucket}/{encoded/object/path}?X-Goog-...
      const u = new URL(videoUrl);
      if (u.hostname !== 'storage.googleapis.com') throw new Error('Not a GCS URL');
      // pathname = "/{bucket}/{object}" — decode each segment
      const parts = u.pathname.slice(1).split('/');
      const bucket = decodeURIComponent(parts[0]);
      const object = parts.slice(1).map(decodeURIComponent).join('/');
      gcsUri = `gs://${bucket}/${object}`;
    } catch(e) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Provide a valid gcsUri (gs://) or videoUrl (storage.googleapis.com).' }) };
    }
  }

  if (!gcsUri || !gcsUri.startsWith('gs://')) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'gcsUri must be a valid gs:// URI.' }) };
  }

  // Only allow inputs from OUR storage bucket (block SSRF / arbitrary-bucket reads)
  const allowedBucket = process.env.GOOGLE_CLOUD_STORAGE_BUCKET.replace(/^gs:\/\//, '').replace(/\/.*$/, '');
  if (gcsUri.indexOf('gs://' + allowedBucket + '/') !== 0) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'That video is not from this app\'s storage and was rejected.' }) };
  }

  // ── Build output URI ──────────────────────────────────────────────────────
  // Strip trailing gs://bucket prefix to get just the bucket name for output
  const gcsBucket   = process.env.GOOGLE_CLOUD_STORAGE_BUCKET.replace(/\/?$/, ''); // e.g. gs://my-veo-outputs
  const jobSlug     = Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const outputUri   = `${gcsBucket}/upscaled/${jobSlug}/`;

  // ── Get access token ──────────────────────────────────────────────────────
  let accessToken;
  try {
    accessToken = await getAccessToken(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  } catch(e) {
    console.error('upscale-video: getAccessToken failed:', e.message);
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Could not authenticate with GCP.' }) };
  }

  // ── Create Transcoder job ─────────────────────────────────────────────────
  const projectId  = process.env.GOOGLE_CLOUD_PROJECT_ID;
  const apiPath    = `/v1/projects/${projectId}/locations/${LOCATION}/jobs`;
  const jobBody    = JSON.stringify({
    inputUri:  gcsUri,
    outputUri: outputUri,
    config: {
      elementaryStreams: [
        {
          key: 'video-stream0',
          videoStream: {
            h264: {
              widthPixels:  1080,
              heightPixels: 1920,
              bitrateBps:   8000000,
              frameRate:    30,
              profile:      'high',
              preset:       'veryfast',
            },
          },
        },
        {
          key: 'audio-stream0',
          audioStream: {
            codec:            'aac',
            bitrateBps:       128000,
            channelCount:     2,
            sampleRateHertz:  48000,
          },
        },
      ],
      muxStreams: [
        {
          key:              'sd',
          container:        'mp4',
          elementaryStreams: ['video-stream0', 'audio-stream0'],
        },
      ],
    },
  });

  console.log(`upscale-video: user=${user.id}, input=${gcsUri}, output=${outputUri}`);

  let result;
  try {
    result = await httpsRequest({
      hostname: 'transcoder.googleapis.com',
      path:     apiPath,
      method:   'POST',
      headers: {
        'Authorization':  `Bearer ${accessToken}`,
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(jobBody),
      },
    }, jobBody);
  } catch(e) {
    console.error('upscale-video: Transcoder API error:', e.message);
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Could not reach Transcoder API: ' + e.message }) };
  }

  console.log('upscale-video: Transcoder HTTP status:', result.status, JSON.stringify(result.data));

  if (result.status !== 200 || !result.data?.name) {
    const errMsg = result.data?.error?.message || `Transcoder error (HTTP ${result.status})`;
    if (/permission denied|cloud storage|storage|forbidden/i.test(errMsg)) {
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'The cloud video renderer doesn’t have access to your storage yet (one-time setup). Grant the Transcoder service agent "Storage Object Admin" on your bucket, then try again.' }) };
    }
    if (result.status === 401 || result.status === 403) {
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'The cloud renderer isn’t authorized yet. Check the service account has the Transcoder Admin role, then try again.' }) };
    }
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: errMsg }) };
  }

  const jobName = result.data.name;
  console.log(`upscale-video: job created → ${jobName}`);

  // Job submitted successfully — deduct credits (best-effort; logged if it fails)
  const _spent   = await spendCredits(user.id, CREDIT_COST);
  const _charged = (_spent !== -1 && _spent !== null);
  if (!_charged) console.error(`upscale-video: credit deduction failed for user ${user.id} (job ${jobName} already submitted)`);
  await registerVeoOp(jobName, user.id, _charged ? CREDIT_COST : 0, 'upscale');
  const _newBalance = _charged ? _spent : currentBalance;

  return {
    statusCode: 200,
    headers: { ...CORS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobName, outputGcsUri: outputUri, creditsDeducted: _charged ? CREDIT_COST : 0, newBalance: _newBalance }),
  };
};
