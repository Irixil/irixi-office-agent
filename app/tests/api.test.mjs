import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { start, __test as serverTest } from '../server.mjs';
import { createArtifact } from '../core.mjs';

const fixtureRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

async function post(url, pathname, body, origin) {
  const response = await fetch(`${url}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify(body),
  });
  const value = await response.json();
  return { response, value };
}

async function waitForTask(url, id) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const task = (await (await fetch(`${url}/api/tasks/${id}`)).json()).task;
    if (!['running', 'cancellation_unknown'].includes(task.status)) return task;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('任务没有在测试时间内结束');
}

async function waitFor(check, message = '等待条件超时') {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

function alignedPlan() {
  return {
    summary: '按项目根目标形成候选并独立审阅。', outputKind: 'document', deliverables: ['document'],
    projectAlignment: { status: 'aligned', explanation: '任务目标支持当前项目根目标。' },
    roles: [
      { key: 'author', name: '执行员', mission: '形成候选', capabilities: ['写作'], recruitmentReason: '完成任务成果。' },
      { key: 'auditor', name: '审阅员', mission: '独立核对', capabilities: ['审阅'], recruitmentReason: '守住确认边界。' },
      { key: 'courier', name: '交付员', mission: '等待确认', capabilities: ['交付'], recruitmentReason: '等待用户决定。' },
    ],
    steps: [
      { key: 'write', title: '形成候选', kind: 'synthesis', role: 'author', dependsOn: [], tools: [], webScope: { queries: [], urls: [] }, acceptanceCriteria: ['形成候选'], expectedResult: '候选文档' },
      { key: 'review', title: '独立审阅', kind: 'review', role: 'auditor', dependsOn: ['write'], tools: [], webScope: { queries: [], urls: [] }, acceptanceCriteria: ['独立审阅'], expectedResult: '审阅结论' },
      { key: 'deliver', title: '等待确认', kind: 'delivery', role: 'courier', dependsOn: ['review'], tools: [], webScope: { queries: [], urls: [] }, acceptanceCriteria: ['等待确认'], expectedResult: '待确认成果' },
    ],
  };
}

function delayedProviders() {
  const calls = [];
  return {
    calls,
    status: async () => ({ demo: { id: 'demo', available: true, verified: true }, codex: { id: 'codex-cli', available: true, verified: true } }),
    verifyCodex: async () => ({ ok: true }),
    async generate(task) {
      return { title: '已有候选', summary: '用于对话取消回归', content: `# ${task.goal.versions.at(-1).statement}\n\n这是一份已保存的演示候选正文，用于确认取消对话不会修改成果。`.repeat(3), sources: [], claims: [] };
    },
    async review() {
      return { summary: '通过', checks: [
        { name: '目标符合度', passed: true, evidence: '符合', blocking: true },
        { name: '完整性', passed: true, evidence: '完整', blocking: true },
        { name: '来源可追溯', passed: true, evidence: '无事实材料', blocking: true },
        { name: '边界遵守', passed: true, evidence: '无外部动作', blocking: true },
        { name: '文件可用性', passed: true, evidence: '已保存', blocking: true },
      ], claimChecks: [], provider: 'fake-review' };
    },
    converse(task, role, message, { signal }) {
      return new Promise((resolve, reject) => {
        const call = { task: structuredClone(task), role, message, resolve, reject, signal };
        calls.push(call);
        if (!message.includes('忽略取消')) signal.addEventListener('abort', () => {
          const error = new Error('本地模型进程已按取消请求终止。');
          error.code = 'cancelled';
          reject(error);
        }, { once: true });
      });
    },
  };
}

test('首次对话无execution也可独立取消，取消后可重试', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-conversation-cancel-first-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const providers = delayedProviders();
  const running = await start({ port: 0, root, providers });
  t.after(() => running.server.close());
  const created = await post(running.url, '/api/tasks', { goal: '首次对话取消', provider: 'demo' });
  const id = created.value.task.id;
  const first = post(running.url, `/api/tasks/${id}/conversation`, { role: 'researcher', message: '请回答这个问题' });
  const firstCall = await waitFor(() => providers.calls[0]);
  const cancelled = await post(running.url, `/api/tasks/${id}/conversation/cancel`, {});
  assert.equal(cancelled.response.status, 202);
  assert.equal(firstCall.signal.aborted, true);
  assert.notEqual((await first).response.status, 200);
  const afterCancel = (await (await fetch(`${running.url}/api/tasks/${id}`)).json()).task;
  assert.equal(afterCancel.execution, null);
  assert.equal(afterCancel.status, 'idle');
  assert.equal(afterCancel.events.filter((item) => item.type === 'conversation.reply').length, 0);
  assert.ok(afterCancel.events.some((item) => item.type === 'conversation.cancelled'));

  const retry = post(running.url, `/api/tasks/${id}/conversation`, { role: 'researcher', message: '再试一次' });
  const retryCall = await waitFor(() => providers.calls[1]);
  retryCall.resolve({ reply: '重试成功', kind: 'answer', sourceRefs: [] });
  assert.equal((await retry).response.status, 200);
});

test('真实规划显示运行态、阻止重复提交并可单独取消', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-planning-cancel-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let planSignal;
  const providers = {
    status: async () => ({ demo: { id: 'demo' }, codex: { id: 'codex-cli', available: true, verified: true } }),
    verifyCodex: async () => ({ ok: true }),
    plan(_task, { signal }) {
      planSignal = signal;
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
        const error = new Error('本地模型进程已按取消请求终止。'); error.code = 'cancelled'; reject(error);
      }, { once: true }));
    },
  };
  const running = await start({ port: 0, root, providers });
  t.after(() => running.server.close());
  const created = await post(running.url, '/api/tasks', { goal: '验证可取消的真实规划', provider: 'codex-cli' });
  const id = created.value.task.id;
  const planning = post(running.url, `/api/tasks/${id}/plan`, {});
  await waitFor(() => planSignal);
  const during = (await (await fetch(`${running.url}/api/tasks/${id}`)).json()).task;
  assert.deepEqual(during.runtime.activeJob, { kind: 'planning', role: 'coordinator' });
  const duplicate = await post(running.url, `/api/tasks/${id}/plan`, {});
  assert.equal(duplicate.response.status, 409);
  const cancelled = await post(running.url, `/api/tasks/${id}/cancel`, {});
  assert.equal(cancelled.response.status, 202);
  assert.equal(cancelled.value.kind, 'planning');
  assert.equal(planSignal.aborted, true);
  assert.notEqual((await planning).response.status, 200);
  const after = await waitFor(async () => {
    const task = (await (await fetch(`${running.url}/api/tasks/${id}`)).json()).task;
    return task.runtime.activeJob === null ? task : null;
  });
  assert.equal(after.status, 'idle');
  assert.equal(after.workItems.length, 0);
  assert.ok(after.events.some((entry) => entry.type === 'planning.cancelled'));
  assert.equal(after.events.some((entry) => entry.type === 'planning.failed'), false);
});

test('独立规划失败持久化可读事件且不改写旧执行截止时间', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-planning-failure-event-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let observedDeadline;
  const providers = {
    status: async () => ({ demo: { id: 'demo' }, codex: { id: 'codex-cli', available: true, verified: true } }),
    verifyCodex: async () => ({ ok: true }),
    async plan(task) { observedDeadline = task.execution?.deadlineAt; throw new Error('模拟独立规划失败'); },
  };
  const running = await start({ port: 0, root, providers });
  t.after(() => running.server.close());
  const created = await post(running.url, '/api/tasks', { goal: '验证规划失败记录', provider: 'codex-cli' });
  const id = created.value.task.id;
  const oldDeadline = new Date(Date.now() - 60_000).toISOString();
  await running.store.mutate(id, (task) => {
    task.execution = {
      id: 'run-old', goalVersionId: task.goal.activeVersionId, phase: 'completed', limits: {}, modelCalls: [], delegations: [], returnedResults: [], resultBatch: [],
      planRevisions: 0, startedAt: oldDeadline, deadlineAt: oldDeadline, updatedAt: oldDeadline, stopReason: null,
    };
  });
  const failed = await post(running.url, `/api/tasks/${id}/plan`, {});
  assert.equal(failed.response.status, 400);
  assert.equal(observedDeadline, oldDeadline);
  const restored = (await (await fetch(`${running.url}/api/tasks/${id}`)).json()).task;
  assert.equal(restored.execution.deadlineAt, oldDeadline);
  assert.match(restored.events.findLast((entry) => entry.type === 'planning.failed').message, /模拟独立规划失败/);
});

test('已有成果时取消对话不改执行与成果，且丢弃忽略abort的迟到回复', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-conversation-cancel-existing-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const providers = delayedProviders();
  const running = await start({ port: 0, root, providers });
  t.after(() => running.server.close());
  const created = await post(running.url, '/api/tasks', { goal: '保留已有成果', provider: 'demo' });
  const id = created.value.task.id;
  await post(running.url, `/api/tasks/${id}/plan`, {});
  await post(running.url, `/api/tasks/${id}/run`, {});
  const finished = await waitForTask(running.url, id);
  assert.equal(finished.artifacts.length, 1);
  const executionId = finished.execution.id;
  const artifactId = finished.artifacts[0].id;

  const conversation = post(running.url, `/api/tasks/${id}/conversation`, { role: 'researcher', message: '忽略取消后迟到返回' });
  const call = await waitFor(() => providers.calls[0]);
  const live = (await (await fetch(`${running.url}/api/tasks/${id}`)).json()).task;
  const listed = (await (await fetch(`${running.url}/api/tasks`)).json()).tasks.find((task) => task.id === id);
  assert.equal(live.status, 'waiting_user');
  assert.deepEqual(live.runtime.activeJob, { kind: 'conversation', role: 'researcher' });
  assert.deepEqual(listed.runtime.activeJob, { kind: 'conversation', role: 'researcher' });
  await post(running.url, `/api/tasks/${id}/conversation/cancel`, {});
  call.resolve({ reply: '这是迟到结果，不应保存', kind: 'answer', sourceRefs: [] });
  assert.notEqual((await conversation).response.status, 200);
  const restored = (await (await fetch(`${running.url}/api/tasks/${id}`)).json()).task;
  assert.equal(restored.execution.id, executionId);
  assert.equal(restored.artifacts[0].id, artifactId);
  assert.equal(restored.status, 'waiting_user');
  assert.equal(restored.runtime.activeJob, null);
  assert.equal(restored.events.filter((item) => item.type === 'conversation.reply').length, 0);
});

test('对话服务端串行排队且阻止并发运行，并持久化超过500字的完整回复', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-conversation-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const providers = delayedProviders();
  const running = await start({ port: 0, root, providers });
  t.after(() => running.server.close());
  const created = await post(running.url, '/api/tasks', { goal: '验证连续对话', provider: 'demo' });
  const id = created.value.task.id;

  const firstPromise = post(running.url, `/api/tasks/${id}/conversation`, { role: 'researcher', message: '请给出完整说明' });
  const firstCall = await waitFor(() => providers.calls[0]);
  const duplicate = await post(running.url, `/api/tasks/${id}/conversation`, { role: 'researcher', message: '重复提交' });
  assert.equal(duplicate.response.status, 202);
  assert.equal(duplicate.value.queued, true);
  const concurrentRun = await post(running.url, `/api/tasks/${id}/run`, {});
  assert.equal(concurrentRun.response.status, 409);
  const providerChange = await post(running.url, `/api/tasks/${id}/provider`, { provider: 'codex-cli' });
  assert.equal(providerChange.response.status, 409);

  const fullReply = `${'长回复正文'.repeat(130)}尾部标记`;
  firstCall.resolve({ reply: fullReply, kind: 'answer', sourceRefs: [] });
  const first = await firstPromise;
  assert.equal(first.response.status, 200);
  const queuedCall = await waitFor(() => providers.calls[1]);
  queuedCall.resolve({ reply: '排队消息的真实模型回复', kind: 'answer', sourceRefs: [] });
  await waitFor(async () => {
    const task = (await (await fetch(`${running.url}/api/tasks/${id}`)).json()).task;
    return task.events.some((item) => item.type === 'conversation.reply' && item.detail?.queueId);
  });
  const restored = (await (await fetch(`${running.url}/api/tasks/${id}`)).json()).task;
  const replyEvent = restored.events.find((item) => item.type === 'conversation.reply' && !item.detail?.queueId);
  assert.equal(replyEvent.message.length, 500);
  assert.equal(replyEvent.detail.content, fullReply);
  assert.match(replyEvent.detail.content, /尾部标记$/);
  assert.equal(restored.conversationQueue[0].status, 'completed');
  assert.equal(restored.conversationQueue[0].reply, '排队消息的真实模型回复');
});

