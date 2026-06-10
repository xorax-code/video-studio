  // ===== NB COMPOSITE API =====
  // Generates Nano Banana composite images via Gemini 2.0 Flash image generation.
  // Flow: extract NB instruction → call /.netlify/functions/generate-nb-composite
  //       → store result in seg.nbPreviewDataUrl → show approval modal

  // ── Compress image to max pixels before sending ───────────────────────────
  function _nbCompressImage(dataUrl, maxPx, quality) {
    maxPx = maxPx || 768;
    quality = quality || 0.78;
    return new Promise(function(resolve) {
      var img = new Image();
      img.onload = function() {
        var w = img.naturalWidth || 512, h = img.naturalHeight || 512;
        if (w > maxPx || h > maxPx) {
          if (w > h) { h = Math.round(h * maxPx / w); w = maxPx; }
          else       { w = Math.round(w * maxPx / h); h = maxPx; }
        }
        var c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL('image/jpeg', quality));
      };
      img.onerror = function() { resolve(dataUrl); }; // fallback: use original
      img.src = dataUrl;
    });
  }

  // Strip the data: URL prefix and return { b64, mime }
  function _nbSplitDataUrl(dataUrl) {
    if (!dataUrl || !dataUrl.startsWith('data:')) return { b64: null, mime: 'image/jpeg' };
    var comma = dataUrl.indexOf(',');
    if (comma === -1) return { b64: null, mime: 'image/jpeg' };
    var meta = dataUrl.slice(5, comma);
    var mime = meta.split(';')[0] || 'image/jpeg';
    var b64  = dataUrl.slice(comma + 1);
    return { b64, mime };
  }

  // ── Generate NB composite for a single segment ────────────────────────────
  async function generateNbComposite(segIdx) {
    var seg = segments[segIdx];
    if (!seg) { showToast('Segment not found.', 'error'); return false; }

    var nbPromptRaw = (seg.nbPrompt || '').trim();
    if (!nbPromptRaw && !seg.frameDataUrl) {
      showToast('Generate prompts first — Scene ' + (segIdx + 1) + ' has no NB prompt yet.', 'warning');
      return false;
    }

    if (!avatarImageDataUrl) {
      showToast('Upload your avatar photo first.', 'warning');
      return false;
    }

    // Get JWT for auth
    var jwt = null;
    try {
      var _sbRef = (typeof _sb !== 'undefined' && _sb) ? _sb : window._sb;
      if (_sbRef) {
        var sessionRes = await _sbRef.auth.getSession();
        jwt = (sessionRes && sessionRes.data && sessionRes.data.session && sessionRes.data.session.access_token) || null;
      }
    } catch(_) {}
    if (!jwt) { showToast('Please log in to generate NB composites.', 'warning'); return false; }

    // Compress images before sending
    var avatarCompressed = await _nbCompressImage(avatarImageDataUrl, 768, 0.80);
    var avatarParts = _nbSplitDataUrl(avatarCompressed);

    var frameB64 = null, frameMime = 'image/jpeg';
    var hasFrame = !!seg.frameDataUrl;
    if (hasFrame) {
      var frameCompressed = await _nbCompressImage(seg.frameDataUrl, 768, 0.80);
      var frameParts = _nbSplitDataUrl(frameCompressed);
      frameB64 = frameParts.b64;
      frameMime = frameParts.mime;
    }

    // ── Product reference (optional) — Photo 3: swap the held product ──────────
    // Only applies in compositing mode (a real frame with a held product). When a
    // product photo is uploaded, the backend replaces the original held object.
    var productB64 = null, productMime = 'image/jpeg', hasProduct = false;
    try {
      var _prodUrl = (typeof productImageDataUrl !== 'undefined' && productImageDataUrl)
        || window._producerProductImageUrl || null;
      if (_prodUrl && hasFrame) {
        var prodCompressed = await _nbCompressImage(_prodUrl, 768, 0.80);
        var prodParts = _nbSplitDataUrl(prodCompressed);
        productB64 = prodParts.b64;
        productMime = prodParts.mime;
        hasProduct = true;
      }
    } catch(_) {}

    // ── Build instruction for Imagen 3 based on what photos are available ──────
    // When a video frame exists: avatar (SUBJECT ref) + frame (STYLE ref for background).
    // When avatar only: generate a fresh lifestyle frame from the NB prompt context.
    var instruction;
    var _nbNegativePrompt = '';

    // Read avatar text description — reinforces the SUBJECT image reference in text
    var _avatarDesc = (document.getElementById('avatarDesc') ? document.getElementById('avatarDesc').value.trim() : '');

    // Parse NB prompt JSON once — used by both paths
    var _nbParsedObj = {};
    try { _nbParsedObj = JSON.parse(nbPromptRaw); } catch(_) { _nbParsedObj = {}; }
    var _cleanStr = function(s) {
      return (s || '').replace(/NanoBanana[^.]*\.\s*/gi, '').replace(/INPUT:[^.]*\.\s*/gi, '').trim();
    };

    // Extract all NB prompt fields
    var _nbCore        = _cleanStr(_nbParsedObj.instruction || (typeof nbPromptRaw === 'string' && !nbPromptRaw.startsWith('{') ? nbPromptRaw : ''));
    var _nbSetting     = _cleanStr(_nbParsedObj.setting || '');
    var _nbFraming     = _cleanStr(_nbParsedObj.framing || '');
    var _nbExpression  = _cleanStr(_nbParsedObj.expression || '');
    var _nbStyle       = _cleanStr(_nbParsedObj.style || '');
    var _nbBgRef       = _cleanStr(_nbParsedObj.background_reference || '');
    var _nbVisualDesc  = _cleanStr(_nbParsedObj.visual_description || '');
    _nbNegativePrompt  = _cleanStr(_nbParsedObj.negative_prompt || '');

    var _segAction = (seg.action || '').trim();

    if (hasFrame) {
      // ── Compositing mode ──────────────────────────────────────────────────────
      // The NB prompt JSON's `instruction` field (_nbCore) is a complete NB Pro
      // instruction in Flow format (REPLACE / LOCK / ARM / PROP STATE / HAIR LOCK /
      // GENDER LOCK / TRANSFER BLOCK / LIGHTING MATCH). Use it directly.
      // Do NOT wrap it in another instruction layer — that causes every section to
      // appear twice, which confuses the model and produces wrong results.

      if (_nbCore) {
        // Complete Flow-format instruction: use as-is.
        instruction = _nbCore;
      } else {
        // No instruction field — build minimal fallback from the other NB prompt fields.
        var _hfParts = [];
        _hfParts.push('[FULL PERSON] REPLACE: target person — match position and scale from Photo 2. Camera angle: straight-on, chest height.');
        var _lockLine = 'LOCK: background — preserve the environment, props, and lighting from Photo 2 exactly.';
        if (_nbVisualDesc) _lockLine += ' Scene: ' + _nbVisualDesc + '.';
        if (_nbSetting)    _lockLine += ' Setting: ' + _nbSetting + '.';
        if (_nbBgRef)      _lockLine += ' ' + _nbBgRef + '.';
        _hfParts.push(_lockLine);
        if (_segAction) {
          _hfParts.push('ARM: ' + _segAction + '.');
          _hfParts.push('POSE LOCK: Match the arm height, angle, and reach from Photo 2 exactly — do NOT default to arms at sides.');
          _hfParts.push('PROP STATE: Prop must be in avatar\'s hand at exact position shown in Photo 2.');
        }
        _hfParts.push('LIGHT: ' + (_nbStyle || 'warm ambient') + '. Match Photo 2 lighting exactly.');
        if (_avatarDesc) _hfParts.push('HAIR LOCK: Avatar — ' + _avatarDesc + '. Do NOT copy hair or features from Photo 2 person.');
        _hfParts.push('GENDER LOCK: Match Photo 1 person\'s gender, age, and ethnicity exactly. Do NOT change under any circumstances.');
        _hfParts.push('TRANSFER BLOCK: No text, logos, labels, or graphical overlays from Photo 2 in the output.');
        _hfParts.push('LIGHTING MATCH: Match Photo 2 lighting color temperature, direction, and shadows exactly.');
        if (_nbExpression) _hfParts.push('Expression: ' + _nbExpression + '.');
        _hfParts.push('Framing: ' + (_nbFraming || 'vertical 9:16, medium close-up, subject centered, 85mm, f/1.8 shallow depth of field') + '. Single photorealistic image. ONE person only.');
        instruction = _hfParts.join(' ');
      }

    } else {
      // ── Generate mode — NB Pro structured format ─────────────────────────────
      // No reference frame — generate a fresh lifestyle starting frame for the avatar.
      var _gParts = [];

      // Header
      _gParts.push('[FULL PERSON] Generate the avatar from the SUBJECT reference image in a lifestyle scene.');

      // Avatar description reinforcement
      if (_avatarDesc) _gParts.push('HAIR LOCK: Avatar — ' + _avatarDesc + '. Reproduce this person\'s face, skin tone, hair, and clothing exactly.');

      // Core instruction from NB prompt
      if (_nbCore) {
        _gParts.push(_nbCore);
      } else {
        _gParts.push('Generate a photorealistic vertical 9:16 lifestyle photo of this exact person facing the camera with a natural engaged expression.');
      }

      // Scene / setting / background
      if (_nbSetting)    _gParts.push('Setting: ' + _nbSetting + '.');
      if (_nbBgRef)      _gParts.push(_nbBgRef);
      if (_nbVisualDesc) _gParts.push('Scene: ' + _nbVisualDesc + '.');

      // ARM / pose
      if (_segAction) {
        _gParts.push('ARM: ' + _segAction + '.');
      }

      // Expression
      if (_nbExpression) _gParts.push('Expression: ' + _nbExpression + '.');

      // Standard locks
      _gParts.push('GENDER LOCK: The avatar must match the exact gender, approximate age, and ethnicity of the person in the SUBJECT reference. Do NOT change the avatar\'s gender, age, or ethnicity.');
      _gParts.push('TRANSFER BLOCK: Do NOT add any text, logos, dates, or labels to the output.');

      // Technical
      _gParts.push('Framing: ' + (_nbFraming || 'vertical 9:16, medium close-up, subject centered, 85mm, f/1.8 shallow depth of field') + '.');
      _gParts.push('Style: ' + (_nbStyle || 'photorealistic lifestyle editorial — real room, real lighting, real decor') + '. Single image. ONE person only. No text overlays, no watermarks.');

      instruction = _gParts.join(' ');
    }

    // When a product reference is provided, tell the model to swap the held product.
    if (hasProduct) {
      instruction += ' PRODUCT REPLACE (critical): The object held in the hand must be REPLACED with the product shown in Photo 3. Keep the same hand, grip, finger positions, scale, and arm pose, but the held product\'s shape, color, packaging, label, and text must match Photo 3 exactly. Do NOT keep or blend the original product from the scene frame.';
    }

    // ── Request with 429 retry-backoff ───────────────────────────────────────
    // Vertex AI image generation has a tight QPM quota (~5/min).
    // On 429 "Resource exhausted" we wait and retry up to 3 times.
    var _NB_MAX_RETRIES = 3;
    var _NB_RETRY_BASE  = 30000; // 30s initial wait; doubles each retry

    for (var _attempt = 0; _attempt <= _NB_MAX_RETRIES; _attempt++) {
      try {
        var res = await fetch('/.netlify/functions/generate-nb-composite', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + jwt },
          body: JSON.stringify({
            instruction,
            avatarDesc:     _avatarDesc,
            negativePrompt: _nbNegativePrompt,
            avatarB64:      avatarParts.b64,
            avatarMime:     avatarParts.mime,
            frameB64,
            frameMime,
            productB64,
            productMime,
          }),
        });

        var data;
        try { data = await res.json(); } catch(_) { data = {}; }

        // 429 = Vertex AI rate limit — wait and retry
        if (res.status === 429) {
          if (_attempt < _NB_MAX_RETRIES) {
            var _waitMs = _NB_RETRY_BASE * Math.pow(2, _attempt);
            var _waitSec = Math.round(_waitMs / 1000);
            console.warn('[NB Composite] Scene ' + (segIdx + 1) + ' — 429 rate limit, waiting ' + _waitSec + 's before retry ' + (_attempt + 1) + '/' + _NB_MAX_RETRIES);
            showToast('Scene ' + (segIdx + 1) + ': Vertex AI rate limit — retrying in ' + _waitSec + 's…', 'warning', _waitMs);
            await new Promise(function(r) { setTimeout(r, _waitMs); });
            continue; // retry
          }
          // Exhausted retries
          var _rateMsg = (data && data.error) || 'Vertex AI rate limit exceeded. Try again in a minute.';
          console.error('[NB Composite] Scene ' + (segIdx + 1) + ' — 429 after ' + _NB_MAX_RETRIES + ' retries:', _rateMsg);
          showToast('NB gen failed (Scene ' + (segIdx + 1) + '): rate limit — try again in ~1 min.', 'error', 12000);
          return false;
        }

        if (!res.ok || data.error) {
          var msg = data.error || ('HTTP ' + res.status);
          console.error('[NB Composite] Scene ' + (segIdx + 1) + ' failed — HTTP ' + res.status + ' | Error:', msg, '| Full response:', JSON.stringify(data));
          showToast('NB gen failed (Scene ' + (segIdx + 1) + '): ' + msg, 'error', 20000);
          return false;
        }

        if (!data.imageB64) {
          var noImgMsg = data.error || data.message || 'No image returned (safety filter or bad response)';
          console.error('[NB Composite] Scene ' + (segIdx + 1) + ' — no image in response. Full response:', JSON.stringify(data));
          showToast('NB gen returned no image for Scene ' + (segIdx + 1) + ': ' + noImgMsg, 'error', 20000);
          return false;
        }

        // Store composite in segment
        segments[segIdx].nbPreviewDataUrl = 'data:' + (data.mime || 'image/png') + ';base64,' + data.imageB64;
        segments[segIdx].nbApproved = null; // reset approval — needs re-review

        saveSegments();
        if (typeof renderSegments === 'function') renderSegments();

        return true;

      } catch(e) {
        if (_attempt < _NB_MAX_RETRIES) {
          console.warn('[NB Composite] Scene ' + (segIdx + 1) + ' fetch error, retrying:', e.message);
          await new Promise(function(r) { setTimeout(r, 5000); });
          continue;
        }
        showToast('NB gen error (Scene ' + (segIdx + 1) + '): ' + (e.message || e), 'error', 6000);
        return false;
      }
    }
    return false;
  }
  window.generateNbComposite = generateNbComposite;

  // ── Generate NB composites for ALL segments ───────────────────────────────
  // ── Frame-generation progress panel ──────────────────────────────────────
  function _nbOpenProgress(total) {
    var ex = document.getElementById('nbFrameProgress'); if (ex) ex.remove();
    var rows = '';
    for (var k = 0; k < total; k++) {
      rows += '<div id="nbfp-row-' + k + '" style="display:flex;align-items:center;gap:8px;padding:6px 9px;border-radius:7px;background:var(--surface-2);border:1px solid var(--border);font-size:11px;">'
        + '<span id="nbfp-ic-' + k + '">⏳</span>'
        + '<span style="flex:1;color:var(--text-2);">Scene ' + (k + 1) + ' frame</span>'
        + '<span id="nbfp-st-' + k + '" style="font-weight:700;color:var(--text-3);">queued</span>'
        + '</div>';
    }
    var m = document.createElement('div');
    m.id = 'nbFrameProgress';
    m.style.cssText = 'position:fixed;inset:0;z-index:99990;background:rgba(0,0,0,0.80);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;padding:16px;';
    m.innerHTML = '<div style="background:var(--surface);border:1px solid rgba(56,189,248,0.35);border-radius:14px;padding:20px;width:100%;max-width:460px;max-height:88vh;overflow-y:auto;font-family:inherit;display:flex;flex-direction:column;gap:12px;box-shadow:0 24px 80px rgba(0,0,0,0.65);">'
      + '<div style="display:flex;align-items:center;gap:10px;"><div style="width:34px;height:34px;border-radius:9px;background:rgba(56,189,248,0.15);border:1px solid rgba(56,189,248,0.35);display:flex;align-items:center;justify-content:center;font-size:17px;">🖼️</div>'
      + '<div><div style="font-size:14px;font-weight:800;color:var(--text-1);">Making your start frames</div><div style="font-size:11px;color:var(--text-3);">' + total + ' scene' + (total !== 1 ? 's' : '') + ' · ~15s each · then you review them</div></div></div>'
      + '<div style="display:flex;flex-direction:column;gap:4px;">' + rows + '</div>'
      + '<div><div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-3);margin-bottom:5px;"><span id="nbfp-label">Starting…</span><span id="nbfp-pct">0%</span></div>'
      + '<div style="height:5px;background:var(--surface-3);border-radius:3px;overflow:hidden;"><div id="nbfp-bar" style="height:100%;width:0%;background:linear-gradient(90deg,#38bdf8,#34d399);border-radius:3px;transition:width 0.4s;"></div></div></div>'
      + '</div>';
    document.body.appendChild(m);
  }
  function _nbSetFrameStatus(k, status, doneCount, total) {
    var ic = document.getElementById('nbfp-ic-' + k), st = document.getElementById('nbfp-st-' + k), row = document.getElementById('nbfp-row-' + k);
    var cfg = { generating: ['⟳', '#38bdf8', 'generating…', 'rgba(56,189,248,0.08)'],
                done:       ['✅', '#34d399', 'done',          'rgba(52,211,153,0.07)'],
                error:      ['❌', '#f87171', 'failed',        'rgba(239,68,68,0.07)'] }[status];
    if (cfg) { if (ic) ic.textContent = cfg[0]; if (st) { st.textContent = cfg[2]; st.style.color = cfg[1]; } if (row) row.style.background = cfg[3]; }
    if (typeof doneCount === 'number' && total) {
      var pct = Math.round((doneCount / total) * 100);
      var bar = document.getElementById('nbfp-bar'), pe = document.getElementById('nbfp-pct'), lb = document.getElementById('nbfp-label');
      if (bar) bar.style.width = pct + '%';
      if (pe) pe.textContent = pct + '%';
      if (lb) lb.textContent = doneCount + '/' + total + ' frames';
    }
  }
  function _nbCloseProgress() { var m = document.getElementById('nbFrameProgress'); if (m) m.remove(); }

  async function generateAllNbComposites() {
    // Include segments that either have an NB prompt OR have a frameDataUrl (person-swap path)
    var toGen = segments.filter(function(s) { return (s.nbPrompt || '').trim() || s.frameDataUrl; });
    if (!toGen.length) {
      showToast('No scenes ready — generate prompts first or ensure frames are extracted.', 'warning');
      return;
    }
    if (!avatarImageDataUrl) {
      showToast('Upload your avatar photo first.', 'warning');
      return;
    }

    var btn = document.getElementById('genNbAllBtn');
    var origLabel = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="ti ti-loader-2" style="animation:spin 1s linear infinite;"></i> Generating…'; }

    var succeeded = 0, failed = 0;
    var n = toGen.length;
    _nbOpenProgress(n);

    for (var i = 0; i < n; i++) {
      var seg = toGen[i];
      var segIdx = segments.indexOf(seg);

      // Update button label + progress panel
      if (btn) btn.innerHTML = '<i class="ti ti-loader-2" style="animation:spin 1s linear infinite;"></i> ' + (i + 1) + '/' + n + '…';
      _nbSetFrameStatus(i, 'generating');

      var ok = await generateNbComposite(segIdx);
      if (ok) succeeded++; else failed++;
      _nbSetFrameStatus(i, ok ? 'done' : 'error', succeeded + failed, n);

      // Delay between requests — Vertex AI image generation quota is ~5 QPM.
      // 15s spacing keeps us well under the limit regardless of generation time.
      if (i < n - 1) await new Promise(function(r) { setTimeout(r, 15000); });
    }

    _nbCloseProgress();
    if (btn) { btn.disabled = false; btn.innerHTML = origLabel; }

    if (succeeded > 0) {
      showToast('Generated ' + succeeded + '/' + n + ' NB composite' + (succeeded !== 1 ? 's' : '') + (failed > 0 ? ' · ' + failed + ' failed' : '') + ' — review and approve below.', succeeded === n ? 'success' : 'warning', 6000);
      // Open approval modal after generation
      setTimeout(function() { openNbApprovalModal(); }, 600);
    } else {
      showToast('All NB generations failed. Check console for details.', 'error', 5000);
    }
  }
  window.generateAllNbComposites = generateAllNbComposites;

  // ── NB Approval Modal ─────────────────────────────────────────────────────
  // Shows all generated NB composites side-by-side with approve/reject toggles.
  // Approved composites become the start frame for Veo generation.
  function openNbApprovalModal(fromProcessEverything) {
    var withComposites = segments.filter(function(s) { return s.nbPreviewDataUrl; });
    if (!withComposites.length) {
      showToast('Generate NB composites first.', 'warning');
      return;
    }

    var existing = document.getElementById('nbApprovalModal');
    if (existing) existing.remove();

    var modal = document.createElement('div');
    modal.id = 'nbApprovalModal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;';

    var inner = document.createElement('div');
    inner.style.cssText = 'background:var(--surface);border:1px solid var(--border-2);border-radius:12px;padding:20px;max-width:960px;width:100%;max-height:90vh;overflow-y:auto;display:flex;flex-direction:column;gap:16px;';

    // Header
    var header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;';
    header.innerHTML = '<div style="font-size:15px;font-weight:800;color:var(--text-1);">✅ Review NB Composites</div>'
      + '<div style="display:flex;gap:8px;">'
      + '<button onclick="approveAllNbComposites(true)" style="padding:5px 12px;font-size:11px;font-weight:700;font-family:inherit;background:rgba(52,211,153,0.15);border:1px solid rgba(52,211,153,0.5);border-radius:6px;color:#34d399;cursor:pointer;">✓ Approve All</button>'
      + '<button onclick="approveAllNbComposites(false)" style="padding:5px 12px;font-size:11px;font-weight:700;font-family:inherit;background:rgba(248,113,113,0.1);border:1px solid rgba(248,113,113,0.3);border-radius:6px;color:var(--danger);cursor:pointer;">✕ Reject All</button>'
      + '<button onclick="document.getElementById(\'nbApprovalModal\').remove()" style="padding:5px 10px;font-size:12px;font-family:inherit;background:var(--surface-3);border:1px solid var(--border-2);border-radius:6px;color:var(--text-2);cursor:pointer;">Close</button>'
      + '</div>';

    var subtext = document.createElement('div');
    subtext.style.cssText = 'font-size:11px;color:var(--text-3);margin-top:-8px;';
    subtext.textContent = 'Approve the composites you want to use as start frames for Veo 3. Rejected scenes will use the raw video frame instead.';

    // Grid of composites
    var grid = document.createElement('div');
    grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;';

    withComposites.forEach(function(seg) {
      var idx = segments.indexOf(seg);
      var approved = seg.nbApproved !== false; // default true
      var card = document.createElement('div');
      card.id = 'nb-approval-card-' + idx;
      card.style.cssText = 'border:2px solid ' + (approved ? 'rgba(52,211,153,0.7)' : 'rgba(248,113,113,0.5)')
        + ';border-radius:8px;overflow:hidden;background:var(--surface-2);cursor:pointer;';
      card.innerHTML = '<img id="nb-approval-img-' + idx + '" src="' + seg.nbPreviewDataUrl + '" style="width:100%;aspect-ratio:9/16;object-fit:cover;display:block;">'
        + '<div style="padding:6px 8px;display:flex;align-items:center;justify-content:space-between;gap:6px;">'
          + '<span style="font-size:11px;font-weight:600;color:var(--text-2);">Scene ' + (idx + 1) + '</span>'
          + '<div style="display:flex;align-items:center;gap:5px;">'
            + '<button id="nb-regen-btn-' + idx + '" onclick="event.stopPropagation();regenNbFrame(' + idx + ')" title="Regenerate this frame" style="padding:2px 7px;font-size:11px;font-weight:700;font-family:inherit;background:rgba(56,189,248,0.15);border:1px solid rgba(56,189,248,0.4);border-radius:4px;color:#38bdf8;cursor:pointer;">↺ Redo</button>'
            + '<span id="nb-approval-badge-' + idx + '" style="font-size:11px;font-weight:800;padding:2px 8px;border-radius:4px;background:' + (approved ? 'rgba(52,211,153,0.9)' : 'rgba(248,113,113,0.85)') + ';color:#fff;">' + (approved ? '✓' : '✕') + '</span>'
          + '</div>'
        + '</div>';
      card.onclick = function() { toggleNbApproval(idx); };
      grid.appendChild(card);
    });

    // Footer
    var footer = document.createElement('div');
    footer.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;padding-top:8px;border-top:1px solid var(--border);';
    // fromProcessEverything flag is captured in closure so the button always uses API
    // mode when called from processEverything, regardless of the mode toggle state.
    // When called standalone, the button checks the mode dynamically at click time.
    var _forceApi = !!fromProcessEverything;

    footer.innerHTML = '<button onclick="document.getElementById(\'nbApprovalModal\').remove()" style="padding:7px 16px;font-size:12px;font-family:inherit;background:var(--surface-3);border:1px solid var(--border-2);border-radius:7px;color:var(--text-2);cursor:pointer;">Done</button>'
      + '<button onclick="(function(){document.getElementById(\'nbApprovalModal\').remove();var _api=' + (_forceApi ? 'true' : '(typeof getGenerateMode===\'function\'?getGenerateMode():\'api\')===\'api\'') + ';if(_api){if(typeof generateAllScenesViaAPI===\'function\')generateAllScenesViaAPI();}else{if(typeof showPreflightModal===\'function\')showPreflightModal(false);}})()" style="padding:7px 16px;font-size:12px;font-weight:700;font-family:inherit;background:rgba(52,211,153,0.15);border:1px solid rgba(52,211,153,0.5);border-radius:7px;color:#34d399;cursor:pointer;">⚡ Generate Approved →</button>';

    inner.appendChild(header);
    inner.appendChild(subtext);
    inner.appendChild(grid);
    inner.appendChild(footer);
    modal.appendChild(inner);
    modal.onclick = function(e) { if (e.target === modal) modal.remove(); };
    document.body.appendChild(modal);
  }
  window.openNbApprovalModal = openNbApprovalModal;

  function toggleNbApproval(segIdx) {
    var seg = segments[segIdx];
    if (!seg) return;
    seg.nbApproved = (seg.nbApproved === false) ? true : false;
    var card  = document.getElementById('nb-approval-card-' + segIdx);
    var badge = document.getElementById('nb-approval-badge-' + segIdx);
    var approved = seg.nbApproved !== false;
    if (card)  card.style.borderColor  = approved ? 'rgba(52,211,153,0.7)' : 'rgba(248,113,113,0.5)';
    if (badge) { badge.textContent = approved ? '✓' : '✕'; badge.style.background = approved ? 'rgba(52,211,153,0.9)' : 'rgba(248,113,113,0.85)'; }
    saveSegments();
  }
  window.toggleNbApproval = toggleNbApproval;

  function approveAllNbComposites(approve) {
    segments.forEach(function(seg, idx) {
      if (!seg.nbPreviewDataUrl) return;
      seg.nbApproved = approve;
      var card  = document.getElementById('nb-approval-card-' + idx);
      var badge = document.getElementById('nb-approval-badge-' + idx);
      if (card)  card.style.borderColor  = approve ? 'rgba(52,211,153,0.7)' : 'rgba(248,113,113,0.5)';
      if (badge) { badge.textContent = approve ? '✓' : '✕'; badge.style.background = approve ? 'rgba(52,211,153,0.9)' : 'rgba(248,113,113,0.85)'; }
    });
    saveSegments();
  }
  window.approveAllNbComposites = approveAllNbComposites;

  // ── Regenerate a single NB frame in-place inside the approval modal ────────
  window.regenNbFrame = async function(segIdx) {
    var btn  = document.getElementById('nb-regen-btn-' + segIdx);
    var img  = document.getElementById('nb-approval-img-' + segIdx);
    var card = document.getElementById('nb-approval-card-' + segIdx);

    if (btn) { btn.disabled = true; btn.textContent = '…'; btn.style.opacity = '0.5'; }
    if (img) { img.style.opacity = '0.4'; }

    var ok = await generateNbComposite(segIdx);

    if (ok) {
      var seg = segments[segIdx];
      // Swap image in-place — no modal close/reopen needed
      if (img && seg.nbPreviewDataUrl) {
        img.src = seg.nbPreviewDataUrl;
        img.style.opacity = '1';
      }
      // Auto-approve the fresh frame
      seg.nbApproved = true;
      var badge = document.getElementById('nb-approval-badge-' + segIdx);
      if (card)  card.style.borderColor = 'rgba(52,211,153,0.7)';
      if (badge) { badge.textContent = '✓'; badge.style.background = 'rgba(52,211,153,0.9)'; }
    } else {
      if (img) img.style.opacity = '1';
    }

    if (btn) { btn.disabled = false; btn.textContent = '↺ Redo'; btn.style.opacity = '1'; }
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // PRODUCER PHASE 1 — Generate Master Reference via NB API
  // ─────────────────────────────────────────────────────────────────────────
  // Calls generate-nb-composite with the avatar only (no reference frame) to
  // establish the scene, background, and character anchor for all clips.
  // Result stored as window._sbEstFrameDataUrl and distributed to segments.
  // ═══════════════════════════════════════════════════════════════════════════
  // ─── helper: get JWT ─────────────────────────────────────────────────────
  async function _nbGetJwt() {
    try {
      var _sbRef = (typeof _sb !== 'undefined' && _sb) ? _sb : window._sb;
      if (_sbRef) {
        var sess = await _sbRef.auth.getSession();
        return (sess && sess.data && sess.data.session && sess.data.session.access_token) || null;
      }
    } catch(_) {}
    return null;
  }

  // ─── helper: GPT vision scene description ────────────────────────────────
  async function _nbDescribeScene(imageDataUrl, fallback) {
    var apiKey = (typeof getApiKey === 'function') ? getApiKey() : null;
    if (!apiKey) return fallback;
    try {
      var vRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: [
            { type: 'text', text: 'Describe this scene in 2-3 specific sentences for use as a consistent video background reference. Focus on: the exact surface or counter type, visible props and objects, the background environment, lighting quality and direction, and distinctive visual elements. Be concrete and visual.' },
            { type: 'image_url', image_url: { url: imageDataUrl, detail: 'low' } },
          ]}],
          max_tokens: 200,
        }),
      });
      if (!vRes.ok) return fallback;
      var vData = await vRes.json();
      return ((((vData.choices || [])[0] || {}).message || {}).content || '').trim() || fallback;
    } catch(_) { return fallback; }
  }

  // ─── helper: distribute master frame to all Producer segments ────────────
  function _nbDistributeMaster(masterDataUrl, avatarDesc, sceneRef) {
    segments.forEach(function(seg) {
      if (!seg._scriptOnly) return;
      seg.frameDataUrl = masterDataUrl;
      var action = seg.action || 'speaks naturally to camera with confident eye contact';
      // Note: seg.frameDataUrl is set to masterDataUrl above, so at generation time
      // Photo 1 = avatar, Photo 2 = master reference. The instruction in generateNbComposite
      // will handle the person-swap + pose-change automatically because hasFrame = true.
      // We store the pose/action context here so it gets picked up via seg.action.
      seg.action = action; // ensure action is set for the instruction builder
    });
    if (typeof saveSegments === 'function') saveSegments();
  }

  // ─── Step 1: Setting confirmation modal ──────────────────────────────────
  // Shows before any API call — user edits setting, then hits Generate.
  window.generateNBMasterViaAPI = function() {
    if (!avatarImageDataUrl) {
      showToast('Upload your avatar photo first.', 'warning');
      return;
    }

    var kit         = (typeof getBrandKit === 'function') ? getBrandKit() : {};
    var avatarDesc  = (document.getElementById('avatarDesc')    ? document.getElementById('avatarDesc').value.trim()    : '') || kit.avatarDesc    || 'the presenter';
    var setting     = (document.getElementById('studioSetting') ? document.getElementById('studioSetting').value.trim() : '') || kit.setting       || '';
    var productName = (document.getElementById('sbProduct')     ? document.getElementById('sbProduct').value.trim()     : '') || kit.productName   || '';

    var existing = document.getElementById('nbMasterSetupModal');
    if (existing) existing.remove();

    var overlay = document.createElement('div');
    overlay.id = 'nbMasterSetupModal';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.78);backdrop-filter:blur(6px);padding:16px;';

    overlay.innerHTML = ''
      + '<div style="background:var(--surface);border:1px solid rgba(251,146,60,0.4);border-radius:14px;padding:24px;width:100%;max-width:420px;box-shadow:0 24px 80px rgba(0,0,0,0.6);font-family:inherit;">'
        + '<button onclick="document.getElementById(\'nbMasterSetupModal\').remove()" style="position:absolute;top:12px;right:14px;background:none;border:none;color:var(--text-3);font-size:18px;cursor:pointer;">&#x2715;</button>'
        + '<div style="display:flex;align-items:center;gap:10px;margin-bottom:18px;">'
          + '<div style="width:36px;height:36px;border-radius:9px;background:rgba(251,146,60,0.15);border:1px solid rgba(251,146,60,0.35);display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;">&#x1F3A8;</div>'
          + '<div>'
            + '<div style="font-size:13px;font-weight:800;color:var(--text-1);">Phase 1 — Master Reference</div>'
            + '<div style="font-size:11px;color:var(--text-3);">Set the scene before generating</div>'
          + '</div>'
        + '</div>'

        + '<div style="margin-bottom:14px;">'
          + '<label style="font-size:10px;font-weight:700;color:var(--text-3);letter-spacing:0.08em;text-transform:uppercase;display:block;margin-bottom:6px;">Setting / Background</label>'
          + '<textarea id="nbMasterSettingInput" rows="3" placeholder="e.g. bright modern kitchen with white marble countertop, natural window light, small plant in background..." style="width:100%;background:var(--surface-2);border:1px solid var(--border-2);border-radius:8px;color:var(--text-1);font-size:12px;padding:10px;resize:vertical;font-family:inherit;line-height:1.5;">' + (setting || '') + '</textarea>'
          + '<div style="font-size:10px;color:var(--text-4);margin-top:4px;">Be specific — this locks the background for every scene in your video.</div>'
        + '</div>'

        + '<div style="margin-bottom:18px;">'
          + '<label style="font-size:10px;font-weight:700;color:var(--text-3);letter-spacing:0.08em;text-transform:uppercase;display:block;margin-bottom:6px;">Your Avatar Description <span style="color:var(--text-4);font-weight:400;text-transform:none;">(optional)</span></label>'
          + '<input id="nbMasterAvatarInput" type="text" placeholder="e.g. young woman with long dark hair wearing a white t-shirt..." value="' + avatarDesc.replace(/"/g, '&quot;') + '" style="width:100%;background:var(--surface-2);border:1px solid var(--border-2);border-radius:8px;color:var(--text-1);font-size:12px;padding:9px 10px;font-family:inherit;">'
        + '</div>'

        + '<button id="nbMasterGenBtn" onclick="_nbRunMasterGeneration()" style="width:100%;padding:12px;border-radius:10px;background:linear-gradient(135deg,#fb923c,#f97316);border:none;color:#fff;font-size:13px;font-weight:800;cursor:pointer;font-family:inherit;letter-spacing:0.02em;transition:filter 0.15s;" onmouseenter="this.style.filter=\'brightness(1.1)\'" onmouseleave="this.style.filter=\'\'">&#x26A1; Generate Master Reference</button>'
        + '<div id="nbMasterGenStatus" style="display:none;text-align:center;padding:10px 0 0;font-size:11px;color:var(--text-3);"></div>'
      + '</div>';

    document.body.appendChild(overlay);
    var ta = document.getElementById('nbMasterSettingInput');
    if (ta) setTimeout(function(){ ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 80);
  };

  // ─── Step 2: Run generation (called from setup modal's Generate button) ───
  window._nbRunMasterGeneration = async function() {
    var settingVal  = (document.getElementById('nbMasterSettingInput')  ? document.getElementById('nbMasterSettingInput').value.trim()  : '') || 'a clean well-lit indoor space';
    var avatarVal   = (document.getElementById('nbMasterAvatarInput')   ? document.getElementById('nbMasterAvatarInput').value.trim()   : '') || 'the presenter';
    var kit         = (typeof getBrandKit === 'function') ? getBrandKit() : {};
    var productName = (document.getElementById('sbProduct') ? document.getElementById('sbProduct').value.trim() : '') || kit.productName || '';

    var genBtn    = document.getElementById('nbMasterGenBtn');
    var statusDiv = document.getElementById('nbMasterGenStatus');

    if (genBtn)    { genBtn.disabled = true; genBtn.textContent = 'Generating…'; }
    if (statusDiv) { statusDiv.style.display = 'block'; statusDiv.textContent = 'Calling Nano Banana API — this takes ~15s…'; }

    var jwt = await _nbGetJwt();
    if (!jwt) {
      showToast('Please log in first.', 'warning');
      if (genBtn)    { genBtn.disabled = false; genBtn.textContent = 'Generate Master Reference'; }
      if (statusDiv) { statusDiv.style.display = 'none'; }
      return;
    }

    var instruction = 'Photorealistic UGC video still — master establishing reference. '
      + avatarVal + ' stands or sits in ' + settingVal
      + ', facing camera directly with a natural relaxed expression and soft confident eye contact. '
      + (productName ? productName + ' may be visible on the surface nearby. ' : '')
      + 'Camera: medium shot, vertical 9:16 aspect ratio, soft cinematic key lighting from one side. '
      + 'Style: authentic UGC creator content, single person only, no text overlays, no watermarks, no AI artifacts. '
      + 'This is the MASTER REFERENCE — all other scenes will use this exact background and lighting.';

    try {
      var avatarCompressed = await _nbCompressImage(avatarImageDataUrl, 768, 0.80);
      var avatarParts      = _nbSplitDataUrl(avatarCompressed);

      var res = await fetch('/.netlify/functions/generate-nb-composite', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + jwt },
        body: JSON.stringify({
          instruction,
          avatarB64:  avatarParts.b64,
          avatarMime: avatarParts.mime,
          frameB64:   null,
          frameMime:  'image/jpeg',
        }),
      });

      var data;
      try { data = await res.json(); } catch(_) { data = {}; }

      if (!res.ok || data.error || !data.imageB64) {
        var errMsg = data.error || ('HTTP ' + res.status);
        if (statusDiv) { statusDiv.style.color = 'var(--danger)'; statusDiv.textContent = 'Failed: ' + errMsg; }
        if (genBtn)    { genBtn.disabled = false; genBtn.textContent = 'Retry'; }
        return;
      }

      var masterDataUrl = 'data:' + (data.mime || 'image/png') + ';base64,' + data.imageB64;

      // Close setup modal and show approval modal
      var setupModal = document.getElementById('nbMasterSetupModal');
      if (setupModal) setupModal.remove();

      _nbShowMasterApproval(masterDataUrl, settingVal, avatarVal, productName);

    } catch(e) {
      console.error('[NB Master] error:', e);
      if (statusDiv) { statusDiv.style.color = 'var(--danger)'; statusDiv.textContent = 'Error: ' + (e.message || e); }
      if (genBtn)    { genBtn.disabled = false; genBtn.textContent = 'Retry'; }
    }
  };

  // ─── Step 3: Approval modal — see result, approve or regenerate ───────────
  function _nbShowMasterApproval(masterDataUrl, setting, avatarDesc, productName) {
    var existing = document.getElementById('nbMasterApprovalModal');
    if (existing) existing.remove();

    var overlay = document.createElement('div');
    overlay.id = 'nbMasterApprovalModal';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.82);backdrop-filter:blur(8px);padding:16px;';

    overlay.innerHTML = ''
      + '<div style="background:var(--surface);border:1px solid rgba(52,211,153,0.4);border-radius:14px;padding:22px;width:100%;max-width:460px;box-shadow:0 24px 80px rgba(0,0,0,0.65);font-family:inherit;max-height:90vh;overflow-y:auto;">'

        // Header
        + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">'
          + '<div>'
            + '<div style="font-size:13px;font-weight:800;color:var(--text-1);">&#x1F3A8; Review Master Reference</div>'
            + '<div style="font-size:11px;color:var(--text-3);margin-top:2px;">Approve to lock this scene for all clips, or regenerate.</div>'
          + '</div>'
          + '<button onclick="document.getElementById(\'nbMasterApprovalModal\').remove()" style="background:none;border:none;color:var(--text-3);font-size:18px;cursor:pointer;padding:2px 6px;">&#x2715;</button>'
        + '</div>'

        // Generated image — 9:16 preview
        + '<div style="width:100%;max-width:220px;margin:0 auto 16px;border-radius:10px;overflow:hidden;border:2px solid rgba(52,211,153,0.5);box-shadow:0 0 24px rgba(52,211,153,0.2);">'
          + '<img src="' + masterDataUrl + '" style="width:100%;aspect-ratio:9/16;object-fit:cover;display:block;">'
        + '</div>'

        // Setting used
        + '<div style="background:var(--surface-2);border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:16px;">'
          + '<div style="font-size:9px;font-weight:700;color:var(--text-4);letter-spacing:0.1em;text-transform:uppercase;margin-bottom:4px;">Setting used</div>'
          + '<div style="font-size:12px;color:var(--text-2);line-height:1.5;">' + setting + '</div>'
        + '</div>'

        // Action buttons
        + '<div style="display:flex;flex-direction:column;gap:8px;">'

          // Approve
          + '<button onclick="_nbApproveMaster(\'' + masterDataUrl.replace(/'/g, "\\'") + '\', \'' + setting.replace(/'/g, "\\'") + '\', \'' + avatarDesc.replace(/'/g, "\\'") + '\')" '
            + 'style="width:100%;padding:12px;border-radius:10px;background:linear-gradient(135deg,#00e5bc,#00c4a3);border:none;color:#001a14;font-size:13px;font-weight:800;cursor:pointer;font-family:inherit;transition:filter 0.15s;" '
            + 'onmouseenter="this.style.filter=\'brightness(1.1)\'" onmouseleave="this.style.filter=\'\'">&#x2705; Approve &amp; Lock Scene for All Clips</button>'

          // Regenerate with same settings
          + '<button onclick="document.getElementById(\'nbMasterApprovalModal\').remove();generateNBMasterViaAPI()" '
            + 'style="width:100%;padding:11px;border-radius:10px;background:rgba(251,146,60,0.1);border:1px solid rgba(251,146,60,0.35);color:#fb923c;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;" '
            + 'onmouseenter="this.style.background=\'rgba(251,146,60,0.2)\'" onmouseleave="this.style.background=\'rgba(251,146,60,0.1)\'">&#x21BA; Edit Setting &amp; Regenerate</button>'

        + '</div>'
      + '</div>';

    document.body.appendChild(overlay);
  }
  window._nbShowMasterApproval = _nbShowMasterApproval;

  // ─── Step 4: User approves — distribute master to segments ───────────────
  window._nbApproveMaster = async function(masterDataUrl, setting, avatarDesc) {
    var modal = document.getElementById('nbMasterApprovalModal');
    if (modal) modal.remove();

    // GPT-4o-mini vision: get precise scene description from the image
    showToast('Analyzing scene...', 'info', 4000);
    var sceneDesc = await _nbDescribeScene(masterDataUrl, setting);
    window._sbSceneDesc       = sceneDesc;
    window._sbEstFrameDataUrl = masterDataUrl;

    // Distribute to all Producer segments
    _nbDistributeMaster(masterDataUrl, avatarDesc, sceneDesc);

    var n = segments.filter(function(s){ return s._scriptOnly; }).length;
    showToast('Scene locked for all ' + n + ' clips — ready for Phase 2.', 'success', 5000);

    // Refresh the producer modal to show Phase 1 complete
    var producerModal = document.getElementById('sbProducerModal');
    if (producerModal) { producerModal.remove(); if (typeof sbCopyBrief === 'function') sbCopyBrief(); }

    // Also update Phase 1 button to show success
    var ph1btn = document.getElementById('nbAPIPhase1Btn');
    if (ph1btn) ph1btn.innerHTML = '&#x2705; Master Reference Locked';
  };


  // ═══════════════════════════════════════════════════════════════════════════
  // PRODUCER PHASE 2 — Generate All Per-Scene Start Frames via NB API
  // ─────────────────────────────────────────────────────────────────────────
  // Ensures the master reference is set as frameDataUrl on each Producer
  // segment (so NB treats it as the input image), then calls the existing
  // generateAllNbComposites() loop which handles progress, approval modal, etc.
  // ═══════════════════════════════════════════════════════════════════════════

  // PRODUCER PHASE 2 - Generate All Per-Scene Start Frames via NB API
  // Ensures master reference is on each segment as frameDataUrl, then
  // delegates to generateAllNbComposites() which handles progress + approval.
  window.generateAllNBFramesViaAPI = async function() {
    if (!avatarImageDataUrl) {
      showToast('Upload your avatar photo first.', 'warning');
      return;
    }
    var producerSegs = segments.filter(function(s) {
      return s._scriptOnly && ((s.nbPrompt || '').trim() || s.frameDataUrl);
    });
    if (!producerSegs.length) {
      showToast('Build prompts in Video Producer first.', 'warning');
      return;
    }
    // Distribute master reference frame to segments that don't have one yet
    if (window._sbEstFrameDataUrl) {
      segments.forEach(function(seg) {
        if (seg._scriptOnly && !seg.frameDataUrl) {
          seg.frameDataUrl = window._sbEstFrameDataUrl;
        }
      });
    } else {
      showToast('Tip: run Phase 1 first to lock the background for all scenes. Generating anyway...', 'info', 5000);
    }
    // Delegate to existing loop - handles per-segment calls + approval modal
    if (typeof generateAllNbComposites === 'function') {
      await generateAllNbComposites();
    }
  };
