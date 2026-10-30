import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { coworkerRuntimeState } from '../public/office-geometry.js';

const source = readFileSync(new URL('../public/conversation-app.js', import.meta.url), 'utf8');
const prefix = source.slice(0, source.indexOf('// Preserve the office scene')).replace(/^import .*;\n/gm, '');
function fixture() {
  const nodes = new Map();
  const node = (id) => { if (!nodes.has(id)) nodes.set(id, { value:'', textContent:'', dataset:{}, hidden:false, replaceChildren(){}, querySelector(){return null;}, contains(){return false;}, childElementCount:0, focus(){}, classList:{toggle(){}}, setAttribute(){} }); return nodes.get(id); };
  const storage = () => { const map = new Map(); return { getItem:k=>map.get(k) ?? null, setItem:(k,v)=>map.set(k,String(v)), removeItem:k=>map.delete(k) }; };
  const ctx = vm.createContext({ URL, URLSearchParams, structuredClone, Date, console, setTimeout:()=>1, clearTimeout(){}, innerWidth:1200,
    location:{search:'?window=fixture',href:'http://fixture.invalid/'}, history:{replaceState(){}}, crypto:{randomUUID:()=>`fixture-${Math.random()}`},
    localStorage:storage(), sessionStorage:storage(), window:{}, document:{querySelector:node},
    esc:value=>String(value ?? '').replaceAll('<','&lt;'), renderMarkdown:value=>`<p>${value}</p>`, icon:()=>'', coworkerRuntimeState });
  vm.runInContext(prefix + `\nconst input = document.querySelector('input'), status = document.querySelector('status');
    globalThis.realRefresh = refresh; render = () => {}; renderComposer = () => {}; open = () => {}; refresh = async () => {};
    api = (url, body) => globalThis.transport(url, body);
    globalThis.result = () => ({currentId,selectedRole,roleListing,text:input.value,references,editTarget,sending,notice:status.textContent});`, ctx);
  const calls=[];
  ctx.transport = async (url, body) => { calls.push({url,body}); return {result:{revision:1}}; };
  const run = code => vm.runInContext(code,ctx);
  const put = value => {ctx.value=value;run('data=value');};
  const base={projects:[],conversations:[],sections:[],preferences:{}, catalogue:{models:[],defaultSelection:{provider:'fixture',model:'fixture',effort:'medium'}}, colleagues:['researcher','writer','reviewer','steward','archivist'].map(id=>({id,name:id,works:[]}))};
  put(base); return {ctx,calls,run,put,base,result:()=>structuredClone(ctx.result())};
}
const c = (id, owner='writer') => ({id,title:id,turns:[],messages:[],modelSelection:{model:'fixture'},work:{id:`work-${id}`,ownerId:owner,ownerRevision:3,transfers:[]}});
const tick = () => new Promise(resolve=>setImmediate(resolve));

test('progress keeps internal Noobi briefs folded and never promotes an unverified result', () => {
  const f = fixture();
  const requirement = '检查源码 SHA256 abcdef0123456789abcdef0123456789；' + '内部制作要求。'.repeat(80);
  f.ctx.turn = { id: 'result-turn', status: 'completed', workspace: '/synthetic/workspace', createdAt: '2026-10-27T00:00:00Z', adoptedAt: '2026-10-27T00:01:00Z', projectId: 'p', artifactEntrypoint: 'dist/index.html', resultIndex: { 'dist/index.html': 'sha' }, changes: { changed: ['dist/index.html'] }, verification: { status: 'passed' }, functionalChecks: [{ caseId: 'noobi-production-game', kind: 'web', status: 'passed', requirement }] };
  const rendered = f.run("results({ id: 'c', turns: [turn] })");
  const visible = [...rendered.matchAll(/<dl>([\s\S]*?)<\/dl>/g)].map(match => match[1]).join('\n');
  assert.match(visible, /小游戏制作与实际试玩/);
  assert.match(visible, /可打开运行/);
  assert.doesNotMatch(visible, /SHA256|内部制作要求|共变更/);
  assert.ok(rendered.includes(requirement));
  f.ctx.turn.verification.status = 'unverified';
  const unverified = f.run("results({ id: 'c', turns: [turn] })");
  assert.doesNotMatch(unverified.match(/<dl>([\s\S]*?)<\/dl>/)[1], /本轮记录的功能检查已通过/);
  assert.equal(f.run("checkPurpose({kind:'document', requirement:'x'.repeat(100)})"), '文档内容要求');
});

