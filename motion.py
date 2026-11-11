# SPDX-License-Identifier: GPL-3.0-or-later
"""Continuous route speed profiles and bounded synthetic GPS drift."""
import math
import random
from dataclasses import dataclass

from route import destination, number


@dataclass(frozen=True)
class MotionSettings:
    mode: str = "speed"
    speed: float = 6.0
    pace_seconds: float = 600.0
    randomize: bool = False
    variation_percent: float = 12.0
    drift_enabled: bool = False
    drift_radius_meters: float = 2.0

    @classmethod
    def parse(cls, data):
        if not isinstance(data, dict):
            raise ValueError("移动设置应为对象")
        mode = data.get("mode", "speed")
        if mode not in ("speed", "pace"):
            raise ValueError("移动模式只能选择速度或配速")
        randomize = data.get("randomize", mode == "pace")
        if not isinstance(randomize, bool):
            raise ValueError("随机变速选项应为布尔值")
        variation = number(data.get("variation_percent", 12), 0, 30, "速度波动幅度（%）")
        drift_enabled = data.get("drift_enabled", False)
        if not isinstance(drift_enabled, bool):
            raise ValueError("随机偏移选项应为布尔值")
        drift_radius = number(data.get("drift_radius_meters", 2), 0.5, 10, "最大偏移（米）")
        if mode == "pace":
            pace = number(data.get("pace_seconds", 360), 60, 3600, "配速（秒/公里）")
            speed = 3600 / pace
        else:
            speed = number(data.get("speed", 6), 0.1, 1000, "速度（km/h）")
            pace = 3600 / speed
            randomize = False
        return cls(mode, speed, pace, randomize, variation, drift_enabled, drift_radius)

    def as_dict(self):
        return {"mode": self.mode, "speed": self.speed, "pace_seconds": self.pace_seconds,
                "randomize": self.randomize, "variation_percent": self.variation_percent,
                "drift_enabled": self.drift_enabled, "drift_radius_meters": self.drift_radius_meters}


class DriftProfile:
    """Bounded, continuous GPS test offsets in local east/north meters.

    Random phases and periods blend slow wander with a small walking sway.
    Components have unit norm and weights sum to one, bounding the radial
    offset. Sampling uses moving time, never the number of timer callbacks.
    This is synthetic test data, not a calibrated model of a GPS receiver.
    """
    TRANSITION_SECONDS = 5.0

    def __init__(self, settings, rng=None):
        rng = rng or random.Random()
        self.components = [(weight, 2*math.pi/rng.uniform(low, high), rng.uniform(0, 2*math.pi))
                           for weight, low, high in ((0.65, 22, 38), (0.30, 8, 14), (0.05, 2, 3.5))]
        self.start_radius = 0.0
        self.target_radius = settings.drift_radius_meters if settings.drift_enabled else 0.0
        self.changed_at = 0.0

    @staticmethod
    def _ease(fraction):
        x = min(1.0, max(0.0, fraction))
        return x*x*(3-2*x)

    def radius_at(self, seconds):
        blend = self._ease((seconds-self.changed_at)/self.TRANSITION_SECONDS)
        return self.start_radius + (self.target_radius-self.start_radius)*blend

    def configure(self, settings, seconds):
        target = settings.drift_radius_meters if settings.drift_enabled else 0.0
        if target != self.target_radius:
            self.start_radius = self.radius_at(seconds)
            self.target_radius = target
            self.changed_at = seconds

    def offset_at(self, seconds, remaining):
        # Fixed endpoint taper independent of settings, so live edits cannot
        # change the taper abruptly. Only the final endpoint tapers, not laps.
        radius = self.radius_at(seconds) * self._ease(remaining/30.0)
        east = radius*sum(w*math.sin(omega*seconds+phase) for w, omega, phase in self.components)
        north = radius*sum(w*math.cos(omega*seconds+phase) for w, omega, phase in self.components)
        return east, north

    def position_at(self, origin, seconds, remaining):
        east, north = self.offset_at(seconds, remaining)
        meters = math.hypot(east, north)
        if meters == 0:
            return origin
        return destination(origin, math.degrees(math.atan2(east, north)), meters)


class SpeedProfile:
    """Two randomly phased smooth components; no per-tick white noise.

    The instantaneous speed stays within the chosen percentage of nominal
    speed. A finite route's average may differ slightly from the nominal target.
    """
    def __init__(self, settings, rng=None):
        self.settings = settings
        self.base_mps = settings.speed / 3.6
        self.amplitude = settings.variation_percent / 100 if settings.randomize else 0
        rng = rng or random.Random()
        self.components = [(0.6, 2*math.pi/rng.uniform(12, 22), rng.uniform(0, 2*math.pi)),
                           (0.4, 2*math.pi/rng.uniform(35, 60), rng.uniform(0, 2*math.pi))]

    def speed_at(self, seconds):
        factor = 1 + self.amplitude*sum(w*math.sin(omega*seconds+phase) for w, omega, phase in self.components)
        return self.settings.speed * factor

    def distance_between(self, start, end):
        if end <= start:
            return 0.0
        modulation = sum(w*(math.cos(omega*start+phase)-math.cos(omega*end+phase))/omega
                         for w, omega, phase in self.components)
        return self.base_mps * ((end-start) + self.amplitude*modulation)

    def time_for_distance(self, start, meters, maximum):
        if meters <= 0:
            return 0.0
        if self.amplitude == 0:
            return min(maximum, meters/self.base_mps)
        low, high = 0.0, maximum
        for _ in range(45):
            middle = (low+high)/2
            if self.distance_between(start, start+middle) < meters:
                low = middle
            else:
                high = middle
        return (low+high)/2
