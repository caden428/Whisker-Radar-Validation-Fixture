'use strict';

const assert = require('assert');
const RecipeCore = require('../recipe-core');

const migrated = RecipeCore.migrate({ test: { mode: 'inside' }, validation: {}, trigger: {}, recipes: {} });
assert.strictEqual(migrated.recipes.activeId, 'builtin-system-detection');
assert.strictEqual(RecipeCore.builtIns().length, 7);
assert.strictEqual(RecipeCore.find(migrated, 'builtin-system-bounds').family, 'system');
assert.deepStrictEqual(RecipeCore.builtIns(), RecipeCore.builtIns(), 'built-in recipe snapshots must remain byte-stable across reads');

const recipe = RecipeCore.normalize({
  name: 'Front qualification', family: 'inside', pointCount: 42, cycles: 5,
  angularZones: ['front'], minimumCorrectRate: 0.97,
  coverageMode: 'full-dut',
  geometry: { dutLocationId: 'in-field-front-875-880', reflectorClearanceMm: 18 },
  systemBounds: { requiredTriggerMm: 355.6, requiredNoTriggerMm: 711.2 },
});
const applied = RecipeCore.apply({ test: {}, validation: {}, trigger: {}, recipes: {}, activeSequence: 'old' }, recipe);
assert.strictEqual(applied.test.mode, 'inside');
assert.strictEqual(applied.test.cyclesRequired, 5);
assert.strictEqual(applied.validation.pointCount, 42);
assert.strictEqual(applied.validation.angularZone, 'front');
assert.strictEqual(applied.validation.angularZoneEnabled, true);
assert.strictEqual(applied.validation.coverageMode, 'full-dut');
assert.deepStrictEqual(applied.validation.coverageSides, ['front', 'left', 'right']);
assert.strictEqual(applied.dut.reflectorClearanceMm, 18);
assert.deepStrictEqual(applied.validation.systemLevel, { requiredTriggerMm: 355.6, requiredNoTriggerMm: 711.2 });

let config = RecipeCore.saveCustom(applied, recipe);
const saved = RecipeCore.find(config, config.recipes.activeId);
assert.strictEqual(saved.name, 'Front qualification');
assert.deepStrictEqual(RecipeCore.snapshot(saved), RecipeCore.snapshot(saved), 'recipe snapshots must be deterministic');
config = RecipeCore.saveCustom(config, { ...saved, pointCount: 50 });
assert.strictEqual(RecipeCore.find(config, saved.id).version, 2, 'editing a custom recipe must create a new version');
assert.strictEqual(RecipeCore.find(config, saved.id).createdAt, saved.createdAt, 'recipe versioning must preserve original creation identity');
assert.strictEqual(config.recipes.history.length, 1, 'editing must retain the prior recipe version for traceability');

const multiZone = RecipeCore.normalize({ name: 'Three zones', family: 'inside', angularZones: ['front', 'left', 'right'] });
assert.deepStrictEqual(multiZone.angularZones, ['front', 'left', 'right']);
assert.deepStrictEqual(RecipeCore.normalize({ name: 'All', angularZones: ['all', 'front'] }).angularZones, ['all']);
assert.strictEqual(RecipeCore.normalize({ coverageMode: 'front-perimeter' }).coverageMode, 'front');
assert.strictEqual(RecipeCore.normalize({ coverageMode: 'front-side-flanks' }).coverageMode, 'full-dut');
assert.strictEqual(RecipeCore.normalize({ coverageMode: 'full-perimeter' }).coverageMode, 'full-dut');
assert.ok(!RecipeCore.COVERAGE_SIDES.includes('rear'), 'rear coverage must not exist in the supported model');

const referenced = RecipeCore.normalize({ name: 'Referenced plan', definitionReference: 'engineering/shared-plan-v2' });
assert.strictEqual(referenced.definitionReference, 'engineering/shared-plan-v2', 'Engineering definition references must use the shared recipe contract');

const legacySequenceConfig = RecipeCore.migrate({
  test: { mode: 'characterization' }, validation: {}, trigger: {}, recipes: {},
  sequences: { 'Legacy hand path': [{ x: 100, y: 200, z: 0 }] },
});
const migratedSequencePlan = RecipeCore.find(legacySequenceConfig, 'recipe-sequence-legacy-hand-path');
assert.ok(migratedSequencePlan, 'orphan motion sequences must be published as selectable plans');
assert.strictEqual(migratedSequencePlan.family, 'sequence');
assert.strictEqual(migratedSequencePlan.sequenceName, 'Legacy hand path');
assert.strictEqual(migratedSequencePlan.distribution, 'manual');

console.log('recipe core tests passed');
