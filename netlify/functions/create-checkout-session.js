/**
 * Netlify Function: create-checkout-session
 * Creates a Stripe Hosted Checkout session and returns the redirect URL.
 *
 * Required env vars (set in Netlify dashboard → Environment Variables):
 *   STRIPE_SECRET_KEY      — sk_live_... or sk_test_...
 *   STRIPE_PRICE_STARTER   — price_... for $19/mo Starter plan
 *   STRIPE_PRICE_PRO       — price_... for $49/mo Pro plan
 *   STRIPE_PRICE_AGENCY    — price_... for $99/mo Agency plan
 */

const https    = require('https');
const qs       = require('querystring');

const APP_URL  = 'https://aiscaling.netlify.app';

function stripePost(path, params, secretKey) {
  const body = qs.stringify(params);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.stripe.com',
      path,
      method: 'POST',
      headers: {
        'Authorization':  `Bearer ${secretKey}`,
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

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body.' }) }; }

  const { priceId, userId, email } = body;
  if (!priceId || !userId) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing priceId or userId.' }) };
  }
  // Whitelist valid price IDs — prevents clients from passing arbitrary Stripe prices
  const VALID_PRICES = new Set([
    process.env.STRIPE_PRICE_STARTER,
    process.env.STRIPE_PRICE_PRO,
    process.env.STRIPE_PRICE_AGENCY,
  ].filter(Boolean));
  if (!VALID_PRICES.has(priceId)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid priceId.' }) };
  }
  if (typeof userId !== 'string' || userId.length > 500) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid userId.' }) };
  }

  const params = {
    'mode':                      'subscription',
    'line_items[0][price]':      priceId,
    'line_items[0][quantity]':   '1',
    'client_reference_id':       userId,
    'success_url':               `${APP_URL}/app?upgraded=1&session_id={CHECKOUT_SESSION_ID}`,
    'cancel_url':                `${APP_URL}/app`,
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
