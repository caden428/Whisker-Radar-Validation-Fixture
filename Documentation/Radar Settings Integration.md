# Radar Settings Integration

This document owns the experimental radar target matrix, Raspberry Pi wiring,
service configuration, and physical acceptance. The service is normally
available at `http://<pi>:7130`; Moonraker remains the separate motion API.

## Experimental target profiles

| UI target | Service target | Interface | Status |
|---|---|---|---|
| MoreSense MS58 dual | `dual` | A hardware UART, B software UART, A/B OUT | Experimental |
| MS58 standalone | `single` | SINGLE software UART and OUT | Experimental |
| RCWL-0516 single | `rcwl_single` | Digital OUT only | Experimental |
| RCWL-0516 dual | `rcwl_dual` | A/B digital OUT | Experimental |
| RCWL-0516 interference pair | `rcwl_pair` | Independent A/B digital OUT | Experimental |
| HLK-LD021 Sensor A | `ld021_a` | GPIO5/6 software UART and GPIO13 OUT | Experimental |
| HLK-LD021 Sensor B | `ld021_b` | Audited software UART and GPIO19 OUT | Experimental |
| Two HLK-LD021 sensors | `ld021_pair` | Independent A/B UART and OUT | Experimental |

The legacy service target `ld021` aliases the Sensor A profile. The selected
target controls settings verification, detection inputs, geometry, and report
traceability. Do not configure or test an uninstalled target.

## Shipped Pi assignments

GPIO values are BCM numbers; physical header numbers are shown for wiring.

| Function | BCM | Physical pin |
|---|---:|---:|
| MS58 A TX to Pi / UART RX | 15 | 10 |
| MS58 A RX from Pi / UART TX | 14 | 8 |
| MS58 A OUT | 18 | 12 |
| MS58 B TX to Pi / software RX | 25 | 22 |
| MS58 B RX from Pi / software TX | 24 | 18 |
| MS58 B OUT | 23 | 16 |
| MS58 SINGLE TX to Pi | 27 | 13 |
| MS58 SINGLE RX from Pi | 22 | 15 |
| MS58 SINGLE OUT | 26 | 37 |
| HLK A TX/RX | GPIO6 / GPIO5 | 31 / 29 |
| HLK A OUT | 13 | 33 |
| HLK B OUT | 19 | 35 |
| Common ground | GND | 39 |

Wire sensor TX to Pi RX and Pi TX to sensor RX. All grounds share the common
ground. The MS58 `3V3` variant must not receive 5 V. RCWL `3V3` is an output,
not a supply input. HLK P1 power uses the approved 5 V rail; never power it
from a GPIO. Verify logic levels for every installed board revision.

## Environment file

The installer copies `radar-settings.default` to
`/etc/default/radar-settings` only when that file does not exist. Review the
actual file on the Pi:

```text
RADAR_A_DEVICE=/dev/serial0
RADAR_B_TX_GPIO=24
RADAR_B_RX_GPIO=25
RADAR_SINGLE_TX_GPIO=22
RADAR_SINGLE_RX_GPIO=27
RADAR_SINGLE_OUT_GPIO=26
RADAR_LD021_A_TX_GPIO=5
RADAR_LD021_A_RX_GPIO=6
RADAR_LD021_B_TX_GPIO=
RADAR_LD021_B_RX_GPIO=
RADAR_PREAMBLE_ZEROS=0
RADAR_SERVICE_PORT=7130
```

Sensor B HLK UART pins must be assigned together after a pin audit. The
service rejects incomplete or duplicate software-UART assignments. The
five-zero preamble is disabled by default and may be enabled only after a
query-only bench test proves it is required by the installed MS58 firmware.

## Pi prerequisites and install

1. Back up `printer.cfg`, the boot configuration, and the kernel command line.
2. Confirm the required GPIOs are not owned by Klipper, UART/Bluetooth,
   I²C/SPI, or another service (`gpioinfo` plus configuration review).
3. Disable the serial login console while leaving UART hardware enabled.
4. On a Raspberry Pi 3, use the commissioned PL011 mapping and verify
   `/dev/serial0` resolves to GPIO14/15 after reboot.
5. Install the Klipper input definitions from
   `printer-radar-inputs.cfg.example` for the selected OUT channels.
6. Install the service:

```sh
cd pi-radar-service
python3 -m unittest -v test_radar_service.py
sudo sh ./install.sh
curl http://127.0.0.1:7130/v1/health
curl 'http://127.0.0.1:7130/v1/radars?target=dual'
```

`pigpiod` and `python3-pigpio` are installed by `install.sh`. Check
`systemctl status pigpiod radar-settings` and `journalctl -u radar-settings`
when the service does not start.

## Physical acceptance

- Query the selected target repeatedly; an MS58 query must return a repeatable
  eight-byte configuration frame.
- Apply only approved, safe values and verify independent read-back.
- Confirm persistence after a controlled power cycle where the firmware
  supports it.
- Trigger each active OUT channel independently and confirm the GUI reports
  the correct channel or pair state.
- Disconnect each active OUT wire in turn and confirm readiness blocks the run.
- Run a short non-qualification characterization and inspect the manifest,
  radar-settings snapshot, CSV, and report.

If a query returns zero or the wrong number of bytes, stop before any write.
Check power, common ground, TX/RX direction, UART ownership, serial-console
configuration, `/dev/serial0`, pigpio, and the installed firmware/protocol.
