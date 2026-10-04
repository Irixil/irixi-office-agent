import assert from 'node:assert/strict';
import test from 'node:test';

import { synchronizedUrl } from '../public/navigation-state.js';

test('新建或切换任务时用当前任务与视图替换旧深链接', () => {
  assert.equal(
    synchronizedUrl('http://127.0.0.1:3847/?task=task-old&view=review&source=desk#result', { taskId: 'task-new', view: 'desk' }),
    '/?task=task-new&view=desk&source=desk#result',
  );
});

test('无任务或非法视图不把旧值留在刷新地址中', () => {
  assert.equal(
    synchronizedUrl('http://127.0.0.1:3847/?task=task-old&view=review', { taskId: null, view: 'unknown' }),
    '/',
  );
});
