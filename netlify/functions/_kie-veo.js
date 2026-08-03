/**
 * _kie-veo.js — kie.ai Veo provider (shared module)
 *
 * Lets generate-veo-clip.js / poll-veo-clip.js optionally route Veo through kie.ai
 * (≈25% of Google's price) instead of Vertex AI, WITHOUT changing the client contract.
 * Vertex stays the fallback: if a kie submit fails, the caller continues to Vertex.
 *
 * Enabled only when  VEO_PROVIDER=kie  AND  KIE_API_KEY  are both set.
 *
 * Env vars:
 *   KIE_API_KEY                (required to enable)
 *   VEO_PROVIDER=kie           (flag)
 *   KIE_BASE_URL               (default https://api.kie.ai)
 *   KIE_MODEL_LITE/FAST/STANDARD  — kie model ids per tier (see note below)
 *   KIE_GEN_TYPE_IMAGE         (default REFERENCE_2_VIDEO) — mode when a start frame is sent
 *   KIE_VEO_DETAIL_PATH        (default /api/v1/veo/record-info) — poll endpoint
 *   KIE_FRAME_BUCKET           (default ref-videos) — Supabase Storage bucket for start frames
 *   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY  — used to host the start frame as a URL
 *
 * NOTE on model ids: kie's confirmed strings are `veo3` (Quality) and `veo3_fast` (Fast).
 * The exact Veo-3.1 **Lite** id isn't documented publicly, so KIE_MODEL_LITE defaults to
 * `veo3_fast` and SHOULD be overridden with kie's real Lite id (check the kie playground)
 * to get the $0.15/clip Lite price. Until then, Lite requests run as Fast on kie.
 */

const KIE_BASE = process.env.KIE_BASE_URL || 'https://api.kie.ai';

const MODELS = {
  lite:     process.env.KIE_MODEL_LITE     || 'veo3_fast',
  fast:     process.env.KIE_MODEL_FAST     || 'veo3_fast',
  standard: process.env.KIE_MODEL_STANDARD || 'veo3',
};
// Use the provided image as the actual FIRST FRAME (video starts from it), not a loose
// style/subject "reference" that lets the model redraw a new scene. kie's
// FIRST_AND_LAST_FRAMES_2_VIDEO with a single image = "start from this exact frame".
// Override with KIE_GEN_TYPE_IMAGE=REFERENCE_2_VIDEO to go back to inspiration mode.
const GENTYPE_IMAGE = process.env.KIE_GEN_TYPE_IMAGE  || 'FIRST_AND_LAST_FRAMES_2_VIDEO';
const DETAIL_PATH   = process.env.KIE_VEO_DETAIL_PATH || '/api/v1/veo/record-info';
const FRAME_BUCKET  = process.env.KIE_FRAME_BUCKET    || 'ref-videos';

function enabled() {
  return process.env.VEO_PROVIDER === 'kie' && !!process.env.KIE_API_KEY;
}

// Upload the base64 start frame to Supabase Storage and return a short-lived signed URL
// that kie can fetch (kie's image-to-video takes URLs, not base64).
async function hostFrame(b64, mime, userId) {
  const base = process.env.SUPABASE_URL;
  const svc  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !svc) throw new Error('Supabase storage not configured for frame hosting');
  const ext  = (mime && mime.includes('png')) ? 'png' : 'jpg';
  const path = 'frames/' + (userId || 'anon') + '/' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.' + ext;
  const bytes = Buffer.from(b64, 'base64');

  const up = await fetch(base + '/storage/v1/object/' + FRAME_BUCKET + '/' + path, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + svc, 'apikey': svc, 'Content-Type': mime || 'image/jpeg', 'x-upsert': 'true' },
    body: bytes,
  });
  if (!up.ok) throw new Error('frame upload failed ' + up.status + ' ' + (await up.text()).slice(0, 120));

  const sg = await fetch(base + '/storage/v1/object/sign/' + FRAME_BUCKET + '/' + path, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + svc, 'apikey': svc, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: 6 * 3600 }),
  });
  if (!sg.ok) throw new Error('frame sign failed ' + sg.status);
  const sd = await sg.json();
  if (!sd.signedURL && !sd.signedUrl) throw new Error('frame sign: no signed URL in response');
  return base + '/storage/v1' + (sd.signedURL || sd.signedUrl);
}

