import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_TEXT = 4_000;
const MAX_DIRECT_MEMORIES = 12;
const MAX_DIRECT_BYTES = 12_000;
const SAFE_ID = /^[a-z0-9][a-z0-9-]{5,100}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function clean(value, limit) {
  return String(value ?? '').replaceAll('\u0000', '').trim().slice(0, limit);
}

export function memoryNamespace(scopeType, scopeId) {
  if (scopeType === 'global') return 'irixi-personal-v1';
  return `irixi-project-${crypto.createHash('sha256').update(String(scopeId)).digest('hex').slice(0, 24)}`;
}

export function createXerjMemoryIndex({ projectRoot, baseUrl = 'http://127.0.0.1:19200', fetchImpl = fetch } = {}) {
  const endpoint = new URL(baseUrl);
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)
      || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) {
    throw new Error('XERJ endpoint must be a plain loopback HTTP origin.');
  }
  const dataDir = path.resolve(projectRoot, '.irixi-runtime/xerj-v1.0.0-rc.95/data');
  const keyPath = path.join(dataDir, 'admin.key');
  const scopedKeyDir = path.join(dataDir, 'irixi-scoped-keys');
  if (!keyPath.startsWith(`${path.resolve(projectRoot)}${path.sep}`)) throw new Error('Invalid XERJ key path.');

  async function readPrivateKey(file, kind = 'admin') {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) {
      throw new Error('XERJ key must be a private regular file.');
    }
    const value = (await fs.readFile(file, 'utf8')).trim();
    if (kind === 'admin' ? !/^[a-f0-9]{64}$/i.test(value) : !/^[A-Za-z0-9+/=]{80,256}$/.test(value)) throw new Error('XERJ key is invalid.');
    return value;
  }

  const scopedKeys = new Map();
  async function namespaceKey(namespace) {
    if (scopedKeys.has(namespace)) return scopedKeys.get(namespace);
    const pending = (async () => {
      await fs.mkdir(scopedKeyDir, { recursive: true, mode: 0o700 });
      const scopedPath = path.join(scopedKeyDir, `${crypto.createHash('sha256').update(namespace).digest('hex')}.key`);
      try { return await readPrivateKey(scopedPath, 'scoped'); }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
      const admin = await readPrivateKey(keyPath);
      const response = await fetchImpl(new URL('/_security/api_key', endpoint), {
        method: 'POST', headers: { authorization: `ApiKey ${admin}`, accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ name: `irixi-${crypto.createHash('sha256').update(namespace).digest('hex').slice(0, 16)}`,
          role_descriptors: { irixi_memory: { indices: [{ names: [`.xerj-memory-${namespace}`], privileges: ['read', 'write'] }] } } }),
        signal: AbortSignal.timeout(3_000),
      });
      const payload = await response.json();
      if (!response.ok || typeof payload?.encoded !== 'string' || !/^[A-Za-z0-9+/=]{80,256}$/.test(payload.encoded)) throw new Error('XERJ could not issue a scoped memory key.');
      const temporary = `${scopedPath}.${crypto.randomUUID()}.tmp`;
      await fs.writeFile(temporary, `${payload.encoded}\n`, { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, scopedPath);
      return payload.encoded;
    })();
    scopedKeys.set(namespace, pending);
    try { return await pending; }
    catch (error) { scopedKeys.delete(namespace); throw error; }
  }

  async function request(method, route, body, namespace) {
    const token = await namespaceKey(namespace);
    const response = await fetchImpl(new URL(route, endpoint), {
      method, headers: { authorization: `ApiKey ${token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(3_000),
    });
    const text = await response.text();
    let value;
    try { value = text ? JSON.parse(text) : null; } catch { throw new Error('XERJ returned invalid JSON.'); }
    if (!response.ok) throw Object.assign(new Error(`XERJ request failed (${response.status}).`), { status: response.status });
    return value;
  }

  return {
    async available() {
      try {
        const response = await fetchImpl(new URL('/', endpoint), { signal: AbortSignal.timeout(1_000) });
        return response.status < 500;
      } catch { return false; }
    },
    async upsert(entry) {
      const namespace = memoryNamespace(entry.scopeType, entry.scopeId);
      return request('POST', `/_memory/${encodeURIComponent(namespace)}`, {
        id: entry.id, text: `${entry.title}\n${entry.text}`,
        metadata: { revision: entry.revision, scopeType: entry.scopeType, scopeId: entry.scopeId,
          scopeFingerprint: entry.scopeFingerprint || null, ownerTaskId: entry.ownerTaskId,
          sourceEventId: entry.source?.eventId || null, status: entry.status },
      }, namespace);
    },
    async remove(entry) {
      const namespace = memoryNamespace(entry.scopeType, entry.scopeId);
      return request('DELETE', `/_memory/${encodeURIComponent(namespace)}/${encodeURIComponent(entry.id)}`, null, namespace);
    },
    async recall(scopeType, scopeId, query, k = 20) {
      const namespace = memoryNamespace(scopeType, scopeId);
      return request('POST', `/_memory/${encodeURIComponent(namespace)}/_recall`, { query, k }, namespace);
    },
  };
}

export function createMemoryService({ store, index, emit, clock = () => new Date().toISOString(), validateScope = null } = {}) {
  if (!store || typeof emit !== 'function') throw new Error('Task store and event writer are required.');

  const validProjectScope = (scope) => scope && SAFE_ID.test(scope.projectId || '') && SHA256.test(scope.scopeFingerprint || '');
  let entriesCache = null;
  let entriesCacheAt = 0;
  const invalidateCache = () => { entriesCache = null; entriesCacheAt = 0; };
  const allEntries = async (fresh = false) => {
    if (!fresh && entriesCache && Date.now() - entriesCacheAt < 30_000) return entriesCache;
    entriesCache = (await store.list()).flatMap((task) => (task.memoryEntries || []).map((entry) => ({ taskId: task.id, entry })));
    entriesCacheAt = Date.now();
    return entriesCache;
  };
  const inScope = (entry, projectScope) => entry.scopeType === 'global' || (validProjectScope(projectScope)
      && entry.scopeId === projectScope.projectId && entry.scopeFingerprint === projectScope.scopeFingerprint);

  async function sync(entry) {
    if (!index) return { indexed: false, reason: 'index_unconfigured' };
    try {
      if (entry.status !== 'active') {
        await index.remove(entry);
        return { indexed: true };
      }
      await index.upsert(entry);
      return { indexed: true };
    } catch (error) { return { indexed: false, reason: error?.message || 'index_unavailable' }; }
  }

  return {
    async list(taskId, projectScope = null, { fresh = false } = {}) {
      const task = await store.get(taskId);
      const entries = await allEntries(fresh);
      return entries.filter(({ entry }) => inScope(entry, projectScope))
        .map(({ taskId: ownerTaskId, entry }) => ({ ...structuredClone(entry), ownerTaskId }));
    },
    async save(taskId, input, projectScope = null, expectedGoalVersionId = null) {
      if (!input || typeof input !== 'object' || Array.isArray(input)
          || JSON.stringify(Object.keys(input).sort()) !== JSON.stringify(['kind', 'scopeType', 'text', 'title'].sort())
          || !['preference', 'convention'].includes(input.kind)
          || !['global', 'project'].includes(input.scopeType)
          || input.scopeType === 'global' && input.kind !== 'preference'
          || input.scopeType === 'project' && input.kind !== 'convention'
          || !clean(input.title, 120) || !clean(input.text, MAX_TEXT)
          || String(input.title).trim() !== input.title || String(input.text).trim() !== input.text
          || input.text.length > MAX_TEXT) throw Object.assign(new Error('Memory input is invalid.'), { status: 400 });
      if (input.scopeType === 'project' && !validProjectScope(projectScope)) throw Object.assign(new Error('A current authorized project scope is required.'), { status: 409 });
      const mutation = await store.mutate(taskId, (task) => {
        if (expectedGoalVersionId && task.goal?.activeVersionId !== expectedGoalVersionId) throw Object.assign(new Error('Memory action is bound to an older task goal.'), { status: 409 });
        if (input.scopeType === 'project' && validateScope && !validateScope(task, projectScope)) throw Object.assign(new Error('Current project authorization changed before memory save.'), { status: 409 });
        const id = `memory-${crypto.randomUUID()}`;
        const savedAt = clock();
        const record = { id, revision: 1, kind: input.kind, scopeType: input.scopeType,
          scopeId: input.scopeType === 'global' ? 'personal' : projectScope.projectId,
          scopeFingerprint: input.scopeType === 'project' ? projectScope.scopeFingerprint : null,
          title: input.title, text: input.text, status: 'active', ownerTaskId: taskId,
          createdAt: savedAt, updatedAt: savedAt, history: [] };
        const item = emit(task, 'memory.explicitly_saved', '用户明确保存了一条长期记忆。', {
          memoryId: id, revision: 1, scopeType: record.scopeType, scopeId: record.scopeId,
          kind: record.kind, title: record.title, origin: 'explicit_user_action' });
        record.source = { type: 'explicit_user_action', taskId, eventId: item.id, revision: 1 };
        task.memoryEntries ??= [];
        task.memoryEntries.push(record);
        return structuredClone(record);
      });
      invalidateCache();
      return { memory: mutation.result, index: await sync(mutation.result) };
    },
    async change(taskId, memoryId, input, projectScope = null, expectedGoalVersionId = null) {
      if (!SAFE_ID.test(memoryId || '') || !input || typeof input !== 'object' || Array.isArray(input)
          || !Number.isInteger(input.expectedRevision) || input.expectedRevision < 1
          || !['correct', 'deactivate', 'delete'].includes(input.operation)) throw Object.assign(new Error('Memory change request is invalid.'), { status: 400 });
      const owner = (await allEntries(true)).find(({ entry }) => entry.id === memoryId && inScope(entry, projectScope));
      if (!owner) throw Object.assign(new Error('Memory revision or scope is stale.'), { status: 409 });
      const mutation = await store.mutateMany([taskId, owner.taskId], (tasks) => {
        const currentTask = tasks.get(taskId);
        if (expectedGoalVersionId && currentTask?.goal?.activeVersionId !== expectedGoalVersionId) throw Object.assign(new Error('Memory action is bound to an older task goal.'), { status: 409 });
        const task = tasks.get(owner.taskId);
        const record = (task.memoryEntries || []).find((entry) => entry.id === memoryId);
        if (record?.scopeType === 'project' && validateScope && !validateScope(currentTask, projectScope)) throw Object.assign(new Error('Current project authorization changed before memory update.'), { status: 409 });
        if (!record || record.revision !== input.expectedRevision || !inScope(record, projectScope)
            || record.status === 'deleted' || record.status === 'deactivated' && input.operation !== 'correct') throw Object.assign(new Error('Memory revision or scope is stale.'), { status: 409 });
        if (input.operation === 'correct') {
          if (JSON.stringify(Object.keys(input).sort()) !== JSON.stringify(['expectedRevision', 'kind', 'operation', 'text', 'title'].sort())
              || !['preference', 'convention'].includes(input.kind) || !clean(input.title, 120) || !clean(input.text, MAX_TEXT)
              || (record.scopeType === 'global' && input.kind !== 'preference') || (record.scopeType === 'project' && input.kind !== 'convention')
              || input.title.trim() !== input.title || input.text.trim() !== input.text || input.text.length > MAX_TEXT) {
            throw Object.assign(new Error('Corrected memory is invalid.'), { status: 400 });
          }
          record.history ??= [];
          record.history.push({ revision: record.revision, kind: record.kind, title: record.title, text: record.text, source: record.source, changedAt: clock() });
          record.revision += 1;
          record.kind = input.kind; record.title = input.title; record.text = input.text; record.status = 'active'; record.updatedAt = clock();
        } else {
          if (JSON.stringify(Object.keys(input).sort()) !== JSON.stringify(['expectedRevision', 'operation'].sort())) throw Object.assign(new Error('Memory change contains unsupported fields.'), { status: 400 });
          record.revision += 1; record.status = input.operation === 'delete' ? 'deleted' : 'deactivated'; record.updatedAt = clock();
        }
        const item = emit(task, `memory.${input.operation}`, input.operation === 'correct' ? '用户明确修正了一条长期记忆。' : input.operation === 'deactivate' ? '用户停用了一条长期记忆。' : '用户删除了一条长期记忆。', {
          memoryId, revision: record.revision, scopeType: record.scopeType, scopeId: record.scopeId,
          origin: 'explicit_user_action' });
        if (input.operation === 'correct') record.source = { type: 'explicit_user_action', taskId: task.id, eventId: item.id, revision: record.revision };
        return structuredClone(record);
      });
      invalidateCache();
      return { memory: mutation.result, index: await sync(mutation.result) };
    },
    async retrieve(taskId, query, projectScope = null) {
      const tasks = await store.list();
      const current = tasks.find((task) => task.id === taskId);
      if (!current) throw new Error('Unknown task.');
      const entries = tasks.flatMap((task) => (task.memoryEntries || []).map((entry) => ({ ...entry, ownerTaskId: task.id })))
        .filter((entry) => inScope(entry, projectScope) && entry.status === 'active');
      entriesCache = tasks.flatMap((task) => (task.memoryEntries || []).map((entry) => ({ taskId: task.id, entry })));
      entriesCacheAt = Date.now();
      const snapshot = entries.map((entry) => ({ id: entry.id, revision: entry.revision, scopeType: entry.scopeType,
        scopeId: entry.scopeId, scopeFingerprint: entry.scopeFingerprint || null, ownerTaskId: entry.ownerTaskId }))
        .sort((a, b) => `${a.ownerTaskId}:${a.id}`.localeCompare(`${b.ownerTaskId}:${b.id}`));
      const directlyApplicable = [...entries]
        .filter((entry) => entry.scopeType === 'global' && entry.kind === 'preference'
          || entry.scopeType === 'project' && entry.kind === 'convention')
        .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')) || a.id.localeCompare(b.id));
      const directMemories = [];
      let directBytes = 0;
      for (const entry of directlyApplicable) {
        const size = Buffer.byteLength(`${entry.title}\n${entry.text}`);
        if (directMemories.length >= MAX_DIRECT_MEMORIES || directBytes + size > MAX_DIRECT_BYTES) continue;
        directBytes += size;
        directMemories.push({ id: entry.id, revision: entry.revision, kind: entry.kind, scopeType: entry.scopeType,
          title: entry.title, text: entry.text, source: entry.source, ownerTaskId: entry.ownerTaskId,
          application: entry.scopeType === 'global' ? 'direct_explicit_preference' : 'direct_project_convention' });
      }
      if (!entries.length) return { memories: [], snapshot, degraded: false, reason: null, directCount: 0, relatedCount: 0 };
      if (!index) return { memories: directMemories, snapshot, degraded: true, reason: 'index_unconfigured', directCount: directMemories.length, relatedCount: 0 };
      try {
        const available = await index.available();
        if (!available) return { memories: directMemories, snapshot, degraded: true, reason: 'index_unavailable', directCount: directMemories.length, relatedCount: 0 };
        for (const entry of entries) await index.upsert(entry);
        const scopes = [{ type: 'global', id: 'personal' }];
        if (validProjectScope(projectScope)) scopes.push({ type: 'project', id: projectScope.projectId });
        const recalled = await Promise.all(scopes.map((scope) => index.recall(scope.type, scope.id, query, 20)));
        const byCurrentRevision = new Map(entries.map((entry) => [`${entry.ownerTaskId}:${entry.id}:${entry.revision}`, entry]));
        const relatedMemories = recalled.flatMap((result) => result?.hits || []).flatMap((hit) => {
          const metadata = hit?.metadata || {};
          const entry = byCurrentRevision.get(`${metadata.ownerTaskId}:${hit.id}:${metadata.revision}`);
          if (!entry || metadata.status !== 'active' || metadata.scopeType !== entry.scopeType || metadata.scopeId !== entry.scopeId
              || (entry.scopeType === 'project' && (metadata.scopeFingerprint !== projectScope?.scopeFingerprint || !validProjectScope(projectScope)))) return [];
          return [{ id: entry.id, revision: entry.revision, kind: entry.kind, scopeType: entry.scopeType,
            title: entry.title, text: entry.text, source: entry.source, ownerTaskId: entry.ownerTaskId,
            application: 'xerj_lexical_related_recall' }];
        });
        const memoriesById = new Map(directMemories.map((entry) => [entry.id, entry]));
        for (const entry of relatedMemories) if (!memoriesById.has(entry.id)) memoriesById.set(entry.id, entry);
        const memories = [...memoriesById.values()];
        return { memories, snapshot, degraded: false, reason: null, directCount: directMemories.length, relatedCount: memories.length - directMemories.length };
      } catch (error) { return { memories: directMemories, snapshot, degraded: true, reason: error?.message || 'index_unavailable', directCount: directMemories.length, relatedCount: 0 }; }
    },
    invalidateCache,
  };
}
