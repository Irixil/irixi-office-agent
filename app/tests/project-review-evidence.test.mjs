import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { __test as providerTest } from '../providers.mjs';
import { __test as evidenceTest, assertProjectReviewEvidenceCurrent, assertProjectReviewMode, assertProjectReviewProjection, buildProjectReviewEvidence } from '../project-review-evidence.mjs';
import { assertProjectReviewInputReady, createTrustedProjectReviewFacts, groundingChecks } from '../execution.mjs';

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function fixture() {
  const caller = "import { normalizeLabel } from './label.mjs';\nexport function title(value) {\n  return normalizeLabel(value);\n}\n";
  const before = 'export function normalizeLabel(value) { return String(value); }\n';
  const after = 'export function normalizeLabel(value) { return String(value).trim(); }\n';
  const scope = 'a'.repeat(64);
  const source = 'b'.repeat(64);
  const candidateSha = 'c'.repeat(64);
  const auditSha = 'd'.repeat(64);
  const binding = {
    taskId: 'task-project', goalVersionId: 'goal-current', projectRootGoalVersionId: 'goal-current',
    projectRootInputFingerprint: 'root-current', materialApplicabilityFingerprint: 'materials-current', instructionIds: [],
    workspaceScopeFingerprint: scope, sourceSnapshotSha256: source, inputFingerprint: 'owner-input', sourceContextFingerprint: 'owner-source',
  };
  const readResults = [
    { path: 'app/caller.mjs', view: 'candidate', content: caller, bytes: Buffer.byteLength(caller), fileSha256: sha256(caller), candidateSha256: 'pre-candidate' },
    { path: 'app/label.mjs', view: 'candidate', content: before, bytes: Buffer.byteLength(before), fileSha256: sha256(before), candidateSha256: 'pre-candidate' },
  ];
  const calls = readResults.map((entry, index) => ({
    version: 1, taskId: 'task-project', runId: 'run-current', planId: 'plan-current', planRevision: 1,
    workItemId: 'work-owner', sessionId: 'session-owner', attemptId: 'attempt-owner', round: 1,
    batchOrdinal: index + 1, requestOrdinal: 1, sessionSequence: index + 1, actor: 'host',
    transactionId: 'transaction-current', transactionStep: 'read', binding,
    request: { tool: 'workspace.read', path: entry.path, view: 'candidate', expectedCandidateSha256: 'pre-candidate' },
    outcome: { ok: true, path: entry.path, view: 'candidate', bytes: entry.bytes, fileSha256: entry.fileSha256,
      candidateSha256: 'pre-candidate', sourceSnapshotSha256: source, workspaceScopeFingerprint: scope },
  }));
  const audit = {
    version: 1, auditSha256: auditSha, binding: { ...binding, candidateSha256: candidateSha },
    plan: { id: 'plan-current', revision: 1 }, execution: { runId: 'run-current', sessionId: 'session-owner', calls },
  };
  const patch = `--- a/app/label.mjs\n+++ b/app/label.mjs\n-${before.trim()}\n+${after.trim()}\n`;
  const projectCandidate = {
    sourceSnapshotSha256: source, workspaceScopeFingerprint: scope, candidateId: 'candidate-current', candidateSha256: candidateSha,
    diffSha256: sha256(patch), patch, patchSha256: sha256(patch), sourceIntegritySha256: 'e'.repeat(64),
    projectExecutionAudit: audit, projectExecutionAuditSha256: auditSha,
    changes: [{ path: 'app/label.mjs', beforeSha256: sha256(before), afterSha256: sha256(after), bytes: Buffer.byteLength(after) }],
    checks: [{ id: 'check-current', checkId: 'json-check', passed: true, casePassed: 1, caseTotal: 1, resultDigest: 'f'.repeat(64), candidateSha256: candidateSha, workspaceScopeFingerprint: scope, runtimeFingerprint: 'runtime-current' }],
    sourceIntegrity: { paths: [
      { path: 'app/caller.mjs', authorized: { bytes: Buffer.byteLength(caller), sha256: sha256(caller) }, currentOriginal: { bytes: Buffer.byteLength(caller), sha256: sha256(caller) }, taskSnapshot: { bytes: Buffer.byteLength(caller), sha256: sha256(caller) }, unchanged: true },
      { path: 'app/label.mjs', authorized: { bytes: Buffer.byteLength(before), sha256: sha256(before) }, currentOriginal: { bytes: Buffer.byteLength(before), sha256: sha256(before) }, taskSnapshot: { bytes: Buffer.byteLength(before), sha256: sha256(before) }, unchanged: true },
    ] },
    taskInputBinding: { goalVersionId: 'goal-current', projectRootGoalVersionId: 'goal-current', projectRootInputFingerprint: 'root-current', materialApplicabilityFingerprint: 'materials-current', instructionIds: [] },
  };
  const owner = { id: 'work-owner', stepKey: 'project-tool', kind: 'tool', status: 'completed' };
  const synthesis = { id: 'work-synthesis', stepKey: 'project-synthesis', kind: 'synthesis', status: 'completed', dependsOn: ['work-owner'] };
  const review = { id: 'work-review', stepKey: 'project-review', kind: 'review', status: 'running', dependsOn: ['work-synthesis'], acceptanceCriteria: ['核对 app/caller.mjs 对 normalizeLabel 的直接调用关系。'] };
  const task = {
    id: 'task-project', type: 'project', suggestions: [], materials: [], materialDecisions: [], reviews: [], approvals: [], events: [],
    execution: { id: 'run-review-current', modelCalls: [] },
    goal: { activeVersionId: 'goal-current', versions: [{ id: 'goal-current', statement: '修正标签规范化', successCriteria: ['固定用例通过'], boundaries: ['只改授权模块'] }] },
    projectRootGoalVersionId: 'goal-current', projectRootInputFingerprint: 'root-current',
    projectScopeProposal: {
      id: 'proposal-current', status: 'accepted', repositoryId: 'irixi-office-agent', repositoryTreeSha256: '9'.repeat(64),
      goal: { statement: '修正标签规范化', successCriteria: ['固定用例通过'], boundaries: ['只改授权模块'] },
      deliverable: 'project_patch', readablePaths: ['app/caller.mjs', 'app/label.mjs'], editablePaths: ['app/label.mjs'],
      checks: [{ id: 'json-function-v1', modulePath: 'app/label.mjs', namedExport: 'normalizeLabel', cases: [{ id: 'one', args: [' a '], expected: 'a' }] }],
      fingerprint: 'proposal-fingerprint', acceptedFingerprint: 'proposal-fingerprint', acceptedAt: '2026-10-03T10:00:00.000Z', acceptedGoalVersionId: 'goal-current',
      acceptedTaskInputBinding: { goalVersionId: 'goal-current', projectRootGoalVersionId: 'goal-current', projectRootInputFingerprint: 'root-current', materialApplicabilityFingerprint: 'materials-current', instructionIds: [] },
    },
    events: [
      { id: 'event-scope', type: 'project.scope_accepted', at: '2026-10-03T10:00:00.000Z', detail: { proposalId: 'proposal-current' } },
      { id: 'event-grant', type: 'project_workspace.attached', at: '2026-10-03T10:00:01.000Z', detail: { fixtureId: 'irixi-bounded-js-v1', scopeFingerprint: scope, sourceSnapshotSha256: source } },
    ],
    plan: { id: 'plan-current', revision: 1, stepKeys: ['project-tool', 'project-synthesis', 'project-review', 'project-delivery'] },
    workItems: [owner, synthesis, review, { id: 'work-delivery', stepKey: 'project-delivery', kind: 'delivery', status: 'pending' }],
    projectWorkspace: {
      status: 'ready', fixtureId: 'irixi-bounded-js-v1', executionMode: 'host_bounded_transaction_v1', proposalId: 'proposal-current', proposalFingerprint: 'proposal-fingerprint', grantId: 'grant-current',
      scopeFingerprint: scope, sourceSnapshotSha256: source, readablePaths: ['app/caller.mjs', 'app/label.mjs'], editablePaths: ['app/label.mjs'],
      checks: [{ id: 'json-check', kind: 'json-function-v1', specification: { id: 'json-function-v1', modulePath: 'app/label.mjs', namedExport: 'normalizeLabel', cases: [{ id: 'one', args: [' a '], expected: 'a' }] }, contractSha256: 'contract', inputSetSha256: 'inputs', expectedSetSha256: 'expected', executionContractSha256: 'execution' }],
      candidate: { id: 'candidate-current', candidateSha256: candidateSha, manifest: [
        { path: 'app/caller.mjs', bytes: Buffer.byteLength(caller), sha256: sha256(caller) },
        { path: 'app/label.mjs', bytes: Buffer.byteLength(after), sha256: sha256(after) },
      ] },
    },
    agentSessions: [{ id: 'session-owner', workItemId: 'work-owner', runId: 'run-current', status: 'completed', input: { projectTransaction: { readResults } } }],
    artifacts: [],
  };
  const artifact = { id: 'artifact-current', version: 1, goalVersionId: 'goal-current', materialApplicabilityFingerprint: 'materials-current',
    content: 'JSON 行为检查 1 个用例全部通过。', deliverables: [], claims: [], projectCandidate };
  task.artifacts.push(artifact);
  return { task, artifact, review };
}

