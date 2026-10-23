import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { codexRoleProcessTimeoutMs, OmoPilotController } from './server.mjs';
import { createFakeOmoRoleRunner } from './test-omo-runner.mjs';
import { buildCodexRoleInvocation } from '../app/codex-role-adapter.mjs';
import { buildUnifiedPatch, readRelativeFileMap, sha256Buffer, sha256Text } from './omo-harness.mjs';

test('Reviewer gets a bounded six-minute CLI window while Lead and Chat keep their limits', () => {
  assert.equal(codexRoleProcessTimeoutMs('Reviewer'), 360_000);
  assert.equal(codexRoleProcessTimeoutMs('Developer'), 360_000);
  assert.equal(codexRoleProcessTimeoutMs('Lead'), 60_000);
  assert.equal(codexRoleProcessTimeoutMs('Chat'), 30_000);
});

function candidateSha256ForTest(filesMap) {
  return sha256Text(Object.values(filesMap).sort((a, b) => a.path.localeCompare(b.path))
    .map((file) => `${file.path}:${file.sha256}`).join('|'));
}

async function fixturePatch(sourceRoot, candidateRoot, changedPaths) {
  const patch = buildUnifiedPatch(await readRelativeFileMap(sourceRoot), await readRelativeFileMap(candidateRoot), changedPaths);
  const diffSha256 = sha256Text(patch);
  return { patch, diffSha256, patchSha256: diffSha256 };
}

function makePlanInstructionSnapshotForTest(task, project) {
  const artifact = task.artifacts?.find((item) => item.id === task.activeArtifactId) || null;
  const body = {
    taskId: task.id,
    goalVersionId: task.goalVersionId,
    executionId: task.execution.id,
    registrySha256: task.registry?.registrySha256 || null,
    projectId: project.projectId,
    scopeFingerprint: project.scopeFingerprint,
    artifact: artifact ? {
      id: artifact.id, version: artifact.version,
      candidateSha256: artifact.candidateSha256, diffSha256: artifact.diffSha256,
    } : null,
    instructions: [],
  };
  return { ...body, sha256: sha256Text(JSON.stringify(body)) };
}

test('Codex role is durably reserved before CLI spawn and completed output replays without a second start', async (t) => {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-role-ledger-'));
  t.after(() => fs.rm(runtimeDir, { recursive: true, force: true }));
  let runnerCalls = 0;
  const codexRoleRunner = async (request) => {
    runnerCalls += 1;
    const roleInvocation = buildCodexRoleInvocation(request.role, request.prompt, request.executionMode);
    const invocationPromptSha256 = sha256Text(JSON.stringify(roleInvocation));
    assert.ok(request.idempotencyKey.endsWith(`:${invocationPromptSha256}`));
    const reservation = await request.reserve({
      role: request.role, binding: request.binding, idempotencyKey: request.idempotencyKey,
      deadlineAt: request.deadlineAt, maxCalls: 8,
      promptSha256: invocationPromptSha256,
      promptUtf8Bytes: Buffer.byteLength(roleInvocation.prompt, 'utf8') + Buffer.byteLength(roleInvocation.developerInstructions || '', 'utf8'),
    });
    assert.equal(reservation.created, true);
    const stored = JSON.parse(await fs.readFile(path.join(runtimeDir, 'pilot-ledger.json'), 'utf8'));
    const persisted = stored.tasks[0].execution.modelCalls[0];
    assert.equal(persisted.status, 'reserved');
    assert.equal(persisted.cliSpawned, false);

    await request.recordCliSpawn(reservation);
    await request.recordTurnStarted(reservation, { role: request.role, callOrdinal: 1 });
    const output = { text: '计划已形成。' };
    const workCompleted = await request.acceptResult(output, { role: request.role, binding: request.binding });
    await request.settle(reservation, {
      status: 'model_returned', workCompleted, cliSpawned: true, turnStarted: true,
      providerRequestCount: null, output,
    });
    return { status: 'model_returned', workCompleted, roleCallReserved: true, cliSpawned: true,
      turnStarted: true, providerRequestCount: null, output };
  };
  const controller = new OmoPilotController({ runtimeDir, codexRoleRunner, omoRoleRunner: createFakeOmoRoleRunner() });
  await controller.init();
  const task = {
    id: 'task-role-1', goalVersionId: 'goal-role-1', title: '测试调用账', statement: '验证预约先于调用',
    successCriteria: [], boundaries: [], instructions: [], artifacts: [],
    registry: { registrySha256: 'a'.repeat(64) },
    execution: {
      id: 'run-role-1', phase: 'planned', deadline: new Date(Date.now() + 60_000).toISOString(),
      leadAgentId: 'agent-lead', devAgentId: 'agent-dev', reviewerAgentId: 'agent-review',
      modelCalls: [], sessions: [], workItems: [], planApprovalStatus: 'not_ready',
    },
  };
  controller.state.tasks.push(task);
  controller.state.activeTaskId = task.id;
  await controller.save();

  const request = { role: 'Lead', workItemId: 'work-plan-run-role-1', phase: 'planning', prompt: 'synthetic prompt' };
  const first = await controller.runCodexProductRole(task, request);
  assert.equal(first.output.text, '计划已形成。');
  assert.equal(task.execution.modelCalls[0].callOrdinal, 1);
  assert.equal(task.execution.modelCalls[0].status, 'completed');
  assert.equal(task.execution.modelCalls[0].cliSpawned, true);
  assert.equal(task.execution.modelCalls[0].turnStarted, true);
  assert.equal(task.execution.modelCalls[0].providerRequestCount, null);
  assert.equal(task.execution.modelCalls[0].promptSha256, sha256Text(JSON.stringify(buildCodexRoleInvocation('Lead', request.prompt))));
  assert.equal(task.execution.modelCalls[0].promptUtf8Bytes, Buffer.byteLength(buildCodexRoleInvocation('Lead', request.prompt).prompt, 'utf8'));
  assert.equal(task.execution.modelCalls[0].output.text, '计划已形成。');
  assert.equal(task.execution.sessions[0].status, 'completed');

  const replay = await controller.runCodexProductRole(task, request);
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.output.text, '计划已形成。');
  assert.equal(runnerCalls, 1);
});

