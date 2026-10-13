#!/usr/bin/env node
// Focused zero-model regression for development35. It executes frozen app/core/
// p0-repair bytes with the real learning08 revision-16 record in a controlled
// VM/DOM. It never calls a model, browser, product API, or service.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { executeNativeApp } from './native-client-vm-adapter.mjs';

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const KEY = 'irixi.article-learning-12.session.v1';
const args = process.argv.slice(2);
const arg = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : null; };
const workspace = path.resolve(arg('--workspace') || '');
const evidenceFile = path.resolve(arg('--evidence') || '');
const mode = arg('--mode');
assert.ok(workspace && evidenceFile && ['baseline', 'candidate'].includes(mode),
  'Use --workspace frozen-source --mode baseline|candidate --evidence new-file.json');
const project = path.resolve(import.meta.dirname, '..');
const fixtureFile = path.join(project, 'backend/learning-08-original-retest-client-failure/actual-local-record.json');
const [app, core, repair, fixtureBytes] = await Promise.all([
  fs.readFile(path.join(workspace, 'app.js'), 'utf8'),
  fs.readFile(path.join(workspace, 'core.js'), 'utf8'),
  fs.readFile(path.join(workspace, 'p0-repair.js'), 'utf8'),
  fs.readFile(fixtureFile),
]);
const actualInvalid = JSON.parse(fixtureBytes);
const invalidTurn = actualInvalid.turns.at(-1);
const sourceTurnId = '3427b9ea-dc67-43ca-84f9-30429cc8d8ba';
assert.equal(invalidTurn.status, 'invalid');
assert.equal(invalidTurn.context?.questionSourceTurnId ?? null, null);
assert.equal(invalidTurn.requestBody?.payload?.learnerEntry?.questionSourceTurnId ?? null, null);

