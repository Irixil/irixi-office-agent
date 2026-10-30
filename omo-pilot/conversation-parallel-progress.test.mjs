import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ConversationStore } from './conversation-store.mjs';
import { runParallelWork } from './conversation-parallel.mjs';
import { fileIndex, copyProject, applyProjectDelta, rollbackAdoption } from './conversation-project.mjs';
const selection={provider:'desktop-codex',model:'gpt-6-luna',effort:'medium'};
const response=text=>({status:'model_returned',output:{text}});
async function fixture(t,options={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'n6-independent-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const store=new ConversationStore({runtimeDir:root,catalogueReader:async()=>({models:[{provider:selection.provider,id:selection.model,efforts:['medium'],defaultEffort:'medium'}]}),...options});await store.init();const c=await store.create({requestId:'new'});
 const workspace=path.join(root,'copy');await fs.mkdir(workspace);for(const name of ['a','b','c'])await fs.writeFile(path.join(workspace,name),`old ${name}`);
 const turn={id:'parent',requestId:'parent',text:'work',intent:'execute',status:'working',workspace,projectId:'project',modelSelection:selection,children:[],events:[],calls:[],receipts:[],processes:[],before:await fileIndex(workspace)};c.turns.push(turn);await store.save();return {root,store,c,turn,workspace};
}
test('only real role tool callbacks propagate; no timer and no callback after abort',async t=>{
 let progress=0,received;const ctl=new AbortController();const f=await fixture(t,{omoRunner:async o=>{received=o;await new Promise(r=>setTimeout(r,30));assert.equal(progress,0);await o.onToolReceipt({eventType:'end',toolName:'read',isError:false});assert.equal(progress,1);ctl.abort();await o.onToolReceipt({eventType:'end',toolName:'read',isError:false});assert.equal(progress,1);return response('read completed');}});
 try{await f.store.role(f.c,f.turn,'Developer','controlled',f.workspace,[],ctl.signal,false,{onProgress:()=>progress++});}catch(e){assert.match(e.message,/停止/);}
 assert.ok(received);assert.equal(progress,1);
});
test('parallel helper events reach parent callback; stop prevents late activity and adoption',async t=>{
 let progress=0,entered=0,release,ready;const barrier=new Promise(r=>release=r),both=new Promise(r=>ready=r);const ctl=new AbortController();const f=await fixture(t);
 f.store.role=async(_c,_child,_role,_prompt,cwd,_read,_signal,_decision,activity)=>{if(++entered===2)ready();await barrier;activity.onProgress();await fs.writeFile(path.join(cwd,entered===1?'a':'b'),'late');return 'late';};
 const job=runParallelWork(f.store,f.c,f.turn,{requestId:'group',tasks:[{task:'a',writePaths:['a']},{task:'b',writePaths:['b']}]},f.workspace,ctl.signal,{onProgress:()=>progress++});
 await both;ctl.abort();release();await assert.rejects(job,/停止/);assert.equal(progress,0);assert.equal(f.turn.lastProgressAt,undefined);assert.equal(await fs.readFile(path.join(f.workspace,'a'),'utf8'),'old a');
});
test('save failure restores transaction-owned edits but retains later human edits across serialized recovery',async t=>{
 const f=await fixture(t),candidate=path.join(f.root,'candidate'),before=await fileIndex(f.workspace);await copyProject(f.workspace,candidate,before);await fs.writeFile(path.join(candidate,'a'),'agent a');await fs.writeFile(path.join(candidate,'b'),'agent b');await fs.unlink(path.join(candidate,'c'));const record={};
 await assert.rejects(applyProjectDelta(record,{root:f.workspace,candidate,before,directory:path.join(f.root,'txn'),save:async()=>{if(record.commit?.applied.includes('a')){await fs.writeFile(path.join(f.workspace,'b'),'human b');throw Error('fault after first apply');}}}),/fault/);
 assert.equal(await fs.readFile(path.join(f.workspace,'a'),'utf8'),'old a');assert.equal(await fs.readFile(path.join(f.workspace,'b'),'utf8'),'human b');assert.equal(await fs.readFile(path.join(f.workspace,'c'),'utf8'),'old c');
 const saved=JSON.parse(JSON.stringify(record));await rollbackAdoption(saved);assert.equal(await fs.readFile(path.join(f.workspace,'b'),'utf8'),'human b');
});
