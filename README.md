# Whisker Radar Validation Fixture

Electron application for operating the Whisker Radar Validation Fixture,
recording raw observations, generating local engineering reports, and keeping
run results in local HTML and CSV artifacts.

This package is a development source tree. Hardware values and radar protocol
profiles remain experimental until the installed fixture passes commissioning.

## Quick start

```bat
install.cmd
npm test
launch.cmd
```

Use `build.cmd` to create the Windows installer. `node_modules/` and `dist/`
are generated and should not be included in source handoffs.

## Running and designing tests

The operator completes one numbered flow: layout, hardware, location, test
type, compatible test plan, and editable run rules. Pressing **Run Test** saves
any named plan changes, generates and validates motion, runs preflight, and
starts the test when the fixture is ready. No additional recipe or setup menu
is required for normal operation.

Reusable plans are versioned in the canonical test-plan repository. Engineering
Setup is reserved for maintaining plans, fixture commissioning, hardware,
geometry, timing, logging, and advanced point definitions.

## Read next

- [Documentation home](Documentation/README.md)
- [Developer handoff](Documentation/Developer%20Handoff.md)
- [Code guide](Documentation/Code%20Guide.md)
- [Installation and commissioning](Documentation/Installation%20and%20Commissioning.md)

## System boundary

The Electron app talks to Klipper through Moonraker (normally port 7125) and
to the Raspberry Pi radar-settings service (normally port 7130). `main.js`
owns filesystem and network privileges; `preload.js` exposes the restricted
renderer API; `renderer.js` owns the UI and run sequence; pure core modules
hold validation, geometry, radar-setting, campaign, and naming rules.

The Pi service owns radar UART transactions and read-back verification. The
fixture supports experimental MoreSense MS58, RCWL-0516, and HLK-LD021 target
profiles. The selected target controls wiring, settings, detection inputs,
geometry, and report traceability.

## Current behavior that must not regress

- Every trigger attempt is retained as a raw observation.
- Missed detections retain null latency; invalid observations are never turned
  into passes, failures, or synthetic latency.
- A fresh LOW radar baseline is required before each trigger.
- Formal inside/outside plans use the current geometry definition; dual-system
  geometry measures nearest edge of the selected Aqua DUT footprint, while
  standalone mode uses the calibrated stand-mounted sensor lobe.
- Motion routes are collision-safe around the selected DUT. Both renderer
  preflight and the main process reject unsafe endpoints or segments.
- The finalized local run folder is authoritative. Network errors cannot change
  the local test result.
- Radar writes are range-checked and must be verified by independent readback.
- Single runs and campaigns execute the same versioned test-plan snapshots through
  the same planner, preflight checks, runner, logging, and reporting paths.

See the maintained documents for procedures, hardware wiring, and extension
points. Do not infer commissioning values from the defaults in `main.js`.
