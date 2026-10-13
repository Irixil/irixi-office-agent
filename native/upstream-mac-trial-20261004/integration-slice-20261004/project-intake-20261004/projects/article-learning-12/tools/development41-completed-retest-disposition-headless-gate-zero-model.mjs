#!/usr/bin/env node
// Real headless-Chrome development41 gate layered on the frozen development40
// v2 gate. Product HTML/scripts execute unmodified in candidate mode. baseline
// expects candidate30's completed-replacement blocker; selfcheck uses only an
// in-memory relationship control to prove this observer can pass.
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
const storageKey = 'irixi.article-learning-12.session.v1';
const historyKey = 'irixi.article-learning-12.history.v1';
const failedTurnId = '2dbd94bc-f4b1-4868-ae4f-0589dfc502e2';
const actualSessionId = JSON.parse(fs.readFileSync(path.join(project,
  'backend/learning-08-original-retest-client-failure/actual-local-record.json'), 'utf8')).sessionId;
const frozen = path.join(project, 'tools/development40-headless-startup-workflow-gate-v2-zero-model.mjs');
let source = fs.readFileSync(frozen, 'utf8');
source = source.replace(
  "const project = path.resolve(import.meta.dirname, '..'), chromeBinary",
  `const project = ${JSON.stringify(project)}, chromeBinary`,
);
source = source.replace(
  "if(!localStorage.getItem(KEY))localStorage.setItem(KEY,SEED);",
  "if(!localStorage.getItem(KEY)&&!localStorage.getItem('__development41ArchiveAction'))localStorage.setItem(KEY,SEED);",
);

// Selfcheck modifies only the HTTP fixture's app.js bytes in memory.
const responseAnchor = `      text = await fs.readFile(path.join(workspace, match[2]), 'utf8');
      if (match[2] === 'index.html')`;
const oldBe = 'function be(e,t){return k(e)||e===t||e.status==="invalid"&&t?.failedTurnId===e.turnId}';
const newBe = 'function be(e,t){return k(e)||e===t||e.status==="invalid"&&(t?.failedTurnId===e.turnId||r.turns.some(y=>y.status==="done"&&y.failedTurnId===e.turnId))}';
const oldRecovery = 'function P(){const e=pe();return[...r.turns].reverse().find(t=>!k(t)&&t!==e&&!(t.status==="invalid"&&e?.failedTurnId===t.turnId))}';
const newRecovery = 'function P(){const e=pe();return[...r.turns].reverse().find(t=>!be(t,e)&&t!==e)}';
const transformedResponse = `      text = await fs.readFile(path.join(workspace, match[2]), 'utf8');
      if (${JSON.stringify(requestedMode)} === 'selfcheck' && match[2] === 'app.js') text = text
        .replace(${JSON.stringify(oldBe)}, ${JSON.stringify(newBe)})
        .replace(${JSON.stringify(oldRecovery)}, ${JSON.stringify(newRecovery)})
        .replaceAll('r.turns.every(k)', 'r.turns.every(e=>be(e,null))');
      if (match[2] === 'index.html')`;
if (!source.includes(responseAnchor)) throw new Error('Frozen headless response anchor missing');
source = source.replace(responseAnchor, transformedResponse);

