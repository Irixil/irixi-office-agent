import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { __test as adapter, buildProviderDecisionSchema } from '../codex-role-adapter.mjs';
import { validateParallelRequest } from '../../omo-pilot/conversation-parallel.mjs';
import { guardWorkspaceToolCalls } from '../../omo-pilot/codex-provider-protocol.mjs';

// Register the actual product tool metadata. No tool/stream/CLI is executed.
async function parallelTool(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nested-tool-schema-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const sdk=path.join(root,'unused-sdk.mjs');await fs.writeFile(sdk,"export function createAssistantMessageEventStream(){throw new Error('No model allowed in metadata check');}");
  const keys=['IRIXI_OMO_PI_AI_MODULE_URL','IRIXI_OMO_CONVERSATION','IRIXI_OMO_ROLE'];const old=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  try {
    process.env.IRIXI_OMO_PI_AI_MODULE_URL=pathToFileURL(sdk).href;process.env.IRIXI_OMO_CONVERSATION='1';process.env.IRIXI_OMO_ROLE='Developer';
    const {default:register}=await import(new URL(`../../omo-pilot/codex-bridge-provider.mjs?metadata=${encodeURIComponent(root)}`,import.meta.url));
    const tools=[];register({registerTool:t=>tools.push(t),on:()=>{},registerProvider:()=>{}});
    return {root,tool:tools.find(t=>t.name==='delegate_parallel')};
  } finally {for(const k of keys)old[k]===undefined?delete process.env[k]:process.env[k]=old[k];}
}
const block=(args,name='delegate_parallel')=>({content:[{type:'toolCall',name,arguments:args}]});
const normalized=(args,tool)=>JSON.parse(adapter.normalizeProviderDecision(block(args,tool.name),[tool]).text).content[0].arguments;

test('实际delegate_parallel schema：严格输出的嵌套null恢复成未指定同事，两个写范围不变',async t=>{
 const {tool}=await parallelTool(t);assert.ok(tool);
 const strict=buildProviderDecisionSchema([tool]).properties.content.items.anyOf.find(x=>x.properties.name?.enum?.[0]===tool.name).properties.arguments;
 assert.ok(strict.properties.tasks.items.required.includes('colleagueId'));
 assert.ok(strict.properties.tasks.items.properties.colleagueId.anyOf.some(x=>x.type==='null'));
 const tasks=[{task:'修改统计计算',colleagueId:null,writePaths:['budget.mjs']},{task:'新增命令入口',colleagueId:null,writePaths:['cli.mjs']}];
 const actual=normalized({tasks},tool);assert.deepEqual(actual.tasks,[{task:'修改统计计算',writePaths:['budget.mjs']},{task:'新增命令入口',writePaths:['cli.mjs']}]);
 const accepted=validateParallelRequest({requestId:'local-only',...actual});assert.equal(accepted.length,2);assert.ok(accepted.every(x=>!Object.hasOwn(x,'colleagueId')));
});

test('嵌套数组与array union递归恢复；原schema明确允许null的字段和数组元素仍保留',()=>{
 const item={type:'object',properties:{label:{type:'string'},optional:{type:'string'},nullable:{type:['string','null']},requiredNullable:{type:['string','null']}},required:['label','requiredNullable'],additionalProperties:false};
 const tool={name:'nested',parameters:{type:'object',properties:{rows:{anyOf:[{type:'array',items:{type:'array',items:item}},{type:'null'}]},values:{type:'array',items:{type:['string','null']}}},required:['rows','values'],additionalProperties:false}};
 const actual=normalized({rows:[[{label:'one',optional:null,nullable:null,requiredNullable:null}]],values:['keep',null]},tool);
 assert.deepEqual(actual,{rows:[[{label:'one',nullable:null,requiredNullable:null}]],values:['keep',null]});
 assert.deepEqual(normalized({rows:null,values:[null]},tool),{rows:null,values:[null]});
});

test('必填null、无效同事、未知字段仍拒绝，不把错误参数变成默认授权',async t=>{
 const {tool}=await parallelTool(t);
 const valid={task:'工作',writePaths:['budget.mjs'],colleagueId:null};
 for(const invalid of [{...valid,task:null},{...valid,writePaths:null},{...valid,colleagueId:'not-a-colleague'},{...valid,unexpected:null}]){
  assert.throws(()=>normalized({tasks:[invalid,{...valid,writePaths:['cli.mjs']}]},tool),/do not match OmO tool/);
 }
 const selected=normalized({tasks:[{...valid,colleagueId:'writer'},{...valid,writePaths:['cli.mjs']}]},tool);assert.equal(selected.tasks[0].colleagueId,'writer');
});

test('参数恢复不放松2至4助手、明确写范围与禁止上级路径的宿主检查',async t=>{
 const {root,tool}=await parallelTool(t);
 const one=normalized({tasks:[{task:'工作',writePaths:['budget.mjs'],colleagueId:null}]},tool);
 await assert.rejects(guardWorkspaceToolCalls(block(one),{role:'Developer',rootPath:root,conversation:true}),/2至4/);
 const outside=normalized({tasks:[{task:'工作',writePaths:['../outside.mjs'],colleagueId:null},{task:'另一项',writePaths:['cli.mjs'],colleagueId:null}]},tool);
 assert.throws(()=>validateParallelRequest({requestId:'local-only',...outside}),/普通相对文件路径/);
});
