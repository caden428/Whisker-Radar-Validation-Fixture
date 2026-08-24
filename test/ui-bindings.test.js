'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

// Load the authored UI sources as text. These tests intentionally avoid a
// browser so structural wiring errors can be caught quickly in Node.js.
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
const runNaming = fs.readFileSync(path.join(root, 'run-naming-core.js'), 'utf8');
const campaignManager = fs.readFileSync(path.join(root, 'campaign-manager.js'), 'utf8');
const recipeCore = fs.readFileSync(path.join(root, 'recipe-core.js'), 'utf8');
const testPlanCore = fs.readFileSync(path.join(root, 'test-plan-core.js'), 'utf8');
const operatorFlowState = fs.readFileSync(path.join(root, 'operator-flow-state.js'), 'utf8');
const runWorkspaceCore = fs.readFileSync(path.join(root, 'run-workspace-core.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const runStateView = fs.readFileSync(path.join(root, 'run-state-view.js'), 'utf8');

// Every HTML ID must be unique or DOM lookups and event binding become ambiguous.
const htmlIds = [...`${html}\n${runStateView}`.matchAll(/\bid=["']([^"']+)["']/g)].map((match) => match[1]);
const duplicateIds = [...new Set(htmlIds.filter((id, index) => htmlIds.indexOf(id) !== index))];
assert.deepStrictEqual(duplicateIds, [], `duplicate HTML IDs: ${duplicateIds.join(', ')}`);
assert.ok(
  html.includes('id="quick-recipe-select"')
    && html.includes('id="campaign-recipe-select"')
    && html.includes('id="recipe-builder"')
    && html.includes('<script src="recipe-core.js"></script>')
    && html.includes('<script src="test-plan-core.js"></script>')
    && renderer.includes('RecipeCore.apply(config, recipe)')
    && renderer.includes('method.recipeSnapshot')
    && recipeCore.includes('function saveCustom'),
  'single runs and campaigns must share versioned reusable test-plan snapshots while legacy recipe storage remains migratable'
);
assert.ok(
  html.includes('<script src="operator-flow-state.js"></script>')
    && operatorFlowState.includes('function reduce')
    && operatorFlowState.includes('function reconcile')
    && renderer.includes('function dispatchGuided(action)')
    && renderer.includes('function renderGuidedFlowState()')
    && !renderer.includes("addEventListener('change', () => populateGuided"),
  'operator dropdowns must use one explicit state transition and one targeted render instead of nested population cascades'
);
const guidedDispatchBody = renderer.slice(renderer.indexOf('function dispatchGuided(action)'), renderer.indexOf('function populateGuidedOperatorPath()'));
assert.ok(!guidedDispatchBody.includes('configSet(') && !guidedDispatchBody.includes('renderSpatialResults') && !guidedDispatchBody.includes('renderPlanPreviewCanvas'),
  'dropdown transitions must not persist configuration, generate motion, or redraw result canvases');
assert.ok(
  html.includes('id="guided-prepare-btn" type="button">Save &amp; Preview Grid</button>')
    && html.includes('id="guided-run-btn" type="button" disabled>Run Test</button>')
    && renderer.includes('async function runPreparedGuidedTest()')
    && renderer.includes("addEventListener('click', prepareGuidedOperatorPath)")
    && renderer.includes("addEventListener('click', runPreparedGuidedTest)")
    && html.includes('class="advanced-operator-controls" hidden')
    && html.includes('id="config-recipe-tab" data-tab="recipe" hidden'),
  'normal operation must save and preview separately from starting fixture motion while duplicate legacy plan workflows remain inaccessible'
);
assert.ok(main.includes("ipcMain.handle('test-plan:save'") && main.includes('await saveConfigAsync')
  && preload.includes('testPlanSave') && preload.includes('testPlanDelete'),
  'test-plan changes must use narrow asynchronous repository IPC instead of broad synchronous configuration persistence');
assert.ok(
  testPlanCore.includes('function normalizePlan')
    && testPlanCore.includes('function normalizeRunSetup')
    && testPlanCore.includes('function createPreparedRun')
    && renderer.includes('function activeTestPlan()')
    && renderer.includes('function currentRunSetup()')
    && !renderer.includes('RecipeCore.fromConfig(config)'),
  'saved plans, operator setup, and prepared execution must have explicit contracts instead of reconstructing plans from mutable configuration'
);
assert.ok(
  html.includes('<script src="run-workspace-core.js"></script>')
    && runWorkspaceCore.includes('function catalogFromLegacy')
    && runWorkspaceCore.includes('function createDraft')
    && runWorkspaceCore.includes('function prepare')
    && renderer.includes('let currentPreparedRun = null')
    && renderer.includes('RunWorkspaceCore.prepare({')
    && renderer.includes('currentPreparedRun?.plan || activeTestPlan()'),
  'reusable catalog plans, operator drafts, and immutable prepared execution snapshots must remain separate runtime objects'
);
assert.ok(html.includes('id="operator-path"')
  && html.includes('id="guided-layout"')
  && html.includes('id="guided-sensor"')
  && html.includes('id="guided-dut-location"')
  && html.includes('id="guided-dut-step"')
  && html.includes('id="guided-test-type"')
  && html.includes('id="guided-test-plan"')
  && html.includes('id="guided-derived-name"')
  && html.includes('id="guided-output-name"')
  && html.includes('id="guided-readiness"')
  && html.includes('id="guided-manage-plans-btn"')
  && html.includes('id="guided-prepare-btn"')
  && html.includes('id="guided-run-btn"')
  && renderer.includes('OperatorFlowCore.compatiblePlans')
  && renderer.includes('RecipeCore.createDerived')
  && renderer.includes('function guidedOutputNamePreview')
  && renderer.includes('function openGuidedPlanManager()')
  && renderer.includes("openConfigModal('sequence')"),
  'the progressive operator path must filter plans, preserve named derivatives, review output naming and readiness, and open plan management directly');
assert.ok(
  html.includes('id="engineering-plan-select"')
    && html.includes('id="engineering-plan-new-btn"')
    && html.includes('id="engineering-plan-duplicate-btn"')
    && html.includes('id="engineering-plan-rename-btn"')
    && html.includes('id="engineering-plan-delete-btn"')
    && html.includes('id="engineering-plan-mode"')
    && html.includes('id="engineering-plan-description"')
    && renderer.includes('function populateEngineeringPlanSelect')
    && renderer.includes('function saveEngineeringPlanIfChanged')
    && renderer.includes('function renderEngineeringPlanEditorState')
    && renderer.includes('refreshGuidedPlanOptionsPreservingInputs()'),
  'the explicit Test Plan editor and Run a Test must edit and select the same versioned plan records without overwriting operator input'
);
assert.ok(
  html.includes('<label>Test type</label>')
    && html.includes('id="cfg-test-mode"')
    && !html.match(/class="form-row builder-main-owned"[^>]*>\s*<label>Test (?:mode|type)/)
    && renderer.includes("document.getElementById('cfg-test-mode').addEventListener('change'")
    && renderer.includes("apply.textContent = planTab ? 'Save Test Plan' : 'Apply Settings'"),
  'creating a plan must expose test type and clearly use plan-specific save language'
);
assert.ok(
  html.indexOf('id="engineering-plan-select"') < html.indexOf('id="seq-select"')
    && html.includes('Linked motion sequence'),
  'raw motion sequences must remain subordinate implementation details of shared test plans'
);
['guided-dut-id', 'guided-plan-points', 'guided-plan-cycles', 'guided-plan-pass', 'guided-bound-min-x', 'guided-bound-max-x', 'guided-bound-min-y', 'guided-bound-max-y', 'guided-derived-name'].forEach((id) => {
  const tag = html.match(new RegExp(`<input[^>]*id=["']${id}["'][^>]*>`))?.[0] || '';
  assert.ok(tag && !/\b(?:readonly|disabled)\b/.test(tag), `${id} must remain directly editable`);
});
assert.ok(['cfg-plan-min-x', 'cfg-plan-max-x', 'cfg-plan-min-y', 'cfg-plan-max-y'].every((id) => html.includes(`id="${id}"`))
  && renderer.includes('function guidedBoundsIssue')
  && renderer.includes('function movementBoundsIssue')
  && renderer.includes('characterizationBounds: { ...draft.bounds }'),
  'Test Plans and Run a Test must edit, derive, persist, and enforce reflector movement bounds');
assert.ok(html.includes('id="guided-plan-layout"') && html.includes('id="cfg-plan-distribution"')
  && renderer.includes('pointLayout: document.getElementById(\'guided-plan-layout\').value')
  && renderer.includes('distribution: draft.pointLayout')
  && renderer.includes("pointDistribution: document.getElementById('cfg-plan-distribution').value"),
  'Test Plans and Run a Test must expose, derive, persist, and execute the selected point layout');
assert.ok(renderer.includes('function scheduleGuidedDraftPreview()')
  && renderer.includes('function scheduleEngineeringPlanPreview()')
  && renderer.includes('function scheduleQuickPointPreview()')
  && renderer.includes("document.getElementById('quick-point-count').addEventListener('input', scheduleQuickPointPreview)")
  && renderer.includes("'cfg-plan-distribution', 'cfg-plan-min-x', 'cfg-plan-max-x'")
  && renderer.includes("renderPlanPreviewCanvas(preview.points, preview.summary || '', 'seq-plan-preview')")
  && renderer.includes("renderPlanPreviewCanvas(preview.points, preview.summary || '', 'quick-formal-preview')"),
  'point layout and bound edits must immediately refresh both plan preview graphs');
assert.ok(html.includes('id="guided-plan-preview"')
  && renderer.includes("renderPlanPreviewCanvas(preview.points, preview.summary || '', 'guided-plan-preview')")
  && renderer.includes("document.getElementById('guided-plan-points'")
  && renderer.includes('scheduleGuidedDraftPreview();'),
  'guided step 7 must expose and live-update its own visible point-grid preview');
assert.ok(renderer.includes("if (distribution === 'grid' && xMin !== xMax && yMin !== yMax)")
  && renderer.includes("distribution !== 'grid' && xMin !== xMax && yMin !== yMax")
  && renderer.includes("'row-and-column aligned raster'"),
  'Raster grid must retain a row-and-column lattice instead of falling through to irregular Halton sampling');
assert.ok(renderer.includes('function testPreflight(') && renderer.includes('const preflight = testPreflight();'),
  'the Run button must use the authoritative preflight result');
assert.ok(renderer.includes('DUT-${safeDut}_${sensor}_${labels[draft?.testType]')
  && renderer.includes("'moresense-dual': 'MORESENSE-DUAL'")
  && renderer.includes("hardware?.fixedOutput ? 'FIXED'"),
  'output preview must show the approved DUT, sensor, test, plan, settings, cycles, date, and time convention');
assert.ok(
  html.indexOf('id="guided-layout"') < html.indexOf('id="guided-sensor"')
    && html.indexOf('id="guided-sensor"') < html.indexOf('id="guided-dut-location"')
    && html.indexOf('id="guided-dut-location"') < html.indexOf('id="guided-dut-id"')
    && html.indexOf('id="guided-dut-id"') < html.indexOf('id="guided-test-type"')
    && html.indexOf('id="guided-test-type"') < html.indexOf('id="guided-test-plan"')
    && html.indexOf('id="guided-test-plan"') < html.indexOf('id="guided-output-name"')
    && html.indexOf('id="guided-output-name"') < html.indexOf('id="guided-readiness"'),
  'Run a Test must retain the approved question, plan review, output review, and readiness order'
);
assert.ok(renderer.includes('function populateCampaignTestPlanOptions')
  && renderer.includes("plan.family === testType")
  && html.includes('<label>Test plan<select id="campaign-recipe-select">'),
  'campaigns must select the same test-plan catalog filtered by test type');
assert.ok(
  html.indexOf('Fixture Connection (Moonraker)') < html.indexOf('class="card campaign-card"'),
  'fixture connection must be the first setup card, before campaign controls'
);

// Every literal getElementById reference must resolve to an element in index.html.
const referencedIds = [...renderer.matchAll(/getElementById\(["']([^"']+)["']\)/g)].map((match) => match[1]);
const missingIds = [...new Set(referencedIds.filter((id) => !htmlIds.includes(id)))];
assert.deepStrictEqual(missingIds, [], `renderer references missing HTML IDs: ${missingIds.join(', ')}`);

// Configuration navigation buttons and their content panels must stay paired.
const tabs = [...html.matchAll(/data-tab=["']([^"']+)["']/g)].map((match) => match[1]);
const panels = [...html.matchAll(/data-tab-panel=["']([^"']+)["']/g)].map((match) => match[1]);
assert.deepStrictEqual([...tabs].sort(), [...panels].sort(), 'configuration tabs and panels must match');

// High-value behavioral assertions guard hardware safety and report contracts
// that are easy to break during otherwise unrelated UI refactoring.
assert.ok(main.includes('SET_KINEMATIC_POSITION Z=0\\n${config.trigger.macro}'), 'every reflector trigger must reset logical Z before spinning');
assert.ok(main.includes('${config.trigger.macro} SPEED=${feed}\\nM400'), 'the post-spin wait must start only after reflector motion completes');
assert.ok(main.includes('delayMs: 3500') && main.includes('holdMsDefault: 3500'), 'the commissioned point cycle must use 3.5-second pre- and post-spin waits');
assert.ok(renderer.includes('const baselinePromise = waitForRadarLow(preSpinWaitMs)') && renderer.includes('await sleep(preSpinWaitMs)'), 'the LOW check must run inside the fixed post-move wait');
assert.ok(renderer.includes('const postSpinWaitPromise = sleep(postSpinWaitMs)') && renderer.includes('await postSpinWaitPromise'), 'the runner must wait after the completed spin before moving');
assert.ok(renderer.includes('Radar Trigger Map — Yes / No'), 'characterization must use trigger-only spatial labeling');

assert.ok(
  main.includes("inside: '10.1'")
    && main.includes("outside: '10.2'")
    && main.includes("characterization: 'characterization'"),
  'category folders must identify the test type'
);
assert.ok(
  main.includes("require('./run-naming-core')")
    && runNaming.includes("inside: '10.1'")
    && runNaming.includes("outside: '10.2'")
    && runNaming.includes("characterization: 'CHAR'"),
  'run folders must use the shared operator-facing test identifiers'
);
assert.ok(main.includes("report.testId === 'outside' ? ''"), 'Test 10.2 reports must omit the latency heatmap');
assert.ok(
  main.includes("x:+G.systemReference?.x")
    && main.includes("label:'DUT center'"),
  'reports must use the center of the selected DUT location'
);
assert.ok(
  html.includes('id="cfg-dut-location"')
    && renderer.includes('DutLocationCore.safeRoute')
    && main.includes("code: 'ERR008'"),
  'the selected DUT location must protect endpoints and automated travel paths'
);
assert.ok(main.includes('function drawDut(q,X,Y,label=true)') && !main.includes('function drawSensors'), 'reports must draw the dimensionally accurate DUT instead of individual sensor origins');
assert.ok(main.includes('boundaryShapes:') && main.includes('spatialCredible()'), 'formal reports must preserve and draw DUT-level system boundaries');
assert.ok(main.includes('The dimensionally accurate DUT footprint uses the selected DUT location'), 'reports must state that the DUT footprint does not alter measured data');
assert.ok(
  main.includes("if(showDutFootprint){const l=X(DB.minX),r=X(DB.maxX),t=Y(DB.maxY),b=Y(DB.minY);q.fillStyle='#f8fafc';q.fillRect"),
  'latency reports must mask the complete DUT footprint out of the interpolated heatmap'
);
assert.ok(main.includes('width="3200" height="1800"') && main.includes('function smoothClosedPath'), 'formal spatial plots must export at high resolution with smooth boundaries');
assert.ok(
  main.includes("q.fillText('RESULT KEY'")
    && main.includes("q.fillText(showDutFootprint?'DUT FOOTPRINT':'SINGLE SENSOR'")
    && main.includes("q.fillText('Y position (mm)',left,top-12)")
    && main.includes("q.moveTo(px-5,py-5);q.lineTo(px+5,py+5)"),
  'formal plots must reserve annotation space, use horizontal labels, and distinguish failures without color alone'
);
assert.ok(
  renderer.includes("validationZone === 'outside' && geometry.guardBandMm")
    && renderer.includes("drawWorldLobe(geometry.radiusMm+geometry.guardBandMm"),
  'single-sensor Test 10.2 previews must draw the configured outer guard depth'
);
assert.ok(
  html.includes('id="campaign-name-input"')
    && html.includes('id="campaign-dut-input"')
    && html.includes('<script src="text-input-core.js"></script>'),
  'campaign text controls and shared text-input support must remain available'
);
assert.ok(
  styles.includes('.campaign-step-card input[type="text"]')
    && styles.includes('caret-color: #ffffff')
    && styles.includes('caret-color: var(--cyan)'),
  'campaign text fields must show a high-contrast caret before and during focus'
);
assert.ok(
  main.includes('campaignResult = CampaignLedger.recordCampaign')
    && main.includes('Saved locally to report.html and observations.csv')
    && !main.includes('CampaignLedger.syncPending')
    && !preload.includes("ipcRenderer.on('campaign:sync-status'"),
  'campaign completion must record local HTML/CSV artifacts without remote synchronization'
);
assert.ok(
  html.includes('id="campaign-auto-run-input"')
    && html.includes('id="campaign-auto-run-toggle"')
    && renderer.includes('async function runAutomaticCampaign()')
    && renderer.includes('applyAndVerifyRadarSettings(status.next.gainCode, status.next.threshold')
    && renderer.includes('completion?.localCampaignComplete')
    && renderer.includes('completion.operationalFailure')
    && main.includes("ipcMain.handle('campaign:setAutoRun'")
    && preload.includes("ipcRenderer.invoke('campaign:setAutoRun'"),
  'Auto Run must be explicit, persistent, settings-verified, locally durable, and safety-stopping'
);
assert.ok(
  renderer.includes('const invalidRetryQueue = []')
    && renderer.includes('attemptNumber <= 4')
    && renderer.includes('Resolved on retry')
    && renderer.includes('Auto Run was disabled and will not retry this condition'),
  'invalid acquisition must retry only after the normal plan, cap retries at three, and stop Auto Run on unresolved conditions'
);
assert.ok(
  main.includes('campaign: config.campaign')
    && main.includes('Never let a later settings save')
    && renderer.indexOf('campaignOperatorStatus = result;') < renderer.indexOf('config = await radarAPI.configGet();', renderer.indexOf('campaignOperatorStatus = result;')),
  'ordinary renderer config saves must not roll back main-process-owned Auto Run campaign state'
);
assert.ok(
  main.includes("new Set(['EPERM', 'EACCES', 'EBUSY'])")
    && main.includes('await renameWithRetry(runDirectory, finalDirectory)'),
  'completed run folders must retry transient Windows lock errors before stopping Auto Run'
);
assert.ok(main.includes('.table-wrap{max-height:none!important;height:auto!important;overflow:visible!important}'), 'printed reports must expand the complete raw-observation table');
assert.ok(main.includes('break-inside:avoid-page;page-break-inside:avoid'), 'printed report sections and rows must avoid page splits');
assert.ok(renderer.includes('function buildCharacterizationPlan()'), 'characterization must support automatic point-count plans');
assert.ok(
  html.includes('id="quick-angular-zone-enabled"')
    && html.includes('id="quick-angular-zone"')
    && html.includes('id="cfg-angular-zone-enabled"')
    && renderer.includes('angularZoneEnabled: angularZone.enabled')
    && renderer.includes('ValidationCore.pointInAngularZone'),
  'automatic plans must support toggleable front, right, and left angular-zone filtering'
);
assert.ok(
  html.includes('id="campaign-angular-zone-options"')
    && campaignManager.includes("angularZones: Object.freeze(['all'])")
    && campaignManager.includes("`z${angularZone}-${baseId}`")
    && renderer.includes("angularZoneEnabled: status.next.angularZone !== 'all'"),
  'campaigns must expand and persist ordered angular-zone conditions'
);
assert.ok(renderer.includes("activeTestId() === 'characterization') await regenerateCharacterizationPlanFromOperator()"), 'characterization must regenerate after operator point-count/configuration changes');
assert.ok(
  renderer.includes('function updateEngineeringSetupEditability()')
    && renderer.includes("'#builder-plan-settings input, #builder-validation-geometry input, #builder-trigger-timing input, #system-level-barriers input'")
    && renderer.includes("if (field.id === 'cfg-radar-baseline-timeout') return;")
    && renderer.includes('field.disabled = false')
    && renderer.includes('field.readOnly = false')
    && !renderer.includes('centerY.readOnly = !characterization')
    && renderer.includes('derivedBaselineTimeout.disabled = true'),
  'Engineering Setup text fields, including sensor Y, must remain editable for every test type while preserving the derived timeout lock'
);
assert.ok(
  renderer.includes("setVisible('builder-validation-geometry', true)")
    && renderer.includes("setVisible('builder-plan-settings', true)")
    && renderer.includes("sequenceTab.textContent = 'Test Plans'")
    && renderer.includes("document.querySelector('#config-modal .modal-title').textContent = 'Engineering Settings'")
    && html.includes('id="config-sequence-tab" data-tab="sequence">Test Plans</button>')
    && renderer.includes('applyBlockedForActiveRun = testRunning')
    && html.includes('id="config-active-run-note"'),
  'Test Plan management must remain available for every test type while active runs protect their plan'
);
assert.ok(
  renderer.includes("const interferenceView = activeTestId() === 'interference'")
    && renderer.includes('const displayDutBands = systemBands || (geometry.sensorLayout === \'single\' && hasDutFootprint())')
    && renderer.includes('const showEstimatedActivationZone = !interferenceView && (!characterizationView || displayDutBands)')
    && renderer.includes('function dutReferenceBandGeometry')
    && renderer.includes('const displayBoundary = showEstimatedActivationZone')
    && renderer.includes('if (showEstimatedActivationZone) drawLobe('),
  'HLK interference characterization must not draw or frame the graph around an estimated blue activation zone'
);
assert.ok(
  renderer.includes("const characterizationView = ['characterization', 'interference'].includes(activeTestId())")
    && renderer.includes("if (['characterization', 'interference'].includes(activeTestId()))")
    && renderer.includes("setItem('cnt-tp', 'Triggered')")
    && renderer.includes("setItem('cnt-fn', 'Not Triggered')")
    && renderer.includes("document.getElementById('campaign-pass-label').hidden = characterization")
    && renderer.includes("const characterizationCampaign = ['characterization', 'interference'].includes(status.method?.testId)")
    && renderer.includes('characterization runs complete')
    && main.includes("isCharacterization=['characterization','interference'].includes(R.testId)")
    && main.includes("if(isCharacterization){repeatability();if(R.testId==='interference')spatial()}")
    && main.includes("const columns=isCharacterization?"),
  'HLK interference must use characterization-only triggered/not-triggered UI and reports without pass/fail requirements'
);
assert.ok(
  renderer.includes('geometry.centerX = dutCenter.x')
    && renderer.includes('geometry.centerY = dutCenter.y')
    && renderer.includes('const sensorX = worldX(displayGeometry.centerX)')
    && renderer.includes('const sensorY = worldY(displayGeometry.centerY)')
    && renderer.includes('const hasDutFootprint = Number(location.widthMm) > 0 && Number(location.depthMm) > 0')
    && renderer.includes('DutLocationCore.SINGLE_SENSOR_DUT_LOCATION')
    && renderer.includes('DutLocationCore.ORIGINAL_LOCATION')
    && renderer.includes('Stand-mounted sensor at ${geometry.centerX}, ${geometry.centerY}')
    && renderer.includes('const sensorMarker = geometry.sensorLayout === \'single\''),
  'the spatial graph must draw and frame the location selected for the test rather than stale geometry coordinates'
);
assert.ok(main.includes('gcode_button%20radar_sensor_a=state') && main.includes('gcode_button%20radar_sensor_b=state'), 'both radar detection inputs must be queried');
assert.ok(main.includes('gcode_button%20radar_sensor_single=state') && main.includes('gcode_button%20radar_sensor_ld021=state'), 'MS58 single and LD021 must remain separate detection inputs');
assert.ok(main.includes("ipcMain.handle('radar-settings:apply'"), 'main process must expose validated radar settings application');
assert.ok(renderer.includes('RadarSettingsCore.verifiedPair'), 'tests and saves must depend on two-sensor read-back verification');
assert.ok(html.includes('id="radar-gain-select"') && html.includes('id="radar-threshold-input"'), 'operator GUI must expose gain and threshold');
assert.ok(html.includes('id="cfg-radar-target"') && html.includes('value="single">MS58 standalone') && html.includes('value="ld021">HLK-LD021')
  && html.includes('value="rcwl_single">RCWL-0516 single') && html.includes('value="rcwl_dual">RCWL-0516 dual'),
  'engineering and campaign configuration must offer single and dual RCWL-0516 targets');
assert.ok(html.includes('value="rcwl_pair">RCWL-0516 interference pair'),
  'engineering and campaign configuration must offer the RCWL-0516 interference pair');
assert.ok(renderer.includes('triggeredSensors: ValidationCore.triggeredSensorLabel(pairA, pairB)')
  && renderer.includes('sensor output: ${observation.triggeredSensors}')
  && main.includes("['triggeredSensors','Sensor output']")
  && main.includes("'TriggeredSensors'"),
  'interference observations must identify the pair output in live results, reports, and CSV');
assert.ok(renderer.includes('updateRadarHardwareOptions') && renderer.includes("activeTarget === 'rcwl_single'")
  && renderer.includes("['rcwl_dual', 'rcwl_pair'].includes(activeTarget)"), 'RCWL hardware options must route through explicit single, dual, and pair targets');
assert.ok(main.includes("['rcwl_dual', 'rcwl_pair'].includes(target)") && main.includes("['single', 'rcwl_single'].includes(target)"),
  'RCWL targets must reuse the corresponding single or A/B detection inputs');
assert.ok(renderer.includes("method.settingsProfile === RadarSettingsCore.FIXED_OUTPUT_PROFILE")
  && renderer.includes("if (applySettings && !fixedOutput)"), 'RCWL campaigns must not attempt nonexistent settings writes');
assert.ok(html.includes('id="cfg-hilink-sensor"') && html.includes('id="cfg-hilink-sensor-row"'), 'engineering setup must expose the single-HiLink A/B connection choice');
assert.ok(renderer.includes("config.validation?.hilinkSensor === 'B' ? 'ld021_b' : 'ld021_a'"), 'renderer must route the chosen single-HiLink channel');
assert.ok(main.includes("config.validation?.hilinkSensor === 'B' ? 'ld021_b' : 'ld021_a'"), 'main process must route settings and detection through the chosen single-HiLink channel');
assert.ok(renderer.includes("config.validation?.radarTarget === 'ld021_pair') return 'ld021_pair'")
  && main.includes("config.validation?.radarTarget === 'ld021_pair') return 'ld021_pair'")
  && html.includes('<script src="operator-flow-core.js"></script>'),
  'a dual system-level DUT must be able to route two HLK-LD021 channels while retaining dual geometry');
assert.ok(html.includes('id="radar-settings-save"'), 'operator GUI must provide an explicit persistent-save action');
assert.ok(html.includes('id="radar-ld021-experimental"') && html.includes('id="radar-output-time-input"')
  && html.includes('step="100"') && html.includes('Experimental - HLK-LD021 only'),
  'settings must expose a keyboard-editable experimental LD021 HIGH-time control');
assert.ok(renderer.includes('experimental.hidden = !ld021') && renderer.includes('outputTime.disabled = !editable || !ld021'),
  'experimental HIGH time must be visible and editable only for every LD021 target, including a pair');
assert.ok(renderer.includes("outputTime.addEventListener('input', stage)")
  && renderer.includes('normalizeLd021OutputTimeMs(outputTime.value)')
  && renderer.includes('applyRadarSettings(gainCode, value, protocolProfile, outputTimeMs)'),
  'keyboard edits must stage and submit LD021 HIGH time through the normal Apply action');
assert.ok(main.includes('normalizeLd021OutputTimeMs(requested.outputTimeMs)')
  && main.includes('JSON.stringify({ gainCode, threshold, outputTimeMs, target })'),
  'the main process must validate and forward LD021 HIGH time without exposing arbitrary writes');
assert.ok(main.includes('backgroundThrottling: false'), 'test timing must not be throttled when the GUI is covered or unfocused');
assert.ok(!main.includes('WHISKER_CAMPAIGN_SYNC_TOKEN') && !main.includes('WHISKER_CAMPAIGN_WEBAPP_URL'), 'Google campaign credentials and endpoints must be absent');
assert.ok(!renderer.includes('campaignSync') && !preload.includes('campaign:sync'), 'remote campaign sync controls must be absent');
assert.ok(!html.includes('campaignAdmin') && !html.includes('Google Sheet') && !html.includes('Apps Script'), 'Google campaign administration UI must be absent');
assert.ok(main.includes("code: 'ERR007', label: 'reflector trigger command timeout'"), 'reflector command timeouts must not be mislabeled as X/Y position timeouts');
assert.ok(renderer.includes("ERR007: 'Reflector Trigger Timeout'"), 'the UI must explain reflector trigger timeouts');
assert.ok(
  renderer.includes("const yResult = await radarAPI.home(['y']);")
    && renderer.includes("if (!yResult.success) return yResult;")
    && renderer.includes("const xResult = await radarAPI.home(['x']);"),
  'combined homing must complete Y before moving X and stop if Y homing fails'
);
assert.ok(
  !renderer.includes("radarAPI.home(['x', 'y'])"),
  'renderer must not use combined X/Y homing because its axis order is unsafe near the DUT'
);
assert.ok(
  html.includes('id="campaign-primary-btn"')
    && html.includes('id="campaign-edit-btn"')
    && html.includes('id="campaign-create-btn"')
    && html.includes('id="campaign-condition-grid"')
    && html.includes('id="campaign-runs-input"')
    && html.includes('id="campaign-cycles-input"')
    && html.includes('id="campaign-points-input"')
    && html.includes('id="campaign-gain-options"')
    && html.includes('id="campaign-thresholds-input"')
    && renderer.includes('async function prepareNextCampaignRun({ applySettings = true } = {})'),
  'operator UI must provide start, progress, and next-run campaign workflow'
);
assert.ok(
  html.includes('id="campaign-run-name-grid"')
    && renderer.includes('function renderCampaignRunNameEditor(plan)'),
  'campaign editor must support optional names for individual generated runs'
);
assert.ok(
  html.includes('id="cfg-dut-location"')
    && renderer.includes('systemReference: { x: dutCenter.x, y: dutCenter.y, confirmed: true }')
    && main.includes("dual-sensor-system-distance-bands"),
  'system planning and reports must use the center of the selected DUT location'
);
assert.ok(
  main.includes("'RadarAActualDetected','RadarBActualDetected','CombinedDetectionRule'")
    && renderer.includes("qualificationBasis: validationGeometry().sensorLayout === 'dual'"),
  'qualification reports must use combined output while retaining independent radar diagnostics and system partitions'
);
assert.ok(
  renderer.includes('fixtureBounds:')
    && renderer.includes("const x = axisVisualRange('x'), y = axisVisualRange('y')")
    && renderer.includes('config.validation?.characterizationBounds || fixtureXyBounds()')
    && main.includes('dualSystemBands?fixtureCorners:shapes.flat()')
    && main.includes('DUT_CORNERS')
    && main.includes('q.rect(left,top,pw,ph);q.clip()'),
  'dual-system bands must be clipped to reachable travel while every graph still includes the full DUT footprint'
);
assert.ok(
  renderer.includes('minX -= padX + forwardViewExtensionMm')
    && renderer.includes('maxX += padX + forwardViewExtensionMm')
    && renderer.includes('minY -= padY + forwardViewExtensionMm')
    && renderer.includes('maxY += padY')
    && main.includes('x0-=pad+forwardViewExtensionMm;x1+=pad+forwardViewExtensionMm;y0-=pad+forwardViewExtensionMm;y1+=pad'),
  'GUI and report spatial graphs must add forward and side context without extending the behind-unit edge'
);
assert.ok(
  preload.includes("ipcRenderer.invoke('campaign:update'")
    && main.includes("ipcMain.handle('campaign:update'")
    && renderer.includes("showCampaignModal('edit')")
    && main.includes('CampaignManager.updateCampaign'),
  'active campaigns must remain editable through the renderer and durable main-process state'
);
assert.ok(
  main.includes("ipcMain.handle('campaign:start'")
    && main.includes("ipcMain.handle('campaign:archive'")
    && main.includes('const campaignId = config.campaign.active.id')
    && main.includes('campaignId,'),
  'main process must own campaign creation, archival, and campaign-scoped result recording'
);
assert.ok(
  renderer.includes("cyclesRequired: method.cyclesPerRun")
    && renderer.includes("characterizationBounds: { ...method.geometry.bounds }")
    && renderer.includes("campaignConditionId: status.next.id")
    && renderer.includes("enabled: true"),
  'Prepare Next Run must apply the complete configured method and logging safeguards'
);

console.log(`UI binding tests passed (${htmlIds.length} unique IDs, ${tabs.length} tabs)`);
