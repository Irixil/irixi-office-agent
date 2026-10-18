import assert from 'node:assert/strict';
import { spawn, spawnSync, execFile as execFileCallback } from 'node:child_process';
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
const canonicalJson = (value) => Array.isArray(value) ? `[${value.map(canonicalJson).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
    : JSON.stringify(value);

// Private installation/history replay is retained only in the development workspace.

// Private installation/history replay is retained only in the development workspace.

test('Desktop rejects an explicit privileged Authority port before starting services', () => {
  const result = spawnSync(process.execPath, [path.join(here, 'desktop-product-server.mjs')], {
    cwd: here,
    encoding: 'utf8',
    env: {
      ...process.env,
      IRIXI_DESKTOP_ROOT: desktopRoot,
      IRIXI_DESKTOP_PORT: '55423',
      IRIXI_PRODUCT_AUTHORITY_URL: 'http://127.0.0.1:80/',
      IRIXI_NATIVE_URL: 'http://127.0.0.1:22797/',
      IRIXI_AGENT_OFFICE_PORT: '31640',
      IRIXI_SCENE_PORT: '31641',
      IRIXI_AUTHORITY_TASKS_ROOT: os.tmpdir(),
      IRIXI_PRODUCT_ENABLE_AI: '0',
    },
    timeout: 5_000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /IRIXI_PRODUCT_AUTHORITY_URL must be a plain HTTP 127\.0\.0\.1 origin on a non-privileged port/);
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

test('blank tool projects are registered idempotently and a task only selects scope without authorizing or running', async (t) => {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-tool-project-')));
  const root = path.join(temporary, 'desktop-root');
  const projectsRoot = path.join(root, 'projects');
  const sourceRoot = path.join(temporary, 'source');
  const tasksRoot = path.join(temporary, 'tasks');
  await fs.mkdir(projectsRoot, { recursive: true });
  await fs.mkdir(sourceRoot);
  await fs.mkdir(tasksRoot);
  await fs.symlink(path.join(desktopRoot, 'app'), path.join(root, 'app'));
  await fs.symlink(path.join(desktopRoot, 'art'), path.join(root, 'art'));
  await fs.symlink(path.join(desktopRoot, 'node_modules'), path.join(root, 'node_modules'));
  await fs.writeFile(path.join(sourceRoot, 'main.js'), 'export const starter = true;\n');
  await execFile('git', ['init', '-q', sourceRoot]);
  await execFile('git', ['-C', sourceRoot, 'config', 'user.name', 'Irixi Test']);
  await execFile('git', ['-C', sourceRoot, 'config', 'user.email', 'irixi-test@example.invalid']);
  await execFile('git', ['-C', sourceRoot, 'add', 'main.js']);
  await execFile('git', ['-C', sourceRoot, 'commit', '-qm', 'fixture']);
  const catalogue = path.join(temporary, 'catalogue.json');
  await fs.writeFile(catalogue, JSON.stringify({ schemaVersion: 1, projects: [{
    projectId: 'existing-tool-fixture', label: 'Existing fixture', root: sourceRoot,
    baselinePaths: ['main.js'], allowedWritePaths: ['main.js'], checks: [{ id: 'typecheck' }],
    native: { backend: 'codex', model: 'gpt-6-luna', allowedRoles: ['Lead'], maxAgents: 1, maxModelCalls: 8, maxDurationMs: 1_200_000 },
  }] }));
  const desktopPort = await unusedPort();
  const authorityPort = await unusedPort();
  const nativePort = await unusedPort();
  const agentOfficePort = await unusedPort();
  const scenePort = await unusedPort();
  const bindingFile = path.join(here, 'runtime', `tool-project-binding-${process.pid}-${Date.now()}.json`);
  const child = spawn(process.execPath, [path.join(here, 'desktop-product-server.mjs')], {
    cwd: here, env: { ...process.env, IRIXI_DESKTOP_ROOT: root, IRIXI_DESKTOP_PORT: String(desktopPort),
      IRIXI_NATIVE_URL: `http://127.0.0.1:${nativePort}/`, IRIXI_PRODUCT_AUTHORITY_URL: `http://127.0.0.1:${authorityPort}/`,
      IRIXI_AGENT_OFFICE_PORT: String(agentOfficePort), IRIXI_SCENE_PORT: String(scenePort),
      IRIXI_AUTHORITY_TASKS_ROOT: tasksRoot, IRIXI_PRODUCT_PROJECT_CATALOG_FILE: catalogue,
      IRIXI_PRODUCT_BINDING_FILE: bindingFile, IRIXI_PRODUCT_ENABLE_AI: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await new Promise((resolve) => child.once('exit', resolve)); }
    await fs.rm(bindingFile, { force: true });
    await fs.rm(temporary, { recursive: true, force: true });
  });
  const { desktop } = await waitForDesktop(child);
  const request = { name: 'Blank utility fixture', requestId: 'request-tool-project-123456789' };
  const created = await jsonRequest(desktop, '/api/product/projects', request);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.project.location, `projects/${created.body.project.projectId}`);
  const retried = await jsonRequest(desktop, '/api/product/projects', request);
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  assert.equal(retried.body.created, false);
  assert.equal(retried.body.project.projectId, created.body.project.projectId);
  assert.equal((await fs.readdir(projectsRoot)).filter((name) => !name.startsWith('.')).length, 1);

  const taskRequest = {
    functionId: 'utility', title: 'A blank tool task', statement: 'Build the tool described in this task.',
    successCriteria: [], boundaries: [], projectId: created.body.project.projectId,
    projectScopeFingerprint: created.body.project.scopeFingerprint, taskCreationRequestId: 'task-request-1234567890',
  };
  await fs.mkdir(bindingFile);
  const interrupted = await jsonRequest(desktop, '/api/product/tasks', taskRequest);
  assert.equal(interrupted.status, 500);
  const savedTaskIds = (await fs.readdir(tasksRoot)).filter((name) => name.startsWith('task-'));
  assert.equal(savedTaskIds.length, 1, 'the request persisted exactly one task before the active binding failure');
  await fs.rmdir(bindingFile);
  const task = await jsonRequest(desktop, '/api/product/tasks', taskRequest);
  assert.equal(task.status, 200, JSON.stringify(task.body));
  assert.equal(task.body.reused, true);
  assert.equal(task.body.status, 'waiting_scope_authorization');
  assert.equal(task.body.task.id, savedTaskIds[0]);
  assert.equal(task.body.execution, null);
  assert.equal(task.body.registry, null);
  const persisted = JSON.parse(await fs.readFile(path.join(tasksRoot, task.body.task.id, 'task.json'), 'utf8'));
  assert.equal(persisted.status, 'waiting_scope_authorization');
  assert.equal(persisted.execution, null);
  assert.equal(persisted.productBootstrap.scopeSelections.length, 1);
  assert.equal(persisted.events.some((event) => event.type === 'integration.product_scope_selected'), true);
  assert.equal(persisted.events.some((event) => event.type.includes('authorized') || event.type.includes('run_reserved')), false);
  assert.deepEqual(JSON.parse(await fs.readFile(bindingFile, 'utf8')), { schemaVersion: 1, taskId: task.body.task.id });
  const retriedTask = await jsonRequest(desktop, '/api/product/tasks', taskRequest);
  assert.equal(retriedTask.status, 200, JSON.stringify(retriedTask.body));
  assert.equal(retriedTask.body.reused, true);
  assert.equal(retriedTask.body.task.id, task.body.task.id);
  const conflictingRetry = await jsonRequest(desktop, '/api/product/tasks', { ...taskRequest, statement: 'A different task.' });
  assert.equal(conflictingRetry.status, 400);
  assert.equal(conflictingRetry.body.reason.code, 'TASK_CREATION_REQUEST_CONFLICT');
  assert.deepEqual((await fs.readdir(tasksRoot)).filter((name) => !name.startsWith('.')), [task.body.task.id]);

  persisted.status = 'ready_to_export';
  persisted.execution = { id: 'run-old', phase: 'executing', modelCalls: [{ status: 'completed' }] };
  await fs.writeFile(path.join(tasksRoot, task.body.task.id, 'task.json'), JSON.stringify(persisted));
  const terminalProjection = await fetch(new URL('/api/product-state', desktop)).then((response) => response.json());
  assert.deepEqual(terminalProjection.taskLifecycle, { status: 'ready_to_export', inFlight: false });
  assert.equal(terminalProjection.execution.phase, 'executing');
  const secondRequest = { ...taskRequest, title: 'Second task', statement: 'Create after a terminal task.', taskCreationRequestId: 'task-request-second-123456' };
  const secondTask = await jsonRequest(desktop, '/api/product/tasks', secondRequest);
  assert.equal(secondTask.status, 201, JSON.stringify(secondTask.body));
  assert.equal(secondTask.body.task.id === task.body.task.id, false);

  const secondFile = path.join(tasksRoot, secondTask.body.task.id, 'task.json');
  const secondSaved = JSON.parse(await fs.readFile(secondFile, 'utf8'));
  secondSaved.status = 'ready_to_export';
  secondSaved.execution = { id: 'run-active', phase: 'executing', modelCalls: [{ status: 'reserved' }] };
  await fs.writeFile(secondFile, JSON.stringify(secondSaved));
  const blockedRequest = { ...taskRequest, title: 'Third task', statement: 'Do not switch during a reserved call.', taskCreationRequestId: 'task-request-third-123456' };
  const blocked = await jsonRequest(desktop, '/api/product/tasks', blockedRequest);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.reason.code, 'TASK_SWITCH_BUSY');
  assert.equal((await fs.readdir(tasksRoot)).filter((name) => name.startsWith('task-')).length, 2);
});

