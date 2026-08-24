# MoreSense Protocol and Return Bytes

## Three different response layers

Do not confuse these layers:

1. **UART bytes from the radar** are the eight-byte query value or two-byte
   acknowledgement described below.
2. **Python objects** are produced after those bytes pass length and content
   validation.
3. **HTTP JSON** is the service's structured result returned to Electron or
   `curl`. JSON is not sent by the radar.

The radar returns bytes for every supported transaction: eight bytes for a
query and two acknowledgement bytes for write, save, and reset. In addition,
the service deliberately performs new queries after writes and saves.

## Numeric conventions

- Multibyte values are big-endian: most-significant byte first.
- Command checksum is `sum(all preceding frame bytes) & 0xFF`.
- Gain is a single code byte, not a linear percentage.
- Safe application threshold is limited to 16..1022 by this software.
- A parsed query permits the protocol range through 1023, allowing observation
  of a value that the operator path will not write.

## Query/read

Command sent:

| Offset | Value | Meaning |
|---:|---:|---|
| 0 | `55` | Frame start |
| 1 | `02` | Length/command format byte |
| 2 | `12` | Query operation |
| 3 | `00` | Query argument |
| 4 | `69` | Additive checksum |

Full frame: `55 02 12 00 69`

The radar must return exactly eight bytes:

| Offset(s) | Meaning | Parsing |
|---|---|---|
| 0 | Power code | One byte |
| 1 | Gain code | One allowed gain byte |
| 2..3 | Detection threshold | Unsigned 16-bit big-endian |
| 4..7 | Output hold time | Unsigned 32-bit big-endian milliseconds |

Example response: `00 33 00 64 00 00 01 FF`

This decodes as power `0`, gain `0x33`, threshold `100`, and output time `511`
milliseconds. Wrong length, an unknown gain, or threshold above 1023 fails.

## Apply/write active configuration

The service first queries the radar. The write includes the returned power and
output-time fields so that only gain and threshold change.

| Offset(s) | Meaning |
|---|---|
| 0 | `55`, frame start |
| 1 | `09`, length/format |
| 2 | `11`, set operation |
| 3 | Preserved current power code |
| 4 | Requested gain code |
| 5..6 | Requested threshold, big-endian |
| 7..10 | Preserved current output time, big-endian |
| 11 | Additive checksum |

Example using current power `0`, output time `511`, gain `0x33`, threshold
`100`: `55 09 11 00 33 00 64 00 00 01 FF 06`.

Immediate response must be exactly:

- `4F 4B` (`OK`): command acknowledged.
- `45 52` (`ER`): command rejected; the service fails.
- Any other two bytes or any other length: the service fails.

After `OK`, the manager sends a separate five-byte query and requires its
eight-byte response to contain the requested gain and threshold. In dual mode
this happens independently for A and B, followed by another complete target
query. Therefore an apply involves a combination of write acknowledgements and
query return bytes.

## Save permanent configuration

Command: `55 02 13 01 6B`

Immediate response is the same two-byte `OK`/`ER` acknowledgement. The service
then sends a query and returns that configuration as JSON.

The post-save query proves the radar is online and its active values still
match. It cannot distinguish RAM from EEPROM because power has not been
removed. Only a cold power cycle followed by a query proves persistence.

## Factory reset

Command: `55 02 13 00 6A`

Immediate response is two-byte `OK`/`ER`. The service then queries again. The
HTTP endpoint additionally requires the exact phrase `FACTORY RESET` to reduce
the chance of an accidental reset.

## Allowed gain codes

```text
03 13 23 33 43 53 63 73 83 93 A3 B3 C3 D3
```

All other gain bytes are rejected before a write and rejected if observed in a
query response. The spacing between codes is intentional and reflects the
documented radar encoding; the code does not invent intermediate values.

## HTTP response example

An abbreviated successful query for target `dual` resembles:

```json
{
  "success": true,
  "protocolProfile": "moresense-hci-v2",
  "activeTarget": "dual",
  "activeChannels": ["A", "B"],
  "persistent": false,
  "sensors": {
    "A": {"online": true, "verified": true, "powerCode": 0, "gainCode": 67, "threshold": 125, "outputTimeMs": 2000},
    "B": {"online": true, "verified": true, "powerCode": 0, "gainCode": 67, "threshold": 125, "outputTimeMs": 2000}
  },
  "error": ""
}
```

Decimal `67` is hexadecimal `0x43`. `success: true` for `dual` means both
queries parsed and both radars returned matching gain and threshold.