test('动态工作安全点开始排队回复，单独取消回复后丢弃迟到结果且主任务继续', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-conversation-safe-point-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let releaseSynthesis;
  let synthesisStarted;
  const synthesisGate = new Promise((resolve) => { releaseSynthesis = resolve; });
  const synthesisSeen = new Promise((resolve) => { synthesisStarted = resolve; });
  const conversationCalls = [];
  const plan = {
    summary: '形成研究简报并独立审阅。', outputKind: 'research', deliverables: ['research'],
    roles: [
      { key: 'author', name: '简报编辑', mission: '形成简报', capabilities: ['写作'], recruitmentReason: '需要候选成果。' },
      { key: 'auditor', name: '独立审阅员', mission: '检查简报', capabilities: ['审阅'], recruitmentReason: '确认前需独立检查。' },
      { key: 'courier', name: '交付事务员', mission: '等待确认', capabilities: ['交付'], recruitmentReason: '守住确认边界。' },
    ],
    steps: [
      { key: 'synthesize', title: '形成研究简报', kind: 'synthesis', role: 'author', dependsOn: [], tools: [], acceptanceCriteria: ['形成简报'], expectedResult: '研究简报' },
      { key: 'review', title: '独立审阅', kind: 'review', role: 'auditor', dependsOn: ['synthesize'], tools: [], acceptanceCriteria: ['独立检查'], expectedResult: '审阅结论' },
      { key: 'deliver', title: '等待确认', kind: 'delivery', role: 'courier', dependsOn: ['review'], tools: [], acceptanceCriteria: ['等待用户确认'], expectedResult: '待确认交付' },
    ],
  };
  const finish = (item, output, deliverables = []) => ({ summary: `${item.title}完成`, output, sources: [], claims: [], gap: '', caveats: [], toolRequests: [], deliverables, acceptanceChecks: item.acceptanceCriteria.map((criterion) => ({ criterion, passed: true, evidence: '有可检查结果' })) });
  const providers = {
    status: async () => ({ demo: { id: 'demo' }, codex: { id: 'codex-cli', available: true, verified: true } }),
    verifyCodex: async () => ({ ok: true }),
    plan: async () => structuredClone(plan),
    replan: async () => structuredClone(plan),
    async executeWork(_task, item) {
      if (item.kind === 'synthesis') {
        synthesisStarted();
        await synthesisGate;
        return finish(item, '# 安全点简报\n\n主任务应在取消对话后继续。', [{ kind: 'research', title: '安全点简报', content: '# 安全点简报\n\n主任务应在取消对话后继续。' }]);
      }
      return finish(item, '独立检查完成。');
    },
    async review() {
      return { summary: '独立审阅通过', checks: [
        { name: '目标符合度', passed: true, evidence: '符合', blocking: true },
        { name: '完整性', passed: true, evidence: '完整', blocking: true },
        { name: '来源核对', passed: true, evidence: '无外部事实', blocking: true },
        { name: '边界遵守', passed: true, evidence: '未外部操作', blocking: true },
        { name: '文件可用性', passed: true, evidence: '研究简报可审阅', blocking: true },
      ], claimChecks: [], provider: 'fake-review' };
    },
    converse(_task, role, message, { signal }) {
      return new Promise((resolve) => conversationCalls.push({ role, message, signal, resolve }));
    },
  };
  const running = await start({ port: 0, root, providers });
  t.after(() => running.server.close());
  const created = await post(running.url, '/api/tasks', { goal: '形成可审阅研究简报', provider: 'codex-cli', type: 'research' });
  const id = created.value.task.id;
  await post(running.url, `/api/tasks/${id}/plan`, {});
  await post(running.url, `/api/tasks/${id}/run`, {});
  await synthesisSeen;
  const queued = await post(running.url, `/api/tasks/${id}/conversation`, { role: 'author', message: '运行中补充说明' });
  assert.equal(queued.response.status, 202);
  assert.equal(queued.value.queued, true);
  releaseSynthesis();
  const replyCall = await waitFor(() => conversationCalls[0], '排队回复未在安全点开始');
  const cancelled = await post(running.url, `/api/tasks/${id}/conversation/cancel`, {});
  assert.equal(cancelled.response.status, 202);
  assert.equal(replyCall.signal.aborted, true);
  replyCall.resolve({ reply: '迟到回复不应写入', kind: 'answer', sourceRefs: [] });

  const finished = await waitForTask(running.url, id);
  assert.equal(finished.status, 'waiting_user');
  assert.equal(finished.reviews.at(-1).passed, true);
  assert.equal(finished.conversationQueue[0].status, 'cancelled');
  assert.equal(finished.events.some((item) => item.type === 'conversation.reply' && item.detail?.queueId), false);
  assert.ok(finished.events.some((item) => item.type === 'conversation.cancelled' && item.detail?.queueId));
});

test('应用重启会把中断的排队回复恢复为待回复并重新处理', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-conversation-recovery-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const providers = delayedProviders();
  let running = await start({ port: 0, root, providers });
  t.after(() => running.server.close());
  const created = await post(running.url, '/api/tasks', { goal: '恢复中断的排队回复', provider: 'demo' });
  const id = created.value.task.id;
  await running.store.mutate(id, (task) => {
    const goalVersionId = task.goal.versions.at(-1).id;
    task.conversationQueue.push({
      id: 'conversation-restart-test', role: 'researcher', agentId: null, workItemId: null,
      message: '请在重启后回复', goalVersionId, provider: task.provider, requestEventId: null,
      status: 'running', createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), completedAt: null, reply: null, error: null,
    });
  });
  await new Promise((resolve) => running.server.close(resolve));
  running = await start({ port: 0, root, providers });
  const replyCall = await waitFor(() => providers.calls[0], '重启后未恢复排队回复');
  replyCall.resolve({ reply: '重启恢复成功', kind: 'answer', sourceRefs: [] });
  const restored = await waitFor(async () => {
    const task = (await (await fetch(`${running.url}/api/tasks/${id}`)).json()).task;
    return task.conversationQueue[0].status === 'completed' ? task : null;
  }, '恢复后的排队回复未完成');
  assert.equal(restored.conversationQueue[0].reply, '重启恢复成功');
  assert.ok(restored.events.some((item) => item.type === 'conversation.recovered'));
  assert.ok(restored.events.some((item) => item.type === 'conversation.reply' && item.detail?.queueId === 'conversation-restart-test'));
});

test('换目标会取消在途对话且不写入旧回复', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-conversation-stale-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const providers = delayedProviders();
  const running = await start({ port: 0, root, providers });
  t.after(() => running.server.close());
  const created = await post(running.url, '/api/tasks', { goal: '旧目标', provider: 'demo' });
  const id = created.value.task.id;
  const replacement = await post(running.url, `/api/tasks/${id}/suggestions`, { text: '最终目标改成新目标' });

  const conversation = post(running.url, `/api/tasks/${id}/conversation`, { role: 'researcher', message: '这是旧目标下的问题' });
  await waitFor(() => providers.calls[0]);
  const accepted = await post(running.url, `/api/tasks/${id}/suggestions/${replacement.value.suggestion.id}/accept-goal`, {
    statement: '新目标', successCriteria: ['形成可核对的新目标成果'], boundaries: ['不发送或发布'],
  });
  assert.equal(accepted.response.status, 200);
  const response = await conversation;
  assert.notEqual(response.response.status, 200);
  const restored = (await (await fetch(`${running.url}/api/tasks/${id}`)).json()).task;
  assert.equal(restored.goal.versions.at(-1).statement, '新目标');
  assert.equal(restored.events.filter((item) => item.type === 'conversation.reply').length, 0);
  assert.ok(restored.events.some((item) => item.type === 'conversation.stale'));
});

test('本地 API 完成目标到确认与导出的闭环，并在重启后恢复', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-api-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let running = await start({ port: 0, root });
  t.after(() => running.server.close());

  const created = await post(running.url, '/api/tasks', {
    title: '周报', goal: '形成可审阅的本周项目周报', type: 'document',
    successCriteria: ['包含进展与下一步'], boundaries: ['不编造数字'], provider: 'demo',
  });
  assert.equal(created.response.status, 201);
  const id = created.value.task.id;

  const material = await post(running.url, `/api/tasks/${id}/materials/text`, { name: '本周记录', text: '项目完成了需求核对，下一步准备用户试用。' });
  assert.equal(material.response.status, 201);
  const planned = await post(running.url, `/api/tasks/${id}/plan`, {});
  assert.equal(planned.value.task.workItems.length, 3);
  assert.equal(planned.value.task.workItems.some((item) => item.role === 'researcher'), false);
  const accepted = await post(running.url, `/api/tasks/${id}/run`, {});
  assert.equal(accepted.response.status, 202);

  const finished = await waitForTask(running.url, id);
  assert.equal(finished.status, 'waiting_user');
  assert.equal(finished.artifacts.length, 1);
  assert.equal(finished.artifacts[0].provider, 'demo');
  assert.equal(finished.reviews[0].passed, true);
  assert.equal(finished.approvals.length, 0);

  const artifact = finished.artifacts[0];
  const confirmed = await post(running.url, `/api/tasks/${id}/artifacts/${artifact.id}/confirm`, {});
  assert.equal(confirmed.value.task.status, 'ready_to_export');
  const deniedExport = await fetch(`${running.url}/api/tasks/${id}/artifacts/${artifact.id}/export?format=md`);
  assert.equal(deniedExport.status, 400);
  const exported = await fetch(`${running.url}/api/tasks/${id}/artifacts/${artifact.id}/export?approval=${confirmed.value.approval.id}&format=md`);
  assert.equal(exported.status, 200);
  assert.match(await exported.text(), /形成可审阅的本周项目周报/);

  const revised = await post(running.url, `/api/tasks/${id}/artifacts/${artifact.id}/revise`, { content: `${artifact.content}\n\n第二版候选。` });
  assert.equal(revised.value.artifact.version, 2);
  assert.equal(revised.value.artifact.status, 'candidate');
  assert.equal(revised.value.task.approvals.length, 1);
  const wrongVersionExport = await fetch(`${running.url}/api/tasks/${id}/artifacts/${revised.value.artifact.id}/export?approval=${confirmed.value.approval.id}&format=md`);
  assert.equal(wrongVersionExport.status, 400);

  await new Promise((resolve) => running.server.close(resolve));
  running = await start({ port: 0, root });
  const restored = await (await fetch(`${running.url}/api/tasks/${id}`)).json();
  assert.equal(restored.task.status, 'ready_to_export');
  assert.equal(restored.task.artifacts[0].status, 'confirmed');
});

test('修改接口拒绝非本机网页来源，网址导入拒绝本机地址', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-policy-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const running = await start({ port: 0, root });
  t.after(() => running.server.close());

  const rejected = await post(running.url, '/api/tasks', { goal: '不应建立' }, 'https://hostile.example');
  assert.equal(rejected.response.status, 403);

  const created = await post(running.url, '/api/tasks', { goal: '测试网址策略' });
  const id = created.value.task.id;
  const local = await post(running.url, `/api/tasks/${id}/materials/url`, { url: 'http://127.0.0.1/private' });
  assert.equal(local.response.status, 422);
  assert.match(local.value.error.message, /拒绝|不能读取/);
  assert.equal(local.value.task.materials[0].status, 'failed');
});

test('网址材料导入复用受控公开页面读取器并保存最终地址与正文', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-url-material-reader-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls = [];
  const running = await start({
    port: 0, root,
    publicPageReader: async (url, options) => {
      calls.push({ url, options });
      return { finalUrl: 'https://docs.example.test/final', text: '第一行\n第二行', bytes: 19 };
    },
  });
  t.after(() => running.server.close());
  const created = await post(running.url, '/api/tasks', { goal: '读取一个明确公开网址' });
  const result = await post(running.url, `/api/tasks/${created.value.task.id}/materials/url`, { url: 'https://docs.example.test/start', name: '公开说明' });
  assert.equal(result.response.status, 201);
  assert.deepEqual(calls, [{ url: 'https://docs.example.test/start', options: { maxBytes: 1_500_000, timeoutMs: 15_000 } }]);
  assert.equal(result.value.material.source, 'https://docs.example.test/final');
  assert.equal(result.value.material.text, '第一行\n第二行');
  assert.equal(result.value.material.bytes, 19);
});

