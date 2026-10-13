#!/usr/bin/env node
import crypto from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { reserveModelCall, updateModelCall, sealModelBudget } from './development-budget-ledger.mjs';
import { NATIVE_TRIAL_BINDING, STATE_ROOT, resolveDevelopmentBatchBinding } from './native-development-binding.mjs';
import { nativeDevelopmentOutcome } from './native-result-contract.mjs';
import { assertArticleNativePrompt } from '../../../../authority/article-project-capacity.mjs';

const CODEX = process.env.IRIXI_CODEX_PATH || 'codex';
const EXECUTION_INSTRUCTIONS = "This is the isolated article-learning project explicitly authorized by the owner. The latest owner decision pauses DZ: do not load DZ skills, inspect .dz, run resume-report or write DZ state; this overrides older automatic onboarding. Work only in the fixed candidate workspace. The Developer is assigned ONLY code generation and local static checks. The product owner starts its own independent Reviewer after receiving the Developer result; overall goal criteria describe that later product phase, not work for the Developer to initiate. Do not spawn agents, use collaboration tools, invoke another model or Codex CLI, run direction challenges, or start an independent review yourself. Do not load generic artifact/design/build skill workflows or create their bookkeeping (including .impeccable); this explicit scoped owner assignment supersedes such automatic workflows. A Developer can report done when its own candidate and static checks are finished, while independent product review and learning acceptance remain pending. Reviewer must use read-only access and assess the current exact candidate, without fixing it or delegating. No remote apps, browsing, accounts, credential access, publishing, pushing, dependency installation, team loops or automatic retries. Do not modify project registration, model capability or budget records outside this workspace. Preserve the current goal and follow the native job output contract. The earlier read-after-understanding discussion was only a test and is not this project goal.";

const DISABLED_FEATURES = Object.freeze(['apps','plugins','remote_plugin','browser_use','browser_use_external','browser_use_full_cdp_access','computer_use','multi_agent','multi_agent_v2','image_generation','memories','hooks','goals','skill_search','skill_mcp_dependency_install']);

function rejectBindingOverride(name, expected) {
  const supplied = process.env[name]?.trim();
  if (supplied && supplied !== expected) throw new Error(`${name} cannot override the fixed article-learning-12 development binding`);
}

function parseInvocation(argv) {
  const fixedStart = ['--ask-for-approval', 'on-request'];
  if (fixedStart.some((value, index) => argv[index] !== value)) throw new Error('Rejected Codex arguments; fixed on-request contract required');
  let index = fixedStart.length;
  if (argv[index] !== '--model' || argv[index + 1] !== NATIVE_TRIAL_BINDING.model) throw new Error('Rejected Codex model');
  index += 2;
  const fixedExec = ['exec', '--sandbox', 'workspace-write', '--skip-git-repo-check'];
  if (fixedExec.some((value, offset) => argv[index + offset] !== value) || argv.length !== index + fixedExec.length + 1) throw new Error('Rejected Codex arguments; fixed exec contract required');
  const prompt = argv.at(-1);
  assertArticleNativePrompt(prompt);
  return { prompt, model: NATIVE_TRIAL_BINDING.model };
}

function assertExpectedRole(prompt, expectedRole) {
  const reviewerContract = /your role is Code Reviewer\b/.test(prompt) && /\*\*VERDICT:\*\* PASS or FAIL/.test(prompt);
  const hasDeveloperTag = prompt.includes('ARTICLE_LEARNING_DEVELOPER_12');
  const hasReviewerTag = prompt.includes('ARTICLE_LEARNING_REVIEWER_12');
  if (expectedRole === 'developer' && (!hasDeveloperTag || hasReviewerTag)) throw new Error('Rejected prompt outside the fixed integrated Developer contract');
  if (expectedRole === 'reviewer' && (!hasReviewerTag || hasDeveloperTag)) throw new Error('Rejected prompt outside the fixed integrated Reviewer contract');
  if (expectedRole === 'reviewer' && !reviewerContract) throw new Error('Second launch is reserved for the readonly native Reviewer');
  if (expectedRole === 'developer' && reviewerContract) throw new Error('First launch is reserved for Developer, not Reviewer');
}

const shaFile = async (file) => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');