test('local VM: blank role drafts and references stay separate without creating work', async()=>{
  const f=fixture(); await f.run("openRole('researcher')");
  f.run("input.value='学习草稿'; references=[{title:'学习引用'}]; snapshotDraft()");
  await f.run("openRole('writer')"); assert.equal(f.result().text,'');
  f.run("input.value='工具草稿'; references=[{title:'工具引用'}]; snapshotDraft()");
  await f.run("openRole('researcher')"); assert.equal(f.result().text,'学习草稿'); assert.equal(f.result().references[0].title,'学习引用');
  assert.equal(f.calls.length,0);
});

test('local VM: one unfinished work opens it; multiple projects require a choice; old work remains history',async()=>{
  const f=fixture(); const a=c('a','researcher'), b=c('b','researcher'); f.base.conversations=[a,b]; f.base.colleagues[0].works=[{conversationId:'a',unfinished:true,status:'waiting',projectId:'p1'},{conversationId:'b',unfinished:false,status:'completed',projectId:'p2'}];f.put(f.base);
  await f.run("openRole('researcher')"); assert.equal(f.result().currentId,'a');
  f.base.colleagues[0].works[1].unfinished=true; await f.run("openRole('researcher')");assert.equal(f.result().currentId,null);assert.equal(f.result().roleListing,true);
  assert.equal(f.calls.some(({url})=>url.endsWith('/new')||url.endsWith('/send')),false);
});

test('local VM: a delayed reference returns to the originating role draft',async()=>{
  const f=fixture(); await f.run("openRole('researcher')"); let resolve;
  f.ctx.transport=()=>new Promise(r=>resolve=r); const pending=f.run("addReference({conversationId:'source'})");
  await f.run("openRole('writer')"); resolve({references:[{conversationId:'source',title:'source',text:'reference'}]}); await pending;
  assert.equal(f.result().references.length,0); await f.run("openRole('researcher')"); assert.equal(f.result().references[0].title,'source');
});

test('local VM: late successful send clears only the source draft and keeps work identity',async()=>{
  const f=fixture(); f.base.conversations=[c('a'),c('b','researcher')];f.put(f.base);await f.run("select('a')");
  f.run("input.value='原工作补充'; references=[{title:'引用'}]; snapshotDraft()");let release;
  f.ctx.transport=async (url,body)=>{f.calls.push({url,body});if(url.endsWith('/send')) return new Promise(r=>release=r);return {result:{revision:1}};};
  const pending=f.run('send()');await tick();await f.run("select('b')");f.run("input.value='另一工作草稿'; snapshotDraft()");release({});await pending;
  assert.equal(f.result().currentId,'b');assert.equal(f.result().text,'另一工作草稿');
  const sent=f.calls.find(x=>x.url.endsWith('/send'));assert.equal(sent.body.workId,'work-a');assert.equal(sent.body.expectedOwnerRevision,3);
  await f.run("select('a')");assert.equal(f.result().text,'');assert.equal(f.result().references.length,0);
});

test('local VM: owner revision rejection retains the message and references for explicit retry',async()=>{
  const f=fixture();f.base.conversations=[c('a')];f.put(f.base);await f.run("select('a')");f.run("input.value='未发送';references=[{title:'引用'}];snapshotDraft()");
  f.ctx.transport=async()=>{throw new Error('负责人已经变化');};await f.run('send()');assert.equal(f.result().text,'未发送');assert.equal(f.result().references.length,1);assert.match(f.result().notice,/负责人/);
});

