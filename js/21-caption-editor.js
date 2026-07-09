/* ===========================================================================
 * 21-caption-editor.js — Captions + on-screen Text for the Video Assembler.
 *
 * Adds a CapCut-style caption/text layer over the assembler preview:
 *   - Auto-transcript (pulled from window.segments script text) -> burned captions,
 *     one line per clip, timed to the reel.
 *   - Free-floating text overlays (drag to move, pinch / handle to resize).
 *   - Font / Style (outline/box/shadow/glow) / Animation / Size / Color.
 *   - KARAOKE: word-by-word highlight, live in the preview and burned per-word.
 *
 * Burn-in: on 1080p export, each caption line + text box is rendered to a
 * transparent PNG (client canvas) and handed to assemble-1080p as a timed
 * Transcoder image overlay. Karaoke expands a line into one overlay per word.
 *
 * Additive: hooks window.renderAssembler and exposes helpers the exporter calls.
 * ======================================================================== */
(function () {
  'use strict';

  var FONTS  = [{k:'clean',n:'Clean'},{k:'impact',n:'BOLD'},{k:'script',n:'Script'},{k:'serif',n:'Serif'},{k:'type',n:'Type'}];
  var STYLES = [{k:'none',n:'None'},{k:'outline',n:'Outline'},{k:'box',n:'Box'},{k:'shadow',n:'Shadow'},{k:'glow',n:'Glow'}];
  var ANIMS  = [{k:'none',n:'None'},{k:'pop',n:'Pop'},{k:'fade',n:'Fade'},{k:'slide',n:'Slide'},{k:'bounce',n:'Bounce'},{k:'karaoke',n:'Karaoke'}];
  var SWATCH = ['#ffffff','#ffe14d','#34d399','#ff5da2','#4d9bff','#111111'];
  var FONT_CSS = {
    clean:  '800 %SPX "Geist","Segoe UI",system-ui,sans-serif',
    impact: '900 %SPX Impact,"Arial Black",sans-serif',
    script: 'italic 600 %SPX "Segoe Script","Brush Script MT",cursive',
    serif:  '700 %SPX Georgia,"Times New Roman",serif',
    type:   '700 %SPX "Courier New",monospace'
  };
  var UPPER = { impact: true };

  var S = {
    mode: null,
    cap: { on: true, font: 'impact', color: '#ffe14d', size: 17, style: 'box', anim: 'pop', x: 50, y: 84 },
    tr: [], selLine: 0,
    texts: [], seq: 0, selTxt: null
  };
  window.ASMED = S;
  var _kInt = null;

  function esc(x){ return (x||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function escA(x){ return esc(x).replace(/"/g,'&quot;'); }
  function clamp(v,a,b){ return Math.max(a, Math.min(b, v)); }
  function dist(a,b){ var dx=a.x-b.x, dy=a.y-b.y; return Math.sqrt(dx*dx+dy*dy); }
  function ptVals(o){ return Object.keys(o).map(function(k){ return o[k]; }); }
  function words(s){ return (s||'').split(/\s+/).filter(Boolean); }
  function $(id){ return document.getElementById(id); }
  function specFromCap(text){ return { text: text, font: S.cap.font, style: S.cap.style, color: S.cap.color, size: S.cap.size, x: S.cap.x, y: S.cap.y }; }

  function refreshTranscript() {
    var clips = window._assemblerClips || [];
    var segs  = window.segments || [];
    var lines = [];
    clips.forEach(function (c) {
      var txt = '';
      var seg = segs[c.segIdx];
      if (seg) txt = seg.captionText || seg.speech || seg.voiceover || seg.scriptChunk || seg.text || '';
      txt = (txt || '').toString().trim();
      if (txt.length > 90) txt = txt.slice(0, 88).replace(/\s+\S*$/, '') + '…';
      lines.push({ text: txt || ('Scene ' + (lines.length + 1)) });
    });
    if (!lines.length) lines.push({ text: 'Your caption here' });
    if (S.tr.length === lines.length) { for (var i = 0; i < lines.length; i++) if (S.tr[i]._edited) lines[i] = S.tr[i]; }
    S.tr = lines;
    S.selLine = clamp(S.selLine, 0, S.tr.length - 1);
  }

  function lineTimes() {
    var clips = window._assemblerClips || [];
    var out = [], t = 0;
    for (var i = 0; i < clips.length; i++) { var used = Math.max(0, (clips[i].end - clips[i].start)); out.push({ start: t, end: t + used }); t += used; }
    if (S.tr.length !== clips.length) { var total = t || S.tr.length, per = total / S.tr.length; out = S.tr.map(function (_, i) { return { start: i * per, end: (i + 1) * per }; }); }
    return out;
  }

  function stopKaraoke(){ if (_kInt) { clearInterval(_kInt); _kInt = null; } }
  function renderOverlay() {
    stopKaraoke();
    var cap = $('asmCap'), layer = $('asmTextLayer');
    if (cap) {
      var capSel = (S.mode === 'caption');
      cap.className = 'edcap f-' + S.cap.font + ' st-' + S.cap.style + ' anim-' + S.cap.anim + (S.cap.on ? ' on' : '') + (capSel ? ' sel' : '');
      cap.style.left = S.cap.x + '%'; cap.style.top = S.cap.y + '%'; cap.style.fontSize = S.cap.size + 'px'; cap.style.color = S.cap.color;
      var lineTxt = (S.tr[S.selLine] && S.tr[S.selLine].text) || '';
      var handle = (capSel && S.cap.on) ? '<div class="edhandle">↘</div>' : '';
      if (S.cap.on && S.cap.anim === 'karaoke') {
        var ws = words(lineTxt);
        cap.innerHTML = '<span class="kwrap">' + ws.map(function (w) { return '<span class="kw">' + esc(w) + '</span>'; }).join(' ') + '</span>' + handle;
        var spans = cap.querySelectorAll('.kw');
        if (spans.length) { spans[0].classList.add('on'); var ki = 0; _kInt = setInterval(function () { for (var j = 0; j < spans.length; j++) spans[j].classList.remove('on'); ki = (ki + 1) % spans.length; spans[ki].classList.add('on'); }, 430); }
      } else {
        cap.innerHTML = '<span>' + esc(lineTxt) + '</span>' + handle;
      }
      cap.onpointerdown = (capSel && S.cap.on) ? gestureDown : null;
    }
    if (layer) {
      layer.innerHTML = S.texts.map(function (t) {
        var sel = (t.id === S.selTxt);
        return '<div class="edtext f-' + t.font + ' st-' + t.style + (sel ? ' sel' : '') + '" data-id="' + t.id + '" style="left:' + t.x + '%;top:' + t.y + '%;font-size:' + t.size + 'px;color:' + t.color + '"><span>' + esc(t.text) + '</span>' + (sel ? '<div class="edhandle">↘</div>' : '') + '</div>';
      }).join('');
      Array.prototype.forEach.call(layer.querySelectorAll('.edtext'), function (el) { el.addEventListener('pointerdown', gestureDown); });
    }
  }
  window.asmRenderOverlay = renderOverlay;

  function tabState() { var tt = $('asmTabText'), tc = $('asmTabCap'); if (tt) tt.classList.toggle('on', S.mode === 'text'); if (tc) tc.classList.toggle('on', S.mode === 'caption'); }
  window.asmEdTab = function (m) { S.mode = (S.mode === m) ? null : m; if (S.mode === 'caption') refreshTranscript(); tabState(); renderOverlay(); renderPanel(); };
  function fontChips(active, fn) { return '<div class="edfonts">' + FONTS.map(function (f) { return '<button class="edfont f-' + f.k + (f.k === active ? ' on' : '') + '" onclick="' + fn + '(\'' + f.k + '\')">' + f.n + '</button>'; }).join('') + '</div>'; }
  function pillRow(list, active, fn) { return '<div class="edpills">' + list.map(function (f) { return '<button class="edpill' + (f.k === active ? ' on' : '') + '" onclick="' + fn + '(\'' + f.k + '\')">' + f.n + '</button>'; }).join('') + '</div>'; }
  function swRow(active, fn) { return '<div class="edsw">' + SWATCH.map(function (c) { return '<button style="background:' + c + '"' + (c === active ? ' class="on"' : '') + ' onclick="' + fn + '(\'' + c + '\')"></button>'; }).join('') + '</div>'; }
  function getTxt(id) { for (var i = 0; i < S.texts.length; i++) if (S.texts[i].id === id) return S.texts[i]; return null; }

  function renderPanel() {
    var p = $('asmEdPanel'); if (!p) return;
    if (!S.mode) { p.style.display = 'none'; p.innerHTML = ''; return; }
    p.style.display = 'block';
    if (S.mode === 'text') {
      var t = getTxt(S.selTxt);
      var h = '<button class="edadd" onclick="asmAddText()">＋ Add text</button>';
      if (t) {
        h += '<div class="edrow2">' + fontChips(t.font, 'asmTxtFont')
          + '<div class="edlbl">Style</div>' + pillRow(STYLES, t.style, 'asmTxtStyle')
          + '<div class="edctl"><span>Size</span><input type="range" class="edrange" min="12" max="80" value="' + t.size + '" oninput="asmTxtSize(this.value)"></div>'
          + '<div class="edctl"><span>Color</span>' + swRow(t.color, 'asmTxtColor') + '</div>'
          + '<input class="edtxtin" value="' + escA(t.text) + '" oninput="asmTxtText(this.value)">'
          + '<div class="edhint">Drag to move / pinch or drag the handle to resize</div>'
          + '<div class="edmini"><button class="del" onclick="asmDelText()">Delete text</button></div></div>';
      } else { h += '<div class="edhint">Add a text box, then drag it anywhere on the video. Pick font, style, size &amp; color.</div>'; }
      p.innerHTML = h; return;
    }
    var karHint = (S.cap.anim === 'karaoke') ? '<div class="edhint" style="margin-top:6px">Karaoke: each word lights up in time with the audio (word timing split evenly across each line).</div>' : '';
    p.innerHTML =
      '<div class="edtgl-row"><div><b>Burn captions into export</b><span>Auto-synced from your script, one line per clip</span></div><div class="edtgl' + (S.cap.on ? ' on' : '') + '" onclick="asmCapToggle()"></div></div>'
      + '<div class="edlbl">Font</div>' + fontChips(S.cap.font, 'asmCapFont')
      + '<div class="edlbl">Style</div>' + pillRow(STYLES, S.cap.style, 'asmCapStyle')
      + '<div class="edlbl">Animation</div>' + pillRow(ANIMS, S.cap.anim, 'asmCapAnim') + karHint
      + '<div class="edctl"><span>Size</span><input type="range" class="edrange" min="12" max="60" value="' + S.cap.size + '" oninput="asmCapSize(this.value)"></div>'
      + '<div class="edctl"><span>Color</span>' + swRow(S.cap.color, 'asmCapColor') + '</div>'
      + '<div class="edlbl">Transcript</div>'
      + '<div class="edhint" style="margin-bottom:8px">Auto-transcribed from your script - tap a line to preview it, edit inline. <button class="trbtn" onclick="asmReTranscribe()">Re-transcribe</button></div>'
      + '<div class="trlist">' + S.tr.map(function (l, i) { return '<div class="trline' + (i === S.selLine ? ' on' : '') + '"><span class="tc">' + (i + 1) + '</span><input class="tri" value="' + escA(l.text) + '" onfocus="asmTrPick(' + i + ')" oninput="asmTrEdit(' + i + ',this.value)"></div>'; }).join('') + '</div>';
  }
  window.asmRenderPanel = renderPanel;

  window.asmAddText = function () { var id = ++S.seq; S.texts.push({ id: id, text: 'Your text', x: 50, y: 30, size: 30, font: 'impact', color: '#ffffff', style: 'shadow' }); S.selTxt = id; renderOverlay(); renderPanel(); };
  window.asmTxtFont  = function (f) { var t = getTxt(S.selTxt); if (t) { t.font = f; renderOverlay(); renderPanel(); } };
  window.asmTxtStyle = function (s) { var t = getTxt(S.selTxt); if (t) { t.style = s; renderOverlay(); renderPanel(); } };
  window.asmTxtSize  = function (v) { var t = getTxt(S.selTxt); if (t) { t.size = +v; renderOverlay(); } };
  window.asmTxtColor = function (c) { var t = getTxt(S.selTxt); if (t) { t.color = c; renderOverlay(); renderPanel(); } };
  window.asmTxtText  = function (v) { var t = getTxt(S.selTxt); if (t) { t.text = v; renderOverlay(); } };
  window.asmDelText  = function () { S.texts = S.texts.filter(function (x) { return x.id !== S.selTxt; }); S.selTxt = null; renderOverlay(); renderPanel(); };

  window.asmCapToggle = function () { S.cap.on = !S.cap.on; renderOverlay(); renderPanel(); };
  window.asmCapFont  = function (f) { S.cap.font = f; renderOverlay(); renderPanel(); };
  window.asmCapStyle = function (s) { S.cap.style = s; renderOverlay(); renderPanel(); };
  window.asmCapAnim  = function (a) { S.cap.anim = a; var c = $('asmCap'); if (c) { c.classList.remove('anim-' + a); void c.offsetWidth; } renderOverlay(); renderPanel(); };
  window.asmCapSize  = function (v) { S.cap.size = +v; var c = $('asmCap'); if (c) c.style.fontSize = S.cap.size + 'px'; };
  window.asmCapColor = function (c) { S.cap.color = c; renderOverlay(); renderPanel(); };
  window.asmTrPick   = function (i) { S.selLine = i; renderOverlay(); renderPanel(); };
  window.asmTrEdit   = function (i, v) { if (S.tr[i]) { S.tr[i].text = v; S.tr[i]._edited = true; if (i === S.selLine && S.cap.anim !== 'karaoke') { var c = $('asmCap'); if (c) { var sp = c.querySelector('span'); if (sp) sp.textContent = v; } } else if (i === S.selLine) { renderOverlay(); } } };
  window.asmReTranscribe = function () { var b = (typeof event !== 'undefined') && event.target; if (b) b.textContent = 'Transcribing…'; S.tr.forEach(function (l) { l._edited = false; }); refreshTranscript(); setTimeout(function () { renderPanel(); }, 700); };

  function gestureDown(e) {
    e.preventDefault(); e.stopPropagation();
    var el = e.currentTarget;
    var kind = (el.id === 'asmCap') ? 'cap' : +el.getAttribute('data-id');
    var o = (kind === 'cap') ? S.cap : getTxt(kind); if (!o) return;
    if (kind !== 'cap' && S.selTxt !== kind) { S.selTxt = kind; if (S.mode !== 'text') { S.mode = 'text'; tabState(); } renderOverlay(); renderPanel(); el = document.querySelector('#asmTextLayer .edtext[data-id="' + kind + '"]'); }
    var stage = $('asmStage'); el._ctx = { o: o, rect: stage.getBoundingClientRect() };
    el._pts = el._pts || {}; el._pts[e.pointerId] = { x: e.clientX, y: e.clientY }; el._last = { x: e.clientX, y: e.clientY };
    if (e.target.classList.contains('edhandle')) el._resize = { y0: e.clientY, s0: o.size };
    var ids = Object.keys(el._pts); if (ids.length >= 2) { var pv = ptVals(el._pts); el._pinch = { d0: dist(pv[0], pv[1]), s0: o.size }; }
    try { el.setPointerCapture(e.pointerId); } catch (_) {}
    el.addEventListener('pointermove', gestureMove); el.addEventListener('pointerup', gestureEnd); el.addEventListener('pointercancel', gestureEnd);
  }
  function gestureMove(e) {
    var el = e.currentTarget, c = el._ctx; if (!c) return; var o = c.o;
    if (el._pts && el._pts[e.pointerId]) el._pts[e.pointerId] = { x: e.clientX, y: e.clientY };
    if (el._resize) { var dy = e.clientY - el._resize.y0; o.size = clamp(Math.round(el._resize.s0 + dy * 0.5), 12, 96); el.style.fontSize = o.size + 'px'; return; }
    var ids = el._pts ? Object.keys(el._pts) : [];
    if (ids.length >= 2 && el._pinch) { var pv = ptVals(el._pts); var d = dist(pv[0], pv[1]); o.size = clamp(Math.round(el._pinch.s0 * d / el._pinch.d0), 12, 110); el.style.fontSize = o.size + 'px'; return; }
    var last = el._last || { x: e.clientX, y: e.clientY };
    o.x = clamp(o.x + (e.clientX - last.x) / c.rect.width * 100, 3, 97);
    o.y = clamp(o.y + (e.clientY - last.y) / c.rect.height * 100, 5, 95);
    el.style.left = o.x + '%'; el.style.top = o.y + '%'; el._last = { x: e.clientX, y: e.clientY };
  }
  function gestureEnd(e) {
    var el = e.currentTarget; if (el._pts) delete el._pts[e.pointerId];
    try { el.releasePointerCapture(e.pointerId); } catch (_) {}
    var ids = el._pts ? Object.keys(el._pts) : []; if (ids.length < 2) el._pinch = null;
    if (ids.length === 0) { el.removeEventListener('pointermove', gestureMove); el.removeEventListener('pointerup', gestureEnd); el.removeEventListener('pointercancel', gestureEnd); el._resize = null; el._last = null; }
    else el._last = null;
  }

  var OUT_W = 1080, OUT_H = 1920;
  function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
  function wrapWords(ctx, text, maxW) {
    var ws = words(text), lines = [], cur = [];
    for (var i = 0; i < ws.length; i++) { var test = cur.concat(ws[i]).join(' '); if (ctx.measureText(test).width > maxW && cur.length) { lines.push(cur); cur = [ws[i]]; } else cur.push(ws[i]); }
    if (cur.length) lines.push(cur);
    return lines.length ? lines : [[]];
  }
  function lineWidth(ctx, ws, space) { var w = 0; for (var i = 0; i < ws.length; i++) w += ctx.measureText(ws[i]).width + (i ? space : 0); return w; }
  function renderPNG(spec, scale, activeWord, outScale) {
    outScale = outScale || 1;
    var W = Math.round(OUT_W * outScale), H = Math.round(OUT_H * outScale);
    var cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    var ctx = cv.getContext('2d');
    var px = Math.round(spec.size * scale * outScale);
    var text = UPPER[spec.font] ? (spec.text || '').toUpperCase() : (spec.text || '');
    ctx.font = (FONT_CSS[spec.font] || FONT_CSS.clean).replace('%SPX', px + 'px');
    ctx.textBaseline = 'middle';
    var maxW = W * 0.9;
    var lines = wrapWords(ctx, text, maxW);
    var lh = px * 1.18;
    var cx = W * (spec.x / 100), cy = H * (spec.y / 100);
    var totalH = lines.length * lh, y0 = cy - totalH / 2 + lh / 2;
    var space = ctx.measureText(' ').width;
    if (spec.style === 'box') {
      var bw = 0; lines.forEach(function (ln) { bw = Math.max(bw, lineWidth(ctx, ln, space)); });
      var padX = px * 0.4, padY = px * 0.22;
      ctx.fillStyle = 'rgba(0,0,0,0.62)';
      roundRect(ctx, cx - bw / 2 - padX, y0 - lh / 2 - padY + (lh - px) / 2, bw + padX * 2, totalH + padY * 2 - (lh - px), px * 0.28); ctx.fill();
    }
    ctx.textAlign = 'left';
    var wi = 0;
    lines.forEach(function (ln, li) {
      var y = y0 + li * lh, x = cx - lineWidth(ctx, ln, space) / 2;
      ln.forEach(function (word) {
        var ww = ctx.measureText(word).width;
        ctx.save();
        if (activeWord != null && wi !== activeWord) ctx.globalAlpha = 0.48;
        if (spec.style === 'shadow') { ctx.shadowColor = 'rgba(0,0,0,0.9)'; ctx.shadowBlur = px * 0.28; ctx.shadowOffsetY = px * 0.08; }
        else if (spec.style === 'glow') { ctx.shadowColor = spec.color; ctx.shadowBlur = px * 0.55; }
        if (spec.style === 'outline') { ctx.lineWidth = Math.max(2, px * 0.12); ctx.strokeStyle = '#000'; ctx.lineJoin = 'round'; ctx.strokeText(word, x, y); }
        ctx.fillStyle = spec.color; ctx.fillText(word, x, y);
        if (spec.style === 'glow') { ctx.shadowBlur = px * 0.9; ctx.fillText(word, x, y); }
        ctx.restore();
        x += ww + space; wi++;
      });
    });
    return cv.toDataURL('image/png').split(',')[1];
  }

  window.asmBuildOverlayPayload = function () {
    var stage = $('asmStage'); if (!stage) return [];
    var sw = stage.getBoundingClientRect().width || 300;
    var scale = OUT_W / sw;
    var out = [], budget = 0; var MAXN = 110, MAXB = 4600000;
    var karaoke = (S.cap.anim === 'karaoke');
    if (S.cap.on && S.tr.length) {
      var times = lineTimes();
      for (var i = 0; i < S.tr.length; i++) {
        var l = S.tr[i]; if (!l.text) continue;
        var tm = times[i] || { start: 0, end: null };
        var ws = words(l.text);
        if (karaoke && tm.end != null && ws.length > 1 && out.length < MAXN && budget < MAXB) {
          var per = (tm.end - tm.start) / ws.length;
          for (var w = 0; w < ws.length; w++) {
            if (out.length >= MAXN || budget > MAXB) break;
            var kp = renderPNG(specFromCap(l.text), scale, w, 0.72);
            out.push({ png: kp, start: +(tm.start + w * per).toFixed(3), end: +(tm.start + (w + 1) * per).toFixed(3) });
            budget += kp.length;
          }
        } else {
          var p = renderPNG(specFromCap(l.text), scale, null, 1);
          out.push({ png: p, start: +(tm.start || 0).toFixed(3), end: (tm.end != null ? +tm.end.toFixed(3) : null) });
          budget += p.length;
        }
      }
    }
    S.texts.forEach(function (t) { if (t.text) { var p = renderPNG(t, scale, null, 1); out.push({ png: p, start: 0, end: null }); budget += p.length; } });
    return out;
  };
  window.asmHasOverlays = function () { return (S.cap.on && S.tr.some(function (l) { return l.text; })) || S.texts.length > 0; };

  function hookRender() {
    if (typeof window.renderAssembler !== 'function' || window.renderAssembler._capHooked) return false;
    var orig = window.renderAssembler;
    window.renderAssembler = function () {
      var r = orig.apply(this, arguments);
      try { refreshTranscript(); renderOverlay(); if (S.mode) renderPanel(); tabState(); } catch (e) { console.warn('[caption-editor]', e); }
      return r;
    };
    window.renderAssembler._capHooked = true;
    return true;
  }
  var _tries = 0;
  (function waitHook() { if (hookRender() || _tries++ > 40) return; setTimeout(waitHook, 250); })();

})();
