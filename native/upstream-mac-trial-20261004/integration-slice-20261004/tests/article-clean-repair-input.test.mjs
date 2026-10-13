import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createArticleProjectController, __test } from '../authority/article-project-controller.mjs';
import { CLEAN_INPUT35, createCleanRepairInputManager, cleanRepairReviewBoundary } from '../authority/article-clean-repair-input.mjs';
import { canonical, fingerprint, sha256 } from '../authority/authority-core.mjs';

const base = path.resolve(import.meta.dirname,'..'), real = path.join(base,'project-intake-20261004/projects/article-learning-12'), app = path.join(base,'sources/irixi-20261004/app');
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'irixi-clean35-preparation-'))), tasks = path.join(root,'state/tasks'), state = path.join(root,'state');
  const task = JSON.parse(await fs.readFile(path.join(real,'state/tasks/task-article-learning-12/task.json'))), taskFile = path.join(tasks,task.id,'task.json');
  await fs.mkdir(path.dirname(taskFile),{recursive:true}); await fs.writeFile(taskFile,JSON.stringify(task)); await fs.writeFile(path.join(path.dirname(taskFile),'events.jsonl'),'');
  const workspace = path.join(root,'workspace'); await fs.cp(path.join(real,'backend/development-46-exact-native-source-20261006/source'),workspace,{recursive:true});
  const project = JSON.parse(await fs.readFile(path.join(real,'project.json'))); project.workspace = workspace; const projectFile = path.join(root,'project.json'); await fs.writeFile(projectFile,JSON.stringify(project));
  await fs.cp(path.join(real,'state/development-46'),path.join(state,'development-46'),{recursive:true});
  const capability = JSON.parse(await fs.readFile(path.join(real,'state/model-capability.json'))); capability.development.ledgerFile = path.join(state,'development-46/model-ledger.json');
  const capabilityFile = path.join(state,'model-capability.json'); await fs.writeFile(capabilityFile,JSON.stringify(capability));
  for (const dir of ['backend/development-45-exact-native-source-20261006','backend/development-46-exact-native-source-20261006']) await fs.cp(path.join(real,dir),path.join(root,dir),{recursive:true});
  const registration = JSON.parse(await fs.readFile(path.join(real,'evidence/clean-input35-fixed-acceptance-registration-20261007.json')));
  const files = [CLEAN_INPUT35.failedReportFile,'evidence/'+CLEAN_INPUT35.briefFile,'evidence/clean-input35-fixed-acceptance-registration-20261007.json',...registration.gates.map(g=>g.file)];
  for (const file of files) { await fs.mkdir(path.dirname(path.join(root,file)),{recursive:true}); await fs.copyFile(path.join(real,file),path.join(root,file)); }
  const controller = await createArticleProjectController({tasksRoot:tasks,irixiAppRoot:app,projectFile,capabilityFile});
  const request = {acknowledgement:'prepare_clean_input_only',expectedGoalVersionId:CLEAN_INPUT35.goalVersionId,expectedFailedExecutionId:CLEAN_INPUT35.failedExecutionId,
    expectedConfirmedCandidateSha256:CLEAN_INPUT35.confirmedCandidateSha256,expectedSourceCandidateSha256:CLEAN_INPUT35.inputCandidateSha256,
    expectedFailedWorkspaceFingerprint:CLEAN_INPUT35.failedWorkspaceFingerprint,expectedPriorLedgerSha256:CLEAN_INPUT35.failedLedgerSha256,expectedScopeFingerprint:task.projectWorkspace.scopeFingerprint};
  return {root,state,task,taskFile,workspace,projectFile,capabilityFile,controller,request};
}
const openRequest = prepared => ({preparedId:prepared.preparedId,expectedPreparationSha256:prepared.preparationSha256,acknowledgement:'open_clean_prepared_repair',maxModelCalls:2,maxDurationMs:20*60_000,optInBoundedAutoReview:true});

