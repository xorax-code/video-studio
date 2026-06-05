  // ===== VIDEO DOWNLOADER =====
  const DL_SERVICES = {
    snapsave:  { home: 'https://snapsave.app/',  withUrl: u => `https://snapsave.app/?url=${encodeURIComponent(u)}` },
    ssstik:    { home: 'https://ssstik.io/en',   withUrl: u => `https://ssstik.io/en?url=${encodeURIComponent(u)}` },
    fdown:     { home: 'https://fdown.net/',     withUrl: u => `https://fdown.net/?URLz=${encodeURIComponent(u)}` },
  };

  function openDownloader(service) {
    const svc = DL_SERVICES[service];
    if (svc) window.open(svc.home, '_blank');
  }

  // --- Clear transcript ---
  function clearTranscript() {
    const ta = document.getElementById('originalScript');
    if (ta) { ta.value = ''; saveSegments(); }
    // Clear stale Whisper timestamps — leaving them causes distributeScript()
    // to assign words to wrong positions when the user transcribes a new video.
    whisperSegments = []; whisperWords = [];
    saveCurrentProjectData();
    const status = document.getElementById('transcribeStatus');
    if (status) { status.textContent = ''; status.style.display = 'none'; }
  }

  // --- Audio extraction helpers ---
  // Extracts the audio track from any video/audio file and encodes it as a
  // 16 kHz mono WAV blob. This shrinks a typical 15–30 MB TikTok video down
  // to ~500 KB–2 MB — well under Netlify's 6 MB Lambda payload limit.
  async function extractAudioAsWav(file, onProgress) {
    // Decode audio from the video file
    const arrayBuffer = await file.arrayBuffer();
    if (onProgress) onProgress('Decoding audio…');

    const tempCtx = new AudioContext();
    let audioBuffer;
    try {
      audioBuffer = await tempCtx.decodeAudioData(arrayBuffer);
    } catch (decodeErr) {
      try { await tempCtx.close(); } catch(_) {}
      throw new Error('Could not decode audio — the video may have no audio track or an unsupported codec.');
    }
    try { await tempCtx.close(); } catch(_) {}

    // Resample to 16 kHz mono using OfflineAudioContext (ideal for speech)
    const targetRate = 16000;
    const numFrames = Math.ceil(audioBuffer.duration * targetRate);
    const offCtx = new OfflineAudioContext(1, numFrames, targetRate);
    const src = offCtx.createBufferSource();
    src.buffer = audioBuffer;
    src.connect(offCtx.destination);
    src.start(0);
    if (onProgress) onProgress('Resampling…');
    const rendered = await offCtx.startRendering();

    // Encode as 16-bit PCM WAV
    const samples = rendered.getChannelData(0);
    const wavBuf = new ArrayBuffer(44 + samples.length * 2);
    const v = new DataView(wavBuf);
    const str = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
    str(0, 'RIFF');
    v.setUint32(4,  36 + samples.length * 2, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    v.setUint32(16, 16, true);          // PCM sub-chunk size
    v.setUint16(20, 1,  true);          // PCM format
    v.setUint16(22, 1,  true);          // mono
    v.setUint32(24, targetRate, true);  // sample rate
    v.setUint32(28, targetRate * 2, true); // byte rate
    v.setUint16(32, 2,  true);          // block align
    v.setUint16(34, 16, true);          // bits per sample
    str(36, 'data');
    v.setUint32(40, samples.length * 2, true);
    let off = 44;
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      v.setInt16(off, s < 0 ? s * 32768 : s * 32767, true);
      off += 2;
    }
    return new Blob([wavBuf], { type: 'audio/wav' });
  }

  // --- Whisper transcription ---
  async function transcribeVideo() {
    if (typeof window.requireAccess === 'function' && !window.requireAccess()) return;
    if (!refVideoFile) {
      showToast('Upload a video first, then click Transcribe.', 'warning');
      return;
    }
    const btn = document.getElementById('transcribeBtn');
    if (!btn) return;
    const status = document.getElementById('transcribeStatus');
    btn.disabled = true;
    btn.innerHTML = '<i class="ti ti-loader-2"></i>';
    if (status) status.style.display = 'inline';

    let fileToSend = refVideoFile;

    try {
      // If the file is larger than ~4 MB, extract audio-only before sending.
      // 16 kHz mono WAV for a 60s clip ≈ 1.9 MB — well within the 6 MB Lambda cap.
      if (refVideoFile.size > 3.5 * 1024 * 1024) {
        if (status) { status.textContent = 'Extracting audio…'; status.style.color = '#888'; }
        try {
          fileToSend = await extractAudioAsWav(refVideoFile, (msg) => {
            if (status) status.textContent = msg;
          });
          // Rename so the function picks the right MIME type
          fileToSend = new File([fileToSend], 'audio.wav', { type: 'audio/wav' });
          // Netlify Lambda payload cap is 6 MB; base64 overhead is ~4/3×
          if (fileToSend.size > 4.5 * 1024 * 1024) {
            if (status) status.textContent = '⚠️ Audio is too long to transcribe (max ~2 min). Trim the video and try again.';
            if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ti ti-microphone"></i>'; }
            return;
          }
        } catch (extractErr) {
          console.warn('Audio extraction failed, falling back to raw file:', extractErr);
          fileToSend = refVideoFile; // fall back — may fail if too large, but worth trying
        }
      }

      if (status) { status.textContent = 'Transcribing…'; status.style.color = '#888'; }

      const response = await _proxyTranscribe(fileToSend);
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        if (response.status === 401) {
          if (status) { status.textContent = '✗ Invalid API key'; status.style.color = '#cc6060'; }
        } else {
          if (status) { status.textContent = '✗ ' + (err.error?.message || 'API error ' + response.status); status.style.color = '#cc6060'; }
        }
        return;
      }
      const data = await response.json();
      // Store timestamped segments (phrase-level) for fallback use
      whisperSegments = (data.segments || []).map(s => ({
        start: s.start,
        end: s.end,
        text: s.text.trim()
      }));
      // Store per-word timestamps when available — eliminates linear interpolation guesswork
      whisperWords = (data.words || []).map(w => ({
        word: (w.word || '').trim(),
        start: w.start,
        end: w.end
      })).filter(w => w.word);
      const _osEl = document.getElementById('originalScript');
      if (_osEl) _osEl.value = (data.text || '').trim();
      const origScriptEl = _osEl;
      if (origScriptEl && typeof onMasterScriptInput === 'function') {
        onMasterScriptInput(origScriptEl);
      }
      saveCurrentProjectData();

      // If segments already exist (user segmented before transcribing), redistribute
      // their scripts now using the accurate Whisper word timestamps so the text shown
      // in each segment actually matches what was said in that time window.
      if (segments && segments.length > 0 && whisperWords.length > 0) {
        pushUndo('Before Transcribe Redistribution');
        if (distributeScriptFromTimestamps()) {
          renderSegments();
          saveSegments();
        }
      }

      const tsNote = whisperSegments.length > 0 ? ` (${whisperSegments.length} timed chunks)` : '';
      if (status) { status.textContent = '✓ Transcribed' + tsNote; status.style.color = '#5a8a5a'; }
      setTimeout(() => updateStepProgress?.(), 80);
      setTimeout(() => { if (status) status.style.display = 'none'; }, 3000);
    } catch (err) {
      console.error('Whisper error:', err);
      const msg = err.message || err.toString();
      if (msg.toLowerCase().includes('cors') || msg.toLowerCase().includes('failed to fetch')) {
        if (status) { status.textContent = '✗ Network error'; status.style.color = '#cc6060'; }
      } else {
        if (status) { status.textContent = '✗ ' + msg.substring(0, 60); status.style.color = '#cc6060'; }
      }
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ti ti-microphone"></i>'; }
    }
  }


  // --- Timestamp display ---
  function updateTimestamp() {
    const videoEl = document.getElementById('refVideoEl');
    if (!videoEl) return;
    const cur = videoEl.currentTime;
    const dur = videoEl.duration || 0;
    const fmt = t => { const m = Math.floor(t/60); const s = Math.floor(t%60); return m+':'+(s<10?'0':'')+s; };
    const _tsEl = document.getElementById('videoTimestamp');
    if (_tsEl) _tsEl.textContent = fmt(cur) + ' / ' + fmt(dur);
  }

  // --- Frame capture (returns Promise<dataUrl>) ---
  function captureFrame(time) {
    // Pure capture — does NOT restore currentTime after seeking.
    // Callers that need playhead restore should save videoEl.currentTime before
    // their call (or loop) and restore it after. Restoring inside here fires a
    // second 'seeked' event that can be caught by the next call's listener,
    // causing it to capture the wrong frame in rapid-succession loops.
    return new Promise((resolve) => {
      const videoEl = document.getElementById('refVideoEl');
      if (!videoEl || !videoEl.duration || isNaN(videoEl.duration) || videoEl.readyState < 1) { resolve(null); return; }
      const canvas = document.getElementById('frameCanvas');
      if (!canvas) { resolve(null); return; }
      const doCapture = () => {
        canvas.width = videoEl.videoWidth || 360;
        canvas.height = videoEl.videoHeight || 640;
        const ctx = canvas.getContext('2d');
        if (!ctx) { resolve(null); return; }
        ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.8));
      };
      if (Math.abs(videoEl.currentTime - time) < 0.1) {
        doCapture();
      } else {
        videoEl.currentTime = time;
        const seekTimeout = setTimeout(() => {
          videoEl.removeEventListener('seeked', onSeeked);
          resolve(null);
        }, 8000);
        const onSeeked = () => { clearTimeout(seekTimeout); doCapture(); };
        videoEl.addEventListener('seeked', onSeeked, { once: true });
      }
    });
  }

  // --- Downscale a dataURL to max 512px wide (keeps aspect ratio) ---
  // OpenAI detail:'low' caps at 512px anyway, so this is lossless from the
  // model's perspective but cuts payload size by ~75% on 1080p source videos,
  // keeping 6-frame batches well under Netlify's 6MB function body limit.
  function scaleDataUrl(dataUrl, maxWidth) {
    if (!dataUrl) return Promise.resolve(dataUrl);
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        if (!img.width || !img.height) { resolve(dataUrl); return; } // corrupt frame — send original
        const w = Math.min(img.width, maxWidth || 512);
        const h = Math.round(img.height * (w / img.width));
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const _sc2d = c.getContext('2d');
        if (!_sc2d) { resolve(dataUrl); return; }
        _sc2d.drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL('image/jpeg', 0.75));
      };
      img.onerror = () => resolve(dataUrl); // fallback: send original
      img.src = dataUrl;
    });
  }

  // ── Undo stack ──────────────────────────────────────────────────────────────
  // Saves a full snapshot of segments before any destructive operation so users
  // can step back through Detect Cuts, merges, AI analysis, etc.

  function pushUndo(label) {
    // Deep-clone via JSON — fast, handles all plain-object fields incl. frameDataUrl strings
    _undoStack.push({ label, segments: JSON.parse(JSON.stringify(segments)) });
    if (_undoStack.length > _UNDO_MAX) _undoStack.shift(); // cap memory
    _updateUndoBtn();
  }

  function undoLastAction() {
    if (_undoStack.length === 0) { showToast('Nothing to undo.', 'info'); return; }
    const prev = _undoStack.pop();
    segments = prev.segments;
    renderSegments();
    saveSegments();
    _updateUndoBtn();
    showToast(`↩ Undid: ${prev.label}`, 'success', 2500);
  }

  function _updateUndoBtn() {
    const btn = document.getElementById('undoBtn');
    if (!btn) return;
    if (_undoStack.length === 0) {
      btn.disabled = true;
      btn.setAttribute('title', 'Nothing to undo');
      btn.style.opacity = '0.4';
    } else {
      btn.disabled = false;
      btn.setAttribute('title', `Undo: ${_undoStack[_undoStack.length - 1].label}`);
      btn.style.opacity = '1';
    }
  }

  // --- Auto-segment every 8 seconds ---
  async function autoSegment() {
    const videoEl = document.getElementById('refVideoEl');
    if (!videoEl || !videoEl.duration || isNaN(videoEl.duration)) {
      showToast('Please upload a video first and wait for it to load.', 'warning');
      return;
    }
    const dur = videoEl.duration;
    const interval = 8;
    if (segments.length > 0) pushUndo('Auto Segment');
    segments = [];
    const times = [];
    for (let t = 0; t < dur; t += interval) {
      times.push({ start: t, end: Math.min(t + interval, dur) });
    }
    const _sc1 = document.getElementById('segmentsContainer');
    if (_sc1) _sc1.innerHTML =
      '<div style="text-align:center;padding:24px;font-size:11px;color:var(--text-3);">Capturing frames… <span id="captureProgress">0/' + times.length + '</span></div>';
    const savedPlayhead = videoEl.currentTime;
    for (let i = 0; i < times.length; i++) {
      const frameDataUrl = await captureFrame(times[i].start);
      segments.push({ startTime: times[i].start, endTime: times[i].end, frameDataUrl, script: '', action: '', sceneNotes: '', nbPrompt: '', veoPrompt: '' });
      const prog = document.getElementById('captureProgress');
      if (prog) prog.textContent = (i + 1) + '/' + times.length;
    }
    try { videoEl.currentTime = savedPlayhead; } catch(_) {}
    distributeScript();
    renderSegments();
    saveSegments();
  }

  // --- Frame diff helpers ---

  // Global mean absolute diff (sampled every 4th pixel for speed)
  function computeFrameDiff(data1, data2) {
    if (!data1.length || !data2.length) return 0;
    let total = 0;
    for (let i = 0; i + 2 < data1.length; i += 16) {
      total += Math.abs(data1[i]   - data2[i]);
      total += Math.abs(data1[i+1] - data2[i+1]);
      total += Math.abs(data1[i+2] - data2[i+2]);
    }
    return total / (data1.length / 16 * 3);
  }

  // Regional diff — compare only a rect within the frame (pixel coords in thumb space)
  function computeRegionDiff(data1, data2, w, x0, y0, x1, y1) {
    let total = 0, count = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const idx = (y * w + x) * 4;
        total += Math.abs(data1[idx]   - data2[idx]);
        total += Math.abs(data1[idx+1] - data2[idx+1]);
        total += Math.abs(data1[idx+2] - data2[idx+2]);
        count++;
      }
    }
    return count > 0 ? total / (count * 3) : 0;
  }

  // --- Automatically detect scene cuts by frame differencing ---
  // Detects: hard scene cuts (global diff) AND sudden object/item changes
  // (spike relative to recent rolling average, weighted toward hand/object region)
  let _autoSegRunning = false;
  async function autoSegmentBySceneChange() {
    if (_autoSegRunning) { showToast('Scene detection is already running — please wait.', 'warning'); return; }
    const videoEl = document.getElementById('refVideoEl');
    if (!videoEl || !videoEl.duration || isNaN(videoEl.duration)) {
      showToast('Please upload a video first and wait for it to load.', 'warning');
      return;
    }

    _autoSegRunning = true;
    const savedPlayheadASC = videoEl.currentTime;
    const btn = document.getElementById('detectCutsBtn');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Scanning…'; }
    try {

    const dur = videoEl.duration;
    const sampleInterval = 0.1;     // sample every 0.1s — catches sub-second scene changes
    const hardCutThreshold = 25;    // absolute diff for obvious scene cuts
    const spikeMultiplier = 2.8;    // sudden change = diff > rolling_avg × this
    const minSpikeAbs = 10;         // ignore spikes below this (noise floor)
    const minSegmentLen = 0.4;      // allow segments as short as 0.4s
    const thumbW = 80, thumbH = 45;

    const canvas = document.getElementById('frameCanvas');
    if (!canvas) { showToast('Canvas element missing — please refresh.', 'error'); return; }
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) { showToast('Canvas context unavailable — please refresh.', 'error'); return; }
    canvas.width = thumbW;
    canvas.height = thumbH;

    const _sc2 = document.getElementById('segmentsContainer');
    if (_sc2) _sc2.innerHTML =
      '<div style="text-align:center;padding:24px;font-size:11px;color:var(--text-3);">🎞 Scanning for scene cuts &amp; object changes… <span id="captureProgress">0%</span></div>';

    const cutTimes = [0];
    let prevData = null;
    const recentDiffs = []; // rolling window of composite diff scores
    const rollingWindow = 15; // ~1.5s of history at 0.1s sample rate
    const totalFrames = Math.ceil(dur / sampleInterval);

    for (let k = 0; k <= totalFrames; k++) {
      const t = Math.min(k * sampleInterval, dur);

      await new Promise(resolve => {
        if (Math.abs(videoEl.currentTime - t) < 0.04) { resolve(); return; }
        videoEl.currentTime = t;
        const _seekTo = setTimeout(() => { videoEl.removeEventListener('seeked', _onSeeked); resolve(); }, 8000);
        const _onSeeked = () => { clearTimeout(_seekTo); resolve(); };
        videoEl.addEventListener('seeked', _onSeeked, { once: true });
      });

      ctx.drawImage(videoEl, 0, 0, thumbW, thumbH);
      const currData = ctx.getImageData(0, 0, thumbW, thumbH).data;

      if (prevData) {
        // 1. Global diff — catches hard cuts
        const globalDiff = computeFrameDiff(prevData, currData);

        // 2. Center-lower region diff — where hands/objects appear in talking-head shots
        //    (bottom 60% of frame, center 70% horizontally)
        const cx0 = Math.floor(thumbW * 0.15), cx1 = Math.floor(thumbW * 0.85);
        const cy0 = Math.floor(thumbH * 0.35), cy1 = thumbH;
        const centerDiff = computeRegionDiff(prevData, currData, thumbW, cx0, cy0, cx1, cy1);

        // 3. Composite score: weight center region 1.5× vs global
        const score = (globalDiff + centerDiff * 1.5) / 2.5;

        // 4. Rolling average of recent scores (tracks "normal" motion level)
        recentDiffs.push(score);
        if (recentDiffs.length > rollingWindow) recentDiffs.shift();
        const rollingAvg = recentDiffs.reduce((a, b) => a + b, 0) / recentDiffs.length;

        // 5. Cut if hard cut OR sudden spike above the rolling baseline
        const isHardCut = score > hardCutThreshold;
        const isSuddenChange = score > rollingAvg * spikeMultiplier && score > minSpikeAbs;

        if (isHardCut || isSuddenChange) {
          const lastCut = cutTimes[cutTimes.length - 1];
          if (t - lastCut >= minSegmentLen) {
            cutTimes.push(t);
            // Reset rolling avg after a cut so next segment starts fresh
            recentDiffs.length = 0;
          }
        }
      }

      prevData = new Uint8ClampedArray(currData);

      const prog = document.getElementById('captureProgress');
      if (prog) prog.textContent = Math.min(100, Math.round((k / totalFrames) * 100)) + '%';
    }

    cutTimes.push(dur);

    // Fallback split: if no scene change was detected across a long stretch,
    // auto-split that gap into ~8s chunks so we don't end up with one massive
    // segment that has way too many words for Veo 3 (target is 8s ≈ 24 words).
    const MAX_SEG_LEN = 12;     // anything longer than this gets split
    const TARGET_SEG_LEN = 8;   // aim for chunks around this length
    const expandedCuts = [cutTimes[0]];
    for (let i = 1; i < cutTimes.length; i++) {
      const prevCut = expandedCuts[expandedCuts.length - 1];
      const currCut = cutTimes[i];
      const gap = currCut - prevCut;
      if (gap > MAX_SEG_LEN) {
        const chunks = Math.ceil(gap / TARGET_SEG_LEN);
        const chunkLen = gap / chunks;
        for (let j = 1; j < chunks; j++) {
          expandedCuts.push(prevCut + chunkLen * j);
        }
      }
      expandedCuts.push(currCut);
    }
    cutTimes.length = 0;
    cutTimes.push(...expandedCuts);

    // Build segments — snapshot first so Detect Cuts is undoable
    pushUndo('Detect Cuts');
    segments = [];
    for (let i = 0; i < cutTimes.length - 1; i++) {
      const start = cutTimes[i];
      const end = cutTimes[i + 1];
      if (end - start < 0.5) continue;
      segments.push({
        startTime: start, endTime: end,
        frameDataUrl: null,
        script: '', action: '', sceneNotes: '', nbPrompt: '', veoPrompt: ''
      });
    }

    // Capture start frames at full resolution
    const _sc3 = document.getElementById('segmentsContainer');
    if (_sc3) _sc3.innerHTML =
      '<div style="text-align:center;padding:24px;font-size:11px;color:var(--text-3);">Capturing frames… <span id="captureProgress">0/' + segments.length + '</span></div>';

    canvas.width = videoEl.videoWidth || 360;
    canvas.height = videoEl.videoHeight || 640;

    // Seek to t, draw a tiny 40×23 thumbnail, return grayscale variance.
    // High variance = visually rich/stable frame. Low variance = fade or blended transition.
    // captureFrame reuses the seek if videoEl.currentTime already equals t (tolerance 0.04s).
    const _tcv = document.createElement('canvas');
    _tcv.width = 40; _tcv.height = 23;
    const _tcvCtx = _tcv.getContext('2d');
    if (!_tcvCtx) {
      // canvas context unavailable — re-enable button and exit cleanly
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ti ti-scissors"></i> Detect Cuts'; }
      return;
    } // canvas context unavailable — skip diff pass entirely
    const seekAndVariance = async (t) => {
      await new Promise(res => {
        if (Math.abs(videoEl.currentTime - t) < 0.04) { res(); return; }
        videoEl.currentTime = t;
        const _to = setTimeout(() => { videoEl.removeEventListener('seeked', _fn); res(); }, 3000);
        const _fn = () => { clearTimeout(_to); res(); };
        videoEl.addEventListener('seeked', _fn, { once: true });
      });
      _tcvCtx.drawImage(videoEl, 0, 0, 40, 23);
      const d = _tcvCtx.getImageData(0, 0, 40, 23).data;
      let sum = 0, sumSq = 0;
      for (let p = 0; p < d.length; p += 4) {
        const g = d[p] * 0.299 + d[p + 1] * 0.587 + d[p + 2] * 0.114;
        sum += g; sumSq += g * g;
      }
      const n = d.length / 4, mean = sum / n;
      return sumSq / n - mean * mean;
    };

    for (let i = 0; i < segments.length; i++) {
      let frameTime = segments[i].startTime;
      if (i > 0) {
        const seg = segments[i];
        const segLen = seg.endTime - seg.startTime;
        // First probe: 0.5s in (or 40% for shorter segments, floor 0.3s)
        const off1 = Math.max(0.3, Math.min(0.5, segLen * 0.4));
        const t1 = Math.min(seg.startTime + off1, seg.endTime - 0.1);
        const v1 = await seekAndVariance(t1);
        if (v1 >= 200) {
          frameTime = t1; // Stable frame found — done
        } else {
          // Low variance → frame is likely still mid-transition (fade/dissolve/wipe).
          // Try deeper: 65% into segment or 1.0s, whichever is smaller.
          const off2 = Math.min(1.0, segLen * 0.65);
          const t2 = Math.min(seg.startTime + off2, seg.endTime - 0.1);
          if (t2 > t1 + 0.1) {
            const v2 = await seekAndVariance(t2);
            frameTime = v2 > v1 ? t2 : t1; // Use whichever is more distinct
          } else {
            frameTime = t1;
          }
        }
      }
      // captureFrame skips the seek if we're already at frameTime (saves time)
      segments[i].frameDataUrl = await captureFrame(frameTime);
      const prog = document.getElementById('captureProgress');
      if (prog) prog.textContent = (i + 1) + '/' + segments.length;
    }
    // Restore playhead to where it was before the scan
    try { videoEl.currentTime = savedPlayheadASC; } catch(_) {}

    // Use Whisper timestamps if available (most accurate), else proportional fallback
    if (!distributeScriptFromTimestamps()) distributeScript();
    renderSegments();
    saveSegments();
    // Fire spatial layout analysis in the background — non-blocking
    setTimeout(function() { _runSpatialLayoutBatch(); }, 800);

    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '✅ ' + segments.length + ' cuts found';
      setTimeout(() => { btn.innerHTML = '<i class="ti ti-scissors"></i> Detect Cuts'; }, 4000);
    }
    } catch (err) {
      showToast('Scene detection failed: ' + err.message, 'error');
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="ti ti-scissors"></i> Detect Cuts'; }
    } finally {
      _autoSegRunning = false;
    }
  }

  // --- Mark scene change manually at current playback time ---
  async function markSceneChange() {
    const videoEl = document.getElementById('refVideoEl');
    if (!videoEl || !videoEl.duration || isNaN(videoEl.duration)) { showToast('Please upload a video first.', 'warning'); return; }
    const _mcSavedPlayhead = videoEl.currentTime; // save before any seek
    const t = videoEl.currentTime;
    if (segments.length > 0) {
      const prev = segments[segments.length - 1];
      if (t <= prev.startTime + 0.5) {
        showToast('Seek further into the video before marking a new scene.', 'warning'); return;
      }
      pushUndo('Mark Scene');
      prev.endTime = t;
    }
    const frameDataUrl = await captureFrame(t);
    try { videoEl.currentTime = _mcSavedPlayhead; } catch(_) {}
    const dur = videoEl.duration || t + 8;
    segments.push({ startTime: t, endTime: dur, frameDataUrl, script: '', action: '', sceneNotes: '', nbPrompt: '', veoPrompt: '' });
    distributeScript();
    renderSegments();
    saveSegments();
  }

  // --- Duplicate a segment ---
  // Smart-splits the script at the nearest clause boundary to the midpoint,
  // splits the timestamp range proportionally, captures a fresh video frame at
  // the split timestamp for the clone, re-derives actions, and rebuilds prompts.
  async function duplicateSegment(i) {
    const dupBtn = document.querySelector(`#seg-card-${i} .dup-btn`);
    if (dupBtn) dupBtn.disabled = true;
    pushUndo(`Duplicate Seg ${i + 1}`);
    try {
    const seg = segments[i];
    if (!seg) return;

    const setting     = document.getElementById('studioSetting')?.value.trim() || '';
    const productSel  = document.getElementById('studioProduct');
    const productName = productSel ? (productSel.options[productSel.selectedIndex]?.text || 'the product') : 'the product';

    // ── Smart script split ──────────────────────────────────────────────────
    const script = (seg.script || '').trim();
    let firstHalf = script;
    let secondHalf = '';
    let didSplit = false;
    let firstWordCount = 0;
    let totalWordCount = 0;

    if (script) {
      const clauses = [];
      script.split(/([.!?]+|,|;)/).forEach(part => {
        if (/^[.!?,;]+$/.test(part)) {
          if (clauses.length) clauses[clauses.length - 1] += part;
        } else {
          const trimmed = part.trim();
          if (trimmed) clauses.push(trimmed);
        }
      });

      if (clauses.length > 1) {
        const allWords = script.split(/\s+/).filter(Boolean);
        totalWordCount = allWords.length;
        const midWord  = totalWordCount / 2;
        let wordsSoFar = 0, bestSplit = 1, bestDiff = Infinity;
        for (let c = 0; c < clauses.length - 1; c++) {
          wordsSoFar += clauses[c].split(/\s+/).filter(Boolean).length;
          const diff = Math.abs(wordsSoFar - midWord);
          if (diff < bestDiff) { bestDiff = diff; bestSplit = c + 1; }
        }
        firstHalf      = clauses.slice(0, bestSplit).join(' ').trim();
        secondHalf     = clauses.slice(bestSplit).join(' ').trim();
        firstWordCount = firstHalf.split(/\s+/).filter(Boolean).length;
        didSplit       = true;
      }

      // Fallback: no clause boundary found — split at word midpoint so the
      // cloned segment always gets text rather than an empty script.
      if (!didSplit) {
        const allWords = script.split(/\s+/).filter(Boolean);
        if (allWords.length >= 2) {
          totalWordCount = allWords.length;
          const mid  = Math.ceil(totalWordCount / 2);
          firstHalf      = allWords.slice(0, mid).join(' ');
          secondHalf     = allWords.slice(mid).join(' ');
          firstWordCount = mid;
          didSplit       = true;
        }
      }
    }

    // ── Timestamp split — proportional to word count ────────────────────────
    // The clone's startTime is where the second half of speech begins in the video.
    const clipDur     = seg.endTime - seg.startTime;
    const splitRatio  = (didSplit && totalWordCount > 0) ? firstWordCount / totalWordCount : 0.5;
    const splitTime   = seg.startTime + clipDur * splitRatio;
    const originalEnd = seg.endTime;

    // Shorten the original segment to the first half
    seg.endTime = splitTime;
    seg.script  = firstHalf;
    if (didSplit) seg.action = deriveSceneAction(firstHalf, i, segments.length + 1);

    // ── Build the clone ─────────────────────────────────────────────────────
    const clone = Object.assign({}, seg, {
      done:         false,
      startTime:    splitTime,
      endTime:      originalEnd,
      script:       secondHalf,
      action:       deriveSceneAction(secondHalf, i + 1, segments.length + 1),
      veoPrompt:    '',
      nbPrompt:     seg.nbPrompt,
      frameDataUrl: null,   // frame captured async below at splitTime
      targetX:      null,
      targetY:      null,
      targetPerson: null,
      targetGender: null,
    });

    // Insert so both indices are valid when building prompts
    segments.splice(i + 1, 0, clone);

    // Rebuild Veo 3 JSON for both with their correct time ranges + actions
    const cloneIdx = segments.indexOf(clone);
    seg.veoPrompt   = buildSegmentVeo3Prompt(i,        seg.startTime, seg.endTime, firstHalf,  setting, productName, bgImageDataUrl);
    clone.veoPrompt = buildSegmentVeo3Prompt(cloneIdx >= 0 ? cloneIdx : i + 1, splitTime, originalEnd, secondHalf, setting, productName, bgImageDataUrl);

    debounceSave();
    renderSegments();

    setTimeout(() => {
      const card = document.getElementById('seg-card-' + (i + 1));
      if (card) card.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    }, 120);

    showToast(
      didSplit
        ? '✂ Script split — capturing frame at split point…'
        : 'Segment duplicated — capturing frame…',
      'info', 3000
    );

    // ── Async: capture the frame at splitTime for the clone ─────────────────
    // Runs after render so the card is already visible. Once the frame arrives,
    // update the thumbnail in the DOM and rebuild the clone's Veo 3 prompt with
    // the new start frame context.
    if (!seg._scriptOnly) {
      try {
        const _dupVidEl = document.getElementById('refVideoEl');
        const _dupSavedTime = _dupVidEl ? _dupVidEl.currentTime : null;
        const newFrame = await captureFrame(splitTime);
        if (_dupVidEl && _dupSavedTime !== null) {
          try { _dupVidEl.currentTime = _dupSavedTime; } catch(_) {}
        }
        const cloneIdxNow = segments.indexOf(clone);
        if (newFrame && cloneIdxNow >= 0) {
          clone.frameDataUrl = newFrame;
          // Update the thumbnail live in the rendered card
          const card = document.getElementById('seg-card-' + cloneIdxNow);
          const img  = card?.querySelector('.seg-frame-img');
          if (img) img.src = newFrame;
          // Rebuild Veo 3 with the real start frame now available
          clone.veoPrompt = buildSegmentVeo3Prompt(cloneIdxNow, splitTime, originalEnd, secondHalf, setting, productName, bgImageDataUrl);
          const veoTa = document.getElementById('veo-seg-' + cloneIdxNow);
          if (veoTa) { veoTa.value = clone.veoPrompt; autoGrow(veoTa); }
          debounceSave();
          showToast('✅ Frame captured at split point — second segment ready.', 'success', 3000);
        } else if (!newFrame) {
          showToast('Video not loaded — frame not captured for the new segment. Load the video and use ↻ Regen Action to fill it in.', 'warning', 5000);
        }
      } catch (e) {
        showToast('Frame capture failed: ' + (e.message || e), 'warning');
      }
    }
    } finally {
      const dupBtnFinal = document.querySelector(`#seg-card-${i} .dup-btn`);
      if (dupBtnFinal) dupBtnFinal.disabled = false;
    }
  }

  // --- Clear all segments ---
  function clearSegments() {
    if (segments.length === 0) { segments = []; saveSegments(); renderSegments(); return; }
    showConfirm('Clear all ' + segments.length + ' segment' + (segments.length !== 1 ? 's' : '') + '? This cannot be undone.', () => {
      segments = [];
      saveSegments();
      renderSegments();
      // Re-expand the video player so the user can work with the video again
      setVideoMini(false);
    });
  }

  // --- Copy all Veo 3 prompts to clipboard ---
  function copyAllVeoPrompts() {
    const prompts = segments.map((s, i) => `[Seg ${i+1} — ${Math.floor(s.startTime/60)}:${String(Math.floor(s.startTime%60)).padStart(2,'0')}–${Math.floor(s.endTime/60)}:${String(Math.floor(s.endTime%60)).padStart(2,'0')}]\n${s.veoPrompt || '(empty)'}`);
    if (!prompts.length) { showToast('No segments yet.', 'warning'); return; }
    const nonEmpty = segments.filter(s => (s.veoPrompt || '').trim()).length;
    if (!nonEmpty) { showToast('No Veo 3 prompts generated yet — click ⚡ Generate Prompts first.', 'warning'); return; }
    const btn = (typeof event !== 'undefined' && event?.currentTarget) || document.querySelector('[onclick*="copyAllVeoPrompts"]');
    navigator.clipboard.writeText(prompts.join('\n\n')).then(() => {
      if (btn) { const orig = btn.textContent; btn.textContent = '✓ Copied!'; btn.style.color = '#4ade80'; setTimeout(() => { btn.textContent = orig; btn.style.color = '#a78bfa'; }, 1800); }
      showToast(`${prompts.length} Veo 3 prompt${prompts.length !== 1 ? 's' : ''} copied to clipboard`, 'success');
    }).catch(() => showToast('Copy failed — please try again.', 'error'));
  }

  // --- Download frame as image file ---
  function downloadFrame(i) {
    const seg = segments[i];
    if (!seg || !seg.frameDataUrl) return;
    const fmt = t => { const m = Math.floor(t/60); const s = Math.floor(t%60); return m+'m'+(s<10?'0':'')+s+'s'; };
    const a = document.createElement('a');
    a.href = seg.frameDataUrl;
    a.download = 'frame_seg' + (i+1) + '_start_' + fmt(seg.startTime) + '.jpg';
    a.click();
  }

  // --- Build word-level speech timing guide for a segment ---
  function buildSpeechTimingGuide(script, durationSec) {
    if (!script || !script.trim() || durationSec <= 0) return '';
    const WORDS_PER_SEC = 2.3;
    // Split into natural phrases at punctuation boundaries
    const phrases = script
      .split(/([,;.!?…]+)/)
      .reduce((acc, part, i, arr) => {
        // Re-attach punctuation to the preceding phrase
        if (/^[,;.!?…]+$/.test(part)) {
          if (acc.length) acc[acc.length - 1] += part;
        } else {
          const trimmed = part.trim();
          if (trimmed) acc.push(trimmed);
        }
        return acc;
      }, []);
    // Single phrase (no internal punctuation) — still output it at 0.0s so the
    // Veo agent knows when speech starts; just no mid-phrase timing markers.
    if (phrases.length <= 1) {
      return phrases.length === 1 ? `  [0.0s] "${phrases[0].trim()}"` : '';
    }
    let wordsSoFar = 0;
    const lines = [];
    phrases.forEach(phrase => {
      const t = Math.min(wordsSoFar / WORDS_PER_SEC, durationSec - 0.5);
      lines.push(`  [${t.toFixed(1)}s] "${phrase.trim()}"`);
      wordsSoFar += phrase.split(/\s+/).filter(Boolean).length;
    });
    return lines.join('\n');
  }

  // --- Build one batch of Veo agent prompts (startIdx = 0-based, count = how many) ---
  function copyVeoAgentBatch(startIdx, count, batchNum, totalBatches) {
    const withPrompts = segments.filter(s => (s.veoPrompt || '').trim());
    if (!withPrompts.length) { showToast('No Veo 3 prompts yet — generate prompts first.', 'warning'); return; }
    const batch = withPrompts.slice(startIdx, startIdx + count);
    if (!batch.length) { showToast('No prompts in this batch.', 'warning'); return; }
    const n = batch.length;
    const batchLabel = totalBatches > 1 ? ' (Batch ' + batchNum + ' of ' + totalBatches + ')' : '';

    // Build flat clip list — continuations reuse the parent frame number
    var clips = [];
    batch.forEach(function(seg, bIdx) {
      var frameIdx = bIdx + 1;
      var duration = Math.round((seg.endTime - seg.startTime) * 10) / 10;
      var speechText = '';
      try { var _p = JSON.parse(seg.veoPrompt || '{}'); speechText = _p.speech || seg.script || ''; } catch(_) { speechText = seg.script || ''; }
      var primaryClipNum = clips.length + 1;
      clips.push({ frameIdx: frameIdx, veoPrompt: seg.veoPrompt, speech: speechText, duration: duration, isExtra: false, primaryClipNum: null, seg: seg });
      (seg.veoExtras || []).filter(function(e){ return (e.veoPrompt||'').trim(); }).forEach(function(extra) {
        var dur = 8; try { dur = parseInt(JSON.parse(extra.veoPrompt).duration) || 8; } catch(_) {}
        clips.push({ frameIdx: frameIdx, veoPrompt: extra.veoPrompt, speech: extra.speech || '', duration: dur, isExtra: true, primaryClipNum: primaryClipNum, seg: seg });
      });
    });

    var totalClips = clips.length;
    var hasExtras  = clips.some(function(c){ return c.isExtra; });
    var lines = [];

    var _veoModel = (getAdminSettings().defaultModel || 'Veo 3.1 Lite');
    if (!hasExtras) {
      lines.push('I have ' + n + ' swapped NB Pro composite' + (n !== 1 ? 's' : '') + ' ready in order' + batchLabel + '. Using ' + _veoModel + ', generate one clip per frame in sequence — Frame 1 \u2192 Clip 1, Frame 2 \u2192 Clip 2, and so on. ' + totalClips + ' clips total.');
    } else {
      lines.push('I have ' + n + ' swapped NB Pro composite' + (n !== 1 ? 's' : '') + ' ready in order' + batchLabel + '. Using ' + _veoModel + ', generate ' + totalClips + ' video clips total — some frames are reused for more than one clip. Use the FRAME ASSIGNMENTS table below to know which frame to use as the start frame for each clip. Match by clip number, not by image content.');
    }
    lines.push('');
    lines.push('FRAME ASSIGNMENTS (' + n + ' frame' + (n !== 1 ? 's' : '') + ' \u2192 ' + totalClips + ' clip' + (totalClips !== 1 ? 's' : '') + '):');
    clips.forEach(function(clip, ci) {
      var note = clip.isExtra ? '  \u2190 REUSE Frame ' + clip.frameIdx + ' (same start frame as Clip ' + clip.primaryClipNum + ')' : '';
      lines.push('  Clip ' + (ci + 1) + ' \u2192 Frame ' + clip.frameIdx + note);
    });
    lines.push('');
    lines.push('CRITICAL \u2014 USE EACH PROMPT EXACTLY AS WRITTEN:');
    lines.push('\u2022 "speech" field: enter word-for-word. Do not change any wording.');
    lines.push('\u2022 "action" field: use exactly as written. Do not substitute your own description.');
    lines.push('\u2022 All other fields: copy verbatim \u2014 do NOT paraphrase, shorten, or combine.');
    lines.push('\u2022 Do not carry text from one clip into the next.');
    lines.push('\u2022 REUSE clips: go back and select the same frame number as the start frame. Do not upload a new frame.');
    lines.push('\u2022 TWO-PERSON SCENES: if a prompt has a "speaker" field, only that person\u2019s mouth syncs to the speech.');
    lines.push('');
    clips.forEach(function(clip, ci) {
      var reuseTag = clip.isExtra ? ' (REUSE \u2014 same start frame as Clip ' + clip.primaryClipNum + ')' : '';
      lines.push('\u2501\u2501\u2501 Clip ' + (ci + 1) + ' of ' + totalClips + ' \u00B7 Frame ' + clip.frameIdx + reuseTag + ' \u2501\u2501\u2501');
      lines.push('Model: ' + _veoModel);
      if (clip.isExtra) lines.push('\u2190 START FRAME: select Frame ' + clip.frameIdx + ' again \u2014 do NOT use a new or different frame.');
      try { var _sp = JSON.parse(clip.veoPrompt || '{}'); if (_sp.speaker) lines.push('\u26a0 TWO-PERSON SCENE \u2014 SPEAKER: ' + _sp.speaker + ' delivers ALL the speech'); } catch(_) {}
      lines.push((clip.veoPrompt || '').trim());
      var timing = buildSpeechTimingGuide(clip.speech, clip.duration);
      if (timing) { lines.push(''); lines.push('Speech timing \u2014 sync actions to these moments:'); lines.push(timing); }
      lines.push('');
    });
    lines.push('\u2501\u2501\u2501 END \u2014 ' + totalClips + ' clip' + (totalClips !== 1 ? 's' : '') + ' from ' + n + ' frame' + (n !== 1 ? 's' : '') + batchLabel + ' \u2501\u2501\u2501');

    var message = lines.join('\n');
    navigator.clipboard.writeText(message).then(function() {
      showToast('Batch ' + batchNum + ' copied \u2014 ' + totalClips + ' clip' + (totalClips !== 1 ? 's' : '') + ' from ' + n + ' frame' + (n !== 1 ? 's' : '') + '.', 'success', 4000);
    }).catch(function() {
      try { var ta = document.createElement('textarea'); ta.value = message; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); showToast('Batch ' + batchNum + ' copied!', 'success', 3000); } catch(e) { showToast('Copy failed \u2014 please try again.', 'error'); }
    });
  }

  // --- Copy all Veo 3 prompts as a single ordered message to paste into Claude in Chrome ---
  function copyVeoAgentAllScenePrompts() {
    const withPrompts = segments.filter(s => (s.veoPrompt || '').trim());
    const n = withPrompts.length;

    // Build flat clip list with frame assignments
    const clips = [];
    withPrompts.forEach((seg, idx) => {
      const frameIdx = idx + 1;
      const duration = Math.round((seg.endTime - seg.startTime) * 10) / 10;
      let speechText = '';
      try { const p = JSON.parse(seg.veoPrompt || '{}'); speechText = p.speech || seg.script || ''; } catch(_) { speechText = seg.script || ''; }
      const primaryClipNum = clips.length + 1;
      clips.push({ frameIdx, veoPrompt: seg.veoPrompt, speech: speechText, duration, isExtra: false, primaryClipNum: null, seg });
      (seg.veoExtras || []).filter(e => (e.veoPrompt||'').trim()).forEach(extra => {
        let dur = 8; try { dur = parseInt(JSON.parse(extra.veoPrompt).duration) || 8; } catch(_) {}
        clips.push({ frameIdx, veoPrompt: extra.veoPrompt, speech: extra.speech || '', duration: dur, isExtra: true, primaryClipNum, seg });
      });
    });

    const totalClips = clips.length;
    const hasExtras  = clips.some(c => c.isExtra);
    const lines = [];

    const _veoModelAll = getAdminSettings().defaultModel || 'Veo 3.1 Lite';
    if (!hasExtras) {
      lines.push(`I have ${n} swapped NB Pro composite${n !== 1 ? 's' : ''} ready in order. Using ${_veoModelAll}, generate one clip per frame in sequence \u2014 Frame 1 \u2192 Clip 1, Frame 2 \u2192 Clip 2, and so on. ${totalClips} clips total.`);
    } else {
      lines.push(`I have ${n} swapped NB Pro composite${n !== 1 ? 's' : ''} ready in order. Using ${_veoModelAll}, generate ${totalClips} video clips total \u2014 some frames are reused for more than one clip. Use the FRAME ASSIGNMENTS table below to know which frame to use as the start frame for each clip. Match by clip number, not by image content.`);
    }
    lines.push('');
    lines.push(`FRAME ASSIGNMENTS (${n} frame${n !== 1 ? 's' : ''} \u2192 ${totalClips} clip${totalClips !== 1 ? 's' : ''}):`);
    clips.forEach((clip, ci) => {
      const note = clip.isExtra ? `  \u2190 REUSE Frame ${clip.frameIdx} (same start frame as Clip ${clip.primaryClipNum})` : '';
      lines.push(`  Clip ${ci + 1} \u2192 Frame ${clip.frameIdx}${note}`);
    });
    lines.push('');
    lines.push('CRITICAL \u2014 USE EACH PROMPT EXACTLY AS WRITTEN:');
    lines.push('\u2022 "speech" field: enter word-for-word. Do not change any wording.');
    lines.push('\u2022 "action" field: use exactly as written. Do not substitute your own description.');
    lines.push('\u2022 All other fields: copy verbatim \u2014 do NOT paraphrase, shorten, or combine.');
    lines.push('\u2022 Do not carry text from one clip into the next.');
    lines.push('\u2022 REUSE clips: go back and select the same frame number as the start frame. Do not upload a new frame.');
    lines.push('\u2022 TWO-PERSON SCENES: if a prompt has a "speaker" field, only that person\u2019s mouth syncs to the speech.');
    lines.push('');
    clips.forEach((clip, ci) => {
      const reuseTag = clip.isExtra ? ` (REUSE \u2014 same start frame as Clip ${clip.primaryClipNum})` : '';
      lines.push(`\u2501\u2501\u2501 Clip ${ci + 1} of ${totalClips} \u00B7 Frame ${clip.frameIdx}${reuseTag} \u2501\u2501\u2501`);
      lines.push('Model: ' + _veoModelAll);
      if (clip.isExtra) lines.push(`\u2190 START FRAME: select Frame ${clip.frameIdx} again \u2014 do NOT use a new or different frame.`);
      try { const _sp = JSON.parse(clip.veoPrompt || '{}'); if (_sp.speaker) lines.push(`\u26a0 TWO-PERSON SCENE \u2014 SPEAKER: ${_sp.speaker} delivers ALL the speech`); } catch(_) {}
      lines.push((clip.veoPrompt || '').trim());
      const timing = buildSpeechTimingGuide(clip.speech, clip.duration);
      if (timing) { lines.push(''); lines.push('Speech timing \u2014 sync actions to these moments:'); lines.push(timing); }
      lines.push('');
    });
    lines.push(`\u2501\u2501\u2501 END \u2014 ${totalClips} clip${totalClips !== 1 ? 's' : ''} from ${n} frame${n !== 1 ? 's' : ''} \u2501\u2501\u2501`);

    const message = lines.join('\n');
    navigator.clipboard.writeText(message).then(() => {
      showToast(`${totalClips} clip prompt${totalClips !== 1 ? 's' : ''} copied (${n} frame${n !== 1 ? 's' : ''}) \u2014 paste into Claude in Chrome.`, 'success', 5000);
    }).catch(() => {
      try {
        const ta = document.createElement('textarea'); ta.value = message;
        document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
        showToast(`${totalClips} clip prompts copied!`, 'success', 3000);
      } catch(e) { showToast('Copy failed \u2014 please try again.', 'error'); }
    });
  }


  // --- Copy a batch of NB prompts matching a specific ZIP batch ─────────────
  function copyNBPromptsBatch(startFrameIdx, count, batchNum, totalBatches) {
    if (!avatarImageDataUrl) { showToast('Upload your avatar photo first.', 'warning'); return; }
    const frameSegs = segments.filter(s => s.frameDataUrl);
    const batchFrames = frameSegs.slice(startFrameIdx, startFrameIdx + count);
    if (!batchFrames.length) { showToast('No frames in this batch.', 'warning'); return; }
    const withNB = batchFrames.filter(s => (s.nbPrompt || '').trim());
    if (!withNB.length) { showToast('No NB prompts for this batch — generate prompts first.', 'warning'); return; }

    const _hasBg = !!(typeof bgImageDataUrl !== 'undefined' && bgImageDataUrl && !(typeof bgFromAvatar !== 'undefined' && bgFromAvatar));
    const _bgFrom = !!(typeof bgFromAvatar !== 'undefined' && bgFromAvatar);

    // Photo numbers restart for each batch ZIP: 1=avatar, 2=bg(if any), 2or3=product(if any), then scenes
    const _hasProdBatch = !!(typeof productImageDataUrl !== 'undefined' && productImageDataUrl);
    let batchPhotoIdx = 1 + (_hasBg ? 1 : 0) + (_hasProdBatch ? 1 : 0) + 1;
    const photoMap = new Map();
    batchFrames.forEach(seg => { photoMap.set(seg, batchPhotoIdx++); });
    const totalPhotos = 1 + (_hasBg ? 1 : 0) + (_hasProdBatch ? 1 : 0) + batchFrames.length;
    const startPhotoForScenes = 1 + (_hasBg ? 1 : 0) + (_hasProdBatch ? 1 : 0) + 1;

    const allNegTerms = new Set();
    const sceneBlocks = [];
    withNB.forEach(seg => {
      const segNum = segments.indexOf(seg) + 1;
      const photoNum = photoMap.get(seg);
      let instrText = '', photoGuide = '';
      try {
        const parsed = JSON.parse(seg.nbPrompt.trim());
        if (seg.isCTA) {
          photoGuide = 'Photo 1 = avatar (character to composite). Photo ' + photoNum + ' = product photo — character holds this product.';
          // Fix hardcoded "Photo 2" in the CTA instruction to the actual photo number
          instrText = (parsed.instruction || '').replace(/Photo 2 is the PRODUCT/g, 'Photo ' + photoNum + ' is the PRODUCT').replace(/\bPhoto 2\b/g, 'Photo ' + photoNum);
        } else {
          photoGuide = _bgFrom
            ? 'Photo 1 = your avatar (person + background source for Segment ' + segNum + ').'
            : 'Photo 1 = your avatar (person to composite). Photo ' + photoNum + ' = Segment ' + segNum + ' reference frame (background/composition to match).';
          instrText = parsed.instruction || '';
        }
        if (parsed.negative_prompt) {
          parsed.negative_prompt.split(',').forEach(t => { const tr = t.trim(); if (tr) allNegTerms.add(tr.toLowerCase()); });
        }
      } catch(_) { instrText = seg.nbPrompt.trim(); }
      sceneBlocks.push({ segNum, photoNum, instrText });
    });

    const consolidatedNeg = Array.from(allNegTerms).join(', ');
    const n = withNB.length;
    const batchLabel = ' (Batch ' + batchNum + ' of ' + totalBatches + ')';

    const sceneLines = [];
    sceneLines.push('━━━ NB Batch ' + batchNum + ' of ' + totalBatches + ' — ' + n + ' scene' + (n !== 1 ? 's' : '') + ' ━━━');
    sceneLines.push('');
    sceneBlocks.forEach(function(b) {
      sceneLines.push('━━━ Scene ' + b.segNum + ' → Photo ' + b.photoNum + ' ━━━');
      sceneLines.push(b.instrText);
      sceneLines.push('');
    });
    sceneLines.push('━━━ END — ' + n + ' scene' + (n !== 1 ? 's' : '') + '. One composite per scene. ━━━');

    const fullPrompt = sceneLines.join('\n');
    navigator.clipboard.writeText(fullPrompt).then(function() {
      showToast('NB Prompts Batch ' + batchNum + ' copied (' + n + ' scenes, segments ' + (startFrameIdx+1) + '–' + (startFrameIdx+n) + ').', 'success', 4000);
    }).catch(function() {
      try { var ta = document.createElement('textarea'); ta.value = fullPrompt; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); showToast('NB Batch ' + batchNum + ' copied!', 'success', 3000); } catch(e) { showToast('Copy failed.', 'error'); }
    });
  }

  // --- Copy all per-frame NB prompts as a single ordered message for the NB agent ---
  // Each segment's tailored NB prompt is included in order — no generic swap.
  // The agent composites the avatar into each frame individually using the exact instruction for that shot.
  function copyAllNBPromptsForAgent() {
    if (!avatarImageDataUrl) {
      showToast('Upload your avatar photo first — it becomes Photo 1 in each NB prompt.', 'warning');
      return;
    }
    const frameSegs = segments.filter(s => s.frameDataUrl);
    if (frameSegs.length === 0) {
      showToast('No scene frames yet — extract frames from the timeline first.', 'warning');
      return;
    }

    // Build photo-number map mirroring downloadAllFramesAsZip exactly:
    // Photo 1 = avatar, Photo 2 = first frame in segments order, Photo 3 = second, etc.
    const photoMap = new Map();
    const _hasBgPhotoForCopy = !!(typeof bgImageDataUrl !== 'undefined' && bgImageDataUrl && !(typeof bgFromAvatar !== 'undefined' && bgFromAvatar));
    const _hasProdCopy = !!(typeof productImageDataUrl !== 'undefined' && productImageDataUrl);
    let _photoIdx = 1 + (_hasBgPhotoForCopy ? 1 : 0) + (_hasProdCopy ? 1 : 0) + 1;
    segments.forEach(seg => { if (seg.frameDataUrl) photoMap.set(seg, _photoIdx++); });

    const totalPhotos = 1 + frameSegs.length;
    const withNB = frameSegs.filter(s => (s.nbPrompt || '').trim());
    const missingNB = frameSegs.filter(s => !(s.nbPrompt || '').trim());

    if (withNB.length === 0) {
      showToast('No per-frame NB prompts yet — click ⚡ Generate Prompts (or Analyze All Frames) first.', 'warning');
      return;
    }
    if (missingNB.length > 0) {
      const missing = missingNB.map(s => 'Photo ' + photoMap.get(s)).join(', ');
      showToast(`⚠ ${missingNB.length} frame(s) have no NB prompt and will be skipped: ${missing}. Run Analyze All Frames to fix.`, 'warning', 6000);
    }

    const n = withNB.length;

    // ── Collect per-segment data and deduplicate negative prompt terms ──────
    const allNegTerms = new Set();
    const sceneBlocks = [];

    withNB.forEach(seg => {
      const segNum = segments.indexOf(seg) + 1;
      const photoNum = photoMap.get(seg);
      let instrText = '';
      let photoGuide = '';
      try {
        const parsed = JSON.parse(seg.nbPrompt.trim());
        if (seg.isCTA) {
          photoGuide = `Photo 1 = avatar (character to composite). Photo ${photoNum} = product photo — character holds this product.`;
          instrText = (parsed.instruction || '').replace(/Photo 2 is the PRODUCT/g, `Photo ${photoNum} is the PRODUCT`).replace(/\bPhoto 2\b/g, `Photo ${photoNum}`);
        } else {
          photoGuide = bgFromAvatar
            ? `Photo 1 = your avatar (person + background source for Segment ${segNum}).`
            : `Photo 1 = your avatar (person to composite). Photo ${photoNum} = Segment ${segNum} reference frame (background/composition to match).`;
          instrText = parsed.instruction || '';
        }
        if (parsed.negative_prompt) {
          parsed.negative_prompt.split(',').forEach(t => {
            const trimmed = t.trim();
            if (trimmed) allNegTerms.add(trimmed.toLowerCase());
          });
        }
      } catch(_) { instrText = seg.nbPrompt.trim(); }
      sceneBlocks.push({ segNum, photoNum, photoGuide, instrText });
    });

    // ── Build all scene blocks ───────────────────────────────────────────────
    const sceneLines = [];
    sceneBlocks.forEach(({ segNum, photoNum, photoGuide, instrText }) => {
      sceneLines.push(`━━━ Scene ${segNum} → Photo ${photoNum} ━━━`);
      sceneLines.push(instrText);
      sceneLines.push('');
    });
    sceneLines.push(`━━━ END — ${n} scene${n !== 1 ? 's' : ''}. One composite per scene. ━━━`);
    const scenesBlock = sceneLines.join('\n');

    // ── Copy scenes directly — global rules are sent separately via the panel ─
    navigator.clipboard.writeText(scenesBlock).then(() => {
      showToast(`${n} NB scene prompt${n !== 1 ? 's' : ''} copied — paste after the Global Rules.`, 'success', 4000);
    }).catch(() => {
      try {
        const ta = document.createElement('textarea');
        ta.value = scenesBlock;
        document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
        showToast(`${n} NB scene prompts copied!`, 'success', 3000);
      } catch(e) { showToast('Copy failed — please try again.', 'error'); }
    });
  }

  // --- Targeted extras UI update — rebuilds ONLY the .seg-field-extras div
  // for one card, leaving all other textareas and cursor positions untouched ---

  function _toggleExtraPrompt(id) {
    var el = document.getElementById(id);
    if (el) el.style.display = el.style.display === 'none' ? '' : 'none';
  }

  function _copyExtraPrompt(si, ei, clipNum) {
    var extras = segments[si] && segments[si].veoExtras;
    var extra = extras && extras[ei];
    if (!extra) return;
    var text = extra.veoPrompt || '';
    navigator.clipboard.writeText(text).then(function() {
      showToast('Clip ' + clipNum + ' prompt copied', 'success', 2000);
    }).catch(function() {});
  }

  function _buildExtrasHTML(seg, i) {
    var hasExtras = !!(seg.veoExtras && seg.veoExtras.length > 0);
    var h = '';
    if (hasExtras) {
      h += '<div style="border-top:1px solid var(--border);padding-top:6px;margin-top:2px;">';
      h += '<div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;color:rgba(99,102,241,0.8);margin-bottom:5px;">&#x1F501; Continuation Clips <span style="font-weight:400;opacity:0.55;text-transform:none;letter-spacing:0;">(same frame &middot; new speech)</span></div>';
      seg.veoExtras.forEach(function(extra, j) {
        var promptId = 'veo-extra-prompt-' + i + '-' + j;
        h += '<div style="background:rgba(99,102,241,0.06);border:1px solid rgba(99,102,241,0.22);border-radius:6px;padding:7px 8px;margin-bottom:5px;display:flex;flex-direction:column;gap:5px;">';
        h += '<div style="display:flex;justify-content:space-between;align-items:center;">';
        h += '<span style="font-size:9px;font-weight:700;color:rgba(129,140,248,0.9);">Clip ' + (j + 2) + ' &mdash; Speech</span>';
        h += '<button onclick="removeVeoExtra(' + i + ',' + j + ')" style="background:none;border:none;color:var(--danger);font-size:10px;cursor:pointer;padding:0 4px;" title="Remove">&#x2715;</button>';
        h += '</div>';
        h += '<textarea id="veo-extra-speech-' + i + '-' + j + '" oninput="updateVeoExtraSpeech(' + i + ',' + j + ',this.value)" class="seg-ta-base seg-ta-script" style="min-height:38px;" placeholder="Exact speech for this clip...">' + escHtml(extra.speech || '') + '</textarea>';
        if (extra.veoPrompt) {
          h += '<div style="display:flex;justify-content:space-between;align-items:center;">';
          h += '<span style="font-size:8.5px;color:rgba(99,102,241,0.55);cursor:pointer;" onclick="_toggleExtraPrompt(' + JSON.stringify(promptId) + ')">&#x25B8; Veo 3 JSON (tap to view/edit)</span>';
          h += '<button class="btn-copy" onclick="_copyExtraPrompt(' + i + ',' + j + ',' + (j + 2) + ')" style="font-size:9px;padding:1px 7px;">Copy</button>';
          h += '</div>';
          h += '<textarea id="' + promptId + '" oninput="if(segments[' + i + '].veoExtras[' + j + '])segments[' + i + '].veoExtras[' + j + '].veoPrompt=this.value;debounceSave()" class="seg-ta-base seg-ta-prompt" style="display:none;font-size:9px;">' + escHtml(extra.veoPrompt || '') + '</textarea>';
        }
        h += '</div>';
      });
      h += '</div>';
    }
    h += '<button onclick="addVeoExtra(' + i + ')" style="width:100%;padding:5px 0;font-size:10px;font-weight:600;background:rgba(99,102,241,0.07);border:1px solid rgba(99,102,241,0.25);border-radius:5px;color:rgba(129,140,248,0.85);cursor:pointer;font-family:inherit;margin-top:' + (hasExtras ? '0' : '4px') + ';">&#xFF0B; Add Continuation Clip</button>';
    return h;
  }

  function _patchExtrasUI(segIdx) {
    var card = document.getElementById('seg-card-' + segIdx);
    if (!card) return;
    var extrasDiv = card.querySelector('.seg-field-extras');
    if (!extrasDiv) return;
    extrasDiv.innerHTML = _buildExtrasHTML(segments[segIdx], segIdx);
    extrasDiv.querySelectorAll('textarea').forEach(function(ta) { autoGrow(ta); });
  }

  // --- Continuation clips (veoExtras) — same start frame, different speech ---

  function addVeoExtra(segIdx) {
    if (!segments[segIdx]) return;
    if (!segments[segIdx].veoExtras) segments[segIdx].veoExtras = [];
    segments[segIdx].veoExtras.push({ speech: '', action: '', veoPrompt: '' });
    debounceSave();
    _patchExtrasUI(segIdx);
    setTimeout(function() {
      var j = segments[segIdx].veoExtras.length - 1;
      var ta = document.getElementById('veo-extra-speech-' + segIdx + '-' + j);
      if (ta) { ta.focus(); ta.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
    }, 30);
  }

  function removeVeoExtra(segIdx, extraIdx) {
    if (!segments[segIdx] || !segments[segIdx].veoExtras) return;
    segments[segIdx].veoExtras.splice(extraIdx, 1);
    debounceSave();
    _patchExtrasUI(segIdx);
  }

  function updateVeoExtraSpeech(segIdx, extraIdx, text) {
    if (!segments[segIdx] || !segments[segIdx].veoExtras || !segments[segIdx].veoExtras[extraIdx]) return;
    var extra = segments[segIdx].veoExtras[extraIdx];
    extra.speech = text;

    // Duration: snap to 6 or 8 s at 2.5 wps (same logic as storyboard engine)
    var wc = text.trim().split(/\s+/).filter(Boolean).length;
    var dur = (wc / 2.5) > 5 ? 8 : 6;

    // Inherit shot / camera / audio / negative_prompt from the parent segment's Veo 3 JSON
    var parentSeg = segments[segIdx];
    var parentVeo = {};
    try { parentVeo = JSON.parse(parentSeg.veoPrompt || '{}'); } catch(_) {}

    // Continuation clips share the parent's start frame — use the action from the parent's
    // Veo 3 JSON (built from actual video analysis) so the physical action stays consistent.
    // Never re-derive from speech text — deriveSceneAction keyword-matches props from metaphors.
    extra.action = parentVeo.action || parentSeg.action || 'person speaks naturally to camera — confident posture, real eye contact, natural hand gestures';

    var obj = {
      speech:          text,
      action:          extra.action,
      shot:            parentVeo.shot            || 'medium shot, vertical 9:16',
      camera:          parentVeo.camera          || 'static handheld, slight natural movement',
      duration:        dur + ' seconds',
      audio:           parentVeo.audio           || 'clear natural voice, slight ambient room tone, no background music',
      negative_prompt: parentVeo.negative_prompt || 'multiple people, cuts, transitions, text overlays, subtitles, watermarks, AI artifacts',
    };
    extra.veoPrompt = JSON.stringify(obj, null, 2);
    debounceSave();

    // Live-update the JSON textarea if it is already expanded
    var promptEl = document.getElementById('veo-extra-prompt-' + segIdx + '-' + extraIdx);
    if (promptEl) promptEl.value = extra.veoPrompt;
  }


  // Pull the NEXT segment's script into the current segment as a continuation clip
  function addVeoExtraFromNextSeg(segIdx) {
    var nextSeg = segments[segIdx + 1];
    if (!nextSeg) { showToast('No next segment.', 'warning'); return; }
    var speech = (nextSeg.script || '').trim();
    if (!speech) { showToast('Seg ' + (segIdx + 2) + ' has no script yet — add it first.', 'warning'); return; }
    if (!segments[segIdx].veoExtras) segments[segIdx].veoExtras = [];
    segments[segIdx].veoExtras.push({ speech: '', action: '', veoPrompt: '' });
    var extraIdx = segments[segIdx].veoExtras.length - 1;
    updateVeoExtraSpeech(segIdx, extraIdx, speech);
    _patchExtrasUI(segIdx);
    setTimeout(function() {
      var ta = document.getElementById('veo-extra-speech-' + segIdx + '-' + extraIdx);
      if (ta) ta.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 80);
    showToast('Seg ' + (segIdx + 2) + ' script added as continuation clip on Seg ' + (segIdx + 1) + '.', 'success', 3000);
  }

  // --- Copy NB Global Rules — paste this into the NB agent FIRST, before any batch ---
  function copyNBGlobalRules() {
    if (!avatarImageDataUrl) {
      showToast('Upload your avatar photo first — it becomes Photo 1 in the prompt.', 'warning');
      return;
    }
    const _hasBg = !!(typeof bgImageDataUrl !== 'undefined' && bgImageDataUrl && !(typeof bgFromAvatar !== 'undefined' && bgFromAvatar));
    const _bgFrom = !!(typeof bgFromAvatar !== 'undefined' && bgFromAvatar);

    // Consolidate negative prompts from ALL segments with NB prompts
    const allNegTerms = new Set();
    segments.forEach(function(seg) {
      if (!(seg.nbPrompt || '').trim()) return;
      try {
        var parsed = JSON.parse(seg.nbPrompt.trim());
        if (parsed.negative_prompt) {
          parsed.negative_prompt.split(',').forEach(function(t) {
            var tr = t.trim(); if (tr) allNegTerms.add(tr.toLowerCase());
          });
        }
      } catch(_) {}
    });
    allNegTerms.add('no captions');
    var consolidatedNeg = Array.from(allNegTerms).join(', ');

    var photoLine = 'Upload order: Photo 1 = my avatar.';
    if (_hasBg) photoLine += ' Photo 2 = background reference.';
    else if (_bgFrom) photoLine += ' Photo 1 also provides the background (avatar photo is the background source).';
    photoLine += ' Scene frames follow in order — one per scene, uploaded with each batch.';

    var lines = [];
    lines.push('GLOBAL SETUP — paste this first, before sending any batch:');
    lines.push('');
    lines.push(photoLine);
    lines.push('');
    lines.push('GLOBAL (apply to every scene in every batch):');
    lines.push('remove_captions: true');
    const _extraNeg = 'original person preserved, original face visible, original hair remaining, clothing swap only, face blending, identity merge, mixed person, original character remaining';
    const _fullNeg = consolidatedNeg ? consolidatedNeg + ', ' + _extraNeg : _extraNeg;
    lines.push('negative_prompt: "' + _fullNeg + '"');
    lines.push('base_instruction: "REPLACE: the person in Photo 2 with the avatar from Photo 1. The original person must be ENTIRELY REMOVED — face, hair, body, clothing all gone. Avatar occupies the exact position, size, depth, and pose of the original person. LOCK: the background — every background element, surface, prop, and object from Photo 2 stays 100% identical. LOCK: any secondary person not targeted — they stay completely unchanged. This is a full person replacement, NOT a clothing swap or face overlay. One output per scene."');
    lines.push('');
    lines.push('RULES: Each scene block describes ONLY what is unique to that frame. Apply base_instruction on top of every scene. Do NOT apply a single generic swap instruction across all frames.');

    var text = lines.join('\n');
    navigator.clipboard.writeText(text).then(function() {
      showToast('Global rules copied — paste into NB Pro first, then send each batch.', 'success', 4000);
    }).catch(function() {
      try {
        var ta = document.createElement('textarea'); ta.value = text;
        document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
        showToast('Global rules copied!', 'success', 3000);
      } catch(e) { showToast('Copy failed — please try again.', 'error'); }
    });
  }

    // --- Copy Veo Agent avatar-swap prompt ---
  function copyVeoAgentSwapPrompt() {
    if (!avatarImageDataUrl) {
      showToast('Upload your avatar photo first — it becomes Photo 1 in the prompt.', 'warning');
      return;
    }
    const frameCount = segments.filter(s => s.frameDataUrl).length;
    if (frameCount === 0) {
      showToast('No scene frames extracted yet — use the timeline to capture frames for each segment first.', 'warning');
      return;
    }

    // Derive gender language from the Voice & Accent gender selector
    const voiceGender = (document.getElementById('avatarVoiceGender')?.value || '').toLowerCase();
    let genderNoun, genderPronoun, genderPossessive;
    if (voiceGender === 'male') {
      genderNoun = 'the man'; genderPronoun = 'he'; genderPossessive = 'his';
    } else if (voiceGender === 'female') {
      genderNoun = 'the woman'; genderPronoun = 'she'; genderPossessive = 'her';
    } else {
      // Gender not set — use neutral language and nudge the user
      genderNoun = 'the person'; genderPronoun = 'they'; genderPossessive = 'their';
      showToast('Tip: set the Gender in Voice & Accent to get he/she language in the swap prompt.', 'info', 4000);
    }

    const totalPhotos = 1 + frameCount; // Photo 1 = avatar, Photos 2–N = frames
    const prompt = `Photo 1 is my avatar — ${genderNoun} whose face, body, hair, and clothing must be preserved exactly as they appear. Photos 2 through ${totalPhotos} are frames pulled from a video. For each frame, replace the person in it with ${genderNoun} from Photo 1. ${genderPronoun.charAt(0).toUpperCase() + genderPronoun.slice(1)} must match the original person's exact body position, pose, and stance in that frame. Place ${genderPronoun === 'they' ? 'them' : genderPronoun === 'he' ? 'him' : 'her'} against the original frame's background — do not change the background, lighting, or environment. If the person in the frame is holding, touching, or interacting with any object, ${genderPronoun} must be holding or interacting with that same object in the same hand, at the same position. Keep ${genderPossessive} clothing, hair, and appearance identical to Photo 1 throughout every single frame. Remove any text, captions, subtitles, or watermarks from every frame. Apply this consistently across all frames so ${genderPronoun} looks like a continuous, natural presence throughout the video.`;
    navigator.clipboard.writeText(prompt).then(() => {
      showToast('Veo Agent swap prompt copied — paste it into the Veo agent after uploading your photos.', 'success', 4000);
    }).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = prompt;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      showToast('Veo Agent swap prompt copied!', 'success', 3000);
    });
  }

  // --- Download avatar + all scene frames as a single ZIP folder ---
  async function downloadAllFramesAsZip() {
    if (typeof JSZip === 'undefined') {
      showToast('JSZip library not loaded — please refresh the page and try again.', 'error');
      return;
    }
    const frameSegs = segments.filter(s => s.frameDataUrl);
    if (!avatarImageDataUrl && frameSegs.length === 0) {
      showToast('No avatar or frames found. Upload your avatar and extract frames first.', 'warning');
      return;
    }

    // Helper: convert dataURL to Uint8Array
    const dataUrlToBytes = (dataUrl) => {
      const _ci = dataUrl ? dataUrl.indexOf(',') : -1;
      if (_ci === -1) return new Uint8Array(0);
      const base64 = dataUrl.slice(_ci + 1);
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes;
    };
    const dataUrlExt = (dataUrl) => {
      const mime = (dataUrl.match(/^data:(image\/[a-z+]+);/) || [])[1] || 'image/jpeg';
      return mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
    };

    const _hasProduct = !!(typeof productImageDataUrl !== 'undefined' && productImageDataUrl);
    const _hasBgPhoto = !!(typeof bgImageDataUrl !== 'undefined' && bgImageDataUrl && !(typeof bgFromAvatar !== 'undefined' && bgFromAvatar));
    const projectName = (getActiveProject()?.name || 'project').replace(/[^a-zA-Z0-9_\-]/g, '_').toLowerCase();

    // NB Pro limit: 20 files total including avatar, bg, product, and scene frames
    const NB_LIMIT = 20;
    const fixedCount = (avatarImageDataUrl ? 1 : 0) + (_hasProduct ? 1 : 0) + (_hasBgPhoto ? 1 : 0);
    const framesPerBatch = Math.max(1, NB_LIMIT - fixedCount); // how many scene frames fit per ZIP (minimum 1)
    const totalBatches = Math.ceil(frameSegs.length / framesPerBatch) || 1;
    const needsBatch = totalBatches > 1;

    if (needsBatch) {
      showToast(frameSegs.length + ' frames — downloading ' + totalBatches + ' ZIPs (' + framesPerBatch + ' frames each, ' + fixedCount + ' fixed photos per ZIP)…', 'info', 5000);
    } else {
      showToast('Building ZIP…', 'info', 2500);
    }

    // Build and download one ZIP for a given slice of frameSegs
    const _downloadBatch = async (batchFrames, batchNum, totalBatches) => {
      const zip = new JSZip();
      const folder = zip.folder('veo_frames');
      const suffix = totalBatches > 1 ? ('_batch' + batchNum + 'of' + totalBatches) : '';

      // Fixed photos always first in every batch, consistently numbered:
      // Photo 1 = avatar · Photo 2 = bg (if exists) · Photo 2 or 3 = product (if exists) · then scene frames
      const _productPhotoNum = _hasBgPhoto ? 3 : 2;
      const _scenesStartAt   = 1 + (_hasBgPhoto ? 1 : 0) + (_hasProduct ? 1 : 0) + 1; // 1-based start for scene frames
      if (avatarImageDataUrl) folder.file('Photo-01-avatar.' + dataUrlExt(avatarImageDataUrl), dataUrlToBytes(avatarImageDataUrl));
      if (_hasBgPhoto)        folder.file('Photo-02-background.' + dataUrlExt(bgImageDataUrl), dataUrlToBytes(bgImageDataUrl));
      if (_hasProduct)        folder.file('Photo-' + String(_productPhotoNum).padStart(2, '0') + '-product.' + dataUrlExt(productImageDataUrl), dataUrlToBytes(productImageDataUrl));

      // Scene frames for this batch, photo-numbered from where fixed photos end
      let photoIdx = _scenesStartAt;
      batchFrames.forEach((seg) => {
        const segIdx = segments.indexOf(seg);
        const ext = dataUrlExt(seg.frameDataUrl);
        const filename = seg.isCTA
          ? 'Photo-' + String(photoIdx).padStart(2, '0') + '-cta-product-seg' + String(segIdx + 1).padStart(2, '0') + '.' + ext
          : 'Photo-' + String(photoIdx).padStart(2, '0') + '-scene-' + String(segIdx + 1).padStart(2, '0') + '.' + ext;
        folder.file(filename, dataUrlToBytes(seg.frameDataUrl));
        photoIdx++;
        // Also include NB composite if available
        if (seg.nbPreviewDataUrl) {
          const nbExt = dataUrlExt(seg.nbPreviewDataUrl);
          folder.file('NB-composite-scene-' + String(segIdx + 1).padStart(2, '0') + '.' + nbExt, dataUrlToBytes(seg.nbPreviewDataUrl));
        }
      });

      const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 3 } });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'veo_frames_' + projectName + suffix + '.zip';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    };

    try {
      for (let b = 0; b < totalBatches; b++) {
        const batchFrames = frameSegs.slice(b * framesPerBatch, (b + 1) * framesPerBatch);
        await _downloadBatch(batchFrames, b + 1, totalBatches);
        if (b < totalBatches - 1) await new Promise(r => setTimeout(r, 800)); // brief gap between downloads
      }
      if (needsBatch) {
        showToast('✅ ' + totalBatches + ' ZIPs downloaded — upload each batch to NB Pro separately. Fixed photos (avatar/bg/product) are in every ZIP.', 'success', 8000);
      } else {
        const total = fixedCount + frameSegs.length;
        showToast('ZIP downloaded — ' + total + ' image' + (total !== 1 ? 's' : '') + ' inside.', 'success', 5000);
      }
    } catch (e) {
      showToast('ZIP generation failed: ' + e.message, 'error');
    }
  }

  // --- Veo Agent panel — redesigned 3-step modal ---
  function openVeoAgentPanel() {
    if (typeof window.requireAccess === 'function' && !window.requireAccess()) return;
    document.getElementById('veoAgentModal')?.remove();
    var _fc = segments.filter(function(s) { return s.frameDataUrl; }).length;
    var _nbR = segments.filter(function(s) { return (s.nbPrompt||''  ).trim(); }).length;
    var _vR  = segments.filter(function(s) { return (s.veoPrompt||''  ).trim(); }).length;
    var _hasP = !!(typeof productImageDataUrl !== 'undefined' && productImageDataUrl);
    var _hasB = !!(typeof bgImageDataUrl !== 'undefined' && bgImageDataUrl && !(typeof bgFromAvatar !== 'undefined' && bgFromAvatar));
    var _fixed = (avatarImageDataUrl ? 1 : 0) + (_hasP ? 1 : 0) + (_hasB ? 1 : 0);
    var _fpb = Math.max(1, 20 - _fixed);
    var _zb = _fc > _fpb ? Math.ceil(_fc / _fpb) : 1;
    var _vb = Math.ceil(_vR / 20) || 1;

    // ZIP button
    var _zLbl = _zb > 1 ? '(' + _zb + ' ZIPs \u2014 ' + _fpb + ' frames each)' : _fc + ' frames + ' + _fixed + ' fixed';
    var _zBorder = _zb > 1 ? '0.55' : '0.32';
    var _zipBtn = '<button onclick="downloadAllFramesAsZip()" style="display:flex;align-items:center;justify-content:space-between;padding:9px 14px;border-radius:8px;background:rgba(251,146,60,0.09);border:1px solid rgba(251,146,60,' + _zBorder + ');color:#fb923c;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;width:100%;box-sizing:border-box;"><span>\uD83D\uDCE6 Download ZIP' + (_zb > 1 ? ' \xD7' + _zb : '') + '</span><span style="font-size:10px;opacity:0.65;font-weight:500;">' + _zLbl + '</span></button>';

    // NB prompt buttons
    var _nbBtns = '';
    if (_zb <= 1) {
      var _nbLabel = '\uD83C\uDF4C Copy NB Prompts';
      var _nbCount = _nbR + ' prompts';
      var _nbOnClick = 'copyAllNBPromptsForAgent()';
      _nbBtns = '<button onclick="' + _nbOnClick + '" style="display:flex;align-items:center;justify-content:space-between;padding:9px 14px;border-radius:8px;background:rgba(251,146,60,0.09);border:1px solid rgba(251,146,60,0.32);color:#fb923c;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;width:100%;box-sizing:border-box;"><span>' + _nbLabel + '</span><span style="font-size:10px;opacity:0.6;font-weight:500;">' + _nbCount + '</span></button>';
    } else {
      for (var _bn = 0; _bn < _zb; _bn++) {
        var _bs = _bn * _fpb, _be = Math.min(_bs + _fpb, _fc), _bc = _be - _bs;
        var _bo = _bn === 0 ? '0.14' : '0.07', _bb = _bn === 0 ? '0.5' : '0.25';
        _nbBtns += '<button onclick="copyNBPromptsBatch(' + _bs + ',' + _bc + ',' + (_bn+1) + ',' + _zb + ')" style="display:flex;align-items:center;justify-content:space-between;padding:9px 14px;border-radius:8px;background:rgba(251,146,60,' + _bo + ');border:1px solid rgba(251,146,60,' + _bb + ');color:#fb923c;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;margin-bottom:5px;width:100%;box-sizing:border-box;"><span>\uD83C\uDF4C NB Batch ' + (_bn+1) + ' \u2014 Scenes ' + (_bs+1) + '\u2013' + _be + '</span><span style="font-size:10px;opacity:0.6;font-weight:500;">' + _bc + ' scenes</span></button>';
      }
    }

    // Veo 3 buttons
    var _vBtn = '';
    if (!_vR) {
      _vBtn = '<div style="font-size:11px;color:var(--text-3);padding:4px 0;">No Veo 3 prompts yet.</div>';
    } else if (_vR <= 20) {
      _vBtn = '<button onclick="copyVeoAgentAllScenePrompts()" style="width:100%;display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-radius:8px;background:var(--grad-accent);border:none;color:#fff;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;box-sizing:border-box;"><span>\uD83D\uDCCB Copy All ' + _vR + ' Scene Prompts</span></button>';
    } else {
      for (var _vbi = 0; _vbi < _vb; _vbi++) {
        var _vs = _vbi * 20, _ve = Math.min(_vs + 20, _vR), _vc = _ve - _vs;
        var _vbg = _vbi === 0 ? 'var(--grad-accent)' : 'rgba(124,106,247,0.12)';
        var _vbBord = _vbi === 0 ? '0.5' : '0.3';
        _vBtn += '<button onclick="copyVeoAgentBatch(' + _vs + ',' + _vc + ',' + (_vbi+1) + ',' + _vb + ')" style="width:100%;display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-radius:8px;background:' + _vbg + ';border:1px solid rgba(124,106,247,' + _vbBord + ');color:#fff;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;margin-bottom:6px;box-sizing:border-box;"><span>\uD83D\uDCCB Batch ' + (_vbi+1) + ' \u2014 Scenes ' + (_vs+1) + '\u2013' + _ve + '</span><span style="font-size:10px;opacity:0.7;font-weight:500;">' + _vc + ' frames</span></button>';
      }
    }

    var _badge = _zb > 1 ? '<span style="font-size:10px;background:rgba(251,146,60,0.15);border:1px solid rgba(251,146,60,0.4);color:#fb923c;border-radius:4px;padding:2px 7px;font-weight:700;margin-left:6px;">\xD7' + _zb + ' batches</span>' : '';
    var _step3Label = 'Generate Veo 3 clips' + (_vR > 20 ? ' <span style="font-size:10px;color:var(--text-3);font-weight:400;">(' + _vb + ' batches)</span>' : '');
    var _noAvatar = !avatarImageDataUrl ? ' \u00B7 <span style="color:#f87171;">no avatar</span>' : '';

    var _html = '';
    _html += '<div style="background:var(--surface);border:1px solid rgba(124,106,247,0.3);border-radius:16px;width:100%;max-width:460px;box-shadow:0 24px 80px rgba(0,0,0,0.65);font-family:inherit;overflow:hidden;">';
    _html += '<div style="padding:16px 20px 12px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;">';
    _html += '<div style="display:flex;align-items:center;gap:10px;"><div style="font-size:22px;line-height:1;">\uD83E\uDD16</div><div>';
    _html += '<div style="display:flex;align-items:center;gap:6px;"><span style="font-size:14px;font-weight:800;color:var(--text-1);">Veo Agent Panel</span>' + _badge + '</div>';
    _html += '<div style="font-size:10px;color:var(--text-3);margin-top:2px;">' + _fc + ' frames \u00B7 ' + _nbR + ' NB prompts \u00B7 ' + _vR + ' Veo 3 prompts' + _noAvatar + '</div></div></div>';
    _html += '<button onclick="document.getElementById(\'veoAgentModal\').remove()" style="background:none;border:none;color:var(--text-3);font-size:18px;cursor:pointer;padding:4px 8px;border-radius:6px;">\u2715</button></div>';

    _html += '<div style="padding:16px 20px;display:flex;flex-direction:column;gap:0;">';

    // Step 1
    _html += '<div style="margin-bottom:14px;"><div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;"><div style="width:22px;height:22px;border-radius:50%;background:rgba(251,146,60,0.18);border:1px solid rgba(251,146,60,0.45);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;color:#fb923c;flex-shrink:0;">1</div><span style="font-size:12px;font-weight:700;color:var(--text-1);">Build NB Pro composites</span></div>';
    var _globalRulesBtn = '<button onclick="copyNBGlobalRules()" style="display:flex;align-items:center;justify-content:space-between;padding:9px 14px;border-radius:8px;background:rgba(251,146,60,0.18);border:2px solid rgba(251,146,60,0.65);color:#fb923c;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;width:100%;box-sizing:border-box;"><span>\uD83D\uDCC4 Copy Global Rules</span><span style="font-size:10px;opacity:0.7;font-weight:500;">paste first</span></button>';
    _html += '<div style="display:flex;flex-direction:column;gap:6px;padding-left:30px;">' + _globalRulesBtn + _zipBtn + _nbBtns + '</div></div>';

    _html += '<div style="height:1px;background:var(--border);margin:0 0 14px 30px;"></div>';

    // Step 2
    _html += '<div style="margin-bottom:14px;"><div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;"><div style="width:22px;height:22px;border-radius:50%;background:rgba(34,197,94,0.14);border:1px solid rgba(34,197,94,0.38);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;color:#4ade80;flex-shrink:0;">2</div><span style="font-size:12px;font-weight:700;color:var(--text-1);">Upload composites back</span></div>';
    _html += '<div style="padding-left:30px;"><button onclick="document.getElementById(\'nbBulkUploadInput\').click()" style="width:100%;display:flex;align-items:center;justify-content:space-between;padding:9px 14px;border-radius:8px;background:rgba(34,197,94,0.09);border:1px solid rgba(34,197,94,0.32);color:#4ade80;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;box-sizing:border-box;"><span>\uD83D\uDCE5 Bulk Upload Composites</span><span style="font-size:10px;opacity:0.6;font-weight:500;">auto-assigns in order</span></button></div></div>';
    _html += '<input type="file" id="nbBulkUploadInput" accept="image/*" multiple style="display:none;" onchange="bulkNbCompositeUpload(this.files);this.value=\'\'">';

    _html += '<div style="height:1px;background:var(--border);margin:0 0 14px 30px;"></div>';

    // Step 3
    _html += '<div><div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;"><div style="width:22px;height:22px;border-radius:50%;background:rgba(124,106,247,0.14);border:1px solid rgba(124,106,247,0.38);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;color:#a78bfa;flex-shrink:0;">3</div><span style="font-size:12px;font-weight:700;color:var(--text-1);">' + _step3Label + '</span></div>';
    _html += '<div style="padding-left:30px;">' + _vBtn + '</div></div>';

    _html += '</div>';

    // Footer
    _html += '<div style="padding:10px 20px 14px;border-top:1px solid var(--border);display:flex;gap:8px;">';
    _html += '<button onclick="openVeoAgentPanel()" style="flex:1;padding:7px;border-radius:7px;background:none;border:1px solid var(--border-2);color:var(--text-3);font-size:11px;font-weight:600;cursor:pointer;font-family:inherit;">\uD83D\uDD04 Refresh</button>';
    _html += '<button onclick="copyVeoAgentSwapPrompt()" style="flex:1;padding:7px;border-radius:7px;background:none;border:1px solid var(--border-2);color:var(--text-3);font-size:11px;cursor:pointer;font-family:inherit;" title="Generic swap fallback">Generic Swap</button>';
    _html += '</div></div>';

    var modal = document.createElement('div');
    modal.id = 'veoAgentModal';
    modal.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.72);backdrop-filter:blur(6px);padding:20px;';
    modal.innerHTML = _html;
    document.body.appendChild(modal);
    modal.addEventListener('click', function(e) { if (e.target === modal) modal.remove(); });
  }

  // ─── Shotless Generator modal ───────────────────────────────────────────────
  function openShotlessModal() {
    if (typeof window.requireAccess === 'function' && !window.requireAccess()) return;
    document.getElementById('shotlessModal')?.remove();
    const currentScript = (document.getElementById('originalScript')?.value || '').trim();
    const productSel = document.getElementById('studioProduct');
    const productName = productSel ? (productSel.options[productSel.selectedIndex]?.text || '') : '';
    const settingVal = (document.getElementById('studioSetting')?.value || '').trim();
    const estWords = currentScript.split(/\s+/).filter(Boolean).length;
    const estSegs = Math.min(8, Math.max(3, Math.round(estWords / 22)));
    const modal = document.createElement('div');
    modal.id = 'shotlessModal';
    modal.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.72);backdrop-filter:blur(6px);padding:20px;';
    modal.innerHTML = `
      <div style="background:var(--surface);border:1px solid rgba(139,92,246,0.4);border-radius:16px;padding:26px;width:100%;max-width:500px;box-shadow:0 24px 80px rgba(0,0,0,0.6);position:relative;font-family:inherit;max-height:90vh;overflow-y:auto;">
        <button onclick="document.getElementById('shotlessModal').remove()" style="position:absolute;top:14px;right:14px;background:none;border:none;color:var(--text-3);font-size:18px;cursor:pointer;padding:2px 6px;border-radius:5px;">✕</button>
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:20px;">
          <div style="width:38px;height:38px;border-radius:10px;background:rgba(139,92,246,0.15);border:1px solid rgba(139,92,246,0.3);display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0;">✨</div>
          <div>
            <div style="font-size:15px;font-weight:800;color:var(--text-1);">Shotless Generator</div>
            <div style="font-size:11px;color:var(--text-3);margin-top:1px;">No video needed — GPT invents the shots from your script</div>
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:12px;">
          <div>
            <label style="font-size:11px;font-weight:700;color:var(--text-2);display:block;margin-bottom:4px;">SCRIPT</label>
            <textarea id="shotlessScript" style="width:100%;min-height:100px;background:var(--surface-2);border:1px solid var(--border-2);border-radius:8px;padding:10px;font-size:12px;color:var(--text-1);font-family:inherit;resize:vertical;box-sizing:border-box;" placeholder="Paste your full script here…">${escHtml(currentScript)}</textarea>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
            <div>
              <label style="font-size:11px;font-weight:700;color:var(--text-2);display:block;margin-bottom:4px;">PRODUCT NAME</label>
              <input id="shotlessProduct" type="text" value="${escHtml(productName)}" style="width:100%;background:var(--surface-2);border:1px solid var(--border-2);border-radius:8px;padding:8px 10px;font-size:12px;color:var(--text-1);font-family:inherit;box-sizing:border-box;" placeholder="e.g. Glow Mask">
            </div>
            <div>
              <label style="font-size:11px;font-weight:700;color:var(--text-2);display:block;margin-bottom:4px;">NUMBER OF SCENES</label>
              <input id="shotlessCount" type="number" min="2" max="10" value="${estSegs}" style="width:100%;background:var(--surface-2);border:1px solid var(--border-2);border-radius:8px;padding:8px 10px;font-size:12px;color:var(--text-1);font-family:inherit;box-sizing:border-box;">
            </div>
          </div>
          <div>
            <label style="font-size:11px;font-weight:700;color:var(--text-2);display:block;margin-bottom:4px;">SETTING / VIBE <span style="font-weight:400;opacity:0.6;">(optional — e.g. "modern kitchen, marble counters")</span></label>
            <input id="shotlessSetting" type="text" value="${escHtml(settingVal)}" style="width:100%;background:var(--surface-2);border:1px solid var(--border-2);border-radius:8px;padding:8px 10px;font-size:12px;color:var(--text-1);font-family:inherit;box-sizing:border-box;" placeholder="Leave blank to use avatar background">
          </div>
          <div style="background:rgba(139,92,246,0.07);border:1px solid rgba(139,92,246,0.2);border-radius:8px;padding:10px 12px;font-size:11px;color:var(--text-3);line-height:1.8;">
            <div style="font-weight:700;color:var(--text-2);margin-bottom:3px;">How it works:</div>
            <div>① GPT reads your script and invents ${estSegs} demonstration scenes</div>
            <div>② NB Pro prompts are auto-generated for each scene (no reference frame needed)</div>
            <div>③ Run NB Pro → upload composites → Veo 3 prompts auto-build</div>
          </div>
          <button id="shotlessGenBtn" onclick="generateShotlessSegments()" style="width:100%;padding:13px;border-radius:10px;background:var(--grad-accent);border:none;color:#fff;font-size:14px;font-weight:800;cursor:pointer;font-family:inherit;box-shadow:0 4px 16px rgba(124,106,247,0.3);"
            onmouseenter="this.style.boxShadow='0 4px 24px rgba(124,106,247,0.5)'" onmouseleave="this.style.boxShadow='0 4px 16px rgba(124,106,247,0.3)'">
            ✨ Generate Shot List
          </button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  }

  // --- Spatial layout analysis: runs GPT-4o-mini Vision on a captured frame ---
  // Fires automatically after Detect Cuts. Stores object positions in seg.sceneLayout
  // which gets injected into the Veo 3 prompt's background field.
  async function analyzeFrameSpatialLayout(segIdx) {
    var seg = segments[segIdx];
    if (!seg || !seg.frameDataUrl || seg.sceneLayout) return; // skip if no frame or already done
    if (window.location.protocol === 'file:') return; // no proxy in local dev
    // Compress frame to ≤512px before sending
    var sendUrl = seg.frameDataUrl;
    try {
      sendUrl = await new Promise(function(resolve, reject) {
        var img = new Image();
        img.onload = function() {
          var MAX = 512, w = img.naturalWidth || 512, h = img.naturalHeight || 512;
          if (w > MAX || h > MAX) { if (w > h) { h = Math.round(h * MAX / w); w = MAX; } else { w = Math.round(w * MAX / h); h = MAX; } }
          var c = document.createElement('canvas'); c.width = w; c.height = h;
          c.getContext('2d').drawImage(img, 0, 0, w, h);
          resolve(c.toDataURL('image/jpeg', 0.75));
        };
        img.onerror = reject;
        img.src = seg.frameDataUrl;
      });
    } catch(_) { /* use original */ }

    try {
      var _ak = getApiKey();
      var res = await fetch('/.netlify/functions/openai-chat', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, _ak && _ak !== '__proxy__' ? { 'X-Api-Key': _ak } : {}),
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          max_tokens: 120,
          messages: [{ role: 'user', content: [
            { type: 'text', text: 'List the visible background objects and surfaces in this frame with their spatial positions. Format: "[object]: [position]". Use positions like lower-left, lower-center, lower-right, mid-left, mid-center, mid-right, upper-left, upper-center, upper-right, foreground, background. Focus on props, surfaces, and environmental elements behind the person. Under 80 words. No intro.' },
            { type: 'image_url', image_url: { url: sendUrl, detail: 'low' } }
          ]}]
        })
      });
      var data; try { data = await res.json(); } catch(_) { data = {}; }
      if (!res.ok || data.error) return;
      var text = ((data.choices || [])[0] || {}).message ? (data.choices[0].message.content || '').trim() : '';
      if (!text || /i('m| am) sorry|can'?t (assist|help)|cannot (assist|help)/i.test(text)) return;
      // Guard: segment may have been replaced while awaiting
      if (segments[segIdx] !== seg) return;
      seg.sceneLayout = text;
      debounceSave();
    } catch(_) { /* non-fatal */ }
  }

  // Fire spatial layout analysis for all segments that have frames but no layout yet
  function _runSpatialLayoutBatch() {
    segments.forEach(function(seg, i) {
      if (seg.frameDataUrl && !seg.sceneLayout) {
        analyzeFrameSpatialLayout(i).catch(function() {});
      }
    });
  }

  // --- Click-to-target pin: click on thumbnail to mark which person to swap ---
  function setTargetPin(i, e) {
    const img = e.currentTarget;
    const rect = img.getBoundingClientRect();
    const xPct = Math.round(((e.clientX - rect.left) / rect.width) * 100);
    const yPct = Math.round(((e.clientY - rect.top) / rect.height) * 100);
    segments[i].targetX = xPct;
    segments[i].targetY = yPct;
    const newSide = xPct < 50 ? 'left' : 'right';
    const otherSide = newSide === 'left' ? 'right' : 'left';
    segments[i].targetPerson = newSide;
    // If scene notes contain the auto-generated two-person text, update it to match the new pin
    // so it doesn't conflict with (and override) the pin coordinates in the NB prompt
    const existingNotes = (segments[i].sceneNotes || '').trim();
    if (existingNotes && /avatar replaces this person/i.test(existingNotes)) {
      const gender = segments[i].targetGender || 'person';
      const otherGender = gender === 'woman' ? 'man' : gender === 'man' ? 'woman' : 'person';
      const newNotes = 'two people: ' + gender + ' on ' + newSide.toUpperCase() + ' (avatar replaces this person) \u00B7 ' + otherGender + ' on ' + otherSide.toUpperCase() + ' (keep unchanged)';
      segments[i].sceneNotes = newNotes;
      // Update the textarea live
      const notesEl = document.getElementById('notes-seg-' + i);
      if (notesEl) { notesEl.value = newNotes; autoGrow(notesEl); notesEl.style.borderColor = 'rgba(96,165,250,0.7)'; setTimeout(() => { if (notesEl) notesEl.style.borderColor = ''; }, 1500); }
    }
    debounceSave();
    renderSegments();
  }

  function clearTargetPin(i) {
    segments[i].targetX = null;
    segments[i].targetY = null;
    segments[i].targetPerson = null;
    segments[i].targetGender = null;
    debounceSave();
    renderSegments();
  }

  function setTargetGender(i, gender) {
    // Toggle: clicking the same gender again clears it
    segments[i].targetGender = segments[i].targetGender === gender ? null : gender;
    debounceSave();
    renderSegments();
  }

  // --- Remove a single segment ---
  function removeSegment(i) {
    showConfirm(`Remove Segment ${i + 1}?`, () => {
      pushUndo(`Remove Seg ${i + 1}`);
      segments.splice(i, 1);
      saveSegments();
      renderSegments();
    });
  }

  // --- Merge two adjacent segments (i and i+1) into one ---
  function mergeSegments(i, j) {
    if (i < 0 || j >= segments.length || j !== i + 1) return;
    pushUndo(`Merge Seg ${i + 1}+${j + 1}`);

    const setting     = document.getElementById('studioSetting')?.value.trim() || '';
    const productSel  = document.getElementById('studioProduct');
    const productName = productSel ? (productSel.options[productSel.selectedIndex]?.text || 'the product') : 'the product';

    const mergedEndTime = segments[j].endTime;
    segments[i].endTime = mergedEndTime;

    // Combine scripts
    const mergedScript = [segments[i].script, segments[j].script].filter(Boolean).join(' ').trim();
    segments[i].script = mergedScript;

    // Re-derive action from the full combined script (length-1 = correct post-splice last index)
    segments[i].action = deriveSceneAction(mergedScript, i, segments.length - 1);

    // Rebuild Veo 3 prompt for the merged segment
    segments[i].veoPrompt = buildSegmentVeo3Prompt(
      i,
      segments[i].startTime,
      mergedEndTime,
      mergedScript,
      setting,
      productName,
      bgImageDataUrl
    );

    // Keep first segment's frame + NB prompt (frame stays at original start)
    segments.splice(j, 1);
    renderSegments();
    saveSegments();
    showToast('✅ Segments merged — action & Veo 3 prompt updated.', 'success');
  }

  // --- Auto-merge all segments whose script is fewer than N words ---
  function autoMergeShortSegments() {
    pushUndo('Auto-Merge Short Segs');
    const MIN_WORDS = 4;
    let merged = 0;
    let i = 0;
    while (i < segments.length) {
      const words = (segments[i].script || '').trim().split(/\s+/).filter(Boolean).length;
      if (words > 0 && words < MIN_WORDS) {
        if (i > 0) {
          // Pull short segment backward into previous
          segments[i - 1].endTime = segments[i].endTime;
          segments[i - 1].script = [segments[i - 1].script, segments[i].script].filter(Boolean).join(' ').trim();
          segments[i - 1].action = [segments[i - 1].action, segments[i].action].filter(Boolean).join(' ').trim();
          segments[i - 1].action = deriveSceneAction(segments[i - 1].script, i - 1, segments.length - 1);
          segments[i - 1].veoPrompt = '';  // Clear stale prompt — will regen on next Process Everything
          segments[i - 1].nbPrompt = '';   // Clear stale NB prompt
          segments.splice(i, 1);
          i--; // Re-check i-1: merged result may itself be short
          merged++;
        } else if (segments.length > 1) {
          // First segment is short — push it forward into next
          segments[1].startTime = segments[0].startTime;
          segments[1].frameDataUrl = segments[0].frameDataUrl || segments[1].frameDataUrl;
          segments[1].script = [segments[0].script, segments[1].script].filter(Boolean).join(' ').trim();
          segments[1].action = [segments[0].action, segments[1].action].filter(Boolean).join(' ').trim();
          segments[1].action = deriveSceneAction(segments[1].script, 0, segments.length - 1);
          segments[1].veoPrompt = '';
          segments[1].nbPrompt = '';
          segments.splice(0, 1);
          merged++;
          if (segments.length === 1) i++; // guard: prevents infinite loop if merged result stays short
        } else {
          i++;
        }
      } else {
        i++;
      }
    }
    if (merged > 0) {
      renderSegments();
      saveSegments();
      showToast(`Auto-merged ${merged} short segment${merged !== 1 ? 's' : ''}. Run ⚡ Generate Prompts to refresh.`, 'success');
    } else {
      showToast('No short segments found (all have ≥ 4 words).', 'info');
    }
  }

  // --- Split script at sentence boundaries, proportional to segment durations ---
  function splitScriptIntoSegments(fullScript, segs) {
    const n = segs.length;
    if (!fullScript || n === 0) return Array(n).fill('');
    if (n === 1) return [fullScript.trim()];

    // Extract sentences (keep punctuation attached)
    const raw = fullScript.trim();
    let sentences = raw.match(/[^.!?…]+[.!?…]*["']?\s*/g) || [];
    sentences = sentences.map(s => s.trim()).filter(Boolean);

    // If no sentences found (no punctuation), fall back to even word split
    if (sentences.length <= 1) {
      const words = raw.split(/\s+/);
      const perSeg = Math.ceil(words.length / n);
      return Array.from({ length: n }, (_, i) => words.slice(i * perSeg, (i + 1) * perSeg).join(' '));
    }

    // Total duration and total word count for proportional targeting
    const totalDur = Math.max(1, segs[n - 1].endTime - segs[0].startTime);
    const totalWords = raw.split(/\s+/).length;

    const result = Array(n).fill('');
    let sentIdx = 0;

    for (let i = 0; i < n - 1; i++) {
      const segDur = segs[i].endTime - segs[i].startTime;
      const targetWords = Math.round((segDur / totalDur) * totalWords);
      const bucket = [];
      let wordCount = 0;

      while (sentIdx < sentences.length) {
        const sw = sentences[sentIdx].split(/\s+/).length;
        // Always take at least one sentence; keep adding while under target
        if (bucket.length === 0 || wordCount + sw <= targetWords) {
          bucket.push(sentences[sentIdx]);
          wordCount += sw;
          sentIdx++;
          if (wordCount >= targetWords) break;
        } else {
          break;
        }
      }
      result[i] = bucket.join(' ');
    }

    // Last segment gets all remaining sentences
    result[n - 1] = sentences.slice(sentIdx).join(' ');
    return result;
  }

  // Round a time value to nearest 0.1s to absorb floating-point jitter
  const r1 = t => Math.round(t * 10) / 10;

  // Find which segment index owns a given timestamp (0.1s precision, 0.05s tolerance)
  function segmentForTime(t) {
    const tr = r1(t);
    for (let i = 0; i < segments.length; i++) {
      if (tr >= r1(segments[i].startTime) - 0.05 && tr < r1(segments[i].endTime) + 0.05) {
        return i;
      }
    }
    // Fallback: nearest segment by start-time distance
    let best = 0, minDist = Infinity;
    segments.forEach((seg, i) => {
      const d = Math.abs(tr - r1(seg.startTime));
      if (d < minDist) { minDist = d; best = i; }
    });
    return best;
  }

  // Assign each Whisper chunk atomically to the segment where the chunk STARTS.
  // Keeping chunks together prevents mid-phrase splits (e.g. "grab a few chunks of"
  // in seg 2 and "watermelon" in seg 3 when it's one continuous spoken phrase).
  // For very long chunks (> 6 words AND spanning > 1 segment worth of time), we
  // split at the midpoint so a single long chunk can't overwhelm a short segment.
  function distributeScriptFromTimestamps() {
    if ((!whisperSegments || whisperSegments.length === 0) && (!whisperWords || whisperWords.length === 0)) return false;

    // ── Build flat word timeline ──────────────────────────────────────────────
    // PREFERRED: use Whisper's per-word timestamps (exact, no guessing).
    // FALLBACK:  linearly interpolate within phrase chunks (less accurate).
    let wordTimeline = [];

    if (whisperWords && whisperWords.length > 0) {
      // Use midpoint of each word's time window as its representative timestamp
      wordTimeline = whisperWords.map(w => ({
        word: w.word,
        time: (w.start + w.end) / 2
      }));
    } else {
      // Legacy: estimate per-word times linearly within each phrase chunk
      whisperSegments.forEach(ws => {
        const chunkWords = ws.text.trim().split(/\s+/).filter(Boolean);
        if (!chunkWords.length) return;
        const secPerWord = Math.max(0.1, ws.end - ws.start) / chunkWords.length;
        chunkWords.forEach((word, wi) => {
          wordTimeline.push({ word, time: ws.start + wi * secPerWord });
        });
      });
    }

    if (!wordTimeline.length) return false;

    const buckets = segments.map(() => []);
    let cursor = 0;

    for (let si = 0; si < segments.length; si++) {
      const isLast = si === segments.length - 1;
      if (isLast) {
        // Last segment gets everything remaining
        while (cursor < wordTimeline.length) buckets[si].push(wordTimeline[cursor++].word);
        break;
      }

      const segEnd = r1(segments[si].endTime);

      // Find the first word whose estimated time reaches the scene cut
      let naturalEnd = cursor;
      while (naturalEnd < wordTimeline.length - 1 && wordTimeline[naturalEnd].time < segEnd) {
        naturalEnd++;
      }

      // If no words fall in this segment's time window (e.g. a Whisper chunk starts
      // exactly at the boundary), use a proportional word count as a floor so the
      // bucket never starts empty.  This is the root cause of "watermelon" landing
      // in Seg 3: its chunk starts at 8.0 s = Seg 3 boundary, so naturalEnd never
      // advances and splitAfter becomes cursor-1, leaving Seg 2 with nothing.
      let splitAfter;
      if (naturalEnd === cursor) {
        const totalWords   = wordTimeline.length;
        const totalDur     = r1(segments[segments.length - 1].endTime) - r1(segments[0].startTime);
        const segDur       = segEnd - r1(segments[si].startTime);
        const targetWords  = Math.max(1, Math.round(totalWords * segDur / totalDur));
        splitAfter = Math.min(cursor + targetWords - 1, wordTimeline.length - 2);
      } else {
        splitAfter = naturalEnd - 1;
      }

      // Snap to the nearest sentence boundary (. ! ? ,) within ±8 words of
      // splitAfter.  We use word-index proximity, NOT time distance, so that
      // phrases like "grab a few chunks of watermelon," are always kept whole
      // even when Whisper places the chunk start exactly at the segment boundary
      // (making its per-word timestamps far from segEnd in seconds).
      const lookFrom = Math.max(cursor, splitAfter - 8);
      const lookTo   = Math.min(wordTimeline.length - 2, splitAfter + 8);
      let bestBoundary = -1;
      let bestWordDist = Infinity;

      for (let wi = lookFrom; wi <= lookTo; wi++) {
        if (/[.!?,]$/.test(wordTimeline[wi].word)) {
          const wdist = Math.abs(wi - splitAfter);
          if (wdist < bestWordDist) {
            bestWordDist = wdist;
            bestBoundary = wi;
          }
        }
      }
      if (bestBoundary >= cursor) splitAfter = bestBoundary;

      // Push words up to and including splitAfter into this segment's bucket
      while (cursor <= splitAfter && cursor < wordTimeline.length) {
        buckets[si].push(wordTimeline[cursor++].word);
      }
    }

    // If any bucket is still empty, bridge from nearest non-empty neighbour
    buckets.forEach((bucket, i) => {
      if (bucket.length > 0) return;
      for (let d = 1; d < buckets.length; d++) {
        if (i - d >= 0 && buckets[i - d].length > 1) {
          bucket.push(buckets[i - d].pop()); break;
        }
        if (i + d < buckets.length && buckets[i + d].length > 1) {
          bucket.push(buckets[i + d].shift()); break;
        }
      }
    });

    // Still empty after bridging? Fall back to proportional
    if (buckets.some(b => b.length === 0)) return false;

    buckets.forEach((words, i) => {
      segments[i].script = words.join(' ').trim();
    });
    return true;
  }

  function distributeScript() {
    // ── 1. Whisper timestamps — most accurate, use if available ──────────────
    if (whisperSegments && whisperSegments.length > 0) {
      if (distributeScriptFromTimestamps()) return;
    }

    // ── Skip if every segment already has a script — preserves manual edits ──
    if (segments.length > 0 && segments.every(s => (s.script || '').trim())) return;

    // ── 2. Time-proportional word slice — driven by VIDEO scene boundaries ───
    // Split points come from the video segment start/end times, NOT from
    // punctuation or line breaks. A new unit is only created where there is
    // an actual scene change in the video. If no Whisper timing is available,
    // we estimate speaking position by assuming uniform speaking rate.
    const originalEl = document.getElementById('originalScript');
    const script = originalEl ? originalEl.value.trim() : '';
    if (!script || segments.length === 0) return;

    const words = script.split(/\s+/).filter(Boolean);
    if (words.length === 0) return;

    // Single segment — give it everything
    if (segments.length === 1) { segments[0].script = script; return; }

    const totalDur = (segments[segments.length - 1].endTime - segments[0].startTime) || 1;
    const startOffset = segments[0].startTime;
    const wordsPerSec = words.length / totalDur;

    // Calculate the target word-end index for each segment boundary based on time
    let wordIdx = 0;
    for (let i = 0; i < segments.length; i++) {
      const isLast = i === segments.length - 1;

      if (isLast) {
        // Last segment always gets everything remaining
        segments[i].script = words.slice(wordIdx).join(' ');
        break;
      }

      const segDur = segments[i].endTime - segments[i].startTime;

      // How many words should this segment cover based on its duration?
      const rawTarget = Math.round(segDur * wordsPerSec);
      let endIdx = Math.min(wordIdx + Math.max(1, rawTarget) - 1, words.length - 2);

      // Segments shorter than 7s: cut exactly at the word count — the scene
      // change is the only split criterion, no sentence completion attempted.
      // Segments 7s or longer: the same start frame covers the whole scene,
      // so look ahead up to ~4 words to land on a complete-word boundary
      // that ends a natural phrase (word ending with .!?, or a comma).
      if (segDur >= 7) {
        const lookAhead = Math.min(endIdx + 4, words.length - 2);
        for (let j = endIdx; j <= lookAhead; j++) {
          if (/[.!?,]$/.test(words[j])) { endIdx = j; break; }
        }
      }

      segments[i].script = words.slice(wordIdx, endIdx + 1).join(' ');
      wordIdx = endIdx + 1;
    }
  }

  // --- Auto-grow a textarea to fit its content ---
  function autoGrow(el) {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 300) + 'px';
  }

  // --- Shared debounced save ---
  function debounceSave() {
    clearTimeout(window._segSaveTimer);
    window._segSaveTimer = setTimeout(saveSegments, 800);
  }

  // --- Prompt textarea CSS (inlined so it applies inside innerHTML) ---
  const PROMPT_TA_STYLE = ``;   // styles now live in .seg-ta-base + .seg-ta-prompt
  const ACTION_TA_STYLE = ``;   // styles now live in .seg-ta-base + .seg-ta-action

  // --- Render segment cards ---
  // --- Segment script health badge: word count + estimated speech duration ---
  // Veo 3 clips max out at 8s, so a script that takes much longer than that
  // won't fit one clip. Green = fits, yellow = slightly long, red = won't fit
  // (or too short to be a real scene).
  function scriptHealth(seg) {
    const _WPS = 2.3; // words per second — keep in sync with module-level WORDS_PER_SEC
    const wc = (seg && seg.script || '').trim().split(/\s+/).filter(Boolean).length;
    const estSec = wc / _WPS;
    let color, level, title;
    if (wc === 0) {
      color = 'var(--text-3)'; level = 'empty'; title = 'No script yet';
    } else if (wc < 5) {
      color = '#f87171'; level = 'short'; title = 'Too short — try 5+ words';
    } else if (estSec <= 8.5) {
      color = '#4ade80'; level = 'ok';   title = 'Fits comfortably in one 8s Veo clip';
    } else if (estSec <= 11) {
      color = '#fbbf24'; level = 'long'; title = 'Slightly long — may run past 8s, consider trimming';
    } else {
      color = '#f87171'; level = 'over'; title = 'Too long for one 8s Veo clip — split this scene';
    }
    return { wc, estSec, color, level, title };
  }

  function scriptBadgeHtml(seg) {
    const h = scriptHealth(seg);
    if (h.wc === 0) return '';
    const warn = (h.level === 'short' || h.level === 'over') ? ' ⚠'
               : (h.level === 'long' ? ' ⚠' : '');
    return `<span style="font-weight:400;color:${h.color};" title="${h.title}"> ${h.wc}w · ~${h.estSec.toFixed(1)}s${warn}</span>`;
  }

  // --- Veo 3 prompt JSON safety lint ---
  // Confirms the prompt is valid JSON, has a non-empty speech field (standing
  // rule: every Veo prompt must carry the full segment script in `speech`),
  // and has a non-empty action field.
  function lintVeoJSON(str) {
    if (!str || !str.trim()) return { ok: false, errors: ['no prompt generated yet'] };
    let obj;
    try { obj = JSON.parse(str); }
    catch (e) { return { ok: false, errors: ['invalid JSON — ' + e.message] }; }
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
      return { ok: false, errors: ['not a JSON object'] };
    }
    const errors = [];
    if (!obj.speech || !String(obj.speech).trim()) errors.push('speech field is empty');
    if (!obj.action || !String(obj.action).trim()) errors.push('action field is empty');
    // Warn if "multiple people" is in negative_prompt but scene describes two people
    const negP = String(obj.negative_prompt || '').toLowerCase();
    const combined = (obj.action || '') + ' ' + (obj.speech || '');
    if (negP.includes('multiple people') && detectsTwoPeople(combined)) {
      errors.push('"multiple people" in negative_prompt will flip or drop one person — Regen to fix');
    }
    return { ok: errors.length === 0, errors };
  }

  function veoLintBadgeHtml(seg) {
    if (!seg || !(seg.veoPrompt || '').trim()) return '';
    const r = lintVeoJSON(seg.veoPrompt);
    if (r.ok) {
      return `<span style="font-size:9px;font-weight:700;color:#4ade80;" title="Valid JSON · speech + action present">✓ JSON</span>`;
    }
    return `<span style="font-size:9px;font-weight:700;color:#f87171;cursor:help;" title="${escHtml(r.errors.join(' · '))}">⚠ JSON</span>`;
  }

  // --- Proportional timeline strip above the segment list ---
  function renderSegmentTimeline() {
    const strip = document.getElementById('segmentTimeline');
    if (!strip) return;
    if (!segments.length) { strip.style.display = 'none'; strip.innerHTML = ''; return; }
    strip.style.display = 'block';
    const fmt = t => { const m = Math.floor(t/60); const s = Math.floor(t%60); return m+':'+(s<10?'0':'')+s; };
    const blocks = segments.map((seg, i) => {
      const len = Math.max(0.1, (seg.endTime || 0) - (seg.startTime || 0));
      const h = scriptHealth(seg);
      const bg = h.level === 'ok' ? 'rgba(74,222,128,0.35)'
               : h.level === 'long' ? 'rgba(251,191,36,0.4)'
               : (h.level === 'short' || h.level === 'over') ? 'rgba(248,113,113,0.4)'
               : 'rgba(255,255,255,0.12)';
      const bd = h.level === 'ok' ? '#4ade80'
               : h.level === 'long' ? '#fbbf24'
               : (h.level === 'short' || h.level === 'over') ? '#f87171'
               : 'var(--border-2)';
      const tip = `Seg ${i+1} · ${fmt(seg.startTime||0)}–${fmt(seg.endTime||0)} · ${h.wc}w ~${h.estSec.toFixed(1)}s` + (h.level==='over'?' · too long':h.level==='long'?' · slightly long':h.level==='short'?' · too short':'');
      return `<div onclick="(function(){var c=document.getElementById('seg-card-${i}');if(c)c.scrollIntoView({behavior:'smooth',block:'center'});})()"
        title="${escHtml(tip)}"
        style="flex:${len.toFixed(2)};min-width:24px;height:18px;background:${bg};border:1px solid ${bd};border-radius:2px;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:7px;font-weight:700;color:var(--text-1);overflow:hidden;white-space:nowrap;padding:0 2px;">Sc ${i+1}</div>`;
    }).join('');
    strip.innerHTML = `<div style="display:flex;gap:2px;align-items:center;">${blocks}</div>`;
  }

  function renderSegments() {
    const container = document.getElementById('segmentsContainer');
    const countEl = document.getElementById('segmentCount');
    if (!container) return;
    renderSegmentTimeline();
    if (countEl) countEl.textContent = segments.length + ' segment' + (segments.length !== 1 ? 's' : '');
    if (segments.length === 0) {
      // No segments — show toggle btn only if video is loaded, but keep expanded
      const hasVideo = !!document.getElementById('refVideoEl')?.src;
      showVideoMiniBtn(hasVideo);
      const emptyMsg = studioMode === 'producer'
        ? 'Paste your script and click <strong style="color:var(--text-2);">✂ Split into Scenes</strong> to create segments.'
        : 'Upload a video and detect cuts to get started.';
      container.innerHTML = `<div id="segmentsEmpty" style="text-align:center;padding:24px;font-size:11px;color:var(--text-3);">${emptyMsg}</div>`;
      const saveAllBtn = document.getElementById('saveAllBtn');
      if (saveAllBtn) saveAllBtn.style.display = 'none';
      return;
    }
    // Segments exist — show toggle button and auto-collapse player if not already mini
    showVideoMiniBtn(true);
    const panel = document.getElementById('vsPanelRefVideo');
    if (panel && !panel.classList.contains('video-collapsed')) {
      setVideoMini(true);
    }
    const fmt = t => { const m = Math.floor(t/60); const s = Math.floor(t%60); return m+':'+(s<10?'0':'')+s; };
    container.style.cssText = 'flex:1;overflow-x:auto;overflow-y:auto;padding:10px;display:flex;flex-direction:row;align-items:flex-start;gap:12px;';
    container.innerHTML = segments.map((seg, i) => `
      <div id="seg-card-${i}"
        style="display:flex;flex-direction:column;gap:7px;width:330px;flex-shrink:0;border:1px solid ${seg.done ? 'rgba(34,197,94,0.45)' : 'var(--glass-border)'};border-radius:10px;padding:10px;background:${seg.done ? 'rgba(34,197,94,0.06)' : 'var(--glass-2)'};backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);position:relative;box-shadow:var(--shadow-card);transition:border-color 0.16s,box-shadow 0.16s;">

        <!-- Card header: seg# + time badge + done badge + remove -->
        <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
          <span style="font-size:12px;font-weight:800;color:${seg.done ? '#4ade80' : 'var(--accent-2)'};letter-spacing:-0.3px;">Seg ${i+1}</span>
          ${seg.isCTA ? `<span style="font-size:9px;font-weight:700;padding:1px 7px;border-radius:4px;background:rgba(251,191,36,0.15);border:1px solid rgba(251,191,36,0.3);color:#fbbf24;letter-spacing:0.04em;">🛍 CTA</span>` : `<span style="font-size:10px;color:var(--text-3);font-family:monospace;background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:2px 7px;letter-spacing:0.3px;">${fmt(seg.startTime)} – ${fmt(seg.endTime)}</span>`}
          ${seg.done ? `<span class="scene-done-badge" style="font-size:9px;font-weight:700;color:#4ade80;background:rgba(34,197,94,0.15);border:1px solid rgba(34,197,94,0.4);border-radius:4px;padding:1px 7px;">✅ DONE</span>` : `<span class="scene-done-badge" style="display:none;font-size:9px;font-weight:700;color:#4ade80;background:rgba(34,197,94,0.15);border:1px solid rgba(34,197,94,0.4);border-radius:4px;padding:1px 7px;">✅ DONE</span>`}
          <span style="margin-left:auto;"></span>
          ${(typeof productImageDataUrl !== 'undefined' && productImageDataUrl && !seg.isCTA) ? `<button onclick="toggleSegmentProduct(${i})" title="${seg.showProduct ? 'Product ON — click to remove' : 'Product OFF — click to include'}" style="width:22px;height:22px;padding:0;border-radius:4px;border:1px solid ${seg.showProduct ? 'rgba(251,146,60,0.75)' : 'rgba(255,255,255,0.12)'};background:transparent;cursor:pointer;overflow:hidden;opacity:${seg.showProduct ? '1' : '0.28'};flex-shrink:0;box-shadow:${seg.showProduct ? '0 0 6px rgba(251,146,60,0.4)' : 'none'};transition:opacity 0.15s,border-color 0.15s;"><img src="${productImageDataUrl}" style="width:100%;height:100%;object-fit:cover;display:block;border-radius:3px;"></button>` : ''}
          <button class="dup-btn" onclick="duplicateSegment(${i})" title="Duplicate this segment — copies frame, action, prompts" style="background:rgba(124,106,247,0.07);border:1px solid rgba(124,106,247,0.2);border-radius:4px;color:var(--accent-2);font-size:10px;padding:2px 8px;cursor:pointer;flex-shrink:0;">⧉ Split</button>
          <button class="seg-pin-btn" onclick="(function(b){var c=b.closest('[id^=seg-card-]');if(!c)return;var open=c.getAttribute('data-open')==='1';c.setAttribute('data-open',open?'0':'1');b.textContent=open?'···':'pin';b.title=open?'Expand to edit':'Collapse card';}).call(this,this)" title="Expand to edit">···</button>
          <button onclick="removeSegment(${i})" style="background:rgba(248,113,113,0.07);border:1px solid rgba(248,113,113,0.2);border-radius:4px;color:var(--danger);font-size:10px;padding:2px 8px;cursor:pointer;flex-shrink:0;">✕</button>
        </div>

        <!-- Thumbnail (replicator) or visual desc (producer) -->
        ${seg._scriptOnly ? `
        <div style="display:flex;flex-direction:column;gap:5px;">
          <!-- Visual Description -->
          <div class="seg-field-visual">
            <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;color:var(--warning);margin-bottom:3px;">🎨 Visual Description</div>
            <textarea id="framedesc-seg-${i}"
              oninput="segments[${i}].frameDesc=this.value;autoGrow(this);debounceSave()"
              class="seg-ta-base seg-ta-visual"
              placeholder="Describe the frame — location, lighting, background, mood, clothing, camera angle…"
            >${escHtml(seg.frameDesc || '')}</textarea>
          </div>
        </div>
        ` : `
        <div>
          ${seg.frameDataUrl ? `
          <!-- Click-to-target thumbnail: click directly on the person to pin them -->
          <div style="position:relative;display:block;">
            <img src="${seg.frameDataUrl}" class="seg-frame-img"
              style="cursor:${seg.isCTA ? 'default' : 'crosshair'};"
              ${seg.isCTA ? '' : `onclick="setTargetPin(${i}, event)"`}
              title="${seg.isCTA ? 'Product photo' : 'Click on a person to mark them as the NB swap target'}">
            ${seg.targetX != null ? `<div style="position:absolute;left:${seg.targetX}%;top:${seg.targetY != null ? seg.targetY : 50}%;transform:translate(-50%,-50%);pointer-events:none;z-index:3;width:15px;height:15px;border-radius:50%;background:rgba(96,165,250,0.92);border:2.5px solid #fff;box-shadow:0 0 0 2px rgba(96,165,250,0.5),0 1px 8px rgba(0,0,0,0.7);"></div>` : ''}
          </div>
          ${seg.isCTA ? '' : `<div style="display:flex;gap:3px;margin-top:4px;align-items:center;">
            <button onclick="downloadFrame(${i})" class="seg-dl-btn" style="flex:1;margin-top:0;">⬇ Frame</button>
            <button onclick="openLightbox(segments[${i}].frameDataUrl)" title="View full frame" style="font-size:9px;padding:2px 7px;border-radius:3px;background:rgba(255,255,255,0.04);border:1px solid var(--border);color:var(--text-3);cursor:pointer;">🔍</button>
            ${seg.targetX != null
              ? `<button onclick="clearTargetPin(${i})" title="Clear target pin" style="font-size:9px;padding:2px 6px;border-radius:3px;background:rgba(248,113,113,0.07);border:1px solid rgba(248,113,113,0.25);color:var(--danger);cursor:pointer;">✕ Pin</button>`
              : `<span style="font-size:8px;color:var(--text-3);opacity:0.45;padding:2px 3px;white-space:nowrap;line-height:1.2;">click to<br>target</span>`}
          </div>
          ${seg.targetX != null ? `
          <div style="display:flex;gap:3px;margin-top:3px;align-items:center;">
            <span style="font-size:8px;color:var(--text-3);opacity:0.6;flex-shrink:0;">Gender:</span>
            <button onclick="setTargetGender(${i},'woman')" title="Target is a woman" style="font-size:9px;padding:2px 7px;border-radius:3px;cursor:pointer;border:1px solid ${seg.targetGender==='woman'?'rgba(244,114,182,0.6)':'rgba(255,255,255,0.1)'};background:${seg.targetGender==='woman'?'rgba(244,114,182,0.12)':'transparent'};color:${seg.targetGender==='woman'?'#f472b6':'var(--text-3)'};">👩 Woman</button>
            <button onclick="setTargetGender(${i},'man')" title="Target is a man" style="font-size:9px;padding:2px 7px;border-radius:3px;cursor:pointer;border:1px solid ${seg.targetGender==='man'?'rgba(96,165,250,0.6)':'rgba(255,255,255,0.1)'};background:${seg.targetGender==='man'?'rgba(96,165,250,0.12)':'transparent'};color:${seg.targetGender==='man'?'#60a5fa':'var(--text-3)'};">👨 Man</button>
          </div>` : ''}`}` : ('<div class="seg-empty-frame" style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;padding:8px;min-height:60px;">' + (seg._shotlessData ? '<span style="font-size:9px;font-weight:700;color:rgba(139,92,246,0.8);letter-spacing:0.5px;text-transform:uppercase;">✨ Shotless</span><span style="font-size:9px;color:var(--text-3);text-align:center;line-height:1.4;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;">' + escHtml(seg._shotlessData.scene_description || seg.action || '') + '</span>' : '<span style="font-size:28px;opacity:0.22;">🎞</span>') + '</div>')}
        </div>
        `}

        <!-- Script -->
        <div class="seg-field-script">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px;">
            <span style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;color:var(--text-3);">Script ${scriptBadgeHtml(seg)}</span>
            <button id="rewrite-seg-btn-${i}" onclick="rewriteSegmentScript(${i})" title="AI rewrite this scene to fit within 8s" style="background:none;border:1px solid rgba(96,165,250,0.3);border-radius:3px;color:#60a5fa;font-size:9px;padding:1px 6px;cursor:pointer;white-space:nowrap;">↺ Rewrite</button>
          </div>
          <textarea id="script-seg-${i}"
            oninput="segments[${i}].script=this.value;autoGrow(this);debounceSave()"
            class="seg-ta-base seg-ta-script"
            placeholder="Script for this scene…"
          >${escHtml(seg.script || '')}</textarea>
        </div>

        <!-- Scene Action (collapsed by default) -->
        <div class="seg-field-action">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px;cursor:pointer;" onclick="(function(){var ta=document.getElementById('action-wrap-${i}');var open=ta.style.display!=='none';ta.style.display=open?'none':'';this.querySelector('.action-toggle').textContent=open?'▸ Show':'▾ Hide';}).call(this)">
            <span class="seg-action-label" style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;">🎬 Action</span>
            <div style="display:flex;gap:4px;align-items:center;">
              <button id="regen-action-btn-${i}" onclick="event.stopPropagation();refreshSegmentAction(${i})" title="Re-analyze frames with GPT-4o to rewrite the scene action" style="background:rgba(52,211,153,0.08);border:1px solid rgba(52,211,153,0.35);border-radius:2px;color:#6ee7b7;font-size:9px;padding:1px 6px;cursor:pointer;">↻ Regen Action</button>
              <button onclick="event.stopPropagation();refreshSegmentVeo3(${i})" title="Regenerate Veo 3" style="background:var(--accent-glow-sm);border:1px solid var(--accent);border-radius:2px;color:var(--accent-2);font-size:9px;padding:1px 6px;cursor:pointer;">↻ Regen Veo 3</button>
              <span class="action-toggle" style="font-size:9px;color:var(--text-3);padding:1px 5px;background:var(--bg);border:1px solid var(--border);border-radius:3px;">▸ Show</span>
            </div>
          </div>
          <div id="action-wrap-${i}" style="display:none;">
            <textarea id="action-seg-${i}"
              oninput="segments[${i}].action=this.value;autoGrow(this);debounceSave()"
              class="seg-ta-base seg-ta-action"
              placeholder="Describe what the person is doing — posture, gestures, expression, energy…"
            >${escHtml(seg.action || '')}</textarea>
          </div>
        </div>

        <!-- Scene Notes — manual hints for NB Pro prompt builder -->
        <div class="seg-field-notes">
          <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;color:rgba(167,139,250,0.6);margin-bottom:3px;">📝 Scene Notes <span style="font-weight:400;opacity:0.55;text-transform:none;letter-spacing:0;">(face mask, props, action)</span></div>
          <textarea id="notes-seg-${i}"
            oninput="segments[${i}].sceneNotes=this.value;autoGrow(this);debounceSave()"
            class="seg-ta-base"
            style="font-size:10px;min-height:26px;color:rgba(167,139,250,0.85);border-color:rgba(167,139,250,0.2);"
            placeholder="e.g. wearing black face mask pulling it off · holding red product label · two people, target the woman on left"
          >${escHtml(seg.sceneNotes || '')}</textarea>
        </div>

        <!-- Product toggle moved to segment header — icon next to Split button -->

        <!-- NB Pro prompt — collapsed by default -->
        <div class="seg-field-nb">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px;cursor:pointer;" onclick="const ta=document.getElementById('nb-seg-${i}');const pre=document.getElementById('nbpreview-wrap-${i}');const open=ta.style.display!=='none';ta.style.display=open?'none':'';if(pre)pre.style.display=open?'none':'flex';this.querySelector('.nb-toggle').textContent=open?'▸ Show':'▾ Hide';">
            <span style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;color:var(--warning);">${seg._scriptOnly ? '🎨 NB Pro — Starting Frame' : '🍌 NB Pro'}${seg.nbPrompt ? ' <span style="color:#4ade80;font-weight:900;font-size:10px;">✓</span>' : ''}</span>
            <div style="display:flex;gap:4px;align-items:center;">
              <button data-nb-regen="${i}" onclick="event.stopPropagation();refreshSegmentNB(${i})" title="Regenerate NB Pro prompt" style="background:rgba(251,191,36,0.08);border:1px solid rgba(251,191,36,0.35);border-radius:2px;color:var(--warning);font-size:9px;padding:1px 6px;cursor:pointer;">↻ Regen NB</button>
              <button class="btn-copy" onclick="event.stopPropagation();copyPromptTA('nb-seg-${i}')">Copy</button>
              <span class="nb-toggle" style="font-size:9px;color:var(--text-3);padding:1px 5px;background:var(--bg);border:1px solid var(--border);border-radius:3px;cursor:pointer;">▸ Show</span>
            </div>
          </div>
          <textarea id="nb-seg-${i}"
            oninput="segments[${i}].nbPrompt=this.value;autoGrow(this);debounceSave()"
            class="seg-ta-base seg-ta-prompt"
            style="display:none;"
            placeholder="Describe the scene for NB Pro…"
          >${escHtml(seg.nbPrompt || '')}</textarea>
          <!-- NB composite upload — producer mode only (replicator uses the segment frame directly) -->
          ${seg._scriptOnly ? `
          <div id="nbpreview-wrap-${i}" style="display:none;margin-top:5px;flex-direction:column;gap:4px;">
            ${!bgFromAvatar ? `<div data-nb-bg-row style="display:flex;align-items:center;gap:6px;padding:4px 6px;background:rgba(251,191,36,0.05);border:1px solid rgba(251,191,36,0.2);border-radius:4px;">
              <div onclick="document.getElementById('bgImgInput').click()" title="Click to upload background"
                style="width:36px;height:36px;border-radius:3px;overflow:hidden;flex-shrink:0;cursor:pointer;background:var(--surface-2);border:1px solid rgba(251,191,36,0.25);display:flex;align-items:center;justify-content:center;">
                ${bgImageDataUrl ? `<img id="nb-bg-thumb-${i}" src="${bgImageDataUrl}" style="width:100%;height:100%;object-fit:cover;">` : `<span style="font-size:16px;opacity:0.4;">🖼</span>`}
              </div>
              <span style="font-size:9px;color:var(--text-3);line-height:1.4;flex:1;">${bgImageDataUrl ? '<span style="color:rgba(251,191,36,0.8);font-weight:600;">📎 Photo 2 set</span> — attach this image as Photo 2 in NB Pro (same for all scenes)' : '<span style="color:var(--danger);opacity:0.7;">No background uploaded</span> — upload in the Background panel to use as Photo 2'}</span>
            </div>` : `<div data-nb-bg-row style="font-size:9px;color:rgba(251,191,36,0.6);padding:3px 6px;">🖼 Using avatar photo as background (Photo 1 only — no Photo 2 needed)</div>`}
            <div style="display:flex;align-items:center;gap:6px;">
              <div id="nbpreview-zone-${i}" onclick="document.getElementById('nbpreview-input-${i}').click()"
                style="width:36px;height:36px;border:1px dashed rgba(251,191,36,0.3);border-radius:3px;cursor:pointer;display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0;background:rgba(251,191,36,0.04);">
                ${seg.nbPreviewDataUrl
                  ? `<img src="${seg.nbPreviewDataUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:2px;">`
                  : `<span style="font-size:13px;opacity:0.4;">🍌</span>`}
              </div>
              <span style="font-size:9px;color:var(--text-3);line-height:1.3;">Upload NB Pro<br>composite result</span>
              ${seg.nbPreviewDataUrl ? `<button onclick="clearNbPreview(${i})" style="margin-left:auto;font-size:9px;padding:1px 5px;background:rgba(248,113,113,0.07);border:1px solid rgba(248,113,113,0.2);border-radius:2px;color:var(--danger);cursor:pointer;">✕</button>` : ''}
              <input type="file" id="nbpreview-input-${i}" accept="image/*" style="display:none;" onchange="onNbPreviewChange(${i}, this)">
            </div>
          </div>` : ''}
        </div>

        <!-- Veo 3 prompt -->
        <div class="seg-field-veo">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px;">
            <span style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;color:var(--accent-2);">🎬 VEO 3 / JSON &nbsp;${veoLintBadgeHtml(seg)}</span>
            <div style="display:flex;gap:4px;align-items:center;">
              ${seg.done ? `<button onclick="redoScene(${i})" title="Redo this scene" style="background:rgba(251,191,36,0.08);border:1px solid rgba(251,191,36,0.35);border-radius:2px;color:var(--warning);font-size:9px;padding:1px 6px;cursor:pointer;">🔄 Redo</button>` : ''}
              <button onclick="copyClaudeInstruction(${i})" title="Copy Claude Browser instruction" style="background:rgba(139,92,246,0.1);border:1px solid rgba(139,92,246,0.4);border-radius:2px;color:#a78bfa;font-size:9px;padding:1px 6px;cursor:pointer;">🤖</button>
              <button class="btn-copy" onclick="copyPromptTA('veo-seg-${i}')">Copy</button>
              <button id="veo-toggle-${i}" onclick="toggleVeoPrompt(${i})" title="Show prompt" style="background:var(--surface-3);border:1px solid var(--border);border-radius:2px;color:var(--text-3);font-size:9px;padding:1px 5px;cursor:pointer;display:flex;align-items:center;"><i class="ti ti-eye"></i></button>
            </div>
          </div>
          <div id="veo-wrap-${i}" style="display:none;">
            <textarea id="veo-seg-${i}"
              oninput="segments[${i}].veoPrompt=this.value;debounceSave();autoGrow(this);"
              class="seg-ta-base seg-ta-prompt"
              placeholder="Describe the video clip — action, speech, camera, background, audio…"
            >${escHtml(seg.veoPrompt || '')}</textarea>
          </div>
        </div>

        <!-- Continuation Clips (same start frame, new speech) -->
        <div class="seg-field-extras">
          ${(seg.veoExtras && seg.veoExtras.length > 0) ? `
          <div style="border-top:1px solid var(--border);padding-top:6px;margin-top:2px;">
            <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;color:rgba(99,102,241,0.8);margin-bottom:5px;">🔁 Continuation Clips <span style="font-weight:400;opacity:0.55;text-transform:none;letter-spacing:0;">(same frame · new speech)</span></div>
            ${seg.veoExtras.map((extra, j) => `
            <div style="background:rgba(99,102,241,0.06);border:1px solid rgba(99,102,241,0.22);border-radius:6px;padding:7px 8px;margin-bottom:5px;display:flex;flex-direction:column;gap:5px;">
              <div style="display:flex;justify-content:space-between;align-items:center;">
                <span style="font-size:9px;font-weight:700;color:rgba(129,140,248,0.9);">Clip ${j+2} — Speech</span>
                <button onclick="removeVeoExtra(${i},${j})" style="background:none;border:none;color:var(--danger);font-size:10px;cursor:pointer;padding:0 4px;" title="Remove this continuation clip">✕</button>
              </div>
              <textarea id="veo-extra-speech-${i}-${j}"
                oninput="updateVeoExtraSpeech(${i},${j},this.value)"
                class="seg-ta-base seg-ta-script"
                style="min-height:38px;"
                placeholder="Exact speech for this clip…"
              >${escHtml(extra.speech || '')}</textarea>
              ${extra.veoPrompt ? `
              <div style="display:flex;justify-content:space-between;align-items:center;">
                <span style="font-size:8.5px;color:rgba(99,102,241,0.55);cursor:pointer;user-select:none;" onclick="var p=document.getElementById('veo-extra-prompt-${i}-${j}');p.style.display=p.style.display==='none'?'':'none';">▸ Veo 3 JSON (tap to view/edit)</span>
                <button class="btn-copy" onclick="navigator.clipboard.writeText(segments[${i}].veoExtras[${j}].veoPrompt||'').then(()=>showToast('Clip ${j+2} prompt copied','success',2000))" style="font-size:9px;padding:1px 7px;">Copy</button>
              </div>
              <textarea id="veo-extra-prompt-${i}-${j}"
                oninput="if(segments[${i}].veoExtras[${j}])segments[${i}].veoExtras[${j}].veoPrompt=this.value;debounceSave()"
                class="seg-ta-base seg-ta-prompt"
                style="display:none;font-size:9px;"
              >${escHtml(extra.veoPrompt || '')}</textarea>` : ''}
            </div>
            `).join('')}
          </div>` : ''}
          <button onclick="addVeoExtra(${i})" style="width:100%;padding:5px 0;font-size:10px;font-weight:600;background:rgba(99,102,241,0.07);border:1px solid rgba(99,102,241,0.25);border-radius:5px;color:rgba(129,140,248,0.85);cursor:pointer;font-family:inherit;margin-top:${(seg.veoExtras && seg.veoExtras.length > 0) ? '0' : '4px'};">＋ Add Continuation Clip</button>
        </div>

        <!-- Generated video (Gemini API) -->
        ${seg.apiVideoUrl ? `
        <div style="border-top:1px solid rgba(16,185,129,0.22);padding-top:8px;margin-top:4px;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
            <span style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;color:#34d399;">⚡ Generated Video</span>
            <button onclick="clearSegmentApiVideo(${i})" title="Remove video" style="padding:1px 7px;font-size:9px;background:rgba(248,113,113,0.07);border:1px solid rgba(248,113,113,0.2);border-radius:3px;color:var(--danger);cursor:pointer;font-family:inherit;">✕ Remove</button>
          </div>
          <video controls playsinline style="width:100%;border-radius:6px;max-height:200px;background:#000;display:block;" src="${seg.apiVideoUrl}"></video>
          <a href="${seg.apiVideoUrl}" download="scene-${i+1}.mp4" style="display:flex;align-items:center;justify-content:center;gap:5px;margin-top:6px;padding:6px 0;font-size:10px;font-weight:700;background:rgba(16,185,129,0.10);border:1px solid rgba(16,185,129,0.3);border-radius:5px;color:#34d399;text-decoration:none;">⬇ Download Scene ${i+1}</a>
        </div>` : ''}

      </div>
      ${i < segments.length - 1 ? `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;flex-shrink:0;align-self:flex-start;margin-top:72px;gap:3px;">
        <div style="width:1px;height:16px;background:rgba(255,255,255,0.07);"></div>
        <button onclick="mergeSegments(${i},${i+1})" title="Merge Seg ${i+1} + Seg ${i+2}" style="background:rgba(96,165,250,0.14);border:1px solid rgba(96,165,250,0.45);border-radius:6px;color:#93c5fd;font-size:10px;font-weight:600;padding:5px 10px;cursor:pointer;white-space:nowrap;font-family:inherit;transition:all 0.15s;">⊕ Merge</button>
        <button onclick="addVeoExtraFromNextSeg(${i})" title="Add as continuation clip" style="background:rgba(167,139,250,0.12);border:1px solid rgba(167,139,250,0.42);border-radius:6px;color:#c4b5fd;font-size:9.5px;font-weight:600;padding:5px 10px;cursor:pointer;white-space:nowrap;font-family:inherit;transition:all 0.15s;">＋ Cont.</button>
        <div style="width:1px;height:16px;background:rgba(255,255,255,0.07);"></div>
      </div>` : ''}