test('settled Developer CLI failure closes the current execution without retrying or losing the approved plan', async (t) => {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-developer-failure-settlement-'));
  t.after(() => fs.rm(runtimeDir, { recursive: true, force: true }));
  const deadline = new Date(Date.now() + 10 * 60_000).toISOString();
  let runnerCalls = 0;
  const codexRoleRunner = async (request) => {
    runnerCalls += 1;
    const detailedError = 'Command failed: node -e "PRIVATE_SCRIPT_FROM_ERROR"; stat:/PRIVATE_ABSOLUTE_PATH/file';
    const reservation = await request.reserve({
      role: request.role, binding: request.binding, idempotencyKey: request.idempotencyKey,
      deadlineAt: request.deadlineAt, maxCalls: 8,
    });
    assert.equal(reservation.created, true);
    await request.recordCliSpawn(reservation);
    await request.recordTurnStarted(reservation, { role: request.role, binding: request.binding, callOrdinal: reservation.callOrdinal });
    const error = 'exec_command could not create a local process';
    await request.settle(reservation, {
      status: 'cli_failed', workCompleted: false, cliSpawned: true, turnStarted: true, error,
      diagnostics: {
        cliPathExists: true, startupCwdExists: true, authorizedWorkspaceExists: true,
        toolExecutionTrace: 'observed', toolExecutionEventCount: 15,
        toolExecutions: Array.from({ length: 15 }, (_unused, index) => ({
          eventType: 'item.completed', itemId: `item-${index}`, toolType: 'command_execution',
          status: 'failed', exitCode: 2,
          errorSummary: detailedError,
          errorUtf8Bytes: Buffer.byteLength(detailedError, 'utf8'), errorSha256: sha256Text(detailedError),
          cwd: '../../PRIVATE_RELATIVE_CWD', cwdExists: false, workdir: 'PRIVATE_RELATIVE_WORKDIR', workdirExists: null,
          shell: 'zsh -c "PRIVATE_SHELL"', shellExists: true,
          commandExecutableHint: 'node;touch${IFS}PRIVATE_MARKER', commandUtf8Bytes: 120,
          commandSha256: 'a'.repeat(64),
        })),
      },
    });
    return { status: 'cli_failed', workCompleted: false, roleCallReserved: true, cliSpawned: true, turnStarted: true, error };
  };
  const controller = new OmoPilotController({ runtimeDir, codexRoleRunner, omoRoleRunner: createFakeOmoRoleRunner() });
  await controller.init();
  const project = { projectId: 'developer-failure-project', scopeFingerprint: 'developer-failure-scope', label: 'Synthetic', rootPath: runtimeDir, allowedWritePaths: ['index.html'] };
  controller.listRegisteredProjects = async () => [project];
  const task = {
    id: 'task-developer-failure', goalVersionId: 'goal-developer-failure', title: 'Developer failure settlement',
    statement: 'Preserve the approved plan and stop after a settled local execution failure.', successCriteria: [], boundaries: [],
    instructions: [], artifacts: [], conversations: [], memoryEntries: [],
    selectedScope: { authorized: true, current: true, projectId: project.projectId, scopeFingerprint: project.scopeFingerprint, goalVersionId: 'goal-developer-failure' },
    registry: { status: 'prepared', projectId: project.projectId, scopeFingerprint: project.scopeFingerprint, registrySha256: 'f'.repeat(64) },
    execution: {
      id: 'run-developer-failure', phase: 'executing', status: 'waiting_user', deadline, bindingCurrent: true,
      leadAgentId: 'lead-failure', devAgentId: 'developer-failure', reviewerAgentId: 'reviewer-failure',
      modelCalls: [{ id: 'lead-call-completed', role: 'Lead', status: 'completed', callOrdinal: 1 }],
      sessions: [], workItems: [], plan: { text: 'Approved plan retained.' }, planApprovalStatus: 'saved',
    },
  };
  controller.state.tasks.push(task);
  const workspacePath = path.join(controller.worktreesDir, task.id, task.execution.id);
  await fs.mkdir(workspacePath, { recursive: true });
  const originalDeadline = task.execution.deadline;

  await assert.rejects(controller.runCodexProductRole(task, {
    role: 'Developer', workItemId: 'work-dev-run-developer-failure', phase: 'implementation',
    prompt: 'Synthetic developer invocation.', workspacePath,
  }), /exec_command could not create a local process/u);

  assert.equal(task.execution.phase, 'partial');
  assert.equal(task.execution.status, 'waiting_user');
  assert.equal(task.execution.deadline, originalDeadline);
  assert.equal(task.execution.plan.text, 'Approved plan retained.');
  assert.deepEqual(task.execution.modelCalls.map((call) => [call.role, call.status]), [['Lead', 'completed'], ['Developer', 'failed']]);
  assert.equal(task.execution.sessions.at(-1).status, 'failed');
  assert.equal(task.execution.modelCalls[1].cliDiagnostics.toolExecutionTrace, 'observed');
  assert.equal(task.execution.modelCalls[1].cliDiagnostics.toolExecutionEventCount, 15);
  assert.equal(task.execution.modelCalls[1].cliDiagnostics.toolExecutions.length, 12);
  assert.equal(task.execution.modelCalls[1].cliDiagnostics.toolExecutions.at(-1).cwdExists, false);
  assert.equal(task.execution.modelCalls[1].cliDiagnostics.toolExecutions.at(-1).workdirExists, null);
  assert.equal(task.execution.modelCalls[1].cliDiagnostics.toolExecutions.at(-1).shellExists, true);
  assert.equal(task.execution.modelCalls[1].cliDiagnostics.toolExecutions.at(-1).errorSummary, 'error reported');
  assert.equal(task.execution.modelCalls[1].cliDiagnostics.toolExecutions.at(-1).errorUtf8Bytes, Buffer.byteLength('Command failed: node -e "PRIVATE_SCRIPT_FROM_ERROR"; stat:/PRIVATE_ABSOLUTE_PATH/file', 'utf8'));
  assert.equal(task.execution.modelCalls[1].cliDiagnostics.toolExecutions.at(-1).errorSha256, sha256Text('Command failed: node -e "PRIVATE_SCRIPT_FROM_ERROR"; stat:/PRIVATE_ABSOLUTE_PATH/file'));
  assert.equal(task.execution.modelCalls[1].cliDiagnostics.toolExecutions.at(-1).cwd, '[路径已隐藏]');
  assert.equal(task.execution.modelCalls[1].cliDiagnostics.toolExecutions.at(-1).workdir, '[路径已隐藏]');
  assert.equal(task.execution.modelCalls[1].cliDiagnostics.toolExecutions.at(-1).shell, null);
  assert.equal(task.execution.modelCalls[1].cliDiagnostics.toolExecutions.at(-1).commandExecutableHint, null);
  const serializedDiagnostics = JSON.stringify(task.execution.modelCalls[1].cliDiagnostics);
  assert.ok(Buffer.byteLength(serializedDiagnostics, 'utf8') < 16_384);
  for (const secret of ['secret-token-123456789', 'private-value', '/Users/alice', 'secret-work', 'PRIVATE_SCRIPT_FROM_ERROR', 'PRIVATE_ABSOLUTE_PATH', 'PRIVATE_RELATIVE_CWD', 'PRIVATE_RELATIVE_WORKDIR', 'PRIVATE_SHELL', 'PRIVATE_MARKER']) {
    assert.equal(serializedDiagnostics.includes(secret), false);
  }
  assert.equal(task.artifacts.length, 0);
  assert.equal(runnerCalls, 1, 'a settled failed Developer call is not automatically retried or followed by Reviewer');
});

test('repeated prepare reuses every live phase without resetting its deadline or call ledger', async (t) => {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-prepare-reuse-'));
  t.after(() => fs.rm(runtimeDir, { recursive: true, force: true }));
  const controller = new OmoPilotController({ runtimeDir, preferLocalFallback: true });
  await controller.init();
  const project = { projectId: 'project-one', scopeFingerprint: 'scope-one', label: 'Synthetic', rootPath: runtimeDir, allowedWritePaths: ['index.html'] };
  controller.listRegisteredProjects = async () => [project];
  for (const [index, phase] of ['planned', 'awaiting_plan_approval', 'executing', 'completed', 'partial'].entries()) {
    const deadline = new Date(Date.now() + 10 * 60_000).toISOString();
    const executionId = `run-existing-${phase}`;
    const task = {
      id: `task-prepare-reuse-${index}`, goalVersionId: 'goal-one',
      selectedScope: { authorized: true, projectId: project.projectId, scopeFingerprint: project.scopeFingerprint, goalVersionId: 'goal-one' },
      registry: { projectId: project.projectId, scopeFingerprint: project.scopeFingerprint, registrySha256: String(index).repeat(64) },
      execution: {
        id: executionId, phase, deadline, bindingCurrent: true,
        plan: phase === 'awaiting_plan_approval' ? { text: 'synthetic plan', sha256: 'p'.repeat(64) } : null,
        planApprovalStatus: phase === 'awaiting_plan_approval' ? 'not_persisted' : 'not_ready',
        modelCalls: [{ id: `call-${phase}`, status: 'completed', callOrdinal: 1 }], stopReason: null,
      },
    };
    controller.state.tasks.push(task);
    const before = structuredClone(task.execution);
    const result = await controller.handleTaskAction(task.id, { action: 'prepare_run' });
    assert.equal(result.reused, true, phase);
    assert.equal(task.execution.id, executionId, phase);
    assert.equal(task.execution.deadline, deadline, phase);
    assert.deepEqual(task.execution.modelCalls, before.modelCalls, phase);
    assert.deepEqual(task.execution.plan, before.plan, phase);
    assert.equal(task.executionHistory, undefined, phase);
  }
});

test('prepare rejects while any persisted role reservation is still unsettled', async (t) => {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-prepare-inflight-'));
  t.after(() => fs.rm(runtimeDir, { recursive: true, force: true }));
  const controller = new OmoPilotController({ runtimeDir, preferLocalFallback: true });
  await controller.init();
  const project = { projectId: 'project-one', scopeFingerprint: 'scope-one', label: 'Synthetic', rootPath: runtimeDir, allowedWritePaths: ['index.html'] };
  controller.listRegisteredProjects = async () => [project];
  const task = {
    id: 'task-prepare-inflight', goalVersionId: 'goal-one', selectedScope: { authorized: true, projectId: project.projectId, scopeFingerprint: project.scopeFingerprint, goalVersionId: 'goal-one' },
    registry: { projectId: project.projectId, scopeFingerprint: project.scopeFingerprint, registrySha256: 'c'.repeat(64) },
    execution: { id: 'run-active', phase: 'executing', deadline: new Date(Date.now() + 60_000).toISOString(), modelCalls: [{ id: 'call-live', status: 'reserved' }] },
  };
  controller.state.tasks.push(task);
  await assert.rejects(
    controller.handleTaskAction(task.id, { action: 'prepare_run' }),
    (error) => error.code === 'EXECUTION_CALL_IN_FLIGHT' && error.statusCode === 409,
  );
  assert.equal(task.execution.id, 'run-active');
  assert.equal(task.execution.modelCalls[0].status, 'reserved');
  assert.equal(task.executionHistory, undefined);
});

test('a settled expired execution is archived before a new prepared execution replaces it', async (t) => {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-prepare-history-'));
  t.after(() => fs.rm(runtimeDir, { recursive: true, force: true }));
  const controller = new OmoPilotController({ runtimeDir, preferLocalFallback: true });
  await controller.init();
  const project = { projectId: 'project-one', scopeFingerprint: 'scope-one', label: 'Synthetic', rootPath: runtimeDir, allowedWritePaths: ['index.html'] };
  controller.listRegisteredProjects = async () => [project];
  const task = {
    id: 'task-prepare-history', goalVersionId: 'goal-one', setupStatus: 'ready_to_run',
    selectedScope: { authorized: true, projectId: project.projectId, scopeFingerprint: project.scopeFingerprint, goalVersionId: 'goal-one' },
    registry: { projectId: project.projectId, scopeFingerprint: project.scopeFingerprint, registrySha256: 'b'.repeat(64) },
    execution: { id: 'run-expired', phase: 'failed', deadline: new Date(Date.now() - 1_000).toISOString(), modelCalls: [{ id: 'call-failed', status: 'failed', callOrdinal: 1 }], stopReason: 'execution_deadline_elapsed' },
  };
  controller.state.tasks.push(task);
  const oldDeadline = task.execution.deadline;
  await assert.rejects(controller.handleTaskAction(task.id, { action: 'prepare_run' }),
    (error) => error.code === 'EXECUTION_REQUIRES_EXPLICIT_NEW_RUN' && error.statusCode === 409);
  assert.equal(task.execution.id, 'run-expired');
  assert.equal(task.executionHistory, undefined);
  const result = await controller.handleTaskAction(task.id, { action: 'prepare_run', mode: 'new_execution' });
  assert.equal(result.ok, true);
  assert.notEqual(task.execution.id, 'run-expired');
  assert.equal(task.execution.modelCalls.length, 0);
  assert.equal(task.executionHistory.length, 1);
  assert.equal(task.executionHistory[0].execution.id, 'run-expired');
  assert.equal(task.executionHistory[0].execution.deadline, oldDeadline);
  assert.equal(task.executionHistory[0].execution.modelCalls[0].id, 'call-failed');
});

