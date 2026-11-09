import test from 'node:test';
import assert from 'node:assert/strict';
import {normaliseMotion, formatPace} from '../web/motion.mjs';

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
  const original=normaliseMotion({mode:'pace',pace_seconds:315,randomize:true,variation_percent:18});
  assert.deepEqual(normaliseMotion(JSON.parse(JSON.stringify(original))),original);
});
