/**
 * list-user-videos — returns the authenticated user's cloud video library.
 *
 * Each row stores a gs:// object path (written by poll-veo-clip on success).
 * Signed URLs expire, so we re-sign a fresh V4 URL for every object on each read.
 *
 * POST  Authorization: Bearer <supabase jwt>
 * →  { videos: [ { id, url, mime, label, duration, created_at } ] }
 */
const https  = require('https');
const crypto = require('crypto');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// V4 signed GCS URL (same scheme as poll-veo-clip / poll-upscale).
function createSignedUrl(gcsUri, sa, expiresInSeconds) {
  const exp   = expiresInSeconds || 3600;
  const match = gcsUri.match(/^gs:\/\/([^/]+)\/(.+)$/);
  if (!match) throw new Error('Invalid GCS URI: ' + gcsUri);
  const bucket = match[1];
  const object = match[2];
  const now      = new Date();
  const dateStr  = now.toISOString().slice(0, 10).replace(/-/g, '');
  const timeStr  = now.toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
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
  const stringToSign  = ['GOOG4-RSA-SHA256', timeStr, credentialScope, canonicalHash].join('\n');
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(stringToSign);
  const signature = signer.sign(sa.private_key, 'hex');
  return 'https://storage.googleapis.com/' + bucket + '/' + encodedObject + '?' + queryParams + '&X-Goog-Signature=' + signature;
}

// Validate the Supabase JWT → returns the user object (with .id) or null.
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

// Service-role REST read (bypasses RLS).
function sbAdmin(path) {
  const svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return new Promise((resolve) => {
    const url = new URL(process.env.SUPABASE_URL + '/rest/v1/' + path);
    const req = https.request({
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   'GET',
      headers:  { 'apikey': svc, 'Authorization': 'Bearer ' + svc },
    }, (res) => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString() || 'null') }); } catch { resolve({ status: res.statusCode, data: null }); } });
    });
    req.on('error', () => resolve({ status: 0, data: null }));
    req.end();
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')   return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Server configuration error.' }) };
  }

  const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
  const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!jwt) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Missing authorization token.' }) };
  const authUser = await validateJwt(jwt);
  if (!authUser) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Invalid or expired session.' }) };

  // Optional paging — default newest 60.
  let limit = 60;
  try { const b = JSON.parse(event.body || '{}'); if (b.limit) limit = Math.max(1, Math.min(200, parseInt(b.limit, 10) || 60)); } catch (_) {}

  // Scope strictly to this user's rows (defense in depth on top of service-role).
  const q = 'user_videos?user_id=eq.' + encodeURIComponent(authUser.id)
          + '&select=id,gcs_uri,mime,label,duration,created_at'
          + '&order=created_at.desc&limit=' + limit;
  const r = await sbAdmin(q);
  if (r.status !== 200 || !Array.isArray(r.data)) {
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Could not load your library.' }) };
  }

  let sa;
  try { sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON); }
  catch { return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Server configuration error.' }) }; }

  const videos = [];
  for (const row of r.data) {
    let url = null;
    try { url = createSignedUrl(row.gcs_uri, sa, 21600); } // 6h fresh link
    catch (e) { /* skip un-signable rows (e.g. expired GCS object) */ continue; }
    videos.push({
      id:         row.id,
      url:        url,
      mime:       row.mime || 'video/mp4',
      label:      row.label || null,
      duration:   row.duration || null,
      created_at: row.created_at,
    });
  }

  return { statusCode: 200, headers: Object.assign({}, CORS, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ videos }) };
};