function boundHeader(prompt, key) {
  const values = [...prompt.matchAll(new RegExp('^' + key + ':\\s*(.*?)\\s*$', 'gm'))];
  if (values.length !== 1 || !values[0][1]) throw new Error('Missing or ambiguous project binding header: ' + key);
  return values[0][1];
}
async function checkCapability(prompt, lane, role) {
  const capFile = path.join(STATE_ROOT, 'model-capability.json');
  const stat = await fs.lstat(capFile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 8192 || await fs.realpath(capFile) !== capFile) throw new Error('Project capability file is invalid');
  const cap = JSON.parse(await fs.readFile(capFile, 'utf8'));
  const entry = cap[lane];
  if (cap.schemaVersion !== 1 || cap.projectId !== 'article-learning-12' || !entry || entry.enabled !== true || entry.cap !== 2 || entry.windowMs !== 1200000) throw new Error('This bounded project model batch is not enabled');
  const roleOrder = entry.mode === 'review_only' ? ['reviewer'] : ['developer', 'reviewer'];
  if (role !== roleOrder[0] && entry.mode === 'review_only') throw new Error('This batch permits exactly one readonly Reviewer and no Developer');
  if (entry.mode === 'review_only' && boundHeader(prompt, 'IRIXI_REVIEW_ONLY') !== 'true') throw new Error('Review-only authorization header is missing');
  if (boundHeader(prompt, 'IRIXI_PROJECT_ID') !== cap.projectId || typeof cap.goalVersionId !== 'string' || boundHeader(prompt, 'IRIXI_GOAL_VERSION_ID') !== cap.goalVersionId) throw new Error('The project goal version changed or is not confirmed');
  if (role !== 'developer' && (!/^[a-f0-9]{64}$/.test(cap.candidateSha256 || '') || boundHeader(prompt, 'IRIXI_CANDIDATE_SHA256') !== cap.candidateSha256)) throw new Error('The candidate changed or is not confirmed');
  const binding = await resolveDevelopmentBatchBinding(entry);
  if (binding.batchOrdinal > 1) {
    for (const [key, value] of Object.entries({ IRIXI_EXECUTION_ID: entry.executionId, IRIXI_DEVELOPMENT_BATCH: binding.batchId, IRIXI_REPAIR_OF_EXECUTION_ID: entry.repairOfExecutionId, IRIXI_PRIOR_LEDGER_SHA256: entry.priorLedgerSha256, IRIXI_SCOPE_FINGERPRINT: entry.scopeFingerprint, IRIXI_SOURCE_SNAPSHOT_SHA256: entry.repairInputManifestSha256 })) {
      if (boundHeader(prompt, key) !== value) throw new Error('Repair authorization changed: ' + key);
    }
  }
  return { ...binding, roleOrder };
}

