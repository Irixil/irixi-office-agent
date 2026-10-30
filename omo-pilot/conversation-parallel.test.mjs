import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ConversationStore } from './conversation-store.mjs';
import { runParallelWork, validateParallelRequest, recoverParallelWork } from './conversation-parallel.mjs';
import { fileIndex, copyProject, mergeProjectTrees, applyProjectDelta, rollbackAdoption, directoryIdentity } from './conversation-project.mjs';
import { guardWorkspaceToolCalls } from './codex-provider-protocol.mjs';
import { nativeRoleTools, runOmoNativeRpcRole } from './native-rpc-runner.mjs';
const catalogue = { models: [{ provider: 'desktop-codex', id: 'gpt-6-luna', efforts: ['medium'], defaultEffort: 'medium' }] };
const selection = { provider: 'desktop-codex', model: 'gpt-6-luna', effort: 'medium' };
const response = (text) => ({ status: 'model_returned', output: { text } });
const request = { requestId: 'parallel-test', tasks: [{ task: 'write a', writePaths: ['a.txt'] }, { task: 'write b', writePaths: ['b.txt'] }] };
async function fixture(t, options={}) {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'n6-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const store=new ConversationStore({runtimeDir:root,catalogueReader:async()=>catalogue,...options});await store.init();const c=await store.create({requestId:'new'});
 const workspace=path.join(root,'parent-copy');await fs.mkdir(workspace);await fs.writeFile(path.join(workspace,'a.txt'),'old a');await fs.writeFile(path.join(workspace,'b.txt'),'old b');
 const turn={id:'turn-parent',requestId:'parent',text:'test',intent:'execute',status:'working',workspace,projectId:'project-test',modelSelection:selection,children:[],events:[],calls:[],receipts:[],processes:[]};c.turns.push(turn);await store.save();
 return {root,store,c,turn,workspace};
}
const gate = (root, name, filename, writeScope=['a.txt']) => guardWorkspaceToolCalls({content:[{type:'toolCall',name,arguments:{path:filename}}]}, {rootPath:root,role:'Developer',conversation:true,writeScope});
test('写助手文件权限为实际宿主约束，拒绝命令、越界、范围外edit和链接',async(t)=>{
 const f=await fixture(t);await gate(f.workspace,'write','a.txt');await gate(f.workspace,'edit','a.txt');
 await assert.rejects(gate(f.workspace,'edit','b.txt'),/writable paths/);await assert.rejects(gate(f.workspace,'write','../a.txt'),/traversal/);await assert.rejects(gate(f.workspace,'bash','a.txt'),/不能执行命令/);
 await fs.symlink('b.txt',path.join(f.workspace,'link.txt'));await assert.rejects(gate(f.workspace,'write','link.txt',['link.txt']),/symlink/);
 assert.deepEqual(nativeRoleTools('Developer',true,['a.txt']).names,['read','write','edit','grep','find','ls']);
 assert.throws(()=>validateParallelRequest({...request,tasks:[{task:'x',writePaths:['.git/config']},request.tasks[1]]}),/普通相对/);
});
test('先登记再并发；共同起点、独立副本、组合结果、幂等与原目录保护',async(t)=>{
 let release;const barrier=new Promise(r=>release=r);let started=0;const observed=[];
 const f=await fixture(t,{omoRunner:async(options)=>{const saved=JSON.parse(await fs.readFile(f.store.file));assert.equal(saved.conversations[0].turns[0].children.length,2);observed.push(options);if(++started===2)release();await barrier;await fs.writeFile(path.join(options.cwd,options.writeScope[0]),'new '+options.writeScope[0]);return response('实际文件已写，待父检查');}});
 const result=await runParallelWork(f.store,f.c,f.turn,request,f.workspace,new AbortController().signal);assert.equal(result.status,'composed');assert.equal(started,2);assert.notEqual(observed[0].cwd,observed[1].cwd);assert.deepEqual(f.turn.children[0].sourceIndex,f.turn.children[1].sourceIndex);assert.ok(f.turn.children.every(c=>c.startedAt<=f.turn.children.reduce((x,y)=>x<y.finishedAt?x:y.finishedAt,'9999')));
 assert.equal(await fs.readFile(path.join(f.workspace,'a.txt'),'utf8'),'new a.txt');assert.equal(await fs.readFile(path.join(f.workspace,'b.txt'),'utf8'),'new b.txt');assert.equal((await runParallelWork(f.store,f.c,f.turn,request,f.workspace,new AbortController().signal)).replayed,true);assert.equal(started,2);
 await fs.writeFile(path.join(f.workspace,'a.txt'),'later parent');await runParallelWork(f.store,f.c,f.turn,request,f.workspace,new AbortController().signal);assert.equal(await fs.readFile(path.join(f.workspace,'a.txt'),'utf8'),'later parent');
});
test('登记保存失败不派工；子轮失败等待全部退出且不组合',async(t)=>{
 let calls=0;const f=await fixture(t,{omoRunner:async()=>{calls++;throw new Error('controlled child failure');}});const save=f.store.save.bind(f.store);f.store.save=async()=>{throw new Error('disk failure');};await assert.rejects(runParallelWork(f.store,f.c,f.turn,request,f.workspace,new AbortController().signal),/disk failure/);assert.equal(calls,0);assert.equal(f.turn.children.length,0);f.store.save=save;
 await assert.rejects(runParallelWork(f.store,f.c,f.turn,request,f.workspace,new AbortController().signal),/controlled child failure|已停止/);assert.equal(await fs.readFile(path.join(f.workspace,'a.txt'),'utf8'),'old a');assert.equal(f.turn.parallelGroups[0].status,'failed');assert.ok(f.turn.children.every(c=>!['working','creating'].includes(c.status)));
});
test('取消后迟到助手内容保留在其副本，不组合，不重派',async(t)=>{
 let release;const barrier=new Promise(r=>release=r);let entered=0;let all;const both=new Promise(r=>all=r);const f=await fixture(t,{omoRunner:async(o)=>{if(++entered===2)all();await barrier;await fs.writeFile(path.join(o.cwd,o.writeScope[0]),'late');return response('late');}});const controller=new AbortController();const job=runParallelWork(f.store,f.c,f.turn,request,f.workspace,controller.signal);await both;controller.abort();release();await assert.rejects(job,/已停止/);assert.equal(await fs.readFile(path.join(f.workspace,'a.txt'),'utf8'),'old a');assert.equal(f.turn.parallelGroups[0].status,'stopped');assert.equal(entered,2);await assert.rejects(runParallelWork(f.store,f.c,f.turn,request,f.workspace,new AbortController().signal),/不重复派工/);
});
for(const git of [false,true]) test(`三方组合保留不同位置人工修改并保留同处冲突；${git?'Git':'非Git'}不改版本库`,async(t)=>{
 const f=await fixture(t);const base=path.join(f.root,'base'),ours=path.join(f.root,'ours'),theirs=path.join(f.root,'theirs');for(const d of [base,ours,theirs])await fs.mkdir(d);
 const text='first\n2\n3\n4\n5\n6\n7\nlast\n';for(const d of [base,ours,theirs])await fs.writeFile(path.join(d,'x.txt'),text);
 if(git)execFileSync('/usr/bin/git',['-C',theirs,'init'],{stdio:'ignore'});
 await fs.writeFile(path.join(ours,'x.txt'),text.replace('first','agent'));await fs.writeFile(path.join(theirs,'x.txt'),text.replace('last','human'));
 const target=path.join(f.root,'combined');assert.equal((await mergeProjectTrees({base,ours,theirs,target})).conflicts.length,0);assert.equal(await fs.readFile(path.join(target,'x.txt'),'utf8'),text.replace('first','agent').replace('last','human'));
 await fs.writeFile(path.join(theirs,'x.txt'),text.replace('first','human'));const conflict=await mergeProjectTrees({base,ours,theirs,target:path.join(f.root,'conflict')});assert.equal(conflict.conflicts.length,1);assert.match(await fs.readFile(path.join(f.root,'conflict/x.txt'),'utf8'),/<<<<<<< candidate/);assert.equal(await fs.readFile(path.join(theirs,'x.txt'),'utf8'),text.replace('first','human'));assert.equal(await fs.stat(path.join(theirs,'.git')).then(()=>true,()=>false),git);assert.equal(await fs.stat(path.join(target,'.git')).then(()=>true,()=>false),false);
});
test('采用挂起保存时人工改动不会被覆盖；保存失败回滚且保留后来人工内容',async(t)=>{
 const f=await fixture(t);const candidate=path.join(f.root,'candidate');const before=await fileIndex(f.workspace);await copyProject(f.workspace,candidate,before);await fs.writeFile(path.join(candidate,'a.txt'),'agent a');await fs.writeFile(path.join(candidate,'b.txt'),'agent b');
 let record={};await assert.rejects(applyProjectDelta(record,{root:f.workspace,candidate,before,directory:path.join(f.root,'txn1'),save:async()=>{if(record.commit?.pending?.name==='a.txt')await fs.writeFile(path.join(f.workspace,'a.txt'),'human later');}}),/文件已被修改/);assert.equal(await fs.readFile(path.join(f.workspace,'a.txt'),'utf8'),'human later');assert.equal(await fs.readFile(path.join(f.workspace,'b.txt'),'utf8'),'old b');
 await fs.writeFile(path.join(f.workspace,'a.txt'),'old a');record={};await assert.rejects(applyProjectDelta(record,{root:f.workspace,candidate,before,directory:path.join(f.root,'txn2'),save:async()=>{if(record.commit?.applied.length===1){await fs.writeFile(path.join(f.workspace,'a.txt'),'human after first apply');throw new Error('controlled save failure');}}}),/controlled save failure/);assert.equal(await fs.readFile(path.join(f.workspace,'a.txt'),'utf8'),'human after first apply');assert.equal(await fs.readFile(path.join(f.workspace,'b.txt'),'utf8'),'old b');assert.equal(record.commit.status,'recovery_conflict');
});
test('采用取消、重启回滚与已采用幂等不重写后续用户成果',async(t)=>{
 const f=await fixture(t);const before=await fileIndex(f.workspace);const candidate=path.join(f.root,'candidate');await copyProject(f.workspace,candidate,before);await fs.writeFile(path.join(candidate,'a.txt'),'agent');const record={};const controller=new AbortController();await assert.rejects(applyProjectDelta(record,{root:f.workspace,candidate,before,directory:path.join(f.root,'txn'),signal:controller.signal,save:async()=>{if(record.commit?.applied.length===1)controller.abort();}}),/已停止/);assert.equal(await fs.readFile(path.join(f.workspace,'a.txt'),'utf8'),'old a');
 const committed={};await applyProjectDelta(committed,{root:f.workspace,candidate,before,directory:path.join(f.root,'commit'),save:async()=>{}});await fs.writeFile(path.join(f.workspace,'a.txt'),'human after complete');await applyProjectDelta(committed,{root:f.workspace,candidate,before,directory:path.join(f.root,'ignored'),save:async()=>{throw new Error('must not save');}});assert.equal(await fs.readFile(path.join(f.workspace,'a.txt'),'utf8'),'human after complete');
 const displaced=path.join(f.root,'displaced.txt');await fs.writeFile(displaced,'interrupted old');await fs.writeFile(path.join(f.workspace,'a.txt'),'candidate');const crash={before:{'a.txt':'unused'},commit:{scheme:'preserve-displaced-v1',status:'applying',root:f.workspace,rootIdentity:await directoryIdentity(f.workspace),backup:f.root,after:await fileIndex(f.workspace),entries:[{name:'a.txt',started:true,displaced}]}};await rollbackAdoption(crash);assert.equal(await fs.readFile(path.join(f.workspace,'a.txt'),'utf8'),'interrupted old');const parent={parallelGroups:[{status:'working',children:[]}]};await recoverParallelWork(parent);assert.equal(parent.parallelGroups[0].status,'interrupted');
});

