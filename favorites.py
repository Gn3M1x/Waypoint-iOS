# SPDX-License-Identifier: GPL-3.0-or-later
"""Durable, transactional favorites; never part of a source release archive."""
import json
import os
import sqlite3
import sys
import unicodedata
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from motion import MotionSettings
from route import Route, point


class FavoriteError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def default_data_directory(root):
    if os.environ.get("WAYPOINT_DATA_DIR"):
        return Path(os.environ["WAYPOINT_DATA_DIR"]).expanduser()
    # Standalone .app updates share application data. Source/portable installs
    # keep their data alongside the source and do not write outside that folder.
    if any(p.suffix == ".app" for p in Path(root).parents):
        if sys.platform == "darwin":
            return Path.home()/"Library"/"Application Support"/"Waypoint"
        if os.name == "nt":
            return Path(os.environ.get("LOCALAPPDATA", Path.home()))/"Waypoint"
    return Path(root)/"user-data"


def clean_name(value):
    if not isinstance(value, str):
        raise FavoriteError("请填写收藏名称")
    value = value.strip()
    if not 1 <= len(value) <= 80 or any(ord(c) < 32 for c in value):
        raise FavoriteError("收藏名称应为 1–80 个字符，不能包含换行")
    return value, unicodedata.normalize("NFKC", value).casefold()


def validate_payload(kind, value):
    if not isinstance(value, dict):
        raise FavoriteError("收藏内容格式无效")
    if value.get("coordinateSystem", "WGS84") != "WGS84":
        raise FavoriteError("收藏坐标必须使用 WGS84")
    if kind == "address":
        p = point(value.get("point"))
        zoom = value.get("zoom", 17)
        if isinstance(zoom, bool) or not isinstance(zoom, int) or not 2 <= zoom <= 19:
            raise FavoriteError("地图缩放级别无效")
        payload = {"version": 1, "coordinateSystem": "WGS84", "point": list(p), "zoom": zoom}
        return payload, {"point": list(p), "zoom": zoom}
    if kind == "route":
        route = Route.build(value.get("points"), value.get("closed", False), value.get("laps", 1))
        motion = MotionSettings.parse(value["motion"] if "motion" in value else {"mode": "speed", "speed": value.get("speed", 6)})
        payload = {"version": 1, "coordinateSystem": "WGS84", "points": [list(point(p)) for p in value["points"]],
                   "closed": value.get("closed", False), "laps": value.get("laps", 1),
                   "motion": motion.as_dict(), "speed": motion.speed}
        return payload, {"distance": round(route.length, 1), "points": len(payload["points"]),
                         "closed": payload["closed"], "laps": payload["laps"], "motion": motion.as_dict()}
    raise FavoriteError("收藏类型应为地址或路线")


class FavoritesStore:
    def __init__(self, directory):
        directory = Path(directory)
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.path = directory/"favorites.sqlite3"
        with self.connect() as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("""CREATE TABLE IF NOT EXISTS favorites (
                id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, name_key TEXT NOT NULL,
                payload TEXT NOT NULL, summary TEXT NOT NULL, created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL, deleted_at TEXT, revision INTEGER NOT NULL DEFAULT 1)""")
            connection.execute("CREATE UNIQUE INDEX IF NOT EXISTS favorite_active_name ON favorites(kind,name_key) WHERE deleted_at IS NULL")
        try:
            self.path.chmod(0o600)
        except OSError:
            pass

    @contextmanager
    def connect(self):
        connection = sqlite3.connect(self.path, timeout=10)
        connection.row_factory = sqlite3.Row
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    @staticmethod
    def _serialize(row, include_payload=False):
        value = {"id": row["id"], "kind": row["kind"], "name": row["name"],
                 "summary": json.loads(row["summary"]), "created_at": row["created_at"],
                 "updated_at": row["updated_at"], "deleted": row["deleted_at"] is not None,
                 "revision": row["revision"]}
        if include_payload:
            value["payload"] = json.loads(row["payload"])
        return value

    def list(self, deleted=False):
        with self.connect() as connection:
            rows = connection.execute("SELECT id,kind,name,summary,created_at,updated_at,deleted_at,revision FROM favorites WHERE deleted_at IS " + ("NOT NULL" if deleted else "NULL") + " ORDER BY updated_at DESC,rowid DESC").fetchall()
        # Route point arrays are deliberately omitted from list responses.
        return {"favorites": [self._serialize(r) for r in rows], "trash": deleted}

    def get(self, identifier):
        with self.connect() as connection:
            row = connection.execute("SELECT * FROM favorites WHERE id=?", (str(identifier),)).fetchone()
        if row is None:
            raise FavoriteError("收藏不存在，请刷新列表", 404)
        return {"favorite": self._serialize(row, True)}

    def save(self, data):
        name, name_key = clean_name(data.get("name"))
        kind = data.get("kind")
        payload, summary = validate_payload(kind, data.get("payload"))
        identifier = uuid.uuid4().hex
        now = datetime.now(timezone.utc).isoformat(timespec="microseconds")
        try:
            with self.connect() as connection:
                connection.execute("INSERT INTO favorites(id,kind,name,name_key,payload,summary,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
                                   (identifier, kind, name, name_key, json.dumps(payload, ensure_ascii=False, allow_nan=False),
                                    json.dumps(summary, ensure_ascii=False, allow_nan=False), now, now))
        except sqlite3.IntegrityError:
            raise FavoriteError("已有同名收藏，请换一个名称；原收藏没有被覆盖。", 409) from None
        return self.get(identifier)

    def change(self, action, data):
        if action not in ("rename", "delete", "restore"):
            raise FavoriteError("未知收藏操作")
        identifier = str(data.get("id", ""))
        revision = data.get("expected_revision")
        if isinstance(revision, bool) or not isinstance(revision, int) or revision < 1:
            raise FavoriteError("收藏版本无效，请刷新后重试")
        rename = clean_name(data.get("name")) if action == "rename" else None
        try:
            with self.connect() as connection:
                connection.execute("BEGIN IMMEDIATE")
                row = connection.execute("SELECT * FROM favorites WHERE id=?", (identifier,)).fetchone()
                if row is None:
                    raise FavoriteError("收藏不存在，请刷新列表", 404)
                if row["revision"] != revision:
                    raise FavoriteError("收藏已被其他窗口修改，请刷新后重试。", 409)
                now = datetime.now(timezone.utc).isoformat(timespec="microseconds")
                if action == "rename":
                    connection.execute("UPDATE favorites SET name=?,name_key=?,updated_at=?,revision=revision+1 WHERE id=?", (*rename, now, identifier))
                else:
                    deleted_at = now if action == "delete" else None
                    connection.execute("UPDATE favorites SET deleted_at=?,updated_at=?,revision=revision+1 WHERE id=?", (deleted_at, now, identifier))
        except sqlite3.IntegrityError:
            raise FavoriteError("已有同名收藏，请先改名再恢复或保存；原收藏没有被覆盖。", 409) from None
        return self.get(identifier)
