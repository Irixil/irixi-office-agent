import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { buildAuthorityProjection } from '../authority/authority-core.mjs';

import { createProductBootstrapController, groupPromptMaterials, confirmedLearningPreviewSourceMatches } from './product-bootstrap-controller.mjs';

const SCOPE = 'a'.repeat(64);
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);

test('confirmed learning preview accepts the real public artifact projection and rejects stale bindings', () => {
  const expected = { taskId: 'task-learning', projectId: 'article-learning-12', goalVersionId: 'goal-current',
    executionId: 'run-current', registrySha256: 'a'.repeat(64), artifactId: 'artifact-current',
    artifactVersion: 36, candidateSha256: 'b'.repeat(64) };
  const projection = {
    taskId: expected.taskId, current: true, goalVersionId: expected.goalVersionId,
    execution: { id: expected.executionId },
    native: { bindingCurrent: true, actions: { canPreview: true } },
    product: { projectId: expected.projectId, registrySha256: expected.registrySha256,
      capabilities: { staticPreviewEntries: ['index.html'] } },
    artifact: { id: expected.artifactId, version: expected.artifactVersion,
      candidateSha256: expected.candidateSha256, confirmation: { approvalId: 'approval-current' } },
  };
  assert.equal(Object.hasOwn(projection.artifact, 'status'), false);
  assert.equal(Object.hasOwn(projection.artifact, 'goalVersionId'), false);
  assert.equal(confirmedLearningPreviewSourceMatches(projection, expected), true);
  const alreadyReady = structuredClone(projection);
  alreadyReady.preview = { taskId: expected.taskId, goalVersionId: expected.goalVersionId,
    executionId: expected.executionId, registrySha256: expected.registrySha256,
    artifactId: expected.artifactId, artifactVersion: expected.artifactVersion,
    candidateSha256: expected.candidateSha256, entry: 'index.html', status: 'ready' };
  const unconfirmedReady = structuredClone(alreadyReady);
  unconfirmedReady.artifact.confirmation = null;
  assert.equal(confirmedLearningPreviewSourceMatches(unconfirmedReady, expected), false,
    'an already-ready URL is not reusable without the original confirmation');
  const replacedReadyCandidate = structuredClone(alreadyReady);
  replacedReadyCandidate.artifact.candidateSha256 = 'd'.repeat(64);
  assert.equal(confirmedLearningPreviewSourceMatches(replacedReadyCandidate, expected), false,
    'an already-ready URL is not reusable for a different candidate');
  for (const mutate of [
    (value) => { value.execution.id = 'run-stale'; },
    (value) => { value.product.registrySha256 = 'c'.repeat(64); },
    (value) => { value.artifact.candidateSha256 = 'd'.repeat(64); },
    (value) => { value.artifact.confirmation = null; },
  ]) {
    const stale = structuredClone(projection);
    mutate(stale);
    assert.equal(confirmedLearningPreviewSourceMatches(stale, expected), false);
  }
});

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
      return { taskDir: (id) => path.join(root, id), async init() { await fs.mkdir(root, { recursive: true }); },
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
  await fs.writeFile(path.join(app, 'memory.mjs'), `
    export function createMemoryService({ store }) {
      const matches = (entry, scope) => entry.scopeType === 'global' || entry.scopeType === 'project'
        && entry.scopeId === scope?.projectId && entry.scopeFingerprint === scope?.scopeFingerprint;
      return {
        async list(taskId, scope) {
          await store.get(taskId);
          return (await store.list()).flatMap(task => (task.memoryEntries || []).filter(entry => matches(entry, scope))
            .map(entry => ({ ...structuredClone(entry), ownerTaskId: task.id })));
        },
        async retrieve(taskId, query, scope) {
          const all = (await store.list()).flatMap(task => (task.memoryEntries || []).filter(entry => entry.status === 'active' && matches(entry, scope))
            .map(entry => ({ ...structuredClone(entry), ownerTaskId: task.id })));
          return { memories: all.map(entry => ({ id: entry.id, revision: entry.revision, kind: entry.kind,
            scopeType: entry.scopeType, title: entry.title, text: entry.text, source: entry.source, ownerTaskId: entry.ownerTaskId,
            application: entry.scopeType === 'global' ? 'direct_explicit_preference' : 'direct_project_convention' })),
            snapshot: all.map(entry => ({ id: entry.id, revision: entry.revision, scopeType: entry.scopeType,
              scopeId: entry.scopeId, scopeFingerprint: entry.scopeFingerprint || null, ownerTaskId: entry.ownerTaskId })),
            degraded: false, reason: null };
        },
        invalidateCache() {},
      };
    }
  `);
  let entries = catalog;
  const controller = await createProductBootstrapController({ tasksRoot: tasks, irixiAppRoot: app,
    projectCatalog: async () => entries, projectAuthorization });
  return { controller, tasks, app, setCatalog(value) { entries = value; } };
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
  const ledger = await controller.listTasks();
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].id, created.task.id);
  assert.equal(ledger[0].title, request().title);
  assert.equal(ledger[0].projectId, 'native-project-1');
  assert.equal(ledger[0].inFlight, false);
});