function element() {
  return { value: '', checked: false, disabled: false, hidden: false, readOnly: false, textContent: '', innerHTML: '', style: {}, dataset: {},
    classList: { toggle() {}, add() {}, remove() {} }, listeners: new Map(),
    addEventListener(type, fn) { const rows = this.listeners.get(type) || []; rows.push(fn); this.listeners.set(type, rows); },
    append() {}, querySelector() { return element(); } };
}
function contextFor(storage, saves, { runApp = false } = {}) {
  const requests = [];
  const elements = new Map();
  const get = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  class Storage {
    getItem(key) { return key === KEY ? storage.value : null; }
    setItem(key, value) { if (key === KEY) { JSON.parse(value); storage.value = value; saves.push(value); } }
    removeItem(key) { if (key === KEY) storage.value = null; }
  }
  const localStorage = new Storage();
  const reply = value => Promise.resolve(new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  const controlledFetch = async (input, init = {}) => {
    const url = new URL(String(input), 'http://controlled.invalid');
    requests.push({ path: url.pathname, method: init.method || 'GET' });
    if (url.pathname === '/api/irixi-authority') return reply({ goalVersionId: 'goal-current', artifact: { candidateSha256: 'candidate-current' } });
    if (url.pathname === '/api/irixi-intake') return reply({ modelAvailability: { learning: { enabled: false, sealed: true, running: false, remaining: 0, deadlineAt: null } } });
    throw new Error(`Controlled history harness forbids fetch ${url.pathname}`);
  };
  const document = { getElementById: get, querySelector(selector) { return selector.startsWith('#') ? get(selector.slice(1)) : element(); }, querySelectorAll() { return []; }, createElement: element, body: element(), dispatchEvent() { return true; } };
  const context = vm.createContext({ console, crypto: crypto.webcrypto, structuredClone, Storage, localStorage, document,
    fetch: controlledFetch, Response, URL, CustomEvent: class { constructor(type, detail) { this.type = type; this.detail = detail; } },
    MutationObserver: class { observe() {} disconnect() {} }, confirm: () => false, location: { reload() {} },
    setTimeout: (fn, ms, ...rest) => setTimeout(fn, Math.min(ms, 2), ...rest), clearTimeout });
  vm.runInContext(core, context, { filename: 'frozen-core.js' });
  vm.runInContext(repair, context, { filename: 'frozen-p0-repair.js' });
  if (runApp) executeNativeApp(context, app, 'frozen-app.js');
  context.__controlledRequests = requests;
  return context;
}
function canonical(value) { return JSON.stringify(value); }
function directSerialize(record) {
  const clone = structuredClone(record), storage = { value: canonical(record) }, saves = [];
  const context = contextFor(storage, saves); context.record = clone;
  vm.runInContext('JSON.stringify(record)', context);
  return { before: record, after: clone, storage, saves };
}
async function nativeRestore(record) {
  const storage = { value: canonical(record) }, saves = [];
  const context = contextFor(storage, saves, { runApp: true });
  await new Promise(resolve => setTimeout(resolve, 15));
  return { restored: JSON.parse(storage.value), state: structuredClone(vm.runInContext('state', context)), saves, requests: context.__controlledRequests };
}
function sourceFields(turn) {
  return { status: turn?.status ?? null, contextSource: turn?.context?.questionSourceTurnId ?? null,
    requestSource: turn?.requestBody?.payload?.learnerEntry?.questionSourceTurnId ?? null,
    bytes: Buffer.byteLength(canonical(turn)), sha256: sha(canonical(turn)) };
}
function activeRecord() {
  const record = structuredClone(actualInvalid), oldInvalid = structuredClone(record.turns.at(-1));
  const active = structuredClone(oldInvalid);
  active.turnId = 'controlled-current-submitting-turn'; active.requestBody.turnId = active.turnId; active.status = 'submitting';
  active.context.questionSourceTurnId = ''; active.requestBody.payload.learnerEntry.questionSourceTurnId = '';
  record.turns.push(active);
  return { record, oldInvalid };
}

const report = { schemaVersion: 1, recordedAt: new Date().toISOString(), mode,
  tier: 'Controlled VM/DOM execution of frozen app+core+p0-repair with the real learning08 revision-16 record; no browser, product API, service, or model',
  nativeModelCalls: 0, actualBrowser: false, productApiCalls: 0, serviceStarts: 0, businessSourceEdited: false,
  workspace, sourceHashes: { appJs: sha(app), coreJs: sha(core), p0RepairJs: sha(repair) },
  actualFixture: { file: path.relative(project, fixtureFile), bytes: fixtureBytes.length, sha256: sha(fixtureBytes) }, cases: [], limitations: [] };
const check = (id, passed, detail = {}) => report.cases.push({ id, passed: Boolean(passed), ...detail });
try {
  const invalidDirect = directSerialize(actualInvalid);
  check('invalid_direct_serialization_noop', canonical(invalidDirect.before) === canonical(invalidDirect.after),
    { before: sourceFields(invalidDirect.before.turns.at(-1)), after: sourceFields(invalidDirect.after.turns.at(-1)) });

  const invalidRestored = await nativeRestore(actualInvalid);
  check('invalid_native_app_restore_noop', canonical(invalidTurn) === canonical(invalidRestored.restored.turns.at(-1)) && canonical(invalidTurn) === canonical(invalidRestored.state.turns.at(-1)),
    { saveCount: invalidRestored.saves.length, requests: invalidRestored.requests, before: sourceFields(invalidTurn), restored: sourceFields(invalidRestored.restored.turns.at(-1)), state: sourceFields(invalidRestored.state.turns.at(-1)) });

  const doneClone = structuredClone(actualInvalid); doneClone.turns.at(-1).status = 'done';
  const doneDirect = directSerialize(doneClone);
  check('controlled_done_clone_serialization_noop', canonical(doneDirect.before) === canonical(doneDirect.after),
    { controlledCloneNotActualLearning08Completion: true, before: sourceFields(doneDirect.before.turns.at(-1)), after: sourceFields(doneDirect.after.turns.at(-1)) });
  const doneRestored = await nativeRestore(doneClone);
  check('controlled_done_clone_native_app_restore_noop', canonical(doneClone.turns.at(-1)) === canonical(doneRestored.restored.turns.at(-1))
      && canonical(doneClone.turns.at(-1)) === canonical(doneRestored.state.turns.at(-1)),
    { controlledCloneNotActualLearning08Completion: true, saveCount: doneRestored.saves.length, requests: doneRestored.requests,
      before: sourceFields(doneClone.turns.at(-1)), restored: sourceFields(doneRestored.restored.turns.at(-1)), state: sourceFields(doneRestored.state.turns.at(-1)) });

  const active = activeRecord(), activeSerialized = directSerialize(active.record);
  const activeAfter = activeSerialized.after, current = activeAfter.turns.at(-1), oldAfterSubmitting = activeAfter.turns.at(-2);
  check('current_submitting_turn_captures_source', current.turnId === current.requestBody.turnId
      && current.context.questionSourceTurnId === sourceTurnId && current.requestBody.payload.learnerEntry.questionSourceTurnId === sourceTurnId,
    { turnId: current.turnId, requestTurnId: current.requestBody.turnId, current: sourceFields(current) });
  check('submitting_capture_does_not_migrate_old_invalid', canonical(active.oldInvalid) === canonical(oldAfterSubmitting),
    { before: sourceFields(active.oldInvalid), after: sourceFields(oldAfterSubmitting) });

  current.status = 'running';
  const runningBefore = structuredClone(activeAfter), runningSerialized = directSerialize(activeAfter), running = runningSerialized.after;
  check('running_serialization_retains_exact_source', canonical(runningBefore) === canonical(running)
      && running.turns.at(-1).turnId === running.turns.at(-1).requestBody.turnId
      && running.turns.at(-1).context.questionSourceTurnId === sourceTurnId,
    { turnId: running.turns.at(-1).turnId, requestTurnId: running.turns.at(-1).requestBody.turnId,
      before: sourceFields(runningBefore.turns.at(-1)), after: sourceFields(running.turns.at(-1)) });
  check('running_serialization_does_not_migrate_old_invalid', canonical(active.oldInvalid) === canonical(running.turns.at(-2)),
    { before: sourceFields(active.oldInvalid), after: sourceFields(running.turns.at(-2)) });

  const recovered = await nativeRestore(running);
  const recoveredActive = recovered.restored.turns.find(turn => turn.turnId === current.turnId), recoveredHistorical = recovered.restored.turns.at(-2);
  check('running_native_restore_retains_source_without_repost_or_history_migration', recoveredActive?.context?.questionSourceTurnId === sourceTurnId
      && recoveredActive?.requestBody?.payload?.learnerEntry?.questionSourceTurnId === sourceTurnId
      && canonical(active.oldInvalid) === canonical(recoveredHistorical)
      && !recovered.requests.some(request => request.path === '/api/irixi-inference' && request.method === 'POST'),
    { saveCount: recovered.saves.length, requests: recovered.requests, active: sourceFields(recoveredActive), historicalInvalid: sourceFields(recoveredHistorical) });

  const noMigrationIds = ['invalid_direct_serialization_noop', 'invalid_native_app_restore_noop', 'controlled_done_clone_serialization_noop', 'controlled_done_clone_native_app_restore_noop',
    'submitting_capture_does_not_migrate_old_invalid', 'running_serialization_does_not_migrate_old_invalid', 'running_native_restore_retains_source_without_repost_or_history_migration'];
  const activeIds = ['current_submitting_turn_captures_source', 'running_serialization_retains_exact_source'];
  const noMigrationPassed = noMigrationIds.every(id => report.cases.find(entry => entry.id === id)?.passed);
  const activePassed = activeIds.every(id => report.cases.find(entry => entry.id === id)?.passed);
  report.productHistoryNoMigrationPassed = noMigrationPassed;
  report.activeLifecyclePassed = activePassed;
  if (mode === 'baseline') {
    report.expectedBaselineFailureReproduced = !report.cases.find(entry => entry.id === 'invalid_direct_serialization_noop')?.passed
      && !report.cases.find(entry => entry.id === 'invalid_native_app_restore_noop')?.passed
      && !report.cases.find(entry => entry.id === 'controlled_done_clone_serialization_noop')?.passed
      && !report.cases.find(entry => entry.id === 'controlled_done_clone_native_app_restore_noop')?.passed
      && activePassed;
    assert.equal(report.expectedBaselineFailureReproduced, true, 'Frozen development34 baseline did not reproduce the exact historical migration failure');
    report.passed = true;
  } else {
    report.passed = noMigrationPassed && activePassed && report.cases.every(entry => entry.passed);
    assert.equal(report.passed, true, 'Candidate did not close every fixed history no-migration gate');
  }
  report.companionGate = { file: 'tools/development34-retest-source-regression-zero-model.mjs', sha256: 'e7884fcb4f8a56ba88f18d843b7ba10ef538a2588f44a449df65fe3d3ce7b921', requiredCandidateCases: 14 };
  report.limitations.push('The done turn is a controlled clone used only to prove serialization no-op; it is not represented as an actual completed learning-08 result.');
  report.limitations.push('This is frozen JavaScript with actual learning08 JSON in a controlled VM/DOM, not a headed browser, product API, service, model, or human-learning result.');
} catch (error) {
  report.passed = false; report.error = { name: error.name, message: error.message, stack: error.stack };
}
report.finishedAt = new Date().toISOString();
await fs.writeFile(evidenceFile, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ passed: report.passed, mode, expectedBaselineFailureReproduced: report.expectedBaselineFailureReproduced ?? null,
  productHistoryNoMigrationPassed: report.productHistoryNoMigrationPassed, activeLifecyclePassed: report.activeLifecyclePassed,
  cases: report.cases.map(({ id, passed }) => ({ id, passed })), evidenceFile, nativeModelCalls: 0 }));
if (!report.passed) process.exitCode = 1;
