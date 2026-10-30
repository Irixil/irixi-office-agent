import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runOmoNativeRpcRole, nativeProviderSettings, OMO_NATIVE_BINARY } from './native-rpc-runner.mjs';

const enabled = process.env.IRIXI_RUN_NATIVE_TOOL_TESTS === '1';
const decision = JSON.stringify({content:[{type:'text',text:'受控决策，未调用产品模型'}]});
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'native-provider-cancel-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  return { root, options:{role:'Chat',prompt:'Controlled local provider cancellation check.',cwd:root,conversation:true,decisionOnly:true,timeoutMs:15000} };
}

test('私有 provider 等待使用宿主有限预算；关闭自动重试但不关闭超时',()=>{
  assert.deepEqual(nativeProviderSettings(null,600000),{retry:{enabled:false,maxRetries:0,provider:{maxRetries:0,timeoutMs:600000,streamStartTimeoutMs:600000}}});
  assert.equal(nativeProviderSettings(20000,null).retry.provider.streamStartTimeoutMs,20000);
  assert.throws(()=>nativeProviderSettings(null,null),/finite/);
  assert.throws(()=>nativeProviderSettings(Infinity,0),/finite/);
});

test('actual OmO: 原生流超时传到宿主，原决策停止，迟到结果不成功且无第二调用', {skip:!enabled}, async t=>{
  const f=await fixture(t), wrapper=path.join(f.root,'omo-wrapper');
  const captured=path.join(f.root,'captured-settings.json');
  const settings={retry:{enabled:true,maxRetries:1,baseDelayMs:20,provider:{maxRetries:0,timeoutMs:200,streamStartTimeoutMs:200}}};
  // Only shorten the native stream timer in this host-created private session.
  await fs.writeFile(wrapper,`#!${process.execPath}\nimport fs from 'node:fs';import path from 'node:path';import {spawn} from 'node:child_process';\nconst dir=process.env.OMO_CODING_AGENT_DIR;fs.copyFileSync(path.join(dir,'settings.json'),${JSON.stringify(captured)});fs.writeFileSync(path.join(dir,'settings.json'),${JSON.stringify(JSON.stringify(settings))});\nconst child=spawn(${JSON.stringify(OMO_NATIVE_BINARY)},process.argv.slice(2),{stdio:'inherit',env:process.env});process.on('SIGTERM',()=>child.kill('SIGTERM'));child.on('exit',code=>process.exit(code??1));\n`,{mode:0o700});
  let calls=0,aborted=false,lateReturned=false;
  await assert.rejects(runOmoNativeRpcRole({...f.options,executable:wrapper,runModelDecision:async(_p,_n,signal)=>{
    calls++;
    signal.addEventListener('abort',()=>{aborted=true},{once:true});
    await new Promise(resolve=>setTimeout(resolve,750));
    lateReturned=true;return decision;
  }}),error=>error.code==='OMO_PROVIDER_REQUEST_TIMEOUT'&&/模型本次未及时返回/.test(error.message)&&!/overlapping/.test(error.message));
  assert.equal(calls,1);assert.equal(aborted,true);assert.equal(lateReturned,true);
  const actual=JSON.parse(await fs.readFile(captured,'utf8'));
  assert.deepEqual(actual,nativeProviderSettings(f.options.timeoutMs,null));
});

test('actual OmO: 健康顺序读取与下一决策仍通过；真正用户停止也会终止当前决策',{skip:!enabled},async t=>{
  const f=await fixture(t);let calls=0;
  await fs.writeFile(path.join(f.root,'input.txt'),'synthetic material');
  const result=await runOmoNativeRpcRole({...f.options,decisionOnly:false,runModelDecision:async()=>{
    calls++;await new Promise(resolve=>setTimeout(resolve,100));
    return calls===1?JSON.stringify({content:[{type:'toolCall',name:'read',arguments:{path:'input.txt'}}]}):decision;
  }});
  assert.equal(result.providerDecisionRequests,2);assert.equal(result.toolReceiptSummary.receipts.filter(r=>r.eventType==='end'&&!r.isError).length,1);
  const control=new AbortController();let stopped=false;
  await assert.rejects(runOmoNativeRpcRole({...f.options,signal:control.signal,runModelDecision:async(_p,_n,signal)=>{
    setTimeout(()=>control.abort(),50);return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{stopped=true;reject(new Error('script cancelled'))},{once:true}));
  }}),error=>error.code==='ABORTED');assert.equal(stopped,true);
});

