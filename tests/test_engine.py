import asyncio
import math
import random
import unittest

from engine import Engine
from motion import DriftProfile
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

    async def test_active_route_snapshot_preserves_editor_geometry_and_is_isolated(self):
        data={"points": [[38,114.5], [38,114.5], [38.001,114.5]], "closed": True, "laps": 2}
        await self.engine.dispatch("route", data)
        first=self.engine.route_snapshot()["route"]
        self.assertEqual(first["points"], data["points"])
        self.assertEqual(first["laps"], 2)
        self.assertTrue(first["closed"])
        self.assertEqual(self.engine.snapshot()["route_id"], first["id"])
        self.assertNotIn("points", self.engine.snapshot())
        data["points"][0][0]=0
        first["points"][1][0]=0
        self.assertEqual(self.engine.route_snapshot()["route"]["points"][0][0],38)
        self.assertEqual(self.engine.route_snapshot()["route"]["points"][1][0],38)
        await self.engine.dispatch("pause", {})
        self.assertEqual(self.engine.route_snapshot()["route"]["id"],first["id"])
        await self.engine.dispatch("route", {"points":[[0,0],[0,0.001]]})
        self.assertGreater(self.engine.snapshot()["route_id"],first["id"])
        await self.engine.dispatch("clear", {})
        self.assertIsNone(self.engine.snapshot()["route_id"])
        self.assertIsNone(self.engine.route_snapshot()["route"])

    async def test_reported_drift_transition_freezes_during_pause(self):
        await self.start_drifting()
        self.time=2
        await self.engine.dispatch("pause", {})
        self.assertEqual(self.engine.snapshot()["drift_transition_remaining"],3)
        self.time=100
        await self.engine._tick()
        self.assertEqual(self.engine.snapshot()["drift_transition_remaining"],3)
        await self.engine.dispatch("resume", {})
        self.time=104
        await self.engine._tick()
        self.assertEqual(self.engine.snapshot()["drift_transition_remaining"],0)

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

    async def start_drifting(self, **extra):
        settings = {"mode": "speed", "speed": 3.6, "drift_enabled": True, "drift_radius_meters": 2}
        await self.engine.dispatch("route", {"points": [[38, 114.52], [38.01, 114.52]], "motion": settings, **extra})
        self.engine.drift = DriftProfile(self.engine.motion, random.Random(8))

    async def test_actual_device_coordinates_drift_but_route_progress_does_not(self):
        await self.start_drifting()
        self.assertEqual(self.device.sent[-1], (38, 114.52))
        self.time = 20
        await self.engine._tick()
        snapshot = self.engine.snapshot()
        offset = distance(self.engine.route.at(20), self.device.sent[-1])
        self.assertGreater(offset, 0.1)
        self.assertLessEqual(offset, 2)
        self.assertEqual(snapshot["distance"], 20)
        self.assertEqual(snapshot["average_pace_seconds"], 1000)
        self.assertAlmostEqual(snapshot["drift_distance"], offset, places=3)
        self.assertEqual(snapshot["route_position"], self.engine.route.at(20))

    async def test_drift_pause_resume_uses_moving_time_and_freezes_live_edits(self):
        await self.start_drifting()
        self.time = 10
        await self.engine.dispatch("pause", {})
        held = self.engine.position
        await self.engine.dispatch("motion", {**self.engine.motion.as_dict(), "drift_radius_meters": 4})
        self.time = 200
        await self.engine._tick()
        self.assertEqual(self.engine.position, held)
        self.assertEqual(self.engine.elapsed_moving, 10)
        await self.engine.dispatch("resume", {})
        self.time = 201
        await self.engine._tick()
        expected = self.engine.drift.position_at(self.engine.route.at(11), 11, self.engine.route.length-11)
        self.assertEqual(self.device.sent[-1], expected)

    async def test_speed_update_keeps_drift_and_live_disable_returns_to_route(self):
        await self.start_drifting()
        profile = self.engine.drift
        self.time = 10
        await self.engine.dispatch("speed", {"speed": 7.2})
        self.assertIs(self.engine.drift, profile)
        self.assertTrue(self.engine.motion.drift_enabled)
        self.time = 11
        await self.engine._tick()
        expected = profile.position_at(self.engine.route.at(12), 11, self.engine.route.length-12)
        self.assertEqual(self.engine.position, expected)
        held = self.engine.position
        await self.engine.dispatch("motion", {**self.engine.motion.as_dict(), "drift_enabled": False})
        self.assertEqual(self.engine.position, held)
        self.time = 16
        await self.engine._tick()
        self.assertEqual(self.engine.position, self.engine.route.at(self.engine.traveled))

    async def test_drift_ends_exactly_and_restarting_gets_fresh_profile(self):
        await self.start_drifting()
        profile = self.engine.drift
        self.time = 10000
        await self.engine._tick()
        self.assertEqual(self.engine.position, (38.01, 114.52))
        self.assertEqual(self.engine.snapshot()["drift_distance"], 0)
        self.assertEqual(self.engine.state, "holding")
        await self.engine.dispatch("route", {"points": [[0, 0], [0.01, 0]], "motion": self.engine.motion.as_dict()})
        self.assertIsNot(self.engine.drift, profile)
        self.assertEqual(self.engine.position, (0, 0))
        self.assertEqual(self.engine.elapsed_moving, 0)

    async def test_drift_remains_continuous_across_lap_boundary(self):
        await self.start_drifting(closed=True, laps=2)
        boundary = self.engine.route.cumulative[-1]
        self.time = boundary-0.01
        await self.engine._tick()
        before = self.engine.position
        self.time = boundary+0.01
        await self.engine._tick()
        self.assertLess(distance(before, self.engine.position), 0.04)
        self.assertGreater(self.engine.snapshot()["drift_distance"], 0.01)

    async def test_bad_drift_settings_do_not_send_or_replace_active_route(self):
        await self.start_drifting()
        route = self.engine.route
        sent = list(self.device.sent)
        for action, data in (("motion", {"drift_enabled": "yes"}),
                             ("route", {"points": [[0, 0], [0, 1]], "motion": {"drift_radius_meters": 20}})):
            with self.assertRaises(ValueError):
                await self.engine.dispatch(action, data)
            self.assertIs(self.engine.route, route)
            self.assertEqual(self.device.sent, sent)

    async def test_failed_drift_send_does_not_advance_time_or_report_unsent_offset(self):
        await self.start_drifting()
        held = self.engine.snapshot()
        self.time = 10
        self.device.fail_set = True
        with self.assertRaises(RuntimeError):
            await self.engine.dispatch("pause", {})
        snapshot = self.engine.snapshot()
        for key in ("position", "route_position", "drift_distance", "distance", "elapsed_moving"):
            self.assertEqual(snapshot[key], held[key])
        self.assertTrue(snapshot["recovery_needed"])

    async def test_single_point_nudge_and_recovery_remove_route_drift(self):
        for action, payload in (("set", {"point": [38, 114]}), ("nudge", {"bearing": 90}), ("clear", {})):
            await self.start_drifting()
            await self.engine.dispatch(action, payload)
            self.assertIsNone(self.engine.drift)
            self.assertIsNone(self.engine.snapshot()["route_position"])
            self.assertEqual(self.engine.snapshot()["drift_distance"], 0)


if __name__ == "__main__":
    unittest.main()
