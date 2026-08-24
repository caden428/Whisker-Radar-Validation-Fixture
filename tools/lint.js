'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const excluded = new Set(['node_modules', 'dist', '.git', 'vendor', 'coverage']);
function javascriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (excluded.has(entry.name)) return [];
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? javascriptFiles(fullPath) : (entry.name.endsWith('.js') ? [fullPath] : []);
  });
}

const failures = [];
for (const filePath of javascriptFiles(root)) {
  const source = fs.readFileSync(filePath, 'utf8');
  try { new vm.Script(source, { filename: filePath }); } catch (error) { failures.push(error.message); }
  if (/^(<{7}|={7}|>{7})/m.test(source)) failures.push(`${filePath}: unresolved merge marker`);
}
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
if (/nodeIntegration\s*:\s*true/.test(mainSource)) failures.push('main.js: nodeIntegration must remain disabled');
for (const filePath of javascriptFiles(root).filter((file) => path.basename(file) !== 'preload.js')) {
  if (/\brequire\(['"]electron['"]\)\.ipcRenderer/.test(fs.readFileSync(filePath, 'utf8'))) failures.push(`${filePath}: ipcRenderer is restricted to preload.js`);
}
if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
console.log(`lint passed (${javascriptFiles(root).length} JavaScript files checked)`);
