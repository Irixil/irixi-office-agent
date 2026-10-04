import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
  acceptGoalReplacement,
  activeGoal,
  addMaterial,
  addSuggestion,
  artifactInputIsCurrent,
  createArtifact,
  createTask,
  projectInputFingerprint,
  publicTask,
} from '../core.mjs';
import {
  bindGeneratedEvidence,
  ensureMaterialPolicy,
  materialContext,
  recordMaterialDecision,
} from '../material-applicability.mjs';
import { __test as providerTest } from '../providers.mjs';
import { applyModelPlan, sessionInput } from '../orchestration.mjs';
import { runAuthorizedTools } from '../tools.mjs';

function decide(task, material, patch) {
  const context = materialContext(task, { includeGeneratedEvidence: false });
  const entry = context.directory.find((item) => item.id === material.id);
  return recordMaterialDecision(task, material.id, {
    category: 'goal_specific', disposition: 'use', impact: 'non_blocking', purpose: '当前目标使用', reason: '测试决定',
    ...patch,
    expectedFingerprint: context.fingerprint,
    expectedScope: context.scope,
    expectedContentSha256: entry.contentSha256,
  });
}

function replaceGoal(task, statement = '新版目标') {
  const suggestion = addSuggestion(task, { text: `替换目标为${statement}`, classification: 'replace' });
  return acceptGoalReplacement(task, suggestion.id, { statement, successCriteria: ['形成新版成果'], boundaries: ['不发布'] });
}

test('legacy 读取返回 null 指纹且失败材料不单独激活制度', () => {
  const task = createTask({ goal: '旧任务' });
  task.materials.push({ id: 'material-legacy', name: '旧材料', kind: 'text', source: 'user', status: 'ready', text: '旧正文', bytes: 9, createdAt: '2026-01-01T00:00:00Z' });
  assert.equal(materialContext(task).fingerprint, null);
  assert.deepEqual(materialContext(task).effectiveMaterials.map((item) => item.id), ['material-legacy']);
  addMaterial(task, { name: '损坏 PDF', status: 'failed', error: '无法解析' });
  assert.equal(task.materialApplicability, undefined);
  assert.equal(materialContext(task).fingerprint, null);
});

test('root 可复用事实跨目标，目标专属材料排除，关键约束要求重确认，可选约束不阻断', () => {
  const task = createTask({ goal: '旧目标' });
  const fact = addMaterial(task, { name: '事实', text: '试用人数为 12 人。' });
  const slogan = addMaterial(task, { name: '旧口号', text: '面向公开发布。' });
  const privateBoundary = addMaterial(task, { name: '私密边界', text: '不得上传真实客户记录。' });
  const layout = addMaterial(task, { name: '旧排版', text: '使用三栏布局。' });
  decide(task, fact, { category: 'reusable_fact', disposition: 'use', purpose: '沿用人数事实' });
  decide(task, slogan, { category: 'goal_specific', disposition: 'use', purpose: '旧发布目标口号' });
  decide(task, privateBoundary, { category: 'constraint', disposition: 'use', impact: 'required_for_delivery', purpose: '私密数据边界' });
  decide(task, layout, { category: 'constraint', disposition: 'pending', impact: 'non_blocking', purpose: '旧排版偏好' });
  replaceGoal(task, '准备私密试用');
  const context = materialContext(task);
  assert.deepEqual(context.effectiveMaterials.map((item) => item.id), [fact.id]);
  assert.equal(context.directory.find((item) => item.id === slogan.id).eligibility, 'scope_changed');
  assert.equal(context.directory.find((item) => item.id === layout.id).eligibility, 'scope_changed');
  assert.equal(context.blockingDecisions.length, 1);
  assert.equal(context.blockingDecisions[0].materialId, privateBoundary.id);
});

