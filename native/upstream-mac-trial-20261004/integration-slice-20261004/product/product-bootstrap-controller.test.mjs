import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createProductBootstrapController, groupPromptMaterials } from './product-bootstrap-controller.mjs';

const SCOPE = 'a'.repeat(64);
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);

async function fixture(t, catalog = [], projectAuthorization) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'product-bootstrap-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const app = path.join(root, 'app');
  const tasks = path.join(root, 'tasks');
  await fs.mkdir(app, { recursive: true });
  await fs.writeFile(path.join(app, 'core.mjs'), `
    import crypto from 'node:crypto';
    import fs from 'node:fs/promises';
    import path from 'node:path';
    const activeGoal = (task) => task.goal.versions.find((item) => item.id === task.goal.activeVersionId);
    export { activeGoal };
    export function event(task, type, message, detail = {}) {
      const item = { id: 'event-' + crypto.randomUUID(), at: new Date().toISOString(), type, message, detail };
      task.events.push(item); task.updatedAt = item.at; return item;
    }
    export function createTask(input) {
      const id = 'task-' + crypto.randomUUID(), goalId = 'goal-' + crypto.randomUUID(), at = new Date().toISOString();
      const goal = { id: goalId, version: 1, statement: String(input.goal).trim().slice(0, 4000),
        successCriteria: input.successCriteria.map((x) => String(x).trim().slice(0, 500)).slice(0, 12),
        boundaries: input.boundaries.map((x) => String(x).trim().slice(0, 500)).slice(0, 12) };
      return { id, title: input.title || goal.statement.slice(0, 42), type: 'project', status: 'idle', execution: null,
        goal: { activeVersionId: goalId, versions: [goal] }, suggestions: [], materials: [], events: [], createdAt: at, updatedAt: at };
    }
    export function addSuggestion(task, input) {
      const goal = activeGoal(task), item = { id: 'suggestion-' + crypto.randomUUID(), text: input.text,
        classification: input.classification, author: input.author, status: 'routed', goalVersionId: goal.id,
        createdAt: new Date().toISOString() };
      task.suggestions ??= []; task.suggestions.push(item); return item;
    }
    export function acceptGoalReplacement(task, suggestionId, input) {
      const prior = activeGoal(task), goal = { id: 'goal-' + crypto.randomUUID(), version: prior.version + 1,
        statement: input.statement, successCriteria: structuredClone(input.successCriteria), boundaries: structuredClone(input.boundaries) };
      task.goal.versions.push(goal); task.goal.activeVersionId = goal.id;
      const suggestion = task.suggestions.find((item) => item.id === suggestionId); if (suggestion) suggestion.status = 'accepted';
      return goal;
    }
    export function addMaterial(task, input) {
      const item = { id: 'material-' + crypto.randomUUID(), ...structuredClone(input), goalVersionId: activeGoal(task).id,
        createdAt: new Date().toISOString() };
      task.materials ??= []; task.materials.push(item); return item;
    }
    export function createStore(root) {
      const file = (id) => path.join(root, id, 'task.json');
      return { async init() { await fs.mkdir(root, { recursive: true }); },
        async list() { const names = await fs.readdir(root, { withFileTypes: true }); return Promise.all(names.filter(x => x.isDirectory()).map(x => this.get(x.name))); },
        async get(id) { return JSON.parse(await fs.readFile(file(id), 'utf8')); },
        async save(task) { await fs.mkdir(path.dirname(file(task.id)), { recursive: true }); await fs.writeFile(file(task.id), JSON.stringify(task)); return task; },
        async appendAudit() {},
        async mutate(id, change) { const task = await this.get(id); const result = await change(task); await this.save(task); return { task, result }; } };
    }
  `);
  await fs.writeFile(path.join(app, 'project-workspace.mjs'), `
    export function projectTaskBinding(task) {
      return { taskId: task.id, goalVersionId: task.goal.activeVersionId,
        taskInputBindingSha256: 'b'.repeat(64), pipelineBindingSha256: 'c'.repeat(64) };
    }
    export function projectWorkspaceIsCurrent(task) {
      return Boolean(task.projectWorkspace?.status === 'ready'
        && (task.projectWorkspace.goalVersionId === task.goal.activeVersionId
          || task.projectWorkspace.taskInputBinding?.goalVersionId === task.goal.activeVersionId));
    }
  `);
  await fs.writeFile(path.join(app, 'material-applicability.mjs'), `
    export function materialContext(task) {
      return { fingerprint: null, effectiveMaterials: [], directory: [], blockingDecisions: [] };
    }
  `);
  let entries = catalog;
  const controller = await createProductBootstrapController({ tasksRoot: tasks, irixiAppRoot: app,
    projectCatalog: async () => entries, projectAuthorization });
  return { controller, tasks, setCatalog(value) { entries = value; } };
}

const project = () => ({
  projectId: 'native-project-1',
  label: 'Native Project',
  scopeFingerprint: SCOPE,
  allowedWritePaths: ['src/main.ts'],
  checkIds: ['typecheck'],
  staticPreviewEntries: [],
  staticPreviewFiles: [],
  current: true,
});

const request = () => ({
  title: 'Native integration',
  statement: 'Connect the accepted native project.',
  successCriteria: ['The real native executor produces a reviewable candidate.', 'The final success condition remains present.'],
  boundaries: ['Do not authorize or execute during bootstrap.'],
});

async function seedRuntime(tasks, taskId, goalVersionId) {
  const file = path.join(tasks, taskId, 'task.json');
  const task = JSON.parse(await fs.readFile(file, 'utf8'));
  task.productBootstrap.status = 'registered';
  task.productBootstrap.registry = { status: 'registered', registrySha256: 'd'.repeat(64), projectId: 'native-project-1', scopeFingerprint: SCOPE };
  task.productBootstrap.authorizedProject = { projectId: 'native-project-1', scopeFingerprint: SCOPE, sourceSnapshotSha256: 'e'.repeat(64) };
  task.execution = { id: 'run-current', goalVersionId, phase: 'executing', stopReason: null, startedAt: '2026-10-11T00:00:00.000Z',
    deadlineAt: '2026-10-11T01:00:00.000Z', modelCalls: [
      { id: 'call-running', status: 'running', usage: null },
      { id: 'call-complete', status: 'completed', usage: { inputTokens: 10, outputTokens: 2 } },
    ] };
  task.integrationExecutionRequest = { goalVersionId, prompt: 'complete prior prompt', promptSha256: 'f'.repeat(64) };
  task.projectWorkspace = { goalVersionId, scopeFingerprint: SCOPE, status: 'ready' };
  await fs.writeFile(file, JSON.stringify(task));
  return file;
}

test('no-task state and project list expose setup without paths or execution prerequisites', async (t) => {
  const { controller } = await fixture(t, [project()]);
  assert.deepEqual(await controller.listRegisteredProjects(), [project()]);
  assert.deepEqual(await controller.state(), {
    task: null,
    status: 'waiting_task',
    execution: null,
    registry: null,
    setup: { projects: [project()], selectedProject: null, selectedScope: null },
  });
  assert.equal(JSON.stringify(await controller.state()).includes('/Users/'), false);
});

