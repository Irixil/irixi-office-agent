import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import {
  nativeActionPayload,
  nativeOfficeWaitingPresentation,
  normalizeNativeCandidate,
  normalizeNativeProductState,
} from '../app/public/native-product-state.js';
import { WORKSPACE_ROOT, checkOmoRuntime, executeDeveloperInWorktree, isRequiredModelRegistered, parseReviewerVerdict, readRelativeFileMap, runIndependentReviewerWithOmo, runOmoPrompt, sha256Buffer, sha256Text } from './omo-harness.mjs';
import { createOmoPilotServer } from './server.mjs';
import { createFakeOmoRoleRunner } from './test-omo-runner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('OmO test entry loads process and network isolation before the suite', () => {
  assert.ok(globalThis.__IRIXI_TEST_ISOLATION__);
  assert.equal(globalThis.__IRIXI_TEST_ISOLATION__.blockedCalls, 0);
});

function createRecordedFakeRoleRunner({ developerEdit = null, reviewerText = 'VERDICT: PASS\nIndependent synthetic review.' } = {}) {
  return async (request) => {
    const reservation = await request.reserve({
      role: request.role, binding: request.binding, idempotencyKey: request.idempotencyKey,
      deadlineAt: request.deadlineAt, promptSha256: sha256Text(request.prompt),
      promptUtf8Bytes: Buffer.byteLength(request.prompt, 'utf8'),
    });
    if (!reservation?.created) return { status: 'reservation_rejected', workCompleted: false, roleCallReserved: false, cliSpawned: false, turnStarted: false };
    await request.recordCliSpawn(reservation);
    await request.recordTurnStarted(reservation);
    if (request.role === 'Developer' && developerEdit) await developerEdit(request);
    const roleText = request.role === 'Reviewer' ? reviewerText
      : request.role === 'Lead' ? '计划\n【当前已做到什么】\n隔离测试执行。\n【离最终目标的偏差与老功能保护】\n仅改授权范围。'
        : `Synthetic ${request.role} result for the isolated test.`;
    const output = { text: roleText };
    const workCompleted = await request.acceptResult(output, { role: request.role, binding: request.binding });
    const outcome = {
      status: workCompleted ? 'model_returned' : 'host_validation_failed', workCompleted,
      roleCallReserved: true, cliSpawned: true, turnStarted: true, providerRequestCount: null,
      output, events: ['turn.started', 'turn.completed'],
    };
    await request.settle(reservation, outcome);
    return outcome;
  };
}

async function dispatchTestHttp(server, method, url, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  req.method = method;
  req.url = url;
  req.headers = { host: '127.0.0.1', 'content-type': 'application/json' };
  return new Promise((resolve, reject) => {
    let status = 200;
    let headers = {};
    const res = {
      writeHead(code, value = {}) { status = code; headers = value; },
      end(chunk) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk || '');
        let json;
        try { json = JSON.parse(buffer.toString('utf8')); } catch {}
        resolve({ status, headers, buffer, json });
      },
    };
    req.on('error', reject);
    server.emit('request', req, res);
  });
}

test('同任务工作交代串行持久化，失败请求不报成功且可安全重送', async (t) => {
  const runtimeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'irixi-instruction-save-'));
  t.after(() => fsp.rm(runtimeDir, { recursive: true, force: true }));
  const { controller, server } = await createOmoPilotServer({ runtimeDir, preferLocalFallback: true });
  const task = await controller.createTask({ title: '指令保存并发夹具', statement: '隔离验证可重送保存' });
  const product = normalizeNativeProductState(await controller.buildProductState(task.id));
  const payload = nativeActionPayload(product, 'instructions', { text: '保留本次实际交代。', requestId: 'instruction-retry-001' });
  const actualPersist = controller.persistMutation.bind(controller);
  let releaseSave;
  let enteredSave;
  const saveGate = new Promise((resolve) => { releaseSave = resolve; });
  const saveStarted = new Promise((resolve) => { enteredSave = resolve; });
  let firstSave = true;
  let saveAttempts = 0;
  controller.persistMutation = async (...args) => {
    saveAttempts += 1;
    if (firstSave) {
      firstSave = false;
      enteredSave();
      await saveGate;
      throw Object.assign(new Error('isolated save rejection'), { statusCode: 503 });
    }
    return actualPersist(...args);
  };

  let firstSettled = false;
  const first = dispatchTestHttp(server, 'POST', `/api/product/tasks/${encodeURIComponent(task.id)}/actions`, payload)
    .finally(() => { firstSettled = true; });
  await saveStarted;
  const second = dispatchTestHttp(server, 'POST', `/api/product/tasks/${encodeURIComponent(task.id)}/actions`, payload);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(firstSettled, false, 'first request cannot answer before durable save completes');
  assert.equal(saveAttempts, 1, 'same request id waits behind the task save lock');
  releaseSave();
  const [failed, retried] = await Promise.all([first, second]);
  assert.equal(failed.status, 503);
  assert.equal(retried.status, 200);
  assert.equal(retried.json.status, 'saved_not_executed');
  assert.equal(saveAttempts, 2);
  const persisted = JSON.parse(await fsp.readFile(path.join(runtimeDir, 'pilot-ledger.json'), 'utf8'));
  const savedTask = persisted.tasks.find((item) => item.id === task.id);
  assert.equal(savedTask.instructions.length, 1);
  assert.equal(savedTask.instructions[0].text, '保留本次实际交代。');
  assert.equal(savedTask.instructionRequests['instruction-retry-001'].instructionId, savedTask.instructions[0].id);

  const replay = await dispatchTestHttp(server, 'POST', `/api/product/tasks/${encodeURIComponent(task.id)}/actions`, payload);
  assert.equal(replay.status, 200);
  assert.equal(replay.json.idempotentReplay, true);
  assert.equal(JSON.parse(await fsp.readFile(path.join(runtimeDir, 'pilot-ledger.json'), 'utf8')).tasks
    .find((item) => item.id === task.id).instructions.length, 1);
  assert.equal(globalThis.__IRIXI_TEST_ISOLATION__?.blockedCalls, 0);
});

test('Lead 计划冻结的指令只传给同计划 Developer，新交代留待后续计划', async (t) => {
  const runtimeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'irixi-plan-instructions-'));
  t.after(() => fsp.rm(runtimeDir, { recursive: true, force: true }));
  let developerInput = null;
  const developerRunner = async (input) => {
    developerInput = input;
    throw new Error('stop after capturing isolated Developer input');
  };
  const { controller, server } = await createOmoPilotServer({ runtimeDir, preferLocalFallback: true, developerRunner });
  const task = await controller.createTask({ title: '计划快照夹具', statement: '检查指令快照的隔离与续接' });
  const project = (await controller.listRegisteredProjects()).find((item) => item.projectId === 'task-list-organizer');
  assert.ok(project);
  task.selectedScope = { projectId: project.projectId, scopeFingerprint: project.scopeFingerprint, goalVersionId: task.goalVersionId, authorized: true, current: true };
  task.setupStatus = null;
  task.registry = { projectId: project.projectId, scopeFingerprint: project.scopeFingerprint, registrySha256: 'registry-plan-snapshot', status: 'registered', current: true, bindingCurrent: true };
  task.execution = {
    id: 'execution-plan-snapshot', phase: 'planned', status: 'waiting_start', bindingCurrent: true,
    deadline: new Date(Date.now() + 10 * 60_000).toISOString(), leadAgentId: 'lead-plan-snapshot', devAgentId: 'dev-plan-snapshot', reviewerAgentId: 'review-plan-snapshot',
    agents: [], modelCalls: [], sessions: [], workItems: [], plan: null, planApprovalStatus: 'not_ready',
  };
  await controller.save();

  const setupProduct = normalizeNativeProductState(await controller.buildProductState(task.id));
  const originalInstruction = nativeActionPayload(setupProduct, 'instructions', { text: '当前计划只纳入这条交代。', requestId: 'instruction-original-001' });
  const savedOriginal = await dispatchTestHttp(server, 'POST', `/api/product/tasks/${encodeURIComponent(task.id)}/actions`, originalInstruction);
  assert.equal(savedOriginal.status, 200);

  const planned = await controller.handleTaskAction(task.id, { action: 'run' });
  assert.ok(planned.planSha256);
  const frozen = structuredClone(task.execution.plan.instructionSnapshot);
  assert.deepEqual(frozen.instructions.map((item) => item.text), ['当前计划只纳入这条交代。']);
  assert.match(frozen.sha256, /^[a-f0-9]{64}$/u);

  const beforeInstruction = normalizeNativeProductState(await controller.buildProductState(task.id));
  const add = nativeActionPayload(beforeInstruction, 'instructions', { text: '这条只供后续新计划使用。', requestId: 'instruction-future-001' });
  const added = await dispatchTestHttp(server, 'POST', `/api/product/tasks/${encodeURIComponent(task.id)}/actions`, add);
  assert.equal(added.status, 200);
  assert.deepEqual(task.execution.plan.instructionSnapshot, frozen);

  const current = normalizeNativeProductState(await controller.buildProductState(task.id));
  const approve = nativeActionPayload(current, 'approve_plan');
  const result = await dispatchTestHttp(server, 'POST', `/api/product/tasks/${encodeURIComponent(task.id)}/actions`, approve);
  assert.equal(result.status, 400, 'the injected runner stops before any process or model call');
  assert.ok(developerInput);
  assert.deepEqual(developerInput.instructions.map((item) => item.text), ['当前计划只纳入这条交代。']);
  assert.equal(developerInput.instructionSnapshotSha256, frozen.sha256);
  assert.equal(task.execution.modelCalls.length, 1, 'only the isolated deterministic Lead bookkeeping record exists');
  assert.equal(task.artifacts.length, 0);
  assert.equal(globalThis.__IRIXI_TEST_ISOLATION__?.blockedCalls, 0);
});

test('同项目同范围的新执行只续接已结算旧执行中的同源工作交代', async (t) => {
  const runtimeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'irixi-next-execution-instructions-'));
  t.after(() => fsp.rm(runtimeDir, { recursive: true, force: true }));
  const { controller, server } = await createOmoPilotServer({ runtimeDir, preferLocalFallback: true });
  const task = await controller.createTask({ title: '后续执行交代夹具', statement: '延续同项目范围下的后续工作' });
  const project = (await controller.listRegisteredProjects()).find((item) => item.projectId === 'task-list-organizer');
  assert.ok(project);
  task.selectedScope = { projectId: project.projectId, scopeFingerprint: project.scopeFingerprint, goalVersionId: task.goalVersionId, authorized: true, current: true };
  task.setupStatus = null;
  await controller.handleTaskAction(task.id, { action: 'prepare_run' });
  const sourceExecutionId = task.execution.id;
  const oldRegistry = structuredClone(task.registry);
  const candidate = 'c'.repeat(64);
  const diff = 'd'.repeat(64);
  task.artifacts.push({ id: 'artifact-stable-source', version: 1, goalVersionId: task.goalVersionId,
    executionId: sourceExecutionId, registrySha256: oldRegistry.registrySha256, candidateSha256: candidate,
    diffSha256: diff, patch: '', patchSha256: diff, files: [], hostCheck: { passed: false, checks: [] }, review: null, confirmation: null });
  task.activeArtifactId = 'artifact-stable-source';
  task.execution.phase = 'completed';
  task.execution.modelCalls = [];
  task.execution.sessions = [];
  const oldExecution = structuredClone(task.execution);
  await controller.save();

  const priorProduct = normalizeNativeProductState(await controller.buildProductState(task.id));
  const priorInput = nativeActionPayload(priorProduct, 'instructions', { text: '下一轮继续整理任务索引。', requestId: 'instruction-next-execution-001' });
  const saved = await dispatchTestHttp(server, 'POST', `/api/product/tasks/${encodeURIComponent(task.id)}/actions`, priorInput);
  assert.equal(saved.status, 200);
  const oldInstruction = task.instructions[0];
  assert.equal(oldInstruction.binding.executionId, oldExecution.id);

  await controller.handleTaskAction(task.id, { action: 'prepare_run', mode: 'new_execution' });
  assert.notEqual(task.execution.id, oldExecution.id);
  assert.deepEqual(task.executionHistory.at(-1).execution, oldExecution);
  assert.equal(task.activeArtifactId, 'artifact-stable-source');
  const nextPlan = await controller.handleTaskAction(task.id, { action: 'run' });
  assert.ok(nextPlan.planSha256);
  assert.deepEqual(task.execution.plan.instructionSnapshot.instructions.map((item) => item.id), [oldInstruction.id]);
  assert.deepEqual(task.execution.plan.instructionSnapshot.instructions.map((item) => item.text), ['下一轮继续整理任务索引。']);
  assert.equal(task.execution.plan.instructionSnapshot.artifact.id, 'artifact-stable-source');
  assert.equal(task.execution.plan.instructionSnapshot.projectId, project.projectId);
  assert.equal(task.execution.plan.instructionSnapshot.scopeFingerprint, project.scopeFingerprint);
  assert.deepEqual(task.executionHistory.at(-1).execution, oldExecution, 'the prior approved execution remains unchanged');
  assert.equal(globalThis.__IRIXI_TEST_ISOLATION__?.blockedCalls, 0);
});

