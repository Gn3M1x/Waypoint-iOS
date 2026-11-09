# SPDX-License-Identifier: GPL-3.0-or-later
"""WGS84 route geometry. No phone or third-party dependencies."""
import bisect
import math
from dataclasses import dataclass

RADIUS = 6371008.8


def number(value, low, high, label):
    if isinstance(value, bool):
        raise ValueError(f"{label}必须为数字")
    try:
        value = float(value)
    except (TypeError, ValueError, OverflowError):
        raise ValueError(f"{label}必须为数字") from None
    if not math.isfinite(value) or not low <= value <= high:
        raise ValueError(f"{label}范围为 {low}–{high}")
    return value


def point(value):
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        raise ValueError("坐标格式应为 [纬度, 经度]")
    return (number(value[0], -90, 90, "纬度"), number(value[1], -180, 180, "经度"))


def distance(a, b):
    lat1, lat2 = math.radians(a[0]), math.radians(b[0])
    dlat, dlon = lat2 - lat1, math.radians(b[1] - a[1])
    h = math.sin(dlat / 2)**2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2)**2
    return 2 * RADIUS * math.asin(math.sqrt(min(1, max(0, h))))


def destination(origin, bearing, meters):
    lat, lon = map(math.radians, origin)
    b, arc = math.radians(bearing), meters / RADIUS
    lat2 = math.asin(math.sin(lat)*math.cos(arc) + math.cos(lat)*math.sin(arc)*math.cos(b))
    lon2 = lon + math.atan2(math.sin(b)*math.sin(arc)*math.cos(lat), math.cos(arc)-math.sin(lat)*math.sin(lat2))
    return math.degrees(lat2), (math.degrees(lon2) + 180) % 360 - 180


def interpolate(a, b, fraction):
    # Great-circle interpolation also handles the international date line.
    arc = distance(a, b) / RADIUS
    if arc < 1e-12:
        return a
    if abs(math.pi - arc) < 1e-6:
        raise ValueError("相邻路径点不能互为对跖点")
    s1, s2 = math.sin((1-fraction)*arc)/math.sin(arc), math.sin(fraction*arc)/math.sin(arc)
    p1, l1 = map(math.radians, a)
    p2, l2 = map(math.radians, b)
    x = s1*math.cos(p1)*math.cos(l1) + s2*math.cos(p2)*math.cos(l2)
    y = s1*math.cos(p1)*math.sin(l1) + s2*math.cos(p2)*math.sin(l2)
    z = s1*math.sin(p1) + s2*math.sin(p2)
    return math.degrees(math.atan2(z, math.hypot(x, y))), math.degrees(math.atan2(y, x))


@dataclass
class Route:
    points: list
    cumulative: list
    laps: int

    @classmethod
    def build(cls, values, closed=False, laps=1):
        if not isinstance(values, list) or not 2 <= len(values) <= 2000:
            raise ValueError("路线需要 2–2000 个路径点")
        if not isinstance(closed, bool):
            raise ValueError("闭合路线必须为布尔值")
        if isinstance(laps, bool) or not isinstance(laps, int) or not 1 <= laps <= 100:
            raise ValueError("圈数应为 1–100 的整数")
        if laps > 1 and not closed:
            raise ValueError("多圈路线需要先勾选闭合路线")
        pts = [point(p) for p in values]
        pts = [p for i, p in enumerate(pts) if i == 0 or distance(pts[i-1], p) > 0.001]
        if closed and len(pts) > 1 and distance(pts[0], pts[-1]) > 0.001:
            pts.append(pts[0])
        cumulative = [0.0]
        for a, b in zip(pts, pts[1:]):
            arc = distance(a, b)
            if abs(math.pi - arc / RADIUS) < 1e-6:
                raise ValueError("相邻路径点不能互为对跖点")
            cumulative.append(cumulative[-1] + arc)
        if cumulative[-1] < 1:
            raise ValueError("路线总长应至少为 1 米")
        return cls(pts, cumulative, laps)

    @property
    def length(self):
        return self.cumulative[-1] * self.laps

    def at(self, traveled):
        if traveled >= self.length:
            return self.points[-1]
        segment_distance = max(0, traveled) % self.cumulative[-1]
        i = min(bisect.bisect_right(self.cumulative, segment_distance)-1, len(self.points)-2)
        fraction = (segment_distance-self.cumulative[i])/(self.cumulative[i+1]-self.cumulative[i])
        return interpolate(self.points[i], self.points[i+1], fraction)
