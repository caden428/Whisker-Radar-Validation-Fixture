"""Protocol and two-device transaction tests; no Raspberry Pi is required."""

import sys
import unittest
from unittest.mock import patch

from radar_protocol import (
    QUERY_FRAME, RadarConfig, ProtocolError, build_set_frame,
    parse_ack, parse_query_response,
)
from radar_service import LD021RadarDevice, MockTransport, PigpioSerialTransport, RadarDevice, RadarManager, create_manager
from ld021_protocol import (
    LD021Config, QUERY_FRAME as LD021_QUERY_FRAME, SET_MODE_FRAME,
    build_set_frame as build_ld021_set_frame,
    parse_query_response as parse_ld021_query_response,
)


class ProtocolTests(unittest.TestCase):
    def test_query_frame_and_response(self):
        self.assertEqual(QUERY_FRAME.hex(), "5502120069")
        parsed = parse_query_response(bytes.fromhex("00 33 00 64 00 00 01 FF"))
        self.assertEqual(parsed, RadarConfig(0, 0x33, 100, 511))

    def test_documented_set_frame(self):
        frame = build_set_frame(RadarConfig(0, 0x53, 100, 511), 0x33, 100)
        self.assertEqual(frame.hex(), "55091100330064000001ff06")

    def test_safe_threshold_validation(self):
        frame = build_set_frame(RadarConfig(0, 0x53, 100, 511), 0x33, 16)
        self.assertEqual(frame[5:7], bytes((0x00, 0x10)))
        with self.assertRaises(ProtocolError):
            build_set_frame(RadarConfig(0, 0x53, 100, 2000), 0x33, 15)
        with self.assertRaises(ProtocolError):
            parse_ack(b"ER")

    def test_software_uart_reclaims_stale_rx_registration(self):
        class FakePi:
            connected = True

            def __init__(self):
                self.opens = 0
                self.closed = []

            def set_mode(self, gpio, mode):
                del gpio, mode

            def write(self, gpio, value):
                del gpio, value

            def bb_serial_read_open(self, gpio, baud, bits):
                del gpio, baud, bits
                self.opens += 1
                return -50 if self.opens == 1 else 0

            def bb_serial_read_close(self, gpio):
                self.closed.append(gpio)

        fake_pi = FakePi()

        class FakePigpio:
            OUTPUT = 1
            PI_GPIO_IN_USE = -50

            @staticmethod
            def pi():
                return fake_pi

        with patch.dict(sys.modules, {"pigpio": FakePigpio}):
            transport = PigpioSerialTransport(20, 21)
            transport.open()
        self.assertEqual(fake_pi.closed, [21])
        self.assertEqual(fake_pi.opens, 2)

    def test_software_uart_reclaims_exception_form_of_gpio_in_use(self):
        class FakePi:
            connected = True

            def __init__(self):
                self.opens = 0
                self.closed = []

            def set_mode(self, gpio, mode):
                del gpio, mode

            def write(self, gpio, value):
                del gpio, value

            def bb_serial_read_open(self, gpio, baud, bits):
                del gpio, baud, bits
                self.opens += 1
                if self.opens == 1:
                    raise RuntimeError("'GPIO already in use'")
                return 0

            def bb_serial_read_close(self, gpio):
                self.closed.append(gpio)

        fake_pi = FakePi()

        class FakePigpio:
            OUTPUT = 1
            PI_GPIO_IN_USE = -50

            @staticmethod
            def pi():
                return fake_pi

        with patch.dict(sys.modules, {"pigpio": FakePigpio}):
            PigpioSerialTransport(20, 21).open()
        self.assertEqual(fake_pi.closed, [21])
        self.assertEqual(fake_pi.opens, 2)

    def test_ld021_observed_query_response(self):
        raw = bytes.fromhex(
            "3c 3a 19 fa 01 10 00 02 00 ff 00 32 00 00 00 00 "
            "00 00 00 00 00 00 00 3a 3e"
        )
        parsed = parse_ld021_query_response(raw)
        self.assertEqual(parsed.threshold, 512)
        self.assertEqual(parsed.output_time_ms, 5000)
        self.assertEqual(parsed.light_threshold, 0xFF)

    def test_ld021_set_preserves_unrelated_fields(self):
        current = LD021Config(0x10, 512, 0xFF, 50, 0, 0)
        frame = build_ld021_set_frame(current, 600)
        self.assertEqual(frame.hex(), "3c3a13fd01000258ff00320000000000003a3e")
        self.assertEqual(SET_MODE_FRAME.hex(), "3c3a07fb013a3e")
        self.assertEqual(LD021_QUERY_FRAME.hex(), "3c3a07fa013a3e")

    def test_ld021_set_changes_high_time_in_100_ms_steps(self):
        current = LD021Config(0x10, 512, 0xFF, 50, 7, 0)
        frame = build_ld021_set_frame(current, 600, 2500)
        self.assertEqual(frame[9:11], bytes.fromhex("00 19"))
        self.assertEqual(frame[11:15], bytes.fromhex("00 00 00 07"))
        with self.assertRaisesRegex(ProtocolError, "100 ms steps"):
            build_ld021_set_frame(current, 600, 2550)


