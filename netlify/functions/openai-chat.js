/**
 * Netlify Function: openai-chat
 * Proxies requests to OpenAI /v1/chat/completions using the server-side API key.
 * The key is stored as a Netlify environment variable (OPENAI_API_KEY) and
 * never exposed to the browser.
 *
 * TODO (when Stripe is ready): check user's credit balance in Supabase before
 * forwarding the request, then deduct credits after a successful response.
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Api-Key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  // Only allow POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: { message: 'Method not allowed' } }) };
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Server configuration error: missing API key' }) };
  }

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: (() => {
      try {
        const _b = JSON.parse(event.body || '{}');
        // Cap max_tokens to prevent abuse
        if (_b.max_tokens && _b.max_tokens > 8000) _b.max_tokens = 8000;
        return JSON.stringify(_b);
      } catch(_) { return event.body; }
    })(),
    });

    const data = await response.json();

    return {
      statusCode: response.status,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: { message: 'Proxy error: ' + err.message } }),
    };
  }
};
