import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { __test as adapterTest, buildCodexRoleInvocation, buildCodexRolePrompt, CODEX_ROLE_MODEL, CODEX_ROLE_REASONING_EFFORT, effectiveCodexProcessTimeoutMs, resolveCodexRuntime, runCodexRole } from '../codex-role-adapter.mjs';
import { buildCodexDecisionPrompt, parseCodexDecisionOutput } from '../../omo-pilot/codex-provider-protocol.mjs';

const binding = Object.freeze({
  taskId: 'task-synthetic', goalVersionId: 'goal-synthetic', executionId: 'run-synthetic',
  registrySha256: 'a'.repeat(64), workItemId: 'review-work', artifactId: 'artifact-synthetic', candidateSha256: 'b'.repeat(64),
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-codex-adapter-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const nativeHome = path.join(root, 'native-runtime-home');
  const realUserHome = path.join(root, 'real-user-home');
  const workspacePath = path.join(root, 'qa-worktree');
  await fs.mkdir(workspacePath);
  const executable = path.join(root, 'fake-codex.mjs');
  await fs.writeFile(executable, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
const get = (name) => args[args.indexOf(name) + 1];
const required = ['--json', '--ephemeral', '--ignore-user-config', '--ignore-rules'];
const developerConfig = args.find((arg) => arg.startsWith('developer_instructions=')) || '';
const providerDecision = Boolean(developerConfig);
const providerInstructions = providerDecision ? JSON.parse(developerConfig.slice('developer_instructions='.length)) : '';
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const taskMarker = '--- BEGIN ROLE TASK ---\\n';
const taskStart = prompt.indexOf(taskMarker);
const hostIdentity = providerDecision ? providerInstructions : taskStart < 0 ? '' : prompt.slice(0, taskStart);
const taskPrompt = taskStart < 0 ? prompt : prompt.slice(taskStart + taskMarker.length).split('\\n--- END ROLE TASK ---', 1)[0];
const developer = hostIdentity.includes('Authoritative host-selected role: Developer');
const providerDeveloper = hostIdentity.includes('Authoritative host-selected role: Developer');
const disabled = ['unified_exec', 'apps', 'plugins', 'multi_agent', 'mcp_2026_07_28', 'skill_mcp_dependency_install'];
const good = required.every((flag) => args.includes(flag))
  && get('--model') === 'gpt-6-luna' && get('--sandbox') === (providerDecision ? 'read-only' : developer ? 'workspace-write' : 'read-only')
  && (providerDecision || hostIdentity.includes('IRIXI CODEX HOST ROLE V1'))
  && hostIdentity.includes('Authoritative host-selected model: gpt-6-luna')
  && hostIdentity.includes('Authoritative reasoning effort: medium')
  && hostIdentity.includes('Do not search for, install, or launch another CLI, model, provider, or subagent.')
  && args.some((arg, index) => arg === '-c' && args[index + 1] === 'model_reasoning_effort="medium"')
  && args.some((arg, index) => arg === '-c' && args[index + 1] === 'mcp_servers={}')
  && disabled.every((flag) => args.some((arg, index) => arg === '--disable' && args[index + 1] === flag))
  && (providerDecision
    ? providerDeveloper && hostIdentity.includes('OmO remains the sole agent harness')
      && hostIdentity.includes('Do not attempt CLI-native shell, filesystem, code-mode, MCP, browser, or other tool execution')
      && !hostIdentity.includes('Use only tools actually exposed in this invocation')
    : developer
    ? args.some((arg, index) => arg === '--enable' && args[index + 1] === 'code_mode_host')
      && !args.some((arg, index) => arg === '--disable' && args[index + 1] === 'code_mode_host')
    : args.some((arg, index) => arg === '--disable' && args[index + 1] === 'code_mode_host')
      && !args.some((arg, index) => arg === '--enable' && args[index + 1] === 'code_mode_host'))
  && (providerDecision
    ? args.some((arg, index) => arg === '--disable' && args[index + 1] === 'code_mode_host') && !args.includes('--add-dir')
    : developer ? args.some((arg, index) => arg === '--add-dir' && args[index + 1] === fs.realpathSync(${JSON.stringify(workspacePath)}))
    && !args.some((arg, index) => arg === '--disable' && args[index + 1] === 'shell_tool')
    : args.some((arg, index) => arg === '--disable' && args[index + 1] === 'shell_tool'))
  && get('-C')?.startsWith(process.env.TMPDIR || '/')
  && process.env.HOME === ${JSON.stringify(nativeHome)}
  && process.env.CODEX_HOME === ${JSON.stringify(path.join(realUserHome, '.codex'))};
if (!good) { process.stderr.write(JSON.stringify({ developer, sandbox: get('--sandbox'), addDir: args[args.indexOf('--add-dir') + 1], cwd: get('-C'), effort: args[args.indexOf('-c') + 1], mcp: args[args.lastIndexOf('-c') + 1] })); process.exit(42); }
const mode = providerDecision && prompt.includes('provider-decision-contract') ? 'provider-decision-contract' : taskPrompt.trim();
const output = get('-o');
const isDecisionSchema = Boolean(JSON.parse(fs.readFileSync(get('--output-schema'), 'utf8')).properties?.content);
if (mode.startsWith('identity-probe:')) {
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'synthetic' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'turn.started', turn_id: 'turn-synthetic' }) + '\\n');
  fs.writeFileSync(output, JSON.stringify({ text: 'Synthetic role response', receivedPrompt: prompt }));
  process.stdout.write(JSON.stringify({ type: 'turn.completed', turn_id: 'turn-synthetic' }) + '\\n');
} else if (mode === 'never-started') {
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'synthetic' }) + '\\n');
  fs.writeFileSync(output, '{"partial":true}');
  process.exitCode = 7;
} else if (mode === 'nonzero-after-completed') {
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'synthetic' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'turn.started', turn_id: 'turn-synthetic' }) + '\\n');
  fs.writeFileSync(output, '{"verdict":"PASS"}');
  process.stdout.write(JSON.stringify({ type: 'turn.completed', turn_id: 'turn-synthetic' }) + '\\n');
  process.exitCode = 7;
} else if (mode === 'provider-decision-contract') {
  const output = get('-o');
  const decision = { content: [{ type: 'toolCall', name: 'write', arguments: { path: 'src/allowed.js', content: 'fixture' } }] };
  fs.writeFileSync(output + '.capture.json', JSON.stringify({ prompt, args, schema: JSON.parse(fs.readFileSync(get('--output-schema'), 'utf8')) }));
  fs.writeFileSync(output, JSON.stringify(decision));
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'synthetic' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'turn.started', turn_id: 'turn-synthetic' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'turn.completed', turn_id: 'turn-synthetic' }) + '\\n');
} else if (isDecisionSchema) {
  fs.writeFileSync(output, JSON.stringify({ content: [{ type: 'text', text: 'Synthetic decision' }] }));
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'synthetic' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'turn.started', turn_id: 'turn-synthetic' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'turn.completed', turn_id: 'turn-synthetic' }) + '\\n');
} else if (mode === 'stdout-turn-failed') {
  process.stdout.write(JSON.stringify({ type: 'turn.started', turn_id: 'turn-synthetic' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'turn.failed', error: { code: 'auth_error', message: 'Bearer secret-token-123456789 API_KEY=private-value /home/example/work' } }) + '\\n');
  process.exitCode = 1;
} else if (mode === 'stdout-error') {
  process.stdout.write(JSON.stringify({ type: 'error', message: 'service_busy' }) + '\\n');
  process.exitCode = 1;
} else if (mode === 'command-execution-pass' || mode === 'command-execution-fail') {
  process.stdout.write(JSON.stringify({ type: 'turn.started', turn_id: 'turn-command-synthetic' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'item.completed', item: {
    id: 'item-command-synthetic', type: 'command_execution',
    command: 'API_KEY=private-value node -e "SENSITIVE_SCRIPT_DO_NOT_STORE" --token=sk-secret-token-123456789',
    cwd: '/home/example/private-project', workdir: '/tmp/secret-work', shell: '/bin/zsh',
    status: mode === 'command-execution-pass' ? 'completed' : 'failed', exit_code: mode === 'command-execution-pass' ? 0 : 2,
    error: 'Bearer secret-token-123456789 API_KEY=private-value /Users/alice/private-project/secret.js',
  } }) + '\\n');
  if (mode === 'command-execution-fail') {
    process.stdout.write(JSON.stringify({ type: 'turn.failed', error: { code: 'tool_failed', message: 'The command tool returned a failure.' } }) + '\\n');
    process.exitCode = 1;
  } else {
    fs.writeFileSync(output, '{"verdict":"PASS"}');
    process.stdout.write(JSON.stringify({ type: 'turn.completed', turn_id: 'turn-command-synthetic' }) + '\\n');
  }
} else if (mode === 'partial-turn') {
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'synthetic' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'turn.started', turn_id: 'turn-synthetic' }) + '\\n');
  fs.writeFileSync(output, '{"partial":true}');
  process.exitCode = 7;
} else if (mode === 'hang-no-turn' || mode === 'hang-after-turn') {
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'synthetic' }) + '\\n');
  if (mode === 'hang-after-turn') process.stdout.write(JSON.stringify({ type: 'turn.started', turn_id: 'turn-synthetic' }) + '\\n');
  setInterval(() => {}, 1000);
} else if (mode === 'overflow-after-turn') {
  process.stdout.write(JSON.stringify({ type: 'turn.started', turn_id: 'turn-synthetic' }) + '\\n');
  process.stdout.write('x'.repeat(2_100_000));
} else {
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'synthetic' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'turn.started', turn_id: 'turn-synthetic' }) + '\\n');
  fs.writeFileSync(output, JSON.stringify(isDecisionSchema
    ? { content: [{ type: 'text', text: 'Synthetic decision' }] }
    : { verdict: 'PASS' }));
  process.stdout.write(JSON.stringify({ type: 'turn.completed', turn_id: 'turn-synthetic' }) + '\\n');
}
`);
  await fs.chmod(executable, 0o700);
  const schemaPath = path.join(root, 'schema.json');
  await fs.writeFile(schemaPath, '{"type":"object"}');
  const runRoot = path.join(root, 'audit');
  await fs.mkdir(runRoot);
  return { executable, schemaPath, runRoot, nativeHome, realUserHome, workspacePath };
}

function commonInput(fx, prompt, overrides = {}) {
  return {
    role: 'Reviewer', binding, idempotencyKey: `review:${prompt}`, deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    prompt, schemaPath: fx.schemaPath, runRoot: fx.runRoot, executable: fx.executable,
    hostCheck: { passed: true, taskId: binding.taskId, goalVersionId: binding.goalVersionId, executionId: binding.executionId,
      registrySha256: binding.registrySha256, workItemId: binding.workItemId, artifactId: binding.artifactId, candidateSha256: binding.candidateSha256 },
    reserve: async (request) => ({ created: true, id: `reservation-${request.idempotencyKey.replace(/[^A-Za-z0-9_-]/gu, '_')}`, callOrdinal: 1, binding: request.binding }),
    env: { ...process.env, HOME: fx.nativeHome, CODEX_HOME: '' }, realUserHome: fx.realUserHome,
    recordTurnStarted: async () => {}, settle: async () => {}, acceptResult: async () => true,
    ...overrides,
  };
}

test('Codex role adapter uses the explicit model and records a Reviewer only after a real turn starts', async (t) => {
  const fx = await fixture(t);
  const modelCalls = [];
  const settled = [];
  const result = await runCodexRole(commonInput(fx, 'pass', {
    recordTurnStarted: async (reservation) => modelCalls.push(reservation.id),
    settle: async (reservation, outcome) => settled.push([reservation.id, outcome]),
  }));

  assert.equal(CODEX_ROLE_MODEL, 'gpt-6-luna');
  assert.equal(result.status, 'model_returned', JSON.stringify(result));
  assert.equal(result.workCompleted, true);
  assert.equal(result.roleCallReserved, true);
  assert.equal(result.cliSpawned, true);
  assert.equal(result.turnStarted, true);
  assert.equal(result.providerRequestCount, null);
  assert.deepEqual(result.events, ['thread.started', 'turn.started', 'turn.completed']);
  assert.deepEqual(modelCalls, ['reservation-review_pass']);
  assert.equal(settled[0][1].workCompleted, true);
  assert.equal(result.diagnostics.toolExecutionTrace, 'not_exposed');
  assert.deepEqual(result.diagnostics.toolExecutions, []);
  assert.equal(result.diagnostics.startupCwdExists, true);
  assert.equal(result.diagnostics.cliPathExists, true);
});

test('all four Codex roles receive authoritative host identity with reservation hashes covering the exact stdin', async (t) => {
  const fx = await fixture(t);
  for (const role of ['Lead', 'Developer', 'Reviewer', 'Chat']) {
    const taskPrompt = `identity-probe:${role}`;
    let reserveRequest;
    let reserveCount = 0;
    let spawnCount = 0;
    let turnCount = 0;
    const result = await runCodexRole(commonInput(fx, taskPrompt, {
      role,
      idempotencyKey: `identity:${role}`,
      ...(role === 'Developer' ? { workspacePath: fx.workspacePath } : {}),
      reserve: async (request) => {
        reserveCount += 1;
        reserveRequest = request;
        return { created: true, id: `identity-${role}`, callOrdinal: 1, binding: request.binding };
      },
      recordCliSpawn: async () => { spawnCount += 1; },
      recordTurnStarted: async () => { turnCount += 1; },
    }));

    assert.equal(result.status, 'model_returned', `${role}: ${JSON.stringify(result)}`);
    assert.equal(result.output.text, 'Synthetic role response');
    const actualPrompt = result.output.receivedPrompt;
    assert.equal(actualPrompt, buildCodexRolePrompt(role, taskPrompt));
    assert.match(actualPrompt, new RegExp(`Authoritative host-selected role: ${role}`));
    assert.match(actualPrompt, new RegExp(`Authoritative host-selected model: ${CODEX_ROLE_MODEL}`));
    assert.match(actualPrompt, new RegExp(`Authoritative reasoning effort: ${CODEX_ROLE_REASONING_EFFORT}`));
    assert.match(actualPrompt, /Do not search for, install, or launch another CLI, model, provider, or subagent\./u);
    assert.equal(reserveCount, 1);
    assert.equal(spawnCount, 1);
    assert.equal(turnCount, 1);
    assert.equal(reserveRequest.maxCalls, 8);
    assert.equal(reserveRequest.promptSha256, crypto.createHash('sha256').update(JSON.stringify(buildCodexRoleInvocation(role, taskPrompt))).digest('hex'));
    assert.equal(reserveRequest.promptUtf8Bytes, Buffer.byteLength(actualPrompt, 'utf8'));
  }
});

test('host identity bytes count toward the prompt cap and reject before any reservation', async (t) => {
  const fx = await fixture(t);
  let reserveCount = 0;
  await assert.rejects(runCodexRole(commonInput(fx, 'x'.repeat(512 * 1024), {
    role: 'Lead', idempotencyKey: 'identity-over-limit',
    reserve: async () => { reserveCount += 1; return { created: false }; },
  })), /Codex 角色请求超过安全上限/u);
  assert.equal(reserveCount, 0);
});

test('command_execution diagnostics are bounded and never persist command text, scripts, credentials, or raw paths', async (t) => {
  const fx = await fixture(t);
  for (const [mode, expectedStatus, expectedExitCode] of [
    ['command-execution-pass', 'model_returned', 0],
    ['command-execution-fail', 'cli_failed', 2],
  ]) {
    let settled;
    const result = await runCodexRole(commonInput(fx, mode, { settle: async (_reservation, outcome) => { settled = outcome; } }));
    assert.equal(result.status, expectedStatus);
    const diagnostics = settled.diagnostics;
    assert.equal(diagnostics.toolExecutionTrace, 'observed');
    assert.equal(diagnostics.toolExecutionEventCount, 1);
    assert.equal(diagnostics.toolExecutions.length, 1);
    const [tool] = diagnostics.toolExecutions;
    assert.equal(tool.eventType, 'item.completed');
    assert.equal(tool.itemId, 'item-command-synthetic');
    assert.equal(tool.toolType, 'command_execution');
    assert.equal(tool.status, mode === 'command-execution-pass' ? 'completed' : 'failed');
    assert.equal(tool.exitCode, expectedExitCode);
    assert.equal(tool.commandExecutableHint, null);
    assert.ok(tool.commandUtf8Bytes > 0);
    assert.match(tool.commandSha256, /^[a-f0-9]{64}$/u);
    assert.equal(tool.cwd, '[路径已隐藏]');
    assert.equal(tool.workdir, '[路径已隐藏]');
    assert.equal(tool.shell, 'zsh');
    assert.equal(tool.cwdExists, false);
    assert.equal(tool.workdirExists, false);
    assert.equal(tool.shellExists, true);
    assert.equal(tool.errorSummary, 'error reported');
    assert.ok(tool.errorUtf8Bytes > 0);
    assert.match(tool.errorSha256, /^[a-f0-9]{64}$/u);
    const serialized = JSON.stringify(diagnostics);
    for (const secret of ['private-value', 'SENSITIVE_SCRIPT_DO_NOT_STORE', 'secret-token-123456789', 'sk-secret-token', '/Users/alice', 'secret-work']) {
      assert.equal(serialized.includes(secret), false, `diagnostics must not retain ${secret}`);
    }
    assert.equal(JSON.stringify(settled).includes('SENSITIVE_SCRIPT_DO_NOT_STORE'), false);
  }
});

test('command diagnostics reject shell-syntax hints and keep free-form error text out of metadata', async () => {
  const command = 'node;touch${IFS}PRIVATE_MARKER';
  const error = 'Command failed: node -e "PRIVATE_SCRIPT_FROM_ERROR"; stat:/PRIVATE_ABSOLUTE_PATH/file';
  const diagnostics = await adapterTest.commandExecutionDiagnostics([{
    type: 'item.completed',
    item: {
      type: 'command_execution', command, error,
      cwd: '../PRIVATE_RELATIVE_CWD', workdir: 'relative/PRIVATE_WORKDIR',
    },
  }]);
  const [tool] = diagnostics.toolExecutions;
  assert.equal(tool.commandExecutableHint, null);
  assert.equal(tool.errorSummary, 'error reported');
  assert.equal(tool.errorUtf8Bytes, Buffer.byteLength(error, 'utf8'));
  assert.match(tool.errorSha256, /^[a-f0-9]{64}$/u);
  assert.equal(tool.cwd, '[路径已隐藏]');
  assert.equal(tool.workdir, '[路径已隐藏]');
  assert.equal(tool.cwdExists, null);
  assert.equal(tool.workdirExists, null);
  const serialized = JSON.stringify(diagnostics);
  for (const secret of ['PRIVATE_MARKER', 'PRIVATE_SCRIPT_FROM_ERROR', 'PRIVATE_ABSOLUTE_PATH', 'PRIVATE_RELATIVE_CWD', 'PRIVATE_WORKDIR', 'node;touch']) {
    assert.equal(serialized.includes(secret), false, `diagnostics must not retain ${secret}`);
  }

  const simple = await adapterTest.commandExecutionDiagnostics([{
    type: 'item.completed', item: { type: 'command_execution', command: 'node' },
  }]);
  assert.equal(simple.toolExecutions[0].commandExecutableHint, 'node');
});

test('command_execution diagnostics mark absent fields unknown and retain only the last twelve events', async () => {
  const events = Array.from({ length: 15 }, (_unused, index) => ({
    type: 'item.completed', item: { type: 'command_execution', id: `item-${index}` },
  }));
  const diagnostics = await adapterTest.commandExecutionDiagnostics(events);
  assert.equal(diagnostics.toolExecutionTrace, 'observed');
  assert.equal(diagnostics.toolExecutionEventCount, 15);
  assert.equal(diagnostics.toolExecutions.length, 12);
  assert.equal(diagnostics.toolExecutions[0].itemId, 'item-3');
  assert.deepEqual({
    status: diagnostics.toolExecutions[0].status,
    exitCode: diagnostics.toolExecutions[0].exitCode,
    errorSummary: diagnostics.toolExecutions[0].errorSummary,
    cwd: diagnostics.toolExecutions[0].cwd,
    cwdExists: diagnostics.toolExecutions[0].cwdExists,
    workdir: diagnostics.toolExecutions[0].workdir,
    workdirExists: diagnostics.toolExecutions[0].workdirExists,
    shell: diagnostics.toolExecutions[0].shell,
    shellExists: diagnostics.toolExecutions[0].shellExists,
    commandExecutableHint: diagnostics.toolExecutions[0].commandExecutableHint,
    commandUtf8Bytes: diagnostics.toolExecutions[0].commandUtf8Bytes,
    commandSha256: diagnostics.toolExecutions[0].commandSha256,
  }, {
    status: null, exitCode: null, errorSummary: null, cwd: null, cwdExists: null,
    workdir: null, workdirExists: null, shell: null, shellExists: null,
    commandExecutableHint: null, commandUtf8Bytes: null, commandSha256: null,
  });
});

test('path-existence diagnostics distinguish missing paths from inaccessible paths', async () => {
  const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
  const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
  assert.equal(await adapterTest.pathExistsAs('/missing', 'file', async () => { throw missing; }), false);
  assert.equal(await adapterTest.pathExistsAs('/restricted', 'file', async () => { throw denied; }), null);
  assert.equal(await adapterTest.pathExistsAs('/file-not-dir', 'directory', async () => ({ isFile: () => true, isDirectory: () => false })), false);
});

test('Developer receives only the current QA worktree as an added writable directory', async (t) => {
  const fx = await fixture(t);
  const result = await runCodexRole(commonInput(fx, 'developer-pass', {
    role: 'Developer', workspacePath: fx.workspacePath,
    binding: { ...binding, artifactId: null, candidateSha256: null },
  }));
  assert.equal(result.status, 'model_returned', JSON.stringify(result));
  assert.equal(result.workCompleted, true);
  assert.equal(result.roleCallReserved, true);
});

test('Developer provider-decision mode runs read-only without requiring a writable workspace', async (t) => {
  const fx = await fixture(t);
  await fs.writeFile(fx.executable, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
const valid = value('--sandbox') === 'read-only'
  && !args.includes('--add-dir')
  && !args.some((arg, index) => arg === '--enable' && args[index + 1] === 'code_mode_host');
if (!valid) process.exit(42);
fs.writeFileSync(value('-o'), JSON.stringify({ content: [{ type: 'text', text: 'Synthetic decision' }] }));
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'synthetic' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'turn.started', turn_id: 'turn-synthetic' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'turn.completed', turn_id: 'turn-synthetic' }) + '\\n');
`);
  await fs.chmod(fx.executable, 0o700);
  const result = await runCodexRole(commonInput(fx, 'provider-decision-pass', {
    role: 'Developer', executionMode: 'provider-decision',
    providerTools: [], requiredProviderTools: [],
    binding: { ...binding, artifactId: null, candidateSha256: null },
  }));
  assert.equal(result.status, 'model_returned', JSON.stringify(result));
  assert.equal(result.roleCallReserved, true);
  assert.equal(result.cliSpawned, true);
  assert.equal(result.turnStarted, true);
});

