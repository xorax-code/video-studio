/**
 * Netlify Function: openai-chat
 * Proxies requests to OpenAI /v1/chat/completions using the server-side API key.
 * The key is stored as a Netlify environment variable (OPENAI_API_KEY) and
 * never exposed to the browser.
 *
 * TODO (when Stripe is ready): check user's credit balance in Supabase before
 * forwarding the request, then deduct credits after a successful response.
 */

exports.handler = async (event) => {
  // Only allow POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: { message: 'Method not allowed' } }) };
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: { message: 'OpenAI API key not configured on server. Contact support.' } })
    };
  }

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: event.body,
    });

    const data = await response.json();

    return {
      statusCode: response.status,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: { message: 'Proxy error: ' + err.message } }),
    };
  }
};
