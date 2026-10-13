#!/usr/bin/env node
// Stage41 zero-network VM gate. It layers the one new acceptance condition —
// a completed replacement permanently disposes only its exact failed turn —
// over the frozen development39-v2 workflow without changing that gate.
// baseline runs the exact development40 source and expects the known blocker;
// selfcheck applies an in-memory relationship-only control; candidate requires
// the product source itself to satisfy the behavior.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const arg = name => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
const workspace = path.resolve(arg('--workspace') || '');
const evidence = path.resolve(arg('--evidence') || '');
const requestedMode = arg('--mode');
if (!workspace || !evidence || !['baseline', 'selfcheck', 'candidate'].includes(requestedMode))
  throw new Error('Use --workspace source --mode baseline|selfcheck|candidate --evidence new.json');

const project = path.resolve(import.meta.dirname, '..');
const v1 = path.join(project, 'tools/development39-explicit-resume-ui-regression-zero-model.mjs');
let source = fs.readFileSync(v1, 'utf8');
source = source.replace(
  "const project = path.resolve(import.meta.dirname, '..');",
  `const project = ${JSON.stringify(project)};`,
);

// Preserve the frozen v2 identity-consumption strengthening.
const priorAssertion = `    const uuidAfterDone = vm.runInContext('crypto.randomUUID()', submissionWorld.context);
    check('completed_prepared_identity_is_consumed_and_never_reallocated', uuidAfterDone !== fresh.turnId,
      { completedTurnId: fresh.turnId, nextUuid: uuidAfterDone });`;
const strengthenedAssertion = `    const uuidAfterDone = vm.runInContext('crypto.randomUUID()', submissionWorld.context);
    const completedLivePrepared = preparedRows(submissionWorld.read());
    const completedSavedPrepared = preparedRows(submissionWorld.stored());
    check('completed_prepared_identity_is_consumed_and_never_reallocated',
      uuidAfterDone !== fresh.turnId && completedLivePrepared.length === 0 && completedSavedPrepared.length === 0,
      { completedTurnId: fresh.turnId, nextUuid: uuidAfterDone,
        completedLivePrepared, completedSavedPrepared });`;
if (!source.includes(priorAssertion)) throw new Error('Frozen v1 completed assertion missing');
source = source.replace(priorAssertion, strengthenedAssertion);

// These transformations must run after v1 has assembled its development36
// source, so append them immediately before v1 imports that assembled source.
// A relationship-only selfcheck proves the observer can pass without changing
// the failed row. It is never used for candidate acceptance.
const nativeAnchor = "  executeNativeApp(context, text(app), 'frozen-app.js');";
const oldBe = 'function be(e,t){return k(e)||e===t||e.status==="invalid"&&t?.failedTurnId===e.turnId}';
const newBe = 'function be(e,t){return k(e)||e===t||e.status==="invalid"&&(t?.failedTurnId===e.turnId||r.turns.some(y=>y.status==="done"&&y.failedTurnId===e.turnId))}';
const oldRecovery = 'function P(){const e=pe();return[...r.turns].reverse().find(t=>!k(t)&&t!==e&&!(t.status==="invalid"&&e?.failedTurnId===t.turnId))}';
const newRecovery = 'function P(){const e=pe();return[...r.turns].reverse().find(t=>!be(t,e)&&t!==e)}';
const nativeReplacement = `  const development41App = ${JSON.stringify(requestedMode)} === 'selfcheck' ? text(app)
    .replace(${JSON.stringify(oldBe)},${JSON.stringify(newBe)})
    .replace(${JSON.stringify(oldRecovery)},${JSON.stringify(newRecovery)})
    .replaceAll('r.turns.every(k)','r.turns.every(e=>be(e,null))') : text(app);
  executeNativeApp(context, development41App, 'frozen-app.js');`;

const doneAnchor = `    check('reopened_running_world_reaches_same_done_turn_with_source', reopenedDoneTurn?.status === 'done'
      && reopenedDoneTurn.context?.questionSourceTurnId === sourceTurnId
      && reopenedDone.assessments.some(row => row.turnId === fresh.turnId),
      { reopenedDone: turnFacts(reopenedDoneTurn), reopenedGets: reopened.http.inferenceGets });`;
