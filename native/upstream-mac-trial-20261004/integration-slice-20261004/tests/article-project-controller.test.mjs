import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createArticleProjectController, __test as articleTest } from '../authority/article-project-controller.mjs';
import { createAuthorityReader, __test as authorityCoreTest } from '../authority/authority-core.mjs';
import { createIntakeController, __test as intakeTest } from '../authority/intake-controller.mjs';
import { groundingChecks } from '../../../../app/execution.mjs';
import { assertArticleNativePrompt } from '../authority/article-project-capacity.mjs';
import { resolveDevelopmentBatchBinding } from '../project-intake-20261004/projects/article-learning-12/tools/native-development-binding.mjs';
import { createStore as createIrixiStore } from '../../../../app/core.mjs';

const APP_ROOT = path.resolve(import.meta.dirname, '..', 'sources', 'irixi-20261004', 'app');
const REAL_P12 = path.resolve(import.meta.dirname, '..', 'project-intake-20261004', 'projects', 'article-learning-12');

test('authority task history is bounded at 8 MiB without changing regular-file guards', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-task-boundary-'))), exact = path.join(root, 'exact.json'), oversized = path.join(root, 'oversized.json');
  await fs.writeFile(exact, ''); await fs.truncate(exact, 8 * 1024 * 1024); assert.equal((await authorityCoreTest.readRegular(exact)).length, 8 * 1024 * 1024);
  await fs.writeFile(oversized, ''); await fs.truncate(oversized, 8 * 1024 * 1024 + 1); await assert.rejects(authorityCoreTest.readRegular(oversized), /Authority file is invalid/);
  const link = path.join(root, 'link.json'); await fs.symlink(exact, link); await assert.rejects(authorityCoreTest.readRegular(link), /Authority file is invalid/);
});

test('TaskStore guardedEffect serializes a bound side effect without a trailing task save', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-guarded-effect-')), store = createIrixiStore(root); await store.init();
  await store.save({ id: 'guarded-fixture', events: [], marker: 'unchanged' });
  store.save = async () => { throw new Error('guardedEffect must not save'); };
  const result = await store.guardedEffect('guarded-fixture', async (task) => { assert.equal(task.marker, 'unchanged'); return 'effect-complete'; });
  assert.equal(result, 'effect-complete'); assert.equal((await store.get('guarded-fixture')).marker, 'unchanged');
});

// Private installation/history replay is retained only in the development workspace.

// Private installation/history replay is retained only in the development workspace.

// Private installation/history replay is retained only in the development workspace.

// Private installation/history replay is retained only in the development workspace.

test('article text normalization preserves content and only normalizes transport newlines', () => {
  assert.equal(intakeTest.canonicalArticleText('\uFEFFA\r\nB'), 'A\nB\n');
  assert.equal(intakeTest.canonicalArticleText('A\nB\n\n'), 'A\nB\n');
  assert.notEqual(intakeTest.canonicalArticleText('A\nchanged'), intakeTest.canonicalArticleText('A\nB'));
});

test('reviewer deadline SIGKILL is incomplete only at the exact shared deadline', () => {
  const empty = crypto.createHash('sha256').update('').digest('hex'), ledger = { deadlineAt: '2026-10-05T14:23:57.245Z' };
  const timedOut = { startedAt: '2026-10-05T14:22:54.676Z', completedAt: '2026-10-05T14:23:57.257Z', exitCode: null, signal: 'SIGKILL', stdout: { bytes: 0, sha256: empty } };
  assert.equal(articleTest.classifyReviewerOutcome(ledger, timedOut, '').verdict, 'INCOMPLETE');
  assert.equal(articleTest.classifyReviewerOutcome(ledger, { ...timedOut, completedAt: '2026-10-05T14:23:00.000Z' }, ''), null);
  assert.equal(articleTest.classifyReviewerOutcome(ledger, timedOut, 'partial prose without verdict'), null);
  assert.equal(articleTest.classifyReviewerOutcome(ledger, timedOut, '**VERDICT:** FAIL\nissue').verdict, 'FAIL');
});

test('sealed Reviewer host proof filename is bound to the exact development batch', () => {
  assert.equal(articleTest.boundHostProofFile('development-20'), 'development-20-bound-host-proof-zero-model.json');
  assert.equal(articleTest.boundHostProofFile('development-27'), 'development-27-bound-host-proof-zero-model.json');
  assert.throws(() => articleTest.boundHostProofFile('development-27/other'), /binding is invalid/);
  assert.throws(() => articleTest.boundHostProofFile('development-current'), /binding is invalid/);
});

test('complete review permits 124 KiB source plus bounded framing without truncation', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-review-payload-')));
  await fs.mkdir(path.join(root, '.git'));
  const files = ['a.js', 'b.js', 'c.js', 'd.js', 'e.js', 'f.js'];
  const sizes = [21 * 1024, 21 * 1024, 21 * 1024, 21 * 1024, 20 * 1024, 20 * 1024];
  await Promise.all(files.map((file, index) => fs.writeFile(path.join(root, file), 'x'.repeat(sizes[index]))));
  const payload = await articleTest.reviewDiff(root, files);
  assert.equal(sizes.reduce((sum, value) => sum + value, 0), articleTest.ARTICLE_PROJECT_CAPACITY.maxSourceBytes);
  assert.ok(Buffer.byteLength(payload) <= articleTest.ARTICLE_PROJECT_CAPACITY.maxReviewBytes);
  await fs.writeFile(path.join(root, 'a.js'), 'x'.repeat(sizes[0] + 1));
  await assert.rejects(articleTest.reviewDiff(root, files), /source\/framing limits/);
  await assert.rejects(articleTest.reviewDiff(root, [...files, 'missing.js']), /ENOENT/);
});

test('complete review rejects framing above 2 KiB and native prompt above 144 KiB', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-review-framing-'))), files = [];
  for (let index = 0; index < 8; index++) {
    const dir = `${String(index).padStart(2, '0')}-${'d'.repeat(229)}`, relative = `${dir}/x.js`;
    await fs.mkdir(path.join(root, dir)); await fs.writeFile(path.join(root, relative), ''); files.push(relative);
  }
  await assert.rejects(articleTest.reviewDiff(root, files), /source\/framing limits/);
  assert.equal(Buffer.byteLength(assertArticleNativePrompt('界'.repeat(49_152))), 144 * 1024);
  assert.throws(() => assertArticleNativePrompt('界'.repeat(49_152) + 'a'), /144 KiB/);
});

// Private installation/history replay is retained only in the development workspace.