test('linked child 的事实可跨本地目标但不能跨 root scope', () => {
  const child = createTask({ goal: '子任务目标' });
  child.projectRootTaskId = 'task-root00';
  child.projectRootGoalVersionId = 'goal-root-v1';
  child.projectRootInputFingerprint = 'root-input-v1';
  const fact = addMaterial(child, { name: '子任务事实', text: '反馈窗口为 7 天。' });
  decide(child, fact, { category: 'reusable_fact', disposition: 'use', purpose: '沿用反馈窗口' });
  replaceGoal(child, '子任务新版目标');
  assert.equal(materialContext(child).directory.find((item) => item.id === fact.id).eligible, true);
  child.projectRootGoalVersionId = 'goal-root-v2';
  child.projectRootInputFingerprint = 'root-input-v2';
  assert.equal(materialContext(child).directory.find((item) => item.id === fact.id).eligible, false);
  child.projectRootTaskId = null;
  child.projectRootGoalVersionId = activeGoal(child).id;
  child.projectRootInputFingerprint = projectInputFingerprint(child);
  assert.equal(materialContext(child).directory.find((item) => item.id === fact.id).eligible, false);
});

test('迟到决定按 fingerprint、scope 与正文 hash 拒绝', () => {
  const task = createTask({ goal: '当前目标' });
  const material = addMaterial(task, { name: '边界', text: '不发送。' });
  const stale = materialContext(task, { includeGeneratedEvidence: false });
  decide(task, material, { category: 'constraint', disposition: 'use', impact: 'required_for_delivery', purpose: '发送边界' });
  assert.throws(() => recordMaterialDecision(task, material.id, {
    category: 'constraint', disposition: 'exclude', impact: 'non_blocking', purpose: '迟到操作', reason: '',
    expectedFingerprint: stale.fingerprint, expectedScope: stale.scope,
    expectedContentSha256: stale.directory.find((item) => item.id === material.id).contentSha256,
  }), /刷新后重新提交/);
});

test('read/search/calculate 不能绕过当前适用范围', async () => {
  const task = createTask({ goal: '新版预算' });
  const material = addMaterial(task, { name: '旧报价', text: '单价 3600 元。' });
  decide(task, material, { category: 'goal_specific', disposition: 'exclude', purpose: '旧目标报价', reason: '当前不使用' });
  const item = { tools: ['materials.read', 'materials.search', 'calculate'], title: '核对' };
  const results = await runAuthorizedTools({}, task, item, [
    { id: 'read', tool: 'materials.read', args: { materialIds: [material.id] } },
    { id: 'search', tool: 'materials.search', args: { query: '3600' } },
    { id: 'calc', tool: 'calculate', args: { expression: 'price', inputs: [{ name: 'price', value: 3600, sourceRef: `material:${material.id}#L1-L1` }] } },
  ]);
  assert.equal(results[0].ok, false);
  assert.deepEqual(results[1].result, []);
  assert.equal(results[2].ok, false);
});

test('制度激活后无材料指纹的旧 artifact 只作历史', () => {
  const task = createTask({ goal: '旧任务' });
  const artifact = createArtifact(task, { title: '旧成果', content: '旧成果正文', sources: [], claims: [] }, 'test');
  assert.equal(artifactInputIsCurrent(task, artifact), true);
  ensureMaterialPolicy(task, 'test_activation');
  assert.equal(artifactInputIsCurrent(task, artifact), false);
});

test('planner 排除已有网页证据，同一执行链工作上下文仍可读取', () => {
  const task = createTask({ goal: '规划新一轮研究', provider: 'codex-cli' });
  task.plan = { revision: 1 };
  const item = {
    id: 'work-current', role: 'researcher', kind: 'research', stepKey: 'research-old', title: '旧网页研究', status: 'completed',
    goalVersionId: activeGoal(task).id, projectRootGoalVersionId: activeGoal(task).id, sourceContextFingerprint: 'source-current',
    result: {
      summary: 'OLD-WEB-SUMMARY-SENTINEL', output: 'OLD-WEB-OUTPUT-SENTINEL',
      observations: [{ materialId: 'material-web00', quote: 'OLD-WEB-QUOTE-SENTINEL' }],
      sources: ['https://example.com/report-old-sentinel'],
    },
  };
  task.workItems = [item];
  const evidence = { id: 'material-web00', name: '网页证据', kind: 'url', source: 'https://example.com', status: 'ready', text: '不应进入下一次规划的唯一网页正文', bytes: 20, createdAt: new Date().toISOString(), generatedEvidence: true };
  task.materials.push(evidence);
  bindGeneratedEvidence(task, evidence, item);
  assert.equal(materialContext(task).effectiveMaterials.includes(evidence), true);
  const prompt = providerTest.plannerPrompt(task, { replan: true, failure: { message: '重规划' } });
  assert.doesNotMatch(prompt, /不应进入下一次规划的唯一网页正文/);
  assert.doesNotMatch(prompt, /https:\/\/example\.com/);
  assert.doesNotMatch(prompt, /OLD-WEB-(?:SUMMARY|OUTPUT|QUOTE)-SENTINEL|report-old-sentinel/);
});

