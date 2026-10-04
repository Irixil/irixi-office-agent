import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { addSuggestion, createTask, invalidateCurrentWork, publicTask } from '../core.mjs';
import { __test, createProjectWorkspaceHost, projectArtifactIsCurrent, projectTaskBinding } from '../project-workspace.mjs';
import { registeredRepository, validateProjectScopeResult } from '../project-scope.mjs';

const safeCapability = {
  available: true,
  reason: 'test-only capability',
  fingerprint: 'test-capability',
  runtimeFingerprint: null,
  probes: [],
};
const tempPrefix = path.join(process.cwd(), '.project-test-');
const LEGACY_CONTINUITY_SHA256 = '90c82c08cf046b1460f7d4df94993f589e55905817ea46b9b2d6971892cf0ae2';
const LEGACY_CONTINUITY_FUNCTION = `function renderContinuity(task) {
  const value = task.continuity;
  if (!value) return '<p class="empty-ledger">正在从任务记录整理续接状态。</p>';
  const list = (items, empty) => items.length ? \`<ul>\${items.map((item) => \`<li>\${esc(item)}</li>\`).join('')}</ul>\` : \`<p class="field-note">\${esc(empty)}</p>\`;
  const activeJob = task.runtime?.activeJob;
  const busyText = activeJob?.kind === 'planning' ? '正在形成计划，等待本次规划结果。'
    : activeJob?.kind === 'conversation' ? '正在回复当前对话，完成后会写回同一任务。'
      : activeJob ? '正在处理当前工作，完成后会写回同一任务。' : null;
  const incomplete = busyText ? [busyText, ...value.progress.incomplete] : value.progress.incomplete;
  const stoppedBecause = busyText ? '当前正在工作，没有停下。' : value.progress.stoppedBecause || '没有停下，当前记录可以继续。';
  const nextStep = busyText || value.progress.nextStep;
  const readyForDownload = task.status === 'ready_to_export' && value.candidate?.confirmed;
  const badge = busyText ? '正在工作' : readyForDownload ? '可以下载' : value.progress.needsUserDecision ? '需要你的决定' : 'Irixi 可继续';
  const tone = busyText ? 'active' : value.progress.needsUserDecision ? 'bad' : 'good';
  return \`<div class="continuity-grid"><div><strong>已经做成</strong>\${list(value.progress.done, '还没有完成且仍有效的步骤。')}</div><div><strong>尚未完成</strong>\${list(incomplete, '当前没有未完成步骤。')}</div><div><strong>为什么停下</strong><p>\${esc(stoppedBecause)}</p></div><div><strong>下一步</strong><p>\${esc(nextStep)}</p><span class="record-status" data-tone="\${tone}">\${badge}</span></div></div>\`;
}`;

function expectedAttach(task, capabilities, previous = null, fixtureId = 'node-single-file-v1') {
  return {
    fixtureId,
    expectedGoalVersionId: task.goal.activeVersionId,
    expectedProjectRootGoalVersionId: task.projectRootGoalVersionId,
    expectedProjectRootInputFingerprint: task.projectRootInputFingerprint,
    expectedMaterialApplicabilityFingerprint: task.materialContext?.fingerprint ?? null,
    expectedPreviousScopeFingerprint: previous,
    expectedCapabilityFingerprint: capabilities.fingerprint,
  };
}

function continuityRegion(text) {
  const startMarker = 'function renderContinuity(task) {';
  const endMarker = '\n}\n\nfunction renderProject(task) {';
  const start = text.indexOf(startMarker);
  const endStart = text.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && endStart >= 0);
  return { prefix: text.slice(0, start), content: text.slice(start, endStart + 2), suffix: text.slice(endStart + 2) };
}

function repairedLegacyContinuity(source) {
  assert.equal(crypto.createHash('sha256').update(source).digest('hex'), LEGACY_CONTINUITY_SHA256);
  const repaired = source
    .replace("  const readyForDownload = task.status === 'ready_to_export' && value.candidate?.confirmed;\n", "  const readyForDownload = task.status === 'ready_to_export' && value.candidate?.confirmed;\n  const terminalBlocked = ['failed', 'partial', 'cancelled', 'cancellation_unknown'].includes(task.status)\n    && ['budget_exhausted', 'permanent_error', 'same_error_exhausted', 'project_verification_failed', 'project_transaction_failed'].includes(task.execution?.stopReason);\n")
    .replace("  const badge = busyText ? '正在工作' : readyForDownload ? '可以下载' : value.progress.needsUserDecision ? '需要你的决定' : 'Irixi 可继续';\n  const tone = busyText ? 'active' : value.progress.needsUserDecision ? 'bad' : 'good';", "  const badge = busyText ? '正在工作' : readyForDownload ? '可以下载' : value.progress.needsUserDecision ? '需要你的决定' : terminalBlocked ? '需要先处理' : 'Irixi 可继续';\n  const tone = busyText ? 'active' : value.progress.needsUserDecision || terminalBlocked ? 'bad' : 'good';");
  assert.notEqual(repaired, source);
  return repaired;
}

function memoryStore(task, taskDir) {
  return {
    taskDir: () => taskDir,
    async mutate(_id, mutation) {
      const result = await mutation(task);
      return { task, result };
    },
  };
}

async function setupWithOverride(hostOptions = {}) {
  const taskDir = await fs.mkdtemp(tempPrefix);
  const task = createTask({ title: '问候函数', goal: '修正 greetName 的 trim 与空值行为', type: 'project', successCriteria: ['固定合约通过'], boundaries: ['不写原项目'] });
  const host = createProjectWorkspaceHost({ capabilityOverride: safeCapability, ...hostOptions });
  const capability = await host.capabilities();
  await host.attachDraft(task, taskDir, expectedAttach(task, capability));
  task.execution = { id: 'run-unit' };
  task.workItems = [{ id: 'work-unit', status: 'running', role: 'developer' }];
  task.agentSessions = [];
  return { taskDir, task, host, store: memoryStore(task, taskDir) };
}

test('项目授权公开投影不泄漏本机路径且迟到 scope 被拒绝', async (t) => {
  const { taskDir, task, host } = await setupWithOverride();
  t.after(() => fs.rm(taskDir, { recursive: true, force: true }));
  const exposed = JSON.stringify(publicTask(task));
  assert.equal(exposed.includes(taskDir), false);
  assert.equal(exposed.includes('grantRelativeRoot'), false);
  const old = expectedAttach(task, await host.capabilities(), 'definitely-old-scope');
  await assert.rejects(host.attachDraft(task, taskDir, old), (error) => error.status === 409 && error.code === 'stale_project_workspace');
  task.projectWorkspace.status = 'sandbox_unavailable';
  task.projectWorkspace.reason = '固定隔离探针未通过。';
  const unavailable = publicTask(task).projectWorkspace;
  assert.equal(unavailable.status, 'sandbox_unavailable');
  assert.equal(unavailable.reason, '固定隔离探针未通过。');
});

