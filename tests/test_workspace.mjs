import test from 'node:test';
import assert from 'node:assert/strict';
import {primaryControl, motionKey, sameGeometry, motionChanges, durationLabel} from '../web/workspace.mjs';
import {normaliseMotion} from '../web/motion.mjs';

test('playback controls never restart a moving or paused route when modes or draft validity change',()=>{
  for(const mode of ['browse','point','route'])for(const validRoute of [true,false]){
    assert.equal(primaryControl({connected:true,state:'moving'},mode,{validRoute}).action,'pause');
    assert.equal(primaryControl({connected:true,state:'paused'},mode,{validRoute}).action,'resume');
  }
});
test('completed routes guide recovery and a held single point stays editable',()=>{
  assert.equal(primaryControl({connected:true,state:'holding',route_id:3},'point',{validPoint:true}).action,'clear');
  assert.equal(primaryControl({connected:true,state:'holding',position:[0,0]},'point',{validPoint:true}).action,'set');
});
test('offline, errors, missing devices and invalid drafts have explicit controls',()=>{
  assert.equal(primaryControl({connected:true,state:'moving'},'route',{online:false}).action,null);
  assert.equal(primaryControl({connected:true,state:'error'},'route').action,'clear');
  assert.equal(primaryControl({connected:false},'route',{hasDevice:true}).action,'connect');
  assert.equal(primaryControl({connected:false},'route').action,null);
  assert.equal(primaryControl({connected:true,state:'ready'},'route',{validRoute:false}).action,null);
  assert.equal(primaryControl({connected:true,state:'ready'},'route',{validRoute:true}).action,'route');
});
test('motion comparison uses the chosen units and recognizes unapplied drift edits',()=>{
  const m=normaliseMotion({mode:'pace',pace_seconds:360,drift_enabled:true,drift_radius_meters:2});
  assert.equal(motionKey(m),motionKey({...m,speed:9.999}));
  assert.notEqual(motionKey(m),motionKey({...m,drift_radius_meters:4}));
  assert.match(motionChanges(m,{...m,drift_radius_meters:4}),/2 米 → 4 米/);
});
test('route comparisons include points, closure and laps, independent of motion',()=>{
  const route={points:[[0,0],[0,1]],closed:true,laps:2};
  assert.equal(sameGeometry(route,{...structuredClone(route),motion:{speed:5}}),true);
  for(const changes of [{points:[[0,0],[1,0]]},{closed:false},{laps:3}])assert.equal(sameGeometry(route,{...route,...changes}),false);
  assert.equal(sameGeometry(null,route),false);
  assert.equal(durationLabel(60.1),'1 分 1 秒');
});
