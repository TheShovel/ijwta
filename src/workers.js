'use strict';


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
