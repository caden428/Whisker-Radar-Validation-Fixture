'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const evidenceDirectory = path.join(root, 'dist', 'release-gates');
function writeEvidence(name, details) {
  fs.mkdirSync(evidenceDirectory, { recursive: true });
  const output = path.join(evidenceDirectory, `${name}.json`);
  fs.writeFileSync(output, `${JSON.stringify({ gate: name, passedAt: new Date().toISOString(), ...details }, null, 2)}\n`);
  console.log(`${name} release gate passed; evidence: ${output}`);
}

const mode = process.argv[2];
if (mode === 'record-simulated') {
  writeEvidence('simulated', { checks: ['lint', 'format:check', 'test:unit', 'coverage'], electronIntegration: 'required in CI' });
} else if (mode === 'physical') {
  const simulatedEvidence = path.join(evidenceDirectory, 'simulated.json');
  if (!fs.existsSync(simulatedEvidence)) throw new Error('Run npm run release:simulated before the physical gate');
  const acceptancePath = process.env.RADAR_PHYSICAL_ACCEPTANCE_FILE;
  if (!acceptancePath || !fs.existsSync(acceptancePath)) throw new Error('RADAR_PHYSICAL_ACCEPTANCE_FILE must name an existing acceptance JSON file');
  const acceptance = JSON.parse(fs.readFileSync(acceptancePath, 'utf8'));
  for (const field of ['fixtureId', 'softwareVersion', 'approvedBy', 'approvedAt']) {
    if (typeof acceptance[field] !== 'string' || !acceptance[field].trim()) throw new Error(`Physical acceptance field ${field} is required`);
  }
  for (const check of ['emergencyStopVerified', 'travelLimitsVerified', 'radarReadbackVerified', 'artifactSetVerified']) {
    if (acceptance[check] !== true) throw new Error(`Physical acceptance check ${check} must be true`);
  }
  writeEvidence('physical', { acceptanceFile: path.resolve(acceptancePath), fixtureId: acceptance.fixtureId, approvedBy: acceptance.approvedBy });
} else {
  console.error('Usage: node tools/release-gate.js record-simulated|physical');
  process.exit(2);
}
