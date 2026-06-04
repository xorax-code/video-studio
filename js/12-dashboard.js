  // =========================================================
  // USER SETTINGS PANEL
  // =========================================================

  // ---- Accessibility helpers ----
  let _usetThemeChoice = 'system';

  function selectUsetTheme(t) {
    _usetThemeChoice = t;
    document.querySelectorAll('.uset-theme-btn').forEach(b => b.classList.remove('active'));
    const btn = document.getElementById('uset-theme-' + t);
    if (btn) btn.classList.add('active');
    // Live preview
    const resolved = t === 'system'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : t;
    document.documentElement.setAttribute('data-theme', resolved);
  }

  function previewUsetScale(val) {
    const disp = document.getElementById('uset-scale-display');
    if (disp) disp.textContent = val + '%';
    applyUiZoom(val);
  }

  // ── Background theme ──
  function selectBgTheme(btn) {
    document.querySelectorAll('.bg-theme-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    applyBgTheme(btn.dataset.bg);
  }
  function applyBgTheme(theme) {
    const el = document.documentElement;
    if (theme && theme !== 'midnight') {
      el.setAttribute('data-bg-theme', theme);
    } else {
      el.removeAttribute('data-bg-theme');
    }
  }

  // ── High Contrast ──
  function toggleHighContrast(on) {
    if (on) {
      document.documentElement.setAttribute('data-a11y-hc', '');
    } else {
      document.documentElement.removeAttribute('data-a11y-hc');
    }
    // Sync Settings panel checkbox
    const el = document.getElementById('uset-hc-toggle');
    if (el) el.checked = on;
    // Sync a11y bar checkbox
    const bar = document.getElementById('a11yBarHC');
    if (bar) bar.checked = on;
  }

  // ── Reduce Motion ──
  function toggleReduceMotion(on) {
    if (on) {
      document.documentElement.setAttribute('data-a11y-rm', '');
    } else {
      document.documentElement.removeAttribute('data-a11y-rm');
    }
    // Sync Settings panel checkbox
    const el = document.getElementById('uset-rm-toggle');
    if (el) el.checked = on;
    // Sync a11y bar checkbox
    const bar = document.getElementById('a11yBarRM');
    if (bar) bar.checked = on;
  }

  // ── Quick a11y bar scale ──
  function a11ySetScale(scale) {
    applyUiZoom(scale);
    const slider = document.getElementById('uset-scale-slider');
    const display = document.getElementById('uset-scale-display');
    if (slider) slider.value = scale;
    if (display) display.textContent = scale + '%';
    // Update button states
    document.querySelectorAll('.a11y-size-btn').forEach(b => {
      b.classList.toggle('active', parseInt(b.dataset.scale) === scale);
    });
    // Save
    const s = getUserSettings();
    if (s) { s.uiScale = scale; saveUserSettings(s); }
  }

  // Close a11y bar on outside click
  if (!window._a11yBarClickBound) {
    window._a11yBarClickBound = true;
    document.addEventListener('click', (e) => {
      const bar = document.getElementById('a11yBarPanel');
      const btn = document.getElementById('a11yBarToggle');
      if (bar && btn && !bar.contains(e.target) && !btn.contains(e.target)) {
        bar.classList.remove('open');
      }
    });
  }

  function applyUiZoom(scale) {
    const zoom = scale / 100;
    // `zoom` CSS property is Chrome/Edge only — use `transform: scale()` for Firefox compatibility
    const isFirefox = navigator.userAgent.includes('Firefox');
    if (isFirefox) {
      document.body.style.zoom      = '';
      document.body.style.transform = `scale(${zoom})`;
      document.body.style.transformOrigin = 'top left';
      document.body.style.width     = zoom !== 1 ? `${(100 / zoom).toFixed(4)}%` : '';
    } else {
      document.body.style.transform = '';
      document.body.style.width     = '';
      document.body.style.zoom      = zoom;
    }
    const topnav   = document.querySelector('.topnav');
    const mainArea = document.querySelector('.main-area');
    if (zoom > 1) {
      // Body must scroll so zoomed content isn't clipped
      document.body.style.height    = 'auto';
      document.body.style.overflowY = 'auto';
      document.body.style.overflowX = 'hidden';
      // Topnav sticks to top so it doesn't scroll away
      if (topnav) {
        topnav.style.position = 'sticky';
        topnav.style.top      = '0';
        topnav.style.zIndex   = '9999';
      }
      // Main area flows naturally — body provides the outer scroll
      if (mainArea) {
        mainArea.style.height    = 'auto';
        mainArea.style.overflowY = 'visible';
      }
    } else {
      // Restore default fixed-viewport layout
      document.body.style.height    = '';
      document.body.style.overflowY = '';
      document.body.style.overflowX = '';
      if (topnav) {
        topnav.style.position = '';
        topnav.style.top      = '';
        topnav.style.zIndex   = '';
      }
      if (mainArea) {
        mainArea.style.height    = '';
        mainArea.style.overflowY = '';
      }
    }
  }

  function _showUsetSaved() {
    const el = document.getElementById('usetSaveStatus');
    if (el) { el.style.display = 'block'; setTimeout(() => { el.style.display = 'none'; }, 1800); }
  }

  function saveAccessibilitySettings() {
    const s = getUserSettings();
    if (!s) return;
    const _activeThemeBtn = document.querySelector('.uset-theme-btn.active');
    s.themeMode = (_activeThemeBtn?.id || '').replace('uset-theme-', '') || _usetThemeChoice;
    const _sliderEl = document.getElementById('uset-scale-slider');
    s.uiScale   = _sliderEl ? (parseInt(_sliderEl.value) || 100) : (s.uiScale || 100);
    // Accent color
    const chosen = document.querySelector('.uset-accent-swatch.selected');
    if (chosen) { s.accentColor = chosen.dataset.color; applyAccentColor(s.accentColor); }
    // Background theme
    const activeBg = document.querySelector('.bg-theme-btn.active');
    if (activeBg) { s.bgTheme = activeBg.dataset.bg; applyBgTheme(s.bgTheme); }
    // Accessibility toggles
    s.highContrast = document.getElementById('uset-hc-toggle')?.checked || false;
    s.reduceMotion = document.getElementById('uset-rm-toggle')?.checked || false;
    saveUserSettings(s);
    const resolved = s.themeMode === 'system'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : s.themeMode;
    applyTheme(resolved);
    _showUsetSaved();
  }

  function saveProfileTab() {
    const s = getUserSettings();
    if (!s) return;
    const _udn = document.getElementById('uset-displayName');
    const _utag = document.getElementById('uset-tagline');
    s.displayName = _udn ? _udn.value.trim() : (s.displayName || '');
    s.tagline = _utag ? _utag.value.trim() : (s.tagline || '');
    if (_usetAvatarDataUrl !== undefined) s.avatarDataUrl = _usetAvatarDataUrl;
    saveUserSettings(s);
    _showUsetSaved();
    // Sync topnav chip with new display name (fall back to email)
    if (_sb) {
      _sb.auth.getSession()
        .then(({ data }) => { updateUserChip(s.displayName || (data?.session?.user?.email) || ''); })
        .catch(() => updateUserChip(s.displayName || ''));
    } else {
      updateUserChip(s.displayName || '');
    }
    // Re-render dashboard greeting live if open
    const _tabDash = document.getElementById('tab-dashboard');
    if (_tabDash && _tabDash.classList.contains('active')) renderDashboard();
  }

  async function saveNewPassword() {
    const pw  = document.getElementById('uset-newPassword')?.value  || '';
    const pw2 = document.getElementById('uset-confirmPassword')?.value || '';
    const errEl = document.getElementById('uset-pwError');
    const okEl  = document.getElementById('uset-pwSuccess');
    if (errEl) errEl.style.display = 'none';
    if (okEl)  okEl.style.display  = 'none';
    if (!pw) { if (errEl) { errEl.textContent = 'Please enter a new password.'; errEl.style.display = 'block'; } return; }
    if (pw.length < 8) { if (errEl) { errEl.textContent = 'Password must be at least 8 characters.'; errEl.style.display = 'block'; } return; }
    if (pw !== pw2) { if (errEl) { errEl.textContent = 'Passwords do not match.'; errEl.style.display = 'block'; } return; }
    if (!_sb) { if (errEl) { errEl.textContent = 'Not connected to Supabase.'; errEl.style.display = 'block'; } return; }
    try {
      const { error } = await _sb.auth.updateUser({ password: pw });
      if (error) {
        if (errEl) { errEl.textContent = error.message; errEl.style.display = 'block'; }
      } else {
        if (okEl) okEl.style.display = 'block';
        const _npEl = document.getElementById('uset-newPassword');
        const _cpEl = document.getElementById('uset-confirmPassword');
        if (_npEl) _npEl.value = '';
        if (_cpEl) _cpEl.value = '';
      }
    } catch (err) {
      if (errEl) { errEl.textContent = 'Network error: ' + (err.message || String(err)); errEl.style.display = 'block'; }
    }
  }

  let _reminderTimeout = null;

  // Exposed globally so doLogout() (in 11-settings.js) can cancel the timer before redirecting
  function clearReminderTimer() {
    if (_reminderTimeout) { clearTimeout(_reminderTimeout); _reminderTimeout = null; }
  }

  function saveNotificationsTab() {
    const s = getUserSettings();
    if (!s) return;
    const _reEl = document.getElementById('uset-reminderEnabled');
    const _rtEl = document.getElementById('uset-reminderTime');
    s.reminderEnabled = _reEl ? !!_reEl.checked : !!s.reminderEnabled;
    s.reminderTime    = _rtEl ? (_rtEl.value || '09:00') : (s.reminderTime || '09:00');
    saveUserSettings(s);
    if (!s.reminderEnabled) {
      if (_reminderTimeout) { clearTimeout(_reminderTimeout); _reminderTimeout = null; }
    } else {
      _scheduleReminder(s.reminderTime);
    }
    _showUsetSaved();
  }

  function saveGoalsTab() {
    const s = getUserSettings();
    if (!s) return;
    const _wgEl = document.getElementById('uset-weeklyGoal');
    s.weeklyGoal = _wgEl ? (parseInt(_wgEl.value) || 7) : (s.weeklyGoal || 7);
    // Per-platform goals
    s.goalsPerPlatform = {};
    document.querySelectorAll('.uset-platform-goal').forEach(inp => {
      const val = parseInt(inp.value);
      if (val > 0) s.goalsPerPlatform[inp.dataset.platform] = val;
    });
    saveUserSettings(s);
    _showUsetSaved();
  }

  function _scheduleReminder(timeStr) {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'denied') return;
    if (Notification.permission === 'default') {
      Notification.requestPermission().then(p => { if (p === 'granted') _scheduleReminder(timeStr); });
      return;
    }
    if (_reminderTimeout) clearTimeout(_reminderTimeout);
    const [hh, mm] = (timeStr || '09:00').split(':').map(Number);
    const now = new Date();
    const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0);
    if (target <= now) target.setDate(target.getDate() + 1);
    const ms = target - now;
    _reminderTimeout = setTimeout(() => {
      new Notification('Daily Posting Reminder', { body: "Time to post! Open your app and check today's plan.", icon: '/favicon.ico' });
      _scheduleReminder(timeStr); // reschedule for tomorrow
    }, ms);
  }

  let _usetAvatarDataUrl;
  function _handleAvatarUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) { showToast('Please select an image file.', 'warning'); return; }
    if (file.size > 2 * 1024 * 1024) { showToast('Profile photo must be under 2 MB — please resize first.', 'warning'); return; }
    const reader = new FileReader();
    reader.onload = ev => {
      _usetAvatarDataUrl = ev.target.result;
      const prev = document.getElementById('uset-avatarPreview');
      if (prev) { prev.src = _usetAvatarDataUrl; prev.style.display = 'block'; }
      const _uph = document.getElementById('uset-avatarPlaceholder');
      if (_uph) _uph.style.display = 'none';
      const clrBtn = document.getElementById('uset-avatarClearBtn');
      if (clrBtn) clrBtn.style.display = 'flex';
    };
    reader.readAsDataURL(file);
  }
  function _clearAvatar() {
    _usetAvatarDataUrl = '';
    const prev = document.getElementById('uset-avatarPreview');
    if (prev) { prev.src = ''; prev.style.display = 'none'; }
    const _uph = document.getElementById('uset-avatarPlaceholder');
    if (_uph) _uph.style.display = 'flex';
    const clrBtn = document.getElementById('uset-avatarClearBtn');
    if (clrBtn) clrBtn.style.display = 'none';
  }
  function _selectAccentSwatch(el) {
    document.querySelectorAll('.uset-accent-swatch').forEach(s => s.classList.remove('selected'));
    el.classList.add('selected');
  }

  function applyAccessibilityOnBoot() {
    const s = getUserSettings();
    if (!s) return;
    if (s.uiScale) applyUiZoom(s.uiScale);
    // Accent color
    if (s.accentColor) { if (typeof applyAccentColor === 'function') applyAccentColor(s.accentColor); }
    // Background theme
    if (s.bgTheme && s.bgTheme !== 'midnight') applyBgTheme(s.bgTheme);
    // High contrast
    if (s.highContrast) toggleHighContrast(true);
    // Reduce motion — also respect OS preference
    const prefersRM = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (s.reduceMotion || prefersRM) toggleReduceMotion(true);
    // Reminder
    if (s.reminderEnabled && s.reminderTime) _scheduleReminder(s.reminderTime);
    const mode = s.themeMode || 'system';
    if (mode === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      applyTheme(mq.matches ? 'dark' : 'light');
      mq.addEventListener('change', e => {
        const _mqS = getUserSettings();
        if (_mqS && _mqS.themeMode === 'system') applyTheme(e.matches ? 'dark' : 'light');
      });
    } else {
      applyTheme(mode);
    }
  }

  function _populateAccessibilityTab() {
    const s = getUserSettings();
    if (!s) return;
    _usetThemeChoice = s.themeMode || 'system';
    document.querySelectorAll('.uset-theme-btn').forEach(b => b.classList.remove('active'));
    const activeBtn = document.getElementById('uset-theme-' + _usetThemeChoice);
    if (activeBtn) activeBtn.classList.add('active');
    const scale = s.uiScale || 100;
    const slider = document.getElementById('uset-scale-slider');
    const display = document.getElementById('uset-scale-display');
    if (slider) slider.value = scale;
    if (display) display.textContent = scale + '%';
    // Background theme
    const bgTheme = s.bgTheme || 'midnight';
    document.querySelectorAll('.bg-theme-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.bg === bgTheme);
    });
    // Accessibility toggles
    const hcEl = document.getElementById('uset-hc-toggle');
    if (hcEl) hcEl.checked = !!s.highContrast;
    const rmEl = document.getElementById('uset-rm-toggle');
    if (rmEl) rmEl.checked = !!s.reduceMotion;
  }

  function openUserSettings(tab) {
    const s = getUserSettings();
    if (!s) { showToast('Could not load settings.', 'error'); return; }
    // Setup tab
    const _dlEl = document.getElementById('uset-dlPath');
    if (_dlEl) _dlEl.value = s.dlPath || '';
    const cb = document.getElementById('uset-claudeBrowser');
    if (cb) cb.checked = s.claudeBrowserMode !== false;
    updateClaudeBrowserDisplay();
    // Profile tab
    const _udn = document.getElementById('uset-displayName');
    if (_udn) _udn.value = s.displayName || '';
    const _utag = document.getElementById('uset-tagline');
    if (_utag) _utag.value = s.tagline || '';
    // Show account email (read-only, from Supabase session)
    const _uemail = document.getElementById('uset-accountEmail');
    if (_uemail) {
      const _emailVal = window._supabaseEmail || '';
      if (_emailVal) {
        _uemail.textContent = _emailVal;
      } else if (_sb) {
        _sb.auth.getSession().then(({ data }) => {
          if (_uemail && data?.session?.user?.email) _uemail.textContent = data.session.user.email;
        }).catch(() => {});
      }
    }
    _usetAvatarDataUrl = s.avatarDataUrl || '';
    const prev = document.getElementById('uset-avatarPreview');
    const ph = document.getElementById('uset-avatarPlaceholder');
    const clrBtn = document.getElementById('uset-avatarClearBtn');
    if (s.avatarDataUrl) {
      if (prev) { prev.src = s.avatarDataUrl; prev.style.display='block'; }
      if (ph) ph.style.display='none';
      if (clrBtn) clrBtn.style.display='flex';
    } else {
      if (prev) { prev.src=''; prev.style.display='none'; }
      if (ph) ph.style.display='flex';
      if (clrBtn) clrBtn.style.display='none';
    }
    // Goals tab
    const _wgInit = document.getElementById('uset-weeklyGoal');
    if (_wgInit) _wgInit.value = s.weeklyGoal || 7;
    const _reInit = document.getElementById('uset-reminderEnabled');
    if (_reInit) _reInit.checked = !!s.reminderEnabled;
    const _rtInit = document.getElementById('uset-reminderTime');
    if (_rtInit) _rtInit.value = s.reminderTime || '09:00';
    ['TikTok','Instagram','Facebook','YouTube'].forEach(p => {
      const inp = document.querySelector(`.uset-platform-goal[data-platform="${p}"]`);
      if (inp) inp.value = (s.goalsPerPlatform||{})[p] || '';
    });
    // Appearance tab
    _populateAccessibilityTab();
    const accentName = s.accentColor || 'purple';
    document.querySelectorAll('.uset-accent-swatch').forEach(sw => {
      sw.classList.toggle('selected', sw.dataset.color === accentName);
    });
    const _usoEl = document.getElementById('userSettingsOverlay');
    if (_usoEl) _usoEl.classList.add('open');
    switchUserTab(tab || 'profile');
  }

  function closeUserSettings() {
    const _usoEl = document.getElementById('userSettingsOverlay');
    if (_usoEl) _usoEl.classList.remove('open');
  }

  function switchUserTab(name) {
    document.querySelectorAll('.uset-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    document.querySelectorAll('.uset-tab-content').forEach(c => c.classList.toggle('active', c.id === 'uset-tab-' + name));
    if (name === 'billing') renderBillingTab();
  }

  // ── Stripe price IDs — used by legacy startCheckout() (backend flow) ──
  const STRIPE_PRICES = {
    starter: 'price_1TaviyJEBUETI2v87J63pMtV',
    pro:     'price_1TavjOJEBUETI2v85qh8DA6Z',
    agency:  'price_1TavlqJEBUETI2v8JSHkL5Ez',
  };

  // ── Stripe Payment Links — no backend needed, redirects directly to Stripe ──
  const STRIPE_PAYMENT_LINKS = {
    starter: 'https://buy.stripe.com/eVqfZif9JcHR4rE3bm2go0s',
    pro:     'https://buy.stripe.com/28E00kgdN9vF6zMaDO2go0t',
    agency:  'https://buy.stripe.com/cNi5kEbXxcHRbU64fq2go0u',
  };

  // ── Promo codes ──────────────────────────────────────────────
  // type:'unlock'   → unlocks `tier` immediately — validated SERVER-SIDE via /.netlify/functions/validate-promo
  // type:'discount' → stores a % off applied at Stripe checkout (client-side only, no bypass risk)
  // Unlock codes are NOT stored here — they live in netlify/functions/validate-promo.js only.
  const PROMO_CODES = {
    // Discount codes only (plaintext is fine — they reduce price, they can't bypass payment)
    FRIEND50: { type: 'discount', pct: 50, label: '50% Off Any Plan' },
    LAUNCH30: { type: 'discount', pct: 30, label: '30% Off — Launch Special' },
    SAVE20:   { type: 'discount', pct: 20, label: '20% Off' },
  };

  const PROMO_STORAGE_KEY = 'affiliateos_promo_v1';

  function loadSavedPromo() {
    try {
      const saved = JSON.parse(localStorage.getItem(PROMO_STORAGE_KEY) || 'null');
      if (!saved || !saved.code) return null;
      const code = saved.code.toUpperCase();
      // Unlock codes: trust the server-validated result stored at submission time
      if (saved.type === 'unlock') {
        if (!saved.tier || !saved.label) { localStorage.removeItem(PROMO_STORAGE_KEY); return null; }
        return { code, type: 'unlock', tier: saved.tier, label: saved.label };
      }
      // Discount codes: re-validate client-side (they're kept here)
      const def = PROMO_CODES[code];
      if (!def) { localStorage.removeItem(PROMO_STORAGE_KEY); return null; }
      return { code, ...def };
    } catch { return null; }
  }

  function applyPromoOverride() {
    const promo = loadSavedPromo();
    if (!promo) return;
    if (promo.type === 'unlock') {
      // Unlock tier overrides Stripe tier unless Stripe has a higher tier
      const order = ['free','starter','pro','agency'];
      const stripeIdx = order.indexOf(window._stripeTier || 'free');
      const promoIdx  = order.indexOf(promo.tier);
      if (promoIdx > stripeIdx) window._stripeTier = promo.tier;
    }
    window._activePromo = promo;
  }

  async function submitPromoCode() {
    const input = document.getElementById('promoCodeInput');
    if (!input) return;
    const code = (input.value || '').trim().toUpperCase();
    if (!code) { showToast('Enter a promo code first.', 'warning'); return; }

    // ── Discount codes: validate client-side (no bypass risk) ──────────────
    const discountDef = PROMO_CODES[code];
    if (discountDef && discountDef.type === 'discount') {
      localStorage.setItem(PROMO_STORAGE_KEY, JSON.stringify({
        code, type: 'discount', pct: discountDef.pct, label: discountDef.label
      }));
      window._activePromo = { code, ...discountDef };
      showToast('✅ ' + discountDef.label + ' — saved! Discount applies at checkout.', 'success', 5000);
      renderBillingTab();
      return;
    }

    // ── Unlock codes: validate server-side ─────────────────────────────────
    const btn = document.getElementById('promoSubmitBtn');
    const originalLabel = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }

    try {
      const resp = await fetch('/.netlify/functions/validate-promo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });

      if (!resp.ok) throw new Error('Server error ' + resp.status);
      const result = await resp.json();

      if (!result.valid) {
        showToast('Invalid promo code — please check and try again.', 'error');
        return;
      }

      // Server confirmed valid — store all fields so we don't need to re-validate later
      const def = { type: result.type, tier: result.tier, label: result.label };
      localStorage.setItem(PROMO_STORAGE_KEY, JSON.stringify({ code, ...def }));
      window._activePromo = { code, ...def };

      const order = ['free', 'starter', 'pro', 'agency'];
      const stripeIdx = order.indexOf(window._stripeTier || 'free');
      const promoIdx  = order.indexOf(def.tier);
      if (promoIdx > stripeIdx) window._stripeTier = def.tier;

      showToast('🎉 ' + def.label + ' — activated!', 'success', 5000);
      renderBillingTab();

    } catch (e) {
      console.error('[submitPromoCode]', e);
      showToast('Could not validate code — check your connection and try again.', 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = originalLabel; }
    }
  }

  function removePromoCode() {
    localStorage.removeItem(PROMO_STORAGE_KEY);
    window._activePromo = null;
    // Restore Stripe tier
    window._stripeTier = window._stripeBaseTier || 'free';
    showToast('Promo code removed.', 'info');
    renderBillingTab();
  }

  // Free trial duration — change this one number to adjust trial length for all users
  const TRIAL_DAYS = 3;

  function getTrialStatus() {
    const raw = localStorage.getItem('aff_os_first_login');
    if (!raw) return { active: true, daysLeft: TRIAL_DAYS, expired: false };
    const _ts = Number(raw);
    if (isNaN(_ts)) return { active: true, daysLeft: TRIAL_DAYS, expired: false };
    const msElapsed = Date.now() - _ts;
    const daysElapsed = msElapsed / (1000 * 60 * 60 * 24);
    const daysLeft = Math.max(0, Math.ceil(TRIAL_DAYS - daysElapsed));
    return { active: daysLeft > 0, daysLeft, expired: daysLeft === 0 };
  }

  // Expose globally so other JS files can call it
  window.getTrialStatus = getTrialStatus;

  // ── Feature access gate ──────────────────────────────────────────────────────
  // Returns true if the user can use paid features (active trial OR paid tier).
  // Returns false and shows the upgrade wall if trial has expired on free tier.
  window.requireAccess = function requireAccess() {
    const tier = window._stripeTier || 'free';
    if (tier !== 'free') return true;          // paid tier — always allow
    const trial = getTrialStatus();
    if (!trial.expired) return true;           // active trial — allow
    if (typeof window.showTrialExpiredWall === 'function') window.showTrialExpiredWall();
    return false;
  };

  // ── Trial-expired paywall ────────────────────────────────────────────────────
  // Full-screen, non-dismissible overlay. Shown on app load and on any blocked action.
  // Exposed globally so 11-settings.js can call it after auth boot.
  window.showTrialExpiredWall = function showTrialExpiredWall() {
    if (document.getElementById('trialExpiredWall')) return; // already showing

    const links = STRIPE_PAYMENT_LINKS || {};
    const email = encodeURIComponent(window._supabaseEmail || '');
    const uid   = encodeURIComponent(window._supabaseUid   || '');

    function buildLink(planKey) {
      const base = links[planKey];
      if (!base) return null;
      const sep = base.includes('?') ? '&' : '?';
      let url = base;
      if (email) url += sep + 'prefilled_email=' + email;
      if (uid)   url += (email ? '&' : sep) + 'client_reference_id=' + uid;
      return url;
    }

    const starterUrl = buildLink('starter');
    const proUrl     = buildLink('pro');

    const wall = document.createElement('div');
    wall.id = 'trialExpiredWall';
    wall.style.cssText = 'position:fixed;inset:0;z-index:999999;display:flex;align-items:center;justify-content:center;background:rgba(5,4,12,0.97);backdrop-filter:blur(12px);padding:20px;overflow-y:auto;';
    wall.innerHTML = `
      <div style="width:100%;max-width:540px;text-align:center;padding:8px 0 24px;">
        <!-- Icon -->
        <div style="width:72px;height:72px;border-radius:50%;background:rgba(248,113,113,0.1);border:1.5px solid rgba(248,113,113,0.35);display:flex;align-items:center;justify-content:center;margin:0 auto 20px;">
          <i class="ti ti-lock" style="font-size:28px;color:#f87171;"></i>
        </div>
        <div style="font-size:1.45rem;font-weight:800;color:var(--text-1);margin-bottom:10px;line-height:1.2;">Your free trial has ended</div>
        <div style="font-size:0.9rem;color:var(--text-3);line-height:1.6;margin-bottom:30px;max-width:400px;margin-left:auto;margin-right:auto;">
          Pick a plan to keep your access to the Video Replicator, Veo 3 prompt generator, and everything else you built during your trial.
        </div>

        <!-- Plan cards -->
        <div style="display:flex;flex-direction:column;gap:12px;margin-bottom:24px;">

          <!-- Starter -->
          <div style="background:rgba(255,255,255,0.03);border:1px solid var(--border-2);border-radius:14px;padding:18px 20px;text-align:left;display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;">
            <div style="flex:1;min-width:160px;">
              <div style="font-size:0.95rem;font-weight:700;color:var(--text-1);margin-bottom:3px;">Starter <span style="font-size:0.8rem;font-weight:600;color:var(--text-3);">$47/mo</span></div>
              <div style="font-size:0.78rem;color:var(--text-3);line-height:1.5;">Full Video Replicator · Veo 3 + NB Pro · 5 accounts · Viral scripts</div>
            </div>
            ${starterUrl
              ? `<a href="${starterUrl}" target="_blank" rel="noopener" style="flex-shrink:0;padding:10px 20px;border-radius:8px;background:var(--surface-2);border:1px solid var(--border-2);color:var(--text-1);font-size:0.82rem;font-weight:700;text-decoration:none;white-space:nowrap;transition:border-color 0.2s;" onmouseover="this.style.borderColor='var(--accent)'" onmouseout="this.style.borderColor='var(--border-2)'">Choose Starter →</a>`
              : `<button onclick="openUpgradeModal('starter')" style="flex-shrink:0;padding:10px 20px;border-radius:8px;background:var(--surface-2);border:1px solid var(--border-2);color:var(--text-1);font-size:0.82rem;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap;">Choose Starter →</button>`}
          </div>

          <!-- Pro (highlighted) -->
          <div style="background:rgba(124,106,247,0.06);border:1.5px solid rgba(124,106,247,0.4);border-radius:14px;padding:18px 20px;text-align:left;display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;position:relative;">
            <div style="position:absolute;top:-10px;left:18px;background:var(--grad-accent);color:#fff;font-size:0.67rem;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;padding:3px 10px;border-radius:20px;">Most Popular</div>
            <div style="flex:1;min-width:160px;">
              <div style="font-size:0.95rem;font-weight:700;color:var(--text-1);margin-bottom:3px;">Pro <span style="font-size:0.8rem;font-weight:600;color:var(--text-3);">$97/mo</span></div>
              <div style="font-size:0.78rem;color:var(--text-3);line-height:1.5;">Everything in Starter · Unlimited accounts · Multiple script variations · Priority AI</div>
            </div>
            ${proUrl
              ? `<a href="${proUrl}" target="_blank" rel="noopener" style="flex-shrink:0;padding:10px 20px;border-radius:8px;background:var(--grad-accent);border:none;color:#fff;font-size:0.82rem;font-weight:700;text-decoration:none;white-space:nowrap;">Choose Pro →</a>`
              : `<button onclick="openUpgradeModal('pro')" style="flex-shrink:0;padding:10px 20px;border-radius:8px;background:var(--grad-accent);border:none;color:#fff;font-size:0.82rem;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap;">Choose Pro →</button>`}
          </div>

        </div>

        <!-- Promo code -->
        <div style="margin-bottom:20px;">
          <div style="font-size:0.78rem;color:var(--text-3);margin-bottom:10px;">Have a promo or unlock code?</div>
          <div style="display:flex;gap:8px;max-width:300px;margin:0 auto;">
            <input id="wallPromoInput" type="text" placeholder="Enter code" autocomplete="off"
              style="flex:1;padding:9px 12px;background:var(--bg);border:1px solid var(--border-2);border-radius:8px;color:var(--text-1);font-size:12px;font-family:inherit;letter-spacing:0.5px;text-transform:uppercase;outline:none;"
              onfocus="this.style.borderColor='var(--accent)'" onblur="this.style.borderColor='var(--border-2)'"
              onkeydown="if(event.key==='Enter')_submitWallPromo()">
            <button onclick="_submitWallPromo()" style="padding:9px 16px;border-radius:8px;background:var(--surface-2);border:1px solid var(--border-2);color:var(--text-1);font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap;">Apply</button>
          </div>
          <div id="wallPromoMsg" style="font-size:11px;margin-top:8px;min-height:16px;"></div>
        </div>

        <!-- Sign out -->
        <button onclick="if(typeof window.doLogout==='function')window.doLogout();else location.href='/login.html';"
          style="background:none;border:none;color:var(--text-3);font-size:0.75rem;cursor:pointer;font-family:inherit;text-decoration:underline;">
          Sign out and switch accounts
        </button>
      </div>`;

    document.body.appendChild(wall);
  }

  // Promo submission from the trial-expired wall
  window._submitWallPromo = async function _submitWallPromo() {
    const input = document.getElementById('wallPromoInput');
    const msg   = document.getElementById('wallPromoMsg');
    if (!input) return;
    const code = (input.value || '').trim().toUpperCase();
    if (!code) { input.focus(); return; }
    if (msg) { msg.textContent = 'Checking…'; msg.style.color = 'var(--text-3)'; }

    // Try server-side unlock codes first
    try {
      const resp = await fetch('/.netlify/functions/validate-promo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data.valid && data.type === 'unlock') {
          const promoData = { code, type: 'unlock', tier: data.tier, label: data.label };
          try { localStorage.setItem(PROMO_STORAGE_KEY, JSON.stringify(promoData)); } catch {}
          window._activePromo = promoData;
          window._stripeTier      = data.tier;
          window._stripeBaseTier  = data.tier;
          applyPromoOverride();
          document.getElementById('trialExpiredWall')?.remove();
          showToast('🎉 ' + data.label + ' — activated!', 'success', 5000);
          renderBillingTab();
          return;
        }
        // Server responded but code was not valid — show server's reason if available
        if (!data.valid) {
          if (msg) { msg.textContent = data.message || 'Code not recognised.'; msg.style.color = '#f87171'; }
          input.style.borderColor = '#f87171';
          setTimeout(() => { if (input) input.style.borderColor = ''; }, 2000);
          return;
        }
      }
    } catch (e) {
      console.warn('Wall promo server check failed:', e);
      if (msg) { msg.textContent = 'Network error — please try again.'; msg.style.color = '#f87171'; }
      return; // don't fall through to discount check on network error
    }

    // Try client-side discount codes
    const discountDef = (typeof PROMO_CODES !== 'undefined') ? PROMO_CODES[code] : null;
    if (discountDef) {
      if (msg) { msg.textContent = 'Discount codes require an active paid plan first.'; msg.style.color = '#f87171'; }
      return;
    }

    if (msg) { msg.textContent = 'Code not recognised.'; msg.style.color = '#f87171'; }
    input.style.borderColor = '#f87171';
    setTimeout(() => { if (input) input.style.borderColor = ''; }, 2000);
  };

  const PLAN_INFO = {
    free:    { label: 'Free Trial', price: '$0',      desc: '3-day full access · Video Replicator · Veo 3 prompts · NB Pro workflow · Viral Scripts' },
    starter: { label: 'Starter',   price: '$47/mo',  desc: '1,000 credits/mo (~8 videos) · Full Video Replicator · Veo 3 + NB Pro · Up to 5 tracked accounts · Viral Scripts' },
    pro:     { label: 'Pro',       price: '$97/mo',  desc: '4,000 credits/mo (~33 videos) · Everything in Starter · Unlimited accounts · Multiple script variations · Priority AI' },
    agency:  { label: 'Agency',    price: '$197/mo', desc: 'Everything in Pro · Multiple avatars · Team seats · White-label exports' },
  };

  const PLAN_ORDER = ['free', 'starter', 'pro', 'agency'];

  function renderBillingTab() {
    const container = document.getElementById('billingTabContent');
    if (!container) return;

    const activePromo = window._activePromo || null;
    const tier       = window._stripeTier || 'free';
    // const customerId = window._stripeCustomerId || null; // unused
    const planInfo   = PLAN_INFO[tier] || PLAN_INFO.free;
    const tierIdx    = PLAN_ORDER.indexOf(tier);
    // XSS-safe promo code for HTML interpolation
    const _safeActiveCode = activePromo ? String(activePromo.code || '').replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c])) : '';

    const manageBtnHtml = `<button onclick="openBillingPortal()" style="padding:8px 18px;border-radius:8px;background:var(--grad-accent);border:none;color:#fff;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;">Billing & Cancellation</button>`;

    const plansHtml = PLAN_ORDER.map((planKey, idx) => {
      const info       = PLAN_INFO[planKey];
      const isCurrent  = planKey === tier;
      const isUpgrade  = idx > tierIdx;
      const isAgency   = planKey === 'agency';
      const border     = isCurrent ? '1px solid var(--accent)' : '1px solid var(--border)';
      const bg         = isCurrent ? 'rgba(124,106,247,0.07)' : 'var(--surface-2)';

      let actionHtml = '';
      if (isCurrent) {
        actionHtml = `<span style="font-size:10px;font-weight:700;padding:3px 9px;border-radius:5px;background:rgba(16,185,129,0.15);color:#4ade80;">CURRENT</span>`;
      } else if (isUpgrade) {
        actionHtml = `<button onclick="openUpgradeModal('${planKey}')" style="padding:7px 16px;border-radius:7px;background:var(--grad-accent);border:none;color:#fff;font-size:11.5px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap;">Upgrade</button>`;
      }

      const rec = planKey === 'pro' && tier === 'free'
        ? `<span style="font-size:10px;font-weight:700;padding:2px 7px;border-radius:4px;background:var(--grad-accent);color:#fff;margin-left:6px;">RECOMMENDED</span>`
        : '';

      return `<div style="background:${bg};border:${border};border-radius:10px;padding:14px 16px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
        <div>
          <div style="font-size:13px;font-weight:700;color:var(--text-1);margin-bottom:3px;">
            ${info.label} <span style="font-size:11px;font-weight:500;color:var(--text-3);">— ${info.price}</span>${rec}
          </div>
          <div style="font-size:11px;color:var(--text-3);">${info.desc}</div>
        </div>
        ${actionHtml}
      </div>`;
    }).join('');

    // Trial banner — only shown for free-tier users
    let trialBannerHtml = '';
    if (tier === 'free') {
      const trial = getTrialStatus();
      if (trial.expired) {
        trialBannerHtml = `
        <div style="background:rgba(248,113,113,0.08);border:1px solid rgba(248,113,113,0.35);border-radius:10px;padding:14px 18px;margin-bottom:16px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
          <div style="display:flex;align-items:center;gap:10px;">
            <span style="font-size:20px;">⏳</span>
            <div>
              <div style="font-size:13px;font-weight:700;color:#f87171;margin-bottom:2px;">Your free trial has ended</div>
              <div style="font-size:11px;color:var(--text-3);">Upgrade to keep access to the Video Studio, Veo 3 prompts, and all features.</div>
            </div>
          </div>
          <button onclick="openUpgradeModal('starter')" style="padding:9px 18px;border-radius:8px;background:var(--grad-accent);border:none;color:#fff;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap;flex-shrink:0;">Upgrade Now →</button>
        </div>`;
      } else {
        const urgency = trial.daysLeft === 1
          ? `<span style="color:#f87171;font-weight:700;">Last day!</span> `
          : trial.daysLeft === 2 ? `<span style="color:#fbbf24;font-weight:700;">2 days left</span> — ` : '';
        trialBannerHtml = `
        <div style="background:rgba(251,191,36,0.07);border:1px solid rgba(251,191,36,0.3);border-radius:10px;padding:14px 18px;margin-bottom:16px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
          <div style="display:flex;align-items:center;gap:10px;">
            <span style="font-size:20px;">🎁</span>
            <div>
              <div style="font-size:13px;font-weight:700;color:var(--warning);margin-bottom:2px;">${urgency}Free Trial — ${trial.daysLeft} day${trial.daysLeft !== 1 ? 's' : ''} remaining</div>
              <div style="font-size:11px;color:var(--text-3);">You have full access during your trial. Upgrade before it ends to keep everything.</div>
            </div>
          </div>
          <button onclick="openUpgradeModal('starter')" style="padding:8px 16px;border-radius:8px;background:var(--surface-2);border:1px solid var(--border);color:var(--text-2);font-size:11.5px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap;flex-shrink:0;">View Plans</button>
        </div>`;
      }
    }

    container.innerHTML = trialBannerHtml + `
      <div class="uset-section-title">Current Plan</div>
      <div style="background:var(--surface-2);border:1px solid var(--border-2);border-radius:12px;padding:18px 20px;margin-bottom:20px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;">
        <div>
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
            <span style="font-size:15px;font-weight:800;color:var(--text-1);">${planInfo.label}</span>
            <span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:4px;background:rgba(16,185,129,0.15);color:#4ade80;letter-spacing:.05em;">ACTIVE</span>
          </div>
          <div style="font-size:11px;color:var(--text-3);">${planInfo.desc}</div>
        </div>
        ${manageBtnHtml}
      </div>

      <div class="uset-section-title">Subscription Plans</div>
      <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:20px;">
        ${plansHtml}
      </div>

      ${activePromo && activePromo.type === 'discount' ? `
      <div style="background:rgba(251,191,36,0.07);border:1px solid rgba(251,191,36,0.3);border-radius:9px;padding:12px 16px;display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:16px;">
        <div style="display:flex;align-items:center;gap:10px;">
          <span style="font-size:18px;">🏷</span>
          <div>
            <div style="font-size:12px;font-weight:700;color:var(--warning);">${activePromo.label}</div>
            <div style="font-size:10px;color:var(--text-3);margin-top:2px;">Code <strong>${_safeActiveCode}</strong> active — discount applies at checkout</div>
          </div>
        </div>
        <button onclick="removePromoCode()" style="font-size:10px;padding:3px 8px;border-radius:5px;background:rgba(248,113,113,0.07);border:1px solid rgba(248,113,113,0.25);color:var(--danger);cursor:pointer;">Remove</button>
      </div>` : ''}

      <!-- Promo code entry -->
      <div class="uset-section-title">Promo Code</div>
      <div style="background:var(--surface-2);border:1px solid var(--border);border-radius:10px;padding:14px 16px;margin-bottom:16px;">
        ${activePromo ? `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;">
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="font-size:15px;">${activePromo.type === 'unlock' ? '🔓' : '🏷'}</span>
            <div>
              <div style="font-size:12px;font-weight:700;color:#4ade80;">${activePromo.label}</div>
              <div style="font-size:10px;color:var(--text-3);margin-top:1px;">Code: <strong style="color:var(--text-2);">${_safeActiveCode}</strong></div>
            </div>
          </div>
          <button onclick="removePromoCode()" style="font-size:10px;padding:4px 10px;border-radius:6px;background:rgba(248,113,113,0.07);border:1px solid rgba(248,113,113,0.25);color:var(--danger);cursor:pointer;white-space:nowrap;">✕ Remove</button>
        </div>` : `
        <div style="font-size:11px;color:var(--text-3);margin-bottom:10px;">Have a promo code? Enter it below to unlock features or apply a discount.</div>
        <div style="display:flex;gap:8px;">
          <input id="promoCodeInput" type="text" placeholder="e.g. MAXACCESS"
            style="flex:1;padding:8px 12px;background:var(--bg);border:1px solid var(--border-2);border-radius:7px;color:var(--text-1);font-size:12px;font-family:inherit;letter-spacing:0.5px;text-transform:uppercase;outline:none;"
            onkeydown="if(event.key==='Enter')submitPromoCode()">
          <button id="promoSubmitBtn" onclick="submitPromoCode()" style="padding:8px 16px;border-radius:7px;background:var(--grad-accent);border:none;color:#fff;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap;">Apply</button>
        </div>`}
      </div>

      <!-- ── Credits section ── -->
      <div class="uset-section-title" style="margin-top:4px;">Generation Credits</div>
      ${_renderCreditsSection()}

      <div style="background:var(--surface-2);border:1px solid var(--border);border-radius:9px;padding:12px 16px;display:flex;align-items:center;gap:10px;margin-top:16px;">
        <i class="ti ti-credit-card" style="color:var(--accent-2);font-size:18px;flex-shrink:0;"></i>
        <div style="font-size:11px;color:var(--text-3);line-height:1.6;">Billing is powered by Stripe. Your payment details are never stored on our servers. You can cancel or change your plan at any time from the Customer Portal.</div>
      </div>`;
  }

  // ── Credits section HTML (used inside renderBillingTab) ──────────────────
  function _renderCreditsSection() {
    const balance  = typeof window.userCredits === 'number' ? window.userCredits : 0;
    const tier     = window._stripeTier || 'free';
    const monthly  = { free: 50, starter: 1000, pro: 4000, agency: 5000 }[tier] || 50;
    const pct      = Math.min(100, Math.round((balance / monthly) * 100));
    const barColor = balance <= 50 ? '#f87171' : balance <= monthly * 0.25 ? '#fbbf24' : '#34d399';

    const TOPUP_PACKS = [
      { id: 'boost',    credits: 500,   price: '$5',  label: 'Boost' },
      { id: 'standard', credits: 2000,  price: '$18', label: 'Standard' },
      { id: 'pro_pack', credits: 5000,  price: '$40', label: 'Pro Pack' },
      { id: 'ultra',    credits: 10000, price: '$75', label: 'Ultra' },
    ];

    const packsHtml = TOPUP_PACKS.map(p => `
      <div onclick="purchaseCredits('${p.id}')" style="flex:1;min-width:80px;padding:10px 8px;background:var(--surface-3);border:1px solid var(--border-2);border-radius:9px;cursor:pointer;text-align:center;transition:border-color 0.15s;" onmouseover="this.style.borderColor='rgba(139,92,246,0.5)'" onmouseout="this.style.borderColor='var(--border-2)'">
        <div style="font-size:12px;font-weight:800;color:var(--text-1);">${p.credits >= 1000 ? (p.credits/1000)+'K' : p.credits}</div>
        <div style="font-size:9px;color:var(--text-3);margin:1px 0;">credits</div>
        <div style="font-size:11px;font-weight:700;color:var(--accent-2);">${p.price}</div>
        <div style="font-size:9px;color:var(--text-3);margin-top:2px;">${p.label}</div>
      </div>`).join('');

    return `
    <div style="background:var(--surface-2);border:1px solid var(--border-2);border-radius:12px;padding:16px 18px;margin-bottom:14px;">

      <!-- Balance row -->
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
        <div>
          <div style="font-size:11px;color:var(--text-3);margin-bottom:2px;text-transform:uppercase;letter-spacing:0.05em;font-weight:600;">Current Balance</div>
          <div style="font-size:22px;font-weight:800;color:var(--text-1);line-height:1;">${balance.toLocaleString()} <span style="font-size:12px;font-weight:500;color:var(--text-3);">credits</span></div>
        </div>
        <div style="text-align:right;">
          <div style="font-size:10px;color:var(--text-3);">Monthly included</div>
          <div style="font-size:13px;font-weight:700;color:var(--accent-2);">${monthly.toLocaleString()}</div>
        </div>
      </div>

      <!-- Progress bar -->
      <div style="height:5px;background:var(--surface-3);border-radius:3px;overflow:hidden;margin-bottom:6px;">
        <div style="height:100%;width:${pct}%;background:${barColor};border-radius:3px;transition:width 0.5s;"></div>
      </div>
      <div style="font-size:10px;color:var(--text-3);margin-bottom:14px;">${pct}% of monthly credits remaining · 1 video ≈ 200 credits</div>

      <!-- Generate mode toggle -->
      <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:var(--glass-2);border:1px solid var(--glass-border);border-radius:8px;margin-bottom:14px;">
        <div>
          <div style="font-size:11px;font-weight:700;color:var(--text-2);">Generate Mode</div>
          <div style="font-size:10px;color:var(--text-3);margin-top:2px;">How Veo clips are generated</div>
        </div>
        <div style="display:flex;gap:6px;">
          <button onclick="setGenerateMode('api')" id="genModeApiBtn"
            style="padding:5px 11px;font-size:10px;font-weight:700;border-radius:5px;cursor:pointer;font-family:inherit;transition:all 0.15s;
            ${(typeof getGenerateMode === 'function' ? getGenerateMode() : 'api') === 'api'
              ? 'background:rgba(52,211,153,0.2);border:1px solid rgba(52,211,153,0.6);color:#34d399;'
              : 'background:var(--surface-3);border:1px solid var(--border-2);color:var(--text-3);'}">
            ⚡ API
          </button>
          <button onclick="setGenerateMode('flow')" id="genModeFlowBtn"
            style="padding:5px 11px;font-size:10px;font-weight:700;border-radius:5px;cursor:pointer;font-family:inherit;transition:all 0.15s;
            ${(typeof getGenerateMode === 'function' ? getGenerateMode() : 'api') === 'flow'
              ? 'background:rgba(56,189,248,0.2);border:1px solid rgba(56,189,248,0.6);color:#38bdf8;'
              : 'background:var(--surface-3);border:1px solid var(--border-2);color:var(--text-3);'}">
            🌊 Flow
          </button>
        </div>
      </div>

      <!-- Top-up packs -->
      <div style="font-size:11px;font-weight:700;color:var(--text-2);margin-bottom:8px;">Top-Up Credits</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        ${packsHtml}
      </div>
    </div>`;
  }

  function openUpgradeModal(planKey) {
    const info        = PLAN_INFO[planKey] || { label: planKey, price: '', desc: '' };
    const paymentLink = STRIPE_PAYMENT_LINKS[planKey] || null;
    const existing    = document.getElementById('upgradeModal');
    if (existing) existing.remove();

    // Build checkout URL — pre-fill email + attach Supabase user ID for webhook matching
    let checkoutUrl = paymentLink;
    if (checkoutUrl) {
      const params = new URLSearchParams();
      const email = window._supabaseEmail || '';
      const uid   = window._supabaseUid  || '';
      if (email) params.set('prefilled_email', email);
      if (uid)   params.set('client_reference_id', uid);
      const qs = params.toString();
      if (qs) checkoutUrl += (checkoutUrl.includes('?') ? '&' : '?') + qs;
    }

    // Compute display price — apply discount promo if active
    const _promo = window._activePromo;
    let displayPrice = info.price;
    let promoLine = '';
    if (_promo && _promo.type === 'discount' && info.price) {
      const baseNum = parseFloat((info.price || '').replace(/[^0-9.]/g, ''));
      if (!isNaN(baseNum) && baseNum > 0) {
        const discounted = (baseNum * (1 - _promo.pct / 100)).toFixed(2);
        const period = info.price.includes('/mo') ? '/mo' : '';
        displayPrice = `$${discounted}${period}`;
        const _safeCode = String(_promo.code || '').replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c]));
        promoLine = `<div style="font-size:10px;color:var(--success,#4ade80);margin-top:4px;text-align:center;">${_promo.pct}% off applied · was <s style="opacity:0.6;">${info.price}</s> · code: ${_safeCode}</div>`;
      }
    }

    const checkoutHtml = checkoutUrl
      ? `<a href="${checkoutUrl}" target="_blank" rel="noopener"
           style="display:flex;align-items:center;justify-content:center;gap:8px;padding:13px;border-radius:10px;background:var(--grad-accent);color:#fff;font-size:13px;font-weight:800;text-decoration:none;letter-spacing:-0.2px;box-shadow:0 4px 20px rgba(124,106,247,0.35);">
           <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>
           Pay with Stripe — ${displayPrice}
         </a>
         ${promoLine}
         <div style="display:flex;align-items:center;justify-content:center;gap:5px;margin-top:8px;">
           <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
           <span style="font-size:10px;color:var(--text-3);">Secured by Stripe · Cancel anytime</span>
         </div>`
      : `<div style="background:var(--surface-2);border:1px solid var(--border);border-radius:10px;padding:12px 14px;display:flex;align-items:center;gap:10px;margin-bottom:12px;">
           <span style="font-size:18px;flex-shrink:0;">🚀</span>
           <div>
             <div style="font-size:11.5px;font-weight:700;color:var(--text-1);margin-bottom:2px;">Agency billing coming soon</div>
             <div style="font-size:10.5px;color:var(--text-3);">Contact us for early access to the Agency plan.</div>
           </div>
         </div>
         <a href="mailto:support@affiliateos.app?subject=Upgrade%20to%20Agency%20Plan" style="display:block;text-align:center;padding:10px;border-radius:8px;background:var(--surface-2);border:1px solid var(--border);color:var(--text-2);font-size:12px;font-weight:600;text-decoration:none;">📧 Contact us to upgrade</a>`;

    const modal = document.createElement('div');
    modal.id = 'upgradeModal';
    modal.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.72);backdrop-filter:blur(6px);padding:20px;';
    modal.innerHTML = `
      <div style="background:var(--surface);border:1px solid var(--border-2);border-radius:16px;padding:28px 28px 24px;width:100%;max-width:420px;box-shadow:0 24px 80px rgba(0,0,0,0.6),0 0 0 1px rgba(124,106,247,0.12);position:relative;">
        <button onclick="document.getElementById('upgradeModal').remove()" style="position:absolute;top:14px;right:14px;background:none;border:none;color:var(--text-3);font-size:18px;cursor:pointer;line-height:1;padding:2px 6px;border-radius:5px;">✕</button>

        <div style="display:flex;align-items:center;gap:10px;margin-bottom:18px;">
          <div style="width:38px;height:38px;border-radius:10px;background:var(--grad-accent);display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;">⚡</div>
          <div>
            <div style="font-size:15px;font-weight:800;color:var(--text-1);">Upgrade to ${info.label}</div>
            <div style="font-size:12px;color:var(--text-3);margin-top:1px;">${info.price} · ${info.desc}</div>
          </div>
        </div>

        <div style="margin-bottom:20px;">
          ${checkoutHtml}
        </div>

        <div style="border-top:1px solid var(--border);padding-top:16px;">
          <div style="font-size:11px;font-weight:700;color:var(--text-3);margin-bottom:10px;letter-spacing:0.04em;">🔓 HAVE A PROMO CODE? (skip payment)</div>
          <div style="display:flex;gap:8px;">
            <input id="upgradeModalPromoInput" type="text" placeholder="Enter promo code"
              style="flex:1;padding:9px 12px;background:var(--bg);border:1px solid var(--border-2);border-radius:7px;color:var(--text-1);font-size:12px;font-family:inherit;letter-spacing:0.5px;text-transform:uppercase;outline:none;"
              onkeydown="if(event.key==='Enter')_submitUpgradePromo()">
            <button id="upgradePromoApplyBtn" onclick="_submitUpgradePromo()" style="padding:9px 16px;border-radius:7px;background:var(--surface-2);border:1px solid var(--border);color:var(--text-2);font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;white-space:nowrap;">Apply</button>
          </div>
          <div id="upgradeModalPromoMsg" style="font-size:11px;margin-top:8px;display:none;"></div>
        </div>
      </div>`;

    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
    setTimeout(() => document.getElementById('upgradeModalPromoInput')?.focus(), 80);
  }

  window._submitUpgradePromo = async function _submitUpgradePromo() {
    const input = document.getElementById('upgradeModalPromoInput');
    const msg   = document.getElementById('upgradeModalPromoMsg');
    const applyBtn = document.getElementById('upgradePromoApplyBtn');
    if (!input) return;
    const code = input.value.trim().toUpperCase();
    if (!code) { if (msg) { msg.style.display='block'; msg.style.color='var(--warning)'; msg.textContent='Please enter a promo code.'; } return; }

    // 1. Check client-side discount codes first (these are public price discounts — safe to store client-side)
    const discountDef = PROMO_CODES[code];
    if (discountDef) {
      const promoData = { code, ...discountDef };
      try { localStorage.setItem(PROMO_STORAGE_KEY, JSON.stringify(promoData)); } catch {}
      window._activePromo = promoData;
      document.getElementById('upgradeModal')?.remove();
      showToast('🎉 ' + discountDef.label + ' — activated!', 'success', 4000);
      renderBillingTab();
      return;
    }

    // 2. Fall through to server for unlock codes (MAXACCESS, VIPBETA, EARLYBIRD etc.)
    //    Unlock codes live server-side only — we never store them in client code.
    if (msg) { msg.style.display='block'; msg.style.color='var(--text-3)'; msg.textContent='Validating…'; }
    if (applyBtn) { applyBtn.disabled = true; applyBtn.textContent = '⏳'; }
    try {
      const res = await fetch('/.netlify/functions/validate-promo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      if (!res.ok) {
        if (msg) { msg.style.display='block'; msg.style.color='var(--danger)'; msg.textContent='Server error — please try again.'; }
        if (applyBtn) { applyBtn.disabled = false; applyBtn.textContent = 'Apply'; }
        return;
      }
      const data = await res.json().catch(() => ({ valid: false }));
      if (data.valid && data.type === 'unlock') {
        const promoData = { code, type: 'unlock', tier: data.tier, label: data.label };
        try { localStorage.setItem(PROMO_STORAGE_KEY, JSON.stringify(promoData)); } catch {}
        window._activePromo    = promoData;
        window._stripeTier     = data.tier;
        window._stripeBaseTier = data.tier; // keep base in sync so removePromoCode() restores correctly
        applyPromoOverride();
        document.getElementById('upgradeModal')?.remove();
        showToast('🎉 ' + data.label + ' — activated!', 'success', 4000);
        renderBillingTab();
      } else {
        if (msg) { msg.style.display='block'; msg.style.color='var(--danger)'; msg.textContent='Invalid promo code. Please try again.'; }
        if (applyBtn) { applyBtn.disabled = false; applyBtn.textContent = 'Apply'; }
      }
    } catch(err) {
      if (msg) { msg.style.display='block'; msg.style.color='var(--danger)'; msg.textContent='Network error — please try again.'; }
      if (applyBtn) { applyBtn.disabled = false; applyBtn.textContent = 'Apply'; }
    }
  }

  async function startCheckout(planKey) {
    // Legacy — kept for when Stripe functions are deployed
    const priceId = STRIPE_PRICES[planKey];
    if (!priceId || priceId.includes('_HERE')) {
      openUpgradeModal(planKey);
      return;
    }
    if (!_sb) { showToast('Please sign in first.', 'warning'); return; }
    const { data: { session } } = await _sb.auth.getSession().catch(() => ({ data: { session: null } }));
    if (!session) { showToast('Please sign in first.', 'warning'); return; }
    try {
      const res  = await fetch('/.netlify/functions/create-checkout-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priceId, userId: session.user.id, email: session.user.email }),
      });
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      const data = await res.json();
      if (data.url) { window.location.href = data.url; }
      else { showToast('Checkout error: ' + (data.error || 'Unknown error'), 'error', 5000); }
    } catch (err) {
      showToast('Network error: ' + err.message, 'error');
    }
  }

  function openBillingPortal() {
    const existing = document.getElementById('billingPortalModal');
    if (existing) existing.remove();
    const tier = window._stripeTier || 'free';
    const planInfo = PLAN_INFO[tier] || PLAN_INFO.free;

    const modal = document.createElement('div');
    modal.id = 'billingPortalModal';
    modal.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.72);backdrop-filter:blur(6px);padding:20px;';
    modal.innerHTML = `
      <div style="background:var(--surface);border:1px solid var(--border-2);border-radius:16px;padding:28px 28px 24px;width:100%;max-width:420px;box-shadow:0 24px 80px rgba(0,0,0,0.6),0 0 0 1px rgba(124,106,247,0.12);position:relative;">
        <button onclick="document.getElementById('billingPortalModal').remove()" style="position:absolute;top:14px;right:14px;background:none;border:none;color:var(--text-3);font-size:18px;cursor:pointer;line-height:1;padding:2px 6px;border-radius:5px;">✕</button>

        <div style="display:flex;align-items:center;gap:10px;margin-bottom:20px;">
          <div style="width:38px;height:38px;border-radius:10px;background:var(--grad-accent);display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;">💳</div>
          <div>
            <div style="font-size:15px;font-weight:800;color:var(--text-1);">Manage Subscription</div>
            <div style="font-size:12px;color:var(--text-3);margin-top:1px;">Current plan: ${planInfo.label} — ${planInfo.price}</div>
          </div>
        </div>

        <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:20px;">
          <div style="background:var(--surface-2);border:1px solid var(--border);border-radius:10px;padding:14px 16px;">
            <div style="font-size:12px;font-weight:700;color:var(--text-1);margin-bottom:4px;">Change or upgrade plan</div>
            <div style="font-size:11px;color:var(--text-3);line-height:1.6;">Select a plan from the Subscription Plans list below. Paid billing via Stripe is coming — for now, use a promo code or contact us.</div>
          </div>
          <div style="background:var(--surface-2);border:1px solid var(--border);border-radius:10px;padding:14px 16px;">
            <div style="font-size:12px;font-weight:700;color:var(--text-1);margin-bottom:4px;">Cancel subscription</div>
            <div style="font-size:11px;color:var(--text-3);line-height:1.6;">To cancel, email <a href="mailto:support@aiscaling.io" style="color:var(--accent-2);">support@aiscaling.io</a> — we process cancellations within 24 hours.</div>
          </div>
        </div>

        <button onclick="document.getElementById('billingPortalModal').remove()" style="width:100%;padding:10px;border-radius:9px;background:none;border:1px solid var(--border-2);color:var(--text-3);font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;">Close</button>
      </div>`;

    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  }

  // ── Credit chip: updates the topbar balance display ──────────────────────
  function updateCreditChip(balance) {
    const chip = document.getElementById('creditChip');
    const val  = document.getElementById('creditChipValue');
    if (!chip || !val) return;
    const n = typeof balance === 'number' ? balance : (window.userCredits || 0);
    val.textContent = n.toLocaleString();
    chip.style.borderColor = n <= 30 ? 'rgba(248,113,113,0.6)' : 'rgba(139,92,246,0.35)';
    chip.style.color       = n <= 30 ? '#f87171' : 'var(--accent-2)';
  }
  window.updateCreditChip = updateCreditChip;

  // ── Purchase credits: routes through create-topup-session ─────────────────
  async function purchaseCredits(packId) {
    if (!_sb) { showToast('Please sign in first.', 'warning'); return; }
    const { data } = await _sb.auth.getSession().catch(() => ({ data: { session: null } }));
    if (!data?.session) { showToast('Please sign in first.', 'warning'); return; }

    const btn = document.querySelector(`[onclick="purchaseCredits('${packId}')"]`);
    if (btn) { btn.style.opacity = '0.5'; btn.style.pointerEvents = 'none'; }

    try {
      const res = await fetch('/.netlify/functions/create-topup-session', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + data.session.access_token },
        body:    JSON.stringify({ packId }),
      });
      const result = await res.json();
      if (!res.ok || !result.checkoutUrl) throw new Error(result.error || 'Could not create checkout session.');
      window.location.href = result.checkoutUrl;
    } catch(e) {
      if (btn) { btn.style.opacity = ''; btn.style.pointerEvents = ''; }
      showToast('Top-up error: ' + e.message, 'error', 5000);
    }
  }
  window.purchaseCredits = purchaseCredits;

  // ── Open top-up modal (called when credits run out during generation) ────
  function openTopupModal() {
    const existing = document.getElementById('topupModal');
    if (existing) existing.remove();

    const PACKS = [
      { id: 'boost',    credits: 500,   price: '$5',  label: 'Boost',    desc: '~2.5 videos' },
      { id: 'standard', credits: 2000,  price: '$18', label: 'Standard', desc: '~10 videos'  },
      { id: 'pro_pack', credits: 5000,  price: '$40', label: 'Pro Pack', desc: '~25 videos'  },
      { id: 'ultra',    credits: 10000, price: '$75', label: 'Ultra',    desc: '~50 videos'  },
    ];

    const modal = document.createElement('div');
    modal.id = 'topupModal';
    modal.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.8);backdrop-filter:blur(8px);padding:16px;';
    modal.innerHTML = `
      <div style="background:var(--surface);border:1px solid rgba(139,92,246,0.4);border-radius:16px;padding:26px;width:100%;max-width:400px;box-shadow:0 24px 80px rgba(0,0,0,0.7);position:relative;font-family:inherit;">
        <button onclick="document.getElementById('topupModal').remove()" style="position:absolute;top:13px;right:13px;background:none;border:none;color:var(--text-3);font-size:18px;cursor:pointer;padding:2px 6px;border-radius:4px;">✕</button>
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
          <div style="width:36px;height:36px;border-radius:9px;background:rgba(139,92,246,0.15);border:1px solid rgba(139,92,246,0.35);display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;">⚡</div>
          <div>
            <div style="font-size:14px;font-weight:800;color:var(--text-1);">Top Up Credits</div>
            <div style="font-size:11px;color:var(--text-3);">Current balance: <strong style="color:var(--accent-2);">${(window.userCredits || 0).toLocaleString()}</strong></div>
          </div>
        </div>
        <div style="font-size:11px;color:#f87171;background:rgba(248,113,113,0.08);border:1px solid rgba(248,113,113,0.2);border-radius:7px;padding:8px 12px;margin:12px 0 16px;">
          Not enough credits to generate. Top up to continue.
        </div>
        <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:16px;">
          ${PACKS.map(p => `
          <div onclick="document.getElementById('topupModal').remove();purchaseCredits('${p.id}')"
               style="display:flex;align-items:center;justify-content:space-between;padding:12px 14px;background:var(--surface-2);border:1px solid var(--border-2);border-radius:9px;cursor:pointer;transition:border-color 0.15s;"
               onmouseover="this.style.borderColor='rgba(139,92,246,0.5)'" onmouseout="this.style.borderColor='var(--border-2)'">
            <div>
              <div style="font-size:13px;font-weight:700;color:var(--text-1);">${p.label} — ${p.credits.toLocaleString()} credits</div>
              <div style="font-size:10px;color:var(--text-3);">${p.desc} · 1 credit = $0.01</div>
            </div>
            <div style="font-size:15px;font-weight:800;color:var(--accent-2);flex-shrink:0;">${p.price}</div>
          </div>`).join('')}
        </div>
        <button onclick="document.getElementById('topupModal').remove()" style="width:100%;padding:9px;background:none;border:1px solid var(--border-2);border-radius:8px;color:var(--text-3);font-size:11px;font-weight:600;cursor:pointer;font-family:inherit;">Cancel</button>
      </div>`;

    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  }
  window.openTopupModal = openTopupModal;
  window.applyPromoOverride = applyPromoOverride;
  window.clearReminderTimer = clearReminderTimer;

  // ── Handle post-topup redirect (?credits_added=1) ─────────────────────────
  (function checkTopupRedirect() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('credits_added') === '1') {
      history.replaceState({}, '', '/app');
      setTimeout(async () => {
        if (typeof _sb !== 'undefined' && _sb) {
          const res = await _sb.auth.refreshSession().catch(() => null);
          const newBalance = res?.data?.session?.user?.app_metadata?.credits_balance;
          if (typeof newBalance === 'number') {
            window.userCredits = newBalance;
            if (typeof updateCreditChip === 'function') updateCreditChip(newBalance);
          }
        }
        showToast('Credits added to your account!', 'success', 5000);
        if (typeof openUserSettings === 'function') openUserSettings('billing');
      }, 600);
    }
  })();

  function updateClaudeBrowserDisplay() {
    const cbEl = document.getElementById('uset-claudeBrowser');
    if (!cbEl) return;
    const on = cbEl.checked;
    const badge = document.getElementById('uset-modeBadge');
    const desc = document.getElementById('uset-modeDesc');
    if (badge) { badge.textContent = on ? 'ON — Automated' : 'OFF — Manual';
    badge.className = 'uset-mode-badge ' + (on ? 'auto' : 'manual'); }
    if (desc) desc.textContent = on
      ? 'Claude in Chrome handles everything — file uploads, prompt pasting, generation, and downloading.'
      : 'You paste each prompt into Flow manually. Claude just formats and copies them for you.';
  }

  function saveUserSettingsTab() {
    const s = getUserSettings();
    if (!s) return;
    const _dlSave = document.getElementById('uset-dlPath');
    s.dlPath = _dlSave ? _dlSave.value.trim() : (s.dlPath || '');
    const _cbSave = document.getElementById('uset-claudeBrowser');
    s.claudeBrowserMode = _cbSave ? _cbSave.checked : s.claudeBrowserMode !== false;
    saveUserSettings(s);
    _showUsetSaved();
  }

  // =========================================================
  // WELCOME TOUR
  // =========================================================

  function openWelcomeTour() {
    const ov = document.getElementById('welcomeTourOverlay');
    if (ov) ov.classList.add('open');
  }

  function closeWelcomeTour() {
    const ov = document.getElementById('welcomeTourOverlay');
    if (ov) ov.classList.remove('open');
  }

  // =========================================================
  // ONBOARDING CARD HANDLERS
  // =========================================================

  function onboardStepClick(id, tab) {
    if (tab) switchTab(tab);
    let m = {}; try { m = JSON.parse(localStorage.getItem('onboardingSteps') || '{}'); } catch(e) {}
    m[id] = true;
    try { localStorage.setItem('onboardingSteps', JSON.stringify(m)); } catch(e) {}
    renderDashboard();
  }

  function onboardToggleCollapse() {
    const cur = localStorage.getItem('onboardingCollapsed') === '1';
    try { localStorage.setItem('onboardingCollapsed', cur ? '0' : '1'); } catch(e) {}
    renderDashboard();
  }
