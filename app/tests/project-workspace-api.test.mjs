import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { createTask, recordReview } from '../core.mjs';
import { createTrustedProjectReviewFacts, groundingChecks } from '../execution.mjs';
import { createProjectWorkspaceHost } from '../project-workspace.mjs';
import { GENERIC_FIXTURE_ID, scopeFingerprint } from '../project-scope.mjs';
import { projectTaskBinding } from '../project-workspace.mjs';
import { compileProjectPlan } from '../orchestration.mjs';
import { __test as providerTest } from '../providers.mjs';
import { start } from '../server.mjs';

const tempPrefix = path.join(process.cwd(), '.project-api-test-');
const override = { available: true, reason: 'test-only', fingerprint: 'test-only', probes: [], networkConnections: 0, writesAbsent: true };

test('代码项目 planner 明确只生成四个固定步骤，不重复范围授权', () => {
  const task = createTask({ goal: '在有限源码范围内交付 patch', type: 'project' });
  const binding = projectTaskBinding(task);
  task.projectScopeProposal = { id: 'scope-prompt', fingerprint: 'scope-fingerprint', status: 'accepted' };
  task.projectWorkspace = {
    status: 'ready', fixtureId: GENERIC_FIXTURE_ID, executionMode: 'host_bounded_transaction_v1',
    proposalId: 'scope-prompt', proposalFingerprint: 'scope-fingerprint', taskInputBinding: binding,
    publicContract: {}, publicContractFingerprint: scopeFingerprint({}), scopeFingerprint: 'workspace-prompt', sourceSnapshotSha256: 'source-prompt',
  };
  const prompt = providerTest.plannerPrompt(task);
  assert.match(prompt, /只填写宿主公开四阶段契约的业务内容/);
  assert.match(prompt, /代码工作区也已单独授权/);
  assert.match(prompt, /不得重复填成模型工作/);
  assert.match(prompt, /宿主公开项目规划契约/);
  assert.match(prompt, /"current": true/);
  assert.match(prompt, /"slot": "tool"/);
  assert.match(prompt, /key、kind、dependsOn、tools、webScope、outputKind 和 deliverables 全由宿主/);
  assert.doesNotMatch(prompt, /每个步骤都必须返回 webScope/);
  assert.doesNotMatch(prompt, /outputKind 选择主要成果类型/);
  assert.doesNotMatch(prompt, /角色 key 与步骤 key 使用/);
  assert.doesNotMatch(prompt, /代码项目的 steps 必须/);
  assert.doesNotMatch(prompt, /只可选择 materials\.read/);
});
const RUN6_ARTIFACT_CONTENT = [
  '候选证据包',
  '',
  '版本锁定',
  '- 候选 ID：candidate-2cc13b0c-af5e-4520-a392-7340240c6cda',
  '- revision：1',
  '- candidate SHA-256：d5f5ffe4203f8f018ee5455a2fd9882901b5452d55907f0413294e8e7426e1aa',
  '- mutationSequence：1',
  '- diff SHA-256：4eff538b46441bedc683fa1c1796f1e432b30b77f9badb5e390c5d108d20ceac',
  '- 修改后文件 SHA-256：c785c3f142d47dc2a6c924010881537b8de911fe234d29ee480404b73df0fb23',
  '',
  '行为映射',
  '- named export：宿主提供的候选工作结果明确记录保留 named export `greetName(name)`。',
  '- trim 行为：候选实现先执行 `name.trim()`，去除字符串首尾空白。',
  '- 非空返回值：候选表达式 `Hello, ${trimmedName || "friend"}!` 在 trim 后非空时返回 `Hello, <name>!`。',
  '- 全空白回退值：输入经 trim 后为空时使用 `friend`，返回 `Hello, friend!`。',
  '- 固定检查：`greet-name-contract-v1` 对当前候选执行 3 个用例，3 个全部通过；用例为 english-name、han-name、empty-name。',
  '',
  '变更范围',
  '- workspace.diff 返回 1 个变更条目，唯一路径为 src/greeting.mjs。',
  '- 变更前 SHA-256：09d4b9f82c8d4a130a3a50ff79de8c98addc0a2bb0b3b94333a186d1209bdcee。',
  '- 变更后 SHA-256：c785c3f142d47dc2a6c924010881537b8de911fe234d29ee480404b73df0fb23。',
  '- 修改后大小为 118 bytes；diff SHA-256 非空。',
  '',
  '源完整性',
  '- synthesis 前最新 projectSourceIntegrity 显示 checks/check.mjs、package.json、src/greeting.mjs 的 authorized、currentOriginal 与 taskSnapshot 哈希逐项一致。',
  '- allUnchanged=true，完整性 SHA-256 为 52f4d2fd163cbcaa39dfdea0993a8bd25b95322e4476a68cba9905be413198a9。',
  '',
  '综合结论',
  '当前候选的宿主代码证据、检查结果、实际 diff、版本标识及源完整性证据相互绑定，满足进入独立审阅的条件。此结论不表示 patch 已导出、候选已获独立审阅通过或指定版本已由用户确认。',
].join('\n');
const RUN6_DELIVERABLE_CONTENT = '候选供用户审阅：candidate-2cc13b0c-af5e-4520-a392-7340240c6cda，revision 1，candidate SHA-256 d5f5ffe4203f8f018ee5455a2fd9882901b5452d55907f0413294e8e7426e1aa。唯一变更文件为 src/greeting.mjs；diff SHA-256 为 4eff538b46441bedc683fa1c1796f1e432b30b77f9badb5e390c5d108d20ceac。候选保持 named export `greetName(name)`，以 `name.trim()` 去除首尾空白，并通过 `Hello, ${trimmedName || "friend"}!` 实现非空姓名问候与全空白输入的 `Hello, friend!` 回退。固定检查 greet-name-contract-v1 为 3/3 通过。最新源完整性证据显示 checks/check.mjs、package.json、src/greeting.mjs 的原始文件与任务快照保持一致，allUnchanged=true。该候选仍须经过独立审阅，并由用户确认这一明确版本后方可进入 patch 下载交付。';

async function request(base, pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  const value = await response.json();
  return { status: response.status, value };
}

function attachBody(task, capability, fixtureId = 'node-single-file-v1') {
  return {
    fixtureId,
    expectedGoalVersionId: task.goal.activeVersionId,
    expectedProjectRootGoalVersionId: task.projectRootGoalVersionId,
    expectedProjectRootInputFingerprint: task.projectRootInputFingerprint,
    expectedMaterialApplicabilityFingerprint: task.materialContext?.fingerprint ?? null,
    expectedPreviousScopeFingerprint: task.projectWorkspace?.scopeFingerprint || null,
    expectedCapabilityFingerprint: capability.fingerprint,
  };
}

function passingContinuityCandidate(source) {
  if (source.includes('const requiresAttention =') && source.includes('task.execution?.stopReason')) {
    assert.equal((source.match(/\brequiresAttention\b/g) || []).length, 3);
    const renamed = source.replaceAll('requiresAttention', 'terminalBlocked');
    assert.notEqual(renamed, source);
    assert.equal((renamed.match(/\bterminalBlocked\b/g) || []).length, 3);
    return renamed;
  }
  const repaired = source
    .replace("  const readyForDownload = task.status === 'ready_to_export' && value.candidate?.confirmed;\n", "  const readyForDownload = task.status === 'ready_to_export' && value.candidate?.confirmed;\n  const terminalBlocked = ['failed', 'partial', 'cancelled', 'cancellation_unknown'].includes(task.status)\n    && ['budget_exhausted', 'permanent_error', 'same_error_exhausted', 'project_verification_failed', 'project_transaction_failed'].includes(task.execution?.stopReason);\n")
    .replace("  const badge = busyText ? '正在工作' : readyForDownload ? '可以下载' : value.progress.needsUserDecision ? '需要你的决定' : 'Irixi 可继续';\n  const tone = busyText ? 'active' : value.progress.needsUserDecision ? 'bad' : 'good';", "  const badge = busyText ? '正在工作' : readyForDownload ? '可以下载' : value.progress.needsUserDecision ? '需要你的决定' : terminalBlocked ? '需要先处理' : 'Irixi 可继续';\n  const tone = busyText ? 'active' : value.progress.needsUserDecision || terminalBlocked ? 'bad' : 'good';");
  assert.notEqual(repaired, source);
  assert.equal((repaired.match(/task\.execution\?\.stopReason/g) || []).length, 1);
  return repaired;
}

function wrongStopReasonCandidate(source) {
  const passing = source.includes('需要先处理') ? source : passingContinuityCandidate(source);
  assert.equal((passing.match(/task\.execution\?\.stopReason/g) || []).length, 1);
  assert.equal((passing.match(/task\.stopReason/g) || []).length, 0);
  const wrong = passing.replace('task.execution?.stopReason', 'task.stopReason');
  assert.notEqual(wrong, passing);
  assert.equal((wrong.match(/task\.execution\?\.stopReason/g) || []).length, 0);
  assert.equal((wrong.match(/task\.stopReason/g) || []).length, 1);
  return wrong;
}

function materialDecisionBody(task, materialId) {
  const entry = task.materialContext.directory.find((item) => item.id === materialId);
  return {
    category: 'goal_specific', disposition: 'use', impact: 'non_blocking', purpose: '当前代码目标的输入', reason: 'project scope test',
    expectedFingerprint: task.materialContext.fingerprint,
    expectedScope: task.materialContext.scope,
    expectedContentSha256: entry.contentSha256,
  };
}

function passingProjectReview() {
  return {
    summary: '受控审阅通过', provider: 'stub-independent-review', claimChecks: [],
    projectReviewFacts: { changedFileCount: 999, checks: [{ checkId: 'forged', caseTotal: 999, casePassed: 999 }] },
    checks: ['目标符合度', '完整性', '来源核对', '边界遵守', '文件可用性'].map((name) => ({ name, passed: true, evidence: '完整宿主代码与执行审计已核对。', blocking: true })),
  };
}