test('provider-decision invocation uses developer-level OmO protocol, matching structured output, and read-only CLI args', async (t) => {
  const fx = await fixture(t);
  const tools = ['read', 'write'].map((name) => ({ name, parameters: {
    type: 'object', properties: name === 'write'
      ? { path: { type: 'string' }, content: { type: 'string' } }
      : { path: { type: 'string' } },
    required: name === 'write' ? ['path', 'content'] : ['path'], additionalProperties: false,
  } }));
  const prompt = buildCodexDecisionPrompt({
    systemPrompt: 'OmO runs the agent loop and owns the registered worktree tools.',
    messages: [{ role: 'user', content: 'provider-decision-contract' }],
    tools,
  });
  const schemaPath = path.resolve('app/schemas/role-text.json');
  let reservation;
  const result = await runCodexRole(commonInput(fx, prompt, {
    role: 'Developer', executionMode: 'provider-decision', schemaPath,
    providerTools: tools, requiredProviderTools: ['read', 'write'],
    idempotencyKey: 'provider-decision-contract',
    binding: { ...binding, artifactId: null, candidateSha256: null },
    reserve: async (request) => { reservation = request; return { created: true, id: 'provider-contract', callOrdinal: 1, binding: request.binding }; },
  }));

  assert.equal(result.status, 'model_returned', JSON.stringify(result));
  assert.deepEqual(parseCodexDecisionOutput(result.output.text, tools).content.map((item) => item.name), ['write']);
  const capture = JSON.parse(await fs.readFile(`${path.join(fx.runRoot, 'provider-contract')}.json.capture.json`, 'utf8'));
  assert.equal(capture.prompt, prompt);
  assert.doesNotMatch(capture.prompt, /Use only tools actually exposed in this invocation/u);
  assert.match(capture.prompt, /--- AVAILABLE OMO TOOLS JSON ---[\s\S]*"name":"write"/u);
  const configArg = capture.args.find((arg) => arg.startsWith('developer_instructions='));
  assert.ok(configArg, 'mode contract must use a session-level developer_instructions override');
  const developerInstructions = JSON.parse(configArg.slice('developer_instructions='.length));
  assert.match(developerInstructions, /OmO remains the sole agent harness/u);
  assert.match(developerInstructions, /OmO executes those tool calls/u);
  assert.match(developerInstructions, /Do not attempt CLI-native shell, filesystem, code-mode/u);
  assert.match(developerInstructions, /treat that request as unavailable in this invocation/u);
  assert.match(developerInstructions, /do not mean the separate OmO session tools are unavailable/u);
  assert.doesNotMatch(developerInstructions, /Use only tools actually exposed in this invocation/u);
  assert.equal(capture.args[capture.args.indexOf('--sandbox') + 1], 'read-only');
  assert.ok(capture.args.some((arg, index) => arg === '--disable' && capture.args[index + 1] === 'shell_tool'));
  assert.ok(capture.args.some((arg, index) => arg === '--disable' && capture.args[index + 1] === 'code_mode_host'));
  assert.ok(capture.args.some((arg, index) => arg === '-c' && capture.args[index + 1] === 'features.code_mode.enabled=false'));
  assert.ok(capture.args.some((arg, index) => arg === '--disable' && capture.args[index + 1] === 'unified_exec'));
  assert.equal(capture.args.includes('--add-dir'), false);
  const outputSchemaPath = capture.args[capture.args.indexOf('--output-schema') + 1];
  assert.notEqual(outputSchemaPath, schemaPath);
  assert.deepEqual(capture.schema.properties.content.items.anyOf.map((branch) => branch.properties.name?.enum?.[0]).filter(Boolean), ['read', 'write']);
  assert.equal(capture.schema.properties.content.items.anyOf.find((branch) => branch.properties.name?.enum?.[0] === 'write')
    .properties.arguments.properties.content.type, 'string');
  await assert.rejects(fs.access(outputSchemaPath), { code: 'ENOENT' }, 'temporary schema is removed after the CLI exits');
  const invocation = buildCodexRoleInvocation('Developer', prompt, 'provider-decision');
  assert.equal(reservation.promptSha256, crypto.createHash('sha256').update(JSON.stringify(invocation)).digest('hex'));
  assert.equal(reservation.promptUtf8Bytes, Buffer.byteLength(invocation.prompt, 'utf8') + Buffer.byteLength(invocation.developerInstructions, 'utf8'));
});

