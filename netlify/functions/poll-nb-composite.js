/**
 * Netlify Function: poll-nb-composite
 *
 * Returns the status/result of an async composite job (started by
 * generate-nb-composite-background) by its jobId. Deletes the row once a terminal
 * result is read so the table stays small. Fast/synchronous — safe under the 26s
 * limit because it never generates anything, it just reads a row.
 *
 * Required env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON(_KEY).
 */

function sb(path, opts) {
  const svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
  opts = opts || {};
  opts.headers = Object.assign({ 'apikey': svc, 'Authorization': 'Bearer ' + svc }, opts.headers || {});
  return fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, opts);
}

async function getAuthUser(jwt) {
  try {
    const r = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
      headers: { 'Authorization': 'Bearer ' + jwt, 'apikey': process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_ANON },
    });
    if (!r.ok) return null;
    const d = await r.json();
    return (d && d.id) ? d : null;
  } catch(_) { return null; }
}

exports.handler = async (event) => {
  const CORS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')   return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
  const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!jwt) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Missing authorization token.' }) };
  const user = await getAuthUser(jwt);
  if (!user) return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Invalid or expired session.' }) };

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch(_) {}
  const jobId = body.jobId;
  if (!jobId) return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'jobId required.' }) };

  let rows = [];
  try {
    const r = await sb(`nb_jobs?id=eq.${encodeURIComponent(jobId)}&select=*`, { method: 'GET' });
    rows = await r.json();
  } catch (e) {
    // Transient read error — tell the client to keep polling.
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ status: 'pending' }) };
  }

  if (!Array.isArray(rows) || !rows.length) {
    // No row yet — the background worker hasn't written one. Keep polling.
    return { statusCode: 200, headers: CORS, body: JSON.stringify({ status: 'pending' }) };
  }

  const job = rows[0];
  if (job.user_id && job.user_id !== user.id) {
    return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Not your job.' }) };
  }

  if (job.status === 'done' || job.status === 'error') {
    // Clean up the row (fire-and-forget) once a terminal result is returned.
    sb(`nb_jobs?id=eq.${encodeURIComponent(jobId)}`, { method: 'DELETE', headers: { 'Prefer': 'return=minimal' } }).catch(function(){});
    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify({
        status:   job.status,
        imageB64: job.image_b64 || null,
        mime:     job.mime || 'image/png',
        quality:  job.quality || '',
        credits:  job.credits || 0,
        error:    job.error || null,
        code:     job.code || null,
      }),
    };
  }

  return { statusCode: 200, headers: CORS, body: JSON.stringify({ status: 'pending' }) };
};
