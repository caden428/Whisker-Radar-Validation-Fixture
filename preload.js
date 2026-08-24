const { contextBridge, ipcRenderer } = require('electron');
let configRevision = 0;
const CONFIG_PATCH_ROOTS = ['connection', 'motion', 'trigger', 'test', 'dut', 'validation', 'radar', 'radarService', 'sequences', 'activeSequence', 'logging', 'recipes', 'testPlans', 'ssh'];

async function configGet() {
  const config = await ipcRenderer.invoke('config:get');
  configRevision = Number(config?._revision) || configRevision;
  return config;
}

async function configSet(config) {
  const patch = Object.fromEntries(CONFIG_PATCH_ROOTS.filter((key) => Object.hasOwn(config || {}, key)).map((key) => [key, config[key]]));
  const result = await ipcRenderer.invoke('config:patch', { expectedRevision: configRevision, patch });
  if (result?.config?._revision) configRevision = Number(result.config._revision);
  return result;
}

async function testPlanSave(plan) {
  const result = await ipcRenderer.invoke('test-plan:save', { plan });
  if (result?.config?._revision) configRevision = Number(result.config._revision);
  return result;
}
async function testPlanDelete(planId) {
  const result = await ipcRenderer.invoke('test-plan:delete', { planId });
  if (result?.config?._revision) configRevision = Number(result.config._revision);
  return result;
}

// This is the renderer's complete security boundary. Each exposed method maps
// a narrowly scoped browser call to one main-process IPC channel; renderer code
// never receives direct Node.js, filesystem, shell, or Electron access.
contextBridge.exposeInMainWorld('radarAPI', {
  // Config
  configGet,
  configSet,
  testPlanList:   ()       => ipcRenderer.invoke('test-plan:list'),
  testPlanSave,
  testPlanDelete,

  // Connection
  connect:    (host, port) => ipcRenderer.invoke('moonraker:connect', { host, port }),
  disconnect: ()           => ipcRenderer.invoke('moonraker:disconnect'),

  // Motion
  jog:              (axis, deltaMm, feedMmS)      => ipcRenderer.invoke('moonraker:jog', { axis, deltaMm, feedMmS }),
  moveAndWait:      (x, y, z, feedMmS, timeoutMs) => ipcRenderer.invoke('moonraker:moveAndWait', { x, y, z, feedMmS, timeoutMs }),
  home:             (axes)                        => ipcRenderer.invoke('moonraker:home', { axes }),
  zeroZ:            ()                            => ipcRenderer.invoke('moonraker:zeroZ'),
  trigger:          (spinFeedMmMin)              => ipcRenderer.invoke('moonraker:trigger', { spinFeedMmMin }),

  // Radar
  readRadar:        ()                            => ipcRenderer.invoke('radar:read'),
  readRadarSettings: ()                           => ipcRenderer.invoke('radar-settings:read'),
  applyRadarSettings:(gainCode, threshold, protocolProfile, outputTimeMs) => ipcRenderer.invoke('radar-settings:apply', { gainCode, threshold, protocolProfile, outputTimeMs }),
  saveRadarSettings: ()                           => ipcRenderer.invoke('radar-settings:save'),
  resetRadarSettings:(confirmation)                => ipcRenderer.invoke('radar-settings:reset', confirmation),
  readLd021Power:   ()                             => ipcRenderer.invoke('ld021-power:read'),
  setLd021PowerA:   (enabled)                      => ipcRenderer.invoke('ld021-power:set', 'LD021_A', enabled),
  setLd021PowerB:   (enabled)                      => ipcRenderer.invoke('ld021-power:set', 'LD021_B', enabled),
  setLd021PowerBoth:(enabled)                      => ipcRenderer.invoke('ld021-power:set', 'BOTH', enabled),
  emergencyLd021PowerOff: ()                       => ipcRenderer.invoke('ld021-power:emergencyOff'),
  readSensor:       ()                            => ipcRenderer.invoke('sensor:read'),
  setVelocityLimit: (velocity, accel)             => ipcRenderer.invoke('moonraker:setVelocityLimit', { velocity, accel }),
  setGcodeOffset:   (x, y, z)                     => ipcRenderer.invoke('moonraker:setGcodeOffset', { x, y, z }),
  beginQualificationRun: (metadata)               => ipcRenderer.invoke('motion:beginQualificationRun', metadata),
  endQualificationRun:   ()                       => ipcRenderer.invoke('motion:endQualificationRun'),
  runStatus:             ()                       => ipcRenderer.invoke('run:status'),
  runTransition:         (phase, progress)         => ipcRenderer.invoke('run:transition', phase, progress),
  abortRun:              (reason)                  => ipcRenderer.invoke('run:abort', reason),
  resolveRunRecovery:    (reason)                  => ipcRenderer.invoke('run:resolveRecovery', reason),
  estop:            ()                            => ipcRenderer.invoke('moonraker:estop'),
  firmwareRestart:  ()                            => ipcRenderer.invoke('moonraker:firmwareRestart'),

  // Test mode
  setTestMode: async (mode) => {
    const cfg = await configGet();
    cfg.test = { ...(cfg.test || {}), mode };
    return configSet(cfg);
  },

  // SSH reference
  copySSHCommand: (host, username, port) => ipcRenderer.invoke('ssh:copyCommand', { host, username, port }),

  // Logging / export
  logStart:          (manifest)   => ipcRenderer.invoke('log:start', manifest),
  logWrite:          (row)        => ipcRenderer.invoke('log:write', row),
  logClose:          (summary)    => ipcRenderer.invoke('log:close', summary),
  getLogPath:        ()           => ipcRenderer.invoke('log:getPath'),
  readCurrentLog:    ()           => ipcRenderer.invoke('log:readCurrent'),
  revealLogInFolder: ()           => ipcRenderer.invoke('log:revealInFolder'),
  openReport:        ()           => ipcRenderer.invoke('log:openReport'),
  saveCSV:           (data, name) => ipcRenderer.invoke('file:saveCSV', { data, defaultName: name }),

  // Campaigns
  campaignStatus:     ()           => ipcRenderer.invoke('campaign:status'),
  campaignStart:      (input)      => ipcRenderer.invoke('campaign:start', input),
  campaignUpdate:     (input)      => ipcRenderer.invoke('campaign:update', input),
  campaignArchive:    ()           => ipcRenderer.invoke('campaign:archive'),
  campaignSetAutoRun: (enabled)    => ipcRenderer.invoke('campaign:setAutoRun', { enabled }),

  // App
  getVersion: () => ipcRenderer.invoke('app:version'),

  // Events → renderer
  onStatus:  (cb) => ipcRenderer.on('moonraker:status', (_, d) => cb(d)),
  onLogPath: (cb) => ipcRenderer.on('log:path', (_, p) => cb(p)),
  onRunState:(cb) => ipcRenderer.on('run:state', (_, state) => cb(state)),

  // Removes subscriptions during teardown or reload to prevent duplicate UI updates.
  removeAllListeners: () => {
    ['moonraker:status', 'log:path', 'run:state'].forEach((ch) => ipcRenderer.removeAllListeners(ch));
  },
});
