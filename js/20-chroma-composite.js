// ============================================================================
// 20-chroma-composite.js — Green-screen overlay compositor (v1, dev test)
// ----------------------------------------------------------------------------
// For "composite scenes" where the original reference is a talking person in
// FRONT of an un-separable screen-recording / app UI, we generate the avatar on
// a flat chroma-green background (see 17-nb-api.js + 15-veo-api.js), then this
// module keys the green out and composites the avatar OVER the untouched original
// clip. The real moving UI shows through around her — no baked static background.
//
// Because the original person sits IN FRONT of the UI, as long as the avatar
// covers his silhouette, he's hidden and it reads as "just the character swapped".
//
// Entry points (call from a button or the console on the dev site):
//   window.compositeSegmentOverOriginal(i)   → composite one segment, returns Promise<blobUrl>
//   window.compositeAllOverlaySegments()     → composite every overlay-flagged segment
//   window.restoreGreenClips()               → undo: put the raw green clips back
//
// Notes:
//   • Realtime canvas.captureStream + MediaRecorder (browser-native, no ffmpeg).
//   • Voice audio is taken from the AVATAR clip; the reference audio is muted.
//   • Output is webm; the existing assembler/stitch can transcode for final export.
// ============================================================================
(function () {
  'use strict';

  var KEY_R = 0, KEY_G = 177, KEY_B = 64; // #00b140 target key color

  function _toast(msg, kind, ms) {
    if (typeof showToast === 'function') showToast(msg, kind || 'info', ms || 4000);
    else console.log('[composite]', msg);
  }

  function _refSource() {
    var el = window.refVideoEl || document.getElementById('refVideoEl');
    var src = el && (el.currentSrc || el.src);
    return src || null;
  }

  // Load a fresh, muted <video> from a source URL and resolve once seekable.
  function _loadVideo(src, muted) {
    return new Promise(function (resolve, reject) {
      if (!src) { reject(new Error('missing video source')); return; }
      var v = document.createElement('video');
      v.crossOrigin = 'anonymous';
      v.muted = !!muted;
      v.playsInline = true;
      v.preload = 'auto';
      v.src = src;
      var done = false;
      var to = setTimeout(function () { if (!done) { done = true; reject(new Error('video load timeout')); } }, 20000);
      v.addEventListener('loadeddata', function () {
        if (done) return; done = true; clearTimeout(to); resolve(v);
      }, { once: true });
      v.addEventListener('error', function () {
        if (done) return; done = true; clearTimeout(to); reject(new Error('video load error'));
      }, { once: true });
      v.load();
    });
  }

  function _seek(v, t) {
    return new Promise(function (resolve) {
      if (Math.abs(v.currentTime - t) < 0.02) { resolve(); return; }
      var to = setTimeout(function () { v.removeEventListener('seeked', fn); resolve(); }, 4000);
      var fn = function () { clearTimeout(to); resolve(); };
      v.addEventListener('seeked', fn, { once: true });
      try { v.currentTime = t; } catch (_) { clearTimeout(to); resolve(); }
    });
  }

  function _pickMime() {
    var opts = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    for (var i = 0; i < opts.length; i++) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(opts[i])) return opts[i];
    }
    return 'video/webm';
  }

  // Ensure a same-origin blob URL so getImageData() doesn't hit a tainted-canvas
  // SecurityError. Remote (GCS/Google) clip URLs are fetched into a blob first.
  async function _asBlobUrl(src) {
    if (!src) throw new Error('no clip source');
    if (src.indexOf('blob:') === 0 || src.indexOf('data:') === 0) return src;
    try {
      var r = await fetch(src, { mode: 'cors' });
      if (!r.ok) throw new Error('fetch ' + r.status);
      return URL.createObjectURL(await r.blob());
    } catch (e) {
      throw new Error('could not load the generated clip for compositing (CORS/network) — ' + (e.message || e));
    }
  }

  // Core: composite one segment. avatarSrc = green clip; reference = refVideoEl trimmed.
  async function compositeSegmentOverOriginal(i) {
    var segs = window.segments || [];
    var seg = segs[i];
    if (!seg) throw new Error('segment ' + i + ' not found');

    var avatarSrc = seg._greenClipUrl || seg.apiVideoRaw || seg.apiVideoUrl;
    if (!avatarSrc) throw new Error('segment ' + (i + 1) + ' has no generated (green) clip yet');
    var refSrc = _refSource();
    if (!refSrc) throw new Error('original reference video not loaded');

    _toast('Compositing scene ' + (i + 1) + '…', 'info', 3000);

    avatarSrc = await _asBlobUrl(avatarSrc);          // avoid tainted-canvas on remote URLs
    var avatar = await _loadVideo(avatarSrc, false);  // keep avatar audio (the voice)
    var ref    = await _loadVideo(refSrc, true);      // reference muted

    // Output dimensions: match the reference framing, capped for realtime keying.
    var maxH = window._gsCompositeMaxH || 960;
    var refH = ref.videoHeight || 1280, refW = ref.videoWidth || 720;
    var scale = Math.min(1, maxH / refH);
    var W = Math.round(refW * scale), H = Math.round(refH * scale);

    var canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    var ctx = canvas.getContext('2d', { willReadFrequently: true });

    // Offscreen canvas for keying the avatar frame.
    var akv = document.createElement('canvas');
    akv.width = W; akv.height = H;
    var actx = akv.getContext('2d', { willReadFrequently: true });

    var startT = Math.max(0, +seg.startTime || 0);
    var endT   = (+seg.endTime > startT) ? +seg.endTime : (startT + (avatar.duration || 8));

    await _seek(ref, startT);
    try { avatar.currentTime = 0; } catch (_) {}

    // Build the recording stream: canvas video + avatar audio (voice).
    var fps = 30;
    var stream = canvas.captureStream(fps);
    try {
      var aStream = (avatar.captureStream ? avatar.captureStream() : (avatar.mozCaptureStream ? avatar.mozCaptureStream() : null));
      if (aStream) {
        var at = aStream.getAudioTracks();
        if (at && at[0]) stream.addTrack(at[0]);
      }
    } catch (_) { /* no audio track — silent composite */ }

    var mime = _pickMime();
    var rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8000000 });
    var chunks = [];
    rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };

    var thr = (window._gsKeyThreshold != null) ? window._gsKeyThreshold : 90; // green dominance
    var kg  = (window._gsKeyGreenMin != null) ? window._gsKeyGreenMin : 90;    // min green level

    var stopped = false;
    function keyFrame() {
      // draw avatar to offscreen, then punch out green → transparent
      actx.drawImage(avatar, 0, 0, W, H);
      var img = actx.getImageData(0, 0, W, H);
      var d = img.data;
      for (var p = 0; p < d.length; p += 4) {
        var r = d[p], g = d[p + 1], b = d[p + 2];
        // green if green channel dominates red & blue and is bright enough
        if (g > kg && (g - r) > thr && (g - b) > thr) {
          d[p + 3] = 0; // transparent
        } else if (g > r && g > b && (g - Math.max(r, b)) > thr * 0.5) {
          // edge/spill: desaturate green a touch to reduce fringing
          var avg = (r + b) / 2;
          d[p + 1] = Math.min(g, avg + (thr * 0.5));
        }
      }
      actx.putImageData(img, 0, 0);
    }

    return await new Promise(function (resolve, reject) {
      var raf;
      function tick() {
        if (stopped) return;
        // Reference: hold last UI frame once we pass this scene's end.
        if (ref.currentTime >= endT && !ref.paused) { try { ref.pause(); } catch (_) {} }
        // 1) background = original reference frame (real moving UI)
        ctx.drawImage(ref, 0, 0, W, H);
        // 2) foreground = keyed avatar (covers the original person)
        keyFrame();
        ctx.drawImage(akv, 0, 0, W, H);
        raf = requestAnimationFrame(tick);
      }

      var _settled = false, settleTimer = null, hardStop = null;

      // Single settling path — builds the blob from whatever was recorded and
      // resolves. Guarded so onstop AND the fallback timer can't double-fire.
      function _finalize() {
        if (_settled) return; _settled = true;
        clearTimeout(hardStop); clearTimeout(settleTimer);
        try {
          var blob = new Blob(chunks, { type: mime });
          if (!blob.size) { reject(new Error('recorder produced no data')); return; }
          var url = URL.createObjectURL(blob);
          // preserve the raw green clip so this is reversible
          if (!seg._greenClipUrl) seg._greenClipUrl = seg.apiVideoRaw || seg.apiVideoUrl;
          seg.compositedRaw = url;
          seg.compositedMime = mime;
          seg.apiVideoRaw = url;      // assembler + stitch now use the composite
          seg.apiVideoMime = 'video/webm';
          if (typeof saveSegments === 'function') { try { saveSegments(); } catch (_) {} }
          if (typeof renderSegments === 'function') { try { renderSegments(); } catch (_) {} }
          _toast('Scene ' + (i + 1) + ' composited ✓', 'success', 3000);
          resolve(url);
        } catch (e) { reject(e); }
      }

      function finish() {
        if (stopped) return; stopped = true;
        cancelAnimationFrame(raf);
        try { ref.pause(); } catch (_) {}
        try { if (rec.state !== 'inactive') rec.stop(); } catch (_) {}
        // Fallback: if onstop never fires, finalize anyway from recorded chunks.
        settleTimer = setTimeout(_finalize, 2500);
      }

      avatar.onended = function () { finish(); };
      rec.onstop = function () { _finalize(); };

      // Safety cap: never run longer than avatar duration + 1s.
      hardStop = setTimeout(finish, ((avatar.duration || 8) + 1) * 1000);

      Promise.all([ref.play().catch(function(){}), avatar.play().catch(function(){})])
        .then(function () { rec.start(100); tick(); })
        .catch(function (e) { reject(e); });
    });
  }

  async function compositeAllOverlaySegments() {
    var segs = window.segments || [];
    var globalOn = !!window._greenScreenOverlay;
    var targets = [];
    for (var i = 0; i < segs.length; i++) {
      if ((globalOn || segs[i].overlayGreen) && (segs[i].apiVideoRaw || segs[i].apiVideoUrl || segs[i]._greenClipUrl)) targets.push(i);
    }
    if (!targets.length) { _toast('No overlay-flagged scenes with a generated clip found.', 'warning'); return; }
    _toast('Compositing ' + targets.length + ' scene(s) over the original…', 'info', 4000);
    for (var k = 0; k < targets.length; k++) {
      try { await compositeSegmentOverOriginal(targets[k]); }
      catch (e) { _toast('Scene ' + (targets[k] + 1) + ' failed: ' + (e.message || e), 'error', 6000); }
    }
    _toast('Compositing done — check the scenes / assembler.', 'success', 4000);
  }

  function restoreGreenClips() {
    var segs = window.segments || [];
    var n = 0;
    for (var i = 0; i < segs.length; i++) {
      if (segs[i]._greenClipUrl) {
        segs[i].apiVideoRaw = segs[i]._greenClipUrl;
        segs[i].apiVideoMime = 'video/mp4';
        segs[i].compositedRaw = null;
        n++;
      }
    }
    if (typeof saveSegments === 'function') { try { saveSegments(); } catch (_) {} }
    if (typeof renderSegments === 'function') { try { renderSegments(); } catch (_) {} }
    _toast('Restored ' + n + ' raw green clip(s).', 'info');
  }

  window.compositeSegmentOverOriginal = compositeSegmentOverOriginal;
  window.compositeAllOverlaySegments  = compositeAllOverlaySegments;
  window.restoreGreenClips            = restoreGreenClips;
})();