function completeControlledWorkReview(task, artifact) {
  const workPacket = buildProjectReviewEvidence(task, artifact);
  const reviewItem = task.workItems.find((entry) => entry.kind === 'review');
  const normalized = {
    summary: '受控工作审阅完成。',
    output: '受控工作审阅仅用于零模型测试。',
    sources: [],
    acceptanceChecks: reviewItem.acceptanceCriteria.map((criterion) => ({ criterion, passed: true, evidence: 'controlled host fixture' })),
  };
  task.agentSessions.push({
    id: 'session-review', workItemId: reviewItem.id, runId: task.execution.id, status: 'running', planRevision: 1,
    goalVersionId: 'goal-current', projectRootGoalVersionId: 'goal-current', projectRootInputFingerprint: 'root-current',
    materialApplicabilityFingerprint: 'materials-current', workspaceScopeFingerprint: task.projectWorkspace.scopeFingerprint,
    sourceSnapshotSha256: task.projectWorkspace.sourceSnapshotSha256,
    reviewEvidence: {
      ...normalized,
      resultDigest: sha256(JSON.stringify(normalized)),
      projectReviewEvidenceSha256: workPacket.packetSha256,
      evidenceBasisSha256: workPacket.evidenceBasisSha256,
      artifactSemanticSha256: workPacket.binding.artifactSemanticSha256,
    },
  });
  return buildProjectReviewEvidence(task, artifact);
}