`).join('');

    // Auto-grow all textareas after render
    requestAnimationFrame(() => {
      container.querySelectorAll('textarea').forEach(ta => autoGrow(ta));
    });
    // Update step progress strip whenever segments change
    setTimeout(() => updateStepProgress?.(), 80);
  }

  // Background source is always Photo 2 (uploaded background) unless bgFromAvatar is set.
  // The per-segment dropdown was removed — background panel drives Photo 2 for all scenes.

  // --- Pull jewelry + accessory details from the avatar inventory ---
  // These small items are the ones most likely to get dropped in NB Pro
  // compositing, so we reinforce just them in the prompt. Big stuff
  // (face / hair / clothing) is left to the reference photo. Returns '' when
  // there's nothing useful in the inventory.
  function getAvatarAccessoryNote() {
    const inv = (document.getElementById('avatarInventory')?.value || avatarInventory || '').trim();
    if (!inv) return '';
    let clothing = '';
    let eyeColor = '';
    const accessories = [];
    inv.split(/\r?\n/).forEach(line => {
      const m = line.match(/^\s*(CLOTHING|JEWELRY|OTHER|EYE COLOR)\s*:\s*(.+)$/i);
      if (!m) return;
      const key = m[1].toUpperCase().trim();
      let val = m[2].trim().replace(/\.+$/, '');
      // Safety filter: strip any "holding" language that slipped through the extraction prompt
      // (e.g. GPT-4o-mini misidentifying a crystal pendant necklace as "holding a crystal")
      val = val
        .replace(/\b(holding|held|in (?:her|his|their) hand[s]?|in one hand|in the hand)\b[^,;]*/gi, '')
        .trim()
        .replace(/^[,;\s]+|[,;\s]+$/g, '');
      if (!val || /^(none|none visible|n\/?a|unknown)$/i.test(val)) return;
      if (key === 'CLOTHING') { clothing = val; }
      else if (key === 'EYE COLOR') { eyeColor = val; }
      else { accessories.push(val); }
    });
    let note = '';
    // Eye color — injected first so Veo 3 locks it early in the prompt
    if (eyeColor) note += ` The person has ${eyeColor} eyes — keep this eye color exactly consistent across every scene.`;
    // Clothing gets a hard "must wear exactly" instruction — NB Pro tends to change outfits
    if (clothing) note += ` The person must be wearing exactly this outfit as shown in reference photo 1: ${clothing}. Do not change any part of the clothing.`;
    // Jewelry/accessories get a "keep visible" instruction
    if (accessories.length) note += ` Keep these specific details from reference photo 1 clearly visible and unchanged: ${accessories.join('; ')}.`;
    note += ' CRITICAL: Do NOT copy or add any hair accessories, headbands, hats, clips, bows, or wearable items from the reference frame person that are NOT listed in the avatar profile above. The avatar wears ONLY the items described — nothing extra from the reference.';
    // Gender & age lock — prevents the AI from flipping the avatar's gender or age
    // when the reference frame contains a person of a different gender/age group.
    note += ' GENDER LOCK: The avatar must match the exact gender and approximate age of the person in Photo 1. Do NOT change the avatar\'s gender, age group, or ethnicity under any circumstances — even if the reference frame contains a person of a different gender.';
    // Reference-frame item bleed prevention — stops text, numbers, logos, and props
    // that appear on or near the reference frame person from transferring to the output.
    note += ' TRANSFER BLOCK: Do NOT copy any text, numbers, dates, labels, logos, words, or graphical overlays that appear on the reference frame person\'s body, clothing, or background into the output. Do NOT copy any props, objects, or accessories held or worn by the reference frame person unless explicitly listed in this profile.';
    return note;
  }


  function getProductPhotoGuide(segIdx) {
    const has = !!(typeof productImageDataUrl !== 'undefined' ? productImageDataUrl : null);
    if (!has) return '';
    if (typeof segIdx === 'number') {
      const seg = segments[segIdx];
      if (seg && !seg.showProduct) return '';
    }
    // Product photo number depends on whether a background photo is also present
    const _hasBg = !!(typeof bgImageDataUrl !== 'undefined' && bgImageDataUrl && !(typeof bgFromAvatar !== 'undefined' && bgFromAvatar));
    const productPhotoNum = _hasBg ? 3 : 2;
    return ' Photo ' + productPhotoNum + ' = product reference — replicate its exact proportions, label/text, and brand colors in every frame.';
  }

  function getProductNBInstruction(segIdx) {
    const has = !!(typeof productImageDataUrl !== 'undefined' ? productImageDataUrl : null);
    if (!has) return '';
    if (typeof segIdx === 'number') {
      const seg = segments[segIdx];
      if (seg && !seg.showProduct) return '';
    }
    const _hasBg2 = !!(typeof bgImageDataUrl !== 'undefined' && bgImageDataUrl && !(typeof bgFromAvatar !== 'undefined' && bgFromAvatar));
    const productPhotoNum2 = _hasBg2 ? 3 : 2;
    const _bkName = (typeof getBrandKit === 'function') ? (getBrandKit().productName || '') : '';
    const _nameNote = _bkName ? ' This product is called "' + _bkName + '" — use this name in your instruction regardless of any other brand label visible in the scene.' : '';
    return ' PRODUCT (Photo ' + productPhotoNum2 + '): The exact product shown in Photo ' + productPhotoNum2 + ' must appear in every frame — match its proportions, label/text, size relative to the presenter\'s hands, and brand colors precisely.' + _nameNote;
  }

  // Toggle product visibility for a single segment
  function toggleSegmentProduct(i) {
    if (!segments[i]) return;
    segments[i].showProduct = !segments[i].showProduct;
    saveSegments();
    renderSegments();
  }

  // ─── Shotless NB prompt: no reference frame — tells NB Pro to CREATE the scene ───
  function buildShotlessNBPrompt(i, shotData) {
    const seg = segments[i];
    if (!seg || !shotData) return null;
    const n = segments.length;
    const { action = '', shot_type = 'medium_shot', scene_description = '' } = shotData;
    const shotLabel = {
      medium_shot: '[MEDIUM SHOT — waist to head, natural conversational distance]',
      close_up: '[CLOSE-UP — upper body and face fill ~80% of frame]',
      extreme_close_up: '[EXTREME CLOSE-UP — face and upper chest, fills 90%+ of frame]',
      hands_only: '[HANDS ONLY — focus on hands and product, head above top edge of frame]'
    }[shot_type] || '[MEDIUM SHOT]';

    let photo_guide, instruction;
    const _bgDesc = (typeof bgDescription !== 'undefined' && bgDescription) ? bgDescription.trim() : '';
    const _settingHint = (document.getElementById('studioSetting')?.value || '').trim();
    const _hasSeparateBg = !!(useAvatarBg && bgImageDataUrl && !bgFromAvatar);

    if (_hasSeparateBg) {
      photo_guide = 'Photo 1 = your avatar (the presenter). Photo 2 = target background — place the presenter in front of this setting.' + getProductPhotoGuide(i);
      instruction = `[ORIGINAL SCENE — GENERATE FROM SCRATCH] ${shotLabel} Scene ${i + 1} of ${n}. Place the presenter from Photo 1 in front of the background from Photo 2. ${scene_description}. PRESENTER ACTION: ${action}.${_bgDesc ? ' SETTING: ' + _bgDesc + '.' : ''} The presenter MUST be the exact person from Photo 1 — same face, skin tone, hair, and clothing. Match the lighting from Photo 2 exactly.`;
    } else if (useAvatarBg || bgFromAvatar) {
      photo_guide = 'Photo 1 = your avatar (person + background — generate this scene using the person and environment from Photo 1).' + getProductPhotoGuide(i);
      instruction = `[ORIGINAL SCENE — GENERATE FROM SCRATCH] ${shotLabel} Scene ${i + 1} of ${n}. Recreate the environment from Photo 1 as the setting. ${scene_description}. PRESENTER ACTION: ${action}.${_bgDesc ? ' SETTING CONTEXT: ' + _bgDesc + '.' : ''} The presenter MUST be the exact person from Photo 1 — same face, skin tone, hair, and clothing. Keep the same room and lighting as Photo 1.`;
    } else {
      photo_guide = 'Photo 1 = your avatar (the presenter — create this scene using ONLY this person).' + getProductPhotoGuide(i);
      instruction = `[ORIGINAL SCENE — GENERATE FROM SCRATCH] ${shotLabel} Scene ${i + 1} of ${n}.${_settingHint ? ' Setting: ' + _settingHint + '.' : ''} ${scene_description}. PRESENTER ACTION: ${action}. The presenter MUST be the exact person from Photo 1 — same face, skin tone, hair, and clothing. Do NOT use a generic or different person.`;
    }
    instruction += ' LIGHTING MATCH: Use warm, natural, well-lit lighting consistent with a professional lifestyle product video.';
    instruction += getAvatarAccessoryNote();
    instruction += getProductNBInstruction(i);
    instruction += ' No captions, no text overlays, no subtitles.';
    const negPrompt = 'wrong person, different face, generic stock person, mismatched skin tone, changed clothing, changed hair, wrong facial features, captions, watermarks, logos, cartoon, illustration, anime, distorted hands, extra fingers, blurry face, ghosting, double exposure, composite seam, mismatched lighting';
    return JSON.stringify({ scene: 'Scene ' + (i + 1) + ' of ' + n, photo_guide, seed: Math.floor(Math.random() * 99999), instruction, remove_captions: true, negative_prompt: negPrompt }, null, 2);
  }

  // --- Build Nano Banana prompt for the START frame of a segment ---
  function buildSegmentNanoBananaPrompt(i, frameDataUrl, scriptSlice, setting, productName, productDetails) {
    let instruction, negPrompt;
    if (bgFromAvatar) {
      // Avatar BG mode: Photo 1 is both person and background
      instruction = 'Use reference photo 1 exactly as the source for both the person and the background. Keep the character appearance, clothing, and the background environment from photo 1 completely unchanged. Frame the composition naturally for a 9:16 vertical video. Do not add, remove, or alter any visual elements.';
      negPrompt = 'captions, watermarks, logos, subtitles, camera movement, zoom, pan, cuts, blurry, distorted face, extra limbs, missing hands, duplicate people, cartoon, illustration, painting, drawing, anime, changed background, changed environment, changed clothing, changed props, ghosting, double exposure, transparency, semi-transparent person, composite seam, edge halo, color fringing, mismatched lighting, inconsistent shadow direction';
    } else {
      // Standard: person from Photo 1, background/scene from Photo 2 (uploaded background)
      instruction = 'Place the person from reference photo 1 exactly into the scene from reference photo 2. CRITICAL: match the person\'s exact screen position, size, and placement within the frame as shown in photo 2 — if the person appears in the lower-right corner in photo 2, place them in the lower-right corner at the same scale. Do not center or reposition the person. Match the pose, body position, framing, and camera angle from photo 2 precisely. Do not describe or alter the character — use only reference photo 1 for the person.';
      negPrompt = 'captions, watermarks, logos, subtitles, camera movement, zoom, pan, cuts, blurry, distorted face, extra limbs, missing hands, duplicate people, cartoon, illustration, painting, drawing, anime, changed background, changed props, changed clothing, repositioned person, centered person, wrong scale, ghosting, double exposure, transparency, semi-transparent person, composite seam, edge halo, color fringing, mismatched lighting, inconsistent shadow direction';
    }
    instruction += ' LIGHTING MATCH: Adjust the avatar\'s lighting to exactly match the color temperature, direction, and shadow quality of the reference frame — no generic studio lighting.';
    instruction += getAvatarAccessoryNote();
    instruction += getProductNBInstruction(i);
    instruction += ' No captions, no text overlays, no subtitles.';
    const _nbSceneNum = i + 1;
    const _nbTotal = segments ? segments.length : '?';
    const _hasProductPhoto = !!(typeof productImageDataUrl !== 'undefined' && productImageDataUrl);
    const _hasBgPhoto2 = !!(typeof bgImageDataUrl !== 'undefined' && bgImageDataUrl && !(typeof bgFromAvatar !== 'undefined' && bgFromAvatar));
    // When product is loaded and no bg: Photo 2 = product, Photo 3 = scene frame
    // When bg is loaded: Photo 2 = bg/scene, Photo 3 = product
    // When neither: Photo 2 = scene frame
    let _nbPhotoGuide;
    if (bgFromAvatar) {
      _nbPhotoGuide = `Photo 1 = your avatar (person + background source for Scene ${_nbSceneNum}).`;
    } else if (_hasProductPhoto && !_hasBgPhoto2) {
      // Product is Photo 2 — must be labeled as product reference ONLY, not scene
      _nbPhotoGuide = `Photo 1 = your avatar (person to composite). Photo 2 = PRODUCT REFERENCE ONLY — use this to match the product appearance; do NOT use this as the scene background. Photo 3 = Scene ${_nbSceneNum} reference frame (background/composition to match — this is the scene).`;
    } else {
      _nbPhotoGuide = `Photo 1 = your avatar (person to composite). Photo 2 = Scene ${_nbSceneNum} reference frame (background/composition to match).` + getProductPhotoGuide(i);
    }
    return JSON.stringify({ scene: `Scene ${_nbSceneNum} of ${_nbTotal}`, photo_guide: _nbPhotoGuide, seed: Math.floor(Math.random() * 99999), instruction, remove_captions: true, negative_prompt: negPrompt }, null, 2);
  }

  // --- Build Nano Banana prompt for the END frame of a segment ---
  function buildSegmentNanoBananaEndPrompt(i, setting, productName, productDetails) {
    let instruction, negPrompt;
    if (bgFromAvatar) {
      // Avatar BG mode: Photo 1 is both person and background
      instruction = 'Use reference photo 1 exactly as the source for both the person and the background. Keep the character appearance, clothing, and the background environment from photo 1 completely unchanged. Frame the composition naturally for a 9:16 vertical video. Do not add, remove, or alter any visual elements.';
      negPrompt = 'captions, watermarks, logos, subtitles, camera movement, zoom, pan, cuts, blurry, distorted face, extra limbs, missing hands, duplicate people, cartoon, illustration, painting, drawing, anime, changed background, changed environment, changed clothing, changed props, ghosting, double exposure, transparency, semi-transparent person, composite seam, edge halo, color fringing, mismatched lighting, inconsistent shadow direction';
    } else {
      // Standard: person from Photo 1, background/scene from Photo 2 (uploaded background)
      instruction = 'Place the person from reference photo 1 exactly into the scene from reference photo 2. CRITICAL: match the person\'s exact screen position, size, and placement within the frame as shown in photo 2 — if the person appears in the lower-right corner in photo 2, place them in the lower-right corner at the same scale. Do not center or reposition the person. Match the pose, body position, framing, and camera angle from photo 2 precisely. Do not describe or alter the character — use only reference photo 1 for the person.';
      negPrompt = 'captions, watermarks, logos, subtitles, camera movement, zoom, pan, cuts, blurry, distorted face, extra limbs, missing hands, duplicate people, cartoon, illustration, painting, drawing, anime, changed background, changed props, changed clothing, repositioned person, centered person, wrong scale, ghosting, double exposure, transparency, semi-transparent person, composite seam, edge halo, color fringing, mismatched lighting, inconsistent shadow direction';
    }
    instruction += ' LIGHTING MATCH: Adjust the avatar\'s lighting to exactly match the color temperature, direction, and shadow quality of the reference frame — no generic studio lighting.';
    instruction += getAvatarAccessoryNote();
    instruction += getProductNBInstruction(i);
    instruction += ' No captions, no text overlays, no subtitles.';
    const _nbEndSceneNum = i + 1;
    const _nbEndTotal = segments ? segments.length : '?';
    const _hasProductPhotoEnd = !!(typeof productImageDataUrl !== 'undefined' && productImageDataUrl);
    const _hasBgPhotoEnd = !!(typeof bgImageDataUrl !== 'undefined' && bgImageDataUrl && !(typeof bgFromAvatar !== 'undefined' && bgFromAvatar));
    let _nbEndPhotoGuide;
    if (bgFromAvatar) {
      _nbEndPhotoGuide = `Photo 1 = your avatar (person + background source for Scene ${_nbEndSceneNum} end frame).`;
    } else if (_hasProductPhotoEnd && !_hasBgPhotoEnd) {
      _nbEndPhotoGuide = `Photo 1 = your avatar (person to composite). Photo 2 = PRODUCT REFERENCE ONLY — use this to match the product appearance; do NOT use this as the scene background. Photo 3 = Scene ${_nbEndSceneNum} end-frame reference (background/composition to match — this is the scene).`;
    } else {
      _nbEndPhotoGuide = `Photo 1 = your avatar (person to composite). Photo 2 = Scene ${_nbEndSceneNum} end-frame reference (background/composition to match).` + getProductPhotoGuide(i);
    }
    return JSON.stringify({ scene: `Scene ${_nbEndSceneNum} of ${_nbEndTotal} (end frame)`, photo_guide: _nbEndPhotoGuide, seed: Math.floor(Math.random() * 99999), instruction, remove_captions: true, negative_prompt: negPrompt }, null, 2);
  }

  // --- Vision-based NB prompt builder: analyzes the frame to tailor the instruction ---
  async function buildNBPromptFromImage(i) {
    const seg = segments[i];
    if (!seg || !seg.frameDataUrl) return false;
    const apiKey = getApiKey();
    if (!apiKey) return false;

    const nbTa = document.getElementById('nb-seg-' + i);
    // Capture the previous real prompt BEFORE writing the spinner, so failure paths
    // can restore it rather than writing the spinner string back as a "value".
    const _prevNbPrompt = (seg.nbPrompt && !seg.nbPrompt.startsWith('⏳')) ? seg.nbPrompt : '';
    if (nbTa) nbTa.value = '⏳ Analyzing frame…';

    const sceneNotes = (seg.sceneNotes || '').trim();
    const _nbScript = (seg.script || '').trim();

    // Pre-compute all injected notes — avoids nested template literals (Windows Node compat)
    const _scriptNote = _nbScript
      ? '\n\n── SCENE SCRIPT (use to identify props and context) ──\n"' + _nbScript + '"\nThe presenter says this while performing actions in this frame. Use the script to correctly name any ambiguous products, tools, containers, or props you see. CRITICAL — PRODUCT NAME OVERRIDE: If the script mentions a specific product name (e.g. "QUIA toner pads"), that name is AUTHORITATIVE. Use the script name even if you can see a different brand name on the container in the video frame — the frame may show a competitor product being replaced.'
      : '';
    const _notesNote = sceneNotes
      ? '\n\n⚠️ USER-PROVIDED SCENE NOTES — treat these as ground truth, they override anything you think you see in the image:\n' + sceneNotes
      : '';
    let _twoPersNote = '';
    if (seg.targetX != null) {
      const _tSide   = seg.targetX < 50 ? 'LEFT' : 'RIGHT';
      const _tGender = seg.targetGender === 'woman' ? 'WOMAN' : seg.targetGender === 'man' ? 'MAN' : 'PERSON';
      const _oSide   = _tSide === 'LEFT' ? 'RIGHT' : 'LEFT';
      _twoPersNote = '\n\n⚠️ TWO-PERSON SCENE — READ CAREFULLY:\nThis frame contains MULTIPLE people. The user has pinned the TARGET at ' + seg.targetX + '% from the left edge of the frame — this is the ' + _tSide + ' side of the screen (from the viewer’s perspective looking at the screen).\nYou MUST:\n1. Replace ONLY the ' + _tGender + ' on the ' + _tSide + ' side of the frame. Do NOT second-guess this — trust the coordinate, not your own left/right perception of the image.\n2. The person on the ' + _oSide + ' side must remain 100% UNCHANGED — same face, body, skin, clothing, hair, pose, and position as in Photo 2.\n3. In your written instruction, explicitly state: "Replace ONLY the ' + _tGender.toLowerCase() + ' on the ' + _tSide.toLowerCase() + '. The person on the ' + _oSide.toLowerCase() + ' must stay 100% unchanged."\n4. Your negative_prompt MUST include: missing person, removed person, only one person, disappeared person, merged people';
    } else if (seg.targetPerson === 'left') {
      _twoPersNote = '\n\nIMPORTANT: If there are multiple people in this frame, TARGET ONLY the person closest to the LEFT EDGE of the image (from the viewer looking at the screen). Do NOT move, alter, or replace any other person.';
    } else if (seg.targetPerson === 'right') {
      _twoPersNote = '\n\nIMPORTANT: If there are multiple people in this frame, TARGET ONLY the person closest to the RIGHT EDGE of the image (from the viewer looking at the screen). Do NOT move, alter, or replace any other person.';
    }

    try {
      const res = await _fetchWithRetry('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o',
          temperature: 0.3,
          max_tokens: 1000,
          response_format: { type: 'json_object' },
          messages: [{
            role: 'user',
            content: [
              {
                type: 'text',
                text: `You are writing a Nano Banana image generation instruction. The user has an avatar photo (Photo 1) of a real person they want to composite into this scene frame (Photo 2 = the attached image).` + _scriptNote + _notesNote + _twoPersNote + `

