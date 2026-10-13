// Read-only operator proof: exact final app must come from this batch's fixed
// live compiler invocation; none of the other five business files may change.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
export async function verifyCurrentCompilerProvenance({root,workspace,batchId,ledgerFile}){
 const cap=JSON.parse(await fs.readFile(path.join(root,'state/model-capability.json'))),ledger=JSON.parse(await fs.readFile(ledgerFile));
 const developer=ledger.calls.find(c=>c.expectedRole==='developer');assert.ok(developer&&developer.status==='completed'&&developer.declaredStatus==='done'&&!developer.signal&&developer.exitCode===0);
 const baseline=JSON.parse(await fs.readFile(path.join(root,'state',batchId,'repair-input-manifest.json')));
 const app=await fs.readFile(path.join(workspace,'app.js')),outputSha256=sha(app),tmp=await fs.realpath('/tmp');
 const prefix='irixi-live-compile-'+batchId+'-',matches=[];
 for(const name of await fs.readdir(tmp)){
  if(!name.startsWith(prefix))continue;const dir=path.join(tmp,name),stat=await fs.lstat(dir);if(!stat.isDirectory()||stat.isSymbolicLink())continue;
  const file=path.join(dir,'provenance.json');let bytes;try{const s=await fs.lstat(file);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>32000)continue;bytes=await fs.readFile(file)}catch(e){if(e.code==='ENOENT')continue;throw e}
  const p=JSON.parse(bytes);if(p.outputSha256!==outputSha256)continue;
  assert.equal(p.batchId,batchId);assert.equal(p.goalVersionId,cap.goalVersionId);assert.equal(p.executionId,cap.development.executionId);
  assert.equal(p.fixedLiveInput,true);assert.equal(p.sourceFile,path.join(workspace,'app.js'));assert.equal(p.temporaryInputSelected,false);assert.equal(p.compilerVersion,'0.27.3');
  assert.equal(p.priorLiveAppSha256,baseline.find(f=>f.path==='app.js').sha256);
  assert.ok(Date.parse(p.startedAt)>=Date.parse(developer.startedAt)&&Date.parse(p.finishedAt)<=Date.parse(developer.completedAt));
  assert.equal(sha(await fs.readFile(path.join(dir,'input-app.js'))),p.inputSha256);assert.equal(sha(await fs.readFile(path.join(dir,'output-app.js'))),outputSha256);
  let sourceBytes=app.length;
  for(const f of baseline.filter(f=>f.path!=='app.js')){const b=await fs.readFile(path.join(workspace,f.path));assert.equal(sha(b),f.sha256,'Unexpected non-app business change: '+f.path);sourceBytes+=b.length}
  assert.equal(sourceBytes,p.completeSourceBytes);assert.ok(sourceBytes<=53248);matches.push({provenanceFile:file,provenanceSha256:sha(bytes),...p});
 }
 assert.ok(matches.length,'No exact final app/compiler proof from this active batch; never accept an old temporary output');
 return {passed:true,sourceUnchanged:true,fixedLiveSource:true,matchingProvenanceRecords:matches.length,proof:matches.at(-1),nativeModelCalls:0,businessFilesChangedByRoot:false};
}
