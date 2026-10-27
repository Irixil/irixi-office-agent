import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runOmoNativeRpcRole } from './native-rpc-runner.mjs';

// Opt-in local integration: real OmO and file tools, scripted decisions only.
// No Codex CLI/model adapter is imported or called by the decision callback.
const enabled = process.env.IRIXI_RUN_NATIVE_TOOL_TESTS === '1';
const read = (name) => ({ type: 'toolCall', name: 'read', arguments: { path: name } });
const decision = (...content) => JSON.stringify({ content });
const text = (value) => ({ type: 'text', text: value });
const results = (request) => request.messages.filter((message) => message.role === 'toolResult');
const resultText = (message) => message.content.filter((item) => item.type === 'text').map((item) => item.text).join('\n');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-native-read-recovery-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.irixi-materials'));
  const materials = ['Synthetic source one: 12 items.', 'Synthetic source two: owner remains unconfirmed.'];
  for (let i = 0; i < materials.length; i++) await fs.writeFile(path.join(root, `.irixi-materials/${i + 1}.txt`), materials[i]);
  const receipts = [];
  return { root, materials, receipts, options: { role: 'Lead', cwd: root,
    prompt: 'Local scripted test: read the two supplied synthetic materials before a plan.', timeoutMs: 30_000,
    allowedWritePaths: [], stopOnIdenticalDecision: true, onToolReceipt: (item) => receipts.push(item) } };
}

test('actual OmO returns missing-path failure to the same loop, then reads both exact sources', { skip: !enabled }, async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const outcome = await runOmoNativeRpcRole({ ...f.options, runModelDecision: async (request) => {
    calls += 1;
    if (calls === 1) return decision(read('.irixi-materials/2.txtHACK?'));
    if (calls === 2) {
      const failed = results(request).at(-1);
      assert.equal(failed.isError, true);
      assert.match(resultText(failed), /^\[OMO_WORKSPACE_PATH_NOT_FOUND\]/u);
      assert.match(resultText(failed), /2\.txtHACK\?/u);
      return decision(read('.irixi-materials/1.txt'), read('.irixi-materials/2.txt'));
    }
    assert.equal(calls, 3, 'no unbounded or paid decision fallback');
    const successful = results(request).filter((item) => !item.isError);
    assert.deepEqual(successful.map(resultText), f.materials);
    return decision(text('Plan ready after actual reads of both synthetic materials.'));
  } });
  assert.equal(outcome.status, 'model_returned');
  assert.equal(outcome.providerDecisionRequests, 3);
  assert.equal(outcome.toolReceiptSummary.complete, true);
  const ends = f.receipts.filter((item) => item.eventType === 'end');
  assert.equal(ends.length, 3);
  assert.equal(ends.filter((item) => item.isError).length, 1, 'original failure receipt remains');
  for (let i = 0; i < f.materials.length; i++) assert.equal(await fs.readFile(path.join(f.root, `.irixi-materials/${i + 1}.txt`), 'utf8'), f.materials[i]);
});

test('actual OmO stops before a fourth decision after three different missing paths', { skip: !enabled }, async (t) => {
  const f = await fixture(t);
  let calls = 0;
  await assert.rejects(runOmoNativeRpcRole({ ...f.options, runModelDecision: async () => {
    calls += 1;
    assert.ok(calls <= 3, 'the failed-path limit stops before another model request');
    return decision(read(`.irixi-materials/not-present-${calls}.txt`));
  } }), /three consecutive missing read-only paths/u);
  assert.equal(calls, 3);
  assert.equal(f.receipts.filter((item) => item.eventType === 'end' && item.isError).length, 3);
});

test('actual OmO preflight still rejects unsafe siblings before dispatching a missing read', { skip: !enabled }, async (t) => {
  const f = await fixture(t);
  let calls = 0;
  await assert.rejects(runOmoNativeRpcRole({ ...f.options, runModelDecision: async () => {
    calls += 1;
    return decision(read('.irixi-materials/not-present.txt'), read('../outside.txt'));
  } }), /traversal/u);
  assert.equal(calls, 1);
  assert.equal(f.receipts.length, 0, 'a mixed unsafe batch still fails before tools');
});

test('actual OmO rejects alias-shaped access and can read the explicit literal filename', { skip: !enabled }, async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, '@file.txt'), 'Exact literal source');
  await fs.writeFile(path.join(f.root, 'file.txt'), 'Different source: must never be substituted');
  await assert.rejects(runOmoNativeRpcRole({ ...f.options,
    runModelDecision: async () => decision(read('@file.txt')) }), /ambiguous native alias/u);
  assert.equal(f.receipts.length, 0);
  let calls = 0;
  await runOmoNativeRpcRole({ ...f.options, runModelDecision: async (request) => {
    calls += 1;
    if (calls === 1) return decision(read('./@file.txt'));
    assert.equal(calls, 2);
    assert.equal(resultText(results(request).at(-1)), 'Exact literal source');
    return decision(text('Exact source checked.'));
  } });
  assert.equal(calls, 2);
});