test('TXT、Markdown、DOCX 和可检索 PDF 均可读取，损坏 PDF 明确失败', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-files-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const running = await start({ port: 0, root });
  t.after(() => running.server.close());
  const created = await post(running.url, '/api/tasks', { goal: '核对多格式材料导入' });
  const id = created.value.task.id;

  for (const name of ['sample.txt', 'sample.md', 'irixi-sample.docx', 'irixi-sample.pdf']) {
    const content = await fs.readFile(path.join(fixtureRoot, name));
    const uploaded = await post(running.url, `/api/tasks/${id}/materials/file`, { name, base64: content.toString('base64') });
    assert.equal(uploaded.response.status, 201, `${name}: ${uploaded.value?.error?.message || ''}`);
    assert.equal(uploaded.value.material.status, 'ready');
    assert.match(uploaded.value.material.text, /Irixi|材料/);
  }

  const damaged = await post(running.url, `/api/tasks/${id}/materials/file`, { name: 'damaged.pdf', base64: Buffer.from('not a pdf').toString('base64') });
  assert.equal(damaged.response.status, 422);
  assert.equal(damaged.value.task.materials.at(-1).status, 'failed');
  assert.match(damaged.value.error.message, /无法可靠提取/);
});

test('取消会持久化，随后可安全重新运行且不会产生导出副作用', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-cancel-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const running = await start({ port: 0, root });
  t.after(() => running.server.close());
  const created = await post(running.url, '/api/tasks', { goal: '验证取消与继续', provider: 'demo' });
  const id = created.value.task.id;
  await post(running.url, `/api/tasks/${id}/plan`, {});
  const oldWorkIds = (await (await fetch(`${running.url}/api/tasks/${id}`)).json()).task.workItems.map((item) => item.id);
  const cancelled = await post(running.url, `/api/tasks/${id}/cancel`, {});
  assert.equal(cancelled.value.task.status, 'cancelled');
  assert.equal(cancelled.value.task.approvals.length, 0);

  const resumed = await post(running.url, `/api/tasks/${id}/run`, {});
  assert.equal(resumed.response.status, 202);
  const finished = await waitForTask(running.url, id);
  assert.equal(finished.status, 'waiting_user');
  assert.equal(finished.approvals.length, 0);
  assert.notDeepEqual(finished.workItems.map((item) => item.id), oldWorkIds);
  assert.ok(finished.workHistory.some((entry) => entry.reason === 'plan_rebuilt'));
});

test('三份供应商资料形成真实研究产物、通过原文审阅并在确认后导出', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-suppliers-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const running = await start({ port: 0, root });
  t.after(() => running.server.close());
  const created = await post(running.url, '/api/tasks', {
    title: '供应商比较', goal: '比较三家供应商的价格、交付周期和售后并给出建议', type: 'research', provider: 'demo',
    successCriteria: ['标出价格、交付周期和售后', '缺少信息明确待确认'], boundaries: ['不联系供应商'],
  });
  const id = created.value.task.id;
  for (const [name, text] of [
    ['青松供应商', '青松：含税价格 1200元，交付 7天，售后 12个月。'],
    ['白鹭供应商', '白鹭：含税价格 1350元，交付 5天，售后 18个月。'],
    ['云杉供应商', '云杉：含税价格 1180元，交付周期待确认，售后 12个月。'],
  ]) await post(running.url, `/api/tasks/${id}/materials/text`, { name, text });
  const planned = await post(running.url, `/api/tasks/${id}/plan`, {});
  assert.deepEqual(planned.value.task.workItems.map((item) => item.role), ['researcher', 'writer', 'reviewer', 'steward']);
  await post(running.url, `/api/tasks/${id}/run`, {});
  const finished = await waitForTask(running.url, id);
  assert.equal(finished.status, 'waiting_user');
  const research = finished.workItems.find((item) => item.role === 'researcher');
  assert.equal(research.status, 'completed');
  assert.equal(research.result.observations.length, 3);
  assert.equal(finished.artifacts[0].claims.length, 3);
  assert.equal(finished.reviews[0].sourceEvidence.length, 3);

  const artifact = finished.artifacts[0];
  const confirmed = await post(running.url, `/api/tasks/${id}/artifacts/${artifact.id}/confirm`, {});
  const exported = await fetch(`${running.url}/api/tasks/${id}/artifacts/${artifact.id}/export?approval=${confirmed.value.approval.id}&format=md`);
  assert.equal(exported.status, 200);
  assert.match(await exported.text(), /供应商/);
});

test('运行中的模型进程取消后确认终止，重启不会复活旧工作', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-active-cancel-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let mode = 'block';
  const checks = [
    { name: '目标符合度', passed: true, evidence: '符合', blocking: true },
    { name: '完整性', passed: true, evidence: '完整', blocking: true },
    { name: '来源核对', passed: true, evidence: '无事实材料', blocking: true },
    { name: '边界遵守', passed: true, evidence: '未执行外部操作', blocking: true },
    { name: '文件可用性', passed: true, evidence: '可用', blocking: true },
  ];
  const providers = {
    async status() { return { demo: { id: 'demo' }, codex: { id: 'codex-cli', available: true, verified: true } }; },
    async verifyCodex() { return { ok: true, message: 'test provider' }; },
    async generate(task, { signal } = {}) {
      if (mode === 'success') return { title: '恢复后的候选', summary: '成功', content: `# ${task.goal.versions.at(-1).statement}\n\n恢复后重新生成的候选正文，未复用取消运行的结果。`, sources: [], claims: [] };
      return new Promise((resolve, reject) => {
        const stop = () => { const error = new Error('合成模型已终止'); error.code = 'cancelled'; reject(error); };
        if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true });
      });
    },
    async review() { return { summary: '通过', checks, provider: 'test-independent-review' }; },
  };
  const running = await start({ port: 0, root, providers });
  t.after(() => running.server.close());
  const created = await post(running.url, '/api/tasks', { goal: '验证活动运行取消', provider: 'codex-cli' });
  const id = created.value.task.id;
  await post(running.url, `/api/tasks/${id}/plan`, {});
  await post(running.url, `/api/tasks/${id}/run`, {});
  const beforeCancel = (await (await fetch(`${running.url}/api/tasks/${id}`)).json()).task;
  const oldWorkIds = beforeCancel.workItems.map((item) => item.id);
  const requested = await post(running.url, `/api/tasks/${id}/cancel`, {});
  assert.equal(requested.value.task.status, 'cancellation_unknown');
  const cancelled = await waitForTask(running.url, id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.execution.stopReason, 'local_process_terminated');
  assert.equal(cancelled.artifacts.length, 0);

  mode = 'success';
  await post(running.url, `/api/tasks/${id}/run`, {});
  const finished = await waitForTask(running.url, id);
  assert.equal(finished.status, 'waiting_user');
  assert.notDeepEqual(finished.workItems.map((item) => item.id), oldWorkIds);
  assert.equal(finished.artifacts.length, 1);
});

test('办公室场景只读投影真实任务，并持久化一件家具的合法位置', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-office-scene-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let running = await start({ port: 0, root });
  t.after(() => running.server.close());

  const created = await post(running.url, '/api/tasks', { goal: '制作一份可审阅的虚构办公室周报', provider: 'demo' });
  const id = created.value.task.id;
  let scene = await (await fetch(`${running.url}/api/office-scene?taskId=${id}`)).json();
  assert.equal(scene.connected, true);
  assert.equal(scene.task.taskId, id);
  assert.equal(scene.task.state, 'idle');
  assert.equal(scene.task.demo, true);
  assert.equal(scene.task.goalVersion, created.value.task.goal.activeVersionId);

  await running.store.mutate(id, (task) => {
    task.status = 'running';
    task.activeRole = 'researcher';
    task.events.push({ id: 'event-scene-test', at: new Date().toISOString(), type: 'task.state', message: '研究角色正在核对虚构材料。', detail: {} });
  });
  scene = await (await fetch(`${running.url}/api/office-scene?taskId=${id}`)).json();
  assert.equal(scene.task.state, 'researching');
  assert.match(scene.task.activity, /核对虚构材料/);

  for (const [status, role, expected] of [
    ['running', 'archivist', 'reading'],
    ['running', 'writer', 'drafting'],
    ['running', 'reviewer', 'reviewing'],
    ['waiting_user', 'steward', 'waiting_user'],
    ['ready_to_export', 'steward', 'completed'],
    ['failed', 'writer', 'failed'],
  ]) {
    await running.store.mutate(id, (task) => { task.status = status; task.activeRole = role; });
    scene = await (await fetch(`${running.url}/api/office-scene?taskId=${id}`)).json();
    assert.equal(scene.task.state, expected);
  }

  const invalid = await fetch(`${running.url}/api/office-layout`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ furnitureId: 'desk', x: 0.05, y: 0.7 }),
  });
  assert.equal(invalid.status, 400);

  const hostile = await fetch(`${running.url}/api/office-layout`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: 'https://hostile.example' }, body: JSON.stringify({ furnitureId: 'desk', x: 0.4, y: 0.7 }),
  });
  assert.equal(hostile.status, 403);

  const savedResponse = await fetch(`${running.url}/api/office-layout`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ furnitureId: 'desk', x: 0.4, y: 0.7 }),
  });
  assert.equal(savedResponse.status, 200);
  const saved = (await savedResponse.json()).layout;
  assert.deepEqual(saved.furniture.desk, { x: 0.4, y: 0.7 });

  await new Promise((resolve) => running.server.close(resolve));
  running = await start({ port: 0, root });
  const restored = (await (await fetch(`${running.url}/api/office-layout`)).json()).layout;
  assert.deepEqual(restored.furniture.desk, { x: 0.4, y: 0.7 });

  const resetResponse = await fetch(`${running.url}/api/office-layout`, { method: 'DELETE' });
  assert.equal(resetResponse.status, 200);
  const reset = (await resetResponse.json()).layout;
  assert.deepEqual(reset.furniture.desk, { x: 0.5, y: 0.72 });
});

test('办公场景沿同一任务账本投影候选成果记录', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-office-result-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const running = await start({ port: 0, root });
  t.after(() => running.server.close());

  const created = await post(running.url, '/api/tasks', {
    title: '虚构办公室周报', goal: '制作一份可审阅的虚构办公室周报', provider: 'demo', type: 'document',
  });
  const id = created.value.task.id;
  assert.equal((await post(running.url, `/api/tasks/${id}/plan`, {})).response.status, 200);
  assert.equal((await post(running.url, `/api/tasks/${id}/run`, {})).response.status, 202);

  const finished = await waitForTask(running.url, id);
  assert.equal(finished.status, 'waiting_user');
  assert.equal(finished.artifacts.length, 1);
  assert.equal(finished.reviews.length, 1);

  const scene = await (await fetch(`${running.url}/api/office-scene?taskId=${id}`)).json();
  assert.equal(scene.task.state, 'waiting_user');
  assert.deepEqual(scene.task.result, {
    artifactId: finished.artifacts[0].id,
    logicalId: finished.artifacts[0].logicalId,
    version: finished.artifacts[0].version,
    title: finished.artifacts[0].title,
    summary: finished.artifacts[0].summary,
    goalStatement: '制作一份可审阅的虚构办公室周报',
    materialIds: [],
    process: { taskStatus: 'waiting_user', executionPhase: 'waiting_user', activeRole: 'steward' },
    status: 'candidate',
    reviewStatus: 'passed',
    reviewId: finished.reviews[0].id,
    reviewPassed: true,
    goalVersionId: finished.artifacts[0].goalVersionId,
    workResultIds: finished.artifacts[0].workResultIds,
    instructionIds: finished.artifacts[0].instructionIds,
    createdAt: finished.artifacts[0].createdAt,
  });

  const confirmed = await post(running.url, `/api/tasks/${id}/artifacts/${finished.artifacts[0].id}/confirm`, {});
  assert.equal(confirmed.value.task.status, 'ready_to_export');
  const confirmedScene = await (await fetch(`${running.url}/api/office-scene?taskId=${id}`)).json();
  assert.equal(confirmedScene.task.state, 'completed');
  assert.equal(confirmedScene.task.result.status, 'confirmed');
  assert.equal(confirmedScene.task.result.artifactId, finished.artifacts[0].id);
});

