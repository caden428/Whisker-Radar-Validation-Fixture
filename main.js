const { app, BrowserWindow, ipcMain, dialog, clipboard, shell, nativeImage } = require('electron');
const fs   = require('fs');
const path = require('path');
const RadarSettingsCore = require('./radar-settings-core');
const CampaignLedger = require('./campaign-ledger');
const CampaignManager = require('./campaign-manager');
const RecipeCore = require('./recipe-core');
const TestPlanCore = require('./test-plan-core');
const TestPlanRepositoryCore = require('./test-plan-repository-core');
const RunNamingCore = require('./run-naming-core');
const DutLocationCore = require('./dut-location-core');
const MotionSafetyCore = require('./motion-safety-core');
const { RunController } = require('./run-controller');
const { CommandArbiter } = require('./command-arbiter');
const SmokeTestHarness = require('./smoke-test-harness');
const IpcContracts = require('./ipc-contracts');
const { StructuredLogger } = require('./structured-logger');
const SMOKE_TEST = process.argv.includes('--smoke-test');

/*
 * Module organization
 * -------------------
 *  1. Electron startup and communication architecture
 *  2. Configuration and local campaign persistence
 *  3. Window lifecycle
 *  4. Moonraker, radar-service, and motion IPC
 *  5. Run artifacts and report generation
 *  6. Local campaign application lifecycle
 *
 * Declarations intentionally remain in their existing execution order.
 */

if (SMOKE_TEST) {
  app.setPath('userData', path.join(app.getPath('temp'), `radar-validation-fixture-smoke-${process.pid}`));
}

/*
 * Communication architecture
 * ──────────────────────────
 * The fixture Pi runs Klipper + MainsailOS (per Documentation/Radar Validation
 * Fixture Configuration.docx §3-4), which means Moonraker's HTTP API is already
 * running on it (default port 7125). Rather than SSH-executing commands or
 * talking to the SKR board directly, this app drives the fixture the same way
 * Mainsail/Fluidd do: G-code over Moonraker's REST API. That means:
 *   - No native/serial dependencies (Electron's Node 18+ runtime has global
 *     fetch built in — nothing to npm-install or asarUnpack).
 *   - Homing, jogging, and the trigger macro are all just G-code strings.
 *   - "Wait for motion to finish" is done by appending M400 to a move script:
 *     Moonraker's /printer/gcode/script call blocks until Klipper replies
 *     "ok", and Klipper only replies to M400 once the motion queue is empty.
 *
 * Two things this app assumes but the source doc leaves open — flag these to
 * whoever owns firmware/printer.cfg before relying on them:
 *   1. A `REFLECTOR_SPIN` Klipper macro exists and does whatever the fixture
 *      needs physically for the reflector move. The macro name is configurable
 *      in the Configuration screen if it ends up being called something else.
 *
 *      The app now expects REFLECTOR_SPIN and passes a speed parameter to it.
 *
 *
 *   2. Z has no home switch (doc §6/§7), so "homing" Z just does
 *      SET_KINEMATIC_POSITION Z=0 at the current physical position — there is
 *      no verification that this actually corresponds to a real Z=0.
 *
 *      Without a homing sensor, there is no way to tell if the fixture is at a true z=0.
 *      This leaves us with the option of just calling whatever degree the fixture is at
 *      is "home" when homing the motor system.
 */

ipcMain.handle('app:version', () => app.getVersion());

let mainWindow;
let logWriteQueue = Promise.resolve();
let logWriteFailure = null;
let qualificationRunAuthorized = false;
const ACTIVE_RUN_PATH = path.join(app.getPath('userData'), 'active-run.json');

function atomicWriteFile(filePath, data) {
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const fd = fs.openSync(temporaryPath, 'w');
  try {
    fs.writeFileSync(fd, data, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporaryPath, filePath);
}

function atomicWriteJson(filePath, value) {
  atomicWriteFile(filePath, JSON.stringify(value, null, 2));
}

const runStateStore = {
  load() {
    try { return JSON.parse(fs.readFileSync(ACTIVE_RUN_PATH, 'utf8')); } catch { return null; }
  },
  save(state) { atomicWriteJson(ACTIVE_RUN_PATH, state); },
  clear() { try { fs.unlinkSync(ACTIVE_RUN_PATH); } catch (error) { if (error?.code !== 'ENOENT') throw error; } },
};
let diagnosticLogger = null;
const runController = new RunController(runStateStore, (state) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('run:state', state);
  diagnosticLogger?.info('run.state_changed', { status: state?.status || 'none', phase: state?.phase || 'none', reason: state?.reason || '' });
});
const motionArbiter = new CommandArbiter();
diagnosticLogger = new StructuredLogger(path.join(app.getPath('userData'), 'diagnostics.jsonl'), () => ({ runId: runController.snapshot()?.runId || null }));
let commandSequence = 0;

function contractResult(channel, payload) {
  const result = IpcContracts.validate(channel, payload);
  if (!result.success) diagnosticLogger.warn('ipc.rejected', { channel, code: result.code, error: result.error });
  return result;
}

// ─── Config persistence ───────────────────────────────────────────────────────
const CONFIG_PATH = path.join(app.getPath('userData'), 'radar-config.json');

const DEFAULT_CONFIG = {
  connection: { host: '192.168.2.17', port: 7125 },
  motion: {
    unitsVersion: MotionSafetyCore.MOTION_UNITS_VERSION,
    commissioned: false,
    x: { minMm: -9999, maxMm: 1725, speedMmS: 5000 / 60, accelMmS2: 500, homeOffsetMm: 0 },
    y: { minMm: -9999, maxMm: 1040, speedMmS: 5000 / 60, accelMmS2: 500, homeOffsetMm: 0 },
    z: { minMm: -9999, maxMm: 9999, speedMmS: 5000 / 60, accelMmS2: 500, homeOffsetMm: 0 },
  },
  trigger: {
    macro: 'REFLECTOR_SPIN',
    spinFeedMmMin: 14000,
    delayMs: 3500,
    holdMsDefault: 3500,
    positionTimeoutMs: 30000,
    timingCycleVersion: 3,
  },
  test: { mode: 'characterization', dutId: '', cycleNumber: 1, cyclesRequired: null, singleRunRepeats: 1, minimumCorrectRate: null, definitionFile: '', customMinimumCorrectRate: 0.95 },
  dut: {
    activeLocationId: DutLocationCore.DEFAULT_LOCATION.id,
    reflectorClearanceMm: 0,
    locations: DutLocationCore.BUILT_IN_LOCATIONS,
  },
  validation: {
    schemaVersion: 3,
    sensorLayout: 'dual',
    radarTarget: 'dual',
    hilinkSensor: 'A',
    geometrySemantics: 'dual-sensor-system-distance-bands',
    systemLevel: { requiredTriggerMm: 304.8, requiredNoTriggerMm: 609.6 },
    systemReference: { x: 875, y: 1040, confirmed: false },
    singleSensorConfirmed: false,
    singleSensor: { centerX: 875, centerY: 1200, radiusMm: 304.8 },
    guardBandMm: 10,
    pointCount: 100,
    coverageMode: 'angular',
    coverageSides: [],
    angularZoneEnabled: false,
    angularZone: 'front',
    outsideRadiusMm: 762,
    characterizationBounds: { minX: 0, maxX: 1725, minY: 150, maxY: 1040 },
    ld021Pair: {
      sensorA: { x: 775, y: 900, headingDeg: 0 },
      sensorB: { x: 975, y: 900, headingDeg: 0 },
      idleObservationMs: 10000, startupStabilizationMs: 10000,
      correlationWindowMs: 250, powerControlMode: 'manual', powerUpOrder: 'none',
    },
    rcwlPair: {
      sensorA: { x: 775, y: 900, headingDeg: 0 },
      sensorB: { x: 975, y: 900, headingDeg: 0 },
      idleObservationMs: 10000, startupStabilizationMs: 10000,
      correlationWindowMs: 250, powerControlMode: 'manual', powerUpOrder: 'none',
    },
  },

  radar: {
    pollMs: 100,
    timeoutMs: 5000,
    baselineTimeoutMs: 3000,
  },
  radarService: {
    port: 7130,
    timeoutMs: 2500,
    apiToken: '',
    requireVerifiedSettings: true,
  },
  sequences: {
    test1: [
      { x: 0, y: 0, z: 0, holdMs: 1000 },
    ],
  },
  activeSequence: 'test1',
  logging: { enabled: true },
  campaign: { active: null, archived: [] },
  recipes: { activeId: 'builtin-characterization', custom: [], history: [] },
  testPlans: { schemaVersion: 1, activePlanId: 'builtin-characterization', custom: [], history: [] },
  ssh: { host: '192.168.2.17', username: 'pi', port: 22 },
};

function localCampaignRecord(campaign) {
  if (!campaign || typeof campaign !== 'object') return null;
  const { spreadsheetId, spreadsheetUrl, ...local } = campaign;
  return local;
}

/** Loads config. */
function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const supportedConfig = { ...parsed };
    delete supportedConfig[['edge', 'Find'].join('')];
    const supportedModes = new Set(['characterization', 'interference', 'inside', 'outside', 'system', 'custom', 'sequence']);
    const parsedTest = { ...(parsed.test || {}) };
    if (!supportedModes.has(parsedTest.mode)) parsedTest.mode = DEFAULT_CONFIG.test.mode;
    // Shallow-merge so new default keys introduced in later versions of this
    // app show up even in an old saved config file.
    const migrated = RecipeCore.migrate({ ...DEFAULT_CONFIG, ...supportedConfig,
      connection: { ...DEFAULT_CONFIG.connection, ...parsed.connection },
      motion: MotionSafetyCore.migrate({ ...DEFAULT_CONFIG.motion, ...parsed.motion,
        unitsVersion: parsed.motion?.unitsVersion ?? 1,
        x: { ...DEFAULT_CONFIG.motion.x, ...parsed.motion?.x,
          speedMmS: parsed.motion?.x?.speedMmS ?? (parsed.motion?.unitsVersion === MotionSafetyCore.MOTION_UNITS_VERSION ? DEFAULT_CONFIG.motion.x.speedMmS : 5000) },
        y: { ...DEFAULT_CONFIG.motion.y, ...parsed.motion?.y,
          speedMmS: parsed.motion?.y?.speedMmS ?? (parsed.motion?.unitsVersion === MotionSafetyCore.MOTION_UNITS_VERSION ? DEFAULT_CONFIG.motion.y.speedMmS : 5000) },
        z: { ...DEFAULT_CONFIG.motion.z, ...parsed.motion?.z,
          speedMmS: parsed.motion?.z?.speedMmS ?? (parsed.motion?.unitsVersion === MotionSafetyCore.MOTION_UNITS_VERSION ? DEFAULT_CONFIG.motion.z.speedMmS : 5000) },
      }),
      trigger: { ...DEFAULT_CONFIG.trigger, ...parsed.trigger },
      test: { ...DEFAULT_CONFIG.test, ...parsedTest },
      dut: {
        ...DEFAULT_CONFIG.dut,
        ...(parsed.dut || {}),
        locations: DutLocationCore.BUILT_IN_LOCATIONS.map((builtIn) => (
          (parsed.dut?.locations || []).find((location) => location.id === builtIn.id) || builtIn
        )),
      },
      validation: {
        ...DEFAULT_CONFIG.validation,
        ...parsed.validation,
        coverageMode: RecipeCore.normalize({ coverageMode: parsed.validation?.coverageMode }).coverageMode,
        coverageSides: RecipeCore.normalize({ coverageMode: parsed.validation?.coverageMode }).coverageSides,
        singleSensorConfirmed: parsed.validation?.singleSensorConfirmed === true
          || (parsed.validation?.sensorLayout === 'single' && parsed.validation?.centerConfirmed === true),
        singleSensor: {
          ...DEFAULT_CONFIG.validation.singleSensor,
          ...(parsed.validation?.singleSensor || {}),
          ...(parsed.validation?.sensorLayout === 'single' ? {
            centerX: Number.isFinite(Number(parsed.validation?.centerX)) ? Number(parsed.validation.centerX) : 875,
            centerY: Number.isFinite(Number(parsed.validation?.centerY)) ? Number(parsed.validation.centerY) : 1200,
            radiusMm: Number.isFinite(Number(parsed.validation?.radiusMm)) ? Number(parsed.validation.radiusMm) : 304.8,
          } : {}),
          // Migrate the former calibrated stand position while preserving any
          // other explicitly configured sensor location.
          ...(Number(parsed.validation?.singleSensor?.centerX) === 875
            && Number(parsed.validation?.singleSensor?.centerY) === 1100
            ? { centerY: 1200 }
            : {}),
        },
        systemReference: {
          ...DEFAULT_CONFIG.validation.systemReference,
          ...(parsed.validation?.systemReference || {}),
        },
        characterizationBounds: {
          ...DEFAULT_CONFIG.validation.characterizationBounds,
          ...(parsed.validation?.characterizationBounds || {}),
        },
        ld021Pair: {
          ...DEFAULT_CONFIG.validation.ld021Pair,
          ...(parsed.validation?.ld021Pair || {}),
          sensorA: { ...DEFAULT_CONFIG.validation.ld021Pair.sensorA, ...(parsed.validation?.ld021Pair?.sensorA || {}) },
          sensorB: { ...DEFAULT_CONFIG.validation.ld021Pair.sensorB, ...(parsed.validation?.ld021Pair?.sensorB || {}) },
        },
        rcwlPair: {
          ...DEFAULT_CONFIG.validation.rcwlPair,
          ...(parsed.validation?.rcwlPair || {}),
          sensorA: { ...DEFAULT_CONFIG.validation.rcwlPair.sensorA, ...(parsed.validation?.rcwlPair?.sensorA || {}) },
          sensorB: { ...DEFAULT_CONFIG.validation.rcwlPair.sensorB, ...(parsed.validation?.rcwlPair?.sensorB || {}) },
        },
      },
      radar: { ...DEFAULT_CONFIG.radar, ...parsed.radar },
      radarService: { ...DEFAULT_CONFIG.radarService, ...parsed.radarService },

      logging: { ...DEFAULT_CONFIG.logging, ...parsed.logging },
      campaign: {
        active: localCampaignRecord(parsed.campaign?.active),
        archived: Array.isArray(parsed.campaign?.archived) ? parsed.campaign.archived.map(localCampaignRecord).filter(Boolean) : [],
      },
      ssh: { ...DEFAULT_CONFIG.ssh, ...parsed.ssh },
      sequences: { ...DEFAULT_CONFIG.sequences, ...parsed.sequences },
    });
    migrated.testPlans = parsed.testPlans?.schemaVersion
      ? { ...DEFAULT_CONFIG.testPlans, ...parsed.testPlans }
      : TestPlanCore.migrateLegacyCatalog(migrated.recipes);
    return migrated;
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

let config = loadConfig();
let configRevision = 1;
let configMigrated = false;
if (config.validation?.sensorB || Object.hasOwn(config.validation || {}, 'centerX')
    || Object.hasOwn(config.validation || {}, 'centerY') || Object.hasOwn(config.validation || {}, 'radiusMm')) {
  delete config.validation.sensorB;
  delete config.validation.centerX;
  delete config.validation.centerY;
  delete config.validation.radiusMm;
  configMigrated = true;
}
if (Object.hasOwn(config.validation || {}, 'centerConfirmed')) {
  delete config.validation.centerConfirmed;
  configMigrated = true;
}
if (Number(config.validation?.characterizationBounds?.minY) === 0) {
  config.validation.characterizationBounds.minY = 150;
  configMigrated = true;
}
if (Number(config.trigger?.timingCycleVersion) !== 3) {
  const priorDelayMs = Number(config.trigger?.delayMs);
  const priorHoldMs = Number(config.trigger?.holdMsDefault);
  config.trigger = {
    ...(config.trigger || {}),
    delayMs: (Number.isFinite(priorDelayMs) ? priorDelayMs : 3000) + 500,
    holdMsDefault: (Number.isFinite(priorHoldMs) ? priorHoldMs : 3000) + 500,
    timingCycleVersion: 3,
  };
  config.radar = {
    ...(config.radar || {}),
    baselineTimeoutMs: config.trigger.delayMs,
  };
  config.sequences = Object.fromEntries(Object.entries(config.sequences || {}).map(([name, points]) => [
    name,
    Array.isArray(points) ? points.map((point) => ({
      ...point,
      holdMs: (Number.isFinite(Number(point.holdMs)) ? Number(point.holdMs) : priorHoldMs || 3000) + 500,
    })) : points,
  ]));
  configMigrated = true;
}
if (configMigrated) fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');

/** Saves config. */
function saveConfig(newConfig) {
  const normalizedMotion = MotionSafetyCore.migrate(newConfig.motion);
  const motionIssues = MotionSafetyCore.AXES.flatMap((axis) => MotionSafetyCore.axisIssues(axis, normalizedMotion[axis]));
  if (motionIssues.length) throw new Error(`Invalid motion configuration: ${motionIssues.join('; ')}`);
  if (normalizedMotion.commissioned) {
    const commissioningIssues = MotionSafetyCore.commissioningIssues(normalizedMotion);
    if (commissioningIssues.length) throw new Error(`Fixture cannot be marked commissioned: ${commissioningIssues.join('; ')}`);
  }
  config = {
    ...newConfig,
    motion: normalizedMotion,
    campaign: {
      active: localCampaignRecord(newConfig.campaign?.active),
      archived: Array.isArray(newConfig.campaign?.archived) ? newConfig.campaign.archived.map(localCampaignRecord).filter(Boolean) : [],
    },
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

async function saveConfigAsync(newConfig) {
  const normalizedMotion = MotionSafetyCore.migrate(newConfig.motion);
  const motionIssues = MotionSafetyCore.AXES.flatMap((axis) => MotionSafetyCore.axisIssues(axis, normalizedMotion[axis]));
  if (motionIssues.length) throw new Error(`Invalid motion configuration: ${motionIssues.join('; ')}`);
  config = { ...newConfig, motion: normalizedMotion, campaign: config.campaign };
  await fs.promises.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

function logsDirectory() {
  return path.join(app.getPath('documents'), 'Radar Validation Logs');
}

// ─── Campaign persistence and background completion ─────────────────────────

const TRANSIENT_RENAME_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY']);

/**
 * Windows indexers, antivirus, and report previews can briefly retain a handle
 * inside a completed run directory. Retry only those transient lock errors;
 * structural errors such as an existing destination still fail immediately.
 */
async function renameWithRetry(source, destination, options = {}) {
  const attempts = Math.max(1, Number(options.attempts) || 12);
  const delayMs = Math.max(25, Number(options.delayMs) || 250);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await fs.promises.rename(source, destination);
      return;
    } catch (error) {
      if (!TRANSIENT_RENAME_ERRORS.has(error?.code) || attempt === attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
}

let campaignBackgroundState = {
  phase: 'idle',
  campaignId: '',
  message: '',
  error: '',
  updatedAt: '',
};

function rendererConfig() { return { ...config, _revision: configRevision }; }

ipcMain.handle('config:get', () => rendererConfig());
ipcMain.handle('config:patch', (_, request = {}) => {
  const contract = contractResult('config:patch', request);
  if (!contract.success) return contract;
  request = contract.value;
  const expectedRevision = Number(request.expectedRevision);
  if (expectedRevision !== configRevision) {
    return { success: false, conflict: true, error: 'Configuration changed in another workflow; reload before saving', config: rendererConfig() };
  }
  const allowedRoots = new Set(['connection', 'motion', 'trigger', 'test', 'dut', 'validation', 'radar', 'radarService', 'sequences', 'activeSequence', 'logging', 'recipes', 'testPlans', 'ssh']);
  const patch = request.patch && typeof request.patch === 'object' ? request.patch : {};
  const unsupported = Object.keys(patch).filter((key) => !allowedRoots.has(key));
  if (unsupported.length) return { success: false, error: `Unsupported configuration patch: ${unsupported.join(', ')}`, config: rendererConfig() };
  try {
    saveConfig({ ...config, ...patch, campaign: config.campaign });
    configRevision += 1;
    return { success: true, config: rendererConfig() };
  } catch (error) {
    return { success: false, error: error?.message || String(error), config: rendererConfig() };
  }
});
ipcMain.handle('config:set', (_, newConfig) => {
  // Campaign lifecycle state is owned by the main process. Renderer-side
  // configuration copies can become stale while campaign IPC calls update the
  // active plan (notably the Auto Run flag). Never let a later settings save
  // roll that state back.
  try {
    saveConfig({ ...newConfig, campaign: config.campaign });
    configRevision += 1;
    return { success: true, config: rendererConfig() };
  } catch (error) {
    return { success: false, error: error?.message || String(error) };
  }
});

ipcMain.handle('test-plan:list', () => ({ success: true, catalog: config.testPlans }));
ipcMain.handle('test-plan:save', async (_, payload = {}) => {
  const contract = contractResult('test-plan:save', payload);
  if (!contract.success) return contract;
  const validation = TestPlanCore.validatePlan(contract.value.plan);
  if (!validation.success) return { success: false, error: validation.errors.join('; ') };
  try {
    const { catalog, plan } = TestPlanRepositoryCore.save(config.testPlans, validation.value);
    await saveConfigAsync({ ...config, testPlans: catalog });
    configRevision += 1;
    return { success: true, plan, catalog, config: rendererConfig() };
  } catch (error) { return { success: false, error: error?.message || String(error) }; }
});
ipcMain.handle('test-plan:delete', async (_, payload = {}) => {
  const contract = contractResult('test-plan:delete', payload);
  if (!contract.success) return contract;
  try {
    const catalog = TestPlanRepositoryCore.remove(config.testPlans, contract.value.planId);
    await saveConfigAsync({ ...config, testPlans: catalog });
    configRevision += 1;
    return { success: true, catalog, config: rendererConfig() };
  } catch (error) { return { success: false, error: error?.message || String(error) }; }
});

ipcMain.handle('motion:beginQualificationRun', (_, metadata = {}) => {
  const issues = MotionSafetyCore.commissioningIssues(config.motion);
  if (config.motion?.commissioned !== true || issues.length) {
    qualificationRunAuthorized = false;
    return motionFailure(`Qualification run blocked: ${issues[0] || 'fixture motion settings are not commissioned'}`);
  }
  if (!config.logging?.enabled) {
    qualificationRunAuthorized = false;
    return motionFailure('Qualification run blocked: raw observation logging is disabled');
  }
  try {
    runController.begin(metadata);
  } catch (error) {
    qualificationRunAuthorized = false;
    return motionFailure(error?.message || String(error));
  }
  qualificationRunAuthorized = true;
  return { success: true, run: runController.snapshot() };
});

ipcMain.handle('motion:endQualificationRun', () => {
  qualificationRunAuthorized = false;
  return { success: true };
});
ipcMain.handle('run:status', () => ({ success: true, run: runController.snapshot() }));
ipcMain.handle('run:transition', (_, phase, progress = {}) => {
  const contract = contractResult('run:transition', { phase, progress });
  if (!contract.success) return { ...contract, run: runController.snapshot() };
  try { return { success: true, run: runController.transition(contract.value.phase, contract.value.progress) }; }
  catch (error) { return { success: false, error: error?.message || String(error), run: runController.snapshot() }; }
});
ipcMain.handle('run:abort', (_, reason) => ({ success: true, run: runController.requestAbort(reason) }));
ipcMain.handle('run:resolveRecovery', (_, reason) => ({ success: true, run: runController.resolveRecovery(reason) }));

// ─── Window ───────────────────────────────────────────────────────────────────

/** Creates window. */
function createWindow() {
  mainWindow = new BrowserWindow({
    width:  1600,
    height: 960,
    minWidth:  1280,
    minHeight: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Validation timing must continue at full rate while the operator uses
      // another application or this window is covered/minimized. Chromium's
      // default background throttling can otherwise delay renderer timers and
      // turn valid radar observations into timeouts/INVALID points.
      backgroundThrottling: false,
    },
    title: 'Radar Validation Fixture',
    backgroundColor: '#080c14',
    show: !SMOKE_TEST,
  });
  if (SMOKE_TEST) SmokeTestHarness.attach(mainWindow, app);
  // Legacy inline audit retained temporarily as unreachable reference while
  // downstream UI assertions migrate to smoke-test-harness.js.
  if (false && SMOKE_TEST) {
    mainWindow.webContents.on('did-finish-load', async () => {
      try {
        await mainWindow.webContents.executeJavaScript(`
          new Promise((resolve) => {
            const waitForRenderer = () => {
              if (window.__radarAppStartupError || window.__radarAppReady) return resolve();
              setTimeout(waitForRenderer, 25);
            };
            waitForRenderer();
          })
        `, true);
        await mainWindow.webContents.executeJavaScript(`
          config.test = { ...(config.test || {}), mode: 'characterization' };
          openConfigModal('sequence');
          const sensorLayout = document.getElementById('cfg-sensor-layout');
          sensorLayout.value = 'single';
          sensorLayout.dispatchEvent(new Event('change', { bubbles: true }));
          const eventCounts = {};
          ['cfg-radar-center-x', 'cfg-radar-center-y', 'cfg-definition-file', 'cfg-validation-point-count'].forEach((id) => {
            const field = document.getElementById(id);
            eventCounts[id] = { keydown: 0, beforeinput: 0, input: 0 };
            ['keydown', 'beforeinput', 'input'].forEach((type) => field.addEventListener(type, () => { eventCounts[id][type] += 1; }));
          });
          window.__smokeEngineeringInput = { eventCounts };
        `, true);
        const typeIntoEngineeringField = async (id, value) => {
          mainWindow.focus();
          mainWindow.webContents.focus();
          await mainWindow.webContents.executeJavaScript(`
            (() => { const field = document.getElementById(${JSON.stringify(id)}); field.scrollIntoView({ block: 'center' }); field.focus(); field.select(); })()
          `, true);
          await new Promise((resolve) => setTimeout(resolve, 40));
          mainWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['control'] });
          mainWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['control'] });
          for (const character of value) {
            mainWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: character.toUpperCase() });
            mainWindow.webContents.sendInputEvent({ type: 'char', keyCode: character });
            mainWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: character.toUpperCase() });
          }
          await new Promise((resolve) => setTimeout(resolve, 40));
          return mainWindow.webContents.executeJavaScript(`
            (() => { const field = document.getElementById(${JSON.stringify(id)}); const rect = field.getBoundingClientRect(); const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2); const events = window.__smokeEngineeringInput.eventCounts[${JSON.stringify(id)}]; return { value: field.value, active: document.activeElement === field, hitId: hit?.id || '', pointerEvents: getComputedStyle(field).pointerEvents, events }; })()
          `, true);
        };
        const nativeTyping = {
          centerX: await typeIntoEngineeringField('cfg-radar-center-x', '901'),
          centerY: await typeIntoEngineeringField('cfg-radar-center-y', '1099'),
          definition: await typeIntoEngineeringField('cfg-definition-file', 'keyboard-reference'),
          pointCount: await typeIntoEngineeringField('cfg-validation-point-count', '77'),
        };
        await mainWindow.webContents.executeJavaScript(`
          (() => {
            const fieldState = (id) => {
              const field = document.getElementById(id);
              const rect = field.getBoundingClientRect();
              const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
              const events = window.__smokeEngineeringInput.eventCounts[id];
              return { value: field.value, disabled: field.disabled, readOnly: field.readOnly,
                active: document.activeElement === field, hitId: hit?.id || '', pointerEvents: getComputedStyle(field).pointerEvents,
                events, nativeInputObserved: events.keydown > 0 && events.beforeinput > 0 && events.input > 0 };
            };
            const centerY = document.getElementById('cfg-radar-center-y');
            const baseline = document.getElementById('cfg-radar-baseline-timeout');
            testRunning = true;
            updateEngineeringSetupEditability();
            const applyBlockedDuringRun = document.getElementById('config-apply-btn').disabled
              && !document.getElementById('config-active-run-note').hidden;
            testRunning = false;
            updateEngineeringSetupEditability();
            const fields = Object.fromEntries(['cfg-radar-center-x', 'cfg-radar-center-y', 'cfg-definition-file', 'cfg-validation-point-count'].map((id) => [id, fieldState(id)]));
            window.__smokeEngineeringInput = {
              fields, nativeTyping: ${JSON.stringify(nativeTyping)}, applyBlockedDuringRun,
              centerY: { readOnly: centerY.readOnly, disabled: centerY.disabled },
              baseline: { disabled: baseline.disabled, readOnly: baseline.readOnly },
              success: fields['cfg-radar-center-x'].value === '901'
                && fields['cfg-radar-center-y'].value === '1099'
                && fields['cfg-definition-file'].value === 'keyboard-reference'
                && fields['cfg-validation-point-count'].value === '77'
                && Object.values(fields).every((field) => field.hitId !== '' && field.pointerEvents !== 'none' && field.nativeInputObserved)
                && Object.values(${JSON.stringify(nativeTyping)}).every((field) => field.active && field.hitId !== '' && field.pointerEvents !== 'none' && field.events.keydown > 0 && field.events.beforeinput > 0 && field.events.input > 0)
                && applyBlockedDuringRun && !centerY.readOnly && baseline.disabled,
            };
          })()
        `, true);
        const result = await mainWindow.webContents.executeJavaScript(`
          new Promise((resolve) => {
            const deadline = Date.now() + 10000;
            const inspect = () => {
              if (window.__radarAppStartupError) {
                resolve({ ready: false, startupError: window.__radarAppStartupError });
                return;
              }
              if (!window.__radarAppReady) {
                if (Date.now() >= deadline) resolve({ ready: false, startupError: 'Renderer startup timed out' });
                else setTimeout(inspect, 50);
                return;
              }
              setTimeout(async () => {
                const ids = [
                  'quick-test-mode', 'quick-point-count', 'quick-cycle-count',
                  'quick-char-x-min', 'quick-char-x-max', 'quick-char-y-min', 'quick-char-y-max'
                ];
                const defaults = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)?.value ?? null]));
                const expectedDefaults = {
                  'quick-test-mode': 'characterization',
                  'quick-point-count': '100',
                  'quick-cycle-count': '1',
                  'quick-char-x-min': '0',
                  'quick-char-x-max': '1725',
                  'quick-char-y-min': '150',
                  'quick-char-y-max': '1040'
                };
                const defaultsLoaded = Object.entries(expectedDefaults)
                  .every(([id, value]) => defaults[id] === value);
                const auditEditableFields = (root, area) => {
                  const failures = [];
                  const fields = [...root.querySelectorAll('input[id], textarea[id]')].filter((field) => {
                    const type = String(field.type || '').toLowerCase();
                    return !field.disabled && !field.readOnly
                      && !['button','checkbox','radio','file','hidden','submit'].includes(type);
                  });
                  const focusedKinds = new Set();
                  fields.forEach((field, fieldIndex) => {
                    const original = field.value;
                    const type = String(field.type || 'text').toLowerCase();
                    try {
                      const focusKind = field.tagName + ':' + type;
                      const focusable = field.offsetParent !== null && !focusedKinds.has(focusKind);
                      if (focusable) focusedKinds.add(focusKind);
                      // Native number controls share Chromium's editing path.
                      // Exercise their value/focus lifecycle individually, but
                      // avoid firing every expensive plan-regeneration handler.
                      const dispatchEvents = false;
                      if (focusable) field.focus();
                      const numericMin = Number.isFinite(Number(field.min)) && field.min !== '' ? Number(field.min) : 0;
                      const numericMax = Number.isFinite(Number(field.max)) && field.max !== '' ? Number(field.max) : Infinity;
                      const numericStep = Number.isFinite(Number(field.step)) && Number(field.step) > 0 ? Number(field.step) : 1;
                      const numericValue = (offset) => String(Math.min(numericMax, numericMin + numericStep * offset));
                      const first = type === 'number' ? numericValue(1) : type === 'url'
                        ? 'https://example.test/edit-one' : 'old value';
                      field.value = first;
                      if (dispatchEvents) field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: first }));
                      if (field.value !== first || (focusable && document.activeElement !== field)) {
                        throw new Error('initial edit failed');
                      }

                      if (type !== 'number') {
                        field.setSelectionRange(0, 3);
                        field.setRangeText('new', 0, 3, 'end');
                        if (dispatchEvents) field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: 'new' }));
                        if (!field.value.startsWith('new')) throw new Error('selection replacement failed');
                      }

                      if (focusable) {
                        field.blur();
                        field.focus();
                      }
                      const second = type === 'number' ? numericValue(2) : type === 'url'
                        ? 'https://example.test/edit-two' : field.value + ' continued';
                      field.value = second;
                      if (dispatchEvents) {
                        field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: second }));
                        field.dispatchEvent(new Event('change', { bubbles: true }));
                      }
                      if (field.value !== second || (focusable && document.activeElement !== field)) {
                        throw new Error('edit after refocus failed');
                      }
                    } catch (error) {
                      failures.push({
                        id: field.id || field.dataset.conditionId || (field.className || field.tagName) + '-' + fieldIndex,
                        error: String(error.message || error),
                      });
                    } finally {
                      field.value = original;
                    }
                  });
                  return { area, tested: fields.length, failures };
                };
                const mainFieldAudit = auditEditableFields(document.querySelector('main'), 'main');
                const guidedDevice = document.getElementById('guided-device');
                const guidedGoal = document.getElementById('guided-goal');
                guidedDevice.value = 'single';
                guidedDevice.dispatchEvent(new Event('input', { bubbles: true }));
                const guidedSingleHidesSystem = !document.getElementById('guided-goal-step').hidden
                  && guidedGoal.querySelector('option[value="system"]').disabled
                  && guidedGoal.querySelector('option[value="campaign"]').disabled;
                guidedGoal.value = 'characterization';
                guidedGoal.dispatchEvent(new Event('input', { bubbles: true }));
                document.getElementById('guided-char-points').value = '20';
                document.getElementById('guided-char-cycles').value = '1';
                await prepareGuidedOperatorPath();
                const guidedSingleCharacterizationWorks = config.test.mode === 'characterization'
                  && config.validation.sensorLayout === 'single'
                  && config.sequences[config.activeSequence]?.length === 20
                  && ValidationCore.TEST_DEFINITIONS[config.test.mode].acceptance === null;
                guidedDevice.value = 'dual';
                guidedDevice.dispatchEvent(new Event('input', { bubbles: true }));
                guidedGoal.value = 'system';
                guidedGoal.dispatchEvent(new Event('input', { bubbles: true }));
                document.getElementById('guided-system-zone').value = 'front';
                document.getElementById('guided-system-points').value = '15';
                await prepareGuidedOperatorPath();
                const guidedSystemPoints = config.sequences[config.activeSequence] || [];
                const guidedSystemValidationWorks = config.test.mode === 'system'
                  && config.validation.sensorLayout === 'dual'
                  && guidedSystemPoints.length === 15
                  && new Set(guidedSystemPoints.map((point) => point.zone)).size === 3
                  && ValidationCore.validatePlan('system', guidedSystemPoints, validationGeometry()).length === 0;
                const guidedSystemDiagnostics = {
                  mode: config.test.mode,
                  layout: config.validation.sensorLayout,
                  pointCount: guidedSystemPoints.length,
                  zones: [...new Set(guidedSystemPoints.map((point) => point.zone))],
                  issues: ValidationCore.validatePlan('system', guidedSystemPoints, validationGeometry()),
                  status: document.getElementById('guided-status')?.textContent || '',
                };
                const guidedPointsInput = document.getElementById('guided-system-points');
                guidedPointsInput.focus();
                guidedPointsInput.value = '18';
                const guidedInputsRemainEditable = document.activeElement === guidedPointsInput
                  && guidedPointsInput.value === '18' && !guidedPointsInput.disabled && !guidedPointsInput.readOnly;
                const savedRadarState = { online: radarOnline, high: radarHigh };
                radarOnline = true;
                radarHigh = true;
                updateRadarUI();
                const radarHighLabel = document.getElementById('lbl-radar')?.textContent || '';
                radarHigh = false;
                updateRadarUI();
                const radarLowLabel = document.getElementById('lbl-radar')?.textContent || '';
                radarOnline = savedRadarState.online;
                radarHigh = savedRadarState.high;
                updateRadarUI();
                const savedRadarSettingsUi = {
                  validation: config.validation, mode: config.test?.mode, connected,
                  serviceOnline: radarSettingsServiceOnline, state: radarSettingsState,
                  dirty: radarSettingsDirty, busy: radarSettingsBusy, running: testRunning,
                };
                closeConfigModal();
                const radarSettingsMatrix = [];
                const hardwareCases = [
                  { name: 'moresense-dual', validation: { sensorLayout: 'dual', radarTarget: 'dual' }, target: 'dual', experimental: false },
                  { name: 'ms58-single', validation: { sensorLayout: 'single', radarTarget: 'single' }, target: 'single', experimental: false },
                  { name: 'rcwl-dual', validation: { sensorLayout: 'dual', radarTarget: 'rcwl_dual' }, target: 'rcwl_dual', experimental: false, fixed: true },
                  { name: 'rcwl-single', validation: { sensorLayout: 'single', radarTarget: 'rcwl_single' }, target: 'rcwl_single', experimental: false, fixed: true },
                  { name: 'rcwl-pair', validation: { sensorLayout: 'rcwl_pair', radarTarget: 'rcwl_pair' }, target: 'rcwl_pair', experimental: false, fixed: true },
                  { name: 'ld021-a', validation: { sensorLayout: 'single', radarTarget: 'ld021', hilinkSensor: 'A' }, target: 'ld021_a', experimental: true },
                  { name: 'ld021-b', validation: { sensorLayout: 'single', radarTarget: 'ld021', hilinkSensor: 'B' }, target: 'ld021_b', experimental: true },
                  { name: 'ld021-pair', validation: { sensorLayout: 'ld021_pair', radarTarget: 'ld021_pair' }, target: 'ld021_pair', experimental: true },
                ];
                const ldSensor = (threshold = 512) => ({ online: true, verified: true, threshold, outputTimeMs: 5000, moduleId: 1 });
                connected = true;
                radarSettingsServiceOnline = true;
                radarSettingsBusy = false;
                testRunning = false;
                for (const mode of ['inside', 'outside', 'characterization', 'interference', 'custom', 'sequence']) {
                  for (const hardware of hardwareCases) {
                    config.test.mode = mode;
                    config.validation = { ...config.validation, ...hardware.validation };
                    const sensors = hardware.target === 'dual'
                      ? { A: { online: true, verified: true, gainCode: 67, threshold: 125 }, B: { online: true, verified: true, gainCode: 67, threshold: 125 } }
                      : hardware.target === 'single'
                        ? { SINGLE: { online: true, verified: true, gainCode: 83, threshold: 150 } }
                        : ['rcwl_dual', 'rcwl_pair'].includes(hardware.target)
                          ? { RCWL_A: { online: true, verified: true }, RCWL_B: { online: true, verified: true } }
                          : hardware.target === 'rcwl_single'
                            ? { RCWL_SINGLE: { online: true, verified: true } }
                        : hardware.target === 'ld021_pair'
                          ? { LD021_A: ldSensor(), LD021_B: ldSensor() }
                          : hardware.target === 'ld021_b' ? { LD021_B: ldSensor() } : { LD021_A: ldSensor() };
                    radarSettingsState = { success: true, persistent: hardware.experimental,
                      protocolProfile: hardware.fixed ? RadarSettingsCore.FIXED_OUTPUT_PROFILE : hardware.experimental ? RadarSettingsCore.LD021_PROTOCOL_PROFILE : 'moresense-hci-v2',
                      activeTarget: hardware.target, sensors };
                    radarSettingsDirty = false;
                    renderRadarSettings();
                    const section = document.getElementById('radar-ld021-experimental');
                    const input = document.getElementById('radar-output-time-input');
                    const applyButton = document.getElementById('radar-settings-apply');
                    const saveButton = document.getElementById('radar-settings-save');
                    const gainRow = document.getElementById('radar-gain-row');
                    const thresholdRow = document.getElementById('radar-threshold-row');
                    let inputHit = null;
                    let buttonHit = null;
                    if (hardware.experimental) {
                      input.scrollIntoView({ block: 'center' });
                      input.focus();
                      input.value = '2500';
                      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '2500' }));
                      const inputRect = input.getBoundingClientRect();
                      inputHit = document.elementFromPoint(inputRect.left + inputRect.width / 2, inputRect.top + inputRect.height / 2);
                      applyButton.scrollIntoView({ block: 'center' });
                      const buttonRect = applyButton.getBoundingClientRect();
                      buttonHit = document.elementFromPoint(buttonRect.left + buttonRect.width / 2, buttonRect.top + buttonRect.height / 2);
                    }
                    radarSettingsMatrix.push({ mode, hardware: hardware.name,
                      diagnostics: hardware.experimental ? { inputHitId: inputHit?.id || '', buttonHitId: buttonHit?.id || '', dirty: radarSettingsDirty, applyDisabled: applyButton.disabled, inputDisabled: input.disabled, sectionHidden: section.hidden } : undefined,
                      pass: section.hidden === !hardware.experimental
                        && input.disabled === !hardware.experimental
                        && (!hardware.fixed || (gainRow.hidden && thresholdRow.hidden && applyButton.disabled && saveButton.disabled
                          && RadarSettingsCore.verifiedPair(radarSettingsState)))
                        && (!hardware.experimental || (document.activeElement === input && input.value === '2500'
                          && radarSettingsDirty && !applyButton.disabled && inputHit === input && buttonHit === applyButton)) });
                  }
                }
                config.validation = savedRadarSettingsUi.validation;
                config.test.mode = savedRadarSettingsUi.mode;
                connected = savedRadarSettingsUi.connected;
                radarSettingsServiceOnline = savedRadarSettingsUi.serviceOnline;
                radarSettingsState = savedRadarSettingsUi.state;
                radarSettingsDirty = savedRadarSettingsUi.dirty;
                radarSettingsBusy = savedRadarSettingsUi.busy;
                testRunning = savedRadarSettingsUi.running;
                renderRadarSettings();
                const radarSettingsMatrixWorks = radarSettingsMatrix.every((entry) => entry.pass);
                document.getElementById('campaign-primary-btn')?.click();
                const campaignSummary = document.getElementById('campaign-workload-summary')?.textContent || '';
                const campaignNameInput = document.getElementById('campaign-name-input');
                const campaignDutInput = document.getElementById('campaign-dut-input');
                const campaignAutoRunInput = document.getElementById('campaign-auto-run-input');
                const campaignLayout = document.getElementById('campaign-sensor-layout');
                const campaignSingleSensorFields = document.getElementById('campaign-single-sensor-fields');
                if (campaignLayout) {
                  campaignLayout.value = 'single';
                  campaignLayout.dispatchEvent(new Event('input', { bubbles: true }));
                }
                const singleCampaignShowsSensorGeometry = campaignSingleSensorFields?.hidden === false && campaignSingleSensorFields?.offsetParent !== null;
                if (campaignLayout) {
                  campaignLayout.value = 'dual';
                  campaignLayout.dispatchEvent(new Event('input', { bubbles: true }));
                }
                const dualCampaignHidesSensorGeometry = campaignSingleSensorFields?.hidden === true && campaignSingleSensorFields?.offsetParent === null;
                const inputRect = campaignNameInput?.getBoundingClientRect();
                const inputHit = inputRect ? document.elementFromPoint(inputRect.left + inputRect.width / 2, inputRect.top + inputRect.height / 2) : null;
                const setSmokeInput = (input, value) => {
                  input.value = value;
                  input.dispatchEvent(new Event('input', { bubbles: true }));
                  input.dispatchEvent(new Event('change', { bubbles: true }));
                };
                campaignNameInput?.focus();
                if (campaignNameInput) {
                  setSmokeInput(campaignNameInput, 'Keyboard entry test');
                }
                campaignDutInput?.focus();
                if (campaignDutInput) {
                  setSmokeInput(campaignDutInput, 'DUT 123');
                }
                showCampaignModal('dashboard');
                showCampaignModal('create');
                campaignNameInput.value = 'Old campaign';
                setSmokeInput(campaignNameInput, 'New campaign');
                const campaignKeyboardTypingWorks =
                  !campaignNameInput?.disabled
                  && !campaignNameInput?.readOnly
                  && !campaignDutInput?.disabled
                  && !campaignDutInput?.readOnly;
                if (campaignAutoRunInput) campaignAutoRunInput.checked = true;
                const autoRunPlanCaptured = campaignPlanFromForm().autoRun === true;
                const editFixturePlan = campaignPlanFromForm();
                campaignOperatorStatus = {
                  active: true,
                  campaign: { name: 'Editable campaign', dutId: 'Editable DUT', plan: editFixturePlan },
                  method: editFixturePlan,
                  conditions: [], completed: 0, total: 0, passed: 0, failed: 0, next: null,
                };
                showCampaignModal('edit');
                const campaignEditWorks =
                  campaignFormMode === 'edit'
                  && document.getElementById('campaign-modal-title')?.textContent === 'Edit Campaign'
                  && campaignNameInput?.value === 'Editable campaign'
                  && campaignDutInput?.value === 'Editable DUT'
                  && document.getElementById('campaign-create-btn')?.textContent === 'Save Changes'
                  && campaignPlanFromForm().autoRun === true;
                hideCampaignModal();
                campaignOperatorStatus = { active: false };
                showCampaignModal('create');
                campaignNameInput.focus();
                setSmokeInput(campaignNameInput, 'Second campaign');
                const secondCampaignTypingWorks = campaignNameInput.value === 'Second campaign'
                  && document.activeElement === campaignNameInput
                  && !campaignNameInput.disabled;
                const pointsPerCycleInput = document.getElementById('campaign-points-input');
                pointsPerCycleInput.focus();
                setSmokeInput(pointsPerCycleInput, '10');
                const numericCampaignTypingWorks = pointsPerCycleInput.value === '10'
                  && document.activeElement === pointsPerCycleInput
                  && !pointsPerCycleInput.disabled;
                const numericCampaignValue = pointsPerCycleInput.value;
                const campaignWorkflowReady = document.getElementById('campaign-test-type')?.value === 'inside'
                  && document.getElementById('campaign-runs-input')?.value === '3'
                  && document.getElementById('campaign-cycles-input')?.value === '3'
                  && Number(pointsPerCycleInput.value) === 10
                  && campaignSummary.includes('3 total runs')
                  && campaignSummary.includes('300 measurements per run');
                const campaignCaretColor = getComputedStyle(campaignNameInput).caretColor;
                const campaignCaretVisible = campaignCaretColor
                  && !['auto', 'transparent', 'rgba(0, 0, 0, 0)'].includes(campaignCaretColor);
                const campaignInputsEditable =
                  campaignKeyboardTypingWorks
                  && !campaignNameInput.disabled;
                const campaignButtonWorks = document.getElementById('campaign-modal')?.classList.contains('show') === true;
                const rcwlCampaignControlMatrix = [];
                const campaignTestSelect = document.getElementById('campaign-test-type');
                const campaignTargetSelect = document.getElementById('campaign-radar-target');
                for (const mode of ['inside', 'outside', 'characterization', 'interference', 'custom']) {
                  for (const hardware of [{ layout: 'single', target: 'rcwl_single' }, { layout: 'dual', target: 'rcwl_dual' }]) {
                    campaignTestSelect.value = mode;
                    campaignTestSelect.dispatchEvent(new Event('input', { bubbles: true }));
                    campaignLayout.value = hardware.layout;
                    campaignLayout.dispatchEvent(new Event('input', { bubbles: true }));
                    campaignTargetSelect.value = hardware.target;
                    campaignTargetSelect.dispatchEvent(new Event('change', { bubbles: true }));
                    campaignTargetSelect.scrollIntoView({ block: 'center' });
                    campaignTargetSelect.focus();
                    const targetRect = campaignTargetSelect.getBoundingClientRect();
                    const targetHit = document.elementFromPoint(targetRect.left + targetRect.width / 2, targetRect.top + targetRect.height / 2);
                    const plan = campaignPlanFromForm();
                    rcwlCampaignControlMatrix.push({ mode, ...hardware, pass: !document.getElementById('campaign-radar-target-row').hidden
                      && !campaignTargetSelect.disabled && document.activeElement === campaignTargetSelect && targetHit === campaignTargetSelect
                      && plan.radarTarget === hardware.target && plan.geometry.sensorLayout === hardware.layout
                      && plan.gains.length === 0 && plan.thresholds.length === 0
                      && document.getElementById('campaign-gain-group').hidden && document.getElementById('campaign-threshold-group').hidden });
                  }
                  campaignTestSelect.value = mode;
                  campaignTestSelect.dispatchEvent(new Event('input', { bubbles: true }));
                  campaignLayout.value = 'rcwl_pair';
                  campaignLayout.dispatchEvent(new Event('input', { bubbles: true }));
                  campaignLayout.scrollIntoView({ block: 'center' });
                  campaignLayout.focus();
                  const pairLayoutRect = campaignLayout.getBoundingClientRect();
                  const pairLayoutHit = document.elementFromPoint(pairLayoutRect.left + pairLayoutRect.width / 2, pairLayoutRect.top + pairLayoutRect.height / 2);
                  const pairPlan = campaignPlanFromForm();
                  rcwlCampaignControlMatrix.push({ mode, layout: 'rcwl_pair', target: 'rcwl_pair', pass:
                    !campaignLayout.disabled && document.activeElement === campaignLayout && pairLayoutHit === campaignLayout
                    && document.getElementById('campaign-radar-target-row').hidden
                    && pairPlan.radarTarget === 'rcwl_pair' && pairPlan.geometry.sensorLayout === 'rcwl_pair'
                    && pairPlan.gains.length === 0 && pairPlan.thresholds.length === 0 });
                }
                const rcwlCampaignControlsWork = rcwlCampaignControlMatrix.every((entry) => entry.pass);
                const campaignFieldAudit = auditEditableFields(document.getElementById('campaign-create-view'), 'campaign');
                document.getElementById('campaign-modal')?.classList.remove('show');
                config.test.mode = 'inside';
                openConfigModal('sequence');
                const configLayout = document.getElementById('cfg-sensor-layout');
                if (configLayout) {
                  configLayout.value = 'single';
                  configLayout.dispatchEvent(new Event('change', { bubbles: true }));
                }
                const rcwlEngineeringControlMatrix = [];
                const configMode = document.getElementById('cfg-test-mode');
                const configTarget = document.getElementById('cfg-radar-target');
                for (const mode of ['inside', 'outside', 'characterization', 'interference', 'custom', 'sequence']) {
                  for (const hardware of [{ layout: 'single', target: 'rcwl_single' }, { layout: 'dual', target: 'rcwl_dual' }]) {
                    configMode.value = mode;
                    configLayout.value = hardware.layout;
                    configLayout.dispatchEvent(new Event('change', { bubbles: true }));
                    configTarget.value = hardware.target;
                    configTarget.dispatchEvent(new Event('change', { bubbles: true }));
                    configTarget.scrollIntoView({ block: 'center' });
                    configTarget.focus();
                    const targetRect = configTarget.getBoundingClientRect();
                    const targetHit = document.elementFromPoint(targetRect.left + targetRect.width / 2, targetRect.top + targetRect.height / 2);
                    const saved = await radarAPI.configSet({ ...config,
                      test: { ...(config.test || {}), mode },
                      validation: { ...(config.validation || {}), sensorLayout: hardware.layout, radarTarget: hardware.target } });
                    const persisted = await radarAPI.configGet();
                    rcwlEngineeringControlMatrix.push({ mode, ...hardware, pass: !document.getElementById('cfg-radar-target-row').hidden
                      && !configTarget.disabled && document.activeElement === configTarget && targetHit === configTarget
                      && saved?.success && persisted.test?.mode === mode
                      && persisted.validation?.sensorLayout === hardware.layout && persisted.validation?.radarTarget === hardware.target });
                  }
                  configMode.value = mode;
                  configLayout.value = 'rcwl_pair';
                  configLayout.dispatchEvent(new Event('change', { bubbles: true }));
                  configLayout.scrollIntoView({ block: 'center' });
                  configLayout.focus();
                  const pairLayoutRect = configLayout.getBoundingClientRect();
                  const pairLayoutHit = document.elementFromPoint(pairLayoutRect.left + pairLayoutRect.width / 2, pairLayoutRect.top + pairLayoutRect.height / 2);
                  const saved = await radarAPI.configSet({ ...config,
                    test: { ...(config.test || {}), mode },
                    validation: { ...(config.validation || {}), sensorLayout: 'rcwl_pair', radarTarget: 'rcwl_pair' } });
                  const persisted = await radarAPI.configGet();
                  rcwlEngineeringControlMatrix.push({ mode, layout: 'rcwl_pair', target: 'rcwl_pair', pass:
                    !configLayout.disabled && document.activeElement === configLayout && pairLayoutHit === configLayout
                    && document.getElementById('cfg-radar-target-row').hidden
                    && saved?.success && persisted.test?.mode === mode
                    && persisted.validation?.sensorLayout === 'rcwl_pair' && persisted.validation?.radarTarget === 'rcwl_pair' });
                }
                const rcwlEngineeringControlsWork = rcwlEngineeringControlMatrix.every((entry) => entry.pass);
                configMode.value = 'inside';
                configLayout.value = 'single';
                configLayout.dispatchEvent(new Event('change', { bubbles: true }));
                const configFieldAudit = auditEditableFields(document.getElementById('config-modal'), 'configuration');
                const singleSensorInput = document.getElementById('cfg-radar-center-x');
                singleSensorInput?.scrollIntoView({ block: 'center' });
                const sensorRect = singleSensorInput?.getBoundingClientRect();
                const sensorHit = sensorRect ? document.elementFromPoint(sensorRect.left + sensorRect.width / 2, sensorRect.top + sensorRect.height / 2) : null;
                singleSensorInput?.focus();
                if (singleSensorInput) {
                  singleSensorInput.value = '901';
                  singleSensorInput.dispatchEvent(new Event('input', { bubbles: true }));
                }
                const geometryInputsEditableBeforeLifecycle = sensorHit === singleSensorInput
                  && document.activeElement === singleSensorInput
                  && singleSensorInput?.value === '901'
                  && !singleSensorInput.disabled;
                config.validation.systemLevel = { requiredTriggerMm: 355.6, requiredNoTriggerMm: 711.2 };
                await radarAPI.configSet(config);
                closeConfigModal();
                config = await radarAPI.configGet();
                openConfigModal('system-level');
                const systemPassInput = document.getElementById('cfg-system-pass-inches');
                const systemRedInput = document.getElementById('cfg-system-red-inches');
                const reflectorClearanceInput = document.getElementById('cfg-reflector-clearance-mm');
                const coverageModeInput = document.getElementById('cfg-coverage-mode');
                testRunning = true;
                updateEngineeringSetupEditability();
                testRunning = false;
                updateEngineeringSetupEditability();
                systemPassInput.focus();
                reflectorClearanceInput.value = '18';
                coverageModeInput.value = 'full-dut';
                const systemLevelInputLifecycleWorks = systemPassInput.value === '14'
                  && systemRedInput.value === '28'
                  && document.activeElement === systemPassInput
                  && !systemPassInput.disabled && !systemPassInput.readOnly
                  && !systemRedInput.disabled && !systemRedInput.readOnly
                  && reflectorClearanceInput.value === '18'
                  && coverageModeInput.value === 'full-dut'
                  && !reflectorClearanceInput.disabled && !reflectorClearanceInput.readOnly;
                config.dut = { ...(config.dut || {}), reflectorClearanceMm: 18 };
                config.validation.coverageMode = 'full-dut';
                config.validation.coverageSides = ['front', 'left', 'right'];
                config = RecipeCore.saveCustom(config, RecipeCore.normalize({
                  name: 'Lifecycle Recipe', family: 'inside', pointCount: 25, cycles: 3,
                  angularZones: ['front'], systemBounds: config.validation.systemLevel,
                }));
                await radarAPI.configSet(config);
                closeConfigModal();
                config = await radarAPI.configGet();
                populateRecipeSelectors();
                openConfigModal('recipe');
                const recipeNameInput = document.getElementById('recipe-name-input');
                testRunning = true;
                updateEngineeringSetupEditability();
                testRunning = false;
                updateEngineeringSetupEditability();
                recipeNameInput.focus();
                const recipeInputLifecycleWorks = recipeNameInput.value === 'Lifecycle Recipe'
                  && document.activeElement === recipeNameInput
                  && !recipeNameInput.disabled && !recipeNameInput.readOnly
                  && document.getElementById('quick-recipe-select').value === config.recipes.activeId;
                const inFieldLocation = DutLocationCore.DEFAULT_LOCATION;
                config.validation.sensorLayout = 'dual';
                config.dut = { ...(config.dut || {}), activeLocationId: inFieldLocation.id, reflectorClearanceMm: 18 };
                const inFieldLayout = document.getElementById('cfg-sensor-layout');
                inFieldLayout.value = 'dual';
                inFieldLayout.dispatchEvent(new Event('change', { bubbles: true }));
                document.getElementById('cfg-dut-location').value = inFieldLocation.id;
                document.getElementById('cfg-reflector-clearance-mm').value = '18';
                const generatorPattern = document.getElementById('seq-generator-pattern');
                generatorPattern.value = 'line';
                generatorPattern.dispatchEvent(new Event('change', { bubbles: true }));
                document.getElementById('seq-gen-raster-mode').value = 'count';
                document.getElementById('seq-gen-raster-x-min').value = '650';
                document.getElementById('seq-gen-raster-x-max').value = '1100';
                document.getElementById('seq-gen-raster-y-min').value = '800';
                document.getElementById('seq-gen-raster-y-max').value = '1040';
                document.getElementById('seq-gen-raster-count').value = '35';
                document.getElementById('seq-gen-raster-serpentine').checked = true;
                generatorPattern.value = 'raster';
                generatorPattern.dispatchEvent(new Event('change', { bubbles: true }));
                const lineToRasterSwitchWorks = document.querySelector('[data-generator-panel="raster"]')?.classList.contains('active')
                  && !document.querySelector('[data-generator-panel="line"]')?.classList.contains('active')
                  && generatorPreview.length === 35
                  && generatorPreviewSafety?.safe === true;
                const inFieldPlan = buildRasterPlan();
                const inFieldKeepout = DutLocationCore.noGoBounds(inFieldLocation, 18);
                const safeGeneratedEndpoints = inFieldPlan.points.every((point) =>
                  !DutLocationCore.pointInNoGo(point, inFieldLocation, { clearanceMm: 18 })
                  && !DutLocationCore.pointBehindDut(point, inFieldLocation));
                const sideBandPoints = inFieldPlan.points.filter((point) => point.y >= inFieldKeepout.minY);
                applyGeneratedSequence('replace');
                const appliedInFieldPlan = config.sequences[config.activeSequence] || [];
                const inFieldDutPlanWorks = inFieldPlan.canApply
                  && inFieldPlan.points.length === 35
                  && safeGeneratedEndpoints
                  && sideBandPoints.some((point) => point.x < inFieldKeepout.minX)
                  && sideBandPoints.some((point) => point.x > inFieldKeepout.maxX)
                  && appliedInFieldPlan.length === 35
                  && evaluateMotionPlan(appliedInFieldPlan).safe;
                resolve({
                  ready: true,
                  startupError: '',
                  defaults,
                  defaultsLoaded,
                  guidedSingleHidesSystem,
                  guidedSingleCharacterizationWorks,
                  guidedSystemValidationWorks,
                  guidedSystemDiagnostics,
                  guidedInputsRemainEditable,
                  campaignButtonWorks,
                  campaignWorkflowReady,
                  campaignSummary,
                  campaignInputsEditable,
                  campaignKeyboardTypingWorks,
                  autoRunPlanCaptured,
                  campaignEditWorks,
                  secondCampaignTypingWorks,
                  numericCampaignTypingWorks,
                  numericCampaignValue,
                  campaignCaretVisible,
                  campaignInputDiagnostics: {
                    nameValue: campaignNameInput?.value || '',
                    dutValue: campaignDutInput?.value || '',
                    activeId: document.activeElement?.id || '',
                    nameDisabled: campaignNameInput?.disabled,
                    nameReadOnly: campaignNameInput?.readOnly,
                    textInputCoreAvailable: typeof TextInputCore !== 'undefined',
                    caretColor: campaignCaretColor,
                  },
                  sensorLayoutVisibilityWorks: singleCampaignShowsSensorGeometry
                    && dualCampaignHidesSensorGeometry,
                  geometryInputsEditable: geometryInputsEditableBeforeLifecycle,
                  geometryInputDiagnostics: {
                    hitId: sensorHit?.id || '',
                    activeId: document.activeElement?.id || '',
                    rect: sensorRect ? { left: sensorRect.left, top: sensorRect.top, width: sensorRect.width, height: sensorRect.height } : null,
                    hidden: singleSensorInput ? singleSensorInput.offsetParent === null : true,
                  },
                  engineeringKeyboardInput: window.__smokeEngineeringInput,
                  fieldAudits: [mainFieldAudit, campaignFieldAudit, configFieldAudit],
                  allEditableFieldsWork:
                    [mainFieldAudit, campaignFieldAudit, configFieldAudit]
                      .every((audit) => audit.tested > 0 && audit.failures.length === 0),
                  systemLevelInputLifecycleWorks,
                  recipeInputLifecycleWorks,
                  lineToRasterSwitchWorks,
                  inFieldDutPlanWorks,
                  radarPolls: window.__radarAppDiagnostics?.radarPolls || 0,
                  radarToggleWorks: radarHighLabel === 'Radar TRIGGERED' && radarLowLabel === 'Radar LOW',
                  radarSettingsMatrixWorks,
                  radarSettingsMatrix,
                  rcwlCampaignControlsWork,
                  rcwlCampaignControlMatrix,
                  rcwlEngineeringControlsWork,
                  rcwlEngineeringControlMatrix,
                  radarLabel: document.getElementById('lbl-radar')?.textContent || ''
                });
              }, 500);
            };
            inspect();
          })
        `, true);
        const success = result.ready && result.defaultsLoaded && result.campaignButtonWorks && result.campaignWorkflowReady
          && result.guidedSingleHidesSystem && result.guidedSingleCharacterizationWorks
          && result.guidedSystemValidationWorks && result.guidedInputsRemainEditable
          && result.campaignInputsEditable && result.campaignCaretVisible && result.geometryInputsEditable
          && result.autoRunPlanCaptured
          && result.campaignEditWorks
          && result.secondCampaignTypingWorks
          && result.numericCampaignTypingWorks
          && result.engineeringKeyboardInput?.success
          && result.sensorLayoutVisibilityWorks
          && result.radarSettingsMatrixWorks
          && result.rcwlCampaignControlsWork
          && result.rcwlEngineeringControlsWork
          && result.allEditableFieldsWork
          && result.systemLevelInputLifecycleWorks
          && result.recipeInputLifecycleWorks
          && result.lineToRasterSwitchWorks
          && result.inFieldDutPlanWorks
          && result.radarPolls >= 2 && result.radarToggleWorks;
        console.log(`RADAR_SMOKE_RESULT:${JSON.stringify({ ...result, success })}`);
        app.exit(success ? 0 : 1);
      } catch (error) {
        console.error(`RADAR_SMOKE_RESULT:${JSON.stringify({ success: false, startupError: String(error?.stack || error) })}`);
        app.exit(1);
      }
    });
  }
  mainWindow.loadFile('index.html');
}

app.whenReady().then(() => {
  createWindow();
});

app.on('window-all-closed', () => {
  stopPolling();
  if (logStream) { logStream.end(); logStream = null; }
  if (process.platform !== 'darwin') app.quit();
});

// ─── Moonraker HTTP client ────────────────────────────────────────────────────
let baseUrl        = null;
let moonrakerReady = false;
let pollTimer      = null;
let latestPosition = null;
let latestHomedAxes = '';

let latestRadarState = {
  success: false,
  high: false,
  state: 'UNKNOWN',
  updatedAt: 0,
  error: 'Not connected',
};

/** Returns the current base url. */
function currentBaseUrl() {
  return `http://${config.connection.host}:${config.connection.port}`;
}

/** Fetches json. */
async function fetchJson(urlPath, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(baseUrl + urlPath, { ...options, signal: controller.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Calls the narrowly scoped radar-settings HTTP service running on the fixture Pi. */
async function fetchRadarService(urlPath, options = {}) {
  const host = config.connection?.host;
  const port = Math.max(1, Number(config.radarService?.port) || 7130);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(250, Number(config.radarService?.timeoutMs) || 2500));
  const headers = { ...(options.headers || {}) };
  if (config.radarService?.apiToken) headers.Authorization = `Bearer ${config.radarService.apiToken}`;
  try {
    const response = await fetch(`http://${host}:${port}${urlPath}`, { ...options, headers, signal: controller.signal });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Radar service HTTP ${response.status}`);
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

/** Posts gcode. */
async function postGcodeNow(script, timeoutMs = 8000, timeoutFault = {}) {
  const startedAt = Date.now();
  try {
    await fetchJson('/printer/gcode/script', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script }),
    }, timeoutMs);
    return { success: true, elapsedMs: Date.now() - startedAt };
  } catch (e) {
    const timedOut = e.name === 'AbortError';
    const timeoutCode = timeoutFault.code || 'ERR004';
    const timeoutLabel = timeoutFault.label || 'G-code request timeout';
    return {
      success: false,
      elapsedMs: Date.now() - startedAt,
      error: timedOut ? `Timed out after ${timeoutMs}ms (${timeoutCode} — ${timeoutLabel})` : e.message,
      code: timedOut ? timeoutCode : classifyError(e.message),
    };
  }
}

function postGcode(script, timeoutMs = 8000, timeoutFault = {}) {
  if (runController.shouldAbort()) {
    return Promise.resolve({ success: false, code: 'ERR_ESTOP', error: runController.snapshot()?.reason || 'Run cancellation requested' });
  }
  const commandId = `cmd-${Date.now()}-${++commandSequence}`;
  const command = String(script || '').trim().split(/\s+/)[0] || 'unknown';
  diagnosticLogger.info('fixture.command_started', { commandId, command, timeoutMs });
  return motionArbiter.run(async () => {
    const result = await postGcodeNow(script, timeoutMs, timeoutFault);
    diagnosticLogger.info('fixture.command_completed', { commandId, command, success: result.success, code: result.code || null, elapsedMs: result.elapsedMs });
    return { ...result, commandId };
  });
}

/** Classifies error. */
function classifyError(message) {
  const m = (message || '').toLowerCase();
  if (m.includes('fetch failed') || m.includes('econnrefused') || m.includes('enotfound') || m.includes('timeout')) return 'ERR004';
  if (m.includes('move out of range') || m.includes('travel limit') || m.includes('position exceeds')) return 'ERR006';
  if (m.includes('home') || m.includes('endstop')) return 'ERR002';
  if (m.includes('mcu') || m.includes('shutdown') || m.includes('disconnect')) return 'ERR003';
  if (m.includes('motor') || m.includes('driver') || m.includes('overcurrent') || m.includes('stall')) return 'ERR001';
  return null;
}

ipcMain.handle('moonraker:connect', async (_, payload) => {
  const contract = contractResult('moonraker:connect', payload);
  if (!contract.success) return contract;
  const { host, port } = contract.value;
  config.connection.host = host;
  config.connection.port = port;
  saveConfig(config);
  baseUrl = currentBaseUrl();

  try {
    await fetchJson('/printer/info', {}, 5000);
    moonrakerReady = true;
    startPolling();
    return { success: true };
  } catch (e) {
    moonrakerReady = false;
    return { success: false, error: e.message, code: 'ERR004' };
  }
});

ipcMain.handle('moonraker:disconnect', () => {
  moonrakerReady = false;
  stopPolling();
  return { success: true };
});

/** Starts polling. */
function startPolling() {
  stopPolling();

  const poll = async () => {
    if (!moonrakerReady) return;

    try {
      const baseQuery = '/printer/objects/query?webhooks&toolhead=homed_axes,position&idle_timeout=state';
      let data;
      let radarSource = 'named';
      try {
        data = await fetchJson(`${baseQuery}&gcode_button%20radar_sensor_a=state&gcode_button%20radar_sensor_b=state&gcode_button%20radar_sensor_single=state&gcode_button%20radar_sensor_ld021=state&gcode_button%20radar_sensor_ld021_a=state&gcode_button%20radar_sensor_ld021_b=state`, {}, 3000);
      } catch {
        // Preserve compatibility while printer.cfg is migrated to the named
        // inputs (A, B, MS58 SINGLE, and HLK-LD021).
        data = await fetchJson(`${baseQuery}&gcode_button%20radar_sensor=state`, {}, 3000);
        radarSource = 'legacy';
      }

      let status = data.result.status;
      if (radarSource === 'named'
        && !status['gcode_button radar_sensor_a']
        && !status['gcode_button radar_sensor_b']
        && !status['gcode_button radar_sensor_single']) {
        data = await fetchJson(`${baseQuery}&gcode_button%20radar_sensor=state`, {}, 3000);
        status = data.result.status;
        radarSource = 'legacy';
      }
      const pos = status.toolhead.position || [0, 0, 0, 0];
      latestPosition = { x: Number(pos[0]), y: Number(pos[1]), z: Number(pos[2]) };
      latestHomedAxes = String(status.toolhead.homed_axes || '').toLowerCase();
      if (runController.isActive() && ['shutdown', 'error'].includes(String(status.webhooks.state || '').toLowerCase())) {
        runController.fault(`Klipper entered ${status.webhooks.state}`);
      }

      const buttonA = radarSource === 'named' ? status['gcode_button radar_sensor_a'] : radarSource === 'dual' ? status['gcode_button radar_sensor_a'] : status['gcode_button radar_sensor'];
      const buttonB = radarSource === 'named' || radarSource === 'dual' ? status['gcode_button radar_sensor_b'] : null;
      const buttonSingle = radarSource === 'named' ? status['gcode_button radar_sensor_single'] : null;
      const buttonLD021 = radarSource === 'named' ? status['gcode_button radar_sensor_ld021'] : null;
      const buttonLD021A = radarSource === 'named' ? status['gcode_button radar_sensor_ld021_a'] : null;
      const buttonLD021B = radarSource === 'named' ? status['gcode_button radar_sensor_ld021_b'] : null;
      const stateA = buttonA?.state || 'UNKNOWN';
      const stateB = radarSource === 'named' || radarSource === 'dual' ? (buttonB?.state || 'UNKNOWN') : 'NOT_CONFIGURED';
      const stateSingle = radarSource === 'named' ? (buttonSingle?.state || 'UNKNOWN') : 'NOT_CONFIGURED';
      const stateLD021 = radarSource === 'named' ? (buttonLD021?.state || 'UNKNOWN') : 'NOT_CONFIGURED';
      // Sensor A is the backward-compatible single-HLK channel. Fixtures that
      // have not renamed its Klipper input yet may still expose only LD021.
      const stateLD021A = radarSource === 'named' ? (buttonLD021A?.state || buttonLD021?.state || 'UNKNOWN') : 'NOT_CONFIGURED';
      const stateLD021B = radarSource === 'named' ? (buttonLD021B?.state || 'UNKNOWN') : 'NOT_CONFIGURED';
      const target = activeRadarTarget();
      const activeReadable = ['single', 'rcwl_single'].includes(target)
        ? stateSingle !== 'UNKNOWN' && stateSingle !== 'NOT_CONFIGURED'
        : target === 'ld021' ? stateLD021 !== 'UNKNOWN' && stateLD021 !== 'NOT_CONFIGURED'
        : target === 'ld021_a' ? stateLD021A !== 'UNKNOWN' && stateLD021A !== 'NOT_CONFIGURED'
        : target === 'ld021_b' ? stateLD021B !== 'UNKNOWN' && stateLD021B !== 'NOT_CONFIGURED'
        : target === 'ld021_pair' ? stateLD021A !== 'UNKNOWN' && stateLD021A !== 'NOT_CONFIGURED' && stateLD021B !== 'UNKNOWN' && stateLD021B !== 'NOT_CONFIGURED'
        : ['rcwl_dual', 'rcwl_pair'].includes(target) ? stateA !== 'UNKNOWN' && stateB !== 'UNKNOWN'
        : radarSource === 'legacy' ? stateA !== 'UNKNOWN' : stateA !== 'UNKNOWN' && stateB !== 'UNKNOWN';
      const high = ['single', 'rcwl_single'].includes(target) ? stateSingle === 'PRESSED'
        : target === 'ld021' ? stateLD021 === 'PRESSED'
        : target === 'ld021_a' ? stateLD021A === 'PRESSED'
        : target === 'ld021_b' ? stateLD021B === 'PRESSED'
        : target === 'ld021_pair' ? stateLD021A === 'PRESSED' || stateLD021B === 'PRESSED' : stateA === 'PRESSED' || stateB === 'PRESSED';

      latestRadarState = {
        success: activeReadable,
        high,
        state: high ? 'PRESSED' : activeReadable ? 'RELEASED' : 'UNKNOWN',
        source: radarSource,
        sensors: {
          A: { state: stateA, detected: stateA === 'PRESSED' },
          B: { state: stateB, detected: stateB === 'PRESSED', configured: radarSource === 'named' || radarSource === 'dual' },
          SINGLE: { state: stateSingle, detected: stateSingle === 'PRESSED', configured: radarSource === 'named' },
          LD021: { state: stateLD021, detected: stateLD021 === 'PRESSED', configured: radarSource === 'named' },
          LD021_A: { state: stateLD021A, detected: stateLD021A === 'PRESSED', configured: radarSource === 'named' },
          LD021_B: { state: stateLD021B, detected: stateLD021B === 'PRESSED', configured: radarSource === 'named' },
          RCWL_SINGLE: { state: stateSingle, detected: stateSingle === 'PRESSED', configured: radarSource === 'named' },
          RCWL_A: { state: stateA, detected: stateA === 'PRESSED', configured: radarSource !== 'legacy' },
          RCWL_B: { state: stateB, detected: stateB === 'PRESSED', configured: radarSource === 'named' || radarSource === 'dual' },
        },
        updatedAt: Date.now(),
        activeTarget: target,
        activeChannels: target === 'ld021_pair' ? ['LD021_A', 'LD021_B'] : target === 'ld021_a' ? ['LD021_A'] : target === 'ld021_b' ? ['LD021_B'] : target === 'ld021' ? ['LD021'] : target === 'single' ? ['SINGLE'] : target === 'rcwl_single' ? ['RCWL_SINGLE'] : ['rcwl_dual', 'rcwl_pair'].includes(target) ? ['RCWL_A', 'RCWL_B'] : ['A', 'B'],
        error: activeReadable ? '' : 'One or more active radar detection inputs are unavailable',
      };

      if (mainWindow) {
        mainWindow.webContents.send('moonraker:status', {
          piOnline: true,
          klippyState: status.webhooks.state,
          stateMessage: status.webhooks.state_message || '',
          homedAxes: status.toolhead.homed_axes || '',
          idleState: status.idle_timeout.state,
          position: { x: pos[0], y: pos[1], z: pos[2] },
        });
      }
    } catch (e) {
      latestRadarState = {
        ...latestRadarState,
        success: false,
        error: e.message,
      };

      if (mainWindow) {
        mainWindow.webContents.send('moonraker:status', {
          piOnline: false,
          error: e.message,
          code: 'ERR004',
        });
      }
    } finally {
      if (moonrakerReady) pollTimer = setTimeout(poll, Math.max(20, Number(config.radar?.pollMs) || 100));
    }
  };

  pollTimer = setTimeout(poll, 0);
}

/** Stops polling. */
function stopPolling() {
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
}

// ─── Motion commands ──────────────────────────────────────────────────────────

function activeDutLocation() {
  const locations = Array.isArray(config.dut?.locations) ? config.dut.locations : [];
  if (config.validation?.sensorLayout !== 'dual') {
    return [DutLocationCore.SINGLE_SENSOR_LOCATION, DutLocationCore.SINGLE_SENSOR_DUT_LOCATION, DutLocationCore.ORIGINAL_LOCATION, ...locations]
      .find((location) => location.id === config.dut?.activeLocationId
        && (location.id === DutLocationCore.SINGLE_SENSOR_DUT_LOCATION.id
          || location.id === DutLocationCore.ORIGINAL_LOCATION.id
          || (Number(location.widthMm) === 0 && Number(location.depthMm) === 0)))
      || DutLocationCore.SINGLE_SENSOR_LOCATION;
  }
  return locations.find((location) => location.id === config.dut?.activeLocationId)
    || locations[0] || DutLocationCore.DEFAULT_LOCATION;
}

function reflectorClearanceMm() {
  return Math.max(0, Number(config.dut?.reflectorClearanceMm) || 0);
}

function collisionResult(start, end) {
  const clearanceMm = reflectorClearanceMm();
  if (config.validation?.sensorLayout === 'dual' && DutLocationCore.pointBehindDut(end, activeDutLocation())) {
    return { success: false, code: 'ERR008', error: 'Move blocked: rear motion behind the in-field DUT is unavailable' };
  }
  if (!DutLocationCore.pointInNoGo(end, activeDutLocation(), { clearanceMm })
      && !DutLocationCore.segmentIntersectsNoGo(start, end, activeDutLocation(), { clearanceMm })) return null;
  const bounds = DutLocationCore.noGoBounds(activeDutLocation(), clearanceMm);
  return {
    success: false,
    code: 'ERR008',
    error: `Move blocked by DUT no-go zone X${bounds.minX}–${bounds.maxX}, Y${bounds.minY}–${bounds.maxY}`,
  };
}

function motionFailure(error, code = 'ERR006') {
  return { success: false, code, error };
}

function validatedSpeed(speedMmS) {
  const issue = MotionSafetyCore.speedIssue(speedMmS);
  return issue ? { error: issue } : { value: Number(speedMmS) };
}

ipcMain.handle('moonraker:jog', async (_, { axis, deltaMm, feedMmS }) => {
  const normalizedAxis = String(axis || '').toLowerCase();
  if (!MotionSafetyCore.AXES.includes(normalizedAxis)) return motionFailure('Jog axis must be X, Y, or Z');
  if (!MotionSafetyCore.finite(deltaMm) || Number(deltaMm) === 0) return motionFailure('Jog distance must be a non-zero finite number');
  const speed = validatedSpeed(feedMmS);
  if (speed.error) return motionFailure(speed.error);
  const AXIS = normalizedAxis.toUpperCase();
  if (normalizedAxis !== 'z' && !latestHomedAxes.includes(normalizedAxis)) {
    return motionFailure(`${AXIS} must be homed before jogging`, 'ERR002');
  }
  const current = latestPosition?.[normalizedAxis];
  if (!MotionSafetyCore.finite(current)) return motionFailure(`Current ${AXIS} position is unknown; home or refresh position before jogging`, 'ERR002');
  const targetValue = Number(current) + Number(deltaMm);
  const limitIssue = MotionSafetyCore.pointIssue(config.motion, { [normalizedAxis]: targetValue });
  if (limitIssue) return motionFailure(`Jog blocked: ${limitIssue}`);
  if (latestPosition && (AXIS === 'X' || AXIS === 'Y')) {
    const target = { ...latestPosition, [normalizedAxis]: targetValue };
    const collision = collisionResult(latestPosition, target);
    if (collision) return collision;
  }
  const feedMmMin = MotionSafetyCore.feedMmMin(speed.value);
  const script = `G91\nG1 ${AXIS}${Number(deltaMm)} F${feedMmMin}\nG90\nM400`;
  const result = await postGcode(script, 15000, { code: 'ERR005', label: 'position timeout; check for mechanical binding' });
  if (result.success && latestPosition) latestPosition[normalizedAxis] = targetValue;
  return result;
});

ipcMain.handle('moonraker:moveAndWait', async (_, { x, y, z, feedMmS, timeoutMs }) => {
  const requested = { x, y, z };
  const requiredHomedAxes = ['x', 'y'].filter((axis) => requested[axis] !== undefined && requested[axis] !== null);
  const unhomedAxis = requiredHomedAxes.find((axis) => !latestHomedAxes.includes(axis));
  if (unhomedAxis) return motionFailure(`${unhomedAxis.toUpperCase()} must be homed before an absolute move`, 'ERR002');
  const limitIssue = MotionSafetyCore.pointIssue(config.motion, requested);
  if (limitIssue) return motionFailure(`Move blocked: ${limitIssue}`);
  const speed = validatedSpeed(feedMmS);
  if (speed.error) return motionFailure(speed.error);
  const effectiveTimeoutMs = timeoutMs ?? config.trigger.positionTimeoutMs;
  const timeoutIssue = MotionSafetyCore.timeoutIssue(effectiveTimeoutMs);
  if (timeoutIssue) return motionFailure(timeoutIssue, 'ERR005');
  const parts = [];
  if (x !== undefined && x !== null) parts.push(`X${Number(x)}`);
  if (y !== undefined && y !== null) parts.push(`Y${Number(y)}`);
  if (z !== undefined && z !== null) parts.push(`Z${Number(z)}`);
  if (!parts.length) return { success: false, error: 'No axes specified' };
  if (latestPosition && (x !== undefined || y !== undefined)) {
    const target = {
      x: x === undefined || x === null ? latestPosition.x : Number(x),
      y: y === undefined || y === null ? latestPosition.y : Number(y),
    };
    const collision = collisionResult(latestPosition, target);
    if (collision) return collision;
  }
  const feedMmMin = MotionSafetyCore.feedMmMin(speed.value);
  const script = `G1 ${parts.join(' ')} F${feedMmMin}\nM400`;
  const result = await postGcode(script, Number(effectiveTimeoutMs), {
    code: 'ERR005',
    label: 'position timeout; check for mechanical binding',
  });
  if (result.success && latestPosition) {
    if (x !== undefined && x !== null) latestPosition.x = Number(x);
    if (y !== undefined && y !== null) latestPosition.y = Number(y);
    if (z !== undefined && z !== null) latestPosition.z = Number(z);
  }
  return result;
});

ipcMain.handle('moonraker:home', async (_, { axes }) => {
  if (!Array.isArray(axes) || !axes.length) return motionFailure('At least one homing axis is required');
  const requestedAxes = [...new Set(axes.map((a) => String(a || '').toUpperCase()))];
  if (requestedAxes.some((axis) => !['X', 'Y'].includes(axis))) return motionFailure('Only X and Y can be physically homed on this fixture');
  if (latestPosition && requestedAxes.length === 1 && requestedAxes[0] === 'X') {
    const collision = collisionResult(latestPosition, { x: 0, y: latestPosition.y });
    if (collision) return collision;
  }
  if (latestPosition && requestedAxes.length === 1 && requestedAxes[0] === 'Y') {
    const collision = collisionResult(latestPosition, { x: latestPosition.x, y: 0 });
    if (collision) return collision;
  }
  // Never traverse X toward home while the reflector may still be beside the
  // DUT. Klipper homes a combined "G28 X Y" in X-first order on this fixture.
  const script = requestedAxes.includes('X') && requestedAxes.includes('Y')
    ? 'G28 Y\nG28 X'
    : `G28 ${requestedAxes.join(' ')}`;
  const result = await postGcode(script, 60000, { code: 'ERR002', label: 'homing command timeout' });
  if (!result.success) return result;
  try {
    const data = await fetchJson('/printer/objects/query?toolhead=homed_axes,position', {}, 3000);
    const toolhead = data.result.status.toolhead || {};
    const pos = toolhead.position || [];
    if (pos.length >= 2) {
      latestPosition = { x: Number(pos[0]), y: Number(pos[1]), z: Number(pos[2] || latestPosition?.z || 0) };
      latestHomedAxes = String(toolhead.homed_axes || requestedAxes.join('')).toLowerCase();
      return { ...result, position: { ...latestPosition }, homedAxes: toolhead.homed_axes || '' };
    }
  } catch { /* polling remains the fallback source */ }
  return { ...result, position: latestPosition ? { ...latestPosition } : null };
});

ipcMain.handle('moonraker:zeroZ', async () => {
  const result = await postGcode('SET_KINEMATIC_POSITION Z=0', 5000);
  if (result.success) {
    latestHomedAxes = `${latestHomedAxes}z`;
    if (latestPosition) latestPosition.z = 0;
  }
  return result;
});

ipcMain.handle('moonraker:trigger', async (_, { spinFeedMmMin } = {}) => {
  const requestedFeed = spinFeedMmMin ?? config.trigger.spinFeedMmMin;
  if (!MotionSafetyCore.finite(requestedFeed) || Number(requestedFeed) <= 0 || Number(requestedFeed) > 30000) {
    return motionFailure('Reflector feed must be between 1 and 30000 mm/min', 'ERR007');
  }
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(String(config.trigger.macro || ''))) {
    return motionFailure('Reflector macro name is invalid', 'ERR007');
  }
  const feed = Math.round(Number(requestedFeed));
  // Z is a continuously rotating reflector, not a linear position. The spin
  // macro adds one revolution to Z, so reset its logical coordinate before
  // every spin to prevent long sequences from reaching Klipper's Z maximum.
  const triggerTimeoutMs = Math.max(15000, Number(config.trigger.positionTimeoutMs) || 30000);
  return postGcode(
    `SET_KINEMATIC_POSITION Z=0\n${config.trigger.macro} SPEED=${feed}\nM400`,
    triggerTimeoutMs,
    { code: 'ERR007', label: 'reflector trigger command timeout' }
  );
});

ipcMain.handle('sensor:read', async () => {
  return { success: true, active: false };
});

ipcMain.handle('moonraker:setVelocityLimit', async (_, { velocity, accel }) => {
  const speedIssue = MotionSafetyCore.speedIssue(velocity);
  if (speedIssue) return motionFailure(speedIssue);
  if (!MotionSafetyCore.finite(accel) || Number(accel) <= 0 || Number(accel) > MotionSafetyCore.MAX_ACCEL_MM_S2) {
    return motionFailure(`Acceleration must be > 0 and <= ${MotionSafetyCore.MAX_ACCEL_MM_S2} mm/s²`);
  }
  return postGcode(`SET_VELOCITY_LIMIT VELOCITY=${Number(velocity)} ACCEL=${Number(accel)}`, 5000);
});

ipcMain.handle('moonraker:setGcodeOffset', async (_, { x, y, z }) => {
  if (![x, y, z].every(MotionSafetyCore.finite)) return motionFailure('G-code offsets must be finite numbers');
  return postGcode(`SET_GCODE_OFFSET X=${Number(x)} Y=${Number(y)} Z=${Number(z)}`, 5000);
});

ipcMain.handle('moonraker:estop', async () => {
  diagnosticLogger.warn('fixture.emergency_stop', { source: 'operator' });
  runController.fault('Emergency stop activated');
  return motionArbiter.emergency(async () => {
    try {
      await fetchJson('/printer/emergency_stop', { method: 'POST' }, 5000);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });
});

ipcMain.handle('moonraker:firmwareRestart', async () => {
  try {
    await fetchJson('/printer/firmware_restart', { method: 'POST' }, 15000);
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('radar:read', async () => {
  return latestRadarState;
});

// ─── Radar settings commands ─────────────────────────────────────────────────

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

function rcwlSettingsSnapshot(target = activeRadarTarget()) {
  const channels = target === 'rcwl_single' ? ['RCWL_SINGLE'] : ['RCWL_A', 'RCWL_B'];
  const sensors = Object.fromEntries(channels.map((channel) => {
    const input = latestRadarState.sensors?.[channel] || {};
    const online = input.state !== 'UNKNOWN' && input.state !== 'NOT_CONFIGURED';
    return [channel, { online, verified: online, state: input.state || 'UNKNOWN' }];
  }));
  const success = channels.every((channel) => sensors[channel].online);
  return { success, capturedAt: new Date().toISOString(), activeTarget: target, activeChannels: channels,
    protocolProfile: RadarSettingsCore.FIXED_OUTPUT_PROFILE, persistent: true, sensors,
    error: success ? '' : 'One or more active RCWL-0516 detection inputs are unavailable' };
}

/** Reads and verifies gain/threshold settings for the active radar target. */
ipcMain.handle('radar-settings:read', async () => {
  try {
    if (activeRadarTarget().startsWith('rcwl_')) return rcwlSettingsSnapshot();
    return await fetchRadarService(`/v1/radars?target=${activeRadarTarget()}`);
  } catch (error) {
    return { success: false, error: error.name === 'AbortError' ? 'Radar settings service timed out' : error.message };
  }
});

/** Applies a volatile change; the Pi service preserves unrelated radar fields. */
ipcMain.handle('radar-settings:apply', async (_, requested = {}) => {
  const contract = contractResult('radar-settings:apply', requested);
  if (!contract.success) return contract;
  requested = contract.value;
  try {
    const target = activeRadarTarget();
    if (target.startsWith('rcwl_')) return { ...rcwlSettingsSnapshot(target), success: false, error: 'RCWL-0516 has no programmable settings' };
    const protocolProfile = target.startsWith('ld021')
      ? RadarSettingsCore.LD021_PROTOCOL_PROFILE : 'moresense-hci-v2';
    const gainCode = protocolProfile === RadarSettingsCore.LD021_PROTOCOL_PROFILE
      ? null : RadarSettingsCore.normalizeGainCode(requested.gainCode);
    const threshold = RadarSettingsCore.normalizeThreshold(requested.threshold, protocolProfile);
    const outputTimeMs = protocolProfile === RadarSettingsCore.LD021_PROTOCOL_PROFILE && requested.outputTimeMs != null
      ? RadarSettingsCore.normalizeLd021OutputTimeMs(requested.outputTimeMs)
      : null;
    return await fetchRadarService('/v1/radars/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gainCode, threshold, outputTimeMs, target }),
    });
  } catch (error) {
    return { success: false, error: error.name === 'AbortError' ? 'Radar settings service timed out' : error.message };
  }
});

/** Saves the already verified current target settings to radar EEPROM. */
ipcMain.handle('radar-settings:save', async () => {
  try {
    if (activeRadarTarget().startsWith('rcwl_')) return rcwlSettingsSnapshot();
    return await fetchRadarService('/v1/radars/save', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: activeRadarTarget() }),
    });
  } catch (error) {
    return { success: false, error: error.name === 'AbortError' ? 'Radar settings service timed out' : error.message };
  }
});

/** Factory reset is isolated behind an exact confirmation phrase. */
ipcMain.handle('radar-settings:reset', async (_, confirmation) => {
  if (confirmation !== 'FACTORY RESET') return { success: false, error: 'Factory reset confirmation is required' };
  try {
    return await fetchRadarService('/v1/radars/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: confirmation, target: activeRadarTarget() }),
    });
  } catch (error) {
    return { success: false, error: error.name === 'AbortError' ? 'Radar settings service timed out' : error.message };
  }
});

// Optional external 5 V load switches for the interference fixture. These IPC
// endpoints deliberately expose only fixed A/B actions, never arbitrary GPIO.
ipcMain.handle('ld021-power:read', async () => {
  try { return await fetchRadarService('/v1/ld021-power'); }
  catch (error) { return { success: false, error: error.name === 'AbortError' ? 'Radar settings service timed out' : error.message }; }
});
ipcMain.handle('ld021-power:set', async (_, channel, enabled) => {
  if (!['LD021_A', 'LD021_B', 'BOTH'].includes(channel)) return { success: false, error: 'Invalid LD021 power channel' };
  try {
    return await fetchRadarService('/v1/ld021-power', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel, enabled: enabled === true }) });
  } catch (error) { return { success: false, error: error.name === 'AbortError' ? 'Radar settings service timed out' : error.message }; }
});
ipcMain.handle('ld021-power:emergencyOff', async () => {
  try { return await fetchRadarService('/v1/ld021-power/emergency-off', { method: 'POST' }); }
  catch (error) { return { success: false, error: error.name === 'AbortError' ? 'Radar settings service timed out' : error.message }; }
});

// ─── SSH reference ────────────────────────────────────────────────────────────

ipcMain.handle('ssh:copyCommand', (_, { host, username, port }) => {
  const cmd = port && port !== 22 ? `ssh -p ${port} ${username}@${host}` : `ssh ${username}@${host}`;
  clipboard.writeText(cmd);
  return { success: true, command: cmd };
});

// ─── Log file helpers ─────────────────────────────────────────────────────────
let logPath   = null;
let logStream = null;
let testStartMs = 0;
let manifestPath = null;
let summaryPath = null;
let reportPath = null;
let radarSettingsPath = null;
let runDirectory = null;
let activeLogMeta = null;

/** Returns the stable category folder for a test mode. */
function logCategoryFor(manifest = {}) {
  const testId = manifest.testDefinition?.id || manifest.testId || config.test?.mode || 'sequence';
  return {
    inside: '10.1',
    outside: '10.2',
    system: 'system_level_bounds',
    characterization: 'characterization',
    interference: 'interference',
    custom: 'custom',
    sequence: 'unscored_sequence',
  }[testId] || String(testId).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'radar_test';
}

/** Creates the stable metadata used in both in-progress and completed run names. */
function buildLogNameMetadata(manifest = {}) {
  return {
    category: logCategoryFor(manifest),
    baseName: RunNamingCore.buildRunBase(manifest, new Date(testStartMs)),
    manifest,
  };
}

/** Keeps the same run identity when moving a completed folder. */
function completedRunBase(meta) {
  return meta.baseName;
}

/** Escapes html. */
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]));
}

/** Builds the self-contained, printable HTML report for a completed run. */
function buildReportHtml(report = {}) {
  const safeJson = JSON.stringify(report).replace(/</g, '\\u003c');
  const title = escapeHtml(report.testName || report.testId || 'Radar Test');
  const result = escapeHtml(report.result || 'Complete');
  const characterizationOnly = report.testId === 'interference'
    ? '<div class="note" style="color:#7c3aed;font-weight:700">Characterization Only — No Acceptance Criteria Applied</div>' : '';
  const repeatabilityCycles = Math.max(1, Math.floor(Number(report.cyclesPlanned) || Number(report.aggregates?.[0]?.cyclesPlanned) || 1));
  const cycleWord = repeatabilityCycles === 1 ? 'Cycle' : 'Cycles';
  const spatialSection = report.testId === 'characterization' ? '' : `<section class="card"><h2 id="spatial-title">Spatial Results</h2><canvas id="spatial" width="3200" height="1800"></canvas><p class="note" id="spatial-note"></p></section>`;
  const latencySection = report.testId === 'outside' ? '' : `<section class="card"><h2>Detection Latency — Spatial Distribution</h2><canvas id="latency" width="3200" height="1600"></canvas><p class="note">White circles identify the actual triggered samples used by the spatial interpolation. The dimensionally accurate DUT footprint uses the selected DUT location and is excluded from interpolation, scoring, and all source data. Isolated latency spikes are display-limited with a local spatial median; original measurements remain unchanged in the CSV and raw-observation table.</p></section>`;
  const repeatabilitySection = ['characterization', 'interference'].includes(report.testId) ? `<section class="card"><div class="section-head"><div><h2>Radar Trigger Repeatability Across ${repeatabilityCycles} Test ${cycleWord}</h2><p class="note">Each marker is one tested X/Y position. Color is the number of valid cycles in which the radar triggered; no interpolation or smoothing is applied. Hover over a marker for its combined trigger count.</p></div><button id="download-repeatability">Download high-resolution PNG</button></div><div class="plot-wrap"><canvas id="repeatability" width="2200" height="1200"></canvas><div class="plot-tooltip" id="repeatability-tooltip"></div></div><h3>Trigger-count summary</h3><table id="repeatability-summary"></table></section>` : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} Report</title><style>
:root{color-scheme:dark;--bg:#0a0f18;--card:#111a28;--line:#26364e;--text:#e8eef8;--muted:#8fa0b8;--green:#00d879;--red:#ff4962;--cyan:#20c8f5}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px system-ui,Segoe UI,sans-serif}.page{max-width:2320px;margin:auto;padding:28px}.head,.section-head{display:flex;justify-content:space-between;gap:20px;align-items:flex-start}.section-head h2{margin-top:0}.badge{padding:10px 18px;border:1px solid var(--line);border-radius:8px;font-weight:800}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:18px;margin-top:18px}.meta,.counts{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:10px}.metric{background:#0c1420;border-radius:7px;padding:12px}.metric small{display:block;color:var(--muted);margin-bottom:5px}.metric strong{font-size:19px}canvas{display:block;width:100%;height:auto;background:#09111c;border-radius:7px}.plot-wrap{position:relative}.plot-tooltip{display:none;position:absolute;pointer-events:none;z-index:2;min-width:190px;padding:9px 11px;border:1px solid var(--line);border-radius:6px;background:#07101ddd;color:var(--text);font-size:12px;box-shadow:0 4px 18px #0008}.note{color:var(--muted);font-size:12px}.actions{display:flex;gap:8px}button{background:#17253a;color:var(--text);border:1px solid var(--line);padding:8px 12px;border-radius:6px;cursor:pointer}table{width:100%;border-collapse:collapse;font-size:12px}th,td{text-align:left;padding:7px;border-bottom:1px solid var(--line)}th{color:var(--muted);position:sticky;top:0;background:var(--card)}.table-wrap{max-height:420px;overflow:auto}
@page{size:landscape;margin:12mm}
@media print{html,body{background:#fff;color:#111;font-size:10pt}.page{max-width:none;padding:0}.head{break-inside:avoid-page}.card{background:#fff;border-color:#aaa;margin-top:5mm;break-inside:avoid-page;page-break-inside:avoid}.metric{background:#fff;border:1px solid #ccc}.actions button{display:none}canvas{background:#fff;max-width:100%;height:auto}.note,small,th{color:#444}.raw-observations{break-inside:auto;page-break-inside:auto;break-before:page;border:0;padding:0}.raw-observations h2{break-after:avoid-page;page-break-after:avoid}.table-wrap{max-height:none!important;height:auto!important;overflow:visible!important}.raw-observations table{width:100%;table-layout:fixed;font-size:7.5pt}.raw-observations thead{display:table-header-group}.raw-observations tbody{display:table-row-group}.raw-observations tr{break-inside:avoid-page;page-break-inside:avoid}.raw-observations th,.raw-observations td{position:static;padding:2.2mm 1.2mm;vertical-align:top;overflow-wrap:anywhere;border-bottom:1px solid #bbb}.raw-observations th{background:#eee;color:#222}.raw-observations th:nth-child(1),.raw-observations td:nth-child(1){width:17%}.raw-observations th:nth-child(2),.raw-observations td:nth-child(2){width:6%}.raw-observations th:nth-child(3),.raw-observations td:nth-child(3){width:10%}}
</style></head><body><main class="page"><div class="head"><div><h1>${title}</h1><div class="note">Generated ${escapeHtml(report.completedAt || new Date().toISOString())}</div>${characterizationOnly}</div><div class="actions"><button onclick="window.print()">Print / Save PDF</button><span class="badge">${result}</span></div></div>
  <section class="card meta" id="meta"></section><section class="card counts" id="counts"></section>
  ${spatialSection}
  ${repeatabilitySection}
  ${latencySection}
<section class="card raw-observations"><h2>Raw Observations</h2><div class="table-wrap"><table id="observations"></table></div></section>
<script>const R=${safeJson};
const RAW=R.observations||[],A=R.aggregates||[],O=A.length?A.map(o=>({...o,actualDetected:o.majority==='TRIGGERED',valid:o.majority!=='INVALID',detectionLatencyMs:o.medianLatencyMs})):RAW,G=R.geometry||{},FB=R.fixtureBounds||{},RS=R.radarSettings||{},RSA=RS.sensors?.A||{},RSB=RS.sensors?.B||{},RSS=RS.sensors?.SINGLE||{},RSL=RS.sensors?.LD021||{},RSLA=RS.sensors?.LD021_A||{},RSLB=RS.sensors?.LD021_B||{},activeRadar=R.activeTarget==='ld021_b'?RSLB:R.activeTarget==='ld021_a'||R.activeTarget==='ld021_pair'?RSLA:R.activeTarget==='ld021'?RSL:R.activeTarget==='single'?RSS:RSA,isFormal=['inside','outside','system'].includes(R.testId),isCharacterization=['characterization','interference'].includes(R.testId),singleSensor=G.sensorLayout!=='dual',showDutFootprint=Number(G.dut?.widthMm)>0&&Number(G.dut?.depthMm)>0,dualSystemBands=G.sensorLayout==='dual'&&G.geometrySemantics==='dual-sensor-system-distance-bands';
const DUT=singleSensor
  ? {x:Number.isFinite(+G.centerX)?+G.centerX:+G.singleSensor?.centerX,y:Number.isFinite(+G.centerY)?+G.centerY:+G.singleSensor?.centerY,label:'Sensor center'}
  : {x:+G.systemReference?.x,y:+G.systemReference?.y,label:'DUT center'},DB=G.dut?.bounds||{minX:DUT.x-131,maxX:DUT.x+131,minY:DUT.y-160,maxY:DUT.y+160};
const DUT_CORNERS=showDutFootprint?[{x:+DB.minX,y:+DB.minY},{x:+DB.maxX,y:+DB.minY},{x:+DB.maxX,y:+DB.maxY},{x:+DB.minX,y:+DB.maxY}]:[{x:DUT.x,y:DUT.y}];
const esc=v=>String(v??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
document.getElementById('meta').innerHTML=[['Run',R.runId],['DUT',R.dutId||'—'],['Test',R.testName||R.testId],['Duration',R.durationMs==null?'—':(R.durationMs/1000).toFixed(1)+' s'],['Qualification basis',R.qualificationBasis||'Individual sensor output'],['ERD requirements',(R.erdRequirementIds||[]).join(', ')||'—'],['Radar target',R.activeTarget||'dual'],['Radar gain',activeRadar.gainCode==null?'—':'0x'+Number(activeRadar.gainCode).toString(16).toUpperCase().padStart(2,'0')],['Sense threshold',activeRadar.threshold??'—'],['Radar settings',RS.verifiedPair?'Verified':'NOT VERIFIED'],['Result detail',R.reason||'—']].map(x=>'<div class="metric"><small>'+esc(x[0])+'</small><strong>'+esc(x[1])+'</strong></div>').join('');
const S=R.summary||{},C=S.counts||{},validRaw=RAW.filter(o=>o.valid!==false),countMetrics=isCharacterization?[['Total',S.total??O.length],['Triggered',validRaw.filter(o=>o.actualDetected===true).length],['Not triggered',validRaw.filter(o=>o.actualDetected===false).length],['Invalid',C.INVALID??0]]:[['Total',S.total??O.length],['TP',C.TP??0],['TN',C.TN??0],['FP',C.FP??0],['FN',C.FN??0],['Invalid',C.INVALID??0],['Correct',S.correctRate==null?'—':(S.correctRate*100).toFixed(1)+'%']];document.getElementById('counts').innerHTML=countMetrics.map(x=>'<div class="metric"><small>'+x[0]+'</small><strong>'+x[1]+'</strong></div>').join('');
/** Implements the frame operation for this module. */
function frame(id,xLabel,yLabel,right=24){const c=document.getElementById(id),q=c.getContext('2d'),density=c.width/1100,w=c.width/density,h=c.height/density,p={l:82,r:right,t:28,b:64};q.setTransform(density,0,0,density,0,0);q.clearRect(0,0,w,h);plotBackground(q,w,h);q.strokeStyle='#d9e2ec';q.fillStyle='#475569';q.font='600 16px system-ui';for(let i=0;i<=5;i++){let x=p.l+(w-p.l-p.r)*i/5,y=p.t+(h-p.t-p.b)*i/5;q.beginPath();q.moveTo(x,p.t);q.lineTo(x,h-p.b);q.stroke();q.beginPath();q.moveTo(p.l,y);q.lineTo(w-p.r,y);q.stroke()}q.fillText(xLabel,w/2-50,h-16);q.save();q.translate(22,h/2+50);q.rotate(-Math.PI/2);q.fillText(yLabel,0,0);q.restore();return{c,q,w,h,p}}
/** Implements the bounds operation for this module. */
function bounds(values,key){const a=values.concat(DUT_CORNERS).map(v=>+v[key]).filter(Number.isFinite);let lo=Math.min(...a),hi=Math.max(...a);if(!a.length)return[0,1];if(lo===hi){lo-=1;hi+=1}const d=(hi-lo)*.08;return[lo-d,hi+d]}
/** Paints a consistent, export-safe plot background. */
function plotBackground(q,w,h){q.fillStyle='#f8fafc';q.fillRect(0,0,w,h)}
/** Draws the selected 262 x 320 mm DUT at true XY scale. */
function drawDut(q,X,Y,label=true){const l=X(DB.minX),r=X(DB.maxX),t=Y(DB.maxY),b=Y(DB.minY),cx=X(DUT.x),cy=Y(DUT.y);q.save();if(!showDutFootprint){q.strokeStyle='#d97706';q.lineWidth=2;q.beginPath();q.moveTo(cx-7,cy);q.lineTo(cx+7,cy);q.moveTo(cx,cy-7);q.lineTo(cx,cy+7);q.stroke();if(label){q.fillStyle='#92400e';q.font='700 11px system-ui';q.textAlign='left';q.fillText('SENSOR',cx+9,cy-5)}q.restore();return}q.fillStyle='#f59e0b33';q.strokeStyle='#d97706';q.lineWidth=2;q.fillRect(Math.min(l,r),Math.min(t,b),Math.abs(r-l),Math.abs(b-t));q.strokeRect(Math.min(l,r),Math.min(t,b),Math.abs(r-l),Math.abs(t-b));q.strokeStyle='#0891b2';q.lineWidth=3;q.beginPath();q.moveTo(l,b);q.lineTo(r,b);q.stroke();q.strokeStyle='#0f172a';q.lineWidth=1.5;q.beginPath();q.moveTo(cx-5,cy);q.lineTo(cx+5,cy);q.moveTo(cx,cy-5);q.lineTo(cx,cy+5);q.stroke();if(label){q.fillStyle='#92400e';q.font='700 11px system-ui';q.textAlign='left';q.fillText('DUT',Math.min(l,r)+5,Math.min(t,b)-5)}q.restore()}
/** Draws a smooth closed curve through an unchanged set of boundary samples. */
function smoothClosedPath(q,points,X,Y){
  if(points.length<3)return;
  const mapped=points.map(point=>({x:X(point.x),y:Y(point.y)})),n=mapped.length;
  q.moveTo(mapped[0].x,mapped[0].y);
  for(let i=0;i<n;i++){const p0=mapped[(i-1+n)%n],p1=mapped[i],p2=mapped[(i+1)%n],p3=mapped[(i+2)%n],t=.18;q.bezierCurveTo(p1.x+(p2.x-p0.x)*t,p1.y+(p2.y-p0.y)*t,p2.x-(p3.x-p1.x)*t,p2.y-(p3.y-p1.y)*t,p2.x,p2.y)}
  q.closePath();
}
/** Draws the formal result map as a clean engineering plot. */
function spatialCredible(){
  const c=document.getElementById('spatial'),q=c.getContext('2d'),density=c.width/1200,w=c.width/density,h=c.height/density,p={l:76,r:260,t:92,b:62};
  const vals=(A.length?A:O).filter(o=>Number.isFinite(+o.x)&&Number.isFinite(+o.y));
  const shapes=(R.boundaryShapes&&R.boundaryShapes.length?R.boundaryShapes:[R.boundary||[]]).filter(shape=>shape.length);
  const fixtureCorners=dualSystemBands&&[FB.minX,FB.maxX,FB.minY,FB.maxY].every(Number.isFinite)?[{x:FB.minX,y:FB.minY},{x:FB.maxX,y:FB.maxY}]:[];
  const references=vals.concat(dualSystemBands?fixtureCorners:shapes.flat(),DUT_CORNERS);if(!vals.length)return;
  q.setTransform(density,0,0,density,0,0);q.clearRect(0,0,w,h);plotBackground(q,w,h);q.lineCap='round';q.lineJoin='round';
  const title=R.testId==='inside'?'Test 10.1 — Spatial Verification':R.testId==='outside'?'Test 10.2 — Spatial Verification':'System Level Bounds — Spatial Verification';
  q.fillStyle='#0f172a';q.font='800 22px system-ui';q.textAlign='left';q.fillText(title,p.l,34);
  q.fillStyle='#64748b';q.font='500 12px system-ui';q.fillText('Measured results at commanded X/Y positions · equal physical scale',p.l,56);
  q.strokeStyle='#e2e8f0';q.lineWidth=1;q.beginPath();q.moveTo(p.l,72);q.lineTo(w-28,72);q.stroke();
  let x0=Math.min(...references.map(v=>+v.x)),x1=Math.max(...references.map(v=>+v.x)),y0=Math.min(...references.map(v=>+v.y)),y1=Math.max(...references.map(v=>+v.y));
  const span=Math.max(1,x1-x0,y1-y0),pad=dualSystemBands?0:Math.max(12,span*.055),forwardViewExtensionMm=175;x0-=pad+forwardViewExtensionMm;x1+=pad+forwardViewExtensionMm;y0-=pad+forwardViewExtensionMm;y1+=pad;
  const aw=w-p.l-p.r,ah=h-p.t-p.b,scale=Math.min(aw/(x1-x0),ah/(y1-y0)),pw=(x1-x0)*scale,ph=(y1-y0)*scale,left=p.l+(aw-pw)/2,top=p.t+(ah-ph)/2;
  const X=x=>left+(x-x0)*scale,Y=y=>top+ph-(y-y0)*scale,nice=range=>{const rough=range/6,pow=10**Math.floor(Math.log10(rough)),n=rough/pow;return(n<=1?1:n<=2?2:n<=5?5:10)*pow};
  q.font='600 12px system-ui';q.lineWidth=.75;
  const xStep=nice(x1-x0),yStep=nice(y1-y0);
  for(let x=Math.ceil(x0/xStep)*xStep;x<=x1;x+=xStep){const px=X(x);q.strokeStyle='#e2e8f0';q.beginPath();q.moveTo(px,top);q.lineTo(px,top+ph);q.stroke();q.fillStyle='#64748b';q.textAlign='center';q.fillText(String(Math.round(x)),px,top+ph+22)}
  for(let y=Math.ceil(y0/yStep)*yStep;y<=y1;y+=yStep){const py=Y(y);q.strokeStyle='#e2e8f0';q.beginPath();q.moveTo(left,py);q.lineTo(left+pw,py);q.stroke();q.fillStyle='#64748b';q.textAlign='right';q.fillText(String(Math.round(y)),left-11,py+4)}
  q.fillStyle='#475569';q.font='700 12px system-ui';q.textAlign='left';q.fillText('Y position (mm)',left,top-12);q.textAlign='center';q.fillText('X position (mm)',left+pw/2,h-17);
  q.strokeStyle='#94a3b8';q.lineWidth=1;q.beginPath();q.moveTo(left,top);q.lineTo(left,top+ph);q.lineTo(left+pw,top+ph);q.stroke();
  if(dualSystemBands&&shapes.length>=2){q.save();q.beginPath();q.rect(left,top,pw,ph);q.clip();q.fillStyle='#ff496218';q.fillRect(left,top,pw,ph);[[shapes[1],'#9ca3af','#9ca3af33'],[shapes[0],'#00d879','#00d87933']].forEach(([shape,stroke,fill])=>{q.beginPath();smoothClosedPath(q,shape,X,Y);q.fillStyle=fill;q.fill();q.strokeStyle=stroke;q.lineWidth=2.25;q.stroke()});q.restore()}
  else shapes.forEach(shape=>{q.strokeStyle='#0369a1';q.lineWidth=2.25;q.beginPath();smoothClosedPath(q,shape,X,Y);q.stroke()});
  vals.forEach(o=>{const majority=o.majority||((o.actualDetected===true)?'TRIGGERED':(o.actualDetected===false)?'NOT_TRIGGERED':'INVALID'),good=['TP','TN'].includes(o.outcome),px=X(o.x),py=Y(o.y);q.lineWidth=1.75;if(majority==='INVALID'||o.valid===false){q.fillStyle='#64748b';q.strokeStyle='#ffffff';q.fillRect(px-5,py-5,10,10);q.strokeRect(px-5,py-5,10,10)}else if(good){q.fillStyle='#15803d';q.strokeStyle='#ffffff';q.beginPath();q.arc(px,py,5.5,0,Math.PI*2);q.fill();q.stroke()}else{q.strokeStyle='#c2413b';q.lineWidth=3;q.beginPath();q.moveTo(px-5,py-5);q.lineTo(px+5,py+5);q.moveTo(px+5,py-5);q.lineTo(px-5,py+5);q.stroke()}});
  drawDut(q,X,Y);
  const panelX=w-p.r+38,panelY=p.t+12;q.textAlign='left';q.fillStyle='#0f172a';q.font='800 13px system-ui';q.fillText('RESULT KEY',panelX,panelY);
  const item=(y,label,detail,draw)=>{draw(panelX+7,y-4);q.fillStyle='#1e293b';q.font='700 12px system-ui';q.fillText(label,panelX+24,y);q.fillStyle='#64748b';q.font='500 10px system-ui';q.fillText(detail,panelX+24,y+15)};
  item(panelY+34,'Pass','Expected result',(...a)=>{q.fillStyle='#15803d';q.beginPath();q.arc(...a,5.5,0,Math.PI*2);q.fill()});
  item(panelY+76,'Fail','Unexpected result',(x,y)=>{q.strokeStyle='#c2413b';q.lineWidth=3;q.beginPath();q.moveTo(x-5,y-5);q.lineTo(x+5,y+5);q.moveTo(x+5,y-5);q.lineTo(x-5,y+5);q.stroke()});
  item(panelY+118,'Specified boundary','Geometry reference',(x,y)=>{q.strokeStyle='#0369a1';q.lineWidth=2.5;q.beginPath();q.moveTo(x-7,y);q.lineTo(x+7,y);q.stroke()});
  q.strokeStyle='#e2e8f0';q.lineWidth=1;q.beginPath();q.moveTo(panelX,panelY+148);q.lineTo(w-30,panelY+148);q.stroke();
  q.fillStyle='#0f172a';q.font='800 13px system-ui';q.fillText(showDutFootprint?'DUT FOOTPRINT':'SINGLE SENSOR',panelX,panelY+180);
  q.fillStyle='#1e293b';q.font='700 12px system-ui';q.fillText(showDutFootprint?(G.dut?.name||'Selected DUT location'):'Stand-mounted sensor',panelX,panelY+207);q.fillStyle='#64748b';q.font='500 11px system-ui';q.fillText('Center X '+DUT.x+' mm · Y '+DUT.y+' mm',panelX,panelY+229);if(showDutFootprint){q.fillText('Width 262 mm · depth 320 mm',panelX,panelY+247);q.fillText('Cyan line identifies the front edge',panelX,panelY+265)}
  document.getElementById('spatial-title').textContent=title;
  document.getElementById('spatial-note').textContent=dualSystemBands?'Combined-system bands use distance from the nearest DUT edge: green requires detection through '+(G.requiredTriggerMm||304.8)+' mm; grey is optional and unscored through '+(G.requiredNoTriggerMm||609.6)+' mm; red requires no detection beyond that boundary. The DUT rectangle is drawn at true XY scale.':showDutFootprint?'Measured results and the selected DUT rectangle are shown at true XY scale.':'Measured results and the stand-mounted sensor at ('+DUT.x+', '+DUT.y+') are shown at true XY scale.';
}
/** Implements the spatial operation for this module. */
function spatial(){const f=frame('spatial','X (mm)','Y (mm)'),vals=O.filter(o=>Number.isFinite(+o.x)&&Number.isFinite(+o.y));if(!vals.length)return;let [x0,x1]=bounds(vals,'x'),[y0,y1]=bounds(vals,'y');const boundary=R.boundary||[];if(isFormal&&boundary.length){x0=Math.min(x0,...boundary.map(p=>p.x));x1=Math.max(x1,...boundary.map(p=>p.x));y0=Math.min(y0,...boundary.map(p=>p.y));y1=Math.max(y1,...boundary.map(p=>p.y))}const X=x=>f.p.l+(x-x0)/(x1-x0)*(f.w-f.p.l-f.p.r),Y=y=>f.h-f.p.b-(y-y0)/(y1-y0)*(f.h-f.p.t-f.p.b);if(isFormal&&boundary.length){f.q.strokeStyle='#20c8f5';f.q.lineWidth=3;f.q.beginPath();boundary.forEach((p,i)=>(i?f.q.lineTo(X(p.x),Y(p.y)):f.q.moveTo(X(p.x),Y(p.y))));f.q.closePath();f.q.stroke()}vals.forEach(o=>{const good=isCharacterization?o.actualDetected:['TP','TN'].includes(o.outcome),ungraded=o.outcome==='UNGRADED'||o.expectedDetected==null;f.q.fillStyle=o.valid===false||ungraded?'#75839a':good?'#00d879':'#ff4962';f.q.beginPath();f.q.arc(X(o.x),Y(o.y),5,0,Math.PI*2);f.q.fill()});document.getElementById('spatial-title').textContent=isFormal?(R.testId==='inside'?'Test 10.1 — Inside Shape Results':R.testId==='outside'?'Test 10.2 — Outside Shape Results':'System Level Bounds — Spatial Results'):'Characterization — Raw Trigger Results';document.getElementById('spatial-note').textContent=isFormal?'Cyan line is the configured shape under test. Green is correct; red is incorrect; grey is ungraded.':'No estimated boundary is drawn. Green points triggered; red points did not trigger; gray points are invalid.'}
/** Implements the spatial to scale operation for this module. */
function spatialToScale(){const c=document.getElementById('spatial'),q=c.getContext('2d'),w=c.width,h=c.height,p={l:72,r:28,t:24,b:54},vals=(A.length?A:O).filter(o=>Number.isFinite(+o.x)&&Number.isFinite(+o.y)),boundary=R.boundary||[],all=vals.concat(isFormal?boundary:[]);q.clearRect(0,0,w,h);if(!all.length)return;let x0=Math.min(...all.map(v=>+v.x)),x1=Math.max(...all.map(v=>+v.x)),y0=Math.min(...all.map(v=>+v.y)),y1=Math.max(...all.map(v=>+v.y));const rawW=Math.max(1,x1-x0),rawH=Math.max(1,y1-y0),pad=Math.max(10,Math.max(rawW,rawH)*.06);x0-=pad;x1+=pad;y0-=pad;y1+=pad;const availableW=w-p.l-p.r,availableH=h-p.t-p.b,scale=Math.min(availableW/(x1-x0),availableH/(y1-y0)),plotW=(x1-x0)*scale,plotH=(y1-y0)*scale,left=p.l+(availableW-plotW)/2,top=p.t+(availableH-plotH)/2,X=x=>left+(x-x0)*scale,Y=y=>top+plotH-(y-y0)*scale,niceStep=span=>{const rough=span/6,pow=Math.pow(10,Math.floor(Math.log10(rough))),n=rough/pow;return(n<=1?1:n<=2?2:n<=5?5:10)*pow},xStep=niceStep(x1-x0),yStep=niceStep(y1-y0);q.font='12px system-ui';q.strokeStyle='#26364e';q.fillStyle='#aab8cb';q.lineWidth=1;for(let x=Math.ceil(x0/xStep)*xStep;x<=x1+.0001;x+=xStep){const px=X(x);q.beginPath();q.moveTo(px,top);q.lineTo(px,top+plotH);q.stroke();q.fillText(String(Math.round(x*100)/100),px-14,top+plotH+20)}for(let y=Math.ceil(y0/yStep)*yStep;y<=y1+.0001;y+=yStep){const py=Y(y);q.beginPath();q.moveTo(left,py);q.lineTo(left+plotW,py);q.stroke();q.fillText(String(Math.round(y*100)/100),left-48,py+4)}q.strokeStyle='#607089';q.strokeRect(left,top,plotW,plotH);q.fillStyle='#aab8cb';q.fillText('X position (mm)',left+plotW/2-42,h-12);q.save();q.translate(16,top+plotH/2+38);q.rotate(-Math.PI/2);q.fillText('Y position (mm)',0,0);q.restore();if(isFormal&&boundary.length){q.strokeStyle='#20c8f5';q.lineWidth=3;q.beginPath();boundary.forEach((point,index)=>(index?q.lineTo(X(point.x),Y(point.y)):q.moveTo(X(point.x),Y(point.y))));q.closePath();q.stroke()}vals.forEach(o=>{const majority=o.majority||((o.actualDetected===true)?'TRIGGERED':(o.actualDetected===false)?'NOT_TRIGGERED':'INVALID'),good=R.testId==='characterization'?majority==='TRIGGERED':['TP','TN'].includes(o.outcome),ungraded=o.outcome==='UNGRADED'||o.expectedDetected==null;q.fillStyle=majority==='TIE'?'#ffd166':majority==='INVALID'||o.valid===false||ungraded?'#75839a':good?'#00d879':'#ff4962';q.beginPath();q.arc(X(o.x),Y(o.y),5,0,Math.PI*2);q.fill();if(o.complete===false){q.strokeStyle='#ffd166';q.lineWidth=2;q.beginPath();q.arc(X(o.x),Y(o.y),9,0,Math.PI*2);q.stroke()}});document.getElementById('spatial-title').textContent=isFormal?(R.testId==='inside'?'Test 10.1 — Majority Results':R.testId==='outside'?'Test 10.2 — Majority Results':'System Level Bounds — Majority Results'):'Characterization — Majority Trigger Results';document.getElementById('spatial-note').textContent=(isFormal?'Cyan line is the configured shape. Each marker is the valid-cycle majority at that point; green is correct, red is incorrect, grey is ungraded, and amber is tied/incomplete.':'Each marker summarizes all valid cycles at that point. Green is majority triggered, red is majority not triggered, amber is tied/incomplete, and gray is invalid.')+' X and Y use equal linear scaling, preserving physical proportions.'}
/** Draws the non-interpolated five-cycle repeatability scatter plot and wires hover/PNG export. */
function repeatability(){
  const c=document.getElementById('repeatability');if(!c)return;
  const q=c.getContext('2d'),density=c.width/1100,w=c.width/density,h=c.height/density,p={l:88,r:270,t:32,b:74};
  q.setTransform(density,0,0,density,0,0);q.clearRect(0,0,w,h);
  const pts=A.filter(o=>Number.isFinite(+o.x)&&Number.isFinite(+o.y));
  const planned=Math.max(1,Math.floor(Number(R.cyclesPlanned)||Number(A[0]?.cyclesPlanned)||1));
  const palette=['#7f1d1d','#ef4444','#f59e0b','#fde047','#86efac','#166534'];
  const colorFor=count=>palette[Math.max(0,Math.min(5,Math.round((count/planned)*5)))];
  const labels=Array.from({length:planned+1},(_,count)=>count+' out of '+planned+' triggers');
  if(!pts.length)return;
  const graphPoints=pts.concat(DUT_CORNERS);let x0=Math.min(...graphPoints.map(o=>+o.x)),x1=Math.max(...graphPoints.map(o=>+o.x)),y0=Math.min(...graphPoints.map(o=>+o.y)),y1=Math.max(...graphPoints.map(o=>+o.y));
  const rawW=Math.max(1,x1-x0),rawH=Math.max(1,y1-y0),margin=Math.max(10,Math.max(rawW,rawH)*.06);x0-=margin;x1+=margin;y0-=margin;y1+=margin;
  const availableW=w-p.l-p.r,availableH=h-p.t-p.b,scale=Math.min(availableW/(x1-x0),availableH/(y1-y0)),plotW=(x1-x0)*scale,plotH=(y1-y0)*scale,left=p.l+(availableW-plotW)/2,top=p.t+(availableH-plotH)/2;
  const X=x=>left+(x-x0)*scale,Y=y=>top+plotH-(y-y0)*scale,niceStep=span=>{const rough=span/6,pow=Math.pow(10,Math.floor(Math.log10(rough))),n=rough/pow;return(n<=1?1:n<=2?2:n<=5?5:10)*pow};
  q.font='600 16px system-ui';q.lineWidth=1.25;
  const xStep=niceStep(x1-x0),yStep=niceStep(y1-y0);
  for(let x=Math.ceil(x0/xStep)*xStep;x<=x1+.0001;x+=xStep){const px=X(x);q.strokeStyle='#26364e';q.beginPath();q.moveTo(px,top);q.lineTo(px,top+plotH);q.stroke();q.fillStyle='#aab8cb';q.fillText(String(Math.round(x*100)/100),px-14,top+plotH+22)}
  for(let y=Math.ceil(y0/yStep)*yStep;y<=y1+.0001;y+=yStep){const py=Y(y);q.strokeStyle='#26364e';q.beginPath();q.moveTo(left,py);q.lineTo(left+plotW,py);q.stroke();q.fillStyle='#aab8cb';q.fillText(String(Math.round(y*100)/100),left-50,py+4)}
  q.strokeStyle='#607089';q.strokeRect(left,top,plotW,plotH);q.fillStyle='#aab8cb';q.fillText('X position (mm)',left+plotW/2-58,h-18);q.save();q.translate(23,top+plotH/2+48);q.rotate(-Math.PI/2);q.fillText('Y position (mm)',0,0);q.restore();
  const hits=[];pts.forEach(o=>{const count=Math.max(0,Math.min(planned,Number(o.triggeredCount)||0)),px=X(+o.x),py=Y(+o.y);q.fillStyle=colorFor(count);q.strokeStyle='#e8eef8';q.lineWidth=2;q.beginPath();q.arc(px,py,9,0,Math.PI*2);q.fill();q.stroke();hits.push({px,py,o,count})});
  drawDut(q,X,Y);const legendX=w-p.r+34,legendStep=Math.min(42,Math.max(22,(plotH-20)/Math.max(1,planned)));labels.slice().reverse().forEach((label,index)=>{const count=planned-index,y=top+12+index*legendStep;q.fillStyle=colorFor(count);q.beginPath();q.arc(legendX,y,Math.min(10,legendStep*.3),0,Math.PI*2);q.fill();q.fillStyle='#dce6f5';q.fillText(label,legendX+22,y+5)});
  const counts=Array(planned+1).fill(0);pts.forEach(o=>{counts[Math.max(0,Math.min(planned,Number(o.triggeredCount)||0))]++});
  document.getElementById('repeatability-summary').innerHTML='<thead><tr><th>Trigger count</th><th>Percentage of cycles triggered</th><th>Tested positions</th></tr></thead><tbody>'+counts.map((positions,count)=>'<tr><td>'+count+' of '+planned+'</td><td>'+((count/planned)*100).toFixed(1)+'%</td><td>'+positions+'</td></tr>').join('')+'</tbody>';
  const tip=document.getElementById('repeatability-tooltip');
  c.addEventListener('mousemove',event=>{const rect=c.getBoundingClientRect(),mx=(event.clientX-rect.left)*w/rect.width,my=(event.clientY-rect.top)*h/rect.height,hit=hits.find(item=>Math.hypot(item.px-mx,item.py-my)<=12);if(!hit){tip.style.display='none';return}const o=hit.o;tip.innerHTML='<strong>Point '+esc(o.pointId||'')+'</strong><br>X: '+esc(o.x)+' mm<br>Y: '+esc(o.y)+' mm<br>Triggered: '+hit.count+' of '+planned+' cycles<br>Trigger rate: '+((hit.count/planned)*100).toFixed(1)+'%<br>Valid cycles: '+esc(o.validCount??0)+' of '+planned;tip.style.display='block';tip.style.left=Math.min(event.clientX-rect.left+14,rect.width-220)+'px';tip.style.top=Math.max(8,event.clientY-rect.top-34)+'px'});
  c.addEventListener('mouseleave',()=>{tip.style.display='none'});
  document.getElementById('download-repeatability').addEventListener('click',()=>{const a=document.createElement('a'),folder=String(R.runFolderName||'radar-run').replace(/[<>:"/\\\\|?*]+/g,'-').replace(/[. ]+$/g,'');a.download=folder+'_repeatability.png';a.href=c.toDataURL('image/png');a.click()});
}

/** Implements the latency operation for this module. */
function latency(){const f=frame('latency','X position (mm)','Y position (mm)',130),raw=O.filter(o=>o.actualDetected&&o.valid!==false&&Number.isFinite(+o.x)&&Number.isFinite(+o.y)&&Number.isFinite(+o.detectionLatencyMs));if(raw.length<3){f.q.fillStyle='#8fa0b8';f.q.fillText('At least three triggered latency measurements are required.',90,80);return}const cross=(a,b,c)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x),pts=raw.map(o=>({x:+o.x,y:+o.y})).sort((a,b)=>a.x-b.x||a.y-b.y),lower=[],upper=[];pts.forEach(p=>{while(lower.length>1&&cross(lower[lower.length-2],lower[lower.length-1],p)<=0)lower.pop();lower.push(p)});pts.slice().reverse().forEach(p=>{while(upper.length>1&&cross(upper[upper.length-2],upper[upper.length-1],p)<=0)upper.pop();upper.push(p)});const hull=lower.slice(0,-1).concat(upper.slice(0,-1)),inside=(x,y)=>{let hit=false;for(let i=0,j=hull.length-1;i<hull.length;j=i++){const a=hull[i],b=hull[j];if(((a.y>y)!=(b.y>y))&&(x<(b.x-a.x)*(y-a.y)/(b.y-a.y)+a.x))hit=!hit}return hit};const robust=raw.map(o=>{const nearest=raw.filter(v=>v!==o).sort((a,b)=>Math.hypot(a.x-o.x,a.y-o.y)-Math.hypot(b.x-o.x,b.y-o.y)).slice(0,8).map(v=>+v.detectionLatencyMs).sort((a,b)=>a-b),med=nearest[Math.floor(nearest.length/2)],dev=nearest.map(v=>Math.abs(v-med)).sort((a,b)=>a-b),mad=dev[Math.floor(dev.length/2)]||1,val=+o.detectionLatencyMs;return{x:+o.x,y:+o.y,z:Math.abs(val-med)>3*mad?med:val,raw:val}});let[x0,x1]=bounds(robust,'x'),[y0,y1]=bounds(robust,'y');const plotW=f.w-f.p.l-f.p.r,plotH=f.h-f.p.t-f.p.b,plotAspect=plotW/plotH,dataAspect=(x1-x0)/(y1-y0);if(dataAspect>plotAspect){const target=(x1-x0)/plotAspect,mid=(y0+y1)/2;y0=mid-target/2;y1=mid+target/2}else{const target=(y1-y0)*plotAspect,mid=(x0+x1)/2;x0=mid-target/2;x1=mid+target/2}const zs=robust.map(p=>p.z).sort((a,b)=>a-b),z0=zs[Math.floor(zs.length*.05)],z1=zs[Math.min(zs.length-1,Math.floor(zs.length*.95))];if(z0===z1)z1=z0+1;const X=x=>f.p.l+(x-x0)/(x1-x0)*(f.w-f.p.l-f.p.r),Y=y=>f.h-f.p.b-(y-y0)/(y1-y0)*(f.h-f.p.t-f.p.b),IX=x=>x0+(x-f.p.l)/(f.w-f.p.l-f.p.r)*(x1-x0),IY=y=>y1-(y-f.p.t)/(f.h-f.p.t-f.p.b)*(y1-y0),palette=[[68,1,84],[59,82,139],[33,145,140],[94,201,98],[253,231,37]],color=value=>{let t=Math.max(0,Math.min(1,(value-z0)/(z1-z0)))*(palette.length-1),i=Math.min(palette.length-2,Math.floor(t)),u=t-i,a=palette[i],b=palette[i+1];return'rgb('+a.map((v,k)=>Math.round(v+(b[k]-v)*u)).join(',')+')'},estimate=(x,y)=>{const near=robust.map(p=>({p,d:Math.hypot(p.x-x,p.y-y)})).sort((a,b)=>a.d-b.d).slice(0,12);if(near[0].d<.001)return near[0].p.z;let total=0,weight=0;near.forEach(n=>{const w=1/Math.pow(n.d,2);total+=n.p.z*w;weight+=w});return total/weight};for(let py=f.p.t;py<f.h-f.p.b;py+=4)for(let px=f.p.l;px<f.w-f.p.r;px+=4){const x=IX(px),y=IY(py);if(inside(x,y)){f.q.fillStyle=color(estimate(x,y));f.q.fillRect(px,py,5,5)}}f.q.strokeStyle='rgba(8,18,30,.22)';f.q.lineWidth=1;for(let i=0;i<=5;i++){const px=f.p.l+(f.w-f.p.l-f.p.r)*i/5,py=f.p.t+(f.h-f.p.t-f.p.b)*i/5;f.q.beginPath();f.q.moveTo(px,f.p.t);f.q.lineTo(px,f.h-f.p.b);f.q.stroke();f.q.beginPath();f.q.moveTo(f.p.l,py);f.q.lineTo(f.w-f.p.r,py);f.q.stroke();f.q.fillStyle='#c5cfdd';f.q.fillText((x0+(x1-x0)*i/5).toFixed(0),px-12,f.h-f.p.b+20);f.q.fillText((y1-(y1-y0)*i/5).toFixed(0),20,py+4)}f.q.strokeStyle='#35b8a6';f.q.lineWidth=2;f.q.beginPath();hull.forEach((p,i)=>(i?f.q.lineTo(X(p.x),Y(p.y)):f.q.moveTo(X(p.x),Y(p.y))));f.q.closePath();f.q.stroke();const lx=f.w-78,ly=f.p.t,lh=f.h-f.p.t-f.p.b,grad=f.q.createLinearGradient(0,ly+lh,0,ly);palette.forEach((c,i)=>grad.addColorStop(i/(palette.length-1),'rgb('+c.join(',')+')'));f.q.fillStyle=grad;f.q.fillRect(lx,ly,28,lh);f.q.strokeStyle='#c5cfdd';f.q.strokeRect(lx,ly,28,lh);f.q.fillStyle='#c5cfdd';for(let i=0;i<=5;i++){const value=z1-(z1-z0)*i/5,y=ly+lh*i/5;f.q.fillText(value.toFixed(0),lx+38,y+4)}f.q.save();f.q.translate(f.w-8,f.h/2);f.q.rotate(-Math.PI/2);f.q.fillText('Latency (ms)',0,0);f.q.restore()}
/** Overlays traceable measured samples and the non-data DUT reference. */
function latencyReferences(){
  const c=document.getElementById('latency');if(!c)return;
  const raw=O.filter(o=>o.actualDetected&&o.valid!==false&&Number.isFinite(+o.x)&&Number.isFinite(+o.y)&&Number.isFinite(+o.detectionLatencyMs));if(raw.length<3)return;
  const q=c.getContext('2d'),density=c.width/1100,w=c.width/density,h=c.height/density,p={l:82,r:130,t:28,b:64};q.setTransform(density,0,0,density,0,0);
  let[x0,x1]=bounds(raw,'x'),[y0,y1]=bounds(raw,'y');const pw=w-p.l-p.r,ph=h-p.t-p.b,plotAspect=pw/ph,dataAspect=(x1-x0)/(y1-y0);
  if(dataAspect>plotAspect){const target=(x1-x0)/plotAspect,mid=(y0+y1)/2;y0=mid-target/2;y1=mid+target/2}else{const target=(y1-y0)*plotAspect,mid=(x0+x1)/2;x0=mid-target/2;x1=mid+target/2}
  const X=x=>p.l+(x-x0)/(x1-x0)*pw,Y=y=>h-p.b-(y-y0)/(y1-y0)*ph;
  raw.forEach(o=>{q.fillStyle='#ffffff';q.strokeStyle='#0f172a';q.lineWidth=1.5;q.beginPath();q.arc(X(+o.x),Y(+o.y),4.5,0,Math.PI*2);q.fill();q.stroke()});
  if(showDutFootprint){const l=X(DB.minX),r=X(DB.maxX),t=Y(DB.maxY),b=Y(DB.minY);q.fillStyle='#f8fafc';q.fillRect(Math.min(l,r),Math.min(t,b),Math.abs(r-l),Math.abs(b-t))}
  drawDut(q,X,Y);
  q.fillStyle='#1e293b';q.font='700 13px system-ui';q.textAlign='left';q.fillText('○ measured sample',p.l+12,p.t+20);
}
/** Implements the table operation for this module. */
function table(){const columns=isCharacterization?[['timestamp','Timestamp'],['cycleNumber','Cycle'],['pointId','Point'],['x','X (mm)'],['y','Y (mm)'],...(R.testId==='interference'?[['triggeredSensors','Sensor output']]:[]),['actualDetected','Triggered'],['detectionLatencyMs','Latency (ms)'],['valid','Valid']]:[['timestamp','Timestamp'],['cycleNumber','Cycle'],['pointId','Point'],['x','X (mm)'],['y','Y (mm)'],['distanceMm','Distance (mm)'],['expectedDetected','Expected'],['actualDetected','Triggered'],['outcome','Result'],['detectionLatencyMs','Latency (ms)'],['valid','Valid']];document.getElementById('observations').innerHTML='<thead><tr>'+columns.map(c=>'<th>'+c[1]+'</th>').join('')+'</tr></thead><tbody>'+RAW.map(o=>'<tr>'+columns.map(c=>'<td>'+esc(o[c[0]])+'</td>').join('')+'</tr>').join('')+'</tbody>'}
if(isCharacterization){repeatability();if(R.testId==='interference')spatial()}else{spatialCredible()}if(R.testId!=='outside'){latency();latencyReferences()}table();</script></main></body></html>`;
}

/** Creates the run folder and opens its CSV, manifest, summary, and report paths. */

/** Renders the completed report offscreen and saves its exact graph canvases. */
async function exportReportGraphImages(htmlPath, outputDirectory) {
  if (!htmlPath || !fs.existsSync(htmlPath) || !outputDirectory) return {};
  const graphWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  try {
    await graphWindow.loadFile(htmlPath);
    const dataUrls = await graphWindow.webContents.executeJavaScript(`
      new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
        const prepareForSheets = (canvas) => {
          if (!canvas) return;
          const context = canvas.getContext('2d');
          context.save();
          context.globalCompositeOperation = 'destination-over';
          context.fillStyle = '#ffffff';
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.restore();
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
          for (let index = 0; index < pixels.data.length; index += 4) {
            const red = pixels.data[index], green = pixels.data[index + 1], blue = pixels.data[index + 2];
            if (
              red > 125
              && green > 135
              && blue > 145
              && blue - red >= 12
              && blue - green >= 5
            ) {
              pixels.data[index] = 31;
              pixels.data[index + 1] = 50;
              pixels.data[index + 2] = 64;
            }
          }
          context.putImageData(pixels, 0, 0);
        };
        const image = (id) => {
          const canvas = document.getElementById(id);
          prepareForSheets(canvas);
          return canvas ? canvas.toDataURL('image/png') : '';
        };
        // Sheets calls its first graph "repeatability" for historical reasons.
        // Formal tests use the spatial canvas; keep the payload key compatible
        // with already-deployed campaign workbooks.
        resolve({ repeatability: image('repeatability') || image('spatial'), latency: image('latency') });
      })))
    `);
    const result = {};
    for (const [name, dataUrl] of Object.entries(dataUrls || {})) {
      if (!dataUrl) continue;
      const image = nativeImage.createFromDataURL(dataUrl);
      if (image.isEmpty()) continue;
      const filePath = path.join(outputDirectory, `${name}.png`);
      const sheetImage = image.getSize().width > 1300 ? image.resize({ width: 1300, quality: 'best' }) : image;
      fs.writeFileSync(filePath, sheetImage.toPNG());
      result[name] = filePath;
    }
    return result;
  } finally {
    if (!graphWindow.isDestroyed()) graphWindow.destroy();
  }
}

/** Opens the files used by a new run. */
function openLogFile(manifest = {}) {
  const docsDir = app.getPath('documents');
  const logsDir = path.join(docsDir, 'Radar Validation Logs');
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

  activeLogMeta = buildLogNameMetadata(manifest);
  const categoryDirectory = path.join(logsDir, activeLogMeta.category);
  const inProgressDirectory = path.join(categoryDirectory, '_in_progress');
  const baseName = RunNamingCore.uniqueRunBase(activeLogMeta.baseName, (candidate) => (
    fs.existsSync(path.join(categoryDirectory, candidate))
    || fs.existsSync(path.join(inProgressDirectory, candidate))
  ));
  activeLogMeta.baseName = baseName;
  runDirectory = path.join(inProgressDirectory, baseName);
  fs.mkdirSync(runDirectory, { recursive: true });
  if (runController.isActive()) runController.transition('preflight', { runDirectory });
  logPath = path.join(runDirectory, 'observations.csv');
  manifestPath = path.join(runDirectory, 'manifest.json');
  summaryPath = path.join(runDirectory, 'summary.json');
  reportPath = path.join(runDirectory, 'report.html');
  radarSettingsPath = path.join(runDirectory, 'radar-settings.json');

  logStream = fs.createWriteStream(logPath, { flags: 'a' });
  logStream.on('error', (error) => { logWriteFailure = error; });
  logWriteQueue = Promise.resolve();
  logWriteFailure = null;

  const header = [
    'Timestamp','ElapsedMs','RunId','TestId','TestVersion','DUTIdentifier','CycleNumber',
    'PointId','PositionIndex','AttemptNumber','X','Y','Z','DistanceMm','Zone',
    // Independent A/B diagnostics and the combined qualification result are all retained.
    // 'RadarAActualDetected','RadarBActualDetected','CombinedDetectionRule'
    'ExpectedDetected','ActualDetected','TriggeredSensors','RadarAActualDetected','RadarBActualDetected','SingleRadarActualDetected','LD021AActualDetected','LD021BActualDetected','LD021ARisingEdgeMs','LD021AFallingEdgeMs','LD021BRisingEdgeMs','LD021BFallingEdgeMs','TestPhase','LD021APowerState','LD021BPowerState','ActiveRadarTarget','CombinedDetectionRule',
    'Outcome','Valid','InvalidReason','CoveragePartition','Event',
    'MoveDurationMs','TriggerSentMs','DetectionLatencyMs','DefinitionFile','SoftwareRevision',
    'RadarGainCode','RadarThreshold','RadarSettingsVerified','Notes',
  ].join(',') + '\n';

  logStream.write(header);
  atomicWriteJson(manifestPath, {
    schemaVersion: 2,
    startedAt: new Date(testStartMs).toISOString(),
    softwareRevision: app.getVersion(),
    ...manifest,
  });
  atomicWriteJson(radarSettingsPath, manifest.radarSettings || {
    capturedAt: new Date(testStartMs).toISOString(), verifiedPair: false, error: 'Settings were not captured',
  });

  if (mainWindow) mainWindow.webContents.send('log:path', logPath);
  return logPath;
}

ipcMain.handle('log:start', (_, manifest) => {
  if (!qualificationRunAuthorized) return { success: false, error: 'Run logging blocked: qualification run is not authorized' };
  testStartMs = Date.now();
  return { success: true, path: openLogFile(manifest) };
});

ipcMain.handle('log:write', async (_, row) => {
  if (!logStream || !config.logging.enabled) return { success: false, error: 'Run log is not open' };
  if (logWriteFailure) return { success: false, error: logWriteFailure.message };

  const ts = new Date().toISOString();
  const elapsed = Date.now() - testStartMs;

  const csv = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const bool = (value) => value === true ? 'true' : value === false ? 'false' : '';
  const runRadarSettings = activeLogMeta?.manifest?.radarSettings || {};
  const runRadarA = runRadarSettings.sensors?.A || {};
  const runRadarSingle = runRadarSettings.sensors?.SINGLE || {};
  const runRadarLD021 = runRadarSettings.sensors?.LD021 || {};
  const runRadarLD021A = runRadarSettings.sensors?.LD021_A || {};
  const runRadarLD021B = runRadarSettings.sensors?.LD021_B || {};
  const activeRadar = runRadarSettings.activeTarget === 'ld021_pair' ? runRadarLD021A
    : runRadarSettings.activeTarget === 'ld021_a' ? runRadarLD021A
    : runRadarSettings.activeTarget === 'ld021_b' ? runRadarLD021B
    : runRadarSettings.activeTarget === 'ld021' ? runRadarLD021
    : runRadarSettings.activeTarget === 'single' ? runRadarSingle : runRadarA;
  const values = [
    csv(row.timestamp || ts),
    elapsed,
    csv(row.runId),
    csv(row.testId || config.test?.mode),
    row.testVersion ?? '',
    csv(row.dutId || config.test?.dutId),
    row.cycleNumber ?? config.test?.cycleNumber ?? '',
    csv(row.pointId),
    row.positionIndex ?? row.idx ?? '',
    row.attemptNumber ?? '',
    row.x ?? '',
    row.y ?? '',
    row.z ?? '',
    row.distanceMm ?? '',
    csv(row.zone),
    bool(row.expectedDetected),
    bool(row.actualDetected ?? row.detected),
    csv(row.triggeredSensors),
    bool(row.radarAActualDetected),
    bool(row.radarBActualDetected),
    bool(row.singleRadarActualDetected),
    bool(row.ld021AActualDetected),
    bool(row.ld021BActualDetected),
    row.ld021ARisingEdgeMs ?? '', row.ld021AFallingEdgeMs ?? '', row.ld021BRisingEdgeMs ?? '', row.ld021BFallingEdgeMs ?? '',
    csv(row.testPhase), csv(row.powerAState), csv(row.powerBState),
    csv(runRadarSettings.activeTarget || config.validation?.sensorLayout || 'dual'),
    csv(row.combinedDetectionRule),
    csv(row.outcome),
    bool(row.valid),
    csv(row.invalidReason),
    csv(row.coveragePartition),
    csv(row.event),
    row.moveDurationMs ?? '',
    row.triggerSentMs ?? '',
    row.detectionLatencyMs ?? '',
    csv(config.test?.definitionFile),
    csv(app.getVersion()),
    csv(activeRadar.gainCode == null ? '' : RadarSettingsCore.formatGainCode(activeRadar.gainCode)),
    activeRadar.threshold ?? '',
    bool(runRadarSettings.verifiedPair),
    csv(row.notes),
  ];

  const line = values.join(',') + '\n';
  logWriteQueue = logWriteQueue.then(() => new Promise((resolve, reject) => {
    logStream.write(line, 'utf8', (error) => error ? reject(error) : resolve());
  })).catch((error) => {
    logWriteFailure = error instanceof Error ? error : new Error(String(error));
    throw logWriteFailure;
  });
  try {
    await logWriteQueue;
    return { success: true };
  } catch (error) {
    return { success: false, error: error?.message || String(error) };
  }
});


ipcMain.handle('log:close', async (_, payload) => {
  qualificationRunAuthorized = false;
  try {
    await logWriteQueue;
  } catch (error) {
    return { success: false, error: `Observation log write failed: ${error?.message || error}` };
  }
  if (logStream) {
    const stream = logStream;
    logStream = null;
    await new Promise((resolve) => stream.end(resolve));
  }
  const completedAt = new Date().toISOString();
  const summary = payload?.summary || payload;
  const finalizationPath = runDirectory ? path.join(runDirectory, 'finalization.json') : '';
  if (finalizationPath) atomicWriteJson(finalizationPath, { schemaVersion: 1, phase: 'preparing', updatedAt: completedAt });
  if (summaryPath && summary) atomicWriteJson(summaryPath, { completedAt, ...summary });
  if (reportPath && payload?.report) atomicWriteFile(reportPath, buildReportHtml({
    completedAt,
    ...payload.report,
    summary,
    runFolderName: activeLogMeta?.baseName || '',
  }));
  if (finalizationPath) atomicWriteJson(finalizationPath, { schemaVersion: 1, phase: 'artifacts-ready', updatedAt: new Date().toISOString() });
  let campaignResult = null;
  if (activeLogMeta && runDirectory) {
    const result = payload?.report?.result || (summary?.accepted === true ? 'pass' : summary?.accepted === false ? 'fail' : 'complete');
    const finalBase = completedRunBase(activeLogMeta);
    const finalDirectory = path.join(path.dirname(path.dirname(runDirectory)), finalBase);
    const currentPaths = { csv: logPath, manifest: manifestPath, summary: summaryPath, report: reportPath, radarSettings: radarSettingsPath };
    const renamedPaths = {
      csv: path.join(runDirectory, 'observations.csv'),
      manifest: path.join(runDirectory, 'manifest.json'),
      summary: path.join(runDirectory, 'summary.json'),
      report: path.join(runDirectory, 'report.html'),
      radarSettings: path.join(runDirectory, 'radar-settings.json'),
    };
    Object.keys(currentPaths).forEach((key) => {
      if (currentPaths[key] && renamedPaths[key] && path.resolve(currentPaths[key]) !== path.resolve(renamedPaths[key]) && fs.existsSync(currentPaths[key])) {
        fs.renameSync(currentPaths[key], renamedPaths[key]);
      }
    });
    if (fs.existsSync(renamedPaths.manifest)) {
      const manifest = JSON.parse(fs.readFileSync(renamedPaths.manifest, 'utf8'));
      atomicWriteJson(renamedPaths.manifest, { ...manifest, completedAt, result: String(result).toUpperCase(), finalRunName: finalBase });
    }
    await renameWithRetry(runDirectory, finalDirectory);
    runDirectory = finalDirectory;
    logPath = path.join(finalDirectory, path.basename(renamedPaths.csv));
    manifestPath = path.join(finalDirectory, path.basename(renamedPaths.manifest));
    summaryPath = path.join(finalDirectory, path.basename(renamedPaths.summary));
    reportPath = path.join(finalDirectory, path.basename(renamedPaths.report));
    radarSettingsPath = path.join(finalDirectory, path.basename(renamedPaths.radarSettings));
    atomicWriteJson(path.join(finalDirectory, 'finalization.json'), {
      schemaVersion: 1, phase: 'finalized', completedAt, result: String(result).toUpperCase(),
    });
    if (mainWindow) mainWindow.webContents.send('log:path', logPath);
    activeLogMeta = null;
  }
  if (payload?.report?.testId && runDirectory && config.campaign?.active) {
    try {
      const campaignId = config.campaign.active.id;
      campaignResult = CampaignLedger.recordCampaign(logsDirectory(), {
        campaignId,
        report: payload.report,
        completedAt,
        reportFolder: runDirectory,
      });
      campaignResult.localComplete = true;
      campaignBackgroundState = {
        phase: 'complete',
        campaignId,
        message: 'Saved locally to report.html and observations.csv',
        error: '',
        updatedAt: new Date().toISOString(),
      };
    } catch (error) {
      campaignResult = { error: String(error?.message || error) };
    }
  }
  if (runController.isActive() || runController.snapshot()?.status === 'faulted') {
    const reportResult = String(payload?.report?.result || '').toUpperCase();
    const terminalStatus = ['PASS', 'COMPLETE'].includes(reportResult) ? 'complete'
      : runController.snapshot()?.status === 'abort_requested' ? 'aborted' : 'failed';
    runController.finish(terminalStatus, payload?.report?.reason || reportResult || 'Run finalized', { reportPath, runDirectory });
  }
  return { success: true, reportPath, runDirectory, campaign: campaignResult };
});

ipcMain.handle('campaign:status', () => {
  return {
    success: true,
    ...CampaignManager.status(logsDirectory(), config.campaign?.active),
    background: { ...campaignBackgroundState },
  };
});

ipcMain.handle('campaign:start', async (_, input = {}) => {
  try {
    const contract = contractResult('campaign:write', input);
    if (!contract.success) return contract;
    input = contract.value;
    if (config.campaign?.active) return { success: false, error: 'Close the active campaign before starting another' };
    const campaign = CampaignManager.createCampaign(input);
    config.campaign = { ...(config.campaign || {}), active: campaign, archived: config.campaign?.archived || [] };
    saveConfig(config);
    CampaignLedger.ensureLedger(logsDirectory(), campaign.id);
    return { success: true, ...CampaignManager.status(logsDirectory(), campaign) };
  } catch (error) {
    return { success: false, error: String(error?.message || error) };
  }
});

ipcMain.handle('campaign:update', async (_, input = {}) => {
  try {
    const contract = contractResult('campaign:write', input);
    if (!contract.success) return contract;
    input = contract.value;
    const active = config.campaign?.active;
    if (!active) return { success: false, error: 'No active campaign' };
    const currentStatus = CampaignManager.status(logsDirectory(), active);
    const completedIds = currentStatus.conditions
      .filter((condition) => condition.complete)
      .map((condition) => condition.id);
    const updated = CampaignManager.updateCampaign(active, input, completedIds);
    config.campaign.active = updated;
    saveConfig(config);
    return {
      success: true,
      ...CampaignManager.status(logsDirectory(), updated),
      background: { ...campaignBackgroundState },
    };
  } catch (error) {
    return { success: false, error: String(error?.message || error) };
  }
});

ipcMain.handle('campaign:archive', () => {
  const active = config.campaign?.active;
  if (!active) return { success: false, error: 'No active campaign' };
  const archived = { ...active, status: 'archived', archivedAt: new Date().toISOString() };
  config.campaign = { active: null, archived: [...(config.campaign?.archived || []), archived] };
  saveConfig(config);
  return { success: true };
});

ipcMain.handle('campaign:setAutoRun', (_, { enabled } = {}) => {
  const active = config.campaign?.active;
  if (!active) return { success: false, error: 'No active campaign' };
  active.plan = { ...(active.plan || {}), autoRun: enabled === true };
  saveConfig(config);
  return {
    success: true,
    ...CampaignManager.status(logsDirectory(), config.campaign.active),
    background: { ...campaignBackgroundState },
  };
});

ipcMain.handle('log:getPath', () => logPath || '');

ipcMain.handle('log:readCurrent', () => {
  if (!logPath || !fs.existsSync(logPath)) return { success: false };
  return { success: true, data: fs.readFileSync(logPath, 'utf8'), fileName: path.basename(logPath) };
});

ipcMain.handle('log:revealInFolder', () => {
  if (logPath) shell.showItemInFolder(logPath);
  return { success: true };
});

ipcMain.handle('log:openReport', () => {
  if (!reportPath || !fs.existsSync(reportPath)) return { success: false, error: 'No report has been generated yet' };
  shell.openPath(reportPath);
  return { success: true, reportPath };
});

ipcMain.handle('file:saveCSV', async (_, payload) => {
  const contract = contractResult('file:saveCSV', payload);
  if (!contract.success) return contract;
  const { data, defaultName } = contract.value;
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName || 'radar_sequence.csv',
    filters: [{ name: 'CSV Files', extensions: ['csv'] }],
  });
  if (canceled || !filePath) return { success: false };
  fs.writeFileSync(filePath, data, 'utf8');
  return { success: true, filePath };
});
