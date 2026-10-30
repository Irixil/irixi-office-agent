import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import test from 'node:test';
import { coworkerRuntimeState } from '../public/office-geometry.js';
globalThis.Phaser = {Scene: class {},Game: class {},AUTO:'AUTO',Scale:{RESIZE:'RESIZE',CENTER_BOTH:'CENTER_BOTH'},Geom:{Rectangle:class {}}};
globalThis.document = {addEventListener(){},querySelector(){return null;},getElementById(){return {dataset:{}};}};
globalThis.window = {addEventListener(){},dispatchEvent(){}};
globalThis.CustomEvent = class {constructor(type,options){this.type=type;this.detail=options.detail;}};
const { OfficeScene, bindQualityStates, coworkerAnimationSpec, coworkerRenderTransform } = await import('../public/office-game.js?sleep-v3');
const roles=['researcher','writer','reviewer','archivist'];
const task=(role='writer',...statuses)=>({colleagues:roles.map(id=>({id,works:id===role?statuses.map(status=>({status})):[]}))});
function fixture({reduced=false,reversible=false,pack=new URL('../../art/office-playable-v1/motion-quality-v8/',import.meta.url)}={}) {
  const scene=new OfficeScene(),objects=[];
  scene.people=new Map();scene.coworkerContracts={};scene.time={now:100};scene.motionPreference={matches:reduced};scene.reducedMotion=reduced;scene.scale={height:800};scene.syncRoleDebug=()=>{};scene.moveCoworker=()=>{};
  scene.add={text(x,y,text){const o={x,y,text,visible:true,input:null,setOrigin(){return this;},setDepth(){return this;},setVisible(v){this.visible=v;return this;},setPosition(x,y){this.x=x;this.y=y;return this;},setAlpha(v){this.alpha=v;return this;}};objects.push(o);return o;}};
  const index=JSON.parse(readFileSync(new URL('manifest.json',pack),'utf8'));
  for(const role of roles) {
    const contract=bindQualityStates({role,revision:'base',animations:{},deskDock:{worldAnchor:[100,200]}},JSON.parse(readFileSync(new URL(index.roles[role].manifest,pack),'utf8')));
    if(reversible) {
      const shared={spritesheet:'synthetic-shared-sleep-atlas.png',frameDurationsMs:[80,120,160,200],loop:false};
      bindQualityStates(contract,{id:'synthetic-reversal-contract',frameSize:contract.animations.sleeping.frameSize,anchor:contract.animations.sleeping.anchor,states:{
        'enter-sleeping':{...shared,frameIndices:[7,2,11,5],staticFrameIndex:5,reverseOf:'sleep-to-idle'},
        'exit-sleeping':{...shared,frameIndices:[5,11,2,7],staticFrameIndex:7,reverseOf:'idle-to-sleep'},
      }});
    }
    const callbacks=new Map();const body={visible:true,x:0,y:0,alpha:1,anims:{currentFrame:{textureFrame:0}},texture:{key:''},frame:{name:0},getData(){return true;},setOrigin(){return this;},setScale(){return this;},setPosition(){return this;},play(key){
      this.anims.isPlaying=true;this.animation=key;
      const action=(typeof key==='string'?key:key.key).slice(role.length+1),spec=coworkerAnimationSpec(contract,role,action),position=typeof key==='string'?0:key.startFrame;
      this.anims.currentFrame={textureFrame:spec.frames[position],index:position+1};this.frame.name=spec.frames[position];this.texture.key=spec.textureKey;return this;
    },stop(){this.anims.isPlaying=false;this.stops=(this.stops||0)+1;return this;},setTexture(key){this.texture.key=key;return this;},setFrame(v){this.frame.name=v;return this;},once(event,cb){callbacks.set(event,cb);},off(event){callbacks.delete(event);}};
    const sprite={x:100,y:200,visible:true,alpha:1,getByName(){return body;},setAlpha(){return this;},setInteractive(){return this;}};
    const person={role,home:[100,200],localAction:'idle',desiredAction:'idle',localEligible:true,active:false,activitySource:'local',sprite,statusText:{setText(v){this.text=v;}},callbacks,body};scene.people.set(role,person);scene.coworkerContracts[role]=contract;
  }
  return {scene,objects};
}
function finish(person) {const listener=person.transitionListener;if(listener)person.callbacks.delete(listener.event);listener?.callback();}
test('R04 empty work, explicit unknown and disconnected have distinct sleep eligibility',()=>{
  assert.equal(coworkerRuntimeState(task(),'writer').localEligible,true);
  for(const status of ['unknown','future_status',null,undefined,'queued','waiting_user','failed','stopped','stopping'])assert.equal(coworkerRuntimeState(task('writer',status),'writer').localEligible,false,String(status));
  assert.equal(coworkerRuntimeState({...task(),disconnected:true},'writer').localEligible,false);
  assert.equal(coworkerRuntimeState(task('writer','completed','working'),'writer').active,true);
  assert.equal(coworkerRuntimeState(task('writer','completed','unknown'),'writer').localEligible,false);
});
test('R03 cold start sleep and reduced motion both reach all four authored closed-eye states without idle timer',()=>{
  for(const reduced of [false,true]) {const {scene}=fixture({reduced});scene.setTask(task());for(const p of scene.people.values()){finish(p);scene.updateCoworkerTransitions();assert.equal(p.localAction,'sleeping',p.role);if(reduced)assert.equal(p.body.texture.key,`coworker-${p.role}-v8-sleeping`);assert.equal(p.nextLocalActionAt,Infinity);}}
});
test('R03 one noninteractive Z per actual sleeper survives old deadlines; motion toggles keep static sleep',()=>{
  const {scene,objects}=fixture();scene.setTask(task());assert.equal(objects.length,0,'entry transition is not yet sleep');for(const p of scene.people.values())finish(p);
  for(const time of [100,44999,45000,45001,52999,53000,53001,60999,61000,61001,76999,77000,77001,90000,200000]) {scene.time.now=time;scene.updateLocalCoworkers(time);for(const p of scene.people.values()){scene.syncSleepingIndicator(p,time);assert.equal(p.localAction,'sleeping');assert.equal(p.sleepIndicator.visible,true);assert.equal(p.sleepIndicator.input,null);}}
  assert.equal(objects.length,4);scene.setTask(task(),{reducedMotion:true});for(const p of scene.people.values()){scene.syncSleepingIndicator(p,200001);const y=p.sleepIndicator.y;scene.syncSleepingIndicator(p,210000);assert.equal(p.sleepIndicator.y,y);assert.equal(p.sleepIndicator.alpha,.75);assert.equal(p.localAction,'sleeping');}
});
test('R04 conversation close resumes sleep; overlapping work and stale callbacks cannot restore sleep',()=>{
  const {scene}=fixture();scene.setTask(task());const p=scene.people.get('writer');const stale=p.transitionListener?.callback;
  scene.setTask(task('writer','working'));assert.notEqual(p.localAction,'idle-to-sleep');stale?.();assert.notEqual(p.localAction,'sleeping');
  scene.setTask(task('writer','completed','working'));assert.equal(p.active,true);scene.setTask(task('writer','completed'));finish(p);scene.updateCoworkerTransitions();finish(p);assert.equal(p.desiredAction,'sleeping');
  scene.setTask(task(),{engagedRole:'writer'});assert.equal(p.desiredAction,'idle');scene.syncSleepingIndicator(p);assert.equal(p.sleepIndicator?.visible??false,false);
  scene.setTask(task());finish(p);scene.updateCoworkerTransitions();finish(p);assert.equal(p.desiredAction,'sleeping');
});

