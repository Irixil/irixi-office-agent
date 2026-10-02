import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { activeGoal, addMaterial, createStore, createTask } from '../core.mjs';
import { applyModelPlan, sessionInput, validateModelPlan, validateWorkResult } from '../orchestration.mjs';
import { runAuthorizedTools, safeCalculate } from '../tools.mjs';

function plan() {
  return {
    summary: '先核对与计算，再形成候选并独立审阅。', outputKind: 'document', deliverables: ['document', 'spreadsheet'],
    roles: [
      { key: 'analyst', name: '成本分析员', mission: '核对材料并计算', capabilities: ['材料核对', '确定性计算'], recruitmentReason: '目标包含报价比较与总价计算。' },
      { key: 'author', name: '成果编辑', mission: '形成两种候选成果', capabilities: ['文档', '表格'], recruitmentReason: '目标要求文档与电子表格。' },
      { key: 'auditor', name: '独立审阅员', mission: '重新核对候选', capabilities: ['审阅'], recruitmentReason: '确认前需要独立核对。' },
      { key: 'courier', name: '交付事务员', mission: '等待确认后导出', capabilities: ['版本交付'], recruitmentReason: '守住确认边界。' },
    ],
    steps: [
      { key: 'extract', title: '提取报价输入', kind: 'research', role: 'analyst', dependsOn: [], tools: ['materials.read'], acceptanceCriteria: ['记录单价、数量和运费的原文位置'], expectedResult: '带来源的报价输入' },
      { key: 'calculate', title: '计算采购总价', kind: 'analysis', role: 'analyst', dependsOn: ['extract'], tools: ['calculate'], acceptanceCriteria: ['使用带来源输入计算总价'], expectedResult: '确定性总价' },
      { key: 'synthesize', title: '形成候选成果', kind: 'synthesis', role: 'author', dependsOn: ['calculate'], tools: [], acceptanceCriteria: ['同时形成说明文档和电子表格'], expectedResult: '两种候选成果' },
      { key: 'review', title: '独立核对', kind: 'review', role: 'auditor', dependsOn: ['synthesize'], tools: ['materials.read', 'calculate'], acceptanceCriteria: ['重新核对来源与总价'], expectedResult: '逐项审阅记录' },
      { key: 'deliver', title: '等待确认后导出', kind: 'delivery', role: 'courier', dependsOn: ['review'], tools: [], acceptanceCriteria: ['只导出用户确认的版本'], expectedResult: '待确认交付' },
    ],
  };
}

test('模型计划必须是无环且所有必需分支汇入候选成果', () => {
  const task = createTask({ goal: '比较报价并形成说明文档与电子表格' });
  assert.equal(validateModelPlan(task, plan()).steps.length, 5);
  const orphan = plan();
  orphan.steps.splice(1, 0, { key: 'unused', title: '孤立分析', kind: 'analysis', role: 'analyst', dependsOn: [], tools: [], acceptanceCriteria: ['形成结果'], expectedResult: '孤立结果' });
  assert.throws(() => validateModelPlan(task, orphan), /没有汇入候选成果/);
  const selfReview = plan();
  selfReview.steps.find((step) => step.kind === 'review').role = selfReview.steps.find((step) => step.kind === 'synthesis').role;
  assert.throws(() => validateModelPlan(task, selfReview), /不能自审/);
});

test('关联任务的结构化项目冲突会停下且不生成可运行计划', () => {
  const task = createTask({ goal: '继续采购核验' });
  task.projectRootTaskId = 'task-root';
  task.projectRootGoalVersionId = 'goal-root-recruiting';
  task.projectRootInputFingerprint = 'root-input-recruiting';
  const conflict = plan();
  conflict.projectAlignment = { status: 'conflict', explanation: '项目根目标已经改为招聘，采购核验与其冲突。' };
  const result = applyModelPlan(task, conflict);
  assert.deepEqual(result, []);
  assert.equal(task.status, 'waiting_user');
  assert.equal(task.plan, null);
  assert.ok(task.events.some((item) => item.type === 'project.goal_conflict' && item.detail.rootGoalVersionId === 'goal-root-recruiting'));
});

