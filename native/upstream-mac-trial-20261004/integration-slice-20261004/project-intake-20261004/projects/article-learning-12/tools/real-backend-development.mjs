import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const projectRoot = path.resolve(import.meta.dirname, '..');
const workspace = path.join(projectRoot, 'workspace');
const owned = path.join(projectRoot, 'backend/real-development-20261005');
const base = 'http://127.0.0.1:9109';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const result = { evidenceType: 'real supported product HTTP/WebSocket/native backend; no browser clicks', ok: false, startedAt: new Date().toISOString(), businessAuthoredByHarness: false, actualBrowser: false, automaticRetry: false, callsAllowed: 2, windowMs: 1200000 };
let socket;
const events = [];
const commands = [];
const save = async (name, value) => fs.writeFile(path.join(owned, name), JSON.stringify(value, null, 2) + '\n');
const announce = value => process.stdout.write(JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n');
async function api(route, body) {
  const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(8000), headers: { Origin: base, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json();
  if (!response.ok) throw Error(`Product ${route} rejected (${response.status}): ${value.error || 'request failed'}`);
  return value;
}
async function waitFor(check, message, deadline) {
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 350));
  }
  throw Error(message);
}
function send(command) {
  commands.push({ at: new Date().toISOString(), command });
  socket.send(JSON.stringify(command));
}
async function terminal(agentId, taskId, deadline) {
  return waitFor(() => {
    const value = events.find(event => ['TASK_DONE', 'TASK_FAILED'].includes(event.type) && event.agentId === agentId && (!taskId || event.taskId === taskId));
    return value || null;
  }, 'Native task exceeded the original bounded model window', deadline);
}
await fs.mkdir(owned, { recursive: true });
try {
  const registration = JSON.parse(await fs.readFile(path.join(projectRoot, 'project.json'), 'utf8'));
  assert.equal(registration.id, 'article-learning-12');
  assert.equal(registration.requirementsStatus, 'ready');
  assert.equal(registration.policyBasis.userConfirmed, true);
  assert.equal(registration.policyBasis.version, 'teaching-policy-20261005-v2');
  const initial = await api('/api/irixi-intake');
  assert.equal(initial.taskId, registration.taskId);
  assert.deepEqual(initial.draftGoal, registration.goalDraft);
  assert.equal(initial.goal.confirmed, false, 'This one-shot real run cannot replay a prior confirmation or launch');
  assert.deepEqual(await fs.readdir(workspace), []);
  await assert.rejects(fs.access(path.join(projectRoot, 'state/development-01/model-ledger.json')));
  await save('before.json', initial);
  const goalRequest = { expectedGoalVersionId: initial.goal.id, ...initial.draftGoal };
  const confirmedGoal = await api('/api/irixi-intake/confirm', goalRequest);
  assert.equal(confirmedGoal.goal.confirmed, true);
  assert.deepEqual(confirmedGoal.goal.statement, registration.goalDraft.statement);
  await save('goal-confirmation.json', { request: goalRequest, response: confirmedGoal, authorization: 'User confirmed core goal at 2026-10-05T08:22Z; parent explicitly authorized supported product API operation; this is not a page-click receipt.' });
  result.goalVersionId = confirmedGoal.goal.id;
  const authorized = await api('/api/irixi-intake/authorize-scope', { expectedGoalVersionId: result.goalVersionId });
  assert.equal(authorized.executionOption.authorized, true);
  assert.equal(authorized.modelAvailability.execution.available, true);
  assert.equal(authorized.modelAvailability.execution.remaining, 2);
  assert.equal(authorized.modelAvailability.learning.available, false);
  await save('workspace-authorization.json', authorized);
  const request = authorized.executionOption.registeredExecution;
  assert.ok(request?.prompt && request.promptSha256 === sha(request.prompt));
  assert.ok(request.prompt.includes('ARTICLE_LEARNING_DEVELOPER_12'));
  // Use the product's existing local-only authenticated connection. Never save or print its token.
  const connection = await api('/connect');
  assert.equal(connection.role, 'owner');
  assert.equal(connection.gatewayId, 'mac-article-learning-12');
  socket = new WebSocket('ws://127.0.0.1:9109');
  socket.addEventListener('message', ({ data }) => {
    try {
      const event = JSON.parse(String(data));
      events.push(event);
      fs.appendFile(path.join(owned, 'native-events.jsonl'), JSON.stringify({ receivedAt: new Date().toISOString(), event }) + '\n').catch(() => {});
    } catch { /* native gateway messages must be JSON */ }
  });
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.send(JSON.stringify({ type: 'AUTH', sessionToken: connection.sessionToken }));
  connection.sessionToken = undefined;
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.ok(!events.some(event => event.type === 'AUTH_FAILED'));
  result.authenticatedUsing = 'existing local-only /connect + normal AUTH; token not retained in evidence';
  const deadline = Date.now() + 20 * 60 * 1000;
  const developerId = `real-developer-12-${crypto.randomUUID()}`;
  send({ type: 'RUN_TASK', agentId: 'agent-article-learning-12', taskId: developerId, prompt: request.prompt, repoPath: workspace });
  announce({ phase: 'native_developer_started', taskId: developerId, goalVersionId: result.goalVersionId, maxCalls: 2 });
  const development = await terminal('agent-article-learning-12', developerId, deadline);
  await save('developer-terminal.json', development);
  if (development.type !== 'TASK_DONE') throw Error('Native Developer failed; stopped without retry: ' + development.error);
  assert.ok(Array.isArray(development.result.changedFiles) && development.result.changedFiles.length >= 1 && development.result.changedFiles.length <= 8);
  const candidate = await waitFor(async () => { const value = await api('/api/irixi-authority'); return value.artifact?.hostCheck?.passed ? value : null; }, 'Current candidate did not pass product host capture', Math.min(deadline, Date.now() + 10000));
  await save('candidate-host-capture.json', candidate);
  result.candidateSha256 = candidate.artifact.candidateSha256;
  result.developerTaskId = developerId;
  result.changedFiles = development.result.changedFiles;
  announce({ phase: 'native_candidate_generated', candidateSha256: result.candidateSha256, files: result.changedFiles, independentReviewPending: true });
  const reviewerId = 'reviewer-real-12-' + crypto.randomUUID().slice(0, 8);
  send({ type: 'REQUEST_REVIEW', reviewerAgentId: reviewerId, sourceAgentId: 'agent-article-learning-12', changedFiles: development.result.changedFiles, projectDir: workspace, entryFile: development.result.entryFile || 'index.html', summary: development.result.summary, backend: 'codex' });
  const review = await terminal(reviewerId, null, deadline);
  await save('reviewer-terminal.json', review);
  if (review.type !== 'TASK_DONE') throw Error('Native Reviewer failed; stopped without retry: ' + review.error);
  result.reviewerTaskId = review.taskId;
  result.reviewerOutputSha256 = sha(review.result.fullOutput || review.result.summary);
  const reviewed = await waitFor(async () => { const value = await api('/api/irixi-authority'); return value.artifact?.review ? value : null; }, 'Independent review was not accepted by the product', Math.min(deadline, Date.now() + 10000));
  await save('reviewed-candidate.json', reviewed);
  assert.equal(reviewed.artifact.candidateSha256, result.candidateSha256);
  assert.equal(reviewed.artifact.review.passed, true, 'Native independent review did not PASS; no confirmation or later inference is allowed');
  assert.equal(reviewed.artifact.review.nativeVerdict, 'PASS');
  await save('exact-candidate-confirmation.json', await api('/api/irixi-authority/confirm', { artifactId: reviewed.artifact.id, version: reviewed.artifact.version }));
  const current = await api('/api/irixi-authority');
  assert.equal(current.artifact.candidateSha256, result.candidateSha256);
  assert.equal(current.artifact.confirmation.goalVersionId, result.goalVersionId);
  send({ type: 'SERVE_PREVIEW', filePath: path.join(workspace, 'index.html') });
  const preview = await waitFor(async () => { const response = await fetch(base + '/preview-static/', { headers: { Origin: base }, signal: AbortSignal.timeout(5000) }); return response.ok ? Buffer.from(await response.arrayBuffer()) : null; }, 'Confirmed static preview did not become available', Date.now() + 10000);
  const entry = await fs.readFile(path.join(workspace, 'index.html'));
  assert.equal(sha(preview), sha(entry), 'Served preview is not the exact confirmed entry');
  result.preview = { url: base + '/preview-static/', bytes: preview.length, sha256: sha(preview), sourceEntrySha256: sha(entry), acceptanceType: 'actual HTTP file delivery; no visual or UI-interaction acceptance' };
  const ledger = JSON.parse(await fs.readFile(path.join(projectRoot, 'state/development-01/model-ledger.json'), 'utf8'));
  assert.equal(ledger.calls.length, 2);
  assert.deepEqual(ledger.calls.map(call => call.expectedRole), ['developer', 'reviewer']);
  assert.ok(ledger.calls.every(call => call.status === 'completed' && call.exitCode === 0 && !call.signal));
  result.nativeCalls = ledger.calls.length;
  result.rawOutputs = ledger.calls.map(call => ({ role: call.expectedRole, stdout: call.stdout, stderr: call.stderr }));
  result.learningModelCalls = 0;
  result.learningAcceptance = false;
  result.pageClickAcceptance = false;
  result.ok = true;
  announce({ phase: 'developer_reviewer_exact_confirmation_preview_passed', candidateSha256: result.candidateSha256, actualNativeCalls: 2, learningCalls: 0, actualBrowser: false, preview: result.preview.url });
} catch (error) {
  result.error = error.stack || error.message;
  announce({ phase: 'stopped_no_retry', error: error.message, actualBrowser: false });
  process.exitCode = 1;
} finally {
  socket?.close();
  result.finishedAt = new Date().toISOString();
  await save('sent-commands.json', commands);
  await save('result.json', result);
}
