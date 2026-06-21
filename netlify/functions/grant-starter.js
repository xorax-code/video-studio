/**
 * Netlify Function: grant-starter
 * --------------------------------
 * One-time "starter credits" grant so a new free user can finish ONE full video
 * before hitting a paywall (the reverse-trial pattern). Idempotent: it sets an
 * app_metadata flag `starter_granted` so a user can only ever receive the grant
 * ONCE, no matter how many times the frontend calls this on load.
 *
 * Credits are merged into app_metadata (GoTrue admin update merges top-level keys),
 * so existing credits_balance / producer_playbook are preserved.
 *
 * Required env vars (already set):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON (or SUPABASE_ANON_KEY)
 *
 * POST, Authorization: Bearer <supabase_jwt>
 * Response: { granted: bool, already?: bool, balance: number, added?: number }
 */

const https = require('https');

// ── TUNE ME ─────────────────────────────────────────────────────────────────
// Enough to finish one short video: ~5 start frames (×2 = 10) + ~5 Lite clips
// (×15 = 75) ≈ 85, with margin. Raise toward ~160 to cover a Fast-quality video.
const STARTER_CREDITS = 120;

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

    const admin = await getAdminUser(user.id);
    if (!admin) return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Could not read account data.' }) };
    const meta = admin.app_metadata || {};
    const balance = meta.credits_balance ?? 0;

    // Idempotent: already granted → no-op.
    if (meta.starter_granted) {
      return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ granted: false, already: true, balance }) };
    }

    const newBalance = balance + STARTER_CREDITS;
    const ok = await updateUserMeta(user.id, { credits_balance: newBalance, starter_granted: true });
    if (!ok) {
      console.error(`grant-starter: failed to grant for user ${user.id}`);
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Could not grant starter credits.' }) };
    }
    console.log(`grant-starter: +${STARTER_CREDITS} → ${newBalance} for user ${user.id}`);
    return { statusCode: 200, headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ granted: true, added: STARTER_CREDITS, balance: newBalance }) };

  } catch (topErr) {
    console.error('grant-starter: unhandled exception:', topErr.message, topErr.stack);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Internal error: ' + topErr.message }) };
  }
};
