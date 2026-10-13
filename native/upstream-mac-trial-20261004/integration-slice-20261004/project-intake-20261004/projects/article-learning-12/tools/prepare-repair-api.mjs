#!/usr/bin/env node
// Explicit zero-model preparation through the same live product API as the UI.
// It sends no WebSocket RUN_TASK and cannot invoke a native model.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
const root = path.resolve(import.meta.dirname, '..'), base = 'http://127.0.0.1:9109';
const args = process.argv.slice(2);
if (args.length !== 1 || args[0] !== '--prepare') throw Error('Explicit --prepare required. This only prepares the product repair batch; it never runs a model.');
const owned = path.join(root, 'backend/live-zero-model-repair-20261005');
await fs.mkdir(owned, { recursive: false, mode: 0o700 });
const save = (name,value) => fs.writeFile(path.join(owned,name),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
async function api(route,body) {
  const response=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{Origin:base,...(body===undefined?{}:{'Content-Type':'application/json'})},signal:AbortSignal.timeout(10000),...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {status:response.status,ok:response.ok,value:await response.json()};
}
const taskFile=path.join(root,'state/tasks/task-article-learning-12/task.json'),capFile=path.join(root,'state/model-capability.json');
const beforeTask=await fs.readFile(taskFile),beforeCap=await fs.readFile(capFile),old=JSON.parse(beforeTask);
const oldLedgerFile=JSON.parse(beforeCap).development.ledgerFile,oldLedger=await fs.readFile(oldLedgerFile);
const initial=await api('/api/irixi-intake');assert.equal(initial.ok,true);await save('before.json',initial.value);
const registration=JSON.parse(await fs.readFile(path.join(root,'project.json')));
assert.deepEqual({statement:initial.value.goal.statement,successCriteria:initial.value.goal.successCriteria,boundaries:initial.value.goal.boundaries},registration.goalDraft);
assert.equal(initial.value.goal.confirmed,true);assert.equal(initial.value.executionOption.current,true);
assert.equal(old.execution.phase,'failed');assert.equal(old.execution.stopReason,'permanent_error');
const proposal=initial.value.executionOption.repairProposal;assert.ok(proposal);assert.equal(proposal.expectedFailedExecutionId,old.execution.id);
for(const mutation of [{expectedGoalVersionId:'goal-stale-zero-model-probe'},{maxModelCalls:3}]){
  const rejected=await api('/api/irixi-intake/open-repair-batch',{...proposal,...mutation});assert.equal(rejected.ok,false);assert.ok([400,409].includes(rejected.status));
  assert.equal(sha(await fs.readFile(taskFile)),sha(beforeTask));assert.equal(sha(await fs.readFile(capFile)),sha(beforeCap));
  await assert.rejects(fs.access(path.join(root,'state/development-02')));await save('rejected-'+Object.keys(mutation)[0]+'.json',rejected);
}
const prepared=await api('/api/irixi-intake/open-repair-batch',proposal);await save('explicit-repair-authorization.json',{request:proposal,response:prepared,authorization:'Parent explicitly authorized zero-model same-project nonempty failed-workspace continuation and live API preparation; no RUN_TASK or UI click claimed.'});
assert.equal(prepared.ok,true);assert.equal(prepared.value.batchId,'development-02');
const current=await api('/api/irixi-intake');assert.equal(current.ok,true);await save('prepared-intake.json',current.value);
const task=JSON.parse(await fs.readFile(taskFile)),cap=JSON.parse(await fs.readFile(capFile));
assert.deepEqual(task.executionHistory.at(-1),old.execution);
assert.equal(task.execution.phase,'planned');assert.equal(task.execution.startedAt,null);assert.equal(task.execution.deadlineAt,null);
assert.equal(task.execution.id,prepared.value.executionId);assert.equal(cap.development.executionId,task.execution.id);
assert.equal(current.value.modelAvailability.execution.remaining,2);assert.equal(current.value.modelAvailability.execution.running,false);
assert.equal(current.value.modelAvailability.execution.deadlineAt,null);assert.equal(cap.learning.enabled,false);
assert.equal(sha(await fs.readFile(oldLedgerFile)),sha(oldLedger));await assert.rejects(fs.access(cap.development.ledgerFile));
const failure=JSON.parse(await fs.readFile(path.join(root,'evidence/real-backend-failure-20261005.json')));
for(const file of failure.workspaceFiles){assert.equal(sha(await fs.readFile(path.join(root,'workspace',file.path))),file.sha256);assert.equal(sha(await fs.readFile(path.join(root,'state/development-02/prior-failed-workspace',file.path))),file.sha256);}
const result={recordedAt:new Date().toISOString(),evidenceType:'actual live product HTTP repair API; no native model, WebSocket RUN_TASK, or browser click',ok:true,batchId:prepared.value.batchId,executionId:task.execution.id,goalVersionId:initial.value.goal.id,scopeFingerprint:prepared.value.scopeFingerprint,inputManifestSha256:prepared.value.repairInputManifestSha256,inputWorkspace:registration.workspace,oldExecutionId:old.execution.id,oldExecutionPreservedFailed:true,oldLedgerSha256:sha(oldLedger),failedWorkspaceArchivedExact:true,businessFilesUnchanged:true,nativeModelsThisPreparation:0,nativeCallsTotal:JSON.parse(oldLedger).calls.length,reviewerCalls:0,learningCalls:0,phase:'planned',startedAt:null,deadlineAt:null,nextBudget:{maxCalls:2,windowMs:1200000,roles:['developer','reviewer']},pendingRewardsExcluded:true,nextAction:'Wait for the user to explicitly start development-02; --inspect is read-only and --start development-02 is a separate native operation.'};
await save('result.json',result);await fs.writeFile(path.join(root,'evidence/live-repair-api-zero-model-20261005.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});process.stdout.write(JSON.stringify(result,null,2)+'\n');
