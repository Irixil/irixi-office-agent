import crypto from 'node:crypto';
import { projectCandidateFingerprint } from './project-workspace.mjs';
import { GENERIC_FIXTURE_ID } from './project-scope.mjs';

const MAX_READ_BYTES = 1_500_000;
const MAX_SNIPPETS = 24;
const MAX_SNIPPET_LINES = 7;
const MAX_LINE_CHARS = 700;

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const canonical = (value) => JSON.stringify(value);

export const projectReviewEvidenceRequired = (task) => task?.type === 'project'
  && task.projectWorkspace?.fixtureId === GENERIC_FIXTURE_ID
  && task.projectWorkspace?.executionMode === 'host_bounded_transaction_v1';

export function assertProjectReviewMode(task) {
  if (task?.type !== 'project') return false;
  const genericFixture = task.projectWorkspace?.fixtureId === GENERIC_FIXTURE_ID;
  const boundedMode = task.projectWorkspace?.executionMode === 'host_bounded_transaction_v1';
  if (genericFixture !== boundedMode) throw evidenceError('有限源码 fixture 与宿主执行模式不一致。');
  return genericFixture && boundedMode;
}

function evidenceError(message = '项目审阅证据不完整、已过期或与当前候选不一致。') {
  return Object.assign(new Error(message), { code: 'project_review_evidence_stale', status: 409 });
}

function activeGoal(task) {
  return task.goal?.versions?.find((entry) => entry.id === task.goal.activeVersionId) || null;
}

function currentInstructionIds(task) {
  const goal = activeGoal(task);
  return (task.suggestions || []).filter((entry) => (entry.goalVersionId || goal?.id) === goal?.id
    && entry.classification === 'support' && entry.status === 'routed').map((entry) => entry.id).sort();
}

function sameArray(left, right) {
  return canonical(left || []) === canonical(right || []);
}

function checkDescriptors(workspace) {
  return (workspace.checks || []).map((entry) => ({
    id: entry.id,
    kind: entry.kind,
    specification: structuredClone(entry.specification || null),
    contractSha256: entry.contractSha256 || null,
    inputSetSha256: entry.inputSetSha256 || null,
    expectedSetSha256: entry.expectedSetSha256 || null,
    executionContractSha256: entry.executionContractSha256 || null,
  }));
}

function reviewArtifactProjection(artifact) {
  return {
    id: artifact?.id || null,
    version: artifact?.version ?? null,
    goalVersionId: artifact?.goalVersionId || null,
    projectRootGoalVersionId: artifact?.projectRootGoalVersionId || null,
    projectRootInputFingerprint: artifact?.projectRootInputFingerprint || null,
    materialApplicabilityFingerprint: artifact?.materialApplicabilityFingerprint ?? null,
    inputFingerprint: artifact?.inputFingerprint || null,
    sourceContextFingerprint: artifact?.sourceContextFingerprint || null,
    title: artifact?.title || '',
    summary: artifact?.summary || '',
    content: artifact?.content || '',
    sources: structuredClone(artifact?.sources || []),
    claims: structuredClone(artifact?.claims || []),
    caveats: structuredClone(artifact?.caveats || []),
    deliverables: structuredClone(artifact?.deliverables || []),
    derivations: structuredClone(artifact?.derivations || []),
    workResultIds: structuredClone(artifact?.workResultIds || []),
    nativeFiles: (artifact?.nativeFiles || []).map((entry) => ({
      id: entry.id || null,
      kind: entry.kind || null,
      format: entry.format || null,
      filename: entry.filename || null,
      status: entry.status || null,
      sha256: entry.sha256 || null,
      contentSha256: entry.contentSha256 || null,
      bytes: entry.bytes ?? null,
    })),
    projectCandidate: {
      fingerprint: projectCandidateFingerprint(artifact?.projectCandidate),
      candidateId: artifact?.projectCandidate?.candidateId || null,
      candidateSha256: artifact?.projectCandidate?.candidateSha256 || null,
      patchSha256: artifact?.projectCandidate?.patchSha256 || null,
      diffSha256: artifact?.projectCandidate?.diffSha256 || null,
      sourceIntegritySha256: artifact?.projectCandidate?.sourceIntegritySha256 || null,
      projectExecutionAuditSha256: artifact?.projectCandidate?.projectExecutionAuditSha256 || null,
      checksSha256: sha256(canonical(artifact?.projectCandidate?.checks || [])),
    },
  };
}

