// Owner coordination of an already completed native PASS through the strict
// product API. No model call, TASK_DONE fabrication, budget reset or source edit.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const root=path.resolve(import.meta.dirname,'..'),base='http://127.0.0.1:9109',args=process.argv.slice(2),expected=args[1];
assert.ok(args.length===2&&args[0]==='--coordinate'&&['6b95201ee7634fd40fd7c379d013d1be6a9408b17492db98f8c55e36e162de1c','c114e5dc0078a8463f6f55a3b6d5da63fd04f0a746633f7e8d02a6bb0e5ed0c7'].includes(expected));
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const batch=expected.startsWith('c114')?'development-20':'development-19';
const priorFile=batch==='development-20'?'evidence/development-20-genuine-native-pass-authority-terminal-rejection.json':'evidence/development-19-native-pass-authority-terminal-rejection.json';
const [task,cap,prior]=await Promise.all(['state/tasks/task-article-learning-12/task.json','state/model-capability.json',priorFile].map(async f=>JSON.parse(await fs.readFile(path.join(root,f)))));
assert.equal(cap.development.batchId,batch);assert.equal(cap.development.mode,batch==='development-20'?'developer_reviewer':'review_only');assert.equal(cap.candidateSha256,expected);assert.equal(prior.candidateSha256,expected);
const ledgerFile=path.join(root,'state',batch,'model-ledger.json'),ledgerBytes=await fs.readFile(ledgerFile),ledger=JSON.parse(ledgerBytes),call=ledger.calls.at(-1);
assert.equal(sha(ledgerBytes),prior.ledgerSha256);assert.equal(ledger.calls.length,batch==='development-20'?2:1);assert.deepEqual(ledger.roleOrder,batch==='development-20'?['developer','reviewer']:['reviewer']);assert.ok(ledger.calls.every(c=>c.status==='completed'&&c.exitCode===0&&!c.signal&&c.declaredStatus==='done'));assert.equal(ledger.sealed.reasonCode,'native_terminal_or_host_rejected');assert.equal(call.expectedRole,'reviewer');assert.equal(call.effectiveSandbox,'read-only');assert.equal(call.exitCode,0);assert.equal(call.declaredStatus,'done');
const stdout=await fs.readFile(path.join(path.dirname(ledgerFile),call.stdout.file));assert.equal(sha(stdout),call.stdout.sha256);assert.match(stdout.toString(),/VERDICT:\*\*\s*PASS\b/);
const started=task.events.findLast(e=>e.type==='integration.observation'&&e.detail?.type==='TASK_STARTED'&&e.detail?.actor==='reviewer'&&e.detail?.binding?.executionId===task.execution.id&&e.detail?.binding?.candidateSha256===expected);assert.ok(started);
const request={expectedGoalVersionId:cap.goalVersionId,expectedExecutionId:task.execution.id,expectedCandidateSha256:expected,sourceTaskId:started.detail.sourceTaskId,expectedLedgerSha256:sha(ledgerBytes),expectedStdoutSha256:sha(stdout)};
if(batch==='development-20'){
  const proofBytes=await fs.readFile(path.join(root,'evidence/development-20-bound-host-proof-zero-model.json')),proof=JSON.parse(proofBytes);
  assert.equal(proof.executionId,task.execution.id);assert.equal(proof.candidateSha256,expected);assert.equal(proof.sourceTaskId,started.detail.sourceTaskId);assert.equal(proof.hostChecksPassed,true);assert.equal(proof.sourceUnchanged,true);assert.equal(proof.nativeModelCalls,0);assert.equal(proof.developerStdoutSha256,ledger.calls[0].stdout.sha256);Object.assign(request,{expectedSourceManifestSha256:proof.sourceManifestSha256,expectedDeveloperStdoutSha256:proof.developerStdoutSha256,hostProofFile:'development-20-bound-host-proof-zero-model.json',hostProofSha256:sha(proofBytes)});
}
const names=['PRODUCT.md','app.js','core.js','index.html','styles.css','test-core.js'];const before=await Promise.all(names.map(async n=>({path:n,sha256:sha(await fs.readFile(path.join(root,'workspace',n)))})));
const old18=await fs.readFile(path.join(root,'state/development-18/model-ledger.json'));
const old19=await fs.readFile(path.join(root,'state/development-19/model-ledger.json')),oldLearning=await fs.readFile(path.join(root,'state/learning-01/model-ledger.json'));
const owned=path.join(root,'backend',batch+'-zero-model-review-coordination');await fs.mkdir(owned,{recursive:false,mode:0o700});
const save=(n,v)=>fs.writeFile(path.join(owned,n),JSON.stringify(v,null,2)+'\n',{flag:'wx',mode:0o600});
await save('request.json',{authorizationSource:batch==='development-20'?'Parent continuously authorized exact contract20 repair/review and teaching; coordinate only genuine original bound PASS with zero model calls; preserve failed20 and learning01.':'Parent explicit reviewOnly19 exact candidate, then continuously advance genuinePASS to bounded teaching; preserve18 and19 seal/history.',request,rawNativeVerdict:'PASS',nativeModelCalls:0,priorTransportFailurePreserved:true});
const response=await fetch(base+'/api/irixi-intake/coordinate-sealed-reviewer-result',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify(request),signal:AbortSignal.timeout(10000)});const value=await response.json();await save('response.json',{status:response.status,value});assert.ok(response.ok,value.error);assert.equal(value.coordinated,true);assert.equal(value.candidateSha256,expected);assert.equal(value.nativeVerdict,'PASS');
assert.equal(sha(await fs.readFile(ledgerFile)),sha(ledgerBytes));assert.equal(sha(await fs.readFile(path.join(root,'state/development-18/model-ledger.json'))),sha(old18));for(const f of before)assert.equal(sha(await fs.readFile(path.join(root,'workspace',f.path))),f.sha256);
assert.equal(sha(await fs.readFile(path.join(root,'state/development-19/model-ledger.json'))),sha(old19));assert.equal(sha(await fs.readFile(path.join(root,'state/learning-01/model-ledger.json'))),sha(oldLearning));
const after=JSON.parse(await fs.readFile(path.join(root,'state/tasks/task-article-learning-12/task.json')));const review=after.reviews.find(r=>r.id===value.reviewId);assert.ok(review?.passed);assert.equal(review.nativeVerdict,'PASS');assert.equal(review.fullOutputSha256,sha(stdout));assert.equal(review.modelSummary.trim(),stdout.toString().trim());assert.equal(after.execution.phase,'failed','Original transport failure execution must remain historical evidence');
const result={coordinated:true,...value,sourceUnchanged:true,original18And19LedgersUnchanged:true,originalFailedExecutionPreserved:true,nativeModelCalls:0,teachingStarted:false,evidence:owned};await save('result.json',result);console.log(JSON.stringify(result));
