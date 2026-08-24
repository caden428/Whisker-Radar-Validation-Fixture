# Installation and Commissioning

Use this procedure for a new fixture, replacement computer/Pi, or any change
to motion hardware, wiring, firmware, radar profile, or communication. Routine
operators should use the [User Manual](Radar%20Validation%20Fixture%20User%20Manual.md).

All radar variants in this package are experimental. Do not qualify hardware
with mock inputs, placeholder limits, or an unverified reflector macro.

## Prerequisites

- Approved mechanical and electrical information for the installed fixture
- Windows computer, Raspberry Pi, SKR controller, installed radar hardware,
  and finished wiring harness
- Measured safe travel limits and an accepted emergency-stop method
- A controlled test method defining the required radar target and geometry

## Commissioning sequence

1. **Inspect hardware.** With power disconnected, inspect frame, axes, belts,
   end stops, reflector, cable routing, grounding, and connectors. Record
   fixture identifiers and measured travel.
2. **Commission Klipper/Moonraker.** Back up the active configuration, verify
   the MCU and end stops, home conservatively, confirm Moonraker on port 7125,
   and test the `REFLECTOR_SPIN` macro repeatedly.
3. **Commission the radar service.** Follow [Radar Settings Integration](Radar%20Settings%20Integration.md).
   Select only the physically installed target. Mock mode is for UI/network
   checks only and must be stopped before physical acceptance.
4. **Install the Windows app.** Run `install.cmd`, connect to Moonraker, enter
   measured limits and physical reference values, verify low-speed motion and
   the status panel, then select the commissioning confirmation in Engineering
   Settings. Speed fields are millimetres per second; the app performs the
   Klipper millimetres-per-minute conversion internally.
5. **Run integrated acceptance.** Jog axes at low speed, compare commanded and
   reported coordinates, trigger the reflector, verify radar inputs and
   settings read-back, and run a short non-qualification characterization.
6. **Record release data.** Record accepted limits, radar target/profile,
   physical center, timing, speed, acceleration, reflector configuration,
   software version, Klipper revision, date, and approver.

## Acceptance evidence

The selected radar target must query reliably, return valid read-back, and
produce distinguishable OUT behavior. A dual target verifies A/B together; a
single target verifies only its selected channel. Confirm the run contains
`observations.csv`, `manifest.json`, `summary.json`, `report.html`, and the
radar-settings snapshot.

If any step fails, use [Troubleshooting](Troubleshooting.md), correct that
subsystem, and repeat its acceptance plus the integrated test.