test('chat request IDs replay the saved reply and reject changed content under the same ID', async (t) => {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-chat-idempotency-'));
  t.after(() => fs.rm(runtimeDir, { recursive: true, force: true }));
  const controller = new OmoPilotController({ runtimeDir, preferLocalFallback: true });
  await controller.init();
  const task = {
    id: 'task-chat-idempotency', goalVersionId: 'goal-one', title: 'Synthetic', statement: 'Read-only progress discussion',
    successCriteria: [], boundaries: [], artifacts: [], conversations: [], memoryEntries: [],
    execution: { leadAgentId: 'lead-one', modelCalls: [], workItems: [], sessions: [] },
  };
  controller.state.tasks.push(task);
  const payload = { action: 'chat', requestId: 'chat-request-1', text: 'What is the current status?', agentId: 'lead-one' };
  const first = await controller.handleTaskAction(task.id, payload);
  const countAfterFirst = task.conversations.length;
  const replay = await controller.handleTaskAction(task.id, payload);
  assert.equal(replay.idempotentReplay, true);
  assert.equal(task.conversations.length, countAfterFirst);
  await assert.rejects(
    controller.handleTaskAction(task.id, { ...payload, text: 'A different question' }),
    (error) => error.code === 'REQUEST_ID_REUSED_WITH_DIFFERENT_INPUT' && error.statusCode === 409,
  );
  assert.equal(task.conversations.filter((item) => item.requestId === 'chat-request-1').length, 2);
  assert.ok(first.ok);
});

test('synthetic Lead approval to automatic Reviewer completes one candidate with three durable role starts', async (t) => {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-qa-positive-flow-'));
  const projectRoot = path.join(runtimeDir, 'project');
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.writeFile(path.join(projectRoot, 'index.html'), '<!doctype html><html><body>before</body></html>');
  t.after(() => fs.rm(runtimeDir, { recursive: true, force: true }));

  const project = { projectId: 'project-positive', scopeFingerprint: 'scope-positive', label: 'Synthetic', rootPath: projectRoot, allowedWritePaths: ['index.html'] };
  const calls = [];
  let reviewerPrompt = '';
  const codexRoleRunner = async (request) => {
    const reservation = await request.reserve({
      role: request.role, binding: request.binding, idempotencyKey: request.idempotencyKey,
      deadlineAt: request.deadlineAt, maxCalls: 8,
    });
    assert.equal(reservation.created, true, `${request.role} reservation`);
    calls.push({ role: request.role, binding: structuredClone(request.binding), reservationId: reservation.id });
    await request.recordCliSpawn(reservation);
    await request.recordTurnStarted(reservation, { role: request.role, binding: request.binding, callOrdinal: reservation.callOrdinal });
    let output;
    if (request.role === 'Lead') output = { text: 'Plan: update the authorized HTML fixture and run Host checks.' };
    else if (request.role === 'Developer') {
      await fs.writeFile(path.join(request.workspacePath, 'index.html'), '<!doctype html><html><body>after</body></html>');
      output = { text: 'Updated the authorized fixture.' };
    } else {
      reviewerPrompt = request.prompt;
      output = { text: 'VERDICT: PASS\nThe complete scoped candidate and checks were reviewed.' };
    }
    const workCompleted = await request.acceptResult(output, { role: request.role, binding: request.binding });
    await request.settle(reservation, {
      status: workCompleted ? 'model_returned' : 'host_validation_failed', workCompleted,
      cliSpawned: true, turnStarted: true, providerRequestCount: null, output,
      ...(workCompleted ? {} : { error: 'synthetic binding mismatch' }),
    });
    return {
      status: workCompleted ? 'model_returned' : 'host_validation_failed', workCompleted,
      roleCallReserved: true, cliSpawned: true, turnStarted: true, providerRequestCount: null, output,
    };
  };
  const controller = new OmoPilotController({ runtimeDir, codexRoleRunner, omoRoleRunner: createFakeOmoRoleRunner() });
  await controller.init();
  controller.modelStatus = () => ({ liveExecutionBlocked: false });
  controller.listRegisteredProjects = async () => [project];
  const task = {
    id: 'task-positive-flow', goalVersionId: 'goal-positive', title: 'Synthetic review flow',
    statement: 'Update one authorized fixture and review its full candidate.', successCriteria: ['The changed page contains the update.'],
    boundaries: ['Only index.html may change.'], instructions: [], rejectionHistory: [], artifacts: [], conversations: [], memoryEntries: [],
    selectedScope: { authorized: true, projectId: project.projectId, scopeFingerprint: project.scopeFingerprint, goalVersionId: 'goal-positive' },
    registry: { status: 'prepared', projectId: project.projectId, scopeFingerprint: project.scopeFingerprint, registrySha256: 'e'.repeat(64) },
    execution: {
      id: 'run-positive', phase: 'planned', status: 'waiting_start', bindingCurrent: true,
      deadline: new Date(Date.now() + 10 * 60_000).toISOString(), limits: { maxModelCalls: 8 },
      leadAgentId: 'lead-positive', devAgentId: 'dev-positive', reviewerAgentId: 'reviewer-positive',
      modelCalls: [], sessions: [], workItems: [], plan: null, planApprovalStatus: 'not_ready',
      reviewContinuation: { authorized: false, status: 'disabled', maxModelCalls: 1 },
    },
  };
  controller.state.tasks.push(task);
  controller.state.activeTaskId = task.id;

  await controller.handleTaskAction(task.id, { action: 'run' });
  assert.equal(task.execution.phase, 'awaiting_plan_approval');
  await controller.handleTaskAction(task.id, {
    action: 'approve_plan', expectedPlanSha256: task.execution.plan.sha256,
    expectedInstructionSnapshotSha256: task.execution.plan.instructionSnapshot.sha256,
  });

  assert.deepEqual(calls.map((call) => call.role), ['Lead', 'Developer', 'Reviewer'], JSON.stringify({ modelCalls: task.execution.modelCalls, workItems: task.execution.workItems, check: task.artifacts[0]?.hostCheck }));
  assert.equal(task.execution.modelCalls.length, 3);
  assert.ok(task.execution.modelCalls.every((call) => call.status === 'completed'));
  assert.equal(task.artifacts.length, 1);
  assert.equal(task.artifacts[0].review.nativeVerdict, 'PASS');
  assert.ok(!/0%/.test(task.artifacts[0].review.summary));
  assert.equal(task.artifacts[0].hostCheck.passed, true);
  assert.equal(task.execution.pendingCandidateBinding, undefined);
  assert.equal(calls[2].binding.artifactId, task.artifacts[0].id);
  assert.equal(calls[2].binding.candidateSha256, task.artifacts[0].candidateSha256);
  assert.ok(!reviewerPrompt.includes('<body>after</body>'));
  assert.ok(reviewerPrompt.includes('完整差异文件'));
  assert.ok(reviewerPrompt.includes('候选源码目录'));
  assert.ok(reviewerPrompt.includes(task.artifacts[0].candidateSha256));
});

