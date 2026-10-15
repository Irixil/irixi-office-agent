#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const slice = path.dirname(here);
const upstream = path.dirname(slice);
const oo = path.join(upstream, 'sources', 'OpenOffice');
const ao = path.join(upstream, 'sources', 'agent-office');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const exited = (record) => record.spawnFailed || record.child.exitCode !== null || record.child.signalCode !== null;
const ownedProcessAlive = (record) => {
  if (record.spawnFailed) return false;
  if (record.detached && Number.isInteger(record.processGroupId)) {
    try { process.kill(-record.processGroupId, 0); return true; }
    catch (error) { return error?.code !== 'ESRCH'; }
  }
  return !exited(record);
};
const valueArg = (argv, name) => { const index = argv.indexOf(`--${name}`); return index < 0 ? null : argv[index + 1]; };
const hasFlag = (argv, name) => argv.includes(`--${name}`);

export function createOwnedChildSupervisor({ termGraceMs = 5_000, killGraceMs = 5_000 } = {}) {
  const children = [];
  let stopping = false;
  let stopPromise = null;
  let rejectFatal;
  const fatal = new Promise((_, reject) => { rejectFatal = reject; });
  // A startup failure can happen between spawn and the caller's first race.
  // Attach a handler while preserving the rejected promise for controlled races.
  fatal.catch(() => {});

  function start(name, command, args, cwd, env = {}) {
    if (stopping) throw new Error(`Cannot start ${name} while launcher is stopping`);
    const detached = process.platform !== 'win32';
    const child = spawn(command, args, {
      cwd,
      detached,
      env: { ...process.env, ...env },
      stdio: 'inherit',
    });
    const record = { name, child, detached, processGroupId: detached ? child.pid : null, spawnFailed: false };
    children.push(record);
    child.once('error', (error) => {
      record.spawnFailed = true;
      if (!stopping) rejectFatal(Object.assign(new Error(`${name} failed to spawn: ${error.message}`), { cause: error }));
    });
    child.once('exit', (code, signal) => {
      if (!stopping) rejectFatal(new Error(`${name} exited before launcher shutdown (${signal || code})`));
    });
    return record;
  }

  function signalOwned(record, signal) {
    if (record.detached && Number.isInteger(record.processGroupId) && record.processGroupId === record.child.pid) {
      try { process.kill(-record.processGroupId, signal); return; }
      catch (error) {
        if (error?.code === 'ESRCH') return;
        /* Fall back to the exact owned child below. */
      }
    }
    if (exited(record)) return;
    try { record.child.kill(signal); } catch (error) { if (error?.code !== 'ESRCH') throw error; }
  }

  async function waitForExit(deadlineMs) {
    const deadline = Date.now() + deadlineMs;
    while (children.some(ownedProcessAlive) && Date.now() < deadline) await delay(25);
    return children.filter(ownedProcessAlive);
  }

  function stop() {
    if (stopPromise) return stopPromise;
    stopping = true;
    stopPromise = (async () => {
      for (const record of children) signalOwned(record, 'SIGTERM');
      let remaining = await waitForExit(termGraceMs);
      for (const record of remaining) signalOwned(record, 'SIGKILL');
      remaining = await waitForExit(killGraceMs);
      if (remaining.length) throw new Error(`Owned child processes did not exit: ${remaining.map((item) => item.name).join(', ')}`);
      return {
        stopped: true,
        children: children.map((record) => ({
          name: record.name,
          pid: record.child.pid ?? null,
          exitCode: record.child.exitCode,
          signalCode: record.child.signalCode,
          exited: exited(record),
          processGroupExited: !ownedProcessAlive(record),
        })),
      };
    })();
    return stopPromise;
  }

  return { start, stop, fatal, children, get stopping() { return stopping; } };
}

export async function stopOwnedServicesAfterRoomLeave(room, supervisor) {
  if (room) {
    let timer;
    const leave = Promise.resolve().then(() => room.leave(true)).catch(() => {});
    await Promise.race([leave, new Promise((resolve) => { timer = setTimeout(resolve, 2_000); })]);
    clearTimeout(timer);
  }
  return supervisor.stop();
}

