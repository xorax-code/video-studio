  // ===== REFERENCE VIDEO LIBRARY =====
  // Saved reference videos persist in IndexedDB: a metadata list under
  // 'sm_refvideo_lib', each video Blob under 'sm_refvideo_blob_<id>', and the
  // optional Whisper transcript under 'sm_refvideo_tx_<id>'.
  async function saveCurrentVideoToLibrary() {
    if (!refVideoFile) { showToast('Upload a video first, then save it to the library.', 'warning'); return; }
    const defaultName = (refVideoFile.name || 'Reference video').replace(/\.[^.]+$/, '');
    const name = prompt('Name this reference video:', defaultName);
    if (name === null) return;
    const id = 'rv_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const videoEl = document.getElementById('refVideoEl');
    const durationSec = (videoEl && !isNaN(videoEl.duration)) ? videoEl.duration : 0;
    const hasTranscript = !!(whisperSegments && whisperSegments.length);
    try {
      await DB.set('sm_refvideo_blob_' + id, refVideoFile);
      if (hasTranscript) await DB.set('sm_refvideo_tx_' + id, JSON.stringify(whisperSegments));
      let lib = [];
      try { lib = JSON.parse((await DB.get('sm_refvideo_lib')) || '[]'); } catch(_) { lib = []; }
      lib.unshift({
        id, name: (name.trim() || 'Untitled'), savedAt: Date.now(),
        durationSec, sizeBytes: refVideoFile.size || 0, type: refVideoFile.type || 'video/mp4',
        fileName: refVideoFile.name || '', hasTranscript
      });
      await DB.set('sm_refvideo_lib', JSON.stringify(lib));
      const btn = document.getElementById('saveVideoLibBtn');
      if (btn) { const o = btn.textContent; btn.textContent = '✓ Saved'; setTimeout(() => { btn.textContent = o; }, 2000); }
    } catch (e) {
      showToast('Could not save video to library: ' + ((e && e.message) || e), 'error');
    }
  }

  function openSavedLibraryModal() {
    const modal = document.getElementById('savedLibraryModal');
    if (!modal) return;
    renderStudioLibrary();
    modal.style.display = 'flex';
  }
  function closeSavedLibraryModal() {
    const modal = document.getElementById('savedLibraryModal');
    if (modal) modal.style.display = 'none';
  }

  async function openVideoLibrary() {
    const modal = document.getElementById('videoLibraryModal');
    const listEl = document.getElementById('videoLibraryList');
    if (!modal || !listEl) return;
    modal.style.display = 'flex';
    listEl.innerHTML = '<div style="text-align:center;padding:20px;font-size:11px;color:var(--text-3);">Loading…</div>';
    let lib = [];
    try { lib = JSON.parse((await DB.get('sm_refvideo_lib')) || '[]'); } catch (e) { lib = []; }
    if (!lib.length) {
      listEl.innerHTML = '<div style="text-align:center;padding:24px;font-size:11px;color:var(--text-3);">No saved reference videos yet.<br>Upload a video and click <strong style="color:var(--text-2);">＋ Save to Library</strong>.</div>';
      return;
    }
    const fmtDur = s => { s = Math.round(s || 0); const m = Math.floor(s / 60); const ss = s % 60; return m + ':' + (ss < 10 ? '0' : '') + ss; };
    const fmtSize = b => b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.round(b / 1024) + ' KB';
    const fmtDate = ts => { try { return new Date(ts).toLocaleDateString(); } catch (e) { return ''; } };
    listEl.innerHTML = lib.map(v => `
      <div style="display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--border);border-radius:6px;margin-bottom:6px;background:var(--bg);">
        <div style="font-size:18px;">🎬</div>
        <div style="flex:1;min-width:0;">
          <div style="font-size:12px;font-weight:600;color:var(--text-1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(v.name)}</div>
          <div style="font-size:10px;color:var(--text-3);">${fmtDur(v.durationSec)} · ${fmtSize(v.sizeBytes)} · ${fmtDate(v.savedAt)}${v.hasTranscript ? ' · 📝 transcript' : ''}</div>
        </div>
        <button class="btn" onclick="loadVideoFromLibrary(${escHtml(JSON.stringify(v.id))})" style="padding:3px 10px;font-size:10px;border-color:var(--accent);color:var(--accent-2);">Load</button>
        <button class="btn" onclick="deleteVideoFromLibrary(${escHtml(JSON.stringify(v.id))})" style="padding:3px 8px;font-size:10px;color:var(--danger);border-color:rgba(248,113,113,0.3);">✕</button>
      </div>`).join('');
  }

  function closeVideoLibrary() {
    const modal = document.getElementById('videoLibraryModal');
    if (modal) modal.style.display = 'none';
  }

  async function _doLoadVideoFromLibrary(id, clearSegs) {
    let blob;
    try { blob = await DB.get('sm_refvideo_blob_' + id); } catch (e) { blob = null; }
    if (!blob) { showToast('Video data not found — it may have been cleared.', 'error'); return; }
    let lib = [];
    try { lib = JSON.parse((await DB.get('sm_refvideo_lib')) || '[]'); } catch(_) { lib = []; }
    const meta = lib.find(v => v.id === id) || {};
    const file = new File([blob], meta.fileName || (meta.name || 'library-video') + '.mp4', { type: blob.type || meta.type || 'video/mp4' });
    refVideoFile = file;
    if (typeof _persistProjectVideo === 'function') _persistProjectVideo(file); // survive page refresh
    if (refVideoObjectUrl) URL.revokeObjectURL(refVideoObjectUrl);
    refVideoObjectUrl = URL.createObjectURL(file);
    const videoEl = document.getElementById('refVideoEl');
    if (!videoEl) { showToast('Video player not found — please refresh the page.', 'error'); return; }
    videoEl.src = refVideoObjectUrl;
    videoEl.load(); // Explicitly trigger load — required in some browsers after programmatic src change
    videoEl.style.display = 'block';
    const _vup = document.getElementById('videoUploadPlaceholder');
    if (_vup) _vup.style.display = 'none';
    const _cvb = document.getElementById('clearVideoBtn');
    if (_cvb) _cvb.style.display = 'inline-block';
    const _slb = document.getElementById('saveVideoLibBtn');
    if (_slb) _slb.style.display = 'inline-block';
    const _vuz = document.getElementById('videoUploadZone');
    if (_vuz) _vuz.onclick = null;
    if (document.getElementById('videoFileName')) document.getElementById('videoFileName').textContent = file.name;
    _activeLibraryVideoId = id;
    if (clearSegs) {
      segments = [];
      whisperSegments = []; whisperWords = [];
      if (meta.hasTranscript) {
        try {
          const tx = await DB.get('sm_refvideo_tx_' + id);
          if (tx) { try { whisperSegments = JSON.parse(tx); } catch(e) { whisperSegments = []; } }
        } catch (e) { /* transcript optional */ }
      }
    } else {
      // Same video re-loaded after refresh — restore transcript only if we have none
      if (!whisperSegments.length && meta.hasTranscript) {
        try {
          const tx = await DB.get('sm_refvideo_tx_' + id);
          if (tx) { try { whisperSegments = JSON.parse(tx); } catch(e) { whisperSegments = []; } }
        } catch (e) { /* transcript optional */ }
      }
    }
    saveCurrentProjectData();
    renderSegments();
    closeVideoLibrary();
    showToast(`✅ "${meta.name || file.name}" loaded${clearSegs ? ' — segments cleared' : ' — segments kept'}.`, 'success', 3000);
  }

  async function loadVideoFromLibrary(id) {
    // If this video is already linked to the active project, just restore the
    // player without touching the saved segments (common after a page refresh).
    const activeProject = getActiveProject();
    const isSameVideo = activeProject && activeProject.libraryVideoId === id;
    if (isSameVideo && segments.length > 0) {
      await _doLoadVideoFromLibrary(id, false);
      showToast('Video restored — segments kept.', 'success');
      return;
    }
    // Different video (or no segments yet) — warn before clearing
    if (segments.length > 0) {
      showConfirm('Loading this video will replace the current video and clear its ' + segments.length + ' segment(s). Continue?', async () => {
        try { await _doLoadVideoFromLibrary(id, true); }
        catch (e) { showToast('Failed to load video: ' + (e?.message || e), 'error'); }
      });
      return;
    }
    await _doLoadVideoFromLibrary(id, true);
  }

  async function deleteVideoFromLibrary(id) {
    showConfirm('Remove this video from your library? This cannot be undone.', async () => {
      try {
        await DB.remove('sm_refvideo_blob_' + id);
        await DB.remove('sm_refvideo_tx_' + id);
        let lib = [];
        try { lib = JSON.parse((await DB.get('sm_refvideo_lib')) || '[]'); } catch(_) { lib = []; }
        lib = lib.filter(v => v.id !== id);
        await DB.set('sm_refvideo_lib', JSON.stringify(lib));
        openVideoLibrary();
      } catch (e) {
        showToast('Could not delete: ' + ((e && e.message) || e), 'error');
        openVideoLibrary();
      }
    });
  }

  // --- OpenAI API key management ---
  // Key is baked in by the app owner — users never see or manage it.
  // ── Flagged content words / phrases ──────────────────────────────────────
  const FLAGGED_PATTERNS = [
    /\bcures?\b/i, /\bheals?\b/i, /\btreat(ment|s|ing)?\b/i,
    /doctors? (hate|don'?t want)/i, /pharmacies? don'?t want/i,
    /they don'?t want you to know/i, /\bban(ned)?\b/i,
    /\bmiracle\b/i, /\bguaranteed?\b/i, /\bclinically proven\b/i,
    /\bno side effects\b/i, /\blose \d+ (pounds?|lbs?|kg)/i,
    /\bprevents? (cancer|diabetes|disease|heart)/i,
    /\bfda (approved|cleared)\b/i, /\bscientifically proven\b/i,
    /\bweight loss guarantee\b/i, /\bdetox\b/i,
  ];

  function checkScriptFlagged(text) {
    const warn = document.getElementById('scriptFlagWarning');
    if (!warn) return;
    const flagged = FLAGGED_PATTERNS.some(p => p.test(text));
    warn.style.display = flagged ? 'flex' : 'none';
  }

  // Called on every keystroke in the master script textarea.
  // If the text has changed enough from the Whisper transcript, clear stale timestamps
  // so distributeScript falls through to the sentence-proportional split instead.
  let _lastWhisperText = '';
  let _masterScriptSaveTimer = null;
  function onMasterScriptInput(el) {
    const newText = el.value;
    checkScriptFlagged(newText);
    clearTimeout(_masterScriptSaveTimer);
    _masterScriptSaveTimer = setTimeout(() => saveSegments(), 500);
    // Update step strip whenever script changes
    setTimeout(() => updateStepProgress?.(), 100);

    // If Whisper segments exist, check whether the current text still resembles them.
    // Similarity = shared words / total words (Jaccard-ish). Below 70% → stale → clear.
    if (whisperSegments && whisperSegments.length > 0) {
      const whisperText = whisperSegments.map(w => w.text).join(' ').toLowerCase();
      const newLower    = newText.toLowerCase();
      const wWords  = new Set(whisperText.split(/\s+/).filter(Boolean));
      const nWords  = newLower.split(/\s+/).filter(Boolean);
      const shared  = nWords.filter(w => wWords.has(w)).length;
      const union   = new Set([...wWords, ...nWords]).size;
      const similarity = union > 0 ? shared / union : 0;
      if (similarity < 0.70) {
        // Script has diverged enough — timestamps no longer match
        whisperSegments = []; whisperWords = [];
        saveCurrentProjectData();
      }
    }
  }

  async function rewriteScript() {
    if (typeof window.requireAccess === 'function' && !window.requireAccess()) return;
    const scriptEl = document.getElementById('originalScript');
    const original = (scriptEl?.value || '').trim();
    if (!original) { showToast('Paste or transcribe a script first.', 'warning'); return; }

    const apiKey = getApiKey();
    if (!apiKey) { showToast('No API key available.', 'warning'); return; }

    const btn = document.getElementById('rewriteBtn');
    if (!btn) return; // guard: button may not be present in all UI modes
    const origLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = '⏳';

    const systemPrompt = `You are a video script editor making the absolute minimum changes needed to pass AI content moderation. Your job is surgical — swap only the flagged words or short phrases and leave everything else completely untouched.

RULES — read carefully:
1. KEEP THE STRUCTURE IDENTICAL. Every sentence, every line break, every pause, every word that is NOT flagged must stay exactly as written. Do not rephrase, reorder, shorten, or expand anything that is fine as-is.
2. ONLY change words or short phrases (1–3 words maximum per swap) that would trigger content moderation — things like: "cures", "heals", "treats", "doctors hate", "pharmacies don't want you to know", "miracle", "guaranteed", "clinically proven", "no side effects", "lose X pounds", "prevents cancer/diabetes/disease", "FDA approved", "detox", "scientifically proven".
3. SWAP WITH A NEAR-SYNONYM that sounds natural in speech and carries the same meaning without the medical/legal flag. Examples:
   - "cures" → "helps with" or "supports"
   - "heals" → "helps" or "soothes"
   - "doctors hate this" → "most people don't know this"
   - "prevents disease" → "supports your health"
   - "lose 10 pounds" → "drop some weight"
   - "miracle" → "amazing" or "game-changer"
   - "guaranteed" → "works every time" or "consistent"
   - "clinically proven" → "well-known" or "popular"
   - "detox" → "cleanse" or "reset"
4. Do NOT change: sentence length, sentence count, punctuation style, filler words, CTA phrasing, questions, story beats, energy words, exclamations, or anything not on the flagged list.`;

    const hasSegmentScripts = Array.isArray(segments) && segments.length > 0 && segments.some(s => s.script && s.script.trim());

    try {
      let rewrittenFull = '';

      if (hasSegmentScripts) {
        // Per-segment path: send [SEGn] prefixed lines, get back same format
        const segLines = segments.map((s, i) => `[SEG${i}] ${(s.script || '').trim()}`).join('\n');
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-4o', temperature: 0.2,
            messages: [
              { role: 'system', content: systemPrompt + `\n5. CRITICAL — SEGMENT FORMAT: The input has segments prefixed [SEG0], [SEG1], etc. You MUST output EVERY segment on its own line, keeping the exact same [SEGn] prefix. Never merge, split, reorder, or drop segments. Output ONLY the prefixed lines — no preamble, no explanation.` },
              { role: 'user', content: `Rewrite only the flagged words in each segment. Keep every [SEGn] prefix exactly as-is:\n\n${segLines}` }
            ]
          })
        });
        if (!response.ok) { const e = await response.json().catch(()=>({})); throw new Error(e.error?.message || 'API error ' + response.status); }
        const data = await response.json();
        const raw = data.choices?.[0]?.message?.content?.trim();
        if (!raw) throw new Error('Empty response from API');

        // Parse [SEGn] lines and build module-level rewrittenSegScripts
        const parsed = {};
        raw.split('\n').forEach(line => { const m = line.match(/^\[SEG(\d+)\]\s*(.*)/); if (m) parsed[parseInt(m[1])] = m[2].trim(); });
        rewrittenSegScripts = segments.map((s, i) => ({
          idx: i,
          original: (s.script || '').trim(),
          rewritten: (parsed[i] !== undefined && parsed[i] !== '') ? parsed[i] : (s.script || '').trim()
        }));
        rewrittenFull = rewrittenSegScripts.map(r => `[SEG${r.idx}] ${r.rewritten}`).join('\n');

      } else {
        // No segments yet — rewrite master script as a whole
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-4o', temperature: 0.2,
            messages: [
              { role: 'system', content: systemPrompt + '\n5. Output ONLY the fixed script — same number of lines, same structure, no preamble, no explanation, no labels.' },
              { role: 'user', content: `Here is the script. Make only the minimum surgical word swaps needed — change nothing else:\n\n${original}` }
            ]
          })
        });
        if (!response.ok) { const e = await response.json().catch(()=>({})); throw new Error(e.error?.message || 'API error ' + response.status); }
        const data = await response.json();
        rewrittenFull = data.choices?.[0]?.message?.content?.trim();
        if (!rewrittenFull) throw new Error('Empty response from API');
        rewrittenSegScripts = null;
      }

      // Populate the Rewritten Script section (no modal)
      const section = document.getElementById('rewrittenScriptSection');
      const textarea = document.getElementById('rewrittenScript');
      if (section && textarea) {
        textarea.value = rewrittenFull;
        section.style.display = 'flex';
      }

    } catch (err) {
      showToast('Rewrite failed: ' + err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = origLabel;
    }
  }

  // Apply the rewritten script to current cut segments
  function applyRewrittenScript() {
    const textarea = document.getElementById('rewrittenScript');
    if (!textarea) return;
    const val = textarea.value.trim();
    if (!val) { showToast('No rewritten script yet — click ✏ Rewrite first.', 'warning'); return; }

    if (!segments || segments.length === 0) { showToast('Detect Cuts first, then apply the rewrite.', 'warning'); return; }

    if (rewrittenSegScripts && rewrittenSegScripts.length > 0) {
      // Re-parse the textarea in case user edited it (by [SEGn] prefix)
      const editedParsed = {};
      val.split('\n').forEach(line => {
        const m = line.match(/^\[SEG(\d+)\]\s*(.*)/);
        if (m) editedParsed[parseInt(m[1])] = m[2].trim();
      });
      rewrittenSegScripts.forEach(r => {
        if (r.idx < segments.length) {
          const edited = editedParsed[r.idx];
          segments[r.idx].script = (edited !== undefined && edited !== '') ? edited : r.rewritten;
        }
      });
    } else {
      // No per-segment data — distribute whole rewritten text proportionally
      const cleanVal = val.replace(/^\[SEG\d+\]\s*/gm, '').trim();
      const _osEl = document.getElementById('originalScript');
      if (_osEl) _osEl.value = cleanVal;
      if (segments.some(s => s.script && s.script.trim())) {
        const newWords = cleanVal.split(/\s+/).filter(Boolean);
        const segCounts = segments.map(s => (s.script || '').trim().split(/\s+/).filter(Boolean).length);
        let cursor = 0;
        segments.forEach((seg, idx) => {
          const isLast = idx === segments.length - 1;
          const count = isLast
            ? Math.max(0, newWords.length - cursor)
            : Math.min(segCounts[idx], Math.max(0, newWords.length - cursor));
          seg.script = newWords.slice(cursor, cursor + count).join(' ');
          cursor += count;
        });
        const emptied = segments.filter(s => !(s.script || '').trim()).length;
        if (emptied > 0) showToast(`${emptied} segment(s) ended up empty — the rewrite may be too short.`, 'warning');
      } else {
        if (typeof distributeScript === 'function') distributeScript();
      }
    }

    if (typeof renderSegments === 'function') renderSegments();
    if (typeof saveSegments === 'function') saveSegments();
  }

  // ── Adapt Viral Script to My Product ──────────────────────────────────────
  // Takes the inspiration script already in #originalScript, reads product +
  // avatar context from the Brand Kit / avatarDesc, calls GPT-4o to rewrite
  // the script for THIS product while keeping the same viral structure (hook
  // type, scene count, emotional arc, pacing), then shows the result in the
  // rewrittenScriptSection so the user can review and apply it.
  async function adaptScriptToProduct() {
    rewrittenSegScripts = null;
    if (typeof window.requireAccess === 'function' && !window.requireAccess()) return;

    const scriptEl  = document.getElementById('originalScript');
    const original  = (scriptEl?.value || '').trim();
    if (!original) { showToast('Paste or transcribe a reference script first, then adapt it.', 'warning'); return; }

    const apiKey = getApiKey();
    if (!apiKey) { showToast('No API key available.', 'warning'); return; }

    const btn      = document.getElementById('adaptScriptBtn');
    const origIcon = btn?.innerHTML;
    if (btn) { btn.disabled = true; btn.innerHTML = '<span style="font-size:9px">⏳</span>'; }

    // ── Gather product + avatar context ──────────────────────────────────────
    const kit         = (typeof getBrandKit === 'function') ? getBrandKit() : {};
    const productSel  = document.getElementById('studioProduct');
    const productName = kit.productName
      || (productSel ? (productSel.options[productSel.selectedIndex]?.text || '').replace(/^\s*select.*$/i, '').trim() : '')
      || 'the product';
    const avatarDesc  = document.getElementById('avatarDesc')?.value.trim()
      || kit.avatarDesc || 'a confident wellness creator speaking directly to camera';
    const talkingPts  = (kit.talkingPoints || '')
      .split('\n').filter(Boolean).map(l => '• ' + l.replace(/^[-•]\s*/, '')).join('\n');
    const cta         = kit.cta || 'Link in bio';
    const toneMap     = {
      energetic: 'energetic and hype', conversational: 'casual and conversational',
      urgent: 'urgent with FOMO', professional: 'polished and professional', storytelling: 'story-driven and emotional'
    };
    const toneDesc = toneMap[kit.tone] || 'casual and conversational';

    // ── System prompt ─────────────────────────────────────────────────────────
    const systemPrompt = `You are a top-tier viral short-form video copywriter who writes Amazon affiliate scripts that consistently reach 1M+ views. Your scripts work because:

- The HOOK names a specific, relatable moment — not generic frustration ("you wash your face and STILL see blackheads on your nose" is weak — "I scrubbed my nose every night for a year and those blackheads never moved" is strong)
- The PROBLEM is visceral and specific — one concrete detail beats three vague claims
- The DISCOVERY feels natural — a friend's recommendation, a random scroll, a desperate late-night order
- The PROOF is sensory and measurable — "the toner pad was grey after one swipe" not "my skin felt better"
- Each sentence is ≤18 words and lands as its own punchy beat when spoken aloud
- The CTA creates genuine FOMO for the keyword — people must drop it to find out what the product is

You do NOT preserve weak copy. You USE the reference script's FORMAT (hook type, emotional arc, pacing) but you write every line fresh, sharper, and more specific.

BANNED — never write these words or phrases:
Doctor-approved · Clinically proven`;

    // ── User prompt ───────────────────────────────────────────────────────────
    const userPrompt = `REFERENCE SCRIPT — study the FORMAT only (hook type, arc, pacing, CTA style). Do NOT copy its language:

---REFERENCE---
${original}
---END---

MY PRODUCT: ${productName}
${talkingPts ? 'KEY BENEFITS (work these in naturally):\n' + talkingPts + '\n' : ''}CREATOR VOICE: ${avatarDesc}
TONE: ${toneDesc}
CTA (final beat, word for word): ${cta}

WRITE A BETTER SCRIPT using 6–9 beats (you decide the optimal count):

HOOK: Same hook TYPE as the reference — but make it SPECIFIC and visceral. Name the exact moment. No vague openers.
PROBLEM: One concrete, relatable detail. Something the viewer has lived.
DISCOVERY: How they found ${productName} — keep it natural, not salesy.
DEMO: What they physically do with the product. What they see.
PROOF: ONE sensory, specific result. What they saw, felt, or noticed. Make it visual.
CTA: Exactly: ${cta}

RULES:
- Every sentence ≤18 words
- Zero vague words: "better", "amazing", "so much", "really" — replace with specifics
- Zero stage directions, emojis, hashtags, or scene labels
- Sound like a real person talking to their phone, not an ad
- Return ONLY the sentences — one per line, no labels, no numbers, nothing else`;

    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o',
          temperature: 0.75,
          max_tokens: 900,
          messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }]
        })
      });
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error?.message || 'API error ' + res.status); }
      const data    = await res.json();
      const adapted = data.choices?.[0]?.message?.content?.trim();
      if (!adapted) throw new Error('Empty response from API');

      // ── Show result in the existing rewrittenScriptSection ─────────────────
      const section  = document.getElementById('rewrittenScriptSection');

      const textarea = document.getElementById('rewrittenScript');
      // Update the label dynamically so user knows this is an adaptation, not a moderation rewrite
      const labelEl  = section?.querySelector('div');
      if (labelEl) {
        labelEl.textContent = `Adapted → ${productName}`;
        labelEl.style.color = '#7acc9a';
      }
      if (section && textarea) { textarea.value = adapted; section.style.display = 'flex'; }
      showToast(`Script adapted to ${productName} ✓`, 'success');
    } catch (err) {
      showToast('Adapt failed: ' + err.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = origIcon; }
    }
  }
  window.adaptScriptToProduct = adaptScriptToProduct;
  // ── End adaptScriptToProduct ───────────────────────────────────────────────

  function getApiKey() {
    // In production: all OpenAI calls go through Netlify proxy — no client-side key needed.
    // Returning a truthy placeholder so existing !apiKey guards don't block anything.
    if (window.location.protocol !== 'file:') return '__proxy__';
    // Local file:// testing — use the admin/baked key as before
    return OPENAI_KEY_BAKED || _adminApiKey || _cachedApiKey || '';
  }

  // ── OpenAI Proxy Interceptor ──
  // In production, transparently reroutes all OpenAI API calls through
  // Netlify serverless functions so the API key never reaches the browser.
  // Injects Supabase JWT so the server-side auth guard passes.
  (function() {
    if (window.location.protocol === 'file:') return; // local — bypass
    const _realFetch = window.fetch.bind(window);

    // Helper: get current Supabase access token (async)
    async function _getJwt() {
      try {
        if (typeof _sb !== 'undefined' && _sb) {
          var s = await _sb.auth.getSession();
          return (s && s.data && s.data.session && s.data.session.access_token) || null;
        }
      } catch(e) {}
      return null;
    }

    window.fetch = function(url, opts) {
      // Normalize url to a string for matching decisions (a Request/URL object
      // would otherwise bypass the proxy). The ORIGINAL url is still passed to
      // the real fetch for the pass-through case.
      var u = (typeof url === 'string') ? url : (url && url.url ? url.url : String(url));
      {
        var isChat       = u.includes('api.openai.com/v1/chat/completions')   || u.includes('/.netlify/functions/openai-chat');
        var isTranscribe = u.includes('api.openai.com/v1/audio/transcriptions') || u.includes('/.netlify/functions/openai-transcribe');

        if (isChat || isTranscribe) {
          var target = isChat ? '/.netlify/functions/openai-chat' : '/.netlify/functions/openai-transcribe';
          // If a Request object was passed (no string + no opts), its
          // method/body/headers live on the object, not in `opts`. Read them
          // off so the proxied call isn't silently sent with an empty body.
          // String callers (url is a string) skip this entirely — their path
          // stays byte-for-byte identical.
          var _reqBodyPromise = Promise.resolve(opts);
          if (typeof url !== 'string' && url && typeof url.text === 'function') {
            _reqBodyPromise = url.clone().text().then(function(body) {
              var ro = Object.assign({}, opts);
              if (ro.method === undefined) ro.method = url.method;
              if (ro.body === undefined && body) ro.body = body;
              if (ro.headers === undefined && url.headers) {
                var rh = {};
                try { url.headers.forEach(function(v, k) { rh[k] = v; }); } catch(e) {}
                ro.headers = rh;
              }
              return ro;
            }).catch(function() { return Object.assign({}, opts); });
          }
          // Return a Promise — async so we can await the JWT
          return Promise.all([_getJwt(), _reqBodyPromise]).then(function(arr) {
            var token = arr[0];
            var safeOpts = Object.assign({}, arr[1]);
            var h = Object.assign({}, safeOpts.headers || {});
            // Replace any client-side OpenAI key with the Supabase JWT
            delete h['X-Api-Key']; delete h['x-api-key'];
            // Only the openai.com path may have had a real Authorization header — strip it
            // but inject ours (the server uses OPENAI_API_KEY from env)
            if (token) {
              h['Authorization'] = 'Bearer ' + token;
            } else {
              delete h['Authorization']; delete h['authorization'];
            }
            safeOpts.headers = h;
            return _realFetch(target, safeOpts);
          });
        }
      }
      return _realFetch(url, opts);
    };
  })();

  // ── _proxyTranscribe ──────────────────────────────────────────────────────
  // Sends audio/video to the Netlify transcription proxy (production) or
  // directly to OpenAI (local file:// dev). Always requests word-level AND
  // segment-level timestamps so distributeScriptFromTimestamps() works
  // accurately instead of falling back to linear interpolation.
  //
  // Returns a Response-like object with .ok, .status, and .json() method.
  async function _proxyTranscribe(file) {
    const MAX_PROXY_BYTES = 7 * 1024 * 1024;
    if (file.size > MAX_PROXY_BYTES) {
      throw new Error('Video is too large for transcription (max ~7 MB). Please trim it first.');
    }
    const isLocal = window.location.protocol === 'file:';

    if (isLocal) {
      // ── Local dev: send multipart/form-data directly to OpenAI ────────────
      const apiKey = getApiKey();
      if (!apiKey || apiKey === '__proxy__') throw new Error('No API key for local transcription.');
      const form = new FormData();
      form.append('file', file, file.name || 'audio.mp4');
      form.append('model', 'whisper-1');
      form.append('language', 'en'); // force English — Whisper auto-detect mis-guesses (e.g. Malay) on accented/noisy audio
      form.append('response_format', 'verbose_json');
      form.append('timestamp_granularities[]', 'word');
      form.append('timestamp_granularities[]', 'segment');
      return fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + apiKey },
        body: form,
      });
    }

    // ── Production: base64-encode and POST JSON to Netlify proxy ─────────────
    // The Lambda runtime cannot handle raw multipart, so we base64 the audio
    // and let the server-side function rebuild the multipart for OpenAI.
    const arrayBuf   = await file.arrayBuffer();
    const uint8      = new Uint8Array(arrayBuf);
    let binary = '';
    // Build base64 in chunks to avoid stack overflow on large files
    const CHUNK = 8192;
    for (let i = 0; i < uint8.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, uint8.subarray(i, i + CHUNK));
    }
    const audioBase64 = btoa(binary);

    const payload = JSON.stringify({
      audioBase64,
      fileName: file.name || 'audio.mp4',
      model: 'whisper-1',
      language: 'en', // force English — Whisper auto-detect mis-guesses (e.g. Malay) on accented/noisy audio
      response_format: 'verbose_json',
      timestamp_granularities: ['word', 'segment'],
    });

    // Inject Supabase JWT so the server-side auth guard passes
    var _transcribeHeaders = { 'Content-Type': 'application/json' };
    try {
      if (typeof _sb !== 'undefined' && _sb) {
        var _sess = await _sb.auth.getSession();
        var _tok = _sess && _sess.data && _sess.data.session && _sess.data.session.access_token;
        if (_tok) _transcribeHeaders['Authorization'] = 'Bearer ' + _tok;
      }
    } catch(e) {}

    const raw = await fetch('/.netlify/functions/openai-transcribe', {
      method: 'POST',
      headers: _transcribeHeaders,
      body: payload,
    });

    return raw; // caller does response.ok check + response.json()
  }
  window._proxyTranscribe = _proxyTranscribe;
  // ── End _proxyTranscribe ──────────────────────────────────────────────────

