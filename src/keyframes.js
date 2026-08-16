'use strict';


  // Insert time for new keyframes: the playhead (button/paste) or the exact
  // drop position. Snap rounds it to a frame boundary. Falls back to the
  // playhead when no time is given, so frames never silently land at the end
  // of the timeline.
  function insertTime(t) {
    if (t === undefined) t = state.playhead;
    t = Math.max(0, t);
    if (state.snap) t = Math.round(t * state.fps) / state.fps;
    return t;
  }

  // Add files to the image library only; nothing is placed on the timeline.
  // Keyframes are created by dragging an asset from the panel onto the
  // timeline (see addAssetKeyframe).
  function addImageFiles(files) {
    if (!files || !files.length) return Promise.resolve({ added: 0, failed: 0 });
    var list = Array.prototype.slice.call(files);
    var added = 0;
    var failed = 0;
    var idx = 0;
    function next() {
      if (idx >= list.length) return;
      var file = list[idx++];
      return readImageFile(file).then(function (data) {
        if (state.assets.some(function (a) { return a.img === data.img; })) return;
        state.assets.push({ img: data.img, name: data.name, w: data.w, h: data.h });
        added++;
      }).catch(function () {
        // One bad file must not drop the rest of the batch.
        failed++;
      }).then(next);
    }
    var workers = [];
    var concurrency = Math.min(3, list.length);
    for (var i = 0; i < concurrency; i++) workers.push(next());
    return Promise.all(workers).then(function () {
      renderAssets();
      return { added: added, failed: failed };
    });
  }
  // Place a keyframe reusing an image already in the library (asset drag & drop).
  // The image is already decoded, so unlike addImageFiles there is no file read.
  // The layer new keyframes land on: the active layer when it's a normal
  // layer, otherwise the topmost normal layer (fill layers hold dots, not
  // keyframes).
  function keyframeLayerId() {
    var L = layerById(state.activeLayerId);
    if (L && L.type !== 'fill') return L.id;
    for (var i = 0; i < state.layers.length; i++) {
      if (state.layers[i].type !== 'fill') return state.layers[i].id;
    }
    return state.layers[0].id;
  }

  function addAssetKeyframe(imgSrc, atTime) {
    var meta = null;
    for (var i = 0; i < assetCache.length; i++) {
      if (assetCache[i].img === imgSrc) { meta = assetCache[i]; break; }
    }
    state.keyframes.push({
      id: 'k' + (idSeq++),
      layer: keyframeLayerId(),
      time: insertTime(atTime),
      img: imgSrc,
      name: meta ? meta.name : 'asset',
      w: meta ? meta.w : workW,
      h: meta ? meta.h : workH
    });
    applyWorkSize();
    invalidateAll();
    renderAll();
    scheduleGenerate();
  }

  function selectKeyframe(id) {
    state.selectedId = id;
    state.selectedGapId = null;
    state.selectedDotId = null;
    var kf = state.keyframes.find(function (k) { return k.id === id; });
    if (kf && kf.layer) state.activeLayerId = kf.layer;
    renderSelectedPanel();
    renderLayerPanel();
    renderLane();
  }

  function replaceKeyframeImage(id) {
    var kf = state.keyframes.find(function (k) { return k.id === id; });
    if (!kf) return;
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = function () {
      var file = input.files && input.files[0];
      if (!file) return;
      readImageFile(file).then(function (data) {
        kf.img = data.img;
        kf.name = data.name;
        kf.w = data.w;
        kf.h = data.h;
        // The replacement image is a newly loaded image: add it to the library.
        if (!state.assets.some(function (a) { return a.img === data.img; })) {
          state.assets.push({ img: data.img, name: data.name, w: data.w, h: data.h });
        }
        invalidateAround(id);
        applyWorkSize();
        renderAll();
        scheduleGenerate();
      }).catch(function (e) { toast(e.message); });
    };
    input.click();
  }

  function deleteKeyframe(id) {
    var idx = state.keyframes.findIndex(function (k) { return k.id === id; });
    if (idx === -1) return;
    invalidateAround(id);
    state.keyframes.splice(idx, 1);
    if (state.selectedId === id) state.selectedId = null;
    applyWorkSize();
    refreshDirty();
    renderAll();
    scheduleGenerate();
  }

  // Turn a composite playback frame into a keyframe on the active layer. The
  // composite image becomes a new keyframe; the layer's gaps split there and
  // regenerate.
  function promoteToKeyframe(f) {
    var layerId = keyframeLayerId();
    return compositeDataURL(f.time).then(function (url) {
      state.keyframes.push({
        id: 'k' + (idSeq++),
        layer: layerId,
        time: f.time,
        img: url,
        name: 'promoted',
        w: workW,
        h: workH
      });
      state.selectedId = state.keyframes[state.keyframes.length - 1].id;
      applyWorkSize();
      refreshDirty();
      renderAll();
      scheduleGenerate();
      toast('Promoted to keyframe at ' + fmtTime(f.time));
    });
  }
