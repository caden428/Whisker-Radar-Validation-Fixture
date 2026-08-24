'use strict';

const TEST_LABELS = Object.freeze({
  inside: '10.1',
  outside: '10.2',
  characterization: 'CHAR',
  custom: 'CUSTOM',
  sequence: 'UNSCORED',
  unscored_sequence: 'UNSCORED',
});

/** Converts user metadata into a readable Windows-safe path segment. */
function safeSegment(value, fallback = 'unknown', maxLength = 24) {
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
  let segment = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
  if (!segment || reserved.test(segment)) segment = fallback;
  return segment.slice(0, maxLength).replace(/-+$/g, '') || fallback;
}

/** Returns the short operator-facing identifier for a test mode. */
function testLabelFor(manifest = {}) {
  const testId = manifest.testDefinition?.id || manifest.testId || 'sequence';
  return TEST_LABELS[testId]
    || safeSegment(testId, 'TEST', 20).toUpperCase();
}

/** Reads the captured Radar A settings used for the run name. */
function radarSettingsFor(manifest = {}) {
  const target = manifest.activeTarget || manifest.radarSettings?.activeTarget || 'dual';
  const sensorKey = target === 'ld021_pair' || target === 'ld021_a' ? 'LD021_A'
    : target === 'ld021_b' ? 'LD021_B'
      : target === 'ld021' ? 'LD021'
        : target === 'single' ? 'SINGLE' : 'A';
  const radarA = manifest.radarSettings?.sensors?.[sensorKey] || {};
  const gainPresent = radarA.gainCode !== null && radarA.gainCode !== undefined && radarA.gainCode !== '';
  const thresholdPresent = radarA.threshold !== null && radarA.threshold !== undefined && radarA.threshold !== '';
  const gainValue = gainPresent ? Number(radarA.gainCode) : NaN;
  const thresholdValue = thresholdPresent ? Number(radarA.threshold) : NaN;
  return {
    target,
    gain: Number.isInteger(gainValue)
      ? `0x${gainValue.toString(16).toUpperCase().padStart(2, '0')}`
      : 'unknown',
    threshold: Number.isFinite(thresholdValue)
      ? String(Math.trunc(thresholdValue))
      : 'unknown',
  };
}

const HARDWARE_TOKENS = Object.freeze({
  'moresense-single': 'MS58-SINGLE',
  'moresense-dual': 'MORESENSE-DUAL',
  'ld021-a': 'HLK-LD021-A',
  'ld021-b': 'HLK-LD021-B',
  'ld021-system': 'HLK-LD021-PAIR',
  'ld021-pair': 'HLK-LD021-PAIR',
  'rcwl-single': 'RCWL-SINGLE',
  'rcwl-dual': 'RCWL-DUAL',
  'rcwl-pair': 'RCWL-PAIR',
});

/** Returns the readable hardware/layout token captured in every run name. */
function sensorTokenFor(manifest = {}) {
  const hardwareId = String(manifest.runSetup?.hardwareId || manifest.preparedRun?.setup?.hardwareId || '').trim();
  if (HARDWARE_TOKENS[hardwareId]) return HARDWARE_TOKENS[hardwareId];
  const target = manifest.activeTarget || manifest.radarSettings?.activeTarget || manifest.configuration?.validation?.radarTarget || 'dual';
  return {
    single: 'MS58-SINGLE', dual: 'MORESENSE-DUAL',
    ld021: manifest.configuration?.validation?.hilinkSensor === 'B' ? 'HLK-LD021-B' : 'HLK-LD021-A',
    ld021_a: 'HLK-LD021-A', ld021_b: 'HLK-LD021-B', ld021_pair: 'HLK-LD021-PAIR',
    rcwl_single: 'RCWL-SINGLE', rcwl_dual: 'RCWL-DUAL', rcwl_pair: 'RCWL-PAIR',
  }[target] || safeSegment(target, 'SENSOR', 24).toUpperCase();
}

/** Formats settings without ambiguous unlabeled numeric pairs. */
function settingsTokenFor(manifest = {}) {
  const radar = radarSettingsFor(manifest);
  if (String(radar.target).startsWith('rcwl_')) return 'FIXED';
  if (String(radar.target).startsWith('ld021')) return `T${radar.threshold}`;
  return `G${radar.gain}-T${radar.threshold}`;
}

/** Formats a start instant in America/New_York using Windows-safe characters. */
function easternStartParts(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid run start time');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(date)
    .filter((part) => part.type !== 'literal')
    .map((part) => [part.type, part.value]));
  return {
    time: `${parts.hour}-${parts.minute}${String(parts.dayPeriod).toUpperCase()}`,
    date: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

/** Creates the approved human-readable run-folder basename. */
function buildRunBase(manifest = {}, startedAt = new Date()) {
  const test = testLabelFor(manifest);
  const cycles = Math.max(1, Math.floor(Number(manifest.cyclesPlanned) || 1));
  const cycleWord = cycles === 1 ? 'cycle' : 'cycles';
  const started = easternStartParts(startedAt);
  const dut = safeSegment(manifest.dutId, 'no-DUT');
  const sensor = sensorTokenFor(manifest);
  const plan = safeSegment(manifest.testPlan?.name || manifest.recipe?.name || manifest.activeSequence, 'unnamed-plan', 36);
  const settings = settingsTokenFor(manifest);
  return `DUT-${dut}_${sensor}_${test}_PLAN-${plan}_${settings}_${cycles}${cycleWord}_${started.date}_${started.time}`;
}

/** Adds a numeric suffix only when a basename is already in use. */
function uniqueRunBase(baseName, exists) {
  if (typeof exists !== 'function' || !exists(baseName)) return baseName;
  let suffix = 2;
  while (exists(`${baseName}_${suffix}`)) suffix += 1;
  return `${baseName}_${suffix}`;
}

module.exports = {
  safeSegment,
  testLabelFor,
  radarSettingsFor,
  sensorTokenFor,
  settingsTokenFor,
  easternStartParts,
  buildRunBase,
  uniqueRunBase,
};