test('HTTP 通用范围显式提案确认授权后完成单次批量 CAS、全部检查、独立审阅与 patch 撤旧', { timeout: 45_000 }, async (t) => {
  const root = await fs.mkdtemp(tempPrefix);
  const repositoryRoot = await fs.mkdtemp(tempPrefix);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  t.after(() => fs.rm(repositoryRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(repositoryRoot, 'app', 'public'), { recursive: true });
  await fs.writeFile(path.join(repositoryRoot, 'package.json'), '{"type":"module"}\n');
  await fs.writeFile(path.join(repositoryRoot, 'app', 'label.mjs'), 'export function normalizeLabel(value) { return String(value).trim(); }\n');
  let scopeCalls = 0;
  let planCalls = 0;
  let ownerCalls = 0;
  let reviewPromptText = '';
  let scopePromptText = '';
  const plan = {
    summary: '有限源码事务。', projectAlignment: { status: 'standalone', explanation: '独立任务。' }, outputKind: 'project', deliverables: ['project_patch'],
    roles: [
      { key: 'developer', name: '执行员', mission: '形成候选', capabilities: ['bounded source'], recruitmentReason: '修改有限源码' },
      { key: 'author', name: '汇总员', mission: '汇总宿主证据', capabilities: ['summary'], recruitmentReason: '形成候选说明' },
      { key: 'auditor', name: '审阅员', mission: '独立审阅', capabilities: ['review'], recruitmentReason: '独立核对' },
      { key: 'courier', name: '交付员', mission: '等待确认', capabilities: ['delivery'], recruitmentReason: '只交付确认版本' },
    ],
    steps: [
      { key: 'code', title: '受控修改', kind: 'tool', role: 'developer', dependsOn: [], tools: ['workspace.read', 'workspace.write', 'workspace.check', 'workspace.diff'], acceptanceCriteria: ['候选通过全部固定检查'], expectedResult: '宿主事务证据', webScope: { queries: [], urls: [] } },
      { key: 'synthesis', title: '形成候选', kind: 'synthesis', role: 'author', dependsOn: ['code'], tools: [], acceptanceCriteria: ['候选绑定宿主证据'], expectedResult: 'patch 候选', webScope: { queries: [], urls: [] } },
      { key: 'review', title: '独立审阅', kind: 'review', role: 'auditor', dependsOn: ['synthesis'], tools: [], acceptanceCriteria: ['独立审阅当前版本'], expectedResult: '审阅记录', webScope: { queries: [], urls: [] } },
      { key: 'delivery', title: '等待确认', kind: 'delivery', role: 'courier', dependsOn: ['review'], tools: [], acceptanceCriteria: ['只交付指定版本'], expectedResult: '确认后 patch', webScope: { queries: [], urls: [] } },
    ],
  };
  const providers = {
    async status() { return { demo: { id: 'demo', available: true }, codex: { id: 'codex-cli', available: true } }; },
    async proposeProjectScope(task, repository) {
      scopeCalls += 1;
      assert.equal(repository.repositoryId, 'irixi-office-agent');
      assert.equal(repository.files.some((entry) => entry.path === 'app/label.mjs' && entry.selectable === true && entry.excerpt.includes('normalizeLabel')), true);
      assert.equal(JSON.stringify(repository).includes(repositoryRoot), false);
      scopePromptText = providerTest.projectScopePrompt(task, repository);
      return {
        repositoryId: 'irixi-office-agent', deliverable: 'project_patch',
        goal: { statement: '让标签纯函数去除空白并返回大写文本。', successCriteria: ['确认的输入返回确认的大写文本。'], boundaries: ['只改登记纯函数，不访问外部系统。'] },
        readablePaths: ['app/label.mjs'], editablePaths: ['app/label.mjs'],
        checks: [{ id: 'node-syntax-v1', modulePath: null, namedExport: null, cases: null }, { id: 'json-function-v1', modulePath: 'app/label.mjs', namedExport: 'normalizeLabel', cases: [{ id: 'trim-upper', argsJson: '[" hi "]', expectedJson: '"HI"' }] }],
        rationale: '单一纯函数和单一行为用例足以覆盖该需求。',
      };
    },
    async plan(task) {
      planCalls += 1;
      const stage = (name) => ({
        title: `${name}阶段`, agentName: `${name}专员`, agentMission: `${name}当前候选`,
        agentCapabilities: [`${name}能力`], recruitmentReason: `需要${name}`,
        acceptanceCriteria: [`${name}有明确宿主证据`], expectedResult: `${name}结果`,
      });
      return compileProjectPlan(task, {
        summary: '有限源码事务。',
        projectAlignment: { status: 'standalone', explanation: '独立任务。' },
        stages: { tool: stage('修改'), synthesis: stage('汇总'), review: stage('审阅'), delivery: stage('交付') },
      });
    },
    async executeWork(task, item, input) {
      if (item.kind === 'tool') {
        ownerCalls += 1;
        const read = input.projectTransaction.readResults[0];
        return { summary: '', output: '', sources: [], claims: [], gap: '', caveats: [], acceptanceChecks: [], deliverables: [], toolRequests: [{
          id: 'write-once', tool: 'workspace.write', reason: '提交一次当前 CAS 候选',
          args: { expectedCandidateSha256: read.candidateSha256, changes: [{ path: read.path, expectedFileSha256: read.fileSha256, content: 'export function normalizeLabel(value) { return String(value).trim().toUpperCase(); }\n' }] },
        }] };
      }
      if (item.kind === 'synthesis') {
        assert.equal(input.projectExecutionAudit.execution.mode, 'host_bounded_transaction_v1');
        return {
          summary: '当前有限源码候选已由宿主固定检查。', output: '候选只包含获准纯函数变更，并绑定当前宿主检查与差异证据。', sources: [], claims: [], gap: '', caveats: [], toolRequests: [],
          deliverables: [{ kind: 'project_patch', title: '有限源码候选 patch', content: '候选只包含获准纯函数变更，并绑定当前宿主检查与差异证据。' }],
          acceptanceChecks: item.acceptanceCriteria.map((criterion) => ({ criterion, passed: true, evidence: '当前宿主事务和检查证据已提供。' })),
        };
      }
      assert.equal(item.kind, 'review');
      return { summary: '候选已交独立审阅。', output: '仅转交当前候选和宿主证据。', sources: [], claims: [], gap: '', caveats: [], toolRequests: [], deliverables: [], acceptanceChecks: item.acceptanceCriteria.map((criterion) => ({ criterion, passed: true, evidence: '当前候选已绑定。' })) };
    },
    async review(task, artifact, { projectReviewEvidence }) {
      reviewPromptText = providerTest.reviewPrompt(task, artifact, { projectReviewEvidence });
      return passingProjectReview();
    },
  };
  const host = createProjectWorkspaceHost({ projectRoot: repositoryRoot, capabilityOverride: override });
  let running = await start({ port: 0, root, providers, projectWorkspaceHost: host });
  t.after(() => running.server.close());
  const created = await request(running.url, '/api/tasks', { method: 'POST', body: JSON.stringify({ title: '有限源码任务', goal: '整理这项自然语言源码需求', type: 'project', successCriteria: ['先确认需求卡'], boundaries: ['不写原项目'] }) });
  const taskId = created.value.task.id;
  const beforeScope = await request(running.url, `/api/tasks/${taskId}/project-scope`);
  const staleBinding = structuredClone(beforeScope.value.taskInputBinding);
  staleBinding.goalVersionId = 'goal-from-old-page';
  const staleProposal = await request(running.url, `/api/tasks/${taskId}/project-scope/propose`, { method: 'POST', body: JSON.stringify({ expectedTaskInputBinding: staleBinding, expectedRepositoryTreeSha256: beforeScope.value.repository.treeSha256 }) });
  assert.equal(staleProposal.status, 409);
  assert.equal(scopeCalls, 0);
  const proposed = await request(running.url, `/api/tasks/${taskId}/project-scope/propose`, { method: 'POST', body: JSON.stringify({ expectedTaskInputBinding: beforeScope.value.taskInputBinding, expectedRepositoryTreeSha256: beforeScope.value.repository.treeSha256 }) });
  assert.equal(proposed.status, 201, JSON.stringify(proposed.value));
  assert.equal(scopeCalls, 1);
  assert.match(scopePromptText, /app\/label\.mjs/);
  assert.match(scopePromptText, /argsJson、expectedJson/);
  assert.equal(scopePromptText.includes(repositoryRoot), false);
  const staleAcceptance = await request(running.url, `/api/tasks/${taskId}/project-scope/accept`, { method: 'POST', body: JSON.stringify({ proposalId: proposed.value.projectScope.id, expectedFingerprint: '0'.repeat(64) }) });
  assert.equal(staleAcceptance.status, 409);
  const accepted = await request(running.url, `/api/tasks/${taskId}/project-scope/accept`, { method: 'POST', body: JSON.stringify({ proposalId: proposed.value.projectScope.id, expectedFingerprint: proposed.value.projectScope.fingerprint }) });
  assert.equal(accepted.status, 200);
  const capability = (await request(running.url, '/api/project-capabilities')).value.project;
  const acceptedScope = (await request(running.url, `/api/tasks/${taskId}/project-scope`)).value;
  const attached = await request(running.url, `/api/tasks/${taskId}/project-workspace/attach`, { method: 'POST', body: JSON.stringify({
    proposalId: acceptedScope.projectScope.id, expectedProposalFingerprint: acceptedScope.projectScope.fingerprint,
    expectedGoalVersionId: acceptedScope.taskInputBinding.goalVersionId,
    expectedProjectRootGoalVersionId: acceptedScope.taskInputBinding.projectRootGoalVersionId,
    expectedProjectRootInputFingerprint: acceptedScope.taskInputBinding.projectRootInputFingerprint,
    expectedMaterialApplicabilityFingerprint: acceptedScope.taskInputBinding.materialApplicabilityFingerprint,
    expectedPreviousScopeFingerprint: null, expectedCapabilityFingerprint: capability.fingerprint,
  }) });
  assert.equal(attached.status, 201);
  assert.equal(attached.value.task.projectWorkspace.executionMode, 'host_bounded_transaction_v1');
  await new Promise((resolve) => running.server.close(resolve));
  running = await start({ port: 0, root, providers, projectWorkspaceHost: host });
  const restarted = await request(running.url, `/api/tasks/${taskId}`);
  assert.equal(restarted.value.task.projectWorkspace.status, 'ready');
  assert.equal(restarted.value.task.projectWorkspace.proposalId, acceptedScope.projectScope.id);
  const plannedResponse = await request(running.url, `/api/tasks/${taskId}/plan`, { method: 'POST', body: '{}' });
  assert.equal(plannedResponse.status, 200, JSON.stringify(plannedResponse.value));
  assert.equal(planCalls, 1);
  assert.equal((await request(running.url, `/api/tasks/${taskId}/run`, { method: 'POST', body: '{}' })).status, 202);
  let current;
  for (let index = 0; index < 200; index += 1) {
    current = (await request(running.url, `/api/tasks/${taskId}`)).value.task;
    if (['waiting_user', 'failed', 'partial'].includes(current.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(current.status, 'waiting_user', JSON.stringify({
    stopReason: current.execution?.stopReason,
    lastError: current.execution?.lastError,
    workItems: current.workItems?.map(({ id, kind, status, error }) => ({ id, kind, status, error })),
    events: current.events?.slice(-5),
  }));
  assert.equal(ownerCalls, 1);
  const artifact = current.artifacts.at(-1);
  assert.equal(artifact.reviewStatus, 'passed');
  assert.match(reviewPromptText, /host_bounded_transaction_v1|有限源码事务/);
  assert.match(reviewPromptText, /projectReviewEvidence/);
  assert.match(reviewPromptText, /explicitlyAccepted/);
  assert.match(reviewPromptText, /scopeAcceptedEvent/);
  assert.match(reviewPromptText, /workspaceGrant/);
  assert.match(reviewPromptText, /hostFacts/);
  assert.match(reviewPromptText, /workReview/);
  assert.match(reviewPromptText, /resultDigest/);
  assert.doesNotMatch(reviewPromptText, /同一第三批/);
  const storedReview = current.reviews.filter((entry) => entry.artifactId === artifact.id).at(-1);
  assert.match(storedReview.projectReviewEvidenceSha256, /^[a-f0-9]{64}$/);
  assert.match(storedReview.projectArtifactSemanticSha256, /^[a-f0-9]{64}$/);
  assert.match(storedReview.projectWorkReviewEvidenceSha256, /^[a-f0-9]{64}$/);
  const reviewItem = current.workItems.find((entry) => entry.kind === 'review');
  const reviewSession = current.agentSessions.findLast((entry) => entry.workItemId === reviewItem.id && entry.runId === current.execution.id);
  assert.equal(reviewSession.reviewEvidence.resultDigest, storedReview.projectWorkReviewEvidenceSha256);
  assert.match(reviewSession.reviewEvidence.projectReviewEvidenceSha256, /^[a-f0-9]{64}$/);
  const approval = await request(running.url, `/api/tasks/${taskId}/artifacts/${artifact.id}/confirm`, { method: 'POST', body: '{}' });
  assert.equal(approval.status, 200);
  assert.equal(approval.value.approval.projectReviewEvidenceSha256, storedReview.projectReviewEvidenceSha256);
  assert.equal(approval.value.approval.projectArtifactSemanticSha256, storedReview.projectArtifactSemanticSha256);
  assert.equal(approval.value.approval.projectWorkReviewEvidenceSha256, storedReview.projectWorkReviewEvidenceSha256);
  const downloaded = await fetch(`${running.url}/api/tasks/${taskId}/artifacts/${artifact.id}/export?approval=${approval.value.approval.id}&format=patch`);
  assert.equal(downloaded.status, 200);
  assert.match(await downloaded.text(), /app\/label\.mjs/);
  const replacement = await request(running.url, `/api/tasks/${taskId}/suggestions`, { method: 'POST', body: JSON.stringify({ text: '改成另一项需求', classification: 'replace' }) });
  await request(running.url, `/api/tasks/${taskId}/suggestions/${replacement.value.suggestion.id}/accept-goal`, { method: 'POST', body: JSON.stringify({ statement: '另一项完整需求', successCriteria: ['重新确认范围'], boundaries: ['旧 patch 不可导出'] }) });
  assert.equal((await fetch(`${running.url}/api/tasks/${taskId}/artifacts/${artifact.id}/export?approval=${approval.value.approval.id}&format=patch`)).status, 400);
});

test('HTTP 项目在授权前零模型，迟到授权 409，当前授权跨重启保持且不公开私密路径', { timeout: 20_000 }, async (t) => {
  const root = await fs.mkdtemp(tempPrefix);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let planCalls = 0;
  const providers = {
    async plan() { planCalls += 1; throw new Error('plan should not run before attach'); },
    async status() { return { demo: { id: 'demo', label: 'demo', available: true }, codex: { id: 'codex-cli', label: 'codex', available: true } }; },
  };
  const host = createProjectWorkspaceHost({ capabilityOverride: override });
  let running = await start({ port: 0, root, providers, projectWorkspaceHost: host });
  t.after(() => running.server.close());

  const created = await request(running.url, '/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ title: '私密试用项目', goal: '实现固定 greetName 行为', type: 'project', provider: 'demo', successCriteria: ['固定检查通过'], boundaries: ['不写原项目'] }),
  });
  assert.equal(created.status, 201);
  assert.equal(created.value.task.provider, 'codex-cli');
  const taskId = created.value.task.id;
  const demoDenied = await request(running.url, `/api/tasks/${taskId}/provider`, { method: 'POST', body: JSON.stringify({ provider: 'demo' }) });
  assert.equal(demoDenied.status, 400);
  assert.match(demoDenied.value.error.message, /代码项目固定使用 Codex/);
  const plan = await request(running.url, `/api/tasks/${taskId}/plan`, { method: 'POST', body: '{}' });
  assert.equal(plan.status, 200);
  assert.equal(planCalls, 0);
  assert.equal(plan.value.task.status, 'waiting_user');
  const continuedWithoutGrant = await request(running.url, `/api/tasks/${taskId}/continue`, { method: 'POST', body: '{}' });
  assert.equal(continuedWithoutGrant.status, 200);
  assert.equal(continuedWithoutGrant.value.action, 'await_user');
  assert.equal(planCalls, 0);

  const capabilityResponse = await request(running.url, '/api/project-capabilities');
  assert.equal(capabilityResponse.status, 200);
  assert.equal(typeof capabilityResponse.value.project.sandboxExecSha256, 'string');
  assert.equal(typeof capabilityResponse.value.project.hostVerifierSha256, 'string');
  assert.equal(capabilityResponse.value.project.fixtures[0].publicContract.namedExport, 'greetName');
  const before = (await request(running.url, `/api/tasks/${taskId}`)).value.task;
  const staleBody = attachBody(before, capabilityResponse.value.project);
  const suggestion = await request(running.url, `/api/tasks/${taskId}/suggestions`, {
    method: 'POST', body: JSON.stringify({ text: '改为实现严格问候规则', classification: 'replace' }),
  });
  const replaced = await request(running.url, `/api/tasks/${taskId}/suggestions/${suggestion.value.suggestion.id}/accept-goal`, {
    method: 'POST', body: JSON.stringify({ statement: '实现严格问候规则', successCriteria: ['固定三例通过'], boundaries: ['不写原项目'] }),
  });
  assert.equal(replaced.status, 200);
  const late = await request(running.url, `/api/tasks/${taskId}/project-workspace/attach`, { method: 'POST', body: JSON.stringify(staleBody) });
  assert.equal(late.status, 409);
  assert.equal(late.value.error.code, 'stale_project_workspace');

  const current = (await request(running.url, `/api/tasks/${taskId}`)).value.task;
  const attached = await request(running.url, `/api/tasks/${taskId}/project-workspace/attach`, {
    method: 'POST', body: JSON.stringify(attachBody(current, capabilityResponse.value.project)),
  });
  assert.equal(attached.status, 201);
  assert.equal(attached.value.task.projectWorkspace.status, 'ready');
  assert.equal(JSON.stringify(attached.value).includes(root), false);
  assert.equal(JSON.stringify(attached.value).includes('grantRelativeRoot'), false);

  await new Promise((resolve) => running.server.close(resolve));
  running = await start({ port: 0, root, providers, projectWorkspaceHost: createProjectWorkspaceHost({ capabilityOverride: override }) });
  const afterRestart = await request(running.url, `/api/tasks/${taskId}`);
  assert.equal(afterRestart.status, 200);
  assert.equal(afterRestart.value.task.projectWorkspace.status, 'ready');
  assert.equal(afterRestart.value.task.projectWorkspace.scopeFingerprint, attached.value.task.projectWorkspace.scopeFingerprint);
  assert.equal(JSON.stringify(afterRestart.value).includes(root), false);

  const postAttachSuggestion = await request(running.url, `/api/tasks/${taskId}/suggestions`, {
    method: 'POST', body: JSON.stringify({ text: '改为实现新版严格问候规则', classification: 'replace' }),
  });
  const postAttachReplacement = await request(running.url, `/api/tasks/${taskId}/suggestions/${postAttachSuggestion.value.suggestion.id}/accept-goal`, {
    method: 'POST', body: JSON.stringify({ statement: '实现新版严格问候规则', successCriteria: ['新版固定三例通过'], boundaries: ['不写原项目'] }),
  });
  assert.equal(postAttachReplacement.status, 200);
  assert.equal(postAttachReplacement.value.task.projectWorkspace.status, 'reauthorization_required');
  assert.equal(postAttachReplacement.value.task.projectWorkspace.candidate.status, 'historical');
  const stalePlan = await request(running.url, `/api/tasks/${taskId}/plan`, { method: 'POST', body: '{}' });
  assert.equal(stalePlan.status, 200);
  assert.equal(stalePlan.value.task.status, 'waiting_user');
  const staleContinue = await request(running.url, `/api/tasks/${taskId}/continue`, { method: 'POST', body: '{}' });
  assert.equal(staleContinue.status, 200);
  assert.equal(staleContinue.value.action, 'await_user');
  assert.equal(planCalls, 0);

  await new Promise((resolve) => running.server.close(resolve));
  running = await start({ port: 0, root, providers, projectWorkspaceHost: createProjectWorkspaceHost({ capabilityOverride: override }) });
  let currentTask = (await request(running.url, `/api/tasks/${taskId}`)).value.task;
  assert.equal(currentTask.projectWorkspace.status, 'reauthorization_required');
  let reattached = await request(running.url, `/api/tasks/${taskId}/project-workspace/attach`, {
    method: 'POST', body: JSON.stringify(attachBody(currentTask, capabilityResponse.value.project)),
  });
  assert.equal(reattached.status, 201);
  assert.equal(reattached.value.task.projectWorkspace.status, 'ready');

  const added = await request(running.url, `/api/tasks/${taskId}/materials/text`, {
    method: 'POST', body: JSON.stringify({ name: '问候约束', text: '名称必须去掉首尾空白。' }),
  });
  assert.equal(added.value.task.projectWorkspace.status, 'reauthorization_required');
  currentTask = added.value.task;
  reattached = await request(running.url, `/api/tasks/${taskId}/project-workspace/attach`, {
    method: 'POST', body: JSON.stringify(attachBody(currentTask, capabilityResponse.value.project)),
  });
  assert.equal(reattached.value.task.projectWorkspace.status, 'ready');

  const decided = await request(running.url, `/api/tasks/${taskId}/materials/${added.value.material.id}/applicability`, {
    method: 'POST', body: JSON.stringify(materialDecisionBody(reattached.value.task, added.value.material.id)),
  });
  assert.equal(decided.value.task.projectWorkspace.status, 'reauthorization_required');
  currentTask = decided.value.task;
  reattached = await request(running.url, `/api/tasks/${taskId}/project-workspace/attach`, {
    method: 'POST', body: JSON.stringify(attachBody(currentTask, capabilityResponse.value.project)),
  });
  assert.equal(reattached.value.task.projectWorkspace.status, 'ready');

  const support = await request(running.url, `/api/tasks/${taskId}/suggestions`, {
    method: 'POST', body: JSON.stringify({ text: '保留清晰错误说明', classification: 'support' }),
  });
  assert.equal(support.value.task.projectWorkspace.status, 'reauthorization_required');
  currentTask = support.value.task;
  reattached = await request(running.url, `/api/tasks/${taskId}/project-workspace/attach`, {
    method: 'POST', body: JSON.stringify(attachBody(currentTask, capabilityResponse.value.project)),
  });
  assert.equal(reattached.value.task.projectWorkspace.status, 'ready');

  const rootTask = await request(running.url, '/api/tasks', {
    method: 'POST', body: JSON.stringify({ title: '代码项目根', goal: '统一试用目标', successCriteria: ['目标一致'], boundaries: ['不发布'] }),
  });
  const linked = await request(running.url, `/api/tasks/${taskId}/project-link`, {
    method: 'POST', body: JSON.stringify({ rootTaskId: rootTask.value.task.id }),
  });
  assert.equal(linked.value.task.projectWorkspace.status, 'reauthorization_required');
  reattached = await request(running.url, `/api/tasks/${taskId}/project-workspace/attach`, {
    method: 'POST', body: JSON.stringify(attachBody(linked.value.task, capabilityResponse.value.project)),
  });
  assert.equal(reattached.value.task.projectWorkspace.status, 'ready');
  assert.equal(planCalls, 0);
});

test('HTTP continuity 旧序列化 grant 缺执行模式与合约指纹时重启后零模型等待重授权', { timeout: 20_000 }, async (t) => {
  const root = await fs.mkdtemp(tempPrefix);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let planCalls = 0;
  const plan = {
    summary: '固定项目计划。', projectAlignment: { status: 'standalone', explanation: '独立任务。' }, outputKind: 'project', deliverables: ['project_patch'],
    roles: [
      { key: 'developer', name: '执行员', mission: '修改候选', capabilities: ['workspace'], recruitmentReason: '形成代码差异' },
      { key: 'author', name: '汇总员', mission: '汇总证据', capabilities: ['summary'], recruitmentReason: '形成候选' },
      { key: 'auditor', name: '审阅员', mission: '独立审阅', capabilities: ['review'], recruitmentReason: '审阅边界' },
      { key: 'courier', name: '交付员', mission: '等待确认', capabilities: ['delivery'], recruitmentReason: '交付边界' },
    ],
    steps: [
      { key: 'code', title: '受控修改', kind: 'tool', role: 'developer', dependsOn: [], tools: ['workspace.read', 'workspace.write', 'workspace.check', 'workspace.diff'], acceptanceCriteria: ['通过固定检查'], expectedResult: '宿主证据' },
      { key: 'synthesize', title: '汇总', kind: 'synthesis', role: 'author', dependsOn: ['code'], tools: [], acceptanceCriteria: ['绑定证据'], expectedResult: '候选' },
      { key: 'review', title: '审阅', kind: 'review', role: 'auditor', dependsOn: ['synthesize'], tools: [], acceptanceCriteria: ['独立核对'], expectedResult: '审阅记录' },
      { key: 'deliver', title: '交付', kind: 'delivery', role: 'courier', dependsOn: ['review'], tools: [], acceptanceCriteria: ['指定版本'], expectedResult: '待确认 patch' },
    ],
  };
  const providers = {
    async status() { return { demo: { id: 'demo', available: true }, codex: { id: 'codex-cli', available: true } }; },
    async plan() { planCalls += 1; return structuredClone(plan); },
  };
  let running = await start({ port: 0, root, providers, projectWorkspaceHost: createProjectWorkspaceHost({ capabilityOverride: override }) });
  t.after(() => running.server.close());
  const created = await request(running.url, '/api/tasks', { method: 'POST', body: JSON.stringify({ title: '旧 grant', goal: '修复续接显示', type: 'project', successCriteria: ['固定检查通过'], boundaries: ['只改 renderContinuity'] }) });
  const capability = (await request(running.url, '/api/project-capabilities')).value.project;
  const attached = await request(running.url, `/api/tasks/${created.value.task.id}/project-workspace/attach`, { method: 'POST', body: JSON.stringify(attachBody(created.value.task, capability, 'irixi-continuity-ui-v1')) });
  assert.equal(attached.status, 201);
  await running.store.mutate(created.value.task.id, (task) => {
    delete task.projectWorkspace.executionMode;
    delete task.projectWorkspace.publicContractFingerprint;
  });
  await new Promise((resolve) => running.server.close(resolve));
  running = await start({ port: 0, root, providers, projectWorkspaceHost: createProjectWorkspaceHost({ capabilityOverride: override }) });
  const legacy = (await request(running.url, `/api/tasks/${created.value.task.id}`)).value.task;
  assert.equal(legacy.projectWorkspace.status, 'reauthorization_required');
  assert.match(legacy.projectWorkspace.reason, /公开输入接口|执行模式/);
  const blockedPlan = await request(running.url, `/api/tasks/${created.value.task.id}/plan`, { method: 'POST', body: '{}' });
  assert.equal(blockedPlan.status, 200);
  assert.equal(blockedPlan.value.task.status, 'waiting_user');
  assert.equal(planCalls, 0);
  const reattached = await request(running.url, `/api/tasks/${created.value.task.id}/project-workspace/attach`, { method: 'POST', body: JSON.stringify(attachBody(legacy, capability, 'irixi-continuity-ui-v1')) });
  assert.equal(reattached.status, 201);
  assert.equal(reattached.value.task.projectWorkspace.status, 'ready');
  assert.equal((await request(running.url, `/api/tasks/${created.value.task.id}/plan`, { method: 'POST', body: '{}' })).status, 200);
  assert.equal(planCalls, 1);
});

test('HTTP 当前计划以三批四个真实 workspace 工具形成 artifact，并把完整规范审计交给 final review', { timeout: 45_000 }, async (t) => {
  const root = await fs.mkdtemp(tempPrefix);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let reviewObserved = null;
  const reviewSeen = new Promise((resolve) => { reviewObserved = resolve; });
  const projectPlan = {
    summary: '读取隔离候选后修改、固定检查并查看 diff。',
    projectAlignment: { status: 'standalone', explanation: '独立固定练习项目。' },
    outputKind: 'project', deliverables: ['project_patch'],
    roles: [
      { key: 'developer', name: '代码执行员', mission: '修改隔离候选', capabilities: ['固定工作区'], recruitmentReason: '需要真实代码差异。' },
      { key: 'author', name: '候选汇总员', mission: '汇总宿主证据', capabilities: ['说明'], recruitmentReason: '形成候选说明。' },
      { key: 'auditor', name: '独立审阅员', mission: '核对宿主证据', capabilities: ['审阅'], recruitmentReason: '确认前独立审阅。' },
      { key: 'courier', name: '交付员', mission: '等待确认', capabilities: ['交付'], recruitmentReason: '只交付指定版本。' },
    ],
    steps: [
      { key: 'code', title: '修改并检查候选', kind: 'tool', role: 'developer', dependsOn: [], tools: ['workspace.read', 'workspace.write', 'workspace.check', 'workspace.diff'], acceptanceCriteria: ['完成实际候选读取、修改、检查和 diff'], expectedResult: '宿主代码证据' },
      { key: 'synthesize', title: '形成代码候选', kind: 'synthesis', role: 'author', dependsOn: ['code'], tools: [], acceptanceCriteria: ['绑定宿主证据'], expectedResult: 'project patch 候选' },
      { key: 'review', title: '独立核对', kind: 'review', role: 'auditor', dependsOn: ['synthesize'], tools: [], acceptanceCriteria: ['核对固定证据'], expectedResult: '审阅记录' },
      { key: 'deliver', title: '等待确认', kind: 'delivery', role: 'courier', dependsOn: ['review'], tools: [], acceptanceCriteria: ['只下载确认 patch'], expectedResult: '待确认 patch' },
    ],
  };
  const providers = {
    async status() { return { demo: { id: 'demo', available: true }, codex: { id: 'codex-cli', available: true } }; },
    async plan() { return structuredClone(projectPlan); },
    async executeWork(task, item, input, { signal }) {
      const results = input.toolResults || [];
      if (item.stepKey === 'code' && results.length === 0) {
        return { summary: '', output: '', sources: [], claims: [], gap: '', caveats: [], deliverables: [], acceptanceChecks: [], toolRequests: [{
          id: 'read-current-candidate', tool: 'workspace.read', reason: '先读取当前候选',
          args: { path: 'src/greeting.mjs', view: 'candidate', expectedCandidateSha256: task.projectWorkspace.candidate.candidateSha256 },
        }] };
      }
      if (item.stepKey === 'code' && results.length === 1) {
        const read = results[0].result;
        return { summary: '', output: '', sources: [], claims: [], gap: '', caveats: [], deliverables: [], acceptanceChecks: [], toolRequests: [{
          id: 'write-current-candidate', tool: 'workspace.write', reason: '按当前hash整文件替换',
          args: { path: 'src/greeting.mjs', expectedFileSha256: read.fileSha256, expectedCandidateSha256: read.candidateSha256, content: "export function greetName(name) {\n  const value = String(name).trim();\n  return value ? `Hello, ${value}!` : 'Hello, friend!';\n}\n" },
        }] };
      }
      if (item.stepKey === 'code' && results.length === 2) {
        const write = results[1].result;
        return { summary: '', output: '', sources: [], claims: [], gap: '', caveats: [], deliverables: [], acceptanceChecks: [], toolRequests: [
          { id: 'check-current-candidate', tool: 'workspace.check', reason: '固定合约检查', args: { checkId: 'greet-name-contract-v1', expectedCandidateSha256: write.candidateSha256 } },
          { id: 'diff-current-candidate', tool: 'workspace.diff', reason: '查看真实diff', args: { expectedCandidateSha256: write.candidateSha256 } },
        ] };
      }
      if (item.stepKey === 'code') return { summary: '宿主执行完成', output: '已完成三批四项受控工具。', sources: [], claims: [], gap: '', caveats: [], deliverables: [], toolRequests: [], acceptanceChecks: item.acceptanceCriteria.map((criterion) => ({ criterion, passed: true, evidence: '真实 host ledger 已记录 read/write/check/diff' })) };
      if (item.kind === 'synthesis') {
        assert.equal(input.projectSourceIntegrity.allUnchanged, true);
        assert.equal(input.projectExecutionAudit.execution.calls.length, 4);
        return { summary: '已形成绑定当前候选版本的 project patch 综合证据包。', output: RUN6_ARTIFACT_CONTENT, sources: [], claims: [], gap: '', caveats: [], toolRequests: [], acceptanceChecks: item.acceptanceCriteria.map((criterion) => ({ criterion, passed: true, evidence: '宿主 current source 与 execution audit 完整' })), deliverables: [{ kind: 'project_patch', title: 'greetName 修复候选综合证据包', content: RUN6_DELIVERABLE_CONTENT }] };
      }
      if (item.kind === 'review') return { summary: '预检查完成', output: '按宿主证据预检查完成。', sources: [], claims: [], gap: '', caveats: [], deliverables: [], toolRequests: [], acceptanceChecks: item.acceptanceCriteria.map((criterion) => ({ criterion, passed: true, evidence: '未调用工具，仅核对候选' })) };
      if (signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'cancelled' })), { once: true }));
    },
    async review(task, artifact, { signal, projectReviewEvidence }) {
      reviewObserved({ task: structuredClone(task), artifact: structuredClone(artifact), prompt: providerTest.reviewPrompt(task, artifact, { projectReviewEvidence }) });
      if (signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
      return passingProjectReview();
    },
  };
  let running = await start({ port: 0, root, providers, projectWorkspaceHost: createProjectWorkspaceHost({ capabilityOverride: override }) });
  t.after(() => running.server.close());
  const created = await request(running.url, '/api/tasks', {
    method: 'POST', body: JSON.stringify({ title: '受控读取项目', goal: '读取并修正 greetName', type: 'project', successCriteria: ['固定合约通过'], boundaries: ['不写原项目'] }),
  });
  const capability = (await request(running.url, '/api/project-capabilities')).value.project;
  const attached = await request(running.url, `/api/tasks/${created.value.task.id}/project-workspace/attach`, {
    method: 'POST', body: JSON.stringify(attachBody(created.value.task, capability)),
  });
  assert.equal(attached.status, 201);
  const planned = await request(running.url, `/api/tasks/${created.value.task.id}/plan`, { method: 'POST', body: '{}' });
  assert.equal(planned.status, 200);
  const continued = await request(running.url, `/api/tasks/${created.value.task.id}/continue`, { method: 'POST', body: '{}' });
  assert.equal(continued.status, 202);
  assert.equal(continued.value.action, 'running');
  const runId = continued.value.task.execution.id;
  const observed = await Promise.race([reviewSeen, new Promise((_resolve, reject) => setTimeout(() => reject(new Error('final review 未在时限内收到完整审计')), 20_000))]);
  const audit = observed.artifact.projectCandidate.projectExecutionAudit;
  assert.equal(audit.auditSha256, observed.artifact.projectCandidate.projectExecutionAuditSha256);
  assert.deepEqual(audit.execution.calls.map((call) => [call.round, call.requestOrdinal, call.request.tool]), [[1, 1, 'workspace.read'], [2, 1, 'workspace.write'], [3, 1, 'workspace.check'], [3, 2, 'workspace.diff']]);
  assert.equal(audit.execution.synthesis.actualToolCallCount, 0);
  assert.equal(audit.plan.steps.filter((step) => step.allowedTools.some((tool) => tool.startsWith('workspace.'))).length, 1);
  assert.equal(audit.plan.steps.filter((step) => ['synthesis', 'review', 'delivery'].includes(step.kind)).every((step) => step.allowedTools.length === 0), true);
  assert.match(observed.prompt, /当前候选绑定的宿主项目执行审计/);
  assert.match(observed.prompt, /workspace\.read/);
  assert.match(observed.prompt, /workspace\.diff/);
  assert.match(observed.prompt, /--- a\/src\/greeting\.mjs/);
  assert.equal(observed.prompt.includes(root), false);
  assert.equal(observed.prompt.includes('parentexpected'), false);
  assert.equal(observed.prompt.includes('RAW_CHILD_STDOUT_SENTINEL'), false);
  let during;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    during = await running.store.get(created.value.task.id);
    if (during.artifacts[0]?.reviewStatus === 'passed' && during.status === 'waiting_user') break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(during.artifacts[0].reviewStatus, 'passed');
  assert.equal(during.status, 'waiting_user');
  assert.equal(during.artifacts[0].content, RUN6_ARTIFACT_CONTENT);
  assert.equal(during.artifacts[0].deliverables[0].content, RUN6_DELIVERABLE_CONTENT);
  const currentArtifact = during.artifacts[0];
  const trustedFacts = createTrustedProjectReviewFacts(during, currentArtifact);
  const numericGuard = (task, artifact, facts) => groundingChecks(task, artifact, { projectReviewFacts: facts }).find((entry) => entry.name === '关键数值守卫');
  assert.equal(numericGuard(during, currentArtifact, trustedFacts).passed, true);

  const swapped = structuredClone(currentArtifact);
  swapped.content = swapped.content.replace('3 个用例', '1 个用例').replace('1 个变更条目', '3 个变更条目');
  assert.equal(numericGuard(during, swapped, trustedFacts).passed, false);
  assert.match(numericGuard(during, swapped, trustedFacts).evidence, /1个|3个/);
  const invented = structuredClone(currentArtifact);
  invented.content = invented.content.replace('3 个用例', '9 个用例');
  assert.equal(numericGuard(during, invented, trustedFacts).passed, false);
  const mixedBusinessCount = structuredClone(currentArtifact);
  mixedBusinessCount.content = mixedBusinessCount.content.replace('用例为 english-name、han-name、empty-name。', '用例为 english-name、han-name、empty-name；同批客户为 3 个客户。');
  assert.equal(numericGuard(during, mixedBusinessCount, trustedFacts).passed, false);
  assert.match(numericGuard(during, mixedBusinessCount, trustedFacts).evidence, /3个/);
  for (const misleadingPhrase of ['3 个通过审批的客户', '3 个用例合同', '1 个变更客户']) {
    const misleading = structuredClone(currentArtifact);
    misleading.content = misleading.content.replace('用例为 english-name、han-name、empty-name。', `用例为 english-name、han-name、empty-name；${misleadingPhrase}。`);
    assert.equal(numericGuard(during, misleading, trustedFacts).passed, false, misleadingPhrase);
  }
  const misleadingDiff = structuredClone(currentArtifact);
  misleadingDiff.content = misleadingDiff.content.replace('唯一路径为 src/greeting.mjs。', '唯一路径为 src/greeting.mjs；workspace.diff 另记录 1 个变更客户。');
  assert.equal(numericGuard(during, misleadingDiff, trustedFacts).passed, false);
  const oldGoalTask = structuredClone(during);
  oldGoalTask.goal.versions.push({ ...structuredClone(oldGoalTask.goal.versions.at(-1)), id: 'goal-new-host-counts', statement: '新目标' });
  oldGoalTask.goal.activeVersionId = 'goal-new-host-counts';
  assert.equal(numericGuard(oldGoalTask, currentArtifact, trustedFacts).passed, false);
  const changedCandidate = structuredClone(currentArtifact);
  changedCandidate.projectCandidate.candidateSha256 = '0'.repeat(64);
  assert.equal(numericGuard(during, changedCandidate, trustedFacts).passed, false);
  const changedIntegrity = structuredClone(currentArtifact);
  changedIntegrity.projectCandidate.sourceIntegritySha256 = '1'.repeat(64);
  assert.equal(numericGuard(during, changedIntegrity, trustedFacts).passed, false);
  const failedCheck = structuredClone(currentArtifact);
  failedCheck.projectCandidate.checks[0].passed = false;
  const failedCheckFacts = createTrustedProjectReviewFacts(during, failedCheck);
  assert.equal(numericGuard(during, failedCheck, failedCheckFacts).passed, false);
  assert.equal(numericGuard(during, currentArtifact, structuredClone(trustedFacts)).passed, false);
  const modelFactsTask = structuredClone(during);
  const modelFactsReview = recordReview(modelFactsTask, currentArtifact.id, passingProjectReview());
  assert.equal(modelFactsReview.passed, false);
  assert.equal(modelFactsReview.checks.find((entry) => entry.name === '代码候选宿主计数事实守卫').passed, false);
  const codeItem = during.workItems.find((entry) => entry.stepKey === 'code');
  const session = during.agentSessions.findLast((entry) => entry.workItemId === codeItem.id && entry.runId === runId);
  assert.ok(session);
  assert.equal(session.runId, runId);
  assert.equal(session.workspaceScopeFingerprint, codeItem.workspaceScopeFingerprint);
  assert.equal(session.sourceSnapshotSha256, codeItem.sourceSnapshotSha256);
  assert.equal(session.workspaceScopeFingerprint, during.projectWorkspace.scopeFingerprint);
  assert.equal(session.sourceSnapshotSha256, during.projectWorkspace.sourceSnapshotSha256);
  assert.deepEqual(session.toolCalls.map((entry) => entry.hostAudit?.request.tool), ['workspace.read', 'workspace.write', 'workspace.check', 'workspace.diff']);
  assert.equal(session.toolCalls.every((entry, index) => entry.hostAudit.sessionSequence === index + 1), true);

  await new Promise((resolve) => running.server.close(resolve));
  running = await start({ port: 0, root, providers, projectWorkspaceHost: createProjectWorkspaceHost({ capabilityOverride: override }) });
  const afterRestart = await running.store.get(created.value.task.id);
  assert.equal(afterRestart.artifacts[0].projectCandidate.projectExecutionAudit.auditSha256, audit.auditSha256);
  const confirmed = await request(running.url, `/api/tasks/${created.value.task.id}/artifacts/${afterRestart.artifacts[0].id}/confirm`, { method: 'POST', body: '{}' });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.value));
  const approvalId = confirmed.value.approval.id;
  const downloaded = await fetch(`${running.url}/api/tasks/${created.value.task.id}/artifacts/${afterRestart.artifacts[0].id}/export?format=patch&approval=${approvalId}`);
  assert.equal(downloaded.status, 200);
  assert.equal(await downloaded.text(), afterRestart.artifacts[0].projectCandidate.patch);
  await running.store.mutate(created.value.task.id, (task) => {
    const owner = task.workItems.find((item) => item.kind === 'tool');
    task.agentSessions.findLast((entry) => entry.workItemId === owner.id && entry.toolCalls.some((call) => call.hostAudit)).toolCalls[0].hostAudit.sessionSequence = 99;
  });
  const staleExport = await fetch(`${running.url}/api/tasks/${created.value.task.id}/artifacts/${afterRestart.artifacts[0].id}/export?format=patch&approval=${approvalId}`);
  assert.equal(staleExport.status, 409);
  const staleProblem = await staleExport.json();
  assert.match(staleProblem.error.message, /审计|变化|过期/);
  const replacement = await request(running.url, `/api/tasks/${created.value.task.id}/suggestions`, {
    method: 'POST', body: JSON.stringify({ text: '替换为新的代码目标', classification: 'replace' }),
  });
  assert.equal(replacement.status, 201);
  const goalChanged = await request(running.url, `/api/tasks/${created.value.task.id}/suggestions/${replacement.value.suggestion.id}/accept-goal`, {
    method: 'POST', body: JSON.stringify({ statement: '实现新的独立代码目标', successCriteria: ['新目标固定检查通过'], boundaries: ['不写原项目'] }),
  });
  assert.equal(goalChanged.status, 200);
  const oldApprovalExport = await fetch(`${running.url}/api/tasks/${created.value.task.id}/artifacts/${afterRestart.artifacts[0].id}/export?format=patch&approval=${approvalId}`);
  assert.equal(oldApprovalExport.status, 400);
  assert.match((await oldApprovalExport.json()).error.message, /旧目标|当前目标|过期/);
});

