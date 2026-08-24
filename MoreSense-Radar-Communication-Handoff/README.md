# MoreSense Radar Communication Handoff

This package contains the exact Raspberry Pi service code used by the Radar
Validation Fixture to communicate with MoreSense MS58 radars. It is intended
to let another engineer install the same service, compare behavior, and prove
that their radar responds the same way.

## What is included

- `code/`: byte-identical copies of the deployed service sources and install files.
- `tests/`: the service's original protocol and manager tests.
- `CODE_WALKTHROUGH.md`: responsibility and design explanation for each code layer.
- `PROTOCOL_AND_RETURN_BYTES.md`: byte-level commands, responses, and validation.
- `COMMISSIONING_CHECKLIST.md`: safe reproduction and persistence checks.
- `SOURCE_MANIFEST.md`: provenance and SHA-256 verification instructions.

`ld021_protocol.py` is included because `radar_service.py` imports it. The
MoreSense/MS58 handoff does not require an LD021 sensor.

## System path

```text
Electron UI
  -> validated Electron IPC handler
  -> authenticated HTTP request to port 7130
  -> radar_service.py
  -> hardware UART or pigpio software UART (9600 baud, 8N1)
  -> MoreSense radar
  -> UART response
  -> parsed service JSON
  -> Electron UI
```

The Pi service deliberately exposes typed query, apply, save, and reset
operations. It does not expose an arbitrary serial-write endpoint.

## MoreSense targets in the working system

| Service target | Physical channels | Transport |
|---|---|---|
| `dual` | A and B | A: `/dev/serial0`; B: pigpio software UART |
| `single` | SINGLE | pigpio software UART |

Default BCM GPIO assignments are in `code/radar-settings.default`. Sensor TX
connects to Pi RX and Pi TX connects to sensor RX. Confirm voltage levels and
share a common ground before applying power.

## Install on a Raspberry Pi

1. Review and back up the Pi configuration.
2. Confirm that the configured UART and GPIO pins are not used by Klipper,
   Bluetooth, a login console, or another service.
3. Disable the serial login console while leaving UART hardware enabled.
4. Run the tests before installation:

   ```sh
   cd MoreSense-Radar-Communication-Handoff
   PYTHONPATH=code python3 -m unittest -v tests/test_radar_service.py
   ```

5. Install from the `code` directory:

   ```sh
   cd code
   sudo sh ./install.sh
   ```

6. Review `/etc/default/radar-settings`. The installer preserves an existing
   copy rather than overwriting it.
7. Check the service:

   ```sh
   systemctl status pigpiod radar-settings
   curl http://127.0.0.1:7130/v1/health
   curl 'http://127.0.0.1:7130/v1/radars?target=dual'
   ```

If `RADAR_SERVICE_TOKEN` is set, add `Authorization: Bearer <token>` to HTTP
requests and configure the same token in the Windows application.

## Critical meaning of temporary and permanent

For MoreSense, `/apply` changes the active configuration and reports
`persistent: false`. The service accepts the apply only after each radar sends
`OK` and a separate query returns the requested gain and threshold.

`/save` sends the separate MoreSense save command, requires `OK`, then queries
again and reports `persistent: true`. That flag means the save command was
acknowledged and the current settings still read correctly. It does **not**
prove that nonvolatile memory survived removal of power.

Use the cold-power-cycle procedure in `COMMISSIONING_CHECKLIST.md` for actual
persistence proof.

## Automated tests versus hardware proof

The included tests validate frame construction, parsing, safe value limits,
apply/read-back behavior, dual-radar matching, and save workflow with mock
transports. They cannot validate wiring, UART timing, the installed radar
firmware, EEPROM behavior, or survival across a real power cycle.