// Optional integration: actual OmO processes and actual file-tool receipts.
// All decisions below are scripted; there is no Codex CLI or real model call.
test('真实OmO双写入进程并发，脚本决策通过实际read/write工具修改各自范围',{skip:process.env.IRIXI_RUN_NATIVE_TOOL_TESTS!=='1'},async(t)=>{
 const runtime=process.env.IRIXI_NATIVE_RUNTIME;assert.ok(runtime,'explicit isolated OmO installation required');let first=0;let release;const barrier=new Promise(r=>release=r);const counts=new Map();
 const f=await fixture(t,{omoRunner:o=>runOmoNativeRpcRole({...o,homeDir:path.join(runtime,'home'),executable:path.join(runtime,'bin/omo'),timeoutMs:45000}),modelRunner:async(o)=>{
   const key=o.binding.executionId;const n=(counts.get(key)||0)+1;counts.set(key,n);const child=f.turn.children.find(c=>c.id===key);assert.ok(child);assert.deepEqual(o.providerTools.map(t=>t.name).sort(),['edit','find','grep','ls','read','write']);
   const record=await o.reserve({id:key+'-'+n,controlled:true});if(n===1){if(++first===2)release();await barrier;}
   const content=n===1?[{type:'toolCall',name:'read',arguments:{path:child.writePaths[0]}}]:n===2?[{type:'toolCall',name:'write',arguments:{path:child.writePaths[0],content:'native '+child.writePaths[0]}}]:[{type:'text',text:'范围内已写入，联合检查由父完成。'}];
   const result={status:'model_returned',output:{text:JSON.stringify({content})},sessionId:'scripted-decision-'+key};await o.settle(record,result);return result;
 }});
 const result=await runParallelWork(f.store,f.c,f.turn,request,f.workspace,new AbortController().signal);assert.equal(result.status,'composed');assert.equal(first,2);assert.equal(counts.size,2);assert.ok([...counts.values()].every(n=>n===3));
 for(const child of f.turn.children){assert.ok(child.processes.length>0);assert.ok(child.receipts.some(r=>r.eventType==='end'&&r.toolName==='read'&&!r.isError));assert.ok(child.receipts.some(r=>r.eventType==='end'&&r.toolName==='write'&&!r.isError));}
 const [a,b]=f.turn.children;assert.ok(a.startedAt<b.finishedAt&&b.startedAt<a.finishedAt);assert.equal(await fs.readFile(path.join(f.workspace,'a.txt'),'utf8'),'native a.txt');assert.equal(await fs.readFile(path.join(f.workspace,'b.txt'),'utf8'),'native b.txt');
 if(process.env.IRIXI_NATIVE_EVIDENCE){await fs.mkdir(process.env.IRIXI_NATIVE_EVIDENCE,{recursive:true});await fs.writeFile(path.join(process.env.IRIXI_NATIVE_EVIDENCE,'actual-native-parallel.json'),JSON.stringify({method:'actual OmO with scripted decisions, no product model',result,children:f.turn.children},null,2));}
});
for(const recheck of [true,false]) test(`原目录后改先三方组合${recheck?'重新检查后采用':'没有新检查则拒绝采用'}`,async(t)=>{
 let runs=0;let original;const f=await fixture(t,{omoRunner:async(o)=>{
  if(o.decisionOnly)return response(JSON.stringify({mode:'execute',reply:'开始',title:'组合',readPaths:[]}));
  runs++;
  if(runs===1){await fs.writeFile(path.join(o.cwd,'result.txt'),'agent\n2\n3\n4\n5\n6\nlast\n');await o.onBehaviorCheck({requestId:'first',caseJson:JSON.stringify({caseId:'result',requirement:'包含agent',kind:'document',target:'result.txt',expected:{includes:['agent']}})},o.signal);await fs.writeFile(path.join(original,'result.txt'),'first\n2\n3\n4\n5\n6\nhuman\n');}
  else {assert.match(await fs.readFile(path.join(o.cwd,'result.txt'),'utf8'),/agent[\s\S]*human/);if(recheck)await o.onBehaviorCheck({requestId:'second',caseJson:JSON.stringify({caseId:'result',requirement:'包含agent',kind:'document',target:'result.txt',expected:{includes:['agent']}})},o.signal);}
  return response('已处理，检查见真实回执');
 }});
 f.c.turns=[];original=path.join(f.root,'original');await fs.mkdir(original);await fs.writeFile(path.join(original,'result.txt'),'first\n2\n3\n4\n5\n6\nlast\n');await f.store.bindProject(f.c.id,{requestId:'project',path:original});await f.store.send(f.c.id,{requestId:'start',text:'直接改第一行'});while(f.store.jobs.size)await Promise.all([...f.store.jobs.values()]);
 assert.equal(runs,2);const turn=f.c.turns[0];assert.equal(turn.status,recheck?'completed':'failed');const output=await fs.readFile(path.join(original,'result.txt'),'utf8');assert.match(output,/human/);assert.equal(output.includes('agent'),recheck);assert.equal(turn.functionalChecks.length,recheck?2:1);if(recheck)assert.notEqual(turn.functionalChecks[0].version,turn.functionalChecks[1].version);
});

