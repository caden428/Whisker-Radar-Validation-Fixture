'use strict';

const assert = require('assert');
const OperatorFlowCore = require('../operator-flow-core');
const RecipeCore = require('../recipe-core');

assert.ok(OperatorFlowCore.hardwareForLayout('single').some((item) => item.id === 'rcwl-single'));
assert.ok(OperatorFlowCore.hardwareForLayout('single').some((item) => item.id === 'ld021-a'));
assert.ok(OperatorFlowCore.hardwareForLayout('dual').some((item) => item.id === 'moresense-dual'));
const ld021System = OperatorFlowCore.hardwareById('ld021-system');
assert.strictEqual(ld021System.sensorLayout, 'dual');
assert.strictEqual(ld021System.radarTarget, 'ld021_pair');
assert.strictEqual(OperatorFlowCore.supportsType(ld021System, 'characterization'), true);
assert.strictEqual(OperatorFlowCore.supportsType(ld021System, 'system'), false, 'experimental HLK system setup must not imply formal bounds qualification');
assert.strictEqual(OperatorFlowCore.supportsType(OperatorFlowCore.hardwareById('rcwl-pair'), 'system'), false);
assert.strictEqual(OperatorFlowCore.supportsType(OperatorFlowCore.hardwareById('rcwl-dual'), 'system'), true);

const config = { recipes: { custom: [RecipeCore.normalize({ id: 'positive-custom', name: 'Positive custom', family: 'inside' })] } };
const positive = OperatorFlowCore.compatiblePlans(RecipeCore.all(config), { hardwareId: 'moresense-single', testType: 'inside' });
assert.ok(positive.length >= 2);
assert.ok(positive.every((plan) => plan.family === 'inside'), 'plan filtering must never cross test types');
assert.deepStrictEqual(OperatorFlowCore.compatiblePlans(RecipeCore.all(config), { hardwareId: 'rcwl-pair', testType: 'system' }), []);
const ld021Characterization = OperatorFlowCore.compatiblePlans(RecipeCore.all(config), { hardwareId: 'ld021-system', testType: 'characterization' });
assert.ok(ld021Characterization.length > 0 && ld021Characterization.every((plan) => plan.family === 'characterization'));
const canonicalPlan = { id: 'canonical-char', name: 'Canonical', testType: 'characterization', scored: false,
  rules: { pointCount: 12, cycles: 2, angularZones: ['left'], minimumCorrectRate: null },
  generation: { bounds: { minX: 10, maxX: 100, minY: 20, maxY: 200 } }, compatibility: { hardwareIds: ['ld021-system'] } };
assert.strictEqual(OperatorFlowCore.compatiblePlans([canonicalPlan], { hardwareId: 'ld021-system', testType: 'characterization' }).length, 1);
assert.deepStrictEqual(OperatorFlowCore.planDraft(canonicalPlan), { sourceRecipeId: 'canonical-char', testType: 'characterization', pointCount: 12, cycles: 2, angularZone: 'left', minimumCorrectRate: null,
  pointLayout: 'even',
  bounds: { minX: 10, maxX: 100, minY: 20, maxY: 200 } });

const source = RecipeCore.find(config, 'builtin-system-detection');
const original = OperatorFlowCore.planDraft(source);
assert.strictEqual(OperatorFlowCore.draftChanged(original, { ...original }), false);
assert.strictEqual(OperatorFlowCore.draftChanged(original, { ...original, pointCount: original.pointCount + 1 }), true);
assert.strictEqual(OperatorFlowCore.draftChanged(original, { ...original, pointLayout: 'grid' }), true);
assert.strictEqual(OperatorFlowCore.draftChanged(original, { ...original, bounds: { ...original.bounds, maxX: original.bounds.maxX - 1 } }), true);

const derivedConfig = RecipeCore.createDerived(config, source, {
  pointCount: 44, angularZones: ['left'], compatibility: { hardwareIds: ['moresense-single'], sensorLayouts: ['single'] },
}, 'Left acceptance sweep');
const derived = RecipeCore.find(derivedConfig, derivedConfig.recipes.activeId);
assert.strictEqual(derived.pointCount, 44);
assert.strictEqual(derived.derivedFromRecipeId, source.id);
assert.deepStrictEqual(derived.compatibility.hardwareIds, ['moresense-single']);
assert.strictEqual(source.pointCount, 100, 'deriving a plan must not mutate the source');
assert.throws(() => RecipeCore.createDerived(config, source, {}, '  '), /Name the modified/);
assert.throws(() => RecipeCore.createDerived(derivedConfig, source, {}, 'Left acceptance sweep'), /already exists/);

console.log('operator flow core tests passed');
