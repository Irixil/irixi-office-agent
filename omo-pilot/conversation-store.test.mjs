import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConversationStore, discussionOnly, fileIndex, needsWriteReview } from './conversation-store.mjs';
import { executeConversationCommand } from './conversation-command.mjs';

const gate = () => { let release; return { promise: new Promise((r) => { release = r; }), release: (...args) => release(...args) }; };
async function setup(runner) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-p0-local-'));
  const store = new ConversationStore({ runtimeDir: root, omoRunner: runner }); await store.init();
  const c = await store.create({ requestId: 'create' }); return { store, c, root };
}
const reply = (text) => ({ status: 'model_returned', output: { text }, sessionId: 'local-controlled-test' });
const route = (mode = 'execute', extra = {}) => reply(JSON.stringify({ mode, reply: '本地受控返回，不是真实模型证据', projectPath: null, readPaths: [], ...extra }));
async function drain(store) { while (store.jobs.size) await Promise.all([...store.jobs.values()]); }
async function bindEmptyProject(store, c, root) {
  const dir = path.join(root, 'chosen-project'); await fs.mkdir(dir);
  await store.bindProject(c.id, { requestId: 'chosen-folder', path: dir });
}
async function checkText(options, target, includes) {
  await options.onBehaviorCheck({ requestId: `check-${target}`, caseJson: JSON.stringify({ caseId: target.replace('.', '-'), requirement: '保留受控输出', kind: 'document', target, expected: { includes } }) }, options.signal);
}

test('写后复核需要真实成功回执，列目录、读历史和失败检查不能替代', () => {
  let n = 0; const receipts = [];
  const add = (toolName, name, isError = false) => { const toolCallId = String(++n); receipts.push({ eventType: 'start', toolCallId, toolName, args: { text: JSON.stringify({ path: name }) } }, { eventType: 'end', toolCallId, toolName, isError }); };
  const final = JSON.stringify({ content: [{ type: 'text', text: 'done' }] });
  add('write', '[workspace]/app.js'); assert.equal(needsWriteReview(final, receipts), true);
  add('ls', '.'); add('read', 'history.txt'); add('bash', '', true); assert.equal(needsWriteReview(final, receipts), true);
  add('read', 'app.js'); assert.equal(needsWriteReview(final, receipts), true);
  add('edit', 'app.js'); assert.equal(needsWriteReview(final, receipts), true);
  add('bash', ''); assert.equal(needsWriteReview(final, receipts), true);
});

test('明确资料目录可读其内部文件，但不授权同名前缀、写入或链接越界', async () => {
  const { store, root } = await setup(async () => route('discuss'));
  const dir = path.join(root, 'materials'); await fs.mkdir(dir);
  const file = path.join(dir, 'good.csv'); await fs.writeFile(file, 'a,b');
  const text = `请读取这个资料文件夹 ${dir} 里的 good.csv。`;
  assert.equal(await store.requestedPath(file, text), await fs.realpath(file));
  await assert.rejects(store.requestedPath(dir, `${dir}-unrelated`), /没有获得/);
  await assert.rejects(store.requestedPath(file, `请读 ${root}-other`), /没有获得/);
  const subdir = path.join(dir, 'nested'); await fs.mkdir(subdir);
  await assert.rejects(store.requestedPath(subdir, text, true), /没有获得/);
  const outside = path.join(root, 'outside.txt'); await fs.writeFile(outside, 'outside');
  const link = path.join(dir, 'link.txt'); await fs.symlink(outside, link);
  await assert.rejects(store.requestedPath(link, text), /没有获得/);
  await fs.rm(root, { recursive: true, force: true });
});