function reviewArtifactProjectionSha256(artifact) {
  return sha256(canonical(reviewArtifactProjection(artifact)));
}

function currentTaskInputBinding(task, binding) {
  return {
    goalVersionId: binding.goalVersionId,
    projectRootGoalVersionId: binding.projectRootGoalVersionId,
    projectRootInputFingerprint: binding.projectRootInputFingerprint,
    materialApplicabilityFingerprint: binding.materialApplicabilityFingerprint,
    instructionIds: [...binding.instructionIds],
  };
}

function acceptedProjectEvidence(task, workspace, binding) {
  const proposal = task.projectScopeProposal;
  const goal = activeGoal(task);
  const acceptedBinding = currentTaskInputBinding(task, binding);
  const scopeEvent = (task.events || []).findLast((entry) => entry.type === 'project.scope_accepted'
    && entry.detail?.proposalId === proposal?.id);
  const grantEvent = (task.events || []).findLast((entry) => entry.type === 'project_workspace.attached'
    && entry.detail?.fixtureId === workspace.fixtureId
    && entry.detail?.scopeFingerprint === workspace.scopeFingerprint
    && entry.detail?.sourceSnapshotSha256 === workspace.sourceSnapshotSha256);
  const proposalChecks = proposal?.checks || [];
  const registeredChecks = workspace.checks || [];
  const checkMatches = proposalChecks.length === registeredChecks.length && proposalChecks.every((requested) => {
    if (requested.id === 'node-syntax-v1') return registeredChecks.some((entry) => entry.kind === 'node-syntax-v1');
    return registeredChecks.some((entry) => entry.kind === requested.id
      && entry.specification?.modulePath === requested.modulePath
      && entry.specification?.namedExport === requested.namedExport
      && canonical(entry.specification?.cases || []) === canonical(requested.cases || []));
  });
  if (!proposal || proposal.status !== 'accepted' || proposal.id !== workspace.proposalId
    || proposal.fingerprint !== workspace.proposalFingerprint
    || proposal.acceptedFingerprint !== proposal.fingerprint
    || proposal.acceptedGoalVersionId !== binding.goalVersionId
    || canonical(proposal.acceptedTaskInputBinding) !== canonical(acceptedBinding)
    || canonical(proposal.goal) !== canonical({ statement: goal.statement, successCriteria: goal.successCriteria || [], boundaries: goal.boundaries || [] })
    || canonical(proposal.readablePaths || []) !== canonical(workspace.readablePaths || [])
    || canonical(proposal.editablePaths || []) !== canonical(workspace.editablePaths || [])
    || !checkMatches || !scopeEvent || scopeEvent.at !== proposal.acceptedAt
    || !grantEvent || Date.parse(grantEvent.at) < Date.parse(proposal.acceptedAt)
    || !workspace.grantId) throw evidenceError('当前需求卡、逐条用例、源码范围或工作区授权缺少同一输入版本下的明确接受凭据。');
  const acceptedScope = {
    repositoryId: proposal.repositoryId,
    repositoryTreeSha256: proposal.repositoryTreeSha256,
    deliverable: proposal.deliverable,
    readablePaths: [...proposal.readablePaths],
    editablePaths: [...proposal.editablePaths],
    checks: structuredClone(proposalChecks),
  };
  return {
    explicitlyAccepted: true,
    proposalId: proposal.id,
    proposalFingerprint: proposal.fingerprint,
    acceptedAt: proposal.acceptedAt,
    acceptedGoalVersionId: proposal.acceptedGoalVersionId,
    acceptedTaskInputBinding: acceptedBinding,
    acceptedGoalSha256: sha256(canonical(proposal.goal)),
    acceptedScopeSha256: sha256(canonical(acceptedScope)),
    acceptedCaseSetSha256: sha256(canonical(proposalChecks.flatMap((entry) => entry.cases || []))),
    scopeAcceptedEvent: { id: scopeEvent.id, type: scopeEvent.type, at: scopeEvent.at, proposalId: scopeEvent.detail.proposalId },
    workspaceGrant: {
      grantId: workspace.grantId,
      eventId: grantEvent.id,
      type: grantEvent.type,
      at: grantEvent.at,
      fixtureId: workspace.fixtureId,
      scopeFingerprint: workspace.scopeFingerprint,
      sourceSnapshotSha256: workspace.sourceSnapshotSha256,
    },
  };
}

