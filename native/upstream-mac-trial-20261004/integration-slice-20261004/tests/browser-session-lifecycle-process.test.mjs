import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
const moduleUrl=new URL('../project-intake-20261004/projects/article-learning-12/tools/browser-session-lifecycle.mjs',import.meta.url).href;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
function child(script){
 const p=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['pipe','pipe','pipe']});
 let output='',error='';p.stdout.on('data',b=>{output+=b;});p.stderr.on('data',b=>{error+=b;});
 const exit=new Promise(resolve=>p.once('exit',(code,signal)=>resolve({code,signal,get output(){return output},get error(){return error}})));
 return{p,exit,output:()=>output};
}
const start=`import readline from 'node:readline';const input=readline.createInterface({input:process.stdin});`;
test('CONTROLLED PROCESS: former close-without-readline leaves a real stdin child alive',async()=>{
 const c=child(start+`process.stdout.write('browser-closed-fixture');`);
 try{
  for(let i=0;i<30&&!c.output();i++)await pause(20);
  assert.equal(c.output(),'browser-closed-fixture');await pause(100);assert.equal(c.p.exitCode,null);
 }finally{c.p.kill('SIGTERM');await c.exit;}
});
for(const throws of [false,true])test(`CONTROLLED PROCESS: readline release permits natural exit with stdin pipe still open (${throws?'close throws':'success'})`,async()=>{
 const c=child(start+`import {closeControlledBrowserSession} from ${JSON.stringify(moduleUrl)};
 const browser={async capture(){},async close(){${throws?"throw Error('fixture-close-failed');":''}}};
 try{await closeControlledBrowserSession({input,browser});process.stdout.write('closed');}catch(e){process.stdout.write(e.message);}`);
 try{
  const result=await Promise.race([c.exit,pause(2000).then(()=>null)]);
  assert.ok(result,'helper must exit without parent ending stdin');assert.equal(result.code,0);assert.equal(result.signal,null);assert.equal(result.error,'');
  assert.equal(result.output,throws?'fixture-close-failed':'closed');
 }finally{if(c.p.exitCode===null&&c.p.signalCode===null){c.p.kill('SIGTERM');await c.exit;}}
});
