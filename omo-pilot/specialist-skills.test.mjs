import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { captureLearningSkill, readLearningSnapshot, learningSkillPrompt } from './specialist-skills.mjs';
import { ConversationStore } from './conversation-store.mjs';

const catalogue = { models: [{ provider: 'desktop-codex', id: 'gpt-6-luna', efforts: ['medium'], defaultEffort: 'medium' }] };
const reply = (text) => ({ status: 'model_returned', output: { text }, sessionId: 'controlled-skill-test' });
const route = () => reply(JSON.stringify({ mode: 'discuss', title: '学习快照', reply: '成立。', readPaths: [] }));
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-skill-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sources = { skill: path.join(root, 'SKILL.md'), rules: path.join(root, 'AGENTS.md') };
  await fs.writeFile(sources.skill, '# 学习\n规则版本一。普通执行不转教学。');
  await fs.writeFile(sources.rules, '# Private\nPRIVATE_BEFORE\n## 讨论、解释与纠错的约束\n成立就停止。\n### 例子\n保留条件。\n## Private\nPRIVATE_AFTER');
  return { root, sources };
}

test('只提供指定技能和依赖标题节；同轮冻结，下一轮采用更新版本', async (t) => {
  const { root, sources } = await fixture(t);
  const first = await captureLearningSkill(path.join(root, 'turn-one'), sources);
  const prompt = learningSkillPrompt(first);
  assert.match(prompt, /成立就停止/); assert.match(prompt, /保留条件/);
  assert.doesNotMatch(prompt, /PRIVATE_BEFORE|PRIVATE_AFTER/);
  await fs.writeFile(sources.skill, '规则版本二');
  const same = await captureLearningSkill(path.join(root, 'turn-one'), sources);
  assert.equal(same.version, first.version); assert.match(learningSkillPrompt(same), /规则版本一/);
  const next = await captureLearningSkill(path.join(root, 'turn-two'), sources);
  assert.notEqual(next.version, first.version); assert.match(learningSkillPrompt(next), /规则版本二/);
  const disk = JSON.parse(await fs.readFile(first.snapshotPath, 'utf8'));
  disk.sources[0].text = 'tampered'; await fs.writeFile(first.snapshotPath, JSON.stringify(disk));
  await assert.rejects(readLearningSnapshot(first), /快照不完整/);
});

test('依赖失效、链接和超大来源拒绝装载，不递归访问其他来源', async (t) => {
  const { root, sources } = await fixture(t);
  await fs.writeFile(sources.rules, '# 其他内容');
  await assert.rejects(captureLearningSkill(path.join(root, 'missing-heading'), sources), /标题不存在/);
  const link = path.join(root, 'link'); await fs.symlink(sources.skill, link);
  await assert.rejects(captureLearningSkill(path.join(root, 'link-turn'), { ...sources, skill: link }), /含链接/);
  await fs.writeFile(sources.skill, 'x'.repeat(128 * 1024 + 1));
  await assert.rejects(captureLearningSkill(path.join(root, 'huge'), sources), /允许大小/);
});

test('正常学习对话的分类与回答使用同一快照，下一轮更新；页面不泄露全文', async (t) => {
  const { root, sources } = await fixture(t); const prompts = [];
  const store = new ConversationStore({ runtimeDir: path.join(root, 'runtime'), skillSources: sources, catalogueReader: async () => catalogue,
    omoRunner: async (options) => {
      prompts.push(options.prompt);
      if (options.decisionOnly) { await fs.writeFile(sources.skill, '规则版本二'); return route(); }
      return reply('成立。停止扩展。');
    } });
  await store.init(); const c = await store.create({ requestId: 'create', colleagueId: 'researcher' });
  const project = path.join(root, 'project'); await fs.mkdir(project);
  await store.bindProject(c.id, { requestId: 'bind', path: project });
  await store.send(c.id, { requestId: 'one', text: '先讨论，我理解对吗？' });
  while (store.jobs.size) await Promise.all([...store.jobs.values()]);
  assert.equal(c.turns[0].status, 'completed'); assert.equal(prompts.length, 2);
  assert.ok(prompts.every((p) => p.includes('规则版本一') && !p.includes('规则版本二')));
  assert.equal(c.turns[0].skills.length, 1); assert.equal(c.turns[0].skills[0].sources.length, 2);
  assert.ok(store.view().conversations[0].turns[0].skills[0].sources.every((s) => !Object.hasOwn(s, 'text')));
  const previousVersion = c.turns[0].skills[0].version;
  await store.send(c.id, { requestId: 'two', text: '先解释一下' });
  while (store.jobs.size) await Promise.all([...store.jobs.values()]);
  assert.notEqual(c.turns[1].skills[0].version, previousVersion);
  assert.ok(prompts.slice(2).every((p) => p.includes('规则版本二')));
});

