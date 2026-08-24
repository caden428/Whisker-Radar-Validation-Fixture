(function installOperatorFlowState(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OperatorFlowState = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function operatorFlowStateFactory() {
  'use strict';

  const EMPTY = Object.freeze({ layout: '', hardwareId: '', locationId: '', testType: '', planId: '' });
  function text(value) { return String(value || ''); }
  function create(input = {}) {
    return { layout: text(input.layout), hardwareId: text(input.hardwareId), locationId: text(input.locationId), testType: text(input.testType), planId: text(input.planId) };
  }

  function reduce(stateInput, action = {}) {
    const state = create(stateInput);
    switch (action.type) {
      case 'hydrate': return create(action.value);
      case 'layoutSelected': return { ...EMPTY, layout: text(action.value) };
      case 'hardwareSelected': return { ...state, hardwareId: text(action.value), locationId: '', testType: '', planId: '' };
      case 'locationSelected': return { ...state, locationId: text(action.value) };
      case 'testTypeSelected': return { ...state, testType: text(action.value), planId: '' };
      case 'planSelected': return { ...state, planId: text(action.value) };
      default: return state;
    }
  }

  function reconcile(stateInput, model = {}) {
    let state = create(stateInput);
    const hardware = (model.hardware || []).find((item) => item.id === state.hardwareId && item.layout === state.layout);
    if (!hardware) state = { ...state, hardwareId: '', locationId: '', testType: '', planId: '' };
    const location = (model.locations || []).find((item) => item.id === state.locationId);
    if (!location) state = { ...state, locationId: '', testType: '', planId: '' };
    const type = (model.testTypes || []).find((item) => item.id === state.testType);
    if (!type) state = { ...state, testType: '', planId: '' };
    const plan = (model.plans || []).find((item) => item.id === state.planId);
    if (!plan) state = { ...state, planId: '' };
    return state;
  }

  return { EMPTY, create, reduce, reconcile };
}));
