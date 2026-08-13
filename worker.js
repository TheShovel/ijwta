/* worker.js — background frame interpolation for Keyframe Studio.
 *
 * Runs off the main thread so generating inbetweens never freezes the UI:
 * the AI model (RIFE via ONNX Runtime Web) is downloaded+compiled here, and
 * every gap is rendered in this worker. The main thread sends two keyframe
 * RGBA buffers + a list of missing frame indices; we reply with each finished
 * frame's RGBA buffer (transferred, zero-copy) plus progress messages.
 *
 * Falls back to the pure mesh morph per-frame if the model isn't ready or a
 * single inference fails — generation never stalls.
 */
'use strict';

importScripts('morph.js', 'model.js');

var morph = self.IJWTA_MORPH;
var model = self.IJWTA_MODEL;
var cancelled = false;
var upscaleCancelled = false;

self.onmessage = function (e) {
  var msg = e.data;
  if (msg.type === 'load-model') loadModel();
  else if (msg.type === 'generate-gap') generateGap(msg);
  else if (msg.type === 'color-pass') colorPass(msg);
  else if (msg.type === 'color-pass-free') colorPassFree(msg);
  else if (msg.type === 'color-frame') colorFrame(msg);
  else if (msg.type === 'cancel') cancelled = true;
  else if (msg.type === 'upscale') upscaleFrame(msg);
  else if (msg.type === 'cancel-upscale') upscaleCancelled = true;
};

function post(m, transfer) { self.postMessage(m, transfer); }

// Model loading (mirrors the main-thread overlay state machine)

function loadModel() {
  model.loadModel(function (info) {
    if (info && info.stage === 'model') post({ type: 'model-progress', stage: 'model', frac: info.frac });
    else if (info && info.stage === 'compile') post({ type: 'model-progress', stage: 'compile', frac: 1 });
  }).then(function () {
    post({ type: 'model-ready' });
  }).catch(function (err) {
    post({ type: 'model-error', message: err && err.message ? err.message : String(err) });
  });
}

// Cached color passes: the same colored pass + source frame (aData) are used
// for every frame of a color gap, so they are sent once per gap and reused by
// passId — instead of structured-cloning 16 MB into the worker per frame.
var colorPasses = {};

function colorPass(msg) {
  colorPasses[msg.passId] = {
    pass: new Uint8ClampedArray(msg.passData),
    a: new Uint8ClampedArray(msg.aData),
    width: msg.width, height: msg.height
  };
  var keys = Object.keys(colorPasses);
  if (keys.length > 8) delete colorPasses[keys[0]]; // LRU-ish cap
}

function colorPassFree(msg) {
  if (colorPasses[msg.passId]) delete colorPasses[msg.passId];
}

// Encode a finished frame to a PNG data URL inside the worker (OffscreenCanvas),
// so the main thread never runs the (Firefox-slow) canvas.toDataURL per frame.
// Falls back to null when unsupported — the caller then ships the raw RGBA.
function encodePNG(rgba, width, height) {
  if (typeof OffscreenCanvas === 'undefined' || typeof FileReaderSync === 'undefined') return null;
  try {
    var c = new OffscreenCanvas(width, height);
    var ctx = c.getContext('2d');
    var img = ctx.createImageData(width, height);
    img.data.set(rgba);
    ctx.putImageData(img, 0, 0);
    return c.convertToBlob({ type: 'image/png' }).then(function (blob) {
      return new FileReaderSync().readAsDataURL(blob);
    });
  } catch (e) { return null; }
}

// Post a finished frame, encoding to a PNG data URL in the worker when
// possible. Any encode failure (unsupported codec, memory pressure) falls back
// to shipping the raw RGBA buffer — generation never stalls on encoding.
function postFrame(jobId, frame, rgba, width, height) {
  var enc = encodePNG(rgba, width, height);
  if (!enc) {
    var buf = rgba.buffer;
    post({ type: 'frame', jobId: jobId, idx: frame.idx, t: frame.t, time: frame.time, ai: frame.ai, width: width, height: height, rgba: buf }, [buf]);
    return Promise.resolve();
  }
  return enc.then(function (dataUrl) {
    post({ type: 'frame', jobId: jobId, idx: frame.idx, t: frame.t, time: frame.time, ai: frame.ai, width: width, height: height, img: dataUrl });
  }, function () {
    var buf = rgba.buffer;
    post({ type: 'frame', jobId: jobId, idx: frame.idx, t: frame.t, time: frame.time, ai: frame.ai, width: width, height: height, rgba: buf }, [buf]);
  });
}

