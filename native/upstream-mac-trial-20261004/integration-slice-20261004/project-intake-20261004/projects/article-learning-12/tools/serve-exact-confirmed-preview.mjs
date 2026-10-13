#!/usr/bin/env node
// Serve only an already genuinely reviewed and confirmed candidate. Zero models.
import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import crypto from 'node:crypto';
const args=process.argv.slice(2);assert.ok((args.length===2||args.length===4&&args[2]==='--evidence-suffix'&&/^[A-Za-z0-9_-]{1,60}$/.test(args[3]))&&args[0]==='--serve'&&/^[a-f0-9]{64}$/.test(args[1]));const expected=args[1],suffix=args[3]?'-'+args[3]:'',root=path.resolve(import.meta.dirname,'..'),base='http://127.0.0.1:9109',sha=b=>crypto.createHash('sha256').update(b).digest('hex');
async function api(route){const r=await fetch(base+route,{headers:{Origin:base},signal:AbortSignal.timeout(8000)});const v=await r.json();assert.ok(r.ok,v.error);return v;}
const a=await api('/api/irixi-authority');assert.equal(a.current,true);assert.equal(a.artifact.candidateSha256,expected);assert.equal(a.artifact.review.nativeVerdict,'PASS');assert.equal(a.artifact.review.passed,true);assert.ok(a.artifact.confirmation);
const cap=JSON.parse(await fs.readFile(path.join(root,'state/model-capability.json'))),ledgerBytes=await fs.readFile(cap.development.ledgerFile),ledger=JSON.parse(ledgerBytes);assert.ok(!ledger.calls.some(c=>['reserved','running'].includes(c.status)));
const owned=path.join(root,'backend/exact-static-preview-'+expected.slice(0,12)+suffix);await fs.mkdir(owned,{recursive:false,mode:0o700});const save=(n,v)=>fs.writeFile(path.join(owned,n),JSON.stringify(v,null,2)+'\n',{flag:'wx',mode:0o600});
const connection=await api('/connect');assert.equal(connection.role,'owner');assert.equal(connection.gatewayId,'mac-article-learning-12');const socket=new WebSocket('ws://127.0.0.1:9109');let timer;const events=[];
try{
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  socket.addEventListener('message',({data})=>{try{const e=JSON.parse(String(data));if(['AUTH_FAILED','PREVIEW_READY','ERROR'].includes(e.type))events.push(e);}catch{}});
  socket.send(JSON.stringify({type:'AUTH',sessionToken:connection.sessionToken}));delete connection.sessionToken;await new Promise(r=>setTimeout(r,250));assert.ok(!events.some(e=>e.type==='AUTH_FAILED'));
  const command={type:'SERVE_PREVIEW',filePath:path.join(root,'workspace/index.html')};await save('request.json',{command,expectedCandidateSha256:expected,goalVersionId:a.goalVersionId,artifactId:a.artifact.id,models:0,exactOwnerConfirmationAlreadyPresent:true});socket.send(JSON.stringify(command));
  const end=Date.now()+10000;while(!events.some(e=>e.type==='PREVIEW_READY')&&Date.now()<end)await new Promise(r=>setTimeout(r,200));assert.ok(events.some(e=>e.type==='PREVIEW_READY'),'Bound preview was not authorized');
  const response=await fetch(base+'/preview-static/',{signal:AbortSignal.timeout(8000)});assert.ok(response.ok);const body=Buffer.from(await response.arrayBuffer()),entry=await fs.readFile(path.join(root,'workspace/index.html'));assert.equal(sha(body),sha(entry));assert.equal(sha(await fs.readFile(cap.development.ledgerFile)),sha(ledgerBytes));
  const result={served:true,url:base+'/preview-static/',candidateSha256:expected,goalVersionId:a.goalVersionId,entrySha256:sha(entry),bytes:entry.length,modelCalls:0,actualBrowser:false,recordedAt:new Date().toISOString(),evidence:owned};await save('result.json',result);console.log(JSON.stringify(result));
}finally{clearTimeout(timer);socket.close();await save('preview-events.json',events);}
