import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
const {guardWorkspaceToolCalls}=await import(process.env.IRIXI_PATH_REVIEW_PROTOCOL || './codex-provider-protocol.mjs');
const call=(name,value,key='path')=>({content:[{type:'toolCall',name,arguments:{[key]:value}}]});
async function fixture(t){
 const base=await fs.mkdtemp('/private/tmp/irixi-path-case-');t.after(()=>fs.rm(base,{recursive:true,force:true}));
 const home=path.join(base,'IRiXi'),root=path.join(home,'project','workspace');await fs.mkdir(root,{recursive:true});
 const alias=path.join(base,'IRiXI','project','workspace');
 await fs.writeFile(path.join(root,'allowed.txt'),'alpha\nsecond\n');
 const a=await fs.stat(root),b=await fs.stat(alias);
 assert.equal(a.dev,b.dev);assert.equal(a.ino,b.ino);assert.equal(await fs.realpath(alias),root);
 return {base,home,root,alias,guard:(d,extra={})=>guardWorkspaceToolCalls(d,{role:'Developer',rootPath:root,conversation:true,...extra})};
}

test('same registered root casing accepts read/edit and sends the exact canonical path to native tools',async t=>{
 const f=await fixture(t);
 for(const name of ['read','edit']){const d=call(name,path.join(f.alias,'allowed.txt'));await f.guard(d);assert.equal(d.content[0].arguments.path,path.join(f.root,'allowed.txt'));}
 const array=call('read',[path.join(f.alias,'allowed.txt')],'paths');await f.guard(array);assert.deepEqual(array.content[0].arguments.paths,[path.join(f.root,'allowed.txt')]);
 assert.equal(await fs.readFile(path.join(f.root,'allowed.txt'),'utf8'),'alpha\nsecond\n');
});

test('same root prefix preserves new-file behavior and exact child write scope',async t=>{
 const f=await fixture(t);const d=call('write',path.join(f.alias,'new','new.txt'));
 await f.guard(d,{writeScope:['new/new.txt']});assert.equal(d.content[0].arguments.path,path.join(f.root,'new','new.txt'));
 await assert.rejects(fs.stat(path.join(f.root,'new')), {code:'ENOENT'});
 await f.guard(call('edit',path.join(f.alias,'allowed.txt')),{writeScope:['allowed.txt']});
 await assert.rejects(f.guard(call('write',path.join(f.alias,'other.txt')),{writeScope:['allowed.txt']}),/writable paths/);
});

test('actual outside root and a neighbor prefix remain rejected',async t=>{
 const f=await fixture(t);const neighbor=f.root+'-other';await fs.mkdir(neighbor);await fs.writeFile(path.join(neighbor,'allowed.txt'),'outside');
 for(const p of [path.join(neighbor,'allowed.txt'),path.join(f.base,'absent','allowed.txt')]){
  await assert.rejects(f.guard(call('edit',p)),{code:'OMO_WORKSPACE_PATH_OUTSIDE_ROOT'});
  await assert.rejects(f.guard(call('read',p)),{code:'OMO_WORKSPACE_PATH_BLOCKED'});
 }
 await assert.rejects(f.guard(call('edit',path.join(f.alias,'x')+'/../allowed.txt')),/traversal/);
});

test('symlink root aliases, symlink targets and hard links are not normalized into permission',async t=>{
 const f=await fixture(t);const linkedHome=path.join(f.base,'LinkedHome');await fs.symlink(f.home,linkedHome);
 await assert.rejects(f.guard(call('edit',path.join(linkedHome,'project','workspace','allowed.txt'))),/symlinks or hard-linked/);
 await fs.symlink(path.join(f.root,'allowed.txt'),path.join(f.root,'linked.txt'));
 await assert.rejects(f.guard(call('read',path.join(f.alias,'linked.txt'))),/symlinks or hard-linked/);
 await fs.symlink(f.base,path.join(f.root,'linked-dir'));
 await assert.rejects(f.guard(call('write',path.join(f.alias,'linked-dir','not-created.txt'))),/symlinks or hard-linked/);
 await fs.link(path.join(f.root,'allowed.txt'),path.join(f.root,'hard.txt'));
 await assert.rejects(f.guard(call('edit',path.join(f.alias,'hard.txt'))),/symlinks or hard-linked/);
});

test('missing read still defers only to strict tool errors and existing line-column lookup works',async t=>{
 const f=await fixture(t);
 await assert.rejects(f.guard(call('read',path.join(f.alias,'absent.txt'))),{code:'OMO_WORKSPACE_PATH_NOT_FOUND'});
 const missing=call('read',path.join(f.alias,'absent.txt'));await f.guard(missing,{deferMissingReadErrors:true});
 assert.equal(missing.content[0].arguments.path,path.join(f.root,'absent.txt'));
 await assert.rejects(f.guard(missing),{code:'OMO_WORKSPACE_PATH_NOT_FOUND'});
 const located=call('read',path.join(f.alias,'allowed.txt')+':2:1?');await f.guard(located);
 assert.equal(located.content[0].arguments.path,path.join(f.root,'allowed.txt'));assert.equal(located.content[0].arguments.offset,2);
});