test('旧 greet grant 缺新合约指纹仍按原固定流程可读，continuity 专用事务不借此放宽', async (t) => {
  const { taskDir, task, host, store } = await setupWithOverride();
  t.after(() => fs.rm(taskDir, { recursive: true, force: true }));
  delete task.projectWorkspace.executionMode;
  delete task.projectWorkspace.publicContractFingerprint;
  assert.equal(publicTask(task).projectWorkspace.status, 'ready');
  const read = await host.runTool(store, task.id, 'work-unit', {
    tool: 'workspace.read', args: { path: 'src/greeting.mjs', view: 'candidate', expectedCandidateSha256: task.projectWorkspace.candidate.candidateSha256 },
  });
  assert.equal(read.path, 'src/greeting.mjs');
  assert.equal(read.view, 'candidate');
});

test('patch 对文件末尾换行状态给出合法整文件 unified diff', () => {
  assert.equal(__test.unifiedPatch([{ path: 'src/x.mjs', before: 'old\n', after: 'new\n' }]),
    '--- a/src/x.mjs\n+++ b/src/x.mjs\n@@ -1,1 +1,1 @@\n-old\n+new\n');
  assert.equal(__test.unifiedPatch([{ path: 'src/x.mjs', before: 'old', after: 'new' }]),
    '--- a/src/x.mjs\n+++ b/src/x.mjs\n@@ -1,1 +1,1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n');
  assert.equal(__test.unifiedPatch([{ path: 'src/x.mjs', before: '', after: 'new\n' }]),
    '--- a/src/x.mjs\n+++ b/src/x.mjs\n@@ -1,0 +1,1 @@\n+new\n');
});

test('固定区域 patch 是局部合法 hunk 且可精确重建整文件', async (t) => {
  const root = await fs.mkdtemp(tempPrefix);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, 'source');
  const candidateRoot = path.join(root, 'candidate');
  await fs.mkdir(sourceRoot, { recursive: true });
  await fs.mkdir(candidateRoot, { recursive: true });
  const before = ['const untouched = true;', '', 'function target(value) {', '  return value;', '}', '', 'function later() {', '  return untouched;', '}', ''].join('\n');
  const after = before.replace('  return value;', '  return String(value).trim();');
  await fs.writeFile(path.join(sourceRoot, 'app.js'), before);
  await fs.writeFile(path.join(candidateRoot, 'app.js'), after);
  const fixture = {
    region: { path: 'app.js', id: 'target-v1', startMarker: 'function target(value) {', endMarker: '\n}\n\nfunction later() {', maxBytes: 4096 },
  };
  const diff = await __test.diffCandidate(sourceRoot, candidateRoot, ['app.js'], fixture);
  assert.match(diff.patch, /^@@ -\d+,\d+ \+\d+,\d+ @@$/m);
  assert.doesNotMatch(diff.patch, /^[-+]const untouched/m);
  assert.equal(__test.applySingleHunk(before, diff.patch, true), after);
  assert.equal(diff.regionIntegrity.outsideUnchanged, true);
  assert.equal(diff.regionIntegrity.patchSha256, diff.diffSha256);
  assert.equal(diff.regionIntegrity.reconstructedCandidateSha256, crypto.createHash('sha256').update(after).digest('hex'));
});