test('正式退回仅在同一有效执行内复制旧候选并以新身份续改，再自动审阅新候选', async (t) => {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-revision-continuation-'));
  t.after(() => fs.rm(runtimeDir, { recursive: true, force: true }));
  const projectRoot = path.join(runtimeDir, 'project');
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.writeFile(path.join(projectRoot, 'index.html'), '<!doctype html><html><body>baseline</body></html>');
  const deadline = new Date(Date.now() + 10 * 60_000).toISOString();
  const project = { projectId: 'project-revision', scopeFingerprint: 'scope-revision', label: 'Synthetic', rootPath: projectRoot, allowedWritePaths: ['index.html'] };
  const controller = new OmoPilotController({ runtimeDir, omoRoleRunner: createFakeOmoRoleRunner() });
  await controller.init();
  controller.modelStatus = () => ({ liveExecutionBlocked: false });
  controller.listRegisteredProjects = async () => [project];
  const taskId = 'task-revision-continuation';
  const executionId = 'run-revision-continuation';
  const goalVersionId = 'goal-revision-continuation';
  const registrySha256 = 'e'.repeat(64);
  const oldWorkspace = path.join(controller.worktreesDir, taskId, executionId);
  await fs.mkdir(oldWorkspace, { recursive: true });
  const oldHtml = '<!doctype html><html><body>previous candidate</body></html>';
  await fs.writeFile(path.join(oldWorkspace, 'index.html'), oldHtml);
  const oldSourceFiles = await readRelativeFileMap(oldWorkspace);
  const oldCandidateSha = candidateSha256ForTest(oldSourceFiles);
  const oldPatch = await fixturePatch(projectRoot, oldWorkspace, ['index.html']);
  const oldReview = { id: 'review-old', passed: false, nativeVerdict: 'UNVERIFIED', fullOutputSha256: sha256Text('old report'), text: 'Preserve this report.', sourceEvidence: null };
  const oldArtifact = {
    id: 'artifact-old', version: 1, goalVersionId, executionId, registrySha256,
    worktreePath: oldWorkspace, candidateSha256: oldCandidateSha, ...oldPatch,
    files: Object.values(oldSourceFiles).map(({ path: relPath, sha256, bytes }) => ({ path: relPath, sha256, bytes })),
    changedFiles: [{ path: 'index.html', bytes: oldSourceFiles['index.html'].bytes, sha256: oldSourceFiles['index.html'].sha256 }],
    hostCheck: { passed: false, checks: [{ id: 'scope', passed: false, detail: 'Synthetic Host stop.' }] },
    review: structuredClone(oldReview), confirmation: null,
  };
  const task = {
    id: taskId, goalVersionId, title: 'Same-run revision fixture', statement: 'Update the authorized page.',
    successCriteria: ['The next candidate contains the requested update.'], boundaries: ['Only index.html may change.'],
    instructions: [], rejectionHistory: [], artifacts: [oldArtifact], activeArtifactId: oldArtifact.id,
    conversations: [], memoryEntries: [],
    selectedScope: { authorized: true, current: true, projectId: project.projectId, scopeFingerprint: project.scopeFingerprint, goalVersionId },
    registry: { status: 'prepared', projectId: project.projectId, scopeFingerprint: project.scopeFingerprint, registrySha256 },
    execution: {
      id: executionId, phase: 'partial', status: 'waiting_user', bindingCurrent: true,
      deadline, limits: { maxModelCalls: 8 }, leadAgentId: 'lead-revision', devAgentId: 'dev-revision', reviewerAgentId: 'review-revision',
      plan: { text: 'Keep the authorized page structure and make the requested change.', sha256: sha256Text('approved plan') },
      planApprovalStatus: 'saved', stopReason: null,
      modelCalls: [
        { id: 'call-lead-old', role: 'Lead', status: 'completed', outcome: 'model_returned', callOrdinal: 1, cliSpawned: true, turnStarted: true },
        { id: 'call-dev-old', role: 'Developer', status: 'completed', outcome: 'model_returned', callOrdinal: 2, cliSpawned: true, turnStarted: true,
          binding: { taskId, goalVersionId, executionId, registrySha256, workItemId: `work-dev-${executionId}`, artifactId: null, candidateSha256: null } },
      ],
      sessions: [], workItems: [], requestFingerprints: {},
      reviewContinuation: { authorized: true, status: 'blocked_host_checks', maxModelCalls: 1 },
    },
  };
  task.execution.plan.instructionSnapshot = makePlanInstructionSnapshotForTest(task, project);
  const oldPreviewToken = `omo-preview-${taskId}-1`;
  task.preview = { status: 'ready', token: oldPreviewToken, worktreePath: oldWorkspace, artifactId: oldArtifact.id, artifactVersion: oldArtifact.version, candidateSha256: oldCandidateSha };
  controller.previewTokens.set(oldPreviewToken, { taskId, worktreePath: oldWorkspace });
  controller.state.tasks.push(task);

  const bindingInput = {
    expectedGoalVersionId: goalVersionId, expectedExecutionId: executionId,
    expectedRegistrySha256: registrySha256, expectedScopeFingerprint: project.scopeFingerprint,
    expectedArtifactId: oldArtifact.id, expectedArtifactVersion: oldArtifact.version,
    expectedCandidateSha256: oldCandidateSha,
  };
  const revisePayload = { action: 'revise', requestId: 'revise-request-1', ...bindingInput, reason: 'Update the visible page heading.' };
  for (const [field, staleValue] of [
    ['goalVersionId', 'old-goal'], ['executionId', 'old-execution'], ['registrySha256', '0'.repeat(64)],
  ]) {
    const currentValue = oldArtifact[field];
    oldArtifact[field] = staleValue;
    const before = JSON.stringify(task);
    await assert.rejects(controller.handleTaskAction(task.id, { ...revisePayload, requestId: `stale-${field}` }),
      (error) => error.code === 'REVISION_BINDING_STALE');
    assert.equal(JSON.stringify(task), before, `stale source ${field} must be rejected before saving a revision`);
    oldArtifact[field] = currentValue;
  }
  await assert.rejects(controller.handleTaskAction(task.id, {
    ...revisePayload, expectedCandidateSha256: 'f'.repeat(64),
  }), (error) => error.code === 'REVISION_BINDING_STALE');
  assert.equal(task.rejectionHistory.length, 0, 'a stale candidate CAS has no rejection or fingerprint side effect');
  assert.deepEqual(task.execution.requestFingerprints, {});
  const revisionResult = await controller.handleTaskAction(task.id, revisePayload);
  assert.equal(revisionResult.canContinue, true);
  assert.equal(task.execution.phase, 'partial', 'formal return does not replay or reset the approved execution');
  assert.equal(task.execution.modelCalls.length, 2);
  assert.deepEqual(task.artifacts[0].review, oldReview);
  assert.equal((await fs.readFile(path.join(oldWorkspace, 'index.html'), 'utf8')), oldHtml);
  for (const [field, staleValue] of [
    ['goalVersionId', 'old-goal'], ['executionId', 'old-execution'], ['registrySha256', '0'.repeat(64)], ['version', oldArtifact.version + 1],
  ]) {
    const currentValue = oldArtifact[field];
    oldArtifact[field] = staleValue;
    const projection = await controller.buildProductState(task.id);
    assert.notEqual(projection.native?.actions.canContinue, true, `stale source ${field} closes the UI gate`);
    const before = JSON.stringify(task);
    await assert.rejects(controller.handleTaskAction(task.id, {
      action: 'continue', revisionId: revisionResult.revisionId, ...bindingInput,
    }));
    assert.equal(JSON.stringify(task), before, `stale source ${field} cannot mutate continuation state`);
    const priorRevisionStatus = task.execution.pendingRevision.status;
    const priorPhase = task.execution.phase;
    task.execution.pendingRevision.status = 'running';
    task.execution.phase = 'executing';
    const approveBefore = JSON.stringify(task);
    await assert.rejects(controller.handleTaskAction(task.id, {
      action: 'approve_plan', expectedPlanSha256: task.execution.plan.sha256,
      expectedInstructionSnapshotSha256: task.execution.plan.instructionSnapshot.sha256,
      continuationRevisionId: revisionResult.revisionId,
    }), (error) => error.code === 'REVISION_BINDING_STALE', `approve_plan rejects stale source ${field}`);
    assert.equal(JSON.stringify(task), approveBefore, `approve_plan rejects stale source ${field} before creating state or a directory`);
    task.execution.pendingRevision.status = priorRevisionStatus;
    task.execution.phase = priorPhase;
    oldArtifact[field] = currentValue;
  }
  const replayRevision = await controller.handleTaskAction(task.id, revisePayload);
  assert.equal(replayRevision.idempotentReplay, true);
  assert.equal(task.rejectionHistory.length, 1);
  await assert.rejects(controller.handleTaskAction(task.id, { ...revisePayload, reason: 'Changed under the same request ID.' }),
    (error) => error.code === 'REQUEST_ID_REUSED_WITH_DIFFERENT_INPUT');

  let reviewerBinding = null;
  const roleCalls = [];
  let developerRuns = 0;
  controller.codexRoleRunner = async (request) => {
    roleCalls.push(request.role);
    const invocation = buildCodexRoleInvocation(request.role, request.prompt, request.executionMode);
    const reservation = await request.reserve({
      role: request.role, binding: request.binding, idempotencyKey: request.idempotencyKey,
      deadlineAt: request.deadlineAt, maxCalls: 8,
      promptSha256: sha256Text(JSON.stringify(invocation)),
      promptUtf8Bytes: Buffer.byteLength(invocation.prompt, 'utf8') + Buffer.byteLength(invocation.developerInstructions || '', 'utf8'),
    });
    assert.equal(reservation.created, true);
    await request.recordCliSpawn(reservation);
    await request.recordTurnStarted(reservation, { role: request.role, binding: request.binding, callOrdinal: reservation.callOrdinal });
    let output;
    if (request.role === 'Developer') {
      developerRuns += 1;
      assert.equal(request.binding.workItemId, task.execution.pendingRevision.workItemId);
      if (developerRuns === 1) {
        assert.equal(request.binding.artifactId, oldArtifact.id, 'the first revision worker is bound to its exact source candidate');
        assert.equal(request.binding.candidateSha256, oldCandidateSha);
      } else {
        assert.equal(request.binding.artifactId, task.artifacts[1].id);
        assert.equal(request.binding.candidateSha256, task.artifacts[1].candidateSha256);
      }
      if (developerRuns > 1) {
        await fs.writeFile(path.join(request.workspacePath, 'index.html'), '<!doctype html><html><body>revised candidate</body></html>');
      }
      output = { text: developerRuns > 1 ? 'Updated the requested page in the second revision worktree.' : 'The first correction attempt made no file change.' };
    } else {
      reviewerBinding = structuredClone(request.binding);
      output = { text: 'VERDICT: PASS\nThe revised complete candidate and fixed checks passed review.' };
    }
    const workCompleted = await request.acceptResult(output, { role: request.role, binding: request.binding });
    assert.equal(workCompleted, true);
    await request.settle(reservation, { status: 'model_returned', workCompleted, cliSpawned: true, turnStarted: true, providerRequestCount: null, output });
    return { status: 'model_returned', workCompleted, roleCallReserved: true, cliSpawned: true, turnStarted: true, providerRequestCount: null, output };
  };

  const continuePayload = {
    action: 'continue', revisionId: revisionResult.revisionId, ...bindingInput,
  };
  const firstContinuation = await controller.handleTaskAction(task.id, continuePayload);
  assert.deepEqual(roleCalls, ['Developer']);
  assert.equal(task.execution.phase, 'partial');
  assert.equal(task.execution.pendingRevision.status, 'completed');
  assert.equal(task.artifacts.length, 2);
  const secondArtifact = task.artifacts[1];
  const secondArtifactFiles = await readRelativeFileMap(secondArtifact.worktreePath);
  assert.notEqual(path.dirname(secondArtifact.worktreePath), oldWorkspace);
  assert.equal(path.dirname(secondArtifact.worktreePath), path.join(controller.worktreesDir, taskId, `${executionId}-revisions`));
  assert.deepEqual(await readRelativeFileMap(oldWorkspace), oldSourceFiles, 'the old candidate full file set stays byte-identical');
  assert.equal(candidateSha256ForTest(await readRelativeFileMap(oldWorkspace)), oldCandidateSha);
  assert.deepEqual(controller.previewTokens.get(oldPreviewToken), { taskId, worktreePath: oldWorkspace }, 'the prior preview continues to address the immutable source candidate');

  const secondBindingInput = {
    expectedGoalVersionId: goalVersionId, expectedExecutionId: executionId,
    expectedRegistrySha256: registrySha256, expectedScopeFingerprint: project.scopeFingerprint,
    expectedArtifactId: secondArtifact.id, expectedArtifactVersion: secondArtifact.version,
    expectedCandidateSha256: secondArtifact.candidateSha256,
  };
  const secondRevision = await controller.handleTaskAction(task.id, {
    action: 'revise', requestId: 'revise-request-2', ...secondBindingInput, reason: 'Apply the requested heading update to this exact candidate.',
  });
  assert.equal(secondRevision.canContinue, true);
  const continueSecond = await controller.handleTaskAction(task.id, {
    action: 'continue', revisionId: secondRevision.revisionId, ...secondBindingInput,
  });
  assert.deepEqual(roleCalls, ['Developer', 'Developer', 'Reviewer'], JSON.stringify({
    roleCalls, checks: task.artifacts.map((artifact) => artifact.hostCheck), reviews: task.artifacts.map((artifact) => artifact.review.nativeVerdict),
    pendingCandidateBinding: task.execution.pendingCandidateBinding,
  }));
  assert.equal(task.execution.id, executionId);
  assert.equal(task.execution.deadline, deadline);
  assert.equal(task.execution.modelCalls.length, 5);
  assert.equal(task.execution.phase, 'completed');
  assert.equal(task.execution.pendingRevision.status, 'completed');
  assert.equal(task.artifacts.length, 3);
  assert.equal(task.artifacts[0].id, oldArtifact.id);
  assert.deepEqual(task.artifacts[0].review, oldReview);
  assert.deepEqual(await readRelativeFileMap(oldWorkspace), oldSourceFiles);
  assert.deepEqual(await readRelativeFileMap(secondArtifact.worktreePath), secondArtifactFiles, 'the prior revision candidate remains byte-identical');
  assert.equal(candidateSha256ForTest(await readRelativeFileMap(secondArtifact.worktreePath)), secondArtifact.candidateSha256);
  assert.equal(task.artifacts[1].version, 2);
  assert.equal(task.artifacts[1].hostCheck.passed, false);
  assert.equal(task.artifacts[1].review.nativeVerdict, 'UNVERIFIED');
  assert.equal(task.artifacts[2].version, 3);
  assert.equal(task.artifacts[2].hostCheck.passed, true);
  assert.equal(task.artifacts[2].review.nativeVerdict, 'PASS');
  assert.equal(task.artifacts[2].confirmation, null);
  assert.notEqual(task.artifacts[2].worktreePath, task.artifacts[1].worktreePath);
  assert.equal(path.dirname(task.artifacts[2].worktreePath), path.dirname(task.artifacts[1].worktreePath));
  assert.equal(path.dirname(task.artifacts[2].worktreePath), path.join(controller.worktreesDir, taskId, `${executionId}-revisions`));
  assert.equal((await fs.readFile(path.join(oldWorkspace, 'index.html'), 'utf8')), oldHtml);
  assert.equal(reviewerBinding.artifactId, task.artifacts[2].id);
  assert.equal(reviewerBinding.candidateSha256, task.artifacts[2].candidateSha256);
  assert.equal(firstContinuation.artifactId, task.artifacts[1].id);
  assert.equal(continueSecond.artifactId, task.artifacts[2].id);
  const replayContinue = await controller.handleTaskAction(task.id, {
    action: 'continue', revisionId: secondRevision.revisionId, ...secondBindingInput,
  });
  assert.equal(replayContinue.idempotentReplay, true);
  assert.deepEqual(roleCalls, ['Developer', 'Developer', 'Reviewer'], 'the same revision identity never starts a second model call');
});

