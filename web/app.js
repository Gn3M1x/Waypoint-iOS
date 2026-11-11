'use strict';
import {fromMapCoordinate} from './map-coordinates.mjs';
import {EditorMap, History} from './editor-map.mjs';
import {normaliseMotion, formatPace, RunningMarker} from './motion.mjs';
const $ = id => document.getElementById(id);
const TOKEN_KEY = 'waypoint-token';
const fromFragment = new URLSearchParams(location.hash.slice(1)).get('token');
if (fromFragment) { sessionStorage.setItem(TOKEN_KEY, fromFragment); history.replaceState(null, '', '/'); }
const token = fromFragment || sessionStorage.getItem(TOKEN_KEY) || '';
let points = [], selected = [38.0, 114.52], mode = 'browse', status = null, busy = false, exiting = false;
let activeAction=null, pollGeneration=0;
let motionMode='pace', searchBusy=false, searchGeneration=0;
let selectedLabel='', favoriteKind='address', favoriteTrash=false, favoriteItems=[], favoritePending=null, favoriteBusy=false, favoriteGeneration=0, previousDraft=null;
const edits = new History();
const runner = new RunningMarker($('runner-marker'));
$('runner-toggle').checked = !matchMedia('(prefers-reduced-motion: reduce)').matches;
function syncRunner() {
  runner.update(status, $('runner-toggle').checked);
  if (map.width) runner.place(map);
}
$('runner-toggle').onchange = syncRunner;
let index = -1;
const names = {disconnected:'未连接', connecting:'连接中', ready:'已就绪', holding:'保持位置', moving:'路线移动中', paused:'已暂停', error:'需要处理'};
function toast(text) { $('toast').textContent = text; $('toast').hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => $('toast').hidden = true, 12000); }
async function api(action, body) {
  const response = await fetch('/api/' + action, {method:body === undefined ? 'GET' : 'POST', headers:{'Authorization':'Bearer ' + token, ...(body === undefined ? {} : {'Content-Type':'application/json'})}, body:body === undefined ? undefined : JSON.stringify(body)});
  const result = await response.json();
  if (!response.ok) throw Error(result.error || '操作失败');
  return result;
}
async function act(action, body = {}) {
  if (busy || exiting) return null;
  busy = true; activeAction=action; ++pollGeneration; renderControls();
  try { const result = await api(action, body); if (action === 'route') runner.stop(); if (result.state) renderStatus(result); return result; }
  catch (error) { toast(error.message); return null; }
  finally { activeAction=null; busy=false; await poll(); renderControls(); }
}
function renderControls() {
  const connected = Boolean(status?.connected), state = status?.state;
  for (const id of ['connect','refresh','disconnect','apply','pause','restore','north','south','east','west','exit','apply-motion']) $(id).disabled = busy || exiting;
  $('refresh').textContent = activeAction === 'devices' ? '…' : '↻';
  $('apply-motion').disabled ||= !connected;
  $('connect').disabled ||= !($('devices').value) || (connected && state !== 'error');
  $('disconnect').disabled ||= !connected;
  $('apply').disabled ||= !connected || mode === 'browse' || (mode === 'route' && points.length < 2);
  $('pause').disabled ||= !['moving','paused'].includes(state);
  $('restore').disabled ||= !connected;
  for (const id of ['north','south','east','west']) $(id).disabled ||= !connected || !status?.position;
  $('apply').textContent = mode === 'route' ? '开始路线移动' : '应用编辑位置';
  $('pause').textContent = state === 'paused' ? '继续' : '暂停';
  $('connect').textContent = activeAction === 'connect' ? '正在连接…' : state === 'error' && connected ? '重新连接' : connected ? '已连接' : '准备并连接';
  $('undo').disabled = mode !== 'route' || !edits.past.length;
  $('redo').disabled = mode !== 'route' || !edits.future.length;
  $('delete-point').disabled = mode !== 'route' || index < 0;
  $('clear-route').disabled = mode !== 'route' || !points.length;
  $('export').disabled = points.length < 2;
  $('laps').disabled = !$('closed').checked;
  $('save-route-favorite').disabled = points.length<2;
}
function renderStatus(s) {
  const moved = String(status?.position ?? '') !== String(s.position ?? '');
  status = s;
  $('sent-position').textContent = s.position ? s.position.map(v=>v.toFixed(5)).join(', ') : '尚未发送';
  document.body.classList.toggle('demo-mode',s.demo);
  document.querySelector('.compatibility').textContent = s.device ? 'iOS '+s.device.ios+' · 定位效果待确认' : 'iPhone · 定位效果待验证';
  $('demo-banner').hidden = $('runner-option').hidden = !s.demo;
  syncRunner();
  $('connection-pill').textContent = s.demo ? '演示模式' : s.connected ? 'USB 已连接' : '未连接';
  $('connection-pill').classList.toggle('connected', s.connected);
  $('state-label').textContent = names[s.state] || s.state;
  $('status-title').textContent = busy && s.state === 'connecting' ? '正在连接 iPhone' : names[s.state] || '设备状态';
  $('status-text').textContent = s.message;
  $('status-dot').className = 'status-dot' + (s.state === 'error' ? ' error' : s.connected ? ' ok' : '');
  $('device-info').textContent = s.device ? `${s.device.name} · iOS ${s.device.ios}` : !s.dependency.available && !s.demo ? '定位组件未安装。请通过附带的启动程序安装。' : '实际定位效果需在手机地图中确认。';
  $('sent-distance').replaceChildren(document.createTextNode(s.distance.toFixed(1) + ' '), Object.assign(document.createElement('small'),{textContent:'米'}));
  $('logs').textContent = s.logs.map(l => `[${l.time}] ${l.text}`).join('\n') || '尚无记录。';
  $('log-count').textContent = s.logs.length;
  const current=s.current_pace_seconds;
  $('current-pace').textContent = s.state==='moving' && current ? `${formatPace(current)} · ${s.current_speed.toFixed(1)} km/h` : s.state==='paused'?'已暂停':'当前未移动';
  $('average-pace').textContent = s.average_pace_seconds ? `已发送路线平均配速 ${formatPace(s.average_pace_seconds)}` : '平均配速会在路线开始后显示。';
  $('drift-status').textContent = s.route_position
    ? `已发送偏移 ${(s.drift_distance??0).toFixed(2)} 米 · ${s.state==='paused'?'已冻结':s.state==='holding'?'已到终点':s.motion.drift_enabled?'已启用':s.drift_distance>0?'收回中':'已关闭'}（相对理想路线）`
    : '开始路线后显示已发送偏移。';
  renderControls(); if (moved) map.draw();
}
async function poll() {
  if (exiting || busy) return;
  const generation = ++pollGeneration;
  try {
    const snapshot = await api('status');
    if (generation === pollGeneration && !exiting) renderStatus(snapshot);
  }
  catch (e) { if(generation !== pollGeneration)return; runner.stop(); $('runner-option').hidden=true; $('connection-pill').textContent='控制台离线'; $('status-text').textContent = token ? '无法连接本机控制程序。请确认启动窗口仍在运行。' : '请通过附带的启动程序打开控制台。'; }
}
function setCoordinates(p, label = '') {
  selected = p;
  selectedLabel = label;
  $('lat').value = p[0].toFixed(6);
  $('lon').value = p[1].toFixed(6);
}
function inputPoint() {
  const p=[$('lat').valueAsNumber,$('lon').valueAsNumber];
  if (p.some(v=>!Number.isFinite(v)) || Math.abs(p[0])>90 || Math.abs(p[1])>180) throw Error('请输入有效的 WGS84 纬度和经度。');
  return p;
}
function geometry() { return {points, index, selected, selectedLabel}; }
function forgetLoad() {
  previousDraft = null;
  $('favorites-undo-load').hidden = true;
}
function replaceGeometry(next, active) {
  edits.record(geometry());
  forgetLoad();
  points = next;
  index = active;
  if (index >= 0) setCoordinates(points[index]);
  updateRoute();
}
function travelHistory(redo) {
  const snapshot = edits.step(geometry(), redo);
  if (!snapshot) return;
  map.cancel();
  points = snapshot.points;
  index = snapshot.index;
  setCoordinates(snapshot.selected, snapshot.selectedLabel);
  updateRoute();
}
function selectPoint(p) {
  if (mode === 'browse') return;
  if (mode === 'route') {
    if (points.length >= 2000) return toast('每条路线最多 2000 个路径点。');
    replaceGeometry([...points, p], points.length);
  } else {
    setCoordinates(p);
    updateRoute();
  }
}
function setMode(next) {
  map.cancel();
  mode = next;
  if (mode === 'route' && points[index]) setCoordinates(points[index]);
  for (const key of ['browse','point','route']) {
    const button = $('mode-' + key);
    button.classList.toggle('active', key === mode);
    button.setAttribute('aria-pressed', String(key === mode));
  }
  $('map').dataset.mode = mode;
  $('edit-hint').textContent = {browse:'拖动平移，缩放可查看街道细节。', point:'点击地图选址，确认后应用编辑位置。',route:'点击空白处加点，拖动节点调整路线。'}[mode];
  $('locate').textContent = mode === 'route' ? '按坐标添加路径点' : '查看坐标位置';
  updateRoute();
}
function haversine(a,b) { const r = Math.PI/180, dlat=(b[0]-a[0])*r,dlon=(b[1]-a[1])*r;return 6371008.8*2*Math.asin(Math.sqrt(Math.min(1,Math.sin(dlat/2)**2+Math.cos(a[0]*r)*Math.cos(b[0]*r)*Math.sin(dlon/2)**2))); }
function routeLength() { let n=0; for(let i=1;i<points.length;i++) n+=haversine(points[i-1],points[i]); if($('closed').checked && points.length>1) n+=haversine(points.at(-1),points[0]); return n*($('closed').checked ? Math.max(1,Number($('laps').value)||1) : 1); }
function readMotionUI() {
  const paceMinutes=$('pace-minutes').value,paceSeconds=$('pace-seconds').value;
  if(motionMode==='pace'&&(!paceMinutes||paceSeconds===''||!Number.isInteger(Number(paceMinutes))||!Number.isInteger(Number(paceSeconds))||Number(paceSeconds)<0||Number(paceSeconds)>59))throw Error('配速请填写整数分钟和 0–59 秒。');
  return normaliseMotion({mode:motionMode,speed:Number($('speed').value),pace_seconds:Number(paceMinutes)*60+Number(paceSeconds),randomize:$('pace-random').checked,variation_percent:Number($('pace-variation').value),drift_enabled:$('drift-enabled').checked,drift_radius_meters:Number($('drift-radius').value)});
}
function setMotionMode(next) {
  motionMode=next;
  $('motion-speed').classList.toggle('active',next==='speed');$('motion-pace').classList.toggle('active',next==='pace');
  $('speed-controls').hidden=next!=='speed';$('pace-controls').hidden=next!=='pace';
  updateRoute();
}
function applyImportedMotion(value) {
  const motion=normaliseMotion(value);
  $('speed').value=Math.max(0.5,Math.min(30,motion.speed));
  const rounded=Math.round(motion.pace_seconds);
  $('pace-minutes').value=Math.floor(rounded/60);$('pace-seconds').value=rounded%60;
  $('pace-random').checked=motion.randomize;$('pace-variation').value=motion.variation_percent;
  $('drift-enabled').checked=motion.drift_enabled;$('drift-radius').value=motion.drift_radius_meters;
  setMotionMode(motion.mode);
}
function updateRoute() {
  $('point-count').textContent = points.length;
  $('selection-label').textContent = mode === 'route' && index >= 0 ? '路径点 ' + (index + 1) : '编辑位置';
  const meters=routeLength();let seconds=null;
  try {seconds=meters/(readMotionUI().speed/3.6);} catch {}
  $('route-distance').replaceChildren(document.createTextNode(meters.toFixed(1)+' '),Object.assign(document.createElement('small'),{textContent:'米'}));
  $('route-time').textContent=meters&&seconds!==null ? `${Math.floor(Math.round(seconds)/60)}:${String(Math.round(seconds)%60).padStart(2,'0')}` : '—';
  $('speed-label').textContent=$('speed').value+' km/h';
  $('variation-label').textContent=`±${$('pace-variation').value}%`;
  $('pace-variation').disabled=!$('pace-random').checked;
  $('drift-radius-label').textContent=`${$('drift-radius').value} 米`;
  $('drift-radius').disabled=!$('drift-enabled').checked;
  renderControls(); map.draw();
}

