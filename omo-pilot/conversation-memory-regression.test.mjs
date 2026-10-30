import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConversationStore } from './conversation-store.mjs';
import { effectiveMemories } from './conversation-memory.mjs';
const catalogue={models:[{id:'gpt-6-luna',provider:'desktop-codex',efforts:['medium'],defaultEffort:'medium'}]};
const reply=text=>({status:'model_returned',output:{text},sessionId:'controlled-repair-regression'});
const route=(actions=[],mode='discuss')=>reply(JSON.stringify({mode,reply:'受控回复',readPaths:[],memoryActions:actions}));
const gate=()=>{let release;const promise=new Promise(r=>release=r);return{promise,release};};
const forbidden=()=>{throw Error('No product model permitted');};
async function bounded(p){let timer;try{return await Promise.race([p,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('fixture timeout')),5000))]);}finally{clearTimeout(timer);}}
async function drain(s){while(s.jobs.size)await bounded(Promise.all([...s.jobs.values()]));}
let sequence=0;
const memory=(s,body)=>s.manageMemory({requestId:`mem-${++sequence}`,expectedRevision:s.state.memory.revision,...body});
const create={operation:'create',key:'report',title:'汇报',text:'简短中文',kind:'preference',scopeType:'personal'};
async function setup(t,runner){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'irixi-memory-repair-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const s=new ConversationStore({runtimeDir:dir,omoRunner:runner,modelRunner:forbidden,noobiRunner:forbidden,catalogueReader:async()=>catalogue});await s.init();const c=await s.create({requestId:'create',colleagueId:'writer'});return{s,c,dir};}

test('停用的同源迟到 create 被拒绝，新的明确恢复仍保留原条目和范围',async t=>{
 const actions=[];const f=await setup(t,async o=>o.decisionOnly?route(actions.shift()):reply('受控阅读'));
 async function send(text,command){actions.push(command);const turn=await f.s.send(f.c.id,{requestId:`send-${++sequence}`,text});await drain(f.s);return turn;}
 const original=await send('以后汇报请用短句。',[{...create,sourceQuote:'以后汇报请用短句。'}]);const e=f.s.state.memory.entries[0];
 await memory(f.s,{operation:'deactivate',memoryId:e.id,expectedVersion:e.version});
 await assert.rejects(f.s.manageMemory({...create,requestId:'late-source',expectedRevision:f.s.state.memory.revision,conversationId:f.c.id,sourceQuote:'以后汇报请用短句。'},original),/已停用/);
 const resumed=await send('恢复这条汇报偏好。',[{operation:'restore',memoryId:e.id,expectedVersion:2,sourceQuote:'恢复这条汇报偏好。'}]);
 assert.equal(resumed.memoryActions[0].status,'saved');assert.equal(f.s.state.memory.entries.length,1);assert.equal(f.s.state.memory.entries[0].id,e.id);assert.equal(effectiveMemories(f.s.state,f.c,resumed)[0].text,'简短中文');
});

test('实际只读子轮收到旧记忆后停止所属父作业，不停另一项活跃工作',async t=>{
 const otherEntered=gate(),otherRelease=gate(),childEntered=gate(),childRelease=gate();let f,otherOptions,childOptions,created;
 f=await setup(t,async o=>{
  if(o.decisionOnly && o.prompt.includes('OTHER_ACTIVE_915')) {otherOptions=o;otherEntered.release();await otherRelease.promise;return route();}
  if(o.decisionOnly)return route([],'execute');
  if(o.role==='Developer') {
   created=await memory(f.s,create);
   await o.onDelegate({requestId:'child',task:'仅核对 seed.txt',paths:['seed.txt']},o.signal);
   return reply('受控父轮结束');
  }
  childOptions=o;childEntered.release();await childRelease.promise;return reply('受控子轮结束');
 });
 const other=await f.s.create({requestId:'other',colleagueId:'writer'});await f.s.send(other.id,{requestId:'other-send',text:'OTHER_ACTIVE_915 先讨论'});await bounded(otherEntered.promise);
 const project=path.join(f.dir,'project');await fs.mkdir(project);await fs.writeFile(path.join(project,'seed.txt'),'synthetic sentinel');await f.s.bindProject(f.c.id,{requestId:'bind',path:project});
 const parent=await f.s.send(f.c.id,{requestId:'execute',text:'请执行只读核对'});await bounded(childEntered.promise);const child=parent.children[0];
 assert.equal(parent.memoryUses.flatMap(x=>x.entries).length,0);assert.equal(child.memoryUses[0].entries[0].id,created.changedId);
 const response=await memory(f.s,{operation:'deactivate',memoryId:created.changedId,expectedVersion:1,stopAffected:true});
 assert.deepEqual(response.affectedRuns.map(x=>x.turnId),[child.id]);assert.equal(childOptions.signal.aborted,true);assert.equal(parent.status,'stopping');assert.equal(child.status,'stopping');assert.equal(otherOptions.signal.aborted,false);
 childRelease.release();otherRelease.release();await drain(f.s);assert.equal(parent.status,'stopped');assert.equal(child.status,'stopped');assert.equal(other.turns[0].status,'completed');
});

test('运行树扫描包含成果轮和递归子轮；控制器单位夹具不扩大到其他成果轮',async t=>{
 // Structural fixture: containers/controllers only, not a real artifact/model execution claim.
 const f=await setup(t,forbidden);const created=await memory(f.s,create);
 const controller=new AbortController(),unrelated=new AbortController();
 const nested={id:'nested-memory-user',status:'working',children:[],memoryUses:[{entries:[{id:created.changedId,version:1}]}]};
 const affected={id:'artifact-parent',status:'working',children:[{id:'middle',status:'working',children:[nested]}]};
 const other={id:'artifact-other',status:'working',children:[]};f.c.artifactRuns=[affected,other];f.s.controllers.set(affected.id,controller);f.s.controllers.set(other.id,unrelated);
 const response=await memory(f.s,{operation:'delete',memoryId:created.changedId,expectedVersion:1,stopAffected:true});
 assert.deepEqual(response.affectedRuns.map(x=>x.turnId),[nested.id]);assert.equal(controller.signal.aborted,true);assert.equal(unrelated.signal.aborted,false);assert.equal(affected.status,'stopping');assert.equal(nested.status,'stopping');assert.equal(other.status,'working');
});

test('省略未变字段的自然 edit 仍须满足原长期范围；本次例外不能覆盖个人偏好',async t=>{
 const actions=[];const f=await setup(t,async o=>o.decisionOnly?route(actions.shift()):reply('受控回复'));
 const made=await memory(f.s,create);
 actions.push([{operation:'edit',memoryId:made.changedId,expectedVersion:1,title:'汇报',text:'本次详细',sourceQuote:'这次汇报改为详细说明。'}]);
 const temporary=await f.s.send(f.c.id,{requestId:'temporary-edit',text:'这次汇报改为详细说明。'});await drain(f.s);
 assert.equal(temporary.memoryActions[0].status,'not_saved');assert.equal(effectiveMemories(f.s.state,f.c,{id:'next'})[0].text,'简短中文');
 actions.push([{operation:'edit',memoryId:made.changedId,expectedVersion:1,title:'汇报',text:'以后详细',sourceQuote:'以后汇报改为详细说明。'}]);
 const lasting=await f.s.send(f.c.id,{requestId:'lasting-edit',text:'以后汇报改为详细说明。'});await drain(f.s);
 assert.equal(lasting.memoryActions[0].status,'saved');assert.equal(effectiveMemories(f.s.state,f.c,{id:'next'})[0].text,'以后详细');
});

test('实际交接接收轮收到旧记忆，立即停止应用能找到其控制器',async t=>{
 const entered=gate(),release=gate();let options;
 const f=await setup(t,async o=>{options=o;entered.release();await release.promise;return reply('{}');});t.after(()=>release.release());
 const made=await memory(f.s,create);const transfer=await f.s.handoff(f.c.id,{requestId:'transfer',to:'archivist',expectedOwnerRevision:f.c.work.ownerRevision});await bounded(entered.promise);
 const result=await memory(f.s,{operation:'delete',memoryId:made.changedId,expectedVersion:1,stopAffected:true});
 assert.deepEqual(result.affectedRuns.map(x=>x.turnId),[transfer.receiverId]);assert.equal(options.signal.aborted,true);assert.equal(result.affectedRuns[0].status,'stopping');assert.match(result.notice,/退出确认前/);
 release.release();await drain(f.s);assert.equal(f.c.handoffRuns[0].status,'stopped');
});

test('删除后的旧规则不进入新交接自动上下文，原聊天正文不删除',async t=>{
 const quote='以后汇报使用唯一标记 DELETED_RULE_HANDOFF_628。';const prompts=[];let first=true;
 const f=await setup(t,async o=>{prompts.push(o.prompt);if(o.decisionOnly){const actions=first?[{...create,text:'DELETED_RULE_HANDOFF_628',sourceQuote:quote}]:[];first=false;return route(actions);}return reply('{}');});
 await f.s.send(f.c.id,{requestId:'save-rule',text:quote});await drain(f.s);const e=f.s.state.memory.entries[0];await memory(f.s,{operation:'delete',memoryId:e.id,expectedVersion:1});
 await f.s.handoff(f.c.id,{requestId:'handoff',to:'archivist',expectedOwnerRevision:f.c.work.ownerRevision});await drain(f.s);
 assert.doesNotMatch(prompts.at(-1),/DELETED_RULE_HANDOFF_628/);assert.equal(f.c.messages.find(m=>m.role==='user').text,quote);assert.equal(effectiveMemories(f.s.state,f.c,{}).length,0);
});
