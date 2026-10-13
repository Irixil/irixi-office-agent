#!/usr/bin/env node
// Controlled real DOM + original frozen scripts. Every API is a fixture, no model or production request.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..'),sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const original06=process.argv[2]==='--original06-assess';
assert.ok(process.argv.length===2||process.argv.length===3&&original06);
const owned=path.join(root,'backend/learning06-default-cas-headless-zero-model-20261006'+(original06?'-raw06':''));
await fs.mkdir(owned,{recursive:false,mode:0o700});
const article=await fs.readFile(path.join(root,'materials/synthetic-correlation-article.txt'),'utf8');
const explain=JSON.parse(await fs.readFile(path.join(root,'backend/learning-06-original-runtime-failure/original-valid-explain-stdout.json'),'utf8'));
const originalAssessText=await fs.readFile(path.join(root,'backend/learning-06-original-runtime-failure/original-rejected-assess-stdout.json'),'utf8');
const originalAssess=JSON.parse(originalAssessText);
const sources={};for(const n of ['27','28']){
 const dir=path.join(root,`backend/development-${n}-exact-native-source-20261006/source`),manifest=JSON.parse(await fs.readFile(path.join(path.dirname(dir),'manifest.json')));
 sources[n]={dir,manifest};for(const f of manifest.manifest)assert.equal(sha(await fs.readFile(path.join(dir,f.path))),f.sha256);
}
const cases=[['old27', '27',0],['new28-zero','28',0],['new28-existing','28',7]];
function fixture(name,version,initialRevision){
 return `(()=>{
 const ARTICLE=${JSON.stringify(article)},EXPLAIN=${JSON.stringify(explain)},ORIGINAL=${JSON.stringify(originalAssess)},ORIGINAL_TEXT=${JSON.stringify(originalAssessText)},CASE=${JSON.stringify(name)},VERSION=${JSON.stringify(version)},START_REV=${initialRevision};
 const f=window.__fixture={case:CASE,version:VERSION,requests:[],inferPosts:0,errors:[],states:{},material:null,originalInvalidRejected:false};
 const response=(status,data)=>Promise.resolve(new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}}));
 window.addEventListener('error',e=>f.errors.push(e.message));window.addEventListener('unhandledrejection',e=>f.errors.push(String(e.reason?.message||e.reason)));
 window.fetch=async(input,init={})=>{
  const url=new URL(String(input),location.href),method=init.method||'GET',body=init.body?JSON.parse(init.body):null;
  if(url.origin!==location.origin||!url.pathname.startsWith('/api/'))throw Error('Fixture forbids real/external fetch');
  const row={path:url.pathname,query:url.search,method,body};f.requests.push(row);
  if(url.pathname==='/api/irixi-authority')return response(200,{current:true,goalVersionId:'fixture-goal',artifact:{candidateSha256:'fixture-candidate',confirmation:{}}});
  if(url.pathname==='/api/irixi-intake')return response(200,{modelAvailability:{learning:{remaining:Math.max(0,2-f.inferPosts),running:false,sealed:false}}});
  if(url.pathname==='/api/irixi-materials'&&method==='POST'){
   f.material={materialEventId:'fixture-material-'+CASE,sessionId:body.sessionId,label:body.label,source:body.source,articleText:body.articleText,articleSha256:${JSON.stringify(sha(article))},normalization:'fixture; already canonical'};
   f.states[body.sessionId]={revision:START_REV,state:null};return response(200,f.material);
  }
  if(url.pathname==='/api/irixi-client-state'&&url.searchParams.get('scope')==='project')return response(200,{scope:'project',items:[],totalSessions:0,limit:200,truncated:false});
  if(url.pathname==='/api/irixi-client-state'){
   const id=body?.sessionId||url.searchParams.get('sessionId'),state=f.states[id];
   if(!state||!f.material)return response(409,{error:'fixture requires registered material'});
   const binding={goalVersionId:'fixture-goal',candidateSha256:'fixture-candidate',materialEventId:f.material.materialEventId};
   if(method==='GET')return response(200,{...state,...binding,material:f.material});
   if(method==='PUT'){
    if(!Number.isInteger(body.expectedRevision)){row.authorityStatus=400;row.gatewayStatus=409;return response(409,{error:'Client-state input is invalid'});}
    if(body.expectedRevision!==state.revision)return response(409,{error:'Client-state revision conflict'});
    if(body.expectedGoalVersionId!==binding.goalVersionId||body.expectedCandidateSha256!==binding.candidateSha256||body.expectedMaterialEventId!==binding.materialEventId)return response(409,{error:'fixture stale binding'});
    state.revision++;state.state=body.state;row.accepted=true;return response(200,{revision:state.revision,...binding});
   }
  }
  if(url.pathname==='/api/irixi-inference'){
   if(method==='POST'){f.inferPosts++;f.last=body;return response(200,{accepted:true,turnId:body.turnId,remaining:2-f.inferPosts});}
   const req=f.last;if(!req||url.searchParams.get('turnId')!==req.turnId)return response(404,{error:'unknown fixture turn'});
   let data=EXPLAIN;
   if(req.kind==='assess'&&!(VERSION==='27'&&${original06})){
    data=structuredClone(ORIGINAL);data.activityQualification.requestedType=req.payload.learnerEntry.questionType;
    data.activityQualification.question=req.payload.learnerEntry.question;data.activityQualification.sourceTurnId='';
    // Only a controlled new-request fixture; original06 bytes/turn remain untouched and are separately rejected.
    data.activityQualification.supported=data.activityQualification.semanticType===req.payload.learnerEntry.questionType;
   }else if(req.kind==='assess')data=ORIGINAL;
   return response(200,{status:'done',text:req.kind==='assess'&&VERSION==='27'&&${original06}?ORIGINAL_TEXT:JSON.stringify(data),textSha256:'fixture-model-output-not-real'});
  }
  throw Error('Unhandled fixture route '+method+' '+url.pathname);
 };
 window.__fixtureArticle=ARTICLE;
 const nativeTimer=window.setTimeout.bind(window);window.setTimeout=(fn,ms,...args)=>nativeTimer(fn,ms===5000?5:ms,...args);
})();`;
}
const server=http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://fixture'),m=/^\/(old27|new28-zero|new28-existing)\/(.+)$/.exec(url.pathname);if(!m){res.writeHead(404);res.end();return;}
  const item=cases.find(c=>c[0]===m[1]);let text,mime;
  if(m[2]==='fixture.js'){text=fixture(...item);mime='text/javascript';}
  else {assert.ok(['index.html','core.js','p0-repair.js','app.js','achievements.js','styles.css'].includes(m[2]));text=await fs.readFile(path.join(sources[item[1]].dir,m[2]),'utf8');mime=m[2].endsWith('.html')?'text/html':m[2].endsWith('.css')?'text/css':'text/javascript';if(m[2]==='index.html')text=text.replace('<script src="core.js">','<script src="fixture.js"></script><script src="core.js">');}
  res.writeHead(200,{'Content-Type':mime,'Cache-Control':'no-store'});res.end(text);
 }catch(e){res.writeHead(500);res.end(e.message);}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const port=server.address().port,profile=path.join(owned,'headless-profile');
