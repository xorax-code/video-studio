  // ===== AUTH SYSTEM =====
  // ── SUPABASE CLIENT ──────────────────────────────────────────
  let _pendingSignupName = ''; // bridge display name from doSignup → onAuthSuccess
  const _sb = (() => {
    try { return supabase.createClient(SUPABASE_URL, SUPABASE_ANON); }
    catch(e) { console.warn('Supabase not configured yet:', e.message); return null; }
  })();

  // Legacy session helpers (kept for DB.setUser compatibility)
  function clearSession() { localStorage.removeItem('socialos_session'); }
  function getSession()   { return null; } // always use Supabase now
  function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
  }

  function toggleAuthPass(inputId, btn) {
    const input = document.getElementById(inputId);
    if (!input) return;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.textContent = show ? '🙈' : '👁';
    btn.style.color = show ? 'var(--accent)' : '';
  }

  function showAuthError(msg) {
    const el = document.getElementById('authError');
    if (el) { el.textContent = msg; el.style.display = 'block'; }
  }
  function hideAuthError() {
    const el = document.getElementById('authError');
    if (el) el.style.display = 'none';
  }

  function switchAuthTab(tab) {
    document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
    const tabEl = document.getElementById('authTab_' + tab);
    if (tabEl) tabEl.classList.add('active');
    const loginForm  = document.getElementById('authFormLogin');
    const signupForm = document.getElementById('authFormSignup');
    if (loginForm)  loginForm.style.display  = tab === 'login'  ? 'flex' : 'none';
    if (signupForm) signupForm.style.display = tab === 'signup' ? 'flex' : 'none';
    const fl = document.getElementById('authFooterLogin');
    const fs = document.getElementById('authFooterSignup');
    if (fl) fl.style.display = tab === 'login' ? '' : 'none';
    if (fs) fs.style.display = tab === 'signup' ? '' : 'none';
    hideAuthError();
  }

  async function doLogin(e) {
    e && e.preventDefault();
    hideAuthError();
    if (!_sb) { showAuthError('Supabase not configured. Add your keys to supabase-config.js.'); return; }
    const _liEl = document.getElementById('loginIdentifier');
    const _lpEl = document.getElementById('loginPassword');
    const email    = _liEl ? _liEl.value.trim() : '';
    const password = _lpEl ? _lpEl.value : '';
    if (!email || !password) { showAuthError('Please fill in all fields.'); return; }
    let data, error;
    try {
      ({ data, error } = await _sb.auth.signInWithPassword({ email, password }));
    } catch(e) { showAuthError('Network error — please check your connection and try again.'); return; }
    if (error) { showAuthError(error.message); return; }
    if (!data.user) { showAuthError('Login succeeded but no user returned. Please try again.'); return; }
    onAuthSuccess(data.user.email, data.user.id);
  }

  async function doSignup(e) {
    e && e.preventDefault();
    hideAuthError();
    if (!_sb) { showAuthError('Supabase not configured. Add your keys to supabase-config.js.'); return; }
    const username  = (document.getElementById('signupUsername')?.value || '').trim();
    const email     = (document.getElementById('signupEmail')?.value    || '').trim().toLowerCase();
    const password  = (document.getElementById('signupPassword')?.value || '');
    const confirm   = (document.getElementById('signupConfirm')?.value  || '');
    if (!email || !password) { showAuthError('Please fill in all fields.'); return; }
    if (password.length < 8) { showAuthError('Password must be at least 8 characters.'); return; }
    if (password !== confirm) { showAuthError('Passwords do not match.'); return; }
    let error;
    try {
      ({ error } = await _sb.auth.signUp({ email, password }));
    } catch(e) { showAuthError('Network error — please check your connection and try again.'); return; }
    if (error) { showAuthError(error.message); return; }
    // Stash the display name; it will be saved in onAuthSuccess after DB.setUser scopes the key
    if (username) _pendingSignupName = username;
    showAuthError('✓ Account created! Check your email to confirm, then sign in.');
    // After email confirmation the SIGNED_IN event fires and calls onAuthSuccess automatically
  }

  function onAuthSuccess(username, userId) {
    // Scope all DB reads/writes to this user
    if (userId) DB.setUser(userId);
    // If signup just set a pending display name, persist it now that the DB key is scoped
    if (_pendingSignupName) {
      const _ps = getUserSettings() || {};
      _ps.displayName = _pendingSignupName;
      saveUserSettings(_ps);
      updateUserChip(_pendingSignupName);
      _pendingSignupName = '';
    }
    // Track first-login date for trial countdown (covers login paths not through checkAuthAndBoot)
    if (!localStorage.getItem('aff_os_first_login')) {
      localStorage.setItem('aff_os_first_login', String(Date.now()));
    }
    // Hide auth wall
    const wall = document.getElementById('authWall');
    if (wall) wall.classList.remove('visible');
    // Update topnav user chip -- prefer saved display name over raw email
    const _onAuthS = getUserSettings() || {};
    updateUserChip(_onAuthS.displayName || username);
    // Boot the app — chain first-login tour inside .then() so data is loaded before rendering
    const isFirstLogin = !localStorage.getItem('hasLoggedInBefore');
    if (isFirstLogin) localStorage.setItem('hasLoggedInBefore', '1');
    initApp().then(() => {
      if (isFirstLogin) {
        switchTab('dashboard');
        setTimeout(() => openWelcomeTour(), 600);
      }
    }).catch(e => console.error('initApp failed (onAuthSuccess):', e));
  }

  function updateUserChip(emailOrName) {
    const chip    = document.getElementById('authUserChip');
    const initial = document.getElementById('authUserInitial');
    const nameEl  = document.getElementById('authUserName');
    // Show just the part before @ for emails, or the full display name
    const raw = (emailOrName || '').trim();
    const display = raw.includes('@') ? raw.split('@')[0] : raw;
    const safe = display || '?';
    if (chip) chip.style.display = 'flex';
    if (nameEl) nameEl.textContent = safe !== '?' ? safe : '';
    // Show profile photo if the user has uploaded one, otherwise show initial letter
    if (initial) {
      const avatarUrl = getUserSettings()?.avatarDataUrl;
      if (avatarUrl) {
        const _img = document.createElement('img');
        _img.src = avatarUrl;
        _img.alt = 'Profile';
        _img.onerror = function() {
          if (!this.parentElement) return;
          this.parentElement.textContent = ([...safe][0] || '?').toUpperCase();
          this.parentElement.style.background = '';
        };
        initial.innerHTML = '';
        initial.appendChild(_img);
        initial.style.background = 'transparent';
      } else {
        initial.textContent = ([...safe][0] || '?').toUpperCase();
        initial.style.background = '';
      }
    }
  }

  // ===== HIDDEN ADMIN KEY PANEL =====
  // SHA-256 hash of the admin password.
  // To change: run SHA-256 hash of your new password in the browser console and update this value.
  const ADMIN_PASSWORD_HASH = '9f2076bc7b2301578527698143e4551eb9099e94fdcddfd65e958687bad1d924';

  let _logoClickCount = 0, _logoClickTimer = null;
  function onLogoClick() {
    _logoClickCount++;
    clearTimeout(_logoClickTimer);
    _logoClickTimer = setTimeout(() => { _logoClickCount = 0; }, 1500);
    if (_logoClickCount >= 5) {
      _logoClickCount = 0;
      openAdminKeyModal();
      return false; // Block navigation -- open Easter egg instead
    }
    return true; // Allow normal navigation to landing page
  }
  function openAdminKeyModal() {
    const modal = document.getElementById('adminKeyModal');
    if (!modal) return;
    modal.style.display = 'flex';
    // Always start at the password gate
    const gateScreen = document.getElementById('adminGateScreen');
    const keyScreen  = document.getElementById('adminKeyScreen');
    const gateError  = document.getElementById('adminGateError');
    const gateInput  = document.getElementById('adminGateInput');
    if (gateScreen) gateScreen.style.display = 'block';
    if (keyScreen)  keyScreen.style.display  = 'none';
    if (gateError)  gateError.style.display  = 'none';
    if (gateInput)  { gateInput.value = ''; gateInput.focus(); }
  }
  async function checkAdminPassword() {
    const gateInput = document.getElementById('adminGateInput');
    if (!gateInput) return;
    const entered = (gateInput.value || '').trim();
    let hash;
    try {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(entered));
      hash = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    }
    catch(e) { console.error('hashPassword failed:', e); return; }
    if (hash === ADMIN_PASSWORD_HASH) {
      const gateScreen = document.getElementById('adminGateScreen');
      const keyScreen  = document.getElementById('adminKeyScreen');
      const keyStatus  = document.getElementById('adminKeyStatus');
      const keyInput   = document.getElementById('adminKeyInput');
      if (gateScreen) gateScreen.style.display = 'none';
      if (keyScreen)  keyScreen.style.display  = 'block';
      if (keyStatus)  keyStatus.style.display  = 'none';
      if (keyInput) { if (_adminApiKey) keyInput.value = _adminApiKey; keyInput.focus(); }
    } else {
      const err = document.getElementById('adminGateError');
      if (err) { err.style.display = 'block'; setTimeout(() => { err.style.display = 'none'; }, 2500); }
      gateInput.value = '';
      gateInput.focus();
    }
  }
  function closeAdminKeyModal() {
    const m = document.getElementById('adminKeyModal'); if (m) m.style.display = 'none';
    const gi = document.getElementById('adminGateInput'); if (gi) gi.value = '';
    const ge = document.getElementById('adminGateError'); if (ge) ge.style.display = 'none';
    const ks = document.getElementById('adminKeyStatus'); if (ks) ks.style.display = 'none';
  }
  async function saveAdminKey() {
    const _aki = document.getElementById('adminKeyInput');
    const key = _aki ? _aki.value.trim() : '';
    if (!key) return;
    try {
      await DB.set('admin_openai_key', key, true); // unscoped -- shared for all users
      _adminApiKey = key;
    } catch(e) { showToast('Failed to save API key -- please try again.', 'error'); return; }
    const _aks = document.getElementById('adminKeyStatus');
    if (_aks) _aks.style.display = 'block';
    setTimeout(() => closeAdminKeyModal(), 2000);
  }

  async function doLogout() {
    // Cancel notification timer so it doesn't fire for the wrong user after redirect
    if (typeof clearReminderTimer === 'function') clearReminderTimer();
    try { if (_sb) await _sb.auth.signOut(); } catch(e) { console.warn('signOut error:', e); }
    clearSession();
    window.location.href = '/login.html';
  }
  // Expose globally so inline onclick handlers (e.g. trial-expired wall) can call it
  window.doLogout = doLogout;

  async function changePassword() {
    const newPass    = (document.getElementById('secNewPassword')?.value    || '');
    const confirmPass = (document.getElementById('secConfirmPassword')?.value || '');
    const msgEl = document.getElementById('securityMsg');
    function showMsg(text, ok) {
      if (!msgEl) return;
      msgEl.textContent = text;
      msgEl.style.display = 'block';
      msgEl.style.background = ok ? 'rgba(52,211,153,0.12)' : 'rgba(239,68,68,0.12)';
      msgEl.style.color = ok ? '#34d399' : '#ef4444';
      msgEl.style.border = ok ? '1px solid rgba(52,211,153,0.3)' : '1px solid rgba(239,68,68,0.3)';
    }
    if (!newPass)                      return showMsg('Please enter a new password.', false);
    if (newPass.length < 8)            return showMsg('Password must be at least 8 characters.', false);
    if (newPass !== confirmPass)        return showMsg('Passwords do not match.', false);
    if (!_sb)                          return showMsg('Not connected to auth service.', false);
    let error;
    try {
      ({ error } = await _sb.auth.updateUser({ password: newPass }));
    } catch(e) { return showMsg('Network error — could not update password. Please try again.', false); }
    if (error) return showMsg(error.message, false);
    showMsg('✓ Password updated successfully.', true);
    const _snpEl = document.getElementById('secNewPassword');
    const _scpEl = document.getElementById('secConfirmPassword');
    if (_snpEl) _snpEl.value = '';
    if (_scpEl) _scpEl.value = '';
  }
  window.changePassword = changePassword;

  async function checkAuthAndBoot() {
    // ── Local file bypass: skip auth when opened via file:// ──
    if (window.location.protocol === 'file:') {
      const _wall = document.getElementById('authWall');
      if (_wall) _wall.classList.remove('visible');
      window._stripeTier    = 'agency';
      window._stripeBaseTier = 'agency';
      window.userCredits    = 9999;
      updateUserChip('Local Preview');
      initApp().catch(e => console.error('initApp failed (file bypass):', e));
      return;
    }
    // ── Dev domain bypass: full access for testing on dev--aiscaling.netlify.app ──
    // Gated behind a PIN so the public dev URL doesn't hand strangers free agency access.
    // Unlock once by visiting dev--aiscaling.netlify.app/?dev=5852 (remembered in localStorage).
    // Still restores a real Supabase session so server-side functions receive a valid JWT.
    var _devUnlock = false;
    try {
      var _DEV_PIN  = '5852';
      var _devParam = new URLSearchParams(window.location.search).get('dev');
      if (_devParam === _DEV_PIN) { try { localStorage.setItem('aff_dev_unlock', _DEV_PIN); } catch(_) {} }
      _devUnlock = (localStorage.getItem('aff_dev_unlock') === _DEV_PIN);
    } catch(_) {}
    if (window.location.hostname === 'dev--aiscaling.netlify.app' && _devUnlock) {
      window._stripeTier    = 'agency';
      window._stripeBaseTier = 'agency';
      window.userCredits    = 9999; // unlimited credits for dev testing
      // Restore any cached session so /.netlify/functions/* get a valid Bearer token
      if (_sb) {
        try {
          const { data: _devSess } = await _sb.auth.getSession();
          if (_devSess?.session) {
            DB.setUser(_devSess.session.user.id);
            updateUserChip(_devSess.session.user.email || 'Dev Preview');
          } else {
            // No cached session — redirect to login so the user gets a real JWT
            window.location.href = '/login.html';
            return;
          }
        } catch(e) {
          updateUserChip('Dev Preview');
        }
      } else {
        updateUserChip('Dev Preview');
      }
      initApp().catch(e => console.error('initApp failed (dev bypass):', e));
      return;
    }
    if (!_sb) {
      // Supabase not yet configured -- show the auth wall so user can still access
      console.warn('Supabase not configured. Running without cloud auth.');
      const wall = document.getElementById('authWall');
      if (wall) wall.classList.add('visible');
      return;
    }
    let session;
    try {
      const { data } = await _sb.auth.getSession();
      session = data?.session;
    } catch (err) {
      console.error('Auth boot error:', err);
      showToast('Could not reach authentication service -- please refresh.', 'error');
      return;
    }
    if (session) {
      DB.setUser(session.user.id);
      // Read Stripe tier and credits from app_metadata (written by webhook)
      window._stripeCustomerId = session.user.app_metadata?.stripe_customer_id || null;
      window._stripeTier       = session.user.app_metadata?.stripe_tier || 'free';
      window._stripeBaseTier   = window._stripeTier; // keep original for promo removal
      window._supabaseEmail    = session.user.email || '';
      window._supabaseUid      = session.user.id   || '';
      // Credit balance from app_metadata — default 50 for free/new users, plan amount for paid
      const _savedCredits = session.user.app_metadata?.credits_balance;
      const _defaultCredits = { free: 50, starter: 1000, pro: 4000, agency: 5000 }[window._stripeTier] || 50;
      window.userCredits = (typeof _savedCredits === 'number') ? _savedCredits : _defaultCredits;
      applyPromoOverride();
      // Prefer display name from settings, fall back to email
      const _s = getUserSettings() || {};
      updateUserChip(_s.displayName || session.user.email);
      // Track first-login date for trial countdown (3-day free trial)
      if (!localStorage.getItem('aff_os_first_login')) {
        localStorage.setItem('aff_os_first_login', String(Date.now()));
      }
      // Listen for sign-out events (e.g. token expiry)
      // Unsubscribe any prior subscription first so re-init doesn't fire initApp twice
      if (window._authStateSub) {
        try { window._authStateSub.unsubscribe(); } catch (_) {}
        window._authStateSub = null;
      }
      let _authSub;
      try {
        const { data } = _sb.auth.onAuthStateChange((event, newSession) => {
          if (event === 'SIGNED_OUT' && window.location.protocol !== 'file:') {
            window.location.href = '/login.html';
          }
          if (event === 'USER_UPDATED' && newSession) {
            window._stripeCustomerId = newSession.user.app_metadata?.stripe_customer_id || null;
            window._stripeTier       = newSession.user.app_metadata?.stripe_tier || 'free';
            window._stripeBaseTier   = window._stripeTier; // keep base in sync so promo removal calculates correctly
            // Sync credit balance on any user update (e.g. after top-up webhook lands)
            var _updatedCredits = newSession.user.app_metadata?.credits_balance;
            if (typeof _updatedCredits === 'number') {
              window.userCredits = _updatedCredits;
              if (typeof updateCreditChip === 'function') updateCreditChip(_updatedCredits);
            }
            if (typeof applyPromoOverride === 'function') applyPromoOverride();
            // If the user just paid (tier is now paid), dismiss the trial wall if visible
            if (window._stripeTier !== 'free') document.getElementById('trialExpiredWall')?.remove();
          }
        });
        _authSub = data?.subscription;
      } catch(e) { console.warn('onAuthStateChange setup failed:', e); }
      window._authStateSub = _authSub;
      initApp().catch(e => console.error('initApp failed (checkAuthAndBoot):', e));

      // Handle post-checkout redirect -- skip trial wall since user just paid
      if (new URLSearchParams(window.location.search).get('upgraded') === '1') {
        history.replaceState({}, '', '/app');
        setTimeout(() => showToast('Your plan is now active -- welcome to Affiliate OS!', 'success', 5000), 800);
        return; // don't check trial expiry; webhook may not have landed yet
      }

      // After app boots, check if trial expired and no paid plan -- show paywall
      if (window._stripeTier === 'free') {
        setTimeout(() => {
          const trial = (typeof window.getTrialStatus === 'function') ? window.getTrialStatus() : null;
          if (trial && trial.expired) {
            if (typeof window.showTrialExpiredWall === 'function') window.showTrialExpiredWall();
          }
        }, 400);
      }

      return;
    }
    // No session -- redirect to dedicated login page
    window.location.href = '/login.html';
  }

  checkAuthAndBoot();