test('creates a complete project draft through core and records selection without granting or executing', async (t) => {
  const { controller } = await fixture(t, [project()]);
  const created = await controller.createTask(request());
  assert.equal(created.created, true);
  assert.equal(created.status, 'waiting_scope');
  assert.equal(created.execution, null);
  assert.equal(created.registry, null);
  assert.deepEqual(created.task.successCriteria, request().successCriteria);
  assert.deepEqual(created.task.boundaries, request().boundaries);

  const selected = await controller.selectScope(created.task.id, {
    expectedGoalVersionId: created.task.goalVersionId,
    projectId: 'native-project-1',
    expectedScopeFingerprint: SCOPE,
  });
  assert.equal(selected.status, 'waiting_scope_authorization');
  assert.equal(selected.execution, null);
  assert.equal(selected.registry, null);
  assert.deepEqual(selected.setup.selectedScope, {
    projectId: 'native-project-1', scopeFingerprint: SCOPE, goalVersionId: created.task.goalVersionId,
    selectedAt: selected.setup.selectedScope.selectedAt, current: true,
  });

  const stored = await controller.state(created.task.id);
  assert.equal(stored.status, 'waiting_scope_authorization');
  assert.equal(stored.setup.selectedProject.projectId, 'native-project-1');
  assert.equal(stored.execution, null);
  assert.equal(stored.registry, null);
});

test('rejects oversized input with the original request and writes no task', async (t) => {
  const { controller, tasks } = await fixture(t);
  const oversized = request();
  oversized.successCriteria[1] = `${'x'.repeat(500)}TAIL`;
  const result = await controller.createTask(oversized);
  assert.equal(result.created, false);
  assert.equal(result.reason.code, 'TASK_INPUT_OUT_OF_RANGE');
  assert.equal(result.request.successCriteria[1].endsWith('TAIL'), true);
  assert.deepEqual(await fs.readdir(tasks), []);
});

test('stale registered scope cannot be selected and does not create a grant', async (t) => {
  const { controller, setCatalog } = await fixture(t, [project()]);
  const created = await controller.createTask(request());
  setCatalog([{ ...project(), current: false }]);
  await assert.rejects(() => controller.selectScope(created.task.id, {
    expectedGoalVersionId: created.task.goalVersionId,
    projectId: 'native-project-1',
    expectedScopeFingerprint: SCOPE,
  }), (error) => error.code === 'REGISTERED_SCOPE_STALE' && error.status === 409);
  const stored = await controller.state(created.task.id);
  assert.equal(stored.status, 'waiting_scope');
  assert.equal(stored.setup.selectedScope, null);
  assert.equal(stored.execution, null);
  assert.equal(stored.registry, null);
});

test('explicit preparation after an expired stopped run starts a new round and preserves the complete prior ledger', async (t) => {
  const sourceSnapshotSha256 = 'e'.repeat(64), sourceHead = 'f'.repeat(40);
  const descriptor = {
    ...project(), root: '/registered/project', sourceSnapshotSha256, sourceHead,
    sourceManifest: [{ path: 'src/main.ts', sha256: '1'.repeat(64), bytes: 12 }],
    checks: [{ id: 'typecheck' }],
    native: { maxAgents: 3, maxModelCalls: 8, maxDurationMs: 1_200_000 },
  };
  const { controller, tasks } = await fixture(t, [project()], async () => descriptor);
  const created = await controller.createTask(request());
  const file = path.join(tasks, created.task.id, 'task.json');
  const task = JSON.parse(await fs.readFile(file, 'utf8'));
  const selectedAt = '2026-10-12T01:00:00.000Z';
  task.productBootstrap = {
    schemaVersion: 1, status: 'registered',
    scopeSelections: [{ id: 'scope-selection-1', projectId: descriptor.projectId, scopeFingerprint: SCOPE,
      goalVersionId: created.task.goalVersionId, selectedAt }],
    currentScopeSelectionId: 'scope-selection-1',
    authorizedProject: { projectId: descriptor.projectId, scopeFingerprint: SCOPE, sourceSnapshotSha256, sourceHead, authorizedAt: selectedAt },
    registry: { status: 'registered', projectId: descriptor.projectId, scopeFingerprint: SCOPE, preparedAt: selectedAt },
  };
  task.projectWorkspace = { goalVersionId: created.task.goalVersionId, scopeFingerprint: SCOPE,
    sourceSnapshotSha256, sourceHead, status: 'ready' };
  task.execution = {
    id: 'run-expired', goalVersionId: created.task.goalVersionId, phase: 'failed', stopReason: 'native_process_timeout',
    limits: { maxRoles: 3, maxConcurrentModelCalls: 2, maxModelCalls: 8, maxDurationMs: 1_200_000,
      maxAttemptsPerStep: 2, maxPlanRevisions: 2, maxToolRoundsPerStep: 3 },
    modelCalls: [
      { id: 'call-1', role: 'lead', status: 'failed', error: 'native_process_failed', startedAt: '2026-10-12T01:00:00.000Z', finishedAt: '2026-10-12T01:03:00.000Z' },
      { id: 'call-2', role: 'lead', status: 'failed', error: 'native_process_timeout', startedAt: '2026-10-12T01:17:00.000Z', finishedAt: '2026-10-12T01:20:00.000Z' },
    ],
    delegations: [], returnedResults: [], resultBatch: [], planRevisions: 0,
    preparedAt: '2026-10-12T00:59:00.000Z', startedAt: '2026-10-12T01:00:00.000Z',
    deadlineAt: '2026-10-12T01:20:00.000Z', updatedAt: '2026-10-12T01:20:00.000Z',
  };
  task.integrationExecutionRequest = { goalVersionId: created.task.goalVersionId, displayPrompt: request().statement,
    prompt: 'complete prior prompt', promptSha256: crypto.createHash('sha256').update('complete prior prompt').digest('hex') };
  await fs.writeFile(file, JSON.stringify(task));

  const before = await controller.state(created.task.id);
  assert.equal(before.status, 'ready_to_run');
  assert.equal(before.canPrepareRun, true);
  assert.equal(before.canReconnect, false);
  assert.equal(before.blockedReason, 'explicit_new_run_required');

  const prepared = await controller.prepareRun(created.task.id, {
    expectedGoalVersionId: created.task.goalVersionId,
    expectedScopeFingerprint: SCOPE,
  });
  assert.notEqual(prepared.execution.id, 'run-expired');
  assert.equal(prepared.prepared.priorExecutionId, 'run-expired');
  assert.equal(prepared.prepared.priorModelCalls, 2);

  const stored = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(stored.executionHistory.length, 1);
  assert.equal(stored.executionHistory[0].id, 'run-expired');
  assert.equal(stored.executionHistory[0].stopReason, 'native_process_timeout');
  assert.equal(stored.executionHistory[0].deadlineAt, '2026-10-12T01:20:00.000Z');
  assert.deepEqual(stored.executionHistory[0].modelCalls, task.execution.modelCalls);
  assert.equal(stored.integrationExecutionRequestHistory[0].prompt, 'complete prior prompt');
  assert.equal(stored.productBootstrap.registryHistory[0].reason, 'explicit_new_run');
  assert.equal(stored.productBootstrap.authorizedProject.projectId, descriptor.projectId);
  assert.equal(stored.productBootstrap.currentScopeSelectionId, 'scope-selection-1');
  assert.equal(stored.execution.modelCalls.length, 0);
  assert.equal(stored.execution.limits.maxModelCalls, 8);
  assert.match(stored.integrationExecutionRequest.prompt, /do not import unrelated parent construction-agent AGENTS, DZ, or A\/B coordination details/);
});