test('local VM: creating a conversation for material preserves typed text, and does not steal another role',async()=>{
  const f=fixture();await f.run("openRole('researcher')");f.run("input.value='材料说明';references=[{title:'引用'}];snapshotDraft()");let release;
  f.ctx.transport=async (url,body)=>url.endsWith('/new')?new Promise(r=>release=r):{result:{revision:1}};
  const pending=f.run("create(null,selectedRole,{carryDraft:true})");f.run("input.value='材料说明，继续补充';snapshotDraft()");await f.run("openRole('writer')");release({conversationId:'created'});await pending;
  assert.equal(f.result().selectedRole,'writer');assert.equal(f.result().currentId,null);assert.equal(f.run("getDraft('created').text"),'材料说明，继续补充');assert.equal(f.run("getDraft('created').references.length"),1);
});

test('local VM: the current Noobi approval overrides working only for its own work',()=>{
  const f=fixture();f.base.conversations=[{...c('a','reviewer'),turns:[{status:'working',noobiJobs:[{approvals:[{status:'pending'}]}]}]},c('b')];f.base.colleagues[2].works=[{conversationId:'a',status:'working'}];f.base.colleagues[1].works=[{conversationId:'b',status:'working'}];f.put(f.base);
  assert.equal(f.run("officeTask().colleagues[2].works[0].status"),'waiting_user');assert.equal(f.run("officeTask().colleagues[1].works[0].status"),'working');
});

test('aggregate: inactive tabs and parallel work cannot report false rest or global writer activity',()=>{
  const task={colleagues:[{id:'writer',works:[]},{id:'steward',works:[{status:'completed'},{status:'waiting'}]},{id:'researcher',works:[{status:'working'}]}]};
  assert.equal(coworkerRuntimeState(task,'writer').active,false);assert.equal(coworkerRuntimeState(task,'researcher').active,true);
  assert.equal(coworkerRuntimeState(task,'steward').status,'waiting');assert.equal(coworkerRuntimeState(task,'steward').localEligible,false);
  assert.equal(coworkerRuntimeState({...task,disconnected:true},'researcher').status,'unknown');assert.equal(coworkerRuntimeState(task,'writer',{engagedRole:'writer'}).active,false);
});

test('local VM: handoff process follows exact source/work identities; newer receiver progress is visible',()=>{
  const f=fixture(), turn={id:'turn-a',status:'completed',createdAt:'2026-10-27T01:00:00Z',finishedAt:'2026-10-27T01:00:01Z',receipts:[]};
  const run={id:'receiver-a',workId:'work-a',colleagueId:'researcher',status:'completed',createdAt:'2026-10-27T01:00:02Z',finishedAt:'2026-10-27T01:00:05Z',receipts:[{eventType:'start',toolCallId:'r1',toolName:'read',args:{text:'{"path":"ONLY-A"}'},occurredAt:'2026-10-27T01:00:03Z'},{eventType:'end',toolCallId:'r1',occurredAt:'2026-10-27T01:00:04Z'}],result:'已接手学习'};
  const conv={...c('a'),turns:[turn],handoffRuns:[run,{...run,id:'receiver-b'}]};conv.work.transfers=[{sourceTurnId:'turn-a',receiverId:'receiver-a',from:'writer',to:'researcher',status:'accepted'},{sourceTurnId:'turn-b',receiverId:'receiver-b',from:'writer',to:'researcher',status:'accepted'}];f.ctx.conv=conv;f.ctx.turn=turn;
  assert.equal(f.run('handoffsFor(conv,turn.id).length'),1);const content=f.run('activities(conv,turn)');assert.match(content,/ONLY-A/);assert.match(content,/已确认接手/);assert.match(content,/已接手学习/);assert.doesNotMatch(content,/wb-activity-receiver-b/);assert.equal(f.run('progressTime(conv.handoffRuns[0])'),'2026-10-27T01:00:05Z');
});