async function makeConfirmationFixture(t) {
  const runtimeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'irixi-confirm-delivery-'));
  t.after(() => fsp.rm(runtimeDir, { recursive: true, force: true }));
  const fakeRunner = createRecordedFakeRoleRunner();
  const { controller, server } = await createOmoPilotServer({ runtimeDir, preferLocalFallback: false, codexRoleRunner: fakeRunner });
  assert.equal(controller.codexRoleRunner, fakeRunner, 'confirmation fixture must fail closed to the injected runner');
  const worktreePath = path.join(runtimeDir, 'worktree');
  await fsp.mkdir(worktreePath);
  const content = '<!doctype html><title>frozen candidate</title>\n';
  await fsp.writeFile(path.join(worktreePath, 'index.html'), content);
  const file = { path: 'index.html', bytes: Buffer.byteLength(content), sha256: sha256Buffer(Buffer.from(content)) };
  const candidateSha256 = sha256Text(`${file.path}:${file.sha256}`);
  const patch = 'diff --git a/index.html b/index.html\n+frozen candidate\n';
  const task = {
    id: 'task-confirm-fixture', title: 'confirm fixture', statement: 'frozen delivery',
    goalVersionId: 'goal-confirm-fixture', goalVersions: [{ id: 'goal-confirm-fixture' }],
    selectedScope: { projectId: 'fixture-project', scopeFingerprint: 'scope-fixture', goalVersionId: 'goal-confirm-fixture', current: true, authorized: true },
    execution: { id: 'run-confirm-fixture', bindingCurrent: true, phase: 'completed', deadline: new Date(Date.now() + 60_000).toISOString(), modelCalls: [], sessions: [] },
    registry: { registrySha256: 'registry-confirm-fixture', projectId: 'fixture-project', scopeFingerprint: 'scope-fixture', current: true, bindingCurrent: true, status: 'registered' },
    artifacts: [], activeArtifactId: 'artifact-confirm-fixture',
  };
  task.artifacts.push({
    id: task.activeArtifactId, version: 1, goalVersionId: task.goalVersionId, executionId: task.execution.id,
    registrySha256: task.registry.registrySha256, worktreePath, candidateSha256, diffSha256: sha256Text(patch),
    patchSha256: sha256Text(patch), patch, files: [file],
    hostCheck: { passed: true, checks: [{ id: 'syntax', passed: true }, { id: 'scope', passed: true }] },
    review: null,
    confirmation: null,
  });
  controller.state.tasks.push(task);
  controller.state.activeTaskId = task.id;
  const reviewWorkItemId = 'work-review-confirm-fixture';
  const reviewResult = await controller.runCodexProductRole(task, {
    role: 'Reviewer', workItemId: reviewWorkItemId, phase: 'review', prompt: 'Review the exact fixture candidate.',
    artifact: task.artifacts[0], expectedBinding: {
      taskId: task.id, goalVersionId: task.goalVersionId, executionId: task.execution.id,
      registrySha256: task.registry.registrySha256, workItemId: reviewWorkItemId,
      artifactId: task.artifacts[0].id, candidateSha256: task.artifacts[0].candidateSha256,
      diffSha256: task.artifacts[0].diffSha256,
    },
  });
  const reviewText = reviewResult.output.text.trim();
  task.artifacts[0].review = {
    id: 'review-confirm-fixture', passed: true, nativeVerdict: 'PASS', scopeOutcome: 'clean',
    text: reviewText, fullOutputSha256: sha256Text(reviewText),
    sourceEvidence: {
      taskId: task.id, goalVersionId: task.goalVersionId, executionId: task.execution.id,
      registrySha256: task.registry.registrySha256, artifactId: task.artifacts[0].id,
      artifactVersion: task.artifacts[0].version, scopeFingerprint: task.selectedScope.scopeFingerprint,
      candidateSha256: task.artifacts[0].candidateSha256,
      diffSha256: task.artifacts[0].diffSha256,
      sourceCallId: reviewResult.sourceCallId, sourceCallOutputSha256: reviewResult.sourceCallOutputSha256,
      reportSha256: sha256Text(reviewText),
    },
  };
  task.execution.modelCalls.find((call) => call.id === reviewResult.sourceCallId).reviewAdoption = {
    reviewId: task.artifacts[0].review.id, reviewedAt: task.artifacts[0].review.reviewedAt,
    reportSha256: task.artifacts[0].review.fullOutputSha256, diffSha256: task.artifacts[0].diffSha256,
  };
  const body = {
    artifactId: task.activeArtifactId, version: 1, expectedTaskId: task.id,
    expectedGoalVersionId: task.goalVersionId, expectedExecutionId: task.execution.id,
    expectedRegistrySha256: task.registry.registrySha256, expectedCandidateSha256: candidateSha256,
    expectedDiffSha256: task.artifacts[0].diffSha256,
    expectedReviewId: task.artifacts[0].review.id,
    expectedReviewFullOutputSha256: task.artifacts[0].review.fullOutputSha256,
  };
  async function setReview(text) {
    const reviewWorkItemId = `work-review-fixture-${task.execution.modelCalls.length}`;
    controller.codexRoleRunner = createRecordedFakeRoleRunner({ reviewerText: text });
    const result = await controller.runCodexProductRole(task, {
      role: 'Reviewer', workItemId: reviewWorkItemId, phase: 'review', prompt: `Review the exact candidate and return: ${text}`,
      artifact: task.artifacts[0], expectedBinding: {
        taskId: task.id, goalVersionId: task.goalVersionId, executionId: task.execution.id,
        registrySha256: task.registry.registrySha256, workItemId: reviewWorkItemId,
        artifactId: task.artifacts[0].id, candidateSha256: task.artifacts[0].candidateSha256,
        diffSha256: task.artifacts[0].diffSha256,
      },
    });
    const report = result.output.text.trim();
    const verdict = report.split(/\r?\n/u)[0];
    const currentReview = task.artifacts[0].review = {
      id: `review-confirm-fixture-${task.execution.modelCalls.length}`,
      passed: verdict === 'VERDICT: PASS',
      nativeVerdict: verdict === 'VERDICT: PASS' ? 'PASS' : verdict === 'VERDICT: FAIL' ? 'FAIL' : 'UNVERIFIED',
      scopeOutcome: verdict === 'VERDICT: PASS' ? 'clean' : verdict === 'VERDICT: FAIL' ? 'findings' : 'unverified',
      text: report, fullOutputSha256: sha256Text(report),
      sourceEvidence: {
        taskId: task.id, goalVersionId: task.goalVersionId, executionId: task.execution.id,
        registrySha256: task.registry.registrySha256, artifactId: task.artifacts[0].id,
        artifactVersion: task.artifacts[0].version, scopeFingerprint: task.selectedScope.scopeFingerprint,
        candidateSha256: task.artifacts[0].candidateSha256,
        diffSha256: task.artifacts[0].diffSha256,
        sourceCallId: result.sourceCallId, sourceCallOutputSha256: result.sourceCallOutputSha256,
        reportSha256: sha256Text(report),
      },
    };
    task.execution.modelCalls.find((call) => call.id === result.sourceCallId).reviewAdoption = {
      reviewId: currentReview.id, reviewedAt: currentReview.reviewedAt,
      reportSha256: currentReview.fullOutputSha256, diffSha256: task.artifacts[0].diffSha256,
    };
    body.expectedReviewId = currentReview.id;
    body.expectedReviewFullOutputSha256 = currentReview.fullOutputSha256;
    body.expectedDiffSha256 = task.artifacts[0].diffSha256;
    return currentReview;
  }
  return { controller, server, task, artifact: task.artifacts[0], body, content, setReview,
    request: (method, url, payload) => dispatchTestHttp(server, method, url, payload) };
}

test('OmO runtime is an external prerequisite and is omitted from the public snapshot', () => {
  const runtime = checkOmoRuntime();
  assert.equal(runtime.available, false, 'The public source snapshot intentionally excludes the OmO runtime installation.');
  assert.equal(fs.existsSync(path.join(WORKSPACE_ROOT, '.irixi-runtime', 'omo')), false,
    'The private OmO installation must remain outside the public source snapshot.');
});

test('OmO recognizes a registered 6Luna model but does not infer that a connection is verified', () => {
  assert.equal(isRequiredModelRegistered(
    { defaultProvider: 'deepseek', defaultModel: 'deepseek-v4-pro' },
    { deepseek: ['deepseek-v4-pro'] },
  ), false);
  assert.equal(isRequiredModelRegistered(
    { defaultProvider: 'chatgpt-subscription', defaultModel: 'gpt-6-luna' },
    { 'chatgpt-subscription': ['gpt-6-luna'] },
  ), true);
  assert.equal(checkOmoRuntime().modelRegistered, false, 'current local model registry has no 6Luna entry');
  assert.equal(checkOmoRuntime().connectionStatus, 'unverified', 'no native non-sensitive connection status was available');
  assert.equal(checkOmoRuntime().liveExecutionBlocked, true);
});

test('Reviewer output without a sole explicit first-line verdict is unverified, never PASS', () => {
  assert.equal(parseReviewerVerdict('VERDICT: PASS\nDetails'), 'PASS');
  assert.equal(parseReviewerVerdict('VERDICT: FAIL\nDetails'), 'FAIL');
  assert.equal(parseReviewerVerdict('The result looks good.\nVERDICT: PASS'), 'UNVERIFIED');
  assert.equal(parseReviewerVerdict('VERDICT: PASS\nVERDICT: FAIL'), 'UNVERIFIED');
  assert.equal(parseReviewerVerdict(''), 'UNVERIFIED');
});

test('Live OmO call fails before spawning when 6Luna is not registered locally', async () => {
  const runtime = checkOmoRuntime();
  if (runtime.modelRegistered && runtime.connectionStatus === 'verified') return;
  await assert.rejects(
    runOmoPrompt({ prompt: 'must not spawn', cwd: WORKSPACE_ROOT }),
    (error) => error.code === 'OMO_REQUIRED_MODEL_NOT_CONFIGURED' && error.message.includes('gpt-6-luna'),
  );
});

test('Current OmO action records pre-reservation OmO failure without creating a model-call reservation', async (t) => {
  const runtimeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'irixi-test-adapter-rejection-'));
  t.after(() => fsp.rm(runtimeDir, { recursive: true, force: true }));
  const { controller } = await createOmoPilotServer({
    runtimeDir,
    omoRoleRunner: createFakeOmoRoleRunner(),
    codexRoleRunner: async () => {
      throw Object.assign(new Error('synthetic model unavailable'), { code: 'OMO_REQUIRED_MODEL_NOT_CONFIGURED', statusCode: 503 });
    },
  });
  const project = (await controller.listRegisteredProjects()).find((entry) => entry.projectId === 'task-list-organizer');
  assert.ok(project, 'the model-gate test must reach the registered-project execution path');
  const task = {
    id: 'task-model-gate-test', title: 'synthetic', statement: 'test', goalVersionId: 'goal-model-gate-test',
    successCriteria: [], boundaries: [], instructions: [], rejectionHistory: [], artifacts: [],
    selectedScope: { projectId: project.projectId, scopeFingerprint: project.scopeFingerprint, goalVersionId: 'goal-model-gate-test', current: true, authorized: true },
    registry: { projectId: project.projectId, scopeFingerprint: project.scopeFingerprint, registrySha256: 'registry-model-gate-test', current: true, bindingCurrent: true, status: 'registered' },
    execution: { id: 'run-model-gate-test', phase: 'planned', modelCalls: [], deadline: new Date(Date.now() + 60_000).toISOString(), leadAgentId: 'lead-model-gate-test', sessions: [] },
  };
  controller.state.tasks.push(task);
  await assert.rejects(controller.handleTaskAction(task.id, { action: 'run' }), (error) => error.code === 'OMO_REQUIRED_MODEL_NOT_CONFIGURED' && error.statusCode === 503);
  assert.deepEqual(task.execution.modelCalls, [], 'a rejection before reservation must not create a model-call ledger entry');
  assert.equal(task.execution.plan, undefined, 'a rejected Lead call must not create a plan');
  assert.equal(task.execution.planInProgress, false, 'the transient planning lock must be released');
  assert.equal(task.execution.phase, 'partial');
  assert.equal(task.execution.stopReason, 'omo_role_session_failed');
  assert.equal(task.execution.lastPlanInputSnapshot?.failedAt != null, true, 'the failed input snapshot is retained for diagnosis');
  assert.equal(task.execution.omoSessions.at(-1)?.status, 'failed');
});

