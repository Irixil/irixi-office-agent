import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import {
  STE100_PM_REPORTING_PROMPT,
  WORKSPACE_ROOT,
  buildUnifiedPatch,
  executeDeveloperInWorktree,
  generateLeadPlanWithOmo,
  readRelativeFileMap,
  runHostChecks,
  runIndependentReviewerWithOmo,
  sha256Buffer,
  sha256Text,
} from './omo-harness.mjs';
import { CODEX_ROLE_MODEL, buildCodexRoleInvocation, resolveCodexRuntime, runCodexRole, safeFailureText } from '../app/codex-role-adapter.mjs';
import { buildCodexDecisionPrompt } from './codex-provider-protocol.mjs';
import { nativeRoleTools, runOmoNativeRpcRole } from './native-rpc-runner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(WORKSPACE_ROOT, 'app', 'public');
const ART_DIR = path.join(WORKSPACE_ROOT, 'art');
const VENDOR_DIR = path.join(WORKSPACE_ROOT, 'node_modules');
const BUILTIN_PROJECTS_DIR = path.join(WORKSPACE_ROOT, 'projects');
const PILOT_RUNTIME_DIR = path.join(__dirname, 'runtime');
const PILOT_STATE_FILE = path.join(PILOT_RUNTIME_DIR, 'pilot-ledger.json');

export function codexRoleProcessTimeoutMs(role) {
  if (role === 'Developer' || role === 'Reviewer') return 360_000;
  return role === 'Chat' ? 30_000 : 60_000;
}
const PILOT_WORKTREES_DIR = path.join(PILOT_RUNTIME_DIR, 'worktrees');
const PILOT_PROJECTS_DIR = path.join(PILOT_RUNTIME_DIR, 'projects');
const PILOT_DELIVERIES_DIR = path.join(PILOT_RUNTIME_DIR, 'deliveries');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
};

const ALLOWED_ROLES = [
  'Lead',
  'Senior Developer',
  'Frontend Developer',
  'Backend Architect',
  'Rapid Prototyper',
  'UI Designer',
  'Product Manager',
  'Reviewer',
];

function nowIso() {
  return new Date().toISOString();
}

function planInstructionSnapshot(task, project) {
  const artifact = task.artifacts?.find((item) => item.id === task.activeArtifactId) || null;
  const artifactBinding = artifact ? { id: artifact.id, version: artifact.version, candidateSha256: artifact.candidateSha256, diffSha256: artifact.diffSha256 } : null;
  const currentBinding = {
    taskId: task.id, goalVersionId: task.goalVersionId, projectId: project.projectId,
    scopeFingerprint: project.scopeFingerprint, executionId: task.execution.id,
    registrySha256: task.registry?.registrySha256 || null,
    artifactId: artifact?.id || null, artifactVersion: artifact?.version ?? null,
    candidateSha256: artifact?.candidateSha256 || null, diffSha256: artifact?.diffSha256 || null,
  };
  const instructions = (task.instructions || []).filter((item) => {
    const saved = item.binding;
    if (item.goalVersionId !== task.goalVersionId || !saved
      || saved.taskId !== currentBinding.taskId || saved.goalVersionId !== currentBinding.goalVersionId
      || saved.projectId !== currentBinding.projectId || saved.scopeFingerprint !== currentBinding.scopeFingerprint
      || saved.artifactId !== currentBinding.artifactId || saved.artifactVersion !== currentBinding.artifactVersion
      || saved.candidateSha256 !== currentBinding.candidateSha256 || saved.diffSha256 !== currentBinding.diffSha256) return false;
    if (saved.executionId === currentBinding.executionId && saved.registrySha256 === currentBinding.registrySha256) return true;
    if (saved.executionId === null && saved.registrySha256 === null) return true;
    const archived = task.executionHistory?.find((entry) => entry.execution?.id === saved.executionId
      && entry.registry?.registrySha256 === saved.registrySha256);
    const execution = archived?.execution;
    const registry = archived?.registry;
    const activeStatuses = new Set(['reserved', 'running', 'started', 'in_progress', 'working']);
    const hasInFlight = [...(execution?.modelCalls || []), ...(execution?.sessions || []), ...(execution?.omoSessions || [])]
      .some((call) => activeStatuses.has(call.status))
      || (execution?.reviewRounds || []).some((round) => reviewerRoundHasInFlightWork(round));
    const settled = ['completed', 'failed', 'partial', 'cancelled'].includes(execution?.phase)
      || Number.isFinite(Date.parse(execution?.deadline || '')) && Date.parse(execution.deadline) <= Date.now();
    return Boolean(archived && registry?.projectId === currentBinding.projectId
      && registry?.scopeFingerprint === currentBinding.scopeFingerprint
      && settled && !hasInFlight && execution?.planInProgress !== true);
  }).map(({ id, text, goalVersionId, createdAt, binding }) => ({ id, text, goalVersionId, createdAt, binding }));
  const snapshot = {
    taskId: task.id,
    goalVersionId: task.goalVersionId,
    executionId: task.execution.id,
    registrySha256: task.registry?.registrySha256 || null,
    projectId: project.projectId,
    scopeFingerprint: project.scopeFingerprint,
    artifact: artifactBinding,
    instructions,
  };
  return { ...snapshot, sha256: sha256Text(JSON.stringify(snapshot)) };
}

function validPlanInstructionSnapshot(task, execution, snapshot, { checkArtifact = true } = {}) {
  if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.instructions)) return false;
  const { sha256, ...body } = snapshot;
  const artifact = task.artifacts?.find((item) => item.id === task.activeArtifactId) || null;
  const expectedArtifact = artifact ? { id: artifact.id, version: artifact.version, candidateSha256: artifact.candidateSha256, diffSha256: artifact.diffSha256 } : null;
  return snapshot.taskId === task.id && snapshot.goalVersionId === task.goalVersionId
    && snapshot.executionId === execution.id && snapshot.registrySha256 === task.registry?.registrySha256
    && snapshot.projectId === task.registry?.projectId && snapshot.scopeFingerprint === task.registry?.scopeFingerprint
    && task.selectedScope?.authorized === true && task.selectedScope?.projectId === snapshot.projectId
    && task.selectedScope?.scopeFingerprint === snapshot.scopeFingerprint && task.selectedScope?.goalVersionId === task.goalVersionId
    && (!checkArtifact || JSON.stringify(snapshot.artifact) === JSON.stringify(expectedArtifact))
    && /^[a-f0-9]{64}$/u.test(sha256 || '') && sha256Text(JSON.stringify(body)) === sha256;
}

function boundedCliDiagnostics(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const boundedText = (item, limit) => typeof item === 'string' ? safeFailureText(item, limit) : null;
  const executableName = (item) => typeof item === 'string' && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/u.test(item) ? item : null;
  return {
    cliPathExists: typeof value.cliPathExists === 'boolean' ? value.cliPathExists : null,
    startupCwdExists: typeof value.startupCwdExists === 'boolean' ? value.startupCwdExists : null,
    authorizedWorkspaceExists: typeof value.authorizedWorkspaceExists === 'boolean' ? value.authorizedWorkspaceExists : null,
    toolExecutionTrace: value.toolExecutionTrace === 'observed' ? 'observed' : value.toolExecutionTrace === 'not_exposed' ? 'not_exposed' : 'unknown',
    toolExecutionEventCount: Number.isSafeInteger(value.toolExecutionEventCount) && value.toolExecutionEventCount >= 0
      ? Math.min(value.toolExecutionEventCount, 100_000) : null,
    toolExecutions: Array.isArray(value.toolExecutions) ? value.toolExecutions.slice(-12).map((item) => ({
      eventType: boundedText(item?.eventType, 40),
      itemId: boundedText(item?.itemId, 80),
      toolType: item?.toolType === 'command_execution' ? item.toolType : null,
      status: boundedText(item?.status, 40),
      exitCode: Number.isSafeInteger(item?.exitCode) ? item.exitCode : null,
      errorSummary: typeof item?.errorSummary === 'string' ? 'error reported' : null,
      errorUtf8Bytes: Number.isSafeInteger(item?.errorUtf8Bytes) && item.errorUtf8Bytes >= 0
        ? Math.min(item.errorUtf8Bytes, 2_000_000) : null,
      errorSha256: typeof item?.errorSha256 === 'string' && /^[a-f0-9]{64}$/u.test(item.errorSha256) ? item.errorSha256 : null,
      cwd: typeof item?.cwd === 'string' ? '[路径已隐藏]' : null,
      cwdExists: typeof item?.cwdExists === 'boolean' ? item.cwdExists : null,
      workdir: typeof item?.workdir === 'string' ? '[路径已隐藏]' : null,
      workdirExists: typeof item?.workdirExists === 'boolean' ? item.workdirExists : null,
      shell: executableName(item?.shell),
      shellExists: typeof item?.shellExists === 'boolean' ? item.shellExists : null,
      commandExecutableHint: executableName(item?.commandExecutableHint),
      commandUtf8Bytes: Number.isSafeInteger(item?.commandUtf8Bytes) && item.commandUtf8Bytes >= 0
        ? Math.min(item.commandUtf8Bytes, 2_000_000) : null,
      commandSha256: typeof item?.commandSha256 === 'string' && /^[a-f0-9]{64}$/u.test(item.commandSha256) ? item.commandSha256 : null,
    })) : [],
  };
}

function sameCodexBinding(left, right) {
  return ['taskId', 'goalVersionId', 'executionId', 'registrySha256', 'workItemId', 'artifactId', 'artifactVersion',
    'candidateSha256', 'diffSha256', 'reviewRoundId', 'reviewRoundRequestId', 'previousReviewId', 'previousReviewRoundId', 'scopeFingerprint']
    .every((key) => (left?.[key] ?? null) === (right?.[key] ?? null));
}

function sameCodexTaskBinding(left, right) {
  const baseMatches = ['taskId', 'goalVersionId', 'executionId', 'registrySha256', 'workItemId', 'artifactId', 'candidateSha256', 'diffSha256']
    .every((key) => (left?.[key] ?? null) === (right?.[key] ?? null));
  if (!baseMatches || !(left?.reviewRoundId || right?.reviewRoundId)) return baseMatches;
  return ['artifactVersion', 'scopeFingerprint', 'previousReviewRoundId'].every((key) => (left?.[key] ?? null) === (right?.[key] ?? null));
}

function currentBindingFailure(task, binding) {
  if (task?.id !== binding?.taskId) return 'task_id_changed';
  if (task.goalVersionId !== binding.goalVersionId) return 'goal_version_changed';
  if (task.execution?.id !== binding.executionId) return 'execution_id_changed';
  if (task.registry?.registrySha256 !== binding.registrySha256) return 'registry_changed';
  if (task.registry.current === false || task.registry.bindingCurrent === false || task.registry.status === 'stale') return 'registry_inactive';
  if (binding.reviewRoundId) {
    const round = task.execution?.reviewRounds?.find((item) => item.id === binding.reviewRoundId);
    if (!round || !['open', 'running'].includes(round.status)
      || round.binding?.taskId !== binding.taskId || round.binding?.goalVersionId !== binding.goalVersionId
      || round.binding?.executionId !== binding.executionId || round.binding?.registrySha256 !== binding.registrySha256
      || round.binding?.scopeFingerprint !== task.registry?.scopeFingerprint
      || round.binding?.artifactId !== binding.artifactId || round.binding?.artifactVersion !== binding.artifactVersion
      || round.binding?.candidateSha256 !== binding.candidateSha256 || round.binding?.diffSha256 !== binding.diffSha256
      || round.binding?.previousReviewId !== (binding.previousReviewId || null)
      || (round.binding?.previousReviewRoundId || null) !== (binding.previousReviewRoundId || null)
      || round.binding?.requestId !== binding.reviewRoundRequestId
      || ['cancelled', 'canceled'].includes(String(task.execution?.phase || '').toLowerCase())
      || ['cancelled', 'canceled'].includes(String(task.execution?.status || '').toLowerCase())) return 'review_round_stale';
    const currentArtifact = task.artifacts?.find((item) => item.id === binding.artifactId);
    const roundsForArtifact = task.execution.reviewRounds.filter((item) => item.binding?.artifactId === binding.artifactId);
    const roundIndex = roundsForArtifact.findIndex((item) => item.id === round.id);
    const actualPreviousRoundId = roundIndex > 0 ? roundsForArtifact[roundIndex - 1].id : null;
    if (!currentArtifact || task.activeArtifactId !== binding.artifactId
      || currentArtifact.version !== binding.artifactVersion
      || (currentArtifact.review?.id || null) !== (binding.previousReviewId || null)
      || roundIndex < 0 || actualPreviousRoundId !== (binding.previousReviewRoundId || null)) return 'review_round_stale';
    if (!Number.isFinite(Date.parse(round.deadlineAt)) || Date.parse(round.deadlineAt) <= Date.now()) return 'review_round_expired';
  }
  if (task.selectedScope && (task.selectedScope.current === false || task.selectedScope.authorized === false
    || task.selectedScope.projectId !== task.registry.projectId
    || task.selectedScope.scopeFingerprint !== task.registry.scopeFingerprint
    || task.selectedScope.goalVersionId !== binding.goalVersionId)) return 'scope_binding_changed';
  if (task.execution.bindingCurrent === false) return 'execution_binding_invalidated';
  if (binding.artifactId) {
    const storedArtifact = task.artifacts?.find((item) => item.id === binding.artifactId);
    const pendingCandidate = task.execution.pendingCandidateBinding?.artifactId === binding.artifactId
      ? task.execution.pendingCandidateBinding : null;
    const artifact = storedArtifact || pendingCandidate;
    if (!artifact || artifact.goalVersionId !== binding.goalVersionId || artifact.executionId !== binding.executionId
      || artifact.registrySha256 !== binding.registrySha256 || artifact.candidateSha256 !== binding.candidateSha256
      || artifact.diffSha256 !== binding.diffSha256
      || storedArtifact && (storedArtifact.patchSha256 !== binding.diffSha256
        || sha256Text(storedArtifact.patch || '') !== binding.diffSha256)
      || artifact.confirmation) return 'candidate_binding_changed';
  }
  return null;
}

function executionForBinding(task, binding) {
  if (task.execution?.id === binding.executionId) {
    return { execution: task.execution, current: true };
  }
  const archived = task.executionHistory?.find((entry) => entry.execution?.id === binding.executionId
    && entry.registry?.registrySha256 === binding.registrySha256);
  return archived ? { execution: archived.execution, current: false } : null;
}

function bindingFailureMessage(reason) {
  const labels = {
    task_id_changed: '任务身份已变化', goal_version_changed: '目标版本已变化',
    execution_id_changed: '执行身份已变化', registry_changed: '产品登记已变化',
    execution_binding_invalidated: '执行绑定已失效', candidate_binding_changed: '候选版本绑定已变化',
    call_binding_changed: '角色调用绑定已变化', review_round_stale: '后续审阅授权已失效', review_round_expired: '后续审阅授权已过期',
    registry_inactive: '产品登记已失效', scope_binding_changed: '授权范围已变化',
  };
  return `角色回执已保留但未采纳：${labels[reason] || '当前绑定不再匹配'}。`;
}

function snapshotTaskBinding(task, workItemId, artifact = null) {
  return {
    taskId: task.id, goalVersionId: task.goalVersionId, executionId: task.execution.id,
    registrySha256: task.registry.registrySha256, workItemId,
    artifactId: artifact?.id || null, artifactVersion: artifact?.version ?? null,
    candidateSha256: artifact?.candidateSha256 || null, diffSha256: artifact?.diffSha256 || null,
    scopeFingerprint: task.registry?.scopeFingerprint || null,
  };
}

function roleLedgerForBinding(task, binding) {
  const bound = executionForBinding(task, binding);
  if (!bound || !binding.reviewRoundId && !bound.current) return null;
  if (!binding.reviewRoundId) return bound.execution;
  return bound.execution.reviewRounds?.find((round) => round.id === binding.reviewRoundId) || null;
}

function deadlineForBinding(task, binding) {
  if (binding?.reviewRoundId) {
    return task.execution?.reviewRounds?.find((round) => round.id === binding.reviewRoundId)?.deadlineAt || null;
  }
  return task.execution?.deadline || null;
}

function candidateSha256ForFiles(filesMap) {
  return sha256Text(Object.values(filesMap)
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((file) => `${file.path}:${file.sha256}`)
    .join('|'));
}

function hasToolExecutionFailure(call) {
  return Boolean(call?.cliDiagnostics?.toolExecutions?.some((item) => item.status === 'failed'
    || Number.isInteger(item.exitCode) && item.exitCode !== 0
    || typeof item.errorSummary === 'string'
    || Number.isInteger(item.errorUtf8Bytes) && item.errorUtf8Bytes > 0));
}

function executionIsStopped(execution) {
  const terminal = (value) => ['cancelled', 'canceled', 'stopped'].includes(String(value || '').toLowerCase());
  return Boolean(execution?.stopReason || terminal(execution?.phase) || terminal(execution?.status));
}

function executionIsCancelled(execution) {
  const terminal = (value) => ['cancelled', 'canceled'].includes(String(value || '').toLowerCase());
  return terminal(execution?.phase) || terminal(execution?.status) || /cancel/iu.test(execution?.stopReason || '');
}

function hasFailedHostChecks(artifact) {
  return artifact?.hostCheck?.passed === false && Array.isArray(artifact.hostCheck.checks)
    && artifact.hostCheck.checks.length > 0 && artifact.hostCheck.checks.some((check) => check?.passed === false);
}

function hasUniqueCandidateManifest(artifact) {
  const manifest = artifact?.files;
  if (!Array.isArray(manifest) || !manifest.length) return false;
  const paths = manifest.map((file) => file?.path);
  return paths.every((relPath) => typeof relPath === 'string' && relPath.length > 0)
    && new Set(paths).size === paths.length;
}

function candidateFilesMatchManifest(artifact, filesMap) {
  const manifest = artifact?.files;
  if (!hasUniqueCandidateManifest(artifact)) return false;
  const manifestPaths = manifest.map((file) => file.path).sort();
  const actualPaths = Object.keys(filesMap).sort();
  if (manifestPaths.length !== actualPaths.length
    || manifestPaths.some((relPath, index) => relPath !== actualPaths[index])) return false;
  return manifest.every((file) => {
    const actual = Object.hasOwn(filesMap, file.path) ? filesMap[file.path] : null;
    return actual && Number.isInteger(file.bytes) && file.bytes >= 0
      && /^[a-f0-9]{64}$/u.test(file.sha256 || '')
      && actual.bytes === file.bytes && actual.sha256 === file.sha256;
  }) && candidateSha256ForFiles(filesMap) === artifact.candidateSha256;
}

function sameCandidateFileSnapshot(left, right) {
  const leftPaths = Object.keys(left).sort();
  const rightPaths = Object.keys(right).sort();
  return leftPaths.length === rightPaths.length
    && leftPaths.every((relPath, index) => relPath === rightPaths[index]
      && left[relPath].bytes === right[relPath].bytes
      && left[relPath].sha256 === right[relPath].sha256);
}

function canContinueRejectedCandidate(task, artifact = task?.artifacts?.find((item) => item.id === task?.activeArtifactId)) {
  const execution = task?.execution;
  const revision = execution?.pendingRevision;
  const scope = task?.selectedScope;
  const registry = task?.registry;
  const calls = execution?.modelCalls || [];
  const developer = calls.at(-1);
  return Boolean(revision?.status === 'accepted' && artifact && !artifact.confirmation
    && artifact.goalVersionId === task.goalVersionId && artifact.executionId === execution.id
    && artifact.registrySha256 === registry?.registrySha256
    && revision.sourceArtifactId === artifact.id && revision.sourceCandidateSha256 === artifact.candidateSha256
    && revision.sourceArtifactVersion === artifact.version && hasUniqueCandidateManifest(artifact)
    && revision.goalVersionId === task.goalVersionId && revision.executionId === execution.id
    && revision.registrySha256 === registry?.registrySha256 && revision.scopeFingerprint === registry?.scopeFingerprint
    && execution.phase === 'partial' && execution.planApprovalStatus === 'saved' && execution.plan
    && execution.bindingCurrent !== false && !executionIsStopped(execution)
    && Number.isFinite(Date.parse(execution.deadline)) && Date.parse(execution.deadline) > Date.now()
    && calls.length < 8 && !calls.some((call) => ['reserved', 'running', 'started', 'in_progress', 'working'].includes(call.status))
    && calls.every((call) => call.status === 'completed' && call.outcome === 'model_returned')
    && developer?.role === 'Developer' && developer.cliSpawned === true && developer.turnStarted === true
    && !calls.some(hasToolExecutionFailure)
    && hasFailedHostChecks(artifact)
    && !calls.some((call) => call.role === 'Reviewer' && call.binding?.artifactId === artifact.id
      && call.binding?.candidateSha256 === artifact.candidateSha256)
    && scope?.authorized === true && scope.current !== false && scope.projectId === registry?.projectId
    && scope.scopeFingerprint === registry?.scopeFingerprint && scope.goalVersionId === task.goalVersionId
    && registry?.current !== false && registry?.bindingCurrent !== false && registry?.status !== 'stale');
}

function canStartRevisionDeveloper(task, artifact, revision) {
  const execution = task?.execution;
  const scope = task?.selectedScope;
  const registry = task?.registry;
  const calls = execution?.modelCalls || [];
  return Boolean(revision?.status === 'running' && execution?.pendingRevision?.id === revision.id
    && artifact && artifact.id === revision.sourceArtifactId && artifact.version === revision.sourceArtifactVersion
    && artifact.candidateSha256 === revision.sourceCandidateSha256 && artifact.goalVersionId === revision.goalVersionId
    && artifact.executionId === revision.executionId && artifact.registrySha256 === revision.registrySha256
    && !artifact.confirmation && hasUniqueCandidateManifest(artifact)
    && task.goalVersionId === revision.goalVersionId && execution.id === revision.executionId
    && registry?.registrySha256 === revision.registrySha256 && registry?.scopeFingerprint === revision.scopeFingerprint
    && registry?.current !== false && registry?.bindingCurrent !== false && registry?.status !== 'stale'
    && scope?.authorized === true && scope.current !== false && scope.goalVersionId === revision.goalVersionId
    && scope.projectId === registry.projectId && scope.scopeFingerprint === revision.scopeFingerprint
    && execution.phase === 'executing' && execution.status === 'running'
    && execution.planApprovalStatus === 'saved' && execution.plan && execution.bindingCurrent !== false
    && !executionIsStopped(execution) && Number.isFinite(Date.parse(execution.deadline)) && Date.parse(execution.deadline) > Date.now()
    && calls.length < 8 && !calls.some((call) => ['reserved', 'running', 'started', 'in_progress', 'working'].includes(call.status))
    && calls.every((call) => call.status === 'completed' && call.outcome === 'model_returned')
    && calls.at(-1)?.role === 'Developer' && calls.at(-1)?.cliSpawned === true && calls.at(-1)?.turnStarted === true
    && !calls.some(hasToolExecutionFailure) && hasFailedHostChecks(artifact)
    && !calls.some((call) => call.role === 'Reviewer' && call.binding?.artifactId === artifact.id
      && call.binding?.candidateSha256 === artifact.candidateSha256));
}

