/**
 * Netlify BACKGROUND function: generate-nb-composite-background
 *
 * Runs the slow (20-30s) Vertex image composite WITHOUT the 26s synchronous
 * function limit — background functions (the "-background" suffix) may run up to
 * 15 minutes. It reuses the exact generation logic from generate-nb-composite.js
 * (runComposite) and writes the result to the Supabase `nb_jobs` table, keyed by
 * the client-supplied jobId. The frontend then polls poll-nb-composite.
 *
 * Credits are charged HERE, only AFTER the image is safely persisted to nb_jobs,
 * so a crash/timeout can never charge-without-delivering. runComposite is told to
 * skip its own live deduction via `deferCharge:true`.
 *
 * Required env: everything generate-nb-composite needs, plus SUPABASE_URL and
 * SUPABASE_SERVICE_ROLE_KEY (already configured for the app).
 */
const { runComposite, getAuthUser, chargeUserCredits } = require('./generate-nb-composite.js');

// Read the user id (sub) from a JWT without verifying it — only used as a fallback
// to stamp ownership on the job row if the admin lookup briefly blips. The poller
// always re-verifies the requesting user, so this can't be abused to read others' jobs.
function _jwtSub(jwt) {
  try {
    const p = JSON.parse(Buffer.from((jwt || '').split('.')[1] || '', 'base64').toString());
    return p.sub || p.user_id || null;
  } catch(_) { return null; }
}

// Upsert a row into nb_jobs (id is the primary key → merge-duplicates updates it).
// Returns true on a 2xx write so the caller can gate the credit charge on it.
async function writeJob(row) {
  const svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/nb_jobs`, {
      method: 'POST',
      headers: {
        'apikey': svc,
        'Authorization': 'Bearer ' + svc,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(row),
    });
    return r.ok;
  } catch (e) {
    console.error('nb-background: writeJob failed for', row.id, '-', e.message);
    return false;
  }
}

exports.handler = async (event) => {
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch(_) {}
  const jobId = body.jobId;
  if (!jobId) { console.error('nb-background: missing jobId'); return { statusCode: 400, body: 'missing jobId' }; }

  // Resolve the requesting user for ownership (admin lookup, then jwt-sub fallback).
  const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
  const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  let userId = null;
  try { const u = await getAuthUser(jwt); if (u) userId = u.id; } catch(_) {}
  if (!userId) userId = _jwtSub(jwt);

  // Mark pending immediately so the poller can tell "in progress" from "never ran".
  await writeJob({ id: jobId, user_id: userId, status: 'pending' });

  // Charge AFTER persisting → tell runComposite to skip its own live deduction.
  body.deferCharge = true;
  const modEvent = Object.assign({}, event, { body: JSON.stringify(body) });

  let result;
  try {
    result = await runComposite(modEvent); // same generation logic; { statusCode, headers, body }
  } catch (e) {
    console.error('nb-background: runComposite threw for', jobId, '-', e.message);
    await writeJob({ id: jobId, user_id: userId, status: 'error', code: 500, error: 'Internal error: ' + e.message });
    return { statusCode: 202, body: '' };
  }

  let payload = {};
  try { payload = JSON.parse(result.body || '{}'); } catch(_) {}

  if (result.statusCode === 200 && payload.imageB64) {
    const wrote = await writeJob({
      id: jobId, user_id: userId, status: 'done',
      image_b64: payload.imageB64, mime: payload.mime || 'image/png',
      quality: payload.quality || '', credits: payload.creditsDeducted || 0,
    });
    // Deduct credits ONLY once the image is confirmed saved. If the write failed,
    // we never charge (the client times out and can retry — no money lost).
    const cost = payload.creditsDeducted || 0;
    if (wrote && cost > 0 && userId) {
      const charged = await chargeUserCredits(userId, cost);
      if (!charged) console.error('nb-background: image delivered but charge failed for', userId, jobId);
    } else if (!wrote) {
      console.error('nb-background: done-write failed for', jobId, '— not charging');
    }
  } else {
    await writeJob({
      id: jobId, user_id: userId, status: 'error',
      code: result.statusCode || 502,
      error: payload.error || payload.message || ('HTTP ' + result.statusCode),
    });
  }
  return { statusCode: 202, body: '' };
};
