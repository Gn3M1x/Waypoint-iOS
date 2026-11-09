import asyncio
import math
import unittest

from engine import Engine
from route import Route, destination, distance, point


class FakeDevice:
    def __init__(self):
        self.sent = []
        self.clears = 0
        self.fail_set = False
        self.fail_clear = False
        self.opened = False

    async def devices(self):
        return [{"id": "test-phone", "name": "Test", "ios": "fake", "paired": True},
                {"id": "other-phone", "name": "Other", "ios": "fake", "paired": True}]

    async def prepare(self, serial):
        pass

    async def connect(self, serial, native=False):
        self.opened = True

    async def set(self, p):
        if self.fail_set:
            raise ConnectionError("device disconnected")
        self.sent.append(p)

    async def clear(self):
        if self.fail_clear:
            raise ConnectionError("cannot recover")
        self.clears += 1

    async def close(self):
        self.opened = False


class GeometryTests(unittest.TestCase):
    def test_invalid_points(self):
        for value in ([math.nan, 0], [0, math.inf], [91, 0], [0, -181], [True, 2], [0], None):
            with self.subTest(value=value), self.assertRaises(ValueError):
                point(value)

    def test_ten_meter_nudge(self):
        for origin in ((38, 114.52), (0, 179.99999), (-80, -70)):
            for bearing in (0, 90, 180, 270):
                self.assertAlmostEqual(distance(origin, destination(origin, bearing, 10)), 10, places=6)

    def test_date_line_short_path(self):
        route = Route.build([[0, 179.999], [0, -179.999]])
        self.assertLess(route.length, 223)
        self.assertGreater(abs(route.at(route.length / 2)[1]), 179.99)

    def test_duplicate_points_and_completion(self):
        route = Route.build([[0, 0], [0, 0], [0, 0.001]], closed=True, laps=2)
        self.assertEqual(len(route.points), 3)
        self.assertEqual(route.at(route.length), (0.0, 0.0))
        self.assertAlmostEqual(distance(route.at(route.length/2), (0, 0)), 0, places=5)

    def test_open_route_cannot_repeat_with_a_jump(self):
        with self.assertRaises(ValueError):
            Route.build([[0, 0], [0, 1]], laps=2)


class EngineTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.time = 0.0
        self.device = FakeDevice()
        self.engine = Engine(adapter=self.device, clock=lambda: self.time)
        await self.engine.dispatch("connect", {"device": "test-phone"})

    async def test_connect_does_not_move_phone(self):
        self.assertEqual(self.device.sent, [])
        self.assertFalse(self.engine.dirty)
        self.assertEqual(self.engine.state, "ready")

    async def test_pause_resume_does_not_advance_during_pause(self):
        await self.engine.dispatch("route", {"points": [[0, 0], [0, 0.01]], "speed": 3.6})
        self.time = 10
        await self.engine._tick()
        self.assertAlmostEqual(self.engine.traveled, 10)
        await self.engine.dispatch("pause", {})
        last = self.engine.position
        self.time = 100
        await self.engine._tick()
        self.assertEqual(self.engine.position, last)
        await self.engine.dispatch("resume", {})
        self.time = 105
        await self.engine._tick()
        self.assertAlmostEqual(self.engine.traveled, 15)

    async def test_speed_change_uses_old_speed_for_elapsed_time(self):
        await self.engine.dispatch("route", {"points": [[0, 0], [0, 0.01]], "speed": 3.6})
        self.time = 10
        await self.engine.dispatch("speed", {"speed": 7.2})
        self.time = 15
        await self.engine._tick()
        self.assertAlmostEqual(self.engine.traveled, 20)

    async def test_route_completes_and_holds_endpoint(self):
        await self.engine.dispatch("route", {"points": [[0, 0], [0, 0.001]], "speed": 3.6})
        self.time = 1000
        await self.engine._tick()
        self.assertEqual(self.engine.state, "holding")
        self.assertEqual(self.engine.position, (0.0, 0.001))
        self.assertEqual(self.engine.traveled, self.engine.route.length)

    async def test_set_failure_does_not_claim_position_changed(self):
        self.device.fail_set = True
        with self.assertRaises(RuntimeError):
            await self.engine.dispatch("set", {"point": [38, 114]})
        self.assertIsNone(self.engine.position)
        self.assertTrue(self.engine.dirty)
        self.assertEqual(self.engine.state, "error")

    async def test_recovery_failure_retains_dirty_state_and_blocks_other_device(self):
        await self.engine.dispatch("set", {"point": [38, 114]})
        self.device.fail_clear = True
        with self.assertRaises(RuntimeError):
            await self.engine.dispatch("disconnect", {})
        self.assertTrue(self.engine.dirty)
        self.assertTrue(self.engine.connected)
        with self.assertRaises(ValueError):
            await self.engine.dispatch("connect", {"device": "other-phone"})
        self.device.fail_clear = False
        await self.engine.dispatch("connect", {"device": "test-phone"})
        self.assertFalse(self.engine.dirty)
        self.assertEqual(self.engine.state, "ready")
        self.assertIsNone(self.engine.position)

    async def test_invalid_route_does_not_cancel_active_location(self):
        await self.engine.dispatch("set", {"point": [38, 114]})
        with self.assertRaises(ValueError):
            await self.engine.dispatch("route", {"points": [[0, 0]], "speed": 6})
        self.assertEqual(self.engine.position, (38.0, 114.0))
        self.assertEqual(self.engine.state, "holding")

    async def test_shutdown_recovers_before_closing(self):
        await self.engine.dispatch("set", {"point": [38, 114]})
        await self.engine.shutdown()
        self.assertEqual(self.device.clears, 1)
        self.assertFalse(self.device.opened)
        self.assertFalse(self.engine.dirty)

    async def test_explicit_recovery_can_clear_simulation_from_previous_session(self):
        self.assertFalse(self.engine.dirty)
        await self.engine.dispatch("clear", {})
        self.assertEqual(self.device.clears, 1)
        self.assertEqual(self.engine.state, "ready")

    async def test_bad_action_and_unconnected_set(self):
        await self.engine.dispatch("disconnect", {})
        with self.assertRaises(ValueError):
            await self.engine.dispatch("set", {"point": [38, 114]})
        with self.assertRaises(ValueError):
            await self.engine.dispatch("anything", {})

    async def test_random_pace_phase_freezes_while_paused(self):
        await self.engine.dispatch("route", {"points": [[0, 0], [0, 0.1]], "motion": {"mode": "pace", "pace_seconds": 360}})
        self.time = 10
        await self.engine.dispatch("pause", {})
        self.assertAlmostEqual(self.engine.profile_time, 10)
        position = self.engine.position
        self.time = 100
        await self.engine._tick()
        self.assertEqual(self.engine.position, position)
        self.assertEqual(self.engine.profile_time, 10)
        await self.engine.dispatch("resume", {})
        self.time = 105
        await self.engine._tick()
        self.assertAlmostEqual(self.engine.profile_time, 15)
        self.assertAlmostEqual(self.engine.elapsed_moving, 15)

    async def test_invalid_pace_does_not_send_or_replace_route(self):
        await self.engine.dispatch("set", {"point": [38, 114]})
        sends = len(self.device.sent)
        with self.assertRaises(ValueError):
            await self.engine.dispatch("route", {"points": [[0, 0], [0, 0.1]], "motion": {"mode": "pace", "pace_seconds": 0}})
        self.assertEqual(len(self.device.sent), sends)
        self.assertEqual(self.engine.position, (38, 114))

    async def test_completion_average_uses_only_time_needed_to_finish(self):
        await self.engine.dispatch("route", {"points": [[0, 0], [0, 0.001]], "motion": {"mode": "pace", "pace_seconds": 360, "randomize": False}})
        self.time = 1000
        await self.engine._tick()
        self.assertEqual(self.engine.state, "holding")
        self.assertAlmostEqual(self.engine.snapshot()["average_pace_seconds"], 360)
        self.assertEqual(self.engine.snapshot()["current_speed"], 0)


if __name__ == "__main__":
    unittest.main()