test('正式退回以原始字节继承含二进制资源的候选，并在Developer前校验', async (t) => {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-revision-binary-copy-'));
  t.after(() => fs.rm(runtimeDir, { recursive: true, force: true }));
  const projectRoot = path.join(runtimeDir, 'project');
  await fs.mkdir(projectRoot, { recursive: true });
  const project = { projectId: 'project-binary-revision', scopeFingerprint: 'scope-binary-revision', label: 'Synthetic', rootPath: projectRoot, allowedWritePaths: ['index.html'] };
  const deadline = new Date(Date.now() + 10 * 60_000).toISOString();
  const controller = new OmoPilotController({ runtimeDir, omoRoleRunner: createFakeOmoRoleRunner() });
  await controller.init();
  controller.modelStatus = () => ({ liveExecutionBlocked: false });
  controller.listRegisteredProjects = async () => [project];
  const taskId = 'task-binary-revision'; const executionId = 'run-binary-revision'; const goalVersionId = 'goal-binary-revision';
  const registrySha256 = 'd'.repeat(64);
  const workspacePath = path.join(controller.worktreesDir, taskId, executionId);
  await fs.mkdir(path.join(workspacePath, 'assets'), { recursive: true });
  await fs.mkdir(path.join(projectRoot, 'assets'), { recursive: true });
  const sourceHtml = '<!doctype html><html><body>baseline</body></html>';
  await fs.writeFile(path.join(projectRoot, 'index.html'), sourceHtml);
  await fs.writeFile(path.join(workspacePath, 'index.html'), '<!doctype html><html><body>old</body></html>');
  const binarySource = Buffer.from([0, 255, 254, 128, 137, 80, 78, 71]);
  await fs.writeFile(path.join(projectRoot, 'assets/image.bin'), binarySource);
  await fs.writeFile(path.join(workspacePath, 'assets/image.bin'), binarySource);
  const sourceFiles = await readRelativeFileMap(workspacePath);
  const sourceSha = candidateSha256ForTest(sourceFiles);
  const sourcePatch = await fixturePatch(projectRoot, workspacePath, ['index.html']);
  const artifact = {
    id: 'artifact-binary-source', version: 1, goalVersionId, executionId, registrySha256, worktreePath: workspacePath,
    candidateSha256: sourceSha, ...sourcePatch,
    files: Object.values(sourceFiles).map(({ path: relPath, bytes, sha256 }) => ({ path: relPath, bytes, sha256 })),
    changedFiles: [{ path: 'index.html', bytes: sourceFiles['index.html'].bytes, sha256: sourceFiles['index.html'].sha256 }],
    confirmation: null, review: { id: 'review-binary-old', nativeVerdict: 'UNVERIFIED' },
    hostCheck: { passed: false, checks: [{ id: 'scope', passed: false, detail: 'synthetic stop' }] },
  };
  const task = {
    id: taskId, goalVersionId, title: 'Binary candidate copy', statement: 'Preserve candidate bytes before a revision.',
    successCriteria: ['The binary resource is byte-identical in the new workspace.'], boundaries: ['Only index.html may change.'],
    instructions: [], rejectionHistory: [], artifacts: [artifact], activeArtifactId: artifact.id, conversations: [], memoryEntries: [],
    selectedScope: { authorized: true, current: true, projectId: project.projectId, scopeFingerprint: project.scopeFingerprint, goalVersionId },
    registry: { status: 'prepared', projectId: project.projectId, scopeFingerprint: project.scopeFingerprint, registrySha256 },
    execution: {
      id: executionId, phase: 'partial', status: 'waiting_user', bindingCurrent: true, deadline,
      limits: { maxModelCalls: 8 }, leadAgentId: 'lead-binary', devAgentId: 'dev-binary', reviewerAgentId: 'review-binary',
      plan: { text: 'Change only the fixture HTML.', sha256: sha256Text('Change only the fixture HTML.') },
      planApprovalStatus: 'saved', stopReason: null,
      modelCalls: [
        { id: 'lead-binary-old', role: 'Lead', status: 'completed', outcome: 'model_returned', callOrdinal: 1, cliSpawned: true, turnStarted: true },
        { id: 'dev-binary-old', role: 'Developer', status: 'completed', outcome: 'model_returned', callOrdinal: 2, cliSpawned: true, turnStarted: true },
      ],
      sessions: [], workItems: [], requestFingerprints: {}, reviewContinuation: { authorized: false, status: 'disabled' },
    },
  };
  task.execution.plan.instructionSnapshot = makePlanInstructionSnapshotForTest(task, project);
  controller.state.tasks.push(task);
  const binding = {
    expectedGoalVersionId: goalVersionId, expectedExecutionId: executionId, expectedRegistrySha256: registrySha256,
    expectedScopeFingerprint: project.scopeFingerprint, expectedArtifactId: artifact.id,
    expectedArtifactVersion: artifact.version, expectedCandidateSha256: sourceSha,
  };
  const returned = await controller.handleTaskAction(taskId, { action: 'revise', requestId: 'revise-binary', ...binding, reason: 'Keep binary bytes exact.' });
  let developerWorkspace;
  const roles = [];
  controller.codexRoleRunner = async (request) => {
    roles.push(request.role);
    assert.ok(['Developer', 'Reviewer'].includes(request.role));
    if (request.role === 'Reviewer') {
      // Reviewer receives an exact byte snapshot; it must not claim a binary candidate is fully verified.
      assert.deepEqual(await fs.readFile(path.join(request.workspacePath, 'assets/image.bin')), binarySource);
      const reservation = await request.reserve({ role: request.role, binding: request.binding, idempotencyKey: request.idempotencyKey,
        deadlineAt: request.deadlineAt, maxCalls: 8 });
      assert.equal(reservation.created, true);
      await request.recordCliSpawn(reservation); await request.recordTurnStarted(reservation, { role: request.role, binding: request.binding });
      const output = { text: 'VERDICT: UNVERIFIED\nBinary resource cannot be reviewed semantically.' };
      const workCompleted = await request.acceptResult(output, { role: request.role, binding: request.binding });
      await request.settle(reservation, { status: 'model_returned', workCompleted, cliSpawned: true, turnStarted: true, output });
      return { status: 'model_returned', workCompleted, roleCallReserved: true, cliSpawned: true, turnStarted: true, output };
    }
    developerWorkspace = request.workspacePath;
    assert.deepEqual(await fs.readFile(path.join(developerWorkspace, 'assets/image.bin')), binarySource);
    const invocation = buildCodexRoleInvocation(request.role, request.prompt, request.executionMode);
    const reservation = await request.reserve({ role: request.role, binding: request.binding, idempotencyKey: request.idempotencyKey,
      deadlineAt: request.deadlineAt, maxCalls: 8, promptSha256: sha256Text(JSON.stringify(invocation)),
      promptUtf8Bytes: Buffer.byteLength(invocation.prompt, 'utf8') + Buffer.byteLength(invocation.developerInstructions || '', 'utf8') });
    assert.equal(reservation.created, true);
    await request.recordCliSpawn(reservation); await request.recordTurnStarted(reservation, { role: request.role, binding: request.binding });
    await fs.writeFile(path.join(developerWorkspace, 'index.html'), '<!doctype html><html><body>new</body></html>');
    const output = { text: 'The authorized HTML fixture was updated.' };
    const workCompleted = await request.acceptResult(output, { role: request.role, binding: request.binding });
    await request.settle(reservation, { status: 'model_returned', workCompleted, cliSpawned: true, turnStarted: true, output });
    return { status: 'model_returned', workCompleted, roleCallReserved: true, cliSpawned: true, turnStarted: true, output };
  };
  const result = await controller.handleTaskAction(taskId, { action: 'continue', revisionId: returned.revisionId, ...binding });
  assert.deepEqual(roles, ['Developer', 'Reviewer']);
  assert.deepEqual(await fs.readFile(path.join(developerWorkspace, 'assets/image.bin')), binarySource);
  assert.equal(task.artifacts[1].hostCheck.passed, true);
  assert.equal(task.artifacts[1].confirmation, null);
  assert.equal(result.artifactId, task.artifacts[1].id);
});