test('OmO result without a native session ID is retained as failed metadata, never adopted as session proof', async (t) => {
  const runtimeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'irixi-omo-unknown-session-'));
  t.after(() => fsp.rm(runtimeDir, { recursive: true, force: true }));
  const { controller } = await createOmoPilotServer({
    runtimeDir,
    omoRoleRunner: async () => ({
      status: 'model_returned', output: { text: 'synthetic settled result' }, sessionId: null,
      provider: 'irixi-codex-bridge', model: 'gpt-6-luna', providerDecisionRequests: 1,
    }),
  });
  const task = {
    id: 'task-unknown-native-session', goalVersionId: 'goal-unknown-native-session',
    registry: { registrySha256: 'registry-unknown-native-session', projectId: 'project-fixture', scopeFingerprint: 'scope-fixture' },
    selectedScope: { current: true, authorized: true, projectId: 'project-fixture', scopeFingerprint: 'scope-fixture', goalVersionId: 'goal-unknown-native-session' },
    artifacts: [],
    execution: {
      id: 'run-unknown-native-session', deadline: new Date(Date.now() + 60_000).toISOString(),
      phase: 'executing', modelCalls: [], sessions: [], workItems: [],
    },
  };
  controller.state.tasks.push(task);
  await assert.rejects(controller.runOmoCodexProductRole(task, {
    role: 'Reviewer', workItemId: 'work-review-fixture', phase: 'review', prompt: 'Synthetic read-only review.',
  }), (error) => error.code === 'OMO_NATIVE_SESSION_ID_UNKNOWN');
  assert.equal(task.execution.omoSessions.length, 1);
  assert.equal(task.execution.omoSessions[0].nativeSessionId, null);
  assert.equal(task.execution.omoSessions[0].status, 'failed');
  assert.ok(task.execution.omoSessions[0].hostJobId);
  assert.notEqual(task.execution.omoSessions[0].id, task.execution.omoSessions[0].nativeSessionId);
});

test('Developer receives the registered worktree as current directory and must use relative paths', async (t) => {
  const worktreePath = await fsp.mkdtemp(path.join(os.tmpdir(), 'irixi-developer-cwd-'));
  t.after(() => fsp.rm(worktreePath, { recursive: true, force: true }));
  await fsp.writeFile(path.join(worktreePath, 'app.js'), 'const original = true;\n');
  const sourceFilesMap = await readRelativeFileMap(worktreePath);
  const captured = [];
  const require = createRequire(import.meta.url);
  const childProcess = require('node:child_process');
  const guardedSpawn = childProcess.spawn;
  let syntaxCheckInvocations = 0;
  childProcess.spawn = (executable, args) => {
    syntaxCheckInvocations += 1;
    assert.equal(executable, process.execPath);
    assert.deepEqual(args.slice(0, 1), ['--check']);
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    void fsp.readFile(args[1], 'utf8').then((source) => {
      const invalid = source.includes('const = ;');
      if (invalid) child.stderr.emit('data', Buffer.from('synthetic syntax error'));
      child.emit('close', invalid ? 1 : 0);
    });
    return child;
  };
  syncBuiltinESMExports();
  let result;
  try {
    result = await executeDeveloperInWorktree({
    task: { statement: 'fixture goal', successCriteria: [], boundaries: [] },
    project: { allowedWritePaths: ['app.js'] },
    worktreePath,
    sourceFilesMap,
    planText: 'fixture plan',
    runRole: async (request) => {
      captured.push(request);
      await fsp.writeFile(path.join(worktreePath, 'app.js'), captured.length === 1 ? 'const = ;\n' : 'const repaired = true;\n');
      return { status: 'model_returned', output: { text: 'fixture' }, sessionId: `fixture-session-${captured.length}` };
    },
    });
  } finally {
    childProcess.spawn = guardedSpawn;
    syncBuiltinESMExports();
  }
  assert.equal(captured.length, 2, 'the fixture must exercise the normal and syntax-repair prompt paths');
  assert.equal(captured[0].workspacePath, worktreePath);
  assert.equal(captured[1].workspacePath, worktreePath);
  assert.match(captured[0].prompt, /当前目录就是本次已登记的隔离工作树根目录/u);
  assert.match(captured[0].prompt, /只使用相对于当前目录的路径/u);
  assert.match(captured[0].prompt, /不得按任务名拼接工作树目录/u);
  assert.match(captured[0].prompt, /文件工具由当前 OmO 会话在登记工作树中执行/u);
  assert.match(captured[0].prompt, /Codex 调用只按 OmO 提供的工具合同返回决策，不直接访问或修改文件/u);
  assert.doesNotMatch(captured[0].prompt, /workspace-write 沙箱/u);
  assert.match(captured[1].prompt, /所有文件工具只用当前目录下的相对路径/u);
  assert.match(captured[1].prompt, /由宿主重跑固定检查，包括 node --check/u);
  assert.match(captured[1].prompt, /不要尝试运行 shell/u);
  assert.match(captured[1].prompt, /请使用当前 OmO 会话提供的文件工具只修复授权文件/u);
  assert.doesNotMatch(captured[1].prompt, /请使用 Codex 工具/u);
  assert.doesNotMatch(captured[1].prompt, /工作树绝对路径/u);
  const escapedRoot = worktreePath.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  assert.ok(captured.every((request) => !new RegExp(escapedRoot, 'u').test(request.prompt)));
  assert.equal(result.checkResult.passed, true, 'the isolated syntax repair should pass fixed Host checks');
  assert.equal(syntaxCheckInvocations, 3, 'the explicit fake handles the original check, repair check, and final check');
  assert.equal(globalThis.__IRIXI_TEST_ISOLATION__.blockedCalls, 0, 'no real process was attempted');
});

test('settled OmO role-session failure is terminal and projected without inventing a failed model call', async (t) => {
  const runtimeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'irixi-omo-session-failure-'));
  t.after(() => fsp.rm(runtimeDir, { recursive: true, force: true }));
  const { controller } = await createOmoPilotServer({
    runtimeDir,
    codexRoleRunner: createRecordedFakeRoleRunner(),
    omoRoleRunner: async ({ runModelDecision, cwd }) => {
      assert.equal(cwd, path.join(runtimeDir, 'worktree'));
      await runModelDecision({ messages: [], tools: [] }, 0);
      throw new Error('native tool path rejected: /tmp/sensitive-location');
    },
  });
  const task = {
    id: 'task-omo-session-failure-fixture', title: 'session failure fixture', statement: 'fixture goal', successCriteria: [], boundaries: [],
    goalVersionId: 'goal-omo-session-failure-fixture', functionId: 'utility', activeArtifactId: null, artifacts: [],
    selectedScope: { projectId: 'project-fixture', scopeFingerprint: 'scope-fixture', goalVersionId: 'goal-omo-session-failure-fixture', authorized: true, current: true },
    registry: { projectId: 'project-fixture', scopeFingerprint: 'scope-fixture', registrySha256: 'registry-omo-session-failure-fixture', status: 'registered' },
    execution: { id: 'run-omo-session-failure-fixture', phase: 'executing', status: 'running', planApprovalStatus: 'saved',
      plan: { text: 'fixture plan' }, deadline: new Date(Date.now() + 60_000).toISOString(), modelCalls: [], sessions: [], workItems: [
        { id: 'work-dev-run-omo-session-failure-fixture', status: 'running' },
      ], agents: [] },
    conversations: [], memoryEntries: [], instructions: [], rejectionHistory: [],
  };
  controller.state.tasks.push(task);
  controller.state.activeTaskId = task.id;
  const binding = {
    taskId: task.id, goalVersionId: task.goalVersionId, executionId: task.execution.id,
    registrySha256: task.registry.registrySha256, workItemId: 'work-dev-run-omo-session-failure-fixture',
    artifactId: null, candidateSha256: null, diffSha256: null,
  };
  await assert.rejects(controller.runOmoCodexProductRole(task, {
    role: 'Developer', workItemId: binding.workItemId, phase: 'implementation', prompt: 'fixture',
    workspacePath: path.join(runtimeDir, 'worktree'), project: { allowedWritePaths: ['app.js'] }, expectedBinding: binding,
  }), /native tool path rejected/u);
  assert.equal(task.execution.modelCalls.length, 1);
  assert.equal(task.execution.modelCalls[0].status, 'completed', 'the model returned; do not rewrite its call ledger as failed');
  assert.equal(task.execution.phase, 'partial');
  assert.equal(task.execution.status, 'waiting_user');
  assert.equal(task.execution.stopReason, 'omo_role_session_failed');
  assert.equal(task.execution.omoSessions.at(-1).status, 'failed');
  assert.doesNotMatch(task.execution.failureReason, /sensitive-location/u);
  assert.equal(task.execution.workItems[0].status, 'failed');
  const product = await controller.buildProductState(task.id);
  assert.equal(product.status, 'failed');
  assert.equal(product.taskLifecycle.status, 'failed');
  assert.match(product.nextStep, /0 次业务调用失败；另有 1 个原生角色会话未完成/u);
  assert.match(product.nextStep, /路径已隐藏/u);
  assert.equal(product.native.actions.canRun, false);
});

test('model_returned without non-empty output is recorded as a failed terminal OmO session', async (t) => {
  const runtimeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'irixi-omo-empty-output-'));
  t.after(() => fsp.rm(runtimeDir, { recursive: true, force: true }));
  const { controller } = await createOmoPilotServer({
    runtimeDir,
    codexRoleRunner: createRecordedFakeRoleRunner(),
    omoRoleRunner: async ({ runModelDecision }) => {
      await runModelDecision({ messages: [], tools: [] }, 0);
      return { status: 'model_returned', output: { text: '' }, sessionId: 'synthetic-empty-session' };
    },
  });
  const task = {
    id: 'task-omo-empty-output-fixture', title: 'empty output fixture', statement: 'fixture goal', successCriteria: [], boundaries: [],
    goalVersionId: 'goal-omo-empty-output-fixture', functionId: 'utility', activeArtifactId: null, artifacts: [],
    selectedScope: { projectId: 'project-fixture', scopeFingerprint: 'scope-fixture', goalVersionId: 'goal-omo-empty-output-fixture', authorized: true, current: true },
    registry: { projectId: 'project-fixture', scopeFingerprint: 'scope-fixture', registrySha256: 'registry-omo-empty-output-fixture', status: 'registered' },
    execution: { id: 'run-omo-empty-output-fixture', phase: 'executing', status: 'running', planApprovalStatus: 'saved',
      plan: { text: 'fixture plan' }, deadline: new Date(Date.now() + 60_000).toISOString(), modelCalls: [], sessions: [], workItems: [], agents: [] },
    conversations: [], memoryEntries: [], instructions: [], rejectionHistory: [],
  };
  controller.state.tasks.push(task);
  const binding = {
    taskId: task.id, goalVersionId: task.goalVersionId, executionId: task.execution.id,
    registrySha256: task.registry.registrySha256, workItemId: `work-dev-${task.execution.id}`,
    artifactId: null, candidateSha256: null, diffSha256: null,
  };
  await assert.rejects(controller.runOmoCodexProductRole(task, {
    role: 'Developer', workItemId: binding.workItemId, phase: 'implementation', prompt: 'fixture',
    workspacePath: path.join(runtimeDir, 'worktree'), project: { allowedWritePaths: ['app.js'] }, expectedBinding: binding,
  }), /settled assistant response/u);
  assert.equal(task.execution.modelCalls.length, 1);
  assert.equal(task.execution.modelCalls[0].status, 'completed');
  assert.equal(task.execution.omoSessions.at(-1).status, 'failed');
  assert.match(task.execution.omoSessions.at(-1).failureReason, /没有形成可用结果|assistant response/u);
  assert.equal(task.execution.phase, 'partial');
  assert.equal(task.execution.stopReason, 'omo_role_session_failed');
});

