#!/usr/bin/env node
// Zero-network VM acceptance gate for development42. It executes the actual
// candidate core/repair/achievements/app scripts with a controlled DOM and
// in-memory API. No model, browser, product API, or business write is used.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { executeNativeApp } from './native-client-vm-adapter.mjs';

const args=process.argv.slice(2),arg=k=>{const i=args.indexOf(k);return i<0?null:args[i+1]};
const workspace=path.resolve(arg('--workspace')||''),mode=arg('--mode'),evidence=path.resolve(arg('--evidence')||'');
if(!workspace||!evidence||!['baseline','selfcheck','candidate'].includes(mode))throw Error('Use --workspace source --mode baseline|selfcheck|candidate --evidence new.json');
const project=path.resolve(import.meta.dirname,'..'),KEY='irixi.article-learning-12.session.v1';
const sha=v=>crypto.createHash('sha256').update(v).digest('hex'),pause=ms=>new Promise(r=>setTimeout(r,ms));
const [app0,core,repair,ach0,oldBytes]=await Promise.all([
  fs.readFile(path.join(workspace,'app.js'),'utf8'),fs.readFile(path.join(workspace,'core.js'),'utf8'),
  fs.readFile(path.join(workspace,'p0-repair.js'),'utf8'),fs.readFile(path.join(workspace,'achievements.js'),'utf8'),
  fs.readFile(path.join(project,'backend/learning-08-original-retest-client-failure/actual-local-record.json'))]);
const old=JSON.parse(oldBytes),oldRecordBytes=JSON.stringify(old),oldTurnBytes=new Map(old.turns.map(t=>[t.turnId,JSON.stringify(t)]));
const expectedHash=old.material.articleSha256,report={schemaVersion:1,recordedAt:new Date().toISOString(),mode,
  workspace,nativeModelCalls:0,productApiCalls:0,actualBrowser:false,businessSourceEdited:false,cases:[],limitations:[]};
const check=(id,passed,detail=null)=>report.cases.push({id,passed:Boolean(passed),detail});

const oldCompact='if(["ambiguous","unregistered","invalid"].includes(t.status))return t;';
const scopedCompact='if(t.status==="invalid")return t;';
const oldBe='function be(e,t){return k(e)||e===t||e.status==="invalid"&&(t?.failedTurnId===e.turnId||r.turns.some(y=>y.status==="done"&&y.failedTurnId===e.turnId))}';
const newBe='function be(e,t){return k(e)||e===t||e.status==="invalid"&&(t?.failedTurnId===e.turnId||r.turns.some(y=>y.status==="done"&&y.failedTurnId===e.turnId))||e.status==="stale"&&Array.isArray(r.historicalTurnIds)&&r.historicalTurnIds.includes(e.turnId)&&e.materialEventId!==r.material?.materialEventId}';
const materialAnchor='const sessionId=crypto.randomUUID(),m=await get("/api/irixi-materials",{method:"POST",body:JSON.stringify({sessionId,label:s.material.label,source:s.material.source,articleText:s.material.articleText})}),r=';
const materialGuard='const sessionId=crypto.randomUUID(),m=await get("/api/irixi-materials",{method:"POST",body:JSON.stringify({sessionId,label:s.material.label,source:s.material.source,articleText:s.material.articleText})});if(m.sessionId!==sessionId||m.articleSha256!==s.material.articleSha256)throw Error("重新登记响应与历史正文或新会话身份不一致");const r=';
const restoredObject='r={...s.state.record,sessionId,serverBinding:null,material:';
const qualifiedRestoredObject='r={...s.state.record,historicalTurnIds:(s.state.record.turns||[]).map(t=>t.turnId),sessionId,serverBinding:null,material:';
const compactStart='function compact(r){return{sessionId:r.sessionId,';
const qualifiedCompact='function compact(r){return{sessionId:r.sessionId,historicalTurnIds:r.historicalTurnIds||[],';
let app=app0,ach=ach0;
if(mode==='selfcheck'){
  assert.ok(app.includes(oldBe)&&ach.includes(materialAnchor)&&ach.includes(oldCompact)&&ach.includes(restoredObject)&&ach.includes(compactStart));
  app=app.replace(oldBe,newBe).replaceAll('r.turns.every(k)','r.turns.every(e=>be(e,null))');
  ach=ach.replace(materialAnchor,materialGuard).replace(restoredObject,qualifiedRestoredObject).replace(compactStart,qualifiedCompact).replace(oldCompact,scopedCompact);
}

