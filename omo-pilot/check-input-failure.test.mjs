import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ConversationStore, fileIndex } from './conversation-store.mjs';
import { validateBehaviorCase } from './conversation-checks.mjs';

const documentCase = { caseId: 'content', requirement: '检查合成文稿内容', kind: 'document', target: 'report.txt', expected: { includes: ['present'] } };
const invalidHtml = { ...documentCase, target: 'index.html' };
const final = { content: [{ type: 'text', text: 'Synthetic task result.' }] };
const check = (specification) => ({ content: [{ type: 'toolCall', name: 'verify_behavior', arguments: { caseJson: typeof specification === 'string' ? specification : JSON.stringify(specification) } }] });
const read = { content: [{ type: 'toolCall', name: 'read', arguments: { path: 'report.txt' } }] };

async function fixture(t, decisions, { cancelledChecks = false } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-check-input-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let modelCalls = 0, checkCalls = 0;
  const errors = [], results = [];
  const store = new ConversationStore({ runtimeDir: root, catalogueReader: async () => ({ models: [] }),
    modelRunner: async () => {
      assert.ok(modelCalls < decisions.length, 'synthetic model decision limit');
      return { status: 'model_returned', output: { text: JSON.stringify(decisions[modelCalls++]) } };
    },
    omoRunner: async options => {
      for (let ordinal = 1; ordinal <= decisions.length; ordinal++) {
        const text = await options.runModelDecision({ tools: [], messages: [] }, ordinal, options.signal);
        const call = JSON.parse(text).content.find(item => item.type === 'toolCall');
        if (!call) return { status: 'model_returned', sessionId: 'synthetic-check-input', output: { text } };
        if (call.name === 'read') { await fs.readFile(path.join(options.cwd, 'report.txt')); continue; }
        assert.equal(call.name, 'verify_behavior');
        const controller = new AbortController();
        if (cancelledChecks) controller.abort();
        try { results.push(await options.onBehaviorCheck({ requestId: `request-${++checkCalls}`, ...call.arguments }, cancelledChecks ? controller.signal : options.signal)); }
        catch (error) { errors.push(error.message); }
      }
      throw new Error('synthetic tool loop limit');
    } });
  await store.init();
  const conversation = await store.create({ requestId: 'synthetic-check-input' });
  const workspace = path.join(root, 'project'); await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, 'report.txt'), 'present');
  const before = await fileIndex(workspace);
  const turn = { id: 'synthetic-check-input', text: '检查合成内容', intent: 'execute', status: 'working', before, workspace, calls: [], receipts: [], processes: [], events: [] };
  conversation.turns.push(turn);
  return { store, turn, workspace, before, errors, results, modelCalls: () => modelCalls, checkCalls: () => checkCalls,
    run: () => store.role(conversation, turn, 'Developer', 'Synthetic test. No external model or network.', workspace, [], new AbortController().signal) };
}

test('HTML document checks name the unsupported target and route to actual web behavior', () => {
  assert.throws(() => validateBehaviorCase(invalidHtml), /document.*md.*txt.*csv.*tsv.*json.*yaml.*yml.*HTML.*web/s);
  assert.throws(() => validateBehaviorCase({ ...invalidHtml, expected: undefined }), /document.*HTML.*web/s);
});

test('document content diagnostics name expected.includes and supported cases remain accepted', () => {
  assert.throws(() => validateBehaviorCase({ ...documentCase, expected: { includes: [] } }), /expected\.includes/);
  for (const extension of ['md', 'txt', 'csv', 'tsv', 'json', 'yaml', 'yml']) {
    const spec = { ...documentCase, target: `report.${extension}` };
    assert.equal(validateBehaviorCase(spec), spec);
  }
  const web = { caseId: 'page', requirement: '真实页面显示内容', kind: 'web', target: 'index.html', actions: [{ action: 'assert', selector: '#result', textIncludes: 'present' }] };
  assert.equal(validateBehaviorCase(web), web);
});

test('three rejected checks stop before a fourth model call and preserve workspace and failures', async t => {
  const f = await fixture(t, [check(invalidHtml), check('{'), check({ ...documentCase, expected: {} }), final]);
  await assert.rejects(f.run(), /检查请求连续三次未能开始/);
  assert.equal(f.modelCalls(), 3); assert.equal(f.checkCalls(), 3); assert.equal(f.errors.length, 3);
  assert.deepEqual(await fileIndex(f.workspace), f.before); assert.deepEqual(f.turn.functionalChecks || [], []);
});

test('unrelated reads do not reset rejected-check count', async t => {
  const f = await fixture(t, [check(invalidHtml), read, check('{'), read, check(invalidHtml), final]);
  await assert.rejects(f.run(), /检查请求连续三次未能开始/);
  assert.equal(f.modelCalls(), 5); assert.equal(f.errors.length, 3);
});

test('an executed check resets the count even when its business expectation fails', async t => {
  const failed = { ...documentCase, expected: { includes: ['absent expected content'] } };
  const f = await fixture(t, [check(invalidHtml), check('{'), check(failed), check(invalidHtml), check('{'), final]);
  assert.deepEqual(JSON.parse(await f.run()), final);
  assert.equal(f.modelCalls(), 6); assert.equal(f.errors.length, 4);
  assert.equal(f.results.length, 1); assert.equal(f.results[0].status, 'failed');
  assert.equal(f.turn.functionalChecks.length, 1); assert.equal(f.turn.functionalChecks[0].status, 'failed');
});

test('cancelled checks do not consume the invalid-input allowance', async t => {
  const f = await fixture(t, [check(documentCase), check(documentCase), check(documentCase), final], { cancelledChecks: true });
  assert.deepEqual(JSON.parse(await f.run()), final);
  assert.equal(f.modelCalls(), 4); assert.equal(f.errors.length, 3); assert.ok(f.errors.every(error => error.includes('已停止')));
});

test('a new role invocation starts a fresh allowance', async t => {
  const f = await fixture(t, [check(invalidHtml), check('{'), final, check(invalidHtml), check('{'), final]);
  assert.deepEqual(JSON.parse(await f.run()), final);
  assert.deepEqual(JSON.parse(await f.run()), final);
  assert.equal(f.modelCalls(), 6); assert.equal(f.errors.length, 4);
});
