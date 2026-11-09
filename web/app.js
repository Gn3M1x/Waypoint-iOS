'use strict';
import {MAP_SOURCES, toMapCoordinate, fromMapCoordinate} from './map-coordinates.mjs';
import {normaliseMotion, formatPace} from './motion.mjs';
const $ = id => document.getElementById(id);
const TOKEN_KEY = 'waypoint-token';
const fromFragment = new URLSearchParams(location.hash.slice(1)).get('token');
if (fromFragment) { sessionStorage.setItem(TOKEN_KEY, fromFragment); history.replaceState(null, '', '/'); }
const token = fromFragment || sessionStorage.getItem(TOKEN_KEY) || '';
let points = [], selected = [38.0, 114.52], mode = 'point', status = null, busy = false, exiting = false;
let motionMode='pace', searchBusy=false, searchGeneration=0;
let selectedLabel='', favoriteKind='address', favoriteTrash=false, favoriteItems=[], favoritePending=null, favoriteBusy=false, favoriteGeneration=0, previousDraft=null;
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
  busy = true; renderControls();
  try { const result = await api(action, body); if (result.state) renderStatus(result); return result; }
  catch (error) { toast(error.message); return null; }
  finally { busy = false; await poll(); renderControls(); }
}
function renderControls() {
  const connected = Boolean(status?.connected), state = status?.state;
  for (const id of ['connect','refresh','disconnect','apply','pause','restore','north','south','east','west','exit','apply-motion']) $(id).disabled = busy || exiting;
  $('apply-motion').disabled ||= !connected;
  $('connect').disabled ||= !($('devices').value) || (connected && state !== 'error');
  $('disconnect').disabled ||= !connected;
  $('apply').disabled ||= !connected || (mode === 'route' && points.length < 2);
  $('pause').disabled ||= !['moving','paused'].includes(state);
  $('restore').disabled ||= !connected;
  for (const id of ['north','south','east','west']) $(id).disabled ||= !connected || !status?.position;
  $('apply').textContent = mode === 'route' ? '开始路线移动' : '应用选中位置';
  $('pause').textContent = state === 'paused' ? '继续路线' : '暂停路线';
  $('connect').textContent = busy && state === 'connecting' ? '正在准备连接…' : state === 'error' && connected ? '重新连接' : '准备并连接';
  $('undo').disabled = !points.length;
  $('laps').disabled = !$('closed').checked;
  $('save-route-favorite').disabled = points.length<2;
}
function renderStatus(s) {
  status = s;
  document.body.classList.toggle('demo-mode',s.demo);
  document.querySelector('.compatibility').textContent = s.device ? 'iOS '+s.device.ios+' · 定位效果待确认' : 'iPhone · 定位效果待验证';
  $('demo-banner').hidden = !s.demo;
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
  renderControls(); map.draw();
}
async function poll() {
  if (exiting) return;
  try { renderStatus(await api('status')); }
  catch (e) { $('status-text').textContent = token ? '无法连接本机控制程序。请确认启动窗口仍在运行。' : '请通过附带的启动程序打开控制台。'; }
}
function selectPoint(p) { selectedLabel=''; selected = p; $('lat').value = p[0].toFixed(6); $('lon').value = p[1].toFixed(6); if (mode === 'route') points.push([...p]); updateRoute(); }
function setMode(m) { mode = m; $('mode-point').classList.toggle('active', m === 'point'); $('mode-route').classList.toggle('active', m === 'route'); $('edit-hint').textContent = m === 'route' ? '沿道路依次点击添加路径点。按直线连接相邻点。' : '点击地图选择位置，再点击应用定位。'; updateRoute(); }
function haversine(a,b) { const r = Math.PI/180, dlat=(b[0]-a[0])*r,dlon=(b[1]-a[1])*r;return 6371008.8*2*Math.asin(Math.sqrt(Math.min(1,Math.sin(dlat/2)**2+Math.cos(a[0]*r)*Math.cos(b[0]*r)*Math.sin(dlon/2)**2))); }
function routeLength() { let n=0; for(let i=1;i<points.length;i++) n+=haversine(points[i-1],points[i]); if($('closed').checked && points.length>1) n+=haversine(points.at(-1),points[0]); return n*($('closed').checked ? Math.max(1,Number($('laps').value)||1) : 1); }
function readMotionUI() {
  const paceMinutes=$('pace-minutes').value,paceSeconds=$('pace-seconds').value;
  if(motionMode==='pace'&&(!paceMinutes||paceSeconds===''||!Number.isInteger(Number(paceMinutes))||!Number.isInteger(Number(paceSeconds))||Number(paceSeconds)<0||Number(paceSeconds)>59))throw Error('配速请填写整数分钟和 0–59 秒。');
  return normaliseMotion({mode:motionMode,speed:Number($('speed').value),pace_seconds:Number(paceMinutes)*60+Number(paceSeconds),randomize:$('pace-random').checked,variation_percent:Number($('pace-variation').value)});
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
  setMotionMode(motion.mode);
}
function updateRoute() {
  const meters=routeLength();let seconds=null;
  try {seconds=meters/(readMotionUI().speed/3.6);} catch {}
  $('route-distance').replaceChildren(document.createTextNode(meters.toFixed(1)+' '),Object.assign(document.createElement('small'),{textContent:'米'}));
  $('route-time').textContent=meters&&seconds!==null ? `${Math.floor(Math.round(seconds)/60)}:${String(Math.round(seconds)%60).padStart(2,'0')}` : '—';
  $('speed-label').textContent=$('speed').value+' km/h';
  $('variation-label').textContent=`±${$('pace-variation').value}%`;
  $('pace-variation').disabled=!$('pace-random').checked;
  renderControls(); map.draw();
}