test('legacy OmO session failure is read-only projected as stopped when model calls are settled', async (t) => {
  const runtimeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'irixi-omo-legacy-failure-'));
  t.after(() => fsp.rm(runtimeDir, { recursive: true, force: true }));
  const { controller } = await createOmoPilotServer({ runtimeDir, preferLocalFallback: true });
  const project = (await controller.listRegisteredProjects()).find((entry) => entry.projectId === 'task-list-organizer');
  const task = {
    id: 'task-omo-legacy-failure-fixture', title: 'legacy failure fixture', statement: 'fixture goal', successCriteria: [], boundaries: [],
    goalVersionId: 'goal-omo-legacy-failure-fixture', functionId: 'utility', activeArtifactId: null, artifacts: [],
    selectedScope: { projectId: project.projectId, scopeFingerprint: project.scopeFingerprint, goalVersionId: 'goal-omo-legacy-failure-fixture', authorized: true, current: true },
    registry: { projectId: project.projectId, scopeFingerprint: project.scopeFingerprint, registrySha256: 'registry-omo-legacy-failure-fixture', status: 'registered' },
    execution: { id: 'run-omo-legacy-failure-fixture', phase: 'executing', status: 'waiting_user', deadline: new Date(Date.now() + 60_000).toISOString(),
      modelCalls: [{ role: 'Lead', status: 'completed' }, { role: 'Developer', status: 'completed' }], sessions: [], omoSessions: [
        { role: 'Developer', workItemId: 'work-dev-fixture', status: 'failed', failureReason: null,
          binding: { taskId: 'task-omo-legacy-failure-fixture', goalVersionId: 'goal-omo-legacy-failure-fixture',
            executionId: 'run-omo-legacy-failure-fixture', registrySha256: 'registry-omo-legacy-failure-fixture' } },
      ], workItems: [], agents: [], plan: { text: 'plan retained' }, planApprovalStatus: 'saved' },
    conversations: [], memoryEntries: [], instructions: [], rejectionHistory: [],
  };
  controller.state.tasks.push(task);
  const product = await controller.buildProductState(task.id);
  assert.equal(product.status, 'failed');
  assert.equal(product.execution.phase, 'partial', 'legacy stale execution is projected as stopped without mutating its ledger');
  assert.equal(product.execution.stopReason, 'settled_role_failure');
  assert.match(product.nextStep, /另有 1 个原生角色会话未完成/u);
  assert.match(product.nextStep, /历史记录未保存失败原因/u);
  assert.equal(product.native.actions.canRun, false);
  assert.equal(task.execution.phase, 'executing');
});

test('failed OmO session from a different execution cannot stop the current execution projection', async (t) => {
  const runtimeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'irixi-omo-foreign-session-'));
  t.after(() => fsp.rm(runtimeDir, { recursive: true, force: true }));
  const { controller } = await createOmoPilotServer({ runtimeDir, preferLocalFallback: true });
  const project = (await controller.listRegisteredProjects()).find((entry) => entry.projectId === 'task-list-organizer');
  const task = {
    id: 'task-omo-foreign-session-fixture', title: 'foreign session fixture', statement: 'fixture goal', successCriteria: [], boundaries: [],
    goalVersionId: 'goal-omo-foreign-session-fixture', functionId: 'utility', activeArtifactId: null, artifacts: [],
    selectedScope: { projectId: project.projectId, scopeFingerprint: project.scopeFingerprint, goalVersionId: 'goal-omo-foreign-session-fixture', authorized: true, current: true },
    registry: { projectId: project.projectId, scopeFingerprint: project.scopeFingerprint, registrySha256: 'registry-omo-foreign-session-fixture', status: 'registered' },
    execution: { id: 'run-omo-foreign-session-current', phase: 'executing', status: 'running', deadline: new Date(Date.now() + 60_000).toISOString(),
      modelCalls: [{ role: 'Lead', status: 'completed' }, { role: 'Developer', status: 'completed' }], sessions: [], omoSessions: [
        { role: 'Developer', workItemId: 'work-dev-old', status: 'failed', failureReason: 'old failure', binding: {
          taskId: 'task-omo-foreign-session-fixture', goalVersionId: 'goal-omo-foreign-session-fixture',
          executionId: 'run-omo-foreign-session-old', registrySha256: 'registry-omo-foreign-session-fixture',
        } },
        { role: 'Chat', workItemId: 'work-chat-current', status: 'failed', failureReason: 'chat failure', binding: {
          taskId: 'task-omo-foreign-session-fixture', goalVersionId: 'goal-omo-foreign-session-fixture',
          executionId: 'run-omo-foreign-session-current', registrySha256: 'registry-omo-foreign-session-fixture',
        } },
      ], workItems: [], agents: [], plan: { text: 'plan retained' }, planApprovalStatus: 'saved' },
    conversations: [], memoryEntries: [], instructions: [], rejectionHistory: [],
  };
  controller.state.tasks.push(task);
  const product = await controller.buildProductState(task.id);
  assert.equal(product.status, 'idle');
  assert.equal(product.execution.phase, 'executing');
  assert.equal(product.execution.stopReason, null);
  assert.doesNotMatch(product.nextStep, /本轮已停止|会话未完成/u);
  assert.equal(task.execution.omoSessions[0].status, 'failed', 'historical session remains untouched');
});

test('Reviewer is unverified when Host checks fail and keeps the supplied role adapter when its call is unavailable', async (t) => {
  const content = '<!doctype html>\n' + 'x'.repeat(40);
  const fileSha256 = sha256Buffer(Buffer.from(content));
  const candidateSha256 = sha256Text(`index.html:${fileSha256}`);
  const reviewSource = await fsp.mkdtemp(path.join(os.tmpdir(), 'irixi-review-source-'));
  await fsp.writeFile(path.join(reviewSource, 'index.html'), content);
  t.after(() => fsp.rm(reviewSource, { recursive: true, force: true }));
  const common = {
    task: { title: 'synthetic', goalVersionId: 'goal-test', statement: 'test', successCriteria: [], boundaries: [] },
    project: { allowedWritePaths: ['index.html'] },
    worktreePath: reviewSource,
    candidateSha256,
    diffSha256: sha256Text('synthetic patch'),
    patchText: 'synthetic patch',
    changedFiles: [{ path: 'index.html', bytes: 12 }],
    candidateFilesMap: { 'index.html': { path: 'index.html', bytes: Buffer.byteLength(content), sha256: fileSha256, content } },
  };
  const skipped = await runIndependentReviewerWithOmo({
    ...common,
    checks: [{ status: 'failed', name: 'synthetic check', summary: 'expected failure' }],
  });
  assert.equal(skipped.nativeVerdict, 'UNVERIFIED');
  assert.match(skipped.summary, /未运行/);

  if (checkOmoRuntime().modelRegistered && checkOmoRuntime().connectionStatus === 'verified') return t.skip('A configured 6Luna connection must never be exercised by this test.');
  await assert.rejects(
    runIndependentReviewerWithOmo({
      ...common,
      checks: [{ status: 'passed', name: 'synthetic check', summary: 'passed' }],
      runRole: ({ prompt }) => runOmoPrompt({ prompt, cwd: WORKSPACE_ROOT, noTools: true, readOnly: true }),
    }),
    (error) => error.code === 'OMO_REQUIRED_MODEL_NOT_CONFIGURED',
  );
});

test('Reviewer receives the bound read-only manifest, full diff file, and copied candidate workspace', async (t) => {
  const tailMarker = 'CANDIDATE_TAIL_MARKER_8d42a1';
  const content = '<!doctype html>\n' + 'x'.repeat(16_000) + `\n${tailMarker}\n`;
  const fileSha256 = sha256Buffer(Buffer.from(content));
  const candidateSha256 = sha256Text(`src/app.js:${fileSha256}`);
  const diffText = `${'diff '.repeat(3_000)}\nFULL_DIFF_TAIL_MARKER_9c12fe`;
  const diffTail = 'FULL_DIFF_TAIL_MARKER_9c12fe';
  let capturedPrompt = '';
  let capturedWorkspace = '';
  const sourceRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'irixi-review-source-'));
  await fsp.mkdir(path.join(sourceRoot, 'src'));
  await fsp.writeFile(path.join(sourceRoot, 'src/app.js'), content);
  t.after(() => fsp.rm(sourceRoot, { recursive: true, force: true }));
  const result = await runIndependentReviewerWithOmo({
    task: { title: 'synthetic review', goalVersionId: 'goal-tail', statement: 'review full candidate', successCriteria: [], boundaries: [] },
    project: { allowedWritePaths: ['src/app.js'] },
    worktreePath: sourceRoot,
    candidateSha256,
    diffSha256: sha256Text(diffText),
    patchText: diffText,
    artifactId: 'artifact-bound-review', artifactVersion: 7,
    changedFiles: [{ path: 'src/app.js', bytes: Buffer.byteLength(content), sha256: fileSha256 }],
    candidateFilesMap: { 'src/app.js': { path: 'src/app.js', bytes: Buffer.byteLength(content), sha256: fileSha256, content } },
    checks: [{ status: 'passed', name: 'synthetic host check', summary: 'passed' }],
    runRole: async ({ prompt, workspacePath }) => {
      capturedPrompt = prompt;
      capturedWorkspace = workspacePath;
      return { output: { text: 'VERDICT: PASS\nThe scoped candidate snapshot was reviewed.' } };
    },
  });
  assert.equal(result.passed, true);
  assert.ok(!capturedPrompt.includes(tailMarker), 'full candidate source must not be embedded in Reviewer prompt');
  assert.ok(!capturedPrompt.includes(diffTail), 'full diff must not be embedded in Reviewer prompt');
  assert.ok(capturedPrompt.includes(fileSha256), 'Reviewer receives the exact per-file hash');
  assert.ok(capturedPrompt.includes('artifact-bound-review') && capturedPrompt.includes('"artifactVersion":7'));
  assert.notEqual(capturedWorkspace, sourceRoot);
  assert.ok(capturedPrompt.includes(path.join(capturedWorkspace, 'manifest.json')));
  assert.ok(capturedPrompt.includes(path.join(capturedWorkspace, 'diff.patch')));
  assert.ok(capturedPrompt.includes('不可信数据'), 'candidate material must be framed as untrusted');
  assert.ok(!/0%/.test(result.summary), 'PASS must not claim zero overall goal deviation');
});

test('Reviewer does not embed an oversized candidate and can inspect its verified worktree manifest', async (t) => {
  const content = '<!doctype html>\n' + 'x'.repeat(410 * 1024);
  const fileSha256 = sha256Buffer(Buffer.from(content));
  const sourceRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'irixi-review-source-'));
  await fsp.writeFile(path.join(sourceRoot, 'large.txt'), content);
  t.after(() => fsp.rm(sourceRoot, { recursive: true, force: true }));
  let roleStarted = false;
  const result = await runIndependentReviewerWithOmo({
    task: { title: 'synthetic oversized review', goalVersionId: 'goal-large', statement: 'review all files', successCriteria: [], boundaries: [] },
    project: { allowedWritePaths: ['large.txt'] },
    worktreePath: sourceRoot,
    candidateSha256: sha256Text(`large.txt:${fileSha256}`),
    diffSha256: sha256Text('complete synthetic diff'),
    patchText: 'complete synthetic diff',
    changedFiles: [{ path: 'large.txt', bytes: Buffer.byteLength(content), sha256: fileSha256 }],
    candidateFilesMap: { 'large.txt': { path: 'large.txt', bytes: Buffer.byteLength(content), sha256: fileSha256, content } },
    checks: [{ status: 'passed', name: 'synthetic host check', summary: 'passed' }],
    runRole: async () => { roleStarted = true; return { output: { text: 'VERDICT: PASS' } }; },
  });
  assert.equal(result.nativeVerdict, 'PASS');
  assert.equal(result.invoked, true);
  assert.equal(roleStarted, true);
});

