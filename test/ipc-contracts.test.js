'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { validate } = require('../ipc-contracts');
const { StructuredLogger } = require('../structured-logger');

assert.deepStrictEqual(validate('moonraker:connect', { host: 'fixture.local', port: 7125 }).value,
  { host: 'fixture.local', port: 7125 });
assert.strictEqual(validate('moonraker:connect', { host: '', port: 70000 }).code, 'ERR_IPC_CONTRACT');
assert.strictEqual(validate('config:patch', { expectedRevision: 3, patch: { motion: {} } }).success, true);
assert.strictEqual(validate('config:patch', { expectedRevision: 0, patch: {} }).success, false);
assert.strictEqual(validate('test-plan:save', { plan: { id: 'plan-a', name: 'Plan A' } }).success, true);
assert.strictEqual(validate('test-plan:delete', { planId: 'plan-a' }).success, true);
assert.strictEqual(validate('run:transition', { phase: 'move', progress: {} }).success, true);
assert.strictEqual(validate('run:transition', { phase: 'invented' }).success, false);
assert.strictEqual(validate('radar-settings:apply', { threshold: 8, outputTimeMs: 500 }).success, true);
assert.strictEqual(validate('campaign:write', { name: 'Acceptance', dutId: 'DUT-01' }).success, true);
assert.strictEqual(validate('file:saveCSV', { data: 'a,b\n1,2', defaultName: '../escape.csv' }).success, false);

const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-logger-'));
try {
  const output = path.join(tempDirectory, 'diagnostics.jsonl');
  const logger = new StructuredLogger(output, () => ({ runId: 'run-42' }));
  logger.info('fixture.command_completed', { commandId: 'cmd-7', success: true });
  const record = JSON.parse(fs.readFileSync(output, 'utf8').trim());
  assert.strictEqual(record.runId, 'run-42');
  assert.strictEqual(record.commandId, 'cmd-7');
  assert.strictEqual(record.event, 'fixture.command_completed');
} finally {
  fs.rmSync(tempDirectory, { recursive: true, force: true });
}

console.log('ipc contracts and structured logger tests passed');
