import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

import { createIntegrationController, __test as controllerTest } from '../authority/task-controller.mjs';
import { buildAuthorityProjection, createAuthorityReader, fingerprint, projectTaskBoard } from '../authority/authority-core.mjs';

const IRIXI_APP_ROOT = path.resolve(import.meta.dirname, '..', 'sources', 'irixi-20261004', 'app');

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-integration-controlled-'));
  const toy = path.join(root, 'toy');
  const tasks = path.join(root, 'tasks');
  await fs.mkdir(path.join(toy, 'src'), { recursive: true });
  await fs.mkdir(path.join(toy, 'checks'), { recursive: true });
  await fs.writeFile(path.join(toy, 'package.json'), '{"type":"module","scripts":{"test":"node --test checks/greeting.test.js"}}\n');
  await fs.writeFile(path.join(toy, 'src/greeting.js'), 'export function greeting(name) { return `Hello, ${name}`; }\n');
  await fs.writeFile(path.join(toy, 'checks/greeting.test.js'), `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { greeting } from '../src/greeting.js';\ntest('trim',()=>assert.equal(greeting('  Ada  '),'Hello, Ada!'));\ntest('blank',()=>assert.equal(greeting('   '),'Hello, friend!'));\n`);
  execFileSync('/usr/bin/git', ['init', '-q'], { cwd: toy });
  execFileSync('/usr/bin/git', ['config', 'user.email', 'controlled@example.invalid'], { cwd: toy });
  execFileSync('/usr/bin/git', ['config', 'user.name', 'Controlled Fixture'], { cwd: toy });
  execFileSync('/usr/bin/git', ['add', '.'], { cwd: toy });
  execFileSync('/usr/bin/git', ['commit', '-qm', 'controlled baseline'], { cwd: toy });
  const canonicalToy = await fs.realpath(toy);
  const controller = await createIntegrationController({ tasksRoot: tasks, irixiAppRoot: IRIXI_APP_ROOT, toyRoot: canonicalToy, testOnlyRegisteredToyRoot: canonicalToy });
  return { root, toy: canonicalToy, tasks: await fs.realpath(tasks), controller };
}

async function bindReviewer(controller, taskId, sourceTaskId = 'review-controlled') {
  await controller.store.mutate(taskId, (task) => {
    const artifact = task.artifacts.at(-1);
    controller.helpers.event(task, 'integration.observation', 'CONTROLLED reviewer start', {
      type: 'TASK_STARTED', actor: 'reviewer', sourceTaskId,
      binding: { artifactId: artifact.id, candidateSha256: artifact.projectCandidate.candidateSha256 },
    });
  });
  return sourceTaskId;
}

test('CONTROLLED: project artifact uses current host evidence, review, confirmation, export, and goal invalidation', async (t) => {
  const f = await fixture();
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const task = await f.controller.prepare();
  assert.equal(controllerTest.CONTRACT.namedExport, 'greeting');
  assert.equal(task.integrationExecutionRequest.prompt.endsWith(controllerTest.DEVELOPER_PROTOCOL_TAG), true);
  assert.equal(task.integrationExecutionRequest.displayPrompt.includes(controllerTest.DEVELOPER_PROTOCOL_TAG), false);
  assert.equal(task.integrationExecutionRequest.promptSha256.length, 64);
  assert.equal(task.type, 'project');
  await fs.writeFile(path.join(f.toy, 'src/greeting.js'), `export function greeting(name) {\n  const value = String(name).trim();\n  return value ? \`Hello, \${value}!\` : 'Hello, friend!';\n}\n`);
  const checked = await f.controller.hostCheck(task.id);
  assert.equal(checked.passed, true);
  let stored = await f.controller.store.get(task.id);
  const artifact = stored.artifacts.at(-1);
  assert.equal(f.controller.helpers.projectArtifactIsCurrent(stored, artifact), true);
  const sourceTaskId = await bindReviewer(f.controller, task.id);
  const review = await f.controller.recordReviewer(task.id, sourceTaskId, 'VERDICT: PASS\nISSUES:\n\nSUMMARY: The current one-file diff satisfies the two registered cases.');
  assert.equal(review.passed, true, JSON.stringify(review.checks.filter((entry) => entry.blocking && !entry.passed)));
  const confirmed = await f.controller.confirm(task.id, artifact.id, artifact.version);
  const exported = await f.controller.exportPatch(task.id, artifact.id, confirmed.approval.id);
  assert.equal(exported.sha256, confirmed.patchSha256);
  await f.controller.replaceGoal(task.id, { statement: 'Different explicit goal', successCriteria: ['Different result'], boundaries: ['Same public toy only'] });
  await assert.rejects(f.controller.exportPatch(task.id, artifact.id, confirmed.approval.id), /old goal|旧目标|workspace|current/i);
  const staleReader = await createAuthorityReader({ tasksRoot: f.tasks, taskId: task.id, irixiAppRoot: IRIXI_APP_ROOT });
  const staleProjection = (await staleReader.read()).projection;
  assert.equal(staleProjection.current, false);
  assert.equal(staleProjection.registeredExecution, null);
});