Carefully analyze the attached frame image and follow ALL of these rules:

───────────────────────────────
STEP 1 — IDENTIFY WHAT IS VISIBLE
───────────────────────────────
⚠️ CONFIDENCE RULE — applies to everything in this step:
Only describe something if you are CERTAIN it is there. If you are not 100% sure — omit it entirely. Do NOT guess, infer, or fill in from context. A wrong inclusion causes far more damage than an omission. When in doubt, leave it out.

Classify the shot type:
- FULL PERSON: face and upper body clearly visible (head, shoulders, torso in frame)
- HANDS/ARMS ONLY: no face in frame — only hands, forearms, arms (possibly holding/interacting with products)
- CHIN/NECK CROPPED: person visible from chest down, head cut off above frame top edge
- CLOSE-UP FACE: tight shot, mainly face and neck
- TORSO/SHIRT ONLY: frame shows chest/shoulder-to-waist area — clothing or shirt visible, head is above the top edge of the frame (cropped out), legs are below the bottom edge (cropped out). No face in frame. No hands prominently in frame.
- TWO-PERSON: two people visible in the same frame — identify the targeted person vs the one to preserve

CRITICAL — identify the person's SCREEN POSITION AND SIZE:
- Where is the person positioned within the frame? Describe using quadrant terms: top-left, top-center, top-right, center-left, center, center-right, bottom-left, bottom-center, bottom-right
- What fraction of the FRAME HEIGHT does the person occupy? (e.g. "person fills ~80% of frame height" vs "person is a small insert in the bottom-right corner, filling ~25% of frame height")
- Is most of the frame showing BACKGROUND/ENVIRONMENT rather than the person? (e.g. person is small and off to one side while the background or a product dominates the rest of the frame)

