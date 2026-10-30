import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import { noobiPlaytestEvidence, NOOBI_PLAYTEST_GUIDANCE } from './noobi-verification.mjs';
import { noobiNotificationFacts } from './noobi-events.mjs';

const broken = { verdict: 'repair', summary: '体验评测发现 3 项需要修复。', errors: [{ kind: 'configuration', message: 'playtest.journey[0].id 重复：launch', fatal: true }], checks: [{ id: 'load', status: 'repair', message: '本地预览未完成加载。' }] };
const passed = { verdict: 'pass', summary: '试玩通过', errors: [], checks: [{ id: 'load', status: 'pass', message: '已加载。' }] };
const options = (playtest) => ({ playtest, root: '/not-opened', previewUrl: 'http://127.0.0.1:1234/', loadedUrls: new Set(), signal: new AbortController().signal });

test('保留已知 launch 重复诊断，不用空 coverage 覆盖，不给失败报告交付证明', async () => {
 let coverageCalls=0;const result=await noobiPlaytestEvidence({...options(broken),coverageReader:async()=>{coverageCalls++;throw new Error('没有实际打开正式小游戏入口。');}});
 assert.equal(coverageCalls,0);assert.match(result.findings.join('\n'),/playtest\.journey\[0\]\.id 重复：launch/);assert.match(result.findings.join('\n'),/本地预览未完成加载/);assert.doesNotMatch(result.findings.join('\n'),/没有实际打开正式小游戏入口/);assert.deepEqual(result.checkedFiles,{});
});
test('页面实际已加载但试玩失败，保留运行错误和失败步骤，不授予可用 coverage',async()=>{
 const report={...broken,errors:[{kind:'runtime',message:'TypeError: basket is null',fatal:true}],checks:[{id:'load',status:'pass'},{id:'restart',status:'repair',message:'重开后未清零'}]};let called=false;
 const result=await noobiPlaytestEvidence({...options(report),loadedUrls:new Set(['http://127.0.0.1:1234/']),coverageReader:async()=>{called=true;return {'dist/index.html':'fake'};}});
 assert.equal(called,false);assert.match(result.findings.join('\n'),/basket is null/);assert.match(result.findings.join('\n'),/重开后未清零/);assert.deepEqual(result.checkedFiles,{});
});
test('报告标 pass 但具体检查失败，不能被空泛 pass 放行',async()=>{
 const result=await noobiPlaytestEvidence(options({...broken,verdict:'pass'}));assert.ok(result.findings.length);assert.deepEqual(result.checkedFiles,{});
});
test('pass 但缺少实际入口加载记录，返回可修 coverage 问题，不抛出整个 Harness',async(t)=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'noobi-coverage-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.mkdir(path.join(root,'dist'));await fs.writeFile(path.join(root,'dist/index.html'),'<h1>actual candidate</h1>');
 const result=await noobiPlaytestEvidence({...options(passed),root});assert.match(result.findings[0],/^PLAYTEST_COVERAGE: 没有实际打开正式小游戏入口/);assert.deepEqual(result.checkedFiles,{});
});
test('仅通过报告和加载文件哈希共同成立时返回 coverage（加载集合为受控测试输入）',async(t)=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'noobi-coverage-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.mkdir(path.join(root,'dist'));await fs.writeFile(path.join(root,'dist/index.html'),'<h1>actual candidate</h1>');
 const result=await noobiPlaytestEvidence({...options(passed),root,loadedUrls:new Set(['http://127.0.0.1:1234/'])});assert.deepEqual(result.findings,[]);assert.match(result.checkedFiles['dist/index.html'],/^[a-f0-9]{64}$/);
});
test('停止不变成可修问题：开始前、coverage期间以及 AbortError 均传播',async()=>{
 const early=new AbortController();early.abort(new Error('stopped before check'));await assert.rejects(noobiPlaytestEvidence({...options(broken),signal:early.signal}),/stopped before/);
 const during=new AbortController();await assert.rejects(noobiPlaytestEvidence({...options(passed),signal:during.signal,coverageReader:async()=>{during.abort(new Error('stopped while reading'));throw new Error('secondary coverage error');}}),/stopped while reading/);
 await assert.rejects(noobiPlaytestEvidence({...options(passed),coverageReader:async()=>{throw new DOMException('stopped','AbortError');}}),{name:'AbortError'});
});
test('过滤内部回复、逐字输出、用户全文、推理及补丁增量；保留工具开始结束和图片完成事实',()=>{
 const noise=[{method:'item/agentMessage/delta'},{method:'item/commandExecution/outputDelta'},{method:'item/reasoning/summaryTextDelta'},{method:'item/fileChange/patchUpdated'},...['agentMessage','userMessage','reasoning'].flatMap(type=>['item/started','item/completed'].map(method=>({method,params:{item:{type,text:'not durable'}}})))];
 assert.ok(noise.every(n=>!noobiNotificationFacts(n).persistProgress));
 for(const type of ['commandExecution','fileChange','dynamicToolCall','mcpToolCall','imageGeneration'])for(const method of ['item/started','item/completed'])assert.equal(noobiNotificationFacts({method,params:{item:{type}}}).persistProgress,true);
 for(const method of ['turn/started','turn/completed','turn/plan/updated','serverRequest/resolved','error','warning','harness/run/stop-requested','harness/run/stopped','harness/implementer/completed'])assert.equal(noobiNotificationFacts({method}).persistProgress,true);
 const item={type:'imageGeneration',status:'completed',savedPath:'/controlled/generated.png',revisedPrompt:'image'};const facts=noobiNotificationFacts({method:'item/completed',params:{item}});assert.equal(facts.generatedImage,item);assert.equal(facts.persistProgress,true);assert.equal(noobiNotificationFacts({method:'item/completed',params:{item:{...item,status:'failed'}}}).generatedImage,null);
});
test('宿主补充契约明确保留编号、逐步对照、坐标、最终 success 和生产素材要求',()=>{
 for(const text of ['launch、success、post-action-settle','baselineStepId','Canvas','success 只在全部 journey 结束','只服务 dist'])assert.ok(NOOBI_PLAYTEST_GUIDANCE.includes(text));
});