test('legacy 网页证据无 binding 时维持原读取行为，制度激活后要求当前执行链 binding', () => {
  const task = createTask({ goal: '延续旧研究' });
  const evidence = { id: 'material-web-legacy', name: '旧网页证据', kind: 'url', source: 'https://example.com/legacy', status: 'ready', text: '旧网页正文', bytes: 18, createdAt: '2026-01-01T00:00:00.000Z', generatedEvidence: true };
  task.materials.push(evidence);
  assert.equal(materialContext(task).directory.find((item) => item.id === evidence.id).eligible, true);
  ensureMaterialPolicy(task, 'explicit_change');
  assert.equal(materialContext(task).directory.find((item) => item.id === evidence.id).eligible, false);
});

test('legacy 模型计划保持旧 sourceContextFingerprint、inputFingerprint 与材料 ID 算法', () => {
  const task = createTask({ goal: '比较报价并形成说明' });
  task.materials.push({ id: 'material-legacy-plan', name: '旧报价', kind: 'text', source: 'user', status: 'ready', text: '单价 3600 元。', bytes: 20, createdAt: '2026-01-01T00:00:00.000Z' });
  const simplePlan = {
    summary: '形成候选并审阅。', outputKind: 'document', deliverables: ['document'],
    roles: [
      { key: 'author', name: '作者', mission: '形成候选', capabilities: ['写作'], recruitmentReason: '需要候选。' },
      { key: 'auditor', name: '审阅员', mission: '独立审阅', capabilities: ['审阅'], recruitmentReason: '需要核对。' },
      { key: 'courier', name: '交付员', mission: '等待确认', capabilities: ['交付'], recruitmentReason: '守住确认边界。' },
    ],
    steps: [
      { key: 'synthesize', title: '形成候选', kind: 'synthesis', role: 'author', dependsOn: [], tools: [], acceptanceCriteria: ['形成文档'], expectedResult: '候选文档' },
      { key: 'review', title: '独立审阅', kind: 'review', role: 'auditor', dependsOn: ['synthesize'], tools: [], acceptanceCriteria: ['核对目标'], expectedResult: '审阅记录' },
      { key: 'deliver', title: '等待确认', kind: 'delivery', role: 'courier', dependsOn: ['review'], tools: [], acceptanceCriteria: ['只交付指定版本'], expectedResult: '正式交付' },
    ],
  };
  applyModelPlan(task, simplePlan);
  const goalVersionId = activeGoal(task).id;
  const projectRootGoalVersionId = task.projectRootGoalVersionId;
  const projectRootInputFingerprint = task.projectRootInputFingerprint;
  const materialFingerprint = [{ id: 'material-legacy-plan', bytes: 20, createdAt: '2026-01-01T00:00:00.000Z', contentSha256: crypto.createHash('sha256').update('单价 3600 元。').digest('hex') }];
  const instructionFingerprint = [];
  const expectedSource = crypto.createHash('sha256').update(JSON.stringify({ goalVersionId, projectRootGoalVersionId, projectRootInputFingerprint, materialFingerprint, instructionFingerprint })).digest('hex');
  assert.equal(task.workItems[0].sourceContextFingerprint, expectedSource);
  const expectedInput = crypto.createHash('sha256').update(JSON.stringify({ goalVersionId, projectRootGoalVersionId, projectRootInputFingerprint, step: { ...simplePlan.steps[0], webScope: null }, materialFingerprint, instructionFingerprint, dependencyFingerprints: [] })).digest('hex');
  assert.equal(task.workItems[0].inputFingerprint, expectedInput);
  assert.deepEqual(task.workItems[0].inputMaterialIds, ['material-legacy-plan']);
});

