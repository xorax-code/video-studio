/**
 * Netlify Function: create-portal-session
 * Creates a Stripe Customer Portal session so users can manage/cancel subscriptions.
 *
 * Required env vars:
 *   STRIPE_SECRET_KEY — sk_live_... or sk_test_...
 *
 * NOTE: You must enable the Customer Portal in your Stripe dashboard first:
 *   Stripe Dashboard → Settings → Billing → Customer portal → Activate
 */

const https = require('https');
const qs    = require('querystring');

const APP_URL = 'https://aiscaling.netlify.app';

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
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON.' }) }; }

  const { customerId } = body;
  if (!customerId) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing customerId.' }) };
  }

  const formBody = qs.stringify({
    customer:   customerId,
    return_url: `${APP_URL}/app`,
  });

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.stripe.com',
      path:     '/v1/billing_portal/sessions',
      method:   'POST',
      headers: {
        'Authorization':  `Bearer ${secretKey}`,
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(formBody),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const data = JSON.parse(Buffer.concat(chunks).toString());
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
