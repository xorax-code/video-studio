/**
 * Netlify Function: poll-veo-clip  (Vertex AI version — no RPD cap)
 * Polls a Vertex AI operation for completion.
 * When done, generates a V4 signed GCS URL so the frontend can fetch the video.
 *
 * Required env vars:
 *   GOOGLE_SERVICE_ACCOUNT_JSON   — full service account key JSON (as a string)
 *   GOOGLE_CLOUD_PROJECT_ID       — your GCP project ID
 *   SUPABASE_URL                  — https://xxx.supabase.co
 *   SUPABASE_ANON                 — anon/public key
 *
 * POST body:  { operationName: string }
 * Auth header: Bearer <supabase_jwt>
 */

const https  = require('https');
const crypto = require('crypto');

const LOCATION = 'us-central1';

// OAuth2: service account -> access token. Cached per warm Lambda container
// (tokens last 1h) so we don't RSA-sign + round-trip on every 6s poll.
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
  const unsigned = header + '.' + payload;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  const sig = signer.sign(sa.private_key, 'base64url');
  const jwt = unsigned + '.' + sig;
  const body = 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt;
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

// V4 Signed URL for GCS object
function createSignedUrl(gcsUri, sa, expiresInSeconds) {
  const exp   = expiresInSeconds || 3600;
  const match = gcsUri.match(/^gs:\/\/([^/]+)\/(.+)$/);
  if (!match) throw new Error('Invalid GCS URI: ' + gcsUri);
  const bucket = match[1];
  const object = match[2];
  const now      = new Date();
  const dateStr  = now.toISOString().slice(0,10).replace(/-/g,'');
  const timeStr  = now.toISOString().replace(/[-:]/g,'').slice(0,15) + 'Z';
  const credentialScope = dateStr + '/auto/storage/goog4_request';
  const credential      = sa.client_email + '/' + credentialScope;
  const encodedObject   = object.split('/').map(encodeURIComponent).join('/');
  const queryParams = [
    'X-Goog-Algorithm=GOOG4-RSA-SHA256',
    'X-Goog-Credential=' + encodeURIComponent(credential),
    'X-Goog-Date=' + timeStr,
    'X-Goog-Expires=' + exp,
    'X-Goog-SignedHeaders=host',
  ].join('&');
  const canonicalRequest = [
    'GET',
    '/' + bucket + '/' + encodedObject,
    queryParams,
    'host:storage.googleapis.com\n',
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const canonicalHash = crypto.createHash('sha256').update(canonicalRequest).digest('hex');
  const stringToSign = ['GOOG4-RSA-SHA256', timeStr, credentialScope, canonicalHash].join('\n');
  const signer2 = crypto.createSign('RSA-SHA256');
  signer2.update(stringToSign);
  const signature = signer2.sign(sa.private_key, 'hex');
  return 'https://storage.googleapis.com/' + bucket + '/' + encodedObject + '?' + queryParams + '&X-Goog-Signature=' + signature;
}

// Poll Vertex AI Veo operation via fetchPredictOperation
//
// Veo's predictLongRunning returns operation names like:
//   projects/{p}/locations/{l}/publishers/google/models/{m}/operations/{uuid}
//
// Neither GET /v1/{operationName} nor GET /v1/projects/{p}/locations/{l}/operations/{uuid}
// work for Veo — the correct API is POST :fetchPredictOperation on the model endpoint,
// passing the full operation name in the request body.
//
// The project and model in the operation name come from Google's internal routing
// (may differ from GOOGLE_CLOUD_PROJECT_ID), so we parse them from operationName directly.
function pollOperation(operationName, accessToken) {
  // Parse: projects/{p}/locations/{l}/publishers/google/models/{m}/operations/{id}
  var match = operationName.match(
    /^projects\/([^/]+)\/locations\/([^/]+)\/publishers\/google\/models\/([^/]+)\/operations\//
  );
  var hostname, path, body;
  if (match) {
    var opProject  = match[1];
    var opLocation = match[2];
    var opModel    = match[3];
    path = '/v1/projects/' + opProject + '/locations/' + opLocation
         + '/publishers/google/models/' + opModel + ':fetchPredictOperation';
    hostname = opLocation + '-aiplatform.googleapis.com';
    body = JSON.stringify({ operationName: operationName });
    console.log('poll-veo-clip: fetchPredictOperation', hostname + path);
  } else {
    // Fallback: GET on the full name (may 404 but worth trying)
    path = '/v1/' + operationName;
    hostname = LOCATION + '-aiplatform.googleapis.com';
    body = null;
    console.log('poll-veo-clip: fallback GET', hostname + path);
  }

  return new Promise((resolve, reject) => {
    var opts = {
      hostname: hostname,
      path:     path,
      method:   body ? 'POST' : 'GET',
      headers:  { 'Authorization': 'Bearer ' + accessToken },
    };
    if (body) {
      opts.headers['Content-Type']   = 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) });
        } catch(e) { resolve({ status: res.statusCode, data: null }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// JWT validation via Supabase
function validateJwt(jwt) {
  return new Promise((resolve) => {
    const url = new URL(process.env.SUPABASE_URL + '/auth/v1/user');
    const req = https.request({
      hostname: url.hostname,
      path:     url.pathname,
      method:   'GET',
      headers: { 'Authorization': 'Bearer ' + jwt, 'apikey': process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_ANON || '' },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          resolve(res.statusCode === 200 && data && data.id ? data : null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

// ── Operation registry (ownership + refunds) via service role ────────────────
function sbAdmin(path, opts) {
  const svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
  opts = opts || {};
  return new Promise((resolve) => {
    const url = new URL(process.env.SUPABASE_URL + '/rest/v1/' + path);
    const data = opts.body || null;
    const headers = Object.assign({ 'apikey': svc, 'Authorization': 'Bearer ' + svc }, opts.headers || {});
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const req = https.request({ hostname: url.hostname, path: url.pathname + url.search, method: opts.method || 'GET', headers }, (res) => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString() || 'null') }); } catch { resolve({ status: res.statusCode, data: null }); } });
    });
    req.on('error', () => resolve({ status: 0, data: null }));
    if (data) req.write(data);
    req.end();
  });
}
// Returns { user_id, cost, status } for a registered op, or null if not found.
async function getVeoOp(opName) {
  const r = await sbAdmin('veo_operations?op_name=eq.' + encodeURIComponent(opName) + '&select=user_id,cost,status', {});
  if (r.status === 200 && Array.isArray(r.data) && r.data.length) return r.data[0];
  return null;
}
// Atomically claim a pending op (UPDATE ... WHERE status='pending' is the lock so
// repeated polls / concurrent tabs can't double-refund), then add the cost back.
// Returns the refunded amount (0 if it was already handled or not pending).
async function refundVeoOp(opName, op) {
  if (!op || op.status !== 'pending' || !op.cost) return 0;
  const claim = await sbAdmin('veo_operations?op_name=eq.' + encodeURIComponent(opName) + '&status=eq.pending',
    { method: 'PATCH', headers: { 'Prefer': 'return=representation' }, body: JSON.stringify({ status: 'refunded' }) });
  if (!(claim.status === 200 && Array.isArray(claim.data) && claim.data.length)) return 0; // someone else claimed it
  const credited = await sbAdmin('rpc/add_credits', { method: 'POST', body: JSON.stringify({ p_user: op.user_id, p_amount: op.cost }) });
  if (credited.status !== 200) {
    // Claimed the row but the credit write failed — roll status back to 'pending' so a
    // later poll retries the refund, and log loudly. Prevents permanently-lost credits.
    console.error('CRITICAL refundVeoOp: add_credits failed for op ' + opName + ' user ' + op.user_id + ' cost ' + op.cost + ' — rolling back to pending');
    await sbAdmin('veo_operations?op_name=eq.' + encodeURIComponent(opName), { method: 'PATCH', headers: { 'Prefer': 'return=minimal' }, body: JSON.stringify({ status: 'pending' }) }).catch(function(){});
    return 0;
  }
  return op.cost;
}
// Mark a succeeded op done so it can never be refunded afterward.
function markVeoOpDone(opName) {
  return sbAdmin('veo_operations?op_name=eq.' + encodeURIComponent(opName) + '&status=eq.pending',
    { method: 'PATCH', headers: { 'Prefer': 'return=minimal' }, body: JSON.stringify({ status: 'done' }) }).catch(function(){});
}

// Persist a finished clip to the user's cloud library (best-effort, non-fatal).
// We store the gs:// path, never a signed URL — list-user-videos re-signs on read.
// Download a finished kie clip (an expiring https URL) and re-upload it to our GCS bucket, so the
// 1080p upscale + 1080p reel (which require a gs:// source) work for kie clips too. Returns gs:// URI.
async function uploadRemoteVideoToGcs(accessToken, bucketName, objectName, remoteUrl) {
  const resp = await fetch(remoteUrl);
  if (!resp.ok) throw new Error('kie video download HTTP ' + resp.status);
  const buf = Buffer.from(await resp.arrayBuffer());
  if (!buf.length) throw new Error('kie video download was empty');
  if (buf.length > 80 * 1024 * 1024) throw new Error('kie video too large to persist (' + buf.length + ' bytes)');
  const path = '/upload/storage/v1/b/' + encodeURIComponent(bucketName) + '/o?uploadType=media&name=' + encodeURIComponent(objectName);
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: 'storage.googleapis.com', path, method: 'POST',
      headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'video/mp4', 'Content-Length': buf.length } },
      (res) => { const ch = []; res.on('data', c => ch.push(c)); res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve('gs://' + bucketName + '/' + objectName);
        else reject(new Error('GCS video upload HTTP ' + res.statusCode + ' ' + Buffer.concat(ch).toString().slice(0, 200)));
      }); });
    req.on('error', reject); req.write(buf); req.end();
  });
}

