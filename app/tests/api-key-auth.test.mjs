import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCodexRole } from '../codex-role-adapter.mjs';
import { codexExecArgs } from '../providers.mjs';

const SYNTHETIC = 'sk-synthetic-test-only-do-not-use';
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-api-key-auth-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const script = path.join(root, 'fake-codex.mjs'), capture = path.join(root, 'capture.json');
  await fs.writeFile(script, `#!${process.execPath}\nimport fs from 'node:fs';\nconst args=process.argv.slice(2), get=k=>args[args.indexOf(k)+1];\nlet prompt=''; for await(const chunk of process.stdin) prompt+=chunk;\nfs.writeFileSync(${JSON.stringify(capture)},JSON.stringify({keyMatches:process.env.CODEX_API_KEY===${JSON.stringify(SYNTHETIC)},otherKey:!!process.env.OPENAI_API_KEY,home:process.env.CODEX_HOME,args,hasSecret:JSON.stringify(args).includes(${JSON.stringify(SYNTHETIC)})||prompt.includes(${JSON.stringify(SYNTHETIC)})}));\nif(prompt.includes('SIMULATE_AUTH_FAILURE')) { process.stdout.write(JSON.stringify({type:'turn.failed',error:{code:'authentication_error',message:'Bearer '+process.env.CODEX_API_KEY}})+'\\n');process.exit(1); }\nfs.writeFileSync(get('-o'),JSON.stringify({content:[{type:'text',text:'synthetic response'}]}));\nfor(const type of ['turn.started','turn.completed']) process.stdout.write(JSON.stringify({type})+'\\n');\n`,{mode:0o700});
  await fs.mkdir(path.join(root,'global-codex'));
  await fs.writeFile(path.join(root,'global-codex','auth.json'),'{"synthetic":"global marker remains unchanged"}');
  const records=[];
  const binding={taskId:'task-test',goalVersionId:'goal-test',executionId:'execution-test',registrySha256:'a'.repeat(64),workItemId:'work-test',continuationPolicy:'task_scoped_no_aggregate_v1',continuationRequestId:'request-test'};
  const input={role:'Chat',binding,idempotencyKey:'key-auth-'+path.basename(root),deadlineAt:null,prompt:'Return a short synthetic response',schemaPath:path.join(root,'unused.json'),runRoot:path.join(root,'calls'),executable:script,realUserHome:path.join(root,'real-home'),env:{PATH:process.env.PATH,HOME:path.join(root,'fake-home'),CODEX_HOME:path.join(root,'global-codex'),OPENAI_API_KEY:'ambient-must-not-inherit',CODEX_API_KEY:'ambient-must-not-inherit'},executionMode:'provider-decision',providerTools:[],requiredProviderTools:[],taskScopedContinuation:true,connectionId:'openai-api-key',connectionRevision:'rev-1',credentialReader:async()=>({key:SYNTHETIC,revision:'rev-1'}),reserve:async x=>{const rec={...x,id:'reservation-test',created:true,callOrdinal:1};records.push(rec);return rec;},recordTurnStarted:async()=>{},settle:async(r,result)=>{r.result=result;},acceptResult:async()=>true};
  return {root,capture,input,records};
}
test('API auth reaches only selected CLI environment; explicit home and memory-only flags; evidence has no key',async t=>{
  const f=await fixture(t), result=await runCodexRole(f.input);
  assert.equal(result.status,'model_returned');
  const c=JSON.parse(await fs.readFile(f.capture,'utf8'));
  assert.equal(c.keyMatches,true);assert.equal(c.otherKey,false);assert.equal(c.hasSecret,false);
  assert.equal(c.home,path.join(f.input.runRoot,'codex-home'));
  const rawOutputPath=c.args[c.args.indexOf('-o')+1];assert.notEqual(rawOutputPath,result.outputPath);await assert.rejects(fs.access(rawOutputPath));
  assert.equal(await fs.readFile(path.join(f.input.env.CODEX_HOME,'auth.json'),'utf8'),'{"synthetic":"global marker remains unchanged"}');
  assert.ok(c.args.includes('cli_auth_credentials_store="ephemeral"'));assert.ok(c.args.includes('forced_login_method="api"'));
  assert.equal(f.records[0].connectionId,'openai-api-key');assert.equal(f.records[0].connectionRevision,'rev-1');
  assert.ok(!JSON.stringify(f.records).includes(SYNTHETIC));
  assert.deepEqual(await fs.readdir(c.home),[]);assert.equal(f.input.env.CODEX_API_KEY,'ambient-must-not-inherit');
});
test('missing or changed credential fails before spawn and never retries with Desktop credentials',async t=>{
  for(const credentialReader of [async()=>null,async()=>({key:SYNTHETIC,revision:'rev-2'}),async()=>{throw new Error('Keychain denied');}]){
    const f=await fixture(t),result=await runCodexRole({...f.input,credentialReader});
    assert.equal(result.status,'adapter_failed');assert.equal(result.cliSpawned,false);assert.equal(f.records.length,1);
    await assert.rejects(fs.access(f.capture));assert.ok(!JSON.stringify(f.records).includes(SYNTHETIC));
  }
});
test('each decision rechecks revision instead of keeping a stale in-memory credential',async t=>{
  const f=await fixture(t);let revision='rev-1',reads=0;
  const input={...f.input,credentialReader:async()=>{reads++;return {key:SYNTHETIC,revision};}};
  assert.equal((await runCodexRole(input)).status,'model_returned');
  revision='rev-2';await fs.rm(f.capture);
  const result=await runCodexRole({...input,idempotencyKey:input.idempotencyKey+'-2',runRoot:path.join(f.root,'calls-2')});
  assert.equal(result.cliSpawned,false);assert.equal(reads,2);await assert.rejects(fs.access(f.capture));
});
test('unselected legacy connection preserves its old home and never receives ambient API keys',async t=>{
  const f=await fixture(t);let reads=0;
  const result=await runCodexRole({...f.input,connectionId:null,connectionRevision:null,credentialReader:async()=>{reads++;throw new Error('must not read');}});
  assert.equal(result.status,'model_returned');assert.equal(reads,0);
  const c=JSON.parse(await fs.readFile(f.capture,'utf8'));
  assert.equal(c.home,f.input.env.CODEX_HOME);assert.equal(c.keyMatches,false);assert.equal(c.otherKey,false);
  assert.ok(!c.args.includes('forced_login_method="api"'));
});
test('API route refuses unsupported connection and direct execution',async()=>{
  await assert.rejects(runCodexRole({role:'Chat',connectionId:'deepseek'}),/未回退/);
  await assert.rejects(runCodexRole({connectionId:'openai-api-key',connectionRevision:'rev-1',role:'Chat',executionMode:'direct'}),/OmO/);
  const args=codexExecArgs('schema','out','run',{apiKeyAuth:true});assert.ok(args.includes('cli_auth_credentials_store="ephemeral"'));
});