// Submit a generation to kie. Returns { ok, taskId } or { ok:false, error }.
async function submit(opts) {
  const key   = process.env.KIE_API_KEY;
  const model = MODELS[opts.modelKey] || MODELS.fast;
  const payload = {
    prompt: opts.prompt,
    model,
    aspect_ratio: (opts.aspect === '16:9') ? '16:9' : '9:16',
    enableTranslation: true,
  };
  if (opts.startImageB64 && opts.startImageMime) {
    const url = await hostFrame(opts.startImageB64, opts.startImageMime, opts.userId);
    payload.imageUrls = [url];
    payload.generationType = GENTYPE_IMAGE;
  } else {
    payload.generationType = 'TEXT_2_VIDEO';
  }
  if (opts.callBackUrl) payload.callBackUrl = opts.callBackUrl;

  const r = await fetch(KIE_BASE + '/api/v1/veo/generate', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  let d = null;
  try { d = await r.json(); } catch (_) {}
  const taskId = d && d.data && (d.data.taskId || d.data.task_id);
  if (!r.ok || !d || d.code !== 200 || !taskId) {
    return { ok: false, error: (d && (d.msg || d.message)) || ('kie generate HTTP ' + r.status) };
  }
  return { ok: true, taskId };
}

// Recursively find the first http(s) video URL in a kie response object.
function findVideoUrl(obj, depth) {
  if (!obj || depth > 8) return null;
  if (typeof obj === 'string') {
    return /^https?:\/\/\S+\.(mp4|mov|webm)(\?|$)/i.test(obj) ? obj : null;
  }
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) { const r = findVideoUrl(obj[i], depth + 1); if (r) return r; }
    return null;
  }
  if (typeof obj === 'object') {
    // Common kie keys first
    const priority = ['resultUrls', 'resultUrl', 'videoUrl', 'video_url', 'url', 'originUrls'];
    for (const k of priority) {
      const r = findVideoUrl(obj[k], depth + 1);
      if (r) return r;
    }
    for (const key in obj) { const r = findVideoUrl(obj[key], depth + 1); if (r) return r; }
  }
  return null;
}

// Poll kie for a task. Returns one of:
//   { done:false }                                  — still generating (keep polling)
//   { done:true, videoUrl, mimeType }               — success
//   { done:true, error, filtered? }                 — terminal failure/blocked
async function poll(taskId) {
  const key = process.env.KIE_API_KEY;
  let r;
  try {
    r = await fetch(KIE_BASE + DETAIL_PATH + '?taskId=' + encodeURIComponent(taskId), {
      headers: { 'Authorization': 'Bearer ' + key },
    });
  } catch (e) {
    return { done: false }; // transient network error — keep polling
  }
  let d = null;
  try { d = await r.json(); } catch (_) {}
  if (!r.ok || !d) return { done: false };

  const data = d.data || d;
  // kie status: successFlag 0=generating, 1=success, 2/3=failed (some responses use `status`)
  let flag = (data.successFlag !== undefined) ? data.successFlag : data.status;
  flag = (typeof flag === 'string') ? flag.toLowerCase() : flag;

  const isDone = (flag === 1 || flag === '1' || flag === 'success' || flag === 'succeed' || flag === 'completed');
  const isFail = (flag === 2 || flag === 3 || flag === '2' || flag === '3' || flag === 'fail' || flag === 'failed' || flag === 'error');

  if (isDone) {
    const url = findVideoUrl(data, 0);
    if (!url) return { done: false }; // success flag set but URL not populated yet - keep polling (client has its own max-poll cap)
    return { done: true, videoUrl: url, mimeType: 'video/mp4' };
  }
  if (isFail) {
    const emsg = data.errorMessage || data.error || data.msg || d.msg || 'kie generation failed.';
    const filtered = /filter|responsible|safety|policy|violat|blocked|sensitive|guideline/i.test(String(emsg));
    return { done: true, error: String(emsg), filtered };
  }
  return { done: false };
}

