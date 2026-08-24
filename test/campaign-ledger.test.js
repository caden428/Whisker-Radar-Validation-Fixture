'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const CampaignLedger = require('../campaign-ledger');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-campaign-test-'));
try {
  const baseReport = {
    runId: 'run-ledger',
    testId: 'characterization',
    dutId: 'Aqua 3C-DC',
    cyclesPlanned: 3,
    plannedPositions: [{ pointId: 'p1', x: 1, y: 2 }],
    observations: [1, 2, 3].map((cycleNumber) => ({
      runId: 'run-ledger', testId: 'characterization', pointId: 'p1',
      x: 1, y: 2, cycleNumber, actualDetected: true,
      detectionLatencyMs: 100 + cycleNumber, valid: true,
    })),
    aggregates: [{ pointId: 'p1', x: 1, y: 2, validCount: 3, triggeredCount: 3 }],
    geometry: { centerX: 0, centerY: 0 },
    radarSettings: {
      verifiedPair: true,
      sensors: { A: { gainCode: 0x53, threshold: 100 }, B: { gainCode: 0x53, threshold: 100 } },
    },
  };
  const first = CampaignLedger.recordCampaign(temporary, {
    report: baseReport, completedAt: '2026-07-23T12:00:00Z', reportFolder: 'C:\\run-1',
  });
  assert.strictEqual(first.record.clean, true);
  assert.strictEqual(first.record.retryNumber, 0);
  assert.strictEqual(first.duplicate, false);

  const duplicate = CampaignLedger.recordCampaign(temporary, {
    report: baseReport, completedAt: '2026-07-23T12:00:00Z', reportFolder: 'C:\\run-1',
  });
  assert.strictEqual(duplicate.duplicate, true);

  const retry = CampaignLedger.recordCampaign(temporary, {
    report: { ...baseReport, runId: 'run-ledger-2' },
    completedAt: '2026-07-23T13:00:00Z', reportFolder: 'C:\\run-2',
  });
  assert.strictEqual(retry.record.retryNumber, 1);

  const status = CampaignLedger.getStatus(temporary);
  assert.ok(status.paths.history.endsWith('history.csv'));
  assert.ok(status.paths.current.endsWith('current.csv'));
  assert.strictEqual(status.pending, undefined, 'local ledger must not expose a remote sync queue');
  const history = fs.readFileSync(status.paths.history, 'utf8');
  const current = fs.readFileSync(status.paths.current, 'utf8');
  assert.strictEqual(CampaignLedger.parseCsv(history).length, 3);
  assert.strictEqual(CampaignLedger.parseCsv(current).length, 2);

  console.log('campaign ledger tests passed');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