test('OmO server serves only the mapped office vendors and art assets, with traversal blocked', async () => {
  const runtimeDir = path.join(__dirname, 'runtime-test-static-resources');
  await fsp.rm(runtimeDir, { recursive: true, force: true });
  const { server } = await createOmoPilotServer({ runtimeDir, preferLocalFallback: true });

  async function request(pathname) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let status = 200;
      let headers = {};
      const req = { method: 'GET', url: pathname, headers: { host: '127.0.0.1:3848' }, async *[Symbol.asyncIterator]() {} };
      const res = {
        writeHead(code, value = {}) { status = code; headers = Object.fromEntries(Object.entries(value).map(([k, v]) => [k.toLowerCase(), v])); },
        end(chunk) { if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); resolve({ status, headers, body: Buffer.concat(chunks) }); },
      };
      Promise.resolve(server.listeners('request')[0](req, res)).catch(reject);
    });
  }

  try {
    const cases = [
      ['/vendor/phaser.min.js', 'node_modules/phaser/dist/phaser.min.js', 'text/javascript; charset=utf-8'],
      ['/vendor/easystar.min.js', 'node_modules/easystarjs/bin/easystar-0.4.4.min.js', 'text/javascript; charset=utf-8'],
      ['/assets/office-playable-v1/concept-runtime-v4/manifest.json', 'art/office-playable-v1/concept-runtime-v4/manifest.json', 'application/json; charset=utf-8'],
      ['/assets/office-playable-v1/concept-runtime-v4/room-base-1440x810.png', 'art/office-playable-v1/concept-runtime-v4/room-base-1440x810.png', 'image/png'],
    ];
    for (const [url, localPath, contentType] of cases) {
      const response = await request(url);
      assert.equal(response.status, 200, `${url} should be served`);
      assert.equal(response.headers['content-type'], contentType);
      assert.equal(response.headers['x-content-type-options'], 'nosniff');
      assert.deepEqual(response.body, fs.readFileSync(path.join(WORKSPACE_ROOT, localPath)));
    }

    const api = await request('/api/product-health');
    assert.equal(api.status, 200, 'API routing must retain priority over static resources');
    assert.match(api.headers['content-type'], /application\/json/);

    const traversal = await request('/assets/%2e%2e/.irixi-runtime/omo/home/.omo/agent/settings.json');
    assert.equal(traversal.status, 404, 'art mapping must not expose workspace files');
    assert.equal(traversal.body.includes(Buffer.from('deepseek-v4-pro')), false);
  } finally {
    await fsp.rm(runtimeDir, { recursive: true, force: true });
  }
});

test('confirmation freezes one bound PASS candidate and repeated confirmation preserves its original approval', async (t) => {
  const { controller, task, artifact, body, content } = await makeConfirmationFixture(t);
  const first = await controller.confirmCandidate(task.id, body);
  assert.equal(task.artifacts[0].confirmation.approvalId, first.approvalId);
  assert.equal(task.artifacts[0].confirmation.candidateSha256, artifact.candidateSha256);
  assert.equal(task.artifacts[0].confirmation.diffSha256, artifact.diffSha256);
  assert.equal(task.artifacts[0].confirmation.reviewId, artifact.review.id);

  const frozenPatch = await controller.readConfirmedDelivery(task.id, 'patch', artifact.id, first.approvalId);
  const frozenZip = await controller.readConfirmedDelivery(task.id, 'zip', artifact.id, first.approvalId);
  assert.equal(frozenPatch.buffer.toString('utf8'), artifact.patch);
  assert.equal(frozenZip.buffer.readUInt32LE(0), 0x04034b50);
  await fsp.writeFile(path.join(artifact.worktreePath, 'index.html'), `${content}changed after confirmation\n`);
  assert.deepEqual((await controller.readConfirmedDelivery(task.id, 'zip', artifact.id, first.approvalId)).buffer, frozenZip.buffer);
  assert.deepEqual((await controller.readConfirmedDelivery(task.id, 'patch', artifact.id, first.approvalId)).buffer, frozenPatch.buffer);

  const repeated = await controller.confirmCandidate(task.id, body);
  assert.equal(repeated.idempotent, true);
  assert.equal(repeated.approvalId, first.approvalId);
  await assert.rejects(controller.readConfirmedDelivery(task.id, 'zip', artifact.id, 'wrong-approval'), /指定的已确认版本/u);
  await assert.rejects(controller.readConfirmedDelivery(task.id, 'zip', 'wrong-artifact', first.approvalId), /指定的已确认版本/u);
});

test('confirmation rejects a same-candidate replacement diff or reviewer evidence without a diff binding', async (t) => {
  const changed = await makeConfirmationFixture(t);
  const replacementPatch = `${changed.artifact.patch}\nreplacement diff, unchanged candidate\n`;
  const replacementSha = sha256Text(replacementPatch);
  changed.artifact.patch = replacementPatch;
  changed.artifact.patchSha256 = replacementSha;
  changed.artifact.diffSha256 = replacementSha;
  changed.body.expectedDiffSha256 = replacementSha;
  await assert.rejects(changed.controller.confirmCandidate(changed.task.id, changed.body), (error) => error.statusCode === 409);
  assert.equal(changed.artifact.candidateSha256, changed.body.expectedCandidateSha256);
  assert.equal(changed.artifact.confirmation, null);
  assert.deepEqual(await fsp.readdir(changed.controller.deliveriesDir), []);

  const unbound = await makeConfirmationFixture(t);
  delete unbound.artifact.review.sourceEvidence.diffSha256;
  await assert.rejects(unbound.controller.confirmCandidate(unbound.task.id, unbound.body), (error) => error.statusCode === 409);
  assert.equal(unbound.artifact.confirmation, null);
  assert.deepEqual(await fsp.readdir(unbound.controller.deliveriesDir), []);
});

test('native OmO session confirmation requires the same diff in session, adoption, and source evidence', async (t) => {
  const fixture = await makeConfirmationFixture(t);
  const { task, artifact, body } = fixture;
  const source = artifact.review.sourceEvidence;
  const call = task.execution.modelCalls.find((item) => item.id === source.sourceCallId);
  const sessionId = 'native-session-diff-bound';
  task.execution.omoSessions = [{
    id: sessionId, role: 'Reviewer', phase: 'review', status: 'model_returned',
    binding: structuredClone(call.binding), sourceCallIds: [call.id],
    outputSha256: source.reportSha256, finalOutputSha256: source.reportSha256,
    reviewAdoption: { reviewId: artifact.review.id, reportSha256: source.reportSha256, diffSha256: artifact.diffSha256 },
  }];
  artifact.review.sourceEvidence = {
    taskId: source.taskId, goalVersionId: source.goalVersionId, executionId: source.executionId,
    registrySha256: source.registrySha256, artifactId: source.artifactId, artifactVersion: source.artifactVersion,
    scopeFingerprint: source.scopeFingerprint, candidateSha256: source.candidateSha256, diffSha256: source.diffSha256,
    sourceSessionId: sessionId, sourceCallIds: [call.id], reportSha256: source.reportSha256,
  };
  const confirmation = await fixture.controller.confirmCandidate(task.id, body);
  assert.equal(confirmation.ok, true);
  assert.equal(artifact.confirmation.diffSha256, artifact.diffSha256);
});

test('a diff changed while a Reviewer call is running invalidates that call before adoption', async (t) => {
  const fixture = await makeConfirmationFixture(t);
  const { controller, task, artifact } = fixture;
  const previousRunner = controller.codexRoleRunner;
  const originalDiffSha = artifact.diffSha256;
  controller.codexRoleRunner = async (request) => {
    const result = await previousRunner(request);
    const replacement = `${artifact.patch}\nchanged during review\n`;
    artifact.patch = replacement;
    artifact.patchSha256 = sha256Text(replacement);
    artifact.diffSha256 = artifact.patchSha256;
    return result;
  };
  const workItemId = 'work-review-diff-race';
  await assert.rejects(controller.runCodexProductRole(task, {
    role: 'Reviewer', workItemId, phase: 'review', prompt: 'Review this exact diff snapshot.', artifact,
    expectedBinding: {
      taskId: task.id, goalVersionId: task.goalVersionId, executionId: task.execution.id,
      registrySha256: task.registry.registrySha256, workItemId,
      artifactId: artifact.id, candidateSha256: artifact.candidateSha256, diffSha256: originalDiffSha,
    },
  }), (error) => error.code === 'STALE_ROLE_BINDING');
  const call = task.execution.modelCalls.find((item) => item.binding?.workItemId === workItemId);
  assert.equal(call.status, 'failed');
  assert.equal(call.outcome, 'stale_binding');
  assert.equal(call.reviewAdoption, undefined);
});

test('completed Reviewer request replay returns its original bound source call without reserving another call', async (t) => {
  const { controller, task, artifact, body } = await makeConfirmationFixture(t);
  const source = artifact.review.sourceEvidence;
  const callCount = task.execution.modelCalls.length;
  const workItemId = 'work-review-confirm-fixture';
  const replay = await controller.runCodexProductRole(task, {
    role: 'Reviewer', workItemId, phase: 'review', prompt: 'Review the exact fixture candidate.',
    artifact, expectedBinding: {
      taskId: task.id, goalVersionId: task.goalVersionId, executionId: task.execution.id,
      registrySha256: task.registry.registrySha256, workItemId,
      artifactId: artifact.id, candidateSha256: artifact.candidateSha256,
      diffSha256: artifact.diffSha256,
    },
  });
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.sourceCallId, source.sourceCallId);
  assert.equal(replay.sourceCallOutputSha256, source.sourceCallOutputSha256);
  assert.equal(task.execution.modelCalls.length, callCount);
  const confirmation = await controller.confirmCandidate(task.id, body);
  assert.equal(confirmation.ok, true);
});

test('a replayed review request keeps its current result and cannot restore a superseded report', async (t) => {
  const { controller, task, artifact, setReview } = await makeConfirmationFixture(t);
  const requestId = 'review-request-old';
  const fingerprint = sha256Text(JSON.stringify({
    goalVersionId: task.goalVersionId, executionId: task.execution.id,
    registrySha256: task.registry.registrySha256, artifactId: artifact.id,
    candidateSha256: artifact.candidateSha256, diffSha256: artifact.diffSha256, reviewEvidence: '',
    reviewRoundId: null, previousReviewId: null,
  }));
  const original = artifact.review;
  original.requestId = requestId;
  original.requestFingerprint = fingerprint;
  const originalCall = task.execution.modelCalls.find((call) => call.id === original.sourceEvidence.sourceCallId);
  originalCall.binding.workItemId = `work-review-${requestId}`;
  originalCall.idempotencyKey = `${originalCall.binding.executionId}:${originalCall.binding.workItemId}:review:${originalCall.promptSha256}`;
  originalCall.reviewAdoption = { reviewId: original.id, reviewedAt: 'original-time',
    reportSha256: original.fullOutputSha256, diffSha256: artifact.diffSha256 };
  task.execution.requestFingerprints = { [`review:${requestId}`]: fingerprint };

  const same = await controller.handleTaskAction(task.id, { action: 'review', requestId });
  assert.equal(same.idempotentReplay, true);
  assert.equal(same.reviewId, original.id);
  assert.equal(artifact.review.text, original.text);

  await setReview('VERDICT: FAIL\nA newer report for the same candidate.');
  const newer = artifact.review;
  const callsBeforeReplay = task.execution.modelCalls.length;
  await assert.rejects(controller.handleTaskAction(task.id, { action: 'review', requestId }), (error) => error.statusCode === 409);
  assert.equal(artifact.review.id, newer.id);
  assert.equal(artifact.review.text, newer.text);
  assert.equal(task.execution.modelCalls.length, callsBeforeReplay);
});

test('confirmation rejects stale bindings, non-PASS review, failed Host checks and changed candidate without leaving approval', async (t) => {
  const cases = [
    ['goal', ({ body }) => { body.expectedGoalVersionId = 'old-goal'; }],
    ['execution', ({ body }) => { body.expectedExecutionId = 'old-run'; }],
    ['registry', ({ body }) => { body.expectedRegistrySha256 = 'old-registry'; }],
    ['candidate', ({ body }) => { body.expectedCandidateSha256 = '0'.repeat(64); }],
    ['review ID', ({ body }) => { body.expectedReviewId = 'replacement-review'; }],
    ['review report SHA', ({ body }) => { body.expectedReviewFullOutputSha256 = '0'.repeat(64); }],
    ['review', ({ artifact }) => { artifact.review.nativeVerdict = 'UNVERIFIED'; }],
    ['Host', ({ artifact }) => { artifact.hostCheck.checks[1].passed = false; }],
    ['worktree', async ({ artifact, content }) => fsp.writeFile(path.join(artifact.worktreePath, 'index.html'), `${content}drift\n`)],
  ];
  for (const [label, corrupt] of cases) await t.test(label, async (subtest) => {
    const fixture = await makeConfirmationFixture(subtest);
    await corrupt(fixture);
    const before = structuredClone(fixture.task);
    await assert.rejects(fixture.controller.confirmCandidate(fixture.task.id, fixture.body));
    assert.equal(fixture.artifact.confirmation, null);
    assert.equal(fixture.task.updatedAt, before.updatedAt);
    assert.deepEqual(await fsp.readdir(fixture.controller.deliveriesDir), []);
  });
});

