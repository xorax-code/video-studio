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

  // ── Init ───────────────────────────────────────────────────────────────────
  function initGallery() {
    renderGallery();
    renderAssembler();
  }
  window.initGallery = initGallery;

  // ── Render Gallery ─────────────────────────────────────────────────────────
  function renderGallery() {
    var grid = document.getElementById('galleryGrid');
    var countEl = document.getElementById('galleryCount');
    if (!grid) return;

    var segs = window.segments || [];
    var clips = segs.filter(function(s) { return s.apiVideoUrl || s.apiVideoRaw; });

    if (countEl) countEl.textContent = clips.length ? clips.length + ' clip' + (clips.length !== 1 ? 's' : '') : '';

    if (!clips.length) {
      grid.innerHTML = '<div style="padding:28px 0;text-align:center;color:var(--text-3);font-size:11px;width:100%;">'
        + '🎬 Generated clips will appear here after running the API.<br>'
        + '<span style="opacity:0.5;">Use Generate Prompts → Run in the Replicator above</span></div>';
      return;
    }

    grid.innerHTML = '';
    clips.forEach(function(seg) {
      var idx = segs.indexOf(seg);
      var dur = 6;
      try { var po = JSON.parse(seg.veoPrompt || '{}'); dur = po.duration || 6; } catch(e) {}
      var url = seg.apiVideoUrl || seg.apiVideoRaw || '';
      var label = 'Scene ' + (idx + 1);
      var inAssembler = window._assemblerClips.some(function(c) { return c.segIdx === idx; });

      var card = document.createElement('div');
      card.className = 'gal-card';
      card.dataset.segIdx = idx;
      card.innerHTML =
        '<div class="gal-thumb">'
          + '<video src="' + url + '" muted playsinline loop preload="metadata" class="gal-video" tabindex="-1"></video>'
          + '<div class="gal-dur">' + dur + 's</div>'
          + (inAssembler ? '<div class="gal-badge-added">✓ Added</div>' : '')
        + '</div>'
        + '<div class="gal-meta">'
          + '<span class="gal-label">' + label + '</span>'
          + '<div class="gal-btns">'
            + '<button class="gal-btn gal-btn-add" onclick="galleryAddToAssembler(' + idx + ')" title="Add to assembler">'
              + (inAssembler ? '✓ Added' : '+ Assemble')
            + '</button>'
            + '<button class="gal-btn gal-btn-dl" onclick="galleryDownload(' + idx + ')" title="Download clip">⬇</button>'
          + '</div>'
        + '</div>';

      // Hover-to-play
      var vid = card.querySelector('.gal-video');
      card.addEventListener('mouseenter', function() { if (vid) vid.play().catch(function(){}); });
      card.addEventListener('mouseleave', function() { if (vid) { vid.pause(); vid.currentTime = 0; } });

      grid.appendChild(card);
    });
  }
  window.renderGallery = renderGallery;

  // ── Gallery actions ────────────────────────────────────────────────────────
  window.galleryAddToAssembler = function(segIdx) {
    var segs = window.segments || [];
    var seg = segs[segIdx];
    if (!seg) return;
    var already = window._assemblerClips.some(function(c) { return c.segIdx === segIdx; });
    if (already) {
      window._assemblerClips = window._assemblerClips.filter(function(c) { return c.segIdx !== segIdx; });
    } else {
      var dur = 6;
      try { var po = JSON.parse(seg.veoPrompt || '{}'); dur = parseInt(po.duration, 10) || 6; } catch(e) {}
      window._assemblerClips.push({
        segIdx: segIdx,
        start:  0,
        end:    dur,
        dur:    dur,
        blobUrl: seg.apiVideoRaw || seg.apiVideoUrl || '',  // prefer local blob over expiring Google URL
        mime:   seg.apiVideoMime || 'video/mp4',
        label:  'Scene ' + (segIdx + 1)
      });
    }
    renderGallery();
    renderAssembler();
    // Scroll assembler into view if adding
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

  window.galleryAddAllToAssembler = function() {
    var segs = window.segments || [];
    window._assemblerClips = [];
    segs.forEach(function(seg, idx) {
      if (!seg.apiVideoUrl && !seg.apiVideoRaw) return;
      var dur = 6;
      try { var po = JSON.parse(seg.veoPrompt || '{}'); dur = parseInt(po.duration, 10) || 6; } catch(e) {}
      window._assemblerClips.push({
        segIdx: idx, start: 0, end: dur, dur: dur,
        blobUrl: seg.apiVideoRaw || seg.apiVideoUrl || '',  // prefer local blob over expiring Google URL
        mime: seg.apiVideoMime || 'video/mp4',
        label: 'Scene ' + (idx + 1)
      });
    });
    renderGallery();
    renderAssembler();
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

  function _updateTimelineUI(asmIdx) {
    var clip = window._assemblerClips[asmIdx];
    if (!clip) return;
    var leftPct  = (clip.start / clip.dur) * 100;
    var rightPct = ((clip.dur - clip.end) / clip.dur) * 100;
    var usedSec  = clip.end - clip.start;

    var fill = document.getElementById('asm-tl-fill-' + asmIdx);
    var dl   = document.getElementById('asm-tl-dl-'   + asmIdx);
    var dr   = document.getElementById('asm-tl-dr-'   + asmIdx);
    var hl   = document.getElementById('asm-tl-hl-'   + asmIdx);
    var hr   = document.getElementById('asm-tl-hr-'   + asmIdx);
    var ts   = document.getElementById('asm-tl-ts-'   + asmIdx);
    var td   = document.getElementById('asm-tl-td-'   + asmIdx);
    var te   = document.getElementById('asm-tl-te-'   + asmIdx);

    if (fill) { fill.style.left = leftPct + '%';  fill.style.right = rightPct + '%'; }
    if (dl)   dl.style.width    = leftPct + '%';
    if (dr)   dr.style.width    = rightPct + '%';
    if (hl)   hl.style.left     = leftPct + '%';
    if (hr)   hr.style.right    = rightPct + '%';
    if (ts)   ts.textContent    = _fmtTime(clip.start);
    if (te)   te.textContent    = _fmtTime(clip.end);
    if (td)   td.textContent    = usedSec.toFixed(1) + 's';
  }

  // Global drag state — one handle active at a time
  var _tlDrag = null; // { asmIdx, side, trackEl, vidEl }

  function _initTimelineDrag(asmIdx, trackEl, vidEl) {
    var hl = document.getElementById('asm-tl-hl-' + asmIdx);
    var hr = document.getElementById('asm-tl-hr-' + asmIdx);

    function onHandleDown(side) {
      return function(e) {
        e.preventDefault();
        e.stopPropagation();
        _tlDrag = { asmIdx: asmIdx, side: side, trackEl: trackEl, vidEl: vidEl };
        document.body.style.cursor = 'ew-resize';
      };
    }

    if (hl) hl.addEventListener('mousedown', onHandleDown('start'));
    if (hr) hr.addEventListener('mousedown', onHandleDown('end'));

    // Click on track (not on handle) → seek preview
    trackEl.addEventListener('mousedown', function(e) {
      if (e.target === hl || e.target === hr ||
          e.target.classList.contains('asm-tl-hl') ||
          e.target.classList.contains('asm-tl-hr') ||
          e.target.classList.contains('asm-tl-grip')) return;
      var rect = trackEl.getBoundingClientRect();
      var pct  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      var clip = window._assemblerClips[asmIdx];
      var t    = pct * clip.dur;
      if (vidEl) { vidEl.currentTime = t; vidEl.play().catch(function(){}); }
      // Show playhead momentarily
      var ph = document.getElementById('asm-tl-ph-' + asmIdx);
      if (ph) { ph.style.display = 'block'; ph.style.left = (pct * 100) + '%'; }
      setTimeout(function() { if (ph) ph.style.display = 'none'; }, 1200);
    });
  }

  // Attach global move/up handlers once
  document.addEventListener('mousemove', function(e) {
    if (!_tlDrag) return;
    var d    = _tlDrag;
    var clip = window._assemblerClips[d.asmIdx];
    if (!clip) return;
    var rect = d.trackEl.getBoundingClientRect();
    var pct  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    var t    = pct * clip.dur;

    if (d.side === 'start') {
      clip.start = Math.max(0, Math.min(clip.end - 0.1, t));
    } else {
      clip.end = Math.min(clip.dur, Math.max(clip.start + 0.1, t));
    }

    _updateTimelineUI(d.asmIdx);

    // Seek the thumbnail video to the dragged point for live preview
    if (d.vidEl) { try { d.vidEl.currentTime = d.side === 'start' ? clip.start : clip.end; } catch(_) {} }

    // Update total duration label
    var totalEl = document.getElementById('assemblerTotal');
    if (totalEl) {
      var total = window._assemblerClips.reduce(function(s, c) { return s + (c.end - c.start); }, 0);
      totalEl.textContent = window._assemblerClips.length + ' clip' + (window._assemblerClips.length !== 1 ? 's' : '') + ' · ' + total.toFixed(1) + 's total';
    }
  });

  document.addEventListener('mouseup', function() {
    if (_tlDrag) { document.body.style.cursor = ''; _tlDrag = null; }
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

    var rows = document.getElementById('assemblerRows');
    if (!rows) return;
    rows.innerHTML = '';

    clips.forEach(function(clip, i) {
      var leftPct  = (clip.start / clip.dur) * 100;
      var rightPct = ((clip.dur - clip.end) / clip.dur) * 100;

      var row = document.createElement('div');
      row.className = 'asm-clip';
      row.draggable = true;
      row.dataset.asmIdx = i;

      row.innerHTML =
        '<div class="asm-drag-handle" title="Drag to reorder">⠿</div>'
        + '<div class="asm-thumb-wrap">'
          + '<video src="' + clip.blobUrl + '" muted playsinline preload="metadata" class="asm-thumb-vid"></video>'
        + '</div>'
        + '<div class="asm-info">'
          + '<div class="asm-clip-label">' + clip.label + '</div>'
          + '<div class="asm-clip-sub">' + clip.dur + 's original</div>'
        + '</div>'

        // ── Visual timeline trimmer ───────────────────────────────────────
        + '<div class="asm-timeline" id="asm-tl-' + i + '">'
          + '<div class="asm-tl-track" id="asm-tl-track-' + i + '">'
            + '<div class="asm-tl-dim" id="asm-tl-dl-' + i + '" style="left:0;width:' + leftPct  + '%;"></div>'
            + '<div class="asm-tl-fill" id="asm-tl-fill-' + i + '" style="left:' + leftPct + '%;right:' + rightPct + '%;"></div>'
            + '<div class="asm-tl-dim" id="asm-tl-dr-' + i + '" style="right:0;width:' + rightPct + '%;"></div>'
            + '<div class="asm-tl-hl" id="asm-tl-hl-' + i + '" style="left:' + leftPct  + '%;"><span class="asm-tl-grip">⋮⋮</span></div>'
            + '<div class="asm-tl-hr" id="asm-tl-hr-' + i + '" style="right:' + rightPct + '%;"><span class="asm-tl-grip">⋮⋮</span></div>'
            + '<div class="asm-tl-playhead" id="asm-tl-ph-' + i + '"></div>'
          + '</div>'
          + '<div class="asm-tl-times">'
            + '<span id="asm-tl-ts-' + i + '">' + _fmtTime(clip.start) + '</span>'
            + '<span id="asm-tl-td-' + i + '" class="asm-tl-dur">' + (clip.end - clip.start).toFixed(1) + 's</span>'
            + '<span id="asm-tl-te-' + i + '">' + _fmtTime(clip.end) + '</span>'
          + '</div>'
        + '</div>'

        + '<div class="asm-clip-actions">'
          + '<button class="asm-btn asm-btn-prev" onclick="assemblerPreviewClip(' + i + ')" title="Preview clip">▶</button>'
          + '<button class="asm-btn asm-btn-rm"   onclick="assemblerRemove('      + i + ')" title="Remove">✕</button>'
        + '</div>';

      var vid   = row.querySelector('.asm-thumb-vid');
      var track = row.querySelector('.asm-tl-track');

      // Hover-to-play thumb
      row.addEventListener('mouseenter', function() { if (vid) vid.play().catch(function(){}); });
      row.addEventListener('mouseleave', function() { if (vid) { vid.pause(); vid.currentTime = clip.start; } });

      rows.appendChild(row);

      // Init drag handles after DOM insertion
      _initTimelineDrag(i, track, vid);

      // Drag-to-reorder events
      row.addEventListener('dragstart', function(e) {
        if (_tlDrag) { e.preventDefault(); return; } // don't reorder while trimming
        _dragSrcIdx = i;
        e.dataTransfer.effectAllowed = 'move';
        row.classList.add('asm-dragging');
      });
      row.addEventListener('dragend', function() {
        row.classList.remove('asm-dragging');
        document.querySelectorAll('.asm-clip').forEach(function(r) { r.classList.remove('asm-drag-over'); });
      });
      row.addEventListener('dragover', function(e) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; row.classList.add('asm-drag-over'); });
      row.addEventListener('dragleave', function() { row.classList.remove('asm-drag-over'); });
      row.addEventListener('drop', function(e) {
        e.preventDefault();
        row.classList.remove('asm-drag-over');
        if (_dragSrcIdx === null || _dragSrcIdx === i) return;
        var moved = window._assemblerClips.splice(_dragSrcIdx, 1)[0];
        var targetIdx = parseInt(row.dataset.asmIdx);
        if (_dragSrcIdx < targetIdx) targetIdx--;
        window._assemblerClips.splice(targetIdx, 0, moved);
        _dragSrcIdx = null;
        renderAssembler();
        renderGallery();
      });
    });
  }
  window.renderAssembler = renderAssembler;

  // ── Assembler actions ──────────────────────────────────────────────────────
  window.assemblerSetTrim = function(idx, field, val) {
    var clip = window._assemblerClips[idx];
    if (!clip) return;
    val = Math.max(0, Math.min(clip.dur, isNaN(val) ? 0 : val));
    if (field === 'start') { clip.start = Math.min(val, clip.end - 0.1); }
    else                   { clip.end   = Math.max(val, clip.start + 0.1); }
    _updateTimelineUI(idx);
  };

  window.assemblerRemove = function(idx) {
    window._assemblerClips.splice(idx, 1);
    renderGallery();
    renderAssembler();
  };

  window.assemblerClearAll = function() {
    if (!window._assemblerClips.length) return;
    if (!confirm('Clear all clips from the assembler?')) return;
    window._assemblerClips = [];
    renderGallery();
    renderAssembler();
  };

  window.assemblerPreviewClip = function(idx) {
    var clip = window._assemblerClips[idx];
    if (!clip || !clip.blobUrl) return;
    // Open in a simple modal
    var existing = document.getElementById('asmPreviewModal');
    if (existing) existing.remove();
    var modal = document.createElement('div');
    modal.id = 'asmPreviewModal';
    modal.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.88);display:flex;align-items:center;justify-content:center;';
    modal.innerHTML =
      '<div style="position:relative;max-width:360px;width:90%;border-radius:14px;overflow:hidden;background:#000;">'
        + '<video src="' + clip.blobUrl + '#t=' + clip.start + ',' + clip.end + '" controls autoplay loop muted style="width:100%;display:block;max-height:70vh;"></video>'
        + '<button onclick="document.getElementById(\'asmPreviewModal\').remove()" '
          + 'style="position:absolute;top:10px;right:10px;background:rgba(0,0,0,0.6);border:none;color:#fff;font-size:18px;cursor:pointer;border-radius:50%;width:30px;height:30px;line-height:30px;text-align:center;">✕</button>'
        + '<div style="padding:8px 12px;font-size:11px;color:rgba(255,255,255,0.5);">' + clip.label + ' · ' + clip.start.toFixed(1) + 's – ' + clip.end.toFixed(1) + 's</div>'
      + '</div>';
    modal.addEventListener('click', function(e) { if (e.target === modal) modal.remove(); });
    document.body.appendChild(modal);
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
