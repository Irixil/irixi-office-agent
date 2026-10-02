import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { addSuggestion, createTask, invalidateCurrentWork, publicTask } from '../core.mjs';
import { __test, createProjectWorkspaceHost, projectArtifactIsCurrent } from '../project-workspace.mjs';

const safeCapability = {
  available: true,
  reason: 'test-only capability',
  fingerprint: 'test-capability',
  runtimeFingerprint: null,
  probes: [],
};
const tempPrefix = path.join(process.cwd(), '.project-test-');

function expectedAttach(task, capabilities, previous = null) {
  return {
    fixtureId: 'node-single-file-v1',
    expectedGoalVersionId: task.goal.activeVersionId,
    expectedProjectRootGoalVersionId: task.projectRootGoalVersionId,
    expectedProjectRootInputFingerprint: task.projectRootInputFingerprint,
    expectedMaterialApplicabilityFingerprint: task.materialContext?.fingerprint ?? null,
    expectedPreviousScopeFingerprint: previous,
    expectedCapabilityFingerprint: capabilities.fingerprint,
  };
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

test('patch 对文件末尾换行状态给出合法整文件 unified diff', () => {
  assert.equal(__test.unifiedPatch([{ path: 'src/x.mjs', before: 'old\n', after: 'new\n' }]),
    '--- a/src/x.mjs\n+++ b/src/x.mjs\n@@ -1,1 +1,1 @@\n-old\n+new\n');
  assert.equal(__test.unifiedPatch([{ path: 'src/x.mjs', before: 'old', after: 'new' }]),
    '--- a/src/x.mjs\n+++ b/src/x.mjs\n@@ -1,1 +1,1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n');
  assert.equal(__test.unifiedPatch([{ path: 'src/x.mjs', before: '', after: 'new\n' }]),
    '--- a/src/x.mjs\n+++ b/src/x.mjs\n@@ -1,0 +1,1 @@\n+new\n');
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
