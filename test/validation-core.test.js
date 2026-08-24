'use strict';
const assert = require('assert');
const core = require('../validation-core');
const DutLocationCore = require('../dut-location-core');

// Shared geometry keeps classification and generation checks comparable.
const geometry = { centerX: 0, centerY: 0, radiusMm: 304.8, guardBandMm: 10 };

// Outcome truth table and geometric zone classification.
assert.strictEqual(core.classify(true, true), 'TP');
assert.strictEqual(core.classify(false, false), 'TN');
assert.strictEqual(core.classify(false, true), 'FP');
assert.strictEqual(core.classify(true, false), 'FN');
assert.strictEqual(core.classify(true, true, false), 'INVALID');
assert.strictEqual(core.classifyZone(300, geometry), 'guard-band');
assert.strictEqual(core.classifyZone(280, geometry), 'inside');
assert.strictEqual(core.classifyZone(320, geometry), 'outside');
assert.strictEqual(core.classifyZone({ x: 0, y: -280 }, geometry), 'inside');
assert.strictEqual(core.classifyZone({ x: 0, y: -300 }, geometry), 'inside', 'the Test 10.2 guard must not remove valid activation-zone area');
assert.strictEqual(core.classifyZone({ x: 0, y: -320 }, geometry), 'outside');
assert.strictEqual(core.classifyZone({ x: 160, y: -170 }, geometry), 'outside', 'manual lobe must be narrower than a semicircle');
assert.strictEqual(core.classifyZone({ x: 0, y: 5 }, geometry), 'guard-band', 'the linear guard must cap the boundary at the sensor origin');
assert.strictEqual(core.classifyZone({ x: 0, y: 11 }, geometry), 'outside', 'points beyond the linear guard must remain eligible');

// Observation normalization must not invent latency for a missed detection.
const miss = core.createObservation({ testId: 'inside', x: 0, y: 0, actualDetected: false, detectionLatencyMs: 9999, geometry });
assert.strictEqual(miss.outcome, 'FN');
assert.strictEqual(miss.detectionLatencyMs, null, 'misses must not receive artificial latency');

// Acceptance depends on correct rate, cycle completion, and invalid results.
const observations = [];
for (let cycle = 1; cycle <= 3; cycle++) {
  for (let i = 0; i < 100; i++) observations.push(core.createObservation({ testId: 'inside', cycleNumber: cycle, x: i, y: 0, actualDetected: i < 95, geometry }));
}
let summary = core.summarize(observations, core.TEST_DEFINITIONS.inside);
assert.strictEqual(summary.correctRate, 0.95);
assert.strictEqual(summary.accepted, true);
const stricterDefinition = { ...core.TEST_DEFINITIONS.inside, acceptance: { ...core.TEST_DEFINITIONS.inside.acceptance, minimumCorrectRate: 0.96 } };
assert.strictEqual(core.summarize(observations, stricterDefinition).accepted, false, 'configured pass threshold must control acceptance');

const incomplete = core.summarize(observations.filter((o) => o.cycleNumber === 1), core.TEST_DEFINITIONS.inside);
assert.strictEqual(incomplete.cyclesComplete, false);
assert.strictEqual(incomplete.accepted, false);

observations[0] = core.createObservation({ testId: 'inside', cycleNumber: 1, x: 0, y: 0, actualDetected: false, geometry });
summary = core.summarize(observations, core.TEST_DEFINITIONS.inside);
assert.strictEqual(summary.accepted, false);

// A valid retry replaces an invalid acquisition for acceptance, while the raw
// observation remains present for audit/reporting.
const retryInitial = core.createObservation({ testId: 'inside', cycleNumber: 1, pointId: 'retry-point', x: 0, y: 0, valid: false, invalidReason: 'GPIO unstable', geometry });
const retryResolved = core.createObservation({ testId: 'inside', cycleNumber: 1, pointId: 'retry-point', x: 0, y: 0, actualDetected: true, attemptNumber: 2, geometry });
const retrySummary = core.summarize([retryInitial, retryResolved], core.TEST_DEFINITIONS.inside);
assert.strictEqual(retrySummary.total, 2);
assert.strictEqual(retrySummary.effectiveTotal, 1);
assert.strictEqual(retrySummary.counts.INVALID, 0, 'a valid retry must resolve the invalid acquisition');
assert.strictEqual(core.effectiveObservations([retryInitial, retryResolved])[0].attemptNumber, 2);