Also identify:
- Exact products/props visible on the table or in hands (brand names, colors, sizes)
- Background elements (wall color, any signs, plants, flags, furniture)
- Camera angle (straight-on, low angle from below, high angle from above)
- Lighting quality (warm, cool, soft, harsh)
- Face coverings — ONLY if a mask or face covering is unambiguously, unmistakably present (e.g. a clearly visible surgical mask or cloth mask fully covering nose and mouth). A beard, shadow, dark collar, dark clothing near the chin, or any partially obscured lower face is NOT a mask. If there is even slight doubt, omit this entirely.

───────────────────────────────
STEP 2 — WRITE THE INSTRUCTION
───────────────────────────────
⚠️ APPEARANCE BAN — THE MOST IMPORTANT RULE IN THIS ENTIRE PROMPT:
The original person in Photo 2 will be COMPLETELY REPLACED by the avatar from Photo 1.
You MUST NOT describe ANY of the following about the original person:
  • Hair (color, length, style, braids, locs, waves)
  • Head coverings (headscarf, hijab, turban, beanie, baseball cap, bandana, du-rag)
  • Eyewear (glasses, sunglasses, reading glasses)
  • Jewelry (earrings, necklace, rings, chains, bracelets)
  • Regular clothing (shirt color, hoodie, jacket, uniform)
  • Skin tone or body type