test('用户可明确拒绝候选成果且不产生批准或覆盖', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-artifact-reject-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const running = await start({ port: 0, root });
  t.after(() => running.server.close());

  const created = await post(running.url, '/api/tasks', { goal: '制作一份可审阅的虚构拒绝测试', provider: 'demo' });
  const id = created.value.task.id;
  await post(running.url, `/api/tasks/${id}/plan`, {});
  await post(running.url, `/api/tasks/${id}/run`, {});
  const finished = await waitForTask(running.url, id);
  const artifact = finished.artifacts[0];
  const rejected = await post(running.url, `/api/tasks/${id}/artifacts/${artifact.id}/reject`, { reason: '事实仍需补充。' });
  assert.equal(rejected.response.status, 200);
  assert.equal(rejected.value.artifact.status, 'rejected');
  assert.equal(rejected.value.artifact.rejection.reason, '事实仍需补充。');
  assert.equal(rejected.value.task.approvals.length, 0);
  assert.equal(rejected.value.task.status, 'waiting_user');
  assert.match(rejected.value.task.events.at(-1).message, /拒绝应用/);
});

test('真实计划按依赖并行执行独立会话，受控计算后独立复核并等待确认', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-dynamic-team-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let inFlight = 0;
  let maxInFlight = 0;
  const calls = [];
  const dynamicPlan = {
    summary: '核对报价后并行计算价格和条件，再合成两种成果并独立复核。', outputKind: 'document', deliverables: ['document', 'spreadsheet'],
    roles: [
      { key: 'analyst', name: '采购分析员', mission: '核对报价', capabilities: ['材料核对', '计算'], recruitmentReason: '目标含报价与条件判断。' },
      { key: 'author', name: '成果编辑', mission: '形成成果', capabilities: ['文档', '表格'], recruitmentReason: '目标要求两种格式。' },
      { key: 'auditor', name: '独立审阅员', mission: '重新计算并审阅', capabilities: ['独立审阅'], recruitmentReason: '确认前需要独立复核。' },
      { key: 'courier', name: '交付事务员', mission: '确认后导出', capabilities: ['版本交付'], recruitmentReason: '守住确认边界。' },
    ],
    steps: [
      { key: 'extract', title: '提取报价', kind: 'research', role: 'analyst', dependsOn: [], tools: ['materials.read'], acceptanceCriteria: ['记录报价原文'], expectedResult: '带来源报价' },
      { key: 'cost', title: '计算总价', kind: 'analysis', role: 'analyst', dependsOn: ['extract'], tools: ['calculate'], acceptanceCriteria: ['确定性计算总价'], expectedResult: '总价' },
      { key: 'terms', title: '核对交期', kind: 'analysis', role: 'analyst', dependsOn: ['extract'], tools: [], acceptanceCriteria: ['核对交期'], expectedResult: '交期结论' },
      { key: 'synthesize', title: '形成文档与表格', kind: 'synthesis', role: 'author', dependsOn: ['cost', 'terms'], tools: [], acceptanceCriteria: ['同时形成说明文档和电子表格'], expectedResult: '两种候选成果' },
      { key: 'review', title: '独立复核', kind: 'review', role: 'auditor', dependsOn: ['synthesize'], tools: ['calculate'], acceptanceCriteria: ['独立重算总价'], expectedResult: '审阅结论' },
      { key: 'deliver', title: '等待确认', kind: 'delivery', role: 'courier', dependsOn: ['review'], tools: [], acceptanceCriteria: ['只交付确认版本'], expectedResult: '待确认交付' },
    ],
  };
  const checks = [
    { name: '目标符合度', passed: true, evidence: '候选完成目标', blocking: true },
    { name: '完整性', passed: true, evidence: '文档与表格齐全', blocking: true },
    { name: '来源核对', passed: true, evidence: '原文与计算记录齐全', blocking: true },
    { name: '边界遵守', passed: true, evidence: '没有外部操作', blocking: true },
    { name: '文件可用性', passed: true, evidence: '候选记录可导出', blocking: true },
  ];
  const providers = {
    status: async () => ({ demo: { id: 'demo' }, codex: { id: 'codex-cli', available: true, verified: true } }),
    verifyCodex: async () => ({ ok: true }),
    plan: async () => structuredClone(dynamicPlan),
    replan: async () => structuredClone(dynamicPlan),
    async executeWork(task, item, input) {
      inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight); calls.push({ step: item.stepKey, sessionInput: structuredClone(input) });
      await new Promise((resolve) => setTimeout(resolve, ['cost', 'terms'].includes(item.stepKey) ? 18 : 2));
      inFlight -= 1;
      const material = input.materialDirectory[0];
      const toolResults = input.toolResults || [];
      const finish = (output, deliverables = []) => ({ summary: `${item.title}完成`, output, sources: [`material:${material?.id || 'none'}#L1-L1`], claims: [], gap: '', toolRequests: [], deliverables, acceptanceChecks: item.acceptanceCriteria.map((criterion) => ({ criterion, passed: true, evidence: `${item.stepKey} 有可检查结果` })) });
      if (item.stepKey === 'extract' && !toolResults.length) return { summary: '', output: '', sources: [], claims: [], gap: '', acceptanceChecks: [], deliverables: [], toolRequests: [{ id: 'read-quote', tool: 'materials.read', args: { materialIds: [material.id] }, reason: '读取报价' }] };
      if (item.stepKey === 'cost' && !toolResults.length) return { summary: '', output: '', sources: [], claims: [], gap: '', acceptanceChecks: [], deliverables: [], toolRequests: [{ id: 'calc-total', tool: 'calculate', args: { expression: 'price*quantity+freight', inputs: [
        { name: 'price', value: 3600, sourceRef: `material:${material.id}#L1-L1` }, { name: 'quantity', value: 5, sourceRef: `material:${material.id}#L1-L1` }, { name: 'freight', value: 400, sourceRef: `material:${material.id}#L1-L1` },
      ] }, reason: '计算总价' }] };
      if (item.stepKey === 'review' && !toolResults.length) return { summary: '', output: '', sources: [], claims: [], gap: '', acceptanceChecks: [], deliverables: [], toolRequests: [{ id: 'review-calc', tool: 'calculate', args: { expression: 'price*quantity+freight', inputs: [
        { name: 'price', value: 3600, sourceRef: `material:${material.id}#L1-L1` }, { name: 'quantity', value: 5, sourceRef: `material:${material.id}#L1-L1` }, { name: 'freight', value: 400, sourceRef: `material:${material.id}#L1-L1` },
      ] }, reason: '独立重算' }] };
      if (item.stepKey === 'synthesize') return { ...finish('报价原文为单价 3600 元，数量 5，运费 400 元。确定性总价为 18400 元。', [
        { kind: 'document', title: '采购建议', content: '# 采购建议\n\n确定性总价为 18400 元。' },
        { kind: 'spreadsheet', title: '报价计算', content: '项目,数值\n总价,18400' },
      ]), claims: [{ statement: '报价原文为单价 3600 元，数量 5，运费 400 元。', materialId: material.id, sourceName: material.name, locator: 'L1-L1', quote: '单价 3600 元，数量 5，运费 400 元，交期 10 天。' }] };
      return finish(item.stepKey === 'cost' ? '确定性总价 18400 元' : item.stepKey === 'terms' ? '交期 10 天' : '独立重算总价 18400 元');
    },
    async review(_task, artifact) {
      return { summary: '独立复核通过', checks, claimChecks: artifact.claims.map((claim, claimIndex) => ({ claimIndex, materialId: claim.materialId, locator: claim.locator, verdict: 'supported', evidence: '逐字原文支持该陈述' })), provider: 'fake-independent-review' };
    },
    async converse() { return { reply: '动态角色回复', kind: 'answer', sourceRefs: [] }; },
  };
  const running = await start({ port: 0, root, providers });
  t.after(() => running.server.close());
  const created = await post(running.url, '/api/tasks', { goal: '比较报价并形成说明文档与电子表格', provider: 'codex-cli', memoryPolicy: 'task-only' });
  const id = created.value.task.id;
  await post(running.url, `/api/tasks/${id}/materials/text`, { name: '报价', text: '单价 3600 元，数量 5，运费 400 元，交期 10 天。' });
  const planned = await post(running.url, `/api/tasks/${id}/plan`, {});
  assert.equal(planned.response.status, 200);
  assert.equal(planned.value.task.team.agents.length, 4);
  await post(running.url, `/api/tasks/${id}/run`, {});
  const finished = await waitForTask(running.url, id);
  assert.equal(finished.status, 'waiting_user');
  assert.equal(finished.artifacts[0].deliverables.length, 2);
  assert.equal(finished.artifacts[0].nativeFiles.length, 2);
  assert.equal(finished.artifacts[0].nativeFiles.every((file) => file.status === 'ready' && file.previewPaths.length >= 1), true);
  assert.equal(finished.artifacts[0].nativeFiles.find((file) => file.kind === 'spreadsheet').validation.sheetCount, 1);
  assert.equal(finished.artifacts[0].derivations.some((entry) => entry.result.result === 18400), true);
  assert.equal(finished.reviews[0].passed, true);
  assert.equal(maxInFlight, 2);
  assert.equal(new Set(finished.agentSessions.filter((session) => session.status === 'completed').map((session) => session.id)).size >= 4, true);
  assert.ok(calls.find((call) => call.step === 'review' && call.sessionInput.toolResults.some((entry) => entry.result?.result === 18400)));
  const preview = await fetch(`${running.url}/api/tasks/${id}/artifacts/${finished.artifacts[0].id}/previews/0`);
  assert.equal(preview.status, 200);
  const deniedNative = await fetch(`${running.url}/api/tasks/${id}/artifacts/${finished.artifacts[0].id}/export?format=xlsx`);
  assert.equal(deniedNative.status, 400);
  const unsafeRevision = await post(running.url, `/api/tasks/${id}/artifacts/${finished.artifacts[0].id}/revise`, { content: '不应覆盖多交付物' });
  assert.equal(unsafeRevision.response.status, 400);
  assert.match(unsafeRevision.value.error.message, /多份交付物/);
  const confirmed = await post(running.url, `/api/tasks/${id}/artifacts/${finished.artifacts[0].id}/confirm`, {});
  const exported = await fetch(`${running.url}/api/tasks/${id}/artifacts/${finished.artifacts[0].id}/export?approval=${confirmed.value.approval.id}&format=xlsx`);
  assert.equal(exported.status, 200);
  const bytes = Buffer.from(await exported.arrayBuffer());
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), finished.artifacts[0].nativeFiles.find((file) => file.kind === 'spreadsheet').sha256);
});

