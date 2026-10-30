import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConversationStore } from './conversation-store.mjs';
import { memoryHistory, effectiveMemories } from './conversation-memory.mjs';
const response=text=>({status:'model_returned',output:{text}});
const catalog={models:[{provider:'desktop-codex',id:'gpt-6-luna',efforts:['medium'],defaultEffort:'medium'}]};
const noModel=()=>{throw Error('Product model forbidden');};
const gate=()=>{let release;const promise=new Promise(r=>release=r);return {promise,release};};
let seq=0;
async function drain(store){while(store.jobs.size)await Promise.all([...store.jobs.values()]);}
async function fixture(t,runner){const root=await fs.mkdtemp(path.join(os.tmpdir(),'n5-source-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const store=new ConversationStore({runtimeDir:root,omoRunner:runner,modelRunner:noModel,noobiRunner:noModel,catalogueReader:async()=>catalog});await store.init();const c=await store.create({requestId:'new',colleagueId:'writer'});return {root,store,c};}
const preference=quote=>({operation:'create',key:'report',title:'汇报',text:'SOURCE_RULE_367',kind:'preference',scopeType:'personal',sourceQuote:quote});
const command=(store,body,turn)=>store.manageMemory({requestId:`source-${++seq}`,expectedRevision:store.state.memory.revision,...body},turn);
async function createSource(f,quote,text=quote){const turn={id:`turn-${++seq}`,text,sequence:seq};const message={id:`message-${seq}`,turnId:turn.id,role:'user',text,at:new Date().toISOString()};f.c.messages.push(message);const result=await command(f.store,{...preference(quote),conversationId:f.c.id},turn);return {turn,message,id:result.changedId};}

test('active disabled deleted source spans preserve unrelated goals and UTF-16 offsets; tombstones contain no body',async t=>{
 const f=await fixture(t,noModel),quote='以后汇报使用 SOURCE_RULE_367。',text='😀\n'+quote+'工具叫 BLUEPRINT_489，只做每周统计。';const source=await createSource(f,quote,text);
 assert.equal(f.store.state.memory.entries[0].source.start,3);assert.equal(f.store.state.memory.entries[0].source.end,3+quote.length);
 f.c.messages.push({id:'reply',turnId:source.turn.id,role:'assistant',text:'项目下一步检查每周统计。'});
 for(const operation of [null,'deactivate','delete']){
  if(operation){const e=f.store.state.memory.entries[0];await command(f.store,{operation,memoryId:e.id,expectedVersion:e.version});}
  const historical=memoryHistory(f.store.state,f.c.messages,'next');assert.doesNotMatch(historical[0].text,/SOURCE_RULE_367/);assert.match(historical[0].text,/BLUEPRINT_489.*每周统计/);assert.equal(historical[1].text,'项目下一步检查每周统计。');
  if(operation)assert.doesNotMatch(memoryHistory(f.store.state,f.c.messages,source.turn.id)[0].text,/SOURCE_RULE_367/);
 }
 assert.doesNotMatch(JSON.stringify(f.store.state.memory),/SOURCE_RULE_367|BLUEPRINT_489/);assert.equal(f.c.messages[0].text,text);
 const reopened=new ConversationStore({runtimeDir:f.root,omoRunner:noModel,modelRunner:noModel,catalogueReader:async()=>catalog});await reopened.init();const restored=memoryHistory(reopened.state,reopened.conversation(f.c.id).messages,'next');assert.match(restored[0].text,/BLUEPRINT_489/);assert.doesNotMatch(restored[0].text,/SOURCE_RULE_367/);
});

test('inherited messages use original source ID; legacy missing range and changed message hash never guess positions',async t=>{
 const f=await fixture(t,noModel),quote='以后汇报使用 SOURCE_RULE_367。',source=await createSource(f,quote,quote+'保留目标。');
 const inherited={...source.message,id:'fork-message',source:{messageId:source.message.id}};assert.match(memoryHistory(f.store.state,[inherited],'fork-new')[0].text,/保留目标/);
 assert.match(memoryHistory(f.store.state,[{...inherited,text:'changed '+inherited.text}],'fork-new')[0].text,/缺少可核对/);
 delete f.store.state.memory.entries[0].source.start;assert.match(memoryHistory(f.store.state,[source.message],'next')[0].text,/缺少可核对/);assert.equal(source.message.text,quote+'保留目标。');
});

test('late same-message restore cannot reverse later UI deactivation; a new user message can restore',async t=>{
 const f=await fixture(t,noModel),saved=await createSource(f,'以后汇报使用 SOURCE_RULE_367。');await command(f.store,{operation:'deactivate',memoryId:saved.id,expectedVersion:1});
 const user=(id)=>{const turn={id,text:'恢复这条汇报偏好。'};f.c.messages.push({id:id+'-m',turnId:id,role:'user',text:turn.text,at:new Date().toISOString()});return turn;};
 const first=user('restore-first');await command(f.store,{operation:'restore',conversationId:f.c.id,memoryId:saved.id,expectedVersion:2,sourceQuote:first.text},first);await command(f.store,{operation:'deactivate',memoryId:saved.id,expectedVersion:3});
 await assert.rejects(command(f.store,{operation:'restore',conversationId:f.c.id,memoryId:saved.id,expectedVersion:4,sourceQuote:first.text},first),/迟到恢复/);assert.equal(effectiveMemories(f.store.state,f.c,{}).length,0);
 const next=user('restore-new');await command(f.store,{operation:'restore',conversationId:f.c.id,memoryId:saved.id,expectedVersion:4,sourceQuote:next.text},next);assert.equal(effectiveMemories(f.store.state,f.c,{}).length,1);
});

for(const mode of ['discuss','execute'])test(`deletion between routing and fresh ${mode} role rebuilds base, current-user and history`,async t=>{
 const arrived=gate(),release=gate(),quote='以后汇报使用 SOURCE_RULE_367。';const prompts=[];let f;
 f=await fixture(t,async o=>{prompts.push(o.prompt);if(o.decisionOnly)return response(JSON.stringify({mode,reply:'controlled',readPaths:[],memoryActions:[preference(quote)]}));return response('controlled role ended');});
 const project=path.join(f.root,'project');await fs.mkdir(project);await f.store.bindProject(f.c.id,{requestId:'bind',path:project});const original=f.store.materialCopies.bind(f.store);let gated=false;
 f.store.materialCopies=async(...args)=>{if(!gated&&f.store.state.memory.entries.length){gated=true;arrived.release();await release.promise;}return original(...args);};
 const turn=await f.store.send(f.c.id,{requestId:'start',text:quote+'目标 BLUEPRINT_489。'});await arrived.promise;const e=f.store.state.memory.entries[0];await command(f.store,{operation:'delete',memoryId:e.id,expectedVersion:e.version});release.release();await drain(f.store);
 assert.ok(prompts.length>=2);assert.match(prompts[0],/SOURCE_RULE_367/);assert.doesNotMatch(prompts.at(-1),/SOURCE_RULE_367/);assert.match(prompts.at(-1),/BLUEPRINT_489/);
 const history=await f.store.context(f.c,turn);assert.doesNotMatch(await fs.readFile(path.join(history,f.c.id+'.txt'),'utf8'),/SOURCE_RULE_367/);
});

test('memory change while a fresh role is persisting context refreshes before dispatch',async t=>{
 const arrived=gate(),release=gate(),quote='以后汇报使用 SOURCE_RULE_367。',prompts=[];const f=await fixture(t,async o=>{prompts.push(o.prompt);return o.decisionOnly?response(JSON.stringify({mode:'discuss',reply:'controlled',readPaths:[],memoryActions:[preference(quote)]})):response('done');});
 const project=path.join(f.root,'project');await fs.mkdir(project);await f.store.bindProject(f.c.id,{requestId:'bind',path:project});const save=f.store.save.bind(f.store);let gated=false;
 f.store.save=async()=>{if(!gated&&f.c.turns[0]?.memoryUses?.some(u=>u.entries.length)){gated=true;arrived.release();await release.promise;}return save();};
 await f.store.send(f.c.id,{requestId:'send',text:quote+'保留目标 BLUEPRINT_489。'});await arrived.promise;const e=f.store.state.memory.entries[0];await command(f.store,{operation:'delete',memoryId:e.id,expectedVersion:1});release.release();await drain(f.store);
 assert.ok(prompts.length>=2);assert.doesNotMatch(prompts.at(-1),/SOURCE_RULE_367/);assert.match(prompts.at(-1),/BLUEPRINT_489/);
});

test('managed-rule echoes are removed from assistant history without hiding unrelated results; late exact echoes remain suppressed',async t=>{
 const f=await fixture(t,noModel),quote='以后汇报使用 SOURCE_RULE_367。',source=await createSource(f,quote,quote+'目标 BLUEPRINT_489。');
 f.c.messages.push({id:'echo-before',turnId:source.turn.id,role:'assistant',text:'已保存 SOURCE_RULE_367。项目 BLUEPRINT_489 的每周统计已讨论。'});
 assert.match(memoryHistory(f.store.state,f.c.messages,'next')[1].text,/BLUEPRINT_489/);assert.doesNotMatch(memoryHistory(f.store.state,f.c.messages,'next')[1].text,/SOURCE_RULE_367/);
 await command(f.store,{operation:'delete',memoryId:source.id,expectedVersion:1});
 f.c.messages.push({id:'echo-late',turnId:source.turn.id,role:'assistant',text:quote+'项目 BLUEPRINT_489 仍保留。'});
 const history=memoryHistory(f.store.state,f.c.messages,'next');assert.ok(history.every(m=>!m.text.includes('SOURCE_RULE_367')));assert.ok(history.every(m=>m.text.includes('BLUEPRINT_489')));
 assert.doesNotMatch(JSON.stringify(f.store.state.memory),/SOURCE_RULE_367|BLUEPRINT_489/);assert.match(f.c.messages[1].text,/SOURCE_RULE_367/);
});

test('static delegated role rebuilds revoked memory before dispatch without duplicating its immutable task prompt',async t=>{
 const entered=gate(),release=gate();let childPrompt;const f=await fixture(t,async o=>{if(o.decisionOnly)return response(JSON.stringify({mode:'execute',reply:'controlled',readPaths:[]}));if(o.role==='Developer'){await o.onDelegate({requestId:'child',task:'STATIC_TASK_281 核对 seed',paths:['seed.txt']},o.signal);return response('parent ended');}childPrompt=o.prompt;return response('child ended');});
 const project=path.join(f.root,'project');await fs.mkdir(project);await fs.writeFile(path.join(project,'seed.txt'),'synthetic');await f.store.bindProject(f.c.id,{requestId:'bind',path:project});
 const saved=await command(f.store,{...preference(''),sourceQuote:undefined});const save=f.store.save.bind(f.store);let held=false;
 f.store.save=async()=>{await save();if(!held&&f.c.turns.some(turn=>turn.children.some(child=>child.memoryUses?.some(use=>use.entries.some(entry=>entry.id===saved.changedId))))){held=true;entered.release();await release.promise;}};
 const turn=await f.store.send(f.c.id,{requestId:'send',text:'执行：让只读助手核对 seed'});await entered.promise;await command(f.store,{operation:'delete',memoryId:saved.changedId,expectedVersion:1});release.release();await drain(f.store);
 assert.doesNotMatch(childPrompt,/SOURCE_RULE_367/);assert.equal((childPrompt.match(/STATIC_TASK_281/g)||[]).length,1);assert.equal((childPrompt.match(/HOST MEMORY:/g)||[]).length,1);assert.equal(turn.children[0].memoryUses.at(-1).memoryRevision,f.store.state.memory.revision);assert.deepEqual(turn.children[0].memoryUses.at(-1).entries,[]);
});