test('其他角色不预载学习规则；学习加载或保存失败不启动模型', async (t) => {
  const { root, sources } = await fixture(t); let calls = 0;
  const store = new ConversationStore({ runtimeDir: path.join(root, 'runtime'), skillSources: { ...sources, skill: path.join(root, 'absent') },
    catalogueReader: async () => catalogue, omoRunner: async () => { calls++; return route(); } });
  await store.init(); const writer = await store.create({ requestId: 'writer', colleagueId: 'writer' });
  await store.send(writer.id, { requestId: 'w', text: '讨论工具' });
  while (store.jobs.size) await Promise.all([...store.jobs.values()]);
  assert.equal(calls, 1); assert.equal(writer.turns[0].skills, undefined);
  const learner = await store.create({ requestId: 'learner', colleagueId: 'researcher' });
  await store.send(learner.id, { requestId: 'l', text: '解释概念' });
  while (store.jobs.size) await Promise.all([...store.jobs.values()]);
  assert.equal(calls, 1); assert.equal(learner.turns[0].status, 'failed');
  store.skillSources = sources; const originalSave = store.save.bind(store); let failed = false;
  store.save = async () => { if (!failed && learner.turns.at(-1)?.skills?.length) { failed = true; throw new Error('controlled save failure'); } return originalSave(); };
  await store.send(learner.id, { requestId: 'save-fail', text: '解释概念' });
  while (store.jobs.size) await Promise.all([...store.jobs.values()]);
  assert.equal(calls, 1); assert.equal(learner.turns.at(-1).status, 'failed');
  assert.equal(learner.turns.at(-1).events.filter((e) => e.type === 'skill_loaded').length, 0);
});

test('自动交接和助手沿用同一用户轮的规则，不随接手或派工更新', async (t) => {
  const { root, sources } = await fixture(t); const seen = [];
  const store = new ConversationStore({ runtimeDir: path.join(root, 'runtime'), skillSources: sources, catalogueReader: async () => catalogue,
    omoRunner: async (o) => {
      if (o.decisionOnly) return reply(JSON.stringify({ mode: 'discuss', reply: '准备交接', readPaths: [], handoffTo: 'researcher' }));
      seen.push(o.prompt);
      if (o.prompt.includes('交接资料：')) {
        const f = JSON.parse(o.prompt.match(/交接资料：([^\n]+)/u)[1]);
        await fs.writeFile(sources.skill, '规则版本二');
        return reply(JSON.stringify({ accepted: true, transferId: f.transferId, workId: f.workId, ownerRevision: f.ownerRevision, stopEpoch: f.stopEpoch, summary: '已接到讨论' }));
      }
      return reply('成立。');
    } });
  await store.init(); const c = await store.create({ requestId: 'writer', colleagueId: 'writer' });
  await store.send(c.id, { requestId: 'handoff', text: '先讨论，请学习同事讲解' });
  while (store.jobs.size) await Promise.all([...store.jobs.values()]);
  assert.equal(c.turns[0].status, 'completed'); assert.equal(seen.length, 2);
  assert.ok(seen.every((p) => p.includes('规则版本一') && !p.includes('规则版本二')));
  const parent = c.turns[0]; const workspace = path.join(root, 'project'); await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, 'notes.txt'), 'review');
  await store.delegate(c, parent, { requestId: 'child', task: '检查材料', paths: ['notes.txt'] }, workspace, new AbortController().signal);
  assert.match(seen.at(-1), /规则版本一/); assert.doesNotMatch(seen.at(-1), /规则版本二/);
  assert.equal(parent.skills[0].version, c.handoffRuns[0].skills[0].version);
  assert.equal(parent.skills[0].version, parent.children[0].skills[0].version);
});
