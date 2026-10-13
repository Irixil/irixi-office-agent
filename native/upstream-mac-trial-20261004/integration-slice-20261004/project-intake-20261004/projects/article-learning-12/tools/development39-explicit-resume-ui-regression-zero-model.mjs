#!/usr/bin/env node
// Zero-model acceptance gate for an explicit continuation after a terminal
// invalid assessment. It executes the real frozen product scripts in the
// development36 controlled DOM/API fixture, while correcting only weaknesses
// in that older observer. It never calls a product API, browser, or model.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const project = path.resolve(import.meta.dirname, '..');
const frozenHarness = path.join(project, 'tools/development36-explicit-resume-ui-regression-zero-model.mjs');
const adapter = path.join(project, 'tools/native-client-vm-adapter.mjs');
let source = fs.readFileSync(frozenHarness, 'utf8');

source = source.replace(
  "import { executeNativeApp } from './native-client-vm-adapter.mjs';",
  `import { executeNativeApp } from ${JSON.stringify(pathToFileURL(adapter).href)};`,
).replace(
  "const project = path.resolve(import.meta.dirname, '..');",
  `const project = ${JSON.stringify(project)};`,
);

const readerStart = source.indexOf('function preparedFacts(value) {');
const readerEnd = source.indexOf('\nfunction preparedRows(record) {', readerStart);
if (readerStart < 0 || readerEnd < 0) throw new Error('Frozen harness prepared reader was not found');
const strictReader = `function preparedFacts(value) {
  if (!value || typeof value !== 'object') return null;
  const idAliases = ['turnId','preparedTurnId','pendingTurnId','newTurnId'].filter(key =>
    Object.hasOwn(value, key) && typeof value[key] === 'string' && value[key]);
  if (idAliases.length !== 1) return null;
  const turnId = value[idAliases[0]];
  const sourceValues = [value.questionSourceTurnId, value.sourceTurnId, value.context?.questionSourceTurnId,
    value.requestBody?.payload?.learnerEntry?.questionSourceTurnId].filter(item => typeof item === 'string' && item);
  const questionValues = [value.question, value.context?.question,
    value.requestBody?.payload?.learnerEntry?.question].filter(item => typeof item === 'string' && item);
  const materialValues = [value.materialEventId, value.currentMaterialEventId,
    value.context?.materialEventId].filter(item => typeof item === 'string' && item);
  if (new Set(sourceValues).size !== 1 || new Set(questionValues).size !== 1 || new Set(materialValues).size !== 1) return null;
  const status = value.status || 'prepared';
  if (!['prepared','pending'].includes(status) || turnId === invalidTurnId || sourceValues[0] !== sourceTurnId ||
      questionValues[0] !== raw.activityQualification.question || materialValues[0] !== currentMaterialEventId) return null;
  return { turnId, sourceTurnId: sourceValues[0], question: questionValues[0], materialEventId: materialValues[0], status };
}`;
source = source.slice(0, readerStart) + strictReader + source.slice(readerEnd);

source = source.replace(
  'const body = JSON.parse(init.body); http.statePuts.push(structuredClone(body));',
  `const body = JSON.parse(init.body); http.statePuts.push(structuredClone(body));
      if (delays.rejectStatePut) return reply(409, { error: 'controlled rejected current CAS' });`,
);

