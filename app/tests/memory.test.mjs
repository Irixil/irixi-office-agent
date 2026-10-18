import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createStore, createTask, event } from '../core.mjs';
import { createMemoryService, createXerjMemoryIndex, memoryNamespace } from '../memory.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-memory-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = createStore(root); await store.init();
  const task = createTask({ goal: 'Test explicit memory persistence' }); await store.save(task);
  const documents = new Map();
  const index = {
    async available() { return true; },
    async upsert(entry) { documents.set(`${memoryNamespace(entry.scopeType, entry.scopeId)}:${entry.id}`, { ...structuredClone(entry), metadata: { revision: entry.revision, status: entry.status, scopeType: entry.scopeType, scopeId: entry.scopeId, scopeFingerprint: entry.scopeFingerprint || null, ownerTaskId: entry.ownerTaskId } }); },
    async remove(entry) { documents.delete(`${memoryNamespace(entry.scopeType, entry.scopeId)}:${entry.id}`); },
    async recall(scopeType, scopeId) { return { hits: [...documents.values()].filter((item) => item.scopeType === scopeType && item.scopeId === scopeId).map((item) => ({ id: item.id, metadata: item.metadata, score: 1 })) }; },
  };
  return { root, store, task, index, create: (nextStore = store) => createMemoryService({ store: nextStore, index, emit: event }) };
}

const project = { projectId: 'article-learning-12', scopeFingerprint: 'a'.repeat(64) };

test('explicit memories persist with source, revision, and active scope after store reload', async (t) => {
  const f = await fixture(t);
  const service = f.create();
  const saved = await service.save(f.task.id, { scopeType: 'global', kind: 'preference', title: 'Writing preference', text: 'Use concise Chinese.' });
  assert.equal(saved.memory.source.type, 'explicit_user_action');
  assert.equal(saved.memory.revision, 1);
  const reloaded = f.create(createStore(f.root)); await reloaded.list(f.task.id);
  const found = await reloaded.retrieve(f.task.id, 'concise', project);
  assert.equal(found.memories[0].text, 'Use concise Chinese.');
  assert.equal(found.memories[0].source.eventId, saved.memory.source.eventId);
});

test('explicit Chinese preference is directly applicable when lexical recall has no matching words', async (t) => {
  const f = await fixture(t);
  const service = f.create();
  const saved = await service.save(f.task.id, { scopeType: 'global', kind: 'preference', title: '回答风格', text: '回答先给结论，用简短中文。' });
  f.index.recall = async () => ({ hits: [] });

  const found = await service.retrieve(f.task.id, '整理这个项目的下一步计划', project);
  assert.equal(found.memories.length, 1);
  assert.equal(found.memories[0].id, saved.memory.id);
  assert.equal(found.memories[0].application, 'direct_explicit_preference');
  assert.equal(found.directCount, 1);
  assert.equal(found.relatedCount, 0);
});

test('correction and deactivation reject stale index revisions and do not revive old entries', async (t) => {
  const f = await fixture(t);
  const service = f.create();
  const saved = await service.save(f.task.id, { scopeType: 'project', kind: 'convention', title: 'Naming', text: 'Use snake_case.' }, project);
  const oldHit = { id: saved.memory.id, metadata: { ownerTaskId: f.task.id, revision: 1, status: 'active', scopeType: 'project', scopeId: project.projectId, scopeFingerprint: project.scopeFingerprint } };
  const originalRecall = f.index.recall;
  f.index.recall = async () => ({ hits: [oldHit] });
  const corrected = await service.change(f.task.id, saved.memory.id, { operation: 'correct', expectedRevision: 1, kind: 'convention', title: 'Naming', text: 'Use kebab-case.' }, project);
  assert.equal(corrected.memory.revision, 2);
  const afterCorrection = await service.retrieve(f.task.id, 'naming', project);
  assert.equal(afterCorrection.memories.length, 1);
  assert.equal(afterCorrection.memories[0].revision, 2);
  assert.equal(afterCorrection.memories[0].text, 'Use kebab-case.');
  assert.equal(afterCorrection.memories[0].application, 'direct_project_convention');
  f.index.recall = originalRecall;
  const current = await service.retrieve(f.task.id, 'naming', project);
  assert.equal(current.memories[0].revision, 2);
  assert.equal(current.memories[0].text, 'Use kebab-case.');
  const inactive = await service.change(f.task.id, saved.memory.id, { operation: 'deactivate', expectedRevision: 2 }, project);
  assert.equal(inactive.memory.status, 'deactivated');
  assert.equal((await service.retrieve(f.task.id, 'naming', project)).memories.length, 0);
  await assert.rejects(service.change(f.task.id, saved.memory.id, { operation: 'correct', expectedRevision: 2, kind: 'convention', title: 'Stale', text: 'Must not revive.' }, project), /stale/);
});

