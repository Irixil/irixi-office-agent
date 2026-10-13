#!/usr/bin/env node
// Explicit owner action: reconcile genuine existing output; never infer or edit learning data.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const root=path.resolve(import.meta.dirname,'..'),base='http://127.0.0.1:9109',sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const args=process.argv.slice(2);assert.deepEqual(args,['--coordinate','f883544156f0ceef61394a532e8fc4f021daf4be81bd2986a15db3dca64dbfd0']);
async function api(route,body){const r=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{Origin:base,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)});const v=await r.json();assert.ok(r.ok,route+' refused: '+v.error);return v;}
const proofBytes=await fs.readFile(path.join(root,'evidence/learning02-bound-raw-host-core-proof-zero-model.json')),proof=JSON.parse(proofBytes),proposal=JSON.parse(await fs.readFile(path.join(root,'evidence/learning02-exact-zero-model-coordination-proposal.json'))),request=proposal.proposedRequest;
assert.equal(sha(proofBytes),request.hostProofSha256);assert.equal(request.expectedStdoutSha256,args[1]);
const [authority,intake]=await Promise.all([api('/api/irixi-authority'),api('/api/irixi-intake')]);
assert.equal(authority.current,true);assert.equal(intake.goal.confirmed,true);assert.equal(authority.goalVersionId,proof.goalVersionId);assert.equal(authority.artifact.candidateSha256,proof.candidateSha256);assert.ok(authority.artifact.confirmation);assert.equal(authority.artifact.review.nativeVerdict,'PASS');
const cap=JSON.parse(await fs.readFile(path.join(root,'state/model-capability.json')));assert.equal(cap.learning.enabled,false);assert.equal(cap.learning.ledgerFile,path.join(root,proof.ledgerFile));
const ledgerBytes=await fs.readFile(cap.learning.ledgerFile),raw=await fs.readFile(path.join(root,proof.rawStdoutFile));assert.equal(sha(ledgerBytes),proof.ledgerSha256);assert.equal(sha(raw),proof.rawStdoutSha256);
const taskBefore=JSON.parse(await fs.readFile(path.join(root,'state/tasks/task-article-learning-12/task.json')));assert.ok(!taskBefore.events.some(e=>e.type==='learning.inference_transport_reconciled'&&e.detail?.turnId===proof.turnId));
const before=await api('/api/irixi-inference?turnId='+proof.turnId);assert.equal(before.text,'Task completed');assert.equal(before.textSha256,proof.originalTransportTextSha256);
const owned=path.join(root,'backend/learning02-exact-raw-transport-coordination');await fs.mkdir(owned,{recursive:false,mode:0o700});
const save=(n,v)=>fs.writeFile(path.join(owned,n),JSON.stringify(v,null,2)+'\n',{flag:'wx',mode:0o600});
await save('request.json',{authorizationSource:'Parent explicitly authorized exact raw zero-model coordination and normal client GET recovery, preserving failed transport and sealed02; source thread01a0f5a5-1047-774f-9957-9bb97a1c4039.',request,modelCalls:0});
await save('before.json',{authority,intake,originalGET:before,ledgerSha256:sha(ledgerBytes),rawSha256:sha(raw),originalEventIds:taskBefore.events.map(e=>e.id)});
const response=await api('/api/irixi-inference/coordinate-sealed-result',request);await save('response.json',response);assert.equal(response.reconciled,true);assert.equal(response.turnId,proof.turnId);assert.equal(response.resultSha256,sha(raw));
const after=await api('/api/irixi-inference?turnId='+proof.turnId);assert.equal(after.status,'done');assert.equal(after.reconciled,true);assert.equal(sha(after.text),sha(raw));assert.equal(after.textSha256,sha(raw));assert.equal(sha(await fs.readFile(cap.learning.ledgerFile)),sha(ledgerBytes));
const taskAfter=JSON.parse(await fs.readFile(path.join(root,'state/tasks/task-article-learning-12/task.json')));
assert.deepEqual(taskAfter.events.slice(0,taskBefore.events.length),taskBefore.events);assert.equal(taskAfter.events.length,taskBefore.events.length+1);assert.equal(taskAfter.events.at(-1).id,response.eventId);
await save('after.json',after);const result={recordedAt:new Date().toISOString(),ok:true,eventId:response.eventId,turnId:proof.turnId,rawSha256:sha(raw),rawBytes:raw.length,ledgerSha256:sha(ledgerBytes),allOriginalEventsPreserved:true,originalSealedLedgerUnchanged:true,modelCalls:0,nativeClientRecoveryNotYetRun:true};await save('result.json',result);console.log(JSON.stringify({...result,evidence:owned}));
