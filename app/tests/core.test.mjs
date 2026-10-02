import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  acceptGoalReplacement,
  activeGoal,
  addMaterial,
  addSuggestion,
  assertExportAllowed,
  buildPlan,
  confirmArtifact,
  correctSuggestion,
  createArtifact,
  createStore,
  createTask,
  deriveTaskContinuity,
  recordReview,
  reviseArtifact,
} from '../core.mjs';
import { __test as providerTest } from '../providers.mjs';
import { __test as serverTest } from '../server.mjs';
import {
  beginWork,
  completeWork,
  demoResearch,
  finishModelCall,
  reserveModelCall,
  retryDisposition,
  startExecution,
  validateClaim,
  validateResearchResult,
} from '../execution.mjs';

const replacement = (statement) => ({ statement, successCriteria: [`完成“${statement}”的可核对成果`], boundaries: ['不自动发送、发布或覆盖正式文件'] });

const passingReview = (artifact = null, verdicts = []) => ({
  summary: '通过',
  checks: [
    { name: '目标符合度', passed: true, evidence: '符合目标', blocking: true },
    { name: '完整性', passed: true, evidence: '内容完整', blocking: true },
    { name: '来源核对', passed: true, evidence: '没有事实材料', blocking: true },
    { name: '边界遵守', passed: true, evidence: '未执行外部操作', blocking: true },
    { name: '文件可用性', passed: true, evidence: '标题正文存在', blocking: true },
  ],
  claimChecks: (artifact?.claims || []).map((claim, claimIndex) => ({
    claimIndex,
    materialId: claim.materialId,
    locator: claim.locator,
    verdict: verdicts[claimIndex] || 'supported',
    evidence: verdicts[claimIndex] === 'unsupported' ? '结论把另一主体的条件错误归到当前主体。' : '逐条对照引用原文后可支持。',
  })),
});

test('真实模型子进程显式禁用内置网页搜索并保留只读沙箱', () => {
  const args = providerTest.codexExecArgs('/tmp/schema.json', '/tmp/result.json', '/tmp/run');
  assert.deepEqual(args.slice(args.indexOf('-c'), args.indexOf('-c') + 2), ['-c', 'web_search="disabled"']);
  assert.deepEqual(args.slice(args.indexOf('--sandbox'), args.indexOf('--sandbox') + 2), ['--sandbox', 'read-only']);
  assert.ok(args.includes('--ignore-user-config'));
  assert.ok(args.includes('--ignore-rules'));
});

test('综合交付超时按工作类型而非模型自选步骤名计算', () => {
  assert.equal(providerTest.timeoutForWorkItem({ kind: 'synthesis', stepKey: 'synthesize' }), 420_000);
  assert.equal(providerTest.timeoutForWorkItem({ kind: 'synthesis', stepKey: 'draft_comparison' }), 420_000);
  assert.equal(providerTest.timeoutForWorkItem({ kind: 'analysis', stepKey: 'synthesis' }), 300_000);
});

test('独立规划使用新调用时限，运行内重规划仍受当前执行截止时间约束', () => {
  const expired = { execution: { deadlineAt: new Date(Date.now() - 60_000).toISOString() } };
  assert.equal(providerTest.providerTimeoutMs(expired, 300_000, false), 300_000);
  assert.equal(providerTest.providerTimeoutMs(expired, 300_000, true), 1_000);
  const active = { execution: { deadlineAt: new Date(Date.now() + 20_000).toISOString() } };
  const bounded = providerTest.providerTimeoutMs(active, 300_000, true);
  assert.ok(bounded > 18_000 && bounded <= 20_000);
});

test('替代建议未经确认不会改变当前目标，确认后旧计划作废', () => {
  const task = createTask({ goal: '完成季度复盘', successCriteria: ['含结论'], boundaries: ['不编造'] });
  const firstGoal = activeGoal(task);
  buildPlan(task);
  const suggestion = addSuggestion(task, { text: '最终目标改成准备下季度预算' });
  assert.equal(suggestion.classification, 'replace');
  assert.equal(activeGoal(task).id, firstGoal.id);
  assert.equal(task.status, 'waiting_user');

  correctSuggestion(task, suggestion.id, 'support');
  assert.equal(activeGoal(task).id, firstGoal.id);
  assert.equal(task.status, 'idle');
  correctSuggestion(task, suggestion.id, 'replace');
  const next = acceptGoalReplacement(task, suggestion.id, replacement('准备下季度预算'));
  assert.equal(next.version, 2);
  assert.equal(activeGoal(task).statement, '准备下季度预算');
  assert.equal(task.workItems.length, 0);
});

