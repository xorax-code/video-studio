  // ===== Speaking / non-speaking scene detection =====
  // The avatar should only lip-sync dialogue on scenes where it's actually
  // talking to camera. Product / hands / b-roll shots are NON-speaking — the
  // line becomes voiceover instead, so Veo doesn't render a mouth moving over
  // a product close-up. Detection is automatic:
  //   1. explicit sceneType from the storyboard ('product'|'hands'|'broll')
  //   2. otherwise inferred from the action / shot / frame text
  // Default is SPEAKING — we only flip to non-speaking on a clear signal, so
  // normal "talks to camera" scenes are never affected.
  window.detectNonSpeakingScene = function (o) {
    if (!o) return false;
    var st = String(o.sceneType || '').toLowerCase();
    if (st === 'product' || st === 'hands' || st === 'broll') return true;
    if (st === 'character') return false;
    var txt = [o.action, o._shot, o.shot, o.frameDesc]
      .map(function (x) { return String(x || ''); }).join(' ').toLowerCase();
    if (!txt.trim()) return false;
    // Strong speaking cues override everything (keeps default behavior safe).
    if (/\b(talk|talking|speak|speaking|says|saying|delivers?|deliver(?:ing)? (?:the )?line|to camera|piece to camera|monologue|voice[- ]?over the avatar|addresses the camera|lip[- ]?sync)\b/.test(txt)) return false;
    // Clear non-speaking cues: product-only / hands-only / b-roll / no face.
    return /\b(b-?roll|product (?:close-?up|shot|reveal|insert|demo)|insert shot|flat ?lay|pack ?shot|unboxing|hands? (?:only|close-?up|holding|applying|pouring|squeezing|spraying)|close-?up of (?:the )?product|no (?:one|person|people|face|avatar)|empty (?:room|scene|set)|on the table|texture shot|macro shot)\b/.test(txt);
  };
  window.sceneSpeaks = function (o) { return !window.detectNonSpeakingScene(o); };

  // ===== Anti-tattoo negative terms =====
  // Veo / the frame generator sometimes invent tattoos the uploaded avatar
  // doesn't have. Returns a negative-prompt fragment to suppress them — UNLESS
  // the avatar is actually described as tattooed, in which case it returns ''
  // so we never strip tattoos that are supposed to be there.
  window.antiTattooNeg = function () {
    try {
      var el = document.getElementById('avatarDesc');
      var d  = String((el && el.value) || (window._avatarDesc) || '').toLowerCase();
      if (/\b(tattoo|tattoos|tattooed|inked|body art)\b/.test(d)) return '';
    } catch (e) {}
    return 'tattoo, tattoos, body art, ink, inked skin, skin markings, arm tattoo, sleeve tattoo, neck tattoo, chest tattoo, hand tattoo, finger tattoo';
  };

  // ===== Clip fullscreen helper =====
  // The native <video> fullscreen button can silently no-op for clips that sit
  // inside a transformed/clipped container (e.g. continuation clips inside
  // .seg-card-floating). fsClip tries the real Fullscreen API first, then falls
  // back to a body-level overlay so the user ALWAYS gets a full-size view.
  window.fsClip = function (idOrEl) {
    var v = (typeof idOrEl === 'string') ? document.getElementById(idOrEl) : idOrEl;
    if (!v || v.tagName !== 'VIDEO') return;
    function lightbox() {
      if (document.getElementById('fsClipOverlay')) return;
      var o = document.createElement('div');
      o.id = 'fsClipOverlay';
      o.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,0.96);display:flex;align-items:center;justify-content:center;padding:24px;';
      var nv = document.createElement('video');
      nv.src = v.currentSrc || v.src;
      nv.controls = true; nv.autoplay = true; nv.playsInline = true;
      nv.style.cssText = 'max-width:100%;max-height:100%;border-radius:10px;background:#000;box-shadow:0 12px 60px rgba(0,0,0,0.7);';
      try { nv.currentTime = v.currentTime || 0; } catch (e) {}
      var x = document.createElement('button');
      x.textContent = '✕';
      x.style.cssText = 'position:absolute;top:18px;right:22px;width:40px;height:40px;border-radius:50%;background:rgba(255,255,255,0.14);border:1px solid rgba(255,255,255,0.3);color:#fff;font-size:18px;cursor:pointer;';
      function close() { try { nv.pause(); } catch (e) {} o.remove(); document.removeEventListener('keydown', onKey); }
      function onKey(e) { if (e.key === 'Escape') close(); }
      x.onclick = close;
      o.onclick = function (e) { if (e.target === o) close(); };
      document.addEventListener('keydown', onKey);
      o.appendChild(nv); o.appendChild(x);
      document.body.appendChild(o);
    }
    function fsActive() {
      return document.fullscreenElement || document.webkitFullscreenElement ||
             document.msFullscreenElement || v.webkitDisplayingFullscreen;
    }
    // iOS shows its own native player and doesn't set document.fullscreenElement —
    // trust it and don't second-guess with the lightbox.
    if (!v.requestFullscreen && !v.webkitRequestFullscreen && !v.msRequestFullscreen && v.webkitEnterFullscreen) {
      try { v.webkitEnterFullscreen(); } catch (e) { lightbox(); }
      return;
    }
    var req = v.requestFullscreen || v.webkitRequestFullscreen || v.msRequestFullscreen;
    if (req) {
      var done = false;
      try {
        var p = req.call(v);
        if (p && typeof p.catch === 'function') p.catch(function () { if (!done) { done = true; lightbox(); } });
      } catch (e) { lightbox(); return; }
      // Native fullscreen can RESOLVE yet silently no-op for a clip inside a
      // transformed/fixed container (e.g. continuation clips in the segment card):
      // the TAB enters fullscreen but the video collapses to nothing ("F11 the whole
      // tab"). So a beat later, verify the video is actually the fullscreen element
      // AND is filling the screen; if not, exit that broken fullscreen and use the
      // guaranteed body-level lightbox instead.
      setTimeout(function () {
        if (done) return;
        var fsEl = document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement;
        var r = v.getBoundingClientRect();
        // A properly fullscreened video fills at least ONE axis (portrait 9:16 clips
        // letterbox on wide screens — their width is small, so don't require width).
        // A truly collapsed/broken fullscreen has BOTH dims tiny → falls back to lightbox.
        var showingVideo = v.webkitDisplayingFullscreen ||
          (fsEl === v && (r.height > window.innerHeight * 0.85 || r.width > window.innerWidth * 0.85));
        if (!showingVideo) {
          done = true;
          if (fsEl) { try { (document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen).call(document); } catch (e) {} }
          lightbox();
        }
      }, 300);
    } else {
      lightbox();
    }
  };

  // Double-click ANY clip video to open it full-size. Capture phase + preventDefault
  // so this beats the browser's native dbl-click-fullscreen (which is the control that
  // fails on continuation clips); fsClip still tries true fullscreen first.
  if (!window._fsClipBound) {
    window._fsClipBound = true;
    document.addEventListener('dblclick', function (e) {
      var t = e.target;
      if (t && t.tagName === 'VIDEO') { e.preventDefault(); window.fsClip(t); }
    }, true);
  }

  // ===== Veo speech sync =====
  // Sync a Veo 3 JSON prompt's spoken text to the live script. When the script is
  // EMPTY, also strip any "speaks / talking" directives (including the two-person
  // "the person on the left speaks" tag) and forbid lip movement — so an empty
  // script never forces the avatar to mouth words. Only touches speech / action /
  // negative_prompt; everything else (shot, camera, etc.) is preserved.
  window.veoSyncSpeech = function (promptStr, liveText) {
    if (!promptStr) return promptStr;
    var txt = (liveText == null) ? '' : String(liveText);
    var o;
    try { o = JSON.parse(promptStr); } catch (e) { return promptStr; }
    if (!o || typeof o !== 'object') return promptStr;
    o.speech = txt.trim() ? txt : '';
    if (!txt.trim()) {
      var a = String(o.action || '');
      a = a.replace(/\bspeaks\b/gi, 'stays silent, mouth closed')
           .replace(/\bis the speaker\b/gi, 'stays silent')
           .replace(/\bdelivers (?:the |every )?(?:line|lines|word|words|speech)\b/gi, 'stays silent')
           .replace(/\b(?:mouth moves|moving mouth)\b/gi, 'mouth stays closed')
           .replace(/\b(?:talking|speaking)\b/gi, 'silent');
      o.action = 'No one speaks in this clip — every person keeps their mouth closed with no lip movement or talking. ' + a;
      var neg = String(o.negative_prompt || '');
      neg = neg.replace(/(^|,\s*)silent avatar/gi, '').replace(/(^|,\s*)listener speaking/gi, '').replace(/^[,\s]+/, '').trim();
      o.negative_prompt = 'talking, speaking, lip sync, mouth moving, mouthing words' + (neg ? ', ' + neg : '');
    }
    try { return JSON.stringify(o, null, 2); } catch (e) { return promptStr; }
  };

  // ===== DASHBOARD =====
  function renderDashboard() {
    const container = document.getElementById('dashboardContainer');
    if (!container) return;

    const now = new Date();
    const todayKey = now.toISOString().split('T')[0];
    const dayNames  = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const h = now.getHours();
    const _prof = getUserSettings() || {};
    const _namePart = _prof.displayName ? `, ${escHtml(_prof.displayName)}` : '';
    const greeting = (h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening') + _namePart;
    const _tagline = _prof.tagline || '';
    const dateStr = `${dayNames[now.getDay()]}, ${monthNames[now.getMonth()]} ${now.getDate()}`;

    // Daily motivational quote — rotates by day of year, consistent all day
    const quotes = [
      { q: "The only way to do great work is to love what you do.", a: "Steve Jobs" },
      { q: "Consistency is what transforms average into excellence.", a: "Anonymous" },
      { q: "You don't have to be great to start, but you have to start to be great.", a: "Zig Ziglar" },
      { q: "Content is king, but consistency is the kingdom.", a: "Anonymous" },
      { q: "Do something today that your future self will thank you for.", a: "Sean Patrick Flanery" },
      { q: "The secret of getting ahead is getting started.", a: "Mark Twain" },
      { q: "Small daily improvements lead to stunning results.", a: "Robin Sharma" },
      { q: "One video a day keeps the broke life away.", a: "Creator's Creed" },
      { q: "Don't count the days — make the days count.", a: "Muhammad Ali" },
      { q: "Your network is your net worth — start posting.", a: "Porter Gale" },
      { q: "The best time to post was yesterday. The second best time is now.", a: "Adapted" },
      { q: "Every post is a chance to reach someone new.", a: "Anonymous" },
      { q: "Show up every day, even when it feels pointless. Especially then.", a: "Anonymous" },
      { q: "Discipline is choosing between what you want now and what you want most.", a: "Abraham Lincoln" },
      { q: "Done is better than perfect.", a: "Sheryl Sandberg" },
      { q: "The grind is the glory.", a: "Anonymous" },
      { q: "Success is the sum of small efforts repeated day in and day out.", a: "Robert Collier" },
      { q: "Build something today — even if it's just one clip.", a: "Anonymous" },
      { q: "Opportunity doesn't make appointments. You have to be ready.", a: "Tim Fargo" },
      { q: "Your breakthrough is on the other side of your consistency.", a: "Anonymous" },
      { q: "What you do every day matters more than what you do once in a while.", a: "Gretchen Rubin" },
      { q: "A year from now you'll wish you started today.", a: "Karen Lamb" },
      { q: "Post it. Don't overthink it.", a: "Anonymous" },
      { q: "Execution beats ideas every time.", a: "Anonymous" },
      { q: "The algorithm rewards the consistent, not the talented.", a: "Anonymous" },
      { q: "Winners aren't people who never fail, but those who never quit.", a: "Edwin Louis Cole" },
      { q: "One post at a time. One day at a time.", a: "Anonymous" },
      { q: "Volume wins. Post more.", a: "Anonymous" },
      { q: "Stop waiting for the perfect moment. Take the moment and make it perfect.", a: "Zoey Sayward" },
      { q: "Your content is your currency. Spend it wisely — but spend it.", a: "Anonymous" },
    ];
    const dayOfYear = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86400000);
    const todayQuote = quotes[dayOfYear % quotes.length];

    // Stats
    const totalAccounts   = (accounts || []).length;
    const activeAccounts  = (accounts || []).filter(a => a.status === 'Active').length;
    const totalScripts    = (viralScripts || []).length;
    const scriptsToTry    = (viralScripts || []).filter(s => s.status === 'To Try').length;
    const thisMonth       = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
    const postedThisMonth = (videoLog || []).filter(e => e.date && e.date.startsWith(thisMonth)).length;

    // Posting streak — consecutive days (ending today or yesterday) with at least one video logged
    function calcPostingStreak() {
      const logDates = new Set((videoLog || []).filter(v => v.date).map(v => v.date.slice(0, 10)));
      if (logDates.size === 0) return 0;
      let streak = 0;
      const d = new Date(now);
      const todayStr = d.toISOString().slice(0, 10);
      if (!logDates.has(todayStr)) d.setDate(d.getDate() - 1);
      while (true) {
        const key = d.toISOString().slice(0, 10);
        if (!logDates.has(key)) break;
        streak++;
        d.setDate(d.getDate() - 1);
      }
      return streak;
    }
    const postingStreak = calcPostingStreak();

    // Today's plan
    const todayItems = (dailyItems || []).filter(i => i.date === todayKey);
    const doneCount  = todayItems.filter(i => i.done).length;
    const leftCount  = todayItems.length - doneCount;

    // Greeting subtitle
    let greetingSub = '';
    if (totalAccounts === 0) {
      greetingSub = 'Add your first account to get started.';
    } else if (todayItems.length === 0) {
      greetingSub = `${activeAccounts} active account${activeAccounts !== 1 ? 's' : ''}. Nothing planned for today yet.`;
    } else if (leftCount === 0) {
      greetingSub = `All ${todayItems.length} post${todayItems.length !== 1 ? 's' : ''} done for today. Nice work. 🎉`;
    } else {
      greetingSub = `${leftCount} post${leftCount !== 1 ? 's' : ''} left to do today across ${activeAccounts} active account${activeAccounts !== 1 ? 's' : ''}.`;
    }

    // Account health
    const acctHealth = (accounts || []).map(a => {
      const posts = (videoLog || []).filter(e => e.accountId === a.id && e.date).sort((x,y) => y.date.localeCompare(x.date));
      const lastDate = posts[0]?.date || null;
      const daysAgo  = lastDate ? Math.floor((now - new Date(lastDate)) / 86400000) : null;
      return { ...a, lastDate, daysAgo };
    });

    function healthBadge(a) {
      if (a.daysAgo === null)  return { label: 'Never posted',       cls: 'cold' };
      if (a.daysAgo === 0)     return { label: 'Posted today ✓',     cls: 'ok'   };
      if (a.daysAgo === 1)     return { label: 'Yesterday',          cls: 'ok'   };
      if (a.daysAgo <= 4)      return { label: `${a.daysAgo}d ago`,  cls: 'ok'   };
      if (a.daysAgo <= 7)      return { label: `${a.daysAgo}d ago ·`, cls: 'warn' };
      return { label: `${a.daysAgo}d ago ⚠`,  cls: 'cold' };
    }

    function acctCardHtml(a) {
      const badge  = healthBadge(a);
      const color  = _safeCssColor(a.brandColor) || '#7c6af7';
      const avatar = a.avatar
        ? `<img src="${escHtml(a.avatar)}" style="width:26px;height:26px;border-radius:50%;object-fit:cover;flex-shrink:0;margin-bottom:7px;border:1.5px solid ${color}44;">`
        : `<div style="width:26px;height:26px;border-radius:50%;background:${color}22;border:1.5px solid ${color}55;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:${color};margin-bottom:7px;">${(a.username||'?')[0].toUpperCase()}</div>`;
      return `<div class="db-acct-card ${badge.cls === 'ok' ? '' : badge.cls}" title="${escHtml(a.username)} · ${badge.label}">
        ${avatar}
        <div class="db-acct-name">${escHtml(a.username)}</div>
        <div class="db-acct-last ${badge.cls}">${badge.label}</div>
      </div>`;
    }

    function todayItemHtml(item) {
      const acct   = (accounts || []).find(a => a.id === item.accountId);
      const name   = acct ? escHtml(acct.username) : 'Unknown';
      const color  = _safeCssColor(acct?.brandColor) || '#7c6af7';
      const preview = item.script ? escHtml(item.script.slice(0, 72)) + (item.script.length > 72 ? '…' : '') : 'No script added';
      return `<div class="db-today-item ${item.done ? 'done' : ''}">
        <div class="db-today-check ${item.done ? 'checked' : ''}" onclick="toggleDailyDone(${escHtml(JSON.stringify(item.id))})" style="cursor:pointer;" title="${item.done ? 'Mark undone' : 'Mark done'}">${item.done ? '<i class="ti ti-check" style="font-size:8px;color:#fff;"></i>' : ''}</div>
        <div style="width:7px;height:7px;border-radius:50%;background:${color};flex-shrink:0;box-shadow:0 0 6px ${color}88;"></div>
        <div class="db-today-acct">${name}</div>
        <div class="db-today-script">${preview}</div>
      </div>`;
    }

    const emptyBox = (icon, msg, btnLabel, btnTab) => `
      <div class="db-empty-box">
        <div class="db-empty-icon">${icon}</div>
        ${msg}
        <div style="margin-top:10px;"><button onclick="switchTab('${btnTab}')" style="background:none;border:1px solid var(--border-2);border-radius:var(--radius-xs);color:var(--text-3);font-size:11px;padding:4px 14px;cursor:pointer;font-family:inherit;">${btnLabel} →</button></div>
      </div>`;

    // ── Onboarding checklist (shown until dismissed) ──
    const onboardDismissed = localStorage.getItem('onboardingDismissed') === '1';
    const onboardCollapsed = localStorage.getItem('onboardingCollapsed') === '1';
    let onboardStepsRaw = {}; try { onboardStepsRaw = JSON.parse(localStorage.getItem('onboardingSteps') || '{}'); } catch(e) {}

    const onboardStepDefs = [
      { id: 'accounts',   label: 'Add your first account',          tab: 'my-accounts',    done: (accounts || []).length > 0 },
      { id: 'scripts',    label: 'Save a viral script',             tab: 'viral-scripts',  done: (viralScripts || []).length > 0 },
      { id: 'replicator', label: 'Open the Video Replicator',       tab: 'video-replicator', done: !!onboardStepsRaw.replicator },
      { id: 'plan',       label: 'Plan your first post',            tab: 'calendar',       done: (dailyItems || []).length > 0 },
      { id: 'settings',   label: 'Customise your profile',          tab: null,             done: !!onboardStepsRaw.settings },
    ];

    // Auto-save auto-detected steps
    const autoSteps = { ...onboardStepsRaw };
    let autoChanged = false;
    onboardStepDefs.forEach(s => {
      if (s.done && !autoSteps[s.id]) { autoSteps[s.id] = true; autoChanged = true; }
    });
    if (autoChanged) localStorage.setItem('onboardingSteps', JSON.stringify(autoSteps));

    const stepsState = onboardStepDefs.map(s => ({ ...s, done: s.done || !!autoSteps[s.id] }));
    const doneSteps  = stepsState.filter(s => s.done).length;
    const allDone    = doneSteps === stepsState.length;
    const pct        = Math.round(doneSteps / stepsState.length * 100);

    function onboardStepHtml(s) {
      return `<div class="onboard-step${s.done ? ' done' : ''}" onclick="onboardStepClick(${escHtml(JSON.stringify(s.id))},${escHtml(JSON.stringify(s.tab || ''))})">
        <div class="onboard-step-check">${s.done ? '<i class="ti ti-check" style="font-size:9px;"></i>' : ''}</div>
        <span>${s.label}</span>
      </div>`;
    }

    const onboardHtml = (onboardDismissed || allDone) ? '' : `
      <div class="onboard-card" id="onboardCard">
        <div class="onboard-header">
          <div class="onboard-title">
            <i class="ti ti-rocket" style="color:var(--accent-2);font-size:15px;"></i>
            Setup guide
            <span class="onboard-progress-text">${doneSteps}/${stepsState.length} done</span>
          </div>
          <button class="onboard-collapse-btn" onclick="onboardToggleCollapse()" id="onboardCollapseBtn" title="${onboardCollapsed ? 'Expand' : 'Collapse'}">
            <i class="ti ${onboardCollapsed ? 'ti-chevron-down' : 'ti-chevron-up'}"></i>
          </button>
        </div>
        <div class="onboard-progress-bar"><div class="onboard-progress-fill" style="width:${pct}%;"></div></div>
        <div id="onboardStepsList" style="${onboardCollapsed ? 'display:none;' : ''}">
          <div class="onboard-steps">${stepsState.map(onboardStepHtml).join('')}</div>
          <div class="onboard-footer">
            <button class="onboard-dismiss-btn" onclick="onboardDismiss()">Dismiss</button>
          </div>
        </div>
      </div>`;

    // "Start Here" card — only shown the first few times (before user has processed any video)
    const hideStartCard = localStorage.getItem('hideStartCard') === '1' || (typeof segments !== 'undefined' && segments.length > 0);
    const startCardHtml = hideStartCard ? '' : `
      <div id="startCardBanner" style="background:linear-gradient(135deg,rgba(124,106,247,0.12),rgba(16,185,129,0.08));border:1px solid rgba(124,106,247,0.35);border-radius:14px;padding:18px 20px;display:flex;align-items:center;gap:16px;position:relative;overflow:hidden;margin-bottom:2px;">
        <div style="position:absolute;inset:0;background:radial-gradient(ellipse at 30% 50%,rgba(124,106,247,0.08) 0%,transparent 70%);pointer-events:none;"></div>
        <div style="font-size:36px;flex-shrink:0;">🎬</div>
        <div style="flex:1;min-width:0;">
          <div style="font-size:14px;font-weight:800;color:var(--text-1);letter-spacing:-0.03em;margin-bottom:4px;">Clone your first viral video</div>
          <div style="font-size:12px;color:var(--text-3);line-height:1.5;">Paste a TikTok or Reel URL → AI splits it into scenes → copy your NB Pro &amp; Veo 3 prompts.</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;flex-shrink:0;">
          <button onclick="switchTab('video-replicator');localStorage.setItem('hideStartCard','1');" style="padding:9px 18px;font-size:12px;font-weight:700;background:var(--grad-accent);border:none;border-radius:8px;color:#fff;cursor:pointer;font-family:inherit;white-space:nowrap;">Open Replicator →</button>
          <button onclick="document.getElementById('startCardBanner').remove();localStorage.setItem('hideStartCard','1')" style="background:none;border:none;font-size:11px;color:var(--text-3);cursor:pointer;font-family:inherit;text-align:center;">Dismiss</button>
        </div>
      </div>`;

    container.innerHTML = `
      ${startCardHtml}
      ${onboardHtml}
      <div class="db-greeting">
        <div class="db-greeting-date">${dateStr}</div>
        <div class="db-greeting-title">${greeting}.</div>
        ${_tagline ? `<div style="font-size:11px;color:var(--accent);font-weight:600;margin-top:3px;margin-bottom:2px;">${escHtml(_tagline)}</div>` : ''}
        <div class="db-greeting-sub">${greetingSub}</div>
        <div style="display:flex;align-items:stretch;gap:12px;margin-top:14px;flex-wrap:wrap;">
          ${postingStreak > 0 ? `<div style="display:flex;align-items:center;gap:8px;padding:10px 16px;background:rgba(251,191,36,0.08);border:1px solid rgba(251,191,36,0.28);border-radius:10px;flex-shrink:0;">
            <span style="font-size:22px;line-height:1;">🔥</span>
            <div>
              <div style="font-size:16px;font-weight:900;color:var(--warning);letter-spacing:-0.5px;line-height:1;">${postingStreak}-day streak</div>
              <div style="font-size:9.5px;color:var(--text-3);font-weight:600;margin-top:2px;">Keep posting!</div>
            </div>
          </div>` : `<div style="display:flex;align-items:center;gap:8px;padding:10px 16px;background:var(--glass-2);border:1px solid var(--glass-border);border-radius:10px;flex-shrink:0;">
            <span style="font-size:22px;line-height:1;">🎯</span>
            <div>
              <div style="font-size:14px;font-weight:800;color:var(--text-2);line-height:1;">Start your streak</div>
              <div style="font-size:9.5px;color:var(--text-3);font-weight:600;margin-top:2px;">Post today to begin</div>
            </div>
          </div>`}
          <div class="db-quote" style="flex:1;min-width:180px;padding:10px 14px;background:var(--glass-2);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);border:1px solid var(--glass-border);border-left:3px solid var(--accent);border-radius:var(--radius-sm);box-shadow:var(--shadow-card);">
            <div style="font-size:12px;color:var(--text-2);font-style:italic;line-height:1.55;">"${todayQuote.q}"</div>
            <div style="font-size:10px;color:var(--text-3);font-weight:600;margin-top:4px;text-transform:uppercase;letter-spacing:0.5px;">— ${todayQuote.a}</div>
          </div>
        </div>
      </div>

      <div class="db-stats">
        <div class="db-stat db-stat-accounts">
          <div class="db-stat-num">${totalAccounts}</div>
          <div class="db-stat-label">Accounts</div>
        </div>
        <div class="db-stat db-stat-scripts">
          <div class="db-stat-num">${totalScripts}</div>
          <div class="db-stat-label">Scripts Saved</div>
        </div>
        <div class="db-stat db-stat-posted">
          <div class="db-stat-num">${postedThisMonth}</div>
          <div class="db-stat-label">Posted This Month</div>
        </div>
        <div class="db-stat db-stat-try">
          <div class="db-stat-num">${scriptsToTry}</div>
          <div class="db-stat-label">Scripts to Try</div>
        </div>
      </div>

      <div class="db-two-col">
        <div>
          <div class="db-section-label">
            <span>Today's Plan${todayItems.length > 0 ? `&nbsp;<span style="color:var(--text-3);font-weight:500;text-transform:none;letter-spacing:0;">(${doneCount}/${todayItems.length} done)</span>` : ''}</span>
            <button class="db-section-link" onclick="switchTab('calendar')">Open Daily Plan →</button>
          </div>
          ${todayItems.length === 0
            ? emptyBox('📅', 'Nothing planned for today yet.', 'Plan Today', 'calendar')
            : todayItems.map(todayItemHtml).join('')}
        </div>

        <div>
          <div class="db-section-label">
            <span>Account Health</span>
            <button class="db-section-link" onclick="switchTab('my-accounts')">Manage →</button>
          </div>
          ${(accounts || []).length === 0
            ? emptyBox('👤', 'No accounts yet.', 'Add Account', 'my-accounts')
            : `<div class="db-health-grid">${acctHealth.map(acctCardHtml).join('')}</div>`}
        </div>
      </div>

      <div class="db-section-label">Quick Actions</div>
      <div class="db-quick-actions">
        <button class="db-qa-btn primary" onclick="switchTab('video-replicator')">
          <i class="ti ti-movie db-qa-icon"></i> Clone a Video
        </button>
        <button class="db-qa-btn" onclick="switchTab('calendar')">
          <i class="ti ti-calendar db-qa-icon"></i> Plan Today
        </button>
        <button class="db-qa-btn" onclick="switchTab('viral-scripts')">
          <i class="ti ti-flame db-qa-icon"></i> Browse Scripts
        </button>
        <button class="db-qa-btn" onclick="switchTab('my-accounts')">
          <i class="ti ti-users db-qa-icon"></i> My Accounts
        </button>
      </div>
    `;
  }

  // ===== VIRAL SCRIPTS SUB-TABS =====
  let activeScriptSubTab = 'scripts';
  function switchScriptSubTab(name) {
    activeScriptSubTab = name;
    // update buttons
    ['scripts','hooks','ctas','ideas','calendar'].forEach(n => {
      const btn = document.getElementById('vsSubtab-' + n);
      if (btn) btn.classList.toggle('active', n === name);
    });
    // show/hide panels
    ['scripts','hooks','ctas','ideas','calendar'].forEach(n => {
      const panel = document.getElementById('vsSubpanel-' + n);
      if (panel) panel.style.display = n === name ? '' : 'none';
    });
    // trigger renders
    if (name === 'scripts')  renderScripts();
    if (name === 'hooks')    renderHookBank();
    if (name === 'ctas')     renderCTALibrary();
    if (name === 'ideas')    renderIdeasInbox();
    if (name === 'calendar') renderVsCalendar();
  }

  // ===== VIRAL SCRIPTS CONTENT CALENDAR =====
  let _vsCalYear  = new Date().getFullYear();
  let _vsCalMonth = new Date().getMonth(); // 0-based
  let _vsCalSelectedDate = null;

  const _vsCalMonthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];

  function vsCalPrevMonth() { _vsCalMonth--; if (_vsCalMonth < 0) { _vsCalMonth = 11; _vsCalYear--; } renderVsCalendar(); }
  function vsCalNextMonth() { _vsCalMonth++; if (_vsCalMonth > 11) { _vsCalMonth = 0;  _vsCalYear++; } renderVsCalendar(); }
  function vsCalGoToday()   { const n = new Date(); _vsCalYear = n.getFullYear(); _vsCalMonth = n.getMonth(); renderVsCalendar(); }

  function renderVsCalendar() {
    const labelEl = document.getElementById('vsCalMonthLabel');
    if (labelEl) labelEl.textContent = _vsCalMonthNames[_vsCalMonth] + ' ' + _vsCalYear;

    const grid = document.getElementById('vsCalGrid');
    if (!grid) return;

    const today   = new Date().toISOString().slice(0, 10);
    const firstDay = new Date(_vsCalYear, _vsCalMonth, 1).getDay(); // 0=Sun
    const daysInMonth = new Date(_vsCalYear, _vsCalMonth + 1, 0).getDate();

    // Build account color map for dots
    const acctColors = ['#818cf8','#34d399','#fb923c','#f472b6','#60a5fa','#a78bfa','#fbbf24'];
    const acctColorMap = {};
    (accounts || []).forEach((a, i) => { acctColorMap[a.id] = acctColors[i % acctColors.length]; });

    let cells = '';
    // Empty cells before first day
    for (let s = 0; s < firstDay; s++) cells += '<div></div>';

    for (let d = 1; d <= daysInMonth; d++) {
      const key = `${_vsCalYear}-${String(_vsCalMonth+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const isToday    = key === today;
      const isSelected = key === _vsCalSelectedDate;
      const dayItems   = (dailyItems || []).filter(i => i.date === key);
      const dotAccts   = [...new Set(dayItems.map(i => i.accountId))].slice(0, 4);

      const bg      = isSelected ? 'rgba(139,92,246,0.2)' : isToday ? 'rgba(139,92,246,0.08)' : 'var(--surface-2)';
      const border  = isSelected ? '1.5px solid rgba(139,92,246,0.6)' : isToday ? '1px solid rgba(139,92,246,0.3)' : '1px solid var(--border)';
      const numColor = isToday ? 'var(--accent-2)' : 'var(--text-2)';

      const dots = dotAccts.map(id => `<div style="width:6px;height:6px;border-radius:50%;background:${acctColorMap[id] || '#64748b'};flex-shrink:0;"></div>`).join('');
      const countBadge = dayItems.length > 4 ? `<span style="font-size:8px;color:var(--text-3);">+${dayItems.length-4}</span>` : '';
      const hoverIn  = isSelected ? '' : `this.style.background='var(--surface-3)'`;
      const hoverOut = `this.style.background='${bg}'`;

      cells += `<div onclick="vsCalSelectDay('${key}')" style="min-height:56px;border-radius:6px;padding:5px 6px;cursor:pointer;background:${bg};border:${border};display:flex;flex-direction:column;gap:3px;transition:background 0.1s;" onmouseenter="${hoverIn}" onmouseleave="${hoverOut}">
        <div style="font-size:11px;font-weight:${isToday?'700':'500'};color:${numColor};">${d}</div>
        <div style="display:flex;flex-wrap:wrap;gap:2px;align-items:center;">${dots}${countBadge}</div>
      </div>`;
    }
    grid.innerHTML = cells;

    // Refresh day detail if a date is selected
    if (_vsCalSelectedDate) vsCalRenderDayDetail(_vsCalSelectedDate);
  }

  function vsCalSelectDay(dateKey) {
    _vsCalSelectedDate = dateKey;
    renderVsCalendar(); // re-render to update selection highlight
    vsCalRenderDayDetail(dateKey);
  }

  function vsCalRenderDayDetail(dateKey) {
    const detail = document.getElementById('vsCalDayDetail');
    const title  = document.getElementById('vsCalDayDetailTitle');
    const items  = document.getElementById('vsCalDayItems');
    if (!detail || !title || !items) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return;

    const [y, m, d] = dateKey.split('-').map(Number);
    const label = _vsCalMonthNames[m-1] + ' ' + d + ', ' + y;
    title.textContent = label;
    detail.style.display = 'block';

    const dayItems = (dailyItems || []).filter(i => i.date === dateKey);
    if (dayItems.length === 0) {
      items.innerHTML = '<div style="font-size:12px;color:var(--text-3);padding:8px 0;">Nothing scheduled. Click "+ Schedule Post" to add one.</div>';
      return;
    }
    items.innerHTML = dayItems.map(item => {
      const acct = (accounts || []).find(a => a.id === item.accountId);
      const acctName = acct ? (acct.username || acct.platform || 'Account') : 'Unknown account';
      const preview = (item.script || '').slice(0, 80) + ((item.script || '').length > 80 ? '…' : '');
      const doneStyle = item.done ? 'opacity:0.5;text-decoration:line-through;' : '';
      return `<div style="display:flex;align-items:flex-start;gap:10px;padding:8px 10px;background:var(--surface);border:1px solid var(--border);border-radius:7px;${doneStyle}">
        <input type="checkbox" ${item.done?'checked':''} onchange="vsCalToggleDone(${escHtml(JSON.stringify(item.id))},this.checked)" style="margin-top:3px;cursor:pointer;accent-color:var(--accent);">
        <div style="flex:1;min-width:0;">
          <div style="font-size:11px;font-weight:600;color:var(--accent-2);margin-bottom:2px;">${escHtml(acctName)}</div>
          ${preview ? `<div style="font-size:11px;color:var(--text-2);line-height:1.4;">${escHtml(preview)}</div>` : '<div style="font-size:11px;color:var(--text-3);">No script</div>'}
        </div>
        <button onclick="vsCalRemoveItem(${escHtml(JSON.stringify(item.id))})" style="padding:2px 7px;font-size:10px;background:rgba(248,113,113,0.08);border:1px solid rgba(248,113,113,0.2);border-radius:4px;color:var(--danger);cursor:pointer;flex-shrink:0;">✕</button>
      </div>`;
    }).join('');
  }

  function vsCalToggleDone(id, checked) {
    const item = (dailyItems || []).find(i => i.id === id);
    if (item) {
      item.done = checked;
      saveDailyItems();
      if (_vsCalSelectedDate) vsCalRenderDayDetail(_vsCalSelectedDate);
    }
  }

  function vsCalRemoveItem(id) {
    showConfirm('Remove this scheduled post?', () => {
      dailyItems = (dailyItems || []).filter(i => i.id !== id);
      saveDailyItems();
      renderVsCalendar();
    });
  }

  function vsCalSchedulePost() {
    // Pre-fill the daily plan modal with selected date then open it
    if (_vsCalSelectedDate) {
      // Navigate to Calendar tab with that date selected
      switchTab('calendar');
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (typeof jumpToDate === 'function' && _vsCalSelectedDate) jumpToDate(_vsCalSelectedDate);
          if (typeof openDailyItemModal === 'function') openDailyItemModal();
        });
      });
    } else {
      switchTab('calendar');
      showToast('Select a day on the calendar first.', 'warning');
    }
  }

  // ===== COLLAPSIBLE VS PANEL TOGGLE =====
  function vsPanelToggle(headerEl) {
    const panel = headerEl.parentElement;
    const arrow = headerEl.querySelector('.vsp-arrow');
    const isCollapsed = panel.dataset.collapsed === '1';
    panel.dataset.collapsed = isCollapsed ? '' : '1';
    Array.from(panel.children).forEach(c => {
      if (c === headerEl || c.classList.contains('vs-panel-resize-handle')) return;
      c.style.display = isCollapsed ? '' : 'none';
    });
    const handle = panel.querySelector('.vs-panel-resize-handle');
    if (handle) handle.style.display = isCollapsed ? '' : 'none';
    if (arrow) arrow.style.transform = isCollapsed ? 'rotate(0deg)' : 'rotate(-90deg)';
  }

  // ===== USER SETTINGS =====
  const USER_DEFAULTS = {
    dlPath: '',
    claudeBrowserMode: true,   // true = full automation, false = manual copy-paste
    themeMode: 'system',       // 'dark' | 'light' | 'system'
    uiScale: 100,              // percentage: 80–150
    // Profile
    displayName: '',
    tagline: '',
    avatarDataUrl: '',
    // Goals
    weeklyGoal: 7,
    reminderEnabled: false,
    reminderTime: '09:00',
    goalsPerPlatform: {},      // { 'TikTok': 3, 'Instagram': 2, ... }
    // Appearance
    accentColor: 'purple',
    bgTheme: 'midnight',
    highContrast: false,
    reduceMotion: false,
  };
  function getUserSettings() {
    try {
      const s = localStorage.getItem('sm_user_settings');
      return s ? { ...USER_DEFAULTS, ...JSON.parse(s) } : { ...USER_DEFAULTS };
    } catch(e) { return { ...USER_DEFAULTS }; }
  }
  function saveUserSettings(obj) {
    try { localStorage.setItem('sm_user_settings', JSON.stringify(obj)); } catch(e) { console.warn('saveUserSettings failed:', e); }
  }

  // ── ACCENT COLOR ENGINE ──
  const ACCENT_PRESETS = {
    purple: { base:'#7c6af7', light:'#a78bfa', lighter:'#c4b5fd' },
    blue:   { base:'#3b82f6', light:'#60a5fa', lighter:'#93c5fd' },
    teal:   { base:'#14b8a6', light:'#2dd4bf', lighter:'#5eead4' },
    green:  { base:'#22c55e', light:'#4ade80', lighter:'#86efac' },
    rose:   { base:'#f43f5e', light:'#fb7185', lighter:'#fda4af' },
    orange: { base:'#f97316', light:'#fb923c', lighter:'#fdba74' },
    amber:  { base:'#f59e0b', light:'#fbbf24', lighter:'#fcd34d' },
    pink:   { base:'#ec4899', light:'#f472b6', lighter:'#f9a8d4' },
    gray:   { base:'#6b7280', light:'#9ca3af', lighter:'#d1d5db' },
    black:  { base:'#1f2937', light:'#374151', lighter:'#6b7280' },
  };
  function _hexToRgb(hex) {
    return `${parseInt(hex.slice(1,3),16)},${parseInt(hex.slice(3,5),16)},${parseInt(hex.slice(5,7),16)}`;
  }
  function applyAccentColor(name) {
    const p = ACCENT_PRESETS[name] || ACCENT_PRESETS.purple;
    const r = document.documentElement;
    r.style.setProperty('--accent', p.base);
    r.style.setProperty('--accent-2', p.light);
    r.style.setProperty('--accent-3', p.lighter);
    r.style.setProperty('--accent-glow', `rgba(${_hexToRgb(p.base)},0.22)`);
    r.style.setProperty('--accent-glow-sm', `rgba(${_hexToRgb(p.base)},0.10)`);
    r.style.setProperty('--accent-light', `rgba(${_hexToRgb(p.base)},0.13)`);
    r.style.setProperty('--grad-accent', `linear-gradient(135deg, ${p.base} 0%, ${p.light} 60%, ${p.lighter} 100%)`);
    r.style.setProperty('--grad-accent-soft', `linear-gradient(135deg, rgba(${_hexToRgb(p.base)},0.15) 0%, rgba(${_hexToRgb(p.light)},0.08) 100%)`);
    r.style.setProperty('--grad-accent-hover', `linear-gradient(135deg, rgba(${_hexToRgb(p.base)},0.22) 0%, rgba(${_hexToRgb(p.light)},0.12) 100%)`);
    r.style.setProperty('--shadow-glow', `0 0 0 1px rgba(${_hexToRgb(p.base)},0.18), 0 4px 24px rgba(${_hexToRgb(p.base)},0.22), 0 1px 4px rgba(0,0,0,0.3)`);
    r.style.setProperty('--shadow-glow-sm', `0 0 0 1px rgba(${_hexToRgb(p.base)},0.12), 0 2px 12px rgba(${_hexToRgb(p.base)},0.16)`);
  }

  function getEffectiveDlPath() {
    const u = getUserSettings() || {};
    if (u.dlPath && u.dlPath.trim()) return u.dlPath.trim();
    const a = getAdminSettings();
    return (a.dlPath && a.dlPath.trim()) ? a.dlPath.trim() : '';
  }

  // ===== ADMIN SETTINGS =====
  const ADMIN_DEFAULTS = {
    dlPath: '',
    nbWaitSec: 180,
    veoWaitMin: 6,
    maxTabRefresh: 0,
    cooldownSec: 120,
    defaultModel: 'Veo 3.1 Lite',
    defaultAspect: '9:16',
    creditBudget: 0,
    nbPromptDefault: '',
    veoPromptDefault: '',
    admAccounts: []
  };
  function getAdminSettings() {
    try {
      const s = localStorage.getItem('sm_admin_settings');
      return s ? { ...ADMIN_DEFAULTS, ...JSON.parse(s) } : { ...ADMIN_DEFAULTS };
    } catch(e) { return { ...ADMIN_DEFAULTS }; }
  }
  function saveAdminSettings(obj) {
    try { localStorage.setItem('sm_admin_settings', JSON.stringify(obj)); } catch(e) { console.warn('saveAdminSettings failed:', e); }
  }


  // ── Video Producer: duration pill toggle ────────────────────────────────────
  function setSbDuration(btn) {
    document.querySelectorAll('.sb-dur-pill').forEach(function(p) {
      p.classList.remove('active');
      p.style.border      = '1px solid var(--border-2)';
      p.style.background  = 'var(--glass-2)';
      p.style.color       = 'var(--text-2)';
    });
    btn.classList.add('active');
    btn.style.border     = '1px solid rgba(139,92,246,0.4)';
    btn.style.background = 'rgba(139,92,246,0.1)';
    btn.style.color      = '#c4b5fd';
  }

  // ── Video Producer: format pill toggle ─────────────────────────────────────
  function setSbFormat(btn) {
    document.querySelectorAll('.sb-format-pill').forEach(function(p) {
      p.classList.remove('active');
      p.style.border      = '1px solid var(--border-2)';
      p.style.background  = 'var(--glass-2)';
      p.style.color       = 'var(--text-2)';
    });
    btn.classList.add('active');
    btn.style.border     = '1px solid rgba(139,92,246,0.4)';
    btn.style.background = 'rgba(139,92,246,0.1)';
    btn.style.color      = '#c4b5fd';
  }