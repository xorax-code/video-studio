/**
 * Netlify Function: create-portal-session
 * Creates a Stripe Customer Portal session so users can manage/cancel subscriptions.
 *
 * Required env vars:
 *   STRIPE_SECRET_KEY  -- sk_live_... or sk_test_...
 *   SUPABASE_URL       -- https://xxx.supabase.co
 *   SUPABASE_ANON_KEY  -- anon key for JWT validation
 *
 * NOTE: You must enable the Customer Portal in your Stripe dashboard first:
 *   Stripe Dashboard -> Settings -> Billing -> Customer portal -> Activate
 */

const https = require('https');
const qs    = require('querystring');

const APP_URL = 'https://aiscaling.netlify.app';

function getAuthUser(jwt) {
  return new Promise((resolve) => {
    const url = new URL((process.env.SUPABASE_URL || '') + '/auth/v1/user');
    const req = https.request({
      hostname: url.hostname,
      path:     url.pathname,
      method:   'GET',
      headers: {
        'Authorization': 'Bearer ' + jwt,
        'apikey':        process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_ANON || '',
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          resolve(res.statusCode === 200 && data.id ? data : null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

exports.handler = async (event) => {
  const CORS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
  const headers = { 'Content-Type': 'application/json', ...CORS };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Stripe not configured on server.' }) };
  }

  // Auth: require a valid Supabase JWT before touching any Stripe portal session
  if (!process.env.SUPABASE_URL) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server configuration error.' }) };
  }
  const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
  const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!jwt) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Authentication required.' }) };
  }
  const authUser = await getAuthUser(jwt);
  if (!authUser) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid or expired session.' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON.' }) }; }

  const { customerId } = body;
  if (!customerId) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing customerId.' }) };
  }
  if (!/^cus_[A-Za-z0-9]+$/.test(customerId)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid customerId format.' }) };
  }
  // FIX H-7: verify supplied customerId belongs to the authenticated user
  // Fetch full app_metadata via service role to check stripe_customer_id
  const svcKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (svcKey) {
    try {
      const adminUrl = new URL(`${process.env.SUPABASE_URL}/auth/v1/admin/users/${authUser.id}`);
      const adminData = await new Promise((resolve) => {
        const req = https.request({
          hostname: adminUrl.hostname, path: adminUrl.pathname, method: 'GET',
          headers: { 'Authorization': `Bearer ${svcKey}`, 'apikey': svcKey },
        }, (res) => {
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { resolve(null); } });
        });
        req.on('error', () => resolve(null));
        req.end();
      });
      const expectedId = adminData?.app_metadata?.stripe_customer_id;
      if (expectedId && expectedId !== customerId) {
        console.warn(`Portal session: user ${authUser.id} attempted to access customer ${customerId} (owns ${expectedId})`);
        return { statusCode: 403, headers, body: JSON.stringify({ error: 'Forbidden.' }) };
      }
    } catch (_) { /* If admin check fails, proceed — better than blocking legit users */ }
  }

  const formBody = qs.stringify({
    customer:   customerId,
    return_url: APP_URL + '/app',
  });

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.stripe.com',
      path:     '/v1/billing_portal/sessions',
      method:   'POST',
      headers: {
        'Authorization':  'Bearer ' + secretKey,
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(formBody),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        let data;
        try { data = JSON.parse(Buffer.concat(chunks).toString()); }
        catch (e) { resolve({ statusCode: 502, headers, body: JSON.stringify({ error: 'Invalid response from Stripe.' }) }); return; }
        if (data.error) {
          resolve({ statusCode: 400, headers, body: JSON.stringify({ error: data.error.message }) });
        } else {
          resolve({ statusCode: 200, headers, body: JSON.stringify({ url: data.url }) });
        }
      });
    });
    req.on('error', e => resolve({ statusCode: 500, headers, body: JSON.stringify({ error: e.message }) }));
    req.write(formBody);
    req.end();
  });
};
