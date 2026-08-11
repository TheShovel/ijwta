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

self.onmessage = function (e) {
  var msg = e.data;
  if (msg.type === 'load-model') loadModel();
  else if (msg.type === 'generate-gap') generateGap(msg);
  else if (msg.type === 'cancel') cancelled = true;
};

function post(m, transfer) { self.postMessage(m, transfer); }

// ------------------------------------------------------------------
// Model loading (mirrors the main-thread overlay state machine)
// ------------------------------------------------------------------
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

// ------------------------------------------------------------------
// Gap generation
// ------------------------------------------------------------------
function generateGap(msg) {
  cancelled = false;
  var jobId = msg.jobId;
  var aData = new Uint8ClampedArray(msg.aData);
  var bData = new Uint8ClampedArray(msg.bData);
  var width = msg.width, height = msg.height;
  var fromTime = msg.fromTime, toTime = msg.toTime;
  var missing = msg.missing; // [{idx, t}]

  var meshes = null;
  var isCancelled = function () { return cancelled; };

  var first = function () {
    post({ type: 'gap-progress', jobId: jobId, label: 'Preparing interpolation…', gapFrac: 0 });
    // Flow is only needed for the mesh fallback; compute it up front so any
    // AI failure can drop to a warp without stalling.
    return morph.computeFlowBoth(aData, bData, width, height, {}, function (frac) {
      post({ type: 'gap-progress', jobId: jobId, label: 'Preparing interpolation…', gapFrac: frac * 0.05 });
    }, isCancelled).then(function (pair) {
      if (cancelled) return;
      meshes = morph.buildMeshes(pair, width, height, 16);
    });
  };

  var emit = function (m) {
    if (cancelled) return Promise.resolve();
    var t = m.t;
    var time = fromTime + (toTime - fromTime) * t;
    var send = function (rgba, ai) {
      var buf = rgba.buffer;
      post({ type: 'frame', jobId: jobId, idx: m.idx, t: t, time: time, ai: ai, width: width, height: height, rgba: buf }, [buf]);
    };
    if (model.isReady()) {
      return model.interpolate(aData, bData, width, height, t).then(function (aiOut) {
        send(aiOut, true);
      }).catch(function (err) {
        if (cancelled) return;
        console.error('AI inbetween failed, using mesh warp:', err);
        send(morph.morphFrameMesh(aData, bData, meshes, width, height, t), false);
      });
    }
    send(morph.morphFrameMesh(aData, bData, meshes, width, height, t), false);
    return Promise.resolve();
  };

  var i = 0;
  var next = function () {
    if (cancelled || i >= missing.length) return Promise.resolve();
    var m = missing[i];
    var label = (model.isReady() ? 'AI inbetween ' : 'mesh warp ') + (i + 1) + '/' + missing.length;
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