test('explicit current-result recovery reuses the expired execution without changing its budget or ledger', async (t) => {
  const sourceSnapshotSha256 = 'e'.repeat(64), sourceHead = 'f'.repeat(40);
  const descriptor = {
    ...project(), root: '/registered/project', sourceSnapshotSha256, sourceHead,
    sourceManifest: [{ path: 'src/main.ts', sha256: '1'.repeat(64), bytes: 12 }],
    checks: [{ id: 'typecheck' }],
    native: { maxAgents: 3, maxModelCalls: 8, maxDurationMs: 1_200_000 },
  };
  const { controller, tasks } = await fixture(t, [project()], async () => descriptor);
  const created = await controller.createTask(request());
  await controller.selectScope(created.task.id, {
    expectedGoalVersionId: created.task.goalVersionId, projectId: descriptor.projectId, expectedScopeFingerprint: SCOPE,
  });
  await controller.authorizeScope(created.task.id, {
    expectedGoalVersionId: created.task.goalVersionId, projectId: descriptor.projectId, expectedScopeFingerprint: SCOPE,
  });
  const initial = await controller.prepareRun(created.task.id, {
    expectedGoalVersionId: created.task.goalVersionId, expectedScopeFingerprint: SCOPE,
  });
  const file = path.join(tasks, created.task.id, 'task.json');
  const task = JSON.parse(await fs.readFile(file, 'utf8'));
  const preparedAt = new Date(Date.now() - 1_300_000).toISOString();
  task.productBootstrap.registry = { status: 'registered', projectId: descriptor.projectId,
    scopeFingerprint: SCOPE, preparedAt };
  task.execution.phase = 'executing';
  task.execution.stopReason = null;
  task.execution.startedAt = preparedAt;
  task.execution.deadlineAt = new Date(Date.now() - 1000).toISOString();
  task.execution.modelCalls = Array.from({ length: 5 }, (_, index) => ({
    id: `call-expired-${index + 1}`, status: index === 4 ? 'failed' : 'completed',
    startedAt: preparedAt, finishedAt: new Date(Date.now() - 1000).toISOString(),
  }));

  const registry = {
    taskId: task.id, goalVersionId: task.goal.activeVersionId, projectId: descriptor.projectId,
    workspace: { scopeFingerprint: SCOPE, sourceSnapshotSha256, sourceHead },
    native: { maxModelCalls: 8, maxDurationMs: 1_200_000 },
  };
  const registrySha256 = crypto.createHash('sha256').update(canonical(registry)).digest('hex');
  task.events.push({ id: 'registry-current-expired', at: preparedAt, type: 'integration.product_registry_registered',
    detail: { registry, registrySha256 } });
  const candidateSha256 = crypto.createHash('sha256').update('confirmed native candidate v15').digest('hex');
  const artifactId = 'artifact-confirmed-v15';
  const reviewId = 'review-confirmed-v15';
  task.artifacts = [{ id: artifactId, version: 15, status: 'confirmed', reviewStatus: 'passed', goalVersionId: task.goal.activeVersionId,
    nativeProjectCandidate: { version: 1, kind: 'native_worktree_candidate_v1', candidateSha256,
      taskInputBinding: task.projectWorkspace.taskInputBinding, workspaceScopeFingerprint: SCOPE,
      sourceSnapshotSha256, registrySha256 } }];
  task.reviews = [{ id: reviewId, artifactId, passed: true, goalVersionId: task.goal.activeVersionId,
    candidateSha256, registrySha256 }];
  task.approvals = [{ id: 'approval-confirmed-v15', artifactId, artifactVersion: 15, status: 'confirmed',
    goalVersionId: task.goal.activeVersionId, candidateSha256, reviewId }];
  await fs.writeFile(file, JSON.stringify(task));

  const expected = {
    mode: 'reuse_current_result', expectedGoalVersionId: task.goal.activeVersionId,
    expectedScopeFingerprint: SCOPE, expectedExecutionId: initial.execution.id,
    expectedRegistrySha256: registrySha256, expectedArtifactId: artifactId,
    expectedArtifactVersion: 15, expectedCandidateSha256: candidateSha256,
  };
  const before = await fs.readFile(file, 'utf8');
  await assert.rejects(() => controller.prepareRun(created.task.id, {
    ...expected, expectedCandidateSha256: '0'.repeat(64),
  }), (error) => error.code === 'RUN_REUSE_BINDING_STALE' && error.status === 409);
  assert.equal(await fs.readFile(file, 'utf8'), before);

  const state = await controller.state(created.task.id);
  assert.equal(state.blockedReason, 'explicit_new_run_required');
  assert.equal(state.canRun, false);
  const reused = await controller.prepareRun(created.task.id, expected);
  assert.equal(reused.execution.id, initial.execution.id);
  assert.equal(reused.execution.phase, 'executing');
  assert.equal(reused.prepared.reused, true);
  assert.equal(reused.prepared.reconnect, true);
  assert.equal(reused.prepared.reuseCurrentResult, true);
  assert.equal(reused.prepared.registrySha256, registrySha256);
  assert.equal(reused.prepared.artifactId, artifactId);
  assert.equal(reused.prepared.artifactVersion, 15);
  assert.equal(await fs.readFile(file, 'utf8'), before);
  const stored = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(stored.execution.id, initial.execution.id);
  assert.equal(stored.execution.deadlineAt, task.execution.deadlineAt);
  assert.deepEqual(stored.execution.modelCalls, task.execution.modelCalls);
  assert.equal(stored.execution.limits.maxModelCalls, 8);
  assert.equal(stored.execution.limits.maxDurationMs, 1_200_000);
  assert.equal(stored.executionHistory?.length || 0, 0);
  assert.equal(stored.artifacts[0].id, artifactId);
  assert.equal(stored.approvals[0].id, 'approval-confirmed-v15');
});

