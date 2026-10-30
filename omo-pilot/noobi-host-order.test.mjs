import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const selection=JSON.parse(await fs.readFile(path.join(root,'.irixi-runtime/noobi-specialist/selected.json'),'utf8'));
const {GameHarness,GameHarnessStoppedError,MAX_GAME_HARNESS_REPAIR_ATTEMPTS}=await import(pathToFileURL(path.join(root,'.irixi-runtime/noobi-specialist',selection.directory,'dist/main/gameHarness.js')).href);
const pass=JSON.stringify({verdict:'pass',summary:'Controlled review passed',findings:[]});
const repair=JSON.stringify({verdict:'repair',summary:'Controlled concrete fix',findings:['Fix pause control']});
class Runtime extends EventEmitter {
 constructor(answer){super();this.answer=answer;this.threads=[];this.turns=[];}
 async startThread(options){this.threads.push(options);return `thread-${this.threads.length}`;}
 async startTurn(options){const id=`turn-${this.turns.length+1}`;this.turns.push(options);const text=await this.answer(options,this);queueMicrotask(()=>{this.emit('notification',{method:'item/completed',params:{threadId:options.threadId,turnId:id,item:{type:'agentMessage',text}}});this.emit('notification',{method:'turn/completed',params:{threadId:options.threadId,turnId:id,turn:{id,status:'completed'}}});});return id;}
 async unsubscribeThread(){} async interruptTurn(){} async stop(){}
}
async function fixture(t,answer){const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'noobi-host-order-'));t.after(()=>fs.rm(cwd,{recursive:true,force:true}));const runtime=new Runtime(answer),harness=new GameHarness(runtime),events=[];harness.on('event',e=>events.push(e));return {runtime,harness,events,options:{projectId:'controlled-order',cwd,prompt:'Synthetic host evidence order check. No model.',imageGenerationSkill:{name:'imagegen',path:path.join(cwd,'controlled-imagegen/SKILL.md')},imageGenerationRequirement:{state:'trusted-and-referenced',relativePath:'public/assets/images/synthetic.png'}}};}

test('first host evidence exists before first Reviewer, no unnecessary repair or duplicate host run',async t=>{
 let checks=0,reviewed=false;
 const f=await fixture(t,async o=>{if(o.threadId==='thread-3'){assert.equal(checks,1);assert.equal(await fs.readFile(path.join(f.options.cwd,'fresh-host-evidence.txt'),'utf8'),'current workspace');assert.match(o.prompt,/current_host_delivery status="passed-pending-review"/);reviewed=true;return pass;}return 'Controlled implementation';});
 const result=await f.harness.run({...f.options,validateHostDelivery:async signal=>{assert.equal(signal.aborted,false);checks++;await fs.writeFile(path.join(f.options.cwd,'fresh-host-evidence.txt'),'current workspace');return {ok:true,findings:[]};}});
 assert.equal(reviewed,true);assert.equal(checks,1);assert.equal(result.repairAttempts,0);assert.equal(f.runtime.turns.length,3);assert.equal(result.review.verdict,'pass');
});

test('initial host failure overrides a model pass and is repaired before completion',async t=>{
 let checks=0;
 const f=await fixture(t,async o=>o.threadId==='thread-3'?pass:'Controlled implementation');
 const result=await f.harness.run({...f.options,validateHostDelivery:async()=>++checks===1?{ok:false,findings:['Actual host failed to load the production image']}:{ok:true,findings:[]}});
 assert.equal(result.repairAttempts,1);assert.equal(checks,2);assert.equal(f.runtime.turns.length,5);assert.match(f.runtime.turns[3].prompt,/<authoritative_host_findings>/);assert.match(f.runtime.turns[3].prompt,/Actual host failed to load/);
});

test('Reviewer finding remains required and every repair receives new host checks',async t=>{
 let checks=0,reviews=0;
 const f=await fixture(t,async o=>o.threadId==='thread-3'?(++reviews===1?repair:pass):'Controlled implementation');
 const result=await f.harness.run({...f.options,validateHostDelivery:async()=>{checks++;return checks===2?{ok:false,findings:['Host detected world movement while paused']}:{ok:true,findings:[]};}});
 assert.equal(result.repairAttempts,2);assert.equal(checks,3);assert.equal(reviews,2);assert.match(f.runtime.turns[4].prompt,/<mixed_repair_findings>/);assert.match(f.runtime.turns[4].prompt,/Fix pause control/);assert.match(f.runtime.turns[4].prompt,/Host detected world movement/);
});

test('host failures still exhaust original bounded repair count, never claim completed',async t=>{
 let checks=0;const states=[];
 const f=await fixture(t,async o=>o.threadId==='thread-3'?pass:'Controlled implementation');f.harness.on('state',e=>states.push(e.state));
 await assert.rejects(f.harness.run({...f.options,validateHostDelivery:async()=>{checks++;return {ok:false,findings:['Persistent real host failure']};}}),new RegExp(`Repair limit reached after ${MAX_GAME_HARNESS_REPAIR_ATTEMPTS}`));
 assert.equal(checks,1+MAX_GAME_HARNESS_REPAIR_ATTEMPTS);assert.equal(f.events.filter(e=>e.method==='harness/repair/attempt-started').length,MAX_GAME_HARNESS_REPAIR_ATTEMPTS);assert.equal(states.includes('completed'),false);
});

test('stop cancels the first host gate before Reviewer dispatch',async t=>{
 let entered,signalSeen;const started=new Promise(r=>entered=r);
 const f=await fixture(t,async()=> 'Controlled implementation');
 const running=f.harness.run({...f.options,validateHostDelivery:signal=>new Promise((_resolve,reject)=>{signalSeen=signal;entered();signal.addEventListener('abort',()=>reject(Error('controlled host abort')),{once:true});})});
 await started;assert.equal(f.runtime.turns.length,2);await f.harness.stop(f.options.projectId);await assert.rejects(running,e=>e instanceof GameHarnessStoppedError);assert.equal(signalSeen.aborted,true);assert.equal(f.runtime.turns.length,2);
});

test('host exception fails closed before Reviewer and never fabricates a pass',async t=>{
 let checks=0;const states=[];const f=await fixture(t,async o=>o.threadId==='thread-3'?pass:'Controlled implementation');f.harness.on('state',e=>states.push(e.state));
 await assert.rejects(f.harness.run({...f.options,validateHostDelivery:async()=>{checks++;throw Error('Synthetic preview startup failed');}}),/Synthetic preview startup failed/);
 assert.equal(checks,1);assert.equal(f.runtime.turns.length,2);assert.equal(states.includes('completed'),false);
});

test('no host callback preserves the existing non-controlled contract',async t=>{
 const f=await fixture(t,async o=>o.threadId==='thread-3'?pass:'Controlled implementation');const result=await f.harness.run(f.options);assert.equal(result.repairAttempts,0);assert.equal(f.runtime.turns.length,3);
});

test('initial host and Reviewer failures both survive into the first repair',async t=>{
 let checks=0,reviews=0;
 const f=await fixture(t,async o=>o.threadId==='thread-3'?(++reviews===1?repair:pass):'Controlled implementation');
 const result=await f.harness.run({...f.options,validateHostDelivery:async()=>++checks===1?{ok:false,findings:['Initial host detected missing production image']}:{ok:true,findings:[]}});
 assert.equal(result.repairAttempts,1);assert.equal(checks,2);assert.match(f.runtime.turns[3].prompt,/<mixed_repair_findings>/);assert.match(f.runtime.turns[3].prompt,/Fix pause control/);assert.match(f.runtime.turns[3].prompt,/Initial host detected missing production image/);
});
