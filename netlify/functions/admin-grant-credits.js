/**
 * Netlify Function: admin-grant-credits
 * -------------------------------------
 * Owner-only credit top-up for testing on dev. Adds credits to the CALLER's own
 * account, but ONLY if the authenticated user's email is in the admin allowlist.
 * This is the security boundary — the frontend button is just UX; the email check
 * here is what actually gates it.
 *
 * Configure admins via env var ADMIN_EMAILS (comma-separated). Falls back to the
 * owner's email so it works out of the box on dev.
 *
 * Required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON (or _KEY)
 * POST, Authorization: Bearer <jwt>, body: { amount?: number }
 * Response: { balance, added }  |  { error }
 */

const https = require('https');

const ADMIN_DEFAULT = '2004tjg00@gmail.com';
const DEFAULT_GRANT = 10000;
const MAX_GRANT     = 1000000;

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

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

async function getAuthUser(jwt) {
  const url = new URL(`${process.env.SUPABASE_URL}/auth/v1/user`);
  const r = await httpsRequest({
    hostname: url.hostname, path: url.pathname, method: 'GET',
    headers: { 'Authorization': `Bearer ${jwt}`, 'apikey': process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_ANON },
  });
  if (r.status !== 200 || !r.data?.id) return null;
  return r.data;
}

async function getAdminUser(userId) {
  const url = new URL(`${process.env.SUPABASE_URL}/auth/v1/admin/users/${userId}`);
  const k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const r = await httpsRequest({ hostname: url.hostname, path: url.pathname, method: 'GET',
    headers: { 'Authorization': `Bearer ${k}`, 'apikey': k } });
  return r.status === 200 ? r.data : null;
}

async function updateUserMeta(userId, meta) {
  const url = new URL(`${process.env.SUPABASE_URL}/auth/v1/admin/users/${userId}`);
  const k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const b = JSON.stringify({ app_metadata: meta });
  const r = await httpsRequest({ hostname: url.hostname, path: url.pathname, method: 'PUT',
    headers: { 'Authorization': `Bearer ${k}`, 'apikey': k, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) } }, b);
  return r.status === 200;
}

function isAdmin(email) {
  if (!email) return false;
  const list = (process.env.ADMIN_EMAILS || ADMIN_DEFAULT)
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return list.includes(email.toLowerCase());
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
    if (event.httpMethod !== 'POST')
      return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY)
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Supabase admin not configured.' }) };

    const authHeader = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
    const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    if (!jwt) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Missing authorization token.' }) };

    let user;
    try { user = await getAuthUser(jwt); }
    catch (e) { return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Auth check failed: ' + e.message }) }; }
    if (!user) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Invalid or expired session.' }) };

    // The gate: caller must be an allowlisted admin email.
    if (!isAdmin(user.email)) {
      console.warn(`admin-grant-credits: DENIED for ${user.email}`);
      return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Not authorized.' }) };
    }

    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch (_) {}
    let amount = Math.floor(Number(body.amount) || DEFAULT_GRANT);
    if (!isFinite(amount) || amount < 1) amount = DEFAULT_GRANT;
    if (amount > MAX_GRANT) amount = MAX_GRANT;

    const admin = await getAdminUser(user.id);
    if (!admin) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Could not read account data.' }) };
    const balance = admin.app_metadata?.credits_balance ?? 0;
    const newBalance = balance + amount;

    const ok = await updateUserMeta(user.id, { credits_balance: newBalance });
    if (!ok) return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Could not update balance.' }) };
    console.log(`admin-grant-credits: ${user.email} +${amount} → ${newBalance}`);
    return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ balance: newBalance, added: amount }) };

  } catch (topErr) {
    console.error('admin-grant-credits: unhandled exception:', topErr.message, topErr.stack);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Internal error: ' + topErr.message }) };
  }
};