// Color-layer frame: warp the colored pass along the source layer's motion
// (flow from the pass's line-art frame to the current line-art frame), so the
// colors follow the animation. The pass + source frame arrive once per gap via
// 'color-pass' (or inline for direct callers); bData is transferred per frame.
function colorFrame(msg) {
  cancelled = false;
  var jobId = msg.jobId;
  var rec = msg.passId ? colorPasses[msg.passId] : null;
  var pass, a, width, height;
  if (rec) {
    pass = rec.pass; a = rec.a; width = rec.width; height = rec.height;
  } else {
    pass = new Uint8ClampedArray(msg.passData);
    a = new Uint8ClampedArray(msg.aData);
    width = msg.width; height = msg.height;
  }
  var b = new Uint8ClampedArray(msg.bData);
  morph.computeFlowBoth(a, b, width, height, {}, null, function () { return cancelled; }).then(function (pair) {
    if (cancelled) { post({ type: 'gap-cancelled', jobId: jobId }); return; }
    var warped = morph.warpFrame(pass, pair.flowAB, width, height, 2);
    morph.gateFill(warped, b, width, height);
    return postFrame(jobId, { idx: msg.idx, t: msg.t, time: msg.time, ai: false }, warped, width, height);
  }).then(function () {
    if (cancelled) { post({ type: 'gap-cancelled', jobId: jobId }); return; }
    post({ type: 'gap-done', jobId: jobId });
  }).catch(function (err) {
    if (cancelled) { post({ type: 'gap-cancelled', jobId: jobId }); return; }
    post({ type: 'gap-error', jobId: jobId, message: err && err.message ? err.message : String(err) });
  });
}