test('R04 clicking uses the normal conversation event immediately and wakes before walking completes',async()=>{
  const {scene}=fixture();scene.setTask(task());for(const p of scene.people.values())finish(p);
  const events=[];globalThis.CustomEvent=class {constructor(type,options){this.type=type;this.detail=options.detail;}};window.dispatchEvent=event=>events.push(event);
  scene.nearestWalkable=()=>({x:4,y:4});scene.playerCell={x:0,y:0};scene.startPath=()=>new Promise(()=>{});
  const p=scene.people.get('writer');scene.syncSleepingIndicator(p);scene.talkTo(p);
  assert.equal(events[0].type,'irixi:coworker');assert.equal(events[0].detail.role,'writer');assert.equal(p.localAction,'sleep-to-idle');assert.equal(p.sleepIndicator.visible,false);
  const generation=p.actionGeneration;for(let i=0;i<20;i++)scene.setTask(task(),{engagedRole:'writer'});assert.equal(p.actionGeneration,generation,'conversation polls do not restart awake animation');
  scene.setTask(task());finish(p);assert.equal(p.localAction,'sleeping');
});
test('R04 stopping or unknown during sleep entry invalidates old completion; the status never becomes a sleeper',()=>{
  for(const status of ['stopping','stopped','unknown','queued','waiting_user','failed']) {const {scene}=fixture();scene.setTask(task());const p=scene.people.get('writer'),stale=p.transitionListener?.callback;scene.setTask(task('writer',status));stale?.();scene.syncSleepingIndicator(p);assert.notEqual(p.localAction,'sleeping',status);assert.equal(p.localEligible,false);assert.equal(p.sleepIndicator?.visible??false,false);}
});