test('CLI authentication failure stays failed, redacts the key and does not try another credential',async t=>{
 const f=await fixture(t);let reads=0;
 const result=await runCodexRole({...f.input,prompt:'SIMULATE_AUTH_FAILURE',credentialReader:async()=>{reads++;return {key:SYNTHETIC,revision:'rev-1'};}});
 assert.equal(result.status,'cli_failed');assert.equal(reads,1);assert.equal(f.records.length,1);assert.equal(result.cliSpawned,true);assert.ok(!JSON.stringify(f.records).includes(SYNTHETIC));
});

test('separate test/production run roots never share API CLI caches',async t=>{
 const f=await fixture(t),homes=[];
 for(const suffix of ['isolated-calls','formal-calls']){
  const result=await runCodexRole({...f.input,idempotencyKey:f.input.idempotencyKey+suffix,runRoot:path.join(f.root,suffix)});
  assert.equal(result.status,'model_returned');homes.push(JSON.parse(await fs.readFile(f.capture,'utf8')).home);
 }
 assert.notEqual(homes[0],homes[1]);assert.equal(homes[0],path.join(f.root,'isolated-calls/codex-home'));assert.equal(homes[1],path.join(f.root,'formal-calls/codex-home'));
 for(const home of homes)assert.deepEqual(await fs.readdir(home),[]);
 assert.equal(await fs.readFile(path.join(f.input.env.CODEX_HOME,'auth.json'),'utf8'),'{"synthetic":"global marker remains unchanged"}');
});


test('exact selected credential is removed from errors, outputs and persisted CLI responses regardless of prefix', async t => {
  for (const scenario of ['event', 'stderr', 'success', 'host-error']) {
    const f = await fixture(t);
    const credential = scenario === 'success' ? 'irixi_test_"quoted\\value_20261030' : 'irixi_synthetic_invalid_credential_20261030';
    await fs.writeFile(f.input.executable, `#!${process.execPath}
import fs from 'node:fs';
const args=process.argv.slice(2), key=process.env.CODEX_API_KEY;
for await(const chunk of process.stdin) {}
fs.writeFileSync(args[args.indexOf('-o')+1],JSON.stringify({content:[{type:'text',text:'response '+key}]}));
const scenario=${JSON.stringify(scenario)};
if(scenario==='event'){process.stdout.write(JSON.stringify({type:'turn.failed',error:{code:'invalid_api_key',message:'Incorrect API key provided: '+key}})+'\\n');process.exit(1);}
if(scenario==='stderr'){process.stderr.write('Incorrect API key provided: '+key);process.exit(1);}
for(const type of ['turn.started','turn.completed'])process.stdout.write(JSON.stringify({type})+'\\n');
`);
    const accepted=[];
    const result=await runCodexRole({...f.input,credentialReader:async()=>({key:credential,revision:'rev-1'}),acceptResult:async output=>{accepted.push(output);if(scenario==='host-error')throw new Error('host callback echoed '+credential);return true;}});
    assert.equal(result.status, scenario==='success' ? 'model_returned' : scenario==='host-error' ? 'adapter_failed' : 'cli_failed');
    for(const value of [result,f.records,accepted])assert.ok(!JSON.stringify(value).includes(credential) && !JSON.stringify(value).includes(JSON.stringify(credential).slice(1,-1)),scenario+' leaked current credential');
    const files=await fs.readdir(f.input.runRoot,{recursive:true});
    for(const relative of files){const filename=path.join(f.input.runRoot,relative);if(!(await fs.stat(filename)).isFile())continue;const text=await fs.readFile(filename,'utf8');assert.ok(!text.includes(credential) && !text.includes(JSON.stringify(credential).slice(1,-1)),scenario+' persisted current credential');}
    assert.match(await fs.readFile(result.outputPath,'utf8'),/凭证已隐藏/);
  }
});