// Test 10.1 generation must fill the full lobe, include boundary coverage, and
// retain locally efficient traversal with reasonably uniform spacing.
const generatedInside = core.generateRadialPoints({ count: 100, zone: 'inside', geometry, bounds: { minX: -400, maxX: 400, minY: -400, maxY: 400 } });
assert.strictEqual(generatedInside.length, 100);
assert.ok(generatedInside.every((p) => core.classifyZoneForTest('inside', p, geometry) === 'inside'));
assert.ok(generatedInside.every((p) => core.pointInManualLobe(p, geometry, geometry.radiusMm)));
assert.ok(generatedInside.some((p) => !core.pointInManualLobe(p, geometry, geometry.radiusMm-geometry.guardBandMm)), 'inside plan must cover the former guard-band region');
assert.ok(generatedInside.every((p) => p.y <= geometry.centerY), 'inside points must stay forward of the radar');
assert.ok(generatedInside.some((p) => geometry.centerY-p.y < 80), 'inside plan must cover the near-radar region');
assert.ok(Math.max(...generatedInside.map((p) => geometry.centerY-p.y)) > 250, 'inside plan must cover the tapered far end');
assert.ok(generatedInside.some((p) => p.x < geometry.centerX) && generatedInside.some((p) => p.x > geometry.centerX), 'inside plan must cover both sides');
const insideSteps = generatedInside.slice(1).map((point, index) => Math.hypot(point.x-generatedInside[index].x, point.y-generatedInside[index].y));
assert.ok(Math.max(...insideSteps) < geometry.radiusMm / 2, 'inside traversal must not crisscross the lobe');
const insideNeighbors = generatedInside.map((point, index) => Math.min(...generatedInside.map((other, otherIndex) => index === otherIndex ? Infinity : Math.hypot(point.x-other.x, point.y-other.y))));
const insideNeighborMean = insideNeighbors.reduce((sum, value) => sum+value, 0)/insideNeighbors.length;
const insideNeighborCv = Math.sqrt(insideNeighbors.reduce((sum, value) => sum+Math.pow(value-insideNeighborMean,2),0)/insideNeighbors.length)/insideNeighborMean;
assert.ok(insideNeighborCv < 0.15, `inside neighbor spacing variation is too high: ${insideNeighborCv}`);
// Test 10.2 generation must stay beyond the guarded lobe and cover its outer band.
const generatedOutside = core.generateRadialPoints({ count: 100, zone: 'outside', geometry, outerRadiusMm: 450, bounds: { minX: -500, maxX: 500, minY: -500, maxY: 500 } });
assert.strictEqual(generatedOutside.length, 100);
assert.ok(generatedOutside.every((p) => core.classifyZone(p, geometry) === 'outside'));
assert.ok(generatedOutside.every((p) => core.pointInManualLobe(p, geometry, 450)));
assert.ok(generatedOutside.every((p) => core.distanceToActivationZoneBoundary(p, geometry) > geometry.guardBandMm), 'outside points must stay a linear guard distance from the activation boundary');
assert.ok(generatedOutside.every((p) => p.y <= geometry.centerY), 'outside points must stay in the forward manual-lobe band');
assert.ok(Math.max(...generatedOutside.map((p) => geometry.centerY-p.y)) > 390, 'outside plan must cover the outer lobe extent');
const outsideSteps = generatedOutside.slice(1).map((point, index) => Math.hypot(point.x-generatedOutside[index].x, point.y-generatedOutside[index].y));
assert.ok(Math.max(...outsideSteps) < geometry.radiusMm, 'outside traversal must follow the lobe band instead of making fixture-wide jumps');
const outsideNeighbors = generatedOutside.map((point, index) => Math.min(...generatedOutside.map((other, otherIndex) => index === otherIndex ? Infinity : Math.hypot(point.x-other.x, point.y-other.y))));
const outsideNeighborMean = outsideNeighbors.reduce((sum, value) => sum+value, 0)/outsideNeighbors.length;
const outsideNeighborCv = Math.sqrt(outsideNeighbors.reduce((sum, value) => sum+Math.pow(value-outsideNeighborMean,2),0)/outsideNeighbors.length)/outsideNeighborMean;
assert.ok(outsideNeighborCv < 0.20, `outside lobe-band neighbor spacing variation is too high: ${outsideNeighborCv}`);