test('a copied PASS report from another candidate cannot confirm through the ordinary UI request', async (t) => {
  const current = await makeConfirmationFixture(t);
  const unrelated = await makeConfirmationFixture(t);
  current.artifact.review = structuredClone(unrelated.artifact.review);
  const response = await current.request('POST', `/api/product/tasks/${current.task.id}/confirm`, current.body);
  assert.equal(response.status, 409);
  assert.equal(current.artifact.confirmation, null);
  assert.deepEqual(await fsp.readdir(current.controller.deliveriesDir), []);
});

test('ordinary UI confirmation rejects a PASS replaced after the user read the prior report', async (t) => {
  const fixture = await makeConfirmationFixture(t);
  const readByUi = structuredClone(fixture.body);
  const oldReviewId = fixture.artifact.review.id;
  await fixture.setReview('VERDICT: PASS\nReplacement reviewer report for the same candidate.');
  assert.notEqual(fixture.artifact.review.id, oldReviewId);
  const response = await fixture.request('POST', `/api/product/tasks/${fixture.task.id}/confirm`, readByUi);
  assert.equal(response.status, 409);
  assert.equal(fixture.artifact.confirmation, null);
  assert.deepEqual(await fsp.readdir(fixture.controller.deliveriesDir), []);
});

test('goal HTTP change during final candidate snapshot prevents confirmation and removes temporary deliveries', async (t) => {
  const fixture = await makeConfirmationFixture(t);
  const read = fixture.controller.readCandidateSnapshot.bind(fixture.controller);
  let reads = 0;
  let goalResponse;
  fixture.controller.readCandidateSnapshot = async (artifact) => {
    const snapshot = await read(artifact);
    if (++reads === 3) {
      goalResponse = await fixture.request('POST', `/api/product/tasks/${fixture.task.id}/actions`, {
        action: 'goal', statement: 'A replacement goal arrives during the last file read.',
      });
    }
    return snapshot;
  };
  const response = await fixture.request('POST', `/api/product/tasks/${fixture.task.id}/confirm`, fixture.body);
  assert.equal(goalResponse.status, 200, JSON.stringify(goalResponse.json));
  assert.equal(response.status, 409);
  assert.equal(fixture.artifact.confirmation, null);
  assert.deepEqual(await fsp.readdir(fixture.controller.deliveriesDir), []);
});

test('manual adjudication remains limited to the exact bound FAIL report; UNVERIFIED is not adjudicable', async (t) => {
  const { controller, task, artifact, body, setReview } = await makeConfirmationFixture(t);
  const failText = 'VERDICT: FAIL\nBlocking finding.';
  await setReview(failText);
  const buildZip = controller.buildConfirmedZipBuffer.bind(controller);
  let manifestConfirmation;
  controller.buildConfirmedZipBuffer = async (...args) => {
    manifestConfirmation = structuredClone(args[3]);
    return buildZip(...args);
  };
  Object.assign(body, {
    adjudicationReason: 'Explicitly accepted this bounded finding.',
    authorizationSourceThreadId: 'owner-thread-fixture', authorizationText: 'Owner authorization fixture only.',
  });
  const result = await controller.confirmCandidate(task.id, body);
  assert.equal(task.artifacts[0].confirmation.reviewAdjudication.reviewId, artifact.review.id);
  assert.equal(task.artifacts[0].confirmation.reviewAdjudication.reason, body.adjudicationReason);
  assert.equal(result.approvalId, task.artifacts[0].confirmation.approvalId);
  const coreMetadata = (record) => Object.fromEntries(['approvalId', 'artifactVersion', 'goalVersionId', 'executionId',
    'registrySha256', 'candidateSha256', 'reviewId', 'reviewFullOutputSha256', 'reviewAdjudication']
    .map((key) => [key, record[key]]));
  assert.deepEqual(coreMetadata(manifestConfirmation), coreMetadata(task.artifacts[0].confirmation),
    'the frozen ZIP manifest and final confirmation must retain one adjudication timestamp and identity');

  const blocked = await makeConfirmationFixture(t);
  await blocked.setReview('No explicit verdict.');
  Object.assign(blocked.body, { adjudicationReason: 'must reject', authorizationSourceThreadId: 'owner-thread-fixture', authorizationText: 'fixture' });
  await assert.rejects(blocked.controller.confirmCandidate(blocked.task.id, blocked.body), /真实 FAIL 报告/u);
  assert.equal(blocked.artifact.confirmation, null);
});

test('settled Lead CLI failure projects a stopped state and never opens a start action', async (t) => {
  const runtimeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'irixi-failed-state-'));
  t.after(() => fsp.rm(runtimeDir, { recursive: true, force: true }));
  const { controller } = await createOmoPilotServer({ runtimeDir, preferLocalFallback: true });
  const projects = await controller.listRegisteredProjects();
  const project = projects.find((entry) => entry.projectId === 'task-list-organizer');
  const task = {
    id: 'task-stopped-fixture', title: 'stopped task', statement: 'fixture goal', successCriteria: [], boundaries: [],
    goalVersionId: 'goal-stopped-fixture', functionId: 'utility', activeArtifactId: null, artifacts: [],
    selectedScope: { projectId: project.projectId, scopeFingerprint: project.scopeFingerprint, goalVersionId: 'goal-stopped-fixture', authorized: true, current: true },
    registry: { projectId: project.projectId, scopeFingerprint: project.scopeFingerprint, registrySha256: 'registry-stopped-fixture', status: 'registered' },
    execution: { id: 'run-stopped-fixture', phase: 'partial', status: 'waiting_user', deadline: '2026-10-21T11:09:24.366Z',
      failureReason: 'Codex CLI exit 1', modelCalls: [{ role: 'Lead', status: 'failed' }], agents: [], workItems: [], sessions: [],
      plan: null, planApprovalStatus: 'not_saved', leadAgentId: 'lead-fixture', reviewContinuation: null },
    conversations: [], memoryEntries: [],
  };
  controller.state.tasks.push(task);
  controller.state.activeTaskId = task.id;
  const product = await controller.buildProductState(task.id);
  assert.equal(product.status, 'failed');
  assert.equal(product.statusLabel, '本轮已停止');
  assert.match(product.nextStep, /1 次业务调用失败；尚无计划；工作区可能保留未整合改动.*原截止 .* 保留，等待明确后续/u);
  assert.equal(product.native.actions.canRun, false);
  assert.equal(product.canPrepareRun, false);
  const normalized = normalizeNativeProductState(product);
  assert.equal(normalized.nextStep, product.nextStep);
  assert.equal(normalized.officeStatus, 'failed');
});

test('settled Developer failure with an approved plan projects stopped and never asks to start Lead', async (t) => {
  const runtimeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'irixi-failed-developer-state-'));
  t.after(() => fsp.rm(runtimeDir, { recursive: true, force: true }));
  const { controller } = await createOmoPilotServer({ runtimeDir, preferLocalFallback: true });
  const project = (await controller.listRegisteredProjects()).find((entry) => entry.projectId === 'task-list-organizer');
  const deadline = '2026-10-21T16:01:45.939Z';
  const task = {
    id: 'task-stopped-developer-fixture', title: 'stopped developer task', statement: 'fixture goal', successCriteria: [], boundaries: [],
    goalVersionId: 'goal-stopped-developer-fixture', functionId: 'utility', activeArtifactId: null, artifacts: [],
    selectedScope: { projectId: project.projectId, scopeFingerprint: project.scopeFingerprint, goalVersionId: 'goal-stopped-developer-fixture', authorized: true, current: true },
    registry: { projectId: project.projectId, scopeFingerprint: project.scopeFingerprint, registrySha256: 'developer-stopped-fixture', status: 'registered' },
    execution: { id: 'run-stopped-developer-fixture', phase: 'executing', status: 'waiting_user', deadline,
      failureReason: 'Codex CLI exec_command failed', modelCalls: [
        { role: 'Lead', status: 'completed', callOrdinal: 1 },
        { role: 'Developer', status: 'failed', callOrdinal: 2 },
        { role: 'Chat', status: 'completed', callOrdinal: 3, binding: { workItemId: 'work-chat-stopped-developer-fixture' } },
      ], agents: [], workItems: [], sessions: [], plan: { text: 'The approved plan remains available.' }, planApprovalStatus: 'saved',
      leadAgentId: 'lead-fixture', reviewContinuation: null },
    conversations: [], memoryEntries: [],
  };
  controller.state.tasks.push(task);
  controller.state.activeTaskId = task.id;
  const product = await controller.buildProductState(task.id);
  assert.equal(product.status, 'failed');
  assert.equal(product.statusLabel, '本轮已停止');
  assert.match(product.nextStep, /1 次业务调用失败；计划记录已保留；工作区可能保留未整合改动/u);
  assert.match(product.nextStep, /尚未形成候选，不能视为检查或独立审阅通过/u);
  assert.match(product.nextStep, /原截止 .* 保留/u);
  assert.match(product.nextStep, /Codex CLI exec_command failed/u);
  assert.match(product.nextStep, /不会自动重试/u);
  assert.equal(product.execution.phase, 'executing', 'legacy phase is reported, not silently rewritten by projection');
  assert.equal(product.execution.deadline, deadline);
  assert.equal(product.native.plan.text, 'The approved plan remains available.');
  assert.equal(product.native.actions.canRun, false);
  assert.equal(product.native.actions.canReview, false);
  assert.equal(product.artifact, null);

  const chatOnly = {
    ...structuredClone(task), id: 'task-chat-failure-only-fixture', title: 'chat failure only', activeArtifactId: null,
    execution: { ...structuredClone(task.execution), id: 'run-chat-failure-only-fixture', phase: 'executing', plan: null,
      modelCalls: [{ role: 'Chat', status: 'failed', callOrdinal: 1, binding: { workItemId: 'work-chat-failure-only-fixture' } }] },
  };
  controller.state.tasks.push(chatOnly);
  const chatProduct = await controller.buildProductState(chatOnly.id);
  assert.notEqual(chatProduct.status, 'failed', 'a failed chat must not mark the native execution as failed');
});

test('candidate status does not claim independent review before Host checks and a bound Reviewer result', async (t) => {
  const runtimeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'irixi-candidate-state-'));
  t.after(() => fsp.rm(runtimeDir, { recursive: true, force: true }));
  const { controller } = await createOmoPilotServer({ runtimeDir, preferLocalFallback: true });
  const project = (await controller.listRegisteredProjects()).find((entry) => entry.projectId === 'task-list-organizer');
  const task = {
    id: 'task-candidate-fixture', title: 'candidate fixture', statement: 'fixture goal', successCriteria: [], boundaries: [],
    goalVersionId: 'goal-candidate-fixture', functionId: 'utility', setupStatus: null,
    selectedScope: { projectId: project.projectId, scopeFingerprint: project.scopeFingerprint, goalVersionId: 'goal-candidate-fixture', authorized: true, current: true },
    registry: { projectId: project.projectId, scopeFingerprint: project.scopeFingerprint, registrySha256: 'registry-candidate-fixture', status: 'registered' },
    execution: { id: 'run-candidate-fixture', phase: 'partial', status: 'waiting_user', deadline: '2026-10-21T11:09:24.366Z',
      modelCalls: [], agents: [], workItems: [], sessions: [], plan: null, planApprovalStatus: 'saved', leadAgentId: 'lead-fixture',
      reviewContinuation: { authorized: true, dispatchEventId: null } },
    activeArtifactId: 'artifact-candidate-fixture',
    artifacts: [{ id: 'artifact-candidate-fixture', version: 1, goalVersionId: 'goal-candidate-fixture', executionId: 'run-candidate-fixture',
      registrySha256: 'registry-candidate-fixture', candidateSha256: 'a'.repeat(64),
      hostCheck: { passed: false, checks: [{ id: 'scope', passed: false }] },
      review: { id: null, passed: false, nativeVerdict: 'UNVERIFIED', fullOutputSha256: null, sourceEvidence: null }, confirmation: null }],
    conversations: [], memoryEntries: [], preview: null,
  };
  controller.state.tasks.push(task);
  const product = await controller.buildProductState(task.id);
  assert.match(product.statusLabel, /宿主固定检查未完整通过/u);
  assert.match(product.nextStep, /不得把独立审阅当作已完成/u);
  assert.equal(product.native.autoReviewContinuation.status, 'blocked_host_checks');
  assert.doesNotMatch(`${product.statusLabel}\n${product.nextStep}`, /已自动完成独立审阅/u);
  assert.equal(product.native.actions.canConfirm, false);
});

