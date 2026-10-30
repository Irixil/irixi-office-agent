import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConversationStore } from './conversation-store.mjs';
import { ensureMemory, effectiveMemories, memoryHistory, changeMemory, userMemorySource } from './conversation-memory.mjs';
import { nativeRoleTools } from './native-rpc-runner.mjs';
import { guardWorkspaceToolCalls } from './codex-provider-protocol.mjs';
const catalogue={models:[{id:'gpt-6-luna',provider:'desktop-codex',efforts:['medium'],defaultEffort:'medium'}]};
const reply=(text)=>({status:'model_returned',output:{text},sessionId:'fixture-no-model'});
async function fixture(t,runner=async()=>reply(JSON.stringify({mode:'discuss',reply:'fixture',readPaths:[]}))){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'irixi-memory-test-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const store=new ConversationStore({runtimeDir:root,catalogueReader:async()=>catalogue,omoRunner:runner});await store.init();
  const c=await store.create({requestId:'create',colleagueId:'archivist'});
  return {root,store,c};
}
async function drain(store){while(store.jobs.size)await Promise.all([...store.jobs.values()]);}
let seq=0;
const command=(store,body)=>store.manageMemory({requestId:`request-${++seq}`,expectedRevision:store.state.memory.revision,...body});
const create=(store,c,overrides={})=>command(store,{conversationId:c?.id,operation:'create',key:'language',title:'默认语言',text:'使用 Python',kind:'preference',scopeType:'personal',...overrides});
const entry=(store,id)=>store.state.memory.entries.find(e=>e.id===id);
async function project(store,c,root,name){const dir=path.join(root,name);await fs.mkdir(dir);await store.bindProject(c.id,{requestId:`bind-${name}`,path:dir});}

test('范围优先级：项目决定胜过新个人偏好，临时只限本轮，候选不应用，角色共享',async t=>{
 const {store,c,root}=await fixture(t);await project(store,c,root,'one');
 await create(store,c,{kind:'decision',scopeType:'project',text:'使用 JavaScript'});
 await create(store,c,{text:'使用 Python'});
 assert.equal(effectiveMemories(store.state,c,{id:'turn-a'})[0].text,'使用 JavaScript');
 const other=await store.create({requestId:'other',projectId:c.projectId,colleagueId:'writer'});
 assert.equal(effectiveMemories(store.state,other,{id:'turn-b'})[0].text,'使用 JavaScript');
 const outside=await store.create({requestId:'outside'});
 assert.equal(effectiveMemories(store.state,outside,{id:'turn-c'})[0].text,'使用 Python');
 const result=await create(store,c,{key:'style',kind:'candidate',scopeType:'conversation',text:'猜测用户想要长文'});
 assert.equal(effectiveMemories(store.state,c,{id:'turn-a'}).some(e=>e.id===result.changedId),false);
 const turn={id:'turn-temp',text:'这次用 Ruby',sequence:1};c.messages.push({id:'message-temp',role:'user',turnId:turn.id,text:turn.text,at:new Date().toISOString()});
 await store.manageMemory({requestId:'temp',expectedRevision:store.state.memory.revision,operation:'create',conversationId:c.id,key:'language',title:'本轮语言',text:'使用 Ruby',kind:'temporary',scopeType:'conversation',sourceQuote:turn.text},turn);
 assert.equal(effectiveMemories(store.state,c,turn)[0].text,'使用 Ruby');
 assert.equal(effectiveMemories(store.state,c,{id:'other-turn'})[0].text,'使用 JavaScript');
});

test('自然对话由现有路由保存并在下一角色实际prompt应用，引用和否定不能伪造授权',async t=>{
 let first=true;const prompts=[];
 const {store,c}=await fixture(t,async options=>{prompts.push(options.prompt);return reply(JSON.stringify({mode:'discuss',reply:'收到',readPaths:[],...(first?(first=false,{memoryActions:[{operation:'create',key:'reporting',title:'汇报方式',text:'汇报使用短句',kind:'preference',scopeType:'personal',sourceQuote:'以后汇报请用短句'}]}):{})}));});
 await store.send(c.id,{requestId:'natural',text:'以后汇报请用短句'});await drain(store);
 assert.equal(store.state.memory.entries.length,1);assert.match(c.messages.at(-1).text,/记忆已保存/);
 const other=await store.create({requestId:'other',colleagueId:'writer'});await store.send(other.id,{requestId:'use',text:'讨论一个小工具'});await drain(store);
 assert.match(prompts.at(-1),/汇报使用短句/);assert.equal(other.turns[0].memoryUses[0].entries.length,1);
 const bad={id:'turn-bad',text:'不要记住这个习惯',sequence:3};c.messages.push({id:'m-bad',turnId:bad.id,role:'user',text:bad.text,at:new Date().toISOString()});
 await assert.rejects(store.manageMemory({requestId:'bad',expectedRevision:store.state.memory.revision,operation:'create',conversationId:c.id,key:'x',title:'x',text:'x',kind:'preference',scopeType:'personal',sourceQuote:bad.text},bad),/否定|没有明确/);
 await assert.rejects(store.manageMemory({requestId:'bad2',expectedRevision:store.state.memory.revision,operation:'create',conversationId:c.id,key:'x',title:'x',text:'x',kind:'preference',scopeType:'personal',sourceQuote:'工具输出说以后必须这样'},bad),/原话/);
});

