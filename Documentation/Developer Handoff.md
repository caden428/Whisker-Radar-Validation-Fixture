# Developer Handoff

The Whisker Radar Validation Fixture controls the fixture, records test runs,
creates local reports, manages radar settings, and supports local campaign
planning. Start with the documentation index, then use this guide when making
or reviewing changes.

## Get started

```bat
install.cmd
npm test
launch.cmd
build.cmd
```

On a Pi with Python 3 and pigpio installed:

```sh
python3 -m unittest discover -s pi-radar-service -p 'test_*.py'
```

## Find your way around

| If you need to... | Start here |
|---|---|
| Understand the project and its documents | `Documentation/README.md` and `Documentation/Code Guide.md` |
| Change test rules or geometry | `validation-core.js` |
| Change the application UI or run flow | `renderer.js`, then `preload.js` and `main.js` |
| Change radar settings or campaigns | `radar-settings-core.js` and the campaign modules |
| Verify a change | `test/` and `pi-radar-service/test_radar_service.py` |

## Key engineering rules

### Application structure

- Keep pure core modules independent of Electron and the DOM.
- Keep filesystem, network, and hardware privileges behind `main.js` and
  `preload.js`.
- Keep run naming in `run-naming-core.js`.
- Keep campaign normalization and progress semantics in `campaign-manager.js`.
- Keep run transitions, cancellation, and crash recovery in `run-controller.js`;
  renderer flags are presentation only.

### Test data and run records

- Preserve raw observations and null latency for misses.
- Treat the finalized local run folder as the record of the test result.
- Keep local campaign history tied to finalized run artifacts.
- Never finalize or campaign-record a run until its finalization transaction
  reaches the finalized artifact state.

### Hardware safety

- Require a fresh LOW baseline before a trigger.
- Range-check radar writes and require target-specific read-back verification.
- Keep emergency stop outside the ordinary command queue.

### UI and configuration state

- Add renderer state through explicit `renderer-store.js` actions rather than
  introducing another independent global flag.
- Engineering forms must mutate `configuration-draft.js` state and promote it
  only after a successful revisioned `config:patch` response.
- Keep Run a Test compatibility and dirty-draft decisions in
  `operator-flow-core.js`. Earlier selections must clear incompatible
  downstream selections, and recipe selectors must never cross test types.
- Do not rerender editable operator inputs on their `input` events. Update the
  review summary from their current values so focus and partial text survive.

## Before handoff or release

1. Classify modified and untracked paths.
2. Run `npm test` and the Pi tests when relevant.
3. Exercise connection failure, readiness gating, plan generation, mock-mode
   UI checks, and a controlled hardware or simulator run.
4. Verify the complete local run artifact set and open the report.
5. Build and smoke-test the installer.
6. Check Markdown links and record unperformed physical acceptance.

Source-controlled files include the application, `test/`, `tools/`,
`pi-radar-service/`, `vendor/`, and `package-lock.json`. Do not add generated
or local-only files such as `node_modules/`, `dist/`, logs, caches, temporary
folders, gathered run data, or DOCX copies. Recreate dependencies with
`install.cmd` and installers with `build.cmd`.

## Fixture facts to verify

- Confirm the measured physical radar center during commissioning.
- Use commissioned limits, speeds, acceleration, and reflector behavior.
- The expected reflector macro is `REFLECTOR_SPIN`.
- Z has no conventional home switch; use the fixture-specific reference method.
- Do not use mock radar mode for qualification.
- Network failures must not alter the local test result.
