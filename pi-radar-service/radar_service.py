#!/usr/bin/env python3
"""HTTP bridge between the Electron fixture GUI and configured radar modules."""

import argparse
import json
import os
import select
import threading
import time
from urllib.parse import parse_qs, urlsplit
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from radar_protocol import (
    QUERY_FRAME, RESET_FRAME, SAVE_FRAME, RadarConfig, ProtocolError,
    build_set_frame, parse_ack, parse_query_response, validate_operator_settings,
)
from ld021_protocol import (
    ACK_LENGTH as LD021_ACK_LENGTH,
    LD021Config,
    PROTOCOL_PROFILE as LD021_PROTOCOL_PROFILE,
    QUERY_FRAME as LD021_QUERY_FRAME,
    QUERY_RESPONSE_LENGTH as LD021_QUERY_RESPONSE_LENGTH,
    SET_MODE_FRAME as LD021_SET_MODE_FRAME,
    build_set_frame as build_ld021_set_frame,
    parse_ack as parse_ld021_ack,
    parse_query_response as parse_ld021_query_response,
    validate_output_time_ms as validate_ld021_output_time_ms,
    validate_threshold as validate_ld021_threshold,
)


class TransportError(RuntimeError):
    """Raised when bytes cannot be exchanged reliably with a radar."""


