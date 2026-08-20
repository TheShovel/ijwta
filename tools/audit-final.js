// Final consolidated audit: dumps every Krita brush config (`.myb` + `.kpp`)
// and cross-references the settings each brush actually contains against what
// the paint engine (src/paint.js) truly consumes. Run:
//   node tools/audit-final.js
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BRUSHES = path.join(ROOT, 'brushes');

// settings/elements the engine actually evaluates (verified against paint.js)
const MYPAINT_CONSUMED = new Set([
  'radius_logarithmic', 'radius_by_random', 'opaque', 'opaque_multiply',
  'opaque_linearize', 'hardness', 'offset_by_random', 'offset_by_speed',
  'slow_tracking_per_dab', 'elliptical_dab_ratio', 'elliptical_dab_angle',
  'smudge', 'smudge_length', 'smudge_length_log', 'smudge_transparency',
  'color_h', 'color_s', 'color_v', 'dabs_per_second', 'direction_filter',
  'stroke_duration_logarithmic', 'stroke_holdtime', 'speed1_gamma',
  'speed1_slowness', 'speed2_gamma', 'speed2_slowness'
]);
// mypaint settings present in some brushes but NOT yet evaluated/rendered:
const MYPAINT_UNIMPLEMENTED = [
  'pressure_gain_log', 'tracking_noise', 'slow_tracking', 'anti_aliasing',
  'radius_by_random_log', 'offset_multiplier', 'offset_x', 'offset_y',
  'offset_angle', 'offset_angle_asc', 'offset_angle_view', 'offset_angle_2',
  'offset_angle_2_asc', 'offset_angle_2_view', 'offset_angle_adj',
  'offset_by_speed_slowness', 'elliptical_dab_angle_log', 'custom_input',
  'custom_input_slowness', 'stroke_threshold', 'gridmap_scale',
  'gridmap_scale_x', 'gridmap_scale_y', 'snap_to_pixel', 'change_color_h',
  'change_color_hsv_s', 'change_color_v', 'change_color_l', 'change_color_hsl_s',
  'colorize', 'posterize', 'posterize_num', 'lock_alpha', 'paint_mode',
  'smudge_radius_log', 'eraser', 'dabs_per_basic_radius', 'dabs_per_actual_radius',
  'offset_by_random_logarithmic', 'speed1_slowness_log', 'speed2_slowness_log'
];

const KPP_CONSUMED = ['sizeCurve', 'opacityCurve', 'rotationCurve',
  'scatterCurve', 'scatterAxisX', 'scatterAxisY', 'flowValue', 'spacing'];
const KPP_UNIMPLEMENTED = ['softnessCurve', 'sharpnessCurve', 'textureAsPattern',
  'textureStrength', 'airbrushing', 'mirror', 'darken', 'mix', 'maskingBrush',
  'precision', 'hsvSourceDynamics'];

function parseMyb(buf) {
  // .myb files in this repo are plain JSON (not gzipped).
  try { return JSON.parse(buf.toString('utf8')); } catch (e) { return null; }
}
function parseKpp(buf) {
  // .kpp is a PNG whose zTXt chunk (keyword "preset") holds the deflated
  // brush-definition XML (Krita's storage format).
  if (!(buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)) return null;
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.slice(off + 8, off + 8 + len);
    if (type === 'zTXt') {
      const nul = data.indexOf(0);
      const kw = data.slice(0, nul).toString('latin1');
      if (kw === 'preset') {
        const method = data[nul + 1];
        if (method !== 0) return null;
        try { return zlib.inflateSync(data.slice(nul + 2)).toString('utf8'); } catch (e) { return null; }
      }
    }
    off += 12 + len;
  }
  return null;
}

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'tips') walk(p, out); }
    else if (/\.(myb|kpp)$/i.test(e.name)) out.push(p);
  }
}

const files = [];
walk(BRUSHES, files);
const rows = [];
for (const f of files) {
  const rel = path.relative(ROOT, f);
  const buf = fs.readFileSync(f);
  if (/\.myb$/i.test(f)) {
    let j;
    try { j = parseMyb(buf); } catch (e) { rows.push([rel, 'myb', 'PARSE-FAIL', [], []]); continue; }
    if (!j || !j.settings) { rows.push([rel, 'myb', 'NO-SETTINGS', [], []]); continue; }
    const present = Object.keys(j.settings);
    const used = present.filter(s => MYPAINT_CONSUMED.has(s));
    const missing = present.filter(s => !MYPAINT_CONSUMED.has(s) && !MYPAINT_UNIMPLEMENTED.includes(s));
    const unimp = present.filter(s => MYPAINT_UNIMPLEMENTED.includes(s) && s !== 'dabs_per_basic_radius' && s !== 'dabs_per_actual_radius');
    rows.push([rel, 'myb', j.version || '?', used, unimp]);
  } else {
    const xml = parseKpp(buf);
    if (!xml) { rows.push([rel, 'kpp', 'ZTXT-FAIL', [], []]); continue; }
    const has = [];
    if (/SizeUseCurve[^]*?(?:id="pressure"|<params id="pressure">)/i.test(xml)) has.push('sizeCurve(pressure)');
    else if (/SizeSensor|<params id="pressure"/i.test(xml)) has.push('sizeCurve*');
    if (/OpacityUseCurve|<params id="pressure"[^]*?Opacity/i.test(xml) && /<params id="pressure">/i.test(xml)) has.push('opacityCurve?');
    if (/RotationUseCurve/i.test(xml)) has.push('rotationCurve');
    if (/ScatterValue|Scattering|scatterSensor|ScatterSensor/i.test(xml)) has.push('scatter');
    if (/FlowValue/i.test(xml)) has.push('flow');
    if (/Spacing\b/i.test(xml)) has.push('spacing');
    // meaningful unimplemented features (enabled/real nodes only):
    const un = [];
    if (/<Airbrush[\s>]/i.test(xml)) un.push('airbrushing');
    if (/<Texture\b[^>]*\bPattern=/i.test(xml)) un.push('texturePattern');
    if (/<Softness\b[^>]*\bUseCurve=["']?true/i.test(xml)) un.push('softnessCurve');
    if (/<Sharpness\b[^>]*\bUseCurve=["']?true/i.test(xml)) un.push('sharpnessCurve');
    if (/useColorSource|colorSource|<ColorSource|dynamicsType2/i.test(xml)) un.push('colorSource');
    if (/MaskingBrush|maskingbrush/i.test(xml)) un.push('maskingBrush');
    rows.push([rel, 'kpp', '-', has, un]);
  }
}

// print
console.log('# Final Brush Audit — settings present vs. engine support\n');
console.log('| brush | type | ver | settings consumed | notable unimplemented |');
console.log('|---|---|---|---|---|');
for (const [rel, type, ver, used, unimp] of rows) {
  const u = used.length ? used.join(', ') : '—';
  const m = unimp.length ? [...new Set(unimp)].join(', ') : '—';
  console.log(`| ${rel} | ${type} | ${ver} | ${u} | ${m} |`);
}
console.log(`\nTotal brushes audited: ${rows.length} (myb: ${rows.filter(r=>r[1]==='myb').length}, kpp: ${rows.filter(r=>r[1]==='kpp').length})`);
