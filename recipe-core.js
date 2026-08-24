(function installRecipeCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RecipeCore = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function recipeCoreFactory() {
  'use strict';

  const SCHEMA_VERSION = 1;
  const FAMILIES = Object.freeze(['inside', 'outside', 'system', 'characterization', 'interference', 'custom', 'sequence']);
  const ANGULAR_ZONES = Object.freeze(['all', 'front', 'left', 'right']);
  const DISTRIBUTIONS = Object.freeze(['even', 'boundary', 'grid', 'seeded', 'imported', 'manual']);
  const COVERAGE_MODES = Object.freeze(['angular', 'front', 'full-dut']);
  const COVERAGE_SIDES = Object.freeze(['front', 'left', 'right']);

  const BUILT_INS = Object.freeze([
    { id: 'builtin-system-detection', name: 'System Detection — Positive', family: 'inside', description: 'Verify required detection inside the green system boundary.', scored: true, pointCount: 100, cycles: 3, angularZones: ['all'], distribution: 'boundary', minimumCorrectRate: 0.95 },
    { id: 'builtin-system-rejection', name: 'System Rejection — Negative', family: 'outside', description: 'Verify no detection beyond the red system boundary.', scored: true, pointCount: 100, cycles: 3, angularZones: ['all'], distribution: 'boundary', minimumCorrectRate: 0.95 },
    { id: 'builtin-system-bounds', name: 'System Level Bounds', family: 'system', description: 'Validate green Detect, grey ungraded, and red No Detect behavior in one section plan.', scored: true, pointCount: 15, cycles: 3, angularZones: ['front'], distribution: 'even', minimumCorrectRate: 0.95 },
    { id: 'builtin-characterization', name: 'Area Characterization', family: 'characterization', description: 'Capture raw trigger behavior across a configured area.', scored: false, pointCount: 100, cycles: 3, angularZones: ['all'], distribution: 'even', minimumCorrectRate: null },
    { id: 'builtin-interference', name: 'Radar Pair Interference', family: 'interference', description: 'Capture raw paired-radar interaction data.', scored: false, pointCount: 100, cycles: 3, angularZones: ['all'], distribution: 'even', minimumCorrectRate: null },
    { id: 'builtin-custom-validation', name: 'Custom Per-Point Validation', family: 'custom', description: 'Score explicit expectations attached to saved points.', scored: true, pointCount: 1, cycles: 3, angularZones: ['all'], distribution: 'manual', minimumCorrectRate: 0.95 },
    { id: 'builtin-unscored-sequence', name: 'Unscored Motion Sequence', family: 'sequence', description: 'Run saved positions without an acceptance claim.', scored: false, pointCount: 1, cycles: 1, angularZones: ['all'], distribution: 'manual', minimumCorrectRate: null },
  ].map((recipe) => Object.freeze({ ...recipe, schemaVersion: SCHEMA_VERSION, version: 1, builtIn: true,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' })));

  function finite(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function slug(value) {
    return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 64) || 'recipe';
  }

  function uniqueZones(values) {
    const zones = [...new Set((Array.isArray(values) ? values : ['all']).map(String).filter((zone) => ANGULAR_ZONES.includes(zone)))];
    if (!zones.length || zones.includes('all')) return ['all'];
    return zones;
  }

  function normalizeCoverageMode(value) {
    const mode = String(value || 'angular');
    if (mode === 'front-perimeter') return 'front';
    if (mode === 'front-side-flanks' || mode === 'full-perimeter') return 'full-dut';
    return COVERAGE_MODES.includes(mode) ? mode : 'angular';
  }

  function normalize(input = {}, options = {}) {
    const family = FAMILIES.includes(String(input.family)) ? String(input.family) : 'characterization';
    const scored = ['inside', 'outside', 'system', 'custom'].includes(family);
    const name = String(input.name || FAMILIES[family] || 'Test Recipe').trim() || 'Test Recipe';
    const baseId = String(input.id || '').trim() || `recipe-${slug(name)}`;
    const version = Math.max(1, Math.floor(finite(input.version, 1)));
    const distribution = DISTRIBUTIONS.includes(String(input.distribution)) ? String(input.distribution)
      : ['inside', 'outside'].includes(family) ? 'boundary' : ['custom', 'sequence'].includes(family) ? 'manual' : 'even';
    const requiredTriggerMm = Math.max(0.1, finite(input.systemBounds?.requiredTriggerMm ?? input.requiredTriggerMm, 304.8));
    const requiredNoTriggerMm = Math.max(requiredTriggerMm + 0.1, finite(input.systemBounds?.requiredNoTriggerMm ?? input.requiredNoTriggerMm, 609.6));
    return {
      schemaVersion: SCHEMA_VERSION,
      id: baseId,
      version,
      builtIn: options.builtIn === true || input.builtIn === true,
      name,
      description: String(input.description || '').trim(),
      family,
      scored,
      pointCount: Math.max(1, Math.floor(finite(input.pointCount, 100))),
      cycles: Math.max(1, Math.floor(finite(input.cycles, 3))),
      angularZones: uniqueZones(input.angularZones),
      coverageMode: normalizeCoverageMode(input.coverageMode),
      coverageSides: normalizeCoverageMode(input.coverageMode) === 'front' ? ['front']
        : normalizeCoverageMode(input.coverageMode) === 'full-dut' ? ['front', 'left', 'right'] : [],
      distribution,
      minimumCorrectRate: scored ? Math.min(1, Math.max(0, finite(input.minimumCorrectRate, 0.95))) : null,
      sequenceName: String(input.sequenceName || '').trim(),
      definitionReference: String(input.definitionReference || '').trim(),
      geometry: input.geometry && typeof input.geometry === 'object' ? JSON.parse(JSON.stringify(input.geometry)) : {},
      systemBounds: { requiredTriggerMm, requiredNoTriggerMm },
      execution: {
        holdMs: Math.max(0, finite(input.execution?.holdMs, 3500)),
        retries: Math.max(0, Math.floor(finite(input.execution?.retries, 0))),
        maxInvalidPoints: Math.max(0, Math.floor(finite(input.execution?.maxInvalidPoints, 0))),
      },
      notes: String(input.notes || '').trim(),
      derivedFromRecipeId: String(input.derivedFromRecipeId || '').trim(),
      compatibility: {
        hardwareIds: Array.isArray(input.compatibility?.hardwareIds) ? [...new Set(input.compatibility.hardwareIds.map(String).filter(Boolean))] : [],
        sensorLayouts: Array.isArray(input.compatibility?.sensorLayouts) ? [...new Set(input.compatibility.sensorLayouts.map(String).filter(Boolean))] : [],
      },
      createdAt: String(input.createdAt || new Date().toISOString()),
      updatedAt: String(input.updatedAt || new Date().toISOString()),
    };
  }

  function builtIns() { return BUILT_INS.map((recipe) => normalize(recipe, { builtIn: true })); }

  function all(config = {}) {
    const custom = (Array.isArray(config.recipes?.custom) ? config.recipes.custom : []).map((recipe) => normalize(recipe));
    return [...builtIns(), ...custom];
  }

  function find(config, id) {
    return all(config).find((recipe) => recipe.id === id) || builtIns()[2];
  }

  function fromConfig(config = {}, overrides = {}) {
    const family = String(overrides.family || config.test?.mode || 'characterization');
    const active = find(config, overrides.id || config.recipes?.activeId);
    return normalize({
      ...active,
      ...overrides,
      family,
      pointCount: overrides.pointCount ?? config.validation?.pointCount ?? active.pointCount,
      cycles: overrides.cycles ?? config.test?.cyclesRequired ?? active.cycles,
      minimumCorrectRate: overrides.minimumCorrectRate ?? config.test?.minimumCorrectRate ?? active.minimumCorrectRate,
      sequenceName: overrides.sequenceName ?? config.activeSequence ?? active.sequenceName,
      angularZones: overrides.angularZones ?? (config.validation?.angularZoneEnabled ? [config.validation.angularZone || 'front'] : ['all']),
      systemBounds: overrides.systemBounds || config.validation?.systemLevel || active.systemBounds,
      geometry: overrides.geometry || {
        sensorLayout: config.validation?.sensorLayout,
        radarTarget: config.validation?.radarTarget,
        hilinkSensor: config.validation?.hilinkSensor,
        dutLocationId: config.dut?.activeLocationId,
        characterizationBounds: config.validation?.characterizationBounds,
      },
      execution: { ...active.execution, holdMs: config.trigger?.holdMsDefault ?? active.execution.holdMs, ...(overrides.execution || {}) },
    });
  }

  function apply(config = {}, recipeInput = {}) {
    const recipe = normalize(recipeInput);
    const zone = recipe.angularZones.length === 1 && recipe.angularZones[0] !== 'all' ? recipe.angularZones[0] : 'front';
    return {
      ...config,
      activeSequence: recipe.sequenceName || config.activeSequence,
      recipes: { ...(config.recipes || {}), activeId: recipe.id },
      test: {
        ...(config.test || {}), mode: recipe.family, cyclesRequired: recipe.cycles,
        minimumCorrectRate: recipe.minimumCorrectRate,
      },
      trigger: { ...(config.trigger || {}), holdMsDefault: recipe.execution.holdMs },
      validation: {
        ...(config.validation || {}), pointCount: recipe.pointCount,
        pointDistribution: recipe.distribution,
        ...(recipe.geometry?.sensorLayout ? { sensorLayout: recipe.geometry.sensorLayout } : {}),
        ...(recipe.geometry?.radarTarget ? { radarTarget: recipe.geometry.radarTarget } : {}),
        ...(recipe.geometry?.hilinkSensor ? { hilinkSensor: recipe.geometry.hilinkSensor } : {}),
        ...(recipe.geometry?.characterizationBounds ? { characterizationBounds: { ...recipe.geometry.characterizationBounds } } : {}),
        angularZoneEnabled: recipe.angularZones.length === 1 && recipe.angularZones[0] !== 'all',
        angularZone: zone,
        coverageMode: recipe.coverageMode,
        coverageSides: recipe.coverageSides,
        systemLevel: { ...recipe.systemBounds },
      },
      dut: recipe.geometry?.dutLocationId ? { ...(config.dut || {}), activeLocationId: recipe.geometry.dutLocationId, reflectorClearanceMm: Math.max(0, finite(recipe.geometry?.reflectorClearanceMm, config.dut?.reflectorClearanceMm || 0)) } : config.dut,
    };
  }

  function saveCustom(config = {}, input = {}) {
    const normalized = normalize(input);
    if (normalized.builtIn) throw new Error('Built-in recipes must be copied before editing');
    const custom = Array.isArray(config.recipes?.custom) ? [...config.recipes.custom] : [];
    const history = Array.isArray(config.recipes?.history) ? [...config.recipes.history] : [];
    const existing = custom.findIndex((recipe) => recipe.id === normalized.id);
    if (existing >= 0) {
      history.push(normalize(custom[existing]));
      normalized.version = Math.max(normalized.version, Number(custom[existing].version || 1) + 1);
      normalized.createdAt = custom[existing].createdAt || normalized.createdAt;
    }
    const stamped = { ...normalized, updatedAt: new Date().toISOString() };
    if (existing >= 0) custom.splice(existing, 1, stamped); else custom.push(stamped);
    return { ...config, recipes: { ...(config.recipes || {}), activeId: stamped.id, custom, history } };
  }

  function createDerived(config = {}, sourceInput = {}, overrides = {}, name = '') {
    const source = normalize(sourceInput);
    const cleanName = String(name || '').trim();
    if (!cleanName) throw new Error('Name the modified test plan before saving it');
    if (all(config).some((recipe) => recipe.name.toLocaleLowerCase() === cleanName.toLocaleLowerCase())) throw new Error('A test plan with that name already exists');
    const derivedId = `recipe-${slug(cleanName)}`;
    if (all(config).some((recipe) => recipe.id === derivedId)) throw new Error('That name conflicts with an existing test plan identifier');
    const now = new Date().toISOString();
    return saveCustom(config, {
      ...source, ...overrides, id: derivedId, name: cleanName, builtIn: false, version: 1,
      derivedFromRecipeId: source.id, createdAt: now, updatedAt: now,
    });
  }

  function migrate(config = {}) {
    const next = { ...config, recipes: {
      activeId: config.recipes?.activeId || '',
      custom: Array.isArray(config.recipes?.custom) ? config.recipes.custom.map((recipe) => normalize(recipe)) : [],
      history: Array.isArray(config.recipes?.history) ? config.recipes.history.map((recipe) => normalize(recipe)) : [],
    } };
    const referencedSequences = new Set([...builtIns(), ...next.recipes.custom].map((recipe) => recipe.sequenceName).filter(Boolean));
    Object.entries(config.sequences || {}).forEach(([sequenceName, points]) => {
      if (referencedSequences.has(sequenceName)) return;
      const id = `recipe-sequence-${slug(sequenceName)}`;
      if (next.recipes.custom.some((recipe) => recipe.id === id)) return;
      next.recipes.custom.push(normalize({
        id, name: sequenceName, family: 'sequence', sequenceName,
        description: 'Imported from an existing coordinate sequence. Assign reviewed rules in Engineering Setup before using it as a scored test.',
        pointCount: Array.isArray(points) ? Math.max(1, points.length) : 1,
        cycles: 1, angularZones: ['all'], distribution: 'manual', minimumCorrectRate: null,
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      }));
      referencedSequences.add(sequenceName);
    });
    if (!next.recipes.activeId || !all(next).some((recipe) => recipe.id === next.recipes.activeId)) {
      next.recipes.activeId = BUILT_INS.find((recipe) => recipe.family === String(config.test?.mode || 'characterization'))?.id || 'builtin-characterization';
    }
    return next;
  }

  function snapshot(recipe) { return JSON.parse(JSON.stringify(normalize(recipe))); }

  return { SCHEMA_VERSION, FAMILIES, ANGULAR_ZONES, DISTRIBUTIONS, COVERAGE_MODES, COVERAGE_SIDES, BUILT_INS, normalize, builtIns, all, find, fromConfig, apply, saveCustom, createDerived, migrate, snapshot };
}));
