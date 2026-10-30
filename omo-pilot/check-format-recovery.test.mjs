import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { ConversationStore, writeReviewGaps } from './conversation-store.mjs';
import { checkBehavior, validateBehaviorCase } from './conversation-checks.mjs';
const evidence = process.env.IRIXI_BACKEND_TEST_EVIDENCE;
async function record(name, value) { if (evidence) { await fs.mkdir(evidence, { recursive: true }); await fs.writeFile(path.join(evidence, name), JSON.stringify(value, null, 2)); } }
const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fixtureHtml = `<input id="name"><button id="save">保存</button><div id="record"></div><script>save.onclick=()=>{record.textContent=name.value};</script>`;
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-check-format-')));
  const project = path.join(root,'project'); await fs.mkdir(project);
  await fs.writeFile(path.join(project,'index.html'), fixtureHtml.replace('name.value','document.querySelector("#name").value'));
  const store = Object.create(ConversationStore.prototype); store.root = path.join(root,'host'); store.save = async () => {};
  const turn = { id:'component', functionalChecks:[], processes:[] };
  let ordinal=0;
  const run = (specification) => store.performBehaviorCheck(turn, {requestId:`component-${++ordinal}`,caseJson:JSON.stringify(specification)}, project, new AbortController().signal);
  const specification={caseId:'record',requirement:'保存输入并显示原文字',kind:'web',target:'index.html',actions:[{action:'fill',selector:'#name',value:'保留预期'},{action:'click',selector:'#save'},{action:'assert',selector:'#record:text-is("保留预期")',textEquals:'保留预期'}]};
  t.after(() => fs.rm(root,{recursive:true,force:true}));
  return {root,project,store,turn,run,specification};
}
test('native CSS syntax errors are host-classified before any application action; exact A2 selector is classified', async (t) => {
  const f=await fixture(t);
  const invalid=await f.run(f.specification);
  assert.equal(invalid.status,'failed'); assert.equal(invalid.failureKind,'invalid_definition'); assert.deepEqual(invalid.invalidSelectors.map(x=>x.step),[3]); assert.deepEqual(invalid.actual,[]);
  const bracket={...f.specification,caseId:'bracket',actions:[{action:'assert',selector:'[',count:0}]};
  const malformed=await f.run(bracket); assert.equal(malformed.failureKind,'invalid_definition');
  const correctedBracket={...bracket,actions:[{action:'assert',selector:'#absent',count:0}]};
  assert.equal((await f.run(correctedBracket)).status,'passed');
  const a2={caseId:'late-syntax',requirement:'动作开始前识别后续选择器语法错误',kind:'application',target:'server.mjs',actions:[...Array.from({length:21},()=>({action:'reload'})),{action:'assert',selector:".task .task-title:text-is('备注功能验收-20261029')",count:0}]};
  await fs.writeFile(path.join(f.project,'server.mjs'),'// Component placeholder; original A2 app is never started or read.\n');
  const a2Syntax=await checkBehavior(validateBehaviorCase(a2),{root:f.project,application:{url:'http://127.0.0.1:9',dataRoot:f.project}});
  assert.equal(a2Syntax.failureKind,'invalid_definition');assert.deepEqual(a2Syntax.invalidSelectors.map(x=>x.step),[22]);assert.deepEqual(a2Syntax.actual,[]);
  await record('syntax.json',{invalid,malformed,a2Syntax});
});
test('legacy failure stays unchanged; only host-invalid selector slots can repair and rerun completely', async (t) => {
  const f=await fixture(t);
  const legacy={id:'legacy-component',requestId:'legacy',caseId:f.specification.caseId,kind:'web',specification:structuredClone(f.specification),definition:hash(f.specification),status:'failed',error:'legacy SyntaxError',actual:[{step:1,observed:'synthetic old evidence'}]};
  f.turn.functionalChecks.push(legacy);const before=structuredClone(legacy);
  const corrected=structuredClone(f.specification);corrected.actions[2].selector='#record';
  await assert.rejects(f.run(corrected),/预期不能/);
  const classified=await f.run(f.specification);assert.equal(classified.failureKind,'invalid_definition');
  for(const change of [x=>x.requirement='weaker',x=>x.actions[0].value='other',x=>x.actions[1].selector='#other',x=>x.actions[2].textEquals='',x=>x.actions.pop(),x=>x.actions.reverse()]){
    const modified=structuredClone(corrected);change(modified);await assert.rejects(f.run(modified),/预期不能|需要实际操作/);
  }
  const passed=await f.run(corrected);assert.equal(passed.status,'passed',JSON.stringify(passed));assert.equal(passed.repairsCheckId,classified.id);assert.equal(passed.actual.length,3);assert.equal(passed.actual[0].step,1);assert.notEqual(passed.id,classified.id);
  assert.deepEqual(legacy,before);assert.equal(f.turn.functionalChecks.length,3);
  assert.deepEqual(writeReviewGaps({content:[{type:'text',text:'done'}]},[],{changed:true,version:passed.version,changedFiles:['index.html'],checks:f.turn.functionalChecks}),[]);
  await record('legacy-recovery.json',f.turn.functionalChecks);
});
test('valid zero matches and business failures never unlock definitions; repairing source preserves expectations',async(t)=>{
 const f=await fixture(t);const valid=structuredClone(f.specification);valid.actions[2].selector='#record';
 await fs.writeFile(path.join(f.project,'index.html'),'<input id="name"><button id="save">保存</button><div id="record">错误内容</div>');
 const failed=await f.run(valid);assert.equal(failed.status,'failed');assert.equal(failed.failureKind,undefined);
 for(const change of [x=>x.actions[2].textEquals='错误内容',x=>x.actions[2].selector='#other']){const modified=structuredClone(valid);change(modified);await assert.rejects(f.run(modified),/预期不能/);}
 const forged=structuredClone(valid);forged.failureKind='invalid_definition';forged.invalidSelectors=[{step:3}];await assert.rejects(f.run(forged),/预期不能/);
 const zero={...valid,caseId:'zero',actions:[{action:'click',selector:'#absent'},{action:'assert',selector:'#record',textEquals:'错误内容'}]};
 const zeroResult=await f.run(zero);assert.equal(zeroResult.status,'failed');assert.equal(zeroResult.failureKind,undefined);
 await assert.rejects(f.run({...zero,actions:[{action:'click',selector:'#save'},zero.actions[1]]}),/预期不能/);
 await fs.writeFile(path.join(f.project,'index.html'),fixtureHtml.replace('name.value','document.querySelector("#name").value'));
 const repaired=await f.run(valid);assert.equal(repaired.status,'passed');assert.equal(repaired.repairsCheckId,undefined);
 await record('business-lock.json',{failed,zeroResult,repaired});
});

