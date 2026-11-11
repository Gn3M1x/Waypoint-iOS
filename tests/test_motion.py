import math
import random
import unittest

from motion import DriftProfile, MotionSettings, SpeedProfile
from route import distance, point


class MotionTests(unittest.TestCase):
    def test_six_minute_pace_is_ten_kph(self):
        settings = MotionSettings.parse({"mode": "pace", "pace_seconds": 360})
        self.assertAlmostEqual(settings.speed, 10)
        self.assertTrue(settings.randomize)

    def test_constant_pace_covers_one_kilometer_in_six_minutes(self):
        profile = SpeedProfile(MotionSettings.parse({"mode": "pace", "pace_seconds": 360, "randomize": False}))
        self.assertAlmostEqual(profile.distance_between(0, 360), 1000)
        self.assertAlmostEqual(profile.speed_at(0), profile.speed_at(1000))

    def test_random_speed_is_bounded_and_changes_smoothly(self):
        profile = SpeedProfile(MotionSettings.parse({"mode": "pace", "pace_seconds": 360, "variation_percent": 12}), random.Random(123))
        speeds = [profile.speed_at(i/2) for i in range(1200)]
        self.assertGreater(max(speeds)-min(speeds), 1)
        self.assertTrue(all(8.8 <= value <= 11.2 for value in speeds))
        self.assertLess(max(abs(a-b) for a, b in zip(speeds, speeds[1:])), 0.25)

    def test_distance_is_independent_of_timer_frequency(self):
        profile = SpeedProfile(MotionSettings.parse({"mode": "pace", "pace_seconds": 360}), random.Random(99))
        expected = profile.distance_between(0, 120)
        for interval in (0.1, 0.5, 5):
            total = sum(profile.distance_between(i*interval, (i+1)*interval) for i in range(round(120/interval)))
            self.assertAlmostEqual(total, expected, places=7)

    def test_partial_tick_stops_exactly_at_endpoint(self):
        profile = SpeedProfile(MotionSettings.parse({"mode": "pace", "pace_seconds": 360}), random.Random(17))
        duration = profile.time_for_distance(0, 1000, 500)
        self.assertAlmostEqual(profile.distance_between(0, duration), 1000, places=7)
        self.assertGreater(duration, 300)
        self.assertLess(duration, 410)

    def test_each_playback_can_have_a_different_variation(self):
        settings = MotionSettings.parse({"mode": "pace", "pace_seconds": 360})
        self.assertNotEqual(SpeedProfile(settings, random.Random(1)).speed_at(10), SpeedProfile(settings, random.Random(2)).speed_at(10))

    def test_invalid_motion_settings_are_rejected(self):
        for values in ({"mode": "bad"}, {"mode": "pace", "pace_seconds": 0}, {"mode": "pace", "pace_seconds": float("nan")},
                       {"mode": "pace", "randomize": "true"}, {"mode": "pace", "variation_percent": 31},
                       {"mode": "speed", "speed": True}):
            with self.subTest(values=values), self.assertRaises(ValueError):
                MotionSettings.parse(values)


class DriftTests(unittest.TestCase):
    def settings(self, **values):
        return MotionSettings.parse({"mode": "speed", "speed": 5, "drift_enabled": True, **values})

    def test_legacy_motion_leaves_drift_disabled_and_roundtrip_keeps_settings(self):
        self.assertFalse(MotionSettings.parse({"speed": 5}).drift_enabled)
        settings = self.settings(drift_radius_meters=3.5)
        self.assertEqual(MotionSettings.parse(settings.as_dict()), settings)

    def test_reject_invalid_drift_before_playback(self):
        for value in (None, 0, 1, "true", []):
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.settings(drift_enabled=value)
        for value in (None, True, 0, 0.49, 10.01, math.nan, math.inf, []):
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.settings(drift_radius_meters=value)

    def test_drift_stays_within_radius_and_is_smooth_over_long_playback(self):
        for radius in (0.5, 2, 10):
            profile = DriftProfile(self.settings(drift_radius_meters=radius), random.Random(42))
            samples = [profile.offset_at(i/2, 1000) for i in range(7200)]
            self.assertEqual(samples[0], (0, 0))
            self.assertTrue(all(math.hypot(*p) <= radius+1e-12 for p in samples))
            self.assertGreater(max(math.hypot(*p) for p in samples), 0.8*radius)
            self.assertLess(max(math.dist(a, b) for a, b in zip(samples, samples[1:])), 0.5*radius)

    def test_seeded_samples_repeat_independently_of_sampling_rate(self):
        a = DriftProfile(self.settings(), random.Random(123))
        b = DriftProfile(self.settings(), random.Random(123))
        other = DriftProfile(self.settings(), random.Random(124))
        for t in (10, 50, 100, 500):
            for tick in range(t*2):
                a.offset_at(tick/2, 1000)
            self.assertEqual(a.offset_at(t, 1000), b.offset_at(t, 1000))
            self.assertNotEqual(a.offset_at(t, 1000), other.offset_at(t, 1000))

    def test_wgs84_meter_offsets_near_date_line_and_poles(self):
        profile = DriftProfile(self.settings(), random.Random(3))
        expected = math.hypot(*profile.offset_at(10, 1000))
        for origin in ((38, 114.52), (0, 179.999999), (0, -179.999999), (89.9999, 20), (-89.9999, -20)):
            with self.subTest(origin=origin):
                shifted = point(profile.position_at(origin, 10, 1000))
                self.assertAlmostEqual(distance(origin, shifted), expected, delta=0.001)

    def test_endpoint_taper_is_smooth_and_disabled_positions_are_exact(self):
        profile = DriftProfile(self.settings(), random.Random(4))
        origin = (38, 114.52)
        samples = [profile.position_at(origin, 20, d) for d in (30, 15, 1, 0)]
        magnitudes = [distance(origin, p) for p in samples]
        self.assertGreater(magnitudes[0], magnitudes[1])
        self.assertGreater(magnitudes[1], magnitudes[2])
        self.assertLess(magnitudes[2], 0.01)
        self.assertEqual(samples[-1], origin)
        off = DriftProfile(self.settings(drift_enabled=False))
        self.assertEqual(off.position_at(origin, 200, 1000), origin)

    def test_live_radius_and_toggle_changes_preserve_position_then_ease(self):
        profile = DriftProfile(self.settings(), random.Random(5))
        # Test edits inside the endpoint taper too.
        for t, settings in ((10, self.settings(drift_radius_meters=10)),
                            (12, self.settings(drift_radius_meters=0.5)),
                            (13, self.settings(drift_enabled=False))):
            before = profile.offset_at(t, 15)
            profile.configure(settings, t)
            self.assertEqual(profile.offset_at(t, 15), before)
        self.assertEqual(profile.offset_at(18, 15), (0, 0))
        profile.configure(self.settings(), 18)
        self.assertEqual(profile.offset_at(18, 15), (0, 0))
        self.assertGreater(math.hypot(*profile.offset_at(23, 15)), 0)

    def test_speed_only_updates_do_not_restart_drift_transition_or_phases(self):
        profile = DriftProfile(self.settings(), random.Random(6))
        expected = profile.offset_at(4, 100)
        profile.configure(self.settings(speed=10), 2)
        self.assertEqual(profile.offset_at(4, 100), expected)
