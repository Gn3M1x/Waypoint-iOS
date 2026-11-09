import random
import unittest

from motion import MotionSettings, SpeedProfile


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
