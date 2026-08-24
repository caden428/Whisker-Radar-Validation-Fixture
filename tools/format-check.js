'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const files = ['ipc-contracts.js', 'structured-logger.js', 'renderer-store.js', 'configuration-draft.js',
  'operator-flow-core.js', 'run-state-view.js', 'smoke-test-harness.js', 'campaign.css', 'package.json'];
const failures = [];
for (const relativePath of files) {
  const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
  if (!source.endsWith('\n')) failures.push(`${relativePath}: missing final newline`);
  if (/^(<{7}|={7}|>{7})/m.test(source)) failures.push(`${relativePath}: unresolved merge marker`);
  if (/[^\S\r\n]+$/m.test(source)) failures.push(`${relativePath}: trailing whitespace`);
}
JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
console.log(`format check passed (${files.length} architecture files checked)`);
