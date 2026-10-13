#!/usr/bin/env node
// Diagnostic-only replay of the frozen development36 harness. It changes only
// the observer so it recognizes development38's `preparedTurnId` field; no
// product bytes, fixtures, or acceptance expectations are changed.
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
).replace(
  'value.turnId || value.pendingTurnId || value.newTurnId',
  'value.turnId || value.preparedTurnId || value.pendingTurnId || value.newTurnId',
);
source = source.replace(
  'const body = JSON.parse(init.body); http.statePuts.push(structuredClone(body));',
  `const body = JSON.parse(init.body); http.statePuts.push(structuredClone(body));
      if (delays.rejectStatePut) return reply(409, { error: 'controlled rejected current CAS' });`,
);
source = source.replace(
  "\n\n    reopenedPrepared.get('questionType').value",
  `

    check('diagnostic_reopen_has_native_clickable_submit_or_continuation_path',
      !reopenedPrepared.get('assessBtn').disabled ||
        (!reopenedPrepared.get('invalidRetestActions').hidden && !reopenedPrepared.get('continueInvalidRetest').disabled),
      { assessDisabled: reopenedPrepared.get('assessBtn').disabled,
        continuationHidden: reopenedPrepared.get('invalidRetestActions').hidden,
        continuationDisabled: reopenedPrepared.get('continueInvalidRetest').disabled });
    check('diagnostic_server_record_keeps_prepared_identity',
      preparedRows(reopenedPrepared.http.currentState?.record).length === 1,
      { serverPrepared: preparedRows(reopenedPrepared.http.currentState?.record) });

    reopenedPrepared.get('questionType').value`,
);
source = source.replace(
  "\n\n    const parser = vm.createContext({});",
  `

    const uuidAfterDone = vm.runInContext('crypto.randomUUID()', reopenedPrepared.context);
    check('diagnostic_completed_round_does_not_reuse_prepared_turn_id', uuidAfterDone !== fresh.turnId,
      { completedTurnId: fresh.turnId, nextUuid: uuidAfterDone });

    const parser = vm.createContext({});`,
);
source = source.replace(
  "    report.passed = report.cases.every(row => row.passed); report.productContinuationPassed = report.passed;",
  `    check('diagnostic_success_path_has_one_direct_put_not_two_competing_puts', initial.http.statePuts.length === 1,
      { stateGets: initial.http.stateGets.length, statePuts: initial.http.statePuts.length });

    const rejected = controlledWorld(structuredClone(actual), {
      delays: { materialMs: 5, stateGetMs: 5, statePutMs: 5, rejectStatePut: true },
    });
    await pause(30);
    for (const key of ['requests','inferencePosts','inferenceGets','materialPosts','statePuts','stateGets']) rejected.http[key].length = 0;
    const beforeRejectedClick = canonical(rejected.read());
    await rejected.emit(rejected.get('continueInvalidRetest'), 'click');
    await pause(30);
    const afterRejectedClick = rejected.read();
    check('diagnostic_rejected_direct_cas_does_not_leave_local_prepared_or_current_binding',
      canonical(afterRejectedClick) === beforeRejectedClick && preparedRows(afterRejectedClick).length === 0,
      { localChanged: canonical(afterRejectedClick) !== beforeRejectedClick,
        localPrepared: preparedRows(afterRejectedClick), materialEventId: afterRejectedClick.material?.materialEventId || null,
        serverCurrent: rejected.http.current, stateGets: rejected.http.stateGets.length,
        statePuts: rejected.http.statePuts.length });
    check('diagnostic_continuation_cancels_queued_sync_and_only_direct_cas_runs',
      rejected.http.stateGets.length === 1 && rejected.http.statePuts.length === 1,
      { stateGets: rejected.http.stateGets.length, statePuts: rejected.http.statePuts.length,
        interpretation: 'continueInvalidRetest clears the scheduled sync timer after localStorage.setItem, so this path issues only its direct GET and PUT.' });

    report.passed = report.cases.every(row => row.passed); report.productContinuationPassed = report.passed;`,
);

const workspace = path.join(project, 'backend/development-38-budget-timeout-observation-20261006/unfinished-workspace');
const evidence = process.argv[2] || '/tmp/development38-unfinished-ui-reader-corrected.json';
process.argv = ['node', 'diagnostic', '--workspace', workspace, '--mode', 'candidate', '--evidence', evidence];
await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