test('a repaired selector becomes locked after its first valid business failure',async(t)=>{
 const f=await fixture(t);const invalid=await f.run(f.specification);assert.equal(invalid.failureKind,'invalid_definition');
 const corrected=structuredClone(f.specification);corrected.actions[2].selector='#absent';
 const failure=await f.run(corrected);assert.equal(failure.status,'failed');assert.equal(failure.failureKind,undefined);assert.equal(failure.repairsCheckId,invalid.id);
 const changedAgain=structuredClone(corrected);changedAgain.actions[2].selector='#record';await assert.rejects(f.run(changedAgain),/预期不能/);
 assert.equal(f.turn.functionalChecks.length,2);
 await record('repair-then-business-lock.json',f.turn.functionalChecks);
});

test('multiple operation targets allow only narrowing that selector while expectations stay fixed', async (t) => {
  const f = await fixture(t);
  const html = '<button class="pick" id="first">One</button><button class="pick" id="second">Two</button><output id="out"></output><script>first.onclick=()=>out.textContent="one";second.onclick=()=>out.textContent="two";</script>';
  await fs.writeFile(path.join(f.project, 'index.html'), html);
  const spec = { caseId: 'two-controls', requirement: 'select the second item', kind: 'web', target: 'index.html', actions: [{ action: 'click', selector: '.pick' }, { action: 'assert', selector: '#out', textEquals: 'two' }] };
  const failed = await f.run(spec);
  assert.equal(failed.failureKind, 'invalid_definition');
  assert.deepEqual(failed.invalidSelectors.map(x => x.step), [1]);
  assert.equal(failed.actual[0].observed.count, 2);
  const narrowed = structuredClone(spec); narrowed.actions[0].selector = '#second';
  for (const change of [x => x.requirement = 'weaker', x => x.actions[1].selector = '#other', x => x.actions[1].textEquals = 'one']) {
    const altered = structuredClone(narrowed); change(altered); await assert.rejects(f.run(altered), /预期不能/);
  }
  const passed = await f.run(narrowed);
  assert.equal(passed.status, 'passed', JSON.stringify(passed));
  assert.equal(passed.repairsCheckId, failed.id);
  assert.equal(passed.actual.length, 2);
  assert.equal(await fs.readFile(path.join(f.project, 'index.html'), 'utf8'), html);
  const count = await f.run({ ...spec, caseId: 'plural-assert', actions: [{ action: 'assert', selector: '.pick', count: 2 }] });
  assert.equal(count.status, 'passed');
});