test('terminal task lifecycle wins over a stale executing phase while reserved or running calls remain in flight', async (t) => {
  const { controller, tasks } = await fixture(t);
  const created = await controller.createTask(request());
  const file = path.join(tasks, created.task.id, 'task.json');
  const task = JSON.parse(await fs.readFile(file, 'utf8'));
  task.status = 'ready_to_export';
  task.execution = { id: 'run-old', phase: 'executing', modelCalls: [{ status: 'completed' }] };
  await fs.writeFile(file, JSON.stringify(task));

  const terminal = await controller.state(task.id);
  assert.deepEqual(terminal.taskLifecycle, { status: 'ready_to_export', inFlight: false });
  assert.equal(terminal.execution.phase, 'executing', 'preserve historical phase without treating it as live work');
  assert.equal((await controller.taskSwitchState(task.id)).inFlight, false);

  for (const status of ['reserved', 'running']) {
    task.execution.modelCalls[0].status = status;
    await fs.writeFile(file, JSON.stringify(task));
    const active = await controller.state(task.id);
    assert.deepEqual(active.taskLifecycle, { status: 'ready_to_export', inFlight: true });
    assert.equal((await controller.taskSwitchState(task.id)).inFlight, true);
    assert.equal((await controller.listTasks()).find((item) => item.id === task.id).inFlight, true);
  }
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

test('persists only a whitelisted office function through task save, reload, and goal supplement', async (t) => {
  const { controller, tasks, app } = await fixture(t, [project()]);
  const created = await controller.createTask({ ...request(), functionId: 'utility', successCriteria: [], boundaries: [],
    projectId: project().projectId, projectScopeFingerprint: SCOPE, taskCreationRequestId: 'task-request-utility-123456' });
  assert.equal(created.created, true);
  assert.equal(created.task.functionId, 'utility');
  assert.deepEqual(created.task.successCriteria, []);
  assert.deepEqual(created.task.boundaries, []);
  for (const functionId of ['game', 'agent']) {
    const accepted = await controller.createTask({ ...request(), functionId });
    assert.equal(accepted.created, true);
    assert.equal(accepted.task.functionId, functionId);
  }

  const taskFile = path.join(tasks, created.task.id, 'task.json');
  const saved = JSON.parse(await fs.readFile(taskFile, 'utf8'));
  assert.equal(saved.functionId, 'utility');
  assert.equal(saved.execution, null);
  assert.equal(saved.productBootstrap.status, 'waiting_scope_authorization');

  const reloaded = await createProductBootstrapController({ tasksRoot: tasks, irixiAppRoot: app, projectCatalog: async () => [] });
  assert.equal((await reloaded.state(created.task.id)).task.functionId, 'utility');

  await controller.addInstruction(created.task.id, { expectedGoalVersionId: created.task.goalVersionId, text: '保留当前开发需求类别。' });
  assert.equal(JSON.parse(await fs.readFile(taskFile, 'utf8')).functionId, 'utility');
  assert.equal((await reloaded.state(created.task.id)).task.functionId, 'utility');
  await controller.replaceGoal(created.task.id, { expectedGoalVersionId: created.task.goalVersionId,
    statement: '调整后的小工具需求仍保留原职能。', successCriteria: [], boundaries: [] });
  assert.equal(JSON.parse(await fs.readFile(taskFile, 'utf8')).functionId, 'utility');
  assert.equal((await reloaded.state(created.task.id)).task.functionId, 'utility');
});

test('a repeated utility task-creation request resumes the same saved unexecuted task', async (t) => {
  const { controller, tasks } = await fixture(t, [project()]);
  const input = { ...request(), functionId: 'utility', successCriteria: [], boundaries: [],
    projectId: project().projectId, projectScopeFingerprint: SCOPE, taskCreationRequestId: 'task-request-1234567890' };
  const first = await controller.createTask(input);
  assert.equal(first.created, true);
  assert.equal(first.status, 'waiting_scope_authorization');
  assert.equal(first.execution, null);
  assert.equal(first.registry, null);
  const retry = await controller.createTask(input);
  assert.equal(retry.created, true);
  assert.equal(retry.reused, true);
  assert.equal(retry.task.id, first.task.id);
  assert.equal(retry.status, first.status);
  assert.deepEqual((await fs.readdir(tasks)).filter((entry) => entry.startsWith('task-')), [first.task.id]);
  const conflict = await controller.createTask({ ...input, statement: 'A different goal.' });
  assert.equal(conflict.created, false);
  assert.equal(conflict.reason.code, 'TASK_CREATION_REQUEST_CONFLICT');
  assert.deepEqual((await fs.readdir(tasks)).filter((entry) => entry.startsWith('task-')), [first.task.id]);
});

test('rejects an execution role used as a function id and does not create a task', async (t) => {
  const { controller, tasks } = await fixture(t);
  for (const functionId of ['reviewer', 'developer', '', 'learning']) {
    const result = await controller.createTask({ ...request(), functionId });
    assert.equal(result.created, false);
    assert.equal(result.reason.code, 'TASK_INPUT_INVALID');
    assert.equal(result.reason.field, 'functionId');
  }
  assert.deepEqual(await fs.readdir(tasks), []);
});

test('keeps older task records without functionId unclassified and validates optional lists', async (t) => {
  const { controller, tasks } = await fixture(t);
  const created = await controller.createTask(request());
  assert.equal(created.created, true);
  assert.equal(Object.hasOwn(created.task, 'functionId'), false);
  const saved = JSON.parse(await fs.readFile(path.join(tasks, created.task.id, 'task.json'), 'utf8'));
  assert.equal(Object.hasOwn(saved, 'functionId'), false);

  for (const field of ['successCriteria', 'boundaries']) {
    for (const invalid of ['not-an-array', [42], Array.from({ length: 13 }, (_, index) => `entry-${index}`)]) {
      const result = await controller.createTask({ ...request(), [field]: invalid });
      assert.equal(result.created, false);
      assert.match(result.reason.field, new RegExp(`^${field}`));
    }
  }
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
  const beforeLookup = await fs.readFile(file, 'utf8');
  const learningResult = await controller.findCurrentConfirmedResult(descriptor.projectId);
  assert.equal(learningResult.taskId, task.id);
  assert.equal(learningResult.canReuseCurrentResult, true);
  assert.deepEqual(learningResult.reuseInput, expected);
  assert.deepEqual(await controller.taskSwitchState(task.id), { taskId: task.id, title: task.title, status: task.status, inFlight: false });
  assert.equal(await fs.readFile(file, 'utf8'), beforeLookup, 'finding the confirmed result is read-only');
  const inFlightTask = JSON.parse(beforeLookup);
  inFlightTask.execution.modelCalls[0].status = 'running';
  await fs.writeFile(file, JSON.stringify(inFlightTask));
  assert.equal((await controller.taskSwitchState(task.id)).inFlight, true, 'active native calls block a task switch');
  await fs.writeFile(file, beforeLookup);
  const reservedTask = JSON.parse(beforeLookup);
  reservedTask.execution.modelCalls[0].status = 'reserved';
  await fs.writeFile(file, JSON.stringify(reservedTask));
  assert.equal((await controller.findCurrentConfirmedResult(descriptor.projectId)), null,
    'a reserved native call makes the confirmed result unavailable for recovery');
  const beforeReservedPrepare = await fs.readFile(file, 'utf8');
  await assert.rejects(() => controller.prepareRun(created.task.id, expected),
    (error) => error.code === 'RUN_REUSE_BINDING_STALE' && error.status === 409);
  assert.equal(await fs.readFile(file, 'utf8'), beforeReservedPrepare,
    'a reserved-call recovery rejection must not mutate the task');
  await fs.writeFile(file, beforeLookup);
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

test('current expired candidate with no Review record is eligible for exact read-only recovery', async (t) => {
  const sourceSnapshotSha256 = 'e'.repeat(64), sourceHead = 'f'.repeat(40);
  const descriptor = { ...project(), root: '/registered/project', sourceSnapshotSha256, sourceHead,
    sourceManifest: [{ path: 'src/main.ts', sha256: '1'.repeat(64), bytes: 12 }], checks: [{ id: 'typecheck' }],
    native: { maxAgents: 3, maxModelCalls: 8, maxDurationMs: 1_200_000 } };
  const { controller, tasks } = await fixture(t, [project()], async () => descriptor);
  const created = await controller.createTask(request());
  await controller.selectScope(created.task.id, { expectedGoalVersionId: created.task.goalVersionId,
    projectId: descriptor.projectId, expectedScopeFingerprint: SCOPE });
  await controller.authorizeScope(created.task.id, { expectedGoalVersionId: created.task.goalVersionId,
    projectId: descriptor.projectId, expectedScopeFingerprint: SCOPE });
  const prepared = await controller.prepareRun(created.task.id, {
    expectedGoalVersionId: created.task.goalVersionId, expectedScopeFingerprint: SCOPE,
  });
  const file = path.join(tasks, created.task.id, 'task.json');
  const task = JSON.parse(await fs.readFile(file, 'utf8'));
  const expiredAt = new Date(Date.now() - 1_000).toISOString();
  task.productBootstrap.registry = { status: 'registered', projectId: descriptor.projectId,
    scopeFingerprint: SCOPE, preparedAt: new Date(Date.now() - 5_000).toISOString() };
  task.execution.phase = 'partial'; task.execution.stopReason = 'execution_deadline_elapsed';
  task.execution.deadlineAt = expiredAt; task.execution.updatedAt = expiredAt; task.status = 'waiting_user';
  const registry = { taskId: task.id, goalVersionId: task.goal.activeVersionId, projectId: descriptor.projectId,
    workspace: { scopeFingerprint: SCOPE, sourceSnapshotSha256, sourceHead },
    native: { maxModelCalls: 8, maxDurationMs: 1_200_000 } };
  const registrySha256 = crypto.createHash('sha256').update(canonical(registry)).digest('hex');
  task.events.push({ id: 'registry-unreviewed-expired', at: expiredAt, type: 'integration.product_registry_registered',
    detail: { registry, registrySha256 } });
  const candidateSha256 = crypto.createHash('sha256').update('unreviewed candidate v41').digest('hex');
  const artifactId = 'artifact-unreviewed-v41';
  task.artifacts = [{ id: artifactId, version: 41, status: 'candidate', goalVersionId: task.goal.activeVersionId,
    nativeProjectCandidate: { version: 1, kind: 'native_worktree_candidate_v1', candidateSha256,
      taskInputBinding: task.projectWorkspace.taskInputBinding, workspaceScopeFingerprint: SCOPE,
      sourceSnapshotSha256, registrySha256 } }];
  task.reviews = []; task.approvals = [];
  await fs.writeFile(file, JSON.stringify(task));

  const liveState = await controller.state(created.task.id);
  assert.equal(liveState.blockedReason, 'explicit_new_run_required', JSON.stringify(liveState));
  assert.equal(liveState.canPrepareRun, true, JSON.stringify(liveState));
  const recovery = await controller.findCurrentFailedReviewCandidate(created.task.id);
  assert.ok(recovery, JSON.stringify({ selectedScope: liveState.setup?.selectedScope, registry: liveState.registry,
    execution: liveState.execution, inFlight: liveState.taskLifecycle?.inFlight }));
  assert.equal(recovery.taskId, created.task.id);
  assert.equal(recovery.executionId, prepared.execution.id);
  assert.equal(recovery.artifact.id, artifactId);
  assert.equal(recovery.artifact.version, 41);
  assert.equal(recovery.artifact.candidateSha256, candidateSha256);
  assert.equal(recovery.artifact.review, null);
  assert.equal(recovery.reviewRound, null);
  assert.equal((await controller.taskSwitchState(created.task.id)).inFlight, false);

  for (const [stopReason, phase, status] of [
    ['paused_by_user', 'paused', 'waiting_user'],
    ['cancelled_by_user', 'cancelled', 'cancelled'],
  ]) {
    task.execution.stopReason = stopReason;
    task.execution.phase = phase;
    task.status = status;
    await fs.writeFile(file, JSON.stringify(task));
    assert.equal(await controller.findCurrentFailedReviewCandidate(created.task.id), null, stopReason);
  }
});

test('restores an archived confirmed result over an untouched unstarted round with full CAS and idempotency', async (t) => {
  const sourceSnapshotSha256 = 'e'.repeat(64), sourceHead = 'f'.repeat(40);
  const descriptor = { ...project(), root: '/registered/project', sourceSnapshotSha256, sourceHead,
    sourceManifest: [{ path: 'src/main.ts', sha256: '1'.repeat(64), bytes: 12 }],
    checks: [{ id: 'typecheck' }], native: { maxAgents: 3, maxModelCalls: 8, maxDurationMs: 1_200_000 } };
  const { controller, tasks } = await fixture(t, [project()], async () => descriptor);
  const created = await controller.createTask(request());
  await controller.selectScope(created.task.id, { expectedGoalVersionId: created.task.goalVersionId,
    projectId: descriptor.projectId, expectedScopeFingerprint: SCOPE });
  await controller.authorizeScope(created.task.id, { expectedGoalVersionId: created.task.goalVersionId,
    projectId: descriptor.projectId, expectedScopeFingerprint: SCOPE });
  await controller.prepareRun(created.task.id, { expectedGoalVersionId: created.task.goalVersionId,
    expectedScopeFingerprint: SCOPE });
  const file = path.join(tasks, created.task.id, 'task.json');
  const task = JSON.parse(await fs.readFile(file, 'utf8'));
  const workspace = await import(pathToFileURL(path.join(path.dirname(tasks), 'app', 'project-workspace.mjs')).href);
  const helpers = { activeGoal: (value) => value.goal.versions.find((entry) => entry.id === value.goal.activeVersionId),
    ...workspace, artifactInputIsCurrent: () => false, projectCandidateFingerprint: () => null };
  const preparedAt = new Date(Date.now() - 1_300_000).toISOString();
  const r44Execution = { ...task.execution, id: 'run-r44', phase: 'partial', stopReason: 'execution_deadline_elapsed',
    preparedAt, startedAt: new Date(Date.now() - 1_250_000).toISOString(),
    deadlineAt: new Date(Date.now() - 50_000).toISOString(), updatedAt: new Date(Date.now() - 40_000).toISOString(),
    modelCalls: Array.from({ length: 5 }, (_, index) => ({ id: `call-r44-${index + 1}`,
      status: index === 4 ? 'failed' : 'completed', startedAt: preparedAt, finishedAt: new Date(Date.now() - 60_000).toISOString() })) };
  const r44Request = { ...task.integrationExecutionRequest, preparedAt };
  task.execution = r44Execution;
  task.integrationExecutionRequest = r44Request;
  task.productBootstrap.registry = { status: 'registered', projectId: descriptor.projectId, scopeFingerprint: SCOPE, preparedAt };
  const r44Projection = buildAuthorityProjection(task, helpers);
  const r44Registry = { schemaVersion: 1, authorityUrl: 'http://127.0.0.1:3869/', taskId: task.id,
    goalVersionId: task.goal.activeVersionId, projectId: descriptor.projectId,
    taskInputBindingSha256: r44Projection.taskInputBindingSha256,
    pipelineBindingSha256: r44Projection.pipelineBindingSha256,
    workspace: { scopeFingerprint: SCOPE, sourceSnapshotSha256, sourceHead,
      sourceManifest: descriptor.sourceManifest, allowedWritePaths: descriptor.allowedWritePaths, checks: ['typecheck'] },
    native: { backend: 'codex', allowedRoles: ['Lead', 'Senior Developer', 'Reviewer'], maxModelCalls: 8,
      maxDurationMs: 1_200_000, promptBudget: { contextWindowTokens: 1000, effectiveContextPercent: 80, outputTokens: 100, protocolTokens: 100 } },
    capabilities: { staticPreviewEntries: ['index.html'], autoMerge: false, manualMerge: false, commandPreview: false } };
  const digest = (value) => crypto.createHash('sha256').update(canonical(value)).digest('hex');
  const r44RegistrySha256 = digest(r44Registry);
  const r44RegistryEvent = { id: 'registry-r44', at: preparedAt, type: 'integration.product_registry_registered',
    detail: { registry: r44Registry, registrySha256: r44RegistrySha256 } };
  task.events.push(r44RegistryEvent);
  const candidateSha256 = 'a'.repeat(64), artifactId = 'artifact-v15', reviewId = 'review-v15', approvalId = 'approval-v15';
  task.artifacts = [{ id: artifactId, version: 15, status: 'confirmed', reviewStatus: 'passed', goalVersionId: task.goal.activeVersionId,
    nativeProjectCandidate: { version: 1, kind: 'native_worktree_candidate_v1', candidateSha256,
      taskInputBinding: workspace.projectTaskBinding(task), workspaceScopeFingerprint: SCOPE,
      sourceSnapshotSha256, registrySha256: r44RegistrySha256 } }];
  task.reviews = [{ id: reviewId, artifactId, passed: true, goalVersionId: task.goal.activeVersionId,
    candidateSha256, registrySha256: r44RegistrySha256 }];
  task.approvals = [{ id: approvalId, artifactId, artifactVersion: 15, status: 'confirmed',
    goalVersionId: task.goal.activeVersionId, candidateSha256, reviewId }];
  const r44ArchiveAt = new Date().toISOString();
  task.executionHistory = [{ ...structuredClone(r44Execution), archivedAt: r44ArchiveAt, archiveReason: 'explicit_new_run' }];
  task.integrationExecutionRequestHistory = [{ ...structuredClone(r44Request), archivedAt: r44ArchiveAt, archiveReason: 'explicit_new_run' }];
  task.productBootstrap.registryHistory = [{ ...structuredClone(task.productBootstrap.registry), archivedAt: r44ArchiveAt, reason: 'explicit_new_run' }];
  task.events.push({ id: 'archive-r44', at: r44ArchiveAt, type: 'integration.product_execution_archived',
    detail: { priorExecutionId: r44Execution.id, reason: 'explicit_new_run' } });

  const r45PreparedAt = new Date().toISOString();
  const r45Execution = { ...structuredClone(r44Execution), id: 'run-r45', phase: 'planned', stopReason: null,
    preparedAt: r45PreparedAt, startedAt: null, deadlineAt: null, updatedAt: r45PreparedAt, modelCalls: [],
    delegations: [], returnedResults: [], resultBatch: [], planRevisions: 0 };
  const r45Prompt = 'R45 current prompt stays untouched.';
  const r45Request = { goalVersionId: task.goal.activeVersionId, displayPrompt: task.goal.versions[0].statement,
    prompt: r45Prompt, promptSha256: crypto.createHash('sha256').update(r45Prompt).digest('hex'), preparedAt: r45PreparedAt };
  task.execution = r45Execution;
  task.integrationExecutionRequest = r45Request;
  task.productBootstrap.registry = { status: 'runtime_starting', projectId: descriptor.projectId, scopeFingerprint: SCOPE, preparedAt: r45PreparedAt };
  const r45Projection = buildAuthorityProjection(task, helpers);
  const r45Registry = { ...r44Registry, pipelineBindingSha256: r45Projection.pipelineBindingSha256 };
  const r45RegistrySha256 = digest(r45Registry);
  task.events.push({ id: 'registry-r45', at: new Date(Date.parse(r45PreparedAt) + 1).toISOString(), type: 'integration.product_registry_registered',
    detail: { registry: r45Registry, registrySha256: r45RegistrySha256 } });
  await fs.writeFile(file, JSON.stringify(task));
  const archivedPromptSha256 = r44Request.promptSha256;
  const input = { mode: 'reuse_current_result', expectedGoalVersionId: task.goal.activeVersionId,
    expectedScopeFingerprint: SCOPE, expectedExecutionId: r44Execution.id,
    expectedExecutionSha256: digest(task.executionHistory[0]), expectedPromptSha256: archivedPromptSha256,
    expectedRegistrySha256: r44RegistrySha256, expectedArtifactId: artifactId, expectedArtifactVersion: 15,
    expectedCandidateSha256: candidateSha256, expectedReviewId: reviewId, expectedApprovalId: approvalId,
    expectedCurrentExecutionId: r45Execution.id, expectedCurrentExecutionSha256: digest(r45Execution),
    expectedCurrentPromptSha256: r45Request.promptSha256, expectedCurrentRegistrySha256: r45RegistrySha256 };
  const baseline = await fs.readFile(file, 'utf8');

  const invalidCases = [
    (value) => { value.execution.startedAt = r45PreparedAt; },
    (value) => { value.execution.modelCalls.push({ id: 'call-r45', status: 'completed' }); },
    (value) => { value.events.push({ id: 'reserve-r45', type: 'integration.product_native_call_reserved',
      detail: { executionId: r45Execution.id, modelCallId: 'call-r45' } }); },
    (value) => { value.integrationExecutionRequestHistory[0].prompt += ' altered'; },
    (value) => { value.artifacts[0].nativeProjectCandidate.candidateSha256 = 'b'.repeat(64); },
    (value) => { value.reviews[0].candidateSha256 = 'b'.repeat(64); },
    (value) => { value.approvals[0].reviewId = 'review-other'; },
    (value) => { value.events.find((entry) => entry.id === 'registry-r44').detail.registry.workspace.sourceHead = '0'.repeat(40); },
  ];
  for (const alter of invalidCases) {
    await fs.writeFile(file, baseline);
    const changed = JSON.parse(baseline); alter(changed); await fs.writeFile(file, JSON.stringify(changed));
    const unchanged = await fs.readFile(file, 'utf8');
    await assert.rejects(() => controller.prepareRun(task.id, input), (error) => error.code === 'RUN_REUSE_BINDING_STALE');
    assert.equal(await fs.readFile(file, 'utf8'), unchanged);
  }

  await fs.writeFile(file, baseline);
  const restored = await controller.prepareRun(task.id, input);
  assert.equal(restored.execution.id, r44Execution.id);
  assert.equal(restored.prepared.restored, true);
  let after = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(after.execution.phase, 'partial');
  assert.equal(after.execution.stopReason, 'execution_deadline_elapsed');
  assert.deepEqual(after.execution.modelCalls, r44Execution.modelCalls);
  assert.equal(after.execution.deadlineAt, r44Execution.deadlineAt);
  assert.equal(after.executionHistory.length, 1);
  assert.equal(after.executionHistory[0].id, r45Execution.id);
  assert.deepEqual(after.executionHistory[0].modelCalls, []);
  assert.equal(after.integrationExecutionRequestHistory[0].promptSha256, r45Request.promptSha256);
  assert.equal(after.productBootstrap.registryHistory[0].preparedAt, r45PreparedAt);
  assert.equal(after.events.filter((entry) => entry.type === 'integration.product_native_call_reserved'
    && entry.detail?.executionId === r44Execution.id).length, 0);
  const once = await fs.readFile(file, 'utf8');
  const retried = await controller.prepareRun(task.id, input);
  assert.equal(retried.prepared.idempotent, true);
  assert.equal(await fs.readFile(file, 'utf8'), once);
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
  task.productBootstrap.registryHistory = Array.from({ length: 25 }, (_, i) => ({ id: `prior-registry-${i}` }));
  task.productBootstrap.authorizationHistory = Array.from({ length: 25 }, (_, i) => ({ id: `prior-authorization-${i}` }));

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
  assert.equal(afterSelection.productBootstrap.authorizationHistory.length, 26);
  assert.equal(afterSelection.productBootstrap.authorizationHistory[0].id, 'prior-authorization-0');
  assert.equal(afterSelection.productBootstrap.registryHistory.length, 26);
  assert.equal(afterSelection.productBootstrap.registryHistory[0].id, 'prior-registry-0');
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

test('direct Chinese preference is in the prepared prompt and a pre-run memory change makes the same run stale', async (t) => {
  const descriptor = { ...project(), root: '/registered/project', sourceSnapshotSha256: 'e'.repeat(64), sourceHead: 'f'.repeat(40),
    sourceManifest: [{ path: 'src/main.ts', sha256: '1'.repeat(64), bytes: 12 }], checks: [{ id: 'typecheck' }],
    native: { maxAgents: 3, maxModelCalls: 8, maxDurationMs: 1_200_000 } };
  const { controller, tasks } = await fixture(t, [project()], async () => descriptor);
  const created = await controller.createTask(request());
  await controller.selectScope(created.task.id, { expectedGoalVersionId: created.task.goalVersionId,
    projectId: descriptor.projectId, expectedScopeFingerprint: SCOPE });
  await controller.authorizeScope(created.task.id, { expectedGoalVersionId: created.task.goalVersionId,
    projectId: descriptor.projectId, expectedScopeFingerprint: SCOPE });
  const file = path.join(tasks, created.task.id, 'task.json');
  const task = JSON.parse(await fs.readFile(file, 'utf8'));
  task.memoryEntries = [{ id: 'memory-direct-1', revision: 1, kind: 'preference', scopeType: 'global', scopeId: 'personal',
    title: '回答风格', text: '回答先给结论，用简短中文。', status: 'active', ownerTaskId: created.task.id,
    source: { type: 'explicit_user_action', taskId: created.task.id, eventId: 'event-memory-1', revision: 1 } }];
  await fs.writeFile(file, JSON.stringify(task));

  const prepared = await controller.prepareRun(created.task.id, { expectedGoalVersionId: created.task.goalVersionId,
    expectedScopeFingerprint: SCOPE });
  let stored = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.match(stored.integrationExecutionRequest.prompt, /direct explicit personal preference/);
  assert.match(stored.integrationExecutionRequest.prompt, /回答先给结论，用简短中文。/);
  assert.equal(stored.integrationExecutionRequest.memoryReferences[0].application, 'direct_explicit_preference');
  assert.equal(stored.execution.modelCalls.length, 0);

  stored.memoryEntries[0].status = 'deactivated';
  stored.memoryEntries[0].revision = 2;
  await fs.writeFile(file, JSON.stringify(stored));
  const stale = await controller.state(created.task.id, { refreshMemories: true });
  assert.equal(stale.memory.stalePreparedPrompt, true);
  const refreshed = await controller.prepareRun(created.task.id, { expectedGoalVersionId: created.task.goalVersionId,
    expectedScopeFingerprint: SCOPE });
  stored = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(refreshed.execution.id, prepared.execution.id);
  assert.doesNotMatch(stored.integrationExecutionRequest.prompt, /回答先给结论，用简短中文。/);
  assert.equal(stored.integrationExecutionRequest.memoryReferences.length, 0);
  assert.equal(stored.execution.modelCalls.length, 0);
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

test('registered game catalog admits only the exact writable Noobi playtest path', async (t) => {
  const game = { ...project(), projectId: 'noobi-owl-book-sorter-v1',
    allowedWritePaths: ['.noobi/playtest.json', 'index.html'] };
  const { controller, setCatalog } = await fixture(t, [game]);
  assert.deepEqual((await controller.listRegisteredProjects())[0].allowedWritePaths, game.allowedWritePaths);
  for (const unsafe of ['.noobi/project.json', '.noobi/nested/playtest.json', '.env', '.envrc', '../escape.json']) {
    setCatalog([{ ...game, allowedWritePaths: [...game.allowedWritePaths, unsafe] }]);
    await assert.rejects(() => controller.listRegisteredProjects(), (error) => error.code === 'PROJECT_CATALOG_INVALID');
  }
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
  const currentFocus = "Current failure: test-core.js:132 calls canOpenBatch with {remaining:0,running:false,sealed:false} and a matching goal/artifact; expected true. The missing-goal counterexample must remain false. Keep the registered checks and constraints.";
  task.suggestions.push({ id: 'suggestion-current-focus', goalVersionId: created.task.goalVersionId,
    classification: 'support', status: 'routed', text: currentFocus, createdAt: '2026-10-14T10:00:00.000Z' });
  task.events.push({ id: eventId, type: 'integration.observation', detail: {
    type: 'TASK_DONE', actor: 'reviewer', scopeOutcome: 'completed', resultSha256, reviewText,
    binding: { taskId: task.id, goalVersionId: created.task.goalVersionId, executionId,
      workspaceScopeFingerprint: SCOPE, sourceSnapshotSha256, artifactId, artifactVersion: 9, candidateSha256 },
  } });
  task.events.push({ id: 'event-reviewed-1', type: 'integration.product_native_reviewed', detail: {
    artifactId, reviewId, verdict: 'FAIL', candidateSha256,
  } });
  const linkedHistory = structuredClone(task.events.slice(-2));
  task.events = Array.from({ length: 500 }, (_, index) => ({ id: `event-tail-${index}`, type: 'task.state', detail: {} }));
  await fs.writeFile(path.join(tasks, created.task.id, 'events.jsonl'), `${linkedHistory.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
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
  assert.match(stored.integrationExecutionRequest.prompt, new RegExp(reviewText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(stored.integrationExecutionRequestHistory[0].prompt, originalPrompt);
  assert.equal(stored.integrationExecutionRequestHistory[0].promptSha256, originalPromptSha256);
  assert.equal(stored.integrationExecutionRequestHistory[0].archiveReason, 'unstarted_prompt_reprepared');
  assert.doesNotMatch(stored.integrationExecutionRequestHistory[0].prompt, /Current work focus/);
  const preparedPrompt = stored.integrationExecutionRequest.prompt;
  assert.match(preparedPrompt, /Current work focus \(does not replace the accepted Goal, success criteria, boundaries, or authority\):/);
  assert.equal(preparedPrompt.split(currentFocus).length - 1, 1);
  assert.match(preparedPrompt, /Other accepted instructions \(the current work focus is shown above once\):/);
  assert.match(preparedPrompt, /suggestion-review-1/);
  assert.match(preparedPrompt, /Goal: Connect the accepted native project\./);
  assert.match(preparedPrompt, /The final success condition remains present\./);
  assert.match(preparedPrompt, /Do not authorize or execute during bootstrap\./);
  assert.match(preparedPrompt, /Authorized writable files:\n- src\/main\.ts/);
  assert.match(preparedPrompt, /Registered host checks:\n- typecheck/);
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
  linkedHistory[0].detail.reviewText += 'tampered';
  await fs.writeFile(path.join(tasks, created.task.id, 'events.jsonl'), `${linkedHistory.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  await assert.rejects(() => controller.prepareRun(created.task.id, {
    expectedGoalVersionId: created.task.goalVersionId, expectedScopeFingerprint: SCOPE,
  }), (error) => error.code === 'NATIVE_REVIEW_FEEDBACK_INVALID');
});
