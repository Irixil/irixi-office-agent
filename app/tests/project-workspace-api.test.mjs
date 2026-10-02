import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { recordReview } from '../core.mjs';
import { createTrustedProjectReviewFacts, groundingChecks } from '../execution.mjs';
import { createProjectWorkspaceHost } from '../project-workspace.mjs';
import { __test as providerTest } from '../providers.mjs';
import { start } from '../server.mjs';

const tempPrefix = path.join(process.cwd(), '.project-api-test-');
const override = { available: true, reason: 'test-only', fingerprint: 'test-only', probes: [], networkConnections: 0, writesAbsent: true };
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

function attachBody(task, capability) {
  return {
    fixtureId: 'node-single-file-v1',
    expectedGoalVersionId: task.goal.activeVersionId,
    expectedProjectRootGoalVersionId: task.projectRootGoalVersionId,
    expectedProjectRootInputFingerprint: task.projectRootInputFingerprint,
    expectedMaterialApplicabilityFingerprint: task.materialContext?.fingerprint ?? null,
    expectedPreviousScopeFingerprint: task.projectWorkspace?.scopeFingerprint || null,
    expectedCapabilityFingerprint: capability.fingerprint,
  };
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
    async review(task, artifact, { signal }) {
      reviewObserved({ task: structuredClone(task), artifact: structuredClone(artifact), prompt: providerTest.reviewPrompt(task, artifact) });
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