test('目标替换要求完整新目标且失败无副作用，历史或重复确认被拒绝', () => {
  const task = createTask({ goal: '旧目标', successCriteria: ['旧条件'], boundaries: ['旧边界'] });
  const suggestion = addSuggestion(task, { text: '最终目标改成新目标' });
  const before = structuredClone(task);
  assert.throws(() => acceptGoalReplacement(task, suggestion.id, { statement: '新目标', boundaries: ['新边界'] }), /成功条件/);
  assert.deepEqual(task, before);
  const goal = acceptGoalReplacement(task, suggestion.id, { statement: '新目标', successCriteria: ['新条件'], boundaries: ['新边界'] });
  assert.deepEqual(goal.successCriteria, ['新条件']);
  assert.deepEqual(goal.boundaries, ['新边界']);
  assert.throws(() => acceptGoalReplacement(task, suggestion.id, replacement('再次确认')), /不能重复|历史/);
  const later = addSuggestion(task, { text: '最终目标改成第三目标' });
  const latest = acceptGoalReplacement(task, later.id, replacement('第三目标'));
  assert.equal(latest.version, 3);
  assert.throws(() => acceptGoalReplacement(task, suggestion.id, replacement('历史目标')), /不能重复|历史/);
});

test('进度原因来自当前失败而非后来对话，等待决定按真实原因区分', () => {
  const task = createTask({ goal: '生成清单' });
  buildPlan(task);
  const item = task.workItems[0];
  item.status = 'failed'; item.error = '权限永久拒绝';
  task.status = 'partial'; task.execution = { stopReason: 'permanent_error' };
  task.events.push({ id: 'conversation-later', at: new Date().toISOString(), type: 'conversation.user', message: '进度怎么样', detail: {} });
  assert.equal(deriveTaskContinuity(task).progress.stoppedBecause, '权限永久拒绝');

  const replacementSuggestion = addSuggestion(task, { text: '最终目标改成新清单' });
  assert.match(deriveTaskContinuity(task).progress.nextStep, /完整填写/);
  correctSuggestion(task, replacementSuggestion.id, 'deviate');
  task.events.push({ id: 'project-conflict', at: new Date().toISOString(), type: 'project.goal_conflict', message: '根目标冲突', detail: { taskGoalVersionId: activeGoal(task).id } });
  task.events.push({ id: 'project-wait', at: new Date().toISOString(), type: 'task.state', message: '任务自身目标与新版项目根目标存在冲突', detail: { status: 'waiting_user' } });
  task.status = 'waiting_user'; task.projectRootTaskId = 'task-root';
  assert.match(deriveTaskContinuity(task).progress.nextStep, /项目根目标对齐/);
  task.events.push({ id: 'candidate-wait', at: new Date().toISOString(), type: 'task.state', message: '候选成果已通过核对，等待确认', detail: { status: 'waiting_user' } });
  assert.doesNotMatch(deriveTaskContinuity(task).progress.nextStep, /项目根目标对齐/);
});

test('确认候选后进度显示待下载而不再说等待确认', () => {
  const task = createTask({ goal: '形成可下载报告' });
  buildPlan(task);
  const delivery = { id: 'delivery-test', goalVersionId: activeGoal(task).id, kind: 'delivery', title: '等待确认', status: 'waiting_user' };
  task.workItems.push(delivery);
  const artifact = createArtifact(task, { title: '报告', content: '# 已确认报告', sources: [], claims: [] }, 'test');
  recordReview(task, artifact.id, passingReview());
  confirmArtifact(task, artifact.id);

  const continuity = deriveTaskContinuity(task);
  assert.equal(task.status, 'ready_to_export');
  assert.equal(continuity.candidate.confirmed, true);
  assert.deepEqual(continuity.pending.find((item) => item.id === delivery.id), {
    id: delivery.id,
    title: '下载已确认的指定版本',
    status: 'ready_to_export',
  });
  assert.match(continuity.progress.stoppedBecause, /已确认.*下载/);
  assert.match(continuity.progress.nextStep, /下载已确认/);
  assert.doesNotMatch(`${continuity.progress.stoppedBecause}\n${continuity.progress.nextStep}`, /等待确认|审阅候选/);
  assert.equal(continuity.progress.needsUserDecision, false);
});

test('改稿语句支持当前目标，真正替换最终目标仍需确认', () => {
  const task = createTask({ goal: '写一份供应商简报' });
  assert.equal(addSuggestion(task, { text: '下一版把正文缩短到650字以内' }).classification, 'support');
  assert.equal(addSuggestion(task, { text: '把标题改成“供应商选择简报”' }).classification, 'support');
  assert.equal(addSuggestion(task, { text: '请把刚退回的 v2 修改成新版本。保留行动清单和限制说明两个工作表，保留已有两项行动及来源，在行动清单增加“待确认事项”列：第一项写“年份待确认”，第二项写“负责人和截止日期待确认”。这只是改稿，不改变最终目标。完成后重新独立核对并等我确认，不导出、不发送、不覆盖旧版本。' }).classification, 'support');
  assert.equal(addSuggestion(task, { text: '最终目标改成写一封请假邮件' }).classification, 'replace');
  assert.equal(addSuggestion(task, { text: '取消原目标，改为准备一场招聘会' }).classification, 'replace');
  assert.equal(activeGoal(task).statement, '写一份供应商简报');
});

