import test from 'node:test';
import assert from 'node:assert/strict';
import {wgsToGcj, gcjToWgs, toMapCoordinate, fromMapCoordinate, MAP_SOURCES} from '../web/map-coordinates.mjs';

function close(actual, expected, tolerance=1e-8) {
  assert.ok(Math.abs(actual[0]-expected[0])<tolerance, `latitude: ${actual[0]} vs ${expected[0]}`);
  assert.ok(Math.abs(actual[1]-expected[1])<tolerance, `longitude: ${actual[1]} vs ${expected[1]}`);
}

test('known Beijing conversion preserves latitude/longitude order', () => {
  close(wgsToGcj([39.915,116.404]), [39.91640428150164,116.41024449916938], 1e-10);
});

test('map click inverse recovers phone coordinates in five cities', () => {
  for(const p of [[38,114.52],[29.562,106.551],[39.915,116.404],[31.23,121.47],[22.54,114.06]]) {
    close(gcjToWgs(wgsToGcj(p)),p);
  }
});

test('locations outside transform area are unchanged', () => {
  for(const p of [[35.68,139.76],[40.71,-74],[51.51,-0.12],[-33.87,151.21]]) {
    assert.deepEqual(wgsToGcj(p),p);
    assert.deepEqual(gcjToWgs(p),p);
  }
});

test('switching between basemaps does not mutate stored route coordinates', () => {
  const route = [[38,114.52],[38.001,114.521]], original=structuredClone(route);
  for(const source of ['amap','osm','amap']) {
    for(const p of route) close(fromMapCoordinate(toMapCoordinate(p,source),source),p);
  }
  assert.deepEqual(route,original);
});

test('both providers use HTTPS and documented tile order', () => {
  const url=new URL(MAP_SOURCES.amap.tileUrl(16,53615,25279));
  assert.equal(url.protocol,'https:');
  assert.equal(url.hostname,'webst02.is.autonavi.com');
  assert.equal(url.searchParams.get('x'),'53615');
  assert.equal(url.searchParams.get('y'),'25279');
  assert.equal(url.searchParams.get('z'),'16');
  assert.equal(MAP_SOURCES.osm.tileUrl(16,53615,25279),'https://tile.openstreetmap.org/16/53615/25279.png');
});