function generateGap(msg) {
  cancelled = false;
  var jobId = msg.jobId;
  var aData = new Uint8ClampedArray(msg.aData);
  var bData = new Uint8ClampedArray(msg.bData);
  var width = msg.width, height = msg.height;
  var fromTime = msg.fromTime, toTime = msg.toTime;
  var mode = msg.mode || 'ai';
  var squash = msg.squash || null;
  var blur = msg.blur || null;
  var missing = msg.missing; // [{idx, t}]
  var blurOn = !!(blur && blur.on && blur.intensity > 0);

  var meshes = null;
  var flowPromise = null;
  var isCancelled = function () { return cancelled; };
  // Flow is only needed for the mesh fallback and the alpha warp. When the AI
  // model works and the keyframes are fully opaque (the common case) neither is
  // used, so compute it lazily on first actual need instead of up front — that
  // skips the whole optical-flow pass (~0.5-1.5 s at working size) per gap.
  var opaque = morph.isOpaque(aData) && morph.isOpaque(bData);
  var ensureMeshes = function () {
    if (meshes) return Promise.resolve();
    if (flowPromise) return flowPromise;
    post({ type: 'gap-progress', jobId: jobId, label: 'Preparing interpolation…', gapFrac: 0 });
    flowPromise = morph.computeFlowBoth(aData, bData, width, height, {}, function (frac) {
      post({ type: 'gap-progress', jobId: jobId, label: 'Preparing interpolation…', gapFrac: frac * 0.05 });
    }, isCancelled).then(function (pair) {
      if (cancelled) return;
      meshes = morph.buildMeshes(pair, width, height, 16);
    });
    return flowPromise;
  };

  // Make sure the AI model is loaded before generating, so a worker that gets
  // a gap before its model finished downloading still AI-generates instead of
  // silently falling back to the mesh warp for the whole gap.
  var ensureModel = function () {
    if (model.isReady()) return Promise.resolve();
    post({ type: 'gap-progress', jobId: jobId, label: 'Loading AI model…', gapFrac: 0 });
    return model.loadModel(function (info) {
      if (info && info.stage === 'model') post({ type: 'model-progress', stage: 'model', frac: info.frac });
      else if (info && info.stage === 'compile') post({ type: 'model-progress', stage: 'compile', frac: 1 });
    }).catch(function (err) {
      // Model unavailable (offline etc.): the per-frame fallback below will use
      // the mesh warp, matching the old behaviour — generation never stalls.
      console.error('AI model load failed in worker, using mesh warp:', err && err.message ? err.message : err);
    });
  };

  var first = function () {
    if (mode === 'ai') return ensureModel();
    return Promise.resolve();
  };

  var emit = function (m) {
    if (cancelled) return Promise.resolve();
    var t = m.t;
    var time = fromTime + (toTime - fromTime) * t;
    // Encode the frame to a PNG data URL in the worker when possible
    // (OffscreenCanvas) so the main thread never runs the slow canvas.toDataURL
    // per frame. Falls back to shipping the raw RGBA buffer otherwise.
    var send = function (rgba, ai) {
      return postFrame(jobId, { idx: m.idx, t: t, time: time, ai: ai }, rgba, width, height);
    };
    // Motion blur needs the flow, so it forces the (lazily-computed) meshes
    // even for the opaque-AI path that would otherwise skip them entirely.
    var finish = function (rgba, ai) {
      if (!blurOn) return send(rgba, ai);
      return ensureMeshes().then(function () {
        if (cancelled) return;
        return send(morph.motionBlurFrame(rgba, meshes, width, height, t, blur.intensity), ai);
      });
    };
    // RIFE renders RGB with alpha 255; give the frame the mesh-warped alpha so
    // transparent keyframes (cut-out characters) stay transparent in inbetweens.
    // Fully opaque keyframes skip this entirely — the result is byte-identical
    // and a full mesh warp per frame is avoided.
    var applyAlpha = function (rgba) {
      var alpha = morph.warpAlpha(aData, bData, meshes, width, height, t);
      var n = width * height;
      for (var p = 0, q = 0; p < n; p++, q += 4) rgba[q + 3] = alpha[p];
    };
    if (mode === 'squash') {
      return ensureMeshes().then(function () {
        return finish(morph.squashStretchFrame(aData, bData, meshes, width, height, t, squash), false);
      });
    }
    if (model.isReady()) {
      return model.interpolate(aData, bData, width, height, t).then(function (aiOut) {
        if (cancelled) return;
        if (opaque) return finish(aiOut, true);
        return ensureMeshes().then(function () {
          if (cancelled) return;
          applyAlpha(aiOut);
          return finish(aiOut, true);
        });
      }).catch(function (err) {
        if (cancelled) return;
        console.error('AI inbetween failed, using mesh warp:', err);
        return ensureMeshes().then(function () {
          return finish(morph.morphFrameMesh(aData, bData, meshes, width, height, t), false);
        });
      });
    }
    return ensureMeshes().then(function () {
      return finish(morph.morphFrameMesh(aData, bData, meshes, width, height, t), false);
    });
  };

  var i = 0;
  var next = function () {
    if (cancelled || i >= missing.length) return Promise.resolve();
    var m = missing[i];
    var label = (mode === 'squash' ? 'squash frame ' : (model.isReady() ? 'AI inbetween ' : 'mesh warp ')) + (i + 1) + '/' + missing.length;
    i++;
    return emit(m).then(function () {
      if (cancelled) return;
      post({ type: 'gap-progress', jobId: jobId, label: label, gapFrac: i / missing.length });
      // Yield so a cancel message can be processed between frames.
      return new Promise(function (r) { setTimeout(r, 0); }).then(next);
    });
  };

  first().then(next).then(function () {
    if (cancelled) { post({ type: 'gap-cancelled', jobId: jobId }); return; }
    post({ type: 'gap-done', jobId: jobId });
  }).catch(function (err) {
    post({ type: 'gap-error', jobId: jobId, message: err && err.message ? err.message : String(err) });
  });
}

// Export upscaling (super-resolution, lazy-loaded on first export)

function upscaleFrame(msg) {
  upscaleCancelled = false;
  var jobId = msg.jobId;
  var rgba = new Uint8ClampedArray(msg.rgba);
  var width = msg.width, height = msg.height;
  var loadProgress = function (info) {
    if (info && info.stage === 'model') post({ type: 'sr-progress', jobId: jobId, frac: info.frac });
    else if (info && info.stage === 'compile') post({ type: 'sr-progress', jobId: jobId, frac: 1 });
  };
  model.loadSRModel(loadProgress).then(function () {
    if (upscaleCancelled) { post({ type: 'upscale-cancelled', jobId: jobId }); return; }
    return model.upscale(rgba, width, height);
  }).then(function (out) {
    if (upscaleCancelled) { post({ type: 'upscale-cancelled', jobId: jobId }); return; }
    var buf = out.buffer;
    post({ type: 'upscaled', jobId: jobId, width: width * model.SR_SCALE, height: height * model.SR_SCALE, rgba: buf }, [buf]);
  }).catch(function (err) {
    post({ type: 'upscale-error', jobId: jobId, message: err && err.message ? err.message : String(err) });
  });
}
