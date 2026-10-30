import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ConversationStore, fileIndex, needsWriteReview, writeReviewGaps } from './conversation-store.mjs';
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const response = JSON.stringify({ content: [{ type: 'text', text: 'done' }] });
const review = { verdict: 'pass', findings: [] };
const selection = { provider: 'desktop-codex', model: 'gpt-6-luna', effort: 'medium' };
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'noobi-scope-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ConversationStore({ runtimeDir: root, omoRunner: () => { throw new Error('No models'); } });
  await store.init(); const c = await store.create({ requestId: 'scope' });
  const original = path.join(root, 'original'), workspace = path.join(root, 'workspace'); await fs.mkdir(original); await fs.mkdir(workspace);
  await store.bindProject(c.id, { requestId: 'project', path: original });
  const turn = { id: 'scope-turn', intent: 'execute', status: 'working', projectId: c.projectId, workspace, modelSelection: selection, processes: [], receipts: [], events: [], calls: [] };
  c.turns.push(turn); const controller = new AbortController();
  const run = () => store.runNoobi(c, turn, { requestId: 'scope-job', name: 'Controlled fake boundary', prompt: 'No product or model acceptance' }, workspace, controller.signal);
  store.noobiRunner = async (options) => {
    await fs.mkdir(path.join(workspace, 'dist'), { recursive: true }); await fs.mkdir(path.join(workspace, 'tmp'), { recursive: true });
    await fs.writeFile(path.join(workspace, 'dist/index.html'), '<h1>controlled boundary</h1>');
    await fs.writeFile(path.join(workspace, 'tmp/check.py'), 'print("fixture support record")');
    const index = await fileIndex(workspace);
    return { status: 'completed', jobId: options.jobId, projectId: options.projectId, modelSelection: selection, entrypoint: 'dist/index.html',
      result: { review }, verification: { ok: true, build: { ok: true }, visual: { ok: true }, image: { ok: true }, playtest: { verdict: 'pass' }, checkedFiles: { 'dist/index.html': index['dist/index.html'] } } };
  };
  return { root, store, c, turn, controller, run };
}
function options(check) { return { changed: true, changedFiles: Object.keys(check.sourceIndex), version: check.version, checks: [check] }; }

test('new tmp runtime modules and verification scripts stay unverified until there is actual coverage', async (t) => {
  const f = await fixture(t), runner = f.store.noobiRunner;
  f.store.noobiRunner = async (o) => {
    const result = await runner(o);
    await fs.writeFile(path.join(f.turn.workspace, 'dist/index.html'), '<button>Next</button><script>document.querySelector("button").onclick=()=>import("../tmp/runtime.js").then(m=>m.play())</script>');
    await fs.writeFile(path.join(f.turn.workspace, 'tmp/runtime.js'), 'export function play(){throw new Error("UNTESTED_GAME_BRANCH")}');
    result.verification.checkedFiles['dist/index.html'] = sha(await fs.readFile(path.join(f.turn.workspace, 'dist/index.html'))); return result;
  };
  await f.run(); const check = f.turn.functionalChecks[0];
  assert.equal(check.auxiliaryFiles, undefined); assert.equal(check.auxiliaryProvenance, undefined);
  assert.deepEqual(writeReviewGaps(JSON.parse(response), [], options(check)), [
    { reason: 'file_not_exercised', file: 'tmp/check.py' }, { reason: 'file_not_exercised', file: 'tmp/runtime.js' },
  ]);
  assert.equal(needsWriteReview(JSON.parse(response), [], options(check)), true);
});

test('old snapshots, unrelated code and later edits cannot acquire a helper exemption', async (t) => {
  const f = await fixture(t); await fs.writeFile(path.join(f.turn.workspace, 'unrelated.py'), 'unverified'); await f.run();
  const check = f.turn.functionalChecks[0];
  check.auxiliaryFiles = { ...check.sourceIndex }; check.auxiliaryProvenance = { kind: 'noobi-new-scratch-v1', jobId: check.jobId };
  assert.deepEqual(writeReviewGaps(JSON.parse(response), [], options(check)).map((g) => g.file), ['tmp/check.py', 'unrelated.py']);
  for (const patch of [{ status: 'failed' }, { status: 'stopped' }, { version: 'old' }]) {
    assert.equal(needsWriteReview(JSON.parse(response), [], { ...options(check), checks: [{ ...check, ...patch }] }), true);
  }
  await fs.writeFile(path.join(f.turn.workspace, 'tmp/check.py'), 'later modification');
  assert.ok(writeReviewGaps(JSON.parse(response), [], { ...options(check), version: sha(JSON.stringify(await fileIndex(f.turn.workspace))) }).some((g) => g.reason === 'stale_check'));
});

test('retaining a confirmed helper outside the deliverable does not silently revalidate stale checks', async (t) => {
  const f = await fixture(t); await f.run(); const check = f.turn.functionalChecks[0];
  const source = path.join(f.turn.workspace, 'tmp/check.py'), retained = path.join(f.root, 'retained-check.py');
  const bytes = await fs.readFile(source); await fs.copyFile(source, retained); await fs.unlink(source);
  assert.deepEqual(await fs.readFile(retained), bytes);
  const after = await fileIndex(f.turn.workspace), version = sha(JSON.stringify(after));
  const opts = { changed: true, changedFiles: Object.keys(after), version, checks: [check] };
  assert.deepEqual(writeReviewGaps(JSON.parse(response), [], opts), [{ reason: 'stale_check', caseId: check.caseId }]);
  // Explicitly controlled new current-version check, not browser/model proof.
  const fresh = { ...check, version, sourceIndex: after }; assert.equal(needsWriteReview(JSON.parse(response), [], { ...opts, checks: [fresh] }), false);
});

test('actual Store correction supplies exact missing files and a bounded safe recovery path', async (t) => {
  const f = await fixture(t); await f.run(); f.turn.before = {}; f.turn.text = 'controlled correction';
  await fs.mkdir(path.join(f.store.root, 'context', f.turn.id), { recursive: true });
  const prompts = [];
  f.store.modelRunner = async (o) => {
    prompts.push(o.prompt);
    return { status: 'model_returned', output: { text: prompts.length === 1 ? response : JSON.stringify({ content: [{ type: 'toolCall', name: 'read', arguments: { path: 'tmp/check.py' } }] }) } };
  };
  f.store.omoRunner = async (o) => ({ status: 'model_returned', sessionId: 'controlled-no-model', output: { text: await o.runModelDecision({ tools: [], messages: [] }, 1, o.signal) } });
  await f.store.role(f.c, f.turn, 'Developer', 'Controlled local boundary only.', f.turn.workspace, [], f.controller.signal);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /Exact current gaps:.*file_not_exercised.*tmp\/check\.py/);
  assert.match(prompts[1], /do not repeat a passed game merely because unrelated scripts lack coverage/);
  assert.match(prompts[1], /If its purpose is unclear, keep it/);
  assert.deepEqual(f.turn.hostCorrections[0].gaps, [{ reason: 'file_not_exercised', file: 'tmp/check.py' }]);
  assert.equal(await fs.readFile(path.join(f.turn.workspace, 'tmp/check.py'), 'utf8'), 'print("fixture support record")');
});