assert.strictEqual(core.generateRadialPoints({ count: 37, zone: 'inside', geometry, bounds: { minX: -400, maxX: 400, minY: -400, maxY: 400 } }).length, 37);
assert.strictEqual(core.generateRadialPoints({ count: 128, zone: 'outside', geometry, outerRadiusMm: 450, bounds: { minX: -500, maxX: 500, minY: -500, maxY: 500 } }).length, 128);
assert.deepStrictEqual(core.validatePlan('inside', generatedInside, geometry), []);
assert.deepStrictEqual(core.validatePlan('outside', generatedOutside, geometry), []);
assert.deepStrictEqual(core.validatePlan('inside', [{ x: 0, y: -300 }], geometry), [], 'Test 10.1 must accept points near the 12-inch boundary');
assert.strictEqual(core.validatePlan('inside', [{ x: 304.8, y: 0 }], geometry)[0].code, 'WRONG_ZONE');
assert.ok(core.validatePlan('inside', [{ x: 0, y: 100 }], geometry).some((issue) => issue.code === 'WRONG_HEMISPHERE'));
assert.strictEqual(core.generateRadialPoints({ count: 10, zone: 'inside', geometry: { ...geometry, guardBandMm: 400 } }).length, 10, 'Test 10.1 generation must ignore the Test 10.2 guard band');

// Optional angular zones use straight ahead (-Y) as 0 degrees and fixture-right as positive.
assert.strictEqual(core.forwardAngleDeg({ x: geometry.centerX, y: geometry.centerY-100 }, geometry), 0);
assert.strictEqual(core.forwardAngleDeg({ x: geometry.centerX+100, y: geometry.centerY-100 }, geometry), 45);
assert.strictEqual(core.forwardAngleDeg({ x: geometry.centerX-100, y: geometry.centerY-100 }, geometry), -45);
assert.ok(core.pointInAngularZone({ x: geometry.centerX, y: geometry.centerY-100 }, geometry, true, 'front'));
assert.ok(core.pointInAngularZone({ x: geometry.centerX+100, y: geometry.centerY-20 }, geometry, true, 'right'));
assert.ok(core.pointInAngularZone({ x: geometry.centerX-100, y: geometry.centerY-20 }, geometry, true, 'left'));
assert.ok(!core.pointInAngularZone({ x: geometry.centerX-100, y: geometry.centerY-20 }, geometry, true, 'right'));
['front', 'right', 'left'].forEach((angularZone) => {
  const points = core.generateRadialPoints({ count: 24, zone: 'inside', geometry, angularZoneEnabled: true, angularZone });
  assert.strictEqual(points.length, 24, `${angularZone} zone must preserve the requested point count`);
  assert.ok(points.every((point) => core.pointInAngularZone(point, geometry, true, angularZone)), `${angularZone} plan must remain inside its selected angular zone`);
});