test('HTTP continuity 固定事务由宿主完成检查差异、独立审阅、重启确认下载并在目标变化后撤旧', { timeout: 45_000 }, async (t) => {
  const root = await fs.mkdtemp(tempPrefix);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const originalPath = path.resolve('app/public/app.js');
  const originalBytes = await fs.readFile(originalPath);
  let reviewCapture;
  const reviewSeen = new Promise((resolve) => { reviewCapture = resolve; });
  const plan = {
    summary: '在固定函数区域修正续接状态徽标并执行宿主检查。',
    projectAlignment: { status: 'standalone', explanation: '独立的小范围真实项目修复。' },
    outputKind: 'project', deliverables: ['project_patch'],
    roles: [
      { key: 'developer', name: '代码执行员', mission: '修改固定函数区域', capabilities: ['固定工作区'], recruitmentReason: '需要真实候选差异。' },
      { key: 'author', name: '候选汇总员', mission: '汇总宿主证据', capabilities: ['说明'], recruitmentReason: '形成候选说明。' },
      { key: 'auditor', name: '独立审阅员', mission: '核对宿主证据', capabilities: ['审阅'], recruitmentReason: '确认前独立审阅。' },
      { key: 'courier', name: '交付员', mission: '等待确认', capabilities: ['交付'], recruitmentReason: '只交付指定版本。' },
    ],
    steps: [
      { key: 'code', title: '修改并检查续接状态候选', kind: 'tool', role: 'developer', dependsOn: [], tools: ['workspace.read', 'workspace.write', 'workspace.check', 'workspace.diff'], acceptanceCriteria: ['只改固定函数并通过固定检查'], expectedResult: '宿主代码证据' },
      { key: 'synthesize', title: '形成代码候选', kind: 'synthesis', role: 'author', dependsOn: ['code'], tools: [], acceptanceCriteria: ['绑定宿主证据'], expectedResult: 'project patch 候选' },
      { key: 'review', title: '独立核对', kind: 'review', role: 'auditor', dependsOn: ['synthesize'], tools: [], acceptanceCriteria: ['核对固定证据'], expectedResult: '审阅记录' },
      { key: 'deliver', title: '等待确认', kind: 'delivery', role: 'courier', dependsOn: ['review'], tools: [], acceptanceCriteria: ['只下载确认 patch'], expectedResult: '待确认 patch' },
    ],
  };
  const providers = {
    async status() { return { demo: { id: 'demo', available: true }, codex: { id: 'codex-cli', available: true } }; },
    async plan() { return structuredClone(plan); },
    async executeWork(task, item, input, { signal }) {
      if (item.stepKey === 'code') {
        assert.equal(input.projectTransaction.mode, 'host_fixed_transaction_v1');
        assert.equal(input.projectTransaction.publicContractFingerprint, task.projectWorkspace.publicContractFingerprint);
        assert.equal(input.projectTransaction.requiredModelAction, 'one_workspace_write');
        assert.deepEqual(input.projectTransaction.hostNextActions, ['workspace.check', 'workspace.diff']);
        const prompt = providerTest.workPrompt(task, item, input);
        assert.match(prompt, /只有这一次候选生成/);
        assert.doesNotMatch(prompt, /最多三轮/);
        const read = input.projectTransaction.readResult;
        assert.equal(read.contentScope, 'render-continuity-function-v1');
        const repaired = passingContinuityCandidate(read.content);
        return {
          summary: '', output: '', sources: [], claims: [], gap: '', caveats: [], deliverables: [], acceptanceChecks: [],
          toolRequests: [{ id: 'write-continuity', tool: 'workspace.write', reason: '只替换完整固定函数', args: { path: 'app/public/app.js', expectedFileSha256: read.fileSha256, expectedCandidateSha256: read.candidateSha256, content: repaired } }],
        };
      }
      if (item.kind === 'synthesis') {
        assert.equal(input.projectSourceIntegrity.fileCount, 3);
        assert.equal(input.projectSourceIntegrity.allUnchanged, true);
        assert.deepEqual(input.projectExecutionAudit.execution.calls.map((entry) => entry.request.tool), ['workspace.read', 'workspace.write', 'workspace.check', 'workspace.diff']);
        return { summary: '续接状态候选已绑定当前宿主证据。', output: '候选只调整终止状态的徽标与颜色，现有结构和其他状态保持不变。', sources: [], claims: [], gap: '', caveats: [], toolRequests: [], acceptanceChecks: item.acceptanceCriteria.map((criterion) => ({ criterion, passed: true, evidence: '源完整性、固定检查和执行审计均为当前版本' })), deliverables: [{ kind: 'project_patch', title: '续接状态修复候选', content: '候选 patch 只包含已授权固定函数区域内的终止状态提示修复，等待独立审阅和指定版本确认。' }] };
      }
      if (item.kind === 'review') return { summary: '预检查完成', output: '候选与宿主证据已交给独立审阅。', sources: [], claims: [], gap: '', caveats: [], deliverables: [], toolRequests: [], acceptanceChecks: item.acceptanceCriteria.map((criterion) => ({ criterion, passed: true, evidence: '未调用工具' })) };
      if (signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'cancelled' })), { once: true }));
    },
    async review(task, artifact, { signal, projectReviewEvidence }) {
      reviewCapture({ task: structuredClone(task), artifact: structuredClone(artifact), prompt: providerTest.reviewPrompt(task, artifact, { projectReviewEvidence }) });
      if (signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
      return passingProjectReview();
    },
  };
  let running = await start({ port: 0, root, providers, projectWorkspaceHost: createProjectWorkspaceHost({ capabilityOverride: override }) });
  t.after(() => running.server.close());
  const created = await request(running.url, '/api/tasks', { method: 'POST', body: JSON.stringify({ title: '续接状态小修复', goal: '修复终止状态错误显示为可继续', type: 'project', successCriteria: ['固定状态矩阵通过'], boundaries: ['只改 renderContinuity', '原项目只读'] }) });
  const capability = (await request(running.url, '/api/project-capabilities')).value.project;
  const continuityFixture = capability.fixtures.find((entry) => entry.id === 'irixi-continuity-ui-v1');
  assert.ok(continuityFixture);
  assert.equal(continuityFixture.checks[0].id, 'render-continuity-terminal-state-v1');
  assert.equal(continuityFixture.executionMode, 'host_fixed_transaction_v1');
  assert.match(continuityFixture.publicContractFingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(continuityFixture.publicContract.inputInterface.fields.map((field) => field.path), [
    'task.status', 'task.execution.stopReason', 'task.runtime.activeJob', 'task.continuity.candidate.confirmed',
    'task.continuity.progress.done', 'task.continuity.progress.incomplete', 'task.continuity.progress.stoppedBecause',
    'task.continuity.progress.nextStep', 'task.continuity.progress.needsUserDecision',
  ]);
  const attached = await request(running.url, `/api/tasks/${created.value.task.id}/project-workspace/attach`, { method: 'POST', body: JSON.stringify(attachBody(created.value.task, capability, continuityFixture.id)) });
  assert.equal(attached.status, 201);
  assert.equal(attached.value.task.projectWorkspace.fixtureId, continuityFixture.id);
  assert.equal(attached.value.task.projectWorkspace.executionMode, 'host_fixed_transaction_v1');
  assert.equal(attached.value.task.projectWorkspace.status, 'ready', JSON.stringify(attached.value.task.projectWorkspace.sandboxCapability));
  assert.equal(attached.value.task.projectWorkspace.publicContractFingerprint, continuityFixture.publicContractFingerprint);
  assert.equal(attached.value.task.projectWorkspace.publicContract.entrypoint, 'renderContinuity');
  assert.deepEqual(attached.value.task.projectWorkspace.readablePaths, ['app/public/app.js']);
  assert.deepEqual(attached.value.task.projectWorkspace.editablePaths, ['app/public/app.js']);
  assert.equal((await request(running.url, `/api/tasks/${created.value.task.id}/plan`, { method: 'POST', body: '{}' })).status, 200);
  const continued = await request(running.url, `/api/tasks/${created.value.task.id}/continue`, { method: 'POST', body: '{}' });
  assert.equal(continued.status, 202);
  let reviewTimeout;
  const timeoutReview = new Promise((_resolve, reject) => { reviewTimeout = setTimeout(() => reject(new Error('continuity final review timeout')), 20_000); });
  const observed = await Promise.race([reviewSeen, timeoutReview]);
  clearTimeout(reviewTimeout);
  const audit = observed.artifact.projectCandidate.projectExecutionAudit;
  assert.equal(audit.execution.mode, 'host_fixed_transaction_v1');
  assert.equal(audit.execution.transaction.modelInvocationCount, 1);
  assert.deepEqual(audit.execution.calls.map((call) => [call.actor, call.transactionStep, call.batchOrdinal, call.request.tool]), [
    ['host', 'read', 1, 'workspace.read'], ['model', 'write', 2, 'workspace.write'],
    ['host', 'check', 3, 'workspace.check'], ['host', 'diff', 4, 'workspace.diff'],
  ]);
  assert.equal(audit.execution.synthesis.actualToolCallCount, 0);
  assert.match(observed.prompt, /render-continuity-terminal-state-v1/);
  assert.match(observed.prompt, /宿主真实预读取.*唯一一次模型候选 write.*宿主固定 check.*宿主局部 diff/);
  assert.match(observed.prompt, /host\/model\/host\/host/);
  assert.match(observed.prompt, /read\/write\/check\/diff/);
  assert.doesNotMatch(observed.prompt, /同一第三批/);
  assert.match(observed.prompt, /--- a\/app\/public\/app\.js/);
  assert.match(observed.prompt, /需要先处理/);
  assert.match(observed.prompt, /"regionIntegrity"/);
  assert.match(observed.prompt, /"outsideUnchanged": true/);
  assert.doesNotMatch(observed.artifact.projectCandidate.patch, /@@ -1,/);
  assert.doesNotMatch(observed.artifact.projectCandidate.patch, /^[-+]import /m);
  assert.equal(observed.artifact.projectCandidate.regionIntegrity.outsideUnchanged, true);
  assert.equal(observed.artifact.projectCandidate.regionIntegrity.patchSha256, observed.artifact.projectCandidate.patchSha256);
  assert.equal(observed.artifact.projectCandidate.regionIntegritySha256, observed.artifact.projectCandidate.regionIntegrity.integritySha256);
  assert.equal(observed.prompt.includes(root), false);
  let stored;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    stored = await running.store.get(created.value.task.id);
    if (stored.artifacts[0]?.reviewStatus === 'passed' && stored.status === 'waiting_user') break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(stored.artifacts[0].reviewStatus, 'passed');
  assert.equal(stored.projectWorkspace.candidate.checks.at(-1).caseTotal, 23);
  assert.equal(stored.projectWorkspace.candidate.checks.at(-1).casePassed, 23);
  assert.equal(stored.artifacts[0].projectCandidate.regionIntegrity.candidateWhole.sha256, stored.projectWorkspace.candidate.manifest.find((entry) => entry.path === 'app/public/app.js').sha256);
  assert.deepEqual(await fs.readFile(originalPath), originalBytes);

  await new Promise((resolve) => running.server.close(resolve));
  running = await start({ port: 0, root, providers, projectWorkspaceHost: createProjectWorkspaceHost({ capabilityOverride: override }) });
  const restarted = await running.store.get(created.value.task.id);
  assert.equal(restarted.artifacts[0].projectCandidate.projectExecutionAuditSha256, audit.auditSha256);
  const confirmed = await request(running.url, `/api/tasks/${created.value.task.id}/artifacts/${restarted.artifacts[0].id}/confirm`, { method: 'POST', body: '{}' });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.value));
  const downloaded = await fetch(`${running.url}/api/tasks/${created.value.task.id}/artifacts/${restarted.artifacts[0].id}/export?format=patch&approval=${confirmed.value.approval.id}`);
  assert.equal(downloaded.status, 200);
  const patch = await downloaded.text();
  assert.equal(patch, restarted.artifacts[0].projectCandidate.patch);
  assert.match(patch, /需要先处理/);
  const replacement = await request(running.url, `/api/tasks/${created.value.task.id}/suggestions`, { method: 'POST', body: JSON.stringify({ text: '替换为另一个代码目标', classification: 'replace' }) });
  const changed = await request(running.url, `/api/tasks/${created.value.task.id}/suggestions/${replacement.value.suggestion.id}/accept-goal`, { method: 'POST', body: JSON.stringify({ statement: '另一个代码目标', successCriteria: ['另行确认'], boundaries: ['不沿用旧候选'] }) });
  assert.equal(changed.status, 200);
  const oldExport = await fetch(`${running.url}/api/tasks/${created.value.task.id}/artifacts/${restarted.artifacts[0].id}/export?format=patch&approval=${confirmed.value.approval.id}`);
  assert.equal(oldExport.status, 400);
  assert.deepEqual(await fs.readFile(originalPath), originalBytes);
});

