import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConversationStore } from './conversation-store.mjs';
import { COLLEAGUES } from './colleagues.mjs';

const catalogue = { models: [{ provider: 'desktop-codex', id: 'gpt-6-luna', efforts: ['medium'], defaultEffort: 'medium' }] };
const answer = (text) => ({ status: 'model_returned', output: { text }, sessionId: 'controlled-colleague-test' });
const gate = () => { let resolve; return { promise: new Promise((r) => { resolve = r; }), release: (...a) => resolve(...a) }; };
const facts = (o) => JSON.parse(o.prompt.match(/交接资料：([^\n]+)/u)[1]);
const ack = (o) => { const f = facts(o); return answer(JSON.stringify({ accepted: true, transferId: f.transferId, workId: f.workId, ownerRevision: f.ownerRevision, stopEpoch: f.stopEpoch, summary: '已接到原要求，仍保持讨论。' })); };
const route = (extra = {}) => answer(JSON.stringify({ mode: 'discuss', reply: '继续讨论', readPaths: [], title: '同事测试', ...extra }));
async function drain(store) { while (store.jobs.size) await Promise.all([...store.jobs.values()]); }
async function setup(t, runner = async (o) => o.prompt.includes('交接资料：') ? ack(o) : route()) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-colleagues-'));
  const store = new ConversationStore({ runtimeDir: root, omoRunner: runner, catalogueReader: async () => catalogue }); await store.init();
  t.after(async () => { for (const c of store.state.conversations) await store.stop(c.id); await drain(store); await fs.rm(root, { recursive: true, force: true }); });
  const c = await store.create({ requestId: 'new', colleagueId: 'researcher' }); return { root, store, c };
}
test('五位稳定身份、同角色多工作，旧数据升级不伪造角色且备份只生成一次', async (t) => {
  const { root, store, c } = await setup(t);
  const other = await store.create({ requestId: 'second', colleagueId: 'researcher' });
  assert.equal(store.view().colleagues.find((x) => x.id === 'researcher').works.length, 2);
  assert.equal(COLLEAGUES.length, 5); assert.notEqual(c.work.id, other.work.id);
  const legacy = structuredClone(store.state); legacy.version = 2;
  for (const record of legacy.conversations) delete record.work;
  await fs.writeFile(store.file, JSON.stringify(legacy));
  const reopen = new ConversationStore({ runtimeDir: root, catalogueReader: async () => catalogue }); await reopen.init();
  const restored = reopen.conversation(c.id); assert.equal(restored.work.ownerId, null);
  const originalBackup = await fs.readFile(path.join(reopen.root, 'state.before-colleagues-v3.json'), 'utf8');
  const stableId = restored.work.id; await reopen.init();
  assert.equal(reopen.conversation(c.id).work.id, stableId);
  assert.equal(await fs.readFile(path.join(reopen.root, 'state.before-colleagues-v3.json'), 'utf8'), originalBackup);
  await assert.rejects(store.create({ requestId: 'new', colleagueId: 'writer' }), /不同/);
});
test('实际接收回执后唯一负责人变化；请求重复只接收一次，异目标同编号被拒绝', async (t) => {
  let receives = 0;
  const { store, c } = await setup(t, async (o) => { receives++; return ack(o); });
  const body = { requestId: 'handoff', to: 'reviewer', expectedOwnerRevision: 0 };
  const [a, b] = await Promise.all([store.handoff(c.id, body), store.handoff(c.id, body)]); await drain(store);
  assert.equal(a.id, b.id); assert.equal(receives, 1); assert.equal(c.work.ownerId, 'reviewer'); assert.equal(c.work.ownerRevision, 1);
  assert.equal(c.work.transfers[0].status, 'accepted'); assert.equal(c.handoffRuns[0].sessions[0].colleagueId, 'reviewer');
  await assert.rejects(store.handoff(c.id, { ...body, to: 'writer' }), /同一交接/);
});
test('转交期间消息先保存且只释放一次，接收事实保留原文，模型和对话身份不变', async (t) => {
  const entered = gate(), release = gate(); let classifications = 0;
  const { store, c } = await setup(t, async (o) => {
    if (o.prompt.includes('交接资料：')) { entered.release(); await release.promise; return ack(o); }
    classifications++; return route();
  });
  const transfer = await store.handoff(c.id, { requestId: 'transfer', to: 'reviewer' }); await entered.promise;
  const turn = await store.send(c.id, { requestId: 'addition', text: '先讨论，保留蓝色主题' });
  await store.send(c.id, { requestId: 'addition', text: '先讨论，保留蓝色主题' });
  assert.equal(turn.heldForTransferId, transfer.id); assert.equal(classifications, 0); assert.equal(c.messages.length, 1);
  release.release(); await drain(store);
  assert.equal(classifications, 1); assert.equal(turn.colleagueId, 'reviewer'); assert.equal(turn.status, 'completed');
  assert.equal(c.turns.length, 1); assert.equal(c.messages[0].text, '先讨论，保留蓝色主题'); assert.equal(turn.modelSelection.model, 'gpt-6-luna');
});
test('交接中停止：迟到接收不改负责人，已保存补充不继续执行，不误停别的工作', async (t) => {
  const entered = gate(), release = gate();
  const { store, c } = await setup(t, async (o) => {
    if (o.prompt.includes('交接资料：')) { entered.release(); await release.promise; return ack(o); } return route();
  });
  await store.handoff(c.id, { requestId: 'transfer', to: 'reviewer' }); await entered.promise;
  const held = await store.send(c.id, { requestId: 'held', text: '先讨论新要求' });
  const other = await store.create({ requestId: 'other', colleagueId: 'writer' });
  await store.stop(c.id); await store.send(other.id, { requestId: 'other-message', text: '讨论工具' });
  release.release(); await drain(store);
  assert.equal(c.work.ownerId, 'researcher'); assert.equal(c.work.transfers[0].status, 'cancelled');
  assert.equal(held.status, 'stopped'); assert.equal(held.calls.length, 0); assert.equal(other.turns[0].status, 'completed');
});
test('接收成功但保存失败回滚责任；释放输入由原同事处理，未误报接手', async (t) => {
  const { store, c } = await setup(t);
  const save = store.save.bind(store); let failed = false;
  store.save = async () => { if (!failed && c.work.ownerId === 'reviewer') { failed = true; throw new Error('controlled adoption write failure'); } return save(); };
  await store.handoff(c.id, { requestId: 'transfer', to: 'reviewer' }); await drain(store);
  assert.equal(failed, true); assert.equal(c.work.ownerId, 'researcher'); assert.equal(c.work.ownerRevision, 0); assert.equal(c.work.transfers[0].status, 'failed');
  assert.equal(JSON.parse(await fs.readFile(store.file, 'utf8')).conversations[0].work.ownerId, 'researcher');
});
test('重启中断未完成交接而不调用模型；历史分支获得独立工作身份', async (t) => {
  const { root, store, c } = await setup(t);
  await store.send(c.id, { requestId: 'discuss', text: '先讨论' }); await drain(store);
  const branch = await store.fork(c.id, { requestId: 'fork', messageId: c.messages.at(-1).id });
  assert.notEqual(branch.work.id, c.work.id); assert.equal(branch.work.ownerId, 'researcher'); assert.equal(branch.work.transfers.length, 0);
  c.work.transfers.push({ id: 'unfinished', status: 'receiving', from: 'researcher', to: 'reviewer' }); await store.save();
  const reopen = new ConversationStore({ runtimeDir: root, omoRunner: () => { throw new Error('must not run'); }, catalogueReader: async () => catalogue }); await reopen.init();
  assert.equal(reopen.conversation(c.id).work.ownerId, 'researcher'); assert.equal(reopen.conversation(c.id).work.transfers[0].status, 'interrupted');
  assert.equal(reopen.jobs.size, 0);
});
test('正常消息路由触发实际接手，讨论权限在交接后保持且不新增项目', async (t) => {
  let receptions = 0;
  const { store, c } = await setup(t, async (o) => {
    if (o.prompt.includes('交接资料：')) { receptions++; return ack(o); }
    assert.equal(o.role, 'Chat'); return route({ handoffTo: 'reviewer', handoffReason: '小游戏讨论' });
  });
  await store.send(c.id, { requestId: 'idea', text: '想做小游戏，先讨论' }); await drain(store);
  assert.equal(receptions, 1); assert.equal(c.work.ownerId, 'reviewer'); assert.equal(c.turns[0].intent, 'discuss'); assert.equal(c.turns[0].status, 'completed'); assert.equal(store.state.projects.length, 0);
});
test('停止遇持久化失败仍先中止执行，不能继续采用成果', async (t) => {
  const started = gate(), release = gate(); let executionSignal;
  const { root, store, c } = await setup(t, async (o) => {
    if (o.decisionOnly) return route({ mode: 'execute' });
    executionSignal = o.signal; started.release(); await release.promise;
    await fs.writeFile(path.join(o.cwd, 'result.txt'), 'must not be adopted'); return answer('旧工作');
  });
  const project = path.join(root, 'project'); await fs.mkdir(project); await store.bindProject(c.id, { requestId: 'bind', path: project });
  await store.send(c.id, { requestId: 'make', text: '直接制作' }); await started.promise;
  await store.handoff(c.id, { requestId: 'transfer', to: 'writer' });
  const save = store.save.bind(store); let once = true;
  store.save = async () => { if (once) { once = false; throw new Error('controlled stop save failure'); } return save(); };
  await assert.rejects(store.stop(c.id), /stop save failure/); assert.equal(executionSignal.aborted, true);
  release.release(); await drain(store);
  assert.equal(c.turns[0].adoptedAt, undefined); assert.deepEqual(await fs.readdir(project), []);
});
test('公共交接不能指定跳过在写的轮次；过期取消不会取消新交接', async (t) => {
  const release = gate();
  const { store, c } = await setup(t, async (o) => { await release.promise; return ack(o); });
  await assert.rejects(store.handoff(c.id, { requestId: 'spoof', to: 'reviewer', sourceTurnId: 'writer-turn' }), /内部交接停点/);
  const old = await store.handoff(c.id, { requestId: 'old', to: 'reviewer' });
  await store.handoff(c.id, { cancel: true, transferId: old.id });
  const current = await store.handoff(c.id, { requestId: 'new', to: 'writer' });
  await store.handoff(c.id, { cancel: true, transferId: old.id });
  assert.notEqual(current.status, 'cancelled'); release.release(); await drain(store);
  assert.equal(c.work.ownerId, 'writer');
});
test('交接后回复来自接收同事的新执行，不重贴原同事回复标签', async (t) => {
  const { store, c } = await setup(t, async (o) => {
    if (o.prompt.includes('交接资料：')) return ack(o);
    if (o.decisionOnly) return route({ handoffTo: 'reviewer', reply: 'SOURCE_REPLY_MARKER' });
    assert.match(o.prompt, /当前同事：龙猫小游戏开发同事/u); return answer('TARGET_REPLY_MARKER');
  });
  await store.send(c.id, { requestId: 'idea', text: '先讨论小游戏' }); await drain(store);
  const reply = c.messages.at(-1); assert.equal(reply.text, 'TARGET_REPLY_MARKER'); assert.equal(reply.colleagueId, 'reviewer');
  assert(!c.messages.some((m) => m.text === 'SOURCE_REPLY_MARKER'));
});
test('交接释放保存失败显示可恢复中断，不留下无执行的假排队', async (t) => {
  const entered = gate(), release = gate();
  const { store, c } = await setup(t, async (o) => { entered.release(); await release.promise; return ack(o); });
  await store.handoff(c.id, { requestId: 'transfer', to: 'reviewer' }); await entered.promise;
  const held = await store.send(c.id, { requestId: 'held', text: '先讨论新增要求' });
  const save = store.save.bind(store); let failed = false;
  store.save = async () => { if (!failed && c.work.ownerId === 'reviewer' && held.heldForTransferId === null) { failed = true; throw new Error('controlled release failure'); } return save(); };
  release.release(); await drain(store);
  assert.equal(failed, true); assert.equal(held.status, 'interrupted'); assert.equal(store.jobs.has(held.id), false); assert.equal(store.controllers.has(held.id), false);
  assert.equal(c.messages[0].text, '先讨论新增要求');
});
