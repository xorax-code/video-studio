/* ===========================================================================
 * 24-mobile-shell.js — Mobile-only "Create-centric" bottom shell.
 *
 * Reshapes the phone bottom nav (≤800px) into the mock-up's shape:
 *
 *        [ Home ]      ( ⊕ Create )      [ Profile ]
 *
 * The center Create button opens a hub sheet (Replicate · From a script ·
 * Studio). Profile opens an overflow sheet with the demoted areas (Your videos,
 * Plan, My accounts, Viral scripts, Competitors, Settings, Help). Nothing is
 * removed — every destination is still reached in ≤2 taps.
 *
 * Non-destructive: everything here is gated to ≤800px, only injects CSS + two
 * overlay sheets, and drives navigation through the existing global switchTab()
 * / openUserSettings(). On desktop it does nothing. If switchTab is missing it
 * fails safe (buttons just no-op). Companion to js/22-mobile-wizard.js.
 * ======================================================================== */
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }
  function isMobile() { try { return window.matchMedia('(max-width: 800px)').matches; } catch (e) { return false; } }
  function tab(t) { try { if (typeof window.switchTab === 'function') window.switchTab(t); } catch (e) {} try { window.scrollTo(0, 0); } catch (e) {} }

  /* ---- CSS (scoped to phones; keyed off the same #mnav the desktop hides) ---- */
  function injectCss() {
    if ($('mShellCss')) return;
    var s = document.createElement('style'); s.id = 'mShellCss';
    s.textContent =
      // Base (all widths): keep the injected sheets hidden so that if the viewport
      // is widened past 800px mid-session they don't fall back to display:block and
      // leak as loose blocks at the page bottom (the .mmore-overlay bug, app.html).
      '.msheet-ov{display:none}' +
      '@media (max-width:800px){' +
      /* 3-item bar: Home | Create (center FAB) | Profile */
      '#mnav.mshell{padding-top:6px;justify-content:space-around;align-items:flex-end}' +
      '#mnav.mshell .mnav-btn{flex:1;max-width:120px}' +
      '#mnav.mshell .mnav-create{flex:0 0 auto;max-width:none;position:relative;top:-14px}' +
      '#mnav.mshell .mnav-create .fab{width:52px;height:52px;border-radius:17px;background:var(--accent,#34d399);color:#04130d;display:flex;align-items:center;justify-content:center;box-shadow:0 8px 22px rgba(52,211,153,.35);margin:0 auto 3px}' +
      '#mnav.mshell .mnav-create .fab i{font-size:26px}' +
      '#mnav.mshell .mnav-create span{color:var(--text-2,#c9c9d1)}' +
      /* shared bottom-sheet chrome (mirrors .mmore-overlay but self-contained) */
      '.msheet-ov{display:none;position:fixed;inset:0;z-index:1320;background:rgba(4,4,7,.6);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);align-items:flex-end}' +
      '.msheet-ov.open{display:flex;animation:mshFade .18s ease}' +
      '@keyframes mshFade{from{opacity:0}to{opacity:1}}' +
      '.msheet{width:100%;background:var(--surface,#141418);border-top-left-radius:20px;border-top-right-radius:20px;border-top:1px solid var(--border-2,rgba(255,255,255,.12));padding:10px 14px calc(18px + env(safe-area-inset-bottom,0px));animation:mshUp .22s cubic-bezier(.2,.8,.2,1)}' +
      '@keyframes mshUp{from{transform:translateY(16px)}to{transform:translateY(0)}}' +
      '.msheet .grip{width:36px;height:4px;border-radius:3px;background:rgba(255,255,255,.16);margin:2px auto 12px}' +
      '.msheet h3{font-size:16px;font-weight:800;letter-spacing:-.01em;color:var(--text-1,#f4f4f6);margin:0 2px 12px}' +
      '.msh-tile{display:flex;gap:13px;align-items:center;width:100%;text-align:left;background:var(--surface-2,#1a1a1f);border:1px solid var(--border,rgba(255,255,255,.07));border-radius:13px;padding:13px;margin-bottom:9px;cursor:pointer;font-family:inherit;transition:border-color .15s}' +
      '.msh-tile:active{border-color:var(--accent-line,rgba(52,211,153,.4))}' +
      '.msh-tile.pri{border-color:rgba(52,211,153,.28)}' +
      '.msh-tile .ic{width:42px;height:42px;border-radius:11px;background:var(--surface-3,#232329);display:flex;align-items:center;justify-content:center;font-size:20px;color:var(--text-1,#f4f4f6);flex:none}' +
      '.msh-tile.pri .ic{background:var(--accent,#34d399);color:#04130d}' +
      '.msh-tile .tt{font-size:15px;font-weight:700;color:var(--text-1,#f4f4f6);letter-spacing:-.01em}' +
      '.msh-tile .td{font-size:12px;color:var(--text-3,#8a8a93);margin-top:2px;line-height:1.35}' +
      '.msh-tile .ar{margin-left:auto;color:var(--text-3,#6e6e77);font-size:18px}' +
      '.msh-row{display:flex;gap:12px;align-items:center;width:100%;text-align:left;background:none;border:none;padding:12px 6px;cursor:pointer;font-family:inherit;border-bottom:1px solid var(--border,rgba(255,255,255,.06))}' +
      '.msh-row:last-of-type{border-bottom:none}' +
      '.msh-row .ri{width:34px;height:34px;border-radius:10px;background:var(--surface-3,#232329);display:flex;align-items:center;justify-content:center;font-size:17px;color:var(--text-2,#a6a6ae);flex:none}' +
      '.msh-row .rl{font-size:14.5px;font-weight:600;color:var(--text-1,#f4f4f6)}' +
      '.msh-row .rs{font-size:12px;color:var(--text-3,#8a8a93);margin-top:1px}' +
      '.msh-row .rc{margin-left:auto;color:var(--text-3,#6e6e77);font-size:18px}' +
      '.msh-close{width:100%;height:46px;margin-top:8px;border-radius:12px;border:1px solid var(--border-2,rgba(255,255,255,.12));background:var(--surface-2,#1a1a1f);color:var(--text-2,#a6a6ae);font-weight:700;font-size:14px;font-family:inherit;cursor:pointer}' +
      /* ── Review Start Frames modal → mobile bottom sheet ──────────────────
         The desktop dialog (#nbApprovalModal, built in js/17) is a cramped
         side-by-side box on a phone. Restyle it in place — same DOM, same real
         rvApprove()/rvRedo()/rvSwapBg() handlers — into a full-height sheet:
         frame stacked above info, big tappable buttons, keyboard hints hidden. */
      '#nbApprovalModal{padding:0 !important;align-items:flex-end !important}' +
      '#nbApprovalModal .rv-modal{width:100% !important;height:94vh !important;max-height:94vh !important;border-radius:20px 20px 0 0 !important;border-bottom:none !important}' +
      '#nbApprovalModal .rv-stage{flex-direction:column !important;gap:12px !important;padding:14px !important;overflow-y:auto !important}' +
      '#nbApprovalModal .rv-frame{width:100% !important;max-width:184px !important;margin:0 auto !important;flex-shrink:0 !important}' +
      '#nbApprovalModal .rv-info{flex:none !important}' +
      '#nbApprovalModal .rv-kbd{display:none !important}' +
      '#nbApprovalModal .rv-foot > span{display:none !important}' +
      '#nbApprovalModal .rv-foot{padding:12px 14px calc(12px + env(safe-area-inset-bottom,0px)) !important}' +
      '#nbApprovalModal #rvGenBtn{width:100% !important;justify-content:center !important;height:46px !important}' +
      '#nbApprovalModal .rv-strip{padding:11px 14px !important}' +
      '}';
    document.head.appendChild(s);
  }

  /* ---- Sheet DOM (built once, appended to body) ---- */
  function tileHtml(icon, tt, td, pri) {
    return '<div class="ic"><i class="ti ' + icon + '"></i></div>' +
           '<div><div class="tt">' + tt + '</div><div class="td">' + td + '</div></div>' +
           '<div class="ar"><i class="ti ti-chevron-right"></i></div>';
  }
  function rowHtml(icon, rl, rs) {
    return '<div class="ri"><i class="ti ' + icon + '"></i></div>' +
           '<div><div class="rl">' + rl + '</div>' + (rs ? '<div class="rs">' + rs + '</div>' : '') + '</div>' +
           '<div class="rc"><i class="ti ti-chevron-right"></i></div>';
  }

  function ensureSheets() {
    if ($('mCreateSheet') && $('mProfileSheet')) return;

    if (!$('mCreateSheet')) {
      var c = document.createElement('div');
      c.id = 'mCreateSheet'; c.className = 'msheet-ov';
      c.addEventListener('click', function (e) { if (e.target === c) mSheetClose('mCreateSheet'); });
      c.innerHTML =
        '<div class="msheet"><div class="grip"></div><h3>Create a video</h3>' +
        '<button class="msh-tile pri" data-go="video-replicator">' + tileHtml('ti-movie', 'Replicate a video', 'Recreate a reference with your avatar', true) + '</button>' +
        '<button class="msh-tile" data-go="video-producer">' + tileHtml('ti-pencil', 'From a script', 'Producer — describe a product', false) + '</button>' +
        '<button class="msh-tile" data-go="flow-studio">' + tileHtml('ti-wand', 'Studio', 'Free-form image or video from a prompt', false) + '</button>' +
        '<button class="msh-close">Close</button></div>';
      document.body.appendChild(c);
    }

    if (!$('mProfileSheet')) {
      var p = document.createElement('div');
      p.id = 'mProfileSheet'; p.className = 'msheet-ov';
      p.addEventListener('click', function (e) { if (e.target === p) mSheetClose('mProfileSheet'); });
      p.innerHTML =
        '<div class="msheet"><div class="grip"></div><h3>Profile</h3>' +
        '<button class="msh-row" data-go="video-editor">' + rowHtml('ti-layout-grid', 'Your videos', 'Clips and projects') + '</button>' +
        '<button class="msh-row" data-go="calendar">' + rowHtml('ti-calendar', 'Plan and schedule', 'Your posting calendar') + '</button>' +
        '<button class="msh-row" data-go="my-accounts">' + rowHtml('ti-users', 'My accounts', 'Connected social profiles') + '</button>' +
        '<button class="msh-row" data-go="viral-scripts">' + rowHtml('ti-bulb', 'Viral scripts', 'Hooks, CTAs, ideas') + '</button>' +
        '<button class="msh-row" data-go="competitors">' + rowHtml('ti-target', 'Competitors', 'Track niche accounts') + '</button>' +
        '<button class="msh-row" data-settings="1">' + rowHtml('ti-settings', 'Settings', 'Profile, billing, appearance') + '</button>' +
        '<button class="msh-close">Close</button></div>';
      document.body.appendChild(p);
    }

    // Delegate clicks for both sheets.
    ['mCreateSheet', 'mProfileSheet'].forEach(function (id) {
      var el = $(id); if (!el || el._wired) return; el._wired = true;
      el.addEventListener('click', function (e) {
        var t = e.target.closest('.msh-tile,.msh-row,.msh-close'); if (!t) return;
        if (t.classList.contains('msh-close')) { mSheetClose(id); return; }
        mSheetClose(id);
        if (t.getAttribute('data-settings')) {
          try { if (typeof window.openUserSettings === 'function') window.openUserSettings(); } catch (err) {}
        } else {
          var dest = t.getAttribute('data-go'); if (dest) tab(dest);
        }
      });
    });
  }

  window.mSheetClose = function (id) { var s = $(id); if (s) s.classList.remove('open'); };
  // Create is a transient action (a FAB), not a destination — leave the current
  // Home/Profile highlight as-is rather than blanking the bar behind the sheet.
  window.mCreateOpen = function () { ensureSheets(); var s = $('mCreateSheet'); if (s) s.classList.add('open'); };
  window.mProfileOpen = function () { ensureSheets(); var s = $('mProfileSheet'); if (s) s.classList.add('open'); syncNav('profile'); };
  window.mHome = function () { tab('dashboard'); syncNav('home'); };

  /* ---- Nav highlight: Home tab active on dashboard, Profile on its screens ---- */
  var PROFILE_TABS = { 'video-editor': 1, 'calendar': 1, 'my-accounts': 1, 'viral-scripts': 1, 'competitors': 1 };
  function syncNav(which) {
    var nav = $('mnav'); if (!nav) return;
    var home = nav.querySelector('.mnav-home'), prof = nav.querySelector('.mnav-profile');
    if (home) home.classList.toggle('active', which === 'home');
    if (prof) prof.classList.toggle('active', which === 'profile');
  }
  function syncFromTab(t) { syncNav(t === 'dashboard' ? 'home' : (PROFILE_TABS[t] ? 'profile' : '')); }

  function hookSwitchTab() {
    if (typeof window.switchTab !== 'function' || window.switchTab._mshellHooked) return (typeof window.switchTab === 'function');
    var _o = window.switchTab;
    window.switchTab = function (t) { var r = _o.apply(this, arguments); try { syncFromTab(t); } catch (e) {} return r; };
    window.switchTab._mshellHooked = true;
    return true;
  }

  /* ---- Convert the existing 6-item #mnav into the 3-item shell (idempotent) ---- */
  function reshapeNav() {
    var nav = $('mnav'); if (!nav || nav.classList.contains('mshell')) return true;
    nav.classList.add('mshell');
    nav.innerHTML =
      '<button class="mnav-btn mnav-home active" type="button" onclick="mHome()"><i class="ti ti-home"></i><span>Home</span></button>' +
      '<button class="mnav-btn mnav-create" type="button" onclick="mCreateOpen()"><span class="fab"><i class="ti ti-plus"></i></span><span>Create</span></button>' +
      '<button class="mnav-btn mnav-profile" type="button" onclick="mProfileOpen()"><i class="ti ti-user"></i><span>Profile</span></button>';
    return true;
  }

  function evaluate() {
    if (!isMobile()) return;         // desktop: leave the (hidden) nav alone
    injectCss(); ensureSheets(); reshapeNav(); hookSwitchTab();
  }
  window.mobileShellEval = evaluate;

  window.addEventListener('resize', function () { setTimeout(evaluate, 120); });
  var _tries = 0;
  (function boot() { evaluate(); if ($('mnav') && $('mnav').classList.contains('mshell')) return; if (_tries++ > 40) return; setTimeout(boot, 250); })();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(evaluate, 300); });
  else setTimeout(evaluate, 300);
})();