test('a new task can save and correct global memory before scope preparation through one Authority writer', async (t) => {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-memory-writer-')));
  const tasksRoot = path.join(temporary, 'tasks');
  const projectRoot = path.join(temporary, 'registered-project');
  await fs.mkdir(tasksRoot, { recursive: true });
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.writeFile(path.join(projectRoot, 'main.js'), 'export const value = true;\n');
  await execFile('git', ['init', '-q', projectRoot]);
  await execFile('git', ['-C', projectRoot, 'config', 'user.name', 'Irixi Test']);
  await execFile('git', ['-C', projectRoot, 'config', 'user.email', 'irixi-test@example.invalid']);
  await execFile('git', ['-C', projectRoot, 'add', 'main.js']);
  await execFile('git', ['-C', projectRoot, 'commit', '-qm', 'fixture']);
  const desktopPort = await unusedPort();
  const authorityPort = await unusedPort();
  const nativePort = await unusedPort();
  const agentOfficePort = await unusedPort();
  const scenePort = await unusedPort();
  assert.equal(new Set([desktopPort, authorityPort, nativePort, agentOfficePort, scenePort]).size, 5);
  const xerjPort = await unusedPort();
  const catalogue = path.join(temporary, 'catalogue.json');
  const bindingFile = path.join(here, 'runtime', `memory-writer-${process.pid}-${Date.now()}.json`);
  await fs.writeFile(catalogue, JSON.stringify({ schemaVersion: 1, projects: [{
    projectId: 'memory-writer-fixture', label: 'Memory writer fixture', root: projectRoot,
    baselinePaths: ['main.js'], allowedWritePaths: ['main.js'], checks: [{ id: 'typecheck' }],
    native: { backend: 'codex', model: 'gpt-6-luna', allowedRoles: ['Lead'], maxAgents: 1, maxModelCalls: 1, maxDurationMs: 300_000 },
  }] }));
  const child = spawn(process.execPath, [path.join(here, 'desktop-product-server.mjs')], {
    cwd: here,
    env: { ...process.env, IRIXI_DESKTOP_ROOT: desktopRoot, IRIXI_DESKTOP_PORT: String(desktopPort),
      IRIXI_NATIVE_URL: `http://127.0.0.1:${nativePort}/`, IRIXI_PRODUCT_AUTHORITY_URL: `http://127.0.0.1:${authorityPort}/`,
      IRIXI_AUTHORITY_TASKS_ROOT: tasksRoot, IRIXI_PRODUCT_PROJECT_CATALOG_FILE: catalogue,
      IRIXI_PRODUCT_BINDING_FILE: bindingFile, IRIXI_PRODUCT_ENABLE_AI: '0', IRIXI_XERJ_URL: `http://127.0.0.1:${xerjPort}/` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
    await fs.rm(bindingFile, { force: true });
    await fs.rm(path.join(here, 'runtime', 'memory-authority', crypto.createHash('sha256').update(await fs.realpath(tasksRoot)).digest('hex').slice(0, 16)), { recursive: true, force: true });
    await fs.rm(temporary, { recursive: true, force: true });
  });
  const { desktop } = await waitForDesktop(child);
  const created = await jsonRequest(desktop, '/api/product/tasks', {
    title: 'Memory setup', statement: 'Save a preference before choosing a project.',
    successCriteria: ['The preference remains available.'], boundaries: ['Do not start execution.'],
  });
  assert.equal(created.status, 201);
  const taskId = created.body.task.id;
  const goalVersionId = created.body.task.goalVersionId;
  const saved = await jsonRequest(desktop, `/api/product/tasks/${taskId}/actions`, {
    action: 'memory_save', expectedGoalVersionId: goalVersionId, scopeType: 'global', kind: 'preference',
    title: '回答风格', text: '回答先给结论，用简短中文。',
  });
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assert.equal(saved.body.memory.ownerTaskId, taskId);
  assert.equal(saved.body.memory.source.type, 'explicit_user_action');
  const corrected = await jsonRequest(desktop, `/api/product/tasks/${taskId}/actions`, {
    action: 'memory_change', expectedGoalVersionId: goalVersionId, memoryId: saved.body.memory.id,
    expectedRevision: 1, operation: 'correct', kind: 'preference', title: '回答风格', text: '回答先给结论，用更简短的中文。',
  });
  assert.equal(corrected.status, 200, JSON.stringify(corrected.body));
  assert.equal(corrected.body.memory.revision, 2);
  assert.equal(corrected.body.memory.history.length, 1);
  assert.equal(corrected.body.memory.text, '回答先给结论，用更简短的中文。');
  const persisted = JSON.parse(await fs.readFile(path.join(tasksRoot, taskId, 'task.json'), 'utf8'));
  assert.equal(persisted.memoryEntries[0].revision, 2);
  assert.equal(persisted.memoryEntries[0].source.taskId, taskId);
  assert.equal(persisted.events.filter((event) => event.type.startsWith('memory.')).length, 2);
  assert.equal(persisted.execution, null);
  const projects = await fetch(new URL('/api/product/projects', desktop)).then((response) => response.json());
  const selected = await jsonRequest(desktop, `/api/product/tasks/${taskId}/actions`, {
    action: 'select_scope', expectedGoalVersionId: goalVersionId,
    projectId: projects.projects[0].projectId, expectedScopeFingerprint: projects.projects[0].scopeFingerprint,
  });
  assert.equal(selected.status, 200, JSON.stringify(selected.body));
  assert.equal(selected.body.status, 'waiting_scope_authorization');
  await assert.rejects(fetch(new URL('/health', `http://127.0.0.1:${authorityPort}/`)), /fetch failed|ECONNREFUSED/);
});

test('product input HTTP contract reads once, prefers matching authority, and falls back only on explicit local absence', async (t) => {
  await fs.access(path.join(desktopRoot, 'app', 'core.mjs'));
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-product-http-')));
  const tasksRoot = path.join(temporary, 'tasks');
  const projectRoot = path.join(temporary, 'registered-project');
  const toolProjectRoot = path.join(temporary, 'tool-route-project');
  await fs.mkdir(tasksRoot, { recursive: true });
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.mkdir(toolProjectRoot, { recursive: true });
  await fs.writeFile(path.join(projectRoot, 'main.js'), 'export const current = true;\n');
  await execFile('git', ['init', '-q', projectRoot]);
  await execFile('git', ['-C', projectRoot, 'config', 'user.name', 'Irixi Test']);
  await execFile('git', ['-C', projectRoot, 'config', 'user.email', 'irixi-test@example.invalid']);
  await execFile('git', ['-C', projectRoot, 'add', 'main.js']);
  await execFile('git', ['-C', projectRoot, 'commit', '-qm', 'fixture']);
  const toolSourceFiles = {
    'IRIXI_PROJECT.json': '{"schemaVersion":1,"projectId":"tool-zip-route","creationKey":"zip-route-test-key-1234","projectKind":"utility","templateId":"tool-starter-v1"}\n',
    'README.md': '# Tool route fixture\n', 'PRODUCT.md': '# Goal\n',
    'package.json': '{"name":"tool-zip-route","private":true}\n',
    'index.html': '<main>baseline</main>\n', 'styles.css': 'body { color: black; }\n',
    'app.js': 'document.body.dataset.version = "baseline";\n', 'core.js': 'export const version = "baseline";\n',
  };
  for (const [relative, contents] of Object.entries(toolSourceFiles)) await fs.writeFile(path.join(toolProjectRoot, relative), contents);
  await execFile('git', ['init', '-q', toolProjectRoot]);
  await execFile('git', ['-C', toolProjectRoot, 'config', 'user.name', 'Irixi Test']);
  await execFile('git', ['-C', toolProjectRoot, 'config', 'user.email', 'irixi-test@example.invalid']);
  await execFile('git', ['-C', toolProjectRoot, 'add', '--all']);
  await execFile('git', ['-C', toolProjectRoot, 'commit', '-qm', 'tool route fixture']);
  const catalogue = path.join(temporary, 'catalogue.json');
  await fs.writeFile(catalogue, JSON.stringify({ schemaVersion: 1, projects: [{
    projectId: 'article-learning-12', label: 'HTTP contract fixture', root: projectRoot,
    baselinePaths: ['main.js'], allowedWritePaths: ['main.js'], checks: [{ id: 'node-syntax-v1' }],
    native: { backend: 'codex', model: 'gpt-5.6-sol', allowedRoles: ['Lead'], maxAgents: 1, maxModelCalls: 1, maxDurationMs: 300_000 },
  }, {
    projectId: 'tool-zip-route', label: 'ZIP route fixture', root: toolProjectRoot,
    projectKind: 'utility', templateId: 'tool-starter-v1', creationKey: 'zip-route-test-key-1234', location: 'projects/tool-zip-route',
    baselinePaths: Object.keys(toolSourceFiles),
    allowedWritePaths: ['README.md', 'PRODUCT.md', 'package.json', 'index.html', 'styles.css', 'app.js', 'core.js'],
    checks: [{ id: 'node-syntax-v1' }], staticPreviewEntries: ['index.html'],
    staticPreviewFiles: ['index.html', 'styles.css', 'app.js', 'core.js'],
    native: { backend: 'codex', model: 'gpt-6-luna', allowedRoles: ['Lead'], maxAgents: 1, maxModelCalls: 1, maxDurationMs: 300_000 },
  }] }));

  const desktopPort = await unusedPort();
  const authorityPort = await unusedPort();
  const nativePort = await unusedPort();
  const agentOfficePort = await unusedPort();
  const scenePort = await unusedPort();
  const bindingFile = path.join(here, 'runtime', `http-contract-${process.pid}-${Date.now()}.json`);
  const runtimeShimFile = path.join(temporary, 'runtime-launch-shim.mjs');
  const runtimeSpawnMarkerFile = path.join(temporary, 'runtime-spawned');
  await fs.writeFile(runtimeShimFile, `
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import childProcess from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const originalSpawn = childProcess.spawn.bind(childProcess);
childProcess.spawn = (command, args = [], options) => {
  if (typeof args[0] === 'string' && args[0].endsWith('/product/start-product.mjs')) {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = (signal = 'SIGTERM') => {
      if (child.exitCode !== null || child.signalCode !== null) return false;
      child.signalCode = signal;
      setImmediate(() => child.emit('exit', null, signal));
      return true;
    };
    const taskIndex = args.indexOf('--task');
    const taskId = taskIndex >= 0 ? args[taskIndex + 1] : null;
    writeFileSync(process.env.IRIXI_TEST_RUNTIME_SPAWN_MARKER, JSON.stringify({ taskId, args }));
    setTimeout(() => child.stdout.write(JSON.stringify({
      ok: true, mode: 'development_zero_model', taskId, nativeOnly: true,
      readyServiceCount: 4, expectedReadyServiceCount: 4, allStartedServicesReady: true,
      services: { authority: { ready: true }, openoffice: { ready: true }, agentOffice: { ready: true }, scene: { ready: true } },
      modelCalls: 0,
    }) + '\\n'), 50);
    return child;
  }
  return originalSpawn(command, args, options);
};
syncBuiltinESMExports();
`);
  let taskIdForRuntime = null;
  const child = spawn(process.execPath, [path.join(here, 'desktop-product-server.mjs')], {
    cwd: here,
    env: {
      ...process.env,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${runtimeShimFile}`].filter(Boolean).join(' '),
      IRIXI_TEST_RUNTIME_SPAWN_MARKER: runtimeSpawnMarkerFile,
      IRIXI_DESKTOP_ROOT: desktopRoot,
      IRIXI_DESKTOP_PORT: String(desktopPort),
      IRIXI_NATIVE_URL: `http://127.0.0.1:${nativePort}/`,
      IRIXI_PRODUCT_AUTHORITY_URL: `http://127.0.0.1:${authorityPort}/`,
      IRIXI_AGENT_OFFICE_PORT: String(agentOfficePort),
      IRIXI_SCENE_PORT: String(scenePort),
      IRIXI_AUTHORITY_TASKS_ROOT: tasksRoot,
      IRIXI_PRODUCT_PROJECT_CATALOG_FILE: catalogue,
      IRIXI_PRODUCT_BINDING_FILE: bindingFile,
      IRIXI_PRODUCT_ENABLE_AI: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverStderr = '';
  child.stderr.on('data', (chunk) => { serverStderr += chunk; });
  let authorityServer = null;
  let nativeServer = null;
  let zipGatewayProjection = null;
  let zipGatewayCandidate = null;
  let zipGatewayPatch = null;
  const nativeProductActions = [];
  t.after(async () => {
    if (nativeServer) await new Promise((resolve) => nativeServer.close(resolve));
    if (authorityServer) await new Promise((resolve) => authorityServer.close(resolve));
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
    if (taskIdForRuntime) await fs.rm(path.join(here, 'runtime', taskIdForRuntime), { recursive: true, force: true });
    await fs.rm(bindingFile, { force: true });
    await fs.rm(temporary, { recursive: true, force: true });
  });
  const ready = await waitForDesktop(child);
  const base = ready.desktop;

  const unavailableResponse = await fetch(new URL('/api/product/learning-entry', base));
  const unavailableLearningEntry = await unavailableResponse.json();
  assert.equal(unavailableResponse.status, 200, `${JSON.stringify(unavailableLearningEntry)} ${serverStderr}`);
  assert.equal(unavailableLearningEntry.available, false);
  assert.equal(await fs.stat(runtimeSpawnMarkerFile).then(() => true, () => false), false,
    'checking the learning entry does not start a runtime');

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
  taskIdForRuntime = taskId;
  const goalVersionId = created.body.task.goalVersionId;

  const fallback = await jsonRequest(base, `/api/product/tasks/${taskId}/actions`, {
    action: 'support', expectedGoalVersionId: goalVersionId, text: 'Saved only after both fixed authority probes were explicitly refused.',
  });
  assert.equal(fallback.status, 201);
  assert.equal(fallback.body.accepted, true);
  assert.equal(typeof fallback.body.suggestionId, 'string');

  const authorityRequests = [];
  const authorityProjectionReads = [];
  const authorityProjectionRequests = [];
  const zipGatewayRequests = [];
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
      authorityProjectionReads.push(authorityProjectionMode);
      authorityProjectionRequests.push(req.url);
      const runtimeNotStarted = authorityProjectionMode === 'missing-until-runtime'
        && await fs.access(runtimeSpawnMarkerFile).then(() => false, () => true);
      if (authorityProjectionMode === 'missing' || authorityProjectionMode === 'unrelated-404' || runtimeNotStarted) {
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
  const currentProject = currentProjects.projects.find((entry) => entry.projectId === 'article-learning-12');
  assert.equal(currentProject.current, true);
  const staleScope = '0'.repeat(64);
  const staleTask = JSON.parse(await fs.readFile(taskFile, 'utf8'));
  staleTask.functionId = 'game';
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

  authorityProjectionMode = 'missing';
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
  const previewWithoutRuntime = await jsonRequest(base, `/api/product/tasks/${taskId}/actions`, {
    action: 'preview', expectedGoalVersionId: goalVersionId,
  });
  assert.equal(previewWithoutRuntime.status, 503);
  assert.equal(previewWithoutRuntime.body.reason.code, 'NATIVE_GATEWAY_UNAVAILABLE');

  staleTask.execution = null;
  staleTask.integrationExecutionRequest = null;
  await fs.writeFile(taskFile, JSON.stringify(staleTask));
  const currentScopeSelection = await jsonRequest(base, `/api/product/tasks/${taskId}/actions`, {
    action: 'select_scope', expectedGoalVersionId: goalVersionId,
    projectId: currentProject.projectId, expectedScopeFingerprint: currentProject.scopeFingerprint,
  });
  assert.equal(currentScopeSelection.status, 200, JSON.stringify(currentScopeSelection.body));
  nativeServer = http.createServer((req, res) => {
    zipGatewayRequests.push(req.url);
    if (req.method === 'GET' && req.url?.startsWith('/api/product-state?')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Gateway state route does not accept a task query.' })); return;
    }
    if (req.method === 'POST' && /^\/api\/product\/tasks\/[^/]+\/actions$/.test(req.url || '')) {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        nativeProductActions.push({ url: req.url, ...body });
        const status = body.action === 'preview' ? 200 : body.action === 'run' ? 202 : 422;
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ source: 'native-gateway', action: body.action, accepted: status < 400 }));
      });
      return;
    }
    if (req.method === 'GET' && req.url === '/api/irixi-authority' && zipGatewayProjection) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(zipGatewayProjection)); return;
    }
    if (req.method === 'GET' && req.url === '/api/product/candidate' && zipGatewayCandidate) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(zipGatewayCandidate)); return;
    }
    if (req.method === 'GET' && req.url?.startsWith('/api/irixi-authority/patch?') && zipGatewayPatch) {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'x-content-sha256': zipGatewayCandidate.patchSha256 });
      res.end(zipGatewayPatch); return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ source: 'native-authority', taskId, title: '原生任务', goalVersionId,
      status: 'ready_to_export', execution: { id: 'run-expired-current-scope' },
      productRegistry: { current: true }, artifact: { id: 'artifact-confirmed', version: 15, status: 'confirmed' },
      native: { bindingCurrent: true, actions: { canCancel: true, canRun: false, canPreview: true } } }));
  });
  await new Promise((resolve, reject) => nativeServer.once('error', reject).listen(nativePort, '127.0.0.1', resolve));
  authorityProjectionMode = 'accept';
  const authorizedForRuntime = await jsonRequest(base, `/api/product/tasks/${taskId}/actions`, {
    action: 'authorize_scope', expectedGoalVersionId: goalVersionId,
    projectId: currentProject.projectId, expectedScopeFingerprint: currentProject.scopeFingerprint,
  });
  assert.equal(authorizedForRuntime.status, 200, JSON.stringify(authorizedForRuntime.body));
  const reviewTrustedProjects = await createTrustedProductProjects({ file: catalogue });
  const reviewProject = await reviewTrustedProjects.current(currentProject.projectId);
  const reviewTask = JSON.parse(await fs.readFile(taskFile, 'utf8'));
  const reviewStartedAt = '2026-10-12T06:30:00.000Z';
  const reviewRunId = 'run-cold-review-reconnect';
  const reviewArtifactId = 'artifact-cold-review-reconnect';
  const reviewId = 'review-cold-review-reconnect';
  const reviewCandidateSha256 = 'a'.repeat(64);
  const reviewPrompt = 'Original expired execution prompt remains unchanged.';
  const reviewRoundId = 'review-round-cold-reconnect';
  const reviewRoundDeadlineAt = new Date(Date.now() + 60_000).toISOString();
  const reviewLimits = {
    maxRoles: Math.min(8, reviewProject.native.maxAgents), maxConcurrentModelCalls: 2,
    maxModelCalls: reviewProject.native.maxModelCalls, maxDurationMs: reviewProject.native.maxDurationMs,
    maxAttemptsPerStep: 2, maxPlanRevisions: 2, maxToolRoundsPerStep: 3,
  };
  const reviewRegistry = {
    taskId, goalVersionId, projectId: currentProject.projectId,
    workspace: { scopeFingerprint: currentProject.scopeFingerprint,
      sourceSnapshotSha256: reviewProject.sourceSnapshotSha256, sourceHead: reviewProject.sourceHead },
    native: { maxModelCalls: reviewLimits.maxModelCalls, maxDurationMs: reviewLimits.maxDurationMs },
  };
  const reviewRegistrySha256 = crypto.createHash('sha256').update(canonicalJson(reviewRegistry)).digest('hex');
  reviewTask.productBootstrap.registry = { status: 'registered', projectId: currentProject.projectId,
    scopeFingerprint: currentProject.scopeFingerprint, registrySha256: reviewRegistrySha256, preparedAt: reviewStartedAt };
  reviewTask.execution = { id: reviewRunId, goalVersionId, workspaceScopeFingerprint: currentProject.scopeFingerprint,
    sourceSnapshotSha256: reviewProject.sourceSnapshotSha256, phase: 'partial', stopReason: 'execution_deadline_elapsed',
    startedAt: reviewStartedAt, deadlineAt: reviewStartedAt, updatedAt: reviewStartedAt, limits: reviewLimits,
    modelCalls: [{ id: 'call-review-terminal', status: 'completed', startedAt: reviewStartedAt, finishedAt: reviewStartedAt }] };
  reviewTask.integrationExecutionRequest = { goalVersionId, prompt: reviewPrompt,
    promptSha256: crypto.createHash('sha256').update(reviewPrompt).digest('hex') };
  reviewTask.events.push({ id: 'review-runtime-registry', at: reviewStartedAt,
    type: 'integration.product_registry_registered', detail: { registry: reviewRegistry, registrySha256: reviewRegistrySha256 } });
  reviewTask.artifacts = [{ id: reviewArtifactId, version: 39, status: 'candidate', reviewStatus: 'failed', goalVersionId,
    nativeProjectCandidate: { version: 1, kind: 'native_worktree_candidate_v1', candidateSha256: reviewCandidateSha256,
      taskInputBinding: reviewTask.projectWorkspace.taskInputBinding, workspaceScopeFingerprint: currentProject.scopeFingerprint,
      sourceSnapshotSha256: reviewProject.sourceSnapshotSha256, registrySha256: reviewRegistrySha256 } }];
  reviewTask.reviews = [{ id: reviewId, artifactId: reviewArtifactId, passed: false, goalVersionId,
    candidateSha256: reviewCandidateSha256, registrySha256: reviewRegistrySha256 }];
  reviewTask.events.push({ id: reviewRoundId, at: reviewStartedAt,
    type: 'integration.product_native_review_round_opened', detail: {
      goalVersionId, executionId: reviewRunId, registrySha256: reviewRegistrySha256,
      artifactId: reviewArtifactId, artifactVersion: 39, candidateSha256: reviewCandidateSha256,
      expectedReviewId: reviewId, maxModelCalls: 1, openedAt: reviewStartedAt, deadlineAt: reviewRoundDeadlineAt,
    } });
  await fs.writeFile(taskFile, JSON.stringify(reviewTask));
  authorityProjection = { projection: {
    taskId, goalVersionId, current: true, execution: { id: reviewRunId },
    productRegistry: { current: true, registrySha256: reviewRegistrySha256 },
    workspace: { current: true, scopeFingerprint: currentProject.scopeFingerprint },
    native: { bindingCurrent: true, registrySha256: reviewRegistrySha256,
      reviewRound: { id: reviewRoundId, status: 'open', goalVersionId, executionId: reviewRunId,
        registrySha256: reviewRegistrySha256, artifactId: reviewArtifactId, artifactVersion: 39,
        candidateSha256: reviewCandidateSha256, expectedReviewId: reviewId,
        maxModelCalls: 1, modelCalls: 0, remainingCalls: 1, deadlineAt: reviewRoundDeadlineAt },
      actions: { canRun: false, canReview: true, canOpenReviewRound: false } },
    artifact: { id: reviewArtifactId, version: 39, status: 'candidate', goalVersionId,
      candidateSha256: reviewCandidateSha256, nativeCandidate: true,
      review: { id: reviewId, passed: false, candidateSha256: reviewCandidateSha256,
        goalVersionId, registrySha256: reviewRegistrySha256 } },
  } };
  authorityProjectionMode = 'accept';
  const authorityProjectedReviewState = await fetch(new URL('/api/product-state', base)).then((response) => response.json());
  assert.equal(authorityProjectedReviewState.native.actions.canReconnectReview, true);
  assert.equal(authorityProjectedReviewState.product.registrySha256, reviewRegistrySha256);
  assert.equal(authorityProjectedReviewState.product.workspaceScopeFingerprint, currentProject.scopeFingerprint);
  assert.equal(authorityProjectedReviewState.product.bindingCurrent, true);
  assert.equal(authorityProjectedReviewState.links.actions, `/api/product/tasks/${encodeURIComponent(taskId)}/actions`);
  assert.equal(authorityProjectedReviewState.links.candidate, '/api/product/candidate');
  authorityProjectionMode = 'missing-until-runtime';
  const beforeReviewReconnect = await fs.readFile(taskFile, 'utf8');
  const expiredReviewRoundTask = JSON.parse(beforeReviewReconnect);
  expiredReviewRoundTask.events.findLast((entry) => entry.id === reviewRoundId).detail.deadlineAt = reviewStartedAt;
  await fs.writeFile(taskFile, JSON.stringify(expiredReviewRoundTask));
  const expiredReviewRoundState = await fetch(new URL('/api/product-state', base)).then((response) => response.json());
  assert.equal(expiredReviewRoundState.native.actions.canReconnectReview, true,
    'the failed candidate runtime can reconnect without reviving its expired review round');
  assert.equal(expiredReviewRoundState.native.reviewRound, null,
    'the detached projection never reports an expired round as open');
  await fs.writeFile(taskFile, beforeReviewReconnect);
  const detachedReviewState = await fetch(new URL('/api/product-state', base)).then((response) => response.json());
  assert.equal(detachedReviewState.native.actions.canReconnectReview, true);
  assert.equal(detachedReviewState.native.actions.canOpenReviewRound, false);
  assert.equal(detachedReviewState.artifact.id, reviewArtifactId);
  assert.equal(detachedReviewState.runtimeUnavailable, true);
  assert.equal(detachedReviewState.product.registrySha256, reviewRegistrySha256);
  assert.equal(detachedReviewState.product.workspaceScopeFingerprint, currentProject.scopeFingerprint);
  assert.equal(detachedReviewState.product.bindingCurrent, true);
  assert.equal(detachedReviewState.links.actions, `/api/product/tasks/${encodeURIComponent(taskId)}/actions`);
  const reviewReconnectInput = {
    action: 'reconnect_review_runtime', expectedGoalVersionId: goalVersionId,
    expectedScopeFingerprint: currentProject.scopeFingerprint, expectedExecutionId: reviewRunId,
    expectedRegistrySha256: reviewRegistrySha256, expectedArtifactId: reviewArtifactId,
    expectedArtifactVersion: 39, expectedCandidateSha256: reviewCandidateSha256, expectedReviewId: reviewId,
  };
  await fs.rm(runtimeSpawnMarkerFile, { force: true });
  const staleReviewReconnect = await jsonRequest(base, `/api/product/tasks/${taskId}/actions`, {
    ...reviewReconnectInput, expectedCandidateSha256: 'b'.repeat(64),
  });
  assert.equal(staleReviewReconnect.status, 409);
  assert.equal(staleReviewReconnect.body.reason.code, 'REVIEW_RUNTIME_RECONNECT_STALE');
  assert.equal(await fs.stat(runtimeSpawnMarkerFile).then(() => true, () => false), false);
  assert.equal(await fs.readFile(taskFile, 'utf8'), beforeReviewReconnect);
  const reviewReconnect = await jsonRequest(base, `/api/product/tasks/${taskId}/actions`, reviewReconnectInput);
  assert.equal(reviewReconnect.status, 200, JSON.stringify(reviewReconnect.body));
  assert.equal(reviewReconnect.body.reconnected, true);
  assert.equal(reviewReconnect.body.executionId, reviewRunId);
  assert.equal(reviewReconnect.body.registrySha256, reviewRegistrySha256);
  assert.equal(reviewReconnect.body.artifactId, reviewArtifactId);
  assert.equal(reviewReconnect.body.artifactVersion, 39);
  assert.equal(reviewReconnect.body.candidateSha256, reviewCandidateSha256);
  assert.equal(reviewReconnect.body.reviewId, reviewId);
  assert.deepEqual(reviewReconnect.body.reviewRound, { id: reviewRoundId, deadlineAt: reviewRoundDeadlineAt });
  assert.equal(reviewReconnect.body.runtime.modelCalls, 0);
  assert.equal(await fs.readFile(taskFile, 'utf8'), beforeReviewReconnect,
    'review runtime reconnect preserves the original execution, deadline, calls, status, candidate, and review');

  const noReviewTask = JSON.parse(beforeReviewReconnect);
  noReviewTask.reviews = [];
  noReviewTask.events = noReviewTask.events.filter((entry) => entry.id !== reviewRoundId);
  const beforeNoReviewReconnect = JSON.stringify(noReviewTask);
  await fs.writeFile(taskFile, beforeNoReviewReconnect);
  authorityProjection = { projection: {
    taskId, goalVersionId, current: true, execution: { id: reviewRunId },
    productRegistry: { current: true, registrySha256: reviewRegistrySha256 },
    workspace: { current: true, scopeFingerprint: currentProject.scopeFingerprint },
    native: { bindingCurrent: true, registrySha256: reviewRegistrySha256, reviewRound: null,
      actions: { canRun: false, canReview: false, canOpenReviewRound: true } },
    artifact: { id: reviewArtifactId, version: 39, status: 'candidate', goalVersionId,
      candidateSha256: reviewCandidateSha256, nativeCandidate: true, review: null },
  } };
  const noReviewProjects = await createTrustedProductProjects({ file: catalogue });
  const noReviewBootstrap = await createProductBootstrapController({ tasksRoot, irixiAppRoot: path.join(desktopRoot, 'app'),
    projectCatalog: noReviewProjects.listPublic, projectAuthorization: noReviewProjects.current });
  const noReviewRecovery = await noReviewBootstrap.findCurrentFailedReviewCandidate(taskId);
  assert.ok(noReviewRecovery, JSON.stringify({ stopReason: noReviewTask.execution.stopReason, status: noReviewTask.status,
    recovery: noReviewRecovery, scope: noReviewTask.productBootstrap?.authorizedProject }));
  assert.deepEqual({ expectedGoalVersionId: noReviewRecovery.goalVersionId,
    expectedScopeFingerprint: noReviewRecovery.scopeFingerprint, expectedExecutionId: noReviewRecovery.executionId,
    expectedRegistrySha256: noReviewRecovery.registrySha256, expectedArtifactId: noReviewRecovery.artifact.id,
    expectedArtifactVersion: noReviewRecovery.artifact.version, expectedCandidateSha256: noReviewRecovery.artifact.candidateSha256,
    expectedReviewId: noReviewRecovery.artifact.review?.id || null }, {
    expectedGoalVersionId: reviewReconnectInput.expectedGoalVersionId,
    expectedScopeFingerprint: reviewReconnectInput.expectedScopeFingerprint,
    expectedExecutionId: reviewReconnectInput.expectedExecutionId,
    expectedRegistrySha256: reviewReconnectInput.expectedRegistrySha256,
    expectedArtifactId: reviewReconnectInput.expectedArtifactId,
    expectedArtifactVersion: reviewReconnectInput.expectedArtifactVersion,
    expectedCandidateSha256: reviewReconnectInput.expectedCandidateSha256, expectedReviewId: null,
  });
  const noReviewReconnect = await jsonRequest(base, `/api/product/tasks/${taskId}/actions`, {
    ...reviewReconnectInput, expectedReviewId: null,
  });
  assert.equal(noReviewReconnect.status, 200, JSON.stringify(noReviewReconnect.body));
  assert.equal(noReviewReconnect.body.reviewId, null);
  assert.equal(noReviewReconnect.body.runtime.modelCalls, 0);
  assert.equal(await fs.readFile(taskFile, 'utf8'), beforeNoReviewReconnect,
    'no-review reconnect preserves the candidate and does not create a review or model call');
  authorityProjectionMode = 'accept';
  const preparedForRuntime = await jsonRequest(base, `/api/product/tasks/${taskId}/actions`, {
    action: 'prepare_run', expectedGoalVersionId: goalVersionId,
    expectedScopeFingerprint: currentProject.scopeFingerprint,
  });
  assert.equal(preparedForRuntime.status, 202, JSON.stringify(preparedForRuntime.body));
  await fs.rm(runtimeSpawnMarkerFile, { force: true });
  const nativeState = await fetch(new URL('/api/product-state', base)).then((response) => response.json());
  assert.equal(nativeState.source, 'native-authority');
  assert.equal(nativeState.native.actions.canCancel, true);
  assert.equal(nativeState.functionId, 'game');
  const taskScopedNativeStateResponse = await fetch(new URL(`/api/product-state?taskId=${encodeURIComponent(taskId)}`, base));
  assert.equal(taskScopedNativeStateResponse.status, 200);
  assert.equal((await taskScopedNativeStateResponse.json()).taskId, taskId);
  assert.equal(zipGatewayRequests.at(-1), '/api/product-state', 'Desktop validates task identity, then normalizes the Gateway URL');
  const gatewayRequestsBeforeMismatchedState = zipGatewayRequests.length;
  const mismatchedNativeStateResponse = await fetch(new URL(`/api/product-state?taskId=${encodeURIComponent(`${taskId}-other`)}`, base));
  assert.equal(mismatchedNativeStateResponse.status, 409);
  assert.equal(zipGatewayRequests.length, gatewayRequestsBeforeMismatchedState, 'a mismatched task never reaches the Gateway');

  const trustedProjects = await createTrustedProductProjects({ file: catalogue });
  const currentDescriptor = await trustedProjects.current(currentProject.projectId);
  const expiredButCurrent = JSON.parse(await fs.readFile(taskFile, 'utf8'));
  const startedAt = new Date(Date.now() - 120_000).toISOString();
  expiredButCurrent.productBootstrap.status = 'ready_to_run';
  expiredButCurrent.productBootstrap.authorizedProject = {
    projectId: currentProject.projectId, scopeFingerprint: currentProject.scopeFingerprint,
    sourceSnapshotSha256: currentDescriptor.sourceSnapshotSha256, sourceHead: currentDescriptor.sourceHead, authorizedAt: startedAt,
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
  const beforeRejectedReuse = await fs.readFile(taskFile, 'utf8');
  const rejectedReuse = await jsonRequest(base, `/api/product/tasks/${taskId}/actions`, {
    action: 'prepare_run', mode: 'reuse_current_result', expectedGoalVersionId: goalVersionId,
    expectedScopeFingerprint: currentProject.scopeFingerprint, expectedExecutionId: expiredButCurrent.execution.id,
    expectedRegistrySha256: '4'.repeat(64), expectedArtifactId: 'artifact-confirmed',
    expectedArtifactVersion: 15, expectedCandidateSha256: '5'.repeat(64),
  });
  assert.equal(rejectedReuse.status, 409);
  assert.equal(rejectedReuse.body.reason.code, 'RUN_REUSE_BINDING_STALE');
  assert.match(rejectedReuse.body.reason.message, /expired execution or confirmed result no longer matches its current registered binding/i);
  assert.equal(await fs.readFile(taskFile, 'utf8'), beforeRejectedReuse);
  const afterRejectedReuse = JSON.parse(await fs.readFile(taskFile, 'utf8'));
  assert.equal(afterRejectedReuse.execution.id, expiredButCurrent.execution.id);
  assert.equal(afterRejectedReuse.executionHistory?.length || 0, expiredButCurrent.executionHistory?.length || 0);

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

  const recoveryTask = JSON.parse(await fs.readFile(taskFile, 'utf8'));
  const recoveryStartedAt = new Date(Date.now() - 400_000).toISOString();
  const recoveryPrompt = 'The saved R44 prompt remains unchanged.';
  const recoveryLimits = {
    maxRoles: Math.min(8, currentDescriptor.native.maxAgents), maxConcurrentModelCalls: 2,
    maxModelCalls: currentDescriptor.native.maxModelCalls, maxDurationMs: currentDescriptor.native.maxDurationMs,
    maxAttemptsPerStep: 2, maxPlanRevisions: 2, maxToolRoundsPerStep: 3,
  };
  recoveryTask.productBootstrap.registry = {
    status: 'registered', projectId: currentProject.projectId, scopeFingerprint: currentProject.scopeFingerprint,
    preparedAt: recoveryStartedAt,
  };
  recoveryTask.projectWorkspace = {
    status: 'ready', scopeFingerprint: currentProject.scopeFingerprint, goalVersionId,
    sourceSnapshotSha256: currentDescriptor.sourceSnapshotSha256, sourceHead: currentDescriptor.sourceHead,
  };
  recoveryTask.projectWorkspace.taskInputBinding = projectWorkspace.projectTaskBinding(recoveryTask);
  recoveryTask.integrationExecutionRequest = {
    goalVersionId, prompt: recoveryPrompt, promptSha256: crypto.createHash('sha256').update(recoveryPrompt).digest('hex'),
  };
  recoveryTask.execution = {
    id: 'run-expired-current-scope', goalVersionId, phase: 'failed', stopReason: 'native_process_failed',
    workspaceScopeFingerprint: currentProject.scopeFingerprint, sourceSnapshotSha256: currentDescriptor.sourceSnapshotSha256,
    startedAt: recoveryStartedAt, deadlineAt: new Date(Date.now() - 1_000).toISOString(), limits: recoveryLimits,
    modelCalls: [{ id: 'call-terminal-1', status: 'completed', startedAt: recoveryStartedAt, finishedAt: recoveryStartedAt }],
  };
  const recoveryRegistry = {
    taskId, goalVersionId, projectId: currentProject.projectId,
    workspace: { scopeFingerprint: currentProject.scopeFingerprint,
      sourceSnapshotSha256: currentDescriptor.sourceSnapshotSha256, sourceHead: currentDescriptor.sourceHead },
    native: { maxModelCalls: recoveryLimits.maxModelCalls, maxDurationMs: recoveryLimits.maxDurationMs },
  };
  const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : value && typeof value === 'object'
      ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
      : JSON.stringify(value);
  const recoveryRegistrySha256 = crypto.createHash('sha256').update(canonical(recoveryRegistry)).digest('hex');
  recoveryTask.productBootstrap.registry.registrySha256 = recoveryRegistrySha256;
  recoveryTask.events.push({ id: 'registry-current-recovery', at: recoveryStartedAt,
    type: 'integration.product_registry_registered', detail: { registry: recoveryRegistry, registrySha256: recoveryRegistrySha256 } });
  const recoveryCandidateSha256 = '6'.repeat(64);
  const recoveryArtifactId = 'artifact-confirmed-recovery';
  const recoveryReviewId = 'review-confirmed-recovery';
  const recoveryApprovalId = 'approval-confirmed-recovery';
  recoveryTask.artifacts = [{
    id: recoveryArtifactId, version: 15, status: 'confirmed', reviewStatus: 'passed', goalVersionId,
    nativeProjectCandidate: { version: 1, kind: 'native_worktree_candidate_v1', candidateSha256: recoveryCandidateSha256,
      taskInputBinding: recoveryTask.projectWorkspace.taskInputBinding,
      workspaceScopeFingerprint: currentProject.scopeFingerprint,
      sourceSnapshotSha256: currentDescriptor.sourceSnapshotSha256, registrySha256: recoveryRegistrySha256 },
  }];
  recoveryTask.reviews = [{ id: recoveryReviewId, artifactId: recoveryArtifactId, passed: true, goalVersionId,
    candidateSha256: recoveryCandidateSha256, registrySha256: recoveryRegistrySha256 }];
  recoveryTask.approvals = [{ id: recoveryApprovalId, artifactId: recoveryArtifactId, artifactVersion: 15,
    status: 'confirmed', goalVersionId, candidateSha256: recoveryCandidateSha256, reviewId: recoveryReviewId }];
  await fs.writeFile(taskFile, JSON.stringify(recoveryTask));
  authorityProjection = { projection: {
    taskId, goalVersionId, current: true,
    execution: { id: recoveryTask.execution.id },
    productRegistry: { current: true, registrySha256: recoveryRegistrySha256 },
    workspace: { current: true, scopeFingerprint: currentProject.scopeFingerprint },
    native: { bindingCurrent: true, registrySha256: recoveryRegistrySha256,
      actions: { canRun: false, canPreview: true } },
    artifact: { id: recoveryArtifactId, version: 15, status: 'confirmed', goalVersionId,
      candidateSha256: recoveryCandidateSha256, nativeCandidate: true,
      confirmation: { approvalId: recoveryApprovalId } },
  } };
  const beforeRecovery = await fs.readFile(taskFile, 'utf8');
  const malformedRestore = await jsonRequest(base, `/api/product/tasks/${taskId}/actions`, {
    action: 'prepare_run', mode: 'reuse_current_result', expectedGoalVersionId: goalVersionId,
    expectedScopeFingerprint: currentProject.scopeFingerprint, expectedExecutionId: recoveryTask.execution.id,
    expectedRegistrySha256: recoveryRegistrySha256, expectedArtifactId: recoveryArtifactId,
    expectedArtifactVersion: 15, expectedCandidateSha256: recoveryCandidateSha256,
    expectedExecutionSha256: '7'.repeat(64),
  });
  assert.equal(malformedRestore.status, 400);
  assert.equal(malformedRestore.body.reason.code, 'RUN_PREPARATION_INVALID');
  assert.equal(await fs.readFile(taskFile, 'utf8'), beforeRecovery);
  await assert.rejects(() => fs.access(runtimeSpawnMarkerFile));
  const projectionReadStart = authorityProjectionReads.length;
  authorityProjectionMode = 'reject';
  const recoveryRequest = jsonRequest(base, `/api/product/tasks/${taskId}/actions`, {
    action: 'prepare_run', mode: 'reuse_current_result', expectedGoalVersionId: goalVersionId,
    expectedScopeFingerprint: currentProject.scopeFingerprint, expectedExecutionId: recoveryTask.execution.id,
    expectedRegistrySha256: recoveryRegistrySha256, expectedArtifactId: recoveryArtifactId,
    expectedArtifactVersion: 15, expectedCandidateSha256: recoveryCandidateSha256,
  });
  const spawnDeadline = Date.now() + 2_000;
  let runtimeSpawned = false;
  while (Date.now() < spawnDeadline) {
    try { await fs.access(runtimeSpawnMarkerFile); runtimeSpawned = true; break; }
    catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
  assert.equal(runtimeSpawned, true, 'matching local binding must reach the managed runtime restart while Authority is unavailable');
  const runtimeSpawn = JSON.parse(await fs.readFile(runtimeSpawnMarkerFile, 'utf8'));
  const runtimeArgs = runtimeSpawn.args;
  const runtimePort = (name) => runtimeArgs[runtimeArgs.indexOf(name) + 1];
  assert.equal(runtimePort('--authority-port'), String(authorityPort));
  assert.equal(runtimePort('--openoffice-port'), String(nativePort));
  assert.equal(runtimePort('--agent-office-port'), String(agentOfficePort));
  assert.equal(runtimePort('--scene-port'), String(scenePort));
  assert.equal(new Set([authorityPort, nativePort, agentOfficePort, scenePort]).size, 4);
  authorityProjectionMode = 'accept';
  const recovered = await recoveryRequest;
  assert.equal(recovered.status, 202);
  assert.equal(recovered.body.execution.id, recoveryTask.execution.id);
  assert.equal(recovered.body.prepared.reused, true);
  assert.equal(recovered.body.prepared.reconnect, true);
  assert.equal(recovered.body.prepared.reuseCurrentResult, true);
  assert.deepEqual(authorityProjectionReads.slice(projectionReadStart), ['accept']);
  assert.deepEqual(JSON.parse(await fs.readFile(taskFile, 'utf8')), JSON.parse(beforeRecovery));
  const recoveredTask = JSON.parse(await fs.readFile(taskFile, 'utf8'));
  assert.equal(recoveredTask.execution.id, recoveryTask.execution.id);
  assert.equal(recoveredTask.execution.modelCalls.length, 1);
  assert.equal(recoveredTask.execution.deadlineAt, recoveryTask.execution.deadlineAt);
  assert.equal(recoveredTask.executionHistory?.length || 0, recoveryTask.executionHistory?.length || 0);

  const forwardedPreview = await jsonRequest(base, `/api/product/tasks/${taskId}/actions`, {
    action: 'preview', expectedGoalVersionId: goalVersionId, expectedExecutionId: recoveryTask.execution.id,
  });
  assert.equal(forwardedPreview.status, 200, JSON.stringify(forwardedPreview.body));
  assert.deepEqual(forwardedPreview.body, { source: 'native-gateway', action: 'preview', accepted: true });
  const forwardedRun = await jsonRequest(base, `/api/product/tasks/${taskId}/actions`, {
    action: 'run', expectedGoalVersionId: goalVersionId, expectedExecutionId: recoveryTask.execution.id,
  });
  assert.equal(forwardedRun.status, 202, JSON.stringify(forwardedRun.body));
  assert.deepEqual(forwardedRun.body, { source: 'native-gateway', action: 'run', accepted: true });
  const rejectedUnknown = await jsonRequest(base, `/api/product/tasks/${taskId}/actions`, {
    action: 'unknown_action', expectedGoalVersionId: goalVersionId,
  });
  assert.equal(rejectedUnknown.status, 422, JSON.stringify(rejectedUnknown.body));
  assert.deepEqual(rejectedUnknown.body, { source: 'native-gateway', action: 'unknown_action', accepted: false });
  assert.deepEqual(nativeProductActions, [
    { url: `/api/product/tasks/${taskId}/actions`, action: 'preview', expectedGoalVersionId: goalVersionId,
      expectedExecutionId: recoveryTask.execution.id },
    { url: `/api/product/tasks/${taskId}/actions`, action: 'run', expectedGoalVersionId: goalVersionId,
      expectedExecutionId: recoveryTask.execution.id },
    { url: `/api/product/tasks/${taskId}/actions`, action: 'unknown_action', expectedGoalVersionId: goalVersionId },
  ]);

  const zipTaskResponse = await jsonRequest(base, '/api/product/tasks', {
    title: 'Confirmed ZIP route', statement: 'Package the exact approved tool candidate.',
    successCriteria: ['The archive uses the current Authority approval.'], boundaries: ['Do not start a model run.'],
  });
  assert.equal(zipTaskResponse.status, 201);
  const zipTaskId = zipTaskResponse.body.task.id;
  const zipGoalVersionId = zipTaskResponse.body.task.goalVersionId;
  const zipProject = await trustedProjects.current('tool-zip-route');
  const zipSelected = await jsonRequest(base, `/api/product/tasks/${zipTaskId}/actions`, {
    action: 'select_scope', expectedGoalVersionId: zipGoalVersionId,
    projectId: zipProject.projectId, expectedScopeFingerprint: zipProject.scopeFingerprint,
  });
  assert.equal(zipSelected.status, 200, JSON.stringify(zipSelected.body));
  const zipAuthorized = await jsonRequest(base, `/api/product/tasks/${zipTaskId}/actions`, {
    action: 'authorize_scope', expectedGoalVersionId: zipGoalVersionId,
    projectId: zipProject.projectId, expectedScopeFingerprint: zipProject.scopeFingerprint,
  });
  assert.equal(zipAuthorized.status, 200, JSON.stringify(zipAuthorized.body));

  const candidateRoot = path.join(temporary, 'zip-candidate-worktree');
  await execFile('git', ['-C', toolProjectRoot, 'worktree', 'add', '--quiet', '--detach', candidateRoot, 'HEAD']);
  const candidateApp = Buffer.from('document.body.dataset.version = "approved";\n');
  await fs.writeFile(path.join(candidateRoot, 'app.js'), candidateApp);
  const zipPatch = Buffer.from((await execFile('git', ['-C', candidateRoot, 'diff', '--binary', 'HEAD'], {
    encoding: 'buffer', maxBuffer: 256 * 1024,
  })).stdout);
  const zipSha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
  const zipCanonical = (value) => Array.isArray(value) ? `[${value.map(zipCanonical).join(',')}]`
    : value && typeof value === 'object'
      ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${zipCanonical(value[key])}`).join(',')}}`
      : JSON.stringify(value);
  const changedFile = { path: 'app.js', bytes: candidateApp.length, sha256: zipSha256(candidateApp) };
  const zipCandidateSha256 = zipSha256(Buffer.from(zipCanonical([changedFile])));
  const zipBinding = {
    taskId: zipTaskId, goalVersionId: zipGoalVersionId, executionId: 'run-zip-route',
    registrySha256: 'b'.repeat(64), projectId: zipProject.projectId,
    scopeFingerprint: zipProject.scopeFingerprint, sourceSnapshotSha256: zipProject.sourceSnapshotSha256,
    artifactId: 'artifact-zip-route', artifactVersion: 2, candidateSha256: zipCandidateSha256,
    approvalId: 'approval-zip-route', reviewId: 'review-zip-route', status: 'confirmed',
  };
  const zipReview = { id: zipBinding.reviewId, passed: true, goalVersionId: zipGoalVersionId,
    registrySha256: zipBinding.registrySha256, candidateSha256: zipCandidateSha256 };
  const zipConfirmation = { approvalId: zipBinding.approvalId, artifactVersion: zipBinding.artifactVersion,
    goalVersionId: zipGoalVersionId, candidateSha256: zipCandidateSha256, reviewId: zipBinding.reviewId };
  const rawAuthorityProjection = {
    schemaVersion: 1, taskId: zipTaskId, goalVersionId: zipGoalVersionId, current: true,
    execution: { id: zipBinding.executionId, goalVersionId: zipGoalVersionId },
    workspace: { current: true, scopeFingerprint: zipProject.scopeFingerprint, sourceSnapshotSha256: zipProject.sourceSnapshotSha256 },
    productRegistry: { current: true, taskId: zipTaskId, goalVersionId: zipGoalVersionId,
      projectId: zipProject.projectId, registrySha256: zipBinding.registrySha256,
      workspace: { scopeFingerprint: zipProject.scopeFingerprint, sourceSnapshotSha256: zipProject.sourceSnapshotSha256 } },
    artifact: { id: zipBinding.artifactId, version: 2, status: 'confirmed', goalVersionId: zipGoalVersionId,
      candidateSha256: zipCandidateSha256, review: zipReview, confirmation: zipConfirmation },
  };
  authorityProjection = { projection: rawAuthorityProjection };
  zipGatewayProjection = {
    taskId: zipTaskId, goalVersionId: zipGoalVersionId, current: true,
    execution: { id: zipBinding.executionId },
    product: { projectId: zipProject.projectId, bindingCurrent: true, workspaceScopeFingerprint: zipProject.scopeFingerprint },
    artifact: { id: zipBinding.artifactId, version: 2, candidateSha256: zipCandidateSha256,
      review: { id: zipBinding.reviewId, passed: true }, confirmation: { approvalId: zipBinding.approvalId,
        artifactVersion: 2, goalVersionId: zipGoalVersionId } },
  };
  zipGatewayCandidate = {
    taskId: zipTaskId, goalVersionId: zipGoalVersionId, artifactId: zipBinding.artifactId,
    artifactVersion: zipBinding.artifactVersion, candidateSha256: zipCandidateSha256,
    patch: zipPatch.toString('utf8'), patchSha256: zipSha256(zipPatch), files: [changedFile],
    review: { id: zipBinding.reviewId, passed: true }, confirmation: { ...zipConfirmation },
  };
  zipGatewayPatch = zipPatch;

  const publicProjectionResponse = await fetch(new URL('/api/irixi-authority', `http://127.0.0.1:${nativePort}/`));
  const publicProjection = await publicProjectionResponse.json();
  assert.equal(publicProjection.product?.bindingCurrent, true);
  assert.equal(publicProjection.productRegistry, undefined);
  assert.equal(publicProjection.workspace, undefined);
  assert.equal(publicProjection.artifact?.status, undefined);
  assert.equal(publicProjection.artifact?.goalVersionId, undefined);

  const authorityReadsBeforeZip = authorityProjectionRequests.length;
  const zipResponse = await fetch(new URL(`/api/irixi-authority/zip?artifactId=${zipBinding.artifactId}&approvalId=${zipBinding.approvalId}`, base));
  const zipBytes = Buffer.from(await zipResponse.arrayBuffer());
  assert.equal(zipResponse.status, 200, zipBytes.toString('utf8'));
  assert.equal(zipResponse.headers.get('content-type'), 'application/zip');
  assert.equal(zipResponse.headers.get('x-content-sha256'), zipSha256(zipBytes));
  assert.deepEqual(authorityProjectionRequests.slice(authorityReadsBeforeZip), [
    `/v1/authority?taskId=${encodeURIComponent(zipTaskId)}`,
    `/v1/authority?taskId=${encodeURIComponent(zipTaskId)}`,
  ]);
  assert.ok(zipGatewayRequests.includes('/api/product/candidate'));
  assert.ok(zipGatewayRequests.some((url) => url.startsWith('/api/irixi-authority/patch?')));

});