async function readVerifiedCandidateFiles(artifact, worktreesDir, taskId, executionId) {
  const taskRoot = path.resolve(worktreesDir, taskId);
  const sourceRoot = path.resolve(artifact?.worktreePath || '');
  const relativeRoot = path.relative(taskRoot, sourceRoot);
  const parts = relativeRoot.split(path.sep);
  const isInitialWorktree = parts.length === 1 && parts[0] === executionId;
  const isRevisionWorktree = parts.length === 2 && parts[0] === `${executionId}-revisions`
    && /^revision-omo-[a-f0-9-]{36}$/u.test(parts[1]);
  if (!artifact || !sourceRoot || path.isAbsolute(relativeRoot) || (!isInitialWorktree && !isRevisionWorktree)) {
    throw Object.assign(new Error('退回候选的原始工作树不属于当前执行，未启动续改。'), { statusCode: 409, code: 'REVISION_SOURCE_STALE' });
  }
  const filesMap = await readRelativeFileMap(sourceRoot);
  if (!candidateFilesMatchManifest(artifact, filesMap)) {
    throw Object.assign(new Error('退回候选的完整文件与已保存版本不一致，未启动续改。'), { statusCode: 409, code: 'REVISION_SOURCE_CHANGED' });
  }
  for (const relPath of Object.keys(filesMap)) {
    const buffer = await fsp.readFile(path.join(sourceRoot, ...relPath.split('/')));
    const file = filesMap[relPath];
    if (buffer.length !== file.bytes || sha256Buffer(buffer) !== file.sha256) {
      throw Object.assign(new Error('退回候选在读取期间发生变化，未启动续改。'), { statusCode: 409, code: 'REVISION_SOURCE_CHANGED' });
    }
    file.buffer = buffer;
    file.content = buffer.toString('utf8');
  }
  const sourceAfterRead = await readRelativeFileMap(sourceRoot);
  if (!candidateFilesMatchManifest(artifact, sourceAfterRead)
    || !sameCandidateFileSnapshot(filesMap, sourceAfterRead)) {
    throw Object.assign(new Error('退回候选在读取期间发生变化，未启动续改。'), { statusCode: 409, code: 'REVISION_SOURCE_CHANGED' });
  }
  return filesMap;
}

function reviewerSourceEvidence(task, artifact, reviewResult) {
  if (!/^[a-f0-9]{64}$/u.test(reviewResult?.fullOutputSha256 || '')
    || !/^[a-f0-9]{64}$/u.test(artifact?.diffSha256 || '')) return null;
  if (reviewResult.sourceSessionId && Array.isArray(reviewResult.sourceCallIds)
    && reviewResult.sourceCallIds.length && reviewResult.sourceSessionOutputSha256 === reviewResult.fullOutputSha256) {
    return {
      taskId: task.id, goalVersionId: artifact.goalVersionId, executionId: artifact.executionId,
      registrySha256: artifact.registrySha256, artifactId: artifact.id, artifactVersion: artifact.version,
      scopeFingerprint: task.selectedScope?.scopeFingerprint || task.registry?.scopeFingerprint || null,
      candidateSha256: artifact.candidateSha256, diffSha256: artifact.diffSha256, sourceSessionId: reviewResult.sourceSessionId,
      sourceCallIds: reviewResult.sourceCallIds, reportSha256: reviewResult.fullOutputSha256,
      ...(reviewResult.reviewRoundId ? { reviewRoundId: reviewResult.reviewRoundId } : {}),
    };
  }
  if (!reviewResult?.sourceCallId || !/^[a-f0-9]{64}$/u.test(reviewResult.sourceCallOutputSha256 || '')) return null;
  return {
    taskId: task.id, goalVersionId: artifact.goalVersionId, executionId: artifact.executionId,
    registrySha256: artifact.registrySha256, artifactId: artifact.id, artifactVersion: artifact.version,
    scopeFingerprint: task.selectedScope?.scopeFingerprint || task.registry?.scopeFingerprint || null,
    candidateSha256: artifact.candidateSha256, diffSha256: artifact.diffSha256, sourceCallId: reviewResult.sourceCallId,
    sourceCallOutputSha256: reviewResult.sourceCallOutputSha256, reportSha256: reviewResult.fullOutputSha256,
    ...(reviewResult.reviewRoundId ? { reviewRoundId: reviewResult.reviewRoundId } : {}),
  };
}

function hasBoundReviewerSource(task, artifact, review) {
  const source = review?.sourceEvidence;
  const round = source?.reviewRoundId
    ? task.execution?.reviewRounds?.find((item) => item.id === source.reviewRoundId) : null;
  const executionLedger = round || task.execution;
  if (source?.reviewRoundId && (!round || round.status !== 'completed'
    || round.binding?.taskId !== source.taskId || round.binding?.goalVersionId !== source.goalVersionId
    || round.binding?.executionId !== source.executionId || round.binding?.registrySha256 !== source.registrySha256
    || round.binding?.scopeFingerprint !== source.scopeFingerprint || round.binding?.artifactId !== source.artifactId
    || round.binding?.artifactVersion !== source.artifactVersion || round.binding?.candidateSha256 !== source.candidateSha256
    || round.binding?.diffSha256 !== source.diffSha256 || round.binding?.previousReviewId !== (round.expectedReviewId || null))) return false;
  if (!source || source.taskId !== task.id || source.goalVersionId !== task.goalVersionId
    || source.executionId !== task.execution?.id || source.registrySha256 !== task.registry?.registrySha256
    || source.scopeFingerprint !== task.registry?.scopeFingerprint
    || task.selectedScope && (task.selectedScope.current === false || task.selectedScope.authorized === false
      || task.selectedScope.goalVersionId !== task.goalVersionId || task.selectedScope.projectId !== task.registry?.projectId
      || task.selectedScope.scopeFingerprint !== source.scopeFingerprint)
    || source.artifactId !== artifact.id || source.artifactVersion !== artifact.version
    || source.candidateSha256 !== artifact.candidateSha256 || source.diffSha256 !== artifact.diffSha256
    || !/^[a-f0-9]{64}$/u.test(artifact.diffSha256 || '') || artifact.patchSha256 !== artifact.diffSha256
    || sha256Text(artifact.patch || '') !== artifact.diffSha256
    || source.reportSha256 !== review.fullOutputSha256) return false;
  if (source.sourceSessionId) {
    const session = executionLedger?.omoSessions?.find((item) => item.id === source.sourceSessionId);
    const boundCalls = source.sourceCallIds?.map((id) => executionLedger?.modelCalls?.find((item) => item.id === id));
    return Boolean(session && session.role === 'Reviewer' && session.phase === 'review'
      && session.status === 'model_returned' && session.binding?.taskId === source.taskId
      && session.binding?.goalVersionId === source.goalVersionId && session.binding?.executionId === source.executionId
      && session.binding?.registrySha256 === source.registrySha256 && session.binding?.artifactId === source.artifactId
      && session.binding?.candidateSha256 === source.candidateSha256
      && session.binding?.diffSha256 === source.diffSha256
      && (source.reviewRoundId ? session.binding?.previousReviewId === round.expectedReviewId
        && session.binding?.reviewRoundRequestId === round.requestId : !session.binding?.reviewRoundId)
      && (source.reviewRoundId ? session.binding?.reviewRoundId === source.reviewRoundId : !session.binding?.reviewRoundId)
      && session.finalOutputSha256 === source.reportSha256 && session.outputSha256 === source.reportSha256
      && session.reviewAdoption?.reviewId === review.id && session.reviewAdoption?.reportSha256 === source.reportSha256
      && session.reviewAdoption?.diffSha256 === source.diffSha256
      && Array.isArray(session.sourceCallIds) && session.sourceCallIds.length === source.sourceCallIds.length
      && session.sourceCallIds.every((id, index) => id === source.sourceCallIds[index])
      && source.sourceCallIds.length > 0
      && boundCalls.every((call) => call && call.role === 'Reviewer' && call.status === 'completed'
        && call.outcome === 'model_returned' && call.cliSpawned === true && call.turnStarted === true
        && call.binding?.artifactId === source.artifactId && call.binding?.candidateSha256 === source.candidateSha256
        && call.binding?.diffSha256 === source.diffSha256
        && (source.reviewRoundId ? call.binding?.reviewRoundId === source.reviewRoundId : !call.binding?.reviewRoundId))
      && sha256Text(review.text?.trim() || '') === review.fullOutputSha256);
  }
  const call = executionLedger?.modelCalls?.find((item) => item.id === source.sourceCallId);
  const binding = call?.binding;
  return Boolean(call && call.role === 'Reviewer' && call.status === 'completed' && call.outcome === 'model_returned'
    && call.cliSpawned === true && call.turnStarted === true
    && binding?.taskId === source.taskId && binding.goalVersionId === source.goalVersionId
    && binding.executionId === source.executionId && binding.registrySha256 === source.registrySha256
    && (source.reviewRoundId ? binding.reviewRoundId === source.reviewRoundId : !binding.reviewRoundId)
    && binding.artifactId === source.artifactId && binding.candidateSha256 === source.candidateSha256
    && binding.diffSha256 === source.diffSha256
    && call.reviewAdoption?.reviewId === review.id && call.reviewAdoption?.reportSha256 === source.reportSha256
    && call.reviewAdoption?.diffSha256 === source.diffSha256
    && typeof binding.workItemId === 'string' && call.idempotencyKey === `${binding.executionId}:${binding.workItemId}:review:${call.promptSha256}`
    && /^[a-f0-9]{64}$/u.test(call.promptSha256 || '')
    && call.output?.text?.trim() === review.text?.trim()
    && call.outputSha256 === source.sourceCallOutputSha256
    && call.outputSha256 === sha256Text(JSON.stringify(call.output))
    && sha256Text(review.text?.trim() || '') === review.fullOutputSha256);
}

function settledReviewerFailureForArtifact(task, artifact, hasReviewerSource) {
  const execution = task.execution;
  const registry = task.registry;
  const continuation = execution?.reviewContinuation;
  const review = artifact?.review;
  if (!task || !execution || !registry || !artifact || !review || hasReviewerSource
    || review.nativeVerdict !== 'UNVERIFIED' || execution.phase !== 'partial'
    || continuation?.status !== 'blocked_or_failed'
    || artifact.goalVersionId !== task.goalVersionId || artifact.executionId !== execution.id
    || artifact.registrySha256 !== registry.registrySha256
    || continuation.artifactId !== artifact.id || continuation.artifactVersion !== artifact.version
    || continuation.candidateSha256 !== artifact.candidateSha256) return false;

  const activeStatuses = new Set(['reserved', 'running', 'started', 'in_progress', 'working']);
  const hasActiveBusinessCall = (execution.modelCalls || []).some((call) => call.role !== 'Chat' && activeStatuses.has(call.status));
  const hasActiveBusinessSession = (execution.sessions || []).some((session) => session.role !== 'Chat' && activeStatuses.has(session.status));
  if (hasActiveBusinessCall || hasActiveBusinessSession) return false;

  const boundFailedReviewerCall = (execution.modelCalls || []).find((call) => call.role === 'Reviewer'
    && call.status === 'failed'
    && call.binding?.taskId === task.id
    && call.binding?.goalVersionId === task.goalVersionId
    && call.binding?.executionId === execution.id
    && call.binding?.registrySha256 === registry.registrySha256
    && call.binding?.artifactId === artifact.id
    && call.binding?.candidateSha256 === artifact.candidateSha256
    && call.binding?.diffSha256 === artifact.diffSha256);
  if (!boundFailedReviewerCall) return false;
  const failedReviewerDispatch = (execution.sessions || []).some((session) => session.role === 'Reviewer'
    && ['review', 'review:provider-decision'].includes(session.phase) && session.status === 'failed'
    && session.modelCallId === boundFailedReviewerCall.id
    && session.eventId === continuation.dispatchEventId);
  return failedReviewerDispatch;
}

function completedBoundReviewerFailureForArtifact(task, artifact, hasReviewerSource) {
  const execution = task?.execution;
  const review = artifact?.review;
  const source = review?.sourceEvidence;
  if (!execution || !artifact || !hasReviewerSource || review?.nativeVerdict !== 'FAIL'
    || review.passed !== false || review.scopeOutcome !== 'findings' || !source?.reviewRoundId) return false;
  const round = (execution.reviewRounds || []).find((item) => item.id === source.reviewRoundId);
  if (!round || round.status !== 'completed' || round.binding?.artifactId !== artifact.id
    || round.binding?.artifactVersion !== artifact.version || round.binding?.candidateSha256 !== artifact.candidateSha256
    || round.binding?.diffSha256 !== artifact.diffSha256 || round.binding?.taskId !== task.id
    || round.binding?.goalVersionId !== task.goalVersionId || round.binding?.executionId !== execution.id
    || round.binding?.registrySha256 !== task.registry?.registrySha256
    || round.binding?.scopeFingerprint !== task.registry?.scopeFingerprint) return false;
  if (reviewerRoundHasInFlightWork(round)) return false;
  const activeStatuses = new Set(['reserved', 'running', 'started', 'in_progress', 'working']);
  if ((execution.modelCalls || []).some((call) => call.role !== 'Chat' && activeStatuses.has(call.status))) return false;
  if ([...(execution.sessions || []), ...(execution.omoSessions || [])]
    .some((session) => session.role !== 'Chat' && activeStatuses.has(session.status))) return false;
  return true;
}

function reviewerRoundHasInFlightWork(round) {
  const activeStatuses = new Set(['reserved', 'running', 'started', 'in_progress', 'working']);
  return [...(round?.modelCalls || []), ...(round?.sessions || []), ...(round?.omoSessions || [])]
    .some((item) => activeStatuses.has(item.status));
}

function markReviewerCallAdopted(task, artifact, review) {
  const source = review?.sourceEvidence;
  if (!source || source.diffSha256 !== artifact.diffSha256) return false;
  const ledger = source.reviewRoundId
    ? task.execution?.reviewRounds?.find((item) => item.id === source.reviewRoundId) : task.execution;
  if (!ledger) return false;
  if (source.sourceSessionId) {
    const session = ledger.omoSessions?.find((item) => item.id === source.sourceSessionId);
    if (!session) return false;
    session.reviewAdoption = { reviewId: review.id, reviewedAt: review.reviewedAt,
      reportSha256: review.fullOutputSha256, diffSha256: artifact.diffSha256 };
    return hasBoundReviewerSource(task, artifact, review);
  }
  const call = ledger.modelCalls?.find((item) => item.id === source.sourceCallId);
  if (!call) return false;
  call.reviewAdoption = {
    reviewId: review.id, reviewedAt: review.reviewedAt, reportSha256: review.fullOutputSha256,
    diffSha256: artifact.diffSha256,
  };
  return hasBoundReviewerSource(task, artifact, review);
}

function assertCurrentTaskBinding(task, binding) {
  const reason = currentBindingFailure(task, binding);
  if (reason) {
    const error = new Error(bindingFailureMessage(reason));
    error.code = 'STALE_ROLE_BINDING';
    throw error;
  }
}

/**
 * Creates a standard PKZIP buffer from a list of `{ name, data }` entries using Node's built-in zlib.
 */
