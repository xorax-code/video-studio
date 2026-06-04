  // ===== VEO API — SERVER-SIDE GENERATION WITH CREDIT SYSTEM =====
  // Routes all generation through /.netlify/functions/generate-veo-clip
  // (credits deducted server-side) and polls via /.netlify/functions/poll-veo-clip.
  // No Gemini API key needed in the browser.

  var _GEMINI_POLL_MS  = 6000;   // poll every 6s
  var _GEMINI_TIMEOUT  = 360000; // 6 min max

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
    if (step3Label) step3Label.textContent = m === 'api' ? '⚡ Run via API' : 'Run →';

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

  // ── Step 3 handler — routes to API or manual agent panel ─────────────────
  function handleStep3Run() {
    if (getGenerateMode() === 'api') {
      generateAllScenesViaAPI();
    } else {
      if (typeof openVeoAgentPanel === 'function') openVeoAgentPanel();
    }
  }
  window.handleStep3Run = handleStep3Run;

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
  function _veoJsonToPrompt(veoJsonStr) {
    var obj;
    try { obj = typeof veoJsonStr === 'string' ? JSON.parse(veoJsonStr) : veoJsonStr; }
    catch(e) { return String(veoJsonStr || ''); }
    var parts = [];
    if (obj.action) parts.push(obj.action);
    if (obj.speech) parts.push('Person speaks directly to camera and says exactly: "' + obj.speech + '"');
    if (obj.camera) parts.push('Camera: ' + obj.camera);
    if (obj.shot)   parts.push('Framing: ' + obj.shot);
    parts.push(obj.audio || 'Natural clear voice audio, slight ambient room tone, no background music');
    if (obj.negative_prompt) parts.push('Do not include: ' + obj.negative_prompt);
    return parts.join('. ');
  }

  // ── Single clip via server-side API ──────────────────────────────────────
  async function generateVeoClipViaAPI(veoJsonStr, durationSecs, modelKey) {
    var jwt = await _getSupabaseJwt();
    if (!jwt) throw new Error('Not logged in. Please refresh and try again.');

    var prompt = _veoJsonToPrompt(veoJsonStr);
    var dur    = parseInt(durationSecs, 10) || 6;
    if (dur !== 6 && dur !== 8) dur = 6;
    var model  = (modelKey === 'fast') ? 'fast' : 'lite';

    // ── Step 1: Start generation (credits deducted here) ─────────────────
    var startRes = await fetch('/.netlify/functions/generate-veo-clip', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + jwt },
      body:    JSON.stringify({ prompt: prompt, durationSecs: dur, model: model }),
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
        body:    JSON.stringify({ operationName: operationName }),
      });

      var pollData;
      try { pollData = await pollRes.json(); } catch(e) { continue; }

      if (!pollRes.ok) throw new Error(pollData.error || ('Poll error ' + pollRes.status));
      if (pollData.error && !pollData.done) {
        console.warn('[VeoAPI] poll warning:', pollData.error);
        continue;
      }
      if (pollData.done) {
        if (!pollData.videoUrl) throw new Error('Generation finished but no video URL returned.');
        return { videoUrl: pollData.videoUrl, mimeType: pollData.mimeType || 'video/mp4' };
      }
    }
    throw new Error('Generation timed out (6 min). Try again or use a shorter clip.');
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

  // ── Generate all scenes via API ───────────────────────────────────────────
  async function generateAllScenesViaAPI() {
    var toGenerate = segments.filter(function(s) { return s.veoPrompt && s.veoPrompt.trim(); });
    if (!toGenerate.length) {
      showToast('Generate prompts first before running via API.', 'warning');
      return;
    }

    var adm = (typeof getAdminSettings === 'function') ? getAdminSettings() : {};
    var modelKey = (adm.defaultModel || 'Veo 3.1 Fast').toLowerCase().includes('fast') ? 'fast' : 'lite';
    var total = toGenerate.length;

    _openVeoAPIModal(total);

    var succeeded = 0;
    var failed    = 0;

    for (var _i = 0; _i < toGenerate.length; _i++) {
      var seg      = toGenerate[_i];
      var sceneNum = _i + 1;

      _updateVeoAPIScene(sceneNum, total, 'generating');
      _updateVeoAPIProgress(_i, total, succeeded, failed);

      var durSecs = 6;
      try { var _po = JSON.parse(seg.veoPrompt || '{}'); durSecs = _po.duration || 6; } catch(e) {}

      try {
        var result = await generateVeoClipViaAPI(seg.veoPrompt, durSecs, modelKey);

        // Store the raw URI and fetch a blob URL for local playback
        seg.apiVideoUrl  = result.videoUrl;
        seg.apiVideoMime = result.mimeType || 'video/mp4';
        var blobUrl = await _fetchVideoAsBlob(result.videoUrl);
        if (blobUrl) { seg.apiVideoRaw = blobUrl; }

        _updateVeoAPIScene(sceneNum, total, 'done');
        succeeded++;

        if (typeof saveSegments   === 'function') saveSegments();
        if (typeof renderSegments === 'function') renderSegments();
        if (typeof renderGallery  === 'function') renderGallery();
        if (typeof renderAssembler === 'function') renderAssembler();
      } catch(e) {
        console.error('[VeoAPI] Scene ' + sceneNum + ' failed:', e.message);
        _updateVeoAPIScene(sceneNum, total, 'error');
        failed++;

        // Insufficient credits — abort the whole run, modal already shown
        if (e.message && e.message.toLowerCase().includes('credit')) break;
      }

      _updateVeoAPIProgress(_i + 1, total, succeeded, failed);
      if (typeof refreshCreditBalance === 'function') refreshCreditBalance();
    }

    // Final summary toast
    if (failed === 0) {
      showToast('All ' + succeeded + ' clips generated!', 'success', 5000);
    } else if (succeeded > 0) {
      showToast(succeeded + ' clips done, ' + failed + ' failed. See the API modal for details.', 'warning', 6000);
    } else {
      showToast('Generation failed. Check credits or API status.', 'error', 6000);
    }

    // Refresh gallery one final time after all clips are done
    if (succeeded > 0) {
      if (typeof renderGallery   === 'function') renderGallery();
      if (typeof renderAssembler === 'function') renderAssembler();
    }

    // Show "Open Video Editor" nudge after at least one clip succeeds
    if (succeeded > 0) {
      var nudge = document.getElementById('openEditorNudge');
      if (nudge) nudge.style.display = 'flex';
    }
  }
  window.generateAllScenesViaAPI = generateAllScenesViaAPI;

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

  // ── Apply mode UI on page load (restores pill + step3 button state) ───────
  document.addEventListener('DOMContentLoaded', function() { _applyModeUI(); });
