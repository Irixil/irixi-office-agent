import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConversationStore } from './conversation-store.mjs';
import { classifiedWorkLifecycle } from './colleagues.mjs';
const catalogue={models:[{provider:'desktop-codex',id:'gpt-6-luna',efforts:['medium'],defaultEffort:'medium'}]};
const answer=route=>({status:'model_returned',output:{text:JSON.stringify({mode:'discuss',reply:'受控讨论',readPaths:[],...route})},sessionId:'local-lifecycle-only'});
async function drain(s){while(s.jobs.size)await Promise.all([...s.jobs.values()]);}
async function setup(t,runner=async()=>answer({})){const root=await fs.mkdtemp(path.join(os.tmpdir(),'irixi-n4-lifecycle-'));const store=new ConversationStore({runtimeDir:root,omoRunner:runner,catalogueReader:async()=>catalogue});await store.init();const c=await store.create({requestId:'new',colleagueId:'writer'});t.after(async()=>{for(const x of store.state.conversations)await store.stop(x.id);await drain(store);await fs.rm(root,{recursive:true,force:true});});return{root,store,c};}
const request=(text,state='completed')=>({workLifecycle:state,workLifecycleEvidence:text});
test('local classifier guard: ordinary, quoted, hypothetical, negative and questions do not become keyword completion',()=>{
 assert.equal(classifiedWorkLifecycle({},'这轮已完成'),null);
 for(const [text,evidence] of [['请解释“这项工作完成了”','这项工作完成了'],["'这项工作完成了'", "'这项工作完成了'"],['不要结束这项工作','结束这项工作'],['不要结束这项工作','不要结束这项工作'],['这项工作结束了吗？','这项工作结束了吗']])assert.equal(classifiedWorkLifecycle(request(evidence),text),null,text);
 assert.deepEqual(classifiedWorkLifecycle(request('这项工作全部结束'), '这项工作全部结束。'),{state:'completed',evidence:'这项工作全部结束'});
});
test('real Store with controlled runner: round completion remains open; explicit finish and resume keep work identity',async t=>{
 const{store,c}=await setup(t,async o=>{assert.match(o.prompt,/Whole-work lifecycle/);const text=o.prompt.split('Current user message: ')[1].split('\n')[0];return answer(text==='这项工作全部结束'?request(text):text==='继续这项工作'?request(text,'open'):{});});const id=c.work.id;
 await store.send(c.id,{requestId:'chat',text:'先聊这个工具'});await drain(store);assert.equal(c.turns[0].status,'completed');assert.equal(c.work.lifecycle,'open');assert.equal(store.view().colleagues[1].works[0].unfinished,true);
 await store.send(c.id,{requestId:'end',text:'这项工作全部结束'});await drain(store);assert.equal(c.work.lifecycle,'completed');assert.equal(store.view().colleagues[1].works[0].unfinished,false);
 await store.send(c.id,{requestId:'resume',text:'继续这项工作'});await drain(store);assert.equal(c.work.lifecycle,'open');assert.equal(c.work.id,id);assert.equal(c.turns.length,3);
});
test('real Store: closure cannot pass an active receiver, artifact run, nested child or waiting request',async t=>{
 const{store,c}=await setup(t);const turn={id:'request',sequence:2,status:'understanding'};c.turns.push(turn);const signal=new AbortController().signal;
 for(const blocked of ['working','awaiting_project','stopping']){c.turns.unshift({id:'prior',sequence:1,status:blocked});const result=await store.setWorkLifecycle(c,turn,{state:'completed',evidence:'结束'},signal);assert.equal(result.changed,false);assert.equal(c.work.lifecycle,'open');c.turns.shift();}
 c.handoffRuns.push({id:'receiver',status:'working'});assert.equal((await store.setWorkLifecycle(c,turn,{state:'completed'},signal)).changed,false);c.handoffRuns=[];
 c.artifactRuns=[{id:'artifact',status:'working'}];assert.equal((await store.setWorkLifecycle(c,turn,{state:'completed'},signal)).changed,false);c.artifactRuns=[];
 c.turns.unshift({id:'prior',status:'completed',children:[{id:'child',status:'working'}]});assert.equal((await store.setWorkLifecycle(c,turn,{state:'completed'},signal)).changed,false);
});
test('real Store: newer explicit open prevents a late close, and failed persistence restores lifecycle',async t=>{
 const{store,c}=await setup(t);const old={id:'old',sequence:1,status:'completed'},newer={id:'newer',sequence:2,status:'completed'};c.turns.push(old,newer);const signal=new AbortController().signal;
 await store.setWorkLifecycle(c,newer,{state:'open',evidence:'继续'},signal);assert.equal((await store.setWorkLifecycle(c,old,{state:'completed',evidence:'结束'},signal)).stale,true);
 const save=store.save.bind(store);let fail=true;store.save=async()=>{if(fail){fail=false;throw new Error('controlled persistence failure');}return save();};await assert.rejects(store.setWorkLifecycle(c,newer,{state:'completed',evidence:'结束'},signal),/persistence/);assert.equal(c.work.lifecycle,'open');assert.equal(c.work.lifecycleEvents.length,1);
});
test('real Store: migration does not infer whole-work completion and reopen makes no model call',async t=>{
 const{store,c,root}=await setup(t);await store.send(c.id,{requestId:'chat',text:'讨论'});await drain(store);delete c.work.lifecycle;delete c.work.lifecycleEvents;await store.save();
 const reopened=new ConversationStore({runtimeDir:root,omoRunner:()=>{throw new Error('must not call model');},catalogueReader:async()=>catalogue});await reopened.init();assert.equal(reopened.conversation(c.id).work.lifecycle,'open');assert.equal(reopened.view().colleagues[1].works[0].unfinished,true);assert.equal(reopened.jobs.size,0);
});

test('real Store view: a closed work that is actually receiving a new turn stays visible without changing lifecycle',async t=>{
 const{store,c}=await setup(t);c.work.lifecycle='completed';c.turns.push({id:'reading',sequence:1,status:'understanding',calls:[],receipts:[]});const view=store.view().colleagues[1].works[0];assert.equal(view.lifecycle,'completed');assert.equal(view.unfinished,true);assert.equal(view.status,'understanding');c.turns[0].status='completed';
});

test('integrated memory and lifecycle: one message saves its explicit preference before closing the work', async t => {
 const text = '以后汇报请用短句。这项工作全部结束。';
 const { store, c } = await setup(t, async () => answer({
   ...request('这项工作全部结束'),
   memoryActions: [{ operation:'create', key:'reporting', title:'汇报方式', text:'汇报使用短句', kind:'preference', scopeType:'personal', sourceQuote:'以后汇报请用短句' }],
 }));
 await store.send(c.id, { requestId:'memory-and-close', text }); await drain(store);
 assert.equal(c.work.lifecycle, 'completed');
 assert.equal(store.state.memory.entries[0].text, '汇报使用短句');
 assert.match(c.messages.at(-1).text, /结束整项工作/);
 assert.match(c.messages.at(-1).text, /记忆已保存/);
});
