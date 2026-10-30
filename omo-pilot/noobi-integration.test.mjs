import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ConversationStore, fileIndex, needsWriteReview } from './conversation-store.mjs';
import { ConversationPreviews } from './conversation-preview.mjs';
import { noobiWebCoverage, noobiAssetsForReview } from './noobi-verification.mjs';
import { noobiApprovalScopeError } from './noobi-permissions.mjs';

const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');
const gate = () => { let release; return { promise: new Promise((r) => { release = r; }), release: (...a) => release(...a) }; };
const selection = { provider: 'desktop-codex', model: 'gpt-6-luna', effort: 'medium' };
const request = { requestId: 'controlled-job', name: '隔离假边界游戏', prompt: '此处仅测试保存与停止，不证明真实制作' };
const input = (extra = {}) => ({ token: 'test-question', kind: 'input', method: 'item/tool/requestUserInput', createdAt: new Date().toISOString(), title: '选择玩法', details: { isBlocking: true, questions: [{ id: 'genre', question: '哪种玩法？', options: [{ label: '接球' }, { label: '躲避' }] }] }, ...extra });
test('损坏素材清单进入原工具的修复流程，不能当通过或重新生成要求', async (t) => {
  const base = new URL('../.irixi-runtime/noobi-specialist/', import.meta.url);
  const selected = JSON.parse(await fs.readFile(new URL('selected.json', base)));
  const { AssetStore } = await import(new URL(`${selected.directory}/dist/main/assetStore.js`, base));
  const { buildRequiredImageGenerationContract } = await import(new URL(`${selected.directory}/dist/main/gameHarness.js`, base));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-noobi-manifest-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'public/assets'), { recursive: true });
  const file = path.join(root, 'public/assets/asset-pack.json'), store = new AssetStore();
  for (const text of ['{"assets":[]}', '{']) {
    await fs.writeFile(file, text);
    const found = await noobiAssetsForReview(store, 'sample', root);
    assert.deepEqual(found.assets, []); assert.match(found.error, /ASSET_MANIFEST/);
    assert.equal(await fs.readFile(file, 'utf8'), text);
  }
  const contract = buildRequiredImageGenerationContract({ state: 'manifest-repair-required' });
  assert.match(contract, /unverified-manifest/); assert.doesNotMatch(contract, /You MUST invoke \$imagegen/);
  await fs.writeFile(file, JSON.stringify({ version: 1, projectId: 'sample', assets: [] }));
  assert.deepEqual(await noobiAssetsForReview(store, 'sample', root), { assets: [], error: null });
  await assert.rejects(noobiAssetsForReview({ list: async () => { throw new Error('outside scope'); } }, 'sample', root), /outside scope/);
});
async function fakeResult(o) {
  await fs.mkdir(path.join(o.workspace, 'dist'), { recursive: true });
  await fs.writeFile(path.join(o.workspace, 'dist/index.html'), '<h1>Controlled boundary fixture, not acceptance</h1>');
  const index = await fileIndex(o.workspace);
  return { status: 'completed', jobId: o.jobId, projectId: o.projectId, buildVersion: 'controlled-test', modelSelection: o.modelSelection, entrypoint: 'dist/index.html',
    verification: { ok: true, build: { ok: true }, visual: { ok: true }, image: { ok: true }, playtest: { verdict: 'pass' }, checkedFiles: { 'dist/index.html': index['dist/index.html'] } } };
}
async function fixture(t, runner = fakeResult) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-noobi-controlled-'));
  const store = new ConversationStore({ runtimeDir: root, noobiRunner: runner, catalogueReader: async () => ({ models: [{ id: selection.model, provider: selection.provider, efforts: ['medium'], defaultEffort: 'medium' }] }), omoRunner: () => { throw new Error('No real model permitted'); } });
  await store.init();
  const c = await store.create({ requestId: 'test-conversation', colleagueId: 'reviewer' });
  const original = path.join(root, 'original'), workspace = path.join(root, 'workspace');
  await fs.mkdir(original); await fs.mkdir(workspace);
  await store.bindProject(c.id, { requestId: 'project', path: original });
  const turn = { id: 'controlled-turn', projectId: c.projectId, intent: 'execute', status: 'working', workspace, modelSelection: selection, processes: [], events: [], receipts: [], calls: [], createdAt: new Date().toISOString() };
  c.turns.push(turn); const controller = new AbortController(); store.controllers.set(turn.id, controller);
  await store.save();
  t.after(async () => { controller.abort(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, store, c, turn, controller, run: () => store.runNoobi(c, turn, request, workspace, controller.signal) };
}
test('Noobi 重复请求不重复启动，变更请求或外作业身份不被采用', async (t) => {
  let calls = 0; const f = await fixture(t, async (o) => { calls++; return fakeResult(o); });
  const first = await f.run(); assert.equal((await f.run()).jobId, first.jobId); assert.equal(calls, 1);
  await assert.rejects(f.store.runNoobi(f.c, f.turn, { ...request, name: 'different' }, f.turn.workspace, f.controller.signal), /不同/);
  f.store.noobiRunner = async (o) => ({ ...await fakeResult(o), projectId: 'foreign' });
  await assert.rejects(f.store.runNoobi(f.c, f.turn, { ...request, requestId: 'foreign' }, f.turn.workspace, f.controller.signal), /完整构建/);
  assert.equal(f.turn.noobiJobs[1].status, 'failed');
});
test('小游戏证据不覆盖无关脚本，完成保存失败不遗留通过检查或完成摘要', async (t) => {
  const f = await fixture(t); await fs.writeFile(path.join(f.turn.workspace, 'unrelated.py'), 'raise Exception("untested")');
  await f.run();
  assert.equal(needsWriteReview({ content: [{ type: 'text', text: 'done' }] }, [], { changed: true, changedFiles: ['unrelated.py'], version: f.turn.functionalChecks[0].version, checks: f.turn.functionalChecks }), true);
  const g = await fixture(t); const save = g.store.save.bind(g.store); let once = true;
  g.store.save = async () => { if (once && g.turn.noobiJobs?.some((j) => j.status === 'completed')) { once = false; throw new Error('controlled complete save failure'); } return save(); };
  await assert.rejects(g.run(), /complete save failure/);
  const saved = JSON.parse(await fs.readFile(g.store.file)); const stored = saved.conversations[0].turns[0];
  assert.equal(stored.noobiJobs[0].status, 'failed'); assert.equal(stored.noobiJobs[0].summary, undefined);
  assert.equal((stored.functionalChecks || []).some((c) => c.status === 'passed'), false); assert.equal(stored.artifactEntrypoint, undefined);
});
test('结构化答案校验后传递，收到执行端回执才显示答复送达', async (t) => {
  const ready = gate(); let answer;
  const f = await fixture(t, async (o) => { const pending = o.onApproval(input(), o.signal); ready.release(); answer = await pending; await o.onEvent({ type: 'noobi_approval_resolved', token: 'test-question', decision: answer.decision }); return fakeResult(o); });
  const work = f.run(); work.catch(() => {}); await ready.promise;
  while (!f.store.noobiApprovals.size) await new Promise((r) => setTimeout(r, 5));
  await assert.rejects(f.store.resolveNoobiApproval(f.c.id, { token: 'test-question', decision: 'accept' }), /请回答/);
  assert.equal(f.turn.noobiJobs[0].approvals[0].status, 'pending');
  const submitted = await f.store.resolveNoobiApproval(f.c.id, { token: 'test-question', decision: 'accept', answers: { genre: ['接球'] } });
  assert.equal(submitted.status, 'submitting'); await work;
  assert.deepEqual(answer, { decision: 'accept', answers: { genre: ['接球'] } });
  assert.equal(f.turn.noobiJobs[0].approvals[0].status, 'accept'); assert.ok(f.turn.noobiJobs[0].approvals[0].deliveredAt);
});
test('批准保存失败不留下失效卡片；批准保存期间停止不返回批准成功', async (t) => {
  const f = await fixture(t, async (o) => { await o.onApproval(input(), o.signal); return fakeResult(o); });
  const save = f.store.save.bind(f.store); let once = true;
  f.store.save = async () => { if (once && f.turn.noobiJobs?.[0]?.approvals.length) { once = false; throw new Error('controlled pending save failure'); } return save(); };
  await assert.rejects(f.run(), /pending save failure/); assert.equal(f.turn.noobiJobs[0].approvals.length, 0);
  const gateSave = gate(), reachedSave = gate(), ready = gate();
  const g = await fixture(t, async (o) => { const p = o.onApproval(input(), o.signal); ready.release(); await p; throw new Error('must not continue'); });
  const work = g.run(); work.catch(() => {}); await ready.promise;
  while (!g.store.noobiApprovals.size) await new Promise((r) => setTimeout(r, 5));
  const saveG = g.store.save.bind(g.store); let held = false;
  g.store.save = async () => { if (!held && g.turn.noobiJobs[0].approvals[0]?.status === 'submitting') { held = true; reachedSave.release(); await gateSave.promise; } return saveG(); };
  const approving = g.store.resolveNoobiApproval(g.c.id, { token: 'test-question', decision: 'accept', answers: { genre: ['接球'] } }); approving.catch(() => {});
  await reachedSave.promise; await g.store.stop(g.c.id); gateSave.release();
  await assert.rejects(approving, /已停止/); await assert.rejects(work, /已停止/);
  assert.equal(g.turn.noobiJobs[0].approvals[0].status, 'cancelled');
});
test('Noobi 已停止的迟到成功回执不会留下成果检查', async (t) => {
  const f = await fixture(t, async (o) => { const result = await fakeResult(o); f.controller.abort(); return result; });
  await assert.rejects(f.run(), /已停止/); assert.equal(f.turn.noobiJobs[0].status, 'stopped'); assert.equal(f.turn.functionalChecks, undefined);
});
test('答复提交后执行端失败会结束未送达状态，重开不误报批准', async (t) => {
  const ready = gate();
  const f = await fixture(t, async (o) => {
    const pending = o.onApproval(input(), o.signal); ready.release(); await pending;
    throw new Error('controlled worker failure before acknowledgement');
  });
  const work = f.run(); work.catch(() => {}); await ready.promise;
  while (!f.store.noobiApprovals.size) await new Promise((r) => setTimeout(r, 5));
  await f.store.resolveNoobiApproval(f.c.id, { token: 'test-question', decision: 'accept', answers: { genre: ['接球'] } });
  await assert.rejects(work, /before acknowledgement/);
  const approval = f.turn.noobiJobs[0].approvals[0];
  assert.equal(approval.status, 'failed'); assert.equal(approval.deliveredAt, undefined);
  f.turn.status = 'failed'; await f.store.save();
  const reopened = new ConversationStore({ runtimeDir: f.root, omoRunner: () => { throw new Error('No real model permitted'); } });
  await reopened.init();
  assert.equal(reopened.state.conversations[0].turns[0].noobiJobs[0].approvals[0].status, 'failed');
  // Old saved failures may predate the terminal-status repair.
  approval.status = 'submitting'; await f.store.save();
  const migrated = new ConversationStore({ runtimeDir: f.root, omoRunner: () => { throw new Error('No real model permitted'); } });
  await migrated.init();
  assert.equal(migrated.state.conversations[0].turns[0].noobiJobs[0].approvals[0].status, 'interrupted');
});
test('非阻塞问题不阻塞整项工作；私密输入与未接通 MCP 不接受', async (t) => {
  const f = await fixture(t); const job = { status: 'running', approvals: [], events: [] };
  for (const details of [{ questions: [{ isSecret: true }] }, {}]) {
    const answer = await f.store.waitForNoobiApproval(f.c, f.turn, job, input({ details, ...(details.questions ? {} : { method: 'mcpServer/elicitation/request' }) }), f.controller.signal);
    assert.equal(answer.decision, 'decline'); assert.equal(job.approvals.length, 0);
  }
  const pending = f.store.waitForNoobiApproval(f.c, f.turn, job, input({ details: { ...input().details, isBlocking: false } }), f.controller.signal); pending.catch(() => {});
  while (!f.store.noobiApprovals.size) await new Promise((r) => setTimeout(r, 5));
  assert.equal(f.turn.status, 'working'); assert.equal(job.status, 'running');
  await f.store.resolveNoobiApproval(f.c.id, { token: 'test-question', decision: 'decline' }); assert.deepEqual(await pending, { decision: 'decline' });
});
test('批准不能把外部目录、符号链接或无范围的提权命令放进小游戏权限', async (t) => {
  const f = await fixture(t), workspace = await fs.realpath(f.turn.workspace), outside = path.join(await fs.realpath(f.root), 'outside'); await fs.mkdir(outside);
  await fs.symlink(outside, path.join(workspace, 'link'));
  const scope = { workspace, temporary: path.join(await fs.realpath(f.root), 'tmp'), imageSkillDirectory: path.join(await fs.realpath(f.root), 'skill') };
  const permission = (target) => ({ method: 'item/permissions/requestApproval', params: { permissions: { fileSystem: { read: [target] } } } });
  assert.equal(await noobiApprovalScopeError(permission(path.join(workspace, 'new/file')), scope), null);
  assert.match(await noobiApprovalScopeError(permission(outside), scope), /超出/);
  assert.match(await noobiApprovalScopeError(permission(path.join(workspace, 'link/file')), scope), /超出/);
  assert.match(await noobiApprovalScopeError({ method: 'item/commandExecution/requestApproval', params: { cwd: f.turn.workspace, command: 'cat outside' } }, scope), /隔离/);
  assert.match(await noobiApprovalScopeError({ method: 'item/permissions/requestApproval', params: { permissions: { fileSystem: { entries: [{ access: 'read', path: { type: 'special', value: ':root' } }] } } } }, scope), /特殊/);
});
test('试玩覆盖仅从实际加载文件和精确源码映射建立', async (t) => {
  const f = await fixture(t), root = f.turn.workspace;
  await fs.mkdir(path.join(root, 'dist/assets'), { recursive: true }); await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'dist/index.html'), '<script src="/assets/a.js"></script>');
  await fs.writeFile(path.join(root, 'dist/assets/a.js'), 'console.log(1);\n//# sourceMappingURL=a.js.map');
  await fs.writeFile(path.join(root, 'src/main.ts'), 'const n: number = 1; console.log(n);');
  await fs.writeFile(path.join(root, 'unrelated.py'), 'print(5)');
  await fs.writeFile(path.join(root, 'dist/assets/a.js.map'), JSON.stringify({ sources: ['../../src/main.ts'], sourcesContent: ['const n: number = 1; console.log(n);'] }));
  const urls = ['http://127.0.0.1:9001/', 'http://127.0.0.1:9001/assets/a.js', 'http://evil.invalid/unrelated.py'];
  const files = await noobiWebCoverage(root, urls[0], urls);
  assert.ok(files['dist/index.html']); assert.ok(files['src/main.ts']); assert.equal(files['unrelated.py'], undefined);
  await fs.writeFile(path.join(root, 'src/main.ts'), 'changed'); await assert.rejects(noobiWebCoverage(root, urls[0], urls), /源码版本不同/);
});
test('生产目录预览支持绝对资源地址，旧文件入口仍保持原义且不混版本', async (t) => {
  const f = await fixture(t); await fs.mkdir(path.join(f.turn.workspace, 'dist/assets'), { recursive: true });
  await fs.writeFile(path.join(f.turn.workspace, 'dist/index.html'), '<script src="/assets/main.js"></script>');
  await fs.writeFile(path.join(f.turn.workspace, 'dist/assets/main.js'), 'window.game=true;');
  await fs.writeFile(path.join(f.turn.workspace, 'index.html'), 'original source');
  Object.assign(f.turn, { artifactEntrypoint: 'dist/index.html', adoptedAt: new Date().toISOString(), resultIndex: await fileIndex(f.turn.workspace) });
  const previews = new ConversationPreviews(f.store); t.after(() => previews.close()); const port = await previews.ensure(f.store.project(f.c));
  const origin = `http://127.0.0.1:${port}`, url = `${origin}/v/${f.turn.id}/__run__/index.html`;
  assert.match(await (await fetch(url)).text(), /assets\/main.js/);
  const asset = await fetch(`${origin}/assets/main.js`, { headers: { referer: url } }); assert.equal(asset.status, 200); assert.equal(await asset.text(), 'window.game=true;');
  assert.equal(await (await fetch(`${origin}/v/${f.turn.id}/index.html`)).text(), 'original source');
  await fs.writeFile(path.join(f.turn.workspace, 'dist/assets/main.js'), 'changed');
  assert.equal((await fetch(`${origin}/v/${f.turn.id}/__run__/assets/main.js`)).status, 409);
});
