import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import { buildAuthorityProjection, projectTaskBoard, sha256 } from '../authority/authority-core.mjs';
import { createIntakeController, __test } from '../authority/intake-controller.mjs';
import { articleDiscussionBlock, describeArticleDiscussion } from '../authority/model-availability.mjs';
import { createIntegrationController } from '../authority/task-controller.mjs';

const IRIXI_APP_ROOT = path.resolve(import.meta.dirname, '../../../../app');
const AGENT_PANE = path.resolve(import.meta.dirname, '..', '..', 'sources', 'OpenOffice', 'apps', 'web', 'src', 'components', 'office', 'ui', 'AgentPane.tsx');
const AUTHORITY_SERVER = path.resolve(import.meta.dirname, '..', 'authority', 'server.mjs');

test('CONTROLLED: terminal message replacement refreshes both current authority projections', async () => {
  const source = await fs.readFile(AGENT_PANE, 'utf8');
  assert.match(source, /const latestMessageId = messages\.at\(-1\)\?\.id \|\| "";/);
  assert.match(source, /\[agentId, messages\.length, latestMessageId, status, busy, irixiRunEnabled, intake\?\.discussionOnly\]/);
  assert.match(source, /\[agentId, messages\.length, latestMessageId, status, busy, intakeEnabled\]/);
  assert.match(source, /data-irixi-intake-candidate/);
});

// Local-history replay requires excluded private records; retained in the local source snapshot.

