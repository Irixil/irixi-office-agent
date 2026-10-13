#!/usr/bin/env node
// Operator acceptance gate: execute unchanged native client/core, real JSON
// storage and localhost HTTP. Responses are controlled fixtures, never models.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { executeNativeApp } from './native-client-vm-adapter.mjs';

const sha = x => crypto.createHash('sha256').update(x).digest('hex');
const KEY = 'irixi.article-learning-12.session.v1';
const article = '[P1] 同时上升不能证明因果，气温可能同时影响两者。\n\n[P2] 随机分组降低混杂风险，但小样本结论仍有限。\n';
const concepts = [
  { id:'correlation',title:'相关不证明因果',location:'P1',sourceQuote:'同时上升不能证明因果',authorView:'同时变化不能证明因果',aiAnalysis:'须排查共同原因',plainExplanation:'一起变不代表互相造成',familiarExample:'气温影响冰淇淋与游泳',relations:[] },
  { id:'random',title:'随机分组仍有限',location:'P2',sourceQuote:'小样本结论仍有限',authorView:'随机分组降低混杂',aiAnalysis:'样本限制不能忽略',plainExplanation:'分组改善证据但没有消除所有限制',familiarExample:'很少人参加的实验',relations:[] }
];
const explanation = { concepts,coverage:concepts.map(c=>({conceptId:c.id,questionTypes:['cause','misconception','application','transfer']})) };
function assessment(response) {
  const wrong = response.includes('必然');
  return { verdict:wrong?'incorrect':'correct',correct:wrong?[]:['指出相关不证明因果'],errors:wrong?[{claim:response,why:'共同原因可以同时影响两者',location:'P1',conceptId:'correlation'}]:[],omissions:[],evidence:[{conceptId:'correlation',location:'P1',quote:'同时上升不能证明因果',reason:wrong?'该回答把相关误当因果':'该回答保留因果证据限制'}],remediation:{explanation:'共同原因也能使两者一起变化',example:'热天冰淇淋与游泳一起增多'},retest:{question:'雨伞与湿路一起出现能证明雨伞使路湿吗？',unseenWhy:'更换到未见的雨天情境'},conceptResults:[{id:'correlation',label:'相关不证明因果',status:wrong?'weak':'verified',evidenceIndexes:[0],...(wrong?{deficiency:{type:'error',index:0}}:{})}] };
}
const summary = { known:['模型擅自声称整篇掌握'],weak:[],untested:[],nextPractice:['检验随机分组与样本限制'],userOpinions:[] };
const node = () => ({value:'',checked:false,disabled:false,hidden:false,textContent:'',innerHTML:'',style:{},dataset:{},classList:{toggle(){},add(){},remove(){}},addEventListener(){},append(){},querySelector(){return node()}});
const delay = ms => new Promise(r=>setTimeout(r,ms));