const dualGeometry = {
  schemaVersion: 3,
  sensorLayout: 'dual',
  systemReference: { x: 875, y: 1040, confirmed: true },
  dut: { bounds: { minX: 744, maxX: 1006, minY: 880, maxY: 1200 } },
};
const dualSystemGeometry = dualGeometry;
const customSystemGeometry = { ...dualSystemGeometry, requiredTriggerMm: 355.6, requiredNoTriggerMm: 711.2 };
assert.strictEqual(core.classifySystemDistance({ x: 875, y: 524.4 }, customSystemGeometry), 'required-trigger', 'custom green barrier must drive system classification');
assert.strictEqual(core.classifySystemDistance({ x: 875, y: 500 }, customSystemGeometry), 'optional', 'custom grey barrier must begin after green');
assert.strictEqual(core.classifySystemDistance({ x: 875, y: 168.7 }, customSystemGeometry), 'required-no-trigger', 'custom red barrier must drive system classification');
assert.strictEqual(core.geometrySemantics(dualGeometry), core.GEOMETRY_SEMANTICS.DUAL_SYSTEM_BANDS, 'dual geometry must always use DUT-level system bands');
assert.strictEqual(core.activationSensors(dualGeometry).length, 1, 'individual dual-channel sensor lobes must not exist');
assert.strictEqual(core.activationZoneBoundaries(dualSystemGeometry).length, 1, 'dual system acceptance geometry must never render two sensor lobes');
assert.strictEqual(core.systemBandBoundaries(dualSystemGeometry).length, 2);
const [requiredBoundary, noDetectBoundary] = core.systemBandBoundaries(dualSystemGeometry);
const extents = (points) => ({
  minX: Number(Math.min(...points.map((point) => point.x)).toFixed(3)), maxX: Number(Math.max(...points.map((point) => point.x)).toFixed(3)),
  minY: Number(Math.min(...points.map((point) => point.y)).toFixed(3)), maxY: Number(Math.max(...points.map((point) => point.y)).toFixed(3)),
});
assert.deepStrictEqual(extents(requiredBoundary), { minX: 439.2, maxX: 1310.8, minY: 575.2, maxY: 1504.8 }, '12-inch boundary must offset every DUT edge by 304.8 mm');
assert.deepStrictEqual(extents(noDetectBoundary), { minX: 134.4, maxX: 1615.6, minY: 270.4, maxY: 1809.6 }, '24-inch boundary must offset every DUT edge by 609.6 mm');
assert.strictEqual(core.classifySystemDistance({ x: 875, y: 575.2 }, dualSystemGeometry), 'required-trigger');
assert.strictEqual(core.classifySystemDistance({ x: 875, y: 575.199 }, dualSystemGeometry), 'optional');
assert.strictEqual(core.classifySystemDistance({ x: 875, y: 270.4 }, dualSystemGeometry), 'optional');
assert.strictEqual(core.classifySystemDistance({ x: 875, y: 270.399 }, dualSystemGeometry), 'required-no-trigger');
assert.strictEqual(core.classifySystemDistance({ x: 600, y: 700 }, dualSystemGeometry), 'required-trigger', 'corner distance must use the nearest DUT corner');
assert.strictEqual(core.expectedFor('inside', { x: 875, y: 575.2 }, dualSystemGeometry), true);
assert.strictEqual(core.expectedFor('inside', { x: 875, y: 500 }, dualSystemGeometry), null);
assert.strictEqual(core.expectedFor('outside', { x: 875, y: 200 }, dualSystemGeometry), false);
assert.strictEqual(core.expectedFor('custom', { x: 875, y: 575.2 }, dualSystemGeometry), true, 'System Level Custom plans must derive Detect inside the green boundary');
assert.strictEqual(core.expectedFor('custom', { x: 875, y: 500 }, dualSystemGeometry), null, 'System Level Custom plans must leave the grey boundary ungraded');
assert.strictEqual(core.expectedFor('custom', { x: 875, y: 200 }, dualSystemGeometry), false, 'System Level Custom plans must derive No Detect beyond the red boundary');
assert.deepStrictEqual(core.validatePlan('custom', [
  { x: 875, y: 575.2 }, { x: 875, y: 500 }, { x: 875, y: 200 },
], dualSystemGeometry), [], 'System Level Custom plans must not require manual expectedDetected values');
const optionalObservations = [
  core.createObservation({ testId: 'inside', cycleNumber: 1, x: 875, y: 575.2, actualDetected: true, geometry: dualSystemGeometry }),
  core.createObservation({ testId: 'inside', cycleNumber: 1, x: 875, y: 500, actualDetected: false, geometry: dualSystemGeometry }),
  core.createObservation({ testId: 'inside', cycleNumber: 1, x: 875, y: 400, actualDetected: true, geometry: dualSystemGeometry }),
];
const optionalSummary = core.summarize(optionalObservations, { acceptance: { minimumCorrectRate: 1, cyclesRequired: 1 } });
assert.strictEqual(optionalSummary.assessed, 1);
assert.strictEqual(optionalSummary.correctRate, 1, 'optional-band detections and misses must never affect pass rate');
assert.strictEqual(optionalSummary.counts.UNASSESSED, 2);
const systemInsidePoints = core.generateRadialPoints({
  count: 40, zone: 'inside', geometry: dualSystemGeometry,
  bounds: { minX: 0, maxX: 1725, minY: 0, maxY: 1100 },
});
assert.strictEqual(systemInsidePoints.length, 40);
assert.ok(systemInsidePoints.every((point) => core.classifySystemDistance(point, dualSystemGeometry) === 'required-trigger'));
const systemOutsidePoints = core.generateRadialPoints({
  count: 40, zone: 'outside', geometry: dualSystemGeometry, outerRadiusMm: 762,
  bounds: { minX: 0, maxX: 1725, minY: 0, maxY: 1100 },
});
assert.strictEqual(systemOutsidePoints.length, 40);
assert.ok(systemOutsidePoints.every((point) => core.systemDistanceMm(point, dualSystemGeometry) > 609.6));
['left', 'front', 'right'].forEach((angularZone) => {
  const combined = core.generateSystemValidationPoints({
    count: 15, geometry: dualSystemGeometry, angularZone, angularZoneEnabled: true, outerRadiusMm: 762,
    bounds: { minX: 0, maxX: 1725, minY: 0, maxY: 1040 },
  });
  assert.strictEqual(combined.length, 15, `${angularZone} System Level section must preserve its requested count`);
  assert.deepStrictEqual(
    new Set(combined.map((point) => point.zone)),
    new Set(['required-trigger', 'optional', 'required-no-trigger']),
    `${angularZone} section must contain green, grey, and red points`,
  );
  assert.ok(combined.every((point) => core.pointInAngularZone(point, dualSystemGeometry, true, angularZone)));
  assert.deepStrictEqual(core.validatePlan('system', combined, dualSystemGeometry), []);
});
assert.deepStrictEqual(
  new Set([
    core.systemCoveragePartition({ x: 500, y: 1040 }, dualSystemGeometry),
    core.systemCoveragePartition({ x: 875, y: 700 }, dualSystemGeometry),
    core.systemCoveragePartition({ x: 1250, y: 1040 }, dualSystemGeometry),
  ]),
  new Set(['Left', 'Front', 'Right']),
);

