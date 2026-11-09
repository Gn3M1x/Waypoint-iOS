# SPDX-License-Identifier: GPL-3.0-or-later
"""Long-lived DVT session, serialized actions, monotonic route playback."""
import asyncio
import importlib.metadata
import importlib.util
import platform
import sys
import time
from contextlib import AsyncExitStack

from route import Route, destination, number, point
from motion import MotionSettings, SpeedProfile

REQUIRED_PMD = "11.50.2"


def dependency_info():
    try:
        version = importlib.metadata.version("pymobiledevice3")
    except importlib.metadata.PackageNotFoundError:
        return {"available": False, "version": None, "required": REQUIRED_PMD}
    return {"available": True, "version": version, "required": REQUIRED_PMD}


def friendly_error(error):
    detail = f"{type(error).__name__}: {error}"[:1500]
    text = detail.lower()
    if isinstance(error, (asyncio.TimeoutError, TimeoutError)):
        return "操作超时。请解锁手机、检查数据线，再重试。"
    if "developermode" in text or "developer mode" in text:
        return "请在 iPhone 设置 → 隐私与安全性中开启开发者模式，重启并确认后重试。"
    if "password" in text or "locked" in text or "pairing" in text or "trust" in text:
        return "请解锁 iPhone，并在手机上确认“信任此电脑”，然后重试。"
    if "pymobiledevice3" in text and ("import" in text or "module" in text):
        return "定位组件未安装或版本不匹配。请通过“start-mac.command”或“start-windows.bat”重新安装。"
    if "no device" in text or "nodevice" in text or "usbmux" in text:
        return "未连接到 iPhone。请使用可传数据的数据线；Windows 还需安装 Apple Devices。"
    return detail


class DeviceAdapter:
    def __init__(self):
        self.stack = None
        self.location = None

    async def devices(self):
        from pymobiledevice3 import usbmux
        from pymobiledevice3.lockdown import create_using_usbmux
        found = []
        for device in await usbmux.list_devices():
            if not device.is_usb:
                continue
            info = {"id": device.serial, "name": "iPhone（待信任）", "ios": "未知", "paired": False, "developer_mode": None}
            try:
                async with await create_using_usbmux(serial=device.serial, autopair=False, connection_type=device.connection_type) as lockdown:
                    values = lockdown.all_values
                    info.update(name=values.get("DeviceName", "iPhone"), ios=values.get("ProductVersion", "未知"), paired=True)
                    try:
                        info["developer_mode"] = await lockdown.get_developer_mode_status()
                    except Exception:
                        pass
            except Exception:
                pass
            found.append(info)
        return found

    async def prepare(self, serial):
        from pymobiledevice3.lockdown import create_using_usbmux
        async with await create_using_usbmux(serial=serial) as lockdown:
            if not await lockdown.get_developer_mode_status():
                raise RuntimeError("Developer Mode is disabled")
        # Explicit argument array: no shell, arbitrary command, or privilege escalation.
        proc = await asyncio.create_subprocess_exec(
            sys.executable, "-m", "pymobiledevice3", "mounter", "auto-mount", "--udid", serial,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        )
        try:
            output, _ = await asyncio.wait_for(proc.communicate(), timeout=180)
        except BaseException:
            if proc.returncode is None:
                proc.kill()
            await proc.communicate()
            raise
        if proc.returncode:
            raise RuntimeError(output.decode("utf-8", errors="replace")[-1800:])

    async def connect(self, serial, native=False):
        from pymobiledevice3.remote.rsd_tunnel import PreferredRsdTunnel
        from pymobiledevice3.services.dvt.instruments.dvt_provider import DvtProvider
        from pymobiledevice3.services.dvt.instruments.location_simulation import LocationSimulation
        stack = AsyncExitStack()
        try:
            rsd = await stack.enter_async_context(PreferredRsdTunnel(serial=serial, prefer_native=native))
            dvt = await stack.enter_async_context(DvtProvider(rsd))
            self.location = await stack.enter_async_context(LocationSimulation(dvt))
            self.stack = stack
        except BaseException:
            self.location = None
            await stack.aclose()
            raise

    async def set(self, p):
        await self.location.set(*p)

    async def clear(self):
        if self.location is None:
            raise RuntimeError("定位连接未建立，请重新连接后恢复定位。")
        await self.location.clear()

    async def close(self):
        if self.stack:
            try:
                await self.stack.aclose()
            finally:
                self.stack = None
                self.location = None


class DemoAdapter:
    """Explicit preview adapter. Never imports pymobiledevice3 or talks to a phone."""
    async def devices(self):
        return [{"id": "demo-only", "name": "演示设备（非真实手机）", "ios": "27.1 · 演示", "paired": True}]

    async def prepare(self, serial):
        pass

    async def connect(self, serial, native=False):
        pass

    async def set(self, p):
        pass

    async def clear(self):
        pass

    async def close(self):
        pass