NONE of these transfer to the avatar. Including them causes NB Pro to wrongly apply them to the avatar.
The ONLY exception: face masks/coverings (surgical mask, cloth mask, etc.) that must be replicated for scene continuity. Everything else — banned.

Write a SHORT scene-specific instruction using explicit LOCK / REPLACE / LIGHT labels so the model knows exactly what changes vs. what is fixed. Do NOT include boilerplate like "place the person from photo 1 into the scene" — those rules are already in the global prompt. Only write what is UNIQUE to this specific frame. Always end with: "No captions, no text overlays, no subtitles."

Use this label structure so the model can anchor rules without drift:
  REPLACE: what changes (the target person — their position, size, pose)
  LOCK: what must stay identical (background, secondary person, specific objects)
  ARM: exact arm/hand position and what they hold
  LIGHT: color temperature + shadow direction (e.g. "warm/golden from top-left")
  PROP STATE: exact condition of each prop (e.g. "Vaseline jar open, lid removed, facing camera")

FOR FULL PERSON shots:
- Start: "[FULL PERSON]"
- REPLACE: target person — state position (quadrant) and frame height % e.g. "centered, ~80% frame height"
- Camera angle: e.g. "straight-on chest height" or "slight low angle"
- LOCK: background — list all elements briefly: "beige wall, product shelf behind, spa bed left"
- ARM: describe both arms/hands precisely — position, height, what they hold
- PROP STATE: list each prop's exact state: "open Vaseline jar facing camera on table center, honey jar sealed right"
- LIGHT: color temperature and shadow direction: "warm ambient, soft shadows from above"
- Face covering if present: "LOCK: avatar wears [black cloth mask] — do NOT show bare face"

FOR TWO-PERSON shots:
- Start: "[TWO-PERSON]"
- REPLACE: [man/woman] on [left/right] — fills ~[X]% frame height, occupies [X%–X%] of frame width, [depth vs other person]
- LOCK: [man/woman] on [other side] — 100% unchanged, fills ~[Y]% frame height, do not alter face/body/clothing/position
- ARM: if any arm extends between the two people — state whose arm, direction, and where it contacts/lands. Avatar must replicate this exactly. No floating limbs.
- LOCK: background — all elements unchanged
- LIGHT: color temperature and shadow direction

FOR HANDS/ARMS ONLY or CHIN/NECK CROPPED shots:
- Start: "[HANDS ONLY]" or "[CHIN CROPPED]"
- ALWAYS include: "Head exists but is cropped above top edge — do NOT erase it"
- Lateral position and scale of arms/torso in frame
- Camera level: "table level shooting upward" or "straight-on"
- Describe each hand's action precisely: "one hand holds white bowl pouring honey, other steadies large bowl"
- List every table product with position: left, center-left, center, center-right, right

FOR TORSO/SHIRT ONLY shots:
- Start: "[TORSO ONLY]"
- ALWAYS include: "Head above top edge, legs below bottom — do NOT erase either"
- Crop region: "frame starts at shoulder level, ends at waist"
- Lateral position and width
- Camera angle

FOR BACKGROUND signs/paintings:
- Always say "mounted on wall 3ft behind, slightly out of focus"

───────────────────────────────
STEP 3 — WRITE THE NEGATIVE PROMPT
───────────────────────────────
Always include these based on what could go wrong:
- If TWO-PERSON shot: ALWAYS add "missing person, removed person, only one person, disappeared person, merged people, both people replaced, wrong person swapped"
- If head is cropped: ALWAYS add "headless, missing head, decapitated, head removed"
- If hands shot: add "face fully visible, wide shot showing full person"
- If torso/shirt only: ALWAYS add "face visible in frame, head in frame, full body showing, legs visible, zoomed out, wide shot, full-length shot"
- If and ONLY IF you identified a face mask/covering with certainty in STEP 1: add "bare face, mask removed, uncovered mouth, uncovered nose, no face mask, face covering missing" — do NOT add this if you had any doubt about the mask in STEP 1
- Always add: "changed clothing, changed skin tone, changed face, captions, watermarks, cartoon, illustration, anime, distorted hands, extra fingers, blurry face"
- If there's a sign in the background: add "sign touching person, sign held in hand, sign in foreground"
- If background should be plain: add "sign on wall, framed sign, painting, artwork, text on wall, any writing on wall"

───────────────────────────────
STEP 4 — PRODUCT STATE IN THIS FRAME (only when product is loaded)
───────────────────────────────
${typeof productImageDataUrl !== 'undefined' && productImageDataUrl ? `A product reference photo will be passed as Photo 3 to NB Pro. Look at this frame and describe exactly how the product appears in it:
- Is a product clearly visible in this frame? (bottle, jar, tube, box, bag, can, etc.)
- If yes — what state is it in? (sealed/open, cap on/off, pump extended/retracted, lid removed, wrapping intact/torn, etc.)
- How is it being interacted with? (sitting untouched on table, held upright in left hand, held upright in right hand, held in both hands, being opened, being poured, being applied, being displayed label-forward)
- What part faces the camera? (front label, side, top, back, bottom)
- Where is it in the frame? (table foreground, held at waist height, held at chest height, held near face)
If no product is clearly visible, set "product_state" to null.` : '(no product loaded — omit product_state field)'}

───────────────────────────────
STEP 5 — OUTPUT FORMAT
───────────────────────────────
Return ONLY a valid JSON object:
${typeof productImageDataUrl !== 'undefined' && productImageDataUrl ? `{
  "instruction": "...",
  "negative_prompt": "...",
  "product_state": "description of product state, or null if no product visible"
}` : `{
  "instruction": "...",
  "negative_prompt": "..."
}`}