export async function runNativeClientChecks({workspace,evidenceFile,candidateSha256=null}) {
  const app = await fs.readFile(path.join(workspace,'app.js'),'utf8');
  const core = await fs.readFile(path.join(workspace,'core.js'),'utf8');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(),'irixi-native-client-gate-'));
  const storageFile = path.join(temp,'local-storage.json');
  const report = {recordedAt:new Date().toISOString(),evidenceType:'unchanged native app/core in controlled DOM, real JSON persistence and actual localhost HTTP; controlled model responses',candidateSha256,appSha256:sha(app),coreSha256:sha(core),passed:false,cases:[],nativeModelCalls:0,actualBrowser:false,businessFilesChangedByRoot:false};
  const posts=[],gets=[],reservations=new Map();
  let failNextPost=false,holdFirst=true,releaseFirst,firstSeenResolve;
  const firstSeen=new Promise(r=>firstSeenResolve=r);
  const held=new Promise(r=>releaseFirst=r);
  const forced404=new Map();
  const server=http.createServer(async(req,res)=>{
    try {
      const url=new URL(req.url,'http://localhost');
      const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
      if(url.pathname==='/api/irixi-authority')return send(200,{goalVersionId:'controlled-goal',artifact:{candidateSha256:candidateSha256||'controlled-candidate'}});
      if(url.pathname==='/api/irixi-intake')return send(200,{modelAvailability:{learning:{sealed:false,running:false,remaining:20,deadlineAt:new Date(Date.now()+1200000).toISOString()}}});
      if(url.pathname==='/api/irixi-materials') {
        const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks));
        return send(200,{sessionId:body.sessionId,materialEventId:'controlled-material',articleSha256:sha(body.articleText)});
      }
      if(url.pathname!=='/api/irixi-inference')return send(404,{error:'unknown fixture endpoint'});
      if(req.method==='POST') {
        const chunks=[];for await(const chunk of req)chunks.push(chunk);const raw=Buffer.concat(chunks).toString(),body=JSON.parse(raw);
        posts.push({raw,body,bytes:Buffer.byteLength(raw)});
        if(failNextPost){failNextPost=false;return send(503,{error:'controlled loss before registration'});}
        if(reservations.has(body.turnId))return send(500,{error:'该学习轮次已经提交。'});
        const data=body.kind==='explain'?explanation:body.kind==='assess'?assessment(body.payload.learnerEntry.response):summary;
        const text=JSON.stringify(data);reservations.set(body.turnId,{status:'done',turnId:body.turnId,text,textSha256:sha(text)});
        if(holdFirst){holdFirst=false;firstSeenResolve();await held;}
        return send(200,{accepted:true,turnId:body.turnId});
      }
      const id=url.searchParams.get('turnId');gets.push(id);
      if(forced404.get(id)){forced404.set(id,forced404.get(id)-1);return send(404,{error:'controlled late registration visibility'});}
      return reservations.has(id)?send(200,reservations.get(id)):send(404,{error:'not registered'});
    } catch(error){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message}));}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const base='http://127.0.0.1:'+server.address().port;
  let saves=0;
  function client() {
    const elements=new Map(),get=id=>{if(!elements.has(id))elements.set(id,node());return elements.get(id);};
    const localStorage={getItem(key){const db=existsSync(storageFile)?JSON.parse(readFileSync(storageFile,'utf8')):{};return db[key]??null;},setItem(key,value){assert.equal(typeof value,'string');JSON.parse(value);const db=existsSync(storageFile)?JSON.parse(readFileSync(storageFile,'utf8')):{};db[key]=value;writeFileSync(storageFile,JSON.stringify(db));saves++;},removeItem(key){const db=JSON.parse(readFileSync(storageFile,'utf8'));delete db[key];writeFileSync(storageFile,JSON.stringify(db));}};
    const context=vm.createContext({console,crypto:crypto.webcrypto,localStorage,document:{getElementById:get,querySelectorAll(){return[];},createElement:node,body:node()},fetch:(url,options)=>fetch(new URL(url,base),options),setTimeout:(fn,ms)=>setTimeout(fn,Math.min(ms,2)),clearTimeout,confirm:()=>false,location:{reload(){}},structuredClone});
    vm.runInContext(core,context,{filename:'native-core.js'});
    report.vmAdapter=executeNativeApp(context,app,'native-app.js');
    return {context,get,run:code=>vm.runInContext(code,context),read:()=>JSON.parse(vm.runInContext('JSON.stringify(state)',context))};
  }
  const check=(name,detail={})=>report.cases.push({name,passed:true,...detail});
  async function settle(c,predicate){for(let i=0;i<100;i++){if(predicate(c.read()))return;await delay(5);}throw Error('Native client did not reach expected durable state');}
  function assertProjection(body) {
    assert.ok(Buffer.byteLength(JSON.stringify(body.payload))<=64000,'Native payload exceeds existing 64,000B bound');
    const walk=(value)=>{if(!value||typeof value!=='object')return;for(const [key,item]of Object.entries(value)){assert.ok(!['requestBody','requestPayload','cachedRequest','savedLearningRecord'].includes(key),'Model learning record retains nested transport cache: '+key);walk(item);}};
    walk(body.payload.savedLearningRecord);
  }
  try {
    let c=client();await delay(20);
    c.get('articleText').value=article;c.get('label').value='控制验收材料';c.get('source').value='合成材料';
    await c.run('registerMaterial({preventDefault(){}})');
    assert.equal(c.read().material.articleSha256,sha(article));
    const pending=c.run("infer('explain',{instruction:'controlled explanation'})");
    let firstError;pending.catch(e=>{firstError=e;});
    const reached=await Promise.race([firstSeen.then(()=>true),pending.then(()=>true,()=>false),delay(3000).then(()=>false)]);
    if(!reached)throw firstError||Error('First native request never reached actual HTTP fixture');
    assert.equal(posts.length,1);assert.ok(saves>0);
    const pendingState=c.read(),cached=JSON.stringify(pendingState.turns[0].requestBody);
    assert.ok(cached,'Retry request must be persisted before POST completes');
    c.run("state.opinions.push({text:'later edit'});save()");
    assert.equal(JSON.stringify(c.read().turns[0].requestBody),cached,'Later state mutation changes cached original request');
    c.run('state.opinions.pop();save()');releaseFirst();await pending;
    assert.equal(c.read().explanations.length,1);
    check('First actual native infer serializes, durably saves before HTTP acceptance, sends and stores result; cached snapshot immutable');
    const entry=(response,type='cause')=>({questionType:type,question:'同时上升能证明因果吗？',response,userOpinion:'我的判断仅为个人记录',submittedAt:new Date().toISOString()});
    const wrong=entry('同时上升必然说明因果');
    await c.run('infer("assess",'+JSON.stringify({learnerEntry:wrong,instruction:'controlled wrong answer'})+')');
    assert.equal(c.run('knowledgeState(state).find(x=>x.id==="correlation").status'),'weak');
    const correct=entry('仅凭同时上升不能证明因果','retest');
    await c.run('infer("assess",'+JSON.stringify({learnerEntry:correct,instruction:'controlled corrected answer'})+')');
    await c.run('infer("summarize",{instruction:"controlled saved-record summary"})');
    for(let i=0;i<6;i++)await c.run('infer("assess",'+JSON.stringify({learnerEntry:correct,instruction:'controlled finite-history check'})+')');
    posts.forEach(p=>assertProjection(p.body));
    assert.equal(c.read().summaries[0].known.includes('模型擅自声称整篇掌握'),false);
    assert.ok(c.read().summaries[0].untested.includes('随机分组仍有限'));
    check('Multiple actual native turns remain finite; model records omit request caches; evidence and summary preserve untested concept',{turns:c.read().turns.length,maxPayloadBytes:Math.max(...posts.map(p=>Buffer.byteLength(JSON.stringify(p.body.payload))))});
    failNextPost=true;
    const retryEntry=entry('仅凭同时上升不能证明因果','transfer');
    c.get('questionType').value=retryEntry.questionType;c.get('question').value=retryEntry.question;
    c.get('answer').value=retryEntry.response;c.get('opinion').value=retryEntry.userOpinion;
    await c.run('assess({preventDefault(){}})');
    const rejected=posts.at(-1),failedState=c.read(),retryId=failedState.turns.at(-1).turnId;
    assert.equal(failedState.turns.at(-1).status,'ambiguous','Actual native assessment form did not preserve its failed submission');
    assert.equal(failedState.opinions.filter(x=>x.turnId===retryId&&x.text===retryEntry.userOpinion).length,1,'Submitted personal judgment is missing from the independent ledger after inference503');
    c.run('renderReport()');assert.ok(c.get('report').innerHTML.includes(retryEntry.userOpinion),'Failed inference hides submitted personal judgment from report');
    const beforeReopenPosts=posts.length;c=client();
    await settle(c,s=>s.turns.at(-1).status==='unregistered');
    assert.equal(posts.length,beforeReopenPosts,'Reopen auto-POSTed a new request');
    // A confirmed404 is still the same unresolved original request. The
    // accepted18 exclusivity contract disables new actions until explicit
    // original-ID recovery; GET404 does not grant a second request identity.
    assert.equal(c.get('assessBtn').disabled,true,'Confirmed404 allowed a new ordinary action beside its unresolved original ID');
    c.get('answer').value='later edited answer';c.get('questionType').value='application';c.get('hideSource').checked=true;
    c.run('state.position="practice";save()');
    await c.run('recoverTurn(true)');
    assert.equal(posts.at(-1).body.turnId,retryId);
    assert.equal(posts.at(-1).raw,rejected.raw,'Explicit original-ID retry did not preserve original request bytes');
    assert.equal(c.read().assessments.at(-1).response,retryEntry.response);
    check('Actual close/reopen uses GET only; confirmed404 keeps original-ID recovery available and blocks new actions; explicit retry retains original ID and original answer');
    // Fault injection: stale local404 meets a late registered request. The real
    // duplicate HTTP status is500; no additional fixture reservation is allowed.
    const completed=c.read(),late=completed.turns.at(-1);
    late.status='unregistered';late.requestBody=rejected.body;
    completed.assessments=completed.assessments.filter(x=>x.turnId!==retryId);
    completed.opinions=completed.opinions.filter(x=>x.turnId!==retryId);
    c.run('Object.assign(state,'+JSON.stringify(completed)+');save()');
    forced404.set(retryId,1);const countBefore=reservations.size;
    await c.run('recoverTurn(true)');
    assert.equal(reservations.size,countBefore,'Duplicate original ID consumed a second controlled slot');
    assert.equal(c.read().assessments.filter(x=>x.turnId===retryId).length,1);
    assert.equal(c.read().opinions.filter(x=>x.turnId===retryId).length,1);
    const reopenPostCount=posts.length;c=client();await delay(40);const reopened=c.read();
    assert.equal(posts.length,reopenPostCount);
    assert.equal(reopened.assessments.filter(x=>x.turnId===retryId).length,1);
    assert.equal(reopened.draft.answer,'later edited answer');assert.equal(c.get('questionType').value,'application');assert.equal(c.get('hideSource').checked,true);assert.equal(reopened.position,'practice');
    check('Late duplicate500 falls back to same-result GET; controlled slot count unchanged; reopen has one result/opinion and restored draft/material/position',{fixtureReservations:countBefore,paidBillingClaim:false});
    const unsupported=assessment('仅凭同时上升不能证明因果');unsupported.evidence=[];unsupported.errors=[];unsupported.omissions=[];unsupported.conceptResults[0].status='weak';unsupported.conceptResults[0].evidenceIndexes=[];
    c.context.badAssessment=unsupported;c.context.fixtureConcepts=concepts;c.context.fixtureArticle=article;
    let refused=false;try{c.run('parseModelText(JSON.stringify(badAssessment),"assess",{articleText:fixtureArticle,concepts:fixtureConcepts,learnerResponse:"仅凭同时上升不能证明因果"})');}catch{refused=true;}
    const bound={material:{articleText:article,articleSha256:sha(article)},explanations:[{...explanation,articleSha256:sha(article)}],assessments:[{...unsupported,turnId:'bad',articleSha256:sha(article),response:'仅凭同时上升不能证明因果'}],turns:[{turnId:'bad',kind:'assess',status:'done',articleSha256:sha(article),context:{response:'仅凭同时上升不能证明因果'}}]};
    c.context.badRecord=bound;
    assert.ok(refused||c.run('knowledgeState(badRecord).find(x=>x.id==="correlation").status')!=='weak','Unsupported weak diagnosis entered durable weak state');
    check('Evidence-free weak assessment is refused or remains untested');
    const sharedConcept={...concepts[0],id:'heat',title:'共同原因',sourceQuote:'气温可能同时影响两者'},sharedConcepts=[...concepts,sharedConcept],sharedResponse='两者不能证明因果，但气温只影响游泳。';
    const wrongError=assessment(sharedResponse);
    Object.assign(wrongError,{verdict:'partial',errors:[{conceptId:'heat',claim:'气温只影响游泳',why:'气温可能同时影响两者',location:'P1'}]});
    wrongError.conceptResults[0]={...wrongError.conceptResults[0],status:'weak',deficiency:{type:'error',index:0}};
    c.context.sharedConcepts=sharedConcepts;c.context.sharedResponse=sharedResponse;c.context.wrongError=wrongError;
    let errorRefused=false;try{c.run('parseModelText(JSON.stringify(wrongError),"assess",{articleText:fixtureArticle,concepts:sharedConcepts,learnerResponse:sharedResponse})');}catch{errorRefused=true;}
    c.context.wrongErrorRecord={...bound,explanations:[{...explanation,concepts:sharedConcepts,articleSha256:sha(article)}],assessments:[{...wrongError,turnId:'bad',articleSha256:sha(article),response:sharedResponse}],turns:[{turnId:'bad',kind:'assess',status:'done',articleSha256:sha(article),context:{response:sharedResponse}}]};
    assert.ok(errorRefused&&c.run('knowledgeState(wrongErrorRecord).find(x=>x.id==="correlation").status')!=='weak','An error about another concept in the same paragraph wrongly changes correlation to weak');
    check('Errors cannot cross knowledge points sharing the same paragraph in validator or durable state');
    const wrongOmission=assessment('仅凭同时上升不能证明因果');
    wrongOmission.omissions=[{conceptId:'random',location:'P2',text:'未说明小样本限制'}];
    // Preserve the currently declared string contract if the business candidate
    // has not introduced structured omission identity. This is the native11
    // counterexample: real P1 evidence cannot bind a P2 omission to P1 weakness.
    if(!String(posts.find(p=>p.body.kind==='assess')?.body.payload.responseContract.required.omissions).includes('conceptId'))wrongOmission.omissions=['未说明随机分组仍有小样本限制，这是P2知识点'];
    wrongOmission.conceptResults[0]={...wrongOmission.conceptResults[0],status:'weak',deficiency:{type:'omission',index:0}};
    c.context.unrelatedOmission=wrongOmission;
    let omissionRefused=false;try{c.run('parseModelText(JSON.stringify(unrelatedOmission),"assess",{articleText:fixtureArticle,concepts:fixtureConcepts,learnerResponse:"仅凭同时上升不能证明因果"})');}catch{omissionRefused=true;}
    c.context.unrelatedOmissionRecord={...bound,assessments:[{...wrongOmission,turnId:'bad',articleSha256:sha(article),response:'仅凭同时上升不能证明因果'}]};
    assert.ok(omissionRefused&&c.run('knowledgeState(unrelatedOmissionRecord).find(x=>x.id==="correlation").status')!=='weak','A P2 omission is wrongly bound as P1 weakness');
    check('Omission deficiency cannot cross from P2 into P1 in validator or durable state');
    const omissionResponse='同时上升不能证明因果。',validOmission=assessment(omissionResponse);
    Object.assign(validOmission,{verdict:'partial',omissions:[{conceptId:'correlation',location:'P1',text:'遗漏气温这个共同原因'}],evidence:[{conceptId:'correlation',location:'P1',quote:'气温可能同时影响两者',reason:'真实作答没有说明共同原因'}]});
    validOmission.conceptResults[0]={...validOmission.conceptResults[0],status:'weak',deficiency:{type:'omission',index:0}};
    c.context.validOmission=validOmission;c.context.omissionResponse=omissionResponse;
    c.run('parseModelText(JSON.stringify(validOmission),"assess",{articleText:fixtureArticle,concepts:fixtureConcepts,learnerResponse:omissionResponse})');
    c.context.validOmissionRecord={...bound,assessments:[{...validOmission,turnId:'bad',articleSha256:sha(article),response:omissionResponse}],turns:[{turnId:'bad',kind:'assess',status:'done',articleSha256:sha(article),context:{response:omissionResponse}}]};
    assert.equal(c.run('knowledgeState(validOmissionRecord).find(x=>x.id==="correlation").status'),'weak','A valid P1 omission with its actual response/source evidence cannot become P1 weak');
    assert.equal(c.run('knowledgeState(validOmissionRecord).find(x=>x.id==="random").status'),'taught','Valid P1 omission changed untested P2');
    check('Valid P1 omission produces P1 weak in validator and durable state while P2 remains untested');
    const dupArticle='[P1]重复甲\n\n[P1]重复乙\n\n[P2]可定位的句子\n',dupConcept={...concepts[0],location:'P2',sourceQuote:'可定位的句子'};
    c.context.duplicateText=dupArticle;c.context.duplicateExplanation={concepts:[dupConcept],coverage:[explanation.coverage[0]]};
    assert.throws(()=>c.run('parseModelText(JSON.stringify(duplicateExplanation),"explain",{articleText:duplicateText})'),'Duplicate paragraph labels were accepted when another unique paragraph was referenced');
    check('Global duplicate paragraph labels invalidate evidence identity even when only the other unique label is referenced');
    report.passed=true;
  } catch(error){report.error={message:error.message,stack:String(error.stack).split('\n').slice(0,8)};}
  finally {
    releaseFirst();server.closeAllConnections();await new Promise(r=>server.close(r));
    report.finishedAt=new Date().toISOString();report.actualInferenceHttpPosts=posts.length;report.actualInferenceHttpGets=gets.length;report.realSerializedStorageWrites=saves;report.controlledReservations=reservations.size;
    report.requestSizes=posts.map(p=>({turnId:p.body.turnId,kind:p.body.kind,bytes:p.bytes,payloadBytes:Buffer.byteLength(JSON.stringify(p.body.payload))}));
    report.actualResponseContracts=Object.fromEntries([...new Set(posts.map(p=>p.body.kind))].map(kind=>[kind,posts.find(p=>p.body.kind===kind).body.payload.responseContract]));
    report.sourceUnchanged=sha(await fs.readFile(path.join(workspace,'app.js')))==report.appSha256&&sha(await fs.readFile(path.join(workspace,'core.js')))==report.coreSha256;
    if(!report.sourceUnchanged){report.passed=false;report.error={message:'Native business source changed during root acceptance gate'};}
    await fs.rm(temp,{recursive:true,force:true});
    await fs.writeFile(evidenceFile,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
  }
  return report;
}
if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(import.meta.filename)) {
  const args=process.argv.slice(2);if(args.length!==4||args[0]!=='--workspace'||args[2]!=='--evidence')throw Error('Use --workspace owned-candidate --evidence new-owned-evidence.json');
  const result=await runNativeClientChecks({workspace:path.resolve(args[1]),evidenceFile:path.resolve(args[3])});
  process.stdout.write(JSON.stringify(result)+'\n');if(!result.passed)process.exitCode=1;
}
