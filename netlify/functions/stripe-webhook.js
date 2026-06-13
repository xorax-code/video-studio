/**
 * Netlify Function: stripe-webhook
 * Receives Stripe events and syncs subscription tier + credits to Supabase user app_metadata.
 *
 * Required env vars:
 *   STRIPE_SECRET_KEY          -- sk_live_... or sk_test_...
 *   STRIPE_WEBHOOK_SECRET      -- whsec_... (from Stripe Dashboard -> Webhooks)
 *   STRIPE_PRICE_STARTER       -- price_... for Starter plan
 *   STRIPE_PRICE_PRO           -- price_... for Pro plan
 *   STRIPE_PRICE_AGENCY        -- price_... for Agency plan
 *   SUPABASE_URL               -- https://xxx.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY  -- service_role JWT from Supabase -> Settings -> API
 *
 * Stripe events handled:
 *   checkout.session.completed (subscription) -> set tier + allocate monthly credits
 *   checkout.session.completed (payment)       -> add top-up credits
 *   customer.subscription.updated             -> plan change / reactivation
 *   customer.subscription.deleted             -> cancellation -> reset to free
 *   invoice.payment_succeeded (subscription)  -> monthly renewal -> add plan credits
 *   invoice.payment_failed                    -> (logged, no downgrade on first failure)
 */

// Monthly credits per plan (reset each cycle; purchased top-ups are preserved separately)
const PLAN_MONTHLY_CREDITS = {
  free:    50,
  starter: 1000,
  creator: 2500,
  scale:   6500,
  // legacy aliases (old tier names) -> map to current grants
  pro:     2500,
  agency:  6500,
};

const https  = require('https');
const crypto = require('crypto');
const qs     = require('querystring');

// Signature verification
function verifyStripeSignature(rawBody, sigHeader, secret) {
  const parts = {};
  sigHeader.split(',').forEach(p => { const [k, ...rest] = p.split('='); parts[k] = rest.join('='); });
  if (!parts.t || !parts.v1) return false;
  // Replay attack protection: reject webhooks older than 5 minutes
  const tolerance = 300;
  const ts = parseInt(parts.t, 10);
  if (isNaN(ts) || Math.abs(Date.now() / 1000 - ts) > tolerance) return false;
  const payload  = parts.t + '.' + rawBody;
  const expected = crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
  try {
    const _a = Buffer.from(expected);
    const _b = Buffer.from(parts.v1);
    if (_a.length !== _b.length) return false;
    return crypto.timingSafeEqual(_a, _b);
  } catch { return false; }
}

// Tier mapping (legacy env-var fallback; only used if a price has no `plan` metadata)
function tierFromPriceId(priceId) {
  if (!priceId) return 'starter';
  // Hardcoded public price IDs (no secrets) so this works without env vars —
  // the 9 Stripe env vars were exceeding AWS Lambda's 4KB limit and breaking deploys.
  var _PRICE_MAP = {
    'price_1ThbCQJEBUETI2v8B0RUf3Hc': 'starter', 'price_1ThbCzJEBUETI2v8yY6LXCoE': 'starter',
    'price_1ThbDVJEBUETI2v808FvsWXp': 'creator', 'price_1ThbDqJEBUETI2v8FNG7EGpO': 'creator',
    'price_1ThbEGJEBUETI2v832pxuu1R': 'scale',   'price_1ThbEdJEBUETI2v8GlEC4v0k': 'scale',
  };
  if (_PRICE_MAP[priceId]) return _PRICE_MAP[priceId];
  if (priceId === process.env.STRIPE_PRICE_SCALE)          return 'scale';
  if (priceId === process.env.STRIPE_PRICE_CREATOR)        return 'creator';
  if (priceId === process.env.STRIPE_PRICE_STARTER)        return 'starter';
  // annual prices
  if (priceId === process.env.STRIPE_PRICE_SCALE_ANNUAL)   return 'scale';
  if (priceId === process.env.STRIPE_PRICE_CREATOR_ANNUAL) return 'creator';
  if (priceId === process.env.STRIPE_PRICE_STARTER_ANNUAL) return 'starter';
  // legacy names
  if (priceId === process.env.STRIPE_PRICE_AGENCY)  return 'scale';
  if (priceId === process.env.STRIPE_PRICE_PRO)     return 'creator';
  return 'starter'; // default to starter for any unrecognised paid price
}

