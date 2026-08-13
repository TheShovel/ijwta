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

  var state = {
    keyframes: [],        // { id, layer, time, img, name, w, h }
    assets: [],           // { img, name, w, h } — the image library (assets panel)
    layers: [{ id: 'L1', name: 'Layer 1', visible: true }], // top → bottom draw order (first = topmost)
    activeLayerId: 'L1',  // layer new keyframes go into
    generated: {},        // gapId -> [{ idx, t, time, img, ai }]
    gapMeta: {},          // gapId -> { h, count } — what the frames were made from
    gapType: {},          // gapId -> 'ai' | 'squash' | 'none' (per-gap interpolation)
    gapSquash: {},        // gapId -> { amount, curve, preserve }
    dirty: new Set(),     // gapIds that need (re)generation
    fps: 12,
    zoom: 90,             // px per second
    snap: true,
    res: 512,             // long edge for preset aspects
    aspect: 'auto',       // 'auto' | '16:9' | '9:16' | '4:3' | '3:4' | '1:1' | 'custom'
    customW: 1920,        // exact working width in custom aspect mode
    customH: 1080,        // exact working height in custom aspect mode
    modelReady: false,
    playhead: 0,
    curIndex: 0,
    playing: false,
    loop: true,
    keysOnly: false,   // viewport shows keyframes only (no interpolated frames)
    selectedId: null,
    selectedGapId: null,   // gap selected in the timeline (right panel shows it)
    genRun: null,
    pendingRegen: false,
    exporting: false,       // true while an export is running (Stop button)
    exportCancel: false,    // set to stop a PNG/GIF/frame export mid-run
    mp4Stop: null,          // stops the MP4 recorder if one is running
    previewToken: 0,
    viewZoom: 1         // preview viewport zoom (1 = fit the panel; pan lives in the scroll position)
  };

  var workW = 512, workH = 512;
  var restoringProject = false; // true while loading a project (skip size invalidation)
  var imgCache = new Map();
  var assetCache = [];    // [{ img, name, w, h }] — assets panel contents
  var assetImgs = new Set(); // img srcs already in the panel (change detection)
  var idSeq = 1;
  var layerSeq = 2;
  var GUTTER_W = 96; // px at the left of the timeline reserved for layer names
  var TL_H_DEFAULT = 188; // px, initial timeline height (see .timeline-col)
  var TL_H_MIN = 96;      // px, smallest the timeline can be dragged to
  var TL_H_KEY = 'ijwta-timeline-h'; // UI preference, not part of the project file
  var SIDE_W_DEFAULT = 212; // px, initial side panel width (see .side-col)
  var SIDE_W_MIN = 140;     // px, smallest a side panel can be dragged to
  var SIDE_W_KEY_L = 'ijwta-side-w-l'; // UI preferences, not part of the project file
  var SIDE_W_KEY_R = 'ijwta-side-w-r';
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

  function byId(id) { return document.getElementById(id); }

  var el = {
    btnAddAssets: byId('btnAddAssets'),
    assetGrid: byId('assetGrid'),
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
    exportFormat: byId('exportFormat'),
    exportRes: byId('exportRes'),
    btnExportGo: byId('btnExportGo'),
    btnReplace: byId('btnReplace'),
    btnDelete: byId('btnDelete'),
    btnCancel: byId('btnCancel'),
    kfCard: byId('kfCard'),
    kfThumb: byId('kfThumb'),
    kfName: byId('kfName'),
    kfTime: byId('kfTime'),
    kfEmpty: byId('kfEmpty'),
    kfSection: byId('kfSection'),
    gapPanel: byId('gapPanel'),
    gapName: byId('gapName'),
    gapTime: byId('gapTime'),
    gapTypeInput: byId('gapTypeInput'),
    gapSquashGroup: byId('gapSquashGroup'),
    gapSquashAmount: byId('gapSquashAmount'),
    gapSquashValue: byId('gapSquashValue'),
    gapSquashAuto: byId('gapSquashAuto'),
    gapSquashCurve: byId('gapSquashCurve'),
    gapSquashPreserve: byId('gapSquashPreserve'),
    layerNameLabel: byId('layerNameLabel'),
    layerVisible: byId('layerVisible'),
    layerType: byId('layerType'),
    btnAddLayer: byId('btnAddLayer'),
    btnRemoveLayer: byId('btnRemoveLayer'),
    previewCanvas: byId('previewCanvas'),
    previewWrap: byId('previewWrap'),
    previewEmpty: byId('previewEmpty'),
    filmstrip: byId('filmstrip'),
    timeline: byId('timeline'),
    timelineCol: byId('timelineCol'),
    tlResizer: byId('tlResizer'),
    leftCol: byId('leftCol'),
    rightCol: byId('rightCol'),
    leftResizer: byId('leftResizer'),
    rightResizer: byId('rightResizer'),
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
    aspectInput: byId('aspectInput'),
    customWInput: byId('customWInput'),
    customHInput: byId('customHInput'),
    customSizeRow: byId('customSizeRow'),
    selTimeInput: byId('selTimeInput'),
    fileInput: byId('fileInput'),
    toast: byId('toast'),
    loadingOverlay: byId('loadingOverlay'),
    loadingSub: byId('loadingSub'),
    loadingFill: byId('loadingFill'),
    loadingLabel: byId('loadingLabel'),
    loadingMeta: byId('loadingMeta'),
    btnLoadingRetry: byId('btnLoadingRetry'),
    exportOverlay: byId('exportOverlay'),
    exportTitle: byId('exportTitle'),
    exportSub: byId('exportSub'),
    exportFill: byId('exportFill'),
    exportLabel: byId('exportLabel'),
    exportMeta: byId('exportMeta'),
    btnExportCancelOverlay: byId('btnExportCancelOverlay')
  };

  // Background worker pool (frame interpolation off the main thread)

  // With cross-origin isolation (COOP/COEP headers) one worker can use every
  // CPU core via threaded WASM. Without it, ORT runs single-threaded, so we
  // spawn several workers and hand each gap to a different one — the AI
  // inference scales near-linearly across cores, with zero quality change.
  var workers = [];          // active Worker instances
  var workerBusy = [];       // parallel to workers: active gap jobs per worker
  var workersReady = 0;      // workers that reported model-ready
  var workerJobs = {};       // jobId -> { resolve, reject, onFrame, onProgress, worker }
  var jobSeq = 0;
  var upscaleJobs = {};      // jobId -> { resolve, reject } (export upscaling)

  function workerPoolSize() {
    try {
      if (typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated) return 1;
      var hw = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 1;
      // Leave one core for the UI; cap at 4 workers (diminishing returns + RAM).
      return Math.max(1, Math.min(3, hw - 1));
    } catch (e) { return 1; }
  }

  function initWorker() {
    if (workers.length || typeof Worker === 'undefined') return;
    var n = workerPoolSize();
    for (var i = 0; i < n; i++) spawnWorker();
  }

  function spawnWorker() {
    var w;
    try {
      w = new Worker('worker.js');
    } catch (e) {
      console.error('Could not start worker, using inline generation:', e);
      return;
    }
    workerBusy.push(0);
    w.onmessage = function (e) { onWorkerMessage(e, w); };
    w.onerror = function (e) {
      console.error('Worker error, dropping worker:', e && e.message);
      try { w.terminate(); } catch (err) {}
      var idx = workers.indexOf(w);
      if (idx !== -1) { workers.splice(idx, 1); workerBusy.splice(idx, 1); }
      // Reject the jobs that were running on this worker so the generation
      // chain falls back to inline for them.
      Object.keys(workerJobs).forEach(function (id) {
        var j = workerJobs[id];
        if (j && j.worker === w) {
          delete workerJobs[id];
          j.reject(new Error('Worker failed'));
        }
      });
      // If the model was still loading and every worker is gone, unblock the
      // launch overlay so the app proceeds with the mesh fallback.
      if (workers.length === 0 && !el.loadingOverlay.classList.contains('hidden')) {
        onModelError(new Error('Workers failed to load (check the model CDN is reachable)'));
      }
    };
    workers.push(w);
  }

  // Index of the worker with the fewest active gap jobs (round-robin-ish).
  function pickWorker() {
    if (!workers.length) return -1;
    var best = 0;
    for (var i = 1; i < workers.length; i++) {
      if (workerBusy[i] < workerBusy[best]) best = i;
    }
    return best;
  }

  function decBusy(w) {
    var idx = workers.indexOf(w);
    if (idx !== -1) workerBusy[idx] = Math.max(0, workerBusy[idx] - 1);
  }

  function onWorkerMessage(e, w) {
    var m = e.data;
    if (!m) return;
    if (m.type === 'model-progress') { onModelProgress(m); }
    else if (m.type === 'model-ready') {
      workersReady++;
      if (!state.modelReady && workers.length && workersReady >= workers.length) onModelReady();
    }
    else if (m.type === 'model-error') {
      // A pool worker failing to load its own copy of the model shouldn't fail
      // the app (the other workers still work); only surface it when no worker
      // is left at all.
      if (workers.length === 0) onModelError(new Error(m.message));
    }
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
      if (jd) { delete workerJobs[m.jobId]; decBusy(jd.worker); jd.resolve(); }
    }
    else if (m.type === 'gap-error') {
      var je = workerJobs[m.jobId];
      if (je) { delete workerJobs[m.jobId]; decBusy(je.worker); je.reject(new Error(m.message)); }
    }
    else if (m.type === 'sr-progress') {
      var sp = upscaleJobs[m.jobId];
      if (sp && sp.onProgress) sp.onProgress(m.frac);
    }
    else if (m.type === 'upscaled') {
      var uj = upscaleJobs[m.jobId];
      if (uj) { delete upscaleJobs[m.jobId]; uj.resolve({ data: m.rgba, width: m.width, height: m.height }); }
    }
    else if (m.type === 'upscale-cancelled') {
      var uc = upscaleJobs[m.jobId];
      if (uc) { delete upscaleJobs[m.jobId]; uc.reject(new Error('Cancelled')); }
    }
    else if (m.type === 'upscale-error') {
      var ue = upscaleJobs[m.jobId];
      if (ue) { delete upscaleJobs[m.jobId]; ue.reject(new Error(m.message)); }
    }
  }

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  // Largest the timeline can be dragged to: leave room for the toolbar plus a
  // usable preview above it.
  function maxTimelineHeight() {
    var toolbarH = 48;
    var bar = document.querySelector('.toolbar');
    if (bar && bar.offsetHeight) toolbarH = bar.offsetHeight;
    return Math.max(TL_H_MIN + 10, window.innerHeight - toolbarH - 140);
  }
  // Largest a side panel can be dragged to: keep at least half the stage width
  // for the preview and the other panel.
  function maxSideWidth() {
    return Math.max(SIDE_W_MIN + 10, Math.floor(window.innerWidth * 0.4));
  }
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

  // Decode every layer's playback images into the cache ahead of the playhead,
  // so the first appearance of a composite is instant instead of a black flash.
  // Concurrency is capped so we don't hammer the decoder with one giant burst.
  var playbackPreload = null;
  function preloadPlaybackFrames() {
    var srcs = [];
    var seen = {};
    state.keyframes.forEach(function (k) {
      if (k.img && !seen[k.img]) { seen[k.img] = true; srcs.push(k.img); }
    });
    state.layers.forEach(function (L) {
      computeGaps(L.id).forEach(function (g) {
        (state.generated[g.id] || []).forEach(function (f) {
          if (f.img && !seen[f.img]) { seen[f.img] = true; srcs.push(f.img); }
        });
      });
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

  function layerById(id) {
    return state.layers.find(function (l) { return l.id === id; }) || state.layers[0];
  }

  // Keyframes of one layer (or all layers when layerId is omitted), time-sorted.
  function sortedKeyframes(layerId) {
    return state.keyframes.filter(function (k) { return !layerId || k.layer === layerId; })
      .sort(function (a, b) { return a.time - b.time; });
  }

  function gapId(fromId, toId) { return fromId + '->' + toId; }

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

  function keyframeHold(k) {
    // Hold duration in seconds: how long the keyframe displays before the next
    // gap starts interpolating. Defaults to one frame at the current FPS.
    if (typeof k.hold === 'number' && isFinite(k.hold) && k.hold >= 0) return k.hold;
    return 1 / state.fps;
  }

  // The times a color gap generates frames: every source layer keyframe time
  // and every source inbetween time inside the gap. Color frames line up 1:1
  // with the frames actually displayed, and nowhere else.
  function colorFrameTimes(gap) {
    var srcLayer = state.layers[state.layers.indexOf(layerById(gap.layer)) + 1];
    if (!srcLayer) return [];
    var fromT = gap.fromTime, toT = gap.toTime;
    var inclusive = gap.isTail; // the tail gap also covers a change exactly at its end
    var inRange = function (t) { return t > fromT && (inclusive ? t <= toT : t < toT); };
    var times = [];
    sortedKeyframes(srcLayer.id).forEach(function (k) {
      if (inRange(k.time)) times.push(k.time);
    });
    computeGaps(srcLayer.id).forEach(function (g) {
      if (g.toTime <= fromT || g.fromTime >= toT) return;
      var n = g.genCount;
      for (var idx = 1; idx <= n; idx++) {
        var t = g.fromTime + (g.toTime - g.fromTime) * (idx / (n + 1));
        if (inRange(t)) times.push(t);
      }
    });
    times.sort(function (a, b) { return a - b; });
    var out = [];
    times.forEach(function (t) { if (!out.length || out[out.length - 1] !== t) out.push(t); });
    return out;
  }

  // Gaps of one layer (or all layers when layerId is omitted). gapId is unique
  // across layers because keyframe ids are globally unique.
  function computeGaps(layerId) {
    var keys = sortedKeyframes(layerId);
    var gaps = [];
    for (var i = 0; i < keys.length - 1; i++) {
      var from = keys[i], to = keys[i + 1];
      var id = gapId(from.id, to.id);
      var fromEnd = from.time + keyframeHold(from);
      var sec = Math.max(0, to.time - fromEnd);
      // Color layers generate colored frames: the pass is warped to follow the
      // layer directly beneath it. A color layer with nothing under it (or a
      // source layer with no frames) just holds its pass with zero frames.
      var isColor = layerById(layerId).type === 'color';
      var srcBelow = state.layers[state.layers.indexOf(layerById(layerId)) + 1];
      var colorable = !!(srcBelow && sortedKeyframes(srcBelow.id).length);
      var mode = isColor ? 'color' : (state.gapType[id] || 'ai');
      // 'none' gaps hold the from-frame until the next keyframe: no inbetweens.
      var genCount = (mode === 'none' || (isColor && !colorable)) ? 0 : Math.max(0, Math.round(sec * state.fps) - 1);
      gaps.push({
        id: id,
        layer: layerId || null,
        from: from, to: to,
        fromTime: fromEnd, toTime: to.time,
        sec: sec,
        genCount: genCount,
        mode: mode
      });
      // Color layers generate only where the source actually changes content,
      // so stretched/held source frames don't produce redundant color frames.
      if (isColor && colorable) {
        gaps[gaps.length - 1].genCount = colorFrameTimes(gaps[gaps.length - 1]).length;
      }
    }
    // Color layers also color the time after their last keyframe: a synthetic
    // tail gap runs to the latest keyframe of any layer, so a single color
    // pass stretches across the whole animation and warps with the line art.
    var L = layerById(layerId);
    if (L && L.type === 'color' && keys.length) {
      var last = keys[keys.length - 1];
      var end = 0;
      state.keyframes.forEach(function (k) { if (k.time > end) end = k.time; });
      var lastEnd = last.time + keyframeHold(last);
      var tailSec = Math.max(0, end - lastEnd);
      var tailSrc = state.layers[state.layers.indexOf(L) + 1];
      var tailColorable = !!(tailSrc && sortedKeyframes(tailSrc.id).length);
      if (tailSec > 0) {
        gaps.push({
          id: gapId(last.id, last.id + 'end'),
          layer: layerId,
          from: last, to: { id: last.id + 'end', time: end, img: last.img },
          fromTime: lastEnd, toTime: end,
          sec: tailSec,
          genCount: 0,
          mode: 'color',
          isTail: true
        });
        // Same change-based frame count as the between-keyframe gaps: the tail
        // colors only the source's actual content changes, and holds otherwise.
        if (tailColorable) {
          gaps[gaps.length - 1].genCount = colorFrameTimes(gaps[gaps.length - 1]).length;
        }
      }
    }
    return gaps;
  }

  // Every layer's gaps in one flat list. Never mix keyframes from different
  // layers into a gap — each layer interpolates its own timeline.
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
    return {
      h: hashStr(g.from.img + '|' + g.to.img),
      count: g.genCount,
      mode: g.mode || gapMode(g),
      squash: squashKey + '|' + squash.curve + '|' + squash.preserve
    };
  }

  function stampMatches(g, stamp) {
    if (!stamp) return false;
    var cur = gapStamp(g);
    return stamp.h === cur.h && stamp.count === cur.count && stamp.mode === cur.mode && stamp.squash === cur.squash;
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

  // Re-derive one generated frame's timestamp for its current gap. Normal gaps
  // space frames evenly by index; color frames sit at the source layer's frame
  // times (colorFrameTimes), so they must NOT be re-spaced evenly — that would
  // move them off the line art and desync the colors.
  function retimeGapFrame(g, f) {
    if (!f.idx) return;
    if (g.mode === 'color') {
      var ct = colorFrameTimes(g);
      var t = ct[f.idx - 1];
      if (t != null) f.time = t;
      return;
    }
    f.time = g.fromTime + (g.toTime - g.fromTime) * (f.idx / (g.genCount + 1));
  }

  function refreshDirty() {
    var gaps = allGaps();
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
        // Images or count changed: drop stale frames so they don't linger.
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

  // Live-only re-timing used while dragging/resizing: moves every generated
  // frame's timestamp to its current gap position so the lane dots and gap
  // overlays follow the mouse. No dirty-set or stamp side effects — the real
  // validation happens on drop via refreshDirty().
  function retimeAllFrames() {
    allGaps().forEach(function (g) {
      (state.generated[g.id] || []).forEach(function (f) {
        retimeGapFrame(g, f);
      });
    });
  }

  // Snap a dimension onto the 8px grid RIFE's 8x downsampling needs, so any
  // custom size keeps working through the model instead of throwing shape errors.
  function gridSnap(v) {
    return Math.max(8, Math.round(v / 8) * 8);
  }

  // The project's aspect ratio (w/h). 'auto' follows the first keyframe, as
  // before; presets give fixed ratios; 'custom' uses the manual dimensions.
  function projectAspect() {
    if (state.aspect === 'custom') return gridSnap(state.customW) / gridSnap(state.customH);
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
  // freshly-loaded frames are NOT invalidated — they were generated at exactly
  // this size, and refreshDirty() re-checks their stamps afterwards.
  function applyWorkSize() {
    var s = workingSize();
    if (s.w === workW && s.h === workH) return s;
    workW = s.w;
    workH = s.h;
    el.previewCanvas.width = workW;
    el.previewCanvas.height = workH;
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
      frames.push({ time: k.time, img: k.img, gen: false });
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
  // bottom-to-top draw order (the last layer is drawn first, the first layer
  // — the topmost — last). Each image keeps its own alpha channel, so
  // transparent keyframes (e.g. a character cut out on clear) composite over
  // the layers below it. Undecoded images are skipped by the drawing functions
  // (callers wait for them when needed). Color layers color only the layer
  // directly beneath them and always blend by multiply (the pass and its
  // generated warped frames), so the line art's lines stay visible.
  function framesAt(t, keysOnly) {
    var list = [];
    for (var i = state.layers.length - 1; i >= 0; i--) {
      var L = state.layers[i];
      if (L.visible === false) continue;
      var f = layerFrameAt(L.id, t, keysOnly);
      if (f) list.push({ img: f.img, color: L.type === 'color', gen: !!f.gen });
    }
    return list;
  }

  // Draw a bottom-to-top composite of the given layer frames (black backdrop).
  function drawFrames(ctx, frames) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, workW, workH);
    for (var i = 0; i < frames.length; i++) {
      var img = imgCache.get(frames[i].img);
      if (!img) continue;
      // Color layers always blend by multiply (generated warped frames and the
      // raw pass alike): the line art's paper stays white, its dark lines stay
      // visible, and the pass's colors tint the drawing beneath it.
      if (frames[i].color) ctx.globalCompositeOperation = 'multiply';
      drawContain(ctx, img, workW, workH);
      if (frames[i].color) ctx.globalCompositeOperation = 'source-over';
    }
  }

  function compositeKey(t, keysOnly) {
    return framesAt(t, keysOnly).map(function (f) {
      return (f.color ? 'c:' : '') + (f.gen ? 'g:' : '') + f.img;
    }).join('|');
  }

  // Render the composite at t into a fresh canvas (filmstrip thumbs, exports).
  function compositeCanvas(t) {
    var frames = framesAt(t, false);
    var canvas = document.createElement('canvas');
    canvas.width = workW;
    canvas.height = workH;
    var ctx = canvas.getContext('2d');
    return Promise.all(frames.map(function (f) {
      return loadImage(f.img).catch(function () { return null; });
    })).then(function (imgs) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, workW, workH);
      for (var i = 0; i < frames.length; i++) {
        if (!imgs[i]) continue;
        if (frames[i].color) ctx.globalCompositeOperation = 'multiply';
        drawContain(ctx, imgs[i], workW, workH);
        if (frames[i].color) ctx.globalCompositeOperation = 'source-over';
      }
      return canvas;
    });
  }

  function compositeDataURL(t) {
    return compositeCanvas(t).then(function (c) { return c.toDataURL('image/png'); });
  }

  function renderTimeline() {
    var keys = sortedKeyframes();
    var maxTime = keys.length ? keys[keys.length - 1].time : 0;
    var contentW = Math.max(el.timeline.clientWidth, GUTTER_W + 40 + (maxTime + 2) * state.zoom);
    el.track.style.width = contentW + 'px';
    renderRuler(maxTime);
    renderLane();
    renderPlayhead();
    el.zoomLabel.textContent = Math.round(state.zoom) + ' px/s';
  }

  function renderRuler(maxTime) {
    el.ruler.innerHTML = '';
    // A sticky gutter matching the layer rows, so the time scale starts after
    // the layer names and stays visible when the timeline scrolls.
    var rg = document.createElement('div');
    rg.className = 'ruler-gutter';
    el.ruler.appendChild(rg);
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
      tick.style.left = (GUTTER_W + t * state.zoom) + 'px';
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

  // Gap labels are absolutely positioned above their gap. When several narrow
  // gaps sit side by side, their labels overlap horizontally and become
  // unreadable. Assign each label to the first "row" that fits (measured
  // against the labels already placed), then lower it to that row so the text
  // stacks into a readable column instead of colliding.
  function stackGapLabels(items) {
    var ROW_H = 14;    // px between stacked rows
    var MAX_ROWS = 4;  // rows to try before giving up (rarely more are needed)
    var MARGIN = 4;    // px of horizontal clearance between labels on a row
    var BADGE = 10;    // extra width the .stacked badge adds (border + padding)
    var rows = [];
    items.forEach(function (item) {
      var w = item.el.offsetWidth || 0;
      var left = item.left;
      var right = left + w + (w > 0 ? BADGE : 0);
      var row = 0;
      if (w > 0) {
        while (row < MAX_ROWS && rows[row] && rows[row].some(function (o) {
          return right + MARGIN > o[0] && left < o[1] + MARGIN;
        })) row++;
      }
      if (!rows[row]) rows[row] = [];
      rows[row].push([left, right]);
      if (row > 0) {
        item.el.style.top = (-16 + row * ROW_H) + 'px';
        item.el.classList.add('stacked');
      }
    });
  }

  function renderLane() {
    el.lane.innerHTML = '';
    var z = state.zoom;
    state.layers.forEach(function (L) {
      var row = document.createElement('div');
      row.className = 'layer-row' + (L.id === state.activeLayerId ? ' active' : '') + (L.id === layerDragId ? ' dragging' : '');
      row.dataset.layer = L.id;
      var gutter = document.createElement('div');
      gutter.className = 'layer-gutter' + (L.id === state.activeLayerId ? ' active' : '');
      gutter.dataset.layer = L.id;
      gutter.title = 'Click to make ' + L.name + ' the active layer. Drag to reorder the stack';
      gutter.textContent = L.name;
      var grip = document.createElement('span');
      grip.className = 'layer-grip';
      grip.setAttribute('aria-hidden', 'true');
      gutter.appendChild(grip);
      if (L.type === 'color') {
        var typeBadge = document.createElement('span');
        typeBadge.className = 'layer-type-badge';
        typeBadge.textContent = 'color';
        gutter.appendChild(typeBadge);
      }
      var content = document.createElement('div');
      content.className = 'layer-content';

      var keys = sortedKeyframes(L.id);
      var gaps = computeGaps(L.id);
      var labelItems = [];

      gaps.forEach(function (g) {
        var x1 = g.fromTime * z, x2 = g.toTime * z;
        var gen = state.generated[g.id] || [];
        var ok = gapComplete(g);
        var overlay = document.createElement('div');
        overlay.className = 'gap-overlay ' + (ok ? 'ok' : 'dirty') + (g.genCount > WARN_GEN_COUNT ? ' warn' : '') +
          ' mode-' + g.mode + (L.type === 'color' ? ' layer-color' : '') + (g.id === state.selectedGapId ? ' selected' : '');
        overlay.style.left = x1 + 'px';
        overlay.style.width = Math.max(2, x2 - x1) + 'px';
        overlay.dataset.gap = g.id;
        if (g.mode === 'none') {
          if (g.sec > 0) {
            var noneLabel = document.createElement('div');
            noneLabel.className = 'glabel';
            noneLabel.textContent = 'no interpolation';
            overlay.appendChild(noneLabel);
            labelItems.push({ el: noneLabel, left: x1 + 4 });
          }
        } else if (g.mode === 'color' && g.genCount <= 0) {
          if (g.sec > 0) {
            var colorHold = document.createElement('div');
            colorHold.className = 'glabel';
            colorHold.textContent = 'color hold · stretch';
            overlay.appendChild(colorHold);
            labelItems.push({ el: colorHold, left: x1 + 4 });
          }
        } else if (g.genCount > 0) {
          var label = document.createElement('div');
          label.className = 'glabel';
          var suffix = g.mode === 'squash' ? ' · squash' : (g.mode === 'color' ? ' · color' : '');
          label.textContent = ok
            ? g.genCount + ' frames' + suffix
            : (gen.length > 0 ? gen.length + '/' + g.genCount + ' frames · regenerate' + suffix : g.genCount + ' frames needed' + suffix);
          overlay.appendChild(label);
          labelItems.push({ el: label, left: x1 + 4 });
          if (g.genCount > WARN_GEN_COUNT) {
            var warn = document.createElement('div');
            warn.className = 'gap-warn';
            warn.textContent = '⚠ ' + g.genCount + ' inbetweens. Add a real frame here or the output will look bad.';
            overlay.dataset.count = String(g.genCount);
            overlay.appendChild(warn);
          }
        }
        content.appendChild(overlay);

        gen.forEach(function (f) {
          var dot = document.createElement('div');
          dot.className = 'frame-dot';
          dot.style.left = (f.time * z) + 'px';
          content.appendChild(dot);
        });
      });
      stackGapLabels(labelItems);

      keys.forEach(function (k) {
        var chip = document.createElement('div');
        chip.className = 'kf' + (k.id === state.selectedId ? ' selected' : '');
        chip.dataset.id = k.id;
        chip.style.left = (k.time * z) + 'px';
        chip.style.width = Math.max(10, keyframeHold(k) * z) + 'px';
        // Chips are appended in time order, so overlapping chips would paint in
        // that order too. Keep the selected (dragged) chip above the rest so you
        // can grab and pull a chip across its neighbours instead of grabbing the
        // chip on top of it.
        chip.style.zIndex = k.id === state.selectedId ? 10 : 'auto';
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
        content.appendChild(chip);
      });

      row.appendChild(gutter);
      row.appendChild(content);
      el.lane.appendChild(row);
    });
  }

  function renderPlayhead() {
    var left = GUTTER_W + state.playhead * state.zoom;
    el.playhead.style.left = left + 'px';
    var scroll = el.timeline;
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
    div.appendChild(img);
    // The thumb is the composite of every layer at this frame's time.
    compositeDataURL(f.time).then(function (url) {
      if (div.parentNode) img.src = url;
    }).catch(function () {});
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
      promote.title = 'Turn this composite frame into a keyframe on the active layer';
      promote.addEventListener('click', function (e) {
        e.stopPropagation();
        promoteToKeyframe(f).catch(function (err) { toast(err.message); });
      });
      actions.appendChild(promote);
    }
    var dl = document.createElement('button');
    dl.innerHTML = ICONS.download + '<span>download</span>';
    dl.addEventListener('click', function (e) {
      e.stopPropagation();
      compositeDataURL(f.time).then(function (url) {
        downloadFrame(url, 'frame_' + fmtTime(f.time).replace('.', '_').replace('s', '') + '.png');
      }).catch(function () {});
    });
    actions.appendChild(dl);
    div.appendChild(actions);
    div.addEventListener('click', function () {
      setFrameByTime(f.time);
      if (!state.playing) renderFilmstrip();
    });
    return div;
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

  // Which frame the viewport shows is now a composite of every visible layer
  // (see framesAt). The last successfully drawn composite is remembered so the
  // screen never flashes black while a new frame's images decode.
  var lastPreview = null; // { key, frames } of the last composite actually drawn
  function renderPreview() {
    var token = ++state.previewToken;
    applyViewportSize();
    var ctx = el.previewCanvas.getContext('2d');
    if (!state.keyframes.length) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, workW, workH);
      lastPreview = null;
      el.previewEmpty.classList.toggle('hidden', false);
      return;
    }
    el.previewEmpty.classList.add('hidden');
    var key = compositeKey(state.playhead, state.keysOnly);
    if (lastPreview && lastPreview.key === key) return; // already showing this exact composite
    var frames = framesAt(state.playhead, state.keysOnly);
    var missing = frames.some(function (f) { return !imgCache.get(f.img); });
    if (missing) {
      // Keep the previous composite on screen while the new images decode.
      if (lastPreview && lastPreview.frames.length) drawFrames(ctx, lastPreview.frames);
      else {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, workW, workH);
      }
      var srcs = {};
      frames.forEach(function (f) { if (!imgCache.get(f.img)) srcs[f.img] = true; });
      Promise.all(Object.keys(srcs).map(function (src) {
        return loadImage(src).catch(function () {});
      })).then(function () {
        if (token !== state.previewToken) return;
        if (compositeKey(state.playhead, state.keysOnly) !== key) return; // moved on while loading
        var ctx2 = el.previewCanvas.getContext('2d');
        var fr = framesAt(state.playhead, state.keysOnly);
        drawFrames(ctx2, fr);
        lastPreview = { key: key, frames: fr };
      });
      return;
    }
    drawFrames(ctx, frames);
    lastPreview = { key: key, frames: frames };
  }

  function renderSelectedPanel() {
    var gap = state.selectedGapId ? allGaps().find(function (g) { return g.id === state.selectedGapId; }) : null;
    if (state.selectedGapId && !gap) state.selectedGapId = null;
    var hasGap = !!gap;
    el.gapPanel.classList.toggle('hidden', !hasGap);
    el.kfSection.classList.toggle('hidden', hasGap);
    if (hasGap) {
      var L = layerById(gap.layer);
      // Color layers always stretch (hold) — their interpolation is fixed.
      el.gapTypeInput.disabled = !!(L && L.type === 'color');
      el.gapName.textContent = (L ? L.name + ' · ' : '') + (gap.from.name || 'frame') + ' → ' + (gap.to.name || 'frame');
      el.gapTime.textContent = fmtTime(gap.fromTime) + ' → ' + fmtTime(gap.toTime) +
        (gap.mode === 'none' ? ' · hold' : gap.mode === 'color' ? ' · ' + gap.genCount + ' colored frames' : ' · ' + gap.genCount + ' inbetweens');
      el.gapTypeInput.value = gap.mode;
      var squash = gapSquashOpts(gap.id);
      var isSquash = gap.mode === 'squash';
      el.gapSquashGroup.classList.toggle('hidden', !isSquash);
      if (isSquash) {
        var isAuto = squash.amount == null;
        el.gapSquashAmount.value = isAuto ? '0' : String(Math.round(squash.amount * 100) / 100);
        el.gapSquashValue.textContent = isAuto ? 'auto' : (Math.round(squash.amount * 100) + '%');
        el.gapSquashValue.classList.toggle('is-auto', isAuto);
        el.gapSquashAmount.title = isAuto ? 'auto (distance-based)' : (Math.round(squash.amount * 100) + '%');
        el.gapSquashAuto.disabled = isAuto;
        el.gapSquashCurve.value = squash.curve;
        el.gapSquashPreserve.value = squash.preserve;
      }
      return;
    }
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

  function activateLayer(id) {
    if (!layerById(id)) return;
    state.activeLayerId = id;
    state.selectedId = null;
    state.selectedGapId = null;
    renderLayerPanel();
    renderSelectedPanel();
    renderLane();
  }

  function addLayer() {
    var id = 'L' + (layerSeq++);
    // Name the layer after the highest existing number so a name is never
    // reused, even after layers are removed.
    var n = 1;
    state.layers.forEach(function (l) {
      var m = /^Layer (\d+)$/.exec(l.name);
      if (m) n = Math.max(n, parseInt(m[1], 10) + 1);
    });
    // New layers sit on top of the stack (index 0).
    state.layers.unshift({ id: id, name: 'Layer ' + n, visible: true });
    state.activeLayerId = id;
    renderLayerPanel();
    renderSelectedPanel();
    renderLane();
    save();
  }

  function removeLayer(id) {
    if (state.layers.length <= 1) { toast('Keep at least one layer.'); return; }
    var idx = state.layers.findIndex(function (l) { return l.id === id; });
    if (idx === -1) return;
    // Drop the layer's keyframes and any generated frames for its gaps.
    computeGaps(id).forEach(function (g) {
      delete state.generated[g.id];
      delete state.gapMeta[g.id];
    });
    state.keyframes = state.keyframes.filter(function (k) { return k.layer !== id; });
    state.layers.splice(idx, 1);
    if (state.activeLayerId === id) state.activeLayerId = state.layers[0].id;
    var sel = state.keyframes.find(function (k) { return k.id === state.selectedId; });
    if (!sel) state.selectedId = null;
    applyWorkSize();
    refreshDirty();
    renderAll();
    save();
    scheduleGenerate();
  }

  // The layer bar above the timeline follows the active layer. Selecting a
  // layer happens by clicking its row on the timeline, not via a dropdown.
  function renderLayerPanel() {
    var L = layerById(state.activeLayerId);
    el.layerNameLabel.textContent = L ? L.name : '';
    el.layerVisible.checked = L ? L.visible !== false : true;
    el.layerType.value = L && L.type === 'color' ? 'color' : 'normal';
    el.btnRemoveLayer.disabled = state.layers.length <= 1;
  }

  // Assets panel (left column): the image library (state.assets). Loading a
  // file only adds it to the library; keyframes are placed by dragging an
  // asset onto the timeline. Tiles use a custom pointer drag (native HTML5
  // DnD cursors are browser-controlled and often show a no-drop X, so the
  // drag uses its own ghost with a grabbing cursor). An asset lands only
  // when released over the timeline.

  var assetDrag = { active: false, ghost: null };
  var dropGuide = null;

  function showDropGuideAt(clientX) {
    if (!dropGuide) {
      dropGuide = document.createElement('div');
      dropGuide.className = 'drop-guide';
      el.track.appendChild(dropGuide);
      var label = document.createElement('span');
      label.className = 'drop-guide-label';
      dropGuide.appendChild(label);
    }
    var t = Math.max(0, timeFromClientX(clientX));
    dropGuide.style.left = (GUTTER_W + t * state.zoom) + 'px';
    // The line follows the cursor; the label shows the snapped placement.
    dropGuide.querySelector('.drop-guide-label').textContent = fmtTime(insertTime(t));
    dropGuide.classList.add('visible');
  }

  function hideDropGuide() {
    if (dropGuide) dropGuide.classList.remove('visible');
  }

  function isOverTimeline(clientX, clientY) {
    var r = el.timeline.getBoundingClientRect();
    return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
  }

  function beginAssetDrag(a) {
    assetDrag.active = true;
    document.body.classList.add('dragging-asset');
    var ghost = document.createElement('div');
    ghost.className = 'asset-ghost';
    var img = document.createElement('img');
    img.src = a.img;
    img.alt = a.name || 'asset';
    ghost.appendChild(img);
    document.body.appendChild(ghost);
    assetDrag.ghost = ghost;
  }

  function moveAssetDrag(clientX, clientY) {
    var g = assetDrag.ghost;
    if (g) {
      g.style.left = clientX + 'px';
      g.style.top = clientY + 'px';
    }
    if (isOverTimeline(clientX, clientY)) showDropGuideAt(clientX);
    else hideDropGuide();
  }

  function endAssetDrag(a, clientX, clientY) {
    if (assetDrag.ghost) { assetDrag.ghost.remove(); assetDrag.ghost = null; }
    assetDrag.active = false;
    document.body.classList.remove('dragging-asset');
    hideDropGuide();
    if (isOverTimeline(clientX, clientY)) {
      addAssetKeyframe(a.img, insertTime(timeFromClientX(clientX)));
    }
  }

  function startAssetPointerDrag(e, a) {
    if (e.button !== 0) return;
    var startX = e.clientX, startY = e.clientY;
    var dragging = false;
    function onMove(ev) {
      if (!dragging) {
        // Small movement threshold so a plain click never starts a drag.
        if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < 4) return;
        dragging = true;
        beginAssetDrag(a);
      }
      moveAssetDrag(ev.clientX, ev.clientY);
    }
    function onUp(ev) {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      if (dragging) endAssetDrag(a, ev.clientX, ev.clientY);
    }
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
  }

  // ---- layer reordering ----
  // Drag a layer's name gutter up/down to move it in the stack. The row under
  // the cursor determines the target index; the lane re-renders live so the
  // dragged layer visibly jumps to its new position. Composite order (top →
  // bottom = first → last in state.layers) only changes on drop.
  var layerDragId = null; // layer being dragged (also highlights its row)
  function layerIndexAtY(clientY) {
    var rows = el.lane.querySelectorAll('.layer-row');
    if (!rows.length) return 0;
    var laneRect = el.lane.getBoundingClientRect();
    var h = rows[0].getBoundingClientRect().height || 66;
    return clamp(Math.floor((clientY - laneRect.top) / h), 0, rows.length - 1);
  }
  function startLayerDrag(e, layerId) {
    if (e.button !== 0 || state.layers.length < 2) return;
    var startY = e.clientY;
    var dragging = false;
    document.body.classList.add('dragging-layer');
    function onMove(ev) {
      if (!dragging) {
        if (Math.abs(ev.clientY - startY) < 4) return;
        dragging = true;
      }
      var from = state.layers.findIndex(function (l) { return l.id === layerId; });
      if (from === -1) return;
      var to = layerIndexAtY(ev.clientY);
      if (to === from) return;
      var layer = state.layers[from];
      state.layers.splice(from, 1);
      state.layers.splice(to, 0, layer);
      layerDragId = layerId;
      renderLane();
    }
    function onUp(ev) {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      document.body.classList.remove('dragging-layer');
      layerDragId = null;
      renderLane();
      renderPreview();
      renderFilmstrip();
      save();
    }
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
  }

  function renderAssets() {
    var imgs = state.assets;
    // Skip the DOM rebuild when the library is unchanged.
    if (imgs.length === assetCache.length && imgs.every(function (a) { return assetImgs.has(a.img); })) return;
    assetCache = imgs;
    assetImgs = new Set(imgs.map(function (a) { return a.img; }));
    el.assetGrid.innerHTML = '';
    if (!imgs.length) {
      var empty = document.createElement('div');
      empty.className = 'asset-empty';
      empty.textContent = 'No images yet. Add images with the button above, then drag them onto the timeline.';
      el.assetGrid.appendChild(empty);
      return;
    }
    imgs.forEach(function (a) {
      var tile = document.createElement('div');
      tile.className = 'asset';
      tile.title = 'Drag onto the timeline to place a keyframe';
      var img = document.createElement('img');
      img.src = a.img;
      img.alt = a.name || 'asset';
      tile.appendChild(img);
      var name = document.createElement('span');
      name.className = 'asset-name';
      name.textContent = a.name || 'image';
      name.title = a.name || 'image';
      tile.appendChild(name);
      tile.addEventListener('pointerdown', function (e) { startAssetPointerDrag(e, a); });
      el.assetGrid.appendChild(tile);
    });
  }

  function selectGap(id) {
    state.selectedGapId = id || null;
    state.selectedId = null;
    renderSelectedPanel();
    renderLane();
  }

  // Set the interpolation type of one gap. The gap's frames are dropped (the
  // stamp includes the mode, so they would be stale anyway) and it is
  // regenerated with the new mode; 'none' gaps have no inbetweens at all.
  function setGapType(id, type) {
    if (['ai', 'squash', 'none'].indexOf(type) === -1) return;
    state.gapType[id] = type;
    delete state.generated[id];
    delete state.gapMeta[id];
    refreshDirty();
    renderAll();
    save();
    scheduleGenerate(50);
  }

  function applySquashChange(patch) {
    var id = state.selectedGapId;
    if (!id) return;
    setGapSquash(id, patch);
    delete state.generated[id];
    delete state.gapMeta[id];
    refreshDirty();
    renderSelectedPanel();
    renderLane();
    save();
    scheduleGenerate(50);
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
    renderLayerPanel();
    renderAssets();
    updateTransport();
    updateEstimate();
    el.btnKeysOnly.classList.toggle('active', state.keysOnly);
  }

  function updateEstimate() {
    var total = 0, gapCount = 0;
    allGaps().forEach(function (g) {
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

  // Add files to the image library only — nothing is placed on the timeline.
  // Keyframes are created by dragging an asset from the panel onto the
  // timeline (see addAssetKeyframe).
  function addImageFiles(files) {
    if (!files || !files.length) return Promise.resolve(0);
    var chain = Promise.resolve();
    var added = 0;
    Array.prototype.forEach.call(files, function (file) {
      chain = chain.then(function () {
        return readImageFile(file).then(function (data) {
          if (state.assets.some(function (a) { return a.img === data.img; })) return;
          state.assets.push({ img: data.img, name: data.name, w: data.w, h: data.h });
          added++;
        });
      });
    });
    return chain.then(function () {
      renderAssets();
      save();
      return added;
    });
  }
  // Place a keyframe reusing an image already in the library (asset drag & drop).
  // The image is already decoded, so unlike addImageFiles there is no file read.
  function addAssetKeyframe(imgSrc, atTime) {
    var meta = null;
    for (var i = 0; i < assetCache.length; i++) {
      if (assetCache[i].img === imgSrc) { meta = assetCache[i]; break; }
    }
    state.keyframes.push({
      id: 'k' + (idSeq++),
      layer: state.activeLayerId || state.layers[0].id,
      time: insertTime(atTime),
      img: imgSrc,
      name: meta ? meta.name : 'asset',
      w: meta ? meta.w : workW,
      h: meta ? meta.h : workH
    });
    applyWorkSize();
    invalidateAll();
    renderAll();
    save();
    scheduleGenerate();
  }

  function selectKeyframe(id) {
    state.selectedId = id;
    state.selectedGapId = null;
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

  // Turn a composite playback frame into a keyframe on the active layer. The
  // gap it falls in (on that layer) is split and its generated frames re-keyed
  // into the two new gaps, exactly like the single-layer flow.
  function promoteToKeyframe(f) {
    var layerId = state.activeLayerId || state.layers[0].id;
    var oldGap = null;
    computeGaps(layerId).forEach(function (g) {
      if (f.time > g.from.time && f.time < g.to.time) oldGap = g;
    });
    var oldGen = oldGap ? state.generated[oldGap.id] : null;
    if (oldGap) delete state.generated[oldGap.id];
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
      if (oldGen) {
        computeGaps(layerId).forEach(function (g) {
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
    });
  }

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

  // Generation — runs in the background worker; only missing frames are
  // generated, and auto-runs (debounced) after every change.

  function drawImageToData(img, w, h) {
    var canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext('2d');
    // Clear transparent instead of painting black, so keyframes that carry an
    // alpha channel (cut-out characters, overlays) keep their transparency
    // through interpolation and composite over lower layers.
    ctx.clearRect(0, 0, w, h);
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
  // available; otherwise runs inline (mesh warp fallback path). Color gaps
  // dispatch one worker job per frame so the optical flow never blocks the UI.
  function generateGap(gap, missing, cbs) {
    var missingList = missing.map(function (idx) {
      return { idx: idx, t: idx / (gap.genCount + 1) };
    });
    if (gap.mode === 'color') return generateColorGap(gap, missingList, cbs);
    return Promise.all([loadImage(gap.from.img), loadImage(gap.to.img)]).then(function (imgs) {
      if (cbs.cancelled()) return;
      var aData = drawImageToData(imgs[0], workW, workH);
      var bData = drawImageToData(imgs[1], workW, workH);
      if (workers.length) {
        var jobId = 'job' + (++jobSeq);
        var wi = pickWorker();
        return new Promise(function (resolve, reject) {
          workerJobs[jobId] = {
            resolve: resolve,
            reject: reject,
            onFrame: cbs.onFrame,
            onProgress: cbs.onProgress,
            worker: workers[wi]
          };
          workerBusy[wi]++;
          var aBuf = aData.buffer, bBuf = bData.buffer;
          workers[wi].postMessage({
            type: 'generate-gap',
            jobId: jobId,
            aData: aBuf, bData: bBuf,
            width: workW, height: workH,
            fromTime: gap.fromTime, toTime: gap.toTime,
            mode: gap.mode,
            squash: gapSquashOpts(gap.id),
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

  // Color-layer generation. The color keyframe's pass is a colored version of
  // the layer directly beneath (the source) at the keyframe's time. Each
  // generated frame warps the pass along the source layer's motion (flow from
  // its frame at the pass time to its frame at the inbetween time), so the
  // colors follow the line art instead of sitting still. When the source
  // frame is unchanged the pass is reused as-is.
  function generateColorGap(gap, missingList, cbs) {
    var colorLayer = layerById(gap.layer);
    var srcLayer = state.layers[state.layers.indexOf(colorLayer) + 1];
    if (!srcLayer) return Promise.resolve();
    var passImg = gap.from.img;
    var passFrame = layerFrameAt(srcLayer.id, gap.from.time, false);
    if (!passFrame) return Promise.resolve();
    // Frame times are the source layer's content changes inside the gap, not
    // even spacing — a held source yields no frames at all.
    var times = colorFrameTimes(gap);
    return Promise.all([loadImage(passImg), loadImage(passFrame.img)]).then(function (imgs) {
      if (cbs.cancelled()) return;
      var passData = drawImageToData(imgs[0], workW, workH);
      var aData = drawImageToData(imgs[1], workW, workH);
      var i = 0;
      var next = function () {
        if (cbs.cancelled() || i >= missingList.length) return Promise.resolve();
        var m = missingList[i++];
        var time = (m.idx >= 1 && m.idx <= times.length) ? times[m.idx - 1] : gap.toTime;
        var srcFrame = layerFrameAt(srcLayer.id, time, false);
        if (!srcFrame) return next();
        var done = function (img) {
          cbs.onFrame({ idx: m.idx, t: m.t, time: time, img: img, ai: false });
          if (cbs.onProgress) cbs.onProgress('color frame ' + m.idx + '/' + gap.genCount, i / missingList.length);
        };
        if (srcFrame.img === passFrame.img) { done(passImg); return next(); }
        return loadImage(srcFrame.img).then(function (img) {
          if (cbs.cancelled()) return;
          var bData = drawImageToData(img, workW, workH);
          if (!workers.length) {
            // Inline fallback (no worker): the flow pass blocks the main thread
            // here, matching the mesh-warp fallback for normal gaps.
            return morph.computeFlowBoth(aData, bData, workW, workH, {}, null, cbs.cancelled).then(function (pair) {
              if (cbs.cancelled()) return;
              var warped = morph.warpFrame(passData, pair.flowAB, workW, workH, 2);
              morph.gateFill(warped, bData, workW, workH);
              done(dataToDataURL(warped, workW, workH));
            }).then(next);
          }
          // One worker job per frame: the worker computes the optical flow and
          // warps the pass off the main thread, so long color spans never
          // freeze the UI.
          var jobId = 'job' + (++jobSeq);
          var wi = pickWorker();
          return new Promise(function (resolve, reject) {
            workerJobs[jobId] = {
              resolve: resolve,
              reject: reject,
              onFrame: function (fr) { done(fr.img); },
              onProgress: cbs.onProgress,
              worker: workers[wi]
            };
            workerBusy[wi]++;
            workers[wi].postMessage({
              type: 'color-frame',
              jobId: jobId,
              passData: passData, aData: aData, bData: bData,
              width: workW, height: workH,
              idx: m.idx, t: m.t, time: time
            });
          }).catch(function (err) {
            // Worker died mid-frame: fall back to the inline warp for this
            // frame instead of failing the whole color gap. A cancelled run
            // is not an error — let it end.
            if (cbs.cancelled()) throw err;
            console.error('Color worker job failed, warping inline:', err);
            return morph.computeFlowBoth(aData, bData, workW, workH, {}, null, cbs.cancelled).then(function (pair) {
              if (cbs.cancelled()) return;
              var warped = morph.warpFrame(passData, pair.flowAB, workW, workH, 2);
              morph.gateFill(warped, bData, workW, workH);
              done(dataToDataURL(warped, workW, workH));
            });
          }).then(next);
        }).then(next);
      };
      return next();
    });
  }

  function generateGapInline(aData, bData, gap, missingList, cbs) {
    var meshes = null;
    var flowPromise = null;
    // Flow is only needed for the mesh fallback and the alpha warp. When the
    // AI model works and the keyframes are fully opaque (the common case)
    // neither is used, so compute it lazily on first actual need.
    var opaque = morph.isOpaque(aData) && morph.isOpaque(bData);
    var ensureMeshes = function () {
      if (meshes) return Promise.resolve();
      if (flowPromise) return flowPromise;
      if (cbs.onProgress) cbs.onProgress('Preparing interpolation…', 0);
      flowPromise = morph.computeFlowBoth(aData, bData, workW, workH, {}, function (frac) {
        if (cbs.onProgress) cbs.onProgress('Preparing interpolation…', frac * 0.05);
      }, cbs.cancelled).then(function (pair) {
        if (cbs.cancelled()) return;
        meshes = morph.buildMeshes(pair, workW, workH, 16);
      });
      return flowPromise;
    };
    var emit = function (m) {
      if (cbs.cancelled()) return Promise.resolve();
      var t = m.t;
      var time = gap.fromTime + (gap.toTime - gap.fromTime) * t;
      var done = function (rgba, ai) {
        cbs.onFrame({ idx: m.idx, t: t, time: time, img: dataToDataURL(rgba, workW, workH), ai: ai });
      };
      // Squash: affine squash-and-stretch along the detected motion
      // direction, pivoted on the moving mass (no mesh warp, no crossfade).
      if (gap.mode === 'squash') {
        return ensureMeshes().then(function () {
          done(morph.squashStretchFrame(aData, bData, meshes, workW, workH, t, gapSquashOpts(gap.id)), false);
        });
      }
      // RIFE renders RGB with alpha 255; give the frame the mesh-warped alpha so
      // transparent keyframes (cut-out characters) stay transparent in inbetweens.
      // Fully opaque keyframes skip this entirely — the result is byte-identical
      // and a full mesh warp per frame is avoided.
      var applyAlpha = function (rgba) {
        var alpha = morph.warpAlpha(aData, bData, meshes, workW, workH, t);
        var n = workW * workH;
        for (var p = 0, q = 0; p < n; p++, q += 4) rgba[q + 3] = alpha[p];
      };
      if (cbs.aiReady()) {
        return model.interpolate(aData, bData, workW, workH, t).then(function (aiOut) {
          if (cbs.cancelled()) return;
          if (opaque) { done(aiOut, true); return; }
          return ensureMeshes().then(function () {
            if (cbs.cancelled()) return;
            applyAlpha(aiOut);
            done(aiOut, true);
          });
        }).catch(function (err) {
          if (cbs.cancelled()) return;
          console.error('AI inbetween failed, using mesh warp:', err);
          return ensureMeshes().then(function () {
            done(morph.morphFrameMesh(aData, bData, meshes, workW, workH, t), false);
          });
        });
      }
      return ensureMeshes().then(function () {
        done(morph.morphFrameMesh(aData, bData, meshes, workW, workH, t), false);
      });
    };
    var i = 0;
    var next = function () {
      if (cbs.cancelled() || i >= missingList.length) return Promise.resolve();
      var m = missingList[i];
      var label = (gap.mode === 'squash' ? 'squash frame ' : (cbs.aiReady() ? 'AI inbetween ' : 'mesh warp ')) + m.idx + '/' + gap.genCount;
      i++;
      return emit(m).then(function () {
        if (cbs.onProgress) cbs.onProgress(label, i / missingList.length);
        return new Promise(function (r) { setTimeout(r, 0); }).then(next);
      });
    };
    return next();
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
      workers.forEach(function (w) {
        try { w.postMessage({ type: 'cancel' }); } catch (e) {}
      });
    }
  }

  function runGeneration() {
    if (state.genRun) return;
    // Collect gaps bottom-first so a color layer's source layer (directly under
    // it) generates its frames before the color warp runs on top of them.
    var gaps = [];
    for (var li = state.layers.length - 1; li >= 0; li--) {
      computeGaps(state.layers[li].id).forEach(function (g) {
        if (g.genCount > 0 && !gapComplete(g)) gaps.push(g);
      });
    }
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
    var concurrency = Math.min(4, Math.max(1, workers.length || 1));
    var idx = 0, active = 0, firstErr = null;
    var generateOne = function (gap, gi) {
      if (run.cancelled) return Promise.resolve();
      var missing = computeMissing(gap);
      if (!missing.length) return Promise.resolve();
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
    };
    // Run up to `concurrency` gaps at once (one per worker) instead of one big
    // chain, so idle cores keep busy while a slow gap is generating.
    var completion = new Promise(function (resolve, reject) {
      function pump() {
        if (run.cancelled || firstErr) idx = gaps.length; // stop after cancel/error
        while (!run.cancelled && !firstErr && active < concurrency && idx < gaps.length) {
          var gap = gaps[idx], gi = idx;
          idx++;
          active++;
          generateOne(gap, gi).then(function () {
            active--;
            pump();
          }, function (err) {
            active--;
            if (!firstErr) firstErr = err;
            pump();
          });
        }
        if (idx >= gaps.length && active === 0) {
          if (firstErr) reject(firstErr);
          else resolve();
        }
      }
      pump();
    });
    completion.then(function () {
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

  function downloadFrame(dataURL, name) {
    var a = document.createElement('a');
    a.href = dataURL;
    a.download = name || 'frame.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // minimal ZIP writer (store method, no compression)
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

  // Export resolution + AI upscaling

  // The available export resolutions: the working size itself, integer
  // multiples of it (AI upscale when > 1x), and common fixed short-edge
  // targets (720p/1080p/1440p/2160p/4K, matching the project's aspect).
  // The long edge is capped at 8K so exports stay within browser memory.
  function exportResolutionOptions() {
    var s = workingSize();
    var opts = [];
    opts.push({ w: s.w, h: s.h, label: 'Working size (' + s.w + '\u00d7' + s.h + ')', ai: false });
    [2, 4, 8].forEach(function (f) {
      var w = s.w * f, h = s.h * f;
      if (Math.max(w, h) > 8192) return;
      opts.push({ w: w, h: h, label: f + '\u00d7 (' + w + '\u00d7' + h + ')', ai: f > 1 });
    });
    var aspect = s.w / s.h;
    var shortEdge = Math.min(s.w, s.h);
    [720, 1080, 1440, 2160, 3840].forEach(function (t) {
      if (t <= shortEdge) return; // only offer sizes above the working size
      var w, h;
      if (aspect >= 1) { h = t; w = Math.round(t * aspect); }
      else { w = t; h = Math.round(t / aspect); }
      w = gridSnap(w); h = gridSnap(h);
      if (Math.max(w, h) > 8192) return;
      opts.push({ w: w, h: h, label: t + 'p (' + w + '\u00d7' + h + ')', ai: true });
    });
    return opts;
  }

  // Rebuild the resolution dropdown with the current working size. Keeps the
  // user's previous choice when it still exists (matched by dimensions, so a
  // working-size change that keeps the same option available keeps it picked).
  function populateExportRes() {
    var opts = exportResolutionOptions();
    var prevOpt = opts[parseInt(el.exportRes.value, 10) || 0] || null;
    el.exportRes.innerHTML = '';
    opts.forEach(function (o, i) {
      var opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = o.label + (o.ai ? ' \u00b7 AI upscale' : '');
      el.exportRes.appendChild(opt);
    });
    var keep = -1;
    if (prevOpt) {
      opts.forEach(function (o, i) {
        if (o.w === prevOpt.w && o.h === prevOpt.h) keep = i;
      });
    }
    el.exportRes.selectedIndex = keep >= 0 ? keep : 0;
  }

  // Upscale one composite canvas to the target size. When the target is larger
  // than the working size the AI upscaler (worker) runs first — a 4x ESRGAN-
  // style model — and the result is resized to the exact target with high-
  // quality smoothing. Falls back to a plain high-quality resize if the model
  // can't be loaded (offline / blocked), so exports never stall.
  var upscaleModelWarned = false;
  function upscaleCanvasTo(canvas, tw, th) {
    if (canvas.width === tw && canvas.height === th) return Promise.resolve(canvas);
    var bigger = tw > canvas.width || th > canvas.height;
    function drawScaled(src) {
      var c = document.createElement('canvas');
      c.width = tw; c.height = th;
      var ctx = c.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, tw, th);
      drawContain(ctx, src, tw, th);
      return c;
    }
    if (!bigger) return Promise.resolve(drawScaled(canvas));
    // Target is larger: try the AI upscaler first.
    if (workers.length) {
      return upscaleViaWorker(canvas).then(function (hi) {
        return drawScaled(hi);
      }).catch(function (err) {
        if (err && err.message === 'Cancelled') throw err;
        if (!upscaleModelWarned) {
          upscaleModelWarned = true;
          toast('AI upscaler unavailable (' + err.message + '), using high-quality resize');
        }
        return drawScaled(canvas);
      });
    }
    return Promise.resolve(drawScaled(canvas));
  }

  // Send one frame to the worker for AI 4x upscaling. Resolves with a canvas
  // at 4x the input size; the upscaler model downloads+compiles on first use
  // (progress reported through the export progress bar).
  function upscaleViaWorker(canvas) {
    return new Promise(function (resolve, reject) {
      var ctx = canvas.getContext('2d');
      var img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      var jobId = 'up' + (++jobSeq);
      upscaleJobs[jobId] = {
        resolve: function (r) { resolve(r); },
        reject: function (e) { reject(e); },
        onProgress: function (frac) {
          // The first job downloads the model; later jobs resolve instantly
          // and never report progress, so this only shows during download.
          if (frac >= 1) setExportProgress('Upscaler ready — rendering…', 95);
          else setExportProgress('Downloading AI upscaler ' + Math.round(frac * 100) + '%…', frac * 100);
        }
      };
      try {
        var wi = pickWorker();
        var target = workers[wi >= 0 ? wi : 0];
        target.postMessage({
          type: 'upscale',
          jobId: jobId,
          width: canvas.width,
          height: canvas.height,
          rgba: img.data.buffer
        }, [img.data.buffer]);
      } catch (err) {
        delete upscaleJobs[jobId];
        reject(err);
      }
    }).then(function (r) {
      // r = { data: ArrayBuffer, width, height } — build a canvas from it.
      var c = document.createElement('canvas');
      c.width = r.width; c.height = r.height;
      var cctx = c.getContext('2d');
      var id = cctx.createImageData(r.width, r.height);
      id.data.set(new Uint8ClampedArray(r.data));
      cctx.putImageData(id, 0, 0);
      return c;
    });
  }

  // Composite one playback frame and size it to the export target.
  function exportCanvas(f, target) {
    return compositeCanvas(f.time).then(function (c) {
      return upscaleCanvasTo(c, target.w, target.h);
    });
  }

  // Shared cancel state for export runs (PNG/GIF/frame chains). MP4 uses its
  // own recorder stop; both are routed from the same Stop button.
  function beginExport() {
    state.exporting = true;
    state.exportCancel = false;
  }
  function endExport() {
    state.exporting = false;
    state.exportCancel = false;
  }
  function cancelExport() {
    if (!state.exporting) return;
    state.exportCancel = true;
    workers.forEach(function (w) {
      try { w.postMessage({ type: 'cancel-upscale' }); } catch (e) {}
    });
  }

  // Export progress overlay (mirrors the launch model-loading overlay)
  function showExportOverlay(title, sub) {
    el.exportTitle.textContent = title;
    el.exportSub.textContent = sub || '';
    el.exportFill.style.width = '0%';
    el.exportLabel.textContent = '';
    el.exportMeta.textContent = '';
    el.exportOverlay.classList.remove('hidden');
  }
  function setExportProgress(label, pct) {
    el.exportFill.style.width = clamp(pct, 0, 100) + '%';
    el.exportLabel.textContent = label;
    el.exportMeta.textContent = Math.round(pct) + '%';
  }
  function hideExportOverlay() {
    el.exportOverlay.classList.add('hidden');
  }

  // Resolves once every generated frame is done: no active generation run, no
  // queued regeneration, and no incomplete gaps. If frames are still missing it
  // kicks off generation and waits, so an export never captures half-finished
  // inbetweens. Rejects with 'Export cancelled' if the user stops the wait.
  function waitForGeneration() {
    return new Promise(function (resolve, reject) {
      var tries = 0;
      (function check() {
        if (state.exportCancel) { reject(new Error('Export cancelled')); return; }
        var busy = state.genRun || state.pendingRegen;
        var incomplete = allGaps().filter(function (g) {
          return g.genCount > 0 && !gapComplete(g);
        }).length;
        if (!busy && incomplete === 0) { resolve(); return; }
        if (!busy && incomplete > 0) {
          // Nothing running but frames missing (e.g. after a cancel): start a
          // run so the export waits for a complete timeline.
          scheduleGenerate(50);
        }
        // Safety cap (~2 min) so a stuck state can't block exports forever.
        if (tries++ > 600) { resolve(); return; }
        setTimeout(check, 200);
      })();
    });
  }

  function exportPNGZip(target) {
    var frames = buildPlaybackFrames();
    if (!frames.length) { toast('Nothing to export.'); return; }
    setExportProgress('Building PNG sequence…', 1);
    var chain = Promise.resolve();
    var files = [];
    frames.forEach(function (f, i) {
      chain = chain.then(function () {
        if (state.exportCancel) throw new Error('Export cancelled');
        // Composite every layer at this frame's time (AI-upscaled to target).
        return exportCanvas(f, target).then(function (canvas) {
          return new Promise(function (resolve) { canvas.toBlob(resolve, 'image/png'); });
        }).then(function (blob) {
          return blob.arrayBuffer();
        }).then(function (buf) {
          files.push({ name: 'frame_' + pad(i + 1, 4) + '.png', data: new Uint8Array(buf) });
          setExportProgress('Rendering ' + (i + 1) + '/' + frames.length, ((i + 1) / frames.length) * 100);
        });
      });
    });
    chain.then(function () {
      if (state.exportCancel) throw new Error('Export cancelled');
      var zip = makeZip(files);
      downloadBlob(zip, 'animation-frames.zip', 'application/zip');
      hideExportOverlay();
      endExport();
      setGenStatus('ready', 'PNG sequence exported \u2713');
    }).catch(function (err) {
      endExport();
      hideExportOverlay();
      setGenStatus('error', 'Export failed: ' + err.message);
    });
  }

  function exportGIF(target) {
    var frames = buildPlaybackFrames();
    if (!frames.length) { toast('Nothing to export.'); return; }
    if (!gifenc) { toast('GIF encoder not available.'); return; }
    setExportProgress('Encoding GIF…', 1);
    var gif = gifenc.GIFEncoder();
    // Each frame holds for its real timeline duration (holds + gap spacing),
    // exactly like playback. gifenc takes delay in ms and quantizes to 10ms.
    var durs = playbackDurations(frames);
    var chain = Promise.resolve();
    frames.forEach(function (f, i) {
      chain = chain.then(function () {
        if (state.exportCancel) throw new Error('Export cancelled');
        return exportCanvas(f, target).then(function (canvas) {
          return canvas.getContext('2d').getImageData(0, 0, target.w, target.h).data;
        }).then(function (rgba) {
          var palette = gifenc.quantize(rgba, 256);
          var index = gifenc.applyPalette(rgba, palette);
          gif.writeFrame(index, target.w, target.h, { delay: Math.round(durs[i] * 1000), palette: palette });
          setExportProgress('Quantizing ' + (i + 1) + '/' + frames.length, ((i + 1) / frames.length) * 100);
        });
      });
    });
    chain.then(function () {
      if (state.exportCancel) throw new Error('Export cancelled');
      gif.finish();
      downloadBlob(new Blob([gif.bytes()], { type: 'image/gif' }), 'animation.gif');
      hideExportOverlay();
      endExport();
      setGenStatus('ready', 'GIF exported \u2713');
    }).catch(function (err) {
      endExport();
      hideExportOverlay();
      setGenStatus('error', 'GIF export failed: ' + err.message);
    });
  }

  // MP4 export (WebCodecs primary, MediaRecorder fallback)
  // MediaRecorder H.264 is known to silently produce empty recordings for very
  // large (4K-class) canvases, so for big targets prefer WebM/VP9, which
  // handles large frames reliably.
  function pickVideoMime(large) {
    if (typeof window.MediaRecorder === 'undefined') return null;
    var candidates = large
      ? ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
      : ['video/mp4;codecs=avc1.42E01E', 'video/mp4;codecs=avc1.64001f', 'video/mp4',
         'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
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

  function exportMP4(target) {
    var frames = buildPlaybackFrames();
    if (!frames.length) { toast('Nothing to export.'); return; }
    // WebCodecs encodes each frame as it's produced (composite → AI-upscale →
    // encode → discard), so only one frame is in memory at a time — no matter
    // how large the export resolution is. It also handles 4K+ frames that
    // Chrome's MediaRecorder H.264 silently fails on. MediaRecorder is kept as
    // a fallback for browsers without WebCodecs.
    if (window.VideoEncoder && window.Mp4Muxer) {
      exportMP4WebCodecs(frames, target);
      return;
    }
    exportMP4Recorder(frames, target);
  }

  // Pick the first codec the browser's VideoEncoder supports at this
  // resolution, preferring H.264 (most compatible), then VP9, then AV1 — all
  // of which mp4-muxer can put in an MP4 container. Chrome's H.264 encoder
  // often doesn't support 4096-wide frames, so VP9/AV1 matter for 8x exports.
  // Resolves with { codec, muxerCodec } or null if none are supported.
  function pickVideoCodec(w, h) {
    var avcLevels = ['640033', '64002a', '640028', '64001f', '42001f', '42E01E'];
    var candidates = avcLevels.map(function (l) { return { codec: 'avc1.' + l, muxerCodec: 'avc' }; })
      .concat([
        { codec: 'vp09.00.10.08', muxerCodec: 'vp9' },
        { codec: 'vp09.00.41.08', muxerCodec: 'vp9' },
        { codec: 'av01.0.04M.08', muxerCodec: 'av1' }
      ]);
    var i = 0;
    function next() {
      if (i >= candidates.length) return Promise.resolve(null);
      var c = candidates[i++];
      if (typeof VideoEncoder.isConfigSupported !== 'function') {
        return Promise.resolve(c);
      }
      return VideoEncoder.isConfigSupported({ codec: c.codec, width: w, height: h, bitrate: 10 * 1000 * 1000 })
        .then(function (r) { return r && r.supported ? c : next(); })
        .catch(next);
    }
    return next();
  }

  // Encode the animation with WebCodecs + mp4-muxer: each frame is composited,
  // AI-upscaled to the target size, encoded, and immediately discarded — so
  // even 8x exports never hold more than one frame in memory. Timestamps come
  // from each frame's real duration (holds + gap spacing), matching playback.
  function exportMP4WebCodecs(frames, target) {
    var durs = playbackDurations(frames);
    var memMB = Math.round(target.w * target.h * 4 / (1024 * 1024)); // one frame at a time
    if (memMB > 256) toast('One 4K-class frame is large; encoding may use ~' + memMB + ' MB.', 6000);
    setExportProgress('Encoding MP4…', 1);
    pickVideoCodec(target.w, target.h).then(function (pick) {
      if (!pick) {
        // No WebCodecs encoder at all for this size: last-resort MediaRecorder.
        exportMP4Recorder(frames, target);
        return;
      }
      var isAvc = pick.muxerCodec === 'avc';
      var muxer = new window.Mp4Muxer.Muxer({
        target: new window.Mp4Muxer.ArrayBufferTarget(),
        video: { codec: pick.muxerCodec, width: target.w, height: target.h, frameRate: Math.max(1, state.fps) },
        fastStart: 'in-memory'
      });
      var encodeError = null;
      var encoder = new VideoEncoder({
        output: function (chunk, meta) {
          // mp4-muxer needs a colorSpace in the decoder config (VP9/AV1 in
          // particular); some encoders omit it, so supply a sane default.
          if (meta && meta.decoderConfig && !meta.decoderConfig.colorSpace) {
            meta.decoderConfig.colorSpace = { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false };
          }
          muxer.addVideoChunk(chunk, meta);
        },
        error: function (e) { encodeError = e; }
      });
      encoder.configure({ codec: pick.codec, width: target.w, height: target.h, bitrate: 10 * 1000 * 1000 });

      var ts = 0; // microseconds
      var chain = Promise.resolve();
      frames.forEach(function (f, i) {
        chain = chain.then(function () {
          if (state.exportCancel) throw new Error('Export cancelled');
          if (encodeError) throw encodeError;
          return exportCanvas(f, target).then(function (canvas) {
            var frame = new VideoFrame(canvas, { timestamp: ts });
            encoder.encode(frame, { keyFrame: i % (Math.max(1, state.fps) * 2) === 0 });
            frame.close();
            ts += Math.round(durs[i] * 1e6);
            setExportProgress('Encoding frame ' + (i + 1) + '/' + frames.length, ((i + 1) / frames.length) * 100);
          });
        });
      });
      chain.then(function () {
        if (state.exportCancel) throw new Error('Export cancelled');
        return encoder.flush();
      }).then(function () {
        if (encodeError) throw encodeError;
        muxer.finalize();
        var buf = muxer.target.buffer;
        if (!buf || !buf.byteLength) throw new Error('Encoding produced no data');
        downloadBlob(new Blob([buf], { type: 'video/mp4' }), 'animation.mp4');
        hideExportOverlay();
        endExport();
        setGenStatus('ready', 'MP4 exported \u2713');
      }).catch(function (err) {
        try { encoder.close(); } catch (e2) {}
        endExport();
        hideExportOverlay();
        if (err && err.message === 'Export cancelled') setGenStatus('error', 'Export cancelled');
        else setGenStatus('error', 'MP4 export failed: ' + err.message);
      });
    }).catch(function (err) {
      endExport();
      hideExportOverlay();
      setGenStatus('error', 'MP4 export failed: ' + err.message);
    });
  }

  // Fallback: MediaRecorder canvas capture (browsers without WebCodecs).
  function exportMP4Recorder(frames, target) {
    var large = target.w * target.h > 1920 * 1080; // H.264 MediaRecorder is fragile at 4K+
    var mime = pickVideoMime(large);
    if (!mime) {
      hideExportOverlay();
      endExport();
      setGenStatus('error', 'Video recording is not supported in this browser.');
      toast('This browser cannot record video. Use Chrome, Edge or Safari for MP4 export.');
      return;
    }
    var isMp4 = mime.indexOf('mp4') !== -1;
    var canvas = document.createElement('canvas');
    canvas.width = target.w;
    canvas.height = target.h;
    var ctx = canvas.getContext('2d');
    if (typeof canvas.captureStream !== 'function') {
      hideExportOverlay();
      endExport();
      setGenStatus('error', 'This browser cannot capture canvas video.');
      toast('Canvas video capture is not supported here.');
      return;
    }
    // High-res exports hold every frame in memory while recording; warn when
    // that gets heavy so the user can pick a lower resolution if they want.
    var memMB = Math.round(target.w * target.h * 4 * frames.length / (1024 * 1024));
    if (memMB > 512) toast('This export may use ~' + memMB + ' MB of memory. A lower resolution is faster.', 7000);

    setExportProgress(isMp4 ? 'Recording MP4…' : 'Recording video…', 1);

    // Composite (and AI-upscale) every layer per frame time, then record.
    // Frames are rendered one at a time (the worker runs one upscale job at a
    // time), so a long high-res export streams through the progress bar.
    var rendered = null;
    var chain = Promise.resolve();
    var canvases = [];
    frames.forEach(function (f, i) {
      chain = chain.then(function () {
        if (state.exportCancel) throw new Error('Export cancelled');
        return exportCanvas(f, target).then(function (c) {
          canvases.push(c);
          setExportProgress('Upscaling frame ' + (i + 1) + '/' + frames.length, ((i + 1) / frames.length) * 90);
        });
      });
    });
    chain.then(function () {
      if (state.exportCancel) throw new Error('Export cancelled');
      rendered = canvases;
      // captureStream(0) + requestFrame() delivers each drawn frame to the
      // recorder explicitly. The old rAF-driven approach let captureStream
      // sample the canvas passively, which produced empty recordings when the
      // frame loop was throttled (long upscale pre-render, background tab) or
      // the canvas was large. With requestFrame the recording is deterministic.
      var stream = canvas.captureStream(0);
      var track = stream.getVideoTracks && stream.getVideoTracks()[0];
      var useRequestFrame = !!(track && typeof track.requestFrame === 'function');
      var recorder;
      try {
        recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 10 * 1000 * 1000 });
      } catch (e) {
        endExport();
        hideExportOverlay();
        setGenStatus('error', 'Could not start recorder: ' + e.message);
        toast('Recorder failed: ' + e.message);
        return;
      }
      var chunks = [];
      var stopped = false;
      var aborted = false;
      recorder.ondataavailable = function (e) {
        if (e.data && e.data.size) chunks.push(e.data);
      };
      recorder.onstop = function () {
        if (stopped) return;
        stopped = true;
        endExport();
        hideExportOverlay();
        if (aborted) {
          setGenStatus('error', 'Export cancelled');
          return;
        }
        var blob = new Blob(chunks, { type: isMp4 ? 'video/mp4' : mime });
        if (!blob.size) {
          setGenStatus('error', 'Recording produced no data. Try again.');
          return;
        }
        downloadBlob(blob, isMp4 ? 'animation.mp4' : 'animation.webm', blob.type);
        setGenStatus('ready', isMp4
          ? 'MP4 exported \u2713'
          : 'Saved as WebM. This browser cannot mux MP4 (Chrome, Edge or Safari can). \u2713');
      };
      recorder.onerror = function () {
        endExport();
        hideExportOverlay();
        setGenStatus('error', 'Recording failed.');
      };
      state.mp4Stop = function () {
        try { recorder.stop(); } catch (e) {}
      };

      var durs = playbackDurations(frames);
      var finished = false;
      recorder.start();
      if (useRequestFrame) {
        // Draw each frame once, push it to the recorder with requestFrame,
        // hold for its real duration, then free its bitmap. setTimeout keeps
        // running even if the tab is backgrounded, so the recording always
        // produces data instead of silently capturing nothing.
        var cur = 0;
        function recordNext() {
          if (finished) return;
          if (state.exportCancel) {
            finished = true;
            aborted = true;
            state.mp4Stop();
            state.mp4Stop = null;
            return;
          }
          if (cur >= frames.length) {
            finished = true;
            setTimeout(function () { state.mp4Stop(); state.mp4Stop = null; }, 200);
            return;
          }
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, target.w, target.h);
          ctx.drawImage(rendered[cur], 0, 0, target.w, target.h);
          track.requestFrame();
          setExportProgress('Recording frame ' + (cur + 1) + '/' + frames.length, 90 + ((cur + 1) / frames.length) * 10);
          rendered[cur] = null; // free the frame bitmap now that it's captured
          var hold = Math.max(10, Math.round(durs[cur] * 1000));
          cur++;
          setTimeout(recordNext, hold);
        }
        setTimeout(recordNext, 300); // small delay so the recorder is ready
      } else {
        // Fallback (browsers without requestFrame): paint the canvas every
        // animation frame and let captureStream sample it at the project FPS.
        var totalDur = 0;
        durs.forEach(function (d) { totalDur += d; });
        var t0 = performance.now() + 300;
        var idx = -1;
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
            ctx.fillRect(0, 0, target.w, target.h);
            // Canvases are already at target size; draw full-bleed (aspect is
            // preserved by the upscale pipeline, so no letterboxing needed).
            ctx.drawImage(rendered[idx], 0, 0, target.w, target.h);
            setExportProgress('Recording frame ' + (idx + 1) + '/' + frames.length, 90 + ((idx + 1) / frames.length) * 10);
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
      }
      }).catch(function (err) {
        endExport();
        hideExportOverlay();
        if (err && err.message === 'Export cancelled') {
          if (state.mp4Stop) { state.mp4Stop(); state.mp4Stop = null; }
          setGenStatus('error', 'Export cancelled');
        } else {
          setGenStatus('error', 'Export failed: ' + err.message);
        }
      });
  }

  function exportCurrentFrame(target) {
    if (!buildPlaybackFrames().length) { toast('Nothing to export.'); return; }
    setExportProgress('Exporting frame…', 5);
    exportCanvas({ time: state.playhead }, target).then(function (canvas) {
      return new Promise(function (resolve) { canvas.toBlob(resolve, 'image/png'); });
    }).then(function (blob) {
      var url = URL.createObjectURL(blob);
      downloadFrame(url, 'frame_' + pad(state.curIndex + 1, 4) + '.png');
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      hideExportOverlay();
      endExport();
      setGenStatus('ready', 'Frame exported \u2713');
    }).catch(function (err) {
      endExport();
      hideExportOverlay();
      setGenStatus('error', 'Export failed: ' + err.message);
    });
  }

  // Shared entry point: run the selected format at the selected resolution.
  // Shows the export overlay, waits for generation to finish (so the export
  // never captures half-finished inbetweens), then dispatches.
  function runExport() {
    var fmt = el.exportFormat.value;
    var opts = exportResolutionOptions();
    var idx = parseInt(el.exportRes.value, 10) || 0;
    var opt = opts[idx] || opts[0];
    var target = { w: opt.w, h: opt.h };
    // Fail fast before the overlay goes up so it can't get stuck.
    if (!buildPlaybackFrames().length) { toast('Nothing to export.'); return; }
    if (fmt === 'gif' && !gifenc) { toast('GIF encoder not available.'); return; }
    closeMenus();
    beginExport();
    showExportOverlay(
      fmt === 'frame' ? 'Exporting current frame' : 'Exporting ' + fmt.toUpperCase(),
      opt.label + (opt.ai ? ' \u00b7 AI upscale' : '')
    );
    setExportProgress('Waiting for frames to finish generating…', 0);
    waitForGeneration().then(function () {
      if (state.exportCancel) throw new Error('Export cancelled');
      if (fmt === 'png') exportPNGZip(target);
      else if (fmt === 'gif') exportGIF(target);
      else if (fmt === 'mp4') exportMP4(target);
      else exportCurrentFrame(target);
    }).catch(function (err) {
      endExport();
      hideExportOverlay();
      var cancelled = err && err.message === 'Export cancelled';
      setGenStatus('error', cancelled ? 'Export cancelled' : 'Export failed: ' + err.message);
    });
  }

  function timeFromClientX(clientX) {
    var rect = el.timeline.getBoundingClientRect();
    var x = clientX - rect.left + el.timeline.scrollLeft - GUTTER_W;
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
      // No clamping against neighbours: a keyframe can be dragged in front of
      // or behind other keyframes. Gaps are always derived from the time-sorted
      // order, so crossing simply reorders the sequence and everything follows.
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
      // Don't push the hold past the next keyframe's start (on this layer).
      var sorted = sortedKeyframes(kf.layer);
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

  function projectData() {
    return {
      v: 7,
      settings: {
        fps: state.fps, snap: state.snap, zoom: state.zoom,
        res: state.res, keysOnly: state.keysOnly,
        aspect: state.aspect, customW: state.customW, customH: state.customH
      },
      layers: state.layers.map(function (l) {
        return { id: l.id, name: l.name, visible: l.visible, type: l.type === 'color' ? 'color' : 'normal' };
      }),
      activeLayerId: state.activeLayerId,
      assets: state.assets.map(function (a) {
        return { img: a.img, name: a.name, w: a.w, h: a.h };
      }),
      keyframes: state.keyframes.map(function (k) {
        return { id: k.id, layer: k.layer, time: k.time, hold: keyframeHold(k), img: k.img, name: k.name, w: k.w, h: k.h };
      }),
      generated: state.generated,
      gapMeta: state.gapMeta,
      gapType: state.gapType,
      gapSquash: state.gapSquash
    };
  }

  var storageQuotaWarned = false; // one-time notice when auto-save drops frames
  function writeStorage() {
    var data = projectData();
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(data));
    } catch (e) {
      try {
        // Project (with its generated-frame data URLs) is too big for
        // localStorage: save everything except the frames so the session still
        // works, and tell the user once that frames won't survive a reload.
        delete data.generated;
        delete data.gapMeta;
        localStorage.setItem(STORE_KEY, JSON.stringify(data));
        if (!storageQuotaWarned) {
          storageQuotaWarned = true;
          toast('Project too large for auto-save \u2014 generated frames won\u2019t persist across reloads. Use Save project (.ijwta) to keep them.', 8000);
        }
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
    state.zoom = clamp(parseFloat(s.zoom) || 90, 12, 4000);
    state.res = [512, 448, 384, 320].indexOf(parseInt(s.res, 10)) >= 0 ? parseInt(s.res, 10) : 512;
    state.keysOnly = !!s.keysOnly;
    state.aspect = ['auto', '16:9', '9:16', '4:3', '3:4', '1:1', 'custom'].indexOf(s.aspect) >= 0 ? s.aspect : 'auto';
    state.customW = clamp(parseInt(s.customW, 10) || 1920, 8, 4096);
    state.customH = clamp(parseInt(s.customH, 10) || 1080, 8, 4096);
    // Layers: projects saved before layers existed are wrapped in one layer.
    var savedLayers = Array.isArray(data.layers) && data.layers.length ? data.layers : null;
    if (savedLayers) {
      state.layers = savedLayers.map(function (l) {
        return {
          id: l.id,
          name: l.name || 'Layer',
          visible: l.visible !== false,
          type: l.type === 'color' ? 'color' : 'normal'
        };
      });
      state.activeLayerId = state.layers.some(function (l) { return l.id === data.activeLayerId; })
        ? data.activeLayerId : state.layers[0].id;
    } else {
      state.layers = [{ id: 'L1', name: 'Layer 1', visible: true }];
      state.activeLayerId = 'L1';
    }
    layerSeq = state.layers.reduce(function (m, l) {
      var n = parseInt(String(l.id).replace(/\D/g, ''), 10);
      return Math.max(m, isFinite(n) ? n + 1 : 1);
    }, 1);
    state.keyframes = (data.keyframes || []).filter(function (k) { return k && k.img; }).map(function (k) {
      if (!k.layer || !state.layers.some(function (l) { return l.id === k.layer; })) k.layer = state.layers[0].id;
      return k;
    });
    state.generated = (data.generated && typeof data.generated === 'object') ? data.generated : {};
    state.gapMeta = (data.gapMeta && typeof data.gapMeta === 'object') ? data.gapMeta : {};
    state.gapType = (data.gapType && typeof data.gapType === 'object') ? data.gapType : {};
    state.gapSquash = (data.gapSquash && typeof data.gapSquash === 'object') ? data.gapSquash : {};
    // The image library: saved with the project (v5+), otherwise derived from
    // the keyframe images so older projects still show their images. Any
    // keyframe image missing from the library (e.g. promoted composites) is
    // added in keyframe order.
    state.assets = Array.isArray(data.assets)
      ? data.assets.filter(function (a) { return a && a.img; }).map(function (a) {
        return { img: a.img, name: a.name, w: a.w, h: a.h };
      })
      : [];
    state.keyframes.forEach(function (k) {
      if (!k.img || state.assets.some(function (a) { return a.img === k.img; })) return;
      state.assets.push({ img: k.img, name: k.name, w: k.w, h: k.h });
    });
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
    restoringProject = true;
    try {
      applyProjectData(data);
      applyWorkSize();
    } finally {
      restoringProject = false;
    }
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
        restoringProject = true;
        try {
          applyProjectData(data);
          state.selectedId = null;
          state.playhead = 0;
          state.curIndex = 0;
          pause();
          applyWorkSize();
        } finally {
          restoringProject = false;
        }
        refreshDirty();
        renderAll();
        syncInputs();
        save();
        // Frames saved in the file are reused when valid (same stamps);
        // anything invalidated by the load (different endpoint images, a
        // different frame count) is regenerated automatically.
        scheduleGenerate(100);
        toast('Project loaded');
      } catch (e) {
        toast('Could not load project file. Choose an .ijwta file saved from this app.');
      }
    };
    reader.readAsText(file);
  }

  function wireEvents() {
    el.btnAddAssets.addEventListener('click', function () { el.fileInput.click(); });
    byId('btnEmptyAdd').addEventListener('click', function () { el.fileInput.click(); });
    // Loading images only fills the library; place keyframes by dragging an
    // asset from the panel onto the timeline.
    function libraryToast(n) {
      if (n > 0) toast(n + (n === 1 ? ' image added to your library' : ' images added to your library'));
    }
    el.fileInput.addEventListener('change', function () {
      if (el.fileInput.files && el.fileInput.files.length) {
        addImageFiles(el.fileInput.files).then(libraryToast).catch(function (e) { toast(e.message); });
      }
      el.fileInput.value = '';
    });
    el.btnReplace.addEventListener('click', function () {
      if (state.selectedId) replaceKeyframeImage(state.selectedId);
    });
    el.btnDelete.addEventListener('click', function () {
      if (state.selectedId) deleteKeyframe(state.selectedId);
    });
    el.gapTypeInput.addEventListener('change', function () {
      if (state.selectedGapId) setGapType(state.selectedGapId, el.gapTypeInput.value);
    });
    var squashDebounce = null;
    el.gapSquashAmount.addEventListener('input', function () {
      var v = parseFloat(el.gapSquashAmount.value);
      if (!isFinite(v)) return;
      el.gapSquashValue.textContent = Math.round(v * 100) + '%';
      el.gapSquashValue.classList.remove('is-auto');
      el.gapSquashAmount.title = Math.round(v * 100) + '%';
      el.gapSquashAuto.disabled = false;
      clearTimeout(squashDebounce);
      squashDebounce = setTimeout(function () { applySquashChange({ amount: v }); }, 160);
    });
    el.gapSquashAmount.addEventListener('change', function () {
      clearTimeout(squashDebounce);
      var v = parseFloat(el.gapSquashAmount.value);
      if (!isFinite(v)) return;
      applySquashChange({ amount: v });
    });
    el.gapSquashCurve.addEventListener('change', function () {
      applySquashChange({ curve: el.gapSquashCurve.value });
    });
    el.gapSquashPreserve.addEventListener('change', function () {
      applySquashChange({ preserve: el.gapSquashPreserve.value });
    });
    el.gapSquashAuto.addEventListener('click', function () {
      applySquashChange({ amount: null });
    });

    el.layerVisible.addEventListener('change', function () {
      var L = layerById(state.activeLayerId);
      if (!L) return;
      L.visible = el.layerVisible.checked;
      renderPreview();
      renderLane();
      save();
    });
    el.layerType.addEventListener('change', function () {
      var L = layerById(state.activeLayerId);
      if (!L) return;
      var next = el.layerType.value === 'color' ? 'color' : 'normal';
      if (L.type === next) return;
      L.type = next;
      // Color layers have no inbetweens; switching back to normal marks the
      // layer's gaps dirty so they regenerate with the chosen mode.
      refreshDirty();
      renderAll();
      save();
      scheduleGenerate();
    });
    el.btnAddLayer.addEventListener('click', addLayer);
    el.btnRemoveLayer.addEventListener('click', function () { removeLayer(state.activeLayerId); });

    // generation (automatic; regenerate button forces a full re-run)
    el.btnRegenerate.addEventListener('click', function () { invalidateAll(); scheduleGenerate(50); });
    function stopCurrentTask() {
      if (state.genRun) cancelRun();
      else if (state.exporting) cancelExport();
      else if (state.mp4Stop) { state.mp4Stop(); state.mp4Stop = null; }
    }
    el.btnCancel.addEventListener('click', stopCurrentTask);
    // The export overlay's Stop always cancels the export itself (generation
    // finishing in the background is harmless once the export is aborted).
    el.btnExportCancelOverlay.addEventListener('click', function () {
      if (state.exporting) cancelExport();
      else stopCurrentTask();
    });

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

    el.fpsInput.addEventListener('change', function () {
      state.fps = clamp(parseInt(el.fpsInput.value, 10) || 12, 1, 60);
      el.fpsInput.value = String(state.fps);
      invalidateAll();
      renderAll();
      save();
      scheduleGenerate();
    });
    el.snapInput.addEventListener('change', function () { state.snap = el.snapInput.checked; save(); });
    // Aspect ratio + custom dimensions share one path: recompute the working
    // size, re-render, persist, and regenerate anything the size invalidates.
    function changeSizeSetting() {
      state.aspect = el.aspectInput.value;
      state.customW = gridSnap(clamp(parseInt(el.customWInput.value, 10) || 1920, 8, 4096));
      state.customH = gridSnap(clamp(parseInt(el.customHInput.value, 10) || 1080, 8, 4096));
      var s = applyWorkSize();
      syncInputs();
      renderAll();
      save();
      scheduleGenerate();
      if (s.w * s.h > 2 * 1024 * 1024) {
        toast('Working size ' + s.w + '×' + s.h + ' is large, interpolation may be slow', 6000);
      }
    }
    el.aspectInput.addEventListener('change', changeSizeSetting);
    el.customWInput.addEventListener('change', changeSizeSetting);
    el.customHInput.addEventListener('change', changeSizeSetting);
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

    // Drag a layer's name gutter to reorder the stack (bottom → top). The
    // timeline pointerdown handler below still activates the layer on click.
    el.lane.addEventListener('pointerdown', function (e) {
      var gutter = e.target.closest('.layer-gutter');
      if (gutter && gutter.dataset.layer) startLayerDrag(e, gutter.dataset.layer);
    });

    // timeline pointer interactions. Clicking a layer row selects it: the
    // name gutter, or anywhere in the layer's band (which also scrubs).
    el.timeline.addEventListener('pointerdown', function (e) {
      var chip = e.target.closest('.kf');
      if (chip) {
        if (e.target.closest('.kf-resize')) { startKfResize(e, chip); return; }
        startKfDrag(e, chip);
        return;
      }
      var gapEl = e.target.closest('.gap-overlay');
      if (gapEl) { selectGap(gapEl.dataset.gap); return; }
      if (e.target.closest('.playhead') || e.target.closest('.ruler')) { startScrub(e); return; }
      var row = e.target.closest('.layer-row');
      if (row) {
        activateLayer(row.dataset.layer);
        if (e.target.closest('.layer-content')) startScrub(e);
        return;
      }
      if (e.target.closest('.lane')) startScrub(e);
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

    // Resizable timeline: drag the divider above it to change its height.
    function saveTimelineHeight() {
      try { localStorage.setItem(TL_H_KEY, el.timelineCol.style.height); } catch (e) {}
    }
    el.tlResizer.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      el.tlResizer.classList.add('dragging');
      document.body.classList.add('resizing-timeline');
      try { el.tlResizer.setPointerCapture(e.pointerId); } catch (err) {}
      var startY = e.clientY;
      var startH = el.timelineCol.offsetHeight;
      function onMove(ev) {
        var h = clamp(startH - (ev.clientY - startY), TL_H_MIN, maxTimelineHeight());
        el.timelineCol.style.height = h + 'px';
      }
      function onUp() {
        el.tlResizer.classList.remove('dragging');
        document.body.classList.remove('resizing-timeline');
        el.tlResizer.removeEventListener('pointermove', onMove);
        el.tlResizer.removeEventListener('pointerup', onUp);
        el.tlResizer.removeEventListener('pointercancel', onUp);
        saveTimelineHeight();
        renderTimeline();
        renderPreview(); // re-fit the viewport to the new panel size
      }
      el.tlResizer.addEventListener('pointermove', onMove);
      el.tlResizer.addEventListener('pointerup', onUp);
      el.tlResizer.addEventListener('pointercancel', onUp);
    });
    el.tlResizer.addEventListener('dblclick', function () {
      el.timelineCol.style.height = TL_H_DEFAULT + 'px';
      saveTimelineHeight();
      renderTimeline();
      renderPreview();
    });

    // Resizable side panels: drag the divider next to a panel to change its
    // width, double-click to restore the default. The right panel grows leftward.
    function saveSideWidth(key) {
      var col = key === SIDE_W_KEY_L ? el.leftCol : el.rightCol;
      try { localStorage.setItem(key, col.style.width); } catch (e) {}
    }
    function wireSideResizer(resizer, col, key, grow) {
      resizer.addEventListener('pointerdown', function (e) {
        e.preventDefault();
        resizer.classList.add('dragging');
        document.body.classList.add('resizing-side');
        try { resizer.setPointerCapture(e.pointerId); } catch (err) {}
        var startX = e.clientX;
        var startW = col.offsetWidth;
        function onMove(ev) {
          var w = clamp(startW + (ev.clientX - startX) * grow, SIDE_W_MIN, maxSideWidth());
          col.style.width = w + 'px';
        }
        function onUp() {
          resizer.classList.remove('dragging');
          document.body.classList.remove('resizing-side');
          resizer.removeEventListener('pointermove', onMove);
          resizer.removeEventListener('pointerup', onUp);
          resizer.removeEventListener('pointercancel', onUp);
          saveSideWidth(key);
          renderPreview(); // re-fit the viewport to the new panel size
        }
        resizer.addEventListener('pointermove', onMove);
        resizer.addEventListener('pointerup', onUp);
        resizer.addEventListener('pointercancel', onUp);
      });
      resizer.addEventListener('dblclick', function () {
        col.style.width = SIDE_W_DEFAULT + 'px';
        saveSideWidth(key);
        renderPreview();
      });
    }
    wireSideResizer(el.leftResizer, el.leftCol, SIDE_W_KEY_L, 1);   // drag right → wider
    wireSideResizer(el.rightResizer, el.rightCol, SIDE_W_KEY_R, -1); // drag left → wider

    document.addEventListener('keydown', function (e) {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA')) return;
      if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { deleteKeyframe(state.selectedId); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); pause(); step(1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); pause(); step(-1); }
    });

    // Drag & drop files: like every other way of loading images, a drop only
    // adds to the library (assets use the custom pointer drag in renderAssets).
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('drop', function (e) {
      e.preventDefault();
      var dt = e.dataTransfer;
      if (!dt) return;
      var files = dt.files;
      if (!files || !files.length) return;
      addImageFiles(files).then(libraryToast).catch(function (err) { toast(err.message); });
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
      if (files.length) addImageFiles(files).then(libraryToast).catch(function (err) { toast(err.message); });
    });

    // dropdown menus
    function wireMenu(btn, menu, onOpen) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var open = !menu.classList.contains('hidden');
        closeMenus();
        if (!open) {
          menu.classList.remove('hidden');
          if (onOpen) onOpen();
        }
      });
      menu.addEventListener('click', function (e) { e.stopPropagation(); });
    }
    wireMenu(el.btnSettings, el.settingsMenu);
    wireMenu(el.btnFile, el.fileMenu);
    wireMenu(el.btnExport, el.exportMenu, populateExportRes);
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
    el.btnExportGo.addEventListener('click', runExport);

    window.addEventListener('beforeunload', writeStorage);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') writeStorage();
    });
  }

  // Model auto-load (used by boot + retry button; works via the worker or
  // inline when no worker is available)

  function closeMenus() {
    [el.settingsMenu, el.fileMenu, el.exportMenu].forEach(function (m) { m.classList.add('hidden'); });
  }

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
    if (workers.length) {
      // Every pool worker downloads + compiles its own copy of the model (the
      // browser HTTP cache makes the repeated download cheap); the launch
      // overlay hides once all of them report ready, so generation starts with
      // the full pool available.
      workersReady = 0;
      workers.forEach(function (w) { w.postMessage({ type: 'load-model' }); });
      return;
    }
    model.loadModel(onModelProgress).then(onModelReady).catch(onModelError);
  }

  function boot() {
    load();
    syncInputs();
    applyWorkSize();
    refreshDirty();
    // Restore the timeline height the user last dragged it to.
    var savedH = 0;
    try { savedH = parseInt(localStorage.getItem(TL_H_KEY) || '', 10) || 0; } catch (e) {}
    if (savedH) el.timelineCol.style.height = clamp(savedH, TL_H_MIN, maxTimelineHeight()) + 'px';
    // Restore the side panel widths the user last dragged them to.
    [[SIDE_W_KEY_L, el.leftCol], [SIDE_W_KEY_R, el.rightCol]].forEach(function (pair) {
      var savedW = 0;
      try { savedW = parseInt(localStorage.getItem(pair[0]) || '', 10) || 0; } catch (e) {}
      if (savedW) pair[1].style.width = clamp(savedW, SIDE_W_MIN, maxSideWidth()) + 'px';
    });
    renderAll();
    wireEvents();
    initWorker();
    loadModelWithOverlay(); // download + compile the AI model on launch
    scheduleGenerate(400);  // auto-fill any dirty gaps shortly after launch
    window.addEventListener('resize', function () {
      // If the window shrinks, keep the timeline inside the clamped range so
      // the preview never gets crushed to nothing.
      var h = parseInt(el.timelineCol.style.height || TL_H_DEFAULT, 10) || TL_H_DEFAULT;
      el.timelineCol.style.height = clamp(h, TL_H_MIN, maxTimelineHeight()) + 'px';
      // Same clamp for the side panels so the preview keeps usable width.
      [el.leftCol, el.rightCol].forEach(function (col) {
        var w = parseInt(col.style.width || SIDE_W_DEFAULT, 10) || SIDE_W_DEFAULT;
        col.style.width = clamp(w, SIDE_W_MIN, maxSideWidth()) + 'px';
      });
      renderTimeline();
      renderPreview(); // re-fit the viewport to the new panel size
    });
  }

  function syncInputs() {
    el.fpsInput.value = String(state.fps);
    el.snapInput.checked = state.snap;
    el.resInput.value = String(state.res);
    el.aspectInput.value = state.aspect;
    el.customWInput.value = String(state.customW);
    el.customHInput.value = String(state.customH);
    var custom = state.aspect === 'custom';
    el.customSizeRow.classList.toggle('hidden', !custom);
    el.resInput.disabled = custom;
    el.btnLoop.style.opacity = state.loop ? 1 : 0.35;
    el.btnKeysOnly.classList.toggle('active', state.keysOnly);
    updateViewportLabel();
  }

  boot();
})();
