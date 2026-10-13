#!/usr/bin/env node
// Operator harness for existing product APIs. It never authors business files,
// confirms a new goal, opens a new budget, or retries a failed native task.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runNativeClientChecks } from './check-native-client-no-model.mjs';
import { runClientStateSequence } from './check-client-state-sequence-no-model.mjs';
import { verifyCurrentCompilerProvenance } from './verify-current-compiler-provenance.mjs';
import { runResponseContractChecks } from './check-response-contract-no-model.mjs';
import { sealModelBudget } from './development-budget-ledger.mjs';

const root = path.resolve(import.meta.dirname, '..'), workspace = path.join(root, 'workspace');
const base = 'http://127.0.0.1:9109', hash = value => crypto.createHash('sha256').update(value).digest('hex');
const args = process.argv.slice(2);
const inspect = args.length === 1 && args[0] === '--inspect';
const expectedBatch = args.length === 2 && args[0] === '--start' && /^development-[0-9]{2,4}$/.test(args[1]) ? args[1] : null;
if (!inspect && !expectedBatch) throw Error('Use --inspect (read-only), or explicitly --start development-NN to run a separately authorized Developer/Reviewer batch.');
async function api(route) {
  const response = await fetch(base + route, { headers: { Origin: base }, signal: AbortSignal.timeout(8000) });
  const value = await response.json();
  if (!response.ok) throw Error(`${route} rejected (${response.status}): ${value.error || 'request failed'}`);
  return value;
}
const registration = JSON.parse(await fs.readFile(path.join(root, 'project.json')));
const intake = await api('/api/irixi-intake');
const capability = JSON.parse(await fs.readFile(path.join(root, 'state/model-capability.json')));
const task = JSON.parse(await fs.readFile(path.join(root, 'state/tasks/task-article-learning-12/task.json')));
assert.equal(registration.id, 'article-learning-12');
assert.equal(intake.goal.confirmed, true);
assert.equal(intake.executionOption?.current, true);
assert.deepEqual({ statement: intake.goal.statement, successCriteria: intake.goal.successCriteria, boundaries: intake.goal.boundaries }, registration.goalDraft);
const batchId = capability.development.batchId || null;
const summary = { evidenceType: 'live product API, read-only preflight', goalVersionId: intake.goal.id, batchId, executionId: intake.executionOption.execution?.id, phase: intake.executionOption.execution?.phase,
  prepared: Boolean(intake.executionOption.registeredExecution), modelAvailable: intake.modelAvailability.execution.available,
  remaining: intake.modelAvailability.execution.remaining, sealed: intake.modelAvailability.execution.sealed,
  inputWorkspace: workspace, maxCalls: 2, windowMs: 1200000, rewardProposalIncluded: false, nativeModelStarted: false };
