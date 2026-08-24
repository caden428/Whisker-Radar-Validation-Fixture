# Developer Handoff

This is the current development snapshot of the Whisker Radar Validation
Fixture. Core fixture control, run records, reports, target-aware radar
settings, automated tests, and local campaign planning are present.
All radar profiles and hardware-specific values remain experimental until
commissioned on the installed fixture.

## Setup and verification

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

## Read in this order

1. `Documentation/README.md`
2. `Documentation/Code Guide.md`
3. `validation-core.js`
4. `renderer.js`
5. `preload.js`
6. `main.js`
7. `radar-settings-core.js` and the campaign modules
8. `test/` and `pi-radar-service/test_radar_service.py`

## Boundaries to preserve

- Keep pure core modules independent of Electron and the DOM.
- Keep filesystem, network, and hardware privileges behind `main.js` and
  `preload.js`.
- Preserve raw observations and null latency for misses.
- Require a fresh LOW baseline before a trigger.
- Treat the finalized local run folder as authoritative.
- Keep local campaign history tied to finalized run artifacts.
- Range-check radar writes and require target-specific read-back verification.
- Keep run naming in `run-naming-core.js`.
- Keep campaign normalization and progress semantics in `campaign-manager.js`.
- Keep authoritative run transitions, cancellation, and crash recovery in
  `run-controller.js`; renderer flags are presentation mirrors, not authority.
- Keep emergency stop outside the ordinary command queue.
- Never finalize or campaign-record a run until its finalization transaction
  reaches the finalized artifact state.
- Add renderer state through explicit `renderer-store.js` actions rather than
  introducing another independent global flag.
- Engineering forms must mutate `configuration-draft.js` state and promote it
  only after a successful revisioned `config:patch` response.
- Keep Run a Test compatibility and dirty-draft decisions in
  `operator-flow-core.js`. Earlier selections must clear incompatible
  downstream selections, and recipe selectors must never cross test types.
- Do not rerender editable operator inputs on their `input` events. Update the
  review summary from their current values so focus and partial text survive.

## Repository hygiene

Source-controlled: application files, `test/`, `tools/`, `pi-radar-service/`,
`vendor/`, and `package-lock.json`. Generated or local-only: `node_modules/`,
`dist/`, logs, caches, temporary folders, and gathered run data.

Review `git status` before editing. Untracked files may be active project work.

## Release and handoff checks

1. Classify modified and untracked paths.
2. Run `npm test` and the Pi tests when relevant.
3. Exercise connection failure, readiness gating, plan generation, mock-mode
   UI checks, and a controlled hardware or simulator run.
4. Verify the complete local run artifact set and open the report.
5. Build and smoke-test the installer.
6. Check Markdown links and record unperformed physical acceptance.

Do not put gathered run data or DOCX copies into a source handoff. Recreate
dependencies with `install.cmd`; recreate installers with `build.cmd`.

## Decisions that remain explicit

- The measured physical radar center is authoritative.
- Safe limits, speeds, acceleration, and reflector behavior come from
  commissioning.
- The expected reflector macro is `REFLECTOR_SPIN`.
- Z has no conventional home switch; its reference method is fixture-specific.
- Mock radar mode is never valid for qualification.
- Network failures never change the local result.
