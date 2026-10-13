#!/usr/bin/env node
// One explicit bounded repair authorization through the existing product API.
// This operator harness does not author business code, run models, or retry.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fingerprint } from '../../../../authority/authority-core.mjs';

const root = path.resolve(import.meta.dirname, '..'), base = 'http://127.0.0.1:9109';
const args = process.argv.slice(2);
const reviewOnly = args.includes('--review-only'), attemptIndex = args.indexOf('--attempt');
const authorizationAttempt = attemptIndex < 0 ? 1 : Number(args[attemptIndex + 1]);
const expectedArgs = ['--prepare',args[1],...(reviewOnly?['--review-only']:[]),...(attemptIndex<0?[]:['--attempt',String(authorizationAttempt)])];
if (JSON.stringify(args)!==JSON.stringify(expectedArgs) || !/^development-\d{2,4}$/.test(args[1]||'') || !Number.isInteger(authorizationAttempt) || authorizationAttempt<1 || authorizationAttempt>9) throw Error('Use explicitly --prepare development-NN [--review-only] [--attempt N]; this action does not start a model.');
const expectedBatch = args[1], digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function api(route, body) {
  const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: base, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
  return { ok: response.ok, status: response.status, value: await response.json() };
}
async function files(rootDir) {
  const result = [];
  async function visit(dir, prefix = '') {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const relative = prefix ? prefix + '/' + entry.name : entry.name, file = path.join(dir, entry.name), stat = await fs.lstat(file);
      assert.equal(stat.isSymbolicLink(), false);
      if (stat.isDirectory()) await visit(file, relative);
      else { assert.equal(stat.isFile(), true); assert.equal(stat.nlink, 1); const bytes = await fs.readFile(file); result.push({ path: relative, bytes: bytes.length, sha256: digest(bytes) }); }
    }
  }
  await visit(rootDir); return result.sort((a, b) => a.path.localeCompare(b.path));
}
const taskFile = path.join(root, 'state/tasks/task-article-learning-12/task.json'), capFile = path.join(root, 'state/model-capability.json');
const beforeTask = await fs.readFile(taskFile), beforeCap = await fs.readFile(capFile), task = JSON.parse(beforeTask), cap = JSON.parse(beforeCap);
const registration = JSON.parse(await fs.readFile(path.join(root, 'project.json'))), workspace = path.join(root, 'workspace');
assert.equal(path.resolve(registration.workspace), workspace);
assert.equal(task.execution.phase, 'failed'); assert.equal(task.execution.stopReason, 'permanent_error');
assert.equal(cap.development.enabled, false); assert.equal(cap.learning.enabled, false);
const ordinal = Number(/^development-(\d{2,4})$/.exec(cap.development.batchId)?.[1]) + 1;
assert.equal(expectedBatch, 'development-' + String(ordinal).padStart(2, '0'));
const priorLedgerFile = cap.development.ledgerFile, priorLedgerBytes = await fs.readFile(priorLedgerFile), priorLedger = JSON.parse(priorLedgerBytes);
assert.ok(priorLedger.sealed); assert.ok(priorLedger.calls.every(call => !['reserved', 'running'].includes(call.status)));
const beforeFiles = await files(workspace), initial = await api('/api/irixi-intake'); assert.ok(initial.ok);
assert.equal(initial.value.goal.confirmed, true); assert.equal(initial.value.executionOption.current, true);
assert.deepEqual({ statement: initial.value.goal.statement, successCriteria: initial.value.goal.successCriteria, boundaries: initial.value.goal.boundaries }, registration.goalDraft);
const proposal = initial.value.executionOption.repairProposal; assert.ok(proposal);
assert.equal(proposal.expectedFailedExecutionId, task.execution.id); assert.equal(proposal.expectedPriorLedgerSha256, digest(priorLedgerBytes));
assert.equal(proposal.maxModelCalls, 2); assert.equal(proposal.maxDurationMs, 1200000);
let priorLearningBytes=null;
if(expectedBatch==='development-20'){
  assert.equal(reviewOnly,false);assert.equal(proposal.repairKind,'learning_contract');assert.equal(proposal.acknowledgement,'preserve_failed_learning_contract');
  assert.equal(proposal.expectedFailedCandidateSha256,fingerprint(beforeFiles));assert.equal(proposal.expectedFailedTurnId,'fca3e2ec-c05d-43af-91da-dbf88b14cc69');
  priorLearningBytes=await fs.readFile(cap.learning.ledgerFile);assert.equal(proposal.expectedLearningLedgerSha256,digest(priorLearningBytes));
  assert.equal(JSON.parse(priorLearningBytes).sealed.reasonCode,'host_native_learning_output_contract_invalid');
  const reproduction=await fs.readFile(path.join(root,'evidence/learning01-real-output-contract-independent-reproduction.json'));assert.equal(proposal.expectedLearningEvidenceSha256,digest(reproduction));
}
if (reviewOnly) { assert.equal(proposal.reviewOnlyAvailable, true); assert.equal(proposal.expectedCandidateSha256, fingerprint(beforeFiles)); }
if(authorizationAttempt>1){
  // A prior rejected zero-model API attempt is retained. This explicit manual
  // invocation neither retries a native process nor replaces a used budget.
  const priorAttempt=path.join(root,'backend',expectedBatch+'-api-preparation'+(authorizationAttempt===2?'':'-attempt-'+(authorizationAttempt-1)));
  const rejectedAttempt=JSON.parse(await fs.readFile(path.join(priorAttempt,'result.json')));
  assert.equal(rejectedAttempt.ok,false);assert.equal(rejectedAttempt.nativeCalls,0);
  const priorAttemptTask=JSON.parse(await fs.readFile(path.join(priorAttempt,'prior-task.json')));
  assert.equal(priorAttemptTask.execution.id,task.execution.id);
}
const owned = path.join(root, 'backend', expectedBatch + '-api-preparation'+(authorizationAttempt===1?'':'-attempt-'+authorizationAttempt));
await fs.mkdir(owned, { recursive: false, mode: 0o700 });
const save = (name, value) => fs.writeFile(path.join(owned, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
await fs.writeFile(path.join(owned, 'prior-task.json'), beforeTask, { flag: 'wx', mode: 0o600 });
await fs.writeFile(path.join(owned, 'prior-capability.json'), beforeCap, { flag: 'wx', mode: 0o600 });
await save('prior-workspace-manifest.json', beforeFiles);
const explicitRequest = reviewOnly ? { ...proposal, reviewOnly: true } : proposal;
const prepared = await api('/api/irixi-intake/open-repair-batch', explicitRequest);
await save('authorization.json', { authorizationSource: 'Explicit continuous bounded advancement: Sentinel_02b6e8cd601481919c4d63e2e0c395f8, 2026-10-05; each failed batch stops and remains preserved.', request: explicitRequest, response: prepared });
if (!prepared.ok) {
  assert.equal(digest(await fs.readFile(priorLedgerFile)), digest(priorLedgerBytes));
  await save('result.json', { ok: false, status: prepared.status, error: prepared.value.error, nativeCalls: 0, automaticRetry: false });
  throw Error('Product repair authorization rejected (' + prepared.status + '): ' + prepared.value.error);
}
assert.equal(prepared.value.batchId, expectedBatch);
const latest = await api('/api/irixi-intake'); assert.ok(latest.ok); await save('prepared-intake.json', latest.value);
const afterTask = JSON.parse(await fs.readFile(taskFile)), afterCap = JSON.parse(await fs.readFile(capFile));
assert.deepEqual(afterTask.executionHistory.at(-1), task.execution);
for (const priorArtifact of task.artifacts || []) {
  const retained = (afterTask.artifacts || []).find(artifact => artifact.id === priorArtifact.id);
  assert.ok(retained, 'Prior candidate must be retained');
  assert.equal(retained.content, priorArtifact.content);
  assert.deepEqual(retained.projectCandidate, priorArtifact.projectCandidate);
}
assert.equal(afterTask.execution.id, prepared.value.executionId); assert.equal(afterTask.execution.phase, 'planned');
assert.equal(afterTask.execution.startedAt, null); assert.equal(afterTask.execution.deadlineAt, null);
assert.equal(afterCap.development.executionId, afterTask.execution.id); assert.equal(afterCap.learning.enabled, false);
assert.equal(latest.value.modelAvailability.execution.remaining, reviewOnly ? 1 : 2); assert.equal(latest.value.modelAvailability.execution.running, false);
if (reviewOnly) {
  assert.equal(prepared.value.reviewOnly, true); assert.equal(prepared.value.maxNativeCalls, 1);
  assert.equal(afterCap.development.mode, 'review_only'); assert.equal(afterTask.execution.reviewOnly, true);
  assert.equal(latest.value.executionOption.registeredExecution, null);
  const authority = await api('/api/irixi-authority'); assert.ok(authority.ok); await save('recaptured-candidate.json', authority.value);
  assert.equal(authority.value.goalVersionId, latest.value.goal.id);
  assert.equal(authority.value.artifact.candidateSha256, fingerprint(beforeFiles));
  assert.equal(authority.value.artifact.hostCheck.passed, true);
  assert.equal(prepared.value.candidateSha256, fingerprint(beforeFiles));
} else assert.ok(latest.value.executionOption.registeredExecution);
assert.equal(digest(await fs.readFile(priorLedgerFile)), digest(priorLedgerBytes));
if(priorLearningBytes)assert.equal(digest(await fs.readFile(cap.learning.ledgerFile)),digest(priorLearningBytes),'Failed learning01 ledger must stay exact');
assert.deepEqual(await files(workspace), beforeFiles);
assert.deepEqual(await files(path.join(root, 'state', expectedBatch, 'prior-failed-workspace')), beforeFiles);
await assert.rejects(fs.access(afterCap.development.ledgerFile));
const result = { recordedAt: new Date().toISOString(), evidenceType: 'actual product repair API, zero native calls', ok: true, batchId: expectedBatch, executionId: afterTask.execution.id, goalVersionId: latest.value.goal.id, priorFailedExecutionId: task.execution.id, priorLedgerSha256: digest(priorLedgerBytes), candidateHistoryPreserved: true, failedWorkspaceArchivedExact: true, businessFilesUnchanged: true, nativeCalls: 0, phase: 'planned', startedAt: null, deadlineAt: null, reviewOnly, remaining: reviewOnly ? 1 : 2, maxNativeCalls: reviewOnly ? 1 : 2, authorizedUpperBound: 2, candidateSha256: reviewOnly ? fingerprint(beforeFiles) : null, windowMs: 1200000, automaticRetry: false };
await save('result.json', result); process.stdout.write(JSON.stringify(result, null, 2) + '\n');