test('在途退回不落账；过期、失败、取消、预算耗尽或范围变化均不能继续', async (t) => {
  const cases = [
    ['expired', { deadline: new Date(Date.now() - 1_000).toISOString() }],
    ['model-failed', { failedDeveloper: true }],
    ['completed-call-tool-error', { toolError: true }],
    ['cancelled', { stopReason: 'cancelled_by_user' }],
    ['cancel-during-copy-stop-reason', { cancelDuringCopy: 'reason' }],
    ['cancel-during-copy-phase', { cancelDuringCopy: 'phase' }],
    ['budget-exhausted', { callCount: 8 }],
    ['scope-changed-after-return', { mutateScopeAfterReturn: true }],
    ['duplicate-manifest-path', { duplicateManifest: true }],
    ['unmanifested-source-file', { extraFile: true }],
    ['source-changed-during-read', { mutateDuringRead: true }],
    ['in-flight', { inFlight: true }],
  ];
  for (const [name, override] of cases) {
    const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), `irixi-revision-block-${name}-`));
    t.after(() => fs.rm(runtimeDir, { recursive: true, force: true }));
    const project = { projectId: `project-${name}`, scopeFingerprint: `scope-${name}`, label: 'Synthetic', rootPath: runtimeDir, allowedWritePaths: ['index.html'] };
    const controller = new OmoPilotController({ runtimeDir });
    await controller.init();
    controller.listRegisteredProjects = async () => [project];
    const taskId = `task-${name}`;
    const executionId = `run-${name}`;
    const goalVersionId = `goal-${name}`;
    const registrySha256 = name[0].repeat(64);
    const workspacePath = path.join(controller.worktreesDir, taskId, executionId);
    await fs.mkdir(workspacePath, { recursive: true });
    const html = '<!doctype html><html><body>source</body></html>';
    await fs.writeFile(path.join(runtimeDir, 'index.html'), '<!doctype html><html><body>baseline</body></html>');
    await fs.writeFile(path.join(workspacePath, 'index.html'), html);
    const candidatePatch = await fixturePatch(runtimeDir, workspacePath, ['index.html']);
    if (override.extraFile) await fs.writeFile(path.join(workspacePath, 'unlisted.txt'), 'not in manifest');
    const fileSha = sha256Buffer(Buffer.from(html));
    const candidateSha = sha256Text(`index.html:${fileSha}`);
    const artifact = {
      id: `artifact-${name}`, version: 1, goalVersionId, executionId, registrySha256,
      worktreePath: workspacePath, candidateSha256: candidateSha, ...candidatePatch,
      files: [{ path: 'index.html', sha256: fileSha, bytes: Buffer.byteLength(html) }],
      changedFiles: [{ path: 'index.html', sha256: fileSha, bytes: Buffer.byteLength(html) }],
      hostCheck: { passed: false, checks: [{ id: 'scope', passed: false, detail: 'stopped' }] },
      review: { id: `review-${name}`, nativeVerdict: 'UNVERIFIED', text: 'Preserved historical review.' }, confirmation: null,
    };
    if (override.duplicateManifest) artifact.files = [structuredClone(artifact.files[0]), structuredClone(artifact.files[0])];
    const baseCalls = Array.from({ length: override.callCount === 8 ? 7 : 1 }, (_, index) => ({
      id: `call-lead-${name}-${index}`, role: 'Lead', status: 'completed', outcome: 'model_returned', callOrdinal: index + 1,
      cliSpawned: true, turnStarted: true,
    }));
    baseCalls.push({ id: `call-dev-${name}`, role: 'Developer', status: override.failedDeveloper ? 'failed' : 'completed',
      outcome: override.failedDeveloper ? 'cli_failed' : 'model_returned', callOrdinal: baseCalls.length + 1,
      cliSpawned: true, turnStarted: true, cliDiagnostics: { toolExecutions: override.failedDeveloper
        ? [{ status: 'failed' }]
        : override.toolError ? [{ status: 'completed', exitCode: 1, errorSummary: 'tool reported an error', errorUtf8Bytes: 20 }] : [] } });
    if (override.inFlight) baseCalls.push({ id: `call-running-${name}`, role: 'Developer', status: 'running', callOrdinal: baseCalls.length + 1 });
    const task = {
      id: taskId, goalVersionId, title: 'blocked continuation fixture', statement: 'synthetic', successCriteria: [], boundaries: [],
      instructions: [], rejectionHistory: [], artifacts: [artifact], activeArtifactId: artifact.id, conversations: [], memoryEntries: [],
      selectedScope: { authorized: true, current: true, projectId: project.projectId, scopeFingerprint: project.scopeFingerprint, goalVersionId },
      registry: { status: 'prepared', projectId: project.projectId, scopeFingerprint: project.scopeFingerprint, registrySha256 },
      execution: {
        id: executionId, phase: 'partial', status: 'waiting_user', bindingCurrent: true,
        deadline: override.deadline || new Date(Date.now() + 60_000).toISOString(),
        limits: { maxModelCalls: 8 }, leadAgentId: 'lead', devAgentId: 'dev', reviewerAgentId: 'reviewer',
        plan: { text: 'approved', sha256: sha256Text('plan') }, planApprovalStatus: 'saved',
        stopReason: override.stopReason || null, modelCalls: baseCalls, sessions: [], workItems: [], requestFingerprints: {},
      },
    };
    task.execution.plan.instructionSnapshot = makePlanInstructionSnapshotForTest(task, project);
    controller.state.tasks.push(task);
    const bindingInput = {
      expectedGoalVersionId: goalVersionId, expectedExecutionId: executionId,
      expectedRegistrySha256: registrySha256, expectedScopeFingerprint: project.scopeFingerprint,
      expectedArtifactId: artifact.id, expectedArtifactVersion: artifact.version, expectedCandidateSha256: candidateSha,
    };
    const reviseInput = { action: 'revise', requestId: `request-${name}`, ...bindingInput, reason: 'Synthetic formal return.' };
    if (override.inFlight) {
      const before = structuredClone({ modelCalls: task.execution.modelCalls, rejectionHistory: task.rejectionHistory,
        requestFingerprints: task.execution.requestFingerprints, pendingRevision: task.execution.pendingRevision });
      await assert.rejects(controller.handleTaskAction(taskId, reviseInput), (error) => error.code === 'REVISION_ALREADY_IN_FLIGHT', name);
      assert.deepEqual({ modelCalls: task.execution.modelCalls, rejectionHistory: task.rejectionHistory,
        requestFingerprints: task.execution.requestFingerprints, pendingRevision: task.execution.pendingRevision }, before, name);
      continue;
    }
    const returned = await controller.handleTaskAction(taskId, reviseInput);
    assert.equal(returned.canContinue, Boolean(override.mutateScopeAfterReturn || override.mutateDuringRead || override.extraFile || override.cancelDuringCopy), name);
    if (override.mutateScopeAfterReturn) task.selectedScope.scopeFingerprint = 'changed-scope';
    const callsBefore = structuredClone(task.execution.modelCalls);
    const reviewBefore = structuredClone(task.artifacts[0].review);
    const candidateFile = path.join(workspacePath, 'index.html');
    const originalReadFile = fs.readFile;
    const originalWriteFile = fs.writeFile;
    let candidateReads = 0;
    let copiedRevisionFile = false;
    if (override.mutateDuringRead) {
      fs.readFile = async function (filePath, ...args) {
        const contents = await originalReadFile.call(fs, filePath, ...args);
        if (path.resolve(String(filePath)) === candidateFile && ++candidateReads === 2) {
          await originalWriteFile.call(fs, candidateFile, '<!doctype html><html><body>changed during read</body></html>');
        }
        return contents;
      };
    }
    if (override.cancelDuringCopy) {
      fs.writeFile = async function (filePath, ...args) {
        const result = await originalWriteFile.call(fs, filePath, ...args);
        const resolved = path.resolve(String(filePath));
        if (!copiedRevisionFile && resolved.startsWith(path.resolve(controller.worktreesDir, task.id, `${executionId}-revisions`, returned.revisionId) + path.sep)) {
          copiedRevisionFile = true;
          if (override.cancelDuringCopy === 'reason') task.execution.stopReason = 'user_cancelled';
          else { task.execution.phase = 'cancelled'; task.execution.status = 'cancelled'; }
        }
        return result;
      };
    }
    try {
      await assert.rejects(controller.handleTaskAction(taskId, {
        action: 'continue', revisionId: returned.revisionId, ...bindingInput,
      }), (error) => error.code === (override.mutateDuringRead || override.extraFile ? 'REVISION_SOURCE_CHANGED' : 'REVISION_CONTINUATION_UNAVAILABLE'));
    } finally {
      if (override.mutateDuringRead) fs.readFile = originalReadFile;
      if (override.cancelDuringCopy) fs.writeFile = originalWriteFile;
    }
    assert.deepEqual(task.execution.modelCalls, callsBefore, name);
    assert.deepEqual(task.artifacts[0].review, reviewBefore, name);
    assert.equal(task.artifacts.length, 1, name);
    if (override.duplicateManifest || override.extraFile || override.mutateDuringRead) {
      const revisionWorkspacePath = path.join(controller.worktreesDir, task.id, `${executionId}-revisions`, returned.revisionId);
      await assert.rejects(fs.stat(revisionWorkspacePath), { code: 'ENOENT' }, 'invalid or changing source creates no Developer workspace');
    }
    if (override.mutateDuringRead) assert.equal(candidateReads, 3, 'source mutation during byte capture is detected by the final source read');
    if (override.cancelDuringCopy) {
      assert.equal(copiedRevisionFile, true, name);
      assert.deepEqual(task.execution.modelCalls, callsBefore, 'no model call is reserved while cancellation races with copy');
      assert.equal(task.execution.pendingRevision.status, 'failed', name);
      assert.notEqual(task.execution.phase, 'partial', 'cancellation is not overwritten as ordinary partial work');
      assert.notEqual(task.execution.status, 'waiting_user', 'cancellation is not overwritten as a normal waiting state');
      if (override.cancelDuringCopy === 'reason') {
        assert.equal(task.execution.stopReason, 'user_cancelled');
        assert.equal(task.execution.phase, 'cancelled');
        assert.equal(task.execution.status, 'cancelled');
      } else {
        assert.equal(task.execution.phase, 'cancelled');
        assert.equal(task.execution.status, 'cancelled');
        assert.equal(task.execution.stopReason, null);
      }
      assert.equal(task.artifacts.length, 1, 'no artifact is adopted after the cancellation race');
      assert.deepEqual(task.artifacts[0].review, reviewBefore, 'historical review remains unchanged');
      const reservation = await controller.reserveCodexRoleStart(task, {
        role: 'Developer', binding: { taskId, goalVersionId, executionId, registrySha256, workItemId: 'work-dev-stopped' },
        idempotencyKey: `stopped-${name}`, deadlineAt: task.execution.deadline, maxCalls: 8,
      });
      assert.deepEqual(reservation, { created: false, reason: 'execution_stopped' }, 'final reservation gate rejects stopped executions');
      assert.deepEqual(task.execution.modelCalls, callsBefore, 'direct reservation rejection leaves call ledger unchanged');
      const revisionWorkspacePath = path.join(controller.worktreesDir, task.id, `${executionId}-revisions`, returned.revisionId);
      await assert.rejects(fs.stat(revisionWorkspacePath), { code: 'ENOENT' }, 'partial copied workspace is removed');
    }
  }
});