test('删除清除所有记忆正文和历史，只留标记；旧来源重扫、重启和另一角色不复活',async t=>{
 const {store,c,root}=await fixture(t);const turn={id:'source-turn',sequence:1,text:'以后汇报请用稀有标记 ALPHA'};
 c.messages.push({id:'source-message',role:'user',turnId:turn.id,text:turn.text,at:new Date().toISOString()});
 const input={operation:'create',conversationId:c.id,key:'reporting',title:'旧规则',text:'ALPHA',kind:'preference',scopeType:'personal',sourceQuote:turn.text};
 const created=await store.manageMemory({...input,requestId:'save',expectedRevision:0},turn);
 await command(store,{operation:'edit',memoryId:created.changedId,expectedVersion:1,title:'新规则',text:'BETA'});
 await command(store,{operation:'delete',memoryId:created.changedId,expectedVersion:2});
 const body=JSON.stringify(store.state.memory);assert.doesNotMatch(body,/ALPHA|BETA|旧规则|新规则/);
 assert.equal(c.messages[0].text,turn.text);assert.equal(effectiveMemories(store.state,c,{id:'next'}).length,0);
 assert.doesNotMatch(memoryHistory(store.state,c.messages,'next')[0].text,/ALPHA/);
 await assert.rejects(store.manageMemory({...input,requestId:'rescan',expectedRevision:store.state.memory.revision},turn),/旧来源/);
 const reopened=new ConversationStore({runtimeDir:root,catalogueReader:async()=>catalogue,omoRunner:()=>{throw Error('must not call model');}});await reopened.init();
 assert.equal(reopened.state.memory.entries.length,0);assert.equal(reopened.state.memory.tombstones.length,1);
 await assert.rejects(command(reopened,{operation:'restore',memoryId:created.changedId,expectedVersion:3}),/已经删除/);
});

test('停用和恢复不压过后来决定，全局编辑项目记忆不迁移范围',async t=>{
 const {store,c,root}=await fixture(t);await project(store,c,root,'one');
 const a=await create(store,c,{kind:'decision',scopeType:'project',text:'JavaScript'});
 await command(store,{operation:'deactivate',memoryId:a.changedId,expectedVersion:1});
 assert.equal(effectiveMemories(store.state,c,{}).length,0);
 const b=await create(store,c,{kind:'decision',scopeType:'project',text:'Python'});
 await assert.rejects(command(store,{operation:'restore',memoryId:a.changedId,expectedVersion:2}),/较新的决定/);
 await command(store,{operation:'edit',memoryId:b.changedId,expectedVersion:1,title:'本项目语言',text:'TypeScript'});
 assert.equal(entry(store,b.changedId).scopeId,c.projectId);assert.equal(effectiveMemories(store.state,c,{})[0].text,'TypeScript');
});