test('article project remains gated, then binds scope, candidate, review, and confirmation without a model', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-article-controller-')));
  const workspace = path.join(root, 'workspace'), tasks = path.join(root, 'tasks'), state = path.join(root, 'state');
  await Promise.all([fs.mkdir(workspace), fs.mkdir(tasks), fs.mkdir(state)]);
  const material = path.join(root, 'article.txt'); await fs.writeFile(material, 'Synthetic article.\n');
  const projectFile = path.join(root, 'project.json'), capabilityFile = path.join(state, 'model-capability.json');
  const goalDraft = { statement: 'Build a bounded static article learning fixture.', successCriteria: ['index exists'], boundaries: ['static files only'] };
  await fs.writeFile(projectFile, JSON.stringify({ id: 'article-learning-12', taskId: 'task-article-learning-12', title: 'Fixture', workspace, goalDraft, requirementsStatus: 'provisional-awaiting-complete-reference-policy', teachingImplementationStarted: false, material: { path: material, sha256: 'b'.repeat(64) } }));
  const learning01 = path.join(state, 'learning-01', 'model-ledger.json');
  await fs.writeFile(capabilityFile, JSON.stringify({ schemaVersion: 1, projectId: 'article-learning-12', goalVersionId: null, candidateSha256: null, phase: 'blocked', development: { enabled: false, cap: 2, windowMs: 1200000 }, learning: { enabled: false, cap: 2, windowMs: 1200000, ledgerFile: learning01 } }));
  const intake = await createIntakeController({ tasksRoot: tasks, irixiAppRoot: APP_ROOT, taskId: 'task-article-learning-12' }); await intake.ensureTask();
  const controller = await createArticleProjectController({ tasksRoot: tasks, irixiAppRoot: APP_ROOT, projectFile, capabilityFile });
  const before = await intake.read();
  await assert.rejects(controller.confirmGoal(before.taskId, { expectedGoalVersionId: before.goal.id, ...goalDraft }), /尚未就绪/);
  const project = JSON.parse(await fs.readFile(projectFile)); project.requirementsStatus = 'ready'; await fs.writeFile(projectFile, JSON.stringify(project));
  const goal = await controller.confirmGoal(before.taskId, { expectedGoalVersionId: before.goal.id, ...goalDraft });
  await controller.authorize(before.taskId, goal.id);
  const authorizedCapability = JSON.parse(await fs.readFile(capabilityFile)); assert.equal(authorizedCapability.development.enabled, true); assert.equal(authorizedCapability.goalVersionId, goal.id);
  const ready = await controller.state(before.taskId); assert.equal(ready.authorized, true); assert.match(ready.registeredExecution.prompt, /ARTICLE_LEARNING_DEVELOPER_12/);
  assert.match(ready.registeredExecution.prompt, /Do not delegate, create subagents, invoke collaboration/);
  assert.match(ready.registeredExecution.prompt, /separately budgeted native readonly Reviewer/);
  assert.match(ready.registeredExecution.prompt, /Report STATUS: failed if any required build or check is still failing, unresolved, skipped, or abandoned/);
  assert.match(ready.registeredExecution.prompt, /intermediate failure that you actually repair does not force a failed terminal/);
  assert.match(ready.registeredExecution.prompt, /rerun the complete required final checks, preserve the earlier failure and repair in SUMMARY/);
  assert.match(ready.registeredExecution.prompt, /Never hide, waive, or relabel a remaining failure as done/);
  await fs.writeFile(path.join(workspace, 'index.html'), '<!doctype html><title>fixture</title>\n');
  await fs.writeFile(path.join(workspace, 'styles.css'), '.half{width:50%}.full{width:100%}\n');
  await controller.store.mutate(before.taskId, (task) => controller.helpers.event(task, 'integration.observation', 'developer done', { type: 'TASK_DONE', actor: 'developer', sourceTaskId: 'dev-1', binding: { executionId: task.execution.id }, changedFiles: ['index.html'] }));
  const checked = await controller.hostCheck(before.taskId); assert.equal(checked.passed, true);
  assert.deepEqual(checked.candidate.reportedChangedFiles, ['index.html']); assert.deepEqual(checked.candidate.changes, ['index.html', 'styles.css']);
  const candidateTask = await controller.store.get(before.taskId), candidateArtifact = candidateTask.artifacts.at(-1);
  const trustedFacts = controller.helpers.createTrustedProjectReviewFacts(candidateTask, candidateArtifact);
  assert.equal(groundingChecks(candidateTask, candidateArtifact, { projectReviewFacts: trustedFacts }).find((entry) => entry.name === '关键数值守卫').passed, true);
  const proseArtifact = structuredClone(candidateArtifact); proseArtifact.content = 'The article proves that 50% of readers mastered it.';
  assert.equal(groundingChecks(candidateTask, proseArtifact, { projectReviewFacts: trustedFacts }).find((entry) => entry.name === '关键数值守卫').passed, false);
  const reviewCapability = JSON.parse(await fs.readFile(capabilityFile)); assert.equal(reviewCapability.development.enabled, true); assert.equal(reviewCapability.candidateSha256, checked.candidate.candidateSha256);
  await controller.store.mutate(before.taskId, (task) => controller.helpers.event(task, 'integration.observation', 'review started', { type: 'TASK_STARTED', actor: 'reviewer', sourceTaskId: 'review-fixture', binding: { candidateSha256: checked.candidate.candidateSha256 } }));
  await controller.recordReviewer(before.taskId, 'review-fixture', 'VERDICT: PASS\nISSUES:\nSUMMARY: bounded fixture');
  const task = await controller.store.get(before.taskId), artifact = task.artifacts.at(-1);
  const confirmed = await controller.confirm(before.taskId, artifact.id, artifact.version); assert.equal(confirmed.candidateSha256, checked.candidate.candidateSha256);
  const closedCapability = JSON.parse(await fs.readFile(capabilityFile)); closedCapability.learning.enabled = false; await fs.writeFile(capabilityFile, JSON.stringify(closedCapability));
  const reopened = await controller.confirm(before.taskId, artifact.id, artifact.version); assert.equal(reopened.approval.id, confirmed.approval.id);
  assert.equal((await controller.store.get(before.taskId)).approvals.length, 1);
  const capability = JSON.parse(await fs.readFile(capabilityFile)); assert.equal(capability.learning.enabled, true); assert.equal(capability.candidateSha256, checked.candidate.candidateSha256);
  const learning = await createIntakeController({ tasksRoot: tasks, irixiAppRoot: APP_ROOT, taskId: before.taskId, articleProjectFile: projectFile, articleCapabilityFile: capabilityFile });
  const registered = await learning.registerMaterial({ sessionId: 'session-1', label: 'User supplied full text', articleText: 'A\r\nB' });
  const saved = await controller.saveClientState(before.taskId, { projectId: 'article-learning-12', sessionId: 'session-1', expectedGoalVersionId: goal.id, expectedCandidateSha256: checked.candidate.candidateSha256, expectedMaterialEventId: registered.materialEventId, expectedRevision: 0, state: { favorites: ['concept-a'], works: [{ id: 'work-1', done: true }] } });
  assert.equal(saved.revision, 1);
  const restored = await controller.clientState(before.taskId, 'session-1'); assert.equal(restored.revision, 1); assert.equal(restored.material.articleText, 'A\nB\n');
  const currentThroughHistoryRead = await controller.clientState(before.taskId, 'session-1', { historical: true }); assert.equal(currentThroughHistoryRead.readOnly, true); assert.equal(currentThroughHistoryRead.current, true); assert.equal(currentThroughHistoryRead.historical, false);
  await assert.rejects(controller.saveClientState(before.taskId, { projectId: 'article-learning-12', sessionId: 'session-1', expectedGoalVersionId: goal.id, expectedCandidateSha256: checked.candidate.candidateSha256, expectedMaterialEventId: registered.materialEventId, expectedRevision: 0, state: {} }), /revision conflict/);
  await assert.rejects(controller.saveClientState(before.taskId, { projectId: 'article-learning-12', sessionId: 'session-1', expectedGoalVersionId: goal.id, expectedCandidateSha256: checked.candidate.candidateSha256, expectedMaterialEventId: registered.materialEventId, expectedRevision: 1, state: { oversized: 'x'.repeat(49 * 1024) } }), /48 KiB/);
  await assert.rejects(learning.beginInference({ projectId: 'article-learning-12', sessionId: 'session-1', turnId: 'turn-bad', kind: 'explain', articleSha256: registered.articleSha256, payload: { articleText: 'different' } }), /不是本会话最近明确登记/);
  const reservation = await learning.beginInference({ projectId: 'article-learning-12', sessionId: 'session-1', turnId: 'turn-1', kind: 'explain', articleSha256: registered.articleSha256, payload: { articleText: 'A\nB\n' } });
  const recovered = await learning.beginInference({ projectId: 'article-learning-12', sessionId: 'session-1', turnId: 'turn-1', kind: 'explain', articleSha256: registered.articleSha256, payload: { articleText: 'A\nB\n' } });
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.sourceTaskId, reservation.sourceTaskId);
  assert.equal(recovered.prompt, reservation.prompt);
  await assert.rejects(learning.beginInference({ projectId: 'article-learning-12', sessionId: 'session-1', turnId: 'turn-1', kind: 'explain', articleSha256: registered.articleSha256, payload: { articleText: 'A\nB\n' } }), /已经提交/);
  await learning.registerMaterial({ sessionId: 'session-1', label: 'Replacement', articleText: 'C\nD\n' });
  const reboundState = await controller.clientState(before.taskId, 'session-1'); assert.equal(reboundState.revision, 0); assert.equal(reboundState.material.articleText, 'C\nD\n');
  const historicalState = await controller.clientState(before.taskId, 'session-1', { historical: true }); assert.equal(historicalState.current, false); assert.equal(historicalState.state.favorites[0], 'concept-a'); assert.equal(historicalState.material.articleText, 'A\nB\n');
  const projectIndex = await controller.clientState(before.taskId, null, { scope: 'project' }); assert.equal(projectIndex.items.length, 1); assert.equal(projectIndex.items[0].historical, true); assert.equal('state' in projectIndex.items[0], false); assert.equal(projectIndex.truncated, false);
  await controller.store.mutate(before.taskId, (task) => { for (let index = 0; index < 201; index++) { const sessionId = `bounded-${index}`, articleText = `${index}\n`, articleSha256 = crypto.createHash('sha256').update(articleText).digest('hex'); const material = controller.helpers.event(task, 'learning.material_registered', 'bounded fixture material', { sessionId, label: sessionId, source: '', articleText, articleSha256, canonicalTextSha256: articleSha256, goalVersionId: goal.id, candidateSha256: checked.candidate.candidateSha256, normalization: 'fixture' }); controller.helpers.event(task, 'learning.client_state_saved', 'bounded fixture state', { sessionId, goalVersionId: goal.id, candidateSha256: checked.candidate.candidateSha256, materialEventId: material.id, revision: 1, stateSha256: articleSha256, state: { index } }); } });
  const boundedIndex = await controller.clientState(before.taskId, null, { scope: 'project' }); assert.equal(boundedIndex.items.length, 200); assert.equal(boundedIndex.totalSessions, 202); assert.equal(boundedIndex.truncated, true); assert.equal(boundedIndex.limit, 200);
  const answer = 'grounded result'; await learning.recordInference({ sourceTaskId: reservation.sourceTaskId, text: answer, resultSha256: crypto.createHash('sha256').update(answer).digest('hex') });
  assert.equal((await learning.inferenceStatus('turn-1')).status, 'stale');
  await fs.mkdir(path.dirname(learning01)); await fs.writeFile(learning01, JSON.stringify({ calls: [{ status: 'completed', exitCode: 0, signal: null }, { status: 'completed', exitCode: 0, signal: null }] }));
  const nextBatch = await controller.openLearningBatch(before.taskId, goal.id, checked.candidate.candidateSha256);
  assert.equal(nextBatch.ordinal, 2); assert.match(nextBatch.ledgerFile, /state\/learning-02\/model-ledger\.json$/);
  const material02 = await learning.registerMaterial({ sessionId: 'session-02', label: 'Learning 02', articleText: 'Exact recovery text.' });
  const request02 = { projectId: 'article-learning-12', sessionId: 'session-02', turnId: 'turn-learning-02', kind: 'explain', articleSha256: material02.articleSha256, payload: { articleText: 'Exact recovery text.\n' } };
  const reserved02 = await learning.beginInference(request02);
  await learning.recordInference({ sourceTaskId: reserved02.sourceTaskId, errorSha256: '2b4f6f7bf400a98b7620072fee0517a654149f1539ae47d629763ba0ab488cd3' });
  await controller.store.mutate(before.taskId, (current) => { current.events.findLast((entry) => entry.type === 'learning.inference_reserved' && entry.detail?.turnId === request02.turnId).at = new Date(Date.now() - 6000).toISOString(); });
  await assert.rejects(learning.inferenceStatus(request02.turnId), (error) => error.status === 404);
  const recovered02 = await learning.beginInference(request02); assert.equal(recovered02.recovered, true); assert.equal(recovered02.sourceTaskId, reserved02.sourceTaskId);
  assert.equal((await learning.inferenceStatus(request02.turnId)).status, 'running');
  await assert.rejects(learning.beginInference(request02), /已经提交/);
  const recoveredAnswer = 'recovered grounded result'; await learning.recordInference({ sourceTaskId: reserved02.sourceTaskId, text: recoveredAnswer, resultSha256: crypto.createHash('sha256').update(recoveredAnswer).digest('hex') });
  assert.equal((await learning.inferenceStatus(request02.turnId)).status, 'done');

  const reboundRequest = { ...request02, turnId: 'turn-learning-02-material-rebound' }, rebound = await learning.beginInference(reboundRequest);
  await learning.recordInference({ sourceTaskId: rebound.sourceTaskId, errorSha256: '2b4f6f7bf400a98b7620072fee0517a654149f1539ae47d629763ba0ab488cd3' });
  await learning.registerMaterial({ sessionId: 'session-02', label: 'Same bytes, new material event', articleText: 'Exact recovery text.' });
  await assert.rejects(learning.beginInference(reboundRequest), /已经提交/);

  const wrongRequest = { ...request02, turnId: 'turn-learning-02-wrong' }, wrong = await learning.beginInference(wrongRequest);
  await learning.recordInference({ sourceTaskId: wrong.sourceTaskId, errorSha256: 'f'.repeat(64) });
  await assert.rejects(learning.beginInference(wrongRequest), /已经提交/);
  const consumedRequest = { ...request02, turnId: 'turn-learning-02-consumed' }, consumed = await learning.beginInference(consumedRequest);
  await learning.recordInference({ sourceTaskId: consumed.sourceTaskId, errorSha256: '2b4f6f7bf400a98b7620072fee0517a654149f1539ae47d629763ba0ab488cd3' });
  await fs.writeFile(nextBatch.ledgerFile, JSON.stringify({ calls: [{ status: 'completed', exitCode: 0, signal: null }, { status: 'completed', exitCode: 0, signal: null }] }));
  await assert.rejects(learning.beginInference(consumedRequest), /已经提交/);
  assert.equal((await learning.inferenceStatus(consumedRequest.turnId)).status, 'failed');

  // CONTROLLED fixture: a sealed platform-schema mismatch may open exactly one new
  // independent batch only when the old/new registered schema bytes, raw result,
  // current material, goal and candidate are all bound by an explicit proof.
  const material05 = await learning.registerMaterial({ sessionId: 'schema-repair-session', label: 'Schema repair fixture', articleText: 'Schema repair text.' });
  const request05 = { projectId: 'article-learning-12', sessionId: 'schema-repair-session', turnId: 'turn-schema-05', kind: 'explain', articleSha256: material05.articleSha256, payload: { articleText: 'Schema repair text.\n' } };
  const reserved05 = await learning.beginInference(request05), invalidText = '{"concepts":[],"coverage":[]}';
  const invalidSha = crypto.createHash('sha256').update(invalidText).digest('hex'); await learning.recordInference({ sourceTaskId: reserved05.sourceTaskId, text: invalidText, resultSha256: invalidSha });
  const learning05 = path.join(state, 'learning-05', 'model-ledger.json'), rawSha = invalidSha;
  const configRoot = path.join(root, 'config/inference-output-schemas'), oldRoot = path.join(root, 'backend/learning-05-platform-schema-repair/registered-schema-before'), evidenceRoot = path.join(root, 'evidence');
  await Promise.all([fs.mkdir(configRoot, { recursive: true }), fs.mkdir(oldRoot, { recursive: true }), fs.mkdir(evidenceRoot)]);
  const oldExplain = '{"type":"object","additionalProperties":false,"required":["concepts","coverage"],"properties":{"concepts":{},"coverage":{}}}', oldAssess = '{"type":"object","additionalProperties":false,"required":["verdict"],"properties":{"verdict":{}}}', newExplain = '{"type":"object","additionalProperties":false,"required":["concepts","coverage","plan"],"properties":{"concepts":{},"coverage":{},"plan":{}}}', newAssess = '{"type":"object","additionalProperties":false,"required":["verdict","activityQualification"],"properties":{"verdict":{},"activityQualification":{}}}';
  await Promise.all([fs.writeFile(path.join(oldRoot, 'explain.json'), oldExplain), fs.writeFile(path.join(oldRoot, 'assess.json'), oldAssess), fs.writeFile(path.join(configRoot, 'explain.json'), newExplain), fs.writeFile(path.join(configRoot, 'assess.json'), newAssess)]);
  await fs.mkdir(path.join(path.dirname(learning05), 'call-1'), { recursive: true }); await fs.writeFile(path.join(path.dirname(learning05), 'call-1/stdout.log'), invalidText);
  const ledger05 = { cap: 2, windowMs: 1200000, calls: [{ expectedRole: 'inference', promptSha256: reserved05.promptSha256, status: 'completed', exitCode: 0, signal: null, outputSchema: { kind: 'explain', sha256: crypto.createHash('sha256').update(oldExplain).digest('hex') }, stdout: { file: 'call-1/stdout.log', bytes: Buffer.byteLength(invalidText), sha256: rawSha } }], sealed: { reasonCode: 'host_native_learning_output_contract_invalid' } }; await fs.writeFile(learning05, JSON.stringify(ledger05));
  const cap05 = JSON.parse(await fs.readFile(capabilityFile)); cap05.learning = { ...cap05.learning, enabled: false, ledgerFile: learning05 }; await fs.writeFile(capabilityFile, JSON.stringify(cap05));
  const proof = { projectId: 'article-learning-12', goalVersionId: goal.id, candidateSha256: checked.candidate.candidateSha256, materialEventId: material05.materialEventId, turnId: request05.turnId, sourceTaskId: reserved05.sourceTaskId, priorLedgerSha256: crypto.createHash('sha256').update(await fs.readFile(learning05)).digest('hex'), nativeModelCalls: 0, sourceUnchanged: true, invalidRawNotReused: true, invalidRawStdoutSha256: rawSha, invalidResultSha256: invalidSha, oldExplainSchemaSha256: crypto.createHash('sha256').update(oldExplain).digest('hex'), newExplainSchemaSha256: crypto.createHash('sha256').update(newExplain).digest('hex'), oldAssessSchemaSha256: crypto.createHash('sha256').update(oldAssess).digest('hex'), newAssessSchemaSha256: crypto.createHash('sha256').update(newAssess).digest('hex') };
  const proofFile = 'learning-05-platform-schema-repair-zero-model.json', proofBytes = Buffer.from(JSON.stringify(proof)); await fs.writeFile(path.join(evidenceRoot, proofFile), proofBytes);
  const schemaAcceptance = { acknowledgement: 'preserve_platform_schema_contract_failure', expectedSchemaRepairProofFile: proofFile, expectedSchemaRepairProofSha256: crypto.createHash('sha256').update(proofBytes).digest('hex'), expectedPriorLearningLedgerSha256: proof.priorLedgerSha256, expectedFailedTurnId: request05.turnId, expectedMaterialEventId: material05.materialEventId, expectedSourceTaskId: reserved05.sourceTaskId };
  const taskBeforeSchemaReject = await fs.readFile(path.join(tasks, before.taskId, 'task.json')), capBeforeSchemaReject = await fs.readFile(capabilityFile);
  await assert.rejects(controller.openLearningBatch(before.taskId, goal.id, checked.candidate.candidateSha256, { ...schemaAcceptance, expectedSchemaRepairProofSha256: '0'.repeat(64) }), /stale or incomplete/); assert.deepEqual(await fs.readFile(path.join(tasks, before.taskId, 'task.json')), taskBeforeSchemaReject); assert.deepEqual(await fs.readFile(capabilityFile), capBeforeSchemaReject);
  await assert.rejects(controller.openLearningBatch(before.taskId, goal.id, checked.candidate.candidateSha256, { ...schemaAcceptance, expectedMaterialEventId: registered.materialEventId }), /stale or incomplete/);
  await fs.writeFile(path.join(configRoot, 'explain.json'), oldExplain); await assert.rejects(controller.openLearningBatch(before.taskId, goal.id, checked.candidate.candidateSha256, schemaAcceptance), /stale or incomplete/); await fs.writeFile(path.join(configRoot, 'explain.json'), newExplain);
  await fs.writeFile(path.join(path.dirname(learning05), 'call-1/stdout.log'), '{"concepts":[],"coverage":[],"plan":{}}'); await assert.rejects(controller.openLearningBatch(before.taskId, goal.id, checked.candidate.candidateSha256, schemaAcceptance), /stale or incomplete/); await fs.writeFile(path.join(path.dirname(learning05), 'call-1/stdout.log'), invalidText);
  const originalMutate = controller.store.mutate.bind(controller.store);
  controller.store.mutate = async (id, change) => { controller.store.mutate = originalMutate; await originalMutate(id, (current) => controller.helpers.event(current, 'controlled.concurrent_change', 'fixture race')); return originalMutate(id, change); };
  await assert.rejects(controller.openLearningBatch(before.taskId, goal.id, checked.candidate.candidateSha256, schemaAcceptance), /changed before commit/); assert.deepEqual(await fs.readFile(capabilityFile), capBeforeSchemaReject); await assert.rejects(fs.lstat(path.join(state, 'learning-06')), (error) => error.code === 'ENOENT');
  const taskBeforeFault = await fs.readFile(path.join(tasks, before.taskId, 'task.json')), capBeforeFault = await fs.readFile(capabilityFile);
  let capabilityDuringPersistenceFault = null;
  controller.store.mutate = async (id, change) => { controller.store.mutate = originalMutate; const draft = await controller.store.get(id); await change(draft); capabilityDuringPersistenceFault = JSON.parse(await fs.readFile(capabilityFile)); throw new Error('CONTROLLED task persistence fault'); };
  await assert.rejects(controller.openLearningBatch(before.taskId, goal.id, checked.candidate.candidateSha256, schemaAcceptance), /CONTROLLED task persistence fault/); assert.equal(capabilityDuringPersistenceFault.learning.enabled, false); assert.match(capabilityDuringPersistenceFault.phase, /learning-06-pending$/); assert.deepEqual(await fs.readFile(path.join(tasks, before.taskId, 'task.json')), taskBeforeFault); assert.deepEqual(await fs.readFile(capabilityFile), capBeforeFault); await assert.rejects(fs.lstat(path.join(state, 'learning-06')), (error) => error.code === 'ENOENT');
  const taskBeforeInterveningWrite = await fs.readFile(path.join(tasks, before.taskId, 'task.json')), capBeforeInterveningWrite = await fs.readFile(capabilityFile), originalGuardedEffect = controller.store.guardedEffect.bind(controller.store);
  const interveningCap = { ...JSON.parse(capBeforeInterveningWrite), goalVersionId: 'goal-from-another-valid-action', phase: 'other-valid-batch-open', learning: { ...JSON.parse(capBeforeInterveningWrite).learning, enabled: true, ledgerFile: path.join(state, 'learning-77/model-ledger.json') } }, interveningCapBytes = Buffer.from(JSON.stringify(interveningCap));
  controller.store.guardedEffect = async (id, effect) => { controller.store.guardedEffect = originalGuardedEffect; await originalMutate(id, (current) => controller.helpers.event(current, 'controlled.other_valid_action', 'fixture intervening task and capability change')); await fs.writeFile(capabilityFile, interveningCapBytes); return originalGuardedEffect(id, effect); };
  await assert.rejects(controller.openLearningBatch(before.taskId, goal.id, checked.candidate.candidateSha256, schemaAcceptance), /changed before enable/); assert.deepEqual(await fs.readFile(capabilityFile), interveningCapBytes);
  await fs.writeFile(path.join(tasks, before.taskId, 'task.json'), taskBeforeInterveningWrite); await fs.writeFile(capabilityFile, capBeforeInterveningWrite); await fs.rmdir(path.join(state, 'learning-06'));
  const schemaBatch = await controller.openLearningBatch(before.taskId, goal.id, checked.candidate.candidateSha256, schemaAcceptance); assert.equal(schemaBatch.ordinal, 6); assert.match(schemaBatch.ledgerFile, /learning-06\/model-ledger\.json$/);

  // PRODUCT_MODE history must recover exact materials from the append-only audit
  // even after the TaskStore's 500-event projection has rolled them out.
  const productLearning = await createIntakeController({ tasksRoot: tasks, irixiAppRoot: APP_ROOT, taskId: before.taskId,
    articleProjectFile: projectFile, articleCapabilityFile: capabilityFile, productMode: true });
  await controller.store.mutate(before.taskId, (current) => {
    while (current.events.length < 500) controller.helpers.event(current, 'task.state', 'history retention fixture filler', {});
  });
  const retained = await productLearning.registerMaterial({ sessionId: 'retained-history-session', label: 'Retained full text', articleText: 'Exact historical article text.' });
  const retainedState = { record: { sessionId: 'retained-history-session', turns: [{ id: 'turn-1' }] }, cumulative: { completed: 1 } };
  const retainedSave = await productLearning.saveProductClientState({ projectId: 'article-learning-12', sessionId: 'retained-history-session',
    expectedGoalVersionId: goal.id, expectedCandidateSha256: checked.candidate.candidateSha256, expectedMaterialEventId: retained.materialEventId,
    expectedRevision: 0, state: retainedState });
  assert.equal(retainedSave.revision, 1);
  await controller.store.mutate(before.taskId, (current) => {
    for (let index = 0; index < 499; index++) controller.helpers.event(current, 'task.state', 'history retention fixture rollover', { index });
  });
  assert.equal((await controller.store.get(before.taskId)).events.some((entry) => entry.id === retained.materialEventId), false);
  const retainedIndex = await productLearning.productClientState(null, { scope: 'project' });
  const retainedRow = retainedIndex.items.find((entry) => entry.sessionId === 'retained-history-session');
  assert.equal(retainedRow.label, 'Retained full text'); assert.equal(retainedRow.materialEventId, retained.materialEventId); assert.equal(retainedRow.current, true);
  const retainedHistory = await productLearning.productClientState('retained-history-session', { historical: true });
  assert.equal(retainedHistory.readOnly, true); assert.equal(retainedHistory.current, true);
  assert.equal(retainedHistory.material.articleText, 'Exact historical article text.\n'); assert.equal(retainedHistory.materialEventId, retained.materialEventId);
  assert.equal(retainedHistory.material.articleSha256, retained.articleSha256);
  const retainedCurrent = await productLearning.productClientState('retained-history-session');
  assert.equal(retainedCurrent.revision, 1); assert.equal(retainedCurrent.material.articleText, 'Exact historical article text.\n');
  const retainedSave2 = await productLearning.saveProductClientState({ projectId: 'article-learning-12', sessionId: 'retained-history-session',
    expectedGoalVersionId: goal.id, expectedCandidateSha256: checked.candidate.candidateSha256, expectedMaterialEventId: retained.materialEventId,
    expectedRevision: 1, state: { ...retainedState, cumulative: { completed: 2 } } });
  assert.equal(retainedSave2.revision, 2);

  await fs.writeFile(path.join(workspace, 'index.html'), '<!doctype html><title>tampered</title>\n');
  await assert.rejects(controller.openLearningBatch(before.taskId, goal.id, checked.candidate.candidateSha256), /changed after host capture/);
});