function world({materialMismatch=false,initialStorage=null}={}){
  const elements=new Map(),storage=new Map();if(initialStorage)storage.set(KEY,initialStorage);
  function node(name='node'){
    let html='';const out={name,value:'',checked:false,disabled:false,hidden:false,readOnly:false,textContent:'',style:{},dataset:{},listeners:new Map(),children:[],
      classList:{toggle(){},add(){},remove(){}},addEventListener(t,f){const r=this.listeners.get(t)||[];r.push(f);this.listeners.set(t,r)},
      append(...v){this.children.push(...v)},before(){},reset(){},querySelector(sel){return get(sel)},
      querySelectorAll(sel){if(sel==='button'&&html.includes('data-id=')){if(!this._buttons){const ids=[...html.matchAll(/data-id="([^"]+)"/g)].map(m=>m[1]);this._buttons=ids.map(id=>{const b=node('server-session');b.dataset.id=id;return b})}return this._buttons}return[]},
      async click(){if(typeof this.onclick==='function')await this.onclick({preventDefault(){},target:this});for(const f of this.listeners.get('click')||[])await f({preventDefault(){},target:this})}};
    Object.defineProperty(out,'innerHTML',{get:()=>html,set:v=>{html=String(v)}});return out;
  }
  function get(sel){const key=String(sel).replace(/^#/,'');if(!elements.has(key))elements.set(key,node(key));return elements.get(key)}
  const stats={requests:[],materialPosts:0,inferencePosts:0,reloads:0,statePuts:[]},ids=[];let materialOrdinal=0,revision=0;
  class Storage{getItem(k){return storage.get(k)??null}setItem(k,v){JSON.parse(v);storage.set(k,v)}removeItem(k){storage.delete(k)}}
  const reply=(status,v)=>Promise.resolve(new Response(JSON.stringify(v),{status,headers:{'Content-Type':'application/json'}}));
  const fetch=async(input,init={})=>{const u=new URL(String(input),'http://controlled.invalid'),method=init.method||'GET',body=init.body?JSON.parse(init.body):null;stats.requests.push({method,path:u.pathname,search:u.search,body});
    if(u.pathname==='/api/irixi-authority')return reply(200,{goalVersionId:'goal-current',artifact:{candidateSha256:'candidate-current'}});
    if(u.pathname==='/api/irixi-intake')return reply(200,{modelAvailability:{learning:{enabled:false,sealed:true,running:false,remaining:0,deadlineAt:null}}});
    if(u.pathname==='/api/irixi-client-state'&&u.searchParams.get('scope')==='project')return reply(200,{scope:'project',items:[{sessionId:old.sessionId,label:old.material.label,current:false,historical:true}],totalSessions:1,truncated:false});
    if(u.pathname==='/api/irixi-client-state'&&u.searchParams.get('historical')==='true')return reply(200,{readMode:'history',readOnly:true,current:false,historical:true,state:{record:structuredClone(old),cumulative:{}},material:structuredClone(old.material),materialEventId:old.material.materialEventId,goalVersionId:'old-goal',candidateSha256:'old-candidate'});
    if(u.pathname==='/api/irixi-materials'&&method==='POST'){stats.materialPosts++;materialOrdinal++;ids.push(body.sessionId);return reply(200,{sessionId:body.sessionId,materialEventId:`new-event-${materialOrdinal}`,articleSha256:materialMismatch?'f'.repeat(64):expectedHash,label:body.label,source:body.source,articleText:body.articleText})}
    if(u.pathname==='/api/irixi-client-state'&&method==='GET')return reply(200,{revision,state:{schemaVersion:3,record:initialStorage?JSON.parse(storage.get(KEY)):null,cumulative:{}},goalVersionId:'goal-current',candidateSha256:'candidate-current',materialEventId:JSON.parse(storage.get(KEY)||'null')?.material?.materialEventId||null,material:JSON.parse(storage.get(KEY)||'null')?.material||null});
    if(u.pathname==='/api/irixi-client-state'&&method==='PUT'){stats.statePuts.push(structuredClone(body));revision++;return reply(200,{revision,stateSha256:'controlled',goalVersionId:'goal-current',candidateSha256:'candidate-current',materialEventId:body.expectedMaterialEventId})}
    if(u.pathname==='/api/irixi-inference'){stats.inferencePosts++;throw Error('controlled VM forbids inference')}
    throw Error(`unhandled controlled API ${method} ${u.pathname}${u.search}`)};
  const document={hidden:false,body:node('body'),getElementById:get,querySelector:get,querySelectorAll(){return[]},createElement:t=>node(t),addEventListener(){},dispatchEvent(){return true}};
  const context=vm.createContext({console,crypto:crypto.webcrypto,structuredClone,TextEncoder,Storage,localStorage:new Storage(),document,fetch,Response,URL,
    CustomEvent:class{constructor(type,detail){this.type=type;this.detail=detail}},MutationObserver:class{observe(){}disconnect(){}},confirm:()=>true,
    location:{reload(){stats.reloads++}},setTimeout:(fn,ms,...a)=>setTimeout(fn,Math.min(ms,2),...a),clearTimeout});
  vm.runInContext(core,context,{filename:'candidate-core.js'});vm.runInContext(repair,context,{filename:'candidate-repair.js'});vm.runInContext(ach,context,{filename:'candidate-achievements.js'});
  return{context,storage,stats,ids,get,runApp(){executeNativeApp(context,app,'candidate-app.js')},read(){return JSON.parse(storage.get(KEY)||'null')}};
}

async function restoreOnce(options={}){const w=world(options);await pause(25);const sessions=w.get('#serverSessions').querySelectorAll('button');assert.equal(sessions.length,1,'historical server row');await sessions[0].onclick();await pause(15);return w}

const first=await restoreOnce(),firstRecord=first.read();
const originalStillExact=JSON.stringify(old)===oldRecordBytes&&old.turns.every(t=>JSON.stringify(t)===oldTurnBytes.get(t.turnId));
function objects(value,out=[]){if(!value||typeof value!=='object')return out;out.push(value);for(const child of Object.values(value))objects(child,out);return out}
const restoredObjects=objects(firstRecord),requestFactsExact=old.turns.every(t=>restoredObjects.some(row=>row.turnId===t.turnId&&JSON.stringify(row.requestBody??null)===JSON.stringify(t.requestBody??null)));
const restoredBytes=JSON.stringify(firstRecord),learningFactsPresent=['explanations','assessments','opinions','summaries'].every(key=>JSON.stringify(old[key]||[])==='[]'||restoredBytes.includes(JSON.stringify(old[key])));
check('historical_original_and_request_facts_remain_byte_exact',originalStillExact&&requestFactsExact&&learningFactsPresent,{originalStillExact,requestFactsExact,learningFactsPresent});
check('reregister_creates_new_session_and_current_material_binding',Boolean(firstRecord&&firstRecord.sessionId!==old.sessionId&&firstRecord.material?.articleSha256===expectedHash&&firstRecord.material?.materialEventId!==old.material.materialEventId),{oldSessionId:old.sessionId,newSessionId:firstRecord?.sessionId,oldMaterialEventId:old.material.materialEventId,newMaterialEventId:firstRecord?.material?.materialEventId});

const refreshed=world({initialStorage:JSON.stringify(firstRecord)});refreshed.runApp();await pause(35);
const casSaved=refreshed.stats.statePuts.some(row=>row.state?.record?.sessionId===firstRecord.sessionId&&row.expectedMaterialEventId===firstRecord.material.materialEventId);
refreshed.context.confirm=()=>true;await refreshed.get('#newSession').click();
const archived=JSON.parse(refreshed.storage.get('irixi.article-learning-12.history.v1')||'[]'),currentAfterAction=refreshed.read();
const actualNextEffect=archived.some(row=>row.sessionId===firstRecord.sessionId)&&currentAfterAction===null;
check(mode==='baseline'?'candidate31_historical_deadlock_reproduced':'restored_current_context_is_cas_saved_and_actual_next_action_persists',mode==='baseline'?!actualNextEffect:casSaved&&actualNextEffect,{casSaved,actualNextEffect,archivedSessions:archived.map(x=>x.sessionId),currentPresent:Boolean(currentAfterAction),assessDisabled:refreshed.get('#assessBtn').disabled,notice:refreshed.get('#notice').textContent,recoveryText:refreshed.get('#recoveryText').textContent});

const unqualified={sessionId:firstRecord.sessionId,material:structuredClone(firstRecord.material),position:old.position,explanations:structuredClone(old.explanations),assessments:structuredClone(old.assessments),opinions:structuredClone(old.opinions),summaries:structuredClone(old.summaries),turns:old.turns.map(t=>({...structuredClone(t),status:'stale'})),draft:structuredClone(old.draft)};
const unqualifiedWorld=world({initialStorage:JSON.stringify(unqualified)});unqualifiedWorld.runApp();await pause(25);unqualifiedWorld.context.__confirmed=false;unqualifiedWorld.context.confirm=()=>{unqualifiedWorld.context.__confirmed=true;return true};await unqualifiedWorld.get('#newSession').click();
const currentUnresolved=structuredClone(unqualified);currentUnresolved.turns[0].status='running';currentUnresolved.turns[0].materialEventId=currentUnresolved.material.materialEventId;
const currentWorld=world({initialStorage:JSON.stringify(currentUnresolved)});currentWorld.runApp();await pause(25);currentWorld.context.__confirmed=false;currentWorld.context.confirm=()=>{currentWorld.context.__confirmed=true;return true};await currentWorld.get('#newSession').click();
check('unqualified_stale_and_current_unresolved_turns_remain_blocking',!unqualifiedWorld.context.__confirmed&&!currentWorld.context.__confirmed,{unqualifiedConfirm:Boolean(unqualifiedWorld.context.__confirmed),currentConfirm:Boolean(currentWorld.context.__confirmed),unqualifiedNotice:unqualifiedWorld.get('#notice').textContent,currentNotice:currentWorld.get('#notice').textContent});

const second=await restoreOnce(),secondRecord=second.read();
check('repeat_same_article_restore_uses_distinct_session_and_no_inference',Boolean(secondRecord&&firstRecord&&secondRecord.sessionId!==firstRecord.sessionId&&secondRecord.material.articleSha256===firstRecord.material.articleSha256&&first.stats.inferencePosts===0&&second.stats.inferencePosts===0),{firstSessionId:firstRecord?.sessionId,secondSessionId:secondRecord?.sessionId,firstInference:first.stats.inferencePosts,secondInference:second.stats.inferencePosts});

const mismatch=await restoreOnce({materialMismatch:true}),mismatchRecord=mismatch.read();
check(mode==='baseline'?'candidate31_cross_article_wrong_binding_is_accepted':'cross_article_reregister_response_is_rejected_without_local_current',mode==='baseline'?Boolean(mismatchRecord):!mismatchRecord,{localRecordPresent:Boolean(mismatchRecord),reloads:mismatch.stats.reloads,status:mismatch.get('#achievementStatus').textContent});

const keepsOutOfScope=/\["ambiguous","unregistered","invalid"\]\.includes\(t\.status\)/.test(ach0),scoped=/if\(t\.status==="invalid"\)return t/.test(ach);
check(mode==='baseline'?'candidate31_out_of_scope_compact_change_is_present':'compact_scope_is_rolled_back_to_invalid_only',mode==='baseline'?keepsOutOfScope:scoped,{keepsOutOfScope,scoped});

report.passed=report.cases.every(x=>x.passed);report.finishedAt=new Date().toISOString();report.sourceHashes={app:sha(app0),core:sha(core),repair:sha(repair),achievements:sha(ach0),actualRecord:sha(oldBytes)};
report.limitations.push('All HTTP and persistence are in-memory fixtures; no product service or model was called.');
report.limitations.push('Selfcheck modifies only served source strings in memory and is not candidate evidence.');
await fs.writeFile(evidence,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({passed:report.passed,mode,cases:report.cases,evidence,nativeModelCalls:0}));
if(!report.passed)process.exitCode=1;
