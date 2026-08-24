'use strict';

const AXES = Object.freeze(['x', 'y', 'z']);
const MOTION_UNITS_VERSION = 2;
const MAX_SPEED_MM_S = 500;
const MAX_ACCEL_MM_S2 = 10000;
const MAX_TIMEOUT_MS = 10 * 60 * 1000;

function finite(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
}

function migrate(motion = {}) {
  const legacyFeedValues = Number(motion.unitsVersion) !== MOTION_UNITS_VERSION;
  const normalized = { ...motion, unitsVersion: MOTION_UNITS_VERSION, commissioned: motion.commissioned === true };
  AXES.forEach((axis) => {
    const source = motion[axis] || {};
    const speed = Number(source.speedMmS);
    normalized[axis] = {
      ...source,
      speedMmS: legacyFeedValues && Number.isFinite(speed) ? speed / 60 : speed,
    };
  });
  return normalized;
}

function axisIssues(axis, settings = {}) {
  const issues = [];
  if (!AXES.includes(axis)) return [`Unsupported axis ${axis}`];
  if (!finite(settings.minMm) || !finite(settings.maxMm) || Number(settings.minMm) >= Number(settings.maxMm)) {
    issues.push(`${axis.toUpperCase()} travel requires finite min < max`);
  }
  if (!finite(settings.speedMmS) || Number(settings.speedMmS) <= 0 || Number(settings.speedMmS) > MAX_SPEED_MM_S) {
    issues.push(`${axis.toUpperCase()} speed must be > 0 and <= ${MAX_SPEED_MM_S} mm/s`);
  }
  if (!finite(settings.accelMmS2) || Number(settings.accelMmS2) <= 0 || Number(settings.accelMmS2) > MAX_ACCEL_MM_S2) {
    issues.push(`${axis.toUpperCase()} acceleration must be > 0 and <= ${MAX_ACCEL_MM_S2} mm/s²`);
  }
  return issues;
}

function commissioningIssues(motion = {}) {
  const normalized = migrate(motion);
  const issues = AXES.flatMap((axis) => axisIssues(axis, normalized[axis]));
  ['x', 'y'].forEach((axis) => {
    if (Number(normalized[axis]?.minMm) <= -9000) issues.push(`${axis.toUpperCase()} minimum is still a placeholder`);
  });
  return issues;
}

function pointIssue(motion, requested = {}) {
  const normalized = migrate(motion);
  for (const axis of AXES) {
    if (requested[axis] === undefined || requested[axis] === null) continue;
    if (!finite(requested[axis])) return `${axis.toUpperCase()} coordinate must be finite`;
    const value = Number(requested[axis]);
    const settings = normalized[axis] || {};
    if (!finite(settings.minMm) || !finite(settings.maxMm)) return `${axis.toUpperCase()} travel limits are invalid`;
    if (value < Number(settings.minMm) || value > Number(settings.maxMm)) {
      return `${axis.toUpperCase()}${value} is outside configured travel ${settings.minMm}–${settings.maxMm} mm`;
    }
  }
  return '';
}

function speedIssue(speedMmS) {
  if (!finite(speedMmS) || Number(speedMmS) <= 0 || Number(speedMmS) > MAX_SPEED_MM_S) {
    return `Speed must be > 0 and <= ${MAX_SPEED_MM_S} mm/s`;
  }
  return '';
}

function timeoutIssue(timeoutMs) {
  if (!finite(timeoutMs) || Number(timeoutMs) < 1000 || Number(timeoutMs) > MAX_TIMEOUT_MS) {
    return `Motion timeout must be between 1000 and ${MAX_TIMEOUT_MS} ms`;
  }
  return '';
}

function feedMmMin(speedMmS) {
  const issue = speedIssue(speedMmS);
  if (issue) throw new Error(issue);
  return Number(speedMmS) * 60;
}

module.exports = {
  AXES, MOTION_UNITS_VERSION, MAX_SPEED_MM_S, MAX_ACCEL_MM_S2, MAX_TIMEOUT_MS,
  finite, migrate, axisIssues, commissioningIssues, pointIssue, speedIssue, timeoutIssue, feedMmMin,
};
