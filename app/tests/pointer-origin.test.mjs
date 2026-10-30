import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

globalThis.Phaser = {
  Scene: class {}, Game: class {}, AUTO: 'AUTO',
  Scale: { RESIZE: 'RESIZE', CENTER_BOTH: 'CENTER_BOTH' },
};
globalThis.EasyStar = class {};
globalThis.document = { addEventListener() {} };
const { OfficeScene, createOfficeBridge } = await import('../public/office-game.js');

const source = readFileSync(new URL('../public/office-game.js', import.meta.url), 'utf8');

test('both real pointer registrations pass through the canvas-origin gate', () => {
  assert.match(source, /this\.registerCoworkerPointer\(sprite, officePerson\)/);
  assert.match(source, /this\.registerScenePointer\(\)/);
  assert.doesNotMatch(source, /sprite\.on\('pointerdown'/);
  assert.doesNotMatch(source, /this\.input\.on\('pointerdown'/);
});

test('callbacks actually registered on role and scene targets ignore DOM mousedown and accept mouse/touch canvas events', () => {
  const canvas = {}, expandButton = {}, touchButton = {};
  const scene = new OfficeScene();
  scene.game = { canvas };
  const callbacks = [];
  const makeTarget = () => ({ on(type, callback) { assert.equal(type, 'pointerdown'); callbacks.push(callback); } });
  const roleCalls = [], walkCalls = [];
  const person = { role: 'archivist' };
  scene.talkTo = (value) => roleCalls.push(value);
  scene.walkToPointer = (pointer) => walkCalls.push(pointer);
  scene.input = makeTarget();
  scene.registerCoworkerPointer(makeTarget(), person);
  scene.registerScenePointer();
  assert.equal(callbacks.length, 2);
  const domMouse = { type: 'mousedown', target: expandButton, defaultPrevented: false };
  const domTouch = { type: 'touchstart', target: touchButton, defaultPrevented: false };
  for (const event of [domMouse, domTouch]) {
    for (const callback of callbacks) callback({ event }, []);
    assert.equal(event.defaultPrevented, false, 'the gate does not cancel DOM input');
  }
  assert.deepEqual([roleCalls.length, walkCalls.length], [0, 0]);
  const canvasMouse = { event: { type: 'mousedown', target: canvas } };
  const canvasTouch = { event: { type: 'touchstart', target: canvas } };
  for (const pointer of [canvasMouse, canvasTouch]) for (const callback of callbacks) callback(pointer, []);
  assert.deepEqual(roleCalls, [person, person]);
  assert.deepEqual(walkCalls, [canvasMouse, canvasTouch]);
  callbacks[1](canvasMouse, [{}]);
  assert.equal(walkCalls.length, 2, 'a role hit does not also start walking');
});

test('keyboard and DOM role entry still calls talkToRole independently of the pointer gate', () => {
  const person = { role: 'archivist' }, calls = [];
  const bridge = createOfficeBridge({ people: new Map([['archivist', person]]), talkTo(value) { calls.push(value); } });
  bridge.talkToRole('archivist');
  assert.deepEqual(calls, [person]);
});
