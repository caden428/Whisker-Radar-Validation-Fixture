'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'renderer-store.js'), 'utf8'), sandbox);
vm.runInContext(fs.readFileSync(path.join(root, 'configuration-draft.js'), 'utf8'), sandbox);

const store = sandbox.window.RendererStore.createStore({});
const sourceConfig = { motion: { commissioned: false }, test: { mode: 'characterization' } };
store.dispatch({ type: 'CONFIG_LOADED', config: sourceConfig });
sourceConfig.motion.commissioned = true;
assert.strictEqual(store.getState().config.motion.commissioned, false, 'store state must not alias mutable renderer inputs');

const draft = sandbox.window.ConfigurationDraft.open(store.getState().config);
draft.motion.commissioned = true;
assert.strictEqual(store.getState().config.motion.commissioned, false, 'configuration edits must remain isolated until commit');
const restored = sandbox.window.ConfigurationDraft.discard();
assert.strictEqual(restored.motion.commissioned, false);

const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
assert.ok(main.includes("ipcMain.handle('config:patch'") && main.includes('expectedRevision !== configRevision'));
assert.ok(preload.includes("ipcRenderer.invoke('config:patch'"));
assert.ok(main.includes("require('./smoke-test-harness')") && html.includes('campaign.css'));

console.log('renderer architecture tests passed');