test('expired execution with an unsettled native call keeps the current scope and blocks a new round', async (t) => {
  const { controller, tasks } = await fixture(t, [project()]);
  const created = await controller.createTask(request());
  const file = path.join(tasks, created.task.id, 'task.json');
  const task = JSON.parse(await fs.readFile(file, 'utf8'));
  const preparedAt = '2026-10-12T01:00:00.000Z';
  task.productBootstrap = {
    schemaVersion: 1, status: 'runtime_starting',
    scopeSelections: [{ id: 'scope-selection-expired', projectId: project().projectId,
      scopeFingerprint: SCOPE, goalVersionId: created.task.goalVersionId, selectedAt: preparedAt }],
    currentScopeSelectionId: 'scope-selection-expired',
    authorizedProject: { projectId: project().projectId, scopeFingerprint: SCOPE,
      sourceSnapshotSha256: 'e'.repeat(64), sourceHead: 'f'.repeat(40), authorizedAt: preparedAt },
    registry: { status: 'runtime_starting', projectId: project().projectId, scopeFingerprint: SCOPE, preparedAt },
  };
  task.projectWorkspace = { goalVersionId: created.task.goalVersionId, scopeFingerprint: SCOPE,
    sourceSnapshotSha256: 'e'.repeat(64), sourceHead: 'f'.repeat(40), status: 'ready' };
  task.execution = {
    id: 'run-expired-unsettled', goalVersionId: created.task.goalVersionId, phase: 'executing',
    stopReason: null, startedAt: '2026-10-12T01:00:00.000Z', deadlineAt: '2026-10-12T01:20:00.000Z',
    modelCalls: [{ id: 'call-still-running', role: 'lead', status: 'running' }],
  };
  task.integrationExecutionRequest = { goalVersionId: created.task.goalVersionId,
    prompt: 'prior request', promptSha256: crypto.createHash('sha256').update('prior request').digest('hex') };
  await fs.writeFile(file, JSON.stringify(task));

  const state = await controller.state(created.task.id);
  assert.equal(state.status, 'execution_expired');
  assert.equal(state.blockedReason, 'execution_deadline_elapsed_with_unsettled_call');
  assert.equal(state.canPrepareRun, false);
  assert.equal(state.canReconnect, false);
  assert.equal(state.setup.selectedScope.current, true);
  assert.equal(state.execution.id, 'run-expired-unsettled');
});

test('a terminal native process failure before its deadline starts a new explicit round instead of reconnecting', async (t) => {
  const sourceSnapshotSha256 = 'e'.repeat(64), sourceHead = 'f'.repeat(40);
  const descriptor = {
    ...project(), root: '/registered/project', sourceSnapshotSha256, sourceHead,
    sourceManifest: [{ path: 'src/main.ts', sha256: '1'.repeat(64), bytes: 12 }],
    checks: [{ id: 'typecheck' }],
    native: { maxAgents: 3, maxModelCalls: 8, maxDurationMs: 1_200_000 },
  };
  const { controller, tasks } = await fixture(t, [project()], async () => descriptor);
  const created = await controller.createTask(request());
  await controller.selectScope(created.task.id, {
    expectedGoalVersionId: created.task.goalVersionId, projectId: descriptor.projectId, expectedScopeFingerprint: SCOPE,
  });
  await controller.authorizeScope(created.task.id, {
    expectedGoalVersionId: created.task.goalVersionId, projectId: descriptor.projectId, expectedScopeFingerprint: SCOPE,
  });
  const prior = await controller.prepareRun(created.task.id, {
    expectedGoalVersionId: created.task.goalVersionId, expectedScopeFingerprint: SCOPE,
  });
  const file = path.join(tasks, created.task.id, 'task.json');
  const task = JSON.parse(await fs.readFile(file, 'utf8'));
  const failedCall = { id: 'call-review-failed', role: 'reviewer', status: 'failed', usage: 'unknown',
    error: 'native_process_failed', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() };
  task.execution.phase = 'failed';
  task.execution.stopReason = 'native_process_failed';
  task.execution.startedAt = new Date(Date.now() - 1_000).toISOString();
  task.execution.deadlineAt = new Date(Date.now() + 600_000).toISOString();
  task.execution.modelCalls = [failedCall];
  await fs.writeFile(file, JSON.stringify(task));

  const state = await controller.state(created.task.id);
  assert.equal(state.status, 'ready_to_run');
  assert.equal(state.canReconnect, false);
  assert.equal(state.blockedReason, 'explicit_new_run_required');

  const next = await controller.prepareRun(created.task.id, {
    expectedGoalVersionId: created.task.goalVersionId, expectedScopeFingerprint: SCOPE,
  });
  assert.notEqual(next.execution.id, prior.execution.id);
  assert.equal(next.prepared.reused, false);
  assert.equal(next.prepared.priorExecutionId, prior.execution.id);
  assert.equal(next.prepared.priorModelCalls, 1);
  const stored = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(stored.executionHistory[0].id, prior.execution.id);
  assert.equal(stored.executionHistory[0].stopReason, 'native_process_failed');
  assert.deepEqual(stored.executionHistory[0].modelCalls, [failedCall]);
  assert.equal(stored.execution.modelCalls.length, 0);
  assert.equal(stored.execution.limits.maxModelCalls, 8);
  assert.equal(stored.execution.deadlineAt, null);
});

test('a verified registered full registry restores the same saved-plan execution without resetting its budget', async (t) => {
  const sourceSnapshotSha256 = 'e'.repeat(64), sourceHead = 'f'.repeat(40);
  const descriptor = {
    ...project(), root: '/registered/project', sourceSnapshotSha256, sourceHead,
    sourceManifest: [{ path: 'src/main.ts', sha256: '1'.repeat(64), bytes: 12 }],
    checks: [{ id: 'typecheck' }],
    native: { maxAgents: 3, maxModelCalls: 8, maxDurationMs: 1_200_000 },
  };
  const { controller, tasks } = await fixture(t, [project()], async () => descriptor);
  const created = await controller.createTask(request());
  await controller.selectScope(created.task.id, {
    expectedGoalVersionId: created.task.goalVersionId, projectId: descriptor.projectId, expectedScopeFingerprint: SCOPE,
  });
  await controller.authorizeScope(created.task.id, {
    expectedGoalVersionId: created.task.goalVersionId, projectId: descriptor.projectId, expectedScopeFingerprint: SCOPE,
  });
  const prior = await controller.prepareRun(created.task.id, {
    expectedGoalVersionId: created.task.goalVersionId, expectedScopeFingerprint: SCOPE,
  });
  const file = path.join(tasks, created.task.id, 'task.json');
  const task = JSON.parse(await fs.readFile(file, 'utf8'));
  const attemptId = 'attempt-saved-lead-plan';
  const failedCall = { id: 'call-lead-create', role: 'lead', status: 'failed', error: 'native_process_failed',
    startedAt: new Date(Date.now() - 2_000).toISOString(), finishedAt: new Date(Date.now() - 1_000).toISOString() };
  task.execution.phase = 'failed';
  task.execution.stopReason = 'native_process_failed';
  task.execution.startedAt = new Date(Date.now() - 2_000).toISOString();
  task.execution.deadlineAt = new Date(Date.now() + 600_000).toISOString();
  task.execution.modelCalls = [failedCall];
  task.productBootstrap.registry.preparedAt = new Date(Date.now() - 5_000).toISOString();
  const registry = {
    taskId: task.id, goalVersionId: task.goal.activeVersionId, projectId: descriptor.projectId,
    workspace: { scopeFingerprint: SCOPE, sourceSnapshotSha256, sourceHead },
    native: { maxModelCalls: 8 },
  };
  const registrySha256 = crypto.createHash('sha256').update(canonical(registry)).digest('hex');
  task.events.push({ id: 'registry-current', at: new Date().toISOString(), type: 'integration.product_registry_registered',
    detail: { registry, registrySha256 } });
  task.events.push({ id: 'failed-lead-plan-receipt', type: 'integration.observation', detail: {
    sourceEventId: `product-native:${attemptId}:TASK_FAILED:authority-persistence`, nativeAttemptId: attemptId,
    binding: { executionId: task.execution.id },
  } });
  task.events.push({ id: 'lead-create-reservation', type: 'integration.product_native_call_reserved', detail: {
    executionId: task.execution.id, attemptId, modelCallId: failedCall.id, isTeamLead: true, readOnly: true, phase: 'create',
  } });
  await fs.writeFile(file, JSON.stringify(task));

  const state = await controller.state(created.task.id);
  assert.equal(state.status, 'runtime_unavailable');
  assert.equal(state.canReconnect, true);
  assert.equal(state.blockedReason, 'native_runtime_unavailable');
  const reconnected = await controller.prepareRun(created.task.id, {
    expectedGoalVersionId: created.task.goalVersionId, expectedScopeFingerprint: SCOPE,
  });
  assert.equal(reconnected.prepared.reused, true);
  assert.equal(reconnected.prepared.reconnect, true);
  assert.equal(reconnected.execution.id, prior.execution.id);
  const stored = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(stored.execution.deadlineAt, task.execution.deadlineAt);
  assert.deepEqual(stored.execution.modelCalls, [failedCall]);
  assert.equal(stored.executionHistory?.length || 0, 0);
});

