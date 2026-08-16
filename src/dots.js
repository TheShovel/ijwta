'use strict';


  function layerById(id) {
    return state.layers.find(function (l) { return l.id === id; }) || state.layers[0];
  }

  // Keyframes of one layer (or all layers when layerId is omitted), time-sorted.
  function sortedKeyframes(layerId) {
    return state.keyframes.filter(function (k) { return !layerId || k.layer === layerId; })
      .sort(function (a, b) { return a.time - b.time; });
  }

  function gapId(fromId, toId) { return fromId + '->' + toId; }

  // ---- generative color fill (color-dot layers) ----
  // A "fill" layer holds user-placed dots instead of keyframes. Each dot
  // carries a color, a threshold (how opaque a pixel must be to act as a line
  // barrier), a grow radius (px, tucks the color under anti-aliased edges) and
  // an active window [start, end] on the timeline. Dots do NOT interpolate;
  // they simply stop affecting the frame outside their window. The dot fills
  // the connected transparent region of the layer ABOVE the fill layer.

  function dotById(id) {
    if (!id) return null;
    for (var i = 0; i < state.layers.length; i++) {
      var L = state.layers[i];
      if (L.type !== 'fill' || !L.dots) continue;
      var d = L.dots.find(function (x) { return x.id === id; });
      if (d) return d;
    }
    return null;
  }

  // The layer a dot belongs to (find again; dotById returns the dot only).
  function layerOfDot(id) {
    if (!id) return null;
    for (var i = 0; i < state.layers.length; i++) {
      var L = state.layers[i];
      if (L.type !== 'fill' || !L.dots) continue;
      if (L.dots.some(function (x) { return x.id === id; })) return L;
    }
    return null;
  }

  function dotDefaults() {
    return { color: '#4f8fff', threshold: 0.5, grow: 1, dur: 1, gradOn: false, gradColor: '#ffffff', gradHeight: 24, gradDir: 'bottom' };
  }

  // Add a dot at normalized canvas coords (0..1) to a fill layer, active from
  // the current playhead for `dur` seconds. Returns the new dot.
  function addDot(layerId, nx, ny) {
    var L = layerById(layerId);
    if (!L || L.type !== 'fill') return null;
    if (!L.dots) L.dots = [];
    var def = dotDefaults();
    var start = Math.max(0, state.playhead);
    var end = start + def.dur;
    // Clamp to at least the playhead; keep a sensible minimum window.
    var d = {
      id: 'D' + (++idSeq),
      x: clamp(nx, 0, 1),
      y: clamp(ny, 0, 1),
      color: lastDotColor || def.color,
      threshold: def.threshold,
      grow: def.grow,
      gradOn: false,
      gradColor: def.gradColor,
      gradHeight: def.gradHeight,
      gradDir: def.gradDir,
      start: start,
      end: Math.max(end, start + 0.05)
    };
    L.dots.push(d);
    return d;
  }

  function deleteDot(id) {
    var L = layerOfDot(id);
    if (!L || !L.dots) return;
    L.dots = L.dots.filter(function (d) { return d.id !== id; });
    if (state.selectedDotId === id) state.selectedDotId = null;
  }

  // Dots of a fill layer that are active at time t (inclusive window).
  function activeDots(L, t) {
    if (L.type !== 'fill' || !L.dots) return [];
    return L.dots.filter(function (d) {
      return d.start <= t + 1e-9 && t <= d.end + 1e-9;
    });
  }

  function hasFillLayers() {
    return state.layers.some(function (L) { return L.type === 'fill' && L.visible !== false; });
  }

  // A signature of a fill layer's dots active at t, for the composite cache
  // key (dots are user content, not interpolated frames).
  function fillSig(t) {
    var parts = [];
    state.layers.forEach(function (L) {
      if (L.type !== 'fill' || L.visible === false) return;
      activeDots(L, t).forEach(function (d) {
        parts.push(d.id + ':' + d.x.toFixed(4) + ':' + d.y.toFixed(4) + ':' + d.color + ':' +
          (Math.round(d.threshold * 100) / 100) + ':' + d.grow + ':' +
          (d.gradOn ? '1:' + (d.gradColor || '') + ':' + d.gradHeight + ':' + d.gradDir : '0'));
      });
    });
    return parts.join('|');
  }

  // The fill layers that color a given layer: the run of fill layers directly
  // below it (each colors the nearest visible layer above, which for this run
  // is the layer itself). Stops at the first visible normal layer below.
  function fillsForLayer(layerId) {
    var idx = state.layers.findIndex(function (l) { return l.id === layerId; });
    if (idx === -1) return [];
    var out = [];
    for (var i = idx + 1; i < state.layers.length; i++) {
      var L = state.layers[i];
      if (L.visible === false) continue;
      if (L.type === 'fill') out.push(L);
      else break; // first visible normal layer below ends the run
    }
    return out;
  }

  // Signature of the fills coloring `layerId` at time t (for gap stamps and
  // the matte memo, so editing a dot invalidates the generated frames).
  function layerFillSig(layerId, t) {
    var parts = [];
    fillsForLayer(layerId).forEach(function (F) {
      activeDots(F, t).forEach(function (d) {
        parts.push(F.id + ':' + d.id + ':' + d.x.toFixed(4) + ':' + d.y.toFixed(4) + ':' + d.color + ':' +
          (Math.round(d.threshold * 100) / 100) + ':' + d.grow + ':' +
          (d.gradOn ? '1:' + (d.gradColor || '') + ':' + d.gradHeight + ':' + d.gradDir : '0'));
      });
    });
    return parts.join('|');
  }