// Real selected GameHarness code; runtime decisions are scripted. No model,
// browser, image generation or service is launched by these integration cases.
class ScriptedRuntime extends EventEmitter {
 constructor(responses){super();this.responses=responses;this.turns=[];this.threads=[];}
 async startThread(o){this.threads.push(o);return 'thread-'+this.threads.length;}
 async startTurn(o){this.turns.push(o);const id='turn-'+this.turns.length,text=this.responses.shift()||'';queueMicrotask(()=>{this.emit('notification',{method:'item/completed',params:{threadId:o.threadId,turnId:id,item:{type:'agentMessage',text}}});this.emit('notification',{method:'turn/completed',params:{threadId:o.threadId,turnId:id,turn:{id,status:'completed'}}});});return id;}
 async unsubscribeThread(){} async interruptTurn(){} async stop(){}
}
const build=process.env.IRIXI_NOOBI_TEST_BUILD;
const loadHarness=async()=>import(pathToFileURL(path.join(build,'dist/main/gameHarness.js')).href);
const review=JSON.stringify({verdict:'pass',summary:'controlled review',findings:[]});
test('真实 selected Harness 收到 launch 错误后进入原修复轮，修复后先重跑宿主再审阅',{skip:!build},async()=>{
 const {GameHarness}=await loadHarness(),runtime=new ScriptedRuntime(['plan','implementation',review,'repaired configuration',review]),harness=new GameHarness(runtime),events=[];harness.on('event',e=>events.push(e));let checks=0;
 const result=await harness.run({projectId:'noobi-controlled-loop',cwd:'/controlled/noobi-copy',prompt:'controlled adapter test',imageGenerationSkill:{name:'imagegen',path:'/controlled/imagegen/SKILL.md'},validateHostDelivery:async(signal)=>{checks++;const evidence=await noobiPlaytestEvidence({...options(checks===1?broken:passed),signal,coverageReader:async()=>({'dist/index.html':'controlled-hash'})});return {ok:evidence.findings.length===0,findings:evidence.findings};}});
 assert.equal(checks,2);assert.equal(result.repairAttempts,1);assert.match(runtime.turns[3].prompt,/playtest\.journey\[0\]\.id 重复：launch/);assert.ok(events.some(e=>e.method==='harness/host-delivery/repair'));assert.ok(events.some(e=>e.method==='harness/implementer/completed'&&e.message==='implementation'));assert.ok(events.some(e=>e.method==='harness/run/delivery-verified'));assert.equal(result.review.verdict,'pass');
});
test('真实 selected Harness 停止宿主检查时退出为 stopped，不进入修复或完成',{skip:!build},async()=>{
 const {GameHarness}=await loadHarness(),runtime=new ScriptedRuntime(['plan','implementation',review]),harness=new GameHarness(runtime),methods=[];harness.on('event',e=>methods.push(e.method));let entered;const ready=new Promise(r=>entered=r);
 const job=harness.run({projectId:'noobi-controlled-stop',cwd:'/controlled/noobi-copy',prompt:'controlled cancellation test',imageGenerationSkill:{name:'imagegen',path:'/controlled/imagegen/SKILL.md'},validateHostDelivery:async(signal)=>{entered();return noobiPlaytestEvidence({...options(passed),signal,coverageReader:()=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('stopped','AbortError')),{once:true}))});}});
 await ready;const stop=harness.stop('noobi-controlled-stop');await assert.rejects(job,/stopped/i);await stop;assert.ok(methods.includes('harness/run/stop-requested'));assert.ok(methods.includes('harness/run/stopped'));assert.ok(!methods.includes('harness/repair/attempt-started'));assert.ok(!methods.includes('harness/run/delivery-verified'));
});