test('材料决定不进入 root projectInputFingerprint，正文变化会让旧候选失效', () => {
  const task = createTask({ goal: '形成当前说明' });
  const beforeProject = projectInputFingerprint(task);
  const material = addMaterial(task, { name: '当前事实', text: '人数为 12。' });
  decide(task, material, { category: 'reusable_fact', purpose: '人数参考' });
  assert.equal(projectInputFingerprint(task), beforeProject);
  const artifact = createArtifact(task, { title: '当前候选', content: '根据当前事实形成的说明。', sources: [], claims: [] }, 'test');
  assert.equal(artifactInputIsCurrent(task, artifact), true);
  material.text = '人数为 13。';
  assert.equal(artifactInputIsCurrent(task, artifact), false);
});

test('关键待确认材料不妨碍其他研究但会阻止候选，公开规划材料 ID 排除网页证据', async () => {
  const task = createTask({ goal: '形成私密试用说明' });
  const fact = addMaterial(task, { name: '人数事实', text: '人数为 12。' });
  const critical = addMaterial(task, { name: '私密约束', text: '不得上传客户记录。' });
  decide(task, fact, { category: 'reusable_fact', purpose: '人数参考' });
  decide(task, critical, { category: 'constraint', disposition: 'pending', impact: 'required_for_delivery', purpose: '私密数据边界' });
  const search = await runAuthorizedTools({}, task, { tools: ['materials.search'], title: '研究' }, [{ id: 'search', tool: 'materials.search', args: { query: '人数' } }]);
  assert.equal(search[0].ok, true);
  assert.deepEqual(search[0].result.map((entry) => entry.materialId), [fact.id]);
  assert.throws(() => createArtifact(task, { title: '不应生成', content: '不应生成候选', sources: [], claims: [] }, 'test'), /需要决定/);
  task.plan = { revision: 1 };
  const work = { id: 'work-web-current', goalVersionId: activeGoal(task).id, projectRootGoalVersionId: activeGoal(task).id, sourceContextFingerprint: 'source-web-current' };
  task.workItems = [work];
  const evidence = { id: 'material-web-current', name: '当前网页证据', kind: 'url', source: 'https://example.com/current', status: 'ready', text: '网页正文', bytes: 12, createdAt: new Date().toISOString(), generatedEvidence: true };
  task.materials.push(evidence);
  bindGeneratedEvidence(task, evidence, work);
  assert.equal(materialContext(task).effectiveMaterials.includes(evidence), true);
  assert.equal(publicTask(task).materialContext.effectiveMaterialIds.includes(evidence.id), false);
});

test('网页证据去重复用时补登记新执行链 binding', () => {
  const task = createTask({ goal: '继续网页研究' });
  ensureMaterialPolicy(task, 'test_active_policy');
  task.plan = { revision: 1 };
  const first = { id: 'work-web-1', goalVersionId: activeGoal(task).id, projectRootGoalVersionId: activeGoal(task).id, sourceContextFingerprint: 'source-web-1' };
  task.workItems = [first];
  const evidence = { id: 'material-web-dedup', name: '网页证据', kind: 'url', source: 'https://example.com/dedup', status: 'ready', text: '同一网页正文', bytes: 18, createdAt: new Date().toISOString(), generatedEvidence: true };
  task.materials.push(evidence);
  bindGeneratedEvidence(task, evidence, first);
  assert.equal(materialContext(task).directory.find((entry) => entry.id === evidence.id).eligible, true);
  task.plan = { revision: 2 };
  const second = { id: 'work-web-2', goalVersionId: activeGoal(task).id, projectRootGoalVersionId: activeGoal(task).id, sourceContextFingerprint: 'source-web-2' };
  task.workItems = [second];
  assert.equal(materialContext(task).directory.find((entry) => entry.id === evidence.id).eligible, false);
  bindGeneratedEvidence(task, evidence, second);
  assert.equal(evidence.evidenceBindings.length, 2);
  assert.equal(materialContext(task).directory.find((entry) => entry.id === evidence.id).eligible, true);
});

