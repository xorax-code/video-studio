  // ===== SCRIPT-FIRST MODE =====

  // ─── Speech-timing constants ───────────────────────────────────────────────
  // Average conversational speaking rate ≈ 2.3 words/second (≈138 wpm).
  // At this rate, 8 seconds ≈ 18–19 words. We target 18 words per scene and
  // always cut at the nearest sentence boundary — never mid-sentence.
  const WORDS_PER_SEC  = 2.3;
  const TARGET_SCENE_S = 8;            // target seconds per scene
  const TARGET_WORDS   = Math.round(TARGET_SCENE_S * WORDS_PER_SEC); // ≈18

  // Derive a meaningful Veo 3 action description from the scene text.
  // Physical product/food actions are checked FIRST so they take priority over
  // generic emotional states — this makes duplicated segment actions match what
  // the person is actually doing while saying those specific words.
  function deriveSceneAction(text, sceneIndex, totalScenes) {
    const t = text.toLowerCase();
    // ── Physical / hands-on actions ─────────────────────────────────────────
    if (/(squeeze|squeezing|press.*juice|juice.*lemon|lemon.*juice|citrus|half.*lemon|lemon.*half)/.test(t))
      return 'person squeezes citrus over a glass — deliberate hand motion, glances at the action then back to camera';
    if (/(pour|pouring|drizzle|drizzling|drop.*in|add.*to.*glass|add.*to.*cup|measure.*out)/.test(t))
      return 'person pours or adds ingredient with a natural deliberate motion — glances at the pour, then back to camera';
    if (/(drink|drinking|sip|sipping|swallow|take.*sip|taste|tasting|chug|gulp)/.test(t))
      return 'person takes a sip or drinks — natural smooth motion, reacts with a satisfied expression looking back at camera';
    if (/(hold.*up|hold.*out|show|showing|look.*at|here.*is|this.*is|see.*this|reveal|check.*this|look.*at.*this)/.test(t))
      return 'person holds product up toward camera with a confident display — slight smile, direct eye contact';
    if (/(mix|mixing|stir|stirring|blend|blending|shake|shaking|whisk|whisking)/.test(t) && /(bowl|container|cup|jar|bottle|glass|pan|spoon)/.test(t))
      return 'person mixes or stirs with a smooth consistent motion — watches the motion, then returns to camera eye contact';
    if (/(scoop|scooping|measure|measuring)/.test(t) && /(spoon|cup|tablespoon|teaspoon|scoop|powder|supplement)/.test(t))
      return 'person scoops or measures with deliberate steady hands — precise careful motion';
    if (/(open|opening|unscrew|cap.*off|twist.*open|crack.*open|peel|peeling)/.test(t))
      return 'person opens the container with a natural motion — presents product to camera after opening';
    if (/(spread|spreading|apply|applying|rub|rubbing|put.*on|dab|dip|dipping)/.test(t))
      return 'person applies product with a gentle deliberate touch — smooth consistent motion';
    if (/(grab|grabbing|pick.*up|reach.*for|take.*the|pull.*out)/.test(t))
      return 'person reaches and picks up an item with a natural confident motion — brings it into frame';
    if (/(point|pointing|tap|tapping|gesture.*toward|look.*down|down.*here|right.*here)/.test(t))
      return 'person points directly at camera or taps product — strong direct energy, purposeful gesture';
    if (/(cut|cutting|slice|slicing|chop|chopping|break|breaking)/.test(t))
      return 'person cuts or breaks an item with a clean deliberate motion — controlled and practiced';
    if (/(smell|smelling|sniff|sniffing|inhale|breathe.*in)/.test(t))
      return 'person brings item close and inhales with a genuine pleased reaction — looks back at camera with a smile';
    if (/(eat|eating|bite|biting|chew|chewing|try|trying|tasted|tasting)/.test(t))
      return 'person takes a bite or eats with natural motion — genuine satisfying reaction, smiles at camera';
    if (/(wash|washing|rinse|rinsing|clean|cleaning)/.test(t))
      return 'person performs washing or cleaning motion with deliberate hands — clear and visible action';
    if (/(swallow|capsule|pill|tablet|take.*supplement|take.*vitamin)/.test(t))
      return 'person holds up capsule or tablet, takes it naturally — clean motion, looks back to camera';
    if (/(dissolv|melt|break.*down|fat.*away|burn.*fat|flush.*out|cleans.*gut|cleanse.*liver|detox|toxin)/.test(t))
      return 'person demonstrates or gestures toward a visual effect — points to or pours liquid showing a dissolving or clearing reaction on a prop or model';
    if (/(stomach|gut|liver|organ|model|fat.*model|body.*model|digestive)/.test(t))
      return 'person holds or gestures toward an anatomical prop or model — demonstrates effect with a deliberate hand motion';
    if (/(watch|watch.*what|look.*what|look.*how|see.*how|see.*what|i.*show)/.test(t))
      return 'person holds demonstration prop or object toward camera — gestures to draw attention to a visual effect';
    // ── Scene position fallbacks ─────────────────────────────────────────────
    if (sceneIndex === 0)
      return 'person delivers opening hook directly to camera — confident eye contact, slight forward lean, engaging energy';
    if (sceneIndex === totalScenes - 1)
      return 'person delivers closing call-to-action with conviction — direct eye contact, warm smile, natural hand gesture';
    // ── Emotional / rhetorical states ────────────────────────────────────────
    if (/\?/.test(text))
      return 'person asks question with raised eyebrows and a brief pause — inviting expression, slight head tilt';
    if (/(wow|amazing|incredible|unbelievable|crazy|insane|shocking|!{2,})/.test(t))
      return 'person speaks with high energy and excitement — emphatic hand gestures, expressive face';
    if (/(calm|relax|breath|peace|gentle|slow|easy|simple)/.test(t))
      return 'person speaks calmly and deliberately — measured pace, soft confident expression';
    if (/(important|critical|key|remember|listen|never|always|must|warning|stop)/.test(t))
      return 'person emphasises a key point — leans slightly forward, firm eye contact, deliberate pacing';
    if (/(when i|i was|i used to|back when|one day|story|my|personally)/.test(t))
      return 'person shares personal story — reflective expression, natural relaxed gestures, warm tone';
    if (/(step|first|second|third|number \d|tip \d|rule \d|#\d)/.test(t))
      return 'person lists a point — counts on fingers or gestures purposefully, clear and direct delivery';
    if (/(result|transform|before|after|changed|worked|proof|evidence)/.test(t))
      return 'person reveals a result — slight smile of satisfaction, measured confident delivery';
    return 'person speaks naturally to camera — confident posture, real eye contact, natural hand gestures';
  }

  // URL-to-Script: GPT generates a full ad script from Brand Kit data
  async function generateScriptFromUrl() {
    if (typeof window.requireAccess === 'function' && !window.requireAccess()) return;
    const kit = getBrandKit();
    let url = kit.productUrl;
    if (!url) {
      url = prompt('No product URL in Brand Kit. Enter one now:');
      if (!url) return;
      const urlEl = document.getElementById('bkProductUrl');
      if (urlEl) { urlEl.value = url; saveBrandKit(); }
    }
    const key = getApiKey();
    if (!key) { showToast('Add your OpenAI API key in Settings first.', 'warning'); return; }

    const btn = document.getElementById('urlToScriptBtn');
    if (btn) { btn.textContent = '⏳ Generating…'; btn.disabled = true; }

    try {
      const productName  = kit.productName  || 'the product';
      const toneMap      = { energetic:'energetic and hype', conversational:'casual and conversational', urgent:'urgent with FOMO', professional:'polished and professional', storytelling:'story-driven and emotional' };
      const toneDesc     = toneMap[kit.tone] || 'conversational';
      const talkingPts   = kit.talkingPoints ? kit.talkingPoints.split('\n').filter(Boolean).map(l => '• ' + l).join('\n') : '';
      const cta          = kit.cta || 'Link in bio';
      const productType  = (document.getElementById('studioProduct')?.value) || 'affiliate';

      const systemPrompt = `You are a viral short-form video copywriter who writes Amazon affiliate scripts that consistently stop the scroll. Your scripts sound like a real person sharing a genuine find — not an ad.

What separates your scripts from bad AI output:
- The HOOK names ONE specific moment the viewer has lived — not "I tried everything"
- The PROBLEM is shown with one concrete physical detail (what they saw, touched, smelled)
- The DISCOVERY is low-key and natural — not a sales pitch
- The PROOF is something you can SEE or FEEL — not a vague adjective
- Every sentence is 8–14 words, lands as its own beat, sounds real when spoken out loud

BANNED — never write these words or phrases:
Doctor-approved · Clinically proven`;

      // Build beat instructions — GPT decides optimal count (6–9 beats)
      const beatLabels = [];
      beatLabels.push('HOOK: ONE specific relatable moment. Mid-action. No "I tried everything". Name the exact thing that was not working. 8-12 words.');
      beatLabels.push('PROBLEM: The most specific, visual detail of that frustration. What they saw or touched. 8-14 words.');
      beatLabels.push('DISCOVERY: How they found ' + productName + '. One sentence. Natural, not forced. 8-14 words.');
      beatLabels.push('DEMO: What they physically do with the product. What they see in that moment. 8-14 words.');
      beatLabels.push('PROOF: ONE specific result. Something measurable or visual — not "my skin felt better". 8-14 words.');
      beatLabels.push('CTA (final, word for word): ' + cta);

      const userPrompt = `Write a short-form video script for this product — ONE sentence per beat. Use 6–9 beats total (you decide the optimal count based on the product):

PRODUCT: ${productName}
${talkingPts ? 'KEY BENEFITS (weave in naturally, do not list them):\n' + talkingPts + '\n' : ''}CREATOR TONE: ${toneDesc}
Each sentence: 8–14 words max, spoken naturally in one breath.

BEAT STRUCTURE (follow this order, expand with extra PROOF beats if needed):
${beatLabels.join('\n')}

QUALITY BAR — before you output, ask yourself:
1. Does every line name something SPECIFIC? (not "blackheads" — "the blackheads right on the tip of my nose that never moved")
2. Is there at least ONE moment the viewer can physically picture?
3. Does any line contain a banned word? If yes, replace it.
4. Does it sound like a real person texting a friend a recommendation?

Return ONLY the sentences — one per line, no labels, no numbers, no explanation.`;

      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
          max_tokens: 600,
          temperature: 0.8,
        })
      });
      if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err?.error?.message || `API error ${res.status}`); }
      const data = await res.json();
      const script = data.choices?.[0]?.message?.content?.trim() || '';
      if (!script) throw new Error('Empty response from GPT');

      const scriptEl = document.getElementById('originalScript');
      if (scriptEl) {
        scriptEl.value = script;
        onMasterScriptInput(scriptEl);
      }
      // Auto-split immediately
      setTimeout(() => { const _el = document.getElementById('originalScript'); if (_el && _el.value.trim()) splitScriptToScenes(); }, 100);
    } catch(e) {
      showToast('Script generation failed: ' + e.message, 'error');
    } finally {
      if (btn) { btn.textContent = '🔗 Generate Script from URL'; btn.disabled = false; }
    }
  }

  // Per-segment script rewrite
  async function rewriteSegmentScript(i) {
    const key = getApiKey();
    if (!key) { showToast('Add your OpenAI API key in Settings first.', 'warning'); return; }
    const ta  = document.getElementById('script-seg-' + i);
    const btn = document.getElementById('rewrite-seg-btn-' + i);
    if (!ta) return;
    const current = ta.value.trim() || segments[i]?.script?.trim() || '';
    if (!current) { showToast('No script in this scene yet.', 'warning'); return; }

    const prevScript = i > 0 ? (segments[i-1]?.script || '') : '';
    const nextScript = i < segments.length-1 ? (segments[i+1]?.script || '') : '';

    if (btn) { btn.textContent = '⏳'; btn.disabled = true; }
    const _segRef = segments[i]; // capture before any await so we can detect if segments changed
    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: 'You rewrite individual video ad scenes to fit within 8 seconds of speech (≤18 words). Keep the core message, trim filler. Sound natural and conversational. Return ONLY the rewritten scene text, nothing else.' },
            { role: 'user', content: `Rewrite this scene to ≤18 words while keeping its meaning.\n\n${prevScript ? 'Previous scene: "' + prevScript + '"\n' : ''}Current scene: "${current}"\n${nextScript ? 'Next scene: "' + nextScript + '"' : ''}` }
          ],
          max_tokens: 120,
          temperature: 0.6,
        })
      });
      if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err?.error?.message || `API error ${res.status}`); }
      const data = await res.json();
      const rewritten = data.choices?.[0]?.message?.content?.trim() || '';
      if (!rewritten) throw new Error('Empty response');
      if (!segments[i] || segments[i] !== _segRef) return; // guard: segments may have changed during await
      ta.value = rewritten;
      segments[i].script = rewritten;

      // Rebuild action + Veo 3 prompt from new script
      segments[i].action = deriveSceneAction(rewritten, i, segments.length);
      const setting     = document.getElementById('studioSetting')?.value.trim() || '';
      const productSel  = document.getElementById('studioProduct');
      const productName = productSel ? (productSel.options[productSel.selectedIndex]?.text || 'the product') : 'the product';
      segments[i].veoPrompt = buildSegmentVeo3Prompt(i, segments[i].startTime, segments[i].endTime, rewritten, setting, productName, bgImageDataUrl);

      // Update action field in the DOM if visible
      const actionEl = document.getElementById('action-seg-' + i);
      if (actionEl) actionEl.value = segments[i].action;
      const veoEl = document.getElementById('veo-seg-' + i);
      if (veoEl) veoEl.value = segments[i].veoPrompt;

      autoGrow(ta);
      debounceSave();
      // Flash green
      ta.style.borderColor = '#4ade80';
      setTimeout(() => ta.style.borderColor = '', 1200);
      showToast('↺ Script rewritten — action & Veo 3 prompt updated.', 'success', 2500);
    } catch(e) {
      showToast('Rewrite failed: ' + e.message, 'error');
    } finally {
      if (btn) { btn.textContent = '↺ Rewrite'; btn.disabled = false; }
    }
  }

  // Hook Variations + Ad Scoring
  function closeHookVariationsModal() {
    const m = document.getElementById('hookVariationsModal');
    if (m) m.style.display = 'none';
  }

  function applyHookVariation(text) {
    // Replace first segment's script text
    if (segments.length === 0) { showToast('No segments yet — split a script into scenes first.', 'warning'); return; }
    segments[0].script = text;
    const ta = document.getElementById('script-seg-0');
    if (ta) ta.value = text;
    saveSegments();
    closeHookVariationsModal();
    // Flash the first card
    const card = document.getElementById('seg-card-0');
    if (card) { card.style.outline = '2px solid var(--accent)'; setTimeout(() => card.style.outline = '', 1200); }
  }

  async function generateHookVariations() {
    window._vsHookResults = [];
    if (segments.length === 0) { showToast('Split your script into scenes first.', 'warning'); return; }
    const key = getApiKey();
    if (!key) { showToast('Add your OpenAI API key in Settings first.', 'warning'); return; }

    const modal = document.getElementById('hookVariationsModal');
    const list  = document.getElementById('hookVariationsList');
    const btn   = document.getElementById('hookVariationsBtn');
    if (!modal || !list) { showToast('Hook variations panel not found — please reload.', 'error'); return; }
    modal.style.display = 'flex';
    list.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-3);font-size:12px;">⏳ Generating hooks…</div>';
    if (btn) { btn.textContent = '⏳'; btn.disabled = true; }

    try {
      const kit        = getBrandKit();
      const firstSeg   = segments[0]?.script || document.getElementById('originalScript')?.value?.split(/[.!?]/)[0] || '';
      const fullScript = segments.map(s => s.script).join(' ');
      const productName = kit.productName || (document.getElementById('studioProduct')?.options[document.getElementById('studioProduct')?.selectedIndex]?.text) || 'the product';
      const toneMap   = { energetic:'energetic and hype', conversational:'casual and conversational', urgent:'urgent with FOMO', professional:'polished and professional', storytelling:'story-driven' };
      const toneDesc  = toneMap[kit.tone] || 'conversational';
      const cta       = kit.cta || '';

      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [
            { role: 'system', content: 'You are an expert TikTok/Reels ad copywriter specializing in pattern-interrupt hooks. Return ONLY valid JSON.' },
            { role: 'user', content: `Generate 5 alternative opening hooks for this affiliate ad. Each should be ≤18 words, spoken aloud, no hashtags or emojis.

Product: ${productName}
Tone: ${toneDesc}
Current opening: "${firstSeg}"
Full script context: "${fullScript.slice(0, 400)}"
${cta ? 'CTA: ' + cta : ''}

Return a JSON array of 5 objects: [{"hook": "...", "score": 8, "why": "short reason (≤8 words)"}]
Score each hook 1-10 on: pattern-interrupt strength, emotional pull, curiosity gap. Return ONLY the JSON array.` }
          ],
          max_tokens: 600,
          temperature: 0.9,
        })
      });
      if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err?.error?.message || `API error ${res.status}`); }
      const data = await res.json();
      const raw = data.choices?.[0]?.message?.content?.trim() || '';
      let jsonStr = raw.replace(/^```json\n?/, '').replace(/\n?```$/, '').trim();
      const arrStart = jsonStr.indexOf('[');
      const arrEnd = jsonStr.lastIndexOf(']');
      if (arrStart !== -1 && arrEnd !== -1) jsonStr = jsonStr.slice(arrStart, arrEnd + 1);
      let hooks;
      try { hooks = JSON.parse(jsonStr); } catch(_pe) { throw new Error('Malformed JSON from AI — please try again.'); }
      if (!Array.isArray(hooks)) throw new Error('Unexpected response format from AI — please try again.');
      window._vsHookResults = hooks; // stored so onclick can reference by index safely

      list.innerHTML = hooks.map((h, i) => {
        const score = h.score || 0;
        const scoreColor = score >= 8 ? '#4ade80' : score >= 6 ? '#fbbf24' : '#f87171';
        return `<div style="border:1px solid var(--border-2);border-radius:8px;padding:12px 14px;background:var(--surface-2);display:flex;flex-direction:column;gap:6px;">
          <div style="display:flex;align-items:flex-start;gap:10px;">
            <div style="font-size:18px;font-weight:900;color:${scoreColor};flex-shrink:0;line-height:1;min-width:24px;">${score}</div>
            <div style="font-size:12px;color:var(--text-1);line-height:1.5;flex:1;">${escHtml(h.hook)}</div>
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="font-size:10px;color:var(--text-3);flex:1;font-style:italic;">${escHtml(h.why || '')}</span>
            <button onclick="applyHookVariation(window._vsHookResults[${i}].hook)" style="padding:4px 12px;font-size:10.5px;font-weight:600;background:rgba(99,102,241,0.15);border:1px solid rgba(99,102,241,0.4);border-radius:5px;color:#818cf8;cursor:pointer;white-space:nowrap;">↩ Use This Hook</button>
          </div>
        </div>`;
      }).join('');
    } catch(e) {
      list.innerHTML = `<div style="color:var(--danger);padding:16px;font-size:12px;">Failed: ${escHtml(e.message)}</div>`;
    } finally {
      if (btn) { btn.textContent = '🎣 Hook Variations'; btn.disabled = false; }
    }
  }

  // Split the script into ~8s scenes at sentence boundaries
  function splitScriptToScenes() {
    const scriptEl = document.getElementById('originalScript');
    const raw = scriptEl ? scriptEl.value.trim() : '';
    if (!raw) {
      showToast('Paste your script into the Script / Transcript box first, then click ✂ Split into Scenes.', 'warning');
      return;
    }

    // ── Step 1: tokenise into individual sentences ─────────────────────────
    // Handle  .  !  ?  …  and common abbreviations (Mr. Dr. vs sentence ends)
    const sentenceRe = /(?<=[^A-Z][.!?…]{1,3})\s+(?=[A-Z"'])|(?<=[.!?…]{1,3})\s*$/gm;
    const rawSentences = raw
      .replace(/\r\n|\r/g, '\n')             // normalise line endings
      .replace(/\n+/g, ' ')                  // flatten all newlines to spaces
      .split(/(?<=[.!?…])\s+/)               // split after sentence-ending punctuation
      .map(s => s.trim())
      .filter(s => s.length > 0);

    if (rawSentences.length === 0) {
      showToast('Could not parse any sentences. Make sure your script has punctuation (. ! ?).', 'warning');
      return;
    }

    // Warn if there are any existing segments (not just those with generated prompts)
    if (segments.length > 0) {
      showConfirm('This will replace your current segments. Continue?', () => _doSplit(rawSentences));
      return;
    }
    _doSplit(rawSentences);
  }

  function _doSplit(rawSentences) {
    // ── Step 2: group sentences into ~8s chunks ────────────────────────────
    const sceneTexts = [];
    let bucket = [];
    let bucketWords = 0;

    for (let si = 0; si < rawSentences.length; si++) {
      const s = rawSentences[si];
      const wc = s.split(/\s+/).filter(Boolean).length;
      bucket.push(s);
      bucketWords += wc;

      const isLast = si === rawSentences.length - 1;
      if (bucketWords >= TARGET_WORDS || isLast) {
        // If we're just one short sentence over the limit and there are more
        // sentences to come, check whether adding the NEXT sentence would push
        // us further from 8s than stopping now
        sceneTexts.push(bucket.join(' '));
        bucket = [];
        bucketWords = 0;
      }
    }

    // Merge any trailing scene that is too short (< 4 words) into the previous
    if (sceneTexts.length > 1) {
      const last = sceneTexts[sceneTexts.length - 1];
      if (last.split(/\s+/).filter(Boolean).length < 4) {
        sceneTexts[sceneTexts.length - 2] += ' ' + last;
        sceneTexts.pop();
      }
    }

    if (sceneTexts.length === 0) {
      showToast('Could not create any scenes. Try adding more text to your script.', 'warning');
      return;
    }

    // ── Step 3: build segment objects with real speech-based timestamps ─────
    let elapsed = 0;
    segments = sceneTexts.map((text, i) => {
      const words    = text.split(/\s+/).filter(Boolean).length;
      const duration = Math.max(Math.round((words / WORDS_PER_SEC) * 10) / 10, 2);
      const start    = Math.round(elapsed * 10) / 10;
      elapsed += duration;
      const end = Math.round(elapsed * 10) / 10;
      return {
        startTime:       start,
        endTime:         end,
        script:          text,
        action:          deriveSceneAction(text, i, sceneTexts.length),
        frameDataUrl:    null,
        nbPrompt:        '',
        veoPrompt:       '',
        frameDesc:       '',
        _scriptOnly:     true,
      };
    });

    saveSegments();
    renderSegments();

    const total  = segments.length;
    const totSec = Math.round(elapsed);
    const countEl = document.getElementById('segmentCount');
    if (countEl) countEl.textContent = `${total} scene${total !== 1 ? 's' : ''}`;
    showToast(`${total} scene${total !== 1 ? 's' : ''} created — now click ⚡ Generate All Prompts.`, 'success');

    // Check for short segments after split
    const shortSegs = segments.filter(s => (s.script || '').split(/\s+/).filter(Boolean).length < 4);
    if (shortSegs.length > 0) {
      showToast(`${shortSegs.length} segment${shortSegs.length > 1 ? 's have' : ' has'} fewer than 4 words. Use the ⊕ Merge button to combine them.`, 'warning', 5000);
    }
    // Auto-collapse script panel in Producer mode so segment cards are immediately visible
    const _scriptPanel = document.getElementById('vsPanelScript');
    if (_scriptPanel && _scriptPanel.dataset.collapsed !== '1') {
      const _hdr = _scriptPanel.querySelector('.vs-panel-header.collapsible');
      if (_hdr) _hdr.click();
    }
  }  // end _doSplit

  // NB Pro starting-frame prompt for script-only scenes (no video frame reference)
  function buildScriptOnlyNBPrompt(sceneIndex, scriptSlice, setting, avatarDesc, bgDataUrl, frameDesc) {
    const total = segments.length;
    const isFirst = sceneIndex === 0;
    const sceneNum = sceneIndex + 1;

    const clothingNote = getAvatarAccessoryNote(); // clothing + jewelry from Appearance Inventory

    // ── Build structured NB Pro-style instruction ─────────────────────────────
    // Follows the labeled-section format used by NanaBanana Pro in Flow:
    // [FULL PERSON] → REPLACE → Camera → LOCK → ARM → PROP STATE → LIGHT →
    // HAIR LOCK → OUTFIT → GENDER LOCK → TRANSFER BLOCK → LIGHTING MATCH
    const _instrParts = [];

    // Header — full person replacement
    _instrParts.push('[FULL PERSON] REPLACE: avatar person — same position and scale as original person in reference frame.');

    // Camera angle
    _instrParts.push(`Camera angle: straight-on, ${isFirst ? 'chest height' : 'medium close-up'}.`);

    // ── STAGING — the specific action for THIS scene (this is what makes frames non-flat) ──
    var _stgSeg  = (window.segments || [])[sceneIndex];
    var _staging = (_stgSeg && _stgSeg.action) ? _stgSeg.action : (scriptSlice || '');
    if (_staging) {
      _instrParts.push(`STAGING — show this exact moment: ${_staging}. The avatar is ACTIVELY performing this action (holding the product label-forward, mixing in a bowl, squeezing/stirring, scooping, applying, or examining) — NOT just standing and talking. Place a counter or table in front of the avatar for the demo.`);
    }

    // ── POSE & CAMERA vary per scene; SETTING stays identical ──
    _instrParts.push('POSE & CAMERA (this scene only): set the avatar\'s body position, blocking and camera framing to match the staged action above — she may be standing at the counter, seated at the desk leaning over a demo, or tending to a person on a table. The ROOM and SETTING stay IDENTICAL to every other scene; only her pose, what she holds, and the camera distance change between scenes.');

    // Per-scene shot/framing — derived from the scene's shot hint (falls back to a sensible default)
    var _shotHint = (_stgSeg && _stgSeg._shot) ? String(_stgSeg._shot).toLowerCase() : '';
    var _shotDesc = /wide|full/.test(_shotHint)              ? 'wide shot, full body and the surrounding room visible'
                  : /medium close/.test(_shotHint)           ? 'medium close-up, chest-up, hands and prop visible'
                  : /close[- ]?up|ecu|macro|detail/.test(_shotHint) ? 'close-up, the product or treated area prominent'
                  : /medium/.test(_shotHint)                 ? 'medium shot, waist-up with the table and props visible'
                  : isFirst                                  ? 'medium shot, waist-up, establishing the scene and the table'
                  :                                            'medium close-up, chest-up, hands and any prop visible';
    var _framing = 'vertical 9:16, ' + _shotDesc + ', 85mm equivalent, f/1.8 shallow depth of field';

    // Background / setting lock
    if (frameDesc) {
      _instrParts.push(`LOCK: background — ${frameDesc}. Do not alter, move, or add any background elements.`);
    } else if (setting) {
      _instrParts.push(`SETTING (locked for the ENTIRE video — identical in every scene): ${setting}. Same room, decor, props, lighting direction and camera position across all scenes; ONLY the avatar's action changes between scenes. Do not reimagine or vary the environment.`);
    } else {
      _instrParts.push('LOCK: background — use the reference frame environment exactly as shown. Do not alter, move, or add any background elements.');
    }

    // Product reveal on the final scene
    if (sceneNum === total && total > 1) {
      _instrParts.push('PRODUCT REVEAL: the avatar holds the product up toward camera, label facing forward and well-lit, as the clear focal point of this final frame.');
    }

    // Products/props (from Appearance Inventory product instructions)
    const _productInstr = getProductNBInstruction();
    if (_productInstr) _instrParts.push(_productInstr);

    // Light
    _instrParts.push('LIGHT: match the color temperature, direction, and shadow quality of the reference frame exactly.');

    // Hair lock — avatar's hair explicitly stated, warn against reference frame hair bleed
    if (avatarDesc) {
      _instrParts.push(`HAIR LOCK: Avatar description — ${avatarDesc}. The reference frame person may have different hair, skin tone, or facial features — DO NOT apply any of those attributes to the avatar under any circumstances.`);
    }

    // Outfit — from Appearance Inventory clothing note
    if (clothingNote) {
      _instrParts.push(`OUTFIT: The avatar must be wearing exactly this outfit as shown in the avatar reference: ${clothingNote}. Do not change any part of the clothing.`);
    }

    // Avatar accessories warning
    _instrParts.push('CRITICAL: Do NOT copy or add any hair accessories, headbands, hats, clips, bows, or wearable items from the reference frame person that are NOT listed in the avatar profile. The avatar wears ONLY the items described — nothing extra from the reference.');

    // Gender/age/ethnicity lock
    _instrParts.push('GENDER LOCK: The avatar must match the exact gender, approximate age, and ethnicity of the person in the avatar reference photo (Photo 1). Do NOT change the avatar\'s gender, age group, or ethnicity — even if the reference frame contains a person of a different gender or age.');

    // Transfer block — prevent text/overlay/prop bleed from source frame
    _instrParts.push('TRANSFER BLOCK: Do NOT copy any text, numbers, dates, labels, logos, words, or graphical overlays from the reference frame into the output. Do NOT copy any props, objects, or accessories held or worn by the reference frame person unless explicitly described in the scene action.');

    // Lighting match
    _instrParts.push('LIGHTING MATCH: Adjust the avatar\'s lighting to exactly match the color temperature, direction, and shadow quality of the reference frame — no generic studio lighting.');

    // Final quality note
    _instrParts.push('Vertical 9:16, photorealistic lifestyle editorial. This image will be used as the first frame of a Veo 3 video clip.');

    // ── Photo guide ───────────────────────────────────────────────────────────
    const _soPhotoGuide = (bgFromAvatar
      ? `Photo 1 = your avatar (person + background source for Scene ${sceneNum}). No video frame reference for this scene.`
      : bgDataUrl
        ? `Photo 1 = your avatar (person to composite). Photo 2 = Scene ${sceneNum} reference frame (background/composition to match).`
        : `Photo 1 = your avatar — used to generate a synthetic starting frame for Scene ${sceneNum}.`) + getProductPhotoGuide();

    const obj = {
      scene:       `Scene ${sceneNum} of ${total}`,
      photo_guide: _soPhotoGuide,
      seed:        Math.floor(Math.random() * 99999),
      instruction: _instrParts.join(' '),
      framing:     _framing,
      expression:  isFirst ? 'confident, engaged, slight smile' : 'mid-sentence natural expression, eye contact',
      style:       'photorealistic lifestyle editorial — real room, real light, real decor. NOT AI art, NOT studio backdrop, NOT blurred gradient',
      remove_captions: true,
      negative_prompt: 'changed clothing, changed skin tone, changed face, wrong hair, hair color change, hairstyle from reference frame, hair bleed, extra hair accessories from reference, wrong gender avatar, gender swap, age change, ethnicity change, ghosting, double exposure, transparency, semi-transparent person, composite seam, edge halo, color fringing, mismatched lighting, text overlay from reference, numbers on body, date on clothing, labels from reference frame, captions, watermarks, cartoon, illustration, anime, distorted hands, extra fingers, blurry face, multiple people, AI artifacts',
    };

    if (frameDesc) obj.visual_description = frameDesc;

    if (bgDataUrl) {
      obj.background_reference = bgFromAvatar
        ? 'Recreate the background/environment visible in Photo 1 as the scene backdrop. Keep it realistic and consistent — do not replace or reimagine it.'
        : 'Use the environment and background from the reference frame as the scene backdrop. Keep it consistent — do not alter or reimagine it.';
    }

    return JSON.stringify(obj, null, 2);
  }

  function generateAllSegmentPrompts() {
    if (segments.length === 0) {
      showToast('No scenes yet. Paste your script and click ✂ Split into Scenes.', 'warning');
      return;
    }
    const productSel = document.getElementById('studioProduct');
    const product = productSel ? productSel.value : '';
    const productName = productSel ? (productSel.options[productSel.selectedIndex]?.text || 'the product') : 'the product';
    const setting = document.getElementById('studioSetting') ? document.getElementById('studioSetting').value.trim() : '';

    // Sync any live textarea edits into the segments array
    segments.forEach((seg, i) => {
      const ta = document.getElementById('script-seg-' + i);
      if (ta) seg.script = ta.value;
    });

    // If all segments are still empty, try distributing from the original script box
    if (segments.every(s => !(s.script || '').trim())) {
      distributeScript();
    }

    const avatarDesc = document.getElementById('avatarDesc') ? document.getElementById('avatarDesc').value.trim() : '';

    // Build NB prompts synchronously for segments without a captured frame.
    // Segments WITH a frame skip the template entirely — the vision API call below
    // builds the real prompt directly from the image, so stale template output is never shown.
    segments.forEach((seg, i) => {
      if (seg._scriptOnly || !seg.frameDataUrl) {
        // No captured frame — use template
        seg.nbPrompt = buildScriptOnlyNBPrompt(i, seg.script, setting, avatarDesc, bgImageDataUrl, seg.frameDesc || '');
      } else {
        // Frame available — skip template, vision call fills the real prompt below
        seg.nbPrompt    = '⏳ Analyzing frame…';
        seg.nbEndPrompt = buildSegmentNanoBananaEndPrompt(i, setting, productName, product);
      }
      // For segments without an NB preview image, build a text-based Veo 3 prompt now
      if (!seg.nbPreviewDataUrl) {
        seg.veoPrompt = buildSegmentVeo3Prompt(i, seg.startTime, seg.endTime, seg.script, setting, productName, bgImageDataUrl);
      }
    });
    // Rebuild Veo 3 JSON for continuation clips — inherits shot/camera from freshly-built parent
    segments.forEach((seg, i) => {
      if (!seg.veoExtras || !seg.veoExtras.length) return;
      seg.veoExtras.forEach(function(extra, j) {
        if (!(extra.speech || '').trim()) return;
        if (typeof updateVeoExtraSpeech === 'function') updateVeoExtraSpeech(i, j, extra.speech);
      });
    });

    saveSegments();
    renderSegments();
    // Auto-reveal Veo 3 prompts after generation
    document.querySelectorAll('[id^="veo-wrap-"]').forEach(el => { el.style.display = ''; });

    // For segments that have an NB preview image, build vision-based Veo 3 prompts asynchronously.
    // Also run a vision pass to build smarter NB prompts for segments with frame images.
    // Return the promise so callers (e.g. processEverything) can await full completion before
    // opening the pre-flight modal — otherwise segments with NB images show as ❌ "no Veo 3 prompt".
    const withPreviews = segments.filter(s => s.nbPreviewDataUrl);
    const withFrames = segments.filter(s => !s._scriptOnly && s.frameDataUrl);
    const saveAllBtn = document.getElementById('saveAllBtn');
    if (saveAllBtn) saveAllBtn.style.display = 'inline-block';
    if (withPreviews.length > 0 || withFrames.length > 0) {
      return (async () => {
        // Adaptive concurrency — large batches use fewer parallel calls to avoid 429 rate limits
        const _nbConcurrency = segments.length > 20 ? 1 : segments.length > 10 ? 2 : 3;
        // Veo3 from NB preview images — throttled to avoid 429 rate errors
        await _concurrentMap(segments, async (seg, i) => {
          if (!seg.nbPreviewDataUrl) return;
          const veoTa = document.getElementById('veo-seg-' + i);
          if (veoTa) veoTa.value = '⏳ Building from NB image…';
          const _nbOk = await buildVeo3FromNBImage(i);
          // Guard: if segments were replaced during the await, abort — stale index
          if (!segments[i] || seg !== segments[i]) return;
          if (!_nbOk && veoTa && veoTa.value.startsWith('⏳')) {
            // Vision call failed — fall back to template so the textarea isn't stuck on the spinner
            const _s2 = document.getElementById('studioSetting')?.value.trim() || '';
            const _ps2 = document.getElementById('studioProduct');
            const _pn2 = _ps2 ? (_ps2.options[_ps2.selectedIndex]?.text || 'the product') : 'the product';
            segments[i].veoPrompt = buildSegmentVeo3Prompt(i, segments[i].startTime, segments[i].endTime, segments[i].script, _s2, _pn2, bgImageDataUrl);
            if (veoTa) { veoTa.value = segments[i].veoPrompt; autoGrow(veoTa); }
          }
        }, _nbConcurrency);
        // Vision-based NB prompt building — throttled to avoid 429 rate errors
        await _concurrentMap(segments, async (seg, i) => {
          if (seg._scriptOnly || !seg.frameDataUrl) return;
          const nbTa2 = document.getElementById('nb-seg-' + i);
          const ok = await buildNBPromptFromImage(i);
          // Guard: if segments were replaced during the await, abort — stale index
          if (!segments[i] || seg !== segments[i]) return;
          if (!ok) {
            // Vision call failed — keep the template-built prompt already set above
            const _s2 = document.getElementById('studioSetting')?.value.trim() || '';
            const _ps2 = document.getElementById('studioProduct');
            const _pn2 = _ps2 ? (_ps2.options[_ps2.selectedIndex]?.text || 'the product') : 'the product';
            segments[i].nbPrompt = buildSegmentNanoBananaPrompt(i, segments[i].frameDataUrl, segments[i].script, _s2, _pn2, _ps2 ? _ps2.value : '');
            if (nbTa2) { nbTa2.value = segments[i].nbPrompt; autoGrow(nbTa2); }
          }
        }, _nbConcurrency);
        saveSegments();
      })().catch(e => { showToast('Error building prompts: ' + (e?.message || String(e)), 'error'); throw e; });
    }
    return Promise.resolve();
  }

  // --- AI Describe Scenes (Producer mode) ---
  // Sends each scene's script to GPT and fills in Action + Visual Description fields
  async function aiDescribeScenes() {
    if (segments.length === 0) { showToast('Split your script into scenes first.', 'warning'); return; }
    const apiKey = getApiKey();
    if (!apiKey) { showToast('AI features are not available right now. Please contact support.', 'warning'); return; }

    const btn = document.getElementById('aiDescribeBtn');
    if (btn) { btn.textContent = '⏳ Describing…'; btn.disabled = true; }

    const avatarDesc = document.getElementById('avatarDesc')?.value.trim() || 'a person';
    const setting = document.getElementById('studioSetting')?.value.trim() || '';

    const sceneList = segments.map((s, i) =>
      `Scene ${i + 1} (~${Math.round(s.endTime - s.startTime)}s): "${(s.script || '').trim()}"`
    ).join('\n');

    const hasBgImage = !!bgImageDataUrl;

    const systemPrompt = hasBgImage
      ? `You are an expert lifestyle photography art director writing foreground prop descriptions for short-form social media video frames.

A background image has already been provided (attached). The room, walls, surfaces, lighting, and decor ARE ALREADY DECIDED by that image. You must NOT describe the room. You must NOT mention the kitchen, walls, decor, or any setting details — the background is locked in.

Your ONLY job is to describe what PROPS are sitting on the surface directly in front of the presenter for each scene, AND precisely how the presenter is positioned and using those props.

For each scene output two fields:
- action: Describe PRECISELY what the presenter is physically doing. You MUST include: (1) what each hand is doing — specifically what it is holding, touching, or resting on; (2) the presenter's vertical position relative to the table/surface — are they leaning forward, standing upright, chest above the table; (3) facial expression and eye contact. Be concrete: "holds a halved lemon in right hand, left hand resting flat on the counter, upper body upright with chest above table level, looks directly at camera with a slight smile." Max 2 sentences. Third person.
- visual: ONLY describe the foreground props that sit on the surface directly in front of the presenter. These props must match what the script is talking about. Nothing else. Do not describe the room. Do not describe the background. Do not name a setting.

PROP RULES:
- Props sit on the surface DIRECTLY IN FRONT of the presenter — in the lower foreground of the frame, right in front of their body
- Props must match what the script is literally saying. If the script says "lemon water" → a halved lemon and a glass of water with lemon slices. If it says "this supplement" → the supplement bottle label-forward on the surface. If it says "smoothie" → a blender and fruit pieces on the surface.
- If the script is a hook, transition, or doesn't mention a specific item → describe simple neutral props that fit the video's topic (e.g. a glass of water, a small bowl, a bottle)
- Keep it concise: 1–2 sentences, props only, no room description whatsoever

BAD action: "stands confidently, gestures to camera"
GOOD action: "holds a halved lemon in right hand raised near chest height, left hand open on the counter, upper body upright with torso above table level, direct eye contact, slight smile"
BAD visual (describes room): "Warm kitchen with marble counter, floating shelves with plants, afternoon window light."
GOOD visual (props only): "A halved lemon and a tall glass of water with floating lemon slices sitting on the surface directly in front of her."`

      : `You are an expert lifestyle photography art director and AI image prompt writer. You create starting-frame descriptions for short-form social media videos that look like they were shot by a real photographer in a real space — not AI-generated.

${bgFromAvatar ? 'The avatar photo is attached — use it to identify the room aesthetic, surface type, wall decor style, and lighting. Your visual descriptions must match THIS aesthetic and setting. Do NOT invent a different room.' : ''}

For each scene output two fields:
- action: Describe PRECISELY what the presenter is physically doing. You MUST include: (1) what each hand is doing — specifically what it is holding, touching, or resting on; (2) the presenter's vertical position relative to the table/surface — are they leaning forward, standing upright, chest above the table; (3) facial expression and eye contact. Be concrete: "holds a glass of water in right hand at chest height, left hand resting on counter, upper body upright with chest above table level, looks directly at camera." Max 2 sentences. Third person.
- visual: a Pinterest-quality scene description grounded in the real space. Describe the room aesthetic (matching the avatar photo if provided), then the foreground props, then the lighting. Must look like a real photographed room.

RULES:
1. If the avatar photo is attached, match its exact aesthetic — same surface material, same wall style, same lighting quality. Do NOT substitute a different room or style.
2. PROPS IN FRONT: any ingredient, food, drink, or product mentioned in the script must sit on the surface DIRECTLY IN FRONT of the presenter in the lower foreground. This is how real wellness/recipe videos are shot.
3. Describe WALL DECOR specifically — named objects: "three framed botanical prints", "round rattan mirror", "floating oak shelf with ceramic canisters and a pothos".
4. Describe LIGHTING like a photographer: "warm afternoon window light raking in from the left", "overcast diffused north-facing window light", "warm Edison bulb glow".
5. End with a photography style note: "85mm f/1.8, shallow depth of field, lifestyle editorial, real room not a set".
6. Keep the room consistent across all scenes. Only props change per scene.
7. Max 3 sentences. Never describe the person's face, skin, or hair.

BAD action: "stands confidently, gestures broadly"
GOOD action: "holds a supplement bottle in right hand at chest height, left hand open palm-up on the counter, torso upright with chest above table level, direct eye contact, confident expression"
BAD visual: "Warm kitchen, herb jars in background."
GOOD visual: "Warm Japandi kitchen matching the reference photo — honed marble counter, floating oak shelves with ceramic canisters and a small pothos in the background. A halved lemon and a glass of water with lemon slices sit directly on the counter in front of her. Shot on 85mm f/1.8, shallow depth of field, lifestyle editorial, real kitchen not a set."`;

    const userPromptText = `Presenter: ${avatarDesc || 'a confident health/wellness creator'}.${setting ? '\nSetting preference: ' + setting + '.' : ''}
Total scenes: ${segments.length}. Keep setting consistent across scenes — only foreground props change.

Scenes (each ~8 seconds):\n${sceneList}

Return ONLY a raw JSON array of exactly ${segments.length} objects with "action" and "visual" fields. No markdown, no wrapper, no extra text. Start with [ end with ].`;

    // Build the user message — include background image as vision if available
    const userMessage = hasBgImage
      ? {
          role: 'user',
          content: [
            { type: 'text', text: userPromptText },
            { type: 'image_url', image_url: { url: bgImageDataUrl, detail: 'low' } }
          ]
        }
      : { role: 'user', content: userPromptText };

    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [{ role: 'system', content: systemPrompt }, userMessage],
          temperature: 0.75,
          max_tokens: Math.max(1000, segments.length * 150),
        })
      });
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error?.message || 'API error ' + res.status); }
      const data = await res.json();
      let parsed;
      try {
        let raw = data.choices?.[0]?.message?.content || '';
        // Strip markdown code fences if present
        raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
        // Find the JSON array even if there's preamble text
        const arrStart = raw.indexOf('[');
        const arrEnd = raw.lastIndexOf(']');
        if (arrStart !== -1 && arrEnd !== -1) raw = raw.slice(arrStart, arrEnd + 1);
        parsed = JSON.parse(raw);
        // If GPT wrapped it in an object anyway, unwrap
        if (!Array.isArray(parsed)) parsed = parsed.scenes || parsed.data || Object.values(parsed)[0];
      } catch(e) { throw new Error('Could not parse GPT response. Raw: ' + (data.choices?.[0]?.message?.content || '').slice(0, 200)); }

      if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('Unexpected response format.');

      parsed.forEach((desc, i) => {
        if (!segments[i]) return;
        if (desc.action) segments[i].action = desc.action;
        if (desc.visual) segments[i].frameDesc = desc.visual;
        // Update textareas in place without full re-render
        const actionEl = document.getElementById('action-seg-' + i);
        if (actionEl) { actionEl.value = desc.action || ''; autoGrow(actionEl); }
        const frameDescEl = document.getElementById('framedesc-seg-' + i);
        if (frameDescEl) { frameDescEl.value = desc.visual || ''; autoGrow(frameDescEl); }
      });
      saveSegments();
      if (btn) { btn.textContent = '✅ Done!'; setTimeout(() => { const b = document.getElementById('aiDescribeBtn'); if (b) { b.textContent = '✨ AI Describe'; b.disabled = false; } }, 2500); }
      showToast(`AI descriptions applied to ${parsed.length} scene${parsed.length !== 1 ? 's' : ''}`, 'success');
    } catch(err) {
      showToast('AI Describe failed: ' + err.message, 'error', 5000);
      if (btn) { btn.textContent = '✨ AI Describe'; btn.disabled = false; }
    }
  }

  // --- Claude in Chrome instruction builder ---

  // Opens an image in a new browser tab so Claude can right-click → Copy Image → paste
  function openImageInTab(dataUrl, tabTitle) {
    const _st = tabTitle.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    // dataUrl is always a base64 data: URI from FileReader/canvas — safe in src attribute
    const html = `<!DOCTYPE html><html><head><title>${_st}</title>
    <style>body{margin:0;background:#111;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;font-family:sans-serif;}
    img{max-width:100%;max-height:90vh;object-fit:contain;border:2px solid #444;border-radius:4px;}
    p{color:#aaa;font-size:13px;margin-top:12px;text-align:center;}
    strong{color:#fff;}</style></head>
    <body><img src="${dataUrl}" /><p><strong>${_st}</strong><br>Right-click the image → <strong>Copy Image</strong> — then paste it into the upload area</p></body></html>`;
    const blob = new Blob([html], { type: 'text/html' });
    const url  = URL.createObjectURL(blob);
    const tab  = window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 120000);
    // Keep focus on the current tab — images open silently in the background
    if (tab) { tab.blur(); window.focus(); }
  }

  function downloadFrameAsFile(dataUrl, filename, delayMs) {
    const _go = () => {
      // Convert data: URL → Blob URL so Safari honours the download attribute.
      // Safari silently ignores <a download> on data: URLs.
      try {
        const [meta, b64] = dataUrl.split(',');
        const mime = (meta.match(/:(.*?);/) || [])[1] || 'image/jpeg';
        const bytes = atob(b64);
        const arr = new Uint8Array(bytes.length);
        for (let j = 0; j < bytes.length; j++) arr[j] = bytes.charCodeAt(j);
        const blob = new Blob([arr], { type: mime });
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl; a.download = filename;
        document.body.appendChild(a); a.click();
        setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(blobUrl); }, 300);
      } catch (_) {
        // Fallback for browsers where atob/Blob fails (rare)
        const a = document.createElement('a');
        a.href = dataUrl; a.download = filename;
        document.body.appendChild(a); a.click();
        setTimeout(() => document.body.removeChild(a), 200);
      }
    };
    if (delayMs) setTimeout(_go, delayMs);
    else _go();
  }

  function getVeoDuration(script) {
    // Must return exactly 6 or 8 — Veo 3 only supports these two durations.
    // Snap rule: >7s speech → 8, otherwise → 6.
    const words = (script || '').trim().split(/\s+/).filter(Boolean).length;
    const secs  = words / WORDS_PER_SEC;
    return secs > 7 ? 8 : 6;
  }

  // ── Live Scene Status Panel ───────────────────────────────────────────────
  function showStatusPanel() {
    let panel = document.getElementById('sceneStatusPanel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'sceneStatusPanel';
      panel.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:9998;background:var(--surface);border:1px solid var(--border-2);border-radius:10px;padding:12px 14px;min-width:200px;max-width:260px;box-shadow:0 4px 24px rgba(0,0,0,0.5);font-family:inherit;';
      document.body.appendChild(panel);
    }
    const total = segments.filter(s => s.veoPrompt?.trim()).length;
    const done  = segments.filter(s => s.veoPrompt?.trim() && s.done).length;
    const wasMinimized = panel.dataset.minimized === '1';
    panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <span style="font-size:11px;font-weight:700;color:var(--text-1);">🎬 Scene Progress</span>
        <div style="display:flex;gap:4px;align-items:center;">
          <button id="statusPanelMinBtn" onclick="toggleStatusPanel()" title="Minimize" style="background:none;border:none;color:rgba(156,163,175,0.7);cursor:pointer;font-size:11px;padding:2px 6px;">${wasMinimized ? '▲' : '▼'}</button>
          <button onclick="dismissStatusPanel()" title="Dismiss — clears the saved run" style="background:none;border:none;color:var(--text-3);cursor:pointer;font-size:14px;line-height:1;padding:0 2px;">✕</button>
        </div>
      </div>
      <div id="statusPanelBody" style="${wasMinimized ? 'display:none;' : ''}">
        <div style="display:flex;flex-direction:column;gap:4px;">
          ${segments.filter(s => s.veoPrompt?.trim()).map((seg, idx) => {
            const globalIdx = segments.indexOf(seg);
            const statusIcon = seg.done ? '✅' : '⏳';
            const statusColor = seg.done ? '#4ade80' : 'var(--text-3)';
            return `<div style="display:flex;align-items:center;gap:6px;font-size:10px;">
              <span>${statusIcon}</span>
              <span style="color:${statusColor};">Scene ${globalIdx + 1}</span>
              ${seg.done ? '<span style="color:#4ade80;font-size:9px;margin-left:auto;">Done</span>' : ''}
            </div>`;
          }).join('')}
        </div>
        <div style="margin-top:8px;padding-top:6px;border-top:1px solid var(--border);font-size:10px;color:var(--text-3);">${done} / ${total} complete</div>
        <div style="margin-top:6px;background:var(--surface-2);border-radius:3px;height:4px;overflow:hidden;">
          <div style="width:${total>0?Math.round(done/total*100):0}%;height:100%;background:var(--success);border-radius:3px;transition:width 0.4s;"></div>
        </div>
      </div>`;
    // Persist that a run is active for this project so the panel survives a
    // reload / app restart until the user dismisses it.
    DB.set(modeKey('sm_active_run'), JSON.stringify({ projectId: activeProjectId })).catch(() => {});
    return panel;
  }

  // Minimize / restore the status panel body.
  function toggleStatusPanel() {
    const panel = document.getElementById('sceneStatusPanel');
    if (!panel) return;
    const body = document.getElementById('statusPanelBody');
    const btn = document.getElementById('statusPanelMinBtn');
    if (!body) return;
    const isMin = body.style.display === 'none';
    body.style.display = isMin ? '' : 'none';
    panel.dataset.minimized = isMin ? '0' : '1';
    if (btn) btn.textContent = isMin ? '▼' : '▲';
  }

  // Dismiss the status panel AND clear the persisted run marker.
  function dismissStatusPanel() {
    const p = document.getElementById('sceneStatusPanel');
    if (p) p.remove();
    DB.remove(modeKey('sm_active_run')).catch(() => {});
  }

  // On load (and after a mode switch), re-show the status panel if the active
  // project has a run in progress that was never dismissed.
  async function restoreActiveRun() {
    const existing = document.getElementById('sceneStatusPanel');
    if (existing) existing.remove();
    try {
      const raw = await DB.get(modeKey('sm_active_run'));
      if (!raw) return;
      const run = JSON.parse(raw);
      if (run && run.projectId === activeProjectId &&
          segments.some(s => s.veoPrompt && s.veoPrompt.trim())) {
        showStatusPanel();
      }
    } catch (e) { /* ignore */ }
  }

  // ── Mark a scene done (called by Claude via javascript_tool) ──────────────
  window.markSceneDone = function(i) {
    if (!segments[i]) return;
    segments[i].done = true;
    debounceSave();
    const card = document.getElementById('seg-card-' + i);
    if (card) {
      const badge = card.querySelector('.scene-done-badge');
      if (badge) { badge.style.display = ''; }
    }
    // Update live status panel if open
    const panel = document.getElementById('sceneStatusPanel');
    if (panel) showStatusPanel();
    console.log('[markSceneDone] Scene', i + 1, 'marked complete');
  };

  // ── Build Veo 3 prompt from NB Pro image (GPT-4o vision) ─────────────────
  async function buildVeo3FromNBImage(i) {
    const seg = segments[i];
    if (!seg || !seg.nbPreviewDataUrl) return false;
    const apiKey = getApiKey();
    if (!apiKey) return false;

    const script = seg.script || '';
    const action = seg.action || '';
    const total  = segments.length;

    // Two-person speaker context — derived from person-detection auto-fill or manual targeting
    const isTwoPerson = !!(seg.targetPerson);
    const speakerSide   = isTwoPerson ? (seg.targetPerson || 'left').toUpperCase() : '';
    const speakerGender = isTwoPerson ? (seg.targetGender || 'person') : '';
    const listenerSide  = speakerSide === 'LEFT' ? 'RIGHT' : 'LEFT';

    try {
      const res = await _fetchWithRetry('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o',
          temperature: 0.4,
          messages: [{
            role: 'user',
            content: [
              {
                type: 'text',
                text: `You are writing a Veo 3 video generation prompt. The attached image is the STARTING FRAME for this video clip — Scene ${i + 1} of ${total}.

Your job: write a precise Veo 3 JSON prompt that animates this exact frame into an 8-second talking-head video. Look carefully at the image and describe what is in it accurately.

Script the person says (word for word): "${script}"
${action ? 'Presenter action: ' + action : ''}

Return ONLY a valid JSON object with these fields:
- action: STEP 1 — Before writing anything, mentally list every physical object visible in the attached starting frame (products, containers, tools, bottles, pads, cloths — anything on the surface or in the person's hands). STEP 2 — If reference motion was provided above, check each prop interaction in it against your list. If the reference describes using an object that is NOT visible in this frame (e.g. pouring water when no glass/pitcher is visible, using a bowl when no bowl is present), EXCLUDE that interaction entirely and replace it with a natural gesture the person can perform without touching any new object (nod, look at camera, expressive hand gesture near face, etc.). STEP 3 — Write the final action field using ONLY movements and prop interactions involving objects confirmed visible in the starting frame. Do NOT use "left" or "right" — use "one hand", "the other hand", "both hands", or camera-relative terms.
- speech: the exact script text, verbatim
- starting_frame: describe the person's position, clothing, and pose only — do NOT describe props or background here
- background: describe the exact background setting visible in the image (wall color, any art/decor, distance). End with: "Background is locked — do not alter, move, or add any elements."
- foreground_props: list EVERY object on the surface/table with its exact position (e.g. "white jar — center-left, label facing camera"). Note any visible product labels or text and state they must remain legible and unchanged. End with: "All props are locked in place — do not move, add, remove, or rearrange any object. All product labels and text must remain sharp, legible, and identical throughout the clip."
- camera: "static handheld, slight natural movement, medium close-up to close-up, vertical 9:16"
- audio: "${getVoiceStyle() ? getVoiceStyle() + ' voice tone, ' : ''}clear natural voice, slight ambient room tone, no music"
- duration: MUST be exactly "6 seconds" or "8 seconds" — no other values are valid. Choose 8 if the speech takes longer than 7 seconds to say at a natural pace, otherwise choose 6.
- negative_prompt: if the frame shows TWO people, do NOT include "multiple people" — instead use "flipped composition, mirrored subjects, solo person, disappeared person, rearranged props, moved objects, changed table contents, new objects added, missing objects, changed background, different lighting, inconsistent set, cuts, transitions, text overlays, subtitles, watermarks, AI artifacts, morphing text, blurry label, illegible text, distorted letters, warped label, changing text, shifting words". If single person, use "multiple people, rearranged props, moved objects, changed table contents, new objects added, missing objects, changed background, inconsistent set, different lighting, cuts, transitions, text overlays, subtitles, watermarks, AI artifacts, morphing text, blurry label, illegible text, distorted letters, warped label, changing text, shifting words". ALWAYS include the label-preservation terms — they prevent product text from morphing.
${isTwoPerson ? `
TWO-PERSON COMPOSITION — CRITICAL SPEAKER RULES:
• The ${speakerGender} on the ${speakerSide} is the SPEAKER (the avatar). Their mouth moves, they deliver every word of the speech field, and they are the focal subject throughout.
• The person on the ${listenerSide} is the LISTENER. They do NOT speak. They react, nod, smile, or listen — no mouth movement for speech.
• Start the action field with exactly this phrase: "The ${speakerGender} on the ${speakerSide} speaks —" and then describe their gestures and actions. Then describe the listener's reaction on a separate beat.
• LEFT means the person on the viewer's left side of the frame. RIGHT means the person on the viewer's right. Do NOT swap or move either person at any point in the clip.
• In negative_prompt: include "composition flip, swapped positions, wrong speaker, silent avatar, listener speaking, mirrored subjects" — do NOT include "multiple people".` : `- IMPORTANT for TWO-PERSON frames: in the action field, always specify which person is on the LEFT and which is on the RIGHT. Use explicit left/right anchoring so Veo 3 does not flip the composition.`}

No markdown. Return only the JSON object.`
              },
              { type: 'image_url', image_url: { url: seg.nbPreviewDataUrl, detail: 'high' } }
            ]
          }]
        })
      });
      if (!res.ok) { console.warn('[buildVeo3FromNBImage] HTTP', res.status, '— seg', i); return false; }
      const data = await res.json();
      let raw = (data.choices?.[0]?.message?.content || '').trim();
      raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
      // Guard: model returned a refusal / plain-text instead of JSON
      if (!raw.startsWith('{')) {
        console.warn('[buildVeo3FromNBImage] model returned non-JSON for seg', i, '— skipping. Response:', raw.slice(0, 120));
        return false;
      }
      // Validate it's parseable JSON
      const _parsed = JSON.parse(raw);
      if (_parsed.action) {
        if (isTwoPerson) {
          // Two-person scenes: keep left/right anchors — they are compositional, not hand-directions.
          // Just strip hand-specific directional words but preserve positional "on the LEFT/RIGHT" phrases.
          _parsed.action = _parsed.action
            .replace(/\bright\s+hand\b/gi, 'one hand')
            .replace(/\bleft\s+hand\b/gi, 'the other hand')
            .replace(/\bright\s+arm\b/gi, 'one arm')
            .replace(/\bleft\s+arm\b/gi, 'the other arm');
          // Ensure the action opens with the speaker tag so Veo 3 can't mis-attribute the speech
          const speakerTag = 'The ' + speakerGender + ' on the ' + speakerSide + ' speaks';
          if (!_parsed.action.toLowerCase().startsWith('the ' + speakerGender.toLowerCase() + ' on the ' + speakerSide.toLowerCase())) {
            _parsed.action = speakerTag + ' — ' + _parsed.action;
          }
          // Ensure negative_prompt includes composition-lock terms
          if (_parsed.negative_prompt) {
            const compLock = 'composition flip, swapped positions, wrong speaker, silent avatar, listener speaking, mirrored subjects';
            if (!_parsed.negative_prompt.includes('composition flip')) {
              _parsed.negative_prompt = _parsed.negative_prompt.replace(/\bmultiple people[,]?\s*/gi, '').trim();
              _parsed.negative_prompt = compLock + ', ' + _parsed.negative_prompt;
            }
          }
          // Explicit speaker field — tells the Flow agent which person delivers the speech
          // so Veo 3 can correctly assign lip-sync and animation to the right character.
          _parsed.speaker = speakerGender + ' on the ' + speakerSide;
        } else {
          _parsed.action = sanitizeDirections(_parsed.action);
        }
      }
      if (!_parsed.speech || _parsed.speech === 'null' || !String(_parsed.speech).trim()) {
        _parsed.speech = seg.script || '';
      }
      // Always enforce duration — must be exactly 6s or 8s (Veo 3 only supports these two)
      {
        const _wc = String(_parsed.speech || seg.script || '').split(/\s+/).filter(Boolean).length;
        const _fallback = (_wc / WORDS_PER_SEC > 7 ? 8 : 6) + ' seconds';
        if (!_parsed.duration) {
          _parsed.duration = _fallback;
        } else {
          // Snap whatever GPT returned to exactly 6 or 8
          const _n = parseInt(_parsed.duration, 10);
          _parsed.duration = (!isNaN(_n) && _n > 7 ? 8 : 6) + ' seconds';
        }
      }
      raw = JSON.stringify(_parsed, null, 2);
      seg.veoPrompt = raw;
      // Update the textarea in place
      const ta = document.getElementById('veo-seg-' + i);
      if (ta) { ta.value = raw; autoGrow(ta); }
      return true;
    } catch(e) { console.warn('buildVeo3FromNBImage failed:', e); return false; }
  }

  // ── NB Pro preview upload / clear ────────────────────────────────────────
  function onNbPreviewChange(i, input) {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async ev => {
      try {
        if (i >= segments.length) return;
        segments[i].nbPreviewDataUrl = ev.target.result;
        debounceSave();
        const zone = document.getElementById('nbpreview-zone-' + i);
        if (zone) { const _zi = document.createElement('img'); _zi.src = ev.target.result; _zi.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:2px;'; zone.innerHTML = ''; zone.appendChild(_zi); }
        // Auto-generate Veo 3 prompt from the uploaded NB image
        const veoTa = document.getElementById('veo-seg-' + i);
        if (veoTa) { veoTa.value = '⏳ Building Veo 3 prompt from image…'; }
        let ok = false;
        try { ok = await buildVeo3FromNBImage(i); } catch (_) {}
        if (!ok && veoTa) {
          // Fall back to text-based prompt if vision call fails
          const setting = document.getElementById('studioSetting')?.value.trim() || '';
          const productSel = document.getElementById('studioProduct');
          const productName = productSel ? (productSel.options[productSel.selectedIndex]?.text || '') : '';
          segments[i].veoPrompt = buildSegmentVeo3Prompt(i, segments[i].startTime, segments[i].endTime, segments[i].script, setting, productName, bgImageDataUrl);
          if (veoTa) { veoTa.value = segments[i].veoPrompt; autoGrow(veoTa); }
        }
        debounceSave();
      } catch (err) {
        console.error('onNbPreviewChange error:', err);
        const veoTa = document.getElementById('veo-seg-' + i);
        if (veoTa && veoTa.value.startsWith('⏳')) {
          // Fall back to text-based prompt so the textarea is never left blank
          const setting = document.getElementById('studioSetting')?.value.trim() || '';
          const productSel = document.getElementById('studioProduct');
          const productName = productSel ? (productSel.options[productSel.selectedIndex]?.text || '') : '';
          if (segments[i]) {
            segments[i].veoPrompt = buildSegmentVeo3Prompt(i, segments[i].startTime, segments[i].endTime, segments[i].script, setting, productName, bgImageDataUrl);
            veoTa.value = segments[i].veoPrompt;
            autoGrow(veoTa);
          } else {
            veoTa.value = '';
          }
        }
        showToast('Image processing failed — please try uploading again.', 'error');
      }
    };
    reader.onerror = () => {
      const veoTa = document.getElementById('veo-seg-' + i);
      if (veoTa && veoTa.value.startsWith('⏳')) veoTa.value = '';
      showToast('Could not read image file — please try again.', 'error');
    };
    reader.readAsDataURL(file);
  }

  function clearNbPreview(i) {
    if (!segments[i]) return;
    segments[i].nbPreviewDataUrl = null;
    debounceSave();
    renderSegments();
  }

  // ── Bulk NB composite upload — assigns files to segments in sorted filename order ──────
  async function bulkNbCompositeUpload(files) {
    if (!files || files.length === 0) return;
    // Sort by filename so Photo-02-scene-01, Photo-02-scene-02 etc. stay in order
    const sorted = Array.from(files).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    // Target only segments that have a scene frame (same as what the ZIP contains)
    const frameSegs = segments.map((s, i) => ({ s, i })).filter(({ s }) => s.frameDataUrl);
    if (sorted.length > frameSegs.length) {
      showToast(`${sorted.length} files selected but only ${frameSegs.length} segment${frameSegs.length !== 1 ? 's' : ''} have frames — extra files ignored.`, 'warning', 4000);
    }
    const assignCount = Math.min(sorted.length, frameSegs.length);
    showToast(`Uploading ${assignCount} composite${assignCount !== 1 ? 's' : ''}…`, 'info', 2500);
    let done = 0;
    for (let j = 0; j < assignCount; j++) {
      const { i } = frameSegs[j];
      const file = sorted[j];
      await new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = async ev => {
          try {
            if (i >= segments.length) { resolve(); return; }
            segments[i].nbPreviewDataUrl = ev.target.result;
            debounceSave();
            const zone = document.getElementById('nbpreview-zone-' + i);
            if (zone) { const _img = document.createElement('img'); _img.src = ev.target.result; _img.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:2px;'; zone.innerHTML = ''; zone.appendChild(_img); }
            // Auto-generate Veo 3 prompt from the uploaded NB composite
            const veoTa = document.getElementById('veo-seg-' + i);
            if (veoTa) veoTa.value = '⏳ Building Veo 3 prompt…';
            let ok = false;
            try { ok = await buildVeo3FromNBImage(i); } catch(_) {}
            if (!ok && veoTa) {
              const setting = document.getElementById('studioSetting')?.value.trim() || '';
              const productSel = document.getElementById('studioProduct');
              const productName = productSel ? (productSel.options[productSel.selectedIndex]?.text || '') : '';
              if (segments[i]) {
                segments[i].veoPrompt = buildSegmentVeo3Prompt(i, segments[i].startTime, segments[i].endTime, segments[i].script, setting, productName, bgImageDataUrl);
                veoTa.value = segments[i].veoPrompt; autoGrow(veoTa);
              }
            }
            done++;
          } catch(err) {
            console.warn('bulkNbCompositeUpload error seg', i, err);
          }
          resolve();
        };
        reader.onerror = () => resolve();
        reader.readAsDataURL(file);
      });
    }
    debounceSave();
    showToast(`✅ ${done} composite${done !== 1 ? 's' : ''} uploaded — Veo 3 prompts generated.`, 'success', 5000);
  }

  // ─── Shotless segment generator — GPT invents shot list from script ──────────
  async function generateShotlessSegments() {
    const apiKey = getApiKey();
    if (!apiKey) { showToast('Add your API key in Settings first.', 'error'); return; }
    const script = (document.getElementById('shotlessScript')?.value || '').trim();
    if (!script) { showToast('Paste your script first.', 'warning'); return; }
    const productName = (document.getElementById('shotlessProduct')?.value || '').trim() || 'the product';
    const segCount = Math.min(10, Math.max(2, parseInt(document.getElementById('shotlessCount')?.value || '4', 10) || 4));
    const settingDesc = (document.getElementById('shotlessSetting')?.value || '').trim();

    const btn = document.getElementById('shotlessGenBtn');
    if (btn) { btn.textContent = '⏳ Generating shot list…'; btn.disabled = true; }

    try {
      const res = await _fetchWithRetry('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o',
          temperature: 0.7,
          max_tokens: 1800,
          messages: [{
            role: 'user',
            content: `You are a professional social media video producer. Create a ${segCount}-scene shot list for a product advertisement.

PRODUCT: ${productName}
SETTING: ${settingDesc || "the presenter's natural environment (match the avatar photo)"}
FULL SCRIPT:
"${script}"

Divide the script into exactly ${segCount} natural segments. For each, design what the presenter does while speaking.

Return ONLY a valid JSON array with exactly ${segCount} objects:
[
  {
    "script": "exact contiguous words for this segment — no skips, no overlaps with other segments",
    "action": "specific physical action — e.g. 'holds bottle label-forward at chest height with both hands', 'pours two scoops of green powder into glass bowl, camera at table level'",
    "shot_type": "medium_shot" or "close_up" or "extreme_close_up" or "hands_only",
    "scene_description": "complete visual scene for image generation: what props are on the table, where the presenter stands, what is in foreground vs background, lighting quality, camera angle"
  }
]

Production rules:
- The script fields must together cover every word of the FULL script exactly — no gaps
- Scene 1 (hook): attention-grabbing — direct eye contact, product reveal, or bold opening. Shot: medium_shot or close_up
- Demo scenes: realistic product usage — mixing, applying, dispensing, holding, demonstrating. Vary shot types
- Final scene (CTA): product prominently visible with label showing, presenter confident. Shot: close_up or extreme_close_up
- Actions must work as a SINGLE still image that Veo 3 will then animate for ~8 seconds
- Name props specifically (glass bowl, wooden spoon, dropper bottle) — never "some items"
- Return ONLY the JSON array, no explanation or markdown`
          }]
        })
      });

      let data;
      try { data = await res.json(); } catch(_) { data = {}; }
      if (!res.ok || data.error) {
        const msg = data?.error?.message || 'API error ' + res.status;
        showToast('Shot list generation failed: ' + msg, 'error');
        if (btn) { btn.textContent = '✨ Generate Shot List'; btn.disabled = false; }
        return;
      }

      let raw = (data.choices?.[0]?.message?.content || '').trim();
      raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
      let shots;
      try { shots = JSON.parse(raw); } catch(_) {
        showToast('Shot list parse failed — try again.', 'error');
        if (btn) { btn.textContent = '✨ Generate Shot List'; btn.disabled = false; }
        return;
      }
      if (!Array.isArray(shots) || shots.length === 0) {
        showToast('No scenes returned — try again.', 'error');
        if (btn) { btn.textContent = '✨ Generate Shot List'; btn.disabled = false; }
        return;
      }

      // Build segments — estimate timing from word count (~3 words/sec spoken)
      let timeAccum = 0;
      const newSegs = shots.map((shot, idx) => {
        const wordCount = (shot.script || '').split(/\s+/).filter(Boolean).length;
        const duration = Math.max(4, Math.round((wordCount / 3) * 10) / 10);
        const startTime = timeAccum;
        timeAccum += duration;
        return {
          startTime,
          endTime: timeAccum,
          script: shot.script || '',
          action: shot.action || '',
          sceneNotes: shot.scene_description || '',
          nbPrompt: '',
          nbEndPrompt: '',
          nbPreviewDataUrl: null,
          veoPrompt: '',
          frameDataUrl: null,       // no reference frame — shotless
          frameDesc: '',
          _scriptOnly: false,
          done: false,
          isCTA: idx === shots.length - 1, // mark last scene as CTA
          ctaProductName: productName,
          targetPerson: null, targetGender: null, targetX: null, targetY: null,
          _shotlessData: shot       // preserve shot data for NB prompt building
        };
      });

      pushUndo('Shotless Generate');
      segments = newSegs;

      // Build NB prompts for every segment immediately
      segments.forEach((seg, i) => {
        const nb = buildShotlessNBPrompt(i, seg._shotlessData);
        if (nb) seg.nbPrompt = nb;
      });

      saveSegments();
      renderSegments();
      document.getElementById('shotlessModal')?.remove();

      const nbCount = segments.filter(s => s.nbPrompt).length;
      showToast('✅ ' + shots.length + ' scenes generated — ' + nbCount + ' NB prompts ready. Run NB Pro and upload your composites.', 'success', 7000);

    } catch(e) {
      console.warn('generateShotlessSegments error:', e);
      showToast('Shot list generation failed — please try again.', 'error');
    } finally {
      if (btn) { btn.textContent = '✨ Generate Shot List'; btn.disabled = false; }
    }
  }

  // ── Toggle all Veo 3 prompts visible / hidden ────────────────────────────
  function setVeoModel(model) {
    const s = getAdminSettings();
    s.defaultModel = model;
    saveAdminSettings(s);
    _syncVeoModelToggle(model);
  }

  function _syncVeoModelToggle(model) {
    const fastBtn = document.getElementById('veoModelFastBtn');
    const liteBtn = document.getElementById('veoModelLiteBtn');
    const qualBtn = document.getElementById('veoModelQualBtn');
    if (!fastBtn || !qualBtn) return;
    const isFast  = model === 'Veo 3.1 Fast';
    const isLite  = model === 'Veo 3.1 Lite';
    const isQual  = model === 'Veo 3.1 Standard';
    fastBtn.style.background = isFast ? 'rgba(34,197,94,0.18)'  : 'var(--surface)';
    fastBtn.style.color      = isFast ? '#4ade80'               : 'var(--text-3)';
    if (liteBtn) {
      liteBtn.style.background = isLite ? 'rgba(96,165,250,0.18)' : 'var(--surface)';
      liteBtn.style.color      = isLite ? '#60a5fa'               : 'var(--text-3)';
    }
    qualBtn.style.background = isQual ? 'rgba(251,191,36,0.15)' : 'var(--surface)';
    qualBtn.style.color      = isQual ? '#fbbf24'               : 'var(--text-3)';
  }

  function toggleAllPrompts() {
    const btn = document.getElementById('togglePromptsBtn');
    const sections = document.querySelectorAll('[id^="veo-wrap-"]');
    const anyHidden = Array.from(sections).some(el => el.style.display === 'none' || getComputedStyle(el).display === 'none');
    sections.forEach(el => { el.style.display = anyHidden ? '' : 'none'; });
    if (btn) btn.textContent = anyHidden ? '👁 Hide Prompts' : '👁 Reveal Prompts';
  }

  // ── Toggle Veo 3 prompt visibility ───────────────────────────────────────
  function toggleVeoPrompt(i) {
    const wrap = document.getElementById('veo-wrap-' + i);
    const btn  = document.getElementById('veo-toggle-' + i);
    if (!wrap) return;
    const hidden = wrap.style.display === 'none';
    wrap.style.display = hidden ? '' : 'none';
    if (btn) btn.innerHTML = hidden
      ? '<i class="ti ti-eye-off"></i>'
      : '<i class="ti ti-eye"></i>';
    if (btn) btn.title = hidden ? 'Hide prompt' : 'Show prompt';
  }

  // ── Step progress strip ───────────────────────────────────────────────────
  function updateStepProgress() {
    const DONE   = '#4ade80'; // green — step complete
    const ACTIVE = 'var(--accent-2)'; // purple — current step (next to do)
    const DIM    = 'var(--text-3)'; // grey — not yet reached

    if (studioMode === 'replicator') {
      const hasVideo    = !!(refVideoFile || (document.getElementById('refVideoEl')?.src || '').length > 10);
      const hasCuts     = segments.length > 0;
      const hasTranscript = whisperSegments && whisperSegments.length > 0;
      const hasPrompts  = hasCuts && segments.some(s => s.veoPrompt && s.veoPrompt.trim());

      const s = (id, done, active) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.style.color = done ? DONE : active ? ACTIVE : DIM;
        // prepend ✓ on done, remove it on not-done
        const label = el.textContent.replace(/^✓\s*/, '');
        el.textContent = done ? '✓ ' + label : label;
      };

      s('rep-step-1', hasVideo,      !hasVideo);
      s('rep-step-2', hasCuts,       hasVideo && !hasCuts);
      s('rep-step-3', hasTranscript, hasCuts && !hasTranscript);
      s('rep-step-4', hasPrompts,    hasCuts && !hasPrompts);

    } else if (studioMode === 'producer') {
      const hasScript   = !!(document.getElementById('originalScript')?.value.trim());
      const hasCuts     = segments.length > 0;
      const hasDesc     = hasCuts && segments.some(s => s.action && s.action.trim());
      const hasNB       = hasCuts && segments.some(s => s.nbPrompt && s.nbPrompt.trim());
      const hasPrompts  = hasCuts && segments.some(s => s.veoPrompt && s.veoPrompt.trim());

      const s = (id, done, active) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.style.color = done ? DONE : active ? ACTIVE : DIM;
        const label = el.textContent.replace(/^✓\s*/, '');
        el.textContent = done ? '✓ ' + label : label;
      };

      s('pro-step-1', hasScript,  !hasScript);
      s('pro-step-2', hasCuts,    hasScript && !hasCuts);
      s('pro-step-3', hasDesc,    hasCuts && !hasDesc);
      s('pro-step-4', hasNB,      hasDesc && !hasNB);
      s('pro-step-5', hasPrompts, hasNB && !hasPrompts);
    }
  }

  // ── Frame lightbox ────────────────────────────────────────────────────────
  function openLightbox(src) {
    const lb  = document.getElementById('frameLightbox');
    const img = document.getElementById('frameLightboxImg');
    if (!lb || !img) return;
    img.src = src;
    lb.classList.add('open');
    // Remove first to prevent stacking if called multiple times
    document.removeEventListener('keydown', _lbKeyClose);
    document.addEventListener('keydown', _lbKeyClose);
  }
  function closeLightbox() {
    const lb = document.getElementById('frameLightbox');
    if (lb) lb.classList.remove('open');
    document.removeEventListener('keydown', _lbKeyClose);
  }
  function _lbKeyClose(e) { if (e.key === 'Escape') closeLightbox(); }

  // ── Left column collapse / expand ────────────────────────────────────────
  function toggleLeftCol() {
    const layout = document.getElementById('vsLayout');
    const btn    = document.getElementById('leftColToggleBtn');
    if (!layout) return;
    const collapsed = layout.classList.toggle('left-collapsed');
    localStorage.setItem('vs_leftcol_collapsed', collapsed ? '1' : '');
    if (btn) { btn.textContent = collapsed ? '›' : '‹'; btn.title = collapsed ? 'Show left panel' : 'Hide left panel'; }
    // Show/hide the producer-mode Settings button row
    const settingsRow = document.getElementById('vsSettingsToggleRow');
    if (settingsRow) settingsRow.style.display = collapsed ? 'flex' : 'none';
  }

  // ── Video player mini / expand / collapse toggle ─────────────────────────
  function setVideoMini(mini) {
    // setVideoMini(true) now fully collapses the panel to header-only
    const panel = document.getElementById('vsPanelRefVideo');
    const btn   = document.getElementById('videoMiniToggleBtn');
    if (!panel) return;
    if (mini) {
      panel.classList.remove('video-mini');
      panel.classList.add('video-collapsed');
      if (btn) { btn.textContent = '▼ Show Video'; btn.title = 'Expand video player'; }
    } else {
      panel.classList.remove('video-mini');
      panel.classList.remove('video-collapsed');
      if (btn) { btn.textContent = '▲ Collapse'; btn.title = 'Collapse video player'; }
    }
  }
  function toggleVideoMini() {
    const panel = document.getElementById('vsPanelRefVideo');
    if (!panel) return;
    setVideoMini(!panel.classList.contains('video-collapsed'));
  }
  // Alias used by the header button
  function toggleVideoCollapsed() { toggleVideoMini(); }
  // Show toggle button whenever a video is loaded
  function showVideoMiniBtn(show) {
    const btn = document.getElementById('videoMiniToggleBtn');
    if (btn) btn.style.display = show ? '' : 'none';
  }

  // ── More-menu open / close ────────────────────────────────────────────────
  function toggleVsMoreMenu(btn) {
    const menu = document.getElementById('vsMoreMenu');
    if (!menu) return;
    const isOpen = menu.classList.contains('open');
    if (isOpen) {
      menu.classList.remove('open');
      // Clean up any orphaned outside-click handler
      if (toggleVsMoreMenu._closeHandler) {
        document.removeEventListener('click', toggleVsMoreMenu._closeHandler);
        toggleVsMoreMenu._closeHandler = null;
      }
    } else {
      menu.classList.add('open');
      // Remove previous handler before adding a new one
      if (toggleVsMoreMenu._closeHandler) {
        document.removeEventListener('click', toggleVsMoreMenu._closeHandler);
      }
      setTimeout(() => {
        toggleVsMoreMenu._closeHandler = function(e) {
          if (!menu.contains(e.target) && e.target !== btn) {
            menu.classList.remove('open');
            document.removeEventListener('click', toggleVsMoreMenu._closeHandler);
            toggleVsMoreMenu._closeHandler = null;
          }
        };
        document.addEventListener('click', toggleVsMoreMenu._closeHandler);
      }, 0);
    }
  }
  function closeVsMoreMenu() {
    const menu = document.getElementById('vsMoreMenu');
    if (menu) menu.classList.remove('open');
    if (toggleVsMoreMenu._closeHandler) {
      document.removeEventListener('click', toggleVsMoreMenu._closeHandler);
      toggleVsMoreMenu._closeHandler = null;
    }
  }

  // ── One-click Redo Scene (copies single-scene instruction) ────────────────
  function redoScene(i) {
    if (i < 0 || i >= segments.length || !segments[i]) return;
    segments[i].done = false;
    debounceSave();
    renderSegments();
    copyClaudeInstruction(i);
  }

  // ── Credit cost estimator ─────────────────────────────────────────────────
  function estimateCredits(segsToRun) {
    // Veo 3 Fast: ~2 credits/second. NB Pro: ~1 credit per generation.
    let total = 0;
    segsToRun.forEach(seg => {
      const dur = getVeoDuration(seg.script);
      total += dur * 2; // Veo 3
      total += 1;       // NB Pro
    });
    return total;
  }

  // ── Pre-flight gate — per-segment readiness + cost before a run ───────────
  // Aggregates the checks (script length, Veo JSON lint, NB prompt, frame) into
  // one screen so problems get caught while they are still free to fix —
  // before any Veo credits are spent inside Flow.
  function showPreflightModal(skipDone) {
    document.querySelectorAll('.preflight-modal').forEach(m => m.remove());
    if (segments.length === 0) {
      showToast('No segments yet — split a video or script into scenes first.', 'warning');
      return;
    }
    let readyCount = 0, issueCount = 0, skipCount = 0, totalCredits = 0;
    const rows = segments.map((seg, i) => {
      const isSkipped = skipDone && seg.done;
      const sh    = scriptHealth(seg);
      const lint  = lintVeoJSON(seg.veoPrompt || '');
      const hasNb = !!(seg.nbPrompt && seg.nbPrompt.trim());
      // In avatar-background mode there is no Photo 2 start frame, so its
      // absence is not a problem.
      const hasFrame = !!seg.frameDataUrl || !!seg._scriptOnly || bgFromAvatar;
      const sceneCredits = seg.script?.trim() ? getVeoDuration(seg.script) * 2 + 1 : 0;
      const blockers = [];
      if (sh.level === 'empty' || sh.level === 'short' || sh.level === 'over') blockers.push('script ' + sh.level);
      if (!lint.ok) blockers.push('Veo JSON: ' + lint.errors.join(', '));
      if (!hasNb) blockers.push('no NB prompt');
      if (!hasFrame) blockers.push('no start frame');
      const warns = [];
      if (sh.level === 'long') warns.push('script long (~' + sh.estSec.toFixed(1) + 's)');
      let status, color, label;
      // totalCredits counts only scenes that will actually run cleanly
      // (ready + warn) — issue scenes are not costed since they need fixing.
      if (isSkipped) { status = 'skip'; color = 'var(--text-3)'; label = 'skip (done)'; skipCount++; }
      else if (blockers.length) { status = 'issue'; color = '#f87171'; label = blockers.join(' · '); issueCount++; }
      else if (warns.length) { status = 'warn'; color = '#fbbf24'; label = warns.join(' · '); readyCount++; totalCredits += sceneCredits; }
      else { status = 'ready'; color = '#4ade80'; label = 'ready'; readyCount++; totalCredits += sceneCredits; }
      const icon = status === 'ready' ? '✅' : status === 'warn' ? '⚠️' : status === 'skip' ? '⏭️' : '❌';
      return `<div style="display:flex;align-items:center;gap:8px;font-size:10px;padding:4px 0;border-bottom:1px solid var(--border);">
        <span>${icon}</span>
        <span style="font-weight:700;color:var(--text-2);white-space:nowrap;">Scene ${i + 1}</span>
        <span style="color:${color};flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(label)}</span>
        <span style="color:var(--text-3);white-space:nowrap;">${isSkipped ? '—' : '~' + sceneCredits + ' cr'}</span>
      </div>`;
    }).join('');

    const hasIssues = issueCount > 0;
    const runnable = readyCount > 0;
    const modal = document.createElement('div');
    modal.className = 'preflight-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(6,6,10,0.74);z-index:9999;display:flex;align-items:center;justify-content:center;';
    modal.innerHTML = `
      <div style="background:var(--glass);backdrop-filter:blur(24px) saturate(160%);-webkit-backdrop-filter:blur(24px) saturate(160%);border:1px solid var(--glass-border);border-radius:14px;padding:22px;width:520px;max-width:94vw;max-height:86vh;display:flex;flex-direction:column;box-shadow:var(--shadow-panel);font-family:inherit;">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;">
          <div style="font-size:20px;">🛫</div>
          <div>
            <div style="font-size:14px;font-weight:700;color:var(--text-1);">Pre-flight Check${skipDone ? ' (Resume)' : ''}</div>
            <div style="font-size:11px;color:var(--text-3);">${readyCount} ready${issueCount ? ' · ' + issueCount + ' with issues' : ''}${skipCount ? ' · ' + skipCount + ' skipped' : ''}</div>
          </div>
        </div>
        <div style="flex:1;overflow-y:auto;margin-bottom:12px;border:1px solid var(--border);border-radius:8px;padding:4px 10px;background:var(--bg);">${rows}</div>
        <div style="display:flex;gap:8px;margin-bottom:14px;">
          <div style="flex:1;background:var(--grad-accent-soft);border:1px solid rgba(139,92,246,0.25);border-radius:8px;padding:8px 12px;">
            <div style="font-size:15px;font-weight:800;color:var(--accent-2);">~${totalCredits} credits</div>
            <div style="font-size:9px;color:var(--text-3);">${readyCount} scene${readyCount !== 1 ? 's' : ''} × (Veo 3 + NB Pro)</div>
          </div>
          <div style="flex:1;background:${hasIssues ? 'rgba(248,113,113,0.07)' : 'rgba(74,222,128,0.07)'};border:1px solid ${hasIssues ? 'rgba(248,113,113,0.25)' : 'rgba(74,222,128,0.25)'};border-radius:8px;padding:8px 12px;">
            <div style="font-size:12px;font-weight:700;color:${hasIssues ? '#f87171' : '#4ade80'};">${hasIssues ? issueCount + ' need fixing' : 'All clear'}</div>
            <div style="font-size:9px;color:var(--text-3);">${hasIssues ? 'fix in the editor, or run anyway' : 'every scene passed its checks'}</div>
          </div>
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button onclick="this.closest('div[style*=fixed]').remove()" style="padding:8px 16px;background:var(--surface-3);border:1px solid var(--border-2);border-radius:7px;color:var(--text-2);font-weight:600;cursor:pointer;font-size:12px;font-family:inherit;">Cancel</button>
          ${runnable ? `<button onclick="this.closest('div[style*=fixed]').remove();runAllScenes(${skipDone ? 'true' : 'false'}, true)" style="padding:8px 18px;background:${hasIssues ? 'rgba(251,191,36,0.15)' : 'var(--grad-accent)'};border:1px solid ${hasIssues ? 'rgba(251,191,36,0.5)' : 'rgba(167,139,250,0.6)'};border-radius:7px;color:${hasIssues ? 'var(--warning)' : '#fff'};font-weight:700;cursor:pointer;font-size:12px;font-family:inherit;">${hasIssues ? '▶ Run Anyway' : '▶ Run All Scenes'}</button>` : ''}
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  }

  // ── One-button happy path: Analyze video → Generate prompts → Pre-flight ──
  async function processEverything() {
    if (typeof window.requireAccess === 'function' && !window.requireAccess()) return;
    if (segments.length === 0) {
      showToast('No segments yet — upload a video and run Detect Cuts first.', 'warning');
      return;
    }
    const _apiMode = (typeof getGenerateMode === 'function') ? getGenerateMode() === 'api' : true;
    const _confirmMsg = _apiMode
      ? 'Ready to generate? This will analyze your scenes, build prompts, then send all clips to the API automatically. Usually 2–5 minutes.'
      : 'Ready to generate prompts? This will analyze your scenes and prepare everything for manual generation. Usually takes 30–60 seconds.';

    showConfirm(_confirmMsg, async () => {
      pushUndo('Process Everything');
      const btn = document.getElementById('processEverythingBtn');
      const origText = btn ? btn.textContent : '';
      // Count steps: always 2 base + NB step if avatar loaded + Veo step if API mode
      const _hasAvatar = !!window.avatarImageDataUrl;
      const _hasNbStep = _apiMode && _hasAvatar;
      const _totalSteps = _apiMode ? (_hasNbStep ? 4 : 3) : 2;
      const _setStep = (n, label) => {
        if (btn) btn.textContent = `⏳ Step ${n}/${_totalSteps} — ${label}`;
        showToast(`Step ${n} of ${_totalSteps}: ${label}`, 'info', 2000);
      };
      if (btn) { btn.disabled = true; }

      // Step 1 — analyze frames (non-fatal if it fails)
      _setStep(1, 'Analyzing frames…');
      try { await analyzeAllFrames(); } catch (e) { /* non-fatal */ }

      // Step 2 — generate all prompts
      _setStep(2, 'Generating prompts…');
      try {
        await generateAllSegmentPrompts();
      } catch (e) {
        if (btn) { btn.disabled = false; btn.textContent = origText; }
        showToast('Something went wrong — please try again.', 'error');
        return;
      }

      if (!_apiMode) {
        // Manual mode — done after prompts, let user click Step 3
        if (btn) { btn.disabled = false; btn.textContent = origText; }
        const promptCount = segments.filter(s => s.veoPrompt?.trim()).length;
        showToast(`✅ ${promptCount} prompts ready — click Run → to open the agent panel.`, 'success', 5000);
        return;
      }

      // Step 3 (API mode) — Generate NB composite frames if avatar is loaded
      if (_hasNbStep) {
        _setStep(3, 'Generating NB frames…');
        const _nbSegs = segments.filter(s => (s.nbPrompt || '').trim());
        if (_nbSegs.length > 0) {
          try {
            // Generate all NB composites silently (no auto-modal from generateAllNbComposites)
            for (var _ni = 0; _ni < _nbSegs.length; _ni++) {
              var _nIdx = segments.indexOf(_nbSegs[_ni]);
              try { await generateNbComposite(_nIdx); } catch(e) { /* per-segment non-fatal */ }
              if (_ni < _nbSegs.length - 1) await new Promise(r => setTimeout(r, 1200));
            }
          } catch(e) { /* non-fatal — fall through to approval modal */ }
        }
        // Re-enable button and open NB approval modal — user reviews then clicks "Generate Approved"
        if (btn) { btn.disabled = false; btn.textContent = origText; }
        if (typeof openNbApprovalModal === 'function') {
          openNbApprovalModal(true); // true = called from processEverything (API mode)
        } else if (typeof openNBReviewModal === 'function') {
          openNBReviewModal();
        }
        // Stop here — the modal's "Generate Approved" button handles Step 4
        return;
      }

      // Step 3/4 — No NB step, go straight to Veo API generation
      _setStep(_totalSteps, 'Generating clips via API…');
      if (btn) btn.textContent = '⏳ Generating clips…';
      try {
        await generateAllScenesViaAPI();
      } catch (e) {
        // generateAllScenesViaAPI shows its own toasts/modal
      }
      if (btn) { btn.disabled = false; btn.textContent = origText; }
    });
  }

  // ── Run All Scenes — download all images + copy one combined instruction ──
  // preflightDone = true when called from the pre-flight modal, which already
  // showed the user every issue — so the inline confirm() gates are skipped.
  function runAllScenes(skipDone, preflightDone) {
    // Skip gate when called internally from the pre-flight modal (already verified before modal opened)
    if (!preflightDone && typeof window.requireAccess === 'function' && !window.requireAccess()) return;
    const allReady = segments.filter(s => s.veoPrompt?.trim());
    if (!allReady.length) { showToast('Generate prompts first.', 'warning'); return; }

    const ready = skipDone ? allReady.filter(s => !s.done) : allReady;
    if (!ready.length) { showToast('All scenes are already done! Use "Run All Scenes" to re-run them, or click "Redo" on individual scenes.', 'warning'); return; }

    // Declare all variables up front so confirm callbacks can close over them
    const appUrl = window.location.href;
    const _usr = getUserSettings() || {};
    const _adm = getAdminSettings() || {};
    const dlPath = getEffectiveDlPath();
    const claudeBrowserMode = _usr.claudeBrowserMode !== false;
    const nbWaitSec = _adm.nbWaitSec || 180;
    const veoWaitMin = _adm.veoWaitMin || 6;
    const cooldownSec = _adm.cooldownSec || 120;
    const defaultModel = _adm.defaultModel || 'Veo 3.1 Lite';

    // Avatar appearance inventory — embedded into CHECK 1 so the verification is
    // specific to this avatar. Falls back to the generic check when empty.
    const _avInv = (document.getElementById('avatarInventory')?.value || avatarInventory || '').trim();
    const inventoryBlock = _avInv ? `

      ── MATCH AGAINST THE AVATAR INVENTORY ──
      The avatar has these specific details. Check EACH line against the generated
      image and mark PASS / FAIL / UNSURE. Treat any UNSURE as a FAIL.
${_avInv.split(/\r?\n/).map(l => '        ' + l.trim()).filter(l => l.trim()).join('\n')}` : '';

    // ── Confirm gates (run before the main logic, now that all vars are declared) ──
    if (!preflightDone) {
      const unready = segments.filter(s => !s.veoPrompt?.trim() && !(skipDone && s.done));
      if (unready.length) {
        showConfirm(`${unready.length} scene(s) have no prompts yet and will be skipped. Continue?`, () => {
          runAllScenes(skipDone, false); // pass false so the Veo lint check still runs on the next call
        });
        return;
      }
      // ── Veo 3 JSON safety pre-flight ─────────────────────────────────────────
      const lintIssues = [];
      ready.forEach((s) => {
        const idx = segments.indexOf(s);
        const r = lintVeoJSON(s.veoPrompt);
        if (!r.ok) lintIssues.push(`Scene ${idx + 1}: ${r.errors.join(', ')}`);
      });
      if (lintIssues.length) {
        showConfirm(`⚠ ${lintIssues.length} scene(s) have Veo 3 prompt issues. Run anyway?`, () => {
          runAllScenes(skipDone, true);
        });
        return;
      }
    }

    // ── MANUAL MODE: build a simple copy-paste prompt sheet ──────────────────
    if (!claudeBrowserMode) {
      // ── Standard NB Pro + Veo 3 sheet ────────────────────────────────────
      let sheet = `ALL SCENES — MANUAL PROMPT SHEET\nGenerated: ${new Date().toLocaleString()}\n`;
      sheet += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
      if (avatarImageDataUrl) {
        sheet += `📁 Avatar photo: upload directly from this app (Photo 1 — reuse every scene)\n`;
      }
      segments.forEach((seg, gi) => {
        if (!seg.veoPrompt?.trim()) return;
        if (skipDone && seg.done) return;
        if (seg.frameDataUrl) {
          sheet += `• Scene ${gi+1} start frame: upload directly from this app (Photo 2)\n`;
        }
      });
      sheet += `\n`;
      let mn = 0;
      const mt = segments.filter(s => s.veoPrompt?.trim() && !(skipDone && s.done)).length;
      segments.forEach((seg, i) => {
        if (!seg.veoPrompt?.trim()) return;
        if (skipDone && seg.done) return;
        mn++;
        const dur = getVeoDuration(seg.script);
        const wc = (seg.script||'').trim().split(/\s+/).filter(Boolean).length;
        const nbP = seg.nbPrompt || '(no NB Pro prompt)';
        const veoP = seg.veoPrompt || '(no Veo 3 prompt)';
        const hasFrame = !!seg.frameDataUrl && !bgFromAvatar;
        sheet += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nSCENE ${mn} of ${mt}  (App Scene ${i+1})\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
        sheet += `━ NB PRO\n`;
        if (avatarImageDataUrl) sheet += `Photo 1: avatar image from app\n`;
        if (hasFrame) sheet += `Photo 2: scene ${i+1} start frame from app\n`;
        sheet += `Format: 9:16 vertical\n\nNB Pro Prompt:\n${nbP}\n\n`;
        sheet += `━ VEO 3\nModel: ${defaultModel}   Duration: ${dur}s  (${wc} words ≈ ${Math.round(wc/WORDS_PER_SEC)}s)\n\nVeo 3 Prompt:\n${veoP}\n\n`;
      });
      sheet += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nEND — ${mt} scene${mt>1?'s':''} total`;
      navigator.clipboard.writeText(sheet).catch(() => {
        try { const ta=document.createElement('textarea');ta.value=sheet;document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta); } catch(e){}
      });

      // Download all frame images so user can upload them manually to Flow
      let dlDelay = 0;
      const dlInterval = 400; // stagger to avoid browser throttling
      let dlCount = 0;
      if (avatarImageDataUrl) {
        downloadFrameAsFile(avatarImageDataUrl, 'avatar_photo.jpg', dlDelay);
        dlDelay += dlInterval;
        dlCount++;
      }
      segments.forEach((seg, i) => {
        if (!seg.veoPrompt?.trim()) return;
        if (skipDone && seg.done) return;
        if (seg.frameDataUrl && !bgFromAvatar) {
          downloadFrameAsFile(seg.frameDataUrl, `frame_scene_${i+1}.jpg`, dlDelay);
          dlDelay += dlInterval;
          dlCount++;
        }
      });

      const mm = document.createElement('div');
      mm.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9999;display:flex;align-items:center;justify-content:center;';
      mm.innerHTML=`<div style="background:var(--surface);border:1px solid rgba(251,191,36,0.4);border-radius:12px;padding:24px;width:430px;max-width:92vw;box-shadow:0 8px 40px rgba(0,0,0,0.6);font-family:inherit;">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;"><div style="font-size:22px;">📋</div><div>
          <div style="font-size:14px;font-weight:700;color:var(--text-1);">Manual Prompts Copied — ${mt} Scene${mt>1?'s':''}</div>
          <div style="font-size:11px;color:var(--text-3);">Paste into a text editor or directly into Flow</div>
        </div></div>
        <div style="background:rgba(251,191,36,0.07);border:1px solid rgba(251,191,36,0.2);border-radius:6px;padding:10px 12px;font-size:11px;color:var(--text-2);margin-bottom:14px;">
          ${dlCount > 0 ? `📁 ${dlCount} image file${dlCount>1?'s':''} downloading to your Downloads folder<br>` : ''}
          📋 All NB Pro + Veo 3 prompts copied to clipboard<br>
          ✋ Paste each prompt manually into Flow at your own pace
        </div>
        <div style="font-size:10px;color:var(--text-3);margin-bottom:14px;">To switch to full automation, turn on <strong>Claude Browser Mode</strong> in ⚙ Settings.</div>
        <button onclick="this.closest('div[style*=fixed]').remove()" style="width:100%;padding:9px;background:rgba(251,191,36,0.15);border:1px solid rgba(251,191,36,0.4);border-radius:6px;color:var(--warning);font-weight:600;cursor:pointer;font-size:12px;font-family:inherit;">Got it</button>
      </div>`;
      document.body.appendChild(mm);
      mm.addEventListener('click', e=>{ if(e.target===mm)mm.remove(); });
      return;
    }

    let instruction = `The user has asked you to generate videos for all scenes on Google Flow using Claude in Chrome tools. Work through each scene in order. Stay on the existing Flow tab — do not open new browser windows or Chrome profiles.

⚡⚡⚡ EXECUTE IMMEDIATELY — DO NOT EXPLORE OR INVESTIGATE ⚡⚡⚡
Every step below is exact and proven. Start acting on Step 1 NOW.
Do NOT:
  • take "exploratory" screenshots before acting
  • run javascript to "locate", "identify", or "investigate" elements
  • spend steps verifying the UI before clicking
  • research whether a tool works — just use it
The UI is stable. The files are in ~/Downloads/. Begin immediately.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FLOW UI REFERENCE — USE THIS, SKIP ALL EXPLORATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Use the find tool with the exact text/selectors below. They work. Do not verify first.

FIND TOOL PRIORITY (stop at the first one that works — do not try all of them):
  1. find tool with exact visible text (e.g. text="9:16")
  2. find tool with aria-label substring
  3. javascript_tool with document.querySelector on a known CSS selector
  4. Screenshot + coordinate click (LAST RESORT only — avoid unless steps 1–3 all fail)

── IDENTIFYING THE FLOW TAB ──
  Use tabs_context_mcp. The project tab URL contains "labs.google/fx/tools/flow/project/".
  Its title is a date (e.g. "Flow - May 17"). Use that tab for everything.

── BOTTOM BAR (the prompt input row pinned to the bottom of the page) ──
Use these javascript_tool one-liners — faster than find tool, no searching needed:

  New prompt button:
    javascript_tool: document.querySelector('[aria-label="New prompt"]')?.click() ?? find aria-label="New prompt"

  Text input (expand NB Pro panel):
    javascript_tool: document.querySelector('[role="textbox"],[placeholder*="want to create"]')?.click()

  Media/mode button (to switch Image↔Video):
    javascript_tool: document.querySelector('[aria-label="Add media"],[aria-label*="media" i]')?.click()

  Submit / Generate:
    javascript_tool: document.querySelector('[aria-label="Generate"]')?.click()
    Fallback: find aria-label="Generate"

── SWITCHING TO IMAGE MODE (NB Pro) ──
  Run these JS calls back-to-back — batch them if possible:
  1. javascript_tool: document.querySelector('[aria-label="Add media"],[aria-label*="media" i]')?.click()
  2. Wait 0.5s, then: javascript_tool: [...document.querySelectorAll('button,[role="menuitem"],[role="option"]')].find(el=>el.textContent.trim()==='Image')?.click()
  3. Wait 0.5s, then: javascript_tool: [...document.querySelectorAll('button,[role="option"],[role="menuitem"]')].find(el=>el.textContent.includes('Nano Banana Pro'))?.click()
  4. javascript_tool: document.querySelector('[role="textbox"],[placeholder*="want to create"]')?.click()
     → Photo 1 and Photo 2 slots appear above the bar

── SWITCHING TO VIDEO MODE (Veo 3) ──
  1. javascript_tool: document.querySelector('[aria-label="Add media"],[aria-label*="media" i]')?.click()
  2. Wait 0.5s, then: javascript_tool: [...document.querySelectorAll('button,[role="menuitem"],[role="option"]')].find(el=>el.textContent.trim()==='Video')?.click()

── SETTING ASPECT RATIO TO 9:16 ──
  javascript_tool: [...document.querySelectorAll('button,[role="radio"],[role="option"]')].find(el=>el.textContent.trim()==='9:16')?.click()
  Fallback: find text="9:16" and click. Do NOT take a screenshot to confirm — just proceed.

── NB PRO PANEL ELEMENTS ──
  • Photo 1 slot:   first upload area in the NB Pro panel (left side)
  • Photo 2 slot:   second upload area (right side)

  CLICKING A PHOTO SLOT — use these JS one-liners, fastest first:
    Photo 1: javascript_tool:
      (document.querySelector('[aria-label*="Photo 1" i]') ||
       document.querySelector('[aria-label*="Add photo" i]') ||
       [...document.querySelectorAll('[role="button"],[role="img"],button')]
         .find(el => el.textContent.includes('Photo 1') || el.getAttribute('aria-label')?.match(/photo.?1/i))
      )?.click(); return 'clicked Photo 1'

    Photo 2: same but replace "Photo 1" with "Photo 2" in the above

    Fallback if JS fails: find text="Photo 1" and click

  After clicking a slot → asset library opens ("No results found" + "Upload image" button).
  CLICKING "Upload image" — use JS immediately, do NOT use find:
    javascript_tool:
      [...document.querySelectorAll('button,span,[role="button"]')]
        .find(el => el.textContent.trim() === 'Upload image')?.click(); return 'clicked upload'

  Then: file_upload tool with the file path from the scene list below.
  Wait 2 seconds — thumbnail appears in the slot.

  BATCH THESE STEPS: use browser_batch to chain click-slot + screenshot + click-upload in one call.
  • Remove Photo 2: click the × on the Photo 2 thumbnail  →  find aria-label containing "Remove" near Photo 2
  • Prompt field:   the large textarea inside the NB Pro panel (NOT the bottom bar input)
                    find role="textbox" inside the NB Pro panel, or click the visible prompt area
  • Generate btn:   find text="Generate"  OR  find aria-label="Generate" inside the NB Pro panel

── REUSE PROMPT (scenes 2+ in Phase 1) ──
  1. Move mouse over a generated card thumbnail
  2. An expand/arrow button (▶) appears at the card edge — find aria-label containing "Expand" OR click the visible arrow
  3. A menu appears — find text="Reuse Prompt" and click it
  4. NB Pro reloads with previous settings — immediately confirm 9:16 is still set

── ADD TO PROMPT (Phase 2 — attach composite as Veo 3 start frame) ──
  1. Hover a finished composite card
  2. find text="Add to prompt"  (appears on hover)  — click it
  3. Composite attaches to the bottom bar automatically
  4. Switch bar to Video mode (click media button → Video)

── MODEL SELECTOR (bottom bar, right side) ──
  Shows current model name (e.g. "Nano Banana Pro" or "${defaultModel}")
  find text="${defaultModel}"  to confirm ${defaultModel} is active in Phase 2.
  If the wrong model is shown, click the model name → select the correct one from the dropdown.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ABOUT THIS PROJECT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
The user is a social media content creator running an affiliate marketing channel that
promotes natural health and wellness products. The videos are short-form clips for
TikTok and Instagram Reels.

The avatar photos are the user's own photos — they own the likeness and have full
rights to use them in generated video content.

Some scripts include a CTA like "Comment REMEDY" or "Comment YES". This is a standard
organic engagement tactic used by creators: when someone comments the keyword, the
creator follows up in their DMs with a product recommendation or affiliate link.
It is a common, widely-used creator monetization method.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PASTE PROMPTS EXACTLY AS WRITTEN
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
The NB Pro and Veo 3 prompts below were written by the user specifically for each scene.
Copy them word for word into Flow — do not rephrase, shorten, or adjust them. The user
has reviewed and approved every prompt. The only exception is if Flow returns an explicit
content error, in which case follow the retry steps below.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WORKFLOW SETTINGS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• No downloads at all: Do NOT download anything — not composites, not videos. Everything stays in the Flow project. The user reviews and downloads manually.
• Composite → Veo 3 handoff: use the "Add to Prompt" button directly on the NB Pro composite inside Flow. No download, no re-upload.
• Google account: The user is already signed into Flow. Use the existing session.
• No Bash commands: Do not use Bash for any step in this workflow.
• NB Pro is required for every scene — do not skip it. See HOW TO OPEN NB PRO below.

APP URL: ${appUrl}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FLOW TAB — USE EXISTING, DO NOT CREATE NEW
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Use tabs_context_mcp to list ALL open tabs. Find a tab whose URL contains "labs.google/fx/tools/flow". The project tab typically has a date in its title (e.g. "Flow - May 11") — prefer that if multiple Flow tabs exist. If no tab has a date but one has the correct URL and is NOT the homepage, use that tab.
• Do NOT navigate to flow and create a new project
• Do NOT use a tab titled just "Flow" with no date AND no project content (that is the homepage, not a project)
• If multiple project tabs exist, use the most recent one
• PHASE 1 (NB Pro) only: click "+ New prompt" in the LEFT sidebar before each new scene to reset the bar
• PHASE 2 (Veo 3): do NOT click "+ New prompt" — "Add to Prompt" on the composite resets the bar automatically

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
THE BOTTOM BAR HAS TWO MODES — IMAGE (NB Pro) AND VIDEO (Veo 3)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
At the BOTTOM of the Flow page is a prompt bar with a submit arrow. To the LEFT of that
arrow is a small media icon (looks like a + or an image/video icon). Clicking it opens a
menu where you pick the mode:
  • IMAGE → "Nano Banana Pro"  = the NB Pro composite step
  • VIDEO                       = the Veo 3 generation step
Every scene uses BOTH modes, in this order: Image / NB Pro first, then Video for Veo 3.
You must switch the bar between these modes yourself — it does not switch automatically.

HOW TO OPEN NB PRO (Image mode):
  Follow "SWITCHING TO IMAGE MODE (NB Pro)" in the FLOW UI REFERENCE above.
  Short form: click media button → Image → Nano Banana Pro → click text input field (triggers panel to open) → set 9:16 → inject photos → paste prompt → Generate.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
HOW THIS RUN WORKS — TWO PHASES (do them in order)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
This run is split into two phases. Finish Phase 1 ENTIRELY before starting Phase 2.

  PHASE 1 — generate and verify every Nano Banana composite.
  PHASE 2 — for each scene, use "Add to Prompt" on its composite, then generate the Veo 3 video.

Why: NB Pro composites are cheap and fast; Veo 3 videos are slow and cost credits.
Doing all composites first means a bad composite is caught BEFORE a Veo generation
is spent on it.

COMPOSITE HANDOFF (Phase 1 → Phase 2):
  • After a composite passes its checks, note its scene number.
  • In Phase 2, click the "Add to Prompt" button on that composite inside Flow.
    This attaches it directly to the prompt bar as the Veo 3 start frame.
  • Do NOT download composites. Do NOT use file_upload for composites.
    "Add to Prompt" is the only method — it works because Flow keeps the image in the project.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
HOW TO INJECT AN IMAGE INTO FLOW
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Frame images are pre-downloaded to the user's Downloads folder at the start of this run.
Each filename includes a unique run ID — use the EXACT full path shown in the scene list.
Use file_upload to inject them — no javascript_tool, no cross-tab transfer needed.

HOW TO UPLOAD A PHOTO:
  1. Click the Photo 1 or Photo 2 slot → asset library panel opens
     ("No results found" + "Upload image" button). This is normal — do not close it.
  2. Click "Upload image" in the asset library panel
  3. A Windows file picker dialog will open — follow WINDOWS FILE PICKER steps below
  4. Wait ~2 seconds for the thumbnail to appear in the slot
  5. Take a screenshot to confirm the thumbnail is visible before continuing

WINDOWS FILE PICKER — TYPE THE PATH, DO NOT BROWSE:
  When the Windows file dialog opens after clicking "Upload image":
  a) DO NOT click thumbnails or browse folder contents
  b) Click once in the "File name:" text box at the BOTTOM of the dialog
  c) Select all existing text (Ctrl+A) and DELETE it
  d) Type the FULL Windows path exactly as shown in the scene list above
     (e.g. C:\\Users\\x\\Downloads\\avatar_photo_1715987654.jpg)
  e) Press Enter — the dialog closes and the upload begins automatically

  ⚠ Alternatively: use the file_upload tool directly with the full path — it handles
    the file picker automatically without you needing to interact with the dialog.

  ⚠ If the thumbnail does not appear after ~3 seconds:
    → Click the photo slot again to reopen the asset library, then retry file_upload
    → Do NOT use javascript_tool or any cross-tab method — only file_upload works here

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
HOW TO ADD A COMPOSITE TO THE NEXT PROMPT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
After a composite is verified, attach it to the Veo 3 prompt using "Add to Prompt":
1. Find the composite in the Flow sidebar for that scene
2. Hover over it or look for an "Add to Prompt" button (may appear on hover)
3. Click "Add to Prompt" — the composite appears as the start frame in the bottom prompt bar
4. Switch the bar to VIDEO mode (media icon → Video) and confirm the image is still there
5. Do NOT download the composite. Do NOT click any download button.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
HOW TO MARK A SCENE DONE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
After verifying: find the app tab (URL: ${appUrl}) → javascript_tool → window.markSceneDone(SCENE_INDEX)
SCENE_INDEX is 0-based: Scene 1 = index 0, Scene 2 = index 1, etc.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
IF GENERATION FAILS — AUTO RETRY RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠ NEVER skip a scene due to errors. Keep retrying using the pattern below until it succeeds.

