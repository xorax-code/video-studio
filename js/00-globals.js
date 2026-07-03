  // ===== INDEXEDDB STORAGE =====
  const DB = (() => {
    const DB_NAME = 'socialos_db';
    const STORE   = 'kv';
    let _db = null;
    let _openPromise = null; // dedup concurrent open() calls before _db is set
    let _userId = '';

    // Call this after login so all reads/writes are scoped to the user
    function setUser(id) { _userId = id || ''; }
    function uKey(key) { return _userId ? `u_${_userId}_${key}` : key; }

    function open() {
      if (_db) return Promise.resolve(_db);
      if (_openPromise) return _openPromise;
      _openPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = e => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
        };
        req.onsuccess  = e => { _db = e.target.result; _openPromise = null; resolve(_db); };
        req.onerror    = e => { _openPromise = null; reject(e.target.error); };
        req.onblocked  = () => { _openPromise = null; console.warn('DB upgrade blocked'); reject(new Error('IndexedDB blocked by another tab')); };
      });
      return _openPromise;
    }

    async function get(key, unscoped) {
      const db = await open();
      const k = unscoped ? key : uKey(key);
      return new Promise((resolve, reject) => {
        const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(k);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror   = e => reject(e.target.error);
      });
    }

    async function set(key, value, unscoped) {
      const db = await open();
      const k = unscoped ? key : uKey(key);
      return new Promise((resolve, reject) => {
        const req = db.transaction(STORE, 'readwrite').objectStore(STORE).put(value, k);
        req.onsuccess = () => resolve();
        req.onerror   = e => reject(e.target.error);
      });
    }

    async function remove(key, unscoped) {
      const db = await open();
      const k = unscoped ? key : uKey(key);
      return new Promise((resolve, reject) => {
        const req = db.transaction(STORE, 'readwrite').objectStore(STORE).delete(k);
        req.onsuccess = () => resolve();
        req.onerror   = e => reject(e.target.error);
      });
    }

    // Migrate any existing localStorage data into IndexedDB (runs once)
    async function migrateLocalStorage() {
      const keys = ['sm_accounts','sm_competitors','sm_viral_scripts','sm_studio_library',
                    'sm_whisper_segments','sm_segments','sm_avatar_img','sm_avatar_image',
                    'sm_openai_key','sm_avatar_profile','sm_video_log','sm_post_plans','sm_daily_items','sm_weekly_content_types',
                    'sm_bg_image','sm_studio_mode'];
      for (const key of keys) {
        const val = localStorage.getItem(key);
        if (val !== null) {
          try {
            await set(key, val);
            // Verify the migrated value was actually written AND can be read
            // back through the same scoped get() path before destroying the
            // legacy copy. If scopes mismatch (read-back empty/unequal), keep
            // the legacy key so the data is never lost permanently.
            const readBack = await get(key);
            if (readBack != null && String(readBack) === String(val)) {
              localStorage.removeItem(key);
            } else {
              console.warn('migrateLocalStorage: read-back mismatch, keeping legacy key', key);
            }
          } catch(e) { console.warn('migrateLocalStorage: failed to migrate key', key, e); }
        }
      }
    }

    return { get, set, remove, migrateLocalStorage, setUser };
  })();

  // ===== AT-REST FIELD ENCRYPTION (WebCrypto AES-GCM) =====
  // Encrypts sensitive single fields (e.g. social-account passwords) before
  // they are persisted to IndexedDB. The key is derived (PBKDF2) from a
  // per-install random secret kept in localStorage. This is hardening short of
  // a user passphrase — it stops casual at-rest plaintext exposure of stored
  // credentials. Encrypted values are marked with the `enc:v1:` prefix so old
  // plaintext values remain transparently readable (and get re-encrypted on
  // next save). Helpers are async (WebCrypto requirement); fail-soft so a
  // crypto error never blocks save/login.
  const _ENC_MARKER = 'enc:v1:';
  const _ENC = (() => {
    let _keyPromise = null;

    function _hasCrypto() {
      return typeof crypto !== 'undefined' && crypto.subtle &&
             typeof TextEncoder !== 'undefined';
    }

    // Per-install random secret (32 random bytes, base64) stored once.
    function _getInstallSecret() {
      let s = null;
      try { s = localStorage.getItem('sm_enc_secret'); } catch(e) {}
      if (!s) {
        const buf = new Uint8Array(32);
        crypto.getRandomValues(buf);
        s = btoa(String.fromCharCode.apply(null, buf));
        try { localStorage.setItem('sm_enc_secret', s); } catch(e) {}
      }
      return s;
    }

    async function _getKey() {
      if (_keyPromise) return _keyPromise;
      _keyPromise = (async () => {
        const enc = new TextEncoder();
        const secret = _getInstallSecret();
        const baseKey = await crypto.subtle.importKey(
          'raw', enc.encode(secret), { name: 'PBKDF2' }, false, ['deriveKey']
        );
        // Fixed deterministic salt (the install secret is the entropy source).
        const salt = enc.encode('socialos_field_v1');
        return crypto.subtle.deriveKey(
          { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
          baseKey,
          { name: 'AES-GCM', length: 256 },
          false,
          ['encrypt', 'decrypt']
        );
      })();
      return _keyPromise;
    }

    function _b64(bytes) { return btoa(String.fromCharCode.apply(null, bytes)); }
    function _unb64(str) {
      const bin = atob(str);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }

    // Returns `enc:v1:<b64(iv)>:<b64(ct)>`. On any failure returns the original
    // plaintext unchanged so saving never breaks.
    async function encField(str) {
      if (str == null || str === '') return str;
      if (typeof str === 'string' && str.indexOf(_ENC_MARKER) === 0) return str; // already encrypted
      if (!_hasCrypto()) return str;
      try {
        const key = await _getKey();
        const iv = new Uint8Array(12);
        crypto.getRandomValues(iv);
        const enc = new TextEncoder();
        const ct = await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv }, key, enc.encode(String(str))
        );
        return _ENC_MARKER + _b64(iv) + ':' + _b64(new Uint8Array(ct));
      } catch(e) {
        console.warn('encField failed — storing plaintext fallback:', e);
        return str;
      }
    }

    // If value carries the marker, decrypt; otherwise return as-is (legacy
    // plaintext). On decrypt failure returns the raw value so reads never throw.
    async function decField(str) {
      if (typeof str !== 'string' || str.indexOf(_ENC_MARKER) !== 0) return str;
      if (!_hasCrypto()) return str;
      try {
        const body = str.slice(_ENC_MARKER.length);
        const sep = body.indexOf(':');
        if (sep === -1) return str;
        const iv = _unb64(body.slice(0, sep));
        const ct = _unb64(body.slice(sep + 1));
        const key = await _getKey();
        const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
        return new TextDecoder().decode(pt);
      } catch(e) {
        console.warn('decField failed — returning raw value:', e);
        return str;
      }
    }

    return { encField, decField, MARKER: _ENC_MARKER };
  })();
  // Expose async field-crypto helpers to other modules (shared scope + window).
  const _encField = _ENC.encField;
  const _decField = _ENC.decField;
  window._encField = _encField;
  window._decField = _decField;

  // ── Confirm toast (replaces native confirm() dialogs) ──
  window.showConfirm = function(message, onYes, onNo) {
    const container = document.getElementById('toastContainer');
    if (!container) { if (onYes && window.confirm(message)) onYes(); return; }
    const t = document.createElement('div');
    t.className = 'toast toast-warning';
    t.style.cssText = 'pointer-events:auto;min-width:300px;max-width:420px;gap:10px;flex-wrap:wrap;align-items:flex-start;';
    t.innerHTML = `
      <span class="toast-icon"><i class="ti ti-alert-triangle"></i></span>
      <span class="toast-msg" style="flex:1;line-height:1.5;"></span>
      <div style="display:flex;gap:6px;flex-shrink:0;margin-top:2px;">
        <button class="sc-yes" style="padding:3px 12px;background:var(--danger);border:none;border-radius:5px;color:#fff;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit;">Yes</button>
        <button class="sc-no"  style="padding:3px 10px;background:var(--surface-3);border:1px solid var(--border-2);border-radius:5px;color:var(--text-2);font-size:11px;cursor:pointer;font-family:inherit;">No</button>
      </div>`;
    t.querySelector('.toast-msg').textContent = message;
    container.appendChild(t);
    requestAnimationFrame(() => { requestAnimationFrame(() => { t.classList.add('show'); }); });
    const dismiss = () => { t.classList.add('hiding'); setTimeout(() => t.remove(), 300); };
    t.querySelector('.sc-yes').onclick = () => { dismiss(); if (onYes) onYes(); };
    t.querySelector('.sc-no').onclick  = () => { dismiss(); if (onNo)  onNo();  };
  };

  // ── Toast notification system ──
  window.showToast = function(msg, type = 'info', duration = 3500) {
    let container = document.getElementById('toastContainer');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toastContainer';
      document.body.appendChild(container);
    }
    const icons = { success: 'ti-circle-check', error: 'ti-alert-circle', warning: 'ti-alert-triangle', info: 'ti-info-circle' };
    const t = document.createElement('div');
    t.className = `toast toast-${type}`;
    t.innerHTML = `<span class="toast-icon"><i class="ti ${icons[type] || icons.info}"></i></span><span class="toast-msg"></span><button class="toast-close" onclick="this.parentElement.classList.add('hiding');setTimeout(()=>this.parentElement.remove(),300);">✕</button>`;
    t.querySelector('.toast-msg').textContent = msg;
    container.appendChild(t);
    requestAnimationFrame(() => { requestAnimationFrame(() => { t.classList.add('show'); }); });
    setTimeout(() => { t.classList.add('hiding'); setTimeout(() => t.remove(), 300); }, duration);
  };

  // ===== SHARED =====
  const platformEmojis = { TikTok: '🎵', Instagram: '📸', Facebook: '👤', YouTube: '▶️', Other: '🌐' };

  function escHtml(str) {
    if (!str) return '';
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  const _tabTitles = {
    'dashboard': 'Dashboard',
    'my-accounts': 'My Accounts',
    'competitors': 'Competitors',
    'viral-scripts': 'Viral Scripts + Hooks + CTAs',
    'calendar': 'Video Calendar',
    'video-replicator': 'Video Replicator',
    'video-producer': 'Video Producer',
    'video-editor': 'Video Editor',
  };

  function switchTab(tab) {
    localStorage.setItem('sm_active_tab', tab);
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));

    // Both studio sub-tabs share the same #tab-video-studio div
    const isStudio = tab === 'video-replicator' || tab === 'video-producer';
    const divId = isStudio ? 'video-studio' : tab;
    const _tabDiv = document.getElementById('tab-' + divId);
    if (_tabDiv) _tabDiv.classList.add('active');

    // Activate the correct nav button via data-tab attribute
    const navBtn = document.querySelector(`.tab[data-tab="${tab}"]`);
    if (navBtn) navBtn.classList.add('active');
    // no fallback needed -- navBtn query covers all valid tab names

    // Update topbar title
    const titleEl = document.getElementById('topbarTitle');
    if (titleEl) titleEl.textContent = _tabTitles[tab] || tab;

    if (isStudio) {
      const requestedMode = tab === 'video-replicator' ? 'replicator' : 'producer';
      // Only run full initVideoStudio when mode changes or first open.
      // Re-clicking the same tab must not wipe Quick Mode state or trigger
      // unnecessary DB round-trips / project reloads.
      const modeChanged = (typeof studioMode !== 'undefined' && studioMode !== requestedMode);
      if (typeof initVideoStudio === 'function' && (!window._studioInited || modeChanged)) {
        window._studioInited = true;
        initVideoStudio(requestedMode);
      }
    } else {
      if (tab === 'dashboard') renderDashboard();
      if (tab === 'competitors') renderCompetitors();
      if (tab === 'viral-scripts') { renderScripts(); renderHookBank(); renderCTALibrary(); renderIdeasInbox(); }
      if (tab === 'calendar') { renderCalendar(); renderPlans(); renderDailyPlan(); }
      if (tab === 'my-accounts') renderTable();
      if (tab === 'video-editor') {
        if (typeof renderGallery === 'function') renderGallery();
        if (typeof renderAssembler === 'function') renderAssembler();
      }
    }
  }

  // ===== API RATE LIMIT HELPERS =====

  // Run asyncFn over arr with at most `limit` in-flight at once.
  // Returns an array of results in the same order as arr.
  // Errors are caught and stored as { _err: <Error> } so they don't abort other items.
  async function _concurrentMap(arr, asyncFn, limit) {
    limit = limit || 3;
    const results = new Array(arr.length);
    let idx = 0;
    async function worker() {
      while (idx < arr.length) {
        const i = idx++;
        try { results[i] = await asyncFn(arr[i], i); }
        catch(e) { results[i] = { _err: e }; }
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, arr.length) }, worker));
    return results;
  }

  // fetch() wrapper that auto-retries on HTTP 429 with exponential back-off.
  // Respects the server's Retry-After header when present.
  async function _fetchWithRetry(url, opts, maxRetries) {
    maxRetries = (maxRetries == null) ? 5 : maxRetries;
    let delay = 3000;
    let res;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      res = await fetch(url, opts);
      if (res.status !== 429 || attempt === maxRetries) return res;
      const retryAfter = parseInt(res.headers.get('Retry-After') || '0', 10) * 1000;
      const wait = Math.max(retryAfter || 0, delay);
      console.warn('[fetchWithRetry] 429 rate limit — waiting ' + Math.round(wait/1000) + 's before retry ' + (attempt+1) + '/' + maxRetries);
      await new Promise(function(r) { setTimeout(r, wait); });
      delay = Math.min(delay * 2, 30000);
    }
    return res;
  }


