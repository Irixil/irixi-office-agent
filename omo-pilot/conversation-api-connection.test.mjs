import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { ConversationStore } from './conversation-store.mjs';
import { runParallelWork } from './conversation-parallel.mjs';
import { validateModelSelection } from './conversation-models.mjs';
import { runOmoNativeRpcRole } from './native-rpc-runner.mjs';
import { runCodexRole } from '../app/codex-role-adapter.mjs';
const selection={provider:'desktop-codex',model:'gpt-6-luna',effort:'medium',connectionId:'openai-api-key'};
const catalogue={models:[{provider:'desktop-codex',id:'gpt-6-luna',efforts:['low','medium']}]};
const answer=text=>({status:'model_returned',output:{text},sessionId:'synthetic-only'});
async function drain(store){while(store.jobs.size)await Promise.all([...store.jobs.values()]);}
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'irixi-api-store-')),seen=[];let revision='rev-1',configured=true;
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const options={runtimeDir:root,catalogueReader:async()=>catalogue,credentialStatusReader:async()=>({configured,revision}),
  modelRunner:async input=>{seen.push({connectionId:input.connectionId,connectionRevision:input.connectionRevision,model:input.model,role:input.role});const r=await input.reserve({role:input.role,binding:input.binding});const result=answer(JSON.stringify({content:[{type:'text',text:JSON.stringify({mode:'discuss',reply:'synthetic reply',title:'Synthetic',readPaths:[]})}]}));await input.settle(r,result);return result;},
  omoRunner:async input=>{const result=await input.runModelDecision({tools:[],messages:[]},1,input.signal);return answer(JSON.parse(result).content[0].text);}};
 const store=new ConversationStore(options);await store.init();const c=await store.create({requestId:'new'});
 return {root,store,c,seen,options,setRevision:v=>{revision=v;},remove:()=>{configured=false;revision=null;}};
}
test('selection binds current revision; send, model-only edit and fork preserve connection identity',async t=>{
 const f=await fixture(t);await f.store.update(f.c.id,{modelSelection:selection});
 assert.equal(f.c.modelSelection.connectionRevision,'rev-1');
 await f.store.send(f.c.id,{requestId:'one',text:'先讨论'});await drain(f.store);
 assert.equal(f.seen[0].connectionId,'openai-api-key');assert.equal(f.seen[0].connectionRevision,'rev-1');
 await f.store.update(f.c.id,{modelSelection:{provider:'desktop-codex',model:'gpt-6-luna',effort:'low'}});
 assert.equal(f.c.modelSelection.connectionId,'openai-api-key');
 const branch=await f.store.fork(f.c.id,{requestId:'fork',messageId:f.c.messages.at(-1).id});assert.deepEqual(branch.modelSelection,f.c.modelSelection);
 await f.store.send(branch.id,{requestId:'branch',text:'继续讨论'});await drain(f.store);
 assert.ok(f.seen.every(x=>x.connectionId==='openai-api-key'&&x.connectionRevision==='rev-1'));
 await f.store.update(f.c.id,{modelSelection:{...selection,connectionId:null}});assert.equal(f.c.modelSelection.connectionId,undefined);
 await f.store.send(f.c.id,{requestId:'legacy',text:'先讨论'});await drain(f.store);assert.equal(f.seen.at(-1).connectionId,null);
});
test('rotation/deletion rejects stale sends and reopen never auto-calls or rebinds new credential',async t=>{
 const f=await fixture(t);await f.store.update(f.c.id,{modelSelection:selection});await f.store.send(f.c.id,{requestId:'one',text:'先讨论'});await drain(f.store);
 f.setRevision('rev-2');const count=f.seen.length;
 const restored=new ConversationStore(f.options);await restored.init();assert.equal(f.seen.length,count);
 await assert.rejects(restored.send(f.c.id,{requestId:'resume',text:'继续'}),/已更换/);assert.equal(f.seen.length,count);
 assert.equal(restored.conversation(f.c.id).turns[0].modelSelection.connectionRevision,'rev-1');
 await restored.update(f.c.id,{modelSelection:selection});assert.equal(restored.conversation(f.c.id).modelSelection.connectionRevision,'rev-2');
 await restored.send(f.c.id,{requestId:'explicit-new',text:'先讨论'});await drain(restored);assert.equal(f.seen.at(-1).connectionRevision,'rev-2');
 f.remove();await assert.rejects(restored.send(f.c.id,{requestId:'missing',text:'继续'}),/请先打开密钥文件填写并保存 OpenAI API Key，未回退原登录。/);
});
test('read and write assistants retain parent connection despite changing current conversation selection',async t=>{
 const f=await fixture(t);await f.store.update(f.c.id,{modelSelection:selection});
 const workspace=path.join(f.root,'synthetic-component');await fs.mkdir(workspace);await fs.writeFile(path.join(workspace,'one.txt'),'source');await fs.writeFile(path.join(workspace,'two.txt'),'source');
 const parent={id:'turn-component',requestId:'component',text:'component fixture',intent:'execute',status:'working',workspace,projectId:'component',modelSelection:structuredClone(f.c.modelSelection),children:[],events:[],calls:[],receipts:[],processes:[]};f.c.turns.push(parent);
 await f.store.update(f.c.id,{modelSelection:{...selection,connectionId:null}});
 await f.store.delegate(f.c,parent,{requestId:'read',task:'inspect source',paths:['one.txt']},workspace,new AbortController().signal);
 await runParallelWork(f.store,f.c,parent,{requestId:'parallel',tasks:[{task:'inspect first',writePaths:['one.txt']},{task:'inspect second',writePaths:['two.txt']}]},workspace,new AbortController().signal);
 assert.equal(parent.children.length,3);for(const child of parent.children)assert.deepEqual(child.modelSelection,parent.modelSelection);
 assert.equal(f.seen.length,3);assert.ok(f.seen.every(x=>x.connectionId==='openai-api-key'&&x.connectionRevision==='rev-1'));
});
test('API route refuses Noobi before launching original account; unknown connections do not fall back',async t=>{
 const f=await fixture(t);let launched=false;f.store.noobiRunner=async()=>{launched=true;throw new Error('must not launch');};
 await assert.rejects(f.store.runNoobi(f.c,{modelSelection:selection},{},f.root,new AbortController().signal),/未调用原 Codex/);assert.equal(launched,false);
 assert.throws(()=>validateModelSelection(catalogue,{...selection,connectionId:'deepseek'}),/不能用于项目/);
});
test('project command process strips a synthetic key inherited by the host process',async t=>{
 if(process.platform!=='darwin')return t.skip('macOS command sandbox');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'irixi-key-command-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const moduleURL=new URL('./conversation-command.mjs',import.meta.url).href;
 const script=`import {executeConversationCommand} from ${JSON.stringify(moduleURL)};const result=await executeConversationCommand({command:'/usr/bin/python3 -c '+${JSON.stringify("\"import os,json; print(json.dumps({k:k in os.environ for k in ['CODEX_API_KEY','OPENAI_API_KEY']}))\"")}}, {root:${JSON.stringify(root)}});process.stdout.write(JSON.stringify({exitCode:result.details.exitCode,stdout:result.details.stdout,error:result.details.stderr}));`;
 const child=spawn(process.execPath,['--input-type=module','-e',script],{env:{PATH:process.env.PATH,HOME:root,CODEX_API_KEY:'synthetic-host-key',OPENAI_API_KEY:'synthetic-openai-key'},stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);const code=await new Promise(resolve=>child.on('close',resolve));
 assert.equal(code,0,stderr);const result=JSON.parse(stdout);assert.equal(result.exitCode,0,JSON.stringify(result));assert.deepEqual(JSON.parse(result.stdout),{CODEX_API_KEY:false,OPENAI_API_KEY:false});
});

test('DeepSeek is rejected before any native runtime discovery or model process',async()=>{
 for(const s of [{provider:'deepseek',model:'gpt-6-luna'}, {provider:'desktop-codex',model:'deepseek-flash'}]){
  assert.throws(()=>validateModelSelection(catalogue,{...s,effort:'medium'}),/仅限连接验证/);
  await assert.rejects(runOmoNativeRpcRole({role:'Chat',prompt:'synthetic-only',runModelDecision:async()=>'',modelSelection:s,homeDir:'/does-not-exist'}),/仅限连接验证/);
 }
 await assert.rejects(runCodexRole({role:'Chat',model:'deepseek-flash'}),/仅限连接验证/);
});
test('role handoff uses the source connection and does not silently fall back during receiving',async t=>{
 const f=await fixture(t);await f.store.update(f.c.id,{modelSelection:selection});
 const original=f.store.modelRunner;
 f.store.modelRunner=async input=>{
  const result=await original(input),match=input.prompt.match(/返回且只返回JSON：(\{[^\n]+\})。/u);
  if(match)result.output.text=JSON.stringify({content:[{type:'text',text:JSON.stringify({...JSON.parse(match[1]),summary:'synthetic handoff'})}]});
  return result;
 };
 await f.store.handoff(f.c.id,{requestId:'handoff',to:'writer'});await drain(f.store);
 assert.equal(f.c.work.ownerId,'writer');assert.equal(f.c.handoffRuns[0].status,'completed');
 assert.deepEqual(f.c.handoffRuns[0].modelSelection,f.c.modelSelection);
 assert.equal(f.seen.at(-1).connectionId,'openai-api-key');assert.equal(f.seen.at(-1).connectionRevision,'rev-1');
});
