# Whisker Radar Test Tool Code Guide

## Runtime architecture

- `main.js` is the Electron main process. It owns configuration persistence,
  Moonraker and radar-service HTTP calls, privileged IPC handlers, run-folder
  creation, CSV logging, and report generation.
- `preload.js` is the renderer security boundary and exposes `window.radarAPI`.
- `run-controller.js` is the authoritative main-process lifecycle state machine.
  It validates phase changes, owns cancellation/fault state, and persists active
  recovery state outside the renderer.
- `command-arbiter.js` serializes ordinary fixture commands while allowing
  emergency stop to bypass the queue immediately.
- `renderer.js` owns UI state, readiness gating, plan generation, the execution
  driver, observation capture, and visualizations. It reports lifecycle phases
  to the main-process run controller and follows authoritative abort/fault state.
- `renderer-store.js` provides explicit actions for applied configuration,
  configuration drafts, connection state, and authoritative run state.
- `configuration-draft.js` isolates Engineering Settings edits until Apply
  succeeds. Cancel and failed saves restore the last applied snapshot.
- `operator-flow-core.js` owns the Run a Test hardware catalog, test-type
  compatibility rules, angular-zone labels, filtered recipe queries, and
  plan-draft change detection without depending on the DOM or Electron.
- `operator-flow-state.js` owns the selection state machine. Layout,
  hardware, location, type, and plan changes are explicit transitions that
  clear only invalid downstream selections.
- `test-plan-core.js` defines the contracts for a reusable test plan, an
  operator run setup, and an immutable prepared run. It also owns validation.
- `run-workspace-core.js` provides the plan catalog, immutable operator
  draft boundary, and prepared-run factory. Catalog reads return copies so UI
  code cannot mutate saved definitions by reference.
- `run-state-view.js` owns the lifecycle-step DOM rendering previously embedded
  in the renderer coordinator.
- `validation-core.js` is DOM/Electron independent. It defines test geometry,
  point generation, observation classification, and acceptance.
- `radar-settings-core.js` normalizes target-specific settings and read-back.
- `campaign-manager.js`, `campaign-core.js`, and `campaign-ledger.js` own
  local campaign plans, eligibility, and durable history.
- `run-naming-core.js` is the shared Windows-safe run-folder convention. Names
  include DUT, sensor hardware/layout, test type, Test Plan, labeled radar
  settings, cycles, date, and time in that order.

The Raspberry Pi service in `pi-radar-service/` owns UART protocol exchanges,
software-UART GPIO handling, authenticated HTTP endpoints, and radar-setting
read-back. It is installed separately from the Windows app.

## Run flow

1. The operator selects layout, sensor hardware, DUT location, test type, and
   a compatible plan. Plans from other test types are not offered.
   These dropdowns update only in-memory operator state; they do not persist
   configuration, generate motion, query radar hardware, or render canvases.
2. The renderer builds or loads a reviewed plan and validates geometry,
   limits, radar readiness, and logging requirements.
3. The runner homes X/Y, obtains the current position as the route anchor, and
   orders points with `DutLocationCore.orderByShortestSafeRoute`.
4. Each move is checked against the DUT no-go zone and sent through Moonraker
   with a completion wait.
5. After settling, the runner requires a fresh LOW baseline, invokes the
   configured reflector macro (normally `REFLECTOR_SPIN`), and polls the active
   detection input(s).
6. `ValidationCore.createObservation` classifies the raw result. The row is
   written immediately to the run CSV and retained for the report.
7. Completion writes `summary.json`, `report.html`, `observations.csv`, and the
   radar-settings snapshot. The run folder is then finalized; local campaign
   history is updated after those artifacts exist.

## Shared test-plan contract

- `TestPlanCore.OWNERSHIP` defines data boundaries. A saved
  plan owns test type, compatibility, rules, generation, and execution policy.
  A run setup owns hardware, location, DUT identity, selected plan, and explicit
  run-only overrides. Fixture configuration owns commissioned hardware facts.
- Operator selectors read `config.testPlans`.
- Plan changes use narrow `test-plan:save` and `test-plan:delete` IPC contracts.
  `test-plan-repository-core.js` owns versioning and history, and the main
  process persists changes with asynchronous file I/O.
- Built-ins are immutable. Editing one creates a named custom derivative.
- `config.sequences` stores executable point arrays. A test plan may link one
  through its generation settings, but a raw sequence is not itself an independently configured
  validation plan.
- Engineering Apply persists reusable plan intent. Point generation and travel
  validation happen when the operator prepares the plan against the currently
  selected DUT/sensor location, preventing an edit from silently preparing
  motion for stale fixture context.
- Runtime manifests and reports record `testPlan` and `runSetup` independently.

### Operator selection state

`OperatorFlowState.reduce` is the only transition path for the five guided
selectors. A layout change clears hardware and every dependent choice; hardware
clears location/type/plan; test type clears plan; location changes preserve a
still-compatible type and plan. `renderGuidedFlowState` performs one DOM pass,
and select options are replaced only when their option signature changes.