STEP 1 — First failure on any step (NB Pro or Veo 3):
  • Click Generate again immediately using the EXACT same prompt and photos — do not change anything
  • Wait up to ${nbWaitSec} seconds for a result

STEP 2 — If that retry also fails:
  • Do a FULL TAB REFRESH:
    1. Use tabs_context_mcp to get the current URL of the Flow tab
    2. Use the navigate tool to reload to THAT SAME URL (do not open a new tab)
    3. Wait 10 seconds for the page to fully reload
    4. Click "+ New prompt" in the LEFT sidebar
    5. Redo the ENTIRE scene from scratch with the EXACT same prompts and photos (word for word)

STEP 3 — If it fails again after the tab refresh:
  • Do another FULL TAB REFRESH (same steps as Step 2) and try again
  • Keep doing this — tab refresh → retry → tab refresh → retry — until the scene succeeds
  • There is NO skip. Every scene must be completed before moving to the next one.

UNUSUAL ACTIVITY / POLICY FLAG specifically:
  • This is a transient Google account flag — it clears on its own after a few minutes
  • Do NOT modify the prompts. Just wait ${cooldownSec} seconds after the tab refresh, then retry with the exact same prompts
  • If it persists for more than 5 tab-refresh attempts in a row, pause and report to the user that manual intervention is needed on the Flow account before continuing

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
IMAGE FRAMES — DOWNLOADED TO ~/Downloads/
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
All frame images were downloaded to ~/Downloads/ when this run started.
Use HOW TO INJECT AN IMAGE (file_upload) — do NOT pick from the Flow asset library.
Assets in the Flow library may be from a previous session and will be WRONG/STALE.
The correct files to use are listed below:
`;

    // Download all frames to disk — browser Claude uploads them via file_upload tool
    // Use a run-scoped ID so filenames are unique every run (avoids Windows "(2)", "(3)" copies)
    const _runId = Math.floor(Date.now() / 1000);
    const _dlDir = getEffectiveDlPath().replace(/\\/g, '\\\\');
    let _dlDelay = 0;
    const _dlInterval = 400;
    const _avatarFile = `avatar_photo_${_runId}.jpg`;
    if (avatarImageDataUrl) {
      instruction += `• ${getEffectiveDlPath()}\\${_avatarFile}  ← Photo 1 avatar (reuse every scene)\n`;
      downloadFrameAsFile(avatarImageDataUrl, _avatarFile, _dlDelay);
      _dlDelay += _dlInterval;
    }
    const _sceneFiles = {};
    segments.forEach((seg, globalI) => {
      if (!seg.veoPrompt?.trim()) return;
      if (skipDone && seg.done) return;
      if (seg.frameDataUrl) {
        const _sf = `frame_scene_${globalI+1}_${_runId}.jpg`;
        _sceneFiles[globalI+1] = _sf;
        instruction += `• ${getEffectiveDlPath()}\\${_sf}  ← Scene ${globalI+1} start frame (Photo 2)\n`;
        downloadFrameAsFile(seg.frameDataUrl, _sf, _dlDelay);
        _dlDelay += _dlInterval;
      }
    });

    instruction += `