test('已拒绝候选不能绕过候选态再次确认', () => {
  const task = createTask({ goal: '形成一份候选成果' });
  const artifact = createArtifact(task, { title: '候选', content: '可检查正文', sources: [], claims: [] }, 'test');
  recordReview(task, artifact.id, passingReview());
  artifact.status = 'rejected';
  assert.throws(() => confirmArtifact(task, artifact.id), /只有当前候选版本/);
});

test('同错达到尝试上限与永久错误不再重试，不同错误仍交给有界重规划', () => {
  const task = createTask({ goal: '验证重试判定' });
  buildPlan(task);
  startExecution(task, activeGoal(task).id, { maxAttemptsPerStep: 2 });
  const item = task.workItems[0];
  item.attempts = [{ error: 'Temporary upstream failure A' }, { error: 'temporary upstream failure a with detail' }];
  assert.equal(retryDisposition(task, item.id, new Error('temporary upstream failure a')).sameErrorAtLimit, false);
  item.attempts = [{ error: 'Temporary upstream failure A' }, { error: 'Temporary upstream failure A' }];
  assert.equal(retryDisposition(task, item.id, new Error('Temporary upstream failure A')).sameErrorAtLimit, true);
  item.attempts = [{ error: '权限不足' }];
  const permanent = retryDisposition(task, item.id, new Error('权限不足'));
  assert.equal(permanent.permanent, true);
  assert.equal(permanent.retryable, false);
});

test('永久错误与同错耗尽的进度不承诺直接恢复', () => {
  const task = createTask({ goal: '验证终止后的下一步' });
  buildPlan(task);
  const item = task.workItems[0];
  item.status = 'blocked';
  item.error = '权限不足';
  task.status = 'partial';
  task.execution = { stopReason: 'permanent_error' };
  assert.match(deriveTaskContinuity(task).progress.nextStep, /不可自动重试.*解除.*或调整/);
  assert.doesNotMatch(deriveTaskContinuity(task).progress.nextStep, /从未完成.*恢复/);

  item.error = '同一个临时错误';
  task.execution.stopReason = 'same_error_exhausted';
  assert.match(deriveTaskContinuity(task).progress.nextStep, /同一错误.*重试上限.*改变/);
  assert.doesNotMatch(deriveTaskContinuity(task).progress.nextStep, /从未完成.*恢复/);
});

test('跑题建议不会替换目标，旧目标成果在接受新目标后不能导出', () => {
  const task = createTask({ goal: '比较供应商', boundaries: ['不联系供应商'] });
  const originalGoal = activeGoal(task);
  const later = addSuggestion(task, { text: '以后顺便设计一张招聘海报' });
  assert.equal(later.classification, 'deviate');
  assert.equal(activeGoal(task).id, originalGoal.id);

  const artifact = createArtifact(task, { title: '旧目标成果', summary: '旧版', content: '# 比较供应商\n\n不含事实数字的候选。', sources: [], claims: [] }, 'test');
  recordReview(task, artifact.id, passingReview());
  const approval = confirmArtifact(task, artifact.id);
  const replace = addSuggestion(task, { text: '最终目标改成制作招聘海报' });
  acceptGoalReplacement(task, replace.id, replacement('制作招聘海报'));
  assert.throws(() => assertExportAllowed(task, artifact.id, approval.id), /旧目标/);
});

test('换目标后旧工作交代不会污染新计划、提示或成果', () => {
  const task = createTask({ goal: '比较供应商报价', type: 'research' });
  const oldInstruction = addSuggestion(task, { text: '正文必须围绕红杉供应商展开' });
  const oldArtifact = createArtifact(task, { title: '旧稿', content: '红杉供应商比较稿。', summary: '旧目标', sources: [], claims: [] }, 'test');
  const replacement = addSuggestion(task, { text: '最终目标改成写一封请假邮件' });
  acceptGoalReplacement(task, replacement.id, { statement: '写一封请假邮件', successCriteria: ['邮件内容完整'], boundaries: ['不发送'] });
  buildPlan(task);

  assert.equal(oldInstruction.status, 'superseded');
  assert.ok(task.workItems.every((item) => !item.inputSuggestionIds.includes(oldInstruction.id)));
  assert.doesNotMatch(providerTest.providerPrompt(task), /红杉供应商/);
  const next = createArtifact(task, { title: '请假邮件', content: '请假邮件候选稿。', summary: '新目标', sources: [], claims: [] }, 'test');
  assert.deepEqual(next.instructionIds, []);
  assert.equal(next.previousId, null);
  assert.notEqual(oldArtifact.goalVersionId, next.goalVersionId);
});