test('注册 UI 按任务选择固定 fixture 且目标函数边界唯一', async () => {
  const source = await fs.readFile(path.resolve('app/public/app.js'), 'utf8');
  const region = continuityRegion(source);
  assert.equal(source.split('function renderContinuity(task) {').length - 1, 1);
  assert.equal(source.split('\n}\n\nfunction renderProject(task) {').length - 1, 1);
  assert.match(region.content, /^function renderContinuity\(task\) \{/);
  assert.match(source, /projectFixtureSelections: \{\}/);
  assert.match(source, /state\.projectFixtureSelections\[task\.id\] \|\| workspace\?\.fixtureId/);
  assert.match(source, /name="fixtureId" data-project-fixture-select/);
  assert.match(source, /state\.projectFixtureSelections\[state\.task\.id\] = fixture\.id/);
  assert.match(source, /data-project-scope-propose/);
  assert.match(source, /data-project-scope-accept/);
  assert.match(source, /data-generic-scope/);
  assert.match(source, /2 个可改纯函数模块/);
});

test('capability positive-read 只接受实际 bytes 与 SHA-256 同时精确匹配', async (t) => {
  const root = await fs.mkdtemp(tempPrefix);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sample = path.join(root, 'sample.js');
  const bytes = Buffer.from('browser script without module exports\n');
  await fs.writeFile(sample, bytes);
  const wrapper = path.resolve('app/project-runtime/capability-probe-wrapper.mjs');
  const request = (expectedBytes, expectedSha256) => `${JSON.stringify({ action: 'positive-read', path: sample, expectedBytes, expectedSha256, probeId: 'probe-exact', nonce: 'a'.repeat(32) })}\n`;
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  const accepted = await __test.runChild(process.execPath, [wrapper], { input: request(bytes.length, digest), cwd: root });
  assert.equal(JSON.parse(accepted.stdout).passed, true);
  const wrongLength = await __test.runChild(process.execPath, [wrapper], { input: request(bytes.length + 1, digest), cwd: root });
  assert.equal(JSON.parse(wrongLength.stdout).passed, false);
  const wrongHash = await __test.runChild(process.execPath, [wrapper], { input: request(bytes.length, '0'.repeat(64)), cwd: root });
  assert.equal(JSON.parse(wrongHash.stdout).passed, false);
});

test('通用 JSON wrapper 绑定唯一 envelope，宿主策略先拒绝副作用入口', async (t) => {
  const root = await fs.mkdtemp(tempPrefix);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const wrapper = path.resolve('app/project-runtime/generic-json-function-wrapper.mjs');
  const run = async (source, timeoutMs = 1_000) => {
    const modulePath = path.join(root, `candidate-${crypto.randomUUID()}.mjs`);
    await fs.writeFile(modulePath, source);
    return __test.runChild(process.execPath, [wrapper, modulePath], {
      cwd: root, timeoutMs,
      input: `${JSON.stringify({ caseId: 'case-1', nonce: 'a'.repeat(32), exportName: 'transform', args: [2] })}\n`,
    });
  };
  const good = await run('export function transform(value) { return { value: value + 1 }; }\n');
  const envelope = __test.parseSingleEnvelope(good.stdout, ['type', 'caseId', 'nonce', 'value']);
  assert.deepEqual(envelope.value, { value: 3 });
  const monkey = await run('JSON.stringify = () => "forged"; process.stdout.write = () => true; console.log = () => {}; export function transform(value) { return { value }; }\n');
  assert.deepEqual(__test.parseSingleEnvelope(monkey.stdout, ['type', 'caseId', 'nonce', 'value']).value, { value: 2 });
  const iteratorMonkey = await run('Array.prototype[Symbol.iterator] = () => { throw new Error("forged iterator"); }; export function transform(value) { return { value }; }\n');
  assert.deepEqual(__test.parseSingleEnvelope(iteratorMonkey.stdout, ['type', 'caseId', 'nonce', 'value']).value, { value: 2 });
  const noisy = await run('console.log("NOISE"); export function transform(value) { return value; }\n');
  assert.throws(() => __test.parseSingleEnvelope(noisy.stdout, ['type', 'caseId', 'nonce', 'value']));
  const exited = await run('process.exit(0); export function transform(value) { return value; }\n');
  assert.equal(exited.stdout, '');
  const hanging = await run('while (true) {} export function transform(value) { return value; }\n', 100);
  assert.equal(hanging.timedOut, true);
  const flooding = await run('console.log("x".repeat(20000)); export function transform(value) { return value; }\n');
  assert.equal(flooding.outputLimitExceeded, true);
  for (const source of [
    'export function transform() { return NaN; }\n',
    'export function transform() { return new Date(0); }\n',
    'export function transform() { return { toJSON() { return 3; } }; }\n',
    'export function transform() { return Object.defineProperty({}, "value", { get() { return 3; } }); }\n',
    'Object.prototype.toJSON = () => 3; export function transform(value) { return { value }; }\n',
    'export function transform(value) { return new Proxy({ value }, {}); }\n',
    'export function transform() { return "x".repeat(20000); }\n',
    'export function transform(value) { return Object.create({ value }); }\n',
    'export function transform(value) { const result = { value }; result.self = result; return result; }\n',
  ]) {
    const invalid = await run(source);
    assert.notEqual(invalid.code, 0);
    assert.equal(invalid.stdout, '');
  }
  for (const source of [
    'import fs from "node:fs"; export function transform(v) { return v; }',
    'export async function transform(v) { return v; }',
    'export function transform(v) { process.kill(1); return v; }',
    'export function transform(v) { return fetch("https://example.com"); }',
    'export function transform(v) { return globalThis.constructor; }',
  ]) assert.throws(() => __test.assertGenericModulePolicy(source), /纯函数模块/);
});

test('授权根目录链接被拒绝且不会在外部创建暂存副本', async (t) => {
  const taskDir = await fs.mkdtemp(tempPrefix);
  const outside = await fs.mkdtemp(tempPrefix);
  t.after(() => fs.rm(taskDir, { recursive: true, force: true }));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.symlink(outside, path.join(taskDir, 'project-workspaces'));
  const task = createTask({ title: '链接授权负例', goal: '拒绝链接工作区', type: 'project', successCriteria: ['不写外部'], boundaries: ['不跟随链接'] });
  const host = createProjectWorkspaceHost({ capabilityOverride: safeCapability });
  const capabilities = await host.capabilities();
  await assert.rejects(host.attachDraft(task, taskDir, expectedAttach(task, capabilities)), (error) => error.code === 'project_workspace_error');
  assert.deepEqual(await fs.readdir(outside), []);
});

test('目标变化让 grant 与旧项目 artifact 失效但保留历史', async (t) => {
  const { taskDir, task } = await setupWithOverride();
  t.after(() => fs.rm(taskDir, { recursive: true, force: true }));
  const workspace = task.projectWorkspace;
  task.plan = { id: 'plan-current', revision: 1 };
  const artifact = {
    projectCandidate: {
      workspaceScopeFingerprint: workspace.scopeFingerprint,
      sourceSnapshotSha256: workspace.sourceSnapshotSha256,
      candidateId: workspace.candidate.id,
      candidateSha256: workspace.candidate.candidateSha256,
      sandboxCapabilityFingerprint: workspace.sandboxCapability.fingerprint,
      runtimeFingerprint: workspace.sandboxCapability.runtimeFingerprint,
      patch: '',
      patchSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      sourceIntegrity: { integritySha256: 'test-source-integrity' },
      sourceIntegritySha256: 'test-source-integrity',
      projectExecutionAudit: { auditSha256: 'test-execution-audit', plan: { id: 'plan-current', revision: 1 } },
      projectExecutionAuditSha256: 'test-execution-audit',
      taskInputBinding: structuredClone(workspace.candidate.taskInputBinding),
    },
  };
  assert.equal(projectArtifactIsCurrent(task, artifact), true);
  invalidateCurrentWork(task, 'goal_changed', 'goal changed');
  assert.equal(task.projectWorkspace.status, 'reauthorization_required');
  assert.equal(task.projectWorkspace.candidate.status, 'historical');
  assert.equal(projectArtifactIsCurrent(task, artifact), false);
});

test('旧 grant 不能靠新 candidate binding 隐式升级后继续使用工具', async (t) => {
  const { taskDir, task, host, store } = await setupWithOverride();
  t.after(() => fs.rm(taskDir, { recursive: true, force: true }));
  const oldScope = task.projectWorkspace.scopeFingerprint;
  addSuggestion(task, { text: '新增当前目标的实现要求', classification: 'support' });
  assert.equal(task.projectWorkspace.status, 'reauthorization_required');
  assert.equal(task.projectWorkspace.scopeFingerprint, oldScope);
  task.projectWorkspace.status = 'ready';
  task.projectWorkspace.candidate.status = 'ready';
  task.workItems = [{ id: 'work-unit', status: 'running', role: 'developer' }];
  await assert.rejects(host.runTool(store, task.id, 'work-unit', {
    tool: 'workspace.diff', args: { expectedCandidateSha256: task.projectWorkspace.candidate.candidateSha256 },
  }), (error) => error.status === 409 && error.code === 'project_workspace_stale');
});

test('旧宿主 verifier hash 的 grant 不能为新候选生成通过记录', async (t) => {
  const { taskDir, task, host, store } = await setupWithOverride();
  t.after(() => fs.rm(taskDir, { recursive: true, force: true }));
  task.projectWorkspace.checks[0].hostVerifierSha256 = '0'.repeat(64);
  await assert.rejects(host.runTool(store, task.id, 'work-unit', {
    tool: 'workspace.check', args: { checkId: 'greet-name-contract-v1', expectedCandidateSha256: task.projectWorkspace.candidate.candidateSha256 },
  }), (error) => error.status === 409 && error.code === 'project_check_changed');
  assert.equal(task.projectWorkspace.candidate.checks.length, 0);
});

test('通用范围以全量 CAS 原子发布多文件并逐项运行 syntax 与 JSON 行为检查', { timeout: 30_000 }, async (t) => {
  const projectRoot = await fs.mkdtemp(tempPrefix);
  const taskDir = await fs.mkdtemp(tempPrefix);
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  t.after(() => fs.rm(taskDir, { recursive: true, force: true }));
  await fs.mkdir(path.join(projectRoot, 'app', 'public'), { recursive: true });
  await fs.writeFile(path.join(projectRoot, 'package.json'), '{"type":"module"}\n');
  await fs.writeFile(path.join(projectRoot, 'app', 'alpha.mjs'), 'export function alpha(value) { return value; }\n');
  await fs.writeFile(path.join(projectRoot, 'app', 'beta.mjs'), 'export function beta(value) { return value; }\n');
  const task = createTask({ title: '通用纯函数', goal: '整理并确认有限源码需求', type: 'project', successCriteria: ['用户确认用例'], boundaries: ['不写原项目'] });
  const repository = await registeredRepository(projectRoot);
  const binding = projectTaskBinding(task);
  const proposal = validateProjectScopeResult({
    repositoryId: 'irixi-office-agent', deliverable: 'project_patch',
    goal: { statement: '让两个同步纯函数分别执行确认的数值变换。', successCriteria: ['alpha(1)=2', 'beta(2)=4'], boundaries: ['无 import、网络、文件或异步副作用'] },
    readablePaths: ['app/alpha.mjs', 'app/beta.mjs'], editablePaths: ['app/alpha.mjs', 'app/beta.mjs'],
    checks: [
      { id: 'node-syntax-v1', modulePath: null, namedExport: null, cases: null },
      { id: 'json-function-v1', modulePath: 'app/alpha.mjs', namedExport: 'alpha', cases: [{ id: 'alpha-one', argsJson: '[1]', expectedJson: '2' }] },
      { id: 'json-function-v1', modulePath: 'app/beta.mjs', namedExport: 'beta', cases: [{ id: 'beta-two', argsJson: '[2]', expectedJson: '4' }] },
    ],
    rationale: '两个模块都由独立行为用例覆盖。',
  }, repository, binding);
  task.projectScopeProposal = { ...proposal, status: 'accepted', acceptedTaskInputBinding: binding };
  const host = createProjectWorkspaceHost({ projectRoot, capabilityOverride: safeCapability });
  const capability = await host.capabilities();
  await host.attachDraft(task, taskDir, {
    proposalId: proposal.id, expectedProposalFingerprint: proposal.fingerprint,
    expectedGoalVersionId: binding.goalVersionId, expectedProjectRootGoalVersionId: binding.projectRootGoalVersionId,
    expectedProjectRootInputFingerprint: binding.projectRootInputFingerprint,
    expectedMaterialApplicabilityFingerprint: binding.materialApplicabilityFingerprint,
    expectedPreviousScopeFingerprint: null, expectedCapabilityFingerprint: capability.fingerprint,
  });
  task.execution = { id: 'run-generic' };
  task.workItems = [{ id: 'work-generic', status: 'running', role: 'developer' }];
  task.agentSessions = [];
  const store = memoryStore(task, taskDir);
  const initialSha = task.projectWorkspace.candidate.candidateSha256;
  const alpha = task.projectWorkspace.candidate.manifest.find((entry) => entry.path === 'app/alpha.mjs');
  const beta = task.projectWorkspace.candidate.manifest.find((entry) => entry.path === 'app/beta.mjs');
  await assert.rejects(host.runTool(store, task.id, 'work-generic', { tool: 'workspace.write', args: {
    expectedCandidateSha256: initialSha,
    changes: [{ path: 'app/alpha.mjs', expectedFileSha256: alpha.sha256, content: 'export function alpha(value) { return value; }\n' }],
  } }), (error) => error.code === 'project_no_change');
  assert.equal(task.projectWorkspace.candidate.candidateSha256, initialSha);
  await assert.rejects(host.runTool(store, task.id, 'work-generic', { tool: 'workspace.write', args: {
    expectedCandidateSha256: initialSha,
    changes: [
      { path: 'app/alpha.mjs', expectedFileSha256: alpha.sha256, content: 'export function alpha(value) { return value + 1; }\n' },
      { path: 'app/beta.mjs', expectedFileSha256: '0'.repeat(64), content: 'export function beta(value) { return value * 2; }\n' },
    ],
  } }), /迟到修改/);
  assert.equal(task.projectWorkspace.candidate.candidateSha256, initialSha);
  const written = await host.runTool(store, task.id, 'work-generic', { tool: 'workspace.write', args: {
    expectedCandidateSha256: initialSha,
    changes: [
      { path: 'app/alpha.mjs', expectedFileSha256: alpha.sha256, content: 'export function alpha(value) { return value + 1; }\n' },
      { path: 'app/beta.mjs', expectedFileSha256: beta.sha256, content: 'export function beta(value) { return value * 2; }\n' },
    ],
  } });
  assert.equal(written.changes.length, 2);
  assert.notEqual(written.candidateSha256, initialSha);
  const checks = [];
  for (const descriptor of task.projectWorkspace.checks) checks.push(await host.runTool(store, task.id, 'work-generic', {
    tool: 'workspace.check', args: { checkId: descriptor.id, expectedCandidateSha256: written.candidateSha256 },
  }));
  assert.equal(checks.every((entry) => entry.passed), true);
  assert.deepEqual(checks.map((entry) => entry.casePassed), [2, 1, 1]);
  const diff = await host.runTool(store, task.id, 'work-generic', { tool: 'workspace.diff', args: { expectedCandidateSha256: written.candidateSha256 } });
  assert.deepEqual(diff.changes.map((entry) => entry.path), ['app/alpha.mjs', 'app/beta.mjs']);
  assert.equal(diff.sourceIntegrity.allUnchanged, true);
});

test('候选写入逐段拒绝 symlink 与 hardlink，外部 canary 不变', async (t) => {
  const { taskDir, task, host, store } = await setupWithOverride();
  t.after(() => fs.rm(taskDir, { recursive: true, force: true }));
  const candidateRoot = path.join(taskDir, ...task.projectWorkspace.candidate.relativeRoot.split('/'));
  const outside = await fs.mkdtemp(tempPrefix);
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  const outsideFile = path.join(outside, 'greeting.mjs');
  await fs.writeFile(outsideFile, 'OUTSIDE_CANARY\n');
  const originalCandidate = task.projectWorkspace.candidate.candidateSha256;
  const originalFile = task.projectWorkspace.candidate.manifest.find((entry) => entry.path === 'src/greeting.mjs').sha256;
  await fs.rm(path.join(candidateRoot, 'src'), { recursive: true });
  await fs.symlink(outside, path.join(candidateRoot, 'src'));
  await assert.rejects(host.runTool(store, task.id, 'work-unit', {
    tool: 'workspace.write', args: { path: 'src/greeting.mjs', expectedFileSha256: originalFile, expectedCandidateSha256: originalCandidate, content: 'forbidden' },
  }), (error) => error.code === 'project_workspace_error' && !error.message.includes(taskDir));
  assert.equal(await fs.readFile(outsideFile, 'utf8'), 'OUTSIDE_CANARY\n');

  await fs.rm(path.join(candidateRoot, 'src'));
  await fs.mkdir(path.join(candidateRoot, 'src'));
  await fs.link(outsideFile, path.join(candidateRoot, 'src', 'greeting.mjs'));
  await assert.rejects(host.runTool(store, task.id, 'work-unit', {
    tool: 'workspace.read', args: { path: 'src/greeting.mjs', view: 'candidate', expectedCandidateSha256: originalCandidate },
  }), (error) => error.code === 'project_workspace_error');
  assert.equal(await fs.readFile(outsideFile, 'utf8'), 'OUTSIDE_CANARY\n');
});

test('sandbox-exec bytes 漂移使旧 capability 与检查 fail closed', { skip: process.platform !== 'darwin' }, async (t) => {
  const taskDir = await fs.mkdtemp(tempPrefix);
  t.after(() => fs.rm(taskDir, { recursive: true, force: true }));
  const fakeSandbox = path.join(taskDir, 'sandbox-exec-fixture');
  await fs.writeFile(fakeSandbox, 'sandbox-v1\n', { mode: 0o700 });
  const task = createTask({ title: '运行时漂移', goal: '验证固定运行时指纹', type: 'project', successCriteria: ['漂移拒绝'], boundaries: ['不执行任意命令'] });
  const host = createProjectWorkspaceHost({ sandboxExecPath: fakeSandbox, capabilityOverride: safeCapability });
  const capability = await host.capabilities();
  await host.attachDraft(task, taskDir, expectedAttach(task, capability));
  task.execution = { id: 'run-runtime-drift' };
  task.workItems = [{ id: 'work-runtime-drift', status: 'running', role: 'developer' }];
  task.agentSessions = [];
  await fs.writeFile(fakeSandbox, 'sandbox-v2\n', { mode: 0o700 });
  await assert.rejects(host.runTool(memoryStore(task, taskDir), task.id, 'work-runtime-drift', {
    tool: 'workspace.check', args: { checkId: 'greet-name-contract-v1', expectedCandidateSha256: task.projectWorkspace.candidate.candidateSha256 },
  }), (error) => error.status === 409 && error.code === 'project_runtime_changed');
});

test('workspace.diff 每次重读三份 original/snapshot 文件并拒绝原件变化', async (t) => {
  const fixtureParent = await fs.mkdtemp(tempPrefix);
  const fixtureRoot = path.join(fixtureParent, 'fixture');
  t.after(() => fs.rm(fixtureParent, { recursive: true, force: true }));
  const fixture = structuredClone(__test.DEFAULT_FIXTURES['node-single-file-v1']);
  await fs.cp(fixture.sourceRoot, fixtureRoot, { recursive: true });
  fixture.sourceRoot = fixtureRoot;
  const { taskDir, task, host, store } = await setupWithOverride({ fixtures: { fixture } });
  t.after(() => fs.rm(taskDir, { recursive: true, force: true }));
  const first = await host.runTool(store, task.id, 'work-unit', {
    tool: 'workspace.diff', args: { expectedCandidateSha256: task.projectWorkspace.candidate.candidateSha256 },
  });
  assert.equal(first.sourceIntegrity.verified, true);
  assert.equal(first.sourceIntegrity.fileCount, 3);
  assert.equal(first.sourceIntegrity.paths.every((entry) => entry.unchanged), true);
  assert.deepEqual(first.sourceIntegrity.paths.map((entry) => entry.path), ['checks/check.mjs', 'package.json', 'src/greeting.mjs']);
  assert.equal(JSON.stringify(first.sourceIntegrity).includes(fixtureRoot), false);
  assert.equal(JSON.stringify(first.sourceIntegrity).includes('Hello,'), false);
  assert.deepEqual(task.projectWorkspace.candidate.sourceIntegrity, first.sourceIntegrity);

  await fs.writeFile(path.join(fixtureRoot, 'package.json'), '{"changed":true}\n');
  await assert.rejects(host.runTool(store, task.id, 'work-unit', {
    tool: 'workspace.diff', args: { expectedCandidateSha256: task.projectWorkspace.candidate.candidateSha256 },
  }), (error) => error.status === 409 && error.code === 'project_source_changed' && !error.message.includes(fixtureRoot));
});

test('生产流式 cap 对 stdout/stderr flood 立即失败并终止整个进程组', async (t) => {
  const root = await fs.mkdtemp(tempPrefix);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const stream of ['stdout', 'stderr']) {
    const marker = path.join(root, `${stream}.marker`);
    const script = path.join(root, `${stream}.mjs`);
    await fs.writeFile(script, `import {spawn} from 'node:child_process';\nspawn(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'alive'),250)`) }]);\nconst s='x'.repeat(8192);\nprocess.${stream}.write(s);\nsetInterval(()=>{},1000);\n`);
    const result = await __test.runChild(process.execPath, [script], { timeoutMs: 1_000, cwd: root });
    assert.equal(result.outputLimitExceeded, true);
    assert.equal(result.truncated, true);
    assert.ok(result[`${stream}Bytes`] > 4096);
    assert.ok(Buffer.byteLength(result[stream]) <= 4096);
    await new Promise((resolve) => setTimeout(resolve, 450));
    await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
  }
});

test('生产 timeout 与 cancel 终止进程组，不留下继续写入的 Node', async (t) => {
  const root = await fs.mkdtemp(tempPrefix);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const marker = path.join(root, 'marker');
  const script = path.join(root, 'hang.mjs');
  await fs.writeFile(script, `import {spawn} from 'node:child_process';\nspawn(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'alive'),250)`) }]);\nsetInterval(()=>{},1000);\n`);
  const result = await __test.runChild(process.execPath, [script], { timeoutMs: 50, cwd: root });
  assert.equal(result.timedOut, true);
  await new Promise((resolve) => setTimeout(resolve, 450));
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });

  const abort = new AbortController();
  const pending = __test.runChild(process.execPath, [script], { timeoutMs: 1_000, cwd: root, signal: abort.signal });
  setTimeout(() => abort.abort(), 30);
  await assert.rejects(pending, (error) => error.code === 'cancelled');
  await new Promise((resolve) => setTimeout(resolve, 450));
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
});