test('HTTP continuity 固定检查失败保留候选与四步宿主记录，零重试零重规划且重启后仍阻断', { timeout: 30_000 }, async (t) => {
  const root = await fs.mkdtemp(tempPrefix);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectPlan = {
    summary: '在固定函数区域修正续接状态徽标并执行宿主检查。',
    projectAlignment: { status: 'standalone', explanation: '独立的小范围项目。' }, outputKind: 'project', deliverables: ['project_patch'],
    roles: [
      { key: 'developer', name: '代码执行员', mission: '修改固定函数区域', capabilities: ['固定工作区'], recruitmentReason: '需要真实候选差异。' },
      { key: 'author', name: '候选汇总员', mission: '汇总宿主证据', capabilities: ['说明'], recruitmentReason: '形成候选说明。' },
      { key: 'auditor', name: '独立审阅员', mission: '核对宿主证据', capabilities: ['审阅'], recruitmentReason: '确认前独立审阅。' },
      { key: 'courier', name: '交付员', mission: '等待确认', capabilities: ['交付'], recruitmentReason: '只交付指定版本。' },
    ],
    steps: [
      { key: 'code', title: '修改并检查续接状态候选', kind: 'tool', role: 'developer', dependsOn: [], tools: ['workspace.read', 'workspace.write', 'workspace.check', 'workspace.diff'], acceptanceCriteria: ['只改固定函数并通过固定检查'], expectedResult: '宿主代码证据' },
      { key: 'synthesize', title: '形成代码候选', kind: 'synthesis', role: 'author', dependsOn: ['code'], tools: [], acceptanceCriteria: ['绑定宿主证据'], expectedResult: 'project patch 候选' },
      { key: 'review', title: '独立核对', kind: 'review', role: 'auditor', dependsOn: ['synthesize'], tools: [], acceptanceCriteria: ['核对固定证据'], expectedResult: '审阅记录' },
      { key: 'deliver', title: '等待确认', kind: 'delivery', role: 'courier', dependsOn: ['review'], tools: [], acceptanceCriteria: ['只下载确认 patch'], expectedResult: '待确认 patch' },
    ],
  };
  let planCalls = 0; let workCalls = 0; let reviewCalls = 0;
  const providers = {
    async status() { return { demo: { id: 'demo', available: true }, codex: { id: 'codex-cli', available: true } }; },
    async plan() { planCalls += 1; return structuredClone(projectPlan); },
    async executeWork(currentTask, item, input) {
      workCalls += 1;
      assert.equal(item.kind, 'tool');
      const read = input.projectTransaction.readResult;
      if (currentTask.title.includes('顺序违例')) return {
        summary: '', output: '', sources: [], claims: [], gap: '', caveats: [], deliverables: [], acceptanceChecks: [],
        toolRequests: [{ id: 'duplicate-read', tool: 'workspace.read', reason: '受控协议违例', args: { path: read.path, view: 'candidate', expectedCandidateSha256: read.candidateSha256 } }],
      };
      const wrongField = wrongStopReasonCandidate(read.content);
      return { summary: '', output: '', sources: [], claims: [], gap: '', caveats: [], deliverables: [], acceptanceChecks: [], toolRequests: [{
        id: 'wrong-field-write', tool: 'workspace.write', reason: '受控失败候选',
        args: { path: 'app/public/app.js', expectedFileSha256: read.fileSha256, expectedCandidateSha256: read.candidateSha256, content: wrongField },
      }] };
    },
    async review() { reviewCalls += 1; throw new Error('review must not run after a failed fixed check'); },
  };
  let running = await start({ port: 0, root, providers, projectWorkspaceHost: createProjectWorkspaceHost({ capabilityOverride: override }) });
  t.after(() => running.server.close());
  const created = await request(running.url, '/api/tasks', { method: 'POST', body: JSON.stringify({ title: '受控失败项目', goal: '修复终止状态徽标', type: 'project', successCriteria: ['固定状态矩阵通过'], boundaries: ['只改 renderContinuity'] }) });
  const capability = (await request(running.url, '/api/project-capabilities')).value.project;
  const attached = await request(running.url, `/api/tasks/${created.value.task.id}/project-workspace/attach`, { method: 'POST', body: JSON.stringify(attachBody(created.value.task, capability, 'irixi-continuity-ui-v1')) });
  assert.equal(attached.status, 201);
  assert.equal((await request(running.url, `/api/tasks/${created.value.task.id}/plan`, { method: 'POST', body: '{}' })).status, 200);
  assert.equal((await request(running.url, `/api/tasks/${created.value.task.id}/continue`, { method: 'POST', body: '{}' })).status, 202);
  let failed;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    failed = await running.store.get(created.value.task.id);
    if (failed.status === 'partial' && failed.execution?.stopReason === 'project_verification_failed') break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(failed.status, 'partial');
  assert.equal(failed.execution.stopReason, 'project_verification_failed');
  assert.equal(planCalls, 1);
  assert.equal(workCalls, 1);
  assert.equal(reviewCalls, 0);
  assert.equal(failed.artifacts.length, 0);
  assert.equal(failed.execution.modelCalls.length, 1);
  assert.equal(failed.execution.modelCalls.every((entry) => entry.status === 'completed'), true);
  const owner = failed.workItems.find((item) => item.kind === 'tool');
  assert.equal(owner.attempts.length, 1);
  const session = failed.agentSessions.findLast((entry) => entry.workItemId === owner.id && entry.runId === failed.execution.id);
  assert.equal(session.projectTransaction.status, 'failed');
  assert.equal(session.projectTransaction.errorCode, 'project_verification_failed');
  assert.deepEqual(session.toolCalls.map((entry) => [entry.hostAudit.actor, entry.hostAudit.transactionStep, entry.ok]), [
    ['host', 'read', true], ['model', 'write', true], ['host', 'check', true], ['host', 'diff', true],
  ]);
  assert.equal(session.toolCalls[2].result.passed, false);
  assert.equal(session.toolCalls[2].result.casePassed, 9);
  assert.equal(session.toolCalls[2].result.caseTotal, 23);
  assert.ok(session.toolCalls[3].result.regionIntegrity);
  const continuity = (await request(running.url, `/api/tasks/${created.value.task.id}`)).value.task.continuity;
  assert.match(continuity.progress.nextStep, /固定业务检查未通过/);
  const blocked = await request(running.url, `/api/tasks/${created.value.task.id}/continue`, { method: 'POST', body: '{}' });
  assert.equal(blocked.status, 200);
  assert.equal(blocked.value.action, 'blocked');
  assert.equal(workCalls, 1);
  await new Promise((resolve) => running.server.close(resolve));
  running = await start({ port: 0, root, providers, projectWorkspaceHost: createProjectWorkspaceHost({ capabilityOverride: override }) });
  const restarted = (await request(running.url, `/api/tasks/${created.value.task.id}`)).value.task;
  assert.equal(restarted.status, 'partial');
  assert.equal(restarted.execution.stopReason, 'project_verification_failed');
  assert.match(restarted.continuity.progress.nextStep, /固定业务检查未通过/);
  assert.equal((await request(running.url, `/api/tasks/${created.value.task.id}/continue`, { method: 'POST', body: '{}' })).value.action, 'blocked');
  assert.equal(planCalls, 1);
  assert.equal(workCalls, 1);

  const recoveryInstruction = await request(running.url, `/api/tasks/${created.value.task.id}/suggestions`, {
    method: 'POST', body: JSON.stringify({ text: '修正停止原因取值路径并保留其他续接行为', classification: 'support' }),
  });
  assert.equal(recoveryInstruction.status, 201);
  assert.equal(recoveryInstruction.value.task.projectWorkspace.status, 'reauthorization_required');
  const recoveryAttach = await request(running.url, `/api/tasks/${created.value.task.id}/project-workspace/attach`, {
    method: 'POST', body: JSON.stringify(attachBody(recoveryInstruction.value.task, capability, 'irixi-continuity-ui-v1')),
  });
  assert.equal(recoveryAttach.status, 201);
  assert.equal(recoveryAttach.value.task.projectWorkspace.status, 'ready');
  const recoveryPlan = await request(running.url, `/api/tasks/${created.value.task.id}/plan`, { method: 'POST', body: '{}' });
  assert.equal(recoveryPlan.status, 200);
  assert.equal(planCalls, 2);
  assert.equal(workCalls, 1);

  const protocolTask = await request(running.url, '/api/tasks', { method: 'POST', body: JSON.stringify({ title: '顺序违例项目', goal: '修复终止状态徽标', type: 'project', successCriteria: ['固定状态矩阵通过'], boundaries: ['只改 renderContinuity'] }) });
  const protocolAttached = await request(running.url, `/api/tasks/${protocolTask.value.task.id}/project-workspace/attach`, { method: 'POST', body: JSON.stringify(attachBody(protocolTask.value.task, capability, 'irixi-continuity-ui-v1')) });
  assert.equal(protocolAttached.status, 201);
  assert.equal((await request(running.url, `/api/tasks/${protocolTask.value.task.id}/plan`, { method: 'POST', body: '{}' })).status, 200);
  assert.equal((await request(running.url, `/api/tasks/${protocolTask.value.task.id}/continue`, { method: 'POST', body: '{}' })).status, 202);
  let protocolFailed;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    protocolFailed = await running.store.get(protocolTask.value.task.id);
    if (protocolFailed.status === 'partial') break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(protocolFailed.execution.stopReason, 'project_transaction_failed');
  assert.equal(protocolFailed.artifacts.length, 0);
  assert.equal(protocolFailed.execution.modelCalls.length, 1);
  const protocolOwner = protocolFailed.workItems.find((item) => item.kind === 'tool');
  assert.equal(protocolOwner.attempts.length, 1);
  const protocolSession = protocolFailed.agentSessions.findLast((entry) => entry.workItemId === protocolOwner.id && entry.runId === protocolFailed.execution.id);
  assert.equal(protocolSession.projectTransaction.errorCode, 'project_transaction_failed');
  assert.deepEqual(protocolSession.toolCalls.map((entry) => [entry.hostAudit.actor, entry.hostAudit.transactionStep]), [['host', 'read']]);
  assert.equal((await request(running.url, `/api/tasks/${protocolTask.value.task.id}/continue`, { method: 'POST', body: '{}' })).value.action, 'blocked');
  assert.equal(planCalls, 3);
  assert.equal(workCalls, 2);
  assert.equal(reviewCalls, 0);
});
