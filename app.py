#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Local desktop control panel. All device actions require the per-run token."""
import argparse
import asyncio
import concurrent.futures
import hmac
import json
import os
import secrets
import signal
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, parse_qs

from engine import Engine
from geocoder import Geocoder, SearchError
from favorites import FavoritesStore, FavoriteError, default_data_directory

ROOT = Path(__file__).resolve().parent
MAX_BODY = 1_000_000


class Runtime:
    def __init__(self, demo=False):
        self.loop = asyncio.new_event_loop()
        self.engine = Engine(demo=demo)
        self.thread = threading.Thread(target=self.loop.run_forever, daemon=True)
        self.thread.start()
        self.call(self.engine.start(), timeout=5)

    def call(self, coroutine, timeout=310):
        future = asyncio.run_coroutine_threadsafe(coroutine, self.loop)
        try:
            return future.result(timeout)
        except concurrent.futures.TimeoutError:
            future.cancel()
            raise RuntimeError("操作超时。请保持手机解锁并检查连接。") from None

    def snapshot(self):
        async def read():
            return self.engine.snapshot()
        return self.call(read(), timeout=5)

    def close(self):
        self.call(self.engine.shutdown(), timeout=35)
        self.loop.call_soon_threadsafe(self.loop.stop)
        self.thread.join(timeout=3)
        self.loop.close()


def make_handler(runtime, token, on_exit, data_directory=None):
    geocoder = Geocoder()
    favorites = FavoritesStore(data_directory or default_data_directory(ROOT))
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass  # Do not print session tokens or device identifiers.

        def valid_host(self):
            expected = f"127.0.0.1:{self.server.server_port}"
            return self.headers.get("Host", "") == expected

        def authenticated(self):
            expected = f"http://127.0.0.1:{self.server.server_port}"
            origin = self.headers.get("Origin")
            header = self.headers.get("Authorization", "")
            return self.valid_host() and (origin is None or origin == expected) and hmac.compare_digest(header, "Bearer " + token)

        def reply(self, status, value, content_type="application/json; charset=utf-8"):
            body = json.dumps(value, ensure_ascii=False).encode() if isinstance(value, (dict, list)) else value
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
            self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https://webst02.is.autonavi.com https://tile.openstreetmap.org data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if not self.valid_host():
                return self.reply(403, {"error": "非法主机来源"})
            path = urlsplit(self.path).path
            if path == "/api/status":
                if not self.authenticated():
                    return self.reply(403, {"error": "请从启动程序打开控制台"})
                return self.reply(200, runtime.snapshot())
            if path in ("/api/favorites", "/api/favorites/item"):
                if not self.authenticated():
                    return self.reply(403, {"error": "请求未授权"})
                query = parse_qs(urlsplit(self.path).query)
                try:
                    result = favorites.get(query.get("id", [""])[0]) if path.endswith("/item") else favorites.list(query.get("trash", ["0"])[0] == "1")
                    return self.reply(200, result)
                except FavoriteError as exc:
                    return self.reply(exc.status, {"error": str(exc)})
            assets = {"/": ("index.html", "text/html; charset=utf-8"),
                      "/app.js": ("app.js", "text/javascript; charset=utf-8"),
                      "/map-coordinates.mjs": ("map-coordinates.mjs", "text/javascript; charset=utf-8"),
                      "/editor-map.mjs": ("editor-map.mjs", "text/javascript; charset=utf-8"),
                      "/motion.mjs": ("motion.mjs", "text/javascript; charset=utf-8"),
                      "/style.css": ("style.css", "text/css; charset=utf-8")}
            if path not in assets:
                return self.reply(404, {"error": "页面不存在"})
            filename, mime = assets[path]
            self.reply(200, (ROOT / "web" / filename).read_bytes(), mime)

        def do_POST(self):
            if not self.authenticated():
                return self.reply(403, {"error": "请求未授权"})
            if self.headers.get("Content-Type", "").split(";")[0].strip() != "application/json":
                return self.reply(415, {"error": "请求应使用 JSON"})
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 <= length <= MAX_BODY:
                    return self.reply(413, {"error": "数据过大"})
                data = json.loads(self.rfile.read(length) or b"{}")
                if urlsplit(self.path).path.startswith("/api/favorites/"):
                    if not isinstance(data, dict):
                        raise ValueError("收藏请求应为对象")
                    action = urlsplit(self.path).path.removeprefix("/api/favorites/")
                    return self.reply(200, favorites.save(data) if action == "save" else favorites.change(action, data))
                if urlsplit(self.path).path == "/api/search":
                    if not isinstance(data, dict):
                        raise ValueError("搜索请求应为对象")
                    return self.reply(200, geocoder.search(data.get("query")))
                if urlsplit(self.path).path == "/api/exit":
                    runtime.call(runtime.engine.shutdown(), timeout=35)
                    self.reply(200, {"ok": True})
                    threading.Thread(target=on_exit, daemon=True).start()
                    return
                if not urlsplit(self.path).path.startswith("/api/"):
                    return self.reply(404, {"error": "接口不存在"})
                action = urlsplit(self.path).path.removeprefix("/api/")
                value = runtime.call(runtime.engine.dispatch(action, data))
                self.reply(200, value)
            except SearchError as exc:
                self.reply(exc.status, {"error": str(exc)})
            except FavoriteError as exc:
                self.reply(exc.status, {"error": str(exc)})
            except (ValueError, json.JSONDecodeError) as exc:
                self.reply(400, {"error": str(exc)})
            except Exception as exc:
                self.reply(500, {"error": str(exc)[:2000]})

    return Handler


def main():
    parser = argparse.ArgumentParser(description="iPhone 定位控制台")
    parser.add_argument("--demo", action="store_true", help="演示模式，不访问 iPhone")
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--data-dir", type=Path, help="收藏数据目录")
    args = parser.parse_args()
    runtime = Runtime(args.demo)
    # A controlled in-place desktop update can retain the existing local session.
    token = os.environ.pop("WAYPOINT_SESSION_TOKEN", None) or secrets.token_urlsafe(32)
    data_directory = args.data_dir or (ROOT/"user-data-demo" if args.demo else default_data_directory(ROOT))
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(runtime, token, lambda: server.shutdown(), data_directory))
    server.daemon_threads = True
    url = f"http://127.0.0.1:{server.server_port}/#token={token}"
    print("\n定位控制台" + (" · 演示模式（不会连接手机）" if args.demo else ""), flush=True)
    print("请保持本窗口开启。结束时请点击控制台中的“恢复并退出”。", flush=True)
    print("控制台地址（仅本机，勿分享）：\n" + url, flush=True)
    if not args.no_browser:
        webbrowser.open(url)

    def interrupted(_signum, _frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, interrupted)
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        try:
            runtime.close()
        except Exception as exc:
            print("\n" + str(exc), flush=True)
        server.server_close()


if __name__ == "__main__":
    main()
