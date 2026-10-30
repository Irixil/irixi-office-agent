import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { artifactFileLink, renderMarkdown, visibleMessageText } from '../public/conversation-format.js';
import { ConversationPreviews } from '../../omo-pilot/conversation-preview.mjs';

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const turn = () => ({id:'original-turn',projectId:'original-project',adoptedAt:'2026-10-27T19:04:08Z',workspace:'/private/tmp/working-copy',projectIdentity:{path:'/tmp/chosen-project',canonical:'/private/tmp/chosen-project'},artifactEntrypoint:'dist/index.html',resultIndex:{'dist/index.html':sha('game'),'src/index.html':sha('source'),'docs/使用说明.md':sha('guide'),'docs/a&b.txt':sha('and'),'assets/star.png':sha('image')}});
const preview = '/conversation-preview/original-project/__run__/index.html?turn=original-turn';

test('same-turn adopted relative and exact absolute references use the existing versioned entry route',()=>{
  const t=turn();
  for(const value of ['dist/index.html','./dist/index.html','/private/tmp/working-copy/dist/index.html','/tmp/chosen-project/dist/index.html','/private/tmp/chosen-project/dist/index.html','file:///private/tmp/working-copy/dist/index.html']) assert.equal(artifactFileLink(value,t),preview,value);
  assert.equal(artifactFileLink('src/index.html',t),'/conversation-preview/original-project/src/index.html?turn=original-turn');
  assert.equal(artifactFileLink('docs/%E4%BD%BF%E7%94%A8%E8%AF%B4%E6%98%8E.md',t),'/conversation-preview/original-project/docs/%E4%BD%BF%E7%94%A8%E8%AF%B4%E6%98%8E.md?turn=original-turn');
  assert.ok(renderMarkdown('[guide](docs/a&b.txt)',{artifactTurn:t}).includes('docs/a%26b.txt?turn=original-turn'));
});

test('no basename, latest-turn, neighboring root, or unknown file guesses',()=>{
  const t=turn();
  for(const value of ['index.html','other/dist/index.html','missing.txt','/private/tmp/working-copy-other/dist/index.html','/another/project/dist/index.html','~/project/dist/index.html']) {
    assert.equal(artifactFileLink(value,t),null,value);
    assert.ok(!renderMarkdown(`[open](${value})`,{artifactTurn:t}).includes('<a '),value);
  }
});

test('unadopted and missing delivery evidence cannot produce artifact links',()=>{
  for(const t of [undefined,{}, {...turn(),adoptedAt:null}, {...turn(),resultIndex:{}}, {...turn(),resultIndex:{'dist/index.html':null}}, {...turn(),projectId:null}]) assert.equal(artifactFileLink('dist/index.html',t),null);
  assert.equal(artifactFileLink('index.html',{...turn(),artifactEntrypoint:undefined,resultIndex:{'index.html':sha('plain')}}),'/conversation-preview/original-project/index.html?turn=original-turn');
});

test('traversal, encoded traversal, control bytes, links to protected files and malformed paths stay text',()=>{
  const t=turn(); for(const key of ['.env','secrets.txt','key.pem','folder/.hidden'])t.resultIndex[key]=sha('not provided');
  for(const value of ['../dist/index.html','dist/../dist/index.html','%2e%2e/dist/index.html','dist/%2e%2e/index.html','/private/tmp/working-copy/../working-copy/dist/index.html','dist%2f..%2findex.html','dist//index.html','dist/./index.html','dist\\index.html','dist/%00index.html','dist/%0aindex.html','dist/%ZZindex.html','.env','secrets.txt','key.pem','folder/.hidden','file://elsewhere/private/tmp/working-copy/dist/index.html']) {
    assert.equal(artifactFileLink(value,t),null,value);
    assert.ok(!renderMarkdown(`[open](${value})`,{artifactTurn:t}).includes('<a '),value);
  }
});

test('HTTP, mail, API routes and message deep links are unchanged even when a turn exists',()=>{
  for(const target of ['https://example.com/dist/index.html?q=x&b=y','http://127.0.0.1:58313/?conversation=old&message=m','//example.com/file','mailto:user@example.com','/api/conversation/test/preview','/conversation-preview/p/index.html?turn=t','/?backend=openoffice&conversation=old&message=m','?conversation=old&message=m','#message']) assert.equal(renderMarkdown(`[open](${target})`,{artifactTurn:turn()}),renderMarkdown(`[open](${target})`),target);
  assert.ok(!renderMarkdown('[x](javascript:alert)').includes('href="javascript:'));
});

test('artifact references work in every supported Markdown block and keep raw/visible text',()=>{
  const t=turn(); const link='[打开接星星](dist/index.html)';
  const text=`# ${link}\n\n${link}\n\n- ${link}\n\n> ${link}\n\n| file |\n| --- |\n| ${link} |\n\n\`${link}\``;
  const before=structuredClone(t); const output=renderMarkdown(text,{artifactTurn:t});
  assert.equal((output.match(/__run__\/index.html\?turn=original-turn/g)||[]).length,5);
  assert.equal(visibleMessageText('[打开接星星](dist/index.html)'), '打开接星星');
  assert.ok(output.includes('打开接星星'));
  assert.deepEqual(t,before); assert.equal(text.includes(link),true);
  assert.ok(!renderMarkdown('[x](/private/tmp/working-copy/\"><img-src=x>)',{artifactTurn:t}).includes('<img'));
});