test('连续对话提示只带同目标同角色的有界历史与当前候选', () => {
  const task = createTask({ goal: '核对一份报价', type: 'research' });
  const goalId = activeGoal(task).id;
  task.events.push(
    { type: 'conversation.user', message: '第一问', detail: { role: 'researcher', goalVersionId: goalId, content: '请解释第二条结论' } },
    { type: 'conversation.reply', message: '截断摘要', detail: { role: 'researcher', goalVersionId: goalId, content: `第二条是交付周期。${'完整内容'.repeat(140)}尾部标记` } },
    { type: 'conversation.reply', message: '其他角色', detail: { role: 'writer', goalVersionId: goalId, content: '不应进入研究员上下文' } },
  );
  createArtifact(task, { title: '当前稿', content: '当前目标下的候选内容', summary: '当前', sources: [], claims: [] }, 'test');
  const prompt = providerTest.conversationPrompt(task, 'researcher', '你刚才第二条是什么意思？');
  assert.match(prompt, /第二条是交付周期/);
  assert.match(prompt, /当前目标下的候选内容/);
  assert.doesNotMatch(prompt, /不应进入研究员上下文/);
});

test('旧格式对话在换目标时归档但不进入新目标提示', () => {
  const task = createTask({ goal: '比较供应商' });
  task.events.push({ id: 'legacy-conversation', type: 'conversation.reply', message: '旧任务特有标记', detail: { role: 'researcher', provider: 'demo' } });
  const replacement = addSuggestion(task, { text: '最终目标改成写请假邮件' });
  const oldGoalId = activeGoal(task).id;
  acceptGoalReplacement(task, replacement.id, { statement: '写请假邮件', successCriteria: ['邮件内容完整'], boundaries: ['不发送'] });
  const legacy = task.events.find((item) => item.id === 'legacy-conversation');
  assert.equal(legacy.detail.archivedGoalVersionId, oldGoalId);
  assert.equal(legacy.detail.legacyScope, 'archived_on_goal_replacement');
  assert.doesNotMatch(providerTest.conversationPrompt(task, 'researcher', '请继续'), /旧任务特有标记/);
  assert.ok(task.events.includes(legacy));
});

test('旧格式同目标对话只在没有新工作交代时兼容', () => {
  const task = createTask({ goal: '整理进度' });
  const goalVersionId = activeGoal(task).id;
  task.events.push({ id: 'legacy-same-goal', type: 'conversation.reply', message: '旧输入回复标记', detail: { role: 'researcher', goalVersionId, content: '旧输入回复标记' } });
  assert.match(providerTest.conversationPrompt(task, 'researcher', '当前进度'), /旧输入回复标记/);
  addSuggestion(task, { text: '新增工作交代：优先复用现有记录' });
  assert.doesNotMatch(providerTest.conversationPrompt(task, 'researcher', '当前进度'), /旧输入回复标记/);
});

test('新候选版本不会继承旧版确认', () => {
  const task = createTask({ goal: '形成可审阅报告' });
  const first = createArtifact(task, { title: '报告', summary: '初稿', content: '# 形成可审阅报告\n\n这是一份足够长、可以核对目标与边界的候选报告正文。'.repeat(4), sources: [] }, 'demo');
  recordReview(task, first.id, passingReview());
  confirmArtifact(task, first.id);
  assert.equal(first.status, 'confirmed');

  const second = reviseArtifact(task, first.id, { content: `${first.content}\n\n人工补充。` });
  assert.equal(first.status, 'confirmed');
  assert.equal(second.status, 'candidate');
  assert.equal(second.reviewStatus, 'pending');
  assert.throws(() => confirmArtifact(task, second.id), /尚未通过/);
  recordReview(task, second.id, passingReview());
  confirmArtifact(task, second.id);
  assert.equal(first.status, 'superseded_formal');
  assert.equal(second.status, 'confirmed');
});

