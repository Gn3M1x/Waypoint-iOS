// Run with Node 22+, Chrome and Python 3. Optional argument: screenshot directory.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp, mkdir, readFile, writeFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const temp = await mkdtemp(path.join(tmpdir(), 'waypoint-browser-'));
const screenshots = process.argv[2];
const chrome = process.env.CHROME_BIN || ({
  darwin:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  win32:'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
})[process.platform] || 'google-chrome';
const children = [];
async function eventually(fn, message, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await fn();
    if (result) return result;
    await delay(45);
  }
  throw Error(message);
}
function launch(bin, args) {
  const proc = spawn(bin,args,{cwd:root,stdio:['ignore','pipe','pipe']});
  children.push(proc);
  proc.stderr.resume();
  return proc;
}
let ws;
try {
  const demo = launch(process.env.PYTHON || (process.platform==='win32'?'python':'python3'),
    ['app.py','--demo','--no-browser','--data-dir',path.join(temp,'favorites')]);
  let output='';
  demo.stdout.on('data', chunk=>{output+=chunk;});
  const url=await eventually(()=>output.match(/http:\/\/127\.0\.0\.1:\d+\/#token=[\w-]+/)?.[0],'demo startup failed');
  const profile=path.join(temp,'chrome');
  launch(chrome,['--headless=new','--disable-background-timer-throttling','--remote-debugging-port=0',
    '--no-first-run','--no-default-browser-check','--user-data-dir='+profile,'about:blank']);
  const port=await eventually(async()=>{try{return (await readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0];}catch{return null;}},'Chrome startup failed');
  const targets=await (await fetch('http://127.0.0.1:'+port+'/json/list')).json();
  ws=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);
  await once(ws,'open');
  let seq=0;
  const calls=new Map(), errors=[];
  ws.addEventListener('message',e=>{
    const msg=JSON.parse(e.data);
    if(msg.method==='Runtime.exceptionThrown')errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    if(!calls.has(msg.id))return;
    const {ok,fail}=calls.get(msg.id);calls.delete(msg.id);
    msg.error?fail(Error(msg.error.message)):ok(msg.result);
  });
  const send=(method,params={})=>new Promise((ok,fail)=>{
    const id=++seq;calls.set(id,{ok,fail});ws.send(JSON.stringify({id,method,params}));
  });
  async function evaluate(expression) {
    const {result,exceptionDetails}=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
    if(exceptionDetails)throw Error(exceptionDetails.exception?.description||exceptionDetails.text);
    return result.value;
  }
  const el=id=>'document.getElementById('+JSON.stringify(id)+')';
  const value=id=>evaluate(el(id)+'.value');
  const txt=id=>evaluate(el(id)+'.textContent');
  const click=id=>evaluate(el(id)+'.click()');
  const on=(id,event)=>el(id)+'.dispatchEvent(new Event('+JSON.stringify(event)+',{bubbles:true}))';
  const field=(id,v,event='input')=>evaluate(el(id)+'.value='+JSON.stringify(v)+';'+on(id,event));
  const waitText=(id,want)=>eventually(async()=>(await txt(id))===want,id+' expected '+want);
  const frame=()=>evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))');
  const resize=async(width,height)=>{await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});await frame();};
  async function shot(name) {
    if(!screenshots)return;
    await frame();
    await eventually(()=>evaluate('Number(map.dataset.loadedTiles)>0 && map.dataset.loadedTiles===map.dataset.totalTiles'),'screenshot tiles incomplete',18000);
    await mkdir(screenshots,{recursive:true});
    const {data}=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});
    await writeFile(path.join(screenshots,name+'.png'),Buffer.from(data,'base64'));
  }
  async function importFile(name, data) {
    const file=path.join(temp,name);await writeFile(file,data);
    const {root:doc}=await send('DOM.getDocument');
    const {nodeId}=await send('DOM.querySelector',{nodeId:doc.nodeId,selector:'#route-file'});
    await send('DOM.setFileInputFiles',{nodeId,files:[file]});
    await eventually(async()=>!(await value('route-file')),'file not processed');
    await frame();
  }
  async function mouse(type,x,y,buttons=0) {
    await send('Input.dispatchMouseEvent',{type,x,y,buttons,...(type==='mouseMoved'?{}:{button:'left',clickCount:1})});
  }
  const tap=async(x,y)=>{await mouse('mousePressed',x,y,1);await mouse('mouseReleased',x,y);};
  const drag=async(x,y,dx,dy)=>{await mouse('mousePressed',x,y,1);
    for(let i=1;i<=10;i++)await mouse('mouseMoved',x+dx*i/10,y+dy*i/10,1);
    await mouse('mouseReleased',x+dx,y+dy);await frame();};
  async function viewportOK(width,height) {
    const size=await evaluate('({w:document.documentElement.scrollWidth,h:document.documentElement.scrollHeight,map:map.clientHeight,footer:document.querySelector("footer").getBoundingClientRect().bottom})');
    assert.equal(size.w,width);assert.equal(size.h,height);
    assert.ok(size.footer<=height&&size.map>=height*.36,JSON.stringify(size));
  }
  await send('Page.enable');await send('Runtime.enable');
  await resize(1440,900);
  await send('Page.setDownloadBehavior',{behavior:'allow',downloadPath:temp});
  await send('Page.navigate',{url});
  await eventually(()=>evaluate('document.querySelector("#devices")?.value==="demo-only" && !!document.querySelector("#connect:enabled")'),'demo device not ready');
  await click('connect');await waitText('state-label','已就绪');
  await click('mode-route');await drag(620,310,-410,80);
  assert.equal(await txt('point-count'),'0');
  const afterRelease=await txt('map-view');await mouse('mouseMoved',820,360);await frame();
  assert.equal(await txt('map-view'),afterRelease);
  await tap(650,385);await tap(870,460);await tap(990,325);
  await waitText('point-count','3');const original=await value('lat');
  await drag(990,325,-30,48);assert.notEqual(await value('lat'),original);
  await click('undo');assert.equal(await value('lat'),original);
  await click('redo');await click('delete-point');await waitText('point-count','2');
  await click('undo');await click('clear-route');await waitText('point-count','0');
  await click('undo');await waitText('point-count','3');
  // Editing text must not travel through route history.
  assert.equal(await evaluate(el('lat')+'.focus();'+el('lat')+'.dispatchEvent(new KeyboardEvent("keydown",{key:"z",ctrlKey:true,bubbles:true,cancelable:true}))'),true);
  await waitText('point-count','3');
  await evaluate(el('map')+'.focus()');
  const shortcut=(key,modifiers=0)=>send('Input.dispatchKeyEvent',{type:'keyDown',key,modifiers});
  await shortcut('Delete');await waitText('point-count','2');
  await shortcut('z',2);await waitText('point-count','3');
  await shortcut('Z',10);await waitText('point-count','2');
  await shortcut('z',2);await waitText('point-count','3');
  await field('scroll-mode','zoom','change');
  const beforeZoom=await txt('map-view');
  for(let i=0;i<6;i++)await send('Input.dispatchMouseEvent',{type:'mouseWheel',x:820,y:385,deltaX:0,deltaY:-18});
  await frame();assert.notEqual(await txt('map-view'),beforeZoom);
  const camera=await txt('map-view');
  await click('open-search');await click('search-close');
  await click('open-favorites');await click('favorites-close');
  await field('map-source','osm','change');await frame();
  assert.equal(await txt('map-view'),camera);await waitText('point-count','3');
  await field('map-source','amap','change');
  await resize(1280,720);await viewportOK(1280,720);
  assert.equal(await txt('map-view'),camera);
  await resize(390,720);await viewportOK(390,720);assert.equal(await txt('map-view'),camera);
  await resize(1440,900);await viewportOK(1440,900);

  const coords=[[38.0001,114.513],[38.0013,114.513],[38.0032,114.5135],[38.0035,114.517],
    [38.0032,114.5205],[38.0019,114.5206],[38.0004,114.5204],[37.9997,114.5188],[37.9997,114.515]];
  const gpx='<gpx><trk><trkseg>'+coords.map(([a,b])=>'<trkpt lat="'+a+'" lon="'+b+'"/>').join('')+'</trkseg></trk></gpx>';
  await importFile('sample.gpx',gpx);await waitText('point-count','9');
  await click('closed');await field('pace-minutes','5');await field('pace-seconds','30');
  await click('save-route-favorite');await field('favorite-name','演示环线');await click('favorite-submit');
  await eventually(async()=>(await txt('favorites-list')).includes('演示环线'),'save route favorite');
  await click('favorites-close');await click('save-address-favorite');await field('favorite-name','演示终点');await click('favorite-submit');
  await eventually(async()=>(await txt('favorites-list')).includes('演示终点'),'save address favorite');
  await evaluate('document.querySelector(".favorite-load").click()');
  await eventually(()=>evaluate(el('mode-point')+'.getAttribute("aria-pressed")==="true"'),'load address');
  await waitText('sent-position','尚未发送');
  await click('favorites-route-tab');await eventually(async()=>(await txt('favorites-list')).includes('演示环线'),'favorite list');
  await evaluate('document.querySelector(".favorite-load").click()');
  await eventually(()=>evaluate(el('mode-route')+'.getAttribute("aria-pressed")==="true"'),'load route');
  await waitText('sent-position','尚未发送');await click('favorites-close');
  await click('export');
  await eventually(async()=>(await readdir(temp)).includes('waypoint-route.json'),'no JSON export');
  const doc=JSON.parse(await readFile(path.join(temp,'waypoint-route.json'),'utf8'));
  assert.deepEqual(doc.points,coords);assert.equal(doc.motion.pace_seconds,330);assert.equal(doc.motion.randomize,true);
  await click('apply');await waitText('state-label','路线移动中');
  await click('pause');await waitText('state-label','已暂停');
  const held=await txt('sent-position');
  await click('clear-route');await waitText('point-count','0');await waitText('sent-position',held);
  await click('undo');await waitText('point-count','9');await waitText('state-label','已暂停');
  await click('pause');await waitText('state-label','路线移动中');
  await click('restore');await waitText('sent-position','尚未发送');
  await click('mode-point');await field('lat','38.0010');await field('lon','114.5175');
  await waitText('sent-position','尚未发送');await click('apply');await waitText('state-label','保持位置');
  await click('mode-route');
  await waitText('sent-position','38.00100, 114.51750');
  // Let the actual provider settle before recording screenshots.
  await eventually(()=>evaluate(el('map')+'.dataset.loadedTiles==='+el('map')+'.dataset.totalTiles || Number('+el('map')+'.dataset.failedTiles)>0'),'tiles did not settle',18000);
  console.log('Desktop tiles',await evaluate('({...document.getElementById("map").dataset})'));
  await shot('editor-1440');await resize(1280,720);await click('open-favorites');await frame();await shot('favorites-1280');
  await click('favorites-close');await resize(390,720);await click('fit');await frame();await shot('editor-390');
  await resize(1280,720);await click('restore');await waitText('sent-position','尚未发送');
  // Exercise the real drawing path and measure adjacent animation frames after warm-up.
  for(const size of [0,9,2000]) {
    if(!size)await click('clear-route');
    else {
      const points=size===9?coords:Array.from({length:size},(_,i)=>[38+.003*Math.sin(i*2*Math.PI/size),114.52+.004*Math.cos(i*2*Math.PI/size)]);
      await importFile('test.json',JSON.stringify({...doc,points}));
    }
    await waitText('point-count',String(size));await click('mode-browse');
    await frame();const times=await evaluate('new Promise(resolve=>{const t=[];let start=0,n=0;const step=now=>{if(start)t.push(now-start);start=now;document.getElementById("map").dispatchEvent(new WheelEvent("wheel",{deltaX:2,deltaY:1,cancelable:true})); if(++n===65)resolve(t.slice(4));else requestAnimationFrame(step)};document.getElementById("scroll-mode").value="pan";requestAnimationFrame(step)})');
    times.sort((a,b)=>a-b);console.log(size+' points, frame median / p95 (ms)',times[30].toFixed(1),times[56].toFixed(1));
    await click('mode-route');
  }
  await click('disconnect');await waitText('state-label','未连接');
  assert.deepEqual(errors,[]);
  console.log('PASS: captured pointers, history, wheel, drafts, camera, layouts, files, favorites and demo controls');
} finally {
  if(ws)ws.close();
  for(const child of children.reverse()){
    if(child.exitCode===null && child.signalCode===null){
      const stopped=once(child,'exit').catch(()=>{});child.kill();await Promise.race([stopped,delay(2000)]);
    }
  }
  await rm(temp,{recursive:true,force:true,maxRetries:4,retryDelay:200});
}
