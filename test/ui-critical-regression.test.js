'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
assert.ok(!html.includes('<span class="logo-icon">RADAR</span>'),
  'the header must present the application name only once');
assert.match(html, /<button class="btn-icon-header" id="config-btn"[^>]*aria-label="Configuration"[^>]*>&#9881;<\/button>/,
  'the Configuration action must remain a compact, accessible cog button');
assert.match(styles, /select\s*\{[^}]*color-scheme:\s*dark;/s,
  'Windows/Electron dropdown popups must opt into dark native rendering');
assert.match(styles, /select option,[\s\S]*background-color:\s*#0a0f1a;[\s\S]*color:\s*var\(--text\);/,
  'dropdown options must have explicit readable colors because native popups do not reliably inherit them');
assert.ok(html.includes('data-tab="system-level"') && html.includes('id="cfg-system-pass-inches"')
  && html.includes('id="cfg-system-grey-inches"') && html.includes('id="cfg-system-red-inches"')
  && html.includes('id="cfg-reflector-clearance-mm"') && html.includes('id="cfg-coverage-mode"'),
'Engineering Setup must expose the three System Level zone controls');
assert.ok(renderer.includes('updateSystemLevelSummary') && renderer.includes('syncSystemBarrier'),
  'System Level controls must remain synchronized and editable across modal lifecycles');
assert.ok(html.includes('id="recipe-coverage-mode"')
  && renderer.includes('coverageMode: document.getElementById(\'recipe-coverage-mode\').value')
  && html.includes('value="angular"') && html.includes('value="front"') && html.includes('value="full-dut"')
  && !html.includes('value="rear"'),
  'recipe coverage must expose only Angular, Front, and rear-free Full DUT strategies');
assert.ok(renderer.includes('reflectorClearanceMm()') && renderer.includes('keepOutClearanceMm: reflectorClearanceMm()')
  && renderer.includes('coverageMode: normalizedCoverageMode('),
  'point generation and motion routing must enforce the reflector keep-out envelope');
assert.ok(main.includes('function reflectorClearanceMm()') && main.includes('DutLocationCore.noGoBounds(activeDutLocation(), clearanceMm)'),
  'main-process motion commands must enforce the same reflector keep-out envelope');

