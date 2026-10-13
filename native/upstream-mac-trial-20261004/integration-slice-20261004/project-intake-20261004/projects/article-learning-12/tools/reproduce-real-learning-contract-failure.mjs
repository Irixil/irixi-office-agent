#!/usr/bin/env node
// Independent zero-model diagnosis of the preserved real response.
// Never changes native session, model output, business source, or budget.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const root=path.resolve(import.meta.dirname,'..'),hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const owned=path.join(root,'backend/actual-native-learning-acceptance-20261005');
const requestFile=path.join(owned,'explain-8a4348f6-0cc2-4f36-a169-cc720d2ca88e/native-http-request-1.json');
const resultFile=path.join(owned,'recover-original-e34daf48-fe89-45ee-8aa7-bacf54fda6d0/native-http-result-4.json');
const [request,response,stdout,coreBytes,storageBytes]=await Promise.all([
  fs.readFile(requestFile).then(JSON.parse),fs.readFile(resultFile).then(JSON.parse),
  fs.readFile(path.join(root,'state/learning-01/call-1/stdout.log'),'utf8'),
  fs.readFile(path.join(root,'workspace/core.js')),fs.readFile(path.join(owned,'native-local-storage.json')),
]);
const state=JSON.parse(JSON.parse(storageBytes)['irixi.article-learning-12.session.v1']);
assert.equal(response.result.turnId,request.body.turnId);
assert.equal(hash(response.result.text),response.result.textSha256);
assert.equal(state.turns[0].status,'invalid');assert.equal(state.explanations.length,0);
const parsed=JSON.parse(response.result.text);assert.deepEqual(parsed,JSON.parse(stdout));
const context=vm.createContext({});vm.runInContext(coreBytes.toString(),context);
const core=context.LearningCore,types=['cause','misconception','application','transfer'];
let actualFailure=null;
try{core.parseModelText(response.result.text,'explain',{articleText:request.body.payload.articleText});}
catch(error){actualFailure=error.message;}
assert.equal(actualFailure,state.turns[0].error);
assert.ok(parsed.coverage.every(c=>!Array.isArray(c.questionTypes)&&types.every(t=>typeof c.questionTypes[t]==='string'&&c.questionTypes[t].trim())));
// A disposable in-memory shape conversion isolates the mismatch. It is not
// a product fix, an accepted response, or saved learning evidence.
const diagnostic=structuredClone(parsed);
diagnostic.coverage.forEach(c=>{c.questionTypes=Object.keys(c.questionTypes);});
core.parseModelText(JSON.stringify(diagnostic),'explain',{articleText:request.body.payload.articleText});
const report={at:new Date().toISOString(),nativeModelCalls:0,actualResponseRejected:true,
  originalTurnId:request.body.turnId,originalRequestRawBodySha256:request.rawBodySha256,
  originalResponseSha256:response.result.textSha256,originalStdoutSha256:hash(stdout),
  rawStdoutAndTransportedJSONSemanticallyEqual:true,coreSha256:hash(coreBytes),
  actualFailure,clientState:'invalid',storedExplanations:0,
  originalPromptCoverageContract:request.body.payload.responseContract.required.coverage,
  requestedQuestionTypes:types,actualQuestionTypesRepresentation:'object mapping each requested type to a question',
  actualResponseContainsAllFourQuestionTypes:true,
  isolatedDiagnosticShapeConversionAccepted:true,isolatedDiagnosticStoredAsLearningResult:false,
  sourceAndSessionUnchanged:hash(await fs.readFile(path.join(root,'workspace/core.js')))===hash(coreBytes)&&hash(await fs.readFile(path.join(owned,'native-local-storage.json')))===hash(storageBytes),
  conclusion:'Original prompt does not explicitly require a string array for questionTypes; unchanged client validation requires an array. The real model supplied all four question types as an object, and the original candidate correctly rejected its shape. Real teaching did not pass.',
  smallestNextChange:'Native Developer should clarify only the explanation responseContract with an exact string-array JSON example; preserve the original four-type coverage and all validator requirements. The changed candidate requires independent review and exact confirmation before a separately authorized bounded real acceptance.',
  subsequentAssessmentOrRetestOrSummaryRun:false,actualBrowser:false,humanLearningProven:false,
};
assert.equal(report.sourceAndSessionUnchanged,true);
const evidenceFile=path.join(root,'evidence/learning01-real-output-contract-independent-reproduction.json');
await fs.writeFile(evidenceFile,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({independentReproductionPassed:true,realTeachingPassed:false,allFourTypesPresent:true,mismatch:'object supplied; array required',noModelOrSourceChange:true,evidenceFile}));
