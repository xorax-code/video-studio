// ===== FLOW STUDIO =====
// Standalone image + video generator.
// Step 1: Upload reference photo + casual prompt → GPT enhances → Gemini generates image
// Step 2: Generated image + casual video prompt → GPT builds Veo 3 JSON → Veo 3 generates video

(function() {

  // ── State ──────────────────────────────────────────────────────────────────
  var _fsRefDataUrl      = null;   // uploaded reference image
  var _fsRefB64          = null;
  var _fsRefMime         = 'image/jpeg';
  var _fsGenImageDataUrl = null;   // generated image result
  var _fsVideoSrc        = null;   // generated video src (blob or remote)
  var _fsLastImgInstruction = null; // GPT-enhanced instruction shown to user
  var _fsLastVeoJson        = null; // GPT-built Veo 3 JSON shown to user

  // ── Init ───────────────────────────────────────────────────────────────────
  window.initFlowStudio = function() {};

  // ── Drag-and-drop + click upload ───────────────────────────────────────────
  window.onFsRefImageChange = function(e) {
    var file = e && e.target && e.target.files && e.target.files[0];
    if (!file) return;
    _fsLoadRefFile(file);
  };

  window.fsDragOver = function(e) {
    e.preventDefault();
    var zone = document.getElementById('fsUploadZone');
    if (zone) zone.style.borderColor = 'rgba(52,211,153,0.8)';
  };

  window.fsDragLeave = function() {
    var zone = document.getElementById('fsUploadZone');
    if (zone) zone.style.borderColor = 'rgba(255,255,255,0.1)';
  };

  window.fsDrop = function(e) {
    e.preventDefault();
    var zone = document.getElementById('fsUploadZone');
    if (zone) zone.style.borderColor = 'rgba(255,255,255,0.1)';
    var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) _fsLoadRefFile(file);
  };

  window.fsTriggerUpload = function() {
    var inp = document.getElementById('fsRefImageInput');
    if (inp) inp.click();
  };

  function _fsLoadRefFile(file) {
    var reader = new FileReader();
    reader.onload = function(ev) {
      _fsRefDataUrl = ev.target.result;
      var comma = _fsRefDataUrl.indexOf(',');
      _fsRefMime = _fsRefDataUrl.slice(5, comma).split(';')[0] || 'image/jpeg';
      _fsRefB64  = _fsRefDataUrl.slice(comma + 1);

      var prev = document.getElementById('fsRefPreview');
      if (prev) { prev.src = _fsRefDataUrl; prev.style.display = 'block'; }
      var zone = document.getElementById('fsUploadZone');
      if (zone) zone.style.backgroundImage = 'url(' + _fsRefDataUrl + ')';
      var label = document.getElementById('fsUploadLabel');
      if (label) label.style.display = 'none';
    };
    reader.readAsDataURL(file);
  }

  // ── Compress before sending ────────────────────────────────────────────────
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
        resolve(c.toDataURL('image/jpeg', quality));
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

  // ── GPT helper — calls openai-chat proxy ───────────────────────────────────
  async function _fsGpt(systemPrompt, userContent, jwt, maxTokens) {
    var res = await fetch('/.netlify/functions/openai-chat', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + jwt },
      body: JSON.stringify({
        model:      'gpt-4o-mini',
        max_tokens: maxTokens || 600,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userContent  },
        ],
      }),
    });
    var data;
    try { data = await res.json(); } catch(_) { data = {}; }
    if (!res.ok || data.error) throw new Error((data.error && (data.error.message || data.error)) || 'GPT error');
    return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  }

  // ── GPT: rewrite casual image prompt → precise instruction string ──────────
  var _FS_IMG_SYSTEM = `You are a prompt engineer for Gemini AI image editing. The user gives you a casual description of what they want changed in a reference photo of a person. Rewrite it as a single precise instruction string for an AI image editor.

Rules:
- Be specific about placement, size, and appearance of any new elements
- Describe natural lighting and photorealistic integration
- Explicitly state that the subject's face, expression, skin tone, hair, clothing, and the background must stay completely unchanged
- Return ONLY a JSON object in this exact format, no extra text:
{"instruction":"<your detailed instruction here>"}`;

  async function _fsEnhanceImagePrompt(casual, jwt) {
    try {
      var raw = await _fsGpt(_FS_IMG_SYSTEM, casual, jwt, 400);
      // Strip markdown code fences if present
      raw = raw.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
      var parsed = JSON.parse(raw);
      return parsed.instruction || casual;
    } catch(_) {
      // GPT failed or returned bad JSON — fall back to the user's raw prompt
      return casual;
    }
  }

  // ── GPT: rewrite casual video description → Veo 3 JSON ────────────────────
  var _FS_VID_SYSTEM = `You are a prompt engineer for Veo 3 AI video generation. The user gives you a casual description of what they want to happen in a short video clip. Rewrite it as a precise Veo 3 prompt.

Return ONLY a JSON object in this exact format, no extra text:
{
  "action": "<precise description of physical movement and action in this clip>",
  "speech": "<exact words spoken — empty string if the person is not speaking>",
  "negative_prompt": "text overlays, captions, watermarks, subtitles, jump cuts, scene changes, blurry, duplicate people"
}

Rules:
- action: describe visible body movement, facial expression, eye contact direction, and camera behavior
- speech: only include if the user's description clearly involves the person speaking; otherwise use ""
- Keep action under 60 words
- No duration field — that is set separately`;

  async function _fsEnhanceVideoPrompt(casual, jwt) {
    try {
      var raw = await _fsGpt(_FS_VID_SYSTEM, casual || 'The person moves naturally and looks at the camera.', jwt, 400);
      raw = raw.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
      return JSON.parse(raw); // { action, speech, negative_prompt }
    } catch(_) {
      return {
        action: casual || 'The person moves naturally, looking toward the camera with a relaxed expression.',
        speech: '',
        negative_prompt: 'text, captions, watermarks, subtitles, blurry',
      };
    }
  }

  // ── Update status label ────────────────────────────────────────────────────
  function _fsSetStatus(elId, text, color) {
    var el = document.getElementById(elId);
    if (!el) return;
    el.textContent = text;
    el.style.color = color || 'var(--text-3)';
    el.style.display = text ? 'block' : 'none';
  }

  // ── Show/hide enhanced prompt pill ────────────────────────────────────────
  function _fsShowEnhanced(containerId, text) {
    var el = document.getElementById(containerId);
    if (!el) return;
    if (!text) { el.style.display = 'none'; return; }
    el.style.display = '';
    var inner = el.querySelector('.fs-enhanced-text');
    if (inner) inner.textContent = text;
  }

  // ── STEP 1: Generate Image ─────────────────────────────────────────────────
  window.generateFsImage = async function() {
    if (!_fsRefB64) {
      if (typeof showToast === 'function') showToast('Upload a reference photo first.', 'warning');
      return;
    }
    var promptEl = document.getElementById('fsImagePrompt');
    var casual = promptEl ? promptEl.value.trim() : '';
    if (!casual) {
      if (typeof showToast === 'function') showToast('Describe what you want to generate.', 'warning');
      return;
    }

    var jwt = await _fsJwt();
    if (!jwt) {
      if (typeof showToast === 'function') showToast('Please log in to generate images.', 'warning');
      return;
    }

    var btn     = document.getElementById('fsBtnGenImage');
    var spinner = document.getElementById('fsImageSpinner');
    var statusEl = document.getElementById('fsImageStatus');
    if (btn) { btn.disabled = true; btn.textContent = 'Working…'; }
    if (spinner) spinner.style.display = 'flex';
    _fsShowEnhanced('fsImgEnhancedWrap', null);

    var resultWrap = document.getElementById('fsImageResult');
    if (resultWrap) resultWrap.style.display = 'none';

    try {
      // ── Phase 1: GPT rewrites casual prompt → precise instruction ──────────
      _fsSetStatus('fsImageStatus', '✦ Enhancing prompt with GPT…', 'rgba(139,92,246,0.9)');
      var instruction = await _fsEnhanceImagePrompt(casual, jwt);
      _fsLastImgInstruction = instruction;
      _fsShowEnhanced('fsImgEnhancedWrap', instruction);

      // ── Phase 2: Gemini generates the image ───────────────────────────────
      _fsSetStatus('fsImageStatus', '✦ Generating image…', 'rgba(52,211,153,0.9)');

      var compressed = await _fsCompress(_fsRefDataUrl, 768, 0.80);
      var comma = compressed.indexOf(',');
      var mime  = compressed.slice(5, comma).split(';')[0] || 'image/jpeg';
      var b64   = compressed.slice(comma + 1);

      var res = await fetch('/.netlify/functions/generate-nb-composite', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + jwt },
        body: JSON.stringify({
          instruction: instruction,
          avatarB64:   b64,
          avatarMime:  mime,
          frameB64:    null,
          frameMime:   'image/jpeg',
        }),
      });

      var data;
      try { data = await res.json(); } catch(_) { data = {}; }

      if (!res.ok || data.error) {
        if (typeof showToast === 'function') showToast('Image failed: ' + (data.error || 'HTTP ' + res.status), 'error', 6000);
        return;
      }
      if (!data.imageB64) {
        if (typeof showToast === 'function') showToast('No image returned — try rephrasing your prompt.', 'warning', 5000);
        return;
      }

      _fsGenImageDataUrl = 'data:' + (data.mime || 'image/png') + ';base64,' + data.imageB64;
      _fsSetStatus('fsImageStatus', '', '');

      var img = document.getElementById('fsGenImage');
      if (img) img.src = _fsGenImageDataUrl;
      if (resultWrap) resultWrap.style.display = '';

      // Unlock Step 2
      var vidSection = document.getElementById('fsVideoSection');
      if (vidSection) vidSection.style.opacity = '1';
      var vidBtn = document.getElementById('fsBtnGenVideo');
      if (vidBtn) { vidBtn.disabled = false; vidBtn.style.opacity = '1'; vidBtn.style.cursor = 'pointer'; }

      if (typeof showToast === 'function') showToast('Image generated! Scroll down to create a video from it.', 'success', 4000);

    } catch(e) {
      _fsSetStatus('fsImageStatus', '', '');
      if (typeof showToast === 'function') showToast('Image error: ' + (e.message || e), 'error', 5000);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '✨ Generate Image'; }
      if (spinner) spinner.style.display = 'none';
    }
  };

  window.redoFsImage = function() { window.generateFsImage(); };

  window.downloadFsImage = function() {
    if (!_fsGenImageDataUrl) return;
    var a = document.createElement('a');
    a.href = _fsGenImageDataUrl;
    a.download = 'flow-studio-image.png';
    a.click();
  };

  // ── Use generated image as new reference ──────────────────────────────────
  window.useFsImageAsRef = function() {
    if (!_fsGenImageDataUrl) return;
    _fsRefDataUrl = _fsGenImageDataUrl;
    var comma = _fsRefDataUrl.indexOf(',');
    _fsRefMime = _fsRefDataUrl.slice(5, comma).split(';')[0] || 'image/png';
    _fsRefB64  = _fsRefDataUrl.slice(comma + 1);

    var prev = document.getElementById('fsRefPreview');
    if (prev) { prev.src = _fsRefDataUrl; prev.style.display = 'block'; }
    var zone = document.getElementById('fsUploadZone');
    if (zone) zone.style.backgroundImage = 'url(' + _fsRefDataUrl + ')';
    var label = document.getElementById('fsUploadLabel');
    if (label) label.style.display = 'none';

    _fsGenImageDataUrl = null;
    var resultWrap = document.getElementById('fsImageResult');
    if (resultWrap) resultWrap.style.display = 'none';
    _fsShowEnhanced('fsImgEnhancedWrap', null);

    var promptEl = document.getElementById('fsImagePrompt');
    if (promptEl) { promptEl.value = ''; promptEl.focus(); }

    if (typeof showToast === 'function') showToast('Generated image set as new reference — enter a new prompt.', 'success', 4000);
  };

  // ── STEP 2: Generate Video ─────────────────────────────────────────────────
  window.generateFsVideo = async function() {
    if (!_fsGenImageDataUrl) {
      if (typeof showToast === 'function') showToast('Generate an image first — it becomes the video start frame.', 'warning');
      return;
    }

    var promptEl = document.getElementById('fsVideoPrompt');
    var casual   = promptEl ? promptEl.value.trim() : '';

    var durEl = document.querySelectorAll('#fsVideoDuration .fs-dur-btn.active');
    var dur   = durEl.length ? parseInt(durEl[0].dataset.dur) || 6 : 6;

    var jwt = await _fsJwt();
    if (!jwt) {
      if (typeof showToast === 'function') showToast('Please log in to generate videos.', 'warning');
      return;
    }

    var btn     = document.getElementById('fsBtnGenVideo');
    var spinner = document.getElementById('fsVideoSpinner');
    if (btn) { btn.disabled = true; btn.textContent = 'Working…'; }
    if (spinner) spinner.style.display = 'flex';
    _fsShowEnhanced('fsVidEnhancedWrap', null);

    var videoResult = document.getElementById('fsVideoResult');
    if (videoResult) videoResult.style.display = 'none';

    try {
      if (typeof generateVeoClipViaAPI !== 'function') throw new Error('Veo API not loaded — refresh the page.');

      // ── Phase 1: GPT builds Veo 3 JSON from casual description ────────────
      _fsSetStatus('fsVideoStatus', '✦ Building Veo 3 prompt with GPT…', 'rgba(139,92,246,0.9)');
      var veoFields = await _fsEnhanceVideoPrompt(casual, jwt);
      _fsLastVeoJson = veoFields;

      var veoJson = JSON.stringify({
        action:          veoFields.action,
        speech:          veoFields.speech || '',
        duration:        dur,
        negative_prompt: veoFields.negative_prompt || 'text, captions, watermarks, subtitles, blurry',
      });

      // Show the enhanced prompt to the user
      var previewText = '▸ action: ' + veoFields.action
        + (veoFields.speech ? '\n▸ speech: "' + veoFields.speech + '"' : '');
      _fsShowEnhanced('fsVidEnhancedWrap', previewText);

      // ── Phase 2: Veo 3 generates the video ────────────────────────────────
      _fsSetStatus('fsVideoStatus', '✦ Generating video with Veo 3… (~1 min)', 'rgba(52,211,153,0.9)');

      var adm      = (typeof getAdminSettings === 'function') ? getAdminSettings() : {};
      var _dm      = (adm.defaultModel || 'Veo 3.1 Lite').toLowerCase();
      var modelKey = _dm.includes('fast') ? 'fast' : _dm.includes('standard') ? 'standard' : 'lite';

      var result = await generateVeoClipViaAPI(veoJson, dur, modelKey, _fsGenImageDataUrl);

      _fsVideoSrc = result.videoUrl;
      if (typeof window._fetchVideoAsBlob === 'function') {
        var blob = await window._fetchVideoAsBlob(result.videoUrl);
        if (blob) _fsVideoSrc = blob;
      }

      _fsSetStatus('fsVideoStatus', '', '');
      var vid = document.getElementById('fsGenVideo');
      if (vid) { vid.src = _fsVideoSrc; vid.load(); }
      if (videoResult) videoResult.style.display = '';

      if (typeof refreshCreditBalance === 'function') refreshCreditBalance();
      if (typeof showToast === 'function') showToast('Video generated!', 'success', 4000);

    } catch(e) {
      _fsSetStatus('fsVideoStatus', '', '');
      if (typeof showToast === 'function') showToast('Video failed: ' + (e.message || e), 'error', 7000);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '⚡ Generate Video'; }
      if (spinner) spinner.style.display = 'none';
    }
  };

  window.downloadFsVideo = function() {
    if (!_fsVideoSrc) return;
    var a = document.createElement('a');
    a.href = _fsVideoSrc;
    a.download = 'flow-studio-video.mp4';
    a.click();
  };

  // ── Duration toggle ────────────────────────────────────────────────────────
  window.setFsDuration = function(sec, el) {
    document.querySelectorAll('#fsVideoDuration .fs-dur-btn').forEach(function(b) {
      b.classList.remove('active');
      b.style.background  = 'var(--surface-3)';
      b.style.borderColor = 'var(--border-2)';
      b.style.color       = 'var(--text-3)';
    });
    el.classList.add('active');
    el.style.background  = 'rgba(52,211,153,0.18)';
    el.style.borderColor = 'rgba(52,211,153,0.5)';
    el.style.color       = '#34d399';
  };

  window.fsAutoGrow = function(el) {
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  };

})();