test('provider-decision rejects an unlisted tool name and unsupported argument schemas before model reservation', async (t) => {
  const fx = await fixture(t);
  const tools = [{ name: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }];
  assert.throws(() => adapterTest.normalizeProviderDecision({ content: [
    { type: 'toolCall', name: 'styles.css', arguments: {} },
  ] }, tools), /unregistered OmO tool call/u);
  assert.throws(() => adapterTest.strictOutputSchema({ type: 'object', properties: { options: { type: 'object', additionalProperties: true } } }), /unbounded properties/u);
  assert.throws(() => adapterTest.strictOutputSchema({ type: 'object', properties: { path: { type: 'string', minLength: 1 } } }), /unsupported constraints/u);
  assert.throws(() => adapterTest.strictOutputSchema({ anyOf: [{ type: 'string' }], type: 'string' }), /union has unsupported sibling constraints/u);
  const optionalTools = [{ name: 'read', parameters: { type: 'object', properties: {
    path: { type: 'string' }, glob: { type: 'string' }, nullable: { type: ['string', 'null'] },
  }, required: ['path', 'nullable'], additionalProperties: false } }];
  const normalized = adapterTest.normalizeProviderDecision({ content: [{ type: 'toolCall', name: 'read', arguments: {
    path: '.', glob: null, nullable: null,
  } }] }, optionalTools);
  assert.deepEqual(JSON.parse(normalized.text).content[0].arguments, { path: '.', nullable: null },
    'the strict CLI-only null placeholder is removed for an optional OmO argument but retained when null is valid');
  let reservations = 0;
  await assert.rejects(runCodexRole(commonInput(fx, 'unsupported-schema', {
    role: 'Developer', executionMode: 'provider-decision', providerTools: [{ name: 'read', parameters: {
      type: 'object', properties: { options: { type: 'object', additionalProperties: true } },
    } }], requiredProviderTools: ['read'], binding: { ...binding, artifactId: null, candidateSha256: null },
    reserve: async () => { reservations += 1; return { created: true, id: 'must-not-reserve', callOrdinal: 1, binding }; },
  })), /unbounded properties/u);
  await assert.rejects(runCodexRole(commonInput(fx, 'unregistered-tool-schema', {
    role: 'Developer', executionMode: 'provider-decision', providerTools: [...tools, { name: 'styles.css', parameters: tools[0].parameters }],
    requiredProviderTools: ['read'], binding: { ...binding, artifactId: null, candidateSha256: null },
    reserve: async () => { reservations += 1; return { created: true, id: 'must-not-reserve', callOrdinal: 1, binding }; },
  })), /missing a required tool schema/u);
  assert.equal(reservations, 0);
});