function hostFactLabels(kind, sameKindCount) {
  if (sameKindCount !== 1) return [];
  if (kind === 'json-function-v1') return ['JSON 行为检查'];
  if (kind === 'node-syntax-v1') return ['语法检查'];
  return [];
}

function hostFacts(workspace, candidate) {
  const registered = workspace.checks || [];
  const kindCounts = new Map(registered.map((entry) => [entry.kind, registered.filter((item) => item.kind === entry.kind).length]));
  const checks = (candidate.checks || []).map((result) => {
    const descriptor = registered.find((entry) => entry.id === result.checkId);
    if (!descriptor || result.passed !== true || result.casePassed !== result.caseTotal
      || result.candidateSha256 !== candidate.candidateSha256 || !result.resultDigest) throw evidenceError('当前固定检查结果无法绑定已接受检查目录与候选。');
    return {
      checkId: result.checkId,
      kind: descriptor.kind,
      labels: hostFactLabels(descriptor.kind, kindCounts.get(descriptor.kind)),
      contractSha256: descriptor.contractSha256 || null,
      inputSetSha256: descriptor.inputSetSha256 || null,
      expectedSetSha256: descriptor.expectedSetSha256 || null,
      executionContractSha256: descriptor.executionContractSha256 || null,
      caseTotal: result.caseTotal,
      casePassed: result.casePassed,
      resultDigest: result.resultDigest,
      candidateSha256: result.candidateSha256,
    };
  }).sort((left, right) => left.checkId.localeCompare(right.checkId));
  if (checks.length !== registered.length) throw evidenceError('并非全部已接受固定检查都有当前通过结果。');
  return {
    version: 1,
    candidateSha256: candidate.candidateSha256,
    checks,
    changeCount: (candidate.changes || []).length,
    changeFactLabels: ['workspace.diff'],
  };
}

function acceptedSymbols(workspace) {
  return [...new Set((workspace.checks || []).filter((entry) => entry.kind === 'json-function-v1')
    .map((entry) => entry.specification?.namedExport)
    .filter((value) => typeof value === 'string' && /^[A-Za-z_$][\w$]*$/.test(value)))].sort();
}

function acceptedReferenceRequirements(task, workspace, symbols, reads) {
  const modulePaths = new Set((workspace.checks || []).filter((entry) => entry.kind === 'json-function-v1')
    .map((entry) => entry.specification?.modulePath).filter(Boolean));
  const callerPaths = reads.filter((entry) => !entry.changed && !modulePaths.has(entry.path)).map((entry) => entry.path);
  return callerPaths.length ? symbols.map((symbol) => ({ symbol, anyOfPaths: [...callerPaths] })) : [];
}

function boundedLine(value) {
  const text = String(value || '');
  if (text.length > MAX_LINE_CHARS) throw evidenceError('授权调用方的命中行超过审阅证据上限，不能截断后冒充完整片段。');
  return text;
}

function referenceSnippets(reads, symbols) {
  const snippets = [];
  for (const read of reads) {
    if (read.changed) continue;
    const lines = read.content.split('\n');
    for (const symbol of symbols) {
      const exactSymbol = new RegExp(`(^|[^A-Za-z0-9_$])${symbol.replaceAll('$', '\\$')}($|[^A-Za-z0-9_$])`);
      for (let index = 0; index < lines.length; index += 1) {
        if (!exactSymbol.test(lines[index])) continue;
        if (snippets.length >= MAX_SNIPPETS) throw evidenceError('授权调用方命中片段超过审阅证据上限，不能静默省略。');
        const start = Math.max(0, index - 2);
        const end = Math.min(lines.length, index + 3);
        const selected = lines.slice(start, end).slice(0, MAX_SNIPPET_LINES).map(boundedLine);
        const snippet = selected.join('\n');
        snippets.push({
          path: read.path,
          symbol,
          view: 'source_and_candidate',
          startLine: start + 1,
          endLine: start + selected.length,
          sourceSha256: read.sourceSha256,
          candidateSha256: read.candidateSha256,
          snippet,
          snippetSha256: sha256(snippet),
        });
      }
    }
  }
  return snippets;
}