Use HOW TO INJECT AN IMAGE (file_upload) for each file listed above when its scene comes up.
Do not pre-upload everything upfront — inject each image right before it is needed.
⚠ File names include a unique run ID — use EXACTLY the path shown above. Do not guess or shorten.
`;

    // Build two-phase instructions: ALL Nano Banana composites, then ALL Veo videos
    const runScenes = [];
    segments.forEach((seg, i) => {
      if (!seg.veoPrompt?.trim()) return;
      if (skipDone && seg.done) return;
      runScenes.push({ seg, i });
    });
    const totalRunScenes = runScenes.length;

    // ── PHASE 1 — every Nano Banana composite ──
    instruction += `

╔══════════════════════════════════════════════╗
║   PHASE 1 — ALL NANO BANANA COMPOSITES         ║
╚══════════════════════════════════════════════╝
Use HOW TO INJECT AN IMAGE (file_upload from ~/Downloads/) for each scene's photos.
BATCH MODE: queue all generations without waiting, then verify all in one pass.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PHASE 1A — QUEUE ALL NB PRO GENERATIONS (do NOT wait between scenes)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Scene 1 is a full setup. Scenes 2+ use REUSE PROMPT — hover over the previous
generating card (arrow appears even while generating) → Reuse Prompt → remove old
Photo 2 → inject the next scene's frame → clear prompt → paste new prompt.