test('controlled confirmed-core increment creates a new bounded execution and one automatic review reservation', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-article-increment-'))), workspace = path.join(root, 'workspace'), tasks = path.join(root, 'tasks'), state = path.join(root, 'state');
  await Promise.all([fs.mkdir(workspace), fs.mkdir(tasks), fs.mkdir(state)]);
  const material = path.join(root, 'article.txt'); await fs.writeFile(material, 'Synthetic article.\n');
  const projectFile = path.join(root, 'project.json'), capabilityFile = path.join(state, 'model-capability.json'), development01 = path.join(state, 'development-01', 'model-ledger.json');
  const core = { statement: 'Build the confirmed core.', successCriteria: ['core works'], boundaries: ['static only'] };
  await fs.writeFile(projectFile, JSON.stringify({ id: 'article-learning-12', taskId: 'task-increment', title: 'Increment fixture', workspace, goalDraft: core, requirementsStatus: 'ready', teachingImplementationStarted: false, material: { path: material, sha256: 'd'.repeat(64) } }));
  await fs.mkdir(path.dirname(development01)); const ledgerBytes = Buffer.from(`${JSON.stringify({ calls: [{ status: 'completed' }, { status: 'completed' }], sealed: { reasonCode: 'completed' } })}\n`); await fs.writeFile(development01, ledgerBytes);
  await fs.writeFile(capabilityFile, JSON.stringify({ schemaVersion: 1, projectId: 'article-learning-12', goalVersionId: null, candidateSha256: null, phase: 'blocked', development: { enabled: false, ledgerFile: development01, cap: 2, windowMs: 1200000 }, learning: { enabled: false, cap: 2, windowMs: 1200000, ledgerFile: path.join(state, 'learning-01', 'model-ledger.json') } }));
  const intake = await createIntakeController({ tasksRoot: tasks, irixiAppRoot: APP_ROOT, taskId: 'task-increment' }); await intake.ensureTask();
  const controller = await createArticleProjectController({ tasksRoot: tasks, irixiAppRoot: APP_ROOT, projectFile, capabilityFile }), initial = await intake.read(), coreGoal = await controller.confirmGoal(initial.taskId, { expectedGoalVersionId: initial.goal.id, ...core });
  await controller.authorize(initial.taskId, coreGoal.id); await fs.writeFile(path.join(workspace, 'index.html'), '<!doctype html><title>core</title>\n');
  await controller.store.mutate(initial.taskId, (task) => controller.helpers.event(task, 'integration.observation', 'developer done', { type: 'TASK_DONE', actor: 'developer', sourceTaskId: 'dev-core', binding: { executionId: task.execution.id }, changedFiles: ['index.html'], entryFile: 'index.html' }));
  const captured = await controller.hostCheck(initial.taskId); await controller.store.mutate(initial.taskId, (task) => controller.helpers.event(task, 'integration.observation', 'review started', { type: 'TASK_STARTED', actor: 'reviewer', sourceTaskId: 'review-core', binding: { candidateSha256: captured.candidate.candidateSha256 } }));
  await controller.recordReviewer(initial.taskId, 'review-core', 'VERDICT: PASS\nSUMMARY: core'); const coreTask = await controller.store.get(initial.taskId), coreArtifact = coreTask.artifacts.at(-1); await controller.confirm(initial.taskId, coreArtifact.id, coreArtifact.version);
  const coreCapability = JSON.parse(await fs.readFile(capabilityFile)); coreCapability.development.executionId = coreTask.execution.id; await fs.writeFile(capabilityFile, JSON.stringify(coreCapability));
  const coreLearning = await createIntakeController({ tasksRoot: tasks, irixiAppRoot: APP_ROOT, taskId: initial.taskId, articleProjectFile: projectFile, articleCapabilityFile: capabilityFile });
  const oldMaterial = await coreLearning.registerMaterial({ sessionId: 'increment-session', label: 'Old goal material', articleText: 'Old goal text.' });
  await controller.saveClientState(initial.taskId, { projectId: 'article-learning-12', sessionId: 'increment-session', expectedGoalVersionId: coreGoal.id, expectedCandidateSha256: captured.candidate.candidateSha256, expectedMaterialEventId: oldMaterial.materialEventId, expectedRevision: 0, state: { value: 'historical' } });
  const incrementDraft = { statement: 'Add the confirmed P0 increment.', successCriteria: ['core remains', 'increment works'], boundaries: ['static only', 'no P1'] }, project = JSON.parse(await fs.readFile(projectFile)); project.goalDraft = incrementDraft; await fs.writeFile(projectFile, JSON.stringify(project));
  const newGoal = await controller.confirmGoal(initial.taskId, { expectedGoalVersionId: coreGoal.id, ...incrementDraft });
  const afterGoalReplacement = await controller.store.get(initial.taskId); assert.equal(afterGoalReplacement.execution, null); assert.deepEqual(afterGoalReplacement.executionHistory.at(-1), coreTask.execution);
  await assert.rejects(controller.clientState(initial.taskId, 'increment-session'), /newly registered current-goal material/);
  const opened = await controller.authorizeGoalIncrement(initial.taskId, { expectedPriorGoalVersionId: coreGoal.id, expectedNewGoalVersionId: newGoal.id, expectedConfirmedArtifactId: coreArtifact.id, expectedConfirmedCandidateSha256: captured.candidate.candidateSha256, expectedSourceManifestSha256: captured.candidate.candidateSha256, expectedPriorLedgerSha256: crypto.createHash('sha256').update(ledgerBytes).digest('hex'), acknowledgement: 'preserve_confirmed_candidate_as_increment_input', maxModelCalls: 2, maxDurationMs: 1200000, optInBoundedAutoReview: true });
  const openedTask = await controller.store.get(initial.taskId); assert.equal(controller.helpers.projectWorkspaceIsCurrent(openedTask), true, JSON.stringify({ stored: openedTask.projectWorkspace.taskInputBinding, current: controller.helpers.projectTaskBinding(openedTask), workspace: openedTask.projectWorkspace }, null, 2));
  assert.equal(opened.mode, 'goal_increment'); assert.match(opened.registeredExecution.prompt, /new confirmed-goal increment/); assert.doesNotMatch(opened.registeredExecution.prompt, /Known read-only zero-model findings/);
  const projected = await controller.state(initial.taskId); assert.equal(projected.registeredExecution.executionId, opened.executionId); assert.equal(projected.authorized, true);
  const incrementCapability = JSON.parse(await fs.readFile(capabilityFile)); assert.equal(incrementCapability.development.executionId, opened.executionId); assert.equal(incrementCapability.development.batchId, opened.batchId); assert.equal(incrementCapability.development.repairInputManifestSha256, opened.sourceManifestSha256);
  const nativeBinding = await resolveDevelopmentBatchBinding(incrementCapability.development, state); assert.equal(nativeBinding.batchId, opened.batchId); assert.equal(incrementCapability.development.repairOfExecutionId, coreTask.execution.id);
  await fs.writeFile(path.join(workspace, 'index.html'), '<!doctype html><title>core plus increment</title>\n');
  await controller.store.mutate(initial.taskId, (task) => controller.helpers.event(task, 'integration.observation', 'increment developer done', { type: 'TASK_DONE', actor: 'developer', sourceTaskId: 'dev-increment', binding: { executionId: task.execution.id }, changedFiles: ['index.html'], entryFile: 'index.html' }));
  const incrementCandidate = await controller.hostCheck(initial.taskId); assert.equal(incrementCandidate.autoReview.sourceTaskId, 'dev-increment');
  const after = await controller.store.get(initial.taskId); assert.equal(after.approvals.find((entry) => entry.artifactId === coreArtifact.id).status, 'confirmed'); assert.equal(after.events.filter((entry) => entry.type === 'integration.review_dispatch_reserved').length, 1);
  await fs.writeFile(path.join(workspace, 'index.html'), '<!doctype html><title>stale</title>\n'); await assert.rejects(controller.assertRegisteredExecutionCurrent(initial.taskId), /stale/);
});