test('普通工作项的错位引用在同一会话修正，不污染依赖或触发重规划', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-claim-repair-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const plan = {
    summary: '形成可追溯研究候选并独立审阅。', outputKind: 'research', deliverables: ['research'],
    roles: [
      { key: 'author', name: '研究整理员', mission: '形成候选', capabilities: ['整理'], recruitmentReason: '形成成果。' },
      { key: 'auditor', name: '独立审阅员', mission: '独立检查', capabilities: ['审阅'], recruitmentReason: '确认来源。' },
      { key: 'courier', name: '交付事务员', mission: '等待确认', capabilities: ['交付'], recruitmentReason: '守住确认边界。' },
    ],
    steps: [
      { key: 'synthesis', title: '形成研究候选', kind: 'synthesis', role: 'author', dependsOn: [], tools: [], webScope: { queries: [], urls: [] }, acceptanceCriteria: ['引用第二行事实'], expectedResult: '可追溯候选' },
      { key: 'review', title: '独立审阅', kind: 'review', role: 'auditor', dependsOn: ['synthesis'], tools: [], webScope: { queries: [], urls: [] }, acceptanceCriteria: ['逐条核对来源'], expectedResult: '审阅结论' },
      { key: 'deliver', title: '等待确认', kind: 'delivery', role: 'courier', dependsOn: ['review'], tools: [], webScope: { queries: [], urls: [] }, acceptanceCriteria: ['等待用户确认'], expectedResult: '待确认交付' },
    ],
  };
  let synthesisCalls = 0;
  const providers = {
    status: async () => ({ demo: { id: 'demo' }, codex: { id: 'codex-cli', available: true, verified: true } }),
    verifyCodex: async () => ({ ok: true }),
    plan: async () => structuredClone(plan),
    async replan() { throw new Error('错位引用应在同一会话修正，不应重规划。'); },
    async executeWork(task, item, input) {
      const finish = (output, claims = [], deliverables = []) => ({
        summary: '完成', output, sources: claims.map((claim) => `material:${claim.materialId}#${claim.locator}`), claims,
        gap: '', caveats: [], toolRequests: [], deliverables,
        acceptanceChecks: item.acceptanceCriteria.map((criterion) => ({ criterion, passed: true, evidence: '已完成并可核对' })),
      });
      if (item.kind === 'synthesis') {
        synthesisCalls += 1;
        const material = task.materials[0];
        const corrected = input.toolResults?.some((entry) => entry.tool === 'protocol' && /引用原文不在所标行号/.test(entry.error));
        const claim = { statement: '第二行事实为 20人。', materialId: material.id, sourceName: material.name, locator: corrected ? 'L2-L2' : 'L1-L1', quote: '第二行事实为 20人。' };
        return finish('第二行事实为 20人。', [claim], [{ kind: 'research', title: '研究候选', content: '第二行事实为 20人。' }]);
      }
      return finish('已逐条核对来源。');
    },
    async review(_task, artifact) { return { summary: '通过', checks: [
      { name: '目标符合度', passed: true, evidence: '符合', blocking: true },
      { name: '完整性', passed: true, evidence: '完整', blocking: true },
      { name: '来源核对', passed: true, evidence: '逐条核对', blocking: true },
      { name: '边界遵守', passed: true, evidence: '未执行外部动作', blocking: true },
      { name: '文件可用性', passed: true, evidence: '研究候选无需原生办公文件', blocking: true },
    ], claimChecks: artifact.claims.map((claim, claimIndex) => ({ claimIndex, materialId: claim.materialId, locator: claim.locator, verdict: 'supported', evidence: '原文逐字支持。' })), provider: 'fake-review' }; },
    async converse() { return { reply: '回复', kind: 'answer', sourceRefs: [] }; },
  };
  const running = await start({ port: 0, root, providers });
  t.after(() => running.server.close());
  const created = await post(running.url, '/api/tasks', { goal: '形成引用第二行事实的研究候选', type: 'research', provider: 'codex-cli' });
  const id = created.value.task.id;
  await post(running.url, `/api/tasks/${id}/materials/text`, { name: '两行材料', text: '第一行无关。\n第二行事实为 20人。' });
  await post(running.url, `/api/tasks/${id}/plan`, {});
  await post(running.url, `/api/tasks/${id}/run`, {});
  const finished = await waitForTask(running.url, id);
  assert.equal(finished.status, 'waiting_user');
  assert.equal(finished.plan.revision, 1);
  assert.equal(synthesisCalls, 2);
  const synthesisSession = finished.agentSessions.findLast((session) => session.workItemId === finished.workItems.find((item) => item.kind === 'synthesis').id);
  assert.ok(synthesisSession.toolCalls.some((entry) => entry.tool === 'protocol' && /引用原文不在所标行号/.test(entry.error)));
});

test('独立审阅预检返回合法缺口时有界重规划并重做候选', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-review-gap-replan-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let synthesisCalls = 0;
  let reviewWorkCalls = 0;
  let replanCalls = 0;
  const plan = {
    summary: '先形成候选，再独立审阅。', outputKind: 'document', deliverables: ['document'],
    roles: [
      { key: 'author', name: '成果编辑', mission: '形成文档', capabilities: ['文档'], recruitmentReason: '需要候选成果。' },
      { key: 'auditor', name: '独立审阅员', mission: '检查候选', capabilities: ['审阅'], recruitmentReason: '确认前需独立检查。' },
      { key: 'courier', name: '交付事务员', mission: '等待确认', capabilities: ['交付'], recruitmentReason: '守住确认边界。' },
    ],
    steps: [
      { key: 'synthesize', title: '形成候选', kind: 'synthesis', role: 'author', dependsOn: [], tools: [], acceptanceCriteria: ['形成完整文档'], expectedResult: '文档候选' },
      { key: 'review', title: '独立审阅', kind: 'review', role: 'auditor', dependsOn: ['synthesize'], tools: [], acceptanceCriteria: ['核对文件状态'], expectedResult: '审阅结论' },
      { key: 'deliver', title: '等待确认', kind: 'delivery', role: 'courier', dependsOn: ['review'], tools: [], acceptanceCriteria: ['只交付确认版本'], expectedResult: '待确认交付' },
    ],
  };
  const providers = {
    status: async () => ({ demo: { id: 'demo' }, codex: { id: 'codex-cli', available: true, verified: true } }),
    verifyCodex: async () => ({ ok: true }),
    plan: async () => structuredClone(plan),
    replan: async () => { replanCalls += 1; return structuredClone(plan); },
    async executeWork(_task, item) {
      const finish = (output, deliverables = []) => ({ summary: `${item.title}完成`, output, sources: [], claims: [], gap: '', caveats: [], toolRequests: [], deliverables, acceptanceChecks: item.acceptanceCriteria.map((criterion) => ({ criterion, passed: true, evidence: '有可检查结果' })) });
      if (item.kind === 'synthesis') {
        synthesisCalls += 1;
        return finish(`# 候选版本 ${synthesisCalls}\n\n供独立审阅。`, [{ kind: 'document', title: '候选文档', content: `# 候选版本 ${synthesisCalls}\n\n供独立审阅。` }]);
      }
      reviewWorkCalls += 1;
      if (reviewWorkCalls === 1) return { summary: '发现需修订项', output: '候选仍有阻断性问题。', sources: [], claims: [], gap: '需要重新形成候选版本。', caveats: [], toolRequests: [], deliverables: [], acceptanceChecks: [] };
      return finish('第二版候选的文件状态可核对。');
    },
    async review() {
      return { summary: '第二版独立审阅通过', checks: [
        { name: '目标符合度', passed: true, evidence: '符合', blocking: true },
        { name: '完整性', passed: true, evidence: '完整', blocking: true },
        { name: '来源核对', passed: true, evidence: '无外部事实', blocking: true },
        { name: '边界遵守', passed: true, evidence: '未外部操作', blocking: true },
        { name: '文件可用性', passed: true, evidence: '原生候选已生成', blocking: true },
      ], claimChecks: [], provider: 'fake-review' };
    },
    async converse() { return { reply: '回复', kind: 'answer', sourceRefs: [] }; },
  };
  const running = await start({ port: 0, root, providers });
  t.after(() => running.server.close());
  const created = await post(running.url, '/api/tasks', { goal: '形成一份可审阅文档', provider: 'codex-cli' });
  const id = created.value.task.id;
  await post(running.url, `/api/tasks/${id}/plan`, {});
  await post(running.url, `/api/tasks/${id}/run`, {});
  const finished = await waitForTask(running.url, id);
  assert.equal(finished.status, 'waiting_user');
  assert.equal(finished.plan.revision, 2);
  assert.equal(replanCalls, 1);
  assert.equal(synthesisCalls, 2);
  assert.equal(reviewWorkCalls, 2);
  assert.equal(finished.events.some((entry) => entry.type === 'plan.replanned'), true);
  assert.equal(finished.reviews.at(-1).passed, true);
});

test('动态工作项的可重试失败在同一计划内受尝试上限约束', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-dynamic-retry-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let synthesisCalls = 0;
  let replanCalls = 0;
  const plan = {
    summary: '形成候选后独立审阅。', outputKind: 'document', deliverables: ['document'],
    roles: [
      { key: 'author', name: '成果编辑', mission: '形成文档', capabilities: ['文档'], recruitmentReason: '需要候选成果。' },
      { key: 'auditor', name: '独立审阅员', mission: '核对候选', capabilities: ['审阅'], recruitmentReason: '确认前需独立检查。' },
      { key: 'courier', name: '交付事务员', mission: '等待确认', capabilities: ['交付'], recruitmentReason: '守住确认边界。' },
    ],
    steps: [
      { key: 'synthesize', title: '形成候选', kind: 'synthesis', role: 'author', dependsOn: [], tools: [], webScope: { queries: [], urls: [] }, acceptanceCriteria: ['形成完整文档'], expectedResult: '文档候选' },
      { key: 'review', title: '独立审阅', kind: 'review', role: 'auditor', dependsOn: ['synthesize'], tools: [], webScope: { queries: [], urls: [] }, acceptanceCriteria: ['核对候选'], expectedResult: '审阅结论' },
      { key: 'deliver', title: '等待确认', kind: 'delivery', role: 'courier', dependsOn: ['review'], tools: [], webScope: { queries: [], urls: [] }, acceptanceCriteria: ['等待用户确认'], expectedResult: '待确认交付' },
    ],
  };
  const finish = (item, output, deliverables = []) => ({
    summary: `${item.title}完成`, output, sources: [], claims: [], gap: '', caveats: [], toolRequests: [], deliverables,
    acceptanceChecks: item.acceptanceCriteria.map((criterion) => ({ criterion, passed: true, evidence: '已形成可检查结果' })),
  });
  const providers = {
    status: async () => ({ demo: { id: 'demo' }, codex: { id: 'codex-cli', available: true, verified: true } }),
    verifyCodex: async () => ({ ok: true }),
    plan: async () => structuredClone(plan),
    replan: async () => { replanCalls += 1; return structuredClone(plan); },
    async executeWork(_task, item) {
      if (item.kind === 'synthesis') {
        synthesisCalls += 1;
        if (synthesisCalls === 1) throw new Error('临时提供者失败');
        return finish(item, '# 候选\n\n第二次尝试成功。', [{ kind: 'document', title: '候选', content: '# 候选\n\n第二次尝试成功。' }]);
      }
      return finish(item, '候选已独立核对。');
    },
    async review() { return { summary: '通过', checks: [
      { name: '目标符合度', passed: true, evidence: '符合', blocking: true },
      { name: '完整性', passed: true, evidence: '完整', blocking: true },
      { name: '来源核对', passed: true, evidence: '无外部事实', blocking: true },
      { name: '边界遵守', passed: true, evidence: '未外部操作', blocking: true },
      { name: '文件可用性', passed: true, evidence: '原生候选已生成', blocking: true },
    ], claimChecks: [], provider: 'fake-review' }; },
    async converse() { return { reply: '回复', kind: 'answer', sourceRefs: [] }; },
  };
  const running = await start({ port: 0, root, providers });
  t.after(() => running.server.close());
  const created = await post(running.url, '/api/tasks', { goal: '形成一份可审阅文档', provider: 'codex-cli' });
  const id = created.value.task.id;
  await post(running.url, `/api/tasks/${id}/plan`, {});
  await post(running.url, `/api/tasks/${id}/run`, {});
  const finished = await waitForTask(running.url, id);
  const synthesis = finished.workItems.find((item) => item.kind === 'synthesis');
  assert.equal(finished.status, 'waiting_user');
  assert.equal(synthesisCalls, 2);
  assert.equal(replanCalls, 0);
  assert.equal(synthesis.attempts.length, 1);
  assert.ok(finished.events.some((entry) => entry.type === 'work.retry_scheduled'));

  const oldRunId = finished.execution.id;
  await running.store.mutate(id, (task) => {
    task.execution.deadlineAt = new Date(Date.now() - 60_000).toISOString();
    task.execution.modelCalls = Array.from({ length: task.execution.limits.maxModelCalls }, (_, index) => ({ id: `old-call-${index}`, status: 'completed' }));
  });
  const reviewedAgain = await post(running.url, `/api/tasks/${id}/artifacts/${finished.artifacts[0].id}/review`, {});
  assert.equal(reviewedAgain.response.status, 200);
  assert.notEqual(reviewedAgain.value.task.execution.id, oldRunId);
  assert.ok(reviewedAgain.value.task.executionHistory.some((execution) => execution.id === oldRunId));
  const dynamicReviewer = reviewedAgain.value.task.workItems.findLast((item) => item.manualReviewOfArtifactId === finished.artifacts[0].id);
  assert.equal(dynamicReviewer.role, 'auditor');
  assert.equal(dynamicReviewer.status, 'completed');
  assert.equal(reviewedAgain.value.task.workItems.find((item) => item.kind === 'delivery').status, 'waiting_user');
  const reviewSession = reviewedAgain.value.task.agentSessions.findLast((session) => session.workItemId === dynamicReviewer.id);
  assert.equal(reviewSession.reviewedArtifactId, finished.artifacts[0].id);
  assert.ok(reviewSession.reviewedArtifactHash);
  assert.equal(reviewedAgain.value.task.workItems.some((item) => item.role === 'reviewer'), false);
});