test('local VM: handoff-only work exposes stop even when source turn ended',()=>{
  const f=fixture(); f.ctx.conv={...c('a'),turns:[{status:'completed'}]}; f.ctx.conv.work.transfers=[{status:'receiving'}];assert.equal(f.run('Boolean(workRunning(conv))'),true);
});

test('local VM: role material draft remains reachable after switching roles without creating or sending',async()=>{
  const f=fixture();f.base.conversations=[{...c('material-draft','researcher'),materials:[{id:'m',name:'note.txt'}]}];f.put(f.base);
  await f.run("select('material-draft')");f.run("input.value='材料的说明';snapshotDraft()");await f.run("openRole('writer')");await f.run("openRole('researcher')");
  assert.equal(f.result().currentId,'material-draft');assert.equal(f.result().text,'材料的说明');assert.equal(f.calls.some(x=>x.url.endsWith('/new')||x.url.endsWith('/send')),false);
});

test('local VM: created role draft migrates once even when send fails after a role switch',async()=>{
  const f=fixture();await f.run("openRole('researcher')");f.run("input.value='保留这条';snapshotDraft()");let release;
  f.ctx.transport=async(url)=>url.endsWith('/new')?new Promise(r=>release=r):Promise.reject(new Error('受控保存失败'));
  const pending=f.run('send()');await f.run("openRole('writer')");release({conversationId:'created'});await pending;
  assert.equal(f.result().selectedRole,'writer');assert.equal(f.run("getDraft('created').text"),'保留这条');assert.equal(f.run("localStorage.getItem(localKey('new-role-researcher'))"),null);
});

test('local VM: role navigation retains an unsent model choice while existing work uses its saved model',async()=>{
  const f=fixture();await f.run("openRole('researcher')");f.run("selection={model:'chosen',provider:'fixture',effort:'high'};snapshotDraft()");await f.run("openRole('writer')");assert.equal(f.run('selection.model'),'chosen');
  f.base.conversations=[{...c('a'),modelSelection:{model:'work-model',provider:'fixture',effort:'low'}}];f.put(f.base);await f.run("select('a')");assert.equal(f.run('selection.model'),'work-model');await f.run("openRole('researcher')");assert.equal(f.run('selection.model'),'chosen');
});

test('memory UI local VM: scoped management uses currentVersion and never moves a project rule',async()=>{
 const f=fixture();f.run('renderMemory=()=>{}');f.ctx.memory={revision:9,entries:[{id:'m1',title:'旧名称',text:'项目旧规则',version:2,currentVersion:4,scopeType:'project',scopeLabel:'项目A',status:'active',source:{type:'user_message',conversationId:'a',messageId:'msg'}}],defaults:[]};
 f.run('memoryState=globalThis.memory;memoryContext=null;beginMemoryEdit("m1");memoryEditor.text="修改后的规则";saveMemoryEditor()');f.ctx.transport=async(url,body)=>{f.calls.push({url,body});return{revision:10,entries:[],defaults:[],notice:'下一轮生效'};};await f.run("changeMemory('edit')");
 const body=f.calls.at(-1).body;assert.equal(body.expectedRevision,9);assert.equal(body.expectedVersion,4);assert.equal(body.text,'修改后的规则');assert.equal('scopeType' in body,false);assert.equal('projectId' in body,false);assert.equal('conversationId' in body,false);assert.equal(f.run('memoryEditor'),null);
});

test('memory UI local VM: conflict retains draft and an uncertain retry reuses the exact request id',async()=>{
 const f=fixture();f.run('renderMemory=()=>{}');f.ctx.memory={revision:2,entries:[{id:'m',title:'标题',text:'正文',version:1,scopeLabel:'个人'}]};f.run('memoryState=globalThis.memory;beginMemoryEdit("m");memoryEditor.text="未保存修改";saveMemoryEditor()');
 f.ctx.transport=async(url,body)=>{f.calls.push({url,body});throw new Error('版本冲突');};await f.run("changeMemory('edit')");await f.run("changeMemory('edit')");assert.equal(f.run('memoryEditor.text'),'未保存修改');assert.equal(f.calls[0].body.requestId,f.calls[1].body.requestId);assert.match(f.run('memoryMarkup()'),/版本冲突/);assert.match(f.run('localStorage.getItem(memoryDraftKey())'),/未保存修改/);
});

