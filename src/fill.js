'use strict';


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

  // Draw a composite from layer bitmaps (bottom-up order). White backdrop by
  // default (previews, filmstrip). Normal layers draw their frame image directly
  // (no canvas allocation); fill layers draw their computed fill canvas. When
  // `transparent` is set the backdrop is left clear so PNG exports keep alpha.
  function drawComposite(ctx, bits, W, H, transparent, camera) {
    if (!transparent) {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, W, H);
    }
    if (camera) {
      // Non-destructive camera: transformed around the frame centre. The
      // backdrop (above) is drawn untransformed, so when the zoom is in we crop
      // to the content and when it's out the surrounding border stays the
      // (white or, for transparent exports, clear) backdrop.
      ctx.save();
      ctx.translate(W / 2 + camera.x * W, H / 2 + camera.y * H);
      ctx.rotate(camera.rot * Math.PI / 180);
      ctx.scale(camera.zoom, camera.zoom);
      ctx.translate(-W / 2, -H / 2);
    }
    var cam = !!camera;
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
    if (cam) ctx.restore();
    ctx.globalCompositeOperation = 'source-over';
  }