test('terminal execution can reselect and authorize the same project after a registered model-scope change', async (t) => {
  const nextScope = '9'.repeat(64);
  const sourceSnapshotSha256 = 'e'.repeat(64), sourceHead = 'f'.repeat(40);
  let descriptor = {
    ...project(), root: '/registered/project', sourceSnapshotSha256, sourceHead,
    sourceManifest: [{ path: 'src/main.ts', sha256: '1'.repeat(64), bytes: 12 }],
    checks: [{ id: 'typecheck' }],
    native: { model: 'gpt-6-luna', allowedRoles: ['Lead', 'Senior Developer', 'Reviewer'],
      maxAgents: 3, maxModelCalls: 8, maxDurationMs: 1_200_000 },
  };
  const { controller, tasks, setCatalog } = await fixture(t, [project()], async () => descriptor);
  const created = await controller.createTask(request());
  const selected = await controller.selectScope(created.task.id, {
    expectedGoalVersionId: created.task.goalVersionId, projectId: project().projectId,
    expectedScopeFingerprint: SCOPE,
  });
  await controller.authorizeScope(created.task.id, {
    expectedGoalVersionId: created.task.goalVersionId, projectId: project().projectId,
    expectedScopeFingerprint: SCOPE,
  });

  const file = path.join(tasks, created.task.id, 'task.json');
  const task = JSON.parse(await fs.readFile(file, 'utf8'));
  const oldCall = { id: 'call-run5-capacity', role: 'lead', status: 'failed', usage: 'unknown',
    error: 'native_process_failed', startedAt: '2026-10-12T06:35:34.356Z', finishedAt: '2026-10-12T06:36:17.891Z' };
  task.productBootstrap.registry = { status: 'runtime_starting', projectId: project().projectId,
    scopeFingerprint: SCOPE, preparedAt: '2026-10-12T06:32:52.770Z' };
  task.productBootstrap.status = 'registered';
  task.projectWorkspace.status = 'ready';
  task.projectWorkspace.scopeFingerprint = SCOPE;
  task.execution = {
    id: 'run-run5-capacity', goalVersionId: created.task.goalVersionId,
    phase: 'failed', stopReason: 'native_process_failed', modelCalls: [oldCall],
    limits: { maxRoles: 3, maxConcurrentModelCalls: 2, maxModelCalls: 8, maxDurationMs: 1_200_000 },
    startedAt: '2026-10-12T06:35:34.289Z', deadlineAt: '2026-10-12T06:55:34.289Z', updatedAt: oldCall.finishedAt,
  };
  task.integrationExecutionRequest = { goalVersionId: created.task.goalVersionId,
    displayPrompt: 'Prior Run5 request', prompt: 'Prior Run5 full prompt', promptSha256: '2'.repeat(64) };

  const legacyFailureAt = '2026-10-12T05:30:01.906Z';
  const legacyArchiveAt = '2026-10-12T05:49:09.972Z';
  task.executionHistory = [{ id: 'run-legacy-timeout', phase: 'cancelled',
    stopReason: 'accepted_instruction_changed', updatedAt: '2026-10-12T05:49:09.971Z', modelCalls: [{
      id: 'call-legacy-timeout', role: 'senior developer', status: 'failed', usage: 'unknown',
      error: 'native_process_timeout', startedAt: '2026-10-12T05:13:25.333Z', finishedAt: legacyFailureAt,
    }] }];
  task.events.push(
    { id: 'reserve-legacy-timeout', at: '2026-10-12T05:13:25.333Z', type: 'integration.product_native_call_reserved',
      detail: { executionId: 'run-legacy-timeout', modelCallId: 'call-legacy-timeout', attemptId: 'attempt-legacy-timeout' } },
    { id: 'failure-legacy-timeout', at: legacyFailureAt, type: 'integration.observation',
      detail: { type: 'TASK_FAILED', nativeAttemptId: 'attempt-legacy-timeout', error: 'native_process_timeout',
        binding: { executionId: 'run-legacy-timeout' } } },
    { id: 'archive-legacy-timeout', at: legacyArchiveAt, type: 'integration.product_execution_archived',
      detail: { priorExecutionId: null, reason: 'accepted_instruction_changed' } },
    { id: 'reserve-run5-capacity', at: '2026-10-12T06:35:34.356Z', type: 'integration.product_native_call_reserved',
      detail: { executionId: 'run-run5-capacity', modelCallId: oldCall.id, attemptId: 'attempt-run5-capacity' } },
  );
  await fs.writeFile(file, JSON.stringify(task));

  const newProject = { ...project(), scopeFingerprint: nextScope };
  descriptor = { ...descriptor, scopeFingerprint: nextScope };
  setCatalog([newProject]);
  const stale = await controller.state(created.task.id);
  assert.equal(stale.status, 'waiting_scope');
  assert.equal(stale.setup.selectedScope.current, false);
  assert.deepEqual(stale.setup.projects[0].allowedWritePaths, project().allowedWritePaths);

  const reselected = await controller.selectScope(created.task.id, {
    expectedGoalVersionId: created.task.goalVersionId, projectId: project().projectId,
    expectedScopeFingerprint: nextScope,
  });
  assert.equal(reselected.status, 'waiting_scope_authorization');
  assert.equal(reselected.task.goalVersionId, created.task.goalVersionId);

  const afterSelection = JSON.parse(await fs.readFile(file, 'utf8'));
  const archivedRun5 = afterSelection.executionHistory.find((entry) => entry.id === 'run-run5-capacity');
  assert.equal(archivedRun5.stopReason, 'native_process_failed');
  assert.equal(archivedRun5.deadlineAt, '2026-10-12T06:55:34.289Z');
  assert.deepEqual(archivedRun5.modelCalls, [oldCall]);
  assert.equal(archivedRun5.archiveReason, 'explicit_new_run');
  assert.equal(afterSelection.execution, null);
  assert.equal(afterSelection.productBootstrap.authorizedProject, null);
  assert.equal(afterSelection.productBootstrap.authorizationHistory.at(-1).scopeFingerprint, SCOPE);
  assert.equal(afterSelection.productBootstrap.authorizationHistory.at(-1).reason, 'registered_scope_changed');
  assert.equal(afterSelection.productBootstrap.registryHistory.at(-1).reason, 'registered_scope_changed');
  assert.equal(afterSelection.projectWorkspace.status, 'reauthorization_required');

  const repairedLegacy = afterSelection.executionHistory.find((entry) => entry.id === 'run-legacy-timeout');
  assert.deepEqual({ phase: repairedLegacy.phase, stopReason: repairedLegacy.stopReason, updatedAt: repairedLegacy.updatedAt,
    archiveReason: repairedLegacy.archiveReason, archivedAt: repairedLegacy.archivedAt }, {
    phase: 'failed', stopReason: 'native_process_timeout', updatedAt: legacyFailureAt,
    archiveReason: 'accepted_instruction_changed', archivedAt: legacyArchiveAt,
  });
  const repairEvent = afterSelection.events.find((entry) => entry.type === 'integration.product_execution_archive_summary_restored'
    && entry.detail.executionId === 'run-legacy-timeout');
  assert.equal(repairEvent.detail.sourceReservationEventId, 'reserve-legacy-timeout');
  assert.equal(repairEvent.detail.sourceFailureEventId, 'failure-legacy-timeout');
  assert.equal(repairEvent.detail.sourceArchiveEventId, 'archive-legacy-timeout');

  const authorized = await controller.authorizeScope(created.task.id, {
    expectedGoalVersionId: created.task.goalVersionId, projectId: project().projectId,
    expectedScopeFingerprint: nextScope,
  });
  assert.equal(authorized.authorization.scopeFingerprint, nextScope);
  const prepared = await controller.prepareRun(created.task.id, {
    expectedGoalVersionId: created.task.goalVersionId, expectedScopeFingerprint: nextScope,
  });
  const final = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(final.execution.limits.maxModelCalls, 8);
  assert.equal(final.execution.limits.maxDurationMs, 1_200_000);
  assert.equal(final.execution.modelCalls.length, 0);
  assert.equal(final.execution.id, prepared.execution.id);
  assert.equal(final.goal.activeVersionId, created.task.goalVersionId);
  assert.equal(final.productBootstrap.authorizedProject.scopeFingerprint, nextScope);
  assert.equal(final.projectWorkspace.scopeFingerprint, nextScope);
  assert.equal(final.executionHistory.find((entry) => entry.id === 'run-run5-capacity').deadlineAt, '2026-10-12T06:55:34.289Z');
  assert.equal(final.executionHistory.find((entry) => entry.id === 'run-legacy-timeout').modelCalls[0].error, 'native_process_timeout');
  assert.equal(final.execution.modelCalls.length, 0);
  assert.equal(selected.task.goalVersionId, created.task.goalVersionId);
});

