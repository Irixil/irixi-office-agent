import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { resolveCodexRuntime } from '../codex-runtime.mjs';
import { __test as providerTest } from '../providers.mjs';

test('ordinary provider preserves synthetic HOME but passes the resolver CODEX_HOME to its child', async () => {
  const syntheticHome = '/tmp/synthetic-provider-home';
  const runtime = resolveCodexRuntime({ env: { HOME: syntheticHome, CODEX_HOME: `${syntheticHome}/.codex` }, realUserHome: '/Users/runtime-test', platform: 'linux' });
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let captured;
  const pending = providerTest.runProcess('/strict-fake-codex', ['--version'], {
    cwd: '/tmp', input: '', env: { HOME: syntheticHome, CODEX_HOME: `${syntheticHome}/.codex` }, codexHome: runtime.codexHome,
    spawnProcess(command, args, options) {
      captured = { command, args, env: options.env };
      queueMicrotask(() => child.emit('close', 0));
      return child;
    },
  });
  await pending;
  assert.equal(captured.command, '/strict-fake-codex');
  assert.deepEqual(captured.args, ['--version']);
  assert.equal(captured.env.HOME, syntheticHome);
  assert.equal(captured.env.CODEX_HOME, '/Users/runtime-test/.codex');
});