test('宿主审阅证据包绑定当前候选并只投影授权调用方的有界片段', () => {
  const { task, artifact, review } = fixture();
  const packet = buildProjectReviewEvidence(task, artifact);
  assert.equal(packet.acceptance.explicitlyAccepted, true);
  assert.equal(packet.acceptance.scopeAcceptedEvent.proposalId, 'proposal-current');
  assert.equal(packet.acceptance.workspaceGrant.grantId, 'grant-current');
  assert.deepEqual(packet.hostFacts.checks.map((entry) => [entry.checkId, entry.kind, entry.labels, entry.caseTotal, entry.casePassed]), [
    ['json-check', 'json-function-v1', ['JSON 行为检查'], 1, 1],
  ]);
  assert.equal(packet.provenance.length, 2);
  assert.equal(packet.binding.projectCandidateFingerprint.length, 64);
  assert.deepEqual(packet.authorizedReferences.requirements, [{ symbol: 'normalizeLabel', anyOfPaths: ['app/caller.mjs'] }]);
  assert.equal(packet.authorizedReferences.snippets.some((entry) => entry.path === 'app/caller.mjs' && entry.snippet.includes('return normalizeLabel(value)')), true);
  const projection = {
    goalVersionId: 'goal-current', goal: '修正标签规范化', projectRootGoalVersionId: 'goal-current', projectRootInputFingerprint: 'root-current',
    materialApplicability: { fingerprint: 'materials-current' },
    candidateArtifact: structuredClone(artifact),
    projectWorkspace: { scopeFingerprint: task.projectWorkspace.scopeFingerprint, sourceSnapshotSha256: task.projectWorkspace.sourceSnapshotSha256,
      candidate: { id: task.projectWorkspace.candidate.id, candidateSha256: task.projectWorkspace.candidate.candidateSha256 } },
    projectReviewEvidence: packet,
  };
  const prompt = providerTest.workPrompt(task, review, projection);
  assert.match(prompt, /return normalizeLabel\(value\)/);
  assert.match(prompt, /explicitlyAccepted/);
  assert.match(prompt, /proposal-current/);
  assert.match(prompt, /json-check/);
  assert.match(prompt, /resultDigest/);
  assert.doesNotMatch(prompt, /PRIVATE_EXPECTED/);
  assert.equal(assertProjectReviewProjection(task, artifact, { projectReviewEvidence: packet }).packetSha256, packet.packetSha256);
  task.execution.modelCalls = [];
  assert.throws(() => providerTest.workPrompt(task, review, { projectReviewEvidence: packet }), (error) => error.code === 'project_review_evidence_stale');
  assert.equal(task.execution.modelCalls.length, 0);
  const wrongCandidate = structuredClone(projection);
  wrongCandidate.candidateArtifact.projectCandidate.candidateSha256 = '0'.repeat(64);
  assert.throws(() => providerTest.workPrompt(task, review, wrongCandidate), (error) => error.code === 'project_review_evidence_stale');
  assert.equal(task.execution.modelCalls.length, 0);
  for (const mutate of [
    (candidate) => { candidate.content = '被替换的正文'; },
    (candidate) => { candidate.claims = [{ statement: '伪造结论' }]; },
    (candidate) => { candidate.deliverables = [{ kind: 'project_patch', title: '伪造交付物', content: '伪造内容' }]; },
  ]) {
    const mismatched = structuredClone(projection);
    mutate(mismatched.candidateArtifact);
    assert.throws(() => providerTest.workPrompt(task, review, mismatched), (error) => error.code === 'project_review_evidence_stale');
    assert.equal(task.execution.modelCalls.length, 0);
  }
  const finalPacket = completeControlledWorkReview(task, artifact);
  assert.doesNotThrow(() => assertProjectReviewInputReady(task, artifact, finalPacket, { requireWorkReview: true }));
  assert.equal(finalPacket.workReview.sessionId, 'session-review');
  assert.equal(finalPacket.workReview.runId, 'run-review-current');
  assert.equal(finalPacket.workReview.ownerAuditRunId, 'run-current');
  const staleReview = fixture();
  completeControlledWorkReview(staleReview.task, staleReview.artifact);
  staleReview.task.agentSessions.find((entry) => entry.id === 'session-review').runId = 'run-review-old';
  const stalePacket = buildProjectReviewEvidence(staleReview.task, staleReview.artifact);
  assert.equal(stalePacket.workReview, null);
  assert.throws(() => assertProjectReviewInputReady(staleReview.task, staleReview.artifact, stalePacket, { requireWorkReview: true }),
    (error) => error.code === 'project_review_input_incomplete');
});