test('CONTROLLED: native run reservation survives restart and observation IDs are idempotent but collision-safe', async (t) => {
  const f = await fixture();
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const task = await f.controller.prepare();
  const reader = await createAuthorityReader({ tasksRoot: f.tasks, taskId: task.id, irixiAppRoot: IRIXI_APP_ROOT });
  const { projection } = await reader.read();
  const binding = {
    taskId: projection.taskId, goalVersionId: projection.goalVersionId, taskInputBindingSha256: projection.taskInputBindingSha256,
    pipelineBindingSha256: projection.pipelineBindingSha256, executionId: projection.execution.id,
    workspaceScopeFingerprint: projection.workspace.scopeFingerprint, sourceSnapshotSha256: projection.workspace.sourceSnapshotSha256,
    artifactId: null, artifactVersion: null, candidateSha256: null, diffSha256: null, authoritySnapshotSha256: projection.authoritySha256,
  };
  await assert.rejects(reader.reserveRun({ actor: 'developer', sourceTaskId: 'native-wrong', binding, promptSha256: '0'.repeat(64) }), /registered current execution request/);
  await reader.reserveRun({ actor: 'developer', sourceTaskId: 'native-controlled', binding, promptSha256: projection.registeredExecution.promptSha256 });
  const restarted = await createAuthorityReader({ tasksRoot: f.tasks, taskId: task.id, irixiAppRoot: IRIXI_APP_ROOT });
  await assert.rejects(restarted.reserveRun({ actor: 'developer', sourceTaskId: 'native-controlled-2', binding, promptSha256: projection.registeredExecution.promptSha256 }), /already reserved/);
  const body = { schemaVersion: 1, type: 'TASK_STARTED', actor: 'developer', sourceTaskId: 'native-controlled', sourceEventId: 'native-controlled:TASK_STARTED', binding, scopeOutcome: null, resultSha256: null, checkId: null, caseTotal: null, casePassed: null };
  body.observationFingerprint = fingerprint(body);
  assert.equal((await restarted.appendObservation(body)).created, true);
  assert.equal((await restarted.appendObservation(body)).created, false);
  const collided = { ...body, resultSha256: 'changed' };
  delete collided.observationFingerprint;
  collided.observationFingerprint = fingerprint(collided);
  await assert.rejects(restarted.appendObservation(collided), /collided/);
});