test('真正重叠仍拒绝；错误身份的取消不能释放当前请求',{skip:!enabled},async t=>{
  const f=await fixture(t), fake=path.join(f.root,'fake-omo');
  await fs.writeFile(fake,`#!${process.execPath}\nimport readline from 'node:readline';import net from 'node:net';\nconst model=process.env.IRIXI_OMO_MODEL_ID;const state={sessionId:'controlled-overlap',model:{provider:'irixi-codex-bridge',id:model}};const out=v=>process.stdout.write(JSON.stringify(v)+'\\n');readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);out({type:'response',id:r.id,success:true,data:r.type==='get_state'?state:{}});if(r.type==='prompt'){const s=net.createConnection(process.env.IRIXI_OMO_BRIDGE_SOCKET);s.on('error',()=>{});s.on('connect',()=>{const payload={provider:'irixi-codex-bridge',modelId:model,messages:[],tools:[]};s.write(JSON.stringify({id:'one',kind:'model',payload})+'\\n');setTimeout(()=>s.write(JSON.stringify({id:'wrong',kind:'model_cancel',reason:'cancel wrong request'})+'\\n'+JSON.stringify({id:'two',kind:'model',payload})+'\\n'),30);});}});\n`,{mode:0o700});
  let calls=0,aborted=false;
  await assert.rejects(runOmoNativeRpcRole({...f.options,executable:fake,runModelDecision:async(_p,_n,signal)=>{
    calls++;return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(new Error('cancelled'))},{once:true}));
  }}),/overlapping provider decisions/);
  assert.equal(calls,1);assert.equal(aborted,true);
});

async function controlledRpc(f, kind, cancel = false) {
  const fake=path.join(f.root,`controlled-${kind}`);
  await fs.writeFile(fake,`#!${process.execPath}\nimport readline from 'node:readline';import net from 'node:net';const model=process.env.IRIXI_OMO_MODEL_ID;const state={sessionId:'controlled-lifecycle',model:{provider:'irixi-codex-bridge',id:model}};const out=v=>process.stdout.write(JSON.stringify(v)+'\\n');readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);out({type:'response',id:r.id,success:true,data:r.type==='get_state'?state:{}});if(r.type==='prompt'){const s=net.createConnection(process.env.IRIXI_OMO_BRIDGE_SOCKET);s.on('error',()=>{});s.on('connect',()=>{s.write(JSON.stringify({id:'one',kind:${JSON.stringify(kind)},payload:{provider:'irixi-codex-bridge',modelId:model,messages:[],tools:[]}})+'\\n');${cancel ? "setTimeout(()=>s.write(JSON.stringify({id:'one',kind:'model_cancel',reason:'Idle timeout waiting for provider stream after 150ms'})+'\\n'),150);" : ''}});}});\n`,{mode:0o700});return fake;
}

test('provider 取消后永不 settle：3秒内结束等待但明确退出未确认；迟到结果不能转成功',{skip:!enabled,timeout:20000},async t=>{
  const f=await fixture(t),fake=await controlledRpc(f,'model',true);let aborted=false,abortedAt=null,resolveDecision,calls=0;
  await assert.rejects(runOmoNativeRpcRole({...f.options,executable:fake,runModelDecision:async(_p,_n,signal)=>{
    calls++;signal.addEventListener('abort',()=>{aborted=true;abortedAt=Date.now()},{once:true});return new Promise(resolve=>{resolveDecision=resolve});
  }}),error=>error.code==='OMO_PROVIDER_EXIT_UNCONFIRMED'&&error.providerTermination.nativeProcessExited===true&&error.providerTermination.decisionCallbackSettled===false&&error.providerTermination.causeCode==='OMO_PROVIDER_REQUEST_TIMEOUT'&&/收尾尚未确认/.test(error.message)&&!/工作已停下/.test(error.message));
  assert.equal(aborted,true);assert.equal(calls,1);assert.ok(abortedAt!==null);assert.ok(Date.now()-abortedAt<5500);
  resolveDecision(decision);await new Promise(resolve=>setTimeout(resolve,50));assert.equal(calls,1);
});

test('Noobi宿主工具取消仍完整等待安全收尾，不套provider三秒分离',{skip:!enabled,timeout:10000},async t=>{
  const f=await fixture(t),fake=await controlledRpc(f,'noobi_run');const controller=new AbortController();let startedAt,ended=false,aborted=false;
  await assert.rejects(runOmoNativeRpcRole({...f.options,role:'Developer',decisionOnly:false,signal:controller.signal,executable:fake,runModelDecision:()=>{throw new Error('must not request a decision')},onNoobi:async(_request,signal)=>{
    startedAt=Date.now();signal.addEventListener('abort',()=>{aborted=true},{once:true});setTimeout(()=>controller.abort(),30);
    await new Promise(resolve=>setTimeout(resolve,3300));ended=true;return {controlledBoundary:true};
  }}),error=>error.code==='ABORTED');assert.equal(aborted,true);assert.equal(ended,true);assert.ok(Date.now()-startedAt>=3300);
});