test('provider-decision rejects missing or empty registered tool schemas before reservation or CLI spawn', async (t) => {
  const fx = await fixture(t);
  let reservations = 0;
  let spawns = 0;
  for (const providerTools of [[], [{ name: 'read', parameters: { type: 'object', properties: {} } }]]) {
    await assert.rejects(runCodexRole(commonInput(fx, 'schema-preflight', {
      role: 'Developer', executionMode: 'provider-decision',
      binding: { ...binding, artifactId: null, candidateSha256: null },
      providerTools, requiredProviderTools: ['read', 'write', 'edit', 'grep', 'find', 'ls'],
      reserve: async () => { reservations += 1; return { created: true, id: 'must-not-reserve' }; },
      recordCliSpawn: async () => { spawns += 1; },
    })), /missing a required tool schema/u);
  }
  assert.equal(reservations, 0);
  assert.equal(spawns, 0);
});

test('explicit CLI override wins even under synthetic HOME and preserves the real CODEX_HOME', () => {
  const runtime = resolveCodexRuntime({ env: {
    HOME: '/project/.irixi-runtime/omo/home', CODEX_HOME: '/Users/test-user/.codex',
    IRIXI_CODEX_PATH: '/project/.irixi-runtime/omo/bin/codex', CODEX_CLI_PATH: '/Desktop/CodexCLI/codex',
  }, realUserHome: '/Users/test-user', platform: 'darwin' });
  assert.equal(runtime.codexHome, '/Users/test-user/.codex');
  assert.equal(runtime.executable, '/project/.irixi-runtime/omo/bin/codex');
  assert.equal(runtime.executableSource, 'IRIXI_CODEX_PATH');
});

