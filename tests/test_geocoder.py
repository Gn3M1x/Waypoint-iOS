import io
import json
import unittest

from geocoder import Geocoder, SearchError


class GeocoderTests(unittest.TestCase):
    def service(self, payload, key=""):
        self.calls = []
        self.now = 0
        def open_response(request, timeout):
            self.calls.append(request)
            return io.BytesIO(json.dumps(payload).encode())
        return Geocoder(key=key, opener=open_response, clock=lambda: self.now)

    def test_chinese_place_results_have_wgs84_coordinates_and_bounds(self):
        service = self.service([{"name": "河北师范大学", "lat": "37.9965514", "lon": "114.5149368", "display_name": "河北师范大学，石家庄市", "boundingbox": ["37.99", "38.01", "114.50", "114.53"]}])
        result = service.search("河北师范大学")
        self.assertEqual(result["coordinate_system"], "WGS84")
        self.assertEqual(result["results"][0]["point"], (37.9965514, 114.5149368))
        self.assertEqual(result["results"][0]["bounds"], [37.99, 38.01, 114.50, 114.53])
        self.assertIn("Waypoint", self.calls[0].get_header("User-agent"))

    def test_amap_results_keep_explicit_gcj02_type_and_latitude_order(self):
        service = self.service({"status": "1", "pois": [{"name": "测试校园", "location": "114.52,38.00", "cityname": "石家庄市"}]}, key="test-key")
        result = service.search("测试校园")
        self.assertEqual(result["coordinate_system"], "GCJ02")
        self.assertEqual(result["results"][0]["point"], (38.0, 114.52))

    def test_repeat_query_uses_cache_without_another_request(self):
        service = self.service([])
        service.search("  石家庄   河北师范大学 ")
        self.assertTrue(service.search("石家庄 河北师范大学")["cached"])
        self.assertEqual(len(self.calls), 1)

    def test_cold_requests_are_rate_limited(self):
        service = self.service([])
        service.search("北京")
        with self.assertRaises(SearchError) as caught:
            service.search("上海")
        self.assertEqual(caught.exception.status, 429)
        self.now = 1.2
        service.search("上海")
        self.assertEqual(len(self.calls), 2)

    def test_invalid_coordinates_and_malformed_rows_are_skipped(self):
        service = self.service([None, {"lat": "nan", "lon": "114", "name": "bad"}, {"lat": "38", "lon": "114", "name": "ok"}])
        self.assertEqual([x["name"] for x in service.search("测试")["results"]], ["ok"])

    def test_query_validation_happens_before_network(self):
        service = self.service([])
        for query in (None, " ", "x"*121, 123):
            with self.assertRaises(ValueError):
                service.search(query)
        self.assertEqual(self.calls, [])

    def test_request_errors_do_not_expose_keys(self):
        def failing(request, timeout):
            raise RuntimeError(request.full_url)
        service = Geocoder(key="private-test-key", opener=failing)
        with self.assertRaises(SearchError) as caught:
            service.search("北京")
        self.assertNotIn("private-test-key", str(caught.exception))