test('memory UI local VM: disabled/candidate/source/default semantics remain visible without model invocation',()=>{
 const f=fixture();f.ctx.memory={entries:[{id:'m',title:'短句',text:'规则',kind:'preference',status:'disabled',version:2,scopeLabel:'个人',source:{type:'explicit_ui'}},{id:'c',title:'候选',text:'尚未采用',kind:'candidate',status:'candidate',version:1,scopeLabel:'项目A',source:{type:'user_message',conversationId:'a',messageId:'msg'}}],defaults:[{name:'花枝鼠',preference:'核对来源'}]};f.run('memoryState=globalThis.memory');const html=f.run('memoryMarkup()');assert.match(html,/恢复使用/);assert.match(html,/候选，未采用/);assert.match(html,/不删除原聊天和成果/);assert.match(html,/message=msg/);assert.match(html,/角色默认能力/);assert.equal(f.calls.length,0);
});

test('Noobi UI local VM: default progress is Chinese, scoped, and agent deltas do not refresh work progress',()=>{
 const f=fixture();f.ctx.job={status:'running',createdAt:'2000-01-01T00:00:00Z',events:[{type:'noobi_progress',phase:'implementing',title:'Implementer · implementation ready',at:'2000-01-01T00:00:01Z'},{type:'noobi_tool',method:'item/agentMessage/delta',title:'new character',at:new Date().toISOString()}]};
 assert.equal(f.run('noobiProgress(globalThis.job)'),'这一步已返回结果');f.ctx.conv={turns:[{noobiJobs:[f.ctx.job]}]};const html=f.run('noobiStatus(globalThis.conv)');assert.match(html,/尚未收到新的制作结果/);assert.doesNotMatch(html,/Implementer|new character/);assert.equal(f.run("noobiEventLabel({type:'noobi_progress',phase:'playtest'})"),'正在试玩');
});

test('memory UI local VM: 409 requires a fresh version before resubmission and never revives a deleted entry',async()=>{
 const f=fixture();f.run('renderMemory=()=>{}');f.ctx.memory={revision:2,entries:[{id:'m',title:'标题',text:'原文',version:1}]};f.run('memoryState=globalThis.memory;beginMemoryEdit("m");memoryEditor.text="编辑文字"');let posts=0;
 f.ctx.transport=async()=>{posts++;throw Object.assign(new Error('版本冲突'),{status:409});};await f.run("changeMemory('edit')");await f.run("changeMemory('edit')");assert.equal(posts,1);assert.equal(f.run('memoryEditor.conflict'),true);
 f.ctx.transport=async()=>({revision:3,entries:[],defaults:[]});await f.run("loadMemory(null,'settings')");assert.equal(f.run('memoryEditor.text'),'编辑文字');assert.equal(f.run('memoryEditor.conflict'),true);assert.match(f.run('memoryNotice'),/已删除/);
});

test('local VM: parallel writing children show actual write scope and do not become read-only assistants',()=>{
 const f=fixture();f.ctx.turn={id:'parent',status:'working',createdAt:new Date().toISOString(),children:[{id:'child',mode:'write',status:'completed',task:'实现按钮',writePaths:['a.js'],changedPaths:['a.js'],startedAt:'2026-10-27T00:00:00Z',finishedAt:'2026-10-27T00:00:02Z',result:'已修改'}]};const html=f.run('activity(globalThis.turn)');assert.match(html,/写入助手/);assert.match(html,/允许修改：a.js/);assert.match(html,/实际修改：a.js/);assert.doesNotMatch(html,/只读助手/);
});