export async function assertPortAvailable(port, host = '127.0.0.1') {
  await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`Port check timed out for ${host}:${port}`)); }, 750);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); reject(new Error(`Port ${host}:${port} is already in use; no existing process was stopped`)); });
    socket.once('error', (error) => {
      clearTimeout(timer);
      socket.destroy();
      if (error?.code === 'ECONNREFUSED') resolve(); else reject(error);
    });
  });
}

export async function waitForHttpReady(url, {
  timeoutMs = 15_000,
  label = url,
  json = true,
  validate = () => true,
  signal = null,
  diagnostics = null,
} = {}) {
  const startedAt = Date.now();
  const deadline = Date.now() + timeoutMs;
  let failure = null;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw signal.reason || new Error(`${label} readiness was cancelled`);
    try {
      const attemptSignal = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(1_000)])
        : AbortSignal.timeout(1_000);
      const response = await fetch(url, { signal: attemptSignal, redirect: 'manual' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const value = json ? await response.json() : await response.text();
      if (!validate(value, response)) throw new Error('response contract mismatch');
      return value;
    } catch (error) {
      if (signal?.aborted) throw signal.reason || error;
      failure = error;
    }
    await delay(100);
  }
  let code = null, cursor = failure;
  while (cursor && !code) { code = cursor.code || null; cursor = cursor.cause; }
  let runtime = null;
  try { runtime = typeof diagnostics === 'function' ? diagnostics() : null; } catch {}
  const detail = runtime ? `; child=${JSON.stringify(runtime)}` : '';
  throw Object.assign(new Error(`${label} did not become ready after ${Date.now() - startedAt}ms: ${failure?.message || 'timeout'}; lastCode=${code || 'none'}${detail}`), {
    code: 'SERVICE_READINESS_TIMEOUT', cause: failure,
  });
}

export async function joinAgentOfficeRoom(wsEndpoint, ClientClass, options = {}) {
  assert.match(wsEndpoint, /^ws:\/\/127\.0\.0\.1:\d+$/, 'Agent Office websocket endpoint is invalid');
  assert.equal(typeof ClientClass, 'function', 'Agent Office client is unavailable');
  const client = new ClientClass(wsEndpoint);
  const room = await client.joinOrCreate('office', { name: 'Irixi Native Office', ...options });
  assert.ok(typeof room?.roomId === 'string' && room.roomId.length > 0, 'Agent Office did not create a room');
  assert.ok(typeof room?.sessionId === 'string' && room.sessionId.length > 0, 'Agent Office room did not return a session');
  return room;
}

export function findAgentOfficeRoomListing(value, roomId) {
  if (!Array.isArray(value) || typeof roomId !== 'string' || !roomId) return null;
  const room = value.find((item) => item?.roomId === roomId && item?.name === 'office');
  if (!room) return null;
  return Object.freeze({
    roomId: room.roomId,
    name: room.name,
    clients: Number.isInteger(room.clients) ? room.clients : null,
    maxClients: Number.isInteger(room.maxClients) ? room.maxClients : null,
  });
}

function controlled(promise, supervisor, signalFailure) {
  return Promise.race([promise, supervisor.fatal, signalFailure]);
}

export function installSignalFailure() {
  let rejectSignal;
  let stopping = false;
  const promise = new Promise((_, reject) => { rejectSignal = reject; });
  promise.catch(() => {});
  const handlers = new Map();
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const handler = () => {
      if (stopping) return;
      stopping = true;
      rejectSignal(Object.assign(new Error(`Launcher received ${signal}`), { code: 'LAUNCHER_SIGNAL', signal }));
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  return {
    promise,
    dispose() { for (const [signal, handler] of handlers) process.removeListener(signal, handler); },
  };
}

async function canonicalDirectory(input, name) {
  assert.ok(input && path.isAbsolute(input), `${name} must be an absolute path`);
  const real = await fsp.realpath(input);
  assert.equal(real, input, `${name} must be canonical`);
  const stat = await fsp.lstat(real);
  assert.equal(stat.isDirectory() && !stat.isSymbolicLink(), true, `${name} must be a real directory`);
  return real;
}

async function canonicalRegularFile(input, name) {
  assert.ok(input && path.isAbsolute(input), `${name} must be an absolute path`);
  const real = await fsp.realpath(input);
  assert.equal(real, input, `${name} must be canonical`);
  const stat = await fsp.lstat(real);
  assert.equal(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, true, `${name} must be a regular single-link file`);
  return real;
}

function checkedPort(value, name) {
  const port = Number(value);
  assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535, `${name} is invalid`);
  return port;
}

