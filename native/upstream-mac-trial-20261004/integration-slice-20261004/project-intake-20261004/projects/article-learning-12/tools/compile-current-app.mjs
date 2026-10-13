// Build coordination only: no application logic. --inspect is read-only.
// --compile must be invoked by the separately active native Developer; fixed
// live app.js is the only input. A fresh provenance directory records exact
// input/output; an old temporary file cannot be selected as build input.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const root=path.resolve(import.meta.dirname,'..'),workspace=path.join(root,'workspace');
const sourceFile=path.join(workspace,'app.js'),names=['PRODUCT.md','app.js','core.js','index.html','styles.css','test-core.js'];
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const args=process.argv.slice(2),inspect=args.length===1&&args[0]==='--inspect';
assert.ok(inspect||(args.length===3&&args[0]==='--compile'&&/^development-\d{2,4}$/.test(args[1])&&/^[a-f0-9]{64}$/.test(args[2])),'Use --inspect or --compile development-NN expected-live-app-sha256');
const require=createRequire(import.meta.url),esbuild=require(path.resolve(root,'../../../../sources/OpenOffice/node_modules/.pnpm/esbuild@0.27.3/node_modules/esbuild/lib/main.js'));
assert.equal(esbuild.version,'0.27.3');
const flags={loader:'js',minify:true,keepNames:false,charset:'utf8',sourcefile:'app.js'};
const manifest=async()=>Promise.all(names.map(async name=>{const f=path.join(workspace,name),s=await fs.lstat(f);assert.ok(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1);const b=await fs.readFile(f);return{path:name,bytes:b.length,sha256:sha(b)}}));
const before=await manifest(),source=await fs.readFile(sourceFile),inputSha256=sha(source);
const built=await esbuild.transform(source.toString('utf8'),flags),output=Buffer.from(built.code),outputSha256=sha(output);
const total=before.reduce((n,f)=>n+(f.path==='app.js'?output.length:f.bytes),0);
const report={startedAt:new Date().toISOString(),compilerVersion:esbuild.version,flags,sourceFile,fixedLiveInput:true,inputSha256,inputBytes:source.length,outputSha256,outputBytes:output.length,completeSourceBytes:total,sourceLimitBytes:53248,sourceFits:total<=53248,temporaryInputSelected:false,businessLogicAuthoredByTool:false};
if(inspect){console.log(JSON.stringify({...report,businessFilesWritten:false}));}
else{
 const cap=JSON.parse(await fs.readFile(path.join(root,'state/model-capability.json'))),batchId=args[1];
 assert.equal(cap.development.batchId,batchId);assert.equal(cap.development.enabled,true);assert.equal(cap.learning.enabled,false);assert.equal(inputSha256,args[2],'Live input changed before compiler read');
 const ledger=JSON.parse(await fs.readFile(cap.development.ledgerFile));
 assert.ok(!ledger.sealed&&ledger.calls.length===1&&ledger.calls[0].expectedRole==='developer'&&ledger.calls[0].status==='running','Only the one active native Developer can compile this live candidate');
 const baseline=JSON.parse(await fs.readFile(path.join(root,'state',batchId,'repair-input-manifest.json')));
 for(const f of before.filter(f=>f.path!=='app.js'))assert.equal(f.sha256,baseline.find(x=>x.path===f.path)?.sha256,'One-app repair must preserve '+f.path);
 assert.ok(report.sourceFits,'Hard source bound: complete compiled candidate='+total+' >53248. Preserve all features/files/tests; report blocked instead of dropping code.');
 // Existing canonical function-name assignments are retained by normal
 // esbuild minification. Repeated keepNames would add another metadata layer.
 for(const name of ['registerMaterial','infer','assess','explain','summarize','refreshRuntime','record','recoverTurn','resumeRunning','renderReport','save','restore'])
  assert.ok(built.code.includes(JSON.stringify(name)),'Existing native name metadata missing: '+name);
 const fresh=await fs.mkdtemp('/tmp/irixi-live-compile-'+batchId+'-');
 await fs.writeFile(path.join(fresh,'input-app.js'),source,{flag:'wx',mode:0o600});await fs.writeFile(path.join(fresh,'output-app.js'),output,{flag:'wx',mode:0o600});
 assert.equal(sha(await fs.readFile(sourceFile)),inputSha256,'Live app changed while compiler ran');
 const current=await manifest();assert.deepEqual(current,before,'Candidate changed while compiler ran');
 const temporary=path.join(workspace,'.live-compile-'+crypto.randomUUID()+'.tmp');
 try{await fs.writeFile(temporary,output,{flag:'wx',mode:0o600});await fs.rename(temporary,sourceFile)}finally{await fs.unlink(temporary).catch(()=>{})}
 const after=await manifest();assert.equal(after.find(x=>x.path==='app.js').sha256,outputSha256);
 Object.assign(report,{batchId,executionId:cap.development.executionId,goalVersionId:cap.goalVersionId,priorLiveAppSha256:baseline.find(x=>x.path==='app.js').sha256,unchangedOtherFiles:before.filter(x=>x.path!=='app.js'),finishedAt:new Date().toISOString(),businessFilesWritten:['app.js'],provenanceDirectory:fresh});
 await fs.writeFile(path.join(fresh,'provenance.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify(report));
}