const nearBoundaryInside = core.createObservation({ testId: 'inside', x: 0, y: -300, actualDetected: true, geometry });
assert.strictEqual(nearBoundaryInside.zone, 'inside');
assert.strictEqual(nearBoundaryInside.outcome, 'TP');

// Formal definitions override stale or incorrectly imported point expectations.
const forcedExpectation = core.createObservation({ testId: 'inside', x: 0, y: 0, expectedDetected: false, actualDetected: false, geometry });
assert.strictEqual(forcedExpectation.expectedDetected, true, 'formal test definition must override stale point metadata');
assert.strictEqual(forcedExpectation.outcome, 'FN');

// Negative-test summaries count true negatives and false positives correctly.
const outsideObservations = [];
for (let cycle = 1; cycle <= 3; cycle++) {
  for (let i = 0; i < 100; i++) outsideObservations.push(core.createObservation({
    testId: 'outside', cycleNumber: cycle, x: 400, y: i, actualDetected: i >= 95, geometry,
  }));
}
const outsideSummary = core.summarize(outsideObservations, core.TEST_DEFINITIONS.outside);
assert.strictEqual(outsideSummary.counts.TN, 285);
assert.strictEqual(outsideSummary.counts.FP, 15);
assert.strictEqual(outsideSummary.accepted, true);

outsideObservations.push(core.createObservation({ testId: 'outside', cycleNumber: 3, x: 400, y: 0, valid: false, geometry }));
assert.strictEqual(core.summarize(outsideObservations, core.TEST_DEFINITIONS.outside).accepted, false, 'any invalid formal observation invalidates acceptance');

// Unscored, characterization, and custom modes preserve their distinct semantics.
const unscored = core.createObservation({ testId: 'sequence', x: 0, y: 0, actualDetected: true, geometry });
assert.strictEqual(unscored.outcome, 'UNASSESSED');
const characterization = core.createObservation({ testId: 'characterization', x: 0, y: -100, expectedDetected: false, actualDetected: true, geometry });
assert.strictEqual(characterization.expectedDetected, null, 'characterization must never infer a geometric expectation');
assert.strictEqual(characterization.outcome, 'UNASSESSED', 'characterization records trigger yes/no without pass/fail classification');
const custom = core.createObservation({ testId: 'custom', x: 0, y: 0, expectedDetected: false, actualDetected: true, geometry });
assert.strictEqual(custom.outcome, 'FP');
assert.strictEqual(core.validatePlan('custom', [{ x: 0, y: 0 }], geometry)[0].code, 'MISSING_EXPECTATION');

