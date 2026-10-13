#!/usr/bin/env node
// Resume only this operator's observation/gate/review of the same authorized
// native batch. Never starts Developer, opens a budget or changes its deadline.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {runNativeClientChecks} from './check-native-client-no-model.mjs';
import {sealModelBudget} from './development-budget-ledger.mjs';

const root=path.resolve(import.meta.dirname,'..'),workspace=path.join(root,'workspace'),base='http://127.0.0.1:9109';
const args=process.argv.slice(2);assert.ok(args.length===2&&args[0]==='--finish'&&/^development-\d{2,4}$/.test(args[1]),'Explicit --finish existing development-NN');
const batchId=args[1],cap=JSON.parse(await fs.readFile(path.join(root,'state/model-capability.json')));
assert.equal(cap.development.batchId,batchId);assert.equal(cap.development.mode,'developer_reviewer');
const ledgerFile=cap.development.ledgerFile,initial=JSON.parse(await fs.readFile(ledgerFile));
assert.equal(initial.calls.length,1);assert.equal(initial.calls[0].expectedRole,'developer');assert.equal(initial.sealed,undefined);
const deadline=Date.parse(initial.deadlineAt);assert.ok(deadline>Date.now());
const evidenceRoot=path.join(root,'backend',batchId+'-existing-budget-gate-and-review');await fs.mkdir(evidenceRoot,{mode:0o700});
const save=(name,value)=>fs.writeFile(path.join(evidenceRoot,name),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function api(route){const r=await fetch(base+route,{headers:{Origin:base},signal:AbortSignal.timeout(8000)});const value=await r.json();assert.ok(r.ok,route+' rejected: '+value.error);return value;}
async function wait(check,message){while(Date.now()<deadline){const value=await check();if(value)return value;await pause(400);}throw Error(message);}
const events=[],commands=[],outcome={batchId,evidenceType:'continued root operator on existing native Developer slot and unchanged original ledger/deadline',developerRestarted:false,budgetReset:false,learningCalls:0,actualBrowser:false,ok:false};let socket;
try{
  await save('initial-ledger.json',initial);
  const finalDeveloperLedger=await wait(async()=>{const x=JSON.parse(await fs.readFile(ledgerFile));return x.calls[0].status!=='running'&&x.calls[0].status!=='reserved'?x:null;},'Original native deadline ended; no retry');
  const dev=finalDeveloperLedger.calls[0];assert.equal(dev.status,'completed');assert.equal(dev.exitCode,0);assert.ok(!dev.signal);assert.equal(dev.declaredStatus,'done');assert.equal(finalDeveloperLedger.sealed,undefined);
  const stdout=await fs.readFile(path.join(root,'state',batchId,'call-1','stdout.log'),'utf8');
  assert.match(stdout,/^STATUS:\s*done\s*$/m);const fields=stdout.match(/^FILES_CHANGED:\s*\n([\s\S]*?)^ENTRY_FILE:\s*(\S+)/m);assert.ok(fields,'Use actual native final report');
  const changedFiles=fields[1].split('\n').map(x=>x.trim()).filter(Boolean);assert.ok(changedFiles.length>0&&changedFiles.every(x=>['PRODUCT.md','app.js','core.js','index.html','styles.css','test-core.js'].includes(x)));
  const developerReport={changedFiles,entryFile:fields[2],summary:stdout.match(/^SUMMARY:\s*(.*)$/m)?.[1]||'Native Developer completed',nativeOutputSha256:crypto.createHash('sha256').update(stdout).digest('hex')};await save('actual-developer-report.json',developerReport);
  const intake=await api('/api/irixi-intake'),candidate=await api('/api/irixi-authority');
  assert.equal(intake.executionOption.execution.id,cap.development.executionId);assert.equal(candidate.goalVersionId,intake.goal.id);assert.equal(candidate.artifact.hostCheck.passed,true);assert.equal(candidate.current,true);await save('host-candidate.json',candidate);
  process.stdout.write(JSON.stringify({phase:'existing_native_developer_completed_host_accepted',batchId,candidateSha256:candidate.artifact.candidateSha256,deadlineAt:initial.deadlineAt})+'\n');
  const gate=await runNativeClientChecks({workspace,evidenceFile:path.join(evidenceRoot,'native-client-gate.json'),candidateSha256:candidate.artifact.candidateSha256});
  outcome.nativeClientGate={passed:gate.passed,evidenceFile:path.join(evidenceRoot,'native-client-gate.json'),actualInferenceHttpPosts:gate.actualInferenceHttpPosts,nativeModelCalls:0};
  if(!gate.passed){await sealModelBudget({ledgerFile,trialId:initial.trialId,workspaceRealpath:initial.workspaceRealpath,reasonCode:'host_native_client_check_failed'});outcome.rootHostGateStoppedBatch=true;outcome.reviewerStarted=false;outcome.officialTaskPhaseMayRemainExecuting=true;throw Error('Root actual client gate failed; Reviewer not started, original ledger sealed: '+gate.error?.message);}
  assert.equal((await api('/api/irixi-authority')).artifact.candidateSha256,candidate.artifact.candidateSha256);assert.equal(gate.sourceUnchanged,true);assert.ok(Date.now()<deadline);
  process.stdout.write(JSON.stringify({phase:'root_native_client_gate_passed_before_reviewer',batchId,candidateSha256:candidate.artifact.candidateSha256,nativeModelCalls:0})+'\n');
  const connection=await api('/connect');assert.equal(connection.role,'owner');assert.equal(connection.gatewayId,'mac-article-learning-12');socket=new WebSocket('ws://127.0.0.1:9109');
  socket.addEventListener('message',({data})=>{try{const event=JSON.parse(String(data));events.push(event);if(['TASK_STARTED','TASK_DONE','TASK_FAILED'].includes(event.type))fs.appendFile(path.join(evidenceRoot,'native-events.jsonl'),JSON.stringify({receivedAt:new Date().toISOString(),event})+'\n').catch(()=>{});}catch{}});
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});socket.send(JSON.stringify({type:'AUTH',sessionToken:connection.sessionToken}));delete connection.sessionToken;await pause(250);assert.ok(!events.some(e=>e.type==='AUTH_FAILED'));
  const reviewerId='repair-reviewer-12-'+crypto.randomUUID().slice(0,8),command={type:'REQUEST_REVIEW',reviewerAgentId:reviewerId,sourceAgentId:'agent-article-learning-12',changedFiles,projectDir:workspace,entryFile:developerReport.entryFile,summary:developerReport.summary,backend:'codex'};
  commands.push({at:new Date().toISOString(),command});socket.send(JSON.stringify(command));outcome.reviewerStarted=true;await save('sent-commands.json',commands);
  process.stdout.write(JSON.stringify({phase:'native_readonly_reviewer_requested_after_client_gate',batchId,candidateSha256:candidate.artifact.candidateSha256})+'\n');
  const reviewer=await wait(()=>events.find(e=>['TASK_DONE','TASK_FAILED'].includes(e.type)&&e.agentId===reviewerId),'Original native window ended during Reviewer; no retry');await save('reviewer-terminal.json',reviewer);assert.equal(reviewer.type,'TASK_DONE');
  const reviewed=await wait(async()=>{const x=await api('/api/irixi-authority');return x.artifact?.review?x:null;},'No bound native review before original deadline');await save('reviewed-candidate.json',reviewed);
  assert.equal(reviewed.artifact.candidateSha256,candidate.artifact.candidateSha256);assert.equal(reviewed.artifact.review.nativeVerdict,'PASS');assert.equal(reviewed.artifact.review.passed,true);
  const final=JSON.parse(await fs.readFile(ledgerFile));assert.equal(final.calls.length,2);assert.ok(final.calls.every(x=>x.status==='completed'&&x.exitCode===0&&!x.signal&&x.declaredStatus!=='failed'));
  Object.assign(outcome,{ok:true,candidateSha256:reviewed.artifact.candidateSha256,nextAction:'Precisely confirm reviewed candidate, then separately bounded actual native learning acceptance.'});
}catch(error){outcome.error=error.message;process.exitCode=1;}
finally{
  socket?.close();outcome.finishedAt=new Date().toISOString();
  try{const final=JSON.parse(await fs.readFile(ledgerFile));outcome.nativeCalls=final.calls.length;outcome.nativeRoles=final.calls.map(x=>({role:x.expectedRole,status:x.status,declaredStatus:x.declaredStatus,startedAt:x.startedAt,completedAt:x.completedAt,exitCode:x.exitCode}));outcome.deadlineAt=final.deadlineAt;outcome.ledgerSealed=final.sealed||null;assert.equal(final.startedAt,initial.startedAt);assert.equal(final.deadlineAt,initial.deadlineAt);}catch(error){outcome.finalLedgerReadError=error.message;}
  await save('result.json',outcome);process.stdout.write(JSON.stringify(outcome)+'\n');
}
