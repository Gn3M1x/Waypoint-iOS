import test from 'node:test';
import assert from 'node:assert/strict';
import {normaliseMotion, formatPace, RunningMarker} from '../web/motion.mjs';

test('the optional running overlay only starts during demo route playback',()=>{
  const element = {hidden:true};
  const marker = new RunningMarker(element);
  const moving = {demo:true, state:'moving', position:[38,114.52]};
  marker.update(moving,false);
  marker.update({...moving,demo:false},true);
  marker.update({...moving,state:'holding'},true);
  marker.update({...moving,position:null},true);
  assert.equal(element.hidden,true);
  assert.equal(marker.animation,undefined);
});

test('pace input has the expected units and default smooth random setting',()=>{
  const value=normaliseMotion({mode:'pace',pace_seconds:360});
  assert.equal(value.speed,10);assert.equal(value.randomize,true);assert.equal(value.variation_percent,12);
});
test('pace formatting carries rounded seconds into the next minute',()=>{
  assert.equal(formatPace(359.8),'6′00″/km');assert.equal(formatPace(360),'6′00″/km');assert.equal(formatPace(null),'—');
});
test('invalid imported motion settings are rejected',()=>{
  for(const value of [{mode:'pace',pace_seconds:0},{mode:'pace',pace_seconds:Infinity},{mode:'pace',pace_seconds:360,randomize:'yes'},{mode:'speed',speed:true}])assert.throws(()=>normaliseMotion(value));
});
test('route export and import preserve pace and variation settings',()=>{
  const original=normaliseMotion({mode:'pace',pace_seconds:315,randomize:true,variation_percent:18,drift_enabled:true,drift_radius_meters:3.5});
  assert.deepEqual(normaliseMotion(JSON.parse(JSON.stringify(original))),original);
});

test('legacy routes default to no drift, independently of speed variation',()=>{
  assert.equal(normaliseMotion({mode:'pace',pace_seconds:360}).drift_enabled,false);
  const speed=normaliseMotion({mode:'speed',speed:5,drift_enabled:true,drift_radius_meters:2});
  assert.equal(speed.drift_enabled,true);assert.equal(speed.randomize,false);
  assert.equal(speed.drift_radius_meters,2);
});

test('invalid drift flags and meter ranges are rejected on import',()=>{
  for(const drift_enabled of [null,0,1,'true',[]])assert.throws(()=>normaliseMotion({mode:'speed',speed:5,drift_enabled}));
  for(const drift_radius_meters of [null,true,0,0.49,10.01,NaN,Infinity,'2'])assert.throws(()=>normaliseMotion({mode:'speed',speed:5,drift_radius_meters}));
});
