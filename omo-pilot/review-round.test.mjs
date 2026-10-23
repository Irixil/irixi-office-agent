import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import test from 'node:test';

// Block process, network-client, and listening-server access before loading app modules.
const require = createRequire(import.meta.url);
const childProcess = require('node:child_process');
const originals = {
  spawn: childProcess.spawn, spawnSync: childProcess.spawnSync, exec: childProcess.exec,
  execSync: childProcess.execSync, execFile: childProcess.execFile, execFileSync: childProcess.execFileSync,
  fork: childProcess.fork, request: http.request, get: http.get, httpsRequest: https.request, httpsGet: https.get,
  createServer: http.createServer, httpsCreateServer: https.createServer,
  connect: net.connect, createConnection: net.createConnection, fetch: globalThis.fetch,
};
const blocked = () => { throw new Error('Real process/network access is blocked in isolated review-round tests.'); };
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[name] = blocked;
http.request = blocked;
http.get = blocked;
https.request = blocked;
https.get = blocked;
https.createServer = (...args) => {
  const server = originals.httpsCreateServer(...args);
  server.listen = blocked;
  return server;
};
http.createServer = (...args) => {
  const server = originals.createServer(...args);
  server.listen = blocked;
  return server;
};
net.connect = blocked;
net.createConnection = blocked;
globalThis.fetch = blocked;
syncBuiltinESMExports();
test.after(() => {
  Object.assign(childProcess, Object.fromEntries(Object.entries(originals).filter(([key]) => key in childProcess)));
  http.request = originals.request;
  http.get = originals.get;
  https.request = originals.httpsRequest;
  https.get = originals.httpsGet;
  https.createServer = originals.httpsCreateServer;
  http.createServer = originals.createServer;
  net.connect = originals.connect;
  net.createConnection = originals.createConnection;
  globalThis.fetch = originals.fetch;
  syncBuiltinESMExports();
});

const [{ createOmoPilotServer }, { readRelativeFileMap, runIndependentReviewerWithOmo, sha256Buffer, sha256Text }, { nativeActionPayload, normalizeNativeProductState }, { guardWorkspaceToolCalls, parseCodexDecisionOutput }] = await Promise.all([
  import('./server.mjs'), import('./omo-harness.mjs'), import('../app/public/native-product-state.js'), import('./codex-provider-protocol.mjs'),
]);

test('隔离前缀同步拦截所有进程与HTTP(S)客户端及监听入口', () => {
  for (const call of [
    () => childProcess.spawn('node', ['-e', '']), () => http.request('http://127.0.0.1'),
    () => http.get('http://127.0.0.1'), () => https.request('https://127.0.0.1'),
    () => https.get('https://127.0.0.1'), () => net.connect(80, '127.0.0.1'),
    () => globalThis.fetch('http://127.0.0.1'), () => http.createServer().listen(0),
    () => https.createServer().listen(0),
  ]) assert.throws(call, /Real process\/network access is blocked/u);
});

test('真实OmO Reviewer材料绝对路径回执在同一系统临时目录别名下可安全读取', async (t) => {
  const sourceRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'omo-review-path-source-'));
  t.after(() => fsp.rm(sourceRoot, { recursive: true, force: true }));
  const content = 'synthetic immutable candidate';
  await fsp.writeFile(path.join(sourceRoot, 'index.html'), content);
  const file = { path: 'index.html', bytes: Buffer.byteLength(content), sha256: sha256Buffer(Buffer.from(content)) };
  const candidateSha256 = sha256Text(`${file.path}:${file.sha256}`);
  const diffText = 'synthetic immutable diff';
  let reviewerPrompt = '';
  let verifiedManifest = null;
  const result = await runIndependentReviewerWithOmo({
    task: { id: 'isolated-review-task', title: 'isolated reviewer path', goalVersionId: 'goal-1', statement: 'inspect candidate', successCriteria: [], boundaries: [] },
    project: { projectId: 'isolated-review-project', scopeFingerprint: 'a'.repeat(64), allowedWritePaths: [] },
    worktreePath: sourceRoot, candidateSha256, diffSha256: sha256Text(diffText), patchText: diffText,
    changedFiles: [file], candidateFilesMap: { 'index.html': { ...file, content } },
    checks: [{ status: 'passed', name: 'isolated fixture', summary: 'passed' }],
    runRole: async ({ prompt, workspacePath }) => {
      reviewerPrompt = prompt;
      const manifestPath = path.join(workspacePath, 'manifest.json');
      const manifestBytes = await fsp.readFile(manifestPath);
      verifiedManifest = { bytes: manifestBytes.length, sha256: sha256Buffer(manifestBytes) };
      assert.equal(workspacePath, await fsp.realpath(workspacePath));
      assert.ok(prompt.includes(manifestPath));
      const cliOutput = { content: [{ type: 'toolCall', name: 'read', arguments: { path: manifestPath, offset: null, limit: null } }] };
      const decision = parseCodexDecisionOutput(JSON.stringify(cliOutput), [{ name: 'read' }]);
      await guardWorkspaceToolCalls(decision, { role: 'Reviewer', rootPath: workspacePath });
      assert.equal((await fsp.readFile(decision.content[0].arguments.path, 'utf8')).includes('isolated-review-task'), true);
      return { output: { text: 'VERDICT: PASS\nThe isolated candidate was checked.' } };
    },
  });
  assert.equal(result.passed, true);
  assert.match(reviewerPrompt, /宿主完整性核验（调用前）：通过/u);
  assert.ok(verifiedManifest);
  assert.ok(reviewerPrompt.includes(`只读清单为 ${verifiedManifest.bytes} UTF-8 字节，SHA-256=${verifiedManifest.sha256}`));
  assert.match(reviewerPrompt, new RegExp(`candidateSha256=${candidateSha256}`, 'u'));
  assert.match(reviewerPrompt, new RegExp(`SHA-256=${sha256Text(diffText)}`, 'u'));
  assert.match(reviewerPrompt, /无需自行重算散列或字节数/u);
  assert.match(reviewerPrompt, /独立阅读完整差异和每个候选源码文件/u);
  assert.match(reviewerPrompt, /不得预设 PASS 或 FAIL/u);
  assert.match(reviewerPrompt, /页面\/UI行为必须标为未实测/u);
});

test('Reviewer 宿主拒绝缺失或不匹配材料，读失败与审阅中篡改均不产生 PASS，业务 FAIL 原样保留', async (t) => {
  const sourceRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'omo-review-integrity-source-'));
  t.after(() => fsp.rm(sourceRoot, { recursive: true, force: true }));
  const content = 'synthetic integrity candidate';
  await fsp.writeFile(path.join(sourceRoot, 'index.html'), content);
  const file = { path: 'index.html', bytes: Buffer.byteLength(content), sha256: sha256Buffer(Buffer.from(content)) };
  const candidateSha256 = sha256Text(`${file.path}:${file.sha256}`);
  const diffText = 'synthetic integrity diff';
  const base = {
    task: { id: 'integrity-task', title: 'integrity fixture', goalVersionId: 'goal-integrity', statement: 'inspect candidate', successCriteria: [], boundaries: [] },
    project: { projectId: 'integrity-project', scopeFingerprint: 'b'.repeat(64), allowedWritePaths: [] },
    worktreePath: sourceRoot, candidateSha256, diffSha256: sha256Text(diffText), patchText: diffText,
    changedFiles: [file], candidateFilesMap: { 'index.html': { ...file, content } },
    checks: [{ status: 'passed', name: 'isolated host check', summary: 'passed' }],
  };
  let roleInvoked = false;
  const forbiddenReviewer = async () => { roleInvoked = true; return { output: { text: 'VERDICT: PASS' } }; };

  const missing = await runIndependentReviewerWithOmo({ ...base, candidateFilesMap: null, runRole: forbiddenReviewer });
  await fsp.rm(path.join(sourceRoot, 'index.html'));
  const missingSource = await runIndependentReviewerWithOmo({ ...base, runRole: forbiddenReviewer });
  await fsp.writeFile(path.join(sourceRoot, 'index.html'), content);
  const candidateMismatch = await runIndependentReviewerWithOmo({ ...base, candidateSha256: '0'.repeat(64), runRole: forbiddenReviewer });
  const diffMismatch = await runIndependentReviewerWithOmo({ ...base, diffSha256: '1'.repeat(64), runRole: forbiddenReviewer });
  assert.equal(missing.invoked, false);
  assert.equal(missingSource.invoked, false);
  assert.equal(missingSource.nativeVerdict, 'UNVERIFIED');
  assert.equal(candidateMismatch.invoked, false);
  assert.equal(diffMismatch.invoked, false);
  assert.equal(roleInvoked, false);

  const unreadable = await runIndependentReviewerWithOmo({
    ...base,
    runRole: async ({ workspacePath }) => {
      const manifestPath = path.join(workspacePath, 'manifest.json');
      await fsp.chmod(workspacePath, 0o755);
      await fsp.rm(manifestPath);
      await assert.rejects(fsp.readFile(manifestPath, 'utf8'), { code: 'ENOENT' });
      return { output: { text: 'VERDICT: UNVERIFIED\nThe bound manifest could not be read.' } };
    },
  });
  assert.equal(unreadable.passed, false);
  assert.equal(unreadable.nativeVerdict, 'UNVERIFIED');

  const tampered = await runIndependentReviewerWithOmo({
    ...base,
    runRole: async ({ workspacePath }) => {
      const candidatePath = path.join(workspacePath, 'candidate', 'index.html');
      await fsp.chmod(candidatePath, 0o644);
      await fsp.writeFile(candidatePath, `${content}\nmodified while reviewing`);
      return { output: { text: 'VERDICT: PASS\nThe untrusted output must not be adopted.' } };
    },
  });
  assert.equal(tampered.passed, false);
  assert.equal(tampered.nativeVerdict, 'UNVERIFIED');
  assert.match(tampered.summary, /材料发生变化/u);

  const businessFail = await runIndependentReviewerWithOmo({
    ...base,
    runRole: async () => ({ output: { text: 'VERDICT: FAIL\nA confirmed functional defect remains.' } }),
  });
  assert.equal(businessFail.passed, false);
  assert.equal(businessFail.nativeVerdict, 'FAIL');
  assert.equal(businessFail.scopeOutcome, 'findings');
  assert.match(businessFail.text, /confirmed functional defect/u);
});

test('preferLocalFallback无审阅副本时不声称完整性通过，也不调用模型', async (t) => {
  const content = '<!doctype html><title>Local-only candidate</title>\n';
  const fileSha256 = sha256Buffer(Buffer.from(content));
  const candidateSha256 = sha256Text(`index.html:${fileSha256}`);
  const diffText = 'diff --git a/index.html b/index.html\n+Local-only candidate\n';
  const worktreePath = await fsp.mkdtemp(path.join(os.tmpdir(), 'omo-review-local-fallback-'));
  await fsp.writeFile(path.join(worktreePath, 'index.html'), content);
  t.after(() => fsp.rm(worktreePath, { recursive: true, force: true }));
  let modelCalled = false;
  const result = await runIndependentReviewerWithOmo({
    task: { id: 'local-fallback-task', title: 'local fallback', goalVersionId: 'goal-local', statement: 'test', successCriteria: [], boundaries: [] },
    project: { projectId: 'local-fallback-project', scopeFingerprint: 'c'.repeat(64), allowedWritePaths: ['index.html'] },
    worktreePath, candidateSha256, diffSha256: sha256Text(diffText), patchText: diffText,
    changedFiles: [{ path: 'index.html', bytes: Buffer.byteLength(content), sha256: fileSha256 }],
    candidateFilesMap: { 'index.html': { path: 'index.html', bytes: Buffer.byteLength(content), sha256: fileSha256, content } },
    checks: [{ status: 'passed', name: 'isolated host check', summary: 'passed' }],
    preferLocalFallback: true,
    runRole: async () => { modelCalled = true; throw new Error('fallback must not invoke a model'); },
  });
  assert.equal(modelCalled, false);
  assert.equal(result.nativeVerdict, 'PASS');
  assert.match(result.text, /本地固定检查报告（非模型 Reviewer）/u);
  assert.doesNotMatch(result.text, /宿主完整性核验（调用前）：通过|只读清单为 undefined/u);
});

async function fixture(t, { reviewerText = 'VERDICT: PASS\nIsolated round passed.', omoSteps = 1,
  oldReviewText = 'VERDICT: UNVERIFIED\nOriginal Reviewer timed out.', waitDecisionForAbort = false } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'omo-review-round-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const runtimeDir = path.join(root, 'runtime');
  const projectRoot = path.join(root, 'project');
  const worktreePath = path.join(root, 'worktree');
  await Promise.all([fsp.mkdir(projectRoot), fsp.mkdir(worktreePath)]);
  const content = '<!doctype html><title>Frozen review candidate</title>\n';
  await Promise.all([
    fsp.writeFile(path.join(projectRoot, 'index.html'), content),
    fsp.writeFile(path.join(worktreePath, 'index.html'), content),
  ]);
  const bytes = Buffer.from(content);
  const file = { path: 'index.html', bytes: bytes.length, sha256: sha256Buffer(bytes) };
  const candidateSha256 = sha256Text(`${file.path}:${file.sha256}`);
  const patch = 'diff --git a/index.html b/index.html\n+Frozen review candidate\n';
  const diffSha256 = sha256Text(patch);
  const project = { projectId: 'round-fixture', label: 'Isolated fixture', rootPath: projectRoot,
    scopeFingerprint: 'a'.repeat(64), allowedWritePaths: ['index.html'] };

  let beforeAcceptResult = null;
  let activeReviewerText = reviewerText;
  const codexRoleRunner = async (request) => {
    const reservation = await request.reserve({ role: request.role, binding: request.binding,
      idempotencyKey: request.idempotencyKey, deadlineAt: request.deadlineAt,
      promptSha256: sha256Text(request.prompt), promptUtf8Bytes: Buffer.byteLength(request.prompt) });
    if (!reservation?.created) return { status: 'reservation_rejected', workCompleted: false };
    await request.recordCliSpawn(reservation);
    await request.recordTurnStarted(reservation);
    if (waitDecisionForAbort) {
      if (request.signal.aborted) await Promise.resolve();
      else await new Promise((resolve) => request.signal.addEventListener('abort', resolve, { once: true }));
    }
    const output = { text: activeReviewerText };
    await beforeAcceptResult?.();
    const workCompleted = await request.acceptResult(output, { role: request.role, binding: request.binding });
    const outcome = { status: workCompleted ? 'model_returned' : 'host_validation_failed', workCompleted,
      roleCallReserved: true, cliSpawned: true, turnStarted: true, providerRequestCount: null, output };
    await request.settle(reservation, outcome);
    return outcome;
  };
  let sequence = 0;
  const omoRoleRunner = async ({ role, prompt, runModelDecision, signal }) => {
    let response = '';
    for (let ordinal = 1; ordinal <= omoSteps; ordinal += 1) {
      response = await runModelDecision({ provider: 'isolated-test', modelId: 'gpt-6-luna',
        systemPrompt: 'isolated', messages: [{ role: 'user', content: `${prompt}\nstep ${ordinal}` }],
        tools: ['read', 'grep', 'find', 'ls'].map((name) => ({ name, parameters: { type: 'object' } })) }, ordinal, signal);
    }
    sequence += 1;
    return { status: 'model_returned', output: { text: activeReviewerText }, provider: 'isolated-test', model: 'gpt-6-luna',
      providerCalls: omoSteps, sessionId: `isolated-review-session-${sequence}` };
  };
  const hostChecksRunner = async ({ worktreePath: candidatePath }) => ({
    checks: [{ id: 'fixture-check', name: 'isolated fixture check', status: 'passed', summary: 'passed' }],
    currentFilesMap: await readRelativeFileMap(candidatePath),
  });
  const { controller, server } = await createOmoPilotServer({ runtimeDir, preferLocalFallback: false,
    codexRoleRunner, omoRoleRunner, hostChecksRunner });
  controller.modelStatus = () => ({ liveExecutionBlocked: false });
  controller.listRegisteredProjects = async () => [project];

  const taskId = 'task-review-round-fixture';
  const goalVersionId = 'goal-review-round-fixture';
  const executionId = 'run-review-round-fixture';
  const registrySha256 = 'b'.repeat(64);
  const artifactId = 'artifact-review-round-fixture';
  const dispatchEventId = 'dispatch-review-timeout';
  const failedCallId = 'call-original-reviewer-failed';
  const selectedScope = { projectId: project.projectId, scopeFingerprint: project.scopeFingerprint,
    goalVersionId, current: true, authorized: true };
  const task = {
    id: taskId, title: 'Review round fixture', statement: 'Preserve and re-review one exact candidate.',
    successCriteria: ['Keep the same candidate and record the independent result.'], boundaries: ['Do not change the candidate.'],
    goalVersionId, selectedScope,
    registry: { registrySha256, projectId: project.projectId, scopeFingerprint: project.scopeFingerprint,
      current: true, bindingCurrent: true, status: 'registered' },
    execution: { id: executionId, bindingCurrent: true, phase: 'partial', status: 'waiting_user',
      stopReason: 'execution_deadline_elapsed', deadline: new Date(Date.now() - 60_000).toISOString(),
      reviewerAgentId: 'reviewer-fixture', modelCalls: [], sessions: [], omoSessions: [], workItems: [],
      reviewContinuation: { status: 'blocked_or_failed', dispatchEventId, artifactId, artifactVersion: 1, candidateSha256 } },
    artifacts: [], activeArtifactId: artifactId,
  };
  for (let index = 1; index <= 6; index += 1) task.execution.modelCalls.push({ id: `call-prior-${index}`, role: 'Developer', status: 'completed' });
  task.execution.modelCalls.push({ id: failedCallId, role: 'Reviewer', status: 'failed',
    binding: { taskId, goalVersionId, executionId, registrySha256, artifactId, artifactVersion: 1, candidateSha256, diffSha256 } });
  task.execution.sessions.push({ role: 'Reviewer', phase: 'review:provider-decision', status: 'failed',
    modelCallId: failedCallId, eventId: dispatchEventId });
  task.artifacts.push({ id: artifactId, version: 1, goalVersionId, executionId, registrySha256,
    worktreePath, candidateSha256, diffSha256, patchSha256: diffSha256, patch, changedFiles: [{ path: 'index.html' }],
    files: [file], hostCheck: { passed: true, checks: [{ id: 'fixture-check', passed: true }] },
    review: { id: 'review-original-timeout', passed: false, nativeVerdict: 'UNVERIFIED', scopeOutcome: 'unverified',
      text: oldReviewText, fullOutputSha256: sha256Text(oldReviewText), sourceEvidence: null }, confirmation: null });
  controller.state.tasks.push(task);
  controller.state.activeTaskId = taskId;
  await controller.save();
  return { controller, server, task, project, oldReviewText, expectedOldCalls: structuredClone(task.execution.modelCalls),
    originalDeadline: task.execution.deadline, candidateSha256, diffSha256, taskId, goalVersionId, executionId,
    registrySha256, artifactId, previousReviewId: task.artifacts[0].review.id, scopeFingerprint: project.scopeFingerprint,
    setBeforeAcceptResult(callback) { beforeAcceptResult = callback; },
    setReviewerText(text) { activeReviewerText = text; } };
}

function openPayload(f, requestId = 'open-round-request-1') {
  const previousRound = f.task.execution.reviewRounds?.filter((item) => item.binding?.artifactId === f.artifactId).at(-1) || null;
  return { action: 'open_review_round', requestId, expectedTaskId: f.taskId,
    expectedGoalVersionId: f.goalVersionId, expectedExecutionId: f.executionId, expectedRegistrySha256: f.registrySha256,
    expectedScopeFingerprint: f.scopeFingerprint, expectedArtifactId: f.artifactId, expectedArtifactVersion: 1,
    expectedCandidateSha256: f.candidateSha256, expectedDiffSha256: f.diffSha256, expectedReviewId: f.task.artifacts[0].review?.id || null,
    expectedPreviousReviewRoundId: previousRound?.id || null };
}

function reviewPayload(f, round, requestId = 'review-round-request-1') {
  return { action: 'review', requestId, expectedReviewRoundId: round.id, expectedTaskId: f.taskId,
    expectedGoalVersionId: f.goalVersionId, expectedExecutionId: f.executionId, expectedRegistrySha256: f.registrySha256,
    expectedScopeFingerprint: f.scopeFingerprint, expectedArtifactId: f.artifactId, expectedArtifactVersion: 1,
    expectedCandidateSha256: f.candidateSha256, expectedDiffSha256: f.diffSha256,
    expectedReviewId: round.expectedReviewId, expectedPreviousReviewRoundId: round.binding.previousReviewRoundId || null };
}

function postAction(f, payload) {
  return new Promise((resolve, reject) => {
    const request = Readable.from([Buffer.from(JSON.stringify(payload))]);
    request.method = 'POST';
    request.url = `/api/product/tasks/${encodeURIComponent(f.taskId)}/actions`;
    request.headers = { host: '127.0.0.1:3848', origin: 'http://127.0.0.1:3848', 'content-type': 'application/json' };
    request.socket = { remoteAddress: '127.0.0.1' };
    const response = {
      statusCode: 200,
      headers: {},
      setHeader(key, value) { this.headers[key] = value; },
      writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers); },
      end(body) {
        try { resolve({ status: this.statusCode, body: JSON.parse(String(body)) }); }
        catch (error) { reject(error); }
      },
    };
    f.server.emit('request', request, response);
  });
}

test('显式开启后继审阅轮幂等且不改写原调用账与截止', async (t) => {
  const f = await fixture(t);
  const payload = openPayload(f);
  const first = await f.controller.handleTaskAction(f.taskId, payload);
  const second = await f.controller.handleTaskAction(f.taskId, payload);
  assert.equal(first.status, 'open');
  assert.equal(first.maxModelCalls, 8);
  assert.equal(first.modelCalls, 0);
  assert.equal(second.reviewRoundId, first.reviewRoundId);
  assert.equal(second.idempotentReplay, true);
  assert.equal(f.task.execution.reviewRounds.length, 1);
  assert.deepEqual(f.task.execution.modelCalls, f.expectedOldCalls);
  assert.equal(f.task.execution.deadline, f.originalDeadline);
  const state = await f.controller.buildProductState(f.taskId);
  assert.equal(state.native.reviewRound.maxModelCalls, 8);
  assert.equal(state.native.reviewRoundOffer, null);
});

test('正式同版FAIL后只允许显式开启新审阅轮；保留旧FAIL、调用账与截止，且旧请求仍幂等', async (t) => {
  const f = await fixture(t, { reviewerText: 'VERDICT: FAIL\nThe bound candidate still has a blocking defect.' });
  const initialGrant = openPayload(f, 'grant-initial-formal-fail');
  await f.controller.handleTaskAction(f.taskId, initialGrant);
  const failedReviewRound = f.task.execution.reviewRounds[0];
  const firstReview = await f.controller.handleTaskAction(f.taskId,
    reviewPayload(f, failedReviewRound, 'review-initial-formal-fail'));
  const oldFail = structuredClone(f.task.artifacts[0].review);
  assert.equal(firstReview.verdict, 'FAIL');
  assert.equal(failedReviewRound.status, 'completed');
  assert.equal(oldFail.nativeVerdict, 'FAIL');

  const before = normalizeNativeProductState(await f.controller.buildProductState(f.taskId));
  assert.equal(before.native.actions.canOpenReviewRound, true);
  assert.equal(before.native.actions.canReviewSameRun, false);
  assert.equal(before.native.actions.canReview, false);
  assert.deepEqual(f.task.execution.modelCalls, f.expectedOldCalls);
  assert.equal(f.task.execution.deadline, f.originalDeadline);

  const followupGrant = nativeActionPayload(before, 'open_review_round', { requestId: 'grant-after-formal-fail' });
  assert.equal(followupGrant.expectedReviewId, oldFail.id);
  assert.equal(followupGrant.expectedPreviousReviewRoundId, failedReviewRound.id);
  const openResponse = await postAction(f, followupGrant);
  assert.equal(openResponse.status, 200);
  const opened = openResponse.body;
  const secondReviewRound = f.task.execution.reviewRounds[1];
  assert.equal(opened.status, 'open');
  assert.equal(opened.maxModelCalls, 8);
  assert.equal(opened.modelCalls, 0);
  assert.equal(secondReviewRound.binding.previousReviewId, oldFail.id);
  assert.equal(secondReviewRound.binding.previousReviewRoundId, failedReviewRound.id);
  assert.equal(f.task.artifacts[0].review.id, oldFail.id);
  assert.equal(f.task.artifacts[0].review.text, oldFail.text);
  assert.equal(f.task.artifacts[0].reviewHistory.at(-1).text, f.oldReviewText);
  assert.deepEqual(f.task.execution.modelCalls, f.expectedOldCalls);
  assert.equal(f.task.execution.deadline, f.originalDeadline);
  await assert.rejects(f.controller.handleTaskAction(f.taskId,
    { ...followupGrant, expectedCandidateSha256: 'f'.repeat(64) }), /同一开启请求编号已绑定其他审阅轮/u);
  assert.equal(secondReviewRound.modelCalls.length, 0);

  f.setReviewerText('VERDICT: PASS\nThe exact candidate now passes.');
  const secondResult = await f.controller.handleTaskAction(f.taskId,
    reviewPayload(f, secondReviewRound, 'review-followup-pass'));
  assert.equal(secondResult.verdict, 'PASS');
  const replay = await f.controller.handleTaskAction(f.taskId, followupGrant);
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.reviewRoundId, opened.reviewRoundId);
  assert.equal(f.task.execution.reviewRounds.length, 2);
  assert.equal(secondReviewRound.modelCalls.length, 1);
  assert.equal(f.task.artifacts[0].reviewHistory.at(-1).id, oldFail.id);
  assert.equal(f.task.artifacts[0].reviewHistory.find((item) => item.id === oldFail.id).text, oldFail.text);
});

test('正式FAIL后的新审阅轮拒绝PASS、确认、范围或候选变化及在途调用', async (t) => {
  const makeFailedCandidate = async (st, reviewerText = 'VERDICT: FAIL\nA blocker remains.') => {
    const f = await fixture(st, { reviewerText });
    await f.controller.handleTaskAction(f.taskId, openPayload(f, 'initial-grant'));
    const round = f.task.execution.reviewRounds[0];
    await f.controller.handleTaskAction(f.taskId, reviewPayload(f, round, 'initial-review'));
    return f;
  };

  await t.test('PASS不可再次开启', async (st) => {
    const f = await makeFailedCandidate(st, 'VERDICT: PASS\nThe candidate passes.');
    const projection = normalizeNativeProductState(await f.controller.buildProductState(f.taskId));
    assert.equal(projection.native.actions.canOpenReviewRound, false);
    await assert.rejects(f.controller.handleTaskAction(f.taskId, openPayload(f, 'forbidden-after-pass')),
      /当前审阅失败、候选或授权范围不满足/u);
    assert.equal(f.task.execution.reviewRounds.length, 1);
  });

  for (const staleState of ['execution-binding', 'registry-current', 'registry-binding', 'registry-status']) {
    await t.test(`${staleState}失效时前端不生成开轮载荷且HTTP拒绝`, async (st) => {
      const f = await makeFailedCandidate(st);
      if (staleState === 'execution-binding') f.task.execution.bindingCurrent = false;
      if (staleState === 'registry-current') f.task.registry.current = false;
      if (staleState === 'registry-binding') f.task.registry.bindingCurrent = false;
      if (staleState === 'registry-status') f.task.registry.status = 'stale';
      const projection = normalizeNativeProductState(await f.controller.buildProductState(f.taskId));
      assert.equal(projection.native.actions.canOpenReviewRound, false);
      assert.throws(() => nativeActionPayload(projection, 'open_review_round', { requestId: `blocked-${staleState}` }), /未开放/u);
      const response = await postAction(f, openPayload(f, `blocked-${staleState}`));
      assert.equal(response.status, 409);
      assert.equal(f.task.execution.reviewRounds.length, 1);
    });
  }

  for (const mutation of ['confirmed', 'registry', 'scope', 'candidate', 'artifact-version', 'diff', 'missing-review-source', 'active-call']) {
    await t.test(`${mutation}绑定/状态变化时拒绝`, async (st) => {
      const f = await makeFailedCandidate(st);
      const payload = openPayload(f, `forbidden-${mutation}`);
      if (mutation === 'confirmed') f.task.artifacts[0].confirmation = { confirmedAt: new Date().toISOString() };
      if (mutation === 'registry') f.task.registry.registrySha256 = 'c'.repeat(64);
      if (mutation === 'scope') f.task.selectedScope.scopeFingerprint = 'd'.repeat(64);
      if (mutation === 'candidate') f.task.artifacts[0].candidateSha256 = 'e'.repeat(64);
      if (mutation === 'artifact-version') f.task.artifacts[0].version += 1;
      if (mutation === 'diff') f.task.artifacts[0].diffSha256 = 'f'.repeat(64);
      if (mutation === 'missing-review-source') f.task.artifacts[0].review.sourceEvidence = null;
      if (mutation === 'active-call') f.task.execution.modelCalls.push({ id: 'active-native-call', role: 'Developer', status: 'running' });
      const projection = normalizeNativeProductState(await f.controller.buildProductState(f.taskId));
      assert.equal(projection.native.actions.canOpenReviewRound, false);
      await assert.rejects(f.controller.handleTaskAction(f.taskId, payload),
        /当前审阅失败、候选或授权范围不满足/u);
      assert.equal(f.task.execution.reviewRounds.length, 1);
    });
  }

  await t.test('上一审阅轮仍在途时不得并发开额度', async (st) => {
    const f = await makeFailedCandidate(st);
    const activeId = 'review-round-active-fixture';
    f.task.execution.reviewRounds.push({ id: activeId, status: 'open', deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      maxModelCalls: 8, modelCalls: [], binding: { taskId: f.taskId, goalVersionId: f.goalVersionId,
        executionId: f.executionId, registrySha256: f.registrySha256, scopeFingerprint: f.scopeFingerprint,
        artifactId: f.artifactId, artifactVersion: 1, candidateSha256: f.candidateSha256,
        diffSha256: f.diffSha256, previousReviewId: f.task.artifacts[0].review.id,
        previousReviewRoundId: f.task.execution.reviewRounds[0].id } });
    const projection = normalizeNativeProductState(await f.controller.buildProductState(f.taskId));
    assert.equal(projection.native.actions.canOpenReviewRound, false);
    await assert.rejects(f.controller.handleTaskAction(f.taskId, openPayload(f, 'forbidden-in-flight-round')),
      /前一后续审阅轮尚未结清/u);
    assert.equal(f.task.execution.reviewRounds.length, 2);
  });

  await t.test('新轮超过自己的截止后拒绝Reviewer调用且不影响旧执行期限', async (st) => {
    const f = await makeFailedCandidate(st);
    await f.controller.handleTaskAction(f.taskId, openPayload(f, 'grant-expiring-followup'));
    const round = f.task.execution.reviewRounds.at(-1);
    round.deadlineAt = new Date(Date.now() - 1_000).toISOString();
    const binding = { taskId: f.taskId, goalVersionId: f.goalVersionId, executionId: f.executionId,
      registrySha256: f.registrySha256, workItemId: `work-review-${round.id}-expired`, artifactId: f.artifactId,
      artifactVersion: 1, candidateSha256: f.candidateSha256, diffSha256: f.diffSha256,
      scopeFingerprint: f.scopeFingerprint, reviewRoundId: round.id, reviewRoundRequestId: round.requestId,
      previousReviewId: round.expectedReviewId };
    const reserved = await f.controller.reserveCodexRoleStart(f.task, { role: 'Reviewer', binding,
      idempotencyKey: 'expired-reviewer-call', deadlineAt: round.deadlineAt,
      promptSha256: 'a'.repeat(64), promptUtf8Bytes: 1 });
    assert.equal(reserved.created, false);
    assert.equal(reserved.reason, 'stale_or_expired_binding');
    assert.equal(round.modelCalls.length, 0);
    assert.deepEqual(f.task.execution.modelCalls, f.expectedOldCalls);
    assert.equal(f.task.execution.deadline, f.originalDeadline);
  });
});

test('同一 OmO Reviewer 流程将8次CLI预算记在新轮并归档旧报告，确认只看同版新PASS', async (t) => {
  const f = await fixture(t, { omoSteps: 3 });
  const opened = await f.controller.handleTaskAction(f.taskId, openPayload(f));
  const round = f.task.execution.reviewRounds[0];
  const result = await f.controller.handleTaskAction(f.taskId, reviewPayload(f, round));
  assert.equal(result.reviewRoundId, opened.reviewRoundId);
  assert.equal(result.verdict, 'PASS');
  assert.equal(round.status, 'completed');
  assert.equal(round.maxModelCalls, 8);
  assert.equal(round.modelCalls.length, 3);
  assert.ok(round.modelCalls.every((call) => call.binding.reviewRoundId === round.id
    && call.binding.reviewRoundRequestId === round.requestId && call.binding.previousReviewId === f.previousReviewId));
  assert.deepEqual(f.task.execution.modelCalls, f.expectedOldCalls);
  assert.equal(f.task.execution.deadline, f.originalDeadline);
  assert.equal(f.task.artifacts[0].reviewHistory.length, 1);
  assert.equal(f.task.artifacts[0].reviewHistory[0].text, f.oldReviewText);
  assert.equal(f.task.artifacts[0].review.nativeVerdict, 'PASS');
  assert.equal(f.task.artifacts[0].review.sourceEvidence.reviewRoundId, round.id);
  const productState = await f.controller.buildProductState(f.taskId);
  assert.equal(productState.native.actions.canConfirm, true);
  const normalized = normalizeNativeProductState(productState);
  assert.equal(normalized.artifact.reviewHistory[0].text, f.oldReviewText);
  const replay = await f.controller.handleTaskAction(f.taskId, reviewPayload(f, round));
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.reviewId, result.reviewId);
  assert.equal(round.modelCalls.length, 3);
});

test('空正文的旧UNVERIFIED审阅仍保留历史条目并可显示失败占位', async (t) => {
  const f = await fixture(t, { oldReviewText: '' });
  await f.controller.handleTaskAction(f.taskId, openPayload(f));
  const round = f.task.execution.reviewRounds[0];
  await f.controller.handleTaskAction(f.taskId, reviewPayload(f, round));
  const normalized = normalizeNativeProductState(await f.controller.buildProductState(f.taskId));
  assert.equal(normalized.artifact.reviewHistory.length, 1);
  assert.equal(normalized.artifact.reviewHistory[0].nativeVerdict, 'UNVERIFIED');
  assert.equal(normalized.artifact.reviewHistory[0].text, null);
});

test('绑定变化或重放其他旧轮回执不能替换当前审阅', async (t) => {
  const f = await fixture(t);
  const opened = await f.controller.handleTaskAction(f.taskId, openPayload(f));
  const round = f.task.execution.reviewRounds[0];
  const invalid = reviewPayload(f, round);
  invalid.expectedDiffSha256 = 'c'.repeat(64);
  await assert.rejects(f.controller.handleTaskAction(f.taskId, invalid), /候选、旧审阅或授权范围不一致/u);
  assert.equal(round.modelCalls.length, 0);
  assert.equal(round.status, 'open');
  assert.equal(f.task.artifacts[0].review.id, f.previousReviewId);
  assert.equal(opened.reviewRoundId, round.id);
});

test('真实候选版本或当前旧审阅变化时，在途结果采纳与下一次调用预留均拒绝陈旧绑定', async (t) => {
  for (const mutation of ['artifact-version', 'previous-review']) {
    await t.test(`${mutation} 在结果返回前变化`, async (st) => {
      const f = await fixture(st);
      const opened = await f.controller.handleTaskAction(f.taskId, openPayload(f));
      const round = f.task.execution.reviewRounds[0];
      const priorReview = structuredClone(f.task.artifacts[0].review);
      f.setBeforeAcceptResult(() => {
        if (mutation === 'artifact-version') f.task.artifacts[0].version += 1;
        else f.task.artifacts[0].review.id = 'review-replaced-during-flight';
      });
      await assert.rejects(f.controller.handleTaskAction(f.taskId, reviewPayload(f, round)), /未采纳/u);
      assert.equal(f.task.artifacts[0].review.nativeVerdict, priorReview.nativeVerdict);
      assert.equal(f.task.artifacts[0].review.text, priorReview.text);
      if (mutation === 'previous-review') assert.equal(f.task.artifacts[0].review.id, 'review-replaced-during-flight');
      else assert.equal(f.task.artifacts[0].review.id, priorReview.id);
      assert.notEqual(f.task.artifacts[0].review.nativeVerdict, 'PASS');
      assert.equal(round.status, 'stale');
      assert.equal(opened.reviewRoundId, round.id);
    });
    await t.test(`${mutation} 在下一次调用预留前变化`, async (st) => {
      const f = await fixture(st);
      await f.controller.handleTaskAction(f.taskId, openPayload(f));
      const round = f.task.execution.reviewRounds[0];
      const binding = { taskId: f.taskId, goalVersionId: f.goalVersionId, executionId: f.executionId,
        registrySha256: f.registrySha256, workItemId: `work-review-${round.id}-stale-check`, artifactId: f.artifactId,
        artifactVersion: 1, candidateSha256: f.candidateSha256, diffSha256: f.diffSha256,
        scopeFingerprint: f.scopeFingerprint, reviewRoundId: round.id, reviewRoundRequestId: round.requestId,
        previousReviewId: f.previousReviewId };
      await f.controller.reserveCodexRoleStart(f.task, { role: 'Reviewer', binding,
        idempotencyKey: 'first-decision', deadlineAt: round.deadlineAt,
        promptSha256: 'a'.repeat(64), promptUtf8Bytes: 1 });
      const callCount = round.modelCalls.length;
      if (mutation === 'artifact-version') f.task.artifacts[0].version += 1;
      else f.task.artifacts[0].review.id = 'review-replaced-between-decisions';
      const rejected = await f.controller.reserveCodexRoleStart(f.task, { role: 'Reviewer', binding,
        idempotencyKey: 'next-decision', deadlineAt: round.deadlineAt,
        promptSha256: 'b'.repeat(64), promptUtf8Bytes: 1 });
      assert.equal(rejected.created, false);
      assert.equal(rejected.reason, 'stale_or_expired_binding');
      assert.equal(round.modelCalls.length, callCount);
      assert.notEqual(f.task.artifacts[0].review.nativeVerdict, 'PASS');
    });
  }
});

test('8次真实调用额度只计入后继轮，第9次预留被拒绝', async (t) => {
  const f = await fixture(t);
  await f.controller.handleTaskAction(f.taskId, openPayload(f));
  const round = f.task.execution.reviewRounds[0];
  const binding = { taskId: f.taskId, goalVersionId: f.goalVersionId, executionId: f.executionId,
    registrySha256: f.registrySha256, workItemId: `work-review-${round.id}-limit-test`, artifactId: f.artifactId,
    artifactVersion: 1, candidateSha256: f.candidateSha256, diffSha256: f.diffSha256,
    scopeFingerprint: f.scopeFingerprint, reviewRoundId: round.id, reviewRoundRequestId: round.requestId,
    previousReviewId: f.previousReviewId };
  for (let ordinal = 1; ordinal <= 8; ordinal += 1) {
    const result = await f.controller.reserveCodexRoleStart(f.task, { role: 'Reviewer', binding,
      idempotencyKey: `isolated-call-${ordinal}`, deadlineAt: round.deadlineAt,
      promptSha256: ordinal.toString(16).padStart(64, '0'), promptUtf8Bytes: 1 });
    assert.equal(result.created, true);
    assert.equal(round.modelCalls.at(-1).callOrdinal, ordinal);
    round.modelCalls.at(-1).status = 'completed';
  }
  const ninth = await f.controller.reserveCodexRoleStart(f.task, { role: 'Reviewer', binding,
    idempotencyKey: 'isolated-call-9', deadlineAt: round.deadlineAt,
    promptSha256: '9'.repeat(64), promptUtf8Bytes: 1 });
  assert.equal(ninth.created, false);
  assert.equal(ninth.reason, 'budget_or_concurrency_limit');
  assert.equal(round.modelCalls.length, 8);
  assert.deepEqual(f.task.execution.modelCalls, f.expectedOldCalls);
  assert.equal(f.task.execution.deadline, f.originalDeadline);
});

test('取消只绑定并终止当前审阅轮，abort在途调用且保留原执行账与截止', async (t) => {
  const f = await fixture(t, { waitDecisionForAbort: true });
  await f.controller.handleTaskAction(f.taskId, openPayload(f));
  const round = f.task.execution.reviewRounds[0];
  const reviewing = f.controller.handleTaskAction(f.taskId, reviewPayload(f, round));
  for (let attempt = 0; attempt < 50 && !f.controller.reviewRoundAbortControllers.has(round.id); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  const abortController = f.controller.reviewRoundAbortControllers.get(round.id);
  assert.ok(abortController);
  const projection = normalizeNativeProductState(await f.controller.buildProductState(f.taskId));
  assert.equal(projection.native.actions.canCancel, true);
  const payload = nativeActionPayload(projection, 'cancel', { requestId: 'cancel-round-1' });
  assert.equal(payload.expectedReviewRoundId, round.id);
  assert.equal(payload.expectedTaskId, f.taskId);
  assert.equal(payload.expectedGoalVersionId, f.goalVersionId);
  assert.equal(payload.expectedExecutionId, f.executionId);
  assert.equal(payload.expectedRegistrySha256, f.registrySha256);
  assert.equal(payload.expectedScopeFingerprint, f.scopeFingerprint);
  assert.equal(payload.expectedCandidateSha256, f.candidateSha256);
  assert.equal(payload.expectedDiffSha256, f.diffSha256);
  const staleCancel = await postAction(f, { ...payload, expectedScopeFingerprint: 'c'.repeat(64) });
  assert.equal(staleCancel.status, 409);
  assert.match(JSON.stringify(staleCancel.body), /取消请求与当前审阅轮/u);
  assert.equal(round.status, 'running');
  assert.equal(abortController.signal.aborted, false);
  const cancelled = await postAction(f, payload);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.status, 'cancelled');
  assert.equal(abortController.signal.aborted, true);
  await assert.rejects(reviewing, /未采纳/u);
  assert.equal(round.status, 'cancelled');
  assert.equal(round.modelCalls.length, 1);
  assert.equal(round.modelCalls[0].status, 'failed');
  assert.equal(f.task.artifacts[0].review.id, f.previousReviewId);
  assert.equal(f.task.artifacts[0].review.nativeVerdict, 'UNVERIFIED');
  assert.deepEqual(f.task.execution.modelCalls, f.expectedOldCalls);
  assert.equal(f.task.execution.deadline, f.originalDeadline);
  assert.equal(f.task.execution.phase, 'partial');
  const replay = await postAction(f, payload);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.idempotentReplay, true);
  assert.equal(replay.body.reviewRoundId, round.id);
  const next = await f.controller.handleTaskAction(f.taskId, openPayload(f, 'grant-after-cancel'));
  const nextRound = f.task.execution.reviewRounds.at(-1);
  assert.equal(next.status, 'open');
  assert.equal(nextRound.binding.previousReviewRoundId, round.id);
  const staleButtonReplay = await f.controller.handleTaskAction(f.taskId, payload);
  assert.equal(staleButtonReplay.reviewRoundId, round.id);
  assert.equal(nextRound.status, 'open');
});

