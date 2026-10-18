import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

import {
  assertAgentOfficeServerBuildCurrent,
  assertPortAvailable,
  classifyRegistryProjection,
  createOwnedChildSupervisor,
  findAgentOfficeRoomListing,
  installSignalFailure,
  joinAgentOfficeRoom,
  resolveAgentOfficeUiRoot,
  resolveInitialRegistryBinding,
  resolveProductPorts,
  stopOwnedServicesAfterRoomLeave,
  waitForHttpReady,
} from './start-product.mjs';
import { desktopEntryReadyMode, resolveDesktopEntryAiEnabled } from './start-product-entry.mjs';

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

test('waits for a controlled stub and stops only its owned process group after true exit', async () => {
  const port = await freePort();
  const supervisor = createOwnedChildSupervisor({ termGraceMs: 1_000, killGraceMs: 1_000 });
  const record = supervisor.start('controlled-ready-stub', process.execPath, ['-e', `
    const http = require('node:http');
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, component: 'controlled-stub' }));
    });
    server.listen(${port}, '127.0.0.1');
    process.on('SIGTERM', () => server.close(() => process.exit(0)));
  `], process.cwd());
  const value = await Promise.race([
    waitForHttpReady(`http://127.0.0.1:${port}/health`, {
      timeoutMs: 3_000,
      label: 'controlled stub',
      validate: (body) => body?.ok === true && body?.component === 'controlled-stub',
    }),
    supervisor.fatal,
  ]);
  assert.deepEqual(value, { ok: true, component: 'controlled-stub' });
  await assert.rejects(() => assertPortAvailable(port), /already in use/);

  const stopped = await supervisor.stop();
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.children.length, 1);
  assert.equal(stopped.children[0].pid, record.child.pid);
  assert.equal(stopped.children[0].exited, true);
  assert.ok(record.child.exitCode !== null || record.child.signalCode !== null);
  await assertPortAvailable(port);
});

test('creates and verifies one real Agent Office room before reporting readiness', async () => {
  class FakeClient {
    constructor(endpoint) { this.endpoint = endpoint; }
    async joinOrCreate(name, options) {
      assert.equal(this.endpoint, 'ws://127.0.0.1:3029');
      assert.equal(name, 'office');
      assert.deepEqual(options, { name: 'Irixi Native Office', taskId: 'task-1' });
      return { roomId: 'room-1', sessionId: 'session-1' };
    }
  }
  const room = await joinAgentOfficeRoom('ws://127.0.0.1:3029', FakeClient, { taskId: 'task-1' });
  assert.equal(room.roomId, 'room-1');
  assert.deepEqual(findAgentOfficeRoomListing([
    { roomId: 'other', name: 'office', clients: 1, maxClients: 100 },
    { roomId: 'room-1', name: 'office', clients: 1, maxClients: 100 },
  ], room.roomId), { roomId: 'room-1', name: 'office', clients: 1, maxClients: 100 });
  assert.equal(findAgentOfficeRoomListing([], room.roomId), null);
});

test('escalates an owned child that ignores SIGTERM and observes SIGKILL exit', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'launcher-owned-child-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const readyFile = path.join(root, 'ready');
  const supervisor = createOwnedChildSupervisor({ termGraceMs: 50, killGraceMs: 1_000 });
  const record = supervisor.start('controlled-term-resistant-stub', process.execPath, ['-e', `
    const fs = require('node:fs');
    process.on('SIGTERM', () => {});
    fs.writeFileSync(${JSON.stringify(readyFile)}, 'ready');
    setInterval(() => {}, 1000);
  `], process.cwd());
  const deadline = Date.now() + 3_000;
  while (!fs.existsSync(readyFile) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(fs.existsSync(readyFile), true);
  const stopped = await supervisor.stop();
  assert.equal(stopped.children[0].exited, true);
  assert.equal(record.child.signalCode, 'SIGKILL');
});

test('waits for and kills an owned descendant after its process-group leader exits', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX process groups are required');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'launcher-owned-descendant-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const readyFile = path.join(root, 'descendant-pid');
  const supervisor = createOwnedChildSupervisor({ termGraceMs: 100, killGraceMs: 1_000 });
  const record = supervisor.start('controlled-descendant-stub', process.execPath, ['-e', `
    const fs = require('node:fs');
    const { spawn } = require('node:child_process');
    const descendant = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    fs.writeFileSync(${JSON.stringify(readyFile)}, String(descendant.pid));
    process.on('SIGTERM', () => process.exit(0));
    setInterval(() => {}, 1000);
  `], process.cwd());
  const deadline = Date.now() + 3_000;
  while (!fs.existsSync(readyFile) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(fs.existsSync(readyFile), true);
  const descendantPid = Number(fs.readFileSync(readyFile, 'utf8'));

  const stopped = await supervisor.stop();
  assert.equal(record.child.exitCode, 0);
  assert.equal(stopped.children[0].processGroupExited, true);
  assert.throws(() => process.kill(descendantPid, 0), (error) => error?.code === 'ESRCH');
});