// Multi-cycle report aggregation uses valid observations only, resolves a
// 3-of-5 trigger result as triggered, preserves ties, and uses median latency.
const repeated = [true, true, false, true, false].map((actualDetected, index) => core.createObservation({
  runId: 'aggregate-run', testId: 'characterization', pointId: 'p-001', cycleNumber: index + 1,
  x: 12.345, y: 67.89, actualDetected,
  detectionLatencyMs: actualDetected ? [100, 5000, 300][index > 2 ? 2 : index] : null,
  geometry,
}));
let aggregate = core.aggregateByPoint(repeated, 5)[0];
assert.strictEqual(aggregate.majority, 'TRIGGERED');
assert.strictEqual(aggregate.triggerRate, 0.6);
assert.strictEqual(aggregate.medianLatencyMs, 300);
assert.strictEqual(aggregate.complete, true);

aggregate = core.aggregateByPoint(repeated.slice(0, 4), 5)[0];
assert.strictEqual(aggregate.majority, 'TRIGGERED');
assert.strictEqual(aggregate.complete, false);
const tie = core.aggregateByPoint(repeated.slice(1), 4)[0];
assert.strictEqual(tie.majority, 'TIE');
assert.strictEqual(tie.outcome, 'MIXED');

const formalMajority = core.aggregateByPoint([true, true, false].map((actualDetected, index) => core.createObservation({
  runId: 'formal-run', testId: 'inside', pointId: 'inside-001', cycleNumber: index + 1,
  x: 0, y: -100, actualDetected, geometry,
})), 3)[0];
assert.strictEqual(formalMajority.outcome, 'TP');

// Approved interference heading convention: 0° map-down, negative left,
// positive right, and ±180° map-up.
assert.deepStrictEqual(core.headingVector(0), { x: 0, y: -1 });
assert.ok(core.headingVector(-90).x < -0.999 && Math.abs(core.headingVector(-90).y) < 1e-9);
assert.ok(core.headingVector(90).x > 0.999 && Math.abs(core.headingVector(90).y) < 1e-9);
assert.ok(core.headingVector(180).y > 0.999);
const interference = core.createObservation({ testId: 'interference', x: 1, y: 2, actualDetected: true, geometry });
assert.strictEqual(interference.outcome, 'UNASSESSED');
assert.strictEqual(core.TEST_DEFINITIONS.interference.acceptance, null);
const interferenceSummary = core.summarize([interference], core.TEST_DEFINITIONS.interference);
assert.strictEqual(interferenceSummary.accepted, null, 'interference characterization must never produce a pass/fail acceptance result');
assert.strictEqual(interferenceSummary.assessed, 0, 'interference characterization observations must remain unscored');
assert.strictEqual(interferenceSummary.counts.UNASSESSED, 1, 'interference characterization must retain triggered/not-triggered observations as unassessed');
assert.strictEqual(core.triggeredSensorLabel(true, false), 'A');
assert.strictEqual(core.triggeredSensorLabel(false, true), 'B');
assert.strictEqual(core.triggeredSensorLabel(true, true), 'Both');
assert.strictEqual(core.triggeredSensorLabel(false, false), 'Neither');
assert.strictEqual(core.triggeredSensorLabel(null, false), 'Unknown');
assert.strictEqual(core.createObservation({ testId: 'interference', x: 1, y: 2, actualDetected: true,
  radarAActualDetected: true, radarBActualDetected: true, geometry }).triggeredSensors, 'Both');