test('Desktop CLI path is used when no explicit Irixi override is set', () => {
  const runtime = resolveCodexRuntime({ env: {
    HOME: '/app/synthetic-home', CODEX_HOME: '/Users/test-user/.codex',
    CODEX_CLI_PATH: '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
  }, realUserHome: '/Users/test-user', platform: 'darwin' });
  assert.equal(runtime.executable, '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex');
  assert.equal(runtime.executableSource, 'CODEX_CLI_PATH');
  assert.equal(runtime.codexHome, '/Users/test-user/.codex');
});

test('normal Desktop launch discovers the installed app-bundled CLI without CODEX_CLI_PATH', async (t) => {
  const desktopCli = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
  try { await fs.access(desktopCli); } catch { return t.skip('Desktop bundle is not installed at the system Applications path'); }
  const runtime = resolveCodexRuntime({ env: { HOME: '/app/synthetic-home', CODEX_HOME: '' }, realUserHome: '/Users/test-user', platform: 'darwin' });
  assert.equal(runtime.executable, desktopCli);
  assert.equal(runtime.executableSource, 'desktop-app-bundle');
});

test('missing supported runtime never falls back to the user global CLI', () => {
  const runtime = resolveCodexRuntime({ env: { HOME: '/app/home', CODEX_HOME: '' }, realUserHome: '/Users/test-user', platform: 'linux' });
  assert.equal(runtime.executable, null);
  assert.match(runtime.executableError, /不会回退到用户全局 CLI/u);
  assert.equal(runtime.codexHome, '/Users/test-user/.codex');
});

