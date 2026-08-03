  // ===== VEO API — SERVER-SIDE GENERATION WITH CREDIT SYSTEM =====
  // Routes all generation through /.netlify/functions/generate-veo-clip
  // (credits deducted server-side) and polls via /.netlify/functions/poll-veo-clip.
  // No Gemini API key needed in the browser.

  var _GEMINI_POLL_MS  = 9000;   // poll every 9s (was 6s — eases load on kie's rate limit + the status-poll endpoint)
  var _GEMINI_TIMEOUT  = 900000; // 15 min max — wider window so genuine completions under load aren't cut off (a false timeout → user regenerates → a second paid clip)

  // ── Omni Flash (Gemini Omni via kie) helpers ──────────────────────────────
  // Per-duration credit cost (must mirror OMNI_COSTS in generate-veo-clip.js).
  var _OMNI_COST = { 4: 50, 6: 65, 8: 85, 10: 100 };
  // The user-chosen Omni duration (persisted globally on window._omniDurationSecs by 06-analyze.js).
  function _omniDurNow() {
    var d = (typeof window !== 'undefined') ? parseInt(window._omniDurationSecs, 10) : NaN;
    return ([4, 6, 8, 10].indexOf(d) !== -1) ? d : 8;
  }
  // Map the stored defaultModel label → generation modelKey ('omni'|'fast'|'standard'|'lite').
  function _modelKeyFromDm(dm) {
    dm = (dm || '').toLowerCase();
    return dm.indexOf('omni')     !== -1 ? 'omni'
         : dm.indexOf('fast')     !== -1 ? 'fast'
         : dm.indexOf('standard') !== -1 ? 'standard'
         : 'lite';
  }

  // ── Generation speed preference ('' = Cheaper via kie [default] · 'vertex' = Faster, direct) ──
  // Applies to BOTH the Replicator and the Studio (read when building the generate request).
  try { window._veoProviderPref = localStorage.getItem('veoProvider') || ''; } catch(e) { window._veoProviderPref = ''; }
  // Relabel the Studio video quality dropdown with doubled credits when Faster is on.
  window.updateVeoCostLabels = function () {
    var mult = (window._veoProviderPref === 'vertex') ? 2 : 1;
    var base = { lite: 15, fast: 30, standard: 80 };
    var lbl  = { lite: '◈ Lite', fast: '⚡ Fast', standard: '✦ Quality' };
    try {
      document.querySelectorAll('#fsVidModel option').forEach(function (o) {
        if (base[o.value] != null) o.textContent = lbl[o.value] + ' · ~' + (base[o.value] * mult) + ' cr';
      });
    } catch (_) {}
  };
  window.setVeoProvider = function (p) {
    window._veoProviderPref = (p === 'vertex') ? 'vertex' : '';
    try { localStorage.setItem('veoProvider', window._veoProviderPref); } catch(_) {}
    try { document.querySelectorAll('.veo-speed-sel').forEach(function (s) { s.value = window._veoProviderPref; }); } catch(_) {}
    window.updateVeoCostLabels();
    if (typeof showToast === 'function') showToast(window._veoProviderPref === 'vertex'
      ? '⚡ Faster mode — clips generate direct (quicker, 2× credits)'
      : '💸 Cheaper mode — clips route through kie (best price)', 'info', 3200);
  };
  try { document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('.veo-speed-sel').forEach(function (s) { s.value = window._veoProviderPref || ''; });
    window.updateVeoCostLabels();
  }); } catch(_) {}

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
    if (step3Label) step3Label.textContent = '⚡ Make Clips';

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
  // Debounced: a completion wave can fire up to ~10 of these (one per clip) in a tight
  // burst, each doing a Supabase token refresh → a refresh storm. We collapse calls within
  // a short window to a single token refresh, while guaranteeing a TRAILING refresh so the
  // balance still settles to the correct value after the last clip finishes.
  var _REFRESH_DEBOUNCE_MS = 1500;
  var _lastCreditRefresh = 0;
  var _trailingRefreshTimer = null;
  async function _doRefreshCreditBalance() {
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
  async function refreshCreditBalance() {
    var now = Date.now();
    if (now - _lastCreditRefresh < _REFRESH_DEBOUNCE_MS) {
      // Too soon after the last refresh — suppress this call, but schedule a single
      // trailing refresh so the final balance is still fetched once the burst settles.
      if (!_trailingRefreshTimer) {
        _trailingRefreshTimer = setTimeout(function () {
          _trailingRefreshTimer = null;
          _lastCreditRefresh = Date.now();
          _doRefreshCreditBalance();
        }, _REFRESH_DEBOUNCE_MS);
      }
      return;
    }
    _lastCreditRefresh = now;
    return _doRefreshCreditBalance();
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

    // ── Green-screen overlay mode ──────────────────────────────────────────────
    // The start frame is the avatar on flat chroma green (see 17-nb-api.js). Force
    // the background to stay green + static so it keys cleanly, and push the subject
    // to gesture energetically so the composited character isn't stagnant. When on,
    // this overrides the obj.background field (which would otherwise re-describe a
    // scene) and we skip the wardrobe/scene fields further down where noted.
    var _gsVeo = false;
    try { _gsVeo = !!(window._greenScreenOverlay || obj.overlayGreen); } catch(_) {}
    if (_gsVeo) {
      parts.push('Background: a single perfectly flat, solid chroma-green screen (#00b140), edge to edge, evenly lit and completely STATIC — the background never changes, moves, brightens, or gains any text, UI, charts, or objects at any point');
      parts.push('Keep the green background clean with no shadows cast onto it and no green spill onto the subject\'s skin, hair, or clothing');
    }

    // Scene context first — sets the visual environment before action/speech
    // These fields exist when the prompt was built from an NB composite start frame.
    // In API mode they were previously dropped; Flow agents read the full JSON so they
    // always had them. Adding them here makes API output match Flow quality.
    if (obj.starting_frame)   parts.push('Starting frame: ' + obj.starting_frame);
    if (obj.background && !_gsVeo) parts.push('Background: ' + obj.background);
    if (obj.foreground_props) parts.push('Foreground and props: ' + obj.foreground_props);
    // Anchor left/right in action before adding to prompt
    if (obj.action) parts.push(_anchorLeftRight(obj.action));
    if (_gsVeo) {
      // Composited character must be lively, not stiff — match the energy of the
      // reference talker (pointing at on-screen numbers, leaning in, hand emphasis).
      parts.push('The subject is animated and expressive throughout: active hand gestures and pointing, leaning slightly toward the camera on emphasis, natural head movement, shifting weight, engaged eyebrows and mouth — never a stiff, frozen, or static pose');
      parts.push('Camera: handheld with subtle natural micro-movement');
    }
    // Speaker lock — keep the INTENDED speaker (whoever the action names, which may be a
    // background or specific person) as the only one who talks, and freeze everyone else's
    // mouth. We deliberately do NOT assume the "main" person, so you can direct any person.
    if (obj.speech) parts.push('Exactly ONE person speaks this line and says exactly: "' + obj.speech.toLowerCase() + '". The speaker is the specific person named in the action above — keep the line with that exact person and never switch it to anyone else. Every OTHER person in the shot stays completely silent the entire time with their mouth closed and still, and never lip-syncs, mouths, or mimes any words');
    if (obj.camera) parts.push('Camera: ' + obj.camera);
    if (obj.shot)   parts.push('Framing: ' + obj.shot);
    parts.push(obj.audio || 'Natural clear voice audio, slight ambient room tone, no background music');
    // Explicit positive instruction — always enforce single continuous shot
    parts.push('Single continuous smooth shot from start to finish, no transitions, no cuts, no fades, no scene changes');
    // Wardrobe lock — Veo otherwise morphs clothing mid-clip (e.g. "puts clothes on") or
    // bleeds a garment from the source video. Force the outfit to stay identical and on.
    parts.push('The person wears the exact same outfit for the entire clip — their clothing stays identical and stays on; they do NOT put on, take off, change, or adjust any clothing, robe, or kimono at any point');
    // If any left/right positioning is mentioned, add composition lock
    var _hasPosition = /\b(left|right)\b/i.test(obj.action || '');
    // Hand / product integrity — Veo loves to sprout a SECOND hand or split the held product
    // into two. When the action asks for one hand and/or holds a product, force a single hand
    // and one intact object, as a POSITIVE instruction AND negatives (kie has no separate
    // negative-prompt field, so both must live inside the prompt text).
    var _actTxt = (obj.action || '');
    var _oneHand = /\b(one|single|1)[\s-]*hand(ed)?\b/i.test(_actTxt) || /\bwith one hand\b/i.test(_actTxt);
    var _holdsProduct = /\b(hold|holds|holding|apply|applies|applying|swipe|swipes|dab|dabs|press|presses|rub|rubs|wipe|wipes|use[sd]? (?:the|a|it)|with (?:her|his|the) hand)\b/i.test(_actTxt);
    if (_oneHand) {
      parts.push('She uses ONLY ONE hand for the entire clip — the other hand stays relaxed at her side or fully out of frame and never enters the shot; she holds exactly ONE single product that stays whole and intact the entire time (it is never duplicated, cloned, or split)');
    }
    var _handNeg = _oneHand ? ', two hands, both hands, second hand entering frame, extra hand, third hand, extra arm' : '';
    var _prodNeg = (_oneHand || _holdsProduct) ? ', duplicate product, two products, cloned product, split product, product splitting in half, product breaking apart, extra fingers, sixth finger, deformed hands, merged hands, morphing hands' : '';
    // Speaker negatives — only when there IS a spoken line, to stop the wrong person lip-syncing.
    var _speechNeg = obj.speech ? ', wrong person speaking, wrong person talking, background person talking, second person talking, another person mouthing words, the person lying down talking, the person being treated talking, both people talking at once, lip sync on the wrong person, mouth moving on a silent person' : '';
    // Negative prompt: strip duplicate transition terms, append full list + optional position lock
    var _negBase = (obj.negative_prompt || '').replace(/\b(cuts|transitions|fade\s*in|fade\s*out)[,]?\s*/gi, '').replace(/,\s*,/g, ',').replace(/^[,\s]+|[,\s]+$/g, '');
    var _wardrobeNeg = ', changing clothes, putting on clothing, taking off clothing, dressing, undressing, adjusting clothing, wardrobe change, outfit change, clothes morphing, new garment appearing, robe appearing, kimono, putting on a robe';
    // Suppress invented tattoos (skipped automatically if the avatar is tattooed).
    var _tatNeg = (typeof window.antiTattooNeg === 'function') ? window.antiTattooNeg() : '';
    var _gsNeg = _gsVeo ? ', background changing, patterned or textured background, app UI appearing, charts, text or numbers appearing, environment appearing behind subject, green spill on skin or hair, static frozen stiff pose' : '';
    var _negExtra = _ANTI_TRANSITION_NEG + _wardrobeNeg + _gsNeg + _handNeg + _prodNeg + _speechNeg + (_hasPosition ? ', horizontally flipped, mirrored composition, swapped sides, reversed left and right, wrong side' : '') + (_tatNeg ? ', ' + _tatNeg : '');
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
  // Veo's person-likeness / usage-guidelines block on the INPUT IMAGE. Vertex
  // surfaces this several ways (support code 15236754, "usage guidelines",
  // "violates", "responsible AI") and NOT always via the structured filter flag,
  // so we pattern-match the message to trigger the soften-and-retry path.
  function _isLikenessBlock(msg) {
    if (!msg) return false;
    return /15236754|usage guidelines|violat|responsible ai|safety (?:filter|guidelines)|input image/i.test(String(msg));
  }

  // Transient backend hiccups from Vertex/Veo (NOT content blocks) — e.g. "Internal
  // error. Please try again later", "service unavailable", "deadline exceeded". These
  // clear on a retry. Kept separate from _isLikenessBlock so we retry the SAME frame
  // (the frame is fine; Google's backend just stumbled), not regenerate a wider one.
  function _isTransientError(msg) {
    if (!msg) return false;
    return /internal error|try again later|please try again|temporarily|unavailable|deadline exceeded|backend error|service error|\b50[023]\b/i.test(String(msg));
  }
  // Veo intermittently fails to generate AUDIO for a request ("...was unable to generate
  // audio for this request. Please try a different prompt."). It usually clears on a plain
  // retry of the same clip, so treat it as retryable rather than a hard failure.
  function _isAudioError(msg) {
    if (!msg) return false;
    return /unable to generate audio|generate audio for this request|could ?n'?t generate audio|failed to generate audio|no audio (?:was )?generated/i.test(String(msg));
  }

  async function generateVeoClipViaAPI(veoJsonStr, durationSecs, modelKey, imageDataUrl, refFrameDataUrl, softenLevel, segIdx, framingLevel, transientRetry, outerDeadline) {
    softenLevel    = softenLevel | 0;  // 0 = default; higher = softer start frame (fallback retries when no segIdx)
    framingLevel   = framingLevel | 0; // 0 = normal; higher = wider/cleaner regenerated composite (auto-escalate)
    transientRetry = transientRetry | 0; // 0 = first attempt; bumped on each transient retry (up to 3)
    // Single OUTER wall-clock budget shared across all recovery/retry recursions. Set once
    // on the first (top-level) call and threaded down so a blocked-then-recovered clip can't
    // silently run for ~30-45 min by resetting the poll deadline on every recursion — the
    // whole attempt (incl. recoveries) stays bounded to the ~15 min the UI promises.
    if (typeof outerDeadline !== 'number' || !isFinite(outerDeadline)) {
      outerDeadline = Date.now() + _GEMINI_TIMEOUT;
    }
    var jwt = await _getSupabaseJwt();
    if (!jwt) throw new Error('Not logged in. Please refresh and try again.');

    var prompt = _veoJsonToPrompt(veoJsonStr);
    // Omni Flash (Gemini Omni via kie) supports 4/6/8/10s; Veo tiers stay 6/8s.
    var isOmni = (modelKey === 'omni');
    var dur    = parseInt(durationSecs, 10) || (isOmni ? 8 : 6);
    if (isOmni) { if ([4, 6, 8, 10].indexOf(dur) === -1) dur = 8; }
    else        { if (dur !== 6 && dur !== 8) dur = 6; }
    var model  = isOmni ? 'omni' : (modelKey === 'fast') ? 'fast' : (modelKey === 'standard') ? 'standard' : 'lite';
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
    // Last level (380px) is a deliberately soft "get it through at any cost" fallback
    // for extreme face close-ups Veo blocks even when moderately softened. Quality
    // suffers at that level, but a soft clip beats a hard failure.
    // Likeness-softening REMOVED (per request): Veo now receives the FULL-RESOLUTION
    // start frame, so the generated video comes out sharper (no more down-res/mushy
    // input). The person-likeness filter is still handled — on a block, recovery
    // regenerates a WIDER / cleaner composite frame (framingLevel escalation below),
    // which is the lever that actually clears it; the old soften pass did not.
    // `softenLevel` stays in the signature (only bounds the recovery recursion) but no
    // longer alters the image. `_veoSoftenStartFrame` is now unused — kept for easy re-enable.
    var _veoStartUrl = imageDataUrl;

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
        videoModel:      isOmni ? 'omni' : undefined,  // routes server to the Omni Flash branch
        startImageB64:   startImageB64,
        startImageMime:  startImageMime,
        frameB64:        frameB64,    // reference frame for Gemini scene analysis
        frameMime:       frameMime,
        aspectRatio:     aspect,
        provider:        (typeof window !== 'undefined' && window._veoProviderPref) || undefined,
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
    // Poll against the shared OUTER budget (not a freshly-reset per-call deadline) so the
    // total time across the initial attempt + any auto-recoveries/retries stays bounded.
    // Track CONSECUTIVE poll failures so a poll endpoint that always returns malformed JSON
    // or persistently non-OK fails fast (~36s) instead of spinning the whole 15-min window.
    var _consecPollFails = 0;
    while (Date.now() < outerDeadline) {
      await new Promise(function(r) { setTimeout(r, _GEMINI_POLL_MS); });

      var pollRes = await fetch('/.netlify/functions/poll-veo-clip', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + jwt },
        body:    JSON.stringify({ operationName: operationName, durationSecs: dur }),
      });

      var pollData;
      try {
        pollData = await pollRes.json();
      } catch(e) {
        if (++_consecPollFails >= 10) throw new Error("The video status service isn't responding — your credits were refunded if the clip didn't start. Please try regenerating this clip.");
        continue;
      }

      if (!pollRes.ok) {
        // Transient server error on the poll endpoint — log and retry rather than aborting
        // (the generation operation is still running server-side)
        console.warn('[VeoAPI] poll HTTP ' + pollRes.status + ' — retrying:', pollData && pollData.error);
        if (++_consecPollFails >= 10) throw new Error("The video status service isn't responding — your credits were refunded if the clip didn't start. Please try regenerating this clip.");
        continue;
      }
      // A 200 with parseable JSON — the poll service is healthy. Reset the consecutive
      // failure counter so only *back-to-back* failures count toward the fast-fail threshold.
      _consecPollFails = 0;
      // Terminal: done + error (content filter, 404, auth failure, etc.)
      if (pollData.done && pollData.error) {
        // A block = likeness filter (15236754), the structured `filtered` flag, OR a
        // recitation/copyright block. All three are fixed the same way: a MORE STYLIZED,
        // WIDER, cleaner start frame. The server already refunded the blocked clip, so a
        // retry is safe to re-charge.
        var _blocked = pollData.filtered || pollData.recitation || _isLikenessBlock(pollData.error);
        // Surface the raw Vertex response shape (when the server attaches it) so an
        // opaque "no video" failure is diagnosable straight from the console.
        if (pollData.debug) console.warn('[VeoAPI] Vertex done-but-empty response shape:', pollData.debug);
        if (_blocked) console.warn('[VeoAPI] clip blocked — raw model error:', pollData.error);

        // AUTO-RECOVER: a blocked PRIMARY clip (has a real segIdx) regenerates its start
        // frame more de-photorealized AND wider, then retries — this is what actually
        // clears Veo's person-likeness / recitation filter (a plain downscale does not).
        // Escalate up to framingLevel 2 (level 2 drops the source frame → a fresh wide
        // generate-mode composite). Extras (segIdx undefined) and exhausted escalations
        // fall through to a clean, refunded failure.
        if (_blocked && typeof segIdx === 'number' && framingLevel < 2
            && typeof window.generateNbComposite === 'function') {
          var _next = framingLevel + 1;
          console.warn('[VeoAPI] auto-recovering blocked clip — regenerating Scene ' + (segIdx + 1) +
                       ' start frame (stylize+wider, level ' + _next + ')');
          if (typeof showToast === 'function') {
            showToast('Scene ' + (segIdx + 1) + ' was blocked — rebuilding a softer, wider frame and retrying…', 'info', 5000);
          }
          var _regenOk = false;
          try { _regenOk = await window.generateNbComposite(segIdx, _next, _next); } catch (_e) { _regenOk = false; }
          if (_regenOk) {
            var _seg2 = (window.segments || [])[segIdx];
            var _newStart = (_seg2 && (_seg2.nbPreviewDataUrl || _seg2.frameDataUrl)) || imageDataUrl;
            // A recovery starts a genuinely NEW paid generation, so give it its OWN fresh
            // polling window — otherwise a late-window block would start (and re-charge) a
            // clip the poll loop immediately abandons (charged-but-lost). Total time stays
            // bounded because recovery recursion is capped (framingLevel < 2).
            return await generateVeoClipViaAPI(veoJsonStr, durationSecs, modelKey, _newStart, refFrameDataUrl, softenLevel + 1, segIdx, _next, 0, (Date.now() + _GEMINI_TIMEOUT));
          }
          console.warn('[VeoAPI] auto-recover frame regen failed — surfacing clean failure');
        }

        // AUTO-RETRY (transient): a NON-block backend hiccup from Vertex/Veo ("Internal
        // error. Please try again later", "unavailable", "deadline exceeded", etc.). The
        // start frame is fine, so retry the SAME generation — up to 3× with exponential
        // backoff (2.5s → 5s → 10s) — before surfacing anything. The server already
        // refunded each failed op, so extra attempts never double-charge; most clips
        // self-heal within a retry or two, and the backoff rides out longer Veo blips.
        var _audio     = !_blocked && _isAudioError(pollData.error);
        var _transient = !_blocked && (_isTransientError(pollData.error) || _audio);
        if (_transient && transientRetry < 3) {
          var _tAttempt = transientRetry + 1;                    // 1..3
          var _tBackoff = 2500 * Math.pow(2, transientRetry);    // 2.5s → 5s → 10s
          console.warn('[VeoAPI] ' + (_audio ? 'audio-generation error' : 'transient backend error') +
                       ' — auto-retrying (' + _tAttempt + ' of 3, in ' + Math.round(_tBackoff / 1000) + 's):', pollData.error);
          if (typeof showToast === 'function') showToast(_audio ? 'The model missed the audio on this clip — retrying…' : 'Video service hiccup — retrying this clip…', 'info', 4000);
          await new Promise(function (r) { setTimeout(r, _tBackoff); });
          // Fresh polling window for the retried clip (bounded by transientRetry < 3) so an
          // end-of-window transient retry isn't started-then-abandoned.
          return await generateVeoClipViaAPI(veoJsonStr, durationSecs, modelKey, imageDataUrl, refFrameDataUrl, softenLevel, segIdx, framingLevel, transientRetry + 1, (Date.now() + _GEMINI_TIMEOUT));
        }

        // Keep the raw model error in the console for debugging, but show the user a
        // clean, human, actionable message instead of Vertex's technical text.
        if (!_blocked) console.warn('[VeoAPI] clip failed — raw model error:', pollData.error);
        var _errMsg = _blocked
          ? "🚫 The video model's people filter blocked this clip even after rebuilding softer, wider frames — your credits were refunded. Fix: use a wider / less close-up start frame, or a more everyday-looking (less model-like) avatar, then regenerate just this scene."
          : (_audio
              ? "🔇 The video model couldn't generate audio for this scene, even after a retry — your credits were refunded. Fix: shorten or reword the spoken line (very long or unusual lines trip this up), then regenerate just this scene."
              : (_transient
                  ? "⚠️ The video service had a brief hiccup and couldn't finish this clip — your credits were refunded. Please hit Regen to try again."
                  : (pollData.error || 'This clip didn’t render — your credits were refunded. Try regenerating it.')));
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
    var _eta = Math.max(1, Math.ceil(Math.ceil(total / Math.min(10, total || 1)) * 1.3)); // ~1.3 min/clip, up to 10 concurrent
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
          + '<div style="font-size:11px;color:var(--text-3);">' + total + ' clip' + (total !== 1 ? 's' : '') + ' · about ' + _eta + ' min · credits deducted as each finishes</div>'
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
    // Safety net: force the Veo JSON's speech to match the LIVE script before generating,
    // so a script that was edited/deleted after the prompt was built never replays the
    // old line. (The edit handler also syncs this, but this catches prompts that went
    // stale before that fix or via other paths.)
    function _syncSpeech(promptStr, liveText) {
      return (typeof window.veoSyncSpeech === 'function') ? window.veoSyncSpeech(promptStr, liveText) : promptStr;
    }
    var workList = [];
    segments.forEach(function(seg) {
      if (!seg.veoPrompt || !seg.veoPrompt.trim() || seg.nbApproved === false) return;
      var segIdx = segments.indexOf(seg);
      workList.push({ seg: seg, segIdx: segIdx, veoPrompt: _syncSpeech(seg.veoPrompt, seg.script), isExtra: false, extraIdx: -1, extra: null });
      (seg.veoExtras || []).forEach(function(extra, j) {
        if (!(extra.veoPrompt || '').trim()) return;
        workList.push({ seg: seg, segIdx: segIdx, veoPrompt: _syncSpeech(extra.veoPrompt, extra.speech), isExtra: true, extraIdx: j, extra: extra });
      });
    });

    if (!workList.length) {
      showToast('Generate prompts first before running via API.', 'warning');
      return;
    }

    var adm      = (typeof getAdminSettings === 'function') ? getAdminSettings() : {};
    var _dm      = (adm.defaultModel || 'Veo 3.1 Lite');
    var modelKey = _modelKeyFromDm(_dm);
    var _isOmni  = (modelKey === 'omni');
    var _omniDur = _omniDurNow();
    var total    = workList.length;

    // Pre-spend cost gate — show the estimated total and confirm BEFORE committing, so a
    // user can't accidentally burn a big batch or hit a surprise out-of-credits mid-batch.
    // Omni Flash uses its per-duration price (50/65/85/100); Veo tiers keep their tier price.
    var _clipCost = _isOmni
      ? (_OMNI_COST[_omniDur] || 85)
      : (modelKey === 'standard' ? 80 : modelKey === 'fast' ? 30 : 15)
                    * ((typeof window !== 'undefined' && window._veoProviderPref === 'vertex') ? 2 : 1); // ⚡ Faster (Vertex) = 2× credits
    var _estCost  = total * _clipCost;
    var _bal      = (typeof window.userCredits === 'number') ? window.userCredits : null;
    if (_bal != null && _estCost > _bal) {
      showToast('This batch needs ~' + _estCost + ' credits (' + total + ' clip' + (total > 1 ? 's' : '') + ') but you have ' + _bal + '. Top up or reject some scenes.', 'error', 8000);
      if (typeof window.openTopupModal === 'function') window.openTopupModal();
      return;
    }
    if (_bal != null) {
      var _okToSpend = window.confirm('Generate ' + total + ' clip' + (total > 1 ? 's' : '') + ' — about ' + _estCost + ' credits (' + _clipCost + ' each). You have ' + _bal + '. Continue?');
      if (!_okToSpend) return;
    }

    // Concurrency limit. Vertex AI comfortably allows 10 concurrent video gen ops,
    // but kie.ai rate-limits (~20 requests / 10s across submit + status polls), so when
    // we're NOT explicitly on Vertex ("⚡ Faster") we run a smaller pool to stay under
    // kie's limit and to ease load on the poll-veo-clip status endpoint (fewer
    // "status service isn't responding" fast-fails during big batches).
    var _onVertexPref  = (typeof window !== 'undefined' && window._veoProviderPref === 'vertex');
    var MAX_CONCURRENT = _onVertexPref ? 10 : 4;
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
        if (_isOmni) durSecs = _omniDur; // Omni uses the user-chosen 4/6/8/10s, not the scene's Veo length

        try {
          // All clips (primary + continuations) use the same NB composite start frame
          var _startImg = seg.nbPreviewDataUrl || seg.frameDataUrl || null;
          // Pass segIdx for PRIMARY clips so a block auto-regenerates a wider/cleaner
          // composite. Extras share the parent frame, so they use the soften fallback.
          var result    = await generateVeoClipViaAPI(item.veoPrompt, durSecs, modelKey, _startImg, seg.frameDataUrl || null, 0, (item.isExtra ? undefined : segIdx), 0);

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
    // Re-entrancy guard — kept OFF the seg object so it is never persisted by
    // saveSegments (a persisted busy flag would lock the scene after reload).
    window.__regenBusy = window.__regenBusy || {};
    if (window.__regenBusy['s' + segIdx]) { showToast('Scene ' + (segIdx + 1) + ' is already regenerating…', 'info', 3000); return; }
    if (!seg.veoPrompt || !seg.veoPrompt.trim()) {
      showToast('Generate the Veo 3 prompt for this scene first.', 'warning'); return;
    }

    var adm      = (typeof getAdminSettings === 'function') ? getAdminSettings() : {};
    var modelKey = _modelKeyFromDm(adm.defaultModel || 'Veo 3.1 Lite');

    var durSecs = 6;
    try { var _po = JSON.parse(seg.veoPrompt || '{}'); durSecs = _po.duration || 6; } catch(_) {}
    if (modelKey === 'omni') durSecs = _omniDurNow(); // Omni uses the chosen 4/6/8/10s

    // Show loading state on the regen button
    var btn = document.getElementById('regenSceneBtn-' + segIdx);
    if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
    window.__regenBusy['s' + segIdx] = true;
    showToast('Regenerating Scene ' + (segIdx + 1) + '… (~30–90s)', 'info', 4000);

    try {
      var startImg = seg.nbPreviewDataUrl || seg.frameDataUrl || null;
      var result   = await generateVeoClipViaAPI(seg.veoPrompt, durSecs, modelKey, startImg, seg.frameDataUrl || null, 0, segIdx, 0);

      seg.apiVideoUrl  = result.videoUrl;
      seg.apiVideoMime = result.mimeType || 'video/mp4';
      var blobUrl = await _fetchVideoAsBlob(result.videoUrl);
      if (blobUrl) seg.apiVideoRaw = blobUrl;

      if (typeof saveSegments    === 'function') saveSegments();
      if (typeof renderSegments  === 'function') renderSegments();
      if (typeof renderGallery   === 'function') renderGallery();
      if (typeof renderAssembler === 'function') renderAssembler();
      if (typeof refreshCreditBalance === 'function') refreshCreditBalance();
      // The scene modal (segFloatModal) is built once when opened and is NOT
      // refreshed by renderSegments — that only redraws the cards behind it. If
      // it's open, rebuild it so the freshly generated clip actually shows;
      // otherwise the user sees the old video and thinks regen did nothing.
      if (document.getElementById('segFloatModal') && typeof window.openSegModal === 'function') window.openSegModal(segIdx);
      showToast('Scene ' + (segIdx + 1) + ' regenerated!', 'success', 4000);
    } catch(e) {
      showToast('Regen failed (Scene ' + (segIdx + 1) + '): ' + e.message, 'error', 8000);
      if (btn) { btn.disabled = false; btn.textContent = '↺ Regen'; }
    } finally {
      window.__regenBusy['s' + segIdx] = false;
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
    var modelKey = _modelKeyFromDm(adm.defaultModel || 'Veo 3.1 Lite');

    var durSecs = 6;
    try { var _po = JSON.parse(extra.veoPrompt || '{}'); durSecs = _po.duration || 6; } catch(_) {}
    if (modelKey === 'omni') durSecs = _omniDurNow(); // Omni uses the chosen 4/6/8/10s

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
      // Rebuild the scene modal if open so the new continuation clip shows
      // (renderSegments only redraws the cards behind it, not the modal).
      if (document.getElementById('segFloatModal') && typeof window.openSegModal === 'function') window.openSegModal(segIdx);
      showToast('Clip ' + (extraIdx + 2) + ' generated!', 'success', 4000);
    } catch(e) {
      showToast('Regen failed (Clip ' + (extraIdx + 2) + '): ' + e.message, 'error', 8000);
      if (btn) { btn.disabled = false; btn.textContent = '↺ Regen'; }
    }
  }
  window.regenExtraClip = regenExtraClip;

  // ── Apply mode UI on page load (restores pi