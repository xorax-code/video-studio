/* ===========================================================================
 * 23-asm-audio.js — Shared audio helpers for the Video Assembler.
 *
 * One decode, two uses:
 *   1. Waveform peaks  → drawn under each timeline clip (see speech vs dead space).
 *   2. 16 kHz mono WAV → sent to Whisper (openai-transcribe) for real captions when
 *      a clip has no script text (e.g. an uploaded video).
 *
 * Everything is cached by clip (blobUrl + trim range) so re-renders are cheap and
 * we never decode or transcribe the same clip twice. Fully self-contained and
 * additive — exposes window.AsmAudio; touches no existing state.
 * ======================================================================== */
(function () {
  'use strict';

  var _ctx = null;                 // one shared AudioContext (lazy)
  var _decodeCache = {};           // blobUrl -> Promise<AudioBuffer|null>
  var _peakCache   = {};           // key -> Float32Array of peaks
  var _txCache     = {};           // key -> Promise<string>  (transcription)

  function ctx() {
    if (!_ctx) { try { _ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { _ctx = null; } }
    return _ctx;
  }
  function keyOf(blobUrl, start, end) { return blobUrl + '|' + (start || 0).toFixed(2) + '|' + (end == null ? 'x' : end.toFixed(2)); }

  // Decode a clip's audio track once. Resolves null if there's no audio / decode fails.
  function decode(blobUrl) {
    if (!blobUrl) return Promise.resolve(null);
    if (_decodeCache[blobUrl]) return _decodeCache[blobUrl];
    var p = fetch(blobUrl)
      .then(function (r) { return r.arrayBuffer(); })
      .then(function (buf) {
        var c = ctx(); if (!c) return null;
        return new Promise(function (resolve) {
          // callback form for Safari compatibility
          try {
            c.decodeAudioData(buf, function (ab) { resolve(ab); }, function () { resolve(null); });
          } catch (e) { resolve(null); }
        });
      })
      .catch(function () { return null; });
    _decodeCache[blobUrl] = p;
    // Don't permanently cache a failure (transient fetch error, not-yet-ready URL) —
    // clear it so a later render/transcribe can retry. In-flight callers still share p.
    p.then(function (ab) { if (!ab && _decodeCache[blobUrl] === p) delete _decodeCache[blobUrl]; });
    return p;
  }

  // Mix an AudioBuffer down to a single mono Float32Array.
  function toMono(ab) {
    var ch = ab.numberOfChannels;
    if (ch === 1) return ab.getChannelData(0);
    var out = new Float32Array(ab.length);
    for (var c = 0; c < ch; c++) {
      var d = ab.getChannelData(c);
      for (var i = 0; i < d.length; i++) out[i] += d[i] / ch;
    }
    return out;
  }

  // N normalized peak values (0..1) across the [start,end] window of a clip.
  function computePeaks(ab, start, end, n) {
    var mono = toMono(ab);
    var sr = ab.sampleRate;
    var s0 = Math.max(0, Math.floor((start || 0) * sr));
    var s1 = Math.min(mono.length, Math.floor((end == null ? ab.duration : end) * sr));
    var span = Math.max(1, s1 - s0);
    var per = span / n;
    var peaks = new Float32Array(n);
    var max = 0.0001;
    for (var b = 0; b < n; b++) {
      var a = s0 + Math.floor(b * per), z = s0 + Math.floor((b + 1) * per);
      var m = 0;
      for (var i = a; i < z; i++) { var v = mono[i]; if (v < 0) v = -v; if (v > m) m = v; }
      peaks[b] = m; if (m > max) max = m;
    }
    for (var k = 0; k < n; k++) peaks[k] = peaks[k] / max; // normalize to the loudest bar
    return peaks;
  }

  // Draw the waveform for a clip into a canvas sized to the timeline block.
  // Cheap + cached: after the first decode, redraws are synchronous from peaks.
  window.AsmAudio = window.AsmAudio || {};
  window.AsmAudio.drawWave = function (canvas, blobUrl, start, end, widthPx, color) {
    if (!canvas) return;
    var w = Math.max(8, Math.round(widthPx || canvas.clientWidth || 80));
    var h = canvas.clientHeight || 22;
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var k = keyOf(blobUrl, start, end) + '|' + w;
    if (canvas.dataset.wk === k) return;          // already drawn for this size/range
    canvas.dataset.wk = k;

    function paint(peaks) {
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      var g = canvas.getContext('2d'); if (!g) return;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      if (!peaks) return;                         // no audio track → leave empty
      var mid = h / 2, barW = w / peaks.length;
      g.fillStyle = color || 'rgba(52,211,153,0.85)';
      for (var i = 0; i < peaks.length; i++) {
        var bh = Math.max(1, peaks[i] * (h - 2));
        var x = i * barW;
        g.fillRect(x, mid - bh / 2, Math.max(0.6, barW * 0.7), bh);
      }
    }

    var pk = _peakCache[keyOf(blobUrl, start, end) + '|' + w];
    if (pk) { paint(pk); return; }
    decode(blobUrl).then(function (ab) {
      if (canvas.dataset.wk !== k) return;        // block re-rendered / range changed
      if (!ab) { paint(null); return; }
      var peaks = computePeaks(ab, start, end, Math.min(w, 240));
      _peakCache[keyOf(blobUrl, start, end) + '|' + w] = peaks;
      paint(peaks);
    });
  };

  // Encode a [start,end] slice of a decoded buffer as a 16 kHz mono 16-bit WAV blob.
  function encodeWav(ab, start, end) {
    var s0 = start || 0, s1 = (end == null ? ab.duration : end);
    var dur = Math.max(0.05, s1 - s0);
    var targetRate = 16000;
    var frames = Math.ceil(dur * targetRate);
    var OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    return new Promise(function (resolve) {
      try {
        var off = new OfflineCtx(1, frames, targetRate);
        var src = off.createBufferSource();
        src.buffer = ab;
        src.connect(off.destination);
        src.start(0, s0, dur);                    // render only the trimmed slice
        off.startRendering().then(function (rendered) {
          var samples = rendered.getChannelData(0);
          var wav = new ArrayBuffer(44 + samples.length * 2);
          var v = new DataView(wav);
          var str = function (o, s) { for (var i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
          str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
          str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
          v.setUint32(24, targetRate, true); v.setUint32(28, targetRate * 2, true);
          v.setUint16(32, 2, true); v.setUint16(34, 16, true);
          str(36, 'data'); v.setUint32(40, samples.length * 2, true);
          var off2 = 44;
          for (var i = 0; i < samples.length; i++) {
            var x = Math.max(-1, Math.min(1, samples[i]));
            v.setInt16(off2, x < 0 ? x * 32768 : x * 32767, true); off2 += 2;
          }
          resolve(new Blob([wav], { type: 'audio/wav' }));
        }).catch(function () { resolve(null); });
      } catch (e) { resolve(null); }
    });
  }

  // Transcribe a clip's spoken audio → plain text. Cached per clip+range.
  // Returns '' if there's no audio, the proxy is unavailable, or on error.
  window.AsmAudio.transcribeClip = function (blobUrl, start, end) {
    var key = keyOf(blobUrl, start, end);
    if (_txCache[key]) return _txCache[key];
    var p = decode(blobUrl).then(function (ab) {
      if (!ab) return '';
      return encodeWav(ab, start, end).then(function (wav) {
        if (!wav) return '';
        if (wav.size > 4.0 * 1024 * 1024) return ''; // base64 adds ~1/3 → keep JSON body under the 6 MB Lambda cap
        if (typeof window._proxyTranscribe !== 'function') return '';
        var file = new File([wav], 'audio.wav', { type: 'audio/wav' });
        return window._proxyTranscribe(file).then(function (resp) {
          if (!resp || !resp.ok) return '';
          return resp.json().then(function (d) { return (d && d.text ? String(d.text) : '').trim(); });
        }).catch(function () { return ''; });
      });
    }).catch(function () { return ''; });
    _txCache[key] = p;
    return p;
  };

  // True if a clip actually has a decodable audio track (for UI hints).
  window.AsmAudio.hasAudio = function (blobUrl) {
    return decode(blobUrl).then(function (ab) { return !!(ab && ab.length); });
  };

  // Drop caches for a clip (e.g. after it's removed) — optional housekeeping.
  window.AsmAudio.forget = function (blobUrl) {
    delete _decodeCache[blobUrl];
    Object.keys(_peakCache).forEach(function (k) { if (k.indexOf(blobUrl) === 0) delete _peakCache[k]; });
    Object.keys(_txCache).forEach(function (k) { if (k.indexOf(blobUrl) === 0) delete _txCache[k]; });
  };

})();
