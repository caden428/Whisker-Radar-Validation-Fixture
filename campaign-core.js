(function campaignCoreFactory(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CampaignCore = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function buildCampaignCore() {
  'use strict';

  const validationCore = typeof require === 'function'
    ? require('./validation-core')
    : (typeof globalThis !== 'undefined' ? globalThis.ValidationCore : null);

  const SCHEMA_VERSION = 3;
  const HISTORY_COLUMNS = Object.freeze([
    'SchemaVersion', 'RecordId', 'CampaignKey', 'CompletedAt', 'RunId', 'DUT',
    'TestId', 'RadarTarget', 'SettingsProfile', 'Gain', 'Threshold', 'CyclesPlanned', 'CyclesCompleted', 'PointCount',
    'Status', 'SettingsVerified', 'ValidPoints', 'ThreeOfThree', 'TwoOfThree',
    'OneOfThree', 'ZeroOfThree', 'MedianLatencyMs', 'P95LatencyMs',
    'InvalidObservations', 'RetryNumber', 'ReportFolder', 'FailureReason',
    'ConditionId', 'CampaignRunNumber', 'RepeatNumber', 'TestResult',
    'FullTriggerPoints', 'PartialTriggerPoints', 'ZeroTriggerPoints', 'AverageTriggerRate',
  ]);

  function finite(value, fallback = null) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function normalizeText(value) {
    return String(value == null ? '' : value).trim();
  }

  function normalizeGain(value) {
    if (value == null || value === '') return '';
    const number = typeof value === 'string' && /^0x/i.test(value)
      ? Number.parseInt(value, 16) : Number(value);
    return Number.isFinite(number) ? `0x${number.toString(16).toUpperCase().padStart(2, '0')}` : '';
  }

  function percentile(values, fraction) {
    const sorted = (values || []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) return null;
    const rank = Math.max(0, Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1));
    return sorted[rank];
  }

  function median(values) {
    const sorted = (values || []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) return null;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (value && typeof value === 'object') {
      return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
  }

  function hashText(text) {
    let hash = 2166136261;
    for (let index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function settingsFrom(report) {
    const settings = report?.radarSettings || {};
    const activeTarget = report?.activeTarget || settings.activeTarget || 'dual';
    if (String(activeTarget).startsWith('rcwl_')) {
      return { radarTarget: activeTarget, settingsProfile: 'fixed-digital-output',
        gain: '', threshold: '', verified: settings.verifiedPair === true };
    }
    if (String(activeTarget).startsWith('ld021')) {
      const channel = activeTarget === 'ld021_pair' || activeTarget === 'ld021_a' ? 'LD021_A'
        : activeTarget === 'ld021_b' ? 'LD021_B' : 'LD021';
      const sensor = settings.sensors?.[channel] || {};
      return { radarTarget: activeTarget, settingsProfile: 'ld021-threshold-only', gain: '', threshold: finite(sensor.threshold),
        verified: settings.verifiedPair === true && sensor.online === true && sensor.verified !== false && finite(sensor.threshold) !== null };
    }
    if (activeTarget === 'single') {
      const sensor = settings.sensors?.SINGLE || {};
      return { radarTarget: 'single', settingsProfile: 'moresense-gain-threshold', gain: normalizeGain(sensor.gainCode), threshold: finite(sensor.threshold),
        verified: settings.verifiedPair === true && sensor.online === true && sensor.verified !== false && !!normalizeGain(sensor.gainCode) && finite(sensor.threshold) !== null };
    }
    const sensorA = settings.sensors?.A || {};
    const sensorB = settings.sensors?.B || {};
    const gain = normalizeGain(sensorA.gainCode);
    const threshold = finite(sensorA.threshold);
    const matches = gain && threshold !== null
      && normalizeGain(sensorB.gainCode) === gain
      && finite(sensorB.threshold) === threshold;
    return { radarTarget: 'dual', settingsProfile: 'moresense-gain-threshold', gain, threshold, verified: settings.verifiedPair === true && !!matches };
  }

  function buildCampaignRecord(input = {}) {
    const report = input.report || {};
    const observations = Array.isArray(report.observations) ? report.observations : [];
    // Raw observations include failed acquisition attempts for traceability.
    // Campaign completion is based on the final replacement for each point/cycle.
    const effectiveObservations = validationCore?.effectiveObservations
      ? validationCore.effectiveObservations(observations) : observations;
    const aggregates = Array.isArray(report.aggregates) ? report.aggregates : [];
    const cyclesPlanned = Math.max(1, Math.floor(finite(report.cyclesPlanned, 1)));
    const settings = settingsFrom(report);
    const validCycles = new Set(effectiveObservations.filter((item) => item.valid !== false
      && typeof item.actualDetected === 'boolean').map((item) => finite(item.cycleNumber)).filter(Number.isFinite));
    const counts = { 0: 0, 1: 0, 2: 0, 3: 0 };
    aggregates.forEach((point) => {
      const triggered = Math.max(0, Math.min(3, Math.floor(finite(point.triggeredCount, 0))));
      counts[triggered] = (counts[triggered] || 0) + 1;
    });
    const validPoints = aggregates.filter((point) => finite(point.validCount, 0) >= cyclesPlanned).length;
    const invalidObservations = effectiveObservations.filter((item) => item.valid === false).length;
    const rawInvalidObservations = observations.filter((item) => item.valid === false).length;
    const latencies = effectiveObservations.filter((item) => item.valid !== false && item.actualDetected === true)
      .map((item) => finite(item.detectionLatencyMs)).filter(Number.isFinite);
    const plannedPositions = Array.isArray(report.plannedPositions) && report.plannedPositions.length
      ? report.plannedPositions : aggregates;
    const pointCount = plannedPositions.length;
    if (pointCount > aggregates.length) counts[0] += pointCount - aggregates.length;
    const fullTriggerPoints = aggregates.filter((point) => finite(point.triggeredCount, 0) >= cyclesPlanned).length;
    const partialTriggerPoints = aggregates.filter((point) => {
      const count = finite(point.triggeredCount, 0);
      return count > 0 && count < cyclesPlanned;
    }).length;
    const zeroTriggerPoints = aggregates.filter((point) => finite(point.triggeredCount, 0) <= 0).length
      + Math.max(0, pointCount - aggregates.length);
    const averageTriggerRate = pointCount && cyclesPlanned
      ? effectiveObservations.filter((item) => item.valid !== false && item.actualDetected === true).length / (pointCount * cyclesPlanned)
      : null;
    const executionComplete = pointCount > 0
      && validPoints === pointCount
      && validCycles.size >= cyclesPlanned
      && invalidObservations === 0
      && settings.verified
      && !!normalizeText(input.reportFolder);
    const testResult = normalizeText(report.result || (report.testId === 'characterization' ? 'COMPLETE' : 'FAIL')).toUpperCase();
    const clean = executionComplete && ['PASS', 'COMPLETE'].includes(testResult);
    const footprint = {
      geometry: report.geometry || {},
      points: plannedPositions.map((point) => [finite(point.x), finite(point.y)]),
    };
    const campaignKey = [
      normalizeText(report.dutId).toLowerCase(), settings.radarTarget, settings.settingsProfile, settings.gain, settings.threshold ?? '',
      cyclesPlanned, pointCount, hashText(stableStringify(footprint)),
    ].join('|');
    const completedAt = normalizeText(input.completedAt || report.completedAt || new Date().toISOString());
    const recordId = hashText(`${campaignKey}|${normalizeText(report.runId)}|${completedAt}|${normalizeText(input.reportFolder)}`);
    return {
      schemaVersion: SCHEMA_VERSION,
      recordId,
      campaignKey,
      completedAt,
      runId: normalizeText(report.runId),
      dut: normalizeText(report.dutId),
      testId: normalizeText(report.testId),
      radarTarget: settings.radarTarget,
      settingsProfile: settings.settingsProfile,
      gain: settings.gain,
      threshold: settings.threshold,
      cyclesPlanned,
      cyclesCompleted: validCycles.size,
      pointCount,
      status: executionComplete ? (testResult === 'COMPLETE' ? 'COMPLETE' : testResult === 'PASS' ? 'PASS' : 'FAIL') : 'INCOMPLETE',
      settingsVerified: settings.verified,
      validPoints,
      threeOfThree: counts[3] || 0,
      twoOfThree: counts[2] || 0,
      oneOfThree: counts[1] || 0,
      zeroOfThree: counts[0] || 0,
      medianLatencyMs: median(latencies),
      p95LatencyMs: percentile(latencies, 0.95),
      invalidObservations,
      rawInvalidObservations,
      retryNumber: Math.max(0, Math.floor(finite(input.retryNumber, 0))),
      reportFolder: normalizeText(input.reportFolder),
      failureReason: clean ? '' : normalizeText(report.reason || input.failureReason || 'Campaign completion requirements were not met'),
      conditionId: normalizeText(report.campaignConditionId),
      campaignRunNumber: Math.max(0, Math.floor(finite(report.campaignRunNumber, 0))),
      repeatNumber: Math.max(0, Math.floor(finite(report.campaignRepeatNumber, 0))),
      testResult,
      fullTriggerPoints,
      partialTriggerPoints,
      zeroTriggerPoints,
      averageTriggerRate,
      graphData: aggregates.map((point, index) => ({
        pointId: normalizeText(point.pointId || index + 1),
        x: finite(point.x),
        y: finite(point.y),
        triggeredCount: Math.max(0, Math.floor(finite(point.triggeredCount, 0))),
        validCount: Math.max(0, Math.floor(finite(point.validCount, 0))),
        medianLatencyMs: finite(point.medianLatencyMs),
      })),
      clean,
    };
  }

  function recordToRow(record) {
    const values = {
      SchemaVersion: record.schemaVersion, RecordId: record.recordId, CampaignKey: record.campaignKey,
      CompletedAt: record.completedAt, RunId: record.runId, DUT: record.dut, TestId: record.testId,
      RadarTarget: record.radarTarget, SettingsProfile: record.settingsProfile, Gain: record.gain, Threshold: record.threshold, CyclesPlanned: record.cyclesPlanned,
      CyclesCompleted: record.cyclesCompleted, PointCount: record.pointCount, Status: record.status,
      SettingsVerified: record.settingsVerified, ValidPoints: record.validPoints,
      ThreeOfThree: record.threeOfThree, TwoOfThree: record.twoOfThree,
      OneOfThree: record.oneOfThree, ZeroOfThree: record.zeroOfThree,
      MedianLatencyMs: record.medianLatencyMs, P95LatencyMs: record.p95LatencyMs,
      InvalidObservations: record.invalidObservations, RetryNumber: record.retryNumber,
      ReportFolder: record.reportFolder, FailureReason: record.failureReason,
      ConditionId: record.conditionId, CampaignRunNumber: record.campaignRunNumber,
      RepeatNumber: record.repeatNumber, TestResult: record.testResult,
      FullTriggerPoints: record.fullTriggerPoints, PartialTriggerPoints: record.partialTriggerPoints,
      ZeroTriggerPoints: record.zeroTriggerPoints, AverageTriggerRate: record.averageTriggerRate,
    };
    return HISTORY_COLUMNS.map((column) => values[column] == null ? '' : values[column]);
  }

  return {
    SCHEMA_VERSION, HISTORY_COLUMNS, normalizeGain, percentile, median,
    stableStringify, hashText, buildCampaignRecord, recordToRow,
  };
}));
