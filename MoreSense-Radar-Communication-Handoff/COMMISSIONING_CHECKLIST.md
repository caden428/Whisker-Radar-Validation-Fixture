# MoreSense Commissioning Checklist

Use approved engineering values for the installed board revision. Do not use
mock mode for physical acceptance or qualification.

## 1. Record the comparison baseline

- Record Pi model and OS, radar model/board revision, radar firmware if known,
  service source hashes, wiring, power voltage, and common-ground arrangement.
- Record `/etc/default/radar-settings` with any secret token redacted.
- Confirm whether the target is `dual` or `single`.
- Confirm `/dev/serial0` and every software-UART GPIO are unclaimed by other
  services or interfaces.

## 2. Test the software without hardware writes

From the handoff root:

```sh
PYTHONPATH=code python3 -m unittest -v tests/test_radar_service.py
```

All tests must pass. Then install/start the service and check:

```sh
systemctl --no-pager --full status pigpiod radar-settings
curl http://127.0.0.1:7130/v1/health
```

If authentication is enabled, add `-H 'Authorization: Bearer TOKEN'` to every
request below.

## 3. Query only before allowing a write

Run the applicable request several times:

```sh
curl 'http://127.0.0.1:7130/v1/radars?target=dual'
curl 'http://127.0.0.1:7130/v1/radars?target=single'
```

Acceptance:

- Every active sensor is `online: true`.
- Every response is `success: true`.
- Gain, threshold, and output time are repeatable.
- Dual A/B gain and threshold match.
- Service logs contain no short-response or timeout errors.

Stop before writes if a response is missing, short, intermittent, contains an
unknown gain, or reports a threshold above 1023. Check power, voltage, ground,
TX/RX crossover, UART ownership, login-console settings, pigpio, GPIO numbers,
and whether the installed firmware requires the optional zero preamble.

## 4. Prove temporary apply/read-back

Choose an approved test gain and threshold that differ from the recorded
baseline. Example only (`0x43` is decimal 67; threshold 125):

```sh
curl -X POST http://127.0.0.1:7130/v1/radars/apply \
  -H 'Content-Type: application/json' \
  -d '{"target":"dual","gainCode":67,"threshold":125}'
```

For `single`, change the target accordingly. Acceptance:

- HTTP returns success.
- Every write received UART `OK` internally.
- The service's independent read-back returns gain 67 and threshold 125 for
  every active sensor.
- `persistent` is `false` for a MoreSense apply.
- A separate manual GET query returns the same values.

This proves active/temporary configuration. It does not prove EEPROM.

## 5. Prove the save command and immediate read-back

Only after step 4 succeeds:

```sh
curl -X POST http://127.0.0.1:7130/v1/radars/save \
  -H 'Content-Type: application/json' \
  -d '{"target":"dual"}'
```

Acceptance:

- Save returns success and `persistent: true`.
- A new GET query returns the selected settings for every active sensor.

At this stage, `persistent: true` records that the save command was
acknowledged and immediate read-back succeeded. Do not yet claim power-cycle
persistence.

## 6. Prove permanent storage with a cold power cycle

1. Record the complete successful pre-power-cycle query JSON.
2. Shut down the fixture safely.
3. Remove radar power long enough for its supply to discharge; do not merely
   restart the HTTP service.
4. Restore radar and Pi/fixture power according to the approved startup order.
5. Wait for the service and radar to become ready.
6. Query the same target without applying or saving anything first.
7. Compare every active radar's gain and threshold against the recorded saved
   values.

Only a match at step 7 proves the setting survived power loss. Record the JSON,
timestamps, power-off duration, and operator. A mismatch means persistence is
not validated even if the prior `/save` response said `persistent: true`.

## 7. Restore the intended production configuration

If the commissioning values were temporary test values, apply the approved
production gain and threshold, verify read-back, save, and repeat the cold
power-cycle proof. Never leave a fixture in an undocumented state.

## 8. Compare the second system with the original

For both systems record:

- Query command behavior and exact eight returned values.
- Apply result, acknowledgement outcome, and read-back.
- Save result and cold-start read-back.
- Dual-channel matching behavior.
- Response and failure behavior with one radar disconnected.
- Service logs and source hashes.

Matching HTTP JSON is useful, but equivalence requires the same physical
settings after a cold restart and the same handling of invalid or absent
responses.

## Common failures

| Symptom | Likely area |
|---|---|
| Expected 8 bytes, received 0 | Power, ground, swapped TX/RX, wrong device/GPIO, console owns UART |
| Short response | Timing/noise, wrong baud/protocol, unstable power |
| `ER` acknowledgement | Radar rejected the command or firmware differs |
| Unknown gain code | Different firmware/protocol or corrupt response |
| Apply says read-back mismatch | Write not applied, wrong sensor, stale/incorrect UART data |
| A/B settings do not match | Channels were configured independently or one write failed |
| Save succeeds but cold query reverts | Save did not reach nonvolatile storage or firmware semantics differ |