const doneAnchor = `    check('controlled_done_consumes_prepared_identity_and_preserves_source', completed.record.turns.some(turn => turn.turnId === preparedId && turn.status === 'done' && turn.context?.questionSourceTurnId === sourceTurnId) && !completed.record.turns.some(turn => turn.status === 'pending'), { preparedId });`;
if (!source.includes(doneAnchor)) throw new Error('Frozen headless done anchor missing');
const relationship = `${doneAnchor}
    await sleep(500);
    const relationBeforeReload = await evaluate(\`fetch('/__fixture/state').then(r=>r.json())\`);
    const persistedOld = relationBeforeReload.savedState?.record?.turns?.find(turn=>turn.turnId===invalidTurnId);
    const persistedReplacement = relationBeforeReload.savedState?.record?.turns?.find(turn=>turn.turnId===preparedId);
    const relationshipFacts = {
      failedTurnByteExact: JSON.stringify(persistedOld) === JSON.stringify(actualRecord.turns.find(turn=>turn.turnId===invalidTurnId)),
      replacementDone: persistedReplacement?.status === 'done',
      replacementFailedTurnId: persistedReplacement?.failedTurnId || null,
      first: null, second: null,
    };
    for (const ordinal of ['first','second']) {
      await navigate(pageKind);
      await sleep(700);
      const row = await evaluate(\`(()=>{window.__development41ConfirmReached=false;window.confirm=()=>{window.__development41ConfirmReached=true;return false};const assess=document.getElementById('assessBtn');const open=document.getElementById('openBatch');document.getElementById('newSession').click();return {assessEnabled:!assess.disabled,openBatchEnabled:!open.disabled,confirmReached:window.__development41ConfirmReached,notice:document.getElementById('notice').textContent,recoveryHidden:document.getElementById('recovery').hidden,oldInvalid:JSON.parse(localStorage.getItem(${JSON.stringify(storageKey)})).turns.find(t=>t.turnId===${JSON.stringify(failedTurnId)})}})()\`);
      row.failedTurnByteExact = JSON.stringify(row.oldInvalid) === JSON.stringify(actualRecord.turns.find(turn=>turn.turnId===${JSON.stringify(failedTurnId)}));
      delete row.oldInvalid;
      relationshipFacts[ordinal] = row;
    }
    const relationAllowsNext = relationshipFacts.failedTurnByteExact && relationshipFacts.replacementDone &&
      relationshipFacts.replacementFailedTurnId===invalidTurnId && relationshipFacts.first.failedTurnByteExact &&
      relationshipFacts.second.failedTurnByteExact && relationshipFacts.first.assessEnabled &&
      relationshipFacts.second.assessEnabled && relationshipFacts.first.confirmReached && relationshipFacts.second.confirmReached;
    let actualNextOperation = { attempted: false };
    if (relationAllowsNext) {
      const postsBeforeArchive = (await evaluate(\`fetch('/__fixture/state').then(r=>r.json())\`)).stats.inferencePosts;
      await evaluate(\`localStorage.setItem('__development41ArchiveAction','1');true\`);
      await evaluate(\`(()=>{window.confirm=()=>true;document.getElementById('newSession').click();return true})()\`);
      await until(\`(()=>{const h=JSON.parse(localStorage.getItem(${JSON.stringify(historyKey)})||'[]');const r=JSON.parse(localStorage.getItem(${JSON.stringify(storageKey)})||'null');return h.length>0&&r&&r.sessionId!==${JSON.stringify(actualSessionId)}&&r.turns.length===0})()\`, 10000);
      actualNextOperation = await evaluate(\`fetch('/__fixture/state').then(r=>r.json()).then(server=>{const history=JSON.parse(localStorage.getItem(${JSON.stringify(historyKey)})||'[]'),current=JSON.parse(localStorage.getItem(${JSON.stringify(storageKey)})||'null'),archived=history.at(-1);return {attempted:true,newSessionId:current?.sessionId||null,newSessionTurnCount:current?.turns?.length??null,archivedSessionId:archived?.sessionId||null,archivedReplacement:archived?.turns?.find(t=>t.turnId===\${JSON.stringify(preparedId)})||null,archivedOldInvalid:archived?.turns?.find(t=>t.turnId===${JSON.stringify(failedTurnId)})||null,inferencePostsBefore:${'${postsBeforeArchive}'},inferencePostsAfter:server.stats.inferencePosts}})\`);
      actualNextOperation.oldInvalidByteExact = JSON.stringify(actualNextOperation.archivedOldInvalid) === JSON.stringify(actualRecord.turns.find(turn=>turn.turnId===invalidTurnId));
      actualNextOperation.passed = actualNextOperation.newSessionId && actualNextOperation.newSessionId!==actualRecord.sessionId && actualNextOperation.newSessionTurnCount===0 && actualNextOperation.archivedSessionId===actualRecord.sessionId && actualNextOperation.archivedReplacement?.status==='done' && actualNextOperation.archivedReplacement?.failedTurnId===invalidTurnId && actualNextOperation.oldInvalidByteExact && actualNextOperation.inferencePostsAfter===actualNextOperation.inferencePostsBefore;
      await evaluate(\`localStorage.removeItem('__development41ArchiveAction');localStorage.setItem(${JSON.stringify(storageKey)},\${JSON.stringify(JSON.stringify(relationBeforeReload.savedState.record))});true\`);
      await navigate(pageKind); await sleep(500);
    }
    relationshipFacts.actualNextOperation = actualNextOperation;
    if (${JSON.stringify(requestedMode)} === 'baseline') check('candidate30_completed_replacement_gap_reproduced_in_real_headless_page',
      relationshipFacts.failedTurnByteExact && relationshipFacts.replacementDone && !relationAllowsNext, relationshipFacts);
    else check('completed_replacement_relation_is_saved_and_allows_next_operation_after_repeated_refresh',
      relationAllowsNext && actualNextOperation.passed, relationshipFacts);`;
source = source.replace(doneAnchor, relationship);
source = source.replace(
  `report.finishedAt = new Date().toISOString(); report.limitations.push('All API and inference results are local fixtures; this is real HTML/parser/DOM behavior but not a product service, Native model, or human-learning result.');`,
  `report.development41Mode = ${JSON.stringify(requestedMode)};
  report.relationshipSelfcheckApplied = ${JSON.stringify(requestedMode === 'selfcheck')};
  report.finishedAt = new Date().toISOString(); report.limitations.push('All API and inference results are local fixtures; this is real HTML/parser/DOM behavior but not a product service, Native model, or human-learning result.');
  report.limitations.push('The relationship selfcheck, when selected, modifies app.js only in the loopback fixture and is not product evidence.');`,
);

// Underlying v2 candidate mode executes the complete product workflow. Our
// own requested mode determines whether the relationship outcome is expected
// to fail (baseline), pass by control (selfcheck), or pass in product bytes.
process.argv = ['node', 'development41-headless-gate', '--workspace', workspace, '--mode', 'candidate', '--evidence', evidence];
await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
