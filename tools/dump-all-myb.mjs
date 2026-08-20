import fs from 'fs';
for (const f of process.argv.slice(2)) {
  console.log('=== ' + f + ' ===');
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  const keys = ['radius_logarithmic','opaque','opaque_multiply','hardness','anti_aliasing',
    'offset_by_random','offset_by_speed','offset_by_speed_slowness','radius_by_random',
    'elliptical_dab_ratio','elliptical_dab_angle','dabs_per_actual_radius','dabs_per_basic_radius',
    'dabs_per_second','smudge','smudge_length','smudge_length_log','smudge_transparency',
    'smudge_radius_log','slow_tracking','slow_tracking_per_dab','tracking_noise',
    'speed1_gamma','speed1_slowness','speed2_gamma','speed2_slowness','direction_filter',
    'stroke_duration_logarithmic','stroke_holdtime','stroke_threshold','opaque_linearize',
    'color_h','color_s','color_v','change_color_h','change_color_hsv_s','change_color_v'];
  for (const k of keys) {
    const s = j.settings[k];
    if (!s) continue;
    const ins = Object.keys(s.inputs || {});
    let line = k + ': base=' + s.base_value;
    if (ins.length) {
      line += ' inputs{';
      for (const i of ins) line += i + '=' + JSON.stringify(s.inputs[i]);
      line += '}';
    }
    console.log('  ' + line);
  }
}