class SlippyMap {
  constructor(canvas) {
    this.canvas=canvas; this.ctx=canvas.getContext('2d'); this.zoom=16;this.center=[38,114.52];this.tiles=new Map();this.pending=false;
    this.source='amap';
    try { const saved=localStorage.getItem('waypoint-map-source'); if(Object.hasOwn(MAP_SOURCES,saved))this.source=saved; } catch {}
    this.refreshSourceLabel();
    new ResizeObserver(()=>this.draw()).observe(canvas);
    canvas.addEventListener('pointerdown',e=>{if(e.button!==0)return;canvas.setPointerCapture(e.pointerId);this.drag={x:e.clientX,y:e.clientY,center:this.project(this.center),moved:false};});
    canvas.addEventListener('pointermove',e=>{if(!this.drag)return;const dx=e.clientX-this.drag.x,dy=e.clientY-this.drag.y;if(Math.hypot(dx,dy)>4)this.drag.moved=true;if(this.drag.moved){this.center=this.unproject([this.drag.center[0]-dx,this.drag.center[1]-dy]);this.draw();}});
    canvas.addEventListener('pointerup',e=>{if(!this.drag)return;const d=this.drag;this.drag=null;if(!d.moved){const rect=canvas.getBoundingClientRect();selectPoint(this.unproject(this.fromScreen([e.clientX-rect.left,e.clientY-rect.top])));}});
    canvas.addEventListener('pointercancel',()=>{this.drag=null;});
    canvas.addEventListener('wheel',e=>{e.preventDefault();const rect=canvas.getBoundingClientRect(),screen=[e.clientX-rect.left,e.clientY-rect.top],anchor=this.unproject(this.fromScreen(screen));const next=Math.max(2,Math.min(19,this.zoom+(e.deltaY<0?1:-1)));if(next===this.zoom)return;this.zoom=next;const p=this.project(anchor);this.center=this.unproject([p[0]-(screen[0]-rect.width/2),p[1]-(screen[1]-rect.height/2)]);this.draw();},{passive:false});
  }
  project(p) { const [lat,lon]=toMapCoordinate(p,this.source),size=256*2**this.zoom,s=Math.sin(Math.max(-85.05112878,Math.min(85.05112878,lat))*Math.PI/180);return[(lon+180)/360*size,(0.5-Math.log((1+s)/(1-s))/(4*Math.PI))*size]; }
  unproject([x,y]) { const size=256*2**this.zoom;return fromMapCoordinate([180/Math.PI*Math.atan(Math.sinh(Math.PI*(1-2*Math.max(0,Math.min(size,y))/size))),((x/size*360)%360+360)%360-180],this.source); }
  fromScreen([x,y]) { const c=this.project(this.center);return[c[0]+x-this.width/2,c[1]+y-this.height/2]; }
  toScreen(p) { const a=this.project(p),c=this.project(this.center),world=256*2**this.zoom;let dx=a[0]-c[0];dx=((dx+world/2)%world+world)%world-world/2;return[dx+this.width/2,a[1]-c[1]+this.height/2]; }
  tile(z,x,y) {
    const n=2**z;x=((x%n)+n)%n;if(y<0||y>=n)return null;
    const key=`${this.source}/${z}/${x}/${y}`;
    if(this.tiles.has(key))return this.tiles.get(key);
    const image=new Image(),entry={image,status:'loading',timer:null};
    image.referrerPolicy='strict-origin-when-cross-origin';
    const settle=state=>{if(entry.status!=='loading')return;clearTimeout(entry.timer);entry.status=state;this.draw();};
    image.onload=()=>settle(image.naturalWidth===256&&image.naturalHeight===256?'loaded':'error');
    image.onerror=()=>settle('error');
    entry.timer=setTimeout(()=>{settle('error');image.onload=null;image.onerror=null;image.src='';},12000);
    image.src=MAP_SOURCES[this.source].tileUrl(z,x,y);
    this.tiles.set(key,entry);
    if(this.tiles.size>512){const oldest=this.tiles.keys().next().value;this.discardTile(oldest);}
    return entry;
  }
  discardTile(key) {
    const entry=this.tiles.get(key);if(!entry)return;
    clearTimeout(entry.timer);entry.image.onload=null;entry.image.onerror=null;
    if(entry.status==='loading')entry.image.src='';
    this.tiles.delete(key);
  }
  refreshSourceLabel() {
    const source=MAP_SOURCES[this.source];
    $('map-source').value=this.source;
    $('map-attribution').textContent=source.attribution;
    $('map-attribution').href=source.attributionUrl;
    this.canvas.dataset.mapSource=this.source;
  }
  setSource(source) {
    if(!Object.hasOwn(MAP_SOURCES,source))return;
    // Cancel only unfinished requests. Loaded tiles stay cached per provider.
    for(const[key,entry]of this.tiles)if(entry.status==='loading')this.discardTile(key);
    this.source=source;this.refreshSourceLabel();
    try{localStorage.setItem('waypoint-map-source',source);}catch{}
    this.draw();
  }
  retryTiles() {
    for(const[key,entry]of this.tiles)if(entry.status!=='loaded')this.discardTile(key);
    this.draw();
  }
  renderLoadStatus(entries) {
    const total=entries.length,loaded=entries.filter(e=>e.status==='loaded').length,failed=entries.filter(e=>e.status==='error').length;
    this.canvas.dataset.loadedTiles=String(loaded);this.canvas.dataset.totalTiles=String(total);this.canvas.dataset.failedTiles=String(failed);
    $('map-loading').hidden=loaded===total&&total>0;
    $('map-loading').textContent=failed?`${MAP_SOURCES[this.source].name}：${failed} 张未能加载，可点“↻”重试或切换地图源。`:`${MAP_SOURCES[this.source].name}加载中：${loaded}/${total}`;
  }
  draw() { if(this.pending)return;this.pending=true;requestAnimationFrame(()=>{this.pending=false;this.paint();}); }
  paint() {
    const rect=this.canvas.getBoundingClientRect(),dpr=window.devicePixelRatio||1;this.width=rect.width;this.height=rect.height;if(!this.width||!this.height)return;
    this.canvas.width=Math.round(this.width*dpr);this.canvas.height=Math.round(this.height*dpr);const ctx=this.ctx;ctx.scale(dpr,dpr);ctx.fillStyle='#152030';ctx.fillRect(0,0,this.width,this.height);
    ctx.strokeStyle='#203047';ctx.lineWidth=1;for(let x=0;x<this.width;x+=48){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,this.height);ctx.stroke();}for(let y=0;y<this.height;y+=48){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(this.width,y);ctx.stroke();}
    const origin=this.fromScreen([0,0]),minx=Math.floor(origin[0]/256),miny=Math.floor(origin[1]/256),maxx=Math.floor((origin[0]+this.width)/256),maxy=Math.floor((origin[1]+this.height)/256);
    ctx.filter='invert(0.92) hue-rotate(180deg) brightness(0.8) saturate(0.4)';
    const visibleTiles=[];
    for(let x=minx;x<=maxx;x++)for(let y=miny;y<=maxy;y++){const entry=this.tile(this.zoom,x,y);if(entry)visibleTiles.push(entry);if(entry?.status==='loaded')ctx.drawImage(entry.image,Math.round(x*256-origin[0]),Math.round(y*256-origin[1]),257,257);}ctx.filter='none';
    this.renderLoadStatus(visibleTiles);
    const path=[...points];if($('closed').checked&&path.length>1)path.push(path[0]);if(path.length>1){ctx.beginPath();path.forEach((p,i)=>{const [x,y]=this.toScreen(p);i?ctx.lineTo(x,y):ctx.moveTo(x,y);});ctx.strokeStyle='#062f2b';ctx.lineWidth=8;ctx.lineJoin='round';ctx.stroke();ctx.strokeStyle='#56e2bd';ctx.lineWidth=3;ctx.stroke();}
    points.forEach((p,i)=>this.marker(p,'#56e2bd',String(i+1),9));if(mode==='point')this.marker(selected,'#56e2bd','',9);if(status?.position)this.marker(status.position,'#81adff','',8,true);
    ctx.fillStyle='#b0c4d8';ctx.font='10px -apple-system,sans-serif';ctx.fillText(`z${this.zoom}  ·  ${this.center[0].toFixed(5)}, ${this.center[1].toFixed(5)}`,15,25);
  }
  marker(p,color,label,r,glow=false) { const[x,y]=this.toScreen(p),ctx=this.ctx;if(glow){ctx.fillStyle='#81adff30';ctx.beginPath();ctx.arc(x,y,18,0,Math.PI*2);ctx.fill();}ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fillStyle=color;ctx.fill();ctx.lineWidth=2;ctx.strokeStyle='#e8fff7';ctx.stroke();if(label){ctx.fillStyle='#073c30';ctx.font='bold 10px -apple-system,sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(label,x,y);ctx.textAlign='left';ctx.textBaseline='alphabetic';} }
  fit() { const ps=points.length?points:[selected];this.center=[(Math.min(...ps.map(p=>p[0]))+Math.max(...ps.map(p=>p[0])))/2,(Math.min(...ps.map(p=>p[1]))+Math.max(...ps.map(p=>p[1])))/2];this.zoom=19;for(;this.zoom>2;this.zoom--){const c=this.project(this.center);if(ps.every(p=>{const q=this.project(p);return Math.abs(q[0]-c[0])<this.width/2-55&&Math.abs(q[1]-c[1])<this.height/2-55;}))break;}this.draw(); }
}
const map=new SlippyMap($('map'));
function routeDocument() {
  if(points.length<2)throw Error('请先在地图上画一条路线，至少添加两个路径点。');
  const motion=readMotionUI();
  return {version:1,coordinateSystem:'WGS84',points:structuredClone(points),speed:motion.speed,motion,closed:$('closed').checked,laps:$('closed').checked?Number($('laps').value):1};
}
function editorSnapshot() {
  const fields={};
  for(const id of ['speed','pace-minutes','pace-seconds','pace-random','pace-variation'])fields[id]=$(id).type==='checkbox'?$(id).checked:$(id).value;
  return {points:structuredClone(points),selected:[...selected],selectedLabel,mode,motionMode,fields,closed:$('closed').checked,laps:$('laps').value,center:[...map.center],zoom:map.zoom};
}
function restoreEditor(draft) {
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
  return `${length} · ${s.points} 个点 · ${motion}${s.motion.randomize?` · 波动 ±${s.motion.variation_percent}%`:''} · ${s.laps} 圈`;
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
  if(!items.length){const empty=document.createElement('div');empty.className='favorites-empty';empty.textContent=favoriteTrash?'回收站中没有匹配的收藏。':term?'没有匹配的收藏。':favoriteKind==='address'?'还没有收藏地址。在地图选点或输入坐标后，点击“★ 收藏地址”。':'还没有收藏路线。画好路线并设置配速后，点击“★ 收藏路线”。';$('favorites-list').append(empty);}
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
  try{const data=await api(`favorites${favoriteTrash?'?trash=1':''}`);if(generation!==favoriteGeneration)return;favoriteItems=data.favorites;renderFavorites();}
  catch(e){$('favorites-notice').textContent=e.message;}
}
async function showFavorites(kind=favoriteKind) {
  favoriteKind=kind;$('favorites-panel').hidden=false;
  await refreshFavorites();
}
function openFavoriteForm(pending,name,preview) {
  favoritePending=pending;favoriteKind=pending.kind;$('favorites-panel').hidden=false;
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
    cancelFavoriteForm();$('favorites-notice').textContent=`已载入“${value.name}”${value.kind==='route'?'及其配速、随机幅度和圈数。点击“开始路线移动”后才会播放。':'，可继续在地图选点。'} 当前手机定位与播放保持原状。`;
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
for(const id of ['lat','lon'])$(id).addEventListener('input',()=>{selectedLabel='';});
$('save-address-favorite').onclick=()=>{
  try{const p=[Number($('lat').value),Number($('lon').value)];if(!$('lat').value||!$('lon').value||!Number.isFinite(p[0])||!Number.isFinite(p[1])||Math.abs(p[0])>90||Math.abs(p[1])>180)throw Error('请先选择或输入有效坐标。');openFavoriteForm({action:'save',kind:'address',payload:{version:1,coordinateSystem:'WGS84',point:p,zoom:map.zoom}},selectedLabel||`地址 ${p[0].toFixed(5)}, ${p[1].toFixed(5)}`,`将保存 ${p[0].toFixed(6)}, ${p[1].toFixed(6)}（WGS84）。`);}catch(e){toast(e.message);}
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
for(const id of ['pace-minutes','pace-seconds','pace-random','pace-variation'])$(id).addEventListener('input',updateRoute);
$('apply-motion').onclick=()=>{try{act('motion',readMotionUI());}catch(e){toast(e.message);}};
$('map-source').onchange=e=>map.setSource(e.target.value);
$('retry-tiles').onclick=()=>map.retryTiles();
function focusSearchResult(result, coordinateSystem, attribution) {
  selectedLabel=result.name;
  selected=coordinateSystem==='GCJ02'?fromMapCoordinate(result.point,'amap'):[...result.point];
  $('lat').value=selected[0].toFixed(6);$('lon').value=selected[1].toFixed(6);
  map.center=[...selected];map.zoom=16;
  if(result.bounds){
    const [south,north,west,east]=result.bounds;
    const corners=[[south,west],[north,east]];
    map.zoom=19;
    for(;map.zoom>3;map.zoom--){const c=map.project(map.center);if(corners.every(p=>{const q=map.project(p);return Math.abs(q[0]-c[0])<map.width/2-40&&Math.abs(q[1]-c[1])<map.height/2-40;}))break;}
  }
  // Searching never appends a waypoint or sends a position to the phone.
  $('place-results').hidden=true;
  $('place-search-status').textContent=`已定位到“${result.name}”。${mode==='route'?'点击地图继续添加路径点。':'可点击应用选中位置。'} ${attribution}`;
  updateRoute();
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
      const button=document.createElement('button');button.type='button';button.setAttribute('role','listitem');
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
$('mode-point').onclick=()=>setMode('point');$('mode-route').onclick=()=>setMode('route');
$('refresh').onclick=async()=>{const r=await act('devices');if(!r)return;const old=$('devices').value;$('devices').replaceChildren();for(const d of r.devices){const option=document.createElement('option');option.value=d.id;option.textContent=`${d.name} · iOS ${d.ios}`;$('devices').append(option);}if(!r.devices.length)$('devices').append(Object.assign(document.createElement('option'),{value:'',textContent:'未找到 USB 设备'}));if(r.devices.some(d=>d.id===old))$('devices').value=old;renderControls();};
$('devices').onchange=renderControls;
$('connect').onclick=()=>act('connect',{device:$('devices').value,native:$('native').checked});
$('disconnect').onclick=()=>act('disconnect');
$('locate').onclick=()=>{const lat=Number($('lat').value),lon=Number($('lon').value);if(!$('lat').value||!$('lon').value||!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>90||Math.abs(lon)>180)return toast('请输入有效的纬度（−90 到 90）和经度（−180 到 180）。');selectPoint([lat,lon]);map.center=[Math.max(-85,Math.min(85,lat)),lon];map.draw();};
$('undo').onclick=()=>{points.pop();updateRoute();};$('clear-route').onclick=()=>{points=[];updateRoute();};
$('apply').onclick=()=>{try{if(mode==='point')act('set',{point:selected});else act('route',{points,motion:readMotionUI(),closed:$('closed').checked,laps:$('closed').checked?Number($('laps').value):1});}catch(e){toast(e.message);}};
$('pause').onclick=()=>act(status?.state==='paused'?'resume':'pause');$('restore').onclick=()=>act('clear');
$('speed').oninput=updateRoute;$('speed').onchange=()=>act('speed',{speed:Number($('speed').value)});
$('closed').onchange=updateRoute;$('laps').oninput=updateRoute;
for(const[id,bearing]of[['north',0],['east',90],['south',180],['west',270]])$(id).onclick=()=>act('nudge',{bearing,meters:10});
$('zoom-in').onclick=()=>{map.zoom=Math.min(19,map.zoom+1);map.draw();};$('zoom-out').onclick=()=>{map.zoom=Math.max(2,map.zoom-1);map.draw();};$('fit').onclick=()=>map.fit();
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
$('exit').onclick=async()=>{if(busy)return;busy=true;renderControls();try{await api('exit',{});exiting=true;$('status-title').textContent='程序已退出';$('status-text').textContent='停止模拟指令已发送。可关闭这个页面和启动窗口。';$('connection-pill').textContent='已退出';$('connection-pill').classList.remove('connected');}catch(error){toast('退出未完成：'+error.message);}finally{busy=false;renderControls();}};
window.addEventListener('beforeunload',e=>{if(status?.recovery_needed&&!exiting){e.preventDefault();e.returnValue='';}});
poll();setInterval(poll,1000);updateRoute();