async function rendererFixture(){
 const source=await fs.readFile(new URL('../public/conversation-app.js',import.meta.url),'utf8');
 const selected=source.slice(source.indexOf('function messageNode('),source.indexOf('\nfunction duration('));
 const history={children:[],append(node){this.children.push(node);},querySelector(){return this.children[0]||null;},replaceChildren(){this.children=[];}};
 const scroll={scrollHeight:1000,scrollTop:0,clientHeight:200};
 const context={renderMarkdown,esc:String,roleName:()=>'',active:new Set(['working']),focusedMessage:null,selectedRole:null,roleProfile:()=>null,button:()=>'',linkFor:()=>'',html:()=>{},$:s=>s==='#wb-history'?history:scroll,document:{
   createElement(){const body={innerHTML:'',writes:0};Object.defineProperty(body,'innerHTML',{get(){return this.html||'';},set(value){this.html=value;this.writes++;}});return {dataset:{},innerHTML:'',querySelector:()=>body,querySelectorAll:()=>[],body};},
   getElementById(id){return history.children.find(n=>n.id===id);}
 }};
 const sandbox=vm.createContext(context); vm.runInContext(selected,sandbox);
 return {source,history,run:(msg,c)=>{sandbox.msg=msg;sandbox.c=c;return vm.runInContext('messageNode(msg,c)',sandbox);},render:c=>{sandbox.c=c;vm.runInContext('renderMessages(c)',sandbox);}};
}

test('message renderer resolves only its own turn after project moves; inherited/other turns never borrow a match',async()=>{
 const f=await rendererFixture(); const m={id:'m',turnId:'original-turn',role:'assistant',at:'2026-10-27',text:'[play](dist/index.html)'};
 let node=f.run(m,{id:'moved-conversation',projectId:'new-project',turns:[turn(),{...turn(),id:'new-turn',projectId:'new-project'}]});
 assert.ok(node.innerHTML.includes(preview));assert.ok(!node.innerHTML.includes('new-project/'));
 node=f.run({...m,inherited:true},{projectId:'new-project',turns:[{...turn(),id:'new-turn',projectId:'new-project'}]});
 assert.ok(!node.innerHTML.includes('/conversation-preview/'));
 const changed={...m,turnId:'other-turn'};node=f.run(changed,{turns:[turn()]});assert.ok(!node.innerHTML.includes('/conversation-preview/'));
});

test('adoption enables an existing message link once; ordinary refresh does not replace its body',async()=>{
 const f=await rendererFixture();const t={...turn(),adoptedAt:null,status:'working'};const c={turns:[t],messages:[{id:'m',turnId:t.id,role:'assistant',at:'2026-10-27',text:'[play](dist/index.html)'}]};
 f.render(c); const node=f.history.children[0]; assert.ok(!node.innerHTML.includes('/conversation-preview/'));
 t.adoptedAt='now';t.status='completed';f.render(c);assert.ok(node.body.innerHTML.includes(preview));assert.equal(node.body.writes,1);
 f.render(c);assert.equal(node.body.writes,1);
});

test('copy/reference action source still uses the unchanged raw message',async()=>{
 const source=await fs.readFile(new URL('../public/conversation-app.js',import.meta.url),'utf8');
 assert.match(source,/case 'copy-message': await copy\(message\.text\); break;/);
 const quoteCase = source.split('\n').find(line => line.includes("case 'quote-message':"));
 assert.ok(quoteCase.includes('conversationId: c.id, messageId: message.id'));
 assert.ok(quoteCase.includes('selection: quoteSelection.text'));
 assert.ok(!quoteCase.includes('renderMarkdown'));
});

test('generated entry uses real preview route, serves its assets and still rejects changed bytes and traversal',async()=>{
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'artifact-link-')));
 const t={...turn(),workspace:root};const project={id:t.projectId,root};
 await fs.mkdir(path.join(root,'dist/assets'),{recursive:true});await fs.writeFile(path.join(root,'dist/index.html'),'<img src="assets/star.txt">');await fs.writeFile(path.join(root,'dist/assets/star.txt'),'star');
 t.resultIndex={'dist/index.html':sha('<img src="assets/star.txt">'),'dist/assets/star.txt':sha('star')};
 const store={state:{projects:[project],conversations:[{turns:[t]}]},save:async()=>{}};const previews=new ConversationPreviews(store);
 try{
  const href=artifactFileLink('dist/index.html',t);assert.equal(href,preview);
  const url=new URL(href,'http://127.0.0.1');const parts=url.pathname.split('/');let redirected;
  await previews.redirect(parts[2],parts.slice(3).join('/'),url.searchParams.get('turn'),{writeHead(code,headers){assert.equal(code,302);redirected=headers.Location;},end(){}});
  const response=await fetch(redirected);assert.equal(response.status,200);assert.equal(await response.text(),'<img src="assets/star.txt">');
  assert.equal(await (await fetch(new URL('assets/star.txt',redirected))).text(),'star');
  await fs.writeFile(path.join(root,'dist/index.html'),'changed');assert.equal((await fetch(redirected)).status,409);
  assert.equal((await fetch(redirected.replace('__run__/index.html','__run__/..%2foutside.txt'))).status,403);
 }finally{previews.close();await fs.rm(root,{recursive:true,force:true});}
});
