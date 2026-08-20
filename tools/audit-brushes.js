#!/usr/bin/env node
// Audit: dump every setting present in every bundled brush (.myb + .kpp),
// grouped by brush. Also flags which settings our parser currently implements.
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const dir = path.join(__dirname, '..', 'brushes');

// Settings our mypaint engine (mySetting + the per-dab evaluator in paint.js)
// actually implements. Any setting with a base_value and/or input curves is
// evaluated dynamically, so this set is the full libmypaint setting surface
// we handle rather than an exhaustive allow-list.
const MYB_SUPPORTED = new Set([
  'radius_logarithmic', 'radius_by_random', 'opaque', 'opaque_multiply', 'opaque_linearize',
  'hardness', 'anti_aliasing', 'dabs_per_actual_radius', 'dabs_per_basic_radius',
  'dabs_per_second', 'offset_by_random', 'offset_by_speed', 'slow_tracking_per_dab',
  'elliptical_dab_ratio', 'elliptical_dab_angle',
  'speed1_gamma', 'speed1_slowness', 'speed2_gamma', 'speed2_slowness',
  'direction_filter', 'stroke_duration_logarithmic', 'stroke_holdtime',
  'color_h', 'color_s', 'color_v',
  'smudge', 'smudge_length', 'smudge_length_log', 'smudge_transparency'
]);

function r32be(b, o) { return (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]; }

function parseMyb(buf) {
  try {
    const j = JSON.parse(buf.toString('utf8'));
    return (j && j.settings) || {};
  } catch (e) { return null; }
}

function parseKpp(buf) {
  if (buf[0] !== 0x89) return null; // zip format — skip
  let o = 8, xml = null;
  while (o + 8 <= buf.length) {
    const len = r32be(buf, o);
    const type = buf.slice(o + 4, o + 8).toString();
    if (type === 'zTXt') {
      let i = 0;
      while (buf[o + 8 + i] !== 0) i++;
      try { xml = zlib.inflateSync(buf.slice(o + 8 + i + 2, o + 8 + len)).toString(); } catch (e) {}
    }
    if (type === 'IEND') break;
    o += 12 + len;
  }
  return xml;
}

const mybAll = new Set();
const kppAll = new Set();
const kppCurveParams = new Set(); // params that have pressure/random/etc curves

for (const fn of fs.readdirSync(dir).sort()) {
  const full = path.join(dir, fn);
  if (!fs.statSync(full).isFile()) continue;
  const buf = fs.readFileSync(full);
  if (fn.endsWith('.myb')) {
    const s = parseMyb(buf);
    if (!s) { console.log('MYB ' + fn + ': (unparseable)'); continue; }
    const keys = Object.keys(s);
    keys.forEach(k => mybAll.add(k));
    const missing = keys.filter(k => !MYB_SUPPORTED.has(k));
    console.log('MYB ' + fn);
    console.log('  settings: ' + keys.join(', '));
    if (missing.length) console.log('  NOT SUPPORTED: ' + missing.join(', '));
  } else if (fn.endsWith('.kpp')) {
    const xml = parseKpp(buf);
    if (!xml) { console.log('KPP ' + fn + ': (no xml / zip)'); continue; }
    const params = [];
    const re = /<param[^>]*name="([^"]+)"[^>]*>/g;
    let m;
    while ((m = re.exec(xml))) params.push(m[1]);
    params.forEach(p => kppAll.add(p));
    // params that have a curve (pressure/random/fuzzy/speed etc.)
    const curveRe = /<param[^>]*name="([^"]+)"[^>]*>[\s\S]*?<params id="(pressure|random|fuzzy|speed1|speed2|stroke|direction|declination|ascension|custom)"/g;
    let cm;
    while ((cm = curveRe.exec(xml))) kppCurveParams.add(cm[1]);
    const interesting = params.filter(p =>
      /Value|Sensor|Curve|Texture|Masking|Composite|Flow|Eraser|Mirror|Precision|Auto/.test(p));
    console.log('KPP ' + fn);
    console.log('  params(' + params.length + '): ' + params.join(', '));
    console.log('  curves: ' + [...kppCurveParams].filter(p => params.includes(p)).join(', ') || '(none)');
    console.log('  interesting: ' + interesting.join(', ') || '(none)');
  }
}

console.log('\n=== UNION OF ALL MYB SETTINGS (' + mybAll.size + ') ===');
console.log([...mybAll].sort().join(', '));
console.log('\n=== UNION OF ALL KPP PARAMS (' + kppAll.size + ') ===');
console.log([...kppAll].sort().join(', '));