const relationChecks = `${doneAnchor}

    const completionRecord = submissionWorld.stored();
    const completionPut = await submissionWorld.context.fetch('/api/irixi-client-state', {
      method: 'PUT', body: canonical({ sessionId: completionRecord.sessionId,
        expectedRevision: submissionWorld.http.revision, expectedGoalVersionId: currentGoal,
        expectedCandidateSha256: currentCandidate, expectedMaterialEventId: currentMaterialEventId,
        state: { schemaVersion: 3, record: completionRecord, cumulative: {} } }) });
    if (!completionPut.ok) throw new Error('Controlled completion CAS failed: ' + completionPut.status);
    for (let i = 0; i < 300 && !submissionWorld.http.currentState?.record?.turns?.some(turn => turn.turnId === fresh.turnId && turn.status === 'done'); i++) await pause(2);
    const serverPersistedDone = Boolean(submissionWorld.http.currentState?.record?.turns?.some(turn => turn.turnId === fresh.turnId && turn.status === 'done'));
    const persistedAfterDone = structuredClone(serverPersistedDone ? submissionWorld.http.currentState.record : submissionWorld.stored());
    const persistedOld = persistedAfterDone.turns.find(turn => turn.turnId === invalidTurnId);
    const persistedReplacement = persistedAfterDone.turns.find(turn => turn.turnId === fresh.turnId);
    const relationWorld = controlledWorld(persistedAfterDone, {
      currentState: { schemaVersion: 3, record: persistedAfterDone, cumulative: {} },
      revision: submissionWorld.http.revision,
    });
    await pause(30);
    relationWorld.context.__development41ConfirmReached = false;
    relationWorld.context.confirm = () => { relationWorld.context.__development41ConfirmReached = true; return false; };
    await relationWorld.emit(relationWorld.get('newSession'), 'click');
    const firstConfirmReached = Boolean(relationWorld.context.__development41ConfirmReached);
    const firstAssessEnabled = !relationWorld.get('assessBtn').disabled;
    const repeatedWorld = controlledWorld(relationWorld.read(), {
      currentState: relationWorld.http.currentState || { schemaVersion: 3, record: relationWorld.read(), cumulative: {} },
      revision: relationWorld.http.revision,
    });
    await pause(30);
    repeatedWorld.context.__development41ConfirmReached = false;
    repeatedWorld.context.confirm = () => { repeatedWorld.context.__development41ConfirmReached = true; return false; };
    await repeatedWorld.emit(repeatedWorld.get('newSession'), 'click');
    const secondConfirmReached = Boolean(repeatedWorld.context.__development41ConfirmReached);
    const secondAssessEnabled = !repeatedWorld.get('assessBtn').disabled;
    const relationshipFacts = {
      failedTurnByteExact: canonical(persistedOld) === canonical(oldInvalid),
      replacementDone: persistedReplacement?.status === 'done', serverPersistedDone,
      replacementFailedTurnId: persistedReplacement?.failedTurnId || null,
      firstAssessEnabled, firstConfirmReached, secondAssessEnabled, secondConfirmReached,
      firstNotice: relationWorld.get('notice').textContent,
      secondNotice: repeatedWorld.get('notice').textContent,
    };
    if (${JSON.stringify(requestedMode)} === 'baseline') {
      check('candidate30_completed_replacement_relationship_gap_is_reproduced',
        relationshipFacts.failedTurnByteExact && relationshipFacts.replacementDone && relationshipFacts.serverPersistedDone &&
          (!firstAssessEnabled || !firstConfirmReached || !secondAssessEnabled || !secondConfirmReached),
        relationshipFacts);
    } else {
      check('completed_replacement_disposes_exact_failed_turn_across_repeated_restore',
        relationshipFacts.failedTurnByteExact && relationshipFacts.replacementDone && relationshipFacts.serverPersistedDone &&
          relationshipFacts.replacementFailedTurnId === invalidTurnId && firstAssessEnabled && firstConfirmReached &&
          secondAssessEnabled && secondConfirmReached,
        relationshipFacts);
    }

    for (const unresolvedStatus of ['pending','running','failed']) {
      const unresolvedRecord = structuredClone(persistedAfterDone);
      const row = unresolvedRecord.turns.find(turn => turn.turnId === fresh.turnId);
      row.status = unresolvedStatus;
      unresolvedRecord.assessments = unresolvedRecord.assessments.filter(item => item.turnId !== fresh.turnId);
      const unresolvedWorld = controlledWorld(unresolvedRecord, {
        currentState: { schemaVersion: 3, record: unresolvedRecord, cumulative: {} }, revision: 1,
      });
      await pause(20);
      unresolvedWorld.context.__development41ConfirmReached = false;
      unresolvedWorld.context.confirm = () => { unresolvedWorld.context.__development41ConfirmReached = true; return false; };
      await unresolvedWorld.emit(unresolvedWorld.get('newSession'), 'click');
      check('replacement_' + unresolvedStatus + '_does_not_dispose_failed_turn',
        !unresolvedWorld.context.__development41ConfirmReached &&
          (unresolvedStatus === 'pending' || unresolvedWorld.get('assessBtn').disabled),
        { status: unresolvedStatus, assessDisabled: unresolvedWorld.get('assessBtn').disabled,
          confirmReached: Boolean(unresolvedWorld.context.__development41ConfirmReached),
          failedTurnByteExact: canonical(unresolvedWorld.read().turns.find(turn => turn.turnId === invalidTurnId)) === canonical(oldInvalid) });
    }`;
const reportReplacement = `report.development41Mode = ${JSON.stringify(requestedMode)};
report.relationshipSelfcheckApplied = ${JSON.stringify(requestedMode === 'selfcheck')};
report.limitations.push('The relationship selfcheck, when selected, modifies app.js only in memory and is not product evidence.');
report.finishedAt = new Date().toISOString();`;
const nestedTransform = [
  `if (!source.includes(${JSON.stringify(nativeAnchor)})) throw new Error('Native app execution anchor missing');`,
  `source = source.replace(${JSON.stringify(nativeAnchor)}, ${JSON.stringify(nativeReplacement)});`,
  `if (!source.includes(${JSON.stringify(doneAnchor)})) throw new Error('Frozen done/reopen anchor missing');`,
  `source = source.replace(${JSON.stringify(doneAnchor)}, ${JSON.stringify(relationChecks)});`,
  `source = source.replace(${JSON.stringify("report.gateVersion = 'development39-v1';")}, ${JSON.stringify("report.gateVersion = 'development41-completed-retest-disposition-vm-v1';")});`,
  `source = source.replace(${JSON.stringify("report.finishedAt = new Date().toISOString();")}, ${JSON.stringify(reportReplacement)});`,
].join('\n');
const v1Import = "await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);";
if (!source.includes(v1Import)) throw new Error('Frozen v1 import anchor missing');
source = source.replace(v1Import, `${nestedTransform}\n${v1Import}`);

process.argv = ['node', 'development41-vm-gate', '--workspace', workspace, '--mode', 'candidate', '--evidence', evidence];
await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
