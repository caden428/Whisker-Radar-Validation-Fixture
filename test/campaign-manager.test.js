'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const CampaignCore = require('../campaign-core');
const CampaignLedger = require('../campaign-ledger');
const CampaignManager = require('../campaign-manager');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-campaign-manager-'));
process.on('exit', () => fs.rmSync(temporary, { recursive: true, force: true }));

const campaign = CampaignManager.createCampaign({
  name: '10.1 Repeatability',
  dutId: 'Aqua 3C-DC',
  plan: {
    testId: 'inside',
    runsPerCondition: 3,
    cyclesPerRun: 3,
    pointCount: 100,
    autoRun: true,
    gains: ['0x43'],
    thresholds: [50],
    geometry: { guardBandMm: 10 },
  },
}, new Date('2026-07-28T17:00:00.000Z'));

assert.strictEqual(campaign.name, '10.1 Repeatability');
assert.strictEqual(campaign.status, 'active');
assert.strictEqual(campaign.plan.testId, 'inside');
assert.strictEqual(campaign.plan.runsPerCondition, 3);
assert.strictEqual(campaign.plan.autoRun, true);
assert.strictEqual(campaign.plan.geometry.centerX, undefined, 'dual campaigns must not store an individual sensor center');
assert.strictEqual(campaign.plan.geometry.sensorB, undefined, 'dual campaigns must not store a second sensor location');
assert.strictEqual(campaign.plan.geometry.singleSensor, undefined, 'dual campaigns must contain only DUT-level geometry');
assert.strictEqual(campaign.plan.geometry.schemaVersion, 3);
assert.deepStrictEqual(campaign.plan.geometry.dut.bounds, { minX: 744, maxX: 1006, minY: 880, maxY: 1200 }, 'campaigns must retain a complete DUT footprint for edge-distance geometry');
assert.ok(campaign.id.startsWith('10-1-repeatability-2026-07-28-'));

const initial = CampaignManager.status(temporary, campaign);
assert.strictEqual(initial.completed, 0);
assert.strictEqual(initial.total, 3);
assert.strictEqual(initial.next.gain, '0x43');
assert.strictEqual(initial.next.threshold, 50);
assert.strictEqual(initial.next.repeat, 1);

const scoped = CampaignLedger.ensureLedger(temporary, campaign.id);
const record = Object.fromEntries(CampaignCore.HISTORY_COLUMNS.map((column) => [column, '']));
Object.assign(record, {
  RecordId: 'record-1',
  CampaignKey: 'key-1',
  Status: 'FAIL',
  TestResult: 'FAIL',
  Gain: '0x43',
  Threshold: '50',
  ConditionId: initial.next.id,
});
fs.appendFileSync(scoped.history, CampaignLedger.csvLine(CampaignCore.HISTORY_COLUMNS.map((column) => record[column])), 'utf8');
const progressed = CampaignManager.status(temporary, campaign);
assert.strictEqual(progressed.completed, 1);
assert.strictEqual(progressed.failed, 1);
assert.strictEqual(progressed.next.repeat, 2);

const edited = CampaignManager.updateCampaign(campaign, {
  name: '10.1 Repeatability — Revised',
  dutId: 'Aqua Rev E',
  plan: { ...campaign.plan, runsPerCondition: 4 },
}, [initial.next.id], new Date('2026-07-29T01:02:03.000Z'));
assert.strictEqual(edited.id, campaign.id, 'editing must preserve the durable campaign identity');
assert.strictEqual(edited.createdAt, campaign.createdAt, 'editing must preserve the original creation time');
assert.strictEqual(edited.updatedAt, '2026-07-29T01:02:03.000Z');
assert.strictEqual(CampaignManager.methodFor(edited).conditions.length, 4);
assert.throws(
  () => CampaignManager.updateCampaign(campaign, {
    plan: { ...campaign.plan, runsPerCondition: 1, gains: ['0x53'] },
  }, [initial.next.id]),
  /recorded results cannot be removed/i
);
assert.throws(
  () => CampaignManager.updateCampaign(campaign, {
    plan: { ...campaign.plan, testId: 'outside' },
  }, [initial.next.id]),
  /test type cannot be changed/i
);