test('旧候选在新计划未运行并取消后可用独立上下文手动复核', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-manual-review-existing-candidate-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const plan = {
    summary: '形成文档并独立复核。', outputKind: 'document', deliverables: ['document'],
    roles: [
      { key: 'author', name: '编辑', mission: '形成文档', capabilities: ['文档'], recruitmentReason: '需要候选。' },
      { key: 'auditor', name: '独立审阅员', mission: '核对候选', capabilities: ['审阅'], recruitmentReason: '确认前需独立检查。' },
      { key: 'courier', name: '交付事务员', mission: '等待确认', capabilities: ['交付'], recruitmentReason: '守住确认边界。' },
    ],
    steps: [
      { key: 'synthesize', title: '形成候选', kind: 'synthesis', role: 'author', dependsOn: [], tools: [], webScope: { queries: [], urls: [] }, acceptanceCriteria: ['形成完整文档'], expectedResult: '文档候选' },
      { key: 'review', title: '独立审阅', kind: 'review', role: 'auditor', dependsOn: ['synthesize'], tools: [], webScope: { queries: [], urls: [] }, acceptanceCriteria: ['核对候选'], expectedResult: '审阅结论' },
      { key: 'deliver', title: '等待确认', kind: 'delivery', role: 'courier', dependsOn: ['review'], tools: [], webScope: { queries: [], urls: [] }, acceptanceCriteria: ['等待确认'], expectedResult: '待确认交付' },
    ],
  };
  const finish = (item, output, deliverables = []) => ({
    summary: `${item.title}完成`, output, sources: [], claims: [], gap: '', caveats: [], toolRequests: [], deliverables,
    acceptanceChecks: item.acceptanceCriteria.map((criterion) => ({ criterion, passed: true, evidence: '已完成' })),
  });
  const providers = {
    status: async () => ({ demo: { id: 'demo' }, codex: { id: 'codex-cli', available: true, verified: true } }),
    verifyCodex: async () => ({ ok: true }),
    plan: async () => structuredClone(plan),
    async executeWork(_task, item) {
      if (item.kind === 'synthesis') return finish(item, '# 候选\n\n保留并复核。', [{ kind: 'document', title: '候选', content: '# 候选\n\n保留并复核。' }]);
      return finish(item, '已对候选进行独立检查。');
    },
    async review() { return { summary: '通过', checks: [
      { name: '目标符合度', passed: true, evidence: '符合', blocking: true },
      { name: '完整性', passed: true, evidence: '完整', blocking: true },
      { name: '来源核对', passed: true, evidence: '无外部事实', blocking: true },
      { name: '边界遵守', passed: true, evidence: '未外部操作', blocking: true },
      { name: '文件可用性', passed: true, evidence: '原生文档已生成', blocking: true },
    ], claimChecks: [], provider: 'fake-review' }; },
    async converse() { return { reply: '回复', kind: 'answer', sourceRefs: [] }; },
  };
  const running = await start({ port: 0, root, providers });
  t.after(() => running.server.close());
  const created = await post(running.url, '/api/tasks', { goal: '保留旧候选并复核', provider: 'codex-cli' });
  const id = created.value.task.id;
  await post(running.url, `/api/tasks/${id}/plan`, {});
  await post(running.url, `/api/tasks/${id}/run`, {});
  const first = await waitForTask(running.url, id);
  const artifactId = first.artifacts[0].id;

  const replanned = await post(running.url, `/api/tasks/${id}/plan`, {});
  assert.equal(replanned.response.status, 200);
  assert.equal(replanned.value.task.workItems.find((item) => item.kind === 'synthesis').status, 'ready');
  await post(running.url, `/api/tasks/${id}/cancel`, {});
  const refreshed = await post(running.url, `/api/tasks/${id}/artifacts/${artifactId}/refresh-native`, {});
  assert.equal(refreshed.response.status, 200);
  const reviewed = await post(running.url, `/api/tasks/${id}/artifacts/${artifactId}/review`, {});
  assert.equal(reviewed.response.status, 200);
  assert.equal(reviewed.value.review.passed, true);
  const manual = reviewed.value.task.workItems.findLast((item) => item.manualReviewOfArtifactId === artifactId);
  assert.equal(manual.status, 'completed');
  assert.equal(manual.dependsOn.length, 0);
  assert.equal(manual.basedOnWorkItemId, replanned.value.task.workItems.find((item) => item.kind === 'review').id);
  assert.equal(reviewed.value.task.workItems.find((item) => item.kind === 'synthesis').status, 'ready');
  assert.equal(reviewed.value.task.workItems.find((item) => item.kind === 'delivery').status, 'pending');
  const session = reviewed.value.task.agentSessions.findLast((item) => item.workItemId === manual.id);
  assert.equal(session.reviewedArtifactId, artifactId);
  assert.ok(session.reviewedArtifactHash);
  assert.equal(reviewed.value.task.activeAgentId, manual.agentId);
});

test('办公室投影按手动复核的在途动态审阅员显示真实审阅状态', () => {
  const goal = { id: 'goal-current', version: 1, statement: '核对候选', status: 'active' };
  const task = {
    id: 'task-projection', provider: 'codex-cli', status: 'running', activeRole: 'auditor', activeAgentId: 'agent-auditor',
    goal: { activeVersionId: goal.id, versions: [goal] }, artifacts: [], reviews: [], events: [{ message: '正在手动复核', at: new Date().toISOString() }],
    team: { agents: [{ id: 'agent-auditor', roleKey: 'auditor', stationRole: 'reviewer' }] },
    workItems: [
      { id: 'old-review', agentId: 'agent-auditor', role: 'auditor', kind: 'review', title: '旧审阅', status: 'pending' },
      { id: 'manual-review', agentId: 'agent-auditor', role: 'auditor', kind: 'review', title: '手动复核', status: 'running' },
    ],
    execution: { phase: 'reviewing', delegations: [], resultBatch: [] }, materials: [],
  };
  const projection = serverTest.projectOfficeTask(task);
  assert.equal(projection.state, 'reviewing');
  assert.equal(projection.role, 'auditor');
  assert.equal(projection.team.workItems.find((item) => item.id === 'manual-review').status, 'running');
});

test('重新审阅在途会立即失效旧通过结论并阻止并发确认', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-review-confirm-race-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let reviewCalls = 0;
  let rejectDelayedReview;
  const passing = { summary: '通过', checks: [
    { name: '目标符合度', passed: true, evidence: '符合', blocking: true },
    { name: '完整性', passed: true, evidence: '完整', blocking: true },
    { name: '来源核对', passed: true, evidence: '无外部事实', blocking: true },
    { name: '边界遵守', passed: true, evidence: '未外部操作', blocking: true },
    { name: '文件可用性', passed: true, evidence: '正文存在', blocking: true },
  ], claimChecks: [], provider: 'fake-review' };
  const providers = {
    status: async () => ({ demo: { id: 'demo', available: true, verified: true }, codex: { id: 'codex-cli' } }),
    verifyCodex: async () => ({ ok: true }),
    async generate() { return { title: '并发候选', summary: '候选', content: '等待独立核对的正文。', sources: [], claims: [] }; },
    async review() {
      reviewCalls += 1;
      if (reviewCalls === 1) return structuredClone(passing);
      if (reviewCalls === 2) return new Promise((_resolve, reject) => { rejectDelayedReview = reject; });
      throw new Error('延迟审阅失败');
    },
    async converse() { return { reply: '回复', kind: 'answer', sourceRefs: [] }; },
  };
  const running = await start({ port: 0, root, providers });
  t.after(() => running.server.close());
  const created = await post(running.url, '/api/tasks', { goal: '验证复核确认竞态', provider: 'demo' });
  const id = created.value.task.id;
  await post(running.url, `/api/tasks/${id}/plan`, {});
  await post(running.url, `/api/tasks/${id}/run`, {});
  const finished = await waitForTask(running.url, id);
  const artifactId = finished.artifacts[0].id;
  assert.equal(finished.artifacts[0].reviewStatus, 'passed');

  const reviewing = post(running.url, `/api/tasks/${id}/artifacts/${artifactId}/review`, {});
  await waitFor(() => rejectDelayedReview);
  const during = (await (await fetch(`${running.url}/api/tasks/${id}`)).json()).task;
  assert.equal(during.artifacts[0].reviewStatus, 'pending');
  assert.deepEqual(during.runtime.activeJob, { kind: 'review', role: 'reviewer' });
  const concurrentConfirm = await post(running.url, `/api/tasks/${id}/artifacts/${artifactId}/confirm`, {});
  assert.equal(concurrentConfirm.response.status, 409);
  rejectDelayedReview(new Error('延迟审阅失败'));
  assert.equal((await reviewing).response.status, 400);
  const failed = await waitForTask(running.url, id);
  assert.equal(failed.artifacts[0].reviewStatus, 'failed');
  const staleConfirm = await post(running.url, `/api/tasks/${id}/artifacts/${artifactId}/confirm`, {});
  assert.equal(staleConfirm.response.status, 400);
  await post(running.url, `/api/tasks/${id}/artifacts/${artifactId}/reject`, { reason: '拒绝这个版本' });
  const rejectedConfirm = await post(running.url, `/api/tasks/${id}/artifacts/${artifactId}/confirm`, {});
  assert.equal(rejectedConfirm.response.status, 400);
});

test('动态同错达到上限与权限错误直接停止，不再触发重规划', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-terminal-retry-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let synthesisCalls = 0;
  let replanCalls = 0;
  const plan = {
    summary: '形成候选后独立审阅。', outputKind: 'document', deliverables: ['document'],
    roles: [
      { key: 'author', name: '编辑', mission: '形成候选', capabilities: ['文档'], recruitmentReason: '需要候选。' },
      { key: 'auditor', name: '审阅', mission: '独立核对', capabilities: ['审阅'], recruitmentReason: '需要复核。' },
      { key: 'courier', name: '交付', mission: '等待确认', capabilities: ['交付'], recruitmentReason: '守住边界。' },
    ],
    steps: [
      { key: 'synthesize', title: '形成候选', kind: 'synthesis', role: 'author', dependsOn: [], tools: [], webScope: { queries: [], urls: [] }, acceptanceCriteria: ['形成文档'], expectedResult: '文档候选' },
      { key: 'review', title: '独立审阅', kind: 'review', role: 'auditor', dependsOn: ['synthesize'], tools: [], webScope: { queries: [], urls: [] }, acceptanceCriteria: ['核对候选'], expectedResult: '审阅结论' },
      { key: 'deliver', title: '等待确认', kind: 'delivery', role: 'courier', dependsOn: ['review'], tools: [], webScope: { queries: [], urls: [] }, acceptanceCriteria: ['等待确认'], expectedResult: '待确认交付' },
    ],
  };
  const providers = {
    status: async () => ({ demo: { id: 'demo' }, codex: { id: 'codex-cli', available: true, verified: true } }),
    verifyCodex: async () => ({ ok: true }),
    plan: async () => structuredClone(plan),
    replan: async () => { replanCalls += 1; return structuredClone(plan); },
    async executeWork(task) {
      synthesisCalls += 1;
      if (task.goal.versions.at(-1).statement.includes('权限')) throw new Error('权限不足');
      throw new Error('同一个临时错误');
    },
    async review() { throw new Error('不应进入审阅'); },
    async converse() { return { reply: '回复', kind: 'answer', sourceRefs: [] }; },
  };
  const running = await start({ port: 0, root, providers });
  t.after(() => running.server.close());

  const repeated = await post(running.url, '/api/tasks', { goal: '验证同错上限', provider: 'codex-cli' });
  await post(running.url, `/api/tasks/${repeated.value.task.id}/plan`, {});
  await post(running.url, `/api/tasks/${repeated.value.task.id}/run`, {});
  const repeatedDone = await waitForTask(running.url, repeated.value.task.id);
  assert.equal(repeatedDone.status, 'partial');
  assert.equal(repeatedDone.execution.stopReason, 'same_error_exhausted');
  assert.equal(repeatedDone.workItems.find((item) => item.kind === 'synthesis').attempts.length, 2);
  assert.equal(replanCalls, 0);

  const callsBeforePermission = synthesisCalls;
  const permanent = await post(running.url, '/api/tasks', { goal: '验证权限错误', provider: 'codex-cli' });
  await post(running.url, `/api/tasks/${permanent.value.task.id}/plan`, {});
  await post(running.url, `/api/tasks/${permanent.value.task.id}/run`, {});
  const permanentDone = await waitForTask(running.url, permanent.value.task.id);
  assert.equal(permanentDone.status, 'partial');
  assert.equal(permanentDone.execution.stopReason, 'permanent_error');
  assert.equal(permanentDone.workItems.find((item) => item.kind === 'synthesis').status, 'blocked');
  assert.equal(synthesisCalls - callsBeforePermission, 1);
  assert.equal(replanCalls, 0);
});