test('controlled automatic-review dispatch failure preserves Developer bytes and enables only explicit review-only reuse', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-auto-review-failure-'))), workspace = path.join(root, 'workspace'), tasks = path.join(root, 'tasks'), state = path.join(root, 'state');
  await Promise.all([fs.mkdir(workspace), fs.mkdir(tasks), fs.mkdir(state)]); const material = path.join(root, 'article.txt'); await fs.writeFile(material, 'Synthetic.\n');
  const projectFile = path.join(root, 'project.json'), capabilityFile = path.join(state, 'model-capability.json'), ledgerFile = path.join(state, 'development-01/model-ledger.json'), goalDraft = { statement: 'Build.', successCriteria: ['works'], boundaries: ['static'] };
  await fs.writeFile(projectFile, JSON.stringify({ id: 'article-learning-12', taskId: 'task-auto-failure', title: 'Auto review fixture', workspace, goalDraft, requirementsStatus: 'ready', material: { path: material, sha256: 'a'.repeat(64) } }));
  await fs.mkdir(path.dirname(ledgerFile)); await fs.writeFile(capabilityFile, JSON.stringify({ projectId: 'article-learning-12', goalVersionId: null, candidateSha256: null, development: { enabled: false, ledgerFile, cap: 2, windowMs: 1200000 }, learning: { enabled: false, ledgerFile: path.join(state, 'learning-01/model-ledger.json') } }));
  const intake = await createIntakeController({ tasksRoot: tasks, irixiAppRoot: APP_ROOT, taskId: 'task-auto-failure' }); await intake.ensureTask(); const controller = await createArticleProjectController({ tasksRoot: tasks, irixiAppRoot: APP_ROOT, projectFile, capabilityFile }), before = await intake.read();
  const goal = await controller.confirmGoal(before.taskId, { expectedGoalVersionId: before.goal.id, ...goalDraft }); await controller.authorize(before.taskId, goal.id); await fs.writeFile(path.join(workspace, 'index.html'), '<!doctype html>\n');
  await controller.store.mutate(before.taskId, (task) => { task.execution.increment = { optInBoundedAutoReview: true }; controller.helpers.event(task, 'integration.run_reserved', 'developer reserved', { actor: 'developer', sourceTaskId: 'dev-auto', executionId: task.execution.id }); controller.helpers.event(task, 'integration.observation', 'developer done', { type: 'TASK_DONE', actor: 'developer', sourceTaskId: 'dev-auto', binding: { executionId: task.execution.id }, changedFiles: ['index.html'], entryFile: 'index.html' }); });
  const checked = await controller.hostCheck(before.taskId), task = await controller.store.get(before.taskId), dispatch = task.events.findLast((entry) => entry.type === 'integration.review_dispatch_reserved');
  const cap = JSON.parse(await fs.readFile(capabilityFile)); cap.development.executionId = task.execution.id; await fs.writeFile(capabilityFile, JSON.stringify(cap));
  const output = 'STATUS: done\nFILES_CHANGED:\nindex.html\n', outputSha = crypto.createHash('sha256').update(output).digest('hex'); await fs.mkdir(path.join(path.dirname(ledgerFile), 'call-1')); await fs.writeFile(path.join(path.dirname(ledgerFile), 'call-1/stdout.log'), output);
  const ledger = { cap: 2, windowMs: 1200000, deadlineAt: new Date(Date.now() - 1).toISOString(), calls: [{ expectedRole: 'developer', status: 'completed', exitCode: 0, signal: null, declaredStatus: 'done', stdout: { file: 'call-1/stdout.log', bytes: Buffer.byteLength(output), sha256: outputSha } }], sealed: { at: new Date().toISOString(), reasonCode: 'platform_auto_review_dispatch_failed' } }, ledgerBytes = Buffer.from(JSON.stringify(ledger)); await fs.writeFile(ledgerFile, ledgerBytes);
  const request = { acknowledgement: 'preserve_auto_review_dispatch_failure', expectedGoalVersionId: goal.id, expectedExecutionId: task.execution.id, expectedCandidateSha256: checked.candidate.candidateSha256, expectedLedgerSha256: crypto.createHash('sha256').update(ledgerBytes).digest('hex'), expectedDispatchEventId: dispatch.id };
  await assert.rejects(controller.recordAutoReviewDispatchFailure(before.taskId, { ...request, expectedCandidateSha256: '0'.repeat(64) }), /stale/); await controller.store.mutate(before.taskId, (current) => controller.helpers.event(current, 'integration.run_reserved', 'bad reviewer', { actor: 'reviewer', executionId: current.execution.id })); await assert.rejects(controller.recordAutoReviewDispatchFailure(before.taskId, request), /stale/);
  await controller.store.mutate(before.taskId, (current) => { current.events = current.events.filter((entry) => !(entry.type === 'integration.run_reserved' && entry.detail?.actor === 'reviewer')); controller.helpers.event(current, 'integration.observation', 'reviewer started without reservation fixture', { type: 'TASK_STARTED', actor: 'reviewer', sourceTaskId: 'review-fixture', binding: { executionId: current.execution.id, candidateSha256: checked.candidate.candidateSha256 } }); });
  const activityTaskBefore = await fs.readFile(path.join(tasks, before.taskId, 'task.json')), activityCapBefore = await fs.readFile(capabilityFile), activityLedgerBefore = await fs.readFile(ledgerFile);
  await assert.rejects(controller.recordAutoReviewDispatchFailure(before.taskId, request), /stale/); assert.deepEqual(await fs.readFile(path.join(tasks, before.taskId, 'task.json')), activityTaskBefore); assert.deepEqual(await fs.readFile(capabilityFile), activityCapBefore); assert.deepEqual(await fs.readFile(ledgerFile), activityLedgerBefore);
  await controller.store.mutate(before.taskId, (current) => { current.events = current.events.filter((entry) => !(entry.type === 'integration.observation' && entry.detail?.actor === 'reviewer')); }); const recorded = await controller.recordAutoReviewDispatchFailure(before.taskId, request); assert.equal(recorded.reviewerCalls, 0);
  const stopped = await controller.store.get(before.taskId); assert.equal(stopped.execution.stopReason, 'permanent_error'); assert.equal(stopped.artifacts.at(-1).autoReviewDispatch.failed, true); const proposal = (await controller.state(before.taskId)).repairProposal; assert.equal(proposal.reviewOnlyAvailable, true); const opened = await controller.openRepairBatch(before.taskId, { ...proposal, reviewOnly: true }); assert.equal(opened.maxNativeCalls, 1); assert.equal(opened.candidateSha256, checked.candidate.candidateSha256);
});

