/**
 * Netlify Function: fetch-remote-video
 * Imports a reference video from a pasted social link (TikTok / Instagram Reels /
 * Facebook / YouTube Shorts) so the user doesn't have to download+upload it.
 *
 * Flow: validate URL -> resolve a direct, watermark-free video URL ->
 * download server-side -> upload to Supabase Storage (bucket "ref-videos") ->
 * return a short-lived signed URL the browser downloads into a File.
 *
 * TikTok works out of the box via tikwm (no key). Instagram / Facebook / YouTube
 * use an optional RapidAPI provider you configure with env vars (see README-style
 * note at the bottom). Without that key, those platforms return a clear message.
 *
 * Env vars:
 *   SUPABASE_URL                - https://xxx.supabase.co
 *   SUPABASE_ANON_KEY           - anon key (JWT validation)
 *   SUPABASE_SERVICE_ROLE_KEY   - service role (Storage upload + signed URL)
 *   RAPIDAPI_KEY   (optional)   - enables IG / FB / YouTube import
 *   RAPIDAPI_HOST  (optional)   - e.g. social-download-all-in-one.p.rapidapi.com
 *   RAPIDAPI_URL   (optional)   - full endpoint, e.g. https://<host>/v1/social/autolink
 */

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const MAX_BYTES  = 80 * 1024 * 1024; // reject anything over ~80 MB
const BUCKET     = 'ref-videos';
const SIGN_TTL   = 3600;             // signed URL lifetime (seconds)