source = source.replace(
  "    assert.ok(continuationMarkup, 'Candidate is missing #continueInvalidRetest[data-irixi-explicit-retest]');",
  `    assert.ok(continuationMarkup, 'Candidate is missing #continueInvalidRetest[data-irixi-explicit-retest]');
    const aliasBase = { status: 'prepared', sourceTurnId, question: raw.activityQualification.question,
      currentMaterialEventId };
    const acceptedAliases = ['turnId','preparedTurnId','pendingTurnId','newTurnId'].map(alias =>
      preparedFacts({ ...aliasBase, [alias]: 'fresh-' + alias }));
    check('prepared_reader_accepts_each_single_registered_id_alias_with_exact_binding',
      acceptedAliases.every(Boolean) && new Set(acceptedAliases.map(row => row.turnId)).size === 4,
      { acceptedAliases });
    const readerNegatives = {
      conflictingAliases: preparedFacts({ ...aliasBase, turnId: 'one', preparedTurnId: 'two' }),
      oldInvalidId: preparedFacts({ ...aliasBase, turnId: invalidTurnId }),
      wrongSource: preparedFacts({ ...aliasBase, turnId: 'wrong-source', sourceTurnId: 'forged' }),
      wrongQuestion: preparedFacts({ ...aliasBase, turnId: 'wrong-question', question: 'unrelated question' }),
      wrongMaterial: preparedFacts({ ...aliasBase, turnId: 'wrong-material', currentMaterialEventId: 'other-material' }),
      conflictingNestedSource: preparedFacts({ ...aliasBase, turnId: 'conflicting-source', context: { questionSourceTurnId: 'forged' } }),
    };
    check('prepared_reader_rejects_alias_source_question_material_and_nested_conflicts',
      Object.values(readerNegatives).every(value => value === null), { readerNegatives });`,
);

source = source.replace(
  "    const reopenedPrepared = controlledWorld(afterClick, { currentState: initial.http.currentState, revision: initial.http.revision });",
  `    initial.context.__resumeResponse = { current: true, state: structuredClone(initial.http.currentState),
      material: { ...structuredClone(actual.material), materialEventId: currentMaterialEventId },
      materialEventId: currentMaterialEventId, goalVersionId: currentGoal, candidateSha256: currentCandidate };
    initial.context.__resumeSessionId = afterClick.sessionId;
    const authoritativePrepared = structuredClone(vm.runInContext(
      'LearningAchievements.restoreCurrentResponse(__resumeResponse,__resumeSessionId)', initial.context));
    const reopenedPrepared = controlledWorld(authoritativePrepared,
      { currentState: initial.http.currentState, revision: initial.http.revision, delays: { inferencePostMs: 30 } });`,
);

source = source.replace(
  "    const reopenedSavedPrepared = reopenedPrepared.http.statePuts.length === 0",
  `    check('server_restore_keeps_same_prepared_identity_and_native_submit_enabled',
      restoredPrepared.length === 1 && restoredPrepared[0].turnId === prepared[0].turnId &&
        !reopenedPrepared.get('assessBtn').disabled,
      { prepared: restoredPrepared, assessDisabled: reopenedPrepared.get('assessBtn').disabled });
    const reopenedSavedPrepared = reopenedPrepared.http.statePuts.length === 0`,
);

source = source.replace(
  "    const submitPromises = [\n      ...reopenedPrepared.get('answerForm').emit('submit'),",
  `    const submissionWorld = reopenedPrepared.get('assessBtn').disabled ? initial : reopenedPrepared;
    check('submission_uses_a_natively_enabled_control_without_forced_disabled_form_emit',
      !submissionWorld.get('assessBtn').disabled,
      { usedAuthoritativeRestore: submissionWorld === reopenedPrepared,
        assessDisabled: submissionWorld.get('assessBtn').disabled });
    const submitPromises = [
      ...submissionWorld.get('answerForm').emit('submit'),`,
);

source = source.replace(
  "    for (let i = 0; i < 200 && !reopenedPrepared.stored().turns.some(turn => turn.status === 'running' && turn.turnId === prepared[0]?.turnId); i++) await pause(2);\n    const running = reopenedPrepared.stored(),",
  `    for (let i = 0; i < 200 && !reopenedPrepared.context.state.turns.some(turn =>
      turn.status === 'submitting' && turn.turnId === prepared[0]?.turnId); i++) await pause(1);
    const liveSubmittedTurn = reopenedPrepared.context.state.turns.find(turn => turn.turnId === prepared[0]?.turnId);
    for (let i = 0; i < 200 && !reopenedPrepared.stored().turns.some(turn => turn.status === 'running' && turn.turnId === prepared[0]?.turnId); i++) await pause(2);
    const running = reopenedPrepared.stored(),`,
);