test('R03 Z only rises during its visible cycle and resets while fully transparent',()=>{
  const {scene}=fixture();scene.setTask(task());const p=scene.people.get('writer');finish(p);
  const points=[0,120,360,720,1440,1800,1920,2280,2399,2400].map(time=>{scene.syncSleepingIndicator(p,time);return {time,y:p.sleepIndicator.y,alpha:p.sleepIndicator.alpha};});
  for(let i=1;i<points.length-1;i++)assert.ok(points[i].y<=points[i-1].y,'one-way rise before transparent reset');
  for(const time of [0,1920,2280,2399,2400])assert.equal(points.find(p=>p.time===time).alpha,0,`transparent at ${time}`);
  assert.ok(points.find(p=>p.time===360).alpha>0);assert.ok(points.find(p=>p.time===1800).alpha<points.find(p=>p.time===1440).alpha);
});

test('R03 each Z follows the current sleeping head transform instead of a shared canvas-height ratio',()=>{
  const {scene}=fixture({reduced:true});scene.setTask(task());
  const crowns={researcher:[128,82],writer:[88,34],reviewer:[153,101],archivist:[138,82]};
  for(const p of scene.people.values()){scene.syncSleepingIndicator(p,0);const x=p.sleepIndicator.x,y=p.sleepIndicator.y;const c=scene.coworkerContracts[p.role],spec=coworkerAnimationSpec(c,p.role,'sleeping'),{scale,offset}=coworkerRenderTransform(c,spec.anchor,'sleeping'),head=spec.animation.sleepIndicatorAnchor||crowns[p.role];assert.equal(x,p.sprite.x+offset[0]+(head[0]-spec.anchor[0])*scale+10);assert.equal(y,p.sprite.y+offset[1]+(head[1]-spec.anchor[1])*scale-4);p.sprite.x+=37;p.sprite.y+=21;scene.syncSleepingIndicator(p,0);assert.equal(p.sleepIndicator.x,x+37);assert.equal(p.sleepIndicator.y,y+21);}
});

test('desk sleep Z honors per-state local head pixels with placement scale, offset and sprite movement; missing metadata keeps old anchors',()=>{
  const {scene}=fixture({reduced:true});
  for(const [i,p] of [...scene.people.values()].entries()) {
    const c=scene.coworkerContracts[p.role],original=c.animations.sleeping;
    // Keep the pack's transition references valid while varying only its head registration.
    const transitions=Object.fromEntries(['enter-sleeping','exit-sleeping','enter-working','exit-working'].map(name=>[name,c.animations[name]]));
    bindQualityStates(c,{id:'synthetic-head-anchor',frameSize:original.frameSize,anchor:original.anchor,states:{...transitions,sleeping:{...original,sleepIndicatorAnchor:[61+i*19,92+i*7],placement:{scale:.41+i*.13,registrationPoint:[44,88],worldPoint:[390+i*27,511+i*17]}}}});
    const sleep=c.animations.sleeping;
    scene.setTask(task(),{reducedMotion:true});scene.syncSleepingIndicator(p,0);
    const {scale,offset}=coworkerRenderTransform(c,sleep.anchor,'sleeping');
    const expected=[p.sprite.x+offset[0]+(sleep.sleepIndicatorAnchor[0]-sleep.anchor[0])*scale+10,p.sprite.y+offset[1]+(sleep.sleepIndicatorAnchor[1]-sleep.anchor[1])*scale-4];
    assert.deepEqual([p.sleepIndicator.x,p.sleepIndicator.y],expected);
    p.sprite.x+=23;p.sprite.y-=17;scene.syncSleepingIndicator(p,8000);
    assert.deepEqual([p.sleepIndicator.x,p.sleepIndicator.y],[expected[0]+23,expected[1]-17]);
    assert.equal(p.sleepIndicator.alpha,.75);
  }
});

