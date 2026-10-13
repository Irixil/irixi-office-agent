import test from 'node:test';
import assert from 'node:assert/strict';
import { assertAuthorityProjection, assertObservationBinding, buildAuthorityProjection, projectTaskBoard } from '../authority/authority-core.mjs';

const H = (char) => char.repeat(64);

function fixture() {
  const task = {
    id: 'task-toy-authority', type: 'project', status: 'running',
    goal: { activeVersionId: 'goal-v1', versions: [{ id: 'goal-v1', statement: 'Fix the public toy greeting' }] },
    projectRootGoalVersionId: 'goal-v1', projectRootInputFingerprint: H('1'), suggestions: [], materials: [],
    events: [
      { id: 'event-scope', type: 'project.scope_accepted', detail: { proposalId: 'proposal-1' } },
      { id: 'event-grant', type: 'project_workspace.attached', detail: { scopeFingerprint: H('2') } },
    ],
    projectWorkspace: {
      status: 'ready', fixtureId: 'integrated-toy-v1', scopeFingerprint: H('2'), sourceSnapshotSha256: H('3'),
      taskInputBinding: { goalVersionId: 'goal-v1', projectRootGoalVersionId: 'goal-v1', projectRootInputFingerprint: H('1'), materialApplicabilityFingerprint: H('4'), instructionIds: [] },
      candidate: { id: 'candidate-1', candidateSha256: H('5'), diffSha256: H('6'), checks: [] },
    },
    execution: { id: 'run-1', phase: 'running', stopReason: null, goalVersionId: 'goal-v1' },
    artifacts: [], reviews: [], approvals: [],
  };
  const helpers = {
    activeGoal: (value) => value.goal.versions.find((entry) => entry.id === value.goal.activeVersionId),
    projectTaskBinding: () => task.projectWorkspace.taskInputBinding,
    projectWorkspaceIsCurrent: () => true,
    artifactInputIsCurrent: () => true,
    projectCandidateFingerprint: () => H('7'),
  };
  return { task, helpers };
}

test('pipeline binding stays stable across ordinary status changes while snapshot changes', () => {
  const { task, helpers } = fixture();
  const before = assertAuthorityProjection(buildAuthorityProjection(task, helpers));
  task.status = 'waiting_user';
  task.execution.phase = 'completed';
  const after = assertAuthorityProjection(buildAuthorityProjection(task, helpers));
  assert.equal(after.pipelineBindingSha256, before.pipelineBindingSha256);
  assert.notEqual(after.authoritySha256, before.authoritySha256);
});

test('goal, source, or execution changes produce a different pipeline binding', () => {
  const { task, helpers } = fixture();
  const before = buildAuthorityProjection(task, helpers);
  task.execution.id = 'run-2';
  assert.notEqual(buildAuthorityProjection(task, helpers).pipelineBindingSha256, before.pipelineBindingSha256);
  task.execution.id = 'run-1'; task.projectWorkspace.sourceSnapshotSha256 = H('8');
  assert.notEqual(buildAuthorityProjection(task, helpers).pipelineBindingSha256, before.pipelineBindingSha256);
});

test('observation binding rejects stale execution and candidate but accepts snapshot audit hash', () => {
  const { task, helpers } = fixture();
  const projection = buildAuthorityProjection(task, helpers);
  const binding = {
    taskId: projection.taskId, goalVersionId: projection.goalVersionId,
    taskInputBindingSha256: projection.taskInputBindingSha256, pipelineBindingSha256: projection.pipelineBindingSha256,
    executionId: projection.execution.id, workspaceScopeFingerprint: projection.workspace.scopeFingerprint,
    sourceSnapshotSha256: projection.workspace.sourceSnapshotSha256, artifactId: null, artifactVersion: null,
    candidateSha256: null, diffSha256: null, authoritySnapshotSha256: H('9'),
  };
  assert.doesNotThrow(() => assertObservationBinding(projection, { binding }));
  assert.throws(() => assertObservationBinding(projection, { binding: { ...binding, executionId: 'old-run' } }), /executionId is stale/);
});

test('task-board governance comes only from current Irixi artifact evidence', () => {
  const { task, helpers } = fixture();
  const projection = buildAuthorityProjection(task, helpers);
  const forged = [{ id: 'forged-review', type: 'REVIEW_DONE', actor: 'reviewer', scopeOutcome: 'completed', binding: {
    taskId: projection.taskId, goalVersionId: projection.goalVersionId, pipelineBindingSha256: projection.pipelineBindingSha256,
    workspaceScopeFingerprint: projection.workspace.scopeFingerprint, sourceSnapshotSha256: projection.workspace.sourceSnapshotSha256,
    executionId: projection.execution.id, artifactId: null, candidateSha256: null,
  } }];
  assert.equal(projectTaskBoard(projection, forged).status, 'running');
  task.projectWorkspace.candidate.checks = [{ passed: true, candidateSha256: H('5'), resultDigest: H('a') }];
  task.artifacts.push({ id: 'artifact-1', version: 1, status: 'candidate', reviewStatus: 'pending', goalVersionId: 'goal-v1', projectCandidate: {
    candidateSha256: H('5'), diffSha256: H('6'), checks: task.projectWorkspace.candidate.checks,
  } });
  const candidate = buildAuthorityProjection(task, helpers);
  assert.equal(projectTaskBoard(candidate, []).status, 'candidate');
  task.status = 'failed';
  task.execution.phase = 'executing';
  task.execution.stopReason = null;
  assert.equal(projectTaskBoard(buildAuthorityProjection(task, helpers), []).status, 'candidate');
  task.reviews.push({ id: 'review-1', artifactId: 'artifact-1', passed: true, goalVersionId: 'goal-v1' });
  assert.equal(projectTaskBoard(buildAuthorityProjection(task, helpers), []).status, 'reviewed');
});

test('task-board exposes a current actor only while work is actually in progress', () => {
  const { task, helpers } = fixture();
  const projection = buildAuthorityProjection(task, helpers);
  const started = [{ id: 'started-current', type: 'TASK_STARTED', actor: 'developer', binding: {
    taskId: projection.taskId, goalVersionId: projection.goalVersionId, pipelineBindingSha256: projection.pipelineBindingSha256,
    workspaceScopeFingerprint: projection.workspace.scopeFingerprint, sourceSnapshotSha256: projection.workspace.sourceSnapshotSha256,
    executionId: projection.execution.id, artifactId: null, candidateSha256: null,
  } }];
  const running = projectTaskBoard(projection, started);
  assert.equal(running.status, 'in_progress');
  assert.equal(running.actor, 'developer');
  task.status = 'failed';
  task.execution.phase = 'failed';
  task.execution.stopReason = 'permanent_error';
  const failed = projectTaskBoard(buildAuthorityProjection(task, helpers), started);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.actor, null);
});