test('memory UI local VM: exact backend length limits are visible and oversized restored drafts never post',async()=>{
 const f=fixture();f.run('renderMemory=()=>{}');f.ctx.memory={revision:2,entries:[{id:'m',title:'标题',text:'正文',version:1}]};f.run('memoryState=globalThis.memory;beginMemoryEdit("m")');const html=f.run('memoryMarkup()');assert.match(html,/maxlength="160"/);assert.match(html,/maxlength="4000"/);assert.match(html,/最多 160 字符/);assert.match(html,/最多 4000 字符/);
 f.run("memoryEditor.text='长'.repeat(4001)");await f.run("changeMemory('edit')");assert.equal(f.calls.length,0);assert.equal(f.run('memoryEditor.text.length'),4001);assert.match(f.run('memoryError'),/4000/);
 f.run("memoryEditor.text='长'.repeat(4000);memoryEditor.title='名'.repeat(161)");await f.run("changeMemory('edit')");assert.equal(f.calls.length,0);assert.match(f.run('memoryError'),/160/);
 f.run("memoryEditor.title='名'.repeat(160)");f.ctx.transport=async(url,body)=>{f.calls.push({url,body});return{revision:3,entries:[]};};await f.run("changeMemory('edit')");assert.equal(f.calls.length,1);assert.equal(f.calls[0].body.title.length,160);assert.equal(f.calls[0].body.text.length,4000);
});

test('Noobi UI local VM: code and brief retain specific activity, reasoning lifecycle is not new work progress',()=>{
 const f=fixture();assert.equal(f.run("noobiEventLabel({type:'noobi_progress',phase:'code',title:'Implementer · analyzing workspace'})"),'检查项目');assert.equal(f.run("noobiEventLabel({type:'noobi_state',phase:'code'})"),'制作小游戏');assert.equal(f.run("noobiEventLabel({type:'noobi_state',phase:'brief'})"),'梳理游戏要求');assert.equal(f.run("noobiEventLabel({type:'noobi_progress',phase:'brief',title:'Reviewer · verifying build'})"),'检查成果');
 for(const event of [{type:'noobi_tool',method:'item/reasoning/started'},{type:'noobi_tool',method:'item/reasoning/completed'},{type:'noobi_tool',method:'item/started',title:'Planner · reasoning started'},{type:'noobi_tool',method:'item/completed',title:'Implementer · reasoning completed'}]){f.ctx.event=event;assert.equal(f.run('noobiProgressEvent(globalThis.event)'),false);assert.equal(f.run('noobiEventLabel(globalThis.event)'),'内部思考记录');}
 f.ctx.job={status:'running',createdAt:'2000-01-01T00:00:00Z',events:[{type:'noobi_state',phase:'code',at:'2000-01-01T00:00:01Z'},{type:'noobi_tool',method:'item/completed',title:'Implementer · reasoning completed',at:new Date().toISOString()}]};assert.equal(f.run('noobiProgress(globalThis.job)'),'制作小游戏');f.ctx.conv={turns:[{noobiJobs:[f.ctx.job]}]};assert.match(f.run('noobiStatus(globalThis.conv)'),/尚未收到新的制作结果/);
});