test('实际OmO父工具派工、双助手、联合失败、修复和新版本检查全链',{skip:process.env.IRIXI_RUN_NATIVE_TOOL_TESTS!=='1'},async(t)=>{
 const runtime=process.env.IRIXI_NATIVE_RUNTIME;let started=0;let release;const barrier=new Promise(r=>release=r);const counts=new Map();
 const batch={tasks:[{task:'write main',writePaths:['main.mjs']},{task:'write math',writePaths:['math.mjs']}]};
 const check={caseId:'joint',requirement:'联合运行两文件得到6',kind:'cli',target:'main.mjs',runner:'node',arguments:[],expected:{stdoutEquals:'6\n',exitCode:0}};
 const f=await fixture(t,{omoRunner:o=>runOmoNativeRpcRole({...o,homeDir:path.join(runtime,'home'),executable:path.join(runtime,'bin/omo'),timeoutMs:45000}),modelRunner:async(o)=>{
  const key=o.binding.executionId,n=(counts.get(key)||0)+1;counts.set(key,n);const child=f.turn.children.find(c=>c.id===key);let block;
  if(child){if(n===1){if(++started===2)release();await barrier;}const filename=child.writePaths[0];block=n===1?{type:'toolCall',name:'read',arguments:{path:filename}}:n===2?{type:'toolCall',name:'write',arguments:{path:filename,content:filename==='main.mjs'?"import { double } from './math.mjs'; console.log(double(3));\n":"export const twice = (value) => value * 2;\n"}}:{type:'text',text:'写入完成，待父联合检查'};}
  else {assert.equal(key,f.turn.id);block=n===1?{type:'toolCall',name:'delegate_parallel',arguments:batch}:n===2||n===4?{type:'toolCall',name:'verify_behavior',arguments:{caseJson:JSON.stringify(check)}}:n===3?{type:'toolCall',name:'edit',arguments:{path:'math.mjs',oldText:'twice',newText:'double'}}:{type:'text',text:'联合运行检查通过，已修正接口名称冲突'};}
  const record=await o.reserve({controlled:true});const result=response(JSON.stringify({content:[block]}));await o.settle(record,result);return result;
 }});
 await fs.writeFile(path.join(f.workspace,'main.mjs'),'// baseline main\n');await fs.writeFile(path.join(f.workspace,'math.mjs'),'// baseline math\n');f.turn.before=await fileIndex(f.workspace);
 const text=await f.store.role(f.c,f.turn,'Developer','受控脚本驱动真实OmO工具，不调用模型。',f.workspace,[],new AbortController().signal);
 assert.match(text,/联合运行检查通过/);assert.equal(f.turn.children.length,2);assert.ok(f.turn.receipts.some(r=>r.eventType==='end'&&r.toolName==='delegate_parallel'&&!r.isError));assert.deepEqual(f.turn.functionalChecks.map(c=>c.status),['failed','passed']);assert.notEqual(f.turn.functionalChecks[0].version,f.turn.functionalChecks[1].version);assert.deepEqual(new Set(f.turn.functionalChecks[1].coveredFiles),new Set(['main.mjs','math.mjs']));
 if(process.env.IRIXI_NATIVE_EVIDENCE)await fs.writeFile(path.join(process.env.IRIXI_NATIVE_EVIDENCE,'actual-native-parent-combination.json'),JSON.stringify({method:'actual OmO parent/children/tools and actual CLI behavior checks; scripted model decisions',turn:f.turn},null,2));
});

