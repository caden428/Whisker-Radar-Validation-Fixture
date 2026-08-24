'use strict';

const { PHASES } = require('./run-controller');

class ContractError extends Error {
  constructor(channel, message) { super(`${channel}: ${message}`); this.name = 'ContractError'; this.code = 'ERR_IPC_CONTRACT'; }
}

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function finite(value) { return value !== '' && value !== null && value !== undefined && Number.isFinite(Number(value)); }
function text(value, name, max = 500) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\r\n\0]/.test(value)) throw new Error(`${name} is invalid`);
  return value.trim();
}
function integer(value, name, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return number;
}

const validators = {
  'config:patch'(payload) {
    if (!plainObject(payload) || !plainObject(payload.patch)) throw new Error('request and patch must be objects');
    return { ...payload, expectedRevision: integer(payload.expectedRevision, 'expectedRevision', 1, Number.MAX_SAFE_INTEGER) };
  },
  'test-plan:save'(payload) {
    if (!plainObject(payload) || !plainObject(payload.plan)) throw new Error('plan must be an object');
    text(payload.plan.id, 'plan id', 160); text(payload.plan.name, 'plan name', 160);
    return payload;
  },
  'test-plan:delete'(payload) {
    if (!plainObject(payload)) throw new Error('request must be an object');
    return { planId: text(payload.planId, 'planId', 160) };
  },
  'moonraker:connect'(payload) {
    if (!plainObject(payload)) throw new Error('request must be an object');
    return { host: text(payload.host, 'host', 253), port: integer(payload.port, 'port', 1, 65535) };
  },
  'run:transition'(payload) {
    if (!plainObject(payload) || !PHASES.has(payload.phase)) throw new Error('phase is unsupported');
    if (payload.progress !== undefined && !plainObject(payload.progress)) throw new Error('progress must be an object');
    return { phase: payload.phase, progress: payload.progress || {} };
  },
  'radar-settings:apply'(payload) {
    if (!plainObject(payload) || !finite(payload.threshold)) throw new Error('threshold must be finite');
    if (payload.gainCode !== undefined && payload.gainCode !== null && !finite(payload.gainCode)) throw new Error('gainCode must be finite when supplied');
    if (payload.outputTimeMs !== undefined && payload.outputTimeMs !== null && !finite(payload.outputTimeMs)) throw new Error('outputTimeMs must be finite when supplied');
    return payload;
  },
  'campaign:write'(payload) {
    if (!plainObject(payload)) throw new Error('campaign input must be an object');
    if (payload.name !== undefined) text(payload.name, 'campaign name', 160);
    if (payload.dutId !== undefined && typeof payload.dutId !== 'string') throw new Error('dutId must be text');
    return payload;
  },
  'file:saveCSV'(payload) {
    if (!plainObject(payload) || typeof payload.data !== 'string' || payload.data.length > 50 * 1024 * 1024) throw new Error('CSV data must be text no larger than 50 MB');
    const defaultName = text(payload.defaultName || 'observations.csv', 'defaultName', 180);
    if (/[\\/]/.test(defaultName)) throw new Error('defaultName must not contain a path');
    return { data: payload.data, defaultName };
  },
};

function validate(channel, payload) {
  try {
    const validator = validators[channel];
    if (!validator) throw new Error('no runtime contract is registered');
    return { success: true, value: validator(payload) };
  } catch (error) {
    const contractError = new ContractError(channel, error?.message || String(error));
    return { success: false, error: contractError.message, code: contractError.code };
  }
}

module.exports = { ContractError, validate, plainObject, finite, text, integer };