async function main() {
  const { workspace: configuredWorkspace } = NATIVE_TRIAL_BINDING;
  rejectBindingOverride('UPSTREAM_MODEL_WORKSPACE', configuredWorkspace);
  rejectBindingOverride('UPSTREAM_CODEX_MODEL', NATIVE_TRIAL_BINDING.model);
  const workspaceRealpath = await fs.realpath(configuredWorkspace);
  if (await fs.realpath(process.cwd()) !== workspaceRealpath) throw new Error('Codex cwd must exactly equal the authorized article-learning-12 development public workspace');
  const requestedArgs = process.argv.slice(2);
  const { prompt, model } = parseInvocation(requestedArgs);
  assertArticleNativePrompt(prompt);
  const knownRoleTags = ['ARTICLE_LEARNING_DEVELOPER_12', 'ARTICLE_LEARNING_REVIEWER_12'].filter((tag) => prompt.includes(tag));
  if (knownRoleTags.length !== 1) throw new Error('Rejected unbound or ambiguous integration role prompt before reservation');
  const { ledgerFile, trialId, roleOrder } = await checkCapability(prompt, 'development', knownRoleTags[0] === 'ARTICLE_LEARNING_DEVELOPER_12' ? 'developer' : 'reviewer');
  rejectBindingOverride('UPSTREAM_MODEL_LEDGER', ledgerFile);
  rejectBindingOverride('UPSTREAM_MODEL_TRIAL_ID', trialId);
  const reservation = await reserveModelCall({ ledgerFile, trialId, workspaceRealpath, prompt, roleOrder });
  const callDir = path.join(path.dirname(ledgerFile), `call-${reservation.ordinal}`);
  await fs.mkdir(callDir, { recursive: false, mode: 0o700 });
  const stdoutFile = path.join(callDir, 'stdout.log');
  const stderrFile = path.join(callDir, 'stderr.log');
  const stdoutStream = createWriteStream(stdoutFile, { flags: 'wx', mode: 0o600 });
  const stderrStream = createWriteStream(stderrFile, { flags: 'wx', mode: 0o600 });
  let child;
  let timeout;
  let stopping = false;
  const killOwnGroup = () => {
    if (!child?.pid || stopping) return;
    stopping = true;
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, killOwnGroup);
  try {
    assertExpectedRole(prompt, reservation.expectedRole);
    const effectiveSandbox = reservation.expectedRole === 'reviewer' ? 'read-only' : 'workspace-write';
    await updateModelCall({ ledgerFile, trialId, workspaceRealpath, ordinal: reservation.ordinal, patch: {
      status: 'running', startedAt: new Date().toISOString(), binary: CODEX, explicitModel: model, effectiveSandbox, disabledFeatures: [...DISABLED_FEATURES], codeModeHostEnabled: true, currentScopeInstructionsSha256: crypto.createHash('sha256').update(EXECUTION_INSTRUCTIONS).digest('hex'), ignoreUserConfig: true, ignoreExecRules: true, ephemeral: true, webSearch: 'disabled',
    } });
    const actualArgs = [
      '--ask-for-approval','never','--model',model,
      ...DISABLED_FEATURES.flatMap((feature)=>['--disable',feature]),
      '--enable','code_mode_host','--enable','skip_host_skill_discovery','-c','project_doc_max_bytes=0','-c',`developer_instructions=${JSON.stringify(EXECUTION_INSTRUCTIONS)}`,'-c','web_search="disabled"',
      'exec','--ignore-user-config','--ignore-rules','--ephemeral',
      '--sandbox',effectiveSandbox,'--skip-git-repo-check',prompt,
    ];
    child = spawn(CODEX, actualArgs, { cwd: workspaceRealpath, env: process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    await updateModelCall({ ledgerFile, trialId, workspaceRealpath, ordinal: reservation.ordinal, patch: { modelPid: child.pid } });
    timeout = setTimeout(killOwnGroup, Math.max(1, reservation.remainingMs));
    child.stdout.on('data', (bytes) => { process.stdout.write(bytes); stdoutStream.write(bytes); });
    child.stderr.on('data', (bytes) => { process.stderr.write(bytes); stderrStream.write(bytes); });
    const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (exitCode, signal) => resolve({ exitCode, signal })); });
    clearTimeout(timeout);
    stdoutStream.end(); stderrStream.end();
    await Promise.all([once(stdoutStream, 'close'), once(stderrStream, 'close')]);
    const [stdoutStat, stderrStat] = await Promise.all([fs.stat(stdoutFile), fs.stat(stderrFile)]);
    const outcome = nativeDevelopmentOutcome(await fs.readFile(stdoutFile, 'utf8'), reservation.expectedRole);
    await updateModelCall({ ledgerFile, trialId, workspaceRealpath, ordinal: reservation.ordinal, patch: {
      status: 'completed', completedAt: new Date().toISOString(), exitCode: result.exitCode, signal: result.signal,
      declaredStatus: outcome.declaredStatus, semanticFailureReason: outcome.reasonCode,
      stdout: { bytes: stdoutStat.size, sha256: await shaFile(stdoutFile), file: path.relative(path.dirname(ledgerFile), stdoutFile) },
      stderr: { bytes: stderrStat.size, sha256: await shaFile(stderrFile), file: path.relative(path.dirname(ledgerFile), stderrFile) },
    } });
    if (result.exitCode !== 0 || result.signal || outcome.declaredStatus === 'failed') await sealModelBudget({ledgerFile, trialId, workspaceRealpath, reasonCode:outcome.reasonCode || 'article_project_model_failed'});
    process.exitCode = outcome.declaredStatus === 'failed' ? 1 : result.exitCode ?? (result.signal ? 1 : 0);
  } catch (error) {
    clearTimeout(timeout); killOwnGroup(); stdoutStream.destroy(); stderrStream.destroy();
    await updateModelCall({ ledgerFile, trialId, workspaceRealpath, ordinal: reservation.ordinal, patch: {
      status: 'failed', completedAt: new Date().toISOString(), errorCode: error.code || 'wrapper_failed',
    } }).catch(() => {});
    await sealModelBudget({ledgerFile, trialId, workspaceRealpath, reasonCode:'article_project_wrapper_failed'}).catch(()=>{});
    throw error;
  }
}

main().catch((error) => { console.error(`[codex-two-call-budget] ${error.message}`); process.exitCode = 1; });