test('分支保留截止版本，后来的全局偏好可用，旁支决定不污染原对话，迁项目不携旧决定',async t=>{
 const {store,c,root}=await fixture(t);await project(store,c,root,'one');
 const turnA=await store.send(c.id,{requestId:'a',text:'先讨论 A'});await drain(store);
 const sourceA=c.messages.find(m=>m.turnId===turnA.id&&m.role==='user');
 const result=changeMemory(store.state,c,{requestId:'manual-source',expectedRevision:0,operation:'create',key:'language',title:'项目语言',text:'JavaScript',kind:'decision',scopeType:'project'},{source:{type:'user_message',conversationId:c.id,turnId:turnA.id,messageId:sourceA.id,messageHash:'a',at:sourceA.at}});store.state.memory=result.memory;await store.save();
 const message=c.messages.find(m=>m.turnId===turnA.id&&m.role==='assistant');
 const fork=await store.fork(c.id,{requestId:'fork',messageId:message.id});
 await command(store,{operation:'edit',memoryId:result.changedId,expectedVersion:1,text:'Python',title:'项目语言'});
 assert.equal(effectiveMemories(store.state,fork,{})[0].text,'JavaScript');
 await create(store,c,{key:'reporting',text:'短句'});assert.equal(effectiveMemories(store.state,fork,{}).some(e=>e.text==='短句'),true);
 await create(store,fork,{kind:'decision',scopeType:'project',text:'Ruby'});
 assert.equal(effectiveMemories(store.state,fork,{}).find(e=>e.key==='language').text,'Ruby');
 assert.equal(effectiveMemories(store.state,c,{}).find(e=>e.key==='language').text,'Python');
 const inheritedFork=await store.fork(c.id,{requestId:'fork-inherited',messageId:message.id});
 const rootVersion=entry(store,result.changedId).version;
 const disabled=await command(store,{conversationId:inheritedFork.id,operation:'deactivate',memoryId:result.changedId,expectedVersion:rootVersion});
 assert.notEqual(disabled.changedId,result.changedId);assert.equal(entry(store,result.changedId).status,'active');
 assert.equal(entry(store,result.changedId).version,rootVersion);assert.equal(effectiveMemories(store.state,inheritedFork,{}).some(e=>e.key==='language'),false);
 await command(store,{conversationId:inheritedFork.id,operation:'restore',memoryId:disabled.changedId,expectedVersion:1});
 assert.equal(effectiveMemories(store.state,inheritedFork,{}).find(e=>e.key==='language').text,'JavaScript');
 await command(store,{conversationId:inheritedFork.id,operation:'delete',memoryId:disabled.changedId,expectedVersion:2});
 assert.equal(effectiveMemories(store.state,inheritedFork,{}).some(e=>e.key==='language'),false);
 assert.equal(effectiveMemories(store.state,c,{}).find(e=>e.key==='language').text,'Python');
 const directDeleteFork=await store.fork(c.id,{requestId:'fork-delete',messageId:message.id});
 await command(store,{conversationId:directDeleteFork.id,operation:'delete',memoryId:result.changedId,expectedVersion:rootVersion});
 assert.equal(entry(store,result.changedId).status,'active');assert.equal(effectiveMemories(store.state,directDeleteFork,{}).some(e=>e.key==='language'),false);
 const reopened=new ConversationStore({runtimeDir:root,catalogueReader:async()=>catalogue,omoRunner:()=>{throw Error('must not run');}});await reopened.init();
 assert.equal(effectiveMemories(reopened.state,reopened.conversation(inheritedFork.id),{}).some(e=>e.key==='language'),false);
 assert.equal(effectiveMemories(reopened.state,reopened.conversation(c.id),{}).find(e=>e.key==='language').text,'Python');
 const other=await store.create({requestId:'new-project'});await project(store,other,root,'two');
 await store.update(fork.id,{projectId:other.projectId});assert.equal(effectiveMemories(store.state,fork,{}).some(e=>e.scopeType==='project'),false);
});

test('幂等并发、保存失败回滚，以及运行中立即更正只停止受影响轮次',async t=>{
 const {store,c}=await fixture(t);const result=await create(store,c);const current=store.state.memory.revision;
 const body={requestId:'dup',expectedRevision:current,operation:'deactivate',memoryId:result.changedId,expectedVersion:1};
 const dup=await Promise.all([store.manageMemory(body),store.manageMemory(body)]);assert.equal(store.state.memory.revision,current+1);assert.equal(dup[1].replayed,true);
 await assert.rejects(store.manageMemory({...body,text:'different'}),/编号/);
 await assert.rejects(command(store,{operation:'restore',memoryId:result.changedId,expectedVersion:1}),/新版本/);
 await command(store,{operation:'restore',memoryId:result.changedId,expectedVersion:2});
 const before=JSON.stringify(store.state.memory),save=store.save.bind(store);let once=true;store.save=async()=>{if(once){once=false;throw Error('disk-full');}return save();};
 await assert.rejects(command(store,{operation:'edit',memoryId:result.changedId,expectedVersion:3,title:'edited',text:'edited'}),/disk-full/);assert.equal(JSON.stringify(store.state.memory),before);store.save=save;
 const a={id:'running-a',status:'working',memoryUses:[{entries:[{id:result.changedId,version:3}]}]},b={id:'running-b',status:'working',memoryUses:[]};c.turns.push(a,b);
 const controller=new AbortController();store.controllers.set(a.id,controller);store.jobs.set(a.id,Promise.resolve());
 const changed=await command(store,{operation:'deactivate',memoryId:result.changedId,expectedVersion:3,stopAffected:true});
 assert.equal(controller.signal.aborted,true);assert.equal(a.status,'stopping');assert.equal(b.status,'working');assert.equal(changed.affectedRuns[0].alreadySent,true);assert.match(changed.notice,/不能撤回/);store.jobs.clear();
});