test('a goal change preserves the old selection as history but makes it non-current', async (t) => {
  const { controller, tasks } = await fixture(t, [project()]);
  const created = await controller.createTask(request());
  const selected = await controller.selectScope(created.task.id, {
    expectedGoalVersionId: created.task.goalVersionId,
    projectId: 'native-project-1',
    expectedScopeFingerprint: SCOPE,
  });
  const taskFile = path.join(tasks, created.task.id, 'task.json');
  const task = JSON.parse(await fs.readFile(taskFile, 'utf8'));
  const replacement = { ...task.goal.versions[0], id: 'goal-replacement', version: 2, statement: 'Changed goal' };
  task.goal.versions.push(replacement);
  task.goal.activeVersionId = replacement.id;
  await fs.writeFile(taskFile, JSON.stringify(task));

  const state = await controller.state(created.task.id);
  assert.equal(state.status, 'waiting_scope');
  assert.equal(state.setup.selectedScope.goalVersionId, selected.task.goalVersionId);
  assert.equal(state.setup.selectedScope.current, false);
  const stored = JSON.parse(await fs.readFile(taskFile, 'utf8'));
  assert.equal(stored.productBootstrap.scopeSelections.length, 1);
  assert.equal(stored.productBootstrap.scopeSelections[0].goalVersionId, created.task.goalVersionId);
});

test('offline instruction requires the exact runtime binding and archives its complete ledger before changing input', async (t) => {
  const { controller, tasks } = await fixture(t, [project()]);
  const created = await controller.createTask(request());
  const taskFile = await seedRuntime(tasks, created.task.id, created.task.goalVersionId);

  await assert.rejects(() => controller.addInstruction(created.task.id, {
    expectedGoalVersionId: created.task.goalVersionId,
    expectedExecutionId: 'run-stale',
    expectedRegistrySha256: 'd'.repeat(64),
    text: 'Preserve the complete accepted instruction.',
  }), (error) => error.code === 'PRODUCT_BINDING_STALE' && error.status === 409);
  assert.equal(JSON.parse(await fs.readFile(taskFile, 'utf8')).execution.id, 'run-current');

  const result = await controller.addInstruction(created.task.id, {
    expectedGoalVersionId: created.task.goalVersionId,
    expectedExecutionId: 'run-current',
    expectedRegistrySha256: 'd'.repeat(64),
    text: 'Preserve the complete accepted instruction.',
  });
  assert.equal(result.status, 'waiting_scope');
  assert.equal(result.execution, null);
  assert.equal(result.registry, null);

  const stored = JSON.parse(await fs.readFile(taskFile, 'utf8'));
  assert.equal(stored.execution, null);
  assert.equal(stored.integrationExecutionRequest, null);
  assert.equal(stored.executionHistory.length, 1);
  assert.equal(stored.executionHistory[0].id, 'run-current');
  assert.equal(stored.executionHistory[0].phase, 'cancelled');
  assert.equal(stored.executionHistory[0].stopReason, 'accepted_instruction_changed');
  assert.equal(stored.executionHistory[0].modelCalls[0].status, 'failed');
  assert.equal(stored.executionHistory[0].modelCalls[0].usage, 'unknown');
  assert.equal(stored.executionHistory[0].modelCalls[0].error, 'native_runtime_unavailable_before_input_change');
  assert.deepEqual(stored.executionHistory[0].modelCalls[1].usage, { inputTokens: 10, outputTokens: 2 });
  assert.equal(stored.integrationExecutionRequestHistory[0].prompt, 'complete prior prompt');
  assert.equal(stored.productBootstrap.registry, null);
  assert.equal(stored.productBootstrap.registryHistory[0].registrySha256, 'd'.repeat(64));
  assert.equal(stored.suggestions.at(-1).text, 'Preserve the complete accepted instruction.');
  assert.equal(stored.status, 'waiting_scope');
  assert.equal(stored.projectWorkspace.status, 'reauthorization_required');
  assert.equal(stored.events.at(-1).type, 'integration.product_execution_archived');
  assert.equal(stored.events.at(-1).detail.priorExecutionId, 'run-current');
  assert.deepEqual(stored.events.at(-1).detail.settledRunningCallIds, ['call-running']);
});