source = source.replace(
  "    check('submitting_running_source_is_exact_and_symmetric', fresh?.status === 'running'",
  `    const liveRunningTurn = reopenedPrepared.context.state.turns.find(turn => turn.turnId === prepared[0]?.turnId);
    check('submitting_to_running_updates_the_same_app_owned_turn_object',
      liveSubmittedTurn && liveSubmittedTurn === liveRunningTurn && liveSubmittedTurn.status === 'running',
      { sameObject: liveSubmittedTurn === liveRunningTurn, status: liveRunningTurn?.status || null });
    check('submitting_running_source_is_exact_and_symmetric', fresh?.status === 'running'`,
);

source = source.replace(
  "\n\n    const parser = vm.createContext({});",
  `

    const uuidAfterDone = vm.runInContext('crypto.randomUUID()', submissionWorld.context);
    check('completed_prepared_identity_is_consumed_and_never_reallocated', uuidAfterDone !== fresh.turnId,
      { completedTurnId: fresh.turnId, nextUuid: uuidAfterDone });

    const rejected = controlledWorld(structuredClone(actual), {
      delays: { materialMs: 5, stateGetMs: 5, statePutMs: 5, rejectStatePut: true },
    });
    await pause(30);
    for (const key of ['requests','inferencePosts','inferenceGets','materialPosts','statePuts','stateGets']) rejected.http[key].length = 0;
    const rejectedControl = rejected.get('continueInvalidRetest');
    const rejectedBefore = canonical(rejected.read());
    await rejected.emit(rejectedControl, 'click');
    await pause(30);
    const rejectedAfter = rejected.read();
    check('cas_rejection_restores_prior_local_bytes_and_keeps_continuation_available_without_inference',
      canonical(rejectedAfter) === rejectedBefore && preparedRows(rejectedAfter).length === 0 &&
        !rejectedControl.hidden && !rejectedControl.disabled && rejected.http.inferencePosts.length === 0,
      { localBytesRestored: canonical(rejectedAfter) === rejectedBefore,
        prepared: preparedRows(rejectedAfter), controlHidden: rejectedControl.hidden,
        controlDisabled: rejectedControl.disabled, stateGets: rejected.http.stateGets.length,
        statePuts: rejected.http.statePuts.length, inferencePosts: rejected.http.inferencePosts.length });

    const parser = vm.createContext({});`,
);

const submissionStart = source.indexOf('    const submissionWorld =');
const submissionEnd = source.indexOf('\n\n    const uuidAfterDone', submissionStart);
if (submissionStart < 0 || submissionEnd < 0) throw new Error('Submission acceptance segment was not found');
let submissionSegment = source.slice(submissionStart, submissionEnd).replaceAll('reopenedPrepared', 'submissionWorld');
submissionSegment = submissionSegment.replace(
  "const submissionWorld = submissionWorld.get('assessBtn').disabled ? initial : submissionWorld;",
  "const submissionWorld = reopenedPrepared.get('assessBtn').disabled ? initial : reopenedPrepared;",
);
source = source.slice(0, submissionStart) + submissionSegment + source.slice(submissionEnd);

source = source.replace(
  "  report.companionGates = [",
  `  report.gateVersion = 'development39-v1';
  report.observerCorrections = [
    'strict registered prepared ID aliases',
    'authoritative server-record restore',
    'native enabled-control assertion before submit',
    'same app-owned turn object submitting-to-running assertion',
    'direct CAS rejection rollback assertion',
    'completed prepared ID consumption assertion',
  ];
  report.companionGates = [`,
);

const argv = process.argv.slice(2);
const arg = name => { const index = argv.indexOf(name); return index < 0 ? null : argv[index + 1]; };
const workspace = arg('--workspace');
const evidence = arg('--evidence');
const mode = arg('--mode');
if (!workspace || !evidence || !['baseline','candidate'].includes(mode))
  throw new Error('Use --workspace frozen-source --mode baseline|candidate --evidence new-file.json');
process.argv = ['node', 'development39-gate', '--workspace', path.resolve(workspace), '--mode', mode,
  '--evidence', path.resolve(evidence)];
await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
