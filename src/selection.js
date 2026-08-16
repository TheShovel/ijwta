'use strict';


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
