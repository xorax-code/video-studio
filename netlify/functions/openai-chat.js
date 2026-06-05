/**
 * Netlify Function: openai-chat
 * Proxies requests to OpenAI /v1/chat/completions using the server-side API key.
 * The key is stored as a Netlify environment variable (OPENAI_API_KEY) and
 * never exposed to the browser.
 *
 * Required env vars:
 *   OPENAI_API_KEY   -- OpenAI secret key
 *   SUPABASE_URL     -- https://xxx.supabase.co
 *   SUPABASE_ANON_KEY -- anon key for JWT validation
 */

const https = require('https');

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Api-Key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// FIX: Added JWT auth -- previously this was an open proxy; any caller could
// make unlimited OpenAI API calls billed to the account with no authentication.
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
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: { message: 'Method not allowed' } }) };
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: { message: 'Server configuration error: missing API key' } }) };
  }

  // Auth: require valid Supabase JWT
  if (!process.env.SUPABASE_URL) {
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: { message: 'Server configuration error.' } }) };
  }
  const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
  const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!jwt) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: { message: 'Authentication required.' } }) };
  }
  const authUser = await getAuthUser(jwt);
  if (!authUser) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: { message: 'Invalid or expired session.' } }) };
  }

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type':  'application/json',
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
