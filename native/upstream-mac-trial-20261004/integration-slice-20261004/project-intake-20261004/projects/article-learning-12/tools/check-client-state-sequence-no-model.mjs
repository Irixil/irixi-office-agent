// Execute the actual compiled client across bounded article/session/batch
// transitions. HTTP and JSON persistence are real; responses and budgets are
// controlled fixtures. No real authority, model, browser or business write.
import fs from 'node:fs/promises';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {executeNativeApp} from './native-client-vm-adapter.mjs';

const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const KEY='irixi.article-learning-12.session.v1',HISTORY='irixi.article-learning-12.history.v1';
const article='[P1] 同时上升不能证明因果，气温可能同时影响两者。\n\n[P2] 随机分组降低混杂风险，但小样本结论仍有限。\n';
const concepts=[{id:'correlation',title:'相关不证明因果',location:'P1',sourceQuote:'同时上升不能证明因果',authorView:'同时变化不能证明因果',aiAnalysis:'排查共同因素',plainExplanation:'一起变不代表互相造成',familiarExample:'热天冰淇淋与游泳',relations:[]},{id:'random',title:'随机分组仍有限',location:'P2',sourceQuote:'小样本结论仍有限',authorView:'随机分组降低混杂',aiAnalysis:'样本限制仍须保留',plainExplanation:'改善分组没有消除所有限制',familiarExample:'很少人参加实验',relations:[]}];
const explanation={concepts,coverage:concepts.map(c=>({conceptId:c.id,questionTypes:['cause','misconception','application','transfer']}))};
function diagnosis(response){const wrong=response.includes('必然');return{verdict:wrong?'incorrect':'correct',correct:wrong?[]:['保留因果限制'],errors:wrong?[{conceptId:'correlation',claim:response,why:'共同因素可以同时影响两者',location:'P1'}]:[],omissions:[],evidence:[{conceptId:'correlation',location:'P1',quote:'同时上升不能证明因果',reason:wrong?'回答将相关误当因果':'回答保留因果证据限制'}],remediation:{explanation:'共同因素也能使两者一起改变',example:'热天冰淇淋与游泳一起增多'},retest:{question:'雨伞销量与湿路一起增多能证明买伞使路湿吗？',unseenWhy:'换到未见的雨天情境'},conceptResults:[{id:'correlation',label:'相关不证明因果',status:wrong?'weak':'verified',evidenceIndexes:[0],...(wrong?{deficiency:{type:'error',index:0}}:{})}]};}
const syntheticSummary={known:['模型擅自声称整篇掌握'],weak:[],untested:[],nextPractice:['检验随机分组和样本限制'],userOpinions:['模型推断用户自信']};
const element=()=>({value:'',checked:false,disabled:false,hidden:false,textContent:'',innerHTML:'',style:{},dataset:{},listeners:new Map(),classList:{toggle(){},add(){},remove(){}},addEventListener(type,fn){const a=this.listeners.get(type)||[];a.push(fn);this.listeners.set(type,a)},append(){},querySelector(){return element()}});