test('stops owned services when Agent Office room leave never settles', async () => {
  const order = [];
  const result = await stopOwnedServicesAfterRoomLeave({ leave: () => new Promise(() => {}) }, {
    async stop() { order.push('supervisor.stop'); return { stopped: true }; },
  });
  assert.deepEqual(order, ['supervisor.stop']);
  assert.deepEqual(result, { stopped: true });
});

test('nested launcher shutdown survives a second SIGTERM during owned-service cleanup', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX signal behavior is required');
  const source = fs.readFileSync(new URL('./start-product.mjs', import.meta.url), 'utf8');
  const cleanup = source.indexOf('await stopOwnedServicesAfterRoomLeave(agentOfficeRoom, supervisor)');
  const dispose = source.indexOf('signals.dispose()', cleanup);
  assert.ok(cleanup >= 0 && dispose > cleanup, 'signal handlers must remain installed until owned-service cleanup completes');
  const script = `
    import { installSignalFailure, stopOwnedServicesAfterRoomLeave } from ${JSON.stringify(new URL('./start-product.mjs', import.meta.url).href)};
    const signals = installSignalFailure();
    console.log('ready');
    signals.promise.catch(async () => {
      console.log('shutdown-started');
      await stopOwnedServicesAfterRoomLeave(null, { async stop() {
        await new Promise((resolve) => setTimeout(resolve, 250));
        console.log('cleanup-complete');
        return { stopped: true };
      } });
      signals.dispose();
      process.exit(0);
    });
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('signal test child did not become ready')), 3000);
    child.stdout.on('data', () => {
      if (output.includes('ready')) { clearTimeout(timer); resolve(); }
    });
    child.once('error', reject);
  });
  child.kill('SIGTERM');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('launcher did not enter cleanup')), 3000);
    child.stdout.on('data', () => {
      if (output.includes('shutdown-started')) { clearTimeout(timer); resolve(); }
    });
  });
  child.kill('SIGTERM');
  const result = await new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  assert.deepEqual(result, { code: 0, signal: null }, output);
  assert.match(output, /cleanup-complete/);
});

test('unexpected owned child exit rejects the launcher fatal boundary', async () => {
  const supervisor = createOwnedChildSupervisor({ termGraceMs: 100, killGraceMs: 100 });
  supervisor.start('controlled-failing-stub', process.execPath, ['-e', 'process.exit(7)'], process.cwd());
  await assert.rejects(supervisor.fatal, /controlled-failing-stub exited.*7/);
  const stopped = await supervisor.stop();
  assert.equal(stopped.children[0].exitCode, 7);
  assert.equal(stopped.children[0].exited, true);
});

test('registry lifecycle distinguishes normal input rebinding from workspace drift', () => {
  const policy = {
    goalVersionId: 'goal-1',
    taskInputBindingSha256: 'input-1',
    pipelineBindingSha256: 'pipeline-1',
    workspace: { scopeFingerprint: 'scope-1', sourceSnapshotSha256: 'source-1' },
  };
  const projection = {
    current: true,
    goalVersionId: 'goal-1',
    taskInputBindingSha256: 'input-1',
    pipelineBindingSha256: 'pipeline-1',
    workspace: { current: true, scopeFingerprint: 'scope-1', sourceSnapshotSha256: 'source-1' },
  };
  assert.equal(classifyRegistryProjection(policy, projection), 'current');
  assert.equal(classifyRegistryProjection(policy, { ...projection, goalVersionId: 'goal-2', current: false }), 'waiting_rebind');
  assert.throws(
    () => classifyRegistryProjection(policy, { ...projection, workspace: { ...projection.workspace, sourceSnapshotSha256: 'source-2' } }),
    (error) => error?.code === 'SECURITY_BINDING_DRIFT',
  );
  assert.throws(
    () => classifyRegistryProjection(policy, { ...projection, current: false }),
    /became stale without an authorized input-binding transition/,
  );
});

test('managed initial registry derives current task binding only from an unbound authorized policy', () => {
  const policy = {
    workspace: { scopeFingerprint: 'scope-1', sourceSnapshotSha256: 'source-1' },
  };
  const projection = {
    current: true,
    goalVersionId: 'goal-current',
    taskInputBindingSha256: 'input-current',
    pipelineBindingSha256: 'pipeline-current',
    workspace: { current: true, scopeFingerprint: 'scope-1', sourceSnapshotSha256: 'source-1' },
  };
  assert.deepEqual(resolveInitialRegistryBinding(policy, projection, { managedRegistry: true }), {
    goalVersionId: 'goal-current',
    taskInputBindingSha256: 'input-current',
    pipelineBindingSha256: 'pipeline-current',
  });
  assert.throws(
    () => resolveInitialRegistryBinding({ ...policy, goalVersionId: 'stale-goal' }, projection, { managedRegistry: true }),
    /must not predeclare goalVersionId/,
  );
  assert.throws(
    () => resolveInitialRegistryBinding(policy, { ...projection, current: false }, { managedRegistry: true }),
    /requires a current authority projection/,
  );
  assert.throws(
    () => resolveInitialRegistryBinding(policy, {
      ...projection,
      workspace: { ...projection.workspace, scopeFingerprint: 'other-scope' },
    }, { managedRegistry: true }),
    (error) => error?.code === 'SECURITY_BINDING_DRIFT',
  );
});

test('scene resolves the existing Agent Office package UI instead of the repository root', () => {
  const agentOffice = path.resolve(import.meta.dirname, '..', '..', 'sources', 'agent-office');
  const ui = resolveAgentOfficeUiRoot(agentOffice);
  assert.equal(ui, path.join(agentOffice, 'packages', 'ui'));
  assert.equal(fs.statSync(path.join(ui, 'index.html')).isFile(), true);
  assert.equal(fs.statSync(path.join(ui, 'vite.config.ts')).isFile(), true);
});

test('requires the built Agent Office server entries to be at least as current as their sources', () => {
  const agentOffice = path.resolve(import.meta.dirname, '..', '..', 'sources', 'agent-office');
  assert.equal(assertAgentOfficeServerBuildCurrent(agentOffice), true);
});

test('readiness timeout reports elapsed time, last network code, and owned child status', async () => {
  const port = await freePort();
  await assert.rejects(() => waitForHttpReady(`http://127.0.0.1:${port}/health`, {
    timeoutMs: 80,
    label: 'diagnostic stub',
    diagnostics: () => ({ exitCode: null, signalCode: null }),
  }), (error) => error?.code === 'SERVICE_READINESS_TIMEOUT'
    && /after \d+ms/.test(error.message)
    && /lastCode=ECONNREFUSED/.test(error.message)
    && /"exitCode":null/.test(error.message));
});

