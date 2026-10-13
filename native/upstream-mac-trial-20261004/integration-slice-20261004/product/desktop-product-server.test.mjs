import assert from 'node:assert/strict';
import { spawn, execFile as execFileCallback } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { createProductBootstrapController } from './product-bootstrap-controller.mjs';
import { createTrustedProductProjects } from './trusted-product-projects.mjs';

const execFile = promisify(execFileCallback);
const here = import.meta.dirname;
const desktopRoot = path.resolve(import.meta.dirname, '../../../..');

test('default product catalog preserves the starter and publicly lists the confirmed article project', async () => {
  const file = await fs.realpath(path.join(here, 'registered-projects.local.json'));
  const definitions = JSON.parse(await fs.readFile(file, 'utf8')).projects;
  assert.deepEqual(definitions[0].native, {
    backend: 'codex', model: 'gpt-5.6-sol', allowedRoles: ['Lead', 'Senior Developer', 'Reviewer'],
    maxAgents: 3, maxModelCalls: 8, maxDurationMs: 1_200_000,
  });
  assert.equal(definitions[1].native.maxModelCalls, 8);
  assert.equal(definitions[1].native.maxDurationMs, 1_200_000);
  const catalog = await createTrustedProductProjects({ file });
  const projects = await catalog.listPublic();
  assert.deepEqual(projects.map((entry) => entry.projectId), ['agent-office-native-server', 'article-learning-12']);
  const starter = projects[0];
  assert.deepEqual(starter.allowedWritePaths, [
    'packages/server/src/index.ts',
    'packages/server/src/irixi-authority.ts',
    'packages/server/src/memory/MemoryStore.ts',
    'packages/server/src/rooms/OfficeRoom.ts',
  ]);
  const article = projects[1];
  assert.deepEqual(article.staticPreviewEntries, ['index.html']);
  assert.deepEqual(article.checkIds, ['node-syntax-v1', 'article-learning-core-v1']);
  assert.equal(article.current, true);
});

async function unusedPort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForDesktop(child) {
  let stdout = '', stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`desktop server readiness timed out: ${stderr}`)), 15_000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const lines = stdout.split('\n'); stdout = lines.pop() || '';
      for (const line of lines) {
        try {
          const value = JSON.parse(line);
          if (value?.ok === true && value?.desktop) {
            clearTimeout(timer); resolve(value); return;
          }
        } catch {}
      }
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`desktop server exited before readiness (${code ?? signal ?? 'unknown'}): ${stderr}`));
    });
  });
}