const map = new EditorMap($('map'), $('basemap'), {
  scene: () => ({points, mode, selected, index: mode === 'route' ? index : -1, sent:status?.position, closed:$('closed').checked}),
  select(i) { index = i; setCoordinates(points[i]); updateRoute(); },
  move(i, p) { const next = points.slice(); next[i] = p; replaceGeometry(next, i); },
  pick: selectPoint,
  scrollZoom: () => $('scroll-mode').value === 'zoom',
  source(key, config) {
    $('map-source').value = key;
    $('map-attribution').textContent = config.attribution;
    $('map-attribution').href = config.attributionUrl;
  },
  tiles(loaded, total, failed) {
    Object.assign($('map').dataset, {loadedTiles:loaded, totalTiles:total, failedTiles:failed});
    $('map-loading').hidden = total > 0 && total === loaded;
    $('tile-message').textContent = failed ? '部分底图未加载' : '正在加载底图…';
    $('retry-tiles').hidden = !failed;
  },
  view(zoom, center) {
    runner.place(map);
    $('map-view').textContent = 'Z' + zoom.toFixed(1) + '  ·  ' + center.map(v=>v.toFixed(5)).join(', ');
  }
});
if (/Mac/.test(navigator.platform)) $('scroll-mode').value = 'pan';
function routeDocument() {
  if(points.length<2)throw Error('请先在地图上画一条路线，至少添加两个路径点。');
  const motion=readMotionUI();
  return {version:1,coordinateSystem:'WGS84',points:structuredClone(points),speed:motion.speed,motion,closed:$('closed').checked,laps:$('closed').checked?Number($('laps').value):1};
}
function editorSnapshot() {
  const fields={};
  for(const id of ['speed','pace-minutes','pace-seconds','pace-random','pace-variation','drift-enabled','drift-radius'])fields[id]=$(id).type==='checkbox'?$(id).checked:$(id).value;
  return {index,points:structuredClone(points),selected:[...selected],selectedLabel,mode,motionMode,fields,closed:$('closed').checked,laps:$('laps').value,center:[...map.center],zoom:map.zoom};
}
function restoreEditor(draft) {
  map.cancel(); edits.reset(); index=draft.index;
  points=structuredClone(draft.points);selected=[...draft.selected];selectedLabel=draft.selectedLabel;
  $('lat').value=selected[0].toFixed(6);$('lon').value=selected[1].toFixed(6);
  $('closed').checked=draft.closed;$('laps').value=draft.laps;
  for(const[id,value]of Object.entries(draft.fields)){if($(id).type==='checkbox')$(id).checked=value;else $(id).value=value;}
  setMotionMode(draft.motionMode);setMode(draft.mode);map.center=[...draft.center];map.zoom=draft.zoom;map.draw();
}
function installRouteDocument(data) {
  if(data?.coordinateSystem!=='WGS84'||data.version!==1)throw Error('路线文件格式无效。');
  const incoming=data.points;
  if(!Array.isArray(incoming)||incoming.length<2||incoming.length>2000||incoming.some(p=>!Array.isArray(p)||p.length!==2||p.some(v=>typeof v!=='number'||!Number.isFinite(v))||Math.abs(p[0])>90||Math.abs(p[1])>180))throw Error('收藏路线包含无效坐标。');
  const motion=normaliseMotion(data.motion??{mode:'speed',speed:data.speed??6});
  if(typeof data.closed!=='boolean'||!Number.isInteger(data.laps)||data.laps<1||data.laps>100)throw Error('收藏路线参数无效。');
  map.cancel(); edits.reset(); index=incoming.length-1;
  points=structuredClone(incoming);selected=[...points.at(-1)];selectedLabel='';
  $('lat').value=selected[0].toFixed(6);$('lon').value=selected[1].toFixed(6);
  $('closed').checked=data.closed;$('laps').value=data.laps;
  applyImportedMotion(motion);setMode('route');map.fit();
}
function favoriteSummary(item) {
  const s=item.summary;
  if(item.kind==='address')return `${s.point[0].toFixed(6)}, ${s.point[1].toFixed(6)} · WGS84`;
  const length=s.distance>=1000?`${(s.distance/1000).toFixed(2)} km`:`${s.distance.toFixed(1)} 米`;
  const motion=s.motion.mode==='pace'?formatPace(s.motion.pace_seconds):`${s.motion.speed} km/h`;
  return `${length} · ${s.points} 个点 · ${motion}${s.motion.randomize?` · 波动 ±${s.motion.variation_percent}%`:''}${s.motion.drift_enabled?` · 偏移 ≤${s.motion.drift_radius_meters} 米`:''} · ${s.laps} 圈`;
}
function cancelFavoriteForm() {favoritePending=null;$('favorite-name-form').hidden=true;}
function renderFavorites() {
  $('favorites-address-tab').classList.toggle('active',favoriteKind==='address');
  $('favorites-route-tab').classList.toggle('active',favoriteKind==='route');
  const addressCount=favoriteItems.filter(x=>x.kind==='address').length,routeCount=favoriteItems.filter(x=>x.kind==='route').length;
  $('favorites-count').textContent=`${addressCount} 个地址 · ${routeCount} 条路线${favoriteTrash?' · 回收站':''}`;
  const term=$('favorites-filter').value.trim().toLocaleLowerCase();
  const items=favoriteItems.filter(x=>x.kind===favoriteKind&&x.name.toLocaleLowerCase().includes(term));
  $('favorites-list').replaceChildren();
  if(!items.length){const empty=document.createElement('div');empty.className='favorites-empty';empty.textContent=favoriteTrash?'回收站中没有匹配的收藏。':term?'没有匹配的收藏。':favoriteKind==='address'?'还没有收藏地址。选点后点击“收藏地址”。':'还没有收藏路线。编辑后点击“收藏路线”。';$('favorites-list').append(empty);}
  for(const item of items){
    const row=document.createElement('div');row.className='favorite-item';
    const info=document.createElement('div');info.className='favorite-info';
    const name=document.createElement('strong'),detail=document.createElement('small');name.textContent=item.name;detail.textContent=favoriteSummary(item);info.append(name,detail);
    const actions=document.createElement('div');actions.className='favorite-actions';
    const button=(label,action,primary=false)=>{const b=document.createElement('button');b.type='button';b.textContent=label;if(primary)b.className='favorite-load';b.onclick=action;actions.append(b);};
    if(!favoriteTrash)button(item.kind==='address'?'定位地图':'载入路线',()=>loadFavorite(item),true);
    button('改名',()=>openFavoriteForm({action:'rename',kind:item.kind,id:item.id,revision:item.revision},item.name,favoriteSummary(item)));
    button(favoriteTrash?'恢复':'移入回收站',()=>changeFavorite(favoriteTrash?'restore':'delete',item));
    row.append(info,actions);$('favorites-list').append(row);
  }
}
async function refreshFavorites() {
  const generation=++favoriteGeneration;
  $('favorites-list').setAttribute('aria-busy','true'); $('favorites-loading').hidden=false;
  try{const data=await api(`favorites${favoriteTrash?'?trash=1':''}`);if(generation!==favoriteGeneration)return;favoriteItems=data.favorites;renderFavorites();}
  catch(e){if(generation===favoriteGeneration)$('favorites-notice').textContent=e.message;}
  finally{if(generation===favoriteGeneration){$('favorites-list').removeAttribute('aria-busy');$('favorites-loading').hidden=true;}}
}
async function showFavorites(kind=favoriteKind) {
  closeSearch();favoriteKind=kind;$('favorites-panel').hidden=false;
  await refreshFavorites();
}
function openFavoriteForm(pending,name,preview) {
  closeSearch();favoritePending=pending;favoriteKind=pending.kind;$('favorites-panel').hidden=false;
  if(pending.action==='save'){favoriteTrash=false;$('favorites-trash').checked=false;}
  $('favorite-name-form').hidden=false;$('favorite-form-label').textContent=pending.action==='rename'?'修改收藏名称':pending.kind==='address'?'收藏当前地址':'收藏当前路线与移动设置';
  $('favorite-name').value=name;$('favorite-preview').textContent=preview;
  $('favorite-name').focus();refreshFavorites();
}
async function loadFavorite(item) {
  try{
    const data=await api('favorites/item?id='+encodeURIComponent(item.id));const value=data.favorite;
    if(value.deleted)throw Error('该收藏已在回收站中，请先恢复。');
    const draft=editorSnapshot();
    if(value.kind==='route')installRouteDocument(value.payload);
    else{selected=[...value.payload.point];selectedLabel=value.name;$('lat').value=selected[0].toFixed(6);$('lon').value=selected[1].toFixed(6);setMode('point');map.center=[...selected];map.zoom=value.payload.zoom;map.draw();}
    previousDraft=draft;$('favorites-undo-load').hidden=false;
    cancelFavoriteForm();$('favorites-notice').textContent=`已载入“${value.name}”${value.kind==='route'?'及其配速、随机变速、偏移和圈数。点击“开始路线移动”即可播放。':'，可继续编辑。'}`;
  }catch(e){toast(e.message);}
}
async function changeFavorite(action,item) {
  if(favoriteBusy)return;favoriteBusy=true;
  try{await api('favorites/'+action,{id:item.id,expected_revision:item.revision});$('favorites-notice').textContent=action==='delete'?'已移入回收站，可在回收站中恢复。':'已恢复收藏。';await refreshFavorites();}
  catch(e){toast(e.message);await refreshFavorites();}finally{favoriteBusy=false;}
}
$('open-favorites').onclick=()=>{cancelFavoriteForm();showFavorites();};
$('favorites-close').onclick=()=>{cancelFavoriteForm();$('favorites-panel').hidden=true;};
$('favorites-address-tab').onclick=()=>{cancelFavoriteForm();showFavorites('address');};
$('favorites-route-tab').onclick=()=>{cancelFavoriteForm();showFavorites('route');};
$('favorites-refresh').onclick=refreshFavorites;
$('favorites-filter').oninput=renderFavorites;
$('favorites-trash').onchange=e=>{cancelFavoriteForm();favoriteTrash=e.target.checked;refreshFavorites();};
$('favorite-cancel').onclick=cancelFavoriteForm;
$('favorites-undo-load').onclick=()=>{if(previousDraft){restoreEditor(previousDraft);previousDraft=null;$('favorites-undo-load').hidden=true;$('favorites-notice').textContent='已恢复载入前的编辑内容。';}};
for(const id of ['lat','lon'])$(id).addEventListener('input',()=>{
  selectedLabel='';
  if(mode==='route') {index=-1; $('selection-label').textContent='编辑位置'; renderControls();}
  if(mode==='point') {try {selected=inputPoint();} catch {}}
  map.draw();
});
$('save-address-favorite').onclick=()=>{
  try{const p=inputPoint();openFavoriteForm({action:'save',kind:'address',payload:{version:1,coordinateSystem:'WGS84',point:p,zoom:Math.round(map.zoom)}},selectedLabel||`地址 ${p[0].toFixed(5)}, ${p[1].toFixed(5)}`,`将保存 ${p[0].toFixed(6)}, ${p[1].toFixed(6)}（WGS84）。`);}catch(e){toast(e.message);}
};
$('save-route-favorite').onclick=()=>{
  try{const payload=routeDocument();const stamp=new Date().toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});openFavoriteForm({action:'save',kind:'route',payload},`路线 ${stamp}`,`${points.length} 个路径点 · ${$('route-distance').textContent} · ${formatPace(payload.motion.pace_seconds)} · ${payload.laps} 圈`);}catch(e){toast(e.message);}
};
$('favorite-name-form').onsubmit=async e=>{
  e.preventDefault();if(favoriteBusy||!favoritePending)return;
  favoriteBusy=true;$('favorite-submit').disabled=true;
  const pending=favoritePending;
  try{
    const body=pending.action==='rename'?{id:pending.id,expected_revision:pending.revision,name:$('favorite-name').value}:{kind:pending.kind,name:$('favorite-name').value,payload:pending.payload};
    await api('favorites/'+pending.action,body);cancelFavoriteForm();$('favorites-filter').value='';$('favorites-notice').textContent='收藏已保存到电脑，关闭程序后仍可载入。';await refreshFavorites();
  }catch(e){$('favorites-notice').textContent=e.message;}
  finally{favoriteBusy=false;$('favorite-submit').disabled=false;}
};
$('motion-speed').onclick=()=>setMotionMode('speed');$('motion-pace').onclick=()=>setMotionMode('pace');
for(const id of ['pace-minutes','pace-seconds','pace-random','pace-variation','drift-enabled','drift-radius'])$(id).addEventListener('input',updateRoute);
$('apply-motion').onclick=()=>{try{act('motion',readMotionUI());}catch(e){toast(e.message);}};
$('map-source').onchange=e=>map.setSource(e.target.value);
$('retry-tiles').onclick=()=>map.retryTiles();
function focusSearchResult(result, coordinateSystem, attribution) {
  selectedLabel=result.name;
  selected=coordinateSystem==='GCJ02'?fromMapCoordinate(result.point,'amap'):[...result.point];
  $('lat').value=selected[0].toFixed(6);$('lon').value=selected[1].toFixed(6);
  map.center=[...selected];map.zoom=16;
  if(result.bounds){const [south,north,west,east]=result.bounds;map.fit([[south,west],[north,east]]);}
  if(mode==='browse')setMode('point');
  if(mode==='route')index=-1;
  closeSearch();
  // Searching never appends a waypoint or sends a position to the phone.
  $('place-results').hidden=true;
  $('place-search-status').textContent=`已定位到“${result.name}”。${mode==='route'?'点击地图继续添加路径点。':'可点击应用选中位置。'} ${attribution}`;
  toast('已定位到“'+result.name+'”'); updateRoute();
}
$('place-search-form').onsubmit=async e=>{
  e.preventDefault();if(searchBusy)return;
  const query=$('place-query').value.trim();if(!query)return toast('请先输入要搜索的地名。');
  const generation=++searchGeneration;searchBusy=true;
  $('place-search-button').disabled=true;$('place-search-button').textContent='搜索中…';
  $('place-results').replaceChildren();$('place-results').hidden=true;
  $('place-search-status').textContent='正在搜索地名，轨迹播放可继续运行…';
  try{
    const data=await api('search',{query});if(generation!==searchGeneration)return;
    const results=data.results??[];
    $('place-search-status').textContent=results.length?`找到 ${results.length} 个结果，点击定位地图。${data.attribution}`:`未找到结果，试试“城市 + 地名”，或在地图上选点后收藏。${data.attribution}`;
    for(const result of results){
      const button=document.createElement('button');button.type='button';
      const name=document.createElement('strong'),address=document.createElement('small');
      name.textContent=result.name;address.textContent=result.address;
      button.append(name,address);button.onclick=()=>focusSearchResult(result,data.coordinate_system,data.attribution);
      $('place-results').append(button);
    }
    $('place-results').hidden=!results.length;
  }catch(error){if(generation===searchGeneration)$('place-search-status').textContent=error.message;}
  finally{searchBusy=false;$('place-search-button').disabled=false;$('place-search-button').textContent='搜索地名';}
};
$('place-search-clear').onclick=()=>{searchGeneration++;$('place-query').value='';$('place-results').replaceChildren();$('place-results').hidden=true;$('place-search-status').textContent='免 Key 搜索对小地名收录有限；可直接在地图选点后收藏。';};
function closeSearch(){ $('search-popup').hidden=true; }
$('open-search').onclick=()=>{ $('favorites-panel').hidden=true; $('search-popup').hidden=false; $('place-query').focus(); };
$('search-close').onclick=closeSearch;
$('mode-browse').onclick=()=>setMode('browse');
$('mode-point').onclick=()=>setMode('point');$('mode-route').onclick=()=>setMode('route');
$('refresh').onclick=async()=>{const r=await act('devices');if(!r)return;const old=$('devices').value;$('devices').replaceChildren();for(const d of r.devices){const option=document.createElement('option');option.value=d.id;option.textContent=`${d.name} · iOS ${d.ios}`;$('devices').append(option);}if(!r.devices.length)$('devices').append(Object.assign(document.createElement('option'),{value:'',textContent:'未找到 USB 设备'}));if(r.devices.some(d=>d.id===old))$('devices').value=old;renderControls();};
$('devices').onchange=renderControls;
$('connect').onclick=()=>act('connect',{device:$('devices').value,native:$('native').checked});
$('disconnect').onclick=()=>act('disconnect');
$('locate').onclick=()=>{
  try {
    const p=inputPoint();
    if(mode==='browse')setMode('point');
    selectPoint(p); map.center=p; map.draw();
  } catch(e){toast(e.message);}
};
$('undo').onclick=()=>travelHistory(false);
$('redo').onclick=()=>travelHistory(true);
$('clear-route').onclick=()=>replaceGeometry([], -1);
$('delete-point').onclick=()=>{
  if(index<0)return;
  const next=points.filter((_,i)=>i!==index);
  replaceGeometry(next, Math.min(index, next.length-1));
};
window.addEventListener('keydown', e=>{
  if(e.key==='Escape'){map.cancel();closeSearch();$('favorites-panel').hidden=true;return;}
  if(mode!=='route'||e.target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])'))return;
  const modifier=e.ctrlKey||e.metaKey, key=e.key.toLowerCase();
  if(modifier && (key==='z'||key==='y')){
    e.preventDefault(); travelHistory(key==='y'||e.shiftKey);
  } else if(!modifier && (key==='delete'||key==='backspace') && index>=0){
    e.preventDefault(); $('delete-point').click();
  }
});
$('apply').onclick=()=>{try{if(mode==='point'){const p=inputPoint();act('set',{point:p});}else act('route',{points,motion:readMotionUI(),closed:$('closed').checked,laps:$('closed').checked?Number($('laps').value):1});}catch(e){toast(e.message);}};
$('pause').onclick=()=>act(status?.state==='paused'?'resume':'pause');$('restore').onclick=()=>act('clear');
$('speed').oninput=updateRoute;
$('closed').onchange=updateRoute;$('laps').oninput=updateRoute;
for(const[id,bearing]of[['north',0],['east',90],['south',180],['west',270]])$(id).onclick=()=>act('nudge',{bearing,meters:10});
$('zoom-in').onclick=()=>map.zoomAt(map.zoom+1);$('zoom-out').onclick=()=>map.zoomAt(map.zoom-1);$('fit').onclick=()=>map.fit();
$('import').onclick=()=>$('route-file').click();
$('route-file').onchange=async e=>{
  try{
    const file=e.target.files[0];if(!file)return;
    if(file.size>1000000)throw Error('路线文件不能超过 1 MB');
    const text=await file.text();let incoming,closed=false,laps=1,importedMotion=null;
    if(file.name.toLowerCase().endsWith('.gpx')){
      if(/<!DOCTYPE|<!ENTITY/i.test(text))throw Error('GPX 不能包含外部实体或文档类型声明');
      const doc=new DOMParser().parseFromString(text,'application/xml');
      if(doc.querySelector('parsererror'))throw Error('GPX 格式无效');
      const segments=doc.getElementsByTagNameNS('*','trkseg'),routes=doc.getElementsByTagNameNS('*','rte');
      if(segments.length+routes.length!==1)throw Error('请导入只含一段轨迹或一条路线的 GPX');
      const container=segments[0]||routes[0],tag=segments.length?'trkpt':'rtept';
      incoming=[...container.getElementsByTagNameNS('*',tag)].map(p=>[p.hasAttribute('lat')?Number(p.getAttribute('lat')):NaN,p.hasAttribute('lon')?Number(p.getAttribute('lon')):NaN]);
    }else{
      const data=JSON.parse(text);
      if(data.coordinateSystem!=='WGS84'||data.version!==1)throw Error('请使用本工具导出的 WGS84 路线文件');
      incoming=data.points;closed=data.closed??false;laps=data.laps??1;
      if(typeof closed!=='boolean'||!Number.isInteger(laps)||laps<1||laps>100)throw Error('路线参数无效');
      importedMotion=normaliseMotion(data.motion??{mode:'speed',speed:data.speed??6});
    }
    if(!Array.isArray(incoming)||incoming.length<2||incoming.length>2000||incoming.some(p=>!Array.isArray(p)||p.length!==2||p.some(v=>typeof v!=='number'||!Number.isFinite(v))||Math.abs(p[0])>90||Math.abs(p[1])>180))throw Error('路线需要 2–2000 个有效的 WGS84 坐标点');
    map.cancel(); edits.reset(); forgetLoad(); index=incoming.length-1; selectedLabel='';
    points=incoming;selected=[...points.at(-1)];
    $('lat').value=selected[0].toFixed(6);$('lon').value=selected[1].toFixed(6);
    $('closed').checked=closed;$('laps').value=laps;
    if(importedMotion)applyImportedMotion(importedMotion);
    setMode('route');map.fit();
  }catch(error){toast(error.message);}finally{e.target.value='';}
};
$('export').onclick=()=>{
  if(points.length<2)return toast('请先添加至少两个路径点。');
  try{
    const motion=readMotionUI();
    const blob=new Blob([JSON.stringify({version:1,coordinateSystem:'WGS84',points,speed:motion.speed,motion,closed:$('closed').checked,laps:$('closed').checked?Number($('laps').value):1},null,2)],{type:'application/json'});
    const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='waypoint-route.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
  }catch(error){toast(error.message);}
};
$('exit').onclick=async()=>{if(busy)return;busy=true;renderControls();try{await api('exit',{});exiting=true;runner.stop();$('runner-option').hidden=true;$('status-title').textContent='程序已退出';$('status-text').textContent='停止模拟指令已发送。可关闭这个页面和启动窗口。';$('connection-pill').textContent='已退出';$('connection-pill').classList.remove('connected');}catch(error){toast('退出未完成：'+error.message);}finally{busy=false;renderControls();}};
window.addEventListener('beforeunload',e=>{if(status?.recovery_needed&&!exiting){e.preventDefault();e.returnValue='';}});
setMode('browse'); $('refresh').click(); setInterval(poll,1000);
