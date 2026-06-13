// ===== MEDIA GALLERY + VIDEO ASSEMBLER =====
// Renders generated clips in a gallery strip and provides a drag-to-reorder
// assembler timeline with per-clip trim controls and FFmpeg.wasm export.

(function() {

  // ── State ──────────────────────────────────────────────────────────────────
  window._assemblerClips = window._assemblerClips || [];  // [{ segIdx, start, end, blobUrl, mime, label, dur }]
  var _galleryCollapsed  = false;
  var _assemblerCollapsed = false;
  var _dragSrcIdx = null;  // assembler drag source index
  var _ffmpegLoaded = false;

  // ── Timeline persistence (survives refresh / next session) ────────────────
  // We persist ONLY a lightweight record per clip — which scene/extra it is and
  // its in/out trim points — never the blob. On load we rebuild the full clips
  // from the user's saved segments, so the timeline (and your trims/splits/order)
  // comes back. Saved only on real user mutations, never on a render, so an empty
  // initial render can't wipe the saved timeline.
  var _asmRestoreAttempted = false;
  function _asmSave() {
    try {
      var recs = (window._assemblerClips || []).map(function (c) {
        return { segIdx: c.segIdx, extraIdx: (c.extraIdx == null ? -1 : c.extraIdx), start: c.start, end: c.end };
      });
      if (typeof DB !== 'undefined' && DB && DB.set) DB.set('sm_assembler_timeline', recs);
    } catch (_) {}
  }
  function _asmBuildClip(rec) {
    var segs = window.segments || [];
    var seg = segs[rec.segIdx];
    if (!seg) return null;
    var blobUrl, mime, dur, label;
    if (rec.extraIdx != null && rec.extraIdx >= 0) {
      var ex = seg.veoExtras && seg.veoExtras[rec.extraIdx];
      if (!ex || (!ex.apiVideoRaw && !ex.apiVideoUrl)) return null;
      blobUrl = ex.apiVideoRaw || ex.apiVideoUrl; mime = ex.apiVideoMime || 'video/mp4';
      dur = 8; try { dur = parseInt(JSON.parse(ex.veoPrompt || '{}').duration, 10) || 8; } catch (e) {}
      label = 'Scene ' + (rec.segIdx + 1) + ' · Clip ' + (rec.extraIdx + 2);
    } else {
      if (!seg.apiVideoRaw && !seg.apiVideoUrl) return null;
      blobUrl = seg.apiVideoRaw || seg.apiVideoUrl; mime = seg.apiVideoMime || 'video/mp4';
      dur = 6; try { dur = parseInt(JSON.parse(seg.veoPrompt || '{}').duration, 10) || 6; } catch (e) {}
      label = 'Scene ' + (rec.segIdx + 1);
    }
    var start = (typeof rec.start === 'number') ? rec.start : 0;
    var end   = (typeof rec.end   === 'number') ? rec.end   : dur;
    start = Math.max(0, Math.min(start, dur));
    end   = Math.max(start + 0.1, Math.min(end, dur));
    return { segIdx: rec.segIdx, extraIdx: (rec.extraIdx == null ? -1 : rec.extraIdx), start: start, end: end, dur: dur, blobUrl: blobUrl, mime: mime, label: label };
  }
  async function _asmRestoreOnce() {
    if (_asmRestoreAttempted) return;
    if (!(window.segments && window.segments.length)) return; // wait until clips are loaded
    if (window._assemblerClips && window._assemblerClips.length) { _asmRestoreAttempted = true; return; }
    _asmRestoreAttempted = true;
    try {
      var recs = (typeof DB !== 'undefined' && DB && DB.get) ? await DB.get('sm_assembler_timeline') : null;
      if (!recs || !recs.length) return;
      var rebuilt = [];
      recs.forEach(function (rec) { var c = _asmBuildClip(rec); if (c) rebuilt.push(c); });
      if (rebuilt.length) {
        window._assemblerClips = rebuilt;
        if (typeof window._asmSel !== 'number' || window._asmSel < 0) window._asmSel = 0;
        renderAssembler();
        if (typeof renderGallery === 'function') renderGallery();
      }
    } catch (_) {}
  }
  window._asmRestoreOnce = _asmRestoreOnce;

  // ── Init ───────────────────────────────────────────────────────────────────
  function initGallery() {
    renderGallery();
    renderAssembler();
    _asmRestoreOnce();
    // Safety net: segments may finish loading shortly after init
    setTimeout(function () { _asmRestoreOnce(); }, 1500);
  }
  window.initGallery = initGallery;

  // ── Render Gallery ─────────────────────────────────────────────────────────
  function renderGallery() {
    _asmRestoreOnce(); // restore a saved timeline once segments are available
    var grid = document.getElementById('galleryGrid');
    var countEl = document.getElementById('galleryCount');
    if (!grid) return;

    var segs = window.segments || [];

    // Build flat clip list: primary clips + continuation extras
    var clips = [];
    segs.forEach(function(seg, idx) {
      if (seg.apiVideoUrl || seg.apiVideoRaw) {
        var dur = 6;
        try { var po = JSON.parse(seg.veoPrompt || '{}'); dur = po.duration || 6; } catch(e) {}
        clips.push({ seg: seg, segIdx: idx, extraIdx: -1, dur: dur,
          url: seg.apiVideoRaw || seg.apiVideoUrl || '',
          mime: seg.apiVideoMime || 'video/mp4',
          label: 'Scene ' + (idx + 1) });
      }
      (seg.veoExtras || []).forEach(function(extra, j) {
        if (!(extra.apiVideoUrl || extra.apiVideoRaw)) return;
        var eDur = 8;
        try { eDur = JSON.parse(extra.veoPrompt || '{}').duration || 8; } catch(e) {}
        clips.push({ seg: seg, segIdx: idx, extraIdx: j, dur: eDur,
          url: extra.apiVideoRaw || extra.apiVideoUrl || '',
          mime: extra.apiVideoMime || 'video/mp4',
          label: 'Scene ' + (idx + 1) + ' · Clip ' + (j + 2) });
      });
    });

    if (countEl) countEl.textContent = clips.length ? clips.length + ' clip' + (clips.length !== 1 ? 's' : '') : '';

    if (!clips.length) {
      grid.innerHTML = '<div style="padding:28px 0;text-align:center;color:var(--text-3);font-size:11px;width:100%;">'
        + '🎬 Generated clips will appear here after running the API.<br>'
        + '<span style="opacity:0.5;">Use Generate Prompts → Run in the Replicator above</span></div>';
      return;
    }

    grid.innerHTML = '';
    clips.forEach(function(clip) {
      var inAssembler = window._assemblerClips.some(function(c) {
        return c.segIdx === clip.segIdx && (c.extraIdx === undefined ? -1 : c.extraIdx) === clip.extraIdx;
      });

      var card = document.createElement('div');
      card.className = 'gal-card';
      card.dataset.segIdx = clip.segIdx;
      card.innerHTML =
        '<div class="gal-thumb">'
          + '<video src="' + clip.url + '" muted playsinline loop preload="metadata" class="gal-video" tabindex="-1"></video>'
          + '<div class="gal-dur">' + clip.dur + 's</div>'
          + (inAssembler ? '<div class="gal-badge-added">✓ Added</div>' : '')
        + '</div>'
        + '<div class="gal-meta">'
          + '<span class="gal-label">' + clip.label + '</span>'
          + '<div class="gal-btns">'
            + '<button class="gal-btn gal-btn-add" onclick="galleryAddToAssembler(' + clip.segIdx + ',' + clip.extraIdx + ')" title="Add to assembler">'
              + (inAssembler ? '✓ Added' : '+ Assemble')
            + '</button>'
            + (clip.extraIdx === -1
              ? '<button class="gal-btn gal-btn-dl" onclick="galleryDownload(' + clip.segIdx + ')" title="Download clip">⬇</button>'
                + '<button class="gal-btn gal-btn-hd" onclick="galleryUpscale(' + clip.segIdx + ')" title="Download 1080p upscaled">HD</button>'
              : '<button class="gal-btn gal-btn-dl" onclick="(function(){var e=segments[' + clip.segIdx + '].veoExtras[' + clip.extraIdx + '];var a=document.createElement(\'a\');a.href=e.apiVideoRaw||e.apiVideoUrl;a.download=\'scene-' + (clip.segIdx+1) + '-clip-' + (clip.extraIdx+2) + '.mp4\';a.click();})()" title="Download clip">⬇</button>'
            )
          + '</div>'
        + '</div>';

      var vid = card.querySelector('.gal-video');
      card.addEventListener('mouseenter', function() { if (vid) vid.play().catch(function(){}); });
      card.addEventListener('mouseleave', function() { if (vid) { vid.pause(); vid.currentTime = 0; } });

      grid.appendChild(card);
    });
  }
  window.renderGallery = renderGallery;

  // ── Gallery actions ────────────────────────────────────────────────────────
  window.galleryAddToAssembler = function(segIdx, extraIdx) {
    if (extraIdx === undefined) extraIdx = -1;
    var segs = window.segments || [];
    var seg = segs[segIdx];
    if (!seg) return;
    var already = window._assemblerClips.some(function(c) {
      return c.segIdx === segIdx && (c.extraIdx === undefined ? -1 : c.extraIdx) === extraIdx;
    });
    if (already) {
      window._assemblerClips = window._assemblerClips.filter(function(c) {
        return !(c.segIdx === segIdx && (c.extraIdx === undefined ? -1 : c.extraIdx) === extraIdx);
      });
    } else {
      var blobUrl, mime, dur, label;
      if (extraIdx >= 0) {
        var extra = seg.veoExtras && seg.veoExtras[extraIdx];
        if (!extra) return;
        dur = 8; try { dur = parseInt(JSON.parse(extra.veoPrompt || '{}').duration, 10) || 8; } catch(e) {}
        blobUrl = extra.apiVideoRaw || extra.apiVideoUrl || '';
        mime    = extra.apiVideoMime || 'video/mp4';
        label   = 'Scene ' + (segIdx + 1) + ' · Clip ' + (extraIdx + 2);
      } else {
        dur = 6; try { var po = JSON.parse(seg.veoPrompt || '{}'); dur = parseInt(po.duration, 10) || 6; } catch(e) {}
        blobUrl = seg.apiVideoRaw || seg.apiVideoUrl || '';
        mime    = seg.apiVideoMime || 'video/mp4';
        label   = 'Scene ' + (segIdx + 1);
      }
      window._assemblerClips.push({
        segIdx: segIdx, extraIdx: extraIdx,
        start: 0, end: dur, dur: dur,
        blobUrl: blobUrl, mime: mime, label: label
      });
    }
    renderGallery();
    renderAssembler();
    _asmSave();
    if (!already) {
      var ap = document.getElementById('assemblerPanel');
      if (ap) ap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  };

  window.galleryDownload = function(segIdx) {
    // Route through downloadSegmentVideo so we always use a blob URL
    if (typeof window.downloadSegmentVideo === 'function') {
      window.downloadSegmentVideo(segIdx);
    }
  };

  // ── Shared 1080p upscale helper — works with both <button> and <select> ──
  async function _doUpscale(videoUrl, filename, elId) {
    if (!videoUrl) {
      if (typeof showToast === 'function') showToast('No video URL for this clip.', 'error');
      return;
    }
    var jwt = null;
    try {
      var _sbRef = (typeof _sb !== 'undefined' && _sb) ? _sb : window._sb;
      if (_sbRef) { var _sr = await _sbRef.auth.getSession(); jwt = (_sr && _sr.data && _sr.data.session && _sr.data.session.access_token) || null; }
    } catch(_) {}
    if (!jwt) jwt = (typeof window.getAuthToken === 'function' ? window.getAuthToken() : null) || localStorage.getItem('supabase_access_token') || localStorage.getItem('sb-token') || window._authToken || null;
    if (!jwt) {
      if (typeof showToast === 'function') showToast('Please log in to use 1080p download.', 'warning');
      return;
    }
    var el = document.getElementById(elId);
    var isSelect = el && el.tagName === 'SELECT';
    var originalLabel = isSelect ? (el.options[0] && el.options[0].text) : (el && el.textContent);
    function setElState(label, disabled) {
      if (!el) return;
      el.disabled = !!disabled;
      if (isSelect) { if (el.options[0]) el.options[0].text = label; el.selectedIndex = 0; }
      else el.textContent = label;
    }
    try {
      setElState('⏳ …', true);
      if (typeof showToast === 'function') showToast('Starting 1080p upscale…', 'info', 4000);
      var createRes  = await fetch('/.netlify/functions/upscale-video', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + jwt },
        body: JSON.stringify({ videoUrl: videoUrl }),
      });
      var createData = await createRes.json();
      if (!createRes.ok || !createData.jobName) throw new Error(createData.error || 'Failed to start upscale job.');
      var jobName = createData.jobName, outputGcsUri = createData.outputGcsUri;
      var maxAttempts = 60, attempt = 0;
      while (attempt < maxAttempts) {
        await new Promise(function(r) { setTimeout(r, 5000); });
        attempt++;
        var pollRes  = await fetch('/.netlify/functions/poll-upscale', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + jwt },
          body: JSON.stringify({ jobName: jobName, outputGcsUri: outputGcsUri, filename: filename }),
        });
        var pollData = await pollRes.json();
        if (pollData.state === 'FAILED') throw new Error(pollData.error || 'Upscale job failed.');
        if (pollData.state === 'SUCCEEDED' && pollData.downloadUrl) {
          // Fetch the (cross-origin) signed URL as a blob and download THAT. Setting
          // a.href directly to a cross-origin URL makes the browser ignore `download`
          // and NAVIGATE to it instead (the "leave website" prompt). A same-origin
          // blob URL downloads in place with no navigation.
          try {
            var _resp = await fetch(pollData.downloadUrl);
            var _blob = await _resp.blob();
            var _obj  = URL.createObjectURL(_blob);
            var a = document.createElement('a'); a.href = _obj; a.download = filename; a.click();
            setTimeout(function(){ URL.revokeObjectURL(_obj); }, 60000);
          } catch (_dlErr) {
            // CORS-blocked fallback: open in a new tab (doesn't navigate the app away).
            window.open(pollData.downloadUrl, '_blank');
          }
          if (typeof showToast === 'function') showToast('1080p download started!', 'success', 4000);
          setElState(originalLabel, false);
          return;
        }
        setElState('⏳ ' + Math.min(95, Math.round((attempt / maxAttempts) * 100)) + '%', true);
      }
      throw new Error('Upscale timed out after 5 minutes.');
    } catch(e) {
      console.error('[upscale]', e);
      if (typeof showToast === 'function') showToast('1080p failed: ' + (e.message || e), 'error', 6000);
      setElState(originalLabel, false);
    }
  }

  // Expose the upscaler so other modules (Studio, etc.) can offer 1080p too.
  window._doUpscale = _doUpscale;

  // ── 1080p for gallery clips (button, by segIdx) ───────────────────────────
  window.galleryUpscale = async function(segIdx) {
    var seg = (window.segments || [])[segIdx];
    if (!seg) return;
    return _doUpscale(seg.apiVideoUrl || seg.apiVideoRaw, 'scene-' + (segIdx + 1) + '-1080p.mp4', 'gal-hd-btn-' + segIdx);
  };

  // ── Download-resolution select handlers (segment cards) ──────────────────
  window.handleDlSel = function(sel, segIdx) {
    var v = sel.value; sel.selectedIndex = 0;
    if (v === '720p') { if (typeof downloadSegmentVideo === 'function') downloadSegmentVideo(segIdx); }
    else if (v === '1080p') { _doUpscale((window.segments[segIdx]||{}).apiVideoUrl || (window.segments[segIdx]||{}).apiVideoRaw, 'scene-' + (segIdx + 1) + '-1080p.mp4', sel.id); }
  };
  window.handleExtraDlSel = function(sel, segIdx, extraIdx) {
    var v = sel.value; sel.selectedIndex = 0;
    var seg = (window.segments || [])[segIdx];
    var extra = seg && seg.veoExtras && seg.veoExtras[extraIdx];
    if (!extra) return;
    if (v === '720p') {
      var a = document.createElement('a'); a.href = extra.apiVideoRaw || extra.apiVideoUrl;
      a.download = 'scene-' + (segIdx + 1) + '-clip-' + (extraIdx + 2) + '.mp4'; a.click();
    } else if (v === '1080p') {
      _doUpscale(extra.apiVideoUrl || extra.apiVideoRaw, 'scene-' + (segIdx + 1) + '-clip-' + (extraIdx + 2) + '-1080p.mp4', sel.id);
    }
  };

  window.galleryAddAllToAssembler = function() {
    var segs = window.segments || [];
    window._assemblerClips = [];
    segs.forEach(function(seg, idx) {
      // Primary clip
      if (seg.apiVideoUrl || seg.apiVideoRaw) {
        var dur = 6;
        try { var po = JSON.parse(seg.veoPrompt || '{}'); dur = parseInt(po.duration, 10) || 6; } catch(e) {}
        window._assemblerClips.push({
          segIdx: idx, extraIdx: -1, start: 0, end: dur, dur: dur,
          blobUrl: seg.apiVideoRaw || seg.apiVideoUrl || '',
          mime: seg.apiVideoMime || 'video/mp4',
          label: 'Scene ' + (idx + 1)
        });
      }
      // Continuation extras
      (seg.veoExtras || []).forEach(function(extra, j) {
        if (!extra.apiVideoUrl && !extra.apiVideoRaw) return;
        var eDur = 8;
        try { eDur = parseInt(JSON.parse(extra.veoPrompt || '{}').duration, 10) || 8; } catch(e) {}
        window._assemblerClips.push({
          segIdx: idx, extraIdx: j, start: 0, end: eDur, dur: eDur,
          blobUrl: extra.apiVideoRaw || extra.apiVideoUrl || '',
          mime: extra.apiVideoMime || 'video/mp4',
          label: 'Scene ' + (idx + 1) + ' · Clip ' + (j + 2)
        });
      });
    });
    renderGallery();
    renderAssembler();
    _asmSave();
  };

  window.toggleGallery = function() {
    _galleryCollapsed = !_galleryCollapsed;
    var body = document.getElementById('galleryBody');
    var icon = document.getElementById('galleryCollapseIcon');
    if (body) body.style.display = _galleryCollapsed ? 'none' : '';
    if (icon) icon.textContent = _galleryCollapsed ? '▶' : '▼';
  };

  // ── Timeline helpers ───────────────────────────────────────────────────────
  function _fmtTime(sec) {
    var m  = Math.floor(sec / 60);
    var s  = Math.floor(sec % 60);
    var ms = Math.floor((sec % 1) * 10);
    return m + ':' + (s < 10 ? '0' : '') + s + '.' + ms;
  }

  // ── Horizontal (CapCut-style) timeline state + preview controller ──────────
  if (typeof window._asmSel !== 'number') window._asmSel = -1; // selected clip index
  var _asmPlaying = false;
  var _asmCurIdx  = 0;     // clip currently loaded in the preview
  var _asmRAF     = null;

  function _asmUsed(c)       { return Math.max(0, (c.end - c.start)); }
  function _asmTotalUsed()   { return window._assemblerClips.reduce(function(s, c) { return s + _asmUsed(c); }, 0); }
  function _asmSeqStart(i)   { var t = 0; for (var k = 0; k < i; k++) t += _asmUsed(window._assemblerClips[k]); return t; }
  function _asmPreviewEl()   { return document.getElementById('asmPreviewVid'); }

  // Sequence time → { idx, local } (local = time inside the clip's source video)
  function _asmSeqToClip(t) {
    var clips = window._assemblerClips, acc = 0;
    for (var i = 0; i < clips.length; i++) {
      var u = _asmUsed(clips[i]);
      if (t < acc + u || i === clips.length - 1) {
        return { idx: i, local: clips[i].start + Math.max(0, Math.min(u, t - acc)) };
      }
      acc += u;
    }
    return { idx: 0, local: (clips[0] ? clips[0].start : 0) };
  }

  function _asmSetPlayhead(t) {
    var wrap = document.getElementById('asmTlWrap');
    var ph   = document.getElementById('asmPlayhead');
    var total = _asmTotalUsed();
    if (ph && wrap) {
      var pct = total > 0 ? (t / total) : 0;
      ph.style.left = (pct * wrap.offsetWidth) + 'px';
    }
    var lbl = document.getElementById('asmTimeLabel');
    if (lbl) lbl.textContent = _fmtTime(t) + ' / ' + _fmtTime(total);
  }

  function _asmLoadClip(idx, local, play) {
    var clip = window._assemblerClips[idx]; if (!clip) return;
    var v = _asmPreviewEl(); if (!v) return;
    _asmCurIdx = idx;
    if (v.getAttribute('data-src') !== clip.blobUrl) {
      v.src = clip.blobUrl; v.setAttribute('data-src', clip.blobUrl); v.load();
    }
    var seek = function() {
      try { v.currentTime = (typeof local === 'number') ? local : clip.start; } catch(_) {}
      if (play) v.play().catch(function(){});
    };
    if (v.readyState >= 1) seek(); else v.addEventListener('loadedmetadata', seek, { once: true });
  }

  function _asmSeekSeq(t) {
    var m = _asmSeqToClip(t);
    _asmLoadClip(m.idx, m.local, _asmPlaying);
    _asmSetPlayhead(t);
  }
  window._asmSeekSeq = _asmSeekSeq;

  function _asmTick() {
    if (!_asmPlaying) return;
    var v = _asmPreviewEl(), clips = window._assemblerClips, clip = clips[_asmCurIdx];
    if (v && clip) {
      if (v.currentTime >= clip.end - 0.02) {
        if (_asmCurIdx < clips.length - 1) {
          _asmLoadClip(_asmCurIdx + 1, clips[_asmCurIdx + 1].start, true);
        } else { _asmPause(); _asmSeekSeq(0); return; }
      }
      var seqT = _asmSeqStart(_asmCurIdx) + Math.max(0, (v.currentTime - clip.start));
      _asmSetPlayhead(seqT);
    }
    _asmRAF = requestAnimationFrame(_asmTick);
  }

  window.asmTogglePlay = function() {
    var clips = window._assemblerClips; if (!clips.length) return;
    if (_asmPlaying) { _asmPause(); return; }
    _asmPlaying = true;
    var btn = document.getElementById('asmPlayBtn'); if (btn) btn.textContent = '⏸';
    var v = _asmPreviewEl();
    if (!v.getAttribute('data-src')) _asmLoadClip(_asmCurIdx, clips[_asmCurIdx].start, true);
    else v.play().catch(function(){});
    if (_asmRAF) cancelAnimationFrame(_asmRAF);
    _asmRAF = requestAnimationFrame(_asmTick);
  };

  function _asmPause() {
    _asmPlaying = false;
    var v = _asmPreviewEl(); if (v) v.pause();
    var btn = document.getElementById('asmPlayBtn'); if (btn) btn.textContent = '▶';
    if (_asmRAF) { cancelAnimationFrame(_asmRAF); _asmRAF = null; }
  }
  window.asmPause = _asmPause;

  // ── Trim-handle drag (on the selected clip's green ends) ───────────────────
  var _tlDrag = null; // { idx, side, leftX, pxPerSec, startBase, block }

  function _asmHandleDown(idx, side, block) {
    return function(e) {
      e.preventDefault(); e.stopPropagation();
      var clip = window._assemblerClips[idx]; if (!clip) return;
      var rect = block.getBoundingClientRect();
      _tlDrag = { idx: idx, side: side, block: block, leftX: rect.left,
                  pxPerSec: rect.width / Math.max(0.1, _asmUsed(clip)), startBase: clip.start };
      document.body.style.cursor = 'ew-resize';
    };
  }

  document.addEventListener('mousemove', function(e) {
    if (!_tlDrag) return;
    var d = _tlDrag, clip = window._assemblerClips[d.idx]; if (!clip) return;
    var local = d.startBase + (e.clientX - d.leftX) / d.pxPerSec;
    if (d.side === 'start') clip.start = Math.max(0, Math.min(clip.end - 0.2, local));
    else                    clip.end   = Math.min(clip.dur, Math.max(clip.start + 0.2, local));
    var used = _asmUsed(clip);
    if (d.block) {
      d.block.style.flexGrow = Math.max(0.2, used);
      var dl = d.block.querySelector('.asm-cliph-dur'); if (dl) dl.textContent = used.toFixed(1) + 's';
    }
    var totalEl = document.getElementById('assemblerTotal');
    if (totalEl) {
      var n = window._assemblerClips.length;
      totalEl.textContent = n + ' clip' + (n !== 1 ? 's' : '') + ' · ' + _asmTotalUsed().toFixed(1) + 's total';
    }
  });

  document.addEventListener('mouseup', function() {
    if (_tlDrag) { document.body.style.cursor = ''; var i = _tlDrag.idx; _tlDrag = null; _asmSeekSeq(_asmSeqStart(i)); _asmSave(); }
  });

  // ── Render Assembler ───────────────────────────────────────────────────────
  function renderAssembler() {
    var timeline = document.getElementById('assemblerTimeline') || document.getElementById('assemblerPanel');
    var totalEl  = document.getElementById('assemblerTotal');
    var emptyEl  = document.getElementById('assemblerEmpty');
    if (!timeline) return;

    var clips = window._assemblerClips;
    var totalDur = clips.reduce(function(s, c) { return s + (c.end - c.start); }, 0);
    if (totalEl) totalEl.textContent = clips.length
      ? clips.length + ' clip' + (clips.length !== 1 ? 's' : '') + ' · ' + totalDur.toFixed(1) + 's total'
      : '';

    if (emptyEl) emptyEl.style.display = clips.length ? 'none' : 'flex';

    var editor = document.getElementById('assemblerEditor');
    if (editor) editor.style.display = clips.length ? 'block' : 'none';

    var track = document.getElementById('asmTrack');
    if (!track) return;
    if (window._asmSel >= clips.length) window._asmSel = clips.length - 1;
    if (window._asmSel < 0 && clips.length) window._asmSel = 0;
    track.innerHTML = '';

    clips.forEach(function(clip, i) {
      var used  = _asmUsed(clip);
      var block = document.createElement('div');
      block.className = 'asm-cliph' + (i === window._asmSel ? ' on' : '');
      block.style.flexGrow = Math.max(0.2, used);
      block.dataset.idx = i;
      block.draggable = true;

      block.innerHTML =
        '<video class="asm-cliph-thumb" src="' + clip.blobUrl + '#t=' + clip.start + '" muted playsinline preload="metadata"></video>'
        + '<div class="asm-cliph-grad"></div>'
        + '<div class="asm-cliph-label">' + clip.label + '</div>'
        + '<div class="asm-cliph-dur">' + used.toFixed(1) + 's</div>'
        + (i === window._asmSel
            ? '<div class="asm-cliph-hl" title="Trim start"></div><div class="asm-cliph-hr" title="Trim end"></div>'
            : '');

      track.appendChild(block);

      var tv = block.querySelector('.asm-cliph-thumb');

      // Click to select (ignore clicks on the trim handles)
      block.addEventListener('click', function(e) {
        if (e.target.classList.contains('asm-cliph-hl') || e.target.classList.contains('asm-cliph-hr')) return;
        if (_tlDrag) return;
        window.asmSelect(i);
      });

      // Hover-scrub the thumbnail
      block.addEventListener('mouseenter', function() { if (tv && i !== window._asmSel) { try { tv.currentTime = clip.start; tv.play().catch(function(){}); } catch(_) {} } });
      block.addEventListener('mouseleave', function() { if (tv) tv.pause(); });

      // Trim handles (only on selected clip)
      var hl = block.querySelector('.asm-cliph-hl'), hr = block.querySelector('.asm-cliph-hr');
      if (hl) hl.addEventListener('mousedown', _asmHandleDown(i, 'start', block));
      if (hr) hr.addEventListener('mousedown', _asmHandleDown(i, 'end', block));

      // Drag to reorder
      block.addEventListener('dragstart', function(e) {
        if (_tlDrag) { e.preventDefault(); return; }
        _dragSrcIdx = i; e.dataTransfer.effectAllowed = 'move'; block.classList.add('asm-dragging');
      });
      block.addEventListener('dragend', function() {
        block.classList.remove('asm-dragging');
        document.querySelectorAll('.asm-cliph').forEach(function(b) { b.classList.remove('asm-drag-over'); });
      });
      block.addEventListener('dragover', function(e) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; block.classList.add('asm-drag-over'); });
      block.addEventListener('dragleave', function() { block.classList.remove('asm-drag-over'); });
      block.addEventListener('drop', function(e) {
        e.preventDefault(); block.classList.remove('asm-drag-over');
        if (_dragSrcIdx === null || _dragSrcIdx === i) return;
        var moved = clips.splice(_dragSrcIdx, 1)[0];
        var targetIdx = i; if (_dragSrcIdx < targetIdx) targetIdx--;
        clips.splice(targetIdx, 0, moved);
        _dragSrcIdx = null; window._asmSel = targetIdx;
        renderAssembler(); renderGallery(); _asmSave();
      });
    });

    // Click the ruler to scrub the whole sequence
    var ruler = document.getElementById('asmRuler');
    if (ruler) ruler.onclick = function(e) {
      var rect = this.getBoundingClientRect();
      var pct  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      _asmSeekSeq(pct * _asmTotalUsed());
    };

    // Make sure the preview shows something and the playhead reflects selection
    var v = _asmPreviewEl();
    if (v && clips.length && !v.getAttribute('data-src')) _asmLoadClip(0, clips[0].start, false);
    if (!_asmPlaying) _asmSetPlayhead(window._asmSel >= 0 ? _asmSeqStart(window._asmSel) : 0);
  }
  window.renderAssembler = renderAssembler;

  // ── Assembler actions ──────────────────────────────────────────────────────
  // Select a clip (highlights it, shows trim handles, loads it into the preview)
  window.asmSelect = function(i) {
    if (i < 0 || i >= window._assemblerClips.length) return;
    window._asmSel = i;
    _asmPause();
    renderAssembler();
    var c = window._assemblerClips[i];
    if (c) { _asmLoadClip(i, c.start, false); _asmSetPlayhead(_asmSeqStart(i)); }
  };

  // Delete the selected clip
  window.asmDeleteSelected = function() {
    var i = window._asmSel;
    if (i < 0 || i >= window._assemblerClips.length) { if (typeof showToast === 'function') showToast('Click a clip to select it first.', 'warning'); return; }
    window._assemblerClips.splice(i, 1);
    window._asmSel = Math.min(i, window._assemblerClips.length - 1);
    _asmPause();
    renderGallery(); renderAssembler(); _asmSave();
    _asmSeekSeq(0);
  };

  // Back-compat: remove a clip by index
  window.assemblerRemove = function(idx) {
    if (idx < 0 || idx >= window._assemblerClips.length) return;
    window._assemblerClips.splice(idx, 1);
    if (window._asmSel >= window._assemblerClips.length) window._asmSel = window._assemblerClips.length - 1;
    renderGallery(); renderAssembler(); _asmSave();
  };

  // Split the SELECTED clip at the playhead (or its midpoint) into two clips
  window.asmSplitAtPlayhead = function() {
    var i = window._asmSel, clips = window._assemblerClips;
    if (i < 0 || i >= clips.length) { if (typeof showToast === 'function') showToast('Click a clip to select it, then Split.', 'warning'); return; }
    var clip = clips[i], used = _asmUsed(clip), local;
    var v = _asmPreviewEl();
    if (_asmCurIdx === i && v && v.getAttribute('data-src') === clip.blobUrl) local = v.currentTime;
    else local = clip.start + used / 2;
    local = Math.max(clip.start + 0.2, Math.min(clip.end - 0.2, local));
    if (clip.end - clip.start < 0.5) { if (typeof showToast === 'function') showToast('Clip is too short to split.', 'warning'); return; }
    var second = Object.assign({}, clip, { start: local, end: clip.end });
    clip.end = local;
    clips.splice(i + 1, 0, second);
    window._asmSel = i;
    renderGallery(); renderAssembler(); _asmSave();
    if (typeof showToast === 'function') showToast('Clip split — select either half and Delete to cut it out.', 'success', 3000);
  };

  window.assemblerClearAll = function() {
    if (!window._assemblerClips.length) return;
    if (!confirm('Clear all clips from the timeline?')) return;
    window._assemblerClips = [];
    window._asmSel = -1;
    _asmPause();
    var v = _asmPreviewEl(); if (v) { v.removeAttribute('src'); v.removeAttribute('data-src'); }
    renderGallery();
    renderAssembler();
    _asmSave();
  };

  window.toggleAssembler = function() {
    _assemblerCollapsed = !_assemblerCollapsed;
    var body = document.getElementById('assemblerBody');
    var icon = document.getElementById('assemblerCollapseIcon');
    if (body) body.style.display = _assemblerCollapsed ? 'none' : '';
    if (icon) icon.textContent = _assemblerCollapsed ? '▶' : '▼';
  };

  // ── Export ─────────────────────────────────────────────────────────────────
  // Strategy:
  //   • 1 clip, no trim  → direct MP4 download (instant)
  //   • Multiple clips, no trim → ZIP of individual MP4s via JSZip (fast, no WASM)
  //   • Any clip has trim → FFmpeg.wasm (slow; requires COEP headers — may hang on Netlify)
  window.assemblerExport = function() {
    var clips = window._assemblerClips;
    if (!clips.length) { if (typeof showToast === 'function') showToast('Add clips to the assembler first.', 'warning'); return; }

    var needsTrim = clips.some(function(c) { return c.start > 0.01 || c.end < c.dur - 0.01; });

    // Single clip, no trim — direct download
    if (clips.length === 1 && !needsTrim) {
      var a = document.createElement('a');
      a.href = clips[0].blobUrl;
      a.download = 'scene-' + (clips[0].segIdx + 1) + '.mp4';
      a.click();
      if (typeof showToast === 'function') showToast('Clip downloaded.', 'success');
      return;
    }

    // Multiple clips, no trim — ZIP (fast, no WASM required)
    if (!needsTrim) {
      _exportAsZip(clips);
      return;
    }

    // Clips have trim points — need FFmpeg (may be slow / require headers)
    _exportWithFFmpeg(clips);
  };

  // ── 1080p stitched export — server-side Cloud Transcoder concat + upscale ──
  window.assemblerExport1080 = async function() {
    var clips = window._assemblerClips;
    if (!clips.length) { if (typeof showToast === 'function') showToast('Add clips to the timeline first.', 'warning'); return; }

    var jwt = null;
    try {
      var _sbRef = (typeof _sb !== 'undefined' && _sb) ? _sb : window._sb;
      if (_sbRef) { var _sr = await _sbRef.auth.getSession(); jwt = (_sr && _sr.data && _sr.data.session && _sr.data.session.access_token) || null; }
    } catch(_) {}
    if (!jwt) jwt = (typeof window.getAuthToken === 'function' ? window.getAuthToken() : null) || localStorage.getItem('supabase_access_token') || localStorage.getItem('sb-token') || window._authToken || null;
    if (!jwt) { if (typeof showToast === 'function') showToast('Please log in to export 1080p.', 'warning'); return; }

    // Resolve each clip's cloud (GCS) source URL + trim offsets, in timeline order
    var segs = window.segments || [];
    var payload = [];
    for (var i = 0; i < clips.length; i++) {
      var c = clips[i], seg = segs[c.segIdx], src = '';
      if (seg) {
        if (c.extraIdx != null && c.extraIdx >= 0) {
          var ex = seg.veoExtras && seg.veoExtras[c.extraIdx];
          src = (ex && ex.apiVideoUrl) || '';
        } else {
          src = seg.apiVideoUrl || '';
        }
      }
      if (!src || src.indexOf('storage.googleapis.com') === -1) {
        if (typeof showToast === 'function') showToast('Clip ' + (i + 1) + ' (' + (c.label || '') + ') has no cloud source — regenerate that clip, then re-add it.', 'error', 9000);
        return;
      }
      payload.push({
        videoUrl: src,
        start: (c.start > 0.05) ? c.start : null,
        end:   (c.end < c.dur - 0.05) ? c.end : null,
      });
    }

    var btn   = document.getElementById('assemblerExport1080Btn');
    var btn720 = document.getElementById('assemblerExportBtn');
    var prog  = document.getElementById('assemblerExportProgress');
    var pBar  = document.getElementById('assemblerExportBar');
    var pLbl  = document.getElementById('assemblerExportLabel');
    function setProg(pct, label) { if (prog) prog.style.display = 'flex'; if (pBar) pBar.style.width = pct + '%'; if (pLbl) pLbl.textContent = label; }
    function done(label) { if (btn) { btn.disabled = false; btn.innerHTML = label || '<i class="ti ti-sparkles" style="font-size:13px;margin-right:5px;vertical-align:-1px;"></i>1080p MP4'; } if (btn720) btn720.disabled = false; if (prog) prog.style.display = 'none'; }

    if (btn)   { btn.disabled = true; btn.textContent = 'Stitching…'; }
    if (btn720) btn720.disabled = true;
    setProg(4, 'Starting 1080p stitch (this can take a few minutes)…');

    try {
      var createRes = await fetch('/.netlify/functions/assemble-1080p', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + jwt },
        body: JSON.stringify({ clips: payload }),
      });
      var createData = await createRes.json();
      if (!createRes.ok || !createData.jobName) throw new Error(createData.error || 'Failed to start the stitch job.');

      var jobName = createData.jobName, outputGcsUri = createData.outputGcsUri;
      var maxAttempts = 150, attempt = 0; // ~12.5 min ceiling
      while (attempt < maxAttempts) {
        await new Promise(function(r) { setTimeout(r, 5000); });
        attempt++;
        var pollRes = await fetch('/.netlify/functions/poll-upscale', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + jwt },
          body: JSON.stringify({ jobName: jobName, outputGcsUri: outputGcsUri, filename: 'assembled-1080p.mp4' }),
        });
        var pollData = await pollRes.json();
        if (pollData.state === 'FAILED') throw new Error(pollData.error || 'Stitch job failed.');
        if (pollData.state === 'SUCCEEDED' && pollData.downloadUrl) {
          var a = document.createElement('a'); a.href = pollData.downloadUrl; a.download = 'assembled-1080p.mp4'; a.click();
          if (typeof showToast === 'function') showToast('1080p video ready — download started!', 'success', 5000);
          done();
          return;
        }
        setProg(Math.min(95, 8 + Math.round((attempt / maxAttempts) * 90)), 'Rendering 1080p video… (' + (attempt * 5) + 's)');
      }
      throw new Error('Stitch timed out. Try fewer clips or retry.');
    } catch(e) {
      console.error('[assemble-1080p]', e);
      if (typeof showToast === 'function') showToast('1080p stitch failed: ' + (e.message || e), 'error', 9000);
      done();
    }
  };

  // ── ZIP export — JSZip, no FFmpeg, works without COEP headers ──────────────
  async function _exportAsZip(clips) {
    var btn      = document.getElementById('assemblerExportBtn');
    var prog     = document.getElementById('assemblerExportProgress');
    var progBar  = document.getElementById('assemblerExportBar');
    var progLabel = document.getElementById('assemblerExportLabel');

    function setProgress(pct, label) {
      if (prog)      prog.style.display     = 'flex';
      if (progBar)   progBar.style.width    = pct + '%';
      if (progLabel) progLabel.textContent  = label;
    }
    function resetBtn(label) {
      if (btn) { btn.disabled = false; btn.textContent = label || '⬇ Download'; }
      if (prog) prog.style.display = 'none';
    }

    if (btn) { btn.disabled = true; btn.textContent = 'Packing…'; }
    setProgress(5, 'Loading…');

    try {
      // Load JSZip from cdnjs (pure JS, ~100KB, no WASM)
      if (!window.JSZip) {
        await new Promise(function(resolve, reject) {
          var s = document.createElement('script');
          s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
          s.onload = resolve;
          s.onerror = reject;
          document.head.appendChild(s);
        });
      }

      var zip = new window.JSZip();

      for (var i = 0; i < clips.length; i++) {
        var clip = clips[i];
        var pct  = 10 + Math.round((i / clips.length) * 80);
        setProgress(pct, 'Packing clip ' + (i + 1) + ' of ' + clips.length + '…');
        var res = await fetch(clip.blobUrl);
        if (!res.ok) throw new Error('Could not fetch clip ' + (i + 1));
        var buf = await res.arrayBuffer();
        zip.file('scene-' + (i + 1) + '.mp4', buf);
      }

      setProgress(92, 'Creating ZIP…');
      var zipBlob = await zip.generateAsync({ type: 'blob', compression: 'STORE' }); // STORE = no recompression, instant
      var url = URL.createObjectURL(zipBlob);
      var a   = document.createElement('a');
      a.href  = url;
      a.download = 'video-clips.zip';
      a.click();
      setTimeout(function() { URL.revokeObjectURL(url); }, 10000);

      setProgress(100, 'Done!');
      setTimeout(function() { resetBtn('⬇ Download'); }, 2000);
      if (typeof showToast === 'function') showToast(clips.length + ' clips saved to ZIP!', 'success', 4000);

    } catch(e) {
      console.error('[ZIP export]', e);
      resetBtn('⬇ Download');
      if (typeof showToast === 'function') showToast('Download failed: ' + (e.message || e), 'error', 5000);
    }
  };

  function _exportWithFFmpeg(clips) {
    var btn = document.getElementById('assemblerExportBtn');
    var prog = document.getElementById('assemblerExportProgress');
    var progBar = document.getElementById('assemblerExportBar');
    var progLabel = document.getElementById('assemblerExportLabel');

    function setProgress(pct, label) {
      if (prog)     prog.style.display = 'flex';
      if (progBar)  progBar.style.width = pct + '%';
      if (progLabel) progLabel.textContent = label;
    }
    function resetBtn() {
      if (btn) { btn.disabled = false; btn.textContent = '⬇ Export MP4'; }
      if (prog) prog.style.display = 'none';
    }

    if (btn) { btn.disabled = true; btn.textContent = 'Loading FFmpeg…'; }
    setProgress(5, 'Loading FFmpeg…');

    // Load FFmpeg.wasm from CDN.
    // Requires both @ffmpeg/ffmpeg (exposes window.FFmpeg) AND @ffmpeg/util
    // (exposes window.FFmpegUtil with toBlobURL). Load them sequentially so
    // _runFFmpeg is only called once both are available.
    if (!window.FFmpeg || !window.FFmpegUtil) {
      var ffmpegLoaded = !!window.FFmpeg;
      var utilLoaded   = !!window.FFmpegUtil;
      // FIX C-3: latch counter prevents _runFFmpeg being called twice on simultaneous loads
      var _pendingLoads = (!ffmpegLoaded ? 1 : 0) + (!utilLoaded ? 1 : 0);

      function _onBothLoaded() {
        _pendingLoads--;
        if (_pendingLoads <= 0 && window.FFmpeg && window.FFmpegUtil) {
          _runFFmpeg(clips, setProgress, resetBtn);
        }
      }
      function _onScriptError() {
        resetBtn();
        if (typeof showToast === 'function') showToast('FFmpeg failed to load — check your internet connection.', 'error');
      }

      if (!ffmpegLoaded) {
        var s1 = document.createElement('script');
        s1.src = 'https://unpkg.com/@ffmpeg/ffmpeg@0.12.6/dist/umd/ffmpeg.js';
        s1.onload = _onBothLoaded;
        s1.onerror = _onScriptError;
        document.head.appendChild(s1);
      }
      if (!utilLoaded) {
        var s2 = document.createElement('script');
        s2.src = 'https://unpkg.com/@ffmpeg/util@0.12.1/dist/umd/index.js';
        s2.onload = _onBothLoaded;
        s2.onerror = _onScriptError;
        document.head.appendChild(s2);
      }
    } else {
      _runFFmpeg(clips, setProgress, resetBtn);
    }
  }

  async function _runFFmpeg(clips, setProgress, resetBtn) {
    try {
      var btn = document.getElementById('assemblerExportBtn');
      if (btn) btn.textContent = 'Assembling…';
      setProgress(10, 'Preparing clips…');

      var { FFmpeg } = window.FFmpeg || {};
      var { fetchFile, toBlobURL } = window.FFmpegUtil || {};

      if (!FFmpeg) throw new Error('FFmpeg not available — requires HTTPS + cross-origin headers (deploy to Netlify first).');

      var ff = new FFmpeg();
      ff.on('progress', function(p) {
        setProgress(10 + Math.round(p.progress * 80), 'Assembling ' + Math.round(p.progress * 100) + '%…');
      });

      var baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.4/dist/umd';
      await ff.load({ coreURL: await toBlobURL(baseURL + '/ffmpeg-core.js', 'text/javascript'),
                      wasmURL: await toBlobURL(baseURL + '/ffmpeg-core.wasm', 'application/wasm') });

      setProgress(25, 'Writing clips…');
      var concatLines = '';
      for (var i = 0; i < clips.length; i++) {
        var clip = clips[i];
        var fname = 'clip' + i + '.mp4';
        var resp = await fetch(clip.blobUrl);
        var buf  = await resp.arrayBuffer();
        await ff.writeFile(fname, new Uint8Array(buf));

        // Trim if needed
        var trimmed = 'trimmed' + i + '.mp4';
        var needsTrim = clip.start > 0 || clip.end < clip.dur;
        if (needsTrim) {
          await ff.exec(['-ss', String(clip.start), '-to', String(clip.end), '-i', fname, '-c', 'copy', trimmed]);
          concatLines += 'file \'' + trimmed + '\'\n';
        } else {
          concatLines += 'file \'' + fname + '\'\n';
        }
        setProgress(25 + Math.round((i / clips.length) * 40), 'Processing clip ' + (i+1) + '/' + clips.length + '…');
      }

      // Write concat list
      await ff.writeFile('concat.txt', concatLines);
      setProgress(70, 'Stitching video…');
      await ff.exec(['-f', 'concat', '-safe', '0', '-i', 'concat.txt', '-c', 'copy', 'output.mp4']);

      setProgress(95, 'Downloading…');
      var data = await ff.readFile('output.mp4');
      // Pass the Uint8Array directly — using data.buffer would include the entire
      // backing ArrayBuffer even if data is a view with a non-zero byteOffset,
      // which produces a corrupt or oversized blob.
      var blob = new Blob([data], { type: 'video/mp4' });
      var url  = URL.createObjectURL(blob);
      var a    = document.createElement('a');
      a.href = url; a.download = 'assembled-video.mp4'; a.click();
      setTimeout(function() { URL.revokeObjectURL(url); }, 5000);

      setProgress(100, 'Done!');
      setTimeout(resetBtn, 2000);
      if (typeof showToast === 'function') showToast('Video exported successfully!', 'success', 4000);

    } catch(e) {
      console.error('[Assembler] FFmpeg error:', e);
      resetBtn();
      if (typeof showToast === 'function') showToast('Export failed: ' + e.message, 'error', 6000);
    }
  }

  // -- Hook into renderSegments so gallery auto-refreshes
  var _origRenderSegments = window.renderSegments;
  window.renderSegments = function() {
    if (typeof _origRenderSegments === 'function') _origRenderSegments.apply(this, arguments);
    renderGallery();
  };

  // Init on load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initGallery);
  } else {
    initGallery();
  }

})();
