'use strict';


  // Camera: a non-destructive pan / zoom / rotation transform applied to the
  // final composite (and to exported frames). Stored as keyframes on the
  // timeline and interpolated per frame. Disabled by default so existing
  // projects are untouched. x/y are normalized offsets (-1..1 of half the
  // frame), zoom is a scale multiplier (1 = none), rot is degrees.
  function cameraAt(t) {
    var keys = state.camera.keys;
    if (!keys.length) return { x: 0, y: 0, zoom: 1, rot: 0 };
    if (t <= keys[0].t) return { x: keys[0].x, y: keys[0].y, zoom: keys[0].zoom, rot: keys[0].rot };
    var last = keys[keys.length - 1];
    if (t >= last.t) return { x: last.x, y: last.y, zoom: last.zoom, rot: last.rot };
    for (var i = 0; i < keys.length - 1; i++) {
      var a = keys[i], b = keys[i + 1];
      if (t >= a.t && t <= b.t) {
        var f = (b.t - a.t) ? (t - a.t) / (b.t - a.t) : 0;
        return {
          x: a.x + (b.x - a.x) * f,
          y: a.y + (b.y - a.y) * f,
          zoom: a.zoom + (b.zoom - a.zoom) * f,
          rot: a.rot + (b.rot - a.rot) * f
        };
      }
    }
    return { x: last.x, y: last.y, zoom: last.zoom, rot: last.rot };
  }

  // Index of the exact (snapped) camera key at time t, or -1.
  function cameraKeyAt(t) {
    var st = state.snap ? Math.round(t * state.fps) / state.fps : t;
    for (var i = 0; i < state.camera.keys.length; i++) {
      if (Math.abs(state.camera.keys[i].t - st) < 1e-6) return i;
    }
    return -1;
  }

  function cameraSnappedTime() {
    var t = state.playhead;
    return state.snap ? Math.round(t * state.fps) / state.fps : t;
  }

  // Snapshot the camera transform onto the undo stack for one gesture.
  function cameraRecord() { recordUndo('camera'); }

  // Set one field of the camera key at the current (snapped) playhead, creating
  // a key there if none exists yet. Coalesced so dragging a slider makes a
  // single undo entry.
  function setCameraField(field, value) {
    cameraRecord();
    var t = Math.max(0, cameraSnappedTime());
    var idx = cameraKeyAt(t);
    var k;
    var created = false;
    if (idx >= 0) {
      k = state.camera.keys[idx];
    } else {
      k = { t: t, x: 0, y: 0, zoom: 1, rot: 0 };
      state.camera.keys.push(k);
      state.camera.keys.sort(function (a, b) { return a.t - b.t; });
      created = true;
    }
    k[field] = value;
    if (state.camera.keys.length === 1) {
      // A single key marks the whole timeline; duplicate it at 0 if the playhead
      // isn't there so the static transform holds from the start.
      if (k.t > 0) {
        var k0 = { t: 0, x: k.x, y: k.y, zoom: k.zoom, rot: k.rot };
        state.camera.keys.push(k0);
        state.camera.keys.sort(function (a, b) { return a.t - b.t; });
        created = true;
      }
    }
    renderPreview();
    renderCameraPanel();
    // A newly created key must show up on the timeline lane (camera row), which
    // is otherwise only rebuilt on full renders. Skip this on plain value edits
    // of an existing key, where the dot's position never changes.
    if (created && typeof renderTimeline === 'function') renderTimeline();
  }

  function addCameraKey() {
    cameraRecord();
    var t = Math.max(0, cameraSnappedTime());
    if (cameraKeyAt(t) >= 0) { toast('A camera key already exists here'); return; }
    var cam = cameraAt(t);
    state.camera.keys.push({ t: t, x: cam.x, y: cam.y, zoom: cam.zoom, rot: cam.rot });
    state.camera.keys.sort(function (a, b) { return a.t - b.t; });
    renderAll();
    toast('Camera key added at ' + fmtTime(t));
  }

  function removeCameraKey(t) {
    var st = state.snap ? Math.round(t * state.fps) / state.fps : t;
    var idx = -1;
    for (var i = 0; i < state.camera.keys.length; i++) {
      if (Math.abs(state.camera.keys[i].t - st) < 1e-6) { idx = i; break; }
    }
    if (idx < 0) return;
    cameraRecord();
    state.camera.keys.splice(idx, 1);
    renderAll();
  }

  // Sync the right-panel controls + readout to the current camera state.
  function renderCameraPanel() {
    var p = byId('cameraPanel');
    if (!p) return;
    var cam = cameraAt(state.playhead);
    if (el.cameraX) { el.cameraX.value = String(Math.round(cam.x * 1000) / 1000); syncSlider(el.cameraX); el.cameraXVal.textContent = Math.round(cam.x * 100) + '%'; }
    if (el.cameraY) { el.cameraY.value = String(Math.round(cam.y * 1000) / 1000); syncSlider(el.cameraY); el.cameraYVal.textContent = Math.round(cam.y * 100) + '%'; }
    if (el.cameraZoom) { el.cameraZoom.value = String(Math.round(cam.zoom * 1000) / 1000); syncSlider(el.cameraZoom); el.cameraZoomVal.textContent = Math.round(cam.zoom * 100) / 100 + 'x'; }
    if (el.cameraRot) { el.cameraRot.value = String(Math.round(cam.rot * 10) / 10); syncSlider(el.cameraRot); el.cameraRotVal.textContent = Math.round(cam.rot * 10) / 10 + '°'; }
    // Add / Remove are mutually exclusive: Add shows when there is no camera key
    // at the playhead, Remove shows when one exists there.
    var hasKey = cameraKeyAt(state.playhead) >= 0;
    if (el.btnCameraAddKey) el.btnCameraAddKey.classList.toggle('hidden', hasKey);
    if (el.btnCameraRemoveKey) el.btnCameraRemoveKey.classList.toggle('hidden', !hasKey);
  }

  // A read-only-ish timeline row showing camera keyframes (rendered by
  // renderLane). Click seeks, drag moves the key time, double-click removes.
  function renderCameraRow() {
    var z = state.zoom;
    var row = document.createElement('div');
    row.className = 'camera-row';
    var gutter = document.createElement('div');
    gutter.className = 'layer-gutter';
    gutter.textContent = 'Camera';
    gutter.title = 'Camera track: pan / zoom / rotation keyframes';
    var content = document.createElement('div');
    content.className = 'layer-content';
    if (state.camera.keys.length) {
      state.camera.keys.forEach(function (k) {
        var chip = document.createElement('div');
        chip.className = 'cam-dot';
        chip.dataset.t = String(k.t);
        chip.style.left = (k.t * z) + 'px';
        chip.style.width = '10px';
        chip.title = 'Camera key at ' + fmtTime(k.t) + ' · drag to move · double-click to remove';
        chip.addEventListener('dblclick', function (e) { e.stopPropagation(); removeCameraKey(k.t); });
        content.appendChild(chip);
      });
    } else {
      var hint = document.createElement('div');
      hint.className = 'fill-hint';
      hint.textContent = 'No camera keys yet. Edit a value below or drag a slider to add one.';
      content.appendChild(hint);
    }
    row.appendChild(gutter);
    row.appendChild(content);
    el.lane.appendChild(row);
  }
