#!/usr/bin/env node
// Dump the XML structure of the Size/Opacity pressure curve params from a .kpp.
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const buf = fs.readFileSync(path.join(__dirname, '..', 'brushes', 'j)_WaterC_Basic_Round-Grain.kpp'));
function r32(o) { return (buf[o] << 24) | (buf[o + 1] << 16) | (buf[o + 2] << 8) | buf[o + 3]; }
let o = 8, xml = null;
while (o + 8 <= buf.length) {
  const len = r32(o);
  const t = buf.slice(o + 4, o + 8).toString();
  if (t === 'zTXt') {
    let i = 0;
    while (buf[o + 8 + i] !== 0) i++;
    try { xml = zlib.inflateSync(buf.slice(o + 8 + i + 2, o + 8 + len)).toString(); } catch (e) {}
  }
  if (t === 'IEND') break;
  o += 12 + len;
}
// Show the SizeOption + SizeUseCurve + SizeSensor params and their curve points
for (const name of ['SizeValue', 'SizeUseCurve', 'SizeSensor', 'OpacityValue', 'OpacityUseCurve', 'FlowValue', 'ScatterValue', 'Scattering/AxisX', 'Scattering/AxisY']) {
  const m = xml.match(new RegExp('<param[^>]*name="' + name + '"[^>]*>([\\s\\S]*?)<\\/param>'));
  if (m) console.log('### ' + name + '\n' + m[1].trim().slice(0, 500) + '\n');
}
// The PressureSize curve structure (a <param name="PressureSize"> containing <params id="pressure"> with points)
const pm = xml.match(/<param[^>]*name="PressureSize"[^>]*>([\s\S]*?)<\/param>/);
if (pm) console.log('### PressureSize\n' + pm[1].trim().slice(0, 800) + '\n');
