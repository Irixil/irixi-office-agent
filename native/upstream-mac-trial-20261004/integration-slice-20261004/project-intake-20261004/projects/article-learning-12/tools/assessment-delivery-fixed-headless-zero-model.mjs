#!/usr/bin/env node
// Additive, hash-bound acceptance wrapper. The frozen v2 gate stays unchanged.
// Fix its save-observation timing; retain every candidate predicate and require
// evidence on the server plus the latest saved assessment after actual reopen.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const file = path.join(import.meta.dirname,'development46-assessment-decision-consistency-headless-v2-zero-model.mjs');
const bytes = fs.readFileSync(file), sha = v => crypto.createHash('sha256').update(v).digest('hex');
if (sha(bytes) !== 'b8796126746bf8bff523b5e575b3bb6bb1ebf40c45e9629bcd9ab2c0ceec1cf4') throw Error('Frozen Headless-v2 bytes changed');
let source = bytes.toString('utf8');
function replaceUnique(before,after) {
  if (source.split(before).length !== 2) throw Error('Fixed acceptance substitution is not byte-exact and unique');
  source = source.replace(before,after);
}
replaceUnique(
  "const done=await submit('application'),before=(await evaluate(`fetch('/__fixture/state').then(r=>r.json())`)).inferencePosts.length;",
  "const done=await submit('application');await until(`fetch('/__fixture/state').then(r=>r.json()).then(s=>s.state?.record?.turns?.some(t=>t.turnId===${JSON.stringify(done.turn.turnId)}&&t.status==='done')&&s.state?.record?.assessments?.some(a=>a.turnId===${JSON.stringify(done.turn.turnId)}))`,12000);const before=(await evaluate(`fetch('/__fixture/state').then(r=>r.json())`)).inferencePosts.length;"
);
replaceUnique(
  "s.statePuts.some(p=>p.state?.record?.turns?.some(t=>t.turnId===${JSON.stringify(done.turn.turnId)}))",
  "s.statePuts.some(p=>p.state?.record?.turns?.some(t=>t.turnId===${JSON.stringify(done.turn.turnId)}&&t.status==='done')&&p.state?.record?.assessments?.some(a=>a.turnId===${JSON.stringify(done.turn.turnId)}))"
);
replaceUnique('  const candidatePass=checks.normalControlParsedPersistedAndMastered',`  const evidenceOnServer=(scenario,turnId)=>{const raw=scenario.server.rawOutputs[turnId],parsed=JSON.parse(raw),row=scenario.server.state.record.assessments.find(a=>a.turnId===turnId);return Boolean(row)&&containsValue(scenario.server.state.record,v=>v===raw)&&containsParsed(scenario.server.state.record,parsed)&&canonical(decision(row))===canonical(decision(scenario.browser.record.assessments.find(a=>a.turnId===turnId)))};
  checks.newResponseEvidenceAndDecisionActuallySavedOnServer=normal.persisted.every(x=>evidenceOnServer(normal,x.turnId))&&evidenceOnServer(fresh,freshTurnId)&&evidenceOnServer(partial,partial.persisted.turnId);
  const savedAssessment=fresh.server.state.record.assessments.find(a=>a.turnId===freshTurnId),restoredAssessment=freshReopen.browser.record.assessments.find(a=>a.turnId===freshTurnId),savedTurn=fresh.server.state.record.turns.find(t=>t.turnId===freshTurnId),restoredTurn=freshReopen.browser.record.turns.find(t=>t.turnId===freshTurnId);
  checks.latestSavedAssessmentRestored=Boolean(savedAssessment&&restoredAssessment&&savedTurn&&restoredTurn)&&canonical(savedAssessment)===canonical(restoredAssessment)&&savedTurn.status==='done'&&restoredTurn.status==='done'&&canonical(savedTurn.context)===canonical(restoredTurn.context);
  report.saveCompletionObservedBeforeReopen=true;
  report.fixedAcceptanceOrigin='frozen development46 v2; original predicates retained; save completion observed and server/latest-state checks added';
  const candidatePass=checks.newResponseEvidenceAndDecisionActuallySavedOnServer&&checks.latestSavedAssessmentRestored&&checks.normalControlParsedPersistedAndMastered`);
await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
