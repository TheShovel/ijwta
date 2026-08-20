#!/usr/bin/env node
// For each bundled .kpp, extract the meaningful option values: size/opacity/flow/
// spacing/rotation/scatter/softness values + their pressure curves + scatter axes.
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const dir = path.join(__dirname, '..', 'brushes');
const OPTS = ['Size', 'Opacity', 'Flow', 'Spacing', 'Rotation', 'Scatter', 'Softness', 'Sharpness'];

for (const fn of fs.readdirSync(dir).sort()) {
  if (!fn.endsWith('.kpp')) continue;
  const buf = fs.readFileSync(path.join(dir, fn));
  if (buf[0] !== 0x89) { continue; }
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
  if (!xml) continue;
  function param(name) {
    const m = xml.match(new RegExp('<param[^>]*name="' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"[^>]*>([\\s\\S]*?)<\\/param>'));
    return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : null;
  }
  function curve(name) {
    const s = param(name + 'Sensor');
    if (!s) return null;
    const m = s.match(/<curve>([^<]+)<\/curve>/);
    if (!m) return null;
    return m[1].split(';').map(p => p.split(',').map(Number)).filter(p => p.length === 2);
  }
  const parts = [];
  for (const op of OPTS) {
    const v = param(op + 'Value');
    const use = param(op + 'UseCurve');
    const c = curve(op);
    const press = param('Pressure' + op);
    if (c && c.length >= 2) parts.push(op + ' curve=' + JSON.stringify(c) + (press === 'true' ? ' [pressure]' : ''));
    else if (v && v !== '1' && v !== '1.000000') parts.push(op + '=' + v + (use === 'true' ? ' (useCurve)' : ''));
    else if (v && v !== '1' && v !== '1.000000') parts.push(op + '=' + v);
  }
  const scatterX = param('Scattering/AxisX'), scatterY = param('Scattering/AxisY');
  const scat = [];
  if (scatterX === 'true') scat.push('X');
  if (scatterY === 'true') scat.push('Y');
  if (scat.length) parts.push('scatterAxis=' + scat.join(''));
  console.log(fn + ':');
  console.log('  ' + (parts.join('  ') || '(defaults only)'));
}
