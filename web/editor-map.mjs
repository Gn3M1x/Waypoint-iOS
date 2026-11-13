import { MAP_SOURCES, toMapCoordinate, fromMapCoordinate } from './map-coordinates.mjs';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const wrap = value => ((value % 1) + 1) % 1;

export function project(point, source) {
  const [lat, lon] = toMapCoordinate(point, source);
  const sin = Math.sin(clamp(lat, -85.05112878, 85.05112878) * Math.PI / 180);
  return [(lon + 180) / 360, 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)];
}

export function unproject([x, y], source) {
  const latitude = Math.atan(Math.sinh(Math.PI * (1 - 2 * clamp(y, 0, 1)))) * 180 / Math.PI;
  return fromMapCoordinate([latitude, wrap(x) * 360 - 180], source);
}

export class History {
  past = [];
  future = [];
  record(before) {
    this.past.push(before);
    if (this.past.length > 100) this.past.shift();
    this.future.length = 0;
  }
  step(current, redo = false) {
    const [from, to] = redo ? [this.future, this.past] : [this.past, this.future];
    if (!from.length) return null;
    to.push(current);
    return from.pop();
  }
  reset() {
    this.past.length = this.future.length = 0;
  }
}

export class EditorMap {
  zoom = 16;
  center = [38, 114.52];
  tiles = new Map();
  projections = new WeakMap();
  hover = -1;
  drag = null;
  frame = 0;
  baseDirty = true;
  constructor(canvas, backdrop, events) {
    this.canvas = canvas;
    this.backdrop = backdrop;
    this.events = events;
    this.source = 'amap';
    try {
      const saved = localStorage.getItem('waypoint-map-source');
      if (Object.hasOwn(MAP_SOURCES, saved)) this.source = saved;
    } catch {}
    this.ctx = canvas.getContext('2d');
    this.base = backdrop.getContext('2d', {alpha: false});
    this.observer = new ResizeObserver(() => this.draw(true));
    this.observer.observe(canvas);
    canvas.addEventListener('pointerdown', e => this.down(e));
    canvas.addEventListener('pointermove', e => this.move(e));
    canvas.addEventListener('pointerup', e => this.up(e));
    for (const name of ['pointercancel', 'lostpointercapture']) {
      canvas.addEventListener(name, e => { if (e.pointerId === this.drag?.id) this.cancel(); });
    }
    canvas.addEventListener('pointerleave', () => this.setHover(-1));
    window.addEventListener('blur', () => { this.pinchZoom = undefined; this.cancel(); });
    canvas.addEventListener('wheel', e => this.wheel(e), {passive: false});
    // Safari supplies GestureEvents for trackpad pinch instead of Ctrl+wheel.
    canvas.addEventListener('gesturestart', e => {
      e.preventDefault();
      this.cancel();
      this.pinchZoom = this.zoom;
    }, {passive:false});
    canvas.addEventListener('gesturechange', e => {
      e.preventDefault();
      if (this.pinchZoom !== undefined && e.scale > 0) this.zoomAt(this.pinchZoom + Math.log2(e.scale), this.local(e));
    }, {passive:false});
    canvas.addEventListener('gestureend', e => { e.preventDefault(); this.pinchZoom = undefined; }, {passive:false});
    this.setSource(this.source);
  }
  get scale() { return 256 * 2 ** this.zoom; }
  world(p) {
    if (!this.projections.has(p)) this.projections.set(p, project(p, this.source));
    return this.projections.get(p);
  }
  screen(p, camera) {
    const [x, y] = this.world(p);
    let dx = x - camera[0];
    dx -= Math.round(dx);
    return [this.width / 2 + dx * this.scale, this.height / 2 + (y - camera[1]) * this.scale];
  }
  local(e) {
    const rect = this.canvas.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  }
  coordinate([x, y]) {
    const [cx, cy] = this.world(this.center);
    return unproject([cx + (x - this.width / 2) / this.scale,
      cy + (y - this.height / 2) / this.scale], this.source);
  }
  hit([x, y]) {
    const {points, mode} = this.events.scene();
    if (mode !== 'route') return -1;
    const center = this.world(this.center);
    let closest = -1, limit = 12 ** 2;
    points.forEach((p, i) => {
      const [px, py] = this.screen(p, center);
      const d = (px - x) ** 2 + (py - y) ** 2;
      if (d <= limit) { closest = i; limit = d; }
    });
    return closest;
  }
  setHover(index) {
    if (index === this.hover) return;
    this.hover = index;
    this.canvas.classList.toggle('over-point', index >= 0);
    this.draw();
  }
  down(e) {
    if (this.drag || e.button !== 0 || !e.isPrimary) return;
    const start = this.local(e);
    this.drag = {id: e.pointerId, start, index: this.hit(start), center: this.world(this.center), moved: false};
    this.canvas.focus({preventScroll: true});
    this.canvas.setPointerCapture(e.pointerId);
  }
  inside([x,y]) {
    return x >= 0 && x < this.width && y >= 0 && y < this.height;
  }
  updateDrag(pos) {
    const d = this.drag;
    const dx = pos[0] - d.start[0], dy = pos[1] - d.start[1];
    if (!d.moved && Math.hypot(dx, dy) < 5) return;
    d.moved = true;
    this.canvas.classList.add('dragging');
    if (d.index >= 0) {
      const startPoint = this.events.scene().points[d.index];
      if (!startPoint) return this.cancel();
      const [px, py] = this.world(startPoint);
      d.preview = unproject([px + dx / this.scale, py + dy / this.scale], this.source);
      this.draw();
    } else {
      this.center = unproject([d.center[0] - dx / this.scale, d.center[1] - dy / this.scale], this.source);
      this.draw(true);
    }
  }
  move(e) {
    if (!this.drag) return this.setHover(this.hit(this.local(e)));
    if (e.pointerId !== this.drag.id) return;
    const pos = this.local(e);
    if (e.buttons === 0 || !this.inside(pos)) return this.cancel();
    this.updateDrag(pos);
  }
  up(e) {
    if (e.pointerId !== this.drag?.id) return;
    const pos = this.local(e);
    if (!this.inside(pos)) return this.cancel();
    this.updateDrag(pos);
    const d = this.drag;
    this.cancel();
    if (!d) return;
    if (d.preview) return this.events.move(d.index, d.preview);
    if (d.moved) return;
    if (d.index >= 0) this.events.select(d.index);
    else this.events.pick(this.coordinate(pos));
  }
  cancel() {
    const id = this.drag?.id;
    this.drag = null;
    if (id !== undefined && this.canvas.hasPointerCapture(id)) this.canvas.releasePointerCapture(id);
    this.canvas.classList.remove('dragging');
    this.setHover(-1);
    this.draw();
  }
  zoomAt(next, [x, y] = [this.width / 2, this.height / 2]) {
    const old = this.scale;
    const camera = this.world(this.center);
    this.zoom = clamp(next, 2, 19);
    const difference = 1 / old - 1 / this.scale;
    this.center = unproject([camera[0] + (x - this.width / 2) * difference,
      camera[1] + (y - this.height / 2) * difference], this.source);
    this.draw(true);
  }
  wheel(e) {
    e.preventDefault();
    if (this.drag || this.pinchZoom !== undefined) return;
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.height : 1;
    if (e.ctrlKey || e.metaKey || this.events.scrollZoom()) {
      this.zoomAt(this.zoom - clamp(e.deltaY * unit * (e.ctrlKey ? 0.014 : 0.005), -1.5, 1.5), this.local(e));
    } else {
      const [x, y] = this.world(this.center);
      this.center = unproject([x + e.deltaX * unit / this.scale, y + e.deltaY * unit / this.scale], this.source);
      this.draw(true);
    }
  }
  fit(ps = this.events.scene().points) {
    // Restoring an active route can happen before the first animation frame.
    const width=this.canvas.clientWidth || this.width || 160;
    const height=this.canvas.clientHeight || this.height || 210;
    if (!ps.length) ps = [this.events.scene().selected];
    const origin = this.world(ps[0])[0];
    let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
    for (const p of ps) {
      const [wx, y] = this.world(p);
      const x = wx - Math.round(wx - origin);
      left = Math.min(left, x); right = Math.max(right, x);
      top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
    this.center = unproject([(left + right) / 2, (top + bottom) / 2], this.source);
    this.zoom = clamp(Math.log2(Math.min(Math.max(60, width - 100) / (right - left),
      Math.max(60, height - 150) / (bottom - top)) / 256), 2, 19);
    this.draw(true);
  }
  setSource(source) {
    if (!Object.hasOwn(MAP_SOURCES, source)) return;
    this.cancel();
    if (source !== this.source) {
      for (const [key, entry] of this.tiles) if (entry.state === 'loading') this.discard(key);
    }
    this.source = source;
    this.projections = new WeakMap();
    this.canvas.dataset.mapSource = source;
    this.events.source(source, MAP_SOURCES[source]);
    try { localStorage.setItem('waypoint-map-source', source); } catch {}
    this.draw(true);
  }
  tile(z, x, y) {
    const count = 2 ** z;
    const key = [this.source,z,(x % count + count) % count,y].join('/');
    let entry = this.tiles.get(key);
    if (entry) {
      this.tiles.delete(key);
      this.tiles.set(key, entry);
      return entry;
    }
    const img = new Image();
    entry = {img, state:'loading'};
    const finish = state => {
      if (entry.state !== 'loading') return;
      clearTimeout(entry.timer);
      entry.state = state;
      this.draw(true);
    };
    img.onload = () => finish(img.naturalWidth ? 'loaded' : 'error');
    img.onerror = () => finish('error');
    entry.timer = setTimeout(() => { finish('error'); img.removeAttribute('src'); }, 12000);
    img.src = MAP_SOURCES[this.source].tileUrl(z, (x % count + count) % count, y);
    this.tiles.set(key, entry);
    if (this.tiles.size > 384) this.discard(this.tiles.keys().next().value);
    return entry;
  }
  discard(key) {
    const entry = this.tiles.get(key);
    clearTimeout(entry.timer);
    entry.img.onload = entry.img.onerror = null;
    if (entry.state === 'loading') entry.img.removeAttribute('src');
    this.tiles.delete(key);
  }
  retryTiles() {
    for (const [key, entry] of this.tiles) if (entry.state !== 'loaded') this.discard(key);
    this.draw(true);
  }
  draw(base = false) {
    this.baseDirty ||= base;
    if (!this.frame) this.frame = requestAnimationFrame(() => this.paint());
  }
  paintBase(center) {
    const ctx = this.base, z = Math.round(this.zoom), count = 2 ** z;
    const tileSize = this.scale / count;
    const ox = center[0] * this.scale - this.width / 2;
    const oy = center[1] * this.scale - this.height / 2;
    ctx.fillStyle = '#e6ece8';
    ctx.fillRect(0, 0, this.width, this.height);
    let loaded = 0, total = 0, failed = 0;
    for (let y = Math.max(0, Math.floor(oy / tileSize)); y <= Math.min(count - 1, Math.floor((oy + this.height) / tileSize)); y++) {
      for (let x = Math.floor(ox / tileSize); x <= Math.floor((ox + this.width) / tileSize); x++) {
        const entry = this.tile(z, x, y);
        const left = x * tileSize - ox, top = y * tileSize - oy;
        total++;
        if (entry.state === 'loaded') {
          loaded++;
          ctx.drawImage(entry.img, left, top, tileSize + 0.5, tileSize + 0.5);
        } else {
          if (entry.state === 'error') failed++;
          const xx = (x % count + count) % count;
          // Zooming out can expose four already-loaded children before their parent arrives.
          // Use an ancestor as a fallback beneath available children.
          for (let depth = 1; depth <= Math.min(4, z - 2); depth++) {
            const factor = 2 ** depth;
            const parent = this.tiles.get([this.source,z-depth,Math.floor(xx/factor),Math.floor(y/factor)].join('/'));
            if (parent?.state !== 'loaded') continue;
            const crop = 256 / factor;
            ctx.drawImage(parent.img, (xx % factor)*crop, (y % factor)*crop, crop, crop,
              left, top, tileSize + 0.5, tileSize + 0.5);
            break;
          }
          const half = tileSize / 2;
          for (let cy = 0; cy < 2; cy++) for (let cx = 0; cx < 2; cx++) {
            const child = this.tiles.get([this.source,z+1,xx*2+cx,y*2+cy].join('/'));
            if (child?.state === 'loaded') ctx.drawImage(child.img,left+cx*half,top+cy*half,half+0.5,half+0.5);
          }
        }
      }
    }
    this.events.tiles(loaded, total, failed);
  }
  paint() {
    this.frame = 0;
    this.width = this.canvas.clientWidth;
    this.height = this.canvas.clientHeight;
    if (!this.width || !this.height) return;
    const dpr = window.devicePixelRatio || 1;
    for (const layer of [this.canvas, this.backdrop]) {
      const w = Math.round(this.width * dpr), h = Math.round(this.height * dpr);
      if (layer.width !== w || layer.height !== h) {
        layer.width = w; layer.height = h; this.baseDirty = true;
      }
    }
    this.ctx.setTransform(dpr,0,0,dpr,0,0);
    this.base.setTransform(dpr,0,0,dpr,0,0);
    const camera = this.world(this.center);
    const view = [this.source,this.width,this.height,this.zoom,...camera].join(',');
    if (this.baseDirty || view !== this.lastView) {
      this.paintBase(camera);
      this.lastView = view;
      this.baseDirty = false;
    }
    this.paintDraft(camera);
    this.events.view(this.zoom, this.center);
  }
  paintDraft(camera) {
    const ctx = this.ctx;
    const {points, mode, selected, index, sent, closed, activeRoute, draftChanged} = this.events.scene();
    ctx.clearRect(0, 0, this.width, this.height);
    if (activeRoute) this.paintActiveRoute(activeRoute, camera);
    // Reuse the projected route and its Path2D while translating the camera.
    // Keep coordinates local to the first waypoint to preserve canvas precision.
    const sceneKey = this.routeCache;
    if (!sceneKey || sceneKey.points !== points || sceneKey.source !== this.source ||
        sceneKey.zoom !== this.zoom || sceneKey.closed !== closed || sceneKey.preview !== this.drag?.preview) {
      const origin = points.length ? this.world(points[0]) : camera;
      const scale = this.scale;
      const positions = points.map((p,i) => {
        const [wx, wy] = this.world(i === this.drag?.index && this.drag.preview ? this.drag.preview : p);
        const dx = wx - origin[0];
        return [(dx - Math.round(dx)) * scale, (wy - origin[1]) * scale];
      });
      const path = new Path2D();
      positions.forEach(([x,y], i) => i ? path.lineTo(x,y) : path.moveTo(x,y));
      if (closed) path.closePath();
      this.routeCache = {points, source:this.source, zoom:this.zoom, closed, preview:this.drag?.preview, positions, path};
    }
    const {positions, path} = this.routeCache;
    const [offsetX, offsetY] = points.length ? this.screen(points[0],camera) : [0,0];
    ctx.save();
    ctx.translate(offsetX, offsetY);
    if (positions.length > 1 && (!activeRoute || draftChanged || this.drag?.preview)) {
      ctx.lineJoin = ctx.lineCap = 'round';
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 7; ctx.stroke(path);
      if(activeRoute)ctx.setLineDash([7,5]);
      ctx.strokeStyle = '#08795e'; ctx.lineWidth = 3.5; ctx.stroke(path);
      ctx.setLineDash([]);
    }
    const occupied = new Set();
    positions.forEach(([x,y],i) => {
      if (i === index || i === this.hover) return;
      if (x+offsetX < -18 || y+offsetY < -18 || x+offsetX > this.width+18 || y+offsetY > this.height+18) return;
      const end = i === 0 || i === positions.length - 1;
      if (!end && positions.length > 150) {
        const cell = Math.floor(x/20) + ',' + Math.floor(y/20);
        if (occupied.has(cell)) return;
        occupied.add(cell);
      }
      this.pointMarker(x,y,i,positions.length,false);
    });
    for (const i of new Set([this.hover,index])) {
      if (positions[i]) this.pointMarker(...positions[i],i,positions.length,true);
    }
    ctx.restore();
    if (mode === 'point') this.marker(...this.screen(selected,camera), '#008a68', 9, '＋', true);
    if (sent) {
      const [x,y] = this.screen(sent,camera);
      // A ring remains visible when a device position coincides with a labelled route endpoint.
      ctx.beginPath(); ctx.arc(x,y,15,0,2*Math.PI);
      ctx.strokeStyle='#fff'; ctx.lineWidth=5; ctx.stroke();
      ctx.strokeStyle='#326bcb'; ctx.lineWidth=2.5; ctx.stroke();
    }
  }
  paintActiveRoute(route, camera) {
    const ctx=this.ctx;
    const old=this.activeRouteCache;
    if(!old || old.route!==route || old.source!==this.source || old.zoom!==this.zoom) {
      const origin=this.world(route.points[0]), path=new Path2D();
      route.points.forEach((p,i)=>{
        const [wx,wy]=this.world(p), dx=wx-origin[0];
        const x=(dx-Math.round(dx))*this.scale, y=(wy-origin[1])*this.scale;
        if(i)path.lineTo(x,y);else path.moveTo(x,y);
      });
      if(route.closed)path.closePath();
      this.activeRouteCache={route,source:this.source,zoom:this.zoom,path};
    }
    ctx.save();ctx.translate(...this.screen(route.points[0],camera));
    ctx.lineJoin=ctx.lineCap='round';
    ctx.strokeStyle='#fff';ctx.lineWidth=8;ctx.stroke(this.activeRouteCache.path);
    ctx.strokeStyle='#326bcb';ctx.lineWidth=4;ctx.stroke(this.activeRouteCache.path);ctx.restore();
  }
  pointMarker(x,y,i,count,active) {
    const first = i === 0, last = count > 1 && i === count-1;
    this.marker(x,y,last?'#a94c26':'#08795e', first||last||active?11:4,
      first?'起':last?'终':active?String(i+1):'', active);
  }
  marker(x,y,color,r,label,halo) {
    const ctx = this.ctx;
    if (halo) {
      ctx.fillStyle = color + '38';
      ctx.beginPath(); ctx.arc(x,y,r+6,0,2*Math.PI); ctx.fill();
    }
    ctx.fillStyle = color; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x,y,r,0,2*Math.PI); ctx.fill(); ctx.stroke();
    if (label) {
      ctx.font = 'bold 10px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = '#fff'; ctx.fillText(label,x,y);
    }
  }
}
