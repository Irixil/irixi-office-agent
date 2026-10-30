import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationStore } from './conversation-store.mjs';
import { colleagueWorkView, createWork } from './colleagues.mjs';
import { coworkerRuntimeState } from '../app/public/office-geometry.js';

const conversation = () => ({ id: 'conversation-local', title: '同一项工作', projectId: 'project-local',
  turns: [], messages: [], handoffRuns: [], artifactRuns: [], modelSelection: { model: 'test-only' }, work: createWork('writer') });
const helperWork = (c) => colleagueWorkView([c]).find((person) => person.id === 'researcher').works[0];

test('实际交接登记：排队接手不能盖过同一同事仍在执行的助手', async () => {
  const c = conversation();
  const parent = { id: 'parent', status: 'working', children: [{ id: 'assistant', colleagueId: 'researcher', status: 'working' }] };
  c.turns.push(parent);
  let releasePredecessor;
  const predecessor = new Promise((resolve) => { releasePredecessor = resolve; });
  const store = Object.create(ConversationStore.prototype);
  let modelCalls = 0;
  // Controlled persistence and predecessor boundary; actual handoff()/receiveHandoff()
  // register and await the predecessor. No model, service or user data is used.
  Object.assign(store, {
    conversation: () => c, admit: (fn) => fn(),
    commitFields: async (pairs) => { for (const [target, fields] of pairs) Object.assign(target, fields); },
    controllers: new Map(), jobs: new Map([[parent.id, predecessor]]),
    save: async () => {}, releaseHandoffInputs: async () => {},
    role: async () => { modelCalls += 1; throw new Error('此检查禁止调用模型'); },
  });
  const transfer = await store.handoff(c.id, { to: 'researcher', requestId: 'handoff-local', expectedOwnerRevision: 0 });
  const job = store.jobs.get(transfer.receiverId);
  try {
    assert.equal(c.handoffRuns[0].status, 'queued');
    assert.equal(parent.children[0].status, 'working');
    assert.equal(helperWork(c).status, 'working');
    const state = coworkerRuntimeState({ colleagues: colleagueWorkView([c]) }, 'researcher');
    assert.equal(state.active, true);
    assert.equal(state.status, 'working');
    assert.equal(state.localEligible, false);
  } finally {
    store.controllers.get(transfer.receiverId).abort();
    releasePredecessor();
    await job;
  }
  assert.equal(modelCalls, 0);
});

test('同一同事的停止、执行、理解和准备状态按实际优先级聚合，不按数组先后', () => {
  const c = conversation();
  const states = ['stopping', 'working', 'understanding', 'creating', 'queued', 'waiting'];
  for (let index = 0; index < states.length; index += 1) {
    for (const lower of states.slice(index + 1)) {
      for (const ordered of [[states[index], lower], [lower, states[index]]]) {
        c.turns = [{ status: 'working', children: ordered.map((status, i) => ({ id: `child-${i}`, colleagueId: 'researcher', status })) }];
        assert.equal(helperWork(c).status, states[index], JSON.stringify(ordered));
      }
    }
  }
});

test('没有活跃助手时保留最近结果；协助状态不改变负责人或整项工作是否结束', () => {
  const c = conversation();
  c.turns = [{ status: 'completed', children: [{ id: 'old', colleagueId: 'researcher', status: 'failed' }, { id: 'new', colleagueId: 'researcher', status: 'completed' }] }];
  assert.equal(helperWork(c).status, 'completed');
  assert.equal(helperWork(c).unfinished, true);
  c.work.lifecycle = 'completed';
  assert.equal(helperWork(c).unfinished, false);
  c.handoffRuns.push({ id: 'latest', colleagueId: 'researcher', status: 'interrupted' });
  assert.equal(helperWork(c).status, 'interrupted');
  assert.equal(c.work.ownerId, 'writer');
});
