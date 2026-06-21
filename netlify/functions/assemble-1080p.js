/**
 * Netlify Function: assemble-1080p
 * Stitches the assembler's clips into ONE 1080×1920 (vertical 9:16) MP4 using the
 * Cloud Video Transcoder — concatenating every clip in order, applying each clip's
 * trim (in/out), and upscaling the whole thing to 1080p in a single job.
 *
 * Returns immediately with { jobName, outputGcsUri } — poll with poll-upscale.js
 * (the output file is keyed "sd", i.e. {outputGcsUri}sd.mp4, matching the upscaler).
 *
 * Required env vars (same as upscale-video.js):
 *   GOOGLE_SERVICE_ACCOUNT_JSON, GOOGLE_CLOUD_PROJECT_ID, GOOGLE_CLOUD_STORAGE_BUCKET,
 *   SUPABASE_URL, SUPABASE_ANON (or SUPABASE_ANON_KEY)
 *
 * POST body (JSON):
 *   { clips: [ { videoUrl|gcsUri: "...", start: <sec|null>, end: <sec|null> }, ... ] }
 *   - start/end are trim offsets within each clip (seconds). Pass null/omit when not trimmed.
 *
 * Response: { jobName, outputGcsUri }
 */

const https  = require('https');
const crypto = require('crypto');