test('HTTP projection stops only a settled Reviewer failure bound to the current candidate', async (t) => {
  const runtimeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'irixi-review-stop-projection-'));
  t.after(() => fsp.rm(runtimeDir, { recursive: true, force: true }));
  const { controller, server } = await createOmoPilotServer({ runtimeDir, preferLocalFallback: false, codexRoleRunner: createFakeOmoRoleRunner() });
  const project = { projectId: 'review-stop-fixture-project', scopeFingerprint: 'review-stop-fixture-scope', label: 'Isolated fixture', allowedWritePaths: ['index.html'] };
  controller.listRegisteredProjects = async () => [project];
  const taskId = 'task-review-stop-fixture';
  const goalVersionId = 'goal-review-stop-fixture';
  const executionId = 'run-review-stop-fixture';
  const registrySha256 = '1'.repeat(64);
  const artifactId = 'artifact-review-stop-fixture';
  const candidateSha256 = '2'.repeat(64);
  const diffSha256 = '3'.repeat(64);
  const callId = 'call-review-stop-fixture';
  const dispatchEventId = `evt-${callId}`;
  const reviewerBinding = { taskId, goalVersionId, executionId, registrySha256, workItemId: 'work-review-stop-fixture', artifactId, candidateSha256, diffSha256 };
  const baseTask = (id = taskId) => {
    const boundReviewer = { ...reviewerBinding, taskId: id };
    return {
    id, title: 'Reviewer stop projection fixture', statement: 'Synthetic projection only', successCriteria: [], boundaries: [],
    functionId: 'utility', goalVersionId, selectedScope: { projectId: project.projectId, scopeFingerprint: project.scopeFingerprint, goalVersionId, authorized: true, current: true },
    registry: { projectId: project.projectId, scopeFingerprint: project.scopeFingerprint, registrySha256, status: 'registered' },
    execution: {
      id: executionId, phase: 'partial', status: 'waiting_user', deadline: new Date(Date.now() + 600_000).toISOString(),
      modelCalls: [
        { id: 'lead-fixture', role: 'Lead', status: 'completed', callOrdinal: 1 },
        ...Array.from({ length: 5 }, (_unused, index) => ({ id: `developer-fixture-${index + 1}`, role: 'Developer', status: 'completed', callOrdinal: index + 2 })),
        { id: callId, role: 'Reviewer', status: 'failed', callOrdinal: 7, binding: structuredClone(boundReviewer) },
      ],
      sessions: [{ eventId: dispatchEventId, role: 'Reviewer', phase: 'review:provider-decision', modelCallId: callId, status: 'failed' }],
      agents: [], workItems: [], plan: { text: 'synthetic plan' }, planApprovalStatus: 'saved',
      reviewContinuation: { authorized: true, status: 'blocked_or_failed', dispatchEventId, artifactId, artifactVersion: 1, candidateSha256 },
    },
    activeArtifactId: artifactId,
    artifacts: [{ id: artifactId, version: 1, goalVersionId, executionId, registrySha256, candidateSha256, diffSha256, patchSha256: diffSha256, patch: '',
      hostCheck: { passed: true, checks: [{ id: 'fixture-check', passed: true }] },
      review: { id: 'review-unverified-fixture', passed: false, nativeVerdict: 'UNVERIFIED', scopeOutcome: 'unverified',
        fullOutputSha256: sha256Text(''), text: '', sourceEvidence: null }, confirmation: null }],
    conversations: [], memoryEntries: [], instructions: [], rejectionHistory: [], preview: null,
  };
  };

  const getProjectedUiState = async (task) => {
    controller.state.tasks.push(task);
    const response = await dispatchTestHttp(server, 'GET', `/api/product-state?taskId=${encodeURIComponent(task.id)}`);
    assert.equal(response.status, 200);
    const ui = normalizeNativeProductState(response.json);
    const presentation = nativeOfficeWaitingPresentation(ui, { id: ui.taskId, status: ui.status, goal: { activeVersionId: ui.goalVersionId } });
    return { raw: response.json, ui, presentation };
  };

  const settled = await getProjectedUiState(baseTask());
  assert.equal(settled.raw.execution.modelCalls.length, 7);
  assert.equal(settled.raw.execution.modelCalls.at(-1).role, 'Reviewer');
  assert.equal(settled.raw.native.autoReviewContinuation.status, 'blocked_or_failed');
  assert.match(settled.raw.statusLabel, /Reviewer 调用已失败/u);
  assert.match(settled.raw.nextStep, /不会自动重试/u);
  assert.match(settled.raw.nextStep, /明确授权/u);
  assert.equal(settled.ui.nextStep, settled.raw.nextStep);
  assert.equal(settled.presentation.office.kicker, 'REVIEW STOPPED');

  const inFlight = baseTask('task-review-stop-inflight-fixture');
  inFlight.execution.modelCalls.push({ id: 'reviewer-inflight', role: 'Reviewer', status: 'running', binding: structuredClone(inFlight.execution.modelCalls.at(-1).binding) });
  inFlight.execution.sessions.push({ eventId: 'evt-reviewer-inflight', role: 'Reviewer', phase: 'review:provider-decision', modelCallId: 'reviewer-inflight', status: 'running' });
  const active = await getProjectedUiState(inFlight);
  assert.notEqual(active.raw.native.autoReviewContinuation.status, 'blocked_or_failed');
  assert.doesNotMatch(active.raw.nextStep, /不会自动重试/u);
  assert.notEqual(active.presentation?.office?.kicker, 'REVIEW STOPPED');

  const oldCandidateFailure = baseTask('task-review-stop-old-candidate-fixture');
  oldCandidateFailure.execution.modelCalls.at(-1).binding.candidateSha256 = '4'.repeat(64);
  const stale = await getProjectedUiState(oldCandidateFailure);
  assert.notEqual(stale.raw.native.autoReviewContinuation.status, 'blocked_or_failed');
  assert.doesNotMatch(stale.raw.nextStep, /不会自动重试/u);

  const unknownPhase = baseTask('task-review-stop-unknown-phase-fixture');
  unknownPhase.execution.sessions[0].phase = 'review:unrecognized';
  const unknownPhaseState = await getProjectedUiState(unknownPhase);
  assert.notEqual(unknownPhaseState.raw.native.autoReviewContinuation.status, 'blocked_or_failed');
  assert.doesNotMatch(unknownPhaseState.raw.nextStep, /不会自动重试/u);

  const unverifiedOnly = baseTask('task-review-stop-unverified-fixture');
  unverifiedOnly.execution.modelCalls = unverifiedOnly.execution.modelCalls.filter((call) => call.role !== 'Reviewer');
  unverifiedOnly.execution.sessions = [];
  unverifiedOnly.execution.reviewContinuation = { authorized: true, status: 'armed', dispatchEventId: null, artifactId: null, artifactVersion: null, candidateSha256: null };
  const onlyUnverified = await getProjectedUiState(unverifiedOnly);
  assert.notEqual(onlyUnverified.raw.native.autoReviewContinuation.status, 'blocked_or_failed');
  assert.doesNotMatch(onlyUnverified.raw.nextStep, /不会自动重试/u);
  assert.equal(onlyUnverified.presentation.office.kicker, 'REVIEW UNVERIFIED');

  const passedTask = baseTask('task-review-stop-passed-fixture');
  const passedCall = passedTask.execution.modelCalls.at(-1);
  const passedReviewText = 'VERDICT: PASS\nSynthetic bound review.';
  const passedReportSha256 = sha256Text(passedReviewText);
  const passedPatch = 'synthetic patch for the bound pass fixture';
  const passedDiffSha256 = sha256Text(passedPatch);
  passedCall.binding.diffSha256 = passedDiffSha256;
  passedCall.status = 'completed';
  passedCall.outcome = 'model_returned';
  passedCall.cliSpawned = true;
  passedCall.turnStarted = true;
  passedCall.promptSha256 = '5'.repeat(64);
  passedCall.idempotencyKey = `${executionId}:${passedCall.binding.workItemId}:review:${passedCall.promptSha256}`;
  passedCall.output = { text: passedReviewText };
  passedCall.outputSha256 = sha256Text(JSON.stringify(passedCall.output));
  passedCall.reviewAdoption = { reviewId: 'review-passed-fixture', reportSha256: passedReportSha256, diffSha256: passedDiffSha256 };
  const passedArtifact = passedTask.artifacts[0];
  passedArtifact.patch = passedPatch;
  passedArtifact.patchSha256 = passedDiffSha256;
  passedArtifact.diffSha256 = passedDiffSha256;
  passedArtifact.review = {
    id: 'review-passed-fixture', passed: true, nativeVerdict: 'PASS', scopeOutcome: 'clean',
    fullOutputSha256: passedReportSha256, text: passedReviewText,
    sourceEvidence: {
      taskId: passedTask.id, goalVersionId, executionId, registrySha256, artifactId, artifactVersion: 1,
      scopeFingerprint: project.scopeFingerprint, candidateSha256, diffSha256: passedDiffSha256,
      sourceCallId: passedCall.id, sourceCallOutputSha256: passedCall.outputSha256, reportSha256: passedReportSha256,
    },
  };
  passedTask.execution.reviewContinuation.status = 'completed';
  const passed = await getProjectedUiState(passedTask);
  assert.match(passed.raw.statusLabel, /已通过宿主检查与同版独立审阅/u);
  assert.doesNotMatch(passed.raw.statusLabel, /已停止/u);
  assert.doesNotMatch(passed.raw.nextStep, /不会自动重试/u);
  assert.equal(passed.presentation.office.kicker, 'CANDIDATE READY');
});

test('Lead planning prompt uses registered project scope and host facts without prescribing external state recovery', async () => {
  const { generateLeadPlanWithOmo } = await import('./omo-harness.mjs');
  let prompt = '';
  await generateLeadPlanWithOmo({
    task: { title: 'Fixture', statement: 'Goal', successCriteria: ['Check'], boundaries: ['No publish'] },
    project: { projectId: 'registered-project', label: 'Fixture project', allowedWritePaths: ['index.html', 'app.js'] },
    instructions: [{ text: 'Use the existing authorized scope.' }],
    runRole: async (request) => { prompt = request.prompt; return { output: { text: 'A sufficiently long fixture plan.' } }; },
  });
  assert.match(prompt, /规划阶段只使用本提示中由宿主提供的目标/u);
  assert.match(prompt, /不要读取或恢复外部技能、状态或台账/u);
  assert.match(prompt, /已登记项目：registered-project · Fixture project/u);
  assert.match(prompt, /允许写入的项目文件：index\.html, app\.js/u);
  assert.match(prompt, /调用次数、检查与审阅状态以宿主记录为准/u);
  assert.doesNotMatch(prompt, /\.dz\/state\.json|resume-report|Users\/.*workspace/u);
  assert.match(prompt, /不要自行声称没有调用模型/u);
});