test('重启恢复link发布后的半步，清除自有临时链接并还原原文件',async(t)=>{
 const f=await fixture(t),target=path.join(f.workspace,'a.txt'),displaced=path.join(f.root,'original-a'),temp=path.join(f.workspace,'.irixi-test.tmp');await fs.rename(target,displaced);await fs.writeFile(temp,'candidate');await fs.link(temp,target);const stat=await fs.stat(temp);
 const record={before:{'a.txt':'old-digest'},commit:{scheme:'preserve-displaced-v1',status:'applying',root:f.workspace,rootIdentity:await directoryIdentity(f.workspace),backup:f.root,after:{'a.txt':(await import('node:crypto')).createHash('sha256').update('candidate').digest('hex')},entries:[{name:'a.txt',started:true,displaced,temp,tempIno:stat.ino,tempDev:stat.dev}]}};
 await rollbackAdoption(record);assert.equal(await fs.readFile(target,'utf8'),'old a');assert.equal((await fs.stat(target)).nlink,1);assert.equal(await fs.stat(temp).then(()=>true,()=>false),false);assert.equal(record.commit.status,'rolled_back');
});
test('组合最终保存失败撤回父候选，两个助手副本仍可查',async(t)=>{
 const f=await fixture(t,{omoRunner:async(o)=>{await fs.writeFile(path.join(o.cwd,o.writeScope[0]),'new');return response('saved candidate');}});const save=f.store.save.bind(f.store);f.store.save=async()=>{if(f.turn.parallelGroups?.[0]?.status==='composed')throw new Error('last save fails');return save();};await assert.rejects(runParallelWork(f.store,f.c,f.turn,request,f.workspace,new AbortController().signal),/last save fails/);assert.equal(await fs.readFile(path.join(f.workspace,'a.txt'),'utf8'),'old a');assert.equal(await fs.readFile(path.join(f.workspace,'b.txt'),'utf8'),'old b');for(const child of f.turn.children)assert.equal(await fs.readFile(path.join(child.workspace,child.writePaths[0]),'utf8'),'new');
});

