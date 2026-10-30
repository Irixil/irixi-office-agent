import assert from 'node:assert/strict';
import test from 'node:test';
globalThis.Phaser={Scene:class {},Game:class {},AUTO:'AUTO',Scale:{RESIZE:'RESIZE',CENTER_BOTH:'CENTER_BOTH'}};
globalThis.document={addEventListener(){}};globalThis.window={addEventListener(){}};
const {OfficeScene}=await import('../public/office-game.js?steward-prop-regression');
function fixture(owner='desk') {
  const scene=new OfficeScene();const images=[];
  scene.add={image(x,y,key){const i={x,y,key,visible:true,setOrigin(){return this;},setDisplaySize(){return this;},setDepth(){return this;},setVisible(v){this.visible=v;return this;}};images.push(i);return i;}};
  scene.coworkerContracts={steward:{steward:{integration:{propVisibility:{fixedDeskStackWorldBBox:[960,819,1022,859],shelfPatchWorldBBox:[864,730,904,760]},shelfWorldFoot:[884,780]}}}};
  scene.stewardRoutine={bookOwner:owner};scene.drawStewardProps();return {scene,images};
}
test('R02 initial legacy prop objects stay hidden until current work mode is known',()=>{
  const {scene,images}=fixture();assert.equal(images.length,2);assert.ok(images.every(i=>!i.visible));
  scene.syncStewardProps();assert.equal(scene.stewardDeskStack.visible,true);assert.equal(scene.stewardShelfStack.visible,false);
});
test('R02 real setTask workbench entry hides the old desk/shelf props; exit restores actual book owner',()=>{
  for(const owner of ['desk','shelf','mole','transition']){
    const {scene,images}=fixture(owner);scene.syncStewardProps();const before=images.map(i=>i.visible);
    scene.setTask({colleagues:[]});assert.deepEqual(images.map(i=>i.visible),[false,false]);assert.equal(scene.stewardRoutine.bookOwner,owner);
    scene.setTask({status:'idle'});assert.deepEqual(images.map(i=>i.visible),before);assert.equal(scene.stewardRoutine.bookOwner,owner);
  }
});
test('R02 burrow setup alone suppresses legacy props and late owner notifications cannot restore duplicate books',()=>{
  const {scene,images}=fixture();scene.stewardBurrow={workbench:true};
  for(const owner of ['desk','shelf','mole','transition']) {scene.stewardRoutine.bookOwner=owner;scene.syncStewardProps();assert.deepEqual(images.map(i=>i.visible),[false,false]);}
  scene.stewardRoutine.bookOwner='shelf';scene.stewardBurrow.workbench=false;scene.syncStewardProps();assert.deepEqual(images.map(i=>i.visible),[false,true]);
});
