'use strict';

const assert = require('assert');
const Repository = require('../test-plan-repository-core');

const base = { id: 'custom-a', name: 'Custom A', testType: 'inside', builtIn: false,
  rules: { pointCount: 10, cycles: 2, angularZones: ['all'], minimumCorrectRate: 0.95 },
  generation: { strategy: 'boundary' } };
let result = Repository.save({}, base);
assert.strictEqual(result.plan.version, 1);
result = Repository.save(result.catalog, { ...base, rules: { ...base.rules, pointCount: 20 } });
assert.strictEqual(result.plan.version, 2);
assert.strictEqual(result.catalog.history.length, 1);
assert.strictEqual(result.catalog.custom[0].rules.pointCount, 20);
const removed = Repository.remove(result.catalog, 'custom-a');
assert.strictEqual(removed.custom.length, 0);
assert.strictEqual(removed.history.length, 2);
assert.throws(() => Repository.save({}, { ...base, builtIn: true }), /Built-in/);

console.log('test plan repository tests passed');
