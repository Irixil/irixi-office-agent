#!/usr/bin/env node
// Operator acceptance evidence outside the native business workspace.
// Each invocation performs only its explicit one action; no model retry/batch loop.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import {createRequire} from 'node:module';

const root=path.resolve(import.meta.dirname,'..'),base='http://127.0.0.1:9109';
const args=process.argv.slice(2),action=args[0],name=args[1];
assert.ok((action==='--register'&&args.length===1)||(action==='--open-batch'&&args.length===1)||(action==='--turn'&&['explain','wrong','retest','summary'].includes(name)&&(args.length===2||(name==='retest'&&args.length===4&&args[2]==='--answer-file'))),'Explicitly --register, --open-batch, or --turn explain|wrong|retest|summary [--answer-file owned-relative-path]');
const owned=path.join(root,'backend','real-learning-acceptance-20261005'),stateFile=path.join(owned,'benchmark-record.json');
const digest=s=>crypto.createHash('sha256').update(s).digest('hex'),pause=ms=>new Promise(r=>setTimeout(r,ms));
async function api(route,body){const r=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{Origin:base,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)});const v=await r.json();if(!r.ok)throw Error(`Product API ${route} (${r.status}): ${v.error}`);return v;}
const [authority,intake]=await Promise.all([api('/api/irixi-authority'),api('/api/irixi-intake')]);
assert.equal(authority.current,true);assert.equal(intake.goal.confirmed,true);assert.equal(authority.goalVersionId,intake.goal.id);assert.equal(authority.artifact.review.passed,true);assert.ok(authority.artifact.confirmation);
const core=createRequire(import.meta.url)(path.join(root,'workspace/core.js'));
const app=await fs.readFile(path.join(root,'workspace/app.js'),'utf8');
const contractScope=Object.create(null),locationMatch=app.match(/^const locationRule=(.+);$/m);
if(locationMatch)contractScope.locationRule=vm.runInNewContext(locationMatch[1],Object.create(null),{timeout:1000});
const match=app.match(/^const contracts=(.+);$/m);assert.ok(match,'Read exact native client response contract');const contracts=vm.runInNewContext('('+match[1]+')',contractScope,{timeout:1000});
const instructions={};for(const kind of ['explain','assess','summarize']){const m=app.match(new RegExp("infer\\('"+kind+"',\\{(?:learnerEntry:entry,)?instruction:(.*?)\\}\\)"));assert.ok(m,'Read exact client '+kind+' instruction');instructions[kind]=vm.runInNewContext(m[1],contractScope,{timeout:1000});assert.equal(typeof instructions[kind],'string');}
await fs.mkdir(owned,{recursive:true,mode:0o700});
async function saveNew(file,value){await fs.writeFile(file,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});}
async function saveState(s){const tmp=stateFile+'.'+crypto.randomUUID()+'.tmp';await fs.writeFile(tmp,JSON.stringify(s,null,2)+'\n',{flag:'wx',mode:0o600});await fs.rename(tmp,stateFile);}
const binding={goalVersionId:authority.goalVersionId,candidateSha256:authority.artifact.candidateSha256};
if(action==='--register'){
  await assert.rejects(fs.access(stateFile));assert.equal(intake.modelAvailability.learning.running,false);assert.equal(intake.modelAvailability.learning.sealed,false);
  const articleText=core.normalizeText(await fs.readFile(path.join(root,'materials/synthetic-correlation-article.txt'),'utf8'));
  assert.equal(digest(articleText),'30a13cff47372a135a9ce191bfe2e2ab8ab2611d45901091e17fe0b86faabcc8');
  const sessionId='mechanism-benchmark-'+crypto.randomUUID(),request={sessionId,label:'合成验收：相关性与因果性',source:'公开/合成机制验收材料；以下答案由验收代理构造，不代表真实用户已学会',articleText};
  const material=await api('/api/irixi-materials',request);assert.equal(material.articleSha256,digest(articleText));assert.equal(material.sessionId,sessionId);
  const s={...binding,sessionId,material:{...material,articleText,source:request.source},explanations:[],assessments:[],opinions:[],summaries:[],turns:[],benchmarkOnly:true,humanLearningProven:false};
  await saveNew(path.join(owned,'material-registration.json'),{recordedAt:new Date().toISOString(),binding,request,response:material,nativeCalls:0});await saveState(s);console.log(JSON.stringify({registered:true,...binding,sessionId,articleSha256:material.articleSha256,nativeCalls:0}));
}else{
  const s=JSON.parse(await fs.readFile(stateFile));assert.equal(s.goalVersionId,binding.goalVersionId);assert.equal(s.candidateSha256,binding.candidateSha256);assert.ok(s.turns.every(t=>t.status==='done'),'No new operation after invalid, failed or incomplete turn');
  if(action==='--open-batch'){
    const l=intake.modelAvailability.learning;assert.equal(l.running,false);assert.equal(l.sealed,false);assert.equal(l.remaining,0);
    const response=await api('/api/irixi-learning/open-batch',{expectedGoalVersionId:binding.goalVersionId,expectedCandidateSha256:binding.candidateSha256});
    await saveNew(path.join(owned,'explicit-learning-batch-'+response.ordinal+'.json'),{recordedAt:new Date().toISOString(),authorizationSource:'Existing continuous advancement Sentinel_02b6e8cd601481919c4d63e2e0c395f8; separately explicit bounded acceptance batch',binding,response});console.log(JSON.stringify({explicitBatchOpened:true,response,nativeCalls:0}));
  }else{
    const l=intake.modelAvailability.learning;assert.equal(l.running,false);assert.equal(l.sealed,false);assert.ok(l.remaining>0);
    const kind=name==='summary'?'summarize':name==='explain'?'explain':'assess';let learnerEntry=null;
    if(name==='explain'){assert.equal(s.explanations.length,0);assert.equal(s.turns.length,0);}
    else if(name==='wrong'){assert.equal(s.explanations.length,1);assert.equal(s.assessments.length,0);learnerEntry={questionType:'misconception',question:'不用原文，解释冰淇淋销量与游泳人数同时上升能否证明因果，以及随机分组和小样本的作用。',response:'冰淇淋销量和游泳人数同时上升，所以吃冰淇淋导致更多人游泳；相关足以证明因果。只要随机分组就保证每次实验完全没有偏差，一个小样本也足以确定普遍结论。',userOpinion:'验收代理模拟个人判断：我觉得自己已经完全会了。此意见不能代替作答证据。',submittedAt:new Date().toISOString()};}
    else if(name==='retest'){assert.ok(s.assessments.length>0);assert.equal(args.length,4,'Provide a concrete benchmark answer for the actual unseen retest');const rel=args[3];assert.ok(rel.startsWith('backend/real-learning-acceptance-20261005/')&&!rel.includes('..')&&/^[A-Za-z0-9_./-]+$/.test(rel));const answerFile=path.join(root,rel),stat=await fs.lstat(answerFile);assert.ok(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size<=10000);const response=(await fs.readFile(answerFile,'utf8')).trim();assert.ok(response);learnerEntry={questionType:'retest',question:s.assessments.at(-1).retest.question,response,userOpinion:'验收代理构造重测答案，不能说明真实用户学习效果。',submittedAt:new Date().toISOString()};}
    else assert.ok(s.assessments.length>0);
    const turnId='benchmark-'+crypto.randomUUID(),turn={turnId,kind,status:'running',articleSha256:s.material.articleSha256,context:learnerEntry,startedAt:new Date().toISOString(),acceptanceCase:name},request={projectId:'article-learning-12',sessionId:s.sessionId,turnId,kind,articleSha256:s.material.articleSha256,payload:{articleText:s.material.articleText,savedLearningRecord:{materialEventId:s.material.materialEventId,articleSha256:s.material.articleSha256,explanations:s.explanations,assessments:s.assessments,opinions:s.opinions,turns:s.turns},...(learnerEntry?{learnerEntry}:{}),instruction:instructions[kind],responseContract:contracts[kind]}};
    const turnDir=path.join(owned,name+'-'+turnId);await fs.mkdir(turnDir,{recursive:false,mode:0o700});await saveNew(path.join(turnDir,'request.json'),{binding,benchmarkOnly:true,request});
    s.turns.push(turn);await saveState(s);let terminal;
    try{
      const accepted=await api('/api/irixi-inference',request);await saveNew(path.join(turnDir,'accepted.json'),accepted);assert.equal(accepted.accepted,true);assert.equal(accepted.turnId,turnId);console.log(JSON.stringify({phase:'native_learning_requested',kind,acceptanceCase:name,turnId,...binding}));
      const until=Date.now()+1200000;while(Date.now()<until){terminal=await api('/api/irixi-inference?turnId='+encodeURIComponent(turnId));if(terminal.status!=='running')break;await pause(4000);}assert.equal(terminal?.status,'done','Native inference did not complete; preserve without retry');
      await saveNew(path.join(turnDir,'raw-result.json'),terminal);assert.equal(digest(terminal.text),terminal.textSha256);
      const data=core.parseModelText(terminal.text,kind,{articleText:s.material.articleText,...(kind==='assess'?{concepts:s.explanations.at(-1).concepts,learnerResponse:learnerEntry.response}:{})});
      Object.assign(turn,{status:'done',textSha256:terminal.textSha256,completedAt:new Date().toISOString()});const saved={...data,...(learnerEntry||{}),turnId,articleSha256:s.material.articleSha256,createdAt:new Date().toISOString()};
      if(kind==='explain')s.explanations.push(saved);else if(kind==='assess'){s.assessments.push(saved);s.opinions.push({text:learnerEntry.userOpinion,at:learnerEntry.submittedAt});}else s.summaries.push(core.reconcileSummary(saved,s));
      await saveState(s);const ledger=JSON.parse(await fs.readFile(JSON.parse(await fs.readFile(path.join(root,'state/model-capability.json'))).learning.ledgerFile));
      const status={recordedAt:new Date().toISOString(),binding,ok:true,acceptanceCase:name,turnId,kind,rawResultSha256:terminal.textSha256,structuredResult:data,knowledgeState:core.knowledgeState(s),reconciledSummary:s.summaries.at(-1)||null,benchmarkOnly:true,humanLearningProven:false,actualBrowser:false,automaticRetry:false,ledger};await saveNew(path.join(turnDir,'result.json'),status);console.log(JSON.stringify(status));
    }catch(e){Object.assign(turn,{status:terminal?.status==='done'?'invalid':'failed',error:e.message,completedAt:new Date().toISOString()});await saveState(s);await saveNew(path.join(turnDir,'failure.json'),{recordedAt:new Date().toISOString(),binding,error:e.message,terminal:terminal||null,automaticRetry:false,benchmarkOnly:true});process.exitCode=1;console.log(JSON.stringify({ok:false,kind,turnId,error:e.message,automaticRetry:false}));}
  }
}