test('实际OmO精确范围允许edit，范围外write被宿主拒绝',{skip:process.env.IRIXI_RUN_NATIVE_TOOL_TESTS!=='1'},async(t)=>{
 const runtime=process.env.IRIXI_NATIVE_RUNTIME,f=await fixture(t),receipts=[];let calls=0;
 const options={role:'Developer',conversation:true,writeScope:['a.txt'],cwd:f.workspace,prompt:'Controlled real tool scope check',homeDir:path.join(runtime,'home'),executable:path.join(runtime,'bin/omo'),timeoutMs:30000,onToolReceipt:r=>receipts.push(r)};
 await runOmoNativeRpcRole({...options,runModelDecision:async()=>JSON.stringify({content:[++calls===1?{type:'toolCall',name:'edit',arguments:{path:'a.txt',oldText:'old a',newText:'edited a'}}:{type:'text',text:'范围内修改已完成'}]})});
 assert.equal(await fs.readFile(path.join(f.workspace,'a.txt'),'utf8'),'edited a');assert.ok(receipts.some(r=>r.toolName==='edit'&&r.eventType==='end'&&!r.isError));
 const prior=receipts.length;await assert.rejects(runOmoNativeRpcRole({...options,runModelDecision:async()=>JSON.stringify({content:[{type:'toolCall',name:'write',arguments:{path:'b.txt',content:'forbidden'}}]})}),/writable paths/);assert.equal(await fs.readFile(path.join(f.workspace,'b.txt'),'utf8'),'old b');assert.equal(receipts.slice(prior).some(r=>r.toolName==='write'&&r.eventType==='end'&&!r.isError),false);
 if(process.env.IRIXI_NATIVE_EVIDENCE)await fs.writeFile(path.join(process.env.IRIXI_NATIVE_EVIDENCE,'actual-native-write-scope.json'),JSON.stringify({method:'actual native edit and rejected outside write; scripted decisions',receipts},null,2));
});
test('实际双OmO停止后进程已退出，晚回复不组合',{skip:process.env.IRIXI_RUN_NATIVE_TOOL_TESTS!=='1'},async(t)=>{
 const runtime=process.env.IRIXI_NATIVE_RUNTIME;let entered=0,ready;const both=new Promise(r=>ready=r);
 const f=await fixture(t,{omoRunner:o=>runOmoNativeRpcRole({...o,homeDir:path.join(runtime,'home'),executable:path.join(runtime,'bin/omo'),timeoutMs:30000}),modelRunner:async(o)=>{if(++entered===2)ready();await new Promise((resolve,reject)=>{o.signal.addEventListener('abort',()=>reject(new Error('controlled pending decision cancelled')),{once:true});if(o.signal.aborted)reject(new Error('cancelled'));});return response('must not return');}});
 const controller=new AbortController(),job=runParallelWork(f.store,f.c,f.turn,request,f.workspace,controller.signal);await both;controller.abort();await assert.rejects(job,/cancelled|停止/);assert.equal(await fs.readFile(path.join(f.workspace,'a.txt'),'utf8'),'old a');assert.equal(f.turn.parallelGroups[0].status,'stopped');
 for(const child of f.turn.children)for(const process of child.processes)assert.throws(()=>globalThis.process.kill(process.pid,0));
 if(process.env.IRIXI_NATIVE_EVIDENCE)await fs.writeFile(path.join(process.env.IRIXI_NATIVE_EVIDENCE,'actual-native-cancel.json'),JSON.stringify({method:'two actual OmO processes; scripted waiting decisions; OS exit checked',children:f.turn.children,group:f.turn.parallelGroups[0]},null,2));
});