test('CONTROLLED: article-learning intake is discussion-only and opens without creating or resetting a model ledger', async () => {
  const server = await fs.readFile(AUTHORITY_SERVER, 'utf8');
  const pane = await fs.readFile(AGENT_PANE, 'utf8');
  assert.match(server, /ARTICLE_INTAKE_TASK_ID = 'task-article-learning-11'/);
  assert.match(server, /ARTICLE_WORKSPACE = path\.join\(ARTICLE_PROJECT_ROOT, 'workspace'\)/);
  assert.match(server, /ARTICLE_DISCUSSION_LEDGER = path\.join\(ARTICLE_PROJECT_ROOT, 'state', 'model-ledger\.json'\)/);
  assert.match(server, /unsentDraft: ARTICLE_DRAFT, executionSupported: false, executionOption: null/);
  assert.match(server, /writeArticleCapabilityEnabled\(true\)/);
  assert.match(server, /writeArticleCapabilityEnabled\(false\)/);
  assert.doesNotMatch(server, /unlink\(ARTICLE_DISCUSSION_LEDGER/);
  assert.match(pane, /data-irixi-intake-open-discussion/);
  assert.match(pane, /data-irixi-intake-close-discussion/);
  assert.match(pane, /intake\.executionOption &&/);
});

test('CONTROLLED: article discussion availability fails closed for pending, stopped, interrupted, and failed calls', () => {
  const success = { status: 'completed', exitCode: 0, signal: null };
  assert.equal(articleDiscussionBlock({ calls: [], pendingRun: false, intakeStatus: 'ready' }), null);
  assert.equal(articleDiscussionBlock({ calls: [success], pendingRun: false, intakeStatus: 'draft_ready' }), null);

  assert.deepEqual(articleDiscussionBlock({ calls: [success], pendingRun: true, intakeStatus: 'discussing' }), {
    code: 'model_call_running',
    reason: '本轮只读澄清正在运行或等待权威状态落盘；不能并行发送另一条消息。',
  });
  assert.equal(articleDiscussionBlock({ calls: [{ status: 'reserved' }], pendingRun: false, intakeStatus: 'waiting_reply' }).code, 'model_call_running');
  assert.equal(articleDiscussionBlock({ calls: [{ status: 'running' }], pendingRun: false, intakeStatus: 'waiting_reply' }).code, 'model_call_running');
  assert.equal(articleDiscussionBlock({ calls: [success], pendingRun: false, intakeStatus: 'stopped' }).code, 'intake_stopped');

  for (const call of [
    { status: 'completed', exitCode: 1, signal: null },
    { status: 'completed', exitCode: 0, signal: 'SIGKILL' },
    { status: 'failed', exitCode: 1, signal: null },
    { status: 'completed', signal: null },
    { status: 'completed', exitCode: 0 },
    null,
  ]) {
    const block = articleDiscussionBlock({ calls: [call], pendingRun: false, intakeStatus: 'waiting_reply' });
    assert.equal(block.code, 'model_call_failed');
    assert.match(block.reason, /不能使用表面剩余额度/);
  }

  assert.equal(describeArticleDiscussion({
    available: false, enabled: true, remaining: 1, deadlineAt: null, sealed: false,
    blockedBy: 'model_call_failed', reason: '上次模型调用失败或未完整结束；本批已停止，不能使用表面剩余额度继续发送。',
  }), '只读澄清不可用：上次模型调用失败或未完整结束；本批已停止，不能使用表面剩余额度继续发送。');
});

test('CONTROLLED: intake discussion stays draft until an explicit complete goal confirmation', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-intake-controlled-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const controller = await createIntakeController({ tasksRoot: path.join(root, 'tasks'), irixiAppRoot: IRIXI_APP_ROOT, taskId: 'task-intake-controlled' });
  const initial = await controller.read();
  assert.equal(initial.exists, false);

  const concept = 'I have an early project idea but have not confirmed the goal.';
  const message = await controller.beginMessage({ concept });
  assert.equal(message.displayPrompt, concept);
  assert.equal(message.prompt.startsWith(`${__test.INTAKE_TAG}\n`), true);
  await assert.rejects(controller.reserveRun({ sourceTaskId: 'native-intake-1', promptSha256: '0'.repeat(64) }), /not the current|不是当前/);
  await controller.reserveRun({ sourceTaskId: 'native-intake-1', promptSha256: message.promptSha256 });
  assert.equal((await controller.read()).pendingRun, true);
  await assert.rejects(controller.beginMessage({ concept: 'Do not overlap this message.' }), /不能并行/);

  const reply = 'DRAFT: clarify the intended reader, outcome, and content boundary. Explicit confirmation is still required.\n';
  const afterReply = await controller.recordReply({ sourceTaskId: 'native-intake-1', text: reply, resultSha256: sha256(reply) });
  assert.equal(afterReply.status, 'draft_ready');
  assert.equal(afterReply.goal.confirmed, false);
  assert.equal(afterReply.latestReply.text, reply);
  await assert.rejects(controller.recordReply({ sourceTaskId: 'native-intake-1', text: `${reply}changed`, resultSha256: sha256(`${reply}changed`) }), /不能写入不同回复/);
  const followup = await controller.beginMessage({ concept: 'Focus the next question on measurable learning outcomes.' });
  assert.equal(followup.projection.status, 'waiting_reply');
  assert.equal(followup.prompt.includes(concept), true);
  assert.equal(followup.prompt.includes(reply), true);
  assert.equal(followup.prompt.includes('not yet confirmed'), true);
  await controller.reserveRun({ sourceTaskId: 'native-intake-2', promptSha256: followup.promptSha256 });
  await assert.rejects(controller.confirmGoal({
    expectedGoalVersionId: afterReply.goal.id, statement: 'A complete goal', successCriteria: ['One measurable result'], boundaries: ['No code execution'],
  }), /尚未完成/);
  await controller.recordFailure({ sourceTaskId: 'native-intake-2', errorSha256: 'f'.repeat(64) });
  await assert.rejects(controller.confirmGoal({
    expectedGoalVersionId: 'old-goal', statement: 'A complete goal', successCriteria: ['One measurable result'], boundaries: ['No code execution'],
  }), /过期/);

  const confirmed = await controller.confirmGoal({
    expectedGoalVersionId: afterReply.goal.id,
    statement: 'Help a reader turn selected articles into a structured learning plan.',
    successCriteria: ['The user can review an outline and measurable learning checkpoints.'],
    boundaries: ['Discussion and goal confirmation only; no repository execution is authorized.'],
  });
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.goal.confirmed, true);
  assert.equal(confirmed.executionSupported, false);
  const stored = await controller.read();
  assert.equal(stored.goal.statement, confirmed.goal.statement);
  assert.equal(stored.nextStep.includes('另行授权'), true);
});