function settle(scene,p) {
  for(let i=0;i<8&&(p.transitionListener||p.pendingAction);i++) {
    finish(p);
    const a=scene.coworkerContracts[p.role].animations[p.localAction];
    p.body.anims.currentFrame.textureFrame=a.safeSwitchFrameIndices?.[0]??a.frameIndices[0];
    scene.updateCoworkerTransitions();
  }
}

test('desk sleep reverses shared pose IDs at every entry frame for conversation, work, stop and unknown; stale completions never override intent',()=>{
  for(const role of roles)for(const frame of [7,2,11,5])for(const intent of ['conversation','working','stopping','unknown','disconnected']) {
    const {scene}=fixture({reversible:true});scene.setTask(task());const p=scene.people.get(role);
    const obsolete=p.transitionListener.callback;p.body.anims.currentFrame.textureFrame=frame;
    const next=intent==='conversation'?task():intent==='disconnected'?{...task(),disconnected:true}:task(role,intent);
    const presence=intent==='conversation'?{engagedRole:role}:{};
    scene.setTask(next,presence);
    assert.equal(p.localAction,'sleep-to-idle',`${role}/${frame}/${intent}`);
    assert.deepEqual(p.body.animation,{key:`${role}-sleep-to-idle`,startFrame:[5,11,2,7].indexOf(frame)});
    assert.equal(p.desiredAction,intent==='working'?'working':'idle');
    const generation=p.actionGeneration,listener=p.transitionListener;
    obsolete();assert.equal(p.actionGeneration,generation);assert.equal(p.transitionListener,listener);assert.equal(p.localAction,'sleep-to-idle');
    for(let i=0;i<10;i++)scene.setTask(next,presence);
    assert.equal(p.actionGeneration,generation);assert.equal(p.callbacks.size,1);
    settle(scene,p);assert.equal(p.localAction,intent==='working'?'working':'idle');
    assert.equal(p.transitionListener,null);assert.equal(p.sleepIndicator?.visible??false,false);
  }
});

test('desk sleep clicks dispatch before animation and walking, repeated clicks do not restart; close reverses current wake pose and work wins',()=>{
  const {scene}=fixture({reversible:true});scene.setTask(task());const p=scene.people.get('writer');finish(p);scene.syncSleepingIndicator(p,360);
  const events=[];window.dispatchEvent=event=>events.push({event,action:p.localAction});
  scene.nearestWalkable=()=>({x:4,y:4});scene.playerCell={x:0,y:0};scene.startPath=()=>new Promise(()=>{});
  scene.talkTo(p);assert.equal(events[0].event.type,'irixi:coworker');assert.equal(events[0].event.detail.role,'writer');assert.equal(events[0].action,'sleeping');
  assert.equal(p.localAction,'sleep-to-idle');assert.equal(p.sleepIndicator.visible,false);
  const generation=p.actionGeneration,obsolete=p.transitionListener.callback;
  for(let i=0;i<6;i++)scene.talkTo(p);assert.equal(p.actionGeneration,generation);assert.equal(p.callbacks.size,1);
  p.body.anims.currentFrame.textureFrame=11;scene.setTask(task());
  assert.equal(p.localAction,'idle-to-sleep');assert.deepEqual(p.body.animation,{key:'writer-idle-to-sleep',startFrame:2});
  obsolete();assert.equal(p.localAction,'idle-to-sleep');finish(p);assert.equal(p.localAction,'sleeping');
  scene.setTask(task('writer','working'),{engagedRole:'writer'});assert.equal(p.desiredAction,'working');settle(scene,p);assert.equal(p.localAction,'working');
  scene.setTask(task('writer','working'));assert.equal(p.localAction,'working');
});

