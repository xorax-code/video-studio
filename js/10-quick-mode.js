  // ===== ASYNC INIT =====
  async function initApp() {
    // Guard against double-boot (onAuthStateChange can fire twice on initial load)
    if (window._appBooted) return;
    window._appBooted = true;
    // Migrate any old localStorage data first
    await DB.migrateLocalStorage();

    // Load all data from IndexedDB — wrap each parse so one corrupt value can't blank the whole app
    try {
      accounts      = _safeJSON(await DB.get('sm_accounts'),       []);
      competitors   = _safeJSON(await DB.get('sm_competitors'),    []);
      viralScripts  = _safeJSON(await DB.get('sm_viral_scripts'),  []);
      // Studio library is mode-specific — loaded properly when studio opens
      studioLibrary = [];
      videoLog      = _safeJSON(await DB.get('sm_video_log'),      []);
      postPlans     = _safeJSON(await DB.get('sm_post_plans'),      []);
      dailyItems    = _safeJSON(await DB.get('sm_daily_items'),     []);
      // sm_weekly_content_types was replaced by the merged postPlans system — no load needed
      _cachedApiKey = await DB.get('sm_openai_key') || '';
      // Load the shared admin key (not user-scoped — same for all users on this device)
      _adminApiKey  = await DB.get('admin_openai_key', true) || '';
    } catch(e) {
      console.error('initApp: DB load failed:', e);
      showToast('Failed to load data — please refresh.', 'error');
      accounts     = accounts     || [];
      videoLog     = videoLog     || [];
      postPlans    = postPlans    || [];
      dailyItems   = dailyItems   || [];
      competitors  = competitors  || [];
      viralScripts = viralScripts || [];
      _cachedApiKey = _cachedApiKey || '';
      _adminApiKey  = _adminApiKey  || '';
    }

    // Render
    renderTable();
    await loadSegments();

    // Load feature panel data — await all so data is ready before the tab renders
    await Promise.all([
      loadHooks(), loadCTALibrary(), loadIdeas(), loadProducts(), loadPerformanceLogs(), loadRecycleItems(),
    ].map(p => p.catch(e => console.warn('Feature panel load error:', e))));

    // Restore the last active tab (default to dashboard on first open)
    const savedTab = localStorage.getItem('sm_active_tab') || 'dashboard';
    switchTab(savedTab);

    // Initialise credit chip with the balance loaded during auth boot
    if (typeof updateCreditChip === 'function') updateCreditChip(window.userCredits || 0);
    // Initialise generate mode badge in settings if already rendered
    if (typeof updateGenerateModeBadge === 'function') updateGenerateModeBadge();

    // Hide "How it works" banner if user already dismissed it
    if (localStorage.getItem('vs_hiw_dismissed')) {
      const hiw = document.getElementById('vsHowItWorks');
      if (hiw) hiw.style.display = 'none';
    }

    // Warn before closing tab if there's unsaved segment work in progress
    if (!window._beforeUnloadRegistered) {
      window._beforeUnloadRegistered = true;
      window.addEventListener('beforeunload', e => {
        // Flush any pending debounced saves immediately so data isn't lost
        if (window._segSaveTimer) {
          clearTimeout(window._segSaveTimer);
          window._segSaveTimer = null;
          saveSegments();
        }
        if (typeof _masterScriptSaveTimer !== 'undefined' && _masterScriptSaveTimer) {
          clearTimeout(_masterScriptSaveTimer);
          _masterScriptSaveTimer = null;
          saveSegments();
        }
        if (segments && segments.length > 0 && segments.some(s => s.veoPrompt || s.nbPrompt || s.script)) {
          e.preventDefault();
          e.returnValue = '';
        }
      });
    }
  }

  // ===== THEME TOGGLE =====
  function applyTheme(theme) {
    theme = 'dark'; // light mode removed — always dark
    document.documentElement.setAttribute('data-theme', theme);
    const isLight = theme === 'light';
    const label = document.getElementById('themeLabel');
    const thumb = document.getElementById('themeToggleThumb');
    const icon  = document.getElementById('themeToggleIcon');
    if (label) label.textContent = isLight ? 'Light' : 'Dark';
    if (thumb) thumb.style.transform = isLight ? 'translateX(17px)' : 'translateX(0)';
    if (icon)  icon.className = isLight ? 'ti ti-sun' : 'ti ti-moon';
  }

  function toggleAppTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = 'dark'; // light mode removed
    applyTheme(next);
    // Keep Settings panel in sync so dropdown matches the active theme
    const s = getUserSettings();
    if (s !== null && s !== undefined) {
      s.themeMode = next;
      saveUserSettings(s);
    }
    // Background themes are dark-only — reset to midnight when switching to light mode
    if (next === 'light') {
      const hadTheme = document.documentElement.hasAttribute('data-bg-theme');
      applyBgTheme('midnight');
      if (s && hadTheme) { s.bgTheme = 'midnight'; saveUserSettings(s); } // only persist if a theme was actually active
      // Sync the theme picker buttons in Settings if the panel is open
      document.querySelectorAll('.bg-theme-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.bg === 'midnight');
      });
      if (hadTheme) showToast('Switched to light mode — background themes reset.', 'info', 2000);
    }
  }