const matrix = CampaignManager.normalizePlan({
  testId: 'characterization',
  runsPerCondition: 2,
  cyclesPerRun: 4,
  pointCount: 25,
  gains: ['0x33', '0x53'],
  thresholds: [16, 50],
  bounds: { minX: 0, maxX: 100, minY: 10, maxY: 90 },
});
assert.strictEqual(CampaignManager.buildConditions(matrix).length, 8);
const zonedMatrix = CampaignManager.normalizePlan({
  ...matrix,
  runsPerCondition: 1,
  gains: ['0x43'],
  thresholds: [50],
  angularZones: ['right', 'front', 'left'],
});
const zonedConditions = CampaignManager.buildConditions(zonedMatrix);
assert.deepStrictEqual(zonedConditions.map((condition) => condition.angularZone), ['right', 'front', 'left']);
assert.deepStrictEqual(zonedConditions.map((condition) => condition.id), [
  'zright-g43-t50-r1', 'zfront-g43-t50-r1', 'zleft-g43-t50-r1',
]);
const guidedSystemPlan = CampaignManager.normalizePlan({
  ...matrix, testId: 'system', pointCount: 15, cyclesPerRun: 3, runsPerCondition: 1,
  gains: ['0x43'], thresholds: [50], angularZones: ['left', 'front', 'right'], geometry: { sensorLayout: 'dual' },
});
assert.deepStrictEqual(CampaignManager.buildConditions(guidedSystemPlan).map((condition) => condition.angularZone), ['left', 'front', 'right'], 'guided System Level campaigns must retain operator order');
assert.strictEqual(guidedSystemPlan.testId, 'system');
assert.strictEqual(guidedSystemPlan.pointCount, 15, 'each guided campaign section must contain 15 points');
assert.strictEqual(guidedSystemPlan.cyclesPerRun, 3);
assert.strictEqual(CampaignManager.buildConditions(guidedSystemPlan).length, 3, 'the guided campaign must contain exactly three ordered sections');
assert.deepStrictEqual(CampaignManager.normalizePlan({ ...matrix }).angularZones, ['all'], 'legacy campaigns must retain full-area behavior');
const namedMatrix = CampaignManager.normalizePlan({ ...matrix, runNames: { 'g33-t16-r1': 'Cold start' } });
assert.strictEqual(CampaignManager.buildConditions(namedMatrix)[0].name, 'Cold start');
assert.strictEqual(CampaignManager.buildConditions(namedMatrix)[1].name, '');

const other = CampaignLedger.pathsFor(temporary, 'another-campaign');
assert.notStrictEqual(scoped.directory, other.directory);
assert.ok(scoped.directory.includes(campaign.id));

assert.throws(() => CampaignManager.createCampaign({ name: '', dutId: 'A' }), /campaign name/i);
assert.throws(() => CampaignManager.createCampaign({ name: 'A', dutId: '' }), /DUT/i);
assert.throws(() => CampaignManager.normalizePlan({ gains: [], thresholds: [50] }), /gain/i);
assert.throws(() => CampaignManager.normalizePlan({ gains: ['0x43'], thresholds: [1] }), /threshold/i);
assert.throws(() => CampaignManager.normalizePlan({ gains: ['0x43'], thresholds: [50], angularZones: [] }), /angular zone/i);
assert.throws(() => CampaignManager.normalizePlan({ gains: ['0x43'], thresholds: [50], angularZones: ['rear'] }), /angular zones/i);

