/**
 * Netlify Function: stripe-webhook
 * Receives Stripe events and syncs subscription tier to Supabase user app_metadata.
 *
 * Required env vars:
 *   STRIPE_SECRET_KEY          — sk_live_... or sk_test_...
 *   STRIPE_WEBHOOK_SECRET      — whsec_... (from Stripe Dashboard → Webhooks)
 *   STRIPE_PRICE_STARTER       — price_... for $19/mo
 *   STRIPE_PRICE_PRO           — price_... for $49/mo
 *   STRIPE_PRICE_AGENCY        — price_... for $99/mo
 *   SUPABASE_URL               — https://xxx.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY  — service_role JWT from Supabase → Settings → API
 *
 * Stripe events handled:
 *   checkout.session.completed       → set tier on first payment
 *   customer.subscription.updated    → plan change / reactivation
 *   customer.subscription.deleted    → cancellation → reset to free
 *   invoice.payment_failed           → (logged, no downgrade on first failure)
 */

const https  = require('https');
const crypto = require('crypto');
const qs     = require('querystring');

// ── Signature verification ──────────────────────────────────────────────────
function verifyStripeSignature(rawBody, sigHeader, secret) {
  const parts = {};
  sigHeader.split(',').forEach(p => { const [k, ...rest] = p.split('='); parts[k] = rest.join('='); });
  if (!parts.t || !parts.v1) return false;
  // Replay attack protection: reject webhooks older than 5 minutes
  const tolerance = 300;
  const ts = parseInt(parts.t, 10);
  if (isNaN(ts) || Math.abs(Date.now() / 1000 - ts) > tolerance) return false;
  const payload  = `${parts.t}.${rawBody}`;
  const expected = crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
  try {
    const _a = Buffer.from(expected), _b = Buffer.from(parts.v1);
    if (_a.length !== _b.length) return false;
    return crypto.timingSafeEqual(_a, _b);
  } catch { return false; }
}

// ── Tier mapping ─────────────────────────────────────────────────────────────
function tierFromPriceId(priceId) {
  if (!priceId) return 'starter';
  if (priceId === process.env.STRIPE_PRICE_AGENCY)  return 'agency';
  if (priceId === process.env.STRIPE_PRICE_PRO)     return 'pro';
  if (priceId === process.env.STRIPE_PRICE_STARTER) return 'starter';
  return 'starter'; // default to starter for any unrecognised paid price
}

