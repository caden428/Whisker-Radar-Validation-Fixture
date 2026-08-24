'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { fileURLToPath } = require('url');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const rawDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-v8-coverage-'));
const testFiles = fs.readdirSync(path.join(root, 'test'))
  .filter((name) => name.endsWith('.test.js') && name !== 'renderer-startup.test.js')
  .sort();
try {
  for (const testFile of testFiles) {
    const result = spawnSync(process.execPath, [path.join(root, 'test', testFile)], {
      cwd: root, stdio: 'inherit', env: { ...process.env, NODE_V8_COVERAGE: rawDirectory },
    });
    if (result.status !== 0) process.exit(result.status || 1);
  }
  let covered = 0;
  let total = 0;
  const productionFiles = new Set();
  for (const reportName of fs.readdirSync(rawDirectory)) {
    const report = JSON.parse(fs.readFileSync(path.join(rawDirectory, reportName), 'utf8'));
    for (const script of report.result || []) {
      let scriptPath = String(script.url || '');
      if (scriptPath.startsWith('file:')) {
        try { scriptPath = fileURLToPath(scriptPath); } catch { continue; }
      }
      const normalized = scriptPath.replace(/\\/g, '/');
      const rootNormalized = root.replace(/\\/g, '/');
      if (!normalized.startsWith(rootNormalized) || normalized.includes('/test/') || normalized.includes('/tools/') || normalized.includes('/node_modules/')) continue;
      productionFiles.add(normalized);
      for (const fn of script.functions || []) {
        total += 1;
        if ((fn.ranges?.[0]?.count || 0) > 0) covered += 1;
      }
    }
  }
  const percent = total ? Number((covered * 100 / total).toFixed(1)) : 0;
  const summary = { generatedAt: new Date().toISOString(), metric: 'V8 function coverage', covered, total, percent, productionFiles: productionFiles.size, tests: testFiles.length };
  const outputDirectory = path.join(root, 'coverage');
  fs.mkdirSync(outputDirectory, { recursive: true });
  fs.writeFileSync(path.join(outputDirectory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`coverage: ${percent}% functions (${covered}/${total}) across ${productionFiles.size} files`);
  if (percent < 35) { console.error('coverage is below the 35% Phase 4 floor'); process.exit(1); }
} finally {
  fs.rmSync(rawDirectory, { recursive: true, force: true });
}
