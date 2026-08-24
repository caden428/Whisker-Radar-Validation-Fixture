'use strict';

const assert = require('assert');
const { performance } = require('perf_hooks');
const State = require('../operator-flow-state');

let state = State.create();
const started = performance.now();
for (let index = 0; index < 10000; index += 1) {
  state = State.reduce(state, { type: 'layoutSelected', value: index % 2 ? 'single' : 'dual' });
  state = State.reduce(state, { type: 'hardwareSelected', value: index % 2 ? 'moresense-single' : 'moresense-dual' });
  state = State.reduce(state, { type: 'locationSelected', value: 'location' });
  state = State.reduce(state, { type: 'testTypeSelected', value: 'characterization' });
  state = State.reduce(state, { type: 'planSelected', value: 'plan' });
}
const elapsed = performance.now() - started;
assert.ok(elapsed < 500, `50,000 operator transitions took ${elapsed.toFixed(1)} ms`);
assert.strictEqual(state.planId, 'plan');

console.log(`operator flow performance tests passed (${elapsed.toFixed(1)} ms for 50,000 transitions)`);
