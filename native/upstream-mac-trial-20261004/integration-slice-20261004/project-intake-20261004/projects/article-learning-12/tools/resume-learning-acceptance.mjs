#!/usr/bin/env node
// GET-only continuation of an intentionally closed operator acceptance client.
// This is real backend continuity evidence, not headed-browser UI evidence.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
const args=process.argv.slice(2);assert.ok(args.length===2&&args[0]==='--resume'&&/^benchmark-[a-f0-9-]{36}$/.test(args[1]),'Explicitly --resume existing-benchmark-turn-id');
const root=path.resolve(import.meta.dirname,'..'),owned=path.join(root,'backend','real-learning-acceptance-20261005'),stateFile=path.join(owned,'benchmark-record.json'),base='http://127.0.0.1:9109',digest=b=>crypto.createHash('sha256').update(b).digest('hex');
async function get(route){const r=await fetch(base+route,{headers:{Origin:base},signal:AbortSignal.timeout(10000)});const v=await r.json();if(!r.ok)throw Error(`Product read ${route} (${r.status}): ${v.error}`);return v;}
const s=JSON.parse(await fs.readFile(stateFile)),turn=s.turns.find(t=>t.turnId===args[1]);assert.ok(turn);assert.equal(turn.status,'running');assert.equal(s.turns.filter(t=>t.status==='running').length,1);assert.equal(turn.articleSha256,s.material.articleSha256);
const a=await get('/api/irixi-authority');assert.equal(a.current,true);assert.equal(a.goalVersionId,s.goalVersionId);assert.equal(a.artifact.candidateSha256,s.candidateSha256);assert.equal(a.artifact.review.passed,true);assert.ok(a.artifact.confirmation);
const cap=JSON.parse(await fs.readFile(path.join(root,'state/model-capability.json'))),beforeLedger=JSON.parse(await fs.readFile(cap.learning.ledgerFile)),beforeCalls=beforeLedger.calls.map(c=>({ordinal:c.ordinal,promptSha256:c.promptSha256,modelPid:c.modelPid}));
const dir=path.join(owned,turn.acceptanceCase+'-'+turn.turnId);await fs.access(path.join(dir,'request.json'));await fs.access(path.join(dir,'accepted.json'));await assert.rejects(fs.access(path.join(dir,'result.json')));await assert.rejects(fs.access(path.join(dir,'resumed-result.json')));
console.log(JSON.stringify({phase:'GET_only_learning_resume',turnId:turn.turnId,modelStarts:0,deadlineAt:beforeLedger.deadlineAt}));
const until=Math.max(Date.now()+5000,Date.parse(beforeLedger.deadlineAt));let terminal;
while(Date.now()<until){terminal=await get('/api/irixi-inference?turnId='+encodeURIComponent(turn.turnId));if(terminal.status!=='running')break;await new Promise(r=>setTimeout(r,4000));}
assert.equal(terminal?.status,'done','Original bounded inference did not finish; never restart or POST');assert.equal(digest(terminal.text),terminal.textSha256);
const core=createRequire(import.meta.url)(path.join(root,'workspace/core.js')),data=core.parseModelText(terminal.text,turn.kind,{articleText:s.material.articleText,...(turn.kind==='assess'?{concepts:s.explanations.at(-1).concepts,learnerResponse:turn.context.response}:{})});
const key=turn.kind==='explain'?'explanations':turn.kind==='assess'?'assessments':'summaries';assert.ok(!s[key].some(r=>r.turnId===turn.turnId));const saved={...data,...(turn.context||{}),turnId:turn.turnId,articleSha256:s.material.articleSha256,createdAt:new Date().toISOString()};
s[key].push(turn.kind==='summarize'?core.reconcileSummary(saved,s):saved);if(turn.kind==='assess'&&turn.context.userOpinion)s.opinions.push({turnId:turn.turnId,text:turn.context.userOpinion,at:turn.context.submittedAt});Object.assign(turn,{status:'done',textSha256:terminal.textSha256,completedAt:new Date().toISOString()});
const afterLedger=JSON.parse(await fs.readFile(cap.learning.ledgerFile));assert.deepEqual(afterLedger.calls.map(c=>({ordinal:c.ordinal,promptSha256:c.promptSha256})),beforeCalls.map(({ordinal,promptSha256})=>({ordinal,promptSha256})),'GET continuation must not create a native model call');for(const c of beforeCalls)if(c.modelPid)assert.equal(afterLedger.calls.find(a=>a.ordinal===c.ordinal).modelPid,c.modelPid);
const temporary=stateFile+'.'+crypto.randomUUID()+'.tmp';await fs.writeFile(temporary,JSON.stringify(s,null,2)+'\n',{flag:'wx',mode:0o600});await fs.rename(temporary,stateFile);
const evidence={recordedAt:new Date().toISOString(),evidenceType:'actual GET-only backend continuation after closing the operator acceptance process; no actual headed browser',ok:true,turnId:turn.turnId,kind:turn.kind,structuredResult:data,rawResult:terminal,knowledgeState:core.knowledgeState(s),modelStartsThisResume:0,ledgerCallsBefore:beforeCalls,ledger:afterLedger,benchmarkOnly:true,humanLearningProven:false,actualBrowser:false,automaticRetry:false};await fs.writeFile(path.join(dir,'resumed-result.json'),JSON.stringify(evidence,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify(evidence));
