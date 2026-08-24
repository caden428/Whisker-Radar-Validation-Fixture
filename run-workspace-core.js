(function installRunWorkspaceCore(root, factory) {
  const dependency = typeof module === 'object' && module.exports ? require('./test-plan-core') : root.TestPlanCore;
  const api = factory(dependency);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RunWorkspaceCore = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function runWorkspaceCoreFactory(TestPlanCore) {
  'use strict';

  function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }

  function catalogFromLegacy(recipes = {}, builtIns = []) {
    const migrated = TestPlanCore.migrateLegacyCatalog(recipes);
    const plans = [...(Array.isArray(builtIns) ? builtIns : []).map(TestPlanCore.fromLegacyRecipe), ...migrated.custom];
    return Object.freeze({
      activePlanId: migrated.activePlanId,
      list: () => plans.map(clone),
      find: (id) => clone(plans.find((plan) => plan.id === id) || null),
      history: () => migrated.history.map(clone),
    });
  }

  function catalogFromCanonical(testPlans = {}, builtIns = []) {
    const plans = [...(Array.isArray(builtIns) ? builtIns : []).map(TestPlanCore.fromLegacyRecipe),
      ...(Array.isArray(testPlans.custom) ? testPlans.custom : []).map(TestPlanCore.normalizePlan)];
    const history = (Array.isArray(testPlans.history) ? testPlans.history : []).map(TestPlanCore.normalizePlan);
    return Object.freeze({
      activePlanId: String(testPlans.activePlanId || ''), list: () => plans.map(clone),
      find: (id) => clone(plans.find((plan) => plan.id === id) || null), history: () => history.map(clone),
    });
  }

  function createDraft(input = {}) {
    return Object.freeze(TestPlanCore.normalizeRunSetup(input));
  }

  function prepare({ plan, draft, generatedPoints, resolvedHardware, resolvedGeometry, acceptanceRules, preparedAt } = {}) {
    return TestPlanCore.createPreparedRun({
      plan, setup: draft, generatedPoints, resolvedHardware, resolvedGeometry, acceptanceRules, preparedAt,
    });
  }

  return { catalogFromLegacy, catalogFromCanonical, createDraft, prepare };
}));
