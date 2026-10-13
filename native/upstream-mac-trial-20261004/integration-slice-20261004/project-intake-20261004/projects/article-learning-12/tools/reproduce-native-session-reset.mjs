// Read-only business-source diagnosis; controlled DOM/GETs and persisted-turn
// fault injection. Never opens a real batch, performs a POST or invokes models.
import fs from 'node:fs/promises';
import vm from 'node:vm';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { executeNativeApp } from './native-client-vm-adapter.mjs';
const app=await fs.readFile('workspace/app.js','utf8'),core=await fs.readFile('workspace/core.js','utf8');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const KEY='irixi.article-learning-12.session.v1',HISTORY='irixi.article-learning-12.history.v1',results=[];
try {
  for(const status of ['submitting','ambiguous','running','failed']) {
    const original={sessionId:'controlled-session',material:{articleText:'[P1]相关不能证明因果。\n',articleSha256:'controlled-sha',materialEventId:'controlled-material',label:'合成',source:'故障注入'},position:'practice',explanations:[],assessments:[],opinions:[{text:'保留我的判断'}],summaries:[],draft:{},turns:[{turnId:'original-unresolved-turn',kind:'assess',status,articleSha256:'controlled-sha',requestBody:{turnId:'original-unresolved-turn'}}]};
    const storage=new Map([[KEY,JSON.stringify(original)]]),elements=new Map();let reloads=0,confirmations=0,posts=0;
    const element=()=>({value:'',checked:false,disabled:false,hidden:false,textContent:'',innerHTML:'',style:{},dataset:{},classList:{toggle(){},add(){},remove(){}},listeners:new Map(),addEventListener(type,fn){const list=this.listeners.get(type)||[];list.push(fn);this.listeners.set(type,list)},append(){},querySelector(){return element()}});
    const get=id=>{if(!elements.has(id))elements.set(id,element());return elements.get(id)};
    const context=vm.createContext({crypto:crypto.webcrypto,console,document:{getElementById:get,querySelectorAll(){return[]},createElement:element,body:element()},localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>{JSON.parse(v);storage.set(k,v)},removeItem:k=>storage.delete(k)},fetch:async(url,options={})=>{if(options.method==='POST'){posts++;throw Error('No POST allowed in readonly counterexample')}if(String(url).startsWith('/api/irixi-inference'))return new Promise(()=>{});return {ok:true,json:async()=>String(url).includes('intake')?{modelAvailability:{learning:{remaining:0,running:false,sealed:false}}}:{goalVersionId:'fixture-goal',artifact:{candidateSha256:'fixture-candidate'}}}},setTimeout,clearTimeout,structuredClone,confirm:()=>{confirmations++;return true},location:{reload(){reloads++}}});
    vm.runInContext(core,context,{filename:'native-core.js'});executeNativeApp(context,app);
    const click=get('newSession').listeners.get('click')[0];assert.equal(typeof click,'function');const disabled=get('newSession').disabled;click();
    const archive=JSON.parse(storage.get(HISTORY)||'[]');assert.equal(posts,0);
    results.push({originalStatus:status,buttonDisabled:disabled,confirmations,activeSessionRemoved:!storage.has(KEY),archivedUnresolvedTurnId:archive.at(-1)?.turns.at(-1)?.turnId,archivedStatus:archive.at(-1)?.turns.at(-1)?.status,reloads,modelCalls:0,actualBrowser:false});
  }
  const c={};vm.createContext(c);vm.runInContext(core,c);
  const emptySession={sessionId:'fresh',material:null,turns:[],explanations:[],assessments:[]};
  const batchEnabled=c.LearningCore.canOpenBatch({modelAvailability:{learning:{remaining:0,running:false,sealed:false}}},{goalVersionId:'fixture',artifact:{candidateSha256:'fixture'}},emptySession);
  const report={recordedAt:new Date().toISOString(),candidateSha256:'7203ab596fdc687747f95463bbbd2a0f5415dda2885ab9d5113092349693e2a8',evidenceType:'unchanged compiled-native new-session click handler, controlled DOM/GETs, fault-injected persisted turns and explicit controlled confirm; pure native batch predicate',sourceUnchanged:sha(await fs.readFile('workspace/app.js'))===sha(app)&&sha(await fs.readFile('workspace/core.js'))===sha(core),appSha256:sha(app),coreSha256:sha(core),newSessionCases:results,batchPredicateAllowsEmptySession:batchEnabled,actualOpenBatchApiExecuted:false,modelCalls:0,actualBrowser:false,finding1Confirmed:'Actual new-session handler archives and removes unresolved active turns; no current history-reopen action.',finding2Boundary:'Pure UI predicate permits an empty session. Actual backend requires prior two completed successful calls. Current unconfirmed candidate cannot legally run actual learning/open-batch; not run.',avoidNewArticleDeadlock:'A tighter page gate must still let a newly registered article begin explain/assess after the previous article completed. Requiring a fresh session already to have completed that cycle would deny its first calls.'};
  await fs.writeFile('evidence/development-16-readonly-session-reset-and-batch-counterexamples.json',JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify(report));
} catch(error) { console.error(JSON.stringify({ok:false,error:error.message,modelCalls:0}));process.exitCode=1; }