test('旧独立任务缺目标版本的审批仅在精确绑定旧成果版本时兼容', () => {
  const task = createTask({ goal: '旧单任务成果' });
  const artifact = createArtifact(task, { title: '旧成果', summary: '兼容', content: '# 旧成果', sources: [], claims: [] }, 'test');
  task.projectRootGoalVersionId = artifact.projectRootGoalVersionId;
  task.projectRootInputFingerprint = artifact.projectRootInputFingerprint;
  delete artifact.projectRootGoalVersionId;
  delete artifact.projectRootInputFingerprint;
  recordReview(task, artifact.id, passingReview());
  const approval = confirmArtifact(task, artifact.id);
  delete approval.goalVersionId;
  assert.doesNotThrow(() => assertExportAllowed(task, artifact.id, approval.id));

  approval.artifactVersion = artifact.version + 1;
  assert.throws(() => assertExportAllowed(task, artifact.id, approval.id), /有效导出确认/);
  approval.artifactVersion = artifact.version;

  task.projectRootTaskId = 'task-project-root';
  task.projectRootGoalVersionId = 'goal-project-root';
  task.projectRootInputFingerprint = 'root-input';
  assert.throws(() => assertExportAllowed(task, artifact.id, approval.id), /关联项目之前|项目输入/);

  const currentTask = createTask({ goal: '新格式成果' });
  const currentArtifact = createArtifact(currentTask, { title: '新成果', summary: '当前', content: '# 新成果', sources: [], claims: [] }, 'test');
  recordReview(currentTask, currentArtifact.id, passingReview());
  const currentApproval = confirmArtifact(currentTask, currentArtifact.id);
  delete currentApproval.goalVersionId;
  assert.throws(() => assertExportAllowed(currentTask, currentArtifact.id, currentApproval.id), /有效导出确认/);
});

test('概要文本不能覆盖结构化表格，纯文档编辑同步真正交付内容', () => {
  const sheetTask = createTask({ goal: '形成两张工作表', type: 'spreadsheet' });
  const workbook = JSON.stringify({ sheets: [
    { name: '行动清单', rows: [['行动', '进度'], ['核对', '=1+1']] },
    { name: '限制说明', rows: [['限制'], ['待确认']] },
  ] });
  const sheet = createArtifact(sheetTask, {
    title: '行动簿', summary: '两张工作表的候选概要', content: '行动簿概要', sources: [], claims: [],
    deliverables: [{ kind: 'spreadsheet', title: '行动簿', content: workbook }],
  }, 'test');
  assert.throws(() => reviseArtifact(sheetTask, sheet.id, { content: '把第一列改一下' }), /结构化成果/);
  assert.equal(sheet.deliverables[0].content, workbook);
  assert.equal(JSON.parse(sheet.deliverables[0].content).sheets.length, 2);
  assert.equal(JSON.parse(sheet.deliverables[0].content).sheets[0].rows[1][1], '=1+1');

  const documentTask = createTask({ goal: '形成可编辑文档', type: 'document' });
  const document = createArtifact(documentTask, {
    title: '文档', summary: '候选概要', content: '候选概要', sources: [], claims: [],
    deliverables: [{ kind: 'document', title: '文档', content: '# 真正文档\n\n旧内容' }],
  }, 'test');
  const revised = reviseArtifact(documentTask, document.id, { content: '# 真正文档\n\n新内容' });
  assert.equal(revised.content, '# 真正文档\n\n新内容');
  assert.equal(revised.deliverables[0].content, revised.content);
});

test('任务可原子保存并从磁盘恢复', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-store-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = createStore(root);
  const task = createTask({ title: '恢复测试', goal: '重启后继续工作' });
  addMaterial(task, { name: '记录', text: '保留这段文字' });
  await store.save(task);
  const restored = await createStore(root).get(task.id);
  assert.equal(restored.title, '恢复测试');
  assert.equal(restored.materials[0].text, '保留这段文字');
});

test('演示提供者醒目标记且导出规则按成果类型限制', () => {
  const task = createTask({ title: '演示', goal: '核对演示标记', type: 'email' });
  const result = providerTest.demoResult(task);
  assert.match(result.summary, /演示提供者/);
  const artifact = createArtifact(task, result, 'demo');
  recordReview(task, artifact.id, passingReview());
  confirmArtifact(task, artifact.id);
  assert.match(serverTest.exportBody(task, artifact, 'eml').content, /X-Irixi-Status: Draft-Only/);
  assert.throws(() => serverTest.exportBody(task, artifact, 'ics'), /不支持/);

  const calendar = createTask({ title: '日程', goal: '准备试用日程', type: 'calendar' });
  const calendarArtifact = createArtifact(calendar, providerTest.demoResult(calendar), 'demo');
  recordReview(calendar, calendarArtifact.id, passingReview());
  confirmArtifact(calendar, calendarArtifact.id);
  assert.match(serverTest.exportBody(calendar, calendarArtifact, 'ics').content, /STATUS:TENTATIVE/);
  assert.match(serverTest.exportBody(calendar, calendarArtifact, 'html').content, /<!doctype html>/);
  assert.equal(serverTest.exportBody(calendar, calendarArtifact, 'md').extension, 'md');
});

