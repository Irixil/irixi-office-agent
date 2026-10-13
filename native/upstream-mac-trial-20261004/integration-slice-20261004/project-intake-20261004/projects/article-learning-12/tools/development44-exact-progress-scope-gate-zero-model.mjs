#!/usr/bin/env node
// Development44 zero-model gate. Only the complete development42 progress()
// function may replace development43 progress(); every other candidate byte is
// required to remain development43-exact. Each invocation writes a fresh,
// exclusive evidence directory.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run=promisify(execFile),args=process.argv.slice(2),arg=k=>{const i=args.indexOf(k);return i<0?null:args[i+1]};
const workspace=path.resolve(arg('--workspace')||''),mode=arg('--mode'),evidenceDir=path.resolve(arg('--evidence-dir')||'');
if(!workspace||!evidenceDir||!['baseline','selfcheck','candidate'].includes(mode))throw Error('Use --workspace source --mode baseline|selfcheck|candidate --evidence-dir parent-directory');
const project=path.resolve(import.meta.dirname,'..'),source42=path.join(project,'backend/development-42-exact-native-source-20261006/source'),source43=path.join(project,'backend/development-43-exact-native-source-20261006/source');
const files=['PRODUCT.md','achievements.js','app.js','core.js','index.html','p0-repair.js','styles.css','test-core.js'],sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const expectedProgressSha256='b71077ced2101d50e797cd90d6bf6bf0ac170b9721d1cc3fc729023706c5df68',expectedProgressBytes=1136,expectedRestoreSha256='e32088fe7dbf24a4d8d8229ecbe1d2559c74f43033673a6fe78a5b5e888e4a29';
const splitProgress=bytes=>{const start=bytes.indexOf(Buffer.from('function progress(r){')),end=bytes.indexOf(Buffer.from('\nfunction performance(r){'));if(start<0||end<=start)throw Error('progress function boundary not found');return{prefix:bytes.subarray(0,start),progress:bytes.subarray(start,end),suffix:bytes.subarray(end)}};
const restoreBytes=bytes=>{const start=bytes.indexOf(Buffer.from('async function restore(id){')),end=bytes.indexOf(Buffer.from('\npanel.querySelector("#celebrationsEnabled")'),start);if(start<0||end<=start)throw Error('restore function boundary not found');return bytes.subarray(start,end)};
const [achievement42,achievement43]=await Promise.all([fs.readFile(path.join(source42,'achievements.js')),fs.readFile(path.join(source43,'achievements.js'))]),p42=splitProgress(achievement42),p43=splitProgress(achievement43);
if(p42.progress.length!==expectedProgressBytes||sha(p42.progress)!==expectedProgressSha256||sha(restoreBytes(achievement43))!==expectedRestoreSha256)throw Error('frozen source constants no longer match');
const exactAchievement=Buffer.concat([p43.prefix,p42.progress,p43.suffix]);
async function validate(candidateRoot,achievementOverride=null){
  const listed=(await fs.readdir(candidateRoot,{withFileTypes:true})).filter(x=>x.isFile()).map(x=>x.name).sort(),checks={};
  checks.exactEightFiles=JSON.stringify(listed)===JSON.stringify([...files].sort());
  checks.sevenOtherFilesExact=true;const hashes={};for(const file of files.filter(x=>x!=='achievements.js')){const [actual,expected]=await Promise.all([fs.readFile(path.join(candidateRoot,file)),fs.readFile(path.join(source43,file))]);hashes[file]=sha(actual);if(!actual.equals(expected))checks.sevenOtherFilesExact=false}
  const actualAchievement=achievementOverride||await fs.readFile(path.join(candidateRoot,'achievements.js')),parts=splitProgress(actualAchievement);
  checks.nonProgressBytesExact=parts.prefix.equals(p43.prefix)&&parts.suffix.equals(p43.suffix);
  checks.progressExact42=parts.progress.length===expectedProgressBytes&&sha(parts.progress)===expectedProgressSha256;
  checks.restoreExact43=sha(restoreBytes(actualAchievement))===expectedRestoreSha256;
  checks.exactSplicedAchievement=actualAchievement.equals(exactAchievement);hashes['achievements.js']=sha(actualAchievement);
  return{valid:Object.values(checks).every(Boolean),checks,hashes,listed,progress:{bytes:parts.progress.length,sha256:sha(parts.progress)},restore:{bytes:restoreBytes(actualAchievement).length,sha256:sha(restoreBytes(actualAchievement))},achievementSha256:sha(actualAchievement)}
}
await fs.mkdir(evidenceDir,{recursive:true});const runDirectory=await fs.mkdtemp(path.join(evidenceDir,`${mode}-`)),resultFile=path.join(runDirectory,'result.json'),nested43File=path.join(runDirectory,'development43-vm.json');
const report={schemaVersion:1,recordedAt:new Date().toISOString(),mode,result:null,passed:false,workspace,input43CandidateSha256:'bf5718a15e7369b0ac0590c6b3ada237d9bc58f991a72217b692f924a3c63611',nativeModelCalls:0,productApiCalls:0,businessSourceEdited:false,runDirectory,cases:[],requiredReportFields:['mode','result','passed','nativeModelCalls','productApiCalls','runDirectory','scopeValidation','otherByteMutation','nestedDevelopment43Vm','sourceHashes','cases'],requiredCandidateCases:['exact_progress_only_scope_is_valid','other_nonprogress_byte_is_rejected','frozen_development43_vm_gate_passes']};
const check=(id,passed,detail=null)=>report.cases.push({id,passed:Boolean(passed),detail});let temporaryWorkspace=null;
try{
  let target=workspace;if(mode==='selfcheck'){temporaryWorkspace=await fs.mkdtemp(path.join(os.tmpdir(),'development44-selfcheck-'));for(const file of files)await fs.copyFile(path.join(source43,file),path.join(temporaryWorkspace,file));await fs.writeFile(path.join(temporaryWorkspace,'achievements.js'),exactAchievement,{flag:'w'});target=temporaryWorkspace}
  const scope=await validate(target);report.scopeValidation=scope;
  check('exact_progress_only_scope_is_valid',mode==='baseline'?!scope.valid:scope.valid,{expected:mode==='baseline'?false:true,actual:scope.valid,checks:scope.checks,progress:scope.progress,restore:scope.restore,achievementSha256:scope.achievementSha256});
  const otherMutation=Buffer.from(exactAchievement);otherMutation[0]^=1;const invalid=await validate(source43,otherMutation);report.otherByteMutation={rejected:!invalid.valid,checks:invalid.checks,achievementSha256:invalid.achievementSha256};check('other_nonprogress_byte_is_rejected',!invalid.valid&&!invalid.checks.nonProgressBytesExact,{checks:invalid.checks,achievementSha256:invalid.achievementSha256});
  const gate=path.join(project,'tools/development43-historical-material-identity-vm-gate-zero-model.mjs');let childExitCode=0,childStdout='',childStderr='';try{const child=await run(process.execPath,[gate,'--workspace',target,'--mode','candidate','--evidence',nested43File],{timeout:45000,maxBuffer:8*1024*1024});childStdout=child.stdout;childStderr=child.stderr}catch(error){childExitCode=error.code??1;childStdout=error.stdout||'';childStderr=error.stderr||''}
  const nested=JSON.parse(await fs.readFile(nested43File));report.nestedDevelopment43Vm={exitCode:childExitCode,passed:nested.passed,result:nested.result,sha256:sha(await fs.readFile(nested43File)),stdoutTail:childStdout.trim().split('\n').slice(-1),stderrTail:childStderr.trim().split('\n').slice(-2)};check('frozen_development43_vm_gate_passes',childExitCode===0&&nested.passed===true,{exitCode:childExitCode,result:nested.result,reportSha256:report.nestedDevelopment43Vm.sha256});
  report.passed=report.cases.every(x=>x.passed);report.result=report.passed?(mode==='baseline'?'EXPECTED_BASELINE_SCOPE_REJECTION_REPRODUCED':mode==='selfcheck'?'CONTROLLED_NONCANDIDATE_SELFCHECK_PASS':'PASS'):'FAIL';report.finishedAt=new Date().toISOString();report.sourceHashes={tool:sha(await fs.readFile(new URL(import.meta.url))),development43VmGate:sha(await fs.readFile(gate)),development42Achievements:sha(achievement42),development43Achievements:sha(achievement43),expectedProgress:expectedProgressSha256,expectedRestore:expectedRestoreSha256};report.limitations=['Selfcheck assembles candidate bytes only in a temporary directory and is not candidate evidence.','The nested gate uses temporary real-host state plus VM APIs; it does not call a model or live product API.'];
}catch(error){report.result='FAIL';report.error={message:error.message,stack:error.stack}}finally{if(temporaryWorkspace)await fs.rm(temporaryWorkspace,{recursive:true,force:true,maxRetries:4,retryDelay:50}).catch(()=>{})}
await fs.writeFile(resultFile,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({passed:report.passed,result:report.result,mode,runDirectory,resultFile,nested43File,nativeModelCalls:0}));if(!report.passed)process.exitCode=1;
