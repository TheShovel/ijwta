#!/usr/bin/env node
// For each .myb, list settings whose base_value differs from libmypaint defaults
// (or that have inputs curves), so we know what actually matters per brush.
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'brushes');

// libmypaint default base_values (from mypaint-brush-settings default table)
const DEFAULTS = {
  radius_logarithmic: Math.log(1.3), opaque: 1.0, opaque_multiply: 1.0, hardness: 0.5,
  anti_aliasing: 1.0, dabs_per_actual_radius: 2.0, dabs_per_basic_radius: 0.0,
  dabs_per_second: 0.0, radius_by_random: 0.0, offset_by_random: 0.0,
  offset_by_speed: 0.0, opaque_linearize: 1.0, slow_tracking: 0.0,
  slow_tracking_per_dab: 0.3, tracking_noise: 0.0, speed1_gamma: 0.0,
  speed1_slowness: 1.0, speed2_gamma: 0.0, speed2_slowness: 1.0,
  offset_by_speed_slowness: 30.0, offset_multiplier: 0.0, offset_x: 0.0, offset_y: 0.0,
  offset_angle: 0.0, offset_angle_adj: 0.0, offset_angle_asc: 0.0, offset_angle_view: 0.0,
  offset_angle_2: 0.0, offset_angle_2_asc: 0.0, offset_angle_2_view: 0.0,
  elliptical_dab_ratio: 1.0, elliptical_dab_angle: 0.0, direction_filter: 0.0,
  custom_input: 0.0, custom_input_slowness: 50.0, stroke_threshold: 0.0,
  stroke_duration_logarithmic: Math.log(0.5), stroke_holdtime: 0.0,
  pressure_gain_log: 0.0, smudge: 0.0, smudge_length: 0.5, smudge_radius_log: 0.0,
  smudge_length_log: 0.0, smudge_bucket: 0.0, smudge_transparency: 0.5,
  colorize: 0.0, lock_alpha: 0.0, posterize: 0.0, posterize_num: 10.0,
  change_color_h: 0.0, change_color_l: 0.0, change_color_v: 0.0,
  change_color_hsl_s: 0.0, change_color_hsv_s: 0.0, restore_color: 0.0,
  snap_to_pixel: 0.0, eraser: 0.0, gridmap_scale: 1.0, gridmap_scale_x: 1.0,
  gridmap_scale_y: 1.0, paint_mode: 1.0
};

for (const fn of fs.readdirSync(dir).sort()) {
  if (!fn.endsWith('.myb')) continue;
  const buf = fs.readFileSync(path.join(dir, fn));
  let j;
  try { j = JSON.parse(buf.toString('utf8')); } catch (e) { continue; }
  const s = (j && j.settings) || {};
  const interesting = [];
  for (const [k, v] of Object.entries(s)) {
    const bv = v && v.base_value !== undefined ? +v.base_value : NaN;
    const def = DEFAULTS[k];
    const hasCurve = v && v.inputs && Object.keys(v.inputs).length;
    const differs = (def !== undefined && isFinite(bv) && Math.abs(bv - def) > 0.001) ||
                    (def === undefined && isFinite(bv) && bv !== 0);
    if (differs || hasCurve) {
      interesting.push(k + (isFinite(bv) ? '=' + (+bv.toFixed(3)) : '') + (hasCurve ? '{' + Object.keys(v.inputs).join(',') + '}' : ''));
    }
  }
  console.log(fn + ':');
  console.log('  ' + (interesting.join('  ') || '(all defaults)'));
}