// Private installation/history replay is retained only in the development workspace.

// Private installation/history replay is retained only in the development workspace.

// Private installation/history replay is retained only in the development workspace.

// Private installation/history replay is retained only in the development workspace.

// Private installation/history replay is retained only in the development workspace.

// Private installation/history replay is retained only in the development workspace.

// Private installation/history replay is retained only in the development workspace.

// Private installation/history replay is retained only in the development workspace.

// Private installation/history replay is retained only in the development workspace.

// Private installation/history replay is retained only in the development workspace.

// Private installation/history replay is retained only in the development workspace.

// Private installation/history replay is retained only in the development workspace.

// Private installation/history replay is retained only in the development workspace.

// Private installation/history replay is retained only in the development workspace.

// Private installation/history replay is retained only in the development workspace.

// Private installation/history replay is retained only in the development workspace.

// Private installation/history replay is retained only in the development workspace.

// Private installation/history replay is retained only in the development workspace.

test('controlled fixture preserves a failed batch and explicitly opens a bound repair batch', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-article-repair-')));
  const workspace = path.join(root, 'workspace'), tasks = path.join(root, 'tasks'), state = path.join(root, 'state');
  await Promise.all([fs.mkdir(workspace), fs.mkdir(tasks), fs.mkdir(state)]);
  const material = path.join(root, 'article.txt'); await fs.writeFile(material, 'Synthetic article.\n');
  const projectFile = path.join(root, 'project.json'), capabilityFile = path.join(state, 'model-capability.json'), development01 = path.join(state, 'development-01', 'model-ledger.json');
  const goalDraft = { statement: 'Repair a bounded static candidate.', successCriteria: ['index exists'], boundaries: ['static files only'] };
  await fs.writeFile(projectFile, JSON.stringify({ id: 'article-learning-12', taskId: 'task-repair', title: 'Repair fixture', workspace, goalDraft, requirementsStatus: 'ready', teachingImplementationStarted: false, material: { path: material, sha256: 'c'.repeat(64) } }));
  await fs.mkdir(path.dirname(development01));
  const priorLedger = `${JSON.stringify({ version: 1, trialId: 'fixture-development-01', cap: 2, windowMs: 1200000, calls: [{ status: 'completed', exitCode: 0, signal: null }], sealed: { at: new Date().toISOString(), reasonCode: 'fixture_failure' } }, null, 2)}\n`;
  await fs.writeFile(development01, priorLedger);
  await fs.writeFile(capabilityFile, JSON.stringify({ schemaVersion: 1, projectId: 'article-learning-12', goalVersionId: null, candidateSha256: null, phase: 'blocked', development: { enabled: false, ledgerFile: development01, cap: 2, windowMs: 1200000 }, learning: { enabled: false, cap: 2, windowMs: 1200000, ledgerFile: path.join(state, 'learning-01', 'model-ledger.json') } }));
  const intake = await createIntakeController({ tasksRoot: tasks, irixiAppRoot: APP_ROOT, taskId: 'task-repair' }); await intake.ensureTask();
  const controller = await createArticleProjectController({ tasksRoot: tasks, irixiAppRoot: APP_ROOT, projectFile, capabilityFile });
  const before = await intake.read(), goal = await controller.confirmGoal(before.taskId, { expectedGoalVersionId: before.goal.id, ...goalDraft });
  await controller.authorize(before.taskId, goal.id);
  await fs.writeFile(path.join(workspace, 'index.html'), `<!doctype html><title>failed output</title>\n${'x'.repeat(55_132)}`);
  await fs.mkdir(path.join(workspace, '.impeccable', 'build'), { recursive: true }); await fs.writeFile(path.join(workspace, '.impeccable', 'build', 'pending.json'), '{}\n');
  const failedExecutionId = (await controller.store.get(before.taskId)).execution.id;
  await controller.recordNativeFailure(before.taskId, 'developer', 'fixture-dev-failed');
  const cap = JSON.parse(await fs.readFile(capabilityFile)); cap.development.enabled = false; await fs.writeFile(capabilityFile, JSON.stringify(cap));
  const changedProject = JSON.parse(await fs.readFile(projectFile)); changedProject.goalDraft.successCriteria.push('New cumulative achievement table requirement'); await fs.writeFile(projectFile, JSON.stringify(changedProject));
  const blocked = await controller.state(before.taskId); assert.equal(blocked.repairProposal, null); assert.equal(blocked.current, false); assert.match(blocked.repairBlockedReason, /新增需求尚未通过产品确认目标/);
  await assert.rejects(controller.openRepairBatch(before.taskId, { expectedGoalVersionId: goal.id, expectedFailedExecutionId: failedExecutionId, expectedScopeFingerprint: blocked.scopeFingerprint, expectedPriorLedgerSha256: crypto.createHash('sha256').update(priorLedger).digest('hex'), expectedSourceSnapshotSha256: '0'.repeat(64), acknowledgement: 'preserve_failed_batch', maxModelCalls: 2, maxDurationMs: 1200000 }), /新增需求尚未通过产品确认目标/);
  changedProject.goalDraft = goalDraft; await fs.writeFile(projectFile, JSON.stringify(changedProject));
  const proposal = (await controller.state(before.taskId)).repairProposal; assert.equal(proposal.expectedFailedExecutionId, failedExecutionId);
  await assert.rejects(controller.openRepairBatch(before.taskId, { ...proposal, reviewOnly: true, expectedCandidateSha256: '0'.repeat(64) }), /stale or unsupported|source\/framing limits/);
  await assert.rejects(controller.openRepairBatch(before.taskId, { ...proposal, expectedGoalVersionId: 'stale-goal' }), /stale/);
  const failedIndex = await fs.readFile(path.join(workspace, 'index.html'));
  await fs.writeFile(path.join(workspace, 'index.html'), '<!doctype html><title>changed after proposal</title>\n');
  await assert.rejects(controller.openRepairBatch(before.taskId, proposal), /stale/);
  await assert.rejects(fs.access(path.join(state, 'development-02')));
  await fs.writeFile(path.join(workspace, 'index.html'), failedIndex);
  const opened = await controller.openRepairBatch(before.taskId, proposal);
  assert.equal(opened.batchId, 'development-02'); assert.notEqual(opened.executionId, failedExecutionId);
  assert.match(opened.registeredExecution.prompt, /IRIXI_DEVELOPMENT_BATCH: development-02/);
  assert.match(opened.registeredExecution.prompt, new RegExp(`IRIXI_REPAIR_OF_EXECUTION_ID: ${failedExecutionId}`));
  assert.equal((await fs.readFile(development01, 'utf8')), priorLedger);
  assert.equal(JSON.parse(await fs.readFile(path.join(state, 'development-02', 'repair-input-manifest.json'))).some((entry) => entry.path === '.impeccable/build/pending.json' && entry.trust === 'untrusted-metadata'), true);
  assert.deepEqual(await fs.readFile(path.join(state, 'development-02', 'prior-failed-workspace', 'index.html')), failedIndex);
  assert.equal(await fs.readFile(path.join(state, 'development-02', 'prior-failed-workspace', '.impeccable', 'build', 'pending.json'), 'utf8'), '{}\n');
  await assert.rejects(fs.access(opened.ledgerFile)); // Only a later native call creates this ledger.
  const repairedTask = await controller.store.get(before.taskId); assert.equal(repairedTask.executionHistory.at(-1).id, failedExecutionId);
  assert.equal(repairedTask.executionHistory.at(-1).phase, 'failed');
  assert.equal(repairedTask.executionHistory.at(-1).stopReason, 'permanent_error');
  assert.equal(repairedTask.execution.limits.maxModelCalls, 2);
  assert.equal(repairedTask.execution.limits.maxDurationMs, 1200000);
  assert.equal(repairedTask.execution.phase, 'planned'); assert.equal(repairedTask.execution.startedAt, null); assert.equal(repairedTask.execution.deadlineAt, null);
  assert.equal(repairedTask.execution.repair.sourceManifestSha256, opened.repairInputManifestSha256);
  assert.equal(repairedTask.events.some((entry) => entry.type === 'project.repair_scope_accepted' && entry.detail?.executionId === opened.executionId), true);
  await controller.assertRepairInputCurrent(before.taskId);
  await fs.writeFile(path.join(workspace, 'index.html'), '<!doctype html><title>changed after authorization</title>\n');
  await assert.rejects(controller.assertRepairInputCurrent(before.taskId), /changed after explicit authorization/);
  await fs.writeFile(path.join(workspace, 'index.html'), failedIndex);
  const reader = await createAuthorityReader({ tasksRoot: tasks, taskId: before.taskId, irixiAppRoot: APP_ROOT });
  const preparedProjection = (await reader.read()).projection;
  const binding = { taskId: preparedProjection.taskId, goalVersionId: preparedProjection.goalVersionId, taskInputBindingSha256: preparedProjection.taskInputBindingSha256, pipelineBindingSha256: preparedProjection.pipelineBindingSha256, executionId: preparedProjection.execution.id, workspaceScopeFingerprint: preparedProjection.workspace.scopeFingerprint, sourceSnapshotSha256: preparedProjection.workspace.sourceSnapshotSha256, artifactId: null, artifactVersion: null, candidateSha256: null, diffSha256: null, authoritySnapshotSha256: preparedProjection.authoritySha256, sourceTaskId: 'fixture-repair-dev' };
  await reader.reserveRun({ actor: 'developer', sourceTaskId: 'fixture-repair-dev', binding, promptSha256: opened.registeredExecution.promptSha256 });
  const startedTask = await controller.store.get(before.taskId); assert.equal(startedTask.execution.phase, 'executing'); assert.ok(startedTask.execution.startedAt); assert.ok(startedTask.execution.deadlineAt);
  await fs.rm(path.join(workspace, '.impeccable'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'index.html'), '<!doctype html><title>bounded repaired output</title>\n');
  await controller.store.mutate(before.taskId, (task) => controller.helpers.event(task, 'integration.observation', 'controlled repair developer done', { type: 'TASK_DONE', actor: 'developer', sourceTaskId: 'fixture-repair-dev', binding: { executionId: task.execution.id }, changedFiles: ['index.html'] }));
  const checked = await controller.hostCheck(before.taskId); assert.equal(checked.passed, true);
  const awaiting = await controller.store.get(before.taskId);
  assert.equal(awaiting.status, 'waiting_user');
  assert.equal(awaiting.activeRole, 'reviewer');
  assert.equal(awaiting.artifacts.at(-1).status, 'candidate');
  assert.equal(awaiting.reviews.length, 0);
  assert.equal(awaiting.approvals.length, 0);
  const reviewerText = '**VERDICT:** FAIL\n\n**ISSUES:**\n1. CONTRACT: exact controlled defect.\n\n**SUMMARY:** rejected candidate.\n';
  await fs.mkdir(path.join(state, 'development-02', 'call-2')); await fs.writeFile(path.join(state, 'development-02', 'call-2', 'stdout.log'), reviewerText);
  await fs.writeFile(path.join(state, 'development-02', 'model-ledger.json'), JSON.stringify({ version: 1, trialId: 'fixture-development-02', cap: 2, windowMs: 1200000, calls: [{ expectedRole: 'developer', status: 'completed' }, { expectedRole: 'reviewer', status: 'completed', declaredStatus: 'failed', semanticFailureReason: 'native_reviewer_not_passed', stdout: { file: 'call-2/stdout.log', sha256: crypto.createHash('sha256').update(reviewerText).digest('hex') } }], sealed: { at: new Date().toISOString(), reasonCode: 'native_reviewer_not_passed' } }));
  await controller.store.mutate(before.taskId, (task) => { controller.helpers.event(task, 'integration.run_reserved', 'controlled reviewer reservation', { actor: 'reviewer', sourceTaskId: 'fixture-review-fail', executionId: task.execution.id, candidateSha256: checked.candidate.candidateSha256 }); return controller.helpers.event(task, 'integration.observation', 'controlled reviewer started', { type: 'TASK_STARTED', actor: 'reviewer', sourceTaskId: 'fixture-review-fail', binding: { executionId: task.execution.id, candidateSha256: checked.candidate.candidateSha256 } }); });
  await controller.recordNativeFailure(before.taskId, 'reviewer', 'fixture-review-fail');
  const rejectedTask = await controller.store.get(before.taskId); assert.equal(rejectedTask.artifacts.at(-1).status, 'rejected'); assert.equal(rejectedTask.reviews.at(-1).nativeVerdict, 'FAIL'); assert.equal(rejectedTask.reviews.at(-1).scopeOutcome, 'contract_failed');
  const repair03Proposal = (await controller.state(before.taskId)).repairProposal, opened03 = await controller.openRepairBatch(before.taskId, repair03Proposal);
  assert.equal(opened03.batchId, 'development-03'); assert.match(opened03.registeredExecution.prompt, /exact controlled defect/);
});

