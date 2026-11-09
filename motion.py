# SPDX-License-Identifier: GPL-3.0-or-later
"""Continuous speed profiles with an exact distance integral."""
import math
import random
from dataclasses import dataclass

from route import number


@dataclass(frozen=True)
class MotionSettings:
    mode: str = "speed"
    speed: float = 6.0
    pace_seconds: float = 600.0
    randomize: bool = False
    variation_percent: float = 12.0

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
        if mode == "pace":
            pace = number(data.get("pace_seconds", 360), 60, 3600, "配速（秒/公里）")
            speed = 3600 / pace
        else:
            speed = number(data.get("speed", 6), 0.1, 1000, "速度（km/h）")
            pace = 3600 / speed
            randomize = False
        return cls(mode, speed, pace, randomize, variation)

    def as_dict(self):
        return {"mode": self.mode, "speed": self.speed, "pace_seconds": self.pace_seconds,
                "randomize": self.randomize, "variation_percent": self.variation_percent}


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
