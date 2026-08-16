/* The editor is split into the files in src/, loaded as plain scripts in order.
 *
 * Khuwari, the browser animation tool. Places keyframe images on a timeline
 * at arbitrary times; each gap between two keyframes is filled with
 * interpolated frames, one per tick of the gap (gapSeconds * FPS - 1 frames).
 * The default gap mode runs a local machine learning model (RIFE via ONNX
 * Runtime Web, see model.js) in the browser; a pure-JS mesh warp engine (see
 * morph.js) is the fallback when the model can't be loaded, and
 * squash-and-stretch and no-interpolation modes are per-gap options. Static
 * site, no server, no GPU.
 */
'use strict';

var morph = window.KHUWARI_MORPH;
var gifenc = window.gifenc;
var model = window.KHUWARI_MODEL;
