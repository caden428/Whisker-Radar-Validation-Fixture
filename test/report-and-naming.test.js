const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const RunNamingCore = require('../run-naming-core');

const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

const verifiedRadar = {
  verifiedPair: true,
  sensors: {
    A: { gainCode: 0x43, threshold: 50 },
    B: { gainCode: 0x43, threshold: 50 },
  },
};
const exampleManifest = {
  testId: 'inside',
  dutId: 'Radar-A12',
  cyclesPlanned: 5,
  runSetup: { hardwareId: 'moresense-dual' },
  testPlan: { name: 'Inside Full Area' },
  radarSettings: { ...verifiedRadar, activeTarget: 'dual' },
};
assert.strictEqual(
  RunNamingCore.buildRunBase(exampleManifest, '2026-07-28T17:00:00.000Z'),
  'DUT-Radar-A12_MORESENSE-DUAL_10.1_PLAN-Inside-Full-Area_G0x43-T50_5cycles_2026-07-28_01-00PM'
);
assert.strictEqual(
  RunNamingCore.buildRunBase({ ...exampleManifest, cyclesPlanned: 1, dutId: 'Radar A12 / Rev 3' }, '2026-07-28T17:00:00.000Z'),
  'DUT-Radar-A12-Rev-3_MORESENSE-DUAL_10.1_PLAN-Inside-Full-Area_G0x43-T50_1cycle_2026-07-28_01-00PM'
);
assert.strictEqual(
  RunNamingCore.buildRunBase({ ...exampleManifest, testId: 'characterization', dutId: '' }, '2026-07-28T17:00:00.000Z'),
  'DUT-no-DUT_MORESENSE-DUAL_CHAR_PLAN-Inside-Full-Area_G0x43-T50_5cycles_2026-07-28_01-00PM'
);
assert.strictEqual(
  RunNamingCore.buildRunBase({
    ...exampleManifest,
    testId: 'custom',
    testPlan: { name: 'Engineering Sweep / Rev A' },
    activeSequence: 'Engineering Sweep / Rev A',
  }, '2026-07-28T17:00:00.000Z'),
  'DUT-Radar-A12_MORESENSE-DUAL_CUSTOM_PLAN-Engineering-Sweep-Rev-A_G0x43-T50_5cycles_2026-07-28_01-00PM'
);
assert.strictEqual(
  RunNamingCore.buildRunBase({
    ...exampleManifest, runSetup: { hardwareId: 'ld021-b' }, testPlan: { name: 'Full Range Raster' },
    radarSettings: { activeTarget: 'ld021_b', sensors: { LD021_B: { threshold: 512 } } },
  }, '2026-07-28T17:00:00.000Z'),
  'DUT-Radar-A12_HLK-LD021-B_10.1_PLAN-Full-Range-Raster_T512_5cycles_2026-07-28_01-00PM'
);
assert.strictEqual(
  RunNamingCore.buildRunBase({
    ...exampleManifest, runSetup: { hardwareId: 'rcwl-dual' },
    radarSettings: { activeTarget: 'rcwl_dual', sensors: { RCWL_A: {}, RCWL_B: {} } },
  }, '2026-07-28T17:00:00.000Z'),
  'DUT-Radar-A12_RCWL-DUAL_10.1_PLAN-Inside-Full-Area_FIXED_5cycles_2026-07-28_01-00PM'
);
const usedNames = new Set([
  'DUT-Radar-A12_MORESENSE-DUAL_10.1_PLAN-Inside-Full-Area_G0x43-T50_5cycles_2026-07-28_01-00PM',
  'DUT-Radar-A12_MORESENSE-DUAL_10.1_PLAN-Inside-Full-Area_G0x43-T50_5cycles_2026-07-28_01-00PM_2',
]);
assert.strictEqual(
  RunNamingCore.uniqueRunBase(
    'DUT-Radar-A12_MORESENSE-DUAL_10.1_PLAN-Inside-Full-Area_G0x43-T50_5cycles_2026-07-28_01-00PM',
    (candidate) => usedNames.has(candidate)
  ),
  'DUT-Radar-A12_MORESENSE-DUAL_10.1_PLAN-Inside-Full-Area_G0x43-T50_5cycles_2026-07-28_01-00PM_3'
);

// Build the real report and compile its embedded browser script. This catches
// template/JavaScript syntax errors without needing to launch a GUI.
const reportStart = source.indexOf('function escapeHtml');
const reportEnd = source.indexOf('/** Creates the run folder', reportStart);
const reportContext = {};
vm.createContext(reportContext);
vm.runInContext(source.slice(reportStart, reportEnd), reportContext);
const observations = [true, true, false].map((actualDetected, index) => ({
  timestamp: `2026-07-22T12:00:0${index}Z`, cycleNumber: index + 1, pointId: 'p-001',
  x: 100, y: 200, expectedDetected: null, actualDetected, outcome: 'UNASSESSED',
  detectionLatencyMs: actualDetected ? 200 + index * 10 : null, valid: true,
}));
const aggregates = [{ pointId: 'p-001', x: 100, y: 200, majority: 'TRIGGERED', triggerRate: 2 / 3,
  triggeredCount: 2, notTriggeredCount: 1, validCount: 3, invalidCount: 0, medianLatencyMs: 205,
  outcome: 'UNASSESSED', complete: true }];
const html = reportContext.buildReportHtml({
  testId: 'characterization', testName: 'Characterization', cyclesPlanned: 3, observations, aggregates,
  summary: { total: 3, counts: {}, correctRate: null },
  runFolderName: 'CHAR_3cycles_0x43.50_01-00PM_2026-07-28_DUT-Radar-A12',
});
assert.ok(!html.includes('Activation Probability Heatmap'));
assert.ok(html.includes('Radar Trigger Repeatability Across 3 Test Cycles'));
assert.ok(html.includes('Download high-resolution PNG'));
assert.ok(!html.includes('<canvas id="spatial"'));
assert.ok(!html.includes("['Sequence',R.activeSequence]"));
assert.ok(html.includes('const RAW='));
assert.ok(html.includes("folder+'_repeatability.png'"));
assert.ok(html.includes('DUT_CORNERS'));
assert.ok(html.includes("Number.isFinite(+G.centerY)?+G.centerY:+G.singleSensor?.centerY"));
assert.ok(!html.includes('stand-mounted sensor at (875, 1200)'));
assert.ok(html.includes('Width 262 mm'));
assert.ok(!html.includes('function drawSensors'));
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
assert.doesNotThrow(() => new Function(script));

const interferenceHtml = reportContext.buildReportHtml({
  testId: 'interference', testName: 'HLK-LD021 Interference Characterization', cyclesPlanned: 3,
  observations, aggregates, summary: { total: 3, counts: { INVALID: 0 }, correctRate: null },
  runFolderName: 'INTERFERENCE_3cycles',
});
assert.ok(interferenceHtml.includes('Characterization Only — No Acceptance Criteria Applied'));
assert.ok(interferenceHtml.includes("isCharacterization=['characterization','interference'].includes(R.testId)"));
assert.ok(interferenceHtml.includes("['Triggered',validRaw.filter(o=>o.actualDetected===true).length]"));
assert.ok(interferenceHtml.includes("if(isCharacterization){repeatability();if(R.testId==='interference')spatial()}"));
assert.ok(interferenceHtml.includes('const columns=isCharacterization?'));
const interferenceScript = interferenceHtml.match(/<script>([\s\S]*)<\/script>/)[1];
assert.doesNotThrow(() => new Function(interferenceScript));

console.log('report and naming tests passed');
