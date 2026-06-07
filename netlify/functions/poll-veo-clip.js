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

// OAuth2: service account -> access token
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
          resolve(res.statusCode === 200 && !!data.id);
        } catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.end();
  });
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
  const valid = await validateJwt(jwt);
  if (!valid) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Invalid or expired session.' }) };
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON.' }) }; }
  const { operationName } = body;
  if (!operationName || typeof operationName !== 'string') {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'operationName is required.' }) };
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
    return { statusCode: 200, headers: Object.assign({}, CORS, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ done: isTerminal, error: errMsg }) };
  }
  if (pd.error) {
    // FIX: Google LRO spec sets done:true when an operation fails with an error field.
    // Returning done:false here caused the frontend to keep polling forever on a terminal
    // Vertex AI error (e.g. quota exceeded, invalid request, model error).
    // Now we respect pd.done — if Vertex marked the op done, we stop polling immediately.
    return { statusCode: 200, headers: Object.assign({}, CORS, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ done: !!pd.done, error: pd.error.message || 'Generation failed on server.' }) };
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

    // ── Content filter confirmed ──────────────────────────────────────────────
    // Vertex AI returned the known response structure but generatedSamples is
    // empty (or raiFilteredCount > 0), meaning Google's safety system blocked it.
    // Stop polling immediately — retrying the same prompt will get the same result.
    if (samplesFound || raiFilteredCount > 0) {
      return { statusCode: 200, headers: Object.assign({}, CORS, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ done: true, filtered: true,
          error: "Google's safety filter blocked this scene. Try rewording the scene description — avoid specific people, brand names, or violent/explicit actions." }) };
    }

    // ── Unknown response format ───────────────────────────────────────────────
    // done:true but no video URI anywhere in the response. Vertex AI won't change
    // its answer on re-poll, so stop immediately rather than burning 10 minutes.
    console.warn('poll-veo-clip: unknown done response — stopping immediately');
    return { statusCode: 200, headers: Object.assign({}, CORS, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ done: true,
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
    // Signed URL creation failed — return error rather than a useless gs:// URI
    return { statusCode: 200, headers: Object.assign({}, CORS, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ done: true, error: 'Video generated but download link failed: ' + e.message }) };
  }

  return { statusCode: 200, headers: Object.assign({}, CORS, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ done: true, videoUrl: signedUrl, mime: mimeType }) };
};