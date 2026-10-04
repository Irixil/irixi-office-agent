import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  activeGoal,
  addMaterial,
  buildPlan,
  createArtifact,
  createStore,
  createTask,
  recordReview,
} from '../core.mjs';
import {
  finishModelCall,
  reserveModelCall,
  startExecution,
  transitionExecution,
} from '../execution.mjs';
import { createProviders } from '../providers.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const evidenceRoot = path.resolve(process.argv[2]);
await fs.mkdir(evidenceRoot, { recursive: false });

const store = createStore(path.join(evidenceRoot, 'tasks'));
const task = createTask({
  title: '独立审阅语义边界核查',
  goal: '核对两家虚构供应商的价格与交付条件是否与原文一致',
  type: 'research',
  provider: 'codex-cli',
  successCriteria: ['逐条核对每个事实声明的主体、数值和关系'],
  boundaries: ['只使用虚构材料', '不执行外部操作', '不确定时必须阻断'],
});
const material = addMaterial(task, {
  name: '材料1.txt',
  source: 'synthetic-fixture:materials-1',
  text: '甲木供应商：含税价格 1200元，交付 7天。\n乙水供应商：含税价格 1350元，交付 5天。',
});
buildPlan(task);
startExecution(task, activeGoal(task).id);
transitionExecution(task, 'reviewing');

const correct = createArtifact(task, {
  title: '正确对应样例',
  summary: '主体、数值和交付条件与原文一致',
  content: `# ${activeGoal(task).statement}\n\n甲木供应商含税价格 1200元、交付 7天；乙水供应商含税价格 1350元、交付 5天。`,
  sources: [material.name],
  claims: [
    { statement: '甲木供应商含税价格 1200元、交付 7天', materialId: material.id, sourceName: material.name, locator: 'L1-L1', quote: '甲木供应商：含税价格 1200元，交付 7天。' },
    { statement: '乙水供应商含税价格 1350元、交付 5天', materialId: material.id, sourceName: material.name, locator: 'L2-L2', quote: '乙水供应商：含税价格 1350元，交付 5天。' },
  ],
}, 'semantic-fixture');

const swapped = createArtifact(task, {
  title: '主体条件互换反例',
  summary: '每句同时出现两个名字，但把引用行的条件归给另一主体',
  content: `# ${activeGoal(task).statement}\n\n相较乙水供应商，甲木供应商含税价格 1350元、交付 5天；相较甲木供应商，乙水供应商含税价格 1200元、交付 7天。`,
  sources: [material.name],
  claims: [
    { statement: '相较乙水供应商，甲木供应商含税价格 1350元、交付 5天', materialId: material.id, sourceName: material.name, locator: 'L2-L2', quote: '乙水供应商：含税价格 1350元，交付 5天。' },
    { statement: '相较甲木供应商，乙水供应商含税价格 1200元、交付 7天', materialId: material.id, sourceName: material.name, locator: 'L1-L1', quote: '甲木供应商：含税价格 1200元，交付 7天。' },
  ],
}, 'semantic-fixture');

await store.save(task);
const providers = createProviders({ projectRoot, store });
const connection = await providers.verifyCodex();
assert.equal(connection.ok, true, connection.message);

async function reviewCase(label, artifact) {
  const call = reserveModelCall(task, 'reviewer');
  await store.save(task);
  try {
    const raw = await providers.review(task, artifact);
    finishModelCall(task, call.id, { status: 'completed', usage: raw?._providerMeta?.usage || 'unknown' });
    const review = recordReview(task, artifact.id, raw);
    await store.save(task);
    return { label, ok: true, reviewId: review.id, passed: review.passed, claimChecks: review.claimChecks, checks: review.checks };
  } catch (error) {
    finishModelCall(task, call.id, { status: 'failed', error: error.message });
    await store.save(task);
    return { label, ok: false, error: error.message };
  }
}

const results = [];
results.push(await reviewCase('correct', correct));
results.push(await reviewCase('swapped', swapped));

const summary = {
  provider: 'codex-cli',
  providerVersion: connection.message,
  modelCallCount: task.execution.modelCalls.length,
  modelUsage: task.execution.modelCalls.map((call) => call.usage),
  correct: results[0],
  swapped: results[1],
  expected: { correctPassed: true, swappedPassed: false },
};
await fs.writeFile(path.join(evidenceRoot, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

assert.equal(results[0].ok, true, results[0].error);
assert.equal(results[1].ok, true, results[1].error);
assert.equal(results[0].passed, true, '正确样例未通过真实独立审阅');
assert.equal(results[1].passed, false, '主体条件互换反例未被真实独立审阅阻断');
assert.equal(task.execution.modelCalls.length, 2);
