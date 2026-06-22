  // =========================================================
  // ADMIN PANEL
  // =========================================================

  function openAdminOverlay() {
    const ov = document.getElementById('adminOverlay');
    if (!ov) return;
    ov.classList.add('open');
    const _apg = document.getElementById('adminPinGate');
    if (_apg) _apg.style.display = 'block';
    const _aPanel = document.getElementById('adminPanel');
    if (_aPanel) _aPanel.classList.remove('open');
    const pinInput = document.getElementById('adminPinInput');
    if (pinInput) pinInput.value = '';
    const _ape = document.getElementById('adminPinError');
    if (_ape) _ape.style.display = 'none';
    setTimeout(() => { if (pinInput) pinInput.focus(); }, 80);
  }

  function closeAdminOverlay() {
    const ov = document.getElementById('adminOverlay');
    if (ov) ov.classList.remove('open');
    const _pinClear = document.getElementById('adminPinInput');
    if (_pinClear) _pinClear.value = '';
  }

  async function verifyAdminPin() {
    const _pinIn = document.getElementById('adminPinInput');
    const val = _pinIn ? _pinIn.value.trim() : '';
    if (!val) return;
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(val));
    const hex = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
    if (hex === 'c88df307576db7934882aafb2e6e3c575476ee42e9f0959affcda9ee6e1ce801') {
      const _apg = document.getElementById('adminPinGate');
      if (_apg) _apg.style.display = 'none';
      const panel = document.getElementById('adminPanel');
      if (panel) panel.classList.add('open');
      loadAdminPanel();
    } else {
      const errEl = document.getElementById('adminPinError');
      if (errEl) { errEl.style.display = 'block'; setTimeout(() => { errEl.style.display = 'none'; }, 2200); }
      if (_pinIn) { _pinIn.value = ''; _pinIn.focus(); }
    }
  }

  function switchAdminTab(name) {
    document.querySelectorAll('.adm-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    document.querySelectorAll('.adm-tab-content').forEach(c => c.classList.toggle('active', c.id === 'adm-tab-' + name));
  }

  function loadAdminPanel() {
    const s = getAdminSettings();
    // Helper: safely set an element's value
    const _set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
    // General
    _set('adm-dlPath', s.dlPath || '');
    // Workflow
    _set('adm-nbWait', s.nbWaitSec || 180);
    _set('adm-veoWait', s.veoWaitMin || 6);
    _set('adm-maxRetry', s.maxTabRefresh || 0);
    _set('adm-cooldown', s.cooldownSec || 120);
    _set('adm-model', s.defaultModel || 'Veo 3.1 Lite');
    _set('adm-creditBudget', s.creditBudget || 0);
    // Prompts
    _set('adm-nbDefault', s.nbPromptDefault || '');
    _set('adm-veoDefault', s.veoPromptDefault || '');
    // Accounts
    renderAdmAccounts();
    // Start on General tab
    switchAdminTab('general');
  }

  function saveAdminTab(tab) {
    const s = getAdminSettings();
    if (!s) return;
    // Helper: safely get an element's value with a fallback
    const _get = (id, fallback) => { const el = document.getElementById(id); return el ? el.value : fallback; };
    if (tab === 'general') {
      s.dlPath = _get('adm-dlPath', s.dlPath || '').trim();
    } else if (tab === 'workflow') {
      s.nbWaitSec    = parseInt(_get('adm-nbWait',      s.nbWaitSec    || 180)) || 180;
      s.veoWaitMin   = parseInt(_get('adm-veoWait',     s.veoWaitMin   || 6))   || 6;
      s.maxTabRefresh= parseInt(_get('adm-maxRetry',    s.maxTabRefresh|| 0))   || 0;
      s.cooldownSec  = parseInt(_get('adm-cooldown',    s.cooldownSec  || 120)) || 120;
      s.defaultModel =         _get('adm-model',        s.defaultModel || 'Veo 3.1 Lite');
      s.creditBudget = parseInt(_get('adm-creditBudget',s.creditBudget || 0))   || 0;
    } else if (tab === 'prompts') {
      s.nbPromptDefault  = _get('adm-nbDefault',  s.nbPromptDefault  || '').trim();
      s.veoPromptDefault = _get('adm-veoDefault', s.veoPromptDefault || '').trim();
    }
    saveAdminSettings(s);
    showAdmSaved();
  }

  function showAdmSaved() {
    const el = document.getElementById('admSaveStatus');
    if (el) { el.style.display = 'block'; setTimeout(() => { if (el) el.style.display = 'none'; }, 1800); }
    showToast('Settings saved', 'success', 2000);
  }

  // ---- Admin Accounts ----
  let _admEditAccId = null;
  function renderAdmAccounts() {
    const s = getAdminSettings();
    const list = document.getElementById('admAccountList');
    if (!list) return;
    const accs = s.admAccounts || [];
    if (accs.length === 0) {
      list.innerHTML = '<div style="font-size:12px;color:var(--text-3);padding:8px 0;">No accounts yet. Add your first one below.</div>';
      return;
    }
    list.innerHTML = accs.map((a) => `
      <div class="adm-acc-card">
        <span class="adm-acc-platform">${escHtml(a.platform || 'Other')}</span>
        <div>
          <div class="adm-acc-handle">${escHtml(a.handle || '')}</div>
          ${a.name  ? `<div class="adm-acc-name">${escHtml(a.name)}</div>` : ''}
          ${a.url   ? `<div style="font-size:10px;color:var(--accent-2);">${escHtml(a.url)}</div>` : ''}
          ${a.notes ? `<div style="font-size:10px;color:var(--text-3);">${escHtml(a.notes)}</div>` : ''}
        </div>
        <button class="adm-acc-del" onclick="deleteAdmAccount(${escHtml(JSON.stringify(a.id || a.handle))})" title="Remove">✕</button>
      </div>`).join('');
  }

  function openAdmAddAccount(accId) {
    // Store the account's id (not array index) to prevent stale-index overwrites
    _admEditAccId = (accId !== undefined) ? accId : null;
    const s = getAdminSettings();
    const form = document.getElementById('admAccountForm');
    const _admTitle = document.getElementById('admAccFormTitle');
    if (_admTitle) _admTitle.textContent = _admEditAccId !== null ? 'Edit Account' : 'New Account';
    const _admSet = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
    if (_admEditAccId !== null) {
      const a = (s.admAccounts || []).find(a => a.id === _admEditAccId) || {};
      _admSet('adm-acc-platform', a.platform || 'TikTok');
      _admSet('adm-acc-handle',   a.handle   || '');
      _admSet('adm-acc-name',     a.name     || '');
      _admSet('adm-acc-url',      a.url      || '');
      _admSet('adm-acc-notes',    a.notes    || '');
    } else {
      ['adm-acc-handle','adm-acc-name','adm-acc-url','adm-acc-notes'].forEach(id => _admSet(id, ''));
      _admSet('adm-acc-platform', 'TikTok');
    }
    if (form) form.style.display = 'block';
    const _handleFocus = document.getElementById('adm-acc-handle');
    if (_handleFocus) _handleFocus.focus();
  }

  function saveAdmAccount() {
    const s = getAdminSettings();
    if (!s) { showToast('Could not load settings.', 'error'); return; }
    if (!s.admAccounts) s.admAccounts = [];
    const _g = (id) => { const el = document.getElementById(id); return el ? el.value : ''; };
    const acc = {
      platform: _g('adm-acc-platform'),
      handle: _g('adm-acc-handle').trim(),
      name: _g('adm-acc-name').trim(),
      url: _g('adm-acc-url').trim(),
      notes: _g('adm-acc-notes').trim()
    };
    if (!acc.handle) { showToast('Handle is required.', 'warning'); return; }
    if (_admEditAccId !== null) {
      // Find by ID rather than index to prevent stale-index overwrites
      const existingIdx = s.admAccounts.findIndex(a => a.id === _admEditAccId);
      if (existingIdx !== -1) {
        acc.id = _admEditAccId;
        s.admAccounts[existingIdx] = acc;
      } else {
        acc.id = _uid();
        s.admAccounts.push(acc);
      }
    } else { acc.id = _uid(); s.admAccounts.push(acc); }
    saveAdminSettings(s);
    const admAccountForm = document.getElementById('admAccountForm');
    if (admAccountForm) admAccountForm.style.display = 'none';
    renderAdmAccounts();
  }

  function deleteAdmAccount(accId) {
    showConfirm('Remove this account?', () => {
      const s = getAdminSettings();
      // Find by id; fall back to handle for legacy entries that predate id field
      s.admAccounts = (s.admAccounts || []).filter(a => (a.id || a.handle) !== accId);
      saveAdminSettings(s);
      renderAdmAccounts();
    });
  }

  // ---- Backup / Restore ----
  async function admExport() {
    try {
      const [rawAccounts, rawCompetitors, rawScripts, rawStudio,
             rawProducts, rawHooks, rawCtas, rawPerf, rawRecycle, rawIdeas,
             rawPostPlans, rawDailyItems, rawVideoLog,
             rawProjectsR, rawProjectsP, rawActiveR, rawActiveP,
             rawStudioR, rawStudioP] = await Promise.all([
        DB.get('sm_accounts'),      DB.get('sm_competitors'),
        DB.get('sm_viral_scripts'), DB.get('sm_studio_library'),
        DB.get('sm_products'),      DB.get('sm_hooks'),
        DB.get('sm_ctas'),          DB.get('sm_performance'),
        DB.get('sm_recycle'),       DB.get('sm_ideas'),
        DB.get('sm_post_plans'),    DB.get('sm_daily_items'),
        DB.get('sm_video_log'),
        DB.get('sm_projects_r'),        DB.get('sm_projects_p'),
        DB.get('sm_active_project_r'),  DB.get('sm_active_project_p'),
        DB.get('sm_studio_library_r'),  DB.get('sm_studio_library_p'),
      ]);
      const payload = {
        _exported:    new Date().toISOString(),
        adminSettings: getAdminSettings(),
        accounts:     _safeJSON(rawAccounts,    []),
        competitors:  _safeJSON(rawCompetitors, []),
        viralScripts: _safeJSON(rawScripts,     []),
        studio:       _safeJSON(rawStudio,      []),
        products:     _safeJSON(rawProducts,    []),
        hooks:        _safeJSON(rawHooks,       []),
        ctas:         _safeJSON(rawCtas,        []),
        performance:  _safeJSON(rawPerf,        []),
        recycle:      _safeJSON(rawRecycle,     []),
        ideas:        _safeJSON(rawIdeas,       []),
        postPlans:    _safeJSON(rawPostPlans,   []),
        dailyItems:   _safeJSON(rawDailyItems,  []),
        videoLog:     _safeJSON(rawVideoLog,    []),
        replicatorProjects:    _safeJSON(rawProjectsR,  []),
        producerProjects:      _safeJSON(rawProjectsP,  []),
        replicatorActiveProject: rawActiveR || null,
        producerActiveProject:   rawActiveP || null,
        replicatorStudio:      _safeJSON(rawStudioR,    []),
        producerStudio:        _safeJSON(rawStudioP,    []),
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      const _blobUrl = URL.createObjectURL(blob);
      a.href = _blobUrl;
      a.download = `socialos-backup-${new Date().toISOString().slice(0,10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(_blobUrl), 10000);
    } catch (err) { showToast('Export failed: ' + (err.message || String(err)), 'error'); }
  }

  function admImport(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const data = JSON.parse(ev.target.result);
        if (!data || typeof data !== 'object' || !data._exported) {
          showToast('Invalid backup file — missing export header.', 'error');
          return;
        }
        showConfirm('This will overwrite current data. Continue?', async () => {
          try {
            if (data.adminSettings) saveAdminSettings(data.adminSettings);
            if (data.accounts)     await DB.set('sm_accounts',      JSON.stringify(data.accounts));
            if (data.competitors)  await DB.set('sm_competitors',   JSON.stringify(data.competitors));
            if (data.viralScripts) await DB.set('sm_viral_scripts', JSON.stringify(data.viralScripts));
            if (data.studio)       await DB.set('sm_studio_library',JSON.stringify(data.studio));
            if (data.products)     await DB.set('sm_products',      JSON.stringify(data.products));
            if (data.hooks)        await DB.set('sm_hooks',         JSON.stringify(data.hooks));
            if (data.ctas)         await DB.set('sm_ctas',          JSON.stringify(data.ctas));
            if (data.performance)  await DB.set('sm_performance',   JSON.stringify(data.performance));
            if (data.recycle)      await DB.set('sm_recycle',       JSON.stringify(data.recycle));
            if (data.ideas)        await DB.set('sm_ideas',         JSON.stringify(data.ideas));
            const postPlans = Array.isArray(data.postPlans) ? data.postPlans : [];
            const dailyItems = Array.isArray(data.dailyItems) ? data.dailyItems : [];
            await DB.set('sm_post_plans',  JSON.stringify(postPlans));
            await DB.set('sm_daily_items', JSON.stringify(dailyItems));
            await DB.set('sm_video_log',   JSON.stringify(data.videoLog   || []));
            if (data.replicatorProjects)      await DB.set('sm_projects_r',       JSON.stringify(data.replicatorProjects));
            if (data.producerProjects)        await DB.set('sm_projects_p',       JSON.stringify(data.producerProjects));
            if (data.replicatorActiveProject) await DB.set('sm_active_project_r', data.replicatorActiveProject);
            if (data.producerActiveProject)   await DB.set('sm_active_project_p', data.producerActiveProject);
            if (data.replicatorStudio)        await DB.set('sm_studio_library_r', JSON.stringify(data.replicatorStudio));
            if (data.producerStudio)          await DB.set('sm_studio_library_p', JSON.stringify(data.producerStudio));
            showToast('Import successful — reloading…', 'success');
            setTimeout(() => location.reload(), 1200);
          } catch (err2) { showToast('Import failed: ' + (err2?.message || String(err2)), 'error'); }
        });
      } catch(err) { showToast('Invalid backup file.', 'error'); }
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  async function clearAllLocalData() {
    showConfirm('Clear all local app data? This cannot be undone. You will be signed out — your account and subscription remain active and you can sign back in.', async () => {
      try {
        await Promise.all([
          'sm_accounts','sm_competitors','sm_viral_scripts',
          'sm_projects','sm_projects_r','sm_projects_p',
          'sm_active_project_r','sm_active_project_p',
          'sm_studio_library','sm_studio_library_r','sm_studio_library_p',
          'sm_video_log','sm_post_plans','sm_daily_items',
          'sm_hooks','sm_ctas','sm_ideas','sm_products','sm_performance','sm_recycle','sm_segments'
        ].map(k => DB.remove(k)));
        try { if (_sb) await _sb.auth.signOut(); } catch(_) {}
        localStorage.clear(); // clear after signOut so auth tokens are available during session termination
        location.reload();
      } catch (err) {
        showToast('Clear failed: ' + (err.message || String(err)), 'error');
      }
    });
  }

  function admReset() {
    showConfirm('⚠ Reset ALL app data? This cannot be undone.', () => {
      showConfirm('Are you sure? Everything will be cleared.', async () => {
        try {
          await Promise.all([
            DB.remove('sm_accounts'),       DB.remove('sm_competitors'),
            DB.remove('sm_viral_scripts'),  DB.remove('sm_studio_library'),
            DB.remove('sm_studio_library_r'), DB.remove('sm_studio_library_p'),
            DB.remove('sm_products'),       DB.remove('sm_hooks'),
            DB.remove('sm_ctas'),           DB.remove('sm_performance'),
            DB.remove('sm_recycle'),        DB.remove('sm_ideas'),
            DB.remove('sm_post_plans'),     DB.remove('sm_daily_items'),
            DB.remove('sm_video_log'),      DB.remove('sm_user_settings'),
            DB.remove('sm_projects_r'),     DB.remove('sm_projects_p'),
            DB.remove('sm_active_project_r'), DB.remove('sm_active_project_p'),
            DB.remove('sm_segments'),
          ]);
          localStorage.removeItem('sm_admin_settings');
          showToast('Data cleared. The page will now reload.', 'success');
          setTimeout(() => location.reload(), 1200);
        } catch (err) {
          showToast('Reset failed: ' + (err?.message || String(err)), 'error');
        }
      });
    });
  }
