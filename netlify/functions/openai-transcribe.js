/**
 * Netlify Function: openai-transcribe
 * Proxies audio transcription requests to OpenAI /v1/audio/transcriptions.
 * The client sends the audio file as a base64-encoded string in JSON.
 * This function reconstructs the multipart FormData and forwards it to OpenAI.
 *
 * TODO (when Stripe is ready): check/deduct credits before forwarding.
 */

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: { message: 'Method not allowed' } }) };
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: { message: 'OpenAI API key not configured on server.' } })
    };
  }

  try {
    const { audioBase64, fileName, model, response_format, timestamp_granularities } = JSON.parse(event.body);

    if (!audioBase64) {
      return { statusCode: 400, body: JSON.stringify({ error: { message: 'Missing audioBase64 field.' } }) };
    }

    // Reconstruct the audio file from base64
    const audioBuffer = Buffer.from(audioBase64, 'base64');

    // Determine MIME type from file extension
    const ext = (fileName || 'audio.webm').split('.').pop().toLowerCase();
    const mimeMap = { webm: 'audio/webm', mp4: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/m4a' };
    const mimeType = mimeMap[ext] || 'audio/webm';

    const audioBlob = new Blob([audioBuffer], { type: mimeType });

    const formData = new FormData();
    formData.append('file', audioBlob, fileName || 'audio.webm');
    formData.append('model', model || 'whisper-1');
    if (response_format) formData.append('response_format', response_format);
    if (timestamp_granularities) formData.append('timestamp_granularities[]', timestamp_granularities);

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      body: formData,
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
