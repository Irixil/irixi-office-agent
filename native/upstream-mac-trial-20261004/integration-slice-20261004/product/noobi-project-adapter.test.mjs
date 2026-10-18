import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import {
  assertAuthorityProjection, buildAuthorityProjection, fingerprint,
} from '../authority/authority-core.mjs';
import {
  assertExplicitProjectRoot, createNoobiProjectAdapter, NOOBI_HEAD, NOOBI_ROOT,
  officeExecutionIdentity, officeProjectIdentity,
} from './noobi-project-adapter.mjs';

const office = { taskId: 'office-task-001', projectId: 'noobi-owl-book-sorter-v1' };
const scopeFingerprint = 'a'.repeat(64);
const sourceSnapshotSha256 = 'b'.repeat(64);
const goalVersionId = 'goal-001';
const registryBase = (taskRecord, runId) => {
  const taskInputBindingSha256 = fingerprint(taskRecord.projectWorkspace.taskInputBinding);
  const pipelineBinding = {
    taskId: taskRecord.id,
    goalVersionId,
    projectRootGoalVersionId: null,
    projectRootInputFingerprint: null,
    materialApplicabilityFingerprint: null,
    instructionIds: [],
    taskInputBindingSha256,
    workspaceScopeFingerprint: scopeFingerprint,
    sourceSnapshotSha256,
    executionId: runId,
  };
  return {
    taskInputBindingSha256,
    pipelineBindingSha256: fingerprint(pipelineBinding),
  };
};

function authoritySnapshot(runId, candidateRoot, registeredRoot = '/registered/source', sourceManifest = null) {
  const taskInputBinding = {
    projectRootGoalVersionId: null,
    projectRootInputFingerprint: null,
    materialApplicabilityFingerprint: null,
    instructionIds: [],
  };
  const taskRecord = {
    id: office.taskId,
    title: 'Adapter contract fixture',
    type: 'project',
    status: 'waiting_user',
    goal: { activeVersionId: goalVersionId },
    execution: { id: runId, phase: 'executing', goalVersionId, modelCalls: [], limits: { maxConcurrentModelCalls: 1 } },
    projectWorkspace: { status: 'ready', taskInputBinding, scopeFingerprint, sourceSnapshotSha256 },
    artifacts: [], reviews: [], approvals: [], events: [],
  };
  const helpers = {
    activeGoal: () => ({ id: goalVersionId, statement: 'Adapter test goal' }),
    projectTaskBinding: () => taskInputBinding,
    projectWorkspaceIsCurrent: () => true,
    artifactInputIsCurrent: () => true,
  };
  const bindingHashes = registryBase(taskRecord, runId);
  const registry = {
    taskId: office.taskId,
    goalVersionId,
    ...bindingHashes,
    projectId: office.projectId,
    workspace: { path: registeredRoot, sourceHead: 'f'.repeat(40), scopeFingerprint, sourceSnapshotSha256,
      sourceManifest: sourceManifest || ['index.html', 'package.json', 'src/main.js', 'src/style.css'].map((path) => ({ path })) },
    native: { maxModelCalls: 8 },
    capabilities: { staticPreviewEntries: ['index.html'] },
  };
  const registrySha256 = fingerprint(registry);
  const candidate = {
    version: 1,
    kind: 'native_worktree_candidate_v1',
    candidateSha256: 'c'.repeat(64),
    diffSha256: 'd'.repeat(64),
    patchSha256: 'e'.repeat(64),
    taskInputBinding,
    workspaceScopeFingerprint: scopeFingerprint,
    sourceSnapshotSha256,
    registrySha256,
    nativeWorkspace: candidateRoot,
    manifest: sourceManifest || [],
    checks: [{ passed: true, candidateSha256: 'c'.repeat(64) }],
  };
  const artifact = {
    id: 'artifact-001', version: 1, status: 'candidate', reviewStatus: 'pending', goalVersionId,
    nativeProjectCandidate: candidate,
  };
  taskRecord.artifacts.push(artifact);
  taskRecord.events.push({ type: 'integration.product_registry_registered', id: 'event-registry-1', detail: { registry, registrySha256 } });
  const projection = assertAuthorityProjection(buildAuthorityProjection(taskRecord, helpers));
  return { task: taskRecord, projection };
}

test('generates and validates the existing Authority projection shape; rejects mismatched task binding', async () => {
  assert.equal(NOOBI_HEAD, '21729721f342c273efd19206bba1922923312407');
  assert.throws(() => officeProjectIdentity({ taskId: 'same', projectId: 'same' }), /distinct/);
  const snapshot = authoritySnapshot('office-run-current', '/tmp/candidate-root');
  assert.equal(snapshot.projection.current, true);
  assert.equal(snapshot.projection.productRegistry.current, true);
  assert.equal(snapshot.projection.productRegistry.workspace.scopeFingerprint, snapshot.projection.workspace.scopeFingerprint);
  assert.equal(officeExecutionIdentity(snapshot.task, snapshot.projection).runId, 'office-run-current');
  assert.throws(() => officeExecutionIdentity({ ...snapshot.task, id: 'other-task' }, snapshot.projection), /TaskStore binding/);
  assert.throws(() => officeExecutionIdentity(snapshot.task, { ...snapshot.projection, taskId: 'other-task' }), /Authority projection digest/);
});

test('keeps project scope explicit and does not permit a sibling root', async () => {
  const parentRoot = await mkdtemp(path.join(os.tmpdir(), 'noobi-scope-'));
  try {
    await assert.rejects(assertExplicitProjectRoot(parentRoot, parentRoot), /direct child/);
    await assert.rejects(assertExplicitProjectRoot(parentRoot, `${parentRoot}-sibling`), /direct child/);
    const checked = await assertExplicitProjectRoot(parentRoot, path.join(parentRoot, 'chosen'));
    assert.equal(checked.parentRoot, await realpath(parentRoot));
    assert.equal(checked.projectRoot, path.join(checked.parentRoot, 'chosen'));
  } finally { await rm(parentRoot, { recursive: true, force: true }); }
});

// External Noobi installation replay is retained only in the development workspace.