test('回滚最后一步遇用户替换，保留用户字节而不按旧检查删除',async(t)=>{
 const f=await fixture(t),before=await fileIndex(f.workspace),candidate=path.join(f.root,'candidate');await copyProject(f.workspace,candidate,before);await fs.writeFile(path.join(candidate,'a.txt'),'agent');const record={};const rename=fs.rename;let injected=false;
 fs.rename=async(from,to)=>{if(!injected&&to.includes('rollback-displaced-')){injected=true;await fs.writeFile(from,'human during rollback');}return rename(from,to);};
 try {await assert.rejects(applyProjectDelta(record,{root:f.workspace,candidate,before,directory:path.join(f.root,'txn'),save:async()=>{if(record.commit?.applied.length===1)throw new Error('rollback trigger');}}),/rollback trigger/);}finally{fs.rename=rename;}
 assert.equal(injected,true);assert.equal(await fs.readFile(path.join(f.workspace,'a.txt'),'utf8'),'human during rollback');assert.equal(record.commit.status,'recovery_conflict');
});

test('写入协助者保留独立同事归属，原工作负责人不变',async(t)=>{
 const f=await fixture(t,{omoRunner:async(o)=>{await fs.writeFile(path.join(o.cwd,o.writeScope[0]),'done');return response('done');}});f.c.work.ownerId='writer';f.turn.colleagueId='writer';
 await runParallelWork(f.store,f.c,f.turn,{...request,tasks:[{...request.tasks[0],colleagueId:'steward'},{...request.tasks[1],colleagueId:'archivist'}]},f.workspace,new AbortController().signal);
 assert.equal(f.c.work.ownerId,'writer');assert.deepEqual(f.turn.children.map(c=>c.colleagueId),['steward','archivist']);assert.ok(f.turn.children.every(c=>c.workId===f.c.work.id&&c.projectId===f.turn.projectId&&c.parentTurnId===f.turn.id));
});

