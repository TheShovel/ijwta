/* app.js — Keyframe Studio timeline app
 *
 * Places keyframe images on a timeline at arbitrary times; a pure-JS morph engine
 * (see morph.js) fills each gap with interpolated frames: one per tick of the gap,
 * i.e. gapSeconds * FPS - 1 frames. Most frames are optical-flow mesh warps; every
 * fourth generated slot is locally synthesized from recognized/cleaned warped
 * regions. Static site, no server, no GPU, no model downloads.
 */
(function () {
  'use strict';

  var morph = window.IJWTA_MORPH;
  var gifenc = window.gifenc;
  var model = window.IJWTA_MODEL;

  // ------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------
  var state = {
    keyframes: [],        // { id, time, img, name, w, h }
    generated: {},        // gapId -> [{ idx, t, time, img, ai }]
    gapMeta: {},          // gapId -> { h, count } — what the frames were made from
    dirty: new Set(),     // gapIds that need (re)generation
    fps: 12,
    zoom: 90,             // px per second
    snap: true,
    res: 512,
    modelReady: false,
    playhead: 0,
    curIndex: 0,
    playing: false,
    loop: true,
    keysOnly: false,   // viewport shows keyframes only (no interpolated frames)
    selectedId: null,
    genRun: null,
    pendingRegen: false,
    previewToken: 0,
    viewZoom: 1         // preview viewport zoom (1 = fit the panel; pan lives in the scroll position)
  };

  var workW = 512, workH = 512;
  var imgCache = new Map();
  var idSeq = 1;
  var toastTimer = null;
  var saveTimer = null;
  var STORE_KEY = 'ijwta-project-v1';
  var WARN_GEN_COUNT = 5; // gaps needing more inbetweens than this get a red warning

  // Inline SVG icons for the buttons that are (re)built at runtime. Stroke-based
  // 24×24 paths, currentColor, matching the static icons in index.html.
  var ICONS = {
    play: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
    arrowUp: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>',
    download: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>'
  };

  // ------------------------------------------------------------------
  // DOM refs
  // ------------------------------------------------------------------
  function byId(id) { return document.getElementById(id); }

  var el = {
    btnAddKeyframes: byId('btnAddKeyframes'),
    btnPlay: byId('btnPlay'),
    btnStepBack: byId('btnStepBack'),
    btnStepFwd: byId('btnStepFwd'),
    btnLoop: byId('btnLoop'),
    btnKeysOnly: byId('btnKeysOnly'),
    btnRegenerate: byId('btnRegenerate'),
    btnSettings: byId('btnSettings'),
    settingsMenu: byId('settingsMenu'),
    btnFile: byId('btnFile'),
    fileMenu: byId('fileMenu'),
    btnSaveProject: byId('btnSaveProject'),
    btnLoadProject: byId('btnLoadProject'),
    projectInput: byId('projectInput'),
    btnExport: byId('btnExport'),
    exportMenu: byId('exportMenu'),
    btnReplace: byId('btnReplace'),
    btnDelete: byId('btnDelete'),
    btnCancel: byId('btnCancel'),
    kfCard: byId('kfCard'),
    kfThumb: byId('kfThumb'),
    kfName: byId('kfName'),
    kfTime: byId('kfTime'),
    kfEmpty: byId('kfEmpty'),
    previewCanvas: byId('previewCanvas'),
    previewWrap: byId('previewWrap'),
    previewEmpty: byId('previewEmpty'),
    filmstrip: byId('filmstrip'),
    timeline: byId('timeline'),
    track: byId('track'),
    ruler: byId('ruler'),
    lane: byId('lane'),
    playhead: byId('playhead'),
    zoomLabel: byId('zoomLabel'),
    timeLabel: byId('timeLabel'),
    frameLabel: byId('frameLabel'),
    resLabel: byId('resLabel'),
    genStatus: byId('genStatus'),
    genProgress: byId('genProgress'),
    genFill: byId('genFill'),
    genLabel: byId('genLabel'),
    genMeta: byId('genMeta'),
    fpsInput: byId('fpsInput'),
    snapInput: byId('snapInput'),
    resInput: byId('resInput'),
    selTimeInput: byId('selTimeInput'),
    fileInput: byId('fileInput'),
    toast: byId('toast'),
    loadingOverlay: byId('loadingOverlay'),
    loadingSub: byId('loadingSub'),
    loadingFill: byId('loadingFill'),
    loadingLabel: byId('loadingLabel'),
    loadingMeta: byId('loadingMeta'),
    btnLoadingRetry: byId('btnLoadingRetry')
  };

  // ------------------------------------------------------------------
  // Background worker (frame interpolation off the main thread)
  // ------------------------------------------------------------------
  var worker = null;          // Worker instance or null (inline fallback)
  var workerJobs = {};        // jobId -> { resolve, reject, onFrame, onProgress }
  var jobSeq = 0;

  function initWorker() {
    if (worker !== null || typeof Worker === 'undefined') return;
    try {
      worker = new Worker('worker.js');
      worker.onmessage = onWorkerMessage;
      worker.onerror = function (e) {
        console.error('Worker error, falling back to inline generation:', e && e.message);
        try { worker.terminate(); } catch (err) {}
        worker = null;
        // Reject pending jobs so the generation chain falls back to inline.
        Object.keys(workerJobs).forEach(function (id) {
          var j = workerJobs[id];
          delete workerJobs[id];
          j.reject(new Error('Worker failed'));
        });
        // If the model was still loading in the worker, unblock the launch
        // overlay so the app proceeds with the mesh fallback.
        if (!el.loadingOverlay.classList.contains('hidden')) {
          onModelError(new Error('Worker failed to load (check the model CDN is reachable)'));
        }
      };
    } catch (e) {
      console.error('Could not start worker, using inline generation:', e);
      worker = null;
    }
  }

  function onWorkerMessage(e) {
    var m = e.data;
    if (!m) return;
    if (m.type === 'model-progress') { onModelProgress(m); }
    else if (m.type === 'model-ready') { onModelReady(); }
    else if (m.type === 'model-error') { onModelError(new Error(m.message)); }
    else if (m.type === 'gap-progress') {
      var jp = workerJobs[m.jobId];
      if (jp && jp.onProgress) jp.onProgress(m.label, m.gapFrac);
    }
    else if (m.type === 'frame') {
      var jf = workerJobs[m.jobId];
      if (!jf) return;
      var rgba = new Uint8ClampedArray(m.rgba);
      jf.onFrame({
        idx: m.idx, t: m.t, time: m.time, ai: m.ai,
        img: dataToDataURL(rgba, m.width, m.height)
      });
    }
    else if (m.type === 'gap-done' || m.type === 'gap-cancelled') {
      var jd = workerJobs[m.jobId];
      if (jd) { delete workerJobs[m.jobId]; jd.resolve(); }
    }
    else if (m.type === 'gap-error') {
      var je = workerJobs[m.jobId];
      if (je) { delete workerJobs[m.jobId]; je.reject(new Error(m.message)); }
    }
  }

  // ------------------------------------------------------------------
  // Small helpers
  // ------------------------------------------------------------------
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function fmtTime(t) { return (Math.round(t * 100) / 100).toFixed(2) + 's'; }
  // Ruler/other labels: strip float noise like 0.35000000000000003.
  function fmtNum(n) {
    var r = Math.round(n * 100) / 100;
    return String(r);
  }

  function hashStr(s) {
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  function toast(msg, ms) {
    el.toast.textContent = msg;
    el.toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.classList.add('hidden'); }, ms || 3200);
  }

  function loadImage(src) {
    if (imgCache.has(src)) return Promise.resolve(imgCache.get(src));
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { imgCache.set(src, img); resolve(img); };
      img.onerror = function () { reject(new Error('Could not decode image')); };
      img.src = src;
    });
  }

  // Decode every playback frame's image into the cache ahead of the playhead,
  // so the first time a frame appears it's already in memory (no black flash).
  // Concurrency is capped so we don't hammer the decoder with one giant burst.
  var playbackPreload = null;
  function preloadPlaybackFrames() {
    var frames = buildPlaybackFrames();
    var srcs = [];
    var seen = {};
    frames.forEach(function (f) {
      if (f.img && !seen[f.img]) { seen[f.img] = true; srcs.push(f.img); }
    });
    var idx = 0;
    function worker() {
      if (idx >= srcs.length) return Promise.resolve();
      var src = srcs[idx++];
      return loadImage(src).catch(function () {}).then(worker);
    }
    var workers = [];
    var n = Math.min(8, srcs.length);
    for (var i = 0; i < n; i++) workers.push(worker());
    playbackPreload = Promise.all(workers);
    return playbackPreload;
  }

  function drawContain(ctx, img, w, h) {
    var scale = Math.min(w / img.width, h / img.height);
    var dw = img.width * scale, dh = img.height * scale;
    ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
  }

  function downloadBlob(data, filename, type) {
    var blob = data instanceof Blob ? data : new Blob([data], { type: type || 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function withTimeout(promise, ms, message) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(new Error(message)); }, ms);
      promise.then(function (v) { clearTimeout(timer); resolve(v); }, function (e) { clearTimeout(timer); reject(e); });
    });
  }

  // ------------------------------------------------------------------
  // Keyframes & gaps
  // ------------------------------------------------------------------
  function sortedKeyframes() {
    return state.keyframes.slice().sort(function (a, b) { return a.time - b.time; });
  }

  function gapId(fromId, toId) { return fromId + '->' + toId; }

  function keyframeHold(k) {
    // Hold duration in seconds: how long the keyframe displays before the next
    // gap starts interpolating. Defaults to one frame at the current FPS.
    if (typeof k.hold === 'number' && isFinite(k.hold) && k.hold >= 0) return k.hold;
    return 1 / state.fps;
  }

  function computeGaps() {
    var keys = sortedKeyframes();
    var gaps = [];
    for (var i = 0; i < keys.length - 1; i++) {
      var from = keys[i], to = keys[i + 1];
      var fromEnd = from.time + keyframeHold(from);
      var sec = Math.max(0, to.time - fromEnd);
      var genCount = Math.max(0, Math.round(sec * state.fps) - 1);
      gaps.push({
        id: gapId(from.id, to.id),
        from: from, to: to,
        fromTime: fromEnd, toTime: to.time,
        sec: sec,
        genCount: genCount
      });
    }
    return gaps;
  }

  // Hash of what a gap's frames were generated from: the two endpoint images
  // plus the frame count. If these are unchanged, existing frames stay valid
  // (only their timestamps may need re-deriving).
  function gapStamp(g) {
    return { h: hashStr(g.from.img + '|' + g.to.img), count: g.genCount };
  }

  function stampMatches(g, stamp) {
    if (!stamp) return false;
    var cur = gapStamp(g);
    return stamp.h === cur.h && stamp.count === cur.count;
  }

  // Which frame indices (1..genCount) are still missing for this gap. When the
  // stamp matches (same endpoint images + count), existing frames are valid
  // and only absent indices are returned — so a cancelled gap resumes from its
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

  function refreshDirty() {
    var gaps = computeGaps();
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
          if (f.idx) f.time = g.fromTime + (g.toTime - g.fromTime) * (f.idx / (g.genCount + 1));
        });
      } else if (g.genCount > 0) {
        // Images or count changed: drop stale frames so they don't linger.
        if (state.generated[g.id] && state.generated[g.id].length) state.generated[g.id] = [];
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

  // Live-only re-timing used while dragging/resizing: moves every generated
  // frame's timestamp to its current gap position so the lane dots and gap
  // overlays follow the mouse. No dirty-set or stamp side effects — the real
  // validation happens on drop via refreshDirty().
  function retimeAllFrames() {
    computeGaps().forEach(function (g) {
      (state.generated[g.id] || []).forEach(function (f) {
        if (f.idx) f.time = g.fromTime + (g.toTime - g.fromTime) * (f.idx / (g.genCount + 1));
      });
    });
  }

  function workingSize() {
    var target = state.res;
    var first = sortedKeyframes()[0];
    var aspect = first && first.h ? first.w / first.h : 1;
    var w, h;
    // The raw SD1.5 UNet only runs correctly when the latent dims (w/8, h/8)
    // are divisible by 8 — so image dims go on a 64px grid (aspect is letterboxed).
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

  function applyWorkSize() {
    var s = workingSize();
    if (s.w === workW && s.h === workH) return;
    workW = s.w;
    workH = s.h;
    el.previewCanvas.width = workW;
    el.previewCanvas.height = workH;
    resetViewport(); // also refreshes the res/view label
    // Frames generated at the previous size no longer match the canvas.
    invalidateAll();
  }

  // ------------------------------------------------------------------
  // Playback frames
  // ------------------------------------------------------------------
  function buildPlaybackFrames() {
    var list = [];
    sortedKeyframes().forEach(function (k) {
      list.push({ time: k.time, img: k.img, key: true, id: k.id });
    });
    computeGaps().forEach(function (g) {
      var gen = state.generated[g.id];
      if (gen) gen.forEach(function (f) { list.push({ time: f.time, img: f.img, key: false }); });
    });
    list.sort(function (a, b) {
      if (a.time !== b.time) return a.time - b.time;
      return a.key === b.key ? 0 : (a.key ? -1 : 1);
    });
    return list;
  }

  function currentFrame() {
    var frames = buildPlaybackFrames();
    return frames[state.curIndex] || null;
  }

  // ------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------
  function renderTimeline() {
    var keys = sortedKeyframes();
    var maxTime = keys.length ? keys[keys.length - 1].time : 0;
    var contentW = Math.max(el.timeline.clientWidth, 40 + (maxTime + 2) * state.zoom);
    el.track.style.width = contentW + 'px';
    renderRuler(maxTime);
    renderLane();
    renderPlayhead();
    el.zoomLabel.textContent = Math.round(state.zoom) + ' px/s';
  }

  function renderRuler(maxTime) {
    el.ruler.innerHTML = '';
    var steps = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60];
    var step = steps[0];
    for (var i = 0; i < steps.length; i++) {
      if (steps[i] * state.zoom >= 34) { step = steps[i]; break; }
    }
    var end = maxTime + 2;
    // Never flood the DOM with ticks, no matter how long/zoomed the timeline is.
    while (end / step > 3000) step *= 5;
    var minor = step >= 1 ? step / 5 : 0;
    for (var t = 0; t <= end + 1e-9; t += minor || step) {
      var isMajor = minor === 0 || Math.abs((t / step) - Math.round(t / step)) < 1e-9;
      var tick = document.createElement('div');
      tick.className = 'tick ' + (isMajor ? 'major' : 'minor');
      tick.style.left = (t * state.zoom) + 'px';
      var line = document.createElement('div');
      line.className = 'line';
      tick.appendChild(line);
      if (isMajor) {
        var label = document.createElement('span');
        label.className = 'label';
        label.textContent = fmtNum(t) + 's';
        tick.appendChild(label);
      }
      el.ruler.appendChild(tick);
    }
  }

  function renderLane() {
    el.lane.innerHTML = '';
    var keys = sortedKeyframes();
    var gaps = computeGaps();
    var z = state.zoom;

    gaps.forEach(function (g) {
      var x1 = g.fromTime * z, x2 = g.toTime * z;
      var gen = state.generated[g.id] || [];
      var ok = gapComplete(g);
      var overlay = document.createElement('div');
      overlay.className = 'gap-overlay ' + (ok ? 'ok' : 'dirty') + (g.genCount > WARN_GEN_COUNT ? ' warn' : '');
      overlay.style.left = x1 + 'px';
      overlay.style.width = Math.max(2, x2 - x1) + 'px';
      if (g.genCount > 0) {
        var label = document.createElement('div');
        label.className = 'glabel';
        label.textContent = ok
          ? g.genCount + ' frames'
          : (gen.length > 0 ? gen.length + '/' + g.genCount + ' frames · regenerate' : g.genCount + ' frames needed');
        overlay.appendChild(label);
        if (g.genCount > WARN_GEN_COUNT) {
          var warn = document.createElement('div');
          warn.className = 'gap-warn';
          warn.textContent = '⚠ ' + g.genCount + ' inbetweens. Add a real frame here or the output will look bad.';
          overlay.dataset.count = String(g.genCount);
          overlay.appendChild(warn);
        }
      }
      el.lane.appendChild(overlay);

      gen.forEach(function (f) {
        var dot = document.createElement('div');
        dot.className = 'frame-dot';
        dot.style.left = (f.time * z) + 'px';
        el.lane.appendChild(dot);
      });
    });

    keys.forEach(function (k) {
      var chip = document.createElement('div');
      chip.className = 'kf' + (k.id === state.selectedId ? ' selected' : '');
      chip.dataset.id = k.id;
      chip.style.left = (k.time * z) + 'px';
      chip.style.width = Math.max(10, keyframeHold(k) * z) + 'px';
      chip.title = 'Frame at ' + fmtTime(k.time) + '. Drag to move, drag the right edge to resize its duration';
      var thumb = document.createElement('div');
      thumb.className = 'kf-thumb';
      var img = document.createElement('img');
      img.src = k.img;
      thumb.appendChild(img);
      var tlabel = document.createElement('div');
      tlabel.className = 'kf-time';
      tlabel.textContent = fmtTime(k.time);
      var resize = document.createElement('div');
      resize.className = 'kf-resize';
      resize.title = 'Drag to set how long this frame holds';
      chip.appendChild(thumb);
      chip.appendChild(tlabel);
      chip.appendChild(resize);
      chip.addEventListener('dblclick', function (e) {
        e.stopPropagation();
        replaceKeyframeImage(k.id);
      });
      el.lane.appendChild(chip);
    });
  }

  function renderPlayhead() {
    el.playhead.style.left = (state.playhead * state.zoom) + 'px';
    var scroll = el.timeline;
    var left = state.playhead * state.zoom;
    if (left > scroll.scrollLeft + scroll.clientWidth - 60) {
      scroll.scrollLeft = left - scroll.clientWidth + 60;
    } else if (left < scroll.scrollLeft + 10) {
      scroll.scrollLeft = Math.max(0, left - 10);
    }
  }

  function renderFilmstrip() {
    el.filmstrip.innerHTML = '';
    buildPlaybackFrames().forEach(function (f, i) {
      el.filmstrip.appendChild(makeThumb(f, i));
    });
  }

  function makeThumb(f, i) {
    var div = document.createElement('div');
    div.className = 'thumb' + (f.key ? ' key' : '') + (i === state.curIndex ? ' current' : '');
    var img = document.createElement('img');
    img.src = f.img;
    div.appendChild(img);
    if (f.key) {
      var badge = document.createElement('div');
      badge.className = 'badge';
      badge.textContent = '◆ key';
      div.appendChild(badge);
    }
    var tlabel = document.createElement('div');
    tlabel.className = 'tlabel';
    tlabel.textContent = fmtTime(f.time);
    div.appendChild(tlabel);
    var actions = document.createElement('div');
    actions.className = 'actions';
    if (!f.key) {
      var promote = document.createElement('button');
      promote.innerHTML = ICONS.arrowUp + '<span>use as keyframe</span>';
      promote.title = 'Turn this generated frame into a keyframe at this time';
      promote.addEventListener('click', function (e) {
        e.stopPropagation();
        promoteToKeyframe(f);
      });
      actions.appendChild(promote);
    }
    var dl = document.createElement('button');
    dl.innerHTML = ICONS.download + '<span>download</span>';
    dl.addEventListener('click', function (e) {
      e.stopPropagation();
      downloadFrame(f.img, 'frame_' + fmtTime(f.time).replace('.', '_').replace('s', '') + '.png');
    });
    actions.appendChild(dl);
    div.appendChild(actions);
    div.addEventListener('click', function () {
      setFrameByTime(f.time);
      if (!state.playing) renderFilmstrip();
    });
    return div;
  }

  // Draw the frame into the backing store at native resolution. The canvas
  // element itself is CSS-scaled to the viewport size (see applyViewportSize),
  // so no in-canvas zoom transform is needed — zooming never clips the image
  // to a fixed-size square, the wrap just scrolls to pan.
  function paintPreview(ctx, img) {
    drawContain(ctx, img, workW, workH);
  }

  // Scale that makes the work area fit the panel without upscaling (1 at
  // native-or-larger panels). viewZoom is relative to this fit.
  function viewportFitScale() {
    var w = el.previewWrap.clientWidth, h = el.previewWrap.clientHeight;
    if (!w || !h) return 1;
    return Math.min(1, w / workW, h / workH);
  }

  // Grow/shrink the canvas element so "viewZoom 1" fits the panel and higher
  // zooms make it overflow the wrap, which then scrolls instead of clipping.
  function applyViewportSize() {
    var s = viewportFitScale() * state.viewZoom;
    el.previewCanvas.style.width = Math.round(workW * s) + 'px';
    el.previewCanvas.style.height = Math.round(workH * s) + 'px';
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

  // Which frame the viewport shows. With keysOnly on, interpolated frames are
  // hidden and the active keyframe (the one at/before the playhead) is shown
  // instead — playback and scrubbing still track the playhead, so you can walk
  // through the animation as it looked without any inbetweens.
  function previewFrame() {
    if (!state.keysOnly) return currentFrame();
    var keys = sortedKeyframes();
    var kf = null;
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].time <= state.playhead + 1e-9) kf = keys[i];
      else break;
    }
    return kf;
  }

  var lastPreviewImg = null; // last successfully drawn image (avoid black flashes)
  function renderPreview() {
    var token = ++state.previewToken;
    applyViewportSize();
    var ctx = el.previewCanvas.getContext('2d');
    var f = previewFrame();
    if (!f) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, workW, workH);
      lastPreviewImg = null;
      el.previewEmpty.classList.toggle('hidden', state.keyframes.length > 0);
      return;
    }
    el.previewEmpty.classList.add('hidden');
    var cached = imgCache.get(f.img);
    if (cached) {
      // Already decoded: draw synchronously — no async gap, no black flash.
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, workW, workH);
      paintPreview(ctx, cached);
      lastPreviewImg = cached;
      return;
    }
    // Not in cache yet: keep the last frame on screen instead of flashing
    // black, then swap in the new frame the moment it decodes.
    if (lastPreviewImg) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, workW, workH);
      paintPreview(ctx, lastPreviewImg);
    } else {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, workW, workH);
    }
    loadImage(f.img).then(function (img) {
      if (token !== state.previewToken) return;
      var ctx2 = el.previewCanvas.getContext('2d');
      ctx2.fillStyle = '#000';
      ctx2.fillRect(0, 0, workW, workH);
      paintPreview(ctx2, img);
      lastPreviewImg = img;
    }).catch(function () {});
  }

  function renderSelectedPanel() {
    var kf = state.keyframes.find(function (k) { return k.id === state.selectedId; });
    var has = !!kf;
    el.selTimeInput.disabled = !has;
    el.btnReplace.disabled = !has;
    el.btnDelete.disabled = !has;
    el.kfCard.classList.toggle('hidden', !has);
    el.kfEmpty.classList.toggle('hidden', has);
    if (!kf) return;
    el.selTimeInput.value = (Math.round(kf.time * 100) / 100).toFixed(2);
    el.kfThumb.src = kf.img;
    el.kfName.textContent = kf.name || 'keyframe';
    el.kfTime.textContent = fmtTime(kf.time);
  }

  function updateTransport() {
    var frames = buildPlaybackFrames();
    el.timeLabel.textContent = fmtTime(state.playhead);
    el.frameLabel.textContent = 'frame ' + (state.curIndex + 1) + ' / ' + frames.length;
    el.btnPlay.innerHTML = state.playing ? ICONS.pause : ICONS.play;
    el.btnLoop.style.opacity = state.loop ? 1 : 0.35;
  }

  function renderAll() {
    renderTimeline();
    renderFilmstrip();
    renderPreview();
    renderSelectedPanel();
    updateTransport();
    updateEstimate();
    el.btnKeysOnly.classList.toggle('active', state.keysOnly);
  }

  function updateEstimate() {
    var total = 0, gapCount = 0;
    computeGaps().forEach(function (g) {
      if (g.genCount > 0 && !gapComplete(g)) { total += computeMissing(g).length; gapCount++; }
    });
    if (!state.keyframes.length) {
      setGenStatus('idle', '');
    } else if (!total) {
      setGenStatus('ready', 'All gaps generated ✓');
    } else {
      setGenStatus('idle', '~' + total + ' frames to generate across ' + gapCount + ' gap(s)');
    }
  }

  // ------------------------------------------------------------------
  // Playback
  // ------------------------------------------------------------------
  function setFrameByIndex(idx) {
    var frames = buildPlaybackFrames();
    if (!frames.length) { state.curIndex = 0; state.playhead = 0; }
    else {
      state.curIndex = clamp(Math.round(idx), 0, frames.length - 1);
      state.playhead = frames[state.curIndex].time;
    }
    renderPreview();
    renderPlayhead();
    updateTransport();
    highlightCurrentThumb();
  }

  function setFrameByTime(t) {
    var frames = buildPlaybackFrames();
    if (!frames.length) { state.curIndex = 0; state.playhead = 0; }
    else {
      var idx = 0;
      for (var i = 0; i < frames.length; i++) {
        if (frames[i].time <= t + 1e-9) idx = i; else break;
      }
      state.curIndex = idx;
      // Keep the playhead exactly where the user scrubbed instead of snapping
      // it to a frame boundary, so it can sit anywhere between frames.
      state.playhead = Math.max(0, t);
    }
    renderPreview();
    renderPlayhead();
    updateTransport();
    highlightCurrentThumb();
  }

  // Used at the end of a scrub when Snap is on: settle the playhead on the
  // nearest playback frame (either a keyframe or a generated inbetween).
  function snapPlayheadToNearestFrame() {
    var frames = buildPlaybackFrames();
    if (!frames.length) return;
    var t = state.playhead;
    var best = 0, bestD = Infinity;
    for (var i = 0; i < frames.length; i++) {
      var d = Math.abs(frames[i].time - t);
      if (d < bestD) { bestD = d; best = i; }
    }
    setFrameByTime(frames[best].time);
  }

  function highlightCurrentThumb() {
    var thumbs = el.filmstrip.children;
    for (var i = 0; i < thumbs.length; i++) {
      thumbs[i].classList.toggle('current', i === state.curIndex);
    }
  }

  // Time-based playback: the playhead advances in real time (1 second of
  // timeline per 1 second of wall clock) and the frame under the playhead is
  // displayed. Keyframe holds and gap lengths are therefore respected — a
  // keyframe that holds for 0.5s really stays on screen 0.5s — instead of
  // every frame being force-fit to exactly 1/fps.
  var playStart = 0, playStartTime = 0;
  function playbackEnd() {
    var keys = sortedKeyframes();
    if (!keys.length) return 0;
    return keys[keys.length - 1].time + keyframeHold(keys[keys.length - 1]);
  }
  function play() {
    if (state.playing || !buildPlaybackFrames().length) return;
    if (state.playhead >= playbackEnd()) state.playhead = 0; // at the end: restart
    state.playing = true;
    playStart = state.playhead;
    playStartTime = performance.now();
    updateTransport();
    // Decode all playback frames into memory now so the first appearance of
    // each frame is instant instead of a black flash.
    preloadPlaybackFrames();
    requestAnimationFrame(tick);
  }

  function pause() {
    state.playing = false;
    updateTransport();
  }

  function togglePlay() { state.playing ? pause() : play(); }

  function tick(now) {
    if (!state.playing) return;
    var end = playbackEnd();
    state.playhead = Math.max(0, playStart + (now - playStartTime) / 1000);
    if (state.playhead >= end) {
      if (state.loop) {
        state.playhead = 0;
        playStart = 0;
        playStartTime = now;
      } else {
        setFrameByTime(end); // settle on the last frame and stop
        pause();
        return;
      }
    }
    setFrameByTime(state.playhead);
    if (state.playing) requestAnimationFrame(tick);
  }

  function step(delta) {
    setFrameByIndex(state.curIndex + delta);
  }

  // ------------------------------------------------------------------
  // Keyframe add / move / delete / replace
  // ------------------------------------------------------------------
  function readImageFile(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var MAX = 2048;
        var scale = Math.min(1, MAX / Math.max(img.width, img.height));
        var w = Math.max(1, Math.round(img.width * scale));
        var h = Math.max(1, Math.round(img.height * scale));
        var c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        resolve({ img: c.toDataURL('image/png'), w: img.width, h: img.height, name: file.name || 'frame' });
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Could not read ' + (file.name || 'image'))); };
      img.src = url;
    });
  }

  function addKeyframes(files, atTime) {
    if (!files || !files.length) return Promise.resolve();
    var sortedKeys = sortedKeyframes();
    var baseTime = atTime !== undefined
      ? atTime
      : (sortedKeys.length ? sortedKeys[sortedKeys.length - 1].time + 1 : 0);
    var chain = Promise.resolve();
    Array.prototype.forEach.call(files, function (file, i) {
      chain = chain.then(function () {
        return readImageFile(file).then(function (data) {
          state.keyframes.push({
            id: 'k' + (idSeq++),
            time: Math.max(0, baseTime + i),
            img: data.img,
            name: data.name,
            w: data.w,
            h: data.h
          });
        });
      });
    });
    return chain.then(function () {
      applyWorkSize();
      invalidateAll();
      renderAll();
      save();
      scheduleGenerate();
    });
  }

  function selectKeyframe(id) {
    state.selectedId = id;
    renderSelectedPanel();
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
        invalidateAround(id);
        applyWorkSize();
        renderAll();
        save();
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
    delete state.generated[gapId(id, '')];
    if (state.selectedId === id) state.selectedId = null;
    applyWorkSize();
    refreshDirty();
    renderAll();
    save();
    scheduleGenerate();
  }

  function promoteToKeyframe(f) {
    // re-key the generated frames of the old gap into the two gaps created by the split
    var oldGap = null;
    computeGaps().forEach(function (g) {
      if (f.time > g.from.time && f.time < g.to.time) oldGap = g;
    });
    var oldGen = oldGap ? state.generated[oldGap.id] : null;
    if (oldGap) delete state.generated[oldGap.id];
    state.keyframes.push({
      id: 'k' + (idSeq++),
      time: f.time,
      img: f.img,
      name: 'promoted',
      w: workW,
      h: workH
    });
    if (oldGen) {
      computeGaps().forEach(function (g) {
        state.generated[g.id] = oldGen.filter(function (frame) {
          return frame.time > g.fromTime + 1e-9 && frame.time < g.toTime - 1e-9;
        });
      });
    }
    state.selectedId = state.keyframes[state.keyframes.length - 1].id;
    applyWorkSize();
    refreshDirty();
    renderAll();
    save();
    scheduleGenerate();
    toast('Promoted to keyframe at ' + fmtTime(f.time));
  }

  // ------------------------------------------------------------------
  // Generation
  // ------------------------------------------------------------------
  function setGenStatus(kind, text) {
    el.genStatus.className = 'status ' + kind;
    el.genStatus.textContent = text || '';
  }

  function setGenProgress(label, pct) {
    el.genProgress.classList.remove('hidden');
    el.genFill.style.width = clamp(pct, 0, 100) + '%';
    el.genLabel.textContent = label;
    el.genMeta.textContent = Math.round(pct) + '%';
  }

  // ------------------------------------------------------------------
  // Generation — runs in the background worker; only missing frames are
  // generated, and auto-runs (debounced) after every change.
  // ------------------------------------------------------------------
  function drawImageToData(img, w, h) {
    var canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    drawContain(ctx, img, w, h);
    return ctx.getImageData(0, 0, w, h).data;
  }

  function dataToDataURL(data, w, h) {
    var canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext('2d');
    var imageData = ctx.createImageData(w, h);
    imageData.data.set(data);
    ctx.putImageData(imageData, 0, 0);
    return canvas.toDataURL('image/png');
  }

  // Generate one gap's missing frames. Dispatches to the worker when
  // available; otherwise runs inline (mesh warp fallback path).
  function generateGap(gap, missing, cbs) {
    var missingList = missing.map(function (idx) {
      return { idx: idx, t: idx / (gap.genCount + 1) };
    });
    return Promise.all([loadImage(gap.from.img), loadImage(gap.to.img)]).then(function (imgs) {
      if (cbs.cancelled()) return;
      var aData = drawImageToData(imgs[0], workW, workH);
      var bData = drawImageToData(imgs[1], workW, workH);
      if (worker) {
        var jobId = 'job' + (++jobSeq);
        return new Promise(function (resolve, reject) {
          workerJobs[jobId] = {
            resolve: resolve,
            reject: reject,
            onFrame: cbs.onFrame,
            onProgress: cbs.onProgress
          };
          var aBuf = aData.buffer, bBuf = bData.buffer;
          worker.postMessage({
            type: 'generate-gap',
            jobId: jobId,
            aData: aBuf, bData: bBuf,
            width: workW, height: workH,
            fromTime: gap.fromTime, toTime: gap.toTime,
            missing: missingList
          }, [aBuf, bBuf]);
        }).catch(function (err) {
          // Worker died mid-job: run the same gap inline instead of failing.
          if (cbs.cancelled()) throw err;
          console.error('Worker job failed, running inline:', err);
          return generateGapInline(aData, bData, gap, missingList, cbs);
        });
      }
      return generateGapInline(aData, bData, gap, missingList, cbs);
    });
  }

  // Inline fallback (no worker available). Every frame is AI-generated by the
  // local model when it's ready, otherwise the mesh warp takes over —
  // generation never stalls.
  function generateGapInline(aData, bData, gap, missingList, cbs) {
    var meshes = null;
    var emit = function (m) {
      if (cbs.cancelled()) return Promise.resolve();
      var t = m.t;
      var time = gap.fromTime + (gap.toTime - gap.fromTime) * t;
      var done = function (rgba, ai) {
        cbs.onFrame({ idx: m.idx, t: t, time: time, img: dataToDataURL(rgba, workW, workH), ai: ai });
      };
      if (cbs.aiReady()) {
        return model.interpolate(aData, bData, workW, workH, t).then(function (aiOut) {
          done(aiOut, true);
        }).catch(function (err) {
          if (cbs.cancelled()) return;
          console.error('AI inbetween failed, using mesh warp:', err);
          done(morph.morphFrameMesh(aData, bData, meshes, workW, workH, t), false);
        });
      }
      done(morph.morphFrameMesh(aData, bData, meshes, workW, workH, t), false);
      return Promise.resolve();
    };
    var first = function () {
      if (cbs.onProgress) cbs.onProgress('Preparing interpolation…', 0);
      return morph.computeFlowBoth(aData, bData, workW, workH, {}, function (frac) {
        if (cbs.onProgress) cbs.onProgress('Preparing interpolation…', frac * 0.05);
      }, cbs.cancelled).then(function (pair) {
        if (cbs.cancelled()) return;
        meshes = morph.buildMeshes(pair, workW, workH, 16);
      });
    };
    var i = 0;
    var next = function () {
      if (cbs.cancelled() || i >= missingList.length) return Promise.resolve();
      var m = missingList[i];
      var label = (cbs.aiReady() ? 'AI inbetween ' : 'mesh warp ') + m.idx + '/' + gap.genCount;
      i++;
      return emit(m).then(function () {
        if (cbs.onProgress) cbs.onProgress(label, i / missingList.length);
        return new Promise(function (r) { setTimeout(r, 0); }).then(next);
      });
    };
    return first().then(next);
  }

  var genTimer = null;
  var modelGate = null;          // promise resolving when model load settles
  var modelGateResolve = null;   // resolve() for the gate above
  function scheduleGenerate(delay) {
    clearTimeout(genTimer);
    genTimer = setTimeout(function () {
      // Wait for the model download/compile to settle so gaps are generated
      // with AI when possible (the launch overlay blocks interaction anyway).
      (modelGate || Promise.resolve()).then(function () {
        if (state.genRun) { state.pendingRegen = true; cancelRun(); }
        else runGeneration();
      });
    }, delay || 500);
  }

  function cancelRun() {
    if (state.genRun) {
      state.genRun.cancelled = true;
      if (worker) worker.postMessage({ type: 'cancel' });
    }
  }

  function runGeneration() {
    if (state.genRun) return;
    var gaps = computeGaps().filter(function (g) {
      return g.genCount > 0 && !gapComplete(g);
    });
    var total = gaps.reduce(function (s, g) { return s + computeMissing(g).length; }, 0);
    if (!total) {
      setGenStatus('ready', 'All gaps generated ✓');
      updateEstimate();
      return;
    }
    var run = { cancelled: false };
    state.genRun = run;
    el.btnCancel.classList.remove('hidden');
    setGenStatus('downloading', 'Preparing…');
    setGenProgress('Preparing…', 2);

    var done = 0;
    var chain = Promise.resolve();
    gaps.forEach(function (gap, gi) {
      chain = chain.then(function () {
        if (run.cancelled) return;
        var missing = computeMissing(gap);
        if (!missing.length) return;
        var gen = state.generated[gap.id] || (state.generated[gap.id] = []);
        // Stamp now, so a later refresh keeps the frames we produce here even
        // if the run is cancelled (only the tail stays dirty).
        state.gapMeta[gap.id] = gapStamp(gap);
        setGenStatus('downloading', 'Gap ' + (gi + 1) + '/' + gaps.length + ' (' + missing.length + ' frames)');
        return generateGap(gap, missing, {
          aiReady: function () { return model.isReady(); },
          cancelled: function () { return run.cancelled; },
          onProgress: function (label, gapFrac) {
            setGenProgress(
              'Gap ' + (gi + 1) + '/' + gaps.length + ' · ' + label,
              ((done + gapFrac) / total) * 100
            );
          },
          onFrame: function (frame) {
            // Merge by index so a partially-generated gap is only topped up.
            var found = gen.find(function (f) { return f && f.idx === frame.idx; });
            if (found) { for (var k in found) found[k] = frame[k]; }
            else gen.push(frame);
            done++;
            setGenProgress(
              'Gap ' + (gi + 1) + '/' + gaps.length + ' · ' + (frame.ai ? 'AI frame ' : 'warp ') + frame.idx + '/' + gap.genCount,
              (done / total) * 100
            );
          }
        }).then(function () {
          if (!run.cancelled) {
            gen.sort(function (a, b) { return a.idx - b.idx; });
            refreshDirty();
          }
          renderLane();
          renderFilmstrip();
        });
      });
    });
    chain.then(function () {
      if (run.cancelled) {
        setGenStatus('idle', 'Stopped. Completed frames kept; remaining gaps will auto-regenerate.');
        updateEstimate();
      } else {
        setGenStatus('ready', total + ' frames generated ✓');
      }
    }).catch(function (err) {
      if (err && err.message === 'Cancelled') {
        setGenStatus('idle', 'Stopped.');
      } else {
        setGenStatus('error', 'Generation failed: ' + (err && err.message ? err.message : String(err)));
        toast('Generation failed: ' + (err && err.message ? err.message : String(err)), 6000);
      }
      console.error(err);
    }).finally(function () {
      state.genRun = null;
      el.btnCancel.classList.add('hidden');
      el.genProgress.classList.add('hidden');
      save();
      if (state.pendingRegen) {
        state.pendingRegen = false;
        runGeneration();
      }
    });
  }

  // ------------------------------------------------------------------
  // Export
  // ------------------------------------------------------------------
  function canvasToPNGBlob(img, w, h) {
    var canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    drawContain(ctx, img, w, h);
    return new Promise(function (resolve) {
      canvas.toBlob(resolve, 'image/png');
    });
  }

  function downloadFrame(dataURL, name) {
    var a = document.createElement('a');
    a.href = dataURL;
    a.download = name || 'frame.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // ---- minimal ZIP writer (store method, no compression) ----
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function makeZip(files) {
    var enc = new TextEncoder();
    var chunks = [];
    var central = [];
    var offset = 0;
    files.forEach(function (f) {
      var name = enc.encode(f.name);
      var crc = crc32(f.data);
      var local = new Uint8Array(30 + name.length);
      var dv = new DataView(local.buffer);
      dv.setUint32(0, 0x04034b50, true);
      dv.setUint16(4, 20, true);
      dv.setUint16(6, 0x0800, true);
      dv.setUint16(8, 0, true);
      dv.setUint16(10, 0, true);
      dv.setUint16(12, 0x21, true);
      dv.setUint32(14, crc, true);
      dv.setUint32(18, f.data.length, true);
      dv.setUint32(22, f.data.length, true);
      dv.setUint16(26, name.length, true);
      dv.setUint16(28, 0, true);
      local.set(name, 30);
      chunks.push(local, f.data);
      central.push({ name: name, crc: crc, size: f.data.length, offset: offset });
      offset += local.length + f.data.length;
    });
    var cdStart = offset;
    var cdChunks = [];
    central.forEach(function (c) {
      var rec = new Uint8Array(46 + c.name.length);
      var dv = new DataView(rec.buffer);
      dv.setUint32(0, 0x02014b50, true);
      dv.setUint16(4, 20, true);      // version made by
      dv.setUint16(6, 20, true);      // version needed to extract
      dv.setUint16(8, 0x0800, true);  // flags: UTF-8 names
      dv.setUint16(10, 0, true);      // method: store
      dv.setUint16(12, 0, true);      // mod time
      dv.setUint16(14, 0x21, true);   // mod date
      dv.setUint32(16, c.crc, true);
      dv.setUint32(20, c.size, true); // compressed size
      dv.setUint32(24, c.size, true); // uncompressed size
      dv.setUint16(28, c.name.length, true);
      dv.setUint16(30, 0, true);      // extra field length
      dv.setUint16(32, 0, true);      // comment length
      dv.setUint16(34, 0, true);      // disk number start
      dv.setUint16(36, 0, true);      // internal attributes
      dv.setUint32(38, 0, true);      // external attributes
      dv.setUint32(42, c.offset, true);
      rec.set(c.name, 46);
      cdChunks.push(rec);
    });
    var cdSize = cdChunks.reduce(function (s, c) { return s + c.length; }, 0);
    var eocd = new Uint8Array(22);
    var ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, central.length, true);
    ev.setUint16(10, central.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, cdStart, true);
    var total = eocd.length + cdSize;
    chunks.forEach(function (c) { total += c.length; });
    var out = new Uint8Array(total);
    var p = 0;
    chunks.forEach(function (c) { out.set(c, p); p += c.length; });
    cdChunks.forEach(function (c) { out.set(c, p); p += c.length; });
    out.set(eocd, p);
    return out;
  }

  function pad(n, len) {
    var s = String(n);
    while (s.length < len) s = '0' + s;
    return s;
  }

  function exportPNGZip() {
    var frames = buildPlaybackFrames();
    if (!frames.length) { toast('Nothing to export.'); return; }
    setGenStatus('downloading', 'Building PNG sequence…');
    var chain = Promise.resolve();
    var files = [];
    frames.forEach(function (f, i) {
      chain = chain.then(function () {
        return loadImage(f.img).then(function (img) {
          return canvasToPNGBlob(img, workW, workH);
        }).then(function (blob) {
          return blob.arrayBuffer();
        }).then(function (buf) {
          files.push({ name: 'frame_' + pad(i + 1, 4) + '.png', data: new Uint8Array(buf) });
          setGenProgress('Rendering ' + (i + 1) + '/' + frames.length, ((i + 1) / frames.length) * 100);
        });
      });
    });
    chain.then(function () {
      var zip = makeZip(files);
      downloadBlob(zip, 'animation-frames.zip', 'application/zip');
      setGenStatus('ready', 'PNG sequence exported ✓');
      el.genProgress.classList.add('hidden');
    }).catch(function (err) {
      setGenStatus('error', 'Export failed: ' + err.message);
    });
  }

  function exportGIF() {
    var frames = buildPlaybackFrames();
    if (!frames.length) { toast('Nothing to export.'); return; }
    if (!gifenc) { toast('GIF encoder not available.'); return; }
    setGenStatus('downloading', 'Encoding GIF…');
    var gif = gifenc.GIFEncoder();
    // Each frame holds for its real timeline duration (holds + gap spacing),
    // exactly like playback. gifenc takes delay in ms and quantizes to 10ms.
    var durs = playbackDurations(frames);
    var chain = Promise.resolve();
    frames.forEach(function (f, i) {
      chain = chain.then(function () {
        return loadImage(f.img).then(function (img) {
          var canvas = document.createElement('canvas');
          canvas.width = workW;
          canvas.height = workH;
          var ctx = canvas.getContext('2d');
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, workW, workH);
          drawContain(ctx, img, workW, workH);
          return ctx.getImageData(0, 0, workW, workH).data;
        }).then(function (rgba) {
          var palette = gifenc.quantize(rgba, 256);
          var index = gifenc.applyPalette(rgba, palette);
          gif.writeFrame(index, workW, workH, { delay: Math.round(durs[i] * 1000), palette: palette });
          setGenProgress('Quantizing ' + (i + 1) + '/' + frames.length, ((i + 1) / frames.length) * 100);
        });
      });
    });
    chain.then(function () {
      gif.finish();
      downloadBlob(new Blob([gif.bytes()], { type: 'image/gif' }), 'animation.gif');
      setGenStatus('ready', 'GIF exported ✓');
      el.genProgress.classList.add('hidden');
    }).catch(function (err) {
      setGenStatus('error', 'GIF export failed: ' + err.message);
    });
  }

  // ---- MP4 export (records the animation with the browser's built-in encoder) ----
  function pickVideoMime() {
    if (typeof window.MediaRecorder === 'undefined') return null;
    var candidates = [
      'video/mp4;codecs=avc1.42E01E',
      'video/mp4;codecs=avc1.64001f',
      'video/mp4',
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm'
    ];
    for (var i = 0; i < candidates.length; i++) {
      try {
        if (window.MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
      } catch (e) { /* keep trying */ }
    }
    return null;
  }

  // How long each playback frame stays on screen during playback/export:
  // from its own time until the next frame's time (the last frame runs until
  // the end of the timeline, i.e. its keyframe hold). This keeps playback and
  // exported video in sync with the actual positions on the timeline.
  function playbackDurations(frames) {
    var end = playbackEnd();
    var durs = [];
    for (var i = 0; i < frames.length; i++) {
      var next = frames[i + 1];
      durs.push(Math.max(1 / Math.max(1, state.fps), next ? next.time - frames[i].time : end - frames[i].time));
    }
    return durs;
  }

  function exportMP4() {
    var frames = buildPlaybackFrames();
    if (!frames.length) { toast('Nothing to export.'); return; }
    var mime = pickVideoMime();
    if (!mime) {
      setGenStatus('error', 'Video recording is not supported in this browser.');
      toast('This browser cannot record video. Use Chrome, Edge or Safari for MP4 export.');
      return;
    }
    var isMp4 = mime.indexOf('mp4') !== -1;
    var fps = Math.max(1, state.fps);
    var canvas = document.createElement('canvas');
    canvas.width = workW;
    canvas.height = workH;
    var ctx = canvas.getContext('2d');
    if (typeof canvas.captureStream !== 'function') {
      setGenStatus('error', 'This browser cannot capture canvas video.');
      toast('Canvas video capture is not supported here.');
      return;
    }

    setGenStatus('downloading', isMp4 ? 'Recording MP4…' : 'Recording video…');
    setGenProgress('Preparing frames…', 2);
    el.genProgress.classList.remove('hidden');
    el.btnCancel.classList.remove('hidden');

    Promise.all(frames.map(function (f) { return loadImage(f.img); })).then(function (imgs) {
      var stream = canvas.captureStream(fps);
      var recorder;
      try {
        recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 10 * 1000 * 1000 });
      } catch (e) {
        el.btnCancel.classList.add('hidden');
        setGenStatus('error', 'Could not start recorder: ' + e.message);
        toast('Recorder failed: ' + e.message);
        return;
      }
      var chunks = [];
      var stopped = false;
      recorder.ondataavailable = function (e) {
        if (e.data && e.data.size) chunks.push(e.data);
      };
      recorder.onstop = function () {
        if (stopped) return;
        stopped = true;
        el.btnCancel.classList.add('hidden');
        el.genProgress.classList.add('hidden');
        var blob = new Blob(chunks, { type: isMp4 ? 'video/mp4' : mime });
        if (!blob.size) {
          setGenStatus('error', 'Recording produced no data. Try again.');
          return;
        }
        downloadBlob(blob, isMp4 ? 'animation.mp4' : 'animation.webm', blob.type);
        setGenStatus('ready', isMp4
          ? 'MP4 exported ✓'
          : 'Saved as WebM. This browser cannot mux MP4 (Chrome, Edge or Safari can). ✓');
      };
      recorder.onerror = function () {
        el.btnCancel.classList.add('hidden');
        setGenStatus('error', 'Recording failed.');
      };
      state.mp4Stop = function () {
        try { recorder.stop(); } catch (e) {}
      };

      var durs = playbackDurations(frames);
      var totalDur = 0;
      durs.forEach(function (d) { totalDur += d; });
      var t0 = performance.now() + 300; // small delay so the recorder is ready
      var idx = -1;
      var finished = false;
      recorder.start();
      function draw(now) {
        if (finished) return;
        if (now < t0) { requestAnimationFrame(draw); return; }
        // Advance through frames using each frame's real duration on the
        // timeline (holds + gap spacing), matching what playback shows.
        var elapsed = (now - t0) / 1000;
        var next = frames.length - 1;
        var acc = 0;
        for (var i = 0; i < frames.length - 1; i++) {
          if (elapsed < acc + durs[i]) { next = i; break; }
          acc += durs[i];
        }
        if (next !== idx) {
          idx = next;
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, workW, workH);
          drawContain(ctx, imgs[idx], workW, workH);
          setGenProgress('Recording frame ' + (idx + 1) + '/' + frames.length, ((idx + 1) / frames.length) * 100);
        }
        // Keep the final frame on screen for its own hold, then stop.
        if (elapsed >= totalDur) {
          finished = true;
          setTimeout(function () { state.mp4Stop(); state.mp4Stop = null; }, 200);
          return;
        }
        requestAnimationFrame(draw);
      }
      requestAnimationFrame(draw);
    }).catch(function (err) {
      el.btnCancel.classList.add('hidden');
      el.genProgress.classList.add('hidden');
      setGenStatus('error', 'Export failed: ' + err.message);
    });
  }

  // ------------------------------------------------------------------
  // Timeline interactions
  // ------------------------------------------------------------------
  function timeFromClientX(clientX) {
    var rect = el.timeline.getBoundingClientRect();
    var x = clientX - rect.left + el.timeline.scrollLeft;
    return x / state.zoom;
  }

  function startKfDrag(e, chip) {
    var id = chip.dataset.id;
    var kf = state.keyframes.find(function (k) { return k.id === id; });
    if (!kf) return;
    e.preventDefault();
    e.stopPropagation();
    selectKeyframe(id);
    var startX = e.clientX;
    var startTime = kf.time;
    var moved = false;
    var tip = document.createElement('div');
    tip.className = 'kf-drag-tip';
    chip.appendChild(tip);
    // After a live renderLane() the chip is rebuilt, so re-attach the tip to
    // the fresh element for this keyframe.
    function attachTip() {
      var fresh = el.lane.querySelector('.kf[data-id="' + id + '"]');
      if (fresh) fresh.appendChild(tip);
    }
    function updateTip(t) { tip.textContent = fmtTime(t); }
    updateTip(startTime);

    function onMove(ev) {
      var dt = (ev.clientX - startX) / state.zoom;
      var t = Math.max(0, startTime + dt);
      // Don't drag a keyframe past the previous one's end (its time + hold).
      var sorted = sortedKeyframes();
      var idx = sorted.indexOf(kf);
      if (idx > 0) {
        var prevEnd = sorted[idx - 1].time + keyframeHold(sorted[idx - 1]);
        if (t < prevEnd) t = prevEnd;
      }
      if (state.snap) t = Math.round(t * state.fps) / state.fps;
      kf.time = t;
      retimeAllFrames();  // gap overlays + dots follow live
      renderLane();
      attachTip();
      updateTip(t);
      moved = true;
    }
    function onUp() {
      tip.remove();
      el.timeline.removeEventListener('pointermove', onMove);
      el.timeline.removeEventListener('pointerup', onUp);
      el.timeline.removeEventListener('pointercancel', onUp);
      if (moved) {
        invalidateAround(id);
        refreshDirty();
        renderAll();
        save();
        scheduleGenerate(300);
      } else {
        renderLane();
      }
    }
    el.timeline.addEventListener('pointermove', onMove);
    el.timeline.addEventListener('pointerup', onUp);
    el.timeline.addEventListener('pointercancel', onUp);
    try { el.timeline.setPointerCapture(e.pointerId); } catch (err) {}
  }

  // Resize a keyframe's hold duration by dragging its right edge.
  function startKfResize(e, chip) {
    var id = chip.dataset.id;
    var kf = state.keyframes.find(function (k) { return k.id === id; });
    if (!kf) return;
    e.preventDefault();
    e.stopPropagation();
    selectKeyframe(id);
    var startX = e.clientX;
    var startHold = keyframeHold(kf);
    var minHold = 1 / state.fps;
    var moved = false;
    var tip = document.createElement('div');
    tip.className = 'kf-drag-tip';
    chip.appendChild(tip);
    function attachTip() {
      var fresh = el.lane.querySelector('.kf[data-id="' + id + '"]');
      if (fresh) fresh.appendChild(tip);
    }
    function updateTip(h) { tip.textContent = fmtTime(h) + ' hold'; }
    updateTip(startHold);

    function onMove(ev) {
      var dh = (ev.clientX - startX) / state.zoom;
      var h = Math.max(minHold, startHold + dh);
      // Don't push the hold past the next keyframe's start.
      var sorted = sortedKeyframes();
      var idx = sorted.indexOf(kf);
      if (idx < sorted.length - 1) {
        h = Math.min(h, Math.max(minHold, sorted[idx + 1].time - kf.time));
      }
      if (state.snap) h = Math.round(h * state.fps) / state.fps;
      h = Math.max(minHold, h);
      kf.hold = h;
      retimeAllFrames();  // gap overlays + dots follow live
      renderLane();
      attachTip();
      updateTip(h);
      moved = true;
    }
    function onUp() {
      tip.remove();
      el.timeline.removeEventListener('pointermove', onMove);
      el.timeline.removeEventListener('pointerup', onUp);
      el.timeline.removeEventListener('pointercancel', onUp);
      if (moved) {
        invalidateAround(id);
        refreshDirty();
        renderAll();
        save();
        scheduleGenerate(300);
      } else {
        renderLane();
      }
    }
    el.timeline.addEventListener('pointermove', onMove);
    el.timeline.addEventListener('pointerup', onUp);
    el.timeline.addEventListener('pointercancel', onUp);
    try { el.timeline.setPointerCapture(e.pointerId); } catch (err) {}
  }

  function startScrub(e) {
    e.preventDefault();
    if (state.playing) pause(); // scrubbing is a manual override; stop playback
    try { el.timeline.setPointerCapture(e.pointerId); } catch (err) {}
    setFrameByTime(timeFromClientX(e.clientX));
    function onMove(ev) { setFrameByTime(timeFromClientX(ev.clientX)); }
    function onUp() {
      el.timeline.removeEventListener('pointermove', onMove);
      el.timeline.removeEventListener('pointerup', onUp);
      el.timeline.removeEventListener('pointercancel', onUp);
      // With Snap on, settle the playhead onto the nearest playback frame;
      // otherwise it stays exactly where the user left it.
      if (state.snap) snapPlayheadToNearestFrame();
    }
    el.timeline.addEventListener('pointermove', onMove);
    el.timeline.addEventListener('pointerup', onUp);
    el.timeline.addEventListener('pointercancel', onUp);
  }

  // ------------------------------------------------------------------
  // Persistence
  // ------------------------------------------------------------------
  function projectData() {
    return {
      v: 3,
      settings: {
        fps: state.fps, snap: state.snap, zoom: state.zoom,
        res: state.res, keysOnly: state.keysOnly
      },
      keyframes: state.keyframes.map(function (k) { return { id: k.id, time: k.time, hold: keyframeHold(k), img: k.img, name: k.name, w: k.w, h: k.h }; }),
      generated: state.generated,
      gapMeta: state.gapMeta
    };
  }

  function writeStorage() {
    var data = projectData();
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(data));
    } catch (e) {
      try {
        delete data.generated;
        delete data.gapMeta;
        localStorage.setItem(STORE_KEY, JSON.stringify(data));
      } catch (e2) { /* storage unavailable */ }
    }
  }

  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(writeStorage, 600);
  }

  function applyProjectData(data) {
    var s = data.settings || {};
    state.fps = clamp(parseFloat(s.fps) || 12, 1, 60);
    state.snap = s.snap !== false;
    state.zoom = clamp(parseFloat(s.zoom) || 90, 12, 400);
    state.res = [512, 448, 384, 320].indexOf(parseInt(s.res, 10)) >= 0 ? parseInt(s.res, 10) : 512;
    state.keysOnly = !!s.keysOnly;
    state.keyframes = (data.keyframes || []).filter(function (k) { return k && k.img; });
    state.generated = (data.generated && typeof data.generated === 'object') ? data.generated : {};
    state.gapMeta = (data.gapMeta && typeof data.gapMeta === 'object') ? data.gapMeta : {};
    idSeq = state.keyframes.reduce(function (m, k) {
      var n = parseInt(String(k.id).replace(/\D/g, ''), 10);
      return Math.max(m, isFinite(n) ? n + 1 : 1);
    }, 1);
  }

  function load() {
    var raw = null;
    try { raw = localStorage.getItem(STORE_KEY); } catch (e) {}
    if (!raw) return;
    var data = null;
    try { data = JSON.parse(raw); } catch (e) { return; }
    if (!data || !data.keyframes) return;
    applyProjectData(data);
    applyWorkSize();
    refreshDirty();
  }

  // File menu: export the project as an .ijwta file (Save) / import one (Load).
  function saveProjectFile() {
    var blob = new Blob([JSON.stringify(projectData(), null, 2)], { type: 'application/json' });
    downloadBlob(blob, 'keyframe-studio-project.ijwta', 'application/json');
    toast('Project saved (.ijwta)');
  }

  function loadProjectFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var data = JSON.parse(reader.result);
        if (!data || !Array.isArray(data.keyframes)) throw new Error('not a project file');
        cancelRun();
        applyProjectData(data);
        state.selectedId = null;
        state.playhead = 0;
        state.curIndex = 0;
        pause();
        applyWorkSize();
        refreshDirty();
        renderAll();
        save();
        // Frames saved in the file are reused when valid (same size + stamps);
        // anything invalidated by the load (size change, stale frames) is
        // regenerated automatically.
        scheduleGenerate(100);
        toast('Project loaded');
      } catch (e) {
        toast('Could not load project file. Choose an .ijwta file saved from this app.');
      }
    };
    reader.readAsText(file);
  }

  // ------------------------------------------------------------------
  // Wiring
  // ------------------------------------------------------------------
  function wireEvents() {
    el.btnAddKeyframes.addEventListener('click', function () { el.fileInput.click(); });
    byId('btnEmptyAdd').addEventListener('click', function () { el.fileInput.click(); });
    el.fileInput.addEventListener('change', function () {
      if (el.fileInput.files && el.fileInput.files.length) {
        addKeyframes(el.fileInput.files).catch(function (e) { toast(e.message); });
      }
      el.fileInput.value = '';
    });
    el.btnReplace.addEventListener('click', function () {
      if (state.selectedId) replaceKeyframeImage(state.selectedId);
    });
    el.btnDelete.addEventListener('click', function () {
      if (state.selectedId) deleteKeyframe(state.selectedId);
    });

    // generation (automatic; regenerate button forces a full re-run)
    el.btnRegenerate.addEventListener('click', function () { invalidateAll(); scheduleGenerate(50); });
    el.btnCancel.addEventListener('click', function () {
      if (state.genRun) cancelRun();
      else if (state.mp4Stop) { state.mp4Stop(); state.mp4Stop = null; }
    });

    // playback
    el.btnPlay.addEventListener('click', togglePlay);
    el.btnLoop.addEventListener('click', function () { state.loop = !state.loop; el.btnLoop.style.opacity = state.loop ? 1 : 0.35; });
    el.btnKeysOnly.addEventListener('click', function () {
      state.keysOnly = !state.keysOnly;
      el.btnKeysOnly.classList.toggle('active', state.keysOnly);
      renderPreview();
      save();
    });
    el.btnStepBack.addEventListener('click', function () { pause(); step(-1); });
    el.btnStepFwd.addEventListener('click', function () { pause(); step(1); });

    // settings
    el.fpsInput.addEventListener('change', function () {
      state.fps = clamp(parseInt(el.fpsInput.value, 10) || 12, 1, 60);
      el.fpsInput.value = String(state.fps);
      invalidateAll();
      renderAll();
      save();
      scheduleGenerate();
    });
    el.snapInput.addEventListener('change', function () { state.snap = el.snapInput.checked; save(); });
    el.resInput.addEventListener('change', function () {
      state.res = parseInt(el.resInput.value, 10) || 512;
      applyWorkSize();
      invalidateAll();
      renderAll();
      save();
      scheduleGenerate();
    });
    // Model auto-load: the AI model downloads+compiles once on launch. The loading
    // overlay shows progress; generation falls back to mesh warp if it fails.
    el.btnLoadingRetry.addEventListener('click', function () {
      el.btnLoadingRetry.classList.add('hidden');
      loadModelWithOverlay();
    });

    // selected keyframe time
    el.selTimeInput.addEventListener('change', function () {
      var kf = state.keyframes.find(function (k) { return k.id === state.selectedId; });
      if (!kf) return;
      var t = Math.max(0, parseFloat(el.selTimeInput.value) || 0);
      if (state.snap) t = Math.round(t * state.fps) / state.fps;
      invalidateAround(kf.id);
      kf.time = t;
      refreshDirty();
      renderAll();
      save();
      scheduleGenerate(300);
    });

    // zoom
    // (timeline zoom buttons were removed from Settings; Ctrl+wheel on the
    // timeline still zooms, and the canvas wheel/dblclick handle the viewport)

    // viewport zoom / pan (preview canvas)
    el.previewCanvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      zoomViewport(e.deltaY < 0 ? 1.2 : 1 / 1.2, e);
    }, { passive: false });
    el.previewCanvas.addEventListener('dblclick', resetViewport);
    var panState = null;
    el.previewCanvas.addEventListener('pointerdown', function (e) {
      if (state.viewZoom <= 1) return;
      panState = { x: e.clientX, y: e.clientY };
      el.previewCanvas.classList.add('panning');
      try { el.previewCanvas.setPointerCapture(e.pointerId); } catch (err) {}
    });
    el.previewCanvas.addEventListener('pointermove', function (e) {
      if (!panState) return;
      // Drag-pan: scroll the wrap 1:1 with the cursor (CSS px).
      el.previewWrap.scrollLeft -= e.clientX - panState.x;
      el.previewWrap.scrollTop -= e.clientY - panState.y;
      panState = { x: e.clientX, y: e.clientY };
      updateViewportLabel();
    });
    function endPan() {
      panState = null;
      el.previewCanvas.classList.remove('panning');
    }
    el.previewCanvas.addEventListener('pointerup', endPan);
    el.previewCanvas.addEventListener('pointercancel', endPan);

    // timeline pointer interactions
    el.timeline.addEventListener('pointerdown', function (e) {
      var chip = e.target.closest('.kf');
      if (chip) {
        if (e.target.closest('.kf-resize')) { startKfResize(e, chip); return; }
        startKfDrag(e, chip);
        return;
      }
      if (e.target.closest('.playhead') || e.target.closest('.ruler') || e.target.closest('.lane')) startScrub(e);
    });
    el.timeline.addEventListener('wheel', function (e) {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        var factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        state.zoom = clamp(state.zoom * factor, 12, 4000);
        renderTimeline();
      } else {
        el.timeline.scrollLeft += e.deltaY || e.deltaX;
      }
    }, { passive: false });

    // Instant hover tooltip for long-gap warnings. The whole red gap is
    // hoverable (see .gap-overlay.warn in styles.css); a fixed-position tip
    // follows the cursor so it isn't clipped by the lane and shows immediately.
    var gapTip = document.createElement('div');
    gapTip.className = 'gap-tip hidden';
    gapTip.setAttribute('role', 'tooltip');
    document.body.appendChild(gapTip);
    var gapTipVisible = false;
    function moveGapTip(e) {
      var pad = 14;
      gapTip.style.left = (e.clientX + pad) + 'px';
      gapTip.style.top = (e.clientY + pad) + 'px';
      var r = gapTip.getBoundingClientRect();
      if (r.right > window.innerWidth - 8) gapTip.style.left = Math.max(8, e.clientX - r.width - pad) + 'px';
      if (r.bottom > window.innerHeight - 8) gapTip.style.top = Math.max(8, e.clientY - r.height - pad) + 'px';
    }
    function hideGapTip() {
      gapTipVisible = false;
      gapTip.classList.add('hidden');
    }
    el.timeline.addEventListener('mouseover', function (e) {
      var warn = e.target && e.target.closest ? e.target.closest('.gap-overlay.warn') : null;
      if (!warn) { hideGapTip(); return; }
      gapTip.textContent = '⚠ This gap needs ' + (warn.dataset.count || '?') +
        ' interpolated frames. It\u2019s recommended to put a real frame in here. Long AI stretches tend to look bad.';
      gapTip.classList.remove('hidden');
      gapTipVisible = true;
      moveGapTip(e);
    });
    el.timeline.addEventListener('mousemove', function (e) {
      if (gapTipVisible) moveGapTip(e);
    });
    el.timeline.addEventListener('mouseleave', hideGapTip);

    // keyboard
    document.addEventListener('keydown', function (e) {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA')) return;
      if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { deleteKeyframe(state.selectedId); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); pause(); step(1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); pause(); step(-1); }
    });

    // drag & drop
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('drop', function (e) {
      e.preventDefault();
      var files = e.dataTransfer && e.dataTransfer.files;
      if (!files || !files.length) return;
      var overTimeline = e.target && e.target.closest && e.target.closest('#timeline');
      var atTime = overTimeline ? timeFromClientX(e.clientX) : undefined;
      addKeyframes(files, atTime).catch(function (err) { toast(err.message); });
    });
    window.addEventListener('paste', function (e) {
      var items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      var files = [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image/') === 0) {
          var f = items[i].getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length) addKeyframes(files).catch(function (err) { toast(err.message); });
    });

    // dropdown menus
    function wireMenu(btn, menu) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var open = !menu.classList.contains('hidden');
        closeMenus();
        if (!open) menu.classList.remove('hidden');
      });
      menu.addEventListener('click', function (e) { e.stopPropagation(); });
    }
    function closeMenus() {
      [el.settingsMenu, el.fileMenu, el.exportMenu].forEach(function (m) { m.classList.add('hidden'); });
    }
    wireMenu(el.btnSettings, el.settingsMenu);
    wireMenu(el.btnFile, el.fileMenu);
    wireMenu(el.btnExport, el.exportMenu);
    document.addEventListener('click', closeMenus);

    // File menu: save / load project .ijwta files
    el.btnSaveProject.addEventListener('click', saveProjectFile);
    el.btnLoadProject.addEventListener('click', function () { el.projectInput.click(); });
    el.projectInput.addEventListener('change', function () {
      if (el.projectInput.files && el.projectInput.files[0]) {
        loadProjectFile(el.projectInput.files[0]);
      }
      el.projectInput.value = '';
    });
    byId('btnExportPNG').addEventListener('click', exportPNGZip);
    byId('btnExportGIF').addEventListener('click', exportGIF);
    byId('btnExportMP4').addEventListener('click', exportMP4);
    byId('btnExportFrame').addEventListener('click', function () {
      var f = currentFrame();
      if (!f) { toast('No frame to export.'); return; }
      downloadFrame(f.img, 'frame_' + pad(state.curIndex + 1, 4) + '.png');
    });

    window.addEventListener('beforeunload', writeStorage);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') writeStorage();
    });
  }

  // ------------------------------------------------------------------
  // Model auto-load (used by boot + retry button; works via the worker or
  // inline when no worker is available)
  // ------------------------------------------------------------------
  function setLoadingProgress(label, pct) {
    el.loadingFill.style.width = clamp(pct, 0, 100) + '%';
    el.loadingLabel.textContent = label;
    el.loadingMeta.textContent = Math.round(pct) + '%';
  }

  function onModelProgress(info) {
    if (info && info.stage === 'model') {
      el.loadingSub.textContent = 'Downloading the interpolation model…';
      setLoadingProgress('Downloading model…', info.frac * 100);
    } else if (info && info.stage === 'compile') {
      el.loadingSub.textContent = 'Compiling the model for your browser…';
      setLoadingProgress('Compiling model…', 99);
    }
  }

  function onModelReady() {
    state.modelReady = true;
    if (modelGateResolve) { modelGateResolve(); modelGateResolve = null; }
    setLoadingProgress('Ready', 100);
    el.loadingOverlay.classList.add('hidden');
    toast('AI model ready ✓. All inbetweens are AI-generated');
  }

  function onModelError(err) {
    console.error('AI model load failed:', err);
    state.modelReady = false;
    if (modelGateResolve) { modelGateResolve(); modelGateResolve = null; }
    el.loadingSub.textContent = 'Could not load the AI model (' + (err && err.message ? err.message : err) + '). Frames will use the mesh warp instead.';
    el.loadingMeta.textContent = 'failed';
    el.btnLoadingRetry.classList.remove('hidden');
    toast('AI model failed to load. Using mesh warp', 6000);
  }

  function loadModelWithOverlay() {
    el.loadingOverlay.classList.remove('hidden');
    el.btnLoadingRetry.classList.add('hidden');
    setLoadingProgress('Preparing…', 0);
    el.loadingSub.textContent = 'Fetching the local AI engine + model (one-time, ~21 MB)…';
    modelGate = new Promise(function (resolve) { modelGateResolve = resolve; });
    if (worker) {
      // The worker downloads + compiles the model and reports progress back.
      worker.postMessage({ type: 'load-model' });
      return;
    }
    model.loadModel(onModelProgress).then(onModelReady).catch(onModelError);
  }

  function boot() {
    load();
    syncInputs();
    applyWorkSize();
    refreshDirty();
    renderAll();
    wireEvents();
    initWorker();
    loadModelWithOverlay(); // download + compile the AI model on launch
    scheduleGenerate(400);  // auto-fill any dirty gaps shortly after launch
    window.addEventListener('resize', function () {
      renderTimeline();
      renderPreview(); // re-fit the viewport to the new panel size
    });
  }

  function syncInputs() {
    el.fpsInput.value = String(state.fps);
    el.snapInput.checked = state.snap;
    el.resInput.value = String(state.res);
    el.btnLoop.style.opacity = state.loop ? 1 : 0.35;
    el.btnKeysOnly.classList.toggle('active', state.keysOnly);
    updateViewportLabel();
  }

  boot();
})();
