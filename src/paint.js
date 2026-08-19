'use strict';

  // ---------------------------------------------------------------------------
  // Built-in paint tool.
  //
  // A small bitmap brush engine that paints onto a canvas sized to the project's
  // working resolution, then drops the result into the existing asset library
  // (state.assets) and/or as a keyframe (addAssetKeyframe) - so painted art flows
  // through the exact same timeline / ML-interpolation path as imported images.
  //
  // Krita brush (.kpp) presets are supported: a .kpp is a gzip-wrapped ZIP
  // containing the preset XML (size / opacity / spacing / hardness / engine) and
  // a brush-tip image. We parse those and map them onto our bitmap stamps. Krita's
  // specialised engines (smudge, hatch, clone, ...) can't be reproduced faithfully
  // in a browser without their C++ code, so non-pixel engines fall back to the
  // same bitmap stamp using the extracted settings + tip where present.
  // ---------------------------------------------------------------------------

  var paintOpen = false;
  var editKeyframeId = null;        // when repainting an existing keyframe
  var paintCanvas = null, paintCtx = null;
  var brushList = [];               // array of brush presets
  var current = null;               // active brush preset
  var eraserOn = false;

  // Paint layers: transparent canvases composited over the keyframe base so
  // painted art is non-destructive and re-saves through the normal pipeline.
  var paintLayers = [];          // [{id,name,visible,opacity,canvas}]
  var activeLayer = null;
  var paintBaseCanvas = null;    // the keyframe/background we paint over
  var paintDispCtx = null;       // context of the on-screen #paintCanvas (composite)
  var layerSeq = 0;
  var pendingBrushes = null;     // brushes to apply once the tool is wired

  // live stroke state
  var drawing = false;
  var rafId = 0;
  var rawPoints = [];               // raw samples since last pump
  var rawLatest = null;             // most recent sample
  var smoothPt = null;              // eased (stabilised) point
  var lastPainted = null;           // last stamped point
  var smoothAlpha = 1;              // easing factor for this stroke
  var tipCanvas = null;             // pre-rendered, tinted brush tip (256px)
  var undoStack = [];          // per-stroke snapshots (ImageData)
  var onionImgs = {};          // kf.img -> decoded ghost image for onion skin

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }

  function hexToRgb(hex) {
    hex = String(hex || '#000000').replace('#', '');
    if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    var n = parseInt(hex, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function makeBrush(name, o) {
    return Object.assign({
      name: name, engine: 'pixel', radius: 40, opacity: 1, hardness: 0.8,
      spacing: 0.15, rotation: 0, color: '#1a1a1a', tip: null,
      followDir: false, builtin: false
    }, o || {});
  }

  function defaultBrushes() {
    return [
      makeBrush('Round (soft)', { radius: 45, hardness: 0.25, spacing: 0.08, builtin: true }),
      makeBrush('Round (hard)', { radius: 45, hardness: 0.95, spacing: 0.12, builtin: true }),
      makeBrush('Ink', { radius: 22, hardness: 1, opacity: 1, spacing: 0.04, builtin: true }),
      makeBrush('Flat', { radius: 50, hardness: 0.85, spacing: 0.06, rotation: 35, builtin: true }),
      makeBrush('Airbrush', { radius: 70, hardness: 0.0, opacity: 0.45, spacing: 0.03, builtin: true })
    ];
  }

  // ---- tip rendering ----------------------------------------------------------

  function refreshTip() {
    if (!tipCanvas) {
      tipCanvas = document.createElement('canvas');
      tipCanvas.width = 256; tipCanvas.height = 256;
    }
    var g = tipCanvas.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, 256, 256);
    var c = hexToRgb(current.color);
    if (current.tip && current.tip.width) {
      // Use the loaded tip image as an alpha mask, tinted to the brush colour.
      g.drawImage(current.tip, 0, 0, 256, 256);
      g.globalCompositeOperation = 'source-in';
      g.fillStyle = 'rgb(' + c.r + ',' + c.g + ',' + c.b + ')';
      g.fillRect(0, 0, 256, 256);
      g.globalCompositeOperation = 'source-over';
    } else {
      // Procedural round tip with a soft/hard falloff (Krita "hardness").
      var inner = clamp(current.hardness, 0, 1);
      var grd = g.createRadialGradient(128, 128, 0, 128, 128, 128);
      grd.addColorStop(0, 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',1)');
      grd.addColorStop(inner, 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',1)');
      grd.addColorStop(1, 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',0)');
      g.fillStyle = grd;
      g.beginPath();
      g.arc(128, 128, 128, 0, Math.PI * 2);
      g.fill();
    }
  }

  // ---- stamping ---------------------------------------------------------------

  function stampDab(x, y, r, op, rot) {
    if (eraserOn) paintCtx.globalCompositeOperation = 'destination-out';
    else paintCtx.globalCompositeOperation = 'source-over';
    paintCtx.globalAlpha = clamp(op, 0, 1);
    var rad = (rot == null) ? (current.rotation * Math.PI / 180) : rot;
    paintCtx.save();
    paintCtx.translate(x, y);
    paintCtx.rotate(rad);
    paintCtx.drawImage(tipCanvas, -r, -r, 2 * r, 2 * r);
    paintCtx.restore();
  }

  function stampSegment(from, to) {
    var dx = to.x - from.x, dy = to.y - from.y;
    var dist = Math.hypot(dx, dy);
    var step = Math.max(1, current.radius * current.spacing);
    var n = Math.max(1, Math.floor(dist / step));
    var ang = current.followDir ? Math.atan2(dy, dx) : null;
    for (var i = 1; i <= n; i++) {
      var t = i / n;
      var px = from.x + dx * t;
      var py = from.y + dy * t;
      var pr = from.press + (to.press - from.press) * t;
      var r = current.radius * (0.5 + 0.5 * pr);
      var op = current.opacity * (0.4 + 0.6 * pr);
      stampDab(px, py, r, op, ang);
    }
  }

  function pressureOf(ev) {
    if (ev.pointerType === 'mouse') return 1;
    var p = ev.pressure;
    if (!p || p <= 0) return 0.5;
    return p;
  }

  function alphaFromMode() {
    var mode = (byId('paintSmoothMode') && byId('paintSmoothMode').value) || 'stabilizer';
    var s = clamp((byId('paintSmoothStr') ? (+byId('paintSmoothStr').value) : 60) / 100, 0.01, 1);
    if (mode === 'none') return 1;
    if (mode === 'basic') return 1 - 0.6 * s;
    return 1 - 0.92 * s; // stabilizer: heavier smoothing / more lag
  }

  function pump() {
    if (!drawing) { rafId = 0; return; }
    var mode = (byId('paintSmoothMode') && byId('paintSmoothMode').value) || 'stabilizer';
    if (mode === 'stabilizer') {
      smoothPt.x += (rawLatest.x - smoothPt.x) * smoothAlpha;
      smoothPt.y += (rawLatest.y - smoothPt.y) * smoothAlpha;
      var end = { x: smoothPt.x, y: smoothPt.y, press: rawLatest.press };
      stampSegment(lastPainted, end);
      lastPainted = end;
    } else {
      for (var i = 0; i < rawPoints.length; i++) {
        var pt = rawPoints[i];
        if (mode === 'basic') {
          smoothPt.x += (pt.x - smoothPt.x) * smoothAlpha;
          smoothPt.y += (pt.y - smoothPt.y) * smoothAlpha;
        } else {
          smoothPt = { x: pt.x, y: pt.y };
        }
        stampSegment(lastPainted, smoothPt);
        lastPainted = { x: smoothPt.x, y: smoothPt.y, press: pt.press };
      }
    }
    compositeDisplay();
    rawPoints.length = 0;
    rafId = requestAnimationFrame(pump);
  }

  // ---- pointer handling -------------------------------------------------------

  function canvasPoint(ev) {
    var rect = paintCanvas.getBoundingClientRect();
    var sx = workW / rect.width, sy = workH / rect.height;
    return { x: (ev.clientX - rect.left) * sx, y: (ev.clientY - rect.top) * sy };
  }

  function onPaintDown(ev) {
    if (ev.button !== 0 && ev.pointerType === 'mouse') return;
    ev.preventDefault();
    try { paintCanvas.setPointerCapture(ev.pointerId); } catch (e) {}
    pushUndo();
    drawing = true;
    var p = canvasPoint(ev);
    var press = pressureOf(ev);
    rawPoints = [{ x: p.x, y: p.y, press: press }];
    rawLatest = { x: p.x, y: p.y, press: press };
    smoothPt = { x: p.x, y: p.y };
    lastPainted = { x: p.x, y: p.y, press: press };
    smoothAlpha = alphaFromMode();
    // initial dab so a click leaves a mark
    stampDab(p.x, p.y, current.radius * (0.5 + 0.5 * press), current.opacity * (0.4 + 0.6 * press));
    compositeDisplay();
    if (!rafId) rafId = requestAnimationFrame(pump);
  }

  function onPaintMove(ev) {
    if (!drawing) return;
    var p = canvasPoint(ev);
    var press = pressureOf(ev);
    rawPoints.push({ x: p.x, y: p.y, press: press });
    rawLatest = { x: p.x, y: p.y, press: press };
  }

  function onPaintUp(ev) {
    if (!drawing) return;
    drawing = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    // process any samples not yet consumed, then seal the stroke at the true end
    if (rawPoints.length) pump();
    if (rawLatest) {
      stampSegment(lastPainted, { x: rawLatest.x, y: rawLatest.y, press: rawLatest.press });
    }
    paintCtx.globalAlpha = 1;
    paintCtx.globalCompositeOperation = 'source-over';
    compositeDisplay();
    try { paintCanvas.releasePointerCapture(ev.pointerId); } catch (e) {}
  }

  // ---- per-stroke undo --------------------------------------------------------

  function pushUndo() {
    if (!activeLayer) return;
    try {
      // Snapshot the layer that is actually being drawn so undo restores the
      // correct canvas even if the active layer is switched before undoing.
      undoStack.push({ canvas: activeLayer.canvas, data: activeLayer.canvas.getContext('2d').getImageData(0, 0, workW, workH) });
    } catch (e) { return; }
    if (undoStack.length > 30) undoStack.shift();
  }

  function undoStroke() {
    if (!undoStack.length) { toast('Nothing to undo'); return; }
    var rec = undoStack.pop();
    rec.canvas.getContext('2d').putImageData(rec.data, 0, 0);
    compositeDisplay();
  }

  function clearCanvas() {
    pushUndo();
    paintCtx.clearRect(0, 0, workW, workH);
    compositeDisplay();
  }

  // ---- brush list UI ----------------------------------------------------------

  function buildBrushList() {
    var list = byId('paintBrushList');
    if (!list) return;
    list.innerHTML = '';
    brushList.forEach(function (b, i) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'paint-brush' + (b === current ? ' active' : '');
      btn.textContent = b.name + (b.engine && b.engine !== 'pixel' ? ' (' + b.engine + ')' : '');
      btn.addEventListener('click', function () {
        current = b;
        refreshTip();
        refreshBrushUI();
        buildBrushList();
      });
      list.appendChild(btn);
    });
  }

  function refreshBrushUI() {
    setVal('paintSize', current.radius, current.radius + 'px');
    setVal('paintOpacity', current.opacity, Math.round(current.opacity * 100) + '%');
    setVal('paintHardness', current.hardness, Math.round(current.hardness * 100) + '%');
    setVal('paintSpacing', current.spacing, Math.round(current.spacing * 100) + '%');
    setVal('paintRot', current.rotation, Math.round(current.rotation) + '°');
    var fd = byId('paintFollowDir'); if (fd) fd.checked = !!current.followDir;
    var col = byId('paintColor'); if (col) col.value = current.color;
    var nameEl = byId('paintBrushName'); if (nameEl) nameEl.textContent = current.name;
  }

  function setVal(id, v, label) {
    var el = byId(id);
    if (!el) return;
    el.value = String(v);
    if (el.classList.contains('slider')) syncSlider(el);
    var lab = byId(id + 'Val');
    if (lab) lab.textContent = label;
  }

  // ---- Krita (.kpp) parsing ---------------------------------------------------

  function readU16(b, o) { return b[o] | (b[o + 1] << 8); }
  function readU32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 24) | (b[o + 3] << 24)) >>> 0; }

  async function gunzip(u8) {
    var ds = new DecompressionStream('gzip');
    var stream = new Blob([u8]).stream().pipeThrough(ds);
    var ab = await new Response(stream).arrayBuffer();
    return new Uint8Array(ab);
  }

  async function inflateRaw(u8) {
    var ds = new DecompressionStream('deflate-raw');
    var stream = new Blob([u8]).stream().pipeThrough(ds);
    var ab = await new Response(stream).arrayBuffer();
    return new Uint8Array(ab);
  }

  // Minimal ZIP reader: walk local file headers, inflate deflated entries.
  function parseZip(u8) {
    var out = {};
    var i = 0;
    while (i + 4 <= u8.length) {
      if (u8[i] === 0x50 && u8[i + 1] === 0x4b && u8[i + 2] === 0x03 && u8[i + 3] === 0x04) {
        var method = readU16(u8, i + 8);
        var compSize = readU32(u8, i + 18);
        var nameLen = readU16(u8, i + 26);
        var extraLen = readU16(u8, i + 28);
        var name = '';
        for (var k = 0; k < nameLen; k++) name += String.fromCharCode(u8[i + 30 + k]);
        var dataStart = i + 30 + nameLen + extraLen;
        var comp = u8.slice(dataStart, dataStart + compSize);
        out[name] = { method: method, data: comp };
        i = dataStart + compSize;
      } else { i++; }
    }
    return out;
  }

  function decodeText(u8) {
    var s = '';
    for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return decodeURIComponent(escape(s));
  }

  function loadImageFromBytes(bytes, type) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(new Blob([bytes], { type: type || 'image/png' }));
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('bad image')); };
      img.src = url;
    });
  }

  async function parseKppFile(file) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('This browser lacks DecompressionStream; cannot read .kpp');
    }
    var buf = new Uint8Array(await file.arrayBuffer());
    var data = buf;
    if (buf[0] === 0x1f && buf[1] === 0x8b) data = await gunzip(buf);

    var entries;
    try { entries = parseZip(data); } catch (e) { entries = {}; }

    var presetName = (file.name || 'krita brush').replace(/\.kpp$/i, '');
    var tipImg = null;
    var params = {};

    // Collect candidate tip images (largest non-preview PNG) and the preset XML.
    var pngs = [];
    var xmlText = null;
    for (var name in entries) {
      if (name.endsWith('/')) continue;
      var ent = entries[name];
      var lower = name.toLowerCase();
      try {
        if (lower.endsWith('.xml') && !xmlText) {
          xmlText = decodeText(await inflateRaw(ent.data));
        } else if (lower.endsWith('.json') && lower.indexOf('meta') >= 0) {
          try {
            var mj = JSON.parse(decodeText(await inflateRaw(ent.data)));
            if (mj && mj.name) presetName = mj.name;
          } catch (e) {}
        } else if (lower.endsWith('.png') && lower.indexOf('preview') < 0) {
          var raw = ent.method === 0 ? ent.data : await inflateRaw(ent.data);
          pngs.push({ name: name, raw: raw });
        }
      } catch (e) {}
    }

    // Parse preset XML for engine + numeric params.
    if (xmlText) {
      try {
        var xml = new DOMParser().parseFromString(xmlText, 'application/xml');
        var idEl = xml.querySelector('paintop > id') || xml.querySelector('id');
        var engine = idEl ? idEl.textContent : 'pixel';
        xml.querySelectorAll('param').forEach(function (p) {
          var n = p.getAttribute('name');
          if (n) params[n.toLowerCase()] = p.textContent.trim();
        });
        if (params.name) presetName = params.name;
        // Pick the brush tip now that we may know its filename.
        if (params.brushtip && pngs.length) {
          var match = pngs.filter(function (p) { return p.name.toLowerCase().indexOf(String(params.brushtip).toLowerCase()) >= 0; });
          if (match[0]) tipImg = await loadImageFromBytes(match[0].raw, 'image/png');
        }
      } catch (e) {}
    }

    if (!tipImg && pngs.length) {
      // Fallback: largest PNG (exclude tiny thumbnails that slipped through).
      var best = null, bestArea = 0;
      for (var j = 0; j < pngs.length; j++) {
        try {
          var im = await loadImageFromBytes(pngs[j].raw, 'image/png');
          var area = im.width * im.height;
          if (area > bestArea && area >= 16) { bestArea = area; best = im; }
        } catch (e) {}
      }
      tipImg = best;
    }

    var radius = parseFloat(params.diameter || params.radius);
    if (!isFinite(radius)) radius = 45;
    radius = clamp(radius, 2, 320);
    var opacity = parseFloat(params.opacity);
    if (!isFinite(opacity)) opacity = 1; else if (opacity > 1) opacity = opacity / 100;
    opacity = clamp(opacity, 0.02, 1);
    var spacing = parseFloat(params.spacing);
    if (!isFinite(spacing)) spacing = 0.15;
    spacing = clamp(spacing, 0.02, 1);
    var hard = parseFloat(params.softness != null ? params.softness : params.hardness != null ? params.hardness : params.ratio);
    if (!isFinite(hard)) hard = 0.8;
    hard = clamp(hard, 0, 1);

    var brush = makeBrush(presetName, {
      engine: (params && (xmlText ? 'krita' : 'pixel')),
      radius: radius, opacity: opacity, spacing: spacing, hardness: hard,
      tip: tipImg, color: (current ? current.color : '#1a1a1a')
    });
    brush.builtin = false;
    brushList.push(brush);
    current = brush;
    refreshTip();
    refreshBrushUI();
    buildBrushList();
    toast('Loaded brush: ' + presetName);
  }

  // ---- save / integrate -------------------------------------------------------

  function canvasToURL() { return paintCanvas.toDataURL('image/png'); }

  function assetName() { return (current ? current.name : 'Paint') + ' paint'; }

  function ensureAsset(url) {
    if (!state.assets.some(function (a) { return a.img === url; })) {
      state.assets.push({ img: url, name: assetName(), w: workW, h: workH });
    }
  }

  function saveToLibrary() {
    var url = canvasToURL();
    recordUndo();
    if (editKeyframeId) {
      var kf = null;
      for (var i = 0; i < state.keyframes.length; i++) if (state.keyframes[i].id === editKeyframeId) kf = state.keyframes[i];
      if (kf) {
        kf.img = url; kf.w = workW; kf.h = workH;
        savePaintLayersToKeyframe(kf);
        ensureAsset(url);
        invalidateAround(kf.id);
        applyWorkSize();
        renderAll();
        scheduleGenerate();
      }
      toast('Keyframe updated');
    } else {
      ensureAsset(url);
      renderAssets();
      toast('Added to library');
    }
  }

  function addKeyframeAtPlayhead() {
    var url = canvasToURL();
    ensureAsset(url);
    renderAssets();
    addAssetKeyframe(url, state.playhead);
    var nk = null;
    for (var i = 0; i < state.keyframes.length; i++) if (state.keyframes[i].img === url) nk = state.keyframes[i];
    savePaintLayersToKeyframe(nk);
    toast('Keyframe added at ' + fmtTime(state.playhead));
  }

  // ---- paint layers ----------------------------------------------------------

  function getKf(id) {
    for (var i = 0; i < state.keyframes.length; i++) if (state.keyframes[i].id === id) return state.keyframes[i];
    return null;
  }

  // Render base + all visible layers onto the on-screen canvas.
  function compositeDisplay() {
    if (!paintDispCtx) return;
    paintDispCtx.setTransform(1, 0, 0, 1, 0, 0);
    paintDispCtx.clearRect(0, 0, workW, workH);
    if (editKeyframeId) paintDrawOnion(paintDispCtx);
    if (paintBaseCanvas) paintDispCtx.drawImage(paintBaseCanvas, 0, 0, workW, workH);
    paintLayers.forEach(function (l) {
      if (!l.visible) return;
      paintDispCtx.globalAlpha = l.opacity;
      paintDispCtx.drawImage(l.canvas, 0, 0, workW, workH);
      paintDispCtx.globalAlpha = 1;
    });
  }

  // ---- onion skin: ghosts of neighbouring keyframes while painting --------

  // Fit an image into the work canvas, preserving aspect ratio (letterboxed),
  // so ghost frames drawn at other resolutions are not distorted.
  function onionDrawContain(ctx, img, dw, dh) {
    var iw = img.naturalWidth || img.width || dw;
    var ih = img.naturalHeight || img.height || dh;
    if (!iw || !ih) { ctx.drawImage(img, 0, 0, dw, dh); return; }
    var s = Math.min(dw / iw, dh / ih);
    var w = Math.round(iw * s), h = Math.round(ih * s);
    ctx.drawImage(img, (dw - w) / 2, (dh - h) / 2, w, h);
  }

  // Neighbours of the keyframe being edited, on that keyframe's own layer, so
  // the ghost stack follows the timeline rather than the playhead.
  function paintOnionNeighbors() {
    if (!editKeyframeId) return { before: [], after: [] };
    var kf = getKf(editKeyframeId);
    if (!kf) return { before: [], after: [] };
    var ks = sortedKeyframes(kf.layer);
    if (!ks.length) return { before: [], after: [] };
    var idx = -1;
    for (var i = 0; i < ks.length; i++) if (ks[i].id === kf.id) { idx = i; break; }
    if (idx === -1) return { before: [], after: [] };
    var b = (state.onionCfg && state.onionCfg.before) | 0;
    var a = (state.onionCfg && state.onionCfg.after) | 0;
    var before = [], after = [];
    for (var j = 1; j <= b; j++) { var k = idx - j; if (k >= 0) before.push(ks[k]); }
    for (var m = 1; m <= a; m++) { var n = idx + m; if (n < ks.length) after.push(ks[n]); }
    return { before: before, after: after };
  }

  function onionImgFor(kf) {
    if (kf && kf.img != null && onionImgs[kf.img]) return onionImgs[kf.img];
    if (kf && kf.img != null && typeof imgCache !== 'undefined' && imgCache.get) {
      var c = imgCache.get(kf.img);
      if (c) return c;
    }
    return null;
  }

  function loadOnionImages(nb, done) {
    var list = nb.before.concat(nb.after);
    var pending = list.length;
    if (!pending) { done(); return; }
    var seen = {};
    list.forEach(function (kf) {
      var src = kf && kf.img;
      if (!src || seen[src]) { if (--pending === 0) done(); return; }
      seen[src] = true;
      if (onionImgs[src] != null || (typeof imgCache !== 'undefined' && imgCache.get && imgCache.get(src))) {
        if (--pending === 0) done();
        return;
      }
      var im = new Image();
      im.onload = function () { onionImgs[src] = im; if (--pending === 0) done(); };
      im.onerror = function () { onionImgs[src] = null; if (--pending === 0) done(); };
      im.src = src;
    });
  }

  function paintDrawOnion(ctx) {
    if (!state.onion) return;
    var nb = paintOnionNeighbors();
    if (!nb.before.length && !nb.after.length) return;
    var op = state.onionCfg ? state.onionCfg.opacity : 0.28;
    var tint = state.onionCfg && state.onionCfg.tint;
    var tintColor = state.onionCfg && state.onionCfg.tintColor;
    var tintOp = state.onionCfg ? state.onionCfg.tintOpacity : 0.35;
    function drawGhost(kf, alpha) {
      var img = onionImgFor(kf);
      if (!img) return;
      if (!tint || !tintColor) {
        ctx.globalAlpha = alpha;
        onionDrawContain(ctx, img, workW, workH);
        return;
      }
      var c = document.createElement('canvas');
      c.width = workW; c.height = workH;
      var g = c.getContext('2d');
      g.globalAlpha = alpha;
      onionDrawContain(g, img, workW, workH);
      g.globalCompositeOperation = 'source-atop';
      g.globalAlpha = tintOp;
      g.fillStyle = tintColor;
      g.fillRect(0, 0, workW, workH);
      ctx.globalAlpha = 1;
      ctx.drawImage(c, 0, 0);
    }
    ctx.save();
    for (var i = 0; i < nb.before.length; i++) {
      var fade = 1 - i * 0.22; if (fade < 0.22) fade = 0.22;
      drawGhost(nb.before[i], op * fade);
    }
    for (var x = 0; x < nb.after.length; x++) {
      var fade2 = 1 - x * 0.22; if (fade2 < 0.22) fade2 = 0.22;
      drawGhost(nb.after[x], op * 0.8 * fade2);
    }
    ctx.restore();
  }

  function refreshOnion() {
    if (!state.onion || !editKeyframeId) { compositeDisplay(); return; }
    onionImgs = {};
    loadOnionImages(paintOnionNeighbors(), compositeDisplay);
  }

  function loadOnionPrefs() {
    try {
      var s = localStorage.getItem(ONION_KEY);
      if (s) {
        var o = JSON.parse(s);
        if (typeof o.onion === 'boolean') state.onion = o.onion;
        if (o.cfg) Object.assign(state.onionCfg, o.cfg);
      }
    } catch (e) {}
  }

  function saveOnionPrefs() {
    try { localStorage.setItem(ONION_KEY, JSON.stringify({ onion: state.onion, cfg: state.onionCfg })); } catch (e) {}
  }

  function syncPaintOnionUI() {
    var o = state.onionCfg || {};
    var c = byId('paintOnion'); if (c) c.checked = !!state.onion;
    setVal('paintOnionBefore', o.before | 0, String(o.before | 0));
    setVal('paintOnionAfter', o.after | 0, String(o.after | 0));
    setVal('paintOnionOpacity', o.opacity, Math.round((o.opacity == null ? 0.28 : o.opacity) * 100) + '%');
    var t = byId('paintOnionTint'); if (t) t.checked = !!o.tint;
  }

  function addLayer(name, makeActive) {
    if (makeActive === undefined) makeActive = true;
    layerSeq++;
    var cv = document.createElement('canvas');
    cv.width = workW; cv.height = workH;
    var layer = { id: 'PL' + layerSeq, name: name || ('Layer ' + layerSeq), visible: true, opacity: 1, canvas: cv };
    paintLayers.push(layer);
    if (makeActive || !activeLayer) activeLayer = layer;
    paintCtx = activeLayer.canvas.getContext('2d');
    rebuildLayerUI();
    return layer;
  }

  function deleteActiveLayer() {
    if (paintLayers.length <= 1) { toast('Keep at least one layer'); return; }
    var idx = paintLayers.indexOf(activeLayer);
    paintLayers.splice(idx, 1);
    activeLayer = paintLayers[Math.min(idx, paintLayers.length - 1)];
    paintCtx = activeLayer.canvas.getContext('2d');
    undoStack = [];
    rebuildLayerUI();
    compositeDisplay();
  }

  function moveLayer(idx, delta) {
    var ni = idx + delta;
    if (ni < 0 || ni >= paintLayers.length) return;
    var tmp = paintLayers[idx];
    paintLayers[idx] = paintLayers[ni];
    paintLayers[ni] = tmp;
    rebuildLayerUI();
    compositeDisplay();
  }

  // Collapse the active layer into the layer directly beneath it (respecting
  // each layer's visibility + opacity, so the on-screen result is unchanged).
  function mergeDown() {
    var idx = paintLayers.indexOf(activeLayer);
    if (idx <= 0) { toast('Already at the bottom'); return; }
    var below = paintLayers[idx - 1];
    var mc = document.createElement('canvas');
    mc.width = workW; mc.height = workH;
    var mctx = mc.getContext('2d');
    if (below.visible) { mctx.globalAlpha = below.opacity; mctx.drawImage(below.canvas, 0, 0, workW, workH); }
    if (activeLayer.visible) { mctx.globalAlpha = activeLayer.opacity; mctx.drawImage(activeLayer.canvas, 0, 0, workW, workH); }
    mctx.globalAlpha = 1;
    below.canvas = mc;
    below.opacity = 1;
    below.visible = !!(below.visible || activeLayer.visible);
    paintLayers.splice(idx, 1);
    activeLayer = below;
    paintCtx = below.canvas.getContext('2d');
    undoStack = [];
    rebuildLayerUI();
    compositeDisplay();
  }

  function rebuildLayerUI() {
    var list = byId('paintLayerList');
    if (!list) return;
    list.innerHTML = '';
    for (var i = paintLayers.length - 1; i >= 0; i--) {
      (function (i) {
        var l = paintLayers[i];
        var row = document.createElement('div');
        row.className = 'paint-layer' + (l === activeLayer ? ' active' : '');
        var eye = document.createElement('input');
        eye.type = 'checkbox'; eye.checked = l.visible;
        eye.addEventListener('change', function () { l.visible = eye.checked; compositeDisplay(); });
        var name = document.createElement('span');
        name.className = 'paint-layer-name';
        name.textContent = l.name;
        name.title = 'Select layer';
        var up = document.createElement('button');
        up.type = 'button'; up.className = 'paint-layer-btn'; up.textContent = '↑';
        up.title = 'Move up';
        up.addEventListener('click', function (e) { e.stopPropagation(); moveLayer(i, 1); });
        var down = document.createElement('button');
        down.type = 'button'; down.className = 'paint-layer-btn'; down.textContent = '↓';
        down.title = 'Move down';
        down.addEventListener('click', function (e) { e.stopPropagation(); moveLayer(i, -1); });
        var op = document.createElement('input');
        op.type = 'range'; op.min = '0'; op.max = '1'; op.step = '0.01'; op.value = String(l.opacity);
        op.className = 'paint-layer-op';
        op.title = 'Layer opacity';
        op.addEventListener('input', function (e) { e.stopPropagation(); l.opacity = +op.value; compositeDisplay(); });
        op.addEventListener('click', function (e) { e.stopPropagation(); });
        name.addEventListener('click', function () {
          activeLayer = l; paintCtx = l.canvas.getContext('2d'); undoStack = []; rebuildLayerUI();
        });
        row.appendChild(eye);
        row.appendChild(name);
        row.appendChild(up);
        row.appendChild(down);
        row.appendChild(op);
        row.addEventListener('click', function (e) {
          if (e.target === eye || e.target === name || e.target === op || e.target === up || e.target === down) return;
          activeLayer = l; paintCtx = l.canvas.getContext('2d'); undoStack = []; rebuildLayerUI();
        });
        list.appendChild(row);
      })(i);
    }
  }

  // A layer contributes nothing if it has no painted (non-transparent) pixels.
  function layerHasInk(l) {
    try {
      var d = l.canvas.getContext('2d').getImageData(0, 0, workW, workH).data;
      for (var i = 3; i < d.length; i += 4) if (d[i] !== 0) return true;
    } catch (e) {}
    return false;
  }

  // Snapshot the current stack (layer pixels -> data URLs) for project save.
  // Empty layers are dropped since they add nothing to the composite.
  function capturePaintLayers() {
    return paintLayers.filter(layerHasInk).map(function (l) {
      return { name: l.name, visible: !!l.visible, opacity: l.opacity, img: l.canvas.toDataURL('image/png') };
    });
  }

  // Rebuild the layer stack (optionally from saved data URLs). When no saved
  // stack is given we just start with one empty layer.
  function restorePaintLayers(arr) {
    paintLayers = [];
    activeLayer = null;
    layerSeq = 0;
    (arr || []).forEach(function (d) {
      var cv = document.createElement('canvas');
      cv.width = workW; cv.height = workH;
      var layer = {
        id: 'PL' + (++layerSeq),
        name: d.name || ('Layer ' + layerSeq),
        visible: d.visible !== false,
        opacity: (d.opacity == null ? 1 : d.opacity),
        canvas: cv
      };
      if (d.img) {
        var im = new Image();
        im.onload = function () { cv.getContext('2d').drawImage(im, 0, 0, workW, workH); compositeDisplay(); };
        im.src = d.img;
      }
      paintLayers.push(layer);
    });
    if (!paintLayers.length) addLayer('Layer 1', true);
    activeLayer = paintLayers[paintLayers.length - 1];
    paintCtx = activeLayer.canvas.getContext('2d');
    rebuildLayerUI();
  }

  function savePaintLayersToKeyframe(kf) {
    if (!kf) return;
    var real = capturePaintLayers();
    if (!real.length) { kf.paintLayers = undefined; return; }
    // A single fully-opaque, visible layer whose pixels already equal the flattened
    // image is perfectly reconstructed on reopen by seeding kf.img into layer 1, so
    // storing it again would only bloat the project file. Skip it.
    if (real.length === 1 && real[0].visible !== false && real[0].opacity === 1 && real[0].img === kf.img) {
      kf.paintLayers = undefined;
      return;
    }
    kf.paintLayers = real;
  }

  // ---- brush presets (persisted in the project + standalone .khuwari files) --

  // Convert a brush to a plain, serialisable object (tip image -> data URL).
  function serializeBrush(b) {
    var o = {
      name: b.name, engine: b.engine, radius: b.radius, opacity: b.opacity,
      hardness: b.hardness, spacing: b.spacing, rotation: b.rotation,
      color: b.color, followDir: !!b.followDir
    };
    try {
      if (b.tip && b.tip.width) {
        var c = document.createElement('canvas');
        c.width = b.tip.width; c.height = b.tip.height;
        c.getContext('2d').drawImage(b.tip, 0, 0);
        o.tipURL = c.toDataURL('image/png');
      }
    } catch (e) {}
    return o;
  }

  // Rebuild a brush object (optionally with its tip image) from a preset.
  function deserializeBrush(preset) {
    return new Promise(function (resolve) {
      var b = makeBrush(preset.name || 'Preset', {
        engine: preset.engine || 'pixel',
        radius: clamp(+preset.radius || 40, 1, 320),
        opacity: clamp(+preset.opacity != null ? +preset.opacity : 1, 0.02, 1),
        hardness: clamp(+preset.hardness != null ? +preset.hardness : 0.8, 0, 1),
        spacing: clamp(+preset.spacing != null ? +preset.spacing : 0.15, 0.01, 1),
        rotation: +preset.rotation || 0,
        color: preset.color || '#1a1a1a',
        followDir: !!preset.followDir,
        builtin: false
      });
      if (preset.tipURL) {
        var im = new Image();
        im.onload = function () { b.tip = im; if (b === current) refreshTip(); resolve(b); };
        im.onerror = function () { resolve(b); };
        im.src = preset.tipURL;
      } else resolve(b);
    });
  }

  // Restore saved custom brushes (called from project load). Defaults always
  // come first; only user-made presets are re-added.
  function applyLoadedBrushes(arr) {
    if (!Array.isArray(arr)) return;
    if (!paintCanvas) { pendingBrushes = arr; return; }
    brushList = defaultBrushes();
    current = brushList[0];
    buildBrushList();
    refreshBrushUI();
    arr.forEach(function (p) {
      deserializeBrush(p).then(function (b) { brushList.push(b); buildBrushList(); });
    });
  }

  function resetPaintBrushes() {
    brushList = defaultBrushes();
    current = brushList[0];
    if (paintCanvas) { buildBrushList(); refreshBrushUI(); }
  }

  function saveBrushPreset() {
    var nameInput = byId('paintPresetName');
    var name = (nameInput && nameInput.value) || current.name;
    var preset = serializeBrush(current);
    preset.name = name;
    deserializeBrush(preset).then(function (b) {
      brushList.push(b);
      current = b;
      buildBrushList();
      refreshBrushUI();
      toast('Preset saved: ' + name);
    });
  }

  function savePresetFile() {
    var preset = serializeBrush(current);
    var blob = new Blob([JSON.stringify(preset, null, 2)], { type: 'application/json' });
    downloadBlob(blob, (current.name || 'brush') + '.khuwari', 'application/json');
    toast('Brush preset exported');
  }

  function loadPresetFile() {
    var f = this.files && this.files[0];
    this.value = '';
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var data = JSON.parse(reader.result);
        var arr = Array.isArray(data) ? data : (data.brushes ? data.brushes : [data]);
        arr.forEach(function (p) {
          deserializeBrush(p).then(function (b) { brushList.push(b); buildBrushList(); });
        });
        refreshBrushUI();
        toast('Loaded ' + arr.length + ' preset(s)');
      } catch (e) {
        toast('Could not load preset file');
      }
    };
    reader.readAsText(f);
  }

  // ---- open / close -----------------------------------------------------------

  function fitCanvas() {
    var wrap = byId('paintCanvasWrap');
    if (!wrap || !paintCanvas) return;
    var aw = wrap.clientWidth - 24, ah = wrap.clientHeight - 24;
    if (aw <= 0 || ah <= 0) return;
    var scale = Math.min(aw / workW, ah / workH, 1.6);
    paintCanvas.style.width = (workW * scale) + 'px';
    paintCanvas.style.height = (workH * scale) + 'px';
  }

  function openPaint(opts) {
    opts = opts || {};
    editKeyframeId = opts.keyframeId || null;
    var ov = byId('paintOverlay');
    if (!ov) return;
    ov.classList.remove('hidden');
    paintOpen = true;
    paintCanvas.width = workW;
    paintCanvas.height = workH;
    paintDispCtx = paintCanvas.getContext('2d');

    // The background canvas stays transparent; a keyframe's existing image is
    // folded into the first layer (so repainted art stays editable) and any
    // previously saved layer stack is restored whole.
    if (!paintBaseCanvas) paintBaseCanvas = document.createElement('canvas');
    paintBaseCanvas.width = workW; paintBaseCanvas.height = workH;
    paintBaseCanvas.getContext('2d').clearRect(0, 0, workW, workH);

    undoStack = [];
    var kf = editKeyframeId ? getKf(editKeyframeId) : null;
    if (kf && Array.isArray(kf.paintLayers) && kf.paintLayers.length) {
      restorePaintLayers(kf.paintLayers);
    } else {
      restorePaintLayers(null);
      if (kf) {
        var img = new Image();
        img.onload = function () {
          paintLayers[0].canvas.getContext('2d').drawImage(img, 0, 0, workW, workH);
          compositeDisplay();
        };
        img.src = kf.img;
      }
    }
    var banner = byId('paintEditBanner');
    if (kf) { if (banner) { banner.textContent = 'Repainting keyframe at ' + fmtTime(kf.time); banner.classList.remove('hidden'); } }
    else if (banner) { banner.classList.add('hidden'); }
    fitCanvas();
    refreshTip();
    refreshBrushUI();
    rebuildLayerUI();
    syncPaintOnionUI();
    compositeDisplay();
    refreshOnion();
  }

  function closePaint() {
    if (drawing) { drawing = false; if (rafId) { cancelAnimationFrame(rafId); rafId = 0; } }
    var ov = byId('paintOverlay');
    if (ov) ov.classList.add('hidden');
    paintOpen = false;
  }

  function wirePaint() {
    paintCanvas = byId('paintCanvas');
    paintDispCtx = paintCanvas.getContext('2d');
    brushList = defaultBrushes();
    current = brushList[0];

    byId('btnPaintClose').addEventListener('click', closePaint);
    var openBtn = byId('btnPaint');
    if (openBtn) openBtn.addEventListener('click', function () { openPaint(); });
    var kfPaint = byId('btnKfPaint');
    if (kfPaint) kfPaint.addEventListener('click', function () {
      var id = el.kfMenu && el.kfMenu._kfId;
      if (id) openPaint({ keyframeId: id });
      else if (state.selectedId) openPaint({ keyframeId: state.selectedId });
      else toast('Right-click a frame, then choose Edit in paint');
    });

    byId('paintCanvas').addEventListener('pointerdown', onPaintDown);
    byId('paintCanvas').addEventListener('pointermove', onPaintMove);
    byId('paintCanvas').addEventListener('pointerup', onPaintUp);
    byId('paintCanvas').addEventListener('pointercancel', onPaintUp);
    byId('paintCanvas').addEventListener('pointerleave', function (e) { if (drawing) onPaintUp(e); });

    // settings
    byId('paintSize').addEventListener('input', function () { current.radius = +this.value; setVal('paintSize', this.value, Math.round(+this.value) + 'px'); });
    byId('paintOpacity').addEventListener('input', function () { current.opacity = +this.value; setVal('paintOpacity', this.value, Math.round(+this.value * 100) + '%'); });
    byId('paintHardness').addEventListener('input', function () { current.hardness = +this.value; setVal('paintHardness', this.value, Math.round(+this.value * 100) + '%'); refreshTip(); });
    byId('paintSpacing').addEventListener('input', function () { current.spacing = +this.value; setVal('paintSpacing', this.value, Math.round(+this.value * 100) + '%'); });
    byId('paintRot').addEventListener('input', function () { current.rotation = +this.value; setVal('paintRot', this.value, Math.round(+this.value) + '°'); });
    byId('paintColor').addEventListener('input', function () { current.color = this.value; refreshTip(); });
    byId('paintEraser').addEventListener('change', function () { eraserOn = this.checked; });
    byId('paintSmoothMode').addEventListener('change', refreshBrushUI);
    byId('paintSmoothStr').addEventListener('input', function () { setVal('paintSmoothStr', this.value, Math.round(+this.value) + '%'); });

    // follow stroke direction
    byId('paintFollowDir').addEventListener('change', function () { current.followDir = this.checked; });

    // paint layers
    byId('btnPaintAddLayer').addEventListener('click', function () { addLayer(); });
    byId('btnPaintDelLayer').addEventListener('click', function () { deleteActiveLayer(); });
    byId('btnPaintMergeDown').addEventListener('click', function () { mergeDown(); });

    // brush presets (kept in the project + standalone .khuwari files)
    byId('btnPaintSavePreset').addEventListener('click', saveBrushPreset);
    byId('btnPaintSavePresetFile').addEventListener('click', savePresetFile);
    byId('btnPaintLoadPreset').addEventListener('click', function () { byId('paintPresetInput').click(); });
    byId('paintPresetInput').addEventListener('change', loadPresetFile);

    // load brush files
    byId('btnPaintLoadKpp').addEventListener('click', function () { byId('paintKppInput').click(); });
    byId('paintKppInput').addEventListener('change', function () {
      var f = this.files && this.files[0]; this.value = '';
      if (!f) return;
      parseKppFile(f).catch(function (e) { toast('Could not load brush: ' + (e.message || e)); });
    });
    byId('btnPaintLoadTip').addEventListener('click', function () { byId('paintTipInput').click(); });
    byId('paintTipInput').addEventListener('change', function () {
      var f = this.files && this.files[0]; this.value = '';
      if (!f) return;
      readImageFile(f).then(function (d) {
        var im = new Image();
        im.onload = function () { current.tip = im; refreshTip(); toast('Brush tip loaded'); };
        im.src = d.img;
      }).catch(function () { toast('Could not load tip image'); });
    });

    // actions
    byId('btnPaintClear').addEventListener('click', clearCanvas);
    byId('btnPaintUndo').addEventListener('click', undoStroke);
    byId('btnPaintSaveLib').addEventListener('click', saveToLibrary);
    byId('btnPaintAddKf').addEventListener('click', addKeyframeAtPlayhead);

    // keyboard: Esc closes, Ctrl+Z undoes a stroke, Ctrl+Shift+N adds a layer,
    // Ctrl+E merges the active layer down (all while the paint tool is open).
    document.addEventListener('keydown', function (e) {
      if (!paintOpen) return;
      var t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      var mod = e.ctrlKey || e.metaKey;
      if (e.key === 'Escape') { closePaint(); }
      else if (mod && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); undoStroke(); }
      else if (mod && e.shiftKey && (e.key === 'n' || e.key === 'N')) { e.preventDefault(); addLayer(); }
      else if (mod && !e.shiftKey && (e.key === 'e' || e.key === 'E')) { e.preventDefault(); mergeDown(); }
    });

    // onion skin: mirror the global state.onion / state.onionCfg (used by the
    // main viewport) so the toggle + settings stay consistent across the app
    loadOnionPrefs();
    syncPaintOnionUI();
    var poChk = byId('paintOnion');
    if (poChk) poChk.addEventListener('change', function () { state.onion = this.checked; saveOnionPrefs(); refreshOnion(); });
    var poB = byId('paintOnionBefore');
    if (poB) poB.addEventListener('input', function () { state.onionCfg.before = +this.value; setVal('paintOnionBefore', this.value, this.value); saveOnionPrefs(); refreshOnion(); });
    var poA = byId('paintOnionAfter');
    if (poA) poA.addEventListener('input', function () { state.onionCfg.after = +this.value; setVal('paintOnionAfter', this.value, this.value); saveOnionPrefs(); refreshOnion(); });
    var poO = byId('paintOnionOpacity');
    if (poO) poO.addEventListener('input', function () { state.onionCfg.opacity = +this.value; setVal('paintOnionOpacity', this.value, Math.round(+this.value * 100) + '%'); saveOnionPrefs(); compositeDisplay(); });
    var poT = byId('paintOnionTint');
    if (poT) poT.addEventListener('change', function () { state.onionCfg.tint = this.checked; saveOnionPrefs(); compositeDisplay(); });

    buildBrushList();
    refreshBrushUI();
    if (pendingBrushes) { var pb = pendingBrushes; pendingBrushes = null; applyLoadedBrushes(pb); }
  }