for (const replaceAncestor of [false,true]) test(`保存等待时${replaceAncestor?'根目录祖先':'项目根目录'}被替换为同内容外目录链接，采用与回滚不越界`,async(t)=>{
 const f=await fixture(t), holder=path.join(f.root,'selected'), root=path.join(holder,'project'), outside=path.join(f.root,'outside'), candidate=path.join(f.root,'candidate');
 await fs.mkdir(root,{recursive:true});await fs.writeFile(path.join(root,'a.txt'),'old');await fs.mkdir(path.join(outside,'project'),{recursive:true});await fs.writeFile(path.join(outside,'a.txt'),'old');await fs.writeFile(path.join(outside,'project/a.txt'),'old');
 const before=await fileIndex(root);await copyProject(root,candidate,before);await fs.writeFile(path.join(candidate,'a.txt'),'agent');const record={};let replaced=false;
 await assert.rejects(applyProjectDelta(record,{root,candidate,before,directory:path.join(f.root,'txn-root-swap'),save:async()=>{if(!replaced&&record.commit?.pending){replaced=true;const from=replaceAncestor?holder:root;await fs.rename(from,from+'-held');await fs.symlink(replaceAncestor?outside:outside,from);}}}),/目录身份/);
 assert.equal(replaced,true);assert.equal(await fs.readFile(path.join(outside,'a.txt'),'utf8'),'old');assert.equal(await fs.readFile(path.join(outside,'project/a.txt'),'utf8'),'old');assert.equal(record.commit.status,'recovery_conflict');
 await rollbackAdoption(record);assert.equal(await fs.readFile(path.join(outside,'a.txt'),'utf8'),'old');assert.equal(await fs.readFile(path.join(outside,'project/a.txt'),'utf8'),'old');
});
test('部分采用后根路径被换，恢复保留备份而不向替换目录回滚',async(t)=>{
 const f=await fixture(t), before=await fileIndex(f.workspace), candidate=path.join(f.root,'candidate'),outside=path.join(f.root,'outside');await copyProject(f.workspace,candidate,before);await copyProject(f.workspace,outside,before);await fs.writeFile(path.join(candidate,'a.txt'),'agent');await fs.writeFile(path.join(outside,'a.txt'),'agent');const record={};let replaced=false;
 await assert.rejects(applyProjectDelta(record,{root:f.workspace,candidate,before,directory:path.join(f.root,'txn-partial'),save:async()=>{if(!replaced&&record.commit?.applied?.length){replaced=true;await fs.rename(f.workspace,f.workspace+'-held');await fs.symlink(outside,f.workspace);throw new Error('controlled save after swap');}}}),/controlled save after swap/);
 assert.equal(record.commit.status,'recovery_conflict');assert.equal(await fs.readFile(path.join(outside,'a.txt'),'utf8'),'agent');assert.equal(await fs.readFile(path.join(record.commit.backup,'a.txt'),'utf8'),'old a');
});
test('复制目标祖先在异步复制期间被换，不继续在替换目录落笔',async(t)=>{
 const f=await fixture(t),holder=path.join(f.root,'copy-holder'),target=path.join(holder,'copy'),outside=path.join(f.root,'outside');await fs.mkdir(holder);await fs.mkdir(path.join(outside,'copy'),{recursive:true});await fs.writeFile(path.join(outside,'copy/a.txt'),'external a');await fs.writeFile(path.join(outside,'copy/b.txt'),'external b');const index=await fileIndex(f.workspace),originalCopy=fs.copyFile;let swapped=false;
 fs.copyFile=async(...args)=>{const result=await originalCopy(...args);if(!swapped&&String(args[1]).startsWith(target+path.sep)){swapped=true;await fs.rename(holder,holder+'-held');await fs.symlink(outside,holder);}return result;};
 try{await assert.rejects(copyProject(f.workspace,target,index),/目录身份/);}finally{fs.copyFile=originalCopy;}
 assert.equal(swapped,true);assert.equal(await fs.readFile(path.join(outside,'copy/a.txt'),'utf8'),'external a');assert.equal(await fs.readFile(path.join(outside,'copy/b.txt'),'utf8'),'external b');
});
test('同一文件两处文本冲突作为可修候选保留，而非误报git合并工具失败',async(t)=>{
 const f=await fixture(t),base=path.join(f.root,'base-two'),ours=path.join(f.root,'ours-two'),theirs=path.join(f.root,'theirs-two'),target=path.join(f.root,'combined-two');const text='first\n'+Array.from({length:20},(_,i)=>'line '+i).join('\n')+'\nlast\n';
 for(const dir of [base,ours,theirs]){await fs.mkdir(dir);await fs.writeFile(path.join(dir,'x.txt'),text);}
 await fs.writeFile(path.join(ours,'x.txt'),text.replace('first','agent first').replace('last','agent last'));await fs.writeFile(path.join(theirs,'x.txt'),text.replace('first','human first').replace('last','human last'));
 const result=await mergeProjectTrees({base,ours,theirs,target});assert.equal(result.conflicts.length,1);assert.equal((await fs.readFile(path.join(target,'x.txt'),'utf8')).match(/^<<<<<<< candidate/gm).length,2);
});
