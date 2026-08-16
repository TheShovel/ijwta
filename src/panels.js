'use strict';


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
