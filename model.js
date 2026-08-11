/* model.js — local AI frame interpolation (RIFE, ONNX) for Keyframe Studio.
 *
 * No server, no API: when the user enables "AI inbetweens" the app downloads two
 * things in-browser —
 *   1. ONNX Runtime Web (wasm inference engine) from a CDN, and
 *   2. a small RIFE-style frame-interpolation ONNX model (concatenated-frame
 *      tensor in [1,6,H,W], interpolated frame out [1,3,H,W]).
 * After that everything runs locally in the page; nothing is sent anywhere.
 * If the runtime or model cannot be fetched (offline / blocked), the app falls
 * back to the pure mesh morph — AI inbetweens are strictly optional.
 *
 * Swap ORT_VERSION / ORT_CDN / MODEL_URL below to change sources.
 */
(typeof self !== 'undefined' ? self : window).IJWTA_MODEL = (function () {
  'use strict';

  var root = (typeof self !== 'undefined' ? self : window);

  var ORT_VERSION = '1.20.1';
  var ORT_CDN = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@' + ORT_VERSION + '/dist/';
  var ORT_JS = ORT_CDN + 'ort.min.js';
  var ORT_WASM = ORT_CDN; // ort fetches ort-wasm*.wasm from this path

  // RIFE ONNX export (frame interpolation). Must accept [1,6,H,W] float32
  // (frame A RGB + frame B RGB, 0..1) and emit [1,3,H,W] float32 (0..1).
  var MODEL_URL = 'https://huggingface.co/yuvraj108c/rife-onnx/resolve/main/rife49_ensemble_True_scale_1_sim.onnx';

  var state = {
    runtimeLoaded: false,
    session: null,
    loading: false,
    loadPromise: null
  };

  // ------------------------------------------------------------------
  // Runtime
  // ------------------------------------------------------------------
  function loadRuntime() {
    if (state.runtimeLoaded) return Promise.resolve();
    if (root.ort && root.ort.InferenceSession) {
      state.runtimeLoaded = true;
      return Promise.resolve();
    }
    return new Promise(function (resolve, reject) {
      if (typeof importScripts === 'function') {
        // Inside a Web Worker: importScripts is synchronous and CORS-permitted.
        try {
          importScripts(ORT_JS);
        } catch (e) {
          reject(new Error('Could not load ONNX Runtime from ' + ORT_JS));
          return;
        }
        if (!root.ort || !root.ort.InferenceSession) {
          reject(new Error('ONNX Runtime loaded but `ort` is missing'));
          return;
        }
        try {
          root.ort.env.wasm.wasmPaths = ORT_WASM;
          root.ort.env.wasm.numThreads = 1;
        } catch (e) { /* non-fatal */ }
        state.runtimeLoaded = true;
        resolve();
        return;
      }
      var script = document.createElement('script');
      script.src = ORT_JS;
      script.onload = function () {
        if (!root.ort || !root.ort.InferenceSession) {
          reject(new Error('ONNX Runtime loaded but `ort` is missing'));
          return;
        }
        try {
          root.ort.env.wasm.wasmPaths = ORT_WASM;
          root.ort.env.wasm.numThreads = 1;
        } catch (e) { /* non-fatal */ }
        state.runtimeLoaded = true;
        resolve();
      };
      script.onerror = function () { reject(new Error('Could not load ONNX Runtime from ' + ORT_JS)); };
      document.head.appendChild(script);
    });
  }

  // ------------------------------------------------------------------
  // Streaming download with progress (0..1)
  // ------------------------------------------------------------------
  function downloadWithProgress(url, onProgress) {
    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error('Download failed (HTTP ' + res.status + ')');
      var total = Number(res.headers.get('Content-Length')) || 0;
      if (!res.body || typeof res.body.getReader !== 'function') {
        // No streaming (older browsers): fall back to a single read.
        onProgress(0.1);
        return res.arrayBuffer().then(function (buf) {
          onProgress(1);
          return buf;
        });
      }
      var reader = res.body.getReader();
      var received = 0;
      var chunks = [];
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) {
            var all = new Uint8Array(received);
            var off = 0;
            for (var i = 0; i < chunks.length; i++) {
              all.set(chunks[i], off);
              off += chunks[i].length;
            }
            onProgress(1);
            return all.buffer;
          }
          chunks.push(r.value);
          received += r.value.length;
          if (total) onProgress(received / total);
          return pump();
        });
      }
      return pump();
    });
  }

  // ------------------------------------------------------------------
  // Model
  // ------------------------------------------------------------------
  function loadModel(onProgress) {
    if (state.session) return Promise.resolve();
    if (state.loadPromise) return state.loadPromise;
    state.loading = true;
    state.loadPromise = loadRuntime()
      .then(function () {
        if (onProgress) onProgress({ stage: 'model', frac: 0 });
        return downloadWithProgress(MODEL_URL, function (frac) {
          if (onProgress) onProgress({ stage: 'model', frac: frac });
        });
      })
      .then(function (buf) {
        if (onProgress) onProgress({ stage: 'compile', frac: 1 });
        return root.ort.InferenceSession.create(buf, { executionProviders: ['wasm'] });
      })
      .then(function (session) {
        state.session = session;
        try {
          var meta = [];
          var outputMeta = [];
          (session.inputNames || []).forEach(function (n) {
            var m = session.inputMetadata ? session.inputMetadata[n] : null;
            meta.push(n + (m && m.dims ? ' ' + JSON.stringify(m.dims) : ''));
          });
          (session.outputNames || []).forEach(function (n) {
            var m = session.outputMetadata ? session.outputMetadata[n] : null;
            outputMeta.push(n + (m && m.dims ? ' ' + JSON.stringify(m.dims) : ''));
          });
          console.log('[AI] model inputs:', meta.join(', ') || '(unknown)', '| outputs:', outputMeta.join(', ') || '(unknown)');
        } catch (e) { /* optional */ }
        return session;
      })
      .finally(function () {
        state.loading = false;
        state.loadPromise = null;
      });
    return state.loadPromise;
  }

  // ------------------------------------------------------------------
  // Inference
  // ------------------------------------------------------------------
  // Single frame -> [1,3,H,W] float32 in 0..1 (channel-first R,G,B planes).
  function rgbaToRifefloat(rgba, w, h) {
    var n = w * h;
    var out = new Float32Array(3 * n);
    for (var p = 0, i = 0; p < n; p++, i += 4) {
      out[p] = rgba[i] / 255;
      out[n + p] = rgba[i + 1] / 255;
      out[2 * n + p] = rgba[i + 2] / 255;
    }
    return out;
  }

  function concatFrames(aData, bData, w, h) {
    var n = w * h;
    var out = new Float32Array(6 * n);
    for (var p = 0, i = 0; p < n; p++, i += 4) {
      out[p] = aData[i] / 255;
      out[n + p] = aData[i + 1] / 255;
      out[2 * n + p] = aData[i + 2] / 255;
      out[3 * n + p] = bData[i] / 255;
      out[4 * n + p] = bData[i + 1] / 255;
      out[5 * n + p] = bData[i + 2] / 255;
    }
    return out;
  }

  function rifeOutputToRGBA(tensorData, w, h) {
    var n = w * h;
    var out = new Uint8ClampedArray(n * 4);
    var r = tensorData, g = tensorData.subarray ? tensorData.subarray(n, 2 * n) : tensorData.slice(n, 2 * n);
    var b = tensorData.subarray ? tensorData.subarray(2 * n, 3 * n) : tensorData.slice(2 * n, 3 * n);
    for (var p = 0, i = 0; p < n; p++, i += 4) {
      out[i] = Math.round(Math.min(1, Math.max(0, r[p])) * 255);
      out[i + 1] = Math.round(Math.min(1, Math.max(0, g[p])) * 255);
      out[i + 2] = Math.round(Math.min(1, Math.max(0, b[p])) * 255);
      out[i + 3] = 255;
    }
    return out;
  }

  // Interpolate an inbetween from two keyframe RGBA buffers (size w×h) at time t.
  // Returns Promise<Uint8ClampedArray> or rejects so callers can fall back.
  //
  // RIFE exports come in a few flavours and we handle all of them:
  //   A) one 6-channel input [1,6,H,W]  (frameA RGB ++ frameB RGB)
  //   B) two 3-channel inputs          (frameA, frameB) — e.g. named
  //      'frame0'/'frame1', 'img0'/'img1', or 'x'/'y'
  //   C) two 3-channel inputs + a scalar 'timestep' input (t in [0,1])
  // The interpolated frame is the first 3-channel output.
  function interpolate(aData, bData, w, h, t) {
    if (!state.session) return Promise.reject(new Error('Model not loaded'));
    var n = w * h;
    var tensor6 = new root.ort.Tensor('float32', concatFrames(aData, bData, w, h), [1, 6, h, w]);
    var tensorA = new root.ort.Tensor('float32', rgbaToRifefloat(aData, w, h), [1, 3, h, w]);
    var tensorB = new root.ort.Tensor('float32', rgbaToRifefloat(bData, w, h), [1, 3, h, w]);
    var ts = (typeof t === 'number' && isFinite(t)) ? t : 0.5;
    var feeds = {};
    var names = [];
    try { names = state.session.inputNames || []; } catch (e) {}

    function isTimestepName(s) {
      var l = String(s).toLowerCase();
      return l.indexOf('timestep') !== -1 || l.indexOf('time') !== -1 || l.indexOf('t_') === 0;
    }
    function isFrameAName(s) {
      var l = String(s).toLowerCase();
      return l.indexOf('img0') !== -1 || l.indexOf('frame0') !== -1 || l === 'x' || l.indexOf('a') === l.length - 1;
    }

    if (!names.length) {
      // No metadata: assume the single 6-channel layout (most common export).
      feeds.input = tensor6;
    } else {
      var six = null, frames = [], timestepName = null;
      for (var k = 0; k < names.length; k++) {
        var meta = state.session.inputMetadata ? state.session.inputMetadata[names[k]] : null;
        var ch = meta && meta.dims ? meta.dims[1] : 0;
        if (ch === 6) { six = names[k]; break; }
        if (isTimestepName(names[k])) timestepName = names[k];
        else frames.push(names[k]);
      }
      if (six) {
        feeds[six] = tensor6;
      } else if (timestepName && frames.length >= 2) {
        // Layout C: two frame inputs + a scalar timestep input.
        var aName = frames.filter(isFrameAName)[0] || frames[0];
        var bName = frames[0] === aName ? frames[1] : frames[0];
        feeds[aName] = tensorA;
        feeds[bName] = tensorB;
        var tsDims = [1];
        try {
          var tm = state.session.inputMetadata ? state.session.inputMetadata[timestepName] : null;
          if (tm && tm.dims && tm.dims.length) tsDims = tm.dims;
        } catch (e2) {}
        feeds[timestepName] = new root.ort.Tensor('float32', new Float32Array([ts]), tsDims);
      } else if (frames.length >= 2) {
        // Layout B: two frame inputs, no timestep.
        var aName2 = frames.filter(isFrameAName)[0] || frames[0];
        var bName2 = frames[0] === aName2 ? frames[1] : frames[0];
        feeds[aName2] = tensorA;
        feeds[bName2] = tensorB;
      } else {
        feeds[names[0]] = tensor6;
      }
    }

    // Pre-flight check: ONNX Runtime errors are cryptic when feed data length
    // doesn't match the input's expected size — catch it here with a clear message.
    var feedNames = Object.keys(feeds);
    for (var fn = 0; fn < feedNames.length; fn++) {
      var feed = feeds[feedNames[fn]];
      var expected = 1;
      var dims = feed.dims || [];
      for (var d = 0; d < dims.length; d++) expected *= dims[d];
      if (feed.data && feed.data.length !== expected) {
        return Promise.reject(new Error(
          'Feed "' + feedNames[fn] + '" size ' + expected + ' != data length ' + feed.data.length +
          ' (dims ' + JSON.stringify(dims) + ')'
        ));
      }
    }

    return state.session.run(feeds).then(function (results) {
      var outNames = Object.keys(results);
      if (!outNames.length) throw new Error('Model returned no outputs');
      var out = results[outNames[0]];
      var data = out.data;
      var len = w * h * 3;
      if (!data || data.length < len) throw new Error('Model output too small (' + (data ? data.length : 0) + ' < ' + len + ')');
      return rifeOutputToRGBA(data, w, h);
    });
  }

  function isReady() { return !!state.session; }
  function isLoading() { return state.loading; }

  return {
    loadRuntime: loadRuntime,
    loadModel: loadModel,
    interpolate: interpolate,
    rgbaToRifefloat: rgbaToRifefloat,
    isReady: isReady,
    isLoading: isLoading,
    MODEL_URL: MODEL_URL,
    ORT_JS: ORT_JS
  };
})();
