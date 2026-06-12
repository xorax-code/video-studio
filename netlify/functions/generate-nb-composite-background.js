/**
 * Netlify BACKGROUND function: generate-nb-composite-background
 *
 * Runs the slow (20-30s) Vertex image composite WITHOUT the 26s synchronous
 * function limit — background functions (the "-background" suffix) may run up to
 * 15 minutes. It reuses the exact generation logic from generate-nb-composite.js
 * (runComposite) and writes the result to the Supabase `nb_jobs` table, keyed by
 * the client-supplied jobId. The frontend then polls poll-nb-composite.
 *
 * Required env: everything generate-nb-composite needs, plus SUPABASE_URL and
 * SUPABASE_SERVICE_ROLE_KEY (already configured for the app).
 */
const { runComposite, getAuthUser } = require('./generate-nb-composite.js');

// Upsert a row into nb_jobs (id is the primary key → merge-duplicates updates it).
async function writeJob(row) {
  const svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/nb_jobs`, {
      method: 'POST',
      headers: {
        'apikey': svc,
        'Authorization': 'Bearer ' + svc,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(row),
    });
  } catch (e) {
    console.error('nb-background: writeJob failed for', row.id, '-', e.message);
  }
}

exports.handler = async (event) => {
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch(_) {}
  const jobId = body.jobId;
  if (!jobId) { console.error('nb-background: missing jobId'); return { statusCode: 400, body: 'missing jobId' }; }

  // Resolve the requesting user for ownership checks (non-fatal if it fails).
  const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
  const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  let userId = null;
  try { const u = await getAuthUser(jwt); if (u) userId = u.id; } catch(_) {}

  // Mark pending so the poller can tell "in progress" from "unknown job".
  await writeJob({ id: jobId, user_id: userId, status: 'pending' });

  let result;
  try {
    result = await runComposite(event); // same generation logic; { statusCode, headers, body }
  } catch (e) {
    console.error('nb-background: runComposite threw for', jobId, '-', e.message);
    await writeJob({ id: jobId, user_id: userId, status: 'error', code: 500, error: 'Internal error: ' + e.message });
    return { statusCode: 202, body: '' };
  }

  let payload = {};
  try { payload = JSON.parse(result.body || '{}'); } catch(_) {}

  if (result.statusCode === 200 && payload.imageB64) {
    await writeJob({
      id: jobId, user_id: userId, status: 'done',
      image_b64: payload.imageB64, mime: payload.mime || 'image/png',
      quality: payload.quality || '', credits: payload.creditsDeducted || 0,
    });
  } else {
    await writeJob({
      id: jobId, user_id: userId, status: 'error',
      code: result.statusCode || 502,
      error: payload.error || payload.message || ('HTTP ' + result.statusCode),
    });
  }
  return { statusCode: 202, body: '' };
};
