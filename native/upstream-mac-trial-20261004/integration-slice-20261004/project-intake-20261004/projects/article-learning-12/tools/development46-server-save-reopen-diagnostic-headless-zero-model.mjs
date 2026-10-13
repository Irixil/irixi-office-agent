#!/usr/bin/env node
// Append-only diagnostic wrapper around the frozen development46 Headless-v2
// gate. The only behavioral substitution waits until the controlled server has
// durably accepted the fresh contradictory assessment as a done turn before
// the existing continuation and reopen sequence proceeds.
import fs from 'node:fs';
import path from 'node:path';

const frozen = path.join(import.meta.dirname, 'development46-assessment-decision-consistency-headless-v2-zero-model.mjs');
let source = fs.readFileSync(frozen, 'utf8');

const before = "const done=await submit('application'),before=(await evaluate(`fetch('/__fixture/state').then(r=>r.json())`)).inferencePosts.length;";
const after = "const done=await submit('application');await until(`fetch('/__fixture/state').then(r=>r.json()).then(s=>s.state?.record?.turns?.some(t=>t.turnId===${JSON.stringify(done.turn.turnId)}&&t.status==='done')&&s.state?.record?.assessments?.some(a=>a.turnId===${JSON.stringify(done.turn.turnId)}))`,12000);const before=(await evaluate(`fetch('/__fixture/state').then(r=>r.json())`)).inferencePosts.length;";

if (!source.includes(before)) throw new Error('Frozen Headless-v2 runFreshConflict sequence was not found byte-exactly');
source = source.replace(before, after);
if (source.includes(before)) throw new Error('Frozen sequence replacement was not unique');

await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
