/* global Chart, radarAPI, ValidationCore, RadarSettingsCore, RendererStore, ConfigurationDraft, RunStateView, TestPlanCore, OperatorFlowState, RunWorkspaceCore */
'use strict';

/*
 * Module organization
 * -------------------
 *  1. Application state
 *  2. Charts, geometry, and validation views
 *  3. Logging and radar settings
 *  4. UI state and sequence planning
 *  5. Radar observation and sequence execution
 *  6. Motion, connection, and configuration workflows
 *  7. IPC updates, auxiliary controls, and initialization
 *
 * Keep declarations in execution order. Section boundaries are navigational;
 * application behavior remains owned by the existing functions below.
 */

// ─── State ────────────────────────────────────────────────────────────────────
let config = null;           // loaded from main process (radar-config.json)
const appStore = RendererStore.createStore({ config: null, configDraft: null, run: null, connection: {} });
let connected = false;       // Moonraker host reachable
let klippyState = 'unknown'; // 'ready' | 'shutdown' | 'error' | 'startup' | 'unknown'
let idleState = '';          // 'Idle' | 'Ready' | 'Printing'
let homedAxes = '';          // e.g. "xy"
let position = { x: 0, y: 0, z: 0 };
let lastConfirmedHomePoint = null;
let commandInFlight = false; // set around any motion IPC call, for the Motion Active dot

let testRunning  = false;
let repeatedSingleRunActive = false;
let testAborted  = false;
let seqIdx       = 0;
let seqTotal     = 0;

let radarHigh = false;
let radarOnline = false;
let radarPollTimer = null;
let radarFailCount = 0;
let radarSettingsState = null;
let radarSettingsServiceOnline = false;
let radarSettingsBusy = false;
let radarSettingsDirty = false;

let positionsRun  = 0;
let triggersSent  = 0;
let faultCount    = 0;

let lastMetrics = { pos: '---', moveDurationMs: null, latencyMs: null, seqDurationMs: null };

let chartSampleT0 = 0;
let phaseMarkers  = []; // { xSec, label: 'TRIGGER' }
let generatorPreview = [];
let generatorPreviewExcluded = [];
let generatorPreviewSafety = null;
const MAX_GENERATOR_POINTS = 2000;
let csvPreview = [];
let planPreviewRaf = null;
let currentObservations = [];
let currentRunId = '';
let currentRunDefinition = null;
let currentPreparedRun = null;
let pendingPreparedRun = null;
let spatialHitTargets = [];
let activeVisualization = 'spatial';
let activeSpatialLayer = 'outcome';
let observationFilterKey = 'all';
let campaignOperatorStatus = null;
let campaignFormMode = 'create';
let campaignAutoRunActive = false;
let campaignAutoRunStopRequested = false;
let pendingLogWrites = Promise.resolve();
let pendingLogWriteError = null;
let authoritativeRunState = null;
window.__radarAppDiagnostics = { radarPolls: 0 };
window.__operatorFlowDiagnostics = { transitions: 0, renders: 0, optionRebuilds: 0, maxRenderMs: 0 };

// ─── Chart ────────────────────────────────────────────────────────────────────
let chart;

/** Initializes the live Chart.js motion timeline. */
function initChart() {
  const ctx = document.getElementById('position-chart').getContext('2d');
  chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        { label: 'X', data: [], borderColor: '#00d4ff', backgroundColor: 'transparent', borderWidth: 2, pointRadius: 0, tension: 0.3, fill: false },
        { label: 'Y', data: [], borderColor: '#ffaa00', backgroundColor: 'transparent', borderWidth: 2, pointRadius: 0, tension: 0.3, fill: false },
        { label: 'Z', data: [], borderColor: '#9b6fff', backgroundColor: 'transparent', borderWidth: 2, pointRadius: 0, tension: 0.3, fill: false },
      ],
    },
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#0e1420',
          borderColor: '#2a3a55',
          borderWidth: 1,
          titleColor: '#7b8aa0',
          bodyColor: '#dde4f0',
          callbacks: {
            title: (items) => `t = ${Number(items[0].label).toFixed(2)}s`,
            label: (item) => ` ${item.dataset.label}: ${Number(item.raw).toFixed(2)} mm`,
          },
        },
      },
      scales: {
        x: {
          type: 'linear',
          title: { display: true, text: 'Time (s)', color: '#7b8aa0', font: { size: 10 } },
          ticks: { color: '#4a5a70', maxTicksLimit: 12, callback: (v) => v.toFixed(1) },
          grid: { color: 'rgba(255,255,255,0.04)' },
        },
        y: {
          title: { display: true, text: 'Position (mm)', color: '#7b8aa0', font: { size: 10 } },
          ticks: { color: '#4a5a70', maxTicksLimit: 8 },
          grid: { color: 'rgba(255,255,255,0.06)' },
        },
      },
    },
    plugins: [{
      id: 'triggerMarkers',
      beforeDraw(c) {
        if (!phaseMarkers.length) return;
        const { ctx: cx, scales: { x, y } } = c;
        cx.save();
        phaseMarkers.forEach((m) => {
          const xPx = x.getPixelForValue(m.xSec);
          cx.strokeStyle = 'rgba(0,232,123,0.6)';
          cx.lineWidth = 1;
          cx.setLineDash([4, 3]);
          cx.beginPath();
          cx.moveTo(xPx, y.top);
          cx.lineTo(xPx, y.bottom);
          cx.stroke();
        });
        cx.setLineDash([]);
        cx.restore();
      },
    }],
  });
}

/** Implements the clear chart operation for this module. */
function clearChart() {
  chart.data.labels = [];
  chart.data.datasets.forEach((d) => (d.data = []));
  phaseMarkers = [];
  chart.update('none');
}

// ─── Geometry and test definitions ───────────────────────────────────────────

/** Returns normalized radar geometry from the active configuration. */
function activeSensorLayout() {
  const modal = document.getElementById('config-modal');
  const pending = modal?.classList.contains('show')
    ? document.getElementById('cfg-sensor-layout')?.value : null;
  const layout = pending || config.validation?.sensorLayout;
  return ['ld021_pair', 'rcwl_pair'].includes(layout) ? layout : layout === 'dual' ? 'dual' : 'single';
}

/** Returns the saved service/input target without treating geometry as hardware identity. */
function activeRadarTarget() {
  if (config.validation?.sensorLayout === 'ld021_pair') return 'ld021_pair';
  if (config.validation?.sensorLayout === 'rcwl_pair') return 'rcwl_pair';
  if (config.validation?.sensorLayout === 'dual') {
    if (config.validation?.radarTarget === 'ld021_pair') return 'ld021_pair';
    return config.validation?.radarTarget === 'rcwl_dual' ? 'rcwl_dual' : 'dual';
  }
  if (config.validation?.radarTarget === 'rcwl_single') return 'rcwl_single';
  if (config.validation?.radarTarget === 'ld021') {
    return config.validation?.hilinkSensor === 'B' ? 'ld021_b' : 'ld021_a';
  }
  return 'single';
}

function isHilinkTarget(target = activeRadarTarget()) {
  return String(target).startsWith('ld021');
}

function isRcwlTarget(target = activeRadarTarget()) {
  return String(target).startsWith('rcwl_');
}

const RADAR_HARDWARE_OPTIONS = Object.freeze({
  single: Object.freeze([
    ['single', 'MS58 standalone'], ['rcwl_single', 'RCWL-0516 single'], ['ld021', 'HLK-LD021'],
  ]),
  dual: Object.freeze([
    ['dual', 'MoreSense dual'], ['rcwl_dual', 'RCWL-0516 dual'], ['ld021_pair', 'Two HLK-LD021 sensors — system-level DUT'],
  ]),
});

function updateRadarHardwareOptions(select, sensorLayout, preferredTarget) {
  if (!select || ['ld021_pair', 'rcwl_pair'].includes(sensorLayout)) return sensorLayout;
  const layout = sensorLayout === 'dual' ? 'dual' : 'single';
  const options = RADAR_HARDWARE_OPTIONS[layout];
  const target = options.some(([value]) => value === preferredTarget) ? preferredTarget : options[0][0];
  select.innerHTML = options.map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
  select.value = target;
  return target;
}

function hilinkChannel(target = activeRadarTarget()) {
  return target === 'ld021_b' ? 'LD021_B' : target === 'ld021_a' ? 'LD021_A' : target === 'ld021' ? 'LD021' : '';
}

function validationGeometry() {
  const dut = activeDutLocation();
  const dutGeometry = DutLocationCore.geometry(dut);
  const dutCenter = dutGeometry.center;
  const sensorLayout = activeSensorLayout();
  const geometry = {
    schemaVersion: Number(config.validation?.schemaVersion) || 2,
    // Layout is authoritative. A saved single-sensor semantics value must not
    // survive a switch to the in-field dual system and break zone generation.
    geometrySemantics: sensorLayout === 'dual'
      ? ValidationCore.GEOMETRY_SEMANTICS.DUAL_SYSTEM_BANDS
      : config.validation?.geometrySemantics,
    sensorLayout,
    systemReference: { x: dutCenter.x, y: dutCenter.y, confirmed: true },
    dut: {
      id: dut.id,
      name: dut.name,
      center: { ...dutCenter },
      bounds: { ...dutGeometry.bounds },
      widthMm: Number(dut.widthMm),
      depthMm: Number(dut.depthMm),
      frontY: Number(dut.frontY),
    },
    requiredTriggerMm: Number(config.validation?.systemLevel?.requiredTriggerMm) || ValidationCore.SYSTEM_REQUIRED_TRIGGER_MM,
    requiredNoTriggerMm: Number(config.validation?.systemLevel?.requiredNoTriggerMm) || ValidationCore.SYSTEM_REQUIRED_NO_TRIGGER_MM,
    radiusMm: sensorLayout === 'dual'
      ? Number(config.validation?.systemLevel?.requiredTriggerMm) || ValidationCore.SYSTEM_REQUIRED_TRIGGER_MM : undefined,
    guardBandMm: Math.max(0, Number(config.validation?.guardBandMm) || 0),
  };
  if (['ld021_pair', 'rcwl_pair'].includes(sensorLayout)) {
    const pair = sensorLayout === 'rcwl_pair' ? config.validation?.rcwlPair || {} : config.validation?.ld021Pair || {};
    geometry.sensorA = { ...(pair.sensorA || {}) };
    geometry.sensorB = { ...(pair.sensorB || {}) };
    geometry.geometrySemantics = `${sensorLayout.replace('_', '-')}-characterization`;
    return geometry;
  }
  if (sensorLayout === 'single') {
    // The location chosen for this test is authoritative. Do not let stale
    // Engineering singleSensor coordinates move the graph marker elsewhere.
    geometry.centerX = dutCenter.x;
    geometry.centerY = dutCenter.y;
    geometry.radiusMm = Number(config.validation?.singleSensor?.radiusMm) || 304.8;
  }
  return geometry;
}

function angularZoneSettings() {
  const enabled = config.validation?.angularZoneEnabled === true;
  const zone = Object.prototype.hasOwnProperty.call(ValidationCore.ANGULAR_ZONES, config.validation?.angularZone)
    ? config.validation.angularZone : 'front';
  return { enabled, zone, label: ValidationCore.ANGULAR_ZONES[zone].label };
}

function updateSystemLevelSummary() {
  const pass = Number(document.getElementById('cfg-system-pass-inches')?.value);
  const red = Number(document.getElementById('cfg-system-red-inches')?.value);
  const summary = document.getElementById('cfg-system-level-summary');
  if (!summary) return;
  summary.textContent = Number.isFinite(pass) && Number.isFinite(red) && pass > 0 && red > pass
    ? `Green: 0–${pass} in. Grey: ${pass}–${red} in. Red: beyond ${red} in.`
    : 'Green must be greater than 0, and the grey/red boundary must be greater than the green boundary.';
}

function activeDutLocation() {
  return dutLocationForLayout(activeSensorLayout());
}

/** True only when the selected single-sensor option is installed in a physical DUT. */
function hasDutFootprint(location = activeDutLocation()) {
  return Number(location?.widthMm) > 0 && Number(location?.depthMm) > 0;
}

/**
 * Supplies the display-only 12 in / 24 in footprint bands for a single sensor
 * installed in a DUT.  The active single-sensor validation semantics remain
 * untouched; this geometry is never used to score or generate test points.
 */
function dutReferenceBandGeometry(geometry = validationGeometry()) {
  if (ValidationCore.usesDualSystemBands(geometry)) return geometry;
  return {
    ...geometry,
    sensorLayout: 'dual',
    geometrySemantics: ValidationCore.GEOMETRY_SEMANTICS.DUAL_SYSTEM_BANDS,
  };
}

function reflectorClearanceMm() {
  const modal = document.getElementById('config-modal');
  const pending = document.getElementById('cfg-reflector-clearance-mm');
  if (modal?.classList.contains('show') && pending && Number.isFinite(Number(pending.value))) return Math.max(0, Number(pending.value));
  return Math.max(0, Number(config.dut?.reflectorClearanceMm) || 0);
}

function normalizedCoverageMode(value = config.validation?.coverageMode) {
  const mode = String(value || 'angular');
  if (mode === 'front-perimeter') return 'front';
  if (mode === 'front-side-flanks' || mode === 'full-perimeter') return 'full-dut';
  return ['angular', 'front', 'full-dut'].includes(mode) ? mode : 'angular';
}

function coverageSidesForMode(mode = normalizedCoverageMode()) {
  const normalized = normalizedCoverageMode(mode);
  return normalized === 'front' ? ['front'] : normalized === 'full-dut' ? ['front', 'left', 'right'] : [];
}

function motionKeepoutOptions() {
  return { bounds: fixtureXyBounds(), clearanceMm: 1, keepOutClearanceMm: reflectorClearanceMm(), allowRear: activeSensorLayout() !== 'dual' ? true : false };
}

function dutLocationForLayout(sensorLayout) {
  const locations = Array.isArray(config.dut?.locations) && config.dut.locations.length
    ? config.dut.locations : DutLocationCore.BUILT_IN_LOCATIONS;
  const modal = document.getElementById('config-modal');
  const selector = document.getElementById('cfg-dut-location');
  const selectedId = modal?.classList.contains('show') && selector?.value
    ? selector.value : config.dut?.activeLocationId;
  if (sensorLayout !== 'dual') {
    return [DutLocationCore.SINGLE_SENSOR_LOCATION, DutLocationCore.SINGLE_SENSOR_DUT_LOCATION, DutLocationCore.ORIGINAL_LOCATION, ...locations]
      .find((location) => location.id === selectedId
        && (location.id === DutLocationCore.SINGLE_SENSOR_DUT_LOCATION.id
          || location.id === DutLocationCore.ORIGINAL_LOCATION.id
          || (Number(location.widthMm) === 0 && Number(location.depthMm) === 0)))
      || DutLocationCore.SINGLE_SENSOR_LOCATION;
  }
  return locations.find((location) => location.id === selectedId)
    || locations[0] || DutLocationCore.DEFAULT_LOCATION;
}

function updateDutLocationControl(sensorLayout = config.validation?.sensorLayout) {
  const select = document.getElementById('cfg-dut-location');
  const summary = document.getElementById('cfg-dut-location-summary');
  if (!select || !summary) return;
  const locations = Array.isArray(config.dut?.locations) && config.dut.locations.length
    ? config.dut.locations : DutLocationCore.BUILT_IN_LOCATIONS;
  if (sensorLayout !== 'dual') {
    select.innerHTML = `<option value="${DutLocationCore.SINGLE_SENSOR_LOCATION.id}">${DutLocationCore.SINGLE_SENSOR_LOCATION.name}</option>`;
    select.value = DutLocationCore.SINGLE_SENSOR_LOCATION.id;
  } else {
    select.innerHTML = locations.map((location) => `<option value="${escapeHtml(location.id)}">${escapeHtml(location.name)}</option>`).join('');
    select.value = locations.some((location) => location.id === config.dut?.activeLocationId)
      ? config.dut.activeLocationId : DutLocationCore.DEFAULT_LOCATION.id;
  }
  select.disabled = sensorLayout !== 'dual';
  const location = sensorLayout === 'dual'
    ? locations.find((candidate) => candidate.id === select.value) || DutLocationCore.DEFAULT_LOCATION
    : DutLocationCore.SINGLE_SENSOR_LOCATION;
  const geometry = DutLocationCore.geometry(location);
  const keepOut = DutLocationCore.noGoBounds(location, reflectorClearanceMm());
  summary.textContent = sensorLayout === 'dual'
    ? `DUT center (${geometry.center.x}, ${geometry.center.y}); physical footprint X ${geometry.bounds.minX}–${geometry.bounds.maxX}, Y ${geometry.bounds.minY}–${geometry.bounds.maxY}. Reflector keep-out X ${keepOut.minX}–${keepOut.maxX}, Y ${keepOut.minY}–${keepOut.maxY}; rear motion is disabled.`
    : 'Stand-mounted single sensor at (875, 1200). No Aqua DUT rectangle is present.';
}

function dutNoGoBounds() {
  return DutLocationCore.geometry(activeDutLocation()).bounds;
}

function dutGraphCorners() {
  const bounds = dutNoGoBounds();
  return [
    { x: bounds.minX, y: bounds.minY }, { x: bounds.maxX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.maxY }, { x: bounds.minX, y: bounds.maxY },
  ];
}

function reflectorKeepoutBounds() {
  return DutLocationCore.noGoBounds(activeDutLocation(), reflectorClearanceMm());
}

function reflectorKeepoutGraphCorners() {
  if (activeSensorLayout() !== 'dual') return [];
  const bounds = reflectorKeepoutBounds();
  return [
    { x: bounds.minX, y: bounds.minY }, { x: bounds.maxX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.maxY }, { x: bounds.minX, y: bounds.maxY },
  ];
}

function drawReflectorKeepout(ctx, worldX, worldY) {
  if (activeSensorLayout() !== 'dual') return;
  const bounds = reflectorKeepoutBounds();
  const left = worldX(bounds.minX), right = worldX(bounds.maxX);
  const top = worldY(bounds.maxY), bottom = worldY(bounds.minY);
  ctx.save();
  ctx.fillStyle = 'rgba(255,64,92,.10)';
  ctx.strokeStyle = 'rgba(255,64,92,.85)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  ctx.fillRect(Math.min(left, right), Math.min(top, bottom), Math.abs(right-left), Math.abs(bottom-top));
  ctx.strokeRect(Math.min(left, right), Math.min(top, bottom), Math.abs(right-left), Math.abs(bottom-top));
  ctx.setLineDash([]);
  ctx.fillStyle = '#ff647c'; ctx.font = 'bold 9px Segoe UI, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  ctx.fillText('REFLECTOR KEEP-OUT', Math.min(left, right) + 4, Math.max(top, bottom) + 3);
  ctx.restore();
}

/** Returns a valid outer sampling offset for the selected geometry. */
function formalOuterDistanceMm(geometry = validationGeometry()) {
  const configured = Number(config.validation?.outsideRadiusMm);
  if (ValidationCore.usesDualSystemBands(geometry)) {
    return Math.max(762, Number.isFinite(configured) ? configured : 0);
  }
  return Math.max(geometry.radiusMm, configured || geometry.radiusMm * 1.5);
}

/** Draws the selected DUT at true XY scale, with its front edge and center identified. */
function drawDutFootprint(ctx, worldX, worldY, label = true, displayGeometry = validationGeometry()) {
  const location = activeDutLocation();
  const dutGeometry = DutLocationCore.geometry(location);
  const left = worldX(dutGeometry.bounds.minX), right = worldX(dutGeometry.bounds.maxX);
  const top = worldY(dutGeometry.bounds.maxY), bottom = worldY(dutGeometry.bounds.minY);
  const centerX = worldX(dutGeometry.center.x), centerY = worldY(dutGeometry.center.y);
  const hasDutFootprint = Number(location.widthMm) > 0 && Number(location.depthMm) > 0;
  ctx.save();
  if (!hasDutFootprint) {
    const sensorX = worldX(displayGeometry.centerX);
    const sensorY = worldY(displayGeometry.centerY);
    ctx.strokeStyle = '#f59e0b'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(sensorX-7,sensorY);ctx.lineTo(sensorX+7,sensorY);ctx.moveTo(sensorX,sensorY-7);ctx.lineTo(sensorX,sensorY+7);ctx.stroke();
    if (label) {
      ctx.fillStyle = '#fbbf24'; ctx.font = 'bold 10px Segoe UI, sans-serif';
      ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.fillText('SENSOR', sensorX+8, sensorY-4);
    }
    ctx.restore(); return;
  }
  ctx.fillStyle = 'rgba(245,158,11,.20)';
  ctx.strokeStyle = '#f59e0b';
  ctx.lineWidth = 2;
  ctx.fillRect(Math.min(left, right), Math.min(top, bottom), Math.abs(right-left), Math.abs(bottom-top));
  ctx.strokeRect(Math.min(left, right), Math.min(top, bottom), Math.abs(right-left), Math.abs(bottom-top));
  ctx.strokeStyle = '#22d3ee';
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(left, bottom); ctx.lineTo(right, bottom); ctx.stroke();
  ctx.strokeStyle = '#f8fafc';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(centerX-5,centerY);ctx.lineTo(centerX+5,centerY);ctx.moveTo(centerX,centerY-5);ctx.lineTo(centerX,centerY+5);ctx.stroke();
  if (label) {
    ctx.fillStyle = '#fbbf24'; ctx.font = 'bold 10px Segoe UI, sans-serif';
    ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillText('DUT', Math.min(left,right)+4, Math.min(top,bottom)-3);
  }
  ctx.restore();
}

/** Resolves the configured mode to a supported validation test identifier. */
function activeTestId() {
  const mode = currentPreparedRun?.plan?.testType || pendingPreparedRun?.plan?.testType || config.test?.mode || 'characterization';
  return ValidationCore.TEST_DEFINITIONS[mode] ? mode : 'sequence';
}

/** Returns the configured cycle count. */
function configuredCycleCount(testId = activeTestId()) {
  const configured = Number(config.test?.cyclesRequired);
  if (Number.isFinite(configured) && configured >= 1) return Math.floor(configured);
  return Math.max(1, Math.floor(ValidationCore.TEST_DEFINITIONS[testId]?.acceptance?.cyclesRequired || 1));
}

/** Returns the configured pass rate. */
function configuredPassRate(testId = activeTestId()) {
  const raw = config.test?.minimumCorrectRate;
  const configured = Number(raw);
  if (raw !== null && raw !== undefined && raw !== '' && Number.isFinite(configured)) return Math.min(1, Math.max(0, configured));
  if (testId === 'custom') {
    const legacy = Number(config.test?.customMinimumCorrectRate);
    if (Number.isFinite(legacy)) return Math.min(1, Math.max(0, legacy));
  }
  return Math.min(1, Math.max(0, Number(ValidationCore.TEST_DEFINITIONS[testId]?.acceptance?.minimumCorrectRate) || 0));
}

const FORMAL_SEQUENCE_NAMES = new Set(['Test 10.1 Inside Detection', 'Test 10.2 Outside Boundary']);

/** Defines which operator controls are meaningful for each test type. */
const TEST_UI_CAPABILITIES = Object.freeze({
  inside: { automaticPoints: true, footprint: false, planSource: false, passThreshold: true, builder: false },
  outside: { automaticPoints: true, footprint: false, planSource: false, passThreshold: true, builder: false },
  system: { automaticPoints: true, footprint: false, planSource: false, passThreshold: true, builder: false },
  characterization: { automaticPoints: true, footprint: true, planSource: false, passThreshold: false, builder: false },
  interference: { automaticPoints: true, footprint: true, planSource: false, passThreshold: false, builder: false },
  custom: { automaticPoints: false, footprint: false, planSource: true, passThreshold: true, builder: true },
  sequence: { automaticPoints: false, footprint: false, planSource: true, passThreshold: false, builder: true },
});

/** Returns UI capabilities for the selected test type. */
function activeTestCapabilities() {
  return TEST_UI_CAPABILITIES[activeTestId()] || TEST_UI_CAPABILITIES.sequence;
}

function activeRecipe() {
  return RecipeCore.find(config, config.recipes?.activeId);
}

function activePlanCatalog() {
  return config.testPlans?.schemaVersion
    ? RunWorkspaceCore.catalogFromCanonical(config.testPlans, RecipeCore.builtIns())
    : RunWorkspaceCore.catalogFromLegacy(config.recipes || {}, RecipeCore.builtIns());
}

/** Canonical saved plan. Runtime configuration is deliberately not folded back into it. */
function activeTestPlan() {
  return activePlanCatalog().find(config.recipes?.activeId) || TestPlanCore.fromLegacyRecipe(activeRecipe());
}

/** Current operator choices and explicit run-only overrides. */
function currentRunSetup() {
  const hardware = OperatorFlowCore.HARDWARE.find((item) => item.sensorLayout === config.validation?.sensorLayout
    && item.radarTarget === config.validation?.radarTarget
    && (!item.hilinkSensor || item.hilinkSensor === config.validation?.hilinkSensor));
  const plan = activeTestPlan();
  return RunWorkspaceCore.createDraft({
    layout: hardware?.layout || (config.validation?.sensorLayout === 'dual' ? 'dual' : 'single'),
    hardwareId: hardware?.id || '', locationId: config.dut?.activeLocationId || '',
    dutId: config.test?.dutId || '', planId: plan.id,
    overrides: {
      pointCount: Number(config.validation?.pointCount) === plan.rules.pointCount ? null : config.validation?.pointCount,
      cycles: Number(config.test?.cyclesRequired) === plan.rules.cycles ? null : config.test?.cyclesRequired,
      angularZone: config.validation?.angularZoneEnabled ? config.validation?.angularZone : 'all',
      minimumCorrectRate: config.test?.minimumCorrectRate === plan.rules.minimumCorrectRate ? null : config.test?.minimumCorrectRate,
    },
  });
}

function recipeOptionsHtml(selectedId = config.recipes?.activeId) {
  return RecipeCore.all(config).map((recipe) => `<option value="${escapeHtml(recipe.id)}"${recipe.id === selectedId ? ' selected' : ''}>${escapeHtml(recipe.name)}${recipe.builtIn ? ' (Built-in)' : ` v${recipe.version}`}</option>`).join('');
}

function populateCampaignTestPlanOptions(selectedId = document.getElementById('campaign-recipe-select')?.value || config.recipes?.activeId) {
  const select = document.getElementById('campaign-recipe-select');
  if (!select) return;
  const testType = document.getElementById('campaign-test-type')?.value;
  const plans = RecipeCore.all(config).filter((plan) => !testType || plan.family === testType);
  select.innerHTML = plans.map((plan) => `<option value="${escapeHtml(plan.id)}">${escapeHtml(plan.name)}${plan.builtIn ? ' (Built-in)' : ` v${plan.version}`}</option>`).join('');
  select.value = plans.some((plan) => plan.id === selectedId) ? selectedId : plans[0]?.id || '';
}

function populateRecipeSelectors() {
  ['quick-recipe-select', 'campaign-recipe-select'].forEach((id) => {
    const select = document.getElementById(id);
    if (!select) return;
    const selected = id === 'campaign-recipe-select' ? select.value || config.recipes?.activeId : config.recipes?.activeId;
    select.innerHTML = recipeOptionsHtml(selected);
    if (RecipeCore.all(config).some((recipe) => recipe.id === selected)) select.value = selected;
  });
  populateCampaignTestPlanOptions();
  const recipe = activeRecipe();
  const description = document.getElementById('quick-recipe-description');
  if (description) description.textContent = `${recipe.description || recipe.name} · ${recipe.pointCount} points · ${recipe.cycles} cycle${recipe.cycles === 1 ? '' : 's'}${recipe.scored ? ` · ${Number(recipe.minimumCorrectRate * 100).toFixed(1)}% required` : ' · observational'}`;
}

const engineeringPlanState = { selectedId: '', original: null, originalSignature: '', isNew: false, deletedIds: new Set() };

function engineeringPlanSignature(recipeInput) {
  const recipe = RecipeCore.normalize(recipeInput || {});
  return JSON.stringify({
    name: recipe.name, description: recipe.description, family: recipe.family, pointCount: recipe.pointCount, cycles: recipe.cycles,
    angularZones: recipe.angularZones, coverageMode: recipe.coverageMode, distribution: recipe.distribution,
    minimumCorrectRate: recipe.minimumCorrectRate, sequenceName: recipe.sequenceName,
    definitionReference: recipe.definitionReference, geometry: recipe.geometry,
    systemBounds: recipe.systemBounds, execution: recipe.execution, compatibility: recipe.compatibility,
  });
}

function populateEngineeringPlanSelect(selectedId = engineeringPlanState.selectedId || config.recipes?.activeId) {
  const select = document.getElementById('engineering-plan-select');
  if (!select) return;
  const plans = RecipeCore.all(config).filter((recipe) => !engineeringPlanState.deletedIds.has(recipe.id));
  select.innerHTML = plans.map((recipe) => `<option value="${escapeHtml(recipe.id)}">${escapeHtml(recipe.name)}${recipe.builtIn ? ' (Built-in)' : ` v${recipe.version}`}</option>`).join('');
  select.value = plans.some((recipe) => recipe.id === selectedId) ? selectedId : config.recipes?.activeId;
}

function setEngineeringPlanStatus(recipe, message = '') {
  const status = document.getElementById('engineering-plan-status');
  if (!status) return;
  status.textContent = message || (recipe?.builtIn
    ? 'Built-in plan. Change its rules and enter a new name to save a custom plan.'
    : `Custom plan v${recipe?.version || 1}. Save Test Plan creates the next version and publishes it to Run a Test.`);
  renderEngineeringPlanEditorState(recipe);
}

function renderEngineeringPlanEditorState(recipe = engineeringPlanState.original) {
  const mode = document.getElementById('engineering-plan-mode');
  const meta = document.getElementById('engineering-plan-meta');
  if (!mode || !meta) return;
  if (engineeringPlanState.isNew) {
    mode.textContent = 'Creating New Test Plan';
    meta.textContent = 'Choose the test type first, then define the reusable procedure and save it as a new plan.';
  } else if (recipe?.builtIn) {
    mode.textContent = `Viewing Built-in Test Plan: ${recipe.name}`;
    meta.textContent = 'Built-in plans are protected. Use Duplicate and Edit, or enter a custom name before saving changed rules.';
  } else {
    mode.textContent = `Editing Test Plan: ${recipe?.name || 'Custom plan'}`;
    meta.textContent = `Custom plan v${recipe?.version || 1}. Saving creates the next traceable version.`;
  }
}

function loadEngineeringPlan(recipeId) {
  const recipe = RecipeCore.find(config, recipeId);
  if (!recipe) return;
  config = RecipeCore.apply(config, recipe);
  config.test = { ...(config.test || {}), definitionFile: recipe.definitionReference || '' };
  engineeringPlanState.selectedId = recipe.id;
  engineeringPlanState.original = RecipeCore.snapshot(recipe);
  engineeringPlanState.isNew = false;
  populateConfigForm();
  populateEngineeringPlanSelect(recipe.id);
  document.getElementById('engineering-plan-name').value = recipe.builtIn ? `${recipe.name} Custom` : recipe.name;
  document.getElementById('engineering-plan-description').value = recipe.description || '';
  engineeringPlanState.originalSignature = engineeringPlanSignature(engineeringRecipeFromConfig());
  setEngineeringPlanStatus(recipe);
  scheduleEngineeringPlanPreview();
}

function engineeringRecipeFromConfig() {
  const base = engineeringPlanState.original || activeRecipe();
  const name = document.getElementById('engineering-plan-name').value.trim();
  const description = document.getElementById('engineering-plan-description').value.trim();
  const family = config.test?.mode || base.family;
  const distribution = config.validation?.pointDistribution || base.distribution;
  const hardware = OperatorFlowCore.HARDWARE.find((item) => item.sensorLayout === config.validation?.sensorLayout
    && item.radarTarget === config.validation?.radarTarget && (!item.hilinkSensor || item.hilinkSensor === config.validation?.hilinkSensor));
  return RecipeCore.normalize({
    ...base,
    id: engineeringPlanState.isNew || base.builtIn ? `recipe-${String(name || 'new-test-plan').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}` : base.id,
    name, description, builtIn: false, family, pointCount: config.validation?.pointCount,
    cycles: config.test?.cyclesRequired, angularZones: config.validation?.angularZoneEnabled ? [config.validation.angularZone || 'front'] : ['all'],
    coverageMode: config.validation?.coverageMode, distribution,
    minimumCorrectRate: config.test?.minimumCorrectRate,
    sequenceName: ['custom', 'sequence'].includes(family) || ['manual', 'imported'].includes(distribution) ? config.activeSequence : '',
    definitionReference: config.test?.definitionFile || '',
    geometry: { ...(base.geometry || {}), sensorLayout: config.validation?.sensorLayout, radarTarget: config.validation?.radarTarget,
      hilinkSensor: config.validation?.hilinkSensor, dutLocationId: config.dut?.activeLocationId,
      characterizationBounds: config.validation?.characterizationBounds, reflectorClearanceMm: config.dut?.reflectorClearanceMm },
    systemBounds: config.validation?.systemLevel,
    execution: { ...(base.execution || {}), holdMs: config.trigger?.holdMsDefault },
    compatibility: hardware ? { hardwareIds: [hardware.id], sensorLayouts: [hardware.sensorLayout] } : base.compatibility,
  });
}

function saveEngineeringPlanIfChanged() {
  if (engineeringPlanState.deletedIds.size) {
    config.recipes = { ...(config.recipes || {}), custom: (config.recipes?.custom || []).filter((recipe) => !engineeringPlanState.deletedIds.has(recipe.id)) };
  }
  const base = engineeringPlanState.original || activeRecipe();
  const candidate = engineeringRecipeFromConfig();
  const changed = engineeringPlanState.isNew || engineeringPlanState.originalSignature !== engineeringPlanSignature(candidate);
  if (!changed) {
    config.recipes = { ...(config.recipes || {}), activeId: base.id };
    return base;
  }
  if (!candidate.name.trim()) throw new Error('Enter a test plan name before saving the Test Plan');
  if (base.builtIn && !engineeringPlanState.isNew && candidate.name === base.name) throw new Error('Built-in plans are protected. Enter a new test plan name for these changed rules.');
  if ((base.builtIn || engineeringPlanState.isNew) && RecipeCore.all(config).some((recipe) => recipe.id === candidate.id || recipe.name.toLocaleLowerCase() === candidate.name.toLocaleLowerCase())) {
    throw new Error('A test plan with that name already exists');
  }
  config = RecipeCore.saveCustom(config, candidate);
  const saved = RecipeCore.find(config, config.recipes.activeId);
  engineeringPlanState.selectedId = saved.id;
  engineeringPlanState.original = RecipeCore.snapshot(saved);
  engineeringPlanState.originalSignature = engineeringPlanSignature(saved);
  engineeringPlanState.isNew = false;
  return saved;
}

function populateRecipeBuilder(recipeInput = activeRecipe(), copy = false) {
  const recipe = RecipeCore.normalize(recipeInput || {});
  document.getElementById('recipe-name-input').value = copy ? `${recipe.name} Copy` : recipe.builtIn ? `${recipe.name} Custom` : recipe.name;
  document.getElementById('recipe-description-input').value = recipe.description;
  document.getElementById('recipe-family-select').value = recipe.family;
  document.getElementById('recipe-point-count-input').value = recipe.pointCount;
  document.getElementById('recipe-distribution-select').value = recipe.distribution;
  document.getElementById('recipe-cycles-input').value = recipe.cycles;
  document.getElementById('recipe-pass-rate-input').value = recipe.scored ? Number((recipe.minimumCorrectRate * 100).toFixed(1)) : 95;
  document.getElementById('recipe-green-bound-input').value = Number((recipe.systemBounds.requiredTriggerMm / 25.4).toFixed(3));
  document.getElementById('recipe-red-bound-input').value = Number((recipe.systemBounds.requiredNoTriggerMm / 25.4).toFixed(3));
  document.querySelectorAll('#recipe-angular-zone-options input').forEach((input) => { input.checked = recipe.angularZones.includes(input.value); });
  document.getElementById('recipe-coverage-mode').value = recipe.coverageMode;
  document.getElementById('recipe-pass-rate-row').hidden = !recipe.scored;
  document.getElementById('recipe-builder-status').textContent = recipe.builtIn
    ? 'Built-in recipes are protected. Save creates an editable custom recipe.'
    : `Editing ${recipe.name} v${recipe.version}. Saving creates the next reusable version.`;
}

function recipeFromBuilder() {
  const family = document.getElementById('recipe-family-select').value;
  const selectedZones = [...document.querySelectorAll('#recipe-angular-zone-options input:checked')].map((input) => input.value);
  return RecipeCore.normalize({
    id: `recipe-${String(document.getElementById('recipe-name-input').value || 'custom').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`,
    name: document.getElementById('recipe-name-input').value,
    description: document.getElementById('recipe-description-input').value,
    family,
    pointCount: Number(document.getElementById('recipe-point-count-input').value),
    distribution: document.getElementById('recipe-distribution-select').value,
    coverageMode: document.getElementById('recipe-coverage-mode').value,
    cycles: Number(document.getElementById('recipe-cycles-input').value),
    angularZones: selectedZones,
    minimumCorrectRate: Number(document.getElementById('recipe-pass-rate-input').value) / 100,
    sequenceName: ['custom', 'sequence'].includes(family) ? config.activeSequence : '',
    geometry: {
      sensorLayout: config.validation?.sensorLayout,
      radarTarget: config.validation?.radarTarget,
      hilinkSensor: config.validation?.hilinkSensor,
      dutLocationId: config.dut?.activeLocationId,
      characterizationBounds: config.validation?.characterizationBounds,
      reflectorClearanceMm: config.dut?.reflectorClearanceMm,
    },
    systemBounds: {
      requiredTriggerMm: Number(document.getElementById('recipe-green-bound-input').value) * 25.4,
      requiredNoTriggerMm: Number(document.getElementById('recipe-red-bound-input').value) * 25.4,
    },
    execution: { holdMs: config.trigger?.holdMsDefault || 3500 },
  });
}

async function applyRecipeForSingleRun(recipeId) {
  const recipe = RecipeCore.find(config, recipeId);
  if (!recipe) return false;
  const previousMode = activeTestId();
  if (!['inside', 'outside', 'system'].includes(previousMode) && ['inside', 'outside', 'system'].includes(recipe.family)) rememberBuilderPlanBeforeFormalMode();
  config = RecipeCore.apply(config, recipe);
  document.getElementById('quick-test-mode').value = recipe.family;
  if (['inside', 'outside'].includes(recipe.family)) await regenerateFormalPlanFromOperator();
  else if (recipe.family === 'system') await regenerateSystemValidationPlan();
  else if (['characterization', 'interference'].includes(recipe.family)) {
    restoreBuilderPlanForNonFormalMode();
    await regenerateCharacterizationPlanFromOperator();
  } else {
    restoreBuilderPlanForNonFormalMode();
    await radarAPI.configSet(config);
    updateSeqProgress();
    renderSpatialResults();
  }
  populateRecipeSelectors();
  updateQuickRunPanel(`Loaded recipe: ${recipe.name}`);
  return true;
}

/** Remembers builder plan before formal mode. */
function rememberBuilderPlanBeforeFormalMode() {
  if (config.activeSequence && !FORMAL_SEQUENCE_NAMES.has(config.activeSequence)) {
    config.test = { ...(config.test || {}), lastBuilderSequence: config.activeSequence };
  }
}

/** Restores builder plan for non formal mode. */
function restoreBuilderPlanForNonFormalMode() {
  if (!FORMAL_SEQUENCE_NAMES.has(config.activeSequence)) return;
  const remembered = config.test?.lastBuilderSequence;
  const available = Object.keys(config.sequences || {}).filter((name) => !FORMAL_SEQUENCE_NAMES.has(name));
  if (remembered && config.sequences?.[remembered]) config.activeSequence = remembered;
  else if (available.length) config.activeSequence = available[0];
  else {
    const name = 'Custom Test 1';
    config.sequences[name] = [{ x: 0, y: 0, z: 0, holdMs: config.trigger.holdMsDefault }];
    config.activeSequence = name;
  }
}

/** Builds the active test definition with operator acceptance overrides. */
function activeDefinition() {
  const testId = activeTestId();
  const base = ValidationCore.TEST_DEFINITIONS[testId];
  if (!base?.acceptance) return base;
  return {
    ...base,
    acceptance: {
      ...base.acceptance,
      minimumCorrectRate: configuredPassRate(testId),
      cyclesRequired: configuredCycleCount(testId),
    },
  };
}

/** Resets validation run. */
function resetValidationRun() {
  currentObservations = [];
  currentRunId = `run_${new Date().toISOString().replace(/[:.]/g, '-')}`;
  currentRunDefinition = activeDefinition();
  currentPreparedRun = null;
  updateValidationDashboard();
  updateObservationFilterOptions();
  renderSpatialResults();
}

/** Creates traceability metadata for the run that is about to start. */
function buildRunManifest(plannedPositions = []) {
  const configuration = JSON.parse(JSON.stringify(config));
  if (configuration.radarService) {
    configuration.radarService.apiToken = configuration.radarService.apiToken ? '[configured; value not logged]' : '';
  }
  return {
    runId: currentRunId,
    recipe: RecipeCore.snapshot(activeRecipe()),
    testPlan: currentPreparedRun?.plan || activeTestPlan(),
    runSetup: currentPreparedRun?.setup || currentRunSetup(),
    preparedRun: currentPreparedRun,
    testDefinition: currentRunDefinition,
    dutId: config.test?.dutId || '',
    firstCycleNumber: config.test?.cycleNumber || 1,
    cyclesPlanned: currentPreparedRun?.acceptanceRules?.cyclesRequired || configuredCycleCount(),
    definitionFile: config.test?.definitionFile || '',
    geometry: currentPreparedRun?.resolvedGeometry || validationGeometry(),
    fixtureBounds: fixtureXyBounds(),
    characterizationBounds: config.validation?.characterizationBounds || null,
    activeSequence: config.activeSequence,
    plannedPositions,
    qualificationBasis: validationGeometry().sensorLayout === 'dual' ? 'Combined dual-sensor system output (A_OR_B)' : 'Individual sensor output',
    radarSettings: RadarSettingsCore.traceabilitySnapshot(radarSettingsState),
    measurementRule: config.validation?.sensorLayout === 'single'
      ? 'TRIGGERED when the configured single-radar detection input is HIGH'
      : 'TRIGGERED when either configured dual-radar detection input is HIGH',
    configuration,
  };
}

/** Normalizes, stores, logs, and displays one radar observation. */
function recordObservation(index, point, actualDetected, latencyMs, moveDurationMs, extra = {}) {
  const radarSensors = extra.radarSensors || {};
  const radarTarget = extra.activeRadarTarget || activeRadarTarget();
  const singleChannel = radarTarget === 'single' ? 'SINGLE' : hilinkChannel(radarTarget);
  const pairA = radarTarget === 'ld021_pair' ? radarSensors.LD021_A?.detected
    : radarTarget === 'rcwl_pair' ? radarSensors.RCWL_A?.detected : radarSensors.A?.detected;
  const pairB = radarTarget === 'ld021_pair' ? radarSensors.LD021_B?.detected
    : radarTarget === 'rcwl_pair' ? radarSensors.RCWL_B?.detected : radarSensors.B?.detected;
  const observation = ValidationCore.createObservation({
    runId: currentRunId,
    testId: activeTestId(),
    testVersion: currentRunDefinition?.version || 1,
    dutId: config.test?.dutId || '',
    cycleNumber: extra.cycleNumber || config.test?.cycleNumber || 1,
    pointId: point.pointId || index,
    positionIndex: index,
    attemptNumber: extra.attemptNumber || 1,
    x: point.x, y: point.y, z: point.z,
    expectedDetected: point.expectedDetected,
    actualDetected,
    radarAActualDetected: typeof (radarSensors.RCWL_A?.detected ?? radarSensors.A?.detected) === 'boolean' ? (radarSensors.RCWL_A?.detected ?? radarSensors.A.detected) : null,
    radarBActualDetected: typeof (radarSensors.RCWL_B?.detected ?? radarSensors.B?.detected) === 'boolean' ? (radarSensors.RCWL_B?.detected ?? radarSensors.B.detected) : null,
    singleRadarActualDetected: typeof radarSensors[singleChannel]?.detected === 'boolean'
      ? radarSensors[singleChannel].detected : null,
    ld021AActualDetected: typeof radarSensors.LD021_A?.detected === 'boolean' ? radarSensors.LD021_A.detected : null,
    ld021BActualDetected: typeof radarSensors.LD021_B?.detected === 'boolean' ? radarSensors.LD021_B.detected : null,
    triggeredSensors: ValidationCore.triggeredSensorLabel(pairA, pairB),
    ld021ARisingEdgeMs: extra.ld021ARisingEdgeMs,
    ld021AFallingEdgeMs: extra.ld021AFallingEdgeMs,
    ld021BRisingEdgeMs: extra.ld021BRisingEdgeMs,
    ld021BFallingEdgeMs: extra.ld021BFallingEdgeMs,
    testPhase: extra.testPhase || (activeTestId() === 'interference' ? 'both-powered moving-reflector' : ''),
    powerAState: extra.powerAState,
    powerBState: extra.powerBState,
    activeRadarTarget: radarTarget,
    combinedDetectionRule: radarTarget === 'ld021_pair' ? 'LD021_A_OR_B (characterization only)' : radarTarget === 'rcwl_pair' ? 'RCWL_A_OR_B (characterization only)' : isHilinkTarget(radarTarget) ? hilinkChannel(radarTarget) : radarTarget === 'single' ? 'SINGLE' : 'A_OR_B',
    detectionLatencyMs: latencyMs,
    moveDurationMs,
    valid: extra.valid !== false,
    invalidReason: extra.invalidReason || '',
    notes: extra.notes || '',
    geometry: validationGeometry(),
  });
  currentObservations.push(observation);
  queueLogWrite({ event: 'OBSERVATION', ...observation });
  updateValidationDashboard();
  updateObservationFilterOptions();
  renderSpatialResults();
  return observation;
}

function queueLogWrite(row) {
  pendingLogWrites = pendingLogWrites.then(async () => {
    const result = await radarAPI.logWrite(row);
    if (!result?.success) throw new Error(result?.error || 'Observation log write was not acknowledged');
  }).catch((error) => {
    pendingLogWriteError = error instanceof Error ? error : new Error(String(error));
  });
  return pendingLogWrites;
}

async function flushLogWrites() {
  await pendingLogWrites;
  if (pendingLogWriteError) throw pendingLogWriteError;
}

async function logWritesReady() {
  try {
    await flushLogWrites();
    return true;
  } catch (error) {
    await finishSequence('fail', `Observation logging failed: ${error?.message || error}`);
    return false;
  }
}

/** Returns the current summary. */
function currentSummary() {
  return ValidationCore.summarize(currentObservations, currentRunDefinition);
}

/** Implements the observation key operation for this module. */
function observationKey(observation) {
  return `${observation.runId || 'unknown'}::${observation.cycleNumber || 1}`;
}

/** Returns visible observations. */
function visibleObservations() {
  return observationFilterKey === 'all' ? currentObservations : currentObservations.filter((o) => observationKey(o) === observationFilterKey);
}

/** Returns one majority result per physical point for the current run. */
function currentPointAggregates() {
  return ValidationCore.aggregateByPoint(currentObservations, configuredCycleCount());
}

/** Uses point majorities for all-cycle views and raw observations for one cycle. */
function visibleSpatialObservations() {
  if (observationFilterKey !== 'all') return visibleObservations();
  return currentPointAggregates().map((aggregate) => ({
    ...aggregate,
    actualDetected: aggregate.majority === 'TRIGGERED' ? true : aggregate.majority === 'NOT_TRIGGERED' ? false : null,
    detectionLatencyMs: aggregate.medianLatencyMs,
    valid: aggregate.majority !== 'INVALID',
    aggregated: true,
  }));
}

/** Updates observation filter options. */
function updateObservationFilterOptions() {
  const select = document.getElementById('viz-run-filter');
  if (!select) return;
  const keys = [...new Set(currentObservations.map(observationKey))];
  const previous = observationFilterKey;
  select.innerHTML = '<option value="all">All runs / cycles</option>';
  keys.forEach((key) => {
    const [runId, cycle] = key.split('::');
    const option = document.createElement('option');
    option.value = key;
    option.textContent = `${runId} / cycle ${cycle}`;
    select.appendChild(option);
  });
  observationFilterKey = keys.includes(previous) ? previous : 'all';
  select.value = observationFilterKey;
}

/** Updates validation dashboard. */
function updateValidationDashboard() {
  const observations = visibleObservations();
  const summary = ValidationCore.summarize(observations, currentRunDefinition);
  const set = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
  const setItem = (id, label, visible = true) => {
    const value = document.getElementById(id);
    if (!value) return;
    const item = value.closest('.outcome-item');
    item.style.display = visible ? '' : 'none';
    const caption = item.querySelector('small');
    if (caption) caption.textContent = label;
  };
  const characterization = ['characterization', 'interference'].includes(activeTestId());
  if (characterization) {
    const effective = ValidationCore.effectiveObservations(observations);
    const triggered = effective.filter((observation) => observation.valid !== false && observation.actualDetected === true).length;
    const notTriggered = effective.filter((observation) => observation.valid !== false && observation.actualDetected === false).length;
    setItem('cnt-tp', 'Triggered');
    setItem('cnt-fn', 'Not Triggered');
    setItem('cnt-invalid', 'Invalid');
    setItem('cnt-tn', 'True Negative', false);
    setItem('cnt-fp', 'False Positive', false);
    setItem('cnt-rate', 'Correct', false);
    set('cnt-tp', triggered);
    set('cnt-fn', notTriggered);
    set('cnt-invalid', summary.counts.INVALID);
    return;
  }
  setItem('cnt-tp', 'True Positive');
  setItem('cnt-tn', 'True Negative');
  setItem('cnt-fn', 'False Negative');
  setItem('cnt-fp', 'False Positive');
  setItem('cnt-invalid', 'Invalid');
  setItem('cnt-rate', 'Correct');
  set('cnt-tp', summary.counts.TP);
  set('cnt-tn', summary.counts.TN);
  set('cnt-fp', summary.counts.FP);
  set('cnt-fn', summary.counts.FN);
  set('cnt-invalid', summary.counts.INVALID);
  set('cnt-rate', summary.correctRate === null ? '—' : `${summary.correct}/${summary.assessed} (${(summary.correctRate * 100).toFixed(1)}%)`);
}

/** Draws outcome marker. */
function drawOutcomeMarker(ctx, x, y, outcome, radius = 5) {
  const colors = { TP: '#00e87b', TN: '#55b7ff', FP: '#ff9f43', FN: '#ff405c', MIXED: '#ffd166', INVALID: '#69788f', UNASSESSED: '#d5dbe7' };
  ctx.save();
  ctx.strokeStyle = colors[outcome] || colors.UNASSESSED;
  ctx.fillStyle = colors[outcome] || colors.UNASSESSED;
  ctx.lineWidth = 2;
  if (outcome === 'FN') {
    ctx.beginPath(); ctx.moveTo(x-radius,y-radius); ctx.lineTo(x+radius,y+radius); ctx.moveTo(x+radius,y-radius); ctx.lineTo(x-radius,y+radius); ctx.stroke();
  } else if (outcome === 'FP') {
    ctx.beginPath(); ctx.moveTo(x,y-radius-1); ctx.lineTo(x+radius+1,y); ctx.lineTo(x,y+radius+1); ctx.lineTo(x-radius-1,y); ctx.closePath(); ctx.fill();
  } else if (outcome === 'TN') {
    ctx.fillRect(x-radius, y-radius, radius*2, radius*2);
  } else if (outcome === 'INVALID' || outcome === 'MIXED') {
    ctx.beginPath(); ctx.moveTo(x,y-radius-1); ctx.lineTo(x+radius+1,y+radius); ctx.lineTo(x-radius-1,y+radius); ctx.closePath(); ctx.fill();
  } else {
    ctx.beginPath(); ctx.arc(x,y,radius,0,Math.PI*2); ctx.fill();
  }
  ctx.restore();
}

/** Draws planned positions and measured outcomes on the live spatial canvas. */
function renderSpatialResults() {
  const canvas = document.getElementById('spatial-results-canvas');
  if (!canvas || !config) return;
  const rect = canvas.getBoundingClientRect();
  if (rect.width < 20 || rect.height < 20) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const width = rect.width, height = rect.height;
  ctx.clearRect(0, 0, width, height);

  const planned = config.sequences?.[config.activeSequence] || [];
  const visible = visibleSpatialObservations();
  const geometry = validationGeometry();
  const characterizationView = ['characterization', 'interference'].includes(activeTestId())
    || (visible.length > 0 && visible.every((observation) => ['characterization', 'interference'].includes(observation.testId)));
  const interferenceView = activeTestId() === 'interference'
    || (visible.length > 0 && visible.every((observation) => observation.testId === 'interference'));
  const title = document.getElementById('viz-title');
  if (title && activeVisualization !== 'motion') title.textContent = characterizationView
    ? (activeSpatialLayer === 'latency' ? 'Raw Trigger Latency — Characterization' : 'Radar Trigger Map — Yes / No')
    : (activeSpatialLayer === 'latency' ? 'Raw Detection Latency — No Interpolation' : 'Raw Spatial Results — Current Run');
  const legend = document.getElementById('spatial-legend');
  if (legend) legend.innerHTML = (characterizationView
    ? '<div class="legend-item"><div class="legend-dot" style="background:#00e87b"></div><span>Majority triggered</span></div><div class="legend-item"><div class="legend-dot square" style="background:#ff405c"></div><span>Majority not triggered</span></div><div class="legend-item"><div class="legend-dot" style="background:#ffd166"></div><span>Tie / mixed</span></div><div class="legend-item"><div class="legend-dot" style="background:#69788f"></div><span>Invalid</span></div>'
    : '<div class="legend-item"><div class="legend-dot" style="background:#00e87b"></div><span>TP</span></div><div class="legend-item"><div class="legend-dot square" style="background:#55b7ff"></div><span>TN</span></div><div class="legend-item"><div class="legend-dot" style="background:#ff405c"></div><span>FN</span></div><div class="legend-item"><div class="legend-dot diamond" style="background:#ff9f43"></div><span>FP</span></div><div class="legend-item"><div class="legend-dot" style="background:#69788f"></div><span>Invalid</span></div>')
    + (hasDutFootprint()
      ? '<div class="legend-item"><div class="legend-dot square" style="background:#f59e0b"></div><span>DUT footprint; cyan edge is front</span></div>'
      : `<div class="legend-item"><div class="legend-dot" style="background:#f59e0b"></div><span>Stand-mounted sensor at ${geometry.centerX}, ${geometry.centerY}</span></div>`);
  const systemBands = ValidationCore.usesDualSystemBands(geometry);
  const displayDutBands = systemBands || (geometry.sensorLayout === 'single' && hasDutFootprint());
  const bandGeometry = displayDutBands ? dutReferenceBandGeometry(geometry) : geometry;
  if (legend && displayDutBands) legend.innerHTML += '<div class="legend-item"><div class="legend-dot" style="background:#00d4ff"></div><span>12 in. DUT-edge reference</span></div><div class="legend-item"><div class="legend-dot square" style="background:#9ba5b4"></div><span>24 in. DUT-edge reference</span></div>';
  const isOutsidePlan = planned.some((p) => p.zone === 'outside');
  const displayRadius = isOutsidePlan ? formalOuterDistanceMm(geometry) : geometry.radiusMm;
  const displayAdjustment = displayRadius - geometry.radiusMm;
  // Interference characterization is observation-only. The two HLK sensors'
  // configured headings are fixture references, not estimated activation
  // zones, so do not draw or frame the graph around a blue lobe overlay.
  const showEstimatedActivationZone = !interferenceView && (!characterizationView || displayDutBands);
  const displayBoundary = showEstimatedActivationZone
    ? ValidationCore.activationZoneBoundaries(bandGeometry, displayAdjustment).flat() : [];
  const framedBoundary = displayDutBands ? displayBoundary.filter((point) => point.y <= dutNoGoBounds().maxY) : displayBoundary;
  const characterizationBands = characterizationView && displayDutBands
    ? ValidationCore.activationZoneBoundaries(bandGeometry).flat().filter((point) => point.y <= dutNoGoBounds().maxY) : [];
  const sensorMarker = geometry.sensorLayout === 'single' ? [{ x: geometry.centerX, y: geometry.centerY }] : [];
  if (activeSensorLayout() !== 'dual') {
    if (geometry.sensorLayout === 'dual') sensorMarker.push({ x: geometry.centerX, y: geometry.centerY });
  }
  const values = [...planned, ...currentObservations, ...dutGraphCorners(), ...framedBoundary, ...characterizationBands, ...sensorMarker]
    .filter((p) => Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)));
  if (!values.length) return;
  let minX = Math.min(...values.map((p) => Number(p.x))), maxX = Math.max(...values.map((p) => Number(p.x)));
  let minY = Math.min(...values.map((p) => Number(p.y))), maxY = Math.max(...values.map((p) => Number(p.y)));
  const padX = Math.max(20, (maxX-minX)*0.08), padY = Math.max(20, (maxY-minY)*0.08);
  const forwardViewExtensionMm = 175;
  minX -= padX + forwardViewExtensionMm;
  maxX += padX + forwardViewExtensionMm;
  minY -= padY + forwardViewExtensionMm;
  maxY += padY;
  const margin = { l: 48, r: 18, t: 16, b: 34 };
  const scale = Math.min((width-margin.l-margin.r)/(maxX-minX || 1), (height-margin.t-margin.b)/(maxY-minY || 1));
  const px = (x) => margin.l + (x-minX)*scale;
  const py = (y) => height-margin.b - (y-minY)*scale;

  ctx.strokeStyle = 'rgba(255,255,255,.07)'; ctx.fillStyle = '#637089'; ctx.font = '10px sans-serif'; ctx.lineWidth = 1;
  for (let i=0;i<=5;i++) {
    const x=minX+(maxX-minX)*i/5, y=minY+(maxY-minY)*i/5;
    ctx.beginPath(); ctx.moveTo(px(x),margin.t); ctx.lineTo(px(x),height-margin.b); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(margin.l,py(y)); ctx.lineTo(width-margin.r,py(y)); ctx.stroke();
    ctx.fillText(x.toFixed(0),px(x)-10,height-12); ctx.fillText(y.toFixed(0),5,py(y)+3);
  }

  const drawLobe = (extent, color, dash, fill = '') => {
    ValidationCore.activationZoneBoundaries(bandGeometry, extent-bandGeometry.radiusMm).forEach((boundary) => {
      ctx.save(); ctx.strokeStyle=color; ctx.setLineDash(dash); ctx.lineWidth=1.5;
      if (displayDutBands) {
        ctx.beginPath(); ctx.rect(margin.l, py(dutNoGoBounds().maxY), width-margin.l-margin.r, height-margin.b-py(dutNoGoBounds().maxY)); ctx.clip();
      }
      ctx.beginPath(); boundary.forEach((point,index) => { if (!index) ctx.moveTo(px(point.x),py(point.y)); else ctx.lineTo(px(point.x),py(point.y)); }); ctx.closePath();
      if (fill) { ctx.fillStyle=fill; ctx.fill(); } ctx.stroke();
      ctx.restore();
    });
  };
  if (showEstimatedActivationZone) drawLobe(bandGeometry.radiusMm, 'rgba(0,212,255,.9)', [], 'rgba(0,212,255,.035)');
  if (displayDutBands) {
    drawLobe(bandGeometry.requiredNoTriggerMm,'rgba(155,165,180,.65)',[5,4]);
  } else if (!characterizationView && activeTestId() === 'outside' && geometry.guardBandMm) {
    drawLobe(geometry.radiusMm+geometry.guardBandMm,'rgba(255,170,0,.45)',[4,4]);
  }
  if (!characterizationView && isOutsidePlan) drawLobe(displayRadius,'rgba(155,111,255,.65)',[7,4]);
  drawDutFootprint(ctx, px, py);

  const completed = new Set(visible.map((o) => String(o.pointId)));
  ctx.fillStyle='rgba(160,174,195,.35)';
  planned.forEach((p,i) => { if (!completed.has(String(p.pointId || i+1))) { ctx.beginPath();ctx.arc(px(p.x),py(p.y),2.5,0,Math.PI*2);ctx.fill(); } });
  spatialHitTargets = [];
  const duplicates = new Map();
  visible.forEach((o) => {
    const key=`${o.x}|${o.y}`; const n=duplicates.get(key)||0; duplicates.set(key,n+1);
    const angle=n*2.39996, offset=n ? Math.min(9,2+n*1.2) : 0;
    const sx=px(o.x)+Math.cos(angle)*offset, sy=py(o.y)+Math.sin(angle)*offset;
    const markerOutcome = characterizationView ? (o.valid === false ? 'INVALID' : o.majority === 'TIE' ? 'MIXED' : o.actualDetected ? 'TP' : 'FN') : o.outcome;
    drawOutcomeMarker(ctx,sx,sy,markerOutcome,5);
    if (o.aggregated && !o.complete) { ctx.save();ctx.strokeStyle='#ffd166';ctx.lineWidth=1.5;ctx.beginPath();ctx.arc(sx,sy,8,0,Math.PI*2);ctx.stroke();ctx.restore(); }
    if (activeSpatialLayer === 'latency') {
      ctx.save(); ctx.font='bold 9px sans-serif'; ctx.fillStyle=o.actualDetected ? '#f2f5fa' : '#ff7083';
      ctx.fillText(o.actualDetected && o.detectionLatencyMs !== null ? `${o.detectionLatencyMs} ms` : 'MISS', sx+7, sy-6); ctx.restore();
    }
    spatialHitTargets.push({x:sx,y:sy,o});
  });
}

// ─── Visualization controls ──────────────────────────────────────────────────

/** Attaches UI event handlers for visualization. */
function wireVisualization() {
  const spatial = document.getElementById('spatial-results-canvas');
  const motion = document.getElementById('position-chart');
  const spatialBtn = document.getElementById('viz-spatial-btn');
  const latencyBtn = document.getElementById('viz-latency-btn');
  const motionBtn = document.getElementById('viz-motion-btn');
  const title = document.getElementById('viz-title');
  const setMode = (mode) => {
    activeVisualization = mode;
    spatial.classList.toggle('viz-hidden', mode === 'motion');
    motion.classList.toggle('viz-hidden', mode !== 'motion');
    spatialBtn.classList.toggle('active', mode === 'spatial');
    latencyBtn.classList.toggle('active', mode === 'latency');
    motionBtn.classList.toggle('active', mode === 'motion');
    title.textContent = mode === 'spatial' ? 'Raw Spatial Results — Current Run' : mode === 'latency' ? 'Raw Detection Latency — No Interpolation' : 'Position vs. Time — Current Sequence';
    activeSpatialLayer = mode === 'latency' ? 'latency' : 'outcome';
    if (mode !== 'motion') renderSpatialResults(); else chart.resize();
  };
  spatialBtn.addEventListener('click', () => setMode('spatial'));
  latencyBtn.addEventListener('click', () => setMode('latency'));
  motionBtn.addEventListener('click', () => setMode('motion'));
  spatial.addEventListener('mousemove', (ev) => {
    const rect=spatial.getBoundingClientRect(), x=ev.clientX-rect.left, y=ev.clientY-rect.top;
    const hit=spatialHitTargets.find((h)=>Math.hypot(h.x-x,h.y-y)<=9);
    const tip=document.getElementById('spatial-tooltip');
    if (!hit) { tip.style.display='none'; return; }
    const o=hit.o;
    const characterization = ['characterization', 'interference'].includes(o.testId)
      || ['characterization', 'interference'].includes(activeTestId());
    tip.innerHTML=characterization
      ? `<b>Radar Triggered: ${o.valid === false ? 'INVALID' : o.actualDetected ? 'YES' : 'NO'}</b> · point ${escapeHtml(o.pointId)}<br>X ${o.x} · Y ${o.y}${o.testId === 'interference' ? `<br>Sensor output: ${escapeHtml(o.triggeredSensors || 'Unknown')}` : ''}<br>Latency ${o.detectionLatencyMs ?? '—'} ms · Cycle ${o.cycleNumber}`
      : `<b>${escapeHtml(o.outcome)}</b> · point ${escapeHtml(o.pointId)}<br>X ${o.x} · Y ${o.y} · distance ${o.distanceMm ?? '—'} mm<br>Expected ${o.expectedDetected === null ? 'unscored' : o.expectedDetected ? 'DETECT' : 'NO DETECT'} · Actual ${o.actualDetected ? 'DETECT' : 'NO DETECT'}<br>Latency ${o.detectionLatencyMs ?? '—'} ms · Cycle ${o.cycleNumber}`;
    if (o.aggregated) {
      const rate = o.triggerRate === null ? '—' : `${(o.triggerRate * 100).toFixed(1)}%`;
      tip.innerHTML = characterization
        ? `<b>${escapeHtml(o.majority)}</b> · point ${escapeHtml(o.pointId)}<br>X ${o.x} · Y ${o.y}<br>Triggered ${o.triggeredCount}/${o.validCount} (${rate}) · ${o.invalidCount} invalid<br>Median triggered latency ${o.medianLatencyMs ?? '—'} ms`
        : `<b>${escapeHtml(o.outcome)}</b> · point ${escapeHtml(o.pointId)}<br>X ${o.x} · Y ${o.y} · distance ${o.distanceMm ?? '—'} mm<br>Majority ${escapeHtml(o.majority)} · triggered ${o.triggeredCount}/${o.validCount} (${rate})<br>${o.invalidCount} invalid · median triggered latency ${o.medianLatencyMs ?? '—'} ms`;
    }
    tip.style.left=`${Math.min(rect.width-270,x+12)}px`; tip.style.top=`${Math.max(4,y-55)}px`; tip.style.display='block';
  });
  spatial.addEventListener('mouseleave',()=>{document.getElementById('spatial-tooltip').style.display='none';});
  document.getElementById('viz-run-filter').addEventListener('change', (ev) => {
    observationFilterKey = ev.target.value;
    updateValidationDashboard();
    renderSpatialResults();
  });
}

/** Implements the push chart sample operation for this module. */
function pushChartSample() {
  const sec = (Date.now() - chartSampleT0) / 1000;
  chart.data.labels.push(sec);
  chart.data.datasets[0].data.push(position.x);
  chart.data.datasets[1].data.push(position.y);
  chart.data.datasets[2].data.push(position.z);
  chart.update('none');
  return sec;
}

// ─── Log Panel ────────────────────────────────────────────────────────────────
/** Implements the log event operation for this module. */
function logEvent(msg, type = 'info') {
  const out  = document.getElementById('log-output');
  const now  = new Date();
  const time = now.toTimeString().slice(0, 8) + '.' + String(now.getMilliseconds()).padStart(3, '0');
  const el   = document.createElement('div');
  el.className = 'log-entry';
  el.innerHTML = `<span class="log-time">${time}</span><span class="log-msg ${type}">${escapeHtml(msg)}</span>`;
  out.appendChild(el);
  out.scrollTop = out.scrollHeight;
}

/** Escapes html. */
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── Radar settings ──────────────────────────────────────────────────────────
/** Returns a run-blocking explanation when verified active-radar settings are required. */
function radarSettingsBlockingIssue() {
  if (!config?.radarService?.requireVerifiedSettings) return '';
  if (!radarSettingsServiceOnline) return 'Radar settings service is offline';
  const expectedTarget = activeRadarTarget();
  if (radarSettingsState?.activeTarget !== expectedTarget) return `Re-read settings for the ${expectedTarget} radar target`;
  if (!RadarSettingsCore.verifiedPair(radarSettingsState)) return radarSettingsState?.error || 'Active radar target settings are not verified';
  if (radarSettingsDirty) return 'Radar settings have unapplied changes';
  return '';
}

/** Updates the operator card from the last independently read sensor states. */
function renderRadarSettings() {
  const gain = document.getElementById('radar-gain-select');
  const threshold = document.getElementById('radar-threshold-input');
  const outputTime = document.getElementById('radar-output-time-input');
  const experimental = document.getElementById('radar-ld021-experimental');
  const refresh = document.getElementById('radar-settings-refresh');
  const apply = document.getElementById('radar-settings-apply');
  const save = document.getElementById('radar-settings-save');
  const badge = document.getElementById('radar-settings-badge');
  const message = document.getElementById('radar-settings-message');
  if (!gain) return;
  const sensorA = radarSettingsState?.sensors?.A;
  const sensorB = radarSettingsState?.sensors?.B;
  const sensorSingle = radarSettingsState?.sensors?.SINGLE;
  const sensorLD021 = radarSettingsState?.sensors?.LD021;
  const sensorLD021A = radarSettingsState?.sensors?.LD021_A;
  const sensorLD021B = radarSettingsState?.sensors?.LD021_B;
  const sensorRcwlSingle = radarSettingsState?.sensors?.RCWL_SINGLE;
  const sensorRcwlA = radarSettingsState?.sensors?.RCWL_A;
  const sensorRcwlB = radarSettingsState?.sensors?.RCWL_B;
  const activeTarget = activeRadarTarget();
  const activeSensor = activeTarget === 'ld021_pair' ? sensorLD021A : activeTarget === 'ld021_a' ? sensorLD021A : activeTarget === 'ld021_b' ? sensorLD021B : activeTarget === 'ld021' ? sensorLD021 : activeTarget === 'single' ? sensorSingle : activeTarget === 'rcwl_single' ? sensorRcwlSingle : ['rcwl_dual', 'rcwl_pair'].includes(activeTarget) ? sensorRcwlA : sensorA;
  const ld021 = isHilinkTarget(activeTarget);
  const rcwl = isRcwlTarget(activeTarget);
  const verified = radarSettingsState?.activeTarget === activeTarget && RadarSettingsCore.verifiedPair(radarSettingsState);
  const dualTarget = activeTarget === 'dual';
  setDot('radar-a-settings-dot', dualTarget && sensorA?.online ? 'connected' : dualTarget && radarSettingsServiceOnline ? 'error' : '');
  setDot('radar-b-settings-dot', dualTarget && sensorB?.online ? 'connected' : dualTarget && radarSettingsServiceOnline ? 'error' : '');
  setDot('radar-single-settings-dot', activeTarget === 'single' && sensorSingle?.online ? 'connected' : activeTarget === 'single' && radarSettingsServiceOnline ? 'error' : '');
  setDot('radar-ld021-settings-dot', ld021 && sensorLD021?.online ? 'connected' : ld021 && radarSettingsServiceOnline ? 'error' : '');
  setDot('radar-ld021-a-settings-dot', ['ld021_a', 'ld021_pair'].includes(activeTarget) && sensorLD021A?.online ? 'connected' : ['ld021_a', 'ld021_pair'].includes(activeTarget) && radarSettingsServiceOnline ? 'error' : '');
  setDot('radar-ld021-b-settings-dot', ['ld021_b', 'ld021_pair'].includes(activeTarget) && sensorLD021B?.online ? 'connected' : ['ld021_b', 'ld021_pair'].includes(activeTarget) && radarSettingsServiceOnline ? 'error' : '');
  setDot('radar-rcwl-single-settings-dot', activeTarget === 'rcwl_single' && sensorRcwlSingle?.online ? 'connected' : activeTarget === 'rcwl_single' && radarSettingsServiceOnline ? 'error' : '');
  setDot('radar-rcwl-a-settings-dot', ['rcwl_dual', 'rcwl_pair'].includes(activeTarget) && sensorRcwlA?.online ? 'connected' : ['rcwl_dual', 'rcwl_pair'].includes(activeTarget) && radarSettingsServiceOnline ? 'error' : '');
  setDot('radar-rcwl-b-settings-dot', ['rcwl_dual', 'rcwl_pair'].includes(activeTarget) && sensorRcwlB?.online ? 'connected' : ['rcwl_dual', 'rcwl_pair'].includes(activeTarget) && radarSettingsServiceOnline ? 'error' : '');
  const radarAStatus = document.getElementById('radar-a-settings-status');
  const radarBStatus = document.getElementById('radar-b-settings-status');
  const radarSingleStatus = document.getElementById('radar-single-settings-status');
  const radarLD021Status = document.getElementById('radar-ld021-settings-status');
  const radarLD021AStatus = document.getElementById('radar-ld021-a-settings-status');
  const radarLD021BStatus = document.getElementById('radar-ld021-b-settings-status');
  const radarRcwlSingleStatus = document.getElementById('radar-rcwl-single-settings-status');
  const radarRcwlAStatus = document.getElementById('radar-rcwl-a-settings-status');
  const radarRcwlBStatus = document.getElementById('radar-rcwl-b-settings-status');
  if (radarAStatus) radarAStatus.hidden = !dualTarget;
  if (radarBStatus) radarBStatus.hidden = !dualTarget;
  if (radarSingleStatus) radarSingleStatus.hidden = activeTarget !== 'single';
  if (radarLD021Status) radarLD021Status.hidden = activeTarget !== 'ld021';
  if (radarLD021AStatus) radarLD021AStatus.hidden = !['ld021_a', 'ld021_pair'].includes(activeTarget);
  if (radarLD021BStatus) radarLD021BStatus.hidden = !['ld021_b', 'ld021_pair'].includes(activeTarget);
  if (radarRcwlSingleStatus) radarRcwlSingleStatus.hidden = activeTarget !== 'rcwl_single';
  if (radarRcwlAStatus) radarRcwlAStatus.hidden = !['rcwl_dual', 'rcwl_pair'].includes(activeTarget);
  if (radarRcwlBStatus) radarRcwlBStatus.hidden = !['rcwl_dual', 'rcwl_pair'].includes(activeTarget);
  if (verified && activeSensor && !radarSettingsDirty
      && document.activeElement !== gain && document.activeElement !== threshold && document.activeElement !== outputTime) {
    if (!ld021) gain.value = String(activeSensor.gainCode);
    threshold.value = String(activeSensor.threshold);
    if (ld021) outputTime.value = String(activeSensor.outputTimeMs);
  }
  const editable = connected && radarSettingsServiceOnline && !radarSettingsBusy && !testRunning && !rcwl;
  document.getElementById('radar-gain-row').hidden = ld021 || rcwl;
  document.getElementById('radar-threshold-row').hidden = rcwl;
  document.getElementById('radar-threshold-label').textContent = ld021 ? 'Sensitivity threshold' : 'Threshold';
  threshold.min = String(ld021 ? RadarSettingsCore.LD021_MIN_THRESHOLD : RadarSettingsCore.MIN_SAFE_THRESHOLD);
  threshold.max = String(ld021 ? RadarSettingsCore.LD021_MAX_THRESHOLD : RadarSettingsCore.MAX_SAFE_THRESHOLD);
  gain.disabled = !editable || ld021;
  threshold.disabled = !editable || rcwl;
  experimental.hidden = !ld021;
  outputTime.disabled = !editable || !ld021;
  refresh.disabled = !connected || radarSettingsBusy || testRunning;
  apply.disabled = !editable || !radarSettingsDirty;
  apply.textContent = rcwl ? 'Not configurable' : ld021 ? 'Apply & Save' : 'Apply Temporary';
  save.disabled = rcwl || !editable || !verified || radarSettingsDirty || ld021;
  save.textContent = rcwl ? 'No settings to save' : ld021 ? 'Saved on Apply' : dualTarget ? 'Save to Both' : 'Save to Device';
  badge.className = `settings-badge ${radarSettingsBusy || radarSettingsDirty ? 'dirty' : verified ? 'verified' : radarSettingsServiceOnline ? 'error' : 'offline'}`;
  badge.textContent = radarSettingsBusy ? 'Working' : radarSettingsDirty ? 'Not applied' : verified ? (rcwl ? 'Ready' : radarSettingsState.persistent ? 'Saved' : 'Verified') : radarSettingsServiceOnline ? 'Mismatch' : 'Offline';
  const targetLabel = ['rcwl_dual', 'rcwl_pair'].includes(activeTarget) ? 'both RCWL-0516 sensors' : activeTarget === 'rcwl_single' ? 'the RCWL-0516 sensor' : dualTarget ? 'both radars' : activeTarget === 'ld021_pair' ? 'both HLK-LD021 sensors' : activeTarget === 'ld021_a' ? 'HLK-LD021 Sensor A' : activeTarget === 'ld021_b' ? 'HLK-LD021 Sensor B' : ld021 ? 'the HLK-LD021' : 'the MS58 single radar';
  message.textContent = radarSettingsBusy ? `Communicating with ${targetLabel}…`
    : radarSettingsDirty ? `Values are staged only. Apply Temporary verifies ${targetLabel} before tests can run.`
      : verified ? rcwl
        ? `${['rcwl_dual', 'rcwl_pair'].includes(activeTarget) ? 'Both RCWL-0516 detection inputs are' : 'RCWL-0516 detection input is'} online. This hardware has no programmable gain or threshold.`
        : ld021
        ? activeTarget === 'ld021_pair'
          ? `LD021_A and LD021_B verified: shared sensitivity threshold ${activeSensor.threshold}, HIGH time ${activeSensor.outputTimeMs} ms; module IDs ${sensorLD021A?.moduleId ?? 'unknown'} / ${sensorLD021B?.moduleId ?? 'unknown'}; saved to device memory.`
          : `HLK-LD021 ${activeTarget === 'ld021_b' ? 'Sensor B' : 'Sensor A'} verified: sensitivity threshold ${activeSensor.threshold}, output delay ${activeSensor.outputTimeMs} ms${radarSettingsState.persistent ? ', saved to device memory' : ''}.`
        : `${dualTarget ? 'Both radars' : 'Single radar'} verified: gain ${RadarSettingsCore.formatGainCode(activeSensor.gainCode)}, threshold ${activeSensor.threshold}${radarSettingsState.persistent ? ', saved to device memory' : ', volatile'}.`
        : radarSettingsState?.error || (connected ? 'Radar settings service is unavailable.' : `Connect to the fixture to read ${targetLabel}.`);
  document.getElementById('radar-settings-direction').textContent = rcwl
    ? 'RCWL-0516 range is fixed by the module and installation; characterize each hardware lot.'
    : ld021
    ? `Lower threshold increases expected range. LD021 protocol range: ${RadarSettingsCore.LD021_MIN_THRESHOLD}–${RadarSettingsCore.LD021_MAX_THRESHOLD}.`
    : `Lower gain code and lower threshold increase expected range. Safe threshold: ${RadarSettingsCore.MIN_SAFE_THRESHOLD}–${RadarSettingsCore.MAX_SAFE_THRESHOLD}.`;
  setStartEnabled();
}

/** Queries the active radar target and keeps device read-back as the source of truth. */
async function refreshRadarSettings(logResult = false) {
  if (!connected || radarSettingsBusy) return false;
  radarSettingsBusy = true;
  renderRadarSettings();
  const result = await radarAPI.readRadarSettings();
  radarSettingsBusy = false;
  radarSettingsState = result;
  radarSettingsServiceOnline = !!result?.sensors;
  radarSettingsDirty = false;
  renderRadarSettings();
  updateQuickRunPanel();
  const expectedTarget = activeRadarTarget();
  const resultVerified = result?.activeTarget === expectedTarget && RadarSettingsCore.verifiedPair(result);
  if (logResult) logEvent(resultVerified
    ? `${isRcwlTarget(expectedTarget) ? `RCWL-0516 ${expectedTarget === 'rcwl_dual' ? 'dual inputs' : 'input'}` : isHilinkTarget(expectedTarget) ? `HLK-LD021${expectedTarget === 'ld021_pair' ? '' : ` Sensor ${expectedTarget === 'ld021_b' ? 'B' : 'A'}`} threshold` : expectedTarget === 'single' ? 'MS58 single radar gain and threshold' : 'Radar A/B gain and threshold'} read-back verified`
    : `Radar settings verification failed: ${result?.error || 'service unavailable'}`, resultVerified ? 'info' : 'error');
  return resultVerified;
}

/** Applies one campaign condition to the active radar target and verifies read-back. */
async function applyAndVerifyRadarSettings(gainCode, threshold) {
  if (!connected) return { success: false, error: 'Fixture is disconnected' };
  if (!radarSettingsServiceOnline && !(await refreshRadarSettings(false))) {
    return { success: false, error: radarSettingsState?.error || 'Radar settings service is offline' };
  }
  try {
    const protocolProfile = isHilinkTarget() ? RadarSettingsCore.LD021_PROTOCOL_PROFILE : 'moresense-hci-v2';
    const ld021 = protocolProfile === RadarSettingsCore.LD021_PROTOCOL_PROFILE;
    const normalizedGain = ld021 ? null : RadarSettingsCore.normalizeGainCode(gainCode);
    const normalizedThreshold = RadarSettingsCore.normalizeThreshold(threshold, protocolProfile);
    radarSettingsBusy = true;
    renderRadarSettings();
    let result = await radarAPI.applyRadarSettings(normalizedGain, normalizedThreshold, protocolProfile);
    const expectedTarget = activeRadarTarget();
    const matchesRequestedSettings = (payload) => {
      const sensors = payload?.sensors || {};
      const activeChannels = payload?.activeChannels || (expectedTarget === 'ld021_pair' ? ['LD021_A', 'LD021_B'] : expectedTarget === 'ld021_a' ? ['LD021_A'] : expectedTarget === 'ld021_b' ? ['LD021_B'] : expectedTarget === 'ld021' ? ['LD021'] : expectedTarget === 'single' ? ['SINGLE'] : ['A', 'B']);
      return payload?.activeTarget === expectedTarget && RadarSettingsCore.verifiedPair(payload)
        && activeChannels.every((channel) => (ld021 || Number(sensors[channel]?.gainCode) === normalizedGain)
          && Number(sensors[channel]?.threshold) === normalizedThreshold);
    };
    // LD021 may commit the setting but miss the immediate software-UART query.
    // Retry independent read-back after a short quiet period; never authorize
    // fixture movement unless a fresh response contains the requested value.
    if (ld021 && !matchesRequestedSettings(result)) {
      for (const delayMs of [250, 500, 750]) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        result = await radarAPI.readRadarSettings();
        if (matchesRequestedSettings(result)) break;
      }
    }
    radarSettingsState = result;
    radarSettingsServiceOnline = !!result?.sensors;
    radarSettingsDirty = !matchesRequestedSettings(result);
    return matchesRequestedSettings(result)
      ? { success: true }
      : { success: false, error: result?.error || 'Active radar target read-back did not match the campaign condition' };
  } catch (error) {
    return { success: false, error: String(error?.message || error) };
  } finally {
    radarSettingsBusy = false;
    renderRadarSettings();
    updateQuickRunPanel();
  }
}

/** Wires staged Apply, verified Save, and explicit re-read behavior. */
function wireRadarSettings() {
  const gain = document.getElementById('radar-gain-select');
  const threshold = document.getElementById('radar-threshold-input');
  const outputTime = document.getElementById('radar-output-time-input');
  const stage = () => { radarSettingsDirty = true; renderRadarSettings(); updateQuickRunPanel(); };
  gain.addEventListener('change', stage);
  threshold.addEventListener('input', stage);
  outputTime.addEventListener('input', stage);
  document.getElementById('radar-settings-refresh').addEventListener('click', () => refreshRadarSettings(true));
  document.getElementById('radar-settings-apply').addEventListener('click', async () => {
    try {
      const protocolProfile = radarSettingsState?.protocolProfile || 'moresense-hci-v2';
      const ld021 = protocolProfile === RadarSettingsCore.LD021_PROTOCOL_PROFILE;
      const gainCode = ld021 ? null : RadarSettingsCore.normalizeGainCode(gain.value);
      const value = RadarSettingsCore.normalizeThreshold(threshold.value, protocolProfile);
      const outputTimeMs = ld021 ? RadarSettingsCore.normalizeLd021OutputTimeMs(outputTime.value) : null;
      radarSettingsBusy = true;
      renderRadarSettings();
      const result = await radarAPI.applyRadarSettings(gainCode, value, protocolProfile, outputTimeMs);
      radarSettingsBusy = false;
      radarSettingsState = result;
      radarSettingsServiceOnline = !!result?.sensors;
      radarSettingsDirty = !RadarSettingsCore.verifiedPair(result);
      renderRadarSettings();
      updateQuickRunPanel();
      logEvent(RadarSettingsCore.verifiedPair(result)
        ? ld021 ? `Applied and verified HLK-LD021 sensitivity threshold ${value}, HIGH time ${outputTimeMs} ms; saved to device memory`
          : `Applied temporary radar settings to ${config.validation?.sensorLayout === 'single' ? 'single radar' : 'A/B'}: gain ${RadarSettingsCore.formatGainCode(gainCode)}, threshold ${value}`
        : `Radar settings apply failed: ${result?.error || 'read-back did not verify'}`, RadarSettingsCore.verifiedPair(result) ? 'info' : 'error');
    } catch (error) {
      radarSettingsBusy = false;
      renderRadarSettings();
      logEvent(`Radar settings blocked: ${error.message}`, 'error');
    }
  });
  document.getElementById('radar-settings-save').addEventListener('click', async () => {
    radarSettingsBusy = true;
    renderRadarSettings();
    const result = await radarAPI.saveRadarSettings();
    radarSettingsBusy = false;
    radarSettingsState = result;
    radarSettingsServiceOnline = !!result?.sensors;
    radarSettingsDirty = false;
    renderRadarSettings();
    updateQuickRunPanel();
    logEvent(result?.success && result?.persistent
      ? `Verified radar settings saved to ${config.validation?.sensorLayout === 'single' ? 'single device' : 'both devices'}`
      : `Radar settings save failed: ${result?.error || 'persistence not verified'}`, result?.success && result?.persistent ? 'info' : 'error');
  });
  renderRadarSettings();
}

// ─── UI helpers ───────────────────────────────────────────────────────────────
/** Sets dot. */
function setDot(id, cls) {
  const el = document.getElementById(id);
  if (el) el.className = 'status-dot ' + (cls || '');
}

/** Implements the clamp operation for this module. */
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

/** Calculates visual range. */
function axisVisualRange(axis) {
  const m = config.motion[axis];
  const min = m.minMm <= -9000 ? 0 : m.minMm; // -9999 in the source doc is a placeholder, not a real limit
  const max = Math.max(m.maxMm, min + 1);
  return { min, max };
}

/** Implements the motion enabled operation for this module. */
function motionEnabled() {
  return connected && klippyState === 'ready';
}

function commissioningBlockingIssue() {
  if (config.motion?.commissioned !== true) return 'Fixture motion settings are not commissioned';
  for (const axis of ['x', 'y']) {
    const settings = config.motion?.[axis] || {};
    if (!Number.isFinite(Number(settings.minMm)) || Number(settings.minMm) <= -9000
        || !Number.isFinite(Number(settings.maxMm)) || Number(settings.minMm) >= Number(settings.maxMm)) {
      return `${axis.toUpperCase()} travel limits are not commissioned`;
    }
    if (!Number.isFinite(Number(settings.speedMmS)) || Number(settings.speedMmS) <= 0) return `${axis.toUpperCase()} speed is invalid`;
    if (!Number.isFinite(Number(settings.accelMmS2)) || Number(settings.accelMmS2) <= 0) return `${axis.toUpperCase()} acceleration is invalid`;
  }
  return '';
}

/** Returns validation issues for the active scored plan. */
function planValidationIssues(points = []) {
  const testId = activeTestId();
  if (!['inside', 'outside', 'system', 'custom'].includes(testId)) return [];
  return ValidationCore.validatePlan(testId, optimizedExecutionPoints(points), validationGeometry());
}

function formatPlanIssue(issue) {
  const message = String(issue?.message || issue?.code || 'Unknown plan issue');
  return issue?.pointId ? `${issue.pointId}: ${message}` : message;
}

function movementBoundsIssue(points = []) {
  const bounds = config.validation?.characterizationBounds || {};
  if (![bounds.minX, bounds.maxX, bounds.minY, bounds.maxY].every((value) => Number.isFinite(Number(value)))) return 'The Test Plan requires finite X and Y movement bounds';
  if (!(Number(bounds.minX) < Number(bounds.maxX)) || !(Number(bounds.minY) < Number(bounds.maxY))) return 'The Test Plan movement minimums must be smaller than maximums';
  const outside = points.find((point) => Number(point.x) < Number(bounds.minX) || Number(point.x) > Number(bounds.maxX)
    || Number(point.y) < Number(bounds.minY) || Number(point.y) > Number(bounds.maxY));
  return outside ? `Position X${outside.x} Y${outside.y} is outside Test Plan movement bounds X ${bounds.minX}–${bounds.maxX}, Y ${bounds.minY}–${bounds.maxY} mm` : '';
}

/** Returns the current plan blocking issue. */
function currentPlanBlockingIssue() {
  if (!config) return '';
  const commissioningIssue = commissioningBlockingIssue();
  if (commissioningIssue) return commissioningIssue;
  const settingsIssue = radarSettingsBlockingIssue();
  if (settingsIssue) return settingsIssue;
  const testId = activeTestId();
  const sourcePoints = config.sequences?.[config.activeSequence] || [];
  const points = optimizedExecutionPoints(sourcePoints);
  const scoredMode = ['inside', 'outside', 'system', 'custom'].includes(testId);
  if (!points.length) return 'The selected test plan has no positions';
  const boundsIssue = movementBoundsIssue(points);
  if (boundsIssue) return boundsIssue;
  if (['inside', 'outside'].includes(testId)) {
    const expectedName = testId === 'inside' ? 'Test 10.1 Inside Detection' : 'Test 10.2 Outside Boundary';
    if (config.activeSequence !== expectedName || points.length !== Math.max(1, Math.floor(Number(config.validation?.pointCount) || 100))) {
      return 'The automatic formal plan must be regenerated before running';
    }
  }
  if (!config.logging?.enabled) return 'Enable raw CSV logging in Settings before running a test';
  if (scoredMode) {
    const issues = planValidationIssues(points);
    if (issues.length) {
      const examples = issues.slice(0, 3).map(formatPlanIssue).join(' | ');
      return `${issues.length} plan issue(s) must be corrected before running. ${examples}${issues.length > 3 ? ' | See Plan issues below.' : ''}`;
    }
  }
  const motionSafety = evaluateMotionPlan(points);
  const motionIssue = motionSafety.pointIssues[0] || motionSafety.routeIssues[0];
  if (motionIssue) return motionIssue.message;
  return '';
}

/** Returns the authoritative readiness result used to gate the Run button. */
function testPreflight(points = config.sequences?.[config.activeSequence] || []) {
  const blocker = currentPlanBlockingIssue();
  const checks = [
    { ok: !repeatedSingleRunActive || testRunning, label: 'Repeated single-test sequence is preparing the next run', blocking: true },
    { ok: motionEnabled(), label: motionEnabled() ? 'Fixture connected and Klipper ready' : 'Connect fixture and wait for Klipper ready', blocking: true },
    { ok: !commissioningBlockingIssue(), label: commissioningBlockingIssue() || 'Fixture motion settings commissioned', blocking: true },
    { ok: !radarSettingsBlockingIssue(), label: radarSettingsBlockingIssue() || 'Radar settings verified', blocking: true },
    { ok: points.length > 0, label: points.length ? `${points.length} planned points` : 'No planned points', blocking: true },
    { ok: !blocker, label: blocker || 'Plan, logging, limits, and motion timeout valid', blocking: true },
  ];
  const firstBlocking = checks.find((check) => check.blocking && !check.ok);
  return { ready: !firstBlocking, reason: firstBlocking?.label || '', checks };
}

/** Renders a concise readiness checklist for the selected test. */
function renderPreflightChecklist(points, blocker) {
  const host = document.getElementById('quick-preflight-checklist');
  if (!host) return;
  const cycles = configuredCycleCount();
  const scoringIssues = planValidationIssues(points);
  const motionSafety = evaluateMotionPlan(points);
  const planIssues = [...scoringIssues, ...motionSafety.pointIssues, ...motionSafety.routeIssues];
  const planCheckLabel = planIssues.length
    ? `Plan validation failed: ${planIssues.length} issue(s) — see details below`
    : blocker || 'Plan, logging, limits, and motion timeout valid';
  const checks = [
    { ok: motionEnabled(), label: motionEnabled() ? 'Fixture connected and Klipper ready' : 'Connect fixture and wait for Klipper ready', blocking: true },
    { ok: !commissioningBlockingIssue(), label: commissioningBlockingIssue() || 'Fixture motion settings commissioned', blocking: true },
    { ok: !radarSettingsBlockingIssue(), label: radarSettingsBlockingIssue() || (isRcwlTarget()
      ? `${activeRadarTarget() === 'rcwl_dual' ? 'Both RCWL-0516 inputs are' : 'RCWL-0516 input is'} online`
      : `${config.validation?.sensorLayout === 'single' ? 'Single radar' : 'Radar A/B'} gain and threshold are verified`), blocking: true },
    { ok: points.length > 0, label: points.length ? `${points.length} planned points` : 'No planned points', blocking: true },
    { ok: !blocker, label: planCheckLabel, blocking: true },
    { ok: cycles % 2 === 1, label: cycles % 2 === 1 ? `${cycles} cycles gives an unambiguous majority` : `${cycles} cycles can tie; an odd count is recommended`, blocking: false },
  ];
  const issueDetails = planIssues.length
    ? `<div class="preflight-issues" role="alert"><strong>Plan issues (${planIssues.length})</strong><ol>${planIssues.map((issue) => `<li>${escapeHtml(formatPlanIssue(issue))}</li>`).join('')}</ol></div>`
    : '';
  host.innerHTML = checks.map((check) => `<div class="preflight-item ${check.ok ? 'ok' : check.blocking ? 'blocked' : 'warning'}"><span>${check.ok ? '✓' : check.blocking ? '✕' : '⚠'}</span><span>${escapeHtml(check.label)}</span></div>`).join('') + issueDetails;
}

/** Sets start enabled. */
function setStartEnabled() {
  const btn = document.getElementById('start-btn');
  if (testRunning) return; // handled by setStartBtn('running')
  const preflight = testPreflight();
  btn.disabled = !preflight.ready;
  btn.title = preflight.reason || 'Run the selected test';
  btn.setAttribute('aria-label', preflight.reason ? `Run unavailable: ${preflight.reason}` : 'Run the selected test');
}

// ─── Position / status rendering ─────────────────────────────────────────────
/** Updates position ui. */
function updatePositionUI() {
  document.getElementById('pos-x').textContent = position.x.toFixed(2);
  document.getElementById('pos-y').textContent = position.y.toFixed(2);
  document.getElementById('pos-z').textContent = position.z.toFixed(2);
  document.getElementById('jog-x-val').textContent = position.x.toFixed(2);
  document.getElementById('jog-y-val').textContent = position.y.toFixed(2);
  document.getElementById('jog-z-val').textContent = position.z.toFixed(2);

  document.getElementById('homed-x').classList.toggle('homed', homedAxes.includes('x'));
  document.getElementById('homed-y').classList.toggle('homed', homedAxes.includes('y'));
  document.getElementById('homed-z').classList.toggle('homed', homedAxes.includes('z'));
  setDot('dot-s-xhome', homedAxes.includes('x') ? 'connected' : '');
  setDot('dot-s-yhome', homedAxes.includes('y') ? 'connected' : '');
  setDot('dot-s-zhome', homedAxes.includes('z') ? 'connected' : '');

  const rx = axisVisualRange('x'), ry = axisVisualRange('y'), rz = axisVisualRange('z');
  const px = clamp((position.x - rx.min) / (rx.max - rx.min), 0, 1) * 100;
  const py = clamp((position.y - ry.min) / (ry.max - ry.min), 0, 1) * 100;
  const pz = clamp((position.z - rz.min) / (rz.max - rz.min), 0, 1) * 100;
  const dot = document.getElementById('travel-dot');
  dot.style.left = px + '%';
  dot.style.bottom = py + '%';
  document.getElementById('z-gauge-fill').style.height = pz + '%';
}

/** Shows target marker. */
function showTargetMarker(p) {
  const rx = axisVisualRange('x'), ry = axisVisualRange('y');
  const px = clamp((p.x - rx.min) / (rx.max - rx.min), 0, 1) * 100;
  const py = clamp((p.y - ry.min) / (ry.max - ry.min), 0, 1) * 100;
  const target = document.getElementById('travel-target');
  target.style.left = px + '%';
  target.style.bottom = py + '%';
  target.classList.add('show');
}

/** Hides target marker. */
function hideTargetMarker() {
  document.getElementById('travel-target').classList.remove('show');
}

/** Briefly highlights travel dot. */
function flashTravelDot() {
  const dot = document.getElementById('travel-dot');
  dot.classList.add('triggering');
  setTimeout(() => dot.classList.remove('triggering'), 400);
}

/** Updates status grid. */
function updateStatusGrid() {
  const piOnline = connected;
  const driverConnected = connected && klippyState === 'ready';
  const motionActive = commandInFlight || idleState === 'Printing';
  const fault = klippyState === 'error';
  const estop = klippyState === 'shutdown';

  setDot('dot-pi', piOnline ? 'connected' : 'error');
  setDot('dot-driver', driverConnected ? 'connected' : (piOnline ? 'error' : ''));
  setDot('dot-s-pi', piOnline ? 'connected' : 'error');
  setDot('dot-s-driver', driverConnected ? 'connected' : (piOnline ? 'error' : ''));
  setDot('dot-s-motion', motionActive ? 'active' : '');
  setDot('dot-s-testrunning', testRunning ? 'active' : '');
  setDot('dot-s-fault', fault ? 'error' : '');
  setDot('dot-s-estop', estop ? 'error' : '');

  document.getElementById('lbl-pi').textContent = piOnline ? 'Raspberry Pi ✓' : 'Raspberry Pi';
  document.getElementById('lbl-driver').textContent = driverConnected ? 'Driver ✓' : 'Driver';
  document.getElementById('klippy-state').textContent = `klippy: ${klippyState}`;

  document.getElementById('estop-badge').classList.toggle('show', estop);

  const enabled = motionEnabled();
  ['home-all-btn', 'home-x-btn', 'home-y-btn', 'zero-z-btn', 'estop-btn'].forEach((id) => {
    document.getElementById(id).disabled = !connected; // e-stop button should work whenever connected, even mid-fault
  });
  document.getElementById('estop-btn').disabled = !connected;
  document.getElementById('clear-estop-btn').disabled = !connected || (klippyState !== 'shutdown' && klippyState !== 'error');
  document.querySelectorAll('.jog-btn').forEach((b) => (b.disabled = !enabled || testRunning));
  document.getElementById('home-all-btn').disabled = !enabled || testRunning;
  document.getElementById('home-x-btn').disabled = !enabled || testRunning;
  document.getElementById('home-y-btn').disabled = !enabled || testRunning;
  document.getElementById('zero-z-btn').disabled = !enabled || testRunning;

  renderRadarSettings();
  setStartEnabled();
}

// ─── State flow (sequence phases) ────────────────────────────────────────────
const STEP_ORDER = RunStateView.STEP_ORDER;

/** Sets state flow. */
function setStateFlow(active) {
  if (active && testRunning) {
    void radarAPI.runTransition(active, { positionIndex: seqIdx, totalPositions: seqTotal }).then((result) => {
      if (!result?.success && result?.run?.status === 'abort_requested') testAborted = true;
    }).catch((error) => {
      testAborted = true;
      logEvent(`Run controller transition failed: ${error?.message || error}`, 'error');
    });
  }
  RunStateView.render(active);
}

/** Resets state flow. */
function resetStateFlow() {
  RunStateView.reset();
}

/** Sets start btn. */
function setStartBtn(mode) {
  const btn = document.getElementById('start-btn');
  const icon = document.getElementById('start-icon');
  const label = document.getElementById('start-label');
  btn.classList.remove('running');
  if (mode === 'running') {
    btn.hidden = false;
    btn.disabled = false;
    btn.classList.add('running');
    icon.textContent = '■';
    label.textContent = 'ABORT (E-STOP)';
  } else if (mode === 'idle') {
    btn.hidden = true;
    btn.disabled = false;
    icon.textContent = '▶';
    label.textContent = 'RUN TEST';
  } else {
    btn.hidden = true;
    btn.disabled = true;
    icon.textContent = '▶';
    label.textContent = 'RUN TEST';
  }
}

/** Sets result. */
function setResult(mode, reason) {
  const badge = document.getElementById('result-badge');
  const icon = document.getElementById('result-icon');
  const text = document.getElementById('result-text');
  const reasonEl = document.getElementById('result-reason');
  const configs = {
    idle:    { icon: '◎', text: 'READY',    reason: 'Load or select a test plan, then connect to begin' },
    running: { icon: '…', text: 'RUNNING',  reason: 'Test in progress' },
    pass:    { icon: '✓', text: 'PASS',     reason: 'Acceptance criteria satisfied' },
    fail:    { icon: '✗', text: 'FAIL',     reason: 'Sequence stopped' },
    complete: { icon: 'C', text: 'COMPLETE', reason: 'Characterization data captured' },
  };
  const cfg = configs[mode] || configs.idle;
  badge.className = 'result-badge ' + mode;
  text.className = 'result-text ' + mode;
  icon.textContent = cfg.icon;
  text.textContent = cfg.text;
  reasonEl.textContent = reason || cfg.reason;
}

/** Updates counters. */
function updateCounters() {
  document.getElementById('cnt-positions').textContent = positionsRun;
  document.getElementById('cnt-triggers').textContent = triggersSent;
  document.getElementById('cnt-faults').textContent = faultCount;
}

/** Updates seq progress. */
function updateSeqProgress() {
  if (!testRunning && config) {
    seqIdx = 0;
    seqTotal = (config.sequences?.[config.activeSequence]?.length || 0) * configuredCycleCount();
  }
  document.getElementById('seq-idx').textContent = seqIdx;
  document.getElementById('seq-total').textContent = seqTotal;
  document.getElementById('seq-name').textContent = config.activeSequence;
  updateQuickRunPanel();
}

/** Updates quick run panel. */
function updateQuickRunPanel(message = '', isError = false) {
  if (!config) return;
  const recipeSelect = document.getElementById('quick-recipe-select');
  if (recipeSelect && recipeSelect.value !== config.recipes?.activeId) recipeSelect.value = config.recipes?.activeId;
  const recipeDescription = document.getElementById('quick-recipe-description');
  const runRecipe = activeRecipe();
  if (recipeDescription) recipeDescription.textContent = `${runRecipe.description || runRecipe.name} · ${runRecipe.pointCount} points · ${runRecipe.cycles} cycle${runRecipe.cycles === 1 ? '' : 's'}${runRecipe.scored ? ` · ${Number(runRecipe.minimumCorrectRate * 100).toFixed(1)}% required` : ' · observational'}`;
  const sequenceSelect = document.getElementById('quick-sequence-select');
  if (!sequenceSelect) return;
  // Keep the campaign method protected only while it still owns a pending run.
  // Completed campaigns intentionally remain active for review, but must not
  // strand the quick-run text fields in their disabled (unclickable) state.
  const campaignLocked = !!campaignOperatorStatus?.active && !!campaignOperatorStatus?.next;
  if (recipeSelect) recipeSelect.disabled = testRunning || repeatedSingleRunActive || campaignLocked;
  const customizeRecipe = document.getElementById('quick-customize-recipe-btn');
  if (customizeRecipe) customizeRecipe.disabled = testRunning || repeatedSingleRunActive || campaignLocked;
  const formalMode = ['inside', 'outside', 'system'].includes(activeTestId());
  const characterizationMode = ['characterization', 'interference'].includes(activeTestId());
  const capabilities = activeTestCapabilities();
  const automaticPointMode = capabilities.automaticPoints;
  const scoredMode = ['inside', 'outside', 'system', 'custom'].includes(activeTestId());
  const names = Object.keys(config.sequences || {}).filter((name) => formalMode || !FORMAL_SEQUENCE_NAMES.has(name));
  const previousOptions = [...sequenceSelect.options].map((option) => option.value);
  if (previousOptions.length !== names.length || previousOptions.some((name, index) => name !== names[index])) {
    sequenceSelect.innerHTML = '';
    names.forEach((name) => {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      sequenceSelect.appendChild(option);
    });
  }
  sequenceSelect.value = config.activeSequence;

  const mode = document.getElementById('quick-test-mode');
  if (mode) {
    mode.value = config.test?.mode || 'characterization';
    mode.disabled = testRunning || campaignLocked;
  }
  document.getElementById('quick-formal-controls').style.display = automaticPointMode ? 'flex' : 'none';
  document.getElementById('quick-characterization-controls').style.display = capabilities.footprint ? 'flex' : 'none';
  document.getElementById('quick-plan-source').style.display = capabilities.planSource ? 'flex' : 'none';
  document.getElementById('quick-open-builder-btn').style.display = capabilities.builder ? 'block' : 'none';
  document.getElementById('quick-open-builder-btn').textContent = 'Open Test Builder / Edit Points';
  document.getElementById('quick-pass-threshold-row').style.display = capabilities.passThreshold ? 'flex' : 'none';
  const passThreshold = document.getElementById('quick-pass-threshold');
  if (passThreshold && document.activeElement !== passThreshold) passThreshold.value = Number((configuredPassRate() * 100).toFixed(1));
  const pointCount = document.getElementById('quick-point-count');
  if (pointCount) {
    if (document.activeElement !== pointCount) pointCount.value = Math.max(1, Math.floor(Number(config.validation?.pointCount) || 100));
    pointCount.disabled = testRunning || campaignLocked;
  }
  const angularZone = angularZoneSettings();
  const angularEnabledInput = document.getElementById('quick-angular-zone-enabled');
  const angularZoneInput = document.getElementById('quick-angular-zone');
  const angularZoneRow = document.getElementById('quick-angular-zone-row');
  if (angularEnabledInput) {
    angularEnabledInput.checked = angularZone.enabled;
    angularEnabledInput.disabled = testRunning || campaignLocked;
  }
  if (angularZoneInput) {
    angularZoneInput.value = angularZone.zone;
    angularZoneInput.disabled = !angularZone.enabled || testRunning || campaignLocked;
  }
  if (angularZoneRow) angularZoneRow.style.display = angularZone.enabled ? 'flex' : 'none';
  ['quick-cycle-count', 'quick-general-cycle-count'].forEach((id) => {
    const cycles = document.getElementById(id);
    if (cycles) {
      if (document.activeElement !== cycles) cycles.value = configuredCycleCount();
      cycles.disabled = testRunning || campaignLocked;
    }
  });
  const dut = document.getElementById('quick-dut-id');
  if (dut) {
    if (document.activeElement !== dut) dut.value = config.test?.dutId || '';
    dut.disabled = testRunning || campaignLocked;
  }
  const repeatCount = document.getElementById('quick-repeat-count');
  if (repeatCount) {
    if (document.activeElement !== repeatCount) repeatCount.value = Math.max(1, Math.floor(Number(config.test?.singleRunRepeats) || 1));
    repeatCount.disabled = testRunning || repeatedSingleRunActive || campaignLocked;
  }
  sequenceSelect.disabled = testRunning || campaignLocked;
  document.getElementById('quick-load-csv-btn').disabled = testRunning || campaignLocked;
  document.getElementById('quick-open-builder-btn').disabled = testRunning || campaignLocked;
  document.getElementById('quick-pass-threshold').disabled = testRunning || campaignLocked;
  const footprint = config.validation?.characterizationBounds || {};
  const xFootprintRange = axisVisualRange('x');
  const yFootprintRange = axisVisualRange('y');
  const footprintDefaults = {
    minX: xFootprintRange.min, maxX: xFootprintRange.max,
    minY: yFootprintRange.min, maxY: yFootprintRange.max,
  };
  [['quick-char-x-min','minX'],['quick-char-x-max','maxX'],['quick-char-y-min','minY'],['quick-char-y-max','maxY']].forEach(([id,key]) => {
    const input = document.getElementById(id);
    if (input && document.activeElement !== input) input.value = footprint[key] ?? footprintDefaults[key];
    if (input) input.disabled = testRunning || campaignLocked;
  });
  const advancedControls = document.querySelector('.advanced-operator-controls');
  if (advancedControls && !advancedControls.open) {
    advancedControls.querySelectorAll('input, select, button').forEach((control) => { control.disabled = true; });
  }

  const summary = document.getElementById('quick-plan-summary');
  if (!summary) return;
  const points = config.sequences?.[config.activeSequence] || [];
  const cycleText = `${configuredCycleCount()} cycle(s), ${points.length * configuredCycleCount()} total positions${scoredMode ? `, ${Number((configuredPassRate()*100).toFixed(1))}% required` : ''}`;
  const blocker = currentPlanBlockingIssue();
  const prefix = message ? `${message} | ` : '';
  summary.textContent = isError ? message : blocker || `${prefix}${points.length} points ready | ${cycleText}`;
  summary.className = `quick-plan-summary ${isError || blocker ? 'error' : points.length ? 'ready' : ''}`;
  renderPreflightChecklist(points, isError ? message : blocker);
  if (automaticPointMode && !isError) requestAnimationFrame(() => renderPlanPreviewCanvas(points, blocker, 'quick-formal-preview'));
  setStartEnabled();
  renderGuidedRunReadiness();
}

/** Updates metrics panel. */
function updateMetricsPanel() {
  document.getElementById('metric-pos').textContent = lastMetrics.pos;
  document.getElementById('metric-move-dur').textContent = lastMetrics.moveDurationMs != null ? `${lastMetrics.moveDurationMs} ms` : '---';
  document.getElementById('metric-latency').textContent = lastMetrics.latencyMs != null ? `${lastMetrics.latencyMs} ms` : '---';
  document.getElementById('metric-seq-dur').textContent = lastMetrics.seqDurationMs != null ? `${(lastMetrics.seqDurationMs / 1000).toFixed(2)} s` : '---';
}

/** Implements the sleep operation for this module. */
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** Reads number. */
function readNumber(id, fallback = 0) {
  const el = document.getElementById(id);
  const value = el ? parseFloat(el.value) : NaN;
  return Number.isFinite(value) ? value : fallback;
}

// ─── Sequence plan construction ──────────────────────────────────────────────

/** Implements the round point operation for this module. */
function roundPoint(v) {
  return Math.round(v * 1000) / 1000;
}

/** Normalizes modal numeric inputs. */
function normalizeModalNumericInputs() {
  document.querySelectorAll('#config-modal input[type="number"]').forEach((el) => {
    if (el.type !== 'text') el.type = 'text';
    el.inputMode = 'decimal';
    el.autocomplete = 'off';
    el.spellcheck = false;
  });
}

/** Implements the clone points operation for this module. */
function clonePoints(points) {
  return points.map((p) => ({
    x: roundPoint(p.x),
    y: roundPoint(p.y),
    z: roundPoint(p.z),
    holdMs: Math.max(0, Math.round(p.holdMs ?? 0)),
  }));
}

/** Builds line points. */
function buildLinePoints() {
  const start = {
    x: readNumber('seq-gen-line-start-x'),
    y: readNumber('seq-gen-line-start-y'),
  };
  const end = {
    x: readNumber('seq-gen-line-end-x'),
    y: readNumber('seq-gen-line-end-y'),
  };
  const count = Math.max(1, Math.floor(readNumber('seq-gen-line-count', 2)));
  const holdMs = Math.max(0, Math.round(readNumber('seq-generator-hold', config.trigger.holdMsDefault)));
  const points = [];

  if (count === 1) {
    points.push({ ...start, z: 0, holdMs });
    return points;
  }

  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    points.push({
      x: roundPoint(start.x + (end.x - start.x) * t),
      y: roundPoint(start.y + (end.y - start.y) * t),
      z: 0,
      holdMs,
    });
  }

  return points;
}

/** Samples even. */
function sampleEven(min, max, count) {
  if (count <= 1) return [roundPoint((min + max) / 2)];
  const points = [];
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    points.push(roundPoint(min + (max - min) * t));
  }
  return points;
}

/** Calculates values. */
function axisValues(min, max, step, order) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  const inc = Math.abs(step) || 1;
  const values = [];

  for (let v = lo; v <= hi + 1e-9; v += inc) {
    values.push(roundPoint(v));
  }

  if (values.length === 0) values.push(roundPoint(lo));
  if (values[values.length - 1] !== roundPoint(hi)) values.push(roundPoint(hi));
  if (order === 'desc') values.reverse();

  return values;
}

function generatedPointIssue(point, index = 0) {
  const x = Number(point?.x), y = Number(point?.y);
  if (![x, y].every(Number.isFinite)) return `Point ${index + 1} has invalid coordinates`;
  const bounds = fixtureXyBounds();
  if (x < bounds.minX || x > bounds.maxX || y < bounds.minY || y > bounds.maxY) return `Point ${index + 1} is outside fixture travel`;
  if (activeSensorLayout() === 'dual') {
    const location = activeDutLocation();
    if (DutLocationCore.pointInNoGo({ x, y }, location, { clearanceMm: reflectorClearanceMm() })) return `Point ${index + 1} is inside the DUT reflector keep-out`;
    if (DutLocationCore.pointBehindDut({ x, y }, location)) return `Point ${index + 1} is behind the DUT; rear motion is unavailable`;
  }
  return '';
}

function evaluateMotionPlan(points, start = lastConfirmedHomePoint || configuredHomePoint()) {
  return DutLocationCore.evaluatePlan(points, start, activeDutLocation(), motionKeepoutOptions());
}

function filterGeneratedPoints(points) {
  const safe = [], excluded = [];
  points.forEach((point, index) => {
    const reason = generatedPointIssue(point, index);
    if (reason) excluded.push({ ...point, originalIndex: index, reason });
    else safe.push(point);
  });
  return { safe, excluded };
}

function denseSafeRaster(xLo, xHi, yLo, yHi, target, serpentine, xOrder, yOrder) {
  const xSpan = Math.max(1e-9, xHi - xLo), ySpan = Math.max(1e-9, yHi - yLo);
  let safe = [];
  for (const factor of [8, 16, 32, 64]) {
    const candidateTarget = Math.max(target * factor, 64);
    let cols = Math.max(1, Math.round(Math.sqrt(candidateTarget * (xSpan / ySpan))));
    cols = Math.min(cols, candidateTarget);
    const rows = Math.max(1, Math.ceil(candidateTarget / cols));
    let xValues = sampleEven(xLo, xHi, cols);
    let yValues = sampleEven(yLo, yHi, rows);
    if (xOrder === 'desc') xValues = xValues.reverse();
    if (yOrder === 'desc') yValues = yValues.reverse();
    const candidates = [];
    yValues.forEach((y, rowIndex) => {
      const row = serpentine && rowIndex % 2 ? [...xValues].reverse() : xValues;
      row.forEach((x) => candidates.push({ x, y }));
    });
    safe = filterGeneratedPoints(candidates).safe;
    if (safe.length >= target) break;
  }
  if (safe.length <= target) return safe;
  const selected = [];
  const used = new Set();
  for (let index = 0; index < target; index++) {
    let sourceIndex = target === 1 ? Math.floor((safe.length - 1) / 2) : Math.round(index * (safe.length - 1) / (target - 1));
    while (used.has(sourceIndex) && sourceIndex + 1 < safe.length) sourceIndex += 1;
    used.add(sourceIndex);
    selected.push(safe[sourceIndex]);
  }
  return selected;
}

/** Adds the System Level result classification to newly generated dual-DUT points. */
function annotateSystemLevelPoints(points) {
  if (activeSensorLayout() !== 'dual') return points;
  const geometry = validationGeometry();
  return points.map((point) => {
    const zone = ValidationCore.classifySystemDistance(point, geometry);
    const annotated = { ...point, zone };
    if (zone === 'required-trigger') annotated.expectedDetected = true;
    else if (zone === 'required-no-trigger') annotated.expectedDetected = false;
    else delete annotated.expectedDetected; // Grey: run it, display it, but do not score it.
    return annotated;
  });
}

function finalizeGeneratedPlan(plan) {
  const points = annotateSystemLevelPoints(Array.isArray(plan.points) ? plan.points : []);
  const safety = evaluateMotionPlan(points);
  const exactCount = !Number.isFinite(Number(plan.requestedCount)) || points.length === Number(plan.requestedCount);
  const issues = [...(safety.pointIssues || []), ...(safety.routeIssues || [])];
  if (!exactCount) issues.unshift({ code: 'POINT_COUNT_SHORTFALL', message: `Only ${points.length} of ${plan.requestedCount} requested safe points fit` });
  return { ...plan, points, safety: { ...safety, safe: safety.safe && exactCount, issues }, canApply: safety.safe && exactCount && points.length > 0 };
}

function blockedGeneratedPlan(message, code = 'GENERATOR_LIMIT') {
  const issue = { code, message };
  return {
    points: [], excluded: [], canApply: false, note: message,
    safety: { safe: false, ordered: [], routes: [], pointIssues: [], routeIssues: [issue], issues: [issue] },
  };
}

/** Builds raster plan. */
function buildRasterPlan() {
  const holdMs = Math.max(0, Math.round(readNumber('seq-generator-hold', config.trigger.holdMsDefault)));
  const mode = document.getElementById('seq-gen-raster-mode')?.value || 'spacing';
  const serpentine = !!document.getElementById('seq-gen-raster-serpentine')?.checked;
  const xMin = readNumber('seq-gen-raster-x-min');
  const xMax = readNumber('seq-gen-raster-x-max');
  const yMin = readNumber('seq-gen-raster-y-min');
  const yMax = readNumber('seq-gen-raster-y-max');
  const targetCount = Math.max(0, Math.floor(readNumber('seq-gen-raster-count', 0)));
  const points = [];

  if (mode === 'count') {
    const target = Math.max(1, targetCount || 25);
    if (target > MAX_GENERATOR_POINTS) {
      return blockedGeneratedPlan(`Requested point count ${target} exceeds the safe generator limit of ${MAX_GENERATOR_POINTS}. Reduce Point Count.`);
    }
    const xLo = Math.min(xMin, xMax);
    const xHi = Math.max(xMin, xMax);
    const yLo = Math.min(yMin, yMax);
    const yHi = Math.max(yMin, yMax);
    const xSpan = Math.max(1e-9, xHi - xLo);
    const ySpan = Math.max(1e-9, yHi - yLo);

    let cols = Math.max(1, Math.round(Math.sqrt(target * (xSpan / ySpan))));
    cols = Math.min(cols, target);
    const rows = Math.max(1, Math.ceil(target / cols));
    const xValues = sampleEven(xLo, xHi, cols);
    const yValues = sampleEven(yLo, yHi, rows);

    const xOrder = document.getElementById('seq-gen-raster-x-order')?.value || 'asc';
    const yOrder = document.getElementById('seq-gen-raster-y-order')?.value || 'asc';
    const orderedXValues = xOrder === 'desc' ? [...xValues].reverse() : xValues;
    const orderedYValues = yOrder === 'desc' ? [...yValues].reverse() : yValues;
    orderedYValues.forEach((y, rowIdx) => {
      const row = serpentine && rowIdx % 2 === 1 ? [...orderedXValues].reverse() : orderedXValues;
      row.forEach((x) => {
        points.push({ x, y, z: 0, holdMs });
      });
    });

    points.length = target;
    const filtered = filterGeneratedPoints(points);
    const safePoints = filtered.safe.length === target ? filtered.safe
      : denseSafeRaster(xLo, xHi, yLo, yHi, target, serpentine, xOrder, yOrder).map((point) => ({ ...point, z: 0, holdMs }));
    return finalizeGeneratedPlan({
      points: safePoints, excluded: filtered.excluded, requestedCount: target,
      note: `Raster Grid requested ${target} point(s); ${safePoints.length} safe point(s) generated${filtered.excluded.length ? ` and ${filtered.excluded.length} original grid cell(s) excluded by safety geometry` : ''}.`,
    });
  }

  const xStep = Math.abs(readNumber('seq-gen-raster-x-step', 1)) || 1;
  const yStep = Math.abs(readNumber('seq-gen-raster-y-step', 1)) || 1;
  const estimatedColumns = Math.floor(Math.abs(xMax-xMin)/xStep)+1;
  const estimatedRows = Math.floor(Math.abs(yMax-yMin)/yStep)+1;
  const estimatedPoints = estimatedColumns*estimatedRows;
  if (!Number.isFinite(estimatedPoints) || estimatedPoints > MAX_GENERATOR_POINTS) {
    return blockedGeneratedPlan(`This spacing would create ${Number.isFinite(estimatedPoints) ? estimatedPoints.toLocaleString() : 'too many'} points. Increase X/Y Step or use Target Count (maximum ${MAX_GENERATOR_POINTS}).`);
  }
  const xValues = axisValues(
    xMin,
    xMax,
    xStep,
    document.getElementById('seq-gen-raster-x-order')?.value || 'asc'
  );
  const yValues = axisValues(
    yMin,
    yMax,
    yStep,
    document.getElementById('seq-gen-raster-y-order')?.value || 'asc'
  );

  yValues.forEach((y, rowIdx) => {
    const row = serpentine && rowIdx % 2 === 1 ? [...xValues].reverse() : xValues;
    row.forEach((x) => {
      points.push({ x, y, z: 0, holdMs });
    });
  });

  const filtered = filterGeneratedPoints(points);
  return finalizeGeneratedPlan({ points: filtered.safe, excluded: filtered.excluded,
    note: `Raster Grid generated ${filtered.safe.length} safe point(s) from spacing${filtered.excluded.length ? `; ${filtered.excluded.length} unsafe cell(s) excluded` : ''}.` });
}

/** Builds generator plan. */
function buildGeneratorPlan() {
  const pattern = document.getElementById('seq-generator-pattern')?.value || 'line';
  if (pattern === 'raster') return buildRasterPlan();
  const rawPoints = buildLinePoints();
  const filtered = filterGeneratedPoints(rawPoints);
  return finalizeGeneratedPlan({ points: filtered.safe, excluded: filtered.excluded,
    note: `Line Sweep generated ${filtered.safe.length} safe point(s)${filtered.excluded.length ? `; ${filtered.excluded.length} unsafe point(s) excluded` : ''}.` });
}

/** Returns generator pattern label. */
function getGeneratorPatternLabel() {
  const pattern = document.getElementById('seq-generator-pattern')?.value || 'line';
  return pattern === 'raster' ? 'Raster Grid' : 'Line Sweep';
}

/** Updates generator panel visibility. */
function updateGeneratorPanelVisibility() {
  const pattern = document.getElementById('seq-generator-pattern')?.value || 'line';
  document.querySelectorAll('.generator-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.dataset.generatorPanel === pattern);
  });
  updateRasterModeVisibility();
}

/** Updates raster mode visibility. */
function updateRasterModeVisibility() {
  const mode = document.getElementById('seq-gen-raster-mode')?.value || 'spacing';
  document.querySelectorAll('.raster-spacing-field').forEach((el) => {
    el.style.display = mode === 'spacing' ? '' : 'none';
  });
  document.querySelectorAll('.raster-count-field').forEach((el) => {
    el.style.display = mode === 'count' ? '' : 'none';
  });
}

/** Formats a description of point. */
function describePoint(p) {
  return `X${p.x} Y${p.y} hold ${p.holdMs}ms`;
}

/** Renders generator summary. */
function renderGeneratorSummary(points, note, safety = null) {
  const el = document.getElementById('seq-generator-summary');
  if (!el) return;

  if (!points.length) {
    const issue = safety?.issues?.[0]?.message;
    el.textContent = issue ? `${note || 'No generated plan.'} Blocked: ${issue}` : note || 'No generated plan yet';
    el.classList.toggle('error', !!issue);
    return;
  }

  const first = points[0];
  const last = points[points.length - 1];
  const issue = safety?.issues?.[0]?.message;
  el.textContent = `${note || getGeneratorPatternLabel()} First: ${describePoint(first)}. Last: ${describePoint(last)}.${issue ? ` Blocked: ${issue}` : ' Safe to apply.'}`;
  el.classList.toggle('error', !!issue);
}

function updateGeneratorApplyState(canApply) {
  ['seq-generator-apply-btn', 'seq-generator-append-btn', 'seq-generator-create-btn'].forEach((id) => {
    const button = document.getElementById(id);
    if (button) button.disabled = testRunning || !canApply;
  });
}

/** Returns plan preview canvas. */
function getPlanPreviewCanvas(canvasId = 'seq-plan-preview') {
  return document.getElementById(canvasId);
}

/** Implements the plan preview bounds operation for this module. */
function planPreviewBounds(points) {
  if (!points.length) {
    const xMin = config.motion?.x?.minMm ?? 0;
    const xMax = config.motion?.x?.maxMm ?? 1;
    const yMin = config.motion?.y?.minMm ?? 0;
    const yMax = config.motion?.y?.maxMm ?? 1;
    return { minX: xMin, maxX: xMax, minY: yMin, maxY: yMax };
  }

  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  let minX = Math.min(...xs);
  let maxX = Math.max(...xs);
  let minY = Math.min(...ys);
  let maxY = Math.max(...ys);

  if (minX === maxX) { minX -= 1; maxX += 1; }
  if (minY === maxY) { minY -= 1; maxY += 1; }

  const padX = Math.max((maxX - minX) * 0.12, 1);
  const padY = Math.max((maxY - minY) * 0.12, 1);

  return {
    minX: minX - padX,
    maxX: maxX + padX,
    minY: minY - padY,
    maxY: maxY + padY,
  };
}

/** Implements the world to canvas operation for this module. */
function worldToCanvas(x, y, bounds, width, height, pad) {
  const plotW = Math.max(1, width - pad.left - pad.right);
  const plotH = Math.max(1, height - pad.top - pad.bottom);
  const nx = (x - bounds.minX) / Math.max(1e-9, bounds.maxX - bounds.minX);
  const ny = (y - bounds.minY) / Math.max(1e-9, bounds.maxY - bounds.minY);
  return {
    x: pad.left + nx * plotW,
    y: pad.top + (1 - ny) * plotH,
  };
}

function equalScaleBounds(bounds, width, height, pad) {
  const result = { ...bounds };
  const worldWidth = Math.max(1e-9, result.maxX-result.minX);
  const worldHeight = Math.max(1e-9, result.maxY-result.minY);
  const plotWidth = Math.max(1, width-pad.left-pad.right);
  const plotHeight = Math.max(1, height-pad.top-pad.bottom);
  const plotAspect = plotWidth/plotHeight;
  if (worldWidth/worldHeight > plotAspect) {
    const targetHeight = worldWidth/plotAspect, centerY = (result.minY+result.maxY)/2;
    result.minY = centerY-targetHeight/2; result.maxY = centerY+targetHeight/2;
  } else {
    const targetWidth = worldHeight*plotAspect, centerX = (result.minX+result.maxX)/2;
    result.minX = centerX-targetWidth/2; result.maxX = centerX+targetWidth/2;
  }
  return result;
}

/** Renders plan preview canvas. */
function renderPlanPreviewCanvas(points, note, canvasId = 'seq-plan-preview', previewMeta = {}) {
  const canvas = getPlanPreviewCanvas(canvasId);
  if (!canvas) return;
  const safety = previewMeta.safety || evaluateMotionPlan(points);
  points = safety.safe ? safety.ordered : [...points];
  const excludedPoints = Array.isArray(previewMeta.excluded) ? previewMeta.excluded : [];

  const ctx = canvas.getContext('2d');
  const width = canvas.clientWidth || 1;
  const height = canvas.clientHeight || 1;
  const dpr = window.devicePixelRatio || 1;

  const targetW = Math.round(width * dpr);
  const targetH = Math.round(height * dpr);
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const validationZone = points.find((p) => p.zone === 'inside' || p.zone === 'outside')?.zone;
  const geometry = validationGeometry();
  const systemBands = ValidationCore.usesDualSystemBands(geometry);
  const displayDutBands = systemBands || (geometry.sensorLayout === 'single' && hasDutFootprint());
  const bandGeometry = displayDutBands ? dutReferenceBandGeometry(geometry) : geometry;
  const previewRadius = validationZone === 'outside' ? formalOuterDistanceMm(geometry) : geometry.radiusMm;
  const routeStart = lastConfirmedHomePoint || configuredHomePoint();
  const routedPath = points.length ? [{ x: Number(routeStart.x), y: Number(routeStart.y) }] : [];
  const routeAvailable = safety.safe;
  (safety.routes || []).forEach((route) => routedPath.push(...route.waypoints));
  const previewBoundary = validationZone
    ? ValidationCore.activationZoneBoundaries(geometry, previewRadius-geometry.radiusMm).flat() : [];
  const framedPreviewBoundary = systemBands ? previewBoundary.filter((point) => point.y <= dutNoGoBounds().maxY) : previewBoundary;
  const characterizationBands = !validationZone && activeTestId() === 'characterization' && systemBands
    ? ValidationCore.activationZoneBoundaries(geometry).flat().filter((point) => point.y <= dutNoGoBounds().maxY) : [];
  const boundsPoints = validationZone
    ? [...points, ...excludedPoints, ...routedPath, ...dutGraphCorners(), ...reflectorKeepoutGraphCorners(), ...framedPreviewBoundary]
    : [...points, ...excludedPoints, ...routedPath, ...dutGraphCorners(), ...reflectorKeepoutGraphCorners(), ...characterizationBands];
  const pad = { left: 44, right: 14, top: 18, bottom: 30 };
  const bounds = equalScaleBounds(planPreviewBounds(boundsPoints), width, height, pad);
  const gridX = 6;
  const gridY = 5;

  ctx.fillStyle = '#0a0f1a';
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = 'rgba(0,212,255,0.08)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= gridX; i++) {
    const x = pad.left + ((width - pad.left - pad.right) * i) / gridX;
    ctx.beginPath();
    ctx.moveTo(x, pad.top);
    ctx.lineTo(x, height - pad.bottom);
    ctx.stroke();
  }
  for (let i = 0; i <= gridY; i++) {
    const y = pad.top + ((height - pad.top - pad.bottom) * i) / gridY;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(width - pad.right, y);
    ctx.stroke();
  }

  ctx.strokeStyle = 'rgba(123,138,160,0.55)';
  ctx.lineWidth = 1;
  ctx.strokeRect(pad.left, pad.top, width - pad.left - pad.right, height - pad.top - pad.bottom);

  ctx.fillStyle = '#7b8aa0';
  ctx.font = '10px Segoe UI, sans-serif';
  ctx.textBaseline = 'top';
  ctx.fillText(bounds.maxY.toFixed(1), 4, pad.top - 2);
  ctx.textBaseline = 'bottom';
  ctx.fillText(bounds.minY.toFixed(1), 4, height - pad.bottom + 2);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(bounds.minX.toFixed(1), pad.left, height - pad.bottom + 4);
  ctx.textAlign = 'right';
  ctx.fillText(bounds.maxX.toFixed(1), width - pad.right, height - pad.bottom + 4);

  const characterizationSystemView = !validationZone && activeTestId() === 'characterization' && displayDutBands;
  if (validationZone || characterizationSystemView) {
    const drawWorldLobe = (extent, color, dash = [], fill = '') => {
      ValidationCore.activationZoneBoundaries(bandGeometry, extent-bandGeometry.radiusMm).forEach((boundary) => {
        ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.setLineDash(dash); ctx.beginPath();
        if (displayDutBands) {
          const backY = worldToCanvas(bounds.minX, dutNoGoBounds().maxY, bounds, width, height, pad).y;
          ctx.rect(pad.left, backY, width-pad.left-pad.right, height-pad.bottom-backY); ctx.clip(); ctx.beginPath();
        }
        boundary.forEach((point,index) => {
          const canvasPoint = worldToCanvas(point.x,point.y,bounds,width,height,pad);
          if (!index) ctx.moveTo(canvasPoint.x,canvasPoint.y); else ctx.lineTo(canvasPoint.x,canvasPoint.y);
        });
        ctx.closePath(); if (fill) { ctx.fillStyle=fill; ctx.fill(); } ctx.stroke(); ctx.restore();
      });
    };
    drawWorldLobe(bandGeometry.radiusMm, 'rgba(0,212,255,.9)', [], 'rgba(0,212,255,.04)');
    if (displayDutBands) {
      drawWorldLobe(bandGeometry.requiredNoTriggerMm, 'rgba(155,165,180,.7)', [5,4]);
    } else if (validationZone === 'outside' && geometry.guardBandMm) {
      drawWorldLobe(geometry.radiusMm+geometry.guardBandMm, 'rgba(255,170,0,.55)', [4,4]);
    }
    if (validationZone === 'outside') drawWorldLobe(previewRadius, 'rgba(155,111,255,.7)', [7,4]);
  }

  drawReflectorKeepout(ctx, (x) => worldToCanvas(x, bounds.minY, bounds, width, height, pad).x,
    (y) => worldToCanvas(bounds.minX, y, bounds, width, height, pad).y);
  drawDutFootprint(ctx, (x) => worldToCanvas(x, bounds.minY, bounds, width, height, pad).x,
    (y) => worldToCanvas(bounds.minX, y, bounds, width, height, pad).y);

  if (!points.length) {
    excludedPoints.forEach((point) => {
      const xy = worldToCanvas(Number(point.x), Number(point.y), bounds, width, height, pad);
      ctx.save(); ctx.strokeStyle = '#ff405c'; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.moveTo(xy.x-6,xy.y-6);ctx.lineTo(xy.x+6,xy.y+6);ctx.moveTo(xy.x+6,xy.y-6);ctx.lineTo(xy.x-6,xy.y+6);ctx.stroke(); ctx.restore();
    });
    ctx.fillStyle = '#7b8aa0';
    ctx.font = '12px Segoe UI, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(note || 'No points to preview yet', width / 2, height / 2);
    return;
  }

  const projected = points.map((p, idx) => ({
    idx: idx + 1,
    p,
    xy: worldToCanvas(p.x, p.y, bounds, width, height, pad),
  }));

  ctx.strokeStyle = routeAvailable ? 'rgba(0,232,123,0.48)' : 'rgba(255,64,92,0.8)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  routedPath.forEach((point, idx) => {
    const xy = worldToCanvas(point.x, point.y, bounds, width, height, pad);
    if (idx === 0) ctx.moveTo(xy.x, xy.y);
    else ctx.lineTo(xy.x, xy.y);
  });
  ctx.stroke();

  projected.forEach((item, idx) => {
    const isFirst = idx === 0;
    const isLast = idx === projected.length - 1;
    const color = isFirst ? '#00d4ff' : isLast ? '#ffaa00' : '#00e87b';
    ctx.fillStyle = color;
    ctx.strokeStyle = '#08111a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(item.xy.x, item.xy.y, 5.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    const labelEvery = Math.max(1, Math.ceil(projected.length / 12));
    if (isFirst || isLast || item.idx % labelEvery === 0) {
      ctx.fillStyle = '#dde4f0';
      ctx.font = '10px Segoe UI, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(item.idx), item.xy.x + 8, item.xy.y);
    }
  });

  excludedPoints.forEach((point) => {
    const xy = worldToCanvas(Number(point.x), Number(point.y), bounds, width, height, pad);
    ctx.save(); ctx.strokeStyle = '#ff405c'; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(xy.x-6,xy.y-6);ctx.lineTo(xy.x+6,xy.y+6);ctx.moveTo(xy.x+6,xy.y-6);ctx.lineTo(xy.x-6,xy.y+6);ctx.stroke();
    ctx.restore();
  });

  const start = projected[0];
  const end = projected[projected.length - 1];
  const home = worldToCanvas(routeStart.x, routeStart.y, bounds, width, height, pad);
  ctx.fillStyle = '#55b7ff'; ctx.fillRect(home.x-4,home.y-4,8,8);
  ctx.fillStyle = '#55b7ff'; ctx.font = '9px Segoe UI, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
  ctx.fillText('Home', home.x+7, home.y-4);
  ctx.fillStyle = 'rgba(0,212,255,0.9)';
  ctx.font = '9px Segoe UI, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillText('Start', start.xy.x + 8, start.xy.y - 4);
  ctx.fillStyle = 'rgba(255,170,0,0.95)';
  ctx.fillText('End', end.xy.x + 8, end.xy.y - 4);
}

/** Schedules plan preview render. */
function schedulePlanPreviewRender(points, note, previewMeta = {}) {
  if (planPreviewRaf) cancelAnimationFrame(planPreviewRaf);
  planPreviewRaf = requestAnimationFrame(() => {
    planPreviewRaf = null;
    renderPlanPreviewCanvas(points, note, 'seq-plan-preview', previewMeta);
  });
}

/** Seeds generator defaults. */
function seedGeneratorDefaults() {
  const seq = config.sequences[config.activeSequence] || [];
  const first = seq[0] || { x: 0, y: 0, holdMs: config.trigger.holdMsDefault };
  const last = seq[seq.length - 1] || first;

  const setIfBlank = (id, value) => {
    const el = document.getElementById(id);
    if (el && !el.value) el.value = value;
  };

  setIfBlank('seq-generator-pattern', document.getElementById('seq-generator-pattern')?.value || 'line');
  setIfBlank('seq-generator-hold', config.trigger.holdMsDefault);

  setIfBlank('seq-gen-line-start-x', first.x ?? 0);
  setIfBlank('seq-gen-line-start-y', first.y ?? 0);
  setIfBlank('seq-gen-line-end-x', last.x ?? first.x ?? 0);
  setIfBlank('seq-gen-line-end-y', last.y ?? first.y ?? 0);
  setIfBlank('seq-gen-line-count', Math.max(2, seq.length || 2));

  const xs = seq.map((p) => p.x);
  const ys = seq.map((p) => p.y);
  const xRange = axisVisualRange('x');
  const yRange = axisVisualRange('y');
  const xMin = xs.length ? Math.min(...xs) : xRange.min;
  const xMax = xs.length ? Math.max(...xs) : xRange.max;
  const yMin = ys.length ? Math.min(...ys) : yRange.min;
  const yMax = ys.length ? Math.max(...ys) : yRange.max;

  setIfBlank('seq-gen-raster-x-min', xMin);
  setIfBlank('seq-gen-raster-x-max', xMax);
  setIfBlank('seq-gen-raster-x-step', 10);
  setIfBlank('seq-gen-raster-y-min', yMin);
  setIfBlank('seq-gen-raster-y-max', yMax);
  setIfBlank('seq-gen-raster-y-step', 10);
  setIfBlank('seq-gen-raster-x-order', 'asc');
  setIfBlank('seq-gen-raster-y-order', 'asc');
  const rasterMode = document.getElementById('seq-gen-raster-mode');
  if (rasterMode && !rasterMode.dataset.seeded) {
    rasterMode.value = 'count';
    rasterMode.dataset.seeded = 'true';
  }
  setIfBlank('seq-gen-raster-count', Math.max(1, seq.length || 25));
  updateRasterModeVisibility();
}

/** Previews generator. */
function previewGenerator() {
  const plan = buildGeneratorPlan();
  generatorPreview = plan.points;
  generatorPreviewExcluded = plan.excluded || [];
  generatorPreviewSafety = plan.safety;
  renderGeneratorSummary(plan.points, plan.note, plan.safety);
  updateGeneratorApplyState(plan.canApply);
  schedulePlanPreviewRender(plan.points, plan.note, { excluded: generatorPreviewExcluded, safety: generatorPreviewSafety });
}

/** Commits sequence edit. */
function commitSequenceEdit() {
  const name = document.getElementById('seq-select').value || config.activeSequence;
  const original = config.sequences[name] || [];
  const rows = [...document.querySelectorAll('#seq-tbody tr')];
  config.sequences[name] = rows.map((tr, index) => {
    const point = {
      ...(original[index] || {}),
      x: parseFloat(tr.querySelector('.seq-x').value) || 0,
      y: parseFloat(tr.querySelector('.seq-y').value) || 0,
      z: 0,
      holdMs: parseInt(tr.querySelector('.seq-hold').value, 10) || 0,
    };
    const zone = tr.querySelector('.seq-zone')?.value || '';
    const expected = tr.querySelector('.seq-expected')?.value || 'auto';
    delete point.zone;
    delete point.expectedDetected;
    if (zone) point.zone = zone;
    if (expected !== 'auto') point.expectedDetected = expected === 'true';
    return point;
  });
  config.activeSequence = name;
  return name;
}

/** Applies generated sequence. */
function applyGeneratedSequence(mode) {
  commitSequenceEdit();
  const plan = buildGeneratorPlan();
  const points = clonePoints(plan.points);
  const currentName = document.getElementById('seq-select').value || config.activeSequence;
  let targetName = currentName;

  if (!plan.canApply) {
    const message = plan.safety?.issues?.map((issue) => issue.message).join('\n') || 'The generated plan contains no safe positions.';
    window.alert(`Generated plan cannot be applied.\n\n${message}`);
    return;
  }

  const combined = mode === 'append' ? (config.sequences[targetName] || []).concat(points) : points;
  const combinedSafety = evaluateMotionPlan(combined);
  if (!combinedSafety.safe) {
    const message = [...combinedSafety.pointIssues, ...combinedSafety.routeIssues].map((issue) => issue.message).join('\n');
    window.alert(`Generated plan cannot be applied.\n\n${message}`);
    return;
  }

  if (mode === 'create') {
    const rawName = document.getElementById('seq-generator-name')?.value?.trim();
    const pattern = getGeneratorPatternLabel();
    targetName = rawName || `${pattern} ${Object.keys(config.sequences).length + 1}`;
    if (config.sequences[targetName]) {
      window.alert(`Sequence "${targetName}" already exists.`);
      return;
    }
    config.sequences[targetName] = points;
  } else if (mode === 'append') {
    config.sequences[targetName] = (config.sequences[targetName] || []).concat(points);
  } else {
    config.sequences[targetName] = points;
  }

  config.activeSequence = targetName;
  populateSequenceSelect();
  renderSequenceTable();
  updateSeqProgress();
  generatorPreview = points;
  generatorPreviewExcluded = plan.excluded || [];
  generatorPreviewSafety = plan.safety;
  const actionNote = mode === 'append' ? 'Appended plan' : mode === 'create' ? 'Created plan' : 'Replaced active plan';
  renderGeneratorSummary(points, `${actionNote}. ${plan.note}`, plan.safety);
  updateGeneratorApplyState(plan.canApply);
  schedulePlanPreviewRender(points, `${actionNote}. ${plan.note}`, { excluded: generatorPreviewExcluded, safety: generatorPreviewSafety });
}

// ─── CSV plan and observation import ─────────────────────────────────────────

/** Normalizes csv header. */
function normalizeCsvHeader(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Parses quoted CSV text into an array of rows and cells. */
function parseCsvText(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"') {
        if (next === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }

    if (ch === ',') {
      row.push(cell);
      cell = '';
      continue;
    }

    if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }

    if (ch !== '\r') {
      cell += ch;
    }
  }

  row.push(cell);
  rows.push(row);
  return rows
    .map((cells) => cells.map((v) => String(v).trim()))
    .filter((cells) => cells.some((v) => v !== ''));
}

/** Converts plan CSV rows into normalized fixture positions. */
function extractPointsFromCsvText(text) {
  const rows = parseCsvText(text);
  if (!rows.length) return { points: [], summary: 'CSV is empty' };

  const headerNames = rows[0].map(normalizeCsvHeader);
  const hasHeader = headerNames.some((name) => ['x', 'y', 'z', 'holdms', 'hold', 'holdmilliseconds'].includes(name));
  const dataRows = hasHeader ? rows.slice(1) : rows;
  const indexByField = hasHeader ? {
    x: headerNames.findIndex((name) => name === 'x'),
    y: headerNames.findIndex((name) => name === 'y'),
    z: headerNames.findIndex((name) => name === 'z'),
    holdMs: headerNames.findIndex((name) => ['holdms', 'hold', 'holdmilliseconds', 'ms'].includes(name)),
    zone: headerNames.findIndex((name) => name === 'zone'),
    expectedDetected: headerNames.findIndex((name) => ['expecteddetected', 'expected'].includes(name)),
  } : { x: 0, y: 1, z: 2, holdMs: 3, zone: -1, expectedDetected: -1 };

  const defaultZ = 0;
  const defaultHold = Math.max(0, Math.round(readNumber('seq-generator-hold', config.trigger.holdMsDefault)));
  const points = [];

  dataRows.forEach((cells) => {
    if (cells.length === 0) return;
    if (!hasHeader && cells[0]?.startsWith('#')) return;

    const pick = (field) => {
      const idx = indexByField[field];
      return idx >= 0 ? cells[idx] : '';
    };

    const x = parseFloat(pick('x'));
    const y = parseFloat(pick('y'));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;

    const zRaw = pick('z');
    const holdRaw = pick('holdMs');
    const expectedRaw = pick('expectedDetected').toLowerCase();
    points.push({
      x: roundPoint(x),
      y: roundPoint(y),
      z: Number.isFinite(parseFloat(zRaw)) ? roundPoint(parseFloat(zRaw)) : roundPoint(defaultZ),
      holdMs: Number.isFinite(parseInt(holdRaw, 10)) ? Math.max(0, parseInt(holdRaw, 10)) : defaultHold,
      ...(pick('zone') ? { zone: pick('zone') } : {}),
      ...(['true', 'false'].includes(expectedRaw) ? { expectedDetected: expectedRaw === 'true' } : {}),
    });
  });

  if (!points.length) {
    return { points: [], summary: 'CSV did not contain any valid x/y rows' };
  }

  return {
    points,
    summary: `Loaded ${points.length} point(s) from CSV. First: ${describePoint(points[0])}. Last: ${describePoint(points[points.length - 1])}.`,
  };
}

/** Converts result CSV rows into canonical observation objects. */
function extractObservationsFromCsvText(text, sourceName = 'imported.csv') {
  const rows = parseCsvText(text);
  if (rows.length < 2) return [];
  const headers = rows[0].map(normalizeCsvHeader);
  const index = (names) => headers.findIndex((h) => names.includes(h));
  const columns = {
    event: index(['event']), runId: index(['runid']), testId: index(['testid']), testVersion: index(['testversion']),
    dutId: index(['dutidentifier','dutid']), cycle: index(['cyclenumber','cycle']), pointId: index(['pointid']),
    positionIndex: index(['positionindex','idx']), attempt: index(['attemptnumber','attempt']), x: index(['x']), y: index(['y']), z: index(['z']),
    expected: index(['expecteddetected','expectedresult']), actual: index(['actualdetected','detected','actualdetectionresult']),
    triggeredSensors: index(['triggeredsensors','sensoroutput']),
    latency: index(['detectionlatencyms','latencyms','latency']), move: index(['movedurationms']), valid: index(['valid']),
    invalidReason: index(['invalidreason']), notes: index(['notes']), timestamp: index(['timestamp']), zone: index(['zone']),
  };
  const pick = (cells, key) => columns[key] >= 0 ? cells[columns[key]] : '';
  const parseBool = (value) => {
    const v=String(value).trim().toLowerCase();
    if (['true','1','yes','detected','detect'].includes(v)) return true;
    if (['false','0','no','notdetected','nodetect'].includes(v)) return false;
    return null;
  };
  const imported=[];
  rows.slice(1).forEach((cells) => {
    const event=pick(cells,'event');
    if (event && !['OBSERVATION','RADAR_RESULT'].includes(event)) return;
    const x=parseFloat(pick(cells,'x')), y=parseFloat(pick(cells,'y'));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const actual=parseBool(pick(cells,'actual'));
    if (actual === null) return;
    const expected=parseBool(pick(cells,'expected'));
    const testId=pick(cells,'testId') || activeTestId();
    imported.push(ValidationCore.createObservation({
      runId: pick(cells,'runId') || sourceName,
      testId,
      testVersion: parseFloat(pick(cells,'testVersion')) || 1,
      dutId: pick(cells,'dutId'),
      cycleNumber: parseFloat(pick(cells,'cycle')) || config.test?.cycleNumber || 1,
      pointId: pick(cells,'pointId') || pick(cells,'positionIndex'),
      positionIndex: parseFloat(pick(cells,'positionIndex')) || null,
      attemptNumber: parseFloat(pick(cells,'attempt')) || 1,
      x, y, z: parseFloat(pick(cells,'z')) || 0,
      zone: pick(cells,'zone') || undefined,
      expectedDetected: expected === null ? undefined : expected,
      actualDetected: actual,
      triggeredSensors: pick(cells,'triggeredSensors'),
      detectionLatencyMs: parseFloat(pick(cells,'latency')),
      moveDurationMs: parseFloat(pick(cells,'move')),
      timestamp: pick(cells,'timestamp') || undefined,
      valid: parseBool(pick(cells,'valid')) !== false,
      invalidReason: pick(cells,'invalidReason'),
      notes: pick(cells,'notes'),
      geometry: validationGeometry(),
    }));
  });
  return imported;
}

/** Renders csv summary. */
function renderCsvSummary(points, note) {
  const el = document.getElementById('seq-import-summary');
  if (!el) return;

  if (!points.length) {
    el.textContent = note || 'No CSV loaded yet';
    return;
  }

  el.textContent = note || `Loaded ${points.length} point(s) from CSV. First: ${describePoint(points[0])}. Last: ${describePoint(points[points.length - 1])}.`;
}

/** Previews imported csv. */
function previewImportedCsv() {
  const text = document.getElementById('seq-import-csv')?.value || '';
  const parsed = extractPointsFromCsvText(text);
  csvPreview = parsed.points;
  renderCsvSummary(csvPreview, parsed.summary);
}

/** Imports csv points. */
function importCsvPoints(mode) {
  commitSequenceEdit();

  const text = document.getElementById('seq-import-csv')?.value || '';
  const parsed = extractPointsFromCsvText(text);
  const points = clonePoints(parsed.points);

  if (!points.length) {
    renderCsvSummary([], parsed.summary);
    window.alert(parsed.summary);
    return;
  }

  const currentName = document.getElementById('seq-select').value || config.activeSequence;
  let targetName = currentName;

  if (mode === 'create') {
    const rawName = document.getElementById('seq-import-name')?.value?.trim();
    targetName = rawName || `Imported CSV ${Object.keys(config.sequences).length + 1}`;
    if (config.sequences[targetName]) {
      window.alert(`Sequence "${targetName}" already exists.`);
      return;
    }
    config.sequences[targetName] = points;
  } else if (mode === 'append') {
    config.sequences[targetName] = (config.sequences[targetName] || []).concat(points);
  } else {
    config.sequences[targetName] = points;
  }

  config.activeSequence = targetName;
  populateSequenceSelect();
  renderSequenceTable();
  updateSeqProgress();
  csvPreview = points;
  renderCsvSummary(points, mode === 'append' ? 'Appended CSV points to the active sequence' : mode === 'create' ? `Created sequence "${targetName}" from CSV` : `Replaced active sequence with ${points.length} CSV point(s)`);
}

// ─── Error classification badge ──────────────────────────────────────────────
const ERR_LABELS = {
  ERR001: 'Motor Fault',
  ERR002: 'Home Switch Failure',
  ERR003: 'Driver Offline',
  ERR004: 'Raspberry Pi Communication Lost',
  ERR005: 'Position Timeout',
  ERR006: 'Travel Limit Exceeded',
  ERR007: 'Reflector Trigger Timeout',
};

// ─── Radar input and trigger observation ─────────────────────────────────────

/** Implements the fault reason for operation for this module. */
function faultReasonFor(res) {
  if (res.code && ERR_LABELS[res.code]) return `${res.code} — ${ERR_LABELS[res.code]}`;
  return res.error || 'Unknown fault';
}


/** Reads radar once. */
async function readRadarOnce() {
  const res = await radarAPI.readRadar();
  window.__radarAppDiagnostics.radarPolls++;

  if (res.success) {
    radarFailCount = 0;
    radarOnline = true;
    radarHigh = !!res.high;
  } else {
    radarFailCount++;
    if (radarFailCount >= 3) {
      radarOnline = false;
      radarHigh = false;
    }
  }

  updateRadarUI();

  return {
    // Measurement logic must never accept a cached state after a failed read.
    // radarOnline is intentionally debounced for the UI only.
    success: !!res.success,
    high: radarHigh,
    error: res.error,
    updatedAt: res.updatedAt,
    sensors: res.sensors || {},
    activeTarget: res.activeTarget || activeRadarTarget(),
    activeChannels: res.activeChannels || (activeRadarTarget() === 'ld021_pair' ? ['LD021_A', 'LD021_B'] : activeRadarTarget() === 'ld021_a' ? ['LD021_A'] : activeRadarTarget() === 'ld021_b' ? ['LD021_B'] : activeRadarTarget() === 'ld021' ? ['LD021'] : activeRadarTarget() === 'single' ? ['SINGLE'] : activeRadarTarget() === 'rcwl_single' ? ['RCWL_SINGLE'] : ['rcwl_dual', 'rcwl_pair'].includes(activeRadarTarget()) ? ['RCWL_A', 'RCWL_B'] : ['A', 'B']),
    source: res.source || '',
  };
}

/** Updates radar ui. */
function updateRadarUI() {
  const dot = document.getElementById('dot-radar');
  const label = document.getElementById('lbl-radar');

  if (!dot || !label) return;

  if (!radarOnline) {
    setDot('dot-radar', 'error');
    label.textContent = `${config.validation?.sensorLayout === 'single' ? 'Single radar' : 'Radar A/B'} detection offline`;
    return;
  }

  setDot('dot-radar', radarHigh ? 'active' : '');
  label.textContent = radarHigh ? 'Radar TRIGGERED' : 'Radar LOW';
}

/** Starts radar polling. */
function startRadarPolling() {
  stopRadarPolling();

  const poll = async () => {
    await readRadarOnce();
    radarPollTimer = setTimeout(poll, config.radar?.pollMs || 100);
  };

  poll();
}

/** Stops radar polling. */
function stopRadarPolling() {
  if (radarPollTimer) {
    clearTimeout(radarPollTimer);
    radarPollTimer = null;
  }
}

/** Polls for a fresh radar HIGH signal until detection or timeout. */
async function waitForRadarHigh(timeoutMs, triggerSentMs) {
  const pollMs = Math.max(10, config.radar?.pollMs || 25);
  const deadline = triggerSentMs + timeoutMs;
  let successfulReads = 0;
  let lastError = '';
  let lastSampleAt = 0;
  let lastSensors = {};
  let lastActiveTarget = activeRadarTarget();
  let priorLd021A = null, priorLd021B = null;
  let firstPairDetectionAt = null;
  let firstPairLatencyMs = null;
  const pairDetections = { A: false, B: false };
  const edges = {};

  while (Date.now() < deadline) {
    if (testAborted) {
      return { detected: false, latencyMs: null, aborted: true, valid: false, error: 'Test aborted during detection window' };
    }

    const res = await readRadarOnce();
    if (res.success) {
      lastSensors = res.sensors || {};
      lastActiveTarget = res.activeTarget || lastActiveTarget;
    }

    const sampleAt = Number(res.updatedAt) || 0;
    const freshSample = res.success && sampleAt >= triggerSentMs && sampleAt !== lastSampleAt;
    const pairTarget = ['ld021_pair', 'rcwl_pair'].includes(lastActiveTarget);
    const pairChannelA = lastActiveTarget === 'ld021_pair' ? 'LD021_A' : 'RCWL_A';
    const pairChannelB = lastActiveTarget === 'ld021_pair' ? 'LD021_B' : 'RCWL_B';
    if (freshSample && pairTarget) {
      pairDetections.A ||= res.sensors?.[pairChannelA]?.detected === true;
      pairDetections.B ||= res.sensors?.[pairChannelB]?.detected === true;
    }
    if (freshSample && lastActiveTarget === 'ld021_pair') {
      const a = res.sensors?.LD021_A?.detected;
      const b = res.sensors?.LD021_B?.detected;
      if (typeof a === 'boolean' && priorLd021A !== null && a !== priorLd021A) edges[a ? 'ld021ARisingEdgeMs' : 'ld021AFallingEdgeMs'] = sampleAt - triggerSentMs;
      if (typeof b === 'boolean' && priorLd021B !== null && b !== priorLd021B) edges[b ? 'ld021BRisingEdgeMs' : 'ld021BFallingEdgeMs'] = sampleAt - triggerSentMs;
      if (typeof a === 'boolean') priorLd021A = a;
      if (typeof b === 'boolean') priorLd021B = b;
    }
    if (freshSample && pairTarget && firstPairDetectionAt !== null) {
      const pairConfig = lastActiveTarget === 'rcwl_pair' ? config.validation?.rcwlPair : config.validation?.ld021Pair;
      const correlationMs = Math.max(1, Number(pairConfig?.correlationWindowMs) || 250);
      if (Date.now() >= firstPairDetectionAt + correlationMs) {
        const sensors = { ...(res.sensors || {}),
          [pairChannelA]: { ...(res.sensors?.[pairChannelA] || {}), detected: pairDetections.A },
          [pairChannelB]: { ...(res.sensors?.[pairChannelB] || {}), detected: pairDetections.B },
        };
        return { detected: true, latencyMs: firstPairLatencyMs, valid: true, sensors,
          activeTarget: res.activeTarget || lastActiveTarget, ...edges };
      }
    }
    if (freshSample && res.high) {
      if (pairTarget) {
        if (firstPairDetectionAt === null) {
          firstPairDetectionAt = sampleAt;
          firstPairLatencyMs = sampleAt - triggerSentMs;
        }
        const pairConfig = lastActiveTarget === 'rcwl_pair' ? config.validation?.rcwlPair : config.validation?.ld021Pair;
        const correlationMs = Math.max(1, Number(pairConfig?.correlationWindowMs) || 250);
        if (!(pairDetections.A && pairDetections.B) && Date.now() < firstPairDetectionAt + correlationMs) {
          successfulReads++; lastSampleAt = sampleAt;
          await sleep(pollMs);
          continue;
        }
        const sensors = { ...(res.sensors || {}),
          [pairChannelA]: { ...(res.sensors?.[pairChannelA] || {}), detected: pairDetections.A },
          [pairChannelB]: { ...(res.sensors?.[pairChannelB] || {}), detected: pairDetections.B },
        };
        return { detected: true, latencyMs: firstPairLatencyMs, valid: true, sensors,
          activeTarget: res.activeTarget || lastActiveTarget, ...edges };
      }
      return {
        detected: true,
        latencyMs: sampleAt - triggerSentMs,
        valid: true,
        sensors: res.sensors || {},
        activeTarget: res.activeTarget || lastActiveTarget,
        ...edges,
      };
    }
    if (freshSample) { successfulReads++; lastSampleAt = sampleAt; }
    else lastError = res.error || 'Radar state unavailable';

    await sleep(pollMs);
  }

  if (firstPairDetectionAt !== null) {
    const pairChannelA = lastActiveTarget === 'ld021_pair' ? 'LD021_A' : 'RCWL_A';
    const pairChannelB = lastActiveTarget === 'ld021_pair' ? 'LD021_B' : 'RCWL_B';
    return { detected: true, latencyMs: firstPairLatencyMs, valid: true,
      sensors: { ...lastSensors,
        [pairChannelA]: { ...(lastSensors[pairChannelA] || {}), detected: pairDetections.A },
        [pairChannelB]: { ...(lastSensors[pairChannelB] || {}), detected: pairDetections.B },
      }, activeTarget: lastActiveTarget, ...edges };
  }

  return {
    detected: false,
    latencyMs: null,
    valid: successfulReads > 0 && Date.now() - lastSampleAt <= Math.max(500, pollMs * 3),
    error: successfulReads > 0 && Date.now() - lastSampleAt <= Math.max(500, pollMs * 3) ? '' : lastError || 'No recent radar sample at the end of the detection window',
    sensors: lastSensors,
    activeTarget: lastActiveTarget,
    ...edges,
  };
}

/** Requires a fresh LOW baseline before a trigger attempt. */
async function waitForRadarLow(timeoutMs) {
  const pollMs = Math.max(20, config.radar?.pollMs || 100);
  const requestedAt = Date.now();
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() <= deadline) {
    if (testAborted) return { success: false, aborted: true };
    const res = await readRadarOnce();
    if (res.success && !res.high && Number(res.updatedAt) >= requestedAt) return { success: true };
    await sleep(pollMs);
  }
  return { success: false, aborted: false };
}

// ─── Sequence runner ──────────────────────────────────────────────────────────
/** Executes the active point plan, triggers the radar, and records every result. */
/**
 * Homes Y completely before moving X so the reflector clears the DUT before
 * traversing horizontally. Stop immediately if the Y home fails.
 */
async function homeYThenX() {
  const yResult = await radarAPI.home(['y']);
  if (!yResult.success) return yResult;
  const xResult = await radarAPI.home(['x']);
  if (xResult.success && Number.isFinite(Number(xResult.position?.x)) && Number.isFinite(Number(xResult.position?.y))) {
    lastConfirmedHomePoint = { x: Number(xResult.position.x), y: Number(xResult.position.y) };
  }
  return xResult;
}

async function runSequence() {
  if (config.radarService?.requireVerifiedSettings && !(await refreshRadarSettings(true))) {
    const reason = radarSettingsBlockingIssue();
    setResult('fail', reason);
    logEvent(`Test blocked: ${reason}`, 'error');
    return;
  }
  const preparedFromOperator = pendingPreparedRun;
  if (!preparedFromOperator && ['inside', 'outside'].includes(activeTestId())) {
    const formalPlan = buildFormalValidationPlan(activeTestId());
    if (formalPlan.error) {
      logEvent(`Formal test blocked: ${formalPlan.error}`, 'error');
      setResult('fail', formalPlan.error);
      return;
    }
    installFormalValidationPlan(activeTestId(), formalPlan);
    await radarAPI.configSet(config);
    updateSeqProgress();
  } else if (!preparedFromOperator && activeTestId() === 'system') {
    const systemPlan = buildSystemValidationPlan(config.validation?.angularZoneEnabled === false ? 'all' : config.validation?.angularZone || 'front');
    if (systemPlan.error) {
      logEvent(`System Level test blocked: ${systemPlan.error}`, 'error');
      setResult('fail', systemPlan.error);
      return;
    }
    systemPlan.points = optimizedExecutionPoints(systemPlan.points);
    config.sequences[systemPlan.name] = systemPlan.points;
    config.activeSequence = systemPlan.name;
    await radarAPI.configSet(config);
    updateSeqProgress();
  }
  const runBlocker = currentPlanBlockingIssue();
  if (runBlocker) {
    logEvent(`Test blocked before motion: ${runBlocker}`, 'error');
    setResult('fail', runBlocker);
    return;
  }
  let seq = preparedFromOperator
    ? preparedFromOperator.generatedPoints.map((point) => ({ ...point }))
    : optimizedExecutionPoints(config.sequences[config.activeSequence] || []);
  config.sequences[config.activeSequence] = seq;
  await radarAPI.configSet(config);
  if (!seq.length) { logEvent('Active sequence has no positions — add some in Configuration → Sequence', 'warn'); return; }
  if (['inside','outside','system','custom'].includes(activeTestId()) && !config.logging?.enabled) {
    logEvent('Validation blocked: raw CSV logging is disabled', 'error');
    setResult('fail', 'Enable raw CSV logging before running a validation test');
    return;
  }
  const planIssues = ValidationCore.validatePlan(activeTestId(), seq, validationGeometry());
  if (planIssues.length && ['inside','outside','system','custom'].includes(activeTestId())) {
    const examples = planIssues.slice(0, 3).map((issue) => issue.message).join('; ');
    logEvent(`Validation plan blocked: ${planIssues.length} invalid point(s). ${examples}`, 'error');
    setResult('fail', `Plan does not match ${activeTestId()} zone — correct it before running`);
    return;
  }

  resetValidationRun();
  const preparedHardware = OperatorFlowCore.HARDWARE.find((item) => item.sensorLayout === config.validation?.sensorLayout
    && item.radarTarget === config.validation?.radarTarget
    && (!item.hilinkSensor || item.hilinkSensor === config.validation?.hilinkSensor));
  currentPreparedRun = preparedFromOperator || RunWorkspaceCore.prepare({
    plan: activeTestPlan(), draft: currentRunSetup(), generatedPoints: seq,
    resolvedHardware: preparedHardware || {}, resolvedGeometry: validationGeometry(),
    acceptanceRules: currentRunDefinition?.acceptance || {},
  });
  pendingPreparedRun = null;
  seq = currentPreparedRun.generatedPoints;
  const authorization = await radarAPI.beginQualificationRun({
    runId: currentRunId,
    testId: currentPreparedRun.plan.testType,
    sequence: config.activeSequence,
    plannedPositions: seq.length,
    cycles: currentPreparedRun.acceptanceRules.cyclesRequired || configuredCycleCount(),
  });
  if (!authorization?.success) {
    const reason = authorization?.error || 'The main process did not authorize this run';
    logEvent(reason, 'error');
    setResult('fail', reason);
    return;
  }

  testRunning = true;
  testAborted = false;
  updateEngineeringSetupEditability();
  seqIdx = 0;
  const definition = currentRunDefinition;
  const requiredCycles = currentPreparedRun.acceptanceRules.cyclesRequired || configuredCycleCount();
  seqTotal = seq.length * requiredCycles;
  positionsRun = 0;
  triggersSent = 0;
  updateCounters();
  updateSeqProgress();
  clearChart();
  chartSampleT0 = Date.now();
  const seqStartMs = Date.now();
  pendingLogWrites = Promise.resolve();
  pendingLogWriteError = null;

  setStartBtn('running');
  setResult('running');
  resetStateFlow();
  updateStatusGrid();
  await radarAPI.setTestMode(config.test?.mode || 'sequence');
  const logStartResult = await radarAPI.logStart(buildRunManifest(seq));
  if (!logStartResult?.success) {
    await finishSequence('fail', logStartResult?.error || 'Run log could not be opened');
    return;
  }
  logEvent(`Sequence "${config.activeSequence}" started — ${seq.length} position(s) × ${requiredCycles} cycle(s)`, 'state');

  setStateFlow('home');
  const homeRes = await withCommandInFlight(homeYThenX);
  if (!homeRes.success) {
    await finishSequence('fail', faultReasonFor(homeRes));
    return;
  }
  const confirmedHome = homeRes.position && Number.isFinite(Number(homeRes.position.x)) && Number.isFinite(Number(homeRes.position.y))
    ? { x: Number(homeRes.position.x), y: Number(homeRes.position.y) }
    : lastConfirmedHomePoint || configuredHomePoint();
  lastConfirmedHomePoint = confirmedHome;
  seq = optimizedExecutionPoints(seq, confirmedHome);
  config.sequences[config.activeSequence] = seq;
  await radarAPI.configSet(config);
  renderPlanPreviewCanvas(seq, '', 'quick-formal-preview');
  logEvent('Homed X/Y', 'state');

  // Invalid acquisition is distinct from a hardware fault.  Keep planned
  // point/cycles for a post-plan retry pass (three retries after the initial).
  const invalidRetryQueue = [];
  const queueInvalidRetry = (index, point, cycleNumber) => {
    invalidRetryQueue.push({ index, point: { ...point }, cycleNumber });
  };

  for (let cycleOffset = 0; cycleOffset < requiredCycles && !testAborted; cycleOffset++) {
    const cycleNumber = Math.max(1, Number(config.test?.cycleNumber) || 1) + cycleOffset;
    if (requiredCycles > 1) logEvent(`Validation cycle ${cycleOffset + 1}/${requiredCycles} (cycle number ${cycleNumber})`, 'state');
    if (cycleOffset > 0) {
      setStateFlow('home');
      const cycleHomeRes = await withCommandInFlight(homeYThenX);
      if (!cycleHomeRes.success) {
        await finishSequence('fail', `Cycle ${cycleOffset + 1} home failed: ${faultReasonFor(cycleHomeRes)}`);
        return;
      }
      logEvent(`Cycle ${cycleOffset + 1}: homed X/Y`, 'state');
    }
  for (let i = 0; i < seq.length && !testAborted; i++) {
    const p = seq[i];
    seqIdx = cycleOffset * seq.length + i + 1;
    updateSeqProgress();

    if (!withinLimits(p)) {
      const reason = generatedPointIssue(p, i) || 'Position is outside configured fixture travel or DUT safety limits';
      logEvent(`Position ${i + 1} (X${p.x} Y${p.y}) blocked before motion: ${reason}`, 'error');
      recordObservation(i + 1, p, null, null, null, { cycleNumber, valid: false, invalidReason: reason });
      await finishSequence('fail', reason);
      return;
    }

    setStateFlow('move');
    showTargetMarker(p);
    const moveStartMs = Date.now();
    const feed = Math.max(config.motion.x.speedMmS, config.motion.y.speedMmS);
    const dynamicTimeoutMs = moveTimeoutFor(p);
    let moveRes = await withCommandInFlight(() => moveAlongSafeRoute(p, feed, dynamicTimeoutMs));
    if (!moveRes.success && ['ERR004', 'ERR005'].includes(moveRes.code)) {
      logEvent(`Position ${i + 1}: command timed out; checking actual fixture position before retry`, 'warn');
      if (await waitForTargetPosition(p)) {
        moveRes = { success: true, elapsedMs: Date.now() - moveStartMs, recovered: true };
        writeLogRow(i + 1, p, 'MOVE_TIMEOUT_RECOVERED', { moveDurationMs: moveRes.elapsedMs, attemptNumber: 1 });
      } else if (!testAborted && motionEnabled()) {
        logEvent(`Position ${i + 1}: target not confirmed; retrying the same target once`, 'warn');
        const retry = await withCommandInFlight(() => moveAlongSafeRoute(p, feed, dynamicTimeoutMs * 2));
        moveRes = { ...retry, elapsedMs: Date.now() - moveStartMs };
        writeLogRow(i + 1, p, retry.success ? 'MOVE_RETRY_COMPLETE' : 'MOVE_RETRY_FAILED', { moveDurationMs: moveRes.elapsedMs, attemptNumber: 2, notes: retry.error || '' });
      }
    }
    hideTargetMarker();
    pushChartSample();

    if (!moveRes.success) {
      writeLogRow(i + 1, p, 'MOVE_FAILED', { notes: moveRes.error });
      recordObservation(i + 1, p, null, null, moveRes.elapsedMs, { cycleNumber, valid: false, invalidReason: `Move failed: ${moveRes.error}` });
      await finishSequence('fail', faultReasonFor(moveRes));
      return;
    }
    logEvent(`Position ${i + 1}/${seq.length}: moved to X${p.x} Y${p.y} in ${moveRes.elapsedMs}ms`, 'state');
    writeLogRow(i + 1, p, 'MOVE_COMPLETE', { moveDurationMs: moveRes.elapsedMs });

    setStateFlow('settle');
    if (testAborted) break;
    const preSpinWaitMs = Math.max(0, Number(config.trigger.delayMs) || 3000);
    const baselinePromise = waitForRadarLow(preSpinWaitMs);
    await sleep(preSpinWaitMs);
    const baselineRes = await baselinePromise;
if (!baselineRes.success) {
  if (baselineRes.aborted) break;
  recordObservation(i + 1, p, null, null, moveRes.elapsedMs, {
    cycleNumber,
    valid: false,
    invalidReason: 'Radar remained HIGH before trigger; no clean LOW baseline',
  });
  queueInvalidRetry(i + 1, p, cycleNumber);
  logEvent(`Point ${i + 1}: INVALID — radar remained HIGH before trigger`, 'error');
  positionsRun++;
  updateCounters();
  if (!(await logWritesReady())) return;
  continue;
}

    setStateFlow('trigger');
    if (testAborted) break;
const triggerSentMs = Date.now();

commandInFlight = true;
updateStatusGrid();

const triggerPromise = radarAPI.trigger(config.trigger.spinFeedMmMin || 14000);
const detectionPromise = waitForRadarHigh(config.radar.timeoutMs, triggerSentMs);
const trigRes = await triggerPromise;

commandInFlight = false;
updateStatusGrid();

pushChartSample();

if (!trigRes.success) {
  writeLogRow(i + 1, p, 'TRIGGER_FAILED', { notes: trigRes.error });
  recordObservation(i + 1, p, null, null, moveRes.elapsedMs, { cycleNumber, valid: false, invalidReason: `Trigger failed: ${trigRes.error}` });
  await finishSequence('fail', faultReasonFor(trigRes));
  return;
}

    setStateFlow('hold');
    const postSpinWaitMs = Math.max(0, Number(p.holdMs ?? config.trigger.holdMsDefault) || 3000);
    const postSpinWaitPromise = sleep(postSpinWaitMs);
const detectionRes = await detectionPromise;
    await postSpinWaitPromise;

triggersSent++;
updateCounters();
flashTravelDot();
phaseMarkers.push({ xSec: (triggerSentMs - chartSampleT0) / 1000 });

if (detectionRes.valid === false) {
  logEvent(`Radar measurement invalid at position ${i + 1}: ${detectionRes.error}`, 'error');
} else if (detectionRes.detected) {
  logEvent(`Radar detected at position ${i + 1} — latency: ${detectionRes.latencyMs}ms`, 'pass');
} else {
  logEvent(`Radar missed at position ${i + 1} — no GPIO HIGH within ${config.radar.timeoutMs}ms`, 'warn');
}

const observation = recordObservation(i + 1, p, detectionRes.detected, detectionRes.latencyMs, moveRes.elapsedMs, {
  cycleNumber,
  radarSensors: detectionRes.sensors,
  activeRadarTarget: detectionRes.activeTarget,
  ...detectionRes,
  valid: detectionRes.valid !== false,
  invalidReason: detectionRes.valid === false ? detectionRes.error : '',
  notes: detectionRes.valid === false ? detectionRes.error : detectionRes.detected ? 'Radar triggered' : 'Radar timeout',
});
if (!(await logWritesReady())) return;
if (observation.valid === false) queueInvalidRetry(i + 1, p, cycleNumber);
const outcomeLabels = { TP: 'TRUE POSITIVE', TN: 'TRUE NEGATIVE', FP: 'FALSE POSITIVE', FN: 'FALSE NEGATIVE', INVALID: 'INVALID', UNASSESSED: 'UNSCORED' };
if (['characterization', 'interference'].includes(activeTestId())) {
  const pairOutput = activeTestId() === 'interference' ? ` — sensor output: ${observation.triggeredSensors}` : '';
  logEvent(`Point ${i + 1}: RADAR TRIGGERED ${observation.valid === false ? 'INVALID' : observation.actualDetected ? 'YES' : 'NO'}${pairOutput}`, observation.valid === false ? 'error' : observation.actualDetected ? 'pass' : 'info');
} else {
  logEvent(`Point ${i + 1}: ${outcomeLabels[observation.outcome] || observation.outcome}`, observation.outcome === 'FP' || observation.outcome === 'FN' ? 'fail' : observation.outcome === 'TP' || observation.outcome === 'TN' ? 'pass' : 'info');
}

lastMetrics.pos = `${p.x}, ${p.y}, ${p.z}`;
lastMetrics.moveDurationMs = moveRes.elapsedMs;
lastMetrics.latencyMs = detectionRes.latencyMs;
updateMetricsPanel();
    if (testAborted) break;

    positionsRun++;
    updateCounters();
    setStateFlow('next');
  }
  }

  async function retryInvalidMeasurement(item, attemptNumber) {
    const { index, point: p, cycleNumber } = item;
    setStateFlow('move');
    showTargetMarker(p);
    const moveStartMs = Date.now();
    const feed = Math.max(config.motion.x.speedMmS, config.motion.y.speedMmS);
    const moveRes = await withCommandInFlight(() => moveAlongSafeRoute(p, feed, moveTimeoutFor(p)));
    hideTargetMarker();
    if (!moveRes.success) {
      recordObservation(index, p, null, null, Date.now() - moveStartMs, { cycleNumber, attemptNumber, valid: false, invalidReason: `Move failed: ${moveRes.error}`, notes: `Retry ${attemptNumber - 1}/3` });
      await finishSequence('fail', faultReasonFor(moveRes));
      return null;
    }
    setStateFlow('settle');
    const baselineWaitMs = Math.max(0, Number(config.trigger.delayMs) || 3000);
    const baselinePromise = waitForRadarLow(baselineWaitMs);
    await sleep(baselineWaitMs);
    const baselineRes = await baselinePromise;
    if (!baselineRes.success) {
      if (!baselineRes.aborted) recordObservation(index, p, null, null, moveRes.elapsedMs, {
        cycleNumber, attemptNumber, valid: false,
        invalidReason: 'Radar remained HIGH before trigger; no clean LOW baseline', notes: `Retry ${attemptNumber - 1}/3`,
      });
      if (!(await logWritesReady())) return null;
      return false;
    }
    setStateFlow('trigger');
    const triggerSentMs = Date.now();
    commandInFlight = true;
    updateStatusGrid();
    const triggerPromise = radarAPI.trigger(config.trigger.spinFeedMmMin || 14000);
    const detectionPromise = waitForRadarHigh(config.radar.timeoutMs, triggerSentMs);
    const trigRes = await triggerPromise;
    commandInFlight = false;
    updateStatusGrid();
    if (!trigRes.success) {
      recordObservation(index, p, null, null, moveRes.elapsedMs, { cycleNumber, attemptNumber, valid: false, invalidReason: `Trigger failed: ${trigRes.error}`, notes: `Retry ${attemptNumber - 1}/3` });
      await finishSequence('fail', faultReasonFor(trigRes));
      return null;
    }
    setStateFlow('hold');
    const holdPromise = sleep(Math.max(0, Number(p.holdMs ?? config.trigger.holdMsDefault) || 3000));
    const detectionRes = await detectionPromise;
    await holdPromise;
    triggersSent++;
    updateCounters();
    const observation = recordObservation(index, p, detectionRes.detected, detectionRes.latencyMs, moveRes.elapsedMs, {
      cycleNumber, attemptNumber, radarSensors: detectionRes.sensors, activeRadarTarget: detectionRes.activeTarget, ...detectionRes,
      valid: detectionRes.valid !== false, invalidReason: detectionRes.valid === false ? detectionRes.error : '',
      notes: detectionRes.valid === false ? `Retry ${attemptNumber - 1}/3: ${detectionRes.error}` : `Resolved on retry ${attemptNumber - 1}/3`,
    });
    if (!(await logWritesReady())) return null;
    logEvent(`Point ${index}, cycle ${cycleNumber}: ${observation.valid === false ? 'still INVALID' : `valid on retry ${attemptNumber - 1}/3`}`, observation.valid === false ? 'error' : 'pass');
    return observation.valid !== false;
  }

  for (let attemptNumber = 2; attemptNumber <= 4 && invalidRetryQueue.length && !testAborted; attemptNumber++) {
    const pending = invalidRetryQueue.splice(0);
    logEvent(`Retrying ${pending.length} invalid point/cycle measurement(s) — attempt ${attemptNumber - 1}/3`, 'state');
    for (const item of pending) {
      const resolved = await retryInvalidMeasurement(item, attemptNumber);
      if (testAborted || !testRunning || resolved === null) return;
      if (!resolved) invalidRetryQueue.push(item);
    }
  }
  if (invalidRetryQueue.length && !testAborted) logEvent(`${invalidRetryQueue.length} point/cycle measurement(s) remained invalid after 3 retries`, 'error');

  let returnFailure = '';
  if (!testAborted) {
    setStateFlow('return');
    logEvent('Sequence complete — returning fixture to home', 'state');
    const returnRes = await withCommandInFlight(homeYThenX);
    if (!returnRes.success) returnFailure = faultReasonFor(returnRes);
  }

  lastMetrics.seqDurationMs = Date.now() - seqStartMs;
  updateMetricsPanel();
  let finalMode = testAborted ? 'fail' : 'pass';
  let finalReason = testAborted ? 'Sequence aborted' : 'Sequence complete — fixture returned home';
  const summary = currentSummary();
  if (returnFailure) {
    finalMode = 'fail';
    finalReason = `Fixture failed to return home: ${returnFailure}`;
  } else if (!testAborted && currentRunDefinition?.acceptance) {
    finalMode = summary.accepted ? 'pass' : 'fail';
    finalReason = `${summary.correct}/${summary.assessed} correct (${summary.correctRate === null ? '—' : (summary.correctRate*100).toFixed(1)+'%'}; ${Number((currentRunDefinition.acceptance.minimumCorrectRate*100).toFixed(1))}% required), ${summary.counts.FP} FP, ${summary.counts.FN} FN, ${summary.counts.INVALID} invalid, ${summary.cyclesCompleted}/${currentRunDefinition.acceptance.cyclesRequired} cycles`;
  } else if (!testAborted && ['characterization', 'interference'].includes(activeTestId())) {
    finalMode = 'complete';
    finalReason = `${activeTestId() === 'interference' ? 'Interference characterization complete — no acceptance criteria applied' : 'Characterization complete'} — ${summary.total} raw trigger measurements captured`;
  }
  await finishSequence(finalMode, finalReason);
}

async function runRepeatedSingleTests() {
  if (repeatedSingleRunActive || testRunning) return;
  const repeats = Math.max(1, Math.floor(Number(config.test?.singleRunRepeats) || 1));
  repeatedSingleRunActive = true;
  try {
    for (let repeat = 1; repeat <= repeats; repeat += 1) {
      if (!motionEnabled()) break;
      logEvent(`Single-test repeat ${repeat} of ${repeats} starting`, 'state');
      await runSequence();
      if (!motionEnabled() || ['shutdown', 'error'].includes(klippyState)) break;
    }
  } finally {
    repeatedSingleRunActive = false;
    updateQuickRunPanel();
  }
}

/** Finalizes UI state, summary data, logging, and the HTML report. */
async function finishSequence(mode, reason) {
  try {
    await flushLogWrites();
  } catch (error) {
    mode = 'fail';
    reason = `Observation logging failed: ${error?.message || error}`;
  }
  if (mode === 'fail') { faultCount++; updateCounters(); }
  testRunning = false;
  testAborted = false;
  updateEngineeringSetupEditability();
  setStartBtn(motionEnabled() ? 'idle' : 'disabled');
  setStateFlow(null);
  setResult(mode, reason);
  updateQuickRunPanel();
  const completed = mode === 'pass' || mode === 'complete';
  logEvent(completed ? `Result: COMPLETE — ${reason}` : `Result: FAIL — ${reason}`, completed ? 'pass' : 'fail');
  const completedTestType = currentPreparedRun?.plan?.testType || activeTestId();
  const summary = { runId: currentRunId, testId: completedTestType, ...currentSummary() };
  const aggregates = currentPointAggregates();
  const closeResult = await radarAPI.logClose({
    summary,
    report: {
      runId: currentRunId,
      recipe: RecipeCore.snapshot(activeRecipe()),
      testPlan: currentPreparedRun?.plan || activeTestPlan(),
      runSetup: currentPreparedRun?.setup || currentRunSetup(),
      preparedRun: currentPreparedRun,
      testId: completedTestType,
      testName: currentRunDefinition?.name || completedTestType,
      dutId: currentPreparedRun?.setup?.dutId || config.test?.dutId || '',
      campaignId: config.campaign?.active?.id || '',
      campaignName: config.campaign?.active?.name || '',
      campaignConditionId: config.test?.campaignConditionId || '',
      campaignRunNumber: config.test?.campaignRunNumber || 0,
      campaignRepeatNumber: config.test?.campaignRepeatNumber || 0,
      cyclesPlanned: currentPreparedRun?.acceptanceRules?.cyclesRequired || configuredCycleCount(),
      activeSequence: config.activeSequence,
      plannedPositions: (config.sequences?.[config.activeSequence] || []).map((point) => ({
        pointId: point.pointId,
        x: point.x,
        y: point.y,
        z: point.z,
      })),
      result: mode === 'pass' ? 'PASS' : mode === 'complete' ? 'COMPLETE' : 'FAIL',
      reason,
      durationMs: lastMetrics.seqDurationMs,
      activeTarget: activeRadarTarget(),
      radarSettings: RadarSettingsCore.traceabilitySnapshot(radarSettingsState),
      geometry: validationGeometry(),
      boundary: ['inside', 'outside', 'system'].includes(activeTestId()) ? ValidationCore.activationZoneBoundaries(validationGeometry()).flat() : [],
      boundaryShapes: (ValidationCore.usesDualSystemBands(validationGeometry())
        || (validationGeometry().sensorLayout === 'single' && hasDutFootprint()))
        ? ValidationCore.systemBandBoundaries(dutReferenceBandGeometry(validationGeometry())) : [],
      observations: currentObservations,
      aggregates,
    },
  });
  if (!closeResult?.success && closeResult?.error) {
    setResult('fail', closeResult.error);
    logEvent(closeResult.error, 'error');
  }
  await radarAPI.endQualificationRun();
  if (closeResult?.reportPath) logEvent(`HTML report generated: ${closeResult.reportPath}`, 'info');
  if (closeResult?.campaign?.localComplete) {
    logEvent('Campaign result saved locally; report.html and observations.csv are available.', 'info');
  }
  if (closeResult?.campaign?.record) {
    const campaign = closeResult.campaign;
    if (campaign.duplicate) {
      logEvent('Campaign result was already recorded; duplicate local entry was skipped', 'info');
    } else if (!closeResult?.campaign?.localComplete) {
      logEvent(`Campaign result recorded locally (${campaign.record.gain}, threshold ${campaign.record.threshold})`, 'pass');
    }
  } else if (closeResult?.campaign?.error) {
    logEvent(`Campaign automation error; normal run artifacts are safe: ${closeResult.campaign.error}`, 'error');
  }
  await refreshCampaignOperator();
  updateStatusGrid();
}

/** Implements the with command in flight operation for this module. */
async function withCommandInFlight(fn) {
  commandInFlight = true;
  updateStatusGrid();
  try {
    return await fn();
  } finally {
    commandInFlight = false;
    updateStatusGrid();
  }
}

/** Checks whether values are within limits. */
function withinLimits(p) {
  const rx = config.motion.x, ry = config.motion.y;
  return p.x >= rx.minMm && p.x <= rx.maxMm &&
         p.y >= ry.minMm && p.y <= ry.maxMm &&
         !DutLocationCore.pointInNoGo(p, activeDutLocation(), { clearanceMm: reflectorClearanceMm() }) &&
         (activeSensorLayout() !== 'dual' || !DutLocationCore.pointBehindDut(p, activeDutLocation()));
}

/** Computes a move timeout from distance and canonical configured speed (mm/s). */
function moveTimeoutFor(target, origin = position) {
  const distanceMm = Math.hypot(Number(target.x) - Number(origin.x), Number(target.y) - Number(origin.y));
  const speedMmS = Math.max(0.001, Number(config.motion.x.speedMmS) || 0, Number(config.motion.y.speedMmS) || 0);
  const expectedMs = distanceMm / speedMmS * 1000;
  return Math.max(Number(config.trigger.positionTimeoutMs) || 30000, Math.ceil(expectedMs * 1.75 + 15000));
}

// ─── Safe motion routing ─────────────────────────────────────────────────────

function fixtureXyBounds() {
  const x = axisVisualRange('x'), y = axisVisualRange('y');
  return { minX: x.min, maxX: x.max, minY: y.min, maxY: y.max };
}

function configuredHomePoint() {
  return {
    x: Number(config.motion?.x?.homeOffsetMm) || 0,
    y: Number(config.motion?.y?.homeOffsetMm) || 0,
  };
}

/** Applies one shared, deterministic route-wide shortest-trajectory optimization to every test type. */
function optimizedExecutionPoints(points, start = lastConfirmedHomePoint || configuredHomePoint()) {
  const safety = DutLocationCore.evaluatePlan(points, start, activeDutLocation(), motionKeepoutOptions());
  return safety.safe ? safety.ordered : [...points];
}

/** Moves automated tests around the front of the selected DUT footprint. */
async function moveAlongSafeRoute(target, feed, timeoutMs) {
  const route = DutLocationCore.safeRoute(position, target, activeDutLocation(), motionKeepoutOptions());
  if (!route.length) return { success: false, code: 'ERR008', error: 'Target is inside the DUT no-go zone' };
  let result = { success: true };
  let legStart = { x: Number(position.x), y: Number(position.y) };
  for (const waypoint of route) {
    if (DutLocationCore.segmentIntersectsNoGo(legStart, waypoint, activeDutLocation(), { clearanceMm: reflectorClearanceMm() })) {
      return { success: false, code: 'ERR008', error: 'Calculated route would cross the DUT no-go zone' };
    }
    result = await radarAPI.moveAndWait(waypoint.x, waypoint.y, undefined, feed, timeoutMs);
    if (!result.success) return result;
    legStart = waypoint;
  }
  return result;
}

/** Waits for status polling to confirm that a timed-out command reached its target. */
async function waitForTargetPosition(target, timeoutMs = 15000, toleranceMm = 1) {
  const deadline = Date.now() + timeoutMs;
  while (!testAborted && Date.now() < deadline) {
    if (Math.hypot(Number(position.x) - Number(target.x), Number(position.y) - Number(target.y)) <= toleranceMm) return true;
    await sleep(250);
  }
  return false;
}

/** Writes log row. */
function writeLogRow(idx, p, event, extra = {}) {
  return queueLogWrite({
    idx,
    x: p.x,
    y: p.y,
    z: p.z,
    event,
    ...extra,
  });
}

// ─── Jog / Home / E-Stop wiring ───────────────────────────────────────────────
/** Attaches UI event handlers for motion buttons. */
function wireMotionButtons() {
  document.querySelectorAll('.jog-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const axis = btn.dataset.axis;
      const stepSel = parseFloat(document.getElementById('jog-step-sel').value);
      const dirSign = Math.sign(parseFloat(btn.dataset.dir));
      // Outer buttons (data-dir -1/1) jog 10x the selected step; inner buttons (data-dir -0.1/0.1) jog the step itself.
      const isOuter = Math.abs(parseFloat(btn.dataset.dir)) >= 1;
      const delta = (isOuter ? stepSel * 10 : stepSel) * dirSign;
      const predicted = position[axis] + delta;
      const limits = config.motion[axis];
      if (predicted < limits.minMm || predicted > limits.maxMm) {
        logEvent(`Jog ${axis.toUpperCase()}${delta > 0 ? '+' : ''}${delta} would exceed configured travel limit — blocked`, 'warn');
        return;
      }
      const target = { ...position, [axis]: predicted };
      if (DutLocationCore.segmentIntersectsNoGo(position, target, activeDutLocation(), { clearanceMm: reflectorClearanceMm() })) {
        logEvent(`Jog blocked: path would enter the DUT no-go zone`, 'error');
        return;
      }
      const res = await withCommandInFlight(() => radarAPI.jog(axis, delta, limits.speedMmS));
      if (!res.success) logEvent(`Jog ${axis.toUpperCase()} failed: ${faultReasonFor(res)}`, 'error');
    });
  });

  document.getElementById('home-all-btn').addEventListener('click', async () => {
    logEvent('Homing X/Y…', 'state');
    const res = await withCommandInFlight(homeYThenX);
    logEvent(res.success ? 'Home All complete' : `Home All failed: ${faultReasonFor(res)}`, res.success ? 'state' : 'error');
  });
  document.getElementById('home-x-btn').addEventListener('click', async () => {
    const res = await withCommandInFlight(() => radarAPI.home(['x']));
    logEvent(res.success ? 'Home X complete' : `Home X failed: ${faultReasonFor(res)}`, res.success ? 'state' : 'error');
  });
  document.getElementById('home-y-btn').addEventListener('click', async () => {
    const res = await withCommandInFlight(() => radarAPI.home(['y']));
    logEvent(res.success ? 'Home Y complete' : `Home Y failed: ${faultReasonFor(res)}`, res.success ? 'state' : 'error');
  });
  document.getElementById('zero-z-btn').addEventListener('click', async () => {
    const res = await withCommandInFlight(() => radarAPI.zeroZ());
    logEvent(res.success ? 'Z zeroed at current position' : `Zero Z failed: ${faultReasonFor(res)}`, res.success ? 'state' : 'error');
  });

  document.getElementById('estop-btn').addEventListener('click', async () => {
    campaignAutoRunStopRequested = true;
    if (testRunning) testAborted = true;
    logEvent('EMERGENCY STOP triggered', 'error');
    await radarAPI.abortRun('Operator activated emergency stop');
    await radarAPI.estop();
  });
  document.getElementById('clear-estop-btn').addEventListener('click', async () => {
    logEvent('Sending firmware restart to clear E-Stop / fault…', 'warn');
    const res = await radarAPI.firmwareRestart();
    logEvent(res.success ? 'Firmware restart sent — re-home before running a sequence' : `Firmware restart failed: ${res.error}`, res.success ? 'warn' : 'error');
  });

  document.getElementById('start-btn').addEventListener('click', () => {
    if (testRunning) {
      testAborted = true;
      void radarAPI.abortRun('Operator aborted the active run');
      logEvent('Abort requested — sending emergency stop', 'warn');
      radarAPI.estop();
      return;
    }
    void runRepeatedSingleTests();
  });
}

// ─── Connection wiring ────────────────────────────────────────────────────────
/** Attaches UI event handlers for connection. */
function wireConnection() {
  document.getElementById('conn-btn').addEventListener('click', async () => {
    if (connected) {
      await radarAPI.disconnect();
      connected = false;
      klippyState = 'unknown';
      radarSettingsServiceOnline = false;
      radarSettingsState = null;
      radarSettingsDirty = false;
      document.getElementById('conn-btn').textContent = 'Connect';
      document.getElementById('conn-btn').className = 'btn-connect';
      logEvent('Disconnected from fixture', 'info');
      renderRadarSettings();
      updateStatusGrid();
      return;
    }
    const host = document.getElementById('conn-host').value.trim() || config.connection.host;
    const port = parseInt(document.getElementById('conn-port').value, 10) || config.connection.port;
    logEvent(`Connecting to ${host}:${port}…`, 'info');
    const res = await radarAPI.connect(host, port);
    if (res.success) {
      connected = true;
      config.connection = { host, port };
      document.getElementById('conn-btn').textContent = 'Disconnect';
      document.getElementById('conn-btn').className = 'btn-connect connected';
      logEvent(`Connected to fixture at ${host}:${port}`, 'info');
      await refreshRadarSettings(true);
    } else {
      logEvent(`Connect failed: ${faultReasonFor(res)}`, 'error');
    }
    updateStatusGrid();
  });
}

// ─── Config modal ─────────────────────────────────────────────────────────────
/** Updates config mode visibility. */
function updateConfigModeVisibility() {
  const testId = activeTestId();
  const capabilities = activeTestCapabilities();
  const formalMode = ['inside', 'outside', 'system'].includes(testId);
  const customMode = testId === 'custom';
  const characterizationMode = testId === 'characterization';
  const setVisible = (id, visible) => {
    const element = document.getElementById(id);
    if (element) element.style.display = visible ? '' : 'none';
  };

  setVisible('builder-plan-settings', true);
  // Radar hardware and fixture geometry affect every run, including custom,
  // unscored, and interference plans. Keep Engineering Setup available in
  // every mode while leaving the mode-specific plan-building controls gated.
  setVisible('builder-validation-geometry', true);
  setVisible('builder-general-generator', capabilities.planSource);
  setVisible('builder-csv-import', capabilities.planSource);
  setVisible('builder-positions', capabilities.planSource);
  setVisible('builder-trigger-timing', true);
  document.querySelectorAll('.builder-main-owned').forEach((element) => { element.style.display = 'none'; });
  document.querySelectorAll('.builder-custom-only').forEach((element) => { element.style.display = customMode ? '' : 'none'; });
  document.querySelectorAll('.builder-formal-operator-control').forEach((element) => { element.style.display = formalMode ? 'none' : ''; });
  setVisible('engineering-plan-pass-row', ['inside', 'outside', 'system', 'custom'].includes(testId));

  const sequenceTab = document.getElementById('config-sequence-tab');
  sequenceTab.style.display = '';
  sequenceTab.textContent = 'Test Plans';
  document.querySelector('#config-modal .modal-title').textContent = 'Engineering Settings';
  if (formalMode) {
    const systemGeometry = validationGeometry();
    document.getElementById('builder-validation-title').textContent = 'Formal Test Geometry (Engineering)';
    document.getElementById('builder-validation-note').textContent = config.validation?.sensorLayout === 'dual'
      ? `System-level distance is measured from the nearest DUT edge. Test 10.1 covers ${systemGeometry.requiredTriggerMm} mm; Test 10.2 begins beyond ${systemGeometry.requiredNoTriggerMm} mm. Edit these barriers on the System Level tab.`
      : 'These calibrated values scale the single-sensor detection lobe. Test 10.1 covers the full 12-inch area through its boundary. The guard band applies only to negative Test 10.2. Applying geometry changes automatically regenerates the selected formal plan.';
  } else if (characterizationMode) {
    document.getElementById('builder-validation-title').textContent = 'Characterization Engineering Setup';
    document.getElementById('builder-validation-note').textContent = 'Select the installed radar hardware and configure the characterization footprint, point count, and angular coverage. Apply changes before starting a new run; the active run keeps the plan it started with.';
  } else {
    document.getElementById('builder-validation-title').textContent = 'Detection Geometry & Validation Plan';
    document.getElementById('builder-validation-note').textContent = 'Both plans face toward decreasing Y. Test 10.1 fills the complete 12-inch lobe through its boundary. The guard band applies only to Test 10.2, which fills the surrounding negative-test band through the configured outer depth.';
  }
  updateEngineeringSetupEditability();
}

function updateConfigTabPresentation(tab = 'motion') {
  const planTab = tab === 'sequence';
  const title = document.querySelector('#config-modal .modal-title');
  const apply = document.getElementById('config-apply-btn');
  if (title) title.textContent = planTab ? 'Test Plan Editor' : 'Engineering Settings';
  if (apply) apply.textContent = planTab ? 'Save Test Plan' : 'Apply Settings';
}

let engineeringPlanPreviewRaf = null;
function scheduleEngineeringPlanPreview() {
  if (engineeringPlanPreviewRaf !== null) cancelAnimationFrame(engineeringPlanPreviewRaf);
  engineeringPlanPreviewRaf = requestAnimationFrame(() => {
    engineeringPlanPreviewRaf = null;
    const bounds = {
      minX: Number(document.getElementById('cfg-plan-min-x').value), maxX: Number(document.getElementById('cfg-plan-max-x').value),
      minY: Number(document.getElementById('cfg-plan-min-y').value), maxY: Number(document.getElementById('cfg-plan-max-y').value),
    };
    if (!Object.values(bounds).every(Number.isFinite) || bounds.minX >= bounds.maxX || bounds.minY >= bounds.maxY) return;
    const savedConfig = config;
    try {
      config = {
        ...config,
        test: { ...(config.test || {}), mode: document.getElementById('cfg-test-mode').value },
        validation: { ...(config.validation || {}), pointCount: Math.max(1, Number(document.getElementById('cfg-validation-point-count').value) || 1),
          pointDistribution: document.getElementById('cfg-plan-distribution').value, characterizationBounds: bounds },
      };
      const testType = config.test.mode;
      let preview;
      if (['inside', 'outside'].includes(testType)) preview = buildFormalValidationPlan(testType);
      else if (testType === 'system') preview = buildSystemValidationPlan(config.validation?.angularZone || 'front', config.validation.pointCount);
      else if (['characterization', 'interference'].includes(testType)) preview = buildCharacterizationPlan();
      else preview = { points: config.sequences?.[config.activeSequence] || [], summary: 'Saved manual/imported positions' };
      if (preview?.points?.length) {
        renderPlanPreviewCanvas(preview.points, preview.summary || '', 'seq-plan-preview');
        renderPlanPreviewCanvas(preview.points, preview.summary || '', 'quick-formal-preview');
      }
    } finally {
      config = savedConfig;
    }
  });
}

let quickPointPreviewRaf = null;
function scheduleQuickPointPreview() {
  if (quickPointPreviewRaf !== null) cancelAnimationFrame(quickPointPreviewRaf);
  quickPointPreviewRaf = requestAnimationFrame(() => {
    quickPointPreviewRaf = null;
    const input = document.getElementById('quick-point-count');
    const requestedCount = Math.floor(Number(input?.value));
    if (!Number.isFinite(requestedCount) || requestedCount < 1 || requestedCount > 2000) return;
    const testType = activeTestId();
    if (!['inside', 'outside', 'system', 'characterization', 'interference'].includes(testType)) return;
    const savedConfig = config;
    try {
      config = { ...config, validation: { ...(config.validation || {}), pointCount: requestedCount } };
      let preview;
      if (['inside', 'outside'].includes(testType)) preview = buildFormalValidationPlan(testType);
      else if (testType === 'system') preview = buildSystemValidationPlan(config.validation?.angularZone || 'front', requestedCount);
      else preview = buildCharacterizationPlan();
      if (preview?.points?.length) renderPlanPreviewCanvas(preview.points, preview.summary || '', 'quick-formal-preview');
      else if (preview?.error) renderPlanPreviewCanvas([], preview.error, 'quick-formal-preview');
    } finally {
      config = savedConfig;
    }
  });
}

/** Keeps Engineering Setup text fields editable for every test type. */
function updateEngineeringSetupEditability() {
  document.querySelectorAll(
    '#builder-plan-settings input, #builder-validation-geometry input, #builder-trigger-timing input, #system-level-barriers input',
  ).forEach((field) => {
    if (field.id === 'cfg-radar-baseline-timeout') return;
    field.disabled = false;
    field.readOnly = false;
  });

  const derivedBaselineTimeout = document.getElementById('cfg-radar-baseline-timeout');
  if (derivedBaselineTimeout) derivedBaselineTimeout.disabled = true;

  const applyButton = document.getElementById('config-apply-btn');
  const recipeSaveButton = document.getElementById('recipe-save-btn');
  const runNote = document.getElementById('config-active-run-note');
  const applyBlockedForActiveRun = testRunning;
  if (applyButton) applyButton.disabled = applyBlockedForActiveRun;
  if (recipeSaveButton) recipeSaveButton.disabled = applyBlockedForActiveRun;
  if (runNote) runNote.hidden = !applyBlockedForActiveRun;
}

/** Opens config modal. */
function openConfigModal(initialTab = null) {
  ConfigurationDraft.open(config);
  appStore.dispatch({ type: 'CONFIG_DRAFT_OPENED', config });
  populateConfigForm();
  engineeringPlanState.deletedIds = new Set();
  engineeringPlanState.selectedId = config.recipes?.activeId;
  engineeringPlanState.original = RecipeCore.snapshot(activeRecipe());
  engineeringPlanState.isNew = false;
  populateEngineeringPlanSelect(engineeringPlanState.selectedId);
  document.getElementById('engineering-plan-name').value = activeRecipe().builtIn ? `${activeRecipe().name} Custom` : activeRecipe().name;
  document.getElementById('engineering-plan-description').value = activeRecipe().description || '';
  engineeringPlanState.originalSignature = engineeringPlanSignature(engineeringRecipeFromConfig());
  setEngineeringPlanStatus(activeRecipe());
  populateRecipeBuilder(activeRecipe());
  updateConfigModeVisibility();
  updateEngineeringSetupEditability();
  seedGeneratorDefaults();
  updateGeneratorPanelVisibility();
  previewGenerator();
  if (document.getElementById('seq-import-csv')?.value) previewImportedCsv();
  document.getElementById('config-modal').classList.add('show');
  if (typeof initialTab === 'string') document.querySelector(`.tab-btn[data-tab="${initialTab}"]`)?.click();
  else updateConfigTabPresentation(document.querySelector('#config-modal .tab-btn.active')?.dataset.tab || 'motion');
}

/** Closes config modal. */
function closeConfigModal() {
  if (ConfigurationDraft.isOpen()) {
    config = ConfigurationDraft.discard() || config;
    appStore.dispatch({ type: 'CONFIG_DRAFT_DISCARDED' });
  }
  document.getElementById('config-modal').classList.remove('show');
  renderSpatialResults();
  updateQuickRunPanel();
}

/** Refreshes the plain-language campaign card and dashboard. */
async function refreshCampaignOperator() {
  const status = await radarAPI.campaignStatus();
  if (!status?.success) return;
  campaignOperatorStatus = status;
  // Campaign completion is persisted before this status refresh. Recompute all
  // quick-run controls now so the final save immediately restores text input.
  updateQuickRunPanel();
  const active = !!status.active;
  const name = document.getElementById('campaign-card-name');
  const progress = document.getElementById('campaign-progress-text');
  const fill = document.getElementById('campaign-progress-fill');
  const next = document.getElementById('campaign-next-condition');
  const sync = document.getElementById('campaign-local-status');
  const primary = document.getElementById('campaign-primary-btn');
  const view = document.getElementById('campaign-view-btn');
  const badge = document.getElementById('campaign-state-badge');
  const autoControl = document.getElementById('campaign-auto-run-control');
  const autoToggle = document.getElementById('campaign-auto-run-toggle');
  if (!active) {
    name.textContent = 'No active campaign';
    progress.textContent = 'Start a campaign to track local reports and CSV results.';
    fill.style.width = '0%';
    next.textContent = '';
    sync.textContent = 'Local results are protected.';
    sync.className = 'campaign-local-status';
    primary.textContent = 'Start New Campaign';
    view.hidden = true;
    autoControl.hidden = true;
    autoToggle.checked = false;
    badge.textContent = 'READY';
    return;
  }
  const percent = status.total ? Math.round(status.completed / status.total * 100) : 0;
  const characterizationCampaign = ['characterization', 'interference'].includes(status.method?.testId);
  name.textContent = status.campaign.name;
  progress.textContent = characterizationCampaign
    ? `${status.completed} of ${status.total} characterization runs complete${status.failed ? ` - ${status.failed} fixture failure(s)` : ''}`
    : `${status.completed} of ${status.total} runs complete - ${status.passed || 0} passed - ${status.failed || 0} failed`;
  fill.style.width = `${percent}%`;
  const nextZone = status.next?.angularZone && status.next.angularZone !== 'all'
    ? ` - ${ValidationCore.ANGULAR_ZONES[status.next.angularZone]?.label || status.next.angularZone}` : ' - Full area';
  next.textContent = status.next ? `Next: Run ${status.next.runNumber} - ${String(status.next.radarTarget).startsWith('rcwl_') ? 'RCWL-0516 fixed output' : status.next.radarTarget === 'ld021' ? `HLK sensitivity threshold ${status.next.threshold}` : `${status.next.gain} / ${status.next.threshold}`}${nextZone} - Repeat ${status.next.repeat}` : 'All runs complete';
  sync.textContent = 'Local report.html and observations.csv are authoritative.';
  sync.className = 'campaign-local-status good';
  primary.textContent = status.next ? 'Prepare Next Run' : 'Review Campaign';
  view.hidden = false;
  autoControl.hidden = false;
  autoToggle.checked = status.method.autoRun === true;
  badge.textContent = status.next ? 'ACTIVE' : 'COMPLETE';
  renderCampaignDashboard();
}

function showCampaignModal(view = 'create') {
  const form = ['create', 'edit'].includes(view);
  campaignFormMode = view === 'edit' ? 'edit' : 'create';
  document.getElementById('campaign-create-view').hidden = !form;
  document.getElementById('campaign-dashboard-view').hidden = form;
  document.getElementById('campaign-modal-title').textContent = view === 'edit' ? 'Edit Campaign' : form ? 'Start New Campaign' : 'Campaign Progress';
  document.getElementById('campaign-modal').classList.add('show');
  if (form) seedCampaignCreateForm(view === 'edit' ? campaignOperatorStatus?.campaign : null);
  if (!form) renderCampaignDashboard();
  if (form) requestAnimationFrame(() => document.getElementById('campaign-name-input')?.focus());
}

function hideCampaignModal() {
  document.getElementById('campaign-modal').classList.remove('show');
}

function renderCampaignDashboard() {
  const status = campaignOperatorStatus;
  if (!status?.active) return;
  const testNames = { inside: 'Test 10.1', outside: 'Test 10.2', system: 'System Level Bounds', characterization: 'Characterization', interference: 'Radar Pair Interference Characterization', custom: 'Custom' };
  const characterizationCampaign = ['characterization', 'interference'].includes(status.method?.testId);
  document.getElementById('campaign-dashboard-name').textContent = status.campaign.name;
  document.getElementById('campaign-dashboard-auto-run-toggle').checked = status.method.autoRun === true;
  document.getElementById('campaign-dashboard-summary').textContent = characterizationCampaign
    ? `${status.completed} of ${status.total} characterization runs complete${status.failed ? ` - ${status.failed} fixture failure(s)` : ''} - ${testNames[status.method.testId] || status.method.testId} - ${status.campaign.dutId}`
    : `${status.completed} of ${status.total} runs complete - ${status.passed || 0} passed - ${status.failed || 0} failed - ${testNames[status.method.testId] || status.method.testId} - ${status.campaign.dutId}`;
  const sync = document.getElementById('campaign-dashboard-sync');
  sync.textContent = 'Local report.html and observations.csv';
  sync.className = 'status-chip';
  document.getElementById('campaign-condition-grid').innerHTML = status.conditions.map((condition) => {
    const isNext = status.next?.id === condition.id;
    const state = condition.complete ? (condition.result || 'Complete') : isNext ? 'Next run' : 'Not run';
    const cls = condition.complete ? `complete ${condition.result === 'FAIL' ? 'fail' : ''}` : isNext ? 'next' : '';
    const zone = condition.angularZone === 'all' ? 'Full area' : ValidationCore.ANGULAR_ZONES[condition.angularZone]?.label || condition.angularZone;
    const setting = String(condition.radarTarget).startsWith('rcwl_') ? 'RCWL-0516 fixed output' : condition.radarTarget === 'ld021' ? `HLK sensitivity threshold ${condition.threshold}` : `${condition.gain} / ${condition.threshold}`;
    return `<div class="campaign-condition ${cls}"><span class="condition-title">Run ${condition.runNumber} - ${escapeHtml(zone)} - ${escapeHtml(setting)}</span><span class="condition-state">Repeat ${condition.repeat} - ${state}</span></div>`;
  }).join('');
  const prepare = document.getElementById('campaign-dashboard-prepare-btn');
  prepare.disabled = !status.next;
  prepare.textContent = status.next ? 'Prepare Next Run' : 'Campaign Complete';
}

function seedCampaignCreateForm(campaign = null) {
  const value = (id, next) => {
    const element = document.getElementById(id);
    if (element && document.activeElement !== element) element.value = next;
  };
  value('campaign-sensor-layout', ['ld021_pair', 'rcwl_pair'].includes(config.validation?.sensorLayout) ? config.validation.sensorLayout : config.validation?.sensorLayout === 'dual' ? 'dual' : 'single');
  updateRadarHardwareOptions(document.getElementById('campaign-radar-target'), document.getElementById('campaign-sensor-layout').value, config.validation?.radarTarget);
  value('campaign-hilink-sensor', config.validation?.hilinkSensor === 'B' ? 'B' : 'A');
  const campaignDut = document.getElementById('campaign-dut-location');
  const dutLocations = Array.isArray(config.dut?.locations) && config.dut.locations.length
    ? config.dut.locations : DutLocationCore.BUILT_IN_LOCATIONS;
  campaignDut.innerHTML = dutLocations.map((location) => `<option value="${escapeHtml(location.id)}">${escapeHtml(location.name)}</option>`).join('');
  campaignDut.value = config.validation?.sensorLayout === 'dual'
    ? config.dut?.activeLocationId || DutLocationCore.DEFAULT_LOCATION.id
    : DutLocationCore.ORIGINAL_LOCATION.id;
  value('campaign-center-x', Number(config.validation?.singleSensor?.centerX) || 875);
  value('campaign-center-y', Number(config.validation?.singleSensor?.centerY) || 1200);
  value('campaign-radius', Number(config.validation?.singleSensor?.radiusMm) || 304.8);
  value('campaign-guard-band', Number(config.validation?.guardBandMm) || 10);
  const bounds = config.validation?.characterizationBounds || {};
  value('campaign-x-min', bounds.minX ?? 0);
  value('campaign-x-max', bounds.maxX ?? 1725);
  value('campaign-y-min', bounds.minY ?? 150);
  value('campaign-y-max', bounds.maxY ?? 1040);
  const selectedZones = config.validation?.angularZoneEnabled
    ? [config.validation?.angularZone || 'front'] : ['all'];
  document.querySelectorAll('#campaign-angular-zone-options input').forEach((input) => {
    input.checked = selectedZones.includes(input.value);
  });
  const custom = document.getElementById('campaign-custom-plan');
  const available = Object.keys(config.sequences || {}).filter((name) => !FORMAL_SEQUENCE_NAMES.has(name));
  custom.innerHTML = available.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
  custom.value = config.test?.lastBuilderSequence && available.includes(config.test.lastBuilderSequence)
    ? config.test.lastBuilderSequence : available[0] || '';
  document.getElementById('campaign-name-input').value = campaign?.name || '';
  document.getElementById('campaign-dut-input').value = campaign?.dutId || config.test?.dutId || '';
  const campaignRecipe = document.getElementById('campaign-recipe-select');
  campaignRecipe.innerHTML = recipeOptionsHtml(campaign?.plan?.recipeId || config.recipes?.activeId);
  campaignRecipe.value = campaign?.plan?.recipeId || config.recipes?.activeId;
  document.querySelectorAll('#campaign-create-view input:not([readonly]), #campaign-create-view select, #campaign-create-view button')
    .forEach((control) => { control.disabled = false; });
  document.getElementById('campaign-create-status').textContent = '';
  document.getElementById('campaign-create-status').className = 'campaign-operation-status';
  const plan = campaign?.plan;
  if (plan) {
    value('campaign-test-type', plan.testId);
    value('campaign-runs-input', plan.runsPerCondition);
    value('campaign-cycles-input', plan.cyclesPerRun);
    value('campaign-points-input', plan.pointCount);
    value('campaign-pass-input', Number(plan.minimumCorrectRate) * 100);
    value('campaign-thresholds-input', plan.thresholds.join(', '));
    document.getElementById('campaign-auto-run-input').checked = plan.autoRun === true;
    document.querySelectorAll('#campaign-gain-options input').forEach((input) => { input.checked = plan.gains.map(Number).includes(Number(input.value)); });
    document.querySelectorAll('#campaign-angular-zone-options input').forEach((input) => { input.checked = (plan.angularZones || ['all']).includes(input.value); });
    value('campaign-sensor-layout', plan.geometry.sensorLayout);
    updateRadarHardwareOptions(document.getElementById('campaign-radar-target'), plan.geometry.sensorLayout, plan.radarTarget);
    value('campaign-radar-target', plan.radarTarget || (plan.geometry.sensorLayout === 'dual' ? 'dual' : 'single'));
    value('campaign-hilink-sensor', plan.hilinkSensor === 'B' ? 'B' : 'A');
    if (plan.geometry.dutLocationId) value('campaign-dut-location', plan.geometry.dutLocationId);
    if (plan.geometry.singleSensor) {
      value('campaign-center-x', plan.geometry.singleSensor.centerX);
      value('campaign-center-y', plan.geometry.singleSensor.centerY);
      value('campaign-radius', plan.geometry.singleSensor.radiusMm);
    }
    value('campaign-guard-band', plan.geometry.guardBandMm);
    value('campaign-x-min', plan.geometry.bounds?.minX);
    value('campaign-x-max', plan.geometry.bounds?.maxX);
    value('campaign-y-min', plan.geometry.bounds?.minY);
    value('campaign-y-max', plan.geometry.bounds?.maxY);
    if (plan.geometry.sequenceName) value('campaign-custom-plan', plan.geometry.sequenceName);
  } else {
    document.getElementById('campaign-auto-run-input').checked = false;
  }
  populateCampaignTestPlanOptions(campaign?.plan?.recipeId || config.recipes?.activeId);
  document.getElementById('campaign-create-btn').textContent = campaign ? 'Save Changes' : 'Create Campaign';
  // A completed/archived campaign may have left dependent controls disabled
  // (custom-plan point count or dual DUT selection). Every new form starts
  // editable; updateCampaignCreatePreview reapplies only those intentional locks.
  document.querySelectorAll('#campaign-create-view input, #campaign-create-view select, #campaign-create-view button')
    .forEach((control) => { if (!control.readOnly) control.disabled = false; });
  updateCampaignCreatePreview();
  if (plan?.runNames) document.querySelectorAll('#campaign-run-name-grid input').forEach((input) => { input.value = plan.runNames[input.dataset.conditionId] || ''; });
}

function applyRecipeToCampaignForm(recipeId) {
  const recipe = RecipeCore.find(config, recipeId);
  if (!recipe) return;
  document.getElementById('campaign-test-type').value = recipe.family;
  document.getElementById('campaign-cycles-input').value = recipe.cycles;
  document.getElementById('campaign-points-input').value = recipe.pointCount;
  if (recipe.scored) document.getElementById('campaign-pass-input').value = Number((recipe.minimumCorrectRate * 100).toFixed(1));
  document.querySelectorAll('#campaign-angular-zone-options input').forEach((input) => { input.checked = recipe.angularZones.includes(input.value); });
  updateCampaignCreatePreview();
}

function campaignPlanFromForm() {
  const numeric = (id) => Number(document.getElementById(id).value);
  const sensorLayout = document.getElementById('campaign-sensor-layout').value;
  const radarTarget = ['ld021_pair', 'rcwl_pair'].includes(sensorLayout) ? sensorLayout : document.getElementById('campaign-radar-target').value;
  const fixedOutput = radarTarget.startsWith('rcwl_');
  const gains = fixedOutput || ['ld021', 'ld021_pair'].includes(radarTarget) ? [] : [...document.querySelectorAll('#campaign-gain-options input:checked')].map((input) => input.value);
  const thresholds = fixedOutput ? [] : document.getElementById('campaign-thresholds-input').value
    .split(/[,\s]+/).map((value) => value.trim()).filter(Boolean).map(Number);
  const testId = document.getElementById('campaign-test-type').value;
  const selectedAngularZones = [...document.querySelectorAll('#campaign-angular-zone-options input:checked')]
    .map((input) => input.value);
  const locations = Array.isArray(config.dut?.locations) && config.dut.locations.length
    ? config.dut.locations : DutLocationCore.BUILT_IN_LOCATIONS;
  const requestedLocationId = sensorLayout === 'dual'
    ? document.getElementById('campaign-dut-location').value : DutLocationCore.ORIGINAL_LOCATION.id;
  const dutLocation = sensorLayout === 'dual'
    ? locations.find((location) => location.id === requestedLocationId) || DutLocationCore.DEFAULT_LOCATION
    : DutLocationCore.SINGLE_SENSOR_LOCATION;
  const dutGeometry = DutLocationCore.geometry(dutLocation);
  const recipeId = document.getElementById('campaign-recipe-select').value;
  const recipeSnapshot = RecipeCore.snapshot(RecipeCore.normalize({
    ...RecipeCore.find(config, recipeId), family: testId,
    pointCount: numeric('campaign-points-input'), cycles: numeric('campaign-cycles-input'),
    minimumCorrectRate: numeric('campaign-pass-input') / 100,
    angularZones: testId === 'custom' ? ['all'] : selectedAngularZones,
    coverageMode: normalizedCoverageMode(config.validation?.coverageMode || RecipeCore.find(config, recipeId)?.coverageMode),
    systemBounds: config.validation?.systemLevel,
    geometry: {
      ...(RecipeCore.find(config, recipeId)?.geometry || {}),
      sensorLayout,
      radarTarget,
      dutLocationId: requestedLocationId,
      reflectorClearanceMm: config.dut?.reflectorClearanceMm,
    },
  }));
  return {
    recipeId,
    recipeSnapshot,
    testId,
    autoRun: document.getElementById('campaign-auto-run-input').checked,
    runsPerCondition: numeric('campaign-runs-input'),
    cyclesPerRun: numeric('campaign-cycles-input'),
    pointCount: numeric('campaign-points-input'),
    minimumCorrectRate: numeric('campaign-pass-input') / 100,
    radarTarget,
    hilinkSensor: document.getElementById('campaign-hilink-sensor').value === 'B' ? 'B' : 'A',
    gains,
    thresholds,
    angularZones: testId === 'custom' ? ['all'] : selectedAngularZones,
    runNames: Object.fromEntries([...document.querySelectorAll('#campaign-run-name-grid input')]
      .map((input) => [input.dataset.conditionId, input.value.trim()]).filter(([, name]) => name)),
    geometry: {
      schemaVersion: 3,
      sensorLayout,
      geometrySemantics: ['ld021_pair', 'rcwl_pair'].includes(sensorLayout) ? `${sensorLayout.replace('_', '-')}-characterization` : sensorLayout === 'dual' ? 'dual-sensor-system-distance-bands' : 'single-sensor-activation-lobe',
      sensorA: { ...((sensorLayout === 'rcwl_pair' ? config.validation?.rcwlPair : config.validation?.ld021Pair)?.sensorA || {}) },
      sensorB: { ...((sensorLayout === 'rcwl_pair' ? config.validation?.rcwlPair : config.validation?.ld021Pair)?.sensorB || {}) },
      dutLocationId: dutLocation.id,
      dut: {
        id: dutLocation.id, name: dutLocation.name,
        center: { ...dutGeometry.center }, bounds: { ...dutGeometry.bounds },
        widthMm: Number(dutLocation.widthMm), depthMm: Number(dutLocation.depthMm), frontY: Number(dutLocation.frontY),
      },
      systemReference: {
        ...dutGeometry.center,
        confirmed: true,
      },
      requiredTriggerMm: Number(config.validation?.systemLevel?.requiredTriggerMm) || ValidationCore.SYSTEM_REQUIRED_TRIGGER_MM,
      requiredNoTriggerMm: Number(config.validation?.systemLevel?.requiredNoTriggerMm) || ValidationCore.SYSTEM_REQUIRED_NO_TRIGGER_MM,
      guardBandMm: numeric('campaign-guard-band'),
      singleSensor: {
        centerX: numeric('campaign-center-x'),
        centerY: numeric('campaign-center-y'),
        radiusMm: numeric('campaign-radius'),
      },
      bounds: {
        minX: numeric('campaign-x-min'), maxX: numeric('campaign-x-max'),
        minY: numeric('campaign-y-min'), maxY: numeric('campaign-y-max'),
      },
      sequenceName: document.getElementById('campaign-custom-plan').value,
    },
  };
}

function renderCampaignRunNames(plan) {
  const grid = document.getElementById('campaign-run-name-grid');
  const saved = Object.fromEntries([...grid.querySelectorAll('input')]
    .map((input) => [input.dataset.conditionId, input.value]));
  const rows = [];
  const fixedOutput = plan.radarTarget.startsWith('rcwl_');
  const gains = fixedOutput || ['ld021', 'ld021_pair'].includes(plan.radarTarget) ? [null] : plan.gains;
  const thresholds = fixedOutput ? [null] : plan.thresholds;
  (plan.angularZones || ['all']).forEach((zone) => gains.forEach((gain) => thresholds
    .filter(Number.isFinite).forEach((threshold) => {
      for (let repeat = 1; repeat <= Math.max(0, Math.floor(plan.runsPerCondition) || 0); repeat += 1) {
        const gainHex = gain == null ? '' : Number(gain).toString(16).padStart(2, '0');
        const base = fixedOutput ? `${plan.radarTarget.replace('_', '-')}-r${repeat}` : gain == null ? `${plan.radarTarget === 'ld021_pair' ? 'ld021-pair' : 'ld021'}-t${threshold}-r${repeat}` : `g${gainHex}-t${threshold}-r${repeat}`;
        const id = zone === 'all' ? base : `z${zone}-${base}`;
        const label = zone === 'all' ? 'Full area' : ValidationCore.ANGULAR_ZONES[zone]?.label || zone;
        const settingLabel = fixedOutput ? 'Fixed output' : gain == null ? `HLK threshold ${threshold}` : `0x${gainHex} / ${threshold}`;
        rows.push(`<label><span>Run ${rows.length + 1} · ${escapeHtml(label)} · ${settingLabel} · Repeat ${repeat}</span><input type="text" maxlength="80" data-condition-id="${escapeHtml(id)}" value="${escapeHtml(saved[id] || '')}" placeholder="Optional run name" /></label>`);
      }
    })));
  grid.innerHTML = rows.join('');
}

// Kept as a named entry point for integrations that open the optional-name editor.
function renderCampaignRunNameEditor(plan) {
  renderCampaignRunNames(plan);
}

function updateCampaignCreatePreview() {
  const layoutSelect = document.getElementById('campaign-sensor-layout');
  const targetSelect = document.getElementById('campaign-radar-target');
  if (!['ld021_pair', 'rcwl_pair'].includes(layoutSelect.value)) updateRadarHardwareOptions(targetSelect, layoutSelect.value, targetSelect.value);
  let plan = campaignPlanFromForm();
  const formal = ['inside', 'outside', 'system'].includes(plan.testId);
  const characterization = plan.testId === 'characterization' || plan.testId === 'interference';
  document.getElementById('campaign-formal-coordinates').hidden = !formal;
  document.getElementById('campaign-characterization-coordinates').hidden = !characterization;
  document.getElementById('campaign-custom-coordinates').hidden = plan.testId !== 'custom';
  document.getElementById('campaign-angular-zone-group').hidden = plan.testId === 'custom';
  document.getElementById('campaign-guard-label').hidden = plan.testId !== 'outside';
  const dualSensors = plan.geometry.sensorLayout === 'dual';
  const hlk = ['ld021', 'ld021_pair'].includes(plan.radarTarget);
  const fixedOutput = plan.radarTarget.startsWith('rcwl_');
  document.getElementById('campaign-radar-target-row').hidden = ['ld021_pair', 'rcwl_pair'].includes(plan.geometry.sensorLayout);
  document.getElementById('campaign-hilink-sensor-row').hidden = plan.radarTarget !== 'ld021' || plan.geometry.sensorLayout !== 'single';
  document.getElementById('campaign-gain-group').hidden = hlk || fixedOutput;
  document.getElementById('campaign-threshold-group').hidden = fixedOutput;
  document.getElementById('campaign-threshold-label').textContent = hlk ? 'Sensitivity threshold values' : 'Threshold values';
  document.getElementById('campaign-threshold-help').textContent = hlk ? 'Comma separated; 1–16777215. Lower values increase expected range.' : 'Comma separated';
  const campaignDut = document.getElementById('campaign-dut-location');
  campaignDut.disabled = !dualSensors;
  campaignDut.closest('label').hidden = !dualSensors;
  document.getElementById('campaign-single-sensor-fields').hidden = dualSensors || ['ld021_pair', 'rcwl_pair'].includes(plan.geometry.sensorLayout);
  document.getElementById('campaign-system-geometry-note').hidden = !dualSensors;
  document.getElementById('campaign-pass-label').hidden = characterization;
  const pointsInput = document.getElementById('campaign-points-input');
  if (plan.testId === 'custom') {
    const customCount = config.sequences?.[plan.geometry.sequenceName]?.length || 0;
    pointsInput.value = customCount || '';
    pointsInput.disabled = true;
    plan = campaignPlanFromForm();
  } else {
    pointsInput.disabled = false;
  }
  const zoneCount = plan.angularZones.length;
  const gainCount = hlk || fixedOutput ? 1 : plan.gains.length;
  const thresholdCount = fixedOutput ? 1 : plan.thresholds.filter(Number.isFinite).length;
  const conditions = zoneCount * gainCount * thresholdCount;
  const runs = conditions * Math.max(0, Math.floor(plan.runsPerCondition) || 0);
  const measurementsPerRun = Math.max(0, Math.floor(plan.cyclesPerRun) || 0) * Math.max(0, Math.floor(plan.pointCount) || 0);
  renderCampaignRunNames(plan);
  const testName = { inside: 'Test 10.1', outside: 'Test 10.2', system: 'System Level Bounds', characterization: 'Characterization', interference: 'Radar Pair Interference', custom: 'Custom test' }[plan.testId];
  const coordinateSummary = formal
    ? (dualSensors
      ? `${plan.geometry.dut.name} - ${plan.geometry.requiredTriggerMm}/${plan.geometry.requiredNoTriggerMm} mm nearest-edge offsets`
      : `Center ${plan.geometry.singleSensor.centerX}, ${plan.geometry.singleSensor.centerY} - Depth ${plan.geometry.singleSensor.radiusMm} mm`)
    : characterization
      ? `X ${plan.geometry.bounds.minX}–${plan.geometry.bounds.maxX} - Y ${plan.geometry.bounds.minY}–${plan.geometry.bounds.maxY}`
      : `Plan: ${plan.geometry.sequenceName || 'choose a plan'}`;
  document.getElementById('campaign-workload-summary').innerHTML =
    `<strong>${escapeHtml(testName || 'Campaign')} workload</strong>`
    + `<span>${zoneCount} zone${zoneCount === 1 ? '' : 's'} × ${fixedOutput ? 'fixed-output hardware' : hlk ? `${plan.thresholds.filter(Number.isFinite).length} sensitivity threshold${plan.thresholds.filter(Number.isFinite).length === 1 ? '' : 's'}` : `${plan.gains.length} gain${plan.gains.length === 1 ? '' : 's'} × ${plan.thresholds.filter(Number.isFinite).length} threshold${plan.thresholds.filter(Number.isFinite).length === 1 ? '' : 's'}`} × ${plan.runsPerCondition || 0} repeat${plan.runsPerCondition === 1 ? '' : 's'} = ${runs} total runs</span>`
    + `<span>${plan.cyclesPerRun || 0} cycles × ${plan.pointCount || 0} points = ${measurementsPerRun} measurements per run</span>`
    + `<span>${runs * measurementsPerRun} planned measurements total</span>`
    + `<span>${escapeHtml(coordinateSummary)}</span>`;
}

/** Applies the campaign method and stages the next radar condition. */
async function prepareNextCampaignRun({ applySettings = true } = {}) {
  const status = campaignOperatorStatus || await radarAPI.campaignStatus();
  if (!status?.active || !status.next) {
    showCampaignModal('dashboard');
    return false;
  }
  const method = status.method;
  if (method.recipeSnapshot) config = RecipeCore.apply(config, method.recipeSnapshot);
  config.test = {
    ...(config.test || {}),
    mode: method.testId,
    dutId: status.campaign.dutId,
    cyclesRequired: method.cyclesPerRun,
    minimumCorrectRate: method.minimumCorrectRate,
    campaignConditionId: status.next.id,
    campaignRunNumber: status.next.runNumber,
    campaignRepeatNumber: status.next.repeat,
  };
  config.validation = {
    ...(config.validation || {}),
    pointCount: method.pointCount,
    angularZoneEnabled: status.next.angularZone !== 'all',
    angularZone: status.next.angularZone === 'all' ? 'front' : status.next.angularZone,
    sensorLayout: method.geometry.sensorLayout,
    radarTarget: method.radarTarget,
    hilinkSensor: method.hilinkSensor === 'B' ? 'B' : 'A',
    geometrySemantics: method.geometry.geometrySemantics,
    singleSensorConfirmed: config.validation?.singleSensorConfirmed === true,
    guardBandMm: method.geometry.guardBandMm,
    systemReference: { ...method.geometry.systemReference },
    characterizationBounds: { ...method.geometry.bounds },
  };
  if (method.geometry.sensorLayout === 'single') {
    config.validation.singleSensor = { ...method.geometry.singleSensor };
  }
  if (['ld021_pair', 'rcwl_pair'].includes(method.geometry.sensorLayout)) {
    const pairKey = method.geometry.sensorLayout === 'rcwl_pair' ? 'rcwlPair' : 'ld021Pair';
    config.validation[pairKey] = { ...(config.validation?.[pairKey] || {}),
      sensorA: { ...method.geometry.sensorA }, sensorB: { ...method.geometry.sensorB } };
  }
  if (method.geometry.dutLocationId) {
    config.dut = { ...(config.dut || {}), activeLocationId: method.geometry.dutLocationId };
  }
  if (method.geometry.sensorLayout !== 'dual') {
    config.dut = { ...(config.dut || {}), activeLocationId: DutLocationCore.ORIGINAL_LOCATION.id };
  }
  if (method.testId === 'custom') config.activeSequence = method.geometry.sequenceName;
  config.logging = { ...(config.logging || {}), enabled: true };
  await radarAPI.configSet(config);
  if (radarSettingsState?.activeTarget !== activeRadarTarget()) {
    await refreshRadarSettings(false);
    // Give the LD021 software UART a quiet interval before the apply endpoint
    // starts its own query/set/read-back transaction.
    if (isHilinkTarget() && activeRadarTarget() !== 'ld021_pair') await new Promise((resolve) => setTimeout(resolve, 300));
  }
  if (['characterization', 'interference'].includes(method.testId)) await regenerateCharacterizationPlanFromOperator();
  else if (['inside', 'outside'].includes(method.testId)) await regenerateFormalPlanFromOperator();
  else if (method.testId === 'system') await regenerateSystemValidationPlan();
  else {
    updateSeqProgress();
    renderSpatialResults();
  }
  const fixedOutput = method.settingsProfile === RadarSettingsCore.FIXED_OUTPUT_PROFILE;
  if (!fixedOutput) {
    if (status.next.gainCode != null) document.getElementById('radar-gain-select').value = String(status.next.gainCode);
    document.getElementById('radar-threshold-input').value = status.next.threshold;
    if (status.next.gainCode != null) document.getElementById('radar-gain-select').dispatchEvent(new Event('change'));
    document.getElementById('radar-threshold-input').dispatchEvent(new Event('input'));
  }
  const preparedZone = status.next.angularZone === 'all'
    ? 'Full area' : ValidationCore.ANGULAR_ZONES[status.next.angularZone]?.label || status.next.angularZone;
  updateQuickRunPanel(`Campaign run ${status.next.runNumber} prepared - ${preparedZone}`);
  hideCampaignModal();
  logEvent(`Campaign run ${status.next.runNumber} prepared: ${preparedZone}, repeat ${status.next.repeat}, ${fixedOutput ? 'RCWL-0516 fixed output' : method.radarTarget === 'ld021' ? `HLK sensitivity threshold ${status.next.threshold}` : `gain ${status.next.gain}, threshold ${status.next.threshold}`}. ${fixedOutput ? 'Detection inputs were verified.' : `Apply and verify the ${method.radarTarget === 'ld021' ? 'HLK-LD021' : method.geometry.sensorLayout === 'single' ? 'single radar' : 'A/B radar system'} before running.`}`, 'info');
  if (applySettings && !fixedOutput) {
    const applied = await applyAndVerifyRadarSettings(status.next.gainCode, status.next.threshold);
    if (!applied.success) {
      logEvent(`Campaign run preparation stopped: ${applied.error}`, 'error');
      setResult('fail', applied.error);
      return false;
    }
    logEvent(`Campaign radar settings verified: ${method.radarTarget === 'ld021' ? `HLK sensitivity threshold ${status.next.threshold}` : `${status.next.gain} / ${status.next.threshold}`}`, 'pass');
  }
  return true;
}

function setCampaignAutoRunState(message = '', state = '') {
  const element = document.getElementById('campaign-auto-run-state');
  element.textContent = message;
  element.className = `campaign-auto-run-state ${state}`;
}

/** Runs every remaining condition through the normal guarded sequence workflow. */
async function runAutomaticCampaign() {
  // Completion compatibility: completion?.localCampaignComplete is the durable
  // advancement signal; completion.operationalFailure stops this loop.
  if (campaignAutoRunActive || testRunning) return;
  campaignAutoRunActive = true;
  campaignAutoRunStopRequested = false;
  setCampaignAutoRunState('Auto Run starting…');
  try {
    while (!campaignAutoRunStopRequested) {
      const status = await radarAPI.campaignStatus();
      campaignOperatorStatus = status;
      if (!status?.active || status.method?.autoRun !== true || !status.next) break;
      if (!connected || !motionEnabled() || ['shutdown', 'error'].includes(klippyState)) {
        throw new Error(!connected ? 'Fixture disconnected' : `Fixture is not ready (${klippyState})`);
      }
      const conditionId = status.next.id;
      setCampaignAutoRunState(`Preparing run ${status.next.runNumber} of ${status.total}…`);
      if (!(await prepareNextCampaignRun({ applySettings: true }))) throw new Error('Campaign condition could not be prepared and verified');
      if (campaignAutoRunStopRequested) break;
      setCampaignAutoRunState(`Running ${status.next.runNumber} of ${status.total}…`);
      await runSequence();
      const advanced = await radarAPI.campaignStatus();
      campaignOperatorStatus = advanced;
      if (testAborted || !connected || ['shutdown', 'error'].includes(klippyState)) throw new Error('Auto Run stopped by a fixture or E-Stop fault');
      if (advanced.next?.id === conditionId) {
        // An incomplete condition must not be relaunched by the status feed.
        // Persistently disable Auto Run before yielding control back to polling.
        await radarAPI.campaignSetAutoRun(false);
        throw new Error('Run result did not meet campaign completion requirements; Auto Run was disabled and will not retry this condition');
      }
      await refreshCampaignOperator();
    }
    const finalStatus = await radarAPI.campaignStatus();
    const complete = finalStatus?.active && !finalStatus.next;
    setCampaignAutoRunState(complete ? 'Auto Run complete.' : 'Auto Run stopped.', complete ? 'complete' : '');
  } catch (error) {
    campaignAutoRunStopRequested = true;
    setCampaignAutoRunState(`Auto Run stopped: ${error.message}`, 'error');
    logEvent(`Auto Run stopped: ${error.message}`, 'error');
  } finally {
    campaignAutoRunActive = false;
    await refreshCampaignOperator();
  }
}

function wireCampaignWorkflow() {
  const setAutoRun = async (enabled) => {
    if (!enabled) campaignAutoRunStopRequested = true;
    const result = await radarAPI.campaignSetAutoRun(enabled);
    if (!result.success) {
      window.alert(result.error || 'Auto Run could not be updated');
      await refreshCampaignOperator();
      return;
    }
    campaignOperatorStatus = result;
    await refreshCampaignOperator();
    if (enabled) void runAutomaticCampaign();
  };
  document.getElementById('campaign-recipe-select').addEventListener('change', (event) => applyRecipeToCampaignForm(event.target.value));
  document.getElementById('campaign-test-type').addEventListener('change', () => {
    populateCampaignTestPlanOptions();
    const selectedPlanId = document.getElementById('campaign-recipe-select').value;
    if (selectedPlanId) applyRecipeToCampaignForm(selectedPlanId);
    else updateCampaignCreatePreview();
  });
  [
    'campaign-test-type', 'campaign-runs-input', 'campaign-cycles-input', 'campaign-points-input', 'campaign-pass-input',
    'campaign-thresholds-input', 'campaign-sensor-layout', 'campaign-dut-location', 'campaign-center-x', 'campaign-center-y', 'campaign-radius',
    'campaign-guard-band', 'campaign-x-min', 'campaign-x-max', 'campaign-y-min', 'campaign-y-max',
    'campaign-custom-plan',
  ].forEach((id) => document.getElementById(id).addEventListener('input', updateCampaignCreatePreview));
  document.getElementById('campaign-radar-target').addEventListener('change', updateCampaignCreatePreview);
  document.getElementById('campaign-hilink-sensor').addEventListener('change', updateCampaignCreatePreview);
  document.querySelectorAll('#campaign-gain-options input').forEach((input) => input.addEventListener('change', updateCampaignCreatePreview));
  document.querySelectorAll('#campaign-angular-zone-options input').forEach((input) => input.addEventListener('change', (event) => {
    const options = [...document.querySelectorAll('#campaign-angular-zone-options input')];
    if (event.target.checked && event.target.value === 'all') {
      options.filter((option) => option.value !== 'all').forEach((option) => { option.checked = false; });
    } else if (event.target.checked) {
      const all = options.find((option) => option.value === 'all');
      if (all) all.checked = false;
    }
    updateCampaignCreatePreview();
  }));
  document.getElementById('campaign-primary-btn').addEventListener('click', () => {
    if (!campaignOperatorStatus?.active) showCampaignModal('create');
    else if (campaignOperatorStatus.next) prepareNextCampaignRun();
    else showCampaignModal('dashboard');
  });
  document.getElementById('campaign-view-btn').addEventListener('click', () => showCampaignModal('dashboard'));
  document.getElementById('campaign-auto-run-toggle').addEventListener('change', (event) => setAutoRun(event.target.checked));
  document.getElementById('campaign-dashboard-auto-run-toggle').addEventListener('change', (event) => setAutoRun(event.target.checked));
  document.getElementById('campaign-modal-close-btn').addEventListener('click', hideCampaignModal);
  document.getElementById('campaign-create-cancel-btn').addEventListener('click', hideCampaignModal);
  document.getElementById('campaign-create-btn').addEventListener('click', async () => {
    const button = document.getElementById('campaign-create-btn');
    const status = document.getElementById('campaign-create-status');
    button.disabled = true;
    status.className = 'campaign-operation-status';
    const editing = campaignFormMode === 'edit';
    if (editing) status.textContent = 'Saving campaign changes…';
    status.textContent = 'Creating the local campaign and preparing automatic logging…';
    status.textContent = editing ? 'Saving campaign changes…' : status.textContent;
    const campaignInput = {
      name: document.getElementById('campaign-name-input').value.trim(),
      dutId: document.getElementById('campaign-dut-input').value.trim(),
      plan: campaignPlanFromForm(),
    };
    const result = editing
      ? await radarAPI.campaignUpdate(campaignInput)
      : await radarAPI.campaignStart(campaignInput);
    button.disabled = false;
    if (!result.success) {
      status.className = 'campaign-operation-status error';
      status.textContent = result.error || `Campaign could not be ${editing ? 'updated' : 'created'}`;
      return;
    }
    config = await radarAPI.configGet();
    updateQuickRunPanel();
    campaignOperatorStatus = result;
    status.className = 'campaign-operation-status success';
    if (editing) status.textContent = 'Campaign changes saved.';
    status.textContent = 'Campaign created. Reports and CSV results will be saved locally.';
    status.textContent = editing ? 'Campaign changes saved.' : status.textContent;
    await refreshCampaignOperator();
    showCampaignModal('dashboard');
    if (result.method?.autoRun === true) void runAutomaticCampaign();
  });
  document.getElementById('campaign-dashboard-prepare-btn').addEventListener('click', prepareNextCampaignRun);
  document.getElementById('campaign-edit-btn').addEventListener('click', () => showCampaignModal('edit'));
  document.getElementById('campaign-archive-btn').addEventListener('click', async () => {
    if (!window.confirm('Close and archive this local campaign? Completed reports and CSV results remain available.')) return;
    campaignAutoRunStopRequested = true;
    const result = await radarAPI.campaignArchive();
    if (!result.success) {
      window.alert(result.error || 'Campaign could not be archived');
      return;
    }
    hideCampaignModal();
    campaignOperatorStatus = { active: false };
    config = await radarAPI.configGet();
    updateQuickRunPanel();
    await refreshCampaignOperator();
    updateQuickRunPanel();
  });
}

/** Populates config form. */
function populateConfigForm() {
  document.getElementById('cfg-x-min').value = config.motion.x.minMm;
  document.getElementById('cfg-x-max').value = config.motion.x.maxMm;
  document.getElementById('cfg-x-speed').value = config.motion.x.speedMmS;
  document.getElementById('cfg-x-accel').value = config.motion.x.accelMmS2;
  document.getElementById('cfg-x-offset').value = config.motion.x.homeOffsetMm;

  document.getElementById('cfg-y-min').value = config.motion.y.minMm;
  document.getElementById('cfg-y-max').value = config.motion.y.maxMm;
  document.getElementById('cfg-y-speed').value = config.motion.y.speedMmS;
  document.getElementById('cfg-y-accel').value = config.motion.y.accelMmS2;
  document.getElementById('cfg-y-offset').value = config.motion.y.homeOffsetMm;

  document.getElementById('cfg-z-min').value = config.motion.z.minMm;
  document.getElementById('cfg-z-max').value = config.motion.z.maxMm;
  document.getElementById('cfg-z-speed').value = config.motion.z.speedMmS;
  document.getElementById('cfg-motion-commissioned').checked = config.motion?.commissioned === true;
  document.getElementById('cfg-z-accel').value = config.motion.z.accelMmS2;
  document.getElementById('cfg-z-offset').value = config.motion.z.homeOffsetMm;

  document.getElementById('cfg-trigger-macro').value = config.trigger.macro;
  document.getElementById('cfg-trigger-delay').value = config.trigger.delayMs;
  document.getElementById('cfg-hold-default').value = config.trigger.holdMsDefault;
  document.getElementById('cfg-pos-timeout').value = config.trigger.positionTimeoutMs;

  document.getElementById('cfg-logging-enabled').checked = !!config.logging.enabled;
  document.getElementById('cfg-ssh-host').value = config.ssh.host;
  document.getElementById('cfg-ssh-user').value = config.ssh.username;
  document.getElementById('cfg-ssh-port').value = config.ssh.port;
  document.getElementById('cfg-radar-service-port').value = config.radarService?.port || 7130;
  document.getElementById('cfg-radar-service-timeout').value = config.radarService?.timeoutMs || 2500;
  document.getElementById('cfg-radar-require-verified').checked = config.radarService?.requireVerifiedSettings !== false;
  document.getElementById('cfg-radar-timeout').value = config.radar?.timeoutMs || 5000;
  document.getElementById('cfg-radar-poll').value = config.radar?.pollMs || 100;
  document.getElementById('cfg-radar-baseline-timeout').value = config.trigger?.delayMs || 3000;

  document.getElementById('cfg-test-mode').value = config.test?.mode || 'characterization';
  document.getElementById('cfg-plan-distribution').value = config.validation?.pointDistribution || activeRecipe()?.distribution || 'even';
  const planBounds = config.validation?.characterizationBounds || {};
  document.getElementById('cfg-plan-min-x').value = planBounds.minX ?? 0;
  document.getElementById('cfg-plan-max-x').value = planBounds.maxX ?? 1725;
  document.getElementById('cfg-plan-min-y').value = planBounds.minY ?? 150;
  document.getElementById('cfg-plan-max-y').value = planBounds.maxY ?? 1040;
  const dutLocationSelect = document.getElementById('cfg-dut-location');
  const dutLocations = Array.isArray(config.dut?.locations) && config.dut.locations.length
    ? config.dut.locations : DutLocationCore.BUILT_IN_LOCATIONS;
  dutLocationSelect.innerHTML = dutLocations.map((location) => `<option value="${escapeHtml(location.id)}">${escapeHtml(location.name)}</option>`).join('');
  dutLocationSelect.value = config.dut?.activeLocationId || dutLocations[0].id;
  updateDutLocationControl(config.validation?.sensorLayout);
  document.getElementById('cfg-dut-id').value = config.test?.dutId || '';
  document.getElementById('cfg-cycles-required').value = configuredCycleCount();
  document.getElementById('cfg-cycle-number').value = config.test?.cycleNumber || 1;
  document.getElementById('cfg-definition-file').value = config.test?.definitionFile || '';
  document.getElementById('cfg-custom-minimum').value = Number((configuredPassRate() * 100).toFixed(1));
  document.getElementById('cfg-sensor-layout').value = ['ld021_pair', 'rcwl_pair'].includes(config.validation?.sensorLayout) ? config.validation.sensorLayout : config.validation?.sensorLayout === 'dual' ? 'dual' : 'single';
  updateRadarHardwareOptions(document.getElementById('cfg-radar-target'), document.getElementById('cfg-sensor-layout').value, config.validation?.radarTarget);
  document.getElementById('cfg-hilink-sensor').value = config.validation?.hilinkSensor === 'B' ? 'B' : 'A';
  document.getElementById('cfg-radar-center-x').value = config.validation?.singleSensor?.centerX ?? 875;
  document.getElementById('cfg-radar-center-y').value = config.validation?.singleSensor?.centerY ?? 1200;
  document.getElementById('cfg-radar-center-confirmed').checked = !!config.validation?.singleSensorConfirmed;
  document.getElementById('cfg-radius-mm').value = config.validation?.singleSensor?.radiusMm ?? 304.8;
  const dualSensors = config.validation?.sensorLayout === 'dual';
  const pairLayout = ['ld021_pair', 'rcwl_pair'].includes(config.validation?.sensorLayout);
  document.getElementById('cfg-radar-target-row').hidden = pairLayout;
  document.getElementById('cfg-hilink-sensor-row').hidden = dualSensors || pairLayout || config.validation?.radarTarget !== 'ld021';
  document.getElementById('cfg-single-sensor-fields').hidden = dualSensors || pairLayout;
  document.getElementById('cfg-ld021-pair-fields').hidden = !pairLayout;
  document.getElementById('cfg-system-geometry-note').hidden = !dualSensors;
  document.getElementById('cfg-sensor-center-confirmation').hidden = dualSensors;
  document.getElementById('cfg-guard-band-mm').value = config.validation?.guardBandMm ?? 10;
  document.getElementById('cfg-validation-point-count').value = config.validation?.pointCount ?? 100;
  const passInches = (Number(config.validation?.systemLevel?.requiredTriggerMm) || ValidationCore.SYSTEM_REQUIRED_TRIGGER_MM) / 25.4;
  const redInches = (Number(config.validation?.systemLevel?.requiredNoTriggerMm) || ValidationCore.SYSTEM_REQUIRED_NO_TRIGGER_MM) / 25.4;
  document.getElementById('cfg-system-pass-inches').value = Number(passInches.toFixed(3));
  document.getElementById('cfg-system-grey-inches').value = Number(redInches.toFixed(3));
  document.getElementById('cfg-system-red-inches').value = Number(redInches.toFixed(3));
  document.getElementById('cfg-reflector-clearance-mm').value = Math.max(0, Number(config.dut?.reflectorClearanceMm) || 0);
  document.getElementById('cfg-coverage-mode').value = normalizedCoverageMode();
  updateSystemLevelSummary();
  const angularZone = angularZoneSettings();
  document.getElementById('cfg-angular-zone-enabled').checked = angularZone.enabled;
  document.getElementById('cfg-angular-zone').value = angularZone.zone;
  document.getElementById('cfg-angular-zone').disabled = !angularZone.enabled;
  document.getElementById('cfg-angular-zone-row').style.display = angularZone.enabled ? 'flex' : 'none';
  document.getElementById('cfg-outside-radius-mm').value = config.validation?.sensorLayout === 'dual'
    ? Math.max(762, Number(config.validation?.outsideRadiusMm) || 0)
    : config.validation?.outsideRadiusMm ?? 457.2;
  const pair = config.validation?.sensorLayout === 'rcwl_pair' ? config.validation?.rcwlPair || {} : config.validation?.ld021Pair || {};
  document.getElementById('cfg-pair-a-label').textContent = `${config.validation?.sensorLayout === 'rcwl_pair' ? 'RCWL_A' : 'LD021_A'} X / Y / heading (mm, mm, deg)`;
  document.getElementById('cfg-pair-b-label').textContent = `${config.validation?.sensorLayout === 'rcwl_pair' ? 'RCWL_B' : 'LD021_B'} X / Y / heading (mm, mm, deg)`;
  document.getElementById('cfg-ld021-a-x').value = pair.sensorA?.x ?? 775;
  document.getElementById('cfg-ld021-a-y').value = pair.sensorA?.y ?? 900;
  document.getElementById('cfg-ld021-a-heading').value = pair.sensorA?.headingDeg ?? 0;
  document.getElementById('cfg-ld021-b-x').value = pair.sensorB?.x ?? 975;
  document.getElementById('cfg-ld021-b-y').value = pair.sensorB?.y ?? 900;
  document.getElementById('cfg-ld021-b-heading').value = pair.sensorB?.headingDeg ?? 0;
  document.getElementById('cfg-ld021-idle-ms').value = pair.idleObservationMs ?? 10000;
  document.getElementById('cfg-ld021-startup-ms').value = pair.startupStabilizationMs ?? 10000;
  document.getElementById('cfg-ld021-correlation-ms').value = pair.correlationWindowMs ?? 250;

  radarAPI.getLogPath().then((p) => {
    document.getElementById('cfg-log-folder').textContent = p ? p.replace(/[\\/][^\\/]+$/, '') : '(created on first sequence run)';
  });

  populateSequenceSelect();
  renderSequenceTable();
  normalizeModalNumericInputs();
  updateEngineeringSetupEditability();
}

/** Populates sequence select. */
function populateSequenceSelect() {
  const sel = document.getElementById('seq-select');
  sel.innerHTML = '';
  Object.keys(config.sequences).filter((name) => ['inside', 'outside', 'system'].includes(activeTestId()) || !FORMAL_SEQUENCE_NAMES.has(name)).forEach((name) => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    sel.appendChild(opt);
  });
  sel.value = config.activeSequence;
}

/** Renders sequence table. */
function renderSequenceTable() {
  const name = document.getElementById('seq-select').value || config.activeSequence;
  const seq = config.sequences[name] || [];
  const tbody = document.getElementById('seq-tbody');
  tbody.innerHTML = '';
  seq.forEach((p, i) => {
    const tr = document.createElement('tr');
    const zone = ['inside', 'outside', 'guard-band', 'required-trigger', 'optional', 'required-no-trigger'].includes(p.zone) ? p.zone : '';
    const automaticExpectation = activeSensorLayout() === 'dual'
      ? ValidationCore.expectedFor('custom', p, validationGeometry()) : null;
    const expected = p.expectedDetected === true ? 'true'
      : p.expectedDetected === false ? 'false'
        : automaticExpectation === true ? 'true' : automaticExpectation === false ? 'false' : 'auto';
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td><input type="number" class="seq-x" value="${p.x}" /></td>
      <td><input type="number" class="seq-y" value="${p.y}" /></td>
      <td><input type="number" class="seq-hold" value="${p.holdMs}" /></td>
      <td><select class="seq-zone" aria-label="Point ${i + 1} zone">
        <option value="" ${zone === '' ? 'selected' : ''}>Auto</option>
        <option value="inside" ${zone === 'inside' ? 'selected' : ''}>Inside</option>
        <option value="outside" ${zone === 'outside' ? 'selected' : ''}>Outside</option>
        <option value="guard-band" ${zone === 'guard-band' ? 'selected' : ''}>Guard</option>
        <option value="required-trigger" ${zone === 'required-trigger' ? 'selected' : ''}>System pass</option>
        <option value="optional" ${zone === 'optional' ? 'selected' : ''}>System grey (ungraded)</option>
        <option value="required-no-trigger" ${zone === 'required-no-trigger' ? 'selected' : ''}>System fail</option>
      </select></td>
      <td><select class="seq-expected" aria-label="Point ${i + 1} expected result">
        <option value="auto" ${expected === 'auto' ? 'selected' : ''}>Auto / ungraded</option>
        <option value="true" ${expected === 'true' ? 'selected' : ''}>Detect</option>
        <option value="false" ${expected === 'false' ? 'selected' : ''}>No detect</option>
      </select></td>
      <td><button class="btn-icon-sm seq-remove-row" title="Remove">✕</button></td>
    `;
    tr.querySelector('.seq-remove-row').addEventListener('click', () => {
      seq.splice(i, 1);
      config.sequences[name] = seq;
      renderSequenceTable();
    });
    tbody.appendChild(tr);
  });
  normalizeModalNumericInputs();
}

/** Reads sequence table into config. */
function readSequenceTableIntoConfig() {
  return commitSequenceEdit();
}

/** Creates and validates the automatic Test 10.1 or Test 10.2 point plan. */
function buildFormalValidationPlan(zone) {
  const geometry = validationGeometry();
  const count = Math.max(1, Math.floor(Number(config.validation?.pointCount) || 100));
  const requestedOuterRadius = formalOuterDistanceMm(geometry);
  const systemBands = ValidationCore.usesDualSystemBands(geometry);
  const minimumOutsideDepth = systemBands
    ? geometry.requiredNoTriggerMm
    : geometry.radiusMm + geometry.guardBandMm;
  if (zone === 'outside' && requestedOuterRadius <= minimumOutsideDepth) {
    return { error: systemBands
      ? `The Test 10.2 outer edge offset must be greater than ${geometry.requiredNoTriggerMm} mm.`
      : 'The Test 10.2 outer depth must be greater than required depth + guard band.' };
  }
  const movementBounds = config.validation?.characterizationBounds || fixtureXyBounds();
  const angularZone = angularZoneSettings();
  const points = ValidationCore.generateRadialPoints({
    count,
    zone,
    geometry,
    outerRadiusMm: requestedOuterRadius,
    holdMs: config.trigger.holdMsDefault,
    bounds: { ...movementBounds },
    angularZoneEnabled: angularZone.enabled,
    angularZone: angularZone.zone,
    distribution: config.validation?.pointDistribution || activeRecipe()?.distribution || 'boundary',
    coverageMode: normalizedCoverageMode(config.validation?.coverageMode || activeRecipe()?.coverageMode),
    keepOutClearanceMm: reflectorClearanceMm(),
    isPointAllowed: (point) => !DutLocationCore.pointInNoGo(point, activeDutLocation(), { clearanceMm: reflectorClearanceMm() }),
  }).map((point, index) => ({ ...point, pointId: `${zone}-${String(index + 1).padStart(3, '0')}` }));
  if (points.length < count) {
    return { error: `Only ${points.length} of ${count} requested points fit inside configured fixture travel.` };
  }
  const name = zone === 'inside' ? 'Test 10.1 Inside Detection' : 'Test 10.2 Outside Boundary';
  const areaLabel = systemBands
    ? (zone === 'inside' ? `${geometry.requiredTriggerMm} mm DUT-edge offset zone` : `beyond ${geometry.requiredNoTriggerMm} mm required-no-detection band`)
    : (zone === 'inside' ? 'full 12-inch single-sensor detection lobe' : 'single-sensor exterior lobe band');
  let spacingNote = '';
  if (points.length > 1) {
    const neighbors = points.map((point, index) => Math.min(...points.map((other, otherIndex) => index === otherIndex ? Infinity : Math.hypot(point.x-other.x,point.y-other.y)))).sort((a,b)=>a-b);
    const mean = neighbors.reduce((sum,value)=>sum+value,0)/neighbors.length;
    const deviation = Math.sqrt(neighbors.reduce((sum,value)=>sum+Math.pow(value-mean,2),0)/neighbors.length);
    spacingNote = ` Nearest-neighbor spacing: ${neighbors[0].toFixed(1)}–${neighbors[neighbors.length-1].toFixed(1)} mm, median ${neighbors[Math.floor(neighbors.length/2)].toFixed(1)} mm, variation ${(deviation/mean*100).toFixed(1)}%.`;
  }
  const bufferNote = zone === 'outside' ? ' Test 10.2 guard band excluded.' : ' Test 10.1 includes the full required area through its boundary.';
  const angularNote = angularZone.enabled ? ` Angular zone: ${angularZone.label}.` : '';
  return { points, name, count, summary: `${name}: ${points.length}/${count} evenly spaced positions across the ${areaLabel}.${bufferNote}${angularNote}${spacingNote}` };
}

/** Builds one exact-count System Level section containing green, grey, and red samples. */
function buildSystemValidationPlan(zone = config.validation?.angularZone || 'front', countOverride = config.validation?.pointCount) {
  if (activeSensorLayout() !== 'dual') return { error: 'System Level Bounds Validation requires the Aqua dual-sensor DUT setup.' };
  const count = Math.max(3, Math.floor(Number(countOverride) || 15));
  const geometry = validationGeometry();
  const bounds = config.validation?.characterizationBounds || fixtureXyBounds();
  const points = ValidationCore.generateSystemValidationPoints({
    count, geometry, bounds, angularZoneEnabled: zone !== 'all', angularZone: zone,
    distribution: config.validation?.pointDistribution || activeRecipe()?.distribution || 'even',
    holdMs: config.trigger.holdMsDefault, keepOutClearanceMm: reflectorClearanceMm(),
    outerRadiusMm: Math.max(geometry.requiredNoTriggerMm + 1, Number(config.validation?.outsideRadiusMm) || geometry.requiredNoTriggerMm * 1.25),
    isPointAllowed: (point) => !DutLocationCore.pointInNoGo(point, activeDutLocation(), { clearanceMm: reflectorClearanceMm() })
      && !DutLocationCore.pointBehindDut(point, activeDutLocation()),
  }).map((point, index) => ({ ...point, pointId: `system-${zone}-${String(index + 1).padStart(3, '0')}` }));
  if (points.length !== count) return { error: `Only ${points.length} of ${count} System Level points fit in the ${zone} section.` };
  const counts = points.reduce((result, point) => ({ ...result, [point.zone]: (result[point.zone] || 0) + 1 }), {});
  const label = zone === 'front' ? 'Front / middle' : ValidationCore.ANGULAR_ZONES[zone]?.label || 'Full area';
  return {
    name: `System Level — ${label}`, points, count,
    summary: `${label}: ${counts['required-trigger'] || 0} green Detect, ${counts.optional || 0} grey ungraded, and ${counts['required-no-trigger'] || 0} red No Detect points.`,
  };
}

async function regenerateSystemValidationPlan() {
  const zone = config.validation?.angularZoneEnabled === false ? 'all' : config.validation?.angularZone || 'front';
  const plan = buildSystemValidationPlan(zone);
  if (plan.error) { updateQuickRunPanel(plan.error, true); return false; }
  plan.points = optimizedExecutionPoints(plan.points);
  config.sequences[plan.name] = plan.points;
  config.activeSequence = plan.name;
  await radarAPI.configSet(config);
  updateSeqProgress();
  renderSpatialResults();
  renderPlanPreviewCanvas(plan.points, plan.summary, 'quick-formal-preview');
  return plan;
}

/** Creates an exact-count serpentine raster over the current characterization footprint. */
function buildCharacterizationPlan() {
  const count = Math.max(1, Math.floor(Number(config.validation?.pointCount) || 100));
  const coverageMode = normalizedCoverageMode(config.validation?.coverageMode || activeRecipe()?.coverageMode);
  if (activeSensorLayout() === 'dual' && ValidationCore.PERIMETER_COVERAGE_MODES?.includes(coverageMode)) {
    const geometry = validationGeometry();
    const angularZone = angularZoneSettings();
    const bounds = { minX: axisVisualRange('x').min, maxX: axisVisualRange('x').max, minY: axisVisualRange('y').min, maxY: axisVisualRange('y').max };
    const generated = ValidationCore.generatePerimeterPoints({
      count, zone: 'inside', geometry, coverageMode,
      bounds, holdMs: config.trigger.holdMsDefault, keepOutClearanceMm: reflectorClearanceMm(),
      isPointAllowed: (point) => !DutLocationCore.pointInNoGo(point, activeDutLocation(), { clearanceMm: reflectorClearanceMm() }),
    }).map((point, index) => ({ ...point, z: 0, pointId: `characterization-${String(index + 1).padStart(3, '0')}` }));
    return {
      name: 'Characterization DUT Perimeter Grid', points: generated, count,
      summary: `Characterization DUT Perimeter Grid: ${generated.length}/${count} safe positions on ${coverageMode.replace(/-/g, ' ')}.${angularZone.enabled ? ` Angular filter is ignored for explicit perimeter coverage (${angularZone.label}).` : ''}`,
    };
  }
  const source = config.sequences?.[config.activeSequence] || [];
  const valid = source.filter((point) => Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y)));
  const xRange = axisVisualRange('x');
  const yRange = axisVisualRange('y');
  const configuredBounds = config.validation?.characterizationBounds || {};
  let xMin = Number.isFinite(Number(configuredBounds.minX)) ? Number(configuredBounds.minX) : valid.length ? Math.min(...valid.map((point) => Number(point.x))) : xRange.min;
  let xMax = Number.isFinite(Number(configuredBounds.maxX)) ? Number(configuredBounds.maxX) : valid.length ? Math.max(...valid.map((point) => Number(point.x))) : xRange.max;
  let yMin = Number.isFinite(Number(configuredBounds.minY)) ? Number(configuredBounds.minY) : valid.length ? Math.min(...valid.map((point) => Number(point.y))) : yRange.min;
  let yMax = Number.isFinite(Number(configuredBounds.maxY)) ? Number(configuredBounds.maxY) : valid.length ? Math.max(...valid.map((point) => Number(point.y))) : yRange.max;
  xMin = clamp(xMin, xRange.min, xRange.max); xMax = clamp(xMax, xRange.min, xRange.max);
  yMin = clamp(yMin, yRange.min, yRange.max); yMax = clamp(yMax, yRange.min, yRange.max);
  if (xMin > xMax) [xMin, xMax] = [xMax, xMin];
  if (yMin > yMax) [yMin, yMax] = [yMax, yMin];
  if (xMin === xMax && yMin === yMax) {
    xMin = xRange.min; xMax = xRange.max; yMin = yRange.min; yMax = yRange.max;
  }
  const holdMs = Math.max(0, Math.round(valid[0]?.holdMs ?? config.trigger.holdMsDefault));
  const z = roundPoint(valid[0]?.z ?? 0);
  const points = [];
  const angularZone = angularZoneSettings();
  const distribution = config.validation?.pointDistribution || activeRecipe()?.distribution || 'even';
  const excludeDut = activeSensorLayout() === 'dual';
  const pointAllowed = (point) => !excludeDut || !DutLocationCore.pointInNoGo(point, activeDutLocation(), { clearanceMm: reflectorClearanceMm() });
  if (distribution === 'boundary' && xMin !== xMax && yMin !== yMax) {
    const candidates = Math.max(count * 40, 160);
    const boundaryCandidates = [];
    for (let index = 0; index < candidates; index++) {
      const edge = (index / candidates) * 4;
      const side = Math.floor(edge), fraction = edge - side;
      const point = side === 0 ? { x: xMin + fraction * (xMax - xMin), y: yMin }
        : side === 1 ? { x: xMax, y: yMin + fraction * (yMax - yMin) }
          : side === 2 ? { x: xMax - fraction * (xMax - xMin), y: yMax }
            : { x: xMin, y: yMax - fraction * (yMax - yMin) };
      if (!ValidationCore.pointInAngularZone(point, validationGeometry(), angularZone.enabled, angularZone.zone) || !pointAllowed(point)) continue;
      boundaryCandidates.push(point);
    }
    for (let index = 0; index < Math.min(count, boundaryCandidates.length); index++) {
      const point = boundaryCandidates[Math.floor(index * boundaryCandidates.length / Math.min(count, boundaryCandidates.length))];
      points.push({ x: roundPoint(point.x), y: roundPoint(point.y), z, holdMs, pointId: `characterization-${String(points.length + 1).padStart(3, '0')}` });
    }
  }
  if (distribution === 'grid' && xMin !== xMax && yMin !== yMax) {
    // Keep raster points on one row/column lattice even when angular or DUT
    // safety filtering removes cells. Previously those constraints routed the
    // "grid" option through Halton sampling, producing an irregular cloud.
    const aspect = Math.max(1e-9, (xMax - xMin) / (yMax - yMin));
    for (let density = 0; density < 100 && points.length < count; density++) {
      const columns = Math.max(2, Math.ceil(Math.sqrt(count * aspect)) + density);
      const rows = Math.max(2, Math.ceil(count / columns) + density);
      const candidates = [];
      sampleEven(yMin, yMax, rows).forEach((y, rowIndex) => {
        const xValues = sampleEven(xMin, xMax, columns);
        const row = rowIndex % 2 ? [...xValues].reverse() : xValues;
        row.forEach((x) => {
          const point = { x, y };
          if (!ValidationCore.pointInAngularZone(point, validationGeometry(), angularZone.enabled, angularZone.zone)) return;
          if (!pointAllowed(point)) return;
          candidates.push(point);
        });
      });
      if (candidates.length < count) continue;
      candidates.slice(0, count).forEach((point) => points.push({
        x: roundPoint(point.x), y: roundPoint(point.y), z, holdMs,
        pointId: `characterization-${String(points.length + 1).padStart(3, '0')}`,
      }));
    }
  }
  if (points.length < count && distribution !== 'grid' && xMin !== xMax && yMin !== yMax) {
    const halton = (index, base) => {
      let result = 0, fraction = 1 / base, value = index;
      while (value > 0) { result += fraction * (value % base); value = Math.floor(value / base); fraction /= base; }
      return result;
    };
    const seedOffset = distribution === 'seeded' ? 997 : 0;
    for (let index = 1; index <= Math.max(10000, count * 1000) && points.length < count; index++) {
      const sampleIndex = index + seedOffset;
      const point = { x: xMin + halton(sampleIndex, 2)*(xMax-xMin), y: yMin + halton(sampleIndex, 3)*(yMax-yMin) };
      if (!ValidationCore.pointInAngularZone(point, validationGeometry(), angularZone.enabled, angularZone.zone)) continue;
      if (!pointAllowed(point)) continue;
      points.push({ x: roundPoint(point.x), y: roundPoint(point.y), z, holdMs, pointId: `characterization-${String(points.length + 1).padStart(3, '0')}` });
    }
  } else if (points.length < count && (xMin === xMax || yMin === yMax)) {
    const candidates = Math.max(count, count * 20);
    for (let index = 0; index < candidates && points.length < count; index++) {
      const fraction = candidates === 1 ? 0.5 : index / (candidates - 1);
      const point = {
        x: roundPoint(xMin === xMax ? xMin : xMin + (xMax - xMin) * fraction),
        y: roundPoint(yMin === yMax ? yMin : yMin + (yMax - yMin) * fraction),
      };
      if (!pointAllowed(point)) continue;
      points.push({ ...point, z, holdMs, pointId: `characterization-${String(points.length + 1).padStart(3, '0')}` });
    }
  } else if (points.length < count && distribution !== 'grid') {
    const aspect = Math.max(1e-9, (xMax - xMin) / (yMax - yMin));
    const columns = Math.min(count, Math.max(1, Math.round(Math.sqrt(count * aspect))));
    const rows = Math.max(1, Math.ceil(count / columns));
    const xValues = sampleEven(xMin, xMax, columns);
    const yValues = sampleEven(yMin, yMax, rows);
    yValues.forEach((y, rowIndex) => {
      const row = rowIndex % 2 ? [...xValues].reverse() : xValues;
      row.forEach((x) => {
        if (points.length >= count) return;
        points.push({ x, y, z, holdMs, pointId: `characterization-${String(points.length + 1).padStart(3, '0')}` });
      });
    });
  }
  return {
    name: 'Characterization Auto Grid',
    points,
    count,
    summary: `Characterization Auto Grid: ${points.length} ${distribution === 'grid' ? 'row-and-column aligned raster' : angularZone.enabled ? 'distributed' : 'evenly spaced'} raw-measurement positions across X ${roundPoint(xMin)}–${roundPoint(xMax)} mm and Y ${roundPoint(yMin)}–${roundPoint(yMax)} mm.${angularZone.enabled ? ` Angular zone: ${angularZone.label}.` : ''}`,
  };
}

/** Implements the regenerate characterization plan from operator operation for this module. */
async function regenerateCharacterizationPlanFromOperator() {
  const plan = buildCharacterizationPlan();
  plan.points = optimizedExecutionPoints(plan.points);
  config.sequences[plan.name] = plan.points;
  config.activeSequence = plan.name;
  await radarAPI.configSet(config);
  updateSeqProgress();
  renderSpatialResults();
  renderPlanPreviewCanvas(plan.points, '', 'quick-formal-preview');
  return plan;
}

/** Implements the install formal validation plan operation for this module. */
function installFormalValidationPlan(zone, plan) {
  plan.points = optimizedExecutionPoints(plan.points);
  config.sequences[plan.name] = plan.points;
  config.activeSequence = plan.name;
  config.test.mode = zone;
}

/** Implements the regenerate formal plan from operator operation for this module. */
async function regenerateFormalPlanFromOperator() {
  const zone = activeTestId();
  if (!['inside', 'outside'].includes(zone)) return false;
  const plan = buildFormalValidationPlan(zone);
  if (plan.error) {
    await radarAPI.configSet(config);
    updateQuickRunPanel(plan.error, true);
    renderPlanPreviewCanvas([], plan.error, 'quick-formal-preview');
    return false;
  }
  installFormalValidationPlan(zone, plan);
  await radarAPI.configSet(config);
  updateSeqProgress();
  renderSpatialResults();
  renderPlanPreviewCanvas(plan.points, '', 'quick-formal-preview');
  return true;
}

/** Generates validation plan. */
function generateValidationPlan(zone) {
  config.validation = {
    ...(config.validation || {}),
    sensorLayout: document.getElementById('cfg-sensor-layout').value,
    radarTarget: ['ld021_pair', 'rcwl_pair'].includes(document.getElementById('cfg-sensor-layout').value)
      ? document.getElementById('cfg-sensor-layout').value : document.getElementById('cfg-radar-target').value,
    hilinkSensor: document.getElementById('cfg-hilink-sensor').value === 'B' ? 'B' : 'A',
    systemLevel: {
      requiredTriggerMm: readNumber('cfg-system-pass-inches', 12) * 25.4,
      requiredNoTriggerMm: readNumber('cfg-system-red-inches', 24) * 25.4,
    },
    singleSensorConfirmed: document.getElementById('cfg-radar-center-confirmed').checked,
    singleSensor: {
      centerX: readNumber('cfg-radar-center-x', config.validation?.singleSensor?.centerX || 875),
      centerY: readNumber('cfg-radar-center-y', config.validation?.singleSensor?.centerY || 1200),
      radiusMm: Math.max(0, readNumber('cfg-radius-mm', config.validation?.singleSensor?.radiusMm || 304.8)),
    },
    guardBandMm: Math.max(0, readNumber('cfg-guard-band-mm', 10)),
    pointCount: Math.max(1, Math.floor(readNumber('cfg-validation-point-count', 100))),
    angularZoneEnabled: document.getElementById('cfg-angular-zone-enabled').checked,
    angularZone: document.getElementById('cfg-angular-zone').value,
    outsideRadiusMm: document.getElementById('cfg-sensor-layout').value === 'dual'
      ? Math.max(762, readNumber('cfg-outside-radius-mm', 762))
      : Math.max(0, readNumber('cfg-outside-radius-mm', 457.2)),
  };
  const plan = buildFormalValidationPlan(zone);
  if (plan.error) { window.alert(plan.error); return; }
  installFormalValidationPlan(zone, plan);
  document.getElementById('cfg-test-mode').value = zone;
  populateSequenceSelect();
  renderSequenceTable();
  updateSeqProgress();
  renderGeneratorSummary(plan.points, plan.summary);
  schedulePlanPreviewRender(plan.points);
}

/** Attaches UI event handlers for config modal. */
function wireConfigModal() {
  document.getElementById('config-btn').addEventListener('click', openConfigModal);
  document.getElementById('config-close-btn').addEventListener('click', closeConfigModal);
  document.getElementById('config-cancel-btn').addEventListener('click', closeConfigModal);

  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      document.querySelector(`.tab-panel[data-tab-panel="${btn.dataset.tab}"]`).classList.add('active');
      if (btn.closest('#config-modal')) updateConfigTabPresentation(btn.dataset.tab);
    });
  });
  document.getElementById('recipe-family-select').addEventListener('change', (event) => {
    document.getElementById('recipe-pass-rate-row').hidden = !['inside', 'outside', 'system', 'custom'].includes(event.target.value);
  });
  document.querySelectorAll('#recipe-angular-zone-options input').forEach((input) => input.addEventListener('change', (event) => {
    const options = [...document.querySelectorAll('#recipe-angular-zone-options input')];
    if (event.target.checked && event.target.value === 'all') options.filter((option) => option.value !== 'all').forEach((option) => { option.checked = false; });
    else if (event.target.checked) {
      const all = options.find((option) => option.value === 'all');
      if (all) all.checked = false;
    }
    if (!options.some((option) => option.checked)) {
      const all = options.find((option) => option.value === 'all');
      if (all) all.checked = true;
    }
  }));
  document.getElementById('recipe-copy-btn').addEventListener('click', () => populateRecipeBuilder(activeRecipe(), true));
  document.getElementById('recipe-save-btn').addEventListener('click', async () => {
    const status = document.getElementById('recipe-builder-status');
    try {
      if (testRunning) throw new Error('Finish the active run before selecting a different recipe. Your edits remain in the form.');
      const recipe = recipeFromBuilder();
      if (!recipe.name.trim()) throw new Error('Enter a recipe name');
      if (recipe.systemBounds.requiredNoTriggerMm <= recipe.systemBounds.requiredTriggerMm) throw new Error('The grey/red boundary must be greater than the green boundary');
      config = RecipeCore.saveCustom(config, recipe);
      config = RecipeCore.apply(config, RecipeCore.find(config, config.recipes.activeId));
      const saved = await radarAPI.configSet(config);
      if (!saved?.success) throw new Error(saved?.error || 'Recipe was not saved');
      // A newly saved formal recipe must own a freshly generated plan before
      // the operator returns to Run a Test; do not require a second selector
      // change to clear the automatic-plan preflight blocker.
      await applyRecipeForSingleRun(config.recipes.activeId);
      populateRecipeSelectors();
      populateRecipeBuilder(activeRecipe());
      status.textContent = `${activeRecipe().name} v${activeRecipe().version} saved and selected for single runs and campaigns.`;
      updateQuickRunPanel(`Saved recipe: ${activeRecipe().name}`);
    } catch (error) {
      status.textContent = error?.message || String(error);
    }
  });

  document.getElementById('engineering-plan-select').addEventListener('change', (event) => loadEngineeringPlan(event.target.value));
  document.getElementById('engineering-plan-new-btn').addEventListener('click', () => {
    engineeringPlanState.isNew = true;
    engineeringPlanState.selectedId = '';
    engineeringPlanState.originalSignature = '';
    document.getElementById('engineering-plan-select').value = '';
    const name = document.getElementById('engineering-plan-name');
    name.value = `New Test Plan ${RecipeCore.all(config).length + 1}`;
    document.getElementById('engineering-plan-description').value = '';
    name.focus(); name.select();
    setEngineeringPlanStatus(null, 'New plan draft. Choose its test type, set its procedure, then Save Test Plan.');
  });
  document.getElementById('engineering-plan-duplicate-btn').addEventListener('click', () => {
    const source = engineeringPlanState.original || activeRecipe();
    engineeringPlanState.isNew = true;
    engineeringPlanState.selectedId = '';
    engineeringPlanState.originalSignature = '';
    document.getElementById('engineering-plan-select').value = '';
    const name = document.getElementById('engineering-plan-name');
    name.value = `${source.name} Copy`;
    document.getElementById('engineering-plan-description').value = source.description || '';
    name.focus(); name.select();
    setEngineeringPlanStatus(source, `Creating an editable copy of ${source.name}. Choose the test type and change any procedure values, then Save Test Plan.`);
  });
  document.getElementById('engineering-plan-rename-btn').addEventListener('click', () => {
    const recipe = engineeringPlanState.original;
    if (recipe?.builtIn) { setEngineeringPlanStatus(recipe, 'Built-in plans cannot be renamed. Use Duplicate and Edit to create a custom plan.'); return; }
    const name = document.getElementById('engineering-plan-name');
    name.focus(); name.select();
    setEngineeringPlanStatus(recipe, 'Edit the plan name, then Save Test Plan. The prior version remains in history.');
  });
  document.getElementById('engineering-plan-delete-btn').addEventListener('click', () => {
    const recipe = engineeringPlanState.original;
    if (!recipe || recipe.builtIn) { setEngineeringPlanStatus(recipe, 'Built-in plans cannot be deleted.'); return; }
    engineeringPlanState.deletedIds.add(recipe.id);
    const fallback = RecipeCore.builtIns().find((item) => item.family === recipe.family) || RecipeCore.builtIns()[0];
    loadEngineeringPlan(fallback.id);
    setEngineeringPlanStatus(fallback, `${recipe.name} will be deleted when you Save Test Plan. Its linked motion sequence is preserved.`);
  });
  document.getElementById('cfg-test-mode').addEventListener('change', (event) => {
    config.test = { ...(config.test || {}), mode: event.target.value };
    updateConfigModeVisibility();
    renderEngineeringPlanEditorState();
    scheduleEngineeringPlanPreview();
  });

  document.getElementById('seq-select').addEventListener('change', () => {
    config.activeSequence = document.getElementById('seq-select').value;
    renderSequenceTable();
    seedGeneratorDefaults();
  });

  document.getElementById('seq-add-row-btn').addEventListener('click', () => {
    readSequenceTableIntoConfig();
    const name = config.activeSequence;
    config.sequences[name].push({ x: 0, y: 0, z: 0, holdMs: config.trigger.holdMsDefault });
    renderSequenceTable();
  });

  document.getElementById('seq-new-btn').addEventListener('click', () => {
  readSequenceTableIntoConfig();

  let name = document.getElementById('seq-name-input')?.value?.trim();

  if (!name) {
    name = `New Sequence ${Object.keys(config.sequences).length + 1}`;
  }

  if (config.sequences[name]) {
    window.alert(`Sequence "${name}" already exists.`);
    return;
  }

  config.sequences[name] = [
    { x: 0, y: 0, z: 0, holdMs: config.trigger.holdMsDefault }
  ];

  config.activeSequence = name;
  populateSequenceSelect();
  renderSequenceTable();
});

document.getElementById('seq-rename-btn').addEventListener('click', () => {
  readSequenceTableIntoConfig();

  const oldName = config.activeSequence;
  const newName = document.getElementById('seq-name-input')?.value?.trim();

  if (!newName || newName === oldName) return;

  if (config.sequences[newName]) {
    window.alert(`Sequence "${newName}" already exists.`);
    return;
  }

  config.sequences[newName] = config.sequences[oldName];
  delete config.sequences[oldName];

  config.activeSequence = newName;
  populateSequenceSelect();
  renderSequenceTable();
});

  document.getElementById('seq-delete-btn').addEventListener('click', () => {
    const name = config.activeSequence;
    if (Object.keys(config.sequences).length <= 1) { window.alert('At least one sequence must exist.'); return; }
    if (!window.confirm(`Delete sequence "${name}"?`)) return;
    delete config.sequences[name];
    config.activeSequence = Object.keys(config.sequences)[0];
    populateSequenceSelect();
    renderSequenceTable();
  });

  document.getElementById('copy-ssh-btn').addEventListener('click', async () => {
    const host = document.getElementById('cfg-ssh-host').value;
    const user = document.getElementById('cfg-ssh-user').value;
    const port = parseInt(document.getElementById('cfg-ssh-port').value, 10) || 22;
    const res = await radarAPI.copySSHCommand(host, user, port);
    logEvent(`Copied to clipboard: ${res.command}`, 'info');
  });

  document.getElementById('seq-generator-pattern').addEventListener('change', () => {
    updateGeneratorPanelVisibility();
    previewGenerator();
  });
  document.getElementById('seq-gen-raster-mode').addEventListener('change', () => {
    updateRasterModeVisibility();
    previewGenerator();
  });
  document.getElementById('seq-generator-preview-btn').addEventListener('click', previewGenerator);
  document.getElementById('seq-generator-apply-btn').addEventListener('click', () => applyGeneratedSequence('replace'));
  document.getElementById('seq-generator-append-btn').addEventListener('click', () => applyGeneratedSequence('append'));
  document.getElementById('seq-generator-create-btn').addEventListener('click', () => applyGeneratedSequence('create'));
  document.getElementById('generate-inside-plan-btn').addEventListener('click', () => generateValidationPlan('inside'));
  document.getElementById('generate-outside-plan-btn').addEventListener('click', () => generateValidationPlan('outside'));
  document.getElementById('seq-import-load-btn').addEventListener('click', () => {
    document.getElementById('seq-import-file').click();
  });
  document.getElementById('seq-import-file').addEventListener('change', async (ev) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    document.getElementById('seq-import-csv').value = text;
    previewImportedCsv();
    ev.target.value = '';
  });
  document.getElementById('seq-import-preview-btn').addEventListener('click', previewImportedCsv);
  document.getElementById('seq-import-apply-btn').addEventListener('click', () => importCsvPoints('replace'));
  document.getElementById('seq-import-append-btn').addEventListener('click', () => importCsvPoints('append'));
  document.getElementById('seq-import-create-btn').addEventListener('click', () => importCsvPoints('create'));

  document.getElementById('config-modal').addEventListener('input', (ev) => {
    const id = ev.target?.id || '';
    if (
      id.startsWith('seq-gen-') ||
      id === 'seq-generator-pattern' ||
      id === 'seq-generator-hold'
    ) {
      previewGenerator();
    }
    if (id === 'cfg-reflector-clearance-mm') previewGenerator();
    if ([
      'cfg-plan-distribution', 'cfg-plan-min-x', 'cfg-plan-max-x',
      'cfg-plan-min-y', 'cfg-plan-max-y', 'cfg-validation-point-count',
      'cfg-angular-zone-enabled', 'cfg-angular-zone',
    ].includes(id)) scheduleEngineeringPlanPreview();
  });

  // Select controls are not guaranteed to emit `input` in every Electron/Chromium
  // interaction path, so refresh the live graph on their semantic change event too.
  ['cfg-plan-distribution', 'cfg-angular-zone-enabled', 'cfg-angular-zone']
    .forEach((id) => document.getElementById(id)?.addEventListener('change', scheduleEngineeringPlanPreview));

  const syncSystemBarrier = (sourceId) => {
    const source = document.getElementById(sourceId);
    const peer = document.getElementById(sourceId === 'cfg-system-grey-inches' ? 'cfg-system-red-inches' : 'cfg-system-grey-inches');
    if (source && peer) peer.value = source.value;
    updateSystemLevelSummary();
  };
  document.getElementById('cfg-system-pass-inches').addEventListener('input', updateSystemLevelSummary);
  document.getElementById('cfg-system-grey-inches').addEventListener('input', () => syncSystemBarrier('cfg-system-grey-inches'));
  document.getElementById('cfg-system-red-inches').addEventListener('input', () => syncSystemBarrier('cfg-system-red-inches'));

  document.getElementById('config-apply-btn').addEventListener('click', async () => {
    const applyButton = document.getElementById('config-apply-btn');
    const originalLabel = applyButton.textContent;
    applyButton.disabled = true;
    const appliedConfig = config;
    config = ConfigurationDraft.editable();
    applyButton.textContent = 'Applying…';

    try {
      const passBarrierInches = num('cfg-system-pass-inches');
      const redBarrierInches = num('cfg-system-red-inches');
      if (!(passBarrierInches > 0) || !(redBarrierInches > passBarrierInches)) {
        throw new Error('System Level barriers require a green boundary above 0 and a grey/red boundary greater than green.');
      }
      const planBounds = { minX: num('cfg-plan-min-x'), maxX: num('cfg-plan-max-x'), minY: num('cfg-plan-min-y'), maxY: num('cfg-plan-max-y') };
      if (!(planBounds.minX < planBounds.maxX) || !(planBounds.minY < planBounds.maxY)) {
        throw new Error('Test Plan movement bounds require X/Y minimums smaller than their maximums.');
      }
      const commissionedBounds = { minX: num('cfg-x-min'), maxX: num('cfg-x-max'), minY: num('cfg-y-min'), maxY: num('cfg-y-max') };
      if (planBounds.minX < commissionedBounds.minX || planBounds.maxX > commissionedBounds.maxX
        || planBounds.minY < commissionedBounds.minY || planBounds.maxY > commissionedBounds.maxY) {
        throw new Error(`Test Plan movement bounds must stay inside fixture travel: X ${commissionedBounds.minX}–${commissionedBounds.maxX}, Y ${commissionedBounds.minY}–${commissionedBounds.maxY} mm.`);
      }
      commitSequenceEdit();

    config.motion = { ...config.motion, unitsVersion: 2, commissioned: document.getElementById('cfg-motion-commissioned').checked };
    config.motion.x = { minMm: num('cfg-x-min'), maxMm: num('cfg-x-max'), speedMmS: num('cfg-x-speed'), accelMmS2: num('cfg-x-accel'), homeOffsetMm: num('cfg-x-offset') };
    config.motion.y = { minMm: num('cfg-y-min'), maxMm: num('cfg-y-max'), speedMmS: num('cfg-y-speed'), accelMmS2: num('cfg-y-accel'), homeOffsetMm: num('cfg-y-offset') };
    config.motion.z = { minMm: num('cfg-z-min'), maxMm: num('cfg-z-max'), speedMmS: num('cfg-z-speed'), accelMmS2: num('cfg-z-accel'), homeOffsetMm: num('cfg-z-offset') };
    if (config.motion.commissioned && ['x', 'y'].some((axis) => config.motion[axis].minMm <= -9000)) {
      throw new Error('Replace the X/Y -9999 placeholder minimums with measured travel limits before confirming commissioning.');
    }

    config.trigger.macro = document.getElementById('cfg-trigger-macro').value.trim() || 'REFLECTOR_SPIN';
    config.trigger.delayMs = num('cfg-trigger-delay');
    config.trigger.holdMsDefault = num('cfg-hold-default');
    config.trigger.positionTimeoutMs = num('cfg-pos-timeout');

config.radar = {
  timeoutMs: num('cfg-radar-timeout') || 2000,
  pollMs: num('cfg-radar-poll') || 100,
  baselineTimeoutMs: num('cfg-trigger-delay') || 3000,
};

config.test = {
  ...(config.test || {}),
  mode: document.getElementById('cfg-test-mode').value,
  dutId: document.getElementById('cfg-dut-id').value.trim(),
  cycleNumber: Math.max(1, num('cfg-cycle-number')),
  definitionFile: document.getElementById('cfg-definition-file').value.trim(),
  cyclesRequired: Math.max(1, Math.floor(num('cfg-cycles-required'))),
  minimumCorrectRate: ['inside', 'outside', 'system', 'custom'].includes(document.getElementById('cfg-test-mode').value)
    ? Math.min(1, Math.max(0, num('cfg-custom-minimum') / 100)) : null,
};

config.dut = {
  ...(config.dut || {}),
  reflectorClearanceMm: Math.max(0, num('cfg-reflector-clearance-mm')),
  activeLocationId: document.getElementById('cfg-sensor-layout').value === 'dual'
    ? document.getElementById('cfg-dut-location').value
    : config.dut?.activeLocationId || DutLocationCore.DEFAULT_LOCATION.id,
  locations: Array.isArray(config.dut?.locations) && config.dut.locations.length
    ? config.dut.locations : DutLocationCore.BUILT_IN_LOCATIONS,
};
const selectedDutCenter = DutLocationCore.geometry(activeDutLocation()).center;
const selectedSensorLayout = document.getElementById('cfg-sensor-layout').value;
const selectedPairSettings = {
  sensorA: { x: num('cfg-ld021-a-x'), y: num('cfg-ld021-a-y'), headingDeg: num('cfg-ld021-a-heading') },
  sensorB: { x: num('cfg-ld021-b-x'), y: num('cfg-ld021-b-y'), headingDeg: num('cfg-ld021-b-heading') },
  idleObservationMs: Math.max(0, num('cfg-ld021-idle-ms') || 10000),
  startupStabilizationMs: Math.max(0, num('cfg-ld021-startup-ms') || 10000),
  correlationWindowMs: Math.max(1, num('cfg-ld021-correlation-ms') || 250),
};

config.validation = {
  ...(config.validation || {}),
  sensorLayout: selectedSensorLayout,
  geometrySemantics: selectedSensorLayout === 'dual'
    ? ValidationCore.GEOMETRY_SEMANTICS.DUAL_SYSTEM_BANDS
    : ['ld021_pair', 'rcwl_pair'].includes(selectedSensorLayout)
      ? `${selectedSensorLayout.replace('_', '-')}-characterization`
      : ValidationCore.GEOMETRY_SEMANTICS.SINGLE_SENSOR_LOBE,
  systemLevel: {
    requiredTriggerMm: num('cfg-system-pass-inches') * 25.4,
    requiredNoTriggerMm: num('cfg-system-red-inches') * 25.4,
  },
  radarTarget: ['ld021_pair', 'rcwl_pair'].includes(selectedSensorLayout) ? selectedSensorLayout
    : document.getElementById('cfg-radar-target').value,
  hilinkSensor: document.getElementById('cfg-hilink-sensor').value === 'B' ? 'B' : 'A',
  singleSensorConfirmed: document.getElementById('cfg-radar-center-confirmed').checked,
  singleSensor: {
    centerX: num('cfg-radar-center-x'),
    centerY: num('cfg-radar-center-y'),
    radiusMm: Math.max(0, num('cfg-radius-mm')),
  },
  guardBandMm: Math.max(0, num('cfg-guard-band-mm')),
  characterizationBounds: { ...planBounds },
  pointDistribution: document.getElementById('cfg-plan-distribution').value,
  pointCount: Math.max(1, Math.floor(num('cfg-validation-point-count'))),
  coverageMode: normalizedCoverageMode(document.getElementById('cfg-coverage-mode').value),
  coverageSides: coverageSidesForMode(document.getElementById('cfg-coverage-mode').value),
  angularZoneEnabled: document.getElementById('cfg-angular-zone-enabled').checked,
  angularZone: document.getElementById('cfg-angular-zone').value,
  outsideRadiusMm: document.getElementById('cfg-sensor-layout').value === 'dual'
    ? Math.max(762, num('cfg-outside-radius-mm'))
    : Math.max(0, num('cfg-outside-radius-mm')),
  systemReference: { x: selectedDutCenter.x, y: selectedDutCenter.y, confirmed: true },
  ld021Pair: selectedSensorLayout === 'ld021_pair' ? selectedPairSettings : config.validation?.ld021Pair,
  rcwlPair: selectedSensorLayout === 'rcwl_pair' ? selectedPairSettings : config.validation?.rcwlPair,
};

    config.logging.enabled = document.getElementById('cfg-logging-enabled').checked;
    config.ssh.host = document.getElementById('cfg-ssh-host').value.trim();
    config.ssh.username = document.getElementById('cfg-ssh-user').value.trim();
    config.ssh.port = num('cfg-ssh-port');
    config.radarService = {
      ...(config.radarService || {}),
      port: Math.min(65535, Math.max(1, Math.floor(num('cfg-radar-service-port') || 7130))),
      timeoutMs: Math.max(250, Math.floor(num('cfg-radar-service-timeout') || 2500)),
      requireVerifiedSettings: document.getElementById('cfg-radar-require-verified').checked,
    };
      const engineeringDraftRecipe = engineeringRecipeFromConfig();
      const editingSharedPlan = Boolean(engineeringPlanState.selectedId || engineeringPlanState.isNew);
      if (editingSharedPlan) {
        // Engineering edits define reusable intent. Motion is generated and safety-checked
        // later, when an operator prepares this plan for the selected fixture location.
        const saved = await radarAPI.configSet(config);
        if (!saved?.success) throw new Error(saved?.error || 'Configuration was not saved.');
        updateSeqProgress();
        updateQuickRunPanel();
        renderSpatialResults();
      } else if (['inside', 'outside'].includes(activeTestId())) {
        const planApplied = await regenerateFormalPlanFromOperator();
        if (!planApplied) {
          const planError = buildFormalValidationPlan(activeTestId()).error;
          throw new Error(planError || 'The validation plan could not be regenerated from the new settings.');
        }
      } else if (activeTestId() === 'system') {
        const planApplied = await regenerateSystemValidationPlan();
        if (!planApplied) throw new Error('The System Level plan could not be regenerated from the new settings.');
      } else if (['characterization', 'interference'].includes(activeTestId())) {
        const linkedManualPlan = engineeringDraftRecipe.sequenceName
          && ['manual', 'imported'].includes(engineeringDraftRecipe.distribution)
          && Array.isArray(config.sequences?.[engineeringDraftRecipe.sequenceName]);
        if (linkedManualPlan) {
          config.activeSequence = engineeringDraftRecipe.sequenceName;
          const saved = await radarAPI.configSet(config);
          if (!saved?.success) throw new Error(saved?.error || 'The linked characterization sequence was not saved.');
        } else {
          const plan = await regenerateCharacterizationPlanFromOperator();
          if (!plan?.points?.length) throw new Error('The characterization plan contains no usable positions.');
        }
      } else {
        const saved = await radarAPI.configSet(config);
        if (!saved?.success) throw new Error(saved?.error || 'Configuration was not saved.');
        updateSeqProgress();
        updateQuickRunPanel();
        renderSpatialResults();
      }
      const deletedPlanIds = [...engineeringPlanState.deletedIds];
      const savedEngineeringPlan = saveEngineeringPlanIfChanged();
      config.recipes = { ...(config.recipes || {}), activeId: savedEngineeringPlan.id };
      const planSave = await radarAPI.configSet(config);
      if (!planSave?.success) throw new Error(planSave?.error || 'The shared test plan was not saved.');
      for (const planId of deletedPlanIds) {
        const deletion = await radarAPI.testPlanDelete(planId);
        if (deletion.success) config.testPlans = deletion.catalog;
      }
      if (!savedEngineeringPlan.builtIn) {
        const repositorySave = await radarAPI.testPlanSave(TestPlanCore.fromLegacyRecipe(savedEngineeringPlan));
        if (!repositorySave?.success) throw new Error(repositorySave?.error || 'The canonical test plan was not saved.');
        config.testPlans = repositorySave.catalog;
      }
      populateRecipeSelectors();
      populateEngineeringPlanSelect(savedEngineeringPlan.id);
      refreshGuidedPlanOptionsPreservingInputs();
    if (connected) await refreshRadarSettings(false);

    if (connected && motionEnabled()) {
      const velocity = Math.max(config.motion.x.speedMmS, config.motion.y.speedMmS, config.motion.z.speedMmS);
      const accel = Math.max(config.motion.x.accelMmS2, config.motion.y.accelMmS2, config.motion.z.accelMmS2);
      const vRes = await radarAPI.setVelocityLimit(velocity, accel);
      logEvent(vRes.success
        ? `Pushed SET_VELOCITY_LIMIT VELOCITY=${velocity} ACCEL=${accel} to Klipper (global — not per-axis, see Motion tab note)`
        : `Failed to push velocity limit: ${vRes.error}`, vRes.success ? 'info' : 'error');

      const oRes = await radarAPI.setGcodeOffset(config.motion.x.homeOffsetMm, config.motion.y.homeOffsetMm, config.motion.z.homeOffsetMm);
      logEvent(oRes.success ? 'Pushed SET_GCODE_OFFSET to Klipper' : `Failed to push offsets: ${oRes.error}`, oRes.success ? 'info' : 'error');
    }

      config = ConfigurationDraft.commit(config);
      appStore.dispatch({ type: 'CONFIG_COMMITTED', config });
      logEvent('Configuration saved', 'info');
      closeConfigModal();
    } catch (error) {
      config = appliedConfig;
      ConfigurationDraft.discard();
      appStore.dispatch({ type: 'CONFIG_DRAFT_DISCARDED' });
      const message = error?.message || String(error);
      logEvent(`Configuration apply failed: ${message}`, 'error');
      window.alert(`Configuration could not be applied.\n\n${message}`);
    } finally {
      applyButton.disabled = testRunning;
      applyButton.textContent = originalLabel;
      updateEngineeringSetupEditability();
    }
  });

  /** Implements the num operation for this module. */
  function num(id) { return parseFloat(document.getElementById(id).value) || 0; }
}

// ─── IPC status feed ──────────────────────────────────────────────────────────
/** Sets up events. */
function setupEvents() {
  radarAPI.onRunState((state) => {
    authoritativeRunState = state;
    appStore.dispatch({ type: 'RUN_STATE_CHANGED', run: state });
    if (state && ['abort_requested', 'faulted', 'recovery_required'].includes(state.status)) {
      testAborted = true;
      campaignAutoRunStopRequested = true;
    }
  });
  radarAPI.onStatus((d) => {
    connected = !!d.piOnline;
    appStore.dispatch({ type: 'CONNECTION_CHANGED', connection: { connected, klippyState: d.klippyState || 'unknown' } });
    if (d.piOnline) {
      klippyState = d.klippyState;
      idleState = d.idleState;
      homedAxes = d.homedAxes || '';
      position = d.position;
      updatePositionUI();
    } else {
      klippyState = 'unknown';
    }
    updateStatusGrid();

    if (connected && campaignOperatorStatus?.active && campaignOperatorStatus.method?.autoRun === true
      && campaignOperatorStatus.next && !campaignAutoRunActive && !testRunning) {
      void runAutomaticCampaign();
    }

    if (testRunning && klippyState === 'shutdown' && !testAborted) {
      testAborted = true;
      void radarAPI.abortRun('Klipper entered shutdown during the run');
      logEvent('Klipper entered shutdown state during sequence — aborting', 'error');
    }
  });

  radarAPI.onLogPath((p) => {
    document.getElementById('log-path-display').textContent = p;
    document.getElementById('log-path-footer').textContent = p;
  });
}

// ─── Misc buttons ─────────────────────────────────────────────────────────────
const guidedFlowState = { originalDraft: null, selection: OperatorFlowState.create() };

function setGuidedOptions(select, items, placeholder, selected = '') {
  const signature = JSON.stringify([placeholder, ...items.map((item) => [item.id, item.label || item.name])]);
  if (select.dataset.optionSignature !== signature) {
    select.innerHTML = `<option value="">${escapeHtml(placeholder)}</option>${items.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.label || item.name)}</option>`).join('')}`;
    select.dataset.optionSignature = signature;
    window.__operatorFlowDiagnostics.optionRebuilds += 1;
  }
  if (items.some((item) => item.id === selected)) select.value = selected;
  else select.value = '';
}

function guidedHardware() { return OperatorFlowCore.hardwareById(guidedFlowState.selection.hardwareId); }

function guidedDraftFromFields() {
  const scored = OperatorFlowCore.typeById(document.getElementById('guided-test-type').value)?.scored === true;
  return {
    sourceRecipeId: document.getElementById('guided-test-plan').value,
    testType: document.getElementById('guided-test-type').value,
    pointCount: Math.max(1, Math.min(2000, Math.floor(Number(document.getElementById('guided-plan-points').value) || 1))),
    pointLayout: document.getElementById('guided-plan-layout').value || 'even',
    cycles: Math.max(1, Math.min(100, Math.floor(Number(document.getElementById('guided-plan-cycles').value) || 1))),
    angularZone: document.getElementById('guided-plan-zone').value || 'all',
    minimumCorrectRate: scored ? Math.min(1, Math.max(0, (Number(document.getElementById('guided-plan-pass').value) || 0) / 100)) : null,
    bounds: {
      minX: Number(document.getElementById('guided-bound-min-x').value), maxX: Number(document.getElementById('guided-bound-max-x').value),
      minY: Number(document.getElementById('guided-bound-min-y').value), maxY: Number(document.getElementById('guided-bound-max-y').value),
    },
  };
}

function guidedBoundsIssue(bounds = {}) {
  if (!Object.values(bounds).every(Number.isFinite)) return 'Enter finite X and Y movement bounds.';
  if (!(bounds.minX < bounds.maxX) || !(bounds.minY < bounds.maxY)) return 'Movement minimums must be smaller than maximums.';
  const fixture = fixtureXyBounds();
  if (bounds.minX < fixture.minX || bounds.maxX > fixture.maxX || bounds.minY < fixture.minY || bounds.maxY > fixture.maxY) {
    return `Movement bounds must stay inside fixture travel: X ${fixture.minX}–${fixture.maxX}, Y ${fixture.minY}–${fixture.maxY} mm.`;
  }
  return '';
}

let guidedPreviewRaf = null;
function scheduleGuidedDraftPreview() {
  if (guidedPreviewRaf !== null) cancelAnimationFrame(guidedPreviewRaf);
  guidedPreviewRaf = requestAnimationFrame(() => {
    guidedPreviewRaf = null;
    if (!guidedFlowState.originalDraft) return;
    const draft = guidedDraftFromFields();
    if (guidedBoundsIssue(draft.bounds)) return;
    const source = RecipeCore.find(config, draft.sourceRecipeId);
    const hardware = guidedHardware();
    if (!source || !hardware) return;
    const savedConfig = config;
    try {
      const previewRecipe = RecipeCore.normalize({ ...source, family: draft.testType, pointCount: draft.pointCount,
        distribution: draft.pointLayout, cycles: draft.cycles, angularZones: [draft.angularZone], minimumCorrectRate: draft.minimumCorrectRate,
        geometry: { ...(source.geometry || {}), sensorLayout: hardware.sensorLayout, radarTarget: hardware.radarTarget,
          ...(hardware.hilinkSensor ? { hilinkSensor: hardware.hilinkSensor } : {}),
          dutLocationId: document.getElementById('guided-dut-location').value, characterizationBounds: { ...draft.bounds } } });
      config = RecipeCore.apply(config, previewRecipe);
      let preview;
      if (['inside', 'outside'].includes(draft.testType)) preview = buildFormalValidationPlan(draft.testType);
      else if (draft.testType === 'system') preview = buildSystemValidationPlan(draft.angularZone, draft.pointCount);
      else if (['characterization', 'interference'].includes(draft.testType)) preview = buildCharacterizationPlan();
      else preview = { points: config.sequences?.[previewRecipe.sequenceName || config.activeSequence] || [], summary: 'Saved manual/imported positions' };
      if (preview?.points?.length) renderPlanPreviewCanvas(preview.points, preview.summary || '', 'guided-plan-preview');
      else if (preview?.error) renderPlanPreviewCanvas([], preview.error, 'guided-plan-preview');
    } finally {
      config = savedConfig;
    }
  });
}

function guidedOutputNamePreview(draft = guidedFlowState.originalDraft ? guidedDraftFromFields() : null) {
  const labels = { inside: '10.1', outside: '10.2', system: 'SYSTEM', characterization: 'CHAR', interference: 'INTERFERENCE', custom: 'CUSTOM', sequence: 'UNSCORED' };
  const safePart = (value, fallback, limit) => String(value || fallback)
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, limit) || fallback;
  const safeDut = safePart(document.getElementById('guided-dut-id').value, 'no-DUT', 24);
  const cycles = Math.max(1, Number(draft?.cycles) || 1);
  const hardware = guidedHardware();
  const sensor = {
    'moresense-single': 'MS58-SINGLE', 'moresense-dual': 'MORESENSE-DUAL',
    'ld021-a': 'HLK-LD021-A', 'ld021-b': 'HLK-LD021-B', 'ld021-system': 'HLK-LD021-PAIR', 'ld021-pair': 'HLK-LD021-PAIR',
    'rcwl-single': 'RCWL-SINGLE', 'rcwl-dual': 'RCWL-DUAL', 'rcwl-pair': 'RCWL-PAIR',
  }[hardware?.id] || 'SENSOR';
  const snapshot = RadarSettingsCore.traceabilitySnapshot(radarSettingsState) || {};
  const target = hardware?.radarTarget || snapshot.activeTarget;
  const sensorKey = target === 'ld021_pair' || hardware?.id === 'ld021-a' ? 'LD021_A'
    : hardware?.id === 'ld021-b' ? 'LD021_B' : target === 'ld021' ? 'LD021' : target === 'single' ? 'SINGLE' : 'A';
  const setting = snapshot.sensors?.[sensorKey] || {};
  const gain = Number.isInteger(Number(setting.gainCode)) ? `0x${Number(setting.gainCode).toString(16).toUpperCase().padStart(2, '0')}` : 'unknown';
  const threshold = Number.isFinite(Number(setting.threshold)) ? Math.trunc(Number(setting.threshold)) : 'unknown';
  const settings = hardware?.fixedOutput ? 'FIXED' : String(target).startsWith('ld021') ? `T${threshold}` : `G${gain}-T${threshold}`;
  const selectedPlan = activePlanCatalog().find(document.getElementById('guided-test-plan').value);
  const plan = safePart(selectedPlan?.name, 'unnamed-plan', 36);
  return `DUT-${safeDut}_${sensor}_${labels[draft?.testType] || 'TEST'}_PLAN-${plan}_${settings}_${cycles}${cycles === 1 ? 'cycle' : 'cycles'}_[date]_[time]`;
}

function updateGuidedOutputReview(draft = guidedFlowState.originalDraft ? guidedDraftFromFields() : null) {
  const output = document.getElementById('guided-output-name');
  if (output) output.textContent = draft ? `Output folder: ${guidedOutputNamePreview(draft)}` : '';
}

function updateGuidedReview() {
  const draft = guidedFlowState.originalDraft ? guidedDraftFromFields() : null;
  const dirty = !!draft && OperatorFlowCore.draftChanged(guidedFlowState.originalDraft, draft);
  document.getElementById('guided-derived-name-row').hidden = !dirty;
  document.getElementById('guided-prepare-btn').textContent = dirty ? 'Save New Plan & Preview Grid' : 'Save & Preview Grid';
  if (!draft) return;
  const type = OperatorFlowCore.typeById(draft.testType), hardware = guidedHardware();
  const zone = OperatorFlowCore.ZONES.find((item) => item.id === draft.angularZone)?.label || 'Whole zone';
  const layout = { even: 'Even distribution', boundary: 'Boundary emphasis', grid: 'Raster grid', seeded: 'Repeatable seeded', imported: 'Imported points', manual: 'Manual points' }[draft.pointLayout] || draft.pointLayout;
  document.getElementById('guided-review').textContent = `${hardware?.label || 'Sensor'} · ${type?.label || 'Test'} · ${draft.pointCount} points · ${layout} · X ${draft.bounds.minX}–${draft.bounds.maxX} mm · Y ${draft.bounds.minY}–${draft.bounds.maxY} mm · ${zone} · ${draft.cycles} cycle${draft.cycles === 1 ? '' : 's'}${type?.scored ? ` · ${(draft.minimumCorrectRate * 100).toFixed(1)}% pass threshold` : ' · observational/unscored'}`;
  updateGuidedOutputReview(draft);
  renderGuidedRunReadiness();
}

function renderGuidedRunReadiness() {
  const selection = guidedFlowState.selection;
  const dutId = document.getElementById('guided-dut-id').value.trim();
  const draft = guidedFlowState.originalDraft ? guidedDraftFromFields() : null;
  const dirty = !!draft && OperatorFlowCore.draftChanged(guidedFlowState.originalDraft, draft);
  const derivedName = document.getElementById('guided-derived-name').value.trim();
  const boundsIssue = draft ? guidedBoundsIssue(draft.bounds) : '';
  const complete = Boolean(selection.layout && selection.hardwareId && selection.locationId && dutId && selection.testType && selection.planId && draft && !boundsIssue && (!dirty || derivedName));
  const button = document.getElementById('guided-prepare-btn');
  button.disabled = testRunning || !complete;
  button.title = complete ? 'Save this setup and generate its grid without starting motion' : dirty && !derivedName ? 'Name the modified test plan first' : 'Complete each test-selection step first';
  const runButton = document.getElementById('guided-run-btn');
  const prepared = Boolean(pendingPreparedRun) && !dirty;
  runButton.disabled = testRunning || !complete || !prepared;
  runButton.title = prepared ? 'Run the saved grid after final safety checks' : 'Save and preview the current grid first';
  const readiness = document.getElementById('guided-readiness');
  if (!readiness) return;
  if (!complete) {
    readiness.textContent = boundsIssue || (dirty && !derivedName ? 'Name the modified test plan to continue.' : !dutId ? 'Enter the DUT name to continue.' : 'Complete the selections above to continue.');
    readiness.className = 'guided-review blocked';
    return;
  }
  const fixtureChecks = [
    motionEnabled() ? '' : 'fixture connection',
    commissioningBlockingIssue() ? 'motion commissioning' : '',
    radarSettingsBlockingIssue() ? 'radar verification' : '',
  ].filter(Boolean);
  readiness.textContent = !prepared
    ? 'Selections complete. Save and preview the grid before running.'
    : fixtureChecks.length
      ? `Grid saved. Run is currently waiting for: ${fixtureChecks.join(', ')}. Final route and output checks run at start.`
      : 'Grid saved and ready to inspect. Run Test starts the final safety checks and fixture motion.';
  readiness.className = `guided-review${fixtureChecks.length ? ' blocked' : ''}`;
}

function loadGuidedPlanDraft() {
  const recipeId = document.getElementById('guided-test-plan').value;
  const recipe = recipeId ? activePlanCatalog().find(recipeId) : null;
  const review = document.getElementById('guided-review-step');
  if (!recipe || recipe.testType !== document.getElementById('guided-test-type').value) {
    review.hidden = true; guidedFlowState.originalDraft = null; renderGuidedRunReadiness(); return;
  }
  const draft = OperatorFlowCore.planDraft(recipe, config.validation?.characterizationBounds);
  guidedFlowState.originalDraft = { ...draft };
  document.getElementById('guided-plan-points').value = draft.pointCount;
  document.getElementById('guided-plan-layout').value = draft.pointLayout;
  document.getElementById('guided-plan-cycles').value = draft.cycles;
  document.getElementById('guided-plan-zone').value = draft.angularZone;
  document.getElementById('guided-bound-min-x').value = draft.bounds.minX;
  document.getElementById('guided-bound-max-x').value = draft.bounds.maxX;
  document.getElementById('guided-bound-min-y').value = draft.bounds.minY;
  document.getElementById('guided-bound-max-y').value = draft.bounds.maxY;
  const pass = document.getElementById('guided-plan-pass');
  pass.value = recipe.scored ? Number((draft.minimumCorrectRate * 100).toFixed(1)) : '';
  pass.disabled = !recipe.scored;
  pass.placeholder = recipe.scored ? '' : 'Not applicable';
  document.getElementById('guided-derived-name').value = '';
  review.hidden = false;
  updateGuidedReview();
  scheduleGuidedDraftPreview();
}

function refreshGuidedPlanOptionsPreservingInputs() {
  const planSelect = document.getElementById('guided-test-plan');
  const currentPlanId = planSelect.value;
  const recipes = OperatorFlowCore.compatiblePlans(RecipeCore.all(config), {
    hardwareId: document.getElementById('guided-sensor').value,
    testType: document.getElementById('guided-test-type').value,
  });
  setGuidedOptions(planSelect, recipes, recipes.length ? 'Choose a compatible plan…' : 'No compatible plans', currentPlanId);
  document.getElementById('guided-plan-help').textContent = recipes.length ? `${recipes.length} compatible plan${recipes.length === 1 ? '' : 's'} available for this test type.` : 'No saved plan is compatible with this hardware and test type.';
}

function guidedStateLocations(hardware) {
  if (!hardware) return [];
  return hardware.systemGeometry
    ? (Array.isArray(config.dut?.locations) && config.dut.locations.length ? config.dut.locations : DutLocationCore.BUILT_IN_LOCATIONS)
    : [DutLocationCore.SINGLE_SENSOR_LOCATION, DutLocationCore.SINGLE_SENSOR_DUT_LOCATION, DutLocationCore.ORIGINAL_LOCATION];
}

/** Performs one targeted render pass after an operator-flow state transition. */
function renderGuidedFlowState() {
  const renderStarted = performance.now();
  const state = guidedFlowState.selection;
  const hardwareItems = OperatorFlowCore.hardwareForLayout(state.layout);
  const hardware = OperatorFlowCore.hardwareById(state.hardwareId);
  const locations = guidedStateLocations(hardware);
  const types = hardware ? OperatorFlowCore.TEST_TYPES.filter((type) => OperatorFlowCore.supportsType(hardware, type.id)) : [];
  const plans = state.testType ? OperatorFlowCore.compatiblePlans(activePlanCatalog().list(), { hardwareId: state.hardwareId, testType: state.testType }) : [];
  guidedFlowState.selection = OperatorFlowState.reconcile(state, { hardware: hardwareItems, locations, testTypes: types, plans });
  const next = guidedFlowState.selection;

  document.getElementById('guided-layout').value = next.layout;
  setGuidedOptions(document.getElementById('guided-sensor'), hardwareItems, 'Choose a sensor...', next.hardwareId);
  setGuidedOptions(document.getElementById('guided-dut-location'), locations, 'Choose a location...', next.locationId);
  setGuidedOptions(document.getElementById('guided-test-type'), types, 'Choose a test type...', next.testType);
  setGuidedOptions(document.getElementById('guided-test-plan'), plans, plans.length ? 'Choose a compatible plan...' : 'No compatible plans', next.planId);
  document.getElementById('guided-sensor-step').hidden = !next.layout;
  document.getElementById('guided-location-step').hidden = !next.hardwareId;
  document.getElementById('guided-dut-step').hidden = !next.locationId;
  document.getElementById('guided-type-step').hidden = !next.locationId;
  document.getElementById('guided-plan-step').hidden = !next.testType;
  document.getElementById('guided-output-step').hidden = !next.planId;
  document.getElementById('guided-readiness-step').hidden = !next.planId;
  document.getElementById('guided-plan-help').textContent = plans.length ? `${plans.length} compatible plan${plans.length === 1 ? '' : 's'} available for this test type.` : 'No saved plan is compatible with this hardware and test type.';
  loadGuidedPlanDraft();
  const elapsed = performance.now() - renderStarted;
  window.__operatorFlowDiagnostics.renders += 1;
  window.__operatorFlowDiagnostics.maxRenderMs = Math.max(window.__operatorFlowDiagnostics.maxRenderMs, elapsed);
}

function dispatchGuided(action) {
  window.__operatorFlowDiagnostics.transitions += 1;
  guidedFlowState.selection = OperatorFlowState.reduce(guidedFlowState.selection, action);
  guidedFlowState.originalDraft = null;
  pendingPreparedRun = null;
  if (!testRunning) currentPreparedRun = null;
  renderGuidedFlowState();
  renderGuidedRunReadiness();
}

function populateGuidedOperatorPath() {
  const zoneSelect = document.getElementById('guided-plan-zone');
  if (zoneSelect.options.length === 0) setGuidedOptions(zoneSelect, OperatorFlowCore.ZONES, 'Choose a zone…', 'all');
  const currentHardware = OperatorFlowCore.HARDWARE.find((item) => item.sensorLayout === config.validation?.sensorLayout && item.radarTarget === config.validation?.radarTarget && (!item.hilinkSensor || item.hilinkSensor === config.validation?.hilinkSensor));
  const layout = currentHardware?.layout || (config.validation?.sensorLayout === 'dual' ? 'dual' : 'single');
  guidedFlowState.selection = OperatorFlowState.create({
    layout, hardwareId: currentHardware?.id || '', locationId: config.dut?.activeLocationId || '',
    testType: config.test?.mode || '', planId: config.recipes?.activeId || '',
  });
  renderGuidedFlowState();
  const dutId = document.getElementById('guided-dut-id');
  if (document.activeElement !== dutId) dutId.value = config.test?.dutId || '';
  updateGuidedOutputReview();
  renderGuidedRunReadiness();
}

function openGuidedPlanManager() {
  const selectedPlanId = document.getElementById('guided-test-plan').value;
  openConfigModal('sequence');
  if (selectedPlanId) loadEngineeringPlan(selectedPlanId);
}

async function prepareGuidedOperatorPath() {
  const status = document.getElementById('guided-status'), button = document.getElementById('guided-prepare-btn');
  const hardware = guidedHardware(), draft = guidedDraftFromFields(), source = draft.sourceRecipeId ? RecipeCore.find(config, draft.sourceRecipeId) : null;
  status.className = '';
  if (!hardware || !source || source.family !== draft.testType) return false;
  if (testRunning) { status.textContent = 'Finish the active run before preparing another test.'; status.className = 'error'; return false; }
  button.disabled = true;
  try {
    const dirty = OperatorFlowCore.draftChanged(guidedFlowState.originalDraft, draft);
    const boundsIssue = guidedBoundsIssue(draft.bounds);
    if (boundsIssue) throw new Error(boundsIssue);
    const locationId = document.getElementById('guided-dut-location').value;
    const overrides = { family: draft.testType, pointCount: draft.pointCount, distribution: draft.pointLayout, cycles: draft.cycles, angularZones: [draft.angularZone], minimumCorrectRate: draft.minimumCorrectRate,
      compatibility: { hardwareIds: [hardware.id], sensorLayouts: [hardware.sensorLayout] }, geometry: { ...(source.geometry || {}), sensorLayout: hardware.sensorLayout, radarTarget: hardware.radarTarget,
        ...(hardware.hilinkSensor ? { hilinkSensor: hardware.hilinkSensor } : {}), dutLocationId: locationId, characterizationBounds: { ...draft.bounds } } };
    let recipe = RecipeCore.normalize({ ...source, ...overrides });
    if (dirty) {
      config = RecipeCore.createDerived(config, source, overrides, document.getElementById('guided-derived-name').value);
      recipe = RecipeCore.find(config, config.recipes.activeId);
      const repositorySave = await radarAPI.testPlanSave(TestPlanCore.fromLegacyRecipe(recipe));
      if (!repositorySave?.success) throw new Error(repositorySave?.error || 'The new test plan was not saved');
      config.testPlans = repositorySave.catalog;
    }
    config = RecipeCore.apply(config, recipe);
    config.validation = { ...(config.validation || {}), sensorLayout: hardware.sensorLayout, radarTarget: hardware.radarTarget,
      ...(hardware.hilinkSensor ? { hilinkSensor: hardware.hilinkSensor } : {}), geometrySemantics: hardware.systemGeometry ? ValidationCore.GEOMETRY_SEMANTICS.DUAL_SYSTEM_BANDS : ValidationCore.GEOMETRY_SEMANTICS.SINGLE_SENSOR_LOBE };
    config.test = { ...(config.test || {}), dutId: document.getElementById('guided-dut-id').value.trim(), singleRunRepeats: 1 };
    config.dut = { ...(config.dut || {}), activeLocationId: locationId };
    let generated = true;
    if (['inside', 'outside'].includes(draft.testType)) generated = await regenerateFormalPlanFromOperator();
    else if (draft.testType === 'system') generated = await regenerateSystemValidationPlan();
    else if (['characterization', 'interference'].includes(draft.testType)) generated = await regenerateCharacterizationPlanFromOperator();
    else await radarAPI.configSet(config);
    if (!generated) throw new Error('A safe test plan could not be generated inside fixture travel.');
    pendingPreparedRun = RunWorkspaceCore.prepare({
      plan: activeTestPlan(), draft: currentRunSetup(),
      generatedPoints: optimizedExecutionPoints(config.sequences?.[config.activeSequence] || []),
      resolvedHardware: hardware, resolvedGeometry: validationGeometry(),
      acceptanceRules: activeDefinition()?.acceptance || {},
    });
    populateRecipeSelectors(); updateQuickRunPanel();
    guidedFlowState.originalDraft = OperatorFlowCore.planDraft(recipe);
    document.getElementById('guided-derived-name').value = '';
    updateGuidedReview();
    status.textContent = `${recipe.name} saved and prepared. Inspect the grid, then select Run Test when ready.`;
    return true;
  } catch (error) { status.textContent = error.message; status.className = 'error'; return false; }
  finally { button.disabled = false; }
}

async function runPreparedGuidedTest() {
  const status = document.getElementById('guided-status');
  if (!pendingPreparedRun) {
    status.textContent = 'Save and preview the current grid before running.';
    status.className = 'error';
    return;
  }
  const preflight = testPreflight();
  if (!preflight.ready) {
    status.textContent = preflight.reason;
    status.className = 'error';
    return;
  }
  await runSequence();
}

/** Attaches UI event handlers for quick run panel. */
async function wireQuickRunPanel() {
  setGuidedOptions(document.getElementById('guided-plan-zone'), OperatorFlowCore.ZONES, 'Choose a zone…', 'all');
  document.getElementById('guided-layout').addEventListener('change', (event) => dispatchGuided({ type: 'layoutSelected', value: event.target.value }));
  document.getElementById('guided-sensor').addEventListener('change', (event) => dispatchGuided({ type: 'hardwareSelected', value: event.target.value }));
  document.getElementById('guided-dut-location').addEventListener('change', (event) => dispatchGuided({ type: 'locationSelected', value: event.target.value }));
  document.getElementById('guided-test-type').addEventListener('change', (event) => dispatchGuided({ type: 'testTypeSelected', value: event.target.value }));
  document.getElementById('guided-test-plan').addEventListener('change', (event) => dispatchGuided({ type: 'planSelected', value: event.target.value }));
  ['guided-plan-points', 'guided-plan-layout', 'guided-plan-zone', 'guided-plan-cycles', 'guided-plan-pass',
    'guided-bound-min-x', 'guided-bound-max-x', 'guided-bound-min-y', 'guided-bound-max-y']
    .forEach((id) => document.getElementById(id).addEventListener('input', () => { pendingPreparedRun = null; updateGuidedReview(); scheduleGuidedDraftPreview(); }));
  ['guided-dut-id', 'guided-derived-name'].forEach((id) => document.getElementById(id).addEventListener('input', () => { pendingPreparedRun = null; updateGuidedOutputReview(); renderGuidedRunReadiness(); }));
  document.getElementById('guided-manage-plans-btn').addEventListener('click', openGuidedPlanManager);
  document.getElementById('guided-prepare-btn').addEventListener('click', prepareGuidedOperatorPath);
  document.getElementById('guided-run-btn').addEventListener('click', runPreparedGuidedTest);
  const regenerateAngularPlan = async () => {
    if (['characterization', 'interference'].includes(activeTestId())) return regenerateCharacterizationPlanFromOperator();
    if (['inside', 'outside'].includes(activeTestId())) return regenerateFormalPlanFromOperator();
    if (activeTestId() === 'system') return regenerateSystemValidationPlan();
    await radarAPI.configSet(config);
    return false;
  };

  document.getElementById('quick-recipe-select').addEventListener('change', async (event) => {
    await applyRecipeForSingleRun(event.target.value);
  });
  document.getElementById('quick-customize-recipe-btn').addEventListener('click', () => {
    openConfigModal('recipe');
    populateRecipeBuilder(activeRecipe(), true);
  });
  document.getElementById('quick-repeat-count').addEventListener('change', async (event) => {
    const repeats = Math.min(100, Math.max(1, Math.floor(Number(event.target.value) || 1)));
    event.target.value = repeats;
    config.test = { ...(config.test || {}), singleRunRepeats: repeats };
    await radarAPI.configSet(config);
    updateQuickRunPanel();
  });

  document.getElementById('quick-sequence-select').addEventListener('change', async (event) => {
    config.activeSequence = event.target.value;
    if (!['inside', 'outside', 'system'].includes(activeTestId())) config.test = { ...(config.test || {}), lastBuilderSequence: config.activeSequence };
    await radarAPI.configSet(config);
    updateSeqProgress();
    renderSpatialResults();
    logEvent(`Active test plan changed to "${config.activeSequence}"`, 'info');
  });

  document.getElementById('quick-test-mode').addEventListener('change', async (event) => {
    const previousMode = activeTestId();
    if (!['inside', 'outside', 'system'].includes(previousMode) && ['inside', 'outside', 'system'].includes(event.target.value)) rememberBuilderPlanBeforeFormalMode();
    config.test = { ...(config.test || {}), mode: event.target.value };
    if (['inside', 'outside'].includes(event.target.value)) {
      await regenerateFormalPlanFromOperator();
    } else if (event.target.value === 'system') {
      await regenerateSystemValidationPlan();
    } else if (['characterization', 'interference'].includes(event.target.value)) {
      restoreBuilderPlanForNonFormalMode();
      await regenerateCharacterizationPlanFromOperator();
    } else {
      restoreBuilderPlanForNonFormalMode();
      await radarAPI.configSet(config);
      updateSeqProgress();
      renderSpatialResults();
    }
  });

  const updateCycleCount = async (event) => {
    const cycles = Math.max(1, Math.floor(Number(event.target.value) || 1));
    config.test = { ...(config.test || {}), cyclesRequired: cycles };
    event.target.value = cycles;
    await radarAPI.configSet(config);
    updateSeqProgress();
    logEvent(`Run cycle count set to ${cycles}`, 'info');
  };
  document.getElementById('quick-cycle-count').addEventListener('change', updateCycleCount);
  document.getElementById('quick-general-cycle-count').addEventListener('change', updateCycleCount);

  document.getElementById('quick-pass-threshold').addEventListener('change', async (event) => {
    const percent = Math.min(100, Math.max(0, Number(event.target.value) || 0));
    config.test = { ...(config.test || {}), minimumCorrectRate: percent / 100 };
    event.target.value = Number(percent.toFixed(1));
    await radarAPI.configSet(config);
    updateQuickRunPanel();
    logEvent(`Pass threshold set to ${Number(percent.toFixed(1))}%`, 'info');
  });

  document.getElementById('quick-point-count').addEventListener('input', scheduleQuickPointPreview);
  document.getElementById('quick-point-count').addEventListener('change', async (event) => {
    const count = Math.max(1, Math.floor(Number(event.target.value) || 1));
    config.validation = { ...(config.validation || {}), pointCount: count };
    event.target.value = count;
    if (['characterization', 'interference'].includes(activeTestId())) {
      const plan = await regenerateCharacterizationPlanFromOperator();
      logEvent(`${plan.name} regenerated with ${count} points`, 'info');
    } else if (activeTestId() === 'system') {
      const generated = await regenerateSystemValidationPlan();
      if (generated) logEvent(`System Level plan regenerated with ${count} points`, 'info');
    } else {
      const generated = await regenerateFormalPlanFromOperator();
      if (generated) logEvent(`${activeTestId() === 'inside' ? 'Test 10.1' : 'Test 10.2'} plan regenerated with ${count} points`, 'info');
    }
  });

  document.getElementById('quick-angular-zone-enabled').addEventListener('change', async (event) => {
    config.validation = { ...(config.validation || {}), angularZoneEnabled: event.target.checked };
    await regenerateAngularPlan();
    updateQuickRunPanel();
    logEvent(`Angular zone filter ${event.target.checked ? 'enabled' : 'disabled'}`, 'info');
  });

  document.getElementById('quick-angular-zone').addEventListener('change', async (event) => {
    config.validation = { ...(config.validation || {}), angularZone: event.target.value };
    await regenerateAngularPlan();
    updateQuickRunPanel();
    logEvent(`Angular zone set to ${angularZoneSettings().label}`, 'info');
  });

  /** Saves characterization footprint controls and rebuilds its exact-count grid. */
  const updateCharacterizationBounds = async () => {
    const value = (id) => Number(document.getElementById(id).value);
    const next = {
      minX: value('quick-char-x-min'), maxX: value('quick-char-x-max'),
      minY: value('quick-char-y-min'), maxY: value('quick-char-y-max'),
    };
    if (!Object.values(next).every(Number.isFinite) || next.minX >= next.maxX || next.minY >= next.maxY) {
      updateQuickRunPanel('Characterization footprint requires finite min values smaller than max values', true);
      return;
    }
    config.validation = { ...(config.validation || {}), characterizationBounds: next };
    const plan = await regenerateCharacterizationPlanFromOperator();
    logEvent(`${plan.name} regenerated for X ${next.minX}–${next.maxX} mm and Y ${next.minY}–${next.maxY} mm`, 'info');
  };
  ['quick-char-x-min','quick-char-x-max','quick-char-y-min','quick-char-y-max'].forEach((id) => {
    document.getElementById(id).addEventListener('change', updateCharacterizationBounds);
  });

  document.getElementById('quick-dut-id').addEventListener('change', async (event) => {
    config.test = { ...(config.test || {}), dutId: event.target.value.trim() };
    await radarAPI.configSet(config);
  });

  document.getElementById('quick-load-csv-btn').addEventListener('click', () => {
    document.getElementById('quick-load-csv-file').click();
  });
  document.getElementById('quick-load-csv-file').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const parsed = extractPointsFromCsvText(await file.text());
    if (!parsed.points.length) {
      updateQuickRunPanel(`${file.name}: ${parsed.summary}`, true);
      logEvent(`Could not load test CSV "${file.name}": ${parsed.summary}`, 'error');
      event.target.value = '';
      return;
    }

    const baseName = file.name.replace(/\.csv$/i, '').trim() || 'Test Plan';
    const sequenceName = `CSV - ${baseName}`;
    config.sequences[sequenceName] = parsed.points;
    config.activeSequence = sequenceName;
    config.test = { ...(config.test || {}), definitionFile: file.name, lastBuilderSequence: sequenceName };
    await radarAPI.configSet(config);
    updateSeqProgress();
    renderSpatialResults();
    updateQuickRunPanel(`${file.name}: ${parsed.points.length} points loaded and ready`);
    logEvent(`Loaded test plan "${file.name}" with ${parsed.points.length} position(s)`, 'info');
    event.target.value = '';
  });

  document.getElementById('quick-open-builder-btn').addEventListener('click', () => openConfigModal('sequence'));
  if (['inside', 'outside'].includes(activeTestId())) await regenerateFormalPlanFromOperator();
  else if (activeTestId() === 'system') await regenerateSystemValidationPlan();
  else if (activeTestId() === 'characterization') await regenerateCharacterizationPlanFromOperator();
  else if (activeTestId() === 'interference') await regenerateCharacterizationPlanFromOperator();
  else {
    restoreBuilderPlanForNonFormalMode();
    await radarAPI.configSet(config);
    updateSeqProgress();
  }
}

/** Attaches UI event handlers for misc buttons. */
function wireMiscButtons() {
  document.getElementById('clear-log-btn').addEventListener('click', () => {
    document.getElementById('log-output').innerHTML = '';
  });

  document.getElementById('export-csv-btn').addEventListener('click', async () => {
    const current = await radarAPI.readCurrentLog();
    if (!current.success) { logEvent('No sequence log to export yet — run a sequence first', 'warn'); return; }
    const res = await radarAPI.saveCSV(current.data, current.fileName);
    if (res.success) logEvent(`Exported: ${res.filePath}`, 'info');
  });

  document.getElementById('open-report-btn').addEventListener('click', async () => {
    const res = await radarAPI.openReport();
    if (!res.success) logEvent(res.error || 'No report is available yet', 'warn');
  });

  document.getElementById('show-log-files-btn').addEventListener('click', () => radarAPI.revealLogInFolder());

  document.getElementById('viz-load-results-btn').addEventListener('click', () => document.getElementById('viz-results-files').click());
  document.getElementById('viz-results-files').addEventListener('change', async (ev) => {
    const files=[...(ev.target.files || [])];
    if (!files.length) return;
    const loaded=[];
    for (const file of files) loaded.push(...extractObservationsFromCsvText(await file.text(), file.name));
    currentObservations.push(...loaded);
    updateObservationFilterOptions();
    updateValidationDashboard();
    renderSpatialResults();
    logEvent(`Loaded ${loaded.length} raw observation(s) from ${files.length} result CSV file(s)`, loaded.length ? 'info' : 'warn');
    ev.target.value='';
  });
}

// ─── Init ─────────────────────────────────────────────────────────────────────
/** Attaches UI event handlers for spin speed control. */
function wireSpinSpeedControl() {
  const el = document.getElementById('spin-speed-input');
  if (!el) return;

  el.value = config.trigger.spinFeedMmMin || 14000;
  el.addEventListener('change', async () => {
    config.trigger.spinFeedMmMin = parseFloat(el.value) || 14000;
    await radarAPI.configSet(config);
    logEvent(`Reflector spin speed set to ${config.trigger.spinFeedMmMin} mm/min`, 'info');
  });
}

/** Implements the init operation for this module. */
async function init() {
  config = await radarAPI.configGet();
  config = RecipeCore.migrate(config);
  appStore.dispatch({ type: 'CONFIG_LOADED', config });
  const recoveredRun = await radarAPI.runStatus();
  authoritativeRunState = recoveredRun?.run || null;
  appStore.dispatch({ type: 'RUN_STATE_CHANGED', run: authoritativeRunState });
  if (authoritativeRunState?.status === 'recovery_required') {
    await radarAPI.resolveRunRecovery('Operator acknowledged interrupted run during application startup');
    logEvent('Recovered an interrupted run. Its _in_progress artifacts were preserved for review.', 'warn');
  }
  populateRecipeSelectors();
  populateGuidedOperatorPath();

  document.getElementById('conn-host').value = config.connection.host;
  document.getElementById('conn-port').value = config.connection.port;

  initChart();
  wireVisualization();
  setupEvents();
  wireConnection();
  wireMotionButtons();
  wireRadarSettings();
  wireConfigModal();
  await wireQuickRunPanel();
  wireMiscButtons();
  wireSpinSpeedControl();
  wireCampaignWorkflow();
  document.getElementById('cfg-sensor-layout').addEventListener('change', (event) => {
    const dualSensors = event.target.value === 'dual';
    const pairLayout = ['ld021_pair', 'rcwl_pair'].includes(event.target.value);
    if (!dualSensors) {
      document.getElementById('cfg-radar-center-x').value = 875;
      document.getElementById('cfg-radar-center-y').value = 1200;
    }
    if (dualSensors) {
      const outerDistance = document.getElementById('cfg-outside-radius-mm');
      outerDistance.value = Math.max(762, Number(outerDistance.value) || 0);
    }
    document.getElementById('cfg-single-sensor-fields').hidden = dualSensors || pairLayout;
    document.getElementById('cfg-ld021-pair-fields').hidden = !pairLayout;
    const target = updateRadarHardwareOptions(document.getElementById('cfg-radar-target'), event.target.value, config.validation?.radarTarget);
    document.getElementById('cfg-radar-target-row').hidden = pairLayout;
    document.getElementById('cfg-hilink-sensor-row').hidden = dualSensors || pairLayout || target !== 'ld021';
    if (pairLayout) {
      const pair = event.target.value === 'rcwl_pair' ? config.validation?.rcwlPair || {} : config.validation?.ld021Pair || {};
      document.getElementById('cfg-pair-a-label').textContent = `${event.target.value === 'rcwl_pair' ? 'RCWL_A' : 'LD021_A'} X / Y / heading (mm, mm, deg)`;
      document.getElementById('cfg-pair-b-label').textContent = `${event.target.value === 'rcwl_pair' ? 'RCWL_B' : 'LD021_B'} X / Y / heading (mm, mm, deg)`;
      document.getElementById('cfg-ld021-a-x').value = pair.sensorA?.x ?? 775;
      document.getElementById('cfg-ld021-a-y').value = pair.sensorA?.y ?? 900;
      document.getElementById('cfg-ld021-a-heading').value = pair.sensorA?.headingDeg ?? 0;
      document.getElementById('cfg-ld021-b-x').value = pair.sensorB?.x ?? 975;
      document.getElementById('cfg-ld021-b-y').value = pair.sensorB?.y ?? 900;
      document.getElementById('cfg-ld021-b-heading').value = pair.sensorB?.headingDeg ?? 0;
    }
    document.getElementById('cfg-system-geometry-note').hidden = !dualSensors;
    document.getElementById('cfg-sensor-center-confirmation').hidden = dualSensors;
    updateDutLocationControl(event.target.value);
    updateEngineeringSetupEditability();
    previewGenerator();
    renderSpatialResults();
    renderPlanPreviewCanvas(config.sequences?.[config.activeSequence] || [], '', 'quick-formal-preview');
  });
  document.getElementById('cfg-radar-target').addEventListener('change', (event) => {
    const singleLayout = document.getElementById('cfg-sensor-layout').value === 'single';
    document.getElementById('cfg-hilink-sensor-row').hidden = !singleLayout || event.target.value !== 'ld021';
  });
  document.getElementById('cfg-angular-zone-enabled').addEventListener('change', (event) => {
    document.getElementById('cfg-angular-zone').disabled = !event.target.checked;
    document.getElementById('cfg-angular-zone-row').style.display = event.target.checked ? 'flex' : 'none';
  });
  document.getElementById('cfg-dut-location').addEventListener('change', (event) => {
    const locations = Array.isArray(config.dut?.locations) ? config.dut.locations : DutLocationCore.BUILT_IN_LOCATIONS;
    const location = locations.find((candidate) => candidate.id === event.target.value) || locations[0];
    const geometry = DutLocationCore.geometry(location);
    const keepOut = DutLocationCore.noGoBounds(location, reflectorClearanceMm());
    document.getElementById('cfg-dut-location-summary').textContent = `DUT center (${geometry.center.x}, ${geometry.center.y}); physical footprint X ${geometry.bounds.minX}–${geometry.bounds.maxX}, Y ${geometry.bounds.minY}–${geometry.bounds.maxY}. Reflector keep-out X ${keepOut.minX}–${keepOut.maxX}, Y ${keepOut.minY}–${keepOut.maxY}; rear motion is disabled.`;
    previewGenerator();
    renderSpatialResults();
    renderPlanPreviewCanvas(config.sequences?.[config.activeSequence] || [], '', 'quick-formal-preview');
    renderPlanPreviewCanvas(config.sequences?.[config.activeSequence] || [], '', 'seq-plan-preview');
  });
  await refreshCampaignOperator();

  const ver = await radarAPI.getVersion();
  document.getElementById('app-version').textContent = `v${ver}`;

  setStartBtn('disabled');
  startRadarPolling();
  setResult('idle');
  updateSeqProgress();
  updateStatusGrid();
  resetValidationRun();
  logEvent('Radar Validation Fixture GUI ready — connect to the fixture to begin', 'info');

  window.addEventListener('resize', () => {
    if (activeVisualization === 'spatial') renderSpatialResults();
    if (['inside', 'outside', 'system'].includes(activeTestId())) renderPlanPreviewCanvas(config.sequences?.[config.activeSequence] || [], '', 'quick-formal-preview');
    if (document.getElementById('config-modal')?.classList.contains('show')) {
      schedulePlanPreviewRender(generatorPreview);
    }
  });
}

window.addEventListener('load', () => {
  init()
    .then(() => {
      window.__radarAppReady = true;
    })
    .catch((error) => {
      window.__radarAppReady = false;
      window.__radarAppStartupError = error?.stack || error?.message || String(error);
      console.error('Radar Validation Fixture failed to initialize:', error);
      const log = document.getElementById('log-output');
      if (log) {
        const row = document.createElement('div');
        row.className = 'log-entry error';
        row.textContent = `Startup error: ${error?.message || error}`;
        log.prepend(row);
      }
    });
});
window.addEventListener('unload', () => {
  stopRadarPolling();
  radarAPI.removeAllListeners();
});