if (inspect) { process.stdout.write(JSON.stringify(summary, null, 2) + '\n'); }
else {
  assert.equal(batchId, expectedBatch, 'Requested batch differs from the explicitly prepared product batch');
  assert.equal(summary.prepared, true); assert.equal(summary.modelAvailable, true);
  assert.equal(summary.remaining, 2); assert.equal(summary.sealed, false);
  const ledgerFile = capability.development.ledgerFile;
  try { const ledger = JSON.parse(await fs.readFile(ledgerFile)); assert.equal(ledger.calls.length, 0, 'This start harness never resumes or repeats a used batch'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const request = intake.executionOption.registeredExecution;
  assert.equal(hash(request.prompt), request.promptSha256);
  assert.equal(request.executionId, capability.development.executionId);
  const evidenceRoot = path.join(root, 'backend', `${expectedBatch}-explicit-start`);
  await fs.mkdir(evidenceRoot, { recursive: false, mode: 0o700 });
  const save = (name, value) => fs.writeFile(path.join(evidenceRoot, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const outcome = { ...summary, preflight: summary, evidenceType: 'explicit operator start via supported authenticated native product APIs', ok: false, automaticRetry: false, learningCalls: 0, confirmedCandidate: false, actualBrowser: false, operatorStartedAt: new Date().toISOString() };
  const events = [], commands = []; let socket;
  const deadline = Date.now() + 1200000;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function wait(check, message) { while (Date.now() < deadline) { const value = await check(); if (value) return value; await pause(350); } throw Error(message); }
  const terminal = (agentId, taskId) => wait(() => events.find(event => ['TASK_DONE','TASK_FAILED'].includes(event.type) && event.agentId === agentId && (!taskId || event.taskId === taskId)), 'The original two-call/20-minute window ended; no retry');
  function send(command) { commands.push({ at: new Date().toISOString(), command }); socket.send(JSON.stringify(command)); }
  try {
    await save('preflight.json', intake);
    const connection = await api('/connect');
    assert.equal(connection.role, 'owner'); assert.equal(connection.gatewayId, 'mac-article-learning-12');
    socket = new WebSocket('ws://127.0.0.1:9109');
    socket.addEventListener('message', ({data}) => { try { const event = JSON.parse(String(data)); events.push(event); if (['TASK_STARTED','TASK_DONE','TASK_FAILED'].includes(event.type)) fs.appendFile(path.join(evidenceRoot,'native-events.jsonl'), JSON.stringify({receivedAt:new Date().toISOString(),event})+'\n').catch(()=>{}); } catch {} });
    await new Promise((resolve,reject) => { socket.addEventListener('open',resolve,{once:true}); socket.addEventListener('error',reject,{once:true}); });
    socket.send(JSON.stringify({type:'AUTH',sessionToken:connection.sessionToken})); delete connection.sessionToken;
    await pause(250); assert.equal(socket.readyState, WebSocket.OPEN); assert.ok(!events.some(event => event.type === 'AUTH_FAILED'));
    const developerId = `repair-developer-12-${crypto.randomUUID()}`;
    send({type:'RUN_TASK',agentId:'agent-article-learning-12',taskId:developerId,prompt:request.prompt,repoPath:workspace});
    outcome.runTaskSent = true;
    process.stdout.write(JSON.stringify({phase:'native_developer_requested',batchId,taskId:developerId,maxCalls:2,windowMs:1200000})+'\n');
    const developer = await terminal('agent-article-learning-12',developerId); await save('developer-terminal.json',developer);
    if (developer.type !== 'TASK_DONE') throw Error(`Developer failed; stop without retry: ${developer.error}`);
    const candidate = await wait(async()=>{const value=await api('/api/irixi-authority');return value.artifact?.hostCheck?.passed&&(expectedBatch!=='development-20'||value.artifact.candidateSha256!==task.execution.repair.failedLearningCandidateSha256)?value:null;},'No newly host-accepted current candidate; stop');
    await save('host-candidate.json',candidate);
    assert.equal(candidate.goalVersionId,intake.goal.id);
    process.stdout.write(JSON.stringify({phase:'native_candidate_host_accepted',batchId,candidateSha256:candidate.artifact.candidateSha256})+'\n');
    // Actual client serialization/storage/HTTP must work before spending the
    // independently bounded Reviewer slot. Controlled replies use no models.
    let compilerProof;
    try{compilerProof=await verifyCurrentCompilerProvenance({root,workspace,batchId:expectedBatch,ledgerFile})}
    catch(error){compilerProof={passed:false,error:{message:error.message},nativeModelCalls:0}}
    await save('native-compiler-provenance.json',compilerProof);
    const baseGate=await runNativeClientChecks({workspace,evidenceFile:path.join(evidenceRoot,'native-client-base-gate.json'),candidateSha256:candidate.artifact.candidateSha256});
    const sequenceGate=await runClientStateSequence({workspace,evidenceFile:path.join(evidenceRoot,'native-client-state-sequence.json'),candidateSha256:candidate.artifact.candidateSha256});
    const contractGate=expectedBatch==='development-20'?await runResponseContractChecks({root,workspace,evidenceFile:path.join(evidenceRoot,'native-response-contract-gate.json'),responseContracts:baseGate.actualResponseContracts}):null;
    const clientGate={...baseGate,evidenceType:'fixed-live compiler provenance plus all native JSON/HTTP and full bounded client-state gates; controlled responses only',
      passed:compilerProof.passed&&baseGate.passed&&sequenceGate.passed&&(!contractGate||contractGate.passed),sourceUnchanged:baseGate.sourceUnchanged&&sequenceGate.sourceUnchanged&&(!contractGate||contractGate.sourceUnchanged),
      compilerProof,sequenceGate,contractGate,actualInferenceHttpPosts:baseGate.actualInferenceHttpPosts+(sequenceGate.mainControlledInferencePosts||0),
      error:compilerProof.passed?(baseGate.passed?(sequenceGate.passed?(contractGate&&!contractGate.passed?{message:contractGate.error}:undefined):{message:sequenceGate.blockers.map(x=>x.group).join(',')}):baseGate.error):compilerProof.error};
    await save('native-client-gate.json',clientGate);
    outcome.nativeClientGate = {passed:clientGate.passed,evidenceFile:path.join(evidenceRoot,'native-client-gate.json'),actualInferenceHttpPosts:clientGate.actualInferenceHttpPosts,nativeModelCalls:0};
    if (!clientGate.passed) {
      const ledger = JSON.parse(await fs.readFile(ledgerFile));
      assert.ok(!ledger.calls.some(call=>['reserved','running'].includes(call.status)), 'Do not seal an active native process');
      await sealModelBudget({ledgerFile,trialId:ledger.trialId,workspaceRealpath:ledger.workspaceRealpath,reasonCode:'host_native_client_check_failed'});
      outcome.rootHostGateStoppedBatch=true;outcome.reviewerStarted=false;
      const evidenceName=`${expectedBatch}-bound-native-client-failure.json`;
      const evidenceBytes=await fs.readFile(path.join(evidenceRoot,'native-client-gate.json'));
      await fs.writeFile(path.join(root,'evidence',evidenceName),evidenceBytes,{flag:'wx',mode:0o600});
      const hostFailureRequest={expectedGoalVersionId:intake.goal.id,expectedExecutionId:request.executionId,
        expectedCandidateSha256:candidate.artifact.candidateSha256,evidenceFile:evidenceName,evidenceSha256:hash(evidenceBytes)};
      await save('host-client-failure-request.json',hostFailureRequest);
      const response=await fetch(base+'/api/irixi-intake/host-client-failure',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify(hostFailureRequest),signal:AbortSignal.timeout(10000)});
      const hostFailure=await response.json();await save('host-client-failure-response.json',{status:response.status,hostFailure});
      outcome.officialHostFailureRecorded=response.ok&&hostFailure.recorded===true;
      outcome.officialTaskPhaseMayRemainExecuting=!outcome.officialHostFailureRecorded;
      if(!outcome.officialHostFailureRecorded)throw Error('Root gate failed and official host failure recording refused; preserve sealed batch: '+hostFailure.error);
      throw Error('Root native client gate failed; Reviewer not started; model ledger sealed. '+clientGate.error?.message);
    }
    const gatedCandidate=await api('/api/irixi-authority');
    assert.equal(gatedCandidate.artifact.candidateSha256,candidate.artifact.candidateSha256);
    assert.equal(clientGate.sourceUnchanged,true);
    process.stdout.write(JSON.stringify({phase:'root_native_client_gate_passed_before_reviewer',batchId,candidateSha256:candidate.artifact.candidateSha256,actualHttp:true,nativeModelCalls:0})+'\n');
    const reviewerId = 'repair-reviewer-12-'+crypto.randomUUID().slice(0,8);
    const reviewScope=expectedBatch==='development-20'?'Frozen contract20 acceptance: read evidence/DEVELOPMENT-20-CONTRACT-ACCEPTANCE-BOUNDARY-20261005.md and actual host proof backend/development-20-explicit-start/native-response-contract-gate.json. Only app.js model-facing existing responseContract types/instructions change; core.js and other five sources stay byte-identical. Actual preserved learning01 response contains all four question types as an object, rejected by unchanged array validator. Clarify existing explain/assess/summarize JSON types in one bounded change; literal questionTypes string array, string nested values, integer deficiency index, no judgment changes. Original full native JSON/HTTP, ten-state sequence, fixed live compiler and typed valid/invalid/source evidence gates pass before Reviewer. Existing quote/identity/evidence/weak/summary guards must remain. No new features, question count, mastery threshold, retries/abandon flows, rewards, styles, dependencies, source-limit increase or full rewrite. Model output schema is only a platform type guard; it never proves semantic correctness. Identify a concrete original criterion/failure trigger for any blocker. Genuine PASS leads to exact confirmation and separately authorized real teaching on the new candidate. Failed learning01 remains preserved.':'Frozen core acceptance boundary: read evidence/DEVELOPMENT-18-ACCEPTANCE-BOUNDARY-20261005.md. Existing goal criteria5/7/8/10 preserve failed records, stop failed batches, restore position without automatic model calls. Processing terminal is not business settled: settled means done plus corresponding same-turn saved valid result. failed/stale/invalid/incomplete/refused must remain visible; this does not require all terminal states retriable or stale reusable. One shared per-turn predicate must govern recovery visibility, buttons, infer, reset and batch gating; no parallel state-list patches. With remaining1 all unresolved states prevent a new assess/summary ID even through direct action; original-ID GET404 recovery remains. Root fixed-live compiler proof, original native HTTP gate and full10-state enumeration including both action buttons/direct actions and resolved fresh article path passed before this review. A fresh registered article after a completed archived article may obtain its first calls without its own completed cycle. No new question counts, mastery thresholds, schemas, retry/abandon features or minor UI/style blockers. If reporting a blocker, identify the concrete already accepted boundary and failure trigger; controlled fixtures do not prove human learning. Genuine PASS leads next to real teaching acceptance.';
    send({type:'REQUEST_REVIEW',reviewerAgentId:reviewerId,sourceAgentId:'agent-article-learning-12',changedFiles:developer.result.changedFiles,projectDir:workspace,entryFile:developer.result.entryFile||'index.html',summary:developer.result.summary+'\n'+reviewScope,backend:'codex'});
    process.stdout.write(JSON.stringify({phase:'native_readonly_reviewer_requested',batchId,candidateSha256:candidate.artifact.candidateSha256})+'\n');
    const reviewer = await terminal(reviewerId,null); await save('reviewer-terminal.json',reviewer);
    if (reviewer.type !== 'TASK_DONE') throw Error(`Reviewer failed; stop without retry: ${reviewer.error}`);
    const reviewed = await wait(async()=>{const value=await api('/api/irixi-authority');return value.artifact?.review?value:null;},'No current bound independent review; stop');
    await save('reviewed-candidate.json',reviewed);
    assert.equal(reviewed.artifact.candidateSha256,candidate.artifact.candidateSha256); assert.equal(reviewed.artifact.review.nativeVerdict,'PASS'); assert.equal(reviewed.artifact.review.passed,true);
    const ledger = JSON.parse(await fs.readFile(ledgerFile)); assert.equal(ledger.calls.length,2); assert.ok(ledger.calls.every(call=>call.status==='completed'&&call.exitCode===0&&!call.signal&&call.declaredStatus!=='failed'));
    Object.assign(outcome,{ok:true,nativeCalls:2,candidateSha256:reviewed.artifact.candidateSha256,nextAction:'Inspect the exact reviewed candidate and explicitly confirm its version in the product. Preview and learning acceptance are later actions.'});
  } catch(error) { outcome.error=error.message;process.exitCode=1; }
  finally {
    // The wrapper's clock starts when the native call is reserved, a little
    // after this operator clock. Observe its termination without changing its
    // deadline or issuing another command. This is a bounded final state read.
    const finalizationDeadline=Date.now()+5000;
    while(Date.now()<finalizationDeadline){
      try {
        const observed=JSON.parse(await fs.readFile(ledgerFile));
        if(!observed.calls.some(call=>['reserved','running'].includes(call.status)))break;
        const nativeDeadline=Date.parse(observed.deadlineAt);
        if(!Number.isFinite(nativeDeadline)||nativeDeadline>Date.now()+2500)break;
      }catch{break;}
      await pause(250);
    }
    outcome.terminationObservationOnly=true;
    socket?.close();
    try {
      const finalIntake=await api('/api/irixi-intake'),lane=finalIntake.modelAvailability.execution;
      Object.assign(outcome,{phase:finalIntake.executionOption.execution?.phase,prepared:Boolean(finalIntake.executionOption.registeredExecution),modelAvailable:lane.available,remaining:lane.remaining,sealed:lane.sealed});
      await save('final-intake.json',finalIntake);
    } catch(error) { outcome.finalStateReadError=error.message; }
    try {
      const finalLedger=JSON.parse(await fs.readFile(ledgerFile));
      Object.assign(outcome,{nativeCalls:finalLedger.calls.length,actualNativeProcesses:finalLedger.calls.filter(call=>call.modelPid).length,nativeModelStarted:finalLedger.calls.some(call=>call.modelPid),nativeRoles:finalLedger.calls.map(call=>({role:call.expectedRole,status:call.status,declaredStatus:call.declaredStatus,startedAt:call.startedAt,completedAt:call.completedAt,exitCode:call.exitCode})),budgetStartedAt:finalLedger.startedAt,deadlineAt:finalLedger.deadlineAt,ledgerSealed:finalLedger.sealed||null});
    } catch(error) { outcome.finalLedgerReadError=error.message; }
    outcome.finishedAt=new Date().toISOString();await save('sent-commands.json',commands);await save('result.json',outcome);process.stdout.write(JSON.stringify(outcome)+'\n');
  }
}