test('failed Host gate skips Reviewer before reservation and creates no call ledger entry', async (t) => {
  const fx = await fixture(t);
  let reservations = 0;
  let modelCalls = 0;
  const result = await runCodexRole(commonInput(fx, 'pass', {
    hostCheck: { passed: false, taskId: binding.taskId, goalVersionId: binding.goalVersionId, executionId: binding.executionId,
      registrySha256: binding.registrySha256, workItemId: binding.workItemId, artifactId: binding.artifactId, candidateSha256: binding.candidateSha256 },
    reserve: async () => { reservations += 1; throw new Error('must not reserve'); },
    recordTurnStarted: async () => { modelCalls += 1; },
  }));

  assert.equal(result.status, 'skipped_before_reservation');
  assert.equal(result.workCompleted, false);
  assert.equal(result.roleCallReserved, false);
  assert.equal(reservations, 0);
  assert.equal(modelCalls, 0);
});

test('Reviewer Host gate rejects a different goal or work item before reservation', async (t) => {
  const fx = await fixture(t);
  let reservations = 0;
  const result = await runCodexRole(commonInput(fx, 'pass', {
    hostCheck: { passed: true, taskId: binding.taskId, goalVersionId: 'different-goal', executionId: binding.executionId,
      registrySha256: binding.registrySha256, workItemId: binding.workItemId, artifactId: binding.artifactId, candidateSha256: binding.candidateSha256 },
    reserve: async () => { reservations += 1; return { created: true }; },
  }));
  assert.equal(result.status, 'skipped_before_reservation');
  assert.equal(reservations, 0);
});

