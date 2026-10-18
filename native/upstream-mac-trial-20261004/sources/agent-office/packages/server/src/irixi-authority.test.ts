import assert from 'node:assert/strict';
import test from 'node:test';
import { createIrixiAuthorityProjection } from './irixi-authority.ts';

test('Agent Office accepts an explicit isolated Authority port without weakening zero-model mode', () => {
    const previous = {
        url: process.env.AGENT_OFFICE_IRIXI_AUTHORITY_URL,
        task: process.env.AGENT_OFFICE_IRIXI_TASK_ID,
        zeroModel: process.env.AGENT_OFFICE_ZERO_MODEL,
    };
    try {
        process.env.AGENT_OFFICE_IRIXI_TASK_ID = 'task-isolated-port';
        process.env.AGENT_OFFICE_ZERO_MODEL = '1';
        process.env.AGENT_OFFICE_IRIXI_AUTHORITY_URL = 'http://127.0.0.1:31639/';
        assert.ok(createIrixiAuthorityProjection());

        for (const url of [
            'http://127.0.0.1/', 'http://127.0.0.1:80/', 'http://127.0.0.1:1023/',
            'http://127.0.0.1:65536/', 'https://127.0.0.1:31639/', 'http://localhost:31639/',
            'http://user@127.0.0.1:31639/', 'http://127.0.0.1:31639/path',
            'http://127.0.0.1:31639/?task=other', 'http://127.0.0.1:31639/#fragment',
        ]) {
            process.env.AGENT_OFFICE_IRIXI_AUTHORITY_URL = url;
            assert.throws(() => createIrixiAuthorityProjection(), /explicit HTTP loopback origin/);
        }

        process.env.AGENT_OFFICE_IRIXI_AUTHORITY_URL = 'http://127.0.0.1:31639/';
        process.env.AGENT_OFFICE_ZERO_MODEL = '0';
        assert.throws(() => createIrixiAuthorityProjection(), /zero-model mode/);
    } finally {
        if (previous.url === undefined) delete process.env.AGENT_OFFICE_IRIXI_AUTHORITY_URL;
        else process.env.AGENT_OFFICE_IRIXI_AUTHORITY_URL = previous.url;
        if (previous.task === undefined) delete process.env.AGENT_OFFICE_IRIXI_TASK_ID;
        else process.env.AGENT_OFFICE_IRIXI_TASK_ID = previous.task;
        if (previous.zeroModel === undefined) delete process.env.AGENT_OFFICE_ZERO_MODEL;
        else process.env.AGENT_OFFICE_ZERO_MODEL = previous.zeroModel;
    }
});
