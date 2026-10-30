import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { conversationSourceBuild } from '../../omo-pilot/server.mjs';

test('actually referenced scene and foreground bytes change the build, unrelated art does not', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'irixi-scene-build-'));
  const folder=path.join(root,'art/office-playable-v1/concept-runtime-v4');
  await fs.mkdir(folder,{recursive:true});
  const write=(name,data)=>fs.writeFile(path.join(folder,name),data);
  try {
    await write('manifest.json',JSON.stringify({world:{background:'room.png'},foregroundItems:[{file:'desk.png'}]}));
    await write('room.png','room fixture');await write('desk.png','desk fixture');
    const initial=await conversationSourceBuild([],root);
    await write('unreferenced.png','other');assert.equal(await conversationSourceBuild([],root),initial);
    await write('desk.png','revised desk');assert.notEqual(await conversationSourceBuild([],root),initial);
    await write('desk.png','desk fixture');assert.equal(await conversationSourceBuild([],root),initial);
    await fs.unlink(path.join(folder,'desk.png'));await assert.rejects(conversationSourceBuild([],root),/ENOENT/);
    await write('manifest.json',JSON.stringify({world:{background:'../outside.png'}}));
    await assert.rejects(conversationSourceBuild([],root),/非法素材路径/);
  } finally {await fs.rm(root,{recursive:true,force:true});}
});

test('split hand layer and station occlusion are part of the actual build identity', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'irixi-front-build-'));
  const pack=path.join(root,'art/office-playable-v1/motion-quality-v8');
  await fs.mkdir(path.join(pack,'role'),{recursive:true});
  try {
    await fs.writeFile(path.join(pack,'manifest.json'),JSON.stringify({roles:{reviewer:{manifest:'role/manifest.json'}}}));
    await fs.writeFile(path.join(pack,'role/manifest.json'),JSON.stringify({states:{idle:{spritesheet:'body.png',frontSpritesheet:'hand.png'}},occlusionPatch:{file:'table.png'}}));
    for(const file of ['body.png','hand.png','table.png']) await fs.writeFile(path.join(pack,'role',file),file);
    const initial=await conversationSourceBuild([],root);
    for(const file of ['hand.png','table.png']) {
      await fs.writeFile(path.join(pack,'role',file),'changed');
      assert.notEqual(await conversationSourceBuild([],root),initial,file);
      await fs.writeFile(path.join(pack,'role',file),file);
    }
    await fs.unlink(path.join(pack,'role/hand.png'));
    await assert.rejects(conversationSourceBuild([],root),/hand.png/);
  } finally {await fs.rm(root,{recursive:true,force:true});}
});