test('重规划同 key 但材料正文改变时不复用旧结果，下游也随之失效', () => {
  const task = createTask({ goal: '比较报价并形成说明文档与电子表格' });
  const material = addMaterial(task, { name: '报价', text: '单价 3600 元，数量 5，运费 400 元。' });
  applyModelPlan(task, plan());
  for (const item of task.workItems.filter((entry) => ['extract', 'calculate'].includes(entry.stepKey))) { item.status = 'completed'; item.result = { output: item.stepKey }; }
  material.text = '单价 3500 元，数量 5，运费 900 元。';
  applyModelPlan(task, plan(), { reason: 'gap_replan', preserveCompleted: true });
  assert.equal(task.workItems.find((item) => item.stepKey === 'extract').reusedFromWorkItemId, null);
  assert.equal(task.workItems.find((item) => item.stepKey === 'calculate').reusedFromWorkItemId, null);
});

test('重规划输入只携带最近同步骤历史，不重复灌入其他步骤结果', () => {
  const task = createTask({ goal: '比较报价并形成说明文档与电子表格' });
  applyModelPlan(task, plan());
  const item = task.workItems.find((entry) => entry.stepKey === 'synthesize');
  const makeHistory = (stepKey, marker) => ({
    stepKey, title: stepKey, kind: 'analysis', role: 'analyst', status: 'completed', goalVersionId: item.goalVersionId,
    sourceContextFingerprint: item.sourceContextFingerprint, inputFingerprint: marker, acceptanceCriteria: ['完成'], expectedResult: '结果',
    result: { summary: marker, output: marker.repeat(20_000) },
  });
  task.workHistory = [{ items: [makeHistory('extract', 'other-a'), makeHistory('calculate', 'other-b'), makeHistory('synthesize', 'old'), makeHistory('synthesize', 'latest')] }];
  const input = sessionInput(task, item);
  assert.equal(input.historicalCompletedEvidence.length, 1);
  assert.equal(input.historicalCompletedEvidence[0].stepKey, 'synthesize');
  assert.equal(input.historicalCompletedEvidence[0].result.summary, 'latest');
  assert.equal(input.historicalCompletedEvidence[0].result.output.length, 12_000);
});

test('受控计算器核对完整数值和原文位置，拒绝把 36 当成 3600', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-tools-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = createStore(root); await store.init();
  const task = createTask({ goal: '计算采购总价' });
  const material = addMaterial(task, { name: '报价', text: '单价 3600 元，数量 5，运费 400 元。' });
  const item = { title: '计算总价', expectedResult: '总价', tools: ['calculate'] };
  const valid = await runAuthorizedTools(store, task, item, [{ id: 'calc-1', tool: 'calculate', reason: '计算总价', args: { expression: 'price*quantity+freight', inputs: [
    { name: 'price', value: 3600, sourceRef: `material:${material.id}#L1-L1` },
    { name: 'quantity', value: 5, sourceRef: `material:${material.id}#L1-L1` },
    { name: 'freight', value: 400, sourceRef: `material:${material.id}#L1-L1` },
  ] } }]);
  assert.equal(valid[0].result.result, 18400);
  const invalid = await runAuthorizedTools(store, task, item, [{ id: 'calc-2', tool: 'calculate', reason: '伪造输入', args: { expression: 'price+freight', inputs: [
    { name: 'price', value: 36, sourceRef: `material:${material.id}#L1-L1` },
    { name: 'freight', value: 400, sourceRef: `material:${material.id}#L1-L1` },
  ] } }]);
  assert.equal(invalid[0].ok, false);
  assert.match(invalid[0].error, /完整数值/);
  assert.equal(safeCalculate('(3600*5)+400'), 18400);
});

test('工具请求与最终结果互斥，最终结果逐条覆盖步骤验收标准', () => {
  const item = { acceptanceCriteria: ['有来源', '有结论'] };
  assert.throws(() => validateWorkResult(item, { output: '提前结论', gap: '', acceptanceChecks: [], deliverables: [], toolRequests: [{ id: 'x' }] }), /不能同时/);
  assert.equal(validateWorkResult(item, { output: '完整结果', gap: '', toolRequests: [], deliverables: [], acceptanceChecks: [
    { criterion: '有来源', passed: true, evidence: '材料 A L1' },
    { criterion: '有结论', passed: true, evidence: '结论已形成' },
  ] }).stage, 'final');
});