function projectBinding(task, artifact, audit) {
  const goal = activeGoal(task);
  const workspace = task.projectWorkspace;
  const evidence = artifact.projectCandidate;
  const storedArtifact = task.artifacts?.find((entry) => entry.id === artifact.id);
  const instructionIds = currentInstructionIds(task);
  const binding = {
    taskId: task.id,
    goalVersionId: goal?.id || null,
    projectRootGoalVersionId: task.projectRootGoalVersionId || goal?.id || null,
    projectRootInputFingerprint: task.projectRootInputFingerprint || null,
    materialApplicabilityFingerprint: artifact.materialApplicabilityFingerprint ?? null,
    instructionIds,
    planId: task.plan?.id || null,
    planRevision: task.plan?.revision ?? null,
    proposalId: workspace?.proposalId || null,
    proposalFingerprint: workspace?.proposalFingerprint || null,
    grantId: workspace?.grantId || null,
    workspaceScopeFingerprint: workspace?.scopeFingerprint || null,
    sourceSnapshotSha256: workspace?.sourceSnapshotSha256 || null,
    candidateId: workspace?.candidate?.id || null,
    candidateSha256: workspace?.candidate?.candidateSha256 || null,
    artifactId: artifact.id,
    artifactVersion: artifact.version,
    artifactSemanticSha256: reviewArtifactProjectionSha256(artifact),
    projectExecutionAuditSha256: audit?.auditSha256 || null,
    projectCandidateFingerprint: projectCandidateFingerprint(evidence),
  };
  if (!goal || task.type !== 'project' || workspace?.status !== 'ready'
    || workspace.fixtureId !== GENERIC_FIXTURE_ID || workspace.executionMode !== 'host_bounded_transaction_v1'
    || !evidence || !audit || !storedArtifact || storedArtifact.version !== artifact.version
    || reviewArtifactProjectionSha256(storedArtifact) !== binding.artifactSemanticSha256
    || projectCandidateFingerprint(storedArtifact.projectCandidate) !== projectCandidateFingerprint(evidence)
    || artifact.goalVersionId !== goal.id || evidence.candidateId !== binding.candidateId
    || evidence.candidateSha256 !== binding.candidateSha256
    || evidence.workspaceScopeFingerprint !== binding.workspaceScopeFingerprint
    || evidence.sourceSnapshotSha256 !== binding.sourceSnapshotSha256
    || evidence.projectExecutionAuditSha256 !== binding.projectExecutionAuditSha256
    || audit.binding?.taskId !== task.id || audit.binding?.goalVersionId !== binding.goalVersionId
    || audit.binding?.projectRootGoalVersionId !== binding.projectRootGoalVersionId
    || (audit.binding?.projectRootInputFingerprint ?? null) !== binding.projectRootInputFingerprint
    || (audit.binding?.materialApplicabilityFingerprint ?? null) !== binding.materialApplicabilityFingerprint
    || !sameArray(audit.binding?.instructionIds, instructionIds)
    || audit.binding?.workspaceScopeFingerprint !== binding.workspaceScopeFingerprint
    || audit.binding?.sourceSnapshotSha256 !== binding.sourceSnapshotSha256
    || audit.plan?.id !== binding.planId || audit.plan?.revision !== binding.planRevision) throw evidenceError();
  return binding;
}