// Perimeter coverage is deterministic, exact-count, and side-balanced while
// preserving the physical DUT keep-out and system-level green band.
const perimeter = core.generateRadialPoints({
  count: 20, zone: 'inside', geometry: dualSystemGeometry,
  coverageMode: 'full-dut',
  bounds: { minX: 0, maxX: 1725, minY: 0, maxY: 1040 },
  keepOutClearanceMm: 12,
  isPointAllowed: (point) => !DutLocationCore.pointInNoGo(point, DutLocationCore.DEFAULT_LOCATION, { clearanceMm: 12 }),
});
assert.strictEqual(perimeter.length, 20, 'perimeter generator must preserve exact requested count');
assert.ok(perimeter.every((point) => core.classifySystemDistance(point, dualSystemGeometry) === 'required-trigger'));
assert.ok(perimeter.every((point) => point.x < 744 || point.x > 1006 || point.y < 880 || point.y > 1200), 'perimeter points must stay outside the physical DUT');
assert.deepStrictEqual(new Set(perimeter.map((point) => point.coverageSide)), new Set(['front', 'left', 'right']));
assert.deepStrictEqual(perimeter.reduce((counts, point) => ({ ...counts, [point.coverageSide]: (counts[point.coverageSide] || 0) + 1 }), {}),
  { front: 7, left: 7, right: 6 }, 'full DUT coverage must preserve deterministic balanced side quotas');
assert.deepStrictEqual(core.generateRadialPoints({
  count: 20, zone: 'inside', geometry: dualSystemGeometry, coverageMode: 'full-dut',
  bounds: { minX: 0, maxX: 1725, minY: 0, maxY: 1040 }, keepOutClearanceMm: 12,
  isPointAllowed: (point) => !DutLocationCore.pointInNoGo(point, DutLocationCore.DEFAULT_LOCATION, { clearanceMm: 12 }),
}), perimeter, 'perimeter generation must be repeatable for the same inputs');
assert.ok(perimeter.every((point) => point.coverageSide !== 'rear'), 'full DUT coverage must never generate rear points');
const backfilledPerimeter = core.generateRadialPoints({
  count: 10, zone: 'inside', geometry: dualSystemGeometry,
  coverageMode: 'full-dut',
  bounds: { minX: 0, maxX: 1725, minY: 0, maxY: 1040 },
  keepOutClearanceMm: 12,
  isPointAllowed: (point) => !DutLocationCore.pointInNoGo(point, DutLocationCore.DEFAULT_LOCATION, { clearanceMm: 12 })
    && !(point.x < 744 && point.y < 950),
});
assert.strictEqual(backfilledPerimeter.length, 10, 'unsafe perimeter candidates must be replaced instead of reducing the requested count');
assert.ok(backfilledPerimeter.every((point) => !(point.x < 744 && point.y < 950)), 'replacement points must come only from the allowed area');
assert.deepStrictEqual(new Set(backfilledPerimeter.map((point) => point.coverageSide)), new Set(['front', 'left', 'right']), 'backfill must preserve every feasible requested side');
const redistributedPerimeter = core.generateRadialPoints({
  count: 10, zone: 'inside', geometry: dualSystemGeometry, coverageMode: 'full-dut',
  bounds: { minX: 0, maxX: 1725, minY: 0, maxY: 1040 }, keepOutClearanceMm: 12,
  isPointAllowed: (point) => !DutLocationCore.pointInNoGo(point, DutLocationCore.DEFAULT_LOCATION, { clearanceMm: 12 }) && point.y < 880,
});
assert.strictEqual(redistributedPerimeter.length, 10, 'an unavailable side quota must be redistributed to feasible sides');
assert.ok(redistributedPerimeter.every((point) => point.coverageSide === 'front'), 'redistribution must use only physically feasible sides');
const impossiblePerimeter = core.generateRadialPoints({
  count: 10, zone: 'inside', geometry: dualSystemGeometry, coverageMode: 'full-dut',
  bounds: { minX: 0, maxX: 1725, minY: 0, maxY: 1040 }, keepOutClearanceMm: 12,
  isPointAllowed: () => false,
});
assert.strictEqual(impossiblePerimeter.length, 0, 'an impossible exact-count request must return a shortfall for the caller to block');
const frontOnly = core.generateRadialPoints({
  count: 20, zone: 'inside', geometry: dualSystemGeometry, coverageMode: 'front',
  bounds: { minX: 0, maxX: 1725, minY: 0, maxY: 1040 },
});
assert.strictEqual(frontOnly.length, 20);
assert.ok(frontOnly.every((point) => point.coverageSide === 'front'), 'front coverage must stay on the accessible front edge');

console.log('validation-core tests passed');
