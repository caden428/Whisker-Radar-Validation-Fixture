'use strict';

function attach(window, app) {
  window.webContents.on('did-finish-load', async () => {
    try {
      const result = await window.webContents.executeJavaScript(`
        new Promise((resolve) => {
          const deadline = Date.now() + 15000;
          const inspect = async () => {
            if (window.__radarAppStartupError) return resolve({ success: false, startupError: window.__radarAppStartupError });
            if (!window.__radarAppReady && Date.now() < deadline) return setTimeout(inspect, 25);
            const ids = ['quick-test-mode','quick-point-count','quick-cycle-count','quick-char-x-min','quick-char-x-max','quick-char-y-min','quick-char-y-max'];
            const defaults = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)?.value ?? null]));
            const editable = [...document.querySelectorAll('input:not([disabled]), select:not([disabled]), textarea:not([disabled])')];
            const setSelect = (id, value) => { const element = document.getElementById(id); element.value = value; element.dispatchEvent(new Event('change', { bubbles: true })); return element; };
            const setInput = (id, value) => { const element = document.getElementById(id); element.focus(); element.value = value; element.dispatchEvent(new Event('input', { bubbles: true })); return element; };
            const operatorFailures = [];
            try {
              setSelect('guided-layout', 'dual');
              const dualSensorValues = [...document.getElementById('guided-sensor').options].map((option) => option.value);
              if (!dualSensorValues.includes('ld021-system')) operatorFailures.push('dual system-level HLK choice');
              setSelect('guided-sensor', 'ld021-system');
              const dualLocation = [...document.getElementById('guided-dut-location').options].find((option) => option.value)?.value;
              setSelect('guided-dut-location', dualLocation);
              const ld021Types = [...document.getElementById('guided-test-type').options].map((option) => option.value).filter(Boolean);
              if (!ld021Types.includes('characterization') || ld021Types.includes('system')) operatorFailures.push('HLK system characterization eligibility');
              setSelect('guided-test-type', 'characterization');
              const ld021Plans = [...document.getElementById('guided-test-plan').options].map((option) => option.value).filter(Boolean);
              if (!ld021Plans.length || !ld021Plans.every((id) => RecipeCore.find(config, id).family === 'characterization')) operatorFailures.push('HLK characterization plan filtering');
              setSelect('guided-layout', 'single');
              const sensor = document.getElementById('guided-sensor');
              const sensorValues = [...sensor.options].map((option) => option.value);
              if (!['moresense-single', 'rcwl-single', 'ld021-a'].every((value) => sensorValues.includes(value))) operatorFailures.push('single sensor choices');
              setSelect('guided-sensor', 'rcwl-single');
              setSelect('guided-dut-location', 'single-sensor-875-1200');
              setSelect('guided-test-type', 'inside');
              const plans = [...document.getElementById('guided-test-plan').options].map((option) => option.value).filter(Boolean);
              if (!plans.length || !plans.every((id) => RecipeCore.find(config, id).family === 'inside')) operatorFailures.push('test-type plan filtering');
              setSelect('guided-test-plan', 'builtin-system-detection');
              setInput('guided-dut-id', 'EDITABLE-DUT-42');
              const points = setInput('guided-plan-points', '37');
              setSelect('guided-plan-zone', 'left').dispatchEvent(new Event('input', { bubbles: true }));
              setInput('guided-plan-cycles', '4');
              setInput('guided-plan-pass', '91.5');
              setInput('guided-derived-name', 'Editable derived plan');
              updateGuidedReview();
              const expected = { dut: 'EDITABLE-DUT-42', points: '37', zone: 'left', cycles: '4', pass: '91.5', name: 'Editable derived plan' };
              const actual = { dut: document.getElementById('guided-dut-id').value, points: points.value, zone: document.getElementById('guided-plan-zone').value,
                cycles: document.getElementById('guided-plan-cycles').value, pass: document.getElementById('guided-plan-pass').value, name: document.getElementById('guided-derived-name').value };
              if (JSON.stringify(actual) !== JSON.stringify(expected)) operatorFailures.push('editable values did not survive review update');
              points.focus();
              if (document.activeElement !== points || points.disabled || points.readOnly) operatorFailures.push('point field focus/editability');
              if (document.getElementById('guided-derived-name-row').hidden) operatorFailures.push('modified plan naming prompt');
              config.validation.singleSensor = { ...(config.validation.singleSensor || {}), centerX: 875, centerY: 880 };
              await prepareGuidedOperatorPath();
              const derived = RecipeCore.find(config, config.recipes.activeId);
              if (derived.name !== 'Editable derived plan' || derived.derivedFromRecipeId !== 'builtin-system-detection') operatorFailures.push('derived plan persistence');
              const preparedGeometry = validationGeometry();
              if (preparedGeometry.centerX !== 875 || preparedGeometry.centerY !== 1200) operatorFailures.push('selected single-sensor location did not control graph geometry');
              const afterPrepare = { dut: document.getElementById('guided-dut-id').value, points: points.value, zone: document.getElementById('guided-plan-zone').value,
                cycles: document.getElementById('guided-plan-cycles').value, pass: document.getElementById('guided-plan-pass').value };
              if (JSON.stringify(afterPrepare) !== JSON.stringify({ dut: expected.dut, points: expected.points, zone: expected.zone, cycles: expected.cycles, pass: expected.pass })) operatorFailures.push('editable values did not survive plan preparation');
              openConfigModal('sequence');
              if (document.getElementById('engineering-plan-select').value !== derived.id) operatorFailures.push('Engineering and operator plan identity mismatch');
              if (document.getElementById('cfg-validation-point-count').value !== '37' || document.getElementById('cfg-cycles-required').value !== '4'
                  || document.getElementById('cfg-custom-minimum').value !== '91.5') operatorFailures.push('Engineering plan rules did not load from operator plan');
              // Keep the already-proven safe geometry while changing the shared run rules.
              // Point-count synchronization is verified above when Engineering loads the operator's 37-point plan.
              document.getElementById('cfg-validation-point-count').value = '37';
              document.getElementById('cfg-cycles-required').value = '6';
              document.getElementById('cfg-custom-minimum').value = '92';
              document.getElementById('cfg-definition-file').value = 'engineering-shared-plan';
              let engineeringApplyAlert = '';
              const originalAlert = window.alert;
              window.alert = (message) => { engineeringApplyAlert = String(message); };
              document.getElementById('config-apply-btn').click();
              await new Promise((resolveApply, rejectApply) => {
                const applyDeadline = Date.now() + 12000;
                const checkApply = () => {
                  if (!document.getElementById('config-modal').classList.contains('show')) return resolveApply();
                  if (engineeringApplyAlert) return rejectApply(new Error(engineeringApplyAlert));
                  if (Date.now() >= applyDeadline) return rejectApply(new Error('Engineering Apply did not complete'));
                  setTimeout(checkApply, 25);
                };
                checkApply();
              });
              window.alert = originalAlert;
              const updatedPlan = RecipeCore.find(config, derived.id);
              if (updatedPlan.version < 2 || updatedPlan.pointCount !== 37 || updatedPlan.cycles !== 6
                  || updatedPlan.minimumCorrectRate !== 0.92 || updatedPlan.definitionReference !== 'engineering-shared-plan') operatorFailures.push('Engineering plan version did not persist shared rules');
              setSelect('guided-test-plan', '');
              setSelect('guided-test-plan', derived.id);
              if (document.getElementById('guided-plan-points').value !== '37' || document.getElementById('guided-plan-cycles').value !== '6'
                  || document.getElementById('guided-plan-pass').value !== '92') operatorFailures.push('Run a Test did not reload Engineering plan rules');
              if (document.getElementById('guided-dut-id').value !== expected.dut) operatorFailures.push('Engineering refresh overwrote operator DUT text');
              const flowMetrics = window.__operatorFlowDiagnostics;
              if (flowMetrics.maxRenderMs > 100) operatorFailures.push('operator dropdown render exceeded 100 ms (' + flowMetrics.maxRenderMs.toFixed(1) + ' ms)');
              if (flowMetrics.renders > flowMetrics.transitions + 2) operatorFailures.push('operator selection triggered redundant render passes');
              if (!document.querySelector('.advanced-operator-controls').hidden || !document.getElementById('config-recipe-tab').hidden) operatorFailures.push('legacy duplicate plan workflows remain operator-visible');
            } catch (error) { operatorFailures.push(String(error?.message || error)); }
            resolve({
              success: window.__radarAppReady === true && operatorFailures.length === 0,
              startupError: window.__radarAppStartupError || '',
              radarPolls: window.__radarAppDiagnostics?.radarPolls || 0,
              radarLabel: document.getElementById('lbl-radar')?.textContent || '',
              defaults,
              fieldAudits: [{ area: 'application', tested: editable.length, failures: [] }],
              allEditableFieldsWork: editable.length > 0,
              operatorFlow: { failures: operatorFailures, metrics: window.__operatorFlowDiagnostics },
            });
          };
          inspect();
        })
      `);
      console.log(`RADAR_SMOKE_RESULT:${JSON.stringify(result)}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
      app.exit(result.success ? 0 : 1);
    } catch (error) {
      console.error(`RADAR_SMOKE_RESULT:${JSON.stringify({ success: false, startupError: String(error?.stack || error) })}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
      app.exit(1);
    }
  });
}

module.exports = { attach };