function actualReads(task, artifact, audit) {
  const workspace = task.projectWorkspace;
  const ownerSessionId = audit.execution?.sessionId;
  const ownerSession = (task.agentSessions || []).find((entry) => entry.id === ownerSessionId
    && entry.workItemId === audit.execution?.calls?.[0]?.workItemId
    && entry.runId === audit.execution?.runId);
  const readResults = ownerSession?.input?.projectTransaction?.readResults;
  const readCalls = (audit.execution?.calls || []).filter((entry) => entry.request?.tool === 'workspace.read');
  if (!ownerSession || ownerSession.status !== 'completed' || !Array.isArray(readResults)
    || readResults.length !== workspace.readablePaths.length || readCalls.length !== readResults.length
    || !sameArray(readResults.map((entry) => entry.path), workspace.readablePaths)
    || !sameArray(readCalls.map((entry) => entry.request.path), workspace.readablePaths)) throw evidenceError('当前执行没有覆盖完整授权 readSet。');
  const sourceByPath = new Map((artifact.projectCandidate.sourceIntegrity?.paths || []).map((entry) => [entry.path, entry]));
  const candidateByPath = new Map((workspace.candidate?.manifest || []).map((entry) => [entry.path, entry]));
  const changeByPath = new Map((artifact.projectCandidate.changes || []).map((entry) => [entry.path, entry]));
  let totalBytes = 0;
  return readResults.map((entry, index) => {
    const content = typeof entry.content === 'string' ? entry.content : null;
    const bytes = content === null ? -1 : Buffer.byteLength(content);
    totalBytes += Math.max(bytes, 0);
    const call = readCalls[index];
    const source = sourceByPath.get(entry.path);
    const candidate = candidateByPath.get(entry.path);
    const change = changeByPath.get(entry.path) || null;
    if (content === null || bytes !== entry.bytes || sha256(content) !== entry.fileSha256
      || entry.view !== 'candidate' || entry.candidateSha256 !== call.outcome?.candidateSha256
      || call.outcome?.ok !== true || call.outcome?.path !== entry.path || call.outcome?.view !== entry.view
      || call.outcome?.bytes !== entry.bytes || call.outcome?.fileSha256 !== entry.fileSha256
      || call.outcome?.workspaceScopeFingerprint !== workspace.scopeFingerprint
      || call.outcome?.sourceSnapshotSha256 !== workspace.sourceSnapshotSha256
      || !source || source.unchanged !== true || !candidate
      || source.authorized?.sha256 !== source.currentOriginal?.sha256
      || source.authorized?.sha256 !== source.taskSnapshot?.sha256
      || (change
        ? change.beforeSha256 !== entry.fileSha256 || change.afterSha256 !== candidate.sha256
          || change.bytes !== candidate.bytes || source.authorized?.sha256 !== entry.fileSha256
        : entry.fileSha256 !== candidate.sha256 || entry.bytes !== candidate.bytes
          || source.authorized?.sha256 !== candidate.sha256)) throw evidenceError('授权 readSet 的正文或来源哈希无法由当前宿主记录复核。');
    return {
      path: entry.path,
      content,
      bytes,
      readBeforeWriteSha256: entry.fileSha256,
      sourceSha256: source.authorized.sha256,
      candidateSha256: candidate.sha256,
      changed: source.authorized.sha256 !== candidate.sha256,
      ownerSessionId,
      transactionId: call.transactionId,
      readSequence: call.sessionSequence,
    };
  }).map((entry) => {
    if (totalBytes > MAX_READ_BYTES) throw evidenceError('授权 readSet 超过审阅证据上限。');
    return entry;
  });
}