class MockLD021Transport:
    def __init__(self):
        self.raw = bytes.fromhex(
            "3c 3a 19 fa 01 10 00 02 00 ff 00 32 00 00 00 00 "
            "00 00 00 00 00 00 00 3a 3e"
        )

    def exchange(self, command, expected, timeout_s=0.35):
        del timeout_s
        if command == LD021_QUERY_FRAME:
            response = self.raw
        elif command == SET_MODE_FRAME:
            response = command
        elif len(command) == 19 and command[:5] == bytes.fromhex("3c 3a 13 fd 01"):
            threshold = command[5:8]
            self.raw = self.raw[:6] + threshold + self.raw[9:10] + command[9:11] + self.raw[12:]
            response = bytes.fromhex("3c 3a 07 fd 01 3a 3e")
        else:
            raise AssertionError(f"unexpected LD021 command {command.hex(' ')}")
        self.assert_length(response, expected)
        return response

    @staticmethod
    def assert_length(response, expected):
        if len(response) != expected:
            raise AssertionError(f"expected {expected} response bytes, got {len(response)}")


class ManagerTests(unittest.TestCase):
    def setUp(self):
        self.a = MockTransport()
        self.b = MockTransport()
        self.single = MockTransport()
        self.manager = RadarManager(RadarDevice("A", self.a), RadarDevice("B", self.b), RadarDevice("SINGLE", self.single))

    def test_query_apply_and_save_both(self):
        self.assertTrue(self.manager.query_all()["success"])
        applied = self.manager.apply_all(0x43, 125)
        self.assertTrue(applied["success"])
        self.assertEqual(applied["sensors"]["A"]["threshold"], 125)
        self.assertEqual(applied["sensors"]["B"]["gainCode"], 0x43)
        saved = self.manager.save_all()
        self.assertTrue(saved["persistent"])
        self.assertEqual(self.a.saved.threshold, 125)
        self.assertEqual(self.b.saved.threshold, 125)

    def test_legacy_ld021_and_pair_a_share_one_transport(self):
        manager = create_manager(mock=True)
        self.assertIs(manager.radars["LD021"], manager.radars["LD021_A"])

    def test_mismatch_is_not_verified(self):
        self.b.config = RadarConfig(0, 0x63, 100, 2000)
        state = self.manager.query_all()
        self.assertFalse(state["success"])
        self.assertIn("do not match", state["error"])

    def test_single_target_is_independent(self):
        applied = self.manager.apply_all(0x63, 150, target="single")
        self.assertTrue(applied["success"])
        self.assertEqual(applied["activeTarget"], "single")
        self.assertEqual(applied["activeChannels"], ["SINGLE"])
        self.assertEqual(applied["sensors"]["SINGLE"]["threshold"], 150)
        self.assertEqual(self.a.config.threshold, 100)
        self.assertEqual(self.b.config.threshold, 100)
        saved = self.manager.save_all(target="single")
        self.assertTrue(saved["persistent"])
        self.assertEqual(self.single.saved.threshold, 150)

    def test_separate_ld021_threshold_is_read_back_and_persistent(self):
        transport = MockLD021Transport()
        manager = RadarManager(self.manager.radars["A"], self.manager.radars["B"], self.manager.radars["SINGLE"], LD021RadarDevice("LD021", transport))
        initial = manager.query_all(target="ld021")
        self.assertEqual(initial["protocolProfile"], "hilink-ld021-motion-v1")
        self.assertEqual(initial["sensors"]["LD021"]["threshold"], 512)
        applied = manager.apply_all(None, 600, target="ld021")
        self.assertTrue(applied["success"])
        self.assertTrue(applied["persistent"])
        self.assertEqual(applied["sensors"]["LD021"]["threshold"], 600)

    def test_ld021_high_time_is_saved_and_read_back(self):
        transport = MockLD021Transport()
        manager = RadarManager(self.manager.radars["A"], self.manager.radars["B"], self.manager.radars["SINGLE"],
                               LD021RadarDevice("LD021", transport))
        applied = manager.apply_all(None, 600, target="ld021", output_time_ms=2500)
        self.assertTrue(applied["success"])
        self.assertTrue(applied["persistent"])
        self.assertEqual(applied["sensors"]["LD021"]["outputTimeMs"], 2500)
        self.assertEqual(manager.query_all(target="ld021")["sensors"]["LD021"]["outputTimeMs"], 2500)

    def test_non_ld021_target_rejects_high_time(self):
        with self.assertRaisesRegex(ProtocolError, "only for HLK-LD021"):
            self.manager.apply_all(0x43, 125, target="dual", output_time_ms=2500)

    def test_single_ld021_a_and_b_targets_are_independent(self):
        a, b = MockLD021Transport(), MockLD021Transport()
        manager = RadarManager(self.manager.radars["A"], self.manager.radars["B"], self.manager.radars["SINGLE"],
                               radar_ld021_a=LD021RadarDevice("LD021_A", a),
                               radar_ld021_b=LD021RadarDevice("LD021_B", b))
        applied_b = manager.apply_all(None, 700, target="ld021_b")
        self.assertTrue(applied_b["success"])
        self.assertEqual(applied_b["activeChannels"], ["LD021_B"])
        self.assertEqual(applied_b["sensors"]["LD021_B"]["threshold"], 700)
        self.assertEqual(manager.query_all(target="ld021_a")["sensors"]["LD021_A"]["threshold"], 512)

    def test_single_ld021_b_requires_sensor_b_configuration(self):
        manager = RadarManager(self.manager.radars["A"], self.manager.radars["B"], self.manager.radars["SINGLE"],
                               radar_ld021_a=LD021RadarDevice("LD021_A", MockLD021Transport()))
        with self.assertRaisesRegex(Exception, "LD021_B"):
            manager.query_all(target="ld021_b")

    def test_ld021_pair_applies_shared_threshold_and_reads_both_back(self):
        a, b = MockLD021Transport(), MockLD021Transport()
        manager = RadarManager(self.manager.radars["A"], self.manager.radars["B"], self.manager.radars["SINGLE"],
                               radar_ld021_a=LD021RadarDevice("LD021_A", a),
                               radar_ld021_b=LD021RadarDevice("LD021_B", b))
        applied = manager.apply_all(None, 600, target="ld021_pair", output_time_ms=2500)
        self.assertTrue(applied["success"])
        self.assertTrue(applied["persistent"])
        self.assertEqual(applied["activeChannels"], ["LD021_A", "LD021_B"])
        self.assertEqual(applied["sensors"]["LD021_A"]["threshold"], 600)
        self.assertEqual(applied["sensors"]["LD021_B"]["threshold"], 600)
        self.assertEqual(applied["sensors"]["LD021_A"]["outputTimeMs"], 2500)
        self.assertEqual(applied["sensors"]["LD021_B"]["outputTimeMs"], 2500)

    def test_ld021_pair_retries_delayed_persistent_readback(self):
        class DelayedReadbackTransport(MockLD021Transport):
            def __init__(self):
                super().__init__()
                self.fail_next_query = False

            def exchange(self, command, expected, timeout_s=0.35):
                if command == LD021_QUERY_FRAME and self.fail_next_query:
                    self.fail_next_query = False
                    raise OSError("sensor is committing its persistent setting")
                response = super().exchange(command, expected, timeout_s)
                if len(command) == 19 and command[:5] == bytes.fromhex("3c 3a 13 fd 01"):
                    self.fail_next_query = True
                return response

        a, b = DelayedReadbackTransport(), DelayedReadbackTransport()
        manager = RadarManager(self.manager.radars["A"], self.manager.radars["B"],
                               radar_ld021_a=LD021RadarDevice("LD021_A", a),
                               radar_ld021_b=LD021RadarDevice("LD021_B", b))
        applied = manager.apply_all(None, 4750, target="ld021_pair")
        self.assertTrue(applied["success"])
        self.assertEqual(applied["sensors"]["LD021_A"]["threshold"], 4750)
        self.assertEqual(applied["sensors"]["LD021_B"]["threshold"], 4750)

    def test_ld021_pair_requires_both_sensors_online(self):
        class OfflineTransport(MockLD021Transport):
            def exchange(self, command, expected, timeout_s=0.35):
                raise OSError("sensor offline")
        manager = RadarManager(self.manager.radars["A"], self.manager.radars["B"], self.manager.radars["SINGLE"],
                               radar_ld021_a=LD021RadarDevice("LD021_A", MockLD021Transport()),
                               radar_ld021_b=LD021RadarDevice("LD021_B", OfflineTransport()))
        state = manager.query_all(target="ld021_pair")
        self.assertFalse(state["success"])
        self.assertFalse(state["sensors"]["LD021_B"]["online"])


if __name__ == "__main__":
    unittest.main()
