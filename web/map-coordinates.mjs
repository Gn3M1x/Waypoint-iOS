// WGS84 <-> GCJ-02 math adapted from wandergis/coordtransform (MIT).
// Copyright (c) 2015 记忆的残骸. Full notice: ../THIRD_PARTY_NOTICES.md.
// All public functions use [latitude, longitude], matching the phone API.
const A = 6378245;
const EE = 0.00669342162296594323;
const PI = Math.PI;

function outsideTransformArea([lat, lon]) {
  return !(lon > 73.66 && lon < 135.05 && lat > 3.86 && lat < 53.55);
}

function latitudeDelta(x, y) {
  let v = -100 + 2*x + 3*y + 0.2*y*y + 0.1*x*y + 0.2*Math.sqrt(Math.abs(x));
  v += (20*Math.sin(6*x*PI) + 20*Math.sin(2*x*PI))*2/3;
  v += (20*Math.sin(y*PI) + 40*Math.sin(y/3*PI))*2/3;
  v += (160*Math.sin(y/12*PI) + 320*Math.sin(y*PI/30))*2/3;
  return v;
}

function longitudeDelta(x, y) {
  let v = 300 + x + 2*y + 0.1*x*x + 0.1*x*y + 0.1*Math.sqrt(Math.abs(x));
  v += (20*Math.sin(6*x*PI) + 20*Math.sin(2*x*PI))*2/3;
  v += (20*Math.sin(x*PI) + 40*Math.sin(x/3*PI))*2/3;
  v += (150*Math.sin(x/12*PI) + 300*Math.sin(x/30*PI))*2/3;
  return v;
}

export function wgsToGcj(p) {
  if (outsideTransformArea(p)) return [...p];
  const [lat, lon] = p, radians = lat/180*PI;
  const magic = 1 - EE*Math.sin(radians)**2, root = Math.sqrt(magic);
  const dlat = latitudeDelta(lon-105, lat-35)*180/((A*(1-EE))/(magic*root)*PI);
  const dlon = longitudeDelta(lon-105, lat-35)*180/(A/root*Math.cos(radians)*PI);
  return [lat+dlat, lon+dlon];
}

export function gcjToWgs(p) {
  if (outsideTransformArea(p)) return [...p];
  let candidate = [...p];
  // Invert the forward transform numerically, rather than just subtracting once.
  for (let i=0; i<10; i++) {
    const transformed = wgsToGcj(candidate);
    const dlat = transformed[0]-p[0], dlon = transformed[1]-p[1];
    candidate = [candidate[0]-dlat, candidate[1]-dlon];
    if (Math.max(Math.abs(dlat), Math.abs(dlon)) < 1e-10) break;
  }
  return candidate;
}

export const MAP_SOURCES = Object.freeze({
  amap: Object.freeze({
    name: '高德地图', coordinateSystem: 'GCJ02',
    attribution: '© 高德地图', attributionUrl: 'https://www.amap.com/',
    tileUrl: (z,x,y) => `https://webst02.is.autonavi.com/appmaptile?style=7&x=${x}&y=${y}&z=${z}`,
  }),
  osm: Object.freeze({
    name: 'OpenStreetMap', coordinateSystem: 'WGS84',
    attribution: '© OpenStreetMap contributors', attributionUrl: 'https://www.openstreetmap.org/copyright',
    tileUrl: (z,x,y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
  }),
});

export function toMapCoordinate(p, source) {
  return source === 'amap' ? wgsToGcj(p) : [...p];
}

export function fromMapCoordinate(p, source) {
  return source === 'amap' ? gcjToWgs(p) : [...p];
}