test('正文改变只看该材料最新决定，关键约束不降级且旧同 hash 决定不复活', () => {
  const task = createTask({ goal: '形成受约束交付' });
  const material = addMaterial(task, { name: '边界材料', text: 'A 版：内部使用。' });
  decide(task, material, { category: 'reusable_fact', purpose: '旧 A 版参考' });
  material.text = 'B 版：不得上传客户记录。';
  decide(task, material, { category: 'constraint', disposition: 'use', impact: 'required_for_delivery', purpose: '私密数据边界' });
  material.text = 'A 版：内部使用。';
  const reverted = materialContext(task).directory.find((entry) => entry.id === material.id);
  assert.equal(reverted.eligible, false);
  assert.equal(reverted.eligibility, 'needs_reconfirmation');
  assert.equal(materialContext(task).blockingDecisions[0].materialId, material.id);
  assert.throws(() => createArtifact(task, { title: '被挡候选', content: '不得生成', sources: [], claims: [] }, 'test'), /正文已变化/);
});

test('非 ready 生成证据即使 legacy 无 binding 也不可读', () => {
  const task = createTask({ goal: '旧研究' });
  const evidence = { id: 'material-web-failed', name: '失败网页证据', kind: 'url', source: 'https://example.com/failed', status: 'failed', error: '读取失败', text: '不可信残留正文', bytes: 18, createdAt: new Date().toISOString(), generatedEvidence: true };
  task.materials.push(evidence);
  const entry = materialContext(task).directory.find((item) => item.id === evidence.id);
  assert.equal(entry.eligible, false);
  assert.equal(materialContext(task).effectiveMaterials.includes(evidence), false);
});

test('全部模型 prompt 不注入排除或待确认正文，并明确非关键材料不扩大 gap', () => {
  const task = createTask({ goal: '准备私密试用', provider: 'codex-cli' });
  const fact = addMaterial(task, { name: '当前事实', text: 'CURRENT-FACT-BODY' });
  const old = addMaterial(task, { name: '旧发布材料', text: 'OLD-SLOGAN-BODY-DO-NOT-INJECT' });
  const optional = addMaterial(task, { name: '旧排版材料', text: 'OPTIONAL-LAYOUT-BODY-DO-NOT-INJECT' });
  const critical = addMaterial(task, { name: '私密约束', text: 'CRITICAL-PENDING-BODY-DO-NOT-INJECT' });
  decide(task, fact, { category: 'reusable_fact', purpose: '当前事实参考' });
  decide(task, old, { category: 'goal_specific', disposition: 'exclude', purpose: '旧目标专属' });
  decide(task, optional, { category: 'constraint', disposition: 'pending', impact: 'non_blocking', purpose: '非关键排版' });
  decide(task, critical, { category: 'constraint', disposition: 'pending', impact: 'required_for_delivery', purpose: '交付前私密边界' });
  task.team = { agents: [{ id: 'agent-research', name: '研究员' }] };
  task.plan = { revision: 1, deliverables: ['document'] };
  const item = { id: 'work-research', agentId: 'agent-research', role: 'researcher', kind: 'research', title: '核对当前事实', acceptanceCriteria: ['核对事实'] };
  task.workItems = [item];
  const artifact = { id: 'artifact-prompt', title: '提示测试候选', content: '只含 CURRENT-FACT-BODY', claims: [], deliverables: [], nativeFiles: [] };
  task.artifacts.push(artifact);
  const context = materialContext(task);
  const prompts = [
    providerTest.plannerPrompt(task),
    providerTest.workPrompt(task, item, { materialDirectory: context.directory, materialApplicability: { fingerprint: context.fingerprint, blockingDecisions: context.blockingDecisions } }),
    providerTest.researchPrompt(task),
    providerTest.providerPrompt(task),
    providerTest.reviewPrompt(task, artifact),
    providerTest.conversationPrompt(task, 'researcher', '现在能继续哪些工作？'),
  ];
  for (const prompt of prompts) {
    assert.doesNotMatch(prompt, /OLD-SLOGAN-BODY-DO-NOT-INJECT|OPTIONAL-LAYOUT-BODY-DO-NOT-INJECT|CRITICAL-PENDING-BODY-DO-NOT-INJECT/);
  }
  assert.match(prompts[0], /eligible=false/);
  assert.match(prompts[0], /不依赖它的研究/);
  assert.match(prompts[1], /非关键排除不能擅自升级为阻断性 gap/);
  assert.match(prompts[4], /材料适用范围与决定指纹/);
  assert.match(prompts[4], /旧目标专属/);
});

