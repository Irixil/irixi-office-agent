import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { userMemorySource, unquotedUserText, memoryHistory, MEMORY_ROUTING, effectiveMemories } from './conversation-memory.mjs';
import { ConversationStore } from './conversation-store.mjs';
const real={"text": "先讨论，不要改文件。这是同一学习项目的新对话。请接上已有对话和实际文件，简短告诉我现在完成了什么、还有什么没验证，不要让我重新描述需求。另外请记住一个仅用于这个项目的约定：进展汇报固定按“已完成、还缺什么、下一步”三项短句写。", "action": {"operation": "create", "key": "learning_original_copy_progress_report_format", "title": "学习项目进展汇报格式", "text": "本项目进展汇报固定按“已完成、还缺什么、下一步”三项短句写。", "kind": "decision", "scopeType": "project", "sourceQuote": "进展汇报固定按“已完成、还缺什么、下一步”三项短句写。"}};
const complete=real.text.slice(real.text.indexOf('另外请记住'));
const action={...real.action,sourceQuote:complete};
const fixture=text=>({c:{id:'synthetic-c',projectId:'synthetic-p',messages:[{id:'synthetic-m',turnId:'synthetic-t',role:'user',text,at:'2026-10-30T00:00:00Z'}]},turn:{id:'synthetic-t',text}});
const source=(text,quote=text,extra={})=>{const {c,turn}=fixture(text);return userMemorySource(c,turn,{...action,sourceQuote:quote,...extra});};
const hash=text=>crypto.createHash('sha256').update(text).digest('hex');

test('complete authorization with quoted labels is accepted; truncated value stays rejected',()=>{
 const {c,turn}=fixture(real.text);
 assert.throws(()=>userMemorySource(c,turn,real.action),/引用、代码/);
 const result=userMemorySource(c,turn,action);
 assert.equal(result.start,real.text.indexOf(complete));assert.equal(result.end,real.text.length);
 assert.equal(result.messageHash,hash(real.text));assert.equal(result.quoteHash,hash(complete));
 assert.match(MEMORY_ROUTING,/authorization, its scope, and any inline quoted value/);
});

test('quoted commands, code, assumptions and negation cannot authorize; project name outside quotes is not approval',()=>{
 for(const text of [
  '“另外请记住本项目按短句写。”',
  '本项目有人说：“记住按短句写。”',
  '请评价这段假设：另外请记住本项目按短句写。',
  '如果本项目要汇报，请记住按“短句”写。',
  '本项目不要记住“短句”约定。',
  '本项目不需要记住“短句”约定。',
  '```text\n另外请记住本项目按短句写。\n```',
  '> 另外请记住本项目按短句写。',
  '    另外请记住本项目按短句写。',
  '`另外请记住本项目按短句写。`',
 ]) assert.throws(()=>source(text),undefined,text);
 for(const text of ['以后向我汇报时短一些。请评价假设：“以后都用 Rust。”','以后向我汇报时短一些。请评价假设：以后都用 Rust。']) {
  assert.throws(()=>source(text,'以后都用 Rust。',{kind:'preference',scopeType:'personal'}));
  assert.doesNotThrow(()=>source(text,'以后向我汇报时短一些。',{kind:'preference',scopeType:'personal'}));
 }
});

test('quoted labels are data; only unquoted words determine operation, scope, uncertainty or negation',()=>{
 assert.doesNotThrow(()=>source('另外请记住本项目的标题：“如果”“不要保存”“下一步？”三项。'));
 assert.throws(()=>source('本项目“删除”这条记忆。',undefined,{operation:'delete'}),/没有明确/);
 assert.doesNotThrow(()=>source('删除本项目的“如果”约定。',undefined,{operation:'delete'}));
 assert.throws(()=>source('请记住“仅用于这个项目”的格式。'),/项目决定/);
});

test('personal and temporary authority cannot come only from quoted commands',()=>{
 assert.throws(()=>source('以后请检查工具输出：“请记住我喜欢短句。”',undefined,{kind:'preference',scopeType:'personal'}),/引用外/);
 assert.throws(()=>source('本轮请检查工具输出：“请记住本轮汇报用短句。”',undefined,{kind:'temporary',scopeType:'conversation'}),/引用外/);
 assert.doesNotThrow(()=>source('以后汇报请用“短句”。',undefined,{kind:'preference',scopeType:'personal'}));
 assert.doesNotThrow(()=>source('本轮汇报请用“短句”。',undefined,{kind:'temporary',scopeType:'conversation'}));
});

test('quoted emoji keep exact UTF-16 span and hash; removal only masks the authorized range',()=>{
 const text='“😀”\n'+complete+'保留其他目标。';const {c,turn}=fixture(text);
 assert.equal(unquotedUserText(text).length,text.length);
 const s=userMemorySource(c,turn,action);assert.equal(s.start,5);assert.equal(text.slice(s.start,s.end),complete);
 assert.equal(s.quoteHash,hash(complete));
 const state={conversations:[{...c,turns:[]}],memory:{version:1,revision:1,entries:[],requests:{},tombstones:[{sources:[s]}]}};
 const masked=memoryHistory(state,c.messages,'other')[0].text;
 assert.equal(masked,'“😀”\n[此段规则以当前有效记忆为准]保留其他目标。');assert.equal(c.messages[0].text,text);
});

test('normal host route saves complete source in synthetic project only; real failure is not edited',async t=>{
 const runtime=await fs.mkdtemp(path.join(os.tmpdir(),'memory-inline-test-'));t.after(()=>fs.rm(runtime,{recursive:true,force:true}));
 const noModel=()=>{throw Error('model forbidden');};
 const store=new ConversationStore({runtimeDir:runtime,omoRunner:noModel,modelRunner:noModel,catalogueReader:async()=>({models:[{id:'gpt-6-luna',provider:'desktop-codex',efforts:['medium'],defaultEffort:'medium'}]})});await store.init();
 const c=await store.create({requestId:'synthetic-create'});const project=path.join(runtime,'project');await fs.mkdir(project);await store.bindProject(c.id,{requestId:'synthetic-bind',path:project});
 const turn={id:'synthetic-t',text:real.text};c.messages.push({id:'synthetic-m',role:'user',turnId:turn.id,text:real.text,at:'2026-10-30T00:00:00Z'});
 const result=await store.applyMemoryRoute(c,turn,{memoryActions:[action]});assert.equal(result[0].status,'saved');
 const entry=store.state.memory.entries[0];assert.equal(entry.scopeId,c.projectId);assert.equal(entry.kind,'decision');assert.equal(entry.source.quoteHash,hash(complete));
 const same=await store.create({requestId:'synthetic-same',projectId:c.projectId});assert.equal(effectiveMemories(store.state,same,{}).length,1);
 const other=await store.create({requestId:'synthetic-other'});assert.equal(effectiveMemories(store.state,other,{}).length,0);
});

// Each memory has its own complete human instruction; the final status question is not part of either source.
test('two independent memory instructions use their own spans while the whole paragraph stays rejected',()=>{
 const project='请记住一个仅用于这个项目的约定：进展汇报固定按“已完成、还缺什么、下一步”三项短句写。';
 const personal='另请记住我的长期偏好：以后回答默认用简短中文。';
 const text=project+personal+'只确认记忆是否保存，不读写项目文件。';
 for(const [quote,extra] of [[project,{}],[personal,{kind:'preference',scopeType:'personal'}]]) {
  const result=source(text,quote,extra);
  assert.equal(text.slice(result.start,result.end),quote);
  assert.equal(result.quoteHash,hash(quote));
  assert.throws(()=>source(text,text,extra),/讨论或假设/);
 }
});