test('a late Lead plan after goal replacement is retained as invalidated and never adopted', async (t) => {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-stale-lead-'));
  t.after(() => fs.rm(runtimeDir, { recursive: true, force: true }));
  let controller;
  const codexRoleRunner = async (request) => {
    const reservation = await request.reserve({
      role: request.role, binding: request.binding, idempotencyKey: request.idempotencyKey,
      deadlineAt: request.deadlineAt, maxCalls: 8,
    });
    assert.equal(reservation.created, true);
    await request.recordCliSpawn(reservation);
    await request.recordTurnStarted(reservation, { role: request.role, binding: request.binding, callOrdinal: reservation.callOrdinal });
    const output = { text: 'Late plan for the prior goal.' };
    const workCompleted = await request.acceptResult(output, { role: request.role, binding: request.binding });
    assert.equal(workCompleted, true, 'the result was valid at initial acceptance');
    await request.settle(reservation, { status: 'model_returned', workCompleted: true, cliSpawned: true, turnStarted: true, output });
    controller.state.tasks[0].goalVersionId = 'goal-replaced';
    return { status: 'model_returned', workCompleted: true, roleCallReserved: true, cliSpawned: true, turnStarted: true, output };
  };
  controller = new OmoPilotController({ runtimeDir, codexRoleRunner, omoRoleRunner: createFakeOmoRoleRunner() });
  await controller.init();
  controller.modelStatus = () => ({ liveExecutionBlocked: false });
  const project = { projectId: 'project-stale', scopeFingerprint: 'scope-stale', label: 'Synthetic', rootPath: runtimeDir, allowedWritePaths: ['index.html'] };
  controller.listRegisteredProjects = async () => [project];
  const task = {
    id: 'task-stale-lead', goalVersionId: 'goal-original', title: 'Stale plan', statement: 'Original goal',
    successCriteria: [], boundaries: [], instructions: [], rejectionHistory: [], artifacts: [],
    registry: { projectId: project.projectId, scopeFingerprint: project.scopeFingerprint, registrySha256: 'f'.repeat(64) },
    execution: {
      id: 'run-stale-lead', phase: 'planned', deadline: new Date(Date.now() + 60_000).toISOString(),
      leadAgentId: 'lead', devAgentId: 'developer', reviewerAgentId: 'reviewer', modelCalls: [], sessions: [], workItems: [],
    },
  };
  controller.state.tasks.push(task);
  await assert.rejects(controller.handleTaskAction(task.id, { action: 'run' }), (error) => error.code === 'STALE_ROLE_BINDING');
  const call = task.execution.modelCalls[0];
  assert.equal(call.status, 'failed');
  assert.equal(call.outcome, 'stale_binding');
  assert.equal(call.output.text, 'Late plan for the prior goal.');
  assert.match(call.invalidationReason, /目标版本已变化/u);
  assert.equal(task.execution.plan, undefined);
  assert.equal(task.execution.stopReason, 'stale_binding');
});

test('late Developer and Reviewer results are invalidated in their original call ledger', async (t) => {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-stale-workers-'));
  t.after(() => fs.rm(runtimeDir, { recursive: true, force: true }));
  let controller;
  const codexRoleRunner = async (request) => {
    const reservation = await request.reserve({
      role: request.role, binding: request.binding, idempotencyKey: request.idempotencyKey,
      deadlineAt: request.deadlineAt, maxCalls: 8,
    });
    assert.equal(reservation.created, true, `${request.role} reservation: ${JSON.stringify(reservation)}`);
    await request.recordCliSpawn(reservation);
    await request.recordTurnStarted(reservation, { role: request.role, binding: request.binding, callOrdinal: reservation.callOrdinal });
    const output = { text: request.role === 'Reviewer' ? 'VERDICT: PASS\nLate review.' : 'Late source edit result.' };
    controller.state.tasks[0].goalVersionId = `goal-replaced-${request.role}`;
    const workCompleted = await request.acceptResult(output, { role: request.role, binding: request.binding });
    assert.equal(workCompleted, false, `${request.role} must reject a result after goal replacement`);
    await request.settle(reservation, { status: 'host_validation_failed', workCompleted: false, cliSpawned: true, turnStarted: true, output, error: 'stale binding' });
    return { status: 'host_validation_failed', workCompleted: false, roleCallReserved: true, cliSpawned: true, turnStarted: true, output };
  };
  controller = new OmoPilotController({ runtimeDir, codexRoleRunner, omoRoleRunner: createFakeOmoRoleRunner() });
  await controller.init();
  const task = {
    id: 'task-stale-workers', goalVersionId: 'goal-workers', title: 'Stale worker results', statement: 'Original goal',
    registry: { registrySha256: '1'.repeat(64) }, artifacts: [],
    execution: {
      id: 'run-stale-workers', phase: 'executing', planApprovalStatus: 'saved',
      deadline: new Date(Date.now() + 60_000).toISOString(), leadAgentId: 'lead', devAgentId: 'developer', reviewerAgentId: 'reviewer',
      modelCalls: [], sessions: [], workItems: [],
    },
  };
  controller.state.tasks.push(task);
  const workspacePath = path.join(controller.worktreesDir, task.id, task.execution.id);
  await fs.mkdir(workspacePath, { recursive: true });
  await fs.writeFile(path.join(workspacePath, 'index.html'), '<!doctype html><html><body>candidate</body></html>');
  const staleReviewerFiles = await readRelativeFileMap(workspacePath);
  const staleReviewerCandidateSha = candidateSha256ForTest(staleReviewerFiles);
  const staleReviewerPatch = buildUnifiedPatch({}, staleReviewerFiles, ['index.html']);
  const staleReviewerDiffSha = sha256Text(staleReviewerPatch);
  for (const role of ['Developer', 'Reviewer']) {
    task.execution.phase = 'executing';
    task.execution.status = 'running';
    task.execution.stopReason = null;
    task.execution.bindingCurrent = true;
    task.goalVersionId = 'goal-workers';
    const artifact = role === 'Reviewer' ? {
      id: 'artifact-stale-review', goalVersionId: 'goal-workers', executionId: task.execution.id,
      registrySha256: task.registry.registrySha256, candidateSha256: staleReviewerCandidateSha,
      diffSha256: staleReviewerDiffSha, patchSha256: staleReviewerDiffSha, patch: staleReviewerPatch,
      files: Object.values(staleReviewerFiles).map(({ path: relPath, bytes, sha256 }) => ({ path: relPath, bytes, sha256 })),
      changedFiles: Object.values(staleReviewerFiles).map(({ path: relPath, bytes, sha256 }) => ({ path: relPath, bytes, sha256 })),
      hostCheck: { passed: true },
    } : null;
    if (artifact) task.execution.pendingCandidateBinding = {
      artifactId: artifact.id, goalVersionId: artifact.goalVersionId, executionId: artifact.executionId,
      registrySha256: artifact.registrySha256, candidateSha256: artifact.candidateSha256,
      diffSha256: artifact.diffSha256,
    };
    const before = task.execution.modelCalls.length;
    await assert.rejects(controller.runCodexProductRole(task, {
      role, workItemId: role === 'Developer' ? `work-dev-${task.execution.id}` : `work-${role.toLowerCase()}`, phase: role.toLowerCase(), prompt: 'synthetic stale-result test',
      workspacePath: role === 'Developer' ? workspacePath : null, artifact,
    }), (error) => error.code === 'STALE_ROLE_BINDING');
    const call = task.execution.modelCalls[before];
    assert.equal(call.role, role);
    assert.equal(call.status, 'failed');
    assert.equal(call.outcome, 'stale_binding');
    assert.ok(call.output.text);
    assert.match(call.invalidationReason, /目标版本已变化/u);
    if (artifact) delete task.execution.pendingCandidateBinding;
  }
});

