'use strict';
// Scans the brushes/ folder and writes brushes/manifest.json so the app can
// auto-load whatever .kpp files are present (a static site can't list a
// directory, so the manifest is the folder index). Re-run after adding or
// removing brushes:
//   node tools/update-brush-manifest.js
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'brushes');
const files = fs.readdirSync(dir)
  .filter(f => /\.(kpp|myb)$/i.test(f))
  .sort();
fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(files, null, 2) + '\n');
console.log('brushes/manifest.json updated with ' + files.length + ' brushes:');
files.forEach(f => console.log('  ' + f));
