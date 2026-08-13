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

  // Image helpers (single-channel Float32Array luma)

  // Premultiply luma by alpha so transparent pixels (e.g. a cut-out character)
  // don't drag the optical flow around with invisible content; for fully opaque
  // frames this is identical to the plain luma.
  function grayscale(rgba, w, h) {
    var n = w * h;
    var out = new Float32Array(n);
    for (var p = 0, i = 0; p < n; p++, i += 4) {
      var lum = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
      out[p] = lum * (rgba[i + 3] / 255);
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
    var win = (2 * r + 1) * (2 * r + 1);
    var us = new Float64Array(win);
    var vs = new Float64Array(win);
    var i, j, len, dy, dx;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var p = y * w + x;
        var gc = gray[p];
        len = 0;
        var fU = 0, fV = 0, allSame = true;
        // Same window as the original: every dy/dx in [-r, r] with each step
        // clamped, so border rows/cols contribute duplicates exactly like the
        // old median window.
        for (dy = -r; dy <= r; dy++) {
          var yy = y + dy;
          if (yy < 0) yy = 0; else if (yy >= h) yy = h - 1;
          var row = yy * w;
          for (dx = -r; dx <= r; dx++) {
            var xx = x + dx;
            if (xx < 0) xx = 0; else if (xx >= w) xx = w - 1;
            var q = row + xx;
            if (Math.abs(gray[q] - gc) <= colorThresh) {
              var uv = u[q];
              var vv = v[q];
              if (!len) { fU = uv; fV = vv; }
              else if (uv !== fU || vv !== fV) allSame = false;
              us[len] = uv;
              vs[len] = vv;
              len++;
            }
          }
        }
        if (!len) { ou[p] = u[p]; ov[p] = v[p]; continue; }
        // Uniform window (static background, flat interiors): the median is the
        // value itself — skip the sort entirely. Otherwise insertion sort: the
        // window overlaps almost fully between adjacent pixels, so the values
        // are nearly sorted and insertion sort beats Array#sort (no comparator
        // callbacks, no garbage) with the same median.
        if (allSame) { ou[p] = fU; ov[p] = fV; continue; }
        for (i = 1; i < len; i++) {
          var uu = us[i]; j = i - 1;
          while (j >= 0 && us[j] > uu) { us[j + 1] = us[j]; j--; }
          us[j + 1] = uu;
          var vv2 = vs[i]; j = i - 1;
          while (j >= 0 && vs[j] > vv2) { vs[j + 1] = vs[j]; j--; }
          vs[j + 1] = vv2;
        }
        ou[p] = us[len >> 1];
        ov[p] = vs[len >> 1];
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

  // Dense flow via coarse-to-fine block matching

  // Dense flow via coarse-to-fine block matching. The source patch around
  // (x,y) is gathered once per pixel (row-major, matching the old per-offset
  // loops exactly), then each candidate offset walks it skipping out-of-bounds
  // targets. Same arithmetic order as before, so results are identical — but
  // no per-offset function calls and no patch re-gathering.
  function blockMatch(a, b, wa, ha, uIn, vIn, searchR, patchR, isCancelled) {
    var n = wa * ha;
    var u = new Float32Array(n);
    var v = new Float32Array(n);
    var checkEvery = Math.max(1, Math.floor(n / 50000));
    var pr = patchR;
    var win = (2 * pr + 1) * (2 * pr + 1);
    var srcX = new Int32Array(win);
    var srcY = new Int32Array(win);
    var sr = new Float32Array(win);
    for (var y = 0; y < ha; y++) {
      var sy0 = y - pr; if (sy0 < 0) sy0 = 0;
      var sy1 = y + pr; if (sy1 >= ha) sy1 = ha - 1;
      for (var x = 0; x < wa; x++) {
        var p = y * wa + x;
        if (isCancelled && p % checkEvery === 0 && isCancelled()) throw new Error('Cancelled');
        var sx0 = x - pr; if (sx0 < 0) sx0 = 0;
        var sx1 = x + pr; if (sx1 >= wa) sx1 = wa - 1;
        var centre = a[p];
        var len = 0, tsum = 0;
        for (var dy = sy0; dy <= sy1; dy++) {
          for (var dx = sx0; dx <= sx1; dx++) {
            var q = dy * wa + dx;
            sr[len] = a[q];
            srcX[len] = dx;
            srcY[len] = dy;
            tsum += Math.abs(a[q] - centre);
            len++;
          }
        }
        var cu = uIn ? uIn[p] : 0;
        var cv = vIn ? vIn[p] : 0;
        // Flat patches carry no motion information: keep the propagated estimate
        // instead of letting noise push the flow around (this is what keeps
        // flat backgrounds clean and stops flow bleeding from moving objects).
        if (tsum < 6 * len) {
          u[p] = cu;
          v[p] = cv;
          continue;
        }
        // Start from the current estimate so ties in flat regions keep it
        // (otherwise every refinement pass drifts toward the first candidate).
        // Candidate order matches the original: the (0,0) estimate is evaluated
        // first, then every offset in scan order — strict < keeps the first
        // (earliest) minimum on ties, so results are identical.
        var k, offx, offy, sum, cnt, d, s, ty, tx;
        offx = cu; offy = cv;
        sum = 0; cnt = 0;
        for (k = 0; k < len; k++) {
          ty = srcY[k] + offy; tx = srcX[k] + offx;
          if (ty < 0 || ty >= ha || tx < 0 || tx >= wa) continue;
          d = sr[k] - b[ty * wa + tx];
          sum += d * d;
          cnt++;
        }
        var best = cnt ? sum / cnt : Infinity;
        var bu = cu, bv = cv;
        for (var oy = -searchR; oy <= searchR; oy++) {
          for (var ox = -searchR; ox <= searchR; ox++) {
            if (ox === 0 && oy === 0) continue;
            offx = cu + ox; offy = cv + oy;
            sum = 0; cnt = 0;
            for (k = 0; k < len; k++) {
              ty = srcY[k] + offy; tx = srcX[k] + offx;
              if (ty < 0 || ty >= ha || tx < 0 || tx >= wa) continue;
              d = sr[k] - b[ty * wa + tx];
              sum += d * d;
              cnt++;
            }
            s = cnt ? sum / cnt : Infinity;
            if (s < best) { best = s; bu = cu + ox; bv = cv + oy; }
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
    return computeFlowGray(grayscale(rgbaA, width, height), grayscale(rgbaB, width, height), width, height, opts, onStep, isCancelled);
  }

  // Same as computeFlow, but takes precomputed grayscale luma so callers that
  // need both directions (computeFlowBoth) only convert each image once.
  function computeFlowGray(grayA0, grayB0, width, height, opts, onStep, isCancelled) {
    opts = opts || {};
    var maxLevels = opts.maxLevels || 5;
    var levelsA = buildPyramid(grayA0, width, height, maxLevels);
    var levelsB = buildPyramid(grayB0, width, height, maxLevels);
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
    var grayA = grayscale(rgbaA, width, height);
    var grayB = grayscale(rgbaB, width, height);
    return computeFlowGray(grayA, grayB, width, height, opts, function (frac, label) {
      if (onStep) onStep(frac * 0.45, label);
    }, isCancelled).then(function (ab) {
      return computeFlowGray(grayB, grayA, width, height, opts, function (frac, label) {
        if (onStep) onStep(0.45 + frac * 0.45, label);
      }, isCancelled).then(function (ba) {
        if (isCancelled && isCancelled()) throw new Error('Cancelled');
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

  function bilinearSampleRGBA(src, w, h, fx, fy) {
    if (fx < 0) fx = 0; else if (fx > w - 1) fx = w - 1;
    if (fy < 0) fy = 0; else if (fy > h - 1) fy = h - 1;
    var x0 = fx | 0, y0 = fy | 0;
    var x1 = x0 < w - 1 ? x0 + 1 : x0;
    var y1 = y0 < h - 1 ? y0 + 1 : y0;
    var ax = fx - x0, ay = fy - y0;
    var i00 = (y0 * w + x0) * 4, i01 = (y0 * w + x1) * 4;
    var i10 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4;
    var out = [0, 0, 0, 0];
    for (var c = 0; c < 4; c++) {
      var v0 = src[i00 + c] * (1 - ax) * (1 - ay) + src[i01 + c] * ax * (1 - ay);
      var v1 = src[i10 + c] * (1 - ax) * ay + src[i11 + c] * ax * ay;
      out[c] = v0 + v1;
    }
    return out;
  }

  // Separable box blur on all four channels (including alpha). Softens the
  // warped color pass: hard silhouette edges feather out instead of aliasing
  // against the sharp line art beneath, and noisy flow at object edges stops
  // producing single-pixel color speckles.
  // Sliding-window sums make this O(n) instead of O(n·r); channel values are
  // integers so the running sum is exact — byte-identical to the old loop.
  function smoothRGBA(rgba, w, h, r) {
    var n = w * h;
    var tmp = new Uint8ClampedArray(rgba.length);
    var out = new Uint8ClampedArray(rgba.length);
    var x, y, q, i, cnt, lo, hi, newLo, newHi;
    var sum0, sum1, sum2, sum3;
    // horizontal pass
    for (y = 0; y < h; y++) {
      var rb = y * w * 4;
      sum0 = 0; sum1 = 0; sum2 = 0; sum3 = 0; cnt = 0;
      lo = 0; hi = r; if (hi >= w) hi = w - 1;
      for (i = 0; i <= hi; i++) {
        q = rb + i * 4;
        sum0 += rgba[q]; sum1 += rgba[q + 1]; sum2 += rgba[q + 2]; sum3 += rgba[q + 3];
        cnt++;
      }
      for (x = 0; x < w; x++) {
        q = rb + x * 4;
        tmp[q] = sum0 / cnt; tmp[q + 1] = sum1 / cnt; tmp[q + 2] = sum2 / cnt; tmp[q + 3] = sum3 / cnt;
        // slide the window one pixel right
        newLo = x + 1 - r; if (newLo < 0) newLo = 0;
        if (newLo > lo) {
          q = rb + lo * 4;
          sum0 -= rgba[q]; sum1 -= rgba[q + 1]; sum2 -= rgba[q + 2]; sum3 -= rgba[q + 3];
          cnt--;
          lo = newLo;
        }
        newHi = x + 1 + r; if (newHi >= w) newHi = w - 1;
        if (newHi > hi) {
          q = rb + newHi * 4;
          sum0 += rgba[q]; sum1 += rgba[q + 1]; sum2 += rgba[q + 2]; sum3 += rgba[q + 3];
          cnt++;
          hi = newHi;
        }
      }
    }
    // vertical pass
    for (x = 0; x < w; x++) {
      sum0 = 0; sum1 = 0; sum2 = 0; sum3 = 0; cnt = 0;
      lo = 0; hi = r; if (hi >= h) hi = h - 1;
      for (i = 0; i <= hi; i++) {
        q = (i * w + x) * 4;
        sum0 += tmp[q]; sum1 += tmp[q + 1]; sum2 += tmp[q + 2]; sum3 += tmp[q + 3];
        cnt++;
      }
      for (y = 0; y < h; y++) {
        q = (y * w + x) * 4;
        out[q] = sum0 / cnt; out[q + 1] = sum1 / cnt; out[q + 2] = sum2 / cnt; out[q + 3] = sum3 / cnt;
        newLo = y + 1 - r; if (newLo < 0) newLo = 0;
        if (newLo > lo) {
          q = (lo * w + x) * 4;
          sum0 -= tmp[q]; sum1 -= tmp[q + 1]; sum2 -= tmp[q + 2]; sum3 -= tmp[q + 3];
          cnt--;
          lo = newLo;
        }
        newHi = y + 1 + r; if (newHi >= h) newHi = h - 1;
        if (newHi > hi) {
          q = (newHi * w + x) * 4;
          sum0 += tmp[q]; sum1 += tmp[q + 1]; sum2 += tmp[q + 2]; sum3 += tmp[q + 3];
          cnt++;
          hi = newHi;
        }
      }
    }
    return out;
  }

  // Limit a warped color pass's alpha to the source frame's silhouette: the
  // fill only shows where the source layer is opaque, so colors never bleed
  // outside the drawing — no matter the line art's style or color. What is
  // "line" vs "paper" inside the silhouette is left to the multiply blend
  // (dark stays dark, light gets tinted), so fluffy soft edges and any-color
  // line art both work.
  function gateFill(warped, line, w, h) {
    var n = w * h;
    for (var p = 0, q = 0; p < n; p++, q += 4) {
      warped[q + 3] = warped[q + 3] * (line[q + 3] / 255);
    }
    return warped;
  }

  // Warp one image fully along a flow field (the A→B flow from computeFlowBoth).
  // Used by color layers: the colored pass of one frame is warped to follow
  // the line-art frame it colors, so colors track the animation. A positive
  // radius smooths the result (feathered edges) to avoid jagged color edges.
  // Bilinear sampling is inlined — no per-pixel function calls or allocation.
  function warpFrame(src, flowAB, width, height, radius) {
    var u = flowAB.u, v = flowAB.v;
    var out = new Uint8ClampedArray(src.length);
    var w1 = width - 1, h1 = height - 1;
    var y, x, p, q;
    for (y = 0; y < height; y++) {
      for (x = 0; x < width; x++) {
        p = y * width + x;
        q = p * 4;
        var fx = x - u[p], fy = y - v[p];
        if (fx < 0) fx = 0; else if (fx > w1) fx = w1;
        if (fy < 0) fy = 0; else if (fy > h1) fy = h1;
        var x0 = fx | 0, y0 = fy | 0;
        var x1 = x0 < w1 ? x0 + 1 : x0;
        var y1 = y0 < h1 ? y0 + 1 : y0;
        var ax = fx - x0, ay = fy - y0;
        var w00 = (1 - ax) * (1 - ay), w01 = ax * (1 - ay);
        var w10 = (1 - ax) * ay, w11 = ax * ay;
        var i00 = (y0 * width + x0) * 4, i01 = (y0 * width + x1) * 4;
        var i10 = (y1 * width + x0) * 4, i11 = (y1 * width + x1) * 4;
        out[q] = (src[i00] * w00 + src[i01] * w01) + (src[i10] * w10 + src[i11] * w11);
        out[q + 1] = (src[i00 + 1] * w00 + src[i01 + 1] * w01) + (src[i10 + 1] * w10 + src[i11 + 1] * w11);
        out[q + 2] = (src[i00 + 2] * w00 + src[i01 + 2] * w01) + (src[i10 + 2] * w10 + src[i11 + 2] * w11);
        out[q + 3] = (src[i00 + 3] * w00 + src[i01 + 3] * w01) + (src[i10 + 3] * w10 + src[i11 + 3] * w11);
      }
    }
    if (radius > 0) return smoothRGBA(out, width, height, radius);
    return out;
  }

  function morphFrame(aData, bData, flowAB, flowBA, width, height, t) {
    var n = width * height;
    var out = new Uint8ClampedArray(n * 4);
    var uAB = flowAB.u, vAB = flowAB.v;
    var uBA = flowBA.u, vBA = flowBA.v;
    var thresh = 4.0;
    var inv = 1 - t;
    var w1 = width - 1, h1 = height - 1;
    var a = aData, b = bData;
    for (var y = 0; y < height; y++) {
      for (var x = 0; x < width; x++) {
        var p = y * width + x;
        var q = p * 4;

        // forward/backward consistency: the two flows should point at each other
        var ux = uAB[p], vy = vAB[p];
        var lx = Math.round(x + ux), ly = Math.round(y + vy);
        if (lx < 0) lx = 0; else if (lx > w1) lx = w1;
        if (ly < 0) ly = 0; else if (ly > h1) ly = h1;
        var lp = ly * width + lx;
        var cA = Math.abs(ux + uBA[lp]) + Math.abs(vy + vBA[lp]);

        var ux2 = uBA[p], vy2 = vBA[p];
        var mx = Math.round(x + ux2), my = Math.round(y + vy2);
        if (mx < 0) mx = 0; else if (mx > w1) mx = w1;
        if (my < 0) my = 0; else if (my > h1) my = h1;
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

        var sax = x - t * ux, say = y - t * vy;
        var sbx = x - inv * ux2, sby = y - inv * vy2;
        var fx = sax; if (fx < 0) fx = 0; else if (fx > w1) fx = w1;
        var fy = say; if (fy < 0) fy = 0; else if (fy > h1) fy = h1;
        var x0 = fx | 0, y0 = fy | 0;
        var x1 = x0 < w1 ? x0 + 1 : x0;
        var y1 = y0 < h1 ? y0 + 1 : y0;
        var ax = fx - x0, ay = fy - y0;
        var w00 = (1 - ax) * (1 - ay), w01 = ax * (1 - ay);
        var w10 = (1 - ax) * ay, w11 = ax * ay;
        var ia00 = (y0 * width + x0) * 4, ia01 = (y0 * width + x1) * 4;
        var ia10 = (y1 * width + x0) * 4, ia11 = (y1 * width + x1) * 4;
        fx = sbx; if (fx < 0) fx = 0; else if (fx > w1) fx = w1;
        fy = sby; if (fy < 0) fy = 0; else if (fy > h1) fy = h1;
        x0 = fx | 0; y0 = fy | 0;
        x1 = x0 < w1 ? x0 + 1 : x0;
        y1 = y0 < h1 ? y0 + 1 : y0;
        ax = fx - x0; ay = fy - y0;
        var u00 = (1 - ax) * (1 - ay), u01 = ax * (1 - ay);
        var u10 = (1 - ax) * ay, u11 = ax * ay;
        var ib00 = (y0 * width + x0) * 4, ib01 = (y0 * width + x1) * 4;
        var ib10 = (y1 * width + x0) * 4, ib11 = (y1 * width + x1) * 4;
        var sa0 = (a[ia00] * w00 + a[ia01] * w01) + (a[ia10] * w10 + a[ia11] * w11);
        var sa1 = (a[ia00 + 1] * w00 + a[ia01 + 1] * w01) + (a[ia10 + 1] * w10 + a[ia11 + 1] * w11);
        var sa2 = (a[ia00 + 2] * w00 + a[ia01 + 2] * w01) + (a[ia10 + 2] * w10 + a[ia11 + 2] * w11);
        var sa3 = (a[ia00 + 3] * w00 + a[ia01 + 3] * w01) + (a[ia10 + 3] * w10 + a[ia11 + 3] * w11);
        var sb0 = (b[ib00] * u00 + b[ib01] * u01) + (b[ib10] * u10 + b[ib11] * u11);
        var sb1 = (b[ib00 + 1] * u00 + b[ib01 + 1] * u01) + (b[ib10 + 1] * u10 + b[ib11 + 1] * u11);
        var sb2v = (b[ib00 + 2] * u00 + b[ib01 + 2] * u01) + (b[ib10 + 2] * u10 + b[ib11 + 2] * u11);
        var sb3 = (b[ib00 + 3] * u00 + b[ib01 + 3] * u01) + (b[ib10 + 3] * u10 + b[ib11 + 3] * u11);
        out[q] = Math.round((wa * sa0 + wb * sb0 + eps * (inv * a[q] + t * b[q])) / denom);
        out[q + 1] = Math.round((wa * sa1 + wb * sb1 + eps * (inv * a[q + 1] + t * b[q + 1])) / denom);
        out[q + 2] = Math.round((wa * sa2 + wb * sb2v + eps * (inv * a[q + 2] + t * b[q + 2])) / denom);
        out[q + 3] = Math.round((wa * sa3 + wb * sb3 + eps * (inv * a[q + 3] + t * b[q + 3])) / denom);
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

  // Mesh-based warping

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

  // Interpolate ONLY the alpha channel with the same mesh warp, so an AI frame
  // (RGB model, alpha 255) can borrow the layer's transparency: the silhouette
  // moves with the warp instead of dissolving, and clear areas stay clear.
  function warpAlpha(aData, bData, meshes, width, height, t) {
    var rendered = renderMeshWarps(aData, bData, meshes, width, height, t);
    var n = width * height;
    var alpha = new Uint8Array(n);
    for (var p = 0, q = 0; p < n; p++, q += 4) alpha[p] = rendered.out[q + 3];
    return alpha;
  }

  function renderMeshWarps(aData, bData, meshes, width, height, t) {
    var meshAB = meshes.meshAB, meshBA = meshes.meshBA;
    var n = width * height;
    var out = new Uint8ClampedArray(n * 4);
    var covered = new Uint8Array(n);
    var inv = 1 - t;
    var w1 = width - 1, h1 = height - 1;
    var a = aData, b = bData;
    var uAB = meshAB.u, vAB = meshAB.v, uBA = meshBA.u, vBA = meshBA.v;
    var cols = meshAB.cols, rows = meshAB.rows, cell = meshAB.cell;
    // Hoisted per-row and per-column mesh-sample factors (fx/fy, cell coords,
    // interpolation weights) so the per-pixel hot loop only combines them.
    var fxArr = new Float32Array(width), axArr = new Float32Array(width);
    var i0c = new Int32Array(width), i1c = new Int32Array(width);
    var fyArr = new Float32Array(height), ayArr = new Float32Array(height);
    var j0r = new Int32Array(height), j1r = new Int32Array(height);
    var y, x, p, q;
    for (x = 0; x < width; x++) {
      var ffx = x / cell;
      if (ffx < 0) ffx = 0; else if (ffx > cols - 2) ffx = cols - 2;
      fxArr[x] = ffx;
      i0c[x] = ffx | 0;
      i1c[x] = (ffx | 0) + 1;
      axArr[x] = ffx - (ffx | 0);
    }
    for (y = 0; y < height; y++) {
      var ffy = y / cell;
      if (ffy < 0) ffy = 0; else if (ffy > rows - 2) ffy = rows - 2;
      fyArr[y] = ffy;
      j0r[y] = ffy | 0;
      j1r[y] = (ffy | 0) + 1;
      ayArr[y] = ffy - (ffy | 0);
    }
    // Forward-splat coverage: which output pixels does A's deformation land on?
    for (y = 0; y < height; y++) {
      var fy0 = fyArr[y], ay0 = ayArr[y], j0 = j0r[y], j1 = j1r[y];
      var j0c = j0 * cols, j1c = j1 * cols;
      for (x = 0; x < width; x++) {
        p = y * width + x;
        var i0 = i0c[x], i1 = i1c[x], ax0 = axArr[x];
        var u0 = uAB[j0c + i0] * (1 - ax0) * (1 - ay0) + uAB[j0c + i1] * ax0 * (1 - ay0)
              + uAB[j1c + i0] * (1 - ax0) * ay0 + uAB[j1c + i1] * ax0 * ay0;
        var v0 = vAB[j0c + i0] * (1 - ax0) * (1 - ay0) + vAB[j0c + i1] * ax0 * (1 - ay0)
              + vAB[j1c + i0] * (1 - ax0) * ay0 + vAB[j1c + i1] * ax0 * ay0;
        var qx = Math.round(x + t * u0);
        var qy = Math.round(y + t * v0);
        if (qx < 0) qx = 0; else if (qx > w1) qx = w1;
        if (qy < 0) qy = 0; else if (qy > h1) qy = h1;
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
        var found = false;
        for (var dy2 = -1; dy2 <= 1 && !found; dy2++) {
          var ny = y + dy2;
          if (ny < 0 || ny >= height) continue;
          for (var dx2 = -1; dx2 <= 1; dx2++) {
            if (dx2 === 0 && dy2 === 0) continue;
            var nx = x + dx2;
            if (nx < 0 || nx >= width) continue;
            if (covered[ny * width + nx]) { found = true; break; }
          }
        }
        if (found) covered[y * width + x] = 1;
      }
    }
    for (y = 0; y < height; y++) {
      var fy1 = fyArr[y], ay1 = ayArr[y], j0b = j0r[y], j1b = j1r[y];
      var j0bc = j0b * cols, j1bc = j1b * cols;
      for (x = 0; x < width; x++) {
        p = y * width + x;
        q = p * 4;
        var i0b = i0c[x], i1b = i1c[x], ax1 = axArr[x];
        var omax = 1 - ax1, omay = 1 - ay1;
        if (covered[p]) {
          var uA = uAB[j0bc + i0b] * omax * omay + uAB[j0bc + i1b] * ax1 * omay
                 + uAB[j1bc + i0b] * omax * ay1 + uAB[j1bc + i1b] * ax1 * ay1;
          var vA = vAB[j0bc + i0b] * omax * omay + vAB[j0bc + i1b] * ax1 * omay
                 + vAB[j1bc + i0b] * omax * ay1 + vAB[j1bc + i1b] * ax1 * ay1;
          var uB = uBA[j0bc + i0b] * omax * omay + uBA[j0bc + i1b] * ax1 * omay
                 + uBA[j1bc + i0b] * omax * ay1 + uBA[j1bc + i1b] * ax1 * ay1;
          var vB = vBA[j0bc + i0b] * omax * omay + vBA[j0bc + i1b] * ax1 * omay
                 + vBA[j1bc + i0b] * omax * ay1 + vBA[j1bc + i1b] * ax1 * ay1;
          var sax = x - t * uA, say = y - t * vA;
          var sbx = x - inv * uB, sby = y - inv * vB;
          var fx = sax; if (fx < 0) fx = 0; else if (fx > w1) fx = w1;
          var fy = say; if (fy < 0) fy = 0; else if (fy > h1) fy = h1;
          var x0 = fx | 0, y0 = fy | 0;
          var x1 = x0 < w1 ? x0 + 1 : x0;
          var y1 = y0 < h1 ? y0 + 1 : y0;
          var ax = fx - x0, ay = fy - y0;
          var w00 = (1 - ax) * (1 - ay), w01 = ax * (1 - ay);
          var w10 = (1 - ax) * ay, w11 = ax * ay;
          var ia00 = (y0 * width + x0) * 4, ia01 = (y0 * width + x1) * 4;
          var ia10 = (y1 * width + x0) * 4, ia11 = (y1 * width + x1) * 4;
          fx = sbx; if (fx < 0) fx = 0; else if (fx > w1) fx = w1;
          fy = sby; if (fy < 0) fy = 0; else if (fy > h1) fy = h1;
          x0 = fx | 0; y0 = fy | 0;
          x1 = x0 < w1 ? x0 + 1 : x0;
          y1 = y0 < h1 ? y0 + 1 : y0;
          ax = fx - x0; ay = fy - y0;
          var u00 = (1 - ax) * (1 - ay), u01 = ax * (1 - ay);
          var u10 = (1 - ax) * ay, u11 = ax * ay;
          var ib00 = (y0 * width + x0) * 4, ib01 = (y0 * width + x1) * 4;
          var ib10 = (y1 * width + x0) * 4, ib11 = (y1 * width + x1) * 4;
          var sa0 = (a[ia00] * w00 + a[ia01] * w01) + (a[ia10] * w10 + a[ia11] * w11);
          var sa1 = (a[ia00 + 1] * w00 + a[ia01 + 1] * w01) + (a[ia10 + 1] * w10 + a[ia11 + 1] * w11);
          var sa2 = (a[ia00 + 2] * w00 + a[ia01 + 2] * w01) + (a[ia10 + 2] * w10 + a[ia11 + 2] * w11);
          var sa3 = (a[ia00 + 3] * w00 + a[ia01 + 3] * w01) + (a[ia10 + 3] * w10 + a[ia11 + 3] * w11);
          var sb0 = (b[ib00] * u00 + b[ib01] * u01) + (b[ib10] * u10 + b[ib11] * u11);
          var sb1 = (b[ib00 + 1] * u00 + b[ib01 + 1] * u01) + (b[ib10 + 1] * u10 + b[ib11 + 1] * u11);
          var sb2 = (b[ib00 + 2] * u00 + b[ib01 + 2] * u01) + (b[ib10 + 2] * u10 + b[ib11 + 2] * u11);
          var sb3 = (b[ib00 + 3] * u00 + b[ib01 + 3] * u01) + (b[ib10 + 3] * u10 + b[ib11 + 3] * u11);
          out[q] = Math.round(inv * sa0 + t * sb0);
          out[q + 1] = Math.round(inv * sa1 + t * sb1);
          out[q + 2] = Math.round(inv * sa2 + t * sb2);
          out[q + 3] = Math.round(inv * sa3 + t * sb3);
        } else if (uRaw) {
          var fu = bilinearField(uRaw, width, height, x, y);
          var fv = bilinearField(vRaw, width, height, x, y);
          var sb2x = x - inv * fu, sb2y = y - inv * fv;
          var fx2 = sb2x; if (fx2 < 0) fx2 = 0; else if (fx2 > w1) fx2 = w1;
          var fy2 = sb2y; if (fy2 < 0) fy2 = 0; else if (fy2 > h1) fy2 = h1;
          var x0 = fx2 | 0, y0 = fy2 | 0;
          var x1 = x0 < w1 ? x0 + 1 : x0;
          var y1 = y0 < h1 ? y0 + 1 : y0;
          var ax = fx2 - x0, ay = fy2 - y0;
          var w00 = (1 - ax) * (1 - ay), w01 = ax * (1 - ay);
          var w10 = (1 - ax) * ay, w11 = ax * ay;
          var ib2 = (y0 * width + x0) * 4, ib3 = (y0 * width + x1) * 4;
          var ib4 = (y1 * width + x0) * 4, ib5 = (y1 * width + x1) * 4;
          out[q] = Math.round((b[ib2] * w00 + b[ib3] * w01) + (b[ib4] * w10 + b[ib5] * w11));
          out[q + 1] = Math.round((b[ib2 + 1] * w00 + b[ib3 + 1] * w01) + (b[ib4 + 1] * w10 + b[ib5 + 1] * w11));
          out[q + 2] = Math.round((b[ib2 + 2] * w00 + b[ib3 + 2] * w01) + (b[ib4 + 2] * w10 + b[ib5 + 2] * w11));
          out[q + 3] = (b[ib2 + 3] * w00 + b[ib3 + 3] * w01) + (b[ib4 + 3] * w10 + b[ib5 + 3] * w11);
        } else {
          // No raw flow available: fall back to B at rest.
          var x0 = x < w1 ? x : w1, y0 = y < h1 ? y : h1;
          var ib6 = (y0 * width + x0) * 4;
          out[q] = b[ib6]; out[q + 1] = b[ib6 + 1]; out[q + 2] = b[ib6 + 2]; out[q + 3] = b[ib6 + 3];
        }
      }
    }
    return { out: out, covered: covered };
  }

  // Local recognition + generation pass

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

  function motionStats(meshes, width, height) {
    var mesh = meshes.meshAB;
    var cols = mesh.cols, rows = mesh.rows, cell = mesh.cell;
    var sumU = 0, sumV = 0, sumMag = 0, count = 0;
    var sumX = 0, sumY = 0;
    for (var j = 0; j < rows; j++) {
      for (var i = 0; i < cols; i++) {
        var idx = j * cols + i;
        var u = mesh.u[idx], v = mesh.v[idx];
        var mag = Math.sqrt(u * u + v * v);
        if (mag < 1.5) continue;
        sumU += u * mag; sumV += v * mag; sumMag += mag; count++;
        sumX += (i * cell) * mag; sumY += (j * cell) * mag;
      }
    }
    if (!count || sumMag < 1e-6) return null;
    var ux = sumU / sumMag, uy = sumV / sumMag;
    var len = Math.sqrt(ux * ux + uy * uy);
    if (len < 1e-6) return null;
    var cx = sumX / sumMag, cy = sumY / sumMag;
    if (cx < 0) cx = 0; else if (cx > width - 1) cx = width - 1;
    if (cy < 0) cy = 0; else if (cy > height - 1) cy = height - 1;
    return {
      ux: ux / len, uy: uy / len,
      avgU: ux, avgV: uy,
      cx: cx, cy: cy,
      mag: len
    };
  }

  function squashStretchFrame(aData, bData, meshes, width, height, t, opts) {
    var stats = motionStats(meshes, width, height);
    if (!stats) return aData.slice();
    opts = opts || {};
    var dist = Math.sqrt(stats.avgU * stats.avgU + stats.avgV * stats.avgV);
    var autoK = Math.min(0.35, Math.max(0.06, dist / 100));
    var amount = opts.amount != null && isFinite(opts.amount) ? opts.amount : autoK;
    amount = Math.max(-0.8, Math.min(0.8, amount));
    var curve = opts.curve || 'peak';
    var p;
    if (curve === 'peak') p = Math.sin(Math.PI * t);
    else if (curve === 'impact') p = t;
    else if (curve === 'ease') p = 0.5 * (1 - Math.cos(Math.PI * t));
    else p = t;
    var kEff = amount * p;
    var s = 1 - kEff;
    if (s < 0.4) s = 0.4; else if (s > 1.8) s = 1.8;
    var preserve = opts.preserve || 'area';
    var perp = preserve === 'volume' ? 1 / Math.sqrt(s) : 1 / s;
    var px = opts.px != null && isFinite(opts.px) ? opts.px : stats.cx;
    var py = opts.py != null && isFinite(opts.py) ? opts.py : stats.cy;
    if (px < 0) px = 0; else if (px > width - 1) px = width - 1;
    if (py < 0) py = 0; else if (py > height - 1) py = height - 1;
    return affineScale(aData, width, height, stats.ux, stats.uy, s, perp, px, py);
  }

  function affineScale(src, width, height, ux, uy, s, inv, px, py) {
    var n = width * height;
    var out = new Uint8ClampedArray(n * 4);
    var cx = px != null && isFinite(px) ? px : width / 2;
    var cy = py != null && isFinite(py) ? py : height / 2;
    var w1 = width - 1, h1 = height - 1;
    for (var y = 0; y < height; y++) {
      for (var x = 0; x < width; x++) {
        var dx = x - cx, dy = y - cy;
        var along = dx * ux + dy * uy;
        var perp = dx * -uy + dy * ux;
        var fx = cx + (along / s) * ux - (perp / inv) * uy;
        var fy = cy + (along / s) * uy + (perp / inv) * ux;
        if (fx < 0) fx = 0; else if (fx > w1) fx = w1;
        if (fy < 0) fy = 0; else if (fy > h1) fy = h1;
        var x0 = fx | 0, y0 = fy | 0;
        var x1 = x0 < w1 ? x0 + 1 : x0;
        var y1 = y0 < h1 ? y0 + 1 : y0;
        var ax = fx - x0, ay = fy - y0;
        var w00 = (1 - ax) * (1 - ay), w01 = ax * (1 - ay);
        var w10 = (1 - ax) * ay, w11 = ax * ay;
        var q = (y * width + x) * 4;
        var i00 = (y0 * width + x0) * 4, i01 = (y0 * width + x1) * 4;
        var i10 = (y1 * width + x0) * 4, i11 = (y1 * width + x1) * 4;
        out[q] = Math.round((src[i00] * w00 + src[i01] * w01) + (src[i10] * w10 + src[i11] * w11));
        out[q + 1] = Math.round((src[i00 + 1] * w00 + src[i01 + 1] * w01) + (src[i10 + 1] * w10 + src[i11 + 1] * w11));
        out[q + 2] = Math.round((src[i00 + 2] * w00 + src[i01 + 2] * w01) + (src[i10 + 2] * w10 + src[i11 + 2] * w11));
        out[q + 3] = Math.round((src[i00 + 3] * w00 + src[i01 + 3] * w01) + (src[i10 + 3] * w10 + src[i11 + 3] * w11));
      }
    }
    return out;
  }

  // Motion blur for inbetween frames: smears the rendered frame along the local
  // motion direction (the mesh flow), with the amount scaling with the pixel's
  // motion magnitude and easing in and out across the gap (sin(pi·t): no blur at
  // the keyframes, peak mid-gap). Static regions are copied untouched, so only
  // content that actually moved gets a streak — that is what makes it accurate
  // motion blur (and what masks warp/AI imperfections along the motion path).
  function motionBlurFrame(rgba, meshes, width, height, t, intensity) {
    var n = width * height;
    var out = new Uint8ClampedArray(rgba.length);
    if (!(intensity > 0) || !meshes || !meshes.meshAB) { out.set(rgba); return out; }
    var mesh = meshes.meshAB;
    var cols = mesh.cols, rows = mesh.rows, cell = mesh.cell;
    var mu = mesh.u, mv = mesh.v;
    var w1 = width - 1, h1 = height - 1;
    var ease = Math.sin(Math.PI * t);
    if (!(ease > 0)) { out.set(rgba); return out; }
    var fxArr = new Float32Array(width), axArr = new Float32Array(width);
    var i0c = new Int32Array(width), i1c = new Int32Array(width);
    var fyArr = new Float32Array(height), ayArr = new Float32Array(height);
    var j0r = new Int32Array(height), j1r = new Int32Array(height);
    for (var x = 0; x < width; x++) {
      var ffx = x / cell;
      if (ffx < 0) ffx = 0; else if (ffx > cols - 2) ffx = cols - 2;
      fxArr[x] = ffx;
      i0c[x] = ffx | 0;
      i1c[x] = (ffx | 0) + 1;
      axArr[x] = ffx - (ffx | 0);
    }
    for (var y = 0; y < height; y++) {
      var ffy = y / cell;
      if (ffy < 0) ffy = 0; else if (ffy > rows - 2) ffy = rows - 2;
      fyArr[y] = ffy;
      j0r[y] = ffy | 0;
      j1r[y] = (ffy | 0) + 1;
      ayArr[y] = ffy - (ffy | 0);
    }
    var MAX_TRAIL = 24;   // longest streak in px (cap keeps tap count sane)
    var MAX_TAPS = 12;    // cap on samples per pixel
    var src = rgba;
    for (y = 0; y < height; y++) {
      var j0 = j0r[y], j1 = j1r[y], ay = ayArr[y];
      var omay = 1 - ay;
      var j0c = j0 * cols, j1c = j1 * cols;
      for (x = 0; x < width; x++) {
        var p = y * width + x;
        var q = p * 4;
        var i0 = i0c[x], i1 = i1c[x], ax = axArr[x];
        var omax = 1 - ax;
        var ux = mu[j0c + i0] * omax * omay + mu[j0c + i1] * ax * omay
               + mu[j1c + i0] * omax * ay + mu[j1c + i1] * ax * ay;
        var vy = mv[j0c + i0] * omax * omay + mv[j0c + i1] * ax * omay
               + mv[j1c + i0] * omax * ay + mv[j1c + i1] * ax * ay;
        var mag = Math.sqrt(ux * ux + vy * vy);
        var trail = ease * intensity * mag;
        if (trail < 0.6) {
          out[q] = src[q]; out[q + 1] = src[q + 1]; out[q + 2] = src[q + 2]; out[q + 3] = src[q + 3];
          continue;
        }
        if (trail > MAX_TRAIL) trail = MAX_TRAIL;
        var taps = Math.min(MAX_TAPS, 1 + 2 * Math.round(trail / 2));
        if (taps < 3) taps = 3;
        var dx = ux / mag, dy = vy / mag;
        var half = taps >> 1;
        var step = trail / (taps - 1);
        var r0 = 0, g0 = 0, b0 = 0, a0 = 0;
        for (var k = 0; k < taps; k++) {
          var off = (k - half) * step;
          var fx = x + dx * off, fy = y + dy * off;
          if (fx < 0) fx = 0; else if (fx > w1) fx = w1;
          if (fy < 0) fy = 0; else if (fy > h1) fy = h1;
          var x0 = fx | 0, y0 = fy | 0;
          var x1 = x0 < w1 ? x0 + 1 : x0;
          var y1 = y0 < h1 ? y0 + 1 : y0;
          var ax2 = fx - x0, ay2 = fy - y0;
          var w00 = (1 - ax2) * (1 - ay2), w01 = ax2 * (1 - ay2);
          var w10 = (1 - ax2) * ay2, w11 = ax2 * ay2;
          var i00 = (y0 * width + x0) * 4, i01 = (y0 * width + x1) * 4;
          var i10 = (y1 * width + x0) * 4, i11 = (y1 * width + x1) * 4;
          r0 += (src[i00] * w00 + src[i01] * w01) + (src[i10] * w10 + src[i11] * w11);
          g0 += (src[i00 + 1] * w00 + src[i01 + 1] * w01) + (src[i10 + 1] * w10 + src[i11 + 1] * w11);
          b0 += (src[i00 + 2] * w00 + src[i01 + 2] * w01) + (src[i10 + 2] * w10 + src[i11 + 2] * w11);
          a0 += (src[i00 + 3] * w00 + src[i01 + 3] * w01) + (src[i10 + 3] * w10 + src[i11 + 3] * w11);
        }
        out[q] = r0 / taps;
        out[q + 1] = g0 / taps;
        out[q + 2] = b0 / taps;
        out[q + 3] = a0 / taps;
      }
    }
    return out;
  }

  // True when every pixel's alpha channel is 255 (no transparency). Lets the AI
  // path skip the mesh-warped alpha pass entirely — RIFE already renders alpha
  // 255, so the result is byte-identical while saving a full mesh warp per frame.
  function isOpaque(rgba) {
    for (var i = 3; i < rgba.length; i += 4) {
      if (rgba[i] !== 255) return false;
    }
    return true;
  }
  return {
    computeFlow: computeFlow,
    computeFlowBoth: computeFlowBoth,
    warpFrame: warpFrame,
    smoothRGBA: smoothRGBA,
    gateFill: gateFill,
    morphFrame: morphFrame,
    morphFrameMesh: morphFrameMesh,
    motionBlurFrame: motionBlurFrame,
    squashStretchFrame: squashStretchFrame,
    warpAlpha: warpAlpha,
    synthesizeInbetweenFrame: synthesizeInbetweenFrame,
    buildMeshes: buildMeshes,
    blendFrame: blendFrame,
    isOpaque: isOpaque
  };
})();
