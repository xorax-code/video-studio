// ===== STUDIO =====
// Mode toggle: Generate Image (up to 5 reference photos) | Generate Video (optional start frame)
// Results are kept in a persistent scrollable strip — new generations appear alongside old ones.
// GPT-4o-mini enhances casual prompts → Gemini image gen / Veo 3 video gen

(function() {

  // ── State ──────────────────────────────────────────────────────────────────
  var _fsMode     = 'image';
  var _fsImgSlots = [null,null,null,null,null,null]; // {dataUrl,b64,mime} — Subject/Background/Style/Ref/Product/Extra
  var _fsVidFrame = null;                       // {dataUrl,b64,mime}

  // History arrays — results are never replaced, only appended (newest first)
  var _fsImgHistory = []; // [{dataUrl, id}]
  var _fsVidHistory = []; // [{src, id}]       src is always a blob URL
  var _MAX_HISTORY  = 20;

  // Prompt history — last 10 per mode, stored in localStorage (tiny text, no need for IndexedDB)
  var _fsImgPromptHistory = [];
  var _fsVidPromptHistory = [];
  try { _fsImgPromptHistory = JSON.parse(localStorage.getItem('fsImgPrompts') || '[]'); } catch(_) {}
  try { _fsVidPromptHistory = JSON.parse(localStorage.getItem('fsVidPrompts') || '[]'); } catch(_) {}

  // Expose state checkers for inline HTML onmouseleave handlers
  window._fsSlotFilled = function(idx) { return !!_fsImgSlots[idx]; };
  window._fsVidFilled  = function()    { return !!_fsVidFrame; };

  // ── Mode toggle ────────────────────────────────────────────────────────────
  window.switchFsMode = function(mode) {
    _fsMode = mode;
    var isImg = mode === 'image';

    // Ingredient panels
    var imgRefs = document.getElementById('fsImgRefs');
    var vidRefs = document.getElementById('fsVidRefs');
    if (imgRefs) imgRefs.style.display = isImg ? '' : 'none';
    if (vidRefs) vidRefs.style.display = isImg ? 'none' : '';

    // Prompts
    var imgPrompt = document.getElementById('fsImgPrompt');
    var vidPrompt = document.getElementById('fsVidPrompt');
    if (imgPrompt) imgPrompt.style.display = isImg ? '' : 'none';
    if (vidPrompt) vidPrompt.style.display = isImg ? 'none' : '';

    // Settings (count vs duration+count)
    var imgSettings = document.getElementById('fsImgSettings');
    var vidSettings = document.getElementById('fsVidSettings');
    if (imgSettings) imgSettings.style.display = isImg ? 'flex' : 'none';
    if (vidSettings) vidSettings.style.display = isImg ? 'none' : 'flex';

    // Generate buttons
    var genImg = document.getElementById('fsBtnGenImg');
    var genVid = document.getElementById('fsBtnGenVid');
    if (genImg) genImg.style.display = isImg ? '' : 'none';
    if (genVid) genVid.style.display = isImg ? 'none' : '';

    // Spinners
    var spnImg = document.getElementById('fsImgSpinner');
    var spnVid = document.getElementById('fsVidSpinner');
    if (!isImg && spnImg) spnImg.style.display = 'none';
    if (isImg  && spnVid) spnVid.style.display = 'none';

    // Mode pill active states
    _fsStyleModeBtn(document.getElementById('fsModeImgBtn'), isImg);
    _fsStyleModeBtn(document.getElementById('fsModeVidBtn'), !isImg);
  };

  function _fsStyleModeBtn(btn, active) {
    if (!btn) return;
    btn.style.background = active ? 'rgba(52,211,153,0.2)' : 'transparent';
    btn.style.color      = active ? '#34d399'              : 'var(--text-3)';
  }

  // ── Image slot upload ──────────────────────────────────────────────────────
  window.fsTriggerSlot = function(idx) {
    var inp = document.getElementById('fsSlotInput-' + idx);
    if (inp) inp.click();
  };

  window.onFsSlotChange = function(idx, e) {
    var file = e && e.target && e.target.files && e.target.files[0];
    if (!file) return;
    _fsReadImageFile(file, function(result) {
      _fsImgSlots[idx] = result;
      _fsRenderSlot(idx);
      var inp = document.getElementById('fsSlotInput-' + idx);
      if (inp) inp.value = '';
    });
  };

  window.fsClearSlot = function(idx, e) {
    if (e) e.stopPropagation();
    _fsImgSlots[idx] = null;
    _fsRenderSlot(idx);
  };

  window.fsSlotClearAll = function() {
    for (var i = 0; i < 6; i++) {
      _fsImgSlots[i] = null;
      _fsRenderSlot(i);
      var inp = document.getElementById('fsSlotInput-' + i);
      if (inp) inp.value = '';
    }
    showToast('All reference photos cleared.', 'info', 1800);
  };

  function _fsRenderSlot(idx) {
    var slot   = document.getElementById('fsSlot-' + idx);
    var clearX = document.getElementById('fsSlotClear-' + idx);
    var label  = document.getElementById('fsSlotLabel-' + idx);
    if (!slot) return;
    var img = _fsImgSlots[idx];
    if (img) {
      slot.style.backgroundImage    = 'url(' + img.dataUrl + ')';
      slot.style.backgroundSize     = 'cover';
      slot.style.backgroundPosition = 'center';
      slot.style.borderColor = 'rgba(52,211,153,0.6)';
      if (clearX) clearX.style.display = 'flex';
      if (label)  label.style.display  = 'none';
    } else {
      slot.style.backgroundImage = '';
      slot.style.borderColor     = 'rgba(255,255,255,0.1)';
      if (clearX) clearX.style.display = 'none';
      if (label)  label.style.display  = 'flex';
    }
  }

  // ── Video start frame upload ───────────────────────────────────────────────
  window.fsTriggerVidFrame = function() {
    var inp = document.getElementById('fsVidFrameInput');
    if (inp) inp.click();
  };

  window.onFsVidFrameChange = function(e) {
    var file = e && e.target && e.target.files && e.target.files[0];
    if (!file) return;
    _fsReadImageFile(file, function(result) {
      _fsVidFrame = result;
      _fsRenderVidFrame();
      var inp = document.getElementById('fsVidFrameInput');
      if (inp) inp.value = '';
    });
  };

  window.fsClearVidFrame = function(e) {
    if (e) e.stopPropagation();
    _fsVidFrame = null;
    _fsRenderVidFrame();
  };

  function _fsRenderVidFrame() {
    var slot   = document.getElementById('fsVidFrameSlot');
    var clearX = document.getElementById('fsVidFrameClear');
    var label  = document.getElementById('fsVidFrameLabel');
    if (!slot) return;
    if (_fsVidFrame) {
      slot.style.backgroundImage    = 'url(' + _fsVidFrame.dataUrl + ')';
      slot.style.backgroundSize     = 'cover';
      slot.style.backgroundPosition = 'center';
      slot.style.borderColor = 'rgba(52,211,153,0.6)';
      if (clearX) clearX.style.display = 'flex';
      if (label)  label.style.display  = 'none';
    } else {
      slot.style.backgroundImage = '';
      slot.style.borderColor     = 'rgba(255,255,255,0.1)';
      if (clearX) clearX.style.display = 'none';
      if (label)  label.style.display  = 'flex';
    }
  }

  // ── Read file ──────────────────────────────────────────────────────────────
  function _fsReadImageFile(file, cb) {
    var reader = new FileReader();
    reader.onload = function(ev) {
      var dataUrl = ev.target.result;
      var comma   = dataUrl.indexOf(',');
      cb({ dataUrl: dataUrl, b64: dataUrl.slice(comma + 1), mime: dataUrl.slice(5, comma).split(';')[0] || 'image/jpeg' });
    };
    reader.readAsDataURL(file);
  }

  // ── Compress ───────────────────────────────────────────────────────────────
  function _fsCompress(dataUrl, maxPx, quality) {
    return new Promise(function(resolve) {
      var img = new Image();
      img.onload = function() {
        var w = img.naturalWidth || 512, h = img.naturalHeight || 512;
        if (w > maxPx || h > maxPx) {
          if (w >= h) { h = Math.round(h * maxPx / w); w = maxPx; }
          else        { w = Math.round(w * maxPx / h); h = maxPx; }
        }
        var c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL('image/jpeg', quality || 0.80));
      };
      img.onerror = function() { resolve(dataUrl); };
      img.src = dataUrl;
    });
  }

  // ── Supabase JWT ───────────────────────────────────────────────────────────
  async function _fsJwt() {
    try {
      var sb = (typeof _sb !== 'undefined' && _sb) ? _sb : window._sb;
      if (sb) {
        var r = await sb.auth.getSession();
        return (r && r.data && r.data.session && r.data.session.access_token) || null;
      }
    } catch(_) {}
    return null;
  }

  // ── GPT helper ─────────────────────────────────────────────────────────────
  async function _fsGpt(system, user, jwt, maxTokens) {
    var res = await fetch('/.netlify/functions/openai-chat', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + jwt },
      body: JSON.stringify({
        model: 'gpt-4o-mini', max_tokens: maxTokens || 500,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
    });
    var data; try { data = await res.json(); } catch(_) { data = {}; }
    if (!res.ok || data.error) throw new Error((data.error && (data.error.message || data.error)) || 'GPT error');
    return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  }

  var _FS_IMG_SYS = 'You are a prompt engineer for Gemini AI image editing. Rewrite the user\'s casual description into a precise photorealistic instruction. Rules: be specific about placement, lighting, and integration; state that the subject\'s face, skin, hair, clothing, and background must stay completely unchanged; if multiple reference photos are mentioned, reference them by number. Return ONLY: {"instruction":"<your detailed instruction>"}';
  // Used when NO reference photos are provided (pure text-to-image): generate from
  // scratch, so there is no subject to "keep unchanged."
  var _FS_IMG_GEN_SYS = 'You are a prompt engineer for AI text-to-image generation. Rewrite the user\'s casual description into a precise, vivid, photorealistic image-generation prompt. Rules: be specific about subject, composition, lighting, setting, mood, and style; do NOT reference any photos; do NOT say to keep anything unchanged. Return ONLY: {"instruction":"<your detailed instruction>"}';

  // _FS_VID_SYS removed — video prompt enhancement handled by enhance-veo-prompt Netlify function (Gemini 2.5 Flash multimodal)

  // ── Prompt history ─────────────────────────────────────────────────────────
  function _fsSavePrompt(mode, text) {
    if (!text || !text.trim()) return;
    var key = mode === 'image' ? 'fsImgPrompts' : 'fsVidPrompts';
    var arr = mode === 'image' ? _fsImgPromptHistory : _fsVidPromptHistory;
    var ex  = arr.indexOf(text);
    if (ex !== -1) arr.splice(ex, 1);
    arr.unshift(text);
    if (arr.length > 10) arr.length = 10;
    try { localStorage.setItem(key, JSON.stringify(arr)); } catch(_) {}
    _fsRenderPromptHistory(mode);
  }

  function _fsRenderPromptHistory(mode) {
    var cId  = mode === 'image' ? 'fsImgPromptHistory' : 'fsVidPromptHistory';
    var pId  = mode === 'image' ? 'fsImgPrompt'        : 'fsVidPrompt';
    var arr  = mode === 'image' ? _fsImgPromptHistory  : _fsVidPromptHistory;
    var cont = document.getElementById(cId);
    if (!cont) return;
    cont.innerHTML = '';
    if (!arr.length) { cont.style.display = 'none'; return; }
    cont.style.display = 'flex';
    arr.forEach(function(text) {
      var chip = document.createElement('button');
      chip.title = text;
      chip.textContent = text.length > 42 ? text.slice(0, 39) + '…' : text;
      chip.style.cssText = 'flex:0 0 auto;max-width:210px;padding:3px 9px;font-size:9px;font-family:inherit;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.12);border-radius:20px;color:var(--text-3);cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;transition:all 0.12s;';
      chip.onmouseover = function() { this.style.background = 'rgba(52,211,153,0.1)'; this.style.borderColor = 'rgba(52,211,153,0.3)'; this.style.color = '#34d399'; };
      chip.onmouseout  = function() { this.style.background = 'rgba(255,255,255,0.05)'; this.style.borderColor = 'rgba(255,255,255,0.12)'; this.style.color = 'var(--text-3)'; };
      chip.onclick = function() { var el = document.getElementById(pId); if (el) { el.value = text; el.focus(); } };
      cont.appendChild(chip);
    });
  }

  function _fsInitPromptHistory() {
    ['image', 'video'].forEach(function(mode) {
      var pId = mode === 'image' ? 'fsImgPrompt' : 'fsVidPrompt';
      var cId = mode === 'image' ? 'fsImgPromptHistory' : 'fsVidPromptHistory';
      var el  = document.getElementById(pId);
      if (!el || document.getElementById(cId)) return;
      var div = document.createElement('div');
      div.id = cId;
      div.style.cssText = 'display:none;flex-wrap:wrap;gap:4px;margin-top:5px;';
      el.parentNode.insertBefore(div, el.nextSibling);
      _fsRenderPromptHistory(mode);
    });
  }

  // ── Delete individual results ──────────────────────────────────────────────
  window.deleteFsImgResult = function(idx) {
    _fsImgHistory.splice(idx, 1);
    _renderImgStrip();
    _fsSaveImgHistory();
  };

  window.deleteFsVidResult = function(idx) {
    _fsVidHistory.splice(idx, 1);
    _renderVidStrip();
    _fsSaveVidHistory();
  };

  // ── Use image result as video start frame ──────────────────────────────────
  window.useFsImgResultAsVidStart = function(idx) {
    var item = _fsImgHistory[idx];
    if (!item) return;
    var dataUrl = item.dataUrl;
    var comma   = dataUrl.indexOf(',');
    _fsVidFrame = { dataUrl: dataUrl, b64: dataUrl.slice(comma + 1), mime: dataUrl.slice(5, comma).split(';')[0] || 'image/jpeg' };
    _fsRenderVidFrame();
    switchFsMode('video');
    if (typeof showToast === 'function') showToast('Set as video start frame — enter a prompt and generate.', 'success', 2500);
  };

  // ── Status helper ──────────────────────────────────────────────────────────
  function _fsStatus(elId, text, color) {
    var el = document.getElementById(elId);
    if (!el) return;
    el.textContent  = text;
    el.style.color  = color || 'var(--text-3)';
    el.style.display = text ? '' : 'none';
  }

  // ── Render image results strip ─────────────────────────────────────────────
  function _updateEmptyState() {
    var empty = document.getElementById('fsEmptyState');
    if (!empty) return;
    var hasImg = _fsImgHistory.length > 0;
    var hasVid = _fsVidHistory.length > 0;
    empty.style.display = (hasImg || hasVid) ? 'none' : 'flex';
  }

  function _renderImgStrip() {
    var strip   = document.getElementById('fsImgStrip');
    var wrapper = document.getElementById('fsImgResults');
    var countEl = document.getElementById('fsImgResultCount');
    if (!strip) return;
    if (countEl) countEl.textContent = _fsImgHistory.length;
    if (wrapper) wrapper.style.display = _fsImgHistory.length ? '' : 'none';
    _updateEmptyState();

    strip.innerHTML = '';
    _fsImgHistory.forEach(function(item, idx) {
      var card = document.createElement('div');
      card.style.cssText = 'flex:0 0 130px;border-radius:8px;overflow:hidden;background:var(--surface-2);border:1px solid var(--border-2);flex-shrink:0;position:relative;';
      card.innerHTML =
        // Delete ✕ — top-right corner
        '<div style="position:absolute;top:4px;right:4px;z-index:2;">'
          + '<button onclick="event.stopPropagation();deleteFsImgResult(' + idx + ')" title="Delete" '
            + 'style="width:18px;height:18px;border-radius:50%;background:rgba(0,0,0,0.65);border:1px solid rgba(255,255,255,0.2);color:rgba(255,255,255,0.7);font-size:10px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;line-height:1;">✕</button>'
        + '</div>'
        + '<img src="' + item.dataUrl + '" style="width:100%;aspect-ratio:9/16;object-fit:cover;display:block;cursor:zoom-in;" title="Expand">'
        + '<div style="padding:4px;display:flex;gap:2px;flex-wrap:wrap;">'
          + '<button onclick="downloadFsImgResult(' + idx + ')" style="flex:1;padding:3px 2px;font-size:9px;font-weight:700;font-family:inherit;background:rgba(52,211,153,0.1);border:1px solid rgba(52,211,153,0.3);border-radius:5px;color:#34d399;cursor:pointer;" title="Download">⬇</button>'
          + '<button onclick="useFsImgResultAsRef(' + idx + ')" style="flex:1;padding:3px 2px;font-size:9px;font-weight:700;font-family:inherit;background:rgba(251,146,60,0.1);border:1px solid rgba(251,146,60,0.3);border-radius:5px;color:#fb923c;cursor:pointer;" title="Use as image reference">→ Ref</button>'
          + '<button onclick="useFsImgResultAsVidStart(' + idx + ')" style="flex:1;padding:3px 2px;font-size:9px;font-weight:700;font-family:inherit;background:rgba(139,92,246,0.1);border:1px solid rgba(139,92,246,0.3);border-radius:5px;color:#a78bfa;cursor:pointer;" title="Use as video start frame">→ Vid</button>'
        + '</div>';
      var imgEl = card.querySelector('img');
      if (imgEl) imgEl.addEventListener('click', (function(url, i) { return function() { _fsOpenLightbox(url, i); }; })(item.dataUrl, idx));
      strip.appendChild(card);
    });
  }

  // ── Image lightbox ─────────────────────────────────────────────────────────
  function _fsOpenLightbox(dataUrl, idx) {
    var existing = document.getElementById('fsImgLightbox');
    if (existing) existing.remove();

    var modal = document.createElement('div');
    modal.id = 'fsImgLightbox';
    modal.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.92);display:flex;align-items:center;justify-content:center;padding:16px;cursor:zoom-out;';

    var inner = document.createElement('div');
    inner.style.cssText = 'position:relative;max-width:min(480px, 90vw);max-height:90vh;display:flex;flex-direction:column;align-items:center;gap:10px;';

    var img = document.createElement('img');
    img.src = dataUrl;
    img.style.cssText = 'max-width:100%;max-height:80vh;object-fit:contain;border-radius:12px;display:block;box-shadow:0 8px 40px rgba(0,0,0,0.6);';
    img.onclick = function(e) { e.stopPropagation(); };

    var closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = 'position:absolute;top:-14px;right:-14px;width:32px;height:32px;border-radius:50%;background:rgba(255,255,255,0.15);border:1px solid rgba(255,255,255,0.3);color:#fff;font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px);';
    closeBtn.onclick = function(e) { e.stopPropagation(); modal.remove(); };

    var actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;justify-content:center;';

    var dlBtn = document.createElement('button');
    dlBtn.textContent = '⬇ Download';
    dlBtn.style.cssText = 'padding:8px 16px;font-size:11px;font-weight:700;font-family:inherit;background:rgba(52,211,153,0.15);border:1px solid rgba(52,211,153,0.45);border-radius:8px;color:#34d399;cursor:pointer;';
    dlBtn.onclick = function(e) { e.stopPropagation(); var a = document.createElement('a'); a.href = dataUrl; a.download = 'studio-result.png'; a.click(); };

    var refBtn = document.createElement('button');
    refBtn.textContent = '→ Use as Ref';
    refBtn.style.cssText = 'padding:8px 16px;font-size:11px;font-weight:700;font-family:inherit;background:rgba(251,146,60,0.15);border:1px solid rgba(251,146,60,0.45);border-radius:8px;color:#fb923c;cursor:pointer;';
    refBtn.onclick = function(e) { e.stopPropagation(); modal.remove(); if (typeof idx === 'number') useFsImgResultAsRef(idx); };

    var vidBtn = document.createElement('button');
    vidBtn.textContent = '→ Start Video';
    vidBtn.style.cssText = 'padding:8px 16px;font-size:11px;font-weight:700;font-family:inherit;background:rgba(139,92,246,0.15);border:1px solid rgba(139,92,246,0.45);border-radius:8px;color:#a78bfa;cursor:pointer;';
    vidBtn.onclick = function(e) { e.stopPropagation(); modal.remove(); if (typeof idx === 'number') useFsImgResultAsVidStart(idx); };

    actions.appendChild(dlBtn);
    actions.appendChild(refBtn);
    actions.appendChild(vidBtn);
    actions.onclick = function(e) { e.stopPropagation(); };

    inner.appendChild(closeBtn);
    inner.appendChild(img);
    inner.appendChild(actions);
    modal.appendChild(inner);
    modal.addEventListener('click', function() { modal.remove(); });

    // Close on Escape
    function onKey(e) { if (e.key === 'Escape') { modal.remove(); document.removeEventListener('keydown', onKey); } }
    document.addEventListener('keydown', onKey);

    document.body.appendChild(modal);
  }

  // ── Studio 1080p upscale (reuses the gallery upscaler) ──
  function fsUpscale1080(idx) {
    var item = _fsVidHistory[idx];
    if (!item) return;
    var url = item.gcsUrl || item.src;
    if (typeof window._doUpscale === 'function') {
      window._doUpscale(url, 'studio-video-' + (idx + 1) + '-1080p.mp4', 'fs-hd-' + idx);
    } else if (typeof showToast === 'function') {
      showToast('1080p upscale is not available right now.', 'warning');
    }
  }
  window.fsUpscale1080 = fsUpscale1080;

  // ── Render video results strip ─────────────────────────────────────────────
  function _renderVidStrip() {
    var strip   = document.getElementById('fsVidStrip');
    var wrapper = document.getElementById('fsVidResults');
    var countEl = document.getElementById('fsVidResultCount');
    if (!strip) return;
    var doneCount = _fsVidHistory.filter(function(i) { return !i.pending; }).length;
    if (countEl) countEl.textContent = doneCount;
    if (wrapper) wrapper.style.display = _fsVidHistory.length ? '' : 'none';
    _updateEmptyState();

    strip.innerHTML = '';
    _fsVidHistory.forEach(function(item, idx) {
      var card = document.createElement('div');
      card.style.cssText = 'flex:0 0 150px;border-radius:8px;overflow:hidden;background:var(--surface-2);border:1px solid var(--border-2);flex-shrink:0;position:relative;';

      // Pending placeholder — show spinner while generation is in flight
      if (item.pending) {
        card.style.cssText += 'display:flex;flex-direction:column;align-items:center;justify-content:center;aspect-ratio:9/16;gap:8px;';
        card.innerHTML =
          '<div style="width:20px;height:20px;border:2px solid rgba(52,211,153,0.2);border-top-color:#34d399;border-radius:50%;animation:spin 0.8s linear infinite;"></div>'
          + '<span style="font-size:9px;color:var(--text-3);text-align:center;padding:0 8px;">generating…</span>';
        strip.appendChild(card);
        return;
      }

      card.innerHTML =
        // Delete ✕ — top-right corner
        '<div style="position:absolute;top:4px;right:4px;z-index:2;">'
          + '<button onclick="event.stopPropagation();deleteFsVidResult(' + idx + ')" title="Delete" '
            + 'style="width:18px;height:18px;border-radius:50%;background:rgba(0,0,0,0.65);border:1px solid rgba(255,255,255,0.2);color:rgba(255,255,255,0.7);font-size:10px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;line-height:1;">✕</button>'
        + '</div>'
        + '<video src="' + item.src + '" muted playsinline loop style="width:100%;aspect-ratio:9/16;object-fit:cover;display:block;cursor:pointer;" title="Click to preview"></video>'
        + '<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity 0.15s;background:rgba(0,0,0,0.25);" class="fs-vid-overlay">'
          + '<div style="width:36px;height:36px;border-radius:50%;background:rgba(0,0,0,0.65);border:2px solid rgba(255,255,255,0.8);display:flex;align-items:center;justify-content:center;font-size:14px;color:#fff;padding-left:2px;">▶</div>'
        + '</div>'
        + '<div style="padding:5px;display:flex;gap:3px;">'
          + '<button onclick="previewFsVid(' + idx + ')" title="Preview" style="flex:0 0 26px;padding:4px 2px;font-size:9px;font-weight:700;font-family:inherit;background:rgba(56,189,248,0.1);border:1px solid rgba(56,189,248,0.3);border-radius:5px;color:#38bdf8;cursor:pointer;">▶</button>'
          + '<button onclick="downloadFsVidResult(' + idx + ')" title="Download 720p" style="flex:1;padding:4px 2px;font-size:9px;font-weight:700;font-family:inherit;background:rgba(52,211,153,0.1);border:1px solid rgba(52,211,153,0.3);border-radius:5px;color:#34d399;cursor:pointer;">720p</button>'
          + '<button id="fs-hd-' + idx + '" onclick="fsUpscale1080(' + idx + ')" title="Upscale &amp; download in 1080p HD" style="flex:1;padding:4px 2px;font-size:9px;font-weight:800;font-family:inherit;background:rgba(16,185,129,0.16);border:1px solid rgba(16,185,129,0.45);border-radius:5px;color:#34d399;cursor:pointer;">1080p</button>'
        + '</div>';

      var vid     = card.querySelector('video');
      var overlay = card.querySelector('.fs-vid-overlay');

      // Hover: show play overlay + silent preview
      card.addEventListener('mouseenter', function() {
        if (overlay) overlay.style.opacity = '1';
        if (vid) vid.play().catch(function(){});
      });
      card.addEventListener('mouseleave', function() {
        if (overlay) overlay.style.opacity = '0';
        if (vid) { vid.pause(); vid.currentTime = 0; }
      });

      // Click thumbnail → open preview modal
      if (vid) vid.addEventListener('click', function() { previewFsVid(idx); });
      if (overlay) overlay.addEventListener('click', function() { previewFsVid(idx); });

      strip.appendChild(card);
    });
  }

  // ── Video preview modal ────────────────────────────────────────────────────
  window.previewFsVid = function(idx) {
    var item = _fsVidHistory[idx];
    if (!item || !item.src) return;

    var existing = document.getElementById('fsVidPreviewModal');
    if (existing) existing.remove();

    var modal = document.createElement('div');
    modal.id = 'fsVidPreviewModal';
    modal.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.92);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:16px;';
    modal.innerHTML =
      '<div style="position:relative;width:100%;max-width:380px;">'
        + '<video src="' + item.src + '" controls autoplay playsinline '
          + 'style="width:100%;border-radius:12px;background:#000;display:block;max-height:80vh;"></video>'
        + '<button onclick="document.getElementById(\'fsVidPreviewModal\').remove()" '
          + 'style="position:absolute;top:-14px;right:-14px;width:32px;height:32px;border-radius:50%;'
          + 'background:rgba(255,255,255,0.15);border:1px solid rgba(255,255,255,0.3);'
          + 'color:#fff;font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;'
          + 'backdrop-filter:blur(4px);">✕</button>'
        + '<div style="display:flex;gap:8px;margin-top:10px;justify-content:center;">'
          + '<button onclick="downloadFsVidResult(' + idx + ')" '
            + 'style="padding:8px 20px;font-size:11px;font-weight:700;font-family:inherit;'
            + 'background:rgba(52,211,153,0.15);border:1px solid rgba(52,211,153,0.45);'
            + 'border-radius:8px;color:#34d399;cursor:pointer;">⬇ Download</button>'
          + (idx > 0
            ? '<button onclick="previewFsVid(' + (idx - 1) + ')" style="padding:8px 14px;font-size:11px;font-weight:700;font-family:inherit;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);border-radius:8px;color:var(--text-2);cursor:pointer;">‹ Prev</button>'
            : '')
          + (idx < _fsVidHistory.length - 1
            ? '<button onclick="previewFsVid(' + (idx + 1) + ')" style="padding:8px 14px;font-size:11px;font-weight:700;font-family:inherit;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);border-radius:8px;color:var(--text-2);cursor:pointer;">Next ›</button>'
            : '')
        + '</div>'
        + '<div style="text-align:center;margin-top:6px;font-size:9px;color:var(--text-4);">Video ' + (idx + 1) + ' of ' + _fsVidHistory.length + '</div>'
      + '</div>';

    // Click backdrop to close
    modal.addEventListener('click', function(e) { if (e.target === modal) modal.remove(); });
    // Escape key to close
    var _escClose = function(e) { if (e.key === 'Escape') { modal.remove(); document.removeEventListener('keydown', _escClose); } };
    document.addEventListener('keydown', _escClose);

    document.body.appendChild(modal);
  };

  // ── Download functions ─────────────────────────────────────────────────────
  window.downloadFsImgResult = function(idx) {
    var item = _fsImgHistory[idx];
    if (!item) return;
    var a = document.createElement('a');
    a.href = item.dataUrl; // base64 data URL — same-origin, download works fine
    a.download = 'studio-image-' + (idx + 1) + '.png';
    a.click();
  };

  window.downloadFsVidResult = async function(idx) {
    var item = _fsVidHistory[idx];
    if (!item || !item.src) return;
    // item.src is always a blob URL — download works without cross-origin issues
    var a = document.createElement('a');
    a.href = item.src;
    a.download = 'studio-video-' + (idx + 1) + '.mp4';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  // ── Use image result as new reference ─────────────────────────────────────
  window.useFsImgResultAsRef = function(idx) {
    var item = _fsImgHistory[idx];
    if (!item) return;

    var dataUrl = item.dataUrl;
    var comma   = dataUrl.indexOf(',');
    _fsImgSlots[0] = { dataUrl: dataUrl, b64: dataUrl.slice(comma + 1), mime: dataUrl.slice(5, comma).split(';')[0] || 'image/png' };
    // Clear slots 1-4 so the generated image is cleanly in slot 0
    for (var i = 1; i < 5; i++) { _fsImgSlots[i] = null; _fsRenderSlot(i); }
    _fsRenderSlot(0);

    var promptEl = document.getElementById('fsImgPrompt');
    if (promptEl) { promptEl.value = ''; promptEl.focus(); }

    if (typeof showToast === 'function') showToast('Set as Photo 1 — enter a new prompt to continue editing.', 'success', 3500);
  };

  // ── GENERATE IMAGE ─────────────────────────────────────────────────────────
  window.generateFsImage = async function() {
    var loaded = _fsImgSlots.filter(Boolean);
    // Reference photos are OPTIONAL. With none, this is straight text-to-image
    // generation; with photos, it's reference-guided editing. Only the prompt is required.
    var promptEl = document.getElementById('fsImgPrompt');
    var casual   = promptEl ? promptEl.value.trim() : '';
    if (!casual) {
      if (typeof showToast === 'function') showToast('Enter a prompt first.', 'warning'); return;
    }

    var jwt = await _fsJwt();
    if (!jwt) { if (typeof showToast === 'function') showToast('Please log in.', 'warning'); return; }

    _fsSavePrompt('image', casual); // persist to history

    var varSel  = document.getElementById('fsImgVariations');
    var varCount = varSel ? Math.max(1, Math.min(3, parseInt(varSel.value) || 1)) : 1;

    // Precheck balance for ALL variations up front. The backend charges per image only
    // AFTER success, so each parallel variation passes the single-frame gate independently;
    // without this, a low-balance user could receive more images than they can pay for.
    var _imgModelEl0 = document.getElementById('fsImgModel');
    var _costPerImg  = (_imgModelEl0 && _imgModelEl0.value === 'pro') ? 5 : 2;
    if (typeof window.userCredits === 'number' && window.userCredits < _costPerImg * varCount) {
      if (typeof showToast === 'function') showToast('Not enough credits for ' + varCount + ' image' + (varCount > 1 ? 's' : '') + ' (' + (_costPerImg * varCount) + ' needed). Lower the variation count or top up.', 'warning', 5000);
      return;
    }

    var btn     = document.getElementById('fsBtnGenImg');
    var spinner = document.getElementById('fsImgSpinner');
    if (btn)    { btn.disabled = true; btn.textContent = varCount === 1 ? '✨ Generating…' : '✨ Generating ' + varCount + '…'; }
    if (spinner) spinner.style.display = 'flex';

    try {
      _fsStatus('fsImgStatusTxt', '✦ Enhancing prompt…', 'rgba(139,92,246,0.9)');
      var photoContext = loaded.length > 1
        ? 'I have ' + loaded.length + ' reference photos (' + loaded.map(function(_,i){ return 'Photo '+(i+1); }).join(', ') + '). '
        : '';
      var instruction = casual;
      try {
        var _imgSys = loaded.length ? _FS_IMG_SYS : _FS_IMG_GEN_SYS;
        var raw = await _fsGpt(_imgSys, photoContext + casual, jwt, 400);
        raw = raw.replace(/```json\s*/gi,'').replace(/```\s*/gi,'').trim();
        instruction = JSON.parse(raw).instruction || casual;
      } catch(_) {}

      _fsStatus('fsImgStatusTxt', varCount === 1 ? '✦ Generating image…' : '✦ Generating ' + varCount + ' variations…', 'rgba(52,211,153,0.9)');

      var images = [];
      for (var i = 0; i < loaded.length; i++) {
        var compressed = await _fsCompress(loaded[i].dataUrl, 768, 0.80);
        var comma = compressed.indexOf(',');
        images.push({ b64: compressed.slice(comma + 1), mime: compressed.slice(5, comma).split(';')[0] || 'image/jpeg' });
      }

      var _imgModelEl = document.getElementById('fsImgModel');
      var _imgQuality = (_imgModelEl && _imgModelEl.value === 'pro') ? 'pro' : 'flash';
      var payloadObj = { instruction: instruction, images: images, creative: true, quality: _imgQuality };

      function _doFetch() {
        // Use the shared retry helper (auto-retries on a Vertex DSQ 429) when available
        if (typeof window._nbPostComposite === 'function') {
          return window._nbPostComposite(payloadObj, jwt, 'Studio')
            .then(function(r) { return { ok: !!(r.res && r.res.ok), data: r.data || {} }; })
            .catch(function(e) { return { ok: false, data: { error: e.message } }; });
        }
        return fetch('/.netlify/functions/generate-nb-composite', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + jwt },
          body: JSON.stringify(payloadObj),
        }).then(function(r) { return r.json().then(function(d) { return { ok: r.ok, data: d }; }); })
          .catch(function(e) { return { ok: false, data: { error: e.message } }; });
      }

      var results = await Promise.all(Array.from({ length: varCount }, _doFetch));

      var newItems = [];
      var errors   = [];
      results.forEach(function(r) {
        if (r.ok && r.data && r.data.imageB64) {
          newItems.push({ dataUrl: 'data:' + (r.data.mime || 'image/png') + ';base64,' + r.data.imageB64, id: Date.now() + Math.random() });
        } else {
          errors.push(r.data && r.data.error ? r.data.error : 'No image returned');
        }
      });

      if (!newItems.length) throw new Error(errors[0] || ('All ' + varCount + ' variation' + (varCount > 1 ? 's' : '') + ' failed — try rephrasing your prompt.'));

      // Add to history newest-first, cap at max
      newItems.reverse().forEach(function(item) { _fsImgHistory.unshift(item); });
      if (_fsImgHistory.length > _MAX_HISTORY) _fsImgHistory.length = _MAX_HISTORY;
      _renderImgStrip();
      _fsSaveImgHistory();

      // Scroll the strip to show the newest results
      var strip = document.getElementById('fsImgStrip');
      if (strip) strip.scrollLeft = 0;

      _fsStatus('fsImgStatusTxt', '', '');
      var msg = newItems.length === varCount
        ? (varCount === 1 ? 'Image generated!' : varCount + ' variations generated!')
        : newItems.length + ' of ' + varCount + ' variations generated.';
      if (typeof showToast === 'function') showToast(msg, 'success', 3000);

    } catch(e) {
      _fsStatus('fsImgStatusTxt', '', '');
      if (typeof showToast === 'function') showToast('Image error: ' + (e.message || e), 'error', 6000);
    } finally {
      if (btn)     { btn.disabled = false; btn.textContent = '✨ Generate'; }
      if (spinner)  spinner.style.display = 'none';
    }
  };

  // ── GENERATE VIDEO ─────────────────────────────────────────────────────────
  // Tracks how many generations are currently in flight so the button label
  // stays informative and the button is NEVER disabled — new generations can
  // always be started while others are running.
  var _fsVidActiveCount = 0;

  function _fsVidUpdateBtn() {
    var btn = document.getElementById('fsBtnGenVid');
    if (!btn) return;
    btn.textContent = _fsVidActiveCount > 0
      ? '⚡ Generate (' + _fsVidActiveCount + '…)'
      : '⚡ Generate';
  }

  // Run a single video generation. Shows a pending placeholder card in the
  // strip immediately so the user can see progress without blocking new runs.
  async function _runOneVidGeneration(pendingId, casual, dur, jwt, startImg, refFrameUrl, enhFrameB64, enhFrameMime) {
    _fsVidActiveCount++;
    _fsVidUpdateBtn();

    try {
      if (typeof generateVeoClipViaAPI !== 'function') throw new Error('Veo API not loaded — refresh the page.');

      // Build enhanced prompt via Gemini 2.5 Flash
      var veoFields = { action: casual, speech: '', negative_prompt: 'text overlays, captions, watermarks, subtitles, jump cuts, scene changes, transitions, blurry' };
      try {
        var enhPayload = { casual: casual, duration: dur };
        if (enhFrameB64) {
          enhPayload.frameB64  = enhFrameB64;
          enhPayload.frameMime = enhFrameMime || 'image/jpeg';
        }
        var enhRes  = await fetch('/.netlify/functions/enhance-veo-prompt', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + jwt },
          body:    JSON.stringify(enhPayload),
        });
        var enhData; try { enhData = await enhRes.json(); } catch(_) { enhData = {}; }
        if (enhRes.ok && enhData.action) veoFields = Object.assign(veoFields, enhData);
      } catch(_) {}

      var veoJson = JSON.stringify({
        action:          veoFields.action,
        speech:          (veoFields.speech || '').toLowerCase(),
        duration:        dur,
        negative_prompt: veoFields.negative_prompt || 'text overlays, captions, watermarks, subtitles, jump cuts, scene changes, transitions, blurry',
      });

      // Prefer the per-render quality selector in the Studio toolbar; fall back to the
      // account default if it isn't present.
      var _selModelEl = document.getElementById('fsVidModel');
      var _selModel   = _selModelEl && _selModelEl.value;
      var modelKey;
      if (_selModel === 'lite' || _selModel === 'fast' || _selModel === 'standard') {
        modelKey = _selModel;
      } else {
        var adm = (typeof getAdminSettings === 'function') ? getAdminSettings() : {};
        var _dm = (adm.defaultModel || 'Veo 3.1 Lite').toLowerCase();
        modelKey = _dm.includes('fast') ? 'fast' : _dm.includes('standard') ? 'standard' : 'lite';
      }

      var result = await generateVeoClipViaAPI(veoJson, dur, modelKey, startImg, refFrameUrl);

      var blobSrc = null;
      if (typeof window._fetchVideoAsBlob === 'function') {
        blobSrc = await window._fetchVideoAsBlob(result.videoUrl);
      }
      var finalSrc = blobSrc || result.videoUrl;

      // Replace the pending placeholder with the real video
      var idx = _fsVidHistory.findIndex(function(item) { return item.id === pendingId; });
      if (idx !== -1) {
        _fsVidHistory[idx] = { src: finalSrc, id: pendingId, mime: 'video/mp4', gcsUrl: result.videoUrl };
      } else {
        _fsVidHistory.unshift({ src: finalSrc, id: pendingId, mime: 'video/mp4', gcsUrl: result.videoUrl });
      }
      if (_fsVidHistory.length > _MAX_HISTORY) _fsVidHistory.length = _MAX_HISTORY;
      _renderVidStrip();
      _fsSaveVidHistory();

      var strip = document.getElementById('fsVidStrip');
      if (strip) strip.scrollLeft = 0;

      if (typeof refreshCreditBalance === 'function') refreshCreditBalance();
      if (typeof showToast === 'function') showToast('Video ready!', 'success', 4000);

    } catch(e) {
      // Remove the pending placeholder on failure
      var idx2 = _fsVidHistory.findIndex(function(item) { return item.id === pendingId; });
      if (idx2 !== -1) _fsVidHistory.splice(idx2, 1);
      _renderVidStrip();
      if (typeof showToast === 'function') showToast('Video failed: ' + (e.message || e), 'error', 7000);
    } finally {
      _fsVidActiveCount--;
      _fsVidUpdateBtn();
    }
  }

  window.generateFsVideo = async function() {
    var promptEl = document.getElementById('fsVidPrompt');
    var casual   = promptEl ? promptEl.value.trim() : '';
    if (!casual) {
      if (typeof showToast === 'function') showToast('Enter a video prompt first.', 'warning'); return;
    }

    var durEl    = document.querySelector('#fsVidDuration .fs-dur-btn.active');
    var dur      = durEl ? parseInt(durEl.dataset.dur) || 6 : 6;
    var varSel   = document.getElementById('fsVidVariations');
    var varCount = varSel ? Math.max(1, Math.min(3, parseInt(varSel.value) || 1)) : 1;

    var jwt = await _fsJwt();
    if (!jwt) { if (typeof showToast === 'function') showToast('Please log in.', 'warning'); return; }

    _fsSavePrompt('video', casual); // persist to history

    // Pre-compress frames once — shared across all parallel generations
    var startImg    = null;
    var refFrameUrl = null;
    var enhFrameB64 = null;
    var enhFrameMime = 'image/jpeg';
    if (_fsVidFrame && _fsVidFrame.dataUrl) {
      var cf      = await _fsCompress(_fsVidFrame.dataUrl, 1024, 0.85);
      startImg    = cf;
      refFrameUrl = _fsVidFrame.dataUrl;
      // Separate 768px version for enhance-veo-prompt (multimodal, smaller = faster)
      var ef   = await _fsCompress(_fsVidFrame.dataUrl, 768, 0.80);
      var em   = ef.indexOf(',');
      enhFrameB64  = ef.slice(em + 1);
      enhFrameMime = ef.slice(5, em).split(';')[0] || 'image/jpeg';
    }

    // Add pending placeholder cards immediately so user sees activity
    var pendingIds = [];
    for (var i = 0; i < varCount; i++) {
      var pid = Date.now() + i;
      pendingIds.push(pid);
      _fsVidHistory.unshift({ pending: true, id: pid });
    }
    var wrapper = document.getElementById('fsVidResults');
    if (wrapper) wrapper.style.display = '';
    _renderVidStrip();
    var strip = document.getElementById('fsVidStrip');
    if (strip) strip.scrollLeft = 0;

    // Fire all generations in parallel — each manages its own placeholder
    pendingIds.forEach(function(pid) {
      _runOneVidGeneration(pid, casual, dur, jwt, startImg, refFrameUrl, enhFrameB64, enhFrameMime);
    });
  };

  // ── Duration toggle ────────────────────────────────────────────────────────
  window.setFsDur = function(el) {
    document.querySelectorAll('#fsVidDuration .fs-dur-btn').forEach(function(b) {
      b.classList.remove('active');
      b.style.background  = 'var(--surface-2)';
      b.style.borderColor = 'var(--border-2)';
      b.style.color       = 'var(--text-3)';
    });
    el.classList.add('active');
    el.style.background  = 'rgba(52,211,153,0.18)';
    el.style.borderColor = 'rgba(52,211,153,0.55)';
    el.style.color       = '#34d399';
  };

  window.fsAutoGrow = function(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  };

  // ── IndexedDB persistence ──────────────────────────────────────────────────
  // Images:  store full dataUrl strings (already in memory, JSON-serializable).
  // Videos:  blob URLs die on refresh — convert to ArrayBuffer before saving,
  //          recreate blob URLs on load. Cap video persistence at 5 items.
  var _FS_DB_NAME    = 'fsStudio';
  var _FS_DB_VERSION = 1;
  var _FS_VID_PERSIST_MAX = 5;
  var _fsDb = null;

  function _fsOpenDb() {
    if (_fsDb) return Promise.resolve(_fsDb);
    return new Promise(function(resolve, reject) {
      var req = indexedDB.open(_FS_DB_NAME, _FS_DB_VERSION);
      req.onupgradeneeded = function(e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains('imgHistory')) db.createObjectStore('imgHistory', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('vidHistory')) db.createObjectStore('vidHistory', { keyPath: 'id' });
      };
      req.onsuccess = function(e) { _fsDb = e.target.result; resolve(_fsDb); };
      req.onerror   = function(e) { reject(e.target.error); };
    });
  }

  function _fsPutAll(storeName, items) {
    return _fsOpenDb().then(function(db) {
      return new Promise(function(resolve, reject) {
        var tx    = db.transaction(storeName, 'readwrite');
        var store = tx.objectStore(storeName);
        store.clear();
        items.forEach(function(item) { store.put(item); });
        tx.oncomplete = resolve;
        tx.onerror    = function(e) { reject(e.target.error); };
      });
    });
  }

  function _fsGetAll(storeName) {
    return _fsOpenDb().then(function(db) {
      return new Promise(function(resolve, reject) {
        var tx    = db.transaction(storeName, 'readonly');
        var req   = tx.objectStore(storeName).getAll();
        req.onsuccess = function(e) { resolve(e.target.result || []); };
        req.onerror   = function(e) { reject(e.target.error); };
      });
    });
  }

  // Save image history — called after every image generation
  function _fsSaveImgHistory() {
    _fsPutAll('imgHistory', _fsImgHistory).catch(function(e) {
      console.warn('fsStudio: could not save image history:', e);
    });
  }

  // Save video history — convert blob URLs to ArrayBuffers first
  function _fsSaveVidHistory() {
    var toSave = _fsVidHistory.slice(0, _FS_VID_PERSIST_MAX);
    Promise.all(toSave.map(function(item) {
      if (item.pending || !item.src) return Promise.resolve(null); // skip in-flight placeholders
      if (item.arrayBuffer) return Promise.resolve(item); // already converted
      return fetch(item.src)
        .then(function(r) { return r.arrayBuffer(); })
        .then(function(ab) { return { id: item.id, arrayBuffer: ab, mime: item.mime || 'video/mp4' }; })
        .catch(function() { return null; }); // skip if fetch fails
    })).then(function(items) {
      var valid = items.filter(Boolean);
      _fsPutAll('vidHistory', valid).catch(function(e) {
        console.warn('fsStudio: could not save video history:', e);
      });
    });
  }

  // Load both histories on page load
  function _fsRestoreHistory() {
    // Restore images
    _fsGetAll('imgHistory').then(function(items) {
      if (!items.length) return;
      // Sort by id descending (newest first) then restore
      items.sort(function(a, b) { return b.id - a.id; });
      _fsImgHistory = items.slice(0, _MAX_HISTORY);
      _renderImgStrip();
    }).catch(function(e) { console.warn('fsStudio: could not restore image history:', e); });

    // Restore videos — recreate blob URLs from stored ArrayBuffers
    _fsGetAll('vidHistory').then(function(items) {
      if (!items.length) return;
      items.sort(function(a, b) { return b.id - a.id; });
      var restored = items.map(function(item) {
        var blob    = new Blob([item.arrayBuffer], { type: item.mime || 'video/mp4' });
        var blobUrl = URL.createObjectURL(blob);
        return { src: blobUrl, id: item.id, mime: item.mime, arrayBuffer: item.arrayBuffer };
      });
      _fsVidHistory = restored;
      _renderVidStrip();
    }).catch(function(e) { console.warn('fsStudio: could not restore video history:', e); });
  }

  // Expose a clear function for the UI
  window.fsClearHistory = function(which) {
    if (!which || which === 'img') {
      _fsImgHistory = [];
      _fsPutAll('imgHistory', []).catch(function(){});
      _renderImgStrip();
    }
    if (!which || which === 'vid') {
      _fsVidHistory = [];
      _fsPutAll('vidHistory', []).catch(function(){});
      _renderVidStrip();
    }
    if (typeof showToast === 'function') showToast('History cleared.', 'success', 2500);
  };

  // Kick off restore + UI init when DOM is ready
  function _fsOnReady() {
    _fsRestoreHistory();
    _fsInitPromptHistory();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _fsOnReady);
  } else {
    _fsOnReady();
  }

})();
