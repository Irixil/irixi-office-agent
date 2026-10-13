import test from 'node:test';
import assert from 'node:assert/strict';
import { closeControlledBrowserSession } from '../project-intake-20261004/projects/article-learning-12/tools/browser-session-lifecycle.mjs';

test('CONTROLLED: browser close releases readline after capture and browser shutdown without Chrome', async () => {
  const calls = [];
  const input = { close() { calls.push('readline.close'); } };
  const browser = {
    async capture(name) { calls.push(`capture:${name}`); },
    async close() { calls.push('browser.close'); },
  };
  assert.deepEqual(await closeControlledBrowserSession({ input, browser }), { desktopInteractionFinished: true });
  assert.deepEqual(calls, ['capture:last-desktop-state.png', 'browser.close', 'readline.close']);
});

test('CONTROLLED: browser close failure still releases readline without Chrome', async () => {
  let readlineClosed = false;
  const input = { close() { readlineClosed = true; } };
  const browser = { async capture() {}, async close() { throw new Error('controlled close failure'); } };
  await assert.rejects(closeControlledBrowserSession({ input, browser }), /controlled close failure/);
  assert.equal(readlineClosed, true);
});