test('研究工作只有保存可定位产物后才能完成', () => {
  const task = createTask({ goal: '比较三家供应商', type: 'research' });
  for (const [name, text] of [
    ['青松供应商', '含税价格 1200元\n交付周期 7天'],
    ['白鹭供应商', '含税价格 1350元\n交付周期 5天'],
    ['云杉供应商', '含税价格 1180元\n交付周期待确认'],
  ]) addMaterial(task, { name, text, source: `synthetic:${name}` });
  buildPlan(task);
  startExecution(task, activeGoal(task).id);
  beginWork(task, 'researcher');
  assert.throws(() => completeWork(task, 'researcher', null), /没有可检查产物/);
  const result = validateResearchResult(task, demoResearch(task));
  const item = completeWork(task, 'researcher', result);
  assert.equal(item.status, 'completed');
  assert.equal(item.result.observations.length, 3);
  assert.ok(item.result.observations.every((entry) => entry.materialId && /^L\d+-L\d+$/.test(entry.locator)));
  assert.equal(task.execution.delegations.length, 1);
  assert.equal(task.execution.delegations[0].status, 'returned');
  assert.deepEqual(task.execution.resultBatch.map((entry) => entry.role), ['researcher']);
});

test('不存在于来源的错误价格会被确定性审阅拦住', () => {
  const task = createTask({ goal: '比较供应商价格', type: 'research' });
  const material = addMaterial(task, { name: '青松供应商', text: '青松含税价格 1200元，交付周期 7天。', source: 'synthetic:qingsong' });
  const artifact = createArtifact(task, {
    title: '供应商比较', summary: '故意错误样例',
    content: '# 比较供应商价格\n\n青松含税价格为 9999元。',
    sources: ['青松供应商'],
    claims: [{ statement: '青松含税价格为 9999元', materialId: material.id, sourceName: material.name, locator: 'L1-L1', quote: material.text }],
  }, 'test');
  const review = recordReview(task, artifact.id, passingReview(artifact));
  assert.equal(review.passed, false);
  assert.match(review.checks.find((item) => item.name === '来源定位守卫').evidence, /关键数字|原文/);
  assert.throws(() => confirmArtifact(task, artifact.id), /尚未通过/);
});

test('关键数值守卫覆盖全部交付物，不只检查成果摘要', () => {
  const task = createTask({ goal: '形成价格说明与电子表格', type: 'document' });
  const material = addMaterial(task, { name: '报价', text: '甲木供应商含税价格 1200元。' });
  const artifact = createArtifact(task, {
    title: '多交付物候选', summary: '摘要不含错误数字', content: '# 价格说明\n\n详见配套表格。', sources: [material.name],
    claims: [{ statement: '甲木供应商含税价格 1200元', materialId: material.id, sourceName: material.name, locator: 'L1-L1', quote: material.text }],
    deliverables: [
      { kind: 'document', title: '说明', content: '# 说明\n\n甲木供应商含税价格 1200元。' },
      { kind: 'spreadsheet', title: '表格', content: '{"sheets":[{"name":"报价","rows":[["供应商","价格"],["甲木","9999元"]]}]}' },
    ],
  }, 'test');
  const review = recordReview(task, artifact.id, passingReview(artifact));
  assert.equal(review.passed, false);
  assert.match(review.checks.find((item) => item.name === '关键数值守卫').evidence, /9999/);
});

test('关键数值校验忽略数字与单位间的格式空格', () => {
  const task = createTask({ goal: '比较供应商价格与交付周期', type: 'research' });
  const material = addMaterial(task, {
    name: '报价记录',
    text: '青松办公设备总价为 12800 元，承诺 7 天内交付。',
    source: 'synthetic:spacing',
  });
  const claim = {
    statement: '青松办公设备总价12800元，7天内交付。',
    materialId: material.id,
    sourceName: material.name,
    locator: 'L1-L1',
    quote: material.text,
  };
  assert.equal(validateClaim(task, claim).passed, true);
});

test('来源校验把中文和 ISO 日期视为同一事实，同时保留精度边界', () => {
  const task = createTask({ goal: '核对会议日期' });
  const material = addMaterial(task, { name: '会议记录', text: '会议于2026-09-30确认，试点日期为2026年10月15日。' });
  assert.equal(validateClaim(task, { statement: '2026年9月30日已确认会议结论。', materialId: material.id, sourceName: material.name, locator: 'L1-L1', quote: material.text }).passed, true);
  assert.equal(validateClaim(task, { statement: '试点安排在2026-10-15。', materialId: material.id, sourceName: material.name, locator: 'L1-L1', quote: material.text }).passed, true);
  assert.equal(validateClaim(task, { statement: '试点安排在2026年10月16日。', materialId: material.id, sourceName: material.name, locator: 'L1-L1', quote: material.text }).passed, false);
});

