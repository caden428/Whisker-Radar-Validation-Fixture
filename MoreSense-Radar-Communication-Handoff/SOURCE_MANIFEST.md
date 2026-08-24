# Source Manifest

## Copied source files

The following handoff files are byte-identical copies from this repository:

| Handoff path | Original path | Purpose |
|---|---|---|
| `code/radar_protocol.py` | `pi-radar-service/radar_protocol.py` | MoreSense HCI V2 frames and parsing |
| `code/radar_service.py` | `pi-radar-service/radar_service.py` | UART transports, manager, and HTTP API |
| `code/ld021_protocol.py` | `pi-radar-service/ld021_protocol.py` | Required import for combined service |
| `code/radar-settings.default` | `pi-radar-service/radar-settings.default` | Environment defaults |
| `code/radar-settings.service` | `pi-radar-service/radar-settings.service` | systemd unit |
| `code/install.sh` | `pi-radar-service/install.sh` | Pi installer |
| `tests/test_radar_service.py` | `pi-radar-service/test_radar_service.py` | Protocol/manager tests |

`SHA256SUMS.txt` contains hashes for these copied files. On Linux, verify with:

```sh
sha256sum -c SHA256SUMS.txt
```

The documentation files are new explanatory material and are intentionally not
claimed as copies.

## Windows application integration references

These remain in the parent application rather than this Pi handoff package:

- `main.js`: `activeRadarTarget()` and IPC handlers
  `radar-settings:read`, `radar-settings:apply`, `radar-settings:save`, and
  `radar-settings:reset`.
- `preload.js`: renderer-safe API methods for those IPC handlers.
- `radar-settings-core.js`: UI/API value normalization and response verification.
- `renderer.js`: operator workflows that apply, query, verify, and save settings.
- `test/radar-settings-core.test.js`: Windows-side validation tests.

The copied Pi code is the component that generates and interprets the actual
UART bytes. The Windows code communicates with it through typed HTTP JSON.

## Refreshing this handoff

If any original service source changes, copy it again, regenerate
`SHA256SUMS.txt`, rerun the copied tests, and review the documentation for
behavioral changes. Do not hand-edit a copied source file without clearly
marking it as a fork.

