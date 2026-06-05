  // =========================================================
  // QUICK MODE
  // =========================================================

  function enterQuickMode() {
    const qm = document.getElementById('quickModePanel');
    const vl = document.getElementById('vsLayout');
    if (qm) { qm.style.display = 'flex'; }
    if (vl) vl.style.display = 'none';
    localStorage.setItem('vs_quick_mode', '1');
    _qmUpdateUploadState();
    // If step 2 (analysis in progress) is NOT showing, always reset to step 1.
    // This ensures step 3 ("Ready!") from a previous run doesn't stay stale on re-entry.
    const s2 = document.getElementById('qmStep2');
    const s3 = document.getElementById('qmStep3');
    if (!s2 || s2.style.display !== 'flex') {
      const s1 = document.getElementById('qmStep1');
      if (s1) s1.style.display = '';
      if (s3) s3.style.display = 'none';
    }
  }

  function exitQuickMode() {
    const qm = document.getElementById('quickModePanel');
    const vl = document.getElementById('vsLayout');
    if (qm) qm.style.display = 'none';
    if (vl) vl.style.display = 'flex';
    localStorage.setItem('vs_quick_mode', '0');
  }

  function _qmUpdateUploadState() {
    const hasAvatar = !!avatarImageDataUrl;
    const hasVideo  = !!(refVideoObjectUrl || (document.getElementById('refVideoEl')?.src || '').length > 10);

    // Avatar zone
    const thumb = document.getElementById('qmAvatarThumb');
    const icon  = document.getElementById('qmAvatarIcon');
    const label = document.getElementById('qmAvatarLabel');
    const sub   = document.getElementById('qmAvatarSub');
    const zone  = document.getElementById('qmAvatarZone');
    if (hasAvatar) {
      const imgEl = document.getElementById('qmAvatarImg');
      if (imgEl) imgEl.src = avatarImageDataUrl;
      if (thumb) thumb.style.display = 'block';
      if (icon)  icon.style.display  = 'none';
      if (label) label.textContent = 'Avatar ready ✓';
      if (sub)   sub.textContent   = 'Tap to change';
      if (zone)  { zone.style.borderColor = 'rgba(139,92,246,0.7)'; zone.style.background = 'rgba(139,92,246,0.1)'; }
    } else {
      if (thumb) thumb.style.display = 'none';
      if (icon)  icon.style.display  = '';
      if (label) label.textContent = 'Upload Avatar';
      if (sub)   sub.textContent   = 'Your face photo';
      if (zone)  { zone.style.borderColor = 'rgba(139,92,246,0.35)'; zone.style.background = 'rgba(139,92,246,0.04)'; }
    }

    // Video zone
    const vicon = document.getElementById('qmVideoIcon');
    const vlabel = document.getElementById('qmVideoLabel');
    const vsub   = document.getElementById('qmVideoSub');
    const vzone  = document.getElementById('qmVideoZone');
    if (hasVideo) {
      const fname = refVideoFile?.name || 'Video loaded';
      const shortName = fname.length > 22 ? fname.slice(0, 20) + '…' : fname;
      if (vicon)  vicon.textContent  = '🎬';
      if (vlabel) vlabel.textContent = 'Video ready ✓';
      if (vsub)   vsub.textContent   = shortName;
      if (vzone)  { vzone.style.borderColor = 'rgba(56,189,248,0.65)'; vzone.style.background = 'rgba(56,189,248,0.08)'; }
    } else {
      if (vicon)  vicon.textContent  = '🎬';
      if (vlabel) vlabel.textContent = 'Upload Video';
      if (vsub)   vsub.textContent   = 'The video to replicate';
      if (vzone)  { vzone.style.borderColor = 'rgba(56,189,248,0.3)'; vzone.style.background = 'rgba(56,189,248,0.03)'; }
    }

    // Analyze button — enable only when both are ready
    const btn = document.getElementById('qmAnalyzeBtn');
    if (btn) {
      const ready = hasAvatar && hasVideo;
      btn.disabled = !ready;
      btn.style.opacity = ready ? '1' : '0.4';
      btn.style.cursor  = ready ? 'pointer' : 'not-allowed';
    }
  }

  async function qmStartAnalysis() {
    const s1 = document.getElementById('qmStep1');
    const s2 = document.getElementById('qmStep2');
    const s3 = document.getElementById('qmStep3');
    if (!s1 || !s2 || !s3) return;

    const _setStep = (id, done) => {
      const el   = document.getElementById('qmProg' + id);
      const icEl = document.getElementById('qmIcon' + id);
      if (el)   el.style.opacity   = '1';
      if (icEl) icEl.textContent   = done ? '✅' : '⏳';
    };
    const _pendingStep = (id) => {
      const el   = document.getElementById('qmProg' + id);
      const icEl = document.getElementById('qmIcon' + id);
      if (el)   el.style.opacity = '1';
      if (icEl) icEl.textContent = '⏳';
    };

    s1.style.display = 'none';
    s2.style.display = 'flex';
    s2.style.flexDirection = 'column';
    s2.style.gap = '14px';

    // Reset all steps to pending
    ['Detect','Transcribe','Analyze','Prompts'].forEach(id => {
      const el   = document.getElementById('qmProg' + id);
      const icEl = document.getElementById('qmIcon' + id);
      if (el)   el.style.opacity   = id === 'Detect' ? '1' : '0.4';
      if (icEl) icEl.textContent   = id === 'Detect' ? '⏳' : '○';
    });

    try {
      // Step 1 — detect cuts
      await autoSegmentBySceneChange();
      _setStep('Detect', true);

      // Step 2 — transcribe audio (non-fatal: no mic key, file too long, etc.)
      _pendingStep('Transcribe');
      try { await transcribeVideo(); } catch(e) { /* non-fatal — script fields stay blank */ }
      _setStep('Transcribe', true);

      // Step 3 — analyze frames
      _pendingStep('Analyze');
      try { await analyzeAllFrames(); } catch(e) { /* non-fatal */ }
      _setStep('Analyze', true);

      // Step 4 — build prompts
      _pendingStep('Prompts');
      try { await generateAllSegmentPrompts(); } catch(e) { /* non-fatal */ }
      _setStep('Prompts', true);

      // Show ready screen
      await new Promise(r => setTimeout(r, 500));
      const count = segments.filter(s => s.veoPrompt?.trim()).length;
      const countEl = document.getElementById('qmReadyCount');
      if (countEl) countEl.textContent = count;
      s2.style.display = 'none';
      s3.style.display = 'flex';
      s3.style.flexDirection = 'column';
      s3.style.alignItems = 'center';

    } catch (e) {
      // Fatal error — go back to step 1 with a toast
      s2.style.display = 'none';
      s1.style.display = '';
      ['Detect','Transcribe','Analyze','Prompts'].forEach(id => { const ic = document.getElementById('qmIcon' + id); if (ic) ic.textContent = '○'; });
      _qmUpdateUploadState();
      showToast('Analysis failed — please try again. (' + (e?.message || e) + ')', 'error', 4000);
    }
  }

  let _qmGenerating = false;
  function qmGenerate() {
    if (_qmGenerating) return;
    _qmGenerating = true;
    exitQuickMode();
    setTimeout(() => { _qmGenerating = false; runAllScenes(true); }, 150);
  }

  async function switchStudioMode(mode) {
    if (mode !== 'replicator' && mode !== 'producer') mode = 'replicator';
    // Cancel any pending master-script save so old mode's text doesn't bleed into the new mode's project
    if (typeof _masterScriptSaveTimer !== 'undefined') {
      clearTimeout(_masterScriptSaveTimer); _masterScriptSaveTimer = null;
    }

    const prevMode = studioMode;

    // ── 1. Save current mode's state BEFORE changing studioMode ──────────────
    // (modeKey() still points to the old mode at this point)
    if (projects.length > 0 || activeProjectId) {
      saveCurrentProjectData();
      await DB.set(modeKey('sm_active_project'), activeProjectId);
    }
    saveStudioLibrary();

    // ── 2. Switch mode ────────────────────────────────────────────────────────
    studioMode = mode;
    DB.set('sm_studio_mode', mode).catch(e => console.warn('switchStudioMode: failed to persist mode', e));

    // ── 3. Load new mode's library ────────────────────────────────────────────
    const libRaw = await DB.get(modeKey('sm_studio_library'));
    // Migrate legacy unnamespaced library into Replicator on first run
    const legacyLib = (mode === 'replicator' && !libRaw)
      ? await DB.get('sm_studio_library') : null;
    try { const _lp = JSON.parse(libRaw || legacyLib || '[]'); studioLibrary = Array.isArray(_lp) ? _lp : []; } catch(e) { studioLibrary = []; }
    renderStudioLibrary();

    // ── 4. Load new mode's projects + segments ────────────────────────────────
    await loadProjects();

    // ── 5. Restore an in-progress run's status panel, if any ──────────────────
    await restoreActiveRun();

    // ── 6. Apply visual changes ───────────────────────────────────────────────
    _applyModeVisuals(mode);
  }

  function initVideoStudio(forcedMode) {
    _restoreCtaState();
    // Sync the Lite/Fast/Standard toggle to whatever model is saved
    _syncVeoModelToggle(getAdminSettings().defaultModel || 'Veo 3.1 Lite');
    loadAvatarProfile();
    loadAvatarImage();
    loadAvatarInventory();
    loadProductRefData();
    loadBgImage();
    loadBrandKit();
    populateAvatarAccountPicker();
    if (typeof renderApiKeyStatus === 'function') renderApiKeyStatus();
    // Show Quick Mode by default unless the user explicitly switched to advanced
    const _qmPref = localStorage.getItem('vs_quick_mode');
    if (_qmPref !== '0') {
      // Delay so loadAvatarImage/loadSegments have time to populate state
      // Quick Mode is replicator-only — never auto-trigger in producer mode
      setTimeout(() => {
        if (segments.length === 0 && studioMode !== 'producer') {
          enterQuickMode();
        }
      }, 300);
    }
    // switchStudioMode handles library + projects loading
    if (forcedMode) {
      switchStudioMode(forcedMode).catch(e => console.warn('initVideoStudio: mode switch failed', e));
    } else {
      // Use two-arg .then() so the rejection handler only fires on DB failure,
      // not if switchStudioMode itself throws (which would cause double-invocation)
      DB.get('sm_studio_mode').then(
        saved => switchStudioMode(saved || 'replicator').catch(e => console.warn('initVideoStudio: mode switch failed', e)),
        ()    => switchStudioMode('replicator').catch(e => console.warn('initVideoStudio: mode switch failed', e))
      );
    }
  }


  function _applyModeVisuals(mode) {
    const studio = document.getElementById('tab-video-studio');
    if (!studio) return;
    // Producer mode never uses Quick Mode — make sure vsLayout is visible
    if (mode === 'producer') {
      const vl = document.getElementById('vsLayout');
      const qm = document.getElementById('quickModePanel');
      if (vl) vl.style.display = 'flex';
      if (qm) qm.style.display = 'none';
      localStorage.setItem('vs_quick_mode', '0');
    }
    studio.classList.remove('studio-replicator', 'studio-producer');
    studio.classList.add('studio-' + mode);
    ['replicator', 'producer'].forEach(m => {
      const btn = document.getElementById('studioModetab_' + m);
      if (btn) btn.classList.toggle('active', m === mode);
      const sub = document.getElementById('studioSubtitle_' + m);
      if (sub) sub.style.color = m === mode ? 'var(--accent-2)' : 'var(--text-3)';
    });
    document.querySelectorAll('.tab[data-tab]').forEach(t => t.classList.remove('active'));
    const navBtn = document.querySelector(`.tab[data-tab="video-${mode}"]`);
    if (navBtn) navBtn.classList.add('active');
    const emptyEl = document.getElementById('segmentsEmpty');
    if (emptyEl) {
      emptyEl.innerHTML = mode === 'producer'
        ? 'Enter your product in <strong style="color:var(--accent-2);">✨ Video Producer</strong> on the left, then click <strong style="color:#c4b5fd;">Generate Storyboard</strong> — AI writes your hook, beats &amp; scene directions.'
        : 'Upload a video then click <strong style="color:var(--accent-2);">Detect Cuts</strong> to auto-split into segments, or <strong style="color:var(--text-2);">✂ Mark Scene</strong> while watching.';
    }

    // ── Script panel layout: move between left col (replicator) and right col (producer) ──
    const scriptPanel = document.getElementById('vsPanelScript');
    const leftCol     = document.getElementById('vsLeftCol');
    const rightCol    = document.getElementById('vsRightCol');
    const segPanel    = document.getElementById('vsSegmentsPanel');
    if (scriptPanel && leftCol && rightCol) {
      if (mode === 'producer') {
        // Move script panel to top of right col, just above the segments panel
        const anchor = segPanel || rightCol.lastElementChild;
        if (anchor && anchor !== scriptPanel) rightCol.insertBefore(scriptPanel, anchor);
      } else {
        // Move script panel back to bottom of left col
                if (scriptPanel.parentElement !== leftCol) leftCol.appendChild(scriptPanel);
      }
    }
  }