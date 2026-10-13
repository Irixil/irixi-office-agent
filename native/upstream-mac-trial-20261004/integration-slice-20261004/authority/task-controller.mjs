import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { canonical, fingerprint, loadIrixiAuthorityHelpers, sha256 } from './authority-core.mjs';

const SLICE_ROOT = path.resolve(import.meta.dirname, '..');
const EXPECTED_TOY_ROOT = path.join(SLICE_ROOT, 'batches', 'codex-integrated-05', 'toy-project');
const EXPECTED_TOY_ROOT_08 = path.join(SLICE_ROOT, 'batches', 'codex-intake-execution-08', 'toy-project');
const REGISTERED_TOY_ROOTS = Object.freeze([EXPECTED_TOY_ROOT, EXPECTED_TOY_ROOT_08]);
const SNAPSHOT_PATHS = Object.freeze(['package.json', 'src/greeting.js', 'checks/greeting.test.js']);
const CONTRACT = Object.freeze({
  id: 'integrated-toy-greeting-v1',
  namedExport: 'greeting',
  cases: Object.freeze([
    Object.freeze({ id: 'trim-name', input: '  Ada  ', expected: 'Hello, Ada!' }),
    Object.freeze({ id: 'blank-fallback', input: '   ', expected: 'Hello, friend!' }),
  ]),
});
const DEVELOPER_PROTOCOL_TAG = 'INTEGRATED_TOY_DEVELOPER_05';
const MAX_FILE_BYTES = 128 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;

function registeredDeveloperRequest(goalVersionId, executionId, tag = DEVELOPER_PROTOCOL_TAG) {
  const displayPrompt = [
    'Update the fixed public greeting toy so the synchronous named export greeting trims a string name and returns "Hello, <name>!".',
    'For a blank string, return exactly "Hello, friend!".',
    'Change only src/greeting.js. Do not change package.json or checks/greeting.test.js, add files, commit, merge, serve a preview, or work outside this repository.',
    'The host will run the two registered string cases and compare the exact one-file diff. Do not broaden the input contract beyond strings.',
  ].join('\n');
  const prompt = `${displayPrompt}\n\nIrixi accepted goal version: ${goalVersionId}\nIrixi execution: ${executionId}\n${tag}`;
  return { goalVersionId, executionId, displayPrompt, prompt, promptSha256: sha256(prompt) };
}

async function safeRoot(input, expected = null) {
  const absolute = path.resolve(input);
  const allowed = expected ? [path.resolve(expected)] : REGISTERED_TOY_ROOTS.map((entry) => path.resolve(entry));
  if (!allowed.includes(absolute)) throw new Error('Toy workspace is not a fixed registered workspace');
  const real = await fs.realpath(absolute);
  if (real !== absolute) throw new Error('Toy workspace is not canonical');
  return absolute;
}

async function readEntry(root, relative) {
  if (!SNAPSHOT_PATHS.includes(relative)) throw new Error('File is outside the fixed toy manifest');
  const segments = relative.split('/');
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || (segment !== segments.at(-1) && !stat.isDirectory())) throw new Error('Toy manifest contains a link or invalid directory');
  }
  const before = await fs.lstat(current);
  if (!before.isFile() || before.nlink !== 1 || before.size > MAX_FILE_BYTES || await fs.realpath(current) !== current) throw new Error('Toy file is invalid');
  const bytes = await fs.readFile(current);
  const after = await fs.lstat(current);
  for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']) if (before[key] !== after[key]) throw new Error('Toy file changed while reading');
  return { path: relative, bytes: bytes.length, sha256: sha256(bytes), body: bytes };
}

async function manifest(root) {
  return Promise.all(SNAPSHOT_PATHS.map((relative) => readEntry(root, relative).then(({ body, ...entry }) => entry)));
}

function runFixed(command, args, { cwd, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, env: { LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let total = 0;
    let exceeded = false;
    const collect = (target) => (chunk) => {
      total += chunk.length;
      if (total > MAX_OUTPUT_BYTES) { exceeded = true; child.kill('SIGKILL'); return; }
      target.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.once('error', reject);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, exceeded, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
  });
}

function checkSummary(result) {
  return {
    exitCode: result.code,
    signal: result.signal,
    outputLimitExceeded: result.exceeded,
    stdoutBytes: result.stdout.length,
    stdoutSha256: sha256(result.stdout),
    stderrBytes: result.stderr.length,
    stderrSha256: sha256(result.stderr),
  };
}

async function gitHead(root) {
  const result = await runFixed('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: root, timeoutMs: 5_000 });
  const value = result.stdout.toString('utf8').trim();
  if (result.code !== 0 || result.signal || result.exceeded || !/^[a-f0-9]{40}$/.test(value)) throw new Error('Toy Git HEAD is unavailable');
  return value;
}

function latestArtifact(task) {
  return (task.artifacts || []).filter((entry) => ['candidate', 'confirmed'].includes(entry.status)).at(-1) || null;
}

export async function createIntegrationController({ tasksRoot, irixiAppRoot, toyRoot = EXPECTED_TOY_ROOT, testOnlyRegisteredToyRoot = null }) {
  const fixedToyRoot = await safeRoot(toyRoot, testOnlyRegisteredToyRoot);
  const helpers = await loadIrixiAuthorityHelpers(irixiAppRoot);
  const store = helpers.createStore(path.resolve(tasksRoot));
  await store.init();

  async function assertCandidateCurrent(task, artifact = latestArtifact(task)) {
    const candidate = artifact?.projectCandidate;
    const workspace = task.projectWorkspace;
    if (!artifact || !candidate || !workspace?.candidate || !helpers.projectArtifactIsCurrent(task, artifact)) throw new Error('No current Irixi project candidate exists');
    if (artifact.content !== candidate.patch || sha256(artifact.content) !== candidate.patchSha256) throw new Error('Artifact content is not the current candidate patch');
    if (candidate.projectExecutionAudit?.execution?.runId !== task.execution?.id
      || candidate.workspaceScopeFingerprint !== workspace.scopeFingerprint
      || candidate.sourceSnapshotSha256 !== workspace.sourceSnapshotSha256) throw new Error('Candidate binding is stale');
    const currentManifest = await manifest(fixedToyRoot);
    if (fingerprint(currentManifest) !== candidate.candidateSha256) throw new Error('Candidate files changed after host verification');
    for (const relative of ['package.json', 'checks/greeting.test.js']) {
      if (canonical(currentManifest.find((entry) => entry.path === relative)) !== canonical(workspace.sourceManifest.find((entry) => entry.path === relative))) throw new Error(`Protected toy file changed: ${relative}`);
    }
    const patch = await runFixed('/usr/bin/git', ['diff', '--no-ext-diff', '--binary', 'HEAD', '--', 'src/greeting.js'], { cwd: fixedToyRoot, timeoutMs: 5_000 });
    if (patch.code !== 0 || patch.signal || patch.exceeded || sha256(patch.stdout) !== candidate.patchSha256 || candidate.diffSha256 !== candidate.patchSha256) throw new Error('Candidate patch changed after host verification');
    if (!candidate.checks?.every((entry) => entry.passed === true && entry.candidateSha256 === candidate.candidateSha256 && entry.caseTotal === 2 && entry.casePassed === 2)) throw new Error('Candidate has no passing current host check');
    return { artifact, candidate };
  }

  async function prepare() {
    const sourceManifest = await manifest(fixedToyRoot);
    const sourceHead = await gitHead(fixedToyRoot);
    const task = helpers.createTask({
      type: 'project', provider: 'codex-cli', title: 'Public greeting contract integration',
      goal: 'Update the fixed public toy greeting function and deliver an independently reviewed patch.',
      successCriteria: ['The two registered greeting cases pass.', 'Only src/greeting.js changes.', 'A reviewer evaluates the exact current diff.'],
      boundaries: ['Only the registered three-file public toy may be read.', 'Only src/greeting.js may change.', 'No merge, team loop, preview, or arbitrary shell is authorized.'],
    });
    const binding = helpers.projectTaskBinding(task);
    const sourceSnapshotSha256 = fingerprint(sourceManifest);
    const publicContractFingerprint = fingerprint(CONTRACT);
    const scopeFingerprint = fingerprint({ fixtureId: CONTRACT.id, sourceSnapshotSha256, readablePaths: SNAPSHOT_PATHS, editablePaths: ['src/greeting.js'], contract: CONTRACT, binding });
    const proposalId = `proposal-${crypto.randomUUID()}`;
    task.projectScopeProposal = { id: proposalId, status: 'accepted', fingerprint: scopeFingerprint, acceptedFingerprint: scopeFingerprint, acceptedGoalVersionId: task.goal.activeVersionId };
    task.plan = { id: `plan-${crypto.randomUUID()}`, revision: 1 };
    const runtimeFingerprint = fingerprint({ node: process.version, platform: process.platform, contract: CONTRACT });
    const sandboxCapability = { available: true, fingerprint: fingerprint({ mode: 'codex-wrapper-plus-fixed-host-check-v1', runtimeFingerprint }), runtimeFingerprint, reason: '模型调用由外部固定两次 wrapper 控制；这里仅记录宿主固定检查能力。' };
    task.projectWorkspace = {
      policyVersion: 2, fixtureId: CONTRACT.id, label: 'Integrated public greeting toy', executionMode: 'host_integrated_transaction_v1',
      publicContract: CONTRACT, publicContractFingerprint, proposalId, proposalFingerprint: scopeFingerprint,
      status: 'ready', reason: null, sourceSnapshotId: `source-${crypto.randomUUID()}`, sourceSnapshotSha256,
      sourceManifest, readablePaths: SNAPSHOT_PATHS, editablePaths: ['src/greeting.js'], checks: [{ id: CONTRACT.id, contractSha256: publicContractFingerprint }],
      sourceHead,
      taskInputBinding: binding, scopeFingerprint, grantedAt: new Date().toISOString(), sandboxCapability,
      candidate: { id: `candidate-${crypto.randomUUID()}`, revision: 1, status: 'ready', sourceSnapshotSha256, candidateSha256: sourceSnapshotSha256, manifest: sourceManifest, taskInputBinding: binding, checks: [], diffSha256: sha256('') },
    };
    const scopeEvent = helpers.event(task, 'project.scope_accepted', '已明确接受固定公开 toy 的两用例范围。', { proposalId, goalVersionId: task.goal.activeVersionId, scopeFingerprint, sourceSnapshotSha256, fixtureId: CONTRACT.id });
    helpers.event(task, 'project_workspace.attached', '固定公开 toy 已授权；原项目不自动写回。', { goalVersionId: task.goal.activeVersionId, scopeFingerprint, sourceSnapshotSha256, acceptedScopeEventId: scopeEvent.id });
    helpers.startExecution(task, task.goal.activeVersionId, { maxModelCalls: 2, maxDurationMs: 20 * 60_000, maxAttemptsPerStep: 1, maxPlanRevisions: 0 });
    task.integrationExecutionRequest = registeredDeveloperRequest(task.goal.activeVersionId, task.execution.id);
    await store.save(task);
    return task;
  }

  function registeredScope() {
    return {
      id: CONTRACT.id,
      label: '公共测试 greeting 例子',
      goal: '更新隔离的公共 greeting 测试项目，并交付经过固定检查和独立审阅的补丁。',
      successCriteria: ['两个已展示的字符串用例全部通过。', '只有 src/greeting.js 发生变化。', '独立 Reviewer 审阅当前精确 diff。'],
      boundaries: ['仅可读取已登记的三个公共测试文件。', '仅可修改 src/greeting.js。', '禁止合并、团队循环、预览和任意 shell。'],
      files: [...SNAPSHOT_PATHS],
      editableFiles: ['src/greeting.js'],
      cases: CONTRACT.cases.map((entry) => ({ ...entry })),
    };
  }

  async function registeredScopeState(taskId) {
    let task;
    try { task = await store.get(taskId); } catch (error) { if (error?.code === 'ENOENT') return { ...registeredScope(), selected: false, authorized: false, current: true }; throw error; }
    const goal = helpers.activeGoal(task);
    const selected = (task.events || []).findLast((entry) => entry.type === 'integration.registered_scope_selected'
      && entry.detail?.fixtureId === CONTRACT.id && entry.detail?.goalVersionId === goal.id) || null;
    const authorized = Boolean(selected && task.type === 'project' && task.projectWorkspace?.fixtureId === CONTRACT.id
      && task.projectWorkspace?.status === 'ready' && helpers.projectWorkspaceIsCurrent(task));
    const stopped = Boolean(task.execution?.stopReason) || task.execution?.phase === 'failed';
    const hasCurrentCandidate = Boolean(authorized && task.artifacts?.some((entry) => entry.status === 'candidate'
      && entry.goalVersionId === goal.id && helpers.projectArtifactIsCurrent(task, entry)));
    return { ...registeredScope(), selected: Boolean(selected), authorized, current: !selected || selected.detail.goalVersionId === goal.id,
      goalVersionId: selected?.detail?.goalVersionId || null, scopeFingerprint: authorized ? task.projectWorkspace.scopeFingerprint : null,
      sourceSnapshotSha256: authorized ? task.projectWorkspace.sourceSnapshotSha256 : null,
      execution: authorized && task.execution ? { id: task.execution.id, phase: task.execution.phase, stopReason: task.execution.stopReason || null } : null,
      canStartNewBatch: Boolean(authorized && stopped),
      registeredExecution: authorized && !stopped && !hasCurrentCandidate && task.integrationExecutionRequest?.goalVersionId === goal.id
        && task.integrationExecutionRequest?.executionId === task.execution?.id ? { ...task.integrationExecutionRequest } : null };
  }

  async function selectRegisteredScope(taskId, expectedGoalVersionId) {
    return (await store.mutate(taskId, (task) => {
      const current = helpers.activeGoal(task);
      if (current.id !== expectedGoalVersionId) throw Object.assign(new Error('目标页面已过期，请按当前版本重新选择测试范围。'), { status: 409 });
      const scope = registeredScope();
      const suggestion = helpers.addSuggestion(task, { text: scope.goal, classification: 'replace', author: 'user' });
      const goal = helpers.acceptGoalReplacement(task, suggestion.id, { statement: scope.goal, successCriteria: scope.successCriteria, boundaries: scope.boundaries });
      helpers.event(task, 'integration.registered_scope_selected', '用户已明确选择公共 greeting 测试目标；工作区尚未授权。', { fixtureId: CONTRACT.id, goalVersionId: goal.id });
      helpers.event(task, 'intake.goal_confirmed', '用户明确接受公共测试目标、用例和边界；尚未授权工作区。', { goalVersionId: goal.id });
      task.status = 'waiting_user';
      task.activeRole = 'coordinator';
      return { goal, scope: { ...scope, selected: true, authorized: false, current: true, goalVersionId: goal.id } };
    })).result;
  }

  async function authorizeRegisteredScope(taskId, expectedGoalVersionId) {
    return (await store.mutate(taskId, async (task) => {
      const goal = helpers.activeGoal(task);
      if (goal.id !== expectedGoalVersionId) throw Object.assign(new Error('目标已变化，不能授权旧测试范围。'), { status: 409 });
      const selected = (task.events || []).findLast((entry) => entry.type === 'integration.registered_scope_selected'
        && entry.detail?.fixtureId === CONTRACT.id && entry.detail?.goalVersionId === goal.id);
      if (!selected) throw Object.assign(new Error('请先明确接受公共 greeting 测试目标与边界。'), { status: 409 });
      if (task.type === 'project' && task.projectWorkspace?.fixtureId === CONTRACT.id && helpers.projectWorkspaceIsCurrent(task)) return task;
      const sourceManifest = await manifest(fixedToyRoot);
      const sourceHead = await gitHead(fixedToyRoot);
      const status = await runFixed('/usr/bin/git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: fixedToyRoot, timeoutMs: 5_000 });
      if (status.code !== 0 || status.signal || status.exceeded || status.stdout.length !== 0) throw new Error('公共测试工作区必须从干净的固定基线授权。');
      task.type = 'project';
      const binding = helpers.projectTaskBinding(task);
      const sourceSnapshotSha256 = fingerprint(sourceManifest);
      const publicContractFingerprint = fingerprint(CONTRACT);
      const scopeFingerprint = fingerprint({ fixtureId: CONTRACT.id, sourceSnapshotSha256, readablePaths: SNAPSHOT_PATHS, editablePaths: ['src/greeting.js'], contract: CONTRACT, binding });
      const proposalId = `proposal-${crypto.randomUUID()}`;
      task.projectScopeProposal = { id: proposalId, status: 'accepted', fingerprint: scopeFingerprint, acceptedFingerprint: scopeFingerprint, acceptedGoalVersionId: goal.id };
      task.plan = { id: `plan-${crypto.randomUUID()}`, revision: 1 };
      const runtimeFingerprint = fingerprint({ node: process.version, platform: process.platform, contract: CONTRACT });
      const sandboxCapability = { available: true, fingerprint: fingerprint({ mode: 'codex-wrapper-plus-fixed-host-check-v1', runtimeFingerprint }), runtimeFingerprint, reason: '模型调用由外部固定两次 wrapper 控制；这里仅记录宿主固定检查能力。' };
      task.projectWorkspace = {
        policyVersion: 2, fixtureId: CONTRACT.id, label: 'Integrated public greeting toy', executionMode: 'host_integrated_transaction_v1',
        publicContract: CONTRACT, publicContractFingerprint, proposalId, proposalFingerprint: scopeFingerprint,
        status: 'ready', reason: null, sourceSnapshotId: `source-${crypto.randomUUID()}`, sourceSnapshotSha256,
        sourceManifest, readablePaths: SNAPSHOT_PATHS, editablePaths: ['src/greeting.js'], checks: [{ id: CONTRACT.id, contractSha256: publicContractFingerprint }],
        sourceHead, taskInputBinding: binding, scopeFingerprint, grantedAt: new Date().toISOString(), sandboxCapability,
        candidate: { id: `candidate-${crypto.randomUUID()}`, revision: 1, status: 'ready', sourceSnapshotSha256, candidateSha256: sourceSnapshotSha256, manifest: sourceManifest, taskInputBinding: binding, checks: [], diffSha256: sha256('') },
      };
      const scopeEvent = helpers.event(task, 'project.scope_accepted', '已明确接受固定公开 toy 的两用例范围。', { proposalId, goalVersionId: goal.id, scopeFingerprint, sourceSnapshotSha256, fixtureId: CONTRACT.id });
      helpers.event(task, 'project_workspace.attached', '固定公共测试工作区已单独授权；其他项目仍未授权。', { goalVersionId: goal.id, scopeFingerprint, sourceSnapshotSha256, acceptedScopeEventId: scopeEvent.id });
      helpers.startExecution(task, goal.id, { maxModelCalls: 2, maxDurationMs: 20 * 60_000, maxAttemptsPerStep: 1, maxPlanRevisions: 0 });
      task.integrationExecutionRequest = registeredDeveloperRequest(goal.id, task.execution.id);
      return task;
    })).result;
  }

  async function startNewRegisteredExecution(taskId, expectedGoalVersionId) {
    return (await store.mutate(taskId, (task) => {
      const goal = helpers.activeGoal(task);
      if (goal.id !== expectedGoalVersionId) throw Object.assign(new Error('目标已变化，不能为旧目标开启新批次。'), { status: 409 });
      if (task.type !== 'project' || task.projectWorkspace?.fixtureId !== CONTRACT.id || !helpers.projectWorkspaceIsCurrent(task)) {
        throw Object.assign(new Error('固定公共测试范围或工作区授权已失效。'), { status: 409 });
      }
      if (!task.execution?.stopReason && task.execution?.phase !== 'failed') throw Object.assign(new Error('当前执行尚未停止，不能开启另一批。'), { status: 409 });
      const priorExecutionId = task.execution.id;
      helpers.startExecution(task, goal.id, { maxModelCalls: 2, maxDurationMs: 20 * 60_000, maxAttemptsPerStep: 1, maxPlanRevisions: 0 });
      task.status = 'waiting_user';
      task.activeRole = 'writer';
      task.integrationExecutionRequest = registeredDeveloperRequest(goal.id, task.execution.id);
      helpers.event(task, 'integration.execution_reauthorized', '用户在同一已授权范围内明确开启新的受限执行批次。', {
        goalVersionId: goal.id, priorExecutionId, executionId: task.execution.id,
        scopeFingerprint: task.projectWorkspace.scopeFingerprint, sourceSnapshotSha256: task.projectWorkspace.sourceSnapshotSha256,
      });
      return task;
    })).result;
  }

  async function hostCheck(taskId) {
    return (await store.mutate(taskId, async (task) => {
      const workspace = task.projectWorkspace;
      if (!workspace || workspace.status !== 'ready' || !helpers.projectWorkspaceIsCurrent(task)
        || workspace.scopeFingerprint !== fingerprint({ fixtureId: CONTRACT.id, sourceSnapshotSha256: workspace.sourceSnapshotSha256, readablePaths: SNAPSHOT_PATHS, editablePaths: ['src/greeting.js'], contract: CONTRACT, binding: helpers.projectTaskBinding(task) })) throw new Error('Integrated workspace binding is stale');
      if (task.execution?.goalVersionId !== task.goal.activeVersionId || task.execution?.stopReason) throw new Error('Integrated execution is not current');
      const currentManifest = await manifest(fixedToyRoot);
      if (await gitHead(fixedToyRoot) !== workspace.sourceHead) throw new Error('Toy Git HEAD changed after authorization');
      const baseline = workspace.sourceManifest;
      for (const relative of ['package.json', 'checks/greeting.test.js']) {
        if (canonical(currentManifest.find((entry) => entry.path === relative)) !== canonical(baseline.find((entry) => entry.path === relative))) throw new Error(`Protected toy file changed: ${relative}`);
      }
      const changed = currentManifest.filter((entry) => entry.sha256 !== baseline.find((item) => item.path === entry.path)?.sha256).map((entry) => entry.path);
      if (canonical(changed) !== canonical(['src/greeting.js'])) throw new Error('The candidate must change exactly src/greeting.js');
      const status = await runFixed('/usr/bin/git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: fixedToyRoot, timeoutMs: 5_000 });
      if (status.code !== 0 || status.signal || status.exceeded || status.stdout.toString('utf8') !== ' M src/greeting.js\n') throw new Error('Toy Git status is outside the fixed change set');
      const test = await runFixed(process.execPath, ['--test', 'checks/greeting.test.js'], { cwd: fixedToyRoot });
      const patch = await runFixed('/usr/bin/git', ['diff', '--no-ext-diff', '--binary', 'HEAD', '--', 'src/greeting.js'], { cwd: fixedToyRoot, timeoutMs: 5_000 });
      if (patch.code !== 0 || patch.signal || patch.exceeded || !patch.stdout.length) throw new Error('Current localized patch is unavailable');
      const passed = test.code === 0 && !test.signal && !test.exceeded;
      const candidateSha256 = fingerprint(currentManifest);
      const diffSha256 = sha256(patch.stdout);
      const check = { id: CONTRACT.id, checkId: CONTRACT.id, caseTotal: 2, casePassed: passed ? 2 : 0, passed, candidateSha256, resultDigest: fingerprint({ candidateSha256, contract: CONTRACT, test: checkSummary(test) }), ...checkSummary(test) };
      if (!passed) {
        task.execution.stopReason = 'project_verification_failed';
        task.execution.phase = 'failed';
        task.status = 'failed';
        helpers.event(task, 'integration.host_check_failed', '固定两用例检查未通过；没有生成候选。', { checkId: CONTRACT.id, candidateSha256, resultDigest: check.resultDigest });
        return { passed: false, check };
      }
      const sourceIntegrityBody = { baseline, current: currentManifest, protectedPaths: ['package.json', 'checks/greeting.test.js'], outsideUnchanged: true };
      const sourceIntegrity = { ...sourceIntegrityBody, integritySha256: fingerprint(sourceIntegrityBody) };
      const auditBody = {
        mode: 'host_integrated_transaction_v1', plan: { id: task.plan.id, revision: task.plan.revision },
        execution: { runId: task.execution.id }, binding: helpers.projectTaskBinding(task),
        calls: [{ actor: 'host', tool: 'node-test', checkId: CONTRACT.id, caseTotal: 2, casePassed: 2, resultDigest: check.resultDigest }],
      };
      const projectExecutionAudit = { ...auditBody, auditSha256: fingerprint(auditBody) };
      const projectCandidate = {
        sourceSnapshotSha256: workspace.sourceSnapshotSha256,
        workspaceScopeFingerprint: workspace.scopeFingerprint,
        candidateId: workspace.candidate.id,
        candidateSha256,
        diffSha256,
        patchSha256: sha256(patch.stdout),
        patch: patch.stdout.toString('utf8'),
        changes: changed,
        checks: [check],
        taskInputBinding: helpers.projectTaskBinding(task),
        sourceIntegrity, sourceIntegritySha256: sourceIntegrity.integritySha256,
        projectExecutionAudit, projectExecutionAuditSha256: projectExecutionAudit.auditSha256,
        sandboxCapabilityFingerprint: workspace.sandboxCapability.fingerprint,
        runtimeFingerprint: workspace.sandboxCapability.runtimeFingerprint,
      };
      workspace.candidate = { ...workspace.candidate, status: 'ready', candidateSha256, manifest: currentManifest, checks: [check], diffSha256, sourceIntegrity };
      const artifact = helpers.createArtifact(task, {
        title: 'Greeting contract patch',
        summary: 'The host verified the exact one-file candidate against the two registered string cases.',
        content: patch.stdout.toString('utf8'), sources: [], claims: [], caveats: ['This is a patch only; it has not been applied to another repository.'], projectCandidate,
      }, 'codex-cli');
      // Irixi's generic text constructor trims display text. A patch is a byte
      // deliverable, so restore the already-hashed host patch verbatim before
      // any review or confirmation can observe this artifact.
      artifact.content = projectCandidate.patch;
      if (!helpers.projectArtifactIsCurrent(task, artifact)) throw new Error('Irixi rejected the host evidence for the current project candidate');
      task.status = 'waiting_user';
      task.activeRole = 'reviewer';
      helpers.event(task, 'integration.host_checked', '当前候选已通过固定两用例与一文件边界检查。', { artifactId: artifact.id, candidateSha256, diffSha256, checkId: CONTRACT.id, caseTotal: 2, casePassed: 2 });
      return { passed: true, artifactId: artifact.id, candidate: projectCandidate };
    })).result;
  }

  async function recordReviewer(taskId, sourceTaskId, reviewText) {
    return (await store.mutate(taskId, async (task) => {
      const { artifact } = await assertCandidateCurrent(task);
      if (!/^review-[A-Za-z0-9_-]{1,120}$/.test(sourceTaskId || '')) throw new Error('Reviewer source task ID is invalid');
      const started = (task.events || []).findLast((entry) => entry.type === 'integration.observation'
        && entry.detail?.type === 'TASK_STARTED' && entry.detail?.actor === 'reviewer'
        && entry.detail?.sourceTaskId === sourceTaskId && entry.detail?.binding?.artifactId === artifact.id
        && entry.detail?.binding?.candidateSha256 === artifact.projectCandidate.candidateSha256);
      if (!started) throw new Error('Reviewer result has no current bound TASK_STARTED event');
      const text = String(reviewText || '').slice(0, 40_000);
      const verdict = /(?:^|\n)\s*(?:\*\*)?VERDICT:(?:\*\*)?\s*(PASS|FAIL)\b/im.exec(text)?.[1]?.toUpperCase();
      if (!verdict) throw new Error('Reviewer output has no explicit VERDICT');
      const issueBlock = /(?:\*\*)?ISSUES:(?:\*\*)?([\s\S]*?)(?=(?:\n\s*(?:\*\*)?(?:SUGGESTIONS|SUMMARY):)|$)/i.exec(text)?.[1]?.trim() || '';
      const issueLines = issueBlock.split('\n').map((line) => line.replace(/^\s*(?:[-*]|\d+\.)\s*/, '').trim()).filter(Boolean);
      const explicitContract = issueLines.filter((line) => /^CONTRACT\s*:/i.test(line));
      const explicitOutside = issueLines.filter((line) => /^OUT_OF_SCOPE\s*:/i.test(line));
      const inferredOutside = issueLines.filter((line) => !/^\w+\s*:/i.test(line)
        && /\b(?:missing|null|undefined|non[- ]?string|number|object|array|boolean)\b/i.test(line)
        && /outside.{0,40}(?:accepted )?string contract|outside.{0,40}accepted input/i.test(line));
      const unclassified = issueLines.filter((line) => !explicitContract.includes(line) && !explicitOutside.includes(line) && !inferredOutside.includes(line));
      const scopeOutcome = verdict === 'PASS' && issueLines.length === 0 ? 'passed'
        : explicitContract.length ? 'contract_failed'
          : issueLines.length > 0 && unclassified.length === 0 ? 'outside_scope_only'
            : 'needs_decision';
      const passed = scopeOutcome === 'passed' || scopeOutcome === 'outside_scope_only';
      const evidence = scopeOutcome === 'outside_scope_only'
        ? '固定两用例与一文件边界已由宿主通过；Reviewer 的 FAIL 仅涉及公开 contract 未约定的非字符串输入，原文保留为范围外建议。'
        : scopeOutcome === 'passed' ? '独立 Reviewer 对当前绑定候选给出 PASS，且没有报告约定范围内问题。'
          : scopeOutcome === 'contract_failed' ? 'Reviewer 明确标记了 CONTRACT 范围内阻塞问题。'
            : 'Reviewer 的问题没有明确区分约定范围与范围外建议，需要用户决定。';
      const checks = ['目标符合度', '完整性', '来源核对', '边界遵守', '文件可用性'].map((name) => ({ name, passed, evidence, blocking: true }));
      const projectReviewFacts = helpers.createTrustedProjectReviewFacts(task, artifact);
      const review = helpers.recordReview(task, artifact.id, { checks, summary: text, provider: 'codex-cli' }, { projectReviewFacts });
      review.nativeVerdict = verdict;
      review.scopeOutcome = scopeOutcome;
      review.sourceTaskId = sourceTaskId;
      review.fullOutputSha256 = sha256(text);
      review.projectCandidateFingerprint = helpers.projectCandidateFingerprint(artifact.projectCandidate);
      if (scopeOutcome === 'needs_decision') {
        task.status = 'waiting_user';
        task.activeRole = 'steward';
      }
      helpers.event(task, 'integration.review_recorded', `当前候选独立审阅结论：${verdict}；约定范围结论：${scopeOutcome}。`, { artifactId: artifact.id, reviewId: review.id, sourceTaskId, reviewTextSha256: sha256(text), verdict, scopeOutcome });
      return review;
    })).result;
  }

  async function recordNativeFailure(taskId, actor, sourceTaskId) {
    return (await store.mutate(taskId, (task) => {
      const failed = (task.events || []).findLast((entry) => entry.type === 'integration.observation'
        && entry.detail?.type === 'TASK_FAILED' && entry.detail?.actor === actor
        && entry.detail?.sourceTaskId === sourceTaskId
        && entry.detail?.binding?.executionId === task.execution?.id);
      if (!failed) throw new Error('Native failure has no current bound observation');
      task.execution.stopReason = 'permanent_error';
      task.execution.phase = 'failed';
      task.status = 'failed';
      return helpers.event(task, 'integration.native_failed', `原生 ${actor} 执行失败；本执行不会自动重试。`, {
        actor, sourceTaskId, observationId: failed.id,
      });
    })).result;
  }

  async function confirm(taskId, artifactId, version) {
    return (await store.mutate(taskId, async (task) => {
      const artifact = task.artifacts.find((entry) => entry.id === artifactId && entry.version === version);
      if (!artifact) throw new Error('Specified artifact version is stale');
      await assertCandidateCurrent(task, artifact);
      const latestReview = task.reviews.filter((entry) => entry.artifactId === artifact.id).at(-1);
      if (!latestReview?.passed || latestReview.projectCandidateFingerprint !== helpers.projectCandidateFingerprint(artifact.projectCandidate)) {
        throw new Error('Current candidate has no matching accepted review');
      }
      const approval = helpers.confirmArtifact(task, artifact.id);
      return { approval, patchSha256: sha256(artifact.content) };
    })).result;
  }

  async function exportPatch(taskId, artifactId, approvalId) {
    const task = await store.get(taskId);
    const { artifact } = await assertCandidateCurrent(task, task.artifacts.find((entry) => entry.id === artifactId));
    const latestReview = task.reviews.filter((entry) => entry.artifactId === artifact.id).at(-1);
    const approval = task.approvals.find((entry) => entry.id === approvalId && entry.artifactId === artifact.id);
    if (!latestReview?.passed || latestReview.projectCandidateFingerprint !== helpers.projectCandidateFingerprint(artifact.projectCandidate)
      || approval?.artifactVersion !== artifact.version
      || approval?.projectCandidateFingerprint !== helpers.projectCandidateFingerprint(artifact.projectCandidate)) throw new Error('Review or confirmation is not bound to the current candidate');
    const exportArtifact = helpers.assertExportAllowed(task, artifactId, approvalId);
    return { bytes: Buffer.from(exportArtifact.content, 'utf8'), filename: `integrated-toy-${exportArtifact.version}.patch`, sha256: sha256(exportArtifact.content) };
  }

  async function replaceGoal(taskId, { statement, successCriteria, boundaries }) {
    return (await store.mutate(taskId, (task) => {
      const suggestion = helpers.addSuggestion(task, { text: statement, classification: 'replace', author: 'user' });
      const version = helpers.acceptGoalReplacement(task, suggestion.id, { statement, successCriteria, boundaries });
      return version;
    })).result;
  }

  return { store, helpers, prepare, registeredScope, registeredScopeState, selectRegisteredScope, authorizeRegisteredScope, startNewRegisteredExecution, hostCheck, recordReviewer, recordNativeFailure, confirm, exportPatch, replaceGoal, assertCandidateCurrent, fixedToyRoot };
}

export const __test = { CONTRACT, SNAPSHOT_PATHS, EXPECTED_TOY_ROOT, EXPECTED_TOY_ROOT_08, DEVELOPER_PROTOCOL_TAG, registeredDeveloperRequest, manifest, checkSummary };
