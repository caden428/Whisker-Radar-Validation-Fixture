'use strict';

/**
 * Shared validation helpers for the MoreSense gain/threshold controls.
 * This module contains no Electron or browser dependencies so the main process
 * can reject malformed renderer input and Node tests can exercise the contract.
 */
const ALLOWED_GAIN_CODES = Object.freeze([
  0x03, 0x13, 0x23, 0x33, 0x43, 0x53, 0x63,
  0x73, 0x83, 0x93, 0xA3, 0xB3, 0xC3, 0xD3,
]);
const OPERATOR_GAIN_CODES = Object.freeze([0x33, 0x43, 0x53, 0x63, 0x73, 0x83, 0x93]);
const MIN_SAFE_THRESHOLD = 16;
const MAX_SAFE_THRESHOLD = 1022;
const LD021_PROTOCOL_PROFILE = 'hilink-ld021-motion-v1';
const LD021_MIN_THRESHOLD = 1;
const LD021_MAX_THRESHOLD = 0xFFFFFF;
const LD021_OUTPUT_TIME_STEP_MS = 100;
const LD021_MIN_OUTPUT_TIME_MS = 0;
const LD021_MAX_OUTPUT_TIME_MS = 0xFFFF * LD021_OUTPUT_TIME_STEP_MS;
const FIXED_OUTPUT_PROFILE = 'fixed-digital-output';

function hasFiniteNumber(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
}

/** Converts an API or UI value into an allowed one-byte gain code. */
function normalizeGainCode(value) {
  const parsed = typeof value === 'string' && /^0x/i.test(value) ? Number.parseInt(value, 16) : Number(value);
  if (!Number.isInteger(parsed) || !ALLOWED_GAIN_CODES.includes(parsed)) {
    throw new Error(`Gain must be one of: ${ALLOWED_GAIN_CODES.map(formatGainCode).join(', ')}`);
  }
  return parsed;
}

/** Restricts normal operation to the manufacturer's non-extreme threshold range. */
function normalizeThreshold(value, protocolProfile = 'moresense-hci-v2') {
  const parsed = Number(value);
  const isLd021 = protocolProfile === LD021_PROTOCOL_PROFILE;
  const minimum = isLd021 ? LD021_MIN_THRESHOLD : MIN_SAFE_THRESHOLD;
  const maximum = isLd021 ? LD021_MAX_THRESHOLD : MAX_SAFE_THRESHOLD;
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Threshold must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

/** Validates the LD021's experimental 16-bit output-delay field. */
function normalizeLd021OutputTimeMs(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < LD021_MIN_OUTPUT_TIME_MS
      || parsed > LD021_MAX_OUTPUT_TIME_MS || parsed % LD021_OUTPUT_TIME_STEP_MS !== 0) {
    throw new Error(`LD021 high time must be ${LD021_MIN_OUTPUT_TIME_MS} to ${LD021_MAX_OUTPUT_TIME_MS} ms in ${LD021_OUTPUT_TIME_STEP_MS} ms steps`);
  }
  return parsed;
}

/** Formats a gain code without obscuring its inverse relationship to sensitivity. */
function formatGainCode(value) {
  return `0x${Number(value).toString(16).toUpperCase().padStart(2, '0')}`;
}

/** Returns true when the active target's independently queried sensors are verified. */
function verifiedPair(payload) {
  if (['rcwl_single', 'rcwl_dual', 'rcwl_pair'].includes(payload?.activeTarget)) {
    const channels = payload.activeTarget === 'rcwl_single'
      ? ['RCWL_SINGLE'] : ['RCWL_A', 'RCWL_B'];
    return !!(payload?.success && payload?.protocolProfile === FIXED_OUTPUT_PROFILE
      && channels.every((channel) => payload?.sensors?.[channel]?.online
        && payload.sensors[channel].verified !== false));
  }
  if (['single', 'ld021', 'ld021_a', 'ld021_b'].includes(payload?.activeTarget)) {
    const channel = payload.activeTarget === 'ld021' ? 'LD021'
      : payload.activeTarget === 'ld021_a' ? 'LD021_A' : payload.activeTarget === 'ld021_b' ? 'LD021_B' : 'SINGLE';
    const sensor = payload?.sensors?.[channel];
    return !!(payload?.success && sensor?.online && sensor?.verified !== false
      && hasFiniteNumber(sensor.threshold)
      && (payload?.protocolProfile === LD021_PROTOCOL_PROFILE || hasFiniteNumber(sensor.gainCode)));
  }
  const ld021Pair = payload?.activeTarget === 'ld021_pair';
  const a = payload?.sensors?.[ld021Pair ? 'LD021_A' : 'A'];
  const b = payload?.sensors?.[ld021Pair ? 'LD021_B' : 'B'];
  return !!(
    payload?.success && a?.online && b?.online && a?.verified !== false && b?.verified !== false
    && (ld021Pair || Number(a.gainCode) === Number(b.gainCode))
    && Number(a.threshold) === Number(b.threshold)
    && (!ld021Pair || Number(a.outputTimeMs) === Number(b.outputTimeMs))
  );
}