const chrome=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',[
 '--headless=new','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-sync','--disable-component-update','--disable-default-apps','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:['ignore','ignore','pipe']});
let diagnostics='';chrome.stderr.on('data',b=>{diagnostics+=b;});let browserSocket,targetSocket;
const results=[],deadline=Date.now()+60000;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function cdp(socket){let ordinal=0;const pending=new Map();socket.addEventListener('message',e=>{const v=JSON.parse(String(e.data));if(v.id&&pending.has(v.id)){const p=pending.get(v.id);pending.delete(v.id);v.error?p.reject(Error(v.error.message)):p.resolve(v.result);}});return(method,params={})=>new Promise((resolve,reject)=>{const id=++ordinal;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});}
async function socket(url){const s=new WebSocket(url);await new Promise((r,j)=>{s.addEventListener('open',r,{once:true});s.addEventListener('error',j,{once:true});});return s;}
let control,send;
async function evaluate(expression){const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.text+': '+r.exceptionDetails.exception?.description);return r.result.value;}
async function until(expression){for(let i=0;i<100;i++){if(Date.now()>deadline)throw Error('controlled test deadline');const r=await evaluate(expression);if(r)return r;await sleep(25);}throw Error('fixture condition did not settle: '+expression);}
try{
 for(let i=0;i<100&&!/DevTools listening on (ws:\/\/\S+)/.test(diagnostics);i++)await sleep(50);
 const ws=/DevTools listening on (ws:\/\/\S+)/.exec(diagnostics)?.[1];assert.ok(ws,'headless Chrome endpoint');browserSocket=await socket(ws);control=cdp(browserSocket);
 const {targetId}=await control('Target.createTarget',{url:'about:blank'});
 const httpbase=ws.replace(/^ws:/,'http:').replace(/\/devtools\/browser\/.*$/,'');const list=await (await fetch(httpbase+'/json/list')).json();targetSocket=await socket(list.find(x=>x.id===targetId).webSocketDebuggerUrl);send=cdp(targetSocket);await send('Page.enable');
 for(const [name,version,initialRevision] of cases){
  await send('Page.navigate',{url:`http://127.0.0.1:${port}/${name}/index.html`});
  await until('window.__fixture && window.LearningAchievements && document.querySelector("#achievementStatus")?.textContent.includes("已从服务器发现")');
  const initial=await evaluate('({type:document.querySelector("#questionType").value,question:document.querySelector("#question").value,record:JSON.parse(localStorage.getItem("irixi.article-learning-12.session.v1"))})');
  assert.equal(initial.record.material,null);assert.equal(initial.type,version==='27'?'recall':'cause');
  await evaluate('document.querySelector("#label").value="CONTROLLED fixture; not user learning";document.querySelector("#source").value="AI synthetic mechanism fixture";document.querySelector("#articleText").value=window.__fixtureArticle;document.querySelector("#materialForm").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));true');
  await until('window.__fixture.material && window.__fixture.requests.some(x=>x.method==="PUT")');
  const first=await evaluate('({request:window.__fixture.requests.find(x=>x.method==="PUT"),getBeforePut:window.__fixture.requests.slice(0,window.__fixture.requests.findIndex(x=>x.method==="PUT")).some(x=>x.path==="/api/irixi-client-state"&&x.query.includes("sessionId=")),server:window.__fixture.states[window.__fixture.material.sessionId],notice:document.querySelector("#achievementStatus").textContent})');
  if(version==='27'){assert.equal(first.getBeforePut,false);assert.equal('expectedRevision' in first.request.body,false);assert.equal(first.server.revision,0);}else{assert.equal(first.getBeforePut,true);assert.equal(first.request.body.expectedRevision,initialRevision);assert.equal(first.request.accepted,true);assert.equal(first.server.revision,initialRevision+1);}
  await evaluate('document.querySelector("#explainBtn").click();true');await until('JSON.parse(localStorage.getItem("irixi.article-learning-12.session.v1")).explanations.length===1');await sleep(300);
  await evaluate('document.querySelector("#answer").value="【CONTROLLED AI test answer; not user learning】冰淇淋销量和游泳人数同时增加已证明冰淇淋促使游泳；随机分组保证零偏差，两个人也能推出所有人。";document.querySelector("#answerForm").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));true');
  await until('JSON.parse(localStorage.getItem("irixi.article-learning-12.session.v1")).turns.length===2 && ["done","invalid"].includes(JSON.parse(localStorage.getItem("irixi.article-learning-12.session.v1")).turns[1].status)');await sleep(300);
  const assessed=await evaluate('({request:window.__fixture.requests.find(x=>x.path==="/api/irixi-inference"&&x.body?.kind==="assess").body.payload,record:JSON.parse(localStorage.getItem("irixi.article-learning-12.session.v1")),server:window.__fixture.states[window.__fixture.material.sessionId],putErrors:window.__fixture.requests.filter(x=>x.method==="PUT"&&!x.accepted).length})');
  assert.equal(assessed.record.assessments.length,version==='27'&&original06?0:1);assert.equal(assessed.request.learnerEntry.questionType,initial.type);
  if(version==='27'&&original06){assert.equal(assessed.record.turns[1].status,'invalid');assert.match(assessed.record.turns[1].error,/请求类别不一致/);}
  if(version==='28'){assert.match(assessed.request.responseContract.required.activityQualification,/supported must be false/);assert.equal(assessed.server.state.record.assessments.length,1);assert.equal(assessed.server.state.record.sessionId,assessed.record.sessionId);}
  // Six sequential actual client changes reproduce the old repeated-save pattern without model calls.
  if(version==='27')for(let n=assessed.putErrors;n<6;n++){await evaluate(`document.querySelector('#opinion').value='controlled save ${n}';document.querySelector('#opinion').dispatchEvent(new Event('change',{bubbles:true}));true`);await sleep(300);}
  const beforeReport=await evaluate('({failures:window.__fixture.requests.filter(x=>x.method==="PUT"&&!x.accepted).length,state:window.__fixture.states[window.__fixture.material.sessionId],notice:document.querySelector("#achievementStatus").textContent})');
  if(version==='27'){assert.equal(beforeReport.failures,6);assert.equal(beforeReport.state.state,null);assert.match(beforeReport.notice,/并发冲突/);}
  await evaluate('document.querySelector(\'[data-view="report"]\').click();true');await until('window.__fixture.states[window.__fixture.material.sessionId].state?.record?.position==="report"');await sleep(300);
  const final=await evaluate('({server:window.__fixture.states[window.__fixture.material.sessionId],errors:window.__fixture.errors,requests:window.__fixture.requests.map(x=>({path:x.path,query:x.query,method:x.method,expectedRevision:x.body?.expectedRevision,accepted:x.accepted,authorityStatus:x.authorityStatus,gatewayStatus:x.gatewayStatus})),defaultType:document.querySelector("#questionType").value})');assert.equal(final.errors.length,0);
  results.push({case:name,sourceVersion:version,initialRevision,defaultType:initial.type,assessmentStatus:assessed.record.turns[1].status,assessmentError:assessed.record.turns[1].error||null,original06AssessBytesReplayedOnlyInControlledFixture:version==='27'&&original06,firstSave:{getBeforePut:first.getBeforePut,expectedRevision:first.request.body.expectedRevision??null,accepted:!!first.request.accepted},failuresBeforeReport:beforeReport.failures,serverBeforeReportRevision:beforeReport.state.revision,serverBeforeReportHadState:!!beforeReport.state.state,afterReportRevision:final.server.revision,afterReportRecordPosition:final.server.state.record.position,serverAssessmentCount:final.server.state.record.assessments.length,errors:final.errors,requests:final.requests});
  await evaluate('localStorage.clear();true');
 }
}catch(e){results.push({error:e.stack});process.exitCode=1;}
finally{
 try{if(control)await control('Browser.close');}catch{}targetSocket?.close();browserSocket?.close();
 await Promise.race([new Promise(r=>chrome.once('exit',r)),sleep(2000)]);if(chrome.exitCode===null&&chrome.signalCode===null)chrome.kill('SIGTERM');
 await new Promise(r=>server.close(r));
 const result={at:new Date().toISOString(),ok:!process.exitCode,tier:'Controlled headless real HTML/DOM and frozen original scripts; every API/model output is a fixture, not actual Native or user acceptance',headless:true,physicalInput:false,nativeCalls:0,productionApiCalls:0,sourceEdited:false,originalInvalidOutputReusedAsActual:false,results};
 await fs.writeFile(path.join(owned,'result.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
 console.log(JSON.stringify({ok:result.ok,cases:results.map(({case:name,sourceVersion,firstSave,failuresBeforeReport,afterReportRevision,error})=>({name,sourceVersion,firstSave,failuresBeforeReport,afterReportRevision,error})),nativeCalls:0,physicalInput:false,evidence:owned}));
}