test('Desktop entry readiness accepts fresh setup and persisted-task recovery modes only', () => {
  assert.equal(desktopEntryReadyMode({ ok: true, mode: 'waiting_task' }), 'waiting_task');
  assert.equal(desktopEntryReadyMode({ ok: true, mode: 'native_product_or_setup' }), 'native_product_or_setup');
  assert.equal(desktopEntryReadyMode({ ok: false, mode: 'waiting_task' }), null);
  assert.equal(desktopEntryReadyMode({ ok: true, mode: 'unexpected' }), null);
  assert.equal(desktopEntryReadyMode({ ok: true, mode: 'waiting_task', aiEnabled: true }, true), 'waiting_task');
  assert.equal(desktopEntryReadyMode({ ok: true, mode: 'waiting_task', aiEnabled: false }, false), 'waiting_task');
  assert.equal(desktopEntryReadyMode({ ok: true, mode: 'waiting_task', aiEnabled: false }, true), null);
});

test('Desktop entry AI mode is explicit and defaults to zero-model', () => {
  assert.equal(resolveDesktopEntryAiEnabled([]), false);
  assert.equal(resolveDesktopEntryAiEnabled(['--zero-model']), false);
  assert.equal(resolveDesktopEntryAiEnabled(['--enable-ai']), true);
  assert.throws(() => resolveDesktopEntryAiEnabled(['--enable-ai', '--zero-model']), /mutually exclusive/);
});

test('managed runtime ports keep defaults and accept only distinct non-privileged ports', () => {
  assert.deepEqual(resolveProductPorts([]), { desktop: 3847, authority: 3869, openoffice: 9109, agentOffice: 3029, scene: 5189 });
  assert.deepEqual(resolveProductPorts(['--desktop-port', '55423', '--authority-port', '31639', '--openoffice-port', '22797', '--agent-office-port', '31640', '--scene-port', '31641']), {
    desktop: 55423, authority: 31639, openoffice: 22797, agentOffice: 31640, scene: 31641,
  });
  assert.throws(() => resolveProductPorts(['--authority-port', '80']), /--authority-port is invalid/);
  assert.throws(() => resolveProductPorts(['--authority-port', '31639', '--openoffice-port', '31639']), /ports must be distinct/);
});