test('需求卡、当前输入、逐条检查及授权事件任一缺失或过期都会在序列化前拒绝', () => {
  for (const mutate of [
    ({ task }) => { task.events = task.events.filter((entry) => entry.type !== 'project.scope_accepted'); },
    ({ task }) => { task.projectScopeProposal.acceptedFingerprint = 'old-fingerprint'; },
    ({ task }) => { task.projectScopeProposal.acceptedGoalVersionId = 'goal-old'; },
    ({ task }) => { task.projectScopeProposal.acceptedTaskInputBinding.materialApplicabilityFingerprint = 'old-materials'; },
    ({ task }) => { task.events.find((entry) => entry.type === 'project_workspace.attached').detail.scopeFingerprint = 'old-scope'; },
    ({ task }) => { task.projectScopeProposal.checks[0].cases[0].expected = 'forged'; },
  ]) {
    const value = fixture(); mutate(value);
    assert.throws(() => buildProjectReviewEvidence(value.task, value.artifact), (error) => error.code === 'project_review_evidence_stale');
  }
});

test('宿主检查计数只支持明确且唯一的检查事实引用，不按相同数字放行业务数量', () => {
  const value = fixture();
  const packet = buildProjectReviewEvidence(value.task, value.artifact);
  const facts = createTrustedProjectReviewFacts(value.task, value.artifact, packet);
  const numeric = (artifact, trusted = facts) => groundingChecks(value.task, artifact, { projectReviewFacts: trusted }).find((entry) => entry.name === '关键数值守卫');
  assert.equal(numeric(value.artifact).passed, true);
  assert.doesNotThrow(() => assertProjectReviewInputReady(value.task, value.artifact, packet));
  for (const content of [
    'JSON 行为检查 2 个用例全部通过。',
    'JSON 行为检查 1 个客户全部通过。',
    '另一个检查 1 个用例全部通过。',
    'JSON 行为检查 1 个用例合同。',
  ]) {
    const changed = { ...structuredClone(value.artifact), content };
    const changedTask = structuredClone(value.task);
    changedTask.artifacts = [changed];
    const changedPacket = buildProjectReviewEvidence(changedTask, changed);
    assert.equal(groundingChecks(changedTask, changed, { projectReviewFacts: createTrustedProjectReviewFacts(changedTask, changed, changedPacket) })
      .find((entry) => entry.name === '关键数值守卫').passed, false, content);
    assert.throws(() => assertProjectReviewInputReady(changedTask, changed, changedPacket), (error) => error.code === 'project_review_input_incomplete', content);
    const projection = {
      goalVersionId: 'goal-current', goal: '修正标签规范化', projectRootGoalVersionId: 'goal-current', projectRootInputFingerprint: 'root-current',
      materialApplicability: { fingerprint: 'materials-current' }, candidateArtifact: structuredClone(changed),
      projectWorkspace: { scopeFingerprint: changedTask.projectWorkspace.scopeFingerprint, sourceSnapshotSha256: changedTask.projectWorkspace.sourceSnapshotSha256,
        candidate: { id: changedTask.projectWorkspace.candidate.id, candidateSha256: changedTask.projectWorkspace.candidate.candidateSha256 } },
      projectReviewEvidence: changedPacket,
    };
    assert.throws(() => providerTest.workPrompt(changedTask, value.review, projection), (error) => error.code === 'project_review_input_incomplete', content);
    const finalPacket = completeControlledWorkReview(changedTask, changed);
    assert.throws(() => providerTest.reviewPrompt(changedTask, changed, { projectReviewEvidence: finalPacket }), (error) => error.code === 'project_review_input_incomplete', content);
  }
  assert.equal(numeric(value.artifact, structuredClone(facts)).passed, false, '模型复制宿主 facts 不能获得可信品牌');

  const ambiguous = fixture();
  ambiguous.task.projectWorkspace.checks.push({ ...structuredClone(ambiguous.task.projectWorkspace.checks[0]), id: 'json-check-2' });
  ambiguous.task.projectScopeProposal.checks.push(structuredClone(ambiguous.task.projectScopeProposal.checks[0]));
  ambiguous.artifact.projectCandidate.checks.push({ ...structuredClone(ambiguous.artifact.projectCandidate.checks[0]), id: 'check-current-2', checkId: 'json-check-2', resultDigest: '8'.repeat(64) });
  const ambiguousPacket = buildProjectReviewEvidence(ambiguous.task, ambiguous.artifact);
  assert.deepEqual(ambiguousPacket.hostFacts.checks.flatMap((entry) => entry.labels), []);
  const ambiguousFacts = createTrustedProjectReviewFacts(ambiguous.task, ambiguous.artifact, ambiguousPacket);
  assert.equal(groundingChecks(ambiguous.task, ambiguous.artifact, { projectReviewFacts: ambiguousFacts }).find((entry) => entry.name === '关键数值守卫').passed, false);
});

