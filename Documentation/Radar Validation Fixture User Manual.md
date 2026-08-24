# Whisker Radar Validation Fixture User Manual

This is the operator guide for the experimental Whisker Radar Validation
Fixture. It covers safe operation, test execution, results, and shutdown.
Use [Installation and Commissioning](Installation%20and%20Commissioning.md) for
new or serviced fixtures and [Troubleshooting](Troubleshooting.md) for faults.

## Safety

- Keep hands, tools, cables, and loose material outside the motor travel area.
- Confirm the fixture is clear before homing or running.
- Use only measured, commissioned limits and an approved reflector macro.
- Stay near the fixture while motion is enabled.
- Use Emergency Stop for unsafe motion. Afterward correct the cause, perform
  Firmware Restart, home X/Y, and verify manual motion before a new run.
- Never use mock radar mode for qualification.
- Stop if the selected radar cannot be queried and read back independently.

## Before a run

1. Power the Pi, controller, reflector, and selected experimental radar target.
2. Start the application and connect to Moonraker.
3. Confirm Klipper is ready, required axes are homed, and no fault is active.
4. Select the test mode, Aqua DUT location or standalone sensor geometry, and
   traceable DUT identifier.
5. Review the generated/imported plan, travel limits, points, cycles, and
   acceptance threshold.
6. Query and verify the selected radar settings. Do not apply or save settings
   when reads are unreliable.
7. Confirm logging is enabled and the first home/move/reflector action can be
   observed safely.

## Run a Test workflow

Use the numbered questions from top to bottom:

1. Select Single or Dual sensor/system layout.
2. Select the actual sensor hardware. Only hardware matching the layout is shown.
3. Confirm the stand-mounted sensor position or choose the system-level DUT location.
4. Enter the traceable DUT/product name or ID.
5. Choose Positive Detection, Negative Detection, Total Bounds Testing, Characterization, Interference, Motion Sequence Only, or Custom. Tests unsupported by the selected hardware are hidden.
6. Choose a test plan. The list contains only plans from the selected test type that are compatible with the selected hardware.
7. Review points, Whole/Left/Middle/Right angular zone, cycles, and pass threshold. Unscored tests show the threshold as not applicable.
8. Review the resolved output-folder naming convention and protected local destination.
9. Review readiness. Connection, commissioning, radar verification, route safety, and output checks run automatically; correct any listed blocker, then press **Run Test**.

Run folders use this Windows-safe convention:

`DUT-{DUT}_{SENSOR}_{TEST}_PLAN-{PLAN}_{SETTINGS}_{CYCLES}_{DATE}_{TIME}`

Sensor tokens identify both hardware and layout, such as `MS58-SINGLE`,
`MORESENSE-DUAL`, `HLK-LD021-A`, `HLK-LD021-B`, `HLK-LD021-PAIR`,
`RCWL-SINGLE`, `RCWL-DUAL`, or `RCWL-PAIR`. MoreSense settings use labeled
gain and threshold values such as `G0x83-T250`; HLK uses `T512`; RCWL uses
`FIXED`. The application appends `_2`, `_3`, and so on only when an otherwise
identical folder name already exists.

The review fields, including point layout and X/Y reflector movement minimums and maximums,
remain editable until a run begins. Changing a plan-defining
field marks the plan as modified and reveals **New test plan name**. Enter a
unique name before running the test. The application saves a new derived
plan and leaves the original built-in or saved plan unchanged. Changing only
the DUT/product ID does not create a new plan.

### Creating and editing test plans

Use **Create or Edit Test Plans** beside the plan selector, or open
**Engineering Settings > Test Plans**. Both surfaces use the same records shown
in step 6 of **Run a Test**. Select a plan there to edit its points, angular zone,
cycles, pass threshold, definition reference, geometry, and linked motion
sequence. **Save Test Plan** saves changes as a new traceable version; a changed built-in is
saved as a new custom plan. New, Rename, and Delete operate on custom plans only.

