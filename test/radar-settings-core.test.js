'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const core = require('../radar-settings-core');

// index.html loads this module as a normal browser script. Verify that path
// publishes the API even when CommonJS globals are unavailable.
const browserContext = {};
vm.createContext(browserContext);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, '..', 'radar-settings-core.js'), 'utf8'),
  browserContext
);
assert.ok(browserContext.RadarSettingsCore, 'browser script must expose RadarSettingsCore');
assert.strictEqual(browserContext.RadarSettingsCore.normalizeGainCode('0x83'), 0x83);

assert.strictEqual(core.normalizeGainCode('0x33'), 0x33);
assert.strictEqual(core.normalizeGainCode(0x93), 0x93);
assert.throws(() => core.normalizeGainCode(0x34), /Gain must be one of/);
assert.strictEqual(core.normalizeThreshold('100'), 100);
assert.strictEqual(core.normalizeThreshold(16), 16);
assert.throws(() => core.normalizeThreshold(15), /16 to 1022/);
assert.throws(() => core.normalizeThreshold(1023), /16 to 1022/);
assert.strictEqual(core.normalizeLd021OutputTimeMs('5000'), 5000);
assert.strictEqual(core.normalizeLd021OutputTimeMs(0), 0);
assert.strictEqual(core.normalizeLd021OutputTimeMs(6553500), 6553500);
assert.throws(() => core.normalizeLd021OutputTimeMs(5050), /100 ms steps/);
assert.throws(() => core.normalizeLd021OutputTimeMs(6553600), /0 to 6553500/);

const verified = {
  success: true,
  protocolProfile: 'moresense-hci-v2',
  sensors: {
    A: { online: true, verified: true, gainCode: 0x43, threshold: 125, outputTimeMs: 2000, powerCode: 0 },
    B: { online: true, verified: true, gainCode: 0x43, threshold: 125, outputTimeMs: 2000, powerCode: 0 },
  },
};
assert.strictEqual(core.verifiedPair(verified), true);
assert.strictEqual(core.verifiedPair({ ...verified, sensors: { ...verified.sensors, B: { ...verified.sensors.B, threshold: 126 } } }), false);
const snapshot = core.traceabilitySnapshot(verified);
assert.strictEqual(snapshot.verifiedPair, true);
assert.strictEqual(snapshot.sensors.A.gainCode, 0x43);

const singleVerified = {
  success: true,
  activeTarget: 'single',
  activeChannels: ['SINGLE'],
  sensors: { SINGLE: { online: true, verified: true, gainCode: 0x53, threshold: 150 } },
};
assert.strictEqual(core.verifiedPair(singleVerified), true);
assert.strictEqual(core.verifiedPair({ ...singleVerified, sensors: { SINGLE: { ...singleVerified.sensors.SINGLE, online: false } } }), false);

const ld021Verified = {
  success: true,
  protocolProfile: core.LD021_PROTOCOL_PROFILE,
  activeTarget: 'ld021',
  sensors: { LD021: { online: true, verified: true, gainCode: null, threshold: 512, outputTimeMs: 5000 } },
};
assert.strictEqual(core.verifiedPair(ld021Verified), true);
assert.strictEqual(core.normalizeThreshold(0xFFFFFF, core.LD021_PROTOCOL_PROFILE), 0xFFFFFF);
assert.throws(() => core.normalizeThreshold(0, core.LD021_PROTOCOL_PROFILE), /1 to 16777215/);
assert.strictEqual(core.traceabilitySnapshot(ld021Verified).sensors.LD021.gainCode, null);
assert.deepStrictEqual(core.traceabilitySnapshot(singleVerified).activeChannels, ['SINGLE']);

const ld021BVerified = {
  success: true,
  protocolProfile: core.LD021_PROTOCOL_PROFILE,
  activeTarget: 'ld021_b',
  activeChannels: ['LD021_B'],
  sensors: { LD021_B: { online: true, verified: true, gainCode: null, threshold: 700 } },
};
assert.strictEqual(core.verifiedPair(ld021BVerified), true);
assert.deepStrictEqual(core.traceabilitySnapshot(ld021BVerified).activeChannels, ['LD021_B']);
assert.strictEqual(core.traceabilitySnapshot(ld021BVerified).sensors.LD021_B.threshold, 700);

const ld021PairVerified = {
  success: true,
  protocolProfile: core.LD021_PROTOCOL_PROFILE,
  activeTarget: 'ld021_pair',
  sensors: {
    LD021_A: { online: true, verified: true, threshold: 700, outputTimeMs: 5000 },
    LD021_B: { online: true, verified: true, threshold: 700, outputTimeMs: 5000 },
  },
};
assert.strictEqual(core.verifiedPair(ld021PairVerified), true);
assert.strictEqual(core.verifiedPair({ ...ld021PairVerified, sensors: {
  ...ld021PairVerified.sensors, LD021_B: { ...ld021PairVerified.sensors.LD021_B, outputTimeMs: 5100 },
} }), false, 'paired LD021 verification must include matching HIGH time');

const rcwlSingleVerified = {
  success: true,
  protocolProfile: core.FIXED_OUTPUT_PROFILE,
  activeTarget: 'rcwl_single',
  sensors: { RCWL_SINGLE: { online: true, verified: true } },
};
assert.strictEqual(core.verifiedPair(rcwlSingleVerified), true);
assert.strictEqual(core.verifiedPair({ ...rcwlSingleVerified, sensors: { RCWL_SINGLE: { online: false } } }), false);
assert.deepStrictEqual(core.traceabilitySnapshot(rcwlSingleVerified).activeChannels, ['RCWL_SINGLE']);
const rcwlDualVerified = {
  success: true,
  protocolProfile: core.FIXED_OUTPUT_PROFILE,
  activeTarget: 'rcwl_dual',
  sensors: { RCWL_A: { online: true, verified: true }, RCWL_B: { online: true, verified: true } },
};
assert.strictEqual(core.verifiedPair(rcwlDualVerified), true);
assert.strictEqual(core.verifiedPair({ ...rcwlDualVerified, sensors: { ...rcwlDualVerified.sensors, RCWL_B: { online: false } } }), false);
assert.deepStrictEqual(core.traceabilitySnapshot(rcwlDualVerified).activeChannels, ['RCWL_A', 'RCWL_B']);
const rcwlPairVerified = { ...rcwlDualVerified, activeTarget: 'rcwl_pair' };
assert.strictEqual(core.verifiedPair(rcwlPairVerified), true);
assert.deepStrictEqual(core.traceabilitySnapshot(rcwlPairVerified).activeChannels, ['RCWL_A', 'RCWL_B']);

console.log('radar settings core tests passed');
