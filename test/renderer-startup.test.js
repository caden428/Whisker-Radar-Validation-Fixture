const { spawn } = require('child_process');
const path = require('path');
const electronPath = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

function runSmoke(attempt = 1) {
  const child = spawn(electronPath, ['.', '--smoke-test'], {
    cwd: path.join(__dirname, '..'), env, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const timer = setTimeout(() => child.kill(), 60000);

  child.on('close', (code) => {
    clearTimeout(timer);
    const line = output.split(/\r?\n/).find((entry) => entry.includes('RADAR_SMOKE_RESULT:'));
    // Electron occasionally exits before creating its first BrowserWindow on
    // Windows CI hosts. Retry one clean process, but never mask a reported app failure.
    if (!line && attempt < 3) return setTimeout(() => runSmoke(attempt + 1), 750);
    if (!line) {
      console.error(output.trim() || `renderer startup smoke test produced no result after ${attempt} attempts (last exit ${code})`);
      process.exit(1);
    }
    const result = JSON.parse(line.slice(line.indexOf('RADAR_SMOKE_RESULT:') + 'RADAR_SMOKE_RESULT:'.length));
    if (code !== 0 || !result.success) {
      console.error('renderer startup smoke test failed', JSON.stringify(result, null, 2));
      process.exit(1);
    }
    console.log('renderer startup smoke test passed', {
      radarPolls: result.radarPolls,
      radarLabel: result.radarLabel,
      defaults: result.defaults,
      editableFields: Object.fromEntries((result.fieldAudits || []).map((audit) => [audit.area, audit.tested])),
      attempts: attempt,
    });
  });
}

runSmoke();
