#!/usr/bin/env node
// Exact, explicitly requested owner confirmation after a real bound native PASS.
// No development, inference, preview, retry, or learning batch is started here.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const args=process.argv.slice(2);assert.ok(args.length===2&&args[0]==='--confirm'&&/^[a-f0-9]{64}$/.test(args[1]),'Explicitly --confirm exact-candidate-sha256');
const expected=args[1],root=path.resolve(import.meta.dirname,'..'),base='http://127.0.0.1:9109',sha=b=>crypto.createHash('sha256').update(b).digest('hex');
async function api(route,body){const r=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{Origin:base,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)});const v=await r.json();if(!r.ok)throw Error(`Product API ${route} (${r.status}): ${v.error}`);return v;}
const [a,i]=await Promise.all([api('/api/irixi-authority'),api('/api/irixi-intake')]);const cap=JSON.parse(await fs.readFile(path.join(root,'state/model-capability.json'))),task=JSON.parse(await fs.readFile(path.join(root,'state/tasks/task-article-learning-12/task.json')));
assert.equal(a.current,true);assert.equal(i.goal.confirmed,true);assert.equal(a.goalVersionId,i.goal.id);assert.equal(a.artifact.candidateSha256,expected);assert.equal(cap.candidateSha256,expected);assert.equal(a.artifact.hostCheck.passed,true);assert.equal(a.artifact.review.nativeVerdict,'PASS');assert.equal(a.artifact.review.passed,true);assert.equal(a.artifact.confirmation,null);
const ledgerBytes=await fs.readFile(cap.development.ledgerFile),ledger=JSON.parse(ledgerBytes);assert.ok(ledger.calls.every(c=>c.status==='completed'));const reviewer=ledger.calls.find(c=>c.expectedRole==='reviewer');assert.ok(reviewer);assert.equal(reviewer.exitCode,0);assert.equal(reviewer.signal,null);assert.equal(reviewer.effectiveSandbox,'read-only');
const raw=await fs.readFile(path.resolve(path.dirname(cap.development.ledgerFile),reviewer.stdout.file));assert.equal(sha(raw),reviewer.stdout.sha256);assert.match(raw.toString(),/(?:^|\n)\s*(?:\*\*)?VERDICT:(?:\*\*)?\s*PASS\b/im);
const review=task.reviews.find(r=>r.id===a.artifact.review.id);assert.ok(review);assert.equal(review.modelSummary.trim(),raw.toString().trim());
// TaskStore trims boundary whitespace in its display summary. Coordination
// retains the genuine raw stdout digest; the exact body must still match.
assert.ok([sha(raw),sha(review.modelSummary)].includes(review.fullOutputSha256),'Review digest must identify original native bytes or their boundary-whitespace-normalized display');
const artifact=task.artifacts.find(x=>x.id===a.artifact.id);assert.equal(artifact.projectCandidate.candidateSha256,expected);
let coordination=null;
if(ledger.sealed){
  assert.equal(ledger.sealed.reasonCode,'native_terminal_or_host_rejected');assert.equal(ledger.cap,2);assert.equal(reviewer.declaredStatus,'done');assert.equal(review.coordinatedFromSealedTransportFailure,true);
  const dualCall=cap.development.mode==='developer_reviewer';
  assert.match(cap.development.batchId,/^development-\d{2,}$/);
  if(dualCall){
    assert.equal(cap.development.mode,'developer_reviewer');assert.deepEqual(ledger.roleOrder,['developer','reviewer']);assert.equal(ledger.calls.length,2);assert.ok(ledger.calls.every(c=>c.exitCode===0&&!c.signal&&c.declaredStatus==='done'));assert.equal(ledger.calls[1],reviewer);
  }else{assert.equal(cap.development.mode,'review_only');assert.deepEqual(ledger.roleOrder,['reviewer']);assert.equal(ledger.calls.length,1);}
  coordination=task.events.findLast(e=>e.type==='integration.sealed_reviewer_result_coordinated'&&e.detail?.artifactId===artifact.id&&e.detail?.executionId===task.execution.id);
  assert.ok(coordination,'Sealed native result requires supported authority coordination of actual originalPASS');
  assert.equal(coordination.detail.candidateSha256,expected);assert.equal(coordination.detail.ledgerSha256,sha(ledgerBytes));assert.equal(coordination.detail.stdoutSha256,sha(raw));assert.equal(coordination.detail.sourceTaskId,review.sourceTaskId);
  if(dualCall){
    const proofName=cap.development.batchId+'-bound-host-proof-zero-model.json';
    const proofBytes=await fs.readFile(path.join(root,'evidence',proofName)),proof=JSON.parse(proofBytes);
    // The authority validates the fixed proof before coordinating; its event
    // retains the review/ledger binding, while the exact request keeps the proof.
    const coordinatedDir=path.join(root,'backend',cap.development.batchId+'-zero-model-review-coordination');
    const coordinatedRequest=JSON.parse(await fs.readFile(path.join(coordinatedDir,'request.json'))).request;
    const coordinatedResponse=JSON.parse(await fs.readFile(path.join(coordinatedDir,'response.json')));
    assert.equal(coordinatedResponse.status,200);assert.equal(coordinatedResponse.value.coordinated,true);assert.equal(coordinatedResponse.value.reviewId,review.id);assert.equal(coordinatedResponse.value.artifactId,artifact.id);assert.equal(coordinatedResponse.value.candidateSha256,expected);
    assert.equal(coordinatedRequest.expectedExecutionId,task.execution.id);assert.equal(coordinatedRequest.expectedLedgerSha256,sha(ledgerBytes));assert.equal(coordinatedRequest.expectedStdoutSha256,sha(raw));assert.equal(coordinatedRequest.hostProofFile,proofName);assert.equal(coordinatedRequest.hostProofSha256,sha(proofBytes));
    assert.equal(coordinatedRequest.expectedCandidateSha256,expected);assert.equal(coordinatedRequest.expectedGoalVersionId,cap.goalVersionId);assert.equal(coordinatedRequest.expectedDeveloperStdoutSha256,ledger.calls[0].stdout.sha256);assert.equal(coordinatedRequest.expectedSourceManifestSha256,expected);
    assert.equal(proof.candidateSha256,expected);assert.equal(proof.executionId,task.execution.id);assert.equal(proof.hostChecksPassed,true);assert.equal(proof.sourceUnchanged,true);assert.equal(proof.nativeModelCalls,0);
  }
}
const owned=path.join(root,'backend','exact-reviewed-confirmation-'+expected.slice(0,12));await fs.mkdir(owned,{recursive:false,mode:0o700});const save=(n,v)=>fs.writeFile(path.join(owned,n),JSON.stringify(v,null,2)+'\n',{flag:'wx',mode:0o600});
await save('before.json',{authority:a,intake:i,ledgerSha256:sha(ledgerBytes),rawReviewSha256:sha(raw),transportedReviewSha256:review.fullOutputSha256,displaySummarySha256:sha(review.modelSummary),rawAndTransportedReviewEqualAfterBoundaryWhitespace:true,sealedOriginalLedgerPreserved:!!ledger.sealed,coordination});const request={artifactId:a.artifact.id,version:a.artifact.version};
await save('authorization.json',{authorizationSource:'Continuous user-authorized advancement and own acceptance audit, Sentinel_02b6e8cd601481919c4d63e2e0c395f8, 2026-10-05',operation:'Confirm only the exact genuinely reviewed candidate version to permit bounded teaching acceptance',expectedCandidateSha256:expected,request,actualUserBrowserClick:false,finalHumanLearningAcceptance:false});
const response=await api('/api/irixi-authority/confirm',request);await save('response.json',response);const after=await api('/api/irixi-authority');assert.equal(after.artifact.candidateSha256,expected);assert.equal(after.artifact.id,request.artifactId);assert.ok(after.artifact.confirmation);assert.equal(sha(await fs.readFile(cap.development.ledgerFile)),sha(ledgerBytes));await save('after.json',after);
console.log(JSON.stringify({confirmed:true,artifactId:request.artifactId,version:request.version,candidateSha256:expected,goalVersionId:a.goalVersionId,actualUserBrowserClick:false,modelCalls:0,humanLearningAccepted:false,evidence:owned}));
