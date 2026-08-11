/* morph.js — pure-JS image morphing engine (no ML model, no GPU, no network).
 *
 * Interpolates between two keyframe images by:
 *   1. estimating dense optical flow A->B and B->A (coarse-to-fine block matching
 *      on a Gaussian pyramid, with median smoothing to clean flat regions), plus
 *      an occlusion completion pass (repairFlow),
 *   2. sampling that flow onto a coarse vertex mesh (bilinear per vertex), so the
 *      warp behaves like deforming a mesh: nearby pixels always move coherently
 *      and per-pixel strays/tearing are impossible,
 *   3. for each intermediate time t, deforming A forward and B backward along the
 *      mesh flow and cross-dissolving the two deformations (a classic morph: both
 *      sides render the same intermediate shape, so the dissolve is invisible),
 *      with holes — content revealed between the keyframes — filled from B.
 *
 * Everything runs on the CPU with typed arrays; a gap's flow is computed once,
 * then every frame is a cheap warp+blend. Some frames can additionally use the
 * built-in recognition/synthesis pass: it segments coherent foreground regions,
 * cleans mask islands/holes, then regenerates that inbetween from the warped
 * endpoints. Deterministic and fully offline.
 */
(typeof self !== 'undefined' ? self : window).IJWTA_MORPH = (function () {
  'use strict';

  // ------------------------------------------------------------------
  // Image helpers (single-channel Float32Array luma)
  // ------------------------------------------------------------------
  function grayscale(rgba, w, h) {
    var n = w * h;
    var out = new Float32Array(n);
    for (var p = 0, i = 0; p < n; p++, i += 4) {
      out[p] = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
    }
    return out;
  }

  // Separable box blur (edges clamped). radius 1 -> 3x3, radius 2 -> 5x5.
  function boxBlur(src, dst, w, h, radius) {
    var n = w * h;
    var tmp = new Float32Array(n);
    var r = radius | 0;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var sum = 0, count = 0;
        for (var k = -r; k <= r; k++) {
          var xx = x + k;
          if (xx < 0) xx = 0;
          if (xx >= w) xx = w - 1;
          sum += src[y * w + xx];
          count++;
        }
        tmp[y * w + x] = sum / count;
      }
    }
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        var sum2 = 0, count2 = 0;
        for (k = -r; k <= r; k++) {
          var yy = y + k;
          if (yy < 0) yy = 0;
          if (yy >= h) yy = h - 1;
          sum2 += tmp[yy * w + x];
          count2++;
        }
        dst[y * w + x] = sum2 / count2;
      }
    }
  }

  function buildPyramid(gray, w, h, maxLevels) {
    var levels = [{ data: gray, w: w, h: h }];
    var cw = w, ch = h;
    while (levels.length < maxLevels && cw > 16 && ch > 16) {
      var src = levels[levels.length - 1];
      var blurred = new Float32Array(src.data.length);
      boxBlur(src.data, blurred, cw, ch, 1);
      var nw = Math.max(1, cw >> 1), nh = Math.max(1, ch >> 1);
      var down = new Float32Array(nw * nh);
      for (var y = 0; y < nh; y++) {
        for (var x = 0; x < nw; x++) {
          down[y * nw + x] = blurred[(2 * y) * cw + 2 * x];
        }
      }
      levels.push({ data: down, w: nw, h: nh });
      cw = nw;
      ch = nh;
    }
    return levels;
  }

  function bilinearField(field, pw, ph, fx, fy) {
    if (fx < 0) fx = 0; else if (fx > pw - 1) fx = pw - 1;
    if (fy < 0) fy = 0; else if (fy > ph - 1) fy = ph - 1;
    var x0 = fx | 0, y0 = fy | 0;
    var x1 = x0 < pw - 1 ? x0 + 1 : x0;
    var y1 = y0 < ph - 1 ? y0 + 1 : y0;
    var ax = fx - x0, ay = fy - y0;
    var i00 = y0 * pw + x0, i01 = y0 * pw + x1, i10 = y1 * pw + x0, i11 = y1 * pw + x1;
    return field[i00] * (1 - ax) * (1 - ay) + field[i01] * ax * (1 - ay) +
           field[i10] * (1 - ax) * ay + field[i11] * ax * ay;
  }

  // Bilinear flow upsampling between pyramid levels (smoother than nearest).
  function upsampleFlow(u, v, pw, ph, nw, nh) {
    var scaleX = nw / pw, scaleY = nh / ph;
    var outU = new Float32Array(nw * nh);
    var outV = new Float32Array(nw * nh);
    for (var y = 0; y < nh; y++) {
      for (var x = 0; x < nw; x++) {
        var q = y * nw + x;
        outU[q] = bilinearField(u, pw, ph, x / scaleX, y / scaleY) * scaleX;
        outV[q] = bilinearField(v, pw, ph, x / scaleX, y / scaleY) * scaleY;
      }
    }
    return { u: outU, v: outV };
  }

  // Edge-aware flow smoothing: median of the flow among neighbours whose image
  // intensity is close to the centre pixel's. Cleans flat regions (noise) while
  // keeping object boundaries sharp in the flow field.
  function edgeAwareMedian(u, v, gray, w, h, r, colorThresh) {
    var n = w * h;
    var ou = new Float32Array(n);
    var ov = new Float32Array(n);
    var us = [], vs = [];
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var p = y * w + x;
        var gc = gray[p];
        us.length = 0;
        vs.length = 0;
        for (var dy = -r; dy <= r; dy++) {
          var yy = y + dy;
          if (yy < 0) yy = 0; else if (yy >= h) yy = h - 1;
          for (var dx = -r; dx <= r; dx++) {
            var xx = x + dx;
            if (xx < 0) xx = 0; else if (xx >= w) xx = w - 1;
            var q = yy * w + xx;
            if (Math.abs(gray[q] - gc) <= colorThresh) {
              us.push(u[q]);
              vs.push(v[q]);
            }
          }
        }
        if (!us.length) { us.push(u[p]); vs.push(v[p]); }
        us.sort(function (a, b) { return a - b; });
        vs.sort(function (a, b) { return a - b; });
        ou[p] = us[us.length >> 1];
        ov[p] = vs[vs.length >> 1];
      }
    }
    return { u: ou, v: ov };
  }

  // Bidirectional flow completion: where the two flows disagree (occlusions),
  // re-point the flow using the opposite side's estimate.
  function repairFlow(flowAB, flowBA, width, height, thresh) {
    var uAB = flowAB.u, vAB = flowAB.v;
    var uBA = flowBA.u, vBA = flowBA.v;
    for (var y = 0; y < height; y++) {
      for (var x = 0; x < width; x++) {
        var p = y * width + x;
        var ux = uAB[p], vy = vAB[p];
        var lx = Math.round(x + ux), ly = Math.round(y + vy);
        if (lx < 0) lx = 0; else if (lx >= width) lx = width - 1;
        if (ly < 0) ly = 0; else if (ly >= height) ly = height - 1;
        var q = ly * width + lx;
        var err = Math.abs(ux + uBA[q]) + Math.abs(vy + vBA[q]);
        if (err > thresh) {
          uAB[p] = -uBA[q];
          vAB[p] = -vBA[q];
        }
      }
    }
  }

  // ------------------------------------------------------------------
  // Dense flow via coarse-to-fine block matching
  // ------------------------------------------------------------------
  function ssdAt(a, b, wa, ha, x, y, offx, offy, r) {
    var sum = 0, count = 0;
    for (var dy = -r; dy <= r; dy++) {
      var sy = y + dy;
      if (sy < 0 || sy >= ha) continue;
      var ty = y + offy + dy;
      if (ty < 0 || ty >= ha) continue;
      for (var dx = -r; dx <= r; dx++) {
        var sx = x + dx;
        if (sx < 0 || sx >= wa) continue;
        var tx = x + offx + dx;
        if (tx < 0 || tx >= wa) continue;
        var d = a[sy * wa + sx] - b[ty * wa + tx];
        sum += d * d;
        count++;
      }
    }
    return count ? sum / count : Infinity;
  }

  // Mean absolute deviation of the A patch around its centre pixel: 0 in flat
  // regions, large at edges/texture.
  function textureAt(a, wa, ha, x, y, r) {
    var sum = 0, count = 0;
    var centre = a[y * wa + x];
    for (var dy = -r; dy <= r; dy++) {
      var sy = y + dy;
      if (sy < 0 || sy >= ha) continue;
      for (var dx = -r; dx <= r; dx++) {
        var sx = x + dx;
        if (sx < 0 || sx >= wa) continue;
        sum += Math.abs(a[sy * wa + sx] - centre);
        count++;
      }
    }
    return count ? sum / count : 0;
  }

  function blockMatch(a, b, wa, ha, uIn, vIn, searchR, patchR, isCancelled) {
    var n = wa * ha;
    var u = new Float32Array(n);
    var v = new Float32Array(n);
    var checkEvery = Math.max(1, Math.floor(n / 50000));
    for (var y = 0; y < ha; y++) {
      for (var x = 0; x < wa; x++) {
        var p = y * wa + x;
        if (isCancelled && p % checkEvery === 0 && isCancelled()) throw new Error('Cancelled');
        var cu = uIn ? uIn[p] : 0;
        var cv = vIn ? vIn[p] : 0;
        // Flat patches carry no motion information: keep the propagated estimate
        // instead of letting noise push the flow around (this is what keeps
        // flat backgrounds clean and stops flow bleeding from moving objects).
        if (textureAt(a, wa, ha, x, y, patchR) < 6) {
          u[p] = cu;
          v[p] = cv;
          continue;
        }
        // Start from the current estimate so ties in flat regions keep it
        // (otherwise every refinement pass drifts toward the first candidate).
        var best = ssdAt(a, b, wa, ha, x, y, cu, cv, patchR);
        var bu = cu, bv = cv;
        for (var dy = -searchR; dy <= searchR; dy++) {
          for (var dx = -searchR; dx <= searchR; dx++) {
            if (dx === 0 && dy === 0) continue;
            var s = ssdAt(a, b, wa, ha, x, y, cu + dx, cv + dy, patchR);
            if (s < best) { best = s; bu = cu + dx; bv = cv + dy; }
          }
        }
        u[p] = bu;
        v[p] = bv;
      }
    }
    return { u: u, v: v };
  }

  function medianFilter(field, w, h, r) {
    var out = new Float32Array(field.length);
    var vals = [];
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        vals.length = 0;
        for (var dy = -r; dy <= r; dy++) {
          var yy = y + dy;
          if (yy < 0) yy = 0;
          if (yy >= h) yy = h - 1;
          for (var dx = -r; dx <= r; dx++) {
            var xx = x + dx;
            if (xx < 0) xx = 0;
            if (xx >= w) xx = w - 1;
            vals.push(field[yy * w + xx]);
          }
        }
        vals.sort(function (a, b) { return a - b; });
        out[y * w + x] = vals[vals.length >> 1];
      }
    }
    return out;
  }

  // Flow A->B: u,v such that A(x,y) ≈ B(x+u, y+v).
  function computeFlow(rgbaA, rgbaB, width, height, opts, onStep, isCancelled) {
    opts = opts || {};
    var maxLevels = opts.maxLevels || 5;
    var levelsA = buildPyramid(grayscale(rgbaA, width, height), width, height, maxLevels);
    var levelsB = buildPyramid(grayscale(rgbaB, width, height), width, height, maxLevels);
    var levels = levelsA.length;
    var u = null, v = null;

    var chain = Promise.resolve();
    for (var L = levels - 1; L >= 0; L--) {
      (function (level) {
        chain = chain.then(function () {
          if (isCancelled && isCancelled()) throw new Error('Cancelled');
          var wa = levelsA[level].w, ha = levelsA[level].h;
          if (u) {
            var up = upsampleFlow(u, v, levelsA[level + 1].w, levelsA[level + 1].h, wa, ha);
            u = up.u;
            v = up.v;
          }
          // Small patches at every level: coarse levels are small enough that
          // object interiors get median-filled there, while small patches keep
          // the flow from dilating into flat backgrounds.
          var patchR = 1;
          var searchR = level === levels - 1 ? 4 : 2;
          var matched = blockMatch(levelsA[level].data, levelsB[level].data, wa, ha, u, v, searchR, patchR, isCancelled);
          // Edge-aware smoothing (radius 2) fills flat object interiors from
          // their edges while keeping flat backgrounds still, then refine.
          var smoothed = edgeAwareMedian(matched.u, matched.v, levelsA[level].data, wa, ha, 2, 24);
          var refined = blockMatch(levelsA[level].data, levelsB[level].data, wa, ha, smoothed.u, smoothed.v, 1, patchR, isCancelled);
          var final = edgeAwareMedian(refined.u, refined.v, levelsA[level].data, wa, ha, 2, 24);
          u = final.u;
          v = final.v;
          if (onStep) onStep((levels - level) / levels, 'flow level ' + (level + 1) + '/' + levels);
        });
      })(L);
    }
    return chain.then(function () {
      return { u: u, v: v };
    });
  }

  // Both directions + mutual repair. Returns { flowAB, flowBA, flowBARaw }.
  function computeFlowBoth(rgbaA, rgbaB, width, height, opts, onStep, isCancelled) {
    opts = opts || {};
    return computeFlow(rgbaA, rgbaB, width, height, opts, function (frac, label) {
      if (onStep) onStep(frac * 0.45, label);
    }, isCancelled).then(function (ab) {
      return computeFlow(rgbaB, rgbaA, width, height, opts, function (frac, label) {
        if (onStep) onStep(0.45 + frac * 0.45, label);
      }, isCancelled).then(function (ba) {
        if (isCancelled && isCancelled()) throw new Error('Cancelled');
        var grayA = grayscale(rgbaA, width, height);
        var grayB = grayscale(rgbaB, width, height);
        // Smooth the raw flows first, THEN repair. (Running the median after the
        // repair wiped the occlusion completion: at an object's top/bottom edge
        // the median window mixes in background rows where the completion hasn't
        // reached yet, outvoting it and punching holes in the completed band.)
        // Several passes propagate boundary motion into flat interiors (block
        // matching can't measure motion inside uniform regions; the intensity
        // gate keeps stroke/object edges sharp between passes).
        var abS = ab, baS = ba;
        for (var pass = 0; pass < 3; pass++) {
          abS = edgeAwareMedian(abS.u, abS.v, grayA, width, height, 3, 24);
          baS = edgeAwareMedian(baS.u, baS.v, grayB, width, height, 3, 24);
        }
        // Keep an un-repaired copy of B->A (smoothed like the final flows). The
        // render's hole-fill wants B's content at rest where A's warp doesn't
        // cover (revealed background), and the repair's fictional motion would
        // shift it.
        var baRaw = { u: new Float32Array(baS.u), v: new Float32Array(baS.v) };
        repairFlow(abS, baS, width, height, opts.repairThreshold || 3);
        repairFlow(baS, abS, width, height, opts.repairThreshold || 3);
        if (onStep) onStep(1, 'refining');
        return { flowAB: abS, flowBA: baS, flowBARaw: baRaw };
      });
    });
  }

  // ------------------------------------------------------------------
  // Rendering one intermediate frame
  // ------------------------------------------------------------------
  function bilinearSampleRGBA(src, w, h, fx, fy) {
    if (fx < 0) fx = 0; else if (fx > w - 1) fx = w - 1;
    if (fy < 0) fy = 0; else if (fy > h - 1) fy = h - 1;
    var x0 = fx | 0, y0 = fy | 0;
    var x1 = x0 < w - 1 ? x0 + 1 : x0;
    var y1 = y0 < h - 1 ? y0 + 1 : y0;
    var ax = fx - x0, ay = fy - y0;
    var i00 = (y0 * w + x0) * 4, i01 = (y0 * w + x1) * 4;
    var i10 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4;
    var out = [0, 0, 0];
    for (var c = 0; c < 3; c++) {
      var v0 = src[i00 + c] * (1 - ax) * (1 - ay) + src[i01 + c] * ax * (1 - ay);
      var v1 = src[i10 + c] * (1 - ax) * ay + src[i11 + c] * ax * ay;
      out[c] = v0 + v1;
    }
    return out;
  }

  // t in [0,1]: 0 = exactly frame A, 1 = exactly frame B.
  function morphFrame(aData, bData, flowAB, flowBA, width, height, t) {
    var n = width * height;
    var out = new Uint8ClampedArray(n * 4);
    var uAB = flowAB.u, vAB = flowAB.v;
    var uBA = flowBA.u, vBA = flowBA.v;
    var thresh = 4.0;
    var inv = 1 - t;
    for (var y = 0; y < height; y++) {
      for (var x = 0; x < width; x++) {
        var p = y * width + x;
        var q = p * 4;

        // forward/backward consistency: the two flows should point at each other
        var ux = uAB[p], vy = vAB[p];
        var lx = Math.round(x + ux), ly = Math.round(y + vy);
        if (lx < 0) lx = 0; else if (lx > width - 1) lx = width - 1;
        if (ly < 0) ly = 0; else if (ly > height - 1) ly = height - 1;
        var lp = ly * width + lx;
        var cA = Math.abs(ux + uBA[lp]) + Math.abs(vy + vBA[lp]);

        var ux2 = uBA[p], vy2 = vBA[p];
        var mx = Math.round(x + ux2), my = Math.round(y + vy2);
        if (mx < 0) mx = 0; else if (mx > width - 1) mx = width - 1;
        if (my < 0) my = 0; else if (my > height - 1) my = height - 1;
        var mp = my * width + mx;
        var cB = Math.abs(ux2 + uAB[mp]) + Math.abs(vy2 + vAB[mp]);

        var wA = cA < thresh ? 1 - cA / thresh : 0;
        var wB = cB < thresh ? 1 - cB / thresh : 0;
        var wa = wA * inv;
        var wb = wB * t;
        // Softly mix in the plain cross-fade where confidence is low, so
        // unreliable pixels dissolve instead of snapping between sources.
        var eps = 0.1;
        var denom = wa + wb + eps;

        var sa = bilinearSampleRGBA(aData, width, height, x - t * ux, y - t * vy);
        var sb = bilinearSampleRGBA(bData, width, height, x - inv * ux2, y - inv * vy2);
        for (var c = 0; c < 3; c++) {
          out[q + c] = Math.round((wa * sa[c] + wb * sb[c] + eps * (inv * aData[q + c] + t * bData[q + c])) / denom);
        }
        out[q + 3] = 255;
      }
    }
    return out;
  }

  // Plain cross-fade (fallback / "blend" mode).
  function blendFrame(aData, bData, width, height, t) {
    var n = width * height;
    var out = new Uint8ClampedArray(n * 4);
    var inv = 1 - t;
    for (var p = 0, i = 0; p < n; p++, i += 4) {
      out[i] = Math.round(aData[i] * inv + bData[i] * t);
      out[i + 1] = Math.round(aData[i + 1] * inv + bData[i + 1] * t);
      out[i + 2] = Math.round(aData[i + 2] * inv + bData[i + 2] * t);
      out[i + 3] = 255;
    }
    return out;
  }

  // ------------------------------------------------------------------
  // Mesh-based warping
  // ------------------------------------------------------------------
  // Each vertex of a coarse grid samples the (already edge-aware-median-smoothed)
  // dense flow bilinearly; bilinear interpolation between vertices makes the warp
  // behave like deforming a mesh — nearby pixels always move coherently and
  // per-pixel strays/tearing are impossible. Crucially the vertex values are NOT
  // smoothed afterwards: the dense flow's occlusion completion (repairFlow)
  // extends the object's motion across the occluded band, and averaging that away
  // at vertices made the warp mis-read the object's trailing half (cut/slice
  // look). The completion taper is left intact — the render's dissolve + hole-fill
  // keeps the completed band invisible.
  function buildMesh(u, v, w, h, cell) {
    cell = Math.max(4, Math.round(cell));
    var cols = Math.max(2, Math.ceil(w / cell) + 1);
    var rows = Math.max(2, Math.ceil(h / cell) + 1);
    var mu = new Float32Array(cols * rows);
    var mv = new Float32Array(cols * rows);
    for (var j = 0; j < rows; j++) {
      for (var i = 0; i < cols; i++) {
        var idx = j * cols + i;
        mu[idx] = bilinearField(u, w, h, i * cell, j * cell);
        mv[idx] = bilinearField(v, w, h, i * cell, j * cell);
      }
    }
    return { u: mu, v: mv, cols: cols, rows: rows, cell: cell };
  }

  // Bilinear sample of the mesh flow at pixel (x, y).
  function sampleMesh(mesh, x, y) {
    var cols = mesh.cols, rows = mesh.rows, cell = mesh.cell;
    var fx = x / cell, fy = y / cell;
    if (fx < 0) fx = 0; else if (fx > cols - 2) fx = cols - 2;
    if (fy < 0) fy = 0; else if (fy > rows - 2) fy = rows - 2;
    var i0 = fx | 0, j0 = fy | 0;
    var i1 = i0 + 1, j1 = j0 + 1;
    var ax = fx - i0, ay = fy - j0;
    var u00 = mesh.u[j0 * cols + i0], u01 = mesh.u[j0 * cols + i1];
    var u10 = mesh.u[j1 * cols + i0], u11 = mesh.u[j1 * cols + i1];
    var v00 = mesh.v[j0 * cols + i0], v01 = mesh.v[j0 * cols + i1];
    var v10 = mesh.v[j1 * cols + i0], v11 = mesh.v[j1 * cols + i1];
    var u = u00 * (1 - ax) * (1 - ay) + u01 * ax * (1 - ay) + u10 * (1 - ax) * ay + u11 * ax * ay;
    var v = v00 * (1 - ax) * (1 - ay) + v01 * ax * (1 - ay) + v10 * (1 - ax) * ay + v11 * ax * ay;
    return [u, v];
  }

  function buildMeshes(pair, width, height, cell) {
    return {
      meshAB: buildMesh(pair.flowAB.u, pair.flowAB.v, width, height, cell),
      meshBA: buildMesh(pair.flowBA.u, pair.flowBA.v, width, height, cell),
      flowBARaw: pair.flowBARaw
    };
  }

  // Classic morph render: each side is deformed toward the other along the mesh
  // flow, and the two deformations are cross-dissolved by t. When the flows are
  // right (translation, rotation, deformation) both warps produce the SAME
  // intermediate shape, so the dissolve is invisible — no seams, no cuts, and
  // no per-pixel occlusion weights to ghost rotations. Where A's deformation
  // doesn't cover (content revealed between the keyframes, plus rounding
  // cracks), the pixel is filled from B using the un-repaired flow, so revealed
  // background sits at rest instead of being dragged.
  function morphFrameMesh(aData, bData, meshes, width, height, t) {
    var rendered = renderMeshWarps(aData, bData, meshes, width, height, t);
    return rendered.out;
  }

  function renderMeshWarps(aData, bData, meshes, width, height, t) {
    var meshAB = meshes.meshAB, meshBA = meshes.meshBA;
    var n = width * height;
    var out = new Uint8ClampedArray(n * 4);
    var covered = new Uint8Array(n);
    var inv = 1 - t;
    // Forward-splat coverage: which output pixels does A's deformation land on?
    for (var y = 0; y < height; y++) {
      for (var x = 0; x < width; x++) {
        var p = y * width + x;
        var f = sampleMesh(meshAB, x, y);
        var qx = Math.round(x + t * f[0]);
        var qy = Math.round(y + t * f[1]);
        if (qx < 0) qx = 0; else if (qx > width - 1) qx = width - 1;
        if (qy < 0) qy = 0; else if (qy > height - 1) qy = height - 1;
        covered[qy * width + qx] = 1;
      }
    }
    var uRaw = null, vRaw = null;
    if (meshes.flowBARaw) { uRaw = meshes.flowBARaw.u; vRaw = meshes.flowBARaw.v; }
    // Close 1px holes in the coverage mask: the forward-splat target rounding of a
    // smoothly-varying flow leaves a checkerboard of uncovered pixels around every
    // moving edge, and filling those from B speckles the frame. One dilation pass
    // marks them covered, so only the genuinely wide revealed bands reach the fill.
    for (y = 0; y < height; y++) {
      for (x = 0; x < width; x++) {
        if (covered[y * width + x]) continue;
        var cx2 = x, cy2 = y;
        for (var dy2 = -1; dy2 <= 1; dy2++) {
          var ny = y + dy2;
          if (ny < 0 || ny >= height) continue;
          for (var dx2 = -1; dx2 <= 1; dx2++) {
            if (dx2 === 0 && dy2 === 0) continue;
            var nx = x + dx2;
            if (nx < 0 || nx >= width) continue;
            if (covered[ny * width + nx]) { covered[y * width + x] = 1; break; }
          }
          if (covered[y * width + x]) break;
        }
      }
    }
    for (y = 0; y < height; y++) {
      for (x = 0; x < width; x++) {
        p = y * width + x;
        var q = p * 4;
        if (covered[p]) {
          var fA = sampleMesh(meshAB, x, y);
          var fB = sampleMesh(meshBA, x, y);
          var sa = bilinearSampleRGBA(aData, width, height, x - t * fA[0], y - t * fA[1]);
          var sb = bilinearSampleRGBA(bData, width, height, x - inv * fB[0], y - inv * fB[1]);
          for (var c = 0; c < 3; c++) {
            out[q + c] = Math.round(inv * sa[c] + t * sb[c]);
          }
        } else if (uRaw) {
          var fu = bilinearField(uRaw, width, height, x, y);
          var fv = bilinearField(vRaw, width, height, x, y);
          var sb2 = bilinearSampleRGBA(bData, width, height, x - inv * fu, y - inv * fv);
          out[q] = Math.round(sb2[0]);
          out[q + 1] = Math.round(sb2[1]);
          out[q + 2] = Math.round(sb2[2]);
        } else {
          // No raw flow available: fall back to B at rest.
          var sb3 = bilinearSampleRGBA(bData, width, height, x, y);
          out[q] = Math.round(sb3[0]);
          out[q + 1] = Math.round(sb3[1]);
          out[q + 2] = Math.round(sb3[2]);
        }
        out[q + 3] = 255;
      }
    }
    return { out: out, covered: covered };
  }

  // ------------------------------------------------------------------
  // Local recognition + generation pass
  // ------------------------------------------------------------------
  // This is intentionally not a downloaded ML model: a static/offline site cannot
  // ship meaningful pretrained image generation without a large bundled model. This
  // pass is a tiny deterministic "image model" for drawings: recognize foreground
  // regions against the corner background, warp their masks through the same mesh,
  // clean islands/holes as connected regions, then regenerate a coherent frame from
  // the warped endpoints instead of trusting individual stray pixels.
  function averageCornerColor(data, w, h) {
    var pts = [0, w - 1, (h - 1) * w, (h - 1) * w + (w - 1)];
    var r = 0, g = 0, b = 0;
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i] * 4;
      r += data[p]; g += data[p + 1]; b += data[p + 2];
    }
    return [r / 4, g / 4, b / 4];
  }

  function colorDistToBg(data, i, bg) {
    var dr = data[i] - bg[0], dg = data[i + 1] - bg[1], db = data[i + 2] - bg[2];
    return Math.sqrt(dr * dr + dg * dg + db * db);
  }

  function makeForegroundMask(data, w, h) {
    var n = w * h;
    var bg = averageCornerColor(data, w, h);
    var mask = new Uint8Array(n);
    for (var p = 0, i = 0; p < n; p++, i += 4) {
      if (data[i + 3] > 16 && colorDistToBg(data, i, bg) > 28) mask[p] = 1;
    }
    return { mask: mask, bg: bg };
  }

  function sampleMask(mask, w, h, fx, fy) {
    var x = Math.round(fx), y = Math.round(fy);
    if (x < 0 || y < 0 || x >= w || y >= h) return 0;
    return mask[y * w + x];
  }

  function dilateMask(mask, w, h, r) {
    var out = new Uint8Array(mask.length);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var on = 0;
        for (var dy = -r; dy <= r && !on; dy++) {
          var yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (var dx = -r; dx <= r; dx++) {
            var xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            if (mask[yy * w + xx]) { on = 1; break; }
          }
        }
        out[y * w + x] = on;
      }
    }
    return out;
  }

  function erodeMask(mask, w, h, r) {
    var out = new Uint8Array(mask.length);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var on = 1;
        for (var dy = -r; dy <= r && on; dy++) {
          var yy = y + dy;
          if (yy < 0 || yy >= h) { on = 0; break; }
          for (var dx = -r; dx <= r; dx++) {
            var xx = x + dx;
            if (xx < 0 || xx >= w || !mask[yy * w + xx]) { on = 0; break; }
          }
        }
        out[y * w + x] = on;
      }
    }
    return out;
  }

  function removeSmallComponents(mask, w, h, keepOn, minSize) {
    var n = w * h;
    var seen = new Uint8Array(n);
    var out = new Uint8Array(mask);
    var stack = [];
    var comp = [];
    for (var p = 0; p < n; p++) {
      if (seen[p] || Boolean(mask[p]) !== keepOn) continue;
      seen[p] = 1;
      stack.length = 0; comp.length = 0;
      stack.push(p);
      while (stack.length) {
        var q = stack.pop();
        comp.push(q);
        var x = q % w, y = (q / w) | 0;
        var ns = [q - 1, q + 1, q - w, q + w];
        for (var k = 0; k < ns.length; k++) {
          var r = ns[k];
          if (r < 0 || r >= n || seen[r] || Boolean(mask[r]) !== keepOn) continue;
          if ((k === 0 && x === 0) || (k === 1 && x === w - 1)) continue;
          seen[r] = 1;
          stack.push(r);
        }
      }
      if (comp.length < minSize) {
        for (var i = 0; i < comp.length; i++) out[comp[i]] = keepOn ? 0 : 1;
      }
    }
    return out;
  }

  function cleanGeneratedMask(mask, w, h) {
    // Close pinholes first, remove specks second, then fill tiny enclosed gaps.
    var closed = erodeMask(dilateMask(mask, w, h, 1), w, h, 1);
    var minObject = Math.max(3, Math.round(w * h * 0.00006));
    var noSpecks = removeSmallComponents(closed, w, h, true, minObject);
    return removeSmallComponents(noSpecks, w, h, false, Math.max(3, minObject * 2));
  }

  function localCoherentColor(src, mask, w, h, x, y, fallback) {
    var rs = [], gs = [], bs = [];
    for (var r = 1; r <= 3; r++) {
      rs.length = 0; gs.length = 0; bs.length = 0;
      for (var dy = -r; dy <= r; dy++) {
        var yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (var dx = -r; dx <= r; dx++) {
          var xx = x + dx;
          if (xx < 0 || xx >= w || !mask[yy * w + xx]) continue;
          var q = (yy * w + xx) * 4;
          rs.push(src[q]); gs.push(src[q + 1]); bs.push(src[q + 2]);
        }
      }
      if (rs.length >= 3) {
        rs.sort(function (a, b) { return a - b; });
        gs.sort(function (a, b) { return a - b; });
        bs.sort(function (a, b) { return a - b; });
        var m = rs.length >> 1;
        return [rs[m], gs[m], bs[m]];
      }
    }
    return fallback;
  }

  function synthesizeInbetweenFrame(aData, bData, meshes, width, height, t, baseFrame) {
    var n = width * height;
    var rendered = baseFrame ? { out: baseFrame } : renderMeshWarps(aData, bData, meshes, width, height, t);
    var base = rendered.out;
    var inv = 1 - t;
    var aRec = makeForegroundMask(aData, width, height);
    var bRec = makeForegroundMask(bData, width, height);
    var outMask = new Uint8Array(n);
    for (var y = 0; y < height; y++) {
      for (var x = 0; x < width; x++) {
        var p = y * width + x;
        var fA = sampleMesh(meshes.meshAB, x, y);
        var fB = sampleMesh(meshes.meshBA, x, y);
        var ma = sampleMask(aRec.mask, width, height, x - t * fA[0], y - t * fA[1]);
        var mb = sampleMask(bRec.mask, width, height, x - inv * fB[0], y - inv * fB[1]);
        outMask[p] = ma || mb ? 1 : 0;
      }
    }
    outMask = cleanGeneratedMask(outMask, width, height);

    var out = new Uint8ClampedArray(n * 4);
    var bg = [aRec.bg[0] * inv + bRec.bg[0] * t, aRec.bg[1] * inv + bRec.bg[1] * t, aRec.bg[2] * inv + bRec.bg[2] * t];
    for (y = 0; y < height; y++) {
      for (x = 0; x < width; x++) {
        p = y * width + x;
        var i = p * 4;
        if (outMask[p]) {
          var fallback = [base[i], base[i + 1], base[i + 2]];
          // If the warped pixel accidentally sampled background inside a recognized
          // object, regenerate it from nearby object pixels rather than leaving a gap.
          if (Math.abs(fallback[0] - bg[0]) + Math.abs(fallback[1] - bg[1]) + Math.abs(fallback[2] - bg[2]) < 36) {
            fallback = localCoherentColor(base, outMask, width, height, x, y, fallback);
          }
          var col = localCoherentColor(base, outMask, width, height, x, y, fallback);
          out[i] = Math.round(col[0]);
          out[i + 1] = Math.round(col[1]);
          out[i + 2] = Math.round(col[2]);
        } else {
          out[i] = Math.round(bg[0]);
          out[i + 1] = Math.round(bg[1]);
          out[i + 2] = Math.round(bg[2]);
        }
        out[i + 3] = 255;
      }
    }
    return out;
  }

  return {
    computeFlow: computeFlow,
    computeFlowBoth: computeFlowBoth,
    morphFrame: morphFrame,
    morphFrameMesh: morphFrameMesh,
    synthesizeInbetweenFrame: synthesizeInbetweenFrame,
    buildMeshes: buildMeshes,
    blendFrame: blendFrame
  };
})();
