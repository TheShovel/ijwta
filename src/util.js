'use strict';


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