test('启动时把悬空运行闭合为可继续的部分完成状态', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-run-recovery-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = await start({ port: 0, root });
  const created = await post(first.url, '/api/tasks', { goal: '验证重启恢复', provider: 'demo' });
  const id = created.value.task.id;
  await post(first.url, `/api/tasks/${id}/plan`, {});
  await post(first.url, `/api/tasks/${id}/run`, {});
  const finished = await waitForTask(first.url, id);
  const artifactId = finished.artifacts[0].id;
  await first.store.mutate(id, (task) => {
    const reviewer = task.workItems.find((item) => item.role === 'reviewer');
    reviewer.status = 'running'; reviewer.completedAt = null;
    task.status = 'running'; task.activeRole = 'reviewer';
    task.execution.phase = 'reviewing';
    task.execution.modelCalls.push({ id: 'call-interrupted', role: 'reviewer', status: 'running', startedAt: new Date().toISOString(), finishedAt: null });
    task.execution.delegations.push({ id: 'delegation-interrupted', workItemId: reviewer.id, status: 'running', delegatedAt: new Date().toISOString() });
    task.agentSessions.push({ id: 'session-interrupted', workItemId: reviewer.id, status: 'running', updatedAt: new Date().toISOString() });
  });
  await new Promise((resolve) => first.server.close(resolve));

  const restoredServer = await start({ port: 0, root });
  t.after(() => restoredServer.server.close());
  const restored = (await (await fetch(`${restoredServer.url}/api/tasks/${id}`)).json()).task;
  assert.equal(restored.status, 'partial');
  assert.equal(restored.execution.phase, 'partial');
  assert.equal(restored.execution.stopReason, 'process_restart_interrupted');
  assert.equal(restored.execution.modelCalls.some((call) => call.status === 'running'), false);
  assert.equal(restored.execution.delegations.some((entry) => entry.status === 'running'), false);
  assert.equal(restored.agentSessions.some((session) => session.status === 'running'), false);
  assert.equal(restored.artifacts.some((artifact) => artifact.id === artifactId), true);
  assert.ok(restored.events.some((entry) => entry.type === 'execution.recovered'));

  const resumed = await post(restoredServer.url, `/api/tasks/${id}/run`, {});
  assert.equal(resumed.response.status, 202);
  const completed = await waitForTask(restoredServer.url, id);
  assert.equal(completed.status, 'waiting_user');
  assert.equal(completed.artifacts.length, 2);
});

test('同一任务的多个演示文稿版本使用独立验证目录且保留旧版本', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-presentation-versions-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const running = await start({ port: 0, root });
  t.after(() => running.server.close());
  const created = await post(running.url, '/api/tasks', { goal: '制作一份可审阅的内部演示文稿', type: 'presentation', provider: 'demo' });
  const id = created.value.task.id;
  await post(running.url, `/api/tasks/${id}/plan`, {});
  await post(running.url, `/api/tasks/${id}/run`, {});
  const first = await waitForTask(running.url, id);
  assert.equal(first.artifacts[0].nativeFiles[0].status, 'ready');
  const firstNative = first.artifacts[0].nativeFiles[0];
  await serverTest.generateNativeCandidateFiles(running.store, id, first.artifacts[0].id);
  const reused = (await running.store.get(id)).artifacts[0].nativeFiles[0];
  assert.equal(reused.status, 'ready');
  assert.equal(reused.sha256, firstNative.sha256);
  assert.ok(reused.reusedAt);
  const candidateDir = path.join(running.store.taskDir(id), 'exports', 'candidates', first.artifacts[0].id);
  const request = JSON.parse(await fs.readFile(path.join(candidateDir, 'presentation.request.json'), 'utf8'));
  const receipt = JSON.parse(await fs.readFile(path.join(candidateDir, 'presentation.pptx.receipt.json'), 'utf8'));
  assert.equal(request.generatorRevision, '2026-10-01.1');
  assert.equal(receipt.generatorRevision, request.generatorRevision);

  const reviewCount = first.reviews.length;
  const refreshed = await post(running.url, `/api/tasks/${id}/artifacts/${first.artifacts[0].id}/refresh-native`, {});
  assert.equal(refreshed.response.status, 200);
  assert.equal(refreshed.value.artifact.reviewStatus, 'pending');
  assert.equal(refreshed.value.task.reviews.length, reviewCount);
  assert.ok(refreshed.value.task.events.some((entry) => entry.type === 'artifact.native_refreshed'));
  const blockedConfirm = await post(running.url, `/api/tasks/${id}/artifacts/${first.artifacts[0].id}/confirm`, {});
  assert.equal(blockedConfirm.response.status, 400);
  const reviewedAgain = await post(running.url, `/api/tasks/${id}/artifacts/${first.artifacts[0].id}/review`, {});
  assert.equal(reviewedAgain.response.status, 200);
  assert.equal(reviewedAgain.value.review.passed, true);
  assert.equal(reviewedAgain.value.review.nativeFiles[0].generatorRevision, '2026-10-01.1');

  const rejectedTextOverwrite = await post(running.url, `/api/tasks/${id}/artifacts/${first.artifacts[0].id}/revise`, { content: '不应覆盖结构化幻灯片' });
  assert.equal(rejectedTextOverwrite.response.status, 400);
  await post(running.url, `/api/tasks/${id}/run`, {});
  const secondRun = await waitForTask(running.url, id);
  const revised = secondRun.artifacts.at(-1);
  assert.equal(revised.version, 2);
  assert.equal(revised.nativeFiles[0].status, 'ready');
  const restored = (await (await fetch(`${running.url}/api/tasks/${id}`)).json()).task;
  assert.equal(restored.artifacts.length, 2);
  assert.equal(restored.artifacts.every((artifact) => artifact.nativeFiles[0].status === 'ready'), true);
  assert.notEqual(restored.artifacts[0].nativeFiles[0].relativePath, restored.artifacts[1].nativeFiles[0].relativePath);
});

test('四页演示的十二条短要点保持为全宽正文并完整生成四张预览', async (t) => {
  const evidenceRoot = process.env.IRIXI_PPT_EVIDENCE_DIR;
  const root = evidenceRoot ? path.resolve(evidenceRoot) : await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-presentation-long-list-'));
  if (!evidenceRoot) t.after(() => fs.rm(root, { recursive: true, force: true }));
  const running = await start({ port: 0, root });
  t.after(() => running.server.close());
  const created = await post(running.url, '/api/tasks', { goal: '生成四页内部会议演示', type: 'presentation', provider: 'demo' });
  const id = created.value.task.id;
  const slideFour = ['行动清单', ...Array.from({ length: 12 }, (_, index) => `• 第${index + 1}项：确认负责人、截止日期与依赖条件`)].join('\n');
  const content = JSON.stringify({ slides: [
    { title: '会议结论', body: '本次会议形成三项明确结论。' },
    { title: '关键进展', body: '• 进展一\n• 进展二\n• 进展三' },
    { title: '风险与依赖', body: '• 风险一\n• 依赖一\n• 待确认一' },
    { title: '后续行动', body: slideFour },
  ] });
  const added = await running.store.mutate(id, (task) => createArtifact(task, {
    title: '四页内部会议演示', summary: '含十二条后续行动。', content: '四页会议演示候选。', sources: [], claims: [],
    deliverables: [{ kind: 'presentation', title: '四页内部会议演示', content }],
  }, 'test'));
  await serverTest.generateNativeCandidateFiles(running.store, id, added.result.id);
  const artifact = (await running.store.get(id)).artifacts.find((item) => item.id === added.result.id);
  const native = artifact.nativeFiles.find((file) => file.kind === 'presentation');
  assert.equal(native.status, 'ready');
  assert.equal(native.previewPaths.length, 4);
  assert.equal((await Promise.all(native.previewPaths.map((entry) => fs.stat(path.join(running.store.taskDir(id), entry))))).every((stat) => stat.size > 0), true);
});

test('强制刷新文档时预览绑定当前文件且不复用旧页面', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-document-preview-refresh-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const running = await start({ port: 0, root });
  t.after(() => running.server.close());
  const created = await post(running.url, '/api/tasks', { goal: '制作一份可审阅的内部文档', type: 'document', provider: 'demo' });
  const id = created.value.task.id;
  await post(running.url, `/api/tasks/${id}/plan`, {});
  await post(running.url, `/api/tasks/${id}/run`, {});
  const finished = await waitForTask(running.url, id);
  const artifact = finished.artifacts[0];
  const firstNative = artifact.nativeFiles.find((entry) => entry.kind === 'document');
  assert.equal(firstNative.previewSourceSha256, firstNative.sha256);
  const firstPreviewDir = path.dirname(path.join(running.store.taskDir(id), firstNative.previewPaths[0]));
  await fs.writeFile(path.join(firstPreviewDir, 'stale-page.png'), Buffer.from('old'));

  await serverTest.generateNativeCandidateFiles(running.store, id, artifact.id, { force: true });
  const refreshed = (await running.store.get(id)).artifacts[0].nativeFiles.find((entry) => entry.kind === 'document');
  assert.equal(refreshed.previewSourceSha256, refreshed.sha256);
  assert.notEqual(path.dirname(refreshed.previewPaths[0]), path.dirname(firstNative.previewPaths[0]));
  assert.equal(refreshed.previewPaths.some((entry) => entry.endsWith('stale-page.png')), false);
  assert.equal((await Promise.all(refreshed.previewPaths.map((entry) => fs.stat(path.join(running.store.taskDir(id), entry))))).every((stat) => stat.size > 0), true);

  await serverTest.generateNativeCandidateFiles(running.store, id, artifact.id);
  const reused = (await running.store.get(id)).artifacts[0].nativeFiles.find((entry) => entry.kind === 'document');
  assert.deepEqual(reused.previewPaths, refreshed.previewPaths);
  assert.ok(reused.reusedAt);
});

test('原生多交付物后段失败时保留先成功文件并闭合模型调用与委派', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-native-partial-failure-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const plan = {
    summary: '生成文档与演示文稿并审阅。', outputKind: 'document', deliverables: ['document', 'presentation'],
    roles: [
      { key: 'author', name: '成果编辑', mission: '形成两种成果', capabilities: ['文档', '演示'], recruitmentReason: '目标要求两种成果。' },
      { key: 'auditor', name: '独立审阅员', mission: '独立检查', capabilities: ['审阅'], recruitmentReason: '确认前需复核。' },
      { key: 'courier', name: '交付事务员', mission: '等待确认', capabilities: ['交付'], recruitmentReason: '守住确认边界。' },
    ],
    steps: [
      { key: 'synthesize', title: '形成两种候选', kind: 'synthesis', role: 'author', dependsOn: [], tools: [], webScope: { queries: [], urls: [] }, acceptanceCriteria: ['形成文档和演示文稿'], expectedResult: '两种候选' },
      { key: 'review', title: '独立审阅', kind: 'review', role: 'auditor', dependsOn: ['synthesize'], tools: [], webScope: { queries: [], urls: [] }, acceptanceCriteria: ['独立检查'], expectedResult: '审阅结论' },
      { key: 'deliver', title: '等待确认', kind: 'delivery', role: 'courier', dependsOn: ['review'], tools: [], webScope: { queries: [], urls: [] }, acceptanceCriteria: ['等待用户确认'], expectedResult: '待确认交付' },
    ],
  };
  const providers = {
    status: async () => ({ demo: { id: 'demo' }, codex: { id: 'codex-cli', available: true, verified: true } }),
    verifyCodex: async () => ({ ok: true }),
    plan: async () => structuredClone(plan),
    async replan() { throw new Error('invalid_json_schema: 模拟严格 schema 拒绝'); },
    async executeWork(_task, item) {
      if (item.kind !== 'synthesis') throw new Error('不应进入审阅');
      const invalidWideTable = ['A｜B｜C｜D｜E｜F｜G｜H｜I', '1｜2｜3｜4｜5｜6｜7｜8｜9', 'a｜b｜c｜d｜e｜f｜g｜h｜i'].join('\n');
      return {
        summary: '两种候选已形成', output: '候选供审阅', sources: [], claims: [], gap: '', caveats: [], toolRequests: [],
        deliverables: [
          { kind: 'document', title: '保留的文档', content: '# 保留的文档\n\n这一份应在后续 PPT 失败后继续保留。' },
          { kind: 'presentation', title: '会失败的演示', content: JSON.stringify({ slides: [{ title: '过宽表格', body: invalidWideTable }] }) },
        ],
        acceptanceChecks: [{ criterion: '形成文档和演示文稿', passed: true, evidence: '模型返回了两种候选，原生生成仍需宿主验证' }],
      };
    },
    async review() { throw new Error('不应进入审阅'); },
    async converse() { return { reply: '回复', kind: 'answer', sourceRefs: [] }; },
  };
  const running = await start({ port: 0, root, providers });
  t.after(() => running.server.close());
  const created = await post(running.url, '/api/tasks', { goal: '形成文档和演示文稿', provider: 'codex-cli' });
  const id = created.value.task.id;
  await post(running.url, `/api/tasks/${id}/plan`, {});
  await post(running.url, `/api/tasks/${id}/run`, {});
  const failed = await waitForTask(running.url, id);
  assert.equal(failed.status, 'partial');
  assert.equal(failed.execution.stopReason, 'native_generation_failed');
  assert.equal(failed.artifacts.length, 1);
  assert.equal(failed.artifacts[0].nativeFiles.find((file) => file.kind === 'document')?.status, 'ready');
  assert.equal(failed.artifacts[0].nativeFiles.find((file) => file.kind === 'presentation')?.status, 'failed');
  assert.equal(failed.execution.modelCalls.some((call) => call.status === 'running' || !call.finishedAt), false);
  assert.equal(failed.execution.delegations.some((delegation) => delegation.status === 'running'), false);
  assert.match(failed.workItems.find((item) => item.kind === 'synthesis').error, /presentation 候选文件生成失败/);
});

