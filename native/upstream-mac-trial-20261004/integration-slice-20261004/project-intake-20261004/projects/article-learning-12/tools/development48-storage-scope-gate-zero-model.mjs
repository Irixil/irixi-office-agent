import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const p=path.resolve(import.meta.dirname,'..');
const a=process.argv.slice(2);
assert.equal(a.length,4);assert.equal(a[0],'--workspace');assert.equal(a[2],'--evidence');
const workspace=path.resolve(a[1]),output=path.resolve(a[3]);
const frozen=path.join(p,'backend/development-47-exact-native-source-20261007');
const manifest=JSON.parse(fs.readFileSync(path.join(frozen,'manifest.json')));
const sha=v=>crypto.createHash('sha256').update(v).digest('hex');
const candidateFiles=fs.readdirSync(workspace).sort();
assert.deepEqual(candidateFiles,manifest.manifest.map(f=>f.path).sort());
const checks=[];
for(const f of manifest.manifest){
 const current=fs.readFileSync(path.join(workspace,f.path));
 if(f.path!=='achievements.js'){assert.equal(sha(current),f.sha256,f.path+' is readonly');checks.push({id:'readonly-'+f.path,passed:true})}
}
const previous=fs.readFileSync(path.join(frozen,'source/achievements.js'),'utf8');
const current=fs.readFileSync(path.join(workspace,'achievements.js'),'utf8');
const marker='const KEY=';assert.equal(previous.split(marker).length,2);assert.ok(current.includes(marker));
assert.equal(current.slice(0,current.indexOf(marker)),previous.slice(0,previous.indexOf(marker)),'Original pure progress/qualification/reward/merge/business API must remain byte-identical');
checks.push({id:'original-pure-business-api-prefix-byte-identical',passed:true});
const v={at:new Date().toISOString(),passed:true,nativeModelCalls:0,productApiCalls:0,businessSourceEditedByGate:false,actualBrowser:false,inputCandidateVersion:36,lastConfirmedVersion:28,checks,scope:'Readonly file and pure business-rule integrity gate only. Does not prove save/reopen/submit behavior; independent actual-HTML controlled acceptance remains required.'};
fs.writeFileSync(output,JSON.stringify(v,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({result:'STORAGE48_SCOPE_GATE_PASS',passed:true,checks:checks.length,businessFlowAccepted:false,nativeModels:0}));