class PosixSerialTransport:
    """Hardware-UART transport for Radar A using /dev/serial0 at 9600 8N1."""

    def __init__(self, device="/dev/serial0", baud=9600):
        self.device = device
        self.baud = baud
        self._fd = None

    def open(self):
        import termios
        if self._fd is not None:
            return
        self._fd = os.open(self.device, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
        attrs = termios.tcgetattr(self._fd)
        attrs[0] = 0
        attrs[1] = 0
        attrs[2] = termios.CS8 | termios.CREAD | termios.CLOCAL
        attrs[3] = 0
        attrs[4] = termios.B9600
        attrs[5] = termios.B9600
        attrs[6][termios.VMIN] = 0
        attrs[6][termios.VTIME] = 0
        termios.tcsetattr(self._fd, termios.TCSANOW, attrs)
        termios.tcflush(self._fd, termios.TCIOFLUSH)

    def exchange(self, command: bytes, expected: int, timeout_s=0.35) -> bytes:
        import termios
        self.open()
        termios.tcflush(self._fd, termios.TCIFLUSH)
        written = 0
        while written < len(command):
            written += os.write(self._fd, command[written:])
        result = bytearray()
        deadline = time.monotonic() + timeout_s
        while len(result) < expected and time.monotonic() < deadline:
            readable, _, _ = select.select([self._fd], [], [], max(0, deadline - time.monotonic()))
            if readable:
                result.extend(os.read(self._fd, expected - len(result)))
        if len(result) != expected:
            raise TransportError(f"{self.device}: expected {expected} bytes, received {len(result)}")
        return bytes(result)


class PigpioSerialTransport:
    """DMA-timed software UART on ordinary Pi GPIO pins."""

    # pigpio owns one wave engine for the whole Pi.  Two independent software
    # UART instances must never clear/create/send waves concurrently.
    _wave_lock = threading.RLock()

    def __init__(self, tx_gpio=24, rx_gpio=25, baud=9600):
        self.tx_gpio = tx_gpio
        self.rx_gpio = rx_gpio
        self.baud = baud
        self._pi = None

    def configuration(self):
        return {
            "interface": "pigpio-software-uart",
            "piTxGpio": self.tx_gpio,
            "piRxGpio": self.rx_gpio,
            "baud": self.baud,
            "framing": "8N1",
        }

    def open(self):
        if self._pi is not None:
            return
        try:
            import pigpio
        except ImportError as exc:
            raise TransportError("python3-pigpio is not installed") from exc
        self._pigpio = pigpio
        self._pi = pigpio.pi()
        if not self._pi.connected:
            raise TransportError("pigpiod is not running")
        self._pi.set_mode(self.tx_gpio, pigpio.OUTPUT)
        self._pi.write(self.tx_gpio, 1)
        try:
            status = self._pi.bb_serial_read_open(self.rx_gpio, self.baud, 8)
        except Exception as exc:
            # With pigpio exceptions enabled, PI_GPIO_IN_USE is raised instead
            # of returned. Treat only that specific condition as recoverable.
            if "GPIO already in use" not in str(exc):
                raise TransportError(
                    f"cannot open GPIO{self.rx_gpio} for serial receive ({exc})"
                ) from exc
            status = getattr(pigpio, "PI_GPIO_IN_USE", -50)
        if status == getattr(pigpio, "PI_GPIO_IN_USE", -50):
            # A killed/restarted client can leave its bit-banged reader registered
            # in the long-running pigpiod daemon. This service exclusively owns
            # its configured RX GPIO, so release that stale registration once and
            # reopen it instead of leaving the MS58 settings channel unusable.
            try:
                self._pi.bb_serial_read_close(self.rx_gpio)
                status = self._pi.bb_serial_read_open(self.rx_gpio, self.baud, 8)
            except Exception as exc:
                raise TransportError(
                    f"cannot reclaim GPIO{self.rx_gpio} for serial receive ({exc})"
                ) from exc
        if status < 0:
            raise TransportError(f"cannot open GPIO{self.rx_gpio} for serial receive ({status})")

    def _drain(self):
        while True:
            count, _ = self._pi.bb_serial_read(self.rx_gpio)
            if count <= 0:
                return

    def exchange(self, command: bytes, expected: int, timeout_s=0.35) -> bytes:
        with self._wave_lock:
            self.open()
            self._drain()
            self._pi.wave_clear()
            if self._pi.wave_add_serial(self.tx_gpio, self.baud, command) < 0:
                raise TransportError("failed to construct software-UART transmit waveform")
            wave_id = self._pi.wave_create()
            if wave_id < 0:
                raise TransportError(f"failed to create software-UART waveform ({wave_id})")
            try:
                if self._pi.wave_send_once(wave_id) < 0:
                    raise TransportError("failed to transmit software-UART waveform")
                result = bytearray()
                deadline = time.monotonic() + timeout_s
                while len(result) < expected and time.monotonic() < deadline:
                    count, data = self._pi.bb_serial_read(self.rx_gpio)
                    if count > 0:
                        result.extend(data[:count])
                    else:
                        time.sleep(0.002)
                if len(result) != expected:
                    raise TransportError(
                        f"GPIO{self.rx_gpio}: expected {expected} bytes, received {len(result)} "
                        f"(Pi TX GPIO{self.tx_gpio}, Pi RX GPIO{self.rx_gpio}, {self.baud} 8N1, "
                        f"command {command.hex(' ')}, received {bytes(result).hex(' ') or '<none>'})"
                    )
                return bytes(result[:expected])
            finally:
                while self._pi.wave_tx_busy():
                    time.sleep(0.001)
                self._pi.wave_delete(wave_id)


class MockTransport:
    """In-memory radar used by automated tests and GUI commissioning."""

    def __init__(self, config=None):
        self.config = config or RadarConfig(0x00, 0x53, 100, 2000)
        self.saved = self.config

    def exchange(self, command: bytes, expected: int, timeout_s=0.35) -> bytes:
        del timeout_s
        if command == QUERY_FRAME:
            response = bytes((self.config.power_code, self.config.gain_code))
            response += self.config.threshold.to_bytes(2, "big")
            response += self.config.output_time_ms.to_bytes(4, "big")
        elif command == SAVE_FRAME:
            self.saved = self.config
            response = b"OK"
        elif command == RESET_FRAME:
            self.config = RadarConfig(0x00, 0x53, 100, 2000)
            response = b"OK"
        elif len(command) == 12 and command[:3] == bytes((0x55, 0x09, 0x11)):
            self.config = RadarConfig(
                command[3], command[4], int.from_bytes(command[5:7], "big"),
                int.from_bytes(command[7:11], "big"),
            )
            response = b"OK"
        else:
            raise TransportError(f"mock received unknown command {command.hex(' ')}")
        if len(response) != expected:
            raise TransportError("mock response length mismatch")
        return response


class MockLD021Transport:
    """Deterministic threshold-only sensor used by --mock commissioning runs."""

    def __init__(self, config=None):
        self.config = config or LD021Config(1, 512, 0xFF, 5, 1, 0)

    def exchange(self, command: bytes, expected: int, timeout_s=0.35) -> bytes:
        del timeout_s
        if command == LD021_QUERY_FRAME:
            response = bytes((0x3C, 0x3A, 0x19, 0xFA, 0x01, self.config.version))
            response += self.config.threshold.to_bytes(3, "big")
            response += bytes((self.config.light_threshold,))
            response += self.config.output_delay_units.to_bytes(2, "big")
            response += self.config.module_id.to_bytes(4, "big")
            response += bytes((self.config.output_mode, self.config.light_ad, self.config.intermediate_frequency))
            response += self.config.noise_value.to_bytes(2, "big") + self.config.signal_value.to_bytes(2, "big")
            response += bytes((0x3A, 0x3E))
        elif command == LD021_SET_MODE_FRAME:
            response = bytes((0x3C, 0x3A, 0x07, 0xFB, 0x01, 0x3A, 0x3E))
        elif len(command) == 19 and command[:5] == bytes((0x3C, 0x3A, 0x13, 0xFD, 0x01)):
            self.config = LD021Config(self.config.version, int.from_bytes(command[5:8], "big"),
                                      self.config.light_threshold, int.from_bytes(command[9:11], "big"),
                                      self.config.module_id, self.config.output_mode,
                                      self.config.light_ad, self.config.intermediate_frequency,
                                      self.config.noise_value, self.config.signal_value)
            response = bytes((0x3C, 0x3A, 0x07, 0xFD, 0x01, 0x3A, 0x3E))
        else:
            raise TransportError(f"mock LD021 received unknown command {command.hex(' ')}")
        if len(response) != expected:
            raise TransportError("mock LD021 response length mismatch")
        return response


class RadarDevice:
    """Typed command interface for one physical radar transport."""

    def __init__(self, name, transport, preamble_zeros=0):
        self.name = name
        self.transport = transport
        self.preamble_zeros = max(0, min(16, int(preamble_zeros)))
        self.protocol_profile = "moresense-hci-v2"
        self.persistent_on_apply = False

    def _exchange(self, command, expected):
        return self.transport.exchange((b"\x00" * self.preamble_zeros) + command, expected)

    def query(self):
        return parse_query_response(self._exchange(QUERY_FRAME, 8))

    def runtime_configuration(self):
        transport = self.transport.configuration() if hasattr(self.transport, "configuration") else {
            "interface": self.transport.__class__.__name__,
        }
        return {
            **transport,
            "protocolProfile": self.protocol_profile,
            "preambleZeros": self.preamble_zeros,
            "queryFrame": QUERY_FRAME.hex(" "),
            "expectedQueryBytes": 8,
        }

    def apply(self, current, gain_code, threshold, output_time_ms=None):
        del output_time_ms
        parse_ack(self._exchange(build_set_frame(current, gain_code, threshold), 2))

    def validate_settings(self, gain_code, threshold, output_time_ms=None):
        if output_time_ms is not None:
            raise ProtocolError("output time is configurable only for HLK-LD021 targets")
        validate_operator_settings(gain_code, threshold)

    def save(self):
        parse_ack(self._exchange(SAVE_FRAME, 2))

    def reset(self):
        parse_ack(self._exchange(RESET_FRAME, 2))


class LD021RadarDevice:
    """Typed threshold-only interface for an HLK-LD021 motion sensor."""

    def __init__(self, name, transport):
        self.name = name
        self.transport = transport
        self.protocol_profile = LD021_PROTOCOL_PROFILE
        # The LD021 configuration command updates its saved parameter block.
        self.persistent_on_apply = True

    def query(self):
        return parse_ld021_query_response(
            self.transport.exchange(LD021_QUERY_FRAME, LD021_QUERY_RESPONSE_LENGTH)
        )

    def validate_settings(self, gain_code, threshold, output_time_ms=None):
        del gain_code
        validate_ld021_threshold(threshold)
        if output_time_ms is not None:
            validate_ld021_output_time_ms(output_time_ms)

    def apply(self, current, gain_code, threshold, output_time_ms=None):
        del gain_code
        parse_ld021_ack(
            self.transport.exchange(LD021_SET_MODE_FRAME, LD021_ACK_LENGTH), 0xFB
        )
        parse_ld021_ack(
            self.transport.exchange(build_ld021_set_frame(current, threshold, output_time_ms), LD021_ACK_LENGTH),
            0xFD,
        )

    def save(self):
        # There is no separate save command in the documented LD021 protocol.
        return

    def reset(self):
        raise ProtocolError("LD021 factory reset is not documented; reset is disabled")


class LD021PowerController:
    """Optional, fail-safe GPIO load-switch control for the two LD021 modules."""

    def __init__(self, a_gpio=None, b_gpio=None, active_high=True):
        self.gpios = {"LD021_A": a_gpio, "LD021_B": b_gpio}
        self.active_high = bool(active_high)
        self._pi = None
        self._lock = threading.RLock()

    @property
    def configured(self):
        return any(gpio is not None for gpio in self.gpios.values())

    def _open(self):
        if self._pi is not None:
            return
        try:
            import pigpio
        except ImportError as exc:
            raise TransportError("python3-pigpio is not installed") from exc
        self._pigpio = pigpio
        self._pi = pigpio.pi()
        if not self._pi.connected:
            raise TransportError("pigpiod is not running")
        # Establish the inactive state before a channel can be energized.
        for gpio in self.gpios.values():
            if gpio is not None:
                self._pi.set_mode(gpio, pigpio.OUTPUT)
                self._pi.write(gpio, 0 if self.active_high else 1)

    def state(self):
        with self._lock:
            if not self.configured:
                return {"configured": False, "mode": "manual", "channels": {
                    name: {"configured": False, "enabled": None} for name in self.gpios
                }}
            self._open()
            return {"configured": True, "mode": "automated", "activeHigh": self.active_high,
                    "channels": {name: {"configured": gpio is not None,
                                          "enabled": None if gpio is None else bool(self._pi.read(gpio)) == self.active_high}
                                 for name, gpio in self.gpios.items()}}

    def set(self, channel, enabled):
        if channel not in self.gpios or self.gpios[channel] is None:
            raise TransportError(f"{channel} switched power is not configured; use the manual power workflow")
        with self._lock:
            self._open()
            self._pi.write(self.gpios[channel], int(bool(enabled) == self.active_high))
            return self.state()

    def set_both(self, enabled):
        for channel, gpio in self.gpios.items():
            if gpio is not None:
                self.set(channel, enabled)
        return self.state()


class RadarManager:
    """Serializes radar transactions and verifies the selected target by read-back."""

    TARGET_CHANNELS = {
        "dual": ("A", "B"), "single": ("SINGLE",), "ld021": ("LD021",),
        "ld021_a": ("LD021_A",), "ld021_b": ("LD021_B",),
        "ld021_pair": ("LD021_A", "LD021_B"),
    }

    def __init__(self, radar_a, radar_b, radar_single=None, radar_ld021=None,
                 radar_ld021_a=None, radar_ld021_b=None):
        self.radars = {"A": radar_a, "B": radar_b}
        if radar_single is not None:
            self.radars["SINGLE"] = radar_single
        if radar_ld021 is not None:
            self.radars["LD021"] = radar_ld021
        if radar_ld021_a is not None:
            self.radars["LD021_A"] = radar_ld021_a
        if radar_ld021_b is not None:
            self.radars["LD021_B"] = radar_ld021_b
        self.lock = threading.Lock()

    @staticmethod
    def _sensor_payload(config, verified=True):
        return {"online": True, "verified": verified, **config.as_dict()}

    def _channels_for_target(self, target):
        target = str(target or "dual").lower()
        channels = self.TARGET_CHANNELS.get(target)
        if not channels:
            raise ValueError("target must be dual, single, ld021, ld021_a, ld021_b, or ld021_pair")
        missing = [name for name in channels if name not in self.radars]
        if missing:
            raise TransportError(f"radar channel(s) not configured: {', '.join(missing)}")
        return target, channels

    def query_all(self, persistent=False, target="dual"):
        target, channels = self._channels_for_target(target)
        sensors = {}
        errors = []
        with self.lock:
            for name in self.radars:
                if name not in self.TARGET_CHANNELS[target]:
                    continue
                radar = self.radars[name]
                try:
                    sensors[name] = self._sensor_payload(radar.query())
                except Exception as exc:  # Device failures are returned per sensor.
                    sensors[name] = {"online": False, "verified": False, "error": str(exc)}
                    errors.append(f"Radar {name}: {exc}")
        matching = not errors and all(
            sensors[name].get("gainCode") == sensors[channels[0]].get("gainCode")
            and sensors[name].get("threshold") == sensors[channels[0]].get("threshold")
            and (self.radars[name].protocol_profile != LD021_PROTOCOL_PROFILE
                 or sensors[name].get("outputTimeMs") == sensors[channels[0]].get("outputTimeMs"))
            for name in channels
        )
        profiles = {self.radars[name].protocol_profile for name in channels}
        protocol_profile = profiles.pop() if len(profiles) == 1 else "mixed"
        return {
            "success": not errors and matching,
            "protocolProfile": protocol_profile,
            "activeTarget": target,
            "activeChannels": list(channels),
            "persistent": persistent,
            "capturedAt": _utc_now(),
            "sensors": sensors,
            "error": "; ".join(errors) if errors else (f"{target} radar settings do not match" if not matching else ""),
        }

    def apply_all(self, gain_code, threshold, target="dual", output_time_ms=None):
        target, channels = self._channels_for_target(target)
        for name in channels:
            self.radars[name].validate_settings(gain_code, threshold, output_time_ms)
        with self.lock:
            previous = {name: self.radars[name].query() for name in channels}
            applied = []
            try:
                for name in channels:
                    radar = self.radars[name]
                    radar.apply(previous[name], gain_code, threshold, output_time_ms)
                    # The LD021 persists its parameter block before it resumes
                    # answering queries.  Treat the channel as changed as soon
                    # as both write acknowledgements succeed, then allow several
                    # quiet-period readbacks before failing the pair operation.
                    applied.append(name)
                    readback = None
                    readback_error = None
                    for delay_s in (0, 0.25, 0.5, 0.75):
                        if delay_s:
                            time.sleep(delay_s)
                        try:
                            candidate = radar.query()
                            candidate_gain = getattr(candidate, "gain_code", None)
                            candidate_output_time_ms = getattr(candidate, "output_time_ms", None)
                            if ((candidate_gain is None or candidate_gain == gain_code)
                                    and candidate.threshold == threshold
                                    and (output_time_ms is None or candidate_output_time_ms == output_time_ms)):
                                readback = candidate
                                break
                            readback_error = TransportError(
                                f"Radar {name} read-back did not match requested settings"
                            )
                        except Exception as exc:
                            readback_error = exc
                    if readback is None:
                        raise TransportError(f"Radar {name} read-back failed: {readback_error}")
            except Exception:
                for name in reversed(applied):
                    try:
                        old = previous[name]
                        self.radars[name].apply(old, getattr(old, "gain_code", None), old.threshold,
                                                getattr(old, "output_time_ms", None))
                        time.sleep(0.25)
                    except Exception:
                        pass
                raise
        persistent = all(self.radars[name].persistent_on_apply for name in channels)
        return self.query_all(persistent=persistent, target=target)

    def save_all(self, target="dual"):
        target, channels = self._channels_for_target(target)
        state = self.query_all(persistent=False, target=target)
        if not state["success"]:
            raise TransportError(state["error"] or "active radar settings must match before saving")
        with self.lock:
            for name in channels:
                self.radars[name].save()
        result = self.query_all(persistent=True, target=target)
        result["persistent"] = True
        return result

    def reset_all(self, target="dual"):
        target, channels = self._channels_for_target(target)
        with self.lock:
            for name in channels:
                self.radars[name].reset()
        return self.query_all(persistent=True, target=target)


def _utc_now():
    """Returns an ISO-8601 UTC timestamp without third-party dependencies."""
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


class RadarRequestHandler(BaseHTTPRequestHandler):
    """Small authenticated JSON API; arbitrary serial writes are never exposed."""

    manager = None
    power = None
    api_token = ""

    def _authorized(self):
        return not self.api_token or self.headers.get("Authorization") == f"Bearer {self.api_token}"

    def _body(self):
        length = int(self.headers.get("Content-Length", "0"))
        return json.loads(self.rfile.read(length) or b"{}")

    def _send(self, status, payload):
        encoded = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(encoded)

    def _run(self, action):
        if not self._authorized():
            self._send(401, {"success": False, "error": "unauthorized"})
            return
        try:
            self._send(200, action())
        except (ProtocolError, TransportError, OSError, ValueError) as exc:
            self._send(409, {"success": False, "error": str(exc)})
        except Exception as exc:
            self._send(500, {"success": False, "error": f"radar service failure: {exc}"})

    def do_GET(self):
        if self.path == "/v1/health":
            self._run(lambda: {
                "success": True,
                "service": "radar-settings",
                "singleProtocolProfile": getattr(self.manager.radars.get("SINGLE"), "protocol_profile", None),
                "singleUart": self.manager.radars["SINGLE"].runtime_configuration()
                    if "SINGLE" in self.manager.radars else None,
                "singleOut": {
                    "interface": "klipper-gcode-button",
                    "bcmGpio": int(os.getenv("RADAR_SINGLE_OUT_GPIO", "26")),
                    "physicalPin": 37,
                },
                "ld021ProtocolProfile": getattr(self.manager.radars.get("LD021"), "protocol_profile", None),
                "ld021PairProtocolProfile": getattr(self.manager.radars.get("LD021_A"), "protocol_profile", None),
                "power": self.power.state() if self.power else {"configured": False, "mode": "manual"},
            })
        elif urlsplit(self.path).path == "/v1/radars":
            query = parse_qs(urlsplit(self.path).query)
            self._run(lambda: self.manager.query_all(target=query.get("target", ["dual"])[0]))
        elif self.path == "/v1/ld021-power":
            self._run(lambda: self.power.state())
        else:
            self._send(404, {"success": False, "error": "not found"})

    def do_POST(self):
        if self.path == "/v1/radars/apply":
            def apply():
                body = self._body()
                gain_code = body.get("gainCode")
                return self.manager.apply_all(
                    None if gain_code is None else int(gain_code),
                    int(body["threshold"]),
                    body.get("target", "dual"),
                    None if body.get("outputTimeMs") is None else int(body["outputTimeMs"]),
                )
            self._run(apply)
        elif self.path == "/v1/radars/save":
            self._run(lambda: self.manager.save_all(self._body().get("target", "dual")))
        elif self.path == "/v1/radars/reset":
            def reset():
                body = self._body()
                if body.get("confirm") != "FACTORY RESET":
                    raise ValueError("factory reset confirmation is required")
                return self.manager.reset_all(body.get("target", "dual"))
            self._run(reset)
        elif self.path == "/v1/ld021-power":
            def power():
                body = self._body()
                channel = str(body.get("channel", "")).upper()
                enabled = body.get("enabled") is True
                if channel == "BOTH":
                    return self.power.set_both(enabled)
                return self.power.set(channel, enabled)
            self._run(power)
        elif self.path == "/v1/ld021-power/emergency-off":
            self._run(lambda: self.power.set_both(False))
        else:
            self._send(404, {"success": False, "error": "not found"})

    def log_message(self, fmt, *args):
        print(f"{self.address_string()} - {fmt % args}")


def create_manager(mock=False):
    """Creates either real transports or deterministic commissioning mocks."""
    if mock:
        ld021_a = LD021RadarDevice("LD021_A", MockLD021Transport())
        return RadarManager(RadarDevice("A", MockTransport()), RadarDevice("B", MockTransport()), RadarDevice("SINGLE", MockTransport()),
                            radar_ld021=ld021_a, radar_ld021_a=ld021_a,
                            radar_ld021_b=LD021RadarDevice("LD021_B", MockLD021Transport()))
    preamble = int(os.getenv("RADAR_PREAMBLE_ZEROS", "0"))
    legacy_tx = int(os.getenv("RADAR_LD021_TX_GPIO", "5"))
    legacy_rx = int(os.getenv("RADAR_LD021_RX_GPIO", "6"))
    legacy_ld021 = LD021RadarDevice(
        "LD021", PigpioSerialTransport(legacy_tx, legacy_rx)
    )
    manager = RadarManager(
        RadarDevice("A", PosixSerialTransport(os.getenv("RADAR_A_DEVICE", "/dev/serial0")), preamble),
        RadarDevice("B", PigpioSerialTransport(
            int(os.getenv("RADAR_B_TX_GPIO", "24")),
            int(os.getenv("RADAR_B_RX_GPIO", "25")),
        ), preamble),
        RadarDevice("SINGLE", PigpioSerialTransport(
            int(os.getenv("RADAR_SINGLE_TX_GPIO", "22")),
            int(os.getenv("RADAR_SINGLE_RX_GPIO", "27")),
        ), preamble),
        legacy_ld021,
        radar_ld021_a=legacy_ld021,
    )
    a_tx, a_rx = int(os.getenv("RADAR_LD021_A_TX_GPIO", os.getenv("RADAR_LD021_TX_GPIO", "5"))), int(os.getenv("RADAR_LD021_A_RX_GPIO", os.getenv("RADAR_LD021_RX_GPIO", "6")))
    manager.radars["LD021_A"] = legacy_ld021 if (a_tx, a_rx) == (legacy_tx, legacy_rx) else LD021RadarDevice("LD021_A", PigpioSerialTransport(a_tx, a_rx))
    b_tx_text, b_rx_text = os.getenv("RADAR_LD021_B_TX_GPIO", "").strip(), os.getenv("RADAR_LD021_B_RX_GPIO", "").strip()
    if bool(b_tx_text) != bool(b_rx_text):
        raise TransportError("configure both RADAR_LD021_B_TX_GPIO and RADAR_LD021_B_RX_GPIO, or neither for manual commissioning")
    if b_tx_text:
        b_tx, b_rx = int(b_tx_text), int(b_rx_text)
        assigned = {
            "MoreSense B TX": int(os.getenv("RADAR_B_TX_GPIO", "24")), "MoreSense B RX": int(os.getenv("RADAR_B_RX_GPIO", "25")),
            "MS58 TX": int(os.getenv("RADAR_SINGLE_TX_GPIO", "22")), "MS58 RX": int(os.getenv("RADAR_SINGLE_RX_GPIO", "27")),
            "LD021_A TX": a_tx, "LD021_A RX": a_rx, "LD021_B TX": b_tx, "LD021_B RX": b_rx,
        }
        duplicate = next((gpio for gpio in assigned.values() if list(assigned.values()).count(gpio) > 1), None)
        if duplicate is not None:
            names = ", ".join(name for name, gpio in assigned.items() if gpio == duplicate)
            raise TransportError(f"duplicate software-UART GPIO{duplicate}: {names}")
        # The legacy single-LD021 target and paired Sensor A normally identify
        # the same physical module. Reuse its transport when their pins match;
        # opening a second pigpio bit-banged receiver on the same RX GPIO fails
        # with "GPIO already in use" after either target has been queried.
        manager.radars["LD021_B"] = LD021RadarDevice("LD021_B", PigpioSerialTransport(b_tx, b_rx))
    return manager


def _optional_gpio(name):
    value = os.getenv(name, "").strip()
    return None if not value else int(value)


def create_power_controller(mock=False):
    if mock:
        return LD021PowerController()
    a_gpio, b_gpio = _optional_gpio("RADAR_LD021_A_POWER_GPIO"), _optional_gpio("RADAR_LD021_B_POWER_GPIO")
    if a_gpio is not None and a_gpio == b_gpio:
        raise TransportError("LD021 power enable GPIOs must be different")
    active_high = os.getenv("RADAR_LD021_POWER_ACTIVE_HIGH", "1").strip().lower() not in ("0", "false", "no")
    return LD021PowerController(a_gpio, b_gpio, active_high)


def main():
    parser = argparse.ArgumentParser(description="MoreSense radar settings service")
    parser.add_argument("--host", default=os.getenv("RADAR_SERVICE_HOST", "0.0.0.0"))
    parser.add_argument("--port", type=int, default=int(os.getenv("RADAR_SERVICE_PORT", "7130")))
    parser.add_argument("--mock", action="store_true", default=os.getenv("RADAR_SERVICE_MOCK") == "1")
    args = parser.parse_args()
    RadarRequestHandler.manager = create_manager(args.mock)
    RadarRequestHandler.power = create_power_controller(args.mock)
    RadarRequestHandler.api_token = os.getenv("RADAR_SERVICE_TOKEN", "")
    server = ThreadingHTTPServer((args.host, args.port), RadarRequestHandler)
    print(f"Radar settings service listening on {args.host}:{args.port} ({'mock' if args.mock else 'hardware'})")
    server.serve_forever()


if __name__ == "__main__":
    main()
