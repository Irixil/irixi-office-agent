import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import EasyStar from 'easystarjs';
globalThis.Phaser={Scene:class {},Game:class {},AUTO:'AUTO',Scale:{RESIZE:'RESIZE',CENTER_BOTH:'CENTER_BOTH'}};globalThis.EasyStar=EasyStar;
globalThis.document={addEventListener(){}};globalThis.window={addEventListener(){},dispatchEvent(){}};globalThis.CustomEvent=class {};
const {OfficeScene,OfficeGrid,normalizeRoomContract,walkableFoot}=await import('../public/office-game.js?offgrid-regression');
const art=new URL('../../art/office-playable-v1/',import.meta.url);
function fixture(){
 const s=new OfficeScene(),tweens=[];s.room=normalizeRoomContract(JSON.parse(readFileSync(new URL('concept-runtime-v4/manifest.json',art))),JSON.parse(readFileSync(new URL('concept-runtime-v5/manifest.json',art))));s.grid=new OfficeGrid(s.makeCollisionMap());
 s.playerCell={x:32,y:27};s.player={x:1040,y:896,setPosition(x,y){this.x=x;this.y=y;return this;},setDepth(){return this;},getByName(){return {play(){}};}};
 s.tweens={killTweensOf(){},add(c){tweens.push(c);return c;}};s.destinationMarker={setVisible(){return this;},setPosition(){return this;},setDepth(){return this;}};s.syncDebugState=()=>{};
 return {s,tweens};
}
function stopAtCounterexample(){
 const f=fixture(),s=f.s;assert.equal(s.canStep(1,0),true);s.moveToCell(33,27);s.player.setPosition(1052.8,896);f.tweens.at(-1).onUpdate();s.stopWalkForTextInput();
 assert.deepEqual([s.player.x,s.player.y],[1052.8,896],'typing stops without snapping');assert.equal(walkableFoot(s.room,s.player.x,s.player.y),true);return f;
}
test('R05 original rc2 off-grid near-leg counterexample is rejected by canStep and direct moveToCell',()=>{
 const {s,tweens}=stopAtCounterexample();assert.equal(s.canStep(0,1),false);const count=tweens.length;assert.equal(s.moveToCell(32,28),false);assert.equal(tweens.length,count);assert.deepEqual([s.player.x,s.player.y],[1052.8,896]);
});
test('R05 a safe direction resumes from the exact stopped position and every replayed foot remains walkable',()=>{
 const {s,tweens}=stopAtCounterexample();assert.equal(s.canStep(1,0),true);s.moveToCell(33,27);const tween=tweens.at(-1);
 for(let i=1;i<=100;i++){s.player.setPosition(1052.8+(1072-1052.8)*i/100,896);tween.onUpdate();assert.equal(walkableFoot(s.room,s.player.x,s.player.y),true);}
 tween.onComplete();assert.deepEqual([s.player.x,s.player.y],[1072,896]);assert.equal(s.stepInProgress,false);
});
test('R05 off-grid dynamic collision uses the real start rather than an unblocked grid-centre line',()=>{
 const {s}=stopAtCounterexample();s.room={...s.room,blockedRects:[],walkablePolygons:[[[0,0],[2000,0],[2000,2000],[0,2000]]]};s.grid=new OfficeGrid(s.makeCollisionMap());s.people=new Map([['steward',{sprite:{visible:true,x:1068,y:915}}]]);
 assert.equal(s.canOccupyCell(32,28),true);assert.equal(s.canStep(0,1),false,'actual diagonal segment enters colleague feet');assert.equal(s.canStep(-1,0),true,'moving away remains possible');
});
test('R05 normal pathfinding chooses a safe first segment after an editable-input stop',async()=>{
 const {s,tweens}=stopAtCounterexample();assert.equal(await s.startPath({x:32,y:28},{kind:'floor',destination:{x:32,y:28}}),true);assert.ok(s.path.length);
 const next=s.path[0];assert.notDeepEqual(next,{x:32,y:28},'unsafe direct first edge must be replaced by a detour');
 for(const cell of [...s.path]){const dx=cell.x-s.playerCell.x,dy=cell.y-s.playerCell.y;assert.equal(s.canStep(dx,dy),true);const start=[s.player.x,s.player.y];s.moveToCell(cell.x,cell.y);const tween=tweens.at(-1);for(let i=1;i<=100;i++){s.player.setPosition(start[0]+(tween.x-start[0])*i/100,start[1]+(tween.y-start[1])*i/100);tween.onUpdate();assert.equal(walkableFoot(s.room,s.player.x,s.player.y),true);}tween.onComplete();}
});
