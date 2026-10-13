#!/usr/bin/env node
// Explicit owner coordination after genuine review and exact confirmation.
// Preserves the failed learning batch; never starts a model itself.
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
const args=process.argv.slice(2);assert.ok(args.length===2&&args[0]==='--open'&&/^[a-f0-9]{64}$/.test(args[1]),'Explicit --open newly-reviewed-candidate-sha256');
const expected=args[1],base='http://127.0.0.1:9109',root=path.resolve(import.meta.dirname,'..'),sha=x=>crypto.createHash('sha256').update(x).digest('hex');
async function api(route,body){const r=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{Origin:base,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)});const value=await r.json();assert.ok(r.ok,route+' refused: '+value.error);return value;}
const [authority,intake]=await Promise.all([api('/api/irixi-authority'),api('/api/irixi-intake')]);
const taskBytes=await fs.readFile(path.join(root,'state/tasks/task-article-learning-12/task.json')),task=JSON.parse(taskBytes),cap=JSON.parse(await fs.readFile(path.join(root,'state/model-capability.json'))),repair=task.execution.repair;
assert.equal(authority.current,true);assert.equal(intake.goal.confirmed,true);assert.equal(authority.goalVersionId,intake.goal.id);assert.equal(authority.artifact.candidateSha256,expected);assert.ok(authority.artifact.confirmation);assert.equal(authority.artifact.review.nativeVerdict,'PASS');assert.equal(authority.artifact.review.passed,true);assert.equal(repair.repairKind,'learning_contract');assert.notEqual(expected,repair.failedLearningCandidateSha256);assert.equal(cap.learning.enabled,false);
const originalLedgerFile=cap.learning.ledgerFile,originalBytes=await fs.readFile(originalLedgerFile),original=JSON.parse(originalBytes);
assert.equal(sha(originalBytes),repair.failedLearningLedgerSha256);assert.equal(original.sealed.reasonCode,'host_native_learning_output_contract_invalid');assert.equal(original.calls.length,1);assert.ok(original.calls.every(c=>c.status==='completed'&&c.exitCode===0&&!c.signal));
const request={expectedGoalVersionId:authority.goalVersionId,expectedCandidateSha256:expected,acknowledgement:'new_reviewed_candidate_learning_acceptance',expectedFailedCandidateSha256:repair.failedLearningCandidateSha256,expectedPriorLearningLedgerSha256:sha(originalBytes)};
const owned=path.join(root,'backend','new-reviewed-candidate-learning-acceptance-'+repair.batchId);await fs.mkdir(owned,{recursive:false,mode:0o700});
const save=(name,data)=>fs.writeFile(path.join(owned,name),JSON.stringify(data,null,2)+'\n',{flag:'wx',mode:0o600});
await save('before.json',{authority,intake,request,oldLearningLedgerSha256:sha(originalBytes),oldLearningLedgerFile:originalLedgerFile,modelCalls:0,authorizationSource:'Parent explicitly authorized exact contract repair, then genuine independent review/confirmation and a separate bounded new-candidate real teaching acceptance; old failed learning01 preserved.'});
const response=await api('/api/irixi-learning/open-batch',request);await save('response.json',response);assert.equal(response.ordinal,2);assert.equal(response.cap,2);assert.equal(response.windowMs,1200000);assert.equal(sha(await fs.readFile(originalLedgerFile)),sha(originalBytes));await assert.rejects(fs.access(response.ledgerFile));
const after=await api('/api/irixi-intake');assert.equal(after.modelAvailability.learning.remaining,2);assert.equal(after.modelAvailability.learning.running,false);assert.equal(after.modelAvailability.learning.sealed,false);
await save('after.json',after);await save('result.json',{at:new Date().toISOString(),ok:true,newCandidateSha256:expected,oldCandidateSha256:repair.failedLearningCandidateSha256,ordinal:response.ordinal,oldFailureAndLedgerUnchanged:true,newIndependentLedgerAbsent:true,modelCalls:0,automaticRetry:false,cap:2,windowMs:1200000});console.log(JSON.stringify({opened:true,ordinal:response.ordinal,newCandidateSha256:expected,originalFailedLearning01Preserved:true,modelCalls:0,evidence:owned}));