test('CONTROLLED: a current registered learning-resume repair preserves the confirmed input candidate through Developer reservation', async (t) => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const prepared = await f.controller.prepare();
  await fs.writeFile(path.join(f.toy, 'src/greeting.js'), `export function greeting(name) { const value=String(name).trim(); return value ? \`Hello, \${value}!\` : 'Hello, friend!'; }\n`);
  const checked = await f.controller.hostCheck(prepared.id), reviewTaskId = await bindReviewer(f.controller, prepared.id, 'review-resume');
  await f.controller.recordReviewer(prepared.id, reviewTaskId, 'VERDICT: PASS\nISSUES:\n\nSUMMARY: controlled confirmed input.');
  await f.controller.confirm(prepared.id, checked.artifactId, 1);
  const taskFile = path.join(f.tasks, prepared.id, 'task.json');
  await f.controller.store.mutate(prepared.id, (task) => {
    const prior = task.execution; f.controller.helpers.startExecution(task, task.goal.activeVersionId, { maxModelCalls: 2, maxDurationMs: 1_200_000, maxAttemptsPerStep: 1, maxPlanRevisions: 0 });
    task.execution.phase = 'planned'; task.execution.startedAt = null; task.execution.deadlineAt = null;
    task.execution.repair = { repairKind: 'learning_resume', failedLearningCandidateSha256: task.artifacts.at(-1).projectCandidate.candidateSha256 };
    const prompt = `controlled resume execution ${task.execution.id}`;
    task.integrationExecutionRequest = { goalVersionId: task.goal.activeVersionId, executionId: task.execution.id, displayPrompt: prompt, prompt, promptSha256: crypto.createHash('sha256').update(prompt).digest('hex') };
    task.executionHistory = [...(task.executionHistory || []), prior].slice(-20); task.status = 'waiting_user';
  });
  const pristine = await fs.readFile(taskFile);
  const reserve = async (suffix = 'ok', mutate = null, prompt = null, bindingMutate = null) => {
    await fs.writeFile(taskFile, pristine); if (mutate) await f.controller.store.mutate(prepared.id, mutate);
    const reader = await createAuthorityReader({ tasksRoot: f.tasks, taskId: prepared.id, irixiAppRoot: IRIXI_APP_ROOT }), { projection } = await reader.read();
    const binding = { taskId: projection.taskId, goalVersionId: projection.goalVersionId, taskInputBindingSha256: projection.taskInputBindingSha256, pipelineBindingSha256: projection.pipelineBindingSha256, executionId: projection.execution.id, workspaceScopeFingerprint: projection.workspace.scopeFingerprint, sourceSnapshotSha256: projection.workspace.sourceSnapshotSha256, artifactId: projection.artifact.id, artifactVersion: projection.artifact.version, candidateSha256: projection.artifact.candidateSha256, diffSha256: projection.artifact.diffSha256, authoritySnapshotSha256: projection.authoritySha256 };
    if (bindingMutate) bindingMutate(binding);
    return { reader, projection, result: () => reader.reserveRun({ actor: 'developer', sourceTaskId: `resume-${suffix}`, binding, promptSha256: prompt ?? projection.registeredExecution?.promptSha256 }) };
  };
  for (const [name, mutate, prompt, bindingMutate, pattern] of [
    ['wrong-kind', (task) => { task.execution.repair.repairKind = 'execution_failure'; }, null, null, /already has a candidate/],
    ['wrong-candidate', (task) => { task.execution.repair.failedLearningCandidateSha256 = '0'.repeat(64); }, null, null, /already has a candidate/],
    ['wrong-prompt', null, '0'.repeat(64), null, /registered current execution request/],
    ['wrong-binding', null, null, (binding) => { binding.executionId = 'run-stale'; }, /executionId is stale/],
    ['stopped', (task) => { task.execution.stopReason = 'permanent_error'; }, null, null, /stopped/],
  ]) { const attempt = await reserve(name, mutate, prompt, bindingMutate); await assert.rejects(attempt.result(), pattern); }
  const accepted = await reserve('accepted'); const event = await accepted.result(); assert.equal(event.detail.actor, 'developer');
  const after = await accepted.reader.read(); assert.equal(after.task.execution.phase, 'executing'); assert.ok(after.task.execution.startedAt); assert.ok(after.task.execution.deadlineAt);
  await assert.rejects(accepted.reader.reserveRun({ actor: 'developer', sourceTaskId: 'resume-duplicate', binding: { taskId: after.projection.taskId, goalVersionId: after.projection.goalVersionId, taskInputBindingSha256: after.projection.taskInputBindingSha256, pipelineBindingSha256: after.projection.pipelineBindingSha256, executionId: after.projection.execution.id, workspaceScopeFingerprint: after.projection.workspace.scopeFingerprint, sourceSnapshotSha256: after.projection.workspace.sourceSnapshotSha256, artifactId: after.projection.artifact.id, artifactVersion: after.projection.artifact.version, candidateSha256: after.projection.artifact.candidateSha256, diffSha256: after.projection.artifact.diffSha256, authoritySnapshotSha256: after.projection.authoritySha256 }, promptSha256: after.projection.registeredExecution.promptSha256 }), /already reserved/);
});

