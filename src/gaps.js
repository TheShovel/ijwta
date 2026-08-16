'use strict';


  // Interpolation mode for one gap: 'ai' (neural), 'squash', or 'none'.
  function gapMode(g) {
    return state.gapType[g.id] || 'ai';
  }

  function gapSquashOpts(gapId) {
    var o = state.gapSquash[gapId];
    if (!o) return { amount: null, curve: 'peak', preserve: 'area' };
    return {
      amount: typeof o.amount === 'number' && isFinite(o.amount) ? o.amount : null,
      curve: o.curve === 'impact' || o.curve === 'ease' || o.curve === 'linear' ? o.curve : 'peak',
      preserve: o.preserve === 'volume' ? 'volume' : 'area'
    };
  }

  function setGapSquash(gapId, patch) {
    var cur = gapSquashOpts(gapId);
    var next = {
      amount: patch.hasOwnProperty('amount') ? patch.amount : cur.amount,
      curve: patch.hasOwnProperty('curve') ? patch.curve : cur.curve,
      preserve: patch.hasOwnProperty('preserve') ? patch.preserve : cur.preserve
    };
    if (next.amount != null) next.amount = Math.max(-0.8, Math.min(0.8, next.amount));
    // Drop defaults so saved projects stay small; null amount means auto.
    if (next.amount == null && next.curve === 'peak' && next.preserve === 'area') {
      delete state.gapSquash[gapId];
    } else {
      state.gapSquash[gapId] = next;
    }
  }

  // Per-gap motion blur: { on, intensity }. Intensity 0..1 scales the streak
  // length relative to the pixel's motion (see morph.motionBlurFrame).
  function gapBlurOpts(gapId) {
    var o = state.gapBlur[gapId];
    if (!o) return { on: false, intensity: 0.5 };
    return {
      on: !!o.on,
      intensity: typeof o.intensity === 'number' && isFinite(o.intensity)
        ? Math.max(0, Math.min(1, o.intensity)) : 0.5
    };
  }

  function setGapBlur(gapId, patch) {
    var cur = gapBlurOpts(gapId);
    var next = {
      on: patch.hasOwnProperty('on') ? !!patch.on : cur.on,
      intensity: patch.hasOwnProperty('intensity') ? patch.intensity : cur.intensity
    };
    if (!isFinite(next.intensity)) next.intensity = cur.intensity;
    next.intensity = Math.max(0, Math.min(1, next.intensity));
    if (!next.on) {
      delete state.gapBlur[gapId];
    } else {
      state.gapBlur[gapId] = next;
    }
  }

  function keyframeHold(k) {
    // Hold duration in seconds: how long the keyframe displays before the next
    // gap starts interpolating. Defaults to one frame at the current FPS.
    if (typeof k.hold === 'number' && isFinite(k.hold) && k.hold >= 0) return k.hold;
    return 1 / state.fps;
  }

  // Gaps of one layer (or all layers when layerId is omitted). Each layer
  // interpolates its own timeline; keyframes never mix between layers. gapId is
  // unique across layers because keyframe ids are globally unique.
  function computeGaps(layerId) {
    var keys = sortedKeyframes(layerId);
    var gaps = [];
    for (var i = 0; i < keys.length - 1; i++) {
      var from = keys[i], to = keys[i + 1];
      var id = gapId(from.id, to.id);
      var fromEnd = from.time + keyframeHold(from);
      var sec = Math.max(0, to.time - fromEnd);
      var mode = state.gapType[id] || 'ai';
      // 'none' gaps hold the from-frame until the next keyframe: no inbetweens.
      var genCount = (mode === 'none') ? 0 : Math.max(0, Math.round(sec * state.fps) - 1);
      gaps.push({
        id: id,
        layer: layerId || null,
        from: from, to: to,
        fromTime: fromEnd, toTime: to.time,
        sec: sec,
        genCount: genCount,
        mode: mode
      });
    }
    return gaps;
  }

  function allGaps() {
    var gaps = [];
    state.layers.forEach(function (L) {
      computeGaps(L.id).forEach(function (g) { gaps.push(g); });
    });
    return gaps;
  }

  // Hash of what a gap's frames were generated from: the two endpoint images
  // plus the frame count. If these are unchanged, existing frames stay valid
  // (only their timestamps may need re-deriving).
  function gapStamp(g) {
    var squash = gapSquashOpts(g.id);
    var squashKey = squash.amount == null ? 'auto' : String(Math.round(squash.amount * 1000) / 1000);
    var blur = gapBlurOpts(g.id);
    var blurKey = blur.on ? 'mb' + Math.round(blur.intensity * 1000) : 'none';
    var h = hashStr(g.from.img + '|' + g.to.img);
    return {
      h: h,
      count: g.genCount,
      mode: g.mode || gapMode(g),
      squash: squashKey + '|' + squash.curve + '|' + squash.preserve,
      blur: blurKey,
      // The color fills baked into the endpoints: editing a dot (color,
      // threshold, grow, window) changes the composite the gap interpolates,
      // so the generated frames must regenerate.
      fill: layerFillSig(g.layer, g.from.time) + '|' + layerFillSig(g.layer, g.to.time)
    };
  }

  function stampMatches(g, stamp) {
    if (!stamp) return false;
    var cur = gapStamp(g);
    // Older projects saved stamps without the blur/fill keys; treat those as
    // the defaults (blur off, no fills) so existing frames stay valid.
    var stampBlur = stamp.blur === undefined ? 'none' : stamp.blur;
    var stampFill = stamp.fill === undefined ? '|' : stamp.fill;
    return stamp.h === cur.h && stamp.count === cur.count && stamp.mode === cur.mode &&
      stamp.squash === cur.squash && stampBlur === cur.blur && stampFill === cur.fill;
  }

  // Which frame indices (1..genCount) are still missing for this gap. When the
  // stamp matches (same endpoint images + count), existing frames are valid
  // and only absent indices are returned, so a cancelled gap resumes from its
  // tail instead of redoing finished frames. On a stamp mismatch every frame
  // is stale, so all indices come back missing.
  function computeMissing(g) {
    var gen = state.generated[g.id] || [];
    var valid = stampMatches(g, state.gapMeta[g.id]);
    var have = {};
    if (valid) gen.forEach(function (f) { if (f.idx) have[f.idx] = true; });
    var missing = [];
    for (var i = 1; i <= g.genCount; i++) {
      if (!have[i]) missing.push(i);
    }
    return missing;
  }

  function gapComplete(g) {
    var gen = state.generated[g.id];
    if (g.genCount <= 0) return true;
    if (!gen || gen.length < g.genCount) return false;
    return stampMatches(g, state.gapMeta[g.id]) && computeMissing(g).length === 0;
  }

  // Re-derive one generated frame's timestamp for its current gap. Frames
  // space evenly by index between the hold end and the next keyframe.
  function retimeGapFrame(g, f) {
    if (!f.idx) return;
    f.time = g.fromTime + (g.toTime - g.fromTime) * (f.idx / (g.genCount + 1));
  }

  function refreshDirty() {
    // Every layer has its own gaps; collect them all (order irrelevant now
    // that color layers are gone).
    var gaps = [];
    state.layers.forEach(function (L) {
      computeGaps(L.id).forEach(function (g) { gaps.push(g); });
    });
    var ids = {};
    gaps.forEach(function (g) { ids[g.id] = true; });
    // Drop records for gaps that no longer exist (keyframes deleted/merged).
    Object.keys(state.generated).forEach(function (id) { if (!ids[id]) delete state.generated[id]; });
    Object.keys(state.gapMeta).forEach(function (id) { if (!ids[id]) delete state.gapMeta[id]; });
    var dirty = new Set();
    gaps.forEach(function (g) {
      if (stampMatches(g, state.gapMeta[g.id])) {
        // Same endpoint images + count: frames stay valid; only their
        // timestamps change when gap boundaries move.
        (state.generated[g.id] || []).forEach(function (f) {
          retimeGapFrame(g, f);
        });
      } else if (g.genCount > 0) {
        // Content or count changed: drop stale frames so they don't linger.
        if (state.generated[g.id] && state.generated[g.id].length) state.generated[g.id] = [];
      }
      if (g.genCount <= 0 && state.generated[g.id] && state.generated[g.id].length) {
        // The gap shrank to zero frames (a keyframe was moved onto/next to
        // another): drop leftover generated frames so they don't linger in
        // playback. If the gap grows again later they simply regenerate.
        delete state.generated[g.id];
        delete state.gapMeta[g.id];
      }
      if (g.genCount > 0 && !gapComplete(g)) dirty.add(g.id);
    });
    state.dirty = dirty;
  }

  function invalidateAll() {
    // Working size / FPS / method changed: every frame is now invalid.
    state.gapMeta = {};
    state.generated = {};
    refreshDirty();
  }

  function invalidateAround(kfId) {
    // A keyframe changed: re-evaluate adjacent gaps. Frames already generated
    // are kept; the stamp check decides whether they're still valid, so a pure
    // move only re-times frames while an image replace regenerates the gap.
    refreshDirty();
  }

  // A color-dot edit changed the baked composite the gaps interpolate: mark
  // the affected gaps dirty and regenerate them (the stamp's fill signature
  // is what makes refreshDirty see the change).
  function invalidateDots() {
    refreshDirty();
    scheduleGenerate(60);
  }

  // Live-only re-timing used while dragging/resizing: moves every generated
  // frame's timestamp to its current gap position so the lane dots and gap
  // overlays follow the mouse. No dirty-set or stamp side effects; the real
  // validation happens on drop via refreshDirty().
  function retimeAllFrames() {
    allGaps().forEach(function (g) {
      (state.generated[g.id] || []).forEach(function (f) {
        retimeGapFrame(g, f);
      });
    });
  }