test('desk sleep reduced motion at startup and during either transition stops Canvas animation at the final requested state',()=>{
  for(const initialReduced of [true,false])for(const awake of [true,false]) {
    const {scene}=fixture({reversible:true,reduced:initialReduced});scene.setTask(task());const p=scene.people.get('writer');
    if(!initialReduced&&awake){finish(p);scene.setTask(task(),{engagedRole:'writer'});assert.equal(p.localAction,'sleep-to-idle');}
    const obsolete=p.transitionListener?.callback;
    scene.setTask(task(),{reducedMotion:true,...(awake?{engagedRole:'writer'}:{})});
    assert.equal(p.localAction,awake?'idle':'sleeping');assert.equal(p.body.texture.key,`coworker-writer-v8-${awake?'idle':'sleeping'}`);
    assert.equal(p.transitionListener??null,null);assert.ok(p.body.stops>0,'Canvas sprite stop was called');const generation=p.actionGeneration;obsolete?.();assert.equal(p.actionGeneration,generation);assert.equal(p.localAction,awake?'idle':'sleeping');
    scene.syncSleepingIndicator(p,0);const y=p.sleepIndicator?.y;scene.syncSleepingIndicator(p,4000);assert.equal(p.sleepIndicator?.y,y);
  }
});

test('desk sleep latest work/stop/unknown wins during wake; returning to sleep invalidates the old wake and can reverse again',()=>{
  for(const status of ['working','stopping','stopped','unknown','waiting_user','queued','failed']) {
    const {scene}=fixture({reversible:true});scene.setTask(task());const p=scene.people.get('writer');finish(p);
    scene.setTask(task(),{engagedRole:'writer'});const oldWake=p.transitionListener.callback;
    p.body.anims.currentFrame.textureFrame=2;scene.setTask(task());assert.equal(p.localAction,'idle-to-sleep');
    const oldEntry=p.transitionListener.callback;
    scene.setTask(task('writer',status));assert.equal(p.localAction,'sleep-to-idle');
    assert.deepEqual(p.body.animation,{key:'writer-sleep-to-idle',startFrame:2});
    const current=p.transitionListener,generation=p.actionGeneration;
    oldWake();oldEntry();assert.equal(p.transitionListener,current);assert.equal(p.actionGeneration,generation);
    assert.equal(p.desiredAction,status==='working'?'working':'idle');
    // A later status can replace the queued work without restarting the current lift.
    if(status==='working'){scene.setTask(task('writer','stopping'));assert.equal(p.actionGeneration,generation);}
    for(let i=0;i<5;i++)scene.setTask(task('writer',status==='working'?'stopping':status));
    settle(scene,p);assert.equal(p.localAction,'idle');assert.equal(p.desiredAction,'idle');assert.equal(p.pendingAction,null);
    oldWake();oldEntry();assert.equal(p.localAction,'idle');
  }
});