test('CONTROLLED: candidate tampering after review rejects confirmation', async (t) => {
  const f = await fixture();
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const task = await f.controller.prepare();
  await fs.writeFile(path.join(f.toy, 'src/greeting.js'), `export function greeting(name) { const value=String(name).trim(); return value ? \`Hello, \${value}!\` : 'Hello, friend!'; }\n`);
  const checked = await f.controller.hostCheck(task.id);
  const sourceTaskId = await bindReviewer(f.controller, task.id);
  await f.controller.recordReviewer(task.id, sourceTaskId, 'VERDICT: PASS\nISSUES:\n\nSUMMARY: Current candidate is acceptable.');
  await fs.appendFile(path.join(f.toy, 'src/greeting.js'), '// tampered after review\n');
  await assert.rejects(f.controller.confirm(task.id, checked.artifactId, 1), /changed after host verification|patch changed/i);
});

test('CONTROLLED: preserved native FAIL about non-string inputs is outside the accepted string contract, not rewritten', async (t) => {
  const f = await fixture();
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const task = await f.controller.prepare();
  await fs.writeFile(path.join(f.toy, 'src/greeting.js'), `export function greeting(name) { const value=String(name).trim(); return value ? \`Hello, \${value}!\` : 'Hello, friend!'; }\n`);
  await f.controller.hostCheck(task.id);
  const sourceTaskId = await bindReviewer(f.controller, task.id, 'review-historical-shape');
  const original = '**VERDICT:** FAIL\n**ISSUES:**\n1. Missing, `null`, or non-string names now throw before fallback; this concerns inputs outside the accepted string contract.\n**SUMMARY:** The registered string cases pass, with a suggestion for broader inputs.\n';
  const review = await f.controller.recordReviewer(task.id, sourceTaskId, original);
  assert.equal(review.nativeVerdict, 'FAIL');
  assert.equal(review.scopeOutcome, 'outside_scope_only');
  assert.equal(review.passed, true, JSON.stringify(review.checks.filter((entry) => entry.blocking && !entry.passed)));
  assert.equal(review.fullOutputSha256.length, 64);
});

test('CONTROLLED: an unlabeled or contract failure is never inferred as an outside-scope suggestion', async (t) => {
  const f = await fixture();
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const task = await f.controller.prepare();
  await fs.writeFile(path.join(f.toy, 'src/greeting.js'), `export function greeting(name) { const value=String(name).trim(); return value ? \`Hello, \${value}!\` : 'Hello, friend!'; }\n`);
  await f.controller.hostCheck(task.id);
  await bindReviewer(f.controller, task.id, 'review-ambiguous');
  const ambiguous = await f.controller.recordReviewer(task.id, 'review-ambiguous', 'VERDICT: FAIL\nISSUES:\n- Missing fallback for blank string\nSUMMARY: blocking behavior is unclear.');
  assert.equal(ambiguous.nativeVerdict, 'FAIL');
  assert.equal(ambiguous.scopeOutcome, 'needs_decision');
  assert.equal(ambiguous.passed, false);

  const f2 = await fixture();
  t.after(() => fs.rm(f2.root, { recursive: true, force: true }));
  const task2 = await f2.controller.prepare();
  await fs.writeFile(path.join(f2.toy, 'src/greeting.js'), `export function greeting(name) { const value=String(name).trim(); return value ? \`Hello, \${value}!\` : 'Hello, friend!'; }\n`);
  await f2.controller.hostCheck(task2.id);
  await bindReviewer(f2.controller, task2.id, 'review-contract');
  const contract = await f2.controller.recordReviewer(task2.id, 'review-contract', 'VERDICT: FAIL\nISSUES:\n- CONTRACT: blank strings return the wrong fallback\nSUMMARY: registered behavior fails.');
  assert.equal(contract.scopeOutcome, 'contract_failed');
  assert.equal(contract.passed, false);
});