// ── Gemini Omni ("Omni Flash") via kie's UNIFIED JOBS API ───────────────────
// Different endpoint than Veo: POST /api/v1/jobs/createTask (model + input) and a
// unified job-status query. Supports image-to-video (image_urls) + a user-chosen
// `duration` (string seconds: "4" | "6" | "8" | "10"). Rides the same KIE_API_KEY.
const OMNI_MODEL      = process.env.KIE_MODEL_OMNI      || 'gemini-omni-video';
const OMNI_QUERY_PATH = process.env.KIE_JOBS_QUERY_PATH || '/api/v1/jobs/recordInfo';
const OMNI_DURATIONS  = [4, 6, 8, 10];

function omniEnabled() { return !!process.env.KIE_API_KEY; }

// Submit an Omni Flash generation. Returns { ok, taskId } or { ok:false, error }.
async function submitOmni(opts) {
  const key = process.env.KIE_API_KEY;
  const secs = OMNI_DURATIONS.includes(Number(opts.durationSecs)) ? Number(opts.durationSecs) : 8;
  const input = { prompt: opts.prompt, duration: String(secs) }; // kie wants duration as a STRING
  if (opts.startImageB64 && opts.startImageMime) {
    const url = await hostFrame(opts.startImageB64, opts.startImageMime, opts.userId);
    input.image_urls = [url]; // image-to-video from the composite start frame
  }
  const body = { model: OMNI_MODEL, input };
  if (opts.callBackUrl) body.callBackUrl = opts.callBackUrl;
  const r = await fetch(KIE_BASE + '/api/v1/jobs/createTask', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let d = null;
  try { d = await r.json(); } catch (_) {}
  const taskId = d && d.data && (d.data.taskId || d.data.task_id);
  if (!r.ok || !d || d.code !== 200 || !taskId) {
    return { ok: false, error: (d && (d.msg || d.message)) || ('kie omni generate HTTP ' + r.status) };
  }
  return { ok: true, taskId };
}

// Poll an Omni task via kie's unified Jobs query endpoint. Same return shape as poll().
async function pollOmni(taskId) {
  const key = process.env.KIE_API_KEY;
  let r;
  try {
    r = await fetch(KIE_BASE + OMNI_QUERY_PATH + '?taskId=' + encodeURIComponent(taskId), {
      headers: { 'Authorization': 'Bearer ' + key },
    });
  } catch (e) { return { done: false }; }
  let d = null;
  try { d = await r.json(); } catch (_) {}
  if (!r.ok || !d) return { done: false };
  const data = d.data || d;
  // Job state can arrive as state/status/successFlag depending on kie's schema.
  let flag = (data.successFlag !== undefined) ? data.successFlag
           : (data.state       !== undefined) ? data.state
           : data.status;
  flag = (typeof flag === 'string') ? flag.toLowerCase() : flag;
  const isDone = (flag === 1 || flag === '1' || flag === 'success' || flag === 'succeed' || flag === 'completed');
  const isFail = (flag === 2 || flag === 3 || flag === '2' || flag === '3' || flag === 'fail' || flag === 'failed' || flag === 'error');
  if (isDone) {
    // kie's unified Jobs query returns the result URL inside data.resultJson — a JSON
    // STRING, e.g. {"resultUrls":["https://.../clip.mp4"]}. Parse it first; fall back
    // to a recursive search for other shapes.
    let url = null;
    if (data.resultJson) {
      try {
        const rj = JSON.parse(data.resultJson);
        url = (rj.resultUrls && rj.resultUrls[0]) || rj.resultUrl || findVideoUrl(rj, 0);
      } catch (_) {}
    }
    if (!url) url = findVideoUrl(data, 0);
    if (!url) return { done: false }; // success flag set but URL not populated yet — keep polling
    return { done: true, videoUrl: url, mimeType: 'video/mp4' };
  }
  if (isFail) {
    const emsg = data.failMsg || data.failCode || data.errorMessage || data.error || d.msg || 'kie omni generation failed.';
    const filtered = /filter|responsible|safety|policy|violat|blocked|sensitive|guideline/i.test(String(emsg));
    return { done: true, error: String(emsg), filtered };
  }
  return { done: false };
}

module.exports = { enabled, submit, poll, MODELS, omniEnabled, submitOmni, pollOmni, OMNI_DURATIONS };
