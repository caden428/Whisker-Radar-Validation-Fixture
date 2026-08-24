'use strict';

const assert = require('assert');
const CampaignCore = require('../campaign-core');

function reportFixture(overrides = {}) {
  const plannedPositions = [{ pointId: 'p1', x: 1, y: 2 }, { pointId: 'p2', x: 3, y: 4 }];
  const observations = [];
  [
    { pointId: 'p1', x: 1, y: 2, triggered: [true, true, true] },
    { pointId: 'p2', x: 3, y: 4, triggered: [true, true, false] },
  ].forEach((point) => point.triggered.forEach((actualDetected, index) => observations.push({
    runId: 'run-1', testId: 'characterization', pointId: point.pointId,
    x: point.x, y: point.y, cycleNumber: index + 1, actualDetected,
    detectionLatencyMs: actualDetected ? 100 + observations.length * 10 : null,
    valid: true,
  })));
  return {
    runId: 'run-1',
    testId: 'characterization',
    dutId: 'Aqua 3C-DC',
    cyclesPlanned: 3,
    plannedPositions,
    observations,
    aggregates: [
      { pointId: 'p1', x: 1, y: 2, validCount: 3, triggeredCount: 3 },
      { pointId: 'p2', x: 3, y: 4, validCount: 3, triggeredCount: 2 },
    ],
    geometry: { centerX: 10, centerY: 20 },
    radarSettings: {
      verifiedPair: true,
      sensors: {
        A: { gainCode: 0x53, threshold: 100 },
        B: { gainCode: 0x53, threshold: 100 },
      },
    },
    result: 'COMPLETE',
    reason: 'Characterization complete',
    ...overrides,
  };
}

const complete = CampaignCore.buildCampaignRecord({
  report: reportFixture(),
  completedAt: '2026-07-23T12:00:00Z',
  reportFolder: 'C:\\reports\\complete',
});
assert.strictEqual(complete.clean, true);
assert.strictEqual(complete.status, 'COMPLETE');
assert.strictEqual(complete.gain, '0x53');
assert.strictEqual(complete.threshold, 100);
assert.strictEqual(complete.validPoints, 2);
assert.strictEqual(complete.threeOfThree, 1);
assert.strictEqual(complete.twoOfThree, 1);
assert.strictEqual(complete.oneOfThree, 0);
assert.strictEqual(complete.zeroOfThree, 0);
assert.strictEqual(complete.fullTriggerPoints, 1);
assert.strictEqual(complete.partialTriggerPoints, 1);
assert.strictEqual(complete.zeroTriggerPoints, 0);
assert.strictEqual(complete.averageTriggerRate, 5 / 6);
assert.strictEqual(complete.invalidObservations, 0);
assert.strictEqual(complete.medianLatencyMs, 120);
assert.strictEqual(complete.p95LatencyMs, 140);
assert.strictEqual(complete.graphData.length, 2);
assert.deepStrictEqual(
  { x: complete.graphData[0].x, y: complete.graphData[0].y, triggeredCount: complete.graphData[0].triggeredCount },
  { x: 1, y: 2, triggeredCount: 3 },
);

const invalidReport = reportFixture();
invalidReport.observations[0].valid = false;
invalidReport.aggregates[0].validCount = 2;
invalidReport.aggregates[0].triggeredCount = 2;
const failed = CampaignCore.buildCampaignRecord({
  report: invalidReport,
  completedAt: '2026-07-23T12:01:00Z',
  reportFolder: 'C:\\reports\\failed',
});
assert.strictEqual(failed.clean, false);
assert.strictEqual(failed.status, 'INCOMPLETE');
assert.strictEqual(failed.validPoints, 1);
assert.strictEqual(failed.invalidObservations, 1);
assert.strictEqual(failed.campaignKey, complete.campaignKey);