// ── Stripe helper: GET ───────────────────────────────────────────────────────
function stripeGet(path) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.stripe.com',
      path,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}` },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) { resolve(null); return; }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

// ── Supabase: update user app_metadata ──────────────────────────────────────
async function updateUserMeta(userId, meta) {
  const url      = new URL(`${process.env.SUPABASE_URL}/auth/v1/admin/users/${userId}`);
  const body     = JSON.stringify({ app_metadata: meta });
  const svcKey   = process.env.SUPABASE_SERVICE_ROLE_KEY;

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   'PATCH',
      headers: {
        'Authorization': `Bearer ${svcKey}`,
        'apikey':        svcKey,
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Supabase: find userId by stripe_customer_id in app_metadata ─────────────
// Paginates through all users (1000 per page) so no one is missed.
async function findUserByCustomerId(customerId) {
  const svcKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const baseUrl = process.env.SUPABASE_URL;

  function fetchPage(page) {
    return new Promise((resolve) => {
      const url = new URL(`${baseUrl}/auth/v1/admin/users?per_page=1000&page=${page}`);
      const req = https.request({
        hostname: url.hostname,
        path:     url.pathname + url.search,
        method:   'GET',
        headers: {
          'Authorization': `Bearer ${svcKey}`,
          'apikey':        svcKey,
        },
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
          catch { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.end();
    });
  }

  let page = 1;
  const MAX_PAGES = 20;
  while (page <= MAX_PAGES) {
    const result = await fetchPage(page);
    if (!result) return null;
    const users = Array.isArray(result?.users) ? result.users : [];
    const found = users.find(u => u.app_metadata?.stripe_customer_id === customerId);
    if (found) return found.id;
    // If fewer than 1000 returned, we've exhausted all pages
    if (users.length < 1000) return null;
    page++;
  }
}

// ── Main handler ─────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return { statusCode: 500, body: 'Webhook secret not configured.' };
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('stripe-webhook: Supabase env vars missing');
    return { statusCode: 500, body: 'Server configuration error.' };
  }

  const sigHeader = event.headers['stripe-signature'] || '';
  const rawBody   = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : (event.body || '');

  if (!verifyStripeSignature(rawBody, sigHeader, webhookSecret)) {
    console.error('Stripe webhook: invalid signature');
    return { statusCode: 400, body: 'Invalid signature.' };
  }

  let stripeEvent;
  try { stripeEvent = JSON.parse(rawBody); }
  catch { return { statusCode: 400, body: 'Invalid JSON.' }; }

  console.log('Stripe event:', stripeEvent.type);

  try {
    switch (stripeEvent.type) {

      // ── New subscription / first payment ──────────────────────────────────
      case 'checkout.session.completed': {
        const session = stripeEvent.data.object;
        const userId  = session.client_reference_id;
        if (!userId) { console.warn('No client_reference_id on session'); break; }

        const customerId     = session.customer;
        const subscriptionId = session.subscription;

        // Fetch subscription to get price ID → tier
        let tier = 'starter';
        if (subscriptionId) {
          const sub    = await stripeGet(`/v1/subscriptions/${subscriptionId}`);
          if (!sub) { console.error(`stripe-webhook: failed to fetch sub ${subscriptionId}`); break; }
          const priceId = sub?.items?.data?.[0]?.price?.id;
          tier = tierFromPriceId(priceId);
        }

        await updateUserMeta(userId, {
          stripe_tier:            tier,
          stripe_customer_id:     customerId,
          stripe_subscription_id: subscriptionId,
        });
        console.log(`User ${userId} upgraded to ${tier}`);
        break;
      }

      // ── Plan change or reactivation ───────────────────────────────────────
      case 'customer.subscription.updated': {
        const sub        = stripeEvent.data.object;
        const customerId = sub.customer;
        const priceId    = sub.items?.data?.[0]?.price?.id;
        // Keep users on paid tier while past_due or trialing — only downgrade on terminal states
        const PAID_STATUSES = new Set(['active', 'trialing', 'past_due']);
        const tier = PAID_STATUSES.has(sub.status) ? (tierFromPriceId(priceId) || 'free') : 'free';

        const userId = await findUserByCustomerId(customerId);
        if (userId) {
          await updateUserMeta(userId, { stripe_tier: tier, stripe_subscription_id: sub.id });
          console.log(`User ${userId} plan updated to ${tier}`);
        }
        break;
      }

      // ── Cancellation ──────────────────────────────────────────────────────
      case 'customer.subscription.deleted': {
        const customerId = stripeEvent.data.object.customer;
        const userId     = await findUserByCustomerId(customerId);
        if (userId) {
          await updateUserMeta(userId, { stripe_tier: 'free' });
          console.log(`User ${userId} downgraded to free (subscription cancelled)`);
        }
        break;
      }

      // ── New subscription created (fires before checkout.session.completed) ──
      // Use this as a fallback in case checkout.session.completed lacks client_reference_id
      case 'customer.subscription.created': {
        const sub        = stripeEvent.data.object;
        const customerId = sub.customer;
        const priceId    = sub.items?.data?.[0]?.price?.id;
        const PAID_STATUSES = new Set(['active', 'trialing', 'past_due']);
        const tier = PAID_STATUSES.has(sub.status) ? (tierFromPriceId(priceId) || 'starter') : 'free';

        const userId = await findUserByCustomerId(customerId);
        if (userId) {
          await updateUserMeta(userId, {
            stripe_tier:            tier,
            stripe_subscription_id: sub.id,
          });
          console.log(`User ${userId} subscription created → ${tier}`);
        } else {
          // userId not in Supabase yet — checkout.session.completed will handle it via client_reference_id
          console.log(`subscription.created: no Supabase user found for customer ${customerId} — will be set by checkout.session.completed`);
        }
        break;
      }

      // ── Successful payment (initial + every renewal) ──────────────────────
      case 'invoice.payment_succeeded': {
        const invoice        = stripeEvent.data.object;
        const customerId     = invoice.customer;
        const subscriptionId = invoice.subscription;
        if (!subscriptionId) break; // one-off charge, not a subscription

        // Fetch the subscription to get current price → tier
        const sub     = await stripeGet(`/v1/subscriptions/${subscriptionId}`);
        if (!sub) { console.error(`stripe-webhook: failed to fetch sub ${subscriptionId} on payment`); break; }
        const priceId = sub?.items?.data?.[0]?.price?.id;
        const tier    = tierFromPriceId(priceId) || 'starter';

        const userId = await findUserByCustomerId(customerId);
        if (userId) {
          await updateUserMeta(userId, { stripe_tier: tier });
          console.log(`User ${userId} payment succeeded → tier confirmed as ${tier}`);
        }
        break;
      }

      // ── Payment failure — log only, don't immediately downgrade ───────────
      case 'invoice.payment_failed': {
        const invoice = stripeEvent.data.object;
        console.warn(`Payment failed for customer ${invoice.customer}, attempt ${invoice.attempt_count}`);
        // Stripe will retry automatically. After all retries fail, it fires
        // customer.subscription.deleted which will downgrade the user.
        break;
      }

      default:
        console.log(`Unhandled event type: ${stripeEvent.type}`);
    }

    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  } catch (err) {
    console.error('Webhook handler error:', err);
    return { statusCode: 500, body: 'Handler error: ' + err.message };
  }
};