test('atomic host reservation rejects duplicate starts and stale binding before CLI spawn', async (t) => {
  const fx = await fixture(t);
  let releaseReservation;
  const reservationGate = new Promise((resolve) => { releaseReservation = resolve; });
  const first = runCodexRole(commonInput(fx, 'pass', {
    idempotencyKey: 'same-bound-start',
    reserve: async (request) => {
      await reservationGate;
      return { created: true, id: 'reservation-first', callOrdinal: 1, binding: request.binding };
    },
  }));
  await new Promise((resolve) => setImmediate(resolve));
  const duplicate = await runCodexRole(commonInput(fx, 'pass', { idempotencyKey: 'same-bound-start' }));
  assert.equal(duplicate.status, 'duplicate_in_flight');
  releaseReservation();
  assert.equal((await first).workCompleted, true);

  const stale = await runCodexRole(commonInput(fx, 'pass', {
    idempotencyKey: 'stale-binding-start',
    reserve: async (request) => ({ created: true, id: 'reservation-stale', callOrdinal: 1,
      binding: { ...request.binding, candidateSha256: 'c'.repeat(64) } }),
  }));
  assert.equal(stale.status, 'adapter_failed');
  assert.equal(stale.roleCallReserved, true);
  assert.equal(stale.cliSpawned, false);
});

test('host reservation cannot exceed the eight role-start cap or extend the original window', async (t) => {
  const fx = await fixture(t);
  const overCap = await runCodexRole(commonInput(fx, 'pass', {
    reserve: async (request) => ({ created: true, id: 'reservation-over-cap', callOrdinal: request.maxCalls + 1, binding: request.binding }),
  }));
  assert.equal(overCap.status, 'adapter_failed');
  assert.equal(overCap.roleCallReserved, true);
  assert.equal(overCap.cliSpawned, false);

  const overWindow = await runCodexRole(commonInput(fx, 'pass', { deadlineAt: new Date(Date.now() + 21 * 60_000).toISOString() }));
  assert.equal(overWindow.status, 'deadline_exceeds_policy');
  assert.equal(overWindow.roleCallReserved, false);
});

test('CLI nonzero exit before turn.started preserves the reserved role start and any partial output', async (t) => {
  const fx = await fixture(t);
  let modelCalls = 0;
  const settled = [];
  const result = await runCodexRole(commonInput(fx, 'never-started', {
    recordTurnStarted: async () => { modelCalls += 1; },
    settle: async (_reservation, outcome) => settled.push(outcome),
  }));

  assert.equal(result.status, 'cli_failed');
  assert.equal(result.workCompleted, false);
  assert.equal(result.roleCallReserved, true);
  assert.equal(result.cliSpawned, true);
  assert.equal(result.turnStarted, false);
  assert.equal(result.providerRequestCount, null);
  assert.match(result.providerRequestEvidence, /不提供可核实/);
  assert.equal(modelCalls, 0);
  assert.equal(settled[0].roleCallReserved, true);
  assert.equal(await fs.readFile(result.outputPath, 'utf8'), '{"partial":true}');
});