test('默认 continuity fixture 的当前产品函数原生固定检查 23/23', { skip: process.platform !== 'darwin', timeout: 30_000 }, async (t) => {
  const taskDir = await fs.mkdtemp(tempPrefix);
  t.after(() => fs.rm(taskDir, { recursive: true, force: true }));
  const task = createTask({ title: '当前续接状态', goal: '核对当前产品续接状态', type: 'project', successCriteria: ['固定状态矩阵通过'], boundaries: ['只读当前 renderContinuity'] });
  task.plan = { id: 'plan-current-continuity', revision: 1 };
  const host = createProjectWorkspaceHost({ capabilityOverride: safeCapability });
  const capabilities = await host.capabilities();
  const fixture = capabilities.fixtures.find((entry) => entry.id === 'irixi-continuity-ui-v1');
  await host.attachDraft(task, taskDir, expectedAttach(task, capabilities, null, fixture.id));
  task.execution = { id: 'run-current-continuity' };
  task.workItems = [{ id: 'work-current-continuity', status: 'running', role: 'project_developer' }];
  task.agentSessions = [];
  const read = await host.runTool(memoryStore(task, taskDir), task.id, 'work-current-continuity', {
    tool: 'workspace.read', args: { path: 'app/public/app.js', view: 'candidate', expectedCandidateSha256: task.projectWorkspace.candidate.candidateSha256 },
  });
  const currentRegion = continuityRegion(await fs.readFile(path.resolve('app/public/app.js'), 'utf8')).content;
  assert.equal(read.bytes, Buffer.byteLength(currentRegion));
  assert.equal(read.fileSha256, crypto.createHash('sha256').update(currentRegion).digest('hex'));
  const checked = await host.runTool(memoryStore(task, taskDir), task.id, 'work-current-continuity', {
    tool: 'workspace.check', args: { checkId: fixture.checks[0].id, expectedCandidateSha256: task.projectWorkspace.candidate.candidateSha256 },
  });
  assert.equal(checked.caseTotal, 23);
  assert.equal(checked.casePassed, 23);
  assert.equal(checked.passed, true);
});

