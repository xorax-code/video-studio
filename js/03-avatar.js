  // ===== VIDEO STUDIO =====
  // Optionally hardcode a key here — or use the hidden admin panel (click logo 5× fast)
  const OPENAI_KEY_BAKED = '';
  let _cachedApiKey = '';
  let _adminApiKey = ''; // loaded from DB on boot, shared across all users
  let studioLibrary = [];
  let studioMode = 'replicator'; // 'replicator' | 'producer'
  let avatarImageDataUrl = null;
  // Expose as window.avatarImageDataUrl so other script tags (e.g. 17-nb-api.js) can read it.
  // top-level `let` is script-scoped and NOT a window property in Chrome.
  Object.defineProperty(window, 'avatarImageDataUrl', {
    get: function() { return avatarImageDataUrl; },
    set: function(v) { avatarImageDataUrl = v; },
    configurable: true,
  });
  let avatarInventory = ''; // auto-extracted appearance catalogue for verifying generations
  let _avatarInvSeq = 0;    // bumped per extractAvatarInventory call; stale calls discard their result
  let productImageDataUrl = null;  // product reference photo for consistent image gen
  let bgImageDataUrl = null;
  let bgFromAvatar = false; // true when background was taken from the avatar photo (Photo 1)
  let useAvatarBg = false;  // replicator mode: use avatar's background in NB prompts, keep frame foreground
  let bgDescription = ''; // AI-extracted plain-text description of the background scene
  let refVideoObjectUrl = null;
  let refVideoFile = null; // Raw File object for Whisper transcription
  let segments = []; // [{startTime, endTime, frameDataUrl, script, action, nbPrompt, veoPrompt}]
  // Expose as window.segments via getter so reassignments (segments = []) stay in sync
  Object.defineProperty(window, 'segments', {
    get: function() { return segments; },
    set: function(v) { segments = v; },
    configurable: true,
  });
  let _undoStack = []; // [{label, segments: deep-clone}] — capped at _UNDO_MAX entries
  const _UNDO_MAX = 15;
  let _activeLibraryVideoId = null; // library video ID currently loaded into the player
  // Timestamped transcript chunks from Whisper verbose_json — [{start, end, text}]
  let whisperSegments = [];
  // Per-word timestamps from Whisper (word granularity) — [{word, start, end}]
  // When present, used directly by distributeScriptFromTimestamps for exact assignment.
  let whisperWords = [];
  // Per-segment rewritten scripts from last Rewrite run — [{idx, original, rewritten}]
  let rewrittenSegScripts = null;

  // ── Cross-script helpers (called by loadProjectData on project switch) ──
  function clearUndoStack() { _undoStack = []; }
  function clearRewrittenScripts() { rewrittenSegScripts = null; }

  function saveStudioLibrary() { DB.set(modeKey('sm_studio_library'), JSON.stringify(studioLibrary)).catch(e => console.warn('saveStudioLibrary error:', e)); }

  // ── Layout resize (column divider + per-panel drag handles) ──────────────

  // Single active drag handler refs — prevents stale listener accumulation
  // if mouseup is missed (window blur, rapid clicks, etc.)
  let _vsColMove = null, _vsColUp = null;
  let _vsPanMove = null, _vsPanUp = null;
  let _vsColDragging = false;

  function vsStartColResize(e) {
    e.preventDefault();
    // Clean up any stale listeners from a previous interrupted drag
    if (_vsColMove) { document.removeEventListener('mousemove', _vsColMove); _vsColMove = null; }
    if (_vsColUp)   { document.removeEventListener('mouseup',   _vsColUp);   _vsColUp   = null; }
    const leftCol = document.getElementById('vsLeftCol');
    if (!leftCol) return;
    const divider = document.getElementById('vsColDivider');
    const startX  = e.clientX;
    const startW  = leftCol.getBoundingClientRect().width;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    _vsColDragging = true;
    if (divider) divider.style.background = 'var(--border-2)';
    _vsColMove = function(ev) {
      const container = document.getElementById('vsLayout');
      const containerW = container ? container.getBoundingClientRect().width : 1200;
      const maxW = Math.min(420, containerW * 0.40); // cap at 40% of layout width
      const newW = Math.max(180, Math.min(maxW, startW + ev.clientX - startX));
      leftCol.style.width = newW + 'px';
    };
    _vsColUp = function() {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      _vsColDragging = false;
      if (divider) divider.style.background = 'transparent';
      document.removeEventListener('mousemove', _vsColMove);
      document.removeEventListener('mouseup',   _vsColUp);
      _vsColMove = null; _vsColUp = null;
      localStorage.setItem('affiliateos_leftColW', leftCol.style.width);
    };
    document.addEventListener('mousemove', _vsColMove);
    document.addEventListener('mouseup',   _vsColUp);
  }

  function vsStartPanelResize(e, panelId) {
    e.preventDefault();
    e.stopPropagation();
    // Clean up any stale listeners from a previous interrupted drag
    if (_vsPanMove) { document.removeEventListener('mousemove', _vsPanMove); _vsPanMove = null; }
    if (_vsPanUp)   { document.removeEventListener('mouseup',   _vsPanUp);   _vsPanUp   = null; }
    const panel  = document.getElementById(panelId);
    if (!panel) return;
    const startY = e.clientY;
    const startH = panel.getBoundingClientRect().height;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    _vsPanMove = function(ev) {
      const newH = Math.max(80, startH + ev.clientY - startY);
      panel.style.flexBasis  = newH + 'px';
      panel.style.flexGrow   = '0';
      panel.style.flexShrink = (panelId === 'vsPanelRefVideo') ? '1' : '0';
    };
    _vsPanUp = function() {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', _vsPanMove);
      document.removeEventListener('mouseup',   _vsPanUp);
      _vsPanMove = null; _vsPanUp = null;
      localStorage.setItem('affiliateos_panel_' + panelId, panel.style.flexBasis);
    };
    document.addEventListener('mousemove', _vsPanMove);
    document.addEventListener('mouseup',   _vsPanUp);
  }

  function vsRestoreLayout() {
    const w = localStorage.getItem('affiliateos_leftColW')
           || localStorage.getItem('socialos_leftColW'); // migrate old key
    if (w) { const c = document.getElementById('vsLeftCol'); if (c) c.style.width = w; }
    // Restore voice style
    const savedVoice = localStorage.getItem('vs_voice_style');
    if (savedVoice) { const vEl = document.getElementById('studioVoice'); if (vEl) vEl.value = savedVoice; }
    // Restore left column collapsed state
    if (localStorage.getItem('vs_leftcol_collapsed') === '1') {
      const layout = document.getElementById('vsLayout');
      const btn    = document.getElementById('leftColToggleBtn');
      if (layout) layout.classList.add('left-collapsed');
      if (btn)    { btn.textContent = '›'; btn.title = 'Show left panel'; }
    }
    ['vsPanelAvatar','vsPanelScript','vsPanelRefVideo'].forEach(id => {
      const h = localStorage.getItem('affiliateos_panel_' + id)
             || localStorage.getItem('socialos_panel_' + id); // migrate old key
      if (!h) return;
      const p = document.getElementById(id);
      if (!p) return;
      // Validate: only apply sane pixel values
      const parsed = parseFloat(h);
      if (!isFinite(parsed) || parsed < 80) return;
      p.style.flexBasis  = h;
      p.style.flexGrow   = '0';
      p.style.flexShrink = (id === 'vsPanelRefVideo') ? '1' : '0';
    });
  }
  document.addEventListener('DOMContentLoaded', vsRestoreLayout);

  // --- Save/load segments — delegated to project system ---
  function saveSegments() { saveCurrentProjectData(); }
  async function loadSegments() { /* handled by loadProjects() in initVideoStudio */ }


  // --- Avatar image ---
  function onAvatarImageChange(e) {
    const file = e.target.files[0];
    if (!file) return;
    // Likeness consent is agreed at signup (account-level) + reminded at upload.
    const reader = new FileReader();
    reader.onload = function(ev) {
      try {
        avatarImageDataUrl = ev.target.result;
        const img = document.getElementById('avatarImgEl');
        const placeholder = document.getElementById('avatarImgPlaceholder');
        if (img) { img.src = avatarImageDataUrl; img.style.display = 'block'; }
        if (placeholder) placeholder.style.display = 'none';
        const clearBtn = document.getElementById('clearAvatarImgBtn');
        if (clearBtn) clearBtn.style.display = 'block';
        DB.set('sm_avatar_img', avatarImageDataUrl).catch(e => console.warn('saveAvatarImg error:', e));
        // Auto-extract the appearance inventory from the new avatar photo
        extractAvatarInventory(avatarImageDataUrl);
        // Update quick mode state now that avatarImageDataUrl is set (was a racy setTimeout)
        _qmUpdateUploadState?.();
        // Avatar prep DISABLED (by request): we keep the avatar exactly as uploaded —
        // no de-photorealization pass, no ~2-credit charge. The raw photo is the
        // identity base for every composite; Flash-rendered composites + the Veo-block
        // auto-recovery (js/15-veo-api.js) handle the person-likeness filter instead.
        // To re-enable, restore the prepareAvatarReference call here.
        window._avatarPrepPromise = null;
      } catch (err) {
        showToast('Failed to load avatar image — please try again.', 'error');
      }
    };
    reader.onerror = () => showToast('Could not read avatar image file.', 'error');
    reader.readAsDataURL(file);
  }

  // Swap the working avatar to the prepared (stylized) version produced by
  // window.prepareAvatarReference (in 17-nb-api.js). Keeps the original on file
  // under sm_avatar_img_original so the user can revert. Called on prep success.
  window.applyPreparedAvatar = function(styledUrl, originalUrl) {
    if (!styledUrl) return;
    try {
      avatarImageDataUrl = styledUrl;
      const img = document.getElementById('avatarImgEl');
      const placeholder = document.getElementById('avatarImgPlaceholder');
      const clearBtn = document.getElementById('clearAvatarImgBtn');
      if (img) { img.src = styledUrl; img.style.display = 'block'; }
      if (placeholder) placeholder.style.display = 'none';
      if (clearBtn) clearBtn.style.display = 'block';
      DB.set('sm_avatar_img', styledUrl).catch(function(){});
      if (originalUrl) DB.set('sm_avatar_img_original', originalUrl).catch(function(){});
      // Inventory was already extracted from the uploaded photo (and now survives this
      // image-swap via the sequence guard), so we no longer re-analyze here — that was
      // a duplicate GPT-4o vision call on every upload.
      _qmUpdateUploadState?.();
      if (typeof showToast === 'function') showToast('Avatar ready — optimized to pass video generation. Re-upload anytime to replace it.', 'success', 5000);
    } catch(_) {}
  };

  function clearAvatarImage() {
    avatarImageDataUrl = null;
    const _ai = document.getElementById('avatarImgEl');
    const _ap = document.getElementById('avatarImgPlaceholder');
    const _ac = document.getElementById('clearAvatarImgBtn');
    const _ainput = document.getElementById('avatarImgInput');
    if (_ai) { _ai.src = ''; _ai.style.display = 'none'; }
    if (_ap) _ap.style.display = 'block';
    if (_ac) _ac.style.display = 'none';
    if (_ainput) _ainput.value = '';
    DB.remove('sm_avatar_img').catch(e => console.warn('clearAvatarImg error:', e));
    // The inventory belonged to the cleared avatar — clear it too
    avatarInventory = '';
    const invEl = document.getElementById('avatarInventory');
    if (invEl) invEl.value = '';
    const invStatus = document.getElementById('avatarInventoryStatus');
    if (invStatus) invStatus.textContent = '';
    DB.remove('sm_avatar_inventory').catch(e => console.warn('clearAvatarInventory error:', e));
  }

  function loadAvatarImage() {
    DB.get('sm_avatar_img').then(saved => {
      if (saved) {
        avatarImageDataUrl = saved;
        const img = document.getElementById('avatarImgEl');
        const placeholder = document.getElementById('avatarImgPlaceholder');
        const clearBtn = document.getElementById('clearAvatarImgBtn');
        if (img) { img.src = saved; img.style.display = 'block'; }
        if (placeholder) placeholder.style.display = 'none';
        if (clearBtn) clearBtn.style.display = 'block';
      }
    }).catch(e => console.warn('loadAvatarImage error:', e));
    // Restore the likeness-consent checkbox (once given, it stays remembered)
    DB.get('sm_likeness_consent').then(ok => {
      const c = document.getElementById('avatarConsentChk');
      if (c && ok) c.checked = true;
    }).catch(function(){});
    // Restore the Max Quality (Nano Banana Pro) preference
    DB.get('sm_nb_max_quality').then(on => {
      window._nbMaxQuality = !!on;
      const q = document.getElementById('nbMaxQualityChk');
      if (q && on) q.checked = true;
    }).catch(function(){});
  }

  // Persist the likeness-consent choice
  function onAvatarConsentChange() {
    const c = document.getElementById('avatarConsentChk');
    try { DB.set('sm_likeness_consent', !!(c && c.checked)); } catch(_) {}
  }
  window.onAvatarConsentChange = onAvatarConsentChange;

  // Persist the Max Quality (Nano Banana Pro) preference — read by 17-nb-api.js
  function onNbMaxQualityChange() {
    const q = document.getElementById('nbMaxQualityChk');
    window._nbMaxQuality = !!(q && q.checked);
    try { DB.set('sm_nb_max_quality', window._nbMaxQuality); } catch(_) {}
    if (typeof showToast === 'function') showToast(window._nbMaxQuality ? 'Max Quality frames ON — 5 credits/frame (Nano Banana Pro).' : 'Max Quality off — standard frames (2 credits).', 'info', 3500);
  }
  window.onNbMaxQualityChange = onNbMaxQualityChange;

  // --- Appearance Inventory ---
  // An auto-extracted catalogue of the avatar's face, hair, clothing, and
  // jewelry. It's the source of truth for verifying that AI generations still
  // look like the same person. Stored globally (like the avatar image itself).
  function onAvatarInventoryInput() {
    const el = document.getElementById('avatarInventory');
    if (!el) return;
    avatarInventory = el.value;
    DB.set('sm_avatar_inventory', avatarInventory).catch(e => console.warn('saveAvatarInventory error:', e));
  }

  function loadAvatarInventory() {
    DB.get('sm_avatar_inventory').then(saved => {
      if (saved) {
        avatarInventory = saved;
        const el = document.getElementById('avatarInventory');
        if (el) {
          el.value = saved;
          // Keep the section COLLAPSED by default (the value is loaded behind it).
          // The user can expand Appearance Inventory manually if they want to review it.
        }
      }
    }).catch(e => console.warn('loadAvatarInventory error:', e));
  }

  // ─── Product Reference Image ─────────────────────────────────────────────────
  // Stores a product photo + an AI-generated banana prompt that gets injected
  // into every NB Pro and Veo 3 prompt to keep the product visually consistent.

  function onProductRefImageChange(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      productImageDataUrl = reader.result;
      window._producerProductImageUrl = productImageDataUrl; // expose globally for the composite (Photo 3)
      const thumb  = document.getElementById('productRefThumb');
      const icon   = document.getElementById('productRefIcon');
      const clear  = document.getElementById('clearProductRefBtn');
      const hint   = document.getElementById('productPhoto3Hint');
      if (thumb) { thumb.src = productImageDataUrl; thumb.style.display = 'block'; }
      if (icon)  icon.style.display = 'none';
      if (clear) clear.style.display = '';
      if (hint)  hint.style.display = '';
      DB.set('sm_product_ref_img', productImageDataUrl).catch(e => console.warn('saveProductImg error:', e));
      // Re-render segments so per-segment product toggles appear immediately
      if (typeof renderSegments === 'function' && typeof segments !== 'undefined' && segments.length > 0) {
        renderSegments();
      }
    };
    reader.readAsDataURL(file);
    event.target.value = '';
  }


  // Extracts a representative frame from a product video and uses it as the product reference image.
  function onProductVideoSelect(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    const videoEl = document.createElement('video');
    videoEl.muted = true;
    videoEl.playsInline = true;
    const objUrl = URL.createObjectURL(file);
    videoEl.src = objUrl;
    videoEl.addEventListener('loadedmetadata', () => {
      // Seek to 20% of the duration (tends to show the product clearly, past any intro motion).
      // Guard against zero/invalid duration (NaN/Infinity) which would yield a NaN/negative
      // seek target and silently skip capture — fall back to the current (first) frame.
      if (!isFinite(videoEl.duration) || videoEl.duration <= 0) {
        videoEl.currentTime = 0;
      } else {
        videoEl.currentTime = Math.min(videoEl.duration * 0.2, videoEl.duration - 0.1, 3);
      }
    });
    videoEl.addEventListener('seeked', () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width  = videoEl.videoWidth  || 512;
        canvas.height = videoEl.videoHeight || 512;
        const ctx = canvas.getContext('2d');
        if (!ctx) { URL.revokeObjectURL(objUrl); showToast('Frame capture failed — browser context unavailable.', 'error'); return; }
        ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
        URL.revokeObjectURL(objUrl);
        // Apply as product image
        productImageDataUrl = dataUrl;
        const thumb  = document.getElementById('productRefThumb');
        const icon   = document.getElementById('productRefIcon');
        const clear  = document.getElementById('clearProductRefBtn');
        const vrow   = document.getElementById('productVideoRow');
        const hint   = document.getElementById('productPhoto3Hint');
        if (thumb) { thumb.src = dataUrl; thumb.style.display = 'block'; }
        if (icon)  icon.style.display = 'none';
        if (clear) clear.style.display = '';
        if (vrow)  vrow.style.display = 'none';
        if (hint)  hint.style.display = '';
        DB.set('sm_product_ref_img', dataUrl).catch(e => console.warn('saveProductImg error:', e));
        } catch (e) {
        URL.revokeObjectURL(objUrl);
        showToast('Frame extraction failed: ' + (e.message || e), 'error');
      }
    }, { once: true });
    videoEl.addEventListener('error', () => {
      URL.revokeObjectURL(objUrl);
      showToast('Could not load video — try a product photo instead.', 'error');
    });
    videoEl.load();
    event.target.value = ''; // reset here — event ref is still live at this synchronous point
  }

  function clearProductRefImage() {
    productImageDataUrl = null;
    const thumb  = document.getElementById('productRefThumb');
    const icon   = document.getElementById('productRefIcon');
    const clear  = document.getElementById('clearProductRefBtn');
    const hint   = document.getElementById('productPhoto3Hint');
    if (thumb)  { thumb.src = ''; thumb.style.display = 'none'; }
    if (icon)   icon.style.display = '';
    if (clear)  clear.style.display = 'none';
    if (hint)   hint.style.display = 'none';
    // Also clear producer UI
    window._producerProductImageUrl = null;
    const pThumb = document.getElementById('producerProductThumb');
    const pLabel = document.getElementById('producerProductPhotoLabel');
    const pZone  = document.getElementById('producerProductPhotoZone');
    if (pThumb) { pThumb.src = ''; pThumb.style.display = 'none'; }
    if (pLabel) pLabel.textContent = '📦 Upload product photo';
    if (pZone)  { pZone.style.background = 'rgba(251,146,60,0.05)'; pZone.style.borderColor = 'rgba(251,146,60,0.45)'; }
    DB.remove('sm_product_ref_img').catch(() => {});
    // Re-render so per-segment toggles disappear immediately
    if (typeof renderSegments === 'function' && typeof segments !== 'undefined' && segments.length > 0) {
      renderSegments();
    }
  }

  function loadProductRefData() {
    DB.get('sm_product_ref_img').then(img => {
      if (!img) return;
      productImageDataUrl = img;
      const thumb = document.getElementById('productRefThumb');
      const icon  = document.getElementById('productRefIcon');
      const clear = document.getElementById('clearProductRefBtn');
      const vrow  = document.getElementById('productVideoRow');
      const hint  = document.getElementById('productPhoto3Hint');
      if (thumb) { thumb.src = img; thumb.style.display = 'block'; }
      if (icon)  icon.style.display = 'none';
      if (clear) clear.style.display = '';
      if (vrow)  vrow.style.display = 'none';
      if (hint)  hint.style.display = '';
      // Sync producer UI so the thumb shows regardless of which mode loads first
      window._producerProductImageUrl = img;
      const pThumb = document.getElementById('producerProductThumb');
      const pLabel = document.getElementById('producerProductPhotoLabel');
      const pZone  = document.getElementById('producerProductPhotoZone');
      if (pThumb) { pThumb.src = img; pThumb.style.display = 'block'; }
      if (pLabel) pLabel.textContent = '✅ Product photo loaded — tap to change';
      if (pZone)  { pZone.style.background = 'rgba(251,146,60,0.1)'; pZone.style.borderColor = 'rgba(251,146,60,0.8)'; }
      // Re-render segments so the per-segment product toggle button appears
      if (typeof renderSegments === 'function' && typeof segments !== 'undefined' && segments.length > 0) {
        renderSegments();
      }
    }).catch(e => console.warn('loadProductRefImg error:', e));

    // Also restore the locked hand reference, if any
    DB.get('sm_hand_ref_img').then(hand => {
      if (!hand) return;
      window._handRefDataUrl = hand;
      const hThumb = document.getElementById('handRefThumb');
      const hIcon  = document.getElementById('handRefIcon');
      const hHint  = document.getElementById('handRefHint');
      const hClr   = document.getElementById('clearHandRefBtn');
      const hBtn   = document.getElementById('genHandRefBtn');
      if (hThumb) { hThumb.src = hand; hThumb.style.display = 'block'; }
      if (hIcon)  hIcon.style.display = 'none';
      if (hHint)  hHint.style.display = '';
      if (hClr)   hClr.style.display = '';
      if (hBtn)   hBtn.textContent = '↻ Redo hand';
    }).catch(e => console.warn('loadHandRefImg error:', e));
  }

  // ── Producer-mode product photo upload (mirrors replicator's onProductRefImageChange) ──
  function onProducerProductPhotoSelect(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      productImageDataUrl = reader.result;
      window._producerProductImageUrl = productImageDataUrl; // flag for onmouseleave guard
      // Update producer UI
      const pThumb = document.getElementById('producerProductThumb');
      const pLabel = document.getElementById('producerProductPhotoLabel');
      const pZone  = document.getElementById('producerProductPhotoZone');
      if (pThumb) { pThumb.src = productImageDataUrl; pThumb.style.display = 'block'; }
      if (pLabel) pLabel.textContent = '✅ Product photo loaded — tap to change';
      if (pZone)  { pZone.style.background = 'rgba(251,146,60,0.1)'; pZone.style.borderColor = 'rgba(251,146,60,0.8)'; }
      // Sync replicator UI too so both modes stay consistent
      const rThumb = document.getElementById('productRefThumb');
      const rIcon  = document.getElementById('productRefIcon');
      const rClear = document.getElementById('clearProductRefBtn');
      const rVrow  = document.getElementById('productVideoRow');
      const rHint  = document.getElementById('productPhoto3Hint');
      if (rThumb) { rThumb.src = productImageDataUrl; rThumb.style.display = 'block'; }
      if (rIcon)  rIcon.style.display = 'none';
      if (rClear) rClear.style.display = '';
      if (rVrow)  rVrow.style.display = 'none';
      if (rHint)  rHint.style.display = '';
      DB.set('sm_product_ref_img', productImageDataUrl).catch(e => console.warn('saveProductImg error:', e));
    };
    reader.readAsDataURL(file);
    event.target.value = '';
  }
  window.onProducerProductPhotoSelect = onProducerProductPhotoSelect;

  // Extract a structured appearance inventory from the avatar photo via GPT-4o
  // Vision. Runs automatically whenever a new avatar is set.
  async function extractAvatarInventory(dataUrl) {
    if (!dataUrl) return;
    const _mySeq = ++_avatarInvSeq;  // newer calls win; this one discards if superseded
    const field  = document.getElementById('avatarInventory');
    const status = document.getElementById('avatarInventoryStatus');
    // A new avatar was just set — clear any previous inventory immediately so a
    // failed or aborted extraction leaves the field honestly EMPTY rather than
    // showing the OLD avatar's inventory mismatched against the new photo.
    // (Only fires on a deliberate avatar upload / account load, never on page
    // load, so this won't wipe edits unexpectedly.)
    avatarInventory = '';
    if (field) field.value = '';
    DB.remove('sm_avatar_inventory').catch(e => console.warn('extractAvatarInventory remove error:', e));
    const retryBtn = document.getElementById('retryInventoryBtn');
    if (retryBtn) retryBtn.style.display = 'none';
    // file:// protocol blocks outbound fetch to external APIs (CORS null-origin)
    if (location.protocol === 'file:') {
      if (status) status.textContent = 'open on Netlify to auto-fill — or type manually';
      return;
    }
    // In production on Netlify the proxy supplies the API key server-side —
    // no client-side key is needed, so we only block if we somehow have no key
    // AND we're in a non-proxied context (file:// already returned above).
    // Allow empty key on Netlify — the fetch interceptor will strip the header
    // and the server-side function provides its own OPENAI_API_KEY.
    if (status) status.textContent = '⏳ analyzing avatar…';

    // Compress the image to ≤768px JPEG before sending — large base64 payloads
    // cause fetch to throw a "Failed to fetch" TypeError before reaching the API.
    let sendUrl = dataUrl;
    try {
      sendUrl = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const MAX = 768;
          let w = img.naturalWidth || 512, h = img.naturalHeight || 512;
          if (w > MAX || h > MAX) {
            if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
            else       { w = Math.round(w * MAX / h); h = MAX; }
          }
          const c = document.createElement('canvas');
          c.width = w; c.height = h;
          const _ctx = c.getContext('2d');
          if (!_ctx) { reject(new Error('canvas context unavailable')); return; }
          _ctx.drawImage(img, 0, 0, w, h);
          const compressed = c.toDataURL('image/jpeg', 0.78);
          console.log('[AvatarInventory] compressed to', Math.round(compressed.length / 1024), 'KB');
          resolve(compressed);
        };
        img.onerror = (e) => { console.warn('[AvatarInventory] img load failed, using original', e); reject(e); };
        img.src = dataUrl;
      });
    } catch (_) {
      console.warn('[AvatarInventory] resize failed, using original dataUrl (may be large)');
    }

    const promptText = `You are cataloguing the appearance of a person in a reference photo so it can later be used to verify AI-generated images of the SAME person. List ONLY what is clearly and unmistakably visible — never guess, infer, or invent. If you are not 100% certain something exists, omit it entirely. Use exactly this structure, one short line each:

FACE & HAIR: hair color, length and style; skin tone; any notable facial features.
EYE COLOR: exact eye color if clearly visible (e.g. dark brown, light blue, green, hazel). Write "unknown" if not clearly visible.
CLOTHING: each visible garment with its color and style.
JEWELRY: every piece WORN on the body — earrings, necklaces (including any pendant, crystal, or gemstone hanging from a chain at the chest), rings, bracelets, watches — with type and color. Write "none visible" if there is none.
OTHER: glasses, visible nail color, or hat only. Write "none" if nothing.

CRITICAL RULES:
- GLASSES: Only list glasses/sunglasses if the person is CLEARLY wearing them with both temples visible on the ears. A shadow near the eyes, the edge of a phone screen, or any reflection is NOT glasses. If uncertain, write nothing.
- CLOTHING: Only describe garments you can see the full texture and cut of. Shadows, color overlaps, or partial edges are NOT clothing items. Never name a garment you cannot identify with certainty — write "top" or "shirt" rather than guessing. VESTS AND LAYERING: do NOT describe a vest, jacket, or second layer unless you can clearly see both its collar/neckline AND its armholes as separate from the main shirt. A color difference or shadow on a shirt is NOT a vest. When in doubt, describe only the outermost visible garment as a single item.
- A crystal, gemstone, or pendant hanging from a chain around the neck is JEWELRY (a necklace) — NOT a held item. Never describe it as "holding a crystal".
- Hair accessories (clips, pins, flowers) should only appear under OTHER if they are unmistakably distinct visible objects — never guess. Do NOT invent hair pins or decorative items that may just be reflections or highlights in the hair.
- Do NOT mention anything the person is holding in their hands (products, phones, bottles, bags, props, etc.).
- Only describe the person's own appearance — face, hair, clothing, and accessories worn on the body.

Keep it under 140 words total. No intro, no commentary — just the five labelled lines.`;
    try {
      const _ak = getApiKey();
      const res = await Promise.race([
        _fetchWithRetry('/.netlify/functions/openai-chat', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, _ak ? { 'X-Api-Key': _ak } : {}),
        body: JSON.stringify({
          model: 'gpt-4o',
          max_tokens: 280,
          messages: [{ role: 'user', content: [
            { type: 'text', text: promptText },
            { type: 'image_url', image_url: { url: sendUrl, detail: 'high' } }
          ]}]
        })
      }, 2),
        new Promise(function(_, rej){ setTimeout(function(){ rej(new Error('analysis timed out — tap Retry')); }, 45000); })
      ]);
      let data;
      try { data = await res.json(); } catch(_) { data = {}; }
      if (!res.ok && !data.error) { data.error = { message: 'HTTP ' + res.status + ' — API error' }; }
      if (data.error) {
        const msg = data.error.message || data.error.code || data.error.type || 'unknown error';
        console.error('[AvatarInventory] API error:', data.error);
        if (status) status.textContent = '⚠ ' + msg.slice(0, 120);
        showToast('Avatar analysis failed: ' + msg.slice(0, 120), 'error');
        if (retryBtn) retryBtn.style.display = '';
        if (field && field.style.display === 'none') {
          field.style.display = '';
          const arr = document.querySelector('.inv-arrow');
          if (arr) arr.style.transform = 'rotate(0deg)';
        }
        return;
      }
      const text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '').trim();
      if (!text) {
        if (status) status.textContent = '⚠ no result — fill in manually';
        showToast('Avatar analysis returned no result — fill in the Appearance Inventory manually', 'warning');
        if (retryBtn) retryBtn.style.display = '';
        return;
      }
      // Guard: if the model refused the image, don't write the refusal text in
      if (/i('m| am) sorry|can'?t (assist|help)|cannot (assist|help)|i apologi|unable to (help|assist)/i.test(text)) {
        if (status) status.textContent = '⚠ could not read photo — fill in manually';
        if (retryBtn) retryBtn.style.display = '';
        return;
      }
      // Guard: discard only if a NEWER extraction started while this was in flight.
      // (Don't compare against avatarImageDataUrl — avatar prep legitimately swaps it
      // to the stylized image mid-flight, which would wrongly discard a valid result.)
      if (_mySeq !== _avatarInvSeq) return;
      avatarInventory = text;
      if (field) field.value = text;
      DB.set('sm_avatar_inventory', text).catch(e => console.warn('DB avatar inventory save error:', e));
      if (retryBtn) retryBtn.style.display = 'none';
      // Auto-expand the section so the user can see the filled result
      if (field && field.style.display === 'none') {
        field.style.display = '';
        const arr = document.querySelector('.inv-arrow');
        if (arr) arr.style.transform = 'rotate(0deg)';
      }
      if (status) {
        status.textContent = '✓ auto-filled — edit if needed';
        setTimeout(() => { if (status) status.textContent = ''; }, 6000);
      }
      // If this avatar photo is also the background source, re-extract the bg description
      if (bgFromAvatar) extractBgDescription(dataUrl);
    } catch (e) {
      const msg = e && e.message ? e.message : 'network error';
      console.error('[AvatarInventory]', e);
      if (status) status.textContent = '⚠ ' + msg.slice(0, 120);
      showToast('Avatar analysis failed: ' + msg.slice(0, 120), 'error');
      if (retryBtn) retryBtn.style.display = '';
      // Auto-expand on error too so the Retry button context is visible
      if (field && field.style.display === 'none') {
        field.style.display = '';
        const arr = document.querySelector('.inv-arrow');
        if (arr) arr.style.transform = 'rotate(0deg)';
      }
    }
  }

  // Extract a plain-text description of the background/setting from a photo via
  // GPT-4o-mini Vision. Runs whenever a new background is set or the avatar photo
  // changes while bgFromAvatar is true. Result is stored in bgDescription and
  // injected into NB prompts when useAvatarBg is on — giving Veo/Flow an exact
  // description to match rather than a vague "use Photo 1 background" instruction.
  async function extractBgDescription(dataUrl) {
    if (!dataUrl) return;
    bgDescription = '';
    DB.remove('sm_bg_description').catch(() => {});
    if (location.protocol === 'file:') return;
    // Compress the image to ≤512px JPEG before sending
    let sendUrl = dataUrl;
    try {
      sendUrl = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const MAX = 512;
          let w = img.naturalWidth || 512, h = img.naturalHeight || 512;
          if (w > MAX || h > MAX) {
            if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
            else       { w = Math.round(w * MAX / h); h = MAX; }
          }
          const c = document.createElement('canvas');
          c.width = w; c.height = h;
          const _bgCtx = c.getContext('2d');
          if (!_bgCtx) { reject(new Error('canvas context unavailable')); return; }
          _bgCtx.drawImage(img, 0, 0, w, h);
          resolve(c.toDataURL('image/jpeg', 0.78));
        };
        img.onerror = reject;
        img.src = dataUrl;
      });
    } catch (_) { /* use original dataUrl */ }
    const promptText = `Describe ONLY the background and setting in this photo — not the person or any foreground objects. Focus on: the room or location type, wall colors and textures, furniture or objects visible behind the person, lighting quality and direction, and overall atmosphere. Be specific and concise. Write 1–2 sentences as a visual scene description that could be given to a video AI to recreate this exact setting. Example: "A modern home office with white walls, a bookshelf on the right, and warm natural light coming from the left." Do not mention the person, their clothing, or anything they are holding.`;
    try {
      const _ak = getApiKey();
      const res = await fetch('/.netlify/functions/openai-chat', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, _ak ? { 'X-Api-Key': _ak } : {}),
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          max_tokens: 120,
          messages: [{ role: 'user', content: [
            { type: 'text', text: promptText },
            { type: 'image_url', image_url: { url: sendUrl, detail: 'low' } }
          ]}]
        })
      });
      let data;
      try { data = await res.json(); } catch(_) { data = {}; }
      if (!res.ok || data.error) {
        console.warn('[BgDescription] API error:', data.error);
        return;
      }
      const text = (data.choices?.[0]?.message?.content || '').trim();
      if (!text || /i('m| am) sorry|can'?t (assist|help)|cannot (assist|help)/i.test(text)) return;
      // Guard: discard if the background source changed while the request was in flight
      if (bgImageDataUrl !== dataUrl && avatarImageDataUrl !== dataUrl) return;
      bgDescription = text;
      DB.set('sm_bg_description', text).catch(() => {});
      console.log('[BgDescription] extracted:', text);
      // If Avatar Background mode is active, patch existing prompts now that
      // we have a real description instead of the generic fallback
      if (useAvatarBg && typeof patchNbPromptBackground === 'function') {
        patchNbPromptBackground();
      }
    } catch(e) {
      console.warn('[BgDescription] fetch error:', e);
    }
  }

  // --- Background image ---
  function _applyBgToUI(dataUrl) {
    bgImageDataUrl = dataUrl;
    const img = document.getElementById('bgImgEl');
    const placeholder = document.getElementById('bgImgPlaceholder');
    const clearBtn = document.getElementById('clearBgBtn');
    const activeLabel = document.getElementById('bgActiveLabel');
    if (dataUrl) {
      if (img) { img.src = dataUrl; img.style.display = 'block'; }
      if (placeholder) placeholder.style.display = 'none';
      if (clearBtn) clearBtn.style.display = 'inline-flex';
      if (activeLabel) activeLabel.style.display = 'block';
    } else {
      if (img) { img.src = ''; img.style.display = 'none'; }
      if (placeholder) placeholder.style.display = 'block';
      if (clearBtn) clearBtn.style.display = 'none';
      if (activeLabel) activeLabel.style.display = 'none';
    }
    // Sync the Avatar Background panel thumbnail (replicator mode).
    // Only show when a separately-uploaded bg is set (not when bg = avatar photo).
    const _abpThumb = document.getElementById('avatarBgPhotoThumb');
    const _abpIcon  = document.getElementById('avatarBgPhotoIcon');
    const _abpLabel = document.getElementById('avatarBgPhotoLabel');
    const _abpClear = document.getElementById('avatarBgPhotoClearBtn');
    const _showInPanel = !!(dataUrl && !bgFromAvatar);
    if (_abpThumb) { _abpThumb.src = _showInPanel ? dataUrl : ''; _abpThumb.style.display = _showInPanel ? 'block' : 'none'; }
    if (_abpIcon)  _abpIcon.style.display  = _showInPanel ? 'none' : '';
    if (_abpLabel) _abpLabel.textContent   = _showInPanel ? 'Background set ✓' : 'Tap to upload';
    if (_abpClear) _abpClear.style.display = _showInPanel ? '' : 'none';
    // Refresh NB Pro card bg thumbnails for all visible segments
    _refreshNbBgThumbs();
  }

  function _refreshNbBgThumbs() {
    if (!segments || segments.length === 0) return;
    segments.forEach((_, i) => {
      const wrap = document.getElementById('nbpreview-wrap-' + i);
      if (!wrap) return;
      const thumbRow = wrap.querySelector('[data-nb-bg-row]');
      if (!thumbRow) return;
      if (bgFromAvatar) {
        thumbRow.innerHTML = '<span style="font-size:11px;color:var(--text-3);">🖼 Using avatar photo as background (Photo 1 only — no Photo 2 needed)</span>';
      } else {
        const hasImg = !!bgImageDataUrl;
        thumbRow.innerHTML = `
          <div onclick="document.getElementById('bgImgInput').click()" style="width:36px;height:36px;border-radius:5px;overflow:hidden;border:1.5px solid ${hasImg ? 'var(--accent)' : 'var(--border)'};cursor:pointer;display:flex;align-items:center;justify-content:center;background:var(--surface-2);flex-shrink:0;">
            ${hasImg ? '<img id="nb-bg-thumb-' + i + '" style="width:100%;height:100%;object-fit:cover;">' : '<span style="font-size:16px;">🖼</span>'}
          </div>
          <span style="font-size:10px;color:${hasImg ? 'var(--accent)' : 'var(--text-3)'};">
            ${hasImg ? '📎 Photo 2 set — attach this image as Photo 2 in NB Pro (same for all scenes)' : 'No background uploaded — upload in the Background panel to use as Photo 2'}
          </span>`;
        if (hasImg) {
          const thumb = thumbRow.querySelector('#nb-bg-thumb-' + i);
          if (thumb) thumb.src = bgImageDataUrl;
        }
      }
    });
  }

  function onBgImageChange(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function(ev) {
      try {
        bgFromAvatar = false;
        DB.remove('sm_bg_from_avatar').catch(e => console.warn('onBgImageChange remove error:', e));
        _applyBgToUI(ev.target.result);
        DB.set('sm_bg_image', bgImageDataUrl).catch(e => console.warn('onBgImageChange set error:', e));
        // Extract a plain-text description of this background for use in NB prompts.
        // Also immediately patch prompts so photo_guide reflects Photo 2 right away
        // (before the async description arrives — extractBgDescription will patch again
        // with the full description once the API call completes).
        extractBgDescription(bgImageDataUrl);
        if (useAvatarBg && typeof patchNbPromptBackground === 'function') patchNbPromptBackground();
        const note = document.getElementById('bgSavedNote');
        if (note) { note.style.display = 'inline'; setTimeout(() => note.style.display = 'none', 2500); }
      } catch (err) {
        showToast('Failed to load background image — please try again.', 'error');
      }
    };
    reader.onerror = () => showToast('Could not read background image file.', 'error');
    reader.readAsDataURL(file);
  }

  function clearBgImage() {
    bgFromAvatar = false;
    useAvatarBg = false;
    bgDescription = '';
    DB.remove('sm_bg_from_avatar').catch(e => console.warn('clearBgFromAvatar error:', e));
    DB.remove('sm_use_avatar_bg').catch(e => console.warn('clearBgMode error:', e));
    DB.remove('sm_bg_description').catch(e => console.warn('clearBgDescription error:', e));
    _applyBgToUI(null);
    const _bgi = document.getElementById('bgImgInput');
    if (_bgi) _bgi.value = '';
    DB.remove('sm_bg_image').catch(e => console.warn('clearBgImage error:', e));
    const badge = document.getElementById('bgAvatarBadge');
    if (badge) badge.style.display = 'none';
    // Re-patch all prompts unconditionally so they drop the now-cleared Photo 2
    // reference and fall back to the avatar-Photo-1 instruction branch.
    if (typeof patchNbPromptBackground === 'function') patchNbPromptBackground();
  }

  function useAvatarAsBg() {
    if (!avatarImageDataUrl) {
      showToast('No avatar photo loaded yet — upload one in the Avatar panel first.', 'warning');
      return;
    }
    bgFromAvatar = true;
    _applyBgToUI(avatarImageDataUrl);
    DB.set('sm_bg_image', bgImageDataUrl).catch(e => console.warn('useAvatarAsBg bg error:', e));
    DB.set('sm_bg_from_avatar', '1').catch(e => console.warn('useAvatarAsBg flag error:', e));
    // Extract a plain-text description of the background in the avatar photo.
    // Also immediately patch prompts so photo_guide switches to bgFromAvatar mode
    // (description arrives async — extractBgDescription patches again when ready).
    extractBgDescription(avatarImageDataUrl);
    if (useAvatarBg && typeof patchNbPromptBackground === 'function') patchNbPromptBackground();
    const badge = document.getElementById('bgAvatarBadge');
    if (badge) badge.style.display = 'block';
    const note = document.getElementById('bgSavedNote');
    if (note) { note.style.display = 'inline'; setTimeout(() => note.style.display = 'none', 2500); }
  }

  // Programmatic background setter used by the "Generate from text" flow.
  // Sets a generated/uploaded scene image as the background and activates
  // background mode so it flows into NB Pro + Veo prompts (mockup has no
  // separate Lock toggle — choosing a background is what activates it).
  function setSceneBackground(dataUrl) {
    if (!dataUrl) { clearBgImage(); return; }
    bgFromAvatar = false;
    DB.remove('sm_bg_from_avatar').catch(() => {});
    _applyBgToUI(dataUrl);
    DB.set('sm_bg_image', bgImageDataUrl).catch(() => {});
    extractBgDescription(dataUrl);
    if (typeof patchNbPromptBackground === 'function') patchNbPromptBackground();
    const badge = document.getElementById('bgAvatarBadge');
    if (badge) badge.style.display = 'none';
  }
  window.setSceneBackground = setSceneBackground;

  // --- Brand Kit ---
  let _bkSaveTimer = null;

  function getBrandKit() {
    return {
      productName: document.getElementById('bkProductName')?.value.trim() || document.getElementById('sbProduct')?.value.trim() || '',
      productUrl:  document.getElementById('bkProductUrl')?.value.trim()  || '',
      tone:        document.getElementById('bkTone')?.value               || 'conversational',
      talkingPoints: document.getElementById('bkTalkingPoints')?.value.trim() || '',
      cta:         document.getElementById('bkCta')?.value.trim()         || '',
      avatarDesc:  (document.getElementById('avatarDesc') ? document.getElementById('avatarDesc').value.trim() : ''),
      setting:     (document.getElementById('studioSetting') ? document.getElementById('studioSetting').value.trim() : ''),
    };
  }

  function saveBrandKit() {
    clearTimeout(_bkSaveTimer);
    _bkSaveTimer = setTimeout(() => {
      DB.set('sm_brand_kit', JSON.stringify(getBrandKit())).catch(e => console.warn('saveBrandKit error:', e));
      const note = document.getElementById('bkSavedNote');
      if (note) { note.style.display = 'block'; setTimeout(() => note.style.display = 'none', 1800); }
    }, 600);
  }

  function loadBrandKit() {
    DB.get('sm_brand_kit').then(saved => {
      if (!saved) return;
      try {
        const kit = JSON.parse(saved);
        const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
        set('bkProductName',   kit.productName);
        set('bkProductUrl',    kit.productUrl);
        set('bkTalkingPoints', kit.talkingPoints);
        set('bkCta',           kit.cta);
        const toneEl = document.getElementById('bkTone');
        if (toneEl && kit.tone) toneEl.value = kit.tone;
      } catch(e) { console.warn('loadBrandKit parse error:', e); }
    }).catch(e => console.warn('loadBrandKit DB error:', e));
  }


  async function scrapeProductUrl() {
    const url = document.getElementById('bkProductUrl')?.value.trim();
    if (!url) { showToast('Paste a product URL first.', 'warning'); return; }
    const btn = document.getElementById('bkScrapeBtn');
    const origLabel = btn ? btn.textContent : '';
    if (btn) { btn.textContent = '⏳'; btn.disabled = true; }
    try {
      // Use GPT to extract product info from the URL via the server-side proxy
      const _bkKey = getApiKey();
      const res = await _fetchWithRetry('/.netlify/functions/openai-chat', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, _bkKey ? { 'X-Api-Key': _bkKey } : {}),
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: 'You are a product research assistant. The user will give you a product URL. Return a JSON object with these fields: productName (string), talkingPoints (array of 4-6 short benefit strings), suggestedCta (string). Keep talking points punchy, 3-7 words each. Return ONLY valid JSON, no markdown.' },
            { role: 'user', content: 'Product URL: ' + url + '\n\nExtract the product name, 4-6 key talking points (benefits/claims), and suggest a CTA for a social media ad. Infer from the URL domain and path if you cannot browse it.' }
          ],
          max_tokens: 400,
          temperature: 0.4,
        })
      }, 2);
      let data;
      try { data = await res.json(); } catch(_) { data = {}; }
      if (!res.ok) { throw new Error(data?.error?.message || `API error ${res.status}`); }
      const raw = data.choices?.[0]?.message?.content?.trim() || '';
      const jsonStr = raw.replace(/^```json\n?/, '').replace(/\n?```$/, '').trim();
      let parsed;
      try { parsed = JSON.parse(jsonStr); } catch(_) { throw new Error('AI returned an unexpected format — please try again.'); }
      if (parsed.productName) {
        const nameEl = document.getElementById('bkProductName');
        if (nameEl && !nameEl.value) nameEl.value = parsed.productName;
      }
      if (parsed.talkingPoints?.length) {
        const tpEl = document.getElementById('bkTalkingPoints');
        if (tpEl && !tpEl.value) tpEl.value = parsed.talkingPoints.join('\n');
      }
      if (parsed.suggestedCta) {
        const ctaEl = document.getElementById('bkCta');
        if (ctaEl && !ctaEl.value) ctaEl.value = parsed.suggestedCta;
      }
      saveBrandKit();
    } catch(e) {
      showToast('Could not fetch product info: ' + e.message, 'error');
    } finally {
      if (btn) { btn.textContent = origLabel; btn.disabled = false; }
    }
  }

  function loadBgImage() {
    Promise.all([DB.get('sm_bg_image'), DB.get('sm_bg_from_avatar'), DB.get('sm_use_avatar_bg'), DB.get('sm_bg_description')]).then(([saved, fromAvatar, avatarBg, savedDesc]) => {
      bgFromAvatar  = fromAvatar === '1';
      // Background-replace mode is retired: composites keep the ORIGINAL scene frame (aligned).
      // A stale saved "on" flag must not force the misaligned "imagine a new background" mode.
      useAvatarBg   = false;
      if (avatarBg === '1') DB.remove('sm_use_avatar_bg').catch(() => {});
      if (savedDesc) bgDescription = savedDesc;
      if (saved) _applyBgToUI(saved);
      const badge = document.getElementById('bgAvatarBadge');
      if (badge) badge.style.display = bgFromAvatar && saved ? 'block' : 'none';
    }).catch(e => console.warn('loadBgImage error:', e)).finally(() => {
      _syncAvatarBgUI();
    });
  }

  function _syncAvatarBgUI() {
    const btn  = document.getElementById('avatarBgToggleBtn');
    const note = document.getElementById('avatarBgActiveNote');
    const icon = document.getElementById('avatarBgToggleIcon');
    if (btn)  btn.style.background  = useAvatarBg ? 'rgba(124,106,247,0.22)' : 'rgba(124,106,247,0.07)';
    if (btn)  btn.style.borderColor = useAvatarBg ? 'rgba(124,106,247,0.7)'  : 'rgba(124,106,247,0.35)';
    if (icon) icon.textContent = useAvatarBg ? '☑' : '☐';
    if (note) note.style.display = useAvatarBg ? 'block' : 'none';
  }

  function toggleAvatarBgMode() {
    useAvatarBg = !useAvatarBg;
    (useAvatarBg ? DB.set('sm_use_avatar_bg', '1') : DB.remove('sm_use_avatar_bg')).catch(e => console.warn('toggleAvatarBgMode error:', e));
    _syncAvatarBgUI();
    // Instantly patch all existing NB prompts to reflect the new state — no API calls needed
    const updated = (typeof patchNbPromptBackground === 'function') ? patchNbPromptBackground() : 0;
    const msg = useAvatarBg
      ? (updated > 0 ? `🖼 Avatar background on — ${updated} prompt${updated !== 1 ? 's' : ''} updated` : '🖼 Avatar background on')
      : (updated > 0 ? `Avatar background off — ${updated} prompt${updated !== 1 ? 's' : ''} updated` : 'Avatar background off');
    showToast(msg, useAvatarBg ? 'success' : 'info', 3000);
  }

  // --- Reference video ---
  function onVideoFileChange(e) {
    const file = e.target.files[0];
    if (!file) return;
    refVideoFile = file; // Store for Whisper transcription
    if (refVideoObjectUrl) URL.revokeObjectURL(refVideoObjectUrl);
    refVideoObjectUrl = URL.createObjectURL(file);
    const videoEl = document.getElementById('refVideoEl');
    if (videoEl) { videoEl.src = refVideoObjectUrl; videoEl.style.display = 'block'; }
    const placeholder = document.getElementById('videoUploadPlaceholder');
    if (placeholder) placeholder.style.display = 'none';
    const _cvb = document.getElementById('clearVideoBtn');
    if (_cvb) _cvb.style.display = 'inline-block';
    const _slb = document.getElementById('saveVideoLibBtn');
    if (_slb) _slb.style.display = 'inline-block';
    if (document.getElementById('videoFileName')) document.getElementById('videoFileName').textContent = file.name;
    const _vuz = document.getElementById('videoUploadZone');
    if (_vuz) _vuz.onclick = null;
    showVideoMiniBtn?.(true);
    setTimeout(() => updateStepProgress?.(), 80);
    setTimeout(() => _qmUpdateUploadState?.(), 100);
  }

  function clearVideo() {
    showConfirm('Clear the reference video? This will also clear all segments.', () => {
      if (refVideoObjectUrl) { URL.revokeObjectURL(refVideoObjectUrl); refVideoObjectUrl = null; }
      refVideoFile = null;
      _activeLibraryVideoId = null;
      // Clear timestamps and segments — they belong to the old video
      whisperSegments = []; whisperWords = [];
      segments = [];
      saveCurrentProjectData();
      const videoEl = document.getElementById('refVideoEl');
      if (videoEl) { videoEl.removeAttribute('src'); videoEl.load(); videoEl.style.display = 'none'; }
      const _vph = document.getElementById('videoUploadPlaceholder');
      if (_vph) _vph.style.display = 'block';
      const _cvb2 = document.getElementById('clearVideoBtn');
      if (_cvb2) _cvb2.style.display = 'none';
      const _slb = document.getElementById('saveVideoLibBtn');
      if (_slb) _slb.style.display = 'none';
      if (document.getElementById('videoFileName')) document.getElementById('videoFileName').textContent = '';
      const _rvi = document.getElementById('refVideoInput');
      if (_rvi) _rvi.value = '';
      const _vuz2 = document.getElementById('videoUploadZone');
      if (_vuz2) _vuz2.onclick = function() { const _inp = document.getElementById('refVideoInput'); if (_inp) _inp.click(); };
      setVideoMini?.(false);
      showVideoMiniBtn?.(false);
    });
  }

  // Silently resets the video player UI without touching segments or showing any confirm.
  // Used when switching/creating projects so we never accidentally erase project data.
  function _resetVideoUI() {
    if (refVideoObjectUrl) { URL.revokeObjectURL(refVideoObjectUrl); refVideoObjectUrl = null; }
    refVideoFile = null;
    _activeLibraryVideoId = null;
    const videoEl = document.getElementById('refVideoEl');
    if (videoEl) { videoEl.removeAttribute('src'); videoEl.load(); videoEl.style.display = 'none'; }
    const placeholder = document.getElementById('videoUploadPlaceholder');
    if (placeholder) placeholder.style.display = 'block';
    const clearBtn = document.getElementById('clearVideoBtn');
    if (clearBtn) clearBtn.style.display = 'none';
    const slb = document.getElementById('saveVideoLibBtn');
   
    if (slb) slb.style.display = 'none';
    const fn = document.getElementById('videoFileName');
    if (fn) fn.textContent = '';
    const inp = document.getElementById('refVideoInput');
    if (inp) inp.value = '';
  }