test('宿主审阅证据包对缺正文、旧目标、越权readSet、漏字段和长行fail closed', () => {
  for (const mutate of [
    ({ task }) => { delete task.agentSessions[0].input.projectTransaction.readResults[0].content; },
    ({ task }) => { task.goal.versions.push({ id: 'goal-new', statement: '新目标', successCriteria: [], boundaries: [] }); task.goal.activeVersionId = 'goal-new'; },
    ({ task }) => { task.projectWorkspace.readablePaths.push('private/secret.mjs'); },
    ({ task }) => { const value = 'export function title(value) { return String(value); }\n'; const read = task.agentSessions[0].input.projectTransaction.readResults[0]; read.content = value; read.bytes = Buffer.byteLength(value); read.fileSha256 = sha256(value); const source = task.artifacts[0].projectCandidate.sourceIntegrity.paths[0]; source.authorized = { bytes: read.bytes, sha256: read.fileSha256 }; source.currentOriginal = { bytes: read.bytes, sha256: read.fileSha256 }; source.taskSnapshot = { bytes: read.bytes, sha256: read.fileSha256 }; const manifest = task.projectWorkspace.candidate.manifest[0]; manifest.bytes = read.bytes; manifest.sha256 = read.fileSha256; const outcome = task.artifacts[0].projectCandidate.projectExecutionAudit.execution.calls[0].outcome; outcome.bytes = read.bytes; outcome.fileSha256 = read.fileSha256; },
    ({ task }) => { task.agentSessions[0].input.projectTransaction.readResults[0].content = `${'x'.repeat(701)} normalizeLabel`; task.agentSessions[0].input.projectTransaction.readResults[0].bytes = Buffer.byteLength(task.agentSessions[0].input.projectTransaction.readResults[0].content); task.agentSessions[0].input.projectTransaction.readResults[0].fileSha256 = sha256(task.agentSessions[0].input.projectTransaction.readResults[0].content); task.artifacts[0].projectCandidate.sourceIntegrity.paths[0].authorized.sha256 = task.agentSessions[0].input.projectTransaction.readResults[0].fileSha256; task.artifacts[0].projectCandidate.sourceIntegrity.paths[0].currentOriginal.sha256 = task.agentSessions[0].input.projectTransaction.readResults[0].fileSha256; task.artifacts[0].projectCandidate.sourceIntegrity.paths[0].taskSnapshot.sha256 = task.agentSessions[0].input.projectTransaction.readResults[0].fileSha256; task.projectWorkspace.candidate.manifest[0].sha256 = task.agentSessions[0].input.projectTransaction.readResults[0].fileSha256; task.projectWorkspace.candidate.manifest[0].bytes = task.agentSessions[0].input.projectTransaction.readResults[0].bytes; task.artifacts[0].projectCandidate.projectExecutionAudit.execution.calls[0].outcome.fileSha256 = task.agentSessions[0].input.projectTransaction.readResults[0].fileSha256; task.artifacts[0].projectCandidate.projectExecutionAudit.execution.calls[0].outcome.bytes = task.agentSessions[0].input.projectTransaction.readResults[0].bytes; },
  ]) {
    const value = fixture(); mutate(value);
    assert.throws(() => buildProjectReviewEvidence(value.task, value.artifact), (error) => error.code === 'project_review_evidence_stale');
  }
  const current = fixture();
  const packet = buildProjectReviewEvidence(current.task, current.artifact);
  delete packet.goal;
  assert.throws(() => assertProjectReviewEvidenceCurrent(current.task, current.artifact, packet), (error) => error.code === 'project_review_evidence_stale');
  const outer = fixture();
  const outerPacket = buildProjectReviewEvidence(outer.task, outer.artifact);
  assert.throws(() => assertProjectReviewProjection(outer.task, outer.artifact, {
    goalVersionId: 'goal-old', goal: outer.task.goal.versions[0].statement,
    projectRootGoalVersionId: 'goal-current', projectRootInputFingerprint: 'root-current',
    materialApplicability: { fingerprint: 'materials-current' }, candidateArtifact: structuredClone(outer.artifact),
    projectWorkspace: { scopeFingerprint: outer.task.projectWorkspace.scopeFingerprint, sourceSnapshotSha256: outer.task.projectWorkspace.sourceSnapshotSha256,
      candidate: { id: outer.task.projectWorkspace.candidate.id, candidateSha256: outer.task.projectWorkspace.candidate.candidateSha256 } },
    projectReviewEvidence: outerPacket,
  }), (error) => error.code === 'project_review_evidence_stale');
  const downgraded = fixture();
  downgraded.task.projectWorkspace.executionMode = 'host_fixed_transaction_v1';
  assert.throws(() => buildProjectReviewEvidence(downgraded.task, downgraded.artifact), (error) => error.code === 'project_review_evidence_stale');
  const wrongFixture = fixture();
  wrongFixture.task.projectWorkspace.fixtureId = 'node-single-file-v1';
  assert.throws(() => buildProjectReviewEvidence(wrongFixture.task, wrongFixture.artifact), (error) => error.code === 'project_review_evidence_stale');
  const legacy = fixture();
  legacy.task.projectWorkspace.fixtureId = 'node-single-file-v1';
  legacy.task.projectWorkspace.executionMode = 'host_fixed_transaction_v1';
  assert.equal(assertProjectReviewMode(legacy.task), false);
});

