  // ===== MY ACCOUNTS =====
  let accounts = [];
  let editingId = null;
  let currentAccountAvatar = null; // base64 data URL

  function onAccountAvatarChange(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function(ev) {
      const img = new Image();
      img.onload = function() {
        const SIZE = 150;
        const canvas = document.createElement('canvas');
        canvas.width = SIZE; canvas.height = SIZE;
        const ctx = canvas.getContext('2d');
        if (!ctx) { showToast('Could not process avatar image.', 'error'); return; }
        // crop to square from center
        const min = Math.min(img.width, img.height);
        const sx = (img.width - min) / 2;
        const sy = (img.height - min) / 2;
        ctx.drawImage(img, sx, sy, min, min, 0, 0, SIZE, SIZE);
        currentAccountAvatar = canvas.toDataURL('image/jpeg', 0.75);
        setAccountAvatarPreview(currentAccountAvatar);
      };
      img.src = ev.target.result;
    };
    reader.onerror = () => showToast('Could not read avatar image — please try again.', 'error');
    reader.readAsDataURL(file);
    e.target.value = '';
  }

  function setAccountAvatarPreview(src) {
    const img = document.getElementById('fAvatarImg');
    const placeholder = document.getElementById('fAvatarPlaceholder');
    const clearBtn = document.getElementById('fAvatarClearBtn');
    if (!img || !placeholder || !clearBtn) return;
    if (src) {
      img.src = src;
      img.style.display = 'block';
      placeholder.style.display = 'none';
      clearBtn.style.display = 'inline-block';
    } else {
      img.src = '';
      img.style.display = 'none';
      placeholder.style.display = 'block';
      clearBtn.style.display = 'none';
    }
  }

  function clearAccountAvatar() {
    currentAccountAvatar = null;
    setAccountAvatarPreview(null);
  }

  function updateBrandColorPreview() {
    const colorEl   = document.getElementById('fBrandColor');
    const previewEl = document.getElementById('fBrandColorPreview');
    if (!colorEl || !previewEl) return;
    const color = colorEl.value;
    previewEl.style.background  = color;
    previewEl.style.borderColor = color;
  }

  function resetBrandColor() {
    const platEl  = document.getElementById('fPlatform');
    const colorEl = document.getElementById('fBrandColor');
    if (!platEl || !colorEl) return;
    colorEl.value = platformColors[platEl.value] || '#7c6af7';
    updateBrandColorPreview();
  }

  function saveAccounts() {
    DB.set('sm_accounts', JSON.stringify(accounts)).catch(e => { console.warn('saveAccounts error:', e); showToast('Auto-save failed — please check your connection.', 'warning'); });
  }

  function renderTable() {
    const _siEl = document.getElementById('searchInput');
    const _fpEl = document.getElementById('filterPlatform');
    const _fsEl = document.getElementById('filterStatus');
    const search   = _siEl ? _siEl.value.toLowerCase() : '';
    const platform = _fpEl ? _fpEl.value : '';
    const status   = _fsEl ? _fsEl.value : '';

    let filtered = accounts.filter(a => {
      const matchSearch = !search ||
        (a.username||'').toLowerCase().includes(search) ||
        (a.email||'').toLowerCase().includes(search) ||
        (a.tags||'').toLowerCase().includes(search) ||
        (a.notes||'').toLowerCase().includes(search);
      const matchPlatform = !platform || a.platform === platform;
      const matchStatus = !status || a.status === status;
      return matchSearch && matchPlatform && matchStatus;
    });

    const grid = document.getElementById('acctGrid');
    const empty = document.getElementById('emptyState');
    if (!grid || !empty) return;

    if (filtered.length === 0) {
      grid.innerHTML = '';
      empty.style.display = 'block';
    } else {
      empty.style.display = 'none';

      // Compute last-posted per account from videoLog
      const lastPostMap = {};
      (videoLog || []).forEach(v => {
        if (!v.accountId || !v.date) return;
        if (!lastPostMap[v.accountId] || v.date > lastPostMap[v.accountId]) {
          lastPostMap[v.accountId] = v.date;
        }
      });

      // Count scripts used per account from dailyItems
      const scriptCountMap = {};
      (dailyItems || []).forEach(d => {
        if (d.accountId) scriptCountMap[d.accountId] = (scriptCountMap[d.accountId] || 0) + 1;
      });

      grid.innerHTML = filtered.map(a => {
        const pClass = 'platform-' + (a.platform || 'Other').toLowerCase();
        const emoji = platformEmojis[a.platform] || '🌐';
        const sClass = 'status-' + (a.status || 'Active').toLowerCase();
        const color = _safeCssColor(a.brandColor) || _safeCssColor(platformColors[a.platform]) || '#7c6af7';
        const tags = a.tags ? a.tags.split(',').map((t,i) => t.trim()).filter(Boolean).map((t,i) => `<span class="tag tag-c${i%6}">${escHtml(t)}</span>`).join('') : '';
        const linkBtn = a.url ? `<a href="${escHtml(a.url)}" target="_blank" rel="noopener" class="action-btn action-link" title="Open profile"><i class="ti ti-external-link"></i></a>` : '';
        const avatarHtml = a.avatar
          ? `<img src="${escHtml(a.avatar)}" class="apc-avatar-img" alt="avatar">`
          : `<div class="apc-avatar-placeholder" style="color:${color}; border-color:${color}44; background:${color}15;">${emoji}</div>`;

        // Last posted health
        const lastDate = lastPostMap[a.id];
        let lastPostHtml = '<span class="apc-last-post"><i class="ti ti-clock"></i> Never posted</span>';
        if (lastDate) {
          const daysAgo = Math.floor((Date.now() - new Date(lastDate)) / 86400000);
          const cls = daysAgo <= 4 ? 'ok' : daysAgo <= 7 ? 'warn' : 'cold';
          const label = daysAgo === 0 ? 'Today' : daysAgo === 1 ? 'Yesterday' : `${daysAgo}d ago`;
          lastPostHtml = `<span class="apc-last-post ${cls}"><i class="ti ti-calendar-check"></i> ${label}</span>`;
        }

        const scriptCount = scriptCountMap[a.id] || 0;
        const scriptBadge = scriptCount > 0
          ? `<span class="apc-last-post" style="color:var(--accent);"><i class="ti ti-script"></i> ${scriptCount} planned</span>`
          : '';

        return `<div class="acct-profile-card" data-platform="${escHtml(a.platform)}">
          <div class="apc-header">
            ${avatarHtml}
            <div class="apc-info">
              <div class="apc-username">${escHtml(a.username)}</div>
              <div class="apc-platform-row">
                <span class="platform-badge ${pClass}">${emoji} ${a.platform}</span>
                <span class="status-badge ${sClass}">${a.status}</span>
              </div>
            </div>
          </div>
          <div class="apc-body">
            ${a.email ? `<div class="apc-row"><i class="ti ti-mail apc-row-icon"></i><span>${escHtml(a.email)}</span></div>` : ''}
            ${a.notes ? `<div class="apc-row"><i class="ti ti-tag apc-row-icon"></i><span class="apc-notes-text" title="${escHtml(a.notes)}">${escHtml(a.notes)}</span></div>` : ''}
            ${tags ? `<div class="apc-row" style="flex-wrap:wrap;"><i class="ti ti-hash apc-row-icon"></i><div class="tags" style="margin:0;">${tags}</div></div>` : ''}
          </div>
          <div class="apc-footer">
            <div style="display:flex;align-items:center;gap:10px;">
              ${lastPostHtml}
              ${scriptBadge}
            </div>
            <div class="apc-actions">
              <button class="action-btn action-edit" onclick="editAccount(${escHtml(JSON.stringify(a.id))})" title="Edit account"><i class="ti ti-pencil"></i></button>
              ${linkBtn}
              <button class="action-btn action-delete" onclick="deleteAccount(${escHtml(JSON.stringify(a.id))})" title="Delete account"><i class="ti ti-trash"></i></button>
            </div>
          </div>
        </div>`;
      }).join('');
    }

    updateStats();
  }

  function updateStats() {
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set('statTotal',     accounts.length);
    set('statTikTok',    accounts.filter(a => a.platform === 'TikTok').length);
    set('statInstagram', accounts.filter(a => a.platform === 'Instagram').length);
    set('statFacebook',  accounts.filter(a => a.platform === 'Facebook').length);
    set('statYouTube',   accounts.filter(a => a.platform === 'YouTube').length);
    set('headerCount',   accounts.length + ' account' + (accounts.length !== 1 ? 's' : ''));
  }

  async function openModal(id = null) {
    editingId = id;
    const overlay = document.getElementById('modalOverlay');
    if (!overlay) return;
    const _mtEl = document.getElementById('modalTitle');
    if (_mtEl) _mtEl.textContent = id ? 'Edit Account' : 'Add Account';
    if (id) {
      const a = accounts.find(x => x.id === id);
      if (!a) { showToast('Account not found — please close and reopen.', 'error'); return; }
      const _fpEl2 = document.getElementById('fPlatform');   if (_fpEl2) _fpEl2.value = a.platform;
      const _fsEl2 = document.getElementById('fStatus');     if (_fsEl2) _fsEl2.value = a.status;
      const _fuEl2 = document.getElementById('fUsername');   if (_fuEl2) _fuEl2.value = a.username;
      const _furlEl2 = document.getElementById('fUrl');      if (_furlEl2) _furlEl2.value = a.url || '';
      const _ftEl2 = document.getElementById('fTags');       if (_ftEl2) _ftEl2.value = a.tags || '';
      const _fnEl2 = document.getElementById('fNotes');      if (_fnEl2) _fnEl2.value = a.notes || '';
      const _feEl2 = document.getElementById('fEmail');      if (_feEl2) _feEl2.value = a.email || '';
      // Decrypt the at-rest password back into the form so an edit re-saves it
      // intact (otherwise the blank field would overwrite/erase it on save).
      const _fpwEl2 = document.getElementById('fPassword');
      if (_fpwEl2) _fpwEl2.value = (typeof _decField === 'function') ? await _decField(a.password || '') : (a.password || '');
      currentAccountAvatar = a.avatar || null;
      setAccountAvatarPreview(currentAccountAvatar);
      const defaultColor = platformColors[a.platform] || '#7c6af7';
      const _fcEl2 = document.getElementById('fBrandColor'); if (_fcEl2) _fcEl2.value = a.brandColor || defaultColor;
      updateBrandColorPreview();
    } else {
      ['fPlatform','fStatus','fUsername','fUrl','fTags','fNotes','fEmail','fPassword'].forEach(fieldId => {
        const el = document.getElementById(fieldId);
        if (!el) return;
        if (el.tagName === 'SELECT') el.selectedIndex = 0;
        else el.value = '';
      });
      currentAccountAvatar = null;
      setAccountAvatarPreview(null);
      const _fcBrand = document.getElementById('fBrandColor'); if (_fcBrand) _fcBrand.value = '#7c6af7';
      updateBrandColorPreview();
    }
    overlay.style.display = 'flex';
    setTimeout(() => { const _fus = document.getElementById('fUsername'); if (_fus) _fus.focus(); }, 100);
  }

  function closeModal() { const _mo = document.getElementById('modalOverlay'); if (_mo) _mo.style.display = 'none'; editingId = null; }
  function closeModalOnBg(e) { if (e.target === document.getElementById('modalOverlay')) closeModal(); }

  async function saveAccount() {
    const _fuEl = document.getElementById('fUsername');
    if (!_fuEl) return;
    const username = _fuEl.value.trim();
    if (!username) { showToast('Username is required.', 'warning'); return; }
    const _fpEl  = document.getElementById('fPlatform');
    const _fcEl  = document.getElementById('fBrandColor');
    const _fsEl  = document.getElementById('fStatus');
    const _furlEl = document.getElementById('fUrl');
    const _ftEl  = document.getElementById('fTags');
    const _fnEl  = document.getElementById('fNotes');
    const platform = _fpEl ? _fpEl.value : 'TikTok';
    const pickedColor = _fcEl ? _fcEl.value : '#7c6af7';
    const defaultColor = platformColors[platform] || '#7c6af7';
    const _rawPassword = (document.getElementById('fPassword') ? document.getElementById('fPassword').value.trim() : '');
    // Encrypt the password field at-rest before persisting (AES-GCM via
    // _encField). Empty stays empty; on any crypto failure _encField returns
    // the plaintext so save is never blocked.
    const _encPassword = (typeof _encField === 'function') ? await _encField(_rawPassword) : _rawPassword;
    const data = {
      platform,
      status:   _fsEl  ? _fsEl.value              : 'Active',
      username,
      email:    (document.getElementById('fEmail') ? document.getElementById('fEmail').value.trim() : ''),
      password: _encPassword,
      url:      _furlEl ? _furlEl.value.trim()     : '',
      tags:     _ftEl  ? _ftEl.value.trim()        : '',
      notes:    _fnEl  ? _fnEl.value.trim()        : '',
      avatar: currentAccountAvatar || null,
      // Only store brandColor if it differs from the platform default
      brandColor: pickedColor !== defaultColor ? pickedColor : null,
    };
    if (editingId) {
      const idx = accounts.findIndex(a => a.id === editingId);
      if (idx === -1) { showToast('Account not found — please close and reopen.', 'error'); return; }
      accounts[idx] = { ...accounts[idx], ...data, userEdited: true };
    } else {
      accounts.push({ id: _uid(), ...data });
    }
    saveAccounts(); closeModal(); renderTable();
  }

  function editAccount(id) { openModal(id); }
  function deleteAccount(id) {
    showConfirm('Delete this account?', () => {
      accounts = accounts.filter(a => a.id !== id);
      saveAccounts(); renderTable();
    });
  }

  function togglePass() {
    const inp = document.getElementById('fPassword');
    const btn = document.getElementById('passToggleBtn');
    if (!inp || !btn) return;
    inp.type = inp.type === 'password' ? 'text' : 'password';
    btn.textContent = inp.type === 'password' ? '👁' : '🙈';
  }

  // ===== COMPETITORS =====
  let competitors = [];
  let editingCompId = null;

  function saveCompetitors() { DB.set('sm_competitors', JSON.stringify(competitors)).catch(e => console.warn('saveCompetitors error:', e)); }

  function renderCompetitors() {
    const _csiEl = document.getElementById('compSearchInput');
    const _cfpEl = document.getElementById('compFilterPlatform');
    const search   = _csiEl ? _csiEl.value.toLowerCase() : '';
    const platform = _cfpEl ? _cfpEl.value : '';

    let filtered = competitors.filter(c => {
      const matchSearch = !search ||
        (c.name||'').toLowerCase().includes(search) ||
        (c.handle||'').toLowerCase().includes(search) ||
        (c.niche||'').toLowerCase().includes(search) ||
        (c.inspiration||'').toLowerCase().includes(search) ||
        (c.tags||'').toLowerCase().includes(search);
      const matchPlatform = !platform || c.platform === platform;
      return matchSearch && matchPlatform;
    });

    const grid = document.getElementById('compGrid');
    const empty = document.getElementById('compEmptyState');
    if (!grid || !empty) return;

    const _sct = document.getElementById('statCompTotal');
    const _sci = document.getElementById('statCompInstagram');
    const _scf = document.getElementById('statCompFacebook');
    if (_sct) _sct.textContent = competitors.length;
    if (_sci) _sci.textContent = competitors.filter(c => c.platform === 'Instagram').length;
    if (_scf) _scf.textContent = competitors.filter(c => c.platform === 'Facebook').length;

    if (filtered.length === 0) {
      grid.innerHTML = '';
      empty.style.display = 'block';
    } else {
      empty.style.display = 'none';
      const pClass = p => 'platform-' + (p||'other').toLowerCase();
      grid.innerHTML = filtered.map(c => {
        const emoji = platformEmojis[c.platform] || '🌐';
        const tags = c.tags ? c.tags.split(',').map(t => t.trim()).filter(Boolean).map(t => `<span class="tag tag-green">${escHtml(t)}</span>`).join('') : '';
        const urlBtn = c.url ? `<a class="action-btn action-link" href="${escHtml(c.url)}" target="_blank" title="Visit profile"><i class="ti ti-external-link"></i></a>` : '';
        return `<div class="comp-card">
          <div class="comp-card-header">
            <div class="comp-card-title">
              <div class="comp-avatar">${emoji}</div>
              <div>
                <div class="comp-name">${escHtml(c.name || c.handle)}</div>
                <div class="comp-handle">${escHtml(c.handle)}</div>
              </div>
            </div>
            <div class="comp-card-actions">
              ${urlBtn}
              <button class="action-btn action-edit" onclick="editCompetitor(${escHtml(JSON.stringify(c.id))})" title="Edit"><i class="ti ti-pencil"></i></button>
              <button class="action-btn action-delete" onclick="deleteCompetitor(${escHtml(JSON.stringify(c.id))})" title="Delete"><i class="ti ti-trash"></i></button>
            </div>
          </div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px;">
            <span class="platform-badge ${pClass(c.platform)}">${emoji} ${c.platform}</span>
            ${c.niche ? `<span class="comp-niche">${escHtml(c.niche)}</span>` : ''}
            ${c.followers ? `<span class="comp-followers">👥 ${escHtml(c.followers)}</span>` : ''}
          </div>
          ${c.inspiration ? `<div class="comp-inspiration">💡 ${escHtml(c.inspiration)}</div>` : ''}
          ${tags ? `<div class="tags" style="margin-top:10px;">${tags}</div>` : ''}
        </div>`;
      }).join('');
    }
  }

  function openCompModal(id = null) {
    editingCompId = id;
    const _cmtEl = document.getElementById('compModalTitle'); if (_cmtEl) _cmtEl.textContent = id ? 'Edit Competitor' : 'Add Competitor';
    if (id) {
      const c = competitors.find(x => x.id === id);
      if (!c) { showToast('Competitor not found — please close and reopen.', 'error'); return; }
      const _cpEl2 = document.getElementById('cPlatform');     if (_cpEl2) _cpEl2.value = c.platform;
      const _cniEl2 = document.getElementById('cNiche');        if (_cniEl2) _cniEl2.value = c.niche || '';
      const _cnEl2 = document.getElementById('cName');          if (_cnEl2) _cnEl2.value = c.name || '';
      const _chEl2 = document.getElementById('cHandle');        if (_chEl2) _chEl2.value = c.handle || '';
      const _cfEl2 = document.getElementById('cFollowers');     if (_cfEl2) _cfEl2.value = c.followers || '';
      const _cuEl2 = document.getElementById('cUrl');           if (_cuEl2) _cuEl2.value = c.url || '';
      const _ciEl2 = document.getElementById('cInspiration');   if (_ciEl2) _ciEl2.value = c.inspiration || '';
      const _ctEl2 = document.getElementById('cTags');          if (_ctEl2) _ctEl2.value = c.tags || '';
    } else {
      ['cNiche','cName','cHandle','cFollowers','cUrl','cInspiration','cTags'].forEach(fieldId => { const el = document.getElementById(fieldId); if (el) el.value = ''; });
      const _cplat = document.getElementById('cPlatform');
      if (_cplat) _cplat.selectedIndex = 0;
    }
    const _cmo = document.getElementById('compModalOverlay');
    if (_cmo) _cmo.style.display = 'flex';
    setTimeout(() => { const el = document.getElementById('cName'); if (el) el.focus(); }, 100);
  }

  function closeCompModal() { const _cmo = document.getElementById('compModalOverlay'); if (_cmo) _cmo.style.display = 'none'; editingCompId = null; }
  function closeCompModalOnBg(e) { if (e.target === document.getElementById('compModalOverlay')) closeCompModal(); }

  function saveCompetitor() {
    const _cnEl = document.getElementById('cName');
    if (!_cnEl) return;
    const name = _cnEl.value.trim();
    const _chEl  = document.getElementById('cHandle');
    const handle = _chEl ? _chEl.value.trim() : '';
    if (!name && !handle) { showToast('Name or handle is required.', 'warning'); return; }
    const _cpEl  = document.getElementById('cPlatform');
    const _cniEl = document.getElementById('cNiche');
    const _cfEl  = document.getElementById('cFollowers');
    const _cuEl  = document.getElementById('cUrl');
    const _ciEl  = document.getElementById('cInspiration');
    const _ctEl  = document.getElementById('cTags');
    const data = {
      platform:    _cpEl  ? _cpEl.value              : 'Facebook',
      niche:       _cniEl ? _cniEl.value.trim()      : '',
      name, handle,
      followers:   _cfEl  ? _cfEl.value.trim()       : '',
      url:         _cuEl  ? _cuEl.value.trim()        : '',
      inspiration: _ciEl  ? _ciEl.value.trim()        : '',
      tags:        _ctEl  ? _ctEl.value.trim()        : '',
    };
    if (editingCompId) {
      const idx = competitors.findIndex(c => c.id === editingCompId);
      if (idx === -1) { showToast('Competitor not found — please close and reopen.', 'error'); return; }
      competitors[idx] = { ...competitors[idx], ...data };
    } else {
      competitors.push({ id: _uid(), ...data });
    }
    saveCompetitors(); closeCompModal(); renderCompetitors();
  }

  function editCompetitor(id) { openCompModal(id); }
  function deleteCompetitor(id) {
    showConfirm('Remove this competitor?', () => {
      competitors = competitors.filter(c => c.id !== id);
      saveCompetitors(); renderCompetitors();
    });
  }

  // ===== SEED VIRAL SCRIPTS (merges by ID) =====
  function seedViralScripts() {
    const existingIds = new Set(viralScripts.map(s => s.id));
    const seedScripts = [
      {
        id: 'vs_1',
        platform: 'Facebook',
        status: 'To Try',
        title: '"Comment Your Age" USA Geo-Hook — Soursop Bitters',
        source: 'Mother Satori (@MotherSatori) — 5M followers',
        niche: 'Herbal Remedies / Soursop',
        format: 'Talking Head',
        hook: 'If you\'re from the USA 🇺🇸 — comment your age right now.',
        script: 'If you\'re from the USA 🇺🇸 — comment your age right now.\n\n[beat]\n\nBecause I need to tell you something your doctor never will.\n\n[beat]\n\nYour belly is not fat. It is inflammation — sitting deep in your gut, in your liver, in your lymph nodes. Blocking everything.\n\nAnd it has been there for years.\n\nWhen your liver is clogged with toxins, it cannot break down fat. It cannot flush waste. It just holds onto it.\n\nThat is why no diet, no exercise is working.\n\nIn the Caribbean, we have been cleaning the liver with one thing for over 400 years.\n\nSoursop bitters. The leaf. The root. The bark.\n\nBitter herbs trigger your liver to produce bile again. Bile breaks the toxins loose. And your body finally releases what it has been holding onto.\n\nIn seven days — the bloating drops. The puffiness leaves.\n\nComment BITTERS and I will send you exactly where I get mine.',
        why: 'USA geo-hook forces comments instantly — age is personal, everyone answers it. Algorithm sees comment spike and pushes to millions. Hidden internal enemy (liver toxins) = curiosity + fear. ManyChat auto-replies with product link = passive income machine.',
        tags: 'soursop,liver,USA hook,comment your age,bitters,ManyChat,3.4M views,PROVEN',
        url: 'https://www.facebook.com/watch/?v=25736998135937411',
        dateAdded: 'Scanned May 2026'
      },
      {
        id: 'vs_2',
        platform: 'Facebook',
        status: 'To Try',
        title: '"Doctor Explains the Truth About Breakfast" — Fasting Hook',
        source: 'Kim\'s Remedy (@kimsremedy68) — 67K followers',
        niche: 'Health / Fasting / Weight Loss',
        format: 'Talking Head',
        hook: 'Doctor explains the truth about breakfast — and why eating 3 times a day is keeping your body sick.',
        script: 'Doctor explains the truth about breakfast.\n\n[beat]\n\nIf we eat 3 times a day, our body works around the clock to digest food and dispose of waste.\n\nIt does not have time to heal itself.\n\n[beat]\n\nWhen you give your body a break — two meals instead of three — something remarkable happens.\n\nYour body switches from digestion mode into healing mode.\n\nInflammation drops. Fat cells start releasing stored toxins. Your gut finally gets a chance to repair itself.\n\n[beat]\n\nThis is why fasting works better than any diet. Not because of calories — because of timing.\n\n2 meals is better than 3. Fasting is better than we think.\n\n[beat]\n\nIf your body feels sluggish, bloated, heavy — this is why.\n\nComment HEAL and I will send you the morning routine I personally follow every day.',
        why: 'Authority hook (doctor) makes viewers stop scrolling. Challenges a daily behavior everyone does (eating breakfast). Educational save-bait format gets shared. Fasting angle resonates with 35-55 women already curious about intermittent fasting.',
        tags: 'fasting,breakfast,doctor,authority hook,weight loss,healing,1M views,PROVEN',
        url: 'https://www.facebook.com/watch/?v=987852250594549',
        dateAdded: 'Scanned May 2026'
      },
      {
        id: 'vs_3',
        platform: 'Facebook',
        status: 'To Try',
        title: '"Comment SKIN" — Korean Natural Beauty Recipe Hook',
        source: 'Imani Kim Beauty (@imani.kim.beauty) — 71yr Black/Korean, 14K followers',
        niche: 'Korean Skincare / Brightening / Anti-Aging',
        format: 'Talking Head',
        hook: 'Comment SKIN and follow — and I\'ll send you more natural beauty recipes from Korea that women over 50 swear by.',
        script: 'Comment SKIN and follow — and I\'ll send you more natural beauty recipes from Korea that women over 50 swear by.\n\n[beat]\n\nI am 71 years old. And I have never bought a single skin lightening cream.\n\n[beat]\n\nMy Korean grandmother gave me three things when I was a girl. And I have used them every single week since.\n\n[visual cue: hold up each ingredient]\n\nRice water. Fermented. Applied like a toner every morning.\n\nSnail mucin. One drop. On every dark spot.\n\nNiacinamide. Mixed into my moisturizer every night.\n\n[beat]\n\nThirty days. That is all it takes.\n\nDark spots fade. Skin tightens. Tone evens out.\n\n[smile to camera]\n\nHere is the toner I use personally after every single remedy.\n\nComment SKIN and I will send you the full routine — including what I put on my inner thighs and neck.',
        why: 'Comment keyword CTA drives algorithm engagement. "71 years old and look like this" is instant proof. Cultural authority (Black/Korean = two beauty traditions in one). #over40 #over50 audience is the most engaged skincare demographic on Facebook.',
        tags: 'korean skincare,brightening,comment skin,over50,over40,dark spots,recipe,kbeauty,2.1K views',
        url: 'https://www.facebook.com/watch/?v=1671765690808196',
        dateAdded: 'Scanned May 2026'
      },
      {
        id: 'vs_4',
        platform: 'Facebook',
        status: 'To Try',
        title: 'Caribbean Holistic Healer — Beetroot/Ancient Remedy Hook',
        source: 'Iyah Rootman (ID: 61588469780414) — 1M followers, St. Vincent 🇻🇨',
        niche: 'Caribbean Herbal Remedies / Holistic Health',
        format: 'Talking Head',
        hook: 'This root has been growing in the Caribbean for centuries. And your doctor has never once mentioned it to you.',
        script: 'This root has been growing in the Caribbean for centuries.\n\nAnd your doctor has never once mentioned it to you.\n\n[beat]\n\nI am a root healer from St. Vincent. My grandmother\'s grandmother used this plant. And now science is finally catching up.\n\n[beat]\n\nBeetroot.\n\nNot the kind in your grocery store salad — the concentrated root, the way we extract it.\n\nBeetroot floods your blood with nitrates. Your blood vessels relax. Circulation opens up.\n\nAnd when circulation opens up — fat that has been stuck to your organs starts moving.\n\nInflammation that has sat in your joints for years starts leaving.\n\nYour energy comes back. Your skin clears. Your belly flattens.\n\n[beat]\n\nNot because you dieted. Because your blood is finally moving the way God designed it to.\n\nComment ROOT and I will send you exactly what I use and where to get it.',
        why: 'Vincentian cultural authority = extremely rare and trustworthy angle. "Your doctor never mentioned it" = suppressed knowledge hook (one of the highest converting health hooks). 1.7M view reel proves this format is working at massive scale on this exact account.',
        tags: 'caribbean,beetroot,holistic,root healer,blood circulation,ancient remedy,1.7M views,PROVEN',
        url: 'https://www.facebook.com/reel/3896104254027592',
        dateAdded: 'Scanned May 2026'
      },
      {
        id: 'vs_5',
        platform: 'Facebook',
        status: 'To Try',
        title: '"Watch Me" Transformation Hook — Wedding Makeup',
        source: 'Hwang Makeup (ID: 61576513903123) — 28K followers',
        niche: 'Beauty / Korean Makeup / Transformation',
        format: 'POV / B-roll',
        hook: 'Watch me do her wedding makeup… 😳‼️',
        script: '[No dialogue needed — pure visual hook]\n\nOPENING FRAME: Show subject before — no makeup, natural look.\n\n[TRANSFORMATION SEQUENCE]\nApply base product step by step. Close-up on skin texture changing.\nShow contouring. Highlight. Lip color.\n\nFINAL REVEAL: Subject fully made up — dramatic before/after cut.\n\n[Text overlay]: "Comment GLOW and I\'ll send you every product used"\n\nCAPTION: "Watch me do her [event] transformation 😳‼️ Comment GLOW for the full product list #over40 #kbeauty #skincare #usa"',
        why: '"Watch me" is one of the highest CTR hooks on Facebook Reels — it promises entertainment. Shocked emoji + double exclamation creates FOMO. Wedding/event context is emotionally loaded. 75K views with only 28K followers = massive over-performance ratio. Pure visual — no talking head needed.',
        tags: 'watch me,transformation,before after,makeup,no script,visual hook,75K views,PROVEN',
        url: 'https://www.facebook.com/watch/?v=818460924218705',
        dateAdded: 'Scanned May 2026'
      },
      {
        id: 'vs_6',
        platform: 'Facebook',
        status: 'To Try',
        title: 'Mother Satori — Liver/Bile Soursop Science Script (Full Research Version)',
        source: 'Mother Satori (@MotherSatori) — 5M followers',
        niche: 'Herbal Remedies / Liver Health',
        format: 'Talking Head',
        hook: 'The problem is hidden inside. It is your liver.',
        script: 'The problem is hidden inside.\n\nIt is your liver.\n\n[beat]\n\nYour neck is where collagen breaks down first — because the skin there is thinnest. But the real cause is not age.\n\nIt is a clogged liver.\n\nWhen your liver fills with toxins, it creates inflammation. That inflammation travels through your body and destroys collagen — in your neck, your thighs, your belly.\n\n[beat]\n\nFor generations, my family has cleaned the liver with herbs that have been passed down for centuries.\n\nSoursop. Black seed. Lemon root. Hibiscus.\n\nThese are bitter herbs. And bitter compounds trigger your liver to produce bile.\n\nBile breaks down the toxins. Pushes them out of the body.\n\nAnd when the toxins leave — the inflammation drops. The skin tightens. The belly flattens.\n\n[beat]\n\nComment the letter T — and I will send you the exact recipe I mix my bitters with every single morning.',
        why: 'Liver as the hidden root cause is the #1 performing health hook across all avatar pages. Connects skin problems (collagen) to internal organ = more credibility than just "drink this." Bitter herbs + bile science sounds credible even to skeptics. "Comment T" is the shortest possible comment CTA — lowest friction = highest response rate.',
        tags: 'liver,bile,collagen,soursop,black seed,comment T,science hook,low friction CTA,PROVEN',
        url: 'https://www.facebook.com/MotherSatori/',
        dateAdded: 'Scanned May 2026'
      },
      {
        id: 'vs_7',
        platform: 'Instagram',
        status: 'To Try',
        title: 'Melanskia — "Industrial Waste in Your Liver" Amish Wisdom Script',
        source: 'Melanskia (@melanskia) — 373K followers',
        niche: 'Natural Supplements / Liver Cleanse',
        format: 'Talking Head',
        hook: 'What\'s sitting in your gut right now is not fat. It\'s industrial waste your liver was never designed to process.',
        script: 'What\'s sitting in your gut right now is not fat.\n\nIt is industrial waste. Chemicals, preservatives, synthetic dyes — things your liver was never designed to process.\n\n[beat]\n\nOn our farm, we do not eat from packages. We eat from the ground.\n\nAnd in the Amish community, we have known for generations what happens when you put man-made chemicals into a body built for real food.\n\nYour liver gets overwhelmed. It stores what it cannot process as fat. Right around your organs. Right around your belly.\n\n[beat]\n\nThe way to clear it is not a diet. It is not exercise.\n\nIt is giving your liver the compounds it needs to actually flush.\n\n[hold up product]\n\nThis is what I take every morning before anything else.\n\nOne teaspoon. Warm water. Empty stomach.\n\nBy day five your bloating drops. By day ten your energy comes back. By day fourteen your clothes fit differently.\n\nComment CLEAN and I will send you the link.',
        why: 'Amish cultural authority = purity and simplicity = highest trust in natural remedy content. "Industrial waste" framing redefines the problem from personal failure (I ate too much) to systemic one (the food system poisoned me) = emotional relief + anger = sharing. 373K followers built on this exact formula.',
        tags: 'amish,liver,industrial waste,gut,cleanse,supplement,comment clean,cultural authority,373K followers',
        url: 'https://www.instagram.com/melanskia/',
        dateAdded: 'Scanned May 2026'
      },
      // ===== PRODUCT-SPECIFIC REWRITES (vs_8 – vs_14) =====
      {
        id: 'vs_8',
        platform: 'Facebook',
        status: 'To Try',
        title: '🛒 USA Age Hook — Serene Herbs Soursop Bitters Liquid',
        source: 'Inspired by Mother Satori 3.4M-view formula',
        niche: 'Herbal Remedies / Gut Cleanse / Detox',
        format: 'Talking Head',
        hook: 'If you\'re from the USA 🇺🇸 — comment your age right now.',
        script: 'If you\'re from the USA 🇺🇸 — comment your age right now.\n\n[beat]\n\nBecause I need to show you what people in the Caribbean have known for over 400 years.\n\nYour gut is not just "unhealthy." It is clogged with inflammation — sitting in your liver, your intestines, your lymph nodes. Blocking everything.\n\nEvery day you eat processed food, drink tap water, breathe polluted air — it gets worse.\n\nYour liver becomes overwhelmed. It can\'t flush waste. So it stores it — as fat, as bloat, as that puffy feeling you wake up with every morning.\n\n[beat]\n\nIn the Caribbean, we fix this with one liquid. It starts with soursop — the graviola leaf. Mixed with black seed, moringa, Irish moss, turmeric, and ginger.\n\nWe have been using this combination since our grandmothers\' grandmothers.\n\nAnd now it\'s the number-one best-selling detox supplement in America. Sixty thousand people bought it just last month.\n\n[beat]\n\nSeven days. That\'s all it takes for the bloating to drop.\n\nComment CLEANSE and I\'ll send you exactly where to get it.\n\n[ManyChat keyword: CLEANSE → send Amazon link for Serene Herbs Soursop Bitters B0CYV4FCJS]',
        why: 'Same proven geo-hook formula as Mother Satori\'s 3.4M view video. Soursop Bitters is the EXACT product — "60K bought last month" is real Amazon data. Specific ingredients (soursop, black seed, moringa, Irish moss) match bottle label for authenticity.',
        tags: 'soursop,liver,USA hook,comment your age,bitters,ManyChat,product-specific,serene herbs,REWRITE',
        url: 'https://www.amazon.com/dp/B0CYV4FCJS',
        dateAdded: 'May 2026 — Product Rewrite'
      },
      {
        id: 'vs_9',
        platform: 'Facebook',
        status: 'To Try',
        title: '🛒 Doctor Explains Why You\'re Always Tired — Pura Vida Moringa',
        source: 'Inspired by Kim\'s Remedy 1M-view authority hook formula',
        niche: 'Energy / Metabolism / Immune Support',
        format: 'Talking Head',
        hook: 'A doctor finally explained why I was exhausted at 2 PM every single day — even when I slept 8 hours.',
        script: 'A doctor finally explained why I was exhausted at 2 PM every single day — even when I slept 8 hours.\n\n[beat]\n\nIt is not age. It is not stress.\n\nIt is your mitochondria — the tiny batteries inside every single cell in your body.\n\nWhen your mitochondria are damaged by processed food, chemicals, and chronic inflammation — your cells literally cannot produce energy.\n\nThat afternoon crash? That brain fog? Those are not feelings. That is cellular breakdown.\n\n[beat]\n\nFor 5,000 years, Ayurvedic medicine has had one answer. Moringa oleifera. The miracle tree.\n\nIt contains over 90 nutrients. More iron than spinach. More vitamin C than oranges. More calcium than milk.\n\nBut the secret compound — isothiocyanates — these directly protect your mitochondria. They rebuild the energy your cells have been starved of.\n\n[beat]\n\nI have been taking two capsules every morning for 60 days.\n\nNo more 2 PM crash. No more reaching for coffee. My metabolism is running the way it ran at 30.\n\nComment ENERGY and I will send you the exact brand I use — it is single-origin organic and the number one moringa supplement in America.\n\n[ManyChat keyword: ENERGY → send Amazon link for Pura Vida Moringa B00Y2MAE9O]',
        why: 'Doctor + cellular science makes it credible. "2 PM crash" is universal — everyone relates. 5,000 years of Ayurveda + modern isothiocyanate science = ancient/modern hybrid hook. Pura Vida is literally #1 in Moringa category on Amazon.',
        tags: 'moringa,energy,doctor hook,mitochondria,metabolism,2pm crash,ayurveda,pura vida,REWRITE',
        url: 'https://www.amazon.com/dp/B00Y2MAE9O',
        dateAdded: 'May 2026 — Product Rewrite'
      },
      {
        id: 'vs_10',
        platform: 'Facebook',
        status: 'To Try',
        title: '🛒 Comment GLOW — JiYu Korean Dark Spot Toning Pads',
        source: 'Inspired by Imani Kim Beauty Korean recipe formula',
        niche: 'Korean Skincare / Dark Spots / Anti-Aging',
        format: 'Talking Head',
        hook: 'Comment GLOW and I\'ll send you the Korean secret to erasing dark spots without a single cream.',
        script: 'Comment GLOW and I\'ll send you the Korean secret to erasing dark spots without a single cream.\n\n[beat]\n\nI am 58 years old. Korean-American. And I have never had a single laser treatment.\n\n[beat]\n\nMy mother had dark spots. My grandmother had dark spots. Every woman in my family did.\n\nUntil my halmoni — my grandmother — showed me what Korean women have been using for 300 years.\n\nSnail mucin. Niacinamide. Centella asiatica.\n\nThese three ingredients work at the cellular level. They interrupt melanin production before it reaches the surface. They rebuild the collagen layer beneath the skin.\n\nDark spots don\'t get covered up. They get erased.\n\n[beat]\n\nI used to spend three hundred dollars a month on brightening creams. Then I found these pads.\n\nKorean formula. One hundred pads in one pack. Snail mucin, niacinamide, peptides, centella asiatica, AND alpha-arbutin — everything my halmoni\'s recipe had, in one single swipe.\n\nOne pad every night. Within two weeks — the spots started fading. Within thirty days — my skin tone evened out completely.\n\n[hold up JiYu pads to camera]\n\nComment GLOW and I will send you the link.\n\n[ManyChat keyword: GLOW → send Amazon link for JiYu Toning Polish Pads B0DC156Y5X]',
        why: 'Korean halmoni cultural authority = highest trust in skincare content. Specific ingredients on the JiYu label (snail mucin, niacinamide, centella, alpha-arbutin) are name-dropped for authenticity. "Erase" not "cover" — active transformation language. Over-50 demographic is most engaged skincare viewer on Facebook.',
        tags: 'korean skincare,dark spots,glow,comment glow,halmoni,snail mucin,niacinamide,jiyu,REWRITE',
        url: 'https://www.amazon.com/dp/B0DC156Y5X',
        dateAdded: 'May 2026 — Product Rewrite'
      },
      {
        id: 'vs_11',
        platform: 'Facebook',
        status: 'To Try',
        title: '🛒 Caribbean Island Hydration Secret — Rosabella Electrolyte',
        source: 'Inspired by Iyah Rootman 1.7M-view Caribbean healer formula',
        niche: 'Hydration / Electrolytes / Natural Wellness',
        format: 'Talking Head',
        hook: 'This combination of minerals has been used in the islands since before your grandparents were born. And your sports drink has zero of them.',
        script: 'This combination of minerals has been used in the islands since before your grandparents were born.\n\nAnd your sports drink has zero of them.\n\n[beat]\n\nI am a root healer from the islands. Where I come from, we do not reach for sugar-filled sports drinks or energy drinks full of artificial colors.\n\nWe drink what the earth gives us.\n\n[beat]\n\nYour body needs five things to stay hydrated at the cellular level. Not just water.\n\nSodium. Potassium. Magnesium. Calcium. And Vitamin C from real plants.\n\nWhen these are out of balance — you feel it.\n\nMuscle cramps. Brain fog. Fatigue that sleep does not fix. Heart racing when you stand up too fast.\n\nThat is not weakness. That is cellular dehydration.\n\n[beat]\n\nIn the islands, we get these from hibiscus, sea moss, coconut water, and Himalayan sea salt.\n\nBut now there is a formula that gives your body all five — with no sugar, no chemicals, no artificial anything.\n\nJust clean electrolytes: sodium, potassium, magnesium, calcium, Vitamin C and B12. Watermelon flavor from real plant minerals.\n\n[hold up Rosabella packet]\n\nRosabella. The island answer, finally in a modern form.\n\nFive thousand people are buying this every month.\n\nComment HYDRATE and I will send you the link.\n\n[ManyChat keyword: HYDRATE → send Amazon link for Rosabella Electrolyte B0FJMXG83P]',
        why: 'Caribbean authority + cellular hydration science. "Not just water" reframes hydration — educates and elevates. Naming the 5 electrolytes matches Rosabella\'s actual label. Sugar-free is a critical differentiator for health-conscious audience. 5K/month Amazon sales = real social proof.',
        tags: 'electrolytes,hydration,caribbean,rosabella,sugar free,watermelon,comment hydrate,island remedy,REWRITE',
        url: 'https://www.amazon.com/dp/B0FJMXG83P',
        dateAdded: 'May 2026 — Product Rewrite'
      },
      {
        id: 'vs_12',
        platform: 'Facebook',
        status: 'To Try',
        title: '🛒 "Watch Me Clear My Skin" — QUIA AHA/BHA Toner Pads',
        source: 'Inspired by Hwang Makeup 75K-view "Watch Me" transformation formula',
        niche: 'Korean Skincare / Acne / Pores / Exfoliation',
        format: 'POV / B-roll / 30-Day Challenge',
        hook: 'Watch me clear my skin in 30 days using one Korean pad 😳‼️',
        script: '[OPENING FRAME: Bare skin close-up — visible blackheads, dull texture, uneven tone]\n[Text overlay: "Day 1 — no filter, no makeup"]\n\nWatch me.\n\n[DAYS 1-7 MONTAGE: Quick clips applying QUIA pad each morning. Hold pad to camera. Swipe across cheek.]\n[Text overlay: "One pad. Every morning. No prescription needed."]\n\n[DAYS 8-14: Close-up on skin — pores visibly tightening]\n[Text overlay: "Day 14 — I can feel the texture changing"]\n\n[DAYS 15-30: Clean, glowing skin reveal — slow zoom]\n[Text overlay: "Day 30. Same face. Zero filter."]\n\n[FINAL FRAME: Hold QUIA toner pads to camera with smile]\n[Text overlay: "Comment CLEAR and I\'ll send you these 🇰🇷"]\n\nCAPTION: "Watch me clear my skin in 30 days using one Korean pad 😳‼️ AHA + BHA dual formula, 70 pads per pack, clinically proven 3X gentler than regular exfoliants. No purging. No irritation. Just results. Comment CLEAR for the link #skincare #kbeauty #acne #toner #blackheads #30daychallenge"\n\n[ManyChat keyword: CLEAR → send Amazon link for QUIA Toner Pads B0G4JQ5M69]',
        why: '"Watch me" is the #1 performing visual hook on Facebook Reels. 30-day challenge format = saves, shares, and follow-up comments. "No prescription" = resonates with people frustrated by expensive dermatology. QUIA\'s "3X gentler" clinical claim is a real differentiator to display on screen.',
        tags: 'watch me,transformation,before after,30 days,toner pads,AHA BHA,blackheads,QUIA,kbeauty,REWRITE',
        url: 'https://www.amazon.com/dp/B0G4JQ5M69',
        dateAdded: 'May 2026 — Product Rewrite'
      },
      {
        id: 'vs_13',
        platform: 'Facebook',
        status: 'To Try',
        title: '🛒 Liver/Bile Science Hook — Serene Herbs Soursop Bitters',
        source: 'Inspired by Mother Satori Liver/Bile Science formula',
        niche: 'Herbal Remedies / Liver Health / Detox',
        format: 'Talking Head',
        hook: 'The problem is hiding inside you right now. And it has nothing to do with what you ate.',
        script: 'The problem is hiding inside you right now.\n\nAnd it has nothing to do with what you ate.\n\n[beat]\n\nYour neck is sagging. Your belly will not go down no matter what you try. You wake up tired every morning.\n\nThat is not aging. That is your liver.\n\n[beat]\n\nWhen your liver is clogged — and everyone who eats processed food has some level of liver congestion — it stops producing bile.\n\nBile is what breaks down fat. Bile is what carries toxins out of your body.\n\nWithout bile, toxins recirculate. They destroy collagen. They create inflammation. They get stored around your organs.\n\nThat is what you are seeing in the mirror.\n\n[beat]\n\nIn the Caribbean, in West Africa, in ancient India — they all knew one truth.\n\nBitter herbs force the liver to produce bile again.\n\nSoursop leaf. Black seed. Moringa. Ashwagandha. Irish sea moss. Turmeric. Ginger.\n\nNot one. All of them together. Concentrated. In liquid form.\n\nYour body absorbs liquid in seven minutes. Capsules take hours.\n\n[hold up Serene Herbs bottle]\n\nThis is Serene Herbs. Number one best-selling detox supplement in America. Eight thousand verified five-star reviews. Sixty thousand people bought it last month.\n\nComment BITTER and I will send you the link.\n\n[ManyChat keyword: BITTER → send Amazon link for Serene Herbs Soursop Bitters B0CYV4FCJS]',
        why: 'Liver as hidden root cause is the #1 performing health hook. "Liquid absorbs in 7 minutes" = unique product angle vs. capsules. 8K reviews + 60K bought/month is real Amazon data — say it confidently. "Comment BITTER" = lowest-friction CTA.',
        tags: 'liver,bile,collagen,soursop,black seed,moringa,comment bitter,science hook,serene herbs,REWRITE',
        url: 'https://www.amazon.com/dp/B0CYV4FCJS',
        dateAdded: 'May 2026 — Product Rewrite'
      },
      {
        id: 'vs_14',
        platform: 'Instagram',
        status: 'To Try',
        title: '🛒 "Industrial Waste in Your Body" — Pura Vida Moringa Capsules',
        source: 'Inspired by Melanskia 373K "Industrial Waste" Amish formula',
        niche: 'Natural Supplements / Detox / Energy',
        format: 'Talking Head',
        hook: 'What\'s sitting in your body right now is not fat. It\'s toxins your liver was never built to process.',
        script: 'What\'s sitting in your body right now is not fat.\n\nIt\'s toxins. Pesticides, preservatives, synthetic chemicals — things your liver was never designed to handle.\n\n[beat]\n\nI grew up on a small farm. We grew our own food. We did not eat from packages.\n\nAnd I watched what happened to people in my community who switched to processed food.\n\nTheir energy disappeared. Their belly grew. Their joints ached. Their mood crashed.\n\nThat is not aging. That is a toxic overload.\n\n[beat]\n\nThe most powerful natural detoxifier on this earth does not come from a lab.\n\nIt comes from the moringa tree. Called the "miracle tree" in 80 countries. Used by healers for over 5,000 years.\n\nOver 90 vitamins and minerals in one leaf. The compounds in moringa — called isothiocyanates — activate your liver\'s natural detox pathways. Give your cells the fuel they\'ve been starved of.\n\n[beat]\n\nWithin 14 days, your energy comes back. Your digestion normalizes. The inflammation in your joints starts dropping.\n\n[hold up Pura Vida bottle]\n\nPura Vida Moringa. Single-origin organic. 120 capsules. Number one moringa supplement in America. Ten thousand people bought this last month.\n\nComment TREE and I will send you the link.\n\n[ManyChat keyword: TREE → send Amazon link for Pura Vida Moringa B00Y2MAE9O]',
        why: '"Industrial waste" framing = emotional relief (not my fault, the food system did this). Farm cultural authority = purity and trust. Moringa\'s 5,000-year history + isothiocyanate science = ancient/modern hybrid. "90+ vitamins" is a real, verifiable claim. Pura Vida is genuinely #1 in Moringa on Amazon.',
        tags: 'moringa,industrial waste,detox,energy,farm authority,5000 years,pura vida,comment tree,REWRITE',
        url: 'https://www.amazon.com/dp/B00Y2MAE9O',
        dateAdded: 'May 2026 — Product Rewrite'
      }
    ];
    const newSeeds = seedScripts.filter(s => !existingIds.has(s.id));
    if (newSeeds.length === 0) return;
    viralScripts = [...viralScripts, ...newSeeds];
    saveScriptsStore();
  }

  // ===== VIRAL SCRIPTS =====
  let viralScripts = [];
  let editingScriptId = null;

  function saveScriptsStore() { DB.set('sm_viral_scripts', JSON.stringify(viralScripts)).catch(e => console.warn('saveScriptsStore error:', e)); }

  function renderScripts() {
    const _ssiEl = document.getElementById('scriptSearchInput');
    const _sfsEl = document.getElementById('scriptFilterStatus');
    const _sffEl = document.getElementById('scriptFilterFormat');
    const search = _ssiEl ? (_ssiEl.value || '').toLowerCase() : '';
    const status = _sfsEl ? _sfsEl.value : '';
    const format = _sffEl ? _sffEl.value : '';

    let filtered = viralScripts.filter(s => {
      const matchSearch = !search ||
        (s.title||'').toLowerCase().includes(search) ||
        (s.script||'').toLowerCase().includes(search) ||
        (s.source||'').toLowerCase().includes(search);
      const matchSt = !status || s.status === status;
      const matchFmt = !format || s.format === format;
      return matchSearch && matchSt && matchFmt;
    });

    // Stats
    const _sst = document.getElementById('statScriptTotal');
    const _sstry = document.getElementById('statScriptTry');
    const _ssused = document.getElementById('statScriptUsed');
    if (_sst)   _sst.textContent   = viralScripts.length;
    if (_sstry) _sstry.textContent = viralScripts.filter(s => s.status === 'To Try').length;
    const _usedCount = viralScripts.filter(s => s.status === 'Used').length;
    if (_ssused) {
      if (_usedCount === 0) {
        _ssused.innerHTML = '<span style="font-size:13px;font-weight:700;color:var(--accent);">→</span>';
        const _usedLabel = _ssused.nextElementSibling;
        if (_usedLabel) _usedLabel.innerHTML = '<span style="font-size:9px;color:var(--accent);font-weight:700;">Try one first</span>';
      } else {
        _ssused.textContent = _usedCount;
        const _usedLabel = _ssused.nextElementSibling;
        if (_usedLabel) _usedLabel.textContent = 'Used';
      }
    }

    const grid = document.getElementById('scriptsGrid');
    const empty = document.getElementById('scriptsEmptyState');
    if (!grid || !empty) return;

    if (filtered.length === 0) {
      grid.innerHTML = '';
      empty.style.display = 'block';
    } else {
      empty.style.display = 'none';
      grid.innerHTML = filtered.map(s => {
        const stClass = s.status === 'To Try' ? 'script-status-try' : s.status === 'Used' ? 'script-status-used' : 'script-status-archived';
        const scriptPreview = escHtml(s.script || '').replace(/\n/g, '<br>');
        return `<div class="script-card">
          <div class="script-card-header">
            <div class="script-title">${escHtml(s.title || 'Untitled Script')}</div>
            <div style="display:flex;gap:5px;flex-shrink:0;">
              <button class="action-btn action-edit" onclick="editScript(${escHtml(JSON.stringify(s.id))})">✏️</button>
              <button class="action-btn action-delete" onclick="deleteScript(${escHtml(JSON.stringify(s.id))})">🗑</button>
            </div>
          </div>
          <div class="script-meta">
            ${s.format ? `<span class="script-format">${escHtml(s.format)}</span>` : ''}
            <span class="script-status ${stClass}">${escHtml(s.status)}</span>
            ${s.source ? `<span class="script-source" style="margin:0;">📌 ${escHtml(s.source)}</span>` : ''}
          </div>
          ${s.script ? `<div class="script-body" id="sb-${s.id}">${scriptPreview}</div>
          <button class="script-toggle-btn" id="sbt-${s.id}" onclick="toggleScriptExpand(${escHtml(JSON.stringify(s.id))})">▼ Show full script</button>` : ''}
          <div class="script-card-footer">
            <button class="btn-copy" onclick="copyScript(${escHtml(JSON.stringify(s.id))}, this)" title="Copy script to clipboard">📋 Copy</button>
            <button onclick="sendScriptToReplicator(${escHtml(JSON.stringify(s.id))})" title="Send to Video Replicator" style="padding:2px 9px;font-size:10px;background:rgba(251,191,36,0.08);border:1px solid rgba(251,191,36,0.3);border-radius:3px;color:var(--warning);cursor:pointer;font-weight:600;">→ Replicator</button>
          </div>
        </div>`;
      }).join('');
    }
  }

  function copyScript(id, btn) {
    const s = viralScripts.find(x => x.id === id);
    if (!s) return;
    const text = [s.title, s.script].filter(Boolean).join('\n\n');
    navigator.clipboard.writeText(text).then(() => {
      btn.textContent = '✅ Copied!';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = '📋 Copy'; btn.classList.remove('copied'); }, 2000);
    }).catch(() => showToast('Copy failed — please try again.', 'error'));
  }

  function _loadScriptIntoStudio(id, mode) {
    const s = viralScripts.find(x => x.id === id);
    if (!s) return;
    const text = s.script || '';
    switchTab(mode === 'producer' ? 'video-producer' : 'video-replicator');
    setTimeout(() => {
      const ta = document.getElementById('originalScript');
      if (ta) {
        ta.value = text;
        ta.dispatchEvent(new Event('input'));
        ta.style.borderColor = 'var(--accent)';
        setTimeout(() => ta.style.borderColor = '', 1400);
      }
    }, 300);
  }
  function sendScriptToProducer(id)   { _loadScriptIntoStudio(id, 'producer');   }
  function sendScriptToReplicator(id) { _loadScriptIntoStudio(id, 'replicator'); }

  // Safe ID-based bridge for Hook Bank / CTA Library → studio buttons
  // These avoid embedding raw text in onclick attributes (XSS vector)
  function _pushHookToStudio(btn, mode) {
    const h = hooks.find(x => x.id === btn.dataset.hid);
    if (h) _pushTextToStudio(h.text, mode);
  }
  function _pushCTAToStudio(btn, mode) {
    const c = ctas.find(x => x.id === btn.dataset.cid);
    if (c) _pushTextToStudio(c.text, mode);
  }

  // Push any raw text (hook, CTA, etc.) into the studio script box
  function _pushTextToStudio(text, mode) {
    switchTab(mode === 'producer' ? 'video-producer' : 'video-replicator');
    setTimeout(() => {
      const ta = document.getElementById('originalScript');
      if (ta) {
        // Append to existing script if non-empty, otherwise replace
        const existing = ta.value.trim();
        ta.value = existing ? existing + '\n\n' + text : text;
        ta.dispatchEvent(new Event('input'));
        if (typeof saveSegments === 'function') saveSegments();
        ta.style.borderColor = 'var(--accent)';
        ta.scrollTop = ta.scrollHeight;
        setTimeout(() => ta.style.borderColor = '', 1400);
      }
    }, 300);
  }

  function toggleScriptExpand(id) {
    const body = document.getElementById('sb-' + id);
    const btn  = document.getElementById('sbt-' + id);
    if (!body || !btn) return;
    const expanded = body.classList.toggle('expanded');
    btn.textContent = expanded ? '▲ Show less' : '▼ Show full script';
  }

  function openScriptModal(id = null) {
    editingScriptId = id;
    const _smtEl = document.getElementById('scriptModalTitle'); if (_smtEl) _smtEl.textContent = id ? 'Edit Script' : 'Add Script';
    if (id) {
      const s = viralScripts.find(x => x.id === id);
      if (!s) { showToast('Script not found — please close and reopen.', 'error'); return; }
      const _ssEl = document.getElementById('sStatus');
      const _sfEl = document.getElementById('sFormat');
      const _stEl = document.getElementById('sTitle');
      const _srcEl = document.getElementById('sSource');
      const _scEl = document.getElementById('sScript');
      if (_ssEl)  _ssEl.value  = s.status || 'To Try';
      if (_sfEl)  _sfEl.value  = s.format || 'Talking Head';
      if (_stEl)  _stEl.value  = s.title  || '';
      if (_srcEl) _srcEl.value = s.source || '';
      if (_scEl)  _scEl.value  = s.script || '';
    } else {
      const _sst = document.getElementById('sStatus');
      const _sfmt = document.getElementById('sFormat');
      if (_sst) _sst.selectedIndex = 0;
      if (_sfmt) _sfmt.selectedIndex = 0;
      ['sTitle','sSource','sScript'].forEach(i => { const el = document.getElementById(i); if (el) el.value = ''; });
    }
    const _smo = document.getElementById('scriptModalOverlay');
    if (_smo) _smo.style.display = 'flex';
    setTimeout(() => { const el = document.getElementById('sTitle'); if (el) el.focus(); }, 100);
  }

  function closeScriptModal() { const _smo = document.getElementById('scriptModalOverlay'); if (_smo) _smo.style.display = 'none'; editingScriptId = null; }
  function closeScriptModalOnBg(e) { if (e.target === document.getElementById('scriptModalOverlay')) closeScriptModal(); }

  function saveScript() {
    const _stEl = document.getElementById('sTitle');
    if (!_stEl) return;
    const title = _stEl.value.trim();
    if (!title) { showToast('Script title is required.', 'warning'); return; }
    const _ssEl  = document.getElementById('sStatus');
    const _sfEl  = document.getElementById('sFormat');
    const _srcEl = document.getElementById('sSource');
    const _scEl  = document.getElementById('sScript');
    const data = {
      status: _ssEl  ? _ssEl.value  : 'To Try',
      format: _sfEl  ? _sfEl.value  : 'Talking Head',
      title,
      source: _srcEl ? _srcEl.value.trim() : '',
      script: _scEl  ? _scEl.value.trim()  : '',
    };
    if (editingScriptId) {
      const idx = viralScripts.findIndex(s => s.id === editingScriptId);
      if (idx === -1) { showToast('Script not found — please close and reopen.', 'error'); return; }
      viralScripts[idx] = { ...viralScripts[idx], ...data };
    } else {
      viralScripts.push({ id: _uid(), dateAdded: new Date().toLocaleDateString(), ...data });
    }
    saveScriptsStore(); closeScriptModal(); renderScripts();
  }

  function editScript(id) { openScriptModal(id); }
  function deleteScript(id) {
    showConfirm('Remove this viral script?', () => {
      viralScripts = viralScripts.filter(s => s.id !== id);
      saveScriptsStore(); renderScripts();
    });
  }

  // ===== COMMAND PALETTE =====
  const CMD_ITEMS = [
    { group: 'Navigate', label: 'Dashboard',         icon: 'ti-layout-dashboard',  action: () => switchTab('dashboard') },
    { group: 'Navigate', label: 'Video Replicator',  icon: 'ti-video',             action: () => switchTab('video-replicator') },
    { group: 'Navigate', label: 'Viral Scripts',     icon: 'ti-script',            action: () => switchTab('viral-scripts') },
    { group: 'Navigate', label: 'Accounts',          icon: 'ti-users',             action: () => switchTab('my-accounts') },
    { group: 'Navigate', label: 'Calendar',          icon: 'ti-calendar',          action: () => switchTab('calendar') },
    { group: 'Navigate', label: 'Settings',          icon: 'ti-settings',          action: () => openUserSettings() },
    { group: 'Studio',   label: 'Detect Cuts',       icon: 'ti-scissors',          action: () => { switchTab('video-replicator'); setTimeout(autoSegmentBySceneChange, 200); } },
    { group: 'Studio',   label: 'Process Everything',icon: 'ti-bolt',              action: () => { switchTab('video-replicator'); setTimeout(processEverything, 200); } },
    { group: 'Studio',   label: 'Generate Prompts',  icon: 'ti-wand',              action: () => { switchTab('video-replicator'); setTimeout(generateAllSegmentPrompts, 200); } },
    { group: 'Studio',   label: 'Run All Scenes',    icon: 'ti-player-play',       action: () => { switchTab('video-replicator'); setTimeout(() => showPreflightModal(false), 200); } },
    { group: 'Studio',   label: 'Copy All Veo Prompts', icon: 'ti-clipboard',     action: () => copyAllVeoPrompts() },
    { group: 'Studio',   label: 'Clear Segments',    icon: 'ti-trash',             action: () => clearSegments() },
    { group: 'Studio',   label: 'Open Video Library',icon: 'ti-books',             action: () => openVideoLibrary() },
    { group: 'Studio',   label: 'Save to Library',   icon: 'ti-device-floppy',     action: () => saveGeneratedToLibrary() },
    { group: 'App',      label: 'Sign Out',           icon: 'ti-logout',           action: () => doLogout() },
  ];

  let _cmdActive = -1;

  function openCmdPalette() {
    const pal = document.getElementById('cmdPalette');
    const inp = document.getElementById('cmdInput');
    if (!pal) return;
    pal.classList.add('open');
    _cmdActive = -1;
    filterCmdList('');
    setTimeout(() => inp && inp.focus(), 30);
    // Failsafe: close on Escape even if input doesn't have focus
    // Remove any stale listener from a previous open before adding a new one
    if (pal._escHandler) { document.removeEventListener('keydown', pal._escHandler, true); pal._escHandler = null; }
    pal._escHandler = (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); closeCmdPalette(); } };
    document.addEventListener('keydown', pal._escHandler, true); // capture phase
  }

  function closeCmdPalette() {
    const pal = document.getElementById('cmdPalette');
    if (!pal) return;
    pal.classList.remove('open');
    // Remove the capture-phase Escape listener
    if (pal._escHandler) { document.removeEventListener('keydown', pal._escHandler, true); pal._escHandler = null; }
    const inp = document.getElementById('cmdInput');
    if (inp) inp.value = '';
  }

  function filterCmdList(query) {
    const list = document.getElementById('cmdList');
    if (!list) return;
    _cmdActive = -1;
    const q = query.trim().toLowerCase();
    const filtered = q ? CMD_ITEMS.filter(c => c.label.toLowerCase().includes(q) || c.group.toLowerCase().includes(q)) : CMD_ITEMS;
    if (filtered.length === 0) {
      list.innerHTML = '<div class="cmd-empty">No commands found</div>';
      return;
    }
    const groups = [...new Set(filtered.map(c => c.group))];
    list.innerHTML = groups.map(g => {
      const items = filtered.filter(c => c.group === g);
      return `<div class="cmd-group-label">${g}</div>` +
        items.map((c, _i) => {
          const idx = filtered.indexOf(c);
          return `<div class="cmd-item" data-idx="${idx}" onmousedown="event.preventDefault();_cmdRunIdx(${idx})">
            <i class="ti ${c.icon}"></i>
            <span>${c.label}</span>
          </div>`;
        }).join('');
    }).join('');
  }

  function _cmdRunIdx(idx) {
    const filtered = _getCmdFiltered();
    if (filtered[idx]) { try { filtered[idx].action(); } catch(e) { console.warn('Cmd action failed:', e); } closeCmdPalette(); }
  }

  function _getCmdFiltered() {
    const inp = document.getElementById('cmdInput');
    const q = (inp ? inp.value : '').trim().toLowerCase();
    return q ? CMD_ITEMS.filter(c => c.label.toLowerCase().includes(q) || c.group.toLowerCase().includes(q)) : CMD_ITEMS;
  }

  function cmdKeyNav(e) {
    const list = document.getElementById('cmdList');
    const items = list ? list.querySelectorAll('.cmd-item') : [];
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      _cmdActive = Math.min(_cmdActive + 1, items.length - 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      _cmdActive = Math.max(_cmdActive - 1, 0);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (_cmdActive >= 0 && items[_cmdActive]) {
        const idx = parseInt(items[_cmdActive].dataset.idx);
        _cmdRunIdx(idx);
      }
      return;
    } else if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation(); closeCmdPalette(); return;
    }
    items.forEach((el, i) => el.classList.toggle('active', i === _cmdActive));
    if (items[_cmdActive]) items[_cmdActive].scrollIntoView({ block: 'nearest' });
  }

  // Keyboard
  let _admSeq = 0, _admTimer = null;
  if (!window._authKeysBound) {
    window._authKeysBound = true;
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') { if (typeof closeModal === 'function') closeModal(); if (typeof closeCompModal === 'function') closeCompModal(); if (typeof closeScriptModal === 'function') closeScriptModal(); if (typeof closeAdminOverlay === 'function') closeAdminOverlay(); if (typeof closeUserSettings === 'function') closeUserSettings(); if (typeof closeCmdPalette === 'function') closeCmdPalette(); }
      // Ctrl+K — open command palette
      if (e.ctrlKey && e.key === 'k') { e.preventDefault(); openCmdPalette(); return; }
      // Admin shortcut: Ctrl+Shift+1 then Ctrl+Shift+2 within 1.5s
      if (e.ctrlKey && e.shiftKey && (e.key === '1' || e.key === '!')) {
        _admSeq = 1; clearTimeout(_admTimer); _admTimer = setTimeout(()=>{ _admSeq=0; }, 1500);
      } else if (e.ctrlKey && e.shiftKey && (e.key === '2' || e.key === '@') && _admSeq === 1) {
        _admSeq = 0; clearTimeout(_admTimer); openAdminOverlay();
      } else if (!e.ctrlKey || !e.shiftKey) {
        _admSeq = 0;
      }
    });
  }

  // ===== SEED BEST COMPETITORS (merges by ID — safe to run anytime) =====
  function seedCompetitors() {
    const seeds = [
      {
        id: 'seed_1',
        platform: 'Facebook',
        niche: 'Herbal Remedies / Soursop',
        name: 'Mother Satori',
        handle: '@MotherSatori',
        followers: '4M+',
        url: 'https://www.facebook.com/MotherSatori',
        inspiration: 'Top performer in soursop bitters niche. Uses "Comment your age if you\'re from USA 🇺🇸" as engagement hook — drives massive comment volume for algorithm. Script formula: hidden internal enemy (liver toxins) → ancient Caribbean herb solution → Comment keyword CTA. Product link always in first comment via ManyChat.',
        tags: 'soursop,bitters,liver,comment hook,USA geo-hook,ManyChat,holistic healer'
      },
      {
        id: 'seed_2',
        platform: 'Instagram',
        niche: 'Natural Supplements / Liver Cleanse',
        name: 'Melanskia',
        handle: '@melanskia',
        followers: '300K+',
        url: 'https://www.instagram.com/melanskia/',
        inspiration: 'Amish avatar AI character promoting Modern Antidote liver supplement ($50/jar). Cultural authority angle — "Amish wisdom" = trust. Hook: "Your belly isn\'t fat, it\'s industrial waste in your liver." Everyday lifestyle scenes (baking, farming) make product feel natural. Highest engagement in organic lifestyle niche.',
        tags: 'amish,liver cleanse,cultural authority,avatar,supplement,organic,lifestyle'
      },
      {
        id: 'seed_3',
        platform: 'Instagram',
        niche: 'Natural Health / Amish Wisdom',
        name: 'Nina Yoder',
        handle: '@nina_yoder_33',
        followers: '100K+',
        url: 'https://www.instagram.com/nina_yoder_33/reels/',
        inspiration: 'Amish wisdom angle for herbal remedies. Highly shareable "ancient secret" framing. Targets 35-55 women who distrust mainstream medicine. Save-bait recipe content works well — viewers save for later, which signals algorithm.',
        tags: 'amish,herbal,natural remedy,save bait,recipe,women 35-55'
      },
      {
        id: 'seed_4',
        platform: 'Instagram',
        niche: 'Health & Wellness / Holistic',
        name: 'Maelin Health',
        handle: '@maelin.health',
        followers: 'Growing',
        url: 'https://www.instagram.com/maelin.health/reels/',
        inspiration: 'Health & wellness reels format. Study their reel structure and posting frequency. Good reference for clean talking-head health content format on Instagram.',
        tags: 'health,wellness,reels,holistic,instagram'
      },
      {
        id: 'seed_5',
        platform: 'Instagram',
        niche: 'Chinese Medicine / TCM',
        name: 'Chen Chinese Med',
        handle: '@chen.chinesemed',
        followers: 'Growing',
        url: 'https://www.instagram.com/chen.chinesemed/',
        inspiration: 'TCM (Traditional Chinese Medicine) authority angle. Cultural expertise = instant credibility. Study how they frame ancient remedies for modern problems. Similar to Halmoni character — cultural knowledge as the trust mechanism.',
        tags: 'TCM,chinese medicine,cultural authority,ancient remedy,herbal'
      },
      {
        id: 'seed_6',
        platform: 'Instagram',
        niche: 'Chinese Medicine / Acupuncture',
        name: 'ChenTao Med',
        handle: '@chentaomed',
        followers: 'Growing',
        url: 'https://www.instagram.com/chentaomed/reels/',
        inspiration: 'Another strong TCM content creator. Watch their reels for format ideas — how they explain body systems (liver, kidney, gut) in simple visual ways. Their "ancient cure for modern problem" framing is directly replicable for soursop/bitters content.',
        tags: 'TCM,acupuncture,liver,gut,body systems,ancient cure'
      },
      {
        id: 'seed_7',
        platform: 'Instagram',
        niche: 'Beauty / Skincare',
        name: 'Camille Rochester',
        handle: '@camillerochester',
        followers: 'Growing',
        url: 'https://www.instagram.com/camillerochester/',
        inspiration: 'Skincare and beauty content creator. Good reference for brightening content format, recipe reveals, and "before/after" style hooks. Study her audience engagement tactics and caption style for the brightening recipe niche.',
        tags: 'skincare,brightening,beauty,before after,recipe reveal'
      },
      {
        id: 'seed_8',
        platform: 'Instagram',
        niche: 'Health / Educational',
        name: 'Sawyer Educational',
        handle: '@sawyer.educational',
        followers: 'Growing',
        url: 'https://www.instagram.com/sawyer.educational/',
        inspiration: 'Educational health content format. Study how they make complex health info simple and shareable. "Did you know?" hook style. Strong save-bait content — educational content gets saved more than entertainment.',
        tags: 'educational,health,did you know,save bait,science hook'
      },
      {
        id: 'seed_9',
        platform: 'Facebook',
        niche: 'Herbal Remedies / Health',
        name: 'FB Avatar Health Page 1',
        handle: 'ID: 61588469780414',
        followers: 'Growing',
        url: 'https://www.facebook.com/profile.php?id=61588469780414',
        inspiration: 'Part of a cluster of Facebook AI-avatar health pages in the same niche. Monitor for posting frequency, what hooks they test, and which videos get the most shares. These pages often A/B test hooks rapidly — what gets shares reveals what resonates.',
        tags: 'facebook,avatar,health,herbal,A/B test'
      },
      {
        id: 'seed_10', platform: 'Facebook', niche: 'Holistic Health / Herbal',
        name: 'FB Avatar Health Page 2', handle: 'ID: 61578514026499', followers: 'Growing',
        url: 'https://www.facebook.com/profile.php?id=61578514026499',
        inspiration: 'Second Facebook avatar health page from competitor cluster. Compare posting strategy with other pages in cluster to spot their winning content patterns.',
        tags: 'facebook,avatar,holistic,herbal,cluster'
      },
      { id:'seed_11', platform:'Facebook', niche:'Health Avatar / Herbal', name:'FB Health Avatar C', handle:'ID: 61582083664733', followers:'Growing', url:'https://www.facebook.com/profile.php?id=61582083664733&sk=reels_tab', inspiration:'Monitor reel frequency and hook styles being tested. Track which videos get the most shares to spot winning content this week.', tags:'facebook,avatar,health,herbal,reels,cluster' },
      { id:'seed_12', platform:'Facebook', niche:'Health Avatar / Herbal', name:'FB Health Avatar D', handle:'ID: 61576513903123', followers:'Growing', url:'https://www.facebook.com/profile.php?id=61576513903123&sk=reels_tab', inspiration:'Compare hook styles across this cluster — liver, gut, inflammation, skin — to identify which angle is getting traction right now.', tags:'facebook,avatar,health,herbal,hook testing' },
      { id:'seed_13', platform:'Facebook', niche:'Health Avatar / Herbal', name:'FB Health Avatar E', handle:'ID: 61581571332748', followers:'Growing', url:'https://www.facebook.com/profile.php?id=61581571332748&sk=reels_tab', inspiration:'Watch for new product angles or character styles being tested. Note which persona is getting the most engagement.', tags:'facebook,avatar,health,persona,character,cluster' },
      { id:'seed_14', platform:'Facebook', niche:'Health Avatar / Herbal', name:'FB Health Avatar F', handle:'ID: 61588168746896', followers:'Growing', url:'https://www.facebook.com/profile.php?id=61588168746896&sk=reels_tab', inspiration:'Track CTA style — comment keyword vs link in bio vs direct product link. Whichever dominates is what the algorithm is rewarding.', tags:'facebook,avatar,health,CTA,comment keyword' },
      { id:'seed_15', platform:'Facebook', niche:'Health Avatar / Herbal', name:'FB Health Avatar G', handle:'ID: 61574374395353', followers:'Growing', url:'https://www.facebook.com/profile.php?id=61574374395353&sk=reels_tab', inspiration:'Monitor script formula variations — especially first 3 seconds. The hook is the most A/B-tested element across these pages.', tags:'facebook,avatar,health,hook,script,3 seconds' },
      { id:'seed_16', platform:'Facebook', niche:'Health Avatar / Herbal', name:'FB Health Avatar H', handle:'ID: 61569217314654', followers:'Growing', url:'https://www.facebook.com/profile.php?id=61569217314654&sk=reels_tab', inspiration:'One of the older pages — check if they have higher follower counts, which signals their content formula has been validated longer.', tags:'facebook,avatar,health,established,follower growth' },
      { id:'seed_17', platform:'Facebook', niche:'Health Avatar / Herbal', name:'FB Health Avatar I', handle:'ID: 61579542250184', followers:'Growing', url:'https://www.facebook.com/profile.php?id=61579542250184&sk=reels_tab', inspiration:'Compare niche focus vs others — targeting women specifically, or broader? Audience targeting affects which hooks they use.', tags:'facebook,avatar,health,women,audience,targeting' },
      { id:'seed_18', platform:'Facebook', niche:'Health Avatar / Herbal', name:'FB Health Avatar J', handle:'ID: 61555941464895', followers:'Growing', url:'https://www.facebook.com/profile.php?id=61555941464895&sk=reels_tab', inspiration:'Earliest created page in cluster (lowest ID). Study their full video library for what worked at the start vs what they post now — shows the evolution of the niche.', tags:'facebook,avatar,health,established,early,evolution' },
      { id:'seed_19', platform:'Facebook', niche:'Health Avatar / Herbal', name:'FB Health Avatar K', handle:'ID: 61585093851657', followers:'Growing', url:'https://www.facebook.com/profile.php?id=61585093851657&sk=reels_tab', inspiration:'Watch video length patterns — 30-second quick hooks or 60-90 second full scripts? Length preference reveals what FB algorithm rewards in this niche.', tags:'facebook,avatar,health,video length,algorithm,format' },
      { id:'seed_20', platform:'Facebook', niche:'Health Avatar / Herbal', name:'FB Health Avatar L', handle:'ID: 100084707749976', followers:'Growing', url:'https://www.facebook.com/profile.php?id=100084707749976&sk=reels_tab', inspiration:'Different-style ID — may be older/differently structured account. Compare content format to newer avatar pages. Could indicate a strategy pivot.', tags:'facebook,health,legacy,format,comparison' },
      { id:'seed_21', platform:'Facebook', niche:'Health Avatar / Herbal', name:'FB Health Avatar M', handle:'ID: 61587814272619', followers:'Growing', url:'https://www.facebook.com/profile.php?id=61587814272619&sk=reels_tab', inspiration:'Monitor caption style — heavy hashtags, keyword-rich captions, or minimal text? Caption strategy on Facebook reels directly affects organic reach.', tags:'facebook,avatar,health,caption,hashtags,reach' },
      { id:'seed_22', platform:'Facebook', niche:'Health Avatar / Herbal', name:'FB Health Avatar N', handle:'ID: 61578823245402', followers:'Growing', url:'https://www.facebook.com/profile.php?id=61578823245402&sk=reels_tab', inspiration:'Study their thumbnail/cover frame — the first frame of a Facebook reel acts as the thumbnail. What they show in frame 1 is deliberate. Copy the thumbnail strategy.', tags:'facebook,avatar,health,thumbnail,first frame,visual hook' },
      { id:'seed_23', platform:'Facebook', niche:'Health Avatar / Herbal', name:'FB Health Avatar O', handle:'ID: 61585581172941', followers:'Growing', url:'https://www.facebook.com/profile.php?id=61585581172941&sk=reels_tab', inspiration:'Note posting schedule — these cluster pages often post 2-3x per day. Volume + consistency is part of the growth model alongside hook quality.', tags:'facebook,avatar,health,posting schedule,frequency,volume' },
      { id:'seed_24', platform:'Facebook', niche:'Health Avatar / Herbal', name:'FB Health Avatar P', handle:'ID: 61579553879577', followers:'Growing', url:'https://www.facebook.com/profile.php?id=61579553879577&sk=reels_tab', inspiration:'Check their comment section — what questions do viewers ask most? Those questions are your next video topics. Comments reveal exact audience language for pain points.', tags:'facebook,avatar,health,comments,audience research,pain points' },
      { id:'seed_25', platform:'Facebook', niche:'Health Avatar / Herbal', name:'FB Health Avatar Q', handle:'ID: 61573479115488', followers:'Growing', url:'https://www.facebook.com/profile.php?id=61573479115488&sk=reels_tab', inspiration:'Look for their pinned video — pinned content is always their top performer or best sales video. Start your research analysis there.', tags:'facebook,avatar,health,pinned,top performer,sales video' },
      { id:'seed_26', platform:'Facebook', niche:'Health Avatar / Herbal', name:'FB Health Avatar R', handle:'ID: 61587268836199', followers:'Growing', url:'https://www.facebook.com/profile.php?id=61587268836199&sk=reels_tab', inspiration:'Monitor which products they pivot to — if they switch from soursop to a new product, it signals the old is saturating and a new one is converting better.', tags:'facebook,avatar,health,product pivot,saturation,conversion' },
      { id:'seed_27', platform:'Facebook', niche:'Health Avatar / Herbal', name:'FB Health Avatar S', handle:'ID: 61586276835161', followers:'Growing', url:'https://www.facebook.com/profile.php?id=61586276835161&sk=reels_tab', inspiration:'Compare engagement rate (likes+comments÷views) vs others in cluster. High engagement = strong hook + strong script. Low rate = weak hook despite high reach.', tags:'facebook,avatar,health,engagement rate,hook quality,script' },
      { id:'seed_28', platform:'Facebook', niche:'Beauty / Korean Skincare', name:'Imani Kim Beauty', handle:'@imani.kim.beauty', followers:'Growing', url:'https://www.facebook.com/imani.kim.beauty/reels/', inspiration:'Korean skincare content for Black and multicultural audiences on Facebook. Study how she frames Korean beauty secrets for brightening. Directly relevant to your dark inner thigh and armpit brightening content.', tags:'beauty,korean,skincare,brightening,facebook,multicultural,Black women' },
      { id:'seed_29', platform:'Facebook', niche:'Health / Medical Authority', name:'Dr. Marlon Campbell', handle:'@Drmarloncampbell', followers:'Growing', url:'https://www.facebook.com/Drmarloncampbell/reels/', inspiration:'Medical doctor using Facebook reels. Study how he uses authority to make health claims feel credible. His 60-second body system explainer format (liver, inflammation, gut) is the benchmark for your Mama Cerasee and Jupi content.', tags:'doctor,medical authority,health,liver,gut,credibility,script structure' },
      { id:'seed_30', platform:'Facebook', niche:'Herbal Remedies / Natural Health', name:"Kim's Remedy", handle:'@kimsremedy68', followers:'Growing', url:'https://www.facebook.com/kimsremedy68/reels/', inspiration:'Herbal and natural remedy content — almost identical space to your soursop bitters and brightening content. Study their hook style, product presentation, and CTA format closely.', tags:'herbal,remedy,natural,facebook,soursop,bitters,CTA' },
      { id:'seed_31', platform:'Instagram', niche:"Korean Beauty / Men's Health", name:'Justin Gwang', handle:'@justin.gwang', followers:'Growing', url:'https://www.instagram.com/justin.gwang/reels/', inspiration:'Korean male health and wellness creator. Study how he frames Korean health secrets for men — directly applicable to your Rastafarian man and Jupi hydration content.', tags:'korean,male,health,wellness,reels,authority,mens health' },
      { id:'seed_32', platform:'Instagram', niche:'Skincare / Beauty', name:'Skincare by Serena', handle:'@skincarebyserena_', followers:'Growing', url:'https://www.instagram.com/skincarebyserena_/reels/', inspiration:'Recipe reveal format, ingredient breakdowns, before/after hooks. Her 60-second ingredient explainer structure is the template for your brightening recipe series.', tags:'skincare,beauty,recipe,ingredients,before after,brightening' },
      { id:'seed_33', platform:'Instagram', niche:'Korean Health / Grandmother Character', name:'Grandma Jiwon', handle:'@grandma.jiwon', followers:'Growing', url:'https://www.instagram.com/grandma.jiwon/reels/', inspiration:'⭐ HIGH PRIORITY — Korean grandmother character, identical to your Halmoni. Study every reel. How does she frame advice? What body problems does she target? What products does she link? This is your closest reference for Halmoni content.', tags:'korean,grandmother,halmoni,character,health,beauty,HIGH PRIORITY' },
      { id:'seed_34', platform:'Instagram', niche:'Korean Mom / Beauty Tips', name:'My Korean Mom Tips', handle:'@mykoreanmom.tips', followers:'Growing', url:'https://www.instagram.com/mykoreanmom.tips/reels/', inspiration:'⭐ HIGH PRIORITY — Korean mom character sharing beauty and health tips. Direct reference for Halmoni content. Study hook style, body problems targeted (skin, weight, aging), and how she delivers the cultural authority angle.', tags:'korean,mom,beauty,health,tips,halmoni,cultural,HIGH PRIORITY' },
      { id:'seed_35', platform:'Instagram', niche:'Holistic Wellness', name:"Katie's Holistic Wellness", handle:'@katiesholisticwellness', followers:'Growing', url:'https://www.instagram.com/katiesholisticwellness/reels/', inspiration:'Warm, educational, non-pushy tone for natural remedies. Her script structure for presenting supplements without feeling salesy is a great tone reference for all your characters.', tags:'holistic,wellness,natural,remedy,educational,warm tone,supplements' },
      { id:'seed_36', platform:'Instagram', niche:'Korean Mom / Health Beauty', name:'Korean Mom Official', handle:'@korean.mom.official', followers:'Growing', url:'https://www.instagram.com/korean.mom.official/reels/', inspiration:'⭐ HIGH PRIORITY — Compare vs @grandma.jiwon and @mykoreanmom.tips. Which Korean character style gets the best engagement? Use all three to nail your Halmoni character.', tags:'korean,mom,character,health,beauty,comparison,halmoni,HIGH PRIORITY' },
      { id:'seed_37', platform:'Instagram', niche:'Medical / Holistic MD', name:'Victoria Vane MD', handle:'@victoriavanemd', followers:'Growing', url:'https://www.instagram.com/victoriavanemd/reels/', inspiration:'MD who also endorses natural solutions — the exact credibility balance your Mama Cerasee content needs. Study how she blends medical authority with herbal recommendations to build maximum trust.', tags:'doctor,MD,holistic,medical,credibility,natural,instagram,authority' }
    ];
    const existingIds = new Set(competitors.map(c => c.id));
    const newSeeds = seeds.filter(s => !existingIds.has(s.id));
    if (newSeeds.length === 0) return;
    competitors = [...competitors, ...newSeeds];
    saveCompetitors();
  }

  function seedMyAccounts() {
    const seeds = [
      { id: 'my_1', platform: 'Facebook', status: 'Active', username: 'Rosabella Electrolyte', email: '', password: '', url: 'https://www.facebook.com/profile.php?id=61589406122683', tags: 'electrolytes,hydration,watermelon,sugar-free', notes: '🛒 Rosabella Electrolyte Drink Powder (Watermelon) — Sugar-free, Himalayan pink salt, potassium, magnesium, calcium, Vitamin C & B12' },
      { id: 'my_2', platform: 'Facebook', status: 'Active', username: 'Serene Herbs Soursop', email: '', password: '', url: 'https://www.facebook.com/profile.php?id=61588709376350', tags: 'soursop,detox,gut cleanse,liver,bitters', notes: '🛒 Serene Herbs Soursop Bitters Liquid — #1 Best Seller Detox, soursop, black seed, moringa, Irish moss, ashwagandha, turmeric' },
      { id: 'my_3', platform: 'Facebook', status: 'Active', username: 'Soursop Bitters (Page 2)', email: '', password: '', url: 'https://www.facebook.com/profile.php?id=61589390343621', tags: 'soursop,detox,gut cleanse,liver,bitters', notes: '🛒 Serene Herbs Soursop Bitters Liquid — secondary page. Same product as Page 1.' },
      { id: 'my_4', platform: 'Facebook', status: 'Active', username: 'QUIA Toner Pads', email: '', password: '', url: 'https://www.facebook.com/profile.php?id=61589172641448', tags: 'AHA BHA,exfoliation,blackheads,korean skincare,pores', notes: '🛒 QUIA AHA/BHA Toner Pads — Dual-action exfoliation, 70 pads, clinically proven 3X gentler, reduces blackheads' },
      { id: 'my_5', platform: 'Facebook', status: 'Active', username: 'JiYu Toner Pads', email: '', password: '', url: 'https://www.facebook.com/profile.php?id=61589045653924', tags: 'dark spots,snail mucin,niacinamide,korean skincare,brightening', notes: '🛒 JiYu Toning Polish Pads — Dark spots, wrinkles, snail mucin, niacinamide, peptides, centella, alpha-arbutin, 100 pads' },
      { id: 'my_6', platform: 'Facebook', status: 'Active', username: 'Pura Vida Moringa', email: '', password: '', url: 'https://www.facebook.com/profile.php?id=61589202695239', tags: 'moringa,energy,metabolism,immune,organic,detox', notes: '🛒 Pura Vida Moringa Capsules — #1 Moringa, single-origin organic, 120ct, 500mg, energy + metabolism + immune support' },
    ];
    let changed = false;
    seeds.forEach(seed => {
      const idx = accounts.findIndex(a => a.id === seed.id);
      if (idx === -1) {
        accounts.push(seed);
        changed = true;
      } else if (!accounts[idx].userEdited) {
        // Only sync seed fields if the user has not manually edited this account
        accounts[idx].username = seed.username;
        accounts[idx].url      = seed.url;
        accounts[idx].tags     = seed.tags;
        accounts[idx].notes    = seed.notes;
        changed = true;
      }
    });
    if (changed) saveAccounts();
  }
