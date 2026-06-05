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
    if (!nbPromptRaw) {
      showToast('Generate prompts first — Scene ' + (segIdx + 1) + ' has no NB prompt yet.', 'warning');
      return false;
    }

    // Parse NB prompt JSON to extract instruction
    var instruction = nbPromptRaw;
    try {
      var parsed = JSON.parse(nbPromptRaw);
      instruction = parsed.instruction || nbPromptRaw;
    } catch(_) { /* use raw string */ }

    if (!avatarImageDataUrl) {
      showToast('Upload your avatar photo first.', 'warning');
      return false;
    }

    // Get JWT for auth
    var jwt = null;
    try {
      if (window._sb) {
        var sessionRes = await window._sb.auth.getSession();
        jwt = sessionRes?.data?.session?.access_token || null;
      }
    } catch(_) {}
    if (!jwt) { showToast('Please log in to generate NB composites.', 'warning'); return false; }

    // Compress images before sending
    var avatarCompressed = await _nbCompressImage(avatarImageDataUrl, 768, 0.80);
    var avatarParts = _nbSplitDataUrl(avatarCompressed);

    var frameB64 = null, frameMime = 'image/jpeg';
    if (seg.frameDataUrl) {
      var frameCompressed = await _nbCompressImage(seg.frameDataUrl, 768, 0.80);
      var frameParts = _nbSplitDataUrl(frameCompressed);
      frameB64 = frameParts.b64;
      frameMime = frameParts.mime;
    }

    try {
      var res = await fetch('/.netlify/functions/generate-nb-composite', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + jwt },
        body: JSON.stringify({
          instruction,
          avatarB64:  avatarParts.b64,
          avatarMime: avatarParts.mime,
          frameB64,
          frameMime,
        }),
      });

      var data;
      try { data = await res.json(); } catch(_) { data = {}; }

      if (!res.ok || data.error) {
        var msg = data.error || ('HTTP ' + res.status);
        showToast('NB gen failed (Scene ' + (segIdx + 1) + '): ' + msg, 'error', 7000);
        return false;
      }

      if (!data.imageB64) {
        showToast('NB gen returned no image for Scene ' + (segIdx + 1) + '.', 'error', 5000);
        return false;
      }

      // Store composite in segment
      segments[segIdx].nbPreviewDataUrl = 'data:' + (data.mime || 'image/png') + ';base64,' + data.imageB64;
      segments[segIdx].nbApproved = null; // reset approval — needs re-review

      saveSegments();
      if (typeof renderSegments === 'function') renderSegments();

      return true;

    } catch(e) {
      showToast('NB gen error (Scene ' + (segIdx + 1) + '): ' + (e.message || e), 'error', 6000);
      return false;
    }
  }
  window.generateNbComposite = generateNbComposite;

  // ── Generate NB composites for ALL segments ───────────────────────────────
  async function generateAllNbComposites() {
    var toGen = segments.filter(function(s) { return (s.nbPrompt || '').trim(); });
    if (!toGen.length) {
      showToast('Generate prompts first — no NB prompts found.', 'warning');
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

    for (var i = 0; i < n; i++) {
      var seg = toGen[i];
      var segIdx = segments.indexOf(seg);

      // Update button label with progress
      if (btn) btn.innerHTML = '<i class="ti ti-loader-2" style="animation:spin 1s linear infinite;"></i> ' + (i + 1) + '/' + n + '…';

      var ok = await generateNbComposite(segIdx);
      if (ok) succeeded++; else failed++;

      // Small delay between requests to avoid rate limiting
      if (i < n - 1) await new Promise(function(r) { setTimeout(r, 1200); });
    }

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
  function openNbApprovalModal() {
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
      card.innerHTML = '<img src="' + escHtml(seg.nbPreviewDataUrl) + '" style="width:100%;aspect-ratio:9/16;object-fit:cover;display:block;">'
        + '<div style="padding:8px;display:flex;align-items:center;justify-content:space-between;gap:6px;">'
          + '<span style="font-size:11px;font-weight:600;color:var(--text-2);">Scene ' + (idx + 1) + '</span>'
          + '<span id="nb-approval-badge-' + idx + '" style="font-size:11px;font-weight:800;padding:2px 8px;border-radius:4px;background:' + (approved ? 'rgba(52,211,153,0.9)' : 'rgba(248,113,113,0.85)') + ';color:#fff;">' + (approved ? '✓' : '✕') + '</span>'
        + '</div>';
      card.onclick = function() { toggleNbApproval(idx); };
      grid.appendChild(card);
    });

    // Footer
    var footer = document.createElement('div');
    footer.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;padding-top:8px;border-top:1px solid var(--border);';
    footer.innerHTML = '<button onclick="document.getElementById(\'nbApprovalModal\').remove()" style="padding:7px 16px;font-size:12px;font-family:inherit;background:var(--surface-3);border:1px solid var(--border-2);border-radius:7px;color:var(--text-2);cursor:pointer;">Done</button>'
      + '<button onclick="document.getElementById(\'nbApprovalModal\').remove();showPreflightModal(false);" style="padding:7px 16px;font-size:12px;font-weight:700;font-family:inherit;background:rgba(52,211,153,0.15);border:1px solid rgba(52,211,153,0.5);border-radius:7px;color:#34d399;cursor:pointer;">▶ Run Approved Scenes →</button>';

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