/** Produces the traceability subset stored in manifests and reports. */
function traceabilitySnapshot(payload) {
  if (!payload) return null;
  const activeTarget = payload.activeTarget || 'dual';
  const copySensor = (sensor) => sensor ? {
    online: !!sensor.online,
    verified: sensor.verified !== false,
    gainCode: hasFiniteNumber(sensor.gainCode) ? Number(sensor.gainCode) : null,
    threshold: hasFiniteNumber(sensor.threshold) ? Number(sensor.threshold) : null,
    outputTimeMs: hasFiniteNumber(sensor.outputTimeMs) ? Number(sensor.outputTimeMs) : null,
    powerCode: hasFiniteNumber(sensor.powerCode) ? Number(sensor.powerCode) : null,
    firmwareVersion: hasFiniteNumber(sensor.firmwareVersion) ? Number(sensor.firmwareVersion) : null,
    lightThreshold: hasFiniteNumber(sensor.lightThreshold) ? Number(sensor.lightThreshold) : null,
    moduleId: hasFiniteNumber(sensor.moduleId) ? Number(sensor.moduleId) : null,
    outputMode: hasFiniteNumber(sensor.outputMode) ? Number(sensor.outputMode) : null,
  } : null;
  return {
    capturedAt: payload.capturedAt || new Date().toISOString(),
    protocolProfile: payload.protocolProfile || 'moresense-hci-v2',
    persistent: !!payload.persistent,
    verifiedPair: verifiedPair(payload),
    activeTarget,
    activeChannels: Array.isArray(payload.activeChannels) ? [...payload.activeChannels]
      : activeTarget === 'ld021_pair' ? ['LD021_A', 'LD021_B']
        : activeTarget === 'ld021_a' ? ['LD021_A'] : activeTarget === 'ld021_b' ? ['LD021_B']
          : activeTarget === 'ld021' ? ['LD021'] : activeTarget === 'single' ? ['SINGLE']
      : activeTarget === 'rcwl_single' ? ['RCWL_SINGLE'] : ['rcwl_dual', 'rcwl_pair'].includes(activeTarget) ? ['RCWL_A', 'RCWL_B'] : ['A', 'B'],
    sensors: {
      A: copySensor(payload.sensors?.A), B: copySensor(payload.sensors?.B),
      SINGLE: copySensor(payload.sensors?.SINGLE), LD021: copySensor(payload.sensors?.LD021),
      LD021_A: copySensor(payload.sensors?.LD021_A), LD021_B: copySensor(payload.sensors?.LD021_B),
      RCWL_SINGLE: copySensor(payload.sensors?.RCWL_SINGLE),
      RCWL_A: copySensor(payload.sensors?.RCWL_A), RCWL_B: copySensor(payload.sensors?.RCWL_B),
    },
  };
}

const api = {
  ALLOWED_GAIN_CODES,
  OPERATOR_GAIN_CODES,
  MIN_SAFE_THRESHOLD,
  MAX_SAFE_THRESHOLD,
  LD021_PROTOCOL_PROFILE,
  LD021_MIN_THRESHOLD,
  LD021_MAX_THRESHOLD,
  LD021_OUTPUT_TIME_STEP_MS,
  LD021_MIN_OUTPUT_TIME_MS,
  LD021_MAX_OUTPUT_TIME_MS,
  FIXED_OUTPUT_PROFILE,
  normalizeGainCode,
  normalizeThreshold,
  normalizeLd021OutputTimeMs,
  formatGainCode,
  verifiedPair,
  traceabilitySnapshot,
};

// Export through CommonJS for the Electron main process and Node tests, and
// expose the same API globally when this file is loaded by index.html. The
// renderer runs with context isolation and no Node integration, so a
// CommonJS-only export leaves `RadarSettingsCore` undefined in the GUI.
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') globalThis.RadarSettingsCore = api;
