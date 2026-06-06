// ===== STUDIO =====
// Mode toggle: Generate Image (up to 5 reference photos) | Generate Video (optional start frame)
// Results are kept in a persistent scrollable strip — new generations appear alongside old ones.
// GPT-4o-mini enhances casual prompts → Gemini image gen / Veo 3 video gen

(function() {

  // ── State ──────────────────────────────────────────────────────────────────
  var _fsMode     = 'image';
  var _fsImgSlots = [null,null,null,null,null]; // {dataUrl,b64,mime}
  var _fsVidFrame = null;                       // {dataUrl,b64,mime}

  // History arrays — results are never replaced, only appended (newest first)
  var _fsImgHistory = []; // [{dataUrl, id}]
  var _fsVidHistory = []; // [{src, id}]       src is always a blob URL
  var _MAX_HISTORY  = 20;

  // Expose state checkers for inline HTML onmouseleave handlers
  window._fsSlotFilled = function(idx) { return !!_fsImgSlots[idx]; };
  window._fsVidFilled  = function()    { return !!_fsVidFrame; };

  // ── Mode toggle ────────────────────────────────────────────────────────────
  window.switchFsMode = function(mode) {
    _fsMode = mode;
    var imgPanel = document.getElementById('fsImgPanel');
    var vidPanel = document.getElementById('fsVidPanel');
    var imgBtn   = document.getElementById('fsModeImgBtn');
    var vidBtn   = document.getElementById('fsModeVidBtn');
    if (imgPanel) imgPanel.style.display = mode === 'image' ? '' : 'none';
    if (vidPanel) vidPanel.style.display = mode === 'video' ? '' : 'none';
    _fsStyleModeBtn(imgBtn, mode === 'image');
    _fsStyleModeBtn(vidBtn, mode === 'video');
  };

  function _fsStyleModeBtn(btn, active) {
    if (!btn) return;
    btn.style.background  = active ? 'rgba(52,211,153,0.18)' : 'var(--surface-2)';
    btn.style.borderColor = active ? 'rgba(52,211,153,0.55)' : 'var(--border-2)';
    btn.style.color       = active ? '#34d399'               : 'var(--text-3)';
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

  var _FS_VID_SYS = 'You are a Veo 3 video prompt engineer. Rewrite the user\'s casual description into a precise clip prompt. Return ONLY: {"action":"<precise physical movement and camera description, under 60 words>","speech":"<exact spoken words, or empty string if none>","negative_prompt":"text overlays, captions, watermarks, subtitles, jump cuts, scene changes, blurry"}';

  // ── Status helper ──────────────────────────────────────────────────────────
  function _fsStatus(elId, text, color) {
    var el = document.getElementById(elId);
    if (!el) return;
    el.textContent  = text;
    el.style.color  = color || 'var(--text-3)';
    el.style.display = text ? '' : 'none';
  }

  // ── Render image results strip ─────────────────────────────────────────────
  function _renderImgStrip() {
    var strip   = document.getElementById('fsImgStrip');
    var wrapper = document.getElementById('fsImgResults');
    var countEl = document.getElementById('fsImgResultCount');
    if (!strip) return;
    if (countEl) countEl.textContent = _fsImgHistory.length;
    if (wrapper) wrapper.style.display = _fsImgHistory.length ? '' : 'none';

    strip.innerHTML = '';
    _fsImgHistory.forEach(function(item, idx) {
      var card = document.createElement('div');
      card.style.cssText = 'flex:0 0 130px;border-radius:8px;overflow:hidden;background:var(--surface-2);border:1px solid var(--border-2);flex-shrink:0;';
      card.innerHTML =
        '<img src="' + item.dataUrl + '" style="width:100%;aspect-ratio:9/16;object-fit:cover;display:block;cursor:pointer;" title="Click to use as new reference">'
        + '<div style="padding:5px;display:flex;gap:3px;">'
          + '<button onclick="downloadFsImgResult(' + idx + ')" style="flex:1;padding:4px 2px;font-size:9px;font-weight:700;font-family:inherit;background:rgba(52,211,153,0.1);border:1px solid rgba(52,211,153,0.3);border-radius:5px;color:#34d399;cursor:pointer;" title="Download">⬇</button>'
          + '<button onclick="useFsImgResultAsRef(' + idx + ')" style="flex:1;padding:4px 2px;font-size:9px;font-weight:700;font-family:inherit;background:rgba(251,146,60,0.1);border:1px solid rgba(251,146,60,0.3);border-radius:5px;color:#fb923c;cursor:pointer;" title="Use as new reference">→ Ref</button>'
        + '</div>';
      var imgEl = card.querySelector('img');
      if (imgEl) imgEl.addEventListener('click', function() { useFsImgResultAsRef(idx); });
      strip.appendChild(card);
    });
  }

  // ── Render video results strip ─────────────────────────────────────────────
  function _renderVidStrip() {
    var strip   = document.getElementById('fsVidStrip');
    var wrapper = document.getElementById('fsVidResults');
    var countEl = document.getElementById('fsVidResultCount');
    if (!strip) return;
    if (countEl) countEl.textContent = _fsVidHistory.length;
    if (wrapper) wrapper.style.display = _fsVidHistory.length ? '' : 'none';

    strip.innerHTML = '';
    _fsVidHistory.forEach(function(item, idx) {
      var card = document.createElement('div');
      card.style.cssText = 'flex:0 0 150px;border-radius:8px;overflow:hidden;background:var(--surface-2);border:1px solid var(--border-2);flex-shrink:0;';
      card.innerHTML =
        '<video src="' + item.src + '" muted playsinline loop style="width:100%;aspect-ratio:9/16;object-fit:cover;display:block;cursor:pointer;"></video>'
        + '<div style="padding:5px;">'
          + '<button onclick="downloadFsVidResult(' + idx + ')" style="width:100%;padding:5px;font-size:9px;font-weight:700;font-family:inherit;background:rgba(52,211,153,0.1);border:1px solid rgba(52,211,153,0.3);border-radius:5px;color:#34d399;cursor:pointer;">⬇ Download</button>'
        + '</div>';
      var vid = card.querySelector('video');
      if (vid) {
        card.addEventListener('mouseenter', function() { vid.play().catch(function(){}); });
        card.addEventListener('mouseleave', function() { vid.pause(); vid.currentTime = 0; });
      }
      strip.appendChild(card);
    });
  }

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
    if (!loaded.length) {
      if (typeof showToast === 'function') showToast('Upload at least one reference photo.', 'warning'); return;
    }
    var promptEl = document.getElementById('fsImgPrompt');
    var casual   = promptEl ? promptEl.value.trim() : '';
    if (!casual) {
      if (typeof showToast === 'function') showToast('Enter a prompt first.', 'warning'); return;
    }

    var jwt = await _fsJwt();
    if (!jwt) { if (typeof showToast === 'function') showToast('Please log in.', 'warning'); return; }

    var btn     = document.getElementById('fsBtnGenImg');
    var spinner = document.getElementById('fsImgSpinner');
    if (btn)    { btn.disabled = true; btn.textContent = 'Working…'; }
    if (spinner) spinner.style.display = 'flex';

    try {
      _fsStatus('fsImgStatusTxt', '✦ Enhancing prompt…', 'rgba(139,92,246,0.9)');
      var photoContext = loaded.length > 1
        ? 'I have ' + loaded.length + ' reference photos (' + loaded.map(function(_,i){ return 'Photo '+(i+1); }).join(', ') + '). '
        : '';
      var instruction = casual;
      try {
        var raw = await _fsGpt(_FS_IMG_SYS, photoContext + casual, jwt, 400);
        raw = raw.replace(/```json\s*/gi,'').replace(/```\s*/gi,'').trim();
        instruction = JSON.parse(raw).instruction || casual;
      } catch(_) {}

      _fsStatus('fsImgStatusTxt', '✦ Generating image…', 'rgba(52,211,153,0.9)');

      var images = [];
      for (var i = 0; i < loaded.length; i++) {
        var compressed = await _fsCompress(loaded[i].dataUrl, 768, 0.80);
        var comma = compressed.indexOf(',');
        images.push({ b64: compressed.slice(comma + 1), mime: compressed.slice(5, comma).split(';')[0] || 'image/jpeg' });
      }

      var res = await fetch('/.netlify/functions/generate-nb-composite', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + jwt },
        body: JSON.stringify({ instruction: instruction, images: images }),
      });
      var data; try { data = await res.json(); } catch(_) { data = {}; }
      if (!res.ok || data.error) throw new Error(data.error || 'HTTP ' + res.status);
      if (!data.imageB64) throw new Error('No image returned — try rephrasing your prompt.');

      var dataUrl = 'data:' + (data.mime || 'image/png') + ';base64,' + data.imageB64;

      // Add to history (newest first), cap at max
      _fsImgHistory.unshift({ dataUrl: dataUrl, id: Date.now() });
      if (_fsImgHistory.length > _MAX_HISTORY) _fsImgHistory.length = _MAX_HISTORY;
      _renderImgStrip();

      // Scroll the strip to show the newest result
      var strip = document.getElementById('fsImgStrip');
      if (strip) strip.scrollLeft = 0;

      _fsStatus('fsImgStatusTxt', '', '');
      if (typeof showToast === 'function') showToast('Image generated!', 'success', 3000);

    } catch(e) {
      _fsStatus('fsImgStatusTxt', '', '');
      if (typeof showToast === 'function') showToast('Image error: ' + (e.message || e), 'error', 6000);
    } finally {
      if (btn)     { btn.disabled = false; btn.textContent = '✨ Generate Image'; }
      if (spinner)  spinner.style.display = 'none';
    }
  };

  // ── GENERATE VIDEO ─────────────────────────────────────────────────────────
  window.generateFsVideo = async function() {
    var promptEl = document.getElementById('fsVidPrompt');
    var casual   = promptEl ? promptEl.value.trim() : '';
    if (!casual) {
      if (typeof showToast === 'function') showToast('Enter a video prompt first.', 'warning'); return;
    }

    var durEl = document.querySelector('#fsVidDuration .fs-dur-btn.active');
    var dur   = durEl ? parseInt(durEl.dataset.dur) || 6 : 6;

    var jwt = await _fsJwt();
    if (!jwt) { if (typeof showToast === 'function') showToast('Please log in.', 'warning'); return; }

    var btn     = document.getElementById('fsBtnGenVid');
    var spinner = document.getElementById('fsVidSpinner');
    if (btn)    { btn.disabled = true; btn.textContent = 'Working…'; }
    if (spinner) spinner.style.display = 'flex';

    try {
      if (typeof generateVeoClipViaAPI !== 'function') throw new Error('Veo API not loaded — refresh the page.');

      _fsStatus('fsVidStatusTxt', '✦ Building prompt with GPT…', 'rgba(139,92,246,0.9)');
      var veoFields = { action: casual, speech: '', negative_prompt: 'text, captions, watermarks, subtitles, blurry' };
      try {
        var raw = await _fsGpt(_FS_VID_SYS, casual, jwt, 400);
        raw = raw.replace(/```json\s*/gi,'').replace(/```\s*/gi,'').trim();
        veoFields = Object.assign(veoFields, JSON.parse(raw));
      } catch(_) {}

      var veoJson = JSON.stringify({
        action:          veoFields.action,
        speech:          veoFields.speech || '',
        duration:        dur,
        negative_prompt: veoFields.negative_prompt || 'text, captions, watermarks, subtitles, blurry',
      });

      _fsStatus('fsVidStatusTxt', '✦ Generating with Veo 3… (~1 min)', 'rgba(52,211,153,0.9)');

      var adm      = (typeof getAdminSettings === 'function') ? getAdminSettings() : {};
      var _dm      = (adm.defaultModel || 'Veo 3.1 Lite').toLowerCase();
      var modelKey = _dm.includes('fast') ? 'fast' : _dm.includes('standard') ? 'standard' : 'lite';

      // Compress start frame if provided
      var startImg = null;
      if (_fsVidFrame) {
        var cf = await _fsCompress(_fsVidFrame.dataUrl, 1024, 0.85);
        startImg = cf;
      }

      var result = await generateVeoClipViaAPI(veoJson, dur, modelKey, startImg);

      // Always resolve to a blob URL — download attribute only works same-origin
      var blobSrc = null;
      if (typeof window._fetchVideoAsBlob === 'function') {
        blobSrc = await window._fetchVideoAsBlob(result.videoUrl);
      }
      var finalSrc = blobSrc || result.videoUrl;

      // Add to history (newest first)
      _fsVidHistory.unshift({ src: finalSrc, id: Date.now() });
      if (_fsVidHistory.length > _MAX_HISTORY) _fsVidHistory.length = _MAX_HISTORY;
      _renderVidStrip();

      var strip = document.getElementById('fsVidStrip');
      if (strip) strip.scrollLeft = 0;

      _fsStatus('fsVidStatusTxt', '', '');
      if (typeof refreshCreditBalance === 'function') refreshCreditBalance();
      if (typeof showToast === 'function') showToast('Video generated!', 'success', 4000);

    } catch(e) {
      _fsStatus('fsVidStatusTxt', '', '');
      if (typeof showToast === 'function') showToast('Video failed: ' + (e.message || e), 'error', 7000);
    } finally {
      if (btn)    { btn.disabled = false; btn.textContent = '⚡ Generate Video'; }
      if (spinner) spinner.style.display = 'none';
    }
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

})();