test('否定不跨越分句误伤明确开工', () => {
  for (const text of ['先讨论，不要开始做', '还不能直接执行', '请不要擅自修改']) assert.equal(discussionOnly(text), true);
  for (const text of ['不要再让我填表，直接开始做', '不要犹豫，直接做', '可以，开始制作']) assert.equal(discussionOnly(text), false);
});
test('同请求并发只保存一次并启动一次；新想法不建立项目', async () => {
  let calls = 0;
  const { store, c } = await setup(async () => { calls++; return route('discuss'); });
  await Promise.all(Array.from({ length: 5 }, () => store.send(c.id, { requestId: 'one', text: '先讨论学习工具' })));
  await drain(store); assert.equal(c.turns.length, 1); assert.equal(c.messages.length, 2); assert.equal(calls, 1); assert.equal(store.state.projects.length, 0);
});
test('保存失败可重发，不留下永远排队的假成功', async () => {
  const { store, c } = await setup(async () => route('discuss'));
  const original = store.save.bind(store); let fail = true;
  store.save = async () => { if (fail) { fail = false; throw new Error('injected disk failure'); } return original(); };
  await assert.rejects(store.send(c.id, { requestId: 'retry', text: '讨论' }), /disk failure/);
  assert.equal(c.turns.length, 0);
  await store.send(c.id, { requestId: 'retry', text: '讨论' }); await drain(store); assert.equal(c.turns[0].status, 'completed');
});
test('旧意图迟到不能启动或取消新工作', async () => {
  const delayed = gate(); let chats = 0; let developers = 0;
  const { store, c, root } = await setup(async (options) => {
    const { role, cwd } = options;
    if (role === 'Chat') { chats++; if (chats === 1) await delayed.promise; return route(); }
    developers++; await fs.writeFile(path.join(cwd, 'new.txt'), 'new'); await checkText(options, 'new.txt', ['new']); return reply('完成');
  });
  await bindEmptyProject(store, c, root);
  await store.send(c.id, { requestId: 'old', text: '开始旧的' });
  await store.send(c.id, { requestId: 'new', text: '现在按新的做' });
  await store.jobs.get(c.turns[1].id); delayed.release(); await drain(store);
  assert.equal(developers, 1); assert.equal(store.state.projects.length, 1); assert.equal(c.turns[0].status, 'superseded'); assert.equal(c.turns[1].status, 'completed');
});
test('停止后保留实际文件并在明确继续时恢复', async () => {
  const started = gate(); let workers = 0;
  const { store, c, root } = await setup(async (options) => {
    const { role, cwd, signal } = options;
    if (role === 'Chat') return route();
    if (++workers === 1) {
      await fs.writeFile(path.join(cwd, 'partial.txt'), 'progress'); started.release();
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }));
    }
    assert.equal(await fs.readFile(path.join(cwd, 'partial.txt'), 'utf8'), 'progress');
    await fs.writeFile(path.join(cwd, 'done.txt'), 'done'); await checkText(options, 'done.txt', ['done']); return reply('完成');
  });
  await bindEmptyProject(store, c, root);
  await store.send(c.id, { requestId: 'run', text: '开始做' }); await started.promise;
  await store.stop(c.id); await drain(store); assert.equal(c.turns[0].status, 'stopped');
  await store.send(c.id, { requestId: 'resume', text: '继续完成' }); await drain(store);
  assert.equal(c.turns[1].status, 'completed'); assert.equal(c.turns[1].resumedFrom, c.turns[0].id);
  assert.equal(await fs.readFile(path.join(store.project(c).root, 'done.txt'), 'utf8'), 'done');
});
test('原项目后来的修改不会被候选覆盖；敏感文件不进入副本', async () => {
  let root; let store;
  const result = await setup(async ({ role, cwd }) => {
    if (role === 'Chat') return route('execute', { projectPath: root });
    assert.deepEqual(Object.keys(await fileIndex(cwd)), ['keep.txt']);
    await assert.rejects(fs.access(path.join(cwd, '.env')));
    await fs.writeFile(path.join(cwd, 'keep.txt'), 'candidate'); await fs.writeFile(path.join(root, 'keep.txt'), 'human'); return reply('候选完成');
  });
  store = result.store; root = path.join(result.root, 'existing'); await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'keep.txt'), 'before'); await fs.writeFile(path.join(root, '.env'), 'SYNTHETIC_SECRET=protected');
  await store.send(result.c.id, { requestId: 'import', text: `请修改这个项目 ${root}` }); await drain(store);
  assert.equal(result.c.turns[0].status, 'failed'); assert.equal(await fs.readFile(path.join(root, 'keep.txt'), 'utf8'), 'human');
  assert.equal(await fs.readFile(path.join(root, '.env'), 'utf8'), 'SYNTHETIC_SECRET=protected');
});
test('命令结束清理后台写入；停止等待整个普通进程组', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-p0-command-'));
  await fs.writeFile(path.join(root, 'late.cjs'), "setTimeout(()=>require('fs').writeFileSync('late.txt','bad'),400)");
  const result = await executeConversationCommand({ command: 'node late.cjs >/dev/null 2>&1 & echo started' }, { root });
  assert.equal(result.details.exitCode, 0); await new Promise((r) => setTimeout(r, 600)); await assert.rejects(fs.access(path.join(root, 'late.txt')));
  const abort = new AbortController(); const started = Date.now();
  const run = executeConversationCommand({ command: 'node -e "setTimeout(()=>{},10000)" & wait' }, { root, signal: abort.signal });
  setTimeout(() => abort.abort(), 100); const stopped = await run; assert.equal(stopped.details.stopped, true); assert.ok(Date.now() - started < 2000);
});
