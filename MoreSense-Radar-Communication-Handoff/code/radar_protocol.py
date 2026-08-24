"""MoreSense HCI V2 frame construction and response parsing."""

from dataclasses import dataclass

ALLOWED_GAIN_CODES = (0x03, 0x13, 0x23, 0x33, 0x43, 0x53, 0x63,
                      0x73, 0x83, 0x93, 0xA3, 0xB3, 0xC3, 0xD3)
MIN_SAFE_THRESHOLD = 16
MAX_SAFE_THRESHOLD = 1022
QUERY_FRAME = bytes((0x55, 0x02, 0x12, 0x00, 0x69))
SAVE_FRAME = bytes((0x55, 0x02, 0x13, 0x01, 0x6B))
RESET_FRAME = bytes((0x55, 0x02, 0x13, 0x00, 0x6A))


class ProtocolError(ValueError):
    """Raised when a frame or radar response violates the protocol contract."""


@dataclass(frozen=True)
class RadarConfig:
    """The complete eight-byte configuration returned by a radar query."""

    power_code: int
    gain_code: int
    threshold: int
    output_time_ms: int

    def as_dict(self):
        return {
            "powerCode": self.power_code,
            "gainCode": self.gain_code,
            "threshold": self.threshold,
            "outputTimeMs": self.output_time_ms,
        }


def checksum(frame_without_checksum: bytes) -> int:
    """Returns the low eight bits of the additive MoreSense checksum."""
    return sum(frame_without_checksum) & 0xFF


def validate_operator_settings(gain_code: int, threshold: int):
    """Rejects undocumented gain codes and unsafe threshold extremes."""
    if gain_code not in ALLOWED_GAIN_CODES:
        raise ProtocolError("unsupported gain code")
    if not MIN_SAFE_THRESHOLD <= threshold <= MAX_SAFE_THRESHOLD:
        raise ProtocolError(
            f"threshold must be {MIN_SAFE_THRESHOLD}..{MAX_SAFE_THRESHOLD}"
        )


def parse_query_response(raw: bytes) -> RadarConfig:
    """Parses the fixed eight-byte POWER+GAIN+DELTA+LOT response."""
    if len(raw) != 8:
        raise ProtocolError(f"query response must contain 8 bytes, received {len(raw)}")
    power = raw[0]
    gain = raw[1]
    threshold = int.from_bytes(raw[2:4], "big")
    output_time = int.from_bytes(raw[4:8], "big")
    if gain not in ALLOWED_GAIN_CODES:
        raise ProtocolError(f"radar returned unknown gain code 0x{gain:02X}")
    if threshold > 1023:
        raise ProtocolError(f"radar returned invalid threshold {threshold}")
    return RadarConfig(power, gain, threshold, output_time)


def build_set_frame(config: RadarConfig, gain_code: int, threshold: int) -> bytes:
    """Builds a full set frame while preserving power and output hold time."""
    validate_operator_settings(gain_code, threshold)
    body = bytes((
        0x55, 0x09, 0x11, config.power_code, gain_code,
        (threshold >> 8) & 0xFF, threshold & 0xFF,
    )) + int(config.output_time_ms).to_bytes(4, "big")
    return body + bytes((checksum(body),))


def parse_ack(raw: bytes):
    """Accepts the documented ASCII OK response and rejects ER/garbage."""
    if raw == b"OK":
        return
    if raw == b"ER":
        raise ProtocolError("radar rejected command")
    raise ProtocolError(f"unexpected acknowledgement {raw.hex(' ')}")
