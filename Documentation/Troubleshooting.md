# Troubleshooting

Preserve the run folder and relevant application, Klipper, Moonraker, and
radar-service logs before repairing anything. Do not bypass readiness checks.

## First response

1. Stop motion or use Emergency Stop if the fixture is unsafe.
2. Record the error, phase, point, target, and run-folder name.
3. Check the application status indicators and the local run artifacts.
4. Correct one subsystem at a time, then repeat its acceptance check.

## Connection or Klipper failure

- Confirm the Pi is reachable and Moonraker is listening on port 7125.
- Confirm the MCU is connected, Klipper is `ready`, and no shutdown is active.
- Inspect `klippy.log` and `moonraker.log` after correcting power or wiring.
- After an emergency stop, perform Firmware Restart, home X/Y, and test manual
  motion before starting a new run.

## Homing, limits, or collision failure

- Clear the mechanism and inspect end stops, belts, connectors, and drivers.
- Verify the selected travel limits and Aqua DUT location.
- Review the previewed routed polyline; do not bypass `ERR008` or a soft limit.
- Recommission low-speed motion before a full run.

## Reflector timeout

Confirm the `REFLECTOR_SPIN` macro exists, the reflector/Z mechanism is free,
and Klipper acknowledged the command. Inspect driver and MCU faults. Do not
diagnose a reflector timeout as an XY binding problem without evidence.

## Radar settings verification failure

Do not apply or save settings. On the Pi check:

```sh
systemctl --no-pager --full status pigpiod radar-settings
curl http://127.0.0.1:7130/v1/health
curl 'http://127.0.0.1:7130/v1/radars?target=dual'
journalctl -u radar-settings -n 100 --no-pager
readlink -f /dev/serial0
cat /etc/default/radar-settings
```

Then verify target selection, power, common ground, TX/RX direction, UART
ownership, serial-console configuration, pigpio, and OUT wiring. An MS58
query must return a repeatable eight-byte frame. A zero-byte or short response
means communication is not verified; check the installed firmware/profile and
only consider `RADAR_PREAMBLE_ZEROS=5` after a query-only bench test.

## Invalid observations or incomplete reports

Inspect `observations.csv` and nearby event rows. Invalid attempts must remain
invalid. Check for a stale HIGH baseline, missing OUT input, interrupted
motion/reflector command, or an incomplete run folder. Use the recovery tools
only after backing up the source run folder.

## Local campaign history failure

Confirm the local report and campaign history were written first. Inspect the
finalized run folder and the local campaign history CSV. Never rerun hardware
solely because a report viewer or network-connected tool is unavailable.
