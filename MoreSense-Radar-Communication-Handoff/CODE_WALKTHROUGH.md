# Code Walkthrough

## `radar_protocol.py`: the MoreSense byte contract

This is the protocol-specific layer. It contains no GPIO, HTTP, or UI logic.

- `RadarConfig` represents the eight returned configuration bytes as power,
  gain, threshold, and output hold time.
- `checksum()` adds every preceding command byte and keeps the low eight bits.
- `validate_operator_settings()` restricts writes to documented gain codes and
  thresholds 16 through 1022. This prevents the HTTP/UI path from issuing an
  arbitrary one-byte gain or an extreme threshold.
- `parse_query_response()` requires exactly eight bytes, interprets threshold
  and output time as big-endian integers, and rejects unknown gain codes or a
  threshold above the protocol's 10-bit maximum.
- `build_set_frame()` first validates the requested values. It copies the
  radar's current power code and output hold time into the write frame, so a
  gain/threshold adjustment cannot silently overwrite unrelated settings.
- `parse_ack()` accepts only ASCII `OK`. ASCII `ER` and all other byte pairs
  fail the operation.

The fixed `QUERY_FRAME`, `SAVE_FRAME`, and `RESET_FRAME` constants include
their final checksum bytes.

## `radar_service.py`: transport, coordination, and HTTP

### Transport implementations

`PosixSerialTransport` uses `/dev/serial0` at 9600 baud, 8 data bits, no parity,
and one stop bit. Before a transaction it flushes unread input, writes the full
command, and reads until the exact expected response length arrives or the
0.35-second deadline expires.

`PigpioSerialTransport` provides a software UART for channels without a spare
hardware UART. It drains stale RX data before sending. Its class-wide lock is
important because pigpio exposes a single waveform engine for the whole Pi;
two simultaneous software-UART transmissions could otherwise corrupt one
another. The manager also serializes radar operations at a higher level.

Both transports are intentionally length-driven. They do not declare success
on a partial response.

`MockTransport` models the same commands in memory for repeatable tests. Its
`config` is the active value and `saved` represents the last saved value. This
is a test model, not proof of physical EEPROM behavior.

### `RadarDevice`: one MoreSense radar

- `query()` sends the query frame, expects eight bytes, then parses them.
- `apply()` builds a full settings frame, expects two bytes, and accepts only
  `OK`.
- `save()` sends the save frame, expects two bytes, and accepts only `OK`.
- `reset()` follows the same acknowledgement rule.
- `persistent_on_apply` is `False`, explicitly distinguishing active/temporary
  apply from the separate save operation.
- Optional leading zero bytes are supported for firmware that requires a
  preamble. The default is zero; it should be changed only after a query-only
  bench test establishes that it is necessary.

### `RadarManager`: multi-radar transaction rules

`query_all()` queries only the channels belonging to the selected target. A
channel is online only when its query completed and parsed. For `dual`, success
also requires the returned gain and threshold to match across A and B.

`apply_all()` performs the following sequence:

1. Validate every requested value before sending any write.
2. Query and retain each radar's previous full configuration.
3. Apply to one channel and require its two-byte acknowledgement.
4. Independently query that channel and compare returned gain and threshold
   with the requested values.
5. Repeat for the other active channel.
6. If a later step fails, attempt to restore already-changed channels using
   the saved pre-apply configurations.
7. Query the complete target once more for the returned JSON state.

Thus `OK` alone is never considered proof that a MoreSense apply succeeded.
The returned configuration must match as well.

`save_all()` first requires a successful current query. It then sends the save
command to every active channel and requires `OK` from each, followed by a
fresh query. The returned `persistent: true` is workflow metadata; it is not a
measurement of EEPROM after power loss.

### HTTP layer

The service exposes:

| Method and path | Manager operation |
|---|---|
| `GET /v1/health` | Service health/profile information |
| `GET /v1/radars?target=dual` | `query_all()` |
| `POST /v1/radars/apply` | `apply_all()` |
| `POST /v1/radars/save` | `save_all()` |
| `POST /v1/radars/reset` | `reset_all()` after exact confirmation |

Protocol, transport, and input failures become HTTP 409 JSON responses.
Unexpected service faults become HTTP 500. Authentication is optional but,
when configured, requires an exact bearer token.

## Windows caller in the working application

The Electron main process selects `dual` or `single`, validates values again
with `radar-settings-core.js`, and calls the typed HTTP endpoints. The renderer
does not directly access serial hardware. The source application locations are
listed in `SOURCE_MANIFEST.md`; they are not copied here because the handoff
service has no Electron runtime dependency.

## Supporting files

- `radar-settings.default` documents service token, UART/GPIO assignments, and
  the optional preamble.
- `radar-settings.service` runs the bridge as the `pi` user under systemd.
- `install.sh` installs the reviewed files and pigpio dependency.
- `ld021_protocol.py` is a required import for the combined service but is not
  part of the MoreSense protocol described here.
- `test_radar_service.py` tests the shared service and both supported protocol
  families; the MoreSense cases are identified in the protocol guide.