test('memory UI actual refresh/renderSettings/html path: polling and settings changes retain editor node, caret, and 409 draft',async()=>{
 const f=fixture();const slots=new Map();let replacements=0,settingsWrites=0;
 function slot(){let content='',editor=null;return {dataset:{},memoryHTML:null,get childElementCount(){return content?1:0;},get innerHTML(){return content;},set innerHTML(value){content=value;const match=value.match(/<textarea name="text"[^>]*>([\s\S]*?)<\/textarea>/);editor=match?{name:'text',value:match[1],selectionStart:0,selectionEnd:0,closest:()=>({}),focus(){f.ctx.document.activeElement=this;},setSelectionRange(a,b){this.selectionStart=a;this.selectionEnd=b;}}:null;},contains(node){return editor===node;},querySelector(selector){return selector==='[data-memory-editor]'?editor:selector==='[name=text]'?editor:null;},replaceChildren(){content='';editor=null;},replaceWith(node){replacements++;slots.set('#wb-memory-settings',node);}};}
 const connection={set innerHTML(value){settingsWrites++;this.content=value;f.ctx.document.activeElement=null;slots.set('#wb-memory-settings',slot());},get innerHTML(){return this.content||'';}};slots.set('#connection-list',connection);
 f.ctx.document.querySelector=selector=>slots.get(selector)||null;
 f.ctx.memory={revision:2,entries:[{id:'m',title:'短句',text:'原始正文',version:1,scopeLabel:'个人'}],defaults:[]};f.run("memoryState=globalThis.memory;memoryTarget='settings';renderSettings();beginMemoryEdit('m')");
 const initialSlot=slots.get('#wb-memory-settings'),input=initialSlot.querySelector('[name=text]');input.value='尚未保存的正文与引用说明';input.selectionStart=3;input.selectionEnd=8;f.ctx.document.activeElement=input;f.ctx.inputEvent={target:input};f.run('captureMemoryEditor(globalThis.inputEvent)');
 f.run('refresh=globalThis.realRefresh;render=()=>{renderSettings();renderMemory();}');f.ctx.transport=async()=>structuredClone(f.base);
 for(let i=0;i<4;i++)await f.run('refresh()');assert.equal(settingsWrites,1);assert.equal(slots.get('#wb-memory-settings'),initialSlot);assert.equal(slots.get('#wb-memory-settings').querySelector('[name=text]'),input);assert.deepEqual([input.selectionStart,input.selectionEnd],[3,8]);
 f.base.preferences.fontSize=22;f.base.catalogue.providers=[{id:'fixture',name:'测试连接',status:'connected'}];f.base.build='updated-build';await f.run('refresh()');assert.equal(settingsWrites,2);assert.equal(replacements,1);assert.equal(slots.get('#wb-memory-settings').querySelector('[name=text]'),input);assert.equal(input.value,'尚未保存的正文与引用说明');assert.equal(f.ctx.document.activeElement,input);assert.deepEqual([input.selectionStart,input.selectionEnd],[3,8]);
 f.ctx.transport=async(url)=>{if(url==='/api/office/memory')throw Object.assign(new Error('版本冲突'),{status:409});return structuredClone(f.base);};await f.run("changeMemory('edit')");const conflictInput=slots.get('#wb-memory-settings').querySelector('[name=text]');assert.equal(conflictInput.value,'尚未保存的正文与引用说明');assert.equal(f.run('memoryEditor.conflict'),true);
 f.base.preferences.fontSize=18;for(let i=0;i<4;i++)await f.run('refresh()');assert.equal(slots.get('#wb-memory-settings').querySelector('[name=text]'),conflictInput);assert.equal(conflictInput.value,'尚未保存的正文与引用说明');assert.equal(f.run('memoryEditor.conflict'),true);assert.match(f.run('localStorage.getItem(memoryDraftKey())'),/尚未保存的正文/);
});


test('讨论读取失败不误报成果功能检查失败；实际制作检查仍保留',()=>{
 const f=fixture();const conv=c('failed-discussion','archivist');
 conv.turns=[{id:'failed-read',createdAt:'2026-10-27T17:26:28Z',status:'failed',classifiedMode:'discuss',error:'Run one tool at a time when changing files or running commands, so checks cannot race with edits.'}];
 f.ctx.conv=conv;let html=f.run('results(conv)');assert.match(html,/本次讨论或资料核对尚未完成/);assert.match(html,/多项操作的提交被系统拦截/);assert.match(html,/消息和资料已保留/);assert.doesNotMatch(html,/功能检查尚未确认通过|成果检查尚未通过|尚未采用工作副本/);
 conv.turns[0].error='Read check unavailable';html=f.run('results(conv)');assert.doesNotMatch(html,/成果检查尚未通过/);
 Object.assign(conv.turns[0],{classifiedMode:'execute',workspace:'/isolated-example',error:'成果实际功能检查尚未通过'});html=f.run('results(conv)');assert.match(html,/成果检查尚未通过/);assert.match(html,/工作副本已保留/);
});