### Catalog, draft, and prepared execution

The operator plan selector reads plans from the runtime catalog. Operator
choices are held as a `RunSetup` draft and do not mutate catalog plans. After generation
and safety validation, `RunWorkspaceCore.prepare` deep-freezes the exact plan,
setup, points, resolved hardware, resolved geometry, and acceptance policy.

Run authorization, cycle count, manifests, and completion reports consume that
prepared snapshot. A later UI/configuration refresh therefore cannot silently
change the identity, rules, geometry, or point list attributed to an active run.

The guided **Run Test** action performs plan save, generation, safety validation,
preflight, and execution in order. The motion-area control is hidden while idle
and appears only as the active-run abort/E-stop control.

## Motion and commissioning contract

- Motion speed is stored canonically as millimetres per second (`speedMmS`).
  The main process converts it to Klipper `G1` feed in millimetres per minute
  only when constructing the command.
- The main process rejects non-finite values, unsupported axes, unhomed
  absolute moves, out-of-range endpoints, excessive speed/acceleration, and
  invalid timeouts before sending G-code.
- Qualification runs require explicit fixture commissioning. X/Y placeholder
  minimums such as `-9999` cannot be commissioned.
- Every observation write is serialized and acknowledged before the runner
  advances or finalizes the run. A logging failure changes the run to FAIL.

## Run recovery and finalization

- Active lifecycle state is atomically persisted as `active-run.json` in the
  Electron user-data directory. Restarting after an interruption changes it to
  `recovery_required`; startup acknowledges the interruption without deleting
  the run's `_in_progress` artifacts.
- Run folders remain under `_in_progress` until the CSV stream is closed and
  the summary, report, manifest, and settings snapshot are ready. A
  `finalization.json` marker records `preparing`, `artifacts-ready`, and
  `finalized` transaction phases.
- Ordinary G-code commands are serialized. Emergency stop is deliberately not
  queued and invalidates commands that were waiting when it was activated.
- `fixture-adapters.js` provides a deterministic fake fixture for lifecycle,
  cancellation, fault, and queue tests without physical hardware.

## Configuration concurrency

- Renderer saves use `config:patch` with an expected revision. The main process
  accepts only supported root sections and rejects stale revisions instead of
  overwriting a newer workflow state.
- Campaign lifecycle remains main-process-owned and is intentionally excluded
  from renderer configuration patches.
- The active startup smoke implementation lives in `smoke-test-harness.js`;
  production startup only attaches it when `--smoke-test` is supplied.
- Campaign-specific presentation rules live in `campaign.css`, leaving the
  primary stylesheet focused on shared shell and control styling.

## Geometry and acceptance invariants

- Standalone mode uses the calibrated stand-mounted sensor point `(875, 1200)`
  and its tapered activation lobe; it does not use a DUT rectangle.
- Dual mode treats Radar A/B as one system. The selected Aqua DUT footprint is
  a 262 × 320 mm rectangle; acceptance uses nearest-edge offsets. Through
  304.8 mm requires detection, the band through 609.6 mm is optional/unscored,
  and beyond 609.6 mm requires no detection.
- The guided `ld021-system` hardware choice keeps `sensorLayout: dual` for Aqua
  DUT geometry while using `radarTarget: ld021_pair` for independent
  `LD021_A`/`LD021_B` acquisition. It is limited to experimental
  characterization/interference or unqualified custom/sequence work.
- A physical radar center and commissioned motion limits are inputs, not facts
  that may be inferred from a pilot dataset or source default.
- Invalid attempts are excluded from repeated-point voting. Equal valid votes
  remain an explicit tie.

## File map

| Area | Files |
|---|---|
| UI | `index.html`, `renderer.js`, `renderer-store.js`, `configuration-draft.js`, `run-state-view.js`, `styles.css`, `campaign.css` |
| Privileged app | `main.js`, `preload.js`, `run-controller.js`, `command-arbiter.js` |
| Pure logic | `validation-core.js`, `dut-location-core.js`, `radar-settings-core.js`, `run-naming-core.js`, `text-input-core.js`, `test-plan-core.js`, `test-plan-repository-core.js`, `recipe-core.js`, `operator-flow-core.js`, `operator-flow-state.js`, `run-workspace-core.js` |
| Campaigns | `campaign-core.js`, `campaign-manager.js`, `campaign-ledger.js` |
| Pi service | `pi-radar-service/radar_service.py`, `radar_protocol.py`, `ld021_protocol.py` |
| Engineering tools | `tools/` |
| Hardware test doubles | `fixture-adapters.js` |
| Tests | `test/` and `pi-radar-service/test_radar_service.py` |

Generated `node_modules/` and `dist/` are not source. `vendor/chart.umd.min.js`
is a checked-in third-party browser asset and should not be hand-edited.
