'use strict';

const assert = require('assert');
const State = require('../operator-flow-state');

let state = State.create();
state = State.reduce(state, { type: 'layoutSelected', value: 'dual' });
state = State.reduce(state, { type: 'hardwareSelected', value: 'ld021-system' });
state = State.reduce(state, { type: 'locationSelected', value: 'front' });
state = State.reduce(state, { type: 'testTypeSelected', value: 'characterization' });
state = State.reduce(state, { type: 'planSelected', value: 'area' });
assert.deepStrictEqual(state, { layout: 'dual', hardwareId: 'ld021-system', locationId: 'front', testType: 'characterization', planId: 'area' });

state = State.reduce(state, { type: 'testTypeSelected', value: 'interference' });
assert.strictEqual(state.planId, '', 'changing type must clear only the incompatible downstream plan');
assert.strictEqual(state.locationId, 'front', 'changing type must preserve upstream fixture choices');
state = State.reduce(state, { type: 'hardwareSelected', value: 'rcwl-dual' });
assert.strictEqual(state.locationId, '');
assert.strictEqual(state.testType, '');

const reconciled = State.reconcile({ layout: 'dual', hardwareId: 'missing', locationId: 'front', testType: 'inside', planId: 'positive' }, {
  hardware: [{ id: 'ld021-system', layout: 'dual' }], locations: [{ id: 'front' }], testTypes: [{ id: 'inside' }], plans: [{ id: 'positive' }],
});
assert.deepStrictEqual(reconciled, { layout: 'dual', hardwareId: '', locationId: '', testType: '', planId: '' });

console.log('operator flow state tests passed');
