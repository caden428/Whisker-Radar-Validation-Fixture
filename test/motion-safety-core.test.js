'use strict';

const assert = require('assert');
const core = require('../motion-safety-core');

const legacy = core.migrate({
  x: { minMm: 0, maxMm: 100, speedMmS: 6000, accelMmS2: 500 },
  y: { minMm: 0, maxMm: 100, speedMmS: 3000, accelMmS2: 500 },
  z: { minMm: 0, maxMm: 360, speedMmS: 1200, accelMmS2: 500 },
});
assert.strictEqual(legacy.unitsVersion, 2);
assert.strictEqual(legacy.x.speedMmS, 100, 'legacy G-code feed must migrate from mm/min to canonical mm/s');
assert.strictEqual(core.feedMmMin(83.33333333333333), 5000, 'canonical mm/s must convert to G-code mm/min only at command construction');

const commissioned = { ...legacy, commissioned: true };
assert.deepStrictEqual(core.commissioningIssues(commissioned), []);
assert.match(core.commissioningIssues({ ...commissioned, x: { ...commissioned.x, minMm: -9999 } }).join(' '), /placeholder/);
assert.match(core.pointIssue(commissioned, { x: 101, y: 50 }), /outside configured travel/);
assert.match(core.pointIssue(commissioned, { x: 'not-a-number' }), /must be finite/);
assert.match(core.speedIssue(501), /<= 500/);
assert.match(core.timeoutIssue(999), /between 1000/);
assert.throws(() => core.feedMmMin('G1 X999'), /Speed must/);

console.log('motion safety core tests passed');