test('input changes archive a stopped execution without rewriting its phase, stop reason, timestamps, or calls', async (t) => {
  const { controller, tasks } = await fixture(t, [project()]);
  const created = await controller.createTask(request());
  const taskFile = await seedRuntime(tasks, created.task.id, created.task.goalVersionId);
  const task = JSON.parse(await fs.readFile(taskFile, 'utf8'));
  Object.assign(task.execution, {
    phase: 'partial', stopReason: 'native_process_timeout', preparedAt: '2026-10-12T05:10:00.000Z',
    startedAt: '2026-10-12T05:11:00.000Z', updatedAt: '2026-10-12T05:30:01.906Z',
    modelCalls: [
      { id: 'call-failed', status: 'failed', usage: 'unknown', error: 'native_process_timeout', finishedAt: '2026-10-12T05:30:01.906Z' },
      { id: 'call-complete', status: 'completed', usage: { inputTokens: 10, outputTokens: 2 }, finishedAt: '2026-10-12T05:15:00.000Z' },
    ],
  });
  const before = structuredClone(task.execution);
  await fs.writeFile(taskFile, JSON.stringify(task));

  await controller.addInstruction(created.task.id, {
    expectedGoalVersionId: created.task.goalVersionId, expectedExecutionId: before.id,
    expectedRegistrySha256: 'd'.repeat(64), text: 'Continue the same bounded worktree and preserve the failed run.',
  });

  const stored = JSON.parse(await fs.readFile(taskFile, 'utf8'));
  assert.equal(stored.execution, null);
  const archived = stored.executionHistory[0];
  const { archiveReason, archivedAt, ...execution } = archived;
  assert.deepEqual(execution, before);
  assert.equal(archiveReason, 'accepted_instruction_changed');
  assert.ok(Number.isFinite(Date.parse(archivedAt)));
});

test('a verified authority registry event is exposed and becomes the exact offline mutation CAS', async (t) => {
  const { controller, tasks } = await fixture(t, [project()]);
  const created = await controller.createTask(request());
  const taskFile = await seedRuntime(tasks, created.task.id, created.task.goalVersionId);
  const task = JSON.parse(await fs.readFile(taskFile, 'utf8'));
  const registry = { goalVersionId: created.task.goalVersionId, projectId: 'native-project-1', workspace: { scopeFingerprint: SCOPE } };
  const registrySha256 = crypto.createHash('sha256').update(JSON.stringify(registry)).digest('hex');
  task.events.push({ id: 'registry-event', type: 'integration.product_registry_registered', detail: { registry, registrySha256 } });
  await fs.writeFile(taskFile, JSON.stringify(task));
  assert.equal((await controller.state(created.task.id)).registry.registrySha256, registrySha256);
  await assert.rejects(() => controller.addInstruction(created.task.id, {
    expectedGoalVersionId: created.task.goalVersionId, expectedExecutionId: 'run-current', text: 'Missing the real registry CAS.',
  }), (error) => error.code === 'PRODUCT_BINDING_STALE');
  await controller.addInstruction(created.task.id, {
    expectedGoalVersionId: created.task.goalVersionId, expectedExecutionId: 'run-current', expectedRegistrySha256: registrySha256,
    text: 'Archive this current registry without exposing it as a live binding.',
  });
  assert.equal((await controller.state(created.task.id)).registry, null);
});

test('offline goal and material mutations preserve exact accepted input while rolling the prior runtime into history', async (t) => {
  const first = await fixture(t, [project()]);
  const goalTask = await first.controller.createTask(request());
  const goalFile = await seedRuntime(first.tasks, goalTask.task.id, goalTask.task.goalVersionId);
  const markerOnly = JSON.parse(await fs.readFile(goalFile, 'utf8'));
  delete markerOnly.productBootstrap.registry.registrySha256;
  await fs.writeFile(goalFile, JSON.stringify(markerOnly));
  const replacement = {
    expectedGoalVersionId: goalTask.task.goalVersionId,
    expectedExecutionId: 'run-current',
    statement: 'Use the new exact goal without truncation.',
    successCriteria: ['The accepted replacement is complete.'],
    boundaries: ['The old execution ledger remains historical.'],
  };
  const replaced = await first.controller.replaceGoal(goalTask.task.id, replacement);
  assert.equal(replaced.task.statement, replacement.statement);
  const afterGoal = JSON.parse(await fs.readFile(goalFile, 'utf8'));
  assert.deepEqual(afterGoal.goal.versions.at(-1).successCriteria, replacement.successCriteria);
  assert.equal(afterGoal.executionHistory[0].goalVersionId, goalTask.task.goalVersionId);
  assert.equal(afterGoal.executionHistory[0].stopReason, 'goal_replaced');

  const second = await fixture(t, [project()]);
  const materialTask = await second.controller.createTask(request());
  const materialFile = await seedRuntime(second.tasks, materialTask.task.id, materialTask.task.goalVersionId);
  const text = 'Complete material text with quotes "and" a newline.\nNo excerpting.';
  const material = await second.controller.addMaterial(materialTask.task.id, {
    expectedGoalVersionId: materialTask.task.goalVersionId,
    expectedExecutionId: 'run-current',
    expectedRegistrySha256: 'd'.repeat(64),
    name: 'Exact evidence',
    kind: 'text',
    text,
  });
  const afterMaterial = JSON.parse(await fs.readFile(materialFile, 'utf8'));
  assert.equal(afterMaterial.materials.find((entry) => entry.id === material.materialId).text, text);
  assert.equal(afterMaterial.executionHistory[0].stopReason, 'material_input_changed');
  assert.equal(afterMaterial.integrationExecutionRequestHistory[0].promptSha256, 'f'.repeat(64));
});

test('catalog rejects path-bearing or otherwise untrusted entry shapes', async (t) => {
  const { controller } = await fixture(t, [{ ...project(), workspacePath: '/private/source' }]);
  await assert.rejects(() => controller.listRegisteredProjects(), (error) => error.code === 'PROJECT_CATALOG_INVALID');
});

test('prompt material representation removes only exact same-purpose copies and retains every source ID', () => {
  const materials = [
    { id: 'material-1', name: 'First', kind: 'text', source: 'product-user', text: 'same complete bytes' },
    { id: 'material-2', name: 'Second', kind: 'text', source: 'product-user', text: 'same complete bytes' },
    { id: 'material-3', name: 'Different source', kind: 'text', source: 'linked-reference', text: 'same complete bytes' },
    { id: 'material-4', name: 'Different purpose', kind: 'text', source: 'product-user', text: 'same complete bytes' },
  ];
  const usage = (id, purpose = 'source facts') => ({ id, eligible: true, eligibility: 'current', purpose,
    category: purpose === 'source facts' ? 'reference' : 'constraint', disposition: 'use',
    impact: purpose === 'source facts' ? 'inform' : 'required', reason: 'accepted for current goal' });
  const grouped = groupPromptMaterials(materials, [usage('material-1'), usage('material-2'), usage('material-3'), usage('material-4', 'must preserve exact bytes')]);
  assert.equal(grouped.length, 3);
  assert.deepEqual(grouped[0].references, [{ id: 'material-1', name: 'First' }, { id: 'material-2', name: 'Second' }]);
  assert.deepEqual(grouped[1].references, [{ id: 'material-3', name: 'Different source' }]);
  assert.deepEqual(grouped[2].references, [{ id: 'material-4', name: 'Different purpose' }]);
  assert.equal(grouped[0].usage.purpose, 'source facts');
  assert.equal(grouped[2].usage.purpose, 'must preserve exact bytes');
  assert.equal(grouped.every((entry) => entry.content === 'same complete bytes'), true);
});

