#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertArticleNativePrompt } from '../../../../authority/article-project-capacity.mjs';
const slice=path.resolve(import.meta.dirname,'../..');
const fixedWorkspace=path.resolve(import.meta.dirname,'../workspace');
const wrappers=Object.freeze({ARTICLE_LEARNING_DEVELOPER_12:'codex-development-budget.mjs',ARTICLE_LEARNING_REVIEWER_12:'codex-development-budget.mjs',ARTICLE_LEARNING_INFERENCE_12:'codex-learning-budget.mjs'});
export function dispatchTarget(prompt){
 if(typeof prompt!=='string'||!prompt)throw Error('Rejected missing native prompt');
 const tags=Object.keys(wrappers).filter(tag=>prompt.includes(tag));
 if(tags.length!==1)throw Error('Rejected unregistered or ambiguous real project role');
 if(tags[0]==='ARTICLE_LEARNING_INFERENCE_12'){
  if(Buffer.byteLength(prompt)>65536)throw Error('Rejected oversized native inference prompt');
 }else assertArticleNativePrompt(prompt);
 return Object.freeze({tag:tags[0],wrapper:wrappers[tags[0]]});
}
async function main(){
 const cwd=await fs.realpath(process.cwd()),args=process.argv.slice(2),prompt=args.at(-1);
 const target=dispatchTarget(prompt);
 if(cwd!==fixedWorkspace)throw Error('Rejected cwd outside the authorized real project candidate workspace');
 const wrapper=path.resolve(import.meta.dirname,target.wrapper);
 const child=spawn(process.execPath,[wrapper,...args],{cwd,env:process.env,stdio:['ignore','inherit','inherit']});
 for(const signal of ['SIGINT','SIGTERM','SIGHUP'])process.once(signal,()=>{if(child.exitCode===null)child.kill(signal);});
 const r=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
 process.exitCode=r.code??(r.signal?1:0);
}
if(path.resolve(process.argv[1]||'')===fileURLToPath(import.meta.url))main().catch(e=>{console.error(`[codex-project-dispatch] ${e.message}`);process.exitCode=1;});