test('关联上下文隔离且根工作交代传播会拒收子任务迟到结果', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-project-support-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const workCalls = [];
  const planCalls = [];
  const providers = {
    status: async () => ({ demo: { id: 'demo' }, codex: { id: 'codex-cli', available: true, verified: true } }),
    verifyCodex: async () => ({ ok: true }),
    async plan(task) { planCalls.push(structuredClone(task)); return alignedPlan(); },
    executeWork(task, item, input, { signal }) {
      return new Promise((resolve) => workCalls.push({ task: structuredClone(task), item, input: structuredClone(input), signal, resolve }));
    },
    async review() { throw new Error('迟到候选不应进入审阅'); },
    async converse() { return { reply: '状态已读取', kind: 'answer', sourceRefs: [] }; },
  };
  const running = await start({ port: 0, root: rootDir, providers });
  t.after(() => running.server.close());
  const root = (await post(running.url, '/api/tasks', { goal: '建设持续推进的办公 Agent', provider: 'codex-cli' })).value.task;
  const child = (await post(running.url, '/api/tasks', { goal: '实现续接核验', provider: 'codex-cli' })).value.task;
  const unrelated = (await post(running.url, '/api/tasks', { goal: '私人薪资表', provider: 'codex-cli' })).value.task;
  await post(running.url, `/api/tasks/${child.id}/project-link`, { rootTaskId: root.id });
  await post(running.url, `/api/tasks/${root.id}/suggestions`, { text: '优先续接，不引入新付费服务' });
  await post(running.url, `/api/tasks/${child.id}/plan`, {});
  assert.equal(planCalls[0].projectContext.rootGoal.statement, '建设持续推进的办公 Agent');
  assert.equal(planCalls[0].projectContext.acceptedInstructions[0].text, '优先续接，不引入新付费服务');
  assert.ok(planCalls[0].linkedTaskContext.some((item) => item.taskId === root.id));
  assert.equal(planCalls[0].linkedTaskContext.some((item) => item.taskId === unrelated.id), false);

  await post(running.url, `/api/tasks/${child.id}/run`, {});
  const call = await waitFor(() => workCalls[0]);
  assert.equal(call.input.projectContext.rootGoal.statement, '建设持续推进的办公 Agent');
  assert.deepEqual(call.task.projectContext.acceptedInstructions.map((item) => item.text), ['优先续接，不引入新付费服务']);
  await post(running.url, `/api/tasks/${root.id}/suggestions`, { text: '新增工作交代：所有断点必须可恢复' });
  call.resolve({
    summary: '旧输入结果', output: '不应写入', sources: [], claims: [], gap: '', caveats: [], toolRequests: [],
    deliverables: [{ kind: 'document', title: '旧结果', content: '# 旧结果' }],
    acceptanceChecks: [{ criterion: '形成候选', passed: true, evidence: '旧输入声称完成' }],
  });
  const stopped = await waitFor(async () => {
    const task = (await (await fetch(`${running.url}/api/tasks/${child.id}`)).json()).task;
    return task.status !== 'running' && !task.runtime?.activeJob ? task : null;
  });
  assert.equal(stopped.artifacts.length, 0);
  assert.equal(stopped.plan, null);
  assert.ok(stopped.events.some((item) => item.type === 'project.instructions_synced'));
});

test('根目标待决定跨重启暂停关联任务，多条替换全部解除后才可续接', async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-project-pending-restart-'));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  let running = await start({ port: 0, root: rootDir });
  t.after(() => running.server.close());
  const root = (await post(running.url, '/api/tasks', { goal: '采购项目' })).value.task;
  const child = (await post(running.url, '/api/tasks', { goal: '整理采购核验清单' })).value.task;
  await post(running.url, `/api/tasks/${child.id}/project-link`, { rootTaskId: root.id });
  const first = await post(running.url, `/api/tasks/${root.id}/suggestions`, { text: '最终目标改成招聘项目' });
  const second = await post(running.url, `/api/tasks/${root.id}/suggestions`, { text: '最终目标改成销售项目' });
  let paused = (await (await fetch(`${running.url}/api/tasks/${child.id}`)).json()).task;
  assert.equal(paused.status, 'waiting_user');
  assert.match(paused.continuity.progress.nextStep, /项目根任务的目标变更决定/);

  await running.store.mutate(root.id, (task) => { task.status = 'idle'; });
  await running.store.mutate(child.id, (task) => { task.status = 'idle'; });
  await new Promise((resolve) => running.server.close(resolve));
  running = await start({ port: 0, root: rootDir });
  const restoredRoot = (await (await fetch(`${running.url}/api/tasks/${root.id}`)).json()).task;
  assert.equal(restoredRoot.status, 'waiting_user');
  assert.match(restoredRoot.continuity.progress.nextStep, /完整填写并决定/);
  paused = (await (await fetch(`${running.url}/api/tasks/${child.id}`)).json()).task;
  assert.equal(paused.status, 'waiting_user');
  const continued = await post(running.url, `/api/tasks/${child.id}/continue`, {});
  assert.equal(continued.value.action, 'await_user');

  await post(running.url, `/api/tasks/${root.id}/suggestions/${first.value.suggestion.id}/classification`, { classification: 'deviate' });
  assert.equal((await (await fetch(`${running.url}/api/tasks/${child.id}`)).json()).task.status, 'waiting_user');
  await post(running.url, `/api/tasks/${root.id}/suggestions/${second.value.suggestion.id}/classification`, { classification: 'deviate' });
  const released = (await (await fetch(`${running.url}/api/tasks/${child.id}`)).json()).task;
  assert.equal(released.status, 'idle');
  assert.ok(released.events.some((item) => item.type === 'project.goal_decision_resolved'));
});

test('审阅工作返回合法缺口时立即有界重规划并修复候选，不重复追问同一审阅员', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-review-gap-replan-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let replanned = false;
  let replanCalls = 0;
  let reviewWorkBeforeReplan = 0;
  let synthesisCalls = 0;
  const makePlan = (revised = false) => ({
    summary: revised ? '补齐边界后重新形成候选并审阅。' : '先形成候选，再独立审阅。',
    projectAlignment: { status: 'standalone', explanation: '独立任务。' },
    outputKind: 'email', deliverables: ['email'],
    roles: [
      { key: 'author', name: '起草员', mission: '形成候选', capabilities: ['写作'], recruitmentReason: '需要形成邮件候选。' },
      { key: 'auditor', name: '审阅员', mission: '检查条件与边界', capabilities: ['审阅'], recruitmentReason: '确认前独立核对。' },
      { key: 'courier', name: '交付员', mission: '等待确认', capabilities: ['交付'], recruitmentReason: '守住确认边界。' },
    ],
    steps: [
      { key: revised ? 'write-v2' : 'write', title: revised ? '补齐办公工具边界并重写' : '形成初稿', kind: 'synthesis', role: 'author', dependsOn: [], tools: [], webScope: { queries: [], urls: [] }, acceptanceCriteria: [revised ? '明确成功条件和办公工具边界' : '形成初稿'], expectedResult: '邮件候选' },
      { key: revised ? 'review-v2' : 'review', title: '独立审阅', kind: 'review', role: 'auditor', dependsOn: [revised ? 'write-v2' : 'write'], tools: [], webScope: { queries: [], urls: [] }, acceptanceCriteria: ['检查成功条件和边界'], expectedResult: '审阅结论' },
      { key: 'deliver', title: '等待确认', kind: 'delivery', role: 'courier', dependsOn: [revised ? 'review-v2' : 'review'], tools: [], webScope: { queries: [], urls: [] }, acceptanceCriteria: ['等待明确确认'], expectedResult: '待确认成果' },
    ],
  });
  const providers = {
    status: async () => ({ demo: { id: 'demo' }, codex: { id: 'codex-cli', available: true, verified: true } }),
    verifyCodex: async () => ({ ok: true }),
    async plan() { return makePlan(false); },
    async replan(_task, failure) {
      replanCalls += 1;
      assert.match(failure.message, /成功条件或边界/);
      replanned = true;
      return makePlan(true);
    },
    async executeWork(_task, item) {
      if (item.kind === 'synthesis') {
        synthesisCalls += 1;
        const criterion = item.acceptanceCriteria[0];
        return {
          summary: replanned ? '已补齐边界' : '初稿',
          output: replanned ? '成功条件与办公工具边界均已明确。' : '只有初稿。',
          sources: [], claims: [], gap: '', caveats: [], toolRequests: [],
          deliverables: [{ kind: 'email', title: '邮件候选', content: replanned ? '成功条件与办公工具边界均已明确。' : '只有初稿。' }],
          acceptanceChecks: [{ criterion, passed: true, evidence: '候选已形成' }],
        };
      }
      if (item.kind === 'review' && !replanned) {
        reviewWorkBeforeReplan += 1;
        return {
          summary: '发现内容缺口', output: '需要回到起草步骤修复。',
          sources: [], claims: [], gap: '成功条件或边界没有都改变，且缺少明确办公工具边界。', caveats: [], toolRequests: [], deliverables: [], acceptanceChecks: [],
        };
      }
      return {
        summary: '审阅工作已完成', output: '成功条件和边界均已核对。',
        sources: [], claims: [], gap: '', caveats: [], toolRequests: [], deliverables: [],
        acceptanceChecks: [{ criterion: item.acceptanceCriteria[0], passed: true, evidence: '新版候选已补齐缺口' }],
      };
    },
    async review() {
      return { summary: '通过', checks: [
        { name: '目标符合度', passed: true, evidence: '符合', blocking: true },
        { name: '完整性', passed: true, evidence: '完整', blocking: true },
        { name: '来源核对', passed: true, evidence: '无外部事实', blocking: true },
        { name: '边界遵守', passed: true, evidence: '边界明确', blocking: true },
        { name: '文件可用性', passed: true, evidence: '邮件候选可用', blocking: true },
      ], claimChecks: [], provider: 'fake-review' };
    },
    async converse() { return { reply: '状态', kind: 'answer', sourceRefs: [] }; },
  };
  const running = await start({ port: 0, root, providers });
  t.after(() => running.server.close());
  const task = (await post(running.url, '/api/tasks', { goal: '同时改变成功条件和边界并形成邮件', provider: 'codex-cli', type: 'email' })).value.task;
  await post(running.url, `/api/tasks/${task.id}/plan`, {});
  await post(running.url, `/api/tasks/${task.id}/run`, {});
  const finished = await waitForTask(running.url, task.id);
  assert.equal(finished.status, 'waiting_user');
  assert.equal(replanCalls, 1);
  assert.equal(reviewWorkBeforeReplan, 1);
  assert.equal(synthesisCalls, 2);
  assert.equal(finished.execution.planRevisions, 1);
  assert.equal(finished.artifacts.at(-1).reviewStatus, 'passed');
  assert.ok(finished.events.some((item) => item.type === 'work.gap_detected'));
});