The editor banner always says whether it is creating a new plan, editing a
custom version, or viewing a protected built-in. New plans expose **Test type**
before the type-specific controls. **Duplicate and Edit** is the normal route
for changing a built-in. Plan name, description, compatibility, procedure,
points, default cycles, and applicable acceptance settings are saved with the
plan. **Point layout** selects even distribution, boundary emphasis, raster
grid, repeatable seeded placement, imported points, or manual points. Movement
bounds limit every generated or imported reflector position and
must remain inside commissioned fixture travel and outside DUT keep-out
geometry. DUT identity, actual run location, radar conditions, and output naming
remain part of Run a Test or Campaign setup. The footer says **Save Test Plan**
while this tab is active.

The **Linked motion sequence** control is the plan's low-level path, not a
separate test-plan library. Older unlinked sequences are migrated into safe,
unscored **Motion Sequence Only** plans so they remain selectable. Engineering
Apply saves plan intent without moving or regenerating motion. The selected
fixture location and current safety limits are checked when **Run Test** is
pressed. That one action prepares the immutable run, performs preflight, and
starts motion when every safety requirement is satisfied. Any blocker remains
next to the operator flow with the corrective action; no second Run menu is
required. The separate motion-area button appears only during a run as the
abort/E-stop control.

For simple characterization of an Aqua system-level DUT fitted with two
Hi-Link sensors, choose **Dual sensor or system-level DUT**, then **Aqua
system-level DUT — two HLK-LD021 sensors**, followed by **Characterization**.
This uses the selected Aqua DUT location and dual-system keep-out geometry while
recording `LD021_A` and `LD021_B` independently. The profile is experimental and
is deliberately not offered as formal Total Bounds qualification.

## Test modes

- **Test 10.1 / Inside:** generated formal points require detection.
- **Test 10.2 / Outside:** generated formal points require no detection; the
  dual-system intermediate band is optional/unscored.
- **Characterization:** records observed behavior without a formal pass/fail
  rule and supports exact-count X/Y raster generation.
- **Custom validation:** uses a reviewed plan with per-point expected results.
- **Unscored sequence:** records motion and radar behavior without acceptance.
- **Interference plans:** use the RCWL or HLK pair targets and retain separate
  channel timing/results; they are characterization-only.

All radar target profiles are experimental. MoreSense MS58 settings use gain
and threshold; HLK-LD021 uses its threshold/output-time fields; RCWL has no
programmable settings. The selected target determines which controls appear.

## Normal sequence

```text
Home X/Y
  → move along the collision-safe route
  → wait for motion completion and settling
  → require a fresh LOW baseline
  → run REFLECTOR_SPIN
  → poll the selected radar output(s)
  → record the raw observation
  → hold and advance
  → return X/Y home
```

The application rejects unsafe endpoints and DUT-crossing route segments. A
failed baseline, missing input, incomplete command, or other unusable attempt
is `INVALID`; it is not silently treated as a miss or failure.

## Results and records

Each run is finalized under `Documents/Radar Validation Logs/` with available
artifacts including:

- `manifest.json` — test definition, geometry, settings, and plan
- `observations.csv` — raw motion, trigger, radar, and result events
- `summary.json` — reproducible totals and acceptance
- `report.html` — human-readable report
- `radar-settings.json` — selected-target snapshot

Missed detections keep null latency. With repeated cycles, invalid attempts are
excluded from voting, a strict majority determines the point state, and equal
votes remain a tie. Treat the finalized run folder and `manifest.json` as the
authoritative diagnostic record.

## Shutdown

1. Let the run finish or stop it safely.
2. Confirm the finalized folder contains `report.html` and `observations.csv`; these local files are authoritative.
3. Return the fixture to a safe home position.
4. Disconnect and close the application.
5. Remove power according to the lab procedure.
