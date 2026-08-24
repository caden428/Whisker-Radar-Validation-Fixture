'use strict';

const assert = require('assert');
const Workspace = require('../run-workspace-core');

const recipe = { id: 'plan-a', name: 'Plan A', family: 'inside', pointCount: 3, cycles: 2, distribution: 'boundary' };
const catalog = Workspace.catalogFromLegacy({ activeId: 'plan-a', custom: [recipe], history: [] }, []);
assert.strictEqual(catalog.find('plan-a').testType, 'inside');
assert.strictEqual(catalog.list().length, 1);
const returned = catalog.find('plan-a');
returned.name = 'mutated';
assert.strictEqual(catalog.find('plan-a').name, 'Plan A', 'catalog reads must not expose mutable stored plans');

const draft = Workspace.createDraft({ layout: 'single', hardwareId: 'moresense-single', locationId: 'single-sensor-875-1200', planId: 'plan-a' });
const prepared = Workspace.prepare({
  plan: catalog.find('plan-a'), draft, generatedPoints: [{ x: 1, y: 2 }],
  resolvedHardware: { id: 'moresense-single' }, resolvedGeometry: { centerX: 875, centerY: 1200 },
  acceptanceRules: { cyclesRequired: 2, minimumCorrectRate: 0.95 },
});
assert.strictEqual(prepared.setup.planId, 'plan-a');
assert.deepStrictEqual(prepared.generatedPoints, [{ x: 1, y: 2 }]);

console.log('run workspace tests passed');