function createZipBuffer(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const rawBuf = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data ?? ''), 'utf8');
    const compressedBuf = zlib.deflateRawSync(rawBuf);
    const crc = crc32(rawBuf);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0x0800, 6); // UTF-8 flag
    localHeader.writeUInt16LE(8, 8); // deflate
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressedBuf.length, 18);
    localHeader.writeUInt32LE(rawBuf.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuf, compressedBuf);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressedBuf.length, 20);
    centralHeader.writeUInt32LE(rawBuf.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + compressedBuf.length;
  }

  const centralBuffer = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralBuffer, eocd]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export class OmoPilotController {
  constructor({
    runtimeDir = PILOT_RUNTIME_DIR,
    preferLocalFallback = process.env.OMO_PILOT_MODE === 'deterministic',
    codexRoleRunner = runCodexRole,
    omoRoleRunner = runOmoNativeRpcRole,
    hostChecksRunner = runHostChecks,
    developerRunner = executeDeveloperInWorktree,
  } = {}) {
    this.runtimeDir = runtimeDir;
    this.stateFile = path.join(runtimeDir, 'pilot-ledger.json');
    this.worktreesDir = path.join(runtimeDir, 'worktrees');
    this.customProjectsDir = path.join(runtimeDir, 'projects');
    this.deliveriesDir = path.join(runtimeDir, 'deliveries');
    this.preferLocalFallback = preferLocalFallback;
    this.codexRoleRunner = codexRoleRunner;
    this.omoRoleRunner = omoRoleRunner;
    this.hostChecksRunner = hostChecksRunner;
    this.developerRunner = developerRunner;
    this.roleReservationQueue = Promise.resolve();
    this.reviewRoundOpenQueue = Promise.resolve();
    this.reviewRoundAbortControllers = new Map();
    this.saveQueue = Promise.resolve();
    this.instructionQueues = new Map();
    this.confirming = new Set();
    this.previewTokens = new Map();
    this.state = {
      activeTaskId: null,
      activeTaskRevision: 1,
      customProjects: [],
      tasks: [],
    };
  }

  modelStatus() {
    const runtime = resolveCodexRuntime();
    const executableAvailable = fs.existsSync(runtime.executable);
    return {
      state: executableAvailable ? 'codex_cli_auth_unverified' : 'codex_cli_missing',
      requiredModel: CODEX_ROLE_MODEL,
      modelRegistered: executableAvailable,
      connectionStatus: 'unverified',
      liveExecutionBlocked: !executableAvailable,
      configuredModel: CODEX_ROLE_MODEL,
      configuredProvider: 'Codex CLI',
      message: executableAvailable
        ? `Codex CLI 可用，固定模型为 ${CODEX_ROLE_MODEL}；本机登录状态未通过探测。用户启动的角色调用将单独记账，若认证失败会保留失败记录。`
        : `未找到 Codex CLI，无法启动固定模型 ${CODEX_ROLE_MODEL}。`,
    };
  }

  aiEnabled() {
    return this.preferLocalFallback || fs.existsSync(resolveCodexRuntime().executable);
  }

  async init() {
    await fsp.mkdir(this.runtimeDir, { recursive: true });
    await fsp.mkdir(this.worktreesDir, { recursive: true });
    await fsp.mkdir(this.customProjectsDir, { recursive: true });
    await fsp.mkdir(this.deliveriesDir, { recursive: true });

    if (fs.existsSync(this.stateFile)) {
      try {
        const loaded = JSON.parse(await fsp.readFile(this.stateFile, 'utf8'));
        if (loaded && typeof loaded === 'object') {
          this.state = {
            activeTaskId: loaded.activeTaskId || null,
            activeTaskRevision: Number.isSafeInteger(loaded.activeTaskRevision) ? loaded.activeTaskRevision : 1,
            customProjects: Array.isArray(loaded.customProjects) ? loaded.customProjects : [],
            tasks: Array.isArray(loaded.tasks) ? loaded.tasks : [],
          };
        }
      } catch {
        // start fresh if corrupted
      }
    }

    // Rehydrate preview tokens for existing candidates
    for (const task of this.state.tasks) {
      if (task.preview?.token && task.preview?.worktreePath) {
        this.previewTokens.set(task.preview.token, {
          taskId: task.id,
          worktreePath: task.preview.worktreePath,
        });
      }
    }
    await this.save();
  }

  async persistMutation(mutateSnapshot, commit) {
    const write = this.saveQueue.then(async () => {
      const snapshot = structuredClone(this.state);
      mutateSnapshot(snapshot);
      const serialized = JSON.stringify(snapshot, null, 2);
      const temporary = `${this.stateFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
      await fsp.writeFile(temporary, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await fsp.rename(temporary, this.stateFile);
      commit?.();
    });
    this.saveQueue = write.catch(() => {});
    await write;
  }

  async save() {
    const write = this.saveQueue.then(async () => {
      const serialized = JSON.stringify(this.state, null, 2);
      const temporary = `${this.stateFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
      await fsp.writeFile(temporary, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await fsp.rename(temporary, this.stateFile);
    });
    this.saveQueue = write.catch(() => {});
    await write;
  }

  async saveTaskInstruction(task, payload) {
    const previous = this.instructionQueues.get(task.id) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const tail = previous.catch(() => {}).then(() => current);
    this.instructionQueues.set(task.id, tail);
    await previous.catch(() => {});
    try {
      const text = String(payload.text || '').trim();
      if (!text) throw new Error('补充要求不能为空。');
      const requestId = String(payload.requestId || '');
      if (!/^[A-Za-z0-9_-]{12,128}$/u.test(requestId)) {
        throw Object.assign(new Error('保存工作交代需要稳定的请求编号。'), { statusCode: 400, code: 'INSTRUCTION_REQUEST_ID_REQUIRED' });
      }
      const activeArtifact = this.getActiveArtifact(task);
      const expected = {
        taskId: task.id,
        goalVersionId: task.goalVersionId,
        projectId: task.registry?.projectId || task.selectedScope?.projectId || null,
        scopeFingerprint: task.registry?.scopeFingerprint || task.selectedScope?.scopeFingerprint || null,
        executionId: task.execution?.id || null,
        registrySha256: task.registry?.registrySha256 || null,
        artifactId: activeArtifact?.id || null,
        artifactVersion: activeArtifact?.version ?? null,
        candidateSha256: activeArtifact?.candidateSha256 || null,
        diffSha256: activeArtifact?.diffSha256 || activeArtifact?.patchSha256 || null,
      };
      const actual = {
        taskId: payload.expectedTaskId,
        goalVersionId: payload.expectedGoalVersionId,
        projectId: payload.expectedProjectId,
        scopeFingerprint: payload.expectedScopeFingerprint,
        executionId: payload.expectedExecutionId,
        registrySha256: payload.expectedRegistrySha256,
        artifactId: payload.expectedArtifactId,
        artifactVersion: payload.expectedArtifactVersion,
        candidateSha256: payload.expectedCandidateSha256,
        diffSha256: payload.expectedDiffSha256,
      };
      const expectedFields = ['taskId', 'goalVersionId', 'projectId', 'scopeFingerprint', 'executionId', 'registrySha256', 'artifactId', 'artifactVersion', 'candidateSha256', 'diffSha256'];
      if (expectedFields.some((key) => !Object.hasOwn(payload, `expected${key[0].toUpperCase()}${key.slice(1)}`))
        || JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw Object.assign(new Error('任务或候选已变化，请刷新后重新保存。'), { statusCode: 409, code: 'INSTRUCTION_BINDING_STALE' });
      }
      const inFlight = (task.execution?.modelCalls || []).some((call) => ['reserved', 'running', 'started', 'in_progress', 'working'].includes(call.status))
        || (task.execution?.sessions || []).some((session) => ['reserved', 'running', 'started', 'in_progress', 'working'].includes(session.status))
        || (task.execution?.omoSessions || []).some((session) => session.role !== 'Chat' && ['reserved', 'running', 'started', 'in_progress', 'working'].includes(session.status))
        || (task.execution?.reviewRounds || []).some((round) => reviewerRoundHasInFlightWork(round));
      if (inFlight || task.execution?.planInProgress) {
        throw Object.assign(new Error('当前任务仍有模型工作在途；工作交代尚未保存，请等待本次调用结清。'), { statusCode: 409, code: 'INSTRUCTION_TASK_BUSY' });
      }
      const fingerprint = sha256Text(JSON.stringify({ ...expected, text }));
      const requests = task.instructionRequests || {};
      const prior = requests[requestId];
      if (prior) {
        if (prior.fingerprint !== fingerprint) {
          throw Object.assign(new Error('请求编号已用于不同的工作交代。'), { statusCode: 409, code: 'INSTRUCTION_REQUEST_CONFLICT' });
        }
        const saved = (task.instructions || []).find((item) => item.id === prior.instructionId);
        if (!saved) throw Object.assign(new Error('工作交代记录不完整，请刷新任务状态。'), { statusCode: 409, code: 'INSTRUCTION_RECORD_MISSING' });
        return { ok: true, instructionId: saved.id, idempotentReplay: true };
      }
      const instruction = { id: `inst-${crypto.randomUUID().slice(0, 8)}`, requestId, text, goalVersionId: task.goalVersionId,
        binding: expected, createdAt: nowIso() };
      await this.persistMutation((snapshot) => {
        const snapshotTask = snapshot.tasks.find((item) => item.id === task.id);
        snapshotTask.instructions = [...(snapshotTask.instructions || []), instruction];
        snapshotTask.instructionRequests = { ...snapshotTask.instructionRequests, [requestId]: { fingerprint, instructionId: instruction.id } };
        snapshotTask.updatedAt = instruction.createdAt;
      }, () => {
        task.instructions = [...(task.instructions || []), instruction];
        task.instructionRequests = { ...task.instructionRequests, [requestId]: { fingerprint, instructionId: instruction.id } };
        task.updatedAt = instruction.createdAt;
      });
      return { ok: true, instructionId: instruction.id, status: 'saved_not_executed' };
    } finally {
      release();
      if (this.instructionQueues.get(task.id) === tail) this.instructionQueues.delete(task.id);
    }
  }

  async reserveCodexRoleStart(task, request) {
    const previous = this.roleReservationQueue;
    let release;
    this.roleReservationQueue = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      const execution = task.execution;
      const binding = request.binding;
      const round = binding.reviewRoundId
        ? execution?.reviewRounds?.find((item) => item.id === binding.reviewRoundId) : null;
      const ledger = round || execution;
      const deadlineAt = deadlineForBinding(task, binding);
      if (!round && execution && execution.id === binding.executionId && executionIsStopped(execution)) {
        return { created: false, reason: 'execution_stopped' };
      }
      if (!execution || execution.id !== binding.executionId || task.id !== binding.taskId
        || task.goalVersionId !== binding.goalVersionId || task.registry?.registrySha256 !== binding.registrySha256
        || currentBindingFailure(task, binding)
        || deadlineAt !== request.deadlineAt || Date.parse(deadlineAt || '') <= Date.now()) {
        return { created: false, reason: 'stale_or_expired_binding' };
      }
      if (round && (request.role !== 'Reviewer' || !['open', 'running'].includes(round.status))) {
        return { created: false, reason: 'review_round_not_active' };
      }
      if (ledger.modelCalls?.some((call) => call.idempotencyKey === request.idempotencyKey)) {
        return { created: false, reason: 'role_start_already_recorded' };
      }
      if ((ledger.modelCalls || []).length >= (round?.maxModelCalls || 8)
        || ledger.modelCalls?.some((call) => ['reserved', 'running'].includes(call.status))) {
        return { created: false, reason: 'budget_or_concurrency_limit' };
      }
      if (round) round.status = 'running';
      if (request.role === 'Lead' && execution.phase !== 'planned') return { created: false, reason: 'lead_phase_not_planned' };
      if (request.role === 'Developer') {
        if (execution.planApprovalStatus !== 'saved' || execution.phase !== 'executing') return { created: false, reason: 'developer_phase_not_approved' };
        const revision = execution.pendingRevision;
        if (revision?.status === 'running') {
          if (binding.workItemId !== revision.workItemId || binding.artifactId !== revision.sourceArtifactId
            || binding.candidateSha256 !== revision.sourceCandidateSha256 || binding.goalVersionId !== revision.goalVersionId
            || binding.registrySha256 !== revision.registrySha256) return { created: false, reason: 'revision_binding_mismatch' };
        } else if (binding.workItemId !== `work-dev-${execution.id}` || binding.artifactId || binding.candidateSha256) {
          return { created: false, reason: 'developer_work_item_not_authorized' };
        }
      }
      if (request.role === 'Reviewer') {
        const artifact = task.artifacts.find((item) => item.id === binding.artifactId)
          || (execution.pendingCandidateBinding?.artifactId === binding.artifactId ? execution.pendingCandidateBinding : null);
        if (!artifact || artifact.goalVersionId !== task.goalVersionId || artifact.executionId !== execution.id
          || artifact.registrySha256 !== task.registry.registrySha256 || artifact.candidateSha256 !== binding.candidateSha256
          || artifact.confirmation) return { created: false, reason: 'review_candidate_stale' };
      }
      const callOrdinal = (ledger.modelCalls || []).length + 1;
      const id = `call-codex-${crypto.randomUUID()}`;
      const call = {
        id, role: request.role, status: 'reserved', callOrdinal,
        reservationId: id, idempotencyKey: request.idempotencyKey,
        binding: structuredClone(binding), provider: 'Codex CLI', model: CODEX_ROLE_MODEL,
        promptSha256: request.promptSha256, promptUtf8Bytes: request.promptUtf8Bytes,
        reservedAt: nowIso(), startedAt: null, finishedAt: null,
        cliSpawned: false, turnStarted: false, providerRequestCount: null,
      };
      ledger.modelCalls ||= [];
      ledger.modelCalls.push(call);
      await this.save();
      return { created: true, id, callOrdinal, binding: structuredClone(binding) };
    } finally {
      release();
    }
  }

  async rejectStaleRoleBinding(task, binding) {
    const reason = currentBindingFailure(task, binding);
    if (!reason) return;
    const message = bindingFailureMessage(reason);
    const bound = executionForBinding(task, binding);
    if (bound) {
      const ledger = roleLedgerForBinding(task, binding) || bound.execution;
      for (const call of ledger.modelCalls || []) {
        if (!sameCodexBinding(call.binding, binding)) continue;
        call.stalePreviousStatus = call.status;
        call.status = 'failed';
        call.outcome = 'stale_binding';
        call.failureReason = message;
        call.invalidationReason = message;
        call.invalidatedAt = nowIso();
        const session = (ledger.sessions || []).find((item) => item.modelCallId === call.id);
        if (session) { session.status = 'failed'; session.finishedAt = call.invalidatedAt; }
      }
      if (binding.reviewRoundId) {
        const round = ledger;
        if (round.status === 'open' || round.status === 'running') {
          round.status = reason === 'review_round_expired' ? 'expired' : 'stale';
          round.finishedAt = nowIso();
          round.stopReason = reason;
        }
      } else if (bound.current && !binding.workItemId.startsWith('work-chat-')) {
        bound.execution.phase = 'partial';
        bound.execution.status = 'waiting_user';
        bound.execution.stopReason ||= 'stale_binding';
        bound.execution.failureReason = message;
      }
    }
    task.updatedAt = nowIso();
    await this.save();
    const error = new Error(message);
    error.code = 'STALE_ROLE_BINDING';
    throw error;
  }

  async runOmoCodexProductRole(task, { role, workItemId, phase, prompt, workspacePath = null, artifact = null, expectedBinding = null, project = null }) {
    const sessionId = `omo-${crypto.randomUUID()}`;
    const binding = expectedBinding ? structuredClone(expectedBinding) : snapshotTaskBinding(task, workItemId, artifact);
    const boundExecution = executionForBinding(task, binding);
    const staleReason = currentBindingFailure(task, binding);
    if (!boundExecution || !boundExecution.current || staleReason) {
      throw Object.assign(new Error(staleReason ? bindingFailureMessage(staleReason) : 'OmO session has no current registered execution binding.'), {
        code: 'STALE_ROLE_BINDING',
      });
    }
    let providerCalls = 0;
    const sourceCallIds = [];
    let sessionInfo = null;
    let nativeFailure = null;
    let adoptedSession = false;
    const providerAbort = new AbortController();
    if (binding.reviewRoundId) this.reviewRoundAbortControllers.set(binding.reviewRoundId, providerAbort);
    try {
      sessionInfo = await this.omoRoleRunner({
        role, prompt, cwd: workspacePath || project?.rootPath || WORKSPACE_ROOT,
        allowedWritePaths: project?.allowedWritePaths || [],
        signal: providerAbort.signal,
        timeoutMs: Math.max(1, Date.parse(deadlineForBinding(task, binding)) - Date.now()),
        runModelDecision: async (request, _ordinal, signal) => {
          providerCalls += 1;
          const modelPrompt = buildCodexDecisionPrompt(request);
          const result = await this.runCodexProductRole(task, {
            role, workItemId, phase: `${phase}:provider-decision`, prompt: modelPrompt,
            artifact, expectedBinding, workspacePath, executionMode: 'provider-decision',
            providerTools: request.tools, requiredProviderTools: nativeRoleTools(role).names, signal,
          });
          if (result.sourceCallId && !sourceCallIds.includes(result.sourceCallId)) sourceCallIds.push(result.sourceCallId);
          return result.output.text;
        },
      });
      if (sessionInfo?.status !== 'model_returned' || typeof sessionInfo.output?.text !== 'string' || !sessionInfo.output.text.trim()) {
        throw new Error('OmO native agent loop did not return a settled assistant response.');
      }
      const finalSessionId = typeof sessionInfo.sessionId === 'string' && sessionInfo.sessionId.trim()
        ? sessionInfo.sessionId : null;
      if (!finalSessionId) {
        throw Object.assign(new Error('OmO returned no native session ID; the result cannot be adopted as source evidence.'), {
          code: 'OMO_NATIVE_SESSION_ID_UNKNOWN',
        });
      }
      const adoptedResult = {
        ...sessionInfo, sessionId: finalSessionId, sourceSessionId: finalSessionId,
        sourceCallIds: [...sourceCallIds], sourceSessionOutputSha256: sha256Text(sessionInfo.output.text.trim()),
      };
      adoptedSession = true;
      return adoptedResult;
    } catch (error) {
      nativeFailure = safeFailureText(String(error?.message || error), 500) || 'OmO native role session failed.';
      throw error;
    } finally {
      providerAbort.abort();
      if (binding.reviewRoundId && this.reviewRoundAbortControllers.get(binding.reviewRoundId) === providerAbort) {
        this.reviewRoundAbortControllers.delete(binding.reviewRoundId);
      }
      const bound = executionForBinding(task, binding);
      const ledger = roleLedgerForBinding(task, binding);
      const hasNativeSessionId = typeof sessionInfo?.sessionId === 'string' && Boolean(sessionInfo.sessionId.trim());
      if (bound && ledger) {
        const sessionSourceCallIds = [...new Set([...sourceCallIds, ...(ledger.modelCalls || [])
          .filter((call) => call.role === role && call.cliSpawned === true && call.turnStarted === true
            && sameCodexBinding(call.binding, binding))
          .map((call) => call.id)])];
        ledger.omoSessions ||= [];
        ledger.omoSessions.push({
          id: hasNativeSessionId ? sessionInfo.sessionId : sessionId, hostJobId: sessionId,
          nativeSessionId: hasNativeSessionId ? sessionInfo.sessionId : null, role, phase, workItemId,
          provider: sessionInfo?.provider || 'irixi-codex-bridge', model: sessionInfo?.model || CODEX_ROLE_MODEL,
          providerDecisionRequests: providerCalls, sourceCallIds: sessionSourceCallIds,
          usageStatus: 'unknown', providerRequestCount: null, tokenUsage: null, cost: null,
          finalOutputSha256: sessionInfo?.status === 'model_returned' && typeof sessionInfo.output?.text === 'string'
            ? sha256Text(sessionInfo.output.text.trim()) : null,
          binding,
          outputSha256: sessionInfo?.status === 'model_returned' && typeof sessionInfo.output?.text === 'string'
            ? sha256Text(sessionInfo.output.text.trim()) : null,
          status: currentBindingFailure(task, binding) ? 'stale_binding' : adoptedSession ? 'model_returned' : 'failed',
          failureReason: currentBindingFailure(task, binding) ? bindingFailureMessage(currentBindingFailure(task, binding))
            : adoptedSession ? null : nativeFailure || 'OmO 原生角色会话未完成；结果未采纳。',
          runtime: sessionInfo?.runtime || null,
          settledAt: nowIso(),
        });
        const currentFailure = currentBindingFailure(task, binding);
        const nativeSessionFailed = !adoptedSession;
        if (bound.current && !binding.reviewRoundId && !currentFailure && !binding.workItemId.startsWith('work-chat-')
          && ['Lead', 'Developer', 'Senior Developer', 'Frontend Developer', 'Backend Architect', 'Rapid Prototyper', 'UI Designer', 'Product Manager'].includes(role)
          && nativeSessionFailed
          && !bound.execution.modelCalls.some((call) => ['reserved', 'running', 'started', 'in_progress', 'working'].includes(call.status))) {
          bound.execution.phase = 'partial';
          bound.execution.status = 'waiting_user';
          bound.execution.stopReason ||= 'omo_role_session_failed';
          bound.execution.failureReason = nativeFailure || 'OmO 原生角色会话未完成；没有形成可用结果。';
          const workItem = (bound.execution.workItems || []).find((item) => item.id === workItemId);
          if (workItem?.status === 'running') workItem.status = 'failed';
          const agentId = role === 'Lead' ? bound.execution.leadAgentId
            : role === 'Reviewer' ? bound.execution.reviewerAgentId : bound.execution.devAgentId;
          const agent = (bound.execution.agents || []).find((item) => item.id === agentId);
          if (agent?.status === 'running') agent.status = 'failed';
        }
        task.updatedAt = nowIso();
        await this.save();
      }
    }
  }

  async runCodexProductRole(task, { role, workItemId, phase, prompt, workspacePath = null, artifact = null, expectedBinding = null, executionMode = 'direct', providerTools = null, requiredProviderTools = [], signal = null }) {
    const execution = task.execution;
    const binding = expectedBinding ? structuredClone(expectedBinding) : snapshotTaskBinding(task, workItemId, artifact);
    if (!sameCodexTaskBinding(binding, snapshotTaskBinding(task, workItemId, artifact))) {
      await this.rejectStaleRoleBinding(task, binding);
    }
    const ledger = roleLedgerForBinding(task, binding);
    if (!ledger) throw new Error('角色调用没有对应的当前原生执行或授权审阅轮。');
    const callbackLedger = () => roleLedgerForBinding(task, binding) || (!binding.reviewRoundId ? ledger : null);
    const hostCheck = role === 'Reviewer' ? {
      passed: artifact?.hostCheck?.passed === true,
      taskId: task.id, goalVersionId: task.goalVersionId, executionId: execution.id,
      registrySha256: task.registry.registrySha256, workItemId,
      artifactId: artifact?.id || null, candidateSha256: artifact?.candidateSha256 || null,
    } : null;
    const roleInvocation = buildCodexRoleInvocation(role, prompt, executionMode);
    const promptSha256 = sha256Text(JSON.stringify(roleInvocation));
    const promptUtf8Bytes = Buffer.byteLength(roleInvocation.prompt, 'utf8')
      + Buffer.byteLength(roleInvocation.developerInstructions || '', 'utf8');
    const reservationKey = binding.reviewRoundId
      ? `${execution.id}:${binding.reviewRoundId}:${workItemId}:${phase}:${promptSha256}`
      : `${execution.id}:${workItemId}:${phase}:${promptSha256}`;
    const legacyReservationKey = binding.reviewRoundId
      ? `${execution.id}:${binding.reviewRoundId}:${workItemId}:${phase}:${sha256Text(prompt)}`
      : `${execution.id}:${workItemId}:${phase}:${sha256Text(prompt)}`;
    const existingCall = ledger.modelCalls?.find((call) => call.idempotencyKey === reservationKey
      || call.idempotencyKey === legacyReservationKey);
    if (existingCall) {
      const replayableCall = existingCall.role === role && existingCall.status === 'completed'
        && existingCall.output && sameCodexBinding(existingCall.binding, binding);
      if (replayableCall) {
        const replay = {
          status: 'model_returned', workCompleted: true, roleCallReserved: true,
          cliSpawned: existingCall.cliSpawned === true, turnStarted: existingCall.turnStarted === true,
          providerRequestCount: null, output: structuredClone(existingCall.output), idempotentReplay: true,
        };
        if (role !== 'Reviewer') return {
          ...replay, sourceCallId: existingCall.id, sourceCallOutputSha256: existingCall.outputSha256,
        };
        const validReviewerReplay = existingCall.outcome === 'model_returned'
          && existingCall.cliSpawned === true && existingCall.turnStarted === true
          && typeof existingCall.output.text === 'string' && existingCall.output.text.trim()
          && /^[a-f0-9]{64}$/u.test(existingCall.outputSha256 || '')
          && existingCall.outputSha256 === sha256Text(JSON.stringify(existingCall.output));
        if (validReviewerReplay) return {
          ...replay, sourceCallId: existingCall.id, sourceCallOutputSha256: existingCall.outputSha256,
        };
      }
      const error = new Error(existingCall.failureReason || '该角色启动已经记账，不会自动再次调用。');
      error.code = 'ROLE_START_ALREADY_RECORDED';
      throw error;
    }
    if (role === 'Developer' && executionMode !== 'provider-decision') {
      const revision = execution.pendingRevision?.status === 'running'
        && execution.pendingRevision.workItemId === workItemId ? execution.pendingRevision : null;
      const expectedWorkspace = revision
        ? path.resolve(this.worktreesDir, task.id, `${execution.id}-revisions`, revision.id)
        : path.resolve(this.worktreesDir, task.id, execution.id);
      if (!workspacePath || path.resolve(workspacePath) !== expectedWorkspace) {
        throw new Error('Developer 只能在当前执行登记的隔离工作树中提交文件事务。');
      }
    }
    const deadlineAt = deadlineForBinding(task, binding);
    const result = await this.codexRoleRunner({
      role, binding, idempotencyKey: reservationKey, deadlineAt, prompt,
      schemaPath: path.join(WORKSPACE_ROOT, 'app', 'schemas', 'role-text.json'),
      runRoot: path.join(this.runtimeDir, 'codex-calls', task.id, execution.id, ...(binding.reviewRoundId ? [binding.reviewRoundId] : [])),
      hostCheck, workspacePath,
      executionMode,
      providerTools, requiredProviderTools,
      reserve: (request) => this.reserveCodexRoleStart(task, {
        ...request, promptSha256,
        promptUtf8Bytes,
      }),
      recordCliSpawn: async (reservation) => {
        const targetLedger = callbackLedger();
        const call = targetLedger?.modelCalls.find((item) => item.id === reservation.id);
        if (!call) throw new Error('已预留角色调用不在当前任务账本中。');
        call.cliSpawned = true;
        call.cliSpawnedAt = nowIso();
        await this.save();
      },
      recordTurnStarted: async (reservation) => {
        const targetLedger = callbackLedger();
        const call = targetLedger?.modelCalls.find((item) => item.id === reservation.id);
        if (!call) throw new Error('已预留角色调用不在当前任务账本中。');
        call.status = 'running';
        call.startedAt = nowIso();
        call.turnStarted = true;
        targetLedger.sessions ||= [];
        targetLedger.sessions.push({
          eventId: `evt-${call.id}`, sourceTaskId: task.id, attemptId: `attempt-${call.id}`,
          agentId: role === 'Lead' || role === 'Chat' ? execution.leadAgentId : role === 'Reviewer' ? execution.reviewerAgentId : execution.devAgentId,
          role, phase, callOrdinal: call.callOrdinal, modelCallId: call.id, reviewRoundId: binding.reviewRoundId || null,
          status: 'running', createdAt: call.reservedAt,
        });
        await this.save();
      },
      settle: async (reservation, outcome) => {
        const targetLedger = callbackLedger();
        const call = targetLedger?.modelCalls.find((item) => item.id === reservation.id);
        if (!call) return;
        const staleReason = currentBindingFailure(task, binding)
          || (!sameCodexBinding(call.binding, binding) ? 'call_binding_changed' : null);
        call.status = !staleReason && outcome.status === 'model_returned' && outcome.workCompleted ? 'completed' : 'failed';
        call.finishedAt = nowIso();
        call.cliSpawned = outcome.cliSpawned === true;
        call.turnStarted = outcome.turnStarted === true;
        call.providerRequestCount = null;
        call.outcome = staleReason ? 'stale_binding' : outcome.status;
        if (outcome.output) call.output = structuredClone(outcome.output);
        if (outcome.output) call.outputSha256 = sha256Text(JSON.stringify(outcome.output));
        const diagnostics = boundedCliDiagnostics(outcome.diagnostics);
        if (diagnostics) call.cliDiagnostics = diagnostics;
        if (staleReason) {
          call.invalidationReason = bindingFailureMessage(staleReason);
          call.failureReason = call.invalidationReason;
        } else if (outcome.error) call.failureReason = String(outcome.error).slice(0, 500);
        if (outcome.failureDetails && typeof outcome.failureDetails === 'object') call.failureDetails = structuredClone(outcome.failureDetails);
        const session = (targetLedger.sessions || []).find((item) => item.modelCallId === call.id);
        if (session) { session.status = call.status; session.finishedAt = call.finishedAt; }
        if (call.status === 'failed' && !binding.reviewRoundId && ['Lead', 'Developer', 'Frontend Developer', 'Reviewer'].includes(role)) {
          execution.phase = 'partial';
          execution.status = 'waiting_user';
          execution.failureReason = call.failureReason || `Codex ${role} 执行未完成：${outcome.status}`;
          task.updatedAt = nowIso();
        }
        await this.save();
      },
      acceptResult: async (output, context) => {
        const call = callbackLedger()?.modelCalls.find((item) => item.idempotencyKey === reservationKey);
        return typeof output?.text === 'string' && output.text.trim().length > 0
          && sameCodexBinding(context?.binding, binding)
          && !currentBindingFailure(task, binding)
          && Boolean(call && sameCodexBinding(call.binding, binding));
      },
      signal,
      processTimeoutMs: Math.min(codexRoleProcessTimeoutMs(role), Math.max(1, Date.parse(deadlineAt) - Date.now())),
    });
    const recordedCall = callbackLedger()?.modelCalls.find((call) =>
      call.role === role && call.idempotencyKey === reservationKey && sameCodexBinding(call.binding, binding));
    const staleReason = currentBindingFailure(task, binding);
    if (staleReason) await this.rejectStaleRoleBinding(task, binding);
    if (result.status !== 'model_returned' || result.workCompleted !== true) {
      const error = new Error(result.error || `Codex ${role} 未完成：${result.status}`);
      error.code = result.status;
      error.roleResult = result;
      throw error;
    }
    if (role === 'Reviewer' && (!recordedCall || recordedCall.status !== 'completed'
      || recordedCall.outcome !== 'model_returned' || recordedCall.cliSpawned !== true || recordedCall.turnStarted !== true
      || typeof recordedCall.outputSha256 !== 'string' || !recordedCall.output)) {
      throw new Error('Reviewer 返回没有对应的已结清原生调用记录；该结果不得作为独立审阅证据。');
    }
    return {
      ...result,
      ...(recordedCall ? { sourceCallId: recordedCall.id, sourceCallOutputSha256: recordedCall.outputSha256 } : {}),
    };
  }

  async listRegisteredProjects() {
    const projects = [];
    const builtinDefs = [
      {
        projectId: 'task-list-organizer',
        label: '项目待办整理器 (projects/task-list-organizer)',
        rootPath: path.join(BUILTIN_PROJECTS_DIR, 'task-list-organizer'),
        location: 'projects/task-list-organizer',
        allowedWritePaths: ['index.html', 'app.js', 'core.js', 'styles.css'],
        projectKind: 'utility',
      },
      {
        projectId: 'node-single-file-v1',
        label: 'Node 单文件练习项目 (greetName 契约测试)',
        rootPath: path.join(WORKSPACE_ROOT, 'app', 'project-fixtures', 'node-single-file-v1', 'workspace'),
        location: 'app/project-fixtures/node-single-file-v1/workspace',
        allowedWritePaths: ['src/greeting.mjs'],
        projectKind: 'utility',
      },
      {
        projectId: 'project-progress-assistant',
        label: '项目推进助手 (projects/project-progress-assistant)',
        rootPath: path.join(BUILTIN_PROJECTS_DIR, 'project-progress-assistant'),
        location: 'projects/project-progress-assistant',
        allowedWritePaths: ['index.html', 'app.js', 'styles.css'],
        projectKind: 'utility',
      },
    ];

    for (const def of [...builtinDefs, ...this.state.customProjects]) {
      if (!fs.existsSync(def.rootPath)) continue;
      const fileMap = await readRelativeFileMap(def.rootPath);
      const fingerprintPayload = Object.values(fileMap)
        .sort((a, b) => a.path.localeCompare(b.path))
        .map((f) => `${f.path}:${f.sha256}`)
        .join('|');
      const scopeFingerprint = sha256Text(`${def.projectId}|${def.allowedWritePaths.join(',')}|${fingerprintPayload}`);
      projects.push({
        projectId: def.projectId,
        label: def.label,
        rootPath: def.rootPath,
        location: def.location,
        scopeFingerprint,
        allowedWritePaths: def.allowedWritePaths,
        checkIds: ['check-scope-boundary', 'check-js-syntax', 'check-html-entry'],
        allowedRoles: ALLOWED_ROLES,
        maxAgents: 8,
        maxModelCalls: 8,
        projectKind: def.projectKind || 'utility',
        current: true,
      });
    }
    return projects;
  }

  async createUtilityProject({ name, requestId }) {
    const cleanName = String(name || '').trim() || '新建工具工程';
    if (requestId) {
      const existing = this.state.customProjects.find((p) => p.requestId === requestId);
      if (existing) {
        const all = await this.listRegisteredProjects();
        return all.find((p) => p.projectId === existing.projectId);
      }
    }
    const slug = crypto.randomUUID().slice(0, 8);
    const projectId = `omo-tool-${slug}`;
    const rootPath = path.join(this.customProjectsDir, projectId);
    await fsp.mkdir(rootPath, { recursive: true });

    await fsp.writeFile(path.join(rootPath, 'index.html'), [
      '<!doctype html>',
      '<html lang="zh-CN">',
      '<head>',
      '  <meta charset="utf-8">',
      '  <meta name="viewport" content="width=device-width, initial-scale=1">',
      `  <title>${cleanName}</title>`,
      '  <link rel="stylesheet" href="./styles.css">',
      '</head>',
      '<body>',
      '  <main class="tool-shell">',
      `    <h1>${cleanName}</h1>`,
      '    <p class="subtitle">由 iRIXI × OmO Harness 隔离工作树驱动的工具工程</p>',
      '    <section id="app-root"></section>',
      '  </main>',
      '  <script type="module" src="./app.js"></script>',
      '</body>',
      '</html>',
      '',
    ].join('\n'), 'utf8');

    await fsp.writeFile(path.join(rootPath, 'styles.css'), [
      ':root { color-scheme: light; font-family: system-ui, sans-serif; }',
      'body { margin: 0; padding: 24px; background: #f6f4ef; color: #1d2421; }',
      '.tool-shell { max-width: 880px; margin: 0 auto; background: #fff; padding: 24px; border-radius: 12px; border: 1px solid rgba(0,0,0,0.1); }',
      '',
    ].join('\n'), 'utf8');

    await fsp.writeFile(path.join(rootPath, 'core.js'), [
      'export function formatRecord(item) {',
      '  return { ...item, updatedAt: new Date().toISOString() };',
      '}',
      '',
    ].join('\n'), 'utf8');

    await fsp.writeFile(path.join(rootPath, 'app.js'), [
      'import { formatRecord } from "./core.js";',
      'const root = document.getElementById("app-root");',
      'if (root) {',
      '  const sample = formatRecord({ title: "示例条目", status: "active" });',
      '  root.innerHTML = `<div class="card"><strong>${sample.title}</strong> · <span>${sample.status}</span></div>`;',
      '}',
      '',
    ].join('\n'), 'utf8');

    this.state.customProjects.push({
      projectId,
      label: cleanName,
      rootPath,
      location: `omo-pilot/runtime/projects/${projectId}`,
      allowedWritePaths: ['index.html', 'app.js', 'core.js', 'styles.css'],
      projectKind: 'utility',
      requestId: requestId || null,
    });
    await this.save();

    const all = await this.listRegisteredProjects();
    return all.find((p) => p.projectId === projectId);
  }

  getActiveTask() {
    if (!this.state.activeTaskId) return null;
    return this.state.tasks.find((t) => t.id === this.state.activeTaskId) || null;
  }

  async createTask(body = {}) {
    const statement = String(body.statement || body.goal || '').trim();
    if (!statement) {
      throw new Error('请先写下明确的目标正文。');
    }
    if (body.taskCreationRequestId) {
      const dup = this.state.tasks.find((t) => t.taskCreationRequestId === body.taskCreationRequestId);
      if (dup) {
        this.state.activeTaskId = dup.id;
        this.state.activeTaskRevision += 1;
        await this.save();
        return dup;
      }
    }

    const taskId = `task-omo-${crypto.randomUUID().slice(0, 8)}`;
    const goalVersionId = `goal-v1-${crypto.randomUUID().slice(0, 8)}`;
    const title = String(body.title || '').trim() || statement.slice(0, 36);
    const successCriteria = Array.isArray(body.successCriteria)
      ? body.successCriteria.map((s) => String(s).trim()).filter(Boolean)
      : String(body.successCriteria || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const boundaries = Array.isArray(body.boundaries)
      ? body.boundaries.map((s) => String(s).trim()).filter(Boolean)
      : String(body.boundaries || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

    const projects = await this.listRegisteredProjects();
    let selectedScope = null;
    if (body.projectId && body.projectScopeFingerprint) {
      const matched = projects.find((p) => p.projectId === body.projectId);
      if (matched) {
        selectedScope = {
          projectId: matched.projectId,
          scopeFingerprint: matched.scopeFingerprint,
          goalVersionId,
          selectedAt: nowIso(),
          authorized: false,
          current: true,
        };
      }
    }

    const task = {
      id: taskId,
      title,
      functionId: ['learning', 'utility', 'game', 'agent'].includes(body.functionId) ? body.functionId : 'utility',
      statement,
      successCriteria,
      boundaries,
      goalVersionId,
      goalVersions: [{
        id: goalVersionId,
        statement,
        successCriteria,
        boundaries,
        createdAt: nowIso(),
      }],
      instructions: [],
      materials: [],
      memoryEntries: [],
      conversations: [],
      setupStatus: selectedScope ? 'waiting_scope_authorization' : 'waiting_scope',
      selectedScope,
      execution: null,
      registry: null,
      artifacts: [],
      activeArtifactId: null,
      preview: null,
      rejectionHistory: [],
      taskCreationRequestId: body.taskCreationRequestId || null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    this.state.tasks.unshift(task);
    this.state.activeTaskId = task.id;
    this.state.activeTaskRevision += 1;
    await this.save();
    return task;
  }

  async selectTask(taskId, { expectedActiveTaskId, expectedActiveTaskRevision } = {}) {
    const target = this.state.tasks.find((t) => t.id === taskId);
    if (!target) {
      const err = new Error('未找到指定的原生任务。');
      err.statusCode = 404;
      throw err;
    }
    if (expectedActiveTaskRevision !== undefined && expectedActiveTaskRevision !== this.state.activeTaskRevision) {
      const err = new Error('任务列表已被更新，请刷新后重试。');
      err.statusCode = 409;
      err.code = 'TASK_SELECTION_STALE';
      throw err;
    }
    this.state.activeTaskId = target.id;
    this.state.activeTaskRevision += 1;
    await this.save();
    return target;
  }

  async handleTaskAction(taskId, payload = {}) {
    const task = this.state.tasks.find((t) => t.id === taskId);
    if (!task) {
      const err = new Error('未找到指定的原生任务。');
      err.statusCode = 404;
      throw err;
    }
    const action = payload.action;
    const projects = await this.listRegisteredProjects();
    if (!this.preferLocalFallback
      && ['run', 'approve_plan', 'review', 'chat', 'continue'].includes(action)
      && this.modelStatus().liveExecutionBlocked) {
      const error = new Error(this.modelStatus().message);
      error.code = 'OMO_REQUIRED_MODEL_NOT_CONFIGURED';
      error.statusCode = 503;
      throw error;
    }

    if (action === 'scope') {
      const project = projects.find((p) => p.projectId === payload.projectId);
      if (!project) throw new Error('未找到所选登记项目。');
      task.selectedScope = {
        projectId: project.projectId,
        scopeFingerprint: project.scopeFingerprint,
        goalVersionId: task.goalVersionId,
        selectedAt: nowIso(),
        authorized: false,
        current: true,
      };
      task.setupStatus = 'waiting_scope_authorization';
      task.updatedAt = nowIso();
      await this.save();
      return { ok: true, status: task.setupStatus };
    }

    if (action === 'authorize_scope') {
      if (!task.selectedScope) throw new Error('请先选择项目范围。');
      const project = projects.find((p) => p.projectId === task.selectedScope.projectId);
      if (!project) throw new Error('所选登记项目不存在。');
      task.selectedScope.authorized = true;
      task.selectedScope.scopeFingerprint = project.scopeFingerprint;
      task.selectedScope.authorizedAt = nowIso();
      task.setupStatus = 'ready_to_run';
      task.updatedAt = nowIso();
      await this.save();
      return { ok: true, status: task.setupStatus };
    }

    if (action === 'prepare_run') {
      if (payload.mode === 'reuse_current_result' && task.execution && task.activeArtifactId) {
        task.setupStatus = null;
        task.updatedAt = nowIso();
        await this.save();
        return { ok: true, reused: true };
      }
      if (!task.selectedScope?.authorized) {
        throw new Error('当前项目范围尚未完成授权。');
      }
      const project = projects.find((p) => p.projectId === task.selectedScope.projectId);
      if (!project) throw new Error('登记项目不存在。');

      if (task.execution) {
        const execution = task.execution;
        const inFlight = (execution.modelCalls || []).some((call) => ['reserved', 'running'].includes(call.status));
        if (inFlight) {
          const error = new Error('当前执行仍有角色调用在途；不能通过重复准备替换执行或重置预算。');
          error.statusCode = 409;
          error.code = 'EXECUTION_CALL_IN_FLIGHT';
          throw error;
        }
        const beforeDeadline = Number.isFinite(Date.parse(execution.deadline)) && Date.parse(execution.deadline) > Date.now();
        const sameBinding = execution.bindingCurrent !== false
          && task.registry?.projectId === project.projectId
          && task.registry?.scopeFingerprint === project.scopeFingerprint
          && task.selectedScope.scopeFingerprint === project.scopeFingerprint
          && task.selectedScope.goalVersionId === task.goalVersionId;
        const reusablePhase = ['planned', 'awaiting_plan_approval', 'executing', 'completed', 'partial'].includes(execution.phase);
        const activeExecution = beforeDeadline && ['planned', 'awaiting_plan_approval', 'executing'].includes(execution.phase)
          && !execution.stopReason;
        const explicitNewExecution = payload.mode === 'new_execution';
        if (beforeDeadline && sameBinding && reusablePhase && !execution.stopReason && !explicitNewExecution) {
          task.setupStatus = null;
          task.updatedAt = nowIso();
          await this.save();
          return { ok: true, reused: true, executionId: execution.id, registrySha256: task.registry.registrySha256 };
        }
        if (!explicitNewExecution) {
          const error = new Error(activeExecution
            ? '当前绑定下已有有效执行；重复准备会复用它。若需另开执行，请明确请求新执行。'
            : '现有执行已结束、到期或绑定变化；重复准备不会自动重试。若需另开执行，请明确请求新执行。');
          error.statusCode = 409;
          error.code = activeExecution ? 'EXECUTION_ALREADY_ACTIVE' : 'EXECUTION_REQUIRES_EXPLICIT_NEW_RUN';
          throw error;
        }
        task.executionHistory ||= [];
        task.executionHistory.push({
          archivedAt: nowIso(), execution: structuredClone(execution),
          registry: task.registry ? structuredClone(task.registry) : null,
        });
      }

      const executionId = `run-omo-${crypto.randomUUID().slice(0, 8)}`;
      const registrySha256 = sha256Text(`${task.id}|${task.goalVersionId}|${project.projectId}|${project.scopeFingerprint}|${executionId}`);
      const autoReviewAuthorized = payload.autoReviewContinuation !== false;
      const deadline = new Date(Date.now() + 20 * 60 * 1000).toISOString();

      const leadAgentId = `agent-lead-${executionId.slice(-6)}`;
      const devAgentId = `agent-dev-${executionId.slice(-6)}`;
      const reviewerAgentId = `agent-rev-${executionId.slice(-6)}`;

      task.registry = {
        status: 'prepared',
        projectId: project.projectId,
        scopeFingerprint: project.scopeFingerprint,
        preparedAt: nowIso(),
        registrySha256,
        registeredEventId: `event-reg-${crypto.randomUUID().slice(0, 8)}`,
      };

      task.execution = {
        id: executionId,
        phase: 'planned',
        status: 'waiting_start',
        bindingCurrent: true,
        deadline,
        limits: { maxModelCalls: 8, maxDurationMs: 20 * 60 * 1000 },
        leadAgentId,
        devAgentId,
        reviewerAgentId,
        agents: [
          { id: leadAgentId, name: 'Irixi · Codex Lead', role: 'Lead', stationRole: 'coordinator', backend: 'codex-cli', model: CODEX_ROLE_MODEL, isTeamLead: true, status: 'idle' },
          { id: devAgentId, name: 'Codex Developer', role: 'Frontend Developer', stationRole: 'writer', backend: 'codex-cli', model: CODEX_ROLE_MODEL, isTeamLead: false, status: 'idle' },
          { id: reviewerAgentId, name: 'Codex Independent Reviewer', role: 'Reviewer', stationRole: 'reviewer', backend: 'codex-cli', model: CODEX_ROLE_MODEL, isTeamLead: false, status: 'idle' },
        ],
        modelCalls: [],
        sessions: [],
        workItems: [],
        plan: null,
        planApprovalStatus: 'not_ready',
        reviewContinuation: {
          authorized: autoReviewAuthorized,
          status: autoReviewAuthorized ? 'armed' : 'disabled',
          maxModelCalls: 1,
          maxDurationMs: 20 * 60 * 1000,
        },
      };
      task.setupStatus = null;
      task.updatedAt = nowIso();
      await this.save();
      return { ok: true, executionId, registrySha256 };
    }

    if (action === 'run') {
      if (!task.execution) throw new Error('请先准备原生后台。');
      const project = projects.find((p) => p.projectId === task.registry?.projectId);
      if (!project) throw new Error('未找到绑定的登记项目。');
      if (task.execution.planInProgress || (task.execution.modelCalls || []).some((call) => ['reserved', 'running', 'started', 'in_progress', 'working'].includes(call.status))) {
        throw Object.assign(new Error('Lead 正在处理当前计划，不会重复启动。'), { statusCode: 409, code: 'PLAN_GENERATION_IN_FLIGHT' });
      }

      const lastRejection = task.rejectionHistory.at(-1)?.reason || null;
      const callId = `call-lead-${crypto.randomUUID().slice(0, 8)}`;
      const leadBinding = snapshotTaskBinding(task, `work-plan-${task.execution.id}`);
      const instructionSnapshot = planInstructionSnapshot(task, project);
      task.execution.planInProgress = true;
      task.execution.pendingPlanInstructionSnapshot = instructionSnapshot;
      task.updatedAt = nowIso();
      try { await this.save(); }
      catch (error) {
        task.execution.planInProgress = false;
        delete task.execution.pendingPlanInstructionSnapshot;
        throw error;
      }
      let planResult;
      try {
        planResult = await generateLeadPlanWithOmo({
          task,
          project,
          instructions: instructionSnapshot.instructions,
          instructionSnapshotSha256: instructionSnapshot.sha256,
          rejectionReason: lastRejection,
          preferLocalFallback: this.preferLocalFallback,
          runRole: this.preferLocalFallback ? null : (request) => this.runOmoCodexProductRole(task, {
            ...request, workItemId: leadBinding.workItemId, project, expectedBinding: leadBinding,
          }),
        });
        await this.rejectStaleRoleBinding(task, leadBinding);
        if (!task.execution.planInProgress || task.execution.pendingPlanInstructionSnapshot?.sha256 !== instructionSnapshot.sha256
          || !validPlanInstructionSnapshot(task, task.execution, instructionSnapshot)) {
          throw Object.assign(new Error('Lead 返回时指令快照或任务绑定已变化；计划未保存。'), { statusCode: 409, code: 'PLAN_INSTRUCTION_SNAPSHOT_STALE' });
        }
      } catch (error) {
        if (task.execution?.id === leadBinding.executionId && task.execution.planInProgress) {
          task.execution.planInProgress = false;
          task.execution.lastPlanInputSnapshot = { sha256: instructionSnapshot.sha256, failedAt: nowIso() };
          delete task.execution.pendingPlanInstructionSnapshot;
          task.updatedAt = nowIso();
          try { await this.save(); } catch {}
        }
        throw error;
      }

      if (this.preferLocalFallback) {
        task.execution.modelCalls.push({ id: callId, role: 'Lead', status: 'completed', callOrdinal: task.execution.modelCalls.length + 1, providerRequestCount: null });
        task.execution.sessions.push({ eventId: `evt-${callId}`, sourceTaskId: task.id, attemptId: `att-${callId}`, agentId: task.execution.leadAgentId,
          role: 'Lead', phase: 'planning', callOrdinal: task.execution.modelCalls.length, modelCallId: callId, status: 'completed', createdAt: nowIso() });
      }
      task.execution.plan = {
        text: planResult.text,
        sha256: planResult.sha256,
        provider: planResult.provider,
        instructionSnapshot,
      };
      task.execution.planInProgress = false;
      delete task.execution.pendingPlanInstructionSnapshot;
      task.execution.planApprovalStatus = 'not_persisted';
      task.execution.phase = 'awaiting_plan_approval';
      task.execution.status = 'waiting_user';
      task.execution.workItems = [
        {
          id: `work-plan-${task.execution.id}`,
          agentId: task.execution.leadAgentId,
          actor: 'coordinator',
          role: 'coordinator',
          title: 'Lead 制定执行计划与范围边界核对',
          status: 'waiting_user',
        },
      ];
      task.updatedAt = nowIso();
      await this.save();
      return { ok: true, planSha256: planResult.sha256 };
    }

    if (action === 'continue') {
      const execution = task.execution;
      const revision = execution?.pendingRevision;
      const artifact = task.artifacts.find((item) => item.id === task.activeArtifactId);
      const expected = {
        goalVersionId: payload.expectedGoalVersionId,
        executionId: payload.expectedExecutionId,
        registrySha256: payload.expectedRegistrySha256,
        scopeFingerprint: payload.expectedScopeFingerprint,
        artifactId: payload.expectedArtifactId,
        artifactVersion: payload.expectedArtifactVersion,
        candidateSha256: payload.expectedCandidateSha256,
      };
      const matchesRevision = Boolean(revision && payload.revisionId === revision.id
        && expected.goalVersionId === task.goalVersionId && expected.executionId === execution?.id
        && expected.registrySha256 === task.registry?.registrySha256
        && expected.scopeFingerprint === task.registry?.scopeFingerprint
        && expected.artifactId === revision.sourceArtifactId && expected.artifactVersion === revision.sourceArtifactVersion
        && expected.candidateSha256 === revision.sourceCandidateSha256
        && revision.goalVersionId === expected.goalVersionId && revision.executionId === expected.executionId
        && revision.registrySha256 === expected.registrySha256 && revision.scopeFingerprint === expected.scopeFingerprint);
      if (!matchesRevision) throw Object.assign(new Error('续改请求与当前候选、目标或授权范围不一致。'), { statusCode: 409, code: 'REVISION_BINDING_STALE' });
      if (revision.status === 'running' || revision.status === 'completed' || revision.status === 'failed') {
        return { ok: true, revisionId: revision.id, status: revision.status, idempotentReplay: true };
      }
      if (!artifact || artifact.id !== revision.sourceArtifactId || artifact.version !== revision.sourceArtifactVersion
        || artifact.candidateSha256 !== revision.sourceCandidateSha256) {
        throw Object.assign(new Error('续改请求绑定的候选已不是当前候选。'), { statusCode: 409, code: 'REVISION_BINDING_STALE' });
      }
      if (!canContinueRejectedCandidate(task, artifact)) {
        throw Object.assign(new Error('当前执行已失败、过期、耗尽预算或绑定变化；不会在原执行中重试。'), { statusCode: 409, code: 'REVISION_CONTINUATION_UNAVAILABLE' });
      }
      await readVerifiedCandidateFiles(artifact, this.worktreesDir, task.id, execution.id);
      if (execution.pendingRevision?.id !== revision.id || !canContinueRejectedCandidate(task, artifact)) {
        throw Object.assign(new Error('续改资格在读取候选期间已变化，请刷新任务状态。'), { statusCode: 409, code: 'REVISION_BINDING_STALE' });
      }
      revision.status = 'running';
      revision.startedAt = nowIso();
      execution.phase = 'executing';
      execution.status = 'running';
      execution.workItems ||= [];
      execution.workItems.push({
        id: revision.workItemId, agentId: execution.devAgentId, actor: 'writer', role: 'writer',
        title: `按 v${revision.sourceArtifactVersion} 的正式退回原因继续修改`, status: 'running',
      });
      task.setupStatus = null;
      task.updatedAt = nowIso();
      await this.save();
      try {
        return await this.handleTaskAction(taskId, {
          action: 'approve_plan', expectedPlanSha256: execution.plan.sha256,
          expectedInstructionSnapshotSha256: execution.plan.instructionSnapshot?.sha256,
          continuationRevisionId: revision.id,
        });
      } catch (error) {
        if (execution.pendingRevision?.id === revision.id && revision.status === 'running') {
          revision.status = 'failed';
          revision.finishedAt = nowIso();
          revision.failureReason = String(error.message || error).slice(0, 500);
          if (executionIsCancelled(execution)) {
            execution.phase = 'cancelled';
            execution.status = 'cancelled';
          } else if (!executionIsStopped(execution)) {
            execution.phase = 'partial';
            execution.status = 'waiting_user';
            execution.stopReason = 'revision_execution_failed';
          }
          task.updatedAt = nowIso();
          await this.save();
        }
        throw error;
      }
    }

    if (action === 'approve_plan') {
      if (!task.execution?.plan) throw new Error('当前没有待审批的 Lead 计划。');
      if (payload.expectedPlanSha256 && payload.expectedPlanSha256 !== task.execution.plan.sha256) {
        throw new Error('Lead 计划摘要不匹配，请刷新后重新核对。');
      }
      const revision = task.execution.pendingRevision?.status === 'running'
        && task.execution.pendingRevision.id === payload.continuationRevisionId
        ? task.execution.pendingRevision : null;
      const instructionSnapshot = task.execution.plan.instructionSnapshot;
      if (!validPlanInstructionSnapshot(task, task.execution, instructionSnapshot, { checkArtifact: !revision })
        || payload.expectedInstructionSnapshotSha256 !== instructionSnapshot.sha256) {
        throw Object.assign(new Error('当前计划缺少可信的指令快照；不会把新交代传给旧计划。请形成新计划后再审批。'), { statusCode: 409, code: 'PLAN_INSTRUCTION_SNAPSHOT_STALE' });
      }
      if (revision) {
        const sourceArtifact = task.artifacts.find((item) => item.id === revision.sourceArtifactId);
        if (!sourceArtifact || sourceArtifact.version !== revision.sourceArtifactVersion
          || sourceArtifact.candidateSha256 !== revision.sourceCandidateSha256
          || sourceArtifact.goalVersionId !== revision.goalVersionId
          || sourceArtifact.executionId !== revision.executionId
          || sourceArtifact.registrySha256 !== revision.registrySha256
          || sourceArtifact.confirmation || task.goalVersionId !== revision.goalVersionId
          || task.execution.id !== revision.executionId || task.registry?.registrySha256 !== revision.registrySha256
          || task.registry?.scopeFingerprint !== revision.scopeFingerprint
          || task.selectedScope?.scopeFingerprint !== revision.scopeFingerprint
          || task.selectedScope?.authorized !== true || task.selectedScope?.current === false
          || task.selectedScope?.goalVersionId !== revision.goalVersionId || task.selectedScope?.projectId !== task.registry?.projectId
          || task.registry?.current === false || task.registry?.bindingCurrent === false || task.registry?.status === 'stale'
          || task.execution.bindingCurrent === false || task.execution.phase !== 'executing'
          || task.execution.planApprovalStatus !== 'saved' || Date.parse(task.execution.deadline) <= Date.now()
          || task.execution.stopReason || task.execution.modelCalls.length >= 8
          || task.execution.modelCalls.some((call) => ['reserved', 'running', 'started', 'in_progress', 'working'].includes(call.status))
          || task.execution.modelCalls.some((call) => call.status !== 'completed' || call.outcome !== 'model_returned')
          || task.execution.modelCalls.at(-1)?.role !== 'Developer'
          || task.execution.modelCalls.at(-1)?.cliSpawned !== true || task.execution.modelCalls.at(-1)?.turnStarted !== true
          || task.execution.modelCalls.some(hasToolExecutionFailure)
          || !hasFailedHostChecks(sourceArtifact)
          || task.execution.modelCalls.some((call) => call.role === 'Reviewer' && call.binding?.artifactId === sourceArtifact.id
            && call.binding?.candidateSha256 === sourceArtifact.candidateSha256)) {
          throw Object.assign(new Error('已退回候选的续改绑定已变化；没有启动新的角色调用。'), { statusCode: 409, code: 'REVISION_BINDING_STALE' });
        }
      } else if (task.execution.phase !== 'awaiting_plan_approval' || task.execution.planApprovalStatus === 'saved'
        || task.execution.pendingRevision?.status === 'running') {
        throw Object.assign(new Error('当前没有等待首次批准的执行计划。'), { statusCode: 409, code: 'PLAN_APPROVAL_NOT_PENDING' });
      }
      const project = projects.find((p) => p.projectId === task.registry?.projectId);
      if (!project) throw new Error('未找到绑定的登记项目。');
      const developerWorkItemId = revision?.workItemId || `work-dev-${task.execution.id}`;
      const developerBinding = snapshotTaskBinding(task, developerWorkItemId, revision
        ? task.artifacts.find((item) => item.id === revision.sourceArtifactId) : null);

      // Create isolated worktree directory for this execution
      const worktreePath = revision
        ? path.join(this.worktreesDir, task.id, `${task.execution.id}-revisions`, revision.id)
        : path.join(this.worktreesDir, task.id, task.execution.id);
      const sourceFilesMap = revision
        ? await readVerifiedCandidateFiles(task.artifacts.find((item) => item.id === revision.sourceArtifactId), this.worktreesDir, task.id, task.execution.id)
        : await readRelativeFileMap(project.rootPath);
      await this.rejectStaleRoleBinding(task, developerBinding);
      if (revision) {
        let revisionWorkspaceCreated = false;
        try {
          await fsp.mkdir(path.dirname(worktreePath), { recursive: true });
          await fsp.mkdir(worktreePath);
          revisionWorkspaceCreated = true;
          for (const [relPath, fileObj] of Object.entries(sourceFilesMap)) {
            const destPath = path.join(worktreePath, ...relPath.split('/'));
            await fsp.mkdir(path.dirname(destPath), { recursive: true });
            await fsp.writeFile(destPath, fileObj.buffer, { flag: 'wx' });
          }
          const sourceArtifact = task.artifacts.find((item) => item.id === revision.sourceArtifactId);
          const copiedFiles = await readRelativeFileMap(worktreePath);
          const sourceAfterCopy = await readRelativeFileMap(sourceArtifact.worktreePath);
          if (sourceArtifact.version !== revision.sourceArtifactVersion
            || sourceArtifact.goalVersionId !== revision.goalVersionId
            || sourceArtifact.executionId !== revision.executionId
            || sourceArtifact.registrySha256 !== revision.registrySha256
            || !candidateFilesMatchManifest(sourceArtifact, copiedFiles)
            || !sameCandidateFileSnapshot(sourceFilesMap, copiedFiles)
            || !candidateFilesMatchManifest(sourceArtifact, sourceAfterCopy)
            || !sameCandidateFileSnapshot(sourceFilesMap, sourceAfterCopy)) {
            throw Object.assign(new Error('退回候选复制后与冻结清单不一致，未启动续改。'), { statusCode: 409, code: 'REVISION_SOURCE_CHANGED' });
          }
          if (!canStartRevisionDeveloper(task, sourceArtifact, revision)) {
            throw Object.assign(new Error('复制候选期间执行已停止或续改绑定已变化；未启动 Developer。'), { statusCode: 409, code: 'REVISION_CONTINUATION_UNAVAILABLE' });
          }
        } catch (error) {
          if (revisionWorkspaceCreated) await fsp.rm(worktreePath, { recursive: true, force: true });
          throw error;
        }
      } else {
        let worktreeReady = false;
        try { worktreeReady = (await fsp.stat(worktreePath)).isDirectory(); } catch {}
        if (!worktreeReady) {
          await fsp.mkdir(worktreePath, { recursive: true });
          for (const [relPath, fileObj] of Object.entries(sourceFilesMap)) {
            const destPath = path.join(worktreePath, relPath);
            await fsp.mkdir(path.dirname(destPath), { recursive: true });
            await fsp.writeFile(destPath, fileObj.content, { encoding: 'utf8', flag: 'wx' });
          }
        }
      }

      if (!revision) {
        task.execution.planApprovalStatus = 'saved';
        task.execution.phase = 'executing';
      }

      const lastRejection = revision?.reason || task.rejectionHistory.at(-1)?.reason || null;
      const devCallId = `call-dev-${crypto.randomUUID().slice(0, 8)}`;

      // Execute OmO Developer in the isolated worktree + Host Checks + Self-Repair
      const devExecution = await this.developerRunner({
        task,
        project,
        worktreePath,
        sourceFilesMap,
        planText: task.execution.plan.text,
        instructions: instructionSnapshot.instructions,
        instructionSnapshotSha256: instructionSnapshot.sha256,
        rejectionReason: lastRejection,
        preferLocalFallback: this.preferLocalFallback,
        runRole: this.preferLocalFallback ? null : (request) => this.runOmoCodexProductRole(task, {
          ...request, workItemId: developerBinding.workItemId, project, expectedBinding: developerBinding,
        }),
      });
      await this.rejectStaleRoleBinding(task, developerBinding);
      if (!validPlanInstructionSnapshot(task, task.execution, task.execution.plan?.instructionSnapshot, { checkArtifact: false })
        || task.execution.plan.instructionSnapshot.sha256 !== instructionSnapshot.sha256) {
        throw Object.assign(new Error('开发返回时批准计划的指令快照已变化；结果不进入候选。'), { statusCode: 409, code: 'DEVELOPER_INSTRUCTION_SNAPSHOT_STALE' });
      }

      if (this.preferLocalFallback) {
        task.execution.modelCalls.push({ id: devCallId, role: 'Frontend Developer', status: 'completed', callOrdinal: task.execution.modelCalls.length + 1, providerRequestCount: null });
        task.execution.sessions.push({ eventId: `evt-${devCallId}`, sourceTaskId: task.id, attemptId: `att-${devCallId}`, agentId: task.execution.devAgentId,
          role: 'Frontend Developer', phase: 'implementation', callOrdinal: task.execution.modelCalls.length, modelCallId: devCallId, status: 'completed', createdAt: nowIso() });
      }

      const { checkResult } = devExecution;
      const changedFiles = checkResult.changedPaths
        .map((relPath) => checkResult.currentFilesMap[relPath])
        .filter(Boolean)
        .map((f) => ({ path: f.path, sha256: f.sha256, bytes: f.bytes }));

      const patchText = buildUnifiedPatch(sourceFilesMap, checkResult.currentFilesMap, checkResult.changedPaths);
      const patchSha256 = sha256Text(patchText);
      const diffSha256 = patchSha256;
      const candidateSha256 = candidateSha256ForFiles(checkResult.currentFilesMap);

      const version = task.artifacts.length + 1;
      const artifactId = `artifact-omo-v${version}-${crypto.randomUUID().slice(0, 8)}`;

      // Automatic Continuation into Independent Read-Only Reviewer!
      const revCallId = `call-rev-${crypto.randomUUID().slice(0, 8)}`;
      const reviewerArtifactBinding = {
        id: artifactId, candidateSha256, goalVersionId: developerBinding.goalVersionId,
        executionId: developerBinding.executionId, registrySha256: developerBinding.registrySha256, diffSha256,
      };
      task.execution.pendingCandidateBinding = {
        artifactId, candidateSha256, goalVersionId: task.goalVersionId,
        executionId: task.execution.id, registrySha256: task.registry.registrySha256, diffSha256,
      };
      const reviewerBinding = {
        ...developerBinding, workItemId: `work-rev-${revision?.id || developerBinding.executionId}`,
        artifactId, candidateSha256, diffSha256,
      };
      await this.save();
      await this.rejectStaleRoleBinding(task, reviewerBinding);
      let reviewResult;
      try {
        reviewResult = await runIndependentReviewerWithOmo({
          task, project, worktreePath, candidateSha256, diffSha256, patchText, changedFiles, artifactId, artifactVersion: version,
          checks: checkResult.checks, candidateFilesMap: checkResult.currentFilesMap,
          preferLocalFallback: this.preferLocalFallback,
          runRole: this.preferLocalFallback ? null : (request) => this.runOmoCodexProductRole(task, {
            ...request, workItemId: reviewerBinding.workItemId, project, expectedBinding: reviewerBinding,
            artifact: { ...reviewerArtifactBinding, hostCheck: { passed: checkResult.passed } },
          }),
        });
      } catch (error) {
        reviewResult = {
          passed: false, nativeVerdict: 'UNVERIFIED', scopeOutcome: 'unverified', invoked: false,
          summary: `独立审阅未完成，候选已保留：${String(error.message || error).slice(0, 400)}`,
          text: '', fullOutputSha256: sha256Text(''), provider: 'Codex CLI / gpt-6-luna',
        };
      }
      await this.rejectStaleRoleBinding(task, reviewerBinding);
      if (this.preferLocalFallback) {
        task.execution.modelCalls.push({ id: revCallId, role: 'Reviewer', status: 'completed', callOrdinal: task.execution.modelCalls.length + 1, providerRequestCount: null });
        task.execution.sessions.push({ eventId: `evt-${revCallId}`, sourceTaskId: task.id, attemptId: `att-${revCallId}`, agentId: task.execution.reviewerAgentId,
          role: 'Reviewer', phase: 'review', callOrdinal: task.execution.modelCalls.length, modelCallId: revCallId, status: 'completed', createdAt: nowIso() });
      }

      const reviewId = `review-omo-${crypto.randomUUID().slice(0, 8)}`;
      const artifact = {
        id: artifactId,
        version,
        goalVersionId: task.goalVersionId,
        executionId: task.execution.id,
        registrySha256: task.registry.registrySha256,
        worktreePath,
        candidateSha256,
        diffSha256,
        patchSha256,
        patch: patchText,
        files: Object.values(checkResult.currentFilesMap)
          .sort((a, b) => a.path.localeCompare(b.path))
          .map((f) => ({ path: f.path, sha256: f.sha256, bytes: f.bytes })),
        changedFiles,
        hostCheck: {
          passed: checkResult.passed,
          checks: checkResult.checks.map((c) => ({
            id: c.id,
            passed: c.status === 'passed',
            detail: `${c.name}：${c.summary}`,
          })),
        },
        review: {
          id: reviewId,
          passed: reviewResult.passed,
          nativeVerdict: reviewResult.nativeVerdict,
          scopeOutcome: reviewResult.scopeOutcome,
          fullOutputSha256: reviewResult.fullOutputSha256,
          text: reviewResult.text,
          sourceEvidence: reviewerSourceEvidence(task, {
            id: artifactId, version, goalVersionId: task.goalVersionId, executionId: task.execution.id,
            registrySha256: task.registry.registrySha256, candidateSha256, diffSha256,
          }, reviewResult),
          summary: reviewResult.summary,
          reviewedAt: nowIso(),
        },
        confirmation: null,
        createdAt: nowIso(),
      };

      task.artifacts.push(artifact);
      task.activeArtifactId = artifact.id;
      markReviewerCallAdopted(task, artifact, artifact.review);
      delete task.execution.pendingCandidateBinding;
      if (revision) {
        revision.status = 'completed';
        revision.finishedAt = nowIso();
        revision.resultArtifactId = artifact.id;
        revision.resultCandidateSha256 = artifact.candidateSha256;
      }

      // Auto-register static preview token for the isolated candidate worktree
      const previewToken = `omo-preview-${task.id}-${version}`;
      this.previewTokens.set(previewToken, {
        taskId: task.id,
        worktreePath,
      });
      task.preview = {
        status: 'ready',
        token: previewToken,
        worktreePath,
        taskId: task.id,
        goalVersionId: task.goalVersionId,
        executionId: task.execution.id,
        registrySha256: task.registry.registrySha256,
        artifactId: artifact.id,
        artifactVersion: artifact.version,
        candidateSha256: artifact.candidateSha256,
        entry: 'index.html',
        error: null,
      };

      task.execution.reviewContinuation = {
        ...task.execution.reviewContinuation,
        status: reviewResult.invoked === false && !this.preferLocalFallback ? 'blocked_or_failed' : 'completed',
        dispatchEventId: task.execution.sessions.find((session) => session.role === 'Reviewer' && session.modelCallId)?.eventId || `evt-${revCallId}`,
        artifactId: artifact.id,
        artifactVersion: artifact.version,
        candidateSha256: artifact.candidateSha256,
      };
      const reviewerCompleted = reviewResult.invoked !== false || this.preferLocalFallback;
      task.execution.phase = reviewerCompleted ? 'completed' : 'partial';
      task.execution.status = 'waiting_user';
      const completedWorkItems = [
        {
          id: `work-lead-${task.execution.id}`,
          agentId: task.execution.leadAgentId,
          actor: 'coordinator',
          role: 'coordinator',
          title: 'Lead 计划已批准并完成多模块派工收束',
          status: 'completed',
        },
        {
          id: `work-dev-${task.execution.id}`,
          agentId: task.execution.devAgentId,
          actor: 'writer',
          role: 'writer',
          title: `隔离工作树增量开发与 Host 检查 (${changedFiles.map((f) => f.path).join(', ')})`,
          status: 'completed',
        },
        {
          id: `work-rev-${task.execution.id}`,
          agentId: task.execution.reviewerAgentId,
          actor: 'reviewer',
          role: 'reviewer',
          title: `独立只读审阅自动接续 (${reviewResult.nativeVerdict})`,
          status: reviewerCompleted ? 'completed' : 'blocked',
        },
      ];
      if (revision) {
        const developerWorkItem = task.execution.workItems.find((item) => item.id === revision.workItemId);
        if (developerWorkItem) {
          developerWorkItem.status = 'completed';
          developerWorkItem.title = `退回 v${revision.sourceArtifactVersion} 的修订与 Host 检查 (${changedFiles.map((f) => f.path).join(', ')})`;
        }
        task.execution.workItems.push({ ...completedWorkItems[2], id: reviewerBinding.workItemId });
      } else {
        task.execution.workItems = completedWorkItems;
      }

      task.updatedAt = nowIso();
      await this.save();
      return {
        ok: true,
        artifactId: artifact.id,
        candidateSha256: artifact.candidateSha256,
        reviewId,
        verdict: reviewResult.nativeVerdict,
      };
    }

    if (action === 'preview') {
      const artifact = this.getActiveArtifact(task);
      if (!artifact) throw new Error('当前没有可预览的候选版本。');
      const entry = String(payload.entry || 'index.html');
      const previewToken = `omo-preview-${task.id}-${artifact.version}`;
      this.previewTokens.set(previewToken, {
        taskId: task.id,
        worktreePath: artifact.worktreePath,
      });
      task.preview = {
        status: 'ready',
        token: previewToken,
        worktreePath: artifact.worktreePath,
        taskId: task.id,
        goalVersionId: task.goalVersionId,
        executionId: task.execution.id,
        registrySha256: task.registry.registrySha256,
        artifactId: artifact.id,
        artifactVersion: artifact.version,
        candidateSha256: artifact.candidateSha256,
        entry,
        error: null,
      };
      task.updatedAt = nowIso();
      await this.save();
      return { ok: true, previewUrl: `/product-preview/${previewToken}/${entry}` };
    }

    if (action === 'cancel') {
      const roundId = payload.expectedReviewRoundId;
      const round = typeof roundId === 'string' ? task.execution?.reviewRounds?.find((item) => item.id === roundId) : null;
      const artifact = this.getActiveArtifact(task);
      const requestId = payload.requestId;
      if (!/^[A-Za-z0-9_-]{1,128}$/u.test(requestId || '')) {
        throw Object.assign(new Error('取消审阅轮缺少稳定请求编号。'), { statusCode: 400, code: 'REVIEW_ROUND_CANCEL_REQUEST_ID_REQUIRED' });
      }
      const expected = {
        taskId: payload.expectedTaskId, goalVersionId: payload.expectedGoalVersionId,
        executionId: payload.expectedExecutionId, registrySha256: payload.expectedRegistrySha256,
        scopeFingerprint: payload.expectedScopeFingerprint, artifactId: payload.expectedArtifactId,
        artifactVersion: payload.expectedArtifactVersion, candidateSha256: payload.expectedCandidateSha256,
        diffSha256: payload.expectedDiffSha256, reviewRoundId: roundId,
        previousReviewId: payload.expectedReviewId ?? null,
        previousReviewRoundId: payload.expectedPreviousReviewRoundId ?? null,
      };
      const fingerprint = sha256Text(JSON.stringify({ ...expected, requestId }));
      if (!round || !artifact || round.binding?.taskId !== task.id
        || round.binding?.goalVersionId !== task.goalVersionId || round.binding?.executionId !== task.execution?.id
        || round.binding?.registrySha256 !== task.registry?.registrySha256
        || round.binding?.scopeFingerprint !== task.registry?.scopeFingerprint
        || round.binding?.artifactId !== artifact.id || round.binding?.artifactVersion !== artifact.version
        || round.binding?.candidateSha256 !== artifact.candidateSha256 || round.binding?.diffSha256 !== artifact.diffSha256
        || round.binding?.previousReviewId !== (artifact.review?.id || null)
        || expected.previousReviewId !== (artifact.review?.id || null)
        || (round.binding?.previousReviewRoundId || null) !== expected.previousReviewRoundId
        || expected.taskId !== task.id || expected.goalVersionId !== task.goalVersionId
        || expected.executionId !== task.execution?.id || expected.registrySha256 !== task.registry?.registrySha256
        || expected.scopeFingerprint !== task.registry?.scopeFingerprint || expected.artifactId !== artifact.id
        || expected.artifactVersion !== artifact.version || expected.candidateSha256 !== artifact.candidateSha256
        || expected.diffSha256 !== artifact.diffSha256) {
        throw Object.assign(new Error('取消请求与当前审阅轮、候选或授权范围不一致。'), { statusCode: 409, code: 'REVIEW_ROUND_CANCEL_BINDING_STALE' });
      }
      if (round.cancelRequestId) {
        if (round.cancelRequestId !== requestId || round.cancelRequestFingerprint !== fingerprint) {
          throw Object.assign(new Error('本轮已绑定其他取消请求。'), { statusCode: 409, code: 'REVIEW_ROUND_CANCEL_ALREADY_REQUESTED' });
        }
        return { ok: true, reviewRoundId: round.id, status: round.status, idempotentReplay: true };
      }
      if (!['open', 'running'].includes(round.status) || currentBindingFailure(task, {
        ...round.binding, workItemId: `work-review-${round.id}-cancel`, reviewRoundId: round.id,
        reviewRoundRequestId: round.requestId, previousReviewId: round.expectedReviewId,
        previousReviewRoundId: round.binding?.previousReviewRoundId || null,
      })) {
        throw Object.assign(new Error('当前审阅轮已结束或绑定失效，不能取消其他轮次。'), { statusCode: 409, code: 'REVIEW_ROUND_CANCEL_NOT_ACTIVE' });
      }
      round.cancelRequestId = requestId;
      round.cancelRequestFingerprint = fingerprint;
      round.cancelledAt = nowIso();
      round.cancelBinding = { ...expected };
      round.status = 'cancelled';
      round.stopReason = 'user_cancelled';
      task.updatedAt = nowIso();
      await this.save();
      this.reviewRoundAbortControllers.get(round.id)?.abort();
      return { ok: true, reviewRoundId: round.id, status: round.status, cancelledAt: round.cancelledAt };
    }

    if (action === 'open_review_round') {
      const previousOpen = this.reviewRoundOpenQueue;
      let releaseOpen;
      this.reviewRoundOpenQueue = new Promise((resolve) => { releaseOpen = resolve; });
      await previousOpen;
      try {
      const artifact = this.getActiveArtifact(task);
      const execution = task.execution;
      const requestId = payload.requestId;
      if (!/^[A-Za-z0-9_-]{1,128}$/u.test(requestId || '')) {
        throw Object.assign(new Error('后续审阅轮缺少稳定请求编号。'), { statusCode: 400, code: 'REVIEW_ROUND_REQUEST_ID_REQUIRED' });
      }
      const expected = {
        taskId: payload.expectedTaskId,
        goalVersionId: payload.expectedGoalVersionId,
        executionId: payload.expectedExecutionId,
        registrySha256: payload.expectedRegistrySha256,
        scopeFingerprint: payload.expectedScopeFingerprint,
        artifactId: payload.expectedArtifactId,
        artifactVersion: payload.expectedArtifactVersion,
        candidateSha256: payload.expectedCandidateSha256,
        diffSha256: payload.expectedDiffSha256,
        previousReviewId: payload.expectedReviewId ?? null,
        previousReviewRoundId: payload.expectedPreviousReviewRoundId ?? null,
      };
      const artifactReviewRounds = (execution?.reviewRounds || []).filter((round) => round.binding?.artifactId === artifact?.id);
      const lastReviewRound = artifactReviewRounds.at(-1) || null;
      const existingRequest = execution?.reviewRounds?.find((round) => round.requestId === requestId) || null;
      const expectedPreviousReviewRoundId = existingRequest
        ? existingRequest.binding?.previousReviewRoundId || null : lastReviewRound?.id || null;
      const requestFingerprint = sha256Text(JSON.stringify({ ...expected, requestId }));
      const currentBinding = Boolean(artifact && execution && currentBindingFailure(task, expected) === null
        && expected.taskId === task.id
        && expected.goalVersionId === task.goalVersionId && expected.executionId === execution.id
        && expected.registrySha256 === task.registry?.registrySha256
        && expected.scopeFingerprint === task.registry?.scopeFingerprint
        && expected.artifactId === artifact.id && expected.artifactVersion === artifact.version
        && expected.candidateSha256 === artifact.candidateSha256 && expected.diffSha256 === artifact.diffSha256
        && !artifact.confirmation && artifact.hostCheck?.passed === true
        && artifact.goalVersionId === task.goalVersionId && artifact.executionId === execution.id
        && artifact.registrySha256 === task.registry.registrySha256 && task.selectedScope?.authorized === true
        && task.selectedScope?.current !== false && task.selectedScope?.goalVersionId === task.goalVersionId
        && task.selectedScope?.projectId === task.registry.projectId
        && task.selectedScope?.scopeFingerprint === task.registry.scopeFingerprint);
      if (existingRequest) {
        const storedBinding = existingRequest.binding || {};
        if (!currentBinding || existingRequest.requestFingerprint !== requestFingerprint
          || storedBinding.artifactId !== artifact.id || storedBinding.artifactVersion !== artifact.version
          || storedBinding.candidateSha256 !== artifact.candidateSha256 || storedBinding.diffSha256 !== artifact.diffSha256
          || storedBinding.taskId !== task.id || storedBinding.goalVersionId !== task.goalVersionId
          || storedBinding.executionId !== execution.id || storedBinding.registrySha256 !== task.registry.registrySha256
          || storedBinding.scopeFingerprint !== task.registry.scopeFingerprint
          || storedBinding.previousReviewId !== expected.previousReviewId
          || (storedBinding.previousReviewRoundId || null) !== expected.previousReviewRoundId) {
          throw Object.assign(new Error('同一开启请求编号已绑定其他审阅轮或候选。'), { statusCode: 409, code: 'REQUEST_ID_REUSED_WITH_DIFFERENT_INPUT' });
        }
        return { ok: true, reviewRoundId: existingRequest.id, status: existingRequest.status, deadlineAt: existingRequest.deadlineAt,
          maxModelCalls: existingRequest.maxModelCalls, modelCalls: (existingRequest.modelCalls || []).length, idempotentReplay: true };
      }
      const hasReviewerSource = hasBoundReviewerSource(task, artifact, artifact?.review);
      const eligibleFailure = settledReviewerFailureForArtifact(task, artifact, hasReviewerSource)
        || completedBoundReviewerFailureForArtifact(task, artifact, hasReviewerSource);
      const exact = currentBinding && expected.previousReviewRoundId === expectedPreviousReviewRoundId
        && expected.previousReviewId === (artifact.review?.id || null) && eligibleFailure;
      if (!exact) throw Object.assign(new Error('当前审阅失败、候选或授权范围不满足开启后续审阅轮的条件。'), { statusCode: 409, code: 'REVIEW_ROUND_BINDING_STALE' });
      execution.reviewRounds ||= [];
      const previousReviewId = artifact.review?.id || null;
      const lastRoundDeadline = Date.parse(lastReviewRound?.deadlineAt || '');
      const lastRoundExpired = !Number.isFinite(lastRoundDeadline) || lastRoundDeadline <= Date.now();
      if (lastReviewRound && (['open', 'running'].includes(lastReviewRound.status) && !lastRoundExpired
        || reviewerRoundHasInFlightWork(lastReviewRound))) {
        throw Object.assign(new Error('前一后续审阅轮尚未结清；不会并发开启新额度。'), { statusCode: 409, code: 'REVIEW_ROUND_PREDECESSOR_ACTIVE' });
      }
      if (lastReviewRound && ['open', 'running'].includes(lastReviewRound.status)) {
        lastReviewRound.status = 'expired';
        lastReviewRound.finishedAt ||= nowIso();
        lastReviewRound.stopReason ||= 'review_round_expired';
      }
      const binding = {
        taskId: task.id, goalVersionId: task.goalVersionId, executionId: execution.id,
        registrySha256: task.registry.registrySha256, scopeFingerprint: task.registry.scopeFingerprint,
        artifactId: artifact.id, artifactVersion: artifact.version, candidateSha256: artifact.candidateSha256,
        diffSha256: artifact.diffSha256, previousReviewId,
        previousReviewRoundId: expected.previousReviewRoundId,
      };
      const round = {
        id: `review-round-${crypto.randomUUID()}`, requestId, requestFingerprint,
        binding: { ...binding, requestId }, expectedReviewId: previousReviewId,
        status: 'open', maxModelCalls: 8, modelCalls: [], sessions: [], omoSessions: [], workItems: [],
        openedAt: nowIso(), deadlineAt: new Date(Date.now() + 20 * 60_000).toISOString(),
      };
      execution.reviewRounds.push(round);
      task.updatedAt = nowIso();
      await this.save();
      return { ok: true, reviewRoundId: round.id, status: round.status, deadlineAt: round.deadlineAt,
        maxModelCalls: round.maxModelCalls, modelCalls: 0 };
      } finally {
        releaseOpen();
      }
    }

    if (action === 'review') {
      const artifact = this.getActiveArtifact(task);
      if (!artifact) throw new Error('当前没有待审阅的候选版本。');
      const roundId = typeof payload.expectedReviewRoundId === 'string' ? payload.expectedReviewRoundId : null;
      const round = roundId ? task.execution?.reviewRounds?.find((item) => item.id === roundId) : null;
      const validRequestId = typeof payload.requestId === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(payload.requestId);
      if (round && !validRequestId) throw Object.assign(new Error('后续审阅轮需要稳定的 Reviewer 请求编号。'), { statusCode: 400, code: 'REVIEW_ROUND_REQUEST_ID_REQUIRED' });
      const requestId = validRequestId ? payload.requestId : crypto.randomUUID();
      const reviewEvidence = String(payload.reviewEvidence || '').trim();
      const requestFingerprint = sha256Text(JSON.stringify({
        goalVersionId: task.goalVersionId, executionId: task.execution?.id,
        registrySha256: task.registry?.registrySha256, artifactId: artifact.id,
        candidateSha256: artifact.candidateSha256, diffSha256: artifact.diffSha256, reviewEvidence,
        reviewRoundId: round?.id || null, previousReviewId: round?.expectedReviewId || null,
      }));
      if (round && round.reviewRequestId === requestId && round.reviewRequestFingerprint === requestFingerprint
        && artifact.review?.requestId === requestId && artifact.review?.requestFingerprint === requestFingerprint
        && artifact.review?.sourceEvidence?.reviewRoundId === round.id) {
        return { ok: true, reviewRoundId: round.id, reviewId: artifact.review.id, verdict: artifact.review.nativeVerdict,
          status: round.status, modelCalls: round.modelCalls.length, idempotentReplay: true };
      }
      if (round && (!round || round.binding?.taskId !== task.id || round.binding?.goalVersionId !== task.goalVersionId
        || round.binding?.executionId !== task.execution?.id || round.binding?.registrySha256 !== task.registry?.registrySha256
        || round.binding?.scopeFingerprint !== task.registry?.scopeFingerprint || round.binding?.artifactId !== artifact.id
        || round.binding?.artifactVersion !== artifact.version || round.binding?.candidateSha256 !== artifact.candidateSha256
        || round.binding?.diffSha256 !== artifact.diffSha256 || !['open', 'running'].includes(round.status)
        || (round.binding?.previousReviewRoundId || null) !== (payload.expectedPreviousReviewRoundId ?? null)
        || payload.expectedTaskId !== task.id || payload.expectedGoalVersionId !== task.goalVersionId
        || payload.expectedExecutionId !== task.execution?.id || payload.expectedRegistrySha256 !== task.registry?.registrySha256
        || payload.expectedArtifactId !== artifact.id || payload.expectedArtifactVersion !== artifact.version
        || payload.expectedCandidateSha256 !== artifact.candidateSha256
        || round.expectedReviewId !== (artifact.review?.id || null)
        || payload.expectedReviewId !== round.expectedReviewId
        || payload.expectedDiffSha256 !== artifact.diffSha256
        || payload.expectedScopeFingerprint !== task.registry?.scopeFingerprint)) {
        throw Object.assign(new Error('审阅轮与当前候选、旧审阅或授权范围不一致。'), { statusCode: 409, code: 'REVIEW_ROUND_BINDING_STALE' });
      }
      const reviewWorkItemId = round ? `work-review-${round.id}-${requestId}` : `work-review-${requestId}`;
      const reviewBinding = snapshotTaskBinding(task, reviewWorkItemId, artifact);
      if (round) Object.assign(reviewBinding, {
        reviewRoundId: round.id, reviewRoundRequestId: round.requestId, previousReviewId: round.expectedReviewId,
        previousReviewRoundId: round.binding?.previousReviewRoundId || null,
      });
      if (round?.reviewRequestId) {
        if (round.reviewRequestId !== requestId || round.reviewRequestFingerprint !== requestFingerprint) {
          throw Object.assign(new Error('本轮已绑定到不同 Reviewer 请求；不会重复启动或替换证据。'), { statusCode: 409, code: 'REVIEW_ROUND_CALL_ALREADY_STARTED' });
        }
        return { ok: true, reviewRoundId: round.id, status: round.status, modelCalls: round.modelCalls.length, idempotentReplay: true };
      }
      const requestLedger = round || task.execution;
      requestLedger.requestFingerprints ||= {};
      const requestKey = `review:${requestId}`;
      if (requestLedger.requestFingerprints[requestKey] && requestLedger.requestFingerprints[requestKey] !== requestFingerprint) {
        const error = new Error('同一审阅请求编号已绑定不同候选或证据；请为新的审阅请求生成新编号。');
        error.statusCode = 409;
        error.code = 'REQUEST_ID_REUSED_WITH_DIFFERENT_INPUT';
        throw error;
      }
      if (!requestLedger.requestFingerprints[requestKey]) {
        requestLedger.requestFingerprints[requestKey] = requestFingerprint;
      }
      if (round) {
        const staleReason = currentBindingFailure(task, reviewBinding);
        if (staleReason) {
          round.status = staleReason === 'review_round_expired' ? 'expired' : 'stale';
          round.finishedAt = nowIso();
          round.stopReason = staleReason;
          await this.save();
          throw Object.assign(new Error(bindingFailureMessage(staleReason)), { statusCode: 409, code: 'REVIEW_ROUND_BINDING_STALE' });
        }
        round.reviewRequestId = requestId;
        round.reviewRequestFingerprint = requestFingerprint;
        round.status = 'running';
        round.workItems ||= [];
      } else {
        await this.rejectStaleRoleBinding(task, reviewBinding);
      }
      await this.save();
      if (!round && artifact.review?.requestId === requestId && artifact.review.id) {
        if (!hasBoundReviewerSource(task, artifact, artifact.review)) {
          throw Object.assign(new Error('同一审阅请求的原结果与当前候选或 Reviewer 调用绑定不完整，未替换现有审阅记录。'), { statusCode: 409 });
        }
        return { ok: true, reviewId: artifact.review.id, verdict: artifact.review.nativeVerdict, idempotentReplay: true };
      }
      const priorRequestCall = requestLedger.modelCalls?.find((call) => call.role === 'Reviewer'
        && call.binding?.workItemId === reviewWorkItemId);
      if (priorRequestCall?.reviewAdoption) {
        const currentReview = artifact.review;
        if (currentReview?.sourceEvidence?.sourceCallId !== priorRequestCall.id
          || currentReview.id !== priorRequestCall.reviewAdoption.reviewId) {
          throw Object.assign(new Error('该审阅请求的旧结果已被更新的审阅取代；不会用旧结果覆盖当前审阅。'), { statusCode: 409 });
        }
        if (!hasBoundReviewerSource(task, artifact, currentReview)) {
          throw Object.assign(new Error('该审阅请求的原结果已失去当前候选绑定；不会重新应用旧结果。'), { statusCode: 409 });
        }
        return { ok: true, reviewId: currentReview.id, verdict: currentReview.nativeVerdict, idempotentReplay: true };
      }
      const project = projects.find((p) => p.projectId === task.registry?.projectId);
      let checkResult;
      try {
        checkResult = await this.hostChecksRunner({
          worktreePath: artifact.worktreePath,
          sourceFilesMap: await readRelativeFileMap(project.rootPath),
          allowedWritePaths: project.allowedWritePaths,
        });
      } catch (error) {
        if (round) {
          round.status = Date.parse(round.deadlineAt) <= Date.now() ? 'expired' : 'failed';
          round.finishedAt = nowIso();
          round.failureReason = safeFailureText(String(error?.message || error), 500) || '审阅前宿主检查失败。';
          await this.save();
        }
        throw error;
      }
      await this.rejectStaleRoleBinding(task, reviewBinding);
      const reviewWorkItem = { id: reviewWorkItemId, agentId: task.execution.reviewerAgentId, actor: 'reviewer', role: 'reviewer', title: '当前候选独立只读复核', status: 'running' };
      if (round) round.workItems.push(reviewWorkItem);
      else {
        task.execution.workItems ||= [];
        task.execution.workItems.push(reviewWorkItem);
      }
      await this.save();
      assertCurrentTaskBinding(task, reviewBinding);
      let reviewResult;
      try {
        reviewResult = await runIndependentReviewerWithOmo({
          task, project, worktreePath: artifact.worktreePath, candidateSha256: artifact.candidateSha256,
          diffSha256: artifact.diffSha256, patchText: artifact.patch, changedFiles: artifact.changedFiles,
          artifactId: artifact.id, artifactVersion: artifact.version,
          checks: checkResult.checks, candidateFilesMap: checkResult.currentFilesMap, extraEvidence: reviewEvidence,
          preferLocalFallback: this.preferLocalFallback,
          runRole: this.preferLocalFallback ? null : (request) => this.runOmoCodexProductRole(task, {
            ...request, workItemId: reviewWorkItemId, artifact, project, expectedBinding: reviewBinding,
          }),
        });
        await this.rejectStaleRoleBinding(task, reviewBinding);
        if (round) reviewResult.reviewRoundId = round.id;
        reviewWorkItem.status = reviewResult.invoked === false && !this.preferLocalFallback ? 'blocked' : 'completed';
      } catch (error) {
        reviewWorkItem.status = 'failed';
        if (round) {
          if (!['stale', 'expired', 'cancelled'].includes(round.status)) {
            round.status = Date.parse(round.deadlineAt) <= Date.now() ? 'expired' : 'failed';
          }
          round.finishedAt = nowIso();
          round.failureReason = safeFailureText(String(error?.message || error), 500) || 'Reviewer 后继轮失败。';
        }
        task.updatedAt = nowIso();
        await this.save();
        throw error;
      }
      const reviewId = `review-omo-${crypto.randomUUID().slice(0, 8)}`;
      const nextReview = {
        id: reviewId,
        passed: reviewResult.passed,
        nativeVerdict: reviewResult.nativeVerdict,
        scopeOutcome: reviewResult.scopeOutcome,
        fullOutputSha256: reviewResult.fullOutputSha256,
        text: reviewResult.text,
        sourceEvidence: reviewerSourceEvidence(task, artifact, reviewResult),
        summary: reviewResult.summary,
        reviewedAt: nowIso(),
        requestId,
        requestFingerprint,
      };
      if (round) {
        if (artifact.review) {
          artifact.reviewHistory ||= [];
          artifact.reviewHistory.push(structuredClone(artifact.review));
        }
        round.status = reviewResult.invoked === false || reviewResult.nativeVerdict === 'UNVERIFIED' ? 'failed' : 'completed';
        round.finishedAt = nowIso();
        round.verdict = reviewResult.nativeVerdict;
        round.failureReason = round.status === 'failed' ? reviewResult.summary : null;
      }
      artifact.review = nextReview;
      markReviewerCallAdopted(task, artifact, artifact.review);
      task.updatedAt = nowIso();
      await this.save();
      return { ok: true, reviewId, verdict: reviewResult.nativeVerdict,
        ...(round ? { reviewRoundId: round.id, status: round.status, modelCalls: round.modelCalls.length } : {}) };
    }

    if (action === 'revise') {
      const reason = String(payload.reason || '').trim();
      if (!reason) throw new Error('请填写退回修改原因。');
      const requestId = typeof payload.requestId === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(payload.requestId)
        ? payload.requestId : null;
      if (!requestId) throw Object.assign(new Error('退回请求缺少稳定的唯一请求编号。'), { statusCode: 400, code: 'REVISION_REQUEST_ID_REQUIRED' });
      const expectedBinding = {
        taskId: task.id,
        goalVersionId: payload.expectedGoalVersionId,
        executionId: payload.expectedExecutionId,
        registrySha256: payload.expectedRegistrySha256,
        scopeFingerprint: payload.expectedScopeFingerprint,
        artifactId: payload.expectedArtifactId,
        artifactVersion: payload.expectedArtifactVersion,
        candidateSha256: payload.expectedCandidateSha256,
      };
      const fingerprint = sha256Text(JSON.stringify({ ...expectedBinding, reason }));
      const execution = task.execution;
      if (!execution) throw Object.assign(new Error('当前没有可绑定的原生执行。'), { statusCode: 409, code: 'REVISION_BINDING_STALE' });
      const requestKey = `revise:${requestId}`;
      const existingFingerprint = execution.requestFingerprints?.[requestKey];
      if (existingFingerprint) {
        if (existingFingerprint !== fingerprint) {
          throw Object.assign(new Error('同一退回请求编号已绑定不同候选、目标、范围或原因。'), { statusCode: 409, code: 'REQUEST_ID_REUSED_WITH_DIFFERENT_INPUT' });
        }
        const previous = task.rejectionHistory.find((item) => item.requestId === requestId && item.requestFingerprint === fingerprint);
        if (previous) return { ok: true, revisionId: previous.revisionId, status: execution.pendingRevision?.id === previous.revisionId ? execution.pendingRevision.status : 'recorded', idempotentReplay: true };
      }
      const artifact = this.getActiveArtifact(task);
      const scope = task.selectedScope;
      if (!artifact || artifact.id !== expectedBinding.artifactId || artifact.version !== expectedBinding.artifactVersion
        || artifact.candidateSha256 !== expectedBinding.candidateSha256 || artifact.confirmation
        || artifact.goalVersionId !== task.goalVersionId || artifact.executionId !== execution.id
        || artifact.registrySha256 !== task.registry?.registrySha256
        || task.goalVersionId !== expectedBinding.goalVersionId || execution?.id !== expectedBinding.executionId
        || task.registry?.registrySha256 !== expectedBinding.registrySha256
        || task.registry?.scopeFingerprint !== expectedBinding.scopeFingerprint
        || scope?.authorized !== true || scope.current === false || scope.goalVersionId !== task.goalVersionId
        || scope.projectId !== task.registry?.projectId || scope.scopeFingerprint !== task.registry?.scopeFingerprint) {
        throw Object.assign(new Error('退回请求与当前候选、目标或授权范围不一致。'), { statusCode: 409, code: 'REVISION_BINDING_STALE' });
      }
      if (execution.pendingRevision?.status === 'running'
        || execution.modelCalls?.some((call) => ['reserved', 'running', 'started', 'in_progress', 'working'].includes(call.status))) {
        throw Object.assign(new Error('当前已有角色调用或退回修订在途；没有记录新的返修请求。'), { statusCode: 409, code: 'REVISION_ALREADY_IN_FLIGHT' });
      }
      const revisionId = `revision-omo-${crypto.randomUUID()}`;
      const revision = {
        id: revisionId, requestId, requestFingerprint: fingerprint, status: 'accepted', reason,
        sourceArtifactId: artifact.id, sourceArtifactVersion: artifact.version,
        sourceCandidateSha256: artifact.candidateSha256, goalVersionId: task.goalVersionId,
        executionId: execution.id, registrySha256: task.registry.registrySha256,
        scopeFingerprint: scope.scopeFingerprint, workItemId: `work-revision-${revisionId}`,
        acceptedAt: nowIso(),
      };
      execution.requestFingerprints ||= {};
      execution.requestFingerprints[requestKey] = fingerprint;
      execution.pendingRevision = revision;
      task.rejectionHistory.push({
        revisionId, requestId, requestFingerprint: fingerprint,
        goalVersionId: task.goalVersionId, executionId: execution.id,
        registrySha256: task.registry.registrySha256, scopeFingerprint: scope.scopeFingerprint,
        artifactId: artifact.id, artifactVersion: artifact.version,
        candidateSha256: artifact.candidateSha256, reason, rejectedAt: nowIso(),
      });
      // Same-run execution is available only for a clean Host-gated partial result.
      const canContinue = canContinueRejectedCandidate(task, artifact);
      task.setupStatus = canContinue ? null : 'ready_to_run';
      task.updatedAt = nowIso();
      await this.save();
      return { ok: true, status: revision.status, revisionId, canContinue };
    }

    if (action === 'instructions') {
      return this.saveTaskInstruction(task, payload);
    }

    if (action === 'goal') {
      const statement = String(payload.statement || '').trim();
      const successCriteria = Array.isArray(payload.successCriteria) ? payload.successCriteria : [];
      const boundaries = Array.isArray(payload.boundaries) ? payload.boundaries : [];
      if (!statement) throw new Error('新版目标不能为空。');
      const nextVersionNum = task.goalVersions.length + 1;
      const newGoalVersionId = `goal-v${nextVersionNum}-${crypto.randomUUID().slice(0, 8)}`;
      task.goalVersionId = newGoalVersionId;
      task.statement = statement;
      task.successCriteria = successCriteria;
      task.boundaries = boundaries;
      task.goalVersions.push({
        id: newGoalVersionId,
        statement,
        successCriteria,
        boundaries,
        createdAt: nowIso(),
      });
      if (task.selectedScope) {
        task.selectedScope.goalVersionId = newGoalVersionId;
      }
      task.setupStatus = task.selectedScope?.authorized ? 'ready_to_run' : 'waiting_scope';
      task.updatedAt = nowIso();
      await this.save();
      return { ok: true, goalVersionId: newGoalVersionId };
    }

    if (action === 'memory_save') {
      const entry = {
        id: `mem-${crypto.randomUUID().slice(0, 8)}`,
        revision: 1,
        kind: payload.kind === 'convention' ? 'convention' : 'preference',
        scopeType: payload.scopeType === 'project' ? 'project' : 'global',
        title: String(payload.title || '记忆条目').trim(),
        text: String(payload.text || '').trim(),
        status: 'active',
        ownerTaskId: task.id,
        source: { type: 'user_explicit', taskId: task.id, eventId: `evt-mem-${Date.now()}`, revision: 1 },
      };
      task.memoryEntries.push(entry);
      task.updatedAt = nowIso();
      await this.save();
      return { ok: true, index: { indexed: true }, entry };
    }

    if (action === 'memory_change') {
      const entry = task.memoryEntries.find((m) => m.id === payload.memoryId);
      if (!entry) throw new Error('未找到对应的记忆条目。');
      entry.revision += 1;
      if (payload.operation === 'delete') entry.status = 'deleted';
      else if (payload.operation === 'deactivate') entry.status = 'deactivated';
      else {
        entry.title = String(payload.title || entry.title).trim();
        entry.text = String(payload.text || entry.text).trim();
        entry.kind = payload.kind === 'convention' ? 'convention' : 'preference';
      }
      task.updatedAt = nowIso();
      await this.save();
      return { ok: true, index: { indexed: true }, entry };
    }

    if (action === 'chat') {
      const text = String(payload.text || '').trim();
      const agentId = payload.agentId || task.execution?.leadAgentId;
      const requestId = typeof payload.requestId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(payload.requestId)
        ? payload.requestId : crypto.randomUUID();
      const chatWorkItemId = `work-chat-${requestId}`;
      const chatBinding = task.execution && task.registry?.registrySha256
        ? snapshotTaskBinding(task, chatWorkItemId) : null;
      const requestFingerprint = sha256Text(JSON.stringify({
        text, agentId, goalVersionId: task.goalVersionId, executionId: task.execution?.id,
        registrySha256: task.registry?.registrySha256,
      }));
      const fingerprintLedger = task.execution
        ? (task.execution.requestFingerprints ||= {})
        : (task.requestFingerprints ||= {});
      const requestKey = `chat:${requestId}`;
      if (fingerprintLedger[requestKey] && fingerprintLedger[requestKey] !== requestFingerprint) {
        const error = new Error('同一对话请求编号已绑定不同内容或执行；请为新的对话生成新编号。');
        error.statusCode = 409;
        error.code = 'REQUEST_ID_REUSED_WITH_DIFFERENT_INPUT';
        throw error;
      }
      if (!fingerprintLedger[requestKey]) {
        fingerprintLedger[requestKey] = requestFingerprint;
        await this.save();
      }
      if (chatBinding) assertCurrentTaskBinding(task, chatBinding);
      const priorReply = task.conversations.find((item) => item.requestId === requestId && item.actor === 'Lead' && item.status === 'completed');
      if (priorReply) return { ok: true, conversationId: priorReply.id, idempotentReplay: true };
      const activeArtifact = this.getActiveArtifact(task);
      const userConversation = {
        id: `conv-user-${requestId}`,
        requestId,
        at: nowIso(),
        actor: 'user',
        status: 'completed',
        text,
        sourceTaskId: task.id,
        agentId,
        role: 'Lead',
        goalVersionId: chatBinding?.goalVersionId || task.goalVersionId || null,
        executionId: chatBinding?.executionId || null,
        registrySha256: chatBinding?.registrySha256 || null,
      };
      task.conversations.push(userConversation);
      const verifiedState = activeArtifact?.review?.passed
        ? `[已实测通过] 候选 v${activeArtifact.version} 已完成固定检查与独立审阅 PASS`
        : task.execution?.plan
          ? '[已实测通过] Lead 执行计划已就绪，等待批准后进入隔离开发'
          : '[仅改完未测] 尚未生成实测候选版本';
      let replyText = [
        `1. 【当前已做到】：${verifiedState}。`,
        `2. 【目标偏差与老功能保护】：当前对话仍绑定目标「${task.statement.slice(0, 48)}」；是否存在偏差须依据候选、检查和审阅结果判断。本条对话没有修改原工程文件。`,
        `3. 【卡点说明】：无技术卡点；针对你问的「${text}」，此对话仅作进度核对，不会静默篡改你的主目标。`,
        `4. 【下一步】：${activeArtifact ? '请前往「成果审阅」打开预览并拍板确认（选项 A）或退回微调（选项 B）。' : '请先在书桌批准计划后自动推进。'}`,
      ].join('\n');
      if (!this.preferLocalFallback && task.execution) {
        try {
          const result = await this.runOmoCodexProductRole(task, {
            role: 'Chat', workItemId: chatWorkItemId, phase: 'chat', project: null, expectedBinding: chatBinding,
            prompt: `你是 iRIXI Personal Agent 的协调者。\n${STE100_PM_REPORTING_PROMPT}\n用户就当前任务「${task.title}」（目标：${task.statement}）发来只读讨论：「${text}」。请严格按上述 4 项简明格式用中文回复，不要承诺自动修改主目标。`,
          });
          await this.rejectStaleRoleBinding(task, chatBinding);
          replyText = result.output.text.trim();
        } catch (error) {
          const staleReason = chatBinding && currentBindingFailure(task, chatBinding);
          if (staleReason) {
            userConversation.status = 'invalidated';
            userConversation.invalidationReason = bindingFailureMessage(staleReason);
            task.updatedAt = nowIso();
            await this.save();
            return { ok: false, error: userConversation.invalidationReason, code: 'STALE_ROLE_BINDING' };
          }
          task.conversations.push({
            id: `conv-agent-${requestId}`,
            requestId,
            at: nowIso(),
            actor: 'Lead',
            role: 'Lead',
            status: 'failed',
            text: `模型回复失败：${error.message}`,
            sourceTaskId: task.id,
            agentId,
            goalVersionId: chatBinding?.goalVersionId || task.goalVersionId || null,
            executionId: chatBinding?.executionId || null,
            registrySha256: chatBinding?.registrySha256 || null,
          });
          task.updatedAt = nowIso();
          await this.save();
          return { ok: false, error: error.message };
        }
      }
      task.conversations.push({
        id: `conv-agent-${requestId}`,
        requestId,
        at: nowIso(),
        actor: 'Lead',
        status: 'completed',
        text: replyText,
        sourceTaskId: task.id,
        agentId,
        goalVersionId: chatBinding?.goalVersionId || task.goalVersionId || null,
        executionId: chatBinding?.executionId || null,
        registrySha256: chatBinding?.registrySha256 || null,
        role: 'Lead',
      });
      task.updatedAt = nowIso();
      await this.save();
      return { ok: true };
    }

    throw new Error(`未支持的动作: ${action}`);
  }

  getActiveArtifact(task) {
    if (!task?.activeArtifactId) return null;
    return task.artifacts.find((a) => a.id === task.activeArtifactId) || null;
  }

  async confirmCandidate(taskId, body = {}) {
    const task = this.state.tasks.find((t) => t.id === taskId);
    if (!task) throw Object.assign(new Error('未找到指定的原生任务。'), { statusCode: 404 });
    const artifact = this.getActiveArtifact(task);
    if (!artifact) throw Object.assign(new Error('当前没有可确认的候选版本。'), { statusCode: 409 });
    const conflict = (message) => Object.assign(new Error(message), { statusCode: 409 });
    const requireEqual = (key, value) => {
      if (typeof body[key] !== 'string' || body[key] !== value) throw conflict(`确认请求的 ${key} 与当前候选不匹配，请刷新后重新核对。`);
    };
    const assertBoundCandidate = ({ createReviewAdjudication = true } = {}) => {
      requireEqual('expectedTaskId', task.id);
      requireEqual('expectedGoalVersionId', task.goalVersionId);
      requireEqual('expectedExecutionId', task.execution?.id);
      requireEqual('expectedRegistrySha256', task.registry?.registrySha256);
      requireEqual('expectedCandidateSha256', artifact.candidateSha256);
      requireEqual('expectedDiffSha256', artifact.diffSha256);
      if (body.artifactId !== artifact.id || body.version !== artifact.version
        || task.activeArtifactId !== artifact.id
        || artifact.goalVersionId !== task.goalVersionId
        || artifact.executionId !== task.execution?.id
        || artifact.registrySha256 !== task.registry?.registrySha256
        || task.execution?.bindingCurrent === false
        || task.registry?.current === false || task.registry?.bindingCurrent === false || task.registry?.status === 'stale'
        || task.selectedScope && (task.selectedScope.current === false || task.selectedScope.authorized === false
          || task.selectedScope.goalVersionId !== task.goalVersionId
          || task.selectedScope.projectId !== task.registry?.projectId
          || task.selectedScope.scopeFingerprint !== task.registry?.scopeFingerprint)) {
        throw conflict('目标、执行、登记或指定候选已变化；未确认任何版本。');
      }
      const checks = artifact.hostCheck?.checks;
      if (artifact.hostCheck?.passed !== true || !Array.isArray(checks) || !checks.length || checks.some((check) => check?.passed !== true)) {
        throw conflict('该候选没有同版通过的 Host 固定检查，不能确认。');
      }
      const review = artifact.review;
      const validReview = review?.id && /^[a-f0-9]{64}$/u.test(review.fullOutputSha256 || '')
        && review.text?.trim() && sha256Text(review.text) === review.fullOutputSha256;
      if (!validReview || !hasBoundReviewerSource(task, artifact, review)) {
        throw conflict('该候选缺少与当前任务、执行、范围和候选相符的已结清 Reviewer 调用证据，不能确认。');
      }
      requireEqual('expectedReviewId', review.id);
      requireEqual('expectedReviewFullOutputSha256', review.fullOutputSha256);
      const adjudication = typeof body.adjudicationReason === 'string' && body.adjudicationReason.trim();
      if (adjudication) {
        if (review.passed !== false || review.nativeVerdict !== 'FAIL' || review.scopeOutcome !== 'findings'
          || review.text.trim().split(/\r?\n/u)[0] !== 'VERDICT: FAIL'
          || !body.authorizationSourceThreadId?.trim() || Buffer.byteLength(body.authorizationSourceThreadId) > 160
          || !body.authorizationText?.trim() || Buffer.byteLength(body.authorizationText) > 1000
          || Buffer.byteLength(adjudication) > 1000) {
          throw conflict('人工裁决必须绑定当前真实 FAIL 报告，并提供明确授权来源与理由；UNVERIFIED 不能裁决确认。');
        }
      } else if (review.passed !== true || review.nativeVerdict !== 'PASS' || review.scopeOutcome !== 'clean'
        || review.text.trim().split(/\r?\n/u)[0] !== 'VERDICT: PASS') {
        throw conflict('普通确认仅允许同一候选的独立 Reviewer 明确 PASS。');
      }
      if (artifact.confirmation) {
        if (artifact.confirmation.artifactVersion === artifact.version
          && artifact.confirmation.goalVersionId === task.goalVersionId
          && artifact.confirmation.candidateSha256 === artifact.candidateSha256
          && artifact.confirmation.diffSha256 === artifact.diffSha256
          && artifact.confirmation.reviewId === review.id
          && artifact.confirmation.reviewFullOutputSha256 === review.fullOutputSha256
          && (!adjudication || artifact.confirmation.reviewAdjudication?.reason === adjudication
            && artifact.confirmation.reviewAdjudication?.diffSha256 === artifact.diffSha256
            && artifact.confirmation.reviewAdjudication?.authorizationSourceThreadId === body.authorizationSourceThreadId
            && artifact.confirmation.reviewAdjudication?.authorizationText === body.authorizationText)
          && Boolean(adjudication) === Boolean(artifact.confirmation.reviewAdjudication)) return { existingConfirmation: artifact.confirmation };
        throw conflict('该版本已有确认记录；原确认不会被覆盖。');
      }
      return { reviewAdjudication: adjudication && createReviewAdjudication ? {
        reviewId: review.id, reviewFullOutputSha256: review.fullOutputSha256, diffSha256: artifact.diffSha256,
        reason: adjudication, decidedBy: 'principal', decidedAt: nowIso(),
        authorizationSourceThreadId: body.authorizationSourceThreadId.trim(), authorizationText: body.authorizationText.trim(),
      } : null };
    };
    const previousConfirmation = assertBoundCandidate().existingConfirmation;
    if (previousConfirmation) return {
      ok: true, approvalId: previousConfirmation.approvalId, artifactId: artifact.id,
      version: artifact.version, patchPath: path.join(this.deliveriesDir, previousConfirmation.delivery?.patchFile || `${task.id}-v${artifact.version}.patch`),
      zipPath: path.join(this.deliveriesDir, previousConfirmation.delivery?.zipFile || `${task.id}-v${artifact.version}.zip`),
      idempotent: true,
    };
    if (this.confirming.has(artifact.id)) throw conflict('该候选正在确认；请等待本次保存结果后刷新。');
    this.confirming.add(artifact.id);
    const approvalId = `approval-omo-${crypto.randomUUID().slice(0, 8)}`;
    const patchFile = `${task.id}-${artifact.id}-${approvalId}.patch`;
    const zipFile = `${task.id}-${artifact.id}-${approvalId}.zip`;
    const patchPath = path.join(this.deliveriesDir, patchFile);
    const zipPath = path.join(this.deliveriesDir, zipFile);
    const tempPatch = `${patchPath}.tmp`;
    const tempZip = `${zipPath}.tmp`;
    let published = false;
    const priorUpdatedAt = task.updatedAt;
    try {
      const snapshot = await this.readCandidateSnapshot(artifact);
      const { reviewAdjudication } = assertBoundCandidate();
      const patchBuffer = Buffer.from(artifact.patch, 'utf8');
      const confirmation = {
        approvalId, artifactVersion: artifact.version, goalVersionId: task.goalVersionId,
        executionId: task.execution.id, registrySha256: task.registry.registrySha256,
        candidateSha256: artifact.candidateSha256, diffSha256: artifact.diffSha256, reviewId: artifact.review.id,
        reviewFullOutputSha256: artifact.review.fullOutputSha256, confirmedAt: nowIso(),
        reviewAdjudication,
      };
      const zipBuffer = await this.buildConfirmedZipBuffer(task, artifact, snapshot, confirmation);
      await fsp.writeFile(tempPatch, patchBuffer, { flag: 'wx' });
      await fsp.writeFile(tempZip, zipBuffer, { flag: 'wx' });
      assertBoundCandidate();
      const rechecked = await this.readCandidateSnapshot(artifact);
      if (rechecked.candidateSha256 !== snapshot.candidateSha256
        || rechecked.patchSha256 !== snapshot.patchSha256) throw conflict('候选文件在确认期间发生变化；未确认任何版本。');
      await fsp.rename(tempPatch, patchPath);
      await fsp.rename(tempZip, zipPath);
      assertBoundCandidate();
      const finalSnapshot = await this.readCandidateSnapshot(artifact);
      if (finalSnapshot.candidateSha256 !== snapshot.candidateSha256
        || finalSnapshot.patchSha256 !== snapshot.patchSha256) throw conflict('候选文件在确认发布期间发生变化；未确认任何版本。');
      const finalBinding = assertBoundCandidate({ createReviewAdjudication: false });
      if (finalBinding.existingConfirmation) throw conflict('该版本已在确认期间完成确认；当前请求不会覆盖原记录。');
      artifact.confirmation = {
        ...confirmation,
        delivery: {
          artifactId: artifact.id, artifactVersion: artifact.version, candidateSha256: artifact.candidateSha256,
          diffSha256: artifact.diffSha256,
          approvalId, patchFile, patchSha256: sha256Buffer(patchBuffer), zipFile, zipSha256: sha256Buffer(zipBuffer),
        },
      };
      task.updatedAt = nowIso();
      try { await this.save(); }
      catch (error) { artifact.confirmation = null; task.updatedAt = priorUpdatedAt; throw error; }
      published = true;
      return { ok: true, approvalId, artifactId: artifact.id, version: artifact.version, patchPath, zipPath };
    } finally {
      this.confirming.delete(artifact.id);
      await fsp.rm(tempPatch, { force: true });
      await fsp.rm(tempZip, { force: true });
      if (!published) {
        await fsp.rm(patchPath, { force: true });
        await fsp.rm(zipPath, { force: true });
      }
    }
  }

  async readCandidateSnapshot(artifact) {
    const fileMap = await readRelativeFileMap(artifact.worktreePath);
    const files = Object.values(fileMap).sort((a, b) => a.path.localeCompare(b.path));
    const expected = Array.isArray(artifact.files) ? [...artifact.files].sort((a, b) => a.path.localeCompare(b.path)) : [];
    if (!files.length || files.length !== expected.length
      || files.some((file, i) => file.path !== expected[i].path || file.bytes !== expected[i].bytes || file.sha256 !== expected[i].sha256)) {
      throw Object.assign(new Error('候选工作树与已检查文件清单不一致；已拒绝确认。'), { statusCode: 409 });
    }
    const candidateSha256 = sha256Text(files.map((file) => `${file.path}:${file.sha256}`).join('|'));
    const patchSha256 = sha256Text(artifact.patch || '');
    if (candidateSha256 !== artifact.candidateSha256 || patchSha256 !== artifact.patchSha256 || patchSha256 !== artifact.diffSha256) {
      throw Object.assign(new Error('候选、差异或补丁摘要与已检查记录不一致；已拒绝确认。'), { statusCode: 409 });
    }
    const buffers = await Promise.all(files.map(async (file) => {
      const data = await fsp.readFile(path.join(artifact.worktreePath, file.path));
      if (data.length !== file.bytes || sha256Buffer(data) !== file.sha256) {
        throw Object.assign(new Error('候选文件在读取期间发生变化；已拒绝确认。'), { statusCode: 409 });
      }
      return { ...file, data };
    }));
    return { files: buffers, candidateSha256, patchSha256 };
  }

  async buildConfirmedZipBuffer(task, artifact, snapshot, confirmation) {
    const entries = [];
    for (const file of snapshot.files) entries.push({ name: `tool/${file.path}`, data: file.data });
    entries.push({
      name: 'changes.patch',
      data: Buffer.from(artifact.patch, 'utf8'),
    });
    entries.push({
      name: 'DELIVERY_MANIFEST.json',
      data: Buffer.from(JSON.stringify({
        harness: 'Oh My OpenAgent (OmO 5.1.40 / Pi Kernel)',
        taskId: task.id,
        title: task.title,
        goalVersionId: artifact.goalVersionId,
        statement: task.statement,
        artifactId: artifact.id,
        artifactVersion: artifact.version,
        candidateSha256: artifact.candidateSha256,
        diffSha256: artifact.diffSha256,
        review: {
          id: artifact.review?.id,
          verdict: artifact.review?.nativeVerdict,
          fullOutputSha256: artifact.review?.fullOutputSha256,
        },
        confirmation,
        files: artifact.files,
      }, null, 2), 'utf8'),
    });
    return createZipBuffer(entries);
  }

  async readConfirmedDelivery(taskId, kind, artifactId, approvalId) {
    const task = this.state.tasks.find((item) => item.id === taskId);
    const artifact = task?.artifacts?.find((item) => item.id === artifactId);
    const confirmation = artifact?.confirmation;
    const conflict = (message) => Object.assign(new Error(message), { statusCode: 409 });
    if (!task || !artifact || !confirmation || !approvalId || confirmation.approvalId !== approvalId) {
      throw conflict('下载链接未绑定到指定的已确认版本。');
    }
    if (confirmation.delivery) {
      const delivery = confirmation.delivery;
      if (delivery.artifactId !== artifact.id || delivery.artifactVersion !== artifact.version
        || delivery.candidateSha256 !== artifact.candidateSha256 || delivery.approvalId !== confirmation.approvalId
        || confirmation.diffSha256 && confirmation.diffSha256 !== artifact.diffSha256
        || delivery.diffSha256 && delivery.diffSha256 !== artifact.diffSha256) {
        throw conflict('已确认交付与成果身份不一致，拒绝下载。');
      }
      const filename = kind === 'patch' ? delivery.patchFile : delivery.zipFile;
      if (!filename || path.basename(filename) !== filename) throw conflict('冻结交付文件记录无效。');
      const buffer = await fsp.readFile(path.join(this.deliveriesDir, filename));
      const expected = kind === 'patch' ? delivery.patchSha256 : delivery.zipSha256;
      if (!/^[a-f0-9]{64}$/u.test(expected || '') || sha256Buffer(buffer) !== expected) throw conflict('冻结交付摘要校验失败，拒绝下载。');
      return { task, artifact, buffer };
    }
    // Legacy confirmations retain their already-written frozen files; never rebuild them from a live worktree.
    const filename = `${task.id}-v${artifact.version}.${kind}`;
    const buffer = await fsp.readFile(path.join(this.deliveriesDir, filename));
    if (kind === 'patch' && artifact.patchSha256 && sha256Buffer(buffer) !== artifact.patchSha256) throw conflict('历史 patch 摘要校验失败，拒绝下载。');
    return { task, artifact, buffer };
  }

  async buildProductState(requestedTaskId = null) {
    const projects = await this.listRegisteredProjects();
    const task = requestedTaskId
      ? this.state.tasks.find((t) => t.id === requestedTaskId)
      : this.getActiveTask();

    if (!task) {
      return {
        task: null,
        status: 'waiting_task',
        conversations: [],
        instructions: [],
        setup: {
          projects,
          selectedProject: null,
          selectedScope: null,
        },
        links: {
          createTask: '/api/product/tasks',
          projects: '/api/product/projects',
        },
        memory: {
          entries: [],
          projectScopeCurrent: false,
          indexAvailable: true,
        },
      };
    }

    const selectedProject = task.selectedScope
      ? projects.find((p) => p.projectId === task.selectedScope.projectId) || null
      : null;

    const setup = {
      projects,
      selectedProject,
      selectedScope: task.selectedScope && selectedProject ? {
        projectId: selectedProject.projectId,
        scopeFingerprint: selectedProject.scopeFingerprint,
        goalVersionId: task.goalVersionId,
        selectedAt: task.selectedScope.selectedAt,
        current: true,
      } : null,
    };

    const confirmedArtifact = task.artifacts.filter((a) => a.confirmation && a.goalVersionId === task.goalVersionId).at(-1) || null;
    const currentResultRecovery = confirmedArtifact && task.execution && task.registry && selectedProject ? {
      canReuseCurrentResult: true,
      taskId: task.id,
      title: task.title,
      goalVersionId: task.goalVersionId,
      projectId: selectedProject.projectId,
      scopeFingerprint: selectedProject.scopeFingerprint,
      reuseInput: {
        mode: 'reuse_current_result',
        expectedGoalVersionId: task.goalVersionId,
        expectedScopeFingerprint: selectedProject.scopeFingerprint,
        expectedExecutionId: task.execution.id,
        expectedRegistrySha256: task.registry.registrySha256,
        expectedArtifactId: confirmedArtifact.id,
        expectedArtifactVersion: confirmedArtifact.version,
        expectedCandidateSha256: confirmedArtifact.candidateSha256,
      },
    } : null;

    // Setup pending states: waiting_scope, waiting_scope_authorization, ready_to_run
    if (task.setupStatus) {
      return {
        task: {
          id: task.id,
          title: task.title,
          functionId: task.functionId,
          statement: task.statement,
          successCriteria: task.successCriteria,
          boundaries: task.boundaries,
          goalVersionId: task.goalVersionId,
        },
        status: task.setupStatus,
        taskLifecycle: {
          status: 'idle',
          inFlight: false,
        },
        setup,
        registry: task.registry,
        execution: task.execution ? {
          id: task.execution.id,
          phase: task.execution.phase,
          bindingCurrent: true,
          deadline: task.execution.deadline,
          modelCalls: task.execution.modelCalls,
          plan: task.execution.plan ? {
            text: task.execution.plan.text, sha256: task.execution.plan.sha256,
            instructionIds: (task.execution.plan.instructionSnapshot?.instructions || []).map((item) => item.id),
          } : null,
        } : null,
        currentResultRecovery,
        conversations: task.conversations || [],
        instructions: task.instructions || [],
        canPrepareRun: task.setupStatus === 'ready_to_run' && Boolean(task.selectedScope?.authorized),
        native: {
          bindingCurrent: false,
          source: 'openoffice-native',
          aiEnabled: this.aiEnabled(),
          modelStatus: this.modelStatus(),
          actions: {
            canScope: true,
            canAuthorizeScope: task.setupStatus === 'waiting_scope_authorization' && Boolean(selectedProject),
            canGoal: true,
            canInstructions: true,
          },
        },
        memory: {
          entries: task.memoryEntries,
          references: [],
          projectScopeCurrent: Boolean(selectedProject),
          indexAvailable: true,
          currentForExecution: true,
          stalePreparedPrompt: false,
        },
        links: {
          createTask: '/api/product/tasks',
          projects: '/api/product/projects',
          actions: `/api/product/tasks/${encodeURIComponent(task.id)}/actions`,
        },
      };
    }

    const artifact = this.getActiveArtifact(task);
    const execution = task.execution;
    const registry = task.registry;
    const isConfirmed = Boolean(artifact?.confirmation);
    const hasArtifact = Boolean(artifact);
    const hasReviewerSource = hasArtifact && hasBoundReviewerSource(task, artifact, artifact.review);
    const settledReviewerFailure = hasArtifact && settledReviewerFailureForArtifact(task, artifact, hasReviewerSource);
    const completedBoundReviewerFailure = hasArtifact
      && completedBoundReviewerFailureForArtifact(task, artifact, hasReviewerSource);
    const previousReviewId = artifact?.review?.id || null;
    const artifactReviewRounds = (execution.reviewRounds || []).filter((round) => round.binding?.artifactId === artifact?.id);
    const reviewRoundRecord = artifactReviewRounds.at(-1) || null;
    const reviewRoundStatus = reviewRoundRecord && ['open', 'running'].includes(reviewRoundRecord.status)
      && Date.parse(reviewRoundRecord.deadlineAt) <= Date.now() ? 'expired' : reviewRoundRecord?.status || null;
    const activeReviewRound = ['open', 'running'].includes(reviewRoundStatus);
    const latestReviewRoundSettled = !reviewerRoundHasInFlightWork(reviewRoundRecord);
    const hostChecks = artifact?.hostCheck?.checks;
    const hostChecksPassed = artifact?.hostCheck?.passed === true && Array.isArray(hostChecks)
      && hostChecks.length > 0 && hostChecks.every((check) => check?.passed === true);
    const reviewRoundBindingCurrent = hasArtifact && currentBindingFailure(task, {
      taskId: task.id, goalVersionId: task.goalVersionId, executionId: execution.id,
      registrySha256: registry.registrySha256, scopeFingerprint: registry.scopeFingerprint,
      artifactId: artifact.id, artifactVersion: artifact.version,
      candidateSha256: artifact.candidateSha256, diffSha256: artifact.diffSha256,
    }) === null;
    const canOpenReviewRound = reviewRoundBindingCurrent
      && (settledReviewerFailure || completedBoundReviewerFailure) && hostChecksPassed && !isConfirmed
      && !activeReviewRound && latestReviewRoundSettled;
    const hasPlan = Boolean(execution?.plan);
    const modelCalls = execution.modelCalls || [];
    const executionCalls = modelCalls.filter((call) => call.role !== 'Chat' && !String(call.binding?.workItemId || '').startsWith('work-chat-'));
    const failedCallCount = executionCalls.filter((call) => call.status === 'failed').length;
    const roleSessions = (execution.omoSessions || []).filter((session) => session.role !== 'Chat'
      && !String(session.workItemId || '').startsWith('work-chat-')
      && session.binding?.taskId === task.id
      && session.binding?.goalVersionId === task.goalVersionId
      && session.binding?.executionId === execution.id
      && session.binding?.registrySha256 === registry.registrySha256);
    const latestRoleSession = roleSessions.at(-1) || null;
    const failedRoleSessionCount = roleSessions.filter((session) => session.status === 'failed').length;
    const latestCall = executionCalls.at(-1) || null;
    const hasInFlightCall = modelCalls.some((call) => ['reserved', 'running', 'started', 'in_progress', 'working'].includes(call.status));
    const settledFailedExecution = !hasArtifact && (latestCall?.status === 'failed' || latestRoleSession?.status === 'failed')
      && !hasInFlightCall && !['completed', 'cancelled'].includes(execution.phase);
    const settledFailureReason = execution.failureReason || latestCall?.failureReason || latestRoleSession?.failureReason
      || (latestRoleSession?.status === 'failed' ? '原生角色会话未完成；历史记录未保存失败原因。' : '');
    const projectedLegacySessionFailure = settledFailedExecution && latestCall?.status !== 'failed' && latestRoleSession?.status === 'failed';
    const projectedExecutionPhase = projectedLegacySessionFailure && execution.phase === 'executing' ? 'partial' : execution.phase;
    const waitingPlanApproval = hasPlan && execution.planApprovalStatus !== 'saved' && !hasArtifact;
    const canRunLead = !hasPlan && !hasArtifact && execution?.phase === 'planned';

    const status = isConfirmed
      ? 'ready_to_export'
      : (waitingPlanApproval || hasArtifact)
        ? 'waiting_user'
        : settledFailedExecution ? 'failed' : 'idle';

    const statusLabel = isConfirmed
      ? `版本 v${artifact.version} 已确认，可导出 ZIP / Patch`
      : hasArtifact
        ? !hostChecksPassed
          ? `候选 v${artifact.version} 已生成 · 宿主固定检查未完整通过`
          : activeReviewRound
            ? reviewRoundStatus === 'open' ? '后续只读审阅轮已开启，尚未启动 Reviewer' : '后续只读审阅轮正在运行'
          : settledReviewerFailure
            ? `候选 v${artifact.version} 的当前 Reviewer 调用已失败；本轮审阅已停止`
          : !hasReviewerSource
            ? `候选 v${artifact.version} 已通过宿主检查 · 尚无有效的同版独立审阅`
            : artifact.review.passed === true
              ? `候选 v${artifact.version} 已通过宿主检查与同版独立审阅`
              : `候选 v${artifact.version} 的同版独立审阅未通过`
        : waitingPlanApproval
          ? 'OmO Lead 已生成执行计划，等待你批准后进入隔离工作树开发'
          : settledFailedExecution ? '本轮已停止'
            : 'OmO 原生后台已就绪，点击开始由 Lead 生成执行计划';

    const nextStep = isConfirmed
      ? '指定版本已经确认；可在成果审阅台下载完整工具包 (.zip) 或补丁 (.patch)。'
      : hasArtifact
        ? !hostChecksPassed
          ? '请查看当前候选的宿主固定检查结果。未完整通过前，不得把独立审阅当作已完成，也不能确认或交付。'
          : activeReviewRound
            ? reviewRoundStatus === 'open' ? '后续审阅轮已明确开启；未点击开始前不会调用模型。' : 'Reviewer 正在同版只读审阅；旧报告与原执行账仍保留。等待本轮结清后再查看结果。'
          : settledReviewerFailure
            ? '当前候选已保留，但本轮 Reviewer 调用已失败且没有在途业务调用；未取得有效审阅结果，不得确认或交付。不会自动重试；后续复审需要明确授权。'
          : !hasReviewerSource
            ? '宿主固定检查已通过，但当前候选尚无有效的同版独立审阅结果；等待审阅完成后再查看成果，不要确认或交付。'
            : artifact.review.passed === true
              ? '当前候选的宿主固定检查与同版独立审阅均已通过；请前往「成果审阅」查看差异、打开实时预览并决定是否确认。'
              : '当前候选的同版独立审阅未通过；请先阅读审阅结果，再决定如何处理。'
        : waitingPlanApproval
          ? '请核对下方 OmO Lead 执行计划；批准后将自动完成隔离工作树开发、语法检查与独立 Reviewer 审阅。'
          : settledFailedExecution ? `本轮已停止，${failedCallCount} 次业务调用失败${failedRoleSessionCount ? `；另有 ${failedRoleSessionCount} 个原生角色会话未完成` : ''}；${execution.plan ? '计划记录已保留' : '尚无计划'}；工作区可能保留未整合改动，但尚未形成候选，不能视为检查或独立审阅通过；原截止 ${execution.deadline || '后台未提供'} 保留，等待明确后续。不会自动重试。${settledFailureReason ? ` 失败信息：${settledFailureReason}` : ''}`
            : '点击「由原生 Lead 开始执行」，让 Irixi 生成当前目标的具体执行计划。';

    return {
      taskId: task.id,
      setup,
      title: task.title,
      functionId: task.functionId,
      goalStatement: task.statement,
      successCriteria: task.successCriteria,
      boundaries: task.boundaries,
      goalVersionId: task.goalVersionId,
      authorityCurrent: true,
      current: true,
      inputMutationBinding: {
        goalVersionId: task.goalVersionId,
        executionId: execution.id,
        registrySha256: registry.registrySha256,
      },
      status,
      taskLifecycle: {
        status: isConfirmed ? 'completed' : settledFailedExecution ? 'failed' : 'idle',
        inFlight: false,
      },
      statusLabel,
      nextStep,
      actor: 'coordinator',
      execution: {
        id: execution.id,
        phase: projectedExecutionPhase,
        stopReason: execution.stopReason || (projectedLegacySessionFailure ? 'settled_role_failure' : null),
        deadline: execution.deadline,
        modelCalls: execution.modelCalls,
        reviewContinuation: execution.reviewContinuation,
      },
      artifact: artifact ? {
        id: artifact.id,
        version: artifact.version,
        candidateSha256: artifact.candidateSha256,
        diffSha256: artifact.diffSha256,
        hostCheck: {
          passed: artifact.hostCheck.passed,
        },
        review: artifact.review ? {
          id: artifact.review.id,
          passed: artifact.review.passed,
          nativeVerdict: artifact.review.nativeVerdict,
          scopeOutcome: artifact.review.scopeOutcome,
          fullOutputSha256: artifact.review.fullOutputSha256,
        } : null,
        reviewHistory: Array.isArray(artifact.reviewHistory) ? artifact.reviewHistory.slice(-8).map((review) => ({
          id: review.id, passed: review.passed === true, nativeVerdict: review.nativeVerdict,
          scopeOutcome: review.scopeOutcome, fullOutputSha256: review.fullOutputSha256, text: review.text,
          reviewedAt: review.reviewedAt,
        })) : [],
        confirmation: artifact.confirmation,
      } : null,
      registeredExecution: {
        goalVersionId: task.goalVersionId,
        displayPrompt: task.statement,
        promptSha256: sha256Text(task.statement),
      },
      team: {
        source: 'openoffice-native',
        agents: execution.agents,
      },
      workItems: execution.workItems,
      conversations: task.conversations || [],
      instructions: task.instructions || [],
      memory: {
        entries: task.memoryEntries,
        references: [],
        projectScopeCurrent: true,
        indexAvailable: true,
        currentForExecution: true,
        stalePreparedPrompt: false,
      },
      canPrepareRun: false,
      currentResultRecovery,
      native: {
        bindingCurrent: true,
        registrySha256: registry.registrySha256,
        source: 'openoffice-native',
        aiEnabled: this.aiEnabled(),
        modelStatus: this.modelStatus(),
        agents: execution.agents,
        runAgentId: execution.leadAgentId,
        phase: projectedExecutionPhase,
        plan: execution.plan ? {
          text: execution.plan.text,
          sha256: execution.plan.sha256,
          instructionSnapshotSha256: execution.plan.instructionSnapshot?.sha256 || null,
          instructionCount: execution.plan.instructionSnapshot?.instructions?.length ?? null,
          instructionIds: (execution.plan.instructionSnapshot?.instructions || []).map((item) => item.id),
        } : null,
        planApprovalStatus: execution.planApprovalStatus,
        sessions: execution.sessions,
        preparationFailures: [],
        reviewRound: reviewRoundRecord ? {
          id: reviewRoundRecord.id, status: reviewRoundStatus,
          expectedReviewId: reviewRoundRecord.expectedReviewId || null,
          previousReviewRoundId: reviewRoundRecord.binding?.previousReviewRoundId || null,
          candidateSha256: reviewRoundRecord.binding?.candidateSha256 || null,
          diffSha256: reviewRoundRecord.binding?.diffSha256 || null,
          scopeFingerprint: reviewRoundRecord.binding?.scopeFingerprint || null,
          remainingCalls: Math.max(0, reviewRoundRecord.maxModelCalls - (reviewRoundRecord.modelCalls || []).length),
          maxModelCalls: reviewRoundRecord.maxModelCalls, modelCalls: (reviewRoundRecord.modelCalls || []).length,
          callUnit: 'CLI 调用',
          deadlineAt: reviewRoundRecord.deadlineAt,
        } : null,
        reviewRoundOffer: canOpenReviewRound ? { maxModelCalls: 8, maxDurationMs: 20 * 60 * 1000 } : null,
        autoReviewContinuation: artifact ? {
          taskId: task.id,
          goalVersionId: task.goalVersionId,
          executionId: execution.id,
          registrySha256: registry.registrySha256,
          scopeFingerprint: registry.scopeFingerprint,
          artifactId: artifact.id,
          artifactVersion: artifact.version,
          candidateSha256: artifact.candidateSha256,
          authorized: true,
          status: !hostChecksPassed ? 'blocked_host_checks' : settledReviewerFailure ? 'blocked_or_failed' : hasReviewerSource ? 'completed' : 'awaiting_review',
          dispatchEventId: execution.reviewContinuation?.dispatchEventId || null,
          reviewRoundId: null,
          maxModelCalls: 1,
          maxDurationMs: 20 * 60 * 1000,
          deadlineAt: execution.deadline,
          error: null,
        } : null,
        actions: {
          phase: execution.phase,
          canRun: canRunLead,
          canApprovePlan: waitingPlanApproval,
          canReview: hasArtifact && !isConfirmed && (reviewRoundStatus === 'open'
            || !settledReviewerFailure && !activeReviewRound && !artifactReviewRounds.length),
          canReviewSameRun: hasArtifact && !isConfirmed && !settledReviewerFailure && !completedBoundReviewerFailure
            && !hasReviewerSource && !artifactReviewRounds.length && !activeReviewRound,
          canOpenReviewRound,
          canReconnectReview: false,
          canConfirm: hasArtifact && artifact.review?.passed === true && hasReviewerSource && !isConfirmed,
          canAdjudicateConfirm: hasArtifact && artifact.review?.passed === false && hasReviewerSource && !isConfirmed,
          canPreview: hasArtifact,
          canGoal: true,
          canScope: false,
          canAuthorizeScope: false,
          canPause: false,
          canCancel: Boolean(reviewRoundRecord && activeReviewRound),
          canChat: true,
          canInstructions: true,
          canMaterials: false,
          canInspectDiff: hasArtifact,
          canRevise: hasArtifact && !isConfirmed,
          canContinue: canContinueRejectedCandidate(task, artifact),
          revisionId: execution.pendingRevision?.status === 'accepted' ? execution.pendingRevision.id : null,
        },
      },
      product: {
        projectId: selectedProject?.projectId || registry.projectId,
        registrySha256: registry.registrySha256,
        bindingCurrent: true,
        bindingError: null,
        workspaceScopeFingerprint: registry.scopeFingerprint,
        allowedWritePaths: selectedProject?.allowedWritePaths || ['index.html', 'app.js', 'core.js', 'styles.css'],
        checks: ['check-scope-boundary', 'check-js-syntax', 'check-html-entry'],
        capabilities: {
          team: true,
          worktree: true,
          staticPreviewEntries: ['index.html'],
          staticPreviewFiles: ['index.html', 'app.js', 'core.js', 'styles.css'],
          autoMerge: true,
          manualMerge: true,
          commandPreview: false,
        },
        native: {
          allowedRoles: ALLOWED_ROLES,
          maxModelCalls: 8,
          maxDurationMs: 20 * 60 * 1000,
        },
      },
      preview: task.preview,
      previewLink: task.preview ? `/product-preview/${task.preview.token}/${task.preview.entry}` : null,
      links: {
        createTask: '/api/product/tasks',
        projects: '/api/product/projects',
        nativeTask: `/?backend=openoffice&taskId=${encodeURIComponent(task.id)}`,
        actions: `/api/product/tasks/${encodeURIComponent(task.id)}/actions`,
        candidate: hasArtifact ? `/api/product/tasks/${encodeURIComponent(task.id)}/candidate` : null,
        confirm: hasArtifact ? `/api/product/tasks/${encodeURIComponent(task.id)}/confirm` : null,
        patch: isConfirmed ? `/api/product/tasks/${encodeURIComponent(task.id)}/patch` : null,
        zip: isConfirmed ? `/api/product/tasks/${encodeURIComponent(task.id)}/zip` : null,
        preview: task.preview ? `/product-preview/${task.preview.token}/${task.preview.entry}` : null,
      },
    };
  }

  buildCandidateResponse(taskId) {
    const task = this.state.tasks.find((t) => t.id === taskId);
    if (!task) {
      const err = new Error('未找到指定的原生任务。');
      err.statusCode = 404;
      throw err;
    }
    const artifact = this.getActiveArtifact(task);
    if (!artifact) {
      const err = new Error('当前任务尚无候选版本。');
      err.statusCode = 404;
      throw err;
    }
    return {
      taskId: task.id,
      goalVersionId: task.goalVersionId,
      artifactId: artifact.id,
      artifactVersion: artifact.version,
      candidateSha256: artifact.candidateSha256,
      diffSha256: artifact.diffSha256,
      patchSha256: artifact.patchSha256,
      patch: artifact.patch,
      files: artifact.files,
      checks: artifact.hostCheck.checks,
      review: artifact.review,
      confirmation: artifact.confirmation,
    };
  }

  async listTaskDirectory() {
    const projects = await this.listRegisteredProjects();
    const projectMap = new Map(projects.map((p) => [p.projectId, p.label]));
    return {
      activeTaskId: this.state.activeTaskId,
      activeTaskRevision: this.state.activeTaskRevision,
      tasks: this.state.tasks.map((task) => {
        const artifact = this.getActiveArtifact(task);
        const projectId = task.registry?.projectId || task.selectedScope?.projectId || null;
        const executionFailed = task.execution?.phase === 'failed' || task.execution?.phase === 'partial'
          || task.execution?.modelCalls?.some((call) => call.status === 'failed');
        const deliveryStatusLabel = artifact?.confirmation
          ? '已确认交付'
          : artifact?.review?.passed === false
            ? '审阅未通过 · 未交付'
            : artifact
              ? '已有候选 · 尚未交付'
              : executionFailed
                ? '执行失败 · 尚未交付'
                : task.execution?.plan
                  ? '已有计划 · 尚未交付'
                  : '尚无成果 · 未交付';
        return {
          id: task.id,
          title: task.title,
          functionId: task.functionId,
          status: artifact?.confirmation
            ? 'ready_to_export'
            : artifact
              ? 'waiting_user'
              : task.setupStatus || 'idle',
          inFlight: false,
          updatedAt: task.updatedAt,
          projectId,
          projectLabel: projectId ? projectMap.get(projectId) || projectId : null,
          deliveryStatusLabel,
          currentVersionLabel: artifact
            ? `v${artifact.version} (${artifact.confirmation ? '已确认' : artifact.review?.nativeVerdict || '待审阅'})`
            : '尚未生成候选版本',
        };
      }),
    };
  }
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function serveMappedFile(res, rootDir, relativePath) {
  let decoded;
  try {
    decoded = decodeURIComponent(String(relativePath || ''));
  } catch {
    sendJson(res, 404, { error: { message: '未找到资源。' } });
    return;
  }
  if (!decoded || decoded.includes('\0')) {
    sendJson(res, 404, { error: { message: '未找到资源。' } });
    return;
  }
  try {
    const root = await fsp.realpath(rootDir);
    const candidate = path.resolve(root, decoded.replace(/^[/\\]+/, ''));
    if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
      sendJson(res, 404, { error: { message: '未找到资源。' } });
      return;
    }
    const realFile = await fsp.realpath(candidate);
    if (realFile !== root && !realFile.startsWith(`${root}${path.sep}`)) {
      sendJson(res, 404, { error: { message: '未找到资源。' } });
      return;
    }
    const stat = await fsp.stat(realFile);
    if (!stat.isFile()) {
      sendJson(res, 404, { error: { message: '未找到资源。' } });
      return;
    }
    const content = await fsp.readFile(realFile);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(realFile).toLowerCase()] || 'application/octet-stream',
      'Content-Length': content.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(content);
  } catch {
    sendJson(res, 404, { error: { message: '未找到资源。' } });
  }
}

export async function createOmoPilotServer(options = {}) {
  const controller = new OmoPilotController(options);
  await controller.init();
  const codexRuntime = controller.modelStatus();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
      const pathname = url.pathname;

      // Redirect root `/` without `?backend=openoffice` to `/?backend=openoffice` so the UI immediately loads in Native mode
      if (req.method === 'GET' && pathname === '/' && !url.searchParams.has('backend')) {
        res.writeHead(302, { Location: '/?backend=openoffice' });
        res.end();
        return;
      }

      if (req.method === 'GET' && pathname === '/api/product-health') {
        const activeTask = controller.getActiveTask();
        sendJson(res, 200, {
          ok: true,
          mode: activeTask ? 'native_product_or_setup' : 'waiting_task',
          aiEnabled: controller.aiEnabled(),
          modelStatus: controller.modelStatus(),
          harness: {
            name: 'Codex CLI role adapter',
            ...codexRuntime,
          },
        });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/product-state') {
        const taskId = url.searchParams.get('taskId') || null;
        const state = await controller.buildProductState(taskId);
        sendJson(res, 200, state);
        return;
      }

      if (req.method === 'GET' && pathname === '/api/product/projects') {
        const projects = await controller.listRegisteredProjects();
        sendJson(res, 200, { projects });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/product/projects') {
        const body = await readJsonBody(req);
        const project = await controller.createUtilityProject(body);
        sendJson(res, 201, { ok: true, project });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/product/tasks') {
        const dir = await controller.listTaskDirectory();
        sendJson(res, 200, dir);
        return;
      }

      if (req.method === 'POST' && pathname === '/api/product/tasks') {
        const body = await readJsonBody(req);
        const task = await controller.createTask(body);
        const state = await controller.buildProductState(task.id);
        sendJson(res, 201, state);
        return;
      }

      const selectMatch = pathname.match(/^\/api\/product\/tasks\/([^/]+)\/select$/);
      if (req.method === 'POST' && selectMatch) {
        const taskId = decodeURIComponent(selectMatch[1]);
        const body = await readJsonBody(req);
        await controller.selectTask(taskId, body);
        const state = await controller.buildProductState(taskId);
        sendJson(res, 200, state);
        return;
      }

      const actionsMatch = pathname.match(/^\/api\/product\/tasks\/([^/]+)\/actions$/);
      if (req.method === 'POST' && actionsMatch) {
        const taskId = decodeURIComponent(actionsMatch[1]);
        const body = await readJsonBody(req);
        const result = await controller.handleTaskAction(taskId, body);
        sendJson(res, 200, result);
        return;
      }

      const candidateMatch = pathname.match(/^\/api\/product\/tasks\/([^/]+)\/candidate$/);
      if (req.method === 'GET' && candidateMatch) {
        const taskId = decodeURIComponent(candidateMatch[1]);
        const candidate = controller.buildCandidateResponse(taskId);
        sendJson(res, 200, candidate);
        return;
      }

      const confirmMatch = pathname.match(/^\/api\/product\/tasks\/([^/]+)\/confirm$/);
      if (req.method === 'POST' && confirmMatch) {
        const taskId = decodeURIComponent(confirmMatch[1]);
        const body = await readJsonBody(req);
        const result = await controller.confirmCandidate(taskId, body);
        sendJson(res, 200, result);
        return;
      }

      const patchMatch = pathname.match(/^\/api\/product\/tasks\/([^/]+)\/patch$/);
      if (req.method === 'GET' && patchMatch) {
        const taskId = decodeURIComponent(patchMatch[1]);
        const { task, artifact, buffer } = await controller.readConfirmedDelivery(taskId, 'patch', url.searchParams.get('artifactId'), url.searchParams.get('approvalId'));
        res.writeHead(200, {
          'Content-Type': 'text/x-diff; charset=utf-8',
          'Content-Disposition': `attachment; filename="${task.id}-v${artifact.version}.patch"`,
        });
        res.end(buffer);
        return;
      }

      const zipMatch = pathname.match(/^\/api\/product\/tasks\/([^/]+)\/zip$/);
      if (req.method === 'GET' && zipMatch) {
        const taskId = decodeURIComponent(zipMatch[1]);
        const { task, artifact, buffer: zipBuf } = await controller.readConfirmedDelivery(taskId, 'zip', url.searchParams.get('artifactId'), url.searchParams.get('approvalId'));
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${task.id}-v${artifact.version}.zip"`,
        });
        res.end(zipBuf);
        return;
      }

      const previewMatch = pathname.match(/^\/product-preview\/([^/]+)\/(.+)$/);
      if (req.method === 'GET' && previewMatch) {
        const token = decodeURIComponent(previewMatch[1]);
        const relFile = decodeURIComponent(previewMatch[2]);
        const entry = controller.previewTokens.get(token);
        if (!entry || relFile.includes('..')) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('预览令牌无效或已过期');
          return;
        }
        const filePath = path.join(entry.worktreePath, relFile);
        if (!filePath.startsWith(entry.worktreePath) || !fs.existsSync(filePath)) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('预览文件不存在');
          return;
        }
        const ext = path.extname(filePath);
        const content = await fsp.readFile(filePath);
        res.writeHead(200, {
          'Content-Type': MIME[ext] || 'application/octet-stream',
          'Cache-Control': 'no-store',
        });
        res.end(content);
        return;
      }

      if (req.method === 'GET' && pathname === '/vendor/phaser.min.js') {
        return serveMappedFile(res, VENDOR_DIR, 'phaser/dist/phaser.min.js');
      }
      if (req.method === 'GET' && pathname === '/vendor/easystar.min.js') {
        return serveMappedFile(res, VENDOR_DIR, 'easystarjs/bin/easystar-0.4.4.min.js');
      }
      if (req.method === 'GET' && pathname.startsWith('/assets/')) {
        return serveMappedFile(res, ART_DIR, pathname.slice('/assets/'.length));
      }

      // Serve static Victorian Office UI from `app/public/`
      if (req.method === 'GET') {
        const relPath = pathname === '/' ? 'index.html' : pathname.slice(1);
        const safePath = path.normalize(path.join(PUBLIC_DIR, relPath));
        if (safePath.startsWith(PUBLIC_DIR) && fs.existsSync(safePath) && fs.statSync(safePath).isFile()) {
          const ext = path.extname(safePath);
          const content = await fsp.readFile(safePath);
          res.writeHead(200, {
            'Content-Type': MIME[ext] || 'application/octet-stream',
            'Cache-Control': 'no-store',
          });
          res.end(content);
          return;
        }
      }

      sendJson(res, 404, { error: { message: `未找到路径: ${pathname}` } });
    } catch (error) {
      const status = error.statusCode || 400;
      sendJson(res, status, {
        error: {
          code: error.code || 'OMO_PILOT_ERROR',
          message: error.message || '处理请求时发生错误',
        },
      });
    }
  });

  return { server, controller };
}

const isMainModule =
  Boolean(process.argv[1]) &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isMainModule) {
  const port = Number(process.env.PORT || 3848);
  const host = process.env.HOST || '127.0.0.1';
  const { server } = await createOmoPilotServer();
  server.on('error', (err) => {
    console.error(`[iRIXI OmO Server Error] ${err?.stack || err?.message || err}`);
    process.exit(1);
  });
  server.listen(port, host, () => {
    console.log(`iRIXI × OmO Harness 独立试点副本已启动：http://${host}:${port}/?backend=openoffice`);
  });
}