test('native preparation includes the exact hash-bound Reviewer output referenced by a routed instruction', async (t) => {
  const sourceSnapshotSha256 = 'e'.repeat(64), sourceHead = 'f'.repeat(40);
  const descriptor = {
    ...project(), root: '/registered/project', sourceSnapshotSha256, sourceHead,
    sourceManifest: [{ path: 'src/main.ts', sha256: '1'.repeat(64), bytes: 12 }],
    checks: [{ id: 'typecheck' }],
    native: { maxAgents: 3, maxModelCalls: 8, maxDurationMs: 1_200_000 },
  };
  const { controller, tasks } = await fixture(t, [project()], async () => descriptor);
  const created = await controller.createTask(request());
  const file = path.join(tasks, created.task.id, 'task.json');
  const task = JSON.parse(await fs.readFile(file, 'utf8'));
  const artifactId = 'artifact-review-1', candidateSha256 = '2'.repeat(64), reviewId = 'review-1';
  const eventId = 'event-review-1', executionId = 'run-review-1';
  const reviewText = 'VERDICT: FAIL\nISSUES:\n- Verify this historical finding independently.\n';
  const resultSha256 = crypto.createHash('sha256').update(reviewText).digest('hex');
  task.productBootstrap = {
    schemaVersion: 1, status: 'ready_to_run',
    scopeSelections: [{ id: 'scope-selection-1', projectId: descriptor.projectId, scopeFingerprint: SCOPE,
      goalVersionId: created.task.goalVersionId, selectedAt: new Date().toISOString() }],
    currentScopeSelectionId: 'scope-selection-1',
    authorizedProject: { projectId: descriptor.projectId, scopeFingerprint: SCOPE, sourceSnapshotSha256, sourceHead },
    registry: null,
  };
  task.projectWorkspace = { status: 'ready', goalVersionId: created.task.goalVersionId,
    scopeFingerprint: SCOPE, sourceSnapshotSha256, sourceHead };
  task.suggestions.push({ id: 'suggestion-review-1', goalVersionId: created.task.goalVersionId,
    classification: 'support', status: 'routed', text: `R31 review evidence for independent diagnosis: artifact ${artifactId} v9, candidate SHA-256 ${candidateSha256}, review ${reviewId}. The exact ${reviewText.length}-character reviewText remains in integration.observation event ${eventId} with SHA-256 ${resultSha256}.` });
  task.events.push({ id: eventId, type: 'integration.observation', detail: {
    type: 'TASK_DONE', actor: 'reviewer', scopeOutcome: 'completed', resultSha256, reviewText,
    binding: { taskId: task.id, goalVersionId: created.task.goalVersionId, executionId,
      workspaceScopeFingerprint: SCOPE, sourceSnapshotSha256, artifactId, artifactVersion: 9, candidateSha256 },
  } });
  task.events.push({ id: 'event-reviewed-1', type: 'integration.product_native_reviewed', detail: {
    artifactId, reviewId, verdict: 'FAIL', candidateSha256,
  } });
  const originalPrompt = 'IRIXI_NATIVE_PRODUCT_EXECUTION_V1\nIncomplete prior prompt without the linked review text';
  const originalPromptSha256 = crypto.createHash('sha256').update(originalPrompt).digest('hex');
  const preparedAt = '2026-10-13T00:40:00.000Z';
  task.productBootstrap.registry = { status: 'runtime_starting', projectId: descriptor.projectId,
    scopeFingerprint: SCOPE, preparedAt };
  task.productBootstrap.status = 'runtime_starting';
  task.execution = {
    id: executionId, goalVersionId: created.task.goalVersionId,
    projectRootGoalVersionId: created.task.goalVersionId, projectRootInputFingerprint: null,
    workspaceScopeFingerprint: SCOPE, sourceSnapshotSha256,
    phase: 'planned', limits: { maxRoles: 3, maxConcurrentModelCalls: 2, maxModelCalls: 8,
      maxDurationMs: 1_200_000, maxAttemptsPerStep: 2, maxPlanRevisions: 2, maxToolRoundsPerStep: 3 },
    modelCalls: [], delegations: [], returnedResults: [], resultBatch: [], planRevisions: 0,
    preparedAt, startedAt: null, deadlineAt: null, updatedAt: preparedAt, stopReason: null,
  };
  task.integrationExecutionRequest = { goalVersionId: created.task.goalVersionId,
    displayPrompt: 'Prior request', prompt: originalPrompt, promptSha256: originalPromptSha256,
    preparedAt, instructionIds: ['suggestion-review-1'] };
  await fs.writeFile(file, JSON.stringify(task));

  const prepared = await controller.prepareRun(created.task.id, {
    expectedGoalVersionId: created.task.goalVersionId, expectedScopeFingerprint: SCOPE,
  });
  const stored = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(prepared.prepared.reused, true);
  assert.equal(prepared.prepared.promptRefreshed, true);
  assert.equal(stored.execution.id, executionId);
  assert.deepEqual(stored.execution.limits, task.execution.limits);
  assert.deepEqual(stored.execution.modelCalls, []);
  assert.equal(stored.execution.startedAt, null);
  assert.equal(stored.execution.deadlineAt, null);
  assert.equal(stored.execution.preparedAt, preparedAt);
  assert.equal(stored.integrationExecutionRequestHistory.length, 1);
  assert.equal(stored.integrationExecutionRequestHistory[0].prompt, originalPrompt);
  assert.equal(stored.integrationExecutionRequestHistory[0].promptSha256, originalPromptSha256);
  assert.equal(stored.integrationExecutionRequestHistory[0].archiveReason, 'unstarted_prompt_reprepared');
  assert.equal(stored.integrationExecutionRequest.prompt.includes(reviewText), true);
  assert.match(stored.integrationExecutionRequest.prompt, new RegExp(eventId));
  assert.match(stored.integrationExecutionRequest.prompt, new RegExp(resultSha256));
  assert.match(stored.integrationExecutionRequest.prompt, new RegExp(artifactId));
  assert.match(stored.integrationExecutionRequest.prompt, new RegExp(candidateSha256));
  assert.match(stored.integrationExecutionRequest.prompt, new RegExp(reviewId));
  const reprepareEvent = stored.events.at(-1);
  assert.equal(reprepareEvent.type, 'integration.product_execution_prompt_reprepared');
  assert.equal(reprepareEvent.detail.executionId, executionId);
  assert.equal(reprepareEvent.detail.priorPromptSha256, originalPromptSha256);
  assert.equal(reprepareEvent.detail.promptSha256, stored.integrationExecutionRequest.promptSha256);
  assert.equal(reprepareEvent.detail.modelCalls, 0);
  assert.equal(reprepareEvent.detail.startedAt, null);
  assert.equal(reprepareEvent.detail.deadlineAt, null);
});
