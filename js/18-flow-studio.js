// ===== STUDIO =====
// Mode toggle: Generate Image (up to 5 reference photos) | Generate Video (optional start frame)
// GPT-4o-mini enhances casual prompts → Gemini image gen / Veo 3 video gen

(function() {

  // ── State ──────────────────────────────────────────────────────────────────
  var _fsMode        = 'image';                  // 'image' | 'video'
  var _fsImgSlots    = [null,null,null,null,null]; // {dataUrl,b64,mime} per slot
  var _fsVidFrame    = null;                     // {dataUrl,b64,mime} optional start frame
  var _fsGenImgUrl   = null;                     // generated image data URL
  var _fsGenVideoSrc = null;                     // generated video src

  // ── Switch mode ────────────────────────────────────────────────────────────
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
      // Reset file input so same file can be re-selected after clear
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
      slot.style.backgroundImage = 'url(' + img.dataUrl + ')';
      slot.style.backgroundSize  = 'cover';
      slot.style.backgroundPosition = 'center';
      slot.style.borderColor = 'rgba(52,211,153,0.6)';
      if (clearX)  clearX.style.display  = 'flex';
      if (label)   label.style.display   = 'none';
    } else {
      slot.style.backgroundImage = '';
      slot.style.borderColor     = 'rgba(255,255,255,0.1)';
      if (clearX) clearX.style.display  = 'none';
      if (label)  label.style.display   = 'flex';
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

  // ── Read a file into {dataUrl, b64, mime} ──────────────────────────────────
  function _fsReadImageFile(file, cb) {
    var reader = new FileReader();
    reader.onload = function(ev) {
      var dataUrl = ev.target.result;
      var comma   = dataUrl.indexOf(',');
      var mime    = dataUrl.slice(5, comma).split(';')[0] || 'image/jpeg';
      var b64     = dataUrl.slice(comma + 1);
      cb({ dataUrl: dataUrl, b64: b64, mime: mime });
    };
    reader.readAsDataURL(file);
  }

  // ── Compress image ─────────────────────────────────────────────────────────
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

  // ── Get Supabase JWT ───────────────────────────────────────────────────────
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

  // ── GPT system prompts ─────────────────────────────────────────────────────
  var _FS_IMG_SYS = 'You are a prompt engineer for Gemini AI image editing. Rewrite the user\'s casual description into a precise photorealistic instruction. Rules: be specific about placement, lighting, and integration; state that the subject\'s face, skin, hair, clothing, and background must stay unchanged; if multiple reference photos are described in the user message, reference them by number. Return ONLY: {"instruction":"<your detailed instruction>"}';

  var _FS_VID_SYS = 'You are a Veo 3 video prompt engineer. Rewrite the user\'s casual description into a precise clip prompt. Return ONLY: {"action":"<precise physical movement and camera description, under 60 words>","speech":"<exact spoken words, or empty string if none>","negative_prompt":"text overlays, captions, watermarks, subtitles, jump cuts, scene changes, blurry"}';

  // ── Set status text ────────────────────────────────────────────────────────
  function _fsStatus(elId, text, color) {
    var el = document.getElementById(elId);
    if (!el) return;
    el.textContent = text;
    el.style.color = color || 'var(--text-3)';
    el.style.display = text ? '' : 'none';
  }

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
    var result  = document.getElementById('fsImgResult');
    if (btn)    { btn.disabled = true; btn.textContent = 'Working…'; }
    if (spinner) spinner.style.display = 'flex';
    if (result)  result.style.display  = 'none';

    try {
      // GPT enhance
      _fsStatus('fsImgStatusTxt', '✦ Enhancing prompt…', 'rgba(139,92,246,0.9)');
      var photoContext = loaded.length > 1
        ? 'I have ' + loaded.length + ' reference photos (' + loaded.map(function(_,i){return 'Photo '+(i+1);}).join(', ') + ').'
        : '';
      var instruction = casual;
      try {
        var raw = await _fsGpt(_FS_IMG_SYS, (photoContext ? photoContext + ' ' : '') + casual, jwt, 400);
        raw = raw.replace(/```json\s*/gi,'').replace(/```\s*/gi,'').trim();
        instruction = JSON.parse(raw).instruction || casual;
      } catch(_) { /* fall back to raw prompt */ }

      // Compress all loaded images
      _fsStatus('fsImgStatusTxt', '✦ Generating image…', 'rgba(52,211,153,0.9)');
      var images = [];
      for (var i = 0; i < loaded.length; i++) {
        var compressed = await _fsCompress(loaded[i].dataUrl, 768, 0.80);
        var comma = compressed.indexOf(',');
        images.push({
          b64:  compressed.slice(comma + 1),
          mime: compressed.slice(5, comma).split(';')[0] || 'image/jpeg',
        });
      }

      var res = await fetch('/.netlify/functions/generate-nb-composite', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + jwt },
        body: JSON.stringify({ instruction: instruction, images: images }),
      });
      var data; try { data = await res.json(); } catch(_) { data = {}; }
      if (!res.ok || data.error) throw new Error(data.error || 'HTTP ' + res.status);
      if (!data.imageB64) throw new Error('No image returned — try rephrasing your prompt.');

      _fsGenImgUrl = 'data:' + (data.mime || 'image/png') + ';base64,' + data.imageB64;
      var img = document.getElementById('fsGenImg');
      if (img) img.src = _fsGenImgUrl;
      if (result) result.style.display = '';
      _fsStatus('fsImgStatusTxt', '', '');
      if (typeof showToast === 'function') showToast('Image generated!', 'success', 3000);

    } catch(e) {
      _fsStatus('fsImgStatusTxt', '', '');
      if (typeof showToast === 'function') showToast('Image error: ' + (e.message || e), 'error', 6000);
    } finally {
      if (btn)    { btn.disabled = false; btn.textContent = '✨ Generate Image'; }
      if (spinner) spinner.style.display = 'none';
    }
  };

  window.downloadFsImg = function() {
    if (!_fsGenImgUrl) return;
    var a = document.createElement('a'); a.href = _fsGenImgUrl; a.download = 'studio-image.png'; a.click();
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
    var result  = document.getElementById('fsVidResult');
    if (btn)     { btn.disabled = true; btn.textContent = 'Working…'; }
    if (spinner)  spinner.style.display = 'flex';
    if (result)   result.style.display  = 'none';

    try {
      if (typeof generateVeoClipViaAPI !== 'function') throw new Error('Veo API not loaded — refresh the page.');

      // GPT build Veo 3 JSON
      _fsStatus('fsVidStatusTxt', '✦ Building prompt with GPT…', 'rgba(139,92,246,0.9)');
      var veoFields = { action: casual, speech: '', negative_prompt: 'text, captions, watermarks, subtitles, blurry' };
      try {
        var raw = await _fsGpt(_FS_VID_SYS, casual, jwt, 400);
        raw = raw.replace(/```json\s*/gi,'').replace(/```\s*/gi,'').trim();
        veoFields = Object.assign(veoFields, JSON.parse(raw));
      } catch(_) { /* fall back */ }

      var veoJson = JSON.stringify({
        action:          veoFields.action,
        speech:          veoFields.speech || '',
        duration:        dur,
        negative_prompt: veoFields.negative_prompt || 'text, captions, watermarks, subtitles, blurry',
      });

      _fsStatus('fsVidStatusTxt', '✦ Generating video with Veo 3… (~1 min)', 'rgba(52,211,153,0.9)');

      var adm      = (typeof getAdminSettings === 'function') ? getAdminSettings() : {};
      var _dm      = (adm.defaultModel || 'Veo 3.1 Lite').toLowerCase();
      var modelKey = _dm.includes('fast') ? 'fast' : _dm.includes('standard') ? 'standard' : 'lite';

      // Start frame: use uploaded image if present
      var startImg = null;
      if (_fsVidFrame) {
        var cf = await _fsCompress(_fsVidFrame.dataUrl, 1024, 0.85);
        startImg = cf;
      }

      var res = await generateVeoClipViaAPI(veoJson, dur, modelKey, startImg);
      _fsGenVideoSrc = res.videoUrl;
      if (typeof window._fetchVideoAsBlob === 'function') {
        var blob = await window._fetchVideoAsBlob(res.videoUrl);
        if (blob) _fsGenVideoSrc = blob;
      }

      _fsStatus('fsVidStatusTxt', '', '');
      var vid = document.getElementById('fsGenVid');
      if (vid) { vid.src = _fsGenVideoSrc; vid.load(); }
      if (result) result.style.display = '';
      if (typeof refreshCreditBalance === 'function') refreshCreditBalance();
      if (typeof showToast === 'function') showToast('Video generated!', 'success', 4000);

    } catch(e) {
      _fsStatus('fsVidStatusTxt', '', '');
      if (typeof showToast === 'function') showToast('Video failed: ' + (e.message || e), 'error', 7000);
    } finally {
      if (btn)     { btn.disabled = false; btn.textContent = '⚡ Generate Video'; }
      if (spinner)  spinner.style.display = 'none';
    }
  };

  window.downloadFsVid = function() {
    if (!_fsGenVideoSrc) return;
    var a = document.createElement('a'); a.href = _fsGenVideoSrc; a.download = 'studio-video.mp4'; a.click();
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