test('公开搜索发现不能直接冒充原站证据，已读正文后才可完成', () => {
  const item = { acceptanceCriteria: ['形成有原站证据的结论'] };
  const result = { output: '根据搜索结果形成结论。', gap: '', toolRequests: [], deliverables: [], acceptanceChecks: [
    { criterion: '形成有原站证据的结论', passed: true, evidence: '搜索发现了候选页面' },
  ] };
  const search = { tool: 'web.search', ok: true, evidenceType: 'discovery', result: { status: 'ok', sources: [{ url: 'https://example.com/report' }] } };
  assert.throws(() => validateWorkResult(item, result, { toolCalls: [search] }), /web\.read/);
  const read = { tool: 'web.read', ok: true, evidenceType: 'material', sources: ['material:material-proof#L1-L2'] };
  assert.equal(validateWorkResult(item, result, { toolCalls: [search, read] }).stage, 'final');
  const noResults = { tool: 'web.search', ok: true, evidenceType: 'discovery', result: { status: 'no_results', sources: [] } };
  assert.equal(validateWorkResult(item, { ...result, output: '本次受控搜索没有发现候选页面。' }, { toolCalls: [noResults] }).stage, 'final');
});

test('任务存储串行化同一任务的并发修改', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-store-lock-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = createStore(root); await store.init();
  const task = createTask({ goal: '验证并发写入' }); await store.save(task);
  await Promise.all(Array.from({ length: 12 }, (_, index) => store.mutate(task.id, async (draft) => {
    const value = draft.memoryEntries.length; await new Promise((resolve) => setTimeout(resolve, index % 3));
    draft.memoryEntries.push({ id: `m-${value}`, status: 'active' });
  })));
  assert.equal((await store.get(task.id)).memoryEntries.length, 12);
});

test('指定材料先于全局字符预算选取，长材料不会饿死后加材料', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-material-read-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = createStore(root); await store.init();
  const task = createTask({ goal: '读取指定材料' });
  addMaterial(task, { name: '长材料', text: '合成正文数据\n'.repeat(22_000) });
  const last = addMaterial(task, { name: '后加材料', text: '最后一份材料的唯一内容' });
  const item = { tools: ['materials.read'] };
  const readLast = await runAuthorizedTools(store, task, item, [{ id: 'read-last', tool: 'materials.read', args: { materialIds: [last.id] } }]);
  assert.equal(readLast[0].ok, true);
  assert.equal(readLast[0].result[0].materialId, last.id);
  assert.match(readLast[0].result[0].excerpt, /唯一内容/);
  const continued = await runAuthorizedTools(store, task, item, [{ id: 'read-long', tool: 'materials.read', args: { materialIds: [task.materials[0].id], startLine: 2001, maxLines: 10 } }]);
  assert.equal(continued[0].result[0].locator, 'L2001-L2010');
  assert.equal(continued[0].result[0].nextStartLine, 2011);
  const missing = await runAuthorizedTools(store, task, item, [{ id: 'missing', tool: 'materials.read', args: { materialIds: ['material-missing'] } }]);
  assert.equal(missing[0].ok, false);
  assert.match(missing[0].error, /不存在或不可读/);
  const oneLongLine = addMaterial(task, { name: '单行过长', text: `${'甲'.repeat(130_000)}结尾唯一事实` });
  const refused = await runAuthorizedTools(store, task, item, [{ id: 'one-long-line', tool: 'materials.read', args: { materialIds: [oneLongLine.id] } }]);
  assert.equal(refused[0].ok, false);
  assert.match(refused[0].error, /单行超过可读上限/);
});