test('公开页面精确采集时间不冒充业务日期，其他无来源日期仍被拦截', () => {
  const task = createTask({ goal: '整理公开页面事实' });
  const material = addMaterial(task, { name: '公开页面', text: '正文没有业务日期。', source: 'https://example.com/' });
  material.generatedEvidence = true;
  material.fetchedAt = '2026-09-30T15:42:31.552Z';
  material.evidenceSha256 = 'abc123';
  material.locator = 'https://example.com/#sha256=abc123';
  material.evidenceMetadata = { httpStatus: 200, contentType: 'text/html', resolutionMode: 'system-dns' };
  const exactMetadata = createArtifact(task, { title: '采集记录', summary: '候选', content: '采集时间：2026-09-30T15:42:31.552Z', sources: [], claims: [] }, 'test');
  const reviewPrompt = providerTest.reviewPrompt(task, exactMetadata);
  assert.match(reviewPrompt, /2026-09-30T15:42:31\.552Z/);
  assert.match(reviewPrompt, /web-read/);
  const exactReview = recordReview(task, exactMetadata.id, passingReview());
  assert.equal(exactReview.checks.find((item) => item.name === '关键数值守卫').passed, true);
  const inventedDate = createArtifact(task, { title: '错误日期', summary: '候选', content: '采集时间：2026-09-30T15:42:31.552Z；业务发布日期：2026-10-01。', sources: [], claims: [] }, 'test');
  const inventedReview = recordReview(task, inventedDate.id, passingReview());
  assert.equal(inventedReview.checks.find((item) => item.name === '关键数值守卫').passed, false);
  assert.match(inventedReview.checks.find((item) => item.name === '关键数值守卫').evidence, /2026-10-01/);
});

test('结构性 UUID 不冒充日期，与 ID 相邻的真实业务日期仍被检查', () => {
  const task = createTask({ goal: '整理公开文档事实' });
  const material = addMaterial(task, { name: '官方文档', text: '官方文档说明该功能已经可用。' });
  material.id = 'material-79835740-8a96-40d1-a06c-440ed4c610b7';
  const claims = [{ statement: '该功能已经可用', materialId: material.id, sourceName: material.name, locator: 'L1-L1', quote: material.text }];
  const referenced = createArtifact(task, { title: '引用索引', summary: '候选', content: `来源：${material.id}`, sources: [material.name], claims }, 'test');
  const referencedReview = recordReview(task, referenced.id, passingReview(referenced));
  assert.equal(referencedReview.checks.find((item) => item.name === '关键数值守卫').passed, true);

  const dated = createArtifact(task, { title: '错误日期', summary: '候选', content: `来源：${material.id}；业务日期：2026-10-01。`, sources: [material.name], claims }, 'test');
  const datedReview = recordReview(task, dated.id, passingReview(dated));
  const dateGuard = datedReview.checks.find((item) => item.name === '关键数值守卫');
  assert.equal(dateGuard.passed, false);
  assert.match(dateGuard.evidence, /2026-10-01/);
  assert.doesNotMatch(dateGuard.evidence, /5740/);
});

test('结构引用不依赖文件名，并允许中性名、短文件名和单文档多主体', () => {
  const task = createTask({ goal: '核对通用办公资料中的可追溯引用', type: 'research' });
  const neutral = addMaterial(task, { name: '材料1.txt', text: '甲木供应商：含税价格 1200元，交付 7天。', source: 'synthetic:neutral' });
  const short = addMaterial(task, { name: 'a.txt', text: '乙水供应商：含税价格 1350元，交付 5天。', source: 'synthetic:short' });
  const multi = addMaterial(task, { name: '会议纪要.docx', text: '丙火供应商报价 980元。\n丁金供应商报价 1080元。', source: 'synthetic:multi' });
  for (const claim of [
    { statement: '甲木供应商含税价格 1200元、交付 7天', materialId: neutral.id, sourceName: neutral.name, locator: 'L1-L1', quote: neutral.text },
    { statement: '乙水供应商含税价格 1350元、交付 5天', materialId: short.id, sourceName: short.name, locator: 'L1-L1', quote: short.text },
    { statement: '丁金供应商报价 1080元', materialId: multi.id, sourceName: multi.name, locator: 'L2-L2', quote: '丁金供应商报价 1080元。' },
  ]) assert.equal(validateClaim(task, claim).passed, true);
});

