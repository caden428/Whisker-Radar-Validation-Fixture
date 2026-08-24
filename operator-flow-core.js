(function installOperatorFlowCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OperatorFlowCore = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function operatorFlowCoreFactory() {
  'use strict';

  const TEST_TYPES = Object.freeze([
    { id: 'inside', label: 'Positive Detection', scored: true },
    { id: 'outside', label: 'Negative Detection', scored: true },
    { id: 'system', label: 'Total Bounds Testing', scored: true },
    { id: 'characterization', label: 'Characterization', scored: false },
    { id: 'interference', label: 'Interference', scored: false },
    { id: 'sequence', label: 'Motion Sequence Only', scored: false },
    { id: 'custom', label: 'Custom', scored: true },
  ]);

  const HARDWARE = Object.freeze([
    { id: 'moresense-single', label: 'MoreSense — single sensor', layout: 'single', sensorLayout: 'single', radarTarget: 'single' },
    { id: 'rcwl-single', label: 'RCWL-0516 — single sensor', layout: 'single', sensorLayout: 'single', radarTarget: 'rcwl_single', fixedOutput: true },
    { id: 'ld021-a', label: 'HLK-LD021 — sensor A', layout: 'single', sensorLayout: 'single', radarTarget: 'ld021', hilinkSensor: 'A', experimental: true },
    { id: 'ld021-b', label: 'HLK-LD021 — sensor B', layout: 'single', sensorLayout: 'single', radarTarget: 'ld021', hilinkSensor: 'B', experimental: true },
    { id: 'moresense-dual', label: 'Aqua MoreSense dual-sensor system', layout: 'dual', sensorLayout: 'dual', radarTarget: 'dual', systemGeometry: true },
    { id: 'rcwl-dual', label: 'Aqua RCWL-0516 dual-input system', layout: 'dual', sensorLayout: 'dual', radarTarget: 'rcwl_dual', systemGeometry: true, fixedOutput: true },
    { id: 'ld021-system', label: 'Aqua system-level DUT — two HLK-LD021 sensors', layout: 'dual', sensorLayout: 'dual', radarTarget: 'ld021_pair', systemGeometry: true, experimental: true,
      allowedTestTypes: ['characterization', 'interference', 'sequence', 'custom'] },
    { id: 'rcwl-pair', label: 'RCWL-0516 paired sensors', layout: 'dual', sensorLayout: 'rcwl_pair', radarTarget: 'rcwl_pair', fixedOutput: true },
    { id: 'ld021-pair', label: 'HLK-LD021 paired sensors — stand characterization', layout: 'dual', sensorLayout: 'ld021_pair', radarTarget: 'ld021_pair', experimental: true },
  ]);

  const ZONES = Object.freeze([
    { id: 'all', label: 'Whole zone' },
    { id: 'left', label: 'Left' },
    { id: 'front', label: 'Middle' },
    { id: 'right', label: 'Right' },
  ]);
  const POINT_LAYOUTS = Object.freeze(['even', 'boundary', 'grid', 'seeded', 'imported', 'manual']);

  function hardwareForLayout(layout) { return HARDWARE.filter((item) => item.layout === layout).map((item) => ({ ...item })); }
  function hardwareById(id) { const item = HARDWARE.find((entry) => entry.id === id); return item ? { ...item } : null; }
  function typeById(id) { const item = TEST_TYPES.find((entry) => entry.id === id); return item ? { ...item } : null; }

  function supportsType(hardware, type) {
    if (!hardware || !type) return false;
    if (Array.isArray(hardware.allowedTestTypes) && !hardware.allowedTestTypes.includes(type)) return false;
    if (type === 'system') return hardware.systemGeometry === true;
    if (['inside', 'outside'].includes(type)) return ['single', 'dual'].includes(hardware.sensorLayout);
    if (type === 'interference') return hardware.layout === 'dual';
    return true;
  }

  function compatiblePlans(recipes, selection = {}) {
    const hardware = hardwareById(selection.hardwareId);
    return (Array.isArray(recipes) ? recipes : []).filter((recipe) => {
      if ((recipe.testType || recipe.family) !== selection.testType || !supportsType(hardware, selection.testType)) return false;
      const compatibility = recipe.compatibility || {};
      if (Array.isArray(compatibility.hardwareIds) && compatibility.hardwareIds.length && !compatibility.hardwareIds.includes(hardware.id)) return false;
      if (Array.isArray(compatibility.sensorLayouts) && compatibility.sensorLayouts.length && !compatibility.sensorLayouts.includes(hardware.sensorLayout)) return false;
      return true;
    });
  }

  function movementBounds(recipe, fallback = {}) {
    const source = recipe?.generation?.bounds || recipe?.geometry?.characterizationBounds || fallback || {};
    const finite = (value, defaultValue) => Number.isFinite(Number(value)) ? Number(value) : defaultValue;
    return {
      minX: finite(source.minX, 0), maxX: finite(source.maxX, 1725),
      minY: finite(source.minY, 150), maxY: finite(source.maxY, 1040),
    };
  }

  function planDraft(recipe, fallbackBounds = {}) {
    if (!recipe) return null;
    const rules = recipe.rules || recipe;
    return {
      sourceRecipeId: recipe.id,
      testType: recipe.testType || recipe.family,
      pointCount: Math.max(1, Math.floor(Number(rules.pointCount) || 1)),
      pointLayout: POINT_LAYOUTS.includes(recipe.generation?.strategy || recipe.distribution) ? (recipe.generation?.strategy || recipe.distribution) : 'even',
      cycles: Math.max(1, Math.floor(Number(rules.cycles) || 1)),
      angularZone: Array.isArray(rules.angularZones) && rules.angularZones.length === 1 ? rules.angularZones[0] : 'all',
      minimumCorrectRate: recipe.scored ? Math.min(1, Math.max(0, Number(rules.minimumCorrectRate) || 0)) : null,
      bounds: movementBounds(recipe, fallbackBounds),
    };
  }

  function comparableDraft(draft) {
    return draft ? JSON.stringify({ pointCount: Number(draft.pointCount), pointLayout: POINT_LAYOUTS.includes(draft.pointLayout) ? draft.pointLayout : 'even', cycles: Number(draft.cycles), angularZone: draft.angularZone || 'all', minimumCorrectRate: draft.minimumCorrectRate == null ? null : Number(draft.minimumCorrectRate), bounds: movementBounds({ generation: { bounds: draft.bounds } }) }) : '';
  }
  function draftChanged(original, current) { return comparableDraft(original) !== comparableDraft(current); }

  return { TEST_TYPES, HARDWARE, ZONES, POINT_LAYOUTS, hardwareForLayout, hardwareById, typeById, supportsType, compatiblePlans, movementBounds, planDraft, draftChanged };
}));