class Engine:
    def __init__(self, demo=False, adapter=None, clock=time.monotonic):
        self.demo = demo
        self.adapter = adapter or (DemoAdapter() if demo else DeviceAdapter())
        self.clock = clock
        self.lock = asyncio.Lock()
        self.state = "disconnected"
        self.message = "先用数据线连接 iPhone，然后刷新设备。"
        self.device = None
        self.connected = False
        self.position = None
        self.dirty = False
        self.route = None
        self.traveled = 0.0
        self.speed = 6.0
        self.motion = MotionSettings()
        self.profile = SpeedProfile(self.motion)
        self.profile_time = 0.0
        self.elapsed_moving = 0.0
        self.last_tick = self.clock()
        self.logs = []
        self.ticker = None
        self.closed = False

    def log(self, message):
        self.logs.append({"time": time.strftime("%H:%M:%S"), "text": str(message)[:1600]})
        self.logs = self.logs[-60:]

    def snapshot(self):
        current_speed = self.profile.speed_at(self.profile_time) if self.state == "moving" else 0.0
        return {"demo": self.demo, "state": self.state, "message": self.message,
                "device": self.device, "connected": self.connected, "position": self.position,
                "distance": round(self.traveled, 1), "total": round(self.route.length, 1) if self.route else 0,
                "speed": self.speed, "logs": self.logs[:], "dependency": dependency_info(),
                "motion": self.motion.as_dict(), "current_speed": round(current_speed, 3),
                "current_pace_seconds": 3600/current_speed if current_speed else None,
                "average_pace_seconds": 1000*self.elapsed_moving/self.traveled if self.traveled else None,
                "elapsed_moving": round(self.elapsed_moving, 2),
                "recovery_needed": self.dirty, "platform": platform.system()}

    async def start(self):
        self.ticker = asyncio.create_task(self._run())

    def require_connection(self):
        if not self.connected:
            raise ValueError("请先连接 iPhone。")

    async def dispatch(self, action, data):
        if not isinstance(data, dict):
            raise ValueError("请求内容应为对象")
        async with self.lock:
            if self.closed:
                raise ValueError("程序正在退出")
            try:
                return await self._dispatch(action, data)
            except ValueError:
                raise
            except Exception as exc:
                self.state = "error"
                self.message = friendly_error(exc)
                self.log(self.message)
                raise RuntimeError(self.message) from None

    async def _dispatch(self, action, data):
        if action == "devices":
            return {"devices": await asyncio.wait_for(self.adapter.devices(), timeout=20)}
        if action == "connect":
            if (self.connected or self.dirty) and self.state != "error":
                raise ValueError("请先恢复真实定位并断开当前设备。")
            serial = data.get("device")
            if self.dirty and self.device and self.device["id"] != serial:
                raise ValueError("之前的设备仍需恢复定位，请先插回并连接原设备。")
            devices = await asyncio.wait_for(self.adapter.devices(), timeout=20)
            chosen = next((d for d in devices if d["id"] == serial), None)
            if not chosen:
                raise ValueError("所选 USB 设备已断开，请刷新后重试。")
            native = data.get("native", False)
            if not isinstance(native, bool):
                raise ValueError("连接模式无效")
            if native and platform.system() != "Darwin" and not self.demo:
                raise ValueError("原生隧道仅适用于 Mac")
            self.device = chosen
            self.state = "connecting"
            self.message = "正在准备开发者组件并建立连接，首次可能需要几分钟。"
            self.log(self.message)
            try:
                await self.adapter.close()
                self.connected = False
                await self.adapter.prepare(serial)
                self.message = "开发者组件已准备，正在建立定位服务连接。"
                self.log(self.message)
                await asyncio.wait_for(self.adapter.connect(serial, native=native), timeout=90)
                self.connected = True
                if self.dirty:
                    await self._recover()
            except BaseException:
                await self.adapter.close()
                self.connected = False
                raise
            self.state = "ready"
            self.message = "连接已建立。选点后点击应用定位，再在手机地图中确认效果。"
            self.log("连接已建立；尚未发送模拟坐标。")
        elif action == "set":
            self.require_connection()
            p = point(data.get("point"))
            await self._send(p)
            self.route = None
            self.traveled = 0.0
            self.state = "holding"
            self.message = "坐标指令已发送，请在 iPhone 地图中确认位置是否移动。"
        elif action == "route":
            self.require_connection()
            route = Route.build(data.get("points"), data.get("closed", False), data.get("laps", 1))
            settings = MotionSettings.parse(data["motion"] if "motion" in data else {"mode": "speed", "speed": data.get("speed", 6)})
            await self._send(route.points[0])
            self.route = route
            self._set_motion(settings)
            self.traveled = 0.0
            self.elapsed_moving = 0.0
            self.last_tick = self.clock()
            self.state = "moving"
            self.message = "正在按路线发送坐标。电脑上的进度代表已发送的路线进度。"
            label = f"目标配速 {settings.pace_seconds/60:g} 分/公里" if settings.mode == "pace" else f"{settings.speed:g} km/h"
            self.log(f"路线已开始：{route.length:.1f} 米，{label}" + (f"，平滑随机变速 ±{settings.variation_percent:g}%。" if settings.randomize else "。"))
        elif action == "pause":
            if self.state != "moving":
                raise ValueError("当前没有正在移动的路线")
            await self._tick()
            if self.state != "moving":
                return self.snapshot()
            self.state = "paused"
            self.message = "路线已暂停，保持最后发送的位置。"
        elif action == "resume":
            if self.state != "paused":
                raise ValueError("当前没有暂停的路线")
            self.last_tick = self.clock()
            self.state = "moving"
            self.message = "路线已继续。"
        elif action == "speed":
            settings = MotionSettings.parse({"mode": "speed", "speed": data.get("speed")})
            # Settle elapsed movement at the previous speed before changing speed.
            if self.state == "moving":
                await self._tick()
            self._set_motion(settings)
        elif action == "motion":
            settings = MotionSettings.parse(data)
            if self.state == "moving":
                await self._tick()
            self._set_motion(settings)
            self.log("移动设置已更新。")
        elif action == "nudge":
            self.require_connection()
            if self.position is None:
                raise ValueError("请先应用一个定位点。")
            meters = number(data.get("meters", 10), 0.1, 200, "移动距离（米）")
            bearing = number(data.get("bearing"), 0, 360, "方向")
            await self._send(destination(self.position, bearing, meters))
            self.route = None
            self.traveled = 0.0
            self.state = "holding"
            self.message = "手动移动指令已发送。"
        elif action in ("clear", "disconnect"):
            await self._recover(force=True)
            if action == "disconnect":
                await self.adapter.close()
                self.connected = False
                self.device = None
                self.state = "disconnected"
                self.message = "设备连接已断开。"
        else:
            raise ValueError("未知操作")
        return self.snapshot()

    def _set_motion(self, settings):
        self.motion = settings
        self.speed = settings.speed
        self.profile = SpeedProfile(settings)
        self.profile_time = 0.0
        self.last_tick = self.clock()

    async def _send(self, p):
        # A timed-out RPC might still have reached iOS: retain recovery state.
        self.dirty = True
        await asyncio.wait_for(self.adapter.set(p), timeout=12)
        self.position = p

    async def _recover(self, force=False):
        if self.dirty or (force and self.connected):
            self.require_connection()
            self.dirty = True
            await asyncio.wait_for(self.adapter.clear(), timeout=15)
        self.dirty = False
        self.position = None
        self.route = None
        self.traveled = 0.0
        self.elapsed_moving = 0.0
        self.profile_time = 0.0
        self.state = "ready" if self.connected else "disconnected"
        self.message = "已发送停止模拟指令，请在手机地图中确认真实定位。"
        self.log(self.message)

    async def _tick(self):
        if not self.connected or self.state not in ("moving", "paused", "holding"):
            return
        now = self.clock()
        if self.state == "moving":
            duration = max(0, now-self.last_tick)
            remaining = self.route.length-self.traveled
            increment = self.profile.distance_between(self.profile_time, self.profile_time+duration)
            if increment >= remaining:
                duration = self.profile.time_for_distance(self.profile_time, remaining, duration)
                advanced = self.route.length
            else:
                advanced = self.traveled+increment
            await self._send(self.route.at(advanced))
            self.traveled = advanced
            self.profile_time += duration
            self.elapsed_moving += duration
            self.last_tick = now
            if self.traveled >= self.route.length:
                self.state = "holding"
                self.message = "路线发送完成，保持终点。点击“恢复真实定位”结束模拟。"
                self.log("路线发送完成。")
        elif self.position is not None:
            await self._send(self.position)

    async def _run(self):
        while not self.closed:
            await asyncio.sleep(0.5)
            async with self.lock:
                try:
                    await self._tick()
                except Exception as exc:
                    self.state = "error"
                    self.message = friendly_error(exc) + " 如曾发送坐标，请重新连接数据线后点击恢复真实定位。"
                    self.log(self.message)

    async def shutdown(self):
        async with self.lock:
            try:
                await self._recover(force=True)
            except Exception as exc:
                self.state = "error"
                self.message = "未能确认停止模拟：" + friendly_error(exc) + "。请重新连接并恢复，必要时重启 iPhone。"
                self.log(self.message)
                raise RuntimeError(self.message) from None
            await self.adapter.close()
            self.connected = False
            self.closed = True
            if self.ticker:
                self.ticker.cancel()
                await asyncio.gather(self.ticker, return_exceptions=True)
