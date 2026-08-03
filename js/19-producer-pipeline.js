  // ═══════════════════════════════════════════════════════════════════════════
  // PRODUCER PIPELINE  (js/19-producer-pipeline.js)
  // ─────────────────────────────────────────────────────────────────────────
  // Agentic NB→Veo staggered pipeline for Video Producer mode.
  //
  // Each segment runs in two phases:
  //   1. NB frame   — sequential, 15 s apart (Vertex AI Imagen quota ~5 QPM)
  //   2. Veo clip   — fires immediately after its NB frame is ready; all Veo
  //                   jobs run concurrently (Vertex AI Veo quota = 50 RPM)
  //
  // Dependencies (must load before this module):
  //   15-veo-api.js  — window.generateVeoClipViaAPI, window._fetchVideoAsBlob
  //   17-nb-api.js   — window.generateNbComposite
  // ═══════════════════════════════════════════════════════════════════════════

  (function () {
    'use strict';

    // ── Module state ──────────────────────────────────────────────────────────
    var _ppRunning  = false;
    var _ppStatuses = {};   // { segIdx: { nb: {status,msg}, veo: {status,msg} } }

    // ── Status panel ──────────────────────────────────────────────────────────
    function _ppOpenStatusPanel(total) {
      var existing = document.getElementById('ppStatusModal');
      if (existing) existing.remove();
      _ppStatuses = {};

      var modal = document.createElement('div');
      modal.id = 'ppStatusModal';
      modal.style.cssText = 'position:fixed;inset:0;z-index:99992;background:rgba(0,0,0,0.80);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;padding:16px;';
      modal.innerHTML = ''
        + '<div style="background:var(--surface);border:1px solid rgba(52,211,153,0.35);border-radius:14px;padding:20px;width:100%;max-width:500px;max-height:88vh;overflow-y:auto;box-shadow:0 24px 80px rgba(0,0,0,0.65);font-family:inherit;display:flex;flex-direction:column;gap:12px;">'

          // ── Header ──
          + '<div style="display:flex;align-items:center;gap:10px;">'
            + '<div style="width:36px;height:36px;border-radius:9px;background:rgba(52,211,153,0.15);border:1px solid rgba(52,211,153,0.35);display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;">⚡</div>'
            + '<div style="flex:1;">'
              + '<div style="font-size:14px;font-weight:800;color:var(--text-1);">Pipeline Running</div>'
              + '<div style="font-size:11px;color:var(--text-3);">'
                + total + ' scene' + (total !== 1 ? 's' : '') + '  ·  NB frame → Veo clip  ·  ~' + Math.round(total * 0.9) + ' min'
              + '</div>'
            + '</div>'
          + '</div>'

          // ── Legend ──
          + '<div style="display:flex;gap:10px;flex-wrap:wrap;font-size:10px;color:var(--text-3);">'
            + '<span><span style="color:#38bdf8;">⟳</span> generating</span>'
            + '<span><span style="color:#34d399;">✅</span> done</span>'
            + '<span><span style="color:#f87171;">❌</span> error</span>'
            + '<span><span style="color:var(--text-4);">⏳</span> queued</span>'
          + '</div>'

          // ── Per-scene rows ──
          + '<div id="ppSceneRows" style="display:flex;flex-direction:column;gap:4px;"></div>'

          // ── Progress bar ──
          + '<div>'
            + '<div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-3);margin-bottom:5px;">'
              + '<span id="ppProgressLabel">Starting…</span>'
              + '<span id="ppProgressPct">0%</span>'
            + '</div>'
            + '<div style="height:5px;background:var(--surface-3);border-radius:3px;overflow:hidden;">'
              + '<div id="ppProgressBar" style="height:100%;width:0%;background:linear-gradient(90deg,#34d399,#10b981);border-radius:3px;transition:width 0.5s;"></div>'
            + '</div>'
          + '</div>'

          // ── Dismiss ──
          + '<button onclick="document.getElementById(\'ppStatusModal\').remove()" '
            + 'style="padding:8px;background:var(--glass-2);border:1px solid var(--glass-border);border-radius:7px;color:var(--text-3);font-size:11px;cursor:pointer;font-family:inherit;">'
            + 'Close  <span style="opacity:0.6;">(pipeline continues in background)</span>'
          + '</button>'

        + '</div>';

      document.body.appendChild(modal);
    }

    // ── Ensure a scene row exists in the panel ────────────────────────────────
    function _ppEnsureRow(segIdx) {
      var rows = document.getElementById('ppSceneRows');
      if (!rows) return;
      if (document.getElementById('pp-row-' + segIdx)) return;

      var row = document.createElement('div');
      row.id = 'pp-row-' + segIdx;
      row.style.cssText = 'display:grid;grid-template-columns:52px 1fr 1fr;align-items:center;gap:6px;padding:6px 10px;background:var(--surface-2);border-radius:7px;border:1px solid var(--border);';
      row.innerHTML = ''
        + '<span style="font-size:10px;font-weight:700;color:var(--text-3);">Scene ' + (segIdx + 1) + '</span>'
        + '<div id="pp-nb-' + segIdx  + '" class="pp-phase-chip" style="font-size:10px;padding:3px 7px;border-radius:4px;background:var(--surface-3);border:1px solid var(--border);color:var(--text-4);">⏳ NB: queued</div>'
        + '<div id="pp-veo-' + segIdx + '" class="pp-phase-chip" style="font-size:10px;padding:3px 7px;border-radius:4px;background:var(--surface-3);border:1px solid var(--border);color:var(--text-4);">· Veo: waiting</div>';
      rows.appendChild(row);
    }

    // ── Update a single phase chip ────────────────────────────────────────────
    var _ppChipCfg = {
      queued:     { bg: 'var(--surface-3)',          border: 'var(--border)',              color: 'var(--text-4)', icon: '⏳' },
      generating: { bg: 'rgba(56,189,248,0.12)',     border: 'rgba(56,189,248,0.4)',       color: '#38bdf8',      icon: '⟳' },
      done:       { bg: 'rgba(52,211,153,0.12)',     border: 'rgba(52,211,153,0.4)',       color: '#34d399',      icon: '✅' },
      error:      { bg: 'rgba(239,68,68,0.10)',      border: 'rgba(239,68,68,0.35)',       color: '#f87171',      icon: '❌' },
      skipped:    { bg: 'rgba(120,120,120,0.08)',    border: 'rgba(120,120,120,0.2)',      color: 'var(--text-4)', icon: '—' },
    };

    function _ppSetPhase(segIdx, phase, status, msg) {
      if (!_ppStatuses[segIdx]) _ppStatuses[segIdx] = {};
      _ppStatuses[segIdx][phase] = { status: status, msg: msg };

      _ppEnsureRow(segIdx);

      var el = document.getElementById('pp-' + phase + '-' + segIdx);
      if (!el) return;

      var cfg   = _ppChipCfg[status] || _ppChipCfg.queued;
      var label = (phase === 'nb' ? 'NB' : 'Veo') + ': ' + msg;

      el.style.background  = cfg.bg;
      el.style.borderColor = cfg.border;
      el.style.color       = cfg.color;
      el.textContent       = cfg.icon + ' ' + label;
    }

    // ── Progress bar ──────────────────────────────────────────────────────────
    function _ppUpdateProgress(nbDone, veoDone, nbTotal, veoTotal) {
      // Progress = fraction of all phase steps done (NB + Veo, Veo may include extras)
      var steps     = (nbTotal || 0) + (veoTotal || 0);
      var stepsDone = nbDone + veoDone;
      var pct = steps > 0 ? Math.round((stepsDone / steps) * 100) : 0;

      var bar   = document.getElementById('ppProgressBar');
      var label = document.getElementById('ppProgressLabel');
      var pctEl = document.getElementById('ppProgressPct');

      if (bar)   bar.style.width   = pct + '%';
      if (pctEl) pctEl.textContent = pct + '%';
      if (label) label.textContent = 'NB: ' + nbDone + '/' + (nbTotal||0) + '  ·  Veo: ' + veoDone + '/' + (veoTotal||0);
    }

    // ── Run Pipeline button state ─────────────────────────────────────────────
    function _ppSetBtnState(running) {
      var btn = document.getElementById('runPipelineBtn');
      if (!btn) return;
      if (running) {
        btn.disabled     = true;
        btn.textContent  = '⟳ Pipeline Running…';
        btn.style.opacity = '0.7';
      } else {
        btn.disabled      = false;
        btn.innerHTML     = '<i class="ti ti-player-play" style="font-size:12px;"></i> Run Pipeline';
        btn.style.opacity = '1';
      }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // MAIN ENTRY POINT
    // ═══════════════════════════════════════════════════════════════════════════
    window.runProducerPipeline = async function () {

      if (_ppRunning) {
        if (typeof showToast === 'function') showToast('Pipeline is already running.', 'warning');
        return;
      }

      // ── Prereq checks ───────────────────────────────────────────────────────
      var allSegs = window.segments || [];
      // Snapshot the live segments array. If the user switches projects or clears
      // the video mid-run, window.segments is reassigned to a NEW array; we detect
      // that and bail cleanly instead of writing clips onto the orphaned old array.
      var _segsAtStart = window.segments;
      var _projChangedToastShown = false;
      function _ppProjectChanged() {
        if (window.segments === _segsAtStart) return false;
        if (!_projChangedToastShown) {
          _projChangedToastShown = true;
          if (typeof showToast === 'function')
            showToast('Project changed — producer run stopped.', 'warning', 6000);
        }
        return true;
      }
      var toRun   = allSegs.filter(function (s) {
        return s._scriptOnly && ((s.nbPrompt || '').trim() || s.frameDataUrl) && (s.veoPrompt || '').trim();
      });

      if (!toRun.length) {
        if (typeof showToast === 'function') showToast('Generate prompts first (Step 2) — no scenes are ready for the pipeline.', 'warning', 5000);
        return;
      }
      if (!window.avatarImageDataUrl) {
        if (typeof showToast === 'function') showToast('Upload your avatar photo first.', 'warning');
        return;
      }

      // ── Setup ───────────────────────────────────────────────────────────────
      _ppRunning = true;
      _ppSetBtnState(true);

      try {  // try/finally ensures _ppRunning + button reset even on unexpected throw

      var total       = toRun.length;
      // Total Veo jobs = 1 primary per segment + continuation extras
      var totalVeoJobs = toRun.reduce(function(acc, s) {
        return acc + 1 + ((s.veoExtras || []).filter(function(e){ return (e.veoPrompt||'').trim(); }).length);
      }, 0);
      var nbDone   = 0;
      var veoDone  = 0;
      var veoFail  = 0;
      var aborted  = false;

      // Model key from admin settings
      var adm      = (typeof getAdminSettings === 'function') ? getAdminSettings() : {};
      var dm       = (adm.defaultModel || 'Veo 3.1 Lite').toLowerCase();
      var modelKey = dm.includes('omni') ? 'omni' : dm.includes('fast') ? 'fast' : dm.includes('standard') ? 'standard' : 'lite';
      // Omni Flash uses the user-chosen clip length (4/6/8/10s), not the scene's Veo length.
      var _ppOmniDur = ([4, 6, 8, 10].indexOf(parseInt(window._omniDurationSecs, 10)) !== -1) ? parseInt(window._omniDurationSecs, 10) : 8;

      // Open UI
      _ppOpenStatusPanel(total);

      // Initialise all rows as queued
      toRun.forEach(function (seg) {
        var idx = allSegs.indexOf(seg);
        _ppSetPhase(idx, 'nb',  'queued', 'queued');
        _ppSetPhase(idx, 'veo', 'queued', 'waiting');
      });

      // ── Staggered pipeline ──────────────────────────────────────────────────
      // NB runs sequentially (15 s apart) to respect Vertex AI Imagen quota.
      // As each NB finishes its Veo job fires immediately and runs concurrently.
      var veoPromises = [];

      for (var i = 0; i < toRun.length && !aborted; i++) {
        var seg    = toRun[i];
        var segIdx = allSegs.indexOf(seg);

        // ── Phase 1: NB composite ──────────────────────────────────────────
        _ppSetPhase(segIdx, 'nb', 'generating', 'Generating start frame…');

        var nbOk = false;
        try {
          nbOk = await (typeof window.generateNbComposite === 'function'
            ? window.generateNbComposite(segIdx)
            : Promise.resolve(false));
        } catch (nbErr) {
          console.error('[Pipeline] NB error scene ' + (segIdx + 1) + ':', nbErr.message);
        }

        nbDone++;

        if (!nbOk) {
          _ppSetPhase(segIdx, 'nb',  'error',   'Failed — check credits/quota');
          _ppSetPhase(segIdx, 'veo', 'skipped', 'Skipped (no frame)');
          _ppUpdateProgress(nbDone, veoDone + veoFail, total, totalVeoJobs);
          // Brief spacing before next NB request (DSQ handles concurrency)
          if (i < toRun.length - 1) await new Promise(function (r) { setTimeout(r, 1500); });
          continue;
        }

        _ppSetPhase(segIdx, 'nb', 'done', 'Frame ready');
        _ppUpdateProgress(nbDone, veoDone + veoFail, total, totalVeoJobs);

        // ── Phase 2: Veo clip (non-blocking) ──────────────────────────────
        _ppSetPhase(segIdx, 'veo', 'generating', 'Generating clip…');

        var durSecs = 6;
        try { durSecs = (JSON.parse(seg.veoPrompt || '{}').duration) || 6; } catch (_) {}
        if (modelKey === 'omni') durSecs = _ppOmniDur;

        // IIFE captures loop vars — durSecs MUST be a param to avoid var-closure bug
        (function (theSeg, theSegIdx, theDur) {
          var p = (async function () {
            try {
              var startImg = theSeg.nbPreviewDataUrl || theSeg.frameDataUrl || null;
              var result   = await window.generateVeoClipViaAPI(
                theSeg.veoPrompt, theDur, modelKey, startImg, theSeg.frameDataUrl || null, 0, theSegIdx, 0
              );

              // Project may have changed during this long await — don't write the
              // finished clip onto an orphaned array or save over the new project.
              if (_ppProjectChanged()) { aborted = true; return; }

              theSeg.apiVideoUrl  = result.videoUrl;
              theSeg.apiVideoMime = result.mimeType || 'video/mp4';

              var blobUrl = typeof window._fetchVideoAsBlob === 'function'
                ? await window._fetchVideoAsBlob(result.videoUrl)
                : null;
              if (blobUrl) theSeg.apiVideoRaw = blobUrl;

              _ppSetPhase(theSegIdx, 'veo', 'done', 'Clip ready');
              veoDone++;

              if (typeof saveSegments         === 'function') saveSegments();
              if (typeof renderSegments       === 'function') renderSegments();
              if (typeof renderGallery        === 'function') renderGallery();
              if (typeof refreshCreditBalance === 'function') refreshCreditBalance();

            } catch (veoErr) {
              console.error('[Pipeline] Veo error scene ' + (theSegIdx + 1) + ':', veoErr.message);
              var errMsg = (veoErr.message || 'Unknown error').slice(0, 50);
              _ppSetPhase(theSegIdx, 'veo', 'error', errMsg);
              veoFail++;

              // Credit exhaustion — surface clearly and abort remaining NB
              if (veoErr.message && veoErr.message.toLowerCase().includes('credit')) {
                aborted = true;
                if (typeof showToast === 'function')
                  showToast('Not enough credits — pipeline stopped. Top up to continue.', 'error', 9000);
              }
            }
            _ppUpdateProgress(nbDone, veoDone + veoFail, total, totalVeoJobs);
          })();
          veoPromises.push(p);
        })(seg, segIdx, durSecs);

        // ── Fire continuation clip extras (same NB start frame, different speech) ──
        (seg.veoExtras || []).forEach(function(extra, extraJ) {
          if (!(extra.veoPrompt || '').trim()) return;
          var extraDur = 6;
          try { extraDur = (JSON.parse(extra.veoPrompt || '{}').duration) || 6; } catch (_) {}
          if (modelKey === 'omni') extraDur = _ppOmniDur;
          (function(theSeg, theSegIdx, theExtra, theDur, clipNum) {
            var p = (async function() {
              try {
                var startImg = theSeg.nbPreviewDataUrl || theSeg.frameDataUrl || null;
                var result   = await window.generateVeoClipViaAPI(
                  theExtra.veoPrompt, theDur, modelKey, startImg, theSeg.frameDataUrl || null
                );
                // Project may have changed during this long await — bail before
                // writing onto the orphaned array or saving over the new project.
                if (_ppProjectChanged()) { aborted = true; return; }
                theExtra.apiVideoUrl  = result.videoUrl;
                theExtra.apiVideoMime = result.mimeType || 'video/mp4';
                var blobUrl = typeof window._fetchVideoAsBlob === 'function'
                  ? await window._fetchVideoAsBlob(result.videoUrl) : null;
                if (blobUrl) theExtra.apiVideoRaw = blobUrl;
                veoDone++;
                if (typeof saveSegments         === 'function') saveSegments();
                if (typeof renderSegments       === 'function') renderSegments();
                if (typeof renderGallery        === 'function') renderGallery();
                if (typeof refreshCreditBalance === 'function') refreshCreditBalance();
              } catch(veoErr) {
                console.error('[Pipeline] Veo extra clip ' + clipNum + ' scene ' + (theSegIdx+1) + ' failed:', veoErr.message);
                veoFail++;
                if (veoErr.message && veoErr.message.toLowerCase().includes('credit')) {
                  aborted = true;
                  if (typeof showToast === 'function')
                    showToast('Not enough credits — pipeline stopped. Top up to continue.', 'error', 9000);
                }
              }
              _ppUpdateProgress(nbDone, veoDone + veoFail, total, totalVeoJobs);
            })();
            veoPromises.push(p);
          })(seg, segIdx, extra, extraDur, extraJ + 2);
        });

        // Brief gap between NB requests — DSQ handles concurrency (was 15s for the legacy fixed quota)
        if (i < toRun.length - 1) {
          await new Promise(function (r) { setTimeout(r, 1500); });
        }
      }

      // ── Wait for all in-flight Veo jobs ─────────────────────────────────────
      await Promise.all(veoPromises);

      // Project changed at some point during the run — skip final save/render so
      // we don't touch the new project's data. (try/finally still resets state.)
      if (_ppProjectChanged()) return;

      // ── Final summary ────────────────────────────────────────────────────────
      var successMsg, toastType;
      if (veoFail === 0 && veoDone > 0) {
        successMsg = '🎉 Pipeline complete — ' + veoDone + ' clip' + (veoDone !== 1 ? 's' : '') + ' ready!';
        toastType  = 'success';
      } else if (veoDone > 0) {
        successMsg = 'Pipeline done: ' + veoDone + ' ✅  ' + veoFail + ' ❌  — check failed scenes.';
        toastType  = 'warning';
      } else {
        successMsg = 'Pipeline failed — no clips generated. Check quota / credits.';
        toastType  = 'error';
      }
      if (typeof showToast === 'function') showToast(successMsg, toastType, 7000);

      if (veoDone > 0) {
        if (typeof renderAssembler === 'function') renderAssembler();
        var nudge = document.getElementById('openEditorNudge');
        if (nudge) nudge.style.display = 'flex';
      }

      } finally {
        // Always reset — even if an unexpected error escapes the try block
        _ppRunning = false;
        _ppSetBtnState(false);
      }
    };

  })();
