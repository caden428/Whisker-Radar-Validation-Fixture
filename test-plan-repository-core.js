'use strict';

const TestPlanCore = require('./test-plan-core');

function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function normalizeCatalog(input = {}) {
  return { schemaVersion: 1, activePlanId: String(input.activePlanId || 'builtin-characterization'),
    custom: (Array.isArray(input.custom) ? input.custom : []).map(TestPlanCore.normalizePlan),
    history: (Array.isArray(input.history) ? input.history : []).map(TestPlanCore.normalizePlan) };
}
function save(input, planInput) {
  const catalog = normalizeCatalog(input);
  const validation = TestPlanCore.validatePlan(planInput);
  if (!validation.success) throw new Error(validation.errors.join('; '));
  const plan = validation.value;
  if (plan.builtIn) throw new Error('Built-in plans cannot be overwritten');
  const index = catalog.custom.findIndex((item) => item.id === plan.id);
  if (index >= 0) {
    catalog.history.push(clone(catalog.custom[index]));
    plan.version = Math.max(plan.version, Number(catalog.custom[index].version || 1) + 1);
    plan.createdAt = catalog.custom[index].createdAt || plan.createdAt;
    catalog.custom.splice(index, 1, plan);
  } else catalog.custom.push(plan);
  catalog.activePlanId = plan.id;
  return { catalog, plan: clone(plan) };
}
function remove(input, planId) {
  const catalog = normalizeCatalog(input);
  const index = catalog.custom.findIndex((plan) => plan.id === String(planId));
  if (index < 0) throw new Error('Only saved custom plans can be deleted');
  catalog.history.push(catalog.custom[index]);
  catalog.custom.splice(index, 1);
  if (catalog.activePlanId === planId) catalog.activePlanId = 'builtin-characterization';
  return catalog;
}

module.exports = { normalizeCatalog, save, remove };