function json(status, body) {
  return { statusCode: status, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

// Validate the Supabase JWT and return the user (or null)
async function getAuthUser(jwt) {
  if (!process.env.SUPABASE_URL) return null;
  try {
    const r = await fetch(process.env.SUPABASE_URL + '/auth/v1/user', {
      headers: { 'Authorization': 'Bearer ' + jwt, 'apikey': process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_ANON || '' },
    });
    if (!r.ok) return null;
    const d = await r.json();
    return d && d.id ? d : null;
  } catch (_) { return null; }
}

function detectPlatform(url) {
  const u = url.toLowerCase();
  if (u.includes('tiktok.com'))                              return 'tiktok';
  if (u.includes('instagram.com'))                           return 'instagram';
  if (u.includes('facebook.com') || u.includes('fb.watch')) return 'facebook';
  if (u.includes('youtube.com')  || u.includes('youtu.be'))  return 'youtube';
  return null;
}

// Resolve a direct video URL. Returns { videoUrl, watermarkFree } or throws.
async function resolveDirectUrl(platform, url) {
  if (platform === 'tiktok') {
    // tikwm: free, no key, returns a watermark-free source
    const api = 'https://www.tikwm.com/api/?hd=1&url=' + encodeURIComponent(url);
    const r = await fetch(api, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) throw new Error('TikTok resolver returned ' + r.status);
    const d = await r.json();
    const vid = d && d.data && (d.data.hdplay || d.data.play || d.data.wmplay);
    if (!vid) throw new Error('Could not resolve this TikTok link.');
    return { videoUrl: vid, watermarkFree: !!(d.data.hdplay || d.data.play) };
  }

  // IG / FB / YouTube -> optional RapidAPI provider
  const KEY  = process.env.RAPIDAPI_KEY;
  const HOST = process.env.RAPIDAPI_HOST;
  const EP   = process.env.RAPIDAPI_URL;
  if (!KEY || !HOST || !EP) {
    const e = new Error('IG_FB_NOT_CONFIGURED');
    e.code = 'IG_FB_NOT_CONFIGURED';
    throw e;
  }
  const r = await fetch(EP, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-RapidAPI-Key': KEY, 'X-RapidAPI-Host': HOST },
    body: JSON.stringify({ url }),
  });
  if (!r.ok) throw new Error('Importer returned ' + r.status);
  const d = await r.json();
  // The download links live in `medias` (array of variants). The top-level `url`
  // is just the source page echoed back, and one media item is audio — so pick the
  // best VIDEO variant, preferring no-watermark / HD. Falls back to other shapes.
  let vid = null, wmFree = true;
  if (d && Array.isArray(d.medias) && d.medias.length) {
    const lbl = m => ((m.quality||'') + ' ' + (m.label||'') + ' ' + (m.type||'') + ' ' + (m.extension||'')).toLowerCase();
    const vids = d.medias.filter(m => {
      if (!m || !m.url) return false;
      const l = lbl(m), u = ('' + m.url).toLowerCase();
      const isAudio = /audio|mp3|\.mp3|m4a/.test(l) || (m.audioAvailable === true && m.videoAvailable === false);
      const isVideo = /video|mp4|mov|webm/.test(l) || /\.mp4|\.mov|\.webm/.test(u) || m.videoAvailable === true;
      return !isAudio && (isVideo || /^https?:/.test(u));
    });
    const isWm = m => /water\s*mark|wmplay|\bwm\b/.test(lbl(m));
    const noWm = vids.filter(m => !isWm(m));
    const pool = noWm.length ? noWm : vids;
    const pick = pool.find(m => /hd|1080|no.?water|nowm/.test(lbl(m))) || pool[0] || null;
    if (pick) { vid = pick.url; wmFree = noWm.length ? noWm.includes(pick) : false; }
  }
  if (!vid) {
    vid = (d && d.data && (d.data.url || d.data.play)) ||
          (d && Array.isArray(d.links) && d.links[0] && d.links[0].link) ||
          null;
  }
  if (!vid) throw new Error('Could not resolve a downloadable video from this link.');
  return { videoUrl: vid, watermarkFree: wmFree };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return json(405, { error: { message: 'Method not allowed' } });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { error: { message: 'Server storage is not configured.' } });
  }

  // Auth
  const authHeader = event.headers['authorization'] || event.headers['Authorization'] || '';
  const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!jwt) return json(401, { error: { message: 'Authentication required.' } });
  const user = await getAuthUser(jwt);
  if (!user) return json(401, { error: { message: 'Invalid or expired session.' } });

  // Parse
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: { message: 'Invalid JSON body.' } }); }
  const url = (body.url || '').trim();
  if (!url || !/^https?:\/\//i.test(url)) return json(400, { error: { message: 'Please paste a valid video link.' } });

  const platform = detectPlatform(url);
  if (!platform) return json(400, { error: { message: 'Unsupported link. Use a TikTok, Instagram, Facebook or YouTube URL.' } });

  // Resolve
  let resolved;
  try {
    resolved = await resolveDirectUrl(platform, url);
  } catch (err) {
    if (err.code === 'IG_FB_NOT_CONFIGURED') {
      return json(501, { error: { message: 'Importing ' + platform + ' links needs to be enabled by the admin. TikTok works now.' }, code: 'IG_FB_NOT_CONFIGURED' });
    }
    return json(502, { error: { message: 'Could not fetch that video: ' + err.message } });
  }

  // Download server-side
  let bytes;
  try {
    const _ac = new AbortController();
    const _to = setTimeout(() => _ac.abort(), 22000);
    let vr;
    try { vr = await fetch(resolved.videoUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: _ac.signal }); }
    finally { clearTimeout(_to); }
    if (!vr.ok) return json(502, { error: { message: 'Download failed (' + vr.status + ').' } });
    const len = Number(vr.headers.get('content-length') || 0);
    if (len && len > MAX_BYTES) return json(413, { error: { message: 'That video is too large (over 80 MB). Try a shorter clip.' } });
    const ab = await vr.arrayBuffer();
    bytes = Buffer.from(ab);
    if (bytes.length > MAX_BYTES) return json(413, { error: { message: 'That video is too large (over 80 MB). Try a shorter clip.' } });
  } catch (err) {
    return json(502, { error: { message: 'Download error: ' + err.message } });
  }

  // Upload to Supabase Storage
  const path = user.id + '/' + Date.now() + '-' + platform + '.mp4';
  const svc  = process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    const up = await fetch(process.env.SUPABASE_URL + '/storage/v1/object/' + BUCKET + '/' + path, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + svc, 'apikey': svc, 'Content-Type': 'video/mp4', 'x-upsert': 'true' },
      body: bytes,
    });
    if (!up.ok) {
      const t = await up.text();
      return json(502, { error: { message: 'Storage upload failed. Make sure the "' + BUCKET + '" bucket exists. ' + t.slice(0, 140) } });
    }
  } catch (err) {
    return json(502, { error: { message: 'Storage error: ' + err.message } });
  }

  // Signed URL
  try {
    const sg = await fetch(process.env.SUPABASE_URL + '/storage/v1/object/sign/' + BUCKET + '/' + path, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + svc, 'apikey': svc, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn: SIGN_TTL }),
    });
    if (!sg.ok) {
      try { await fetch(process.env.SUPABASE_URL + '/storage/v1/object/' + BUCKET + '/' + path, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + svc, 'apikey': svc } }); } catch (_) {}
      return json(502, { error: { message: 'Could not sign the video URL.' } });
    }
    const sd = await sg.json();
    const signed = process.env.SUPABASE_URL + '/storage/v1' + (sd.signedURL || sd.signedUrl);
    return json(200, {
      url: signed,
      filename: platform + '-reference.mp4',
      size: bytes.length,
      platform,
      watermarkFree: resolved.watermarkFree,
    });
  } catch (err) {
    return json(502, { error: { message: 'Sign error: ' + err.message } });
  }
};
