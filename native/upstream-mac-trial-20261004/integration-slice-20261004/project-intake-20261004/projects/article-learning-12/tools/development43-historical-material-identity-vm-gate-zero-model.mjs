#!/usr/bin/env node
// Development43 zero-network gate. It combines the frozen development42
// same-article regression with an actual temporary TaskStore response whose
// record is article A while its complete returned material is article B.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { createActualHostMaterialMismatchFixture } from './development43-actual-host-material-fixture-zero-model.mjs';

const run=promisify(execFile),args=process.argv.slice(2),arg=k=>{const i=args.indexOf(k);return i<0?null:args[i+1]};
const workspace=path.resolve(arg('--workspace')||''),mode=arg('--mode'),evidence=path.resolve(arg('--evidence')||'');
if(!workspace||!evidence||!['baseline','selfcheck','candidate'].includes(mode))throw Error('Use --workspace source --mode baseline|selfcheck|candidate --evidence new.json');
const project=path.resolve(import.meta.dirname,'..'),sha=v=>crypto.createHash('sha256').update(v).digest('hex'),pause=ms=>new Promise(r=>setTimeout(r,ms));
const baseGate=path.join(project,'tools/development42-historical-reregister-vm-gate-zero-model.mjs'),tmp=await fs.mkdtemp(path.join(os.tmpdir(),'development43-vm-')),baseEvidence=path.join(tmp,'development42.json');
const report={schemaVersion:1,recordedAt:new Date().toISOString(),mode,workspace,result:null,nativeModelCalls:0,productApiCalls:0,actualBrowser:false,businessSourceEdited:false,cases:[],limitations:[]};
const check=(id,passed,detail=null)=>report.cases.push({id,passed:Boolean(passed),detail});
let fixture;
try{
  await run(process.execPath,[baseGate,'--workspace',workspace,'--mode','candidate','--evidence',baseEvidence],{timeout:30000,maxBuffer:8*1024*1024});
  const base=JSON.parse(await fs.readFile(baseEvidence,'utf8'));
  check('frozen_development42_same_article_suite_passes',base.passed===true,{reportSha256:sha(await fs.readFile(baseEvidence)),caseCount:base.cases.length});

  fixture=await createActualHostMaterialMismatchFixture({projectRoot:project});
  const {response,oldRecord,proof}=fixture,responseBefore=JSON.stringify(response),oldBefore=JSON.stringify(oldRecord);
  check('actual_temporary_host_constructs_complete_A_record_B_material_shape',proof.responseRecordSha256===proof.oldRecordSha256&&proof.returnedCanonicalArticleSha256===proof.returnedDeclaredArticleSha256&&proof.returnedDeclaredArticleSha256===proof.registeredArticleSha256&&proof.returnedTopLevelMaterialEventId===proof.registeredMaterialEventId&&!proof.returnedMaterialHasMaterialEventId&&proof.requestedHistoricalSessionId===oldRecord.sessionId,{proof});

  const [coreSource,achievementSource0]=await Promise.all([fs.readFile(path.join(workspace,'core.js'),'utf8'),fs.readFile(path.join(workspace,'achievements.js'),'utf8')]);
  const anchor='const sessionId=crypto.randomUUID(),m=await get("/api/irixi-materials"';
  const guard='const materialTextSha256=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(core.normalizeText(s.material.articleText))))).map(x=>x.toString(16).padStart(2,"0")).join("");if(s.state.record.sessionId!==id||s.state.record.material?.articleSha256!==s.material.articleSha256||s.state.record.material?.materialEventId!==s.materialEventId||materialTextSha256!==s.material.articleSha256)throw Error("历史记录与完整正文身份不一致");const sessionId=crypto.randomUUID(),m=await get("/api/irixi-materials"';
  let achievementSource=achievementSource0;if(mode==='selfcheck'){assert.ok(achievementSource.includes(anchor));achievementSource=achievementSource.replace(anchor,guard)}
  const KEY='irixi.article-learning-12.session.v1',current={schemaVersion:3,sessionId:'current-sentinel-session',material:{materialEventId:'current-sentinel-material',articleSha256:'c'.repeat(64),articleText:'当前状态不得被替换。\n'},turns:[],requestLog:[{kind:'old-request',bytes:'unchanged'}]},currentBytes=JSON.stringify(current),storage=new Map([[KEY,currentBytes]]),elements=new Map();
  function node(name='node'){let html='';const out={name,value:'',checked:false,disabled:false,hidden:false,textContent:'',style:{},dataset:{},listeners:new Map(),children:[],classList:{toggle(){},add(){},remove(){}},addEventListener(t,f){const a=this.listeners.get(t)||[];a.push(f);this.listeners.set(t,a)},append(...x){this.children.push(...x)},before(){},reset(){},querySelector:s=>get(s),querySelectorAll(sel){if(sel==='button'&&html.includes('data-id=')){if(!this._buttons)this._buttons=[...html.matchAll(/data-id="([^"]+)"/g)].map(m=>{const b=node('history-button');b.dataset.id=m[1];return b});return this._buttons}return[]},async click(){if(typeof this.onclick==='function')await this.onclick({preventDefault(){},target:this});for(const f of this.listeners.get('click')||[])await f({preventDefault(){},target:this})}};Object.defineProperty(out,'innerHTML',{get:()=>html,set:v=>{html=String(v)}});return out}
  function get(sel){const k=String(sel).replace(/^#/,'');if(!elements.has(k))elements.set(k,node(k));return elements.get(k)}
  const stats={materialPosts:0,statePuts:0,inferencePosts:0,reloads:0,requests:[]};
  class Storage{getItem(k){return storage.get(k)??null}setItem(k,v){JSON.parse(v);storage.set(k,v)}removeItem(k){storage.delete(k)}}
  const reply=(status,value)=>Promise.resolve(new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}}));
  const fetch=async(input,init={})=>{const u=new URL(String(input),'http://controlled.invalid'),method=init.method||'GET',body=init.body?JSON.parse(init.body):null;stats.requests.push({method,path:u.pathname,search:u.search});
    if(u.pathname==='/api/irixi-authority')return reply(200,{goalVersionId:proof.goalVersionId,artifact:{candidateSha256:proof.candidateSha256}});
    if(u.pathname==='/api/irixi-intake')return reply(200,{modelAvailability:{learning:{enabled:false,sealed:true,running:false,remaining:0}}});
    if(u.pathname==='/api/irixi-client-state'&&u.searchParams.get('scope')==='project')return reply(200,{scope:'project',items:[{sessionId:proof.requestedHistoricalSessionId,label:'历史 A',current:false,historical:true}],totalSessions:1,truncated:false});
    if(u.pathname==='/api/irixi-client-state'&&u.searchParams.get('historical')==='true')return reply(200,structuredClone(response));
    if(u.pathname==='/api/irixi-materials'&&method==='POST'){stats.materialPosts++;return reply(200,{sessionId:body.sessionId,materialEventId:'unexpected-new-material',articleSha256:proof.returnedDeclaredArticleSha256,label:body.label,source:body.source,articleText:body.articleText})}
    if(u.pathname==='/api/irixi-client-state'&&method==='PUT'){stats.statePuts++;return reply(200,{revision:1})}
    if(u.pathname==='/api/irixi-inference'){stats.inferencePosts++;return reply(500,{error:'forbidden'})}
    if(u.pathname==='/api/irixi-client-state')return reply(404,{error:'no controlled current'});
    throw Error(`unhandled ${method} ${u.pathname}${u.search}`)};
  const document={hidden:false,body:node('body'),getElementById:get,querySelector:get,querySelectorAll(){return[]},createElement:t=>node(t),addEventListener(){},dispatchEvent(){return true}};
  const context=vm.createContext({console,crypto:crypto.webcrypto,structuredClone,TextEncoder,Storage,localStorage:new Storage(),document,fetch,Response,URL,CustomEvent:class{constructor(type,detail){this.type=type;this.detail=detail}},MutationObserver:class{observe(){}disconnect(){}},confirm:()=>true,location:{reload(){stats.reloads++}},setTimeout:(fn,ms,...a)=>setTimeout(fn,Math.min(ms,2),...a),clearTimeout});
  vm.runInContext(coreSource,context,{filename:'candidate-core.js'});vm.runInContext(achievementSource,context,{filename:'candidate-achievements.js'});await pause(25);
  const buttons=get('#serverSessions').querySelectorAll('button');assert.equal(buttons.length,1);await buttons[0].click();await pause(20);
  const currentAfter=storage.get(KEY),responseAfter=JSON.stringify(response),oldAfter=JSON.stringify(oldRecord),accepted=currentAfter!==currentBytes;
  const beforeSideEffects=stats.materialPosts===0&&stats.statePuts===0&&stats.inferencePosts===0;
  const bytesExact=currentAfter===currentBytes&&responseAfter===responseBefore&&oldAfter===oldBefore;
  if(mode==='baseline')check('candidate42_accepts_complete_A_record_B_material_expected_negative',accepted&&stats.materialPosts===1,{accepted,stats,status:get('#achievementStatus').textContent});
  else check('complete_A_record_B_material_rejected_before_any_side_effect',!accepted&&beforeSideEffects&&bytesExact,{accepted,beforeSideEffects,bytesExact,stats,status:get('#achievementStatus').textContent});
  check('source_and_fixture_inputs_remain_byte_exact',responseAfter===responseBefore&&oldAfter===oldBefore,{responseSha256Before:sha(responseBefore),responseSha256After:sha(responseAfter),oldRecordSha256Before:sha(oldBefore),oldRecordSha256After:sha(oldAfter)});
  report.passed=report.cases.every(x=>x.passed);report.result=report.passed?(mode==='baseline'?'EXPECTED_BASELINE_FAILURE_REPRODUCED':mode==='selfcheck'?'CONTROLLED_NONCANDIDATE_SELFCHECK_PASS':'PASS'):'FAIL';report.finishedAt=new Date().toISOString();report.sourceHashes={tool:sha(await fs.readFile(new URL(import.meta.url))),hostFixture:sha(await fs.readFile(new URL('./development43-actual-host-material-fixture-zero-model.mjs',import.meta.url))),frozen42Gate:sha(await fs.readFile(baseGate)),app:sha(await fs.readFile(path.join(workspace,'app.js'))),achievements:sha(await fs.readFile(path.join(workspace,'achievements.js')))};
  report.actualHostProof=proof;report.requiredReportFields=['mode','result','passed','nativeModelCalls','productApiCalls','actualHostProof','cases','sourceHashes'];report.requiredCases=['frozen_development42_same_article_suite_passes','actual_temporary_host_constructs_complete_A_record_B_material_shape',mode==='baseline'?'candidate42_accepts_complete_A_record_B_material_expected_negative':'complete_A_record_B_material_rejected_before_any_side_effect','source_and_fixture_inputs_remain_byte_exact'];
  report.limitations.push('The temporary TaskStore uses the real registerMaterial/saveClientState/clientState functions but never writes live product state.');report.limitations.push('Selfcheck changes served achievements.js bytes only in VM memory and is not candidate evidence.');
}catch(error){report.passed=false;report.result='FAIL';report.error={message:error.message,stack:error.stack}}finally{await fixture?.close().catch(()=>{});await fs.rm(tmp,{recursive:true,force:true,maxRetries:4,retryDelay:50}).catch(()=>{})}
await fs.writeFile(evidence,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({passed:report.passed,result:report.result,mode,cases:report.cases,evidence,nativeModelCalls:0}));if(!report.passed)process.exitCode=1;