test('CONTROLLED: failed fixed tests stop without an artifact', async (t) => {
  const f = await fixture();
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const task = await f.controller.prepare();
  await fs.writeFile(path.join(f.toy, 'src/greeting.js'), 'export function greeting() { return "wrong"; }\n');
  const result = await f.controller.hostCheck(task.id);
  assert.equal(result.passed, false);
  const stored = await f.controller.store.get(task.id);
  assert.equal(stored.artifacts.length, 0);
  assert.equal(stored.execution.stopReason, 'project_verification_failed');
});

test('CONTROLLED: a bound native failure stops the execution without an implicit retry', async (t) => {
  const f = await fixture();
  t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const task = await f.controller.prepare();
  await assert.rejects(f.controller.startNewRegisteredExecution(task.id, task.goal.activeVersionId), /尚未停止/);
  const priorExecutionId = task.execution.id;
  const priorScope = task.projectWorkspace.scopeFingerprint;
  const priorSource = task.projectWorkspace.sourceSnapshotSha256;
  const priorPrompt = task.integrationExecutionRequest.prompt;
  await f.controller.store.mutate(task.id, (stored) => {
    f.controller.helpers.event(stored, 'integration.observation', 'CONTROLLED native failure', {
      type: 'TASK_FAILED', actor: 'developer', sourceTaskId: 'native-failed',
      binding: { executionId: stored.execution.id },
    });
  });
  await f.controller.recordNativeFailure(task.id, 'developer', 'native-failed');
  const stopped = await f.controller.store.get(task.id);
  assert.equal(stopped.status, 'failed');
  assert.equal(stopped.execution.phase, 'failed');
  assert.equal(stopped.execution.stopReason, 'permanent_error');
  const reader = await createAuthorityReader({ tasksRoot: f.tasks, taskId: task.id, irixiAppRoot: IRIXI_APP_ROOT });
  const { projection } = await reader.read();
  const binding = {
    taskId: projection.taskId, goalVersionId: projection.goalVersionId, taskInputBindingSha256: projection.taskInputBindingSha256,
    pipelineBindingSha256: projection.pipelineBindingSha256, executionId: projection.execution.id,
    workspaceScopeFingerprint: projection.workspace.scopeFingerprint, sourceSnapshotSha256: projection.workspace.sourceSnapshotSha256,
    artifactId: null, artifactVersion: null, candidateSha256: null, diffSha256: null, authoritySnapshotSha256: projection.authoritySha256,
  };
  await assert.rejects(reader.reserveRun({ actor: 'developer', sourceTaskId: 'native-after-failure', binding, promptSha256: projection.registeredExecution?.promptSha256 }), /not active|already|stopped|current/i);
  await f.controller.startNewRegisteredExecution(task.id, task.goal.activeVersionId);
  const restarted = await f.controller.store.get(task.id);
  assert.notEqual(restarted.execution.id, priorExecutionId);
  assert.equal(restarted.execution.stopReason, null);
  assert.equal(restarted.projectWorkspace.scopeFingerprint, priorScope);
  assert.equal(restarted.projectWorkspace.sourceSnapshotSha256, priorSource);
  assert.notEqual(restarted.integrationExecutionRequest.prompt, priorPrompt);
  assert.equal(restarted.integrationExecutionRequest.executionId, restarted.execution.id);
  assert.equal(restarted.integrationExecutionRequest.prompt.includes(`Irixi execution: ${restarted.execution.id}`), true);
  assert.equal(restarted.status, 'waiting_user');

  await fs.writeFile(path.join(f.toy, 'src/greeting.js'), `export function greeting(name) { const value=String(name).trim(); return value ? \`Hello, \${value}!\` : 'Hello, friend!'; }\n`);
  const checked = await f.controller.hostCheck(task.id);
  assert.equal(checked.passed, true);
  const candidateTask = await f.controller.store.get(task.id);
  const candidateBoard = projectTaskBoard(buildAuthorityProjection(candidateTask, f.controller.helpers), []);
  assert.equal(candidateTask.status, 'waiting_user');
  assert.equal(candidateBoard.status, 'candidate');
  assert.equal(candidateBoard.statusLabel, '固定检查已通过');
  assert.equal(candidateBoard.actor, null);
  const candidateScope = await f.controller.registeredScopeState(task.id);
  assert.equal(candidateScope.registeredExecution, null);
});
