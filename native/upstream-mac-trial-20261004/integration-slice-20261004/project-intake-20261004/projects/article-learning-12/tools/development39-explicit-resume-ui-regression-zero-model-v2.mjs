#!/usr/bin/env node
// Stage39 v2 zero-model gate. This keeps the frozen v1 observer byte-exact and
// strengthens only its completed-identity assertion: a new UUID is insufficient
// unless the completed prepared row is absent from both live and saved state.
import fs from 'node:fs';
import path from 'node:path';

const project = path.resolve(import.meta.dirname, '..');
const v1 = path.join(project, 'tools/development39-explicit-resume-ui-regression-zero-model.mjs');
let source = fs.readFileSync(v1, 'utf8');

source = source.replace(
  "const project = path.resolve(import.meta.dirname, '..');",
  `const project = ${JSON.stringify(project)};`,
);

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
if (!source.includes(priorAssertion)) throw new Error('Frozen v1 completed-identity assertion was not found');
source = source.replace(priorAssertion, strengthenedAssertion);
source = source.replace("report.gateVersion = 'development39-v1';", "report.gateVersion = 'development39-v2';");
source = source.replace(
  "'completed prepared ID consumption assertion',",
  "'completed prepared ID absent from live and saved state before non-reuse assertion',",
);

await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
