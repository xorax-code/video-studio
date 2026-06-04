  // ===== VIDEO CALENDAR =====
  let videoLog = [];
  let calYear  = new Date().getFullYear();
  let calMonth = new Date().getMonth(); // 0-indexed
  let calSelectedDate = null;

  const platformColors = { TikTok:'#ff2d55', Instagram:'#e1306c', Facebook:'#1877f2', YouTube:'#ff0000', Other:'#7c6af7' };
  // Returns the account's custom brand color, or falls back to platform default.
  // Sanitized: only allows #hex, rgb(), rgba(), and CSS var() — blocks style-attribute injection.
  function _safeCssColor(c) {
    if (!c) return null;
    return /^(#[0-9a-fA-F]{3,8}|rgba?\([^)]{1,60}\)|var\(--[a-zA-Z0-9-]+\))$/.test(c.trim()) ? c.trim() : null;
  }
  function acctColor(acct) {
    return _safeCssColor(acct?.brandColor) || _safeCssColor(platformColors[acct?.platform]) || 'var(--accent)';
  }

  function saveVideoLog() { DB.set('sm_video_log', JSON.stringify(videoLog)).catch(e => console.warn('saveVideoLog error:', e)); }

  function calKey(y, m, d) { return `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`; }

  function renderCalendar() {
    const now = new Date();
    const firstDay = new Date(calYear, calMonth, 1).getDay();
    const daysInMonth = new Date(calYear, calMonth+1, 0).getDate();
    const daysInPrevMonth = new Date(calYear, calMonth, 0).getDate();
    const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const calLabel = document.getElementById('calMonthLabel');
    if (!calLabel) return;
    calLabel.textContent = `${monthNames[calMonth]} ${calYear}`;

    // dayMap no longer needed — dots are rendered directly from getScheduledForDate + dailyItems

    const grid = document.getElementById('calGrid');
    if (!grid) return;
    grid.innerHTML = '';

    // Pad start — correctly show the trailing days of the previous month
    for (let i = 0; i < firstDay; i++) {
      const prevDay = daysInPrevMonth - firstDay + i + 1;
      const prev = new Date(calYear, calMonth - 1, prevDay);
      const cell = document.createElement('div');
      cell.className = 'cal-day other-month';
      cell.innerHTML = `<div class="cal-day-num">${prev.getDate()}</div>`;
      grid.appendChild(cell);
    }

    for (let d = 1; d <= daysInMonth; d++) {
      const key      = calKey(calYear, calMonth, d);
      const isToday  = now.getFullYear()===calYear && now.getMonth()===calMonth && now.getDate()===d;
      const isViewing = key === dailyDate;
      const cell = document.createElement('div');
      cell.className = 'cal-day' + (isToday ? ' today' : '') + (isViewing ? ' cal-viewing' : '');
      cell.dataset.date = key;
      cell.onclick = () => openCalModal(key);

      // --- One dot per account that has posts scheduled on this day ---
      // Total scheduled slots per account (from active plans)
      const slots = getScheduledForDate(key);
      // Unique account IDs with activity this day
      const acctIds = [...new Set(slots.map(s => s.accountId))];

      const dots = acctIds.map(acctId => {
        const acct      = accounts.find(a => a.id === acctId);
        if (!acct) return ''; // skip dots for deleted/stale accounts
        const color     = acctColor(acct);
        const name      = escHtml(acct?.username || 'Unknown');
        const total     = slots.filter(s => s.accountId === acctId).length;
        // Use dailyItems as the source of truth for done state.
        // If the day has been opened, items exist — check if ALL are done.
        // If the day hasn't been opened yet, dayItems is empty → hollow dot (planned).
        const dayItems  = dailyItems.filter(i => i.date === key && i.accountId === acctId);
        const doneCount = dayItems.filter(i => i.done).length;
        const displayTotal = dayItems.length > 0 ? dayItems.length : total;
        const allDone   = dayItems.length > 0 && doneCount === dayItems.length;
        const tip       = allDone
          ? `✅ ${name}: all ${displayTotal} post${displayTotal!==1?'s':''} done`
          : `📋 ${name}: ${doneCount}/${displayTotal} done`;
        if (allDone) {
          return `<div class="cal-dot" style="background:${color};" title="${tip}"></div>`;
        }
        return `<div class="cal-dot" style="background:transparent;border:2px solid ${color};box-sizing:border-box;" title="${tip}"></div>`;
      }).join('');

      cell.innerHTML = `<div class="cal-day-num">${d}</div><div class="cal-dots">${dots}</div>`;
      grid.appendChild(cell);
    }

    // Pad end
    const totalCells = firstDay + daysInMonth;
    const remainder = totalCells % 7;
    if (remainder > 0) {
      for (let i = 1; i <= 7 - remainder; i++) {
        const cell = document.createElement('div');
        cell.className = 'cal-day other-month';
        cell.innerHTML = `<div class="cal-day-num">${i}</div>`;
        grid.appendChild(cell);
      }
    }

    renderCalSidebar();
  }

  function renderCalSidebar() {
    // Account totals for current month from videoLog
    const totals = {};
    videoLog.forEach(e => {
      if (!e.date) return;
      const [ey, em] = e.date.split('-').map(Number);
      if (ey === calYear && em === calMonth+1) {
        totals[e.accountId] = (totals[e.accountId] || 0) + 1;
      }
    });
    const sorted = Object.entries(totals).sort((a,b) => b[1]-a[1]);
    const totalsEl = document.getElementById('calAccountTotals');
    if (!totalsEl) return;
    if (sorted.length === 0) {
      totalsEl.innerHTML = '<div style="font-size:11px;color:var(--text-4);padding:4px 0;">No videos done this month yet.</div>';
    } else {
      totalsEl.innerHTML = sorted.map(([id, count]) => {
        const acct  = accounts.find(a => a.id === id);
        const color = acctColor(acct);
        const name  = escHtml(acct?.username || 'Unknown');
        return `<div style="display:flex;align-items:center;gap:6px;padding:3px 0;">
          <span style="width:8px;height:8px;border-radius:50%;background:${color};flex-shrink:0;display:inline-block;"></span>
          <span style="font-size:11px;color:var(--text-2);flex:1;">${name}</span>
          <span style="font-size:11px;font-weight:700;color:${color};">${count} post${count!==1?'s':''} done</span>
        </div>`;
      }).join('');
    }
  }

  function calPrevMonth() {
    calMonth--;
    if (calMonth < 0) { calMonth = 11; calYear--; }
    renderCalendar();
  }

  function calNextMonth() {
    calMonth++;
    if (calMonth > 11) { calMonth = 0; calYear++; }
    renderCalendar();
  }

  function openCalModal(dateKey) {
    calSelectedDate = dateKey;
    // Navigate the daily plan to this date and highlight on calendar
    dailyDate = dateKey;
    renderDailyPlan();
    _highlightCalDay();
    const dt = new Date(dateKey + 'T12:00:00');
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const days   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const _calTitle = document.getElementById('calModalTitle');
    if (_calTitle) _calTitle.textContent = `${days[dt.getDay()]}, ${months[dt.getMonth()]} ${dt.getDate()}, ${dt.getFullYear()}`;
    // Populate account picker
    const sel = document.getElementById('calAccountSel');
    if (sel) sel.innerHTML = accounts.map(a => `<option value="${escHtml(a.id)}">${platformEmojis[a.platform]||'🌐'} ${escHtml(a.username)} (${escHtml(a.platform)})</option>`).join('');
    const _calNotes = document.getElementById('calNotes');
    if (_calNotes) _calNotes.value = '';
    renderCalDayEntries(dateKey);
    renderCalPlanned(dateKey);
    const _calModal = document.getElementById('calModalOverlay');
    if (_calModal) _calModal.style.display = 'flex';
  }

  function renderCalPlanned(dateKey) {
    const items = dailyItems.filter(i => i.date === dateKey);
    const el = document.getElementById('calPlannedList');
    const section = document.getElementById('calPlannedSection');
    if (items.length === 0) {
      if (section) section.style.display = 'none';
      return;
    }
    if (section) section.style.display = 'block';
    if (!el) return;
    el.innerHTML = items.map(item => {
      const acct      = accounts.find(a => a.id === item.accountId);
      const typeColor = item.wctColor || acctColor(acct);
      const emoji     = platformEmojis[acct?.platform] || '🌐';
      const typeBadge = item.wctLabel
        ? `<span style="font-size:9px;font-weight:700;padding:1px 6px;border-radius:10px;background:${typeColor}22;color:${typeColor};border:1px solid ${typeColor}44;">${item.wctIcon||''} ${escHtml(item.wctLabel)}</span>`
        : '';
      const statusDot = item.done
        ? `<span style="font-size:10px;color:var(--success);font-weight:600;">✓ Done</span>`
        : `<span style="font-size:10px;color:var(--warning);font-weight:600;">Pending</span>`;
      return `<div style="background:var(--surface-2);border:1px solid var(--border);border-left:3px solid ${typeColor};border-radius:var(--radius-sm);padding:10px 12px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
            <span style="font-size:12px;font-weight:600;color:var(--text-1);">${emoji} ${escHtml(acct?.username||'Unknown')}</span>
            <span style="font-size:10px;color:var(--text-3);">${escHtml(acct?.platform||'')}</span>
            ${typeBadge}
          </div>
          <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
            ${statusDot}
            ${item.done
              ? `<button onclick="calMarkDone(${escHtml(JSON.stringify(item.id))}, false)" style="font-size:9px;padding:2px 7px;background:rgba(34,197,94,0.08);border:1px solid rgba(34,197,94,0.3);border-radius:3px;color:var(--success);cursor:pointer;">↩ Undo</button>`
              : `<button onclick="calMarkDone(${escHtml(JSON.stringify(item.id))}, true)" style="font-size:9px;padding:2px 7px;background:rgba(34,197,94,0.08);border:1px solid rgba(34,197,94,0.3);border-radius:3px;color:var(--success);cursor:pointer;font-weight:600;">✓ Done</button>`
            }
          </div>
        </div>
        ${item.inspoUrl ? (item.done
          ? `<div style="margin-bottom:6px;display:flex;align-items:center;gap:6px;">
               <a href="${escHtml(item.inspoUrl)}" target="_blank" rel="noopener" style="font-size:11px;color:var(--accent);text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;" title="${escHtml(item.inspoUrl)}">🔗 ${escHtml(item.inspoUrl)}</a>
               <button onclick="copyItemUrl(${escHtml(JSON.stringify(item.id))},this)" style="padding:1px 7px;font-size:9px;background:var(--accent-glow-sm);border:1px solid var(--accent);border-radius:3px;color:var(--accent);cursor:pointer;white-space:nowrap;flex-shrink:0;">Copy</button>
             </div>`
          : `<div style="margin-bottom:6px;font-size:10px;color:var(--text-3);opacity:0.6;">🔒 Mark done to copy post link.</div>`
        ) : ''}
        ${item.script ? `<div style="padding:8px 10px;background:var(--surface-3);border-radius:var(--radius-xs);font-size:11px;color:var(--text-2);line-height:1.7;white-space:pre-wrap;border-left:2px solid ${typeColor};max-height:180px;overflow-y:auto;">${escHtml(item.script)}</div>` : '<div style="font-size:11px;color:var(--text-4);font-style:italic;">No script written yet.</div>'}
      </div>`;
    }).join('');
  }

  // Mark a planned post done/undone from inside the calendar day modal
  function calMarkDone(itemId, done) {
    if (done) {
      // Marking done from calendar popup — use the same post-link modal
      _markDoneItemId = itemId;
      const item = dailyItems.find(i => i.id === itemId);
      const _mdpl = document.getElementById('markDonePostLink');
      if (_mdpl) _mdpl.value = item?.inspoUrl || '';
      const _mdle = document.getElementById('markDoneLinkError');
      if (_mdle) _mdle.style.display = 'none';
      const _mdmo = document.getElementById('markDoneModalOverlay');
      if (_mdmo) _mdmo.style.display = 'flex';
      setTimeout(() => { const _f = document.getElementById('markDonePostLink'); if (_f) _f.focus(); }, 80);
    } else {
      // Undoing done — no modal
      const item = dailyItems.find(i => i.id === itemId);
      if (!item) return;
      item.done = false;
      const note = item.script ? item.script.substring(0, 60) : '';
      // Remove by itemId (new entries) OR old-style note match (legacy entries without itemId)
      videoLog = videoLog.filter(e => {
        if (item.id && e.itemId) return e.itemId !== item.id;
        return !(e.accountId === item.accountId && e.date === item.date && e.notes === note && !e.itemId);
      });
      saveDailyItems(); saveVideoLog();
      if (calSelectedDate) {
        renderCalPlanned(calSelectedDate);
        renderCalDayEntries(calSelectedDate);
      }
      renderCalendar();
    }
  }

  function renderCalDayEntries(dateKey) {
    const entries = videoLog.filter(e => e.date === dateKey);
    const el = document.getElementById('calDayEntries');
    if (!el) return;
    if (entries.length === 0) {
      el.innerHTML = '<div style="font-size:11px;color:var(--text-4);padding:4px 0;">No videos logged for this day yet.</div>';
      return;
    }
    el.innerHTML = entries.map(e => {
      const acct = accounts.find(a => a.id === e.accountId);
      const color = acctColor(acct);
      return `<div class="cal-entry-row">
        <div style="display:flex;align-items:center;gap:6px;">
          <div style="width:6px;height:6px;border-radius:50%;background:${color};"></div>
          <span style="color:var(--text-2);">${escHtml(acct?.username||'?')}</span>
          ${e.notes ? `<span style="color:var(--text-3);">· ${escHtml(e.notes)}</span>` : ''}
        </div>
        <button onclick="deleteCalEntry(${escHtml(JSON.stringify(e.id))},true)" style="background:none;border:none;cursor:pointer;color:var(--text-4);font-size:11px;padding:0;">✕</button>
      </div>`;
    }).join('');
  }

  function saveCalEntry() {
    if (!calSelectedDate) { showToast('No date selected.', 'warning'); return; }
    const _cas = document.getElementById('calAccountSel');
    const accountId = _cas ? _cas.value : '';
    if (!accountId) { showToast('Select an account.', 'warning'); return; }
    const _cn = document.getElementById('calNotes');
    const notes = _cn ? _cn.value.trim() : '';
    videoLog.push({ id: _uid(), accountId, date: calSelectedDate, notes });
    saveVideoLog();
    if (_cn) _cn.value = '';
    renderCalDayEntries(calSelectedDate);
    renderCalendar();
  }

  function deleteCalEntry(id, fromModal) {
    videoLog = videoLog.filter(e => e.id !== id);
    saveVideoLog();
    if (fromModal && calSelectedDate) renderCalDayEntries(calSelectedDate);
    renderCalendar();
  }

  function closeCalModal() {
    const _cmo = document.getElementById('calModalOverlay');
    if (_cmo) _cmo.style.display = 'none';
    calSelectedDate = null;
  }

  function clearDayCalendar() {
    if (!calSelectedDate) return;
    const _clearDate = calSelectedDate; // capture now — modal close resets calSelectedDate to null
    const planned = dailyItems.filter(i => i.date === _clearDate).length;
    const logged  = videoLog.filter(e => e.date === _clearDate).length;
    const total   = planned + logged;
    if (total === 0) { showToast('Nothing to clear on this day.', 'warning'); return; }
    showConfirm(`Clear ${total} item${total!==1?'s':''} from ${_clearDate}? This cannot be undone.`, () => {
      dailyItems = dailyItems.filter(i => i.date !== _clearDate);
      videoLog   = videoLog.filter(e => e.date !== _clearDate);
      saveDailyItems();
      saveVideoLog();
      closeCalModal();
      renderCalendar();
      renderDailyPlan();
    });
  }

  function clearAllCalendar() {
    const total = dailyItems.length + videoLog.length;
    if (total === 0) { showToast('The calendar is already empty.', 'warning'); return; }
    showConfirm(`Clear everything from the calendar? ${dailyItems.length} planned item${dailyItems.length!==1?'s':''} + ${videoLog.length} logged video${videoLog.length!==1?'s':''} will be permanently erased.`, () => {
      dailyItems = [];
      videoLog   = [];
      saveDailyItems();
      saveVideoLog();
      renderCalendar();
      renderDailyPlan();
    });
  }

  // ===== WEEKLY BLUEPRINT (merged plans) =====
  let postPlans = [];
  let editingPlanId = null;

  const PLAN_TYPE_META = {
    product: { icon:'🛒', label:'Product Video',  color:'#10b981' },
    growth:  { icon:'📈', label:'Account Growth', color:'#06b6d4' },
  };

  function savePlans() { DB.set('sm_post_plans', JSON.stringify(postPlans)).catch(e => console.warn('savePlans error:', e)); }

  // --- Type toggle in plan modal ---
  function selectPlanType(type) {
    document.querySelectorAll('.plan-type-btn').forEach(b => {
      const isActive = b.dataset.type === type;
      b.classList.toggle('active', isActive);
      if (!isActive) {
        b.style.border = '2px solid var(--border-2)';
        b.style.background = 'var(--surface-2)';
        const _sub = b.querySelector('div:nth-child(2)');
        if (_sub) _sub.style.color = 'var(--text-2)';
      } else {
        const meta = PLAN_TYPE_META[type] || PLAN_TYPE_META.product;
        b.style.border = `2px solid ${meta.color}`;
        b.style.background = `${meta.color}22`;
        const _sub = b.querySelector('div:nth-child(2)');
        if (_sub) _sub.style.color = meta.color;
      }
    });
    updatePlanPreviewLine();
  }

  function _getSelectedPlanType() {
    return document.querySelector('.plan-type-btn.active')?.dataset.type || 'product';
  }

  // --- Account scope in plan modal ---
  function togglePlanAccountPicker() {
    const _pss = document.getElementById('planScopeSpecific');
    const _pap = document.getElementById('planAccountPicker');
    if (!_pss || !_pap) return;
    _pap.style.display = _pss.checked ? 'flex' : 'none';
    updatePlanPreviewLine();
  }

  function _renderPlanAccountChips(selectedIds) {
    const picker = document.getElementById('planAccountPicker');
    if (!picker) return;
    picker.innerHTML = accounts.map(a => {
      const sel = selectedIds.includes(a.id);
      return `<span class="wct-acct-chip${sel?' sel':''}" data-id="${a.id}" onclick="this.classList.toggle('sel');updatePlanPreviewLine()">${platformEmojis[a.platform]||'🌐'} ${escHtml(a.username)}</span>`;
    }).join('');
  }

  function updatePlanPreviewLine() {
    const el = document.getElementById('planPreviewLine');
    if (!el) return;
    const prod   = parseInt(document.getElementById('planProductPerDay')?.value) || 0;
    const growth = parseInt(document.getElementById('planGrowthPerDay')?.value)  || 0;
    const specific = document.getElementById('planScopeSpecific')?.checked;
    const acctCount = specific
      ? document.querySelectorAll('#planAccountPicker .wct-acct-chip.sel').length
      : (accounts.length || 0);
    if (acctCount === 0 && specific) { el.textContent = 'Select accounts to see totals.'; return; }
    const n = acctCount || accounts.length || 1;
    const parts = [];
    if (prod   > 0) parts.push(`<span style="color:#10b981;font-weight:700;">🛒 ${prod}/day × ${n} = ${prod*n} product</span>`);
    if (growth > 0) parts.push(`<span style="color:#06b6d4;font-weight:700;">📈 ${growth}/day × ${n} = ${growth*n} growth</span>`);
    el.innerHTML = parts.length ? parts.join(' &nbsp;·&nbsp; ') + ` <span style="color:var(--text-3);">videos/day</span>`
      : '<span style="color:var(--danger);">Set at least one count above 0.</span>';
  }

  // --- Open / close ---
  function openPlanModal(id) {
    editingPlanId = id || null;
    const plan = id ? postPlans.find(p => p.id === id) : null;
    const _pmt = document.getElementById('planModalTitle');
    if (_pmt) _pmt.textContent = plan ? 'Edit Plan' : 'New Plan';

    // Per-type counts (with legacy migration: old plans had single videoType)
    let prodDefault = 1, growthDefault = 1;
    if (plan) {
      if (plan.productPerDay !== undefined || plan.growthPerDay !== undefined) {
        prodDefault   = plan.productPerDay  ?? 0;
        growthDefault = plan.growthPerDay   ?? 0;
      } else if (plan.videoType === 'product') {
        prodDefault = plan.videosPerDay || 1; growthDefault = 0;
      } else if (plan.videoType === 'growth') {
        growthDefault = plan.videosPerDay || 1; prodDefault = 0;
      }
    }
    const _ppd = document.getElementById('planProductPerDay');
    if (_ppd) _ppd.value = prodDefault;
    const _pgd = document.getElementById('planGrowthPerDay');
    if (_pgd) _pgd.value = growthDefault;
    const _psd = document.getElementById('planStartDate');
    if (_psd) _psd.value = plan?.startDate || new Date().toISOString().slice(0,10);
    const _ps = document.getElementById('planScript');
    if (_ps) _ps.value = plan?.scriptNotes || '';

    // Account scope
    const scope = plan?.accountScope || 'all';
    const _psa = document.getElementById('planScopeAll');
    if (_psa) _psa.checked = scope === 'all';
    const _pss = document.getElementById('planScopeSpecific');
    if (_pss) _pss.checked = scope === 'specific';
    _renderPlanAccountChips(plan?.accountIds || []);
    togglePlanAccountPicker();

    // Day buttons — scope to modal only
    const days = plan?.days || [1,2,3,4,5];
    document.querySelectorAll('#planDaysBtns .plan-day-btn').forEach(btn => {
      const d = parseInt(btn.dataset.day);
      btn.classList.toggle('active', days.includes(d));
      btn.onclick = () => { btn.classList.toggle('active'); };
    });

    updatePlanPreviewLine();
    const _pmo = document.getElementById('planModalOverlay');
    if (_pmo) _pmo.style.display = 'flex';
  }

  function closePlanModal() {
    const _pmo = document.getElementById('planModalOverlay');
    if (_pmo) _pmo.style.display = 'none';
    editingPlanId = null;
  }

  function savePlan() {
    const prod   = parseInt(document.getElementById('planProductPerDay')?.value)  || 0;
    const growth = parseInt(document.getElementById('planGrowthPerDay')?.value)   || 0;
    if (prod === 0 && growth === 0) { showToast('Set at least one video type count above 0.', 'warning'); return; }
    const days = Array.from(document.querySelectorAll('#planDaysBtns .plan-day-btn.active')).map(b => parseInt(b.dataset.day)).filter(d => !isNaN(d));
    if (days.length === 0) { showToast('Select at least one posting day.', 'warning'); return; }
    const scope = document.getElementById('planScopeSpecific')?.checked ? 'specific' : 'all';
    const accountIds = scope === 'specific'
      ? Array.from(document.querySelectorAll('#planAccountPicker .wct-acct-chip.sel')).map(c => c.dataset.id)
      : [];
    const data = {
      productPerDay:  prod,
      growthPerDay:   growth,
      accountScope:   scope,
      accountIds,
      startDate:      document.getElementById('planStartDate')?.value || new Date().toISOString().slice(0,10),
      days,
      scriptNotes:    document.getElementById('planScript')?.value?.trim() ?? '',
    };
    if (editingPlanId) {
      const idx = postPlans.findIndex(p => p.id === editingPlanId);
      if (idx > -1) postPlans[idx] = { ...postPlans[idx], ...data };
    } else {
      postPlans.push({ id: _uid(), ...data });
    }
    savePlans();
    closePlanModal();
    renderPlans();
    renderCalendar();
    renderDailyPlan();
  }

  function deletePlan(id) {
    showConfirm('Delete this plan?', () => {
      postPlans = postPlans.filter(p => p.id !== id);
      savePlans();
      renderPlans();
      renderCalendar();
      renderDailyPlan();
    });
  }

  function _planAcctLabel(plan) {
    if (plan.accountScope === 'specific' && plan.accountIds?.length) {
      const names = plan.accountIds.map(id => accounts.find(a=>a.id===id)?.username).filter(Boolean);
      return names.length <= 2 ? names.join(', ') : names.slice(0,2).join(', ') + ` +${names.length-2} more`;
    }
    return `All ${accounts.length||0} accounts`;
  }

  function _planAcctCount(plan) {
    return (plan.accountScope === 'specific' && plan.accountIds?.length)
      ? plan.accountIds.length : (accounts.length || 1);
  }

  // Normalize legacy single-type plans to dual-count format
  function _planCounts(plan) {
    if (plan.productPerDay !== undefined || plan.growthPerDay !== undefined) {
      return { prod: plan.productPerDay||0, growth: plan.growthPerDay||0 };
    }
    // Legacy: had videoType + videosPerDay
    if (plan.videoType === 'growth') return { prod:0, growth: plan.videosPerDay||1 };
    return { prod: plan.videosPerDay||1, growth: 0 };
  }

  function renderPlans() {
    const list   = document.getElementById('plansList');
    const empty  = document.getElementById('plansEmpty');
    if (!list || !empty) return;
    const totals = document.getElementById('plansTotals');
    const dayNames = ['Su','Mo','Tu','We','Th','Fr','Sa'];
    if (postPlans.length === 0) { list.innerHTML = ''; empty.style.display = 'block'; if(totals) totals.style.display='none'; return; }
    empty.style.display = 'none';
    list.innerHTML = postPlans.map(plan => {
      const { prod, growth } = _planCounts(plan);
      const days = Array.isArray(plan.days) ? plan.days : [];
      const n = _planAcctCount(plan);
      const prodWk   = days.length * prod   * n;
      const growthWk = days.length * growth * n;
      const dayChips = dayNames.map((dn,i) =>
        `<span class="wct-day-chip ${days.includes(i)?'on':'off'}">${dn}</span>`).join('');
      const typeBadges = [
        prod   > 0 ? `<span style="background:#10b98122;color:#10b981;font-size:9px;font-weight:700;padding:1px 6px;border-radius:10px;">🛒 ${prod}/day</span>` : '',
        growth > 0 ? `<span style="background:#06b6d422;color:#06b6d4;font-size:9px;font-weight:700;padding:1px 6px;border-radius:10px;">📈 ${growth}/day</span>` : '',
      ].filter(Boolean).join(' ');
      return `<div style="background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px 12px;">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:6px;">
          <div>
            <div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:4px;">${typeBadges}</div>
            <div style="display:flex;gap:3px;flex-wrap:wrap;">${dayChips}</div>
            <div style="font-size:9px;color:var(--text-3);margin-top:3px;">${escHtml(_planAcctLabel(plan))}
              ${(prod>0&&growth>0) ? ` · <span style="color:#10b981;">${prodWk}</span> + <span style="color:#06b6d4;">${growthWk}</span>/wk` :
                prod>0 ? ` · <span style="color:#10b981;">${prodWk} product/wk</span>` :
                         ` · <span style="color:#06b6d4;">${growthWk} growth/wk</span>`}
            </div>
          </div>
          <div style="display:flex;gap:4px;flex-shrink:0;">
            <button class="btn btn-secondary" onclick="openPlanModal(${escHtml(JSON.stringify(plan.id))})" style="padding:2px 7px;font-size:10px;">Edit</button>
            <button class="btn" onclick="deletePlan(${escHtml(JSON.stringify(plan.id))})" style="padding:2px 7px;font-size:10px;color:var(--danger);border-color:#3a2020;">✕</button>
          </div>
        </div>
        ${plan.startDate?`<div style="font-size:9px;color:var(--text-3);">Starting ${plan.startDate}</div>`:''}
      </div>`;
    }).join('');

    // Totals footer
    if (totals) {
      let totalProd=0, totalGrowth=0;
      postPlans.forEach(p => { const {prod,growth}=_planCounts(p); const n=_planAcctCount(p); const pd=Array.isArray(p.days)?p.days:[]; totalProd+=pd.length*prod*n; totalGrowth+=pd.length*growth*n; });
      totals.style.display = 'block';
      totals.innerHTML = `<div style="display:flex;align-items:center;gap:10px;padding:8px 0 2px;border-top:1px solid var(--border);margin-top:8px;flex-wrap:wrap;">
        <span style="font-size:10px;color:var(--text-3);font-weight:600;text-transform:uppercase;letter-spacing:0.4px;">Per week</span>
        ${totalProd>0  ? `<span style="font-size:12px;font-weight:700;color:#10b981;">🛒 ${totalProd} product</span>` : ''}
        ${totalGrowth>0? `<span style="font-size:12px;font-weight:700;color:#06b6d4;">📈 ${totalGrowth} growth</span>` : ''}
      </div>`;
    }
  }

  // ===== DAILY PLAN =====
  let dailyItems = [];  // [{id, date, accountId, inspoUrl, script, done, fromPlanId}]
  let dailyDate  = new Date().toISOString().slice(0,10);
  let editingDailyId = null;

  function saveDailyItems() { DB.set('sm_daily_items', JSON.stringify(dailyItems)).catch(e => { console.warn('saveDailyItems error:', e); showToast('Could not save calendar — changes may be lost.', 'warning'); }); }

  function copyItemUrl(id, btn) {
    const item = dailyItems.find(i => i.id === id);
    if (!item?.inspoUrl) return;
    navigator.clipboard.writeText(item.inspoUrl).then(() => {
      if (btn) { const orig = btn.textContent; btn.textContent = '✓ Copied!'; setTimeout(() => { btn.textContent = orig; }, 1500); }
    }).catch(() => {
      prompt('Copy this link:', item.inspoUrl);
    });
  }

  function fmtDailyDate(d) {
    const dt = new Date(d + 'T12:00:00');
    const today = new Date().toISOString().slice(0,10);
    const _tmrw = new Date(); _tmrw.setDate(_tmrw.getDate()+1);
    const tomorrow = _tmrw.toLocaleDateString('en-CA');
    const names = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const label = d===today ? 'Today' : d===tomorrow ? 'Tomorrow' : names[dt.getDay()];
    return `${label} · ${months[dt.getMonth()]} ${dt.getDate()}, ${dt.getFullYear()}`;
  }

  function switchCalView() {
    renderCalendar();
    renderPlans();
    renderDailyPlan();
  }

  function _setDailyDate(d) { dailyDate = d; renderDailyPlan(); _highlightCalDay(); }
  function goToToday()    { _setDailyDate(new Date().toISOString().slice(0,10)); }
  function goToTomorrow() { _setDailyDate(new Date(Date.now()+86400000).toISOString().slice(0,10)); }
  function dailyPrevDay() { const d = new Date(dailyDate+'T12:00:00'); d.setDate(d.getDate()-1); _setDailyDate(d.toISOString().slice(0,10)); }
  function dailyNextDay() { const d = new Date(dailyDate+'T12:00:00'); d.setDate(d.getDate()+1); _setDailyDate(d.toISOString().slice(0,10)); }
  function jumpToDate(val) { if (val) { _setDailyDate(val); } }

  // Highlight the currently-viewed day on the mini calendar without a full re-render
  function _highlightCalDay() {
    document.querySelectorAll('#calGrid .cal-day').forEach(cell => {
      cell.classList.remove('cal-viewing');
    });
    // Match by data-date attribute (onclick is a JS property, not an HTML attribute)
    const target = document.querySelector(`#calGrid .cal-day[data-date="${dailyDate}"]`);
    if (target) target.classList.add('cal-viewing');
    // If the viewed month doesn't match, do a full calendar re-render to jump months
    const [vy, vm] = dailyDate.split('-').map(Number);
    if (vy !== calYear || vm !== calMonth + 1) {
      calYear = vy; calMonth = vm - 1;
      renderCalendar();
    }
  }

  function getScheduledForDate(dateStr) {
    const dt = new Date(dateStr + 'T12:00:00');
    const dow = dt.getDay();
    const slots = [];
    postPlans.forEach(plan => {
      if (!Array.isArray(plan.days)) return; // guard against corrupt/legacy plan data
      if (!plan.days.includes(dow)) return;
      if (plan.startDate && dateStr < plan.startDate) return;
      const { prod, growth } = _planCounts(plan);
      const targetAccounts = (plan.accountScope === 'specific' && plan.accountIds?.length)
        ? plan.accountIds
        : accounts.map(a => a.id);
      // Product video slots
      if (prod > 0) {
        const meta = PLAN_TYPE_META.product;
        targetAccounts.forEach(acctId => {
          for (let v = 0; v < prod; v++) {
            slots.push({ planId: plan.id, accountId: acctId, script: plan.scriptNotes || '',
              wctLabel: meta.label, wctIcon: meta.icon, wctColor: meta.color });
          }
        });
      }
      // Growth video slots
      if (growth > 0) {
        const meta = PLAN_TYPE_META.growth;
        targetAccounts.forEach(acctId => {
          for (let v = 0; v < growth; v++) {
            slots.push({ planId: plan.id, accountId: acctId, script: plan.scriptNotes || '',
              wctLabel: meta.label, wctIcon: meta.icon, wctColor: meta.color });
          }
        });
      }
    });
    return slots;
  }

  function autoPopulateDay(dateStr) {
    const scheduled = getScheduledForDate(dateStr);
    if (scheduled.length === 0) return;
    const existing = dailyItems.filter(i => i.date === dateStr);
    // Track how many items per (planId+accountId+color) combo already exist
    // so perDay > 1 correctly creates multiple items instead of capping at 1
    const existingCounts = {};
    existing.forEach(e => {
      if (!e.fromPlanId) return;
      const k = `${e.fromPlanId}|${e.accountId}|${e.wctColor||''}`;
      existingCounts[k] = (existingCounts[k] || 0) + 1;
    });
    const seenCounts   = {}; // total slots seen per key (for slot numbering)
    const actuallyAdded = {}; // items actually added (not skipped) per key
    let added = 0;
    scheduled.forEach(slot => {
      const k = `${slot.planId}|${slot.accountId}|${slot.wctColor}`;
      seenCounts[k] = (seenCounts[k] || 0) + 1;
      const slotNumber  = seenCounts[k]; // 1-indexed slot for this key
      const alreadyHave = (existingCounts[k] || 0) + (actuallyAdded[k] || 0);
      if (alreadyHave >= slotNumber) return; // already covered by existing + prior adds
      actuallyAdded[k] = (actuallyAdded[k] || 0) + 1;
      dailyItems.push({
        id: _uid(),
        date: dateStr,
        accountId: slot.accountId,
        script: slot.script || '',
        done: false,
        fromPlanId: slot.planId,
        wctLabel: slot.wctLabel,
        wctIcon:  slot.wctIcon,
        wctColor: slot.wctColor,
      });
      added++;
    });
    if (added > 0) saveDailyItems();
  }

  function renderDailyPlan() {
    const _ddl = document.getElementById('dailyDateLabel');
    if (_ddl) _ddl.textContent = fmtDailyDate(dailyDate);
    const picker = document.getElementById('dailyDatePicker');
    if (picker) picker.value = dailyDate;
    autoPopulateDay(dailyDate);

    const items = dailyItems.filter(i => i.date === dailyDate);
    const list  = document.getElementById('dailyList');
    const empty = document.getElementById('dailyEmpty');
    const banner = document.getElementById('dailyScheduledBanner');
    if (!list || !empty) return;

    const scheduled = getScheduledForDate(dailyDate);
    if (banner) {
      if (scheduled.length > 0) {
        const acctNames = [...new Set(scheduled.map(s => accounts.find(a=>a.id===s.accountId)?.username).filter(Boolean))];
        banner.style.display = 'block';
        banner.textContent = `📋 ${scheduled.length} post${scheduled.length>1?'s':''} scheduled for this day from your active plans (${acctNames.join(', ')})`;
      } else {
        banner.style.display = 'none';
      }
    }

    if (items.length === 0) { list.innerHTML = ''; empty.style.display = 'block'; return; }
    empty.style.display = 'none';

    // Per-type counts for the checklist summary
    const prodItems    = items.filter(i => i.wctColor === PLAN_TYPE_META.product.color || (!i.wctColor && i.wctLabel && i.wctLabel.toLowerCase().includes('product')));
    const growthItems  = items.filter(i => i.wctColor === PLAN_TYPE_META.growth.color  || (!i.wctColor && i.wctLabel && i.wctLabel.toLowerCase().includes('growth')));
    const prodDone     = prodItems.filter(i => i.done).length;
    const growthDone   = growthItems.filter(i => i.done).length;
    const prodLeft     = prodItems.length - prodDone;
    const growthLeft   = growthItems.length - growthDone;
    const totalDone    = items.filter(i => i.done).length;

    // Build the summary bar
    let summaryParts = [];
    if (prodItems.length > 0)   summaryParts.push(`<span style="color:#10b981;font-weight:700;">🛒 ${prodDone}/${prodItems.length} done${prodLeft>0?' · '+prodLeft+' left':' ✓'}</span>`);
    if (growthItems.length > 0) summaryParts.push(`<span style="color:#06b6d4;font-weight:700;">📈 ${growthDone}/${growthItems.length} done${growthLeft>0?' · '+growthLeft+' left':' ✓'}</span>`);
    if (summaryParts.length === 0) summaryParts.push(`<span style="color:var(--text-3);">${totalDone}/${items.length} done</span>`);

    list.innerHTML = `<div style="display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-bottom:10px;padding:8px 10px;background:var(--surface-2);border-radius:var(--radius-sm);border:1px solid var(--border);">
      ${summaryParts.join('<span style="color:var(--text-4);margin:0 2px;">·</span>')}
      <div style="flex:1;min-width:80px;height:4px;background:var(--surface-3);border-radius:2px;">
        <div style="width:${items.length?Math.round(totalDone/items.length*100):0}%;height:100%;background:var(--success);border-radius:2px;transition:width 0.3s;"></div>
      </div>
    </div>` + items.map(item => {
      const acct  = accounts.find(a => a.id === item.accountId);
      const acctClr = acctColor(acct);
      // Determine type color for the left border and badge
      const typeColor = _safeCssColor(item.wctColor) || acctClr;
      const fromPlan = item.fromPlanId ? postPlans.find(p => p.id === item.fromPlanId) : null;
      const typeBadge = item.wctLabel
        ? `<span style="display:inline-flex;align-items:center;gap:3px;padding:1px 7px;border-radius:10px;font-size:9px;font-weight:700;background:${typeColor}22;color:${typeColor};border:1px solid ${typeColor}44;">${item.wctIcon||''} ${escHtml(item.wctLabel)}</span>`
        : '';
      return `<div class="daily-item${item.done?' done':''}" id="daily-item-${item.id}" style="border-left:3px solid ${typeColor};">
        <div class="daily-item-header">
          <div style="display:flex;align-items:center;gap:8px;min-width:0;">
            <div class="daily-check${item.done?' checked':''}" onclick="toggleDailyDone(${escHtml(JSON.stringify(item.id))})" title="${item.done?'Mark undone':'Mark done'}" style="${item.done?`background:${typeColor};border-color:${typeColor};`:''}">
              ${item.done?'<span style="color:#fff;font-size:10px;line-height:1;">✓</span>':''}
            </div>
            ${acct?.avatar?`<img src="${escHtml(acct.avatar)}" style="width:26px;height:26px;border-radius:50%;object-fit:cover;border:1px solid var(--border);">`:`<div style="width:26px;height:26px;border-radius:50%;background:${acctClr};opacity:0.35;flex-shrink:0;"></div>`}
            <div style="min-width:0;">
              <div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap;">
                <span style="font-size:12px;font-weight:600;color:var(--text-1);">${escHtml(acct?.username||'Unknown')}</span>
                ${typeBadge}
              </div>
              <div style="font-size:10px;color:var(--text-3);">${escHtml(acct?.platform||'')}${fromPlan?' · from schedule':''}</div>
            </div>
          </div>
          <div style="display:flex;gap:5px;flex-shrink:0;">
            <button class="btn btn-secondary" onclick="openDailyItemModal(${escHtml(JSON.stringify(item.id))})" style="padding:2px 7px;font-size:10px;">Edit</button>
            <button class="btn" onclick="deleteDailyItem(${escHtml(JSON.stringify(item.id))})" style="padding:2px 7px;font-size:10px;color:var(--danger);border-color:#3a2020;">✕</button>
          </div>
        </div>
        ${item.inspoUrl ? (item.done
          ? `<div style="margin-bottom:6px;padding:5px 10px;background:var(--surface-2);border-radius:var(--radius-xs);display:flex;align-items:center;gap:6px;">
              <span style="font-size:10px;color:var(--text-3);">🔗 Post link:</span>
              <a href="${escHtml(item.inspoUrl)}" target="_blank" class="plan-inspo-link">${escHtml(item.inspoUrl)}</a>
              <button onclick="copyItemUrl(${escHtml(JSON.stringify(item.id))},this)" style="margin-left:auto;padding:1px 7px;font-size:9px;background:var(--accent-glow-sm);border:1px solid var(--accent);border-radius:3px;color:var(--accent);cursor:pointer;white-space:nowrap;">Copy</button>
            </div>`
          : `<div style="margin-bottom:6px;padding:5px 10px;background:var(--surface-2);border-radius:var(--radius-xs);display:flex;align-items:center;gap:6px;opacity:0.55;">
              <span style="font-size:10px;">🔒</span>
              <span style="font-size:10px;color:var(--text-3);">Mark this post as done to copy the link.</span>
            </div>`
        ) : ''}
        ${item.script?`<div class="daily-script-box" style="border-left-color:${typeColor};">${escHtml(item.script)}</div>`:''}
      </div>`;
    }).join('');
  }

  function refreshDailyPlan() {
    // Force-clear any existing undone plan items for the current day so they get re-generated
    // from the latest blueprint state, then re-render everything
    dailyItems = dailyItems.filter(i => !(i.date === dailyDate && i.fromPlanId && !i.done));
    saveDailyItems();
    autoPopulateDay(dailyDate);
    renderDailyPlan();
    renderCalendar();
    renderPlans();
  }

  let _markDoneItemId = null;

  function toggleDailyDone(id) {
    const item = dailyItems.find(i => i.id === id);
    if (!item) return;
    if (item.done) {
      // Undoing: no modal needed — just clear the done state
      item.done = false;
      const _undoNote = item.script ? item.script.substring(0,60) : '';
      // Remove by itemId (new entries) OR old-style note match (legacy entries without itemId)
      videoLog = videoLog.filter(e => {
        if (item.id && e.itemId) return e.itemId !== item.id;
        return !(e.accountId === item.accountId && e.date === item.date && e.notes === _undoNote && !e.itemId);
      });
      saveDailyItems(); saveVideoLog();
      renderDailyPlan();
      renderCalendar();
    } else {
      // Marking done: open the post-link confirmation modal
      _markDoneItemId = id;
      const _mdOverlay  = document.getElementById('markDoneModalOverlay');
      const _mdPostLink = document.getElementById('markDonePostLink');
      const _mdLinkErr  = document.getElementById('markDoneLinkError');
      if (!_mdOverlay) return;
      if (_mdPostLink) _mdPostLink.value = item.inspoUrl || '';
      if (_mdLinkErr)  _mdLinkErr.style.display = 'none';
      _mdOverlay.style.display = 'flex';
      setTimeout(() => _mdPostLink?.focus(), 80);
    }
  }

  function closeMarkDoneModal() {
    const _mdmo = document.getElementById('markDoneModalOverlay');
    if (_mdmo) _mdmo.style.display = 'none';
    _markDoneItemId = null;
  }

  function confirmMarkDone() {
    const linkEl = document.getElementById('markDonePostLink');
    const errEl  = document.getElementById('markDoneLinkError');
    const link   = linkEl ? linkEl.value.trim() : '';
    if (!link) {
      if (errEl)  errEl.style.display = 'block';
      if (linkEl) linkEl.focus();
      return;
    }
    // Block javascript: and data: URIs
    try { const _u = new URL(link); if (!['http:','https:'].includes(_u.protocol)) throw new Error(); }
    catch { if (errEl) { errEl.textContent = 'Please enter a valid URL (https://...)'; errEl.style.display = 'block'; } return; }
    if (errEl) { errEl.textContent = ''; errEl.style.display = 'none'; }
    const item = dailyItems.find(i => i.id === _markDoneItemId);
    if (!item) { closeMarkDoneModal(); return; }
    item.done = true;
    item.inspoUrl = link;
    const note = item.script ? item.script.substring(0,60) : '';
    // Dedup by item.id so each unique daily item gets its own log entry
    // (old dedup by notes would block the 2nd entry when both items have same/empty script)
    // Guard: only use itemId dedup if item.id is defined (legacy items may lack an id)
    const alreadyLogged = item.id
      ? videoLog.some(e => e.itemId === item.id)
      : videoLog.some(e => e.accountId === item.accountId && e.date === item.date && e.notes === note && !e.itemId);
    if (!alreadyLogged) videoLog.push({ id: _uid(), itemId: item.id || null, accountId: item.accountId, date: item.date, notes: note });
    saveDailyItems(); saveVideoLog();
    closeMarkDoneModal();
    renderDailyPlan();
    renderCalendar();
    // If calendar day popup is open, refresh it too
    if (calSelectedDate) {
      renderCalPlanned(calSelectedDate);
      renderCalDayEntries(calSelectedDate);
    }
  }

  function openDailyItemModal(id) {
    if (!accounts || accounts.length === 0) {
      showToast('Add an account first before planning a post.', 'warning');
      return;
    }
    editingDailyId = id || null;
    const item = id ? dailyItems.find(i => i.id === id) : null;
    const _dimt = document.getElementById('dailyItemModalTitle');
    if (_dimt) _dimt.textContent = item ? 'Edit Post' : 'Plan a Post';
    const sel = document.getElementById('dailyItemAccount');
    if (sel) sel.innerHTML = accounts.map(a => `<option value="${escHtml(a.id)}" ${item?.accountId===a.id?'selected':''}>${platformEmojis[a.platform]||'🌐'} ${escHtml(a.username)} (${escHtml(a.platform)})</option>`).join('');
    const _dii = document.getElementById('dailyItemInspo');
    if (_dii) _dii.value = item?.inspoUrl || '';
    const _dis = document.getElementById('dailyItemScript');
    if (_dis) _dis.value = item?.script || '';
    const _dimo = document.getElementById('dailyItemModalOverlay');
    if (_dimo) _dimo.style.display = 'flex';
  }

  function closeDailyItemModal() {
    const _dimo = document.getElementById('dailyItemModalOverlay');
    if (_dimo) _dimo.style.display = 'none';
    editingDailyId = null;
  }

  function saveDailyItem() {
    const _dia = document.getElementById('dailyItemAccount');
    const accountId = _dia ? _dia.value : '';
    if (!accountId) { showToast('Select an account.', 'warning'); return; }
    const data = {
      accountId,
      inspoUrl: document.getElementById('dailyItemInspo')?.value?.trim() ?? '',
      script:   document.getElementById('dailyItemScript')?.value?.trim() ?? '',
      date:     dailyDate,
      // NOTE: do NOT include done here — when editing we preserve the existing
      // done state via the spread below so editing a completed item doesn't reset it.
    };
    if (editingDailyId) {
      const idx = dailyItems.findIndex(i => i.id === editingDailyId);
      if (idx > -1) dailyItems[idx] = { ...dailyItems[idx], ...data };
    } else {
      dailyItems.push({ id: _uid(), ...data, done: false });
    }
    saveDailyItems();
    closeDailyItemModal();
    renderDailyPlan();
    // Keep calendar in sync so the dot appears immediately
    renderCalendar();
  }

  function deleteDailyItem(id) {
    dailyItems = dailyItems.filter(i => i.id !== id);
    saveDailyItems();
    renderDailyPlan();
    renderCalendar();
  }

  // Safely parse a JSON string from DB/localStorage — returns fallback on any error
  function _safeJSON(raw, fallback) { try { const _p = JSON.parse(raw || JSON.stringify(fallback)); return (_p !== null && _p !== undefined) ? _p : fallback; } catch(e) { return fallback; } }