test('授权材料检索先全量排序并返回长文尾部与超长单行的可定位窗口', async () => {
  const task = createTask({ goal: '定位最相关材料' });
  for (let index = 1; index <= 35; index += 1) addMaterial(task, { name: `弱材料${index}`, text: `预算一般说明 ${index}` });
  const strong = addMaterial(task, { name: '后加强材料', text: '项目预算的核心风险是许可证到期。' });
  const chinese = addMaterial(task, { name: '中文材料', text: '供应商的交付周期需要单独核定。' });
  const shortTerms = addMaterial(task, { name: '短词材料', text: 'AI 项目在 Q3 有 7 项交付。' });
  const longLine = addMaterial(task, { name: '超长单行', text: `${'甲'.repeat(130_000)}唯一尾标 2027Q4，责任人为周宁。` });
  const tail = addMaterial(task, { name: '长文尾部', text: `${Array.from({ length: 70 }, (_, index) => `第${index + 1}行普通说明`).join('\n')}\n最终交付日为 2027-11-05，负责人为李明。` });
  const titleOnly = addMaterial(task, { name: '标题唯一标记', text: Array.from({ length: 100 }, (_, index) => `第${index + 1}行无关正文`).join('\n') });
  addMaterial(task, { name: '全角材料', text: `${'无关'.repeat(2_500)}ＡＢＣ` });
  const unicodeOffset = addMaterial(task, { name: 'Unicode偏移材料', text: `${'İ'.repeat(2_000)}ABC尾部原文` });
  const item = { title: '检索', expectedResult: '原文片段', tools: ['materials.search'] };
  const search = async (id, query) => (await runAuthorizedTools({}, task, item, [{ id, tool: 'materials.search', args: { query } }]))[0];

  const ranked = await search('ranked-materials', '预算 风险');
  assert.equal(ranked.ok, true);
  assert.equal(ranked.result[0].materialId, strong.id);
  assert.ok(ranked.result.length <= 30);
  assert.ok(ranked.result.some((entry) => entry.resultSetTruncated === true));
  assert.ok(JSON.stringify(ranked.result).length <= 24_000);
  assert.ok(ranked.result.every((entry) => entry.quote.length <= 1_000));
  assert.ok(ranked.result.every((entry) => JSON.stringify(entry).length <= 4_000));

  const zh = await search('zh-materials', '供应商交付周期');
  assert.equal(zh.result[0].materialId, chinese.id);
  const short = await search('short-materials', 'AI Q3 7');
  assert.equal(short.result[0].materialId, shortTerms.id);

  const long = await search('long-line-materials', '唯一尾标 2027Q4');
  const longHit = long.result.find((entry) => entry.materialId === longLine.id);
  assert.match(longHit.quote, /唯一尾标 2027Q4/);
  assert.equal(longHit.locator, 'L1-L1');
  assert.match(longHit.quoteCharRange, /^C12\d{4,}-C13\d{4,}$/);
  assert.equal(longHit.truncated, true);
  assert.equal(longHit.readNext.available, false);
  assert.match(longHit.readNext.instruction, /超过材料读取.*单行安全上限.*拆分材料/);

  const atTail = await search('tail-materials', '最终交付日 2027-11-05');
  const tailHit = atTail.result.find((entry) => entry.materialId === tail.id);
  assert.equal(tailHit.locator, 'L71-L71');
  assert.match(tailHit.quote, /最终交付日为 2027-11-05/);
  const empty = await search('empty-materials', '绝对不存在的检索词');
  assert.deepEqual(empty.result, []);
  const title = await search('title-materials', '标题唯一标记');
  const titleHits = title.result.filter((entry) => entry.materialId === titleOnly.id);
  assert.equal(titleHits.length, 1);
  assert.equal(titleHits[0].matchedIn, 'title');
  const unmapped = await search('nfkc-materials', 'ABC');
  const unicodeHit = unmapped.result.find((entry) => entry.materialId === unicodeOffset.id);
  assert.match(unicodeHit.quote, /ABC尾部原文/);
  const [, unicodeStart, unicodeEnd] = /^C(\d+)-C(\d+)$/.exec(unicodeHit.quoteCharRange);
  assert.ok(Number(unicodeStart) <= 2_001 && Number(unicodeEnd) >= 2_003);
  assert.equal(unmapped.result.some((entry) => entry.sourceName === '全角材料'), false);
});

