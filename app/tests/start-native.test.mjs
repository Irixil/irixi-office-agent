import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ensureXerj, runNativeStart, stopOwnedXerj } from '../start-native.mjs';

class FakeChild extends EventEmitter {
  exitCode = null;
  signalCode = null;
  kills = [];

  kill(signal) {
    this.kills.push(signal);
    if (signal === 'SIGKILL') this.signalCode = signal;
    if (signal === 'SIGTERM' && this.signalCode === null) {
      this.signalCode = signal;
      queueMicrotask(() => this.emit('exit', null, signal));
    }
    return true;
  }
}

async function xerjFixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-start-native-xerj-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtime = path.join(root, '.irixi-runtime');
  const binary = path.join(runtime, 'xerj-1.0.0-rc.95-aarch64-apple-darwin', 'xerj');
  const data = path.join(runtime, 'xerj-v1.0.0-rc.95', 'data');
  await fs.mkdir(path.dirname(binary), { recursive: true });
  await fs.mkdir(data, { recursive: true });
  await fs.writeFile(binary, 'synthetic binary');
  await fs.chmod(binary, 0o700);
  await fs.writeFile(path.join(data, 'admin.key'), `${'a'.repeat(64)}\n`, { mode: 0o600 });
  return { root, binary, data };
}

test('reuses the authenticated healthy XERJ for the fixed project data and never owns or stops it', async (t) => {
  const fixture = await xerjFixture(t);
  let spawnCount = 0;
  const response = Response.json({ cluster_name: 'xerj', status: 'green', number_of_nodes: 1 });
  const instance = await ensureXerj({ desktopRoot: fixture.root, env: {},
    fetchImpl: async (url, options) => {
      assert.equal(new URL(url).pathname, '/_cluster/health');
      assert.match(options.headers.authorization, /^ApiKey [a-f0-9]{64}$/i);
      assert.equal(options.headers.authorization.includes('aaaaaaaa'), true);
      return response;
    }, spawnImpl() { spawnCount += 1; throw new Error('must reuse'); }, portOccupied() { throw new Error('must not inspect occupied port'); }, warn() {} });
  assert.equal(instance.reused, true);
  assert.equal(instance.child, null);
  assert.equal(spawnCount, 0);
  await stopOwnedXerj(instance.child);
});

test('cold-starts the fixed authenticated lexical XERJ and stops only its owned process', async (t) => {
  const fixture = await xerjFixture(t);
  const child = new FakeChild();
  let args;
  const instance = await ensureXerj({ desktopRoot: fixture.root, env: {}, fetchImpl: async () => { throw new Error('not listening'); },
    portOccupied: async () => false,
    spawnImpl(binary, suppliedArgs, options) { args = { binary, suppliedArgs, options }; return child; }, warn() {} });
  assert.equal(instance.child, child);
  assert.equal(instance.reused, false);
  assert.equal(args.binary, fixture.binary);
  assert.deepEqual(args.suppliedArgs, ['--bind', '127.0.0.1', '--port', '19200', '--data-dir', fixture.data, '--embed-mode', 'lexical']);
  assert.equal(args.options.cwd, fixture.root);
  assert.equal(args.options.stdio, 'ignore');
  await stopOwnedXerj(instance.child);
  assert.deepEqual(child.kills, ['SIGTERM']);
});

test('custom XERJ URL is connected by Desktop configuration without starting the default service', async () => {
  let spawnCount = 0;
  const instance = await ensureXerj({ desktopRoot: '/unused', env: { IRIXI_XERJ_URL: 'http://127.0.0.1:31923' },
    spawnImpl() { spawnCount += 1; }, warn() {} });
  assert.equal(instance.custom, true);
  assert.equal(instance.child, null);
  assert.equal(spawnCount, 0);
});

test('missing installation or spawn failure warns and leaves startup free to continue', async (t) => {
  const fixture = await xerjFixture(t);
  const warnings = [];
  await fs.rm(fixture.binary);
  const missing = await ensureXerj({ desktopRoot: fixture.root, env: {}, warn: (message) => warnings.push(message) });
  assert.equal(missing.child, null);
  assert.equal(warnings.length, 1);

  const occupied = await xerjFixture(t);
  let unexpectedSpawn = false;
  const collision = await ensureXerj({ desktopRoot: occupied.root, env: {}, fetchImpl: async () => { throw new Error('not Xerj'); },
    portOccupied: async () => true, spawnImpl() { unexpectedSpawn = true; }, warn: (message) => warnings.push(message) });
  assert.equal(collision.child, null);
  assert.equal(unexpectedSpawn, false);

  const ready = await xerjFixture(t);
  const spawnFailure = await ensureXerj({ desktopRoot: ready.root, env: {}, fetchImpl: async () => { throw new Error('offline'); },
    portOccupied: async () => false, spawnImpl() { throw new Error('spawn denied'); }, warn: (message) => warnings.push(message) });
  assert.equal(spawnFailure.child, null);
  assert.equal(warnings.length, 3);
});

test('Desktop signal forwards once and cleans the XERJ child created by this entry only', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-start-native-entry-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const product = path.join(root, 'product');
  await fs.mkdir(product);
  await fs.writeFile(path.join(product, 'start-product-entry.mjs'), '');
  const xerj = new FakeChild();
  const desktop = new FakeChild();
  const previousExitCode = process.exitCode;
  try {
    const running = runNativeStart(['--native-root', root, '--zero-model'], {}, {
      ensureXerj: async () => ({ child: xerj, reused: false }),
      spawnImpl: () => desktop,
      onDesktopStart: () => process.emit('SIGTERM'),
    });
    await assert.rejects(running, { code: 'NATIVE_ENTRY_SIGNAL' });
    assert.deepEqual(desktop.kills, ['SIGTERM']);
    assert.deepEqual(xerj.kills, ['SIGTERM']);
  } finally {
    process.exitCode = previousExitCode;
  }
});

test('Desktop spawn failure still stops only its newly started XERJ child', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-start-native-entry-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const product = path.join(root, 'product');
  await fs.mkdir(product);
  await fs.writeFile(path.join(product, 'start-product-entry.mjs'), '');
  const xerj = new FakeChild();
  await assert.rejects(runNativeStart(['--native-root', root], {}, {
    ensureXerj: async () => ({ child: xerj, reused: false }),
    spawnImpl() { throw new Error('desktop spawn failed'); },
  }), /desktop spawn failed/);
  assert.deepEqual(xerj.kills, ['SIGTERM']);
});

test('XERJ degradation does not block a normal Desktop entry start', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-start-native-entry-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const product = path.join(root, 'product');
  await fs.mkdir(product);
  await fs.writeFile(path.join(product, 'start-product-entry.mjs'), '');
  const desktop = new FakeChild();
  const previousExitCode = process.exitCode;
  try {
    await runNativeStart(['--native-root', root, '--zero-model'], {}, {
      ensureXerj: async () => ({ child: null, reused: false }),
      spawnImpl: () => {
        queueMicrotask(() => { desktop.exitCode = 0; desktop.emit('exit', 0, null); });
        return desktop;
      },
    });
    assert.equal(process.exitCode, 0);
  } finally {
    process.exitCode = previousExitCode;
  }
});
