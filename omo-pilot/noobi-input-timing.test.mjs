import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');const selected=JSON.parse(await fs.readFile(path.join(root,'.irixi-runtime/noobi-specialist/selected.json'),'utf8'));const compiled=await fs.readFile(path.join(root,'.irixi-runtime/noobi-specialist',selected.directory,'dist/main/gameplayExperienceEvaluator.js'),'utf8');
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'noobi-input-test-'));const mod=path.join(temp,'evaluator.mjs');await fs.writeFile(mod,compiled+'\nexport { dispatchAction };\n');const {dispatchAction}=await import(pathToFileURL(mod).href);test.after(()=>fs.rm(temp,{recursive:true,force:true}));
const delay=(ms,signal)=>new Promise((resolve,reject)=>{if(signal?.aborted){reject(signal.reason);return}const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve()},ms);const abort=()=>{clearTimeout(timer);reject(signal.reason)};signal?.addEventListener('abort',abort,{once:true})});
const surface={viewport:{width:1000,height:700},bounds:{x:0,y:0,width:1000,height:700}};
function setup(){const events=[],start=performance.now();return {events,window:{isDestroyed:()=>false,webContents:{sendInputEvent:e=>events.push({...e,ms:performance.now()-start})}}}}
const key={type:'key',code:'ArrowLeft',holdMs:300};
async function run(input,captureDelay,options={}){const f=setup(),controller=options.controller??new AbortController(),timings=[];const sampled=await dispatchAction(f.window,{id:'controlled',label:'controlled',role:'move',inputs:[input]},surface,90,delay,controller.signal,async index=>{await delay(captureDelay,controller.signal);if(options.rejectCapture)throw Error('Synthetic screenshot failure')},timings);return {...f,timings,sampled}}

test('slow capture does not prolong requested key hold; late frames are not claimed as held samples',async()=>{
 const r=await run(key,260);const down=r.events.find(x=>x.type==='keyDown'),up=r.events.find(x=>x.type==='keyUp');const actual=up.ms-down.ms;assert.ok(actual>=280&&actual<460,`key held ${actual}ms`);assert.equal(r.sampled,false);assert.ok(r.timings[0].captureWaitMs>=100);assert.equal(r.timings[0].requestedDurationMs,300);assert.ok(Math.abs(r.timings[0].inputDurationMs-actual)<15);assert.equal(r.timings[0].captures.length,2);assert.ok(r.timings[0].captures.some(s=>s.finishedOffsetMs>r.timings[0].inputDurationMs));
});

test('slow capture does not prolong drag and preserves requested endpoint',async()=>{
 const r=await run({type:'drag',fromXRatio:.1,fromYRatio:.4,toXRatio:.8,toYRatio:.4,button:0,durationMs:300},260);const down=r.events.find(x=>x.type==='mouseDown'),up=r.events.find(x=>x.type==='mouseUp');assert.ok(up.ms-down.ms>=280&&up.ms-down.ms<470,`drag held ${up.ms-down.ms}ms`);assert.equal(up.x,800);assert.equal(up.y,280);assert.equal(r.sampled,false);assert.ok(r.timings[0].captureWaitMs>=100);
});

test('slow capture does not pause look motion and total displacement stays exact',async()=>{
 const r=await run({type:'look',deltaX:120,deltaY:-30,durationMs:300},260);assert.ok(r.timings[0].inputDurationMs<470);assert.equal(Math.round(r.events.reduce((n,e)=>n+(e.movementX||0),0)),120);assert.equal(Math.round(r.events.reduce((n,e)=>n+(e.movementY||0),0)),-30);assert.equal(r.sampled,false);
});

test('fast captures still provide two genuine held samples',async()=>{
 const r=await run(key,10);assert.equal(r.sampled,true);assert.equal(r.timings[0].captures.length,2);assert.ok(r.timings[0].captures.every(x=>x.finishedOffsetMs<r.timings[0].inputDurationMs));assert.ok(r.timings[0].inputDurationMs<460);
});

test('screenshot failure is returned after releasing input and is never treated as evidence',async()=>{
 const f=setup(),timings=[];await assert.rejects(dispatchAction(f.window,{inputs:[key]},surface,90,delay,new AbortController().signal,async()=>{await delay(180);throw Error('Synthetic screenshot failure')},timings),/Synthetic screenshot failure/);assert.equal(f.events.at(-1).type,'keyUp');assert.ok(f.events.at(-1).ms<460);assert.ok(timings[0].captures.every(x=>x.status==='failed'));
});

test('stop releases key and drains pending captures without a late key-down',async()=>{
 const f=setup(),controller=new AbortController(),timings=[];const timer=setTimeout(()=>controller.abort(Error('controlled stop')),140);await assert.rejects(dispatchAction(f.window,{inputs:[key]},surface,90,delay,controller.signal,()=>delay(1000,controller.signal),timings),/controlled stop/);clearTimeout(timer);assert.equal(f.events.at(-1).type,'keyUp');assert.ok(f.events.at(-1).ms<240);assert.equal(f.events.filter(x=>x.type==='keyDown').length,1);assert.equal(timings[0].captures[0].status,'failed');
});

test('stop releases drag while capture is pending',async()=>{
 const f=setup(),controller=new AbortController(),timings=[];const timer=setTimeout(()=>controller.abort(Error('controlled drag stop')),140);await assert.rejects(dispatchAction(f.window,{inputs:[{type:'drag',fromXRatio:.1,fromYRatio:.4,toXRatio:.8,toYRatio:.4,button:0,durationMs:300}]},surface,90,delay,controller.signal,()=>delay(1000,controller.signal),timings),/controlled drag stop/);clearTimeout(timer);assert.equal(f.events.at(-1).type,'mouseUp');assert.ok(f.events.at(-1).ms<240);
});

test('short key, wait and pointer retain normal semantics and report separate input timing',async()=>{
 const f=setup(),timings=[];let captures=0;const sampled=await dispatchAction(f.window,{inputs:[{type:'key',code:'Space',holdMs:0},{type:'wait',ms:30},{type:'pointer',xRatio:.5,yRatio:.5,button:0}]},surface,90,delay,new AbortController().signal,async()=>captures++,timings);assert.equal(sampled,false);assert.equal(captures,0);assert.deepEqual(timings.map(t=>t.requestedDurationMs),[90,30,0]);assert.equal(f.events.at(-1).type,'mouseUp');
});


test('release failure drains every capture and preserves the release error',async()=>{
 for(const input of [key,{type:'drag',fromXRatio:.1,fromYRatio:.4,toXRatio:.8,toYRatio:.4,button:0,durationMs:300}]) for(const captureFails of [false,true]){
  const f=setup(),timings=[];let started=0,finished=0;const releaseError=Error('Synthetic release failure');const send=f.window.webContents.sendInputEvent;
  f.window.webContents.sendInputEvent=e=>{send(e);if(e.type==='keyUp'||e.type==='mouseUp')throw releaseError;};
  await assert.rejects(dispatchAction(f.window,{inputs:[input]},surface,90,delay,new AbortController().signal,async()=>{started++;try{await delay(260);if(captureFails)throw Error('Synthetic capture failure');}finally{finished++;}},timings),e=>e===releaseError);
  assert.equal(started,2);assert.equal(finished,started);assert.equal(timings.length,1);assert.ok(timings[0].captureWaitMs>=100);const after=finished;await delay(40);assert.equal(finished,after);
 }
});
