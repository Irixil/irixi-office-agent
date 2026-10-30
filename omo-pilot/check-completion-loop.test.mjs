import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
const {executeConversationCommand}=await import('./conversation-command.mjs');
const {ConversationStore,fileIndex,writeReviewGaps}=await import(process.env.IRIXI_REVIEW_STORE || './conversation-store.mjs');
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const final={content:[{type:'text',text:'completed synthetic work'}]};
const tool=(name,args={})=>({content:[{type:'toolCall',name,arguments:args}]});
const read=()=>tool('read',{path:'report.txt'});
const verify=()=>tool('verify_behavior');
const gate=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:()=>resolve()};};
async function fixture(t,outputs,{onRead}={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'irixi-review-loop-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const prompts=[];let calls=0,decisions=0,checks=0;
 const store=new ConversationStore({runtimeDir:root,catalogueReader:async()=>({models:[]}),modelRunner:async o=>{
  prompts.push(o.prompt);if(calls>=outputs.length)throw Error('synthetic harness decision limit reached');
  return {status:'model_returned',output:{text:JSON.stringify(outputs[calls++])}};
 },omoRunner:async o=>{
  for(let n=0;n<12;n++){
   decisions++;const response=await o.runModelDecision({tools:[],messages:[]},decisions,o.signal);const d=JSON.parse(response);const a=d.content.find(x=>x.type==='toolCall');
   if(!a)return {status:'model_returned',sessionId:'synthetic-no-model',output:{text:response}};
   if(a.name==='read'){await fs.readFile(path.join(o.cwd,'report.txt'));await onRead?.();}
   else if(a.name==='bash'){const result=await executeConversationCommand({command:'/usr/bin/true',timeout:10},{root:o.cwd,signal:o.signal});assert.equal(result.details.exitCode,0);}
   else if(a.name==='write')await fs.writeFile(path.join(o.cwd,'report.txt'),a.arguments.text);
   else if(a.name==='verify_behavior')await o.onBehaviorCheck({requestId:`actual-document-check-${++checks}`,caseJson:JSON.stringify({caseId:'report-content',requirement:'合成内容可读取',kind:'document',target:'report.txt',expected:{includes:['verified text']}})},o.signal);
   else throw Error('unknown synthetic tool');
  }
  throw Error('synthetic harness loop limit reached');
 }});
 await store.init();const c=await store.create({requestId:'synthetic'});const workspace=path.join(root,'project');await fs.mkdir(workspace);
 await fs.writeFile(path.join(workspace,'report.txt'),'old');const before=await fileIndex(workspace);
 await fs.writeFile(path.join(workspace,'report.txt'),'verified text');
 const turn={id:'synthetic-turn',text:'完成合成检查',intent:'execute',status:'working',before,workspace,calls:[],processes:[],receipts:[],events:[],functionalChecks:[{id:'synthetic-old-check',caseId:'report-content',requirement:'合成内容可读取',kind:'document',status:'passed',version:sha(JSON.stringify(before)),sourceIndex:before,specification:{caseId:'report-content',requirement:'合成内容可读取',kind:'document',target:'report.txt',expected:{includes:['verified text']}},definition:sha(JSON.stringify({caseId:'report-content',requirement:'合成内容可读取',kind:'document',target:'report.txt',expected:{includes:['verified text']}})),coveredFiles:['report.txt']}]};c.turns.push(turn);
 await fs.mkdir(path.join(store.root,'context',turn.id),{recursive:true});
 const run=()=>store.role(c,turn,'Developer','Synthetic fixture, no model/network.',workspace,[],new AbortController().signal);
 return {root,store,c,turn,prompts,workspace,run,calls:()=>calls,checks:()=>checks};
}

test('stale evidence identifies current/checked versions, changed source and removed test entry without weakening gate',()=>{
 const check={caseId:'source-check',kind:'web',status:'passed',version:'old-version',sourceIndex:{'index.html':'old','helper.html':'helper'},specification:{target:'helper.html'},coveredFiles:['index.html','helper.html']};
 const gaps=writeReviewGaps(final,[],{changed:true,version:'new-version',sourceIndex:{'index.html':'new','added.txt':'new'},changedFiles:['index.html'],checks:[check]});
 assert.deepEqual(gaps,[{reason:'stale_check',caseId:'source-check',target:'helper.html',targetExists:false,checkedVersion:'old-version',currentVersion:'new-version',modifiedFiles:['index.html'],deletedFiles:['helper.html'],addedFiles:['added.txt']}]);
 assert.equal(check.status,'passed');assert.equal(check.version,'old-version');
});

test('final-read-final stops on second unchanged completion attempt and keeps exact workspace/history',async t=>{
 const f=await fixture(t,[final,read(),final,read(),final,read(),final]);const bytes=await fs.readFile(path.join(f.workspace,'report.txt'));
 await assert.rejects(f.run(),/同一检查缺口已连续两次没有修复进展/);
 assert.equal(f.calls(),3);assert.deepEqual(f.turn.hostCorrections.map(x=>x.correction),[1,2]);
 assert.match(f.prompts[2],/HOST CORRECTION:.*Exact current gaps:.*report-content/s);
 assert.match(f.prompts[2],/checkedVersion.*currentVersion/);assert.equal(f.turn.functionalChecks.length,1);
 assert.deepEqual(await fs.readFile(path.join(f.workspace,'report.txt')),bytes);assert.equal(f.turn.functionalChecks[0].status,'passed');
});

test('several legitimate reads do not exhaust the completion-attempt limit; correction remains visible',async t=>{
 const f=await fixture(t,[final,read(),tool('bash'),read(),read(),final]);
 await assert.rejects(f.run(),/同一检查缺口已连续两次没有修复进展/);assert.equal(f.calls(),6);
 for(const p of f.prompts.slice(1))assert.match(p,/HOST CORRECTION:/);
 assert.deepEqual(f.turn.hostCorrections.map(x=>x.correction),[1,2]);
});

test('historical timestamps and read receipts do not count as new verification progress',async t=>{
 let f;f=await fixture(t,[final,read(),final],{onRead:async()=>{f.turn.functionalChecks[0].finishedAt='2099-01-01';f.turn.receipts.push({eventType:'end',toolName:'read',isError:false});}});
 await assert.rejects(f.run(),/同一检查缺口已连续两次没有修复进展/);assert.equal(f.calls(),3);assert.deepEqual(f.turn.hostCorrections.map(x=>x.correction),[1,2]);
});

test('a running tool is awaited, not timed out or interrupted by the completion guard',async t=>{
 const entered=gate(),release=gate();const f=await fixture(t,[final,read(),final],{onRead:async()=>{entered.resolve();await release.promise;}});
 const result=f.run();await entered.promise;assert.equal(f.calls(),2);assert.equal(f.turn.hostCorrections.length,1);assert.equal(f.turn.status,'working');
 release.resolve();await assert.rejects(result,/同一检查缺口已连续两次没有修复进展/);
});

test('an actual source edit resets the stalled attempt; real check then allows completion',async t=>{
 const f=await fixture(t,[final,read(),tool('write',{text:'verified text plus actual edit'}),final,verify(),final]);
 const result=await f.run();assert.deepEqual(JSON.parse(result),final);assert.equal(f.calls(),6);assert.equal(f.checks(),1);
 assert.deepEqual(f.turn.hostCorrections.map(x=>x.correction),[1,1]);assert.equal(f.turn.functionalChecks.at(-1).status,'passed');
 assert.match(await fs.readFile(path.join(f.workspace,'report.txt'),'utf8'),/actual edit/);assert.doesNotMatch(f.prompts.at(-1),/HOST CORRECTION:/);
});

test('a real verify operation supplies new current evidence without code change and clears pending correction',async t=>{
 const f=await fixture(t,[final,read(),verify(),final]);await f.run();assert.equal(f.calls(),4);assert.equal(f.checks(),1);
 assert.equal(f.turn.functionalChecks.length,2);assert.equal(f.turn.functionalChecks.at(-1).status,'passed');assert.equal(f.turn.hostCorrections.length,1);assert.doesNotMatch(f.prompts.at(-1),/HOST CORRECTION:/);
});
