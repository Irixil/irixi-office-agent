import assert from 'node:assert/strict';
import test from 'node:test';
globalThis.Phaser={Scene:class {},Game:class {},AUTO:'AUTO',Scale:{RESIZE:'RESIZE',CENTER_BOTH:'CENTER_BOTH'},Input:{Keyboard:{KeyCodes:{UP:38,DOWN:40,LEFT:37,RIGHT:39}}}};
const listeners=new Map();globalThis.document={activeElement:null,addEventListener(type,fn){listeners.set(type,fn);},removeEventListener(type){listeners.delete(type);},querySelector(){return null;}};globalThis.window={addEventListener(){},dispatchEvent(){}};globalThis.CustomEvent=class {};
const {OfficeScene}=await import('../public/office-game.js?text-input-stop');
const editable={matches(){return true;},closest(){return null;}};
function fixture(){
 document.activeElement=null;document.querySelector=()=>null;const scene=new OfficeScene(),updates=[],handlers={};let tween=null,killed=0,resets=0;
 const body={play(){return this;}};scene.player={x:688,y:1088,getByName(){return body;},setPosition(x,y){this.x=x;this.y=y;return this;},setDepth(){return this;}};
 scene.playerCell={x:21,y:33};scene.room={walkablePolygons:[[[0,0],[2000,0],[2000,2000],[0,2000]]],blockedRects:[]};scene.grid={isWalkable(){return true;}};
 scene.destinationMarker={visible:false,setVisible(v){this.visible=v;return this;},setPosition(){return this;},setDepth(){return this;}};
 scene.tweens={add(c){tween=c;return c;},killTweensOf(){killed++;}};
 scene.syncDebugState=()=>{};scene.syncRoleDebug=()=>{};scene.centerCameraOnPlayer=()=>{};
 for(const name of ['updateCoworkerTransitions','updateStewardMotionPause','updateStewardBurrowMotionPause','updateStewardRoutine','updateLocalCoworkers','syncCharacterLayers'])scene[name]=()=>updates.push(name);
 scene.cursors={left:{},right:{},up:{},down:{}};scene.keys={A:{},D:{},W:{},S:{}};
 scene.input={keyboard:{resetKeys(){resets++;for(const k of [...Object.values(scene.cursors),...Object.values(scene.keys)])k.isDown=false;},on(type,fn){handlers[type]=fn;},addKeys(keys){return Object.fromEntries((typeof keys==='string'?keys.split(','):Object.keys(keys)).map(k=>[k,{}]));}}};
 return {scene,updates,handlers,get tween(){return tween;},get killed(){return killed;},get resets(){return resets;}};
}
test('F11 editable input cancels an existing automatic route before the next step, with coworker updates still running',()=>{
 const {scene,updates}=fixture();scene.path=[{x:20,y:32}];scene.walkTarget={kind:'coworker'};document.activeElement=editable;const before=[scene.player.x,scene.player.y];scene.update(200);
 assert.deepEqual([scene.player.x,scene.player.y],before);assert.deepEqual(scene.path,[]);assert.equal(scene.walkTarget,null);assert.equal(scene.stepInProgress,false);assert.equal(updates.length,6);
});
test('F11 editable input stops an in-flight step at its current safe position and its old completion cannot revive walking',()=>{
 const f=fixture(),s=f.scene;s.walkTarget={kind:'coworker'};s.moveToCell(20,32);s.player.setPosition(675,1075);f.tween.onUpdate();const old=f.tween;s.path=[{x:19,y:31}];document.activeElement=editable;s.update(200);
 assert.deepEqual([s.player.x,s.player.y],[675,1075]);assert.equal(s.currentStep,null);assert.equal(s.stepInProgress,false);assert.equal(f.killed,1);old.onUpdate();old.onComplete();assert.deepEqual([s.player.x,s.player.y],[675,1075]);assert.deepEqual(s.path,[]);
});
test('F11 input invalidates a pending path request so a delayed result cannot restart the route',async()=>{
 const {scene}=fixture();let release;scene.grid.findPath=()=>new Promise(resolve=>release=resolve);const request=scene.startPath({x:20,y:32},{kind:'coworker'});assert.equal(scene.pathPending,true);
 document.activeElement=editable;scene.update(200);assert.equal(scene.pathPending,false);release([{x:21,y:33},{x:20,y:32}]);assert.equal(await request,false);assert.deepEqual(scene.path,[]);assert.equal(scene.walkTarget,null);assert.equal(scene.destinationMarker.visible,false);
});
test('F11 actual focus and composition listeners stop immediately without preventing Chinese, arrows or space',()=>{
 const {scene,handlers}=fixture();scene.registerKeyboardControls();scene.path=[{x:20,y:32}];document.activeElement=editable;listeners.get('focusin')({target:editable});assert.deepEqual(scene.path,[]);
 for(const key of ['中文','ArrowLeft','ArrowRight',' ','Process']){let prevented=false;handlers.keydown({key,target:editable,isComposing:key==='Process',preventDefault(){prevented=true;}});assert.equal(prevented,false);assert.equal(document.activeElement,editable);}
 scene.path=[{x:20,y:32}];document.activeElement=null;listeners.get('compositionstart')();assert.equal(scene.composing,true);assert.deepEqual(scene.path,[]);listeners.get('compositionend')();assert.equal(scene.composing,false);assert.deepEqual(scene.path,[]);
});
test('F11 ordinary open dialog does not cancel automatic approach before editable text receives focus',()=>{
 const {scene}=fixture();document.querySelector=()=>({open:true});scene.path=[{x:20,y:32}];scene.update(200);assert.equal(scene.stepInProgress,true);assert.equal(scene.pathRequestId,0);
});
test('F11 position-preserving cancellation is opt-in; normal Esc/button cancellation keeps its prior destination semantics',()=>{
 const f=fixture(),s=f.scene;s.moveToCell(20,32);s.player.setPosition(675,1075);f.tween.onUpdate();s.cancelWalk();assert.deepEqual([s.player.x,s.player.y],[656,1056]);assert.deepEqual(s.playerCell,{x:20,y:32});
});