test('goal change during Developer Host checks prevents the candidate from being captured', async (t) => {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-stale-dev-host-'));
  const projectRoot = path.join(runtimeDir, 'project');
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.writeFile(path.join(projectRoot, 'index.html'), '<!doctype html><html><body>before</body></html>');
  t.after(() => fs.rm(runtimeDir, { recursive: true, force: true }));
  const project = { projectId: 'project-dev-host', scopeFingerprint: 'scope-dev-host', label: 'Synthetic', rootPath: projectRoot, allowedWritePaths: ['index.html'] };
  let task;
  let controller;
  let mutateOnNextRead = false;
  const originalReaddir = fs.readdir;
  fs.readdir = async (...args) => {
    const result = await originalReaddir(...args);
    if (mutateOnNextRead) {
      mutateOnNextRead = false;
      task.goalVersionId = 'goal-changed-during-host-check';
    }
    return result;
  };
  t.after(() => { fs.readdir = originalReaddir; });
  const codexRoleRunner = async (request) => {
    const reservation = await request.reserve({ role: request.role, binding: request.binding, idempotencyKey: request.idempotencyKey, deadlineAt: request.deadlineAt, maxCalls: 8 });
    assert.equal(reservation.created, true);
    await request.recordCliSpawn(reservation);
    await request.recordTurnStarted(reservation, { role: request.role, binding: request.binding, callOrdinal: reservation.callOrdinal });
    const output = { text: request.role === 'Lead' ? 'Plan the authorized HTML edit.' : 'Developer updated index.html.' };
    if (request.role === 'Developer') await fs.writeFile(path.join(request.workspacePath, 'index.html'), '<!doctype html><html><body>after</body></html>');
    const workCompleted = await request.acceptResult(output, { role: request.role, binding: request.binding });
    await request.settle(reservation, { status: workCompleted ? 'model_returned' : 'host_validation_failed', workCompleted, cliSpawned: true, turnStarted: true, output });
    if (request.role === 'Developer') mutateOnNextRead = true;
    return { status: workCompleted ? 'model_returned' : 'host_validation_failed', workCompleted, roleCallReserved: true, cliSpawned: true, turnStarted: true, output };
  };
  controller = new OmoPilotController({ runtimeDir, codexRoleRunner, omoRoleRunner: createFakeOmoRoleRunner() });
  await controller.init();
  controller.modelStatus = () => ({ liveExecutionBlocked: false });
  controller.listRegisteredProjects = async () => [project];
  task = {
    id: 'task-stale-dev-host', goalVersionId: 'goal-dev-host', title: 'Developer host race', statement: 'Update the authorized HTML fixture.',
    successCriteria: [], boundaries: ['Only index.html may change.'], instructions: [], rejectionHistory: [], artifacts: [],
    registry: { projectId: project.projectId, scopeFingerprint: project.scopeFingerprint, registrySha256: '3'.repeat(64) },
    execution: {
      id: 'run-stale-dev-host', phase: 'planned', deadline: new Date(Date.now() + 60_000).toISOString(),
      leadAgentId: 'lead', devAgentId: 'developer', reviewerAgentId: 'reviewer', modelCalls: [], sessions: [], workItems: [],
      planApprovalStatus: 'not_ready',
    },
  };
  task.selectedScope = {
    authorized: true, current: true, projectId: project.projectId,
    scopeFingerprint: project.scopeFingerprint, goalVersionId: task.goalVersionId,
  };
  controller.state.tasks.push(task);
  await controller.handleTaskAction(task.id, { action: 'run' });
  await assert.rejects(controller.handleTaskAction(task.id, {
    action: 'approve_plan', expectedPlanSha256: task.execution.plan.sha256,
    expectedInstructionSnapshotSha256: task.execution.plan.instructionSnapshot.sha256,
  }),
    (error) => error.code === 'STALE_ROLE_BINDING');
  assert.equal(task.artifacts.length, 0);
  assert.deepEqual(task.execution.modelCalls.map((call) => call.role), ['Lead', 'Developer']);
  const developerCall = task.execution.modelCalls[1];
  assert.equal(developerCall.status, 'failed');
  assert.equal(developerCall.output.text, 'Developer updated index.html.');
  assert.match(developerCall.invalidationReason, /目标版本已变化/u);
});

test('goal change after Reviewer role return prevents review verdict from replacing the saved candidate review', async (t) => {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-stale-review-adopt-'));
  const projectRoot = path.join(runtimeDir, 'project');
  const candidateRoot = path.join(runtimeDir, 'candidate');
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.mkdir(candidateRoot, { recursive: true });
  const source = '<!doctype html><html><body>before</body></html>';
  const candidate = '<!doctype html><html><body>candidate</body></html>';
  await fs.writeFile(path.join(projectRoot, 'index.html'), source);
  await fs.writeFile(path.join(candidateRoot, 'index.html'), candidate);
  t.after(() => fs.rm(runtimeDir, { recursive: true, force: true }));
  const project = { projectId: 'project-review-adopt', scopeFingerprint: 'scope-review-adopt', label: 'Synthetic', rootPath: projectRoot, allowedWritePaths: ['index.html'] };
  const fileSha256 = sha256Buffer(Buffer.from(candidate));
  const candidateSha256 = sha256Text(`index.html:${fileSha256}`);
  const candidatePatch = await fixturePatch(projectRoot, candidateRoot, ['index.html']);
  const artifact = {
    id: 'artifact-review-adopt', version: 1, goalVersionId: 'goal-review-adopt', executionId: 'run-review-adopt',
    registrySha256: '4'.repeat(64), worktreePath: candidateRoot, candidateSha256,
    ...candidatePatch, changedFiles: [{ path: 'index.html', bytes: Buffer.byteLength(candidate), sha256: fileSha256 }],
    hostCheck: { passed: true }, confirmation: null,
    review: { id: 'review-old', passed: false, nativeVerdict: 'FAIL', scopeOutcome: 'failed', text: 'Original FAIL remains.', fullOutputSha256: '6'.repeat(64) },
  };
  const originalReview = structuredClone(artifact.review);
  let task;
  const codexRoleRunner = async (request) => {
    const reservation = await request.reserve({ role: request.role, binding: request.binding, idempotencyKey: request.idempotencyKey, deadlineAt: request.deadlineAt, maxCalls: 8 });
    assert.equal(reservation.created, true);
    await request.recordCliSpawn(reservation);
    await request.recordTurnStarted(reservation, { role: request.role, binding: request.binding, callOrdinal: reservation.callOrdinal });
    const output = { text: 'VERDICT: PASS\nSynthetic late review.' };
    const workCompleted = await request.acceptResult(output, { role: request.role, binding: request.binding });
    await request.settle(reservation, { status: workCompleted ? 'model_returned' : 'host_validation_failed', workCompleted, cliSpawned: true, turnStarted: true, output });
    return { status: workCompleted ? 'model_returned' : 'host_validation_failed', workCompleted, roleCallReserved: true, cliSpawned: true, turnStarted: true, output };
  };
  const controller = new OmoPilotController({ runtimeDir, codexRoleRunner, omoRoleRunner: createFakeOmoRoleRunner() });
  await controller.init();
  controller.modelStatus = () => ({ liveExecutionBlocked: false });
  controller.listRegisteredProjects = async () => [project];
  task = {
    id: 'task-stale-review-adopt', goalVersionId: 'goal-review-adopt', title: 'Reviewer adoption race', statement: 'Review the current candidate.',
    successCriteria: [], boundaries: [], artifacts: [artifact], activeArtifactId: artifact.id, conversations: [], memoryEntries: [],
    registry: { projectId: project.projectId, scopeFingerprint: project.scopeFingerprint, registrySha256: artifact.registrySha256 },
    execution: {
      id: artifact.executionId, phase: 'partial', deadline: new Date(Date.now() + 60_000).toISOString(),
      leadAgentId: 'lead', devAgentId: 'developer', reviewerAgentId: 'reviewer', modelCalls: [], sessions: [], workItems: [],
    },
  };
  controller.state.tasks.push(task);
  const originalRunCodexProductRole = controller.runCodexProductRole.bind(controller);
  controller.runCodexProductRole = async (...args) => {
    const result = await originalRunCodexProductRole(...args);
    task.goalVersionId = 'goal-changed-after-review-return';
    return result;
  };
  await assert.rejects(controller.handleTaskAction(task.id, { action: 'review', requestId: 'review-race-1' }),
    (error) => error.code === 'STALE_ROLE_BINDING');
  assert.deepEqual(artifact.review, originalReview);
  assert.equal(task.execution.modelCalls.length, 1);
  assert.equal(task.execution.modelCalls[0].role, 'Reviewer');
  assert.equal(task.execution.modelCalls[0].status, 'failed');
  assert.equal(task.execution.modelCalls[0].output.text, 'VERDICT: PASS\nSynthetic late review.');
  assert.match(task.execution.modelCalls[0].invalidationReason, /目标版本已变化/u);
});
