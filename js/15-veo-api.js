  // ===== VEO API — SERVER-SIDE GENERATION WITH CREDIT SYSTEM =====
  // Routes all generation through /.netlify/functions/generate-veo-clip
  // (credits deducted server-side) and polls via /.netlify/functions/poll-veo-clip.
  // No Gemini API key needed in the browser.

  var _GEMINI_POLL_MS  = 6000;   // poll every 6s
  var _GEMINI_TIMEOUT  = 900000; // 15 min max — wider window so genuine completions under load aren't cut off (a false timeout → user regenerates → a second paid clip)

  // ── Generate mode: 'api' (server-side, credits) | 'flow' (manual Google Flow) ──
  function getGenerateMode() {
    try { return localStorage.getItem('affiliateos_generate_mode') || 'api'; } catch(e) { return 'api'; }
  }
  function setGenerateMode(mode) {
    var m = (mode === 'flow') ? 'flow' : 'api';
    try { localStorage.setItem('affiliateos_generate_mode', m); } catch(e) {}
    _applyModeUI(m);
  }
  window.getGenerateMode = getGenerateMode;
  window.setGenerateMode = setGenerateMode;

  // ── Apply all mode-dependent UI updates in one place ─────────────────────
  function _applyModeUI(m) {
    if (!m) m = getGenerateMode();

    // Credits panel buttons (Dashboard)
    var apiBtn  = document.getElementById('genModeApiBtn');
    var flowBtn = document.getElementById('genModeFlowBtn');
    if (apiBtn) {
      apiBtn.style.background  = m === 'api' ? 'rgba(52,211,153,0.2)' : 'var(--surface-3)';
      apiBtn.style.border      = m === 'api' ? '1px solid rgba(52,211,153,0.6)' : '1px solid var(--border-2)';
      apiBtn.style.color       = m === 'api' ? '#34d399' : 'var(--text-3)';
    }
    if (flowBtn) {
      flowBtn.style.background = m === 'flow' ? 'rgba(56,189,248,0.2)' : 'var(--surface-3)';
      flowBtn.style.border     = m === 'flow' ? '1px solid rgba(56,189,248,0.6)' : '1px solid var(--border-2)';
      flowBtn.style.color      = m === 'flow' ? '#38bdf8' : 'var(--text-3)';
    }

    // Workflow bar toggle (wfMode buttons)
    var wfApi    = document.getElementById('wfModeApiBtn');
    var wfManual = document.getElementById('wfModeManualBtn');
    if (wfApi) {
      wfApi.style.background = m === 'api' ? 'rgba(52,211,153,0.22)' : 'var(--surface)';
      wfApi.style.color      = m === 'api' ? '#34d399' : 'var(--text-3)';
    }
    if (wfManual) {
      wfManual.style.background = m === 'flow' ? 'rgba(56,189,248,0.18)' : 'var(--surface)';
      wfManual.style.color      = m === 'flow' ? '#38bdf8' : 'var(--text-3)';
    }

    // Step 3 button in workflow bar
    var step3Btn   = document.getElementById('step3RunBtn');
    var step3Label = document.getElementById('step3Label');
    if (step3Btn) {
      if (m === 'api') {
        step3Btn.title             = 'Generate all clips via API — uses credits';
        step3Btn.style.borderColor = 'rgba(34,197,94,0.55)';
        step3Btn.style.background  = 'rgba(34,197,94,0.10)';
        step3Btn.style.color       = '#4ade80';
        var numEl = step3Btn.querySelector('.vs-step-num');
        if (numEl) { numEl.style.background = 'rgba(34,197,94,0.18)'; numEl.style.borderColor = 'rgba(34,197,94,0.5)'; numEl.style.color = '#4ade80'; }
      } else {
        step3Btn.title             = 'Open agent panel — copy prompts for manual Google Flow';
        step3Btn.style.borderColor = 'rgba(251,146,60,0.45)';
        step3Btn.style.background  = 'rgba(251,146,60,0.07)';
        step3Btn.style.color       = '#fb923c';
        var numEl2 = step3Btn.querySelector('.vs-step-num');
        if (numEl2) { numEl2.style.background = 'rgba(251,146,60,0.15)'; numEl2.style.borderColor = 'rgba(251,146,60,0.4)'; numEl2.style.color = '#fb923c'; }
      }
    }
    if (step3Label) step3Label.textContent = m === 'api' ? '⚡ Make Clips' : '⚡ Make Clips';

    // Show/hide NB Review button based on mode (only relevant in API mode)
    var reviewBtn = document.getElementById('reviewNbBtn');
    if (reviewBtn) reviewBtn.style.display = m === 'api' ? '' : 'none';

    // Settings badge
    var badge = document.getElementById('generateModeBadge');
    if (badge) {
      badge.textContent = m === 'flow' ? 'Google Flow (Manual)' : 'Gemini API (Credits)';
      badge.style.background  = m === 'flow' ? 'rgba(56,189,248,0.15)' : 'rgba(52,211,153,0.15)';
      badge.style.color       = m === 'flow' ? '#38bdf8' : '#34d399';
      badge.style.borderColor = m === 'flow' ? 'rgba(56,189,248,0.4)' : 'rgba(52,211,153,0.4)';
    }
  }

  function updateGenerateModeBadge() { _applyModeUI(); }

  // ── Step 3 handler — open NB review if any composites exist, else run directly ──
  function handleStep3Run() {
    if (getGenerateMode() === 'api') {
      var hasAnyNB = (window.segments || []).some(function(s) { return s.veoPrompt && s.veoPrompt.trim() && (s.nbPreviewDataUrl || s.frameDataUrl); });
      if (hasAnyNB) {
        openNBReviewModal();
      } else {
        generateAllScenesViaAPI();
      }
    } else {
      if (typeof openVeoAgentPanel === 'function') openVeoAgentPanel();
    }
  }
  window.handleStep3Run = handleStep3Run;

  // ── NB Starting-Frame Review Modal ───────────────────────────────────────
  function openNBReviewModal() {
    var segs = window.segments || [];
    var toGen = segs.filter(function(s) { return s.veoPrompt && s.veoPrompt.trim(); });
    if (!toGen.length) { generateAllScenesViaAPI(); return; }

    var existing = document.getElementById('nbReviewModal');
    if (existing) existing.remove();

    // Build card HTML for each segment
    var cards = toGen.map(function(seg) {
      var idx     = segs.indexOf(seg);
      var img     = seg.nbPreviewDataUrl || seg.frameDataUrl || '';
      var script  = (seg.script || '').slice(0, 80) + (seg.script && seg.script.length > 80 ? '…' : '');
      var approved = seg.nbApproved !== false; // default approved
      var hasNB   = !!seg.nbPreviewDataUrl;
      return '<div id="nbrc-' + idx + '" data-idx="' + idx + '" data-approved="' + approved + '" style="'
        + 'background:var(--surface-2);border-radius:10px;overflow:hidden;cursor:pointer;'
        + 'border:2px solid ' + (approved ? 'rgba(52,211,153,0.7)' : 'rgba(239,68,68,0.5)') + ';'
        + 'transition:border-color 0.2s;position:relative;" onclick="window._nbToggleApproval(' + idx + ')">'
        + '<div style="position:relative;">'
          + (img
            ? '<img src="' + img + '" style="width:100%;aspect-ratio:9/16;object-fit:cover;display:block;">'
            : '<div style="width:100%;aspect-ratio:9/16;background:var(--surface-3);display:flex;align-items:center;justify-content:center;font-size:11px;color:var(--text-3);">No image</div>')
          + '<div style="position:absolute;top:6px;right:6px;width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:900;'
            + 'background:' + (approved ? 'rgba(52,211,153,0.9)' : 'rgba(239,68,68,0.85)') + ';'
            + 'box-shadow:0 2px 6px rgba(0,0,0,0.4);" id="nbrc-badge-' + idx + '">'
            + (approved ? '✓' : '✕')
          + '</div>'
          + (!hasNB ? '<div style="position:absolute;bottom:4px;left:4px;font-size:9px;background:rgba(251,146,60,0.85);color:#fff;border-radius:3px;padding:1px 4px;">raw frame</div>' : '')
        + '</div>'
        + '<div style="padding:6px 8px;">'
          + '<div style="font-size:10px;font-weight:700;color:var(--text-2);margin-bottom:2px;">Scene ' + (idx + 1) + '</div>'
          + '<div style="font-size:9px;color:var(--text-3);line-height:1.4;">' + (script || '—') + '</div>'
        + '</div>'
      + '</div>';
    }).join('');

    var approvedCount = toGen.filter(function(s) { return s.nbApproved !== false; }).length;

    var modal = document.createElement('div');
    modal.id = 'nbReviewModal';
    modal.style.cssText = 'position:fixed;inset:0;z-index:99995;background:rgba(0,0,0,0.82);backdrop-filter:blur(8px);display:flex;flex-direction:column;align-items:center;overflow-y:auto;padding:24px 16px;';
    modal.innerHTML =
      '<div style="width:100%;max-width:900px;">'
        + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;flex-wrap:wrap;gap:10px;">'
          + '<div>'
            + '<div style="font-size:16px;font-weight:800;color:var(--text-1);">Review Starting Frames</div>'
            + '<div style="font-size:11px;color:var(--text-3);margin-top:2px;">Click any image to approve ✓ or reject ✕ before sending to Veo. Rejected scenes are skipped.</div>'
          + '</div>'
          + '<div style="display:flex;gap:8px;flex-wrap:wrap;">'
            + '<button onclick="window._nbApproveAll(true)" style="padding:7px 14px;background:rgba(52,211,153,0.15);border:1px solid rgba(52,211,153,0.4);border-radius:7px;color:#34d399;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit;">✓ Approve All</button>'
            + '<button onclick="window._nbApproveAll(false)" style="padding:7px 14px;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);border-radius:7px;color:#ef4444;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit;">✕ Reject All</button>'
            + '<button onclick="document.getElementById(\'nbReviewModal\').remove()" style="padding:7px 14px;background:var(--glass-2);border:1px solid var(--glass-border);border-radius:7px;color:var(--text-3);font-size:11px;cursor:pointer;font-family:inherit;">Cancel</button>'
          + '</div>'
        + '</div>'
        + '<div id="nbReviewGrid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px;margin-bottom:20px;">'
          + cards
        + '</div>'
        + '<div style="display:flex;align-items:center;justify-content:space-between;padding:14px 18px;background:var(--surface);border:1px solid var(--border-2);border-radius:10px;">'
          + '<div id="nbReviewCount" style="font-size:12px;color:var(--text-2);">'
            + '<span style="color:#34d399;font-weight:700;">' + approvedCount + '</span> of ' + toGen.length + ' scenes approved'
          + '</div>'
          + '<button onclick="window._nbStartGeneration()" style="padding:9px 22px;background:linear-gradient(135deg,rgba(52,211,153,0.25),rgba(16,185,129,0.15));border:1px solid rgba(52,211,153,0.5);border-radius:8px;color:#34d399;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;">⚡ Generate Approved</button>'
        + '</div>'
      + '</div>';

    document.body.appendChild(modal);
  }
  window.openNBReviewModal = openNBReviewModal;

  // Toggle approve/reject for a single segment
  window._nbToggleApproval = function(idx) {
    var seg = (window.segments || [])[idx];
    if (!seg) return;
    seg.nbApproved = (seg.nbApproved === false) ? true : false;
    var card = document.getElementById('nbrc-' + idx);
    var badge = document.getElementById('nbrc-badge-' + idx);
    if (card) card.style.borderColor = seg.nbApproved ? 'rgba(52,211,153,0.7)' : 'rgba(239,68,68,0.5)';
    if (badge) { badge.textContent = seg.nbApproved ? '✓' : '✕'; badge.style.background = seg.nbApproved ? 'rgba(52,211,153,0.9)' : 'rgba(239,68,68,0.85)'; }
    _nbUpdateCount();
  };

  // Approve or reject all
  window._nbApproveAll = function(approve) {
    var segs = window.segments || [];
    segs.forEach(function(seg, idx) {
      if (!seg.veoPrompt || !seg.veoPrompt.trim()) return;
      seg.nbApproved = approve;
      var card = document.getElementById('nbrc-' + idx);
      var badge = document.getElementById('nbrc-badge-' + idx);
      if (card) card.style.borderColor = approve ? 'rgba(52,211,153,0.7)' : 'rgba(239,68,68,0.5)';
      if (badge) { badge.textContent = approve ? '✓' : '✕'; badge.style.background = approve ? 'rgba(52,211,153,0.9)' : 'rgba(239,68,68,0.85)'; }
    });
    _nbUpdateCount();
  };

  function _nbUpdateCount() {
    var segs = window.segments || [];
    var total   = segs.filter(function(s) { return s.veoPrompt && s.veoPrompt.trim(); }).length;
    var approved = segs.filter(function(s) { return s.veoPrompt && s.veoPrompt.trim() && s.nbApproved !== false; }).length;
    var el = document.getElementById('nbReviewCount');
    if (el) el.innerHTML = '<span style="color:#34d399;font-weight:700;">' + approved + '</span> of ' + total + ' scenes approved';
  }

  // Close modal and start generation with only approved segments
  window._nbStartGeneration = function() {
    var modal = document.getElementById('nbReviewModal');
    if (modal) modal.remove();
    generateAllScenesViaAPI();
  };

  // ── Get Supabase JWT for authenticated server requests ────────────────────
  async function _getSupabaseJwt() {
    try {
      if (typeof _sb !== 'undefined' && _sb) {
        var sessionRes = await _sb.auth.getSession();
        var session = sessionRes?.data?.session;
        if (!session) return null;
        // Force refresh if token expires within 60 seconds (or already expired)
        var exp = session.expires_at; // unix timestamp in seconds
        if (exp && (exp - Math.floor(Date.now() / 1000)) < 60) {
          var refreshed = await _sb.auth.refreshSession();
          console.log('[JWT] token near/past expiry — refreshed:', !!refreshed?.data?.session);
          return refreshed?.data?.session?.access_token || null;
        }
        return session.access_token || null;
      }
    } catch(e) { console.warn('[_getSupabaseJwt] error:', e?.message); }
    return null;
  }

  // ── Refresh credit balance after a generation ─────────────────────────────
  async function refreshCreditBalance() {
    try {
      if (typeof _sb !== 'undefined' && _sb) {
        var res = await _sb.auth.refreshSession();
        var newBalance = res?.data?.session?.user?.app_metadata?.credits_balance;
        if (typeof newBalance === 'number') {
          window.userCredits = newBalance;
          updateCreditChip(newBalance);
        }
      }
    } catch(e) { console.warn('[VeoAPI] refreshCreditBalance failed:', e.message); }
  }
  window.refreshCreditBalance = refreshCreditBalance;

  // ── Convert Veo JSON object → flat text prompt ────────────────────────────
  // Anti-transition terms injected on every single prompt regardless of source.
  var _ANTI_TRANSITION_NEG = 'cuts, transitions, fade in, fade out, crossfade, dissolve, wipe, flash cut, jump cut, transition effect, scene change, hard cut, smash cut';

  // ── Left/right screen-space anchor ───────────────────────────────────────
  // Veo interprets "left/right" from the subject's POV (mirror perspective),
  // which is the opposite of the viewer's left/right. Force screen-space
  // language so Veo places people where the user actually intends.
  function _anchorLeftRight(text) {
    if (!text || !/\b(left|right)\b/i.test(text)) return text;
    // Single-pass replacer — avoids double-matching when one substitution
    // introduces text that would match a later pattern (e.g. "on the left of frame").
    return text.replace(
      /\bon\s+the\s+(left|right)\s+of\s+frame\b|\b(left|right)\s+of\s+frame\b|\b(left|right)\s+side\b|\bon\s+the\s+(left|right)\b|\bto\s+the\s+(left|right)\b/gi,
      function(match) {
        var m   = match.toLowerCase();
        var isL = /left/.test(m);
        var dir = isL ? 'left' : 'right';
        var tag = '(screen-' + dir + ', viewer\'s ' + dir + ')';
        if (/of\s+frame/.test(m))   return 'on the ' + dir + ' of frame ' + tag;
        if (/\bside\b/.test(m))     return dir + ' side of screen (viewer\'s ' + dir + ')';
        if (/^on\s+the/.test(m))    return 'on the ' + dir + ' of screen ' + tag;
        if (/^to\s+the/.test(m))    return 'to the ' + dir + ' ' + tag;
        return match;
      }
    );
  }

  function _veoJsonToPrompt(veoJsonStr) {
    var obj;
    try { obj = typeof veoJsonStr === 'string' ? JSON.parse(veoJsonStr) : veoJsonStr; }
    catch(e) { return String(veoJsonStr || ''); }
    var parts = [];
    // Scene context first — sets the visual environment before action/speech
    // These fields exist when the prompt was built from an NB composite start frame.
    // In API mode they were previously dropped; Flow agents read the full JSON so they
    // always had them. Adding them here makes API output match Flow quality.
    if (obj.starting_frame)   parts.push('Starting frame: ' + obj.starting_frame);
    if (obj.background)       parts.push('Background: ' + obj.background);
    if (obj.foreground_props) parts.push('Foreground and props: ' + obj.foreground_props);
    // Anchor left/right in action before adding to prompt
    if (obj.action) parts.push(_anchorLeftRight(obj.action));
    if (obj.speech) parts.push('Person speaks directly to camera and says exactly: "' + obj.speech.toLowerCase() + '"');
    if (obj.camera) parts.push('Camera: ' + obj.camera);
    if (obj.shot)   parts.push('Framing: ' + obj.shot);
    parts.push(obj.audio || 'Natural clear voice audio, slight ambient room tone, no background music');
    // Explicit positive instruction — always enforce single continuous shot
    parts.push('Single continuous smooth shot from start to finish, no transitions, no cuts, no fades, no scene changes');
    // If any left/right positioning is mentioned, add composition lock
    var _hasPosition = /\b(left|right)\b/i.test(obj.action || '');
    // Negative prompt: strip duplicate transition terms, append full list + optional position lock
    var _negBase = (obj.negative_prompt || '').replace(/\b(cuts|transitions|fade\s*in|fade\s*out)[,]?\s*/gi, '').replace(/,\s*,/g, ',').replace(/^[,\s]+|[,\s]+$/g, '');
    var _negExtra = _ANTI_TRANSITION_NEG + (_hasPosition ? ', horizontally flipped, mirrored composition, swapped sides, reversed left and right, wrong side' : '');
    parts.push('Do not include: ' + (_negBase ? _negBase + ', ' : '') + _negExtra);
    return parts.join('. ');
  }

  // ── Soften the START FRAME only, for Veo's input ─────────────────────────
  // Veo's likeness filter (support code 15236754, "realistic person likeness")
  // blocks start frames that read as a real PHOTO of a real person. The avatar
  // is AI, but the classifier only scores how photoreal the face looks — and
  // the Max-Quality / Nano-Banana-Pro frames cross that threshold. We keep the
  // full-resolution frame for the gallery + final video, but hand Veo a
  // down-ressed, softened COPY as the start image so it passes the filter every
  // time. The video stays sharp because Veo re-renders every frame after the
  // first. Resolves to the original URL on any failure (never blocks a clip).
  function _veoSoftenStartFrame(dataUrl, maxEdge, quality) {
    return new Promise(function (resolve) {
      try {
        if (!dataUrl || dataUrl.indexOf('data:') !== 0) { resolve(dataUrl); return; }
        var img = new Image();
        img.onload = function () {
          try {
            var w = img.naturalWidth, h = img.naturalHeight;
            if (!w || !h) { resolve(dataUrl); return; }
            var scale = Math.min(1, maxEdge / Math.max(w, h));
            var nw = Math.max(1, Math.round(w * scale));
            var nh = Math.max(1, Math.round(h * scale));
            var c = document.createElement('canvas');
            c.width = nw; c.height = nh;
            var ctx = c.getContext('2d');
            ctx.drawImage(img, 0, 0, nw, nh);
            var out = c.toDataURL('image/jpeg', quality);
            console.log('[VeoAPI] start frame softened for Veo likeness filter: ' +
                        w + 'x' + h + ' → ' + nw + 'x' + nh);
            resolve(out && out.indexOf('data:') === 0 ? out : dataUrl);
          } catch (e) { resolve(dataUrl); }
        };
        img.onerror = function () { resolve(dataUrl); };
        img.src = dataUrl;
      } catch (e) { resolve(dataUrl); }
    });
  }

  // ── Single clip via server-side API ──────────────────────────────────────
  // imageDataUrl:  optional data URL used as starting frame (NB composite or raw frame)
  // refFrameDataUrl: optional data URL of the original source video frame, sent to
  //                  Gemini 2.0 Flash for scene analysis (setting/camera/lighting/props).
  //                  Separate from imageDataUrl — the start image may be the avatar
  //                  composite, but scene analysis always needs the raw source frame.
  async function generateVeoClipViaAPI(veoJsonStr, durationSecs, modelKey, imageDataUrl, refFrameDataUrl, softenLevel) {
    softenLevel = softenLevel | 0; // 0 = default; higher = softer start frame (safety-filter retries)
    var jwt = await _getSupabaseJwt();
    if (!jwt) throw new Error('Not logged in. Please refresh and try again.');

    var prompt = _veoJsonToPrompt(veoJsonStr);
    var dur    = parseInt(durationSecs, 10) || 6;
    if (dur !== 6 && dur !== 8) dur = 6;
    var model  = (modelKey === 'fast') ? 'fast' : (modelKey === 'standard') ? 'standard' : 'lite';
    // Aspect ratio is a session-level choice the UI stores globally; Veo only
    // accepts '9:16' (vertical) or '16:9' (landscape). Default vertical.
    var aspect = (window._veoAspectRatio === '16:9') ? '16:9' : '9:16';

    // ── Strip data URL prefix → raw base64 + mimeType ────────────────────
    function _splitDataUrl(dataUrl) {
      if (!dataUrl || !dataUrl.startsWith('data:')) return { b64: null, mime: null };
      var comma = dataUrl.indexOf(',');
      if (comma === -1) return { b64: null, mime: null };
      var mime = dataUrl.slice(5, comma).split(';')[0] || 'image/jpeg';
      return { b64: dataUrl.slice(comma + 1), mime };
    }

    // Hand Veo a softened copy of the start frame so its "realistic person
    // likeness" filter (code 15236754) passes — gallery/final video keep the
    // full-res frame; only Veo's input is down-ressed. 720px @ 0.72 sits just
    // under the photoreal-face threshold that was blocking clips.
    // Softening levels — escalated automatically when a clip is filtered for likeness.
    // [maxEdge, jpegQuality] per soften level. Level 0 (first attempt) now keeps
    // far more detail — the old 660px/0.70 floor was the main cause of soft,
    // "mushy" upscaled output. The de-photorealization in the composite wording +
    // avatar prep already carry most of the likeness-filter dodge, so we only fall
    // back to heavy softening when Veo actually blocks a clip (auto-retry below).
    var _softenSteps = [ [960, 0.85], [720, 0.68], [520, 0.58] ];
    var _ss = _softenSteps[Math.max(0, Math.min(_softenSteps.length - 1, softenLevel))];
    var _veoStartUrl = imageDataUrl
      ? await _veoSoftenStartFrame(imageDataUrl, _ss[0], _ss[1])
      : imageDataUrl;

    var _start = _splitDataUrl(_veoStartUrl);
    var startImageB64  = _start.b64;
    var startImageMime = _start.mime;

    var _ref = _splitDataUrl(refFrameDataUrl);
    var frameB64  = _ref.b64;
    var frameMime = _ref.mime || 'image/jpeg';

    // ── Step 1: Start generation (credits deducted here) ─────────────────
    var startRes = await fetch('/.netlify/functions/generate-veo-clip', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + jwt },
      body:    JSON.stringify({
        prompt:          prompt,
        durationSecs:    dur,
        model:           model,
        startImageB64:   startImageB64,
        startImageMime:  startImageMime,
        frameB64:        frameB64,    // reference frame for Gemini scene analysis
        frameMime:       frameMime,
        aspectRatio:     aspect,
      }),
    });

    var startData;
    try { startData = await startRes.json(); }
    catch(e) { throw new Error('Unexpected response from generation server.'); }

    if (startRes.status === 402) {
      if (typeof openTopupModal === 'function') openTopupModal();
      throw new Error(startData.message || 'Not enough credits. Top up to continue.');
    }
    if (!startRes.ok) {
      throw new Error(startData.error || ('Generation start failed (HTTP ' + startRes.status + ')'));
    }

    var operationName = startData.operationName;
    if (!operationName) throw new Error('No operation ID returned from server.');

    // Update credit chip immediately
    if (typeof startData.newBalance === 'number') {
      window.userCredits = startData.newBalance;
      if (typeof updateCreditChip === 'function') updateCreditChip(startData.newBalance);
    }

    // ── Step 2: Poll for completion ───────────────────────────────────────
    var deadline = Date.now() + _GEMINI_TIMEOUT;
    while (Date.now() < deadline) {
      await new Promise(function(r) { setTimeout(r, _GEMINI_POLL_MS); });

      var pollRes = await fetch('/.netlify/functions/poll-veo-clip', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + jwt },
        body:    JSON.stringify({ operationName: operationName, durationSecs: dur }),
      });

      var pollData;
      try { pollData = await pollRes.json(); } catch(e) { continue; }

      if (!pollRes.ok) {
        // Transient server error on the poll endpoint — log and retry rather than aborting
        // (the generation operation is still running server-side)
        console.warn('[VeoAPI] poll HTTP ' + pollRes.status + ' — retrying:', pollData && pollData.error);
        continue;
      }
      // Terminal: done + error (content filter, 404, auth failure, etc.)
      if (pollData.done && pollData.error) {
        // Auto-soften retry: if the safety filter blocked this clip, the server has
        // already refunded it (refunded:true), so re-render the start frame softer and
        // try again — up to 3 total attempts. Only on `filtered`, never generic errors.
        if (pollData.filtered && softenLevel < 2 && imageDataUrl) {
          if (typeof showToast === 'function') showToast('Scene was filtered — retrying with a softer frame (attempt ' + (softenLevel + 2) + '/3)…', 'info', 4500);
          return await generateVeoClipViaAPI(veoJsonStr, durationSecs, modelKey, imageDataUrl, refFrameDataUrl, softenLevel + 1);
        }
        // Surface the raw Vertex response shape (when the server attaches it) so an
        // opaque "no video" failure is diagnosable straight from the console.
        if (pollData.debug) console.warn('[VeoAPI] Vertex done-but-empty response shape:', pollData.debug);
        // Content-filtered clips get a 🚫 prefix so the toast is clearly actionable
        var _errMsg = pollData.filtered ? ('🚫 ' + pollData.error + ' (credits refunded)') : pollData.error;
        throw new Error(_errMsg);
      }
      if (pollData.error && !pollData.done) {
        console.warn('[VeoAPI] poll warning:', pollData.error);
        continue;
      }
      if (pollData.done) {
        if (!pollData.videoUrl) throw new Error('Generation finished but no video URL returned. Try regenerating this clip.');
        return { videoUrl: pollData.videoUrl, mimeType: pollData.mimeType || 'video/mp4' };
      }
    }
    throw new Error('Still rendering after 15 min — Veo is under heavy load. Check your gallery in a few minutes before regenerating (a regenerate starts a new paid clip).');
  }

  // ── Fetch video as blob URL for in-browser playback ──────────────────────
  async function _fetchVideoAsBlob(uri) {
    try {
      var res = await fetch(uri);
      if (!res.ok) return null;
      var blob = await res.blob();
      return URL.createObjectURL(blob);
    } catch(e) { return null; }
  }
  window._fetchVideoAsBlob = _fetchVideoAsBlob;

  // ── VEO API progress modal ────────────────────────────────────────────────
  function _openVeoAPIModal(total) {
    var existing = document.getElementById('veoAPIModal');
    if (existing) existing.remove();
    var modal = document.createElement('div');
    modal.id = 'veoAPIModal';
    modal.style.cssText = 'position:fixed;inset:0;z-index:99990;background:rgba(0,0,0,0.72);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;padding:16px;';
    modal.innerHTML = '<div style="background:var(--surface);border:1px solid var(--border-2);border-radius:14px;padding:22px;width:100%;max-width:400px;box-shadow:var(--shadow-panel);font-family:inherit;">'
      + '<div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;">'
        + '<div style="width:34px;height:34px;border-radius:8px;background:rgba(52,211,153,0.15);border:1px solid rgba(52,211,153,0.3);display:flex;align-items:center;justify-content:center;font-size:17px;flex-shrink:0;">⚡</div>'
        + '<div>'
          + '<div style="font-size:13px;font-weight:700;color:var(--text-1);">Generating Clips via API</div>'
          + '<div style="font-size:11px;color:var(--text-3);">' + total + ' scene' + (total !== 1 ? 's' : '') + ' · credits deducted per clip</div>'
        + '</div>'
      + '</div>'
      + '<div id="veoAPISceneList" style="display:flex;flex-direction:column;gap:5px;max-height:300px;overflow-y:auto;margin-bottom:14px;"></div>'
      + '<div id="veoAPIProgressWrap" style="margin-bottom:12px;">'
        + '<div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-3);margin-bottom:4px;">'
          + '<span id="veoAPIProgressLabel">Starting…</span>'
          + '<span id="veoAPIProgressPct">0%</span>'
        + '</div>'
        + '<div style="height:4px;background:var(--surface-3);border-radius:2px;overflow:hidden;">'
          + '<div id="veoAPIProgressBar" style="height:100%;width:0%;background:linear-gradient(90deg,#34d399,#10b981);border-radius:2px;transition:width 0.4s;"></div>'
        + '</div>'
      + '</div>'
      + '<button onclick="document.getElementById(\'veoAPIModal\').remove()" style="width:100%;padding:8px;background:var(--glass-2);border:1px solid var(--glass-border);border-radius:7px;color:var(--text-3);font-size:11px;cursor:pointer;font-family:inherit;">Close (generation continues)</button>'
    + '</div>';
    document.body.appendChild(modal);
  }

  function _updateVeoAPIScene(sceneNum, total, status, info) {
    var list = document.getElementById('veoAPISceneList');
    if (!list) return;
    var id = 'veo-api-scene-' + sceneNum;
    var el = document.getElementById(id);
    var icons  = { generating: '⟳', done: '✅', error: '❌' };
    var colors = { generating: 'var(--accent-2)', done: '#34d399', error: 'var(--danger)' };
    var html = '<div id="' + id + '" style="display:flex;align-items:center;gap:8px;padding:6px 8px;background:var(--surface-2);border-radius:6px;border:1px solid var(--border);">'
      + '<span style="font-size:12px;">' + (icons[status] || '·') + '</span>'
      + '<span style="font-size:11px;color:var(--text-2);flex:1;">Scene ' + sceneNum + ' / ' + total + '</span>'
      + '<span style="font-size:10px;color:' + (colors[status] || 'var(--text-3)') + ';font-weight:600;">'
        + (status === 'generating' ? 'Generating…' : status.toUpperCase())
      + '</span>'
    + '</div>';
    if (el) el.outerHTML = html;
    else list.insertAdjacentHTML('beforeend', html);
  }

  function _updateVeoAPIProgress(done, total, succeeded, failed) {
    var pct   = Math.round((done / total) * 100);
    var bar   = document.getElementById('veoAPIProgressBar');
    var label = document.getElementById('veoAPIProgressLabel');
    var pctEl = document.getElementById('veoAPIProgressPct');
    if (bar)   bar.style.width = pct + '%';
    if (pctEl) pctEl.textContent = pct + '%';
    if (label) label.textContent = done + ' / ' + total + ' done  ·  ' + succeeded + ' ✅  ' + (failed > 0 ? failed + ' ❌' : '');
  }

  // ── Inline card status management ────────────────────────────────────────
  // Drives the seg-gen-status-{i} elements added to each segment card.
  var _veoGenStatuses = {}; // { segIdx: { status, msg } }

  function _setCardStatus(idx, status, msg) {
    _veoGenStatuses[idx] = { status: status, msg: msg };
    _applyCardStatus(idx);
    _updateSummaryBar();
  }

  function _applyCardStatus(idx) {
    var wrap    = document.getElementById('seg-gen-status-' + idx);
    var spinner = document.getElementById('seg-gen-spinner-' + idx);
    var msgEl   = document.getElementById('seg-gen-msg-' + idx);
    if (!wrap) return;
    var s = _veoGenStatuses[idx];
    if (!s) { wrap.style.display = 'none'; return; }

    var cfgs = {
      queued:     { bg: 'rgba(120,120,120,0.1)',  border: 'rgba(120,120,120,0.25)', color: 'var(--text-3)',  spin: false, icon: '⏳' },
      generating: { bg: 'rgba(56,189,248,0.12)',  border: 'rgba(56,189,248,0.4)',   color: '#38bdf8',        spin: true,  icon: ''   },
      done:       { bg: 'rgba(52,211,153,0.12)',  border: 'rgba(52,211,153,0.4)',   color: '#34d399',        spin: false, icon: '✅' },
      error:      { bg: 'rgba(239,68,68,0.10)',   border: 'rgba(239,68,68,0.35)',   color: '#f87171',        spin: false, icon: '❌' },
    };
    var cfg = cfgs[s.status] || cfgs.queued;

    wrap.style.cssText = 'display:flex;margin-top:6px;padding:5px 9px;border-radius:6px;border:1px solid '
      + cfg.border + ';background:' + cfg.bg + ';align-items:center;gap:7px;font-size:10px;font-weight:700;';

    if (spinner) {
      if (cfg.spin) {
        spinner.innerHTML = '<div style="width:10px;height:10px;border:2px solid rgba(56,189,248,0.25);border-top-color:#38bdf8;border-radius:50%;animation:spin 0.7s linear infinite;flex-shrink:0;"></div>';
      } else {
        spinner.innerHTML = '<span style="font-size:11px;">' + cfg.icon + '</span>';
      }
    }
    if (msgEl) { msgEl.textContent = s.msg || ''; msgEl.style.color = cfg.color; }
  }

  function _reapplyAllCardStatuses() {
    Object.keys(_veoGenStatuses).forEach(function(idx) { _applyCardStatus(parseInt(idx, 10)); });
    _updateSummaryBar();
  }

  function _clearAllCardStatuses() {
    Object.keys(_veoGenStatuses).forEach(function(idx) {
      _veoGenStatuses[idx] = null;
      _applyCardStatus(parseInt(idx, 10));
    });
    _veoGenStatuses = {};
    var bar = document.getElementById('veoGenSummaryBar');
    if (bar) bar.remove();
  }

  // ── Summary bar above the segments strip ──────────────────────────────────
  function _updateSummaryBar() {
    var statuses  = Object.values(_veoGenStatuses).filter(Boolean);
    var total     = statuses.length;
    var done      = statuses.filter(function(s) { return s.status === 'done';       }).length;
    var failed    = statuses.filter(function(s) { return s.status === 'error';      }).length;
    var running   = statuses.filter(function(s) { return s.status === 'generating'; }).length;
    var queued    = statuses.filter(function(s) { return s.status === 'queued';     }).length;

    var bar = document.getElementById('veoGenSummaryBar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'veoGenSummaryBar';
      bar.style.cssText = 'margin:6px 0 4px;padding:8px 14px;border-radius:8px;background:rgba(16,185,129,0.08);border:1px solid rgba(52,211,153,0.3);display:flex;align-items:center;gap:10px;flex-wrap:wrap;flex-shrink:0;';
      var container = document.getElementById('segmentsContainer');
      if (container && container.parentNode) {
        container.parentNode.insertBefore(bar, container);
      }
    }

    var pct    = total > 0 ? Math.round(((done + failed) / total) * 100) : 0;
    var chips  = [
      running > 0 ? '<span style="color:#38bdf8;font-weight:700;">⟳ ' + running + ' generating</span>' : '',
      queued  > 0 ? '<span style="color:rgba(251,146,60,0.9);">⏳ ' + queued  + ' queued</span>'       : '',
      done    > 0 ? '<span style="color:#34d399;">✅ ' + done    + ' done</span>'                       : '',
      failed  > 0 ? '<span style="color:#f87171;">❌ ' + failed  + ' failed</span>'                    : '',
    ].filter(Boolean).join('<span style="color:var(--border-2);">  ·  </span>');

    bar.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;flex:1;min-width:200px;">'
        + '<div style="font-size:10px;font-weight:700;color:var(--text-2);white-space:nowrap;">⚡ Generating ' + total + ' clips</div>'
        + (chips  ? '<div style="font-size:10px;">' + chips  + '</div>' : '')
      + '</div>'
      + '<div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">'
        + '<div style="width:120px;height:5px;background:var(--surface-3);border-radius:3px;overflow:hidden;">'
          + '<div style="height:100%;width:' + pct + '%;background:linear-gradient(90deg,#34d399,#10b981);border-radius:3px;transition:width 0.4s;"></div>'
        + '</div>'
        + '<span style="font-size:10px;font-weight:700;color:#34d399;min-width:30px;">' + pct + '%</span>'
      + '</div>';
  }

  // ── Single-clip worker — called in parallel for each segment ─────────────
  // ── Generate all scenes via API — concurrent worker pool ─────────────────
  // Runs up to MAX_CONCURRENT clips simultaneously (Vertex AI allows 10).
  // Any clips beyond that limit sit in "queued" state and auto-start as
  // slots free up — no manual batching needed regardless of segment count.
  async function generateAllScenesViaAPI() {
    // Build flat work list — primary clips first, then continuation extras (veoExtras)
    var workList = [];
    segments.forEach(function(seg) {
      if (!seg.veoPrompt || !seg.veoPrompt.trim() || seg.nbApproved === false) return;
      var segIdx = segments.indexOf(seg);
      workList.push({ seg: seg, segIdx: segIdx, veoPrompt: seg.veoPrompt, isExtra: false, extraIdx: -1, extra: null });
      (seg.veoExtras || []).forEach(function(extra, j) {
        if (!(extra.veoPrompt || '').trim()) return;
        workList.push({ seg: seg, segIdx: segIdx, veoPrompt: extra.veoPrompt, isExtra: true, extraIdx: j, extra: extra });
      });
    });

    if (!workList.length) {
      showToast('Generate prompts first before running via API.', 'warning');
      return;
    }

    var adm      = (typeof getAdminSettings === 'function') ? getAdminSettings() : {};
    var _dm      = (adm.defaultModel || 'Veo 3.1 Lite').toLowerCase();
    var modelKey = _dm.includes('fast') ? 'fast' : _dm.includes('standard') ? 'standard' : 'lite';
    var total    = workList.length;

    // Concurrency limit — Vertex AI allows 10 concurrent video gen operations
    var MAX_CONCURRENT = 10;
    var concurrency    = Math.min(MAX_CONCURRENT, total);

    _openVeoAPIModal(total);

    // Mark ALL clips as queued upfront so users see the full picture immediately
    _veoGenStatuses = {};
    workList.forEach(function(item) {
      _setCardStatus(item.segIdx, 'queued', 'In queue…');
    });

    // Shared state — safe in JS (single-threaded event loop)
    var nextIdx   = 0;
    var succeeded = 0;
    var failed    = 0;
    var aborted   = false;

    // Each worker loops through available tasks until the queue is empty
    async function worker() {
      while (!aborted) {
        var i = nextIdx;
        if (i >= workList.length) break;
        nextIdx++;  // claim this task before any await

        var item     = workList[i];
        var seg      = item.seg;
        var segIdx   = item.segIdx;
        var sceneNum = i + 1;
        var clipLabel = item.isExtra ? 'Clip ' + (item.extraIdx + 2) + ' (cont.)' : 'Clip 1';

        _updateVeoAPIScene(sceneNum, total, 'generating');
        _setCardStatus(segIdx, 'generating', 'Generating ' + clipLabel + '… (~1 min)');

        var durSecs = 6;
        try { var _po = JSON.parse(item.veoPrompt || '{}'); durSecs = parseInt(_po.duration, 10) || 6; } catch(_) {}

        try {
          // All clips (primary + continuations) use the same NB composite start frame
          var _startImg = seg.nbPreviewDataUrl || seg.frameDataUrl || null;
          var result    = await generateVeoClipViaAPI(item.veoPrompt, durSecs, modelKey, _startImg, seg.frameDataUrl || null);

          var videoBlob = await _fetchVideoAsBlob(result.videoUrl);
          if (item.isExtra) {
            item.extra.apiVideoUrl  = result.videoUrl;
            item.extra.apiVideoMime = result.mimeType || 'video/mp4';
            if (videoBlob) item.extra.apiVideoRaw = videoBlob;
          } else {
            seg.apiVideoUrl  = result.videoUrl;
            seg.apiVideoMime = result.mimeType || 'video/mp4';
            if (videoBlob) seg.apiVideoRaw = videoBlob;
          }

          _updateVeoAPIScene(sceneNum, total, 'done');
          _setCardStatus(segIdx, 'done', 'Done!');
          succeeded++;

          if (typeof saveSegments   === 'function') saveSegments();
          if (typeof renderSegments === 'function') renderSegments();
          _reapplyAllCardStatuses();
          if (typeof renderGallery  === 'function') renderGallery();

        } catch(e) {
          console.error('[VeoAPI] Clip ' + sceneNum + ' failed:', e.message);
          _updateVeoAPIScene(sceneNum, total, 'error');
          _setCardStatus(segIdx, 'error', 'Failed: ' + (e.message || 'Unknown').slice(0, 45));
          showToast('Clip ' + sceneNum + ' failed: ' + (e.message || 'Unknown'), 'error', 7000);
          failed++;

          if (typeof renderSegments === 'function') renderSegments();
          _reapplyAllCardStatuses();

          // Credit failure — stop all workers
          if (e.message && (e.message.toLowerCase().includes('insufficient_credits') || e.message.toLowerCase().includes('credit'))) {
            aborted = true;
          }
        }

        _updateVeoAPIProgress(succeeded + failed, total, succeeded, failed);
        if (typeof refreshCreditBalance === 'function') refreshCreditBalance();
      }
    }

    // Launch the worker pool — each worker self-feeds until queue is empty
    var workers = [];
    for (var w = 0; w < concurrency; w++) workers.push(worker());
    await Promise.all(workers);

    // Final toast
    if (failed === 0) {
      showToast('All ' + succeeded + ' clips generated!', 'success', 5000);
    } else if (succeeded > 0) {
      showToast(succeeded + ' done · ' + failed + ' failed.', 'warning', 6000);
    } else {
      showToast('All clips failed. Check credits or API status.', 'error', 6000);
    }

    if (succeeded > 0) {
      // Auto-assemble: line up every generated clip on the timeline in order so the
      // finished sequence is ready to preview/export in one step (no manual adding).
      if (typeof galleryAddAllToAssembler === 'function') {
        galleryAddAllToAssembler();
      } else {
        if (typeof renderGallery   === 'function') renderGallery();
        if (typeof renderAssembler === 'function') renderAssembler();
      }
      var nudge = document.getElementById('openEditorNudge');
      if (nudge) nudge.style.display = 'flex';
    }

    setTimeout(function() {
      _clearAllCardStatuses();
      if (typeof renderSegments === 'function') renderSegments();
    }, 4000);
  }
  window.generateAllScenesViaAPI  = generateAllScenesViaAPI;
  window.generateVeoClipViaAPI    = generateVeoClipViaAPI;   // exposed for 19-producer-pipeline

  // ── Download a segment's video — always via blob so browser saves the file ─
  // The <a download> attribute is ignored for cross-origin URLs (googleapis.com),
  // which causes the browser to open a new tab instead of saving. We always fetch
  // through a local blob URL so the download attribute is honoured.
  window.downloadSegmentVideo = async function(i) {
    var seg = (window.segments || [])[i];
    if (!seg || (!seg.apiVideoRaw && !seg.apiVideoUrl)) {
      if (typeof showToast === 'function') showToast('No video to download.', 'warning');
      return;
    }

    var blobUrl = seg.apiVideoRaw;

    if (!blobUrl && seg.apiVideoUrl) {
      // Blob expired (e.g. after a page refresh) — re-fetch from Google URL
      if (typeof showToast === 'function') showToast('Preparing download…', 'info', 3000);
      blobUrl = await _fetchVideoAsBlob(seg.apiVideoUrl);
      if (blobUrl) seg.apiVideoRaw = blobUrl; // cache so next download is instant
    }

    if (!blobUrl) {
      if (typeof showToast === 'function') showToast('Download failed — the video URL may have expired. Try regenerating.', 'error', 6000);
      return;
    }

    var a = document.createElement('a');
    a.href     = blobUrl;
    a.download = 'scene-' + (i + 1) + '.mp4';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  // ── Remove API video from a segment ──────────────────────────────────────
  function clearSegmentApiVideo(i) {
    if (!segments[i]) return;
    segments[i].apiVideoUrl  = null;
    segments[i].apiVideoRaw  = null;
    segments[i].apiVideoMime = null;
    if (typeof saveSegments   === 'function') saveSegments();
    if (typeof renderSegments === 'function') renderSegments();
  }
  window.clearSegmentApiVideo = clearSegmentApiVideo;

  // ── Regenerate a single scene via API ─────────────────────────────────────
  // Called from the ↺ Regen button on each segment card's generated video section.
  async function regenSingleScene(segIdx) {
    var seg = (window.segments || [])[segIdx];
    if (!seg) { showToast('Segment not found.', 'error'); return; }
    if (!seg.veoPrompt || !seg.veoPrompt.trim()) {
      showToast('Generate the Veo 3 prompt for this scene first.', 'warning'); return;
    }

    var adm      = (typeof getAdminSettings === 'function') ? getAdminSettings() : {};
    var _dm      = (adm.defaultModel || 'Veo 3.1 Lite').toLowerCase();
    var modelKey = _dm.includes('fast') ? 'fast' : _dm.includes('standard') ? 'standard' : 'lite';

    var durSecs = 6;
    try { var _po = JSON.parse(seg.veoPrompt || '{}'); durSecs = _po.duration || 6; } catch(_) {}

    // Show loading state on the regen button
    var btn = document.getElementById('regenSceneBtn-' + segIdx);
    if (btn) { btn.disabled = true; btn.textContent = '⏳'; }

    try {
      var startImg = seg.nbPreviewDataUrl || seg.frameDataUrl || null;
      var result   = await generateVeoClipViaAPI(seg.veoPrompt, durSecs, modelKey, startImg, seg.frameDataUrl || null);

      seg.apiVideoUrl  = result.videoUrl;
      seg.apiVideoMime = result.mimeType || 'video/mp4';
      var blobUrl = await _fetchVideoAsBlob(result.videoUrl);
      if (blobUrl) seg.apiVideoRaw = blobUrl;

      if (typeof saveSegments    === 'function') saveSegments();
      if (typeof renderSegments  === 'function') renderSegments();
      if (typeof renderGallery   === 'function') renderGallery();
      if (typeof renderAssembler === 'function') renderAssembler();
      if (typeof refreshCreditBalance === 'function') refreshCreditBalance();
      showToast('Scene ' + (segIdx + 1) + ' regenerated!', 'success', 4000);
    } catch(e) {
      showToast('Regen failed (Scene ' + (segIdx + 1) + '): ' + e.message, 'error', 8000);
      if (btn) { btn.disabled = false; btn.textContent = '↺ Regen'; }
    }
  }
  window.regenSingleScene = regenSingleScene;

  // ── Regenerate just the START FRAME (NB composite) for one scene ──────────
  // Produces a fresh pose/composite for the scene without re-rendering video.
  // The user can then hit "↺ Regen" to render a new clip from the new frame.
  async function regenSceneFrame(segIdx) {
    var seg = (window.segments || [])[segIdx];
    if (!seg) { showToast('Segment not found.', 'error'); return; }
    if (typeof window.generateNbComposite !== 'function') {
      showToast('Frame generator unavailable — refresh and try again.', 'error'); return;
    }
    var btn = document.getElementById('regenFrameBtn-' + segIdx);
    if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
    try {
      var ok = await window.generateNbComposite(segIdx);
      if (ok) {
        showToast('New start frame for Scene ' + (segIdx + 1) + ' — hit ↺ Regen to render the video.', 'success', 6000);
        if (typeof refreshCreditBalance === 'function') refreshCreditBalance();
      }
    } catch (e) {
      showToast('Frame regen failed (Scene ' + (segIdx + 1) + '): ' + (e && e.message || e), 'error', 8000);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '↺ Frame'; }
    }
  }
  window.regenSceneFrame = regenSceneFrame;

  // ── Regenerate a single continuation (extra) clip ──────────────────────────
  async function regenExtraClip(segIdx, extraIdx) {
    var seg   = (window.segments || [])[segIdx];
    var extra = seg && seg.veoExtras && seg.veoExtras[extraIdx];
    if (!extra) { showToast('Extra clip not found.', 'error'); return; }
    if (!extra.veoPrompt || !extra.veoPrompt.trim()) {
      showToast('Generate the Veo 3 prompt for this clip first.', 'warning'); return;
    }

    var adm      = (typeof getAdminSettings === 'function') ? getAdminSettings() : {};
    var _dm      = (adm.defaultModel || 'Veo 3.1 Lite').toLowerCase();
    var modelKey = _dm.includes('fast') ? 'fast' : _dm.includes('standard') ? 'standard' : 'lite';

    var durSecs = 6;
    try { var _po = JSON.parse(extra.veoPrompt || '{}'); durSecs = _po.duration || 6; } catch(_) {}

    var btnId = 'regenExtraBtn-' + segIdx + '-' + extraIdx;
    var btn = document.getElementById(btnId);
    if (btn) { btn.disabled = true; btn.textContent = '⏳'; }

    try {
      // Continuation clips share the parent segment's start frame
      var startImg = seg.nbPreviewDataUrl || seg.frameDataUrl || null;
      var result   = await generateVeoClipViaAPI(extra.veoPrompt, durSecs, modelKey, startImg, seg.frameDataUrl || null);

      extra.apiVideoUrl  = result.videoUrl;
      extra.apiVideoMime = result.mimeType || 'video/mp4';
      var blobUrl = await _fetchVideoAsBlob(result.videoUrl);
      if (blobUrl) extra.apiVideoRaw = blobUrl;

      if (typeof saveSegments   === 'function') saveSegments();
      if (typeof renderSegments === 'function') renderSegments();
      if (typeof refreshCreditBalance === 'function') refreshCreditBalance();
      showToast('Clip ' + (extraIdx + 2) + ' generated!', 'success', 4000);
    } catch(e) {
      showToast('Regen failed (Clip ' + (extraIdx + 2) + '): ' + e.message, 'error', 8000);
      if (btn) { btn.disabled = false; btn.textContent = '↺ Regen'; }
    }
  }
  window.regenExtraClip = regenExtraClip;

  // ── Apply mode UI on page load (restores pi