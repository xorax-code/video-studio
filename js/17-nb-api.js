  // ===== NB COMPOSITE API =====
  // Generates Nano Banana composite images via Gemini 2.0 Flash image generation.
  // Flow: extract NB instruction → call /.netlify/functions/generate-nb-composite
  //       → store result in seg.nbPreviewDataUrl → show approval modal

  // Quote-safe escaping for values interpolated into HTML attribute strings.
  // Prevents labels/descriptions containing " ' < > & from breaking out of attributes.
  function escAttr(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ── Compress image to max pixels before sending ───────────────────────────
  function _nbCompressImage(dataUrl, maxPx, quality) {
    maxPx = maxPx || 1280;
    quality = quality || 0.9;
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

  // Build an image data: URL from server-returned base64, validating the mime.
  // Server-supplied mime is untrusted; only allow image/* and fall back to PNG.
  function _nbImageDataUrl(mime, b64) {
    var safeMime = (typeof mime === 'string' && /^image\//.test(mime)) ? mime : 'image/png';
    return 'data:' + safeMime + ';base64,' + b64;
  }

  // ── Async composite: start a background job, then poll for the result ─────
  // Vertex's global image endpoint runs 20-30s, past Netlify's 26s synchronous
  // limit. So we POST to the BACKGROUND worker (returns instantly, may run 15
  // min) and poll poll-nb-composite until the image is ready — the timeout stops
  // mattering. Returns { res, data } in the SAME shape the old sync fetch used,
  // so every caller works unchanged. `label` prefixes the optional "rendering…" cue.
  // Run ONE async job: start the background worker, then poll for the result.
  // Returns { res:{ok,status}, data:{imageB64,mime,quality,creditsDeducted,error} }.
  async function _nbRunOneJob(bodyObj, jwt, label) {
    var jobId = (window.crypto && window.crypto.randomUUID)
      ? window.crypto.randomUUID()
      : ('job-' + Date.now() + '-' + Math.random().toString(36).slice(2));

    // SYNCHRONOUS-PRIMARY. We call generate-nb-composite directly and get the image
    // back inline. The background worker was returning RAW 500s with empty bodies
    // (no top-level try/catch in that handler), which surfaced as blank error pop-ups.
    // The sync handler is fully wrapped and ALWAYS returns a readable {error:...} body,
    // so either it works or it tells us exactly what's wrong. On Pro the 26s function
    // window covers a Flash composite. (jobId kept for log correlation only.)
    var tell;
    if (typeof showToast === 'function') {
      tell = setTimeout(function () {
        showToast((label ? label + ': ' : '') + 'rendering…', 'info', 8000);
      }, 4000);
    }
    var res, data = {};
    try {
      res = await fetch('/.netlify/functions/generate-nb-composite', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + jwt },
        body:    JSON.stringify(Object.assign({ jobId: jobId }, bodyObj)),
      });
    } catch (e) {
      if (tell) clearTimeout(tell);
      return { res: { ok: false, status: 0 }, data: { error: 'Could not reach generation service: ' + (e && e.message || e) } };
    }
    if (tell) clearTimeout(tell);

    try { data = await res.json(); } catch(_) { data = {}; }

    if (res.ok && data.imageB64) {
      return { res: { ok: true, status: 200 }, data: { imageB64: data.imageB64, mime: data.mime, quality: data.quality, creditsDeducted: data.creditsDeducted } };
    }
    // Any non-2xx, or a 2xx with no image: surface the server's real message.
    return {
      res:  { ok: false, status: res.status },
      data: { error: data.error || data.message || ('Generation failed (HTTP ' + res.status + ')') },
    };
  }

  // Public entry: runs a job and auto-retries the WHOLE job on a rate limit (429).
  // A 429 produced no image and charged nothing, so re-submitting is safe.
  async function _nbGenerateAsync(bodyObj, jwt, label) {
    // Longer, exponential backoff for the image model's tight quota; jitter de-syncs
    // concurrent retries so they don't all re-hit the limit at the same instant.
    var RL_WAITS = [0, 10000, 22000, 40000, 60000]; // up to 5 attempts (~132s of backoff)
    var out;
    for (var a = 0; a < RL_WAITS.length; a++) {
      if (RL_WAITS[a]) {
        var _w = RL_WAITS[a] + Math.floor(Math.random() * 4000);
        if (typeof showToast === 'function') showToast((label ? label + ': ' : '') + 'rate limited — retrying in ' + Math.round(_w / 1000) + 's…', 'warning', _w);
        await new Promise(function (r) { setTimeout(r, _w); });
      }
      out = await _nbRunOneJob(bodyObj, jwt, label);
      if (!(out.res && out.res.status === 429) || a === RL_WAITS.length - 1) return out;
    }
    return out;
  }
  window._nbGenerateAsync = _nbGenerateAsync;

  // Back-compat wrapper — existing callers (hand ref, Producer, Flow Studio) keep
  // calling _nbPostComposite and transparently get the async start+poll flow.
  function _nbPostComposite(bodyObj, jwt, label) {
    return _nbGenerateAsync(bodyObj, jwt, label);
  }
  window._nbPostComposite = _nbPostComposite;

  // ── Generate NB composite for a single segment ────────────────────────────
  async function generateNbComposite(segIdx, stylizeLevel, framingLevel) {
    stylizeLevel = stylizeLevel | 0; // 0 = base polished look; higher = more stylized (used by safety-filter retries)
    framingLevel = framingLevel | 0; // 0 = normal medium shot; higher = pull back wider (Veo block auto-escalate)
    var seg = segments[segIdx];
    if (!seg) { showToast('Segment not found.', 'error'); return false; }

    var nbPromptRaw = (seg.nbPrompt || '').trim();
    if (!nbPromptRaw && !seg.frameDataUrl) {
      showToast('Generate prompts first — Scene ' + (segIdx + 1) + ' has no NB prompt yet.', 'warning');
      return false;
    }

    if (!avatarImageDataUrl) {
      showToast('Upload your avatar photo first.', 'warning');
      return false;
    }

    // Wait for the one-time avatar prep (stylize) to finish so the de-photorealized
    // avatar base is used for the frame — not the raw uploaded photo. Resolves
    // instantly once prep is done; never blocks if prep failed or wasn't started.
    if (window._avatarPrepPromise) { try { await window._avatarPrepPromise; } catch(_) {} }

    // Get JWT for auth
    var jwt = null;
    try {
      var _sbRef = (typeof _sb !== 'undefined' && _sb) ? _sb : window._sb;
      if (_sbRef) {
        var sessionRes = await _sbRef.auth.getSession();
        jwt = (sessionRes && sessionRes.data && sessionRes.data.session && sessionRes.data.session.access_token) || null;
      }
    } catch(_) {}
    if (!jwt) { showToast('Please log in to generate NB composites.', 'warning'); return false; }

    // Compress images before sending. Max Quality = sharper (1280/0.9) but more likely to
    // trip Veo's "real person" safety filter on FACE shots. Default = softer (768/0.8),
    // which is what reliably passes Veo for talking-head frames (the working state).
    var _nbPx = window._nbMaxQuality ? 1280 : 768;
    var _nbJq = window._nbMaxQuality ? 0.9  : 0.8;
    // Memoize the avatar compression — a multi-scene batch would otherwise re-encode
    // the identical avatar once per scene. Cache keyed by source + target px/quality.
    var avatarCompressed;
    var _avc = window._nbAvCompCache;
    if (_avc && _avc.src === avatarImageDataUrl && _avc.px === _nbPx && _avc.jq === _nbJq) {
      avatarCompressed = _avc.out;
    } else {
      avatarCompressed = await _nbCompressImage(avatarImageDataUrl, _nbPx, _nbJq);
      window._nbAvCompCache = { src: avatarImageDataUrl, px: _nbPx, jq: _nbJq, out: avatarCompressed };
    }
    var avatarParts = _nbSplitDataUrl(avatarCompressed);

    var frameB64 = null, frameMime = 'image/jpeg';
    // ANCHOR FRAME (background consistency): producer script-only scenes have no
    // per-scene source frame. The batch generates the FIRST scene as the video's
    // anchor (window._producerAnchorFrame); every later scene then uses that anchor as
    // its base frame so the SET stays identical — same room, camera, props — and only
    // the avatar's action changes. Replicator scenes keep their own source frame.
    // Final framing escalation (level >= 2): DROP the frame and switch to generate-mode
    // (a fresh WIDE scene that reliably clears Veo's filter).
    var _frameSrc = seg.frameDataUrl || (window._producerAnchorFrame || null);
    var hasFrame = !!_frameSrc && framingLevel < 2;
    if (hasFrame) {
      var frameCompressed = await _nbCompressImage(_frameSrc, _nbPx, _nbJq);
      var frameParts = _nbSplitDataUrl(frameCompressed);
      frameB64 = frameParts.b64;
      frameMime = frameParts.mime;
    }

    // ── Product reference (optional) — make the avatar's product the real one ──
    // Gated ENTIRELY on the per-segment product toggle (seg.showProduct — the product
    // icon next to Split). Only segments the user explicitly marks get the product:
    //   Replicator (real frame)  → REPLACE the held product with the uploaded one.
    //   Producer (no frame)       → the generated avatar HOLDS the exact product.
    var productB64 = null, productMime = 'image/jpeg', hasProduct = false;
    try {
      var _prodUrl = (typeof productImageDataUrl !== 'undefined' && productImageDataUrl)
        || window._producerProductImageUrl || null;
      if (_prodUrl && seg.showProduct) {
        var prodCompressed = await _nbCompressImage(_prodUrl, _nbPx, _nbJq);
        var prodParts = _nbSplitDataUrl(prodCompressed);
        productB64 = prodParts.b64;
        productMime = prodParts.mime;
        hasProduct = true;
      }
    } catch(_) {}

    // ── Locked hand reference (optional) — keeps the hand identical across frames ──
    // When the user has locked a hand, send it on every frame that composites onto a
    // real reference frame, so the hand's skin/bracelet/sleeve stay consistent.
    var handRefB64 = null, handRefMime = 'image/jpeg';
    try {
      var _handUrl = window._handRefDataUrl || null;
      if (!_handUrl && typeof DB !== 'undefined' && DB && DB.get) {
        try { _handUrl = await DB.get('sm_hand_ref_img'); if (_handUrl) window._handRefDataUrl = _handUrl; } catch(_) {}
      }
      if (_handUrl && hasFrame) {
        var handCompressed = await _nbCompressImage(_handUrl, _nbPx, _nbJq);
        var handParts = _nbSplitDataUrl(handCompressed);
        handRefB64 = handParts.b64;
        handRefMime = handParts.mime;
      }
    } catch(_) {}

    // ── Build instruction for Imagen 3 based on what photos are available ──────
    // When a video frame exists: avatar (SUBJECT ref) + frame (STYLE ref for background).
    // When avatar only: generate a fresh lifestyle frame from the NB prompt context.
    var instruction;
    var _nbNegativePrompt = '';

    // Read avatar text description — reinforces the SUBJECT image reference in text
    var _avatarDesc = (document.getElementById('avatarDesc') ? document.getElementById('avatarDesc').value.trim() : '');

    // Parse NB prompt JSON once — used by both paths
    var _nbParsedObj = {};
    try { _nbParsedObj = JSON.parse(nbPromptRaw); } catch(_) { _nbParsedObj = {}; }
    var _cleanStr = function(s) {
      return (s || '').replace(/NanoBanana[^.]*\.\s*/gi, '').replace(/INPUT:[^.]*\.\s*/gi, '').trim();
    };

    // Extract all NB prompt fields
    var _nbCore        = _cleanStr(_nbParsedObj.instruction || (typeof nbPromptRaw === 'string' && !nbPromptRaw.startsWith('{') ? nbPromptRaw : ''));
    var _nbSetting     = _cleanStr(_nbParsedObj.setting || '');
    var _nbFraming     = _cleanStr(_nbParsedObj.framing || '');
    var _nbExpression  = _cleanStr(_nbParsedObj.expression || '');
    var _nbStyle       = _cleanStr(_nbParsedObj.style || '');
    var _nbBgRef       = _cleanStr(_nbParsedObj.background_reference || '');
    var _nbVisualDesc  = _cleanStr(_nbParsedObj.visual_description || '');
    _nbNegativePrompt  = _cleanStr(_nbParsedObj.negative_prompt || '');

    var _segAction = (seg.action || '').trim();

    // ── Locked background ──────────────────────────────────────────────────
    // When the user has locked a background (useAvatarBg + extracted bgDescription),
    // it MUST win over the scene's own setting on every frame — Producer presets
    // (e.g. the apothecary) were overriding it. Force it into the setting/bg fields
    // here, and a hard override directive is appended to the instruction below.
    var _lockedBg = '';
    try {
      if ((typeof useAvatarBg !== 'undefined' && useAvatarBg) && (typeof bgDescription !== 'undefined' && bgDescription)) {
        _lockedBg = String(bgDescription).trim();
      }
    } catch(_) {}
    if (_lockedBg) { _nbBgRef = _lockedBg; _nbSetting = _lockedBg; }

    // ── Green-screen overlay mode ──────────────────────────────────────────────
    // For "composite scenes" (a talking person in FRONT of a screen-recording / app
    // UI that we can't separate), we do NOT bake the avatar into the locked reference
    // background. Instead we render the avatar ALONE on a flat chroma-green screen,
    // matched to the reference person's position / scale / pose, so it can be keyed
    // out and composited OVER the untouched original clip (real moving UI shows through
    // around her). Gated on a global toggle or a per-segment flag.
    var _greenOverlay = false;
    try { _greenOverlay = !!(window._greenScreenOverlay || (seg && seg.overlayGreen)); } catch(_) {}

    if (hasFrame && _greenOverlay) {
      // Use Photo 2 (reference frame) ONLY as a pose/scale/framing reference — its
      // background is discarded and replaced with solid chroma green for keying.
      var _gsParts = [];
      _gsParts.push('[FULL PERSON] REPLACE: the person from Photo 2 with the avatar from Photo 1. Match the avatar to the position, scale, body angle, arm height, and hand/finger pose of the person in Photo 2 EXACTLY, so the avatar occupies the same silhouette on screen.');
      _gsParts.push('BACKGROUND REPLACE (critical): DISCARD the entire environment, app UI, charts, text, screen recording, props, and lighting from Photo 2. Output ONLY the avatar on a perfectly flat, solid chroma-green background (color #00b140 / RGB 0,177,64), edge to edge, evenly lit, no gradient, no shadows cast on the green, no logos, no text, nothing but the avatar and the green.');
      if (_avatarDesc) _gsParts.push('HAIR LOCK: Avatar — ' + _avatarDesc + '. Reproduce this person\'s face, skin tone, and hair exactly. Do NOT copy hair or features from the Photo 2 person.');
      _gsParts.push('GENDER LOCK: Match Photo 1 person\'s gender, age, and ethnicity exactly. Do NOT change under any circumstances.');
      if (_segAction) _gsParts.push('ARM/POSE: ' + _segAction + '. Keep the arm and hand at the same reach and height as Photo 2 so gestures line up with the underlying footage.');
      if (hasProduct) _gsParts.push('The product from Photo 3 must be held in the hand at the same position as Photo 2.');
      _gsParts.push('LIGHTING: light the avatar with soft, even, neutral studio key light (clean white balance) so she keys cleanly — do NOT relight her to any scene, and keep spill/reflected green off her skin, hair edges, and clothing.');
      _gsParts.push('Framing: ' + (_nbFraming || 'vertical 9:16, medium shot, subject chest-up with headroom, 50mm') + '. Keep the subject at the same on-screen position and size as Photo 2.');
      _gsParts.push('RENDER STYLE: natural, real-looking photographic person (realistic skin texture, subtle pores, NOT plastic/waxy/over-smoothed; NOT a 3D render, illustration, or cartoon). ONE person only. No text, no watermark, no UI.');
      _gsParts.push('IMPORTANT: the background must remain a single uniform chroma-green fill with hard, clean edges around the subject for reliable keying.');
      instruction = _gsParts.join(' ');
      // Green-screen output must not carry any transferred UI/text.
      _nbNegativePrompt = (_nbNegativePrompt ? _nbNegativePrompt + ', ' : '') + 'text, logos, app UI, charts, numbers, screen recording, patterned background, green spill on subject, colored rim light';

    } else if (hasFrame) {
      // ── Compositing mode ──────────────────────────────────────────────────────
      // The NB prompt JSON's `instruction` field (_nbCore) is a complete NB Pro
      // instruction in Flow format (REPLACE / LOCK / ARM / PROP STATE / HAIR LOCK /
      // GENDER LOCK / TRANSFER BLOCK / LIGHTING MATCH). Use it directly.
      // Do NOT wrap it in another instruction layer — that causes every section to
      // appear twice, which confuses the model and produces wrong results.

      if (_nbCore) {
        // Complete Flow-format instruction: use as-is.
        instruction = _nbCore;
      } else {
        // No instruction field — build minimal fallback from the other NB prompt fields.
        var _hfParts = [];
        _hfParts.push('[FULL PERSON] REPLACE: target person — match position and scale from Photo 2. Camera angle: straight-on, chest height.');
        var _lockLine = 'LOCK: background — preserve the environment, props, and lighting from Photo 2 exactly.';
        if (_nbVisualDesc) _lockLine += ' Scene: ' + _nbVisualDesc + '.';
        if (_nbSetting)    _lockLine += ' Setting: ' + _nbSetting + '.';
        if (_nbBgRef)      _lockLine += ' ' + _nbBgRef + '.';
        _hfParts.push(_lockLine);
        if (_segAction) {
          _hfParts.push('ARM: ' + _segAction + '.');
          _hfParts.push('POSE LOCK: Match the arm height, angle, and reach from Photo 2 exactly — do NOT default to arms at sides.');
          _hfParts.push('PROP STATE: Prop must be in avatar\'s hand at exact position shown in Photo 2.');
        }
        _hfParts.push('LIGHT: ' + (_nbStyle || 'warm ambient') + '. Match Photo 2 lighting exactly.');
        if (_avatarDesc) _hfParts.push('HAIR LOCK: Avatar — ' + _avatarDesc + '. Do NOT copy hair or features from Photo 2 person.');
        _hfParts.push('GENDER LOCK: Match Photo 1 person\'s gender, age, and ethnicity exactly. Do NOT change under any circumstances.');
        _hfParts.push('TRANSFER BLOCK: No text, logos, labels, or graphical overlays from Photo 2 in the output.');
        _hfParts.push('RELIGHT (critical for realism): Fully RELIGHT the avatar to sit naturally inside Photo 2\'s environment — match the scene\'s light DIRECTION, COLOR TEMPERATURE / white balance (warm vs cool), overall BRIGHTNESS/exposure, contrast, and shadow softness exactly. DISCARD the original lighting and white balance baked into the avatar reference photo; the avatar must look genuinely photographed in THIS room under THIS light, not pasted on top. The avatar must NOT be brighter, warmer, more contrasty, or more saturated than the rest of the scene. Add soft contact shadows consistent with the scene\'s key light so the avatar is grounded in the space and shares the same color grade as the background.');
        if (_nbExpression) _hfParts.push('Expression: ' + _nbExpression + '.');
        _hfParts.push('Framing: ' + (_nbFraming || 'vertical 9:16, medium shot (waist-up, face not filling the frame), subject centered with headroom, 50mm, gentle depth of field') + '. Single premium image — realistic natural skin texture (subtle pores, not plastic or over-smoothed), gentle soft natural lighting. ONE person only.');
        // RENDER-STYLE OVERRIDE — the decisive lever against Veo's person-likeness filter
        // (15236754). Veo blocks LITERAL photographs of real-looking people; a lightly
        // stylized render reads as "digital character", not "real person to deepfake".
        // Aim for the sweet spot: premium + flattering, clearly NOT a literal photo, but
        // NOT a hard cartoon. (Applies even when a scene's saved style said "realistic".)
        _hfParts.push('RENDER STYLE: render as a natural, REAL-LOOKING photograph — authentic and photographic, with realistic skin texture (keep subtle pores and fine detail; NOT plastic, waxy, glossy, or over-smoothed) and lighting that matches the scene per RELIGHT above (do NOT add separate bright/flattering light to the avatar). Keep it a genuine photo look (NOT a 3D render, illustration, anime, or cartoon) and the same clearly-recognizable person — natural rather than airbrushed, with no glossy AI sheen.');
        // ZOOM-OUT OVERRIDE — a face filling the frame also trips 15236754.
        _hfParts.push('IMPORTANT FRAMING OVERRIDE: ALWAYS render a MEDIUM SHOT, even if the source is a tight close-up or shows two people — pull the camera back so every person is chest-up with clear headroom and visible surroundings, and NO single face is larger than ~25% of the frame height. Err on the side of too wide. Do NOT crop in tight on the face — a large face trips the person filter.');
        instruction = _hfParts.join(' ');
      }

    } else {
      // ── Generate mode — NB Pro structured format ─────────────────────────────
      // No reference frame — generate a fresh lifestyle starting frame for the avatar.
      var _gParts = [];

      // Header
      _gParts.push('[FULL PERSON] Generate the avatar from the SUBJECT reference image in a lifestyle scene.');

      // Avatar description reinforcement
      if (_avatarDesc) _gParts.push('HAIR LOCK: Avatar — ' + _avatarDesc + '. Reproduce this person\'s face, skin tone, hair, and clothing exactly.');

      // Core instruction from NB prompt
      if (_nbCore) {
        _gParts.push(_nbCore);
      } else {
        _gParts.push('Generate a natural, REAL-LOOKING photo of this person facing the camera with a natural engaged expression — authentic and photographic, realistic skin texture (subtle pores and fine detail; NOT plastic, waxy, or over-smoothed), soft natural flattering light; a genuine photo look (NOT a 3D render, illustration, anime, or cartoon); natural rather than airbrushed, no glossy AI sheen.');
      }

      // Scene / setting / background
      if (_nbSetting)    _gParts.push('Setting: ' + _nbSetting + '.');
      if (_nbBgRef)      _gParts.push(_nbBgRef);
      if (_nbVisualDesc) _gParts.push('Scene: ' + _nbVisualDesc + '.');

      // ARM / pose
      if (_segAction) {
        _gParts.push('ARM: ' + _segAction + '.');
      }

      // Expression
      if (_nbExpression) _gParts.push('Expression: ' + _nbExpression + '.');

      // Standard locks
      _gParts.push('GENDER LOCK: The avatar must match the exact gender, approximate age, and ethnicity of the person in the SUBJECT reference. Do NOT change the avatar\'s gender, age, or ethnicity.');
      _gParts.push('TRANSFER BLOCK: Do NOT add any text, logos, dates, or labels to the output.');
      _gParts.push('RELIGHT: Light the avatar with the SAME light as the generated scene — one consistent color temperature, direction, exposure, and contrast across the person and the background. DISCARD the lighting/white-balance baked into the avatar reference; the avatar must not be brighter, warmer, or more saturated than the scene, and should share the same color grade so nothing looks pasted in.');

      // Technical
      _gParts.push('Framing: ' + (_nbFraming || 'vertical 9:16, medium shot (waist-up, face not filling the frame), subject centered with headroom, 50mm, gentle depth of field') + '.');
      // RENDER-STYLE OVERRIDE — decisive lever vs Veo's person filter (15236754).
      // See note in the hand-frame branch. Lightly stylized → reads as digital character.
      _gParts.push('RENDER STYLE: render as a natural, REAL-LOOKING photograph — authentic and photographic, with realistic skin texture (keep subtle pores and fine detail; NOT plastic, waxy, glossy, or over-smoothed) and soft natural flattering light. Keep it a genuine photo look (NOT a 3D render, illustration, anime, or cartoon) and the same clearly-recognizable person — natural rather than airbrushed, with no glossy AI sheen.');
      // ZOOM-OUT OVERRIDE — a face filling the frame trips Veo 15236754.
      _gParts.push('IMPORTANT FRAMING OVERRIDE: ALWAYS render a MEDIUM SHOT, even if the source is a tight close-up or shows two people — pull the camera back so every person is chest-up with clear headroom and visible surroundings, and NO single face is larger than ~25% of the frame height. Err on the side of too wide. Do NOT crop in tight on the face — a large face trips the person filter.');
      _gParts.push('Style: premium real-looking lifestyle photo. Single image. ONE person only. No text overlays, no watermarks.');

      instruction = _gParts.join(' ');
    }

    // Compositing mode (Replicator): reinforce the held-product swap in the instruction.
    // Generate mode (Producer): the backend adds its own "EXACT PRODUCT" directive.
    if (hasProduct && hasFrame) {
      instruction += ' PRODUCT REPLACE (critical): The object held in the hand must be REPLACED with the product shown in Photo 3. Keep the same hand, grip, finger positions, scale, and arm pose, but the held product\'s shape, color, packaging, label, and text must match Photo 3 exactly. Do NOT keep or blend the original product from the scene frame.';
    }

    // ── Global render-style override (escalates on safety-filter retries) ────
    // Veo's likeness filter trips on faces that read as a real, identifiable
    // photographed person. This pushes the PERSON toward a polished digital-creator
    // render while keeping the scene premium. Higher stylizeLevel = softer/more
    // stylized, used automatically when a clip gets filtered (see veo retry).
    // Escalation increases STYLIZATION, not blur — blur was proven not to clear Veo's
    // person filter (a 212px soft photo of a face still blocks). A clearly-rendered/
    // digital look is what passes, so each retry pushes further from "literal photo".
    var _styleLevels = [
      ' RENDER STYLE: natural, REAL-LOOKING photograph — authentic and photographic, realistic skin texture (subtle pores and fine detail; NOT plastic, waxy, or over-smoothed), soft natural flattering light. A genuine photo look (NOT a 3D render, illustration, anime, or cartoon); natural rather than airbrushed, with no glossy AI sheen.',
      ' RENDER STYLE (more stylized): clearly a polished digital-character render — smooth simplified skin, soft painterly/editorial finish, noticeably not a real photograph; still flattering and recognizably the same person, premium look, not a hard cartoon.',
      ' RENDER STYLE (max stylized): strongly stylized digital render / editorial illustration of the person — simplified smooth features, soft finish, clearly NOT a photograph of a real individual; keep it human, premium, and recognizable, leaning illustrative to guarantee it clears the person filter.'
    ];
    instruction += _styleLevels[Math.max(0, Math.min(_styleLevels.length - 1, stylizeLevel))];

    // Framing escalation — applied when a Veo clip was blocked for being too photoreal
    // a person: each level pulls the camera back further so the face shrinks (the proven
    // lever), and strips any wall posters/charts (the recitation lever). Level 0 = none.
    var _framingEscalation = [
      '',
      ' FRAMING ESCALATION (the previous frame was blocked): pull the camera back FURTHER — show the full upper body / waist-up with generous space around the subject; the face must be SMALL, no more than ~18% of the frame height. Remove ALL wall posters, charts, and artwork — use a plain empty wall.',
      ' FRAMING ESCALATION (blocked again): WIDE shot now — the person is small within the frame with lots of room and plain environment around them, face tiny. Absolutely no posters, charts, diagrams, logos, or artwork anywhere — plain empty background only.'
    ];
    instruction += _framingEscalation[Math.max(0, Math.min(_framingEscalation.length - 1, framingLevel))];

    // ── SHOT VARIATION (script-only "anchor" scenes) ───────────────────────────
    // Producer/script-only scenes all composite onto scene 1's anchor frame, which
    // otherwise makes every start frame an identical clone of scene 1's pose. For
    // these scenes, KEEP the person/outfit/room/lighting from the anchor but force a
    // DIFFERENT camera framing, angle, and pose per scene (+ inject the scene's own
    // action) so each slide is a distinct shot. Replicator scenes (their own real
    // frame) are untouched — they must match their source pose. Framing escalation
    // (a Veo block) takes over, so suppress variation while pulling back.
    var _isAnchorClone = hasFrame && !seg.frameDataUrl && !!window._producerAnchorFrame && framingLevel < 1;
    if (_isAnchorClone) {
      // Prefer the AI DIRECTOR's per-scene shot plan (seg.framing / seg._shot). Only fall
      // back to a fixed rotation when no plan exists, so scenes still vary either way.
      var _shotPlan = (seg.framing || '').trim();
      if (!_shotPlan && seg._shot) {
        var _shotMap = {
          'close':           'a closer framing on the hands/product (face still small — NOT a tight face crop)',
          'medium':          'a medium waist-up shot, straight-on, subject centered with headroom',
          'wide':            'a wider shot showing more of the room, the subject smaller in frame',
          'product-insert':  'the product held up toward the camera (product close and prominent, the face small in frame)',
          'product insert':  'the product held up toward the camera (product close and prominent, the face small in frame)'
        };
        _shotPlan = _shotMap[String(seg._shot).toLowerCase()] || '';
      }
      if (!_shotPlan) {
        var _shots = [
          'a medium waist-up shot, straight-on, subject centered with headroom',
          'a slight-angle medium shot, the subject just off-center',
          'a wider shot showing more of the room, the subject smaller in frame with the product clearly visible',
          'a medium shot with the product held up toward the camera (product close and prominent, the face still small in frame)',
          'a slightly low-angle medium shot, the subject turned toward the counter mid-action'
        ];
        _shotPlan = _shots[((segIdx % _shots.length) + _shots.length) % _shots.length];
      }
      // Skip continuation-lock boilerplate ("same position / no new actions") — it
      // directly contradicts the shot variation we're forcing here.
      var _varAction = (_segAction && !/same position|no new actions|continues speaking/i.test(_segAction)) ? _segAction : '';
      instruction += '\n\n🎬 SHOT VARIATION (high priority — overrides any generic "always medium shot" framing above): Render THIS scene as ' + _shotPlan + '. Keep the SAME person, outfit, room, props, and lighting as Photo 2, but use a DIFFERENT camera framing, angle, and body pose than Photo 2 — do NOT reproduce Photo 2\'s composition or pose.' + (_varAction ? ' The avatar\'s action in this shot: ' + _varAction + '.' : '') + ' Keep any face no larger than ~25% of the frame height (no tight face close-ups).';
    }

    // Locked background wins over any scene setting mentioned above.
    if (_lockedBg) {
      instruction += ' BACKGROUND LOCK (critical, overrides everything else): The environment/background behind the person MUST be exactly: ' + _lockedBg + '. Replace and IGNORE any other room, shop, store, indoor setting, or location described above. Keep the person, their outfit, and their action the same, but place them in THIS exact background on every single frame.';
    }

    // USER OVERRIDE — a per-scene manual correction typed into the Review modal's edit box.
    // Appended LAST + highest-priority so the user can fix leftovers (e.g. "her hands are
    // empty, no tool") without re-pinning or re-analyzing — it just applies on the next Redo.
    // Skin fidelity — stop the editor inventing tattoos the avatar doesn't have.
    // (window.antiTattooNeg returns '' when the avatar IS described as tattooed.)
    var _tatNeg = (typeof window.antiTattooNeg === 'function') ? window.antiTattooNeg() : '';
    if (_tatNeg) {
      instruction += '\n\nSKIN: Reproduce the avatar\'s skin exactly as in the reference photo. Do NOT add any tattoos, body ink, or skin markings that are not already present on the uploaded avatar.';
    }

    var _nbOverride = (seg.nbOverride || '').trim();
    if (_nbOverride) {
      instruction += '\n\n🔒 USER OVERRIDE — HIGHEST PRIORITY, obey this exactly even if it contradicts anything above: ' + _nbOverride + (/[.!?]$/.test(_nbOverride) ? '' : '.');
    }

    // ── Generate via the async background worker (no 26s timeout) ────────────
    // Starts the background job and polls for the image; slow Vertex global gens
    // (20-30s) no longer trip Netlify's function limit.
    var _ar = await _nbGenerateAsync({
      instruction,
      avatarDesc:     _avatarDesc,
      negativePrompt: _nbNegativePrompt + (_tatNeg ? (_nbNegativePrompt ? ', ' : '') + _tatNeg : ''),
      // Pin coordinates (two-person target) passed as STRUCTURED data so the backend can
      // build a deterministic "replace ONLY the person here" directive — instead of relying
      // on the vision model to write the target into free text (which was unreliable/stale).
      targetX:        (seg && typeof seg.targetX === 'number') ? seg.targetX : null,
      targetY:        (seg && typeof seg.targetY === 'number') ? seg.targetY : null,
      avatarB64:      avatarParts.b64,
      avatarMime:     avatarParts.mime,
      frameB64,
      frameMime,
      productB64,
      productMime,
      handRefB64,
      handRefMime,
      // ALWAYS Flash for the Veo start frame. This composite is only a SEED for the
      // video (pose/composition/identity) — Veo re-renders the final pixels and the
      // 1080p upscale handles sharpness, so Pro buys almost nothing here. Worse, Pro's
      // extra photorealism trips Veo's input-image likeness filter (support code
      // 15236754), which is what broke video generation when "Max Quality" was added.
      // Pro/Max Quality still applies to standalone Studio image generation (js/18),
      // where the photo is the deliverable and there's no Veo filter to clear.
      quality: 'flash',
    }, jwt, 'Scene ' + (segIdx + 1));
    var res = _ar.res, data = _ar.data;

    // Failure (HTTP/error OR no image — the "Model returned no image" / safety-filter
    // case that killed Scene 5). Auto-retry up to 2x with a softer render, which both
    // clears the image filter and rides out transient API blips. Each retry is a cheap
    // Flash image gen (~2 credits).
    if (!res.ok || data.error || !data.imageB64) {
      var msg = data.error || (!data.imageB64 ? 'no image returned (safety filter or transient error)' : ('HTTP ' + res.status));
      if (stylizeLevel < 2) {
        console.warn('[NB Composite] Scene ' + (segIdx + 1) + ' failed (' + msg + ') — auto-retrying softer (level ' + (stylizeLevel + 1) + ')');
        if (typeof showToast === 'function') showToast('Scene ' + (segIdx + 1) + ' didn’t render — retrying with a softer version…', 'info', 4500);
        await new Promise(function (r) { setTimeout(r, 3000 + Math.floor(Math.random() * 2000)); }); // backoff for transient/burst errors (jittered so concurrent scenes don't re-hit together)
        return await generateNbComposite(segIdx, stylizeLevel + 1, framingLevel);
      }
      console.error('[NB Composite] Scene ' + (segIdx + 1) + ' failed after retries:', msg);
      showToast('NB gen failed for Scene ' + (segIdx + 1) + ' after retries: ' + msg, 'error', 20000);
      return false;
    }

    // Store composite in segment
    segments[segIdx].nbPreviewDataUrl = _nbImageDataUrl(data.mime, data.imageB64);
    segments[segIdx].nbApproved = null; // reset approval — needs re-review
    saveSegments();
    if (typeof renderSegments === 'function') renderSegments();
    return true;
  }
  window.generateNbComposite = generateNbComposite;

  // ── Lock Her Hand: generate ONE canonical hand reference, reused on every frame ──
  async function generateHandReference() {
    if (!avatarImageDataUrl) { showToast('Upload your avatar photo first — the hand is generated from it.', 'warning'); return; }
    var btn = document.getElementById('genHandRefBtn');
    var _origLabel = btn ? btn.textContent : '';
    function setBtn(t, dis) { if (btn) { btn.textContent = t; btn.disabled = !!dis; } }

    // Auth
    var jwt = null;
    try {
      var _sbRef = (typeof _sb !== 'undefined' && _sb) ? _sb : window._sb;
      if (_sbRef) { var s = await _sbRef.auth.getSession(); jwt = (s && s.data && s.data.session && s.data.session.access_token) || null; }
    } catch(_) {}
    if (!jwt) { showToast('Please log in to lock the hand.', 'warning'); return; }

    // Wrist jewelry ONLY — pull just bracelet/watch/ring-type items from the
    // inventory's JEWELRY line. We deliberately do NOT use the full accessory
    // note here: it lists earrings/necklaces with "keep visible", and since a
    // hand-only shot has no ears or neck, the model satisfies that by inventing
    // a bracelet on the wrist — which is why every hand was getting one.
    var wristJewelry = '';
    try {
      var _invEl = document.getElementById('avatarInventory');
      var _inv = ((_invEl && _invEl.value) || (typeof avatarInventory !== 'undefined' ? avatarInventory : '') || '').trim();
      var _jline = (_inv.match(/^\s*JEWELRY\s*:\s*(.+)$/im) || [])[1] || '';
      var _wrist = (_jline.match(/[^,;]*\b(bracelet|bangle|cuff|wristband|watch|ring)s?\b[^,;]*/ig) || []).join(', ').replace(/\s+/g, ' ').trim();
      if (_wrist && !/^none/i.test(_wrist)) wristJewelry = _wrist;
    } catch(_) {}
    var avDesc = (document.getElementById('avatarDesc') ? document.getElementById('avatarDesc').value.trim() : '');

    var handInstruction =
      'Generate a photorealistic vertical 9:16 CLOSE-UP of THIS exact person\'s right hand and forearm — use the skin tone, age, gender, and ethnicity from the appearance reference photo. '
      + 'Match her gender exactly: if she is a woman, it MUST be a smooth, hairless, feminine hand and forearm — NO arm hair, NO coarse/knuckle hair, no masculine features. '
      + 'The hand is raised toward the camera, fingers gently curled as if about to hold a small product. '
      + (avDesc ? 'Person: ' + avDesc + '. ' : '')
      + 'CLOTHING: match her ACTUAL outfit from the reference photo. If she is wearing a tank top or sleeveless top, show a BARE arm with NO sleeve and NO cuff — do not invent or add sleeves. Only show a sleeve if her top genuinely has one. '
      + (wristJewelry
          ? ('Wrist/hand jewelry: show exactly ' + wristJewelry + ' — and nothing else on the wrist, hand, or fingers. ')
          : ('Bare wrist and bare hand — NO bracelet, NO bangle, NO cuff, NO wristband, NO watch, NO rings, NO jewelry of any kind on the hand, wrist, or arm. Do NOT invent or add any wrist jewelry. '))
      + 'Plain soft neutral studio background, soft even lighting, realistic skin texture appropriate to her age. '
      + 'ONLY the hand and forearm — NO face, NO head, NO full body, NO product. One hand only.';

    try {
      setBtn('⏳ Generating…', true);
      showToast('Generating her hand…', 'info', 4000);
      var avatarCompressed = await _nbCompressImage(avatarImageDataUrl, 1280, 0.9);
      var aParts = _nbSplitDataUrl(avatarCompressed);
      var _hr = await _nbPostComposite({
        instruction: handInstruction,
        avatarDesc: avDesc,
        avatarB64: aParts.b64,
        avatarMime: aParts.mime,
        // no frame → generate mode produces the hand from the avatar's appearance
      }, jwt, 'Hand');
      var res = _hr.res, data = _hr.data;
      if (!res.ok || !data.imageB64) {
        showToast('Hand generation failed: ' + (data.error || ('HTTP ' + res.status)), 'error', 8000);
        setBtn(_origLabel || '🤚 Lock her hand', false);
        return;
      }
      var dataUrl = _nbImageDataUrl(data.mime, data.imageB64);
      window._handRefDataUrl = dataUrl;
      try { if (typeof DB !== 'undefined' && DB && DB.set) DB.set('sm_hand_ref_img', dataUrl); } catch(_) {}

      var thumb = document.getElementById('handRefThumb');
      var icon  = document.getElementById('handRefIcon');
      var hint  = document.getElementById('handRefHint');
      var clr   = document.getElementById('clearHandRefBtn');
      if (thumb) { thumb.src = dataUrl; thumb.style.display = 'block'; }
      if (icon)  icon.style.display = 'none';
      if (hint)  hint.style.display = '';
      if (clr)   clr.style.display = '';
      setBtn('↻ Redo hand', false);
      showToast('Hand locked — it will be reused on every product frame.', 'success', 4500);
    } catch(e) {
      showToast('Hand generation error: ' + (e.message || e), 'error', 8000);
      setBtn(_origLabel || '🤚 Lock her hand', false);
    }
  }
  window.generateHandReference = generateHandReference;

  function clearHandReference() {
    window._handRefDataUrl = null;
    try { if (typeof DB !== 'undefined' && DB && DB.remove) DB.remove('sm_hand_ref_img'); else if (typeof DB !== 'undefined' && DB && DB.set) DB.set('sm_hand_ref_img', null); } catch(_) {}
    var thumb = document.getElementById('handRefThumb');
    var icon  = document.getElementById('handRefIcon');
    var hint  = document.getElementById('handRefHint');
    var clr   = document.getElementById('clearHandRefBtn');
    var btn   = document.getElementById('genHandRefBtn');
    if (thumb) { thumb.src = ''; thumb.style.display = 'none'; }
    if (icon)  icon.style.display = '';
    if (hint)  hint.style.display = 'none';
    if (clr)   clr.style.display = 'none';
    if (btn)   { btn.textContent = '🤚 Lock her hand'; btn.disabled = false; }
    if (typeof showToast === 'function') showToast('Hand reference cleared.', 'info', 2500);
  }
  window.clearHandReference = clearHandReference;

  // ── Auto avatar-prep on upload ────────────────────────────────────────────
  // Re-renders the uploaded avatar ONCE as a stylized digital character so that
  // Veo's "realistic person likeness" filter (support code 15236754) accepts the
  // resulting start frames. Same pattern as the hand reference: one composite
  // call (Flash model, ~2 credits), then the prepared image becomes the working
  // avatar base for every face-frame composite. Fails safe — on any error the
  // user's original photo is kept and uploads are never blocked.
  async function prepareAvatarReference(originalDataUrl) {
    console.log('[AvatarPrep] triggered');
    if (!originalDataUrl) { console.warn('[AvatarPrep] no image — abort'); return; }

    // Show the status immediately so it's never a silent no-op
    if (typeof showToast === 'function') showToast('Optimizing your avatar for video (one-time, ~2 credits)…', 'info', 6000);

    // Auth — try a couple of times in case the session is mid-refresh
    var jwt = null;
    try {
      var _sbRef = (typeof _sb !== 'undefined' && _sb) ? _sb : window._sb;
      if (_sbRef) {
        var s = await _sbRef.auth.getSession();
        jwt = (s && s.data && s.data.session && s.data.session.access_token) || null;
        if (!jwt) { try { var s2 = await _sbRef.auth.refreshSession(); jwt = (s2 && s2.data && s2.data.session && s2.data.session.access_token) || null; } catch(_) {} }
      }
    } catch(e) { console.warn('[AvatarPrep] auth error', e); }
    if (!jwt) {
      console.warn('[AvatarPrep] no JWT — skipped, original photo kept');
      if (typeof showToast === 'function') showToast('Could not optimize avatar (not signed in). Refresh, sign in, then re-upload.', 'warning', 6000);
      return;
    }
    console.log('[AvatarPrep] JWT ok — calling image model…');

    var avDesc = (document.getElementById('avatarDesc') ? document.getElementById('avatarDesc').value.trim() : '');

    // Instruction is deliberately framed as "stylize into a CG character" (not
    // "recreate this real person") so the image model's own likeness guard
    // doesn't refuse, while still reducing the photoreal look Veo blocks on.
    var instruction =
      'Re-render the person in this reference photo as a polished, premium DIGITAL-CHARACTER portrait — clearly a high-end stylized render, noticeably NOT a literal photograph of a real individual, so it reads as a digital character rather than a real person to deepfake. Use a smooth, simplified, soft painterly/editorial finish; keep it human, flattering and natural (not a hard cartoon, anime, or waxy 3D toy). Keep natural human proportions. '
      + 'Keep the SAME hairstyle, hair color, face shape, skin tone, eye color, expression, facial hair, outfit and jewelry so it is clearly and recognizably the SAME person. '
      + 'Simplify skin to a clean, even, gently stylized finish (not heavy pores or hyper-real texture), with soft, flattering light (like gentle window or outdoor light). '
      + (avDesc ? 'Notes: ' + avDesc + '. ' : '')
      + 'Vertical 9:16, head and shoulders, facing camera, plain soft neutral background.';

    try {
      var compressed = await _nbCompressImage(originalDataUrl, 1024, 0.9);
      var aParts = _nbSplitDataUrl(compressed);
      // Async start+poll (same as the frame generation) — no 26s timeout.
      var _ar = await _nbGenerateAsync({
        instruction: instruction,
        avatarDesc:  avDesc,
        avatarB64:   aParts.b64,
        avatarMime:  aParts.mime,
        // no quality:'pro' → Flash model (less photoreal = more likely to pass)
        // no frame → generate mode produces the stylized portrait from the avatar
      }, jwt, 'Avatar');
      var res = _ar.res, data = _ar.data;
      console.log('[AvatarPrep] result → ok=' + (res && res.ok) + ', image=' + (!!(data && data.imageB64)) + (data && data.error ? ', error=' + data.error : ''));

      if (!res || !res.ok || !data.imageB64) {
        var why = (data && data.error) || ('HTTP ' + (res ? res.status : '?'));
        if (typeof showToast === 'function') showToast('Kept your original photo — avatar optimize failed (' + why + '). Wait a minute and re-upload. Very photoreal faces may get blocked by Veo until it succeeds.', 'warning', 9000);
        return; // graceful — original avatar stays in place
      }
      var styledUrl = _nbImageDataUrl(data.mime, data.imageB64);
      console.log('[AvatarPrep] success — swapping in stylized avatar');
      if (typeof window.applyPreparedAvatar === 'function') {
        window.applyPreparedAvatar(styledUrl, originalDataUrl);
      }
    } catch(e) {
      console.warn('[AvatarPrep] exception', e);
      if (typeof showToast === 'function') showToast('Kept your original photo (avatar prep error: ' + (e && e.message || e) + ').', 'warning', 7000);
    }
  }
  window.prepareAvatarReference = prepareAvatarReference;

  // ── Generate NB composites for ALL segments ───────────────────────────────
  // ── Frame-generation progress panel ──────────────────────────────────────
  function _nbOpenProgress(total) {
    var ex = document.getElementById('nbFrameProgress'); if (ex) ex.remove();
    var rows = '';
    for (var k = 0; k < total; k++) {
      rows += '<div id="nbfp-row-' + k + '" style="display:flex;align-items:center;gap:8px;padding:6px 9px;border-radius:7px;background:var(--surface-2);border:1px solid var(--border);font-size:11px;">'
        + '<span id="nbfp-ic-' + k + '">⏳</span>'
        + '<span style="flex:1;color:var(--text-2);">Scene ' + (k + 1) + ' frame</span>'
        + '<span id="nbfp-st-' + k + '" style="font-weight:700;color:var(--text-3);">queued</span>'
        + '</div>';
    }
    var m = document.createElement('div');
    m.id = 'nbFrameProgress';
    m.style.cssText = 'position:fixed;inset:0;z-index:99990;background:rgba(0,0,0,0.80);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;padding:16px;';
    m.innerHTML = '<div id="nbfp-card" style="background:var(--surface);border:1px solid rgba(56,189,248,0.35);border-radius:14px;padding:20px;width:100%;max-width:460px;max-height:88vh;overflow-y:auto;font-family:inherit;display:flex;flex-direction:column;gap:12px;box-shadow:0 24px 80px rgba(0,0,0,0.65);">'
      + '<div style="display:flex;align-items:center;gap:10px;"><div style="width:34px;height:34px;border-radius:9px;background:rgba(56,189,248,0.15);border:1px solid rgba(56,189,248,0.35);display:flex;align-items:center;justify-content:center;font-size:17px;flex-shrink:0;">🖼️</div>'
      + '<div style="flex:1;min-width:0;"><div style="font-size:14px;font-weight:800;color:var(--text-1);">Making your start frames</div><div style="font-size:11px;color:var(--text-3);">' + total + ' scene' + (total !== 1 ? 's' : '') + ' · runs in the background · then you review them</div></div>'
      + '<button onclick="window._nbMinimizeProgress()" title="Hide — keeps generating in the background" style="background:none;border:none;color:var(--text-3);font-size:18px;cursor:pointer;line-height:1;padding:2px 8px;border-radius:6px;flex-shrink:0;">✕</button></div>'
      + '<div style="display:flex;flex-direction:column;gap:4px;">' + rows + '</div>'
      + '<div><div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-3);margin-bottom:5px;"><span id="nbfp-label">Starting…</span><span id="nbfp-pct">0%</span></div>'
      + '<div style="height:5px;background:var(--surface-3);border-radius:3px;overflow:hidden;"><div id="nbfp-bar" style="height:100%;width:0%;background:linear-gradient(90deg,#38bdf8,#34d399);border-radius:3px;transition:width 0.4s;"></div></div></div>'
      + '</div>';
    document.body.appendChild(m);
  }
  function _nbSetFrameStatus(k, status, doneCount, total) {
    var ic = document.getElementById('nbfp-ic-' + k), st = document.getElementById('nbfp-st-' + k), row = document.getElementById('nbfp-row-' + k);
    var cfg = { generating: ['⟳', '#38bdf8', 'generating…', 'rgba(56,189,248,0.08)'],
                done:       ['✅', '#34d399', 'done',          'rgba(52,211,153,0.07)'],
                error:      ['❌', '#f87171', 'failed',        'rgba(239,68,68,0.07)'] }[status];
    if (cfg) { if (ic) ic.textContent = cfg[0]; if (st) { st.textContent = cfg[2]; st.style.color = cfg[1]; } if (row) row.style.background = cfg[3]; }
    if (typeof doneCount === 'number' && total) {
      var pct = Math.round((doneCount / total) * 100);
      var bar = document.getElementById('nbfp-bar'), pe = document.getElementById('nbfp-pct'), lb = document.getElementById('nbfp-label');
      if (bar) bar.style.width = pct + '%';
      if (pe) pe.textContent = pct + '%';
      if (lb) lb.textContent = doneCount + '/' + total + ' frames';
    }
  }
  function _nbCloseProgress() { var m = document.getElementById('nbFrameProgress'); if (m) m.remove(); }

  // Minimize the frame-progress panel: drop the full-screen blocking overlay and
  // dock the card in the bottom-right so the user can keep working. Generation runs
  // in the background regardless; the review modal still opens automatically when done.
  window._nbMinimizeProgress = function _nbMinimizeProgress() {
    var m = document.getElementById('nbFrameProgress'); if (!m) return;
    var card = document.getElementById('nbfp-card');
    m.style.background = 'transparent';
    m.style.backdropFilter = 'none';
    m.style.pointerEvents = 'none';            // clicks pass through to the app
    m.style.alignItems = 'flex-end';
    m.style.justifyContent = 'flex-end';
    m.style.padding = '16px';
    if (card) {
      card.style.pointerEvents = 'auto';        // the card itself stays interactive
      card.style.maxWidth = '300px';
      card.style.maxHeight = '60vh';
      card.style.boxShadow = '0 12px 40px rgba(0,0,0,0.6)';
    }
    if (typeof showToast === 'function') showToast('Frames are still generating — you can keep working. The review will open when they’re ready.', 'info', 5000);
  };

  async function generateAllNbComposites() {
    // Include segments that either have an NB prompt OR have a frameDataUrl (person-swap path)
    var toGen = segments.filter(function(s) { return (s.nbPrompt || '').trim() || s.frameDataUrl; });
    if (!toGen.length) {
      showToast('No scenes ready — generate prompts first or ensure frames are extracted.', 'warning');
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
    _nbOpenProgress(n);
    // Cost clarity: tell the user the spend up front. Frames are charged only when each
    // one succeeds (a failed/filtered frame costs nothing).
    var _frameCost = (window._nbMaxQuality ? 5 : 2);
    if (typeof showToast === 'function') {
      showToast('Making ' + n + ' start frame' + (n > 1 ? 's' : '') + ' · ~' + (n * _frameCost) + ' credits (' + _frameCost + ' each, charged only on success).', 'info', 5000);
    }

    // Concurrency is TIER-AWARE. The image model's quota is tight, so firing many
    // frames at once trips 429s (the batch that failed scenes 3/4/6/7). Default to
    // SERIAL (1-wide) so the per-frame ~25s gen naturally spaces requests under the
    // quota — reliable for everyone. The top tier gets parallel speed; its 429s are
    // caught by the stronger backoff + auto-retry.
    var _nbTier = (typeof window !== 'undefined' && window._stripeTier) ? window._stripeTier : 'free';
    var _nbTopTier = (_nbTier === 'scale' || _nbTier === 'agency');
    var _CONCURRENCY = _nbTopTier ? 2 : 1;

    // ── Anchor frame → background consistency ─────────────────────────────────
    // For producer script-only runs (no per-scene source frames), generate the FIRST
    // scene ALONE to establish the locked set, capture it as the anchor, then let every
    // other scene match it. Replicator runs (each scene has its own frame) skip this.
    window._producerAnchorFrame = null;
    var _next = 0;
    var _anchorMode = n > 1 && toGen.every(function (s) { return !s.frameDataUrl; });
    if (_anchorMode) {
      var _aSegIdx = segments.indexOf(toGen[0]);
      _nbSetFrameStatus(0, 'generating');
      var _aOk = await generateNbComposite(_aSegIdx); // anchor: no _producerAnchorFrame yet → fresh set
      // The anchor locks the SET that every other scene matches — if it fails, the rest
      // would each generate a different room. Retry once before falling back to per-scene sets.
      if (!_aOk) { _aOk = await generateNbComposite(_aSegIdx); }
      if (_aOk) { succeeded++; window._producerAnchorFrame = (segments[_aSegIdx] && segments[_aSegIdx].nbPreviewDataUrl) || null; }
      else      { failed++; if (typeof showToast === 'function') showToast('Couldn’t lock the shared set — scenes may vary in background. You can regenerate any scene after.', 'warning', 6000); }
      _nbSetFrameStatus(0, _aOk ? 'done' : 'error', succeeded + failed, n);
      if (btn) btn.innerHTML = '<i class="ti ti-loader-2" style="animation:spin 1s linear infinite;"></i> ' + (succeeded + failed) + '/' + n + '…';
      _next = 1; // workers start after the anchor
    }

    async function _nbWorker() {
      while (true) {
        var i = _next++;
        if (i >= n) break;
        var segIdx = segments.indexOf(toGen[i]);
        _nbSetFrameStatus(i, 'generating');
        var ok = await generateNbComposite(segIdx);
        if (ok) succeeded++; else failed++;
        _nbSetFrameStatus(i, ok ? 'done' : 'error', succeeded + failed, n);
        if (btn) btn.innerHTML = '<i class="ti ti-loader-2" style="animation:spin 1s linear infinite;"></i> ' + (succeeded + failed) + '/' + n + '…';
      }
    }
    var _workers = [];
    for (var _w = 0; _w < Math.min(_CONCURRENCY, n); _w++) _workers.push(_nbWorker());
    await Promise.all(_workers);

    _nbCloseProgress();
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
  // Beat color map (matches mockup beat tokens)
  var _RV_BEAT = {
    hook:    {c:'#5b9df9', label:'Hook — the opener'},
    problem: {c:'#f0803c', label:'Problem — the pain point'},
    solution:{c:'#34D399', label:'Solution — the turn'},
    proof:   {c:'#a78bfa', label:'Proof — social proof'},
    cta:     {c:'#e0a83a', label:'CTA — the ask'}
  };
  function _rvBeatKey(seg){
    var b = String((seg && seg.beat) || '').toLowerCase();
    if (b.indexOf('hook')>=0) return 'hook';
    if (b.indexOf('problem')>=0) return 'problem';
    if (b.indexOf('solution')>=0) return 'solution';
    if (b.indexOf('proof')>=0) return 'proof';
    if (b.indexOf('cta')>=0 || b.indexOf('call')>=0) return 'cta';
    return '';
  }
  var _rvIdx = 0;
  var _rvList = [];
  var _rvForceApi = false;

  function openNbApprovalModal(fromProcessEverything) {
    var _allSegs = (typeof segments !== 'undefined' && segments && segments.length) ? segments : (window.segments || []);
    _rvList = _allSegs.filter(function(s) { return s.nbPreviewDataUrl; });
    if (!_rvList.length) {
      showToast('Generate NB composites first.', 'warning');
      return;
    }
    _rvForceApi = !!fromProcessEverything;
    var existing = document.getElementById('nbApprovalModal');
    if (existing) existing.remove();

    if (_rvIdx >= _rvList.length) _rvIdx = 0;

    var modal = document.createElement('div');
    modal.id = 'nbApprovalModal';
    modal.className = 'rv-scrim';
    modal.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(4,4,6,.72);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;padding:24px;';
    modal.innerHTML =
      '<div class="rv-modal" role="dialog" aria-label="Review start frames" style="width:min(900px,96vw);height:min(600px,92vh);background:var(--surface,#101013);border:1px solid var(--border-2,rgba(255,255,255,.14));border-radius:14px;box-shadow:0 12px 34px rgba(0,0,0,.5);display:flex;flex-direction:column;overflow:hidden;font-family:inherit;">'
      + '<div class="rv-head" style="display:flex;align-items:center;justify-content:space-between;padding:13px 18px;border-bottom:1px solid var(--border,rgba(255,255,255,.08));flex-shrink:0;">'
        + '<div style="font-size:14.5px;font-weight:600;letter-spacing:-.2px;display:flex;align-items:center;gap:9px;color:var(--text-1,#f5f5f6);"><i class="ti ti-eye-check" style="color:#34D399;"></i> Review Start Frames</div>'
        + '<div style="display:flex;align-items:center;gap:14px;">'
          + '<span style="font-size:12px;color:var(--text-3,rgba(255,255,255,.5));"><b id="rvApproved" style="color:#34D399;">0</b> of ' + _rvList.length + ' approved</span>'
          + '<button onclick="document.getElementById(\'nbApprovalModal\').remove()" title="Close" style="width:32px;height:32px;border-radius:8px;background:transparent;border:1px solid transparent;color:var(--text-3,rgba(255,255,255,.5));display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:17px;"><i class="ti ti-x"></i></button>'
        + '</div>'
      + '</div>'
      + '<div class="rv-stage" style="flex:1;min-height:0;display:flex;gap:18px;padding:18px;">'
        + '<div class="rv-frame" id="rvFrame" style="width:206px;flex-shrink:0;aspect-ratio:9/16;border-radius:12px;overflow:hidden;border:1px solid var(--border-2,rgba(255,255,255,.14));position:relative;background:#000;">'
          + '<img id="rvImg" src="" alt="" style="width:100%;height:100%;object-fit:cover;">'
          + '<span id="rvBeat" style="position:absolute;top:10px;left:10px;font-size:9px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;padding:2px 8px;border-radius:999px;background:rgba(0,0,0,.5);border:1px solid var(--border-2,rgba(255,255,255,.14));display:none;"></span>'
          + '<span id="rvShot" style="position:absolute;bottom:10px;left:10px;font-size:9px;font-weight:600;padding:2px 7px;border-radius:5px;background:rgba(0,0,0,.6);color:var(--text-2,rgba(255,255,255,.68));border:1px solid var(--border-2,rgba(255,255,255,.14));letter-spacing:.03em;display:none;"></span>'
        + '</div>'
        + '<div class="rv-info" style="flex:1;min-width:0;display:flex;flex-direction:column;gap:13px;">'
          + '<div><div style="font-size:10px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--text-4,rgba(255,255,255,.34));margin-bottom:4px;">Scene <span id="rvNum">1</span> · beat</div><div id="rvBeatName" style="font-size:13.5px;color:var(--text-1,#f5f5f6);line-height:1.5;">—</div></div>'
          + '<div><div style="font-size:10px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--text-4,rgba(255,255,255,.34));margin-bottom:4px;">Action</div><div id="rvAction" style="font-size:13.5px;color:var(--text-1,#f5f5f6);line-height:1.5;">—</div></div>'
          + '<div><div style="font-size:10px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--text-4,rgba(255,255,255,.34));margin-bottom:4px;">On-screen caption</div><div id="rvCap" style="font-family:\'Geist Mono\',monospace;font-size:12.5px;color:var(--text-2,rgba(255,255,255,.68));background:var(--bg,#08080a);border:1px solid var(--border,rgba(255,255,255,.08));border-radius:8px;padding:9px 11px;line-height:1.4;">—</div></div>'
          + '<div style="margin-top:auto;display:flex;flex-direction:column;gap:8px;">'
            + '<input id="rvOverride" type="text" placeholder="✎ Fix this scene (e.g. empty hands), then Redo" oninput="rvSetOverride(this.value)" style="width:100%;box-sizing:border-box;background:var(--bg,#08080a);border:1px solid var(--border,rgba(255,255,255,.08));border-radius:8px;color:var(--text-1,#f5f5f6);font-size:11px;padding:8px 10px;font-family:inherit;outline:none;"/>'
            + '<div style="display:flex;gap:8px;">'
              + '<button id="rvApproveBtn" onclick="rvApprove()" style="flex:1;height:36px;border-radius:8px;border:1px solid var(--border-2,rgba(255,255,255,.14));background:var(--surface-2,#16161a);color:var(--text-1,#f5f5f6);font-family:inherit;font-size:13px;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:7px;"><i class="ti ti-check"></i> Approve <span class="rv-kbd" style="font-family:\'Geist Mono\',monospace;font-size:10px;background:var(--surface-3,#1d1d22);border:1px solid var(--border-2,rgba(255,255,255,.14));border-radius:4px;padding:0 5px;color:var(--text-3,rgba(255,255,255,.5));margin-left:6px;">A</span></button>'
              + '<button id="rvRedoBtn" onclick="rvRedo()" style="flex:1;height:36px;border-radius:8px;border:1px solid var(--border-2,rgba(255,255,255,.14));background:var(--surface-2,#16161a);color:var(--text-1,#f5f5f6);font-family:inherit;font-size:13px;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:7px;"><i class="ti ti-refresh"></i> Redo <span class="rv-kbd" style="font-family:\'Geist Mono\',monospace;font-size:10px;background:var(--surface-3,#1d1d22);border:1px solid var(--border-2,rgba(255,255,255,.14));border-radius:4px;padding:0 5px;color:var(--text-3,rgba(255,255,255,.5));margin-left:6px;">R</span></button>'
              + '<button id="rvSwapBtn" onclick="rvSwapBg()" style="flex:1;height:36px;border-radius:8px;border:1px solid var(--border-2,rgba(255,255,255,.14));background:var(--surface-2,#16161a);color:var(--text-1,#f5f5f6);font-family:inherit;font-size:13px;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:7px;"><i class="ti ti-photo"></i> Swap BG <span class="rv-kbd" style="font-family:\'Geist Mono\',monospace;font-size:10px;background:var(--surface-3,#1d1d22);border:1px solid var(--border-2,rgba(255,255,255,.14));border-radius:4px;padding:0 5px;color:var(--text-3,rgba(255,255,255,.5));margin-left:6px;">B</span></button>'
            + '</div>'
            + '<button id="rvUndoBtn" onclick="rvUndo()" style="display:none;height:30px;border-radius:8px;border:1px solid var(--border-2,rgba(255,255,255,.14));background:transparent;color:var(--text-3,rgba(255,255,255,.5));font-family:inherit;font-size:12px;font-weight:600;cursor:pointer;align-items:center;justify-content:center;gap:6px;"><i class="ti ti-arrow-back-up"></i> Undo edit</button>'
          + '</div>'
        + '</div>'
      + '</div>'
      + '<div class="rv-strip" id="rvStrip" style="flex-shrink:0;display:flex;gap:8px;padding:11px 18px;border-top:1px solid var(--border,rgba(255,255,255,.08));overflow-x:auto;"></div>'
      + '<div class="rv-foot" style="display:flex;align-items:center;justify-content:space-between;padding:12px 18px;border-top:1px solid var(--border,rgba(255,255,255,.08));flex-shrink:0;">'
        + '<span style="font-size:11px;color:var(--text-4,rgba(255,255,255,.34));">← → navigate · A approve · R redo · B swap bg · Esc close</span>'
        + '<button id="rvGenBtn" onclick="rvGenerate()" style="display:inline-flex;align-items:center;gap:7px;height:36px;padding:0 15px;border-radius:8px;font-family:inherit;font-size:13px;font-weight:600;cursor:pointer;border:1px solid rgba(16,185,129,.5);color:#04130d;background:linear-gradient(180deg,#3fd89b,#10b981);box-shadow:inset 0 1px 0 rgba(255,255,255,.25),0 1px 2px rgba(0,0,0,.4);"><i class="ti ti-sparkles"></i> Generate Video <span id="rvCost" style="font-size:11px;font-weight:600;padding:1px 7px;border-radius:999px;background:rgba(4,19,13,.22);margin-left:2px;"></span></button>'
      + '</div>'
      + '</div>';

    modal.onclick = function(e) { if (e.target === modal) { modal.remove(); document.removeEventListener('keydown', _rvKeyHandler); } };
    document.body.appendChild(modal);
    _rvRenderStrip();
    _rvShow(_rvIdx);
    document.addEventListener('keydown', _rvKeyHandler);
  }

  function _rvKeyHandler(e){
    if (!document.getElementById('nbApprovalModal')) { document.removeEventListener('keydown', _rvKeyHandler); return; }
    var tag = (e.target && e.target.tagName) || '';
    var typing = (tag === 'INPUT' || tag === 'TEXTAREA');
    if (e.key === 'Escape') { document.getElementById('nbApprovalModal').remove(); document.removeEventListener('keydown', _rvKeyHandler); return; }
    if (typing) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); _rvShow(Math.min(_rvIdx+1, _rvList.length-1)); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); _rvShow(Math.max(_rvIdx-1, 0)); }
    else if (e.key === 'a' || e.key === 'A') { e.preventDefault(); rvApprove(); }
    else if (e.key === 'r' || e.key === 'R') { e.preventDefault(); rvRedo(); }
    else if (e.key === 'b' || e.key === 'B') { e.preventDefault(); rvSwapBg(); }
  }

  function _rvSegAt(i){ return _rvList[i]; }
  function _rvGlobalIdx(i){ var _a=(typeof segments!=='undefined'&&segments&&segments.length)?segments:(window.segments||_rvList); var gi=_a.indexOf(_rvList[i]); return gi>=0?gi:i; }

  function _rvRenderStrip(){
    var strip = document.getElementById('rvStrip');
    if (!strip) return;
    strip.innerHTML = '';
    _rvList.forEach(function(seg, i){
      var approved = seg.nbApproved !== false;
      var t = document.createElement('div');
      t.onclick = function(){ _rvShow(i); };
      t.style.cssText = 'width:50px;height:70px;border-radius:8px;overflow:hidden;border:2px solid ' + (i===_rvIdx ? '#10B981' : 'transparent') + ';position:relative;cursor:pointer;flex-shrink:0;background:#000;';
      t.setAttribute('data-rvthumb', i);
      t.innerHTML = '<img src="' + seg.nbPreviewDataUrl + '" style="width:100%;height:100%;object-fit:cover;opacity:' + (i===_rvIdx?'1':'.55') + ';">'
        + '<span style="position:absolute;bottom:2px;left:4px;font-size:9px;font-weight:700;color:#fff;text-shadow:0 1px 3px #000;">' + (_rvGlobalIdx(i)+1) + '</span>'
        + '<span style="position:absolute;top:3px;right:3px;width:15px;height:15px;border-radius:50%;background:#10B981;color:#04130d;display:' + (approved?'flex':'none') + ';align-items:center;justify-content:center;font-size:11px;"><i class="ti ti-check"></i></span>';
      strip.appendChild(t);
    });
  }

  function _rvUpdateApprovedCount(){
    var approvedSegs = _rvList.filter(function(s){ return s.nbApproved !== false; });
    var n = approvedSegs.length;
    var el = document.getElementById('rvApproved');
    if (el) el.textContent = n;
    var costEl = document.getElementById('rvCost');
    if (costEl) {
      var c = 0;
      try { if (typeof estimateCredits === 'function') c = estimateCredits(approvedSegs); } catch(e){ c = 0; }
      costEl.textContent = c ? ('~' + c + ' cr') : '';
      costEl.style.display = c ? 'inline-block' : 'none';
    }
  }

  function _rvShow(i){
    if (i < 0 || i >= _rvList.length) return;
    _rvIdx = i;
    var seg = _rvSegAt(i);
    var gIdx = _rvGlobalIdx(i);
    var img = document.getElementById('rvImg');
    if (img) img.src = seg.nbPreviewDataUrl;
    // beat badge
    var bk = _rvBeatKey(seg);
    var beatEl = document.getElementById('rvBeat');
    var beatName = document.getElementById('rvBeatName');
    if (bk && _RV_BEAT[bk]) {
      if (beatEl) { beatEl.style.display='inline-block'; beatEl.textContent = bk; beatEl.style.color = _RV_BEAT[bk].c; }
      if (beatName) beatName.textContent = _RV_BEAT[bk].label;
    } else {
      if (beatEl) beatEl.style.display='none';
      if (beatName) beatName.textContent = (seg.beat || '—');
    }
    var shotEl = document.getElementById('rvShot');
    var shot = String(seg._shot || '').trim();
    if (shotEl) { if (shot) { shotEl.style.display='inline-block'; shotEl.textContent = shot.toUpperCase(); } else { shotEl.style.display='none'; } }
    var numEl = document.getElementById('rvNum'); if (numEl) numEl.textContent = (gIdx+1);
    var actEl = document.getElementById('rvAction'); if (actEl) actEl.textContent = (seg.action || '—');
    var capEl = document.getElementById('rvCap'); if (capEl) capEl.textContent = (seg.onScreenText || seg.script || '—');
    var ov = document.getElementById('rvOverride'); if (ov) ov.value = (seg.nbOverride || '');
    // approve button state
    var approved = seg.nbApproved !== false;
    var ab = document.getElementById('rvApproveBtn');
    if (ab) {
      if (approved) { ab.style.background='rgba(16,185,129,.12)'; ab.style.borderColor='rgba(16,185,129,.32)'; ab.style.color='#34D399'; ab.innerHTML='<i class="ti ti-check"></i> Approved <span class="rv-kbd" style="font-family:\'Geist Mono\',monospace;font-size:10px;background:var(--surface-3,#1d1d22);border:1px solid var(--border-2,rgba(255,255,255,.14));border-radius:4px;padding:0 5px;color:var(--text-3,rgba(255,255,255,.5));margin-left:6px;">A</span>'; }
      else { ab.style.background='var(--surface-2,#16161a)'; ab.style.borderColor='var(--border-2,rgba(255,255,255,.14))'; ab.style.color='var(--text-1,#f5f5f6)'; ab.innerHTML='<i class="ti ti-check"></i> Approve <span class="rv-kbd" style="font-family:\'Geist Mono\',monospace;font-size:10px;background:var(--surface-3,#1d1d22);border:1px solid var(--border-2,rgba(255,255,255,.14));border-radius:4px;padding:0 5px;color:var(--text-3,rgba(255,255,255,.5));margin-left:6px;">A</span>'; }
    }
    // undo button visibility
    var ub = document.getElementById('rvUndoBtn');
    if (ub) ub.style.display = seg.nbEditOriginal ? 'inline-flex' : 'none';
    // strip highlight
    var strip = document.getElementById('rvStrip');
    if (strip) Array.prototype.forEach.call(strip.children, function(c, ci){
      var on = (ci===_rvIdx);
      c.style.borderColor = on ? '#10B981' : 'transparent';
      var im = c.querySelector('img'); if (im) im.style.opacity = on ? '1' : '.55';
    });
    _rvUpdateApprovedCount();
  }

  // ── Action handlers wired to existing pipeline functions ──
  window.rvApprove = function(){
    var seg = _rvSegAt(_rvIdx); if (!seg) return;
    var gIdx = _rvGlobalIdx(_rvIdx);
    // toggle: if not approved -> approve; if already approved -> keep approved (Approve is idempotent-forward)
    seg.nbApproved = (seg.nbApproved === false) ? true : true;
    if (typeof saveSegments === 'function') saveSegments();
    // refresh strip check + count, then advance to next unapproved
    var t = document.querySelector('[data-rvthumb="'+_rvIdx+'"] span:last-child');
    if (t) t.style.display = 'flex';
    _rvShow(_rvIdx);
    // auto-advance
    if (_rvIdx < _rvList.length-1) setTimeout(function(){ _rvShow(_rvIdx+1); }, 160);
  };
  window.rvSetOverride = function(v){
    var gIdx = _rvGlobalIdx(_rvIdx);
    if (typeof setNbOverride === 'function') setNbOverride(gIdx, v);
    else { var seg=_rvSegAt(_rvIdx); if(seg) seg.nbOverride = v; }
  };
  window.rvRedo = function(){
    var gIdx = _rvGlobalIdx(_rvIdx);
    if (typeof regenNbFrame === 'function') regenNbFrame(gIdx);
  };
  window.rvSwapBg = function(){
    var gIdx = _rvGlobalIdx(_rvIdx);
    if (typeof swapBackgroundNbFrame === 'function') swapBackgroundNbFrame(gIdx);
  };
  window.rvUndo = function(){
    var gIdx = _rvGlobalIdx(_rvIdx);
    if (typeof revertBlend === 'function') revertBlend(gIdx);
  };
  window.rvGenerate = function(){
    var m = document.getElementById('nbApprovalModal'); if (m) m.remove();
    document.removeEventListener('keydown', _rvKeyHandler);
    var _api = _rvForceApi ? true : ((typeof getGenerateMode === 'function' ? getGenerateMode() : 'api') === 'api');
    if (_api) { if (typeof generateAllScenesViaAPI === 'function') generateAllScenesViaAPI(); }
    else { if (typeof showPreflightModal === 'function') showPreflightModal(false); }
  };
  // Refresh the currently shown frame image after a redo / swap-bg mutates nbPreviewDataUrl
  window.rvRefreshCurrent = function(){
    if (!document.getElementById('nbApprovalModal')) return;
    _rvShow(_rvIdx);
    _rvRenderStrip();
  };

  window.openNbApprovalModal = openNbApprovalModal;

  // ── "Swap BG" + Undo: post-passes on an approved start frame ────────────────
  // Swap BG replaces the background behind the (already-grounded) character-swap
  // subject with the uploaded custom background and re-grounds/relights him. Undo
  // restores the saved original. Both operate on the current frame; nbEditOriginal
  // holds the pre-edit frame for a one-click revert.

  function _showBlendRevert(idx, show) {
    var b = document.getElementById('nb-revert-btn-' + idx);
    if (b) b.style.display = show ? 'inline-block' : 'none';
  }

  async function swapBackgroundNbFrame(segIdx) {
    var seg = segments[segIdx];
    if (!seg || !seg.nbPreviewDataUrl) { showToast('Generate this frame first.', 'warning'); return; }
    var _bgUrl    = (typeof bgImageDataUrl !== 'undefined' && bgImageDataUrl) ? bgImageDataUrl : null;
    var _bgFromAv = (typeof bgFromAvatar !== 'undefined') ? bgFromAvatar : false;
    if (!_bgUrl || _bgFromAv) { showToast('Upload a custom background first (Background panel), then Swap BG.', 'warning', 6000); return; }
    var btn = document.getElementById('nb-swapbg-btn-' + segIdx);
    var _orig = btn ? btn.innerHTML : '';
    if (btn) { btn.innerHTML = '🖼 Swapping…'; btn.disabled = true; btn.style.opacity = '0.7'; }
    try {
      var jwt = null;
      try {
        var _sbRef = (typeof _sb !== 'undefined' && _sb) ? _sb : window._sb;
        if (_sbRef) { var s = await _sbRef.auth.getSession(); jwt = (s && s.data && s.data.session && s.data.session.access_token) || null; }
      } catch(_) {}
      if (!jwt) { showToast('Please log in to swap the background.', 'warning'); if (btn) { btn.innerHTML = _orig; btn.disabled = false; btn.style.opacity = '1'; } return; }

      var _nbPx = window._nbMaxQuality ? 1280 : 768;
      var _nbJq = window._nbMaxQuality ? 0.9  : 0.8;

      // Keep the very first frame so Undo can always restore it, even after
      // chaining passes. Operate on the CURRENT frame.
      if (!seg.nbEditOriginal) seg.nbEditOriginal = seg.nbPreviewDataUrl;
      var inputUrl = seg.nbPreviewDataUrl;

      var _srcComp  = await _nbCompressImage(inputUrl, _nbPx, _nbJq);
      var _srcParts = _nbSplitDataUrl(_srcComp);
      var _bgComp   = await _nbCompressImage(_bgUrl, _nbPx, _nbJq);
      var _bgParts  = _nbSplitDataUrl(_bgComp);
      var body = { bgReplace: true, harmonizeB64: _srcParts.b64, harmonizeMime: _srcParts.mime, bgB64: _bgParts.b64, bgMime: _bgParts.mime };

      // Identity lock — keep his face exact.
      try {
        if (typeof avatarImageDataUrl !== 'undefined' && avatarImageDataUrl) {
          var _aC = await _nbCompressImage(avatarImageDataUrl, _nbPx, _nbJq);
          var _aP = _nbSplitDataUrl(_aC);
          body.avatarB64 = _aP.b64; body.avatarMime = _aP.mime;
        }
      } catch(_) {}

      // Product lock — keep the label pixel-identical.
      try {
        var _pUrl = (typeof productImageDataUrl !== 'undefined' && productImageDataUrl) || window._producerProductImageUrl || null;
        if (_pUrl && seg.showProduct) {
          var _pC = await _nbCompressImage(_pUrl, _nbPx, _nbJq);
          var _pP = _nbSplitDataUrl(_pC);
          body.productB64 = _pP.b64; body.productMime = _pP.mime;
        }
      } catch(_) {}

      var _ar = await _nbGenerateAsync(body, jwt, 'Swap BG scene ' + (segIdx + 1));
      var res = _ar.res, data = _ar.data;
      if (!res || !res.ok || !data || data.error || !data.imageB64) {
        throw new Error((data && data.error) || 'no image returned');
      }
      seg.nbPreviewDataUrl = _nbImageDataUrl(data.mime, data.imageB64);
      seg.nbApproved = null;
      _showBlendRevert(segIdx, true);
      saveSegments();
      var img = document.getElementById('nb-approval-img-' + segIdx);
      if (img) img.src = seg.nbPreviewDataUrl;
      if (typeof rvRefreshCurrent === 'function') rvRefreshCurrent();
      showToast('Scene ' + (segIdx + 1) + ' background swapped ✓', 'success');
    } catch (e) {
      showToast('Background swap failed for Scene ' + (segIdx + 1) + ': ' + (e.message || e), 'error', 8000);
    } finally {
      if (btn) { btn.innerHTML = _orig || '🖼 Swap BG'; btn.disabled = false; btn.style.opacity = '1'; }
    }
  }
  window.swapBackgroundNbFrame = swapBackgroundNbFrame;

  // Undo — restore the saved original frame (works after a background swap).
  function revertBlend(segIdx) {
    var seg = segments[segIdx];
    if (!seg || !seg.nbEditOriginal) { showToast('Nothing to undo.', 'info'); return; }
    seg.nbPreviewDataUrl = seg.nbEditOriginal;
    seg.nbEditOriginal = null;
    seg.nbApproved = null;
    saveSegments();
    var img = document.getElementById('nb-approval-img-' + segIdx);
    if (img) img.src = seg.nbPreviewDataUrl;
    _showBlendRevert(segIdx, false);
    if (typeof rvRefreshCurrent === 'function') rvRefreshCurrent();
    showToast('Reverted to the original frame.', 'info');
  }
  window.revertBlend = revertBlend;

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

  // Per-scene manual override from the Review modal's edit box. Saved on the segment and
  // injected into the composite as a highest-priority instruction on the next ↺ Redo.
  window.setNbOverride = function(segIdx, val) {
    var seg = segments[segIdx];
    if (!seg) return;
    seg.nbOverride = val || '';
    if (typeof saveSegments === 'function') saveSegments();
  };

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

  // ── Regenerate a single NB frame in-place inside the approval modal ────────
  window.regenNbFrame = async function(segIdx) {
    var btn  = document.getElementById('nb-regen-btn-' + segIdx);
    var img  = document.getElementById('nb-approval-img-' + segIdx);
    var card = document.getElementById('nb-approval-card-' + segIdx);

    if (btn) { btn.disabled = true; btn.textContent = '…'; btn.style.opacity = '0.5'; }
    if (img) { img.style.opacity = '0.4'; }

    var ok = await generateNbComposite(segIdx);

    if (ok) {
      var seg = segments[segIdx];
      // Swap image in-place — no modal close/reopen needed
      if (img && seg.nbPreviewDataUrl) {
        img.src = seg.nbPreviewDataUrl;
        img.style.opacity = '1';
      }
      // Auto-approve the fresh frame
      seg.nbApproved = true;
      var badge = document.getElementById('nb-approval-badge-' + segIdx);
      if (card)  card.style.borderColor = 'rgba(52,211,153,0.7)';
      if (badge) { badge.textContent = '✓'; badge.style.background = 'rgba(52,211,153,0.9)'; }
    } else {
      if (img) img.style.opacity = '1';
    }

    if (btn) { btn.disabled = false; btn.textContent = '↺ Redo'; btn.style.opacity = '1'; }
    if (typeof rvRefreshCurrent === 'function') rvRefreshCurrent();
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // PRODUCER PHASE 1 — Generate Master Reference via NB API
  // ─────────────────────────────────────────────────────────────────────────
  // Calls generate-nb-composite with the avatar only (no reference frame) to
  // establish the scene, background, and character anchor for all clips.
  // Result stored as window._sbEstFrameDataUrl and distributed to segments.
  // ═══════════════════════════════════════════════════════════════════════════
  // ─── helper: get JWT ─────────────────────────────────────────────────────
  async function _nbGetJwt() {
    try {
      var _sbRef = (typeof _sb !== 'undefined' && _sb) ? _sb : window._sb;
      if (_sbRef) {
        var sess = await _sbRef.auth.getSession();
        return (sess && sess.data && sess.data.session && sess.data.session.access_token) || null;
      }
    } catch(_) {}
    return null;
  }

  // ─── helper: GPT vision scene description ────────────────────────────────
  async function _nbDescribeScene(imageDataUrl, fallback) {
    var apiKey = (typeof getApiKey === 'function') ? getApiKey() : null;
    if (!apiKey) return fallback;
    try {
      var vRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: [
            { type: 'text', text: 'Describe this scene in 2-3 specific sentences for use as a consistent video background reference. Focus on: the exact surface or counter type, visible props and objects, the background environment, lighting quality and direction, and distinctive visual elements. Be concrete and visual.' },
            { type: 'image_url', image_url: { url: imageDataUrl, detail: 'low' } },
          ]}],
          max_tokens: 200,
        }),
      });
      if (!vRes.ok) return fallback;
      var vData = await vRes.json();
      return ((((vData.choices || [])[0] || {}).message || {}).content || '').trim() || fallback;
    } catch(_) { return fallback; }
  }

  // ─── helper: distribute master frame to all Producer segments ────────────
  function _nbDistributeMaster(masterDataUrl, avatarDesc, sceneRef) {
    segments.forEach(function(seg) {
      if (!seg._scriptOnly) return;
      seg.frameDataUrl = masterDataUrl;
      var action = seg.action || 'speaks naturally to camera with confident eye contact';
      // Note: seg.frameDataUrl is set to masterDataUrl above, so at generation time
      // Photo 1 = avatar, Photo 2 = master reference. The instruction in generateNbComposite
      // will handle the person-swap + pose-change automatically because hasFrame = true.
      // We store the pose/action context here so it gets picked up via seg.action.
      seg.action = action; // ensure action is set for the instruction builder
    });
    if (typeof saveSegments === 'function') saveSegments();
  }

  // ─── Step 1: Setting confirmation modal ──────────────────────────────────
  // Shows before any API call — user edits setting, then hits Generate.
  window.generateNBMasterViaAPI = function() {
    if (!avatarImageDataUrl) {
      showToast('Upload your avatar photo first.', 'warning');
      return;
    }

    var kit         = (typeof getBrandKit === 'function') ? getBrandKit() : {};
    var avatarDesc  = (document.getElementById('avatarDesc')    ? document.getElementById('avatarDesc').value.trim()    : '') || kit.avatarDesc    || 'the presenter';
    var setting     = (document.getElementById('studioSetting') ? document.getElementById('studioSetting').value.trim() : '') || kit.setting       || '';
    var productName = (document.getElementById('sbProduct')     ? document.getElementById('sbProduct').value.trim()     : '') || kit.productName   || '';

    var existing = document.getElementById('nbMasterSetupModal');
    if (existing) existing.remove();

    var overlay = document.createElement('div');
    overlay.id = 'nbMasterSetupModal';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.78);backdrop-filter:blur(6px);padding:16px;';

    overlay.innerHTML = ''
      + '<div style="background:var(--surface);border:1px solid rgba(251,146,60,0.4);border-radius:14px;padding:24px;width:100%;max-width:420px;box-shadow:0 24px 80px rgba(0,0,0,0.6);font-family:inherit;">'
        + '<button onclick="document.getElementById(\'nbMasterSetupModal\').remove()" style="position:absolute;top:12px;right:14px;background:none;border:none;color:var(--text-3);font-size:18px;cursor:pointer;">&#x2715;</button>'
        + '<div style="display:flex;align-items:center;gap:10px;margin-bottom:18px;">'
          + '<div style="width:36px;height:36px;border-radius:9px;background:rgba(251,146,60,0.15);border:1px solid rgba(251,146,60,0.35);display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;">&#x1F3A8;</div>'
          + '<div>'
            + '<div style="font-size:13px;font-weight:800;color:var(--text-1);">Phase 1 — Master Reference</div>'
            + '<div style="font-size:11px;color:var(--text-3);">Set the scene before generating</div>'
          + '</div>'
        + '</div>'

        + '<div style="margin-bottom:14px;">'
          + '<label style="font-size:10px;font-weight:700;color:var(--text-3);letter-spacing:0.08em;text-transform:uppercase;display:block;margin-bottom:6px;">Setting / Background</label>'
          + '<textarea id="nbMasterSettingInput" rows="3" placeholder="e.g. bright modern kitchen with white marble countertop, natural window light, small plant in background..." style="width:100%;background:var(--surface-2);border:1px solid var(--border-2);border-radius:8px;color:var(--text-1);font-size:12px;padding:10px;resize:vertical;font-family:inherit;line-height:1.5;">' + (setting || '') + '</textarea>'
          + '<div style="font-size:10px;color:var(--text-4);margin-top:4px;">Be specific — this locks the background for every scene in your video.</div>'
        + '</div>'

        + '<div style="margin-bottom:18px;">'
          + '<label style="font-size:10px;font-weight:700;color:var(--text-3);letter-spacing:0.08em;text-transform:uppercase;display:block;margin-bottom:6px;">Your Avatar Description <span style="color:var(--text-4);font-weight:400;text-transform:none;">(optional)</span></label>'
          + '<input id="nbMasterAvatarInput" type="text" placeholder="e.g. young woman with long dark hair wearing a white t-shirt..." value="' + escAttr(avatarDesc) + '" style="width:100%;background:var(--surface-2);border:1px solid var(--border-2);border-radius:8px;color:var(--text-1);font-size:12px;padding:9px 10px;font-family:inherit;">'
        + '</div>'

        + '<button id="nbMasterGenBtn" onclick="_nbRunMasterGeneration()" style="width:100%;padding:12px;border-radius:10px;background:linear-gradient(135deg,#fb923c,#f97316);border:none;color:#fff;font-size:13px;font-weight:800;cursor:pointer;font-family:inherit;letter-spacing:0.02em;transition:filter 0.15s;" onmouseenter="this.style.filter=\'brightness(1.1)\'" onmouseleave="this.style.filter=\'\'">&#x26A1; Generate Master Reference</button>'
        + '<div id="nbMasterGenStatus" style="display:none;text-align:center;padding:10px 0 0;font-size:11px;color:var(--text-3);"></div>'
      + '</div>';

    document.body.appendChild(overlay);
    var ta = document.getElementById('nbMasterSettingInput');
    if (ta) setTimeout(function(){ ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 80);
  };

  // ─── Step 2: Run generation (called from setup modal's Generate button) ───
  window._nbRunMasterGeneration = async function() {
    var settingVal  = (document.getElementById('nbMasterSettingInput')  ? document.getElementById('nbMasterSettingInput').value.trim()  : '') || 'a clean well-lit indoor space';
    var avatarVal   = (document.getElementById('nbMasterAvatarInput')   ? document.getElementById('nbMasterAvatarInput').value.trim()   : '') || 'the presenter';
    var kit         = (typeof getBrandKit === 'function') ? getBrandKit() : {};
    var productName = (document.getElementById('sbProduct') ? document.getElementById('sbProduct').value.trim() : '') || kit.productName || '';

    var genBtn    = document.getElementById('nbMasterGenBtn');
    var statusDiv = document.getElementById('nbMasterGenStatus');

    if (genBtn)    { genBtn.disabled = true; genBtn.textContent = 'Generating…'; }
    if (statusDiv) { statusDiv.style.display = 'block'; statusDiv.textContent = 'Calling Nano Banana API — this takes ~15s…'; }

    var jwt = await _nbGetJwt();
    if (!jwt) {
      showToast('Please log in first.', 'warning');
      if (genBtn)    { genBtn.disabled = false; genBtn.textContent = 'Generate Master Reference'; }
      if (statusDiv) { statusDiv.style.display = 'none'; }
      return;
    }

    var instruction = 'Photorealistic UGC video still — master establishing reference. '
      + avatarVal + ' stands or sits in ' + settingVal
      + ', facing camera directly with a natural relaxed expression and soft confident eye contact. '
      + (productName ? productName + ' may be visible on the surface nearby. ' : '')
      + 'Camera: medium shot, vertical 9:16 aspect ratio, soft cinematic key lighting from one side. '
      + 'Style: authentic UGC creator content, single person only, no text overlays, no watermarks, no AI artifacts. '
      + 'This is the MASTER REFERENCE — all other scenes will use this exact background and lighting.';

    try {
      var avatarCompressed = await _nbCompressImage(avatarImageDataUrl, 1280, 0.9);
      var avatarParts      = _nbSplitDataUrl(avatarCompressed);

      var _mr = await _nbPostComposite({
        instruction,
        avatarB64:  avatarParts.b64,
        avatarMime: avatarParts.mime,
        frameB64:   null,
        frameMime:  'image/jpeg',
      }, jwt, 'Reference');
      var res = _mr.res, data = _mr.data;

      if (!res.ok || data.error || !data.imageB64) {
        var errMsg = data.error || ('HTTP ' + res.status);
        if (statusDiv) { statusDiv.style.color = 'var(--danger)'; statusDiv.textContent = 'Failed: ' + errMsg; }
        if (genBtn)    { genBtn.disabled = false; genBtn.textContent = 'Retry'; }
        return;
      }

      var masterDataUrl = _nbImageDataUrl(data.mime, data.imageB64);

      // Close setup modal and show approval modal
      var setupModal = document.getElementById('nbMasterSetupModal');
      if (setupModal) setupModal.remove();

      _nbShowMasterApproval(masterDataUrl, settingVal, avatarVal, productName);

    } catch(e) {
      console.error('[NB Master] error:', e);
      if (statusDiv) { statusDiv.style.color = 'var(--danger)'; statusDiv.textContent = 'Error: ' + (e.message || e); }
      if (genBtn)    { genBtn.disabled = false; genBtn.textContent = 'Retry'; }
    }
  };

  // ─── Step 3: Approval modal — see result, approve or regenerate ───────────
  function _nbShowMasterApproval(masterDataUrl, setting, avatarDesc, productName) {
    var existing = document.getElementById('nbMasterApprovalModal');
    if (existing) existing.remove();

    var overlay = document.createElement('div');
    overlay.id = 'nbMasterApprovalModal';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.82);backdrop-filter:blur(8px);padding:16px;';

    overlay.innerHTML = ''
      + '<div style="background:var(--surface);border:1px solid rgba(52,211,153,0.4);border-radius:14px;padding:22px;width:100%;max-width:460px;box-shadow:0 24px 80px rgba(0,0,0,0.65);font-family:inherit;max-height:90vh;overflow-y:auto;">'

        // Header
        + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">'
          + '<div>'
            + '<div style="font-size:13px;font-weight:800;color:var(--text-1);">&#x1F3A8; Review Master Reference</div>'
            + '<div style="font-size:11px;color:var(--text-3);margin-top:2px;">Approve to lock this scene for all clips, or regenerate.</div>'
          + '</div>'
          + '<button onclick="document.getElementById(\'nbMasterApprovalModal\').remove()" style="background:none;border:none;color:var(--text-3);font-size:18px;cursor:pointer;padding:2px 6px;">&#x2715;</button>'
        + '</div>'

        // Generated image — 9:16 preview
        + '<div style="width:100%;max-width:220px;margin:0 auto 16px;border-radius:10px;overflow:hidden;border:2px solid rgba(52,211,153,0.5);box-shadow:0 0 24px rgba(52,211,153,0.2);">'
          + '<img src="' + masterDataUrl + '" style="width:100%;aspect-ratio:9/16;object-fit:cover;display:block;">'
        + '</div>'

        // Setting used
        + '<div style="background:var(--surface-2);border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:16px;">'
          + '<div style="font-size:9px;font-weight:700;color:var(--text-4);letter-spacing:0.1em;text-transform:uppercase;margin-bottom:4px;">Setting used</div>'
          + '<div style="font-size:12px;color:var(--text-2);line-height:1.5;">' + setting + '</div>'
        + '</div>'

        // Action buttons
        + '<div style="display:flex;flex-direction:column;gap:8px;">'

          // Approve — handler attached via addEventListener below (no inline
          // string-injection of the multi-KB masterDataUrl into the DOM)
          + '<button id="nbMasterApproveBtn" '
            + 'style="width:100%;padding:12px;border-radius:10px;background:linear-gradient(135deg,#00e5bc,#00c4a3);border:none;color:#001a14;font-size:13px;font-weight:800;cursor:pointer;font-family:inherit;transition:filter 0.15s;" '
            + 'onmouseenter="this.style.filter=\'brightness(1.1)\'" onmouseleave="this.style.filter=\'\'">&#x2705; Approve &amp; Lock Scene for All Clips</button>'

          // Regenerate with same settings
          + '<button onclick="document.getElementById(\'nbMasterApprovalModal\').remove();generateNBMasterViaAPI()" '
            + 'style="width:100%;padding:11px;border-radius:10px;background:rgba(251,146,60,0.1);border:1px solid rgba(251,146,60,0.35);color:#fb923c;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;" '
            + 'onmouseenter="this.style.background=\'rgba(251,146,60,0.2)\'" onmouseleave="this.style.background=\'rgba(251,146,60,0.1)\'">&#x21BA; Edit Setting &amp; Regenerate</button>'

        + '</div>'
      + '</div>';

    document.body.appendChild(overlay);

    // Attach approve handler via closure — passes masterDataUrl/setting/avatarDesc
    // by reference instead of string-injecting them into an inline onclick.
    var approveBtn = overlay.querySelector('#nbMasterApproveBtn');
    if (approveBtn) {
      approveBtn.addEventListener('click', function() {
        _nbApproveMaster(masterDataUrl, setting, avatarDesc);
      });
    }
  }
  window._nbShowMasterApproval = _nbShowMasterApproval;

  // ─── Step 4: User approves — distribute master to segments ───────────────
  window._nbApproveMaster = async function(masterDataUrl, setting, avatarDesc) {
    var modal = document.getElementById('nbMasterApprovalModal');
    if (modal) modal.remove();

    // GPT-4o-mini vision: get precise scene description from the image
    showToast('Analyzing scene...', 'info', 4000);
    var sceneDesc = await _nbDescribeScene(masterDataUrl, setting);
    window._sbSceneDesc       = sceneDesc;
    window._sbEstFrameDataUrl = masterDataUrl;

    // Distribute to all Producer segments
    _nbDistributeMaster(masterDataUrl, avatarDesc, sceneDesc);

    var n = segments.filter(function(s){ return s._scriptOnly; }).length;
    showToast('Scene locked for all ' + n + ' clips — ready for Phase 2.', 'success', 5000);

    // Refresh the producer modal to show Phase 1 complete
    var producerModal = document.getElementById('sbProducerModal');
    if (producerModal) { producerModal.remove(); if (typeof sbCopyBrief === 'function') sbCopyBrief(); }

    // Also update Phase 1 button to show success
    var ph1btn = document.getElementById('nbAPIPhase1Btn');
    if (ph1btn) ph1btn.innerHTML = '&#x2705; Master Reference Locked';
  };


  // ═══════════════════════════════════════════════════════════════════════════
  // PRODUCER PHASE 2 — Generate All Per-Scene Start Frames via NB API
  // ─────────────────────────────────────────────────────────────────────────
  // Ensures the master reference is set as frameDataUrl on each Producer
  // segment (so NB treats it as the input image), then calls the existing
  // generateAllNbComposites() loop which handles progress, approval modal, etc.
  // ═══════════════════════════════════════════════════════════════════════════

  // PRODUCER PHASE 2 - Generate All Per-Scene Start Frames via NB API
  // Ensures master reference is on each segment as frameDataUrl, then
  // delegates to generateAllNbComposites() which handles progress + approval.
  window.generateAllNBFramesViaAPI = async function() {
    if (!avatarImageDataUrl) {
      showToast('Upload your avatar photo first.', 'warning');
      return;
    }
    var producerSegs = segments.filter(function(s) {
      return s._scriptOnly && ((s.nbPrompt || '').trim() || s.frameDataUrl);
    });
    if (!producerSegs.length) {
      showToast('Build prompts in Video Producer first.', 'warning');
      return;
    }
    // Distribute master reference frame to segments that don't have one yet
    if (window._sbEstFrameDataUrl) {
      segments.forEach(function(seg) {
        if (seg._scriptOnly && !seg.frameDataUrl) {
          seg.frameDataUrl = window._sbEstFrameDataUrl;
        }
      });
    } else {
      showToast('Tip: run Phase 1 first to lock the background for all scenes. Generating anyway...', 'info', 5000);
    }
    // Delegate to existing loop - handles per-segment calls + approval modal
    if (typeof generateAllNbComposites === 'function') {
      await generateAllNbComposites();
    }
  };
