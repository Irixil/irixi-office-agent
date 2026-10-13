#!/usr/bin/env node
// Adds read-only observations for the two genuine development40 Reviewer
// findings to the frozen headless v2 gate. It transforms only the test driver
// in memory; candidate business bytes and the frozen v2 gate stay unchanged.
import fs from 'node:fs';
import path from 'node:path';

const project = path.resolve(import.meta.dirname, '..');
const gate = path.join(project, 'tools/development40-headless-startup-workflow-gate-v2-zero-model.mjs');
let source = fs.readFileSync(gate, 'utf8');
source = source.replace(
  "const project = path.resolve(import.meta.dirname, '..'), chromeBinary",
  `const project = ${JSON.stringify(project)}, chromeBinary`,
);

const doneAnchor = `    check('controlled_done_consumes_prepared_identity_and_preserves_source', completed.record.turns.some(turn => turn.turnId === preparedId && turn.status === 'done' && turn.context?.questionSourceTurnId === sourceTurnId) && !completed.record.turns.some(turn => turn.status === 'pending'), { preparedId });`;
const doneObservation = `${doneAnchor}
    await evaluate('document.getElementById("newSession").click();true'); await sleep(25);
    const postDoneControls = await evaluate('({assessDisabled:document.getElementById("assessBtn").disabled,openBatchDisabled:document.getElementById("openBatch").disabled,notice:document.getElementById("notice").textContent,recoveryHidden:document.getElementById("recovery").hidden})');
    diagnostic('genuine_reviewer_finding_old_invalid_reblocks_after_replacement_done', postDoneControls.assessDisabled && postDoneControls.openBatchDisabled && /未解决/.test(postDoneControls.notice), { requiredForOverallPass:false, ...postDoneControls });`;
if (!source.includes(doneAnchor)) throw new Error('Frozen v2 done anchor not found');
source = source.replace(doneAnchor, doneObservation);

const finalAnchor = `    report.passed = report.cases.every(row => row.passed); report.productWorkflowPassed = report.passed;`;
const finalObservation = `    resetOld(); await evaluate(\`localStorage.setItem(\${JSON.stringify(KEY)},\${JSON.stringify(initialRecordBytes)});true\`); await navigate(pageKind); await sleep(350);
    const ambiguousId='controlled-ambiguous-request-body';
    await evaluate(\`(()=>{const r=JSON.parse(localStorage.getItem(\${JSON.stringify(KEY)}));r.turns.push({turnId:\${JSON.stringify('controlled-ambiguous-request-body')},kind:'assess',status:'ambiguous',articleSha256:r.material.articleSha256,materialEventId:r.material.materialEventId,context:{questionType:'cause',question:'controlled question',response:'controlled response'},requestBody:{turnId:\${JSON.stringify('controlled-ambiguous-request-body')},payload:{learnerEntry:{question:'controlled question'}}}});localStorage.setItem(\${JSON.stringify(KEY)},JSON.stringify(r));return true})()\`); await sleep(500);
    const compactObservation=await evaluate(\`fetch('/__fixture/state').then(r=>r.json()).then(server=>{const row=server.savedState?.record?.turns?.find(t=>t.turnId===\${JSON.stringify('controlled-ambiguous-request-body')});return {saved:Boolean(row),status:row?.status||null,requestBodyPresent:Boolean(row&&Object.prototype.hasOwnProperty.call(row,'requestBody'))}})\`);
    diagnostic('genuine_reviewer_finding_compact_drops_ambiguous_request_body', compactObservation.saved && compactObservation.status==='ambiguous' && !compactObservation.requestBodyPresent, { requiredForOverallPass:false, cacheLossRecoveryScenario:true, ...compactObservation });
${finalAnchor}`;
if (!source.includes(finalAnchor)) throw new Error('Frozen v2 final anchor not found');
source = source.replace(finalAnchor, finalObservation);

await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