test('CONTROLLED: a confirmed general goal never becomes the fixed greeting scope without separate selection and authorization', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-intake-scope-controlled-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const tasksRoot = path.join(root, 'tasks');
  const toy = path.join(root, 'toy');
  await fs.mkdir(path.join(toy, 'src'), { recursive: true });
  await fs.mkdir(path.join(toy, 'checks'), { recursive: true });
  await fs.writeFile(path.join(toy, 'package.json'), '{"type":"module","scripts":{"test":"node --test checks/greeting.test.js"}}\n');
  await fs.writeFile(path.join(toy, 'src/greeting.js'), 'export function greeting(name) { return `Hello, ${name}`; }\n');
  await fs.writeFile(path.join(toy, 'checks/greeting.test.js'), `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { greeting } from '../src/greeting.js';\ntest('trim',()=>assert.equal(greeting('  Ada  '),'Hello, Ada!'));\ntest('blank',()=>assert.equal(greeting('   '),'Hello, friend!'));\n`);
  execFileSync('/usr/bin/git', ['init', '-q'], { cwd: toy });
  execFileSync('/usr/bin/git', ['config', 'user.email', 'controlled@example.invalid'], { cwd: toy });
  execFileSync('/usr/bin/git', ['config', 'user.name', 'Controlled Fixture'], { cwd: toy });
  execFileSync('/usr/bin/git', ['add', '.'], { cwd: toy });
  execFileSync('/usr/bin/git', ['commit', '-qm', 'controlled baseline'], { cwd: toy });
  const canonicalToy = await fs.realpath(toy);
  const taskId = 'task-intake-scope-controlled';
  const intake = await createIntakeController({ tasksRoot, irixiAppRoot: IRIXI_APP_ROOT, taskId });
  const message = await intake.beginMessage({ concept: 'I want to explore an article-learning product.' });
  await intake.reserveRun({ sourceTaskId: 'intake-scope-reply', promptSha256: message.promptSha256 });
  await intake.recordReply({ sourceTaskId: 'intake-scope-reply', text: 'Clarify the desired reader outcome.', resultSha256: sha256('Clarify the desired reader outcome.') });
  const confirmed = await intake.confirmGoal({
    expectedGoalVersionId: message.projection.goal.id,
    statement: 'Help a reader make a learning plan from selected articles.',
    successCriteria: ['The user can review learning checkpoints.'],
    boundaries: ['Discussion only; no repository is authorized.'],
  });
  const integration = await createIntegrationController({ tasksRoot, irixiAppRoot: IRIXI_APP_ROOT, toyRoot: canonicalToy, testOnlyRegisteredToyRoot: canonicalToy });
  assert.equal((await integration.store.get(taskId)).type, 'general');
  assert.equal((await integration.registeredScopeState(taskId)).selected, false);

  const selected = await integration.selectRegisteredScope(taskId, confirmed.goal.id);
  assert.equal(selected.scope.selected, true);
  assert.equal(selected.scope.authorized, false);
  assert.notEqual(selected.goal.id, confirmed.goal.id);
  assert.equal((await integration.store.get(taskId)).projectWorkspace, undefined);
  assert.equal((await intake.read()).latestReply.current, false);
  await assert.rejects(integration.authorizeRegisteredScope(taskId, confirmed.goal.id), /目标已变化/);

  await integration.authorizeRegisteredScope(taskId, selected.goal.id);
  const authorized = await integration.registeredScopeState(taskId);
  assert.equal(authorized.authorized, true);
  assert.equal(authorized.registeredExecution.prompt.includes('INTEGRATED_TOY_DEVELOPER_05'), true);
  assert.equal(authorized.registeredExecution.prompt.includes(`Irixi accepted goal version: ${selected.goal.id}`), true);
  const oldPrompt = authorized.registeredExecution.prompt;
  const authorizedTask = await integration.store.get(taskId);
  const board = projectTaskBoard(buildAuthorityProjection(authorizedTask, integration.helpers), []);
  assert.equal(board.goalVersionId, selected.goal.id);
  assert.equal(board.executionId, authorizedTask.execution.id);
  assert.equal(board.current, true);
  assert.notEqual(board.statusLabel, '目标已确认，但尚未授权执行');
  const restarted = await createIntegrationController({ tasksRoot, irixiAppRoot: IRIXI_APP_ROOT, toyRoot: canonicalToy, testOnlyRegisteredToyRoot: canonicalToy });
  assert.equal((await restarted.registeredScopeState(taskId)).authorized, true);
  await intake.confirmGoal({
    expectedGoalVersionId: selected.goal.id,
    statement: 'A newly changed discussion goal.', successCriteria: ['A different outcome.'], boundaries: ['No execution.'],
  });
  const stale = await restarted.registeredScopeState(taskId);
  assert.equal(stale.authorized, false);
  assert.equal(stale.registeredExecution, null);
  const newlySelected = await restarted.selectRegisteredScope(taskId, (await restarted.store.get(taskId)).goal.activeVersionId);
  await restarted.authorizeRegisteredScope(taskId, newlySelected.goal.id);
  const rebound = await restarted.registeredScopeState(taskId);
  assert.notEqual(rebound.registeredExecution.prompt, oldPrompt);
  assert.equal(rebound.registeredExecution.prompt.includes(`Irixi accepted goal version: ${newlySelected.goal.id}`), true);
});
