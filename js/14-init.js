  // ========================================================
  // ===== FEATURE PANELS — Product Vault, Hook Bank, =====
  // ===== CTA Library, Performance Log, Recycler, Ideas =====
  // ========================================================

  // ---------- Utility ----------
  function _uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2); }
  function _escHtml(s) { if (!s) return ''; return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function _showCopied(btn, text) {
    const orig = btn.textContent;
    btn.textContent = text || '✅ Copied!';
    setTimeout(() => { btn.textContent = orig; }, 2000);
  }

  // ============================================================
  // FEATURE 1: PRODUCT VAULT
  // ============================================================
  let products = [];

  async function loadProducts() {
    try { products = _safeJSON(await DB.get('sm_products'), []); } catch(e) { products = []; showToast('Could not load Product Vault.', 'error'); }
    renderProductVault();
    // Hook/CTA product dropdowns are built from the products list — refresh them
    // in case products finished loading after those sections first rendered.
    if (typeof renderHookBank === 'function') renderHookBank();
    if (typeof renderCTALibrary === 'function') renderCTALibrary();
  }

  function saveProducts() { DB.set('sm_products', JSON.stringify(products)).catch(e => console.warn('saveProducts error:', e)); }

  function renderProductVault() {
    const search = (document.getElementById('pvSearch') ? document.getElementById('pvSearch').value : '').toLowerCase();
    const niche = document.getElementById('pvFilterNiche') ? document.getElementById('pvFilterNiche').value : '';

    // Refresh niche dropdown
    const nicheEl = document.getElementById('pvFilterNiche');
    if (nicheEl) {
      const current = nicheEl.value;
      const niches = [...new Set(products.map(p => p.niche).filter(Boolean))].sort();
      nicheEl.innerHTML = '<option value="">All Niches</option>' + niches.map(n => `<option value="${_escHtml(n)}" ${n === current ? 'selected' : ''}>${_escHtml(n)}</option>`).join('');
    }

    const filtered = products.filter(p => {
      const matchSearch = !search || (p.name||'').toLowerCase().includes(search) || (p.brand||'').toLowerCase().includes(search) || (p.niche||'').toLowerCase().includes(search);
      const matchNiche = !niche || p.niche === niche;
      return matchSearch && matchNiche;
    });

    const grid = document.getElementById('pvGrid');
    if (!grid) return;

    if (filtered.length === 0) {
      grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;color:var(--text-3);padding:40px 0;font-size:13px;">${products.length === 0 ? 'No products yet. Click <strong>+ Add Product</strong> to get started.' : 'No products match your search.'}</div>`;
      return;
    }

    const platEmoji = { TikTok: '🎵', Instagram: '📸', Facebook: '👥', YouTube: '▶️', Other: '🌐' };

    grid.innerHTML = filtered.map(p => {
      const plats = (p.platforms || []).map(pl => `<span title="${_escHtml(pl)}">${platEmoji[pl] || '🌐'}</span>`).join(' ');
      return `<div class="pv-card">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;">
          <div>
            <div class="pv-card-title">${_escHtml(p.name)}</div>
            ${p.brand ? `<div class="pv-card-sub">${_escHtml(p.brand)}</div>` : ''}
          </div>
          <div style="display:flex;gap:4px;flex-shrink:0;">
            <button class="btn-sm" data-pid="${p.id}" onclick="openProductModal(this.dataset.pid)">✏️</button>
            <button class="btn-sm danger" data-pid="${p.id}" onclick="deleteProduct(this.dataset.pid)">🗑</button>
          </div>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;">
          ${p.niche ? `<span class="badge-niche">${_escHtml(p.niche)}</span>` : ''}
          ${plats ? `<span style="font-size:14px;">${plats}</span>` : ''}
          <span class="badge-count">${p.clickCount || 0} clicks</span>
        </div>
        ${p.notes ? `<div style="font-size:12px;color:var(--text-2);line-height:1.5;">${_escHtml(p.notes.slice(0,100))}${p.notes.length>100?'…':''}</div>` : ''}
        <div style="margin-top:4px;">
          <div style="font-size:11px;color:var(--text-3);margin-bottom:4px;">Affiliate URL:</div>
          <span class="url-blur" id="pv-url-${p.id}" onclick="this.classList.toggle('revealed')" title="Click to reveal">${_escHtml(p.url)}</span>
        </div>
        <div class="pv-card-actions">
          <button class="btn-sm" data-pid="${p.id}" onclick="copyProductLink(this.dataset.pid, this)">📋 Copy Link</button>
        </div>
      </div>`;
    }).join('');
  }

  function openProductModal(id) {
    const modal = document.getElementById('productModal');
    const titleEl = document.getElementById('productModalTitle');
    if (titleEl) titleEl.textContent = id ? 'Edit Product' : 'Add Product';
    const pmEditIdEl = document.getElementById('pmEditId');
    if (pmEditIdEl) pmEditIdEl.value = id || '';
    document.querySelectorAll('[name="pmPlat"]').forEach(cb => cb.checked = false);

    if (id) {
      const p = products.find(x => x.id === id);
      if (!p) return;
      const pmNameEl = document.getElementById('pmName');
      if (pmNameEl) pmNameEl.value = p.name || '';
      const pmBrandEl = document.getElementById('pmBrand');
      if (pmBrandEl) pmBrandEl.value = p.brand || '';
      const pmUrlEl = document.getElementById('pmUrl');
      if (pmUrlEl) pmUrlEl.value = p.url || '';
      const pmNicheEl = document.getElementById('pmNiche');
      if (pmNicheEl) pmNicheEl.value = p.niche || '';
      const pmNotesEl = document.getElementById('pmNotes');
      if (pmNotesEl) pmNotesEl.value = p.notes || '';
      (p.platforms || []).forEach(pl => {
        const cb = document.querySelector(`[name="pmPlat"][value="${pl}"]`);
        if (cb) cb.checked = true;
      });
    } else {
      const pmNameEl = document.getElementById('pmName');
      if (pmNameEl) pmNameEl.value = '';
      const pmBrandEl = document.getElementById('pmBrand');
      if (pmBrandEl) pmBrandEl.value = '';
      const pmUrlEl = document.getElementById('pmUrl');
      if (pmUrlEl) pmUrlEl.value = '';
      const pmNicheEl = document.getElementById('pmNiche');
      if (pmNicheEl) pmNicheEl.value = '';
      const pmNotesEl = document.getElementById('pmNotes');
      if (pmNotesEl) pmNotesEl.value = '';
    }
    if (modal) modal.classList.add('open');
  }

  function closeProductModal() { const _m = document.getElementById('productModal'); if (_m) _m.classList.remove('open'); }

  function saveProductModal() {
    const pmNameEl = document.getElementById('pmName');
    if (!pmNameEl) { showToast('Product name field not found.', 'warning'); return; }
    const name = pmNameEl.value.trim();
    const url = document.getElementById('pmUrl')?.value.trim() || '';
    if (!name) { showToast('Product name is required.', 'warning'); return; }
    if (!url) { showToast('Affiliate URL is required.', 'warning'); return; }
    const platforms = [...document.querySelectorAll('[name="pmPlat"]:checked')].map(cb => cb.value);
    const id = document.getElementById('pmEditId')?.value || '';
    if (id) {
      const p = products.find(x => x.id === id);
      if (p) {
        p.name = name;
        p.brand = document.getElementById('pmBrand')?.value.trim() || '';
        p.url = url;
        p.niche = document.getElementById('pmNiche')?.value.trim() || '';
        p.platforms = platforms;
        p.notes = document.getElementById('pmNotes')?.value.trim() || '';
      }
    } else {
      products.push({ id: _uid(), name, brand: document.getElementById('pmBrand')?.value.trim() || '', url, niche: document.getElementById('pmNiche')?.value.trim() || '', platforms, notes: document.getElementById('pmNotes')?.value.trim() || '', clickCount: 0, createdAt: Date.now() });
    }
    saveProducts();
    closeProductModal();
    renderProductVault();
  }

  function deleteProduct(id) {
    showConfirm('Delete this product?', () => {
      products = products.filter(p => p.id !== id);
      saveProducts();
      renderProductVault();
    });
  }

  function copyProductLink(id, btn) {
    const p = products.find(x => x.id === id);
    if (!p) return;
    navigator.clipboard.writeText(p.url).then(() => {
      p.clickCount = (p.clickCount || 0) + 1;
      saveProducts();
      _showCopied(btn, '✅ Copied!');
      renderProductVault();
    }).catch(() => showToast('Copy failed — check browser permissions.', 'warning'));
  }

  // ============================================================
  // FEATURE 2: HOOK BANK
  // ============================================================
  let hooks = [];

  const DEFAULT_HOOKS = [
    "Stop scrolling — this changed everything for me",
    "I tried this for 30 days. Here's what happened.",
    "Nobody talks about this, but you need to know",
    "The reason you're not seeing results (it's not what you think)",
    "I wish I knew this before I started"
  ];

  async function loadHooks() {
    try { hooks = _safeJSON(await DB.get('sm_hooks'), []); } catch(e) { hooks = []; showToast('Could not load Hook Bank.', 'error'); }
    // Purge any pre-seeded sample entries
    const before = hooks.length;
    hooks = hooks.filter(h => h.source !== 'Sample');
    if (hooks.length !== before) saveHooks();
    // Seed example hooks on first load (before any user hooks exist)
    if (hooks.length === 0 && !localStorage.getItem('aos_hooks_seeded_v1')) {
      hooks = DEFAULT_HOOKS.map((text, i) => ({ id: 'default_hook_' + i, text, category: 'Template', source: 'Example', copyCount: 0 }));
      saveHooks();
      localStorage.setItem('aos_hooks_seeded_v1', '1');
    }
    renderHookBank();
  }

  function saveHooks() { DB.set('sm_hooks', JSON.stringify(hooks)).catch(e => console.warn('saveHooks error:', e)); }

  // --- Shared: build <option> list of product names for hook/CTA dropdowns ---
  // Hooks and CTAs store the product as a plain name label, so a deleted
  // product still keeps its label on existing items.
  function _productLabelOptions(selected, allLabel) {
    const names = [...new Set((products || []).map(p => p.name).filter(Boolean))].sort();
    let opts = `<option value="">${allLabel || '— Any product —'}</option>`;
    opts += names.map(n => `<option value="${_escHtml(n)}" ${n === selected ? 'selected' : ''}>${_escHtml(n)}</option>`).join('');
    // Keep a selected-but-removed product still visible/selectable
    if (selected && !names.includes(selected)) {
      opts += `<option value="${_escHtml(selected)}" selected>${_escHtml(selected)} (removed)</option>`;
    }
    return opts;
  }

  function renderHookBank() {
    const search = (document.getElementById('hbSearch') ? document.getElementById('hbSearch').value : '').toLowerCase();
    const cat = document.getElementById('hbFilterCat') ? document.getElementById('hbFilterCat').value : '';
    const prodFilter = document.getElementById('hbFilterProduct') ? document.getElementById('hbFilterProduct').value : '';

    // Refresh category dropdown
    const catEl = document.getElementById('hbFilterCat');
    if (catEl) {
      const cur = catEl.value;
      const cats = [...new Set(hooks.map(h => h.category).filter(Boolean))].sort();
      catEl.innerHTML = '<option value="">All Categories</option>' + cats.map(c => `<option value="${_escHtml(c)}" ${c === cur ? 'selected' : ''}>${_escHtml(c)}</option>`).join('');
    }

    // Refresh product dropdown
    const prodEl = document.getElementById('hbFilterProduct');
    if (prodEl) {
      const cur = prodEl.value;
      prodEl.innerHTML = _productLabelOptions(cur, 'All Products');
    }

    const filtered = hooks.filter(h => {
      const matchS = !search || (h.text||'').toLowerCase().includes(search) || (h.category||'').toLowerCase().includes(search);
      const matchC = !cat || h.category === cat;
      const matchP = !prodFilter || h.product === prodFilter;
      return matchS && matchC && matchP;
    });

    const list = document.getElementById('hbList');
    if (!list) return;

    if (filtered.length === 0) {
      list.innerHTML = `<div style="text-align:center;color:var(--text-3);padding:40px 20px;font-size:13px;line-height:1.6;">${hooks.length === 0 ? '🎣 Your Hook Bank is empty.<br>Click <strong>+ Add Hook</strong> to save your first opening line.' : 'No hooks match your search.'}</div>`;
      return;
    }

    list.innerHTML = filtered.map(h => `<div class="hook-card">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;">
        <div style="flex:1;">
          <div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:6px;">
            ${h.category ? `<span class="badge-type" style="display:inline-block;">${_escHtml(h.category)}</span>` : ''}
            ${h.product ? `<span class="badge-niche" style="display:inline-block;" title="Product">🏷 ${_escHtml(h.product)}</span>` : ''}
          </div>
          <div style="font-size:13px;color:var(--text-1);line-height:1.55;">${_escHtml(h.text)}</div>
        </div>
        <div style="display:flex;gap:4px;flex-shrink:0;">
          <button class="btn-sm" onclick="openHookModal(${JSON.stringify(h.id)})">✏️</button>
          <button class="btn-sm danger" onclick="deleteHook(${JSON.stringify(h.id)})">🗑</button>
        </div>
      </div>
      <div class="pv-card-actions">
        <button class="btn-sm" onclick="copyHook(${JSON.stringify(h.id)},this)">📋 Copy</button>
        <span class="badge-count">${h.copyCount || 0} copies</span>
        ${h.source ? `<span style="font-size:11px;color:var(--text-3);">📌 ${_escHtml(h.source)}</span>` : ''}
        <button data-hid="${_escHtml(h.id)}" onclick="_pushHookToStudio(this,'producer')" title="Send hook to Video Producer" style="padding:2px 9px;font-size:10px;background:var(--accent-glow-sm);border:1px solid var(--accent);border-radius:3px;color:var(--accent-2);cursor:pointer;font-weight:600;margin-left:auto;">→ Producer</button>
        <button data-hid="${_escHtml(h.id)}" onclick="_pushHookToStudio(this,'replicator')" title="Send hook to Video Replicator" style="padding:2px 9px;font-size:10px;background:rgba(251,191,36,0.08);border:1px solid rgba(251,191,36,0.3);border-radius:3px;color:var(--warning);cursor:pointer;font-weight:600;">→ Replicator</button>
      </div>
    </div>`).join('');
  }

  function openHookModal(id) {
    const modal = document.getElementById('hookModal');
    if (!modal) return;
    const hmEditIdEl = document.getElementById('hmEditId');
    if (hmEditIdEl) hmEditIdEl.value = id || '';
    const hookModalTitleEl = document.getElementById('hookModalTitle');
    if (hookModalTitleEl) hookModalTitleEl.textContent = id ? 'Edit Hook' : 'Add Hook';
    if (id) {
      const h = hooks.find(x => x.id === id);
      if (!h) return;
      const hmTextEl = document.getElementById('hmText');
      if (hmTextEl) hmTextEl.value = h.text || '';
      const hmCategoryEl = document.getElementById('hmCategory');
      if (hmCategoryEl) hmCategoryEl.value = h.category || '';
      const hmProductEl = document.getElementById('hmProduct');
      if (hmProductEl) hmProductEl.innerHTML = _productLabelOptions(h.product || '');
      const hmSourceEl = document.getElementById('hmSource');
      if (hmSourceEl) hmSourceEl.value = h.source || '';
      const hmNotesEl = document.getElementById('hmNotes');
      if (hmNotesEl) hmNotesEl.value = h.notes || '';
    } else {
      const hmTextEl = document.getElementById('hmText');
      if (hmTextEl) hmTextEl.value = '';
      const hmCategoryEl = document.getElementById('hmCategory');
      if (hmCategoryEl) hmCategoryEl.value = '';
      const hmProductEl = document.getElementById('hmProduct');
      if (hmProductEl) hmProductEl.innerHTML = _productLabelOptions('');
      const hmSourceEl = document.getElementById('hmSource');
      if (hmSourceEl) hmSourceEl.value = '';
      const hmNotesEl = document.getElementById('hmNotes');
      if (hmNotesEl) hmNotesEl.value = '';
    }
    if (modal) modal.classList.add('open');
  }

  function closeHookModal() { const _m = document.getElementById('hookModal'); if (_m) _m.classList.remove('open'); }

  function saveHookModal() {
    const hmTextEl = document.getElementById('hmText');
    if (!hmTextEl) { showToast('Hook text field not found.', 'warning'); return; }
    const text = hmTextEl.value.trim();
    if (!text) { showToast('Hook text is required.', 'warning'); return; }
    const id = document.getElementById('hmEditId')?.value || '';
    if (id) {
      const h = hooks.find(x => x.id === id);
      if (h) { h.text = text; h.category = document.getElementById('hmCategory')?.value || ''; h.product = document.getElementById('hmProduct')?.value || ''; h.source = document.getElementById('hmSource')?.value.trim() || ''; h.notes = document.getElementById('hmNotes')?.value.trim() || ''; }
    } else {
      hooks.push({ id: _uid(), text, category: document.getElementById('hmCategory')?.value || '', product: document.getElementById('hmProduct')?.value || '', platforms: [], source: document.getElementById('hmSource')?.value.trim() || '', notes: document.getElementById('hmNotes')?.value.trim() || '', copyCount: 0, createdAt: Date.now() });
    }
    saveHooks();
    closeHookModal();
    renderHookBank();
  }

  function deleteHook(id) {
    showConfirm('Delete this hook?', () => {
      hooks = hooks.filter(h => h.id !== id);
      saveHooks();
      renderHookBank();
    });
  }

  function copyHook(id, btn) {
    const h = hooks.find(x => x.id === id);
    if (!h) return;
    navigator.clipboard.writeText(h.text).then(() => {
      h.copyCount = (h.copyCount || 0) + 1;
      saveHooks();
      _showCopied(btn, '✅ Copied!');
      setTimeout(() => renderHookBank(), 2100);
    }).catch(() => showToast('Copy failed — check browser permissions.', 'warning'));
  }

  // ============================================================
  // FEATURE 3: CTA LIBRARY
  // ============================================================
  let ctas = [];

  const DEFAULT_CTAS = [
    { text: "Link in bio to grab yours", type: "soft" },
    { text: "Comment 'INFO' and I'll send you the link", type: "engagement" },
    { text: "Swipe up to get the deal before it expires", type: "urgency" },
    { text: "Try it free for 1 day — link in bio", type: "trial" }
  ];

  async function loadCTALibrary() {
    try {
      // One-time wipe of seeded sample data.
      // Write the localStorage flag AFTER DB.set succeeds but in its own try/catch
      // so a quota error on localStorage doesn't leave the flag unset and trigger
      // a repeat wipe on the next load (which would erase user-added CTAs).
      if (!localStorage.getItem('aos_ctas_cleared_v1')) {
        const existing = _safeJSON(await DB.get('sm_ctas'), []);
        const filtered = existing.filter(c => c.source !== 'Sample');
        if (filtered.length !== existing.length) {
          await DB.set('sm_ctas', JSON.stringify(filtered));
        }
        try { localStorage.setItem('aos_ctas_cleared_v1', '1'); } catch(_) {}
        ctas = filtered;
        if (ctas.length === 0 && !localStorage.getItem('aos_ctas_seeded_v1')) {
          ctas = DEFAULT_CTAS.map(c => ({ ...c, id: _uid() }));
          saveCTALibrary();
          localStorage.setItem('aos_ctas_seeded_v1', '1');
        }
        renderCTALibrary();
        return;
      }
      ctas = _safeJSON(await DB.get('sm_ctas'), []);
      const _beforeLen = ctas.length;
      ctas = ctas.filter(c => c.source !== 'Sample');
      if (ctas.length !== _beforeLen) saveCTALibrary();
    } catch(e) { ctas = []; showToast('Could not load CTA Library.', 'error'); }
    // Seed example CTAs on first load (before any user CTAs exist)
    if (ctas.length === 0 && !localStorage.getItem('aos_ctas_seeded_v1')) {
      ctas = DEFAULT_CTAS.map((c, i) => ({ id: 'default_cta_' + i, text: c.text, type: c.type, source: 'Example', copyCount: 0 }));
      saveCTALibrary();
      localStorage.setItem('aos_ctas_seeded_v1', '1');
    }
    renderCTALibrary();
  }

  function saveCTALibrary() { DB.set('sm_ctas', JSON.stringify(ctas)).catch(e => console.warn('saveCTALibrary error:', e)); }

  function renderCTALibrary() {
    const search = (document.getElementById('ctaSearch') ? document.getElementById('ctaSearch').value : '').toLowerCase();
    const type = document.getElementById('ctaFilterType') ? document.getElementById('ctaFilterType').value : '';
    const prodFilter = document.getElementById('ctaFilterProduct') ? document.getElementById('ctaFilterProduct').value : '';

    // Refresh type dropdown
    const typeEl = document.getElementById('ctaFilterType');
    if (typeEl) {
      const cur = typeEl.value;
      const types = [...new Set(ctas.map(c => c.type).filter(Boolean))].sort();
      typeEl.innerHTML = '<option value="">All Types</option>' + types.map(t => `<option value="${_escHtml(t)}" ${t === cur ? 'selected' : ''}>${_escHtml(t)}</option>`).join('');
    }

    // Refresh product dropdown
    const prodEl = document.getElementById('ctaFilterProduct');
    if (prodEl) {
      const cur = prodEl.value;
      prodEl.innerHTML = _productLabelOptions(cur, 'All Products');
    }

    const filtered = ctas.filter(c => {
      const matchS = !search || (c.text||'').toLowerCase().includes(search) || (c.type||'').toLowerCase().includes(search);
      const matchT = !type || c.type === type;
      const matchP = !prodFilter || c.product === prodFilter;
      return matchS && matchT && matchP;
    });

    const list = document.getElementById('ctaList');
    if (!list) return;

    if (filtered.length === 0) {
      list.innerHTML = `<div style="text-align:center;color:var(--text-3);padding:40px 20px;font-size:13px;line-height:1.6;">${ctas.length === 0 ? '📢 Your CTA Library is empty.<br>Click <strong>+ Add CTA</strong> to save your first call-to-action.' : 'No CTAs match your search.'}</div>`;
      return;
    }

    list.innerHTML = filtered.map(c => `<div class="cta-card">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;">
        <div style="flex:1;">
          <div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:6px;">
            ${c.type ? `<span class="badge-type" style="display:inline-block;">${_escHtml(c.type)}</span>` : ''}
            ${c.product ? `<span class="badge-niche" style="display:inline-block;" title="Product">🏷 ${_escHtml(c.product)}</span>` : ''}
          </div>
          <div style="font-size:13px;color:var(--text-1);line-height:1.55;">${_escHtml(c.text)}</div>
        </div>
        <div style="display:flex;gap:4px;flex-shrink:0;">
          <button class="btn-sm" onclick="openCTAModal(${JSON.stringify(c.id)})">✏️</button>
          <button class="btn-sm danger" onclick="deleteCTA(${JSON.stringify(c.id)})">🗑</button>
        </div>
      </div>
      <div class="pv-card-actions">
        <button class="btn-sm" onclick="copyCTA(${JSON.stringify(c.id)},this)">📋 Copy</button>
        <span class="badge-count">${c.copyCount || 0} copies</span>
        <button data-cid="${_escHtml(c.id)}" onclick="_pushCTAToStudio(this,'producer')" title="Send CTA to Video Producer" style="padding:2px 9px;font-size:10px;background:var(--accent-glow-sm);border:1px solid var(--accent);border-radius:3px;color:var(--accent-2);cursor:pointer;font-weight:600;margin-left:auto;">→ Producer</button>
        <button data-cid="${_escHtml(c.id)}" onclick="_pushCTAToStudio(this,'replicator')" title="Send CTA to Video Replicator" style="padding:2px 9px;font-size:10px;background:rgba(251,191,36,0.08);border:1px solid rgba(251,191,36,0.3);border-radius:3px;color:var(--warning);cursor:pointer;font-weight:600;">→ Replicator</button>
      </div>
    </div>`).join('');
  }

  function openCTAModal(id) {
    const modal = document.getElementById('ctaModal');
    const ctamEditIdEl = document.getElementById('ctamEditId');
    if (ctamEditIdEl) ctamEditIdEl.value = id || '';
    const ctaModalTitleEl = document.getElementById('ctaModalTitle');
    if (ctaModalTitleEl) ctaModalTitleEl.textContent = id ? 'Edit CTA' : 'Add CTA';
    document.querySelectorAll('[name="ctamPlat"]').forEach(cb => cb.checked = false);
    if (id) {
      const c = ctas.find(x => x.id === id);
      if (!c) return;
      const ctamTextEl = document.getElementById('ctamText');
      if (ctamTextEl) ctamTextEl.value = c.text || '';
      const ctamTypeEl = document.getElementById('ctamType');
      if (ctamTypeEl) ctamTypeEl.value = c.type || '';
      const ctamProductEl = document.getElementById('ctamProduct');
      if (ctamProductEl) ctamProductEl.innerHTML = _productLabelOptions(c.product || '');
      const ctamNotesEl = document.getElementById('ctamNotes');
      if (ctamNotesEl) ctamNotesEl.value = c.notes || '';
      (c.platforms || []).forEach(pl => {
        const cb = document.querySelector(`[name="ctamPlat"][value="${pl}"]`);
        if (cb) cb.checked = true;
      });
    } else {
      const ctamTextEl = document.getElementById('ctamText');
      if (ctamTextEl) ctamTextEl.value = '';
      const ctamTypeEl = document.getElementById('ctamType');
      if (ctamTypeEl) ctamTypeEl.value = '';
      const ctamProductEl = document.getElementById('ctamProduct');
      if (ctamProductEl) ctamProductEl.innerHTML = _productLabelOptions('');
      const ctamNotesEl = document.getElementById('ctamNotes');
      if (ctamNotesEl) ctamNotesEl.value = '';
    }
    if (modal) modal.classList.add('open');
  }

  function closeCTAModal() { const _m = document.getElementById('ctaModal'); if (_m) _m.classList.remove('open'); }

  function saveCTAModal() {
    const ctamTextEl = document.getElementById('ctamText');
    if (!ctamTextEl) { showToast('CTA text field not found.', 'warning'); return; }
    const text = ctamTextEl.value.trim();
    if (!text) { showToast('CTA text is required.', 'warning'); return; }
    const platforms = [...document.querySelectorAll('[name="ctamPlat"]:checked')].map(cb => cb.value);
    const id = document.getElementById('ctamEditId')?.value || '';
    if (id) {
      const c = ctas.find(x => x.id === id);
      if (c) { c.text = text; c.type = document.getElementById('ctamType')?.value || ''; c.product = document.getElementById('ctamProduct')?.value || ''; c.platforms = platforms; c.notes = document.getElementById('ctamNotes')?.value.trim() || ''; }
    } else {
      ctas.push({ id: _uid(), text, type: document.getElementById('ctamType')?.value || '', product: document.getElementById('ctamProduct')?.value || '', platforms, notes: document.getElementById('ctamNotes')?.value.trim() || '', copyCount: 0, createdAt: Date.now() });
    }
    saveCTALibrary();
    closeCTAModal();
    renderCTALibrary();
  }

  function deleteCTA(id) {
    showConfirm('Delete this CTA?', () => {
      ctas = ctas.filter(c => c.id !== id);
      saveCTALibrary();
      renderCTALibrary();
    });
  }

  function copyCTA(id, btn) {
    const c = ctas.find(x => x.id === id);
    if (!c) return;
    navigator.clipboard.writeText(c.text).then(() => {
      c.copyCount = (c.copyCount || 0) + 1;
      saveCTALibrary();
      _showCopied(btn, '✅ Copied!');
      setTimeout(() => renderCTALibrary(), 2100);
    }).catch(() => showToast('Copy failed — check browser permissions.', 'warning'));
  }

  // ============================================================
  // FEATURE 4: POST PERFORMANCE LOG
  // ============================================================
  let performanceLogs = [];

  async function loadPerformanceLogs() {
    try { performanceLogs = _safeJSON(await DB.get('sm_performance'), []); } catch(e) { performanceLogs = []; showToast('Could not load Performance Log.', 'error'); }
    renderPerformanceLog();
  }

  function savePerformanceLogs() { DB.set('sm_performance', JSON.stringify(performanceLogs)).catch(e => console.warn('savePerformanceLogs error:', e)); }

  function renderPerformanceLog() {
    const accFilter = document.getElementById('plFilterAccount') ? document.getElementById('plFilterAccount').value : '';
    const starsFilter = document.getElementById('plFilterStars') ? parseInt(document.getElementById('plFilterStars').value) || 0 : 0;

    // Refresh account dropdown — guard against accounts not yet loaded
    const accEl = document.getElementById('plFilterAccount');
    if (accEl) {
      const safeAccounts = (typeof accounts !== 'undefined' && Array.isArray(accounts)) ? accounts : [];
      const cur = accEl.value;
      accEl.innerHTML = '<option value="">All Accounts</option>' + safeAccounts.map(a => `<option value="${_escHtml(a.id)}" ${a.id === cur ? 'selected':''}>${_escHtml(a.username || a.platform)}</option>`).join('');
    }

    const filtered = performanceLogs.filter(l => {
      const matchAcc = !accFilter || l.accountId === accFilter;
      const matchStar = !starsFilter || (l.stars || 0) >= starsFilter;
      return matchAcc && matchStar;
    });

    const list = document.getElementById('plList');
    if (!list) return;

    if (filtered.length === 0) {
      list.innerHTML = `<div style="text-align:center;color:var(--text-3);padding:40px 0;font-size:13px;">${performanceLogs.length === 0 ? 'No performance logs yet. Click <strong>+ Log Performance</strong> to start tracking.' : 'No logs match your filter.'}</div>`;
      return;
    }

    const starsHtml = n => '★'.repeat(n) + '☆'.repeat(5 - n);
    const platEmoji = { TikTok:'🎵', Instagram:'📸', Facebook:'👥', YouTube:'▶️' };

    list.innerHTML = filtered.slice().sort((a,b) => (b.createdAt||0)-(a.createdAt||0)).map(l => {
      const acc = Array.isArray(accounts) ? accounts.find(a => a.id === l.accountId) : null;
      const accLabel = acc ? `${platEmoji[acc.platform]||'📱'} ${_escHtml(acc.username || acc.platform)}` : l.accountId ? `Account #${l.accountId.slice(-4)}` : '—';
      return `<div class="pl-card">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;">
          <div style="flex:1;">
            <div class="pv-card-title">${_escHtml(l.scriptTitle || 'Untitled Post')}</div>
            <div class="pv-card-sub">${accLabel} · ${l.date || '—'}</div>
          </div>
          <div style="display:flex;gap:4px;flex-shrink:0;">
            <button class="btn-sm" onclick="openPerformanceModal(${JSON.stringify(l.id)})">✏️</button>
            <button class="btn-sm danger" onclick="deletePerformanceLog(${JSON.stringify(l.id)})">🗑</button>
          </div>
        </div>
        <div class="stars-display" style="color:var(--warning);">${starsHtml(l.stars||0)}</div>
        ${l.notes ? `<div style="font-size:12px;color:var(--text-2);">${_escHtml(l.notes)}</div>` : ''}
      </div>`;
    }).join('');
  }

  let _perfStarValue = 0;
  function setPerfStar(n) {
    _perfStarValue = n;
    const starsEl = document.getElementById('perfStars');
    if (starsEl) starsEl.value = n;
    const labels = ['','Poor','Okay','Good','Great','Amazing'];
    const labelEl = document.getElementById('perfStarLabel');
    if (labelEl) labelEl.textContent = labels[n] || '';
    for (let i = 1; i <= 5; i++) {
      const btn = document.getElementById('star' + i);
      if (btn) btn.classList.toggle('active', i <= n);
    }
  }

  function openPerformanceModal(id) {
    const modal = document.getElementById('performanceModal');
    if (!modal) return;
    const _perfEditId = document.getElementById('perfEditId');
    const _perfTitle  = document.getElementById('perfModalTitle');
    if (_perfEditId) _perfEditId.value = id || '';
    if (_perfTitle)  _perfTitle.textContent = id ? 'Edit Log' : 'Log Performance';

    // Populate account select
    const accSel = document.getElementById('perfAccount');
    if (accSel) accSel.innerHTML = '<option value="">Select account...</option>' + (typeof accounts !== 'undefined' && Array.isArray(accounts) ? accounts : []).map(a => `<option value="${_escHtml(a.id)}">${_escHtml(a.username || a.platform)}</option>`).join('');

    if (id) {
      const l = performanceLogs.find(x => x.id === id);
      if (!l) return;
      if (accSel) accSel.value = l.accountId || '';
      const _pDate  = document.getElementById('perfDate');
      const _pSTitle= document.getElementById('perfTitle');
      const _pNotes = document.getElementById('perfNotes');
      if (_pDate)   _pDate.value  = l.date        || '';
      if (_pSTitle) _pSTitle.value= l.scriptTitle || '';
      if (_pNotes)  _pNotes.value = l.notes       || '';
      setPerfStar(l.stars || 0);
    } else {
      if (accSel) accSel.value = '';
      const _pDate  = document.getElementById('perfDate');
      const _pSTitle= document.getElementById('perfTitle');
      const _pNotes = document.getElementById('perfNotes');
      if (_pDate)   _pDate.value   = new Date().toISOString().split('T')[0];
      if (_pSTitle) _pSTitle.value = '';
      if (_pNotes)  _pNotes.value  = '';
      setPerfStar(0);
    }
    modal.classList.add('open');
  }

  function closePerformanceModal() { const _m = document.getElementById('performanceModal'); if (_m) _m.classList.remove('open'); }

  function savePerformanceModal() {
    const perfTitleEl = document.getElementById('perfTitle');
    if (!perfTitleEl) { showToast('Post title field not found.', 'warning'); return; }
    const title = perfTitleEl.value.trim();
    if (!title) { showToast('Post title is required.', 'warning'); return; }
    const stars = parseInt(document.getElementById('perfStars')?.value) || 0;
    const id = document.getElementById('perfEditId')?.value || '';
    if (id) {
      const l = performanceLogs.find(x => x.id === id);
      if (l) { l.accountId = document.getElementById('perfAccount')?.value || ''; l.date = document.getElementById('perfDate')?.value || ''; l.scriptTitle = title; l.stars = stars; l.notes = document.getElementById('perfNotes')?.value.trim() || ''; }
    } else {
      performanceLogs.push({ id: _uid(), accountId: document.getElementById('perfAccount')?.value || '', date: document.getElementById('perfDate')?.value || '', scriptTitle: title, stars, notes: document.getElementById('perfNotes')?.value.trim() || '', createdAt: Date.now() });
    }
    savePerformanceLogs();
    closePerformanceModal();
    renderPerformanceLog();
  }

  function deletePerformanceLog(id) {
    showConfirm('Delete this log entry?', () => {
      performanceLogs = performanceLogs.filter(l => l.id !== id);
      savePerformanceLogs();
      renderPerformanceLog();
    });
  }

  // ============================================================
  // FEATURE 5: CONTENT RECYCLER
  // ============================================================
  let recycleItems = [];

  async function loadRecycleItems() {
    try { recycleItems = _safeJSON(await DB.get('sm_recycle'), []); } catch(e) { recycleItems = []; showToast('Could not load Content Recycler.', 'error'); }
    renderContentRecycler();
  }

  function saveRecycleItems() { DB.set('sm_recycle', JSON.stringify(recycleItems)).catch(e => console.warn('saveRecycleItems error:', e)); }

  function renderContentRecycler() {
    const search = (document.getElementById('rcSearch') ? document.getElementById('rcSearch').value : '').toLowerCase();
    const type = document.getElementById('rcFilterType') ? document.getElementById('rcFilterType').value : '';

    const filtered = recycleItems.filter(r => {
      const matchS = !search || (r.title||'').toLowerCase().includes(search) || (r.content||'').toLowerCase().includes(search) || (r.tags||[]).join(' ').toLowerCase().includes(search);
      const matchT = !type || r.type === type;
      return matchS && matchT;
    });

    const list = document.getElementById('rcList');
    if (!list) return;

    if (filtered.length === 0) {
      list.innerHTML = `<div style="text-align:center;color:var(--text-3);padding:40px 0;font-size:13px;">${recycleItems.length === 0 ? 'No recycled content yet. Click <strong>+ Add to Recycler</strong> to start saving reusable content.' : 'No items match your search.'}</div>`;
      return;
    }

    list.innerHTML = filtered.slice().sort((a,b)=>(b.createdAt||0)-(a.createdAt||0)).map(r => {
      const tagsHtml = (r.tags||[]).map(t => `<span class="badge-type">${_escHtml(t)}</span>`).join('');
      return `<div class="rc-card">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;">
          <div style="flex:1;">
            <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:4px;">
              <span class="pv-card-title">${_escHtml(r.title)}</span>
              <span class="badge-type">${_escHtml(r.type || 'custom')}</span>
              <span class="badge-count">♻️ ${r.timesUsed || 0} uses</span>
            </div>
            <div style="font-size:12px;color:var(--text-2);line-height:1.5;">${_escHtml((r.content||'').slice(0,120))}${(r.content||'').length>120?'…':''}</div>
            ${tagsHtml ? `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;">${tagsHtml}</div>` : ''}
          </div>
          <div style="display:flex;gap:4px;flex-shrink:0;">
            <button class="btn-sm" onclick="openRecycleModal(${JSON.stringify(r.id)})">✏️</button>
            <button class="btn-sm danger" onclick="deleteRecycleItem(${JSON.stringify(r.id)})">🗑</button>
          </div>
        </div>
        <div class="pv-card-actions">
          <button class="btn-sm" onclick="useRecycleItem(${JSON.stringify(r.id)},this)">♻️ Use Again</button>
        </div>
      </div>`;
    }).join('');
  }

  function openRecycleModal(id) {
    const modal = document.getElementById('recycleModal');
    const rcmEditIdEl = document.getElementById('rcmEditId');
    if (rcmEditIdEl) rcmEditIdEl.value = id || '';
    const recycleModalTitleEl = document.getElementById('recycleModalTitle');
    if (recycleModalTitleEl) recycleModalTitleEl.textContent = id ? 'Edit Recycled Content' : 'Add to Recycler';
    if (id) {
      const r = recycleItems.find(x => x.id === id);
      if (!r) return;
      const rcmTitleEl = document.getElementById('rcmTitle');
      if (rcmTitleEl) rcmTitleEl.value = r.title || '';
      const rcmTypeEl = document.getElementById('rcmType');
      if (rcmTypeEl) rcmTypeEl.value = r.type || 'custom';
      const rcmContentEl = document.getElementById('rcmContent');
      if (rcmContentEl) rcmContentEl.value = r.content || '';
      const rcmTagsEl = document.getElementById('rcmTags');
      if (rcmTagsEl) rcmTagsEl.value = (r.tags || []).join(', ');
      const rcmNotesEl = document.getElementById('rcmNotes');
      if (rcmNotesEl) rcmNotesEl.value = r.notes || '';
    } else {
      const rcmTitleEl = document.getElementById('rcmTitle');
      if (rcmTitleEl) rcmTitleEl.value = '';
      const rcmTypeEl = document.getElementById('rcmType');
      if (rcmTypeEl) rcmTypeEl.value = 'custom';
      const rcmContentEl = document.getElementById('rcmContent');
      if (rcmContentEl) rcmContentEl.value = '';
      const rcmTagsEl = document.getElementById('rcmTags');
      if (rcmTagsEl) rcmTagsEl.value = '';
      const rcmNotesEl = document.getElementById('rcmNotes');
      if (rcmNotesEl) rcmNotesEl.value = '';
    }
    if (modal) modal.classList.add('open');
  }

  function closeRecycleModal() { const _m = document.getElementById('recycleModal'); if (_m) _m.classList.remove('open'); }

  function saveRecycleModal() {
    const rcmTitleEl = document.getElementById('rcmTitle');
    if (!rcmTitleEl) { showToast('Title field not found.', 'warning'); return; }
    const title = rcmTitleEl.value.trim();
    const rcmContentEl = document.getElementById('rcmContent');
    if (!rcmContentEl) { showToast('Content field not found.', 'warning'); return; }
    const content = rcmContentEl.value.trim();
    if (!title) { showToast('Title is required.', 'warning'); return; }
    if (!content) { showToast('Content is required.', 'warning'); return; }
    const tags = document.getElementById('rcmTags')?.value.split(',').map(t => t.trim()).filter(Boolean) || [];
    const id = document.getElementById('rcmEditId')?.value || '';
    if (id) {
      const r = recycleItems.find(x => x.id === id);
      if (r) { r.title = title; r.type = document.getElementById('rcmType')?.value || 'custom'; r.content = content; r.tags = tags; r.notes = document.getElementById('rcmNotes')?.value.trim() || ''; }
    } else {
      recycleItems.push({ id: _uid(), type: document.getElementById('rcmType')?.value || 'custom', sourceId: '', title, content, tags, timesUsed: 0, notes: document.getElementById('rcmNotes')?.value.trim() || '', createdAt: Date.now() });
    }
    saveRecycleItems();
    closeRecycleModal();
    renderContentRecycler();
  }

  function deleteRecycleItem(id) {
    showConfirm('Delete this recycled item?', () => {
      recycleItems = recycleItems.filter(r => r.id !== id);
      saveRecycleItems();
      renderContentRecycler();
    });
  }

  function useRecycleItem(id, btn) {
    const r = recycleItems.find(x => x.id === id);
    if (!r) return;
    navigator.clipboard.writeText(r.content).then(() => {
        r.timesUsed = (r.timesUsed || 0) + 1;
        saveRecycleItems();
        _showCopied(btn, '✅ Copied!');
        setTimeout(() => renderContentRecycler(), 2100);
    }).catch(() => showToast('Copy failed — check browser permissions.', 'warning'));
  }

  // ============================================================
  // FEATURE 6: IDEAS INBOX
  // ============================================================
  let ideas = [];

  async function loadIdeas() {
    try { ideas = _safeJSON(await DB.get('sm_ideas'), []); } catch(e) { ideas = []; showToast('Could not load Ideas Inbox.', 'error'); }
    renderIdeasInbox();
  }

  function saveIdeas() { DB.set('sm_ideas', JSON.stringify(ideas)).catch(e => console.warn('saveIdeas error:', e)); }

  function quickAddIdea() {
    const input = document.getElementById('ideaQuickInput');
    const val = input ? input.value.trim() : '';
    if (!val) return;
    ideas.unshift({ id: _uid(), title: val, body: '', status: 'inbox', platform: '', tags: [], createdAt: Date.now() });
    saveIdeas();
    if (input) input.value = '';
    renderIdeasInbox();
  }

  function renderIdeasInbox() {
    const statusFilter = document.getElementById('iiFilterStatus') ? document.getElementById('iiFilterStatus').value : '';
    const platFilter = document.getElementById('iiFilterPlatform') ? document.getElementById('iiFilterPlatform').value : '';

    const filtered = ideas.filter(i => {
      const matchS = !statusFilter || i.status === statusFilter;
      const matchP = !platFilter || i.platform === platFilter;
      return matchS && matchP;
    });

    const list = document.getElementById('iiList');
    if (!list) return;

    if (filtered.length === 0) {
      list.innerHTML = `<div style="text-align:center;color:var(--text-3);padding:40px 0;font-size:13px;">${ideas.length === 0 ? 'No ideas yet. Use the quick capture bar above to add your first idea!' : 'No ideas match your filter.'}</div>`;
      return;
    }

    const statusBadge = s => {
      if (s === 'inbox') return '<span class="status-badge status-inbox">Inbox</span>';
      if (s === 'in-progress') return '<span class="status-badge status-in-progress">In Progress</span>';
      if (s === 'done') return '<span class="status-badge status-done">Done</span>';
      return '';
    };
    const nextStatus = s => s === 'inbox' ? 'in-progress' : s === 'in-progress' ? 'done' : 'inbox';
    const nextLabel = s => s === 'inbox' ? 'Mark In Progress' : s === 'in-progress' ? 'Mark Done' : 'Move to Inbox';

    list.innerHTML = filtered.map(i => {
      const tagsHtml = (i.tags||[]).map(t => `<span class="badge-type">${_escHtml(t)}</span>`).join('');
      const d = i.createdAt ? new Date(i.createdAt).toLocaleDateString() : '';
      return `<div class="idea-card">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;">
          <div style="flex:1;">
            <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:4px;">
              <span class="pv-card-title">${_escHtml(i.title)}</span>
              ${statusBadge(i.status)}
              ${i.platform ? `<span class="badge-type">${_escHtml(i.platform)}</span>` : ''}
            </div>
            ${i.body ? `<div style="font-size:12px;color:var(--text-2);line-height:1.5;">${_escHtml(i.body.slice(0,120))}${i.body.length>120?'…':''}</div>` : ''}
            <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;align-items:center;">
              ${tagsHtml}
              ${d ? `<span style="font-size:11px;color:var(--text-3);">📅 ${d}</span>` : ''}
            </div>
          </div>
          <div style="display:flex;gap:4px;flex-shrink:0;">
            <button class="btn-sm" onclick="openIdeaModal(${JSON.stringify(i.id)})">✏️</button>
            <button class="btn-sm danger" onclick="deleteIdea(${JSON.stringify(i.id)})">🗑</button>
          </div>
        </div>
        <div class="pv-card-actions">
          <button class="btn-sm" onclick="cycleIdeaStatus(${JSON.stringify(i.id)})">${nextLabel(i.status)}</button>
        </div>
      </div>`;
    }).join('');
  }

  function openIdeaModal(id) {
    const modal = document.getElementById('ideaModal');
    const iimEditIdEl = document.getElementById('iimEditId');
    if (iimEditIdEl) iimEditIdEl.value = id || '';
    const ideaModalTitleEl = document.getElementById('ideaModalTitle');
    if (ideaModalTitleEl) ideaModalTitleEl.textContent = id ? 'Edit Idea' : 'Add Idea';
    if (id) {
      const i = ideas.find(x => x.id === id);
      if (!i) return;
      const iimTitleEl = document.getElementById('iimTitle');
      if (iimTitleEl) iimTitleEl.value = i.title || '';
      const iimBodyEl = document.getElementById('iimBody');
      if (iimBodyEl) iimBodyEl.value = i.body || '';
      const iimStatusEl = document.getElementById('iimStatus');
      if (iimStatusEl) iimStatusEl.value = i.status || 'inbox';
      const iimPlatformEl = document.getElementById('iimPlatform');
      if (iimPlatformEl) iimPlatformEl.value = i.platform || '';
      const iimTagsEl = document.getElementById('iimTags');
      if (iimTagsEl) iimTagsEl.value = (i.tags || []).join(', ');
    } else {
      const iimTitleEl = document.getElementById('iimTitle');
      if (iimTitleEl) iimTitleEl.value = '';
      const iimBodyEl = document.getElementById('iimBody');
      if (iimBodyEl) iimBodyEl.value = '';
      const iimStatusEl = document.getElementById('iimStatus');
      if (iimStatusEl) iimStatusEl.value = 'inbox';
      const iimPlatformEl = document.getElementById('iimPlatform');
      if (iimPlatformEl) iimPlatformEl.value = '';
      const iimTagsEl = document.getElementById('iimTags');
      if (iimTagsEl) iimTagsEl.value = '';
    }
    if (modal) modal.classList.add('open');
  }

  function closeIdeaModal() { const _m = document.getElementById('ideaModal'); if (_m) _m.classList.remove('open'); }

  function saveIdeaModal() {
    const iimTitleEl = document.getElementById('iimTitle');
    if (!iimTitleEl) { showToast('Title field not found.', 'warning'); return; }
    const title = iimTitleEl.value.trim();
    if (!title) { showToast('Title is required.', 'warning'); return; }
    const tags = document.getElementById('iimTags')?.value.split(',').map(t => t.trim()).filter(Boolean) || [];
    const id = document.getElementById('iimEditId')?.value || '';
    if (id) {
      const i = ideas.find(x => x.id === id);
      if (i) { i.title = title; i.body = document.getElementById('iimBody')?.value.trim() || ''; i.status = document.getElementById('iimStatus')?.value || 'inbox'; i.platform = document.getElementById('iimPlatform')?.value || ''; i.tags = tags; }
    } else {
      ideas.unshift({ id: _uid(), title, body: document.getElementById('iimBody')?.value.trim() || '', status: document.getElementById('iimStatus')?.value || 'inbox', platform: document.getElementById('iimPlatform')?.value || '', tags, createdAt: Date.now() });
    }
    saveIdeas();
    closeIdeaModal();
    renderIdeasInbox();
  }

  function deleteIdea(id) {
    showConfirm('Delete this idea?', () => {
      ideas = ideas.filter(i => i.id !== id);
      saveIdeas();
      renderIdeasInbox();
    });
  }

  function cycleIdeaStatus(id) {
    const i = ideas.find(x => x.id === id);
    if (!i) return;
    const order = ['inbox', 'in-progress', 'done'];
    const cur = order.indexOf(i.status);
    i.status = order[(cur + 1) % order.length];
    saveIdeas();
    renderIdeasInbox();
  }

  // ============================================================
  // END FEATURE PANELS
  // ============================================================