test('没有已接受调用方核对标准时不会把独立纯函数偷偷升级为必须存在调用方', () => {
  const { task, artifact } = fixture();
  task.workItems.find((entry) => entry.kind === 'review').acceptanceCriteria = ['核对固定 JSON 用例与最小差异。'];
  task.projectWorkspace.readablePaths = ['app/label.mjs'];
  task.projectScopeProposal.readablePaths = ['app/label.mjs'];
  task.projectWorkspace.candidate.manifest = task.projectWorkspace.candidate.manifest.filter((entry) => entry.path === 'app/label.mjs');
  task.agentSessions[0].input.projectTransaction.readResults = task.agentSessions[0].input.projectTransaction.readResults.filter((entry) => entry.path === 'app/label.mjs');
  artifact.projectCandidate.sourceIntegrity.paths = artifact.projectCandidate.sourceIntegrity.paths.filter((entry) => entry.path === 'app/label.mjs');
  artifact.projectCandidate.projectExecutionAudit.execution.calls = artifact.projectCandidate.projectExecutionAudit.execution.calls.filter((entry) => entry.request.path === 'app/label.mjs');
  const packet = buildProjectReviewEvidence(task, artifact);
  assert.deepEqual(packet.authorizedReferences.requirements, []);
  assert.deepEqual(packet.authorizedReferences.snippets, []);
});

test('调用方片段只接受精确标识符且超过总上限时拒绝而不静默裁剪', () => {
  const base = { path: 'app/caller.mjs', changed: false, sourceSha256: 'a', candidateSha256: 'a' };
  assert.deepEqual(evidenceTest.referenceSnippets([{ ...base, content: 'normalizeLabelExtra(value);' }], ['normalizeLabel']), []);
  assert.throws(() => evidenceTest.referenceSnippets([{ ...base, content: Array.from({ length: 25 }, () => 'normalizeLabel(value);').join('\n') }], ['normalizeLabel']), (error) => error.code === 'project_review_evidence_stale');
});