async function saveUserVideo(userId, gcsUri, mime, label, duration) {
  if (!userId || !gcsUri) return;
  try {
    await sbAdmin('user_videos', {
      method: 'POST',
      headers: { 'Prefer': 'return=minimal' },
      body: JSON.stringify({
        user_id:  userId,
        gcs_uri:  gcsUri,
        mime:     mime || 'video/mp4',
        label:    label || null,
        duration: (typeof duration === 'number' && duration > 0) ? duration : null,
      }),
    });
  } catch (e) {
    // Library save is best-effort — never fail a successful generation over it.
    console.warn('poll-veo-clip: saveUserVideo failed (non-fatal):', e && e.message);
  }
}

// Main handler
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
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON || !process.env.GOOGLE_CLOUD_PROJECT_ID) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Server configuration error.' }) };
  }
  const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
  const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!jwt) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Missing authorization token.' }) };
  const authUser = await validateJwt(jwt);
  if (!authUser) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Invalid or expired session.' }) };
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON.' }) }; }
  const { operationName, label, durationSecs } = body;
  if (!operationName || typeof operationName !== 'string') {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'operationName is required.' }) };
  }
  // Ownership check: refuse only a CONFIRMED cross-user access (row exists with a
  // different owner) — closes the IDOR. A missing row (registry write lagged/failed)
  // is allowed through so we never break a legit poll; it just can't be refunded.
  const _op = await getVeoOp(operationName);
  if (_op && _op.user_id !== authUser.id) {
    console.warn('poll-veo-clip: user ' + authUser.id + ' attempted op owned by ' + _op.user_id);
    return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Forbidden.' }) };
  }

  // Omni Flash (Gemini Omni) poll branch — task ids prefixed "kieomni:" by generate-veo-clip.
  // Mirrors the kie: branch exactly (refund on error, persist finished clip to GCS so 1080p
  // export works), but routes through _kie.pollOmni and slices the 8-char "kieomni:" prefix.
  if (operationName.indexOf('kieomni:') === 0) {
    const _kie = require('./_kie-veo');
    let kr;
    try { kr = await _kie.pollOmni(operationName.slice(8)); }
    catch (e) {
      return { statusCode: 200, headers: Object.assign({}, CORS, { 'Content-Type': 'application/json' }), body: JSON.stringify({ done: false }) };
    }
    if (!kr.done) {
      return { statusCode: 200, headers: Object.assign({}, CORS, { 'Content-Type': 'application/json' }), body: JSON.stringify({ done: false }) };
    }
    if (kr.error) {
      const _rk = await refundVeoOp(operationName, _op);
      return { statusCode: 200, headers: Object.assign({}, CORS, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ done: true, error: kr.error, filtered: !!kr.filtered, refunded: _rk > 0, refundedCredits: _rk }) };
    }
    await markVeoOpDone(operationName);
    // Persist the finished Omni clip to GCS (kie URLs expire + aren't GCS) so 1080p upscale
    // + the 1080p reel work. Best-effort: on ANY failure fall back to the raw kie URL.
    try {
      const _at  = await getAccessToken(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
      const _bkt = (process.env.GOOGLE_CLOUD_STORAGE_BUCKET || '').replace(/^gs:\/\//, '').replace(/\/.*$/, '');
      if (_at && _bkt) {
        const _obj    = 'assembled/kie-clips/' + operationName.slice(8).replace(/[^a-zA-Z0-9_-]/g, '') + '.mp4';
        const _gcsUri = await uploadRemoteVideoToGcs(_at, _bkt, _obj, kr.videoUrl);
        const _sa     = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
        const _signed = createSignedUrl(_gcsUri, _sa, 172800);
        try { await saveUserVideo(authUser.id, _gcsUri, kr.mimeType || 'video/mp4', (typeof label === 'string' ? label.slice(0, 120) : null), parseInt(durationSecs, 10) || null); } catch (_) {}
        console.log('poll-veo-clip: Omni clip persisted to GCS →', _gcsUri.slice(0, 80));
        return { statusCode: 200, headers: Object.assign({}, CORS, { 'Content-Type': 'application/json' }),
          body: JSON.stringify({ done: true, videoUrl: _signed, mimeType: kr.mimeType || 'video/mp4', gcsBacked: true }) };
      }
    } catch (e) {
      console.warn('poll-veo-clip: Omni→GCS persist failed, returning kie URL:', e && e.message);
    }
    return { statusCode: 200, headers: Object.assign({}, CORS, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ done: true, videoUrl: kr.videoUrl, mimeType: kr.mimeType || 'video/mp4' }) };
  }

  // kie.ai poll branch - task ids are prefixed "kie:" by generate-veo-clip.
  if (operationName.indexOf('kie:') === 0) {
    const _kie = require('./_kie-veo');
    let kr;
    try { kr = await _kie.poll(operationName.slice(4)); }
    catch (e) {
      return { statusCode: 200, headers: Object.assign({}, CORS, { 'Content-Type': 'application/json' }), body: JSON.stringify({ done: false }) };
    }
    if (!kr.done) {
      return { statusCode: 200, headers: Object.assign({}, CORS, { 'Content-Type': 'application/json' }), body: JSON.stringify({ done: false }) };
    }
    if (kr.error) {
      const _rk = await refundVeoOp(operationName, _op);
      return { statusCode: 200, headers: Object.assign({}, CORS, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ done: true, error: kr.error, filtered: !!kr.filtered, refunded: _rk > 0, refundedCredits: _rk }) };
    }
    await markVeoOpDone(operationName);
    // Persist the finished kie clip to GCS so 1080p upscale + the 1080p reel work (kie URLs expire
    // and aren't GCS). Best-effort: on ANY failure, fall back to returning the raw kie URL, so the
    // clip still plays and exports at 720p exactly as before.
    try {
      const _at  = await getAccessToken(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
      const _bkt = (process.env.GOOGLE_CLOUD_STORAGE_BUCKET || '').replace(/^gs:\/\//, '').replace(/\/.*$/, '');
      if (_at && _bkt) {
        const _obj    = 'assembled/kie-clips/' + operationName.slice(4).replace(/[^a-zA-Z0-9_-]/g, '') + '.mp4';
        const _gcsUri = await uploadRemoteVideoToGcs(_at, _bkt, _obj, kr.videoUrl);
        const _sa     = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
        const _signed = createSignedUrl(_gcsUri, _sa, 172800);
        try { await saveUserVideo(authUser.id, _gcsUri, kr.mimeType || 'video/mp4', (typeof label === 'string' ? label.slice(0, 120) : null), parseInt(durationSecs, 10) || null); } catch (_) {}
        console.log('poll-veo-clip: kie clip persisted to GCS →', _gcsUri.slice(0, 80));
        return { statusCode: 200, headers: Object.assign({}, CORS, { 'Content-Type': 'application/json' }),
          body: JSON.stringify({ done: true, videoUrl: _signed, mimeType: kr.mimeType || 'video/mp4', gcsBacked: true }) };
      }
    } catch (e) {
      console.warn('poll-veo-clip: kie→GCS persist failed, returning kie URL:', e && e.message);
    }
    return { statusCode: 200, headers: Object.assign({}, CORS, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ done: true, videoUrl: kr.videoUrl, mimeType: kr.mimeType || 'video/mp4' }) };
  }

  let accessToken;
  try {
    accessToken = await getAccessToken(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  } catch(e) {
    console.error('poll-veo-clip: getAccessToken failed:', e.message);
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Could not authenticate with generation service.' }) };
  }
  let pollResult;
  try {
    pollResult = await pollOperation(operationName, accessToken);
  } catch(e) {
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Could not reach generation service.' }) };
  }
  const pd = pollResult.data;
  if (!pd || pollResult.status >= 400) {
    const errMsg = (pd && pd.error && pd.error.message) || ('Poll error (HTTP ' + pollResult.status + ')');
    // FIX: 4xx errors (404=op not found, 401/403=auth) are terminal — mark done:true with error
    // so the frontend stops polling rather than looping forever on a dead operation.
    const isTerminal = pollResult.status === 404 || pollResult.status === 403 || pollResult.status === 401;
    const _r4 = isTerminal ? await refundVeoOp(operationName, _op) : 0;
    return { statusCode: 200, headers: Object.assign({}, CORS, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ done: isTerminal, error: errMsg, refunded: _r4 > 0, refundedCredits: _r4 }) };
  }
  if (pd.error) {
    // FIX: Google LRO spec sets done:true when an operation fails with an error field.
    // Returning done:false here caused the frontend to keep polling forever on a terminal
    // Vertex AI error (e.g. quota exceeded, invalid request, model error).
    // Now we respect pd.done — if Vertex marked the op done, we stop polling immediately.
    const _re = pd.done ? await refundVeoOp(operationName, _op) : 0;
    // Veo's input-image likeness / usage-guidelines block (support code 15236754)
    // arrives here as a generic operation error rather than the structured filter
    // response. Flag it as `filtered` so the client runs its soften-and-retry path.
    const _errText = pd.error.message || 'Generation failed on server.';
    const _isFiltered = /15236754|usage guidelines|violat|responsible ai|input image/i.test(_errText);
    return { statusCode: 200, headers: Object.assign({}, CORS, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ done: !!pd.done, error: _errText, filtered: _isFiltered, refunded: _re > 0, refundedCredits: _re }) };
  }
  if (!pd.done) {
    return { statusCode: 200, headers: Object.assign({}, CORS, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ done: false }) };
  }
  // Log the raw Vertex AI response so we can see the actual structure
  const rawStr = JSON.stringify(pd);
  console.log('poll-veo-clip: Vertex done response (first 1200):', rawStr.slice(0, 1200));

  // ── Recursive GCS URI finder ────────────────────────────────────────────────
  // Walks any depth of the response object and returns the first gs:// URI found.
  // This is the nuclear fallback — handles any current or future Vertex AI response shape.
  function findGcsUri(obj, depth) {
    if (!obj || depth > 8) return null;
    if (typeof obj === 'string') return obj.startsWith('gs://') ? obj : null;
    if (Array.isArray(obj)) {
      for (var i = 0; i < obj.length; i++) {
        var r = findGcsUri(obj[i], depth + 1);
        if (r) return r;
      }
      return null;
    }
    if (typeof obj === 'object') {
      // Check common URI key names first for speed
      var priorityKeys = ['gcsUri', 'uri', 'videoUri', 'outputUri', 'resourceUri'];
      for (var k = 0; k < priorityKeys.length; k++) {
        var v = obj[priorityKeys[k]];
        if (v && typeof v === 'string' && v.startsWith('gs://')) return v;
      }
      // Fall through to all keys
      for (var key in obj) {
        var res = findGcsUri(obj[key], depth + 1);
        if (res) return res;
      }
    }
    return null;
  }

  function findMimeType(obj, depth) {
    if (!obj || depth > 8) return null;
    if (typeof obj === 'object' && !Array.isArray(obj)) {
      var mimeKeys = ['mimeType', 'encoding', 'contentType', 'videoMimeType'];
      for (var k = 0; k < mimeKeys.length; k++) {
        var v = obj[mimeKeys[k]];
        if (v && typeof v === 'string' && v.includes('video')) return v;
      }
      for (var key in obj) {
        var r = findMimeType(obj[key], depth + 1);
        if (r) return r;
      }
    } else if (Array.isArray(obj)) {
      for (var i = 0; i < obj.length; i++) {
        var rm = findMimeType(obj[i], depth + 1);
        if (rm) return rm;
      }
    }
    return null;
  }

  // Try all known explicit response structures first, then fall back to recursive search.
  // IMPORTANT: do NOT use || chaining — empty array [] is falsy in JS, so [] || nextPath
  // would skip right over a content-filtered response (generatedSamples: []) and land on null.
  // Use explicit != null checks so empty arrays are preserved as "found".
  var _samplesRaw =
    (pd.response && pd.response.generateVideoResponse && pd.response.generateVideoResponse.generatedSamples != null)
      ? pd.response.generateVideoResponse.generatedSamples
    : (pd.generateVideoResponse && pd.generateVideoResponse.generatedSamples != null)
      ? pd.generateVideoResponse.generatedSamples
    : (pd.response && pd.response.generatedSamples != null)
      ? pd.response.generatedSamples
    : undefined;

  // samplesFound = true means Vertex returned the expected response shape (even if empty array).
  // Empty array = content filter blocked it. undefined = unknown response format.
  var samplesFound = Array.isArray(_samplesRaw);
  var samples = samplesFound ? _samplesRaw : null;

  var raiFilteredCount =
    (pd.response && pd.response.generateVideoResponse && pd.response.generateVideoResponse.raiFilteredCount) ||
    (pd.generateVideoResponse && pd.generateVideoResponse.raiFilteredCount) ||
    (pd.response && pd.response.raiFilteredCount) || 0;

  var videosList =
    (pd.response && pd.response.generateVideoResponse && pd.response.generateVideoResponse.videos) ||
    (pd.generateVideoResponse && pd.generateVideoResponse.videos) ||
    (pd.response && pd.response.videos) ||
    null;

  var allItems = (samples && samples.length) ? samples : (videosList && videosList.length ? videosList : null);

  var gcsUri, mimeType;

  if (allItems && allItems.length) {
    var firstItem = allItems[0];
    gcsUri   = (firstItem && firstItem.video && (firstItem.video.gcsUri || firstItem.video.uri)) ||
               (firstItem && (firstItem.gcsUri || firstItem.uri)) || '';
    mimeType = (firstItem && firstItem.video && (firstItem.video.mimeType || firstItem.video.encoding)) ||
               (firstItem && (firstItem.mimeType || firstItem.encoding)) || 'video/mp4';
  }

  // Nuclear fallback: recursively search the entire response for any gs:// URI
  if (!gcsUri) {
    console.log('poll-veo-clip: known paths failed — trying recursive GCS URI search');
    gcsUri   = findGcsUri(pd, 0) || '';
    mimeType = mimeType || findMimeType(pd, 0) || 'video/mp4';
  }

  if (!gcsUri) {
    var debugInfo = JSON.stringify({ pdKeys: Object.keys(pd), responseKeys: pd.response ? Object.keys(pd.response) : null, raw: rawStr.slice(0, 400) });
    console.error('poll-veo-clip: no GCS URI found. samplesFound=' + samplesFound + ' raiFilteredCount=' + raiFilteredCount + ' debug:', debugInfo);

    // ── Likeness / usage-guidelines block buried in the response ──────────────
    // Veo's input-image person-likeness block (support code 15236754) often arrives
    // NOT as a top-level error and NOT via generatedSamples/raiFilteredCount — the
    // message is nested deep inside the response object. Scan the raw text so we can
    // flag it as `filtered` (→ client runs its soften-and-retry ladder) and surface
    // the real reason instead of the generic "no video" message.
    if (/15236754|usage guidelines|violat|responsible ai/i.test(rawStr)) {
      const _rl = await refundVeoOp(operationName, _op);
      return { statusCode: 200, headers: Object.assign({}, CORS, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ done: true, filtered: true, refunded: _rl > 0, refundedCredits: _rl,
          error: "Veo blocked the start frame as too photoreal a person (code 15236754). Retrying with a softer frame." }) };
    }

    // Recitation / copyright block — Veo refuses to reproduce recognizable copyrighted
    // material (a wall poster, anatomical chart, brand logo, etc.) seen in the start
    // frame. Softening won't help; the FRAME must be regenerated with a generic
    // background. Surface a clear, actionable message (not the generic "no video").
    if (/recitation/i.test(rawStr)) {
      const _rc = await refundVeoOp(operationName, _op);
      return { statusCode: 200, headers: Object.assign({}, CORS, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ done: true, recitation: true, refunded: _rc > 0, refundedCredits: _rc,
          error: "Veo blocked this for copyright (recitation) — the start frame likely contains a recognizable poster, chart, logo, or artwork. Regenerate the frame with a plain/generic background and try again." }) };
    }

    // ── Content filter confirmed ──────────────────────────────────────────────
    // Vertex AI returned the known response structure but generatedSamples is
    // empty (or raiFilteredCount > 0), meaning Google's safety system blocked it.
    // Stop polling immediately — retrying the same prompt will get the same result.
    if (samplesFound || raiFilteredCount > 0) {
      const _rf = await refundVeoOp(operationName, _op); // refund the blocked clip
      return { statusCode: 200, headers: Object.assign({}, CORS, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ done: true, filtered: true, refunded: _rf > 0, refundedCredits: _rf,
          error: "Google's safety filter blocked this scene. Try rewording the scene description — avoid specific people, brand names, or violent/explicit actions." }) };
    }

    // ── Unknown response format ───────────────────────────────────────────────
    // done:true but no video URI anywhere in the response. Vertex AI won't change
    // its answer on re-poll, so stop immediately rather than burning 10 minutes.
    // Surface the real response shape (keys + short raw snippet) to the client so
    // this stops being a black box — many "no video" cases are actually a filtered
    // response in a shape we don't yet detect, or a quota/permission message.
    console.warn('poll-veo-clip: unknown done response — stopping immediately');
    const _ru = await refundVeoOp(operationName, _op);
    var _respShape = {
      pdKeys:       Object.keys(pd || {}),
      responseKeys: pd.response ? Object.keys(pd.response) : null,
      raiFilteredCount: raiFilteredCount,
      samplesFound: samplesFound,
      raw:          rawStr.slice(0, 600),
    };
    return { statusCode: 200, headers: Object.assign({}, CORS, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ done: true, refunded: _ru > 0, refundedCredits: _ru, debug: _respShape,
        error: 'Generation completed but no video was returned. This is usually a content filter or a Vertex AI error — try regenerating this clip.' }) };
  }

  let signedUrl;
  try {
    const sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    // 172800 seconds = 48 hours — matches Vertex AI's 2-day video retention window
    signedUrl = createSignedUrl(gcsUri, sa, 172800);
    console.log('poll-veo-clip: signed URL created (48h) for', gcsUri.slice(0, 80));
  } catch(e) {
    console.error('poll-veo-clip: signed URL failed:', e.message);
    // Signed URL creation failed — refund and return error rather than a useless gs:// URI
    const _rs = await refundVeoOp(operationName, _op);
    return { statusCode: 200, headers: Object.assign({}, CORS, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ done: true, refunded: _rs > 0, refundedCredits: _rs, error: 'Video generated but download link failed: ' + e.message }) };
  }

  // Success — mark the op done so it can never be refunded later.
  await markVeoOpDone(operationName);
  // Auto-save to the user's cloud library (best-effort; stores the gs:// path).
  await saveUserVideo(authUser.id, gcsUri, mimeType, (typeof label === 'string' ? label.slice(0, 120) : null), parseInt(durationSecs, 10) || null);
  return { statusCode: 200, headers: Object.assign({}, CORS, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ done: true, videoUrl: signedUrl, mimeType: mimeType }) };
};