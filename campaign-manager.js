'use strict';

const fs = require('fs');
const CampaignLedger = require('./campaign-ledger');
const RadarSettingsCore = require('./radar-settings-core');
const RecipeCore = require('./recipe-core');

const SUPPORTED_TESTS = Object.freeze(['characterization', 'interference', 'inside', 'outside', 'system', 'custom']);
const SUPPORTED_ANGULAR_ZONES = Object.freeze(['all', 'right', 'front', 'left']);
const DEFAULT_PLAN = Object.freeze({
  testId: 'characterization',
  runsPerCondition: 1,
  cyclesPerRun: 3,
  pointCount: 100,
  gains: Object.freeze([0x33, 0x43, 0x53]),
  thresholds: Object.freeze([16, 25, 50]),
  angularZones: Object.freeze(['all']),
  geometry: Object.freeze({
    schemaVersion: 3,
    sensorLayout: 'dual',
    geometrySemantics: 'dual-sensor-system-distance-bands',
    systemReference: Object.freeze({ x: 875, y: 1040, confirmed: true }),
    dutLocationId: 'in-field-front-875-880',
    dut: Object.freeze({
      id: 'in-field-front-875-880', name: 'In-Field DUT — Front Edge (875, 880)',
      center: Object.freeze({ x: 875, y: 1040 }),
      bounds: Object.freeze({ minX: 744, maxX: 1006, minY: 880, maxY: 1200 }),
      widthMm: 262, depthMm: 320, frontY: 880,
    }),
    bounds: Object.freeze({ minX: 0, maxX: 1725, minY: 150, maxY: 1040 }),
    requiredTriggerMm: 304.8,
    requiredNoTriggerMm: 609.6,
    guardBandMm: 10,
    singleSensor: Object.freeze({ centerX: 875, centerY: 1200, radiusMm: 304.8 }),
  }),
});

function slug(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 48) || 'campaign';
}

