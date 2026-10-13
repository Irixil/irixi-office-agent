#!/usr/bin/env node
// Explicit owner operation over a separately prepared review-only product batch.
// No Developer, retry, budget opening, confirmation, preview, or learning call.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fingerprint } from '../../../../authority/authority-core.mjs';

const root=path.resolve(import.meta.dirname,'..'),base='http://127.0.0.1:9109',args=process.argv.slice(2);
const inspect=args.length===1&&args[0]==='--inspect';
const batch=args.length===2&&args[0]==='--start'&&/^development-\d{2,4}$/.test(args[1])?args[1]:null;
if(!inspect&&!batch)throw Error('Use --inspect, or explicitly --start development-NN for one prepared readonly review.');
async function api(route){const response=await fetch(base+route,{headers:{Origin:base},signal:AbortSignal.timeout(8000)});const value=await response.json();if(!response.ok)throw Error(`Product read failed (${response.status}): ${value.error}`);return value;}
const [intake,authority]=await Promise.all([api('/api/irixi-intake'),api('/api/irixi-authority')]);
const cap=JSON.parse(await fs.readFile(path.join(root,'state/model-capability.json'))),task=JSON.parse(await fs.readFile(path.join(root,'state/tasks/task-article-learning-12/task.json'))),project=JSON.parse(await fs.readFile(path.join(root,'project.json')));
assert.equal(intake.goal.confirmed,true);assert.equal(intake.executionOption.current,true);
assert.deepEqual({statement:intake.goal.statement,successCriteria:intake.goal.successCriteria,boundaries:intake.goal.boundaries},project.goalDraft);
const summary={batchId:cap.development.batchId,executionId:task.execution.id,goalVersionId:intake.goal.id,mode:cap.development.mode,candidateSha256:authority.artifact?.candidateSha256,phase:intake.executionOption.execution.phase,remaining:intake.modelAvailability.execution.remaining,sealed:intake.modelAvailability.execution.sealed,maxNativeCalls:1,windowMs:1200000,nativeModelStarted:false};
if(inspect){process.stdout.write(JSON.stringify(summary,null,2)+'\n');}
else{
  assert.equal(summary.batchId,batch);assert.equal(summary.mode,'review_only');assert.equal(task.execution.reviewOnly,true);
  assert.equal(cap.development.enabled,true);assert.equal(summary.remaining,1);assert.equal(summary.sealed,false);
  assert.equal(intake.executionOption.registeredExecution,null);assert.equal(authority.artifact.hostCheck.passed,true);assert.equal(authority.artifact.review,null);assert.equal(authority.artifact.confirmation,null);
  assert.equal(authority.goalVersionId,intake.goal.id);assert.equal(cap.candidateSha256,summary.candidateSha256);
  const artifact=task.artifacts.find(a=>a.id===authority.artifact.id);assert.ok(artifact);assert.equal(artifact.projectCandidate.candidateSha256,summary.candidateSha256);
  //19 explicitly reviews only the unchanged18 output; it never repeats
  // development or treats the old failed assertion as a native PASS.
  let carriedHostProof=null;
  if(batch==='development-19'){
    assert.equal(summary.candidateSha256,'6b95201ee7634fd40fd7c379d013d1be6a9408b17492db98f8c55e36e162de1c');
    const report=JSON.parse(await fs.readFile(path.join(root,'evidence/development-18-sealed-host-assertion-mismatch-zero-model-convergence.json')));
    const [baseGate,stateGate,compilerProof]=await Promise.all([report.correctedFullBaseGate,report.fullEnumStateSequence,report.compilerProof].map(async f=>JSON.parse(await fs.readFile(f))));
    assert.ok(baseGate.passed&&baseGate.sourceUnchanged&&stateGate.passed&&stateGate.sourceUnchanged&&compilerProof.passed);
    assert.equal(baseGate.nativeModelCalls,0);assert.equal(stateGate.nativeModelCalls,0);
    const current=[];
    for(const f of report.fullSourceManifest){const bytes=await fs.readFile(path.join(project.workspace,f.path));assert.equal(bytes.length,f.bytes);assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),f.sha256);current.push({...f});}
    assert.equal(fingerprint(current.sort((a,b)=>a.path.localeCompare(b.path))),summary.candidateSha256);
    assert.ok(current.reduce((n,f)=>n+f.bytes,0)<=53248);
    const oldLedger=await fs.readFile(path.join(root,'state/development-18/model-ledger.json'));assert.equal(crypto.createHash('sha256').update(oldLedger).digest('hex'),report.ledgerSha256);
    carriedHostProof={passed:true,exactCurrentCandidate:true,completeSourceBytes:report.fullSourceBytes,sourceLimitBytes:53248,hostEvidence:report.correctedFullBaseGate,stateSequenceEvidence:report.fullEnumStateSequence,compilerEvidence:report.compilerProof,sourceUnchanged:true,priorFailedLedgerUnchanged:true,nativeModelCalls:0,actualBrowser:false};
  }
  const ledgerFile=cap.development.ledgerFile;
  try{const ledger=JSON.parse(await fs.readFile(ledgerFile));assert.equal(ledger.calls.length,0,'This harness never repeats a used review batch');}catch(e){if(e.code!=='ENOENT')throw e;}
  const owned=path.join(root,'backend',batch+'-explicit-readonly-start');await fs.mkdir(owned,{recursive:false,mode:0o700});
  const save=(name,value)=>fs.writeFile(path.join(owned,name),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
  const events=[],commands=[],pause=ms=>new Promise(r=>setTimeout(r,ms));let socket;
  const outcome={...summary,evidenceType:'one explicitly requested native readonly Reviewer via supported authenticated product API',ok:false,developerCalls:0,learningCalls:0,automaticRetry:false,confirmedCandidate:false,actualBrowser:false,operatorStartedAt:new Date().toISOString()};
  const deadline=Date.now()+1200000;
  async function wait(check,message){while(Date.now()<deadline){const value=await check();if(value)return value;await pause(350);}throw Error(message);}
  try{
    await save('preflight-intake.json',intake);await save('preflight-candidate.json',authority);
    if(carriedHostProof)await save('exact-current-host-proof.json',carriedHostProof);
    const connection=await api('/connect');assert.equal(connection.role,'owner');assert.equal(connection.gatewayId,'mac-article-learning-12');
    socket=new WebSocket('ws://127.0.0.1:9109');socket.addEventListener('message',({data})=>{try{events.push(JSON.parse(String(data)));}catch{}});
    await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
    socket.send(JSON.stringify({type:'AUTH',sessionToken:connection.sessionToken}));delete connection.sessionToken;await pause(250);
    assert.equal(socket.readyState,WebSocket.OPEN);assert.ok(!events.some(e=>e.type==='AUTH_FAILED'));
    const reviewScope='Review complete exact same-byte Developer output; no Developer rerun, no unsealing failed18. Frozen original acceptance only, see ../evidence/DEVELOPMENT-18-ACCEPTANCE-BOUNDARY-20261005.md. Goal criteria5/7/8/10 require failures preserved/stopped and position restored without automatic model calls. Processing terminal does not mean saved valid learning result: settled means done with same-turn corresponding saved result. failed/stale/invalid/incomplete/refused stay visible and block a new ID; they need not all be retriable and stale cannot be reused. One settled predicate governs recovery selection, buttons, infer, reset and next batch. With remaining1 all unresolved states block a new assess/summary ID. GET404 remains unresolved, so new action buttons stay disabled while explicit original-ID original-byte recovery remains available. The obsolete opposite host assertion caused18 sealing; original evidence/ledger retained, corrected full native HTTP and10-state/both-action sequence gates passed on this exact unchanged candidate. Resolved archive then fresh registered article can get first calls without its own earlier completed cycle. No new question counts, mastery thresholds, schemas, abandonment features or minor style/UI blockers. For any FAIL identify concrete existing contract and trigger; genuine PASS leads directly to bounded real teaching. Host fixtures do not prove human learning.';
    const reviewerId='reviewer-12-'+crypto.randomUUID().slice(0,8),command={type:'REQUEST_REVIEW',reviewerAgentId:reviewerId,sourceAgentId:'agent-article-learning-12',changedFiles:artifact.projectCandidate.changes,projectDir:project.workspace,entryFile:'index.html',summary:batch==='development-19'?reviewScope:'Explicit readonly review of the complete same-byte successful Developer output, recaptured after a sealed host framing rejection. No Developer rerun. Verify the full current accepted contract and all current source/state/restoration fixes.',backend:'codex'};
    commands.push({at:new Date().toISOString(),command});socket.send(JSON.stringify(command));outcome.reviewRequested=true;
    process.stdout.write(JSON.stringify({phase:'native_readonly_reviewer_requested',batchId:batch,candidateSha256:summary.candidateSha256,maxNativeCalls:1,developerCalls:0})+'\n');
    const terminal=await wait(()=>events.find(e=>['TASK_DONE','TASK_FAILED'].includes(e.type)&&e.agentId===reviewerId),'Review window ended; no retry');await save('reviewer-terminal.json',terminal);
    if(terminal.type!=='TASK_DONE')throw Error('Readonly Reviewer failed; stop: '+terminal.error);
    const reviewed=await wait(async()=>{const v=await api('/api/irixi-authority');return v.artifact?.review?v:null;},'No bound independent review was recorded');await save('reviewed-candidate.json',reviewed);
    assert.equal(reviewed.artifact.candidateSha256,summary.candidateSha256);assert.equal(reviewed.artifact.review.nativeVerdict,'PASS');assert.equal(reviewed.artifact.review.passed,true);
    const ledger=JSON.parse(await fs.readFile(ledgerFile));assert.equal(ledger.calls.length,1);assert.equal(ledger.calls[0].expectedRole,'reviewer');assert.equal(ledger.calls[0].effectiveSandbox,'read-only');assert.equal(ledger.calls[0].exitCode,0);assert.equal(ledger.calls[0].signal,null);
    outcome.ok=true;outcome.nextAction='Inspect this exact reviewed candidate and perform authorized version confirmation and bounded real learning acceptance; actual headed UI remains a separate check.';
  }catch(e){outcome.error=e.message;process.exitCode=1;}
  finally{
    const observeUntil=Date.now()+5000;
    while(Date.now()<observeUntil){try{const l=JSON.parse(await fs.readFile(ledgerFile));if(!l.calls.some(c=>['reserved','running'].includes(c.status))||Date.parse(l.deadlineAt)>Date.now()+2500)break;}catch{break;}await pause(250);}
    socket?.close();
    try{const final=await api('/api/irixi-intake');await save('final-intake.json',final);Object.assign(outcome,{phase:final.executionOption.execution?.phase,remaining:final.modelAvailability.execution.remaining,sealed:final.modelAvailability.execution.sealed});}catch(e){outcome.finalReadError=e.message;}
    try{const l=JSON.parse(await fs.readFile(ledgerFile));Object.assign(outcome,{nativeModelStarted:l.calls.some(c=>c.modelPid),nativeCalls:l.calls.length,nativeRoles:l.calls.map(c=>({role:c.expectedRole,status:c.status,declaredStatus:c.declaredStatus,startedAt:c.startedAt,completedAt:c.completedAt,exitCode:c.exitCode,signal:c.signal,effectiveSandbox:c.effectiveSandbox})),budgetStartedAt:l.startedAt,deadlineAt:l.deadlineAt,ledgerSealed:l.sealed||null});}catch(e){outcome.ledgerReadError=e.message;}
    outcome.finishedAt=new Date().toISOString();await save('sent-commands.json',commands);await save('received-events.json',events);await save('result.json',outcome);process.stdout.write(JSON.stringify(outcome)+'\n');
  }
}