export function resolveAgentOfficeUiRoot(agentOfficeRoot) {
  const root = fs.realpathSync(agentOfficeRoot);
  const ui = fs.realpathSync(path.join(root, 'packages', 'ui'));
  assert.ok(ui.startsWith(`${root}${path.sep}`), 'Agent Office UI escaped its source root');
  for (const file of ['index.html', 'vite.config.ts', 'package.json']) {
    const stat = fs.lstatSync(path.join(ui, file));
    assert.equal(stat.isFile() && !stat.isSymbolicLink(), true, `Agent Office UI entry is invalid: ${file}`);
  }
  return ui;
}

export function assertAgentOfficeServerBuildCurrent(agentOfficeRoot) {
  const root = fs.realpathSync(agentOfficeRoot);
  const pairs = [
    ['packages/server/src/index.ts', 'packages/server/dist/index.js'],
    ['packages/server/src/rooms/OfficeRoom.ts', 'packages/server/dist/rooms/OfficeRoom.js'],
    ['packages/server/src/memory/MemoryStore.ts', 'packages/server/dist/memory/MemoryStore.js'],
  ];
  for (const [sourceRelative, builtRelative] of pairs) {
    const source = path.join(root, sourceRelative), built = path.join(root, builtRelative);
    const sourceStat = fs.lstatSync(source), builtStat = fs.lstatSync(built);
    assert.equal(sourceStat.isFile() && !sourceStat.isSymbolicLink(), true, `Agent Office source entry is invalid: ${sourceRelative}`);
    assert.equal(builtStat.isFile() && !builtStat.isSymbolicLink(), true, `Agent Office build entry is invalid: ${builtRelative}`);
    assert.ok(builtStat.mtimeMs >= sourceStat.mtimeMs, `Agent Office build is stale: ${builtRelative}`);
  }
  return true;
}

export function classifyRegistryProjection(policy, projection) {
  const inputBindingChanged = projection.goalVersionId !== policy.goalVersionId
    || projection.taskInputBindingSha256 !== policy.taskInputBindingSha256
    || projection.pipelineBindingSha256 !== policy.pipelineBindingSha256;
  const workspaceBindingChanged = projection.workspace?.current !== true
    || projection.workspace?.scopeFingerprint !== policy.workspace.scopeFingerprint
    || projection.workspace?.sourceSnapshotSha256 !== policy.workspace.sourceSnapshotSha256;
  if (workspaceBindingChanged) {
    throw Object.assign(new Error('Authorized workspace or source binding changed'), { code: 'SECURITY_BINDING_DRIFT' });
  }
  if (inputBindingChanged) return 'waiting_rebind';
  assert.equal(projection.current, true, 'Current authority became stale without an authorized input-binding transition');
  return 'current';
}

export function resolveInitialRegistryBinding(policy, projection, { managedRegistry = false } = {}) {
  if (managedRegistry) {
    for (const field of ['goalVersionId', 'taskInputBindingSha256', 'pipelineBindingSha256']) {
      assert.equal(Object.hasOwn(policy, field), false, `Managed runtime policy must not predeclare ${field}`);
    }
    const workspaceBindingChanged = projection.workspace?.current !== true
      || projection.workspace?.scopeFingerprint !== policy.workspace.scopeFingerprint
      || projection.workspace?.sourceSnapshotSha256 !== policy.workspace.sourceSnapshotSha256;
    if (workspaceBindingChanged) {
      throw Object.assign(new Error('Authorized workspace or source binding changed'), { code: 'SECURITY_BINDING_DRIFT' });
    }
    assert.equal(projection.current, true, 'Managed runtime requires a current authority projection');
  } else if (classifyRegistryProjection(policy, projection) === 'waiting_rebind') {
    throw Object.assign(new Error('Task goal, input, or pipeline binding changed'), { code: 'REGISTRY_REBIND_REQUIRED' });
  }
  return Object.freeze({
    goalVersionId: projection.goalVersionId,
    taskInputBindingSha256: projection.taskInputBindingSha256,
    pipelineBindingSha256: projection.pipelineBindingSha256,
  });
}