// Exercise user/status inputs through the normal mapping, never by assigning a target pose.
function interrupt(scene,p,event) {
  if(event==='click') {scene.talkTo(p);return;}
  scene.setTask(event==='close'?task():event==='disconnected'?{...task(),disconnected:true}:task(p.role,event));
}
function checkBothDirections(options,selectedRoles=roles) {
  let cases=0;
  const sample=fixture(options);
  for(const role of selectedRoles)for(const direction of ['idle-to-sleep','sleep-to-idle']) {
    const frames=sample.scene.coworkerContracts[role].animations[direction].frameIndices;
    for(const [position,frame] of frames.entries())for(const event of ['working','stopping','click','close','unknown','disconnected']) {
      const {scene}=fixture(options);scene.setTask(task());const p=scene.people.get(role);
      if(direction==='sleep-to-idle'){finish(p);scene.setTask(task(),{engagedRole:role});}
      assert.equal(p.localAction,direction);
      const old=p.transitionListener.callback,oldGeneration=p.actionGeneration;
      p.body.anims.currentFrame={textureFrame:frame,index:position+1};
      const events=[];window.dispatchEvent=e=>events.push(e);
      scene.nearestWalkable=()=>({x:4,y:4});scene.playerCell={x:0,y:0};scene.startPath=()=>new Promise(()=>{});
      interrupt(scene,p,event);
      const label=`${role}/${direction}/${frame}/${event}`;
      const final=event==='working'?'working':event==='close'?'sleeping':'idle';
      assert.equal(p.desiredAction,final,label);
      if(event==='click'){assert.equal(events[0].type,'irixi:coworker',label);assert.equal(events[0].detail.role,role,label);}
      if(p.localAction!==direction) {
        const started=scene.coworkerContracts[role].animations[p.localAction].frameIndices[p.body.animation.startFrame];
        assert.equal(started,frame,`${label}: reversal preserves the currently displayed pose ID`);
      }
      const generation=p.actionGeneration,listener=p.transitionListener;
      if(generation!==oldGeneration){old();assert.equal(p.actionGeneration,generation,label);assert.equal(p.transitionListener,listener,label);}
      for(let i=0;i<3;i++)interrupt(scene,p,event);
      assert.equal(p.actionGeneration,generation,`${label}: repeated input does not replay`);
      assert.equal(p.callbacks.size,1,label);
      settle(scene,p);assert.equal(p.localAction,final,label);assert.equal(p.desiredAction,final,label);
      assert.equal(p.pendingAction,null,label);assert.equal(p.transitionListener,null,label);
      const settledGeneration=p.actionGeneration;
      old();assert.equal(p.localAction,final,`${label}: retired callback cannot override settled state`);assert.equal(p.actionGeneration,settledGeneration,label);
      cases++;
    }
  }
  return cases;
}

test('desk sleep every declared pose of all four roles accepts work, stop, click, close, unknown and disconnect in both directions',()=>{
  assert.equal(checkBothDirections({reversible:true}),192);
});

const actualPack=process.env.IRIXI_DESK_SLEEP_PACK;
const actualRoles=process.env.IRIXI_DESK_SLEEP_ROLES?.split(',')||roles;
test('desk sleep actual supplied pack binds selected roles and passes every declared transition pose', {skip:actualPack?false:'New art not supplied; synthetic results do not verify actual assets'},()=>{
  const pack=pathToFileURL(`${actualPack.replace(/\/$/,'')}/`),index=JSON.parse(readFileSync(new URL('manifest.json',pack),'utf8'));
  let expectedCases=0;
  for(const role of actualRoles) {
    const file=new URL(index.roles[role].manifest,pack),manifest=JSON.parse(readFileSync(file,'utf8'));
    const {scene}=fixture({pack}),c=scene.coworkerContracts[role];
    const enter=c.animations['idle-to-sleep'],exit=c.animations['sleep-to-idle'],sleep=c.animations.sleeping;
    assert.equal(enter.reverseOf,'sleep-to-idle',role);assert.equal(exit.reverseOf,'idle-to-sleep',role);
    assert.deepEqual(exit.frameIndices,[...enter.frameIndices].reverse(),role);
    assert.deepEqual(enter.frameSize,exit.frameSize,role);assert.deepEqual(enter.anchor,exit.anchor,role);
    assert.deepEqual(enter.placement,exit.placement,role);
    for(const a of [enter,exit]){assert.equal(a.frameDurationsMs.length,a.frameIndices.length,role);assert.ok(a.frameDurationsMs.every(ms=>Number.isFinite(ms)&&ms>0),role);}
    assert.ok(sleep.sleepIndicatorAnchor?.length===2&&sleep.sleepIndicatorAnchor.every(Number.isFinite),`${role}: actual head anchor`);
    const forward=manifest.states['enter-sleeping'],reverse=manifest.states['exit-sleeping'];
    assert.equal(new URL(forward.spritesheet,file).href,new URL(reverse.spritesheet,file).href,`${role}: same atlas, not assumed visual equivalence`);
    assert.equal(forward.frontSpritesheet??null,reverse.frontSpritesheet??null,`${role}: same foreground atlas`);
    for(const state of Object.values(manifest.states))for(const field of ['spritesheet','frontSpritesheet'])if(state[field]){
      const png=readFileSync(new URL(state[field],file));assert.deepEqual([...png.subarray(0,8)],[137,80,78,71,13,10,26,10],`${role}/${field}: real PNG present`);
    }
    expectedCases+=(enter.frameIndices.length+exit.frameIndices.length)*6;
  }
  assert.equal(checkBothDirections({pack},actualRoles),expectedCases);
});

