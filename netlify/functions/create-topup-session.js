/**
 * Netlify Function: create-topup-session
 * Creates a Stripe Checkout session (one-time payment) for credit top-up packs.
 *
 * Required env vars:
 *   STRIPE_SECRET_KEY          — sk_live_... or sk_test_...
 *   STRIPE_TOPUP_BOOST         — price_... for 500 credits / $5
 *   STRIPE_TOPUP_STANDARD      — price_... for 2,000 credits / $18
 *   STRIPE_TOPUP_PRO_PACK      — price_... for 5,000 credits / $40
 *   STRIPE_TOPUP_ULTRA         — price_... for 10,000 credits / $75
 *   SUPABASE_URL               — https://xxx.supabase.co
 *   SUPABASE_ANON_KEY          — anon key for JWT validation
 *
 * POST body (JSON):
 *   { packId: 'boost' | 'standard' | 'pro_pack' | 'ultra' }
 *
 * Authorization header: Bearer <supabase_jwt>
 */

const https    = require('https');
const qs       = require('querystring');

const APP_URL = 'https://aiscaling.netlify.app';

// ── Top-up pack definitions ───────────────────────────────────────────────────
// priceId comes from env vars — set in Netlify dashboard after creating in Stripe
const TOPUP_PACKS = {
  boost:    { credits: 500,   label: 'Boost — 500 Credits',         envKey: 'STRIPE_TOPUP_BOOST'    },
  standard: { credits: 2000,  label: 'Standard — 2,000 Credits',    envKey: 'STRIPE_TOPUP_STANDARD' },
  pro_pack: { credits: 5000,  label: 'Pro Pack — 5,000 Credits',    envKey: 'STRIPE_TOPUP_PRO_PACK' },
  ultra:    { credits: 10000, label: 'Ultra — 10,000 Credits',      envKey: 'STRIPE_TOPUP_ULTRA'    },
};

// ── Stripe POST helper ────────────────────────────────────────────────────────
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

// ── JWT validation ────────────────────────────────────────────────────────────
async function getAuthUser(jwt) {
  return new Promise((resolve) => {
    const url = new URL(`${process.env.SUPABASE_URL}/auth/v1/user`);
    const req = https.request({
      hostname: url.hostname,
      path:     url.pathname,
      method:   'GET',
      headers: {
        'Authorization': `Bearer ${jwt}`,
        'apikey':        process.env.SUPABASE_ANON || '',
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

// ── Main handler ──────────────────────────────────────────────────────────────
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

  if (!process.env.STRIPE_SECRET_KEY || !process.env.SUPABASE_URL) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Server configuration error.' }) };
  }

  // ── Auth ───────────────────────────────────────────────────────────────────
  const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
  const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!jwt) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Authentication required.' }) };
  }
  const user = await getAuthUser(jwt);
  if (!user) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Invalid or expired session.' }) };
  }

  // ── Parse body ─────────────────────────────────────────────────────────────
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON.' }) }; }

  const { packId } = body;
  const pack = TOPUP_PACKS[packId];
  if (!pack) {
    return {
      statusCode: 400,
      headers: CORS,
      body: JSON.stringify({ error: `Unknown pack: ${packId}. Valid packs: ${Object.keys(TOPUP_PACKS).join(', ')}` }),
    };
  }

  const priceId = process.env[pack.envKey];
  if (!priceId) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: `Top-up pricing not configured for ${packId}. Contact support.` }),
    };
  }

  // ── Create Stripe Checkout session ────────────────────────────────────────
  let session;
  try {
    const result = await stripePost('/v1/checkout/sessions', {
      mode:                         'payment',
      'line_items[0][price]':       priceId,
      'line_items[0][quantity]':    1,
      success_url:                  `${APP_URL}/app?credits_added=1&pack=${packId}`,
      cancel_url:                   `${APP_URL}/app`,
      client_reference_id:          user.id,
      customer_email:               user.email || '',
      // Pack metadata so the webhook knows how many credits to add
      'metadata[user_id]':          user.id,
      'metadata[pack_id]':          packId,
      'metadata[credits]':          String(pack.credits),
      'payment_intent_data[metadata][user_id]':  user.id,
      'payment_intent_data[metadata][pack_id]':  packId,
      'payment_intent_data[metadata][credits]':  String(pack.credits),
    }, process.env.STRIPE_SECRET_KEY);

    if (result.status !== 200 || !result.data?.url) {
      console.error('create-topup-session: Stripe error', result.data);
      return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: 'Could not create checkout session.' }) };
    }

    session = result.data;
  } catch (e) {
    console.error('create-topup-session: error', e.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Checkout error. Please try again.' }) };
  }

  console.log(`create-topup-session: user ${user.id} → ${packId} (${pack.credits} credits), session ${session.id}`);

  return {
    statusCode: 200,
    headers: { ...CORS, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      checkoutUrl: session.url,
      sessionId:   session.id,
      pack:        { id: packId, credits: pack.credits, label: pack.label },
    }),
  };
};