test('Store外层abort不能把退出未确认改写为已停止；普通取消保持stopped',{timeout:10000},async t=>{
  const {ConversationStore}=await import('./conversation-store.mjs');const f=await fixture(t);const store=new ConversationStore({runtimeDir:f.root,catalogueReader:async()=>({models:[]})});
  await fs.mkdir(store.root,{recursive:true});const turn={id:'controlled-turn',status:'working'};const c={id:'controlled-conversation',turns:[turn],messages:[]};store.state.conversations.push(c);
  const controller=new AbortController();controller.abort();store.runTurn=async()=>{throw Object.assign(new Error('停止处理中：模型调用的收尾尚未确认。本轮未采用结果。'),{code:'OMO_PROVIDER_EXIT_UNCONFIRMED',providerTermination:{nativeProcessExited:true,decisionCallbackSettled:false}})};
  store.launch(c,turn,controller);await store.jobs.get(turn.id);
  assert.equal(turn.status,'interrupted');assert.equal(turn.providerTermination.status,'unconfirmed');assert.equal(turn.providerTermination.nativeProcessExited,true);
  const saved=JSON.parse(await fs.readFile(store.file,'utf8'));assert.equal(saved.conversations[0].turns[0].providerTermination.status,'unconfirmed');assert.equal(store.jobs.size,0);
  const normal={id:'normal-stop',status:'working'};c.turns.push(normal);store.runTurn=async()=>{throw Object.assign(new Error('cancelled'),{code:'ABORTED'})};store.launch(c,normal,controller);await store.jobs.get(normal.id);assert.equal(normal.status,'stopped');
});

test('退出未确认在状态与进度面板明确显示，不被普通interrupted文案盖住',async()=>{
  const vm=await import('node:vm');const text=await fs.readFile(new URL('../app/public/conversation-app.js',import.meta.url),'utf8');
  const label=text.match(/function turnStateLabel\(turn\) \{[^\n]+\}/)[0];const issue=text.slice(text.indexOf('function workIssue(turn)'),text.indexOf('function results(c)'));
  const ctx=vm.createContext({labels:{interrupted:'工作中断，记录已保留'}});vm.runInContext(label+'\n'+issue,ctx);
  const turn={status:'interrupted',providerTermination:{status:'unconfirmed'}};assert.match(ctx.turnStateLabel(turn),/停止处理中.*收尾未确认/);assert.match(ctx.workIssue(turn),/收尾未确认/);
});

test('交接回调退出未确认时，保留待发输入但不自动启动新模型轮',async t=>{
  const {ConversationStore}=await import('./conversation-store.mjs');const f=await fixture(t);let entered,release,requests=0;
  const gate=new Promise(resolve=>{entered=resolve});const pending=new Promise(resolve=>{release=resolve});
  const store=new ConversationStore({runtimeDir:f.root,catalogueReader:async()=>({models:[{provider:'desktop-codex',id:'gpt-6-luna',efforts:['medium'],defaultEffort:'medium'}]}),omoRunner:async()=>{
    requests++;entered();await pending;throw Object.assign(new Error('停止处理中：模型调用的收尾尚未确认。'),{code:'OMO_PROVIDER_EXIT_UNCONFIRMED',providerTermination:{status:'unconfirmed',nativeProcessExited:true,decisionCallbackSettled:false}});
  }});await store.init();const c=await store.create({requestId:'create',colleagueId:'researcher'});
  const transfer=await store.handoff(c.id,{requestId:'handoff',to:'reviewer'});await gate;
  const held=await store.send(c.id,{requestId:'held',text:'先讨论，继续保留蓝色主题'});assert.equal(held.heldForTransferId,transfer.id);
  release();while(store.jobs.size)await Promise.all([...store.jobs.values()]);
  assert.equal(requests,1);assert.equal(c.work.ownerId,'researcher');assert.equal(c.handoffRuns[0].status,'interrupted');assert.equal(held.status,'interrupted');assert.equal(held.heldForTransferId,null);assert.equal(held.calls.length,0);assert.equal(c.messages[0].text,'先讨论，继续保留蓝色主题');
});
