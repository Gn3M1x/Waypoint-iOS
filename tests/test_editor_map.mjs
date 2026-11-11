import test from 'node:test';
import assert from 'node:assert/strict';
import {EditorMap, History, project, unproject} from '../web/editor-map.mjs';

function fixture(source='amap') {
  const m=Object.create(EditorMap.prototype);
  const calls=[];
  Object.assign(m,{width:900,height:600,zoom:16,center:[38,114.52],source,
    projections:new WeakMap(),hover:-1,drag:null,draw(){},
    canvas:{getBoundingClientRect:()=>({left:0,top:0}),focus(){},setPointerCapture(){},hasPointerCapture:()=>false,
      classList:{add(){},remove(){},toggle(){}}},
    events:{scene:()=>({points:[],mode:'route'}),pick:p=>calls.push(p),scrollZoom:()=>false}});
  return {m,calls};
}
function samePoint(actual,expected) {
  for(let i=0;i<2;i++)assert.ok(Math.abs(actual[i]-expected[i])<1e-8);
}
const pointer=(x,y,buttons=1,id=1)=>({isPrimary:true,button:0,buttons,pointerId:id,clientX:x,clientY:y});

test('continuous cursor zoom preserves the same WGS84 target on both providers',()=>{
  for(const source of ['amap','osm']){
    const {m}=fixture(source), anchor=[113,451], expected=m.coordinate(anchor);
    for(let i=0;i<90;i++){
      m.zoomAt(m.zoom+(i<45?.037:-.037),anchor);
      samePoint(m.coordinate(anchor),expected);
    }
    samePoint(unproject(project(expected,source),source),expected);
  }
});
test('released, cancelled and interrupted drags cannot pick or stick',()=>{
  const {m,calls}=fixture();
  m.down(pointer(20,60));m.move(pointer(-50,180));m.up(pointer(-95,190,0));
  assert.equal(m.drag,null);assert.deepEqual(calls,[]);
  const center=m.center;m.move(pointer(666,222,0));assert.equal(center,m.center);
  m.down(pointer(20,60));m.move(pointer(80,160,0));assert.equal(m.drag,null);
  m.down(pointer(20,60));m.cancel();m.up(pointer(20,60,0));assert.deepEqual(calls,[]);
  m.down(pointer(20,60));m.up(pointer(22,60,0));assert.equal(calls.length,1);
});
test('only the captured primary pointer can commit a point move',()=>{
  const {m,calls}=fixture();const points=[m.center];
  m.events.scene=()=>({points,mode:'route'});
  m.events.move=(index,p)=>calls.push({index,p});
  m.down(pointer(450,300));m.move(pointer(520,330,1,3));m.up(pointer(520,330,0,3));
  assert.equal(m.drag.moved,false);
  m.move(pointer(500,330));assert.deepEqual(calls,[]);
  m.up(pointer(500,330,0));assert.equal(calls.length,1);assert.equal(calls[0].index,0);
  samePoint(calls[0].p,m.coordinate([500,330]));samePoint(m.center,[38,114.52]);
});
test('trackpad pan consumes both axes and a pinch preserves its anchor',()=>{
  const {m}=fixture();const start=m.coordinate([470,312]);let consumed=0;
  const wheel={preventDefault:()=>consumed++,deltaX:20,deltaY:12,deltaMode:0,clientX:110,clientY:140};
  m.wheel(wheel);samePoint(m.center,start);
  const before=m.coordinate([110,140]),z=m.zoom;
  m.wheel({...wheel,ctrlKey:true,deltaY:-4});assert.ok(m.zoom>z);
  samePoint(before,m.coordinate([110,140]));assert.equal(consumed,2);
});
test('history restores selection and discards redo after a new edit',()=>{
  const history=new History(), first={points:[],index:-1}, second={points:[[38,114]],index:0};
  history.record(first);assert.equal(history.step(second),first);
  assert.equal(history.step(first,true),second);assert.equal(history.step(second),first);
  history.record(first);assert.equal(history.step(second,true),null);
  history.reset();assert.equal(history.step(first),null);
});
