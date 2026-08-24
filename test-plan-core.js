(function installTestPlanCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TestPlanCore = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function testPlanCoreFactory() {
  'use strict';

  const SCHEMA_VERSION = 1;
  const TEST_TYPES = Object.freeze(['inside', 'outside', 'system', 'characterization', 'interference', 'custom', 'sequence']);
  const ZONES = Object.freeze(['all', 'front', 'left', 'right']);
  const STRATEGIES = Object.freeze(['even', 'boundary', 'grid', 'seeded', 'imported', 'manual']);
  const OWNERSHIP = Object.freeze({
    plan: Object.freeze(['testType', 'compatibility', 'rules', 'generation', 'execution']),
    runSetup: Object.freeze(['layout', 'hardwareId', 'locationId', 'dutId', 'planId', 'overrides']),
    fixture: Object.freeze(['connection', 'motion', 'triggerHardware', 'radarService', 'locations']),
    preparedRun: Object.freeze(['plan', 'setup', 'generatedPoints', 'resolvedHardware', 'resolvedGeometry', 'acceptanceRules']),
  });

  function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
  function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.values(value).forEach(deepFreeze);
    return Object.freeze(value);
  }
  function finite(value, fallback) { const number = Number(value); return Number.isFinite(number) ? number : fallback; }
  function text(value) { return String(value || '').trim(); }
  function unique(values) { return [...new Set((Array.isArray(values) ? values : []).map(String).filter(Boolean))]; }
  function zones(values) {
    const selected = unique(values).filter((zone) => ZONES.includes(zone));
    return !selected.length || selected.includes('all') ? ['all'] : selected;
  }

  /** Canonical reusable plan. Runtime fixture selections never belong here. */
  function normalizePlan(input = {}) {
    const testType = TEST_TYPES.includes(String(input.testType)) ? String(input.testType) : 'characterization';
    const scored = ['inside', 'outside', 'system', 'custom'].includes(testType);
    const requiredTriggerMm = Math.max(0.1, finite(input.rules?.systemBounds?.requiredTriggerMm, 304.8));
    const requiredNoTriggerMm = Math.max(requiredTriggerMm + 0.1, finite(input.rules?.systemBounds?.requiredNoTriggerMm, 609.6));
    return {
      schemaVersion: SCHEMA_VERSION,
      id: text(input.id),
      version: Math.max(1, Math.floor(finite(input.version, 1))),
      builtIn: input.builtIn === true,
      name: text(input.name),
      description: text(input.description),
      testType,
      scored,
      compatibility: {
        hardwareIds: unique(input.compatibility?.hardwareIds),
        sensorLayouts: unique(input.compatibility?.sensorLayouts),
      },
      rules: {
        pointCount: Math.max(1, Math.floor(finite(input.rules?.pointCount, 100))),
        cycles: Math.max(1, Math.floor(finite(input.rules?.cycles, 3))),
        angularZones: zones(input.rules?.angularZones),
        coverageMode: text(input.rules?.coverageMode) || 'angular',
        minimumCorrectRate: scored ? Math.min(1, Math.max(0, finite(input.rules?.minimumCorrectRate, 0.95))) : null,
        systemBounds: { requiredTriggerMm, requiredNoTriggerMm },
      },
      generation: {
        strategy: STRATEGIES.includes(String(input.generation?.strategy)) ? String(input.generation.strategy) : 'even',
        linkedSequenceName: text(input.generation?.linkedSequenceName),
        definitionReference: text(input.generation?.definitionReference),
        bounds: clone(input.generation?.bounds || null),
      },
      execution: {
        holdMs: Math.max(0, finite(input.execution?.holdMs, 3500)),
        retries: Math.max(0, Math.floor(finite(input.execution?.retries, 0))),
        maxInvalidPoints: Math.max(0, Math.floor(finite(input.execution?.maxInvalidPoints, 0))),
      },
      notes: text(input.notes),
      derivedFromPlanId: text(input.derivedFromPlanId),
      createdAt: text(input.createdAt),
      updatedAt: text(input.updatedAt),
    };
  }

  function validatePlan(input) {
    const plan = normalizePlan(input);
    const errors = [];
    if (!plan.id) errors.push('id is required');
    if (!plan.name) errors.push('name is required');
    if (!TEST_TYPES.includes(plan.testType)) errors.push('testType is invalid');
    if (!STRATEGIES.includes(plan.generation.strategy)) errors.push('generation.strategy is invalid');
    if (!plan.builtIn && ['custom', 'sequence'].includes(plan.testType) && plan.generation.strategy === 'manual' && !plan.generation.linkedSequenceName) errors.push('manual plans require a linked sequence');
    return { success: errors.length === 0, errors, value: plan };
  }

  /** Current operator choices. These may override rules, but never mutate a saved plan. */
  function normalizeRunSetup(input = {}) {
    return {
      layout: text(input.layout), hardwareId: text(input.hardwareId), locationId: text(input.locationId),
      dutId: text(input.dutId), planId: text(input.planId),
      overrides: {
        pointCount: input.overrides?.pointCount == null ? null : Math.max(1, Math.floor(finite(input.overrides.pointCount, 1))),
        cycles: input.overrides?.cycles == null ? null : Math.max(1, Math.floor(finite(input.overrides.cycles, 1))),
        angularZone: input.overrides?.angularZone == null ? null : (ZONES.includes(String(input.overrides.angularZone)) ? String(input.overrides.angularZone) : 'all'),
        minimumCorrectRate: input.overrides?.minimumCorrectRate == null ? null : Math.min(1, Math.max(0, finite(input.overrides.minimumCorrectRate, 0))),
      },
    };
  }

  function validateRunSetup(input) {
    const setup = normalizeRunSetup(input);
    const errors = [];
    ['layout', 'hardwareId', 'locationId', 'planId'].forEach((field) => { if (!setup[field]) errors.push(`${field} is required`); });
    return { success: errors.length === 0, errors, value: setup };
  }

  /** Immutable boundary consumed by execution and reporting after preparation. */
  function createPreparedRun({ plan, setup, generatedPoints, resolvedHardware, resolvedGeometry, acceptanceRules, preparedAt } = {}) {
    const planResult = validatePlan(plan);
    const setupResult = validateRunSetup(setup);
    if (!planResult.success || !setupResult.success) throw new Error([...planResult.errors, ...setupResult.errors].join('; '));
    const snapshot = {
      schemaVersion: SCHEMA_VERSION, plan: planResult.value, setup: setupResult.value,
      generatedPoints: clone(Array.isArray(generatedPoints) ? generatedPoints : []),
      resolvedHardware: clone(resolvedHardware || {}), resolvedGeometry: clone(resolvedGeometry || {}),
      acceptanceRules: clone(acceptanceRules || {}), preparedAt: text(preparedAt) || new Date().toISOString(),
    };
    return deepFreeze(clone(snapshot));
  }

  function fromLegacyRecipe(recipe = {}) {
    return normalizePlan({
      id: recipe.id, version: recipe.version, builtIn: recipe.builtIn, name: recipe.name,
      description: recipe.description, testType: recipe.family, compatibility: recipe.compatibility,
      rules: { pointCount: recipe.pointCount, cycles: recipe.cycles, angularZones: recipe.angularZones,
        coverageMode: recipe.coverageMode, minimumCorrectRate: recipe.minimumCorrectRate, systemBounds: recipe.systemBounds },
      generation: { strategy: recipe.distribution, linkedSequenceName: recipe.sequenceName,
        definitionReference: recipe.definitionReference, bounds: recipe.geometry?.characterizationBounds || null },
      execution: recipe.execution, notes: recipe.notes, derivedFromPlanId: recipe.derivedFromRecipeId,
      createdAt: recipe.createdAt, updatedAt: recipe.updatedAt,
    });
  }

  function migrateLegacyCatalog(recipes = {}) {
    const migrateList = (items) => (Array.isArray(items) ? items : []).map(fromLegacyRecipe);
    return {
      schemaVersion: SCHEMA_VERSION,
      activePlanId: text(recipes.activeId),
      custom: migrateList(recipes.custom),
      history: migrateList(recipes.history),
    };
  }

  return { SCHEMA_VERSION, TEST_TYPES, ZONES, STRATEGIES, OWNERSHIP, normalizePlan, validatePlan, normalizeRunSetup, validateRunSetup, createPreparedRun, fromLegacyRecipe, migrateLegacyCatalog };
}));
