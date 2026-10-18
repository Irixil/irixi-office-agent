import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const appSource = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');

function functionSource(name, nextMarker) {
  const asyncStart = appSource.indexOf(`async function ${name}(`);
  const start = asyncStart >= 0 ? asyncStart : appSource.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} declaration exists`);
  const end = appSource.indexOf(nextMarker, start);
  assert.notEqual(end, -1, `${name} end marker exists`);
  return appSource.slice(start, end);
}

function appFunctions(overrides = {}) {
  const state = { backendMode: 'openoffice', pollTimer: null, nativeRefreshGeneration: 0, nativeRefreshesInFlight: 0, task: null, tasks: [], ...overrides.state };
  const timers = [];
  const applied = [];
  const fetchImpl = overrides.fetch || (async () => ({ status: 200, ok: true, headers: { get: () => 'application/json' }, json: async () => ({ current: true }) }));
  const readNativeProduct = overrides.readNativeProduct || new Function('fetch', 'normalizeNativeProductState',
    `${functionSource('readNativeProduct', '\n\nfunction applyNativeProduct')}\nreturn readNativeProduct;`)(fetchImpl, (value) => value);
  const deps = {
    state,
    readNativeProduct,
    applyNativeProduct: (value) => { applied.push(value); state.backendMode = 'openoffice'; },
    renderAll: () => {},
    setBackendUi: () => {},
    announce: () => {},
    nativeMode: () => state.backendMode === 'openoffice',
    nativeBlocked: () => state.backendMode === 'openoffice-blocked',
    shouldPollTask: () => false,
    planningBusy: () => false,
    conversationRuntime: () => null,
    setInterval: (callback) => { timers.push(callback); return timers.length; },
    clearInterval: () => {},
    ...overrides.deps,
  };
  const refresh = functionSource('refreshNativeProduct', '\n\nasync function refreshTask');
  const polling = functionSource('managePolling', '\n\nasync function loadConnections');
  const names = Object.keys(deps);
  const { refreshNativeProduct, managePolling } = new Function(...names,
    `${refresh}\n${polling}\nreturn { refreshNativeProduct, managePolling };`)(...Object.values(deps));
  return { state, timers, applied, refreshNativeProduct, managePolling };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function jsonResponse(value) {
  return { status: 200, ok: true, headers: { get: () => 'application/json' }, json: async () => value };
}

test('定时刷新跳过在途轮询；显式刷新仍新取状态且旧成功不覆盖新结果', async () => {
  const requests = [];
  const app = appFunctions({ fetch: () => { const request = deferred(); requests.push(request); return request.promise; } });
  app.managePolling();
  const tick = app.timers[0];
  const first = tick();
  const skipped = tick();
  const skippedAgain = tick();
  assert.equal(requests.length, 1);

  const explicit = app.refreshNativeProduct({ silent: false });
  assert.equal(requests.length, 2);
  requests[1].resolve(jsonResponse({ version: 'fresh' }));
  await explicit;
  requests[0].resolve(jsonResponse({ version: 'old-poll' }));
  await first;
  await Promise.all([skipped, skippedAgain]);
  assert.deepEqual(app.applied, [{ version: 'fresh' }]);
});

test('旧轮询失败不能覆盖显式刷新；失败完成后下次定时轮询可恢复', async () => {
  const requests = [];
  const app = appFunctions({ fetch: () => { const request = deferred(); requests.push(request); return request.promise; } });
  app.managePolling();
  const tick = app.timers[0];
  const oldPoll = tick();
  const explicit = app.refreshNativeProduct({ silent: false });
  requests[1].resolve(jsonResponse({ version: 'fresh' }));
  await explicit;
  requests[0].reject(new Error('stale poll failed'));
  await oldPoll;
  assert.equal(app.state.backendMode, 'openoffice');
  assert.equal(app.state.nativeError, undefined);

  const failedPoll = tick();
  requests[2].reject(new Error('temporary failure'));
  await failedPoll;
  assert.equal(app.state.backendMode, 'openoffice-blocked');
  app.managePolling();
  assert.equal(app.state.pollTimer, 1, 'blocked UI keeps the same read-only recovery interval');
  const recoveryPoll = tick();
  assert.equal(requests.length, 4);
  requests[3].resolve(jsonResponse({ version: 'recovered' }));
  await recoveryPoll;
  assert.deepEqual(app.applied, [{ version: 'fresh' }, { version: 'recovered' }]);
  assert.equal(app.state.backendMode, 'openoffice');
});

test('Native state display distinguishes an in-flight execution when actor is not returned', () => {
  const actualRole = appSource.match(/const actualRole = ([\s\S]*?);\n  const nativeRoster/);
  assert.ok(actualRole, 'native role display expression exists');
  assert.match(actualRole[1], /execution\?\.phase/);
  assert.match(actualRole[1], /正在执行当前授权任务/);
  assert.doesNotMatch(actualRole[1], /当前尚未开始执行/);
});

test('旧轮询先结束时不会释放仍在途的显式刷新', async () => {
  const requests = [];
  const app = appFunctions({ fetch: () => { const request = deferred(); requests.push(request); return request.promise; } });
  app.managePolling();
  const tick = app.timers[0];
  const oldPoll = tick();
  const explicit = app.refreshNativeProduct({ silent: false });

  requests[0].resolve(jsonResponse({ version: 'old-poll' }));
  await oldPoll;
  const skipped = tick();
  assert.equal(requests.length, 2);

  requests[1].resolve(jsonResponse({ version: 'fresh' }));
  await explicit;
  await skipped;
  const recovery = tick();
  assert.equal(requests.length, 3);
  requests[2].resolve(jsonResponse({ version: 'after-both-finished' }));
  await recovery;
  assert.deepEqual(app.applied, [{ version: 'fresh' }, { version: 'after-both-finished' }]);
});
