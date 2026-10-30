import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConversationStore, confusesDecisionHostWithTools, writeReviewGaps } from './conversation-store.mjs';
import { snapshotMemory, effectiveMemories } from './conversation-memory.mjs';
import { shouldStopForNoProgressToolDecision } from './native-rpc-runner.mjs';

test('parsed decisions preserve malformed-input, tool-call and review-gap distinctions', () => {
  assert.equal(confusesDecisionHostWithTools(undefined), false);
  assert.deepEqual(writeReviewGaps(undefined, [], { changed: true, changedFiles: ['main.js'] }), []);
  assert.throws(() => confusesDecisionHostWithTools(null), TypeError);
  assert.throws(() => writeReviewGaps(null, []), TypeError);
  const tool = { content: [{ type: 'toolCall', name: 'write', arguments: {} }] };
  assert.equal(confusesDecisionHostWithTools(tool), false);
  assert.deepEqual(writeReviewGaps(tool, [], { changed: true }), []);
  assert.deepEqual(writeReviewGaps({ content: [] }, [], { changed: true }).map((g) => g.reason), ['missing_behavior_checks']);
});

test('provider boundary parses each response once and retains malformed-route correction', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-simplify-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ConversationStore({ runtimeDir: root, catalogueReader: async () => ({ models: [] }),
    omoRunner: async (o) => ({ status: 'model_returned', sessionId: 'synthetic-no-model', output: { text: await o.runModelDecision({ tools: [], messages: [] }, 1, o.signal) } }) });
  await store.init(); const c = await store.create({ requestId: 'fixture', colleagueId: 'writer' });
  const workspace = path.join(root, 'project'); await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, 'changed.js'), '// synthetic changed file');
  const tool = JSON.stringify({ content: [{ type: 'toolCall', name: 'read', arguments: { path: 'changed.js' } }] });
  const route = JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ mode: 'discuss', reply: 'synthetic' }) }] });
  for (const { outputs, role, decisionOnly, corrections } of [
    { outputs: [tool], role: 'Developer', decisionOnly: false, corrections: [] },
    { outputs: ['{'], role: 'Developer', decisionOnly: false, corrections: [] },
    { outputs: ['{', route], role: 'Chat', decisionOnly: true, corrections: ['invalid_route_format'] },
  ]) {
    const turn = { id: `fixture-${c.turns.length}`, text: 'synthetic fixture', before: {}, calls: [], processes: [], receipts: [], events: [] };
    c.turns.push(turn); let calls = 0, parses = 0;
    store.modelRunner = async () => ({ status: 'model_returned', output: { text: outputs[calls++] } });
    const parse = JSON.parse;
    JSON.parse = (value, ...args) => { if (outputs.includes(value)) parses++; return parse(value, ...args); };
    let result;
    try { result = await store.role(c, turn, role, 'synthetic, no model', workspace, [], new AbortController().signal, decisionOnly); }
    finally { JSON.parse = parse; }
    assert.equal(result, outputs.at(-1)); assert.equal(calls, outputs.length); assert.equal(parses, outputs.length);
    assert.deepEqual((turn.hostCorrections || []).map((r) => r.reason), corrections);
  }
});

test('invalid behavior cases fail before registration, persistence or workspace access', async () => {
  const store = Object.create(ConversationStore.prototype); let saves = 0;
  store.save = async () => { saves++; };
  for (const caseJson of ['{', '{}', JSON.stringify({ caseId: 'bad', requirement: 'fixture', kind: 'document', target: '../outside.txt', expected: { includes: ['x'] } }),
    JSON.stringify({ caseId: 'bad', requirement: 'fixture', kind: 'web', target: 'index.html', actions: [{ action: 'click', selector: 'button' }] })]) {
    const turn = { functionalChecks: [], processes: [] };
    await assert.rejects(store.performBehaviorCheck(turn, { requestId: 'bad', caseJson }, '/nonexistent-simplification-fixture', new AbortController().signal), /JSON|检查/);
    assert.deepEqual(turn.functionalChecks, []); assert.deepEqual(turn.processes, []); assert.equal(saves, 0);
  }
});

test('0, 1 and 10 synthetic memories validate once with unchanged selection', () => {
  for (const count of [0, 1, 10]) for (const fn of [snapshotMemory, effectiveMemories]) {
    let validations = 0;
    const entries = Array.from({ length: count }, (_, i) => ({ id: String(i), key: String(i), kind: 'preference', scopeType: 'personal', status: 'active', sequence: i }));
    const memory = new Proxy({ version: 1, revision: 0, entries, tombstones: [], requests: {} }, { get(o, key) { if (key === 'version') validations++; return o[key]; } });
    const result = fn({ memory }, { id: 'fixture', projectId: 'project' }, new Set(), '2026-10-29');
    assert.deepEqual(result, fn === snapshotMemory ? {} : entries); assert.equal(validations, 1);
  }
});

test('no-progress decisions keep false on malformed history or output', () => {
  const operation = JSON.stringify({ name: 'read', arguments: { path: 'a' } });
  const decision = (file) => JSON.stringify({ content: [{ type: 'toolCall', name: 'read', arguments: { path: file } }] });
  for (const [operations, text, expected] of [
    [[operation, operation, operation], decision('a'), true], [[operation, operation, operation], decision('b'), false],
    [[operation, operation, operation], '{', false], [['{', '{', '{'], decision('a'), false],
    [[operation], decision('a'), false], [[operation, operation, operation], JSON.stringify({ content: [{ type: 'text', text: 'done' }] }), false],
  ]) assert.equal(shouldStopForNoProgressToolDecision(operations, text), expected);
});