test('独立 legacy continuity sourceRoot 严格保留 9/23 基线，修复后完整矩阵与区域证据通过', { skip: process.platform !== 'darwin', timeout: 45_000 }, async (t) => {
  const taskDir = await fs.mkdtemp(tempPrefix);
  t.after(() => fs.rm(taskDir, { recursive: true, force: true }));
  const ownedSourceRoot = path.join(taskDir, 'owned-legacy-source');
  const originalFile = path.join(ownedSourceRoot, 'app/public/app.js');
  await fs.mkdir(path.dirname(originalFile), { recursive: true });
  await fs.mkdir(path.join(ownedSourceRoot, 'app/project-fixtures/irixi-continuity-ui-v1/checks'), { recursive: true });
  const currentSource = await fs.readFile(path.resolve('app/public/app.js'), 'utf8');
  const currentParts = continuityRegion(currentSource);
  const legacySource = `${currentParts.prefix}${LEGACY_CONTINUITY_FUNCTION}${currentParts.suffix}`;
  await fs.writeFile(originalFile, legacySource);
  await fs.copyFile(path.resolve('package.json'), path.join(ownedSourceRoot, 'package.json'));
  await fs.copyFile(path.resolve('app/project-fixtures/irixi-continuity-ui-v1/checks/check.mjs'), path.join(ownedSourceRoot, 'app/project-fixtures/irixi-continuity-ui-v1/checks/check.mjs'));
  const originalBytes = await fs.readFile(originalFile);
  const originalParts = continuityRegion(originalBytes.toString('utf8'));
  assert.equal(crypto.createHash('sha256').update(originalParts.content).digest('hex'), LEGACY_CONTINUITY_SHA256);
  const task = createTask({ title: '续接状态小修复', goal: '修复终止状态的继续提示', type: 'project', successCriteria: ['固定状态矩阵通过'], boundaries: ['只改 renderContinuity'] });
  task.plan = { id: 'plan-continuity-region', revision: 1 };
  const fixtureDefinition = structuredClone(__test.DEFAULT_FIXTURES['irixi-continuity-ui-v1']);
  fixtureDefinition.sourceRoot = ownedSourceRoot;
  const host = createProjectWorkspaceHost({ capabilityOverride: safeCapability, fixtures: { continuity: fixtureDefinition } });
  const capabilities = await host.capabilities();
  const fixture = capabilities.fixtures.find((entry) => entry.id === 'irixi-continuity-ui-v1');
  assert.ok(fixture);
  assert.equal(fixture.publicContract.entrypoint, 'renderContinuity');
  assert.equal(fixture.readablePaths.join(','), 'app/public/app.js');
  assert.equal(fixture.editablePaths.join(','), 'app/public/app.js');
  const workspace = await host.attachDraft(task, taskDir, expectedAttach(task, capabilities, null, fixture.id));
  assert.equal(workspace.status, 'ready');
  assert.equal(workspace.publicContract.id, 'render-continuity-terminal-state-v1');
  assert.equal(task.projectWorkspace.sourceManifest.length, 3);
  task.execution = { id: 'run-continuity' };
  task.workItems = [{ id: 'work-continuity', status: 'running', role: 'project_developer' }];
  task.agentSessions = [];
  const store = memoryStore(task, taskDir);

  const read = await host.runTool(store, task.id, 'work-continuity', {
    tool: 'workspace.read', args: { path: 'app/public/app.js', view: 'candidate', expectedCandidateSha256: task.projectWorkspace.candidate.candidateSha256 },
  });
  assert.equal(read.contentScope, 'render-continuity-function-v1');
  assert.equal(read.bytes, 1767);
  assert.equal(read.fileSha256, '90c82c08cf046b1460f7d4df94993f589e55905817ea46b9b2d6971892cf0ae2');
  assert.equal(read.wholeFileBytes, originalBytes.length);
  assert.notEqual(read.wholeFileSha256, read.fileSha256);
  assert.equal(read.content, originalParts.content);
  await assert.rejects(host.runTool(store, task.id, 'work-continuity', {
    tool: 'workspace.write', args: { path: 'app/public/app.js', expectedFileSha256: read.fileSha256, expectedCandidateSha256: read.candidateSha256, content: `${read.content}\n` },
  }), (error) => error.code === 'project_region_invalid');
  await assert.rejects(host.runTool(store, task.id, 'work-continuity', {
    tool: 'workspace.write', args: { path: 'app/public/app.js', expectedFileSha256: '0'.repeat(64), expectedCandidateSha256: read.candidateSha256, content: read.content },
  }), (error) => error.status === 409);
  assert.deepEqual(await fs.readFile(originalFile), originalBytes);

  const before = await host.runTool(store, task.id, 'work-continuity', {
    tool: 'workspace.check', args: { checkId: fixture.checks[0].id, expectedCandidateSha256: task.projectWorkspace.candidate.candidateSha256 },
  });
  assert.equal(before.caseTotal, 23);
  assert.equal(before.casePassed, 9);
  assert.equal(before.passed, false);
  assert.deepEqual(before.cases.filter((entry) => !entry.passed).map((entry) => entry.caseId), [
    'budget_exhausted-failed-blocked', 'budget_exhausted-partial-blocked', 'budget_exhausted-cancelled-blocked', 'budget_exhausted-cancellation_unknown-blocked',
    'permanent_error-failed-blocked', 'permanent_error-partial-blocked', 'permanent_error-cancelled-blocked', 'permanent_error-cancellation_unknown-blocked',
    'same_error_exhausted-failed-blocked', 'same_error_exhausted-partial-blocked', 'same_error_exhausted-cancelled-blocked', 'same_error_exhausted-cancellation_unknown-blocked',
    'project_verification_failed-partial-blocked', 'project_transaction_failed-partial-blocked',
  ]);

  const repaired = repairedLegacyContinuity(read.content);
  const candidateRoot = path.join(taskDir, ...task.projectWorkspace.candidate.relativeRoot.split('/'));
  const candidateFile = path.join(candidateRoot, 'app/public/app.js');
  const fixedBody = repaired.slice('function renderContinuity(task) {'.length, -1);
  const commaExpressionBypass = `${repaired}, function forgedRender(task) {${fixedBody}}`;
  const bypassWritten = await host.runTool(store, task.id, 'work-continuity', {
    tool: 'workspace.write', args: { path: 'app/public/app.js', expectedFileSha256: read.fileSha256, expectedCandidateSha256: read.candidateSha256, content: commaExpressionBypass },
  });
  const invalidWholeFile = await __test.runChild(process.execPath, ['--check', candidateFile], { cwd: candidateRoot });
  assert.notEqual(invalidWholeFile.code, 0);
  const bypassCheck = await host.runTool(store, task.id, 'work-continuity', {
    tool: 'workspace.check', args: { checkId: fixture.checks[0].id, expectedCandidateSha256: bypassWritten.candidateSha256 },
  });
  assert.equal(bypassCheck.passed, false);
  assert.equal(bypassCheck.casePassed, 0);
  const reread = await host.runTool(store, task.id, 'work-continuity', {
    tool: 'workspace.read', args: { path: 'app/public/app.js', view: 'candidate', expectedCandidateSha256: bypassWritten.candidateSha256 },
  });
  const written = await host.runTool(store, task.id, 'work-continuity', {
    tool: 'workspace.write', args: { path: 'app/public/app.js', expectedFileSha256: reread.fileSha256, expectedCandidateSha256: reread.candidateSha256, content: repaired },
  });
  assert.equal(written.contentScope, 'render-continuity-function-v1');
  assert.equal(written.bytes, Buffer.byteLength(repaired));
  assert.match(written.fileSha256, /^[a-f0-9]{64}$/);
  assert.notEqual(written.wholeFileSha256, read.wholeFileSha256);
  const validWholeFile = await __test.runChild(process.execPath, ['--check', candidateFile], { cwd: candidateRoot });
  assert.equal(validWholeFile.code, 0);
  const candidateParts = continuityRegion(await fs.readFile(candidateFile, 'utf8'));
  assert.equal(candidateParts.prefix, originalParts.prefix);
  assert.equal(candidateParts.suffix, originalParts.suffix);
  assert.equal(candidateParts.content, repaired);
  assert.deepEqual(await fs.readFile(originalFile), originalBytes);

  const passed = await host.runTool(store, task.id, 'work-continuity', {
    tool: 'workspace.check', args: { checkId: fixture.checks[0].id, expectedCandidateSha256: written.candidateSha256 },
  });
  assert.equal(passed.passed, true);
  assert.equal(passed.casePassed, 23);
  assert.equal(passed.caseTotal, 23);
  assert.equal(passed.cases.every((entry) => !Object.hasOwn(entry, 'value') && !Object.hasOwn(entry, 'stdout')), true);
  const diff = await host.runTool(store, task.id, 'work-continuity', {
    tool: 'workspace.diff', args: { expectedCandidateSha256: written.candidateSha256 },
  });
  assert.deepEqual(diff.changes.map((entry) => entry.path), ['app/public/app.js']);
  assert.equal(diff.sourceIntegrity.fileCount, 3);
  assert.equal(diff.sourceIntegrity.allUnchanged, true);
  assert.ok(diff.regionIntegrity);
  assert.equal(diff.regionIntegrity.path, 'app/public/app.js');
  assert.equal(diff.regionIntegrity.regionId, 'render-continuity-function-v1');
  assert.equal(diff.regionIntegrity.outsideUnchanged, true);
  assert.equal(diff.regionIntegrity.sourceWhole.bytes, originalBytes.length);
  assert.equal(diff.regionIntegrity.sourceRegion.sha256, read.fileSha256);
  assert.equal(diff.regionIntegrity.candidateRegion.sha256, written.fileSha256);
  assert.equal(diff.regionIntegrity.patchSha256, diff.diffSha256);
  assert.equal(diff.regionIntegrity.reconstructedCandidateSha256, written.wholeFileSha256);
  assert.doesNotMatch(diff.patch, /@@ -1,/);
  assert.doesNotMatch(diff.patch, /^[-+]import /m);
  assert.match(diff.patch, /^@@ -\d+,\d+ \+\d+,\d+ @@$/m);
  assert.equal(__test.applySingleHunk(originalBytes.toString('utf8'), diff.patch, originalBytes.toString('utf8').endsWith('\n')), await fs.readFile(candidateFile, 'utf8'));

  const evidence = await host.buildArtifactEvidence(task, taskDir);
  evidence.projectExecutionAudit = { auditSha256: 'continuity-region-audit', plan: { id: task.plan.id, revision: task.plan.revision } };
  evidence.projectExecutionAuditSha256 = evidence.projectExecutionAudit.auditSha256;
  assert.deepEqual(evidence.regionIntegrity, diff.regionIntegrity);
  assert.equal(evidence.regionIntegritySha256, diff.regionIntegrity.integritySha256);
  assert.equal((await host.assertArtifactFilesCurrent(task, taskDir, { projectCandidate: evidence })).toString('utf8'), diff.patch);
  const tamperedRegion = structuredClone(evidence);
  tamperedRegion.regionIntegrity.prefix.sha256 = '0'.repeat(64);
  await assert.rejects(host.assertArtifactFilesCurrent(task, taskDir, { projectCandidate: tamperedRegion }), (error) => error.status === 400 || error.status === 409);
  const missingRegion = structuredClone(evidence);
  delete missingRegion.regionIntegrity;
  delete missingRegion.regionIntegritySha256;
  await assert.rejects(host.assertArtifactFilesCurrent(task, taskDir, { projectCandidate: missingRegion }), (error) => error.status === 400 || error.status === 409);

  const tampered = await fs.readFile(candidateFile, 'utf8');
  await fs.writeFile(candidateFile, ` ${tampered.slice(1)}`);
  await assert.rejects(host.runTool(store, task.id, 'work-continuity', {
    tool: 'workspace.check', args: { checkId: fixture.checks[0].id, expectedCandidateSha256: written.candidateSha256 },
  }), (error) => error.code === 'project_region_outside_changed');
  assert.deepEqual(await fs.readFile(originalFile), originalBytes);
});