test('重规划不复用依赖旧 generated evidence 的已完成 web 研究', () => {
  const task = createTask({ goal: '形成公开资料简报', provider: 'codex-cli' });
  const plan = {
    summary: '读取公开页后形成简报。', outputKind: 'document', deliverables: ['document'],
    roles: [
      { key: 'researcher', name: '研究员', mission: '读取公开页', capabilities: ['网页研究'], recruitmentReason: '需要外部资料。' },
      { key: 'author', name: '作者', mission: '形成简报', capabilities: ['写作'], recruitmentReason: '需要交付。' },
      { key: 'auditor', name: '审阅员', mission: '独立核对', capabilities: ['审阅'], recruitmentReason: '需要独立核对。' },
      { key: 'courier', name: '交付员', mission: '等待确认', capabilities: ['交付'], recruitmentReason: '守住确认边界。' },
    ],
    steps: [
      { key: 'research', title: '读取公开页', kind: 'research', role: 'researcher', dependsOn: [], tools: ['web.read'], webScope: { queries: [], urls: ['https://example.com/current'] }, acceptanceCriteria: ['记录可定位事实'], expectedResult: '公开页事实' },
      { key: 'synthesize', title: '形成简报', kind: 'synthesis', role: 'author', dependsOn: ['research'], tools: [], acceptanceCriteria: ['形成文档'], expectedResult: '候选文档' },
      { key: 'review', title: '独立核对', kind: 'review', role: 'auditor', dependsOn: ['synthesize'], tools: [], acceptanceCriteria: ['核对事实'], expectedResult: '审阅记录' },
      { key: 'deliver', title: '等待确认', kind: 'delivery', role: 'courier', dependsOn: ['review'], tools: [], acceptanceCriteria: ['只交付指定版本'], expectedResult: '正式交付' },
    ],
  };
  applyModelPlan(task, plan);
  const first = task.workItems.find((item) => item.stepKey === 'research');
  const evidence = { id: 'material-web-reuse', name: '公开页', kind: 'url', source: 'https://example.com/current', status: 'ready', text: 'RETIRED-WEB-BODY-SENTINEL', bytes: 24, createdAt: new Date().toISOString(), generatedEvidence: true };
  task.materials.push(evidence);
  bindGeneratedEvidence(task, evidence, first);
  first.status = 'completed';
  first.result = { summary: 'RETIRED-WEB-SUMMARY-SENTINEL', output: 'RETIRED-WEB-OUTPUT-SENTINEL', claims: [{ materialId: evidence.id, quote: 'RETIRED-WEB-QUOTE-SENTINEL' }], sources: [`material:${evidence.id}#L1-L1`] };
  applyModelPlan(task, plan, { reason: 'gap_replan', preserveCompleted: true });
  const next = task.workItems.find((item) => item.stepKey === 'research');
  assert.equal(next.reusedFromWorkItemId, null);
  assert.notEqual(next.status, 'completed');
  assert.equal(materialContext(task).directory.find((item) => item.id === evidence.id).eligible, false);
  const input = sessionInput(task, next);
  assert.deepEqual(input.historicalCompletedEvidence, []);
  assert.doesNotMatch(providerTest.workPrompt(task, next, input), /RETIRED-WEB-(?:BODY|SUMMARY|OUTPUT|QUOTE)-SENTINEL/);
});

