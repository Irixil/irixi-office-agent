import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  activeGoal,
  addMaterial,
  assertExportAllowed,
  buildPlan,
  confirmArtifact,
  createArtifact,
  createStore,
  createTask,
  recordReview,
} from '../core.mjs';
import {
  beginWork,
  completeWork,
  finishModelCall,
  reserveModelCall,
  startExecution,
  transitionExecution,
  validateResearchResult,
} from '../execution.mjs';
import { createProviders } from '../providers.mjs';
import { __test as serverTest } from '../server.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const evidenceRoot = path.resolve(process.argv[2] || path.join(projectRoot, 'docs/sdlc/evidence/core-integration/real-model-supplier'));
await fs.mkdir(evidenceRoot, { recursive: false });

const store = createStore(path.join(evidenceRoot, 'tasks'));
const task = createTask({
  title: '三家虚构供应商比较',
  goal: '比较三家供应商的含税价格、交付周期和售后，并给出有来源的采购建议',
  type: 'research',
  provider: 'codex-cli',
  successCriteria: ['逐家列出价格、交付周期和售后', '指出信息缺口', '给出带条件的建议'],
  boundaries: ['供应商均为虚构', '不得联系供应商', '不得执行外部操作', '不得编造缺失信息'],
});

for (const [name, text] of [
  ['青松供应商.txt', '青松办公设备：含税总价 12,800元；签约后 7天交付；整机保修 12个月；不含上门安装。'],
  ['白鹭供应商.txt', '白鹭商贸：含税总价 13,500元；签约后 5天交付；整机保修 18个月；含一次上门安装。'],
  ['云杉供应商.txt', '云杉科技：含税总价 11,900元；交付周期待确认；整机保修 12个月；上门安装费用待确认。'],
]) addMaterial(task, { name, source: `synthetic-fixture:${name}`, text });

buildPlan(task);
startExecution(task, activeGoal(task).id);
const providers = createProviders({ projectRoot, store });
const connection = await providers.verifyCodex();
assert.equal(connection.ok, true, connection.message);

async function modelCall(role, invoke) {
  const call = reserveModelCall(task, role);
  await store.save(task);
  try {
    const result = await invoke();
    finishModelCall(task, call.id, { status: 'completed', usage: result?._providerMeta?.usage || 'unknown' });
    await store.save(task);
    return result;
  } catch (error) {
    finishModelCall(task, call.id, { status: 'failed', error: error.message });
    await store.save(task);
    throw error;
  }
}

beginWork(task, 'researcher');
await store.save(task);
const research = validateResearchResult(task, await modelCall('researcher', () => providers.research(task)));
completeWork(task, 'researcher', research);

beginWork(task, 'writer');
await store.save(task);
const generated = await modelCall('writer', () => providers.generate(task));
const artifact = createArtifact(task, generated, 'codex-cli');
completeWork(task, 'writer', { artifactId: artifact.id, version: artifact.version, title: artifact.title, claimCount: artifact.claims.length });

beginWork(task, 'reviewer');
transitionExecution(task, 'reviewing');
await store.save(task);
const reviewed = await modelCall('reviewer', () => providers.review(task, artifact));
const review = recordReview(task, artifact.id, reviewed);
completeWork(task, 'reviewer', { reviewId: review.id, passed: review.passed, summary: review.summary, sourceEvidenceCount: review.sourceEvidence.length });
assert.equal(review.passed, true, JSON.stringify(review.checks.filter((item) => !item.passed && item.blocking), null, 2));

transitionExecution(task, 'waiting_user');
const approval = confirmArtifact(task, artifact.id);
assertExportAllowed(task, artifact.id, approval.id);
const exported = serverTest.exportBody(task, artifact, 'md');
await fs.writeFile(path.join(evidenceRoot, 'confirmed-report.md'), exported.content, { flag: 'wx', mode: 0o600 });
await store.save(task);

const summary = {
  ok: true,
  provider: 'codex-cli',
  providerVersion: connection.message,
  goalVersionId: activeGoal(task).id,
  researchObservationCount: research.observations.length,
  researchMissingFacts: research.missingFacts,
  artifactId: artifact.id,
  artifactVersion: artifact.version,
  claimCount: artifact.claims.length,
  reviewId: review.id,
  reviewPassed: review.passed,
  sourceEvidenceCount: review.sourceEvidence.length,
  approvalId: approval.id,
  modelCallCount: task.execution.modelCalls.length,
  modelUsage: task.execution.modelCalls.map((call) => call.usage),
  confirmedReportSha256: crypto.createHash('sha256').update(exported.content).digest('hex'),
  taskSnapshot: path.relative(projectRoot, path.join(evidenceRoot, 'tasks', task.id, 'task.json')),
};
await fs.writeFile(path.join(evidenceRoot, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
