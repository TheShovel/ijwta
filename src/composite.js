'use strict';


  // Snap a dimension onto the 8px grid RIFE's 8x downsampling needs, so any
  // custom size keeps working through the model instead of throwing shape errors.
  function gridSnap(v) {
    return Math.max(8, Math.round(v / 8) * 8);
  }

  // The project's aspect ratio (w/h). 'auto' follows the first keyframe, as
  // before; presets give fixed ratios; 'custom' uses the manual dimensions.
  // Parse a user-typed ratio: "2.35", "2,35", "16:9", "21/9" → number > 0.
  function parseRatio(s) {
    if (s == null) return null;
    s = String(s).trim().replace(',', '.');
    if (!s) return null;
    var m = /^(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)$/.exec(s);
    if (m) {
      var r = parseFloat(m[1]) / parseFloat(m[2]);
      return isFinite(r) && r > 0 ? r : null;
    }
    var f = parseFloat(s);
    return isFinite(f) && f > 0 ? f : null;
  }

  function projectAspect() {
    if (state.aspect === 'custom') return gridSnap(state.customW) / gridSnap(state.customH);
    if (state.aspect === 'manual') return state.aspectRatio || 1;
    if (state.aspect === '16:9') return 16 / 9;
    if (state.aspect === '9:16') return 9 / 16;
    if (state.aspect === '4:3') return 4 / 3;
    if (state.aspect === '3:4') return 3 / 4;
    if (state.aspect === '1:1') return 1;
    var first = sortedKeyframes()[0];
    return first && first.h ? first.w / first.h : 1;
  }

  function workingSize() {
    if (state.aspect === 'custom') {
      var cw = clamp(gridSnap(state.customW), 8, 4096);
      var ch = clamp(gridSnap(state.customH), 8, 4096);
      // Memory guard: keep the total under ~8M px (about 4K) by shrinking the
      // long edge, so any video size stays usable in a browser tab.
      while (cw * ch > 8 * 1024 * 1024 && cw > 8 && ch > 8) {
        if (cw >= ch) cw -= 8; else ch -= 8;
      }
      return { w: cw, h: ch };
    }
    var target = state.res;
    var aspect = projectAspect();
    var w, h;
    // 64px grid keeps dims even for RIFE's 8x downsampling; the aspect is letterboxed.
    if (aspect >= 1) {
      w = target;
      h = Math.max(64, Math.round(target / aspect / 64) * 64);
    } else {
      h = target;
      w = Math.max(64, Math.round(target * aspect / 64) * 64);
    }
    while ((w / 8) * (h / 8) > 4096 && w > 64 && h > 64) {
      if (w >= h) w -= 64; else h -= 64;
    }
    return { w: w, h: h };
  }

  // Applies the current working size to the canvas. Returns the applied size
  // so callers can react (e.g. warn about very large custom resolutions).
  // While a project is being restored the canvas is sized to match, but the
  // freshly-loaded frames are NOT invalidated, since they were generated at exactly
  // this size, and refreshDirty() re-checks their stamps afterwards.
  function applyWorkSize() {
    var s = workingSize();
    if (s.w === workW && s.h === workH) return s;
    workW = s.w;
    workH = s.h;
    el.previewCanvas.width = workW;
    el.previewCanvas.height = workH;
    el.previewOverlay.width = workW;
    el.previewOverlay.height = workH;
    resetViewport(); // also refreshes the res/view label
    if (!restoringProject) {
      // Frames generated at the previous size no longer match the canvas.
      invalidateAll();
    }
    return s;
  }

  // Playback frames: the sorted union of every layer's keyframe and generated
  // frame times. Each entry is a time the composite image changes; the actual
  // composite is rendered on demand (see framesAt / drawFrames).
  function buildPlaybackFrames() {
    var times = {};
    state.layers.forEach(function (L) {
      sortedKeyframes(L.id).forEach(function (k) {
        var e = times[k.time] || (times[k.time] = { key: false });
        e.key = true;
      });
      computeGaps(L.id).forEach(function (g) {
        (state.generated[g.id] || []).forEach(function (f) {
          times[f.time] = times[f.time] || { key: false };
        });
      });
    });
    return Object.keys(times).map(function (t) {
      return { time: parseFloat(t), key: times[t].key };
    }).sort(function (a, b) { return a.time - b.time; });
  }

  function currentFrame() {
    var frames = buildPlaybackFrames();
    return frames[state.curIndex] || null;
  }

  // The frame (keyframe or generated inbetween) of one layer that is active at
  // time t: the last of that layer's frames at or before t. With keysOnly, only
  // keyframes count (no interpolated frames), matching the preview toggle.
  function layerFrameAt(layerId, t, keysOnly) {
    var frames = [];
    sortedKeyframes(layerId).forEach(function (k) {
      frames.push({ time: k.time, img: k.img, gen: false, mix: k.mix || 'source-over' });
    });
    if (!keysOnly) {
      computeGaps(layerId).forEach(function (g) {
        (state.generated[g.id] || []).forEach(function (f) {
          frames.push({ time: f.time, img: f.img, gen: true });
        });
      });
    }
    if (!frames.length) return null;
    frames.sort(function (a, b) { return a.time - b.time; });
    var active = null;
    for (var i = 0; i < frames.length; i++) {
      if (frames[i].time <= t + 1e-9) active = frames[i];
      else break;
    }
    return active;
  }

  // The image each visible layer contributes to the composite at time t, in
  // bottom-to-top draw order (the last layer is drawn first; the first layer
  // (the topmost) is drawn last). Each image keeps its own alpha channel, so
  // transparent keyframes (e.g. a character cut out on clear) composite over
  // the layers below it. Undecoded images are skipped by the drawing functions
  // (callers wait for them when needed).
  function framesAt(t, keysOnly) {
    var list = [];
    for (var i = state.layers.length - 1; i >= 0; i--) {
      var L = state.layers[i];
      if (L.visible === false) continue;
      var f = layerFrameAt(L.id, t, keysOnly);
      if (f) list.push({ img: f.img, mix: f.mix || 'source-over' });
    }
    return list;
  }

  function compositeKey(t, keysOnly) {
    var key = framesAt(t, keysOnly).map(function (f) {
      return f.img + ':' + (f.mix || 'source-over');
    }).join('|');
    // Fill layers are user content, not interpolated frames: include the
    // active dots' signature so the cache distinguishes filled composites.
    var fs = fillSig(t);
    return fs ? key + '|#fill#' + fs : key;
  }

  // Render the composite at t into a fresh canvas (filmstrip thumbs, exports).
  // When `transparent` is set, the backdrop is left clear (no white fill) so
  // PNG exports keep their alpha; on-screen previews pass nothing and keep the
  // white backdrop.
  function compositeCanvas(t, transparent) {
    var frames = framesAt(t, false);
    var canvas = document.createElement('canvas');
    canvas.width = workW;
    canvas.height = workH;
    var ctx = canvas.getContext('2d');
    return Promise.all(frames.map(function (f) {
      return loadImage(f.img).catch(function () { return null; });
    })).then(function () {
      drawComposite(ctx, layerBitmaps(t, false, workW, workH), workW, workH, transparent,
        state.camera.enabled ? cameraAt(t) : null);
      return canvas;
    });
  }