test('逐条语义审阅阻断主体条件错配，即使错误句同时含两个名称', () => {
  const task = createTask({ goal: '比较两家供应商的价格和交付条件', type: 'research' });
  const summary = addMaterial(task, { name: '报价汇总.docx', text: '甲木供应商：含税价格 1200元，交付 7天。\n乙水供应商：含税价格 1350元，交付 5天。', source: 'synthetic:summary' });
  const artifact = createArtifact(task, {
    title: '主体条件错配反例',
    summary: '价格与交付条件对调，但数字都存在于材料集合',
    content: '# 比较两家供应商的价格和交付条件\n\n相较乙水供应商，甲木供应商含税价格 1350元、交付 5天；相较甲木供应商，乙水供应商含税价格 1200元、交付 7天。',
    sources: [summary.name],
    claims: [
      { statement: '相较乙水供应商，甲木供应商含税价格 1350元、交付 5天', materialId: summary.id, sourceName: summary.name, locator: 'L2-L2', quote: '乙水供应商：含税价格 1350元，交付 5天。' },
      { statement: '相较甲木供应商，乙水供应商含税价格 1200元、交付 7天', materialId: summary.id, sourceName: summary.name, locator: 'L1-L1', quote: '甲木供应商：含税价格 1200元，交付 7天。' },
    ],
  }, 'counterexample');
  assert.ok(artifact.claims.every((claim) => validateClaim(task, claim).passed));
  const review = recordReview(task, artifact.id, passingReview(artifact, ['unsupported', 'unsupported']));
  assert.equal(review.passed, false);
  assert.equal(review.checks.find((item) => item.name === '来源定位守卫').passed, true);
  assert.match(review.checks.find((item) => item.name === '逐条事实语义审阅').evidence, /unsupported|错误归/);
  assert.throws(() => confirmArtifact(task, artifact.id), /尚未通过/);
});

test('正常候选逐条支持时通过，语义审阅缺项或不确定时阻断', () => {
  const task = createTask({ goal: '比较两家供应商的价格和交付条件', type: 'research' });
  const material = addMaterial(task, { name: '报价汇总.docx', text: '甲木供应商：含税价格 1200元，交付 7天。', source: 'synthetic:summary' });
  const makeArtifact = () => createArtifact(task, {
    title: '正常候选', summary: '可核对', content: '# 比较两家供应商的价格和交付条件\n\n甲木供应商含税价格 1200元、交付 7天。', sources: [material.name],
    claims: [{ statement: '甲木供应商含税价格 1200元、交付 7天', materialId: material.id, sourceName: material.name, locator: 'L1-L1', quote: material.text }],
  }, 'test');
  const supported = makeArtifact();
  assert.equal(recordReview(task, supported.id, passingReview(supported)).passed, true);
  const missing = makeArtifact();
  assert.equal(recordReview(task, missing.id, passingReview()).passed, false);
  const uncertain = makeArtifact();
  const uncertainResult = passingReview(uncertain);
  uncertainResult.claimChecks[0].verdict = 'uncertain';
  uncertainResult.claimChecks[0].evidence = '原文关系不足以确定。';
  assert.equal(recordReview(task, uncertain.id, uncertainResult).passed, false);
});

test('独立审阅提示包含可定位原文而不是只有材料名称', () => {
  const task = createTask({ goal: '比较供应商价格', type: 'research' });
  const instruction = addSuggestion(task, { text: '保留三点结论，并把正文缩短到 200 字以内。' });
  const material = addMaterial(task, { name: '青松供应商', text: '青松含税价格 1200元。', source: 'synthetic:qingsong' });
  const artifact = createArtifact(task, {
    title: '供应商比较', summary: '候选', content: '# 比较供应商价格\n\n青松含税价格 1200元。', sources: [material.name],
    claims: [{ statement: '青松含税价格 1200元', materialId: material.id, sourceName: material.name, locator: 'L1-L1', quote: material.text }],
  }, 'test');
  const prompt = providerTest.reviewPrompt(task, artifact);
  assert.match(prompt, /青松含税价格 1200元/);
  assert.match(prompt, /L1-L1/);
  assert.match(prompt, new RegExp(material.id));
  assert.match(providerTest.providerPrompt(task), new RegExp(instruction.id));
  assert.match(providerTest.providerPrompt(task), /缩短到 200 字以内/);
  assert.match(prompt, /缩短到 200 字以内/);
  assert.ok(artifact.instructionIds.includes(instruction.id));
});

test('模型调用预算耗尽不会变成成功', () => {
  const task = createTask({ goal: '形成有来源的比较报告', type: 'research', provider: 'codex-cli' });
  addMaterial(task, { name: '材料', text: '报价 1000元' });
  buildPlan(task);
  startExecution(task, activeGoal(task).id, { maxModelCalls: 2 });
  for (let index = 0; index < 2; index += 1) {
    const call = reserveModelCall(task, 'researcher');
    finishModelCall(task, call.id, { status: 'failed', error: '合成失败' });
  }
  assert.throws(() => reserveModelCall(task, 'researcher'), (error) => error.code === 'budget_exhausted');
  assert.equal(task.execution.modelCalls.length, 2);
  assert.notEqual(task.execution.phase, 'completed');
});
