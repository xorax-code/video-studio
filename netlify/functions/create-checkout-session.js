/**
 * Netlify Function: create-checkout-session
 * Creates a Stripe Hosted Checkout session and returns the redirect URL.
 *
 * Required env vars (set in Netlify dashboard -> Environment Variables):
 *   STRIPE_SECRET_KEY      -- sk_live_... or sk_test_...
 *   STRIPE_PRICE_STARTER   -- price_... for $19/mo Starter plan
 *   STRIPE_PRICE_PRO       -- price_... for $49/mo Pro plan
 *   STRIPE_PRICE_AGENCY    -- price_... for $99/mo Agency plan
 *   SUPABASE_URL           -- https://xxx.supabase.co
 *   SUPABASE_ANON_KEY      -- anon key for JWT validation
 */

const https    = require('https');
const qs       = require('querystring');

const APP_URL  = 'https://aiscaling.netlify.app';

// FIX: Added JWT auth — previously this endpoint accepted userId from the request body
// with no authentication, allowing any caller to create checkout sessions attributed
// to an arbitrary user. Now we validate the Supabase JWT and derive userId server-side.
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

function stripePost(path, params, secretKey) {
  const body = qs.stringify(params);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.stripe.com',
      path,
      method: 'POST',
      headers: {
        'Authorization':  'Bearer ' + secretKey,
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json' };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Stripe not configured on server.' }) };
  }

  // Auth: validate JWT — userId comes from the verified token, not the request body
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
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body.' }) }; }

  // Use server-side identity — ignore any client-supplied userId to prevent spoofing
  const { priceId } = body;
  const userId = authUser.id;
  const email  = authUser.email || '';

  if (!priceId) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing priceId.' }) };
  }
  // Whitelist valid price IDs -- prevents clients from passing arbitrary Stripe prices
  const VALID_PRICES = new Set([
    process.env.STRIPE_PRICE_STARTER,
    process.env.STRIPE_PRICE_PRO,
    process.env.STRIPE_PRICE_AGENCY,
  ].filter(Boolean));
  if (!VALID_PRICES.has(priceId)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid priceId.' }) };
  }

  const params = {
    'mode':                      'subscription',
    'line_items[0][price]':      priceId,
    'line_items[0][quantity]':   '1',
    'client_reference_id':       userId,
    'success_url':               APP_URL + '/app?upgraded=1&session_id={CHECKOUT_SESSION_ID}',
    'cancel_url':                APP_URL + '/app',
    'allow_promotion_codes':     'true',
    'subscription_data[metadata][userId]': userId,
  };
  if (email) params['customer_email'] = email;

  try {
    const result = await stripePost('/v1/checkout/sessions', params, secretKey);
    if (result.data.error) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: result.data.error.message }) };
    }
    return { statusCode: 200, headers, body: JSON.stringify({ url: result.data.url }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Proxy error: ' + err.message }) };
  }
};