export async function runProductLauncher(argv = process.argv.slice(2)) {
  const policyFile = await canonicalRegularFile(valueArg(argv, 'registry'), '--registry');
  const tasksRoot = await canonicalDirectory(valueArg(argv, 'tasks-root'), '--tasks-root');
  const desktopRoot = await canonicalDirectory(valueArg(argv, 'desktop-root'), '--desktop-root');
  const desktopAppRoot = await canonicalDirectory(path.join(desktopRoot, 'app'), 'Desktop app root');
  const taskId = valueArg(argv, 'task');
  assert.match(taskId || '', /^[A-Za-z0-9_-]{1,160}$/, '--task is invalid');

  const nativeOnly = hasFlag(argv, 'native-only') || hasFlag(argv, 'skip-desktop');
  const managedRegistry = hasFlag(argv, 'managed-registry');
  const enableAi = hasFlag(argv, 'enable-ai');
  const explicitZeroModel = hasFlag(argv, 'zero-model');
  assert.equal(enableAi && explicitZeroModel, false, '--enable-ai and --zero-model are mutually exclusive');
  const zeroModel = !enableAi;

  const policy = JSON.parse(await fsp.readFile(policyFile, 'utf8'));
  assert.equal(policy.schemaVersion, 1);
  assert.equal(policy.taskId === undefined || policy.taskId === taskId, true, 'Policy taskId changed');
  assert.equal(policy.authorityUrl, 'http://127.0.0.1:3869/');
  assert.equal(await fsp.realpath(policy.workspace.path), policy.workspace.path);
  assert.equal(policy.native.backend, 'codex');
  assert.equal(policy.capabilities.worktree, true);
  assert.equal(policy.capabilities.autoMerge, false);
  assert.equal(policy.capabilities.manualMerge, false);
  assert.equal(policy.capabilities.commandPreview, false);

  const modelCacheFile = path.join(os.homedir(), '.codex', 'models_cache.json');
  const modelCacheBytes = await fsp.readFile(modelCacheFile);
  const modelCache = JSON.parse(modelCacheBytes.toString('utf8'));
  const selectedModel = modelCache.models?.find((entry) => entry.slug === policy.native.model);
  assert.ok(selectedModel, `Selected model ${policy.native.model} is absent from the current Codex model cache`);
  assert.ok(Number.isInteger(selectedModel.context_window) && selectedModel.context_window > 0);
  assert.ok(typeof selectedModel.effective_context_window_percent === 'number'
    && selectedModel.effective_context_window_percent > 0 && selectedModel.effective_context_window_percent <= 100);
  const promptBudget = Object.freeze({
    contextWindowTokens: selectedModel.context_window,
    effectiveContextPercent: selectedModel.effective_context_window_percent,
    outputTokens: 24_576,
    protocolTokens: 8_192,
  });
  const modelCacheEvidence = Object.freeze({
    file: modelCacheFile,
    sha256: crypto.createHash('sha256').update(modelCacheBytes).digest('hex'),
    fetchedAt: modelCache.fetched_at || null,
    clientVersion: modelCache.client_version || null,
    selectedModelSha256: crypto.createHash('sha256').update(JSON.stringify(selectedModel)).digest('hex'),
  });

  const stateRootArg = valueArg(argv, 'state');
  const stateRoot = stateRootArg || path.join(here, 'runtime', policy.projectId);
  assert.ok(path.isAbsolute(stateRoot), '--state must be absolute');
  const productRoot = await fsp.realpath(here);
  const lexicalState = path.resolve(stateRoot);
  assert.ok(lexicalState.startsWith(`${productRoot}${path.sep}`), '--state must remain below the product directory');
  let state = await fsp.realpath(stateRoot).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!state) {
    const parent = path.dirname(lexicalState);
    assert.equal(await fsp.realpath(parent), parent, '--state parent must be an existing canonical directory');
    assert.ok(parent === productRoot || parent.startsWith(`${productRoot}${path.sep}`), '--state parent must remain below the product directory');
    await fsp.mkdir(lexicalState, { mode: 0o700 });
    state = await fsp.realpath(lexicalState);
  }
  assert.ok(path.isAbsolute(state) && state.startsWith(`${productRoot}${path.sep}`), '--state must remain below the product directory');
  const runtimeRegistry = path.join(state, 'current-product-registry.json');
  const agentOfficeUi = resolveAgentOfficeUiRoot(ao);
  assertAgentOfficeServerBuildCurrent(ao);
  for (const file of [
    path.join(oo, 'apps/gateway/node_modules/.bin/tsx'),
    path.join(ao, 'packages/server/dist/index.js'),
    path.join(ao, 'node_modules/.bin/vite'),
    path.join(here, 'desktop-product-server.mjs'),
  ]) assert.equal(fs.existsSync(file), true, `Existing dependency/build is missing: ${file}`);

  const ports = {
    desktop: checkedPort(valueArg(argv, 'desktop-port') || 3847, '--desktop-port'),
    authority: 3869,
    openoffice: checkedPort(valueArg(argv, 'openoffice-port') || 9109, '--openoffice-port'),
    agentOffice: checkedPort(valueArg(argv, 'agent-office-port') || 3029, '--agent-office-port'),
    scene: checkedPort(valueArg(argv, 'scene-port') || 5189, '--scene-port'),
  };
  const activePorts = nativeOnly
    ? [ports.authority, ports.openoffice, ports.agentOffice, ports.scene]
    : Object.values(ports);
  assert.equal(new Set(activePorts).size, activePorts.length, 'Started service ports must be distinct');
  for (const port of activePorts) await assertPortAvailable(port);

  const supervisor = createOwnedChildSupervisor();
  const signals = installSignalFailure();
  const lifecycle = new AbortController();
  let refresh = null;
  let agentOfficeRoom = null;
  let rejectRefreshFailure;
  const refreshFailure = new Promise((_, reject) => { rejectRefreshFailure = reject; });
  refreshFailure.catch(() => {});
  try {
    supervisor.start('Irixi product authority', process.execPath, [path.join(slice, 'authority/server.mjs')], slice, {
      IRIXI_PRODUCT_AUTHORITY: '1',
      IRIXI_AUTHORITY_PORT: String(ports.authority),
      IRIXI_AUTHORITY_TASKS_ROOT: tasksRoot,
      IRIXI_AUTHORITY_TASK_ID: taskId,
      IRIXI_APP_ROOT: desktopAppRoot,
      IRIXI_INTEGRATION_STATE_ROOT: path.join(state, 'authority'),
    });
    const authorityHealth = await controlled(waitForHttpReady(`http://127.0.0.1:${ports.authority}/health`, {
      label: 'Irixi product authority',
      validate: (value) => value?.ok === true && value?.mode === 'irixi-native-product-authority-v1',
      signal: lifecycle.signal,
    }), supervisor, signals.promise);

    async function refreshRegistry() {
      const response = await fetch(`http://127.0.0.1:${ports.authority}/v1/authority?taskId=${encodeURIComponent(taskId)}`, {
        signal: AbortSignal.any([lifecycle.signal, AbortSignal.timeout(3_000)]),
      });
      assert.equal(response.ok, true, `Irixi authority projection failed (${response.status})`);
      const { projection } = await response.json();
      assert.equal(projection?.taskId, taskId);
      const resolvedBinding = resolveInitialRegistryBinding(policy, projection, { managedRegistry });
      const registry = {
        ...policy,
        taskId,
        ...resolvedBinding,
        workspace: {
          ...policy.workspace,
          scopeFingerprint: projection.workspace?.scopeFingerprint,
          sourceSnapshotSha256: projection.workspace?.sourceSnapshotSha256,
        },
        native: { ...policy.native, promptBudget },
      };
      const bytes = `${JSON.stringify(registry, null, 2)}\n`;
      if (await fsp.readFile(runtimeRegistry, 'utf8').catch(() => null) !== bytes) {
        const temporary = `${runtimeRegistry}.${process.pid}.tmp`;
        await fsp.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
        await fsp.rename(temporary, runtimeRegistry);
      }
      const registered = await fetch(policy.authorityUrl + 'v1/product-registry', {
        method: 'POST',
        signal: AbortSignal.any([lifecycle.signal, AbortSignal.timeout(3_000)]),
        headers: { 'content-type': 'application/json' },
        body: bytes,
      });
      assert.equal(registered.ok, true, `Irixi rejected product registry (${registered.status})`);
      return registry;
    }

    const registry = await controlled(refreshRegistry(), supervisor, signals.promise);
    const openOfficeRecord = supervisor.start('OpenOffice native gateway', path.join(oo, 'apps/gateway/node_modules/.bin/tsx'), ['apps/gateway/src/index.ts'], oo, {
      OPEN_OFFICE_DISABLE_AI: zeroModel ? '1' : '0',
      NO_OPEN: '1',
      WS_PORT: String(ports.openoffice),
      GATEWAY_ID: `product-${policy.projectId}`,
      OPEN_OFFICE_CONFIG_DIR: path.join(state, 'openoffice'),
      OPEN_OFFICE_PRODUCT_REGISTRY_FILE: runtimeRegistry,
      OPEN_OFFICE_CODEX_WRAPPER: '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
      WORKSPACE: registry.workspace.path,
      IRIXI_AUTHORITY_URL: policy.authorityUrl,
      IRIXI_AUTHORITY_TASK_ID: taskId,
    });
    const agentOfficeRecord = supervisor.start('Agent Office server', process.execPath, ['packages/server/dist/index.js'], ao, {
      PORT: String(ports.agentOffice),
      AGENT_OFFICE_ZERO_MODEL: '1',
      AGENT_OFFICE_STATE_DIR: path.join(state, 'agent-office'),
      AGENT_OFFICE_IRIXI_AUTHORITY_URL: policy.authorityUrl,
      AGENT_OFFICE_IRIXI_TASK_ID: taskId,
      AGENT_OFFICE_OPENOFFICE_URL: `http://127.0.0.1:${ports.openoffice}/`,
    });
    const sceneRecord = supervisor.start('Agent Office scene', path.join(ao, 'node_modules/.bin/vite'), ['--host', '127.0.0.1', '--port', String(ports.scene), '--strictPort'], agentOfficeUi, {
      AGENT_OFFICE_UI_PORT: String(ports.scene),
      AGENT_OFFICE_SERVER_URL: `http://127.0.0.1:${ports.agentOffice}`,
    });
    if (!nativeOnly) {
      supervisor.start('Desktop native product UI', process.execPath, [path.join(here, 'desktop-product-server.mjs')], here, {
        IRIXI_DESKTOP_ROOT: desktopRoot,
        IRIXI_APP_ROOT: desktopAppRoot,
        IRIXI_AUTHORITY_TASKS_ROOT: tasksRoot,
        IRIXI_DESKTOP_PORT: String(ports.desktop),
        IRIXI_NATIVE_URL: `http://127.0.0.1:${ports.openoffice}/`,
        IRIXI_PRODUCT_AUTHORITY_URL: `http://127.0.0.1:${ports.authority}/`,
      });
    }

    const urls = {
      authority: `http://127.0.0.1:${ports.authority}/`,
      openoffice: `http://127.0.0.1:${ports.openoffice}/`,
      agentOffice: `http://127.0.0.1:${ports.agentOffice}/`,
      scene: `http://127.0.0.1:${ports.scene}/`,
      desktop: `http://127.0.0.1:${ports.desktop}/`,
    };
    const agentOfficeReady = (async () => {
      await waitForHttpReady(`${urls.agentOffice}api/offices`, {
        timeoutMs: 45_000,
        label: 'Agent Office server',
        signal: lifecycle.signal,
        diagnostics: () => ({ exitCode: agentOfficeRecord.child.exitCode, signalCode: agentOfficeRecord.child.signalCode }),
        validate: (value) => value?.status === 'ok' && Array.isArray(value?.offices),
      });
      const clientModule = await import(pathToFileURL(path.join(ao, 'node_modules', 'colyseus.js', 'build', 'esm', 'index.mjs')).href);
      agentOfficeRoom = await joinAgentOfficeRoom(`ws://127.0.0.1:${ports.agentOffice}`, clientModule.Client, {
        taskId,
        executionId: registry.executionId || null,
      });
      const listing = await waitForHttpReady(`${urls.agentOffice}matchmake/office`, {
        timeoutMs: 10_000,
        label: 'Agent Office room',
        signal: lifecycle.signal,
        diagnostics: () => ({ roomId: agentOfficeRoom?.roomId || null }),
        validate: (value) => Boolean(findAgentOfficeRoomListing(value, agentOfficeRoom?.roomId)),
      });
      return findAgentOfficeRoomListing(listing, agentOfficeRoom.roomId);
    })();
    const ready = await controlled(Promise.all([
      Promise.resolve(authorityHealth),
      waitForHttpReady(`${urls.openoffice}api/product-state`, {
        timeoutMs: 45_000,
        label: 'OpenOffice native gateway',
        signal: lifecycle.signal,
        diagnostics: () => ({ exitCode: openOfficeRecord.child.exitCode, signalCode: openOfficeRecord.child.signalCode }),
        validate: (value) => value?.taskId === taskId && value?.current === true
          && value?.product?.bindingCurrent === true,
      }),
      agentOfficeReady,
      waitForHttpReady(urls.scene, {
        timeoutMs: 45_000,
        label: 'Agent Office scene',
        signal: lifecycle.signal,
        diagnostics: () => ({ exitCode: sceneRecord.child.exitCode, signalCode: sceneRecord.child.signalCode }),
        json: false,
        validate: (value, response) => typeof value === 'string' && value.length > 0
          && /text\/html/i.test(response.headers.get('content-type') || ''),
      }),
      ...(!nativeOnly ? [waitForHttpReady(`${urls.desktop}api/product-health`, {
        label: 'Desktop native product UI',
        signal: lifecycle.signal,
        validate: (value) => value?.ok === true,
      })] : []),
    ]), supervisor, signals.promise);
    assert.equal(ready.length, nativeOnly ? 4 : 5);

    if (!managedRegistry) {
      refresh = setInterval(() => {
        refreshRegistry().catch((error) => {
          if (error?.code === 'REGISTRY_REBIND_REQUIRED') {
            clearInterval(refresh);
            refresh = null;
            console.log(JSON.stringify({
              ok: true,
              mode: 'waiting_rebind',
              taskId,
              reason: 'task_goal_input_or_pipeline_changed',
              authorityAvailable: true,
              nativeActionsEnabled: false,
              requiresPreparedRegistryRestart: true,
              modelCalls: 0,
            }));
            return;
          }
          rejectRefreshFailure(Object.assign(new Error(`Registry refresh rejected: ${error.message}`), { cause: error }));
        });
      }, 2_000);
      refresh.unref();
    }

    const services = {
      authority: { ready: true, url: urls.authority },
      openoffice: { ready: true, url: urls.openoffice },
      agentOffice: { ready: true, roomReady: true, room: ready[2], url: urls.agentOffice },
      scene: { ready: true, url: urls.scene },
      desktop: nativeOnly ? { ready: false, skipped: true, url: urls.desktop } : { ready: true, url: urls.desktop },
    };
    const expectedReadyServiceCount = nativeOnly ? 4 : 5;
    console.log(JSON.stringify({
      ok: true,
      mode: zeroModel ? 'development_zero_model' : 'native_authorized',
      taskId,
      nativeOnly,
      registryLifecycle: managedRegistry ? 'external_controller' : 'launcher_guarded',
      aiEnabled: !zeroModel,
      services,
      readyServiceCount: expectedReadyServiceCount,
      expectedReadyServiceCount,
      allStartedServicesReady: true,
      desktop: nativeOnly ? null : `${urls.desktop}?backend=openoffice`,
      authority: urls.authority,
      native: urls.openoffice,
      scene: `${urls.scene}?ws=ws://127.0.0.1:${ports.agentOffice}`,
      automaticMerge: false,
      modelCalls: 0,
      promptBudget,
      modelCacheEvidence,
    }));

    await controlled(refreshFailure, supervisor, signals.promise);
  } catch (error) {
    if (error?.code === 'LAUNCHER_SIGNAL') process.exitCode = error.signal === 'SIGINT' ? 130 : 143;
    else throw error;
  } finally {
    if (refresh) clearInterval(refresh);
    lifecycle.abort(new Error('Product launcher is stopping'));
    try { await stopOwnedServicesAfterRoomLeave(agentOfficeRoom, supervisor); }
    finally { signals.dispose(); }
  }
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  runProductLauncher().catch((error) => {
    console.error(`[Product] startup failed: ${error instanceof Error ? error.stack || error.message : String(error)}`);
    process.exitCode = 1;
  });
}