function currentWorkReviewEvidence(task, artifact, binding, evidenceBasisSha256, expectedWorkPacketSha256) {
  const reviewItem = (task.workItems || []).find((entry) => entry.kind === 'review'
    && (task.plan?.stepKeys || []).includes(entry.stepKey));
  const runId = task.execution?.id || null;
  const ownerAuditRunId = artifact.projectCandidate?.projectExecutionAudit?.execution?.runId || null;
  const session = (task.agentSessions || []).findLast((entry) => entry.workItemId === reviewItem?.id
    && entry.runId === runId && entry.reviewEvidence);
  if (!session) return null;
  const evidence = session.reviewEvidence;
  const acceptanceChecks = structuredClone(evidence.acceptanceChecks || []);
  const criteria = reviewItem.acceptanceCriteria || [];
  const normalized = {
    summary: String(evidence.summary || ''),
    output: String(evidence.output || ''),
    sources: structuredClone(evidence.sources || []),
    acceptanceChecks,
  };
  if (session.goalVersionId !== binding.goalVersionId
    || session.projectRootGoalVersionId !== binding.projectRootGoalVersionId
    || (session.projectRootInputFingerprint ?? null) !== binding.projectRootInputFingerprint
    || (session.materialApplicabilityFingerprint ?? null) !== binding.materialApplicabilityFingerprint
    || session.workspaceScopeFingerprint !== binding.workspaceScopeFingerprint
    || session.sourceSnapshotSha256 !== binding.sourceSnapshotSha256
    || session.planRevision !== binding.planRevision
    || evidence.projectReviewEvidenceSha256 !== expectedWorkPacketSha256
    || evidence.evidenceBasisSha256 !== evidenceBasisSha256
    || evidence.artifactSemanticSha256 !== binding.artifactSemanticSha256
    || acceptanceChecks.length !== criteria.length
    || criteria.some((criterion) => !acceptanceChecks.some((entry) => entry.criterion === criterion && entry.passed === true))) {
    throw evidenceError('当前最终审阅缺少同一运行、候选与证据基础下完成的工作审阅。');
  }
  const resultDigest = sha256(canonical(normalized));
  if (evidence.resultDigest !== resultDigest) throw evidenceError('工作审阅保存结果与当前规范摘要不一致。');
  return {
    workItemId: reviewItem.id,
    sessionId: session.id,
    runId,
    ownerAuditRunId,
    planId: binding.planId,
    planRevision: binding.planRevision,
    usedPacketSha256: evidence.projectReviewEvidenceSha256,
    evidenceBasisSha256,
    artifactSemanticSha256: binding.artifactSemanticSha256,
    acceptanceCriteria: [...criteria],
    acceptanceChecks,
    resultDigest,
  };
}

export function buildProjectReviewEvidence(task, artifact) {
  if (!assertProjectReviewMode(task)) throw evidenceError('当前项目模式不使用有限源码审阅证据包。');
  const audit = artifact?.projectCandidate?.projectExecutionAudit;
  const binding = projectBinding(task, artifact, audit);
  const reads = actualReads(task, artifact, audit);
  const workspace = task.projectWorkspace;
  const symbols = acceptedSymbols(workspace);
  const snippets = referenceSnippets(reads, symbols);
  const referenceRequirements = acceptedReferenceRequirements(task, workspace, symbols, reads);
  if (referenceRequirements.some((requirement) => !snippets.some((entry) => entry.symbol === requirement.symbol && requirement.anyOfPaths.includes(entry.path)))) {
    throw evidenceError('授权 readSet 没有为已接受的 named export 提供完整调用方片段。');
  }
  const planItems = (task.workItems || []).filter((entry) => (task.plan?.stepKeys || []).includes(entry.stepKey));
  const owner = planItems.find((entry) => entry.kind === 'tool');
  const synthesis = planItems.find((entry) => entry.kind === 'synthesis');
  const basis = {
    version: 1,
    binding,
    acceptance: acceptedProjectEvidence(task, workspace, binding),
    goal: {
      statement: activeGoal(task).statement,
      successCriteria: structuredClone(activeGoal(task).successCriteria || []),
      boundaries: structuredClone(activeGoal(task).boundaries || []),
    },
    artifact: reviewArtifactProjection(artifact),
    authorization: {
      readablePaths: [...workspace.readablePaths],
      editablePaths: [...workspace.editablePaths],
      checks: checkDescriptors(workspace),
    },
    candidate: {
      changes: structuredClone(artifact.projectCandidate.changes || []),
      patch: artifact.projectCandidate.patch,
      patchSha256: artifact.projectCandidate.patchSha256,
      diffSha256: artifact.projectCandidate.diffSha256,
      sourceIntegritySha256: artifact.projectCandidate.sourceIntegritySha256,
      checkResults: (artifact.projectCandidate.checks || []).map((entry) => ({
        id: entry.id, checkId: entry.checkId, passed: entry.passed, casePassed: entry.casePassed,
        caseTotal: entry.caseTotal, resultDigest: entry.resultDigest, candidateSha256: entry.candidateSha256,
        workspaceScopeFingerprint: entry.workspaceScopeFingerprint, runtimeFingerprint: entry.runtimeFingerprint,
      })),
    },
    hostFacts: hostFacts(workspace, artifact.projectCandidate),
    provenance: reads.map(({ content: _content, ...entry }) => entry),
    authorizedReferences: { symbols, requirements: referenceRequirements, snippets },
    executionAudit: structuredClone(audit),
    dependencyScope: {
      ownerWorkItemId: owner?.id || null,
      synthesisWorkItemId: synthesis?.id || null,
      synthesisDependsOn: [...(synthesis?.dependsOn || [])],
      planStepKeys: [...(task.plan?.stepKeys || [])],
    },
    progress: {
      ownerCompleted: owner?.status === 'completed',
      synthesisCompleted: synthesis?.status === 'completed',
      candidateAvailable: Boolean(artifact.projectCandidate?.candidateId),
      checksPassed: (artifact.projectCandidate.checks || []).length > 0
        && artifact.projectCandidate.checks.every((entry) => entry.passed === true && entry.casePassed === entry.caseTotal),
    },
  };
  const evidenceBasisSha256 = sha256(canonical(basis));
  const emptyWorkPacketSha256 = sha256(canonical({ ...basis, evidenceBasisSha256, workReview: null }));
  const workReview = currentWorkReviewEvidence(task, artifact, binding, evidenceBasisSha256, emptyWorkPacketSha256);
  const body = { ...basis, evidenceBasisSha256, workReview };
  if (!body.candidate.patch || sha256(body.candidate.patch) !== body.candidate.patchSha256
    || !body.candidate.changes.length || !body.candidate.checkResults.length || !body.acceptance.explicitlyAccepted
    || body.candidate.checkResults.some((entry) => entry.passed !== true || entry.casePassed !== entry.caseTotal)
    || !body.progress.ownerCompleted || !body.progress.synthesisCompleted || !body.progress.checksPassed
    || body.dependencyScope.synthesisDependsOn?.includes(body.dependencyScope.ownerWorkItemId) !== true
    || body.provenance.length !== body.authorization.readablePaths.length) throw evidenceError();
  return { ...body, packetSha256: sha256(canonical(body)) };
}