No markdown, no explanation, no extra fields. Be specific and concrete — name the actual products, colors, and positions you see. Do not use vague terms like "various items" or "some products."`
              },
              { type: 'image_url', image_url: { url: await scaleDataUrl(seg.frameDataUrl, 512), detail: 'low' } }
            ]
          }]
        })
      });
      let data;
      try { data = await res.json(); } catch(_) { data = {}; }
      if (!res.ok || data.error) {
        const msg = data?.error?.message || 'API error ' + res.status;
        showToast('NB prompt build failed: ' + msg + '. Try again.', 'error');
        if (nbTa && nbTa.value.startsWith('⏳')) nbTa.value = _prevNbPrompt || '';
        return false;
      }
      let raw = (data.choices?.[0]?.message?.content || '').trim();
      // Strip markdown code fences if present
      raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
      // If truncated mid-JSON, try to close it
      if (raw.startsWith('{') && !raw.endsWith('}')) {
        // Find the last complete quoted string value and close the object
        const lastQuote = raw.lastIndexOf('"');
        if (lastQuote > 0) raw = raw.substring(0, lastQuote + 1) + '}';
      }
      // Extract JSON object if wrapped in extra text
      const _jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (_jsonMatch && _jsonMatch[0] !== raw) raw = _jsonMatch[0];
      let parsed;
      try { parsed = JSON.parse(raw); } catch(_pe) {
        // Last resort: try to extract instruction manually
        const _instMatch = raw.match(/"instruction"\s*:\s*"([^"]+)"/);
        if (_instMatch) {
          parsed = { instruction: _instMatch[1], negative_prompt: '' };
        } else {
          showToast('NB prompt build failed — AI returned unexpected format. Try again.', 'error');
          if (nbTa && nbTa.value.startsWith('⏳')) nbTa.value = _prevNbPrompt || '';
          return false;
        }
      }
      if (!parsed.instruction) {
        if (nbTa && nbTa.value.startsWith('⏳')) nbTa.value = _prevNbPrompt || '';
        return false;
      }
      // Strip appearance leakage — GPT sometimes describes the original person's
      // hair/glasses/headwear despite the ban. These must never enter the NB prompt
      // because NB Pro applies them to the avatar.
      parsed.instruction = parsed.instruction
        .replace(/\b(wearing|has|with|in)\s+(glasses|sunglasses|reading\s+glasses|spectacles)[^,.;]*[,.;]?\s*/gi, '')
        .replace(/\b(wearing|has|in)\s+(a\s+)?(headscarf|hijab|niqab|turban|beanie|snapback|baseball\s+cap|cap|hat|bandana|du-rag|durag|head\s+covering|head\s+wrap|headband)[^,.;]*[,.;]?\s*/gi, '')
        .replace(/\b(wearing|has)\s+(a\s+)?(hoodie|t-shirt|tshirt|shirt|jacket|sweater|jersey|uniform|vest)[^,.;]*[,.;]?\s*/gi, '')
        .replace(/\b(with|wearing|has)\s+(long|short|braided|natural|curly|wavy|straight|loc[ks]?|dreads?|afro)\s+(hair|locs?|braids?)[^,.;]*[,.;]?\s*/gi, '')
        .replace(/\bhair\s+is\s+(long|short|braided|natural|curly|wavy|straight|loc[ks]?|afro)[^,.;]*[,.;]?\s*/gi, '')
        .replace(/\b(dark|light|brown|black|blonde|red|gray|grey|white)\s+skin\s+(tone|color)?[^,.;]*[,.;]?\s*/gi, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
      // ── Avatar hair counter-instruction ─────────────────────────────────────
      // If the avatar has distinctive hair (white/gray/short/light) that contrasts
      // with the scene person (often dark/long), NB Pro can bleed the scene hair onto
      // the avatar. Detect this and add explicit counter-instructions.
      const _avInvFull = (document.getElementById('avatarInventory')?.value || (typeof avatarInventory !== 'undefined' ? avatarInventory : '') || '').trim();
      if (_avInvFull && parsed.instruction) {
        const _hairLine = _avInvFull.match(/FACE\s*&?\s*HAIR[^\n]*/i)?.[0] || '';
        const _avHairDesc = _hairLine.replace(/FACE\s*&?\s*HAIR\s*:\s*/i, '').split(';')[0].trim();
        const _avHasLightHair = /white|gray|grey|silver|light\b/i.test(_avHairDesc);
        const _avHasDarkHair = /dark|black|brown|long|wavy|curly/i.test(_avHairDesc);
        if (_avHairDesc && (_avHasLightHair || !_avHasDarkHair)) {
          // Avatar has light/short/non-dark hair — add bleed prevention
          parsed.instruction += ' HAIR LOCK: Avatar has ' + _avHairDesc + '. The scene person may have dark or long hair — DO NOT apply that hair to the avatar under any circumstances.';
          const _negHair = 'dark hair, long hair, wavy black hair, wrong hair color, original hairstyle, hair bleed';
          parsed.negative_prompt = parsed.negative_prompt
            ? parsed.negative_prompt + ', ' + _negHair
            : _negHair;
        } else if (_avHairDesc) {
          // Avatar has defined hair — still lock it to prevent any bleed
          parsed.instruction += ' HAIR LOCK: Avatar hair is exactly: ' + _avHairDesc + '. Do not alter or blend with the scene person hair.';
        }
      }

      // ── Glasses color lock ────────────────────────────────────────────────────
      // If avatar inventory mentions glasses, extract the description and lock it
      // so NB Pro doesn't guess the wrong color from surrounding accessories.
      if (_avInvFull && parsed.instruction) {
        const _glassesLine = _avInvFull.match(/(?:glasses|eyeglasses|spectacles|frames?)[^\n;,]*/i)?.[0] || '';
        if (_glassesLine) {
          // Avatar wears glasses — re-inject correct description that was stripped
          parsed.instruction += ' GLASSES: Avatar wears ' + _glassesLine.trim() + '. Match exactly — do NOT change the frame color or style.';
          // Block wrong colors from bleeding (e.g. green from jewelry)
          if (parsed.negative_prompt) {
            parsed.negative_prompt += ', green glasses, wrong glasses color, wrong frame color';
          }
        }
      }

      // Append scene notes directly to instruction so they're always present
      if (sceneNotes && parsed.instruction) {
        parsed.instruction += ` SCENE NOTE: ${sceneNotes}.`;
      }
      // Avatar background mode: place the avatar in a specific background setting.
      // Photo 1 is ALWAYS for character appearance only (face, hair, clothing).
      // If a separate background photo was uploaded (bgFromAvatar = false), it is
      // Photo 2 and serves as the visual reference for the setting — the text
      // description helps the model focus on the environment, not the person.
      // If no separate bg photo is uploaded (bgFromAvatar = true), text description
      // alone sets the scene so the model isn't confused by two jobs in one photo.
      if (useAvatarBg && parsed.instruction) {
        // Strip conflicting "LOCK: background" line produced by GPT-4o frame analysis.
        // When BGMODE is active we are replacing the background, so any instruction
        // telling the model to lock/keep the scene background directly contradicts
        // the [[BGMODE]] block we are about to append. Remove it first.
        parsed.instruction = parsed.instruction.replace(/\s*LOCK:\s*background\s*[—–\-][^\n]*/gi, '');
        const _bgDesc = (typeof bgDescription !== 'undefined' && bgDescription) ? bgDescription.trim() : '';
        const _hasSeparateBg = !!(bgImageDataUrl && !bgFromAvatar);
        if (_hasSeparateBg && _bgDesc) {
          parsed.instruction += ` [[BGMODE]]AVATAR: The character MUST look exactly like Photo 1 — same face, hair color, skin tone, and clothing. Do NOT use the person from the video frame as the character. BACKGROUND: Replace the background entirely with the setting from Photo 2. Photo 2 shows: ${_bgDesc} — match this environment exactly. Keep all foreground content exactly as described above (the person's action, props, table items, products, and any objects in front of the person). Do NOT copy any part of the original background from the video frame.`;
        } else if (_hasSeparateBg) {
          parsed.instruction += ` [[BGMODE]]AVATAR: The character MUST look exactly like Photo 1 — same face, hair color, skin tone, and clothing. Do NOT use the person from the video frame as the character. BACKGROUND: Replace the background entirely with the setting from Photo 2 — match that environment exactly. Keep all foreground content exactly as described above (the person's action, props, table items, products, and any objects in front of the person). Do NOT copy any part of the original background from the video frame.`;
        } else if (_bgDesc) {
          parsed.instruction += ` [[BGMODE]]AVATAR: The character MUST look exactly like Photo 1 — same face, hair color, skin tone, and clothing. Do NOT use the person from the video frame as the character. BACKGROUND: Replace the background entirely with this setting: ${_bgDesc}. Keep all foreground content exactly as described above (the person's action, props, table items, products, and any objects in front of the person). Do NOT copy any part of the original background from the video frame.`;
        } else {
          parsed.instruction += ` [[BGMODE]]AVATAR: The character MUST look exactly like Photo 1 — same face, hair color, skin tone, and clothing. Do NOT use the person from the video frame as the character. BACKGROUND: Replace the background entirely with the same room and setting seen behind the avatar in Photo 1 — same walls, lighting, and environment. Keep all foreground content exactly as described above (the person's action, props, table items, products, and any objects in front of the person). Do NOT copy any part of the original background from the video frame.`;
        }
      }
      // Merge result fields — include scene label and photo guide so the agent knows which upload is which
      const _visionSceneNum = i + 1;
      const _visionTotal = segments.length;
      const _visionPhotoGuide = bgFromAvatar
        ? `Photo 1 = your avatar (character reference only — face, hair, clothing). Background setting is described in the instruction above.`
        : (useAvatarBg && bgImageDataUrl)
          ? `Photo 1 = your avatar (character reference only — face, hair, clothing must match). Photo 2 = target background image (place the avatar in front of this setting).`
          : `Photo 1 = your avatar (person to composite). Photo 2 = Scene ${_visionSceneNum} reference frame (background/composition to match).`;
      const result = { scene: `Scene ${_visionSceneNum} of ${_visionTotal}`, photo_guide: _visionPhotoGuide + getProductPhotoGuide(i), seed: Math.floor(Math.random() * 99999), instruction: parsed.instruction, remove_captions: true, negative_prompt: parsed.negative_prompt || '' };
      // Append avatar accessory note + product note
      result.instruction += getAvatarAccessoryNote();
      // Inject per-frame product state if detected and product image is loaded
      if (parsed.product_state && typeof productImageDataUrl !== 'undefined' && productImageDataUrl) {
        result.instruction += ` PRODUCT STATE IN THIS FRAME: ${parsed.product_state}.`;
      }
      result.instruction += getProductNBInstruction(i);
      result.instruction += ' LIGHTING MATCH: Adjust the avatar\'s lighting to exactly match the color temperature, direction, and shadow quality of the reference frame — no generic studio lighting.';
      result.negative_prompt = (result.negative_prompt || '') + ', ghosting, double exposure, transparency, semi-transparent person, composite seam, edge halo, color fringing, mismatched lighting, inconsistent shadow direction, text overlay from reference, numbers on body, day counter, progress text, dates on clothing, labels from reference frame, wrong gender avatar, gender swap';
      seg.nbPrompt = JSON.stringify(result, null, 2);
      if (nbTa) { nbTa.value = seg.nbPrompt; autoGrow(nbTa); }
      debounceSave();
      return true;
    } catch(e) {
      console.warn('buildNBPromptFromImage failed:', e);
      if (nbTa && nbTa.value.startsWith('⏳')) nbTa.value = _prevNbPrompt || '';
      return false;
    }
  }

  // --- Patch background instruction in all existing NB prompts ---
  // Called when useAvatarBg is toggled or when bgDescription arrives after
  // a background photo is analyzed. Re-writes the BACKGROUND/SETTING suffix
  // in-place — no API calls, instant update.
  function patchNbPromptBackground() {
    if (!segments || segments.length === 0) return 0;
    const _bgDesc        = (typeof bgDescription !== 'undefined' && bgDescription) ? bgDescription.trim() : '';
    const _hasSeparateBg = !!(bgImageDataUrl && !bgFromAvatar);

    // Build the suffix that should appear at the end of each instruction
    let newSuffix = '';
    if (useAvatarBg) {
      if (_hasSeparateBg && _bgDesc) {
        newSuffix = ` [[BGMODE]]AVATAR: The character MUST look exactly like Photo 1 — same face, hair color, skin tone, and clothing. Do NOT use the person from the video frame as the character. BACKGROUND: Replace the background entirely with the setting from Photo 2. Photo 2 shows: ${_bgDesc} — match this environment exactly. Keep all foreground content exactly as described above (the person's action, props, table items, products, and any objects in front of the person). Do NOT copy any part of the original background from the video frame.`;
      } else if (_hasSeparateBg) {
        newSuffix = ` [[BGMODE]]AVATAR: The character MUST look exactly like Photo 1 — same face, hair color, skin tone, and clothing. Do NOT use the person from the video frame as the character. BACKGROUND: Replace the background entirely with the setting from Photo 2 — match that environment exactly. Keep all foreground content exactly as described above (the person's action, props, table items, products, and any objects in front of the person). Do NOT copy any part of the original background from the video frame.`;
      } else if (_bgDesc) {
        newSuffix = ` [[BGMODE]]AVATAR: The character MUST look exactly like Photo 1 — same face, hair color, skin tone, and clothing. Do NOT use the person from the video frame as the character. BACKGROUND: Replace the background entirely with this setting: ${_bgDesc}. Keep all foreground content exactly as described above (the person's action, props, table items, products, and any objects in front of the person). Do NOT copy any part of the original background from the video frame.`;
      } else {
        newSuffix = ` [[BGMODE]]AVATAR: The character MUST look exactly like Photo 1 — same face, hair color, skin tone, and clothing. Do NOT use the person from the video frame as the character. BACKGROUND: Replace the background entirely with the same room and setting seen behind the avatar in Photo 1 — same walls, lighting, and environment. Keep all foreground content exactly as described above (the person's action, props, table items, products, and any objects in front of the person). Do NOT copy any part of the original background from the video frame.`;
      }
    }

    let updated = 0;
    segments.forEach((seg, i) => {
      if (!seg.nbPrompt) return;
      try {
        const parsed = JSON.parse(seg.nbPrompt);
        if (!parsed.instruction) return;
        // Strip any previous background suffix — [[BGMODE]] sentinel is unique and
        // cannot appear in normal GPT-4o frame analysis, so this is completely safe.
        // Use \s* instead of literal space so we don't leave a trailing space.
        parsed.instruction = parsed.instruction.replace(/\s*\[\[BGMODE\]\][\s\S]*$/, '');
        // Strip conflicting "LOCK: background" line when bgmode is active —
        // same fix as in buildNBPromptFromImage to keep patchNbPromptBackground consistent.
        if (useAvatarBg) {
          parsed.instruction = parsed.instruction.replace(/\s*LOCK:\s*background\s*[—–\-][^\n]*/gi, '');
        }
        // Strip any previously appended accessory note to prevent duplication
        const _accNote = getAvatarAccessoryNote();
        if (_accNote) {
          parsed.instruction = parsed.instruction.replace(_accNote.trim(), '').trimEnd();
        }
        // Append new suffix (empty string = background mode off, suffix stripped)
        if (newSuffix) parsed.instruction += newSuffix;
        // Re-append fresh accessory note
        parsed.instruction += getAvatarAccessoryNote();
        parsed.instruction += getProductNBInstruction(i);
        // Keep photo_guide in sync with current background mode state
        const _sceneMatch = (parsed.scene || '').match(/Scene (\d+)/);
        const _sceneNum = _sceneMatch ? parseInt(_sceneMatch[1], 10) : (i + 1);
        if (bgFromAvatar) {
          parsed.photo_guide = `Photo 1 = your avatar (character reference only — face, hair, clothing). Background setting is described in the instruction above.` + getProductPhotoGuide(i);
        } else if (useAvatarBg && bgImageDataUrl) {
          parsed.photo_guide = `Photo 1 = your avatar (character reference only — face, hair, clothing must match). Photo 2 = target background image (place the avatar in front of this setting).` + getProductPhotoGuide(i);
        } else if (useAvatarBg) {
          // No separate bg photo; instruction uses avatar Photo 1 as background reference
          parsed.photo_guide = `Photo 1 = your avatar (character reference only — face, hair, clothing). Background setting is described in the instruction above.` + getProductPhotoGuide(i);
        } else {
          parsed.photo_guide = `Photo 1 = your avatar (person to composite). Photo 2 = Scene ${_sceneNum} reference frame (background/composition to match).` + getProductPhotoGuide(i);
        }
        seg.nbPrompt = JSON.stringify(parsed, null, 2);
        const nbTa = document.getElementById('nb-seg-' + i);
        if (nbTa) { nbTa.value = seg.nbPrompt; autoGrow(nbTa); }
        updated++;
      } catch(_e) { /* leave unchanged on parse error */ }
    });

    if (updated > 0) debounceSave();
    return updated;
  }

  // --- Strip left/right directional language from action descriptions ---
  // Veo 3 interprets left/right from the viewer's POV; GPT-4o describes from
  // the subject's POV — they always come out mirrored. Safer to use neutral terms.
  function sanitizeDirections(text) {
    if (!text) return text;
    return text
      .replace(/\bright\s+hand\b/gi, 'one hand')
      .replace(/\bleft\s+hand\b/gi, 'the other hand')
      .replace(/\bright\s+arm\b/gi, 'one arm')
      .replace(/\bleft\s+arm\b/gi, 'the other arm')
      .replace(/\btheir\s+right\b/gi, 'one side')
      .replace(/\btheir\s+left\b/gi, 'the other side')
      .replace(/\bin\s+(?:the\s+)?right\b/gi, 'in one hand')
      .replace(/\bin\s+(?:the\s+)?left\b/gi, 'in the other hand')
      .replace(/\bto\s+(?:the\s+)?right\b/gi, 'to the side')
      .replace(/\bto\s+(?:the\s+)?left\b/gi, 'to the other side');
  }

  // --- Read the voice style set by the user ---
  function getVoiceStyle() {
    // Avatar-level voice takes priority; fall back to global studio voice field
    const avatarVoice = buildAvatarVoiceString?.() || '';
    const studioVoice = (document.getElementById('studioVoice')?.value || localStorage.getItem('vs_voice_style') || '').trim();
    return avatarVoice || studioVoice;
  }

  // --- Build Veo 3 prompt for one segment ---
  // Detects if a script/action describes a two-person scene
  function detectsTwoPeople(text) {
    if (!text) return false;
    const t = text.toLowerCase();
    return /another person|the other person|points? (at|toward|to) (someone|a person|them|their|his|her)|standing next to|beside (them|a person|someone)|two people|both people|person on the (left|right)|the (man|woman|guy|girl) (on the|to the)|pointing (at|toward|near)|extends?.*(hand|finger).*(toward|at|near|to)|finger (near|at|toward) (their|his|her|the)/.test(t);
  }

  // ── Product CTA Segment helpers ──────────────────────────────

  function _toggleCtaPanel() {
    const body    = document.getElementById('ctaPanelBody');
    const chevron = document.getElementById('ctaPanelChevron');
    if (!body) return;
    const isOpen = body.style.display === 'flex';
    body.style.display = isOpen ? 'none' : 'flex';
    body.style.flexDirection = 'column';
    body.style.gap = '8px';
    if (chevron) chevron.style.transform = isOpen ? '' : 'rotate(180deg)';
    if (!isOpen) {
      const nameIn = document.getElementById('ctaProductNameInput');
      if (nameIn && !nameIn.value.trim())
        nameIn.value = document.getElementById('bkProductName')?.value.trim() || '';
      _refreshCtaPlaceholder();
    }
  }

  function _refreshCtaPlaceholder() { /* no-op — CTA speech field removed */ }

  function _loadCtaProductPhoto(input) {
    const file = input?.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
      const dataUrl = e.target.result;
      window._ctaProductDataUrl = dataUrl;
      const preview = document.getElementById('ctaProductPhotoPreview');
      const ph      = document.getElementById('ctaProductPhotoPlaceholder');
      if (preview) { preview.src = dataUrl; preview.style.display = 'block'; }
      if (ph) ph.style.display = 'none';
      // Save photo to localStorage (only if under 1.5MB base64)
      try {
        if (dataUrl.length < 1572864) localStorage.setItem('cta_product_photo', dataUrl);
        else localStorage.removeItem('cta_product_photo'); // too large — skip
      } catch {}
      _saveCtaState();
    };
    reader.readAsDataURL(file);
  }

  function _saveCtaState() {
    try {
      const name = document.getElementById('ctaProductNameInput')?.value || '';
      localStorage.setItem('cta_product_name', name);
    } catch {}
  }

  function _restoreCtaState() {
    try {
      const name  = localStorage.getItem('cta_product_name') || '';
      const photo = localStorage.getItem('cta_product_photo') || '';
      const nameEl  = document.getElementById('ctaProductNameInput');
      const preview = document.getElementById('ctaProductPhotoPreview');
      const ph      = document.getElementById('ctaProductPhotoPlaceholder');
      if (nameEl && name) nameEl.value = name;
      if (photo && preview) {
        window._ctaProductDataUrl = photo;
        preview.src = photo;
        preview.style.display = 'block';
        if (ph) ph.style.display = 'none';
      }
    } catch {}
  }

  function addCtaSegment() {
    const productName    = (document.getElementById('ctaProductNameInput')?.value || '').trim()
                        || getBrandKit()?.productName || 'the product';
    const productDataUrl = window._ctaProductDataUrl || null;

    if (!productDataUrl) { showToast('Upload a product photo first.', 'warning'); return; }

    const btn = document.getElementById('ctaGenerateBtn');
    pushUndo('Add CTA Segment');
    if (btn) { btn.textContent = '⏳ Adding…'; btn.disabled = true; }

    try {
      const clearSurface = document.getElementById('ctaClearSurface')?.checked || false;
      const voiceStyle   = getVoiceStyle();
      const audioDesc    = voiceStyle
        ? `natural ambient sound, ${voiceStyle} voice tone, no background music`
        : 'natural ambient sound, clear confident voice, no background music';
      const bgNote = segments.length > 0
        ? 'Match the background and environment from the previous scenes exactly. Same lighting, same surface, same props — all locked in place.'
        : 'clean neutral background or lifestyle environment';

      const veoPrompt = JSON.stringify({
        action: `Character holds ${productName} toward camera with label facing forward. Smiles directly at camera with a confident, natural expression.${clearSurface ? ' Surface is clean and clear — no other props or objects visible.' : ''}`,
        speech: '',
        audio: audioDesc,
        duration: '6 seconds',
        negative_prompt: 'text overlays, subtitles, watermarks, AI artifacts, multiple people, cuts, transitions, changed background, blurry label, distorted letters, product rotating',
        camera: 'static handheld, slight natural movement, medium shot — character and product both clearly visible, vertical 9:16',
        background: bgNote,
      }, null, 2);

      const lastEnd = segments.length > 0 ? (segments[segments.length - 1].endTime || 0) : 0;
      segments.push({
        startTime: lastEnd,
        endTime:   lastEnd + 6,
        frameDataUrl: productDataUrl,
        script: '',
        action: `Hold ${productName} toward camera, display label, smile at camera.`,
        veoPrompt,
        isCTA: true,
        ctaProductName: productName,
        done: false,
      });

      debounceSave();
      renderSegments();
      setTimeout(() => {
        const c = document.getElementById('segmentsContainer');
        if (c) c.scrollTo({ left: c.scrollWidth, behavior: 'smooth' });
      }, 180);
      showToast('🛍 CTA segment added — scroll right to see it!', 'success', 4000);

    } catch (err) {
      showToast('Error building CTA: ' + err.message, 'error');
    } finally {
      if (btn) { btn.textContent = '🛍 Add Product CTA Segment'; btn.disabled = false; }
    }
  }

    function buildSegmentVeo3Prompt(i, startTime, endTime, scriptSlice, setting, productName, bgDataUrl) {
    const seg = segments[i];
    const analyzedAction = sanitizeDirections(seg && seg.action ? seg.action : 'person speaking directly to camera with natural confidence and real eye contact, natural hand gestures');
    const _sceneLayout = (seg && seg.sceneLayout) ? seg.sceneLayout.trim() : '';
    const bgNote = bgDataUrl
      ? 'Keep the background exactly as it appears in reference Photo 2 — do not move, add, remove, or change any background element, surface, or prop.'
        + (_sceneLayout ? ' Object positions: ' + _sceneLayout : '')
      : ((setting || 'clean neutral background or lifestyle environment')
        + (_sceneLayout ? ' Object positions: ' + _sceneLayout : ''));
    const actionWithSpeech = analyzedAction;
    const voiceStyle = getVoiceStyle();
    const audioDesc = voiceStyle
      ? `natural ambient sound, ${voiceStyle} voice tone, no background music`
      : 'natural ambient sound, clear voice, no background music';
    // If the script or action describes a two-person scene, remove "multiple people"
    // from the negative_prompt — it will cause Veo 3 to flip or drop one person
    const twoPersonScene = detectsTwoPeople(scriptSlice) || detectsTwoPeople(analyzedAction);
    const negativePrompt = twoPersonScene
      ? 'text overlays, subtitles, watermarks, AI artifacts, cuts, transitions, flipped composition, mirrored subjects, solo person, disappeared person'
      : 'text overlays, subtitles, watermarks, AI artifacts, multiple people, cuts, transitions';
    // Duration: must be exactly 6 or 8 seconds — Veo 3 only supports these two.
    // Always check BOTH the actual clip length AND the speech word count, then take
    // the larger of the two. This prevents short clips with long speech from being
    // assigned "6 seconds" when the words clearly need 8.
    // Snap rule: if either clip or speech exceeds 6s → 8s, otherwise 6s.
    const _wordCount    = (scriptSlice || '').split(/\s+/).filter(Boolean).length;
    const _speechSec    = _wordCount / 2.3;
    const _clipSec      = (typeof startTime === 'number' && typeof endTime === 'number' && endTime > startTime)
      ? endTime - startTime : 0;
    const _maxSec       = Math.max(_clipSec, _speechSec);
    const _duration     = _maxSec > 6 ? 8 : 6;
    const obj = {
      action: actionWithSpeech,
      speech: scriptSlice || '',
      audio: audioDesc,
      duration: _duration + ' seconds',
      negative_prompt: negativePrompt + ', rearranged props, moved objects, changed table contents, new objects added, missing objects, changed background, inconsistent set, morphing text, blurry label, illegible text, distorted letters, warped label, changing text, shifting words',
      camera: 'static handheld, slight natural movement, close-up to medium shot, vertical 9:16',
      background: bgNote,
    };
    return JSON.stringify(obj, null, 2);
  }

  // --- Capture multiple frames from a segment for video analysis ---
  async function captureSegmentFrames(seg, count) {
    const videoElRef = document.getElementById('refVideoEl');
    const savedPlayhead = videoElRef ? videoElRef.currentTime : null;
    const frames = [];
    const step = (seg.endTime - seg.startTime) / (count + 1);
    for (let k = 1; k <= count; k++) {
      const t = seg.startTime + step * k;
      const dataUrl = await captureFrame(t);
      if (dataUrl) frames.push(dataUrl);
    }
    if (videoElRef && savedPlayhead !== null) {
      try { videoElRef.currentTime = savedPlayhead; } catch(_) {}
    }
    return frames;
  }

  // --- Detect pronoun from avatar description ---
  function getAvatarPronoun() {
    const desc = (document.getElementById('avatarDesc') ? document.getElementById('avatarDesc').value : '').toLowerCase();
    if (/\b(woman|female|she|her|girl)\b/.test(desc)) return 'she';
    if (/\b(man|male|he|him|guy|boy)\b/.test(desc)) return 'he';
    return 'they';
  }

  // --- Analyze all segment videos with GPT-4o Vision ---
  async function analyzeAllFrames() {
    if (typeof window.requireAccess === 'function' && !window.requireAccess()) return;
    if (segments.length === 0) { showToast('No segments yet — run Detect Cuts first.', 'warning'); return; }
    const apiKey = getApiKey();
    if (!apiKey) { showToast('AI analysis is not available right now. Please contact the app owner.', 'warning'); return; }

    const pronoun = getAvatarPronoun();
    const btn = document.getElementById('analyzeFramesBtn');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Capturing…'; }

    // ── PHASE 1: Sequential frame capture ─────────────────────────────────────
    // The video element is shared — seeking is sequential, cannot be parallelized.
    // We collect frames for every segment first, then fire all API calls in parallel.
    const frameDataArr = [];
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (btn) btn.textContent = `⏳ Capturing ${i + 1}/${segments.length}…`;
      const FRAME_COUNT = 6;
      const clipStart = seg.startTime;
      const clipEnd   = seg.endTime;
      const clipDur   = clipEnd - clipStart;
      const fmt = s => s.toFixed(1) + 's';
      let liveFrames = [];
      try {
        if (clipDur > 0) {
          const step = clipDur / (FRAME_COUNT + 1);
          const videoElRef = document.getElementById('refVideoEl');
          const savedPlayhead = videoElRef ? videoElRef.currentTime : null;
          for (let k = 1; k <= FRAME_COUNT; k++) {
            const t = clipStart + step * k;
            const raw = await captureFrame(t);
            const f = raw ? await scaleDataUrl(raw, 512) : null;
            if (f) liveFrames.push({ t, f });
          }
          if (videoElRef && savedPlayhead !== null) {
            try { videoElRef.currentTime = savedPlayhead; } catch(_) {}
          }
        }
        // Fall back to the segment's saved thumbnail if the video couldn't be seeked
        if (!liveFrames.length) {
          const fallback = seg.frameDataUrl ? await scaleDataUrl(seg.frameDataUrl, 512) : null;
          if (fallback) liveFrames.push({ t: clipStart, f: fallback });
        }
      } catch(captureErr) {
        console.warn('[analyzeAllFrames] frame capture error seg ' + i, captureErr);
      }
      frameDataArr.push({ seg, i, liveFrames, clipStart, clipEnd, clipDur, fmt });
    }

    // ── PHASE 2: Parallel API calls ────────────────────────────────────────────
    // All segments fire simultaneously — typically 4–8× faster than serial.
    if (btn) btn.textContent = '⏳ Analyzing…';
    let skipped = 0;

    // _concurrentMap throttles to prevent 429 rate errors.
    // Adaptive concurrency: fewer parallel calls for large batches to avoid rate limits.
    const _analyzeConcurrency = frameDataArr.length > 20 ? 1 : frameDataArr.length > 10 ? 2 : 3;
    if (frameDataArr.length > 15 && btn) btn.textContent = '⏳ Analyzing (large batch — pacing API calls)…';
    await _concurrentMap(frameDataArr, async ({ seg, i, liveFrames, clipStart, clipEnd, clipDur, fmt }) => {
        if (liveFrames.length === 0) { skipped++; return; }
        // Stale guard — if segments were re-detected while frames were capturing, bail
        if (!segments[i] || seg !== segments[i]) return;

        const frameLabel   = liveFrames.map(({t}) => `[${fmt(t)}]`).join('  ');
        const imageContent = liveFrames.map(({f}) => ({ type: 'image_url', image_url: { url: f, detail: 'low' } }));

        const _segScript = (seg.script || '').trim();
        const content = [
          {
            type: 'text',
            text: `You are analyzing a VIDEO CLIP from ${fmt(clipStart)} to ${fmt(clipEnd)} (${fmt(clipDur)} long).

The ${liveFrames.length} images below are sequential frames captured at: ${frameLabel}
They are in TIME ORDER — the first image is the start of the clip, the last image is the end. Study how things CHANGE across the sequence.${_segScript ? `

── SCRIPT FOR THIS SCENE (use to identify props and actions) ──
"${_segScript}"
The presenter is saying this while performing the actions you see. Use the script to correctly identify ambiguous props, containers, products, or tools — if the script mentions a bowl, a dropper, a pad, a spoon, a bottle, etc., look for that object in the frames and name it precisely. The script is ground truth for what is being used.` : ''}

Describe ALL visible actions and visual events as a single flowing action description using "${pronoun}" as the subject. This goes into a Veo 3 prompt — every animatable detail matters.

WHAT TO INCLUDE:
1. PERSON ACTIONS — what ${pronoun} is doing with their hands/arms across the clip. Describe the motion arc (starts with → moves to → ends at).
2. PROP & OBJECT INTERACTIONS — identify every object involved. Name it precisely using the script as a guide. What does ${pronoun} do with it? Be specific: "tilts a glass dropper bottle and releases two drops into a wooden bowl" not just "pours something".
3. VISUAL CHANGES & EFFECTS — describe anything that CHANGES between the early frames and the later frames: dissolving, melting, flowing, color change, reaction, transformation. These motion effects are essential for Veo 3 to animate correctly.
4. PHYSICAL MODELS / PROPS — if there is an anatomical model (stomach, gut, liver, organ), food prop, or any demonstration object, name it and describe what it looks like at the START and what it looks like at the END.

RULES:
- Do NOT use "left" or "right" — use "one hand", "the other hand", "both hands", or camera-relative terms (e.g. "held toward camera")
- Do NOT describe the person's appearance, face, clothing, or background
- Do NOT mention, describe, or transcribe any burned-in video text — including animated captions, subtitles, text overlays, or graphic text added in video editing. These are NOT part of the scene. You MAY briefly identify a product name or brand name if it is physically printed on an object the person is actively using or holding. PRODUCT NAME OVERRIDE: If the script (shown above) mentions a specific product name, use that name in the action description — do NOT use a different brand name you see on the label in the frame. The frame may show a competitor's product; the script identifies the correct replacement product.
- Write as a continuous action description, not a bullet list
- Return only the action description — no intro, no commentary`
          },
          ...imageContent
        ];

        try {
          // ── Run action analysis + person-count detection in parallel ──────────
          // Build person-detect prompt — avatar-aware when a reference photo is loaded
          const _hasAvatarRef = !!(typeof avatarImageDataUrl !== 'undefined' && avatarImageDataUrl);
          // Pre-scale avatar to 512px — prevents hitting the 6MB Netlify function body limit
          const _avatarScaled = _hasAvatarRef ? (await scaleDataUrl(avatarImageDataUrl, 512).catch(() => avatarImageDataUrl)) : null;
          const personDetectContent = [
            {
              type: 'text',
              text: _hasAvatarRef
                ? `Photo 1 is a reference portrait of the AVATAR — the specific person we want to identify in a video frame.
Photo 2 is a frame from a video.

Analyze Photo 2 for person composition. Return ONLY valid JSON with no markdown, no explanation:

If exactly 2 people are visible:
{"person_count":2,"left_person":{"gender":"man"|"woman"|"unknown"},"right_person":{"gender":"man"|"woman"|"unknown"},"presenter_side":"left"|"right"}

"presenter_side" = the side of the person in Photo 2 who most closely matches the AVATAR in Photo 1. Compare hair color/style, skin tone, facial features, and body build. Ignore clothing differences. The OTHER person is NOT the avatar.

If only 1 person visible: {"person_count":1}
If 0 or 3+ people visible: {"person_count":0}`
                : `Analyze this video frame for person composition. Return ONLY valid JSON with no markdown, no explanation:

If exactly 2 people are visible:
{"person_count":2,"left_person":{"gender":"man"|"woman"|"unknown"},"right_person":{"gender":"man"|"woman"|"unknown"},"presenter_side":"left"|"right"}

"presenter_side" = the side of the person who is the MAIN PRESENTER: facing the camera directly, speaking or demonstrating a product. The OTHER person (customer, reaction person, subject being treated) should NOT be "presenter_side".

If only 1 person visible: {"person_count":1}
If 0 or 3+ people visible: {"person_count":0}`
            },
            // When avatar is loaded: Photo 1 = avatar reference (scaled to 512px), Photo 2 = video frame
            // When no avatar: just the video frame
            ...(_hasAvatarRef
              ? [
                  { type: 'image_url', image_url: { url: _avatarScaled || avatarImageDataUrl, detail: 'low' } },
                  { type: 'image_url', image_url: { url: liveFrames[0].f,    detail: 'low' } }
                ]
              : [
                  { type: 'image_url', image_url: { url: liveFrames[0].f, detail: 'low' } }
                ]
            )
          ];

          const [res, personRes] = await Promise.all([
            _fetchWithRetry('https://api.openai.com/v1/chat/completions', {
              method: 'POST',
              headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
              body: JSON.stringify({ model: 'gpt-4o', max_tokens: 400, messages: [{ role: 'user', content }] })
            }),
            _fetchWithRetry('https://api.openai.com/v1/chat/completions', {
              method: 'POST',
              headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
              body: JSON.stringify({ model: 'gpt-4o', max_tokens: 120, messages: [{ role: 'user', content: personDetectContent }] })
            })
          ]);

          // ── Process person-count result (non-blocking — errors are silently skipped) ──
          try {
            const personData = await personRes.json().catch(() => ({}));
            const personRaw = personData.choices?.[0]?.message?.content?.trim() || '';
            let personJSON = personRaw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
            const pStart = personJSON.indexOf('{'); const pEnd = personJSON.lastIndexOf('}');
            if (pStart !== -1 && pEnd !== -1) personJSON = personJSON.slice(pStart, pEnd + 1);
            const pd = JSON.parse(personJSON);

            if (pd.person_count === 2 && pd.presenter_side && pd.left_person && pd.right_person) {
              // Guard: segment may have been removed while the API call was in flight
              if (segments.indexOf(seg) === -1) return;
              // Only auto-set if not already manually configured
              if (seg.targetPerson == null && seg.targetX == null) {
                const presenterSide = pd.presenter_side; // 'left' or 'right'
                const presenterGender = presenterSide === 'left' ? pd.left_person.gender : pd.right_person.gender;
                const secondaryGender = presenterSide === 'left' ? pd.right_person.gender : pd.left_person.gender;
                const secondarySide = presenterSide === 'left' ? 'right' : 'left';

                seg.targetPerson = presenterSide;
                seg.targetGender = presenterGender !== 'unknown' ? presenterGender : null;
                seg.targetX = presenterSide === 'left' ? 25 : 75;
                seg.targetY = 50;

                // Auto-fill scene notes only if empty
                if (!(seg.sceneNotes || '').trim()) {
                  seg.sceneNotes = 'two people: ' + presenterGender + ' on ' + presenterSide.toUpperCase() + ' (avatar replaces this person) · ' + secondaryGender + ' on ' + secondarySide.toUpperCase() + ' (keep unchanged)';
                  const currentIdx2 = segments.indexOf(seg);
                  const notesEl = document.getElementById('notes-seg-' + (currentIdx2 >= 0 ? currentIdx2 : i));
                  if (notesEl) { notesEl.value = seg.sceneNotes; autoGrow(notesEl); notesEl.style.borderColor = 'rgba(96,165,250,0.7)'; setTimeout(() => { if (notesEl) notesEl.style.borderColor = ''; }, 1500); }
                }

                // Refresh the target dot on the frame thumbnail
                const currentIdx3 = segments.indexOf(seg);
                if (typeof renderSegmentCard === 'function' && currentIdx3 >= 0) {
                  try { renderSegmentCard(currentIdx3); } catch(_) {}
                }
              }
            }
          } catch(_) { /* person detection is best-effort — never block the main flow */ }

          const data = await res.json().catch(() => ({}));
          if (!res.ok) { skipped++; showToast('Frame analysis error: ' + (data?.error?.message || 'API error ' + res.status), 'error'); return; }
          if (data.error) { skipped++; showToast('Frame analysis error: ' + (data.error.message || data.error), 'error'); return; }
          let description = data.choices?.[0]?.message?.content?.trim() || '';

          // If OpenAI refused the image, retry with only the start frame
          const isRefusal = !description || /i('m| am) sorry|can't assist|cannot assist|I apologize|unable to (help|assist)/i.test(description);
          if (isRefusal && liveFrames.length > 1) {
            const retryContent = [
              { type: 'text', text: `Describe ALL visible actions and visual events in this image using "${pronoun}" as the subject. Short action sentences only. Include: what ${pronoun} is doing with their hands/arms, any objects or props being used, and any visible demonstration effects (dissolving, melting, flowing, reacting). If there is a physical model (stomach, organ, food prop) describe what is happening to it. Do NOT use "left" or "right" — use "one hand", "the other hand", or camera-relative terms. Do NOT mention or transcribe any burned-in video captions, subtitles, or text overlay graphics. You MAY briefly identify product names physically printed on objects being held — but if the script identifies the product by a specific name, use that name instead of the label on the container. No identity, no appearance, no background setting.` },
              { type: 'image_url', image_url: { url: liveFrames[0].f, detail: 'low' } }
            ];
            const retryRes = await _fetchWithRetry('https://api.openai.com/v1/chat/completions', {
              method: 'POST',
              headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
              body: JSON.stringify({ model: 'gpt-4o', max_tokens: 200, messages: [{ role: 'user', content: retryContent }] })
            });
            if (!retryRes.ok) { showToast('Frame retry failed (seg ' + (i+1) + '): ' + retryRes.status, 'warning'); skipped++; return; }
            const retryData = await retryRes.json().catch(() => ({}));
            description = retryData.choices?.[0]?.message?.content?.trim() || '';
          }

          if (!description || /i('m| am) sorry|can't assist|cannot assist/i.test(description)) { skipped++; return; }
          // Stale guard — re-check after awaits
          if (!segments[i] || !segments.includes(seg)) return;

          // Strip any text-overlay/caption references GPT included despite the rule
          description = description
            .replace(/\b(text\s+overlay|on[\s-]?screen\s+text|burned[\s-]?in\s+text)[^.;]*[.;]?\s*/gi, '')
            .replace(/\btext\s+reads?\s+["'\u201c\u201d\u2018\u2019][^"'\u201c\u201d\u2018\u2019]*["'\u201c\u201d\u2018\u2019]\s*/gi, '')
            .replace(/\btext\s+reads?\b[^.;,]*[.;,]?\s*/gi, '')
            .replace(/\bcaptions?\s+(reads?|says?|display)[^.;]*[.;]?\s*/gi, '')
            .replace(/\bsubtitles?\s+(reads?|says?|appear)[^.;]*[.;]?\s*/gi, '')
            .replace(/\s{2,}/g, ' ')
            .trim();
          seg.action = sanitizeDirections(description);
          // Product name override: if brand kit has a product name and this segment
          // shows the product, replace any competitor product name the action may mention
          if (seg.showProduct) {
            const _bkProd = (typeof getBrandKit === 'function') ? (getBrandKit().productName || '') : '';
            const _segScript = (seg.script || '').trim();
            if (_bkProd && seg.action) {
              // Extract product name from script if it differs from what's in the action
              const _scriptProdMatch = _segScript.match(/\b([A-Z][a-z]+(?:\s+[A-Za-z]+){0,3}(?:\s+(?:toner\s+pads?|pads?|serum|cream|oil|drops?|capsules?|gummies?|powder|spray)))/i);
              if (_scriptProdMatch && !seg.action.toLowerCase().includes(_bkProd.toLowerCase())) {
                seg.action = seg.action.replace(new RegExp(_scriptProdMatch[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), _bkProd);
              }
            }
          }

        } catch(e) {
          console.warn('[analyzeScene] frame analysis failed at seg ' + (i + 1) + ':', e);
          skipped++;
        }
    }, _analyzeConcurrency);

    if (typeof renderSegments === 'function') renderSegments();
    if (typeof saveSegments === 'function') saveSegments();
    if (skipped > 0) showToast(skipped + ' scene' + (skipped !== 1 ? 's' : '') + ' skipped.', 'warning');
  }