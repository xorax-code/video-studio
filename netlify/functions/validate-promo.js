// validate-promo.js — Server-side promo code validation
// Unlock codes live HERE only — never sent to the browser.
// To add/remove codes: edit this file and redeploy.
// To use env vars instead: replace the UNLOCK_CODES object with process.env lookups.

'use strict';

const UNLOCK_CODES = {
  MAXACCESS:  { tier: 'agency', label: 'Full Access — All Features Unlocked' },
  VIPBETA:    { tier: 'pro',    label: 'Pro Access — VIP Beta' },
  EARLYBIRD:  { tier: 'agency', label: 'Early Bird — Full Access' },
};

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
};

exports.handler = async (event) => {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { ...CORS, 'Access-Control-Allow-Methods': 'POST, OPTIONS' }, body: '' };
  }

  // Only accept POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ valid: false, error: 'Method Not Allowed' }) };
  }

  let code;
  try {
    const body = JSON.parse(event.body || '{}');
    code = (body.code || '').trim().toUpperCase();
  } catch {
    return {
      statusCode: 400,
      headers: CORS,
      body: JSON.stringify({ valid: false, error: 'Bad request' }),
    };
  }

  if (!code) {
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ valid: false }),
    };
  }

  const def = UNLOCK_CODES[code];

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify(
      def
        ? { valid: true, type: 'unlock', tier: def.tier, label: def.label }
        : { valid: false }
    ),
  };
};