async function jsonRequest(base, pathname, body) {
  const response = await fetch(new URL(pathname, base), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test('product input HTTP contract reads once, prefers matching authority, and falls back only on explicit local absence', async (t) => {
  await fs.access(path.join(desktopRoot, 'app', 'core.mjs'));
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-product-http-')));
  const tasksRoot = path.join(temporary, 'tasks');
  const projectRoot = path.join(temporary, 'registered-project');
  await fs.mkdir(tasksRoot, { recursive: true });
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.writeFile(path.join(projectRoot, 'main.js'), 'export const current = true;\n');
  await execFile('git', ['init', '-q', projectRoot]);
  await execFile('git', ['-C', projectRoot, 'config', 'user.name', 'Irixi Test']);
  await execFile('git', ['-C', projectRoot, 'config', 'user.email', 'irixi-test@example.invalid']);
  await execFile('git', ['-C', projectRoot, 'add', 'main.js']);
  await execFile('git', ['-C', projectRoot, 'commit', '-qm', 'fixture']);
  const catalogue = path.join(temporary, 'catalogue.json');
  await fs.writeFile(catalogue, JSON.stringify({ schemaVersion: 1, projects: [{
    projectId: 'http-contract-fixture', label: 'HTTP contract fixture', root: projectRoot,
    baselinePaths: ['main.js'], allowedWritePaths: ['main.js'], checks: [{ id: 'node-syntax-v1' }],
    native: { backend: 'codex', model: 'gpt-5.6-sol', allowedRoles: ['Lead'], maxAgents: 1, maxModelCalls: 1, maxDurationMs: 300_000 },
  }] }));

  const desktopPort = await unusedPort();
  const authorityPort = await unusedPort();
  const nativePort = await unusedPort();
  const bindingFile = path.join(here, 'runtime', `http-contract-${process.pid}-${Date.now()}.json`);
  const child = spawn(process.execPath, [path.join(here, 'desktop-product-server.mjs')], {
    cwd: here,
    env: {
      ...process.env,
      IRIXI_DESKTOP_ROOT: desktopRoot,
      IRIXI_DESKTOP_PORT: String(desktopPort),
      IRIXI_NATIVE_URL: `http://127.0.0.1:${nativePort}/`,
      IRIXI_PRODUCT_AUTHORITY_URL: `http://127.0.0.1:${authorityPort}/`,
      IRIXI_AUTHORITY_TASKS_ROOT: tasksRoot,
      IRIXI_PRODUCT_PROJECT_CATALOG_FILE: catalogue,
      IRIXI_PRODUCT_BINDING_FILE: bindingFile,
      IRIXI_PRODUCT_ENABLE_AI: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let authorityServer = null;
  let nativeServer = null;
  t.after(async () => {
    if (nativeServer) await new Promise((resolve) => nativeServer.close(resolve));
    if (authorityServer) await new Promise((resolve) => authorityServer.close(resolve));
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
    await fs.rm(bindingFile, { force: true });
    await fs.rm(temporary, { recursive: true, force: true });
  });
  const ready = await waitForDesktop(child);
  const base = ready.desktop;

  const malformed = await jsonRequest(base, '/api/product/tasks', '{"statement":');
  assert.equal(malformed.status, 400);
  assert.deepEqual(malformed.body.reason, { code: 'REQUEST_JSON_INVALID', message: 'Request body must be valid UTF-8 JSON.' });
  assert.deepEqual(malformed.body.error, malformed.body.reason);
  const scalar = await jsonRequest(base, '/api/product/tasks', '"not-an-object"');
  assert.equal(scalar.status, 400);
  assert.equal(scalar.body.reason.code, 'REQUEST_JSON_OBJECT_REQUIRED');

  const sensitiveRejectedInput = `private-${'x'.repeat(2_200)}`;
  const invalidTask = await jsonRequest(base, '/api/product/tasks', {
    title: 'HTTP contract', statement: 'Reject without reflecting the submitted bytes.',
    successCriteria: [sensitiveRejectedInput], boundaries: ['No model calls.'],
  });
  assert.equal(invalidTask.status, 413);
  assert.equal(invalidTask.body.reason.code, 'TASK_INPUT_OUT_OF_RANGE');
  assert.equal(JSON.stringify(invalidTask.body).includes(sensitiveRejectedInput), false);
  assert.equal(Object.hasOwn(invalidTask.body, 'request'), false);

  const created = await jsonRequest(base, '/api/product/tasks', {
    title: 'HTTP contract', statement: 'Route every product input through the current authority.',
    successCriteria: ['Authority owns accepted task-input mutations.'], boundaries: ['No model calls.'],
  });
  assert.equal(created.status, 201);
  const taskId = created.body.task.id;
  const goalVersionId = created.body.task.goalVersionId;

  const fallback = await jsonRequest(base, `/api/product/tasks/${taskId}/actions`, {
    action: 'support', expectedGoalVersionId: goalVersionId, text: 'Saved only after both fixed authority probes were explicitly refused.',
  });
  assert.equal(fallback.status, 201);
  assert.equal(fallback.body.accepted, true);
  assert.equal(typeof fallback.body.suggestionId, 'string');

  const authorityRequests = [];
  let authorityMode = 'accept';
  let authorityProjectionMode = 'accept';
  let authorityProjection = { projection: { taskId } };
  const projectionRejectionBytes = Buffer.from(JSON.stringify({
    code: 'AUTHORITY_PROJECTION_STALE', error: 'sensitive local path /Users/private/projection.json',
  }));
  const mutationRejectionBytes = Buffer.from(JSON.stringify({
    error: 'Product instruction belongs to an older authority binding; /Users/private/authority-state.json',
  }));
  authorityServer = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url?.startsWith('/v1/authority?')) {
      if (authorityProjectionMode === 'missing' || authorityProjectionMode === 'unrelated-404') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: authorityProjectionMode === 'missing' ? 'Unknown task' : 'Not found' })); return;
      }
      if (authorityProjectionMode === 'reject') {
        res.writeHead(409, { 'content-type': 'application/json' }); res.end(projectionRejectionBytes); return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(authorityProjection)); return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    authorityRequests.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
    if (authorityMode === 'reset') { req.socket.destroy(); return; }
    if (authorityMode === 'reject') {
      res.writeHead(409, { 'content-type': 'application/json' });
      res.end(mutationRejectionBytes); return;
    }
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ storedByAuthority: true }));
  });
  await new Promise((resolve, reject) => authorityServer.once('error', reject).listen(authorityPort, '127.0.0.1', resolve));

  authorityProjectionMode = 'unrelated-404';
  const unrelated404 = await jsonRequest(base, `/api/product/tasks/${taskId}/actions`, {
    action: 'support', expectedGoalVersionId: goalVersionId, text: 'A generic route error must not enter the local store.',
  });
  assert.equal(unrelated404.status, 404);
  assert.equal(unrelated404.body.reason.code, 'PRODUCT_AUTHORITY_REJECTED');

  authorityProjectionMode = 'missing';
  const missingFallback = await jsonRequest(base, `/api/product/tasks/${taskId}/actions`, {
    action: 'support', expectedGoalVersionId: goalVersionId, text: 'A different task authority must not block this unexecuted draft.',
  });
  assert.equal(missingFallback.status, 201);
  assert.equal(typeof missingFallback.body.suggestionId, 'string');
  assert.equal(authorityRequests.length, 0);
  authorityProjectionMode = 'accept';

  const routed = await jsonRequest(base, `/api/product/tasks/${taskId}/actions`, {
    action: 'material', expectedGoalVersionId: goalVersionId, name: 'Bounded note', text: 'Authority-owned bytes.',
  });
  assert.equal(routed.status, 201);
  assert.equal(routed.body.storedByAuthority, true);
  assert.deepEqual(authorityRequests.at(-1), {
    url: '/v1/product-materials',
    body: { expectedGoalVersionId: goalVersionId, name: 'Bounded note', text: 'Authority-owned bytes.' },
  });

  const taskFile = path.join(tasksRoot, taskId, 'task.json');
  const runningTask = JSON.parse(await fs.readFile(taskFile, 'utf8'));
  runningTask.execution = { id: 'run-http-contract', phase: 'planned', modelCalls: [] };
  await fs.writeFile(taskFile, JSON.stringify(runningTask));
  const routedAfterNativeRefusal = await jsonRequest(base, `/api/product/tasks/${taskId}/actions`, {
    action: 'support', expectedGoalVersionId: goalVersionId, text: 'The same cached body reaches authority after the native port refuses.',
  });
  assert.equal(routedAfterNativeRefusal.status, 201);
  assert.equal(routedAfterNativeRefusal.body.storedByAuthority, true);
  assert.deepEqual(authorityRequests.at(-1), {
    url: '/v1/product-instructions',
    body: { expectedGoalVersionId: goalVersionId, text: 'The same cached body reaches authority after the native port refuses.' },
  });

  authorityMode = 'reject';
  const rejected = await jsonRequest(base, `/api/product/tasks/${taskId}/actions`, {
    action: 'support', expectedGoalVersionId: goalVersionId, text: 'Must not enter the local store after an authority rejection.',
  });
  assert.equal(rejected.status, 409);
  assert.deepEqual(rejected.body.reason, {
    code: 'PRODUCT_AUTHORITY_REJECTED',
    message: 'The current Irixi authority rejected this task input update.',
    authorityStage: 'mutation',
    authorityResponseSha256: crypto.createHash('sha256').update(mutationRejectionBytes).digest('hex'),
    authorityMessage: 'Product instruction belongs to an older authority binding; [redacted-path]',
  });
  assert.equal(JSON.stringify(rejected.body).includes('/Users/private'), false);

  authorityMode = 'accept';
  authorityProjectionMode = 'reject';
  const projectionRejected = await jsonRequest(base, `/api/product/tasks/${taskId}/actions`, {
    action: 'support', expectedGoalVersionId: goalVersionId, text: 'Projection failures must retain their source stage.',
  });
  assert.equal(projectionRejected.status, 409);
  assert.equal(projectionRejected.body.reason.authorityStage, 'projection');
  assert.equal(projectionRejected.body.reason.authorityCode, 'AUTHORITY_PROJECTION_STALE');
  assert.equal(projectionRejected.body.reason.authorityResponseSha256,
    crypto.createHash('sha256').update(projectionRejectionBytes).digest('hex'));
  assert.equal(JSON.stringify(projectionRejected.body).includes('/Users/private'), false);
  authorityProjectionMode = 'accept';

  const beforeReset = JSON.parse(await fs.readFile(taskFile, 'utf8')).suggestions.length;
  authorityMode = 'reset';
  const ambiguous = await jsonRequest(base, `/api/product/tasks/${taskId}/actions`, {
    action: 'support', expectedGoalVersionId: goalVersionId, text: 'A reset is ambiguous and must never trigger local fallback.',
  });
  assert.equal(ambiguous.status, 503);
  assert.equal(ambiguous.body.reason.code, 'PRODUCT_AUTHORITY_UNAVAILABLE');
  assert.equal(JSON.parse(await fs.readFile(taskFile, 'utf8')).suggestions.length, beforeReset);

  const currentProjects = await fetch(new URL('/api/product/projects', base)).then((response) => response.json());
  const currentProject = currentProjects.projects.find((entry) => entry.projectId === 'http-contract-fixture');
  assert.equal(currentProject.current, true);
  const staleScope = '0'.repeat(64);
  const staleTask = JSON.parse(await fs.readFile(taskFile, 'utf8'));
  staleTask.productBootstrap = {
    schemaVersion: 1, status: 'runtime_starting',
    scopeSelections: [{ id: 'old-scope-selection', projectId: currentProject.projectId,
      scopeFingerprint: staleScope, goalVersionId, selectedAt: '2026-10-12T06:30:00.000Z' }],
    currentScopeSelectionId: 'old-scope-selection',
    authorizedProject: { projectId: currentProject.projectId, scopeFingerprint: staleScope,
      sourceSnapshotSha256: '1'.repeat(64), sourceHead: '2'.repeat(40), authorizedAt: '2026-10-12T06:30:00.000Z' },
    registry: { status: 'runtime_starting', projectId: currentProject.projectId,
      scopeFingerprint: staleScope, preparedAt: '2026-10-12T06:31:00.000Z' },
  };
  staleTask.projectWorkspace = { status: 'ready', scopeFingerprint: staleScope, goalVersionId };
  staleTask.execution = { id: 'run-stale-scope', goalVersionId, phase: 'failed',
    stopReason: 'native_process_failed', startedAt: '2026-10-12T06:32:00.000Z',
    deadlineAt: '2026-10-12T06:52:00.000Z', modelCalls: [{ id: 'call-stale-scope', status: 'failed', error: 'native_process_failed' }] };
  staleTask.integrationExecutionRequest = { goalVersionId, prompt: 'Old bound request', promptSha256: '3'.repeat(64) };
  await fs.writeFile(taskFile, JSON.stringify(staleTask));

  const setupState = await fetch(new URL('/api/product-state', base)).then((response) => response.json());
  assert.equal(setupState.status, 'waiting_scope');
  assert.equal(setupState.task.id, taskId);
  assert.equal(setupState.setup.selectedScope.current, false);
  assert.equal(setupState.setup.projects.find((entry) => entry.projectId === currentProject.projectId).scopeFingerprint,
    currentProject.scopeFingerprint);
  assert.equal(setupState.native.actions.canScope, true);
  assert.equal(setupState.native.actions.canAuthorizeScope, false);
  assert.equal(setupState.native.actions.canRun, false);
  assert.equal(setupState.blockedReason, 'registered_project_scope_required');

  staleTask.productBootstrap.status = 'waiting_scope_authorization';
  staleTask.productBootstrap.scopeSelections[0] = {
    id: 'current-scope-selection', projectId: currentProject.projectId,
    scopeFingerprint: currentProject.scopeFingerprint, goalVersionId, selectedAt: '2026-10-12T06:30:00.000Z',
  };
  staleTask.productBootstrap.currentScopeSelectionId = 'current-scope-selection';
  await fs.writeFile(taskFile, JSON.stringify(staleTask));
  nativeServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ source: 'native-authority', status: 'ready_to_export',
      task: { id: taskId, goalVersionId }, execution: { id: 'run-expired-current-scope' },
      productRegistry: { current: true }, artifact: { id: 'artifact-confirmed', version: 15, status: 'confirmed' },
      native: { bindingCurrent: true, actions: { canCancel: true, canRun: false, canPreview: true } } }));
  });
  await new Promise((resolve, reject) => nativeServer.once('error', reject).listen(nativePort, '127.0.0.1', resolve));
  const nativeState = await fetch(new URL('/api/product-state', base)).then((response) => response.json());
  assert.equal(nativeState.source, 'native-authority');
  assert.equal(nativeState.native.actions.canCancel, true);

  const expiredButCurrent = JSON.parse(await fs.readFile(taskFile, 'utf8'));
  const startedAt = new Date(Date.now() - 120_000).toISOString();
  expiredButCurrent.productBootstrap.status = 'ready_to_run';
  expiredButCurrent.productBootstrap.authorizedProject = {
    projectId: currentProject.projectId, scopeFingerprint: currentProject.scopeFingerprint,
    sourceSnapshotSha256: '1'.repeat(64), sourceHead: '2'.repeat(40), authorizedAt: startedAt,
  };
  expiredButCurrent.productBootstrap.registry = {
    status: 'runtime_starting', projectId: currentProject.projectId,
    scopeFingerprint: currentProject.scopeFingerprint, registrySha256: '4'.repeat(64), preparedAt: startedAt,
  };
  expiredButCurrent.projectWorkspace = {
    status: 'ready', scopeFingerprint: currentProject.scopeFingerprint, goalVersionId,
  };
  const projectWorkspace = await import(path.join(desktopRoot, 'app/project-workspace.mjs'));
  expiredButCurrent.projectWorkspace.taskInputBinding = projectWorkspace.projectTaskBinding(expiredButCurrent);
  expiredButCurrent.execution = {
    id: 'run-expired-current-scope', goalVersionId, phase: 'failed', stopReason: 'native_process_failed',
    startedAt, deadlineAt: startedAt, modelCalls: [],
  };
  await fs.writeFile(taskFile, JSON.stringify(expiredButCurrent));
  const trustedProjects = await createTrustedProductProjects({ file: catalogue });
  const bootstrap = await createProductBootstrapController({
    tasksRoot, irixiAppRoot: path.join(desktopRoot, 'app'),
    projectCatalog: trustedProjects.listPublic, projectAuthorization: trustedProjects.current,
  });
  const expiredSetup = await bootstrap.state(taskId);
  assert.equal(expiredSetup.blockedReason, 'explicit_new_run_required');
  assert.equal(expiredSetup.canRun, false);
  authorityProjection = { projection: {
    taskId, goalVersionId, current: true,
    execution: { id: expiredButCurrent.execution.id },
    productRegistry: { current: true, registrySha256: expiredButCurrent.productBootstrap.registry.registrySha256 },
    workspace: { current: true, scopeFingerprint: currentProject.scopeFingerprint },
    native: { bindingCurrent: true, registrySha256: expiredButCurrent.productBootstrap.registry.registrySha256,
      actions: { canRun: false, canPreview: true } },
    artifact: { id: 'artifact-confirmed', version: 15, status: 'confirmed', goalVersionId,
      candidateSha256: '5'.repeat(64), nativeCandidate: true },
  } };
  authorityProjectionMode = 'reject';
  const expiredFallback = await fetch(new URL('/api/product-state', base)).then((response) => response.json());
  assert.equal(expiredFallback.blockedReason, 'explicit_new_run_required');
  assert.equal(expiredFallback.source, undefined);
  authorityProjectionMode = 'accept';
  const expiredState = await fetch(new URL('/api/product-state', base)).then((response) => response.json());
  assert.equal(expiredState.source, 'native-authority');
  assert.equal(expiredState.artifact.status, 'confirmed');
  assert.equal(expiredState.native.bindingCurrent, true);
  assert.equal(expiredState.native.actions.canRun, false);
  assert.equal(expiredState.native.actions.canPreview, true);
});