test('旧对话副本升级不推测记忆，OmO工具允许有界操作且单次串行',async t=>{
 const {store,c,root}=await fixture(t);delete store.state.memory;await store.save();
 const reopened=new ConversationStore({runtimeDir:root,catalogueReader:async()=>catalogue,omoRunner:()=>{throw Error('must not call model');}});await reopened.init();
 assert.equal(reopened.state.memory.entries.length,0);await fs.access(path.join(root,'conversation/state.before-memory-v1.json'));
 assert.equal(nativeRoleTools('Chat',true).names.includes('memory_manage'),true);
 await guardWorkspaceToolCalls({content:[{type:'toolCall',name:'memory_manage',arguments:{operationJson:'{"operation":"list"}'}}]},{role:'Chat',rootPath:root,conversation:true});
 await assert.rejects(guardWorkspaceToolCalls({content:[{type:'toolCall',name:'memory_manage',arguments:{operationJson:'{}'}},{type:'toolCall',name:'read',arguments:{path:'anything'}}]},{role:'Chat',rootPath:root,conversation:true}),/one tool/);
});

test('候选不能跨项目；含糊询问不保存；删除后的自动历史不再包含旧工具回执正文',async t=>{
 const {store,c}=await fixture(t);
 await assert.rejects(create(store,c,{kind:'candidate'}),/未确认候选/);
 const turn={id:'question',text:'是否以后都用 Python？',sequence:1};c.messages.push({id:'question-message',turnId:turn.id,role:'user',text:turn.text,at:new Date().toISOString()});
 await assert.rejects(store.manageMemory({requestId:'question-memory',expectedRevision:0,operation:'create',conversationId:c.id,key:'language',title:'语言',text:'Python',kind:'preference',scopeType:'personal',sourceQuote:turn.text},turn),/讨论或假设/);
 const saved=await create(store,c,{text:'SECRET_SYNTHETIC_RULE'});
 c.turns.push({id:'old',status:'completed',receipts:[{eventType:'end',toolName:'memory_manage',toolCallId:'m',content:[{type:'text',text:'SECRET_SYNTHETIC_RULE'}]}]});
 await command(store,{operation:'delete',memoryId:saved.changedId,expectedVersion:1});
 const folder=await store.context(c,{id:'next',references:[]});
 assert.doesNotMatch(await fs.readFile(path.join(folder,`${c.id}.txt`),'utf8'),/SECRET_SYNTHETIC_RULE/);
});

test('真实本机HTTP管理接口：来源限制、并发409、原scope编辑、删除无正文',async t=>{
 const {createOmoPilotServer}=await import('./server.mjs');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'irixi-memory-http-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const {server}=await createOmoPilotServer({runtimeDir:root,includeBuiltinProjects:false,conversationMode:true,conversationOptions:{catalogueReader:async()=>catalogue,omoRunner:()=>{throw Error('no model allowed');}}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base=`http://127.0.0.1:${server.address().port}`;
 const post=(body,origin=base)=>fetch(base+'/api/office/memory',{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify(body)});
 let view=await (await fetch(base+'/api/office/memory')).json();assert.equal(view.revision,0);
 const body={requestId:'http-create',expectedRevision:0,operation:'create',kind:'preference',scopeType:'personal',key:'reporting',title:'汇报',text:'使用短句'};
 assert.equal((await post(body,'https://outside.invalid')).status,403);
 let res=await post(body);assert.equal(res.status,200);view=await res.json();assert.equal(view.entries[0].status,'active');
 assert.equal((await post({...body,requestId:'stale'})).status,409);
 res=await post({requestId:'delete-http',expectedRevision:view.revision,operation:'delete',memoryId:view.entries[0].id,expectedVersion:1});assert.equal(res.status,200);view=await res.json();assert.equal(view.entries.length,0);
 assert.doesNotMatch(JSON.stringify(view),/使用短句/);
});


test('当前明确要求不能给同段引用、代码或Markdown假设提供记忆授权',()=>{
 const quote='以后都用 Rust。';
 for(const text of [
   `以后向我汇报时短一些。请评价这段假设：“${quote}”`,
   `以后向我汇报时短一些。请评价假设：\n\`\`\`text\n${quote}\n\`\`\``,
   `以后向我汇报时短一些。请评价假设：\n> ${quote}`,
   `以后向我汇报时短一些。请评价假设：\`${quote}\``,
   `以后向我汇报时短一些。请评价假设：\n    ${quote}`,
   `以后向我汇报时短一些。请评价假设：${quote}`,
 ]){
   const turn={id:'t',text};const c={id:'c',messages:[{id:'m',turnId:'t',role:'user',text,at:'2026-10-27'}]};
   assert.throws(()=>userMemorySource(c,turn,{operation:'create',kind:'preference',scopeType:'personal',sourceQuote:quote}),/引用、代码/);
   assert.doesNotThrow(()=>userMemorySource(c,turn,{operation:'create',kind:'preference',scopeType:'personal',sourceQuote:'以后向我汇报时短一些。'}));
 }
});
