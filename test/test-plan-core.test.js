'use strict';

const assert = require('assert');
const TestPlanCore = require('../test-plan-core');

const legacy = {
  id: 'area-char', version: 3, name: 'Area Characterization', family: 'characterization',
  pointCount: 80, cycles: 2, angularZones: ['left'], distribution: 'grid', minimumCorrectRate: null,
  compatibility: { hardwareIds: ['ld021-system'], sensorLayouts: ['dual'] },
  sequenceName: 'Area Grid', definitionReference: 'plans/area-v3',
  geometry: { dutLocationId: 'front', characterizationBounds: { minX: 0, maxX: 100 } },
};
const plan = TestPlanCore.fromLegacyRecipe(legacy);
assert.strictEqual(plan.testType, 'characterization');
assert.strictEqual(plan.rules.pointCount, 80);
assert.strictEqual(plan.generation.strategy, 'grid');
assert.strictEqual(plan.generation.linkedSequenceName, 'Area Grid');
assert.deepStrictEqual(plan.generation.bounds, { minX: 0, maxX: 100 });
assert.deepStrictEqual(plan.compatibility.hardwareIds, ['ld021-system']);
assert.ok(TestPlanCore.validatePlan(plan).success);
assert.ok(!TestPlanCore.validatePlan({ ...plan, id: '' }).success);

const setup = TestPlanCore.normalizeRunSetup({
  layout: 'dual', hardwareId: 'ld021-system', locationId: 'front', dutId: 'AQUA-1', planId: plan.id,
  overrides: { pointCount: 90, cycles: 4, angularZone: 'right' },
});
assert.ok(TestPlanCore.validateRunSetup(setup).success);
assert.strictEqual(setup.overrides.pointCount, 90);
assert.ok(!TestPlanCore.validateRunSetup({ ...setup, planId: '' }).success);

const prepared = TestPlanCore.createPreparedRun({ plan, setup, generatedPoints: [{ x: 1, y: 2 }], resolvedHardware: { id: 'ld021-system' } });
assert.ok(Object.isFrozen(prepared));
assert.ok(Object.isFrozen(prepared.plan));
assert.ok(Object.isFrozen(prepared.generatedPoints));
assert.strictEqual(prepared.plan.id, plan.id);
assert.deepStrictEqual(prepared.generatedPoints, [{ x: 1, y: 2 }]);

const catalog = TestPlanCore.migrateLegacyCatalog({ activeId: legacy.id, custom: [legacy], history: [{ ...legacy, version: 2 }] });
assert.strictEqual(catalog.activePlanId, legacy.id);
assert.strictEqual(catalog.custom[0].testType, 'characterization');
assert.strictEqual(catalog.history[0].version, 2);
assert.deepStrictEqual(TestPlanCore.OWNERSHIP.runSetup, ['layout', 'hardwareId', 'locationId', 'dutId', 'planId', 'overrides']);

console.log('test plan contract tests passed');