test('project memory is invisible without the exact authorized project scope; missing XERJ degrades only when needed', async (t) => {
  const f = await fixture(t);
  const service = f.create();
  await service.save(f.task.id, { scopeType: 'project', kind: 'convention', title: 'Private project', text: 'Current project only.' }, project);
  assert.equal((await service.list(f.task.id)).length, 0);
  assert.equal((await service.list(f.task.id, { ...project, scopeFingerprint: 'b'.repeat(64) })).length, 0);
  const unavailable = createMemoryService({ store: f.store, emit: event, index: { async available() { return false; } } });
  const degraded = await unavailable.retrieve(f.task.id, 'anything', project);
  assert.equal(degraded.degraded, true);
  assert.equal(degraded.memories.length, 1);
  assert.equal(degraded.memories[0].application, 'direct_project_convention');
  assert.equal(degraded.relatedCount, 0);
});

test('global memories from earlier tasks can be corrected from a later task without trusting a client owner id', async (t) => {
  const f = await fixture(t);
  const earlier = f.task;
  const later = createTask({ goal: 'A separate task can manage explicit global preferences.' }); await f.store.save(later);
  const service = f.create();
  const saved = await service.save(earlier.id, { scopeType: 'global', kind: 'preference', title: 'Tone', text: 'Use a formal tone.' });
  const listed = await service.list(later.id);
  assert.equal(listed[0].ownerTaskId, earlier.id);
  const changed = await service.change(later.id, saved.memory.id, { operation: 'correct', expectedRevision: 1, kind: 'preference', title: 'Tone', text: 'Use plain language.' });
  assert.equal(changed.memory.ownerTaskId, earlier.id);
  const reloaded = await f.create(createStore(f.root)).list(later.id);
  assert.equal(reloaded[0].revision, 2);
  assert.equal(reloaded[0].source.taskId, earlier.id);
  assert.equal(reloaded[0].text, 'Use plain language.');
});

test('memory save and a concurrent native-result write serialize through the same TaskStore writer', async (t) => {
  const f = await fixture(t);
  const service = f.create();
  const nativeResult = f.store.mutate(f.task.id, async (task) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    event(task, 'integration.product_native_result_received', 'A native model result was committed.', { callId: 'call-fixture' });
  });
  const memoryWrite = service.save(f.task.id, { scopeType: 'global', kind: 'preference', title: 'Response style', text: 'Show sources.' });
  const [, saved] = await Promise.all([nativeResult, memoryWrite]);
  const reloaded = await createStore(f.root).get(f.task.id);
  assert.ok(reloaded.events.some((item) => item.type === 'integration.product_native_result_received' && item.detail.callId === 'call-fixture'));
  assert.ok(reloaded.events.some((item) => item.type === 'memory.explicitly_saved' && item.detail.memoryId === saved.memory.id));
  assert.equal(reloaded.memoryEntries.find((item) => item.id === saved.memory.id).text, 'Show sources.');
});

test('XERJ adapter mints an exact namespace key and never uses the admin key for memory data', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-xerj-key-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const data = path.join(root, '.irixi-runtime/xerj-v1.0.0-rc.95/data');
  await fs.mkdir(data, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(data, 'admin.key'), `${'a'.repeat(64)}\n`, { mode: 0o600 });
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: new URL(url), options });
    const route = new URL(url).pathname;
    if (route === '/_security/api_key') return new Response(JSON.stringify({ api_key: 'b'.repeat(64), encoded: 'B'.repeat(88) }), { status: 200 });
    if (route.endsWith('/_recall')) return new Response(JSON.stringify({ hits: [] }), { status: 200 });
    return new Response(JSON.stringify({ ok: true }), { status: route.endsWith('/memory-fixture') ? 201 : 200 });
  };
  const index = createXerjMemoryIndex({ projectRoot: root, fetchImpl });
  const entry = { id: 'memory-fixture', revision: 1, scopeType: 'project', scopeId: 'article-learning-12',
    scopeFingerprint: 'a'.repeat(64), ownerTaskId: 'task-fixture', status: 'active', title: 'Convention', text: 'Use short headings.', source: { eventId: 'event-fixture' } };
  await index.upsert(entry);
  await index.recall('project', entry.scopeId, 'headings');
  await index.remove(entry);
  const mint = calls.find((call) => call.url.pathname === '/_security/api_key');
  const appCalls = calls.filter((call) => call.url.pathname.startsWith('/_memory/'));
  const expectedNamespace = memoryNamespace('project', entry.scopeId);
  assert.equal(JSON.parse(mint.options.body).role_descriptors.irixi_memory.indices[0].names[0], `.xerj-memory-${expectedNamespace}`);
  assert.deepEqual(JSON.parse(mint.options.body).role_descriptors.irixi_memory.indices[0].privileges, ['read', 'write']);
  assert.ok(appCalls.length >= 3);
  assert.ok(appCalls.every((call) => call.options.headers.authorization === `ApiKey ${'B'.repeat(88)}`));
  assert.equal(mint.options.headers.authorization, `ApiKey ${'a'.repeat(64)}`);
  assert.equal((await fs.stat(path.join(data, 'irixi-scoped-keys', `${(await import('node:crypto')).default.createHash('sha256').update(expectedNamespace).digest('hex')}.key`))).mode & 0o777, 0o600);
});
