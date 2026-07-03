  // ===== VIDEO PRODUCER — STORYBOARD ENGINE =====
  // Architecture: CONCEPT -> GENERATE -> (hook picker + beat cards) -> BUILD PROMPTS -> COPY BRIEF
  //
  // Beats are the atomic unit: each beat = one 6-8s Veo 3 clip.
  // After "Build All Prompts", beats are converted to the global segments[] array so the
  // existing Replicator pipeline (NB prompts, Run All Scenes, Agent Brief) handles the rest.

  // Beat type badge colors
  var SB_BEAT_COLORS = {
    HOOK:       '#f43f5e',
    PROBLEM:    '#f97316',
    DISCOVERY:  '#38bdf8',
    DEMO:       '#a78bfa',
    PROOF:      '#34d399',
    CTA:        '#fbbf24',
  };

  // Module-level state (on window so other modules can read)
  if (!window._sbBeats)      window._sbBeats      = [];
  if (!window._sbHookOpts)   window._sbHookOpts   = [];
  if (window._sbHookChoice == null) window._sbHookChoice = 0;

  // ─── Utility helpers ────────────────────────────────────────────────────────
  function _sbMakeId() {
    return 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function _sbWordCount(text) {
    return (text || '').trim().split(/\s+/).filter(Boolean).length;
  }

  // Snap word count to the two durations Veo 3 supports: 6 or 8 seconds.
  // 2.5 wps = average conversational speaking rate for short-form video.
  // Threshold is 5s (12.5 words): scripts longer than that snap to 8s so that
  // beats in the 13-20 word range (which AI commonly generates for longer beats)
  // actually use the 8s clip slot instead of all landing on 6s.
  function sbCalcDuration(script) {
    var sec = _sbWordCount(script) / 2.5;
    return sec > 5 ? 8 : 6;
  }

  // ─── Generate Storyboard (GPT-4o, json_object mode) ─────────────────────────
  async function generateStoryboard() {
    var apiKey = getApiKey();
    if (!apiKey) { showToast('Add your OpenAI API key in Settings first.', 'warning'); return; }
    if (typeof window.requireAccess === 'function' && !window.requireAccess()) return;

    var kit         = getBrandKit();
    var productName = (document.getElementById('sbProduct') ? document.getElementById('sbProduct').value.trim() : '') || kit.productName || 'the product';
    var formatPill  = document.querySelector('.sb-format-pill.active');
    var format      = formatPill ? formatPill.dataset.val : 'talking-head';
    var durPill     = document.querySelector('.sb-dur-pill.active');
    var durVal      = parseInt(durPill ? durPill.dataset.val : '45', 10);
    var toneMap     = {
      energetic:     'energetic, hype, fast-paced',
      conversational:'casual and conversational',
      urgent:        'urgent with FOMO',
      professional:  'polished and authoritative',
      storytelling:  'story-driven and emotional',
    };
    var toneDesc    = toneMap[kit.tone] || 'conversational';
    var talkingPts  = kit.talkingPoints
      ? kit.talkingPoints.split('\n').filter(Boolean).map(function(l){ return '- ' + l; }).join('\n') : '';
    var cta         = kit.cta || 'Link in bio';
    var targetBeats = Math.round(durVal / 6);

    var btn  = document.getElementById('sbGenerateBtn');
    var wrap = document.getElementById('sbResultsWrap');
    if (btn)  { btn.textContent = 'Generating…'; btn.disabled = true; }
    if (wrap) {
      wrap.style.display = 'block';
      wrap.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-3);font-size:11px;">Building your storyboard...</div>';
    }

    var formatRule = format === 'talking-head'
      ? 'Every beat is a talking-head shot — presenter speaks directly to camera. No B-roll.'
      : format === 'demo'
        ? 'Mix talking-head and product demo shots — show the product being actively used.'
        : 'UGC reveal style — presenter reacts, compares before/after, demonstrates result.';

    var systemPrompt = 'You are a viral short-form UGC video director who creates affiliate ad storyboards for TikTok and Reels.\n'
      + 'You output structured JSON storyboards only.\n\n'
      + 'Your storyboards are known for:\n'
      + '- Hooks that name ONE specific relatable moment (never "I tried everything")\n'
      + '- Scripts that are 8-14 words each, landing as their own spoken breath\n'
      + '- Scene directions that give Veo 3 exactly what it needs to generate cinematic motion\n'
      + '- Physical, specific actions (not "smiles at camera" but "holds bottle label-forward at chest height")\n\n'
      + 'FORMAT: ' + formatRule + '\n'
      + 'DURATION RULES: Each beat must be exactly 6 or 8 seconds (Veo 3 only supports these two values).\n'
      + 'BANNED script words: Doctor-approved - Clinically proven';

    var userPrompt = 'Create a ' + durVal + '-second affiliate video storyboard for "' + productName + '".\n\n'
      + (talkingPts ? 'KEY BENEFITS (weave in naturally, do not list them):\n' + talkingPts + '\n\n' : '')
      + 'TONE: ' + toneDesc + '\n'
      + 'FINAL CTA (exact words): "' + cta + '"\n\n'
      + 'Target ~' + targetBeats + ' beats. Choose the exact count based on the product story arc.\n\n'
      + 'Beat types: HOOK | PROBLEM | DISCOVERY | DEMO | PROOF | CTA\n'
      + 'Order: HOOK then PROBLEM then DISCOVERY then DEMO then PROOF(s) then CTA\n'
      + '- HOOK: ONE specific relatable moment, mid-action, 8-12 words\n'
      + '- PROBLEM: most specific visual detail of the frustration, 8-14 words\n'
      + '- DISCOVERY: how they found "' + productName + '" naturally, 8-14 words\n'
      + '- DEMO: exact physical product use, what they do, what they see, 8-14 words\n'
      + '- PROOF: ONE measurable or visible result, 8-14 words\n'
      + '- CTA: the exact cta text above\n\n'
      + 'Also generate 3 alternative HOOK options with different angles.\n\n'
      + 'Return ONLY this JSON (no markdown, no explanation):\n'
      + '{\n'
      + '  "hookOptions": [\n'
      + '    {"script": "...", "angle": "direct"},\n'
      + '    {"script": "...", "angle": "pov"},\n'
      + '    {"script": "...", "angle": "bold"}\n'
      + '  ],\n'
      + '  "beats": [\n'
      + '    {\n'
      + '      "type": "HOOK",\n'
      + '      "script": "exact spoken words 8-14 words",\n'
      + '      "sceneType": "character",\n'
      + '      "shot": "extreme-cu",\n'
      + '      "camera": "static",\n'
      + '      "action": "specific physical action third person one sentence",\n'
      + '      "duration": 6\n'
      + '    }\n'
      + '  ]\n'
      + '}';

    try {
      var res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
        body: JSON.stringify({
          model:           'gpt-4o',
          messages:        [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
          response_format: { type: 'json_object' },
          temperature:     0.8,
          max_tokens:      2400,
        })
      });
      if (!res.ok) {
        var errData = await res.json().catch(function(){ return {}; });
        throw new Error((errData && errData.error && errData.error.message) || ('API error ' + res.status));
      }
      var data   = await res.json();
      var raw    = ((data.choices || [])[0] || {}).message
        ? (data.choices[0].message.content || '').trim() : '';
      var parsed;
      try { parsed = JSON.parse(raw); } catch(_) { throw new Error('Malformed JSON from AI — please try again.'); }

      if (!parsed.beats || !Array.isArray(parsed.beats) || parsed.beats.length === 0) {
        throw new Error('No beats returned — please try again.');
      }

      window._sbBeats = parsed.beats.map(function(b) {
        return {
          id:        _sbMakeId(),
          type:      ((b.type || 'HOOK') + '').toUpperCase(),
          script:    (b.script || '').trim(),
          sceneType: b.sceneType || 'character',
          shot:      b.shot      || 'medium',
          camera:    b.camera    || 'static',
          action:    (b.action   || '').trim(),
          duration:  sbCalcDuration(b.script),
          locked:    false,
          veoPrompt: '',
          done:      false,
        };
      });

      window._sbHookOpts   = Array.isArray(parsed.hookOptions) ? parsed.hookOptions : [];
      window._sbHookChoice = 0;

      renderStoryboard();
      var _totalSec = window._sbBeats.reduce(function(acc, b) { return acc + b.duration; }, 0);
      showToast('Storyboard ready — ' + window._sbBeats.length + ' beats · ~' + _totalSec + 's total', 'success');

    } catch(e) {
      if (wrap) {
        wrap.innerHTML = '<div style="padding:16px;color:var(--danger);font-size:11px;">'
          + 'Failed: ' + escHtml(e.message)
          + '<br><br><button onclick="generateStoryboard()" style="padding:4px 10px;font-size:10px;'
          + 'background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.4);border-radius:4px;'
          + 'color:#f87171;cursor:pointer;">Try again</button></div>';
      }
      showToast('Storyboard generation failed.', 'error');
    } finally {
      if (btn) { btn.textContent = '✨ Generate from Brand Kit'; btn.disabled = false; }
    }
  }

  // ─── Render: hook picker + beat list + action buttons ───────────────────────
  function renderStoryboard() {
    var wrap = document.getElementById('sbResultsWrap');
    if (!wrap) return;

    var beats    = window._sbBeats;
    var hookOpts = window._sbHookOpts;
    var hookIdx  = window._sbHookChoice;
    var html     = '';

    // Hook Picker
    if (hookOpts.length > 1) {
      html += '<div style="margin-bottom:10px;">'
        + '<div style="font-size:9px;font-weight:700;color:#f43f5e;text-transform:uppercase;letter-spacing:0.7px;margin-bottom:6px;">Hook Options</div>'
        + '<div style="display:flex;flex-direction:column;gap:5px;">';
      hookOpts.forEach(function(h, i) {
        var active = (i === hookIdx);
        html += '<div onclick="sbSelectHook(' + i + ')" style="padding:8px 10px;border-radius:6px;border:1px solid '
          + (active ? 'rgba(244,63,94,0.65)' : 'var(--border-2)')
          + ';background:' + (active ? 'rgba(244,63,94,0.1)' : 'var(--surface-2)')
          + ';cursor:pointer;">'
          + '<div style="display:flex;align-items:center;gap:6px;margin-bottom:3px;">'
            + '<div style="width:13px;height:13px;border-radius:50%;border:2px solid '
              + (active ? '#f43f5e' : 'var(--border-2)') + ';background:'
              + (active ? '#f43f5e' : 'transparent') + ';flex-shrink:0;"></div>'
            + '<span style="font-size:9px;font-weight:700;color:' + (active ? '#f43f5e' : 'var(--text-3)')
              + ';text-transform:uppercase;letter-spacing:0.4px;">' + escHtml(h.angle || ('Option ' + (i + 1))) + '</span>'
          + '</div>'
          + '<div style="font-size:10.5px;color:' + (active ? 'var(--text-1)' : 'var(--text-2)')
            + ';line-height:1.45;padding-left:19px;">&ldquo;' + escHtml(h.script || '') + '&rdquo;</div>'
        + '</div>';
      });
      html += '</div></div>';
    }

    // Beat Cards
    html += '<div style="display:flex;flex-direction:row;gap:10px;overflow-x:auto;padding-bottom:10px;scroll-snap-type:x mandatory;-webkit-overflow-scrolling:touch;">';
    beats.forEach(function(beat, idx) { html += _sbRenderBeatCard(beat, idx, beats.length); });
    html += '</div>';

    // Total duration summary
    var _sbTotalSec = beats.reduce(function(acc, b) { return acc + b.duration; }, 0);
    html += '<div style="margin-top:10px;padding:7px 10px;border-radius:6px;background:var(--glass-2);border:1px solid var(--glass-border);display:flex;align-items:center;justify-content:space-between;">'
      + '<span style="font-size:9px;color:var(--text-3);text-transform:uppercase;letter-spacing:0.5px;font-weight:700;">Est. Total Duration</span>'
      + '<span style="font-size:12px;font-weight:800;color:var(--text-1);">' + _sbTotalSec + 's &nbsp;<span style="font-size:9px;color:var(--text-3);font-weight:500;">(' + beats.length + ' beats)</span></span>'
    + '</div>';

    // Bottom actions
    html += '<div style="margin-top:8px;display:flex;flex-direction:column;gap:6px;">'
      + '<button onclick="produceAllBeats()" id="sbProduceBtn"'
        + ' style="width:100%;padding:10px 0;font-size:12px;font-weight:800;'
          + 'background:linear-gradient(135deg,#10b981,#059669);border:1px solid rgba(16,185,129,0.6);'
          + 'border-radius:7px;color:#fff;cursor:pointer;font-family:inherit;letter-spacing:-0.2px;'
          + 'box-shadow:0 0 14px rgba(16,185,129,0.2);"'
        + ' onmouseenter="this.style.boxShadow=\'0 0 22px rgba(16,185,129,0.4)\'"'
        + ' onmouseleave="this.style.boxShadow=\'0 0 14px rgba(16,185,129,0.2)\'">'
        + '🚀 Build All Prompts'
      + '</button>'
      + '<div id="sbBriefWrap" style="display:none;flex-direction:column;gap:6px;">'
        + '<button onclick="if(typeof generateNBMasterViaAPI===\'function\'){generateNBMasterViaAPI();}else{showToast(\'Coming soon\',\'info\',3000);}"'
          + ' style="width:100%;padding:10px 0;font-size:12px;font-weight:700;'
            + 'background:linear-gradient(135deg,rgba(16,185,129,0.18),rgba(5,150,105,0.10));'
            + 'border:1px solid rgba(16,185,129,0.5);border-radius:7px;color:#34d399;cursor:pointer;font-family:inherit;letter-spacing:-0.2px;'
            + 'box-shadow:0 0 12px rgba(16,185,129,0.15);">'
          + '&#x26A1; Generate Start Frames via API'
        + '</button>'
        + '<button onclick="sbCopyBrief()"'
          + ' style="width:100%;padding:8px 0;font-size:10.5px;font-weight:600;'
            + 'background:none;border:1px solid var(--border-2);border-radius:6px;color:var(--text-3);cursor:pointer;font-family:inherit;">'
          + '&#x1F3AC; Open Producer'
        + '</button>'
      + '</div>'
      + '</div>'
    + '</div>';

    wrap.innerHTML = html;
    wrap.style.display = 'block';
    var bw = document.getElementById('sbBriefWrap');
    if (bw) bw.style.display = 'none';
  }

  // ─── Single beat card HTML ───────────────────────────────────────────────────
  function _sbRenderBeatCard(beat, idx, totalBeats) {
    var col       = SB_BEAT_COLORS[beat.type] || '#888';
    var sceneOpts = ['character', 'product', 'hands', 'broll'];
    var shotOpts  = ['extreme-cu', 'close-up', 'medium', 'wide', 'pov'];
    var camOpts   = ['static', 'push-in', 'pan-left', 'pan-right', 'handheld'];
    var wc        = _sbWordCount(beat.script);
    var preview   = beat.script.slice(0, 52) + (beat.script.length > 52 ? '...' : '');

    function makeSelect(field, opts, cur) {
      var inner = opts.map(function(o){ return '<option value="' + o + '"' + (o === cur ? ' selected' : '') + '>' + o + '</option>'; }).join('');
      return '<select onchange="sbSetField(\'' + beat.id + '\',\'' + field + '\',this.value)"'
        + ' style="flex:1;padding:3px 4px;font-size:9.5px;background:var(--bg);border:1px solid var(--border-2);border-radius:3px;color:var(--text-2);font-family:inherit;cursor:pointer;outline:none;">'
        + inner + '</select>';
    }

    return '<div id="sb-card-' + beat.id + '" style="border:1px solid '
      + (beat.locked ? 'rgba(251,146,60,0.5)' : 'var(--border-2)')
      + ';border-radius:7px;background:var(--surface-2);overflow:hidden;min-width:270px;flex-shrink:0;scroll-snap-align:start;">'

      // Header
      + '<div style="display:flex;align-items:center;gap:6px;padding:7px 10px;border-bottom:1px solid var(--border);cursor:pointer;" onclick="sbToggleCard(\'' + beat.id + '\')">'
        + '<span style="font-size:9px;font-weight:800;color:' + col + ';background:' + col + '22;padding:2px 7px;border-radius:10px;letter-spacing:0.5px;flex-shrink:0;">' + beat.type + '</span>'
        + '<div style="flex:1;font-size:10.5px;color:var(--text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'
          + (preview ? ('&ldquo;' + escHtml(preview) + '&rdquo;') : '<span style="color:var(--text-3);font-style:italic;">Empty beat</span>')
        + '</div>'
        + '<span id="sb-dur-' + beat.id + '" style="font-size:9px;color:var(--text-3);flex-shrink:0;">' + beat.duration + 's</span>'
        + (beat.locked ? '<span style="font-size:10px;" title="Locked">🔒</span>' : '')
      + '</div>'

      // Body
      + '<div id="sb-body-' + beat.id + '" style="padding:8px 10px;display:flex;flex-direction:column;gap:6px;">'

        // Script
        + '<div>'
          + '<div style="font-size:8.5px;color:var(--text-3);margin-bottom:3px;text-transform:uppercase;letter-spacing:0.4px;">'
            + 'Script <span id="sb-wc-' + beat.id + '" style="font-weight:400;text-transform:none;">(' + wc + ' words &middot; ' + beat.duration + 's)</span>'
          + '</div>'
          + '<textarea id="sb-script-' + beat.id + '" rows="2"'
            + ' style="width:100%;padding:5px 7px;font-size:10.5px;background:var(--bg);border:1px solid var(--border-2);border-radius:4px;color:var(--text-1);font-family:inherit;resize:vertical;outline:none;box-sizing:border-box;line-height:1.4;"'
            + ' oninput="sbEditScript(\'' + beat.id + '\',this.value)">'
            + escHtml(beat.script)
          + '</textarea>'
        + '</div>'

        // Action
        + '<div>'
          + '<div style="font-size:8.5px;color:var(--text-3);margin-bottom:3px;text-transform:uppercase;letter-spacing:0.4px;">Action</div>'
          + '<textarea id="sb-action-' + beat.id + '" rows="2"'
            + ' style="width:100%;padding:5px 7px;font-size:10px;background:var(--bg);border:1px solid var(--border-2);border-radius:4px;color:var(--text-2);font-family:inherit;resize:vertical;outline:none;box-sizing:border-box;line-height:1.4;"'
            + ' oninput="sbSetField(\'' + beat.id + '\',\'action\',this.value)">'
            + escHtml(beat.action)
          + '</textarea>'
        + '</div>'

        // Scene / Shot / Camera selectors
        + '<div style="display:flex;gap:4px;">'
          + '<div style="flex:1;"><div style="font-size:8px;color:var(--text-3);margin-bottom:2px;">Scene</div>'  + makeSelect('sceneType', sceneOpts, beat.sceneType) + '</div>'
          + '<div style="flex:1;"><div style="font-size:8px;color:var(--text-3);margin-bottom:2px;">Shot</div>'   + makeSelect('shot',      shotOpts,  beat.shot)      + '</div>'
          + '<div style="flex:1;"><div style="font-size:8px;color:var(--text-3);margin-bottom:2px;">Camera</div>' + makeSelect('camera',    camOpts,   beat.camera)    + '</div>'
        + '</div>'

        // Beat action buttons
        + '<div style="display:flex;gap:4px;margin-top:2px;">'
          + '<button onclick="sbRegenerateBeat(\'' + beat.id + '\')" title="AI Rewrite"'
            + ' style="flex:1;padding:4px 0;font-size:9.5px;background:rgba(99,102,241,0.1);border:1px solid rgba(99,102,241,0.35);border-radius:4px;color:#818cf8;cursor:pointer;font-family:inherit;">'
            + '↺ Regen</button>'
          + '<button onclick="sbAddBeat(' + idx + ')" title="Add beat after"'
            + ' style="flex:1;padding:4px 0;font-size:9.5px;background:var(--glass-2);border:1px solid var(--glass-border);border-radius:4px;color:var(--text-2);cursor:pointer;font-family:inherit;">'
            + '+ Add</button>'
          + '<button onclick="sbLockBeat(\'' + beat.id + '\')" title="' + (beat.locked ? 'Unlock' : 'Lock') + '"'
            + ' style="flex:1;padding:4px 0;font-size:9.5px;background:' + (beat.locked ? 'rgba(251,146,60,0.1)' : 'var(--glass-2)')
            + ';border:1px solid ' + (beat.locked ? 'rgba(251,146,60,0.4)' : 'var(--glass-border)')
            + ';border-radius:4px;color:' + (beat.locked ? '#fb923c' : 'var(--text-2)')
            + ';cursor:pointer;font-family:inherit;">'
            + (beat.locked ? '🔒 Locked' : '🔓 Lock') + '</button>'
          + (totalBeats > 2
              ? '<button onclick="sbDeleteBeat(\'' + beat.id + '\')" title="Delete"'
                + ' style="padding:4px 8px;font-size:9.5px;background:rgba(239,68,68,0.06);border:1px solid rgba(239,68,68,0.2);border-radius:4px;color:var(--danger);cursor:pointer;font-family:inherit;">'
                + '✕</button>'
              : '')
        + '</div>'

      + '</div>'  // end body
    + '</div>';   // end card
  }

  // ─── Beat interaction handlers ───────────────────────────────────────────────

  function sbToggleCard(id) {
    var body = document.getElementById('sb-body-' + id);
    if (body) body.style.display = body.style.display === 'none' ? '' : 'none';
  }

  function sbSelectHook(idx) {
    window._sbHookChoice = idx;
    var hookBeat = null;
    for (var i = 0; i < window._sbBeats.length; i++) {
      if (window._sbBeats[i].type === 'HOOK') { hookBeat = window._sbBeats[i]; break; }
    }
    var opt = window._sbHookOpts[idx];
    if (hookBeat && opt && opt.script && !hookBeat.locked) {
      hookBeat.script   = opt.script;
      hookBeat.duration = sbCalcDuration(opt.script);
    }
    renderStoryboard();
  }

  function sbEditScript(id, val) {
    var beat = null;
    for (var i = 0; i < window._sbBeats.length; i++) {
      if (window._sbBeats[i].id === id) { beat = window._sbBeats[i]; break; }
    }
    if (!beat || beat.locked) return;
    beat.script   = val;
    beat.duration = sbCalcDuration(val);
    var wcEl = document.getElementById('sb-wc-' + id);
    if (wcEl) wcEl.textContent = '(' + _sbWordCount(val) + ' words · ' + beat.duration + 's)';
    var durEl = document.getElementById('sb-dur-' + id);
    if (durEl) durEl.textContent = beat.duration + 's';
  }

  function sbSetField(id, field, val) {
    for (var i = 0; i < window._sbBeats.length; i++) {
      if (window._sbBeats[i].id === id) {
        if (window._sbBeats[i].locked && field !== 'locked') return;
        window._sbBeats[i][field] = val;
        break;
      }
    }
  }

  function sbLockBeat(id) {
    var beat = null; var idx = -1;
    for (var i = 0; i < window._sbBeats.length; i++) {
      if (window._sbBeats[i].id === id) { beat = window._sbBeats[i]; idx = i; break; }
    }
    if (!beat) return;
    beat.locked = !beat.locked;
    var card = document.getElementById('sb-card-' + id);
    if (card && idx >= 0) card.outerHTML = _sbRenderBeatCard(beat, idx, window._sbBeats.length);
  }

  function sbDeleteBeat(id) {
    if (window._sbBeats.length <= 2) { showToast('Minimum 2 beats required.', 'warning'); return; }
    window._sbBeats = window._sbBeats.filter(function(b){ return b.id !== id; });
    renderStoryboard();
  }

  function sbAddBeat(afterIdx) {
    var newBeat = {
      id:        _sbMakeId(),
      type:      'PROOF',
      script:    '',
      sceneType: 'character',
      shot:      'medium',
      camera:    'static',
      action:    '',
      duration:  6,
      locked:    false,
      veoPrompt: '',
      done:      false,
    };
    window._sbBeats.splice(afterIdx + 1, 0, newBeat);
    renderStoryboard();
    setTimeout(function() {
      var ta = document.getElementById('sb-script-' + newBeat.id);
      if (ta) ta.focus();
    }, 60);
  }

  // ─── Regenerate a single beat ────────────────────────────────────────────────
  async function sbRegenerateBeat(id) {
    var beat = null;
    for (var i = 0; i < window._sbBeats.length; i++) {
      if (window._sbBeats[i].id === id) { beat = window._sbBeats[i]; break; }
    }
    if (!beat) return;
    var apiKey = getApiKey();
    if (!apiKey) { showToast('Add your OpenAI API key in Settings.', 'warning'); return; }

    var card     = document.getElementById('sb-card-' + id);
    var regenBtn = card ? card.querySelector('button[onclick^="sbRegenerateBeat"]') : null;
    if (regenBtn) { regenBtn.textContent = '...'; regenBtn.disabled = true; }

    var kit         = getBrandKit();
    var productName = (document.getElementById('sbProduct') ? document.getElementById('sbProduct').value.trim() : '') || kit.productName || 'the product';
    var context     = window._sbBeats.map(function(b){ return b.type + ': "' + b.script + '"'; }).join('\n');

    try {
      var res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
        body: JSON.stringify({
          model:           'gpt-4o',
          messages: [{
            role: 'user',
            content: 'Rewrite ONLY the ' + beat.type + ' beat for "' + productName + '".\n\n'
              + 'Storyboard context:\n' + context + '\n\n'
              + 'Beat to rewrite: "' + beat.script + '"\n\n'
              + 'Rules: 8-14 words, sounds natural when spoken, matches surrounding beats.\n'
              + 'BANNED: Doctor-approved, Clinically proven\n\n'
              + 'Return ONLY JSON: {"script":"...","action":"...","sceneType":"character|product|hands|broll","shot":"extreme-cu|close-up|medium|wide|pov","camera":"static|push-in|pan-left|pan-right|handheld"}',
          }],
          response_format: { type: 'json_object' },
          temperature:     0.85,
          max_tokens:      220,
        })
      });
      if (!res.ok) throw new Error('API error ' + res.status);
      var data   = await res.json();
      var _rawRegen = ((data.choices || [])[0] || {}).message ? (data.choices[0].message.content || '{}') : '{}';
      var parsed;
      try { parsed = JSON.parse(_rawRegen); } catch(_) { throw new Error('AI returned malformed JSON — try again.'); }
      if (!parsed.script) throw new Error('Empty response');

      beat.script    = parsed.script.trim();
      beat.action    = (parsed.action    || beat.action || '').trim();
      beat.sceneType = parsed.sceneType  || beat.sceneType;
      beat.shot      = parsed.shot       || beat.shot;
      beat.camera    = parsed.camera     || beat.camera;
      beat.duration  = sbCalcDuration(beat.script);

      var idx2 = -1;
      for (var j = 0; j < window._sbBeats.length; j++) {
        if (window._sbBeats[j].id === id) { idx2 = j; break; }
      }
      var liveCard2 = document.getElementById('sb-card-' + id);
      if (liveCard2 && idx2 >= 0) liveCard2.outerHTML = _sbRenderBeatCard(beat, idx2, window._sbBeats.length);
      showToast('Beat rewritten', 'success', 1800);
    } catch(e) {
      showToast('Regen failed: ' + e.message, 'error');
      // Re-query button from live DOM (card.outerHTML may have detached the original reference)
      var _liveBtn = document.querySelector('#sb-card-' + id + ' button[onclick^="sbRegenerateBeat"]');
      if (_liveBtn) { _liveBtn.textContent = '↺ Regen'; _liveBtn.disabled = false; }
      else if (regenBtn) { regenBtn.textContent = '↺ Regen'; regenBtn.disabled = false; }
    }
  }

  // ─── Build Veo 3 JSON for a beat (pure template, no GPT) ─────────────────────
  function sbBuildVeoJson(beat, idx, total) {
    var kit         = getBrandKit();
    var productName = (document.getElementById('sbProduct') ? document.getElementById('sbProduct').value.trim() : '') || kit.productName || 'the product';
    var cameraMap   = {
      'static':    'static handheld, slight natural movement',
      'push-in':   'slow deliberate push-in toward subject',
      'pan-left':  'slow horizontal pan left',
      'pan-right': 'slow horizontal pan right',
      'handheld':  'handheld natural organic movement',
    };
    var shotMap = {
      'extreme-cu': 'extreme close-up',
      'close-up':   'close-up',
      'medium':     'medium shot',
      'wide':       'wide shot',
      'pov':        'POV shot',
    };
    // Speaking only on 'character' scenes. On product/hands/b-roll the line
    // becomes voiceover so the avatar doesn't lip-sync over a product shot.
    var _speaks = (typeof window.sceneSpeaks === 'function') ? window.sceneSpeaks(beat) : true;
    var obj = {
      speech:          _speaks ? beat.script : '',
      action:          beat.action || (_speaks
                          ? 'person delivers line naturally to camera with confident eye contact'
                          : 'no one speaks on camera — product/insert shot, no mouth movement, no talking'),
      shot:            (shotMap[beat.shot] || beat.shot) + ', vertical 9:16',
      camera:          cameraMap[beat.camera] || beat.camera,
      duration:        beat.duration + ' seconds',
      audio:           _speaks
                          ? 'clear natural voice, slight ambient room tone, no background music'
                          : 'voiceover continues over the shot, slight ambient room tone, no background music',
      negative_prompt: 'multiple people, rearranged props, changed background, cuts, transitions, fade in, fade out, crossfade, dissolve, wipe, flash cut, jump cut, scene change, text overlays, subtitles, watermarks, AI artifacts, distorted hands'
                          + (_speaks ? '' : ', talking, speaking, mouth moving, lip movement, lip sync'),
    };
    if (!_speaks && beat.script && String(beat.script).trim()) obj.voiceover = beat.script;
    if (productName && beat.type !== 'HOOK' && beat.type !== 'PROBLEM') {
      obj.product = productName;
    }
    if (idx === 0)          obj.opening_note = 'First clip: hook must instantly stop the scroll';
    if (idx === total - 1)  obj.closing_note  = 'Final clip: strong CTA, direct eye contact';
    return JSON.stringify(obj, null, 2);
  }

  // ─── Build NB Pro first-frame prompt for a beat (template, no extra GPT call) ──
  // Uses the already-GPT-generated beat.action to describe the exact starting pose/frame.
  function _sbBuildNBFirstFramePrompt(beat, avatarDesc, setting, productName) {
    var shotMap = {
      'extreme-cu': 'extreme close-up',
      'close-up':   'close-up',
      'medium':     'medium shot',
      'wide':       'wide shot',
      'pov':        'POV shot',
    };
    var shotDesc = shotMap[beat.shot] || 'medium shot';

    // Use the first clause of the action as the starting pose (GPT already wrote this)
    var actionStart = (beat.action || 'faces camera with natural expression').split(',')[0].trim();

    var expressionMap = {
      HOOK:      'engaging direct eye contact, slight forward energy',
      PROBLEM:   'frustrated or concerned expression',
      DISCOVERY: 'curious interested expression, slight eyebrow raise',
      DEMO:      'focused deliberate expression, looking at product or hands',
      PROOF:     'pleased satisfied expression, slight smile',
      CTA:       'warm confident smile, direct eye contact',
    };
    var expression = expressionMap[beat.type] || 'natural engaged expression';

    // Photo 1 = avatar photo. No reference frame for Producer beats — generate fresh.
    return 'Photo 1 is the creator/avatar. Generate a photorealistic lifestyle photo of this exact person. '
      + (avatarDesc || 'The person') + ' is ' + actionStart + ', ' + expression + '. '
      + (setting ? 'Setting: ' + setting + '. ' : 'Setting: clean lifestyle environment with warm natural light. ')
      + (productName && beat.type !== 'HOOK' && beat.type !== 'PROBLEM' ? productName + ' visible nearby on the surface. ' : '')
      + 'Camera: ' + shotDesc + ', vertical 9:16, cinematic soft key lighting. '
      + 'Photorealistic UGC video still, single person only, no text, no watermarks. This is the starting frame for a Veo 3 video clip.';
  }


  // ─── Convert beats -> global segments[] ─────────────────────────────────────
  function applyStoryboardToSegments() {
    var beats = window._sbBeats;
    if (!beats || beats.length === 0) return;
    var elapsed = 0;
    segments = beats.map(function(beat, i) {
      var start = Math.round(elapsed * 10) / 10;
      elapsed  += beat.duration;
      var end   = Math.round(elapsed * 10) / 10;
      return {
        startTime:    start,
        endTime:      end,
        script:       beat.script,
        action:       beat.action || (typeof deriveSceneAction === 'function'
                        ? deriveSceneAction(beat.script, i, beats.length) : ''),
        frameDataUrl: null,
        nbPrompt:     '',
        veoPrompt:    beat.veoPrompt || '',
        frameDesc:    '',
        _scriptOnly:  true,
        _beatId:      beat.id,
        _beatType:    beat.type,
      };
    });
    saveSegments();
  }

  // ─── Build All Prompts ───────────────────────────────────────────────────────
  async function produceAllBeats() {
    var beats = window._sbBeats;
    if (!beats || beats.length === 0) {
      showToast('Generate a storyboard first.', 'warning');
      return;
    }
    var btn = document.getElementById('sbProduceBtn');
    if (btn) { btn.textContent = 'Building...'; btn.disabled = true; }

    try {
      var kit   = getBrandKit();   // needed for avatarDesc / setting / productName fallbacks
      var total = beats.length;

      // Step 1: Build Veo 3 JSON + NB first-frame prompts for every beat
      var _pAvatarDesc  = (document.getElementById('avatarDesc')     ? document.getElementById('avatarDesc').value.trim()     : '') || kit.avatarDesc || '';
      var _pSetting     = (document.getElementById('studioSetting')  ? document.getElementById('studioSetting').value.trim()  : '') || kit.setting   || '';
      var _pProductName = (document.getElementById('sbProduct')      ? document.getElementById('sbProduct').value.trim()      : '') || kit.productName || '';
      beats.forEach(function(beat, i) {
        beat.veoPrompt          = sbBuildVeoJson(beat, i, total);
        beat.nbFirstFramePrompt = _sbBuildNBFirstFramePrompt(beat, _pAvatarDesc, _pSetting, _pProductName);
      });

      // Step 2: Push beats into global segments[]
      applyStoryboardToSegments();

      // Step 3: Build NB Pro prompts using existing pipeline
      var setting    = (document.getElementById('studioSetting')  ? document.getElementById('studioSetting').value.trim()  : '') || '';
      var avatarDesc = (document.getElementById('avatarDesc')      ? document.getElementById('avatarDesc').value.trim()      : '') || '';
      segments.forEach(function(seg, i) {
        // Use the beat's auto-generated first-frame NB prompt if available
        if (beats[i] && beats[i].nbFirstFramePrompt) {
          seg.nbPrompt = beats[i].nbFirstFramePrompt;
        } else if (typeof buildScriptOnlyNBPrompt === 'function') {
          seg.nbPrompt = buildScriptOnlyNBPrompt(i, seg.script, _pSetting, _pAvatarDesc, bgImageDataUrl, '');
        }
        if (!seg.veoPrompt && beats[i]) seg.veoPrompt = beats[i].veoPrompt || '';
      });
      saveSegments();

      // Step 4: Render timeline
      if (typeof renderSegments === 'function') renderSegments();

      // Step 5: Exit quick mode if active
      if (typeof exitQuickMode === 'function') {
        var qm = document.getElementById('quickModePanel');
        if (qm && qm.style.display === 'flex') exitQuickMode();
      }

      // Show agent brief button
      var bw = document.getElementById('sbBriefWrap');
      if (bw) bw.style.display = 'flex';

      showToast(total + ' scenes ready — scroll down to review', 'success', 4000);
      if (btn) { btn.textContent = '✅ Prompts Built'; btn.disabled = false; }

      setTimeout(function() {
        var first = document.getElementById('seg-card-0');
        if (first) first.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 350);

    } catch(e) {
      showToast('Build failed: ' + e.message, 'error');
      if (btn) { btn.textContent = '🚀 Build All Prompts'; btn.disabled = false; }
    }
  }



  // ─────────────────────────────────────────────────────────────────────────────
  // PRODUCER WORKFLOW MODAL — 3-phase: Scene Setup → NB Composites → Veo Clips
  // ─────────────────────────────────────────────────────────────────────────────

  // Module-level state for the producer scene
  if (!window._sbEstFrameDataUrl) window._sbEstFrameDataUrl = null;
  if (!window._sbSceneDesc)       window._sbSceneDesc       = '';

  function sbCopyBrief() {
    if (!segments || segments.length === 0) {
      showToast('Build prompts first.', 'warning');
      return;
    }
    var ready = segments.filter(function(s) { return s.veoPrompt && s.veoPrompt.trim(); });
    if (!ready.length) {
      showToast('Build prompts first.', 'warning');
      return;
    }
    var n = ready.length;
    var sceneWord = n !== 1 ? 'scenes' : 'scene';
    var sceneAnalyzed = !!window._sbSceneDesc;
    var compositesUploaded = segments.filter(function(s) { return s.nbCompositeDataUrl || s.frameDataUrl; }).length;

    var existing = document.getElementById('sbProducerModal');
    if (existing) existing.remove();
    var modal = document.createElement('div');
    modal.id = 'sbProducerModal';
    modal.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.72);backdrop-filter:blur(6px);padding:16px;overflow-y:auto;';

    var p1status = sceneAnalyzed ? '&#x2705; Reference locked — character &amp; scene anchored' : 'Generate once in NanoBanana — locks character, scene &amp; lighting for all clips';
    var p1color  = sceneAnalyzed ? '#34d399' : 'var(--text-4)';
    var p2status = compositesUploaded > 0 ? '&#x2705; ' + compositesUploaded + ' of ' + n + ' start frames uploaded' : 'Generate from master reference in NanoBanana — one per scene';
    var p2color  = compositesUploaded > 0 ? '#34d399' : 'var(--text-4)';

    modal.innerHTML = ''
      + '<div style="background:var(--surface);border:1px solid rgba(167,139,250,0.35);border-radius:16px;padding:22px 22px 18px;width:100%;max-width:430px;box-shadow:0 24px 80px rgba(0,0,0,0.6);position:relative;font-family:inherit;">'

        // ── Header ──
        + '<button onclick="document.getElementById(\'sbProducerModal\').remove()" style="position:absolute;top:12px;right:12px;background:none;border:none;color:var(--text-3);font-size:18px;cursor:pointer;padding:2px 6px;border-radius:5px;">&#x2715;</button>'
        + '<div style="display:flex;align-items:center;gap:10px;margin-bottom:18px;">'
          + '<div style="width:36px;height:36px;border-radius:9px;background:rgba(167,139,250,0.15);border:1px solid rgba(167,139,250,0.3);display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;">&#x1F3AC;</div>'
          + '<div>'
            + '<div style="font-size:14px;font-weight:800;color:var(--text-1);">Video Producer</div>'
            + '<div style="font-size:11px;color:var(--text-3);">' + n + ' ' + sceneWord + ' ready &mdash; NanoBanana &rarr; ' + (getAdminSettings().defaultModel || 'Veo 3.1 Lite') + '</div>'
          + '</div>'
        + '</div>'

        // ── Phase 1 ──
        + '<div style="margin-bottom:12px;">'
          + '<div style="font-size:10px;font-weight:700;color:#fb923c;letter-spacing:0.08em;margin-bottom:6px;">PHASE 1 &mdash; GENERATE MASTER REFERENCE IN NANOBANANA</div>'
          + '<div style="font-size:10px;color:' + p1color + ';margin-bottom:8px;">' + p1status + '</div>'
          + '<div style="display:flex;flex-direction:column;gap:6px;">'
            + '<button onclick="sbCopySceneSetupPrompt()" style="display:flex;align-items:center;justify-content:center;gap:7px;padding:10px;border-radius:8px;background:rgba(251,146,60,0.12);border:1px solid rgba(251,146,60,0.35);color:#fb923c;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;" onmouseenter="this.style.background=\'rgba(251,146,60,0.22)\'" onmouseleave="this.style.background=\'rgba(251,146,60,0.12)\'">'
              + '&#x1F4CB; Copy Master Reference Prompt &nbsp;<span style="font-size:9px;opacity:0.7;font-weight:500;">(generate in NanoBanana)</span>'
            + '</button>'
            + '<button onclick="document.getElementById(\'sbEstFrameInput\').click()" style="display:flex;align-items:center;justify-content:center;gap:7px;padding:10px;border-radius:8px;background:rgba(251,146,60,0.08);border:1px solid rgba(251,146,60,0.25);color:#fb923c;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;" onmouseenter="this.style.background=\'rgba(251,146,60,0.18)\'" onmouseleave="this.style.background=\'rgba(251,146,60,0.08)\'">'
              + (sceneAnalyzed ? '&#x2705;' : '&#x1F4E5;') + ' Upload Master Reference Frame &nbsp;<span style="font-size:9px;opacity:0.7;font-weight:500;">(app locks character &amp; scene)</span>'
            + '</button>'
            + '<input type="file" id="sbEstFrameInput" accept="image/*" style="display:none;" onchange="_sbHandleEstablishingFrameUpload(this.files);this.value=\'\';">'
            // API option
            + '<div style="display:flex;align-items:center;gap:6px;">'
              + '<div style="flex:1;height:1px;background:var(--border);"></div>'
              + '<span style="font-size:8.5px;color:var(--text-3);font-weight:600;letter-spacing:0.06em;text-transform:uppercase;">or use API</span>'
              + '<div style="flex:1;height:1px;background:var(--border);"></div>'
            + '</div>'
            + '<button id="nbAPIPhase1Btn" onclick="if(typeof generateNBMasterViaAPI===\'function\'){generateNBMasterViaAPI();}else{showToast(\'Auto NB generation coming soon — use manual upload for now.\',\'info\',5000);}" style="display:flex;align-items:center;justify-content:center;gap:7px;padding:10px;border-radius:8px;background:rgba(16,185,129,0.10);border:1px solid rgba(16,185,129,0.35);color:#34d399;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;" onmouseenter="this.style.background=\'rgba(16,185,129,0.20)\'" onmouseleave="this.style.background=\'rgba(16,185,129,0.10)\'">'
              + (sceneAnalyzed ? '&#x2705;' : '&#x26A1;') + ' Generate Master Reference via API &nbsp;<span style="font-size:9px;opacity:0.75;font-weight:500;">(Nano Banana 2 · no browser needed)</span>'
            + '</button>'
          + '</div>'
        + '</div>'

        + '<div style="height:1px;background:var(--border);margin:10px 0;"></div>'

        // ── Phase 2 ──
        + '<div style="margin-bottom:12px;">'
          + '<div style="font-size:10px;font-weight:700;color:#38bdf8;letter-spacing:0.08em;margin-bottom:6px;">PHASE 2 &mdash; GENERATE PER-SCENE START FRAMES IN NANOBANANA</div>'
          + '<div style="font-size:10px;color:' + p2color + ';margin-bottom:8px;">' + p2status + '</div>'
          + '<div style="display:flex;flex-direction:column;gap:6px;">'
            + '<button onclick="sbCopyProducerNBPrompts()" style="display:flex;align-items:center;justify-content:center;gap:7px;padding:10px;border-radius:8px;background:rgba(56,189,248,0.12);border:1px solid rgba(56,189,248,0.35);color:#38bdf8;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;" onmouseenter="this.style.background=\'rgba(56,189,248,0.22)\'" onmouseleave="this.style.background=\'rgba(56,189,248,0.12)\'">'
              + '&#x1F4CB; Copy Per-Scene Start Frame Prompts &nbsp;<span style="font-size:9px;opacity:0.7;font-weight:500;">(upload master reference as input)</span>'
            + '</button>'
            + '<button onclick="document.getElementById(\'sbCompositesInput\').click()" style="display:flex;align-items:center;justify-content:center;gap:7px;padding:10px;border-radius:8px;background:rgba(52,211,153,0.12);border:1px solid rgba(52,211,153,0.35);color:#34d399;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;" onmouseenter="this.style.background=\'rgba(52,211,153,0.22)\'" onmouseleave="this.style.background=\'rgba(52,211,153,0.12)\'">'
              + '&#x1F4E5; Bulk Upload Start Frames &nbsp;<span style="font-size:9px;opacity:0.7;font-weight:500;">(auto-assigns in order)</span>'
            + '</button>'
            + '<input type="file" id="sbCompositesInput" accept="image/*" multiple style="display:none;" onchange="_sbBulkUploadProducerComposites(this.files);this.value=\'\';">'
            // API option
            + '<div style="display:flex;align-items:center;gap:6px;">'
              + '<div style="flex:1;height:1px;background:var(--border);"></div>'
              + '<span style="font-size:8.5px;color:var(--text-3);font-weight:600;letter-spacing:0.06em;text-transform:uppercase;">or use API</span>'
              + '<div style="flex:1;height:1px;background:var(--border);"></div>'
            + '</div>'
            + '<button onclick="document.getElementById(\'sbProducerModal\').remove();if(typeof generateAllNBFramesViaAPI===\'function\'){generateAllNBFramesViaAPI();}else if(typeof generateAllNbComposites===\'function\'){generateAllNbComposites();}else{showToast(\'Auto NB frame generation coming soon — use manual upload for now.\',\'info\',5000);}" style="display:flex;align-items:center;justify-content:center;gap:7px;padding:10px;border-radius:8px;background:rgba(16,185,129,0.10);border:1px solid rgba(16,185,129,0.35);color:#34d399;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;" onmouseenter="this.style.background=\'rgba(16,185,129,0.20)\'" onmouseleave="this.style.background=\'rgba(16,185,129,0.10)\'">'
              + (compositesUploaded > 0 ? '&#x2705;' : '&#x26A1;') + ' Generate All Start Frames via API &nbsp;<span style="font-size:9px;opacity:0.75;font-weight:500;">(Nano Banana 2 · ' + n + ' frames)</span>'
            + '</button>'
          + '</div>'
        + '</div>'

        + '<div style="height:1px;background:var(--border);margin:10px 0;"></div>'

        // ── Phase 3 ──
        + '<div>'
          + '<div style="font-size:10px;font-weight:700;color:#a78bfa;letter-spacing:0.08em;margin-bottom:8px;">PHASE 3 &mdash; GENERATE VIDEO CLIPS</div>'

          // Option A: manual Google Flow
          + '<button onclick="copyProducerScenePrompts()" style="display:flex;align-items:center;justify-content:center;gap:7px;width:100%;padding:11px;border-radius:9px;background:var(--grad-accent);border:none;color:#fff;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;box-shadow:0 4px 16px rgba(124,106,247,0.3);margin-bottom:8px;" onmouseenter="this.style.boxShadow=\'0 4px 24px rgba(124,106,247,0.5)\'" onmouseleave="this.style.boxShadow=\'0 4px 16px rgba(124,106,247,0.3)\'">'
            + '&#x1F4CB; Copy All Scene Prompts &nbsp;<span style="font-size:9px;opacity:0.85;font-weight:500;">(paste into Google Flow manually)</span>'
          + '</button>'

          // Divider
          + '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">'
            + '<div style="flex:1;height:1px;background:var(--border);"></div>'
            + '<span style="font-size:9px;color:var(--text-3);font-weight:600;letter-spacing:0.06em;text-transform:uppercase;">or</span>'
            + '<div style="flex:1;height:1px;background:var(--border);"></div>'
          + '</div>'

          // Option B: Gemini API direct
          + '<button onclick="document.getElementById(\'sbProducerModal\').remove();generateAllScenesViaAPI();" id="sbAPIGenerateBtn" style="display:flex;align-items:center;justify-content:center;gap:7px;width:100%;padding:11px;border-radius:9px;background:rgba(16,185,129,0.12);border:1px solid rgba(16,185,129,0.45);color:#34d399;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;" onmouseenter="this.style.background=\'rgba(16,185,129,0.22)\'" onmouseleave="this.style.background=\'rgba(16,185,129,0.12)\'">'
            + '&#x26A1; Generate via Gemini API &nbsp;<span style="font-size:9px;opacity:0.8;font-weight:500;">($0.05/clip · audio included · no Flow needed)</span>'
          + '</button>'
          + '<div style="font-size:9px;color:var(--text-3);text-align:center;margin-top:5px;">'
            + (typeof getGeminiKey === 'function' && getGeminiKey()
                ? '&#x2705; API key saved &mdash; ready to generate'
                : '&#x26A0; No API key &mdash; <span style="color:var(--accent-2);cursor:pointer;" onclick="document.getElementById(\'sbProducerModal\').remove();openUserSettings(\'setup\')">Add in Settings &rarr;</span>')
          + '</div>'
        + '</div>'

        // ── Refresh ──
        + '<button onclick="sbCopyBrief()" style="width:100%;margin-top:10px;padding:7px;border-radius:7px;background:none;border:1px solid var(--border-2);color:var(--text-3);font-size:10px;font-weight:600;cursor:pointer;font-family:inherit;" onmouseenter="this.style.borderColor=\'rgba(167,139,250,0.4)\';this.style.color=\'#a78bfa\'" onmouseleave="this.style.borderColor=\'var(--border-2)\';this.style.color=\'var(--text-3)\'">'
          + '&#x1F504; Refresh &mdash; update status after uploads'
        + '</button>'

      + '</div>';

    document.body.appendChild(modal);
    modal.addEventListener('click', function(e) { if (e.target === modal) modal.remove(); });
  }

  // ─── Phase 1a: Scene Setup NB Prompt ────────────────────────────────────────
  function sbCopySceneSetupPrompt() {
    var kit         = getBrandKit();
    var productName = (document.getElementById('sbProduct') ? document.getElementById('sbProduct').value.trim() : '') || kit.productName || 'the product';
    var setting     = (document.getElementById('studioSetting') ? document.getElementById('studioSetting').value.trim() : '') || kit.setting || 'clean modern countertop, soft natural light';
    var avatarDesc  = (document.getElementById('avatarDesc')    ? document.getElementById('avatarDesc').value.trim()    : '') || kit.avatarDesc || 'young woman';

    var prompt = 'NanoBanana — generate the master reference image for a UGC affiliate video. '
      + 'Subject: ' + avatarDesc + ', shoulders-up, neutral relaxed expression, looking just off-camera. '
      + 'Setting: ' + setting + '. '
      + (productName ? 'Product: ' + productName + ' visible in the scene, label facing forward. ' : '')
      + 'Lighting: soft cinematic key light from front-left, natural ambient fill, no harsh shadows. '
      + 'Camera: vertical 9:16, close-up to medium shot, slight natural depth of field. '
      + 'Style: photorealistic UGC video still, single person only, no text, no watermarks, no graphics. '
      + 'CRITICAL: This image will be used as the master reference for all per-scene start frames. '
      + 'Character appearance, outfit, background, props, and lighting must be clearly defined and consistent.';

    navigator.clipboard.writeText(prompt).then(function() {
      showToast('Master reference prompt copied — paste into NanoBanana to generate your reference frame.', 'success', 5000);
    }).catch(function() {
      try {
        var ta = document.createElement('textarea'); ta.value = prompt;
        document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
        showToast('Scene setup prompt copied!', 'success', 3000);
      } catch(e) { showToast('Copy failed — please try again.', 'error'); }
    });
  }

  // ─── Phase 1b: Upload & Analyze Master Reference Frame ──────────────────────
  async function _sbHandleEstablishingFrameUpload(files) {
    if (!files || !files.length) return;
    var file = files[0];
    var apiKey = getApiKey();

    // Show analyzing toast
    showToast('Analyzing your establishing frame...', 'info', 10000);

    // Read as dataUrl
    var dataUrl = await new Promise(function(resolve, reject) {
      var reader = new FileReader();
      reader.onload = function(e) { resolve(e.target.result); };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    window._sbEstFrameDataUrl = dataUrl;

    // Analyze with GPT-4o vision if API key available
    if (apiKey) {
      try {
        var res = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [{
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: 'Describe this scene in 2-3 specific sentences for use as a consistent video background reference. '
                    + 'Focus on: the exact surface or counter type, all visible props and objects, the background environment, '
                    + 'lighting quality and direction, and any distinctive visual elements. '
                    + 'Be concrete and visual — this will be used to ensure all subsequent NanoBanana start frames match this exact scene.'
                },
                { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } }
              ]
            }],
            max_tokens: 200
          })
        });
        if (res.ok) {
          var data = await res.json();
          var desc = (((data.choices || [])[0] || {}).message || {}).content || '';
          window._sbSceneDesc = desc.trim();
        }
      } catch(e) {
        // Non-fatal — use generic scene desc
        window._sbSceneDesc = 'consistent indoor scene with the established props, background, and lighting from the reference frame';
      }
    } else {
      window._sbSceneDesc = 'consistent indoor scene with the established props, background, and lighting from the reference frame';
    }

    // Regenerate all NB prompts incorporating the scene description
    var avatarDesc = (document.getElementById('avatarDesc') ? document.getElementById('avatarDesc').value.trim() : '') || 'the person';
    var sceneRef   = window._sbSceneDesc;
    segments.forEach(function(seg) {
      if (!seg._scriptOnly) return; // only touch Producer segments
      var action = seg.action || 'speaks naturally to camera';
      seg.nbPrompt = 'NanoBanana — start frame variation from master reference image. '
        + 'INPUT: upload the master reference image into NanoBanana before generating this frame. '
        + 'Keep IDENTICAL to reference: character face, hair, outfit, background, props, lighting. '
        + 'Change ONLY the starting pose: ' + avatarDesc + ' is now ' + action + '. '
        + 'Scene: ' + sceneRef + ' '
        + 'Photorealistic, vertical 9:16, single person only, no text, no watermarks.';
    });
    saveSegments();

    showToast('Reference locked ✅ — start frame prompts updated. Now copy Per-Scene Start Frame Prompts.', 'success', 5000);

    // Refresh the modal to show updated status
    var modal = document.getElementById('sbProducerModal');
    if (modal) { modal.remove(); sbCopyBrief(); }
  }

  // ─── Phase 2a: Copy Per-Scene NB Prompts ────────────────────────────────────
  function sbCopyProducerNBPrompts() {
    var withNB = segments.filter(function(s) { return (s.nbPrompt || '').trim(); });
    if (!withNB.length) {
      showToast('Build prompts first — then optionally upload an establishing frame to lock the scene.', 'warning');
      return;
    }
    var n = withNB.length;
    var lines = [];
    var sceneReady = !!window._sbSceneDesc;

    lines.push(
      'Generate ' + n + ' start frame' + (n !== 1 ? 's' : '') + ' in NanoBanana — one per scene, in order. '
      + 'For each scene: open NanoBanana, upload the master reference image as your input image, '
      + 'then paste the scene prompt below. The reference image locks the character, background, and lighting. '
      + 'Change ONLY the starting pose per scene — keep the master reference loaded for all ' + n + ' scenes.'
    );
    lines.push('');

    withNB.forEach(function(seg, idx) {
      lines.push('--- Scene ' + (idx + 1) + ' of ' + n + ' ---');
      lines.push(seg.nbPrompt.trim());
      lines.push('');
    });

    lines.push('--- END: ' + n + ' composites total ---');
    var message = lines.join('\n');

    navigator.clipboard.writeText(message).then(function() {
      showToast(n + ' start frame prompts copied — generate each in NanoBanana using master reference, then bulk upload back here.', 'success', 4000);
    }).catch(function() {
      try {
        var ta = document.createElement('textarea'); ta.value = message;
        document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
        showToast(n + ' start frame prompts copied!', 'success', 3000);
      } catch(e) { showToast('Copy failed — please try again.', 'error'); }
    });
  }

  // ─── Phase 2b: Bulk Upload NB Composites ────────────────────────────────────
  function _sbBulkUploadProducerComposites(files) {
    if (!files || !files.length) return;
    var fileArr = Array.from(files);
    var loaded  = 0;
    var total   = Math.min(fileArr.length, segments.length);

    fileArr.slice(0, segments.length).forEach(function(file, i) {
      var reader = new FileReader();
      reader.onload = function(e) {
        // Assign as both the NB composite and the start frame for this segment
        segments[i].nbCompositeDataUrl = e.target.result;
        segments[i].frameDataUrl       = e.target.result; // used by Veo Agent as start frame
        loaded++;
        if (loaded === total) {
          saveSegments();
          if (typeof renderSegments === 'function') renderSegments();
          showToast(total + ' start frames uploaded ✅ — assigned in order. Now copy Scene Prompts for Google Flow.', 'success', 5000);
          // Refresh modal status
          var modal = document.getElementById('sbProducerModal');
          if (modal) { modal.remove(); sbCopyBrief(); }
        }
      };
      reader.onerror = function() {
        loaded++;
        if (loaded === total) {
          saveSegments();
          if (typeof renderSegments === 'function') renderSegments();
          showToast('Some images failed to read — others were uploaded. Check assignments.', 'warning', 5000);
          var modal2 = document.getElementById('sbProducerModal');
          if (modal2) { modal2.remove(); sbCopyBrief(); }
        }
      };
      reader.readAsDataURL(file);
    });
  }

  // ─── Phase 3: Copy Scene Prompts for Google Flow ────────────────────────────
  function copyProducerScenePrompts() {
    var withPrompts = segments.filter(function(s) { return (s.veoPrompt || '').trim(); });
    if (!withPrompts.length) {
      showToast('Build prompts first.', 'warning');
      return;
    }
    var n = withPrompts.length;
    var hasStartFrames = segments.filter(function(s) { return s.nbCompositeDataUrl || s.frameDataUrl; }).length;
    var lines = [];

    var _curModel = (typeof getAdminSettings === 'function') ? (getAdminSettings().defaultModel || 'Veo 3.1 Lite') : 'Veo 3.1 Lite';
    lines.push(
      'Using ' + _curModel + ' in Google Flow, generate ' + n + ' video clip' + (n !== 1 ? 's' : '') + ' — one per scene. '
      + (hasStartFrames > 0
        ? 'Upload the matching NanoBanana start frame for each clip — each was generated from the master reference, so character and scene stay consistent across all clips. '
        : 'Upload the master reference image as the start frame for each clip. ')
      + 'Scene 1 prompt goes to clip 1, Scene 2 to clip 2, and so on.\n\n'
      + 'CRITICAL — use every field exactly as written:\n'
      + '* "speech" is the exact spoken dialogue — enter it word for word.\n'
      + '* "action" is the exact motion — do not paraphrase or substitute.\n'
      + '* Do not skip any field, merge prompts, or carry text from one scene to the next.'
    );
    lines.push('');

    withPrompts.forEach(function(seg, idx) {
      var duration = Math.round((seg.endTime - seg.startTime) * 10) / 10;
      lines.push('--- Scene ' + (idx + 1) + ' of ' + n + ' ---');
      lines.push('Model: ' + _curModel);
      lines.push(seg.veoPrompt.trim());
      // Parse the veoPrompt once. sbBuildVeoJson encodes the speaking/non-speaking
      // decision directly: on-camera dialogue lives in `speech`; non-speaking
      // (product/hands/broll) clips emit speech:'' and put the line in `voiceover`.
      var pj; try { pj = JSON.parse(seg.veoPrompt); } catch(e) { pj = null; }
      // ONLY treat as on-camera speech when `speech` is non-empty — never fall
      // back to seg.script, which would force a lip-sync timing guide onto a
      // voiceover clip and defeat the voiceover design.
      var speechText = (pj && pj.speech) ? pj.speech : '';
      // Build the on-camera lip-sync timing guide for genuinely speaking clips only.
      if (speechText && typeof buildSpeechTimingGuide === 'function') {
        var timing = buildSpeechTimingGuide(speechText, duration);
        if (timing) { lines.push(''); lines.push('Speech timing:'); lines.push(timing); }
      }
      lines.push('');
    });

    lines.push('--- END: ' + n + ' scene' + (n !== 1 ? 's' : '') + ' total ---');
    var message = lines.join('\n');

    navigator.clipboard.writeText(message).then(function() {
      showToast(n + ' scene prompts copied — paste into Google Flow!', 'success', 3000);
    }).catch(function() {
      try {
        var ta = document.createElement('textarea'); ta.value = message;
        document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
        showToast(n + ' scene prompts copied!', 'success', 3000);
      } catch(e2) { showToast('Copy failed — please try again.', 'error'); }
    });
  }

  // ─── Auto-Plan: parse existing script into storyboard beats ─────────────────
  // Reads the user's script from the Script Editor textarea, sends one gpt-4o-mini
  // call, and pre-fills all storyboard beats in ~2 seconds. Video Producer only.
  async function parseScriptToStoryboard() {
    var scriptEl   = document.getElementById('originalScript');
    var scriptText = scriptEl ? scriptEl.value.trim() : '';
    if (!scriptText) {
      showToast('Paste your script into the Script Editor below first.', 'warning');
      return;
    }

    var apiKey = getApiKey();
    if (!apiKey) { showToast('Add your OpenAI API key in Settings first.', 'warning'); return; }
    if (typeof window.requireAccess === 'function' && !window.requireAccess()) return;

    var productName = (document.getElementById('sbProduct') ? document.getElementById('sbProduct').value.trim() : '') || 'the product';
    var formatPill  = document.querySelector('.sb-format-pill.active');
    var format      = formatPill ? formatPill.dataset.val : 'talking-head';

    var btn  = document.getElementById('sbAutoPlanBtn');
    var wrap = document.getElementById('sbResultsWrap');
    if (btn)  { btn.textContent = 'Parsing…'; btn.disabled = true; }
    if (wrap) {
      wrap.style.display = 'block';
      wrap.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-3);font-size:11px;">Parsing your script into beats…</div>';
    }

    var formatRule = format === 'talking-head'
      ? 'Every beat is a talking-head shot — presenter speaks directly to camera.'
      : format === 'demo'
        ? 'Mix of talking-head and product demo shots.'
        : 'UGC reveal — presenter reacts and demonstrates.';

    var userPrompt = 'Parse this video script into a structured storyboard for "' + productName + '".\n\n'
      + 'SCRIPT:\n' + scriptText + '\n\n'
      + 'FORMAT STYLE: ' + formatRule + '\n\n'
      + 'Instructions:\n'
      + '- Split the script into individual beats (one per line break, sentence, or natural pause)\n'
      + '- Each beat maps to one 6 or 8 second Veo 3 clip (2.5 wps speaking rate, snap duration to 6 or 8)\n'
      + '- Classify each beat: HOOK | PROBLEM | DISCOVERY | DEMO | PROOF | CTA\n'
      + '- Write an action: specific physical movement, third person, one sentence\n'
      + '- Choose sceneType (character|product|hands|broll), shot (extreme-cu|close-up|medium|wide|pov), camera (static|push-in|pan-left|pan-right|handheld)\n'
      + '- The "script" field MUST use the exact spoken words from the input — do not rewrite or shorten them\n'
      + '- Also generate 2 alternative HOOK rewrites with different angles\n\n'
      + 'Return ONLY valid JSON (no markdown fences):\n'
      + '{"hookOptions":[{"script":"...","angle":"direct"},{"script":"...","angle":"pov"}],'
      + '"beats":[{"type":"HOOK","script":"exact words","sceneType":"character","shot":"extreme-cu","camera":"static","action":"specific action","duration":6}]}';

    try {
      var res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
        body: JSON.stringify({
          model:           'gpt-4o-mini',
          messages:        [{ role: 'user', content: userPrompt }],
          response_format: { type: 'json_object' },
          temperature:     0.3,
          max_tokens:      2000,
        })
      });
      if (!res.ok) {
        var errData = await res.json().catch(function(){ return {}; });
        throw new Error((errData && errData.error && errData.error.message) || ('API error ' + res.status));
      }
      var data   = await res.json();
      var raw    = ((data.choices || [])[0] || {}).message
        ? (data.choices[0].message.content || '').trim() : '';
      var parsed;
      try { parsed = JSON.parse(raw); } catch(_) { throw new Error('Malformed JSON — please try again.'); }

      if (!parsed.beats || !Array.isArray(parsed.beats) || parsed.beats.length === 0) {
        throw new Error('No beats parsed — check your script and try again.');
      }

      window._sbBeats = parsed.beats.map(function(b) {
        return {
          id:        _sbMakeId(),
          type:      ((b.type || 'HOOK') + '').toUpperCase(),
          script:    (b.script || '').trim(),
          sceneType: b.sceneType || 'character',
          shot:      b.shot      || 'medium',
          camera:    b.camera    || 'static',
          action:    (b.action   || '').trim(),
          duration:  sbCalcDuration(b.script),
          locked:    false,
          veoPrompt: '',
          done:      false,
        };
      });

      window._sbHookOpts   = Array.isArray(parsed.hookOptions) ? parsed.hookOptions : [];
      window._sbHookChoice = 0;

      renderStoryboard();
      showToast('✅ ' + window._sbBeats.length + ' beats parsed — review and tweak, then Build All Prompts', 'success', 4000);
      // Auto-collapse script panel so beats are immediately visible
      var _sp = document.getElementById('vsPanelScript');
      if (_sp && _sp.dataset.collapsed !== '1') {
        var _sh = _sp.querySelector('.vs-panel-header.collapsible');
        if (_sh) _sh.click();
      }

    } catch(e) {
      if (wrap) {
        wrap.innerHTML = '<div style="padding:16px;color:var(--danger);font-size:11px;">'
          + 'Failed: ' + escHtml(e.message)
          + '<br><br><button onclick="parseScriptToStoryboard()" style="padding:4px 10px;font-size:10px;'
          + 'background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.4);border-radius:4px;'
          + 'color:#f87171;cursor:pointer;">Try again</button></div>';
      }
    } finally {
      if (btn) { btn.textContent = '✨ Parse to Storyboard'; btn.disabled = false; }
    }
  }