test('CONTROLLED: clean35 preparation preserves closed46 and confirmed28; no batch or model is opened', async () => {
  const f = await fixture(), taskBefore = await fs.readFile(f.taskFile), capBefore = await fs.readFile(f.capabilityFile), oldManifest = await __test.manifest(f.workspace);
  const prepared = await f.controller.prepareCleanRepairInput(f.task.id,f.request);
  assert.equal(prepared.inputVersion,35); assert.equal(prepared.inputIsConfirmed,false); assert.equal(prepared.confirmedVersion,28); assert.equal(prepared.actualModelCalls,0); assert.equal(prepared.batchOpened,false);
  assert.equal(fingerprint(await __test.manifest(prepared.sourceRoot)),CLEAN_INPUT35.inputCandidateSha256);
  assert.deepEqual(await __test.manifest(f.workspace),oldManifest); assert.deepEqual(await fs.readFile(f.taskFile),taskBefore); assert.deepEqual(await fs.readFile(f.capabilityFile),capBefore);
  await assert.rejects(fs.access(path.join(f.state,'development-47')));
  const valid = await f.controller.validateCleanRepairInput(f.task.id,openRequest(prepared)); assert.equal(valid.prepared,true);
});
test('CONTROLLED: wrong input version, changed source, changed gate and stale preparation are rejected', async () => {
  for (const fault of ['wrong-version','source','gate','stale']) {
    const f = await fixture();
    if (fault==='wrong-version') { await assert.rejects(f.controller.prepareCleanRepairInput(f.task.id,{...f.request,expectedSourceCandidateSha256:CLEAN_INPUT35.confirmedCandidateSha256}),/selection binding/); continue; }
    if (fault==='source') { await fs.appendFile(path.join(f.root,CLEAN_INPUT35.inputSource,'app.js'),'\n// controlled tamper\n'); await assert.rejects(f.controller.prepareCleanRepairInput(f.task.id,f.request),/source or preserved/); continue; }
    if (fault==='gate') { await fs.appendFile(path.join(f.root,'tools/assessment-delivery-fixed-headless-zero-model.mjs'),'\n'); await assert.rejects(f.controller.prepareCleanRepairInput(f.task.id,f.request),/fixed gate/); continue; }
    const p = await f.controller.prepareCleanRepairInput(f.task.id,f.request); await fs.appendFile(path.join(p.sourceRoot,'test-core.js'),'\n');
    await assert.rejects(f.controller.validateCleanRepairInput(f.task.id,openRequest(p)),/changed or.*stale/); await assert.rejects(fs.access(path.join(f.state,'development-47')));
  }
});
test('CONTROLLED: dirty46 generic repair and preparation-only activation cannot open a batch', async () => {
  const f = await fixture(), p = await f.controller.prepareCleanRepairInput(f.task.id,f.request), before = await fs.readFile(f.taskFile);
  await assert.rejects(f.controller.openRepairBatch(f.task.id,{acknowledgement:'preserve_failed_batch',maxModelCalls:2,maxDurationMs:20*60_000}),/separately prepared clean35/);
  await assert.rejects(f.controller.openCleanRepairBatch(f.task.id,{...openRequest(p),acknowledgement:'prepare_clean_input_only'}),/separate explicit/);
  await assert.rejects(fs.access(path.join(f.state,'development-47'))); assert.deepEqual(await fs.readFile(f.taskFile),before);
});
test('CONTROLLED: later explicit activation binds clean35, preserves46, removes historical review instructions and keeps tests read-only', async () => {
  const f = await fixture(), p = await f.controller.prepareCleanRepairInput(f.task.id,f.request), opened = await f.controller.openCleanRepairBatch(f.task.id,openRequest(p));
  assert.equal(opened.batchId,'development-47'); assert.equal(fingerprint(await __test.manifest(f.workspace)),CLEAN_INPUT35.inputCandidateSha256);
  const prior = JSON.parse(await fs.readFile(path.join(f.state,'development-47/prior-task-execution.json'))); assert.equal(prior.execution.id,CLEAN_INPUT35.failedExecutionId); assert.equal(prior.execution.phase,'failed');
  const activationDir = (await fs.readdir(path.dirname(p.preparationFile))).find(x=>x.startsWith('activation-'));
  assert.equal(fingerprint(await __test.manifest(path.join(path.dirname(p.preparationFile),activationDir,'preserved-failed46-workspace'))),CLEAN_INPUT35.failedWorkspaceFingerprint);
  assert.match(opened.registeredExecution.prompt,/Only app\.js, core\.js/); assert.match(opened.registeredExecution.prompt,/test-core\.js and all frozen tests are read-only/);
  assert.doesNotMatch(opened.registeredExecution.prompt,/Historical-session continuation always fails|repair every accepted-contract issue|timestamp-based record merging/);
  await f.controller.assertRegisteredExecutionCurrent(f.task.id); await f.controller.assertRepairInputCurrent(f.task.id); await assert.rejects(fs.access(opened.ledgerFile));
  const changed = JSON.parse(await fs.readFile(f.taskFile));
  const reviewScope = await cleanRepairReviewBoundary(changed,f.projectFile); assert.match(reviewScope,/finite F1 decision\/UI\/evidence\/save\/reopen/); assert.match(reviewScope,/test-core\.js read-only/); assert.doesNotMatch(reviewScope,/Historical-session continuation always fails|repair every accepted-contract issue/);
  assert.equal(changed.artifacts.find(a=>a.version===28).status,'confirmed'); assert.equal(changed.artifacts.find(a=>a.version===35).status,'rejected');
  assert.equal(canonical(changed.reviews),canonical(f.task.reviews)); assert.equal(canonical(changed.approvals),canonical(f.task.approvals));
  await fs.appendFile(path.join(f.workspace,'test-core.js'),'\n// controlled illegal change\n');
  await f.controller.store.mutate(f.task.id,t=>f.controller.helpers.event(t,'integration.observation','controlled terminal',{type:'TASK_DONE',actor:'developer',binding:{executionId:t.execution.id},changedFiles:['test-core.js']}));
  await assert.rejects(f.controller.hostCheck(f.task.id),/exceed or mismatch/);
});
test('CONTROLLED: a permitted app-only candidate is captured completely and reserves readonly review without calling a model', async () => {
  const f = await fixture(), p = await f.controller.prepareCleanRepairInput(f.task.id,f.request); await f.controller.openCleanRepairBatch(f.task.id,openRequest(p));
  await fs.appendFile(path.join(f.workspace,'app.js'),'\n// controlled scope-only candidate; not a business repair\n');
  await f.controller.store.mutate(f.task.id,t=>f.controller.helpers.event(t,'integration.observation','controlled terminal',{type:'TASK_DONE',actor:'developer',binding:{executionId:t.execution.id},changedFiles:['app.js']}));
  const captured = await f.controller.hostCheck(f.task.id); assert.equal(captured.passed,true); assert.equal(captured.candidate.changes.length,8); assert.deepEqual(captured.candidate.reportedChangedFiles,['app.js']);
  const t = await f.controller.store.get(f.task.id); assert.ok(t.events.some(e=>e.type==='integration.review_dispatch_reserved')); assert.equal(t.artifacts.find(a=>a.version===28).status,'confirmed');
  const briefFile = path.join(f.root,'evidence',CLEAN_INPUT35.briefFile); await fs.appendFile(briefFile,'\n'); await assert.rejects(cleanRepairReviewBoundary(t,f.projectFile),/Reviewer scope is stale/);
});
test('CONTROLLED: failed activation rolls back only untouched staged input and never rewrites old task/capability', async () => {
  const f = await fixture(), p = await f.controller.prepareCleanRepairInput(f.task.id,f.request), taskBefore = await fs.readFile(f.taskFile), capBefore = await fs.readFile(f.capabilityFile);
  const repairInputManifest = async root => (await __test.manifest(root)).map(x=>({...x,trust:'failed-run-output'}));
  const manager = createCleanRepairInputManager({projectFile:f.projectFile,capabilityFile:f.capabilityFile,store:f.controller.store,helpers:f.controller.helpers,workspaceRoot:f.workspace,manifest:__test.manifest,repairInputManifest});
  await assert.rejects(manager.activate(f.task.id,openRequest(p),async()=>{throw Error('controlled registration failure')}),/controlled registration failure/);
  assert.equal(fingerprint(await __test.manifest(f.workspace)),CLEAN_INPUT35.failedWorkspaceFingerprint); assert.deepEqual(await fs.readFile(f.taskFile),taskBefore); assert.deepEqual(await fs.readFile(f.capabilityFile),capBefore);
});
test('CONTROLLED: concurrent explicit activations are serialized; only one can bind the stopped input', async () => {
  const f = await fixture(), p = await f.controller.prepareCleanRepairInput(f.task.id,f.request);
  const results = await Promise.allSettled([f.controller.openCleanRepairBatch(f.task.id,openRequest(p)),f.controller.openCleanRepairBatch(f.task.id,openRequest(p))]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1); assert.equal(results.filter(r=>r.status==='rejected').length,1);
  assert.equal(fingerprint(await __test.manifest(f.workspace)),CLEAN_INPUT35.inputCandidateSha256);
  assert.equal(JSON.parse(await fs.readFile(f.taskFile)).execution.repair.cleanInputBinding.inputCandidateSha256,CLEAN_INPUT35.inputCandidateSha256);
});
test('CONTROLLED: the clean effective brief excludes raw historical Reviewer commands while preserving ordinary repair prompts', () => {
  const project={goalDraft:{statement:'controlled',successCriteria:[],boundaries:[]},material:{path:'controlled',sha256:'0'.repeat(64)}};
  const repair={goalIncrementRepair:true,repairOfExecutionId:CLEAN_INPUT35.failedExecutionId,batchId:'controlled',priorReviewerOutcome:'FAIL',priorReviewerFailureText:'OBSOLETE_REVIEW_COMMAND',repairBrief:'ACTIVE_BRIEF',repairBriefSha256:'0'.repeat(64)};
  assert.match(__test.developerRequest(project,'goal','exec',null,repair).prompt,/OBSOLETE_REVIEW_COMMAND/);
  const current=__test.developerRequest(project,'goal','exec',null,{...repair,cleanInputBinding:{inputCandidateSha256:CLEAN_INPUT35.inputCandidateSha256}}).prompt;
  assert.doesNotMatch(current,/OBSOLETE_REVIEW_COMMAND/); assert.match(current,/ACTIVE_BRIEF/); assert.match(current,/Current effective scope is solely/);
});