test('CLI nonzero exit after turn start keeps a failed call and never treats partial JSON as completion', async (t) => {
  const fx = await fixture(t);
  let modelCalls = 0;
  let settled;
  const result = await runCodexRole(commonInput(fx, 'partial-turn', {
    recordTurnStarted: async () => { modelCalls += 1; },
    settle: async (_reservation, outcome) => { settled = outcome; },
  }));

  assert.equal(result.status, 'cli_failed');
  assert.equal(result.workCompleted, false);
  assert.equal(result.roleCallReserved, true);
  assert.equal(result.cliSpawned, true);
  assert.equal(result.turnStarted, true);
  assert.equal(modelCalls, 1);
  assert.equal(settled.workCompleted, false);
  assert.equal(await fs.readFile(result.outputPath, 'utf8'), '{"partial":true}');
});

test('CLI structured failure events keep bounded redacted causes in the same settled call', async (t) => {
  const fx = await fixture(t);
  const settled = [];
  const result = await runCodexRole(commonInput(fx, 'stdout-turn-failed', {
    settle: async (_reservation, outcome) => settled.push(outcome),
  }));

  assert.equal(result.status, 'cli_failed');
  assert.deepEqual(result.failureDetails, {
    stage: 'turn', eventType: 'turn.failed', code: 'auth_error', exitCode: 1,
    message: 'Bearer [已隐藏] API_KEY=[已隐藏] [路径已隐藏]', stderrTail: null,
  });
  assert.equal(settled[0].failureDetails.message, result.failureDetails.message);
  assert.doesNotMatch(JSON.stringify(settled[0]), /secret-token|private-value|alice/u);
  assert.ok(result.error.length <= 530);

  const errorEvent = await runCodexRole(commonInput(fx, 'stdout-error'));
  assert.equal(errorEvent.failureDetails.eventType, 'error');
  assert.equal(errorEvent.failureDetails.stage, 'cli');
  assert.equal(errorEvent.failureDetails.message, 'service_busy');
});

test('CLI nonzero exit stays failed even with final-looking JSON and turn.completed', async (t) => {
  const fx = await fixture(t);
  let accepted = false;
  const result = await runCodexRole(commonInput(fx, 'nonzero-after-completed', { acceptResult: async () => { accepted = true; return true; } }));

  assert.equal(result.status, 'cli_failed');
  assert.equal(result.roleCallReserved, true);
  assert.equal(result.cliSpawned, true);
  assert.equal(result.turnStarted, true);
  assert.equal(result.workCompleted, false);
  assert.equal(accepted, false);
  assert.equal(await fs.readFile(result.outputPath, 'utf8'), '{"verdict":"PASS"}');
});

test('output overflow preserves a prior turn.started event and settles as failed', async (t) => {
  const fx = await fixture(t);
  let turnRecorded = false;
  let settled;
  const result = await runCodexRole(commonInput(fx, 'overflow-after-turn', {
    recordTurnStarted: async () => { turnRecorded = true; },
    settle: async (_reservation, outcome) => { settled = outcome; },
  }));
  assert.equal(result.status, 'output_overflow');
  assert.equal(result.roleCallReserved, true);
  assert.equal(result.cliSpawned, true);
  assert.equal(result.turnStarted, true);
  assert.equal(turnRecorded, true);
  assert.equal(result.workCompleted, false);
  assert.equal(settled.status, 'output_overflow');
});

test('deadline timeout and cancellation are failures, not completed work', async (t) => {
  const fx = await fixture(t);
  let timedOutSettlement;
  const timedOut = await runCodexRole(commonInput(fx, 'hang-no-turn', {
    processTimeoutMs: 20, settle: async (_reservation, outcome) => { timedOutSettlement = outcome; },
  }));
  assert.equal(timedOut.status, 'timed_out');
  assert.equal(timedOut.roleCallReserved, true);
  assert.equal(timedOut.workCompleted, false);
  assert.equal(timedOut.providerRequestCount, null);
  assert.equal(timedOut.diagnostics.toolExecutionTrace, 'not_exposed');
  assert.equal(timedOut.diagnostics.toolExecutions.length, 0);
  assert.equal(timedOutSettlement.diagnostics.toolExecutionTrace, 'not_exposed');

  const controller = new AbortController();
  let cancelledSettlement;
  const pending = runCodexRole(commonInput(fx, 'hang-after-turn', {
    signal: controller.signal, processTimeoutMs: 5_000,
    settle: async (_reservation, outcome) => { cancelledSettlement = outcome; },
  }));
  setTimeout(() => controller.abort(), 700);
  const cancelled = await pending;
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.workCompleted, false);
  assert.equal(cancelled.roleCallReserved, true);
  assert.equal(cancelled.turnStarted, true);
  assert.equal(cancelled.providerRequestCount, null);
  assert.equal(cancelled.diagnostics.toolExecutionTrace, 'not_exposed');
  assert.equal(cancelled.diagnostics.toolExecutions.length, 0);
  assert.equal(cancelledSettlement.diagnostics.toolExecutionTrace, 'not_exposed');
});

test('Reviewer process timeout is clipped to the original execution deadline', () => {
  const now = Date.parse('2026-10-22T10:00:00.000Z');
  assert.equal(effectiveCodexProcessTimeoutMs(360_000, '2026-10-22T10:06:00.000Z', now), 360_000);
  assert.equal(effectiveCodexProcessTimeoutMs(360_000, '2026-10-22T10:01:30.000Z', now), 90_000);
  assert.equal(effectiveCodexProcessTimeoutMs(360_000, '2026-10-22T09:59:00.000Z', now), 1);
});