const spatialStart = renderer.indexOf('function renderSpatialResults()');
const spatialEnd = renderer.indexOf('/** Attaches UI event handlers for visualization.', spatialStart);
const spatial = renderer.slice(spatialStart, spatialEnd);
assert.ok(spatialStart >= 0 && spatialEnd > spatialStart, 'raw spatial renderer must remain present');
assert.ok(spatial.includes("const geometry = validationGeometry();"), 'raw spatial renderer must initialize geometry');
assert.ok(!spatial.slice(0, spatial.indexOf("const geometry = validationGeometry();")).includes('geometry.sensorLayout'), 'raw spatial renderer must not read geometry before initialization');
assert.ok(spatial.indexOf("const geometry = validationGeometry();") < spatial.indexOf("const legend = document.getElementById('spatial-legend');"), 'geometry must initialize before legend rendering');
assert.ok(spatial.includes('drawDutFootprint(ctx, px, py);'), 'raw spatial renderer must draw the selected DUT');
assert.ok(
  renderer.includes("const excludeDut = activeSensorLayout() === 'dual'")
    && renderer.includes('if (!pointAllowed(point)) continue;'),
  'ordinary and angular characterization plans must exclude the physical in-field DUT footprint',
);
assert.ok(
  renderer.includes("geometrySemantics: sensorLayout === 'dual'")
    && renderer.includes('ValidationCore.GEOMETRY_SEMANTICS.DUAL_SYSTEM_BANDS'),
  'switching to the in-field dual layout must replace stale single-sensor geometry semantics so angular plans remain usable',
);
assert.ok(renderer.includes('function activeSensorLayout()'), 'saved and pending sensor-layout state must use one resolver');
assert.ok(renderer.includes('const sensorLayout = activeSensorLayout();'), 'validation geometry must honor the pending Engineering layout');
assert.ok(renderer.includes("if (activeSensorLayout() !== 'dual')"), 'graph symbol must use the same active layout as geometry');
assert.ok(!html.includes('cfg-sensor-b-') && !html.includes('campaign-sensor-b-'), 'dual setup must not expose individual radar-channel locations');
assert.ok(html.includes('id="cfg-system-geometry-note"') && html.includes('id="campaign-system-geometry-note"'), 'dual setup must explain DUT-level system geometry');
assert.ok(renderer.includes("if (sensorLayout === 'single')")
  && renderer.includes("if (['ld021_pair', 'rcwl_pair'].includes(sensorLayout))"),
'single-sensor positions and interference-pair positions must remain isolated from dual-system qualification geometry');
assert.ok(!renderer.includes('function drawSystemBandOverlay('), 'characterization must not introduce a separate overlay renderer');
assert.ok(renderer.includes('const showEstimatedActivationZone = !interferenceView && (!characterizationView || displayDutBands)')
  && renderer.includes('if (showEstimatedActivationZone) drawLobe(')
  && renderer.includes('validationZone || characterizationSystemView'),
'characterization must reuse the same clipped lobe drawing paths as Test 10.1');
assert.ok(main.includes("fillStyle='#ff496218'") && main.includes("[shapes[1],'#9ca3af','#9ca3af33'],[shapes[0],'#00d879','#00d87933']"), 'formal reports must retain red, grey, and green overlay ordering');
assert.ok(renderer.includes("document.getElementById('campaign-edit-btn').addEventListener('click', () => showCampaignModal('edit'))"), 'Edit Campaign must open the populated campaign form');
assert.ok(renderer.includes('await radarAPI.campaignUpdate(campaignInput)'), 'campaign edits must use the update API');
assert.ok(renderer.includes("document.getElementById('campaign-create-btn').textContent = campaign ? 'Save Changes' : 'Create Campaign'"), 'campaign form must clearly distinguish create and edit actions');
assert.ok(renderer.includes("autoRun: document.getElementById('campaign-auto-run-input').checked"), 'campaign creation and editing must retain Auto Run');
assert.ok(renderer.includes("document.querySelectorAll('#campaign-run-name-grid input')"), 'campaign creation and editing must retain optional run names');
assert.ok(
  renderer.includes('const campaignLocked = !!campaignOperatorStatus?.active && !!campaignOperatorStatus?.next')
    && renderer.includes('Campaign completion is persisted before this status refresh')
    && renderer.includes('updateQuickRunPanel();'),
  'completed campaign saves must restore every quick-run text field instead of leaving the reviewable campaign locked',
);
assert.ok(renderer.includes("document.getElementById('campaign-auto-run-toggle').addEventListener('change'"), 'operator Auto Run toggle must be wired');
assert.ok(renderer.includes("document.getElementById('campaign-dashboard-auto-run-toggle').addEventListener('change'"), 'dashboard Auto Run toggle must be wired');
assert.ok(!renderer.includes('TextInputCore.applyKey(input, event.key)'), 'campaign form must not manually insert keyboard characters');
assert.ok(main.includes('secondCampaignTypingWorks'), 'renderer smoke testing must cover creating another campaign in the same session');
assert.ok(main.includes('numericCampaignTypingWorks'), 'renderer smoke testing must cover numeric campaign-plan fields');
assert.ok(main.includes('rcwlCampaignControlMatrix') && main.includes('rcwlEngineeringControlMatrix'),
  'renderer smoke testing must preserve RCWL controls and saved state across supported test types');
assert.ok(main.includes("['inside', 'outside', 'characterization', 'interference', 'custom', 'sequence']"),
  'hardware UI smoke coverage must include every supported application test type');
assert.ok(!renderer.includes('campaignValueSelected'), 'numeric campaign fields must not use value-replacement workarounds');
assert.ok(renderer.includes('async function runAutomaticCampaign()'), 'Auto Run must have an execution orchestrator');
assert.ok(renderer.includes('applyAndVerifyRadarSettings(status.next.gainCode, status.next.threshold)'), 'Auto Run must apply and verify every radar condition');
assert.ok(renderer.includes("advanced.next?.id === conditionId"), 'Auto Run must not advance without a durable campaign result');
assert.ok(renderer.includes("['shutdown', 'error'].includes(klippyState)"), 'Auto Run must stop on fixture fault states');
assert.ok(renderer.includes('function planValidationIssues(points = [])')
  && renderer.includes('preflight-issues')
  && renderer.includes('formatPlanIssue(issue)'),
  'blocked runs must expose individual plan validation issues in the preflight area');
