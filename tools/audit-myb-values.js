#!/usr/bin/env node
// Value-level MyPaint (.myb) audit.
// For every bundled .myb brush, list each setting's base_value AND which input
// curves it carries (pressure/speed/random/direction/stroke). A setting only
// affects rendering if its base_value differs from the libmypaint default OR it
// has an input curve. Cross-referenced against the settings the paint engine
// actually evaluates (engHardset) so we can see the genuine coverage gaps.
//
// Usage: node tools/audit-myb-values.js
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'brushes');

// libmypaint default base_value for each setting (from mypaint-brush.c
// mypaint_brush_setting_info defaults). Settings not listed default to 0.
const MYPAINT_DEFAULT = {
  radius_logarithmic: 0.34, hardness: 0.5, opaque: 1, opaque_multiply: 0,
  opaque_linearize: 0, dabs_per_actual_radius: 2, dabs_per_basic_radius: 0,
  dabs_per_second: 0, radius_by_random: 0, offset_by_random: 0, offset_by_speed: 0,
  offset_by_speed_slowness: 0.7, speed1_gamma: 0, speed1_slowness: 0.07,
  speed2_gamma: 0, speed2_slowness: 0.07, offset_angle: 0, offset_angle_2: 0,
  offset_angle_2_asc: 0, offset_angle_2_view: 0, offset_angle_adj: 0,
  offset_angle_asc: 0, offset_angle_view: 0, offset_multiplier: 1, offset_x: 0,
  offset_y: 0, angular_vel_filter: 0, slow_tracking: 0, slow_tracking_per_dab: 0,
  tracking_noise: 0, color_h: 0, color_s: 0, color_v: 0, restore_color: 0,
  change_color_h: 0, change_color_hsl_s: 0, change_color_hsv_s: 0, change_color_l: 0,
  change_color_v: 0, change_color: 0, colorize: 0, posterize: 0, posterize_num: 0,
  paint_mode: 0, smudge: 0, smudge_length: 0.5, smudge_radius_log: 0.0,
  smudge_transparency: 0, smudge_bucket: 0, snap_to_pixel: 0, pressure_gain_log: 0,
  gridmap_scale: 0.8, gridmap_scale_x: 1, gridmap_scale_y: 1, ellipical_dab_ratio: 1,
  elliptical_dab_ratio: 1, elliptical_dab_angle: 0, direction_filter: 0.2,
  stroke_threshold: 0.02, stroke_duration_logarithmic: Math.log(4), stroke_holdtime: 0,
  custom_input: 0, custom_input_slowness: 0.05, eraser: 0, lock_alpha: 0, anti_aliasing: 1
};

// Settings the engine (paint.js mypaintDab / myStrokeUpdate) actually evaluates.
const ENG_HARDSET = new Set([
  'radius_logarithmic', 'radius_by_random', 'opaque', 'opaque_multiply',
  'opaque_linearize', 'hardness', 'offset_by_random', 'offset_by_speed',
  'elliptical_dab_ratio', 'elliptical_dab_angle', 'dabs_per_second',
  'speed1_gamma', 'speed1_slowness', 'speed2_gamma', 'speed2_slowness',
  'direction_filter', 'stroke_duration_logarithmic', 'stroke_holdtime'
]);

function fmt(v) {
  if (typeof v !== 'number') return '' + v;
  return Math.abs(v) < 1e-9 ? '0' : (Math.round(v * 1000) / 1000).toString();
}

for (const fn of fs.readdirSync(dir).sort()) {
  if (!fn.endsWith('.myb')) continue;
  let settings;
  try { settings = JSON.parse(fs.readFileSync(path.join(dir, fn), 'utf8')).settings; }
  catch (e) { console.log('MYB ' + fn + ': unparseable'); continue; }
  console.log('\n=== MYB ' + fn + ' ===');
  const rows = [];
  for (const k of Object.keys(settings)) {
    const s = settings[k];
    const base = (typeof s.base_value === 'number') ? s.base_value : NaN;
    const def = MYPAINT_DEFAULT[k];
    const nonDefault = isNaN(base) ? true : (def === undefined ? true : Math.abs(base - def) > 1e-6);
    const inputs = s.inputs || {};
    const inputKeys = Object.keys(inputs);
    if (!nonDefault && inputKeys.length === 0) continue; // truly at default -> skip
    const handled = ENG_HARDSET.has(k);
    const parts = [];
    parts.push('base=' + fmt(base));
    if (inputKeys.length) parts.push('inputs=[' + inputKeys.join(',') + ']');
    parts.push(handled ? 'OK' : '*** UNHANDLED ***');
    rows.push('  - ' + k + '  ' + parts.join(' '));
  }
  if (!rows.length) console.log('  (all settings at libmypaint defaults)');
  else console.log(rows.join('\n'));
}