export function assertProjectReviewEvidenceCurrent(task, artifact, packet) {
  const current = buildProjectReviewEvidence(task, artifact);
  if (!packet || packet.packetSha256 !== current.packetSha256 || canonical(packet) !== canonical(current)) throw evidenceError();
  return current;
}

export function assertProjectReviewProjection(task, artifact, projection, { requireOuterProjection = false } = {}) {
  if (!projectReviewEvidenceRequired(task)) return null;
  const packet = projection?.projectReviewEvidence;
  const current = assertProjectReviewEvidenceCurrent(task, artifact, packet);
  const hasOuterProjection = Object.hasOwn(projection || {}, 'goalVersionId');
  if (requireOuterProjection && !hasOuterProjection) {
    throw evidenceError('项目工作审阅的最终模型输入缺少当前目标与候选外层投影。');
  }
  if (hasOuterProjection) {
    const projectedCandidate = projection.candidateArtifact;
    if (projection.goalVersionId !== current.binding.goalVersionId
      || projection.goal !== current.goal.statement
      || projection.projectRootGoalVersionId !== current.binding.projectRootGoalVersionId
      || (projection.projectRootInputFingerprint ?? null) !== current.binding.projectRootInputFingerprint
      || projection.materialApplicability?.fingerprint !== current.binding.materialApplicabilityFingerprint
      || projectedCandidate?.id !== artifact.id || projectedCandidate?.version !== artifact.version
      || reviewArtifactProjectionSha256(projectedCandidate) !== current.binding.artifactSemanticSha256
      || projectCandidateFingerprint(projectedCandidate?.projectCandidate) !== current.binding.projectCandidateFingerprint
      || projection.projectWorkspace?.scopeFingerprint !== current.binding.workspaceScopeFingerprint
      || projection.projectWorkspace?.sourceSnapshotSha256 !== current.binding.sourceSnapshotSha256
      || projection.projectWorkspace?.candidate?.id !== current.binding.candidateId
      || projection.projectWorkspace?.candidate?.candidateSha256 !== current.binding.candidateSha256) throw evidenceError('项目审阅的最终模型输入与宿主证据包不一致。');
  }
  return current;
}

export const __test = { referenceSnippets, acceptedSymbols, acceptedReferenceRequirements, reviewArtifactProjection, reviewArtifactProjectionSha256 };