REUSE PROMPT STEPS (scenes 2+):
  1. Hover over the previous scene's generating OR finished card
     — the expand arrow (▶) appears on hover even while the card is still generating
     — if the arrow does not appear immediately, try hovering the bottom edge or corner of the card
  2. Click the arrow → click "Reuse Prompt" — NB Pro mode reloads with the previous settings
  3. Screenshot immediately — confirm:
     a) Format is still 9:16 vertical — if it changed, reset it now before doing anything else
     b) Photo 1 (avatar) is still loaded in its slot
        → If Photo 1 is missing: upload ${getEffectiveDlPath()}\\${_avatarFile} using HOW TO INJECT AN IMAGE
        → If Photo 1 is present: leave it, do not touch it
  4. Remove Photo 2 (click its × button to clear the old scene's start frame)
  5. Upload the next scene's Photo 2 using HOW TO INJECT AN IMAGE with that scene's file path
  6. Click inside the prompt field → press Ctrl+A to select all → press Delete to clear → paste the new scene's prompt
  7. Click Generate — move immediately to the next scene without waiting
`;
    runScenes.forEach(({ seg, i }, idx) => {
      const nbPrompt  = seg.nbPrompt || '(no NB Pro prompt)';
      const hasFrame  = !!seg.frameDataUrl && !bgFromAvatar;
      const _sf = _sceneFiles[i+1] || `frame_scene_${i+1}_${_runId}.jpg`;
      instruction += `
━━ QUEUE SCENE ${idx+1} of ${totalRunScenes} (App Scene ${i+1}) ━━
${idx === 0
  ? `Full setup:
• Click "+ New prompt" in the LEFT sidebar to reset the bar
• Open NB Pro: bottom bar → media icon → Image → Nano Banana Pro
${avatarImageDataUrl
    ? `• Upload Photo 1 (avatar): HOW TO INJECT AN IMAGE → ${getEffectiveDlPath()}\\${_avatarFile}`
    : `• No avatar — skip Photo 1`}
${hasFrame
    ? `• Upload Photo 2 (start frame): HOW TO INJECT AN IMAGE → ${getEffectiveDlPath()}\\${_sf}`
    : `• No start frame — skip Photo 2`}
• Set format: 9:16 vertical`
  : `Reuse Prompt from the previous card — App Scene ${runScenes[idx-1].i+1} (hover → expand arrow → Reuse Prompt → confirm 9:16 format → remove old Photo 2)
${hasFrame
    ? `• Upload Photo 2 (start frame): HOW TO INJECT AN IMAGE → ${getEffectiveDlPath()}\\${_sf}`
    : `• No start frame — skip Photo 2`}`}
• Paste this prompt exactly:

${nbPrompt}

• Click Generate — take a screenshot to confirm a new generating card appeared, then move immediately to the next scene. Do NOT wait for it to finish.
`;
    });

    // ── PHASE 1B — verify + download all composites ──
    instruction += `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PHASE 1B — VERIFY ALL COMPOSITES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
All ${totalRunScenes} NB Pro generations are now queued and running in parallel. Go through the Flow
sidebar from BOTTOM to TOP (Flow shows newest first — Scene 1 was queued first so it is the BOTTOM entry; Scene N is the TOP entry). Scroll down to find Scene 1 and work upward.
⚠ After retries, extra cards appear at the top — do NOT count position. Hover each card to confirm which scene it belongs to by reading the thumbnail or prompt.
For each composite:

  1. Wait for it to finish if still generating (up to ${nbWaitSec} seconds)
  2. Take a screenshot of the result
  3. VERIFY it passes ALL checks:

     ✅ CHECK 1 — Avatar present & recognisable (face + clothing match Photo 1)
        FAIL if: completely different person, or no person visible.${inventoryBlock}

     ✅ CHECK 1b — Person position matches Photo 2 (the scene start frame)
        The avatar must appear at the SAME LOCATION AND SCALE as the original person in Photo 2.
        FAIL if: person was repositioned (e.g. centered when they should be bottom-right),
        or wrong size (fills full frame when reference shows a small corner insert, or vice versa).
        The background/environment visible in Photo 2 must still be visible in the composite at the same proportions.

     ✅ CHECK 2 — Background correct
${bgFromAvatar
  ? `        Avatar BG mode — background must match the environment behind the person in Photo 1.`
  : `        Background must match the scene/location from Photo 2 (the start frame for that scene).`}

     ✅ CHECK 3 — Props/items in hand match source photo (if any)

     ✅ CHECK 4 — Image not corrupted (not blank, distorted, illustrated, or melted)

  4. If ALL checks pass: note it as "SCENE N — COMPOSITE READY". Do not download anything.
  5. If ANY check fails: FLAG this scene — note the scene number and continue checking the rest.

After checking all ${totalRunScenes}:
  • For each FLAGGED scene: redo it individually — click "+ New prompt", set up NB Pro from scratch
    with the exact same photos and prompt, set format to 9:16 vertical, generate, verify.
    ⚠ Each redo creates a NEW composite card at the TOP of the sidebar — this is the card to use
    in Phase 2, not the failed attempt. The failed card can be ignored.
  • Keep retrying flagged scenes until they pass.
  • Do NOT start Phase 2 until every scene is marked COMPOSITE READY.
`;
    runScenes.forEach(({ seg, i }, idx) => {
      // intentionally empty — order tracking only, sidebar order matches queue order
    });

    // ── PHASE 2 — every Veo 3 video ──
    instruction += `

╔══════════════════════════════════════════════╗
║      PHASE 2 — ALL VEO 3 VIDEOS                ║
╚══════════════════════════════════════════════╝
BATCH MODE: Queue ALL Veo 3 generations first without waiting. Then go back and verify,
then mark done each one in order. Each scene gets its own unique prompt and start frame.
⚠ Do NOT download anything. Videos stay in the Flow project — user downloads manually.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PHASE 2A — QUEUE ALL VEO 3 GENERATIONS (do NOT wait between scenes)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
For each scene: find its composite card → click "Add to Prompt" → switch to VIDEO mode →
set model + duration → paste the prompt → click Generate → immediately move to next scene.

HOW TO ATTACH THE COMPOSITE (do this for every scene):
  SIDEBAR ORDER: Composites are listed newest-first (top = most recent). Scene 1's composite
  was generated first, so it is near the BOTTOM. Scene N's composite is near the TOP.
  Scroll down to find earlier scenes. After Phase 1B redos, the newest composite for a scene
  is the one highest in the sidebar — use that one.
  1. Find the NB Pro composite for this scene in the sidebar:
     • It is a STILL IMAGE (no play icon, no duration badge) — not a video card
     • If multiple still-image cards exist for this scene (from Phase 1B retries), use the NEWEST (highest)
     • Hover each still-image card to confirm which scene it belongs to before clicking
  2. Hover over it — an "Add to Prompt" button appears
  3. Click "Add to Prompt" — the image loads into the bottom bar as the start frame
     ⚠ "Add to Prompt" does NOT cancel or affect any other ongoing generations — it is safe to click
       while other videos are still generating.
  4. Click the media icon → select "Video" to switch to VIDEO mode
  5. Confirm the start-frame thumbnail is still visible in the bar
     → If thumbnail disappeared after switching to VIDEO mode: go back to the composite card,
       hover, click "Add to Prompt" again, then re-switch to VIDEO mode and confirm before continuing.
     → Do NOT try to re-inject it via HOW TO INJECT AN IMAGE — only "Add to Prompt" works here.
  6. Set model and duration, paste prompt, click Generate
⚠ Do NOT click "+ New prompt" before "Add to Prompt" — this would clear the bar.
   Instead: use "Add to Prompt" on the composite card directly, which resets the bar automatically.
`;
    runScenes.forEach(({ seg, i }, idx) => {
      const veoPrompt = seg.veoPrompt || '(no Veo 3 prompt)';
      const duration  = getVeoDuration(seg.script);
      const wordCount = (seg.script||'').trim().split(/\s+/).filter(Boolean).length;
      instruction += `
━━ QUEUE SCENE ${idx+1} of ${totalRunScenes} (App Scene ${i+1}) ━━
1. Find Scene ${i+1}'s NB Pro composite in the sidebar:
   • NB Pro composites are STILL IMAGES (no play icon, no duration badge) — not video cards
   • If multiple still-image cards exist for this scene (due to Phase 1B retries), use the NEWEST one (highest in sidebar)
   • Do NOT use position to identify scenes — hover each card to confirm it belongs to Scene ${i+1}
   → Hover the correct card → click "Add to Prompt"
2. Switch to VIDEO mode (media icon → Video) — confirm start frame thumbnail is visible
   → If thumbnail gone after mode switch: re-do "Add to Prompt" on the composite → switch to VIDEO again
3. Model: ${defaultModel} · Duration: ${duration}s  (${wordCount} words ≈ ${Math.round(wordCount/WORDS_PER_SEC)}s speech)
4. Paste this prompt exactly:

${veoPrompt}

5. Click Generate — take a screenshot to confirm a new video card started generating, then move immediately to the next scene. Do NOT wait for it to finish.
`;
    });

    instruction += `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PHASE 2B — VERIFY ALL VEO 3 VIDEOS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
All ${totalRunScenes} Veo 3 videos are generating in parallel. Do NOT download them —
leave them in the Flow project. The user will download manually after reviewing.

Go through the Flow sidebar BOTTOM to TOP (Flow shows newest first — Scene 1 is at the BOTTOM, Scene N is at the TOP). Scroll down to Scene 1 and work upward.
⚠ Do NOT use position to identify scenes — retries create extra cards. Hover each card to confirm which scene it is.
⚠ Veo 3 video cards show a play icon or duration badge. NB Pro composites are still images with no duration. Only interact with VIDEO cards in this phase.
For each video card — wait up to ${veoWaitMin} minutes for it to finish if still generating, then:

  1. Play or scrub through the video
  2. Apply this quality check — the ONLY thing that matters is the speech:

     ✅ KEEP — mark done — if:
        • The person speaks the script words clearly and audibly
        • Their mouth movements match the speech throughout
        • The person stays visible for the duration of the speech
        Minor glitches are fine: background weirdness, objects teleporting, props changing,
        unrealistic movement in the background, brief visual artifacts at the start or end.
        These can all be cut in editing. If the speech is clean, the scene is good.

     ❌ FLAG for regen — if:
        • The video failed to render (blank, error message, corrupted)
        • The person disappears or is replaced mid-clip
        • The speech is wrong, garbled, cut off early, or completely missing
        • The lip sync is so far off the words are unusable
        • The entire video is unwatchable (not just a glitchy end frame)

  3. KEEP → mark done (no download needed):
     find tab ${appUrl} → javascript_tool → window.markSceneDone(SCENE_INDEX)
     (0-based: Scene 1 = index 0, Scene 2 = index 1, etc.)
  4. FLAG → note the scene number, continue checking the rest

After all ${totalRunScenes} are checked:
  • For each FLAGGED scene: redo individually —
    find Scene N's NEWEST composite in sidebar (highest still-image card — no play icon, no duration badge;
    if multiple still-image cards exist from Phase 1B retries, use the highest / most recent one) →
    hover → "Add to Prompt" → switch to VIDEO mode →
    confirm start-frame thumbnail visible → set model + duration → paste its exact prompt →
    Generate → verify speech → markSceneDone(SCENE_INDEX).
    (0-based index: Scene 1 = 0, Scene 2 = 1, Scene 3 = 2, etc.)
    ⚠ Do NOT click "+ New prompt" before "Add to Prompt" — that clears the bar.
  • Keep retrying until speech is clean. Still do not download — leave in project.
