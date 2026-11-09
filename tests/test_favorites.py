# SPDX-License-Identifier: GPL-3.0-or-later
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from favorites import FavoriteError, FavoritesStore


class FavoritesTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.store = FavoritesStore(self.directory)

    def address(self, name="学校南门"):
        return self.store.save({"kind": "address", "name": name, "payload": {
            "coordinateSystem": "WGS84", "point": [38.023456, 114.501234], "zoom": 18}})["favorite"]

    def change(self, action, item, **extra):
        return self.store.change(action, {"id": item["id"], "expected_revision": item["revision"], **extra})["favorite"]

    def test_address_survives_reopen_without_coordinate_drift(self):
        item = self.address()
        reopened = FavoritesStore(self.directory).get(item["id"])["favorite"]
        self.assertEqual(reopened, item)
        self.assertEqual(reopened["payload"]["point"], [38.023456, 114.501234])
        self.assertEqual(reopened["payload"]["zoom"], 18)

    def test_route_reopens_with_original_points_and_all_motion_settings(self):
        payload = {"coordinateSystem": "WGS84", "points": [[38, 114.5], [38.001, 114.501], [38.002, 114.5]],
                   "closed": True, "laps": 3, "motion": {"mode": "pace", "pace_seconds": 330,
                   "randomize": True, "variation_percent": 18}}
        item = self.store.save({"kind": "route", "name": "操场三圈", "payload": payload})["favorite"]
        loaded = FavoritesStore(self.directory).get(item["id"])["favorite"]
        for key in ("points", "closed", "laps"):
            self.assertEqual(loaded["payload"][key], payload[key])
        for key, value in payload["motion"].items():
            self.assertEqual(loaded["payload"]["motion"][key], value)
        self.assertGreater(loaded["summary"]["distance"], 1000)
        self.assertNotIn("payload", self.store.list()["favorites"][0])

    def test_duplicate_normalized_name_does_not_overwrite(self):
        original = self.address("Ａ门")
        with self.assertRaises(FavoriteError) as error:
            self.address(" a门 ")
        self.assertEqual(error.exception.status, 409)
        self.assertEqual(self.store.get(original["id"])["favorite"], original)
        self.assertEqual(len(self.store.list()["favorites"]), 1)

    def test_rename_collision_rolls_back_and_stale_window_cannot_delete(self):
        first, second = self.address("东门"), self.address("西门")
        with self.assertRaises(FavoriteError):
            self.change("rename", first, name=second["name"])
        self.assertEqual(self.store.get(first["id"])["favorite"], first)
        renamed = self.change("rename", first, name="东侧入口")
        with self.assertRaises(FavoriteError) as error:
            self.change("delete", first)
        self.assertEqual(error.exception.status, 409)
        self.assertEqual(self.store.get(first["id"])["favorite"], renamed)

    def test_deleted_favorite_can_be_recovered_after_restart(self):
        original = self.address()
        deleted = self.change("delete", original)
        self.assertEqual(self.store.list()["favorites"], [])
        self.store = FavoritesStore(self.directory)
        self.assertEqual(self.store.list(deleted=True)["favorites"][0]["id"], original["id"])
        restored = self.change("restore", deleted)
        self.assertFalse(restored["deleted"])
        self.assertEqual(restored["payload"], original["payload"])

    def test_restore_collision_preserves_both_and_allows_rename_first(self):
        deleted = self.change("delete", self.address())
        current = self.address()
        with self.assertRaises(FavoriteError) as error:
            self.change("restore", deleted)
        self.assertEqual(error.exception.status, 409)
        self.assertEqual(self.store.get(current["id"])["favorite"], current)
        self.assertTrue(self.store.get(deleted["id"])["favorite"]["deleted"])
        renamed = self.change("rename", deleted, name="旧南门")
        self.change("restore", renamed)
        self.assertEqual(len(self.store.list()["favorites"]), 2)

    def test_invalid_content_never_creates_favorite(self):
        payloads = [{"point": [91, 114]}, {"point": [38, float("nan")]},
                    {"coordinateSystem": "GCJ02", "point": [38, 114]},
                    {"point": [38, 114], "zoom": True}]
        for payload in payloads:
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                self.store.save({"kind": "address", "name": "入口", "payload": payload})
        for name in ("", " \n", "a\nb", "a"*81):
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.address(name)
        with self.assertRaises(ValueError):
            self.store.save({"kind": "route", "name": "无效路线", "payload": {"points": [[38, 114], [38, 114]]}})
        self.assertEqual(self.store.list()["favorites"], [])

    def test_concurrent_windows_do_not_lose_new_favorites(self):
        with ThreadPoolExecutor(max_workers=6) as pool:
            items = list(pool.map(lambda i: self.address(f"入口 {i}"), range(18)))
        reopened = FavoritesStore(self.directory).list()["favorites"]
        self.assertEqual({x["id"] for x in reopened}, {x["id"] for x in items})


if __name__ == "__main__":
    unittest.main()