const LOCATION = 'us-central1';
const CREDIT_COST = 12; // credits per stitched 1080p export (tune as needed)

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
  const header   = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload  = Buffer.from(JSON.stringify(claim)).toString('base64url');
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
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
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

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch(e) { resolve({ status: res.statusCode, data: null, raw: Buffer.concat(chunks).toString() }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

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
// Refund credits (used when an op can't be registered after retries).
async function addCredits(userId, amount) {
  const url = new URL(`${process.env.SUPABASE_URL}/rest/v1/rpc/add_credits`);
  const k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const b = JSON.stringify({ p_user: userId, p_amount: amount });
  const r = await httpsRequest({ hostname: url.hostname, path: url.pathname, method: 'POST',
    headers: { 'Authorization': `Bearer ${k}`, 'apikey': k, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) } }, b);
  return r.status === 200;
}
// Register a paid job so poll-upscale can verify ownership + refund on failure. This
// row is what makes refunds possible, so we RETRY the write and return whether it
// succeeded, letting the caller refund if every attempt fails.
async function registerVeoOp(opName, userId, cost, kind) {
  const url = new URL(`${process.env.SUPABASE_URL}/rest/v1/veo_operations`);
  const k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const b = JSON.stringify({ op_name: opName, user_id: userId, cost: cost, kind: kind || 'assemble', status: 'pending' });
  const WAITS = [0, 400, 1200]; // up to 3 attempts
  for (let a = 0; a < WAITS.length; a++) {
    if (WAITS[a]) await new Promise(r => setTimeout(r, WAITS[a]));
    try {
      const res = await httpsRequest({ hostname: url.hostname, path: url.pathname, method: 'POST',
        headers: { 'Authorization': `Bearer ${k}`, 'apikey': k, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates,return=minimal', 'Content-Length': Buffer.byteLength(b) } }, b);
      if (res && res.status >= 200 && res.status < 300) return true;
      console.error(`registerVeoOp attempt ${a + 1} for ${opName}: HTTP ${res && res.status}`);
    } catch (e) {
      console.error(`registerVeoOp attempt ${a + 1} failed for ${opName}:`, e && e.message);
    }
  }
  return false;
}

// Convert a signed storage.googleapis.com URL (or a gs:// URI) → gs:// URI
function toGcsUri(input) {
  if (!input) return null;
  if (input.startsWith('gs://')) return input;
  try {
    const u = new URL(input);
    if (u.hostname !== 'storage.googleapis.com') return null;
    const parts  = u.pathname.slice(1).split('/');
    const bucket = decodeURIComponent(parts[0]);
    const object = parts.slice(1).map(decodeURIComponent).join('/');
    return `gs://${bucket}/${object}`;
  } catch(_) { return null; }
}

function offsetStr(sec) {
  return (Math.max(0, Number(sec)).toFixed(3)) + 's';
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

  const required = ['GOOGLE_SERVICE_ACCOUNT_JSON', 'GOOGLE_CLOUD_PROJECT_ID', 'GOOGLE_CLOUD_STORAGE_BUCKET', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
  const missing  = required.filter(k => !process.env[k]);
  if (!process.env.SUPABASE_ANON_KEY && !process.env.SUPABASE_ANON) missing.push('SUPABASE_ANON / SUPABASE_ANON_KEY');
  if (missing.length) {
    console.error('assemble-1080p: missing env vars:', missing.join(', '));
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Server configuration error.' }) };
  }

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
    return { statusCode: 402, headers: CORS, body: JSON.stringify({ error: 'insufficient_credits', message: `Stitching a 1080p video costs ${CREDIT_COST} credits. You have ${currentBalance}.`, balance: currentBalance, cost: CREDIT_COST }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON body.' }) }; }

  const clipsIn = Array.isArray(body.clips) ? body.clips : [];
  if (!clipsIn.length) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'No clips provided.' }) };
  }
  if (clipsIn.length > 60) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Too many clips (max 60).' }) };
  }

  // Only allow inputs from OUR storage bucket (block SSRF / arbitrary-bucket reads)
  const allowedBucket = process.env.GOOGLE_CLOUD_STORAGE_BUCKET.replace(/^gs:\/\//, '').replace(/\/.*$/, '');

  // Build Transcoder inputs + editList (concatenation with per-clip trims)
  const inputs   = [];
  const editList = [];
  for (let i = 0; i < clipsIn.length; i++) {
    const c   = clipsIn[i];
    const uri = toGcsUri(c.gcsUri || c.videoUrl);
    if (!uri) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Clip ' + (i + 1) + ' has no valid cloud source (regenerate it, then re-add).' }) };
    }
    if (uri.indexOf('gs://' + allowedBucket + '/') !== 0) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Clip ' + (i + 1) + ' is not from this app\'s storage and was rejected.' }) };
    }
    const inKey = 'in' + i;
    inputs.push({ key: inKey, uri });
    const atom = { key: 'atom' + i, inputs: [inKey] };
    if (c.start != null && Number(c.start) > 0.05)  atom.startTimeOffset = offsetStr(c.start);
    if (c.end   != null && Number(c.end)   > 0)     atom.endTimeOffset   = offsetStr(c.end);
    editList.push(atom);
  }

  const gcsBucket = process.env.GOOGLE_CLOUD_STORAGE_BUCKET.replace(/\/?$/, '');
  const jobSlug   = Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const outputUri = `${gcsBucket}/assembled/${jobSlug}/`;

  let accessToken;
  try { accessToken = await getAccessToken(process.env.GOOGLE_SERVICE_ACCOUNT_JSON); }
  catch(e) {
    console.error('assemble-1080p: getAccessToken failed:', e.message);
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Could not authenticate with GCP.' }) };
  }

  const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID;
  const apiPath   = `/v1/projects/${projectId}/locations/${LOCATION}/jobs`;
  const _tcConfig = {
    inputs:   inputs,
    editList: editList,
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
        audioStream: { codec: 'aac', bitrateBps: 128000, channelCount: 2, sampleRateHertz: 48000 },
      },
    ],
    muxStreams: [
      { key: 'sd', container: 'mp4', elementaryStreams: ['video-stream0', 'audio-stream0'] },
    ],
  };

  // Free-tier watermark: bake a "Made with AffiliateOS" PNG overlay into the export.
  // Activates ONLY when the frontend asks (body.watermark) AND a watermark image is
  // configured in GCS via WATERMARK_GCS_URI — otherwise this is a no-op and the
  // existing export is unchanged. Upload a transparent PNG (e.g. 360×90) to your
  // bucket and set WATERMARK_GCS_URI=gs://<bucket>/assets/watermark.png to enable.
  if (body.watermark === true && process.env.WATERMARK_GCS_URI) {
    _tcConfig.overlays = [{
      image: { uri: process.env.WATERMARK_GCS_URI, resolution: { x: 0, y: 0 }, alpha: 0.85 },
      animations: [{ animationStatic: { xy: { x: 0.62, y: 0.93 }, startTimeOffset: '0s' } }],
    }];
  }

  const jobBody = JSON.stringify({ outputUri: outputUri, config: _tcConfig });

  console.log(`assemble-1080p: user=${user.id}, clips=${clipsIn.length}, output=${outputUri}`);

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
    console.error('assemble-1080p: Transcoder API error:', e.message);
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Could not reach Transcoder API: ' + e.message }) };
  }

  console.log('assemble-1080p: Transcoder HTTP status:', result.status, JSON.stringify(result.data));

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
  console.log(`assemble-1080p: job created → ${jobName}`);

  // Job submitted — deduct atomically and register the op so poll-upscale can
  // verify ownership (IDOR) and refund the cost if the render fails.
  const _spent   = await spendCredits(user.id, CREDIT_COST);
  let _charged = (_spent !== -1 && _spent !== null);
  if (!_charged) console.error(`assemble-1080p: credit deduction failed for user ${user.id} (job ${jobName} already submitted)`);
  const _registered = await registerVeoOp(jobName, user.id, _charged ? CREDIT_COST : 0, 'assemble');
  if (!_registered && _charged) {
    // Couldn't record the op after retries → poll-upscale can't auto-refund if the
    // render fails. Refund now so no un-refundable charge stands. (The job keeps running.)
    const _ref = await addCredits(user.id, CREDIT_COST);
    if (!_ref) console.error(`assemble-1080p: CRITICAL — refund failed for user ${user.id} after op-registration failure; balance may be wrong`);
    else { _charged = false; console.error(`assemble-1080p: op ${jobName} unregistered after retries — refunded ${CREDIT_COST}.`); }
  }

  return {
    statusCode: 200,
    headers: { ...CORS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobName, outputGcsUri: outputUri, creditsDeducted: _charged ? CREDIT_COST : 0, newBalance: _charged ? _spent : currentBalance }),
  };
};