const resolvedRetryReport = reportFixture();
resolvedRetryReport.observations[0] = { ...resolvedRetryReport.observations[0], valid: false, actualDetected: null, attemptNumber: 1 };
resolvedRetryReport.observations.push({
  ...resolvedRetryReport.observations[0], valid: true, actualDetected: true,
  detectionLatencyMs: 100, attemptNumber: 2, invalidReason: '',
});
const resolvedRetry = CampaignCore.buildCampaignRecord({
  report: resolvedRetryReport,
  completedAt: '2026-07-23T12:02:00Z', reportFolder: 'C:\\reports\\resolved-retry',
});
assert.strictEqual(resolvedRetry.clean, true, 'a valid retry must satisfy campaign completion');
assert.strictEqual(resolvedRetry.invalidObservations, 0);
assert.strictEqual(resolvedRetry.rawInvalidObservations, 1, 'the original invalid acquisition remains auditable');

const mismatch = reportFixture();
mismatch.radarSettings.sensors.B.threshold = 200;
assert.strictEqual(CampaignCore.buildCampaignRecord({
  report: mismatch, reportFolder: 'C:\\reports\\mismatch',
}).settingsVerified, false);

assert.strictEqual(CampaignCore.percentile([1, 2, 3, 4, 5], 0.95), 5);
assert.strictEqual(CampaignCore.median([1, 2, 3, 4]), 2.5);
assert.strictEqual(CampaignCore.recordToRow(complete).length, CampaignCore.HISTORY_COLUMNS.length);
assert.strictEqual(CampaignCore.SCHEMA_VERSION, 3);

const hlk = CampaignCore.buildCampaignRecord({
  report: reportFixture({
    activeTarget: 'ld021',
    radarSettings: { activeTarget: 'ld021', verifiedPair: true, sensors: { LD021: { online: true, verified: true, threshold: 512 } } },
  }), reportFolder: 'C:\\reports\\hlk',
});
assert.strictEqual(hlk.status, 'COMPLETE');
assert.strictEqual(hlk.radarTarget, 'ld021');
assert.strictEqual(hlk.settingsProfile, 'ld021-threshold-only');
assert.strictEqual(hlk.gain, '');
assert.strictEqual(hlk.threshold, 512);

const hlkB = CampaignCore.buildCampaignRecord({
  report: reportFixture({
    activeTarget: 'ld021_b',
    radarSettings: { activeTarget: 'ld021_b', verifiedPair: true, sensors: { LD021_B: { online: true, verified: true, threshold: 700 } } },
  }), reportFolder: 'C:\\reports\\hlk-b',
});
assert.strictEqual(hlkB.status, 'COMPLETE');
assert.strictEqual(hlkB.radarTarget, 'ld021_b');
assert.strictEqual(hlkB.threshold, 700);

const rcwl = CampaignCore.buildCampaignRecord({
  report: reportFixture({
    activeTarget: 'rcwl_dual',
    radarSettings: { activeTarget: 'rcwl_dual', verifiedPair: true, protocolProfile: 'fixed-digital-output',
      sensors: { RCWL_A: { online: true, verified: true }, RCWL_B: { online: true, verified: true } } },
  }), reportFolder: 'C:\\reports\\rcwl',
});
assert.strictEqual(rcwl.status, 'COMPLETE');
assert.strictEqual(rcwl.radarTarget, 'rcwl_dual');
assert.strictEqual(rcwl.settingsProfile, 'fixed-digital-output');
assert.strictEqual(rcwl.gain, '');
assert.strictEqual(rcwl.threshold, '');

const formalFail = CampaignCore.buildCampaignRecord({
  report: reportFixture({
    testId: 'inside',
    result: 'FAIL',
    campaignConditionId: 'g43-t50-r2',
    campaignRunNumber: 2,
    campaignRepeatNumber: 2,
  }),
  reportFolder: 'C:\\reports\\formal-fail',
});
assert.strictEqual(formalFail.status, 'FAIL', 'a completed formal failure must still advance the campaign');
assert.strictEqual(formalFail.clean, false);
assert.strictEqual(formalFail.conditionId, 'g43-t50-r2');

console.log('campaign core tests passed');