test('Normal-mode fake roles run Lead -> Developer -> Reviewer -> UI-bound confirmation and frozen download', async (t) => {
  const testRuntimeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'irixi-test-e2e-'));
  t.after(() => fsp.rm(testRuntimeDir, { recursive: true, force: true }));

  // Snapshot original project files before running to prove zero mutation of source project
  const sourceProjectDir = path.join(WORKSPACE_ROOT, 'projects', 'task-list-organizer');
  const beforeSourceMap = await readRelativeFileMap(sourceProjectDir);

  const fakeRunner = createRecordedFakeRoleRunner({
    developerEdit: async ({ workspacePath }) => {
      const indexPath = path.join(workspacePath, 'index.html');
      const original = await fsp.readFile(indexPath, 'utf8');
      const marker = '<section class="omo-goal-bar" id="omo-goal-bar" aria-label="synthetic developer increment"><strong>Test goal bar</strong></section>';
      const updated = original.includes('<main') ? original.replace(/(<main[^>]*>)/i, `$1\n${marker}`)
        : original.replace(/(<body[^>]*>)/i, `$1\n${marker}`);
      await fsp.writeFile(indexPath, updated);
      const appPath = path.join(workspacePath, 'app.js');
      await fsp.appendFile(appPath, '\n// synthetic normal-mode Developer change\n');
    },
    reviewerText: 'VERDICT: PASS\nSynthetic independent Reviewer checked the exact candidate and bound Host result.',
  });
  const { server, controller } = await createOmoPilotServer({
    runtimeDir: testRuntimeDir,
    preferLocalFallback: false,
    codexRoleRunner: fakeRunner,
    omoRoleRunner: createFakeOmoRoleRunner(),
    developerRunner: async ({ worktreePath, sourceFilesMap, runRole }) => {
      await runRole({ role: 'Developer', prompt: 'Synthetic Developer action.', phase: 'implementation', workspacePath: worktreePath, sourceFilesMap });
      const currentFilesMap = await readRelativeFileMap(worktreePath);
      const changedPaths = Object.keys(currentFilesMap).filter((name) => currentFilesMap[name].sha256 !== sourceFilesMap[name]?.sha256);
      return {
        usedLiveOmo: true, logs: ['Synthetic isolated Developer and Host checks.'],
        checkResult: {
          passed: changedPaths.length > 0, changedPaths, unexpectedPaths: [], currentFilesMap,
          checks: [
            { id: 'synthetic-syntax', name: 'Synthetic syntax fixture', status: 'passed', summary: 'Fake role fixture accepted.' },
            { id: 'synthetic-scope', name: 'Synthetic scope fixture', status: 'passed', summary: 'Only fixture changes observed.' },
          ],
        },
      };
    },
    hostChecksRunner: async ({ worktreePath: checkRoot, sourceFilesMap }) => {
      const currentFilesMap = await readRelativeFileMap(checkRoot);
      const changedPaths = Object.keys(currentFilesMap).filter((name) => currentFilesMap[name].sha256 !== sourceFilesMap[name]?.sha256);
      return { passed: changedPaths.length > 0, checks: [
        { id: 'synthetic-syntax', name: 'Synthetic syntax fixture', status: 'passed', summary: 'Fake role fixture accepted.' },
        { id: 'synthetic-scope', name: 'Synthetic scope fixture', status: 'passed', summary: 'Only fixture changes observed.' },
      ], changedPaths, unexpectedPaths: [], currentFilesMap };
    },
  });
  assert.equal(controller.codexRoleRunner, fakeRunner, 'this positive pipeline fixture must not reach the real CLI');

  async function requestRaw(pathname, options = {}) {
    return new Promise((resolve, reject) => {
      const method = options.method || 'GET';
      const bodyBuffer = options.body ? Buffer.from(options.body, 'utf8') : null;
      const req = {
        method,
        url: pathname,
        headers: {
          host: '127.0.0.1:3848',
          'content-type': 'application/json',
          ...(options.headers || {}),
        },
        async *[Symbol.asyncIterator]() {
          if (bodyBuffer) yield bodyBuffer;
        },
      };
      let statusCode = 200;
      let resHeaders = {};
      const chunks = [];
      const res = {
        writeHead(status, headers = {}) {
          statusCode = status;
          resHeaders = Object.fromEntries(
            Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
          );
        },
        end(chunk) {
          if (chunk) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'));
          }
          resolve({
            status: statusCode,
            headers: resHeaders,
            buffer: Buffer.concat(chunks),
          });
        },
      };
      Promise.resolve(server.listeners('request')[0](req, res)).catch(reject);
    });
  }

  async function api(pathname, options = {}) {
    const res = await requestRaw(pathname, options);
    const contentType = res.headers['content-type'] || '';
    const body = contentType.includes('json')
      ? JSON.parse(res.buffer.toString('utf8'))
      : res.buffer;
    if (res.status >= 400) {
      throw new Error(body?.error?.message || `HTTP ${res.status}`);
    }
    return body;
  }

  // 1. Check health & initial waiting_task state
    const health = await api('/api/product-health');
    assert.equal(health.ok, true);
    assert.equal(health.aiEnabled, true);

    const initialRaw = await api('/api/product-state');
    const initialProduct = normalizeNativeProductState(initialRaw);
    assert.equal(initialProduct.setupOnly, true);
    assert.equal(initialProduct.status, 'waiting_task');
    assert.ok(initialProduct.setup.projects.length >= 2);

    const targetProject = initialProduct.setup.projects.find((p) => p.projectId === 'task-list-organizer');
    assert.ok(targetProject, 'task-list-organizer should be registered');

    // 2. Create Task with locked Goal, Success Criteria, and Boundaries
    const createdRaw = await api('/api/product/tasks', {
      method: 'POST',
      body: JSON.stringify({
        title: '任务清单快速关键词筛选与计数',
        functionId: 'utility',
        statement: '在任务清单整理器顶部增加关键词实时筛选栏与匹配项计数徽标，保留原有任务数据与交互。',
        successCriteria: [
          '顶部显示关键词筛选输入框与实时匹配数量',
          '输入关键词时实时过滤列表项并更新计数',
          '不破坏原有任务清单结构和样式',
        ],
        boundaries: [
          '仅修改 index.html、app.js、core.js、styles.css',
          '在隔离工作树中执行，不覆盖原项目文件，不自动发布',
        ],
        projectId: targetProject.projectId,
        projectScopeFingerprint: targetProject.scopeFingerprint,
      }),
    });

    let product = normalizeNativeProductState(createdRaw);
    assert.equal(product.setupPending, true);
    assert.equal(product.setupStatus, 'waiting_scope_authorization');
    assert.equal(product.native.actions.canAuthorizeScope, true);

    // 3. Authorize Scope
    await api(product.links.actions, {
      method: 'POST',
      body: JSON.stringify(nativeActionPayload(product, 'authorize_scope', {
        projectId: targetProject.projectId,
        expectedScopeFingerprint: targetProject.scopeFingerprint,
      })),
    });

    product = normalizeNativeProductState(await api('/api/product-state'));
    assert.equal(product.setupStatus, 'ready_to_run');
    assert.equal(product.canPrepareRun, true);

    // 4. Prepare Run (with autoReviewContinuation = true)
    await api(product.links.actions, {
      method: 'POST',
      body: JSON.stringify(nativeActionPayload(product, 'prepare_run', {
        expectedScopeFingerprint: targetProject.scopeFingerprint,
        autoReviewContinuation: true,
      })),
    });

    product = normalizeNativeProductState(await api('/api/product-state'));
    assert.equal(product.current, true);
    assert.equal(product.native.actions.canRun, true);
    assert.ok(product.native.runAgentId);

    // 5. Run Lead to generate Plan (Gate 1: stops for user plan approval)
    await api(product.links.actions, {
      method: 'POST',
      body: JSON.stringify(nativeActionPayload(product, 'run')),
    });

    product = normalizeNativeProductState(await api('/api/product-state'));
    assert.equal(product.status, 'waiting_user');
    assert.equal(product.native.actions.canApprovePlan, true);
    assert.ok(product.native.plan?.text.includes('【当前已做到什么】'));
    assert.ok(product.native.plan?.text.includes('【离最终目标的偏差与老功能保护】'));
    assert.match(product.native.plan?.sha256 || '', /^[a-f0-9]{64}$/);

    // 6. Approve Plan -> Executes Developer in isolated worktree -> Host checks -> Automatic Independent Reviewer!
    await api(product.links.actions, {
      method: 'POST',
      body: JSON.stringify(nativeActionPayload(product, 'approve_plan')),
    });

    product = normalizeNativeProductState(await api('/api/product-state'));
    assert.equal(product.status, 'waiting_user', 'Must stop at waiting_user for human confirmation after auto-review');
    assert.ok(product.artifact, 'Candidate artifact v1 must be produced');
    assert.equal(product.artifact.version, 1);
    assert.equal(product.artifact.hostCheck?.passed, true, 'Host checks must pass');
    assert.equal(product.artifact.review?.passed, true, 'Independent Reviewer must automatically run and PASS');
    assert.equal(product.artifact.review?.nativeVerdict, 'PASS');
    assert.equal(product.native.autoReviewContinuation?.status, 'completed');
    assert.equal(product.native.actions.canConfirm, true);
    assert.ok(product.links.preview, 'Live preview link must be ready');

    // 7. Verify Candidate details via `/api/product/tasks/:id/candidate` and `normalizeNativeCandidate`
    const rawCandidate = await api(product.links.candidate);
    const rawProduct = await api(`/api/product-state?taskId=${encodeURIComponent(product.taskId)}`);
    assert.ok(rawCandidate.review.sourceEvidence, 'candidate endpoint must expose server-bound reviewer evidence');
    assert.ok(rawCandidate.review.sourceEvidence.sourceSessionId);
    assert.deepEqual(rawCandidate.review.sourceEvidence.sourceCallIds, [rawProduct.execution.modelCalls[2].id]);
    assert.equal(rawCandidate.review.sourceEvidence.candidateSha256, product.artifact.candidateSha256);
    const candidate = normalizeNativeCandidate(rawCandidate, product);
    assert.equal(candidate.artifactVersion, 1);
    assert.ok(candidate.patch.includes('diff --git'));
    assert.ok(candidate.checks.every((c) => c.passed === true));
    assert.ok(candidate.review.text.includes('VERDICT: PASS'));

    // 8. Verify Static Preview serves modified HTML & JS with 200 OK
    const previewRes = await requestRaw(product.links.preview);
    assert.equal(previewRes.status, 200);
    const previewHtml = previewRes.buffer.toString('utf8');
    assert.ok(previewHtml.includes('omo-goal-bar'), 'Preview HTML must include the new incremental goal bar');

    // 9. Verify original source project is 100% untouched byte-for-byte!
    const afterSourceMap = await readRelativeFileMap(sourceProjectDir);
    assert.deepEqual(afterSourceMap, beforeSourceMap, 'Original source project files must never be modified');

    // 10. Confirm Candidate Version (Gate 2: explicit user confirmation)
    await api(product.links.confirm, {
      method: 'POST',
      body: JSON.stringify({
        artifactId: product.artifact.id,
        version: product.artifact.version,
        expectedTaskId: product.taskId,
        expectedGoalVersionId: product.goalVersionId,
        expectedExecutionId: product.execution.id,
        expectedRegistrySha256: product.product.registrySha256,
        expectedCandidateSha256: product.artifact.candidateSha256,
        expectedDiffSha256: product.artifact.diffSha256,
        expectedReviewId: product.artifact.review.id,
        expectedReviewFullOutputSha256: product.artifact.review.fullOutputSha256,
      }),
    });

    product = normalizeNativeProductState(await api('/api/product-state'));
    assert.equal(product.status, 'ready_to_export');
    assert.equal(product.officeStatus, 'ready_to_export');
    assert.ok(product.artifact.confirmation?.approvalId);
    assert.ok(product.links.patch, 'Patch download link must be unlocked after confirmation');
    assert.ok(product.links.zip, 'ZIP download link must be unlocked after confirmation');
    assert.deepEqual(rawProduct.execution.modelCalls.map((call) => call.role), ['Lead', 'Developer', 'Reviewer']);
    assert.ok(rawProduct.execution.modelCalls.every((call) => call.status === 'completed' && call.outcome === 'model_returned'));
    assert.equal(product.artifact.review.id, candidate.review.id);
    assert.equal(product.artifact.review.fullOutputSha256, candidate.review.fullOutputSha256);

    // 11. Download `.patch` and `.zip`
    const downloadQuery = `artifactId=${encodeURIComponent(product.artifact.id)}&approvalId=${encodeURIComponent(product.artifact.confirmation.approvalId)}`;
    const patchBuf = await api(`${product.links.patch}?${downloadQuery}`);
    const patchStr = Buffer.from(patchBuf).toString('utf8');
    assert.ok(patchStr.includes('diff --git a/index.html b/index.html'));

    const zipBuf = Buffer.from(await api(`${product.links.zip}?${downloadQuery}`));
    assert.equal(zipBuf.readUInt32LE(0), 0x04034b50, 'Downloaded file must be a valid PKZIP archive');
});