test('实际 macOS sandbox 对固定 greetName 合约执行父侧 verifier 并拒绝欺骗输出', { skip: process.platform !== 'darwin', timeout: 45_000 }, async (t) => {
  const taskDir = await fs.mkdtemp(tempPrefix);
  t.after(() => fs.rm(taskDir, { recursive: true, force: true }));
  const task = createTask({ title: '真实隔离问候函数', goal: '实现 greetName 固定行为', type: 'project', successCriteria: ['三条固定行为通过'], boundaries: ['不写原项目'] });
  const host = createProjectWorkspaceHost();
  const capabilities = await host.capabilities();
  assert.equal(capabilities.available, true);
  assert.equal(typeof capabilities.sandboxExecSha256, 'string');
  assert.equal(capabilities.fixtures[0].checks[0].executionContractSha256, __test.EXECUTION_CONTRACT_SHA256);
  const workspace = await host.attachDraft(task, taskDir, expectedAttach(task, capabilities));
  task.plan = { id: 'plan-sandbox', revision: 1 };
  assert.equal(workspace.status, 'ready');
  assert.equal(workspace.sandboxCapability.probes.every((entry) => entry.accepted), true);
  assert.equal(workspace.sandboxCapability.networkConnections, 0);
  assert.equal(workspace.sandboxCapability.writesAbsent, true);
  task.execution = { id: 'run-sandbox' };
  task.workItems = [{ id: 'work-sandbox', status: 'running', role: 'project_developer' }];
  task.agentSessions = [];
  const store = memoryStore(task, taskDir);

  async function writeCandidate(content) {
    const read = await host.runTool(store, task.id, 'work-sandbox', {
      tool: 'workspace.read', args: { path: 'src/greeting.mjs', view: 'candidate', expectedCandidateSha256: task.projectWorkspace.candidate.candidateSha256 },
    });
    return host.runTool(store, task.id, 'work-sandbox', {
      tool: 'workspace.write', args: { path: 'src/greeting.mjs', expectedFileSha256: read.fileSha256, expectedCandidateSha256: read.candidateSha256, content },
    });
  }
  async function check() {
    return host.runTool(store, task.id, 'work-sandbox', {
      tool: 'workspace.check', args: { checkId: 'greet-name-contract-v1', expectedCandidateSha256: task.projectWorkspace.candidate.candidateSha256 },
    });
  }

  await writeCandidate("export function greetName(name) { const value = String(name).trim(); return value ? `Hello, ${value}!` : 'Hello, friend!'; }\n");
  const passed = await check();
  assert.equal(passed.passed, true);
  assert.equal(passed.casePassed, 3);
  assert.equal(passed.caseTotal, 3);
  assert.equal(typeof passed.contractSha256, 'string');
  assert.equal(typeof passed.inputSetSha256, 'string');
  assert.equal(typeof passed.expectedSetSha256, 'string');
  const diff = await host.runTool(store, task.id, 'work-sandbox', {
    tool: 'workspace.diff', args: { expectedCandidateSha256: task.projectWorkspace.candidate.candidateSha256 },
  });
  assert.match(diff.patch, /Hello, friend!/);
  assert.equal(diff.sourceIntegrity.fileCount, 3);
  assert.equal(diff.sourceIntegrity.paths.every((entry) => entry.unchanged), true);
  assert.equal(JSON.stringify(diff.sourceIntegrity).includes(taskDir), false);
  assert.deepEqual(publicTask(task).projectWorkspace.candidate.sourceIntegrity, diff.sourceIntegrity);
  const evidence = await host.buildArtifactEvidence(task, taskDir);
  evidence.projectExecutionAudit = { auditSha256: 'sandbox-execution-audit', plan: { id: task.plan.id, revision: task.plan.revision } };
  evidence.projectExecutionAuditSha256 = evidence.projectExecutionAudit.auditSha256;
  assert.equal(evidence.patch, diff.patch);
  assert.equal(evidence.patchSha256.length, 64);
  assert.deepEqual(evidence.sourceIntegrity, diff.sourceIntegrity);
  assert.equal(evidence.sourceIntegritySha256, evidence.sourceIntegrity.integritySha256);
  assert.equal(await host.assertArtifactFilesCurrent(task, taskDir, { projectCandidate: evidence }).then((bytes) => bytes.toString('utf8')), diff.patch);
  const missingAudit = structuredClone(evidence);
  delete missingAudit.projectExecutionAudit;
  await assert.rejects(host.assertArtifactFilesCurrent(task, taskDir, { projectCandidate: missingAudit }));
  const forgedAudit = structuredClone(evidence);
  forgedAudit.projectExecutionAudit.auditSha256 = '0'.repeat(64);
  await assert.rejects(host.assertArtifactFilesCurrent(task, taskDir, { projectCandidate: forgedAudit }));
  const tamperedEvidence = structuredClone(evidence);
  tamperedEvidence.patch += '\nUNREVIEWED_CHANGE';
  await assert.rejects(host.assertArtifactFilesCurrent(task, taskDir, { projectCandidate: tamperedEvidence }), (error) => error.status === 400 || error.status === 409);

  const missingIntegrity = structuredClone(evidence);
  delete missingIntegrity.sourceIntegrity;
  await assert.rejects(host.assertArtifactFilesCurrent(task, taskDir, { projectCandidate: missingIntegrity }));
  const forgedIntegrity = structuredClone(evidence);
  forgedIntegrity.sourceIntegrity.paths[0].currentOriginal.sha256 = '0'.repeat(64);
  const { integritySha256: _oldIntegrity, ...forgedBody } = forgedIntegrity.sourceIntegrity;
  forgedIntegrity.sourceIntegrity.integritySha256 = __test.fingerprint(forgedBody);
  forgedIntegrity.sourceIntegritySha256 = forgedIntegrity.sourceIntegrity.integritySha256;
  await assert.rejects(host.assertArtifactFilesCurrent(task, taskDir, { projectCandidate: forgedIntegrity }), (error) => error.code === 'project_source_integrity_stale');

  const tamperedCheck = structuredClone(evidence);
  tamperedCheck.checks[0].casePassed = 2;
  await assert.rejects(host.assertArtifactFilesCurrent(task, taskDir, { projectCandidate: tamperedCheck }), (error) => error.code === 'project_check_stale');
  const removedCheck = structuredClone(evidence);
  removedCheck.checks[0].id = 'check-not-current';
  await assert.rejects(host.assertArtifactFilesCurrent(task, taskDir, { projectCandidate: removedCheck }), (error) => error.code === 'project_check_stale');

  const privateSourcePackage = path.join(taskDir, ...task.projectWorkspace.grantRelativeRoot.split('/'), 'source', 'package.json');
  const sourcePackage = await fs.readFile(privateSourcePackage);
  await fs.writeFile(privateSourcePackage, '{"changed":true}\n');
  await assert.rejects(host.assertArtifactFilesCurrent(task, taskDir, { projectCandidate: evidence }), (error) => error.code === 'project_source_changed');
  await assert.rejects(host.buildArtifactEvidence(task, taskDir), (error) => error.code === 'project_source_changed');
  await fs.writeFile(privateSourcePackage, sourcePackage);

  const attacks = [
    ['exit-zero', 'process.exit(0); export function greetName() { return "unused"; }\n'],
    ['wrong-value', 'export function greetName() { return "wrong"; }\n'],
    ['missing-export', 'export const notGreetName = () => "wrong";\n'],
    ['wrong-type', 'export function greetName() { return 7; }\n'],
    ['extra-stdout', 'console.log("EXTRA_CHILD_OUTPUT"); export function greetName(name) { const v=String(name).trim(); return v ? `Hello, ${v}!` : "Hello, friend!"; }\n'],
    ['duplicate-json', 'process.stdout.write("{}\\n{}\\n"); export function greetName(name) { const v=String(name).trim(); return v ? `Hello, ${v}!` : "Hello, friend!"; }\n'],
    ['hang', 'export function greetName() { while (true) {} }\n'],
    ['stdout-flood', 'process.stdout.write("x".repeat(8192)); export function greetName() { return "wrong"; }\n'],
    ['stderr-flood', 'process.stderr.write("x".repeat(8192)); export function greetName() { return "wrong"; }\n'],
  ];
  for (const [name, source] of attacks) {
    await writeCandidate(source);
    const result = await check();
    assert.equal(result.passed, false, name);
    assert.equal(JSON.stringify(result).includes('EXTRA_CHILD_OUTPUT'), false, name);
    assert.equal(JSON.stringify(result).includes(taskDir), false, name);
    for (const item of result.cases) {
      assert.equal(Object.hasOwn(item, 'stdout'), false);
      assert.equal(Object.hasOwn(item, 'stderr'), false);
      assert.equal(Object.hasOwn(item, 'value'), false);
    }
  }

  await writeCandidate('process.stderr.write("RAW_CHILD_STDERR_SENTINEL"); export function greetName(name) { const v=String(name).trim(); return v ? `Hello, ${v}!` : "Hello, friend!"; }\n');
  const privateOutput = await check();
  assert.equal(privateOutput.passed, true, JSON.stringify(privateOutput));
  assert.equal(JSON.stringify(privateOutput).includes('RAW_CHILD_STDERR_SENTINEL'), false);
  assert.equal(JSON.stringify(privateOutput).includes(taskDir), false);
  assert.equal(JSON.stringify(publicTask(task)).includes(taskDir), false);
});