// Resolve { tier, credits } from a Stripe price object.
// Preferred path: read price.metadata.plan + price.metadata.credits set in the Stripe dashboard.
// This means NO price IDs need to be hardcoded — works for monthly + annual + any future price.
function planFromPrice(price) {
  const md   = (price && price.metadata) || {};
  const tier = (md.plan || tierFromPriceId(price && price.id) || 'starter').toLowerCase();
  let credits = parseInt(md.credits, 10);
  if (!Number.isFinite(credits) || credits <= 0) {
    credits = PLAN_MONTHLY_CREDITS[tier] || PLAN_MONTHLY_CREDITS.starter;
  }
  return { tier, credits };
}

// Stripe helper: GET
function stripeGet(path) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.stripe.com',
      path,
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + process.env.STRIPE_SECRET_KEY },
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

// Supabase: read user app_metadata
async function getAdminUser(userId) {
  const url    = new URL(process.env.SUPABASE_URL + '/auth/v1/admin/users/' + userId);
  const svcKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return new Promise((resolve) => {
    const req = https.request({
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   'GET',
      headers: {
        'Authorization': 'Bearer ' + svcKey,
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

// Supabase: update user app_metadata
async function updateUserMeta(userId, meta) {
  const url    = new URL(process.env.SUPABASE_URL + '/auth/v1/admin/users/' + userId);
  const body   = JSON.stringify({ app_metadata: meta });
  const svcKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   'PATCH',
      headers: {
        'Authorization':  'Bearer ' + svcKey,
        'apikey':         svcKey,
        'Content-Type':   'application/json',
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

// Supabase: find userId by stripe_customer_id in app_metadata
// Paginates through all users (1000 per page) so no one is missed.
async function findUserByCustomerId(customerId) {
  const svcKey  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const baseUrl = process.env.SUPABASE_URL;

  function fetchPage(page) {
    return new Promise((resolve) => {
      const url = new URL(baseUrl + '/auth/v1/admin/users?per_page=1000&page=' + page);
      const req = https.request({
        hostname: url.hostname,
        path:     url.pathname + url.search,
        method:   'GET',
        headers: {
          'Authorization': 'Bearer ' + svcKey,
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
    const users = Array.isArray(result && result.users) ? result.users : [];
    const found = users.find(u => u.app_metadata && u.app_metadata.stripe_customer_id === customerId);
    if (found) return found.id;
    // If fewer than 1000 returned, we have exhausted all pages
    if (users.length < 1000) return null;
    page++;
  }
  // FIX: explicit return null after exhausting MAX_PAGES (was implicit undefined)
  return null;
}

// Main handler
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

      // New subscription / first payment OR one-time top-up
      case 'checkout.session.completed': {
        const session = stripeEvent.data.object;
        const userId  = session.client_reference_id || (session.metadata && session.metadata.user_id);
        if (!userId) { console.warn('No user id on session'); break; }

        // One-time payment: credit top-up
        if (session.mode === 'payment') {
          const credits = parseInt((session.metadata && session.metadata.credits) || '0', 10);
          if (credits > 0) {
            const adminUser = await getAdminUser(userId);
            if (!adminUser) { console.error('stripe-webhook: getAdminUser returned null for user ' + userId + ' during top-up; aborting credit write'); break; }
            const meta           = adminUser.app_metadata || {};
            const currentBalance = meta.credits_balance || 0;
            // Top-ups are added to the spendable balance AND tracked in credits_topup,
            // a reserve counter so they survive the monthly plan reset (plan-first spend).
            const currentTopup   = meta.credits_topup || 0;
            const newBalance     = currentBalance + credits;
            const newTopup       = currentTopup + credits;
            await updateUserMeta(userId, { credits_balance: newBalance, credits_topup: newTopup });
            console.log('User ' + userId + ' top-up: +' + credits + ' credits (pack: ' + (session.metadata && session.metadata.pack_id) + ', balance: ' + newBalance + ', topup reserve: ' + newTopup + ')');
          }
          break;
        }

        // Subscription checkout
        const customerId     = session.customer;
        const subscriptionId = session.subscription;

        // Fetch subscription to get price -> tier + monthly credits (from price metadata)
        let tier = 'starter';
        let planCredits = PLAN_MONTHLY_CREDITS.starter;
        if (subscriptionId) {
          const sub = await stripeGet('/v1/subscriptions/' + subscriptionId);
          if (!sub) { console.error('stripe-webhook: failed to fetch sub ' + subscriptionId); break; }
          const price = sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].price;
          const plan  = planFromPrice(price);
          tier = plan.tier; planCredits = plan.credits;
        }

        const adminUser = await getAdminUser(userId);
        if (!adminUser) { console.error('stripe-webhook: getAdminUser returned null for user ' + userId + ' during subscription checkout; aborting credit write'); break; }
        const meta           = adminUser.app_metadata || {};
        const currentBalance = meta.credits_balance || 0;
        // Preserve any unspent top-up credits (plan-first accounting), then grant fresh plan credits.
        const topupReserve   = Math.min(currentBalance, meta.credits_topup || 0);
        const newBalance     = planCredits + topupReserve;

        await updateUserMeta(userId, {
          stripe_tier:            tier,
          stripe_customer_id:     customerId,
          stripe_subscription_id: subscriptionId,
          credits_balance:        newBalance,
          credits_topup:          topupReserve,
          credits_plan_monthly:   planCredits,
        });
        console.log('User ' + userId + ' upgraded to ' + tier + ', credits set to ' + newBalance + ' (plan ' + planCredits + ' + topup ' + topupReserve + ')');
        break;
      }

      // Plan change or reactivation
      case 'customer.subscription.updated': {
        const sub        = stripeEvent.data.object;
        const customerId = sub.customer;
        const price      = sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].price;
        // Keep users on paid tier while past_due or trialing -- only downgrade on terminal states
        const PAID_STATUSES = new Set(['active', 'trialing', 'past_due']);
        const paid = PAID_STATUSES.has(sub.status);
        const plan = planFromPrice(price);
        const tier = paid ? (plan.tier || 'free') : 'free';

        const userId = await findUserByCustomerId(customerId);
        if (userId) {
          const metaUpdate = { stripe_tier: tier, stripe_subscription_id: sub.id };
          const adminUser  = await getAdminUser(userId);
          const meta       = (adminUser && adminUser.app_metadata) || null;

          // Tier ranking so we only grant credits on a real UPGRADE (not on every update event).
          // Idempotent: after granting, stored stripe_tier == new tier, so repeat events won't re-grant.
          const TIER_RANK  = { free: 0, starter: 1, creator: 2, scale: 3, pro: 2, agency: 3 };
          const prevTier   = (meta && meta.stripe_tier) || 'free';
          const isUpgrade  = !!meta && paid && (TIER_RANK[tier] || 0) > (TIER_RANK[prevTier] || 0);

          if (isUpgrade) {
            // Mid-cycle upgrade: grant the new tier's monthly credits right away.
            // Preserve unspent top-ups (plan-first); old plan credits do not roll over.
            const planCredits    = plan.credits;
            const currentBalance = meta.credits_balance || 0;
            const topupReserve   = Math.min(currentBalance, meta.credits_topup || 0);
            metaUpdate.credits_balance      = planCredits + topupReserve;
            metaUpdate.credits_topup        = topupReserve;
            metaUpdate.credits_plan_monthly = planCredits;
            console.log('User ' + userId + ' UPGRADED ' + prevTier + ' -> ' + tier + ', credits granted to ' + (planCredits + topupReserve) + ' (plan ' + planCredits + ' + topup ' + topupReserve + ')');
          } else {
            // Downgrade or non-plan update: keep current balance until next renewal; just refresh the record.
            if (paid) metaUpdate.credits_plan_monthly = plan.credits;
            console.log('User ' + userId + ' plan updated to ' + tier + ' (no immediate credit change)');
          }

          await updateUserMeta(userId, metaUpdate);
        }
        break;
      }

      // Cancellation — FIX M-12: reset credits to free tier so cancelled users don't keep paid balance
      case 'customer.subscription.deleted': {
        const customerId = stripeEvent.data.object.customer;
        const userId     = await findUserByCustomerId(customerId);
        if (userId) {
          await updateUserMeta(userId, {
            stripe_tier: 'free',
            credits_balance: PLAN_MONTHLY_CREDITS.free,
            credits_topup: 0,
          });
          console.log('User ' + userId + ' downgraded to free + credits reset to ' + PLAN_MONTHLY_CREDITS.free + ' (topups cleared)');
        }
        break;
      }

      // New subscription created (fires before checkout.session.completed)
      // Use this as a fallback in case checkout.session.completed lacks client_reference_id
      case 'customer.subscription.created': {
        const sub        = stripeEvent.data.object;
        const customerId = sub.customer;
        const price      = sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].price;
        const PAID_STATUSES = new Set(['active', 'trialing', 'past_due']);
        const tier = PAID_STATUSES.has(sub.status) ? (planFromPrice(price).tier || 'starter') : 'free';

        const userId = await findUserByCustomerId(customerId);
        if (userId) {
          await updateUserMeta(userId, {
            stripe_tier:            tier,
            stripe_subscription_id: sub.id,
          });
          console.log('User ' + userId + ' subscription created -> ' + tier);
        } else {
          // userId not in Supabase yet -- checkout.session.completed will handle it via client_reference_id
          console.log('subscription.created: no Supabase user found for customer ' + customerId + ' -- will be set by checkout.session.completed');
        }
        break;
      }

      // Successful payment (initial + every monthly renewal)
      case 'invoice.payment_succeeded': {
        const invoice        = stripeEvent.data.object;
        const customerId     = invoice.customer;
        const subscriptionId = invoice.subscription;
        if (!subscriptionId) break; // one-off charge, not a subscription

        // Skip the very first invoice -- checkout.session.completed handles that
        // billing_reason: 'subscription_create' = first charge, 'subscription_cycle' = renewal
        const isRenewal = invoice.billing_reason === 'subscription_cycle';

        // Fetch the subscription to get current price -> tier (+ credits from price metadata)
        const sub     = await stripeGet('/v1/subscriptions/' + subscriptionId);
        if (!sub) { console.error('stripe-webhook: failed to fetch sub ' + subscriptionId + ' on payment'); break; }
        const tier    = planFromPrice(sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].price).tier || 'starter';

        const userId = await findUserByCustomerId(customerId);
        if (userId) {
          const metaUpdate = { stripe_tier: tier };

          if (isRenewal) {
            // Monthly renewal: RESET the plan grant (no rollover of unused plan credits).
            // Purchased top-ups are preserved: with plan-first spend, the unspent top-up
            // reserve = min(currentBalance, credits_topup). New balance = fresh plan + that reserve.
            const adminUser = await getAdminUser(userId);
            if (!adminUser) { console.error('stripe-webhook: getAdminUser returned null for user ' + userId + ' during renewal; aborting credit write'); break; }
            const rmeta          = adminUser.app_metadata || {};
            // Prefer the price's metadata credits for the renewing price
            const rprice         = sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].price;
            const planCredits    = planFromPrice(rprice).credits;
            const currentBalance = rmeta.credits_balance || 0;
            const topupReserve   = Math.min(currentBalance, rmeta.credits_topup || 0);
            const newBalance     = planCredits + topupReserve;
            metaUpdate.credits_balance      = newBalance;
            metaUpdate.credits_topup        = topupReserve;
            metaUpdate.credits_plan_monthly = planCredits;
            console.log('User ' + userId + ' renewal -> reset to ' + newBalance + ' credits (plan ' + planCredits + ' + topup ' + topupReserve + ', tier: ' + tier + ')');
          }

          await updateUserMeta(userId, metaUpdate);
          if (!isRenewal) console.log('User ' + userId + ' payment succeeded -> tier confirmed as ' + tier);
        }
        break;
      }

      // Payment failure -- log only, do not immediately downgrade
      case 'invoice.payment_failed': {
        const invoice = stripeEvent.data.object;
        console.warn('Payment failed for customer ' + invoice.customer + ', attempt ' + invoice.attempt_count);
        // Stripe will retry automatically. After all retries fail, it fires
        // customer.subscription.deleted which will downgrade the user.
        break;
      }

      default:
        console.log('Unhandled event type: ' + stripeEvent.type);
    }

    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  } catch (err) {
    console.error('Webhook handler error:', err);
    return { statusCode: 500, body: 'Handler error: ' + err.message };
  }
};