test('controlled host client failure binds exact evidence and rejects stale or active inputs', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-host-client-failure-'))), workspace = path.join(root, 'workspace'), tasks = path.join(root, 'tasks'), state = path.join(root, 'state'), evidenceDir = path.join(root, 'evidence');
  await Promise.all([fs.mkdir(workspace), fs.mkdir(tasks), fs.mkdir(state), fs.mkdir(evidenceDir)]);
  const material = path.join(root, 'article.txt'); await fs.writeFile(material, 'Synthetic.\n');
  const projectFile = path.join(root, 'project.json'), capabilityFile = path.join(state, 'model-capability.json'), ledgerFile = path.join(state, 'development-01', 'model-ledger.json');
  const goalDraft = { statement: 'Host-check a static client.', successCriteria: ['client persists judgment'], boundaries: ['zero model host check'] };
  await fs.writeFile(projectFile, JSON.stringify({ id: 'article-learning-12', taskId: 'task-host-client', title: 'Host client fixture', workspace, goalDraft, requirementsStatus: 'ready', teachingImplementationStarted: false, material: { path: material, sha256: 'd'.repeat(64) } }));
  await fs.writeFile(capabilityFile, JSON.stringify({ schemaVersion: 1, projectId: 'article-learning-12', goalVersionId: null, candidateSha256: null, phase: 'blocked', development: { enabled: false, ledgerFile, cap: 2, windowMs: 1200000 }, learning: { enabled: false, cap: 2, windowMs: 1200000, ledgerFile: path.join(state, 'learning-01', 'model-ledger.json') } }));
  const intake = await createIntakeController({ tasksRoot: tasks, irixiAppRoot: APP_ROOT, taskId: 'task-host-client' }); await intake.ensureTask();
  const controller = await createArticleProjectController({ tasksRoot: tasks, irixiAppRoot: APP_ROOT, projectFile, capabilityFile }), before = await intake.read();
  const goal = await controller.confirmGoal(before.taskId, { expectedGoalVersionId: before.goal.id, ...goalDraft }); await controller.authorize(before.taskId, goal.id);
  await fs.writeFile(path.join(workspace, 'index.html'), '<!doctype html>\n'); await fs.writeFile(path.join(workspace, 'app.js'), 'export const app=true;\n'); await fs.writeFile(path.join(workspace, 'core.js'), 'export const core=true;\n');
  await controller.store.mutate(before.taskId, (task) => { controller.helpers.event(task, 'integration.run_reserved', 'developer reserved', { actor: 'developer', sourceTaskId: 'dev-host-client', executionId: task.execution.id }); return controller.helpers.event(task, 'integration.observation', 'developer done', { type: 'TASK_DONE', actor: 'developer', sourceTaskId: 'dev-host-client', binding: { executionId: task.execution.id }, changedFiles: ['app.js'] }); });
  const checked = await controller.hostCheck(before.taskId), task = await controller.store.get(before.taskId), evidenceFile = 'development-15-bound-native-client-failure.json';
  const boundCap = JSON.parse(await fs.readFile(capabilityFile)); boundCap.development.executionId = task.execution.id; await fs.writeFile(capabilityFile, JSON.stringify(boundCap));
  const evidence = { candidateSha256: checked.candidate.candidateSha256, appSha256: crypto.createHash('sha256').update(await fs.readFile(path.join(workspace, 'app.js'))).digest('hex'), coreSha256: crypto.createHash('sha256').update(await fs.readFile(path.join(workspace, 'core.js'))).digest('hex'), passed: false, sourceUnchanged: true, nativeModelCalls: 0, actualBrowser: false };
  const evidenceBytes = Buffer.from(`${JSON.stringify(evidence)}\n`); await fs.writeFile(path.join(evidenceDir, evidenceFile), evidenceBytes); const evidenceSha256 = crypto.createHash('sha256').update(evidenceBytes).digest('hex');
  const developerOutput = 'STATUS: done\nFILES_CHANGED:\napp.js\n';
  const baseLedger = { version: 1, cap: 2, windowMs: 1200000, calls: [{ expectedRole: 'developer', status: 'completed', exitCode: 0, signal: null, declaredStatus: 'done', stdout: { file: 'call-1/stdout.log', bytes: Buffer.byteLength(developerOutput), sha256: crypto.createHash('sha256').update(developerOutput).digest('hex') } }], sealed: { reasonCode: 'host_native_client_check_failed' } };
  await fs.mkdir(path.join(path.dirname(ledgerFile), 'call-1'), { recursive: true }); await fs.writeFile(path.join(path.dirname(ledgerFile), 'call-1', 'stdout.log'), developerOutput); await fs.writeFile(ledgerFile, JSON.stringify(baseLedger));
  const input = { expectedGoalVersionId: goal.id, expectedExecutionId: task.execution.id, expectedCandidateSha256: checked.candidate.candidateSha256, evidenceFile, evidenceSha256 };
  await assert.rejects(controller.recordHostClientFailure(before.taskId, { ...input, evidenceSha256: '0'.repeat(64) }), /does not prove/);
  await assert.rejects(controller.recordHostClientFailure(before.taskId, { ...input, expectedCandidateSha256: '1'.repeat(64) }), /does not prove|stale/);
  await fs.writeFile(ledgerFile, JSON.stringify({ ...baseLedger, calls: [...baseLedger.calls, { expectedRole: 'reviewer', status: 'running' }] })); await assert.rejects(controller.recordHostClientFailure(before.taskId, input), /Developer-only/);
  await fs.writeFile(ledgerFile, JSON.stringify({ ...baseLedger, sealed: null })); await assert.rejects(controller.recordHostClientFailure(before.taskId, input), /Developer-only/);
  await fs.writeFile(ledgerFile, JSON.stringify(baseLedger)); const recorded = await controller.recordHostClientFailure(before.taskId, input); assert.equal(recorded.recorded, true);
  const stopped = await controller.store.get(before.taskId); assert.equal(stopped.execution.phase, 'failed'); assert.equal(stopped.execution.stopReason, 'permanent_error'); assert.equal(stopped.artifacts.at(-1).status, 'rejected'); assert.equal(stopped.events.at(-1).type, 'integration.host_client_check_failed');
  const cap = JSON.parse(await fs.readFile(capabilityFile)); assert.equal(cap.development.enabled, false); assert.equal(cap.learning.enabled, false);
  const proposal = (await controller.state(before.taskId)).repairProposal; assert.equal(proposal.reviewOnlyAvailable, true); assert.equal(proposal.expectedCandidateSha256, checked.candidate.candidateSha256);
  const wrongCap = structuredClone(cap); wrongCap.candidateSha256 = '2'.repeat(64); await fs.writeFile(capabilityFile, JSON.stringify(wrongCap)); assert.equal((await controller.state(before.taskId)).repairProposal.reviewOnlyAvailable, undefined); await fs.writeFile(capabilityFile, JSON.stringify(cap));
  await fs.writeFile(ledgerFile, JSON.stringify({ ...baseLedger, calls: [{ ...baseLedger.calls[0], exitCode: 1 }] })); assert.equal((await controller.state(before.taskId)).repairProposal.reviewOnlyAvailable, undefined); await fs.writeFile(ledgerFile, JSON.stringify(baseLedger));
  const originalApp = await fs.readFile(path.join(workspace, 'app.js')); await fs.writeFile(path.join(workspace, 'app.js'), 'changed bytes\n'); assert.equal((await controller.state(before.taskId)).repairProposal.reviewOnlyAvailable, undefined); await fs.writeFile(path.join(workspace, 'app.js'), originalApp);
  const opened = await controller.openRepairBatch(before.taskId, { ...proposal, reviewOnly: true }); assert.equal(opened.reviewOnly, true); assert.equal(opened.maxNativeCalls, 1); assert.equal(opened.candidateSha256, checked.candidate.candidateSha256); assert.equal(opened.registeredExecution, null);
  const reused = await controller.store.get(before.taskId); assert.deepEqual(reused.artifacts.at(-1).projectCandidate.changes, ['app.js', 'core.js', 'index.html']); assert.deepEqual(reused.artifacts.at(-1).projectCandidate.reportedChangedFiles, ['app.js']);
});
