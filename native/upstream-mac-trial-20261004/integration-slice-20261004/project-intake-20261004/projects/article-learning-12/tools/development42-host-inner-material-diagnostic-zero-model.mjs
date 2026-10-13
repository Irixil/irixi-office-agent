#!/usr/bin/env node
// Finite zero-model diagnostic: actual controller functions, temporary TaskStore.
// Two matched normal snapshots and one deliberately mismatched inner record.
// No live API/service, model, candidate confirmation, or application edit.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const projectRoot=path.resolve(import.meta.dirname,'..'),base=path.resolve(projectRoot,'../../..');
const {createArticleProjectController}=await import(pathToFileURL(path.join(base,'authority/article-project-controller.mjs')));
const {createIntakeController}=await import(pathToFileURL(path.join(base,'authority/intake-controller.mjs')));
const sha=v=>crypto.createHash('sha256').update(v).digest('hex');
const arg=process.argv.indexOf('--evidence'), evidence=arg<0?null:path.resolve(process.argv[arg+1]);
assert.ok(evidence,'--evidence is required');
const sourceFile=path.join(projectRoot,'backend/development-34-preparation/prior-task.json'),sourceBytes=await fs.readFile(sourceFile);
const frozenTask=JSON.parse(sourceBytes),tmp=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'d42-host-contract-')));
try {
 const tasksRoot=path.join(tmp,'tasks'),taskDir=path.join(tasksRoot,frozenTask.id);
 await fs.mkdir(taskDir,{recursive:true});
 await fs.writeFile(path.join(taskDir,'task.json'),sourceBytes);
 await fs.writeFile(path.join(taskDir,'events.jsonl'),'');
 const project=JSON.parse(await fs.readFile(path.join(projectRoot,'project.json'),'utf8'));
 project.workspace=path.join(projectRoot,'backend/development-42-exact-native-source-20261006/source');
 const projectFile=path.join(tmp,'project.json'),capabilityFile=path.join(tmp,'model-capability.json');
 await fs.writeFile(projectFile,JSON.stringify(project));
 await fs.writeFile(capabilityFile,JSON.stringify({schemaVersion:1,projectId:'article-learning-12',development:{enabled:false},learning:{enabled:false}}));
 const controller=await createArticleProjectController({tasksRoot,irixiAppRoot:path.join(base,'sources/irixi-20261004/app'),projectFile,capabilityFile});
 const intake=await createIntakeController({tasksRoot,irixiAppRoot:path.join(base,'sources/irixi-20261004/app'),taskId:frozenTask.id,articleProjectFile:projectFile,articleCapabilityFile:capabilityFile});
 const goal=controller.helpers.activeGoal(frozenTask),artifact=frozenTask.artifacts.filter(a=>a.status==='confirmed'&&controller.helpers.projectArtifactIsCurrent(frozenTask,a)).at(-1);
 assert.ok(artifact,'Frozen fixture must already have a current confirmed artifact');
 const sessionId='controlled-d42-host-diagnosis';
 const articleA='[P1] 临时接口诊断文章 A。\n',articleB='[P1] 临时接口诊断文章 B；正文不同。\n';
 const A=await intake.registerMaterial({sessionId,label:'A',source:'temporary diagnostic',articleText:articleA});
 const stateA={record:{sessionId,material:{...A,articleText:articleA},turns:[],explanations:[{articleSha256:A.articleSha256,marker:'A-fact'}],assessments:[],opinions:[],summaries:[]}};
 const binding=(material,revision)=>({projectId:'article-learning-12',sessionId,expectedGoalVersionId:goal.id,expectedCandidateSha256:artifact.projectCandidate.candidateSha256,expectedMaterialEventId:material.materialEventId,expectedRevision:revision});
 const savedA=await controller.saveClientState(frozenTask.id,{...binding(A,0),state:stateA});
 const readA=await controller.clientState(frozenTask.id,sessionId,{historical:true});
 assert.equal(readA.material.articleSha256,readA.state.record.material.articleSha256);
 const AEventBefore=JSON.stringify((await controller.store.get(frozenTask.id)).events.findLast(e=>e.type==='learning.client_state_saved'));
 const B=await intake.registerMaterial({sessionId,label:'B',source:'temporary diagnostic',articleText:articleB});
 const stateB={record:{sessionId,material:{...B,articleText:articleB},turns:[],explanations:[{articleSha256:B.articleSha256,marker:'B-fact'}],assessments:[],opinions:[],summaries:[]}};
 const savedB=await controller.saveClientState(frozenTask.id,{...binding(B,0),state:stateB});
 const readB=await controller.clientState(frozenTask.id,sessionId,{historical:true});
 assert.equal(readB.material.articleSha256,readB.state.record.material.articleSha256);
 await assert.rejects(controller.saveClientState(frozenTask.id,{...binding(A,savedA.revision),state:stateA}),/binding is stale/);
 const craftedSave=await controller.saveClientState(frozenTask.id,{...binding(B,savedB.revision),state:stateA});
 const historical=await controller.clientState(frozenTask.id,sessionId,{historical:true});
 const current=await controller.clientState(frozenTask.id,sessionId);
 const mismatch=historical.material.articleSha256!==historical.state.record.material.articleSha256;
 assert.equal(mismatch,true);
 assert.equal(historical.material.articleSha256,B.articleSha256);
 assert.equal(historical.state.record.material.articleSha256,A.articleSha256);
 assert.deepEqual(historical.state,stateA);
 assert.deepEqual(current.state,stateA);
 const after=await controller.store.get(frozenTask.id);
 assert.equal(JSON.stringify(after.events.find(e=>e.type==='learning.client_state_saved'&&e.detail.sessionId===sessionId&&e.detail.materialEventId===A.materialEventId)),AEventBefore);
 assert.deepEqual(await fs.readFile(sourceFile),sourceBytes);
 const report={schemaVersion:1,recordedAt:new Date().toISOString(),result:'REPRODUCED_ACTUAL_HANDLER_ACCEPTS_CRAFTED_INNER_MISMATCH_NORMAL_MATCHED_PATH_PASSES',
 nativeModelCalls:0,liveProductApiCalls:0,physicalInput:false,serviceChanges:0,businessSourceEdits:0,liveTaskWrites:0,candidateConfirmations:0,
 executionKind:'actual current controller and intake functions with real temporary TaskStore; no HTTP route or live product service',
 fixture:{existingHistoricalConfirmedArtifactVersion:artifact.version,existingHistoricalConfirmedCandidateSha256:artifact.projectCandidate.candidateSha256,noNewConfirmation:true,tempRoot:tmp,removedAfterReport:true,sourceTaskSha256:sha(sourceBytes)},
 sourceHashes:{controller:sha(await fs.readFile(path.join(base,'authority/article-project-controller.mjs'))),intake:sha(await fs.readFile(path.join(base,'authority/intake-controller.mjs'))),tool:sha(await fs.readFile(import.meta.filename))},
 normalPath:{matchedA:true,matchedB:true,oldOuterMaterialBindingRejected:true,inconsistentRecordObserved:false},
 deliberatelyCraftedApiInput:{outerBinding:'valid current B goal/candidate/material/CAS',innerRecord:'unchanged previously saved A record',accepted:true,revision:craftedSave.revision,historicalReturnsInnerAWithOuterB:mismatch,defaultReadAlsoReturnsInnerAWithOuterB:true,AFactsUnchanged:true,originalASnapshotByteExact:true},
 classification:'Actual handler defense gap for deliberately constructed but structurally valid input. It does not show ordinary candidate42 UI producing this input, normal-user data loss, or model acceptance of A evidence under B.',
 conclusion:'The host can store and return the same mismatched shape used in the independent Chrome diagnostic. Normal matched save/read remains coherent; ordinary UI creation of the mismatch remains unproven.',
 limitations:['Direct actual controller calls, not HTTP routing or live service.','The copied already-confirmed historical artifact is only a persistence fixture; candidate32 remains rejected and unconfirmed.','No ordinary UI race or normal-path mismatch producer was reproduced.']};
 await fs.writeFile(evidence,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({result:report.result,evidence,normalPath:report.normalPath,craftedInputAccepted:true}));
} finally {await fs.rm(tmp,{recursive:true,force:true});}

