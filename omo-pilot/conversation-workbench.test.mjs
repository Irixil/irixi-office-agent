import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ConversationStore } from './conversation-store.mjs';
import { guardWorkspaceToolCalls } from './codex-provider-protocol.mjs';
import { buildCodexRoleInvocation } from '../app/codex-role-adapter.mjs';

const catalogue = { models: ['gpt-6-luna', 'gpt-6-sol'].map((id) => ({ provider: 'desktop-codex', id, efforts: ['low', 'medium'], defaultEffort: 'medium' })) };
const answer = (text) => ({ status: 'model_returned', output: { text }, sessionId: `controlled-${Math.random()}` });
const route = (mode = 'discuss') => answer(JSON.stringify({ mode, reply: '这是受控测试', title: '学习记录工具', readPaths: [] }));
async function drain(store) { while (store.jobs.size) await Promise.all([...store.jobs.values()]); }
async function fixture(t, runner) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-workbench-local-'));
  const store = new ConversationStore({ runtimeDir: root, omoRunner: runner, catalogueReader: async () => catalogue }); await store.init();
  t.after(async () => { for (const c of store.state.conversations) await store.stop(c.id); await drain(store); await fs.rm(root, { recursive: true, force: true }); });
  const c = await store.create({ requestId: 'new' }); return { root, store, c };
}
test('开工缺目录先保存，选定只续行一次，原轮模型不随设置变化', async (t) => {
  let routing = 0, workers = 0; const selected = [];
  const { root, store, c } = await fixture(t, async (options) => {
    selected.push(options.modelSelection.model);
    if (options.decisionOnly) { routing++; return route('execute'); }
    workers++; await fs.writeFile(path.join(options.cwd, 'result.txt'), 'working'); await options.onBehaviorCheck({ requestId: 'doc-check', caseJson: JSON.stringify({ caseId: 'content', requirement: '包含工作记录', kind: 'document', target: 'result.txt', expected: { includes: ['working'] } }) }, new AbortController().signal); return answer('已制作');
  });
  await store.send(c.id, { requestId: 'go', text: '直接开始做' }); await drain(store);
  assert.equal(c.turns[0].status, 'awaiting_project'); assert.equal(workers, 0); assert.equal(store.state.projects.length, 0);
  const dir = path.join(root, 'chosen'); await fs.mkdir(dir);
  await store.update(c.id, { modelSelection: { provider: 'desktop-codex', model: 'gpt-6-sol', effort: 'low' } });
  const body = { requestId: 'folder', path: dir, pendingTurnId: c.turns[0].id };
  await Promise.all([store.bindProject(c.id, body), store.bindProject(c.id, body)]); await drain(store);
  assert.equal(workers, 1); assert.equal(routing, 1); assert.equal(c.turns.length, 1);
  assert.equal(c.turns[0].status, 'completed'); assert.deepEqual(selected, ['gpt-6-luna', 'gpt-6-luna']);
  assert.equal(await fs.readFile(path.join(dir, 'result.txt'), 'utf8'), 'working');
});
test('执行轮只返回代码文字，不能冒充成果已保存或工作完成', async (t) => {
  const { root, store, c } = await fixture(t, async (options) => options.decisionOnly ? route('execute') : answer('请将 print(1) 保存为 main.py 后自行运行。'));
  const dir = path.join(root, 'no-deliverable'); await fs.mkdir(dir);
  await store.bindProject(c.id, { requestId: 'folder', path: dir });
  await store.send(c.id, { requestId: 'work', text: '直接制作可运行工具' }); await drain(store);
  assert.equal(c.turns[0].status, 'failed'); assert.equal(c.turns[0].adoptedAt, undefined);
  assert.match(c.turns[0].error, /没有生成或修改成果/); assert.deepEqual(await fs.readdir(dir), []);
});
test('续接交给模型原检查定义和最新实际结果，不能只给含糊的重测要求', async (t) => {
  const { store, c } = await fixture(t, async () => route());
  const specification = { caseId: 'saved', requirement: '保存', kind: 'document', target: 'a.txt', expected: { includes: ['值'] } };
  const turn = { id: 'continuation', references: [], functionalChecks: [{ caseId: 'saved', specification, status: 'failed', error: '缺少值' }, { caseId: 'another', specification: { ...specification, caseId: 'another' }, status: 'failed' }, { caseId: 'saved', specification, status: 'passed', actual: { missing: [] } }] };
  const root = await store.context(c, turn); const checks = JSON.parse(await fs.readFile(path.join(root, 'functional-checks.json'), 'utf8'));
  assert.equal(checks.length, 2); assert.equal(checks[0].status, 'passed'); assert.equal(checks[1].status, 'failed'); assert.deepEqual(checks[0].specification, specification);
});
test('服务关闭保留待选目录的原请求，重开选定仅续行一次；用户停止仍可取消', async (t) => {
  let routing = 0, workers = 0;
  const runner = async (options) => {
    if (options.decisionOnly) { routing++; return route('execute'); }
    workers++; await fs.writeFile(path.join(options.cwd, 'result.txt'), 'working');
    await options.onBehaviorCheck({ requestId: 'doc', caseJson: JSON.stringify({ caseId: 'content', requirement: '写入工作结果', kind: 'document', target: 'result.txt', expected: { includes: ['working'] } }) }, new AbortController().signal); return answer('已制作');
  };
  const { root, store, c } = await fixture(t, runner);
  await store.send(c.id, { requestId: 'original', text: '直接开始做' }); await drain(store);
  const pendingId = c.turns[0].id; await store.stop(c.id, { preservePending: true });
  const next = new ConversationStore({ runtimeDir: root, omoRunner: runner, catalogueReader: async () => catalogue }); await next.init();
  assert.equal(next.conversation(c.id).turns[0].status, 'awaiting_project'); assert.equal(routing, 1); assert.equal(workers, 0);
  const directory = path.join(root, 'chosen-after-restart'); await fs.mkdir(directory);
  const body = { requestId: 'bind-once', path: directory, pendingTurnId: pendingId };
  await Promise.all([next.bindProject(c.id, body), next.bindProject(c.id, body)]); await drain(next);
  assert.equal(workers, 1); assert.equal(routing, 1); assert.equal(next.conversation(c.id).turns.length, 1);
  assert.equal(next.conversation(c.id).turns[0].status, 'completed');
  const other = await next.create({ requestId: 'other' }); await next.send(other.id, { requestId: 'other-work', text: '直接制作' }); await drain(next);
  await next.stop(other.id); assert.equal(other.turns[0].status, 'stopped');
});
test('讨论选目录和重开都不启动工作；旧数据升级备份且保留身份', async (t) => {
  let calls = 0; const { root, store, c } = await fixture(t, async () => { calls++; return route(); });
  await store.send(c.id, { requestId: 'talk', text: '先讨论学习工具' }); await drain(store);
  const dir = path.join(root, 'folder'); await fs.mkdir(dir);
  await store.bindProject(c.id, { requestId: 'bind', path: dir }); assert.equal(calls, 1);
  const saved = JSON.parse(await fs.readFile(store.file)); saved.version = 1; await fs.writeFile(store.file, JSON.stringify(saved));
  const next = new ConversationStore({ runtimeDir: root, omoRunner: async () => { calls++; }, catalogueReader: async () => catalogue }); await next.init();
  assert.equal(calls, 1); assert.equal(next.state.version, 3); assert.equal(next.state.conversations[0].id, c.id);
  assert.equal(JSON.parse(await fs.readFile(path.join(next.root, 'state.before-workbench-v2.json'))).version, 1);
});
test('旧自动长名称首次升级即收短，手动名、原消息与原名保留', async (t) => {
  const { root, store, c } = await fixture(t, async () => route());
  const text = '我想做一个每周饮食记录小工具。先讨论，不要开始做。希望记下食物和日期，然后看到本周的记录。';
  const old = text.slice(0, 48); c.title = old; delete c.titleSource; c.messages = [{ id: 'old-message', role: 'user', text }]; c.projectId = 'old-project';
  store.state.projects.push({ id: 'old-project', name: old, root: '/no-change-to-directory' });
  const manual = { ...structuredClone(c), id: 'manual', titleSource: 'manual' }; store.state.conversations.push(manual);
  store.state.version = 1; await store.save();
  const next = new ConversationStore({ runtimeDir: root, catalogueReader: async () => catalogue }); await next.init();
  const migrated = next.conversation(c.id);
  assert.equal(migrated.title, '每周饮食记录小工具'); assert.equal(migrated.legacyTitle, old);
  assert.deepEqual(migrated.messages, c.messages); assert.equal(next.conversation('manual').title, old);
  assert.equal(next.state.projects[0].name, migrated.title); assert.equal(next.state.projects[0].legacyName, old);
  assert.equal(next.state.projects[0].root, '/no-change-to-directory');
  await next.update(c.id, { title: '手动保留' });
  const reopened = new ConversationStore({ runtimeDir: root, catalogueReader: async () => catalogue }); await reopened.init();
  assert.equal(reopened.conversation(c.id).title, '手动保留');
});
test('无项目及非 Git 均可分支；历史与模型读取不带入截止点之后', async (t) => {
  const { root, store, c } = await fixture(t, async () => route());
  await store.send(c.id, { requestId: 'a', text: '旧主题' }); await drain(store);
  const cutoff = c.messages.at(-1).id;
  await store.send(c.id, { requestId: 'b', text: '不应进入分支的后续决定' }); await drain(store);
  const branch = await store.fork(c.id, { requestId: 'fork', messageId: cutoff });
  assert.equal(branch.messages.length, 2); assert.equal(branch.turns.length, 0); assert.equal(branch.projectId, null);
  const folder = path.join(root, 'plain-folder'); await fs.mkdir(folder);
  await store.bindProject(branch.id, { requestId: 'bind', path: folder });
  const history = await store.context(branch, { id: 'probe', references: [] });
  const content = await fs.readFile(path.join(history, `${branch.id}.txt`), 'utf8');
  assert(!content.includes('不应进入分支')); assert.equal(store.related(branch).length, 1);
  const second = await store.fork(branch.id, { requestId: 'plain', messageId: branch.messages.at(-1).id });
  assert.equal(second.projectId, branch.projectId); assert.equal(second.workspaceRoot, null);
  await assert.rejects(store.fork(branch.id, { requestId: 'isolated', messageId: branch.messages.at(-1).id, workspaceMode: 'isolated', worktreePath: path.join(root, 'isolated') }), /Git 项目/);
});
test('首条与后续编辑生成修订分支，原文保留且重发幂等', async (t) => {
  const { store, c } = await fixture(t, async () => route());
  await store.send(c.id, { requestId: 'a', text: '原第一条' }); await drain(store);
  await store.send(c.id, { requestId: 'b', text: '原第二条' }); await drain(store);
  const original = structuredClone(c.messages);
  const body = { requestId: 'edit', messageId: c.messages[0].id, text: '修订第一条，先讨论' };
  const edit = await store.fork(c.id, body); await drain(store); await store.fork(c.id, body); await drain(store);
  assert.deepEqual(c.messages, original); assert.equal(edit.turns.length, 1); assert.equal(edit.messages[0].text, body.text);
  assert(!edit.messages.some((m) => m.text === '原第二条'));
  const edit2 = await store.fork(c.id, { requestId: 'edit2', messageId: c.messages[2].id, text: '修订第二条，先讨论' }); await drain(store);
  assert.equal(edit2.messages[0].text, '原第一条'); assert.equal(edit2.messages[2].text, '修订第二条，先讨论');
});
test('普通及编辑分支材料可见可移除，实际读取副本同步且原对话保留', async (t) => {
  const { root, store, c } = await fixture(t, async () => route());
  const material = await store.attachMaterial(c.id, { requestId: 'material', name: 'fact.txt', base64: Buffer.from('纸鸢 642').toString('base64') });
  await store.send(c.id, { requestId: 'talk', text: '先讨论材料' }); await drain(store);
  for (const edit of [false, true]) {
    const branch = await store.fork(c.id, { requestId: `material-fork-${edit}`, messageId: c.messages[edit ? 0 : 1].id, ...(edit ? { text: '修改讨论内容' } : {}) }); await drain(store);
    assert.equal(store.view().conversations.find((v) => v.id === branch.id).materials[0].id, material.id);
    assert.notEqual(branch.materials[0], c.materials[0]);
    const before = await store.materialCopies(branch, path.join(root, `before-${edit}`));
    assert.equal(await fs.readFile(before[0].copy, 'utf8'), '纸鸢 642');
    await store.attachMaterial(branch.id, { removeId: material.id });
    assert.deepEqual(branch.materials, []); assert.deepEqual(await store.materialCopies(branch, path.join(root, `after-${edit}`)), []);
    assert.equal(c.materials[0].id, material.id); assert(c.readRoots.includes(material.path));
    assert.equal(await fs.readFile(material.path, 'utf8'), '纸鸢 642');
  }
});
test('旧分支补回隐藏材料，包括自行上传后及源记录移除后；分支移除后重开不复活', async (t) => {
  const { root, store, c } = await fixture(t, async () => route());
  const upload = (cid, requestId, text) => store.attachMaterial(cid, { requestId, name: `${requestId}.txt`, base64: Buffer.from(text).toString('base64') });
  const inherited = await upload(c.id, 'inherited', '原材料');
  await store.send(c.id, { requestId: 'talk', text: '先讨论' }); await drain(store);
  const branch = await store.fork(c.id, { requestId: 'legacy', messageId: c.messages.at(-1).id });
  const empty = await store.fork(c.id, { requestId: 'legacy-empty', messageId: c.messages.at(-1).id });
  branch.materials = []; delete empty.materials; // Reproduce the old saved schema in isolated fixture data.
  const own = await upload(branch.id, 'own', '分支材料');
  await store.attachMaterial(c.id, { removeId: inherited.id });
  const later = await upload(c.id, 'later', '后来材料');
  const reopen = async () => { const next = new ConversationStore({ runtimeDir: root, catalogueReader: async () => catalogue }); await next.init(); return next; };
  const next = await reopen(); const restored = next.conversation(branch.id);
  assert.deepEqual(restored.materials.map((m) => m.path).sort(), [inherited.path, own.path].sort());
  assert.equal(next.conversation(empty.id).materials[0].path, inherited.path);
  assert(!restored.readRoots.includes(later.path));
  await next.attachMaterial(branch.id, { removeId: inherited.id });
  const again = await reopen(); const current = again.conversation(branch.id);
  assert.deepEqual(current.materials.map((m) => m.path), [own.path]);
  const copies = await again.materialCopies(current, path.join(root, 'reopened-copies'));
  assert.deepEqual(copies.map((m) => m.source), [own.path]);
  assert.equal(again.conversation(c.id).materials[0].id, later.id);
  assert.equal(await fs.readFile(inherited.path, 'utf8'), '原材料');
});
test('引用冻结来源，归档改名不失效；无效模型或档位不保存消息', async (t) => {
  const { store, c } = await fixture(t, async () => route());
  await store.send(c.id, { requestId: 'a', text: '来源事实' }); await drain(store);
  const target = await store.create({ requestId: 'target' });
  const ref = { conversationId: c.id, messageId: c.messages[0].id };
  await store.send(target.id, { requestId: 'ref', text: '先讨论这份资料', references: [ref] }); await drain(store);
  await store.update(c.id, { title: '新名字', archived: true });
  assert.equal(target.turns[0].references[0].text, 'user: 来源事实');
  assert.equal(store.references([ref])[0].conversationId, c.id);
  const count = target.messages.length;
  await assert.rejects(store.send(target.id, { requestId: 'bad', text: '讨论', modelSelection: { provider: 'desktop-codex', model: 'gpt-6-sol', effort: 'ultra' } }), /强度/);
  assert.equal(target.messages.length, count);
});
test('两个窗口草稿独立，旧版本保存不能覆盖新输入', async (t) => {
  const { store, c } = await fixture(t, async () => route());
  await store.draft(c.id, { windowId: 'one', expectedRevision: 0, text: '窗口一' });
  await store.draft(c.id, { windowId: 'two', expectedRevision: 0, text: '窗口二' });
  await assert.rejects(store.draft(c.id, { windowId: 'one', expectedRevision: 0, text: '旧覆盖' }), /已有更新/);
  assert.equal(store.state.drafts[`${c.id}:one`].text, '窗口一'); assert.equal(store.state.drafts[`${c.id}:two`].text, '窗口二');
});
test('排队期间只问进度不取消原执行，同项目写入仍依次完成', async (t) => {
  let release; const hold = new Promise((resolve) => { release = resolve; }); let workers = 0;
  const { root, store, c } = await fixture(t, async (options) => {
    if (options.decisionOnly) return route(options.prompt.includes('Current user message: 先讨论：现在进度怎么样') ? 'discuss' : 'execute');
    if (options.role === 'Chat') return answer('正在排队，工作保留。');
    const ordinal = ++workers; if (ordinal === 1) await hold;
    const target = `result-${ordinal}.txt`; await fs.writeFile(path.join(options.cwd, target), '完成');
    await options.onBehaviorCheck({ requestId: target, caseJson: JSON.stringify({ caseId: `result-${ordinal}`, requirement: '结果', kind: 'document', target, expected: { includes: ['完成'] } }) }, options.signal); return answer('完成');
  });
  const until = async (condition) => { for (let n = 0; n < 200; n++) { if (condition()) return; await new Promise((resolve) => setTimeout(resolve, 10)); } throw new Error('受控工作未到达预期位置'); };
  const folder = path.join(root, 'shared'); await fs.mkdir(folder); const second = await store.create({ requestId: 'second' });
  for (const item of [c, second]) await store.bindProject(item.id, { requestId: item.id, path: folder });
  await store.send(c.id, { requestId: 'one', text: '直接制作第一份' }); await until(() => workers === 1);
  await store.send(second.id, { requestId: 'two', text: '直接制作第二份' }); await until(() => second.turns[0].status === 'waiting');
  await store.send(second.id, { requestId: 'progress', text: '先讨论：现在进度怎么样' }); await until(() => second.turns[1].status === 'completed');
  assert.equal(second.turns[0].status, 'waiting'); release(); await drain(store);
  assert.equal(workers, 2); assert.equal(second.turns[0].status, 'completed');
  assert.deepEqual((await fs.readdir(folder)).sort(), ['result-1.txt', 'result-2.txt']);
});
test('Git 分支确有独立工作目录，不复制后续原目录文件', async (t) => {
  const { root, store, c } = await fixture(t, async () => route()); const repo = path.join(root, 'repo'); await fs.mkdir(repo);
  execFileSync('/usr/bin/git', ['init', repo], { stdio: 'ignore' }); await fs.writeFile(path.join(repo, 'fact.txt'), 'baseline');
  execFileSync('/usr/bin/git', ['-C', repo, 'add', '.']); execFileSync('/usr/bin/git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'baseline'], { stdio: 'ignore' });
  await store.bindProject(c.id, { requestId: 'repo', path: repo }); await store.send(c.id, { requestId: 'talk', text: '先讨论' }); await drain(store);
  const material = await store.attachMaterial(c.id, { requestId: 'git-material', name: 'scope.txt', base64: Buffer.from('只读资料').toString('base64') });
  const body = { requestId: 'gitfork', messageId: c.messages.at(-1).id, workspaceMode: 'isolated', worktreePath: path.join(root, 'worktree') };
  const fork = await store.fork(c.id, body);
  assert.equal(fork.materials[0].id, material.id);
  await fs.writeFile(path.join(fork.workspaceRoot, 'fact.txt'), 'alternate');
  assert.equal(await fs.readFile(path.join(repo, 'fact.txt'), 'utf8'), 'baseline'); assert((await fs.readFile(path.join(fork.workspaceRoot, '.git'), 'utf8')).startsWith('gitdir:'));
  const oldWorkspace = fork.workspaceRoot;
  store.state.conversations = store.state.conversations.filter((v) => v.id !== fork.id);
  delete store.state.worktrees[0].conversation.materials; await store.save(); // Old pending worktree snapshot.
  const next = new ConversationStore({ runtimeDir: root, catalogueReader: async () => catalogue }); await next.init();
  const recovered = await next.fork(c.id, body); assert.equal(recovered.materials[0].id, material.id);
  await next.attachMaterial(recovered.id, { removeId: material.id }); assert.deepEqual(recovered.readRoots, []);
  const target = await next.create({ requestId: 'target' }); const targetRoot = path.join(root, 'target'); await fs.mkdir(targetRoot);
  await next.bindProject(target.id, { requestId: 'target-root', path: targetRoot });
  await next.update(recovered.id, { projectId: target.projectId });
  assert.equal(recovered.workspaceRoot, null); assert.equal(next.effectiveProject(recovered).root, await fs.realpath(targetRoot));
  assert.equal(await fs.readFile(path.join(oldWorkspace, 'fact.txt'), 'utf8'), 'alternate');
  assert.equal(await fs.readFile(path.join(repo, 'fact.txt'), 'utf8'), 'baseline');
});
test('助手只读范围由宿主快照限制，派工记录先于启动，取消不派工', async (t) => {
  let inspected = false;
  const { root, store, c } = await fixture(t, async (opts) => {
    assert.equal(opts.role, 'Chat'); assert.equal(opts.readRoots.length, 0); assert.equal(c.turns[0].children[0].status, 'working');
    assert.deepEqual(await fs.readdir(opts.cwd), ['allowed.txt']); inspected = true; return answer('已读 allowed.txt');
  });
  const folder = path.join(root, 'source'); await fs.mkdir(folder); await fs.writeFile(path.join(folder, 'allowed.txt'), 'a'); await fs.writeFile(path.join(folder, 'other.txt'), 'b');
  const parent = { id: 'parent', requestId: 'parent', modelSelection: { provider: 'desktop-codex', model: 'gpt-6-luna', effort: 'medium' }, children: [] }; c.turns.push(parent);
  const controller = new AbortController(); await store.delegate(c, parent, { requestId: 'child', task: '读 allowed', paths: ['allowed.txt'] }, folder, controller.signal);
  assert(inspected); assert.equal(parent.children[0].status, 'completed'); controller.abort();
  await assert.rejects(store.delegate(c, parent, { requestId: 'late', task: 'late', paths: ['.'] }, folder, controller.signal), /已停止/);
  await assert.rejects(guardWorkspaceToolCalls({ content: [{ type: 'toolCall', name: 'write', arguments: { path: 'allowed.txt', content: 'bad' } }] }, { role: 'Chat', rootPath: folder, conversation: true }), /outside its host allowlist/u);
});
test('所选模型和强度写入实际 CLI 指令说明，默认不变', () => {
  const options = buildCodexRoleInvocation('Chat', 'test', 'provider-decision', null, { model: 'gpt-6-sol', reasoningEffort: 'low' });
  assert(options.developerInstructions.includes('model: gpt-6-sol')); assert(options.developerInstructions.includes('effort: low'));
  assert(buildCodexRoleInvocation('Chat', 'test', 'provider-decision').developerInstructions.includes('model: gpt-6-luna'));
});
