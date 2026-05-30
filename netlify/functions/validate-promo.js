// validate-promo.js — Server-side promo code validation
// Unlock codes live HERE only — never sent to the browser.
// To add/remove codes: edit this file and redeploy.
// To use env vars instead: replace the UNLOCK_CODES object with process.env lookups.

'use strict';

// Promo codes loaded from PROMO_CODES_JSON env var (set in Netlify dashboard)
// Format: {"MYCODE":{"label":"My Label","plan":"pro","durationDays":30},...}
// Fallback to empty object if not configured — prevents code exposure in source
const PROMO_CODES = (() => {
  try { return JSON.parse(process.env.PROMO_CODES_JSON || '{}'); }
  catch(e) { console.error('PROMO_CODES_JSON parse error:', e.message); return {}; }
})();
// Legacy alias so existing handler logic referencing UNLOCK_CODES still works
const UNLOCK_CODES = PROMO_CODES;

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
        ? { valid: true, type: 'unlock', tier: def.tier || def.plan, label: def.label }
        : { valid: false }
    ),
  };
};