test('Host检查失败保留旧报告后可经新的显式授权开轮；旧请求和同前驱并发仅一个额度', async (t) => {
  const f = await fixture(t);
  const firstPayload = openPayload(f, 'first-explicit-grant');
  const opened = await f.controller.handleTaskAction(f.taskId, firstPayload);
  const firstRound = f.task.execution.reviewRounds[0];
  const originalHostChecksRunner = f.controller.hostChecksRunner;
  f.controller.hostChecksRunner = async () => { throw new Error('isolated host-check failure'); };
  await assert.rejects(f.controller.handleTaskAction(f.taskId, reviewPayload(f, firstRound)), /isolated host-check failure/u);
  assert.equal(firstRound.status, 'failed');
  assert.equal(f.task.artifacts[0].review.id, f.previousReviewId);
  assert.equal(f.task.artifacts[0].review.nativeVerdict, 'UNVERIFIED');
  f.controller.hostChecksRunner = originalHostChecksRunner;
  const projected = normalizeNativeProductState(await f.controller.buildProductState(f.taskId));
  assert.equal(projected.native.actions.canOpenReviewRound, true);
  const oldReplay = await f.controller.handleTaskAction(f.taskId, firstPayload);
  assert.equal(oldReplay.reviewRoundId, opened.reviewRoundId);
  assert.equal(oldReplay.idempotentReplay, true);
  const secondPayload = openPayload(f, 'second-explicit-grant');
  assert.equal(secondPayload.expectedPreviousReviewRoundId, firstRound.id);
  const [second, duplicate] = await Promise.all([
    f.controller.handleTaskAction(f.taskId, secondPayload),
    f.controller.handleTaskAction(f.taskId, secondPayload),
  ]);
  assert.equal(second.reviewRoundId, duplicate.reviewRoundId);
  assert.equal(duplicate.idempotentReplay, true);
  assert.equal(f.task.execution.reviewRounds.length, 2);
  assert.equal(f.task.execution.reviewRounds[1].binding.previousReviewRoundId, firstRound.id);
  await assert.rejects(f.controller.handleTaskAction(f.taskId, { ...secondPayload, requestId: 'second-click-same-predecessor' }),
    /当前审阅失败、候选或授权范围不满足/u);
  assert.equal(f.task.execution.reviewRounds.length, 2);
  assert.deepEqual(f.task.execution.modelCalls, f.expectedOldCalls);
  assert.equal(f.task.execution.deadline, f.originalDeadline);
});

test('到期轮不会自动续开；仅带上一轮身份的新明确请求能开后继轮', async (t) => {
  const f = await fixture(t);
  await f.controller.handleTaskAction(f.taskId, openPayload(f, 'expiring-grant'));
  const first = f.task.execution.reviewRounds[0];
  first.deadlineAt = new Date(Date.now() - 1_000).toISOString();
  const projected = normalizeNativeProductState(await f.controller.buildProductState(f.taskId));
  assert.equal(projected.native.reviewRound.status, 'expired');
  assert.equal(f.task.execution.reviewRounds.length, 1);
  assert.equal(projected.native.actions.canOpenReviewRound, true);
  const opened = await f.controller.handleTaskAction(f.taskId, openPayload(f, 'explicit-after-expiry'));
  assert.equal(opened.status, 'open');
  assert.equal(first.status, 'expired');
  assert.equal(f.task.execution.reviewRounds.length, 2);
  assert.equal(f.task.execution.reviewRounds[1].binding.previousReviewRoundId, first.id);
});

test('执行归档会把迟到的原生OmO与CLI回执写入精确的历史审阅轮，不采纳旧结果', async (t) => {
  const f = await fixture(t);
  await f.controller.handleTaskAction(f.taskId, openPayload(f, 'archive-receipt-grant'));
  const round = f.task.execution.reviewRounds[0];
  let releaseDecision;
  f.setBeforeAcceptResult(() => new Promise((resolve) => { releaseDecision = resolve; }));
  const reviewing = f.controller.handleTaskAction(f.taskId, reviewPayload(f, round));
  for (let attempt = 0; attempt < 50 && !releaseDecision; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(typeof releaseDecision, 'function');
  const archivedExecution = structuredClone(f.task.execution);
  f.task.executionHistory = [{ execution: archivedExecution, registry: structuredClone(f.task.registry) }];
  f.task.execution = { id: 'run-replacement', phase: 'planned', status: 'waiting_start',
    deadline: new Date(Date.now() + 60_000).toISOString(), bindingCurrent: true,
    modelCalls: [], sessions: [], omoSessions: [], reviewRounds: [], workItems: [] };
  releaseDecision();
  await assert.rejects(reviewing, /角色回执已保留但未采纳/u);
  const archivedRound = archivedExecution.reviewRounds.find((item) => item.id === round.id);
  assert.equal(archivedRound.status, 'stale');
  assert.equal(archivedRound.modelCalls.length, 1);
  assert.equal(archivedRound.modelCalls[0].status, 'failed');
  assert.equal(archivedRound.modelCalls[0].outcome, 'stale_binding');
  assert.equal(archivedRound.omoSessions.length, 1);
  assert.equal(archivedRound.omoSessions[0].status, 'stale_binding');
  assert.equal(archivedRound.omoSessions[0].sourceCallIds[0], archivedRound.modelCalls[0].id);
  assert.deepEqual(archivedExecution.modelCalls, f.expectedOldCalls);
  assert.deepEqual(archivedExecution.omoSessions, []);
  assert.deepEqual(f.task.execution.modelCalls, []);
  assert.equal(f.task.artifacts[0].review.id, f.previousReviewId);
  assert.equal(f.task.artifacts[0].review.nativeVerdict, 'UNVERIFIED');
});
