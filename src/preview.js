'use strict';

  function renderPreview() {
    var token = ++state.previewToken;
    applyViewportSize();
    var ctx = el.previewCanvas.getContext('2d');
    // Markers live on the overlay; wipe it first so stale markers never
    // linger over the composite (the composite canvas itself stays pristine).
    var octx = el.previewOverlay.getContext('2d');
    octx.clearRect(0, 0, workW, workH);
    if (!state.keyframes.length && !hasFillLayers()) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, workW, workH);
      lastPreview = null;
      el.previewEmpty.classList.toggle('hidden', false);
      return;
    }
    el.previewEmpty.classList.add('hidden');
    // Playing always redraws: editor-only overlays (onion ghosts, dot markers)
    // must never linger on the canvas during playback, even when the composite
    // is unchanged (held keyframes reuse the same image).
    var key = compositeKey(state.playhead, state.keysOnly);
    if (!state.playing && lastPreview && lastPreview.key === key) {
      drawDotMarkers(octx);
      return; // already showing this exact composite
    }
    var frames = framesAt(state.playhead, state.keysOnly);
    var missing = frames.some(function (f) { return !imgCache.get(f.img); });
    if (missing) {
      // Keep the previous composite on screen while the new images decode.
      if (lastPreview && lastPreview.bits.length) drawComposite(ctx, lastPreview.bits, workW, workH);
      else {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, workW, workH);
      }
      drawDotMarkers(octx);
      var srcs = {};
      frames.forEach(function (f) { if (!imgCache.get(f.img)) srcs[f.img] = true; });
      Promise.all(Object.keys(srcs).map(function (src) {
        return loadImage(src).catch(function () {});
      })).then(function () {
        if (token !== state.previewToken) return;
        if (compositeKey(state.playhead, state.keysOnly) !== key) return; // moved on while loading
        var ctx2 = el.previewCanvas.getContext('2d');
        var octx2 = el.previewOverlay.getContext('2d');
        octx2.clearRect(0, 0, workW, workH);
        var bits = layerBitmaps(state.playhead, state.keysOnly, workW, workH);
        drawComposite(ctx2, bits, workW, workH);
        if (state.onion) drawOnion(ctx2);
        drawDotMarkers(octx2);
        lastPreview = { key: key, bits: bits };
      });
      return;
    }
    var bits2 = layerBitmaps(state.playhead, state.keysOnly, workW, workH);
    drawComposite(ctx, bits2, workW, workH);
    if (state.onion) drawOnion(ctx);
    drawDotMarkers(octx);
    lastPreview = { key: key, bits: bits2 };
  }

  // Dot markers on the overlay: the fill layer being edited shows the dots
  // that are ACTIVE at the current playhead as small colored rings, so the
  // user sees where each seed sits (dots for other times stay hidden until
  // the playhead reaches them). Only drawn when a fill layer is active or a
  // dot is selected.
  function drawDotMarkers(ctx) {
    if (state.playing) return; // editor markers never show during playback
    var L = null;
    if (layerById(state.activeLayerId).type === 'fill') L = layerById(state.activeLayerId);
    else if (state.selectedDotId) L = layerOfDot(state.selectedDotId);
    if (!L || !L.dots || !L.dots.length) return;
    var W = workW, H = workH;
    var t = state.playhead;
    L.dots.forEach(function (d) {
      if (d.start > t + 1e-9 || t > d.end + 1e-9) return; // not active at this time
      var px = d.x * W, py = d.y * H;
      var sel = d.id === state.selectedDotId;
      // Dark outline ring so the marker reads on any background, then the dot
      // color; the selected dot gets a bright ring instead.
      ctx.beginPath();
      ctx.arc(px, py, sel ? 8 : 6, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(px, py, sel ? 5 : 4, 0, Math.PI * 2);
      ctx.fillStyle = d.color;
      ctx.fill();
      if (sel) {
        ctx.beginPath();
        ctx.arc(px, py, 10, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    });
  }
