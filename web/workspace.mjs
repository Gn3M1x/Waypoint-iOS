// SPDX-License-Identifier: GPL-3.0-or-later
import {normaliseMotion, formatPace} from './motion.mjs';

export function motionKey(value) {
  const m = normaliseMotion(value);
  return JSON.stringify([m.mode, m.mode==='pace'?m.pace_seconds:m.speed,
    m.randomize, m.variation_percent, m.drift_enabled, m.drift_radius_meters]);
}
export function motionSummary(m) {
  const speed = m.mode==='pace'?formatPace(m.pace_seconds):`${Number(m.speed.toFixed(2))} km/h`;
  return `${speed} · ${m.randomize?'随机变速 ±'+m.variation_percent+'%':'匀速'} · ${m.drift_enabled?'偏移 ≤'+m.drift_radius_meters+' 米':'偏移关闭'}`;
}
export function motionChanges(before, after) {
  const changes = [];
  if (before.mode!==after.mode || Math.abs(before.speed-after.speed)>0.00001)
    changes.push(`移动：${before.mode==='pace'?formatPace(before.pace_seconds):before.speed+' km/h'} → ${after.mode==='pace'?formatPace(after.pace_seconds):after.speed+' km/h'}`);
  if (before.randomize!==after.randomize || before.variation_percent!==after.variation_percent)
    changes.push(`变速：${before.randomize?'±'+before.variation_percent+'%':'关闭'} → ${after.randomize?'±'+after.variation_percent+'%':'关闭'}`);
  if (before.drift_enabled!==after.drift_enabled || before.drift_radius_meters!==after.drift_radius_meters)
    changes.push(`偏移：${before.drift_enabled?before.drift_radius_meters+' 米':'关闭'} → ${after.drift_enabled?after.drift_radius_meters+' 米':'关闭'}`);
  return changes.join('；');
}
export function sameGeometry(a, b) {
  return !!a && !!b && a.closed===b.closed && a.laps===b.laps && JSON.stringify(a.points)===JSON.stringify(b.points);
}
export function durationLabel(seconds) {
  if (!Number.isFinite(seconds) || seconds<0) return '—';
  const n=Math.ceil(seconds);
  return `${Math.floor(n/60)} 分 ${n%60} 秒`;
}
export function primaryControl(s, mode, {online=true, hasDevice=false, validRoute=false, validPoint=false}={}) {
  if (!online) return {action:null,label:'控制台离线',hint:'请确认启动窗口仍在运行。重新连接后会同步运行状态。'};
  if (s?.state==='error' && s.connected) return {action:'clear',label:'恢复真实定位',hint:s.message};
  if (!s?.connected) return {action:hasDevice?'connect':null,label:hasDevice?'连接设备':'等待设备',hint:hasDevice?'设备已发现，连接后即可开始模拟。':'请连接并解锁 iPhone，再刷新设备列表。'};
  if (s.state==='moving') return {action:'pause',label:'暂停',hint:'路线正在播放。编辑草稿不会改变正在执行的路线。'};
  if (s.state==='paused') return {action:'resume',label:'继续',hint:'已暂停，设备保持当前位置。'};
  if (s.state==='holding' && s.route_id) return {action:'clear',label:'结束并恢复定位',hint:'路线已完成，设备保持终点。结束模拟后恢复真实定位。'};
  if (mode==='browse') return {action:'edit-route',label:'绘制路线',hint:'拖动地图查看，选择单点定位或路线模拟开始编辑。'};
  if (mode==='point') return {action:validPoint?'set':null,label:s.position?'更新此位置':'应用此位置',hint:validPoint?'确认地图上的选中位置，再应用到设备。':'请在地图选点，或填写有效坐标。'};
  return {action:validRoute?'route':null,label:validRoute?'开始模拟':'添加路径点',hint:validRoute?'开始时将使用当前路线草稿和移动设置。':'请添加至少两个不同的路径点，并检查圈数与移动设置。'};
}
