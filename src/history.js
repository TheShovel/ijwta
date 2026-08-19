'use strict';


  // Undo / redo. A stack of structured-state snapshots taken BEFORE a mutation,
  // so undo returns to the pre-edit state. Only the user-editable parts are
  // captured (NOT the large generated-frame blobs; those are re-derived by
  // refreshDirty() after a restore). Snapshots are plain-data clones so later
  // edits can't mutate a stored copy.
  var undoStack = [];
  var redoStack = [];
  var UNDO_LIMIT = 150;
  // Coalescing: consecutive edits that share a key within a short window collapse
  // into a single history entry (e.g. dragging a slider) so undo reverts the
  // whole gesture, not every intermediate value.
  var lastUndoKey = null;
  var lastUndoTime = 0;

  function snapshotState() {
    return {
      keyframes: state.keyframes,
      assets: state.assets,
      layers: state.layers,
      activeLayerId: state.activeLayerId,
      gapMeta: state.gapMeta,
      gapType: state.gapType,
      gapSquash: state.gapSquash,
      gapBlur: state.gapBlur,
      fps: state.fps,
      zoom: state.zoom,
      snap: state.snap,
      res: state.res,
      aspect: state.aspect,
      aspectRatio: state.aspectRatio,
      customW: state.customW,
      customH: state.customH,
      onion: state.onion,
      onionCfg: state.onionCfg,
      camera: state.camera,
      audio: state.audio,
      selectedId: state.selectedId,
      selectedGapId: state.selectedGapId,
      selectedDotId: state.selectedDotId
    };
  }

  function cloneSnapshot(s) { return JSON.parse(JSON.stringify(s)); }

  // Record the current (pre-mutation) state onto the undo stack. Pass a `key`
  // for sustained gestures (slider drags, camera scrubbing) so consecutive
  // same-key edits within UNDO_COALESCE_MS collapse into one entry.
  function recordUndo(key) {
    var now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    if (key && undoStack.length && lastUndoKey === key && (now - lastUndoTime) < 650) {
      lastUndoTime = now; // extend the coalescing window; do not push a new entry
      return;
    }
    lastUndoKey = key || null;
    lastUndoTime = now;
    undoStack.push(cloneSnapshot(snapshotState()));
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    redoStack.length = 0;
    updateUndoButtons();
  }

  function applySnapshot(s) {
    var c = cloneSnapshot(s);
    state.keyframes = c.keyframes;
    state.assets = c.assets;
    state.layers = c.layers;
    state.activeLayerId = c.activeLayerId;
    state.gapMeta = c.gapMeta;
    state.gapType = c.gapType;
    state.gapSquash = c.gapSquash;
    state.gapBlur = c.gapBlur;
    state.fps = c.fps;
    state.zoom = c.zoom;
    state.snap = c.snap;
    state.res = c.res;
    state.aspect = c.aspect;
    state.aspectRatio = c.aspectRatio;
    state.customW = c.customW;
    state.customH = c.customH;
    state.onion = c.onion;
    state.onionCfg = c.onionCfg;
    state.camera = c.camera;
    state.audio = c.audio;
    if (typeof initAudioFromProject === 'function') initAudioFromProject();
    state.selectedId = c.selectedId;
    state.selectedGapId = c.selectedGapId;
    state.selectedDotId = c.selectedDotId;
    // Re-derive generated frames for the restored geometry: refreshDirty checks
    // stamps and regenerates only what changed, instead of cloning heavy blobs.
    refreshDirty();
    syncInputs();
    renderAll();
    scheduleGenerate(50);
  }

  function undo() {
    if (!undoStack.length) return;
    redoStack.push(cloneSnapshot(snapshotState()));
    if (redoStack.length > UNDO_LIMIT) redoStack.shift();
    var s = undoStack.pop();
    lastUndoKey = null;
    applySnapshot(s);
    updateUndoButtons();
  }

  function redo() {
    if (!redoStack.length) return;
    undoStack.push(cloneSnapshot(snapshotState()));
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    var s = redoStack.pop();
    lastUndoKey = null;
    applySnapshot(s);
    updateUndoButtons();
  }

  function clearHistory() {
    undoStack.length = 0;
    redoStack.length = 0;
    lastUndoKey = null;
    updateUndoButtons();
  }

  function canUndo() { return undoStack.length > 0; }
  function canRedo() { return redoStack.length > 0; }

  function updateUndoButtons() {
    var bu = byId('btnUndo'), br = byId('btnRedo');
    if (bu) bu.disabled = !canUndo();
    if (br) br.disabled = !canRedo();
  }