test('Phaser actual AnimationState uses one-based sequence positions and loads zero-based startFrame despite repeated atlas IDs',()=>{
  const require=createRequire(import.meta.url),Animation=require('phaser/src/animations/Animation'),AnimationState=require('phaser/src/animations/AnimationState');
  const manager={textureManager:{getFrame(key,frame){return {name:frame};}},on(){},get(){return animation;}};
  const animation=new Animation(manager,'sleep',{frames:[3,4,3].map(frame=>({key:'atlas',frame})),frameRate:1});
  const state=new AnimationState({scene:{sys:{anims:manager}}});
  for(const [position,textureFrame] of [3,4,3].entries()){
    state.load({key:'sleep',startFrame:position});assert.equal(state.currentFrame.index,position+1);assert.equal(state.currentFrame.textureFrame,textureFrame);
  }
});

test('explicit start mappings reject unknown actions, wrong lengths, fractions and out-of-range targets at bind time',()=>{
  const stable={frameIndices:[8,9],frameDurationsMs:[100,100],staticFrameIndex:8,loop:true};
  for(const mapping of [null,[],{missing:[0,1]},{idle:[0]},{idle:[0,2]},{idle:[0,.5]},{idle:[0,-1]}]){
    assert.throws(()=>bindQualityStates({role:'writer',revision:'mapping-validation',animations:{}},{id:'invalid',frameSize:[10,10],anchor:[5,9],states:{idle:{...stable},'enter-sleeping':{...stable,startFrameByAction:mapping}}}),/Invalid start-frame mapping/);
  }
});

test('actual supplied sleep cycle starts waking from the exact current body/front pose, without delaying the conversation', {skip:actualPack?false:'Actual asset pack not supplied'},()=>{
  const pack=pathToFileURL(`${actualPack.replace(/\/$/,'')}/`);
  for(const role of actualRoles){
    const sample=fixture({pack}),frames=sample.scene.coworkerContracts[role].animations.sleeping.frameIndices;
    for(const [position,frame] of frames.entries())for(const event of ['click','working','stopping','unknown','disconnected']){
      const {scene}=fixture({pack});scene.setTask(task());const p=scene.people.get(role);finish(p);
      p.body.anims.currentFrame={textureFrame:frame,index:position+1};p.body.frame.name=frame;
      const dispatched=[];window.dispatchEvent=e=>dispatched.push(e);scene.nearestWalkable=()=>({x:4,y:4});scene.playerCell={x:0,y:0};scene.startPath=()=>new Promise(()=>{});
      interrupt(scene,p,event);assert.equal(p.localAction,'sleep-to-idle');
      if(event==='click')assert.equal(dispatched[0].type,'irixi:coworker');
      const exit=scene.coworkerContracts[role].animations['sleep-to-idle'],start=typeof p.body.animation==='object'?p.body.animation.startFrame:0;
      assert.equal(exit.frameIndices[start],frame,`${role}/sleep[${position}]=${frame}/${event}: atlas pose preserved at wake entry`);
      assert.ok(exit.frameIndices.slice(start).includes(exit.frameIndices.at(-1)),'wake continues to its authored upright endpoint');
    }
  }
});

test('actual supplied mapped wake also works immediately when reduced motion is disabled from a static sleeper', {skip:actualPack?false:'Actual asset pack not supplied'},()=>{
  const pack=pathToFileURL(`${actualPack.replace(/\/$/,'')}/`);
  for(const role of actualRoles){
    const {scene}=fixture({pack,reduced:true});scene.setTask(task());const p=scene.people.get(role);
    assert.equal(p.localAction,'sleeping');
    scene.motionPreference.matches=false;scene.setTask(task(),{engagedRole:role,reducedMotion:false});
    assert.equal(p.localAction,'sleep-to-idle');assert.equal(p.desiredAction,'idle');
    const exit=scene.coworkerContracts[role].animations['sleep-to-idle'],start=typeof p.body.animation==='object'?p.body.animation.startFrame:0;
    assert.equal(exit.frameIndices[start],scene.coworkerContracts[role].animations.sleeping.staticFrameIndex);
  }
});