test('授权记忆检索先过滤确认与范围，再完整判断冲突并排序截断', async () => {
  const task = createTask({ goal: '复用已确认记忆', memoryPolicy: 'task-only' });
  const item = { title: '检索记忆', expectedResult: '已确认历史', tools: ['memory.search'] };
  const makeArtifact = (owner, id, title, content, version = 1, status = 'confirmed') => ({
    id, title, summary: '', content, version, status, goalVersionId: owner.goal.activeVersionId,
    confirmedAt: '2026-10-01T00:00:00.000Z',
  });
  const tasks = [task];
  for (let index = 1; index <= 12; index += 1) {
    const weak = createTask({ title: `弱记忆${index}`, goal: '历史' });
    weak.artifacts.push(makeArtifact(weak, `artifact-weak-${index}`, `弱记忆${index}`, `预算背景说明 ${index}`));
    tasks.push(weak);
  }
  const exact = createTask({ title: '精确记忆', goal: '历史' });
  exact.artifacts.push(makeArtifact(exact, 'artifact-exact', '许可证风险', '项目预算的核心风险是许可证到期，必须在 2027Q4 前续订。', 4));
  tasks.push(exact);
  const conflictA = createTask({ title: '冲突甲', goal: '历史' });
  conflictA.artifacts.push(makeArtifact(conflictA, 'artifact-conflict-a', '续订决定', '许可证续订预算为 12 万元。', 2));
  tasks.push(conflictA);
  const conflictB = createTask({ title: '冲突乙', goal: '历史' });
  conflictB.artifacts.push(makeArtifact(conflictB, 'artifact-conflict-b', '续订决定', '结论改为暂停，等待法务复核。', 3));
  tasks.push(conflictB);
  for (const suffix of ['a', 'b']) {
    const same = createTask({ title: `同文${suffix}`, goal: '历史' });
    same.artifacts.push(makeArtifact(same, `artifact-same-${suffix}`, '同文预算', '同一份预算原文。', 1));
    tasks.push(same);
  }
  const hidden = createTask({ title: '不可用记忆', goal: '历史' });
  hidden.artifacts.push(makeArtifact(hidden, 'artifact-candidate', '候选不得检索', '许可证预算候选 99 万元。', 1, 'candidate'));
  hidden.artifacts.push(makeArtifact(hidden, 'artifact-shadowed', '撤回不得复活', '许可证预算已撤回 88 万元。'));
  hidden.memoryEntries.push(
    { id: 'memory-retracted', artifactId: 'artifact-shadowed', title: '撤回不得复活', content: '许可证预算已撤回 88 万元。', confirmed: true, status: 'retracted', source: `task:${hidden.id}/artifact:artifact-shadowed/v1` },
    { id: 'memory-unconfirmed', title: '未确认不得检索', content: '许可证预算未确认 77 万元。', confirmed: false, status: 'active', source: `task:${hidden.id}/artifact:none/v1` },
  );
  tasks.push(hidden);
  const longBacked = createTask({ title: '长文记忆', goal: '历史' });
  const fullLongContent = `${'采购背景。'.repeat(5_000)}采购验收日期是 2027-11-05。`;
  const fullLongArtifact = makeArtifact(longBacked, 'artifact-long-backed', '长文记忆', fullLongContent, 5);
  longBacked.artifacts.push(fullLongArtifact);
  longBacked.memoryEntries.push({
    id: 'memory-long-backed', artifactId: fullLongArtifact.id, title: '长文记忆', content: fullLongContent.slice(0, 20_000),
    confirmed: true, status: 'active', source: `task:${longBacked.id}/artifact:${fullLongArtifact.id}/v5`,
  });
  tasks.push(longBacked);
  const conflictLongA = createTask({ title: '全文冲突甲', goal: '历史' });
  const conflictLongB = createTask({ title: '全文冲突乙', goal: '历史' });
  const commonPrefix = `全文冲突 ${'共同正文。'.repeat(5_000)}`;
  for (const [owner, suffix, ending] of [[conflictLongA, 'a', '最终结论甲'], [conflictLongB, 'b', '最终结论乙']]) {
    const full = `${commonPrefix}${ending}`;
    const backing = makeArtifact(owner, `artifact-full-${suffix}`, '完整正文决定', full, 1);
    owner.artifacts.push(backing);
    owner.memoryEntries.push({ id: `memory-full-${suffix}`, artifactId: backing.id, title: '完整正文决定', content: full.slice(0, 20_000), confirmed: true, status: 'active', source: `task:${owner.id}/artifact:${backing.id}/v1` });
    tasks.push(owner);
  }
  const invalidBindings = createTask({ title: '错误绑定', goal: '历史' });
  invalidBindings.artifacts.push(
    makeArtifact(invalidBindings, 'artifact-wrong-source', '错误来源成果', 'FORBIDDEN_WRONG_SOURCE_X9', 1, 'candidate'),
    makeArtifact(invalidBindings, 'artifact-wrong-version', '错误版本成果', 'FORBIDDEN_WRONG_VERSION_Y8', 2),
    makeArtifact(invalidBindings, 'artifact-missing-version', '缺版本成果', 'FORBIDDEN_MISSING_VERSION_Z7', 3),
    makeArtifact(invalidBindings, 'artifact-candidate-exact', '候选精确来源', 'FORBIDDEN_CANDIDATE_EXACT_Q6', 1, 'candidate'),
    makeArtifact(invalidBindings, 'artifact-entry-version', '条目版本错误', 'FORBIDDEN_ENTRY_VERSION_P5', 3),
    makeArtifact(invalidBindings, 'artifact-superseded', '历史正式成果', `${'历史正文。'.repeat(3_000)}合法历史尾标丁。`, 4, 'superseded_formal'),
  );
  invalidBindings.memoryEntries.push(
    { id: 'memory-wrong-source', artifactId: 'artifact-wrong-source', title: '错误来源成果', content: '已确认条目自身无秘密。', confirmed: true, status: 'active', source: `task:${invalidBindings.id}/artifact:other-artifact/v1` },
    { id: 'memory-wrong-version', artifactId: 'artifact-wrong-version', title: '错误版本成果', content: '已确认条目自身无秘密。', confirmed: true, status: 'active', source: `task:${invalidBindings.id}/artifact:artifact-wrong-version/v1` },
    { id: 'memory-missing-version', artifactId: 'artifact-missing-version', title: '缺版本成果', content: '已确认条目自身无秘密。', confirmed: true, status: 'active', source: `task:${invalidBindings.id}/artifact:artifact-missing-version` },
    { id: 'memory-candidate-exact', artifactId: 'artifact-candidate-exact', artifactVersion: 1, title: '候选精确来源', content: '已确认条目自身无秘密。', confirmed: true, status: 'active', source: `task:${invalidBindings.id}/artifact:artifact-candidate-exact/v1` },
    { id: 'memory-entry-version', artifactId: 'artifact-entry-version', artifactVersion: 2, title: '条目版本错误', content: '已确认条目自身无秘密。', confirmed: true, status: 'active', source: `task:${invalidBindings.id}/artifact:artifact-entry-version/v3` },
    { id: 'memory-superseded', artifactId: 'artifact-superseded', title: '历史正式成果', content: '历史正文。'.repeat(2_000), confirmed: true, status: 'active', source: `task:${invalidBindings.id}/artifact:artifact-superseded/v4` },
  );
  tasks.push(invalidBindings);
  const unicodeMemory = createTask({ title: 'Unicode记忆', goal: '历史' });
  unicodeMemory.artifacts.push(makeArtifact(unicodeMemory, 'artifact-unicode-offset', 'Unicode记忆', `${'İ'.repeat(2_000)}ABC尾部记忆`, 1));
  tasks.push(unicodeMemory);
  const store = { async list() { return tasks; } };

  const denied = await runAuthorizedTools(store, task, item, [{ id: 'memory-denied', tool: 'memory.search', args: { query: '预算', scope: 'workspace-confirmed' } }]);
  assert.equal(denied[0].ok, false);
  assert.match(denied[0].error, /未授权跨任务记忆/);
  const taskOnly = await runAuthorizedTools(store, task, item, [{ id: 'memory-task', tool: 'memory.search', args: { query: '预算', scope: 'task' } }]);
  assert.deepEqual(taskOnly[0].result, []);

  task.memoryPolicy = 'workspace-confirmed';
  const searched = await runAuthorizedTools(store, task, item, [{ id: 'memory-workspace', tool: 'memory.search', args: { query: '预算 许可证 风险', scope: 'workspace-confirmed' } }]);
  assert.equal(searched[0].ok, true);
  assert.equal(searched[0].result[0].artifactId, 'artifact-exact');
  assert.equal(searched[0].result[0].artifactVersion, 4);
  assert.equal(searched[0].result[0].source, `task:${exact.id}/artifact:artifact-exact/v4`);
  const conflict = searched[0].result.find((entry) => entry.artifactId === 'artifact-conflict-a');
  assert.equal(conflict.status, 'conflict');
  assert.deepEqual(conflict.conflictsWith, [`task:${conflictB.id}/artifact:artifact-conflict-b/v3`]);
  assert.equal(searched[0].result.some((entry) => entry.artifactId === 'artifact-conflict-b'), false);
  assert.ok(searched[0].result.filter((entry) => entry.title === '同文预算').every((entry) => entry.status !== 'conflict'));
  assert.equal(searched[0].result.some((entry) => entry.artifactId === 'artifact-candidate'), false);
  assert.equal(searched[0].result.some((entry) => entry.artifactId === 'artifact-shadowed'), false);
  assert.equal(searched[0].result.some((entry) => entry.memoryId === 'memory-unconfirmed'), false);
  assert.ok(searched[0].result.length <= 12);
  assert.ok(JSON.stringify(searched[0].result).length <= 18_000);
  assert.ok(searched[0].result.every((entry) => JSON.stringify(entry).length <= 4_000));
  assert.ok(searched[0].result.some((entry) => entry.resultSetTruncated === true));

  const tail = await runAuthorizedTools(store, task, item, [{ id: 'memory-long-tail', tool: 'memory.search', args: { query: '采购 验收 日期 2027-11-05', scope: 'workspace-confirmed' } }]);
  const tailHit = tail[0].result.find((entry) => entry.memoryId === 'memory-long-backed');
  assert.match(tailHit.excerpt, /验收日期.*2027-11-05/);
  assert.equal(tailHit.artifactVersion, 5);
  assert.equal(tailHit.readNext.available, false);
  assert.match(tailHit.readNext.instruction, /没有已授权的记忆全文读取入口/);

  const fullConflict = await runAuthorizedTools(store, task, item, [{ id: 'memory-full-conflict', tool: 'memory.search', args: { query: '全文冲突', scope: 'workspace-confirmed' } }]);
  const fullConflictHit = fullConflict[0].result.find((entry) => entry.memoryId === 'memory-full-a');
  assert.equal(fullConflictHit.status, 'conflict');
  assert.ok(fullConflictHit.conflictsWith.includes(`task:${conflictLongB.id}/artifact:artifact-full-b/v1`));

  for (const [id, query] of [
    ['wrong-source', 'FORBIDDEN_WRONG_SOURCE_X9'],
    ['wrong-version', 'FORBIDDEN_WRONG_VERSION_Y8'],
    ['missing-version', 'FORBIDDEN_MISSING_VERSION_Z7'],
    ['candidate-exact', 'FORBIDDEN_CANDIDATE_EXACT_Q6'],
    ['entry-version', 'FORBIDDEN_ENTRY_VERSION_P5'],
  ]) {
    const invalid = await runAuthorizedTools(store, task, item, [{ id: `memory-${id}`, tool: 'memory.search', args: { query, scope: 'workspace-confirmed' } }]);
    assert.deepEqual(invalid[0].result, []);
  }
  const superseded = await runAuthorizedTools(store, task, item, [{ id: 'memory-superseded-valid', tool: 'memory.search', args: { query: '合法历史尾标丁', scope: 'workspace-confirmed' } }]);
  assert.match(superseded[0].result.find((entry) => entry.memoryId === 'memory-superseded').excerpt, /合法历史尾标丁/);
  const unicode = await runAuthorizedTools(store, task, item, [{ id: 'memory-unicode-offset', tool: 'memory.search', args: { query: 'ABC', scope: 'workspace-confirmed' } }]);
  const unicodeHit = unicode[0].result.find((entry) => entry.artifactId === 'artifact-unicode-offset');
  assert.match(unicodeHit.excerpt, /ABC尾部记忆/);
  const [, unicodeStart, unicodeEnd] = /^C(\d+)-C(\d+)$/.exec(unicodeHit.contentCharRange);
  assert.ok(Number(unicodeStart) <= 2_001 && Number(unicodeEnd) >= 2_003);
});