export async function runClientStateSequence({workspace,evidenceFile,candidateSha256=null}){
 const app=await fs.readFile(path.join(workspace,'app.js'),'utf8'),core=await fs.readFile(path.join(workspace,'core.js'),'utf8');
 const owned=await fs.mkdtemp(path.join(os.tmpdir(),'irixi-state-sequence-')),fixtures=[];
 const report={recordedAt:new Date().toISOString(),candidateSha256,appSha256:sha(app),coreSha256:sha(core),evidenceType:'unchanged native app/core, controlled DOM, real JSON files and localhost HTTP with synthetic results and bounded runtime fixtures',nativeModelCalls:0,actualBrowser:false,businessFilesChangedByRoot:false,passed:false,cases:[],blockers:[]};
 const check=(name,pass,detail={},group=null)=>{const c={name,passed:!!pass,...detail};report.cases.push(c);if(!pass)report.blockers.push({group:group||name,...c})};
 async function fixture(runtime={}){
  const f={runtime:{remaining:2,running:false,sealed:false,deadlineAt:new Date(Date.now()+1200000).toISOString(),...runtime},batch:1,calls:[],posts:[],batchPosts:[],gets:[],reservations:new Map(),failNextPost:false};
  f.server=http.createServer(async(req,res)=>{try{
   const u=new URL(req.url,'http://fixture'),send=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value))};
   if(u.pathname==='/api/irixi-authority')return send(200,{goalVersionId:'fixture-goal',artifact:{candidateSha256:candidateSha256||'fixture-candidate'}});
   if(u.pathname==='/api/irixi-intake')return send(200,{modelAvailability:{learning:f.runtime}});
   if(req.method==='GET'&&u.pathname==='/api/irixi-inference'){const id=u.searchParams.get('turnId');f.gets.push(id);return f.reservations.has(id)?send(200,f.reservations.get(id)):send(404,{error:'not registered'})}
   const chunks=[];for await(const chunk of req)chunks.push(chunk);const raw=Buffer.concat(chunks).toString(),b=JSON.parse(raw);
   if(u.pathname==='/api/irixi-materials')return send(200,{sessionId:b.sessionId,label:b.label,materialEventId:crypto.randomUUID(),articleSha256:sha(b.articleText),normalization:'native UTF-8 canonical text'});
   if(u.pathname==='/api/irixi-learning/open-batch'){
    f.batchPosts.push(b);
    if(f.runtime.remaining!==0||f.runtime.running||f.runtime.sealed)return send(409,{error:'prior batch is not successful and exhausted'});
    if(b.expectedGoalVersionId!=='fixture-goal'||b.expectedCandidateSha256!==(candidateSha256||'fixture-candidate'))return send(409,{error:'stale binding'});
    f.batch++;f.runtime.remaining=2;f.runtime.deadlineAt=new Date(Date.now()+1200000).toISOString();return send(200,{ordinal:f.batch,cap:2,windowMs:1200000});
   }
   if(u.pathname!=='/api/irixi-inference')return send(404,{error:'unknown fixture endpoint'});
   f.posts.push({raw,body:b});
   if(f.failNextPost){f.failNextPost=false;return send(503,{error:'controlled uncertainty before registration'})}
   if(f.reservations.has(b.turnId))return send(500,{error:'该学习轮次已经提交。'});
   if(f.runtime.remaining<1||f.runtime.running||f.runtime.sealed||Date.parse(f.runtime.deadlineAt)<Date.now())return send(500,{error:'known controlled runtime cannot accept a new inference'});
   const data=b.kind==='explain'?explanation:b.kind==='assess'?diagnosis(b.payload.learnerEntry.response):syntheticSummary,text=JSON.stringify(data);
   f.runtime.remaining--;f.calls.push({turnId:b.turnId,kind:b.kind,batch:f.batch});f.reservations.set(b.turnId,{status:'done',turnId:b.turnId,text,textSha256:sha(text)});return send(200,{accepted:true,turnId:b.turnId,remaining:f.runtime.remaining});
  }catch(e){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:e.message}))}});
  await new Promise((resolve,reject)=>{f.server.once('error',reject);f.server.listen(0,'127.0.0.1',resolve)});f.base='http://127.0.0.1:'+f.server.address().port;fixtures.push(f);return f;
 }
 let ordinal=0;
 function client(f,{stored=null,storageFile=null,freezeInferenceGet=false,allowConfirm=true}={}){
  const file=storageFile||path.join(owned,'session-'+(++ordinal)+'.json');
  if(stored)writeFileSync(file,JSON.stringify({[KEY]:JSON.stringify(stored)}));
  const elements=new Map(),get=id=>{if(!elements.has(id))elements.set(id,element());return elements.get(id)};
  const db=()=>existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{};let reloads=0,confirmations=0;
  // Hold only the injected preexisting unresolved turns. A forbidden new ID,
  // if created by the native client, must finish its real fixture HTTP poll so
  // the exclusivity counterexample can be recorded rather than hanging.
  const frozenIds=new Set(freezeInferenceGet?(JSON.parse(db()[KEY]||'null')?.turns||[]).map(t=>t.turnId):[]);
  const context=vm.createContext({console,crypto:crypto.webcrypto,structuredClone,setTimeout:(fn,ms)=>setTimeout(fn,Math.min(ms,2)),clearTimeout,document:{getElementById:get,querySelectorAll(){return[]},createElement:element,body:element()},localStorage:{getItem:k=>db()[k]||null,setItem:(k,v)=>{JSON.parse(v);writeFileSync(file,JSON.stringify({...db(),[k]:v}))},removeItem:k=>{const d=db();delete d[k];writeFileSync(file,JSON.stringify(d))}},fetch:(url,options={})=>freezeInferenceGet&&(!options.method||options.method==='GET')&&String(url).startsWith('/api/irixi-inference')&&frozenIds.has(new URL(url,f.base).searchParams.get('turnId'))?new Promise(()=>{}):fetch(new URL(url,f.base),options),confirm:()=>{confirmations++;return allowConfirm},location:{reload(){reloads++}}});
  vm.runInContext(core,context,{filename:'native-core.js'});executeNativeApp(context,app);
  return{context,get,file,db,run:code=>vm.runInContext(code,context),read:()=>JSON.parse(vm.runInContext('JSON.stringify(state)',context)),click:id=>get(id).listeners.get('click')?.[0]?.({preventDefault(){}}),counts:()=>({reloads,confirmations})};
 }
 async function register(c,text=article){c.get('articleText').value=text;c.get('label').value='合成状态验收';c.get('source').value='仅用于机制验收';await c.run('registerMaterial({preventDefault(){}})')}
 async function assess(c,response,type='misconception'){c.get('questionType').value=type;c.get('question').value=type==='retest'?c.read().assessments.at(-1).retest.question:'同时上升能证明因果吗？';c.get('answer').value=response;c.get('opinion').value='我的判断独立于模型证据';c.get('hideSource').checked=true;await c.run('assess({preventDefault(){}})')}
 async function settle(c,predicate){for(let i=0;i<100;i++){if(predicate(c.read()))return true;await new Promise(r=>setTimeout(r,5))}return false}
 try{
  const f=await fixture();let c=client(f);await c.run('refreshRuntime()');await register(c);
  check('Full material is registered with exact body hash and kept in native JSON',c.read().material.articleSha256===sha(article));
  await c.run('explain()');check('First actual native action explains and remains taught',c.read().turns.at(-1)?.status==='done'&&c.read().explanations.length===1&&c.run('knowledgeState(state).every(x=>x.status==="taught")'));
  f.failNextPost=true;await assess(c,'同时上升必然说明因果');const ambiguous=c.read(),original=ambiguous.turns.at(-1),originalRaw=f.posts.at(-1).raw;
  check('Ambiguous submission retains same request ID, original payload and independent personal opinion',original.status==='ambiguous'&&ambiguous.opinions.some(x=>x.turnId===original.turnId&&x.text==='我的判断独立于模型证据'));
  const beforeReopen=f.posts.length;c=client(f,{storageFile:c.file});const restored=await settle(c,s=>s.turns.at(-1)?.status==='unregistered');
  check('Close/reopen queries same turn only; does not consume a second call',restored&&f.posts.length===beforeReopen&&f.calls.length===1);
  await c.run('recoverTurn(true)');check('Explicit original-ID recovery uses original bytes and yields one result/opinion',f.posts.at(-1).raw===originalRaw&&c.read().assessments.filter(x=>x.turnId===original.turnId).length===1&&c.read().opinions.filter(x=>x.turnId===original.turnId).length===1&&f.calls.length===2);
  check('Wrong answer is weak; personal opinion does not imply mastery',c.run('knowledgeState(state).find(x=>x.id==="correlation").status')==='weak');
  const cycle=c.read();await c.run('refreshRuntime()');
  for(const status of ['submitting','ambiguous','running','unregistered','invalid','incomplete','failed','stale','refused','done_missing_result']){
   const broken=structuredClone(cycle),turn=broken.turns.at(-1);turn.status=status==='done_missing_result'?'done':status;
   if(status==='done_missing_result')broken.assessments=broken.assessments.filter(x=>x.turnId!==turn.turnId);
   const edge=await fixture({remaining:0}),branch=client(edge,{stored:broken,freezeInferenceGet:true});await branch.run('refreshRuntime()');
   {
    const visibleNotice=branch.get('notice').textContent,visibleRecovery=!branch.get('recovery').hidden&&branch.get('recoveryText').textContent;
    check('Reopened '+status+' visibly explains the preserved unresolved state',!!(visibleNotice||visibleRecovery),{status,notice:visibleNotice,recoveryHidden:branch.get('recovery').hidden,recoveryText:branch.get('recoveryText').textContent},'reopened_terminal_state_invisible');
   }
   branch.click('newSession');const after=branch.db();
   check('New session preserves unresolved '+status,!!after[KEY]&&JSON.parse(after[KEY]).turns.some(x=>x.turnId===turn.turnId),{status,activeRemoved:!after[KEY],archived:!!after[HISTORY],...branch.counts()},'unresolved_session_archive');
   const batchBranch=client(edge,{stored:broken,freezeInferenceGet:true});await batchBranch.run('refreshRuntime()');const before=edge.batchPosts.length;await batchBranch.run('openBatch()');
   check('Next batch cannot hide unresolved '+status,edge.batchPosts.length===before,{status,attemptedBatchPosts:edge.batchPosts.length-before},'unresolved_batch_open');
   for(const action of ['assess','summary']){
    const available=await fixture({remaining:1}),inferenceBranch=client(available,{stored:broken,freezeInferenceGet:true});await inferenceBranch.run('refreshRuntime()');const beforeTurns=inferenceBranch.read().turns.length;const button=action==='assess'?'assessBtn':'summaryBtn',actionEnabled=!inferenceBranch.get(button).disabled;
    check('Native '+action+' button is unavailable beside unresolved '+status,!actionEnabled,{status,action,actionEnabled},'unresolved_action_enabled');
    if(action==='assess')await assess(inferenceBranch,'仅凭同时上升不能证明因果');else await inferenceBranch.run('summarize()');
    check('Available runtime '+action+' cannot create a second ID beside unresolved '+status,inferenceBranch.read().turns.length===beforeTurns&&available.posts.length===0,{status,action,actionEnabled,newTurns:inferenceBranch.read().turns.length-beforeTurns,inferencePosts:available.posts.length},'unresolved_turn_allows_new_id');
   }
  }
  for(const [label,runtime] of [['quota_exhausted',{remaining:0}],['model_running',{remaining:1,running:true}],['sealed_failure',{remaining:1,sealed:true}],['expired_window',{remaining:1,deadlineAt:new Date(Date.now()-1000).toISOString()}]]){
   const edge=await fixture(runtime),branch=client(edge,{stored:cycle});await branch.run('refreshRuntime()');const turns=branch.read().turns.length;await branch.run('summarize()');
   check('Known '+label+' does not create an ambiguous new inference turn',branch.read().turns.length===turns&&edge.posts.length===0,{label,newTurns:branch.read().turns.length-turns,inferencePosts:edge.posts.length},'known_runtime_creates_phantom_turn');
  }
  const emptyFixture=await fixture({remaining:0}),empty=client(emptyFixture);await empty.run('refreshRuntime()');await empty.run('openBatch()');
  check('Empty article context waits for its existing required material registration',emptyFixture.batchPosts.length===0,{attemptedBatchPosts:emptyFixture.batchPosts.length},'empty_material_batch_context');
  const unopened=f.batchPosts.length;await c.run('openBatch()');await c.run('refreshRuntime()');
  check('Completed explain/assess cycle explicitly opens exactly one bounded next batch',f.batchPosts.length===unopened+1&&f.runtime.remaining===2);
  await assess(c,'仅凭同时上升不能证明因果','retest');await c.run('summarize()');
  const saved=c.read();check('Corrected unseen retest and saved summary retain untouched untested concept',saved.turns.every(t=>t.status==='done')&&saved.summaries.length===1&&!saved.summaries[0].known.includes('模型擅自声称整篇掌握')&&saved.summaries[0].untested.includes('随机分组仍有限')&&saved.summaries[0].userOpinions.every(x=>x==='我的判断独立于模型证据'));
  c.run('show("report");save()');const reopenPosts=f.posts.length;c=client(f,{storageFile:c.file});await c.run('refreshRuntime()');
  check('Saved report, material, original response and view reopen with no inference POST',c.read().position==='report'&&c.read().material.articleSha256===sha(article)&&c.read().summaries.length===1&&f.posts.length===reopenPosts);
  c.click('newSession');const history=JSON.parse(c.db()[HISTORY]||'[]');const archived=history.at(-1);
  check('Fully resolved article may be explicitly archived without deleting its results',!c.db()[KEY]&&archived?.summaries.length===1&&archived?.turns.length===4);
  c=client(f,{storageFile:c.file});await c.run('refreshRuntime()');await register(c,article.replace('气温可能','炎热气温可能'));
  const beforeFresh=f.batchPosts.length;await c.run('openBatch()');await c.run('refreshRuntime()');
  check('Fresh registered article can obtain its first calls after prior successful article; no same-session-cycle deadlock',f.batchPosts.length===beforeFresh+1&&f.runtime.remaining===2&&c.read().turns.length===0);
  await c.run('explain()');await assess(c,'仅凭同时上升不能证明因果');
  check('New article still follows explain then assess and retains old completed archive',c.read().turns.length===2&&c.read().turns[0].kind==='explain'&&c.read().turns[1].kind==='assess'&&c.read().turns.every(t=>t.status==='done')&&JSON.parse(c.db()[HISTORY])[0].material.articleSha256===sha(article));
  report.mainControlledCalls=f.calls;report.mainControlledInferencePosts=f.posts.length;report.mainExplicitBatchPosts=f.batchPosts.length;
  report.passed=report.blockers.length===0;
 }catch(error){report.error={message:error.message};report.blockers.push({group:'state_sequence_execution',message:error.message})}
 finally{
  for(const f of fixtures){f.server.closeAllConnections();await new Promise(r=>f.server.close(r))}
  report.finishedAt=new Date().toISOString();report.sourceUnchanged=sha(await fs.readFile(path.join(workspace,'app.js')))==report.appSha256&&sha(await fs.readFile(path.join(workspace,'core.js')))==report.coreSha256;
  if(!report.sourceUnchanged){report.passed=false;report.blockers.push({group:'source_changed_during_check'})}
  await fs.rm(owned,{recursive:true,force:true});await fs.writeFile(evidenceFile,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
 }
 return report;
}
if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(import.meta.filename)){
 const args=process.argv.slice(2);assert.ok(args.length===4&&args[0]==='--workspace'&&args[2]==='--evidence');
 const r=await runClientStateSequence({workspace:path.resolve(args[1]),evidenceFile:path.resolve(args[3])});console.log(JSON.stringify({passed:r.passed,error:r.error||null,blockerGroups:[...new Set(r.blockers.map(x=>x.group))],cases:r.cases,nativeModelCalls:0,actualBrowser:false,sourceUnchanged:r.sourceUnchanged}));if(!r.passed)process.exitCode=1;
}