const hlkPlan = CampaignManager.normalizePlan({
  testId: 'characterization', radarTarget: 'ld021', gains: [], thresholds: [1, 512, 0xFFFFFF], runsPerCondition: 2,
  geometry: { sensorLayout: 'single', singleSensor: { centerX: 875, centerY: 987, radiusMm: 304.8 } },
});
assert.deepStrictEqual(hlkPlan.gains, []);
assert.strictEqual(hlkPlan.settingsProfile, 'ld021-threshold-only');
assert.strictEqual(hlkPlan.geometry.singleSensor.centerY, 987);
assert.deepStrictEqual(CampaignManager.buildConditions(hlkPlan).map((condition) => condition.id), [
  'ld021-t1-r1', 'ld021-t1-r2', 'ld021-t512-r1', 'ld021-t512-r2', 'ld021-t16777215-r1', 'ld021-t16777215-r2',
]);
assert.throws(() => CampaignManager.normalizePlan({ radarTarget: 'ld021', gains: [], thresholds: [0], geometry: { sensorLayout: 'single' } }), /Threshold/i);
assert.throws(() => CampaignManager.normalizePlan({ radarTarget: 'ld021', gains: [], thresholds: [0x1000000], geometry: { sensorLayout: 'single' } }), /Threshold/i);
const hilinkBPlan = CampaignManager.normalizePlan({ testId: 'characterization', radarTarget: 'ld021', hilinkSensor: 'B', gains: [], thresholds: [512], geometry: { sensorLayout: 'single' } });
assert.strictEqual(hilinkBPlan.hilinkSensor, 'B');
assert.ok(CampaignManager.buildConditions(hilinkBPlan).every((condition) => condition.hilinkSensor === 'B'));
const rcwlSinglePlan = CampaignManager.normalizePlan({
  testId: 'characterization', radarTarget: 'rcwl_single', gains: [], thresholds: [], runsPerCondition: 2,
  angularZones: ['front', 'left'], geometry: { sensorLayout: 'single' },
});
assert.strictEqual(rcwlSinglePlan.settingsProfile, 'fixed-digital-output');
assert.deepStrictEqual(rcwlSinglePlan.gains, []);
assert.deepStrictEqual(rcwlSinglePlan.thresholds, []);
assert.deepStrictEqual(CampaignManager.buildConditions(rcwlSinglePlan).map((condition) => condition.id), [
  'zfront-rcwl-single-r1', 'zfront-rcwl-single-r2', 'zleft-rcwl-single-r1', 'zleft-rcwl-single-r2',
]);
const rcwlDualPlan = CampaignManager.normalizePlan({
  testId: 'outside', radarTarget: 'rcwl_dual', gains: [], thresholds: [], runsPerCondition: 1,
  geometry: { sensorLayout: 'dual' },
});
assert.strictEqual(rcwlDualPlan.settingsProfile, 'fixed-digital-output');
assert.strictEqual(CampaignManager.buildConditions(rcwlDualPlan)[0].id, 'rcwl-dual-r1');
const rcwlPairPlan = CampaignManager.normalizePlan({
  testId: 'interference', radarTarget: 'rcwl_pair', gains: [], thresholds: [], runsPerCondition: 1,
  geometry: { sensorLayout: 'rcwl_pair', sensorA: { x: 775, y: 900, headingDeg: 0 }, sensorB: { x: 975, y: 900, headingDeg: 0 } },
});
assert.strictEqual(rcwlPairPlan.settingsProfile, 'fixed-digital-output');
assert.strictEqual(rcwlPairPlan.geometry.geometrySemantics, 'rcwl-pair-characterization');
assert.strictEqual(CampaignManager.buildConditions(rcwlPairPlan)[0].id, 'rcwl-pair-r1');
assert.throws(() => CampaignManager.normalizePlan({ radarTarget: 'rcwl_pair', geometry: { sensorLayout: 'dual' } }), /match/i);
assert.throws(() => CampaignManager.normalizePlan({ radarTarget: 'rcwl_dual', geometry: { sensorLayout: 'single' } }), /match/i);
assert.throws(() => CampaignManager.normalizePlan({ radarTarget: 'rcwl_single', geometry: { sensorLayout: 'dual' } }), /match/i);
assert.throws(() => CampaignManager.updateCampaign({ ...campaign, plan: { ...campaign.plan, radarTarget: 'single' } }, {
  plan: { ...campaign.plan, radarTarget: 'ld021', gains: [], geometry: { ...campaign.plan.geometry, sensorLayout: 'single' } },
}, [initial.next.id]), /Radar hardware cannot be changed/i);

console.log('campaign manager tests passed');