function integer(value, label, minimum = 1, maximum = 10000) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be a whole number from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function finite(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a number`);
  return parsed;
}

function unique(values) {
  return [...new Set(values)];
}

function normalizePlan(input = {}) {
  const source = input.plan || input;
  const testId = String(source.testId || DEFAULT_PLAN.testId);
  if (!SUPPORTED_TESTS.includes(testId)) throw new Error('Choose a supported campaign test type');
  const runsPerCondition = integer(source.runsPerCondition ?? DEFAULT_PLAN.runsPerCondition, 'Runs per condition', 1, 100);
  const cyclesPerRun = integer(source.cyclesPerRun ?? DEFAULT_PLAN.cyclesPerRun, 'Cycles per run', 1, 100);
  const pointCount = integer(source.pointCount ?? DEFAULT_PLAN.pointCount, 'Points per cycle', 1, 10000);
  const minimumCorrectRate = Math.max(0, Math.min(1, finite(source.minimumCorrectRate ?? 0.95, 'Pass threshold')));
  const autoRun = source.autoRun === true;
  const requestedGeometry = source.geometry || {};
  const requestedLayout = String(requestedGeometry.sensorLayout || DEFAULT_PLAN.geometry.sensorLayout);
  const sensorLayout = ['ld021_pair', 'rcwl_pair'].includes(requestedLayout) ? requestedLayout : requestedLayout === 'dual' ? 'dual' : 'single';
  const requestedTarget = String(source.radarTarget || (['ld021_pair', 'rcwl_pair'].includes(sensorLayout) ? sensorLayout : sensorLayout === 'dual' ? 'dual' : 'single')).toLowerCase();
  if (!['dual', 'single', 'ld021', 'ld021_pair', 'rcwl_single', 'rcwl_dual', 'rcwl_pair'].includes(requestedTarget)
    || (sensorLayout === 'dual' && !['dual', 'rcwl_dual'].includes(requestedTarget))
    || (sensorLayout === 'ld021_pair' && requestedTarget !== 'ld021_pair')
    || (sensorLayout === 'rcwl_pair' && requestedTarget !== 'rcwl_pair')
    || (sensorLayout === 'single' && !['single', 'ld021', 'rcwl_single'].includes(requestedTarget))) {
    throw new Error('Radar target must match the selected sensor layout');
  }
  const radarTarget = requestedTarget;
  const hilinkSensor = source.hilinkSensor === 'B' ? 'B' : 'A';
  const settingsProfile = radarTarget.startsWith('rcwl_') ? RadarSettingsCore.FIXED_OUTPUT_PROFILE
    : ['ld021', 'ld021_pair'].includes(radarTarget) ? 'ld021-threshold-only' : 'moresense-gain-threshold';
  const fixedOutput = settingsProfile === RadarSettingsCore.FIXED_OUTPUT_PROFILE;
  const gains = settingsProfile === 'moresense-gain-threshold' ? unique((Array.isArray(source.gains) ? source.gains : DEFAULT_PLAN.gains)
    .map((gain) => RadarSettingsCore.normalizeGainCode(gain))) : [];
  if (settingsProfile === 'moresense-gain-threshold' && !gains.length) throw new Error('Select at least one gain');
  const thresholds = fixedOutput ? [] : unique((Array.isArray(source.thresholds) ? source.thresholds : DEFAULT_PLAN.thresholds)
    .map((threshold) => RadarSettingsCore.normalizeThreshold(threshold,
      settingsProfile === 'ld021-threshold-only' ? RadarSettingsCore.LD021_PROTOCOL_PROFILE : undefined)));
  if (!fixedOutput && !thresholds.length) throw new Error('Enter at least one threshold');
  const angularZones = unique((Array.isArray(source.angularZones) ? source.angularZones : DEFAULT_PLAN.angularZones)
    .map((zone) => String(zone || '').toLowerCase()));
  if (!angularZones.length) throw new Error('Select at least one angular zone');
  if (angularZones.some((zone) => !SUPPORTED_ANGULAR_ZONES.includes(zone))) {
    throw new Error('Angular zones must be all, right, front, or left');
  }

  const requestedBounds = requestedGeometry.bounds || source.bounds || {};
  const referenceX = finite(requestedGeometry.systemReference?.x ?? DEFAULT_PLAN.geometry.systemReference.x, 'System reference X');
  const referenceY = finite(requestedGeometry.systemReference?.y ?? DEFAULT_PLAN.geometry.systemReference.y, 'System reference Y');
  const inferredDutLocationId = Math.abs(referenceY - 1260) < 0.001
    ? 'original-front-875-1100' : DEFAULT_PLAN.geometry.dutLocationId;
  const geometry = {
    schemaVersion: 3,
    sensorLayout,
    geometrySemantics: sensorLayout === 'dual'
      ? 'dual-sensor-system-distance-bands' : 'single-sensor-activation-lobe',
    systemReference: {
      x: referenceX,
      y: referenceY,
      confirmed: requestedGeometry.systemReference?.confirmed === true,
    },
    dutLocationId: String(requestedGeometry.dutLocationId || requestedGeometry.dut?.id || inferredDutLocationId),
    dut: {
      id: String(requestedGeometry.dut?.id || requestedGeometry.dutLocationId || DEFAULT_PLAN.geometry.dut.id),
      name: String(requestedGeometry.dut?.name || DEFAULT_PLAN.geometry.dut.name),
      center: {
        x: finite(requestedGeometry.dut?.center?.x ?? referenceX, 'DUT center X'),
        y: finite(requestedGeometry.dut?.center?.y ?? referenceY, 'DUT center Y'),
      },
      bounds: {
        minX: finite(requestedGeometry.dut?.bounds?.minX ?? referenceX-131, 'DUT minimum X'),
        maxX: finite(requestedGeometry.dut?.bounds?.maxX ?? referenceX+131, 'DUT maximum X'),
        minY: finite(requestedGeometry.dut?.bounds?.minY ?? referenceY-160, 'DUT minimum Y'),
        maxY: finite(requestedGeometry.dut?.bounds?.maxY ?? referenceY+160, 'DUT maximum Y'),
      },
      widthMm: finite(requestedGeometry.dut?.widthMm ?? DEFAULT_PLAN.geometry.dut.widthMm, 'DUT width'),
      depthMm: finite(requestedGeometry.dut?.depthMm ?? DEFAULT_PLAN.geometry.dut.depthMm, 'DUT depth'),
      frontY: finite(requestedGeometry.dut?.frontY ?? DEFAULT_PLAN.geometry.dut.frontY, 'DUT front Y'),
    },
    bounds: {
      minX: finite(requestedBounds.minX ?? DEFAULT_PLAN.geometry.bounds.minX, 'X minimum'),
      maxX: finite(requestedBounds.maxX ?? DEFAULT_PLAN.geometry.bounds.maxX, 'X maximum'),
      minY: finite(requestedBounds.minY ?? DEFAULT_PLAN.geometry.bounds.minY, 'Y minimum'),
      maxY: finite(requestedBounds.maxY ?? DEFAULT_PLAN.geometry.bounds.maxY, 'Y maximum'),
    },
    requiredTriggerMm: Math.max(0.1, finite(requestedGeometry.requiredTriggerMm ?? DEFAULT_PLAN.geometry.requiredTriggerMm, 'Green pass boundary')),
    requiredNoTriggerMm: Math.max(0.1, finite(requestedGeometry.requiredNoTriggerMm ?? DEFAULT_PLAN.geometry.requiredNoTriggerMm, 'Grey/red boundary')),
    guardBandMm: Math.max(0, finite(requestedGeometry.guardBandMm ?? DEFAULT_PLAN.geometry.guardBandMm, 'Guard band')),
    singleSensor: {
      centerX: finite(requestedGeometry.singleSensor?.centerX ?? requestedGeometry.centerX ?? DEFAULT_PLAN.geometry.singleSensor.centerX, 'Sensor center X'),
      centerY: finite(requestedGeometry.singleSensor?.centerY ?? requestedGeometry.centerY ?? DEFAULT_PLAN.geometry.singleSensor.centerY, 'Sensor center Y'),
      radiusMm: finite(requestedGeometry.singleSensor?.radiusMm ?? requestedGeometry.radiusMm ?? DEFAULT_PLAN.geometry.singleSensor.radiusMm, 'Sensor depth'),
    },
    sequenceName: String(requestedGeometry.sequenceName || source.sequenceName || '').trim(),
  };
  if (geometry.requiredNoTriggerMm <= geometry.requiredTriggerMm) {
    throw new Error('The grey/red boundary must be greater than the green pass boundary');
  }
  if (geometry.bounds.minX >= geometry.bounds.maxX || geometry.bounds.minY >= geometry.bounds.maxY) {
    throw new Error('Coordinate minimums must be smaller than maximums');
  }
  if (geometry.sensorLayout === 'dual' || ['ld021_pair', 'rcwl_pair'].includes(geometry.sensorLayout)) delete geometry.singleSensor;
  if (['ld021_pair', 'rcwl_pair'].includes(geometry.sensorLayout)) {
    geometry.geometrySemantics = `${geometry.sensorLayout.replace('_', '-')}-characterization`;
    geometry.sensorA = { x: finite(requestedGeometry.sensorA?.x ?? 775, 'Sensor A X'), y: finite(requestedGeometry.sensorA?.y ?? 900, 'Sensor A Y'), headingDeg: finite(requestedGeometry.sensorA?.headingDeg ?? 0, 'Sensor A heading') };
    geometry.sensorB = { x: finite(requestedGeometry.sensorB?.x ?? 975, 'Sensor B X'), y: finite(requestedGeometry.sensorB?.y ?? 900, 'Sensor B Y'), headingDeg: finite(requestedGeometry.sensorB?.headingDeg ?? 0, 'Sensor B heading') };
  }
  if (geometry.sensorLayout === 'single' && geometry.singleSensor.radiusMm <= 0) throw new Error('Sensor depth must be greater than zero');
  if (testId === 'custom' && !geometry.sequenceName) throw new Error('Choose a custom test plan');
  const runNames = {};
  if (source.runNames && typeof source.runNames === 'object' && !Array.isArray(source.runNames)) {
    Object.entries(source.runNames).forEach(([conditionId, value]) => {
      const name = String(value || '').trim();
      if (name.length > 80) throw new Error('Run names must be 80 characters or fewer');
      if (name) runNames[String(conditionId)] = name;
    });
  }
  const recipeId = String(source.recipeId || '').trim();
  const recipeSnapshot = source.recipeSnapshot ? RecipeCore.snapshot(source.recipeSnapshot) : null;
  return { recipeId, recipeSnapshot, testId, runsPerCondition, cyclesPerRun, pointCount, minimumCorrectRate, autoRun, radarTarget, hilinkSensor, settingsProfile, gains, thresholds, angularZones, geometry, runNames };
}

function formatGain(gainCode) {
  return RadarSettingsCore.formatGainCode(gainCode);
}

function buildConditions(plan) {
  const conditions = [];
  plan.angularZones.forEach((angularZone) => {
    const fixedOutput = plan.settingsProfile === RadarSettingsCore.FIXED_OUTPUT_PROFILE;
    const gains = plan.settingsProfile === 'moresense-gain-threshold' ? plan.gains : [null];
    const thresholds = fixedOutput ? [null] : plan.thresholds;
    gains.forEach((gainCode) => {
      thresholds.forEach((threshold) => {
        for (let repeat = 1; repeat <= plan.runsPerCondition; repeat++) {
          const runNumber = conditions.length + 1;
          const baseId = fixedOutput ? `${plan.radarTarget.replace('_', '-')}-r${repeat}`
            : plan.settingsProfile === 'ld021-threshold-only'
              ? `${plan.radarTarget === 'ld021_pair' ? 'ld021-pair' : 'ld021'}-t${threshold}-r${repeat}` : `g${gainCode.toString(16).padStart(2, '0')}-t${threshold}-r${repeat}`;
          const id = angularZone === 'all' ? baseId : `z${angularZone}-${baseId}`;
          conditions.push({
            id,
            runNumber,
            name: String(plan.runNames?.[id] || ''),
            repeat,
            gainCode,
            gain: gainCode == null ? '' : formatGain(gainCode),
            threshold,
            angularZone,
            radarTarget: plan.radarTarget,
            hilinkSensor: plan.hilinkSensor,
            settingsProfile: plan.settingsProfile,
          });
        }
      });
    });
  });
  return conditions;
}

function methodFor(campaign) {
  const plan = normalizePlan(campaign?.plan || DEFAULT_PLAN);
  return {
    id: `campaign-plan-${campaign?.id || 'draft'}`,
    name: campaign?.name || 'Campaign',
    ...plan,
    cycles: plan.cyclesPerRun,
    conditions: buildConditions(plan),
  };
}

function createCampaign(input = {}, now = new Date()) {
  const name = String(input.name || '').trim();
  const dutId = String(input.dutId || '').trim();
  if (!name) throw new Error('Enter a campaign name');
  if (!dutId) throw new Error('Enter the DUT or product name');
  const plan = normalizePlan(input.plan || input);
  const date = now.toISOString().slice(0, 10);
  return {
    id: `${slug(name)}-${date}-${String(now.getTime()).slice(-6)}`,
    name,
    dutId,
    plan,
    status: 'active',
    createdAt: now.toISOString(),
  };
}

function updateCampaign(existing, input = {}, completedConditionIds = [], now = new Date()) {
  if (!existing || existing.status !== 'active') throw new Error('No active campaign');
  const name = String(input.name ?? existing.name ?? '').trim();
  const dutId = String(input.dutId ?? existing.dutId ?? '').trim();
  if (!name) throw new Error('Enter a campaign name');
  if (!dutId) throw new Error('Enter the DUT or product name');
  const plan = normalizePlan(input.plan || existing.plan);
  const completed = new Set((completedConditionIds || []).map(String).filter(Boolean));
  if (completed.size && plan.testId !== existing.plan?.testId) {
    throw new Error('The test type cannot be changed after campaign results have been recorded');
  }
  if (completed.size && (plan.radarTarget !== existing.plan?.radarTarget || plan.settingsProfile !== existing.plan?.settingsProfile
      || (plan.radarTarget === 'ld021' && plan.hilinkSensor !== (existing.plan?.hilinkSensor === 'B' ? 'B' : 'A')))) {
    throw new Error('Radar hardware cannot be changed after campaign results have been recorded');
  }
  const nextIds = new Set(buildConditions(plan).map((condition) => condition.id));
  const removed = [...completed].filter((id) => !nextIds.has(id));
  if (removed.length) {
    throw new Error('Runs with recorded results cannot be removed. Keep their gain, threshold, and repeat count in the plan');
  }
  return {
    ...existing,
    name,
    dutId,
    plan,
    updatedAt: now.toISOString(),
  };
}

function historyRecords(logsDirectory, campaignId) {
  const ledger = CampaignLedger.ensureLedger(logsDirectory, campaignId);
  const rows = CampaignLedger.parseCsv(fs.readFileSync(ledger.history, 'utf8'));
  const headers = rows.shift() || [];
  return rows.map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] || ''])));
}

function status(logsDirectory, campaign) {
  if (!campaign) {
    const method = methodFor(null);
    return { active: false, method, completed: 0, passed: 0, failed: 0, total: method.conditions.length, conditions: [] };
  }
  const method = methodFor(campaign);
  const records = historyRecords(logsDirectory, campaign.id);
  const terminal = records.filter((record) => ['COMPLETE', 'PASS', 'FAIL'].includes(String(record.Status).toUpperCase()));
  const recordsByCondition = new Map();
  terminal.forEach((record) => {
    const conditionId = String(record.ConditionId || '');
    if (conditionId && !recordsByCondition.has(conditionId)) recordsByCondition.set(conditionId, record);
  });
  // Migration fallback for campaigns created before condition IDs existed.
  method.conditions.forEach((condition) => {
    if (recordsByCondition.has(condition.id)) return;
    const legacy = condition.settingsProfile === 'moresense-gain-threshold' && terminal.find((record) =>
      String(record.Gain).toUpperCase() === condition.gain.toUpperCase()
      && Number(record.Threshold) === condition.threshold
      && ![...recordsByCondition.values()].includes(record));
    if (legacy) recordsByCondition.set(condition.id, legacy);
  });
  const conditions = method.conditions.map((condition) => {
    const record = recordsByCondition.get(condition.id);
    const result = String(record?.TestResult || record?.Status || '').toUpperCase();
    return {
      ...condition,
      complete: !!record,
      result: result === 'COMPLETE' ? 'COMPLETE' : result,
      recordId: record?.RecordId || '',
    };
  });
  const completed = conditions.filter((condition) => condition.complete).length;
  const passed = conditions.filter((condition) => ['PASS', 'COMPLETE'].includes(condition.result)).length;
  const failed = conditions.filter((condition) => condition.result === 'FAIL').length;
  return {
    active: campaign.status === 'active',
    campaign,
    method,
    completed,
    passed,
    failed,
    total: conditions.length,
    conditions,
    next: conditions.find((condition) => !condition.complete) || null,
    ...CampaignLedger.getStatus(logsDirectory, campaign.id),
  };
}

module.exports = {
  SUPPORTED_TESTS, SUPPORTED_ANGULAR_ZONES, DEFAULT_PLAN, slug, normalizePlan, buildConditions, methodFor, createCampaign, updateCampaign, status,
};