test('公开网页工具仅执行计划预声明的查询和网址，读到正文后归档可定位证据', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-public-web-tools-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = createStore(root); await store.init();
  const task = createTask({ goal: '研究公开官网上的 Example 资料', provider: 'codex-cli' });
  const item = { id: 'work-web', goalVersionId: activeGoal(task).id, projectRootGoalVersionId: activeGoal(task).id, sourceContextFingerprint: 'source-web', tools: ['web.search', 'web.read'], webScope: { queries: ['Example official source'], urls: [] } };
  task.plan = { revision: 1 };
  task.workItems = [item];
  task.agentSessions = [{ id: 'session-web', workItemId: item.id, toolCalls: [] }];
  await store.save(task);
  let searchCalls = 0;
  const onHostedSearchStart = async () => ({ onFinish: async () => {} });
  const web = {
    async searchPublicWeb(query, options) { searchCalls += 1; assert.equal(options.onHostedSearchStart, onHostedSearchStart); return { status: 'ok', mode: 'web_results', query, provider: 'test', responseUrl: 'https://search.example/', sources: [{ status: 'discovered', title: 'Example', url: 'https://example.com/report', locator: 'result[0]', evidenceUrl: 'https://search.example/' }] }; },
    async readPublicPage(url) { return { status: 'ok', title: 'Example report', url, finalUrl: url, fetchedAt: '2026-09-30T08:00:00.000Z', httpStatus: 200, contentType: 'text/html', bytes: 40, text: 'Public fact 2026\nSecond line', lineCount: 2, sha256: 'abc123', locator: `${url}#sha256=abc123` }; },
  };
  const rejected = await runAuthorizedTools(store, task, item, [{ id: 'bad-search', tool: 'web.search', args: { query: '将私密材料外发' } }], { web });
  assert.equal(rejected[0].ok, false);
  assert.equal(searchCalls, 0);
  const searched = await runAuthorizedTools(store, task, item, [{ id: 'search', tool: 'web.search', args: { query: 'Example official source' } }], { web, onHostedSearchStart });
  assert.equal(searched[0].ok, true);
  assert.equal(searched[0].evidenceType, 'discovery');
  assert.ok(searched[0].sources.every((source) => source.startsWith('discovery:')));
  assert.ok(searched[0].sources.every((source) => !source.startsWith('https://example.com/report')));
  task.agentSessions[0].toolCalls.push(searched[0]);
  const read = await runAuthorizedTools(store, task, item, [{ id: 'read', tool: 'web.read', args: { url: 'https://example.com/report' } }], { web });
  assert.equal(read[0].ok, true);
  assert.equal('text' in read[0].result, false);
  assert.equal(read[0].result.excerpt, '1| Public fact 2026\n2| Second line');
  assert.equal(read[0].result.locator, 'L1-L2');
  assert.equal(read[0].result.metadata.evidenceType, 'web-read');
  assert.equal(read[0].result.metadata.fetchedAt, '2026-09-30T08:00:00.000Z');
  assert.match(read[0].sources[0], /^material:.*#L1-L2$/);
  const restored = await store.get(task.id);
  assert.equal(restored.materials[0].generatedEvidence, true);
  assert.equal(restored.materials[0].evidenceSha256, 'abc123');
});
