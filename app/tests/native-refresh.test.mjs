import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { nativeMaterialBindingMatches } from '../public/native-product-state.js';

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
    $: () => null,
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

test('状态刷新保留展开的工作文件区域和聊天滚动位置', async () => {
  const column = { scrollTop: 284 };
  const panel = { hidden: false, querySelector: (selector) => selector === '.conversation-column' ? column : null };
  const tools = { open: true };
  const app = appFunctions({
    state: { projectChatTaskId: 'task-position' },
    deps: {
      $: (selector) => selector === '#project-dialogue-panel' ? panel : selector === '#project-workspace-tools' ? tools : null,
      renderAll: () => { column.scrollTop = 0; tools.open = false; },
    },
  });
  await app.refreshNativeProduct({ silent: true });
  assert.equal(column.scrollTop, 284);
  assert.equal(tools.open, true);
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

test('材料面板轮询刷新后仍跟随用户当前选择', () => {
  const panels = ['text', 'file'].map((mode) => ({ dataset: { materialPanel: mode }, hidden: true }));
  const selected = { value: 'file' };
  const sync = new Function('$', '$$', `${functionSource('syncMaterialPanels', '\n\nfunction setBackendUi')}\nreturn syncMaterialPanels;`)(
    () => selected,
    () => panels,
  );
  sync();
  sync();
  assert.deepEqual(panels.map((panel) => panel.hidden), [true, false]);
  selected.value = 'text';
  sync();
  assert.deepEqual(panels.map((panel) => panel.hidden), [false, true]);
});

test('加入材料绑定打开时的任务并在异步读取后重核，切换时保留表单草稿', () => {
  const bound = JSON.stringify(['task-a', 'goal-a', 'project-a', 'scope-a', null, null, null, null, null, null]);
  const otherTask = JSON.stringify(['task-b', 'goal-a', 'project-a', 'scope-a', null, null, null, null, null, null]);
  const otherScope = JSON.stringify(['task-a', 'goal-a', 'project-b', 'scope-b', null, null, null, null, null, null]);
  assert.equal(nativeMaterialBindingMatches(bound, bound), true);
  assert.equal(nativeMaterialBindingMatches(bound, otherTask), false, 'a switched task is stale');
  assert.equal(nativeMaterialBindingMatches(bound, otherScope), false, 'a switched project and scope are stale');
  const submitStart = appSource.indexOf("$('#material-form').addEventListener('submit'");
  const submitEnd = appSource.indexOf("$('#cancel-conversation-button').addEventListener", submitStart);
  const handler = appSource.slice(submitStart, submitEnd);
  assert.match(handler, /nativeMaterialBindingMatches\(boundAtOpen, projectTaskBinding\(state\.nativeProduct\)\)[\s\S]*?await postNativeAction\('materials', input, materialProduct\)/u,
    'the asynchronous file read rechecks the originally captured binding before posting to its captured product');
  assert.match(handler, /if \(nativeMaterialBindingMatches\(boundAtOpen, projectTaskBinding\(state\.nativeProduct\)\)[\s\S]*?element\.reset\(\)/u,
    'the shared form is cleared only while the original task remains selected');
});

test('原生材料清单给出用户可读大小，不暴露内部摘要或处理保证', () => {
  const render = new Function('nativeMode', 'esc', 'formatMaterialSize',
    `${functionSource('renderMaterials', '\n\nfunction formatMaterialSize')}\nreturn renderMaterials;`)(
    () => true,
    (value) => String(value),
    (bytes) => `${(bytes / 1024).toFixed(1)} KB`,
  );
  const output = render({ materials: [{ name: '来源.md', kind: 'md', bytes: 2048, sha256: 'a'.repeat(64) }] });
  assert.match(output, /来源\.md/u);
  assert.match(output, /MD · 2\.0 KB/u);
  assert.match(output, /已保存/u);
  assert.match(output, /原资料会保留/u);
  assert.doesNotMatch(output, /SHA-256|原始字节|命令不会执行/u);
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
