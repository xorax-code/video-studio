/* ===========================================================================
 * 22-mobile-wizard.js — Mobile-only step wizard for the Video Replicator.
 *
 * On phones (≤800px) while the Replicator tab (#tab-video-studio) is showing, this
 * groups the existing panels into 4 guided steps (Avatar → Reference & script →
 * Scene setup → Generate) and reveals one step at a time, with a progress bar and
 * a fixed Back / Next bar. On desktop it does nothing, and it is fully reversible —
 * it only toggles a `wiz-hide` class + a `body.wizmode-on` flag, never editing panel
 * data or the generation logic. If any step's panels are missing it stays off, so it
 * can never break the normal stacked view.
 * ======================================================================== */
(function () {
  'use strict';

  var STEPS = [
    { t: 'Your avatar',        ids: ['vsPanelAvatar'] },
    { t: 'Reference & script', ids: ['vsPanelRefVideo', 'vsPanelScript'] },
    { t: 'Scene setup',        ids: ['avatarBgPanel', 'productRefPanel', 'handRefPanel'] },
    { t: 'Generate',           ids: ['vsSpeedRow', 'processEverythingBtn', 'vsSegmentsPanel'] }
  ];
  // Right-column controls not part of any step — hidden for the whole wizard so
  // they don't float into steps 1–3 (they belong to the normal stacked view).
  var EXTRA_HIDE = ['leftColToggleBtn'];
  var ALL = STEPS.reduce(function (a, s) { return a.concat(s.ids); }, []).concat(EXTRA_HIDE);
  var cur = 0;
  var _on = false;

  function $(id) { return document.getElementById(id); }
  function isMobile() { try { return window.matchMedia('(max-width: 800px)').matches; } catch (e) { return false; } }
  function tabEl() { return $('tab-video-studio'); }
  function tabVisible() { var t = tabEl(); return !!(t && t.offsetParent !== null); }

  function injectCss() {
    if ($('wizCss')) return;
    var s = document.createElement('style'); s.id = 'wizCss';
    s.textContent =
      '@media (max-width:800px){' +
      'body.wizmode-on #vsLayout .wiz-hide{display:none !important}' +
      '#wizHdr{padding:6px 12px 4px}' +
      '#wizDots{display:flex;gap:6px;justify-content:center;margin-bottom:8px}' +
      '#wizDots i{height:5px;border-radius:3px;flex:1;max-width:64px;background:rgba(255,255,255,.15);transition:background .2s}' +
      '#wizDots i.on{background:#34d399}' +
      '#wizTitle{text-align:center;font-weight:800;font-size:15px;color:var(--text-1)}' +
      // Sits directly above the mobile bottom nav (#mnav, ~58px + safe-area, z1200).
      // Match the nav's safe-area math and stack above it so its buttons stay tappable
      // on notched phones.
      '#wizBar{position:fixed;left:0;right:0;bottom:calc(58px + env(safe-area-inset-bottom,0px));z-index:1250;display:flex;gap:10px;align-items:center;padding:9px 12px;background:rgba(12,12,15,.98);border-top:1px solid var(--border);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px)}' +
      '#wizBar button{height:44px;border-radius:12px;font-family:inherit;font-weight:800;font-size:13px;border:1px solid var(--border-2);background:var(--surface-2);color:var(--text-2);cursor:pointer;padding:0 18px}' +
      '#wizBar .wizBack.wizHiddenBack{display:none}' +
      '#wizBar .wizNext{flex:1;background:#34d399;color:#04130d;border:none}' +
      'body.wizmode-on #tab-video-studio{padding-bottom:calc(128px + env(safe-area-inset-bottom,0px)) !important}' +
      '}';
    document.head.appendChild(s);
  }

  function ensureChrome() {
    var layout = $('vsLayout'); if (!layout) return false;
    if (!$('wizHdr')) {
      var h = document.createElement('div'); h.id = 'wizHdr';
      h.innerHTML = '<div id="wizDots">' + STEPS.map(function () { return '<i></i>'; }).join('') + '</div><div id="wizTitle"></div>';
      layout.parentNode.insertBefore(h, layout);
    }
    if (!$('wizBar')) {
      var b = document.createElement('div'); b.id = 'wizBar';
      b.innerHTML = '<button class="wizBack" type="button">‹ Back</button><button class="wizNext" type="button">Next ›</button>';
      document.body.appendChild(b);
      b.querySelector('.wizBack').addEventListener('click', function () { if (cur > 0) { cur--; render(); } });
      b.querySelector('.wizNext').addEventListener('click', function () {
        if (cur < STEPS.length - 1) { cur++; render(); }
        else { var pe = $('processEverythingBtn'); if (pe) { var btn = (pe.tagName === 'BUTTON') ? pe : (pe.querySelector('button') || pe); try { btn.click(); } catch (e) {} } }
      });
    }
    return true;
  }

  function render() {
    // Hide every managed panel, then reveal only the current step's.
    for (var i = 0; i < ALL.length; i++) { var el = $(ALL[i]); if (el) el.classList.add('wiz-hide'); }
    STEPS[cur].ids.forEach(function (id) { var e = $(id); if (e) e.classList.remove('wiz-hide'); });
    var dots = document.querySelectorAll('#wizDots i');
    for (var d = 0; d < dots.length; d++) dots[d].classList.toggle('on', d <= cur);
    var title = $('wizTitle'); if (title) title.textContent = 'Step ' + (cur + 1) + ' of ' + STEPS.length + ' · ' + STEPS[cur].t;
    var bar = $('wizBar');
    if (bar) {
      var bk = bar.querySelector('.wizBack'), nx = bar.querySelector('.wizNext');
      if (bk) bk.classList.toggle('wizHiddenBack', cur === 0); // collapse (not just hide) so Next fills the bar on step 1
      if (nx) nx.textContent = (cur === STEPS.length - 1) ? '✨ Make my video' : 'Next ›';
    }
    try { var t = tabEl(); if (t) t.scrollTop = 0; } catch (e) {}
    try { window.scrollTo(0, 0); } catch (e) {}
  }

  // Only activate if we can actually find the step panels — otherwise fail safe (stay off).
  // Also require Replicator mode (studio-replicator): in Producer mode the step-3
  // panels are producer-hidden and the last step's button runs the wrong pipeline.
  function panelsPresent() {
    var t = tabEl(); if (!t) return false;
    if (!t.classList.contains('studio-replicator')) return false;
    // Require at least the first two anchor panels to exist.
    return !!($('vsPanelAvatar') && $('vsLayout'));
  }

  function enable() {
    if (!panelsPresent() || !ensureChrome()) return;
    injectCss();
    document.body.classList.add('wizmode-on');
    _on = true;
    if (cur >= STEPS.length || cur < 0) cur = 0;
    render();
  }
  function disable() {
    document.body.classList.remove('wizmode-on');
    for (var i = 0; i < ALL.length; i++) { var el = $(ALL[i]); if (el) el.classList.remove('wiz-hide'); }
    var h = $('wizHdr'); if (h) h.remove();
    var b = $('wizBar'); if (b) b.remove();
    _on = false;
  }

  function evaluate() {
    if (isMobile() && tabVisible() && panelsPresent()) { if (!_on) enable(); }
    else if (_on) { disable(); }
  }
  window.mobileWizardEval = evaluate;

  // Re-evaluate on resize (orientation / devtools) and whenever the tab changes.
  window.addEventListener('resize', function () { setTimeout(evaluate, 120); });

  function hookSwitchTab() {
    if (typeof window.switchTab !== 'function' || window.switchTab._wizHooked) return (typeof window.switchTab === 'function');
    var _o = window.switchTab;
    window.switchTab = function () {
      var r = _o.apply(this, arguments);
      // Only reset wizard progress when we're NOT staying on the Replicator — a
      // re-tap of "Create" while already here shouldn't kick the user back to step 1.
      // Fire several delayed re-evaluations: js/08 applies the studio-replicator
      // mode class asynchronously AFTER switchTab returns, so a single 60ms check
      // often misses it and the wizard would never turn on.
      try { if (!(isMobile() && tabVisible() && panelsPresent())) cur = 0; [60, 220, 500, 900].forEach(function (ms) { setTimeout(evaluate, ms); }); } catch (e) {}
      return r;
    };
    window.switchTab._wizHooked = true;
    return true;
  }
  var _tries = 0;
  (function waitHook() { if (hookSwitchTab() || _tries++ > 40) return; setTimeout(waitHook, 250); })();

  // The studio-replicator mode class is applied asynchronously (js/08
  // _applyModeVisuals) AFTER switchTab returns, so a single timed check can miss
  // it and the wizard would never activate. Watch the studio tab for class/style
  // (mode + visibility) changes and re-evaluate. Fail-safe: evaluate() only turns
  // the wizard on when every condition is actually met, and disable() is clean.
  var _tries2 = 0, _obsDeb = null;
  (function observeStudio () {
    var t = tabEl();
    if (!t) { if (_tries2++ < 40) setTimeout(observeStudio, 250); return; }
    try {
      new MutationObserver(function () {
        clearTimeout(_obsDeb); _obsDeb = setTimeout(evaluate, 90);
      }).observe(t, { attributes: true, attributeFilter: ['class', 'style'] });
    } catch (e) {}
  })();

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(evaluate, 400); });
  else setTimeout(evaluate, 400);
})();
