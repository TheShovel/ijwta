'use strict';


  // Scale that makes the work area fit the panel without upscaling (1 at
  // native-or-larger panels). viewZoom is relative to this fit.
  function viewportFitScale() {
    var w = el.previewWrap.clientWidth, h = el.previewWrap.clientHeight;
    if (!w || !h) return 1;
    return Math.min(1, w / workW, h / workH);
  }

  // Grow/shrink the canvas element so "viewZoom 1" fits the panel and higher
  // zooms make it overflow the wrap, which then scrolls instead of clipping.
  // The stage wrapper and the marker overlay track the canvas size so markers
  // stay aligned at any zoom.
  function applyViewportSize() {
    var s = viewportFitScale() * state.viewZoom;
    var w = Math.round(workW * s), h = Math.round(workH * s);
    el.previewCanvas.style.width = w + 'px';
    el.previewCanvas.style.height = h + 'px';
    el.previewStage.style.width = w + 'px';
    el.previewStage.style.height = h + 'px';
  }

  function zoomViewport(factor, e) {
    // Zoom about the cursor, keeping the content point under it fixed: with
    // the display scaled by z/old, scroll moves by the same ratio.
    var old = state.viewZoom;
    var z = clamp(old * factor, 1, 20);
    if (z === old) return;
    var wrap = el.previewWrap;
    var wr = wrap.getBoundingClientRect();
    var mx = e.clientX - wr.left;   // cursor offset within the wrap (CSS px)
    var my = e.clientY - wr.top;
    var sl = wrap.scrollLeft, st = wrap.scrollTop;
    wrap.scrollLeft = (sl + mx) * (z / old) - mx;
    wrap.scrollTop = (st + my) * (z / old) - my;
    state.viewZoom = z;
    applyViewportSize();
    renderPreview();
    updateViewportLabel();
  }

  function resetViewport() {
    state.viewZoom = 1;
    el.previewWrap.scrollLeft = 0;
    el.previewWrap.scrollTop = 0;
    applyViewportSize();
    renderPreview();
    updateViewportLabel();
  }

  function updateViewportLabel() {
    var z = Math.round(state.viewZoom * 100);
    var pan = (el.previewWrap.scrollLeft || el.previewWrap.scrollTop) ? ' · pan' : '';
    el.resLabel.textContent = 'working size ' + workW + '×' + workH + ' · view ' + z + '%' + pan;
  }

  // Which frame the viewport shows is now a composite of every visible layer
  // (see framesAt). The last successfully drawn composite is remembered so the
  // screen never flashes black while a new frame's images decode.
  var lastPreview = null; // { key, bits } of the last composite actually drawn
  function onionNeighbors() {
    var L = layerById(state.activeLayerId);
    if (!L || L.type === 'fill') return { before: [], after: [] };
    var ks = sortedKeyframes(L.id);
    if (!ks.length) return { before: [], after: [] };
    var t = state.playhead;
    var idx = -1;
    for (var i = 0; i < ks.length; i++) {
      if (ks[i].time <= t + 1e-9) idx = i;
    }
    var before = [], after = [];
    var b = (state.onionCfg && state.onionCfg.before) | 0;
    var a = (state.onionCfg && state.onionCfg.after) | 0;
    for (var j = 1; j <= b; j++) { var k = idx - j; if (k >= 0) before.push(ks[k]); }
    for (var k2 = 1; k2 <= a; k2++) { var k3 = idx + 1 + (k2 - 1); if (k3 < ks.length && ks[k3].time > t + 1e-9) after.push(ks[k3]); else if (idx === -1 && k3 < ks.length) after.push(ks[k3]); }
    if (idx === -1 && !after.length && ks.length) after.push(ks[0]);
    return { before: before, after: after };
  }
  function drawOnion(ctx) {
    if (!state.onion || state.playing) return;
    var nb = onionNeighbors();
    if (!nb.before.length && !nb.after.length) return;
    var op = state.onionCfg ? state.onionCfg.opacity : 0.28;
    var tint = state.onionCfg && state.onionCfg.tint;
    var tintColor = state.onionCfg && state.onionCfg.tintColor;
    var tintOp = state.onionCfg ? state.onionCfg.tintOpacity : 0.35;
    function drawGhost(img, alpha) {
      if (!img) return;
      if (!tint || !tintColor) {
        ctx.globalAlpha = alpha;
        drawContain(ctx, img, workW, workH);
        return;
      }
      var c = document.createElement('canvas'); c.width = workW; c.height = workH;
      var g = c.getContext('2d');
      g.globalAlpha = alpha;
      drawContain(g, img, workW, workH);
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
      drawGhost(imgCache.get(nb.before[i].img), op * fade);
    }
    for (var j = 0; j < nb.after.length; j++) {
      var fade2 = 1 - j * 0.22; if (fade2 < 0.22) fade2 = 0.22;
      drawGhost(imgCache.get(nb.after[j].img), op * 0.8 * fade2);
    }
    ctx.restore();
  }
  function syncOnionUI() {
    var c = state.onionCfg || {};
    if (el.onionBefore) { el.onionBefore.value = String(c.before | 0); syncSlider(el.onionBefore); if (el.onionBeforeVal) el.onionBeforeVal.textContent = String(c.before | 0); }
    if (el.onionAfter) { el.onionAfter.value = String(c.after | 0); syncSlider(el.onionAfter); if (el.onionAfterVal) el.onionAfterVal.textContent = String(c.after | 0); }
    if (el.onionOpacity) { el.onionOpacity.value = String(c.opacity); syncSlider(el.onionOpacity); if (el.onionOpacityVal) el.onionOpacityVal.textContent = Math.round(c.opacity * 100) + '%'; }
    if (el.onionTint) el.onionTint.checked = !!c.tint;
    if (el.onionTintGroup) el.onionTintGroup.classList.toggle('hidden', !c.tint);
    if (el.onionTintColor) el.onionTintColor.value = c.tintColor || '#ff3b30';
    if (el.onionTintOpacity) { el.onionTintOpacity.value = String(c.tintOpacity); syncSlider(el.onionTintOpacity); if (el.onionTintOpacityVal) el.onionTintOpacityVal.textContent = Math.round(c.tintOpacity * 100) + '%'; }
  }