assert.ok(html.includes('id="quick-preflight-checklist"') && fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8').includes('.preflight-issues'),
  'the run screen must provide a visible styled container for plan issue details');

assert.ok(html.includes('id="config-apply-btn"'), 'Engineering Settings Apply button must remain in the DOM');
assert.ok(renderer.includes("document.getElementById('config-apply-btn').addEventListener('click', async () =>"), 'Engineering Settings Apply handler must remain wired');
assert.ok(renderer.includes('await radarAPI.configSet(config);'), 'Engineering Settings Apply must persist configuration');
assert.ok(html.includes('id="engineering-plan-description"')
  && renderer.includes('description: recipe.description')
  && renderer.includes('name, description, builtIn: false, family'),
  'test-plan identity edits must preserve name, description, and test type in the saved plan');
assert.ok(main.includes("'/printer/objects/query?toolhead=homed_axes,position'"), 'homing must return the authoritative toolhead position');
assert.ok(renderer.includes('seq = optimizedExecutionPoints(seq, confirmedHome);'), 'execution order must be recalculated from confirmed home');
assert.ok(renderer.includes('function evaluateMotionPlan(points, start = lastConfirmedHomePoint || configuredHomePoint())'), 'preflight and preview must use the same home anchor as execution');
assert.ok(renderer.includes('const filtered = filterGeneratedPoints(points);')
  && renderer.includes('denseSafeRaster(xLo, xHi, yLo, yHi, target')
  && renderer.includes('return finalizeGeneratedPlan({'),
  'raster generation must exclude DUT keep-out cells and backfill count-based grids with safe positions');
assert.ok(renderer.includes('const MAX_GENERATOR_POINTS = 2000;')
  && renderer.includes('if (target > MAX_GENERATOR_POINTS)')
  && renderer.includes('if (!Number.isFinite(estimatedPoints) || estimatedPoints > MAX_GENERATOR_POINTS)')
  && renderer.includes("rasterMode.value = 'count'"),
  'switching to Raster Grid must start bounded and reject oversized spacing grids before allocating points');
assert.ok(renderer.includes('function annotateSystemLevelPoints(points)')
  && renderer.includes("zone === 'required-trigger'")
  && renderer.includes('System grey (ungraded)')
  && renderer.includes("ValidationCore.expectedFor('custom', p, validationGeometry())"),
  'System Level generated and custom points must show automatic pass/fail expectations while retaining grey points as ungraded');
assert.ok(renderer.includes('if (!plan.canApply)')
  && renderer.includes('const combinedSafety = evaluateMotionPlan(combined);'),
  'generated plans and appended plans must be safety-checked before they can replace an active sequence');
assert.ok(renderer.includes('drawReflectorKeepout(ctx,')
  && renderer.includes("ctx.strokeStyle = '#ff405c'")
  && renderer.includes("ctx.fillText('Home'"),
  'plan preview must show the reflector keep-out, excluded candidates, and the home-to-plan route');
assert.ok(renderer.indexOf('const runBlocker = currentPlanBlockingIssue();', renderer.indexOf('async function runSequence()'))
  < renderer.indexOf('testRunning = true;', renderer.indexOf('async function runSequence()')),
  'run must validate DUT endpoints and routes before enabling motion');
assert.ok(main.includes("DutLocationCore.pointBehindDut(end, activeDutLocation())"),
  'the main process must reject rear moves even if the renderer guard is bypassed');
assert.ok(main.includes("MotionSafetyCore.pointIssue(config.motion, requested)")
  && main.includes("MotionSafetyCore.feedMmMin(speed.value)")
  && main.includes("ipcMain.handle('motion:beginQualificationRun'"),
  'the privileged process must enforce travel limits, canonical unit conversion, and commissioning authorization');
assert.ok(renderer.includes('await flushLogWrites()') && main.includes('await logWriteQueue'),
  'run finalization must wait for acknowledged serialized observation writes');
assert.ok(html.includes('id="cfg-motion-commissioned"') && renderer.includes('commissioningBlockingIssue()'),
  'qualification runs must expose and enforce the fixture commissioning lock');

console.log('critical UI regression tests passed');
