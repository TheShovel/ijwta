/* app.js, the Khuwari timeline app
 *
 * Places keyframe images on a timeline at arbitrary times; each gap between
 * two keyframes is filled with interpolated frames, one per tick of the gap
 * (gapSeconds * FPS - 1 frames). The default gap mode runs a local machine
 * learning model (RIFE via ONNX Runtime Web, see model.js) in the browser;
 * a pure-JS mesh warp engine (see morph.js) is the fallback when the model
 * can't be loaded, and squash-and-stretch and no-interpolation modes are
 * per-gap options. Static site, no server, no GPU.
 */
(function () {
  'use strict';

  var morph = window.KHUWARI_MORPH;
  var gifenc = window.gifenc;
  var model = window.KHUWARI_MODEL;

  var state = {
    keyframes: [],        // { id, layer, time, img, name, w, h }
    assets: [],           // { img, name, w, h }: the image library (assets panel)
    layers: [{ id: 'L1', name: 'Layer 1', visible: true }], // top → bottom draw order (first = topmost)
    activeLayerId: 'L1',  // layer new keyframes go into
    generated: {},        // gapId -> [{ idx, t, time, img, ai }]
    gapMeta: {},          // gapId -> { h, count }: what the frames were made from
    gapType: {},          // gapId -> 'ai' | 'squash' | 'none' (per-gap interpolation)
    gapSquash: {},        // gapId -> { amount, curve, preserve }
    gapBlur: {},          // gapId -> { on, intensity } (per-gap motion blur)
    dirty: new Set(),     // gapIds that need (re)generation
    fps: 12,
    zoom: 90,             // px per second
    snap: true,
    res: 512,             // long edge for preset aspects
    aspect: 'auto',       // 'auto' | '16:9' | '9:16' | '4:3' | '3:4' | '1:1' | 'custom' | 'manual'
    aspectRatio: null,    // width/height number when aspect is 'manual'
    customW: 1920,        // exact working width in custom aspect mode
    customH: 1080,        // exact working height in custom aspect mode
    modelReady: false,
    playhead: 0,
    curIndex: 0,
    playing: false,
    loop: true,
    keysOnly: false,   // viewport shows keyframes only (no interpolated frames)
    onion: false,      // onion skin: ghosts of neighboring keyframes
    onionCfg: { before: 1, after: 1, opacity: 0.28, tint: false, tintColor: '#ff3b30', tintOpacity: 0.35 },
    selectedId: null,
    selectedGapId: null,   // gap selected in the timeline (right panel shows it)
    selectedDotId: null,   // color-dot selected (right panel shows its properties)
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
  var assetCache = [];    // [{ img, name, w, h }]: assets panel contents
  var assetImgs = new Set(); // img srcs already in the panel (change detection)
  var idSeq = 1;
  var layerSeq = 2;
  var GUTTER_W = 96; // px at the left of the timeline reserved for layer names
  var TL_H_DEFAULT = 188; // px, initial timeline height (see .timeline-col)
  var TL_H_MIN = 96;      // px, smallest the timeline can be dragged to
  var TL_H_KEY = 'khuwari-timeline-h'; // UI preference, not part of the project file
  var SIDE_W_DEFAULT = 212; // px, initial side panel width (see .side-col)
  var SIDE_W_MIN = 140;     // px, smallest a side panel can be dragged to
  var SIDE_W_KEY_L = 'khuwari-side-w-l'; // UI preferences, not part of the project file
  var SIDE_W_KEY_R = 'khuwari-side-w-r';
  var ONION_KEY = 'khuwari-onion'; // onion-skin prefs (persisted separately from the project file)
  var DOT_COLOR_KEY = 'khuwari-dot-color'; // last fill color used, so new dots pick it up
  var lastDotColor = '#4f8fff';
  var copiedDotProps = null; // fill properties copied from a dot, ready to paste onto another
  var toastTimer = null;
  var WARN_GEN_COUNT = 5; // gaps needing more inbetweens than this get a red warning
  var REGEN_ABSORB_MS = 400; // while a run is active, edits wait at least this long so a quick burst coalesces into ONE restart instead of one cancel+restart per edit
  var EDIT_DEBOUNCE_MS = 250; // floor for edit-driven regeneration: a burst of quick edits shares one run that starts after they settle

  // Inline SVG icons for the buttons that are (re)built at runtime. Stroke-based
  // 24×24 paths, currentColor, matching the static icons in editor.html.
  var ICONS = {
    play: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
    arrowUp: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>',
    download: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>'
  };

  function byId(id) { return document.getElementById(id); }

  // Draw the filled portion of a .slider (normalized 0..1 across its min/max).
  function syncSlider(input) {
    var min = parseFloat(input.min);
    var max = parseFloat(input.max);
    var v = parseFloat(input.value);
    if (!isFinite(min)) min = 0;
    if (!isFinite(max)) max = 1;
    if (!isFinite(v)) v = min;
    var pct = (max > min) ? (v - min) / (max - min) : 0;
    input.style.setProperty('--val', pct.toFixed(4));
  }

  var el = {
    btnAddAssets: byId('btnAddAssets'),
    assetGrid: byId('assetGrid'),
    startScreen: byId('startScreen'),
    btnStartNew: byId('btnStartNew'),
    btnStartLoad: byId('btnStartLoad'),
    btnStartExample: byId('btnStartExample'),
    btnStartDocs: byId('btnStartDocs'),
    btnStartCredits: byId('btnStartCredits'),
    btnStartGithub: byId('btnStartGithub'),
    btnPlay: byId('btnPlay'),
    btnStepBack: byId('btnStepBack'),
    btnStepFwd: byId('btnStepFwd'),
    btnLoop: byId('btnLoop'),
    btnKeysOnly: byId('btnKeysOnly'),
    btnOnion: byId('btnOnion'),
    btnOnionMenu: byId('btnOnionMenu'),
    onionMenu: byId('onionMenu'),
    onionBefore: byId('onionBefore'),
    onionBeforeVal: byId('onionBeforeVal'),
    onionAfter: byId('onionAfter'),
    onionAfterVal: byId('onionAfterVal'),
    onionOpacity: byId('onionOpacity'),
    onionOpacityVal: byId('onionOpacityVal'),
    onionTint: byId('onionTint'),
    onionTintGroup: byId('onionTintGroup'),
    onionTintColor: byId('onionTintColor'),
    onionTintOpacity: byId('onionTintOpacity'),
    onionTintOpacityVal: byId('onionTintOpacityVal'),
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
    btnHelp: byId('btnHelp'),
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
    fillHint: byId('fillHint'),
    fillHintText: byId('fillHintText'),
    gapName: byId('gapName'),
    gapTime: byId('gapTime'),
    gapTypeInput: byId('gapTypeInput'),
    gapSquashGroup: byId('gapSquashGroup'),
    gapSquashAmount: byId('gapSquashAmount'),
    gapSquashValue: byId('gapSquashValue'),
    gapSquashAuto: byId('gapSquashAuto'),
    gapSquashCurve: byId('gapSquashCurve'),
    gapSquashPreserve: byId('gapSquashPreserve'),
    gapBlurGroup: byId('gapBlurGroup'),
    gapBlurOn: byId('gapBlurOn'),
    gapBlurAmount: byId('gapBlurAmount'),
    gapBlurValue: byId('gapBlurValue'),
    layerNameLabel: byId('layerNameLabel'),
    layerMenu: byId('layerMenu'),
    layerMenuLabel: byId('layerMenuLabel'),
    btnLayerMenu: byId('btnLayerMenu'),
    layerVisible: byId('layerVisible'),
    btnAddLayer: byId('btnAddLayer'),
    btnAddFillLayer: byId('btnAddFillLayer'),
    btnRemoveLayer: byId('btnRemoveLayer'),
    dotPanel: byId('dotPanel'),
    dotName: byId('dotName'),
    dotTime: byId('dotTime'),
    dotColor: byId('dotColor'),
    dotThreshold: byId('dotThreshold'),
    dotThresholdValue: byId('dotThresholdValue'),
    dotGrow: byId('dotGrow'),
    dotGrowValue: byId('dotGrowValue'),
    dotGradOn: byId('dotGradOn'),
    dotGradGroup: byId('dotGradGroup'),
    dotGradColor: byId('dotGradColor'),
    dotGradHeight: byId('dotGradHeight'),
    dotGradHeightValue: byId('dotGradHeightValue'),
    dotGradDir: byId('dotGradDir'),
    dotStart: byId('dotStart'),
    dotEnd: byId('dotEnd'),
    btnDotDelete: byId('btnDotDelete'),
    btnDotCopy: byId('btnDotCopy'),
    btnDotPaste: byId('btnDotPaste'),
    previewCanvas: byId('previewCanvas'),
    previewOverlay: byId('previewOverlay'),
    previewStage: byId('previewStage'),
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
    manualAspectRow: byId('manualAspectRow'),
    aspectRatioInput: byId('aspectRatioInput'),
    customWInput: byId('customWInput'),
    customHInput: byId('customHInput'),
    customSizeRow: byId('customSizeRow'),
    selTimeInput: byId('selTimeInput'),
    kfMixInput: byId('kfMixInput'),
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
  // spawn several workers and hand each gap to a different one; the ML
  // inference scales near-linearly across cores, with zero quality change.
  var workers = [];          // active Worker instances
  var workerBusy = [];       // parallel to workers: active gap jobs per worker
  var workerModelBroken = []; // parallel: true when a worker's model load failed
  var workersReady = 0;      // workers that reported model-ready
  var workersFailed = 0;     // workers that settled by failing or dying
  var workerJobs = {};       // jobId -> { resolve, reject, onFrame, onProgress, worker }
  var jobSeq = 0;
  var upscaleJobs = {};      // jobId -> { resolve, reject } (export upscaling)

  function workerPoolSize() {
    try {
      if (typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated) return 1;
      var hw = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 1;
      // Each non-COI worker is single-threaded, so more workers = more parallel
      // frames (chunking spreads one gap across the pool). Cap at 6: every
      // worker holds its own copy of the model, so RAM scales with the pool.
      // Chrome's deviceMemory lets us dial back on low-RAM machines.
      var cap = 6;
      if (typeof navigator !== 'undefined' && navigator.deviceMemory && navigator.deviceMemory <= 4) cap = 3;
      return Math.max(1, Math.min(cap, hw - 1));
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
    workerModelBroken.push(false);
    w.onmessage = function (e) { onWorkerMessage(e, w); };
    w.onerror = function (e) {
      console.error('Worker error, dropping worker:', e && e.message);
      try { w.terminate(); } catch (err) {}
      var idx = workers.indexOf(w);
      if (idx !== -1) { workers.splice(idx, 1); workerBusy.splice(idx, 1); workerModelBroken.splice(idx, 1); }
      // A worker that dies mid-load has settled by dying; count it so the
      // launch-overlay gate can resolve even when not every worker reports back.
      workersFailed++;
      settleModelGate();
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

  // Index of the worker with the fewest active gap jobs, preferring workers
  // whose model loaded: chunks of one gap must all use the same method (ML or
  // mesh) or the quality would visibly differ at chunk boundaries. Falls back
  // to any worker when every one is broken.
  function pickWorker() {
    if (!workers.length) return -1;
    var best = -1;
    for (var i = 0; i < workers.length; i++) {
      if (workerModelBroken[i]) continue;
      if (best === -1 || workerBusy[i] < workerBusy[best]) best = i;
    }
    if (best === -1) {
      best = 0;
      for (var j = 1; j < workers.length; j++) if (workerBusy[j] < workerBusy[best]) best = j;
    }
    return best;
  }

  function decBusy(w) {
    var idx = workers.indexOf(w);
    if (idx !== -1) workerBusy[idx] = Math.max(0, workerBusy[idx] - 1);
  }

  // The launch overlay waits for every worker's model load to SETTLE (ready or
  // failed): a single stuck worker must not hang generation forever. If any
  // worker has the model, the app proceeds (broken workers are skipped by
  // pickWorker); only when ALL fail does it fall back to the mesh warp message.
  function settleModelGate() {
    if (state.modelReady || !modelGate || !workers.length) return;
    if (workersReady + workersFailed >= workers.length) {
      if (workersReady === 0) onModelError(new Error('All workers failed to load the ML model'));
      else onModelReady();
    }
  }

  function onWorkerMessage(e, w) {
    var m = e.data;
    if (!m) return;
    if (m.type === 'model-progress') { onModelProgress(m); }
    else if (m.type === 'model-ready') {
      workersReady++;
      settleModelGate();
    }
    else if (m.type === 'model-error') {
      // A pool worker failing to load its own copy of the model shouldn't fail
      // the app (the other workers still work); mark it broken so pickWorker
      // never hands it a chunk (keeps per-gap quality uniform).
      var wi = workers.indexOf(w);
      if (wi !== -1) workerModelBroken[wi] = true;
      workersFailed++;
      settleModelGate();
    }
    else if (m.type === 'gap-progress') {
      var jp = workerJobs[m.jobId];
      if (jp && jp.onProgress) jp.onProgress(m.label, m.gapFrac);
    }
    else if (m.type === 'frame') {
      var jf = workerJobs[m.jobId];
      if (!jf) return;
      if (m.img) {
        // Worker encoded the frame (OffscreenCanvas), so nothing to do here.
        jf.onFrame({
          idx: m.idx, t: m.t, time: m.time, ai: m.ai, img: m.img
        });
      } else {
        var rgba = new Uint8ClampedArray(m.rgba);
        jf.onFrame({
          idx: m.idx, t: m.t, time: m.time, ai: m.ai,
          img: dataToDataURL(rgba, m.width, m.height)
        });
      }
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
  // Format a manual aspect ratio back into the text field (e.g. 1.77777 → 1.78).
  function fmtRatio(r) { return String(Math.round(r * 100) / 100); }
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

  // Bake the color fills into a keyframe raster: the line-art keyframe with
  // every active fill composited UNDER it (the fill raster is painted first,
  // then the line art is drawn over it through its alpha, exactly like the
  // live render, so the fill never covers the line art). Interpolating these
  // composites makes the colors warp WITH the line art (no per-frame flood,
  // so nothing leaks or floods when something moves). Returns the baked RGBA,
  // or null when no fill applies (caller uses the raw raster). Cached by
  // (keyframe image, size, fill signature): chunked jobs of one gap all hit
  // the same entry.
  var bakeCache = new Map();
  var bakeCacheOrder = [];
  var BAKE_CACHE_MAX = 12;
  function endpointBake(img, layerId, time, W, H) {
    var fills = fillsForLayer(layerId);
    if (!fills.length) return null;
    var sig = layerFillSig(layerId, time);
    if (!sig) return null;
    var imgSrc = (img && img.src) || img;
    var key = imgSrc + '|' + W + 'x' + H + '|' + sig;
    if (bakeCache.has(key)) return bakeCache.get(key);
    var base = drawImageToData(img, W, H);
    var n = W * H;
    // 1. Paint every active fill into its own raster (later dots/fills
    //    overpaint earlier ones in shared regions, matching live rendering).
    var fillData = new Uint8ClampedArray(n * 4);
    var any = false;
    fills.forEach(function (F) {
      activeDots(F, time).forEach(function (d) {
        var rgb = morph.parseHexColor(d.color);
        if (!rgb) return;
        var mask = morph.floodFillMask(base, W, H, d.x * W, d.y * H, d.threshold);
        if (!mask) return;
        var grow = Math.round(d.grow) || 0;
        if (grow > 0) mask = morph.dilateMask(mask, W, H, grow, mask.bounds || null);
        if (d.gradOn) {
          var rgb2 = morph.parseHexColor(d.gradColor);
          if (rgb2) morph.paintGradient(fillData, mask, n, rgb2, rgb, d.gradDir || 'bottom', Math.round(d.gradHeight) || 24, W, mask.bounds || null);
          else morph.paintMask(fillData, mask, n, rgb, W, mask.bounds || null);
        } else morph.paintMask(fillData, mask, n, rgb, W, mask.bounds || null);
        any = true;
      });
    });
    if (!any) return null;
    // 2. Composite the line art OVER the fill: opaque strokes stay on top,
    //    semi-transparent edges blend, and the fill shows only through the
    //    line art's transparency (same result as two stacked layers).
    var out = new Uint8ClampedArray(base);
    for (var p = 0, q = 0; p < n; p++, q += 4) {
      if (fillData[q + 3] !== 255) continue; // no fill here: keep line art as-is
      var a = base[q + 3];
      if (a === 0) {
        out[q] = fillData[q]; out[q + 1] = fillData[q + 1]; out[q + 2] = fillData[q + 2]; out[q + 3] = 255;
      } else {
        var inv = 255 - a;
        out[q] = (base[q] * a + fillData[q] * inv) / 255;
        out[q + 1] = (base[q + 1] * a + fillData[q + 1] * inv) / 255;
        out[q + 2] = (base[q + 2] * a + fillData[q + 2] * inv) / 255;
        out[q + 3] = 255;
      }
    }
    // Bound memory: only cache modest sizes (same guard as the fill cache).
    if (W * H <= 1024 * 1024) {
      bakeCache.set(key, out);
      bakeCacheOrder.push(key);
      if (bakeCacheOrder.length > BAKE_CACHE_MAX) {
        var old = bakeCacheOrder.shift();
        bakeCache.delete(old);
      }
    }
    return out;
  }

  // Fill output cache: the fill for (source img + active dot signature + size)
  // is deterministic, so holds, scrubbing back and forth, and the filmstrip's
  // per-time thumbs reuse one canvas instead of re-running the flood fill.
  // Only modest sizes are cached (the cache caps at 16 entries × 4MB = 64MB
  // worst case); huge canvases recompute; the bbox path keeps that cheap.
  var fillCache = new Map();
  var fillCacheOrder = [];
  var FILL_CACHE_MAX = 16;
  var FILL_CACHE_MAX_PX = 1024 * 1024;

  function fillCacheKey(t, L, srcKey, W, H) {
    var parts = [L.id, srcKey || '', W, H];
    activeDots(L, t).forEach(function (d) {
      parts.push(d.id, d.x.toFixed(4), d.y.toFixed(4), d.color,
        (Math.round(d.threshold * 100) / 100), d.grow,
        d.gradOn ? '1:' + d.gradColor + ':' + d.gradHeight + ':' + d.gradDir : '0');
    });
    return parts.join('|');
  }

  // Render one fill layer's contribution at (W,H): flood-fill every active dot
  // against the source layer's pixels and paint the results (dot order, so a
  // later dot overpaints an earlier one in the same region). `srcData` is the
  // source layer's RGBA at (W,H); `srcKey` identifies it for the cache (the
  // frame image src) or null when it can't be cached (fill-on-fill). Returns a
  // canvas or null when there is nothing to draw.
  function renderFillLayer(t, L, srcData, srcKey, W, H) {
    var dots = activeDots(L, t);
    if (!dots.length || !srcData) return null;
    var cacheable = srcKey && W * H <= FILL_CACHE_MAX_PX;
    var key = cacheable ? fillCacheKey(t, L, srcKey, W, H) : null;
    if (key) {
      var hit = fillCache.get(key);
      if (hit) return hit;
    }
    var n = W * H;
    var canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    var ctx = canvas.getContext('2d');
    var out = ctx.createImageData(W, H);
    dots.forEach(function (d) {
      var rgb = morph.parseHexColor(d.color);
      if (!rgb) return;
      var mask = morph.floodFillMask(srcData, W, H, d.x * W, d.y * H, d.threshold);
      if (!mask) return;
      var grow = Math.round(d.grow) || 0;
      if (grow > 0) mask = morph.dilateMask(mask, W, H, grow, mask.bounds || null);
      if (d.gradOn) {
        var rgb2 = morph.parseHexColor(d.gradColor);
        if (rgb2) morph.paintGradient(out.data, mask, n, rgb2, rgb, d.gradDir || 'bottom', Math.round(d.gradHeight) || 24, W, mask.bounds || null);
        else morph.paintMask(out.data, mask, n, rgb, W, mask.bounds || null);
      } else morph.paintMask(out.data, mask, n, rgb, W, mask.bounds || null);
    });
    ctx.putImageData(out, 0, 0);
    if (key) {
      fillCache.set(key, canvas);
      fillCacheOrder.push(key);
      if (fillCacheOrder.length > FILL_CACHE_MAX) {
        var old = fillCacheOrder.shift();
        fillCache.delete(old);
      }
    }
    return canvas;
  }

  // Render every visible layer into its own bitmap at (W,H), top-down so a
  // fill layer can read the layer above it. Returns the visible layers
  // bottom-up as { layer, canvas, img } entries: normal layers carry their
  // frame image (drawn directly by drawComposite, so no per-layer canvas
  // allocation), fill layers carry their computed fill canvas. canvas/img are
  // null when a layer contributes nothing.
  function layerBitmaps(t, keysOnly, W, H) {
    var vis = [];
    state.layers.forEach(function (L, i) {
      if (L.visible !== false) vis.push({ L: L, idx: i });
    });
    var bmp = {}; // layerId -> { kind:'img', src } | { kind:'fill', canvas } | null
    for (var v = 0; v < vis.length; v++) {
      var L = vis[v].L;
      if (L.type === 'fill') {
        // Color fills are baked into the KEYFRAME composites the gaps
        // interpolate from, so the fill only renders live when the source
        // layer is showing a keyframe (held or exact). Interpolated frames
        // carry the baked colors instead, and re-flooding against warped line
        // art would leak.
        var srcData = null, srcKey = null;
        var srcV = v > 0 ? vis[v - 1] : null;
        if (srcV && activeDots(L, t).length) {
          var srcFrame = layerFrameAt(srcV.L.id, t, keysOnly);
          if (srcFrame && !srcFrame.gen) {
            var up = bmp[srcV.L.id];
            if (up) {
              if (up.kind === 'img') {
                var img = imgCache.get(up.src);
                if (img) { srcData = drawImageToData(img, W, H); srcKey = up.src; }
              } else if (up.kind === 'fill') {
                var uctx = up.canvas.getContext('2d');
                try { srcData = uctx.getImageData(0, 0, W, H).data; } catch (e) { srcData = null; }
              }
            }
          }
        }
        var fc = srcData ? renderFillLayer(t, L, srcData, srcKey, W, H) : null;
        bmp[L.id] = fc ? { kind: 'fill', canvas: fc } : null;
      } else {
        var f = layerFrameAt(L.id, t, keysOnly);
        bmp[L.id] = f ? { kind: 'img', src: f.img, mix: f.mix || 'source-over' } : null;
      }
    }
    var out = [];
    for (var i = vis.length - 1; i >= 0; i--) {
      var b = bmp[vis[i].L.id];
      out.push({
        layer: vis[i].L,
        canvas: b && b.kind === 'fill' ? b.canvas : null,
        img: b && b.kind === 'img' ? b.src : null,
        mix: b && b.kind === 'img' ? (b.mix || 'source-over') : 'source-over'
      });
    }
    return out;
  }

  // Draw a composite from layer bitmaps (bottom-up order). White backdrop.
  // Normal layers draw their frame image directly (no canvas allocation); fill
  // layers draw their computed fill canvas.
  function drawComposite(ctx, bits, W, H) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, H);
    for (var i = 0; i < bits.length; i++) {
      var b = bits[i];
      if (b.canvas) {
        ctx.globalCompositeOperation = 'source-over';
        ctx.drawImage(b.canvas, 0, 0);
      } else if (b.img) {
        var img = imgCache.get(b.img);
        if (img) {
          ctx.globalCompositeOperation = b.mix || 'source-over';
          drawContain(ctx, img, W, H);
        }
      }
    }
    ctx.globalCompositeOperation = 'source-over';
  }

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
  function compositeCanvas(t) {
    var frames = framesAt(t, false);
    var canvas = document.createElement('canvas');
    canvas.width = workW;
    canvas.height = workH;
    var ctx = canvas.getContext('2d');
    return Promise.all(frames.map(function (f) {
      return loadImage(f.img).catch(function () { return null; });
    })).then(function () {
      drawComposite(ctx, layerBitmaps(t, false, workW, workH), workW, workH);
      return canvas;
    });
  }

  // Filmstrip thumbs are displayed at ~66×74 px, but were composited at FULL
  // work resolution: a full-res canvas render + toDataURL per thumb, per
  // refresh, on the MAIN thread during generation (canvas.toDataURL is the
  // exact Firefox-slow op the worker encode path avoids). Composite at thumb
  // scale instead (2× for retina, capped): visually identical on a 66×74 img,
  // ~20× less canvas work and a far cheaper PNG encode.
  var THUMB_MAX_W = 160;
  function compositeThumb(t) {
    var frames = framesAt(t, false);
    var tw = workW, th = workH;
    if (tw > THUMB_MAX_W) {
      var s = THUMB_MAX_W / tw;
      tw = Math.round(tw * s);
      th = Math.round(th * s);
    }
    var canvas = document.createElement('canvas');
    canvas.width = tw;
    canvas.height = th;
    var ctx = canvas.getContext('2d');
    return Promise.all(frames.map(function (f) {
      return loadImage(f.img).catch(function () { return null; });
    })).then(function () {
      drawComposite(ctx, layerBitmaps(t, false, tw, th), tw, th);
      return canvas.toDataURL('image/png');
    });
  }

  function compositeDataURL(t) {
    return compositeCanvas(t).then(function (c) { return c.toDataURL('image/png'); });
  }

  function renderTimeline() {
    var keys = sortedKeyframes();
    var maxTime = keys.length ? keys[keys.length - 1].time : 0;
    // Fill-layer dots can extend past the last keyframe (they run on their own
    // window); make sure their window is visible on the timeline.
    state.layers.forEach(function (L) {
      if (L.type === 'fill' && L.dots) {
        L.dots.forEach(function (d) { if (d.end > maxTime) maxTime = d.end; });
      }
    });
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

  // Color-dot chips that overlap in time are stacked onto separate rows so
  // dots added at the same moment don't sit on top of each other. Same greedy
  // first-fit as stackGapLabels: each chip lands on the first row it doesn't
  // collide with, then drops to that row's vertical offset. Rows are spaced a
  // full chip height apart (no vertical overlap), and the fill layer's row
  // grows to fit however many rows are used, so stacked chips never clip
  // against each other or the layers above/below.
  function stackFillDots(items, rowEl) {
    var BASE_TOP = 7;   // px: top of the first chip row (matches .fill-dot)
    var CHIP_H = 20;    // px: .fill-dot height
    var ROW_GAP = 4;    // px: vertical spacing between stacked rows
    var PAD_BOTTOM = 7; // px: clearance below the last row
    var ROW_STEP = CHIP_H + ROW_GAP;  // stacked rows: a chip height plus a gap
    var MARGIN = 2;     // px of horizontal clearance between chips
    var rows = [];
    items.forEach(function (it) {
      var row = 0;
      while (rows[row] && rows[row].some(function (o) {
        return it.right + MARGIN > o.left && it.left < o.right + MARGIN;
      })) row++;
      if (!rows[row]) rows[row] = [];
      rows[row].push({ left: it.left, right: it.right });
      if (row > 0) it.el.style.top = (BASE_TOP + row * ROW_STEP) + 'px';
    });
    // Grow the fill layer's row to fit the deepest stack (the CSS default of
    // 34px covers the single-row case). There is no row limit: the layer keeps
    // growing however many dots overlap in time.
    if (rowEl) {
      var used = 0;
      for (var i = 0; i < rows.length; i++) if (rows[i] && rows[i].length) used = i;
      if (used > 0) rowEl.style.height = (BASE_TOP + used * ROW_STEP + CHIP_H + PAD_BOTTOM) + 'px';
    }
  }

  function renderLane() {
    el.lane.innerHTML = '';
    var z = state.zoom;
    state.layers.forEach(function (L) {
      var row = document.createElement('div');
      row.className = 'layer-row' + (L.id === state.activeLayerId ? ' active' : '') + (L.id === layerDragId ? ' dragging' : '') +
        (L.type === 'fill' ? ' thin' : '');
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
      var content = document.createElement('div');
      content.className = 'layer-content';

      var keys = sortedKeyframes(L.id);
      var gaps = computeGaps(L.id);
      var labelItems = [];

      if (L.type === 'fill') {
        // Fill layers hold color dots (seed points) instead of keyframes.
        // Each dot is a chip spanning its active window [start, end]. Chips
        // that overlap in time are stacked onto separate rows so dots placed
        // at the same moment stay findable.
        var dots = L.dots || [];
        var fillItems = [];
        if (!dots.length) {
          var hint = document.createElement('div');
          hint.className = 'fill-hint';
          hint.textContent = 'Click the preview to add a color dot. It fills the layer above';
          content.appendChild(hint);
        }
        dots.forEach(function (d) {
          var chip = document.createElement('div');
          chip.className = 'fill-dot' + (d.id === state.selectedDotId ? ' selected' : '');
          chip.dataset.dot = d.id;
          var x1 = d.start * z, x2 = d.end * z;
          var w = Math.max(10, x2 - x1);
          chip.style.left = x1 + 'px';
          chip.style.width = w + 'px';
          chip.style.zIndex = d.id === state.selectedDotId ? 10 : 'auto';
          chip.title = fmtTime(d.start) + ' → ' + fmtTime(d.end) + '. Drag to move, drag the edges to change its window';
          var swatch = document.createElement('span');
          swatch.className = 'fill-dot-swatch';
          swatch.style.background = d.color || '#888';
          var label = document.createElement('span');
          label.className = 'fill-dot-label';
          label.textContent = fmtTime(d.start) + '-' + fmtTime(d.end);
          var g1 = document.createElement('div');
          g1.className = 'fill-dot-edge left';
          var g2 = document.createElement('div');
          g2.className = 'fill-dot-edge right';
          chip.appendChild(swatch);
          chip.appendChild(label);
          chip.appendChild(g1);
          chip.appendChild(g2);
          chip.addEventListener('dblclick', function (e) {
            e.stopPropagation();
            deleteDot(d.id);
            renderLane();
            renderSelectedPanel();
            renderPreview();
            invalidateDots();
          });
          content.appendChild(chip);
          fillItems.push({ el: chip, left: x1, right: x1 + w });
        });
        stackFillDots(fillItems, row);
        row.appendChild(gutter);
        row.appendChild(content);
        el.lane.appendChild(row);
        return;
      }

      gaps.forEach(function (g) {
        var x1 = g.fromTime * z, x2 = g.toTime * z;
        var gen = state.generated[g.id] || [];
        var ok = gapComplete(g);
        var overlay = document.createElement('div');
        overlay.className = 'gap-overlay ' + (ok ? 'ok' : 'dirty') + (g.genCount > WARN_GEN_COUNT ? ' warn' : '') +
          ' mode-' + g.mode + (g.id === state.selectedGapId ? ' selected' : '');
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
        } else if (g.genCount > 0) {
          var label = document.createElement('div');
          label.className = 'glabel';
          var suffix = g.mode === 'squash' ? ' · squash' : '';
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

  // Composite thumbnails are expensive (full canvas render + toDataURL per
  // frame); cache by the composite's identity so re-rendering the filmstrip
  // during generation doesn't recompute frames that haven't changed. The
  // composite itself renders at THUMB scale, not work resolution (see
  // compositeThumb); the filmstrip only ever shows ~66×74 thumbs.
  var thumbCache = {};
  var thumbCacheOrder = [];
  function thumbURL(t) {
    var key = compositeKey(t, false);
    if (thumbCache[key]) return Promise.resolve(thumbCache[key]);
    return compositeThumb(t).then(function (url) {
      thumbCache[key] = url;
      thumbCacheOrder.push(key);
      // Bound the cache so long editing sessions don't leak every composite.
      if (thumbCacheOrder.length > 400) {
        var old = thumbCacheOrder.shift();
        delete thumbCache[old];
      }
      return url;
    });
  }

  function makeThumb(f, i) {
    var div = document.createElement('div');
    div.className = 'thumb' + (f.key ? ' key' : '') + (i === state.curIndex ? ' current' : '');
    var img = document.createElement('img');
    div.appendChild(img);
    // The thumb is the composite of every layer at this frame's time (cached).
    thumbURL(f.time).then(function (url) {
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

  function renderSelectedPanel() {
    var dot = state.selectedDotId ? dotById(state.selectedDotId) : null;
    var gap = state.selectedGapId ? allGaps().find(function (g) { return g.id === state.selectedGapId; }) : null;
    if (state.selectedGapId && !gap) state.selectedGapId = null;
    var hasGap = !!gap;
    // When the active layer is a fill layer with nothing selected, show a
    // placement hint instead of the (empty) keyframe section.
    var activeFill = layerById(state.activeLayerId).type === 'fill' && !dot;
    el.dotPanel.classList.toggle('hidden', !dot);
    el.gapPanel.classList.toggle('hidden', !!dot || activeFill || !hasGap);
    el.fillHint.classList.toggle('hidden', !activeFill);
    el.kfSection.classList.toggle('hidden', !!dot || activeFill || hasGap);
    if (activeFill) {
      var AL = layerById(state.activeLayerId);
      el.fillHintText.textContent = AL && AL.dots && AL.dots.length
        ? 'Color layer with ' + AL.dots.length + ' dot' + (AL.dots.length === 1 ? '' : 's') + '. Click a dot on the timeline to edit it, or click the preview to add another.'
        : 'Click the preview to place a color dot. It flood-fills the layer above this one, bounded by its line art. Click a dot chip on the timeline to edit its color, threshold, grow, and active window.';
    }
    if (dot) {
      var L = layerOfDot(dot.id);
      el.dotName.textContent = (L ? L.name + ' · ' : '') + 'color dot';
      el.dotTime.textContent = fmtTime(dot.start) + ' → ' + fmtTime(dot.end) + ' active';
      el.dotColor.value = dot.color || '#4f8fff';
      el.dotThreshold.value = String(Math.round(dot.threshold * 100) / 100);
      syncSlider(el.dotThreshold);
      el.dotThresholdValue.textContent = Math.round(dot.threshold * 100) + '%';
      el.dotGrow.value = String(Math.round(dot.grow));
      syncSlider(el.dotGrow);
      el.dotGrowValue.textContent = Math.round(dot.grow) + 'px';
      el.dotGradOn.checked = !!dot.gradOn;
      el.dotGradGroup.classList.toggle('hidden', !dot.gradOn);
      el.dotGradColor.value = dot.gradColor || '#ffffff';
      el.dotGradHeight.value = String(Math.round(dot.gradHeight || 24));
      syncSlider(el.dotGradHeight);
      el.dotGradHeightValue.textContent = Math.round(dot.gradHeight || 24) + 'px';
      el.dotGradDir.value = dot.gradDir || 'bottom';
      el.dotStart.value = (Math.round(dot.start * 100) / 100).toFixed(2);
      el.dotEnd.value = (Math.round(dot.end * 100) / 100).toFixed(2);
      el.btnDotPaste.disabled = !copiedDotProps;
      return;
    }
    el.gapPanel.classList.toggle('hidden', !hasGap);
    el.kfSection.classList.toggle('hidden', hasGap);
    if (hasGap) {
      el.gapTypeInput.disabled = false;
      var L = layerById(gap.layer);
      el.gapName.textContent = (L ? L.name + ' · ' : '') + (gap.from.name || 'frame') + ' → ' + (gap.to.name || 'frame');
      el.gapTime.textContent = fmtTime(gap.fromTime) + ' → ' + fmtTime(gap.toTime) +
        (gap.mode === 'none' ? ' · hold' : ' · ' + gap.genCount + ' inbetweens');
      el.gapTypeInput.value = gap.mode;
      var squash = gapSquashOpts(gap.id);
      var isSquash = gap.mode === 'squash';
      el.gapSquashGroup.classList.toggle('hidden', !isSquash);
      if (isSquash) {
        var isAuto = squash.amount == null;
        el.gapSquashAmount.value = isAuto ? '0' : String(Math.round(squash.amount * 100) / 100);
        syncSlider(el.gapSquashAmount);
        el.gapSquashValue.textContent = isAuto ? 'auto' : (Math.round(squash.amount * 100) + '%');
        el.gapSquashValue.classList.toggle('is-auto', isAuto);
        el.gapSquashAmount.title = isAuto ? 'auto (distance-based)' : (Math.round(squash.amount * 100) + '%');
        el.gapSquashAuto.disabled = isAuto;
        el.gapSquashCurve.value = squash.curve;
        el.gapSquashPreserve.value = squash.preserve;
      }
      // Motion blur applies to any gap that actually generates inbetweens
      // (ML or squash).
      var isBlurable = gap.mode === 'ai' || gap.mode === 'squash';
      var blur = gapBlurOpts(gap.id);
      el.gapBlurGroup.classList.toggle('hidden', !isBlurable);
      if (isBlurable) {
        el.gapBlurOn.checked = blur.on;
        el.gapBlurAmount.value = String(Math.round(blur.intensity * 100) / 100);
        syncSlider(el.gapBlurAmount);
        el.gapBlurValue.textContent = Math.round(blur.intensity * 100) + '%';
        el.gapBlurAmount.disabled = !blur.on;
      }
      return;
    }
    var kf = state.keyframes.find(function (k) { return k.id === state.selectedId; });
    var has = !!kf;
    el.selTimeInput.disabled = !has;
    el.kfMixInput.disabled = !has;
    el.btnReplace.disabled = !has;
    el.btnDelete.disabled = !has;
    el.kfCard.classList.toggle('hidden', !has);
    el.kfEmpty.classList.toggle('hidden', has);
    if (!kf) return;
    el.selTimeInput.value = (Math.round(kf.time * 100) / 100).toFixed(2);
    el.kfMixInput.value = kf.mix || 'source-over';
    el.kfThumb.src = kf.img;
    el.kfName.textContent = kf.name || 'keyframe';
    el.kfTime.textContent = fmtTime(kf.time);
  }

  function activateLayer(id) {
    if (!layerById(id)) return;
    state.activeLayerId = id;
    state.selectedId = null;
    state.selectedGapId = null;
    state.selectedDotId = null;
    renderLayerPanel();
    renderSelectedPanel();
    renderLane();
    renderPreview();
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
    state.selectedId = null;
    state.selectedGapId = null;
    state.selectedDotId = null;
    renderLayerPanel();
    renderSelectedPanel();
    renderLane();
  }

  // A generative color-fill layer: holds dots that flood-fill the layer ABOVE
  // it. Inserted directly below the active layer so a fill added while a line
  // art layer is active lands right under it, ready for dots.
  function addFillLayer() {
    var id = 'L' + (layerSeq++);
    var n = 1;
    state.layers.forEach(function (l) {
      var m = /^Color (\d+)$/.exec(l.name);
      if (m) n = Math.max(n, parseInt(m[1], 10) + 1);
    });
    var L = { id: id, name: 'Color ' + n, visible: true, type: 'fill', dots: [] };
    var idx = state.layers.findIndex(function (l) { return l.id === state.activeLayerId; });
    if (idx === -1) idx = 0;
    state.layers.splice(idx + 1, 0, L);
    state.activeLayerId = id;
    state.selectedId = null;
    state.selectedGapId = null;
    state.selectedDotId = null;
    renderLayerPanel();
    renderSelectedPanel();
    renderLane();
    renderPreview();
    toast('Color layer added. Click the preview to place a color dot');
  }

  function removeLayer(id) {
    if (state.layers.length <= 1) { toast('Keep at least one layer.'); return; }
    var idx = state.layers.findIndex(function (l) { return l.id === id; });
    if (idx === -1) return;
    state.keyframes = state.keyframes.filter(function (k) { return k.layer !== id; });
    state.layers.splice(idx, 1);
    if (state.activeLayerId === id) state.activeLayerId = state.layers[0].id;
    var sel = state.keyframes.find(function (k) { return k.id === state.selectedId; });
    if (!sel) state.selectedId = null;
    // A dot on the removed layer can't stay selected.
    if (state.selectedDotId && layerOfDot(state.selectedDotId) === null) state.selectedDotId = null;
    applyWorkSize();
    refreshDirty();
    renderAll();
    scheduleGenerate();
  }

  function renderLayerPanel() {
    var L = layerById(state.activeLayerId);
    el.layerNameLabel.textContent = L ? L.name : '';
    if (el.layerMenuLabel) el.layerMenuLabel.textContent = L ? L.name : 'Layer';
    el.layerVisible.checked = L ? L.visible !== false : true;
    el.btnRemoveLayer.disabled = state.layers.length <= 1;
  }

  // Assets panel (left column): the image library (state.assets). Loading a
  // file only adds it to the library; keyframes are placed by dragging an
  // asset onto the timeline. Tiles use a custom pointer drag (native HTML5
  // DnD cursors are browser-controlled and often show a no-drop X, so the
  // drag uses its own ghost with a grabbing cursor). An asset lands only
  // when released over the timeline.

  var assetDrag = { active: false, ghost: null, spring: null, anim: 0 };
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

  // Swing physics for the drag ghost: the card follows the cursor on a soft
  // position spring and tilts toward its own velocity. Rotation and the
  // drop-in scale are damped springs, so the card swings while moving, settles
  // with a small wobble when it stops, and bounces slightly on pickup.
  var GHOST_W2 = 28; // half of .asset-ghost width/height (56px)
  function ghostFrame() {
    var g = assetDrag.ghost, s = assetDrag.spring;
    if (!g || !s) { assetDrag.anim = 0; return; }
    // Position spring toward the cursor.
    s.x += (s.tx - s.x) * 0.32;
    s.y += (s.ty - s.y) * 0.32;
    // Smoothed velocity from the cursor's movement.
    var vx = s.tx - s.px, vy = s.ty - s.py;
    s.px = s.tx; s.py = s.ty;
    s.vx = s.vx * 0.78 + vx * 0.22;
    s.vy = s.vy * 0.78 + vy * 0.22;
    // Damped rotation spring toward the velocity tilt (radians).
    var target = clamp(s.vx * 0.052 + s.vy * 0.018, -0.42, 0.42);
    s.rotV += (target - s.rot) * 0.045 - s.rotV * 0.13;
    s.rot += s.rotV;
    // Damped scale spring: 0.6 to 1 on pickup, with a slight overshoot bounce.
    s.scaleV += (1 - s.scale) * 0.05 - s.scaleV * 0.16;
    s.scale += s.scaleV;
    g.style.transform = 'translate(' + (s.x - GHOST_W2) + 'px,' + (s.y - GHOST_W2) + 'px)' +
      ' rotate(' + (s.rot * 57.2958) + 'deg) scale(' + s.scale + ')';
    assetDrag.anim = requestAnimationFrame(ghostFrame);
  }

  function beginAssetDrag(a, startX, startY) {
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
    assetDrag.spring = {
      x: startX, y: startY, tx: startX, ty: startY, px: startX, py: startY,
      vx: 0, vy: 0, rot: 0, rotV: 0, scale: 0.6, scaleV: 0
    };
    if (assetDrag.anim) cancelAnimationFrame(assetDrag.anim);
    assetDrag.anim = requestAnimationFrame(ghostFrame);
  }

  function moveAssetDrag(clientX, clientY) {
    var s = assetDrag.spring;
    if (s) { s.tx = clientX; s.ty = clientY; }
    if (isOverTimeline(clientX, clientY)) showDropGuideAt(clientX);
    else hideDropGuide();
  }

  function endAssetDrag(a, clientX, clientY) {
    if (assetDrag.anim) { cancelAnimationFrame(assetDrag.anim); assetDrag.anim = 0; }
    if (assetDrag.ghost) { assetDrag.ghost.remove(); assetDrag.ghost = null; }
    assetDrag.spring = null;
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
        beginAssetDrag(a, startX, startY);
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
  // Layer rows have mixed heights now (fill layers are thin), so pick the row
  // whose midpoint is nearest below the cursor instead of assuming a uniform
  // height.
  function layerIndexAtY(clientY) {
    var rows = el.lane.querySelectorAll('.layer-row');
    if (!rows.length) return 0;
    var laneRect = el.lane.getBoundingClientRect();
    var y = clientY - laneRect.top;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i].getBoundingClientRect();
      var mid = (r.top - laneRect.top) + r.height / 2;
      if (y < mid) return i;
    }
    return rows.length - 1;
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
      // Reordering changes which fills color each layer, so the baked gap
      // composites (and their stamps) change: regenerate.
      refreshDirty();
      scheduleGenerate(60);
    }
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
  }

  function renderAssets() {
    var imgs = state.assets;
    // Skip the DOM rebuild when the panel already matches: same tile count
    // (an empty panel shows one placeholder) and the same image set.
    assetImgs = new Set(imgs.map(function (a) { return a.img; }));
    if (el.assetGrid.childElementCount === (imgs.length || 1)) return;
    assetCache = imgs.slice();
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
      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'asset-del';
      del.title = 'Remove from library';
      del.textContent = '×';
      del.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
      del.addEventListener('click', function (e) {
        e.stopPropagation();
        removeAsset(a.img);
      });
      tile.appendChild(del);
      tile.addEventListener('pointerdown', function (e) { startAssetPointerDrag(e, a); });
      el.assetGrid.appendChild(tile);
    });
  }

  function removeAsset(imgSrc) {
    var i = state.assets.findIndex(function (a) { return a.img === imgSrc; });
    if (i === -1) return;
    state.assets.splice(i, 1);
    renderAssets();
  }

  function selectGap(id) {
    state.selectedGapId = id || null;
    state.selectedId = null;
    state.selectedDotId = null;
    renderSelectedPanel();
    renderLane();
  }

  // Select a color dot (from a fill layer): shows its properties in the right
  // panel and makes its layer the active one.
  function selectDot(id) {
    var L = layerOfDot(id);
    if (!L) return;
    state.selectedDotId = id;
    state.selectedId = null;
    state.selectedGapId = null;
    state.activeLayerId = L.id;
    renderLayerPanel();
    renderSelectedPanel();
    renderLane();
    renderPreview();
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
    scheduleGenerate(50);
  }

  function applyBlurChange(patch) {
    var id = state.selectedGapId;
    if (!id) return;
    setGapBlur(id, patch);
    delete state.generated[id];
    delete state.gapMeta[id];
    refreshDirty();
    renderSelectedPanel();
    renderLane();
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
  // displayed. Keyframe holds and gap lengths are therefore respected: a
  // keyframe that holds for 0.5s really stays on screen 0.5s, instead of
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
    lastPreview = null; // force a clean redraw, clearing editor-only ghosts/markers
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

  // Add files to the image library only; nothing is placed on the timeline.
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
      return added;
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

  function setGenStatus(kind, text) {
    el.genStatus.className = 'status ' + kind;
    el.genStatus.textContent = text || '';
  }

  // Progress bar updates are throttled: they write three DOM properties per
  // frame and generation can complete hundreds of frames, so pushing every
  // frame would thrash layout on the main thread during a run.
  var genProgTimer = null;
  var genProgLabel = null;
  var genProgPct = 0;
  function setGenProgress(label, pct) {
    genProgLabel = label;
    genProgPct = pct;
    if (genProgTimer) return;
    genProgTimer = setTimeout(flushGenProgress, 80);
  }
  function flushGenProgress() {
    if (genProgTimer) { clearTimeout(genProgTimer); genProgTimer = null; }
    if (genProgLabel == null) return;
    var label = genProgLabel, pct = genProgPct;
    genProgLabel = null;
    el.genProgress.classList.remove('hidden');
    el.genFill.style.width = clamp(pct, 0, 100) + '%';
    el.genLabel.textContent = label;
    el.genMeta.textContent = Math.round(pct) + '%';
  }

  // Generation runs in the background worker; only missing frames are
  // generated, and it auto-runs (debounced) after every change.

  // Reused rasterization canvas; allocating one per frame is GC churn during
  // generation (dataToDataURL runs once per generated frame).
  var encodeCanvas = null;
  var encodeCtx = null;
  function dataToDataURL(data, w, h) {
    if (!encodeCanvas) {
      encodeCanvas = document.createElement('canvas');
      encodeCtx = encodeCanvas.getContext('2d');
    }
    if (encodeCanvas.width !== w || encodeCanvas.height !== h) {
      encodeCanvas.width = w;
      encodeCanvas.height = h;
    }
    var imageData = encodeCtx.createImageData(w, h);
    imageData.data.set(data);
    encodeCtx.putImageData(imageData, 0, 0);
    return encodeCanvas.toDataURL('image/png');
  }

  // Rasterize one keyframe image to a raw RGBA buffer at working size (clear
  // transparent so cut-out characters keep their alpha through interpolation).
  // Buffers are cached by (image src, size): with gap chunking the same
  // keyframe pair is rasterized once per chunk, so without this a 4-chunk gap
  // redraws both canvases 4×. Capped small: each entry is a full frame's RGBA.
  var drawCache = new Map();
  function drawImageToData(img, w, h) {
    var key = (img.src || img) + '|' + w + 'x' + h;
    if (drawCache.has(key)) return drawCache.get(key);
    var canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    drawContain(ctx, img, w, h);
    var data = ctx.getImageData(0, 0, w, h).data;
    if (drawCache.size > 16) drawCache.clear();
    drawCache.set(key, data);
    return data;
  }

  // matteK / opacity decision is a property of the keyframe PAIR, not the
  // chunk: memoize it per (endpoint images, size) so chunked jobs don't each
  // re-run isOpaque + pickKeyColor over the full frame.
  var matteMemo = new Map();
  function matteFor(gap, aData, bData) {
    var key = gap.from.img + '>' + gap.to.img + '|' + workW + 'x' + workH +
      '|' + layerFillSig(gap.layer, gap.from.time) + '|' + layerFillSig(gap.layer, gap.to.time);
    if (matteMemo.has(key)) return matteMemo.get(key);
    var n = workW * workH;
    var m = { opaque: morph.isOpaque(aData) && morph.isOpaque(bData), K: null };
    if (!m.opaque) m.K = morph.pickKeyColor(aData, bData, n);
    if (matteMemo.size > 64) matteMemo.clear();
    matteMemo.set(key, m);
    return m;
  }

  // Generate one gap's missing frames. The endpoints are the layer's own two
  // keyframe images. Fully opaque gaps interpolate directly (best quality).
  // Gaps with transparency get the chroma-key matte treatment: the transparent
  // background is painted a key color absent from the frame (encodeMatte), the
  // model interpolates a clean opaque image, and afterwards the frame's alpha is
  // taken from the mesh-union alpha warp of the ORIGINAL keyframes (crisp
  // silhouette) while the key tint is removed from the RGB (removeKey), so
  // cut-out characters get model-quality colors without the transparent-pixel
  // garbage. Dispatches to the worker when available; otherwise runs inline
  // (mesh warp fallback path).
  function generateGap(gap, missing, cbs) {
    var missingList = missing.map(function (idx) {
      return { idx: idx, t: idx / (gap.genCount + 1) };
    });
    return Promise.all([loadImage(gap.from.img), loadImage(gap.to.img)]).then(function (imgs) {
      if (cbs.cancelled()) return;
      // Bake the color fills into each endpoint: the gap interpolates the
      // composite of line art + colors, so the colors warp with the line art
      // instead of being flood-filled per frame (which leaks on moving art).
      var bakedA = endpointBake(imgs[0], gap.layer, gap.from.time, workW, workH);
      var bakedB = endpointBake(imgs[1], gap.layer, gap.to.time, workW, workH);
      var aData = bakedA || drawImageToData(imgs[0], workW, workH);
      var bData = bakedB || drawImageToData(imgs[1], workW, workH);
      var m = matteFor(gap, aData, bData);
      var matteK = m.K;
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
          // Cached buffers must be copied before transfer (transfer detaches).
          var aBuf = aData.slice().buffer, bBuf = bData.slice().buffer;
          var extra = {};
          var transfer = [aBuf, bBuf];
          // The matte memo already computed opacity; pass it so the worker
          // skips its own isOpaque scan of both buffers.
          extra.opaque = !!m.opaque;
          if (matteK) {
            // Only the key color is sent: the worker re-encodes the matte from
            // the originals itself (it needs them anyway for the alpha warp),
            // so no duplicated matte buffers are transferred per job.
            extra.matteK = matteK;
          }
          workers[wi].postMessage(Object.assign({
            type: 'generate-gap',
            jobId: jobId,
            aData: aBuf, bData: bBuf,
            width: workW, height: workH,
            fromTime: gap.fromTime, toTime: gap.toTime,
            mode: gap.mode,
            squash: gapSquashOpts(gap.id),
            blur: gapBlurOpts(gap.id),
            missing: missingList
          }, extra), transfer);
        }).catch(function (err) {
          // Worker died mid-job: run the same gap inline instead of failing.
          if (cbs.cancelled()) throw err;
          console.error('Worker job failed, running inline:', err);
          return generateGapInline(aData, bData, gap, missingList, cbs, matteK);
        });
      }
      return generateGapInline(aData, bData, gap, missingList, cbs, matteK);
    });
  }

  function generateGapInline(aData, bData, gap, missingList, cbs, matteK) {
    var meshes = null;
    var flowPromise = null;
    // Flow is needed for the mesh fallback and the alpha warp. Matte-encoded
    // inputs are opaque, so the ML path skips its own alpha handling; the frame
    // alpha then comes from warpAlpha of the ORIGINAL keyframes. `opaque`
    // reflects the ORIGINAL keyframes: a matte gap still needs the alpha pass.
    var opaque = morph.isOpaque(aData) && morph.isOpaque(bData);
    var n = workW * workH;
    // The matte (opaque) input is used for the model so it never sees
    // transparent pixels; the original buffers feed the alpha warp. The OPTICAL
    // FLOW runs on texture-extended originals (extendTexture), because thin line art
    // on a uniform background starves block matching and would otherwise give
    // ~0 flow → a double-exposed crossfade.
    var aFlow = matteK ? morph.encodeMatte(new Uint8ClampedArray(aData), n, matteK) : aData;
    var bFlow = matteK ? morph.encodeMatte(new Uint8ClampedArray(bData), n, matteK) : bData;
    // Model-driven opacity: alpha channel as grayscale for a second model pass.
    var aGray = matteK ? morph.alphaToGray(aData, workW, workH) : null;
    var bGray = matteK ? morph.alphaToGray(bData, workW, workH) : null;
    // Same static-gap shortcuts as the worker: duplicate keyframes skip both
    // model passes; identical alpha masks skip the alpha pass (removeKey stamps
    // the static mask with the same math the model would produce).
    var framesIdentical = morph.buffersEqual(aData, bData);
    var staticAlpha = null;
    if (!framesIdentical && matteK && morph.sameAlpha(aData, bData, n)) {
      // removeKey takes a per-pixel alpha array (0..255), not an RGBA buffer.
      var sa = new Uint8Array(n);
      for (var p = 0, i = 3; p < n; p++, i += 4) sa[p] = aData[i];
      staticAlpha = sa;
    }
    // Textured flow inputs are built lazily inside ensureMeshes; the ML path never
    // needs the flow and extendTexture is an expensive distance transform.
    var flowBg = null;
    var aFlowTex = null, bFlowTex = null;
    var flowOpts = { maxSearchR: 8 };
    var ensureMeshes = function () {
      if (meshes) return Promise.resolve();
      if (flowPromise) return flowPromise;
      if (!aFlowTex) {
        if (opaque) { aFlowTex = aData; bFlowTex = bData; }
        else {
          flowBg = morph.flowBgColor(aData, bData, n);
          aFlowTex = morph.extendTexture(aData, workW, workH, 10, flowBg);
          bFlowTex = morph.extendTexture(bData, workW, workH, 10, flowBg);
        }
      }
      if (cbs.onProgress) cbs.onProgress('Preparing interpolation…', 0);
      flowPromise = morph.computeFlowBoth(aFlowTex, bFlowTex, workW, workH, flowOpts, function (frac) {
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
      // Apply the original keyframes' mesh-warped alpha + strip the key tint.
      // Transparent gaps always need the meshes (flow) for this.
      var applyAlpha = function (rgba) {
        var alpha = morph.warpAlphaDense(aData, bData, meshes.flowAB, meshes.flowBA, workW, workH, t);
        if (matteK) morph.removeKey(rgba, n, matteK, alpha);
        else {
          for (var p = 0, q = 0; p < n; p++, q += 4) rgba[q + 3] = alpha[p];
        }
      };
      // Motion blur post-process: smears the frame along its motion, easing
      // in/out over the gap. Needs the meshes, so it forces the lazy flow even
      // on the opaque-ML path that would otherwise skip it.
      var blur = gapBlurOpts(gap.id);
      var blurOn = !!(blur.on && blur.intensity > 0);
      var finish = function (rgba, ai) {
        if (!blurOn) { done(rgba, ai); return Promise.resolve(); }
        return ensureMeshes().then(function () {
          if (cbs.cancelled()) return;
          done(morph.motionBlurFrame(rgba, meshes, workW, workH, t, blur.intensity), ai);
        });
      };
      // Squash: affine squash-and-stretch along the detected motion
      // direction, pivoted on the moving mass (no mesh warp, no crossfade).
      if (gap.mode === 'squash') {
        return ensureMeshes().then(function () {
          var frame = morph.squashStretchFrame(aFlow, bFlow, meshes, workW, workH, t, gapSquashOpts(gap.id));
          if (!opaque) applyAlpha(frame);
          return finish(frame, false);
        });
      }
      // The model interpolates the matte (opaque) input; transparency comes from
      // the mesh-union alpha warp of the original keyframes (crisp silhouette).
      // Fully opaque gaps skip all of it: the result is byte-identical and a
      // full mesh warp per frame is avoided. Thin line art renders with the
      // dense per-pixel morph (the coarse mesh averages strokes to ~0 → ghosting).
      var renderMorph = function () {
        if (opaque) return morph.morphFrameMesh(aFlow, bFlow, meshes, workW, workH, t);
        return morph.morphFrame(aFlow, bFlow, meshes.flowAB, meshes.flowBA, workW, workH, t);
      };
      if (cbs.aiReady()) {
        // Duplicate keyframes: every inbetween IS the keyframe, so ship a copy
        // and skip both model passes.
        if (framesIdentical) {
          return finish(new Uint8ClampedArray(aData), true);
        }
        return model.interpolate(aFlow, bFlow, workW, workH, t).then(function (aiOut) {
          if (cbs.cancelled()) return;
          if (opaque) return finish(aiOut, true);
          // Static silhouette: stamp the shared mask with removeKey and skip
          // the alpha model pass entirely.
          if (staticAlpha) {
            morph.removeKey(aiOut, n, matteK, staticAlpha);
            return finish(aiOut, true);
          }
          if (aGray) {
            // Model-driven alpha: interpolate the alpha channel as grayscale.
            // Output consumed raw (channel 0), so no RGBA conversion needed.
            return model.interpolate(aGray, bGray, workW, workH, t, true).then(function (alphaTensor) {
              if (cbs.cancelled()) return;
              morph.applyGrayAlphaRaw(aiOut, alphaTensor, n, matteK);
              return finish(aiOut, true);
            }, function () {
              if (cbs.cancelled()) return;
              return ensureMeshes().then(function () {
                if (cbs.cancelled()) return;
                applyAlpha(aiOut);
                return finish(aiOut, true);
              });
            });
          }
          return ensureMeshes().then(function () {
            if (cbs.cancelled()) return;
            applyAlpha(aiOut);
            return finish(aiOut, true);
          });
        }).catch(function (err) {
          if (cbs.cancelled()) return;
          console.error('ML inbetween failed, using mesh warp:', err);
          return ensureMeshes().then(function () {
            var frame = renderMorph();
            if (!opaque) applyAlpha(frame);
            return finish(frame, false);
          });
        });
      }
      return ensureMeshes().then(function () {
        var frame = renderMorph();
        if (!opaque) applyAlpha(frame);
        return finish(frame, false);
      });
    };
    var i = 0;
    var next = function () {
      if (cbs.cancelled() || i >= missingList.length) return Promise.resolve();
      var m = missingList[i];
      var label = (gap.mode === 'squash' ? 'squash frame ' : (cbs.aiReady() ? 'ML inbetween ' : 'mesh warp ')) + m.idx + '/' + gap.genCount;
      i++;
      return emit(m).then(function () {
        if (cbs.onProgress) cbs.onProgress(label, i / missingList.length);
        return new Promise(function (r) { setTimeout(r, 0); }).then(next);
      });
    };
    return next();
  }

  var genTimer = null;
  var genSeq = 0;                // incremented per schedule: stale callbacks no-op
  var modelGate = null;          // promise resolving when model load settles
  var modelGateResolve = null;   // resolve() for the gate above
  // Coalesced view refresh during generation: rebuilding the lane + filmstrip on
  // every completed frame is O(frames²) with async thumb composites; heavy edits
  // (many cancels/restarts) make it crawl. Updates are throttled to ~150ms and a
  // final flush happens when the run finishes.
  var genViewTimer = null;
  var genViewDirty = false;
  function scheduleGenView() {
    genViewDirty = true;
    if (genViewTimer) return;
    genViewTimer = setTimeout(function () {
      genViewTimer = null;
      if (!genViewDirty) return;
      genViewDirty = false;
      renderLane();
      renderFilmstrip();
    }, 150);
  }
  function flushGenView() {
    genViewDirty = false;
    if (genViewTimer) { clearTimeout(genViewTimer); genViewTimer = null; }
    renderLane();
    renderFilmstrip();
  }
  function scheduleGenerate(delay) {
    clearTimeout(genTimer);
    var token = ++genSeq;
    // Edit-driven schedules (50-60ms) are too twitchy for quick successive
    // edits: each one fired its own generation run, and during a run each one
    // cancelled and restarted it, so a burst of edits stacked one restart per
    // edit and generation lagged further and further behind. Floor the delay
    // so a burst shares a single run that starts once the edits settle, and
    // absorb edits that land mid-run into one restart.
    var d = delay == null ? 500 : Math.max(delay, EDIT_DEBOUNCE_MS);
    if (state.genRun && d < REGEN_ABSORB_MS) d = REGEN_ABSORB_MS;
    genTimer = setTimeout(function () {
      // Wait for the model download/compile to settle so gaps are generated
      // with ML when possible (the launch overlay blocks interaction anyway).
      (modelGate || Promise.resolve()).then(function () {
        if (token !== genSeq) return; // superseded by a newer schedule
        if (state.genRun) { state.pendingRegen = true; cancelRun(); }
        else runGeneration();
      });
    }, d);
  }

  function cancelRun() {
    if (!state.genRun) return;
    state.genRun.cancelled = true;
    workers.forEach(function (w) {
      try { w.postMessage({ type: 'cancel' }); } catch (e) {}
    });
    // The pump waits on outstanding worker jobs; a busy or crashed worker may
    // never answer a cancel, which would wedge the run and block all future
    // auto-generation (heavy editing churns cancel/restart constantly). Settle
    // every outstanding job now so the run drains immediately; late replies are
    // ignored because their jobIds are already gone.
    Object.keys(workerJobs).forEach(function (id) {
      var j = workerJobs[id];
      if (!j) return;
      delete workerJobs[id];
      decBusy(j.worker);
      j.resolve();
    });
  }

  function runGeneration() {
    if (state.genRun) return;
    // Per-layer gaps: each layer interpolates its own timeline, so gaps are
    // independent and can all run concurrently.
    var gaps = [];
    state.layers.forEach(function (L) {
      computeGaps(L.id).forEach(function (g) {
        if (g.genCount > 0 && !gapComplete(g)) gaps.push(g);
      });
    });
    // A gap's missing frames are split across the worker pool: each chunk runs
    // as its own job on a different worker, so a timeline with one big gap (the
    // common case) renders on every core instead of a single worker. Chunks of
    // the same gap recompute the same deterministic optical flow; flow is a
    // small share of a gap's cost and the rendered frames are byte-identical.
    var tasks = [];
    var total = 0;
    gaps.forEach(function (gap, gi) {
      var missing = computeMissing(gap);
      if (!missing.length) return;
      var parts = Math.max(1, Math.min(workers.length || 1, missing.length));
      var per = Math.ceil(missing.length / parts);
      for (var ci = 0; ci < parts; ci++) {
        var chunk = missing.slice(ci * per, (ci + 1) * per);
        if (!chunk.length) break;
        tasks.push({ gap: gap, missing: chunk, gi: gi, ci: ci, parts: parts });
        total += chunk.length;
      }
    });
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
    var concurrency = Math.min(6, Math.max(1, workers.length || 1));
    var idx = 0, active = 0, firstErr = null;
    var generateOne = function (task) {
      if (run.cancelled) return Promise.resolve();
      var gap = task.gap;
      var missing = task.missing;
      if (!missing.length) return Promise.resolve();
      var gen = state.generated[gap.id] || (state.generated[gap.id] = []);
      // Index by frame idx so concurrent chunks of one gap merge in O(1)
      // instead of a linear find per frame.
      var genIndex = {};
      gen.forEach(function (f) { if (f) genIndex[f.idx] = f; });
      // Stamp now, so a later refresh keeps the frames we produce here even
      // if the run is cancelled (only the tail stays dirty).
      state.gapMeta[gap.id] = gapStamp(gap);
      var label = 'Gap ' + (task.gi + 1) + '/' + gaps.length + (task.parts > 1 ? ' · part ' + (task.ci + 1) + '/' + task.parts : '');
      setGenStatus('downloading', label + ' (' + missing.length + ' frames)');
      return generateGap(gap, missing, {
        aiReady: function () { return model.isReady(); },
        cancelled: function () { return run.cancelled; },
        onProgress: function (l, gapFrac) {
          setGenProgress(label + ' · ' + l, ((done + gapFrac) / total) * 100);
        },
        onFrame: function (frame) {
          // Merge by index so a partially-generated gap is only topped up.
          var found = genIndex[frame.idx];
          if (found) { for (var k in found) found[k] = frame[k]; }
          else { gen.push(frame); genIndex[frame.idx] = frame; }
          done++;
          setGenProgress(
            label + ' · ' + (frame.ai ? 'ML frame ' : 'warp ') + frame.idx + '/' + gap.genCount,
            (done / total) * 100
          );
        }
      }).then(function () {
        if (!run.cancelled) {
          gen.sort(function (a, b) { return a.idx - b.idx; });
          refreshDirty();
        }
        scheduleGenView();
      });
    };
    // Run up to `concurrency` chunk jobs at once (one per worker) instead of
    // one big chain, so idle cores stay busy while a slow gap is generating.
    var completion = new Promise(function (resolve, reject) {
      function pump() {
        if (run.cancelled || firstErr) idx = tasks.length; // stop after cancel/error
        while (!run.cancelled && !firstErr && active < concurrency && idx < tasks.length) {
          var task = tasks[idx];
          idx++;
          active++;
          generateOne(task).then(function () {
            active--;
            pump();
          }, function (err) {
            active--;
            if (!firstErr) firstErr = err;
            pump();
          });
        }
        if (idx >= tasks.length && active === 0) {
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
      flushGenProgress();
      el.genProgress.classList.add('hidden');
      flushGenView();
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

  // Export resolution + ML upscaling

  // The available export resolutions: the working size itself, integer
  // multiples of it (ML upscale when > 1x), and common fixed short-edge
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
      opt.textContent = o.label + (o.ai ? ' \u00b7 ML upscale' : '');
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
  // than the working size the ML upscaler (worker) runs first, using a 4x
  // ESRGAN-style model, and the result is resized to the exact target with high-
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
    // Target is larger: try the ML upscaler first.
    if (workers.length) {
      return upscaleViaWorker(canvas).then(function (hi) {
        return drawScaled(hi);
      }).catch(function (err) {
        if (err && err.message === 'Cancelled') throw err;
        if (!upscaleModelWarned) {
          upscaleModelWarned = true;
          toast('ML upscaler unavailable (' + err.message + '), using high-quality resize');
        }
        return drawScaled(canvas);
      });
    }
    return Promise.resolve(drawScaled(canvas));
  }

  // Send one frame to the worker for ML 4x upscaling. Resolves with a canvas
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
          if (frac >= 1) setExportProgress('Upscaler ready, rendering…', 95);
          else setExportProgress('Downloading ML upscaler ' + Math.round(frac * 100) + '%…', frac * 100);
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
      // r = { data: ArrayBuffer, width, height }: build a canvas from it.
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
        // Composite every layer at this frame's time (ML-upscaled to target).
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
  // Video container formats for export. Each maps to a Mediabunny output
  // format class, the codec families that container accepts (tried in order,
  // probed for real encoder support per browser), and download metadata.
  var EXPORT_FORMATS = {
    mp4:  { label: 'MP4',     fmt: 'Mp4OutputFormat',    ext: 'mp4',  mime: 'video/mp4',        codecs: ['avc', 'vp9', 'av1'], opts: { fastStart: 'in-memory' }, recordable: true  },
    webm: { label: 'WebM',    fmt: 'WebMOutputFormat',   ext: 'webm', mime: 'video/webm',       codecs: ['vp9', 'av1', 'vp8'], opts: {}, recordable: true, preferWebm: true },
    mkv:  { label: 'MKV',     fmt: 'MkvOutputFormat',    ext: 'mkv',  mime: 'video/x-matroska', codecs: ['avc', 'vp9', 'av1'], opts: {} },
    mov:  { label: 'MOV',     fmt: 'MovOutputFormat',    ext: 'mov',  mime: 'video/quicktime',  codecs: ['avc', 'vp9', 'av1'], opts: { fastStart: 'in-memory' } },
    ts:   { label: 'MPEG-TS', fmt: 'MpegTsOutputFormat', ext: 'ts',   mime: 'video/MP2T',       codecs: ['avc', 'hevc'], opts: {} }
  };

  // Build the codec candidate list for a container from its allowed codec
  // family names. Each candidate is { codec, muxerCodec } where codec is the
  // WebCodecs string and muxerCodec the short name Mediabunny wants.
  function codecCandidates(names) {
    var avcLevels = ['640033', '64002a', '640028', '64001f', '42001f', '42E01E'];
    var list = [];
    names.forEach(function (n) {
      if (n === 'avc') avcLevels.forEach(function (l) { list.push({ codec: 'avc1.' + l, muxerCodec: 'avc' }); });
      else if (n === 'hevc') {
        list.push({ codec: 'hev1.1.6.L123.B0', muxerCodec: 'hevc' });
        list.push({ codec: 'hvc1.1.6.L123.B0', muxerCodec: 'hevc' });
      }
      else if (n === 'vp9') {
        list.push({ codec: 'vp09.00.10.08', muxerCodec: 'vp9' });
        list.push({ codec: 'vp09.00.41.08', muxerCodec: 'vp9' });
      }
      else if (n === 'av1') list.push({ codec: 'av01.0.04M.08', muxerCodec: 'av1' });
      else if (n === 'vp8') list.push({ codec: 'vp8', muxerCodec: 'vp8' });
    });
    return list;
  }

  function pickVideoMime(large, webm) {
    if (typeof window.MediaRecorder === 'undefined') return null;
    var candidates = webm
      ? ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
      : large
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

  function exportVideo(target, fmtName) {
    var frames = buildPlaybackFrames();
    if (!frames.length) { toast('Nothing to export.'); return; }
    var fmt = EXPORT_FORMATS[fmtName] || EXPORT_FORMATS.mp4;
    // WebCodecs encodes each frame as it's produced (composite → ML-upscale →
    // encode → discard), so only one frame is in memory at a time, no matter
    // how large the export resolution is. It also handles 4K+ frames that
    // Chrome's MediaRecorder H.264 silently fails on. MediaRecorder is kept as
    // a fallback for browsers without WebCodecs (MP4/WebM only; the other
    // containers need WebCodecs muxing).
    if (window.VideoEncoder && window.Mediabunny) {
      exportVideoWebCodecs(frames, target, fmt);
      return;
    }
    if (!fmt.recordable) {
      hideExportOverlay();
      endExport();
      setGenStatus('error', fmt.label + ' export needs WebCodecs in this browser.');
      toast(fmt.label + ' export needs a browser with WebCodecs (Chrome, Edge or Safari).');
      return;
    }
    exportVideoRecorder(frames, target, fmt);
  }

  // Pick the first codec the browser's VideoEncoder really accepts for this
  // container, from the format's allowed codec families. Some browsers lie at
  // isConfigSupported/configure (notably H.264 on Firefox/Linux), so probing
  // encodes one real frame at the target size with a throwaway encoder and
  // only accepts a codec whose encoded output actually arrives.
  // Resolves with { codec, muxerCodec } or null if none are supported.
  function probeCodec(codec, w, h) {
    return new Promise(function (resolve) {
      var enc = null;
      var finished = false;
      var sawOutput = false;
      var timer = setTimeout(function () { finish(false); }, 8000);
      function finish(ok) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        try { if (enc) enc.close(); } catch (e) {}
        resolve(ok);
      }
      try {
        var canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        var ctx = canvas.getContext('2d');
        ctx.fillStyle = '#f00';
        ctx.fillRect(0, 0, w, h);
        enc = new VideoEncoder({
          output: function () { sawOutput = true; },
          error: function () { finish(false); }
        });
        enc.configure({ codec: codec, width: w, height: h, bitrate: 10 * 1000 * 1000 });
        var frame = new VideoFrame(canvas, { timestamp: 0 });
        enc.encode(frame, { keyFrame: true });
        frame.close();
        enc.flush().then(function () { finish(sawOutput); }).catch(function () { finish(false); });
      } catch (e) {
        finish(false);
      }
    });
  }

  function pickVideoCodec(w, h, codecNames) {
    var candidates = codecCandidates(codecNames);
    var i = 0;
    function next() {
      if (i >= candidates.length) return Promise.resolve(null);
      var c = candidates[i++];
      return probeCodec(c.codec, w, h).then(function (ok) { return ok ? c : next(); });
    }
    return next();
  }

  // Encode the animation with WebCodecs + Mediabunny into the requested
  // container: each frame is composited, ML-upscaled to the target size,
  // encoded, and immediately discarded, so even 8x exports never hold more
  // than one frame in memory. Timestamps come from each frame's real duration
  // (holds + gap spacing), matching playback.
  function exportVideoWebCodecs(frames, target, fmt) {
    var durs = playbackDurations(frames);
    var memMB = Math.round(target.w * target.h * 4 / (1024 * 1024)); // one frame at a time
    if (memMB > 256) toast('One 4K-class frame is large; encoding may use ~' + memMB + ' MB.', 6000);
    setExportProgress('Encoding ' + fmt.label + '…', 1);
    pickVideoCodec(target.w, target.h, fmt.codecs).then(function (pick) {
      if (!pick) {
        if (fmt.recordable) { exportVideoRecorder(frames, target, fmt); return; }
        hideExportOverlay();
        endExport();
        setGenStatus('error', 'This browser has no encoder for ' + fmt.label + '.');
        toast('No ' + fmt.label + ' encoder in this browser. Try MP4 or WebM instead.');
        return;
      }
      var MB = window.Mediabunny;
      var muxer = new MB.Output({
        format: new MB[fmt.fmt](fmt.opts),
        target: new MB.BufferTarget()
      });
      var videoSource = new MB.EncodedVideoPacketSource(pick.muxerCodec);
      muxer.addVideoTrack(videoSource);
      var encodeError = null;
      var addChain = Promise.resolve(); // drains Mediabunny's backpressure in order
      var encoder = new VideoEncoder({
        output: function (chunk, meta) {
          // Mediabunny needs a colorSpace in the decoder config (VP9/AV1 in
          // particular); some encoders omit it, so supply a sane default.
          if (meta && meta.decoderConfig && !meta.decoderConfig.colorSpace) {
            meta.decoderConfig.colorSpace = { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false };
          }
          var packet = MB.EncodedPacket.fromEncodedChunk(chunk);
          addChain = addChain
            .then(function () { return videoSource.add(packet, meta); })
            .catch(function (e) { if (!encodeError) encodeError = e; });
        },
        error: function (e) { encodeError = e; }
      });
      encoder.configure({ codec: pick.codec, width: target.w, height: target.h, bitrate: 10 * 1000 * 1000 });

      var ts = 0; // microseconds
      var chain = muxer.start().then(function () {
        var seq = Promise.resolve();
        frames.forEach(function (f, i) {
          seq = seq.then(function () {
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
        return seq;
      }).then(function () {
        if (state.exportCancel) throw new Error('Export cancelled');
        return encoder.flush();
      }).then(function () {
        // Wait for every encoded chunk to be muxed before finalizing.
        return addChain;
      }).then(function () {
        if (encodeError) throw encodeError;
        return muxer.finalize();
      }).then(function () {
        var buf = muxer.target.buffer;
        if (!buf || !buf.byteLength) throw new Error('Encoding produced no data');
        downloadBlob(new Blob([buf], { type: fmt.mime }), 'animation.' + fmt.ext);
        hideExportOverlay();
        endExport();
        setGenStatus('ready', fmt.label + ' exported \u2713');
      }).catch(function (err) {
        try { encoder.close(); } catch (e2) {}
        try { muxer.cancel().catch(function () {}); } catch (e3) {}
        endExport();
        hideExportOverlay();
        if (err && err.message === 'Export cancelled') setGenStatus('error', 'Export cancelled');
        else setGenStatus('error', fmt.label + ' export failed: ' + err.message);
      });
    }).catch(function (err) {
      endExport();
      hideExportOverlay();
      setGenStatus('error', fmt.label + ' export failed: ' + err.message);
    });
  }

  // Fallback: MediaRecorder canvas capture (browsers without WebCodecs).
  // Only MP4 and WebM can be produced this way.
  function exportVideoRecorder(frames, target, fmt) {
    var large = target.w * target.h > 1920 * 1080; // H.264 MediaRecorder is fragile at 4K+
    var mime = pickVideoMime(large, fmt.preferWebm);
    if (!mime) {
      setGenStatus('error', 'Video recording is not supported in this browser.');
      hideExportOverlay();
      endExport();
      toast('This browser cannot record video. Use Chrome, Edge or Safari for ' + fmt.label + ' export.');
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

    setExportProgress((isMp4 ? 'Recording MP4…' : 'Recording WebM…'), 1);

    // Composite (and ML-upscale) every layer per frame time, then record.
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
        var blob = new Blob(chunks, { type: isMp4 ? 'video/mp4' : 'video/webm' });
        if (!blob.size) {
          setGenStatus('error', 'Recording produced no data. Try again.');
          return;
        }
        downloadBlob(blob, isMp4 ? 'animation.mp4' : 'animation.webm', blob.type);
        setGenStatus('ready', fmt.label + ' exported \u2713');
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
    var fmtLabel = EXPORT_FORMATS[fmt] ? EXPORT_FORMATS[fmt].label : fmt.toUpperCase();
    showExportOverlay(
      fmt === 'frame' ? 'Exporting current frame' : 'Exporting ' + fmtLabel,
      opt.label + (opt.ai ? ' · ML upscale' : '')
    );
    setExportProgress('Waiting for frames to finish generating…', 0);
    waitForGeneration().then(function () {
      if (state.exportCancel) throw new Error('Export cancelled');
      if (fmt === 'png') exportPNGZip(target);
      else if (fmt === 'gif') exportGIF(target);
      else if (fmt === 'frame') exportCurrentFrame(target);
      else exportVideo(target, fmt);
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

  // Drag a color-dot chip on the timeline: the body moves the whole active
  // window, the edges resize start/end. Dots never interpolate; only their
  // window shifts.
  function startDotDrag(e, chip) {
    var id = chip.dataset.dot;
    var d = dotById(id);
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    // Read the chip's rect BEFORE selectDot: it re-renders the lane and
    // detaches this element, and a detached element reports a zero rect,
    // which would make the edge test below always pick 'end' (resize).
    var rect = chip.getBoundingClientRect();
    var edge = 'body';
    if (e.clientX - rect.left < 8) edge = 'start';
    else if (rect.right - e.clientX < 8) edge = 'end';
    selectDot(id);
    var startX = e.clientX;
    var s0 = d.start, e0 = d.end;
    var moved = false;
    var tip = document.createElement('div');
    tip.className = 'kf-drag-tip';
    chip.appendChild(tip);
    function attachTip() {
      var fresh = el.lane.querySelector('.fill-dot[data-dot="' + id + '"]');
      if (fresh) fresh.appendChild(tip);
    }
    function updateTip() { tip.textContent = fmtTime(d.start) + ' to ' + fmtTime(d.end); }
    updateTip();

    function onMove(ev) {
      var dt = (ev.clientX - startX) / state.zoom;
      var snapT = function (t) { return state.snap ? Math.round(t * state.fps) / state.fps : t; };
      var minDur = 1 / state.fps;
      if (edge === 'body') {
        var ns = Math.max(0, snapT(s0 + dt));
        var ne = Math.max(ns + minDur, e0 + (ns - s0));
        d.start = ns; d.end = ne;
      } else if (edge === 'start') {
        d.start = Math.min(snapT(s0 + dt), e0 - minDur);
      } else {
        d.end = Math.max(snapT(e0 + dt), d.start + minDur);
      }
      if (d.start < 0) { d.end -= d.start; d.start = 0; }
      moved = true;
      renderLane();
      attachTip();
      updateTip();
      renderPreview();
    }
    function onUp() {
      tip.remove();
      el.timeline.removeEventListener('pointermove', onMove);
      el.timeline.removeEventListener('pointerup', onUp);
      el.timeline.removeEventListener('pointercancel', onUp);
      if (moved) {
        renderAll();
        invalidateDots();
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
      v: 10,
      settings: {
        fps: state.fps, snap: state.snap, zoom: state.zoom,
        res: state.res, keysOnly: state.keysOnly, onion: state.onion, onionCfg: state.onionCfg,
        aspect: state.aspect, aspectRatio: state.aspectRatio,
        customW: state.customW, customH: state.customH
      },
      layers: state.layers.map(function (l) {
        return l.type === 'fill'
          ? { id: l.id, name: l.name, visible: l.visible, type: 'fill', dots: l.dots }
          : { id: l.id, name: l.name, visible: l.visible };
      }),
      activeLayerId: state.activeLayerId,
      assets: state.assets.map(function (a) {
        return { img: a.img, name: a.name, w: a.w, h: a.h };
      }),
      keyframes: state.keyframes.map(function (k) {
        return { id: k.id, layer: k.layer, time: k.time, hold: keyframeHold(k), img: k.img, name: k.name, w: k.w, h: k.h, mix: k.mix || 'source-over' };
      }),
      generated: state.generated,
      gapMeta: state.gapMeta,
      gapType: state.gapType,
      gapSquash: state.gapSquash,
      gapBlur: state.gapBlur
    };
  }

  function applyProjectData(data) {
    var s = data.settings || {};
    state.fps = clamp(parseFloat(s.fps) || 12, 1, 60);
    state.snap = s.snap !== false;
    state.zoom = clamp(parseFloat(s.zoom) || 90, 12, 4000);
    state.res = [512, 448, 384, 320].indexOf(parseInt(s.res, 10)) >= 0 ? parseInt(s.res, 10) : 512;
    state.keysOnly = !!s.keysOnly;
    // Onion prefs: the toggle and its settings are UI prefs (persisted to
    // localStorage on every change). A project file only overrides them when it
    // explicitly carries onion settings; otherwise the user's current prefs
    // (already restored at boot) stay, so loading a project never wipes them.
    if (s.hasOwnProperty('onion')) state.onion = !!s.onion;
    if (s.onionCfg && typeof s.onionCfg === 'object') {
      var c = s.onionCfg;
      state.onionCfg = {
        before: clamp(parseInt(c.before, 10) || 1, 0, 4),
        after: clamp(parseInt(c.after, 10) || 1, 0, 4),
        opacity: clamp(parseFloat(c.opacity) || 0.28, 0.05, 0.9),
        tint: !!c.tint,
        tintColor: (typeof c.tintColor === 'string' && /^#?[0-9a-f]{6}$/i.test(c.tintColor)) ? (c.tintColor[0] === '#' ? c.tintColor : '#' + c.tintColor) : '#ff3b30',
        tintOpacity: clamp(parseFloat(c.tintOpacity) || 0.35, 0.05, 1)
      };
    }
    state.aspect = ['auto', '16:9', '9:16', '4:3', '3:4', '1:1', 'custom', 'manual'].indexOf(s.aspect) >= 0 ? s.aspect : 'auto';
    var ar = parseRatio(s.aspectRatio);
    state.aspectRatio = ar;
    state.customW = clamp(parseInt(s.customW, 10) || 1920, 8, 4096);
    state.customH = clamp(parseInt(s.customH, 10) || 1080, 8, 4096);
    // Layers: projects saved before layers existed are wrapped in one layer.
    var savedLayers = Array.isArray(data.layers) && data.layers.length ? data.layers : null;
    if (savedLayers) {
      state.layers = savedLayers.map(function (l) {
        var base = {
          id: l.id,
          name: l.name || 'Layer',
          visible: l.visible !== false
        };
        if (l.type === 'fill') {
          // Fill layers hold color dots; sanitize every field so a hand-edited
          // project can't crash the renderer.
          base.type = 'fill';
          base.dots = (Array.isArray(l.dots) ? l.dots : []).map(function (d) {
            return {
              id: d && d.id ? String(d.id) : 'D' + (++idSeq),
              x: clamp(parseFloat(d && d.x) || 0, 0, 1),
              y: clamp(parseFloat(d && d.y) || 0, 0, 1),
              color: (typeof (d && d.color) === 'string' && /^#?[0-9a-f]{6}$/i.test(d.color)) ? d.color : '#4f8fff',
              threshold: clamp(parseFloat(d && d.threshold) || 0.5, 0, 1),
              grow: clamp(Math.round(parseFloat(d && d.grow) || 0), 0, 200),
              gradOn: !!(d && d.gradOn),
              gradColor: (typeof (d && d.gradColor) === 'string' && /^#?[0-9a-f]{6}$/i.test(d.gradColor)) ? d.gradColor : '#ffffff',
              gradHeight: clamp(Math.round(parseFloat(d && d.gradHeight) || 24), 4, 400),
              gradDir: ['top', 'bottom', 'left', 'right'].indexOf(d && d.gradDir) >= 0 ? d.gradDir : 'bottom',
              start: Math.max(0, parseFloat(d && d.start) || 0),
              end: Math.max(0, parseFloat(d && d.end) || 0)
            };
          });
          // Normalize: end must be after start (swap/raise as needed).
          base.dots.forEach(function (d) {
            if (d.end <= d.start) d.end = d.start + 1 / state.fps;
          });
        }
        return base;
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
      if (typeof k.mix !== 'string' || ['source-over','multiply','screen','overlay','darken','lighten','color-dodge','color-burn','hard-light','soft-light','difference','exclusion','hue','saturation','color','luminosity'].indexOf(k.mix) < 0) {
        k.mix = 'source-over';
      }
      return k;
    });
    state.generated = (data.generated && typeof data.generated === 'object') ? data.generated : {};
    state.gapMeta = (data.gapMeta && typeof data.gapMeta === 'object') ? data.gapMeta : {};
    state.gapType = (data.gapType && typeof data.gapType === 'object') ? data.gapType : {};
    state.gapSquash = (data.gapSquash && typeof data.gapSquash === 'object') ? data.gapSquash : {};
    state.gapBlur = (data.gapBlur && typeof data.gapBlur === 'object') ? data.gapBlur : {};
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
    // Dots share the id sequence; count them too so new dots never collide
    // with loaded ones (a project could hold only dots).
    state.layers.forEach(function (l) {
      if (l.type === 'fill' && l.dots) {
        l.dots.forEach(function (d) {
          var n = parseInt(String(d.id).replace(/\D/g, ''), 10);
          if (isFinite(n) && n + 1 > idSeq) idSeq = n + 1;
        });
      }
    });
  }

  // File menu: export the project as a .khuwari file (Save) / import one (Load).
  function saveProjectFile() {
    var blob = new Blob([JSON.stringify(projectData(), null, 2)], { type: 'application/json' });
    downloadBlob(blob, 'khuwari-project.khuwari', 'application/json');
    toast('Project saved (.khuwari)');
  }

  function loadProjectFile(file) {
    enterApp();
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
        // Frames saved in the file are reused when valid (same stamps);
        // anything invalidated by the load (different endpoint images, a
        // different frame count) is regenerated automatically.
        scheduleGenerate(100);
        toast('Project loaded');
      } catch (e) {
        toast('Could not load project file. Choose a .khuwari file saved from this app.');
      }
    };
    reader.readAsText(file);
  }

  // ---- start screen ----

  function enterApp() {
    el.startScreen.classList.add('hidden');
  }

  // Wipe everything back to a fresh empty project.
  function newProject() {
    cancelRun();
    pause();
    state.keyframes = [];
    state.assets = [];
    state.layers = [{ id: 'L1', name: 'Layer 1', visible: true }];
    state.activeLayerId = 'L1';
    state.generated = {};
    state.gapMeta = {};
    state.gapType = {};
    state.gapSquash = {};
    state.gapBlur = {};
    state.dirty = new Set();
    state.selectedId = null;
    state.selectedGapId = null;
    state.selectedDotId = null;
    state.playhead = 0;
    state.curIndex = 0;
    applyWorkSize();
    refreshDirty();
    renderAll();
    syncInputs();
    enterApp();
  }

  // Load the bundled example project (example.khuwari) from the start screen's
  // example button (served locally, so no cross-origin fetch restrictions), via
  // the same load path as a user-picked .khuwari.
  function openExample() {
    fetch('example.khuwari').then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.blob();
    }).then(function (blob) {
      loadProjectFile(new File([blob], 'example.khuwari', { type: 'application/json' }));
    }).catch(function (e) {
      toast('Could not load the example project: ' + (e && e.message ? e.message : e));
    });
  }

  function wireEvents() {
    // Tactile button feedback: any .btn gets a quick pop animation on press
    // (the CSS .pop keyframes), so buttons feel physical even without a real
    // ripple. Delegated so dynamically-created buttons get it too.
    document.addEventListener('pointerdown', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('.btn:not(:disabled)') : null;
      if (!btn) return;
      btn.classList.remove('pop');
      void btn.offsetWidth; // restart the animation if it was still running
      btn.classList.add('pop');
    }, true);
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
      syncSlider(el.gapSquashAmount);
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

    var blurDebounce = null;
    el.gapBlurOn.addEventListener('change', function () {
      if (!state.selectedGapId) return;
      var cur = gapBlurOpts(state.selectedGapId);
      applyBlurChange({ on: el.gapBlurOn.checked, intensity: cur.intensity });
    });
    el.gapBlurAmount.addEventListener('input', function () {
      var v = parseFloat(el.gapBlurAmount.value);
      if (!isFinite(v)) return;
      syncSlider(el.gapBlurAmount);
      el.gapBlurValue.textContent = Math.round(v * 100) + '%';
      clearTimeout(blurDebounce);
      blurDebounce = setTimeout(function () { applyBlurChange({ intensity: v }); }, 160);
    });
    el.gapBlurAmount.addEventListener('change', function () {
      clearTimeout(blurDebounce);
      var v = parseFloat(el.gapBlurAmount.value);
      if (!isFinite(v)) return;
      applyBlurChange({ intensity: v });
    });

    el.layerVisible.addEventListener('change', function () {
      var L = layerById(state.activeLayerId);
      if (!L) return;
      L.visible = el.layerVisible.checked;
      // Visibility changes the flattened composite, so every gap's stamp
      // changes and the timeline must regenerate.
      refreshDirty();
      renderAll();
      scheduleGenerate();
    });

    // Color-dot properties (right panel, shown when a dot is selected). Dot
    // edits change the baked composite the gaps interpolate, so the affected
    // gaps must regenerate (the gap stamp carries the fill signature).
    function patchDot(patch) {
      var d = dotById(state.selectedDotId);
      if (!d) return;
      for (var k in patch) d[k] = patch[k];
      if (patch.color) {
        lastDotColor = patch.color;
        try { localStorage.setItem(DOT_COLOR_KEY, lastDotColor); } catch (e) {}
      }
      renderSelectedPanel();
      renderLane();
      renderPreview();
      invalidateDots();
    }
    var dotDebounce = null;
    el.dotColor.addEventListener('input', function () {
      lastDotColor = el.dotColor.value;
      try { localStorage.setItem(DOT_COLOR_KEY, lastDotColor); } catch (e) {}
      patchDot({ color: el.dotColor.value });
    });
    el.dotThreshold.addEventListener('input', function () {
      var v = parseFloat(el.dotThreshold.value);
      if (!isFinite(v)) return;
      syncSlider(el.dotThreshold);
      el.dotThresholdValue.textContent = Math.round(v * 100) + '%';
      clearTimeout(dotDebounce);
      dotDebounce = setTimeout(function () { patchDot({ threshold: v }); }, 120);
    });
    el.dotThreshold.addEventListener('change', function () {
      clearTimeout(dotDebounce);
      var v = parseFloat(el.dotThreshold.value);
      if (isFinite(v)) patchDot({ threshold: v });
    });
    el.dotGrow.addEventListener('input', function () {
      var v = parseFloat(el.dotGrow.value);
      if (!isFinite(v)) return;
      syncSlider(el.dotGrow);
      el.dotGrowValue.textContent = Math.round(v) + 'px';
      clearTimeout(dotDebounce);
      dotDebounce = setTimeout(function () { patchDot({ grow: v }); }, 120);
    });
    el.dotGrow.addEventListener('change', function () {
      clearTimeout(dotDebounce);
      var v = parseFloat(el.dotGrow.value);
      if (isFinite(v)) patchDot({ grow: v });
    });
    el.dotGradOn.addEventListener('change', function () { patchDot({ gradOn: el.dotGradOn.checked }); });
    el.dotGradColor.addEventListener('input', function () { patchDot({ gradColor: el.dotGradColor.value }); });
    el.dotGradDir.addEventListener('change', function () { patchDot({ gradDir: el.dotGradDir.value }); });
    el.dotGradHeight.addEventListener('input', function () {
      var v = parseFloat(el.dotGradHeight.value);
      if (!isFinite(v)) return;
      syncSlider(el.dotGradHeight);
      el.dotGradHeightValue.textContent = Math.round(v) + 'px';
      clearTimeout(dotDebounce);
      dotDebounce = setTimeout(function () { patchDot({ gradHeight: v }); }, 120);
    });
    el.dotGradHeight.addEventListener('change', function () {
      clearTimeout(dotDebounce);
      var v = parseFloat(el.dotGradHeight.value);
      if (isFinite(v)) patchDot({ gradHeight: v });
    });
    el.dotStart.addEventListener('change', function () {
      var d = dotById(state.selectedDotId);
      if (!d) return;
      var v = Math.max(0, parseFloat(el.dotStart.value) || 0);
      d.start = Math.min(v, d.end - 1 / state.fps);
      patchDot({ start: d.start });
    });
    el.dotEnd.addEventListener('change', function () {
      var d = dotById(state.selectedDotId);
      if (!d) return;
      var v = parseFloat(el.dotEnd.value) || 0;
      d.end = Math.max(v, d.start + 1 / state.fps);
      patchDot({ end: d.end });
    });
    el.btnDotDelete.addEventListener('click', function () {
      deleteDot(state.selectedDotId);
      renderSelectedPanel();
      renderLane();
      renderPreview();
      invalidateDots();
    });
    // Copy/paste a dot's fill properties (color, threshold, grow, gradient)
    // onto other dots, so a consistent look can be spread across many dots
    // without re-entering every field. Timing is left alone: a dot's window on
    // the timeline is placement, not part of its look.
    el.btnDotCopy.addEventListener('click', function () {
      var d = dotById(state.selectedDotId);
      if (!d) return;
      copiedDotProps = {
        color: d.color || '#4f8fff',
        threshold: d.threshold != null ? d.threshold : 0.5,
        grow: d.grow != null ? d.grow : 1,
        gradOn: !!d.gradOn,
        gradColor: d.gradColor || '#ffffff',
        gradHeight: d.gradHeight != null ? d.gradHeight : 24,
        gradDir: d.gradDir || 'bottom'
      };
      el.btnDotPaste.disabled = false;
      toast('Dot properties copied');
    });
    el.btnDotPaste.addEventListener('click', function () {
      var d = dotById(state.selectedDotId);
      if (!copiedDotProps || !d) return;
      var p = copiedDotProps;
      d.color = p.color;
      d.threshold = p.threshold;
      d.grow = p.grow;
      d.gradOn = p.gradOn;
      d.gradColor = p.gradColor;
      d.gradHeight = p.gradHeight;
      d.gradDir = p.gradDir;
      // Pasting a color also becomes the last-used color for new dots.
      lastDotColor = p.color;
      try { localStorage.setItem(DOT_COLOR_KEY, lastDotColor); } catch (e) {}
      renderSelectedPanel();
      renderLane();
      renderPreview();
      invalidateDots();
      toast('Dot properties pasted');
    });
    el.btnAddLayer.addEventListener('click', addLayer);
    el.btnAddFillLayer.addEventListener('click', addFillLayer);
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
    });
    el.btnOnion.addEventListener('click', function () {
      state.onion = !state.onion;
      el.btnOnion.classList.toggle('active', state.onion);
      lastPreview = null;
      renderPreview();
    });
    function onionPatch(patch) { for (var k in patch) state.onionCfg[k] = patch[k]; try { localStorage.setItem(ONION_KEY, JSON.stringify(state.onionCfg)); } catch (e) {} syncOnionUI(); lastPreview = null; renderPreview(); }
    el.onionBefore.addEventListener('input', function () { var v = parseInt(el.onionBefore.value, 10) || 0; syncSlider(el.onionBefore); el.onionBeforeVal.textContent = String(v); clearTimeout(window._onionDeb); window._onionDeb = setTimeout(function () { onionPatch({ before: v }); }, 100); });
    el.onionBefore.addEventListener('change', function () { var v = parseInt(el.onionBefore.value, 10) || 0; onionPatch({ before: v }); });
    el.onionAfter.addEventListener('input', function () { var v = parseInt(el.onionAfter.value, 10) || 0; syncSlider(el.onionAfter); el.onionAfterVal.textContent = String(v); clearTimeout(window._onionDeb2); window._onionDeb2 = setTimeout(function () { onionPatch({ after: v }); }, 100); });
    el.onionAfter.addEventListener('change', function () { var v = parseInt(el.onionAfter.value, 10) || 0; onionPatch({ after: v }); });
    el.onionOpacity.addEventListener('input', function () { var v = parseFloat(el.onionOpacity.value) || 0.28; syncSlider(el.onionOpacity); el.onionOpacityVal.textContent = Math.round(v * 100) + '%'; clearTimeout(window._onionDeb3); window._onionDeb3 = setTimeout(function () { onionPatch({ opacity: v }); }, 100); });
    el.onionOpacity.addEventListener('change', function () { var v = parseFloat(el.onionOpacity.value) || 0.28; onionPatch({ opacity: v }); });
    el.onionTint.addEventListener('change', function () { onionPatch({ tint: el.onionTint.checked }); });
    el.onionTintColor.addEventListener('input', function () { onionPatch({ tintColor: el.onionTintColor.value }); });
    el.onionTintOpacity.addEventListener('input', function () { var v = parseFloat(el.onionTintOpacity.value) || 0.35; syncSlider(el.onionTintOpacity); el.onionTintOpacityVal.textContent = Math.round(v * 100) + '%'; clearTimeout(window._onionDeb4); window._onionDeb4 = setTimeout(function () { onionPatch({ tintOpacity: v }); }, 100); });
    el.onionTintOpacity.addEventListener('change', function () { var v = parseFloat(el.onionTintOpacity.value) || 0.35; onionPatch({ tintOpacity: v }); });
    el.btnStepBack.addEventListener('click', function () { pause(); step(-1); });
    el.btnStepFwd.addEventListener('click', function () { pause(); step(1); });

    el.fpsInput.addEventListener('change', function () {
      state.fps = clamp(parseInt(el.fpsInput.value, 10) || 12, 1, 60);
      el.fpsInput.value = String(state.fps);
      invalidateAll();
      renderAll();
      scheduleGenerate();
    });
    el.snapInput.addEventListener('change', function () { state.snap = el.snapInput.checked; });
    // Aspect ratio + custom dimensions share one path: recompute the working
    // size, re-render, persist, and regenerate anything the size invalidates.
    function changeSizeSetting() {
      state.aspect = el.aspectInput.value;
      state.customW = gridSnap(clamp(parseInt(el.customWInput.value, 10) || 1920, 8, 4096));
      state.customH = gridSnap(clamp(parseInt(el.customHInput.value, 10) || 1080, 8, 4096));
      var s = applyWorkSize();
      syncInputs();
      renderAll();
      scheduleGenerate();
      if (s.w * s.h > 2 * 1024 * 1024) {
        toast('Working size ' + s.w + '×' + s.h + ' is large, interpolation may be slow', 6000);
      }
    }
    el.aspectInput.addEventListener('change', changeSizeSetting);
    el.customWInput.addEventListener('change', changeSizeSetting);
    el.customHInput.addEventListener('change', changeSizeSetting);
    // Manual ratio: type "2.35", "16:9" or "21/9" and it applies directly.
    el.aspectRatioInput.addEventListener('change', function () {
      var r = parseRatio(el.aspectRatioInput.value);
      if (!r) {
        toast('Enter a ratio like 2.35 or 16:9');
        syncInputs();
        return;
      }
      state.aspect = 'manual';
      state.aspectRatio = r;
      var s = applyWorkSize();
      syncInputs();
      renderAll();
      scheduleGenerate();
      if (s.w * s.h > 2 * 1024 * 1024) {
        toast('Working size ' + s.w + '×' + s.h + ' is large, interpolation may be slow', 6000);
      }
    });
    el.resInput.addEventListener('change', function () {
      state.res = parseInt(el.resInput.value, 10) || 512;
      applyWorkSize();
      invalidateAll();
      renderAll();
      scheduleGenerate();
    });
    // Model auto-load: the ML model downloads+compiles once on launch. The loading
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
      scheduleGenerate(300);
    });
    // Keyframe blend mode: only affects the live/export composite (the inbetween
    // composites bake fills at source-over), so a change just re-renders; no
    // gap regeneration needed.
    el.kfMixInput.addEventListener('change', function () {
      var kf = state.keyframes.find(function (k) { return k.id === state.selectedId; });
      if (!kf) return;
      kf.mix = el.kfMixInput.value;
      renderAll();
      renderPreview();
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
    // Color-dot editing on the preview: when the active layer is a fill layer,
    // a press on an existing dot drags it to a new position; a press anywhere
    // else places a new dot. Takes precedence over panning so placement works
    // at any zoom.
    var dotDragState = null; // { dot, startNX, startNY, startPX, startPY }
    function dotAt(nx, ny, L) {
      var best = null, bestD = 14; // hit radius in normalized-ish px (14 work px)
      var t = state.playhead;
      (L.dots || []).forEach(function (d) {
        // Only dots active at the current time are shown and draggable.
        if (d.start > t + 1e-9 || t > d.end + 1e-9) return;
        var dx = (d.x - nx) * workW, dy = (d.y - ny) * workH;
        var dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < bestD) { bestD = dist; best = d; }
      });
      return best;
    }
    el.previewCanvas.addEventListener('pointerdown', function (e) {
      var active = layerById(state.activeLayerId);
      if (active && active.type === 'fill') {
        var rect = el.previewCanvas.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          var nx = clamp((e.clientX - rect.left) / rect.width, 0, 1);
          var ny = clamp((e.clientY - rect.top) / rect.height, 0, 1);
          var hit = dotAt(nx, ny, active);
          if (hit) {
            // Drag the dot under the cursor to reposition it.
            state.selectedDotId = hit.id;
            dotDragState = { dot: hit, startNX: nx, startNY: ny, startPX: hit.x, startPY: hit.y, moved: false };
            renderLane();
            renderSelectedPanel();
            renderPreview();
          } else {
            var d = addDot(active.id, nx, ny);
            if (d) state.selectedDotId = d.id;
            renderPreview();
            renderLane();
            renderSelectedPanel();
            invalidateDots();
          }
          return;
        }
      }
      if (state.viewZoom <= 1) return;
      panState = { x: e.clientX, y: e.clientY };
      el.previewCanvas.classList.add('panning');
      try { el.previewCanvas.setPointerCapture(e.pointerId); } catch (err) {}
    });
    el.previewCanvas.addEventListener('pointermove', function (e) {
      var ds = dotDragState;
      if (ds) {
        var rect = el.previewCanvas.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          var nx = clamp((e.clientX - rect.left) / rect.width, 0, 1);
          var ny = clamp((e.clientY - rect.top) / rect.height, 0, 1);
          ds.dot.x = clamp(ds.startPX + (nx - ds.startNX), 0, 1);
          ds.dot.y = clamp(ds.startPY + (ny - ds.startNY), 0, 1);
          ds.moved = true;
          renderPreview();
          renderLane();
        }
        return;
      }
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
      if (dotDragState) {
        if (dotDragState.moved) { invalidateDots(); }
        dotDragState = null;
      }
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
      var dotEl = e.target.closest('.fill-dot');
      if (dotEl) { startDotDrag(e, dotEl); return; }
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
        ' interpolated frames. It\u2019s recommended to put a real frame in here. Long ML stretches tend to look bad.';
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
    wireMenu(el.btnLayerMenu, el.layerMenu);
    wireMenu(el.btnOnionMenu, el.onionMenu, syncOnionUI);
    document.addEventListener('click', closeMenus);

    // File menu: save / load project .khuwari files
    el.btnSaveProject.addEventListener('click', saveProjectFile);
    el.btnLoadProject.addEventListener('click', function () { el.projectInput.click(); });
    el.projectInput.addEventListener('change', function () {
      if (el.projectInput.files && el.projectInput.files[0]) {
        loadProjectFile(el.projectInput.files[0]);
      }
      el.projectInput.value = '';
    });
    el.btnExportGo.addEventListener('click', runExport);

    // Help button in the toolbar: open the documentation in a new tab.
    el.btnHelp.addEventListener('click', function () {
      window.open('docs.html', '_blank');
    });

    // Start screen actions.
    el.btnStartNew.addEventListener('click', newProject);
    el.btnStartLoad.addEventListener('click', function () { el.projectInput.click(); });
    el.btnStartExample.addEventListener('click', openExample);
    el.btnStartDocs.addEventListener('click', function () {
      window.open('docs.html', '_blank');
    });
    el.btnStartGithub.addEventListener('click', function () {
      window.open('https://github.com/TheShovel/khuwari', '_blank');
    });
    el.btnStartCredits.addEventListener('click', function () {
      window.open('credits.html', '_blank');
    });
  }

  // Model auto-load (used by boot + retry button; works via the worker or
  // inline when no worker is available)

  function closeMenus() {
    [el.settingsMenu, el.fileMenu, el.exportMenu, el.layerMenu, el.onionMenu].forEach(function (m) { if (m) m.classList.add('hidden'); });
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
    toast('ML model ready ✓. All inbetweens are ML-generated');
  }

  function onModelError(err) {
    console.error('ML model load failed:', err);
    state.modelReady = false;
    if (modelGateResolve) { modelGateResolve(); modelGateResolve = null; }
    el.loadingSub.textContent = 'Could not load the ML model (' + (err && err.message ? err.message : err) + '). Frames will use the mesh warp instead.';
    el.loadingMeta.textContent = 'failed';
    el.btnLoadingRetry.classList.remove('hidden');
    toast('ML model failed to load. Using mesh warp', 6000);
  }

  function loadModelWithOverlay() {
    el.loadingOverlay.classList.remove('hidden');
    el.btnLoadingRetry.classList.add('hidden');
    setLoadingProgress('Preparing…', 0);
    el.loadingSub.textContent = 'Fetching the local ML engine + model (one-time, ~21 MB)…';
    modelGate = new Promise(function (resolve) { modelGateResolve = resolve; });
    if (workers.length) {
      // Every pool worker downloads + compiles its own copy of the model (the
      // browser HTTP cache makes the repeated download cheap); the launch
      // overlay hides once all of them report ready, so generation starts with
      // the full pool available.
      workersReady = 0;
      workersFailed = 0;
      workers.forEach(function (w, i) { workerModelBroken[i] = false; w.postMessage({ type: 'load-model' }); });
      return;
    }
    model.loadModel(onModelProgress).then(onModelReady).catch(onModelError);
  }

  function boot() {
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
    // Restore onion-skin prefs (overrides the project-file defaults only when
    // nothing is loaded from a file; project settings win once a project is
    // opened, see applyProjectData).
    try {
      var onionSaved = JSON.parse(localStorage.getItem(ONION_KEY) || 'null');
      if (onionSaved && typeof onionSaved === 'object') {
        state.onionCfg = {
          before: clamp(parseInt(onionSaved.before, 10) || 1, 0, 4),
          after: clamp(parseInt(onionSaved.after, 10) || 1, 0, 4),
          opacity: clamp(parseFloat(onionSaved.opacity) || 0.28, 0.05, 0.9),
          tint: !!onionSaved.tint,
          tintColor: (typeof onionSaved.tintColor === 'string' && /^#?[0-9a-f]{6}$/i.test(onionSaved.tintColor)) ? (onionSaved.tintColor[0] === '#' ? onionSaved.tintColor : '#' + onionSaved.tintColor) : '#ff3b30',
          tintOpacity: clamp(parseFloat(onionSaved.tintOpacity) || 0.35, 0.05, 1)
        };
      }
    } catch (e) {}
    // Restore the last fill color used, so newly placed dots keep it.
    try {
      var savedDotColor = localStorage.getItem(DOT_COLOR_KEY);
      if (savedDotColor && /^#?[0-9a-f]{6}$/i.test(savedDotColor)) {
        lastDotColor = savedDotColor[0] === '#' ? savedDotColor : '#' + savedDotColor;
      }
    } catch (e) {}
    renderAll();
    wireEvents();
    syncSlider(el.gapSquashAmount);
    syncSlider(el.gapBlurAmount);
    syncOnionUI();
    el.btnOnion.classList.toggle('active', state.onion);
    initWorker();
    loadModelWithOverlay(); // download + compile the ML model on launch
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
    el.aspectRatioInput.value = state.aspectRatio ? fmtRatio(state.aspectRatio) : '';
    var custom = state.aspect === 'custom';
    var manual = state.aspect === 'manual';
    el.customSizeRow.classList.toggle('hidden', !custom);
    el.manualAspectRow.classList.toggle('hidden', !manual);
    el.resInput.disabled = custom || manual;
    el.btnLoop.style.opacity = state.loop ? 1 : 0.35;
    el.btnKeysOnly.classList.toggle('active', state.keysOnly);
    updateViewportLabel();
  }

  boot();
})();
