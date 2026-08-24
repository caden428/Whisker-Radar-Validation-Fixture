"""Hi-Link HLK-LD021 motion-configuration frame parsing and construction."""

from dataclasses import dataclass

from radar_protocol import ProtocolError

PROTOCOL_PROFILE = "hilink-ld021-motion-v1"
MIN_THRESHOLD = 1
MAX_THRESHOLD = 0xFFFFFF
OUTPUT_TIME_STEP_MS = 100
MIN_OUTPUT_TIME_MS = 0
MAX_OUTPUT_TIME_MS = 0xFFFF * OUTPUT_TIME_STEP_MS
FRAME_HEADER = bytes((0x3C, 0x3A))
FRAME_TAIL = bytes((0x3A, 0x3E))
QUERY_FRAME = bytes.fromhex("3C 3A 07 FA 01 3A 3E")
SET_MODE_FRAME = bytes.fromhex("3C 3A 07 FB 01 3A 3E")
QUERY_RESPONSE_LENGTH = 25
ACK_LENGTH = 7


@dataclass(frozen=True)
class LD021Config:
    """Complete motion-mode configuration and query diagnostics."""

    version: int
    threshold: int
    light_threshold: int
    output_delay_units: int
    module_id: int
    output_mode: int
    light_ad: int = 0
    intermediate_frequency: int = 0
    noise_value: int = 0
    signal_value: int = 0

    @property
    def output_time_ms(self):
        return self.output_delay_units * 100

    def as_dict(self):
        return {
            "gainCode": None,
            "threshold": self.threshold,
            "outputTimeMs": self.output_time_ms,
            "firmwareVersion": self.version,
            "lightThreshold": self.light_threshold,
            "lightSensingEnabled": self.light_threshold != 0xFF,
            "moduleId": self.module_id,
            "outputMode": self.output_mode,
            "lightAd": self.light_ad,
            "intermediateFrequency": self.intermediate_frequency,
            "noiseValue": self.noise_value,
            "signalValue": self.signal_value,
        }


def validate_threshold(threshold: int):
    if not isinstance(threshold, int) or not MIN_THRESHOLD <= threshold <= MAX_THRESHOLD:
        raise ProtocolError(f"LD021 threshold must be {MIN_THRESHOLD}..{MAX_THRESHOLD}")


def validate_output_time_ms(output_time_ms: int):
    if (not isinstance(output_time_ms, int) or output_time_ms < MIN_OUTPUT_TIME_MS
            or output_time_ms > MAX_OUTPUT_TIME_MS or output_time_ms % OUTPUT_TIME_STEP_MS):
        raise ProtocolError(
            f"LD021 high time must be {MIN_OUTPUT_TIME_MS}..{MAX_OUTPUT_TIME_MS} ms "
            f"in {OUTPUT_TIME_STEP_MS} ms steps"
        )


def _validate_frame(raw: bytes, length: int, command: int, mode: int = 1):
    if len(raw) != length:
        raise ProtocolError(f"LD021 response must contain {length} bytes, received {len(raw)}")
    if raw[:2] != FRAME_HEADER or raw[-2:] != FRAME_TAIL:
        raise ProtocolError(f"invalid LD021 frame boundary {raw.hex(' ')}")
    if raw[2] != length or raw[3] != command or raw[4] != mode:
        raise ProtocolError(f"unexpected LD021 response {raw.hex(' ')}")


def parse_query_response(raw: bytes) -> LD021Config:
    _validate_frame(raw, QUERY_RESPONSE_LENGTH, 0xFA)
    threshold = int.from_bytes(raw[6:9], "big")
    validate_threshold(threshold)
    return LD021Config(
        version=raw[5],
        threshold=threshold,
        light_threshold=raw[9],
        output_delay_units=int.from_bytes(raw[10:12], "big"),
        module_id=int.from_bytes(raw[12:16], "big"),
        output_mode=raw[16],
        light_ad=raw[17],
        intermediate_frequency=raw[18],
        noise_value=int.from_bytes(raw[19:21], "big"),
        signal_value=int.from_bytes(raw[21:23], "big"),
    )


def build_set_frame(config: LD021Config, threshold: int, output_time_ms=None) -> bytes:
    """Changes requested motion fields and preserves every other setting."""
    validate_threshold(threshold)
    if output_time_ms is None:
        output_time_ms = config.output_time_ms
    validate_output_time_ms(output_time_ms)
    frame = FRAME_HEADER + bytes((0x13, 0xFD, 0x01))
    frame += threshold.to_bytes(3, "big")
    frame += bytes((config.light_threshold,))
    frame += (output_time_ms // OUTPUT_TIME_STEP_MS).to_bytes(2, "big")
    frame += config.module_id.to_bytes(4, "big")
    frame += bytes((config.output_mode, 0x00)) + FRAME_TAIL
    return frame


def parse_ack(raw: bytes, command: int, mode: int = 1):
    _validate_frame(raw, ACK_LENGTH, command, mode)
