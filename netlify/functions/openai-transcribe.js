/**
 * Netlify Function: openai-transcribe
 * Proxies audio/video transcription requests to OpenAI /v1/audio/transcriptions.
 *
 * Uses Node.js built-in `https` module and manually-built multipart/form-data
 * to avoid Blob/FormData compatibility issues in the Node.js Lambda runtime.
 *
 * Payload limit: ~4 MB raw file (base64 adds ~33% overhead, Lambda cap is 6 MB).
 */

const https = require('https');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: { message: 'Method not allowed' } }),
    };
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: { message: 'OpenAI API key not configured on server.' } }),
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(event.body);
  } catch {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: { message: 'Invalid JSON body.' } }),
    };
  }

  const { audioBase64, fileName, model, response_format, timestamp_granularities } = parsed;

  if (!audioBase64) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: { message: 'Missing audioBase64 field.' } }),
    };
  }

  try {
    const audioBuffer = Buffer.from(audioBase64, 'base64');

    // Map file extension → MIME type (Whisper accepts audio + video containers)
    const ext = (fileName || 'audio.mp4').split('.').pop().toLowerCase();
    const mimeMap = {
      mp4: 'video/mp4', mov: 'video/quicktime', webm: 'audio/webm',
      mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/m4a',
      ogg: 'audio/ogg', flac: 'audio/flac', mpeg: 'audio/mpeg',
    };
    const mimeType = mimeMap[ext] || 'video/mp4';
    const safeFileName = fileName || `audio.${ext}`;

    // Build multipart/form-data manually — avoids Blob/FormData Node.js quirks
    const boundary = '----OpenAIBoundary' + Date.now().toString(36) + Math.random().toString(36).slice(2);
    const CRLF = '\r\n';

    const parts = [];

    // --- file field ---
    parts.push(Buffer.from(
      `--${boundary}${CRLF}` +
      `Content-Disposition: form-data; name="file"; filename="${safeFileName}"${CRLF}` +
      `Content-Type: ${mimeType}${CRLF}${CRLF}`,
      'utf8'
    ));
    parts.push(audioBuffer);
    parts.push(Buffer.from(CRLF, 'utf8'));

    // --- model field ---
    parts.push(Buffer.from(
      `--${boundary}${CRLF}` +
      `Content-Disposition: form-data; name="model"${CRLF}${CRLF}` +
      `${model || 'whisper-1'}${CRLF}`,
      'utf8'
    ));

    // --- response_format field ---
    if (response_format) {
      parts.push(Buffer.from(
        `--${boundary}${CRLF}` +
        `Content-Disposition: form-data; name="response_format"${CRLF}${CRLF}` +
        `${response_format}${CRLF}`,
        'utf8'
      ));
    }

    // --- timestamp_granularities field (array syntax required by OpenAI) ---
    if (timestamp_granularities) {
      const granularities = Array.isArray(timestamp_granularities)
        ? timestamp_granularities
        : [timestamp_granularities];
      for (const g of granularities) {
        parts.push(Buffer.from(
          `--${boundary}${CRLF}` +
          `Content-Disposition: form-data; name="timestamp_granularities[]"${CRLF}${CRLF}` +
          `${g}${CRLF}`,
          'utf8'
        ));
      }
    }

    // --- closing boundary ---
    parts.push(Buffer.from(`--${boundary}--${CRLF}`, 'utf8'));

    const body = Buffer.concat(parts);

    // Forward to OpenAI using Node.js built-in https (always available, no fetch needed)
    const result = await new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: 'api.openai.com',
          path: '/v1/audio/transcriptions',
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': body.length,
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () =>
            resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') })
          );
        }
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    // Parse and forward OpenAI's response
    let data;
    try {
      data = JSON.parse(result.body);
    } catch {
      // OpenAI returned non-JSON (shouldn't happen, but handle gracefully)
      return {
        statusCode: 502,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: { message: 'Unexpected response from OpenAI: ' + result.body.slice(0, 200) } }),
      };
    }

    return {
      statusCode: result.status,
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
