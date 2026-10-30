import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runOmoNativeRpcRole } from './native-rpc-runner.mjs';
import { guardWorkspaceToolCalls, missingReadErrorsSinceProgress } from './codex-provider-protocol.mjs';

const enabled = process.env.IRIXI_RUN_NATIVE_TOOL_TESTS === '1';
const read = (file) => ({ type: 'toolCall', name: 'read', arguments: { path: file } });
const text = (value) => ({ type: 'text', text: value });
const decision = (...content) => JSON.stringify({ content });
const results = (request) => request.messages.filter((m) => m.role === 'toolResult');
const body = (m) => m.content.filter((x) => x.type === 'text').map((x) => x.text).join('\n');
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-blocked-read-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace'), context = path.join(root, 'context'), outside = path.join(root, 'outside');
  for (const dir of [workspace, context, outside]) await fs.mkdir(dir);
  for (const name of ['README.md', 'summary.mjs', 'items.json', 'human-note.txt', 'test.mjs']) await fs.writeFile(path.join(workspace, name), `Authorized ${name}`);
  await fs.writeFile(path.join(context, 'functional-checks.json'), 'Actual current check fixture');
  await fs.writeFile(path.join(outside, 'human-note.txt'), 'OUTSIDE_SENTINEL_MUST_NOT_BE_READ');
  const receipts = [];
  return { root, workspace, context, outside, receipts, options: { role: 'Developer', conversation: true, cwd: workspace, readRoots: [context],
    prompt: 'Controlled local tools only. Read authorized files; blocked absolute path does not add access.', timeoutMs: 30000,
    stopOnIdenticalDecision: true, onToolReceipt: (r) => receipts.push(r) } };
}

test('absolute read refusal performs no external filesystem inspection in preflight or strict hook', async (t) => {
  const f = await fixture(t), attempts = [];
  const originals = Object.fromEntries(['lstat', 'stat', 'realpath', 'readFile', 'readdir'].map((key) => [key, fs[key]]));
  for (const key of Object.keys(originals)) fs[key] = async (...args) => {
    if (String(args[0]).startsWith(f.outside)) { attempts.push({ operation: key, path: String(args[0]) }); throw new Error('external I/O attempted'); }
    return originals[key](...args);
  };
  try {
    for (const name of ['read', 'grep', 'find', 'ls']) {
      const value = { content: [{ type: 'toolCall', name, arguments: { path: path.join(f.outside, 'human-note.txt') } }] };
      const options = { role: 'Developer', conversation: true, rootPath: f.workspace, readRoots: [f.context] };
      await guardWorkspaceToolCalls(value, { ...options, deferMissingReadErrors: true });
      await assert.rejects(guardWorkspaceToolCalls(value, options), (e) => e.code === 'OMO_WORKSPACE_PATH_BLOCKED' && /No file was opened/.test(e.message));
    }
    assert.deepEqual(attempts, []);
  } finally { Object.assign(fs, originals); }
});

test('relative traversal, aliases, links and every out-of-scope write remain fatal before dispatch', async (t) => {
  const f = await fixture(t); await fs.symlink(path.join(f.outside, 'human-note.txt'), path.join(f.workspace, 'link.txt'));
  const options = { role: 'Developer', conversation: true, rootPath: f.workspace, readRoots: [f.context], deferMissingReadErrors: true };
  for (const block of [read('../outside/human-note.txt'), read('@file'), read('link.txt'),
    { type: 'toolCall', name: 'write', arguments: { path: path.join(f.outside, 'new.txt'), content: 'bad' } },
    { type: 'toolCall', name: 'edit', arguments: { path: path.join(f.outside, 'human-note.txt'), oldText: 'x', newText: 'y' } }]) {
    await assert.rejects(guardWorkspaceToolCalls({ content: [block] }, options), (e) => e.code !== 'OMO_WORKSPACE_PATH_BLOCKED');
  }
  assert.equal(await fs.readFile(path.join(f.outside, 'human-note.txt'), 'utf8'), 'OUTSIDE_SENTINEL_MUST_NOT_BE_READ');
  await assert.rejects(fs.stat(path.join(f.outside, 'new.txt')), { code: 'ENOENT' });
});

test('actual OmO six-read batch records five successes and one blocked path, then corrects only to the authorized root', { skip: !enabled }, async (t) => {
  const f = await fixture(t); let calls = 0;
  const outcome = await runOmoNativeRpcRole({ ...f.options, runModelDecision: async (request) => {
    calls++;
    if (calls === 1) return decision(read(path.join(f.workspace, 'README.md')), read(path.join(f.workspace, 'summary.mjs')), read(path.join(f.workspace, 'items.json')),
      read(path.join(f.outside, 'human-note.txt')), read(path.join(f.workspace, 'test.mjs')), read(path.join(f.context, 'functional-checks.json')));
    if (calls === 2) {
      const seen = results(request); assert.equal(seen.length, 6); assert.equal(seen.filter((x) => !x.isError).length, 5);
      assert.match(body(seen.find((x) => x.isError)), /^\[OMO_WORKSPACE_PATH_BLOCKED\]/u);
      assert.ok(seen.every((x) => !body(x).includes('OUTSIDE_SENTINEL_MUST_NOT_BE_READ')));
      return decision(read(path.join(f.workspace, 'human-note.txt')));
    }
    assert.equal(calls, 3); assert.equal(body(results(request).at(-1)), 'Authorized human-note.txt');
    return decision(text('Controlled corrected read complete.'));
  } });
  assert.equal(outcome.status, 'model_returned'); assert.equal(outcome.providerDecisionRequests, 3);
  assert.equal(outcome.toolReceiptSummary.complete, true);
  assert.equal(f.receipts.filter((r) => r.eventType === 'end').length, 7);
  assert.equal(f.receipts.filter((r) => r.eventType === 'end' && r.isError).length, 1);
  assert.equal(await fs.readFile(path.join(f.outside, 'human-note.txt'), 'utf8'), 'OUTSIDE_SENTINEL_MUST_NOT_BE_READ');
});

test('actual OmO stops at three mixed missing/blocked read failures, before any fourth decision', { skip: !enabled }, async (t) => {
  const f = await fixture(t); let calls = 0;
  await assert.rejects(runOmoNativeRpcRole({ ...f.options, runModelDecision: async () => {
    calls++; assert.ok(calls <= 3);
    return decision(read(calls === 2 ? 'absent-local.txt' : path.join(f.outside, `denied-${calls}.txt`)));
  } }), /three consecutive missing read-only paths/u);
  assert.equal(calls, 3); assert.equal(f.receipts.filter((r) => r.eventType === 'end' && r.isError).length, 3);
});

test('blocked error counter shares the existing successful-tool progress reset', () => {
  const error = (tag) => ({ role: 'toolResult', isError: true, content: [text(`[${tag}] retained failure`)] });
  assert.equal(missingReadErrorsSinceProgress([error('OMO_WORKSPACE_PATH_BLOCKED'), error('OMO_WORKSPACE_PATH_NOT_FOUND')]), 2);
  assert.equal(missingReadErrorsSinceProgress([error('OMO_WORKSPACE_PATH_BLOCKED'), { role: 'toolResult', isError: false, content: [text('actual progress')] }, error('OMO_WORKSPACE_PATH_BLOCKED')]), 1);
});
