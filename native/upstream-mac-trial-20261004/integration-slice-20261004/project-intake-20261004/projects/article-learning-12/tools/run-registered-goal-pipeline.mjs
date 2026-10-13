#!/usr/bin/env node
// Owner operator: one registered Developer start, then observe product-dispatched review.
// No business code, review command, approval, new budget or automatic retry is authored here.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
const root=path.resolve(import.meta.dirname,'..'),base='http://127.0.0.1:9109';
const args=process.argv.slice(2);
assert.equal(args.length,2);assert.equal(args[0],'--start');assert.match(args[1],/^development-[0-9]{2,4}$/);
const batchId=args[1],sha=v=>crypto.createHash('sha256').update(v).digest('hex');
async function api(route){const r=await fetch(base+route,{headers:{Origin:base},signal:AbortSignal.timeout(8000)});const v=await r.json();if(!r.ok)throw Error(route+' rejected '+r.status+': '+v.error);return v;}
const intake=await api('/api/irixi-intake');
const cap=JSON.parse(await fs.readFile(path.join(root,'state/model-capability.json'),'utf8'));
const task=JSON.parse(await fs.readFile(path.join(root,'state/tasks/task-article-learning-12/task.json'),'utf8'));
assert.equal(cap.development.batchId,batchId);assert.equal(cap.development.enabled,true);
assert.equal(task.execution.increment?.optInBoundedAutoReview === true || task.execution.repair?.optInBoundedAutoReview === true,true);
assert.equal(intake.goal.confirmed,true);assert.equal(intake.executionOption.current,true);
assert.equal(intake.modelAvailability.execution.available,true);
assert.equal(intake.modelAvailability.execution.remaining,2);
assert.equal(intake.modelAvailability.execution.sealed,false);
const request=intake.executionOption.registeredExecution;assert.ok(request);
assert.equal(sha(request.prompt),request.promptSha256);assert.equal(request.executionId,cap.development.executionId);
try{await fs.lstat(cap.development.ledgerFile);throw Error('This start never repeats a used ledger');}catch(e){if(e.code!=='ENOENT')throw e;}
const evidence=path.join(root,'backend',batchId+'-registered-pipeline-start');
await fs.mkdir(evidence,{recursive:false,mode:0o700});
const save=(name,v)=>fs.writeFile(path.join(evidence,name),JSON.stringify(v,null,2)+'\n',{flag:'wx',mode:0o600});
await save('preflight.json',intake);
const outcome={batchId,executionId:request.executionId,goalVersionId:intake.goal.id,startedAt:new Date().toISOString(),rootSentCommands:[],rootManualReviewCommands:0,rootBusinessCodeWritten:false,automaticRetry:false,learningCalls:0,confirmedCandidate:false,ok:false};
let socket,timer;const events=[];
try{
 const connection=await api('/connect');assert.equal(connection.role,'owner');assert.equal(connection.gatewayId,'mac-article-learning-12');
 socket=new WebSocket('ws://127.0.0.1:9109');
 let finish;const done=new Promise(resolve=>{finish=resolve;});
 socket.addEventListener('message',({data})=>{
  try{const event=JSON.parse(String(data));events.push(event);
   if(['TASK_STARTED','TASK_DONE','TASK_FAILED'].includes(event.type)){
    void fs.appendFile(path.join(evidence,'native-events.jsonl'),JSON.stringify({receivedAt:new Date().toISOString(),event})+'\n');
    process.stdout.write(JSON.stringify({phase:event.type,agentId:event.agentId,taskId:event.taskId})+'\n');
    if(event.type==='TASK_FAILED'||(event.type==='TASK_DONE'&&String(event.agentId).startsWith('reviewer-auto-')))finish(event);
   }
  }catch{}
 });
 await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
 socket.send(JSON.stringify({type:'AUTH',sessionToken:connection.sessionToken}));delete connection.sessionToken;
 await new Promise(r=>setTimeout(r,250));assert.equal(socket.readyState,WebSocket.OPEN);assert.ok(!events.some(e=>e.type==='AUTH_FAILED'));
 const taskId='whole-goal-developer-'+crypto.randomUUID();
 outcome.rootSentCommands.push({type:'RUN_TASK',taskId,promptSha256:request.promptSha256});
 socket.send(JSON.stringify({type:'RUN_TASK',agentId:'agent-article-learning-12',taskId,prompt:request.prompt,repoPath:path.join(root,'workspace')}));
 process.stdout.write(JSON.stringify({phase:'registered_whole_goal_started',batchId,maxNativeProcesses:2,sharedWindowMs:1200000,manualReviewCommands:0})+'\n');
 timer=setTimeout(()=>finish({type:'OPERATOR_OBSERVATION_TIMEOUT'}),1220000);
 const terminal=await done;await save('terminal.json',terminal);
 // Observe persisted state; never repair, approve or resubmit.
 const finalIntake=await api('/api/irixi-intake'),authority=await api('/api/irixi-authority');
 await save('final-intake.json',finalIntake);await save('final-authority.json',authority);
 const ledger=JSON.parse(await fs.readFile(cap.development.ledgerFile,'utf8'));
 await save('final-ledger.json',ledger);
 Object.assign(outcome,{nativeProcesses:ledger.calls.filter(c=>c.modelPid).length,nativeCalls:ledger.calls.length,
  roles:ledger.calls.map(c=>({role:c.expectedRole,status:c.status,exitCode:c.exitCode,startedAt:c.startedAt,completedAt:c.completedAt,promptBytes:c.promptBytes})),
  sealed:ledger.sealed||null,phase:finalIntake.executionOption.execution?.phase,
  candidateSha256:authority.artifact?.candidateSha256||null,
  review:authority.artifact?.review ? {id:authority.artifact.review.id,passed:authority.artifact.review.passed,nativeVerdict:authority.artifact.review.nativeVerdict} : null,
  terminalType:terminal.type});
 outcome.ok=terminal.type==='TASK_DONE'&&ledger.calls.length===2&&ledger.calls.every(c=>c.status==='completed'&&c.exitCode===0)&&authority.artifact?.review?.passed===true;
}catch(e){outcome.error=e.message;process.exitCode=1;}
finally{
 clearTimeout(timer);socket?.close();outcome.finishedAt=new Date().toISOString();
 await save('result.json',outcome);
 process.stdout.write(JSON.stringify(outcome)+'\n');
 if(!outcome.ok)process.exitCode=1;
}
