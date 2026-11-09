# SPDX-License-Identifier: GPL-3.0-or-later
"""Explicit place-name search, cached and rate limited independently of GPS."""
import json
import os
import ssl
import threading
import time
from collections import OrderedDict
from urllib.error import HTTPError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen

from route import point


def verified_open(request, timeout):
    context = ssl.create_default_context()
    # python.org macOS installations may have no configured CA bundle.
    # Add the packaged public roots without disabling TLS verification.
    try:
        import certifi
        context.load_verify_locations(cafile=certifi.where())
    except ImportError:
        pass
    return urlopen(request, timeout=timeout, context=context)


class SearchError(Exception):
    def __init__(self, message, status=502):
        super().__init__(message)
        self.status = status


class Geocoder:
    def __init__(self, key=None, opener=None, clock=time.monotonic):
        self.key = os.environ.get("WAYPOINT_AMAP_KEY", "").strip() if key is None else key
        self.provider = os.environ.get("WAYPOINT_SEARCH_PROVIDER", "auto").strip()
        if self.provider not in ("auto", "amap", "nominatim"):
            raise ValueError("WAYPOINT_SEARCH_PROVIDER 应为 auto、amap 或 nominatim")
        self.endpoint = os.environ.get("WAYPOINT_NOMINATIM_URL", "https://nominatim.openstreetmap.org/search")
        if urlsplit(self.endpoint).scheme != "https" or urlsplit(self.endpoint).username is not None:
            raise ValueError("搜索服务地址应使用 HTTPS，且不能包含凭据")
        self.opener = opener or verified_open
        self.clock = clock
        self.lock = threading.Lock()
        self.cache = OrderedDict()
        self.last_request = float("-inf")

    def search(self, query):
        if not isinstance(query, str) or not 1 <= len(query.strip()) <= 120:
            raise ValueError("请输入 1–120 个字符的地名")
        query = " ".join(query.split())
        provider = ("amap" if self.key else "nominatim") if self.provider == "auto" else self.provider
        if provider == "amap" and not self.key:
            raise SearchError("高德搜索需要配置 Web 服务 Key；也可选择免 Key 的搜索服务。", 400)
        if not self.lock.acquire(blocking=False):
            raise SearchError("上一条搜索尚未完成，请稍后重试。", 429)
        try:
            cache_key = (provider, query)
            cached = self.cache.get(cache_key)
            if cached and self.clock()-cached[0] < 900:
                self.cache.move_to_end(cache_key)
                return dict(cached[1], cached=True)
            if self.clock()-self.last_request < 1.1:
                raise SearchError("搜索过于频繁，请稍等一秒。", 429)
            self.last_request = self.clock()
            if provider == "amap":
                url = "https://restapi.amap.com/v5/place/text?" + urlencode({"key": self.key, "keywords": query, "page_size": 8})
            else:
                url = self.endpoint + ("&" if "?" in self.endpoint else "?") + urlencode({
                    "q": query, "format": "jsonv2", "limit": 8, "addressdetails": 1,
                    "namedetails": 1, "accept-language": "zh-CN,zh,en"})
            request = Request(url, headers={"User-Agent": "Waypoint/0.3 (local desktop map search)", "Accept": "application/json"})
            try:
                with self.opener(request, timeout=12) as response:
                    raw = response.read(2_000_001)
                if len(raw) > 2_000_000:
                    raise SearchError("搜索响应过大，请缩小搜索范围。")
                payload = json.loads(raw)
            except HTTPError as exc:
                raise SearchError("搜索服务暂时限流，请稍后重试。" if exc.code == 429 else "搜索服务暂时不可用，请稍后重试。", 429 if exc.code == 429 else 502) from None
            except SearchError:
                raise
            except Exception:
                raise SearchError("地名搜索暂时无法连接，请检查网络后重试；底图仍可正常使用。") from None
            results = self._parse_amap(payload) if provider == "amap" else self._parse_nominatim(payload)
            result = {"results": results, "provider": provider,
                      "attribution": "© 高德地图" if provider == "amap" else "© OpenStreetMap contributors · ODbL",
                      "coordinate_system": "GCJ02" if provider == "amap" else "WGS84", "cached": False}
            self.cache[cache_key] = (self.clock(), result)
            self.cache.move_to_end(cache_key)
            while len(self.cache) > 100:
                self.cache.popitem(last=False)
            return result
        finally:
            self.lock.release()

    @staticmethod
    def _parse_nominatim(payload):
        if not isinstance(payload, list):
            raise SearchError("地名搜索返回了无效数据，请稍后重试。")
        results = []
        for row in payload[:8]:
            try:
                p = point([row.get("lat"), row.get("lon")])
                display = str(row.get("display_name", ""))[:500]
                names = row.get("namedetails") or {}
                name = str(names.get("name:zh") or row.get("name") or display.split(",")[0])[:160]
                if not name:
                    continue
                bounds = row.get("boundingbox")
                try:
                    south, north, west, east = map(float, bounds)
                    bounds = [south, north, west, east] if -90 <= south <= north <= 90 and -180 <= west <= east <= 180 else None
                except (TypeError, ValueError):
                    bounds = None
                results.append({"name": name, "address": display, "point": p, "bounds": bounds})
            except (ValueError, TypeError, AttributeError):
                continue
        return results

    @staticmethod
    def _parse_amap(payload):
        if not isinstance(payload, dict) or str(payload.get("status")) != "1":
            raise SearchError("高德搜索不可用，请检查 Web 服务 Key 和服务额度。")
        rows = payload.get("pois") or []
        if not isinstance(rows, list):
            raise SearchError("高德搜索返回了无效数据。")
        results = []
        for row in rows[:8]:
            try:
                lon, lat = str(row.get("location", "")).split(",")
                p = point([lat, lon])
                name = str(row.get("name") or "")[:160]
                address = " ".join(row[k] for k in ("pname", "cityname", "adname", "address") if isinstance(row.get(k), str))[:500]
                if name:
                    results.append({"name": name, "address": address, "point": p, "bounds": None})
            except (TypeError, ValueError, AttributeError):
                continue
        return results