`;

    instruction += `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ALL SCENES COMPLETE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Report back: how many scenes completed successfully, and note any that had issues.`;

    // Store for Cowork auto-run pickup
    window._aosPendingInstruction = instruction;
    window._aosPendingTs = Date.now();
    window._aosPendingSceneCount = ready.length;

    navigator.clipboard.writeText(instruction).catch(() => {
      try {
        const ta = document.createElement('textarea');
        ta.value = instruction;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      } catch(e) {}
    });

    // Show live status panel
    showStatusPanel();

    // Show confirmation modal
    const sceneCount = ready.length;
    const doneCount  = segments.filter(s => s.veoPrompt?.trim() && s.done).length;
    const estCredits = estimateCredits(ready);
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9999;display:flex;align-items:center;justify-content:center;';
    modal.innerHTML = `
      <div style="background:var(--surface);border:1px solid rgba(34,197,94,0.4);border-radius:12px;padding:24px;width:480px;max-width:92vw;box-shadow:0 8px 40px rgba(0,0,0,0.6);font-family:inherit;">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;">
          <div style="font-size:22px;">▶</div>
          <div>
            <div style="font-size:14px;font-weight:700;color:var(--text-1);">Run ${sceneCount} Scene${sceneCount>1?'s':''}${skipDone?' (Resume)':''}</div>
            <div style="font-size:11px;color:var(--text-3);">Full instruction copied to clipboard</div>
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:18px;font-size:11px;color:var(--text-2);">
          <div style="background:rgba(34,197,94,0.07);border:1px solid rgba(34,197,94,0.2);border-radius:6px;padding:10px 12px;">
            ✅ All frames downloaded to ~/Downloads/<br>
            ✅ One instruction covers all ${sceneCount} scenes sequentially<br>
            ✅ Auto-retry included (infinite retry — never skips a scene)<br>
            ✅ Each scene auto-marked done in this app when complete
          </div>
          <div style="background:rgba(124,106,247,0.07);border:1px solid rgba(124,106,247,0.2);border-radius:6px;padding:8px 12px;display:flex;align-items:center;gap:10px;">
            <span style="font-size:15px;">💎</span>
            <div>
              <div style="font-size:11px;color:var(--accent-2);font-weight:600;">Estimated: ~${estCredits} Flow credits</div>
              <div style="font-size:10px;color:var(--text-3);">Based on ${sceneCount} scenes × avg duration × Veo 3 Fast rate</div>
            </div>
          </div>
          ${doneCount > 0 && !skipDone ? `<div style="background:rgba(251,191,36,0.06);border:1px solid rgba(251,191,36,0.2);border-radius:6px;padding:8px 12px;font-size:10px;color:var(--warning);">⚡ ${doneCount} scene${doneCount>1?'s are':' is'} already done. Use <strong>Resume</strong> to skip them and save ~${estimateCredits(segments.filter(s=>s.done&&s.veoPrompt?.trim()))} credits.</div>` : ''}
          <div style="background:rgba(6,182,212,0.08);border:1px solid rgba(6,182,212,0.3);border-radius:6px;padding:10px 12px;">
            <div style="font-size:11px;color:#67e8f9;font-weight:700;margin-bottom:4px;">🤖 Auto-Run via Cowork (recommended)</div>
            <div style="font-size:10px;color:var(--text-2);line-height:1.5;">The instruction is ready. Switch to the Cowork chat and type <strong style="color:#e2e8f0;">run it</strong> — Claude will open Google Flow in Chrome and execute the full workflow automatically. No pasting needed.</div>
          </div>
          <div style="color:var(--text-3);font-size:10px;text-align:center;">— or paste manually into any Claude chat (Ctrl+V) —</div>
        </div>
        <div style="display:flex;gap:8px;">
          <button onclick="this.closest('div[style*=fixed]').remove()" style="flex:1;padding:8px;background:rgba(6,182,212,0.12);border:1px solid rgba(6,182,212,0.4);border-radius:6px;color:#67e8f9;font-weight:700;cursor:pointer;font-size:12px;">Got it — switching to Cowork</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  }

  function copyClaudeInstruction(i) {
    if (typeof i !== 'number' || i < 0 || i >= segments.length) return;
    const seg = segments[i];
    if (!seg || !seg.veoPrompt?.trim()) {
      showToast('Generate prompts first, then use this button.', 'warning');
      return;
    }

    const _susr = getUserSettings() || {};
    const _sadm = getAdminSettings() || {};
    const _snbWait = _sadm.nbWaitSec || 180;
    const _sveoWait = _sadm.veoWaitMin || 6;
    const _sModel = _sadm.defaultModel || 'Veo 3.1 Lite';
    const _sClaudeBrowser = _susr.claudeBrowserMode !== false;

    // Avatar appearance inventory — embedded into CHECK 1 below so verification
    // is specific to this avatar. Falls back to the generic check when empty.
    const _sAvInv = (document.getElementById('avatarInventory')?.value || avatarInventory || '').trim();
    const inventoryBlock = _sAvInv ? `

      ── MATCH AGAINST THE AVATAR INVENTORY ──
      The avatar has these specific details. Check EACH line against the generated
      image and mark PASS / FAIL / UNSURE. Treat any UNSURE as a FAIL.
${_sAvInv.split(/\r?\n/).map(l => '        ' + l.trim()).filter(l => l.trim()).join('\n')}` : '';

    const hasAvatar     = !!avatarImageDataUrl;
    const hasStartFrame = !!seg.frameDataUrl && !bgFromAvatar;
    const hasEndFrame   = !!seg.endFrameDataUrl;
    const duration      = getVeoDuration(seg.script);
    const wordCount     = (seg.script || '').trim().split(/\s+/).filter(Boolean).length;

    const nbPrompt  = seg.nbPrompt  || '(no NB Pro prompt generated yet)';
    const veoPrompt = seg.veoPrompt || '(no Veo 3 prompt generated yet)';

    // Download frames to disk — browser Claude uploads them via file_upload tool
    // Unique run ID prevents Windows from creating "(2)", "(3)" numbered copies
    const _sRunId = Math.floor(Date.now() / 1000);
    const _sAvatarFile = `avatar_photo_${_sRunId}.jpg`;
    const _sFrameFile  = `frame_scene_${i+1}_${_sRunId}.jpg`;
    let _sDlDelay = 0;
    const _sDlInterval = 400;
    if (hasAvatar) { downloadFrameAsFile(avatarImageDataUrl, _sAvatarFile, _sDlDelay); _sDlDelay += _sDlInterval; }
    if (hasStartFrame) { downloadFrameAsFile(seg.frameDataUrl, _sFrameFile, _sDlDelay); }

    // ── MANUAL MODE: simple prompt card for this scene ────────────────────────
    if (!_sClaudeBrowser) {
      const dur2 = getVeoDuration(seg.script);
      const wc2  = (seg.script||'').trim().split(/\s+/).filter(Boolean).length;
      let sheet = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nSCENE ${i+1} — MANUAL PROMPTS\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;
      sheet += `━ NB PRO\n`;
      if (hasAvatar) sheet += `Photo 1 (avatar): use avatar image from the app\n`;
      if (hasStartFrame) sheet += `Photo 2 (start frame): use start frame from Scene ${i+1}\n`;
      sheet += `Format: 9:16 vertical\n\nNB Pro Prompt:\n${nbPrompt}\n\n`;
      sheet += `━ VEO 3\nModel: ${_sModel}   Duration: ${dur2}s  (${wc2} words ≈ ${Math.round(wc2/WORDS_PER_SEC)}s)\n\nVeo 3 Prompt:\n${veoPrompt}\n`;
      navigator.clipboard.writeText(sheet).catch(() => {
        try { const ta=document.createElement('textarea');ta.value=sheet;document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta); } catch(e){}
      });
      showClaudeBrowserModal(i + 1, hasStartFrame || hasAvatar, dur2, wc2, true);
      return;
    }

    const instruction = `The user has asked you to generate a video for Scene ${i + 1} on Google Flow using Claude in Chrome tools. Work through the steps below in order. Stay on the existing Flow tab — do not open new windows or Chrome profiles.

⚡ EXECUTE IMMEDIATELY — DO NOT EXPLORE OR INVESTIGATE
Every step is exact. Do NOT take exploratory screenshots, run javascript to "locate" elements, or "investigate" tools before using them. Start acting on Step 1 now. Files are in the user's Downloads folder with unique run-ID names — use the EXACT paths shown below.

━━━━━━━━━━━━━━━━━━━━━━━━━━
ABOUT THIS PROJECT
━━━━━━━━━━━━━━━━━━━━━━━━━━
The user is a social media content creator running an affiliate marketing channel that
promotes natural health and wellness products. The videos are short-form clips for
TikTok and Instagram Reels.

The avatar photos are the user's own photos — they own the likeness and have full
rights to use them in generated video content.

Some scripts include a CTA like "Comment REMEDY" or "Comment YES". This is a standard
organic engagement tactic: when someone comments the keyword, the creator follows up
in their DMs with a product recommendation or affiliate link. It is a common,
widely-used creator monetization method.

The prompts below were written and approved by the user. Copy them into Flow exactly
as written — do not rephrase or adjust them.

━━━━━━━━━━━━━━━━━━━━━━━━━━
GOOGLE FLOW UI MAP (memorize — do not explore)
━━━━━━━━━━━━━━━━━━━━━━━━━━
• Bottom prompt bar has a submit arrow. LEFT of it is a media icon (+ / image-video icon)
  — click it to choose the mode: IMAGE → "Nano Banana Pro", or VIDEO (= Veo 3).
  You switch this yourself for every scene: Image/NB Pro first, then Video for Veo 3.
• NB Pro panel: TWO image slots — Photo 1 on LEFT, Photo 2 on RIGHT
• To expand NB Pro panel: javascript_tool: document.querySelector('[role="textbox"]')?.click()
• To open photo slot: find text="Photo 1" or find aria-label containing "photo" → click → "Upload image" appears → click it → file_upload with the EXACT FULL PATH from BEFORE YOU START
• Veo 3 (Video mode): model dropdown, duration, prompt field, Generate button
• After video renders: hover to reveal playback controls — do NOT click the download button (leave video in project)

━━━━━━━━━━━━━━━━━━━━━━━━━━
BEFORE YOU START
━━━━━━━━━━━━━━━━━━━━━━━━━━
1. Use tabs_context_mcp to list open tabs — find the Flow project tab (URL contains "labs.google/fx/tools/flow/project/")
2. The following files were downloaded to the user's computer at run start:
${hasAvatar ? `   • ${getEffectiveDlPath()}\\${_sAvatarFile}  ← Photo 1 avatar` : '   • (no avatar file)'}
${hasStartFrame ? `   • ${getEffectiveDlPath()}\\${_sFrameFile}  ← Photo 2 start frame` : '   • (no start frame file)'}
   ⚠ These filenames include a unique run ID — use them EXACTLY as shown above.
3. Navigate to the Flow project tab

━━━━━━━━━━━━━━━━━━━━━━━━━━
HOW TO INJECT AN IMAGE INTO FLOW
━━━━━━━━━━━━━━━━━━━━━━━━━━
Frame images are pre-downloaded to the user's Downloads folder (unique run-ID names above).
Use file_upload with the EXACT full path — do not browse for files.

HOW TO UPLOAD A PHOTO:
  1. Click the Photo 1 or Photo 2 slot → asset library opens ("No results found" + "Upload image")
  2. Click "Upload image" — a Windows file picker dialog will appear
  3. WINDOWS FILE PICKER — TYPE THE PATH, DO NOT BROWSE:
     a) DO NOT click thumbnails or browse folder contents
     b) Click once in the "File name:" text box at the BOTTOM of the dialog
     c) Select all (Ctrl+A), DELETE existing text
     d) Type the FULL Windows path exactly from BEFORE YOU START above
        Example: ${getEffectiveDlPath()}\\${_sAvatarFile}
     e) Press Enter — upload begins automatically
     ⚠ Alternatively: use the file_upload tool directly with the full path shown above
  4. Wait ~2 seconds for the thumbnail to appear in the slot
  5. Take a screenshot to confirm thumbnail is visible before continuing

  ⚠ If thumbnail does not appear after ~3 seconds:
    → Click the photo slot again to reopen the asset library, then retry file_upload

━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 1 — Nano Banana Pro
━━━━━━━━━━━━━━━━━━━━━━━━━━
1. Open NB Pro: click the media icon LEFT of the bottom-bar submit arrow → "Image" → "Nano Banana Pro"
${hasAvatar ? `2. Upload Photo 1 (avatar): HOW TO INJECT AN IMAGE → ${getEffectiveDlPath()}\\${_sAvatarFile}` : '2. No avatar — skip Photo 1'}
${hasStartFrame ? `3. Upload Photo 2 (start frame): HOW TO INJECT AN IMAGE → ${getEffectiveDlPath()}\\${_sFrameFile}` : '3. No start frame — skip Photo 2'}
4. Set format: 9:16 vertical
5. Paste this NB Pro prompt:

${nbPrompt}

6. Click Generate — wait up to ${_snbWait}s for image to appear
7. Take a screenshot of the generated NB Pro image
8. VERIFY the image passes ALL of the following checks before clicking "Add to Prompt":

   ✅ CHECK 1 — Avatar present & matches inventory
      The person from Photo 1 (the avatar) must be clearly visible.
      Their face, body, and clothing must be recognisable and unchanged from Photo 1.
      FAIL if: completely different person, or no person at all.${inventoryBlock}

   ✅ CHECK 2 — Background is correct
${bgFromAvatar ? `      ⚠ AVATAR BG MODE IS ON — Photo 1 is the source for BOTH the person AND the background.
      The background in the generated image must match the background visible behind the person in Photo 1.
      Look at Photo 1 carefully — what is behind the person? That same environment must appear in the composite.
      FAIL if: the background has changed to something not in Photo 1, or it is a plain/blank background not present in Photo 1.`
: hasStartFrame ? `      The background environment must match the scene/location shown in Photo 2 (the start frame).
      Compare the generated image directly to Photo 2 — the setting, colours, and key objects in the background must match.
      FAIL if: plain colour background, entirely different location, or no resemblance to Photo 2.`
: `      No reference background provided — skip this check.`}

   ✅ CHECK 3 — Items in hand / props match the source photo
${bgFromAvatar ? `      ⚠ AVATAR BG MODE — the props reference is Photo 1 (the avatar photo).
      If Photo 1 shows the person holding or interacting with any visible object (bottle, fruit, product, tool, food, etc.), that same object must appear in approximately the same position in the generated image.
      FAIL if: Photo 1 shows a visible prop/object but the generated image shows empty hands or a completely different unrelated object.`
: hasStartFrame ? `      If Photo 2 shows the person holding an object (bottle, fruit, product, food, etc.), that same object or a visually similar one must appear in the generated image in approximately the same position.
      FAIL if: Photo 2 shows a visible prop but the generated image shows empty hands or a completely different unrelated object.`
: `      No reference frame provided — skip this check.`}

   ✅ CHECK 4 — Image is not corrupted
      Must be a clean, realistic photo-quality composite — no blank, distorted, melted face, duplicate limbs, cartoon, or illustration.

   IF ANY CHECK FAILS — KEEP RETRYING (never skip):
   • Retry 1: Click Generate again with the EXACT same prompt and photos — wait up to ${_snbWait}s, re-run all 4 checks
   • If retry 1 also fails: do a FULL TAB REFRESH — navigate to the same Flow URL, wait 10 seconds, redo from NB Pro upload with the exact same prompts and photos
   • Keep doing tab refresh → retry until checks 1 and 4 pass — do NOT skip this scene
   • If only checks 2 or 3 fail (background/prop mismatch) after multiple attempts: proceed to Step 2 anyway, note the mismatch in your report
   • "Unusual activity" flag: IMMEDIATELY press F5 to do a full tab refresh — do NOT modify the prompts — wait ${_sadm.cooldownSec || 120} seconds after the refresh completes, then retry the full step identically from the beginning

9. Once all checks pass (or after retry): move the composite into Veo 3 —
   Click "Add to Prompt" on the NB composite (hover over it to reveal the button).
   Then switch the bar to VIDEO mode (media icon → Video) and confirm the composite
   is showing in the start-frame slot. Do NOT download the composite.
   → If the thumbnail disappeared after switching to VIDEO mode: go back to the composite,
     hover, click "Add to Prompt" again, re-switch to VIDEO mode, confirm before continuing.
   ⚠ If you had to retry Step 1 (tab refresh or re-generate), use "Add to Prompt" on the
     NEW passing composite — not the original failed attempt.

━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 2 — ${_sModel}
━━━━━━━━━━━━━━━━━━━━━━━━━━
1. Make sure the bottom bar is in VIDEO mode and the NB composite is sitting in the start-frame slot (from Step 1.9)
2. Select model: ${_sModel}
3. Set duration: ${duration} seconds  (${wordCount} words ≈ ${Math.round(wordCount / WORDS_PER_SEC)}s speech)
4. Paste this Veo 3 prompt:

${veoPrompt}

5. Click Generate — wait up to ${_sveoWait} minutes — do NOT interrupt
6. Verify the video (speech check):
   ✅ KEEP if: person speaks the script clearly, mouth movements match, person stays visible.
      Minor glitches (background weirdness, teleporting props, artifacts at edges) are fine.
   ❌ REGEN if: render failed, person disappears, speech garbled/missing, unwatchable.
7. Do NOT download the video — leave it in the Flow project. The user will download manually.
8. Mark done: tabs_context_mcp → find tab ${window.location.href} → javascript_tool → window.markSceneDone(${i})
9. Report back with the result`;

    navigator.clipboard.writeText(instruction).catch(() => {
      try {
        const ta = document.createElement('textarea');
        ta.value = instruction;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      } catch(e) {}
    });

    showClaudeBrowserModal(i + 1, hasStartFrame || hasAvatar, duration, wordCount);
  }

  function showClaudeBrowserModal(sceneNum, hasFiles, duration, wordCount, isManual) {
    const defaultModel = (getAdminSettings() || {}).defaultModel || 'Veo 3.1 Lite';
    if (isManual) {
      const existing = document.getElementById('claudeBrowserModal');
      if (existing) existing.remove();
      const mm = document.createElement('div');
      mm.id = 'claudeBrowserModal';
      mm.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9999;display:flex;align-items:center;justify-content:center;';
      mm.innerHTML = `<div style="background:var(--surface);border:1px solid rgba(251,191,36,0.4);border-radius:12px;padding:24px;width:420px;max-width:92vw;box-shadow:0 8px 40px rgba(0,0,0,0.6);font-family:inherit;">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;"><div style="font-size:22px;">📋</div><div>
          <div style="font-size:14px;font-weight:700;color:var(--text-1);">Scene ${sceneNum} Prompts Copied</div>
          <div style="font-size:11px;color:var(--text-3);">Manual mode — paste into Flow yourself</div>
        </div></div>
        <div style="background:rgba(251,191,36,0.07);border:1px solid rgba(251,191,36,0.2);border-radius:6px;padding:10px 12px;font-size:11px;color:var(--text-2);margin-bottom:14px;">
          ${hasFiles ? '📁 Image files downloaded to Downloads<br>' : ''}
          📋 NB Pro + Veo 3 prompts copied to clipboard<br>
          ✋ Paste each prompt manually into Flow
        </div>
        <div style="font-size:10px;color:var(--text-3);margin-bottom:14px;">To use full automation, enable <strong>Claude Browser Mode</strong> in ⚙ Settings.</div>
        <button onclick="this.closest('div[style*=fixed]').remove()" style="width:100%;padding:9px;background:rgba(251,191,36,0.15);border:1px solid rgba(251,191,36,0.4);border-radius:6px;color:var(--warning);font-weight:600;cursor:pointer;font-size:12px;font-family:inherit;">Got it</button>
      </div>`;
      document.body.appendChild(mm);
      mm.addEventListener('click', e=>{ if(e.target===mm)mm.remove(); });
      return;
    }

    const existing = document.getElementById('claudeBrowserModal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'claudeBrowserModal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9999;display:flex;align-items:center;justify-content:center;';

    const fileNote = hasFiles ? `
      <div style="background:rgba(34,197,94,0.07);border:1px solid rgba(34,197,94,0.25);border-radius:6px;padding:10px 12px;margin-bottom:14px;display:flex;gap:8px;align-items:flex-start;">
        <div style="font-size:15px;flex-shrink:0;">🖼️</div>
        <div>
          <div style="font-size:10px;color:var(--success);font-weight:600;margin-bottom:2px;">Fully automated — images uploaded via file_upload from ~/Downloads/</div>
          <div style="font-size:11px;color:var(--text-3);line-height:1.5;">Claude in Chrome uploads pre-downloaded frame files directly into Flow's photo slots — no manual steps needed.</div>
        </div>
      </div>` : '';

    modal.innerHTML = `
      <div style="background:var(--surface);border:1px solid rgba(139,92,246,0.4);border-radius:12px;padding:24px;width:500px;max-width:92vw;max-height:90vh;overflow-y:auto;box-shadow:0 8px 40px rgba(0,0,0,0.6);font-family:inherit;">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;">
          <div style="font-size:22px;">🤖</div>
          <div>
            <div style="font-size:14px;font-weight:700;color:var(--text-1);">Use Claude in Chrome — Scene ${sceneNum}</div>
            <div style="font-size:11px;color:var(--text-3);">Full workflow instruction copied to clipboard</div>
          </div>
        </div>
        ${fileNote}

        <!-- Workflow summary -->
        <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:18px;">

          <div style="background:rgba(251,191,36,0.06);border:1px solid rgba(251,191,36,0.2);border-radius:6px;padding:10px 12px;">
            <div style="font-size:10px;font-weight:700;color:var(--warning);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">Step 1 — Nano Banana Pro on labs.google</div>
            <div style="font-size:11px;color:var(--text-2);line-height:1.7;">
              Upload avatar as Photo 1 · Upload start frame as Photo 2<br>
              Set <strong style="color:var(--text-1);">9:16 vertical</strong> · Paste NB Pro prompt · Generate<br>
              ✓ Check result looks right · Click <strong style="color:var(--text-1);">"Add to Prompt"</strong>
            </div>
          </div>

          <div style="background:var(--accent-glow-sm);border:1px solid var(--accent);border-radius:6px;padding:10px 12px;">
            <div style="font-size:10px;font-weight:700;color:var(--accent-2);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">Step 2 — Veo 3</div>
            <div style="font-size:11px;color:var(--text-2);line-height:1.7;">
              NB Pro image becomes the starting frame<br>
              Select <strong style="color:var(--text-1);">${defaultModel}</strong> · Set duration to <strong style="color:var(--text-1);">${duration} seconds</strong><br>
              <span style="font-size:10px;color:var(--text-3);">(${wordCount} words ≈ ${Math.round(wordCount / WORDS_PER_SEC)}s of speech)</span><br>
              Paste Veo 3 prompt · Generate
            </div>
          </div>
        </div>

        <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:18px;">
          <div style="display:flex;gap:10px;align-items:flex-start;">
            <div style="width:22px;height:22px;border-radius:50%;background:rgba(139,92,246,0.2);border:1px solid rgba(139,92,246,0.4);color:#a78bfa;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px;">1</div>
            <div style="font-size:12px;color:var(--text-2);line-height:1.5;">Open <strong style="color:var(--text-1);">Claude.ai</strong> with the <strong style="color:var(--text-1);">Claude in Chrome</strong> extension active.</div>
          </div>
          <div style="display:flex;gap:10px;align-items:flex-start;">
            <div style="width:22px;height:22px;border-radius:50%;background:rgba(139,92,246,0.2);border:1px solid rgba(139,92,246,0.4);color:#a78bfa;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px;">2</div>
            <div style="font-size:12px;color:var(--text-2);line-height:1.5;">Press <kbd style="background:#2a2a3a;border:1px solid #444;border-radius:3px;padding:1px 6px;font-size:11px;">Ctrl+V</kbd> / <kbd style="background:#2a2a3a;border:1px solid #444;border-radius:3px;padding:1px 6px;font-size:11px;">⌘V</kbd> to paste, then send.</div>
          </div>
          <div style="display:flex;gap:10px;align-items:flex-start;">
            <div style="width:22px;height:22px;border-radius:50%;background:rgba(139,92,246,0.2);border:1px solid rgba(139,92,246,0.4);color:#a78bfa;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px;">3</div>
            <div style="font-size:12px;color:var(--text-2);line-height:1.5;">Claude handles the full workflow — NB Pro first, then Veo 3.</div>
          </div>
        </div>

        <div style="background:rgba(139,92,246,0.07);border:1px solid rgba(139,92,246,0.2);border-radius:6px;padding:10px 12px;margin-bottom:18px;">
          <div style="font-size:10px;color:#a78bfa;font-weight:600;margin-bottom:3px;">Don't have Claude in Chrome?</div>
          <div style="font-size:11px;color:var(--text-3);line-height:1.5;">Install it free from the <a href="https://chromewebstore.google.com" target="_blank" style="color:#a78bfa;text-decoration:none;">Chrome Web Store</a> — search "Claude in Chrome" by Anthropic.</div>
        </div>
        <div style="display:flex;justify-content:flex-end;">
          <button onclick="document.getElementById('claudeBrowserModal').remove()" style="padding:8px 20px;background:rgba(139,92,246,0.15);border:1px solid rgba(139,92,246,0.4);border-radius:6px;color:#a78bfa;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;">Got it</button>
        </div>
      </div>`;

    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  }

  // --- Copy Veo 3 prompt and open Google Flow ---
  function copyAndOpenVeo3(i) {
    const el = document.getElementById('veo-seg-' + i);
    if (!el || !el.value.trim()) {
      showToast('Generate prompts first (click ⚡ Generate All Prompts), then use this button.', 'warning');
      return;
    }
    const doCopy = () => {
      try { el.select(); document.execCommand('copy'); } catch(e) {}
    };
    navigator.clipboard.writeText(el.value).catch(doCopy);
    const tab = window.open('https://labs.google/fx/tools/flow', '_blank');
    if (!tab) {
      showToast('Popup blocked — prompt copied to clipboard. Open a new tab and paste.', 'warning', 4000);
    }
    // Show a persistent toast reminding user to paste
    showVeo3Toast(i + 1);
  }

  let _veo3ToastTimer = null;
  function showVeo3Toast(sceneNum) {
    let toast = document.getElementById('veo3Toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'veo3Toast';
      toast.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#1a1a2e;border:1px solid var(--accent);border-radius:8px;padding:12px 20px;display:flex;align-items:center;gap:12px;z-index:9999;box-shadow:0 4px 24px rgba(0,0,0,0.5);font-family:inherit;min-width:280px;max-width:90vw;';
      document.body.appendChild(toast);
    }
    toast.innerHTML = `
      <div style="font-size:20px;flex-shrink:0;">📋</div>
      <div style="flex:1;">
        <div style="font-size:12px;font-weight:700;color:var(--accent-2);margin-bottom:2px;">Scene ${sceneNum} prompt copied!</div>
        <div style="font-size:11px;color:var(--text-2);">Google Flow is opening — just press <kbd style="background:#2a2a3a;border:1px solid #444;border-radius:3px;padding:1px 5px;font-size:10px;">Ctrl+V</kbd> <span style="color:var(--text-3);">/ </span><kbd style="background:#2a2a3a;border:1px solid #444;border-radius:3px;padding:1px 5px;font-size:10px;">⌘V</kbd> to paste.</div>
      </div>
      <button onclick="document.getElementById('veo3Toast').style.display='none'" style="background:none;border:none;color:var(--text-3);font-size:16px;cursor:pointer;flex-shrink:0;padding:0;line-height:1;">✕</button>
    `;
    toast.style.display = 'flex';
    clearTimeout(_veo3ToastTimer);
    _veo3ToastTimer = setTimeout(() => { if (toast) toast.style.display = 'none'; }, 8000);
  }

  // --- Refresh Veo 3 prompt for a single segment after script/action edit ---
  async function refreshSegmentVeo3(i) {
    const seg = segments[i];
    if (!seg) return;
    // Sync live textarea values before regenerating
    const scriptEl2 = document.getElementById('script-seg-' + i);
    if (scriptEl2) seg.script = scriptEl2.value;
    const actionEl = document.getElementById('action-seg-' + i);
    if (actionEl) seg.action = actionEl.value;

    const veoEl = document.getElementById('veo-seg-' + i);

    // If this segment has an NB preview image, use the vision path so the
    // richer starting_frame / foreground_props fields are preserved/updated.
    if (seg.nbPreviewDataUrl) {
      if (veoEl) veoEl.value = '⏳ Rebuilding Veo 3 from image…';
      let ok = false;
      try { ok = await buildVeo3FromNBImage(i); } catch (_) {}
      if (!ok) {
        // Vision call failed — fall back to template builder
        const productSel = document.getElementById('studioProduct');
        const productName = productSel && productSel.selectedIndex >= 0 ? (productSel.options[productSel.selectedIndex]?.text || 'the product') : 'the product';
        const setting = document.getElementById('studioSetting') ? document.getElementById('studioSetting').value.trim() : '';
        seg.veoPrompt = buildSegmentVeo3Prompt(i, seg.startTime, seg.endTime, seg.script, setting, productName, bgImageDataUrl);
        if (veoEl) { veoEl.value = seg.veoPrompt; autoGrow(veoEl); }
      }
      saveSegments();
      // Expand Veo 3 section so the result is visible
      const _veoWrapNB = document.getElementById('veo-wrap-' + i);
      const _veoTglNB  = document.getElementById('veo-toggle-' + i);
      if (_veoWrapNB && _veoWrapNB.style.display === 'none') {
        _veoWrapNB.style.display = '';
        if (_veoTglNB) { _veoTglNB.innerHTML = '<i class="ti ti-eye-off"></i>'; _veoTglNB.title = 'Hide prompt'; }
      }
      showToast(`Seg ${i + 1} Veo 3 prompt updated.`, 'success', 2000);
      return;
    }

    // No NB image — use the fast template builder
    const productSel = document.getElementById('studioProduct');
    const productName = productSel && productSel.selectedIndex >= 0 ? (productSel.options[productSel.selectedIndex]?.text || 'the product') : 'the product';
    const setting = document.getElementById('studioSetting') ? document.getElementById('studioSetting').value.trim() : '';
    seg.veoPrompt = buildSegmentVeo3Prompt(i, seg.startTime, seg.endTime, seg.script, setting, productName, bgImageDataUrl);
    saveSegments();
    // Update the textarea in place and make it visible
    if (veoEl) {
      veoEl.value = seg.veoPrompt;
      autoGrow(veoEl);
    }
    // Expand the Veo 3 section so the user can see the regenerated prompt
    const veoWrap = document.getElementById('veo-wrap-' + i);
    const veoToggleBtn = document.getElementById('veo-toggle-' + i);
    if (veoWrap && veoWrap.style.display === 'none') {
      veoWrap.style.display = '';
      if (veoToggleBtn) {
        veoToggleBtn.innerHTML = '<i class="ti ti-eye-off"></i>';
        veoToggleBtn.title = 'Hide prompt';
      }
    }
    showToast(`Seg ${i + 1} Veo 3 prompt updated.`, 'success', 2000);
  }

  // --- Refresh Scene Action for a single segment via GPT-4o Vision ---
  // Captures 6 evenly-spaced frames across the segment's exact timestamp range
  // (e.g. 0–4 s) and sends them to GPT-4o as a labelled sequential strip so it
  // can describe both the person's actions AND any visual changes over time
  // (pouring → dissolving, squeezing → flowing, etc.).
  // Falls back to deriveSceneAction (keyword-based) if the video isn't loaded.
  async function refreshSegmentAction(i) {
    const seg = segments[i];
    if (!seg) return;
    pushUndo(`Regen Action Seg ${i + 1}`);
    const btn = document.getElementById('regen-action-btn-' + i);
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Analyzing…'; }

    const apiKey  = getApiKey();
    const pronoun = getAvatarPronoun();
    const actionEl = document.getElementById('action-seg-' + i);

    const done = (text, fromAI) => {
      seg.action = sanitizeDirections(text);
      if (actionEl) {
        actionEl.value = seg.action;
        autoGrow(actionEl);
        actionEl.style.borderColor = 'rgba(52,211,153,0.6)';
        setTimeout(() => { if (actionEl) actionEl.style.borderColor = ''; }, 1400);
        // Auto-expand the action section so the user can see the result
        const wrap = document.getElementById('action-wrap-' + i);
        // Toggle span is in the sibling row immediately above action-wrap
        const toggle = wrap ? wrap.previousElementSibling?.querySelector('.action-toggle') : null;
        if (wrap && wrap.style.display === 'none') {
          wrap.style.display = '';
          if (toggle) toggle.textContent = '▾ Hide';
        }
      }
      saveSegments();
      if (btn) { btn.disabled = false; btn.textContent = '↻ Regen Action'; }
      if (fromAI) showToast(`Seg ${i + 1} action updated from AI frame analysis.`, 'success', 2500);
    };

    // No API key — fall back to keyword-based derivation immediately
    if (!apiKey) {
      done(deriveSceneAction(seg.script || '', i, segments.length), false);
      return;
    }

    try {
      // Capture 6 frames evenly spread across startTime → endTime.
      // This gives GPT-4o a temporal sequence so it can see motion changes
      // (e.g. before/during/after a pour, a squeeze, or a dissolving effect).
      const FRAME_COUNT = 6;
      const clipStart = seg.startTime;
      const clipEnd   = seg.endTime;
      const clipDur   = clipEnd - clipStart;

      // Zero-duration guard — if start === end (e.g. a freshly added CTA segment
      // before the user has set its endpoint) all captures would land on the same
      // frame; fall back to keyword derivation immediately.
      if (clipDur <= 0) {
        done(deriveSceneAction(seg.script || '', i, segments.length), false);
        showToast('Segment has no duration yet — action set from script keywords.', 'info', 3000);
        return;
      }

      const step = clipDur / (FRAME_COUNT + 1);

      // Save playhead before the loop; restore after so the user's position is preserved.
      // captureFrame is pure (no internal restore) — restoring inside it fires a second
      // 'seeked' event that the next call's listener would catch, capturing the wrong frame.
      const videoElRef = document.getElementById('refVideoEl');
      const savedPlayhead = videoElRef ? videoElRef.currentTime : null;

      const liveFrames = [];
      const timestamps = [];
      for (let k = 1; k <= FRAME_COUNT; k++) {
        const t = clipStart + step * k;
        timestamps.push(t);
        const raw = await captureFrame(t);
        // Scale to 512px max — OpenAI detail:'low' caps there anyway.
        // Keeps 6-frame payload well under Netlify's 6MB function body limit.
        const f = raw ? await scaleDataUrl(raw, 512) : null;
        if (f) liveFrames.push({ t, f });
      }

      // Restore playhead after all frames captured
      if (videoElRef && savedPlayhead !== null) {
        try { videoElRef.currentTime = savedPlayhead; } catch(_) {}
      }

      // If video isn't loaded/seekable, fall back to the saved start frame only
      if (!liveFrames.length) {
        if (seg.frameDataUrl) {
          const scaledFallback = await scaleDataUrl(seg.frameDataUrl, 512);
          liveFrames.push({ t: clipStart, f: scaledFallback });
          showToast(`Seg ${i+1}: video not loaded — using saved start frame only. Load the video for a full sequence analysis.`, 'warning', 4000);
        } else {
          done(deriveSceneAction(seg.script || '', i, segments.length), false);
          showToast('Video not loaded — action set from script keywords. Load the video for AI frame analysis.', 'info', 4000);
          return;
        }
      }

      // Build the image content with inline timestamp labels
      // Label format: [0.0s] [1.3s] ... so GPT knows frames are ordered in time
      const fmt = s => s.toFixed(1) + 's';
      const frameLabel = liveFrames.map(({t}) => `[${fmt(t)}]`).join('  ');
      const imageContent = liveFrames.map(({f}) => ({ type: 'image_url', image_url: { url: f, detail: 'low' } }));

      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o', max_tokens: 400,
          messages: [{ role: 'user', content: [
            { type: 'text', text: `You are analyzing a VIDEO CLIP from ${fmt(clipStart)} to ${fmt(clipEnd)} (${fmt(clipDur)} long).

The ${liveFrames.length} images below are sequential frames captured at: ${frameLabel}
They are in TIME ORDER. Study what the PERSON is ACTUALLY DOING across the sequence.

Your job: describe ONLY the person's actual physical body movements you can SEE in the frames. This will be used to direct a Veo 3 avatar recreating the same physical behavior.

STRICT RULES:
1. ONLY describe movements the person is VISIBLY PERFORMING in the frames. Do NOT infer, predict, or narrate what they might do based on props or ingredients nearby.
2. If the person is standing/sitting and TALKING without performing a distinct physical action — write that. Example: "${pronoun} stands at a counter speaking naturally to camera with subtle hand gestures."
3. If the person IS actively handling an object (pouring, holding, demonstrating), describe that specific motion precisely.
4. NEVER describe ingredients, foods, or objects doing things on their own (no "the mixture thickens", no "the oil blends in") unless you can see the person actually causing that effect with their hands in the frames.
5. Do NOT use "left" or "right" — use "one hand", "the other hand", "both hands".
6. Do NOT describe the person's appearance, face, clothing, or background.
7. Write one flowing sentence or two short sentences. No bullet lists.
8. Return ONLY the action description — no intro, no commentary.` },
            ...imageContent
          ]}]
        })
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        const errMsg = errData?.error?.message || ('API error ' + res.status);
        done(deriveSceneAction(seg.script || '', i, segments.length), false);
        showToast('Regen action failed: ' + errMsg, 'error', 5000);
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (data.error) {
        done(deriveSceneAction(seg.script || '', i, segments.length), false);
        showToast('Regen action failed: ' + (data.error.message || data.error), 'error', 5000);
        return;
      }
      let desc = data.choices?.[0]?.message?.content?.trim() || '';
      const refused = !desc || /(i['’]m| i am) sorry|(can['’]t|cannot) assist/i.test(desc);
      if (refused) {
        desc = deriveSceneAction(seg.script || '', i, segments.length);
        done(desc, false);
        showToast('AI analysis unavailable — action set from script keywords.', 'info', 3000);
      } else {
        done(desc, true);
      }
    } catch (e) {
      done(deriveSceneAction(seg.script || '', i, segments.length), false);
      showToast('Action updated from script keywords (AI analysis error: ' + (e.message || e) + ').', 'info', 4000);
    }
  }

  // --- Refresh NB Pro prompt for a single segment ---
  // Handles both replicator mode (vision-based) and producer mode (template-based)
  async function refreshSegmentNB(i) {
    const seg = segments[i];
    if (!seg) return;

    // Replicator mode — use GPT-4o vision on the captured frame
    if (!seg._scriptOnly && seg.frameDataUrl) {
      const nbEl = document.getElementById('nb-seg-' + i);
      const btn = document.querySelector(`[data-nb-regen="${i}"]`);
      if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
      try {
        const ok = await buildNBPromptFromImage(i);
        if (!ok && nbEl) {
          // Restore previous value if vision call failed (buildNBPromptFromImage already
          // clears the spinner, but seg.nbPrompt holds the last good value)
          nbEl.value = seg.nbPrompt || '';
          autoGrow(nbEl);
          showToast('Could not rebuild the scene description — your previous version was kept.', 'warning');
        }
        saveSegments();
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = '↻ Regen NB'; }
      }
      return;
    }

    // Producer mode — use template builder with visual description
    const frameDescEl = document.getElementById('framedesc-seg-' + i);
    if (frameDescEl) seg.frameDesc = frameDescEl.value;
    const scriptEl = document.getElementById('script-seg-' + i);
    if (scriptEl) seg.script = scriptEl.value;
    const setting = document.getElementById('studioSetting') ? document.getElementById('studioSetting').value.trim() : '';
    const avatarDesc = document.getElementById('avatarDesc') ? document.getElementById('avatarDesc').value.trim() : '';
    seg.nbPrompt = buildScriptOnlyNBPrompt(i, seg.script, setting, avatarDesc, bgImageDataUrl, seg.frameDesc || '');
    saveSegments();
    const nbEl = document.getElementById('nb-seg-' + i);
    if (nbEl) {
      nbEl.value = seg.nbPrompt;
      autoGrow(nbEl);
      nbEl.style.borderColor = 'var(--warning)';
      setTimeout(() => nbEl.style.borderColor = '', 800);
    }
  }

  // --- Condense over-limit scenes to fit within ~8s of speech ---
  async function condenseAllScripts() {
    if (segments.length === 0) { showToast('No scenes yet. Paste your script and click ✂ Split into 8s Scenes first.', 'warning'); return; }
    const apiKey = getApiKey();
    if (!apiKey) { showToast('AI features are not available right now. Please contact support.', 'warning'); return; }

    // Sync all live textarea values first
    segments.forEach((seg, i) => {
      const el = document.getElementById('script-seg-' + i);
      if (el) seg.script = el.value;
    });

    // Find scenes that are over the word limit
    const overLimit = segments.map((s, i) => { const t = (s.script || '').trim(); return { i, wc: t.split(/\s+/).filter(Boolean).length, text: t }; })
      .filter(x => x.wc > TARGET_WORDS + 3); // allow a little slack

    if (overLimit.length === 0) {
      showToast('All scenes are already within the 8-second word limit — nothing to condense.', 'warning');
      return;
    }

    const btn = document.getElementById('condenseAllBtn');
    if (btn) { btn.textContent = `⏳ Condensing ${overLimit.length} scene${overLimit.length !== 1 ? 's' : ''}…`; btn.disabled = true; }

    const sceneList = overLimit.map(x =>
      `Scene ${x.i + 1} (${x.wc} words — target ≤${TARGET_WORDS}): "${x.text}"`
    ).join('\n\n');

    const systemPrompt = `You are a script editor. You will be given a list of video script scenes that are too long for an 8-second clip. Rewrite each scene to be ${TARGET_WORDS} words or fewer while:
- Keeping the EXACT same message and core claim
- Keeping the speaker's voice and tone
- Removing filler, redundancy, and padding only
- Never adding new claims that weren't in the original
- Never using ellipsis or truncation — every rewrite must be a complete, natural sentence

Return ONLY a raw JSON array of objects with keys "i" (scene index, integer) and "script" (rewritten text). No markdown. No wrapper. Start with [ end with ].`;

    const userPrompt = `Rewrite these ${overLimit.length} over-limit scenes to ≤${TARGET_WORDS} words each:\n\n${sceneList}`;

    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o',
          messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
          temperature: 0.4,
        })
      });
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error?.message || 'API error ' + res.status); }
      const data = await res.json();
      let parsed;
      try {
        let raw = data.choices?.[0]?.message?.content || '';
        raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
        const arrStart = raw.indexOf('['); const arrEnd = raw.lastIndexOf(']');
        if (arrStart !== -1 && arrEnd !== -1) raw = raw.slice(arrStart, arrEnd + 1);
        parsed = JSON.parse(raw);
      } catch(e) { throw new Error('Could not parse GPT response.'); }

      if (!Array.isArray(parsed)) throw new Error('Unexpected response format.');

      let updated = 0;
      const setting = document.getElementById('studioSetting')?.value.trim() || '';
      const productSel = document.getElementById('studioProduct');
      const productName = productSel ? (productSel.options[productSel.selectedIndex]?.text || '') : '';
      parsed.forEach(item => {
        const seg = segments[item.i];
        if (!seg || !item.script) return;
        seg.script = item.script.trim();
        // Rebuild veoPrompt so speech field reflects the new condensed script
        seg.veoPrompt = buildSegmentVeo3Prompt(item.i, seg.startTime, seg.endTime, seg.script, setting, productName, bgImageDataUrl);
        // Update the textareas in place
        const el = document.getElementById('script-seg-' + item.i);
        if (el) { el.value = seg.script; autoGrow(el); el.style.borderColor = '#60a5fa'; setTimeout(() => { if(el) el.style.borderColor = ''; }, 900); }
        const veoEl = document.getElementById('veo-seg-' + item.i);
        if (veoEl) { veoEl.value = seg.veoPrompt; autoGrow(veoEl); }
        seg.nbPrompt = '';
        const nbTa = document.getElementById('nb-seg-' + item.i);
        if (nbTa) { nbTa.value = ''; autoGrow?.(nbTa); }
        updated++;
      });

      saveSegments();
      if (btn) { btn.textContent = `✅ ${updated} condensed`; setTimeout(() => { const b = document.getElementById('condenseAllBtn'); if (b) { b.textContent = '✂ Condense'; b.disabled = false; } }, 2500); }
    } catch(err) {
      showToast('Condense failed: ' + err.message, 'error');
      if (btn) { btn.textContent = '✂ Condense'; btn.disabled = false; }
    }
  }

  // --- Generate NB Pro prompts for ALL producer-mode segments at once ---
  function generateAllNBPrompts() {
    const producerSegs = segments.filter(s => s._scriptOnly);
    if (producerSegs.length === 0) {
      showToast('No producer scenes found. Paste your script and click ✂ Split (8s) first.', 'warning');
      return;
    }
    const missing = producerSegs.filter(s => !s.frameDesc || !s.frameDesc.trim());
    if (missing.length > 0) {
      showConfirm(`${missing.length} scene${missing.length !== 1 ? 's are' : ' is'} missing a Visual Description. Generate anyway? (Those scenes will use script text only — run ✨ AI Describe Scenes first for best results.)`, () => {
        _doGenerateAllNBPrompts();
      });
      return;
    }
    _doGenerateAllNBPrompts();
  }

  function _doGenerateAllNBPrompts() {
    const btn = document.getElementById('genAllNBBtn');
    if (btn) { btn.textContent = '⏳ Building…'; btn.disabled = true; }

    let built = 0;
    segments.forEach((seg, i) => {
      if (!seg._scriptOnly) return;
      // Sync any live textarea edits before building
      const frameDescEl = document.getElementById('framedesc-seg-' + i);
      if (frameDescEl) seg.frameDesc = frameDescEl.value;
      const scriptEl = document.getElementById('script-seg-' + i);
      if (scriptEl) seg.script = scriptEl.value;

      const setting = document.getElementById('studioSetting')?.value.trim() || '';
      const avatarDesc = document.getElementById('avatarDesc')?.value.trim() || '';
      seg.nbPrompt = buildScriptOnlyNBPrompt(i, seg.script, setting, avatarDesc, bgImageDataUrl, seg.frameDesc || '');

      // Update textarea + expand NB toggle so the prompt is visible
      const nbEl = document.getElementById('nb-seg-' + i);
      const nbWrap = document.getElementById('nbpreview-wrap-' + i);
      const nbToggle = document.querySelector(`#seg-card-${i} .nb-toggle`);
      if (nbEl) {
        nbEl.value = seg.nbPrompt;
        nbEl.style.display = '';
        autoGrow(nbEl);
        nbEl.style.borderColor = 'var(--warning)';
        setTimeout(() => { if (nbEl) nbEl.style.borderColor = ''; }, 900);
      }
      if (nbWrap) nbWrap.style.display = 'flex';
      if (nbToggle) nbToggle.textContent = '▾ Hide';
      built++;
    });

    saveSegments();
    if (btn) {
      btn.textContent = `✅ ${built} done`;
      setTimeout(() => { btn.textContent = '🍌 Gen All NB'; btn.disabled = false; }, 2500);
    }
    showToast(`NB prompts built for ${built} scene${built !== 1 ? 's' : ''}`, 'success');
  }


  const _EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  function buildAvatarVoiceString() {
    const custom = (document.getElementById('avatarVoiceCustom')?.value || '').trim();
    // Guard: never let an autofilled email address leak into voice prompts
    if (custom && !_EMAIL_RE.test(custom)) return custom;
    const gender = (document.getElementById('avatarVoiceGender')?.value || '').trim();
    const age    = (document.getElementById('avatarVoiceAge')?.value    || '').trim();
    const tone   = (document.getElementById('avatarVoiceTone')?.value   || '').trim();
    const accent = (document.getElementById('avatarAccent')?.value       || '').trim();
    // Build natural phrase: e.g. "middle-aged warm and conversational female voice, soft Korean accent"
    const voiceParts = [age, tone, gender ? gender + ' voice' : ''].filter(Boolean).join(' ');
    return [voiceParts, accent].filter(Boolean).join(', ');
  }

  function saveAvatarVoice() {
    const v = buildAvatarVoiceString();
    DB.set('vs_avatar_voice', v).catch(() => {});
    const preview = document.getElementById('avatarVoicePreview');
    if (preview) preview.textContent = v ? '🎙 ' + v : '';
  }

  function saveAvatarProfile() {
    const descEl = document.getElementById('avatarDesc');
    if (!descEl) return;
    const desc = descEl.value.trim();
    DB.set('sm_avatar_profile', desc).catch(err => showToast('Save failed: ' + err.message, 'error'));
    saveAvatarVoice();
    const _rawCustom = (document.getElementById('avatarVoiceCustom')?.value || '').trim();
    const voiceData = {
      gender: document.getElementById('avatarVoiceGender')?.value || '',
      age:    document.getElementById('avatarVoiceAge')?.value    || '',
      tone:   document.getElementById('avatarVoiceTone')?.value   || '',
      accent: document.getElementById('avatarAccent')?.value      || '',
      // Never persist autofilled email addresses
      custom: _EMAIL_RE.test(_rawCustom) ? '' : _rawCustom,
    };
    DB.set('vs_avatar_voice_config', voiceData).catch(() => {});
    const note = document.getElementById('avatarSavedNote');
    if (note) { note.style.display = 'block'; setTimeout(() => note.style.display = 'none', 2500); }
  }

  async function loadAvatarProfile() {
    // Migration: move voice config from localStorage to DB if needed
    const _voiceConfigOld = localStorage.getItem('vs_avatar_voice_config');
    if (_voiceConfigOld) {
      try { await DB.set('vs_avatar_voice_config', JSON.parse(_voiceConfigOld)); } catch(_) {}
      localStorage.removeItem('vs_avatar_voice_config');
    }
    DB.get('sm_avatar_profile').then(saved => {
      const el = document.getElementById('avatarDesc');
      if (saved && el) el.value = saved;
    }).catch(err => { console.error('loadAvatarProfile:', err); showToast('Could not load avatar profile — please re-enter your description.', 'warning'); });
    // Restore voice config from DB
    try {
      let vc = await DB.get('vs_avatar_voice_config');
      if (typeof vc === 'string') { try { vc = JSON.parse(vc); } catch(_) { vc = null; } }
      if (vc) {
        if (document.getElementById('avatarVoiceGender')) document.getElementById('avatarVoiceGender').value = vc.gender || '';
        if (document.getElementById('avatarVoiceAge'))    document.getElementById('avatarVoiceAge').value    = vc.age    || '';
        if (document.getElementById('avatarVoiceTone'))   document.getElementById('avatarVoiceTone').value   = vc.tone   || '';
        if (document.getElementById('avatarAccent'))      document.getElementById('avatarAccent').value      = vc.accent || '';
        // Guard: never restore an email address into the custom override — browser autofill
        // can silently inject the user's email which then gets persisted on Save.
        const _safeCustom = (vc.custom || '').trim();
        const _isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(_safeCustom);
        if (_isEmail) {
          vc.custom = '';
          DB.set('vs_avatar_voice_config', vc).catch(() => {});
        }
        if (document.getElementById('avatarVoiceCustom')) document.getElementById('avatarVoiceCustom').value = _isEmail ? '' : _safeCustom;
        saveAvatarVoice();
      }
    } catch(e) {}
    // Browser autofill fires ~300–800ms after page render, overriding JS-set values.
    // Re-check the custom field after a short delay and clear any injected email.
    setTimeout(() => {
      const _el = document.getElementById('avatarVoiceCustom');
      if (_el && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(_el.value.trim())) {
        _el.value = '';
        saveAvatarVoice();
      }
    }, 900);
  }

  function generateStudioPrompts() {
    if (typeof getScenes !== 'function') { console.warn('generateStudioPrompts: getScenes not available'); return; }
    const avatarEl  = document.getElementById('avatarDesc');
    const scriptEl  = document.getElementById('originalScript');
    const videoUrlEl = document.getElementById('refVideoUrl');
    const avatar = avatarEl ? avatarEl.value.trim() : '';
    const videoUrl = videoUrlEl ? videoUrlEl.value.trim() : '';
    const product = document.getElementById('studioProduct') ? document.getElementById('studioProduct').value : '';
    const format = document.getElementById('studioFormat') ? document.getElementById('studioFormat').value : '';
    const setting = document.getElementById('studioSetting') ? document.getElementById('studioSetting').value.trim() : 'clean neutral background';
    const script = scriptEl ? scriptEl.value.trim() : '';
    const scenes = getScenes();

    if (!script && scenes.length === 0) {
      showToast('Please add the original script and/or at least one scene description.', 'warning');
      return;
    }

    const _pSel = document.getElementById('studioProduct');
    const productName = _pSel ? (_pSel.options[_pSel.selectedIndex]?.text || 'the product') : 'the product';

    // Build Nano Banana prompt
    const nbPrompt = buildNanoBananaPrompt(avatar, script, setting, format, productName, product);

    // Build Veo 3 prompts
    const veo3Prompts = buildVeo3Prompts(avatar, scenes, script, setting, format, productName, product);

    // Render output
    const output = document.getElementById('studioOutput');
    if (!output) return;
    output.innerHTML = '';

    // Avatar + video reference row at top
    if (avatarImageDataUrl || document.getElementById('refVideoUrl')?.value) {
      const refRow = document.createElement('div');
      refRow.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:10px;padding:8px;background:#0d0d0d;border:1px solid #1e1e1e;border-radius:2px;';
      refRow.innerHTML = (avatarImageDataUrl ? `<img src="${avatarImageDataUrl}" style="width:40px;height:40px;object-fit:cover;border-radius:2px;border:1px solid #2a2a2a;flex-shrink:0;">` : '') +
        `<div style="flex:1;"><div style="font-size:10px;color:var(--text-2);font-weight:600;">Avatar photo ${avatarImageDataUrl ? '✓ uploaded' : '— not set'}</div>
        <div style="font-size:10px;color:var(--text-3);margin-top:2px;">Product: ${escHtml(productName)}</div></div>`;
      output.appendChild(refRow);
    }

    // Nano Banana block
    const nbBlock = document.createElement('div');
    nbBlock.className = 'prompt-block';
    nbBlock.innerHTML = `<div class="prompt-block-label">
        <span>🍌 Nano Banana — Avatar Video Prompt</span>
        <button class="btn-copy" onclick="copyPromptBlock('nb-text')">Copy</button>
      </div>
      <div class="prompt-block-text" id="nb-text">${escHtml(nbPrompt)}</div>`;
    output.appendChild(nbBlock);

    // Veo 3 blocks
    veo3Prompts.forEach((p, i) => {
      const block = document.createElement('div');
      block.className = 'prompt-block';
      block.innerHTML = `<div class="prompt-block-label">
          <span>🎬 Veo 3 — ${escHtml(p.label)}</span>
          <button class="btn-copy" onclick="copyPromptBlock('veo-text-${i}')">Copy</button>
        </div>
        <div class="prompt-block-text" id="veo-text-${i}">${escHtml(p.prompt)}</div>`;
      output.appendChild(block);
    });

    // Show save button
    const _spb = document.getElementById('savePromptsBtn');
    if (_spb) _spb.style.display = 'inline-block';

    // Store current generation for saving
    window._lastGeneration = {
      id: _uid(),
      title: productName + (videoUrl ? ' — ' + videoUrl.substring(0, 40) + '...' : ''),
      videoUrl,
      product: productName,
      nbPrompt,
      veo3Prompts,
      date: new Date().toLocaleDateString()
    };
  }

  function buildNanoBananaPrompt(avatar, script, setting, format, productName, productDetails) {
    const hasImage = !!avatarImageDataUrl;

    const avatarSection = hasImage
      ? `AVATAR REFERENCE IMAGE: ✅ Uploaded — use the person in the attached photo as the avatar. Match their exact appearance: face, skin tone, hair, and features precisely.\n${avatar ? `ADDITIONAL NOTES: ${avatar}` : ''}`
      : `AVATAR DESCRIPTION: ${avatar || '[No avatar photo uploaded — add one in the Avatar section for best results]'}`;

    const scriptText = script || `[Watch the reference video above, type the script, and it will appear here]`;

    const formatNote = format.includes('Greenscreen')
      ? 'Greenscreen setup. Avatar stands in front of a digital background — use a natural outdoor or kitchen environment behind them.'
      : format.includes('B-roll')
      ? 'Primary talking head shot. Cut to B-roll of the product between speaking segments.'
      : 'Clean single-shot talking head. Avatar speaks directly and confidently to camera the entire time.';

    return `NANO BANANA — Video Recreation Prompt
=======================================

${avatarSection}

SETTING: ${setting || 'clean neutral dark background'}. Natural soft lighting — warm and flattering. Realistic depth.

FORMAT: ${formatNote}

DELIVERY STYLE: The avatar speaks directly to camera with genuine confidence and warmth. Natural hand gestures. Authentic energy — not stiff or robotic. Real eye contact. Sounds and feels like a real person making a genuine recommendation.

PRODUCT BEING PROMOTED: ${productName || '[select product]'}
${productDetails ? `PRODUCT DETAILS: ${productDetails}` : ''}

SCRIPT TO DELIVER:
---
${scriptText}
---

TECHNICAL SPECS:
- Vertical format 9:16 (portrait / Reels / TikTok)
- Photorealistic — no AI artifacts, no uncanny valley
- Natural skin texture, realistic lighting falloff, real background depth
- Match the energy and pacing of a real health & wellness creator
- The avatar IS the main speaker for the entire video`;
  }

  function buildVeo3Prompts(avatar, scenes, script, setting, format, productName, productDetails) {
    const prompts = [];
    const baseAvatar = (avatar || '').split(',')[0] || 'person';

    // Hook scene
    prompts.push({
      label: 'Scene 1 — Hook (0–3 seconds)',
      prompt: `Cinematic vertical video (9:16). Opening shot: ${baseAvatar} in ${setting || 'a clean natural environment'}. The person is looking directly into camera with a serious, knowing expression — about to say something important. Natural handheld camera feel. Warm soft lighting. Photorealistic. No text. 3 seconds.`
    });

    // Custom scenes from user input
    scenes.forEach(s => {
      prompts.push({
        label: `Scene ${s.num} — ${s.desc.substring(0, 40)}...`,
        prompt: `Cinematic vertical video (9:16). ${baseAvatar}. Setting: ${setting || 'natural environment'}. ${s.desc}. Warm natural lighting. Realistic, documentary-style camera work. Photorealistic quality. Product being promoted: ${productName}.`
      });
    });

    // Product reveal scene
    if (productDetails) {
      prompts.push({
        label: 'Product Reveal Scene',
        prompt: `Cinematic vertical video (9:16). Close-up shot: ${baseAvatar} holds up the product (${productName}) to camera with one hand, smiling slightly. The product label is clearly visible. Setting: ${setting || 'natural environment'}. Warm natural lighting. The person nods as if to say "this is the one." Photorealistic. 3–5 seconds.`
      });
    }

    // CTA scene
    prompts.push({
      label: 'CTA Scene — Comment Hook Ending',
      prompt: `Cinematic vertical video (9:16). ${baseAvatar} in ${setting || 'natural environment'}, looking into camera with a warm smile. They point directly at the viewer as if talking to them personally. Natural energy, relaxed and authentic. This is the final 3 seconds of a short-form health & wellness video promoting ${productName}. Warm lighting, photorealistic, vertical format.`
    });

    return prompts;
  }

  // Copy from a div (legacy)
  function copyPromptBlock(id) {
    const el = document.getElementById(id);
    if (!el) return;
    const text = el.tagName === 'TEXTAREA' ? el.value : el.innerText;
    navigator.clipboard.writeText(text).then(() => {
      const btn = el.previousElementSibling?.querySelector('.btn-copy') || el.parentElement?.querySelector('.btn-copy');
      if (btn) { btn.textContent = 'Copied!'; btn.classList.add('copied'); setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000); }
    }).catch(() => showToast('Copy failed.', 'error'));
  }

  // Copy from a textarea prompt field
  function copyPromptTA(id) {
    const el = document.getElementById(id);
    if (!el) return;
    const text = el.value || el.innerText || '';
    navigator.clipboard.writeText(text).then(() => {
      // Find the Copy button in the same header row (previous sibling div)
      const header = el.previousElementSibling;
      const btn = header ? header.querySelector('.btn-copy') : null;
      if (btn) { btn.textContent = 'Copied!'; btn.classList.add('copied'); setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000); }
    }).catch(() => showToast('Copy failed.', 'error'));
  }

  function saveGeneratedToLibrary() {
    if (segments.length === 0) { showToast('Generate prompts first.', 'warning'); return; }
    const productSel = document.getElementById('studioProduct');
    const productName = productSel && productSel.selectedIndex >= 0 ? (productSel.options[productSel.selectedIndex]?.text || 'Untitled') : 'Untitled';
    const settingVal = document.getElementById('studioSetting')?.value.trim() || '';
    const avatarDescVal = document.getElementById('avatarDesc')?.value.trim() || '';
    const item = {
      id: _uid(),
      product: productName,
      setting: settingVal,
      avatarDesc: avatarDescVal,
      avatarImageDataUrl: avatarImageDataUrl || null,
      bgImageDataUrl: bgImageDataUrl || null,
      bgFromAvatar: bgFromAvatar,
      date: new Date().toLocaleDateString(),
      segmentCount: segments.length,
      segments: segments.map(s => ({
        startTime: s.startTime, endTime: s.endTime,
        frameDataUrl: s.frameDataUrl || null,
        script: s.script, action: s.action || '',
        nbPrompt: s.nbPrompt || '',
        nbEndPrompt: s.nbEndPrompt || '',
        nbPreviewDataUrl: s.nbPreviewDataUrl || null,
        veoPrompt: s.veoPrompt || '',
        frameDesc: s.frameDesc || '',
        _scriptOnly: s._scriptOnly || false,
        done: s.done || false,
        isCTA: s.isCTA || false,
        ctaProductName: s.ctaProductName || '',
        showProduct: s.showProduct || false,
        targetX: s.targetX ?? null, targetY: s.targetY ?? null,
        targetPerson: s.targetPerson || '',
        targetGender: s.targetGender || '',
      }))
    };
    studioLibrary.unshift(item);
    saveStudioLibrary();
    DB.set(modeKey('sm_bg_from_avatar'), bgFromAvatar ? '1' : '').catch(() => {});
    renderStudioLibrary();
    const btn = document.getElementById('saveAllBtn');
    if (btn) { btn.textContent = 'Project Saved'; setTimeout(() => btn.textContent = '💾 Save Run to Library', 2000); }
  }

  function renderStudioLibrary() {
    const container = document.getElementById('studioLibrary');
    if (!container) return;
    // Update both the More-menu badge and the modal header badge
    const countText = studioLibrary.length > 0 ? `(${studioLibrary.length})` : '';
    ['libCount','libCountModal'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.textContent = countText;
    });
    if (studioLibrary.length === 0) {
      container.innerHTML = '<div style="font-size:11px;color:var(--text-3);text-align:center;padding:16px 0;">No saved recreations yet<p style="font-size:11px;color:rgba(156,163,175,0.5);margin-top:6px;">Generate prompts for any project, then click "Save Run to Library" to archive it here.</p></div>';
      return;
    }
    container.innerHTML = studioLibrary.map((item, i) => `
      <div class="lib-item">
        <div class="lib-item-title">
          <span>${escHtml(item.product || 'Untitled')}</span>
          <div style="display:flex;gap:4px;">
            <button class="btn-copy" onclick="loadLibraryItem(${i})">Load</button>
            <button class="action-btn action-delete" onclick="deleteLibraryItem(${i})" style="padding:2px 6px;font-size:10px;">✕</button>
          </div>
        </div>
        <div class="lib-item-meta">${escHtml(item.date)} · ${item.segmentCount || 0} segments</div>
      </div>`).join('');
  }

  function loadLibraryItem(i) {
    const item = studioLibrary[i];
    if (!item) return;
    try {

    // Preserve current project before loading library item
    saveCurrentProjectData();

    // Restore segments
    if (item.segments && item.segments.length > 0) {
      segments = (item.segments || []).filter(Boolean).map(s => ({ ...s }));
      renderSegments();
    }

    // Restore avatar description + product + setting
    const avatarDescEl = document.getElementById('avatarDesc');
    if (avatarDescEl && item.avatarDesc) avatarDescEl.value = item.avatarDesc;
    const productSel = document.getElementById('studioProduct');
    if (productSel && item.product) {
      const opt = Array.from(productSel.options).find(o => o.text === item.product);
      if (opt) productSel.value = opt.value;
    }
    const settingEl = document.getElementById('studioSetting');
    if (settingEl && item.setting) settingEl.value = item.setting;

    // Restore avatar image
    if (item.avatarImageDataUrl) {
      avatarImageDataUrl = item.avatarImageDataUrl;
      const img = document.getElementById('avatarImgEl');
      const placeholder = document.getElementById('avatarImgPlaceholder');
      if (img) { img.src = avatarImageDataUrl; img.style.display = 'block'; }
      if (placeholder) placeholder.style.display = 'none';
      const clearBtn = document.getElementById('clearAvatarImgBtn');
      if (clearBtn) clearBtn.style.display = 'block';
      // Clear stale inventory so old avatar details aren't sent to Claude
      avatarInventory = '';
      const _invTa = document.getElementById('avatarInventory');
      if (_invTa) _invTa.value = '';
      // Re-extract inventory for the restored avatar
      if (typeof extractAvatarInventory === 'function') extractAvatarInventory(avatarImageDataUrl);
    }

    // Restore background image + flag
    if (item.bgImageDataUrl) {
      bgFromAvatar = item.bgFromAvatar || false;
      DB.set(modeKey('sm_bg_from_avatar'), bgFromAvatar ? '1' : '').catch(() => {});
      _applyBgToUI(item.bgImageDataUrl);
    }

    // Persist everything
    saveCurrentProjectData();
    if (item.avatarImageDataUrl) DB.set('sm_avatar_img', item.avatarImageDataUrl).catch(e => console.warn('loadLibraryItem avatar error:', e));
    if (item.bgImageDataUrl) DB.set('sm_bg_image', item.bgImageDataUrl).catch(e => console.warn('loadLibraryItem bg error:', e));
    if (avatarDescEl) DB.set('sm_avatar_profile', avatarDescEl.value).catch(e => console.warn('loadLibraryItem profile error:', e));

    // Close modal so the user can see the restored segments
    closeSavedLibraryModal();
    showToast(`✅ Loaded "${item.product || 'Untitled'}" — ${item.segmentCount || 0} segment${(item.segmentCount || 0) !== 1 ? 's' : ''} restored.`, 'success', 3000);

    } catch(err) {
      console.error('[loadLibraryItem] error:', err);
      showToast('Failed to load — this entry may be corrupted. Try deleting and re-saving.', 'error');
      return;
    }
  }

  function deleteLibraryItem(i) {
    showConfirm('Delete this library item? This cannot be undone.', () => {
      studioLibrary.splice(i, 1);
      saveStudioLibrary();
      renderStudioLibrary();
    });
  }

  function populateAvatarAccountPicker() {
    const sel = document.getElementById('avatarAccountPicker');
    if (!sel) return;
    // keep the first placeholder option
    sel.innerHTML = '<option value="">— Load from My Accounts —</option>';
    accounts.forEach(a => {
      if (!a.avatar) return; // only show accounts that have a pfp
      const opt = document.createElement('option');
      opt.value = a.id;
      const emoji = platformEmojis[a.platform] || '🌐';
      opt.textContent = `${emoji} ${a.username} (${a.platform})`;
      sel.appendChild(opt);
    });
  }

  function loadAvatarFromAccount() {
    const sel = document.getElementById('avatarAccountPicker');
    const id = sel.value;
    if (!id) return;
    const acct = accounts.find(a => a.id === id);
    if (!acct || !acct.avatar) return;
    // Set the image in the studio avatar preview
    const img = document.getElementById('avatarImgEl');
    const placeholder = document.getElementById('avatarImgPlaceholder');
    const clearBtn = document.getElementById('clearAvatarImgBtn');
    if (img)         { img.src = acct.avatar; img.style.display = 'block'; }
    if (placeholder) placeholder.style.display = 'none';
    if (clearBtn)    clearBtn.style.display = 'block';
    // Keep the in-memory avatar in sync so generation steps pick it up immediately
    avatarImageDataUrl = acct.avatar;
    // Persist it so it survives save (must match the key loadAvatarImage() reads: sm_avatar_img)
    DB.set('sm_avatar_img', acct.avatar).catch(e => console.warn('loadAvatarFromAccount: DB write failed', e));
    // Auto-extract the appearance inventory from this avatar photo
    extractAvatarInventory(acct.avatar);
    sel.value = '';
  }


  // ===== VIDEO STUDIO PROJECTS =====
  let projects = [];
  let activeProjectId = null;

  // Returns a mode-namespaced DB key so Replicator and Producer
  // never share the same projects, library, or active-project pointer.
  function modeKey(base) {
    return base + (studioMode === 'producer' ? '_p' : '_r');
  }

  function getActiveProject() {
    return projects.find(p => p.id === activeProjectId) || null;
  }

  function saveCurrentProjectData() {
    const p = getActiveProject();
    if (!p) return;
    p.originalScript  = document.getElementById('originalScript')?.value || '';
    p.whisperSegments = whisperSegments;
    if (typeof _activeLibraryVideoId !== 'undefined' && _activeLibraryVideoId)
      p.libraryVideoId = _activeLibraryVideoId;
    p.segments = segments.map(s => ({
      startTime: s.startTime, endTime: s.endTime,
      frameDataUrl: s.frameDataUrl || null,
      script: s.script || '', action: s.action || '',
      sceneNotes: s.sceneNotes || '',
      nbPrompt: s.nbPrompt || '',
      nbEndPrompt: s.nbEndPrompt || '',
      nbPreviewDataUrl: s.nbPreviewDataUrl || null,
      veoPrompt: s.veoPrompt || '',
      frameDesc: s.frameDesc || '',
      _scriptOnly: s._scriptOnly || false,
      done: s.done || false,
      targetPerson: s.targetPerson || '',
      targetGender: s.targetGender || '',
      targetX: s.targetX ?? null,
      targetY: s.targetY ?? null,
      isCTA: s.isCTA || false,
      ctaProductName: s.ctaProductName || '',
      showProduct: s.showProduct || false,
      _shotlessData: s._shotlessData || null,
      veoExtras: s.veoExtras && s.veoExtras.length ? s.veoExtras.map(function(e){ return { speech: e.speech || '', action: e.action || '', veoPrompt: e.veoPrompt || '', apiVideoUrl: e.apiVideoUrl || null, apiVideoMime: e.apiVideoMime || null }; }) : [],
      apiVideoUrl:  s.apiVideoUrl  || null,
      apiVideoMime: s.apiVideoMime || null,
    }));
    p.bgImageDataUrl = (typeof bgImageDataUrl !== 'undefined' ? bgImageDataUrl : null) || null;
    p.bgFromAvatar   = (typeof bgFromAvatar !== 'undefined' ? bgFromAvatar : false) || false;
    DB.set(modeKey('sm_projects'), JSON.stringify(projects)).catch(e => console.warn('saveCurrentProjectData error:', e));
  }

  function loadProjectData() {
    const p = getActiveProject();
    if (!p) return;
    segments        = (p.segments || []).map(s => ({ ...s }));
    // Restore background state per project
    if (typeof p.bgImageDataUrl !== 'undefined') {
      bgImageDataUrl = p.bgImageDataUrl || null;
      bgFromAvatar   = p.bgFromAvatar   || false;
      if (typeof _applyBgToUI === 'function') _applyBgToUI(bgImageDataUrl);
    }
    whisperSegments = p.whisperSegments || [];
    whisperWords    = [];
    _activeLibraryVideoId = p.libraryVideoId || null;
    // Clear undo stack and rewrite cache so they don't bleed across projects
    if (typeof _undoStack !== 'undefined') _undoStack = [];
    if (typeof rewrittenSegScripts !== 'undefined') rewrittenSegScripts = {};
    const _osel = document.getElementById('originalScript');
    if (_osel) _osel.value = p.originalScript || '';
    renderSegments();

    // Re-fetch blob URLs for any segments whose apiVideoUrl survived the save.
    // Blob URLs (blob:http://…) die on page unload, so we store the raw Google
    // URI and rebuild the local blob URL after load. Runs async after a short
    // delay so 15-veo-api.js (which exposes window._fetchVideoAsBlob) has loaded.
    var _segsWithVideo = segments.filter(function(s) { return s.apiVideoUrl; });
    var _segsWithExtras = segments.filter(function(s) { return s.veoExtras && s.veoExtras.some(function(e){ return e.apiVideoUrl; }); });
    if (_segsWithVideo.length || _segsWithExtras.length) {
      setTimeout(async function() {
        var _fetchBlob = window._fetchVideoAsBlob;
        if (typeof _fetchBlob !== 'function') return;
        var changed = false;
        // Re-blob main segment videos
        for (var _vi = 0; _vi < _segsWithVideo.length; _vi++) {
          var _vs = _segsWithVideo[_vi];
          if (!_vs.apiVideoUrl) continue;
          try {
            var _blob = await _fetchBlob(_vs.apiVideoUrl);
            if (_blob) { _vs.apiVideoRaw = _blob; changed = true; }
          } catch(_) {}
        }
        // Re-blob continuation clip videos (veoExtras)
        for (var _ei = 0; _ei < _segsWithExtras.length; _ei++) {
          var _es = _segsWithExtras[_ei];
          for (var _ej = 0; _ej < (_es.veoExtras || []).length; _ej++) {
            var _ex = _es.veoExtras[_ej];
            if (!_ex.apiVideoUrl) continue;
            try {
              var _exBlob = await _fetchBlob(_ex.apiVideoUrl);
              if (_exBlob) { _ex.apiVideoRaw = _exBlob; changed = true; }
            } catch(_) {}
          }
        }
        if (changed) {
          if (typeof renderSegments  === 'function') renderSegments();
          if (typeof renderGallery   === 'function') renderGallery();
          if (typeof renderAssembler === 'function') renderAssembler();
        }
      }, 800);
    }
  }

  function renderProjectBar() {
    const bar = document.getElementById('projectBar');
    if (!bar) return;
    const p = getActiveProject();
    bar.innerHTML = `
      <span style="font-size:11px;color:var(--text-3);flex-shrink:0;">Project</span>
      <select onchange="switchProject(this.value)" style="font-size:11px;padding:3px 8px;background:var(--surface-2);border:1px solid var(--border-2);border-radius:4px;color:var(--text-1);font-family:inherit;outline:none;max-width:220px;flex:1;">
        ${projects.map(pr => `<option value="${escHtml(pr.id)}" ${pr.id === activeProjectId ? 'selected' : ''}>${escHtml(pr.name)}</option>`).join('')}
      </select>
      <button class="btn" onclick="renameProject()" style="padding:2px 8px;font-size:10px;" title="Rename project"><i class="ti ti-pencil" style="font-size:11px;vertical-align:-1px;"></i> Rename</button>
      <button class="btn" onclick="newProject()" style="padding:2px 10px;font-size:11px;flex-shrink:0;">+ New</button>
      <button class="btn" onclick="exportProjectJSON()" style="padding:2px 8px;font-size:10px;color:var(--accent-2);border-color:rgba(124,106,247,0.4);" title="Export project as JSON file"><i class="ti ti-download" style="font-size:11px;vertical-align:-1px;"></i> Export</button>
      <button class="btn" onclick="document.getElementById('projectImportInput').click()" style="padding:2px 8px;font-size:10px;color:var(--text-2);" title="Import project from JSON file"><i class="ti ti-upload" style="font-size:11px;vertical-align:-1px;"></i> Import</button>
      <input type="file" id="projectImportInput" accept=".json" style="display:none;" onchange="importProjectJSON(this)">
      ${(projects.length > 1 && p) ? `<button class="btn" onclick="deleteProject(${escHtml(JSON.stringify(p.id))})" style="padding:2px 8px;font-size:10px;color:var(--danger);border-color:#3a2020;" title="Delete project">🗑</button>` : ''}
    `;
  }

  async function loadProjects() {
    const raw     = await DB.get(modeKey('sm_projects'));
    const savedId = await DB.get(modeKey('sm_active_project'));
    try { projects = JSON.parse(raw || '[]'); } catch(e) { projects = []; }

    if (projects.length === 0) {
      // For Replicator: try to migrate legacy un-namespaced data (one-time)
      if (studioMode === 'replicator') {
        const legacyRaw = await DB.get('sm_projects');
        let legacyProjects = []; try { legacyProjects = JSON.parse(legacyRaw || '[]'); } catch(e) {}
        if (legacyProjects.length > 0) {
          projects = legacyProjects;
        }
      }
      // Still empty? Create a default project
      if (projects.length === 0) {
        let oldSegs = []; try { oldSegs = JSON.parse(await DB.get('sm_segments') || '[]'); } catch(e) {}
        const label = studioMode === 'producer' ? 'Producer Project 1' : 'Project 1';
        projects.push({
          id: _uid(),
          name: label,
          segments: studioMode === 'replicator' ? oldSegs : [],
          originalScript: '',
          whisperSegments: []
        });
      }
    }

    activeProjectId = (savedId && projects.find(p => p.id === savedId))
      ? savedId
      : projects[0].id;

    DB.set(modeKey('sm_projects'), JSON.stringify(projects)).catch(e => console.warn('loadProjects save error:', e));
    DB.set(modeKey('sm_active_project'), activeProjectId).catch(e => console.warn('loadProjects active save error:', e));
    loadProjectData();
    renderProjectBar();
  }

  function newProject() {
    saveCurrentProjectData();
    const defaultName = studioMode === 'producer'
      ? `Producer ${projects.length + 1}`
      : `Project ${projects.length + 1}`;
    const name = prompt('Project name:', defaultName);
    if (!name) return;
    const p = { id: _uid(), name, segments: [], originalScript: '', whisperSegments: [] };
    projects.push(p);
    activeProjectId = p.id;
    DB.set(modeKey('sm_projects'), JSON.stringify(projects)).catch(e => console.warn('newProject save error:', e));
    DB.set(modeKey('sm_active_project'), activeProjectId).catch(e => console.warn('newProject active save error:', e));
    loadProjectData();
    renderProjectBar();
    _resetVideoUI(); // silently clear video UI — new project has no video, no confirm needed
  }

  function switchProject(id) {
    if (id === activeProjectId) return;
    saveCurrentProjectData();
    activeProjectId = id;
    DB.set(modeKey('sm_active_project'), activeProjectId).catch(e => console.warn('switchProject save error:', e));
    loadProjectData(); // loads new project's segments before we touch the UI
    renderProjectBar();
    _resetVideoUI(); // silently clear video UI — don't wipe newly-loaded project segments
  }

  function renameProject() {
    const p = getActiveProject();
    if (!p) return;
    const name = prompt('Rename project:', p.name);
    if (!name || name === p.name) return;
    p.name = name;
    DB.set(modeKey('sm_projects'), JSON.stringify(projects)).catch(e => console.warn('renameProject save error:', e));
    renderProjectBar();
  }

  function deleteProject(id) {
    if (projects.length <= 1) { showToast('Can\'t delete the only project.', 'warning'); return; }
    showConfirm('Delete this project and all its segments?', () => {
      projects = projects.filter(p => p.id !== id);
      if (activeProjectId === id) activeProjectId = projects[0].id;
      DB.set(modeKey('sm_projects'), JSON.stringify(projects)).catch(e => console.warn('deleteProject save error:', e));
      DB.set(modeKey('sm_active_project'), activeProjectId).catch(e => console.warn('deleteProject active save error:', e));
      loadProjectData();
      renderProjectBar();
    });
  }

  // ── Export / Import project as JSON ──────────────────────────────────────
  function exportProjectJSON() {
    const p = getActiveProject();
    if (!p) return;
    const exportData = {
      _app: 'AffiliateOS VideoStudio',
      _version: 1,
      _exported: new Date().toISOString(),
      mode: studioMode,
      project: JSON.parse(JSON.stringify(p)), // deep clone
      avatarDesc: document.getElementById('avatarDesc')?.value || '',
      setting: document.getElementById('studioSetting')?.value || '',
      product: document.getElementById('studioProduct')?.value || '',
      format: document.getElementById('studioFormat')?.value || '',
      // Include images so the project is fully self-contained on import
      avatarImageDataUrl: avatarImageDataUrl || null,
      bgImageDataUrl: bgImageDataUrl || null,
    };
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    const safeName = (p.name || 'project').replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
    a.href     = url;
    a.download = `affiliateos_${safeName}_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function importProjectJSON(input) {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const data = JSON.parse(ev.target.result);
        if (!data._app || !data.project) throw new Error('Not a valid AffiliateOS project file');
        const imported = data.project;
        imported.id   = _uid();
        imported.name = (imported.name || 'Imported') + ' (imported)';
        projects.push(imported);
        activeProjectId = imported.id;
        DB.set(modeKey('sm_projects'), JSON.stringify(projects)).catch(e => console.warn('importProjectJSON save error:', e));
        DB.set(modeKey('sm_active_project'), activeProjectId).catch(e => console.warn('importProjectJSON active save error:', e));
        loadProjectData();
        renderProjectBar();
        // Restore settings
        if (data.setting && document.getElementById('studioSetting')) document.getElementById('studioSetting').value = data.setting;
        if (data.product && document.getElementById('studioProduct')) document.getElementById('studioProduct').value = data.product;
        if (data.format  && document.getElementById('studioFormat'))  document.getElementById('studioFormat').value  = data.format;
        if (data.avatarDesc && document.getElementById('avatarDesc')) document.getElementById('avatarDesc').value = data.avatarDesc;
        // Restore avatar and background images (included in v1+ exports)
        if (data.avatarImageDataUrl) {
          avatarImageDataUrl = data.avatarImageDataUrl;
          const img = document.getElementById('avatarImgEl');
          if (img) { img.src = avatarImageDataUrl; img.style.display = 'block'; }
          const ph = document.getElementById('avatarImgPlaceholder');
          if (ph) ph.style.display = 'none';
          const cb = document.getElementById('clearAvatarImgBtn');
          if (cb) cb.style.display = 'block';
          DB.set('sm_avatar_img', avatarImageDataUrl).catch(() => {});
        }
        if (data.bgImageDataUrl) {
          _applyBgToUI(data.bgImageDataUrl);
          DB.set('sm_bg_image', data.bgImageDataUrl).catch(() => {});
        }
        showToast(`Imported "${imported.name}" — ${(imported.segments||[]).length} scene(s) loaded.`, 'success');
      } catch (e) {
        showToast('Import failed: ' + e.message, 'error');
      } finally {
        input.value = '';
      }
    };
    reader.readAsText(file);
  }


  // ===== VIDEO PRODUCER WORKFLOW =====

  let _producerFormatData = null;   // format analysis string from analyzeVideoFormat()
  let _producerScenes     = [];     // [{speech, visual}] — structured output from generateProducerScript()
  let _producerScriptMode = 'generate';
  let _styleAnchorFrame   = null;   // data URL of re-uploaded rendered hook frame
  let _producerNBFrames   = { hook: '', body: '', cta: '' };
  let _refVideoDuration    = 0;   // seconds of the uploaded reference video
  let _refVideoSceneCount  = 0;   // Math.max(3, Math.round(_refVideoDuration / 8))

  // ── Helper: capture N evenly-spaced frames from the reference video file ──
  async function captureFramesFromRefVideo(count) {
    count = count || 6;
    if (!refVideoFile) return [];
    return new Promise(function(resolve) {
      var url   = URL.createObjectURL(refVideoFile);
      var video = document.createElement('video');
      video.src        = url;
      video.muted      = true;
      video.playsInline = true;
      video.crossOrigin = 'anonymous';

      video.addEventListener('error', function() { URL.revokeObjectURL(url); resolve([]); });

      video.addEventListener('loadedmetadata', async function() {
        var dur = video.duration;
        if (!dur || !isFinite(dur)) { URL.revokeObjectURL(url); resolve([]); return; }

        var frames = [];
        var times  = [];
        for (var i = 0; i < count; i++) times.push(dur * (i + 0.5) / count);

        for (var ti = 0; ti < times.length; ti++) {
          var t = times[ti];
          await new Promise(function(r) {
            video.addEventListener('seeked', r, { once: true });
            video.currentTime = t;
          });
          var c  = document.createElement('canvas');
          var vw = video.videoWidth  || 480;
          var vh = video.videoHeight || 854;
          c.width  = Math.min(vw, 480);
          c.height = Math.round(c.width * vh / vw);
          c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
          frames.push(c.toDataURL('image/jpeg', 0.7));
        }

        URL.revokeObjectURL(url);
        resolve(frames);
      });

      video.load();
    });
  }

  // ── onProducerVideoSelect: file picked → set refVideoFile → auto-transcribe ──
  async function onProducerVideoSelect(event) {
    var file = event.target.files && event.target.files[0];
    if (event.target) event.target.value = '';
    if (!file) return;

    refVideoFile = file;

    // Reset previous scene-count estimate
    _refVideoDuration   = 0;
    _refVideoSceneCount = 0;

    // Probe video duration before transcription starts (no round-trip — local file)
    await new Promise(function(resolve) {
      var tmp = document.createElement('video');
      var blobUrl = URL.createObjectURL(file);
      tmp.src     = blobUrl;
      tmp.preload = 'metadata';
      tmp.onloadedmetadata = function() {
        _refVideoDuration   = isFinite(tmp.duration) ? tmp.duration : 0;
        _refVideoSceneCount = _refVideoDuration > 0 ? Math.max(3, Math.round(_refVideoDuration / 8)) : 0;
        URL.revokeObjectURL(blobUrl);
        resolve();
      };
      tmp.onerror = function() { URL.revokeObjectURL(blobUrl); resolve(); };
      tmp.load();
    }).catch(function() {});

    var label    = document.getElementById('producerRefVideoLabel');
    var statusEl = document.getElementById('producerRefVideoStatus');
    var zone     = document.getElementById('producerRefVideoZone');

    if (label)    label.textContent = '⏳ Transcribing ' + file.name + '…';
    if (statusEl) { statusEl.textContent = 'Sending to Whisper…'; statusEl.style.display = 'block'; statusEl.style.color = 'var(--text-3)'; }
    if (zone)     zone.style.borderColor = 'rgba(124,106,247,0.7)';

    try {
      await transcribeVideo();
      if (label)    label.textContent = '✅ ' + file.name + ' — transcribed' + (_refVideoSceneCount > 0 ? ' (~' + _refVideoSceneCount + ' scenes)' : '');
      if (statusEl) { statusEl.textContent = 'Script ready. Click Analyze Format or Write Script.'; statusEl.style.color = '#7acc7a'; }
      if (zone)     { zone.style.borderColor = '#3a5a3a'; zone.style.background = 'rgba(74,222,128,0.04)'; }
    } catch (err) {
      if (label)    label.textContent = '✗ Transcription failed — ' + err.message;
      if (statusEl) { statusEl.textContent = ''; statusEl.style.display = 'none'; }
      if (zone)     zone.style.borderColor = 'rgba(124,106,247,0.45)';
      refVideoFile = null;
    }
  }

  function onProducerTypeChange(val) {
    var opts = document.getElementById('producerMiniChatOpts');
    if (!opts) return;
    opts.style.display = (val === 'minichat' || val === 'reveal') ? 'flex' : 'none';
  }

  function setProducerScriptMode(mode) {
    _producerScriptMode = mode;
    var genBtn    = document.getElementById('producerModeGenBtn');
    var pasteBtn  = document.getElementById('producerModePasteBtn');
    var writeBtn  = document.getElementById('producerGenScriptBtn');
    var pasteHint = document.getElementById('producerPasteHint');
    if (mode === 'generate') {
      if (genBtn)   { genBtn.style.background   = 'var(--grad-accent)'; genBtn.style.color   = '#fff'; genBtn.style.border = '1px solid rgba(167,139,250,0.5)'; }
      if (pasteBtn) { pasteBtn.style.background = 'var(--glass-2)';     pasteBtn.style.color = 'var(--text-2)'; pasteBtn.style.border = '1px solid var(--glass-border)'; }
      if (writeBtn)  writeBtn.style.display  = '';
      if (pasteHint) pasteHint.style.display = 'none';
    } else {
      if (pasteBtn) { pasteBtn.style.background = 'var(--grad-accent)'; pasteBtn.style.color = '#fff'; pasteBtn.style.border = '1px solid rgba(167,139,250,0.5)'; }
      if (genBtn)   { genBtn.style.background   = 'var(--glass-2)';     genBtn.style.color   = 'var(--text-2)'; genBtn.style.border = '1px solid var(--glass-border)'; }
      if (writeBtn)  writeBtn.style.display  = 'none';
      if (pasteHint) pasteHint.style.display = 'block';
    }
  }

  // ── analyzeVideoFormat: capture frames + transcript → GPT-4o visual breakdown ──
  async function analyzeVideoFormat() {
    var btn      = document.getElementById('analyzeFormatBtn');
    var resultEl = document.getElementById('producerFormatResult');
    if (!btn || !resultEl) return;

    var transcript = (document.getElementById('originalScript') && document.getElementById('originalScript').value || '').trim();
    if (!transcript && !refVideoFile) {
      showToast('Upload a reference video first — it will auto-transcribe, then you can analyze its format.', 'warning');
      return;
    }
    if (!transcript) {
      showToast('Transcription is still in progress. Wait a moment then try again.', 'warning');
      return;
    }

    btn.textContent = '⏳ Capturing frames…';
    btn.disabled = true;
    resultEl.style.display = 'none';

    // Capture up to 6 frames directly from the video file
    var frames = [];
    if (refVideoFile) {
      try {
        btn.textContent = '⏳ Analyzing…';
        frames = await captureFramesFromRefVideo(6);
      } catch(e) { frames = []; }
    }

    // Build vision message
    var frameParts = frames.map(function(dataUrl) {
      return { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } };
    });

    var promptText = 'You are a viral short-form video director analyzing a reference affiliate marketing video. Use the transcript and video frames provided.\n\nTranscript:\n' + transcript.slice(0, 3000) + '\n\nProvide TWO sections:\n\n1. FORMAT BREAKDOWN (3-4 sentences): video style (UGC/facecam/B-roll/voiceover), hook mechanism (visual shock/relatable struggle/result-first/question), pacing (cuts per second, how long each shot holds), CTA mechanic, and what makes this video stop the scroll.\n\n2. SHOT-BY-SHOT VISUAL ACTIONS (one line per ~8 seconds of the video): Use cinematic shot language — include shot type (ECU = extreme close-up, MCU = medium close-up, wide), exactly what hands are doing with the product, camera angle, product placement, and expression. Format each line as: "[Shot type] — [physical action] — [expression/energy]"\nExamples of correct format:\n"ECU — fingertip applies serum drop to bare cheek skin, tiny amount absorbs visibly — no expression, just the skin"\n"MCU — holds amber dropper bottle label toward camera, other hand touches face — bright confident smile"\n"POV reaction — looks directly at camera mid-sentence, touches jawline lightly — surprised pleased expression"\n\nNever write "person talks" or "person speaks" — those are implied. Only write what is PHYSICAL and VISUAL that a camera director would specify.';

    var userContent = [{ type: 'text', text: promptText }].concat(frameParts);

    try {
      var apiKey = getApiKey();
      if (!apiKey) { showToast('AI features are not available right now. Please contact support.', 'warning'); return; }

      var res  = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4o', max_tokens: 800, messages: [{ role: 'user', content: userContent }] })
      });
      var data     = await res.json().catch(function() { return {}; });
      var analysis = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content && data.choices[0].message.content.trim() || '';
      if (!analysis) throw new Error((data && data.error && data.error.message) || 'Empty response from model');

      _producerFormatData    = analysis;
      resultEl.textContent   = analysis;
      resultEl.style.display = 'block';
      showToast('Format analyzed — visual actions detected!', 'success');
    } catch (err) {
      showToast('Format analysis failed: ' + err.message, 'error');
    } finally {
      btn.textContent = '🔍 Analyze Reference Video Format';
      btn.disabled    = false;
    }
  }

  // ── generateProducerScript: returns scene-by-scene [{speech, visual}] ──
  async function generateProducerScript() {
    var btn = document.getElementById('producerGenScriptBtn');
    if (btn) { btn.textContent = '⏳ Writing…'; btn.disabled = true; }

    // Read from storyboard builder (#sbProduct, .sb-format-pill) + Brand Kit fallback
    var _sbProd    = ((document.getElementById('sbProduct') && document.getElementById('sbProduct').value) || '').trim();
    var _kit0      = (typeof getBrandKit === 'function') ? getBrandKit() : {};
    var niche      = _sbProd || _kit0.productName || '';
    var _fmtPill   = document.querySelector('.sb-format-pill.active');
    var _fmtVal    = (_fmtPill && _fmtPill.dataset && _fmtPill.dataset.val) || 'talking-head';
    var videoType  = { 'talking-head': 'standard', 'demo': 'product', 'reveal': 'reveal' }[_fmtVal] || 'standard';
    var ctaKeyword = (_kit0.cta || '').trim();
    var _povPill   = document.querySelector('.sb-pov-pill.active');
    var scriptPov  = (_povPill && _povPill.dataset && _povPill.dataset.val) || 'first';
    var pov        = scriptPov === 'client' ? 'third' : 'first';
    var avatarDesc = ((document.getElementById('avatarDesc') && document.getElementById('avatarDesc').value) || '').trim();

    if (!niche) {
      showToast('Enter your product name in the Producer panel first (e.g. toner pads, gummies).', 'warning');
      if (btn) { btn.textContent = '\u2728 Write My Script'; btn.disabled = false; }
      return;
    }

    var systemPrompt = 'You are a viral short-form video scriptwriter who writes authentic UGC (user-generated content) for affiliate marketing. Your scripts sound like real people talking, NOT like ads.\n\nSPEECH RULES — the words spoken must:\n- Sound 100% natural and conversational, like a friend texting you a recommendation\n- NEVER use: "miracle", "amazing", "incredible", "life-changing", "packed with vitamins", "revolutionary", "breakthrough", "doctor-approved", "clinically proven", or ANY superlative claim\n- NEVER make medical or health claims (e.g. "cures", "treats", "heals", "boosts immunity")\n- Use specific, believable language instead: "my skin looked less red after a few days", not "instantly transformed my skin"\n- Contractions, casual phrasing, hesitations — all good: "honestly", "I was skeptical", "not gonna lie", "I tried everything"\n- The hook must be relatable frustration, not a sales pitch\n- Results should sound REAL and slightly underplayed, not hyped\n- NEVER open a hook with a price comparison — phrases like "my $60 moisturizer" or "this $15 thing" immediately read as an ad\n- NEVER open with "I was skeptical" — it is the most overused UGC opener and destroys credibility\n- NEVER name the product in any hook or CTA unless the video type explicitly requires it\n\nFor every scene you write, you produce TWO things:\n1. SPEECH — the exact words spoken (natural, conversational, 15-20 words for ~8 seconds)\n2. VISUAL — a film-direction instruction describing what the camera sees. This must be a SPECIFIC PHYSICAL ACTION using cinematic shot language.\n\nVISUAL SHOT GRAMMAR — use these shot types:\n- ECU (extreme close-up): skin texture, product label, fingertip applying serum, before/after skin patch\n- MCU (medium close-up): face + hands together — person applying product, holding bottle to camera\n- POV reaction: direct eye contact with camera, genuine expression (surprise, relief, confidence)\n- Product hero: hand holds product label facing camera, well-lit, finger points to key feature\n- Demo insert: hands-only close-up — no face — showing product being opened, poured, applied\n- Before/after: person shows untreated skin area, then treated area side by side or in sequence\n- Reaction beat: person pauses speech, touches treated area, looks pleased/surprised, resumes\n\nRULES FOR VISUAL:\n- NEVER write "person talks to camera" or "person speaks" — that is the DEFAULT and adds no value\n- Every visual MUST include at least one of: product interaction, skin/result demonstration, or a specific physical gesture\n- Include camera distance (ECU / MCU / wide), body position, and what hands are doing\n- Even talking scenes should have a physical action layered on top\n- For ManyChat/story scripts: the VISUAL carries the sell — speech is just the hook\n\nBAD speech: "I found this miracle serum packed with vitamins! Amazing!"\nGOOD speech: "I tried like six different serums and nothing worked. Then someone in my comments mentioned this one."\n\nBAD visual: "Person talks about struggling with dull skin"\nGOOD visual: "ECU of bare cheek showing dull uneven texture, person traces fingertip across skin frowning slightly, glances up at camera"\n\nOutput ONLY valid JSON — no markdown, no extra text.';

    var formatContext = _producerFormatData ? '\n\nReference video format and visual actions to draw inspiration from (do NOT copy — adapt to the new niche):\n' + _producerFormatData : '';

    // Scene count priority: reference video duration > format analysis > type default
    var hasFormat  = !!_producerFormatData;
    var sceneCount = _refVideoSceneCount > 0 ? _refVideoSceneCount
                   : hasFormat             ? 0
                   : (videoType === 'minichat' ? 5 : 8);
    // sceneCount = 0 means GPT determines it from the reference format
    var sceneLen   = '~8 seconds of speech (~18 words)';

    var typeInstructions = '';
    if (videoType === 'standard') {
      typeInstructions = 'Video type: Problem/Solution conversion. Structure must follow this arc:\n\nScene 1 — HOOK (most critical — write this LAST after you know the full story):\n- Lead with a specific, visible skin PROBLEM the viewer recognizes on themselves. NOT a price comparison. NOT "I tried everything." A precise moment or feeling.\n- Proven hooks: "POV: you wash your face every night and the pad still comes back brown" / "I had [specific issue] on my nose and nothing I tried touched it" / "Your moisturizer isn\'t absorbing because you\'re skipping this one step" / "I washed my face for years and had no idea I wasn\'t actually clean"\n- Speech: 12-18 words max. If it could be said by anyone about anything, it is too generic. Make it specific to this product\'s actual mechanism of action.\n- Visual: ECU of the skin problem — pores, texture, dryness, residue. Avatar examines or touches the area, slightly frowns.\n\nScenes 2-3 — PROBLEM DEPTH + DISCOVERY:\n- One scene expands the frustration with a specific believable detail. Example: "I tried four cleansers. Gentle, foamy, fancy ones. My skin stayed exactly the same."\n- One scene is the discovery/turning point — how did they find this? A friend, a comment, a random night trying something new?\n- Visuals: avatar gesturing at face, examining skin, or reaching for the product for the first time.\n\nScenes 4-5 — RESULT + CTA:\n- Scene 4: Specific, underplayed result. NOT "transformed." YES: "Within three days the texture was different. My foundation sat completely different. My cheeks felt softer than they had in years."\n- Scene 5: CTA — must use the provided keyword. "Comment \'[keyword]\' and I\'ll send you the secret." / "Drop \'[keyword]\' and I\'ll send you exactly what I added to my routine." NEVER name the product. The mystery is the hook.\n- Visual Scene 5: avatar holds product toward camera at angle so label is partially visible — creates curiosity without revealing.\n\nBANNED in this type: price comparisons, dollar amounts, "I was skeptical", "this changed my life", naming the product.'
    } else if (videoType === 'product') {
      typeInstructions = 'Video type: Product showcase. Lead with the result (before/after moment), demonstrate the product being used, show the label/packaging clearly in at least 2 scenes, end with soft CTA. Every scene should have a specific product-related visual action.';
    } else if (videoType === 'reveal') {
      var ctaKeywordReveal = ctaKeyword || 'glow';
      typeInstructions = 'VIDEO TYPE: Problem Reveal — two-person scene. The avatar notices/reacts to another person\'s visible skin problem and reveals the solution.\n\nSCENE STRUCTURE (5 scenes):\n\nScene 1 — HOOK: Avatar points at / gestures toward a second person with a visible skin issue. Speech should feel like a reaction: "Okay I have to say something. I had the SAME thing on my nose three months ago." OR "She showed me her skin and I immediately knew what was missing." OR "POV: your friend asks why their skin stays dull no matter what they do."\nVisual: TWO-PERSON shot. Avatar on one side gesturing/pointing toward second person whose [skin issue: blackheads / dry patches / dull texture / rough cheek] is visible. Avatar has concerned/excited expression.\n\nScene 2 — PROBLEM DETAIL: Avatar describes the second person\'s specific problem. "She had really rough texture here [gestures to cheek] and her pores looked clogged." Speech is 12-18 words, describes the EXACT visible issue.\nVisual: ECU of the second person\'s problem area — close-up of dry skin, pores, or texture. Avatar\'s hand gently points or frames the area.\n\nScene 3 — DISCOVERY/DEMO: Avatar demos the solution on themselves or on the second person. "So I just told her to add this one step after washing." OR "I gave her what I\'ve been doing every night."\nVisual: Avatar demonstrates the product action — two-person frame, one applies/shows the product. ECU of hands applying product, or product being held up.\n\nScene 4 — RESULT REVEAL: Second person\'s skin looks different / better. Avatar reacts with genuine enthusiasm. "A week later she sent me this. I literally screamed." OR "Her skin looked completely different. Softer. Actually glowing."\nVisual: Avatar and second person side-by-side, second person\'s skin now visibly improved OR avatar reacts to a before/after. Avatar points at the improved area expressively.\n\nScene 5 — CTA: Avatar alone, direct eye contact, conspiratorial energy. "Comment \'' + ctaKeywordReveal + '\' and I\'ll send you the exact thing I gave her. It\'s embarrassingly simple."\nVisual: Avatar faces camera, holds product partially visible toward camera, inviting expression. Product label angled — visible but not fully readable.\n\nGLOBAL RULES FOR THIS TYPE:\n- NEVER name the product\n- The second person\'s skin problem must be SPECIFIC and visually describable (not "bad skin" — "rough dry patches on both cheeks" or "blackheads across the nose bridge")\n- Avatar is always the helper/expert, never the problem-haver\n- Every visual MUST describe the two-person composition in scenes 1-4: who is where, what each person is doing\n- Speech must be 12-18 words per scene — punchy, natural, like a friend talking';
    } else {
      var povStr = pov === 'first' ? 'first person (I tried / I found)' : 'third person (She tried / This girl found)';
      var ctaExamples = ctaKeyword
        ? 'Strong ManyChat CTA options using keyword "' + ctaKeyword + '" — pick the best fit:\n- "Comment \'' + ctaKeyword + '\' and I\'ll send you exactly what I\'ve been using every morning."\n- "If you want something this simple that actually works — drop \'' + ctaKeyword + '\' and I\'ll send it."\n- "You won\'t believe what this is. Comment \'' + ctaKeyword + '\' and I\'ll send you the link."\n- "This takes like 30 seconds. Comment \'' + ctaKeyword + '\' if you want it."'
        : 'Use a mystery CTA that makes them desperate to know what the product is. Never name it. Never say "check the link in bio."';

      typeInstructions = 'VIDEO TYPE: ManyChat engagement bait — 5 scenes. POV: ' + povStr + '.\n\nSCENE-BY-SCENE RULES:\n\nScene 1 — HOOK (most important scene, write it last after you know the full story):\n- The speech must create an IMMEDIATE visual or emotional reaction. No slow buildup.\n- Use ONE of these proven hook formats:\n  a) Watch hook: "Watch what happens when I put this on my skin" — sets up a visual demonstration\n  b) Frustration hook with SPECIFICS: "I spent $200 on serums and counted — zero difference after 6 weeks"\n  c) POV hook: "POV: your $80 serum and this $12 thing do the same thing"\n  d) Result-first: "My skin hasn\'t looked like this since I was 16. I\'ll show you what I changed."\n- The speech must make someone stop scrolling. If it could be said by anyone about anything, it is too generic. Rewrite it.\n- Visual: ECU of the skin problem, OR avatar holding up two products comparing, OR before/after skin texture shot.\n\nScene 2 — SETUP/PROBLEM:\n- Expand the frustration with ONE specific believable detail.\n- Speech example: "I tried everything. Vitamin C, retinol, clay masks — my skin just stayed the same."\n- Visual: avatar gestures to face, shows empty product bottles, or examines skin in mirror.\n\nScene 3 — DEMO ACTION (this is the body — something must HAPPEN here):\n- This is where the character physically demonstrates the product. The speech MUST reference the action.\n- Speech must narrate the action: "So I just put two drops here, spread it like this, and within a few days..." — the person is DOING something while talking.\n- The demo should be simple and visual: applying drops, spreading, using a tool, comparing a before/after area.\n- Visual: ECU of application — fingertip spreading product on skin, OR product dropper releasing drops, OR before/after skin area comparison.\n- NEVER write scene 3 as pure talking. Something physical must happen.\n\nScene 4 — RESULT TEASE:\n- Specific, believable result. NOT "my skin was transformed." YES: "After 9 days the texture was actually smoother and my foundation went on differently."\n- Speech should tease the product without naming it: "And the thing is, it\'s not even a $100 serum."\n- Visual: avatar touches face, shows clearer skin area, holds product partially in frame.\n\nScene 5 — CTA (create a curiosity gap — do NOT name the product):\n' + ctaExamples + '\n- Avatar holds product label toward camera but at an angle so it\'s not fully readable.\n- BANNED phrases: "Check the link in bio", "Go buy it now", "You can get it at..."\n- The mystery is what drives comments. They need to comment to find out what it is.\n\nGENERAL RULES:\n- Every scene speech must be 12-18 words maximum — short, punchy, no filler\n- Every scene visual must show something PHYSICAL happening — no pure talking head scenes\n- The product must appear physically in scenes 3, 4, and 5 minimum';
    }

    // ── Pull product context from producer panel + Brand Kit ──────────────────
    var producerProduct    = ((document.getElementById('producerProduct')    && document.getElementById('producerProduct').value)    || '').trim();
    var producerDemoAction = ((document.getElementById('producerDemoAction') && document.getElementById('producerDemoAction').value) || '').trim();
    var _kit = (typeof getBrandKit === 'function') ? getBrandKit() : {};
    var bkName   = _kit.productName   || producerProduct || '';
    var bkPoints = _kit.talkingPoints || '';
    var bkTone   = _kit.tone          || 'conversational';
    var bkCta    = _kit.cta           || ctaKeyword || '';
    var bkUrl    = _kit.productUrl    || '';

    var toneMap2 = { energetic:'energetic and hype', conversational:'casual and conversational', urgent:'urgent with FOMO', professional:'polished and professional', storytelling:'story-driven and emotional' };
    var toneDesc2 = toneMap2[bkTone] || 'casual and conversational';

    var productContext = '';
    if (bkName)        productContext += 'PRODUCT: ' + bkName + '\n';
    if (niche)         productContext += 'NICHE: ' + niche + '\n';
    if (producerDemoAction) productContext += 'DEMO ACTION (what the avatar physically does with the product): ' + producerDemoAction + '\n';
    if (toneDesc2)     productContext += 'TONE: ' + toneDesc2 + '\n';
    if (bkUrl)         productContext += 'PRODUCT URL (for context): ' + bkUrl + '\n';
    if (bkPoints) {
      var bkLines = bkPoints.split('\n').filter(function(l) { return l.trim(); }).map(function(l) { return '• ' + l.trim(); }).join('\n');
      productContext += 'KEY SELLING POINTS — weave these naturally into the speech, do not list them verbatim:\n' + bkLines + '\n';
    }
    if (bkCta && videoType !== 'standard') productContext += 'CTA TEXT: ' + bkCta + '\n';

    // ── Universal staging playbook (reverse-engineered from winning UGC) ──────────
    var _setEl2 = document.getElementById('studioSetting');
    var _sceneSetting = _setEl2 ? _setEl2.value.trim() : '';
    systemPrompt += '\n\nSTAGING PLAYBOOK — apply to EVERY scene\'s "visual" field:\n'
      + '- The whole video is shot in ONE locked setting' + (_sceneSetting ? (': ' + _sceneSetting) : ' (a single themed room/space — pick one fitting the niche and keep it IDENTICAL every scene)') + '. Never change location between scenes; only the action changes.\n'
      + '- There is a counter/table in front of the speaker where the demo happens and the product is revealed.\n'
      + '- Scene 1 opens on a SHOCK VISUAL or bold result on the table (a curiosity prop, the problem area up close, or a before/after) — not a talking head.\n'
      + '- Middle scenes are a HANDS-ON DEMO/ritual: mixing ingredients in a glass bowl, squeezing/stirring, scooping, or applying — something physically happens, narrated as it happens.\n'
      + '- The FINAL scene reveals the product held label-forward to camera, then the CTA.\n'
      + '- Keep ONE person on camera. If a client is referenced, show them as a treated body part or a split-frame inset — NEVER a second talking head.';
    if (_sceneSetting) productContext += 'SETTING (all scenes happen here, locked): ' + _sceneSetting + '\n';

    // ── Client-narration perspective override (single avatar tells a client's story) ──
    if (scriptPov === 'client') {
      systemPrompt = 'PERSPECTIVE — CRITICAL, THIS OVERRIDES ALL OTHER POV / "I tried" RULES BELOW:\n'
        + 'The single person speaking is NOT the customer and did NOT use the product themselves. They are a trusted expert/insider narrating a CLIENT\'S experience in the third person.\n'
        + '- Speak ABOUT the client: "I had a client who…", "she came to me with…", "her skin…", "so I had her try…", "a week later she sent me this…".\n'
        + '- The speaker is the authority/helper who recommended it — NEVER the one with the problem. NEVER use "I tried it", "my skin", "I was struggling" — the problem and the results belong to the CLIENT.\n'
        + '- Arc: Hook = the client\'s problem ("a client came to me with…"). Middle = what the speaker had the client do / the product they recommended. Result = the client\'s transformation. CTA = the speaker offering to send what they gave the client.\n'
        + '- VISUALS: keep ONE person (the speaker) on camera the whole time — talking to camera, gesturing, holding the product, or holding up a phone showing the client\'s before/after. Do NOT put the client on screen and do NOT write two-person scenes.\n\n'
        + '----------\n\n' + systemPrompt;
    }

    var userPrompt = 'Write a ' + (sceneCount || 5) + '-scene video script.\n\n' + (productContext ? productContext + '\n' : '') + typeInstructions + formatContext + (avatarDesc ? '\n\nAvatar delivering the video: ' + avatarDesc : '') + '\n\nOutput this exact JSON structure:\n{\n  "scenes": [\n    {\n      "speech": "The exact words spoken in this scene (' + sceneLen + ')",\n      "visual": "Specific physical action — what the person is doing, how they hold/use the product, camera framing, expressions"\n    }\n  ]\n}';

    try {
      var apiKey = getApiKey();
      if (!apiKey) { showToast('AI features are not available right now. Please contact support.', 'warning'); return; }

      var res  = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4o', max_tokens: 2000, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }] })
      });
      if (!res.ok) {
        var _errBody = await res.json().catch(function() { return {}; });
        throw new Error((_errBody && _errBody.error && _errBody.error.message) || 'API error ' + res.status);
      }
      var data = await res.json().catch(function() { return {}; });
      var raw  = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '';
      if (!raw) throw new Error((data && data.error && data.error.message) || 'Empty response from model');

      var parsed = null;
      try { parsed = JSON.parse(raw); } catch(e) { throw new Error('Could not parse scene JSON from model'); }

      var scenes = (parsed && parsed.scenes) || [];
      if (!scenes.length) throw new Error('No scenes returned — try again');

      // Store structured scenes for use in produceAllScenes()
      _producerScenes = scenes;

      // Write only the SPEECH text into the originalScript textarea
      var speechOnly = scenes.map(function(s) { return s.speech || ''; }).filter(Boolean).join(' ');
      var scriptEl = document.getElementById('originalScript');
      if (scriptEl) {
        scriptEl.value = speechOnly;
        scriptEl.dispatchEvent(new Event('input'));
        if (typeof autoGrow === 'function') autoGrow(scriptEl);
      }

      // Auto-split into scenes so segments appear immediately
      setTimeout(function() {
        var _sEl = document.getElementById('originalScript');
        if (_sEl && _sEl.value.trim()) splitScriptToScenes();
      }, 120);

      // Build and display the 3 frame cards
      buildProducerFrameNBPrompts();
      renderProducerFrameCards();

      showToast('Script written! Scenes split automatically — review them, then hit 🚀 Produce All Scenes.', 'success');
    } catch (err) {
      showToast('Script generation failed: ' + err.message, 'error');
    } finally {
      if (btn) { btn.textContent = '\u2728 Write My Script'; btn.disabled = false; }
    }
  }

  // ── buildProducerFrameNBPrompts: generate 3 NB Pro JSON instructions ──────
  function buildProducerFrameNBPrompts() {
    var _sbProd2    = ((document.getElementById('sbProduct') && document.getElementById('sbProduct').value) || '').trim();
    var _kit2      = (typeof getBrandKit === 'function') ? getBrandKit() : {};
    var niche      = _sbProd2 || _kit2.productName || 'the product';
    var avatarDesc = ((document.getElementById('avatarDesc')    && document.getElementById('avatarDesc').value)    || '').trim();
    var ctaKeyword = (_kit2 && _kit2.cta || '').trim();

    var avNote = avatarDesc || 'the presenter';

    // Pull visual directions from stored scenes
    var hookVisual = (_producerScenes[0] && _producerScenes[0].visual) ||
      'MCU — avatar reacts with surprise/discovery expression, holds product toward camera, genuine energy';
    var bodyVisual = '';
    for (var bi = 1; bi < _producerScenes.length - 1; bi++) {
      if (_producerScenes[bi] && _producerScenes[bi].visual) { bodyVisual = _producerScenes[bi].visual; break; }
    }
    if (!bodyVisual) bodyVisual = 'Demo close-up — avatar applies ' + niche + ' product to mannequin face or model skin, fingertip application, ECU of the action';
    var ctaVisual = (_producerScenes[_producerScenes.length - 1] && _producerScenes[_producerScenes.length - 1].visual) ||
      'MCU — avatar faces camera directly, holds product label clearly toward viewer, confident direct eye contact, inviting expression';

    var negPrompt = 'AI art style, fake background, blurred gradient backdrop, studio seamless, painterly, illustration, cartoon, CGI, unrealistic lighting, captions, watermarks, logos, multiple people, distorted hands';

    // ── Hook frame ────────────────────────────────────────────────────────
    var hookObj = {
      frame_type: 'HOOK — Frame 1 of 3 (render this first)',
      photo_guide: 'Photo 1 = your avatar photo. Photo 2 = setting/background reference (optional). Photo 3 = product (optional but recommended for product videos).',
      instruction: 'Generate a photorealistic lifestyle hook frame. Subject: ' + avNote + '. ' + hookVisual + '. Setting: real home/lifestyle environment — Pinterest editorial aesthetic, warm natural light. Vertical 9:16, medium close-up, 85mm equivalent, f/1.8.',
      visual_description: hookVisual,
      framing: 'vertical 9:16, MCU, person centered, 85mm, f/1.8',
      style: 'photorealistic lifestyle editorial — real room, natural light, real decor',
      remove_captions: true,
      negative_prompt: negPrompt,
      seed: Math.floor(Math.random() * 99999),
      NEXT_STEP: 'Render this in NanoBanana Pro → download the result → upload it back into the app as the Style Anchor below to lock setting/lighting for Body and CTA frames.'
    };

    // ── Body / Demo frame ──────────────────────────────────────────────────
    var anchorNote = _styleAnchorFrame
      ? 'Photo 2 = your rendered Hook frame (upload it here as style anchor for consistent setting/lighting).'
      : 'Photo 2 = your rendered Hook frame once available — use it to keep the same room and lighting.';
    var bodyObj = {
      frame_type: 'BODY — Frame 2 of 3 (DEMONSTRATION)',
      photo_guide: 'Photo 1 = your avatar photo. ' + anchorNote + ' Photo 3 = product.',
      instruction: 'Generate a photorealistic lifestyle demonstration frame. Subject: ' + avNote + '. ' + bodyVisual + '. This is the PROOF frame — the avatar must be actively demonstrating the product on a mannequin head, hand model, or area of skin. Product must appear physically in the shot. Setting must match the Hook frame (same room, same lighting). Vertical 9:16, medium close-up.',
      visual_description: bodyVisual,
      demo_requirement: 'Avatar MUST be actively using/applying the product — not just holding it. Show it being applied to mannequin skin, hand model, or a real skin area. This is the visual proof that sells.',
      framing: 'vertical 9:16, ECU or MCU depending on demo action, 85mm, f/1.8',
      style: 'photorealistic lifestyle editorial — match Hook frame setting exactly',
      remove_captions: true,
      negative_prompt: negPrompt,
      seed: Math.floor(Math.random() * 99999)
    };
    if (_styleAnchorFrame) bodyObj.style_anchor_loaded = true;

    // ── CTA frame ──────────────────────────────────────────────────────────
    var ctaKeyNote = ctaKeyword ? ' Avatar gestures toward camera emphasizing the comment word "' + ctaKeyword + '".' : '';
    var ctaAnchorNote = _styleAnchorFrame
      ? 'Photo 2 = your rendered Hook frame (style anchor for consistent setting).'
      : 'Photo 2 = your rendered Hook frame once available — use it to keep the same room and lighting.';
    var ctaObj = {
      frame_type: 'CTA — Frame 3 of 3',
      photo_guide: 'Photo 1 = your avatar photo. ' + ctaAnchorNote + ' Photo 3 = product (label facing camera).',
      instruction: 'Generate a photorealistic lifestyle CTA frame. Subject: ' + avNote + '. ' + ctaVisual + '. Product label must be clearly readable facing the camera.' + ctaKeyNote + ' Setting must match the Hook frame. Vertical 9:16, medium close-up.',
      visual_description: ctaVisual,
      expression: 'confident, warm direct eye contact, slight smile — trustworthy and inviting',
      framing: 'vertical 9:16, MCU, person centered, 85mm, f/1.8',
      style: 'photorealistic lifestyle editorial — match Hook frame setting exactly',
      remove_captions: true,
      negative_prompt: negPrompt,
      seed: Math.floor(Math.random() * 99999)
    };
    if (_styleAnchorFrame) ctaObj.style_anchor_loaded = true;

    _producerNBFrames.hook = JSON.stringify(hookObj, null, 2);
    _producerNBFrames.body = JSON.stringify(bodyObj, null, 2);
    _producerNBFrames.cta  = JSON.stringify(ctaObj,  null, 2);
  }

  // ── renderProducerFrameCards: build the 3 frame card UI ──────────────────
  function renderProducerFrameCards() {
    var container = document.getElementById('producerFrameCards');
    if (!container) return;

    var cards = [
      { key: 'hook', label: '🎣 HOOK — Frame 1', badge: '#f59e0b', desc: 'Opening scene — render this FIRST, then re-upload it below as the style anchor.' },
      { key: 'body', label: '💪 BODY — Demo Frame 2', badge: '#7c3aed', desc: 'Demonstration scene — avatar applies product to mannequin, hand model, or skin.' },
      { key: 'cta',  label: '📣 CTA — Frame 3', badge: '#059669', desc: 'Call-to-action close — product label facing camera, confident direct eye contact.' }
    ];

    var html = '<div style="font-size:9px;color:var(--text-3);margin-bottom:5px;text-transform:uppercase;letter-spacing:0.5px;">⑤ Frame Cards — NB Pro Instructions</div>';

    cards.forEach(function(c) {
      var promptText = escHtml(_producerNBFrames[c.key] || '');
      html += '<div style="border:1px solid rgba(255,255,255,0.07);border-radius:6px;overflow:hidden;margin-bottom:6px;">';
      html += '<div style="background:rgba(255,255,255,0.04);padding:5px 8px;display:flex;align-items:center;gap:6px;border-bottom:1px solid rgba(255,255,255,0.06);">';
      html += '<span style="font-size:9px;font-weight:700;color:' + c.badge + ';letter-spacing:0.3px;">' + c.label + '</span>';
      html += '</div>';
      html += '<div style="padding:5px 8px;font-size:9px;color:var(--text-3);line-height:1.4;">' + escHtml(c.desc) + '</div>';
      html += '<div style="padding:0 8px 6px;">';
      html += '<textarea readonly onclick="this.select()" style="width:100%;font-size:8.5px;font-family:monospace;padding:5px 6px;background:var(--bg);border:1px solid var(--border-2);border-radius:3px;color:var(--text-2);resize:vertical;min-height:70px;max-height:120px;box-sizing:border-box;outline:none;" data-frame-key="' + c.key + '">' + promptText + '</textarea>';
      html += '<button onclick="(function(){var ta=document.querySelector(\'textarea[data-frame-key=\\\"' + c.key + '\\\"]\');if(ta){navigator.clipboard.writeText(ta.value).catch(function(){ta.select();document.execCommand(\'copy\');});showToast(\'Copied ' + c.label + ' prompt\',\'success\');}})();" style="width:100%;padding:3px 0;font-size:9px;font-weight:600;background:var(--glass-2);border:1px solid var(--glass-border);border-radius:3px;color:var(--text-2);cursor:pointer;font-family:inherit;margin-top:3px;">📋 Copy Prompt</button>';
      html += '</div>';

      // Style anchor upload zone — only on Hook card
      if (c.key === 'hook') {
        var anchored = _styleAnchorFrame ? true : false;
        html += '<div style="padding:0 8px 8px;">';
        html += '<div style="font-size:8.5px;color:var(--text-3);margin-bottom:3px;">📸 Re-upload your rendered hook frame to lock visual style:</div>';
        if (anchored) {
          html += '<div style="padding:5px 8px;background:rgba(5,150,105,0.1);border:1px solid rgba(5,150,105,0.35);border-radius:4px;font-size:8.5px;color:#4ade80;text-align:center;">✅ Style anchor set — Body &amp; CTA prompts updated</div>';
        } else {
          html += '<div onclick="document.getElementById(\'styleAnchorInput\').click()" style="padding:8px;border:1px dashed rgba(245,158,11,0.45);border-radius:4px;background:rgba(245,158,11,0.05);cursor:pointer;text-align:center;font-size:9px;color:#fbbf24;" onmouseenter="this.style.background=\'rgba(245,158,11,0.1)\'" onmouseleave="this.style.background=\'rgba(245,158,11,0.05)\'">⬆ Upload rendered hook frame (JPG/PNG)</div>';
          html += '<input id="styleAnchorInput" type="file" accept="image/*" style="display:none;" onchange="onStyleAnchorUpload(event)">';
        }
        html += '</div>';
      }

      html += '</div>';
    });

    container.innerHTML = html;
    container.style.display = 'block';
  }

  // ── onStyleAnchorUpload: user re-uploads their rendered hook frame ────────
  function onStyleAnchorUpload(event) {
    var file = event.target.files && event.target.files[0];
    if (event.target) event.target.value = '';
    if (!file) return;

    var reader = new FileReader();
    reader.onload = function(e) {
      _styleAnchorFrame = e.target.result;
      // Regenerate the 3 frame prompts with anchor baked in
      buildProducerFrameNBPrompts();
      // Also store as bgImageDataUrl so produceAllScenes uses it for consistency
      bgImageDataUrl = _styleAnchorFrame;
      bgFromAvatar   = false;
      var bgEl = document.getElementById('bgImageStatus');
      if (bgEl) bgEl.textContent = 'Style anchor active';
      // Re-render cards
      renderProducerFrameCards();
      showToast('Style anchor set! Body and CTA frame prompts updated.', 'success');
    };
    reader.readAsDataURL(file);
  }

  // ── produceAllScenes: split → pre-fill visuals → NB prompts → Veo 3 prompts ──
  // ── Smart scene segmentation via Vertex Gemini 2.5 Pro (producer-ai) ──────────
  // Returns [{spoken,seconds,action,shot,emphasis}] or null on any failure
  // (caller falls back to the legacy sentence splitter).
  async function aiSegmentScript(script) {
    try {
      var _sbRef = (typeof _sb !== 'undefined' && _sb) ? _sb : window._sb;
      var jwt = null;
      if (_sbRef) {
        var sr = await _sbRef.auth.getSession();
        jwt = (sr && sr.data && sr.data.session && sr.data.session.access_token) || null;
      }
      if (!jwt) return null;
      var prod = (document.getElementById('sbProduct') && document.getElementById('sbProduct').value || '').trim();
      var durEl = document.querySelector('.sb-dur-pill.active');
      var tSecs = durEl ? (parseInt(durEl.dataset.val, 10) || 45) : 45;
      var charDesc = (typeof avatarInventory === 'string' && avatarInventory) ? avatarInventory.slice(0, 600) : '';
      var res = await fetch('/.netlify/functions/producer-ai', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + jwt },
        body:    JSON.stringify({ task: 'segment', script: script, product: prod, targetSeconds: tSecs, character: charDesc }),
      });
      if (!res.ok) { console.warn('aiSegmentScript: HTTP ' + res.status); return null; }
      var data = await res.json();
      return (data && Array.isArray(data.scenes) && data.scenes.length) ? data.scenes : null;
    } catch (e) {
      console.warn('aiSegmentScript failed, will fall back to sentence split:', e && e.message);
      return null;
    }
  }

  // Build segments[] from AI scene objects — mirrors _doSplit's segment shape.
  function _buildSegmentsFromAIScenes(scenes) {
    var elapsed = 0;
    segments = scenes.map(function (sc) {
      var dur   = (Number(sc.seconds) >= 7) ? 8 : 6;
      var start = Math.round(elapsed * 10) / 10;
      elapsed  += dur;
      var end   = Math.round(elapsed * 10) / 10;
      var action = String(sc.action || '').trim();
      if (sc.shot) action += (action ? '  ' : '') + 'Shot: ' + String(sc.shot).trim() + '.';
      return {
        startTime:    start,
        endTime:      end,
        script:       String(sc.spoken || '').trim(),
        action:       action || deriveSceneAction(String(sc.spoken || ''), 0, scenes.length),
        frameDataUrl: null,
        nbPrompt:     '',
        veoPrompt:    '',
        frameDesc:    '',
        _scriptOnly:  true,
        _shot:        String(sc.shot || '').trim(),
        _emphasis:    String(sc.emphasis || '').trim(),
      };
    }).filter(function (s) { return s.script; });
    saveSegments();
    renderSegments();
    var total = segments.length;
    var countEl = document.getElementById('segmentCount');
    if (countEl) countEl.textContent = total + ' scene' + (total !== 1 ? 's' : '');
    // Mirror _doSplit: auto-collapse the script panel so segment cards are visible
    var _sp = document.getElementById('vsPanelScript');
    if (_sp && _sp.dataset.collapsed !== '1') {
      var _hdr = _sp.querySelector('.vs-panel-header.collapsible');
      if (_hdr) _hdr.click();
    }
  }

  // ── Script revise loop — rewrite the producer script from the user's notes ────
  // Uses Vertex Gemini 2.5 Pro (producer-ai, task 'revise').
  async function reviseProducerScript() {
    var ta      = document.getElementById('originalScript');
    var notesEl = document.getElementById('sbReviseNotes');
    var script  = ta ? (ta.value || '').trim() : '';
    var notes   = notesEl ? (notesEl.value || '').trim() : '';
    if (!script) { showToast('Write or paste a script first, then tell the AI how to improve it.', 'warning'); return; }
    var btn = document.getElementById('sbReviseBtn');
    var orig = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = '⟳ Revising…'; }
    try {
      var _sbRef = (typeof _sb !== 'undefined' && _sb) ? _sb : window._sb;
      var jwt = null;
      if (_sbRef) { var sr = await _sbRef.auth.getSession(); jwt = (sr && sr.data && sr.data.session && sr.data.session.access_token) || null; }
      if (!jwt) { showToast('Please log in to use AI revise.', 'warning'); return; }
      var prod = (document.getElementById('sbProduct') && document.getElementById('sbProduct').value || '').trim();
      var res = await fetch('/.netlify/functions/producer-ai', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + jwt },
        body:    JSON.stringify({ task: 'revise', script: script, notes: notes, product: prod }),
      });
      var data = null;
      try { data = await res.json(); } catch (_) {}
      if (!res.ok || !data || !data.script) {
        showToast((data && data.error) || 'Revise failed — please try again.', 'error');
        return;
      }
      if (ta) {
        ta.value = data.script;
        try { ta.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {}
        if (typeof saveSegments === 'function') saveSegments();
      }
      if (notesEl) notesEl.value = '';
      showToast('Script revised. Review it, then Produce All Scenes.', 'success');
    } catch (e) {
      showToast('Revise failed: ' + (e && e.message), 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = orig; }
    }
  }
  window.reviseProducerScript = reviseProducerScript;

  // Script voice toggle — "My experience" (first person) vs "Client's story" (third person)
  function setSbPerspective(btn) {
    document.querySelectorAll('.sb-pov-pill').forEach(function (b) {
      b.classList.remove('active');
      b.style.background = 'var(--glass-2)'; b.style.color = 'var(--text-2)'; b.style.borderColor = 'var(--border-2)';
    });
    btn.classList.add('active');
    btn.style.background = 'rgba(16,185,129,0.12)'; btn.style.color = '#34d399'; btn.style.borderColor = 'rgba(16,185,129,0.4)';
  }
  window.setSbPerspective = setSbPerspective;

  // ── One-tap style presets (from the UGC style profile) — fill Setting + Voice ──
  function applyProducerPreset(btn) {
    var setting = btn.getAttribute('data-setting') || '';
    var voice   = btn.getAttribute('data-voice')   || 'first';
    var name    = btn.getAttribute('data-name')    || 'preset';
    var setEl = document.getElementById('studioSetting');
    if (setEl) { setEl.value = setting; try { setEl.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {} }
    var pill = document.querySelector('.sb-pov-pill[data-val="' + voice + '"]');
    if (pill && typeof setSbPerspective === 'function') setSbPerspective(pill);
    document.querySelectorAll('.sb-preset-card').forEach(function (c) {
      c.classList.remove('on'); c.style.borderColor = 'var(--border-2)'; c.style.background = 'var(--surface-2)';
    });
    btn.classList.add('on'); btn.style.borderColor = 'rgba(16,185,129,0.55)'; btn.style.background = 'rgba(16,185,129,0.10)';
    if (typeof showToast === 'function') showToast('Style set — ' + name + '. Now write or paste your script.', 'success', 3500);
  }
  window.applyProducerPreset = applyProducerPreset;

  async function produceAllScenes() {
    var btn = document.getElementById('produceAllScenesBtn');
    if (btn) { btn.textContent = '⏳ Producing…'; btn.disabled = true; }

    var script = (document.getElementById('originalScript') && document.getElementById('originalScript').value || '').trim();
    if (!script) {
      showToast('Write or paste your script first, then produce.', 'warning');
      if (btn) { btn.textContent = '🚀 Produce All Scenes'; btn.disabled = false; }
      return;
    }

    try {
      // Always split fresh — bypass the confirm dialog that splitScriptToScenes shows
      var _psScript = (document.getElementById('originalScript') && document.getElementById('originalScript').value || '').trim();
      if (!_psScript) {
        showToast('Write or paste your script first, then produce.', 'warning');
        if (btn) { btn.textContent = '\uD83D\uDE80 Produce All Scenes'; btn.disabled = false; }
        return;
      }
      // Step 1/4 \u2014 smart segmentation via Gemini 2.5 Pro (Vertex); fall back to sentence split.
      showToast('Step 1/4 \u2014 Breaking the script into scenes\u2026', 'info');
      var _aiScenes = null;
      try { _aiScenes = await aiSegmentScript(_psScript); } catch(_) { _aiScenes = null; }
      if (_aiScenes && _aiScenes.length) {
        _buildSegmentsFromAIScenes(_aiScenes);
      } else {
        var _psSentences = _psScript.replace(/\r\n|\r/g,'\n').replace(/\n+/g,' ')
          .split(/(?<=[.!?\u2026])\s+/).map(function(s){return s.trim();}).filter(Boolean);
        if (_psSentences.length) _doSplit(_psSentences);
      }

      // Guard: if segmentation produced nothing (e.g. a script with no sentence
      // punctuation, or a non-Latin script), don't build prompts on an empty/stale
      // set and then falsely report success.
      if (!segments || !segments.length) {
        showToast('Couldn’t break that script into scenes — add sentence breaks (periods or line breaks) or a bit more text, then try again.', 'warning', 7000);
        return; // finally{} re-enables the button
      }

      // generateAllSegmentPrompts already builds the NB prompts, so the separate
      // _doGenerateAllNBPrompts pass was duplicate work (built then immediately
      // overwritten) — removed.
      var _producerSteps = [
        ['Step 2/3 — Building visual prompts…',   buildProducerFrameNBPrompts],
        ['Step 3/3 — Generating scene prompts…',  generateAllSegmentPrompts],
      ];
      for (var _si = 0; _si < _producerSteps.length; _si++) {
        showToast(_producerSteps[_si][0], 'info');
        await _producerSteps[_si][1]();
        await new Promise(function(r) { setTimeout(r, 400); });
      }

      showToast('🚀 All scenes produced! Copy the Agent Brief below to run full production.', 'success');
      var _briefWrap = document.getElementById('producerBriefWrap');
      if (_briefWrap) _briefWrap.style.display = 'flex';
    } catch (err) {
      showToast('Produce failed: ' + err.message, 'error');
    } finally {
      if (btn) { btn.textContent = '🚀 Produce All Scenes'; btn.disabled = false; }
    }
  }

  // ── generateAgentBrief — copies full NB + Veo agent instructions for all scenes ──
  function generateAgentBrief() {
    // Open the Veo Agent panel — it has NB prompts, Veo prompts, bulk upload, and ZIP
    if (typeof openVeoAgentPanel === 'function') {
      openVeoAgentPanel();
    } else {
      showToast('Open the Video Studio → Agent Brief tab to access all prompts.', 'info');
    }
  }
