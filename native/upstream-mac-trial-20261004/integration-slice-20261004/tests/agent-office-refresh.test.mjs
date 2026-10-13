import assert from 'node:assert/strict';
import test from 'node:test';

import { irixiProjectionRefreshKey } from '../../sources/agent-office/packages/server/dist/irixi-authority.js';

const base = {
    taskId: 'task-public-toy',
    title: 'Public toy',
    goalStatement: 'Update the registered function.',
    goalVersionId: 'goal-1',
    executionId: 'execution-1',
    artifactId: null,
    artifactVersion: null,
    candidateSha256: null,
    diffSha256: null,
    status: 'in_progress',
    statusLabel: '正在修改',
    nextStep: '等待固定检查',
    actor: 'developer',
    scopeOutcome: null,
    confirmed: false,
    current: true,
    authoritySha256: 'a'.repeat(64),
    pipelineBindingSha256: 'b'.repeat(64),
};

test('Agent Office refresh key follows current progress but is stable for an identical snapshot', () => {
    const key = irixiProjectionRefreshKey(base);
    assert.equal(irixiProjectionRefreshKey({ ...base }), key);
    assert.notEqual(irixiProjectionRefreshKey({ ...base, status: 'candidate', actor: null }), key);
    assert.notEqual(irixiProjectionRefreshKey({ ...base, actor: 'reviewer' }), key);
    assert.notEqual(irixiProjectionRefreshKey({
        ...base,
        artifactId: 'artifact-1',
        artifactVersion: 1,
        candidateSha256: 'c'.repeat(64),
        diffSha256: 'd'.repeat(64),
    }), key);
});
