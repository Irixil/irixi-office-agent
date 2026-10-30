import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { guardWorkspaceToolCalls } from './codex-provider-protocol.mjs';
import { runOmoNativeRpcRole } from './native-rpc-runner.mjs';

const call = (name, args) => ({ type: 'toolCall', name, arguments: args });
const memory = (operation) => call('memory_manage', { operationJson: JSON.stringify({ operation }) });
const read = () => call('read', { path: 'history.txt' });
const decision = (...content) => ({ content });
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-memory-list-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'history.txt'), 'Synthetic prior statement; current memory is disabled.');
  return { root, options: { role: 'Chat', rootPath: root, conversation: true } };
}

test('memory list may accompany real read-only tools in either conversation role', async t => {
  const f = await fixture(t);
  for (const role of ['Chat', 'Developer']) await guardWorkspaceToolCalls(decision(memory('list'), read(),
    call('grep', { path: '.', pattern: 'Synthetic' }), call('find', { path: '.', pattern: '*.txt' }), call('ls', { path: '.' })), { ...f.options, role });
});

test('memory writes and file/command work remain single-tool decisions', async t => {
  const f = await fixture(t);
  for (const operation of ['create', 'edit', 'deactivate', 'restore', 'delete', 'unknown']) {
    await assert.rejects(guardWorkspaceToolCalls(decision(memory(operation), read()), f.options), /one tool at a time/);
    await assert.rejects(guardWorkspaceToolCalls(decision(memory('list'), memory(operation)), f.options), /one tool at a time/);
  }
  for (const name of ['write', 'edit', 'bash', 'verify_behavior', 'delegate_readonly', 'delegate_parallel', 'noobi_run']) {
    await assert.rejects(guardWorkspaceToolCalls(decision(memory('list'), call(name, {})), { ...f.options, role: 'Developer' }), /one tool at a time/);
  }
});

test('memory list does not bypass malformed input, read paths, or child/non-conversation permissions', async t => {
  const f = await fixture(t);
  for (const value of ['{', 'null', '[]', '"list"', ' '.repeat(16001), null]) {
    await assert.rejects(guardWorkspaceToolCalls(decision(call('memory_manage', { operationJson: value }), read()), f.options), /Memory operation is invalid/);
  }
  await assert.rejects(guardWorkspaceToolCalls(decision(memory('list'), call('read', { path: '../outside.txt' })), f.options), /traversal/);
  await assert.rejects(guardWorkspaceToolCalls(decision(memory('list'), read()), { ...f.options, role: 'Developer', writeScope: ['history.txt'] }), /写入助手/);
  await assert.rejects(guardWorkspaceToolCalls(decision(memory('list'), read()), { ...f.options, conversation: false }), /allowlist/);
  await assert.rejects(guardWorkspaceToolCalls(decision(call('memory_manage', { operationJson: '{"operation":"list","operation":"delete"}' }), read()), f.options), /one tool at a time/);
});

// Real OmO/tool integration with scripted decisions and a synthetic memory boundary; zero model calls.
const enabled = process.env.IRIXI_RUN_NATIVE_TOOL_TESTS === '1';
test('actual OmO dispatches list with reads and returns disabled state to the same loop', { skip: !enabled }, async t => {
  const f = await fixture(t), receipts = []; let decisions = 0, lists = 0;
  const result = await runOmoNativeRpcRole({ role: 'Chat', cwd: f.root, conversation: true, timeoutMs: 30000,
    prompt: 'Controlled memory lookup test. Do not change memory or files.', onToolReceipt: r => receipts.push(r),
    onMemory: async request => { assert.equal(JSON.parse(request.operationJson).operation, 'list'); lists++; return { entries: [{ id: 'synthetic-rule', status: 'disabled', version: 3 }] }; },
    runModelDecision: async request => {
      decisions++;
      if (decisions === 1) return JSON.stringify(decision(memory('list'), read(), call('find', { path: '.', pattern: '*.txt' })));
      assert.equal(decisions, 2);
      const results = request.messages.filter(m => m.role === 'toolResult');
      assert.equal(results.length, 3); assert(results.every(r => r.isError !== true));
      assert.match(JSON.stringify(results), /disabled/); assert.match(JSON.stringify(results), /Synthetic prior statement/);
      return JSON.stringify(decision({ type: 'text', text: 'Current memory is disabled; prior history does not restore it.' }));
    } });
  assert.equal(result.status, 'model_returned'); assert.equal(lists, 1); assert.equal(decisions, 2);
  assert.equal(receipts.filter(r => r.eventType === 'end').length, 3);
  assert.equal(await fs.readFile(path.join(f.root, 'history.txt'), 'utf8'), 'Synthetic prior statement; current memory is disabled.');
});

test('actual OmO still blocks a mixed memory write before any tool executes', { skip: !enabled }, async t => {
  const f = await fixture(t), receipts = []; let writes = 0, decisions = 0;
  await assert.rejects(runOmoNativeRpcRole({ role: 'Chat', cwd: f.root, conversation: true, timeoutMs: 30000,
    prompt: 'Controlled forbidden batch test.', onToolReceipt: r => receipts.push(r),
    onMemory: async () => { writes++; throw Error('Must not execute'); },
    runModelDecision: async () => { decisions++; return JSON.stringify(decision(memory('create'), read())); },
  }), /one tool at a time/);
  assert.equal(decisions, 1); assert.equal(writes, 0); assert.equal(receipts.length, 0);
});