test('独立审阅按当前候选依赖链取得动态研究角色结果和成功读取记录', () => {
  const task = createTask({ goal: '依据当前材料形成可核对试用准备稿', provider: 'codex-cli' });
  const material = addMaterial(task, { name: '当前试用事实', text: 'CURRENT-MATERIAL-BODY-SENTINEL' });
  const plan = {
    summary: '先读取材料，再形成候选并独立审阅。', outputKind: 'document', deliverables: ['document'],
    roles: [
      { key: 'material_researcher', name: '材料核对员', mission: '读取当前材料', capabilities: ['材料核对'], recruitmentReason: '需要真实读取证据。' },
      { key: 'author', name: '作者', mission: '形成候选', capabilities: ['写作'], recruitmentReason: '需要形成交付物。' },
      { key: 'auditor', name: '审阅员', mission: '独立核对', capabilities: ['审阅'], recruitmentReason: '需要独立审阅。' },
      { key: 'courier', name: '交付员', mission: '等待确认', capabilities: ['交付'], recruitmentReason: '守住确认边界。' },
    ],
    steps: [
      { key: 'read_current', title: '读取当前材料', kind: 'research', role: 'material_researcher', dependsOn: [], tools: ['materials.read'], webScope: { queries: [], urls: [] }, acceptanceCriteria: ['记录当前事实'], expectedResult: '可核对材料事实' },
      { key: 'synthesize', title: '形成试用准备稿', kind: 'synthesis', role: 'author', dependsOn: ['read_current'], tools: [], webScope: { queries: [], urls: [] }, acceptanceCriteria: ['形成文档'], expectedResult: '候选文档' },
      { key: 'review', title: '独立审阅', kind: 'review', role: 'auditor', dependsOn: ['synthesize'], tools: [], webScope: { queries: [], urls: [] }, acceptanceCriteria: ['核对来源'], expectedResult: '审阅记录' },
      { key: 'deliver', title: '等待确认', kind: 'delivery', role: 'courier', dependsOn: ['review'], tools: [], webScope: { queries: [], urls: [] }, acceptanceCriteria: ['只交付指定版本'], expectedResult: '正式交付' },
    ],
  };
  applyModelPlan(task, plan);
  const research = task.workItems.find((item) => item.kind === 'research');
  const synthesis = task.workItems.find((item) => item.kind === 'synthesis');
  const review = task.workItems.find((item) => item.kind === 'review');
  research.status = 'completed';
  research.result = { summary: 'CURRENT-RESEARCH-SUMMARY-SENTINEL', output: 'CURRENT-RESEARCH-OUTPUT-SENTINEL', sources: [`material:${material.id}#L1-L1`], claims: [] };
  const researchSession = task.agentSessions.find((session) => session.workItemId === research.id);
  researchSession.status = 'completed';
  researchSession.toolCalls = [
    { requestId: 'read-current', tool: 'materials.read', ok: true, result: [{ materialId: material.id, locator: 'L1-L1', text: material.text }], sources: [`material:${material.id}#L1-L1`] },
    { requestId: 'failed-read', tool: 'materials.read', ok: false, error: 'FAILED-TOOL-RECORD-SENTINEL', sources: [] },
  ];
  const unrelated = { ...structuredClone(research), id: 'unrelated-current', stepKey: 'unrelated', title: '不属于候选依赖链', result: { output: 'UNRELATED-CURRENT-RESULT-SENTINEL' } };
  const staleMaterialScope = { ...structuredClone(research), id: 'stale-material-scope', stepKey: 'stale-material', title: '旧材料范围', materialApplicabilityFingerprint: 'old-material-fingerprint', result: { output: 'STALE-MATERIAL-SCOPE-SENTINEL' } };
  const staleRootScope = { ...structuredClone(research), id: 'stale-root-scope', stepKey: 'stale-root', title: '旧根范围', projectRootGoalVersionId: 'old-root-goal', result: { output: 'STALE-ROOT-SCOPE-SENTINEL' } };
  const staleSourceScope = { ...structuredClone(research), id: 'stale-source-scope', stepKey: 'stale-source', title: '旧来源范围', sourceContextFingerprint: 'old-source-context', result: { output: 'STALE-SOURCE-SCOPE-SENTINEL' } };
  const webResearch = { ...structuredClone(research), id: 'candidate-web-research', stepKey: 'candidate_web', title: '当前计划网页研究', tools: ['web.read'], result: { output: 'CHAIN-WEB-RESULT-SENTINEL', sources: ['https://example.com/chain'] } };
  const webSession = { ...structuredClone(researchSession), id: 'candidate-web-session', workItemId: webResearch.id, toolCalls: [{ requestId: 'read-chain-web', tool: 'web.read', ok: true, result: 'CHAIN-WEB-TOOL-SENTINEL', sources: ['material:material-chain-web#L1-L1'] }] };
  task.workItems.push(unrelated, staleMaterialScope, staleRootScope, staleSourceScope, webResearch);
  task.agentSessions.push(webSession);
  const chainWebMaterial = { id: 'material-chain-web', name: '当前链网页证据', kind: 'url', source: 'https://example.com/chain', status: 'ready', text: 'CHAIN-WEB-BODY-SENTINEL', bytes: 23, createdAt: new Date().toISOString(), generatedEvidence: true };
  task.materials.push(chainWebMaterial);
  bindGeneratedEvidence(task, chainWebMaterial, webResearch);
  synthesis.dependsOn.push(staleMaterialScope.id, staleRootScope.id, staleSourceScope.id, webResearch.id);
  synthesis.status = 'running';
  const artifact = createArtifact(task, { title: '当前候选', summary: '候选', content: `# ${activeGoal(task).statement}\n\n${material.text}`, sources: [material.name], claims: [] }, 'codex-cli');
  synthesis.status = 'completed';
  synthesis.result = { artifactId: artifact.id, output: artifact.content };
  const synthesisSession = task.agentSessions.find((session) => session.workItemId === synthesis.id);
  synthesisSession.status = 'completed';
  synthesisSession.output = synthesis.result;
  review.status = 'running';
  task.agentSessions.find((session) => session.workItemId === review.id).toolCalls = [];

  const retired = { id: 'material-retired-review', name: '旧网页', kind: 'url', source: 'https://example.com/retired', status: 'ready', text: 'RETIRED-REVIEW-BODY-SENTINEL', bytes: 28, createdAt: new Date().toISOString(), generatedEvidence: true, evidenceBindings: [{ workItemId: 'old-research', goalVersionId: activeGoal(task).id, projectRootGoalVersionId: activeGoal(task).id, sourceContextFingerprint: 'old-source', planRevision: 0 }] };
  task.materials.push(retired);
  task.workHistory = [{ archivedAt: new Date().toISOString(), items: [{ id: 'old-research', kind: 'research', role: 'researcher', status: 'completed', goalVersionId: activeGoal(task).id, result: { output: 'RETIRED-REVIEW-RESULT-SENTINEL' } }] }];
  task.agentSessions.push({ id: 'old-session', workItemId: 'old-research', status: 'completed', goalVersionId: activeGoal(task).id, planRevision: 0, toolCalls: [{ tool: 'web.read', ok: true, result: 'RETIRED-REVIEW-TOOL-SENTINEL' }] });

  const prompt = providerTest.reviewPrompt(task, artifact);
  assert.match(prompt, /material_researcher/);
  assert.match(prompt, /CURRENT-RESEARCH-OUTPUT-SENTINEL/);
  assert.match(prompt, /read-current/);
  assert.match(prompt, /CURRENT-MATERIAL-BODY-SENTINEL/);
  assert.match(prompt, /CHAIN-WEB-RESULT-SENTINEL/);
  assert.doesNotMatch(prompt, /FAILED-TOOL-RECORD-SENTINEL/);
  assert.doesNotMatch(prompt, /RETIRED-REVIEW-(?:BODY|RESULT|TOOL)-SENTINEL|UNRELATED-CURRENT-RESULT-SENTINEL|STALE-(?:MATERIAL|ROOT|SOURCE)-SCOPE-SENTINEL/);

  task.workHistory.push({ archivedAt: new Date().toISOString(), reason: 'gap_replan', goalVersionId: activeGoal(task).id, items: structuredClone(task.workItems) });
  task.plan = { ...task.plan, revision: task.plan.revision + 1 };
  task.workItems = [{ ...structuredClone(review), id: 'new-plan-review', status: 'pending', result: null, dependsOn: [] }];
  const archivedPrompt = providerTest.reviewPrompt(task, artifact);
  assert.match(archivedPrompt, /CURRENT-RESEARCH-OUTPUT-SENTINEL/);
  assert.match(archivedPrompt, /read-current/);
  assert.doesNotMatch(archivedPrompt, /RETIRED-REVIEW-(?:BODY|RESULT|TOOL)-SENTINEL|UNRELATED-CURRENT-RESULT-SENTINEL|STALE-(?:MATERIAL|ROOT|SOURCE)-SCOPE-SENTINEL|FAILED-TOOL-RECORD-SENTINEL|CHAIN-WEB-(?:BODY|RESULT|TOOL)-SENTINEL/);
});
