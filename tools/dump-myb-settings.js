#!/usr/bin/env node
// Dump the raw JSON structure of a few key mypaint settings.
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'brushes');

function load(name) {
  const j = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
  return j.settings;
}

const s = load('e)_Marker_Medium_(mypaint).myb');
for (const k of ['opaque', 'opaque_multiply', 'radius_logarithmic', 'hardness', 'offset_by_random', 'radius_by_random', 'elliptical_dab_ratio', 'elliptical_dab_angle', 'dabs_per_second', 'smudge', 'smudge_length', 'speed1_gamma', 'speed1_slowness']) {
  console.log('### ' + k);
  console.log(JSON.stringify(s[k], null, 1));
}

const p = load('c)_Pencil_2b_(mypaint).myb');
console.log('### pencil2b radius_logarithmic');
console.log(JSON.stringify(p.radius_logarithmic, null, 1));
console.log('### pencil2b opaque_multiply');
console.log(JSON.stringify(p.opaque_multiply, null, 1));
