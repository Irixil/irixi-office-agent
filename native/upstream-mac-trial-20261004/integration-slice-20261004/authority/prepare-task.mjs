#!/usr/bin/env node
import path from 'node:path';
import { createIntegrationController } from './task-controller.mjs';

const tasksRoot = process.env.IRIXI_AUTHORITY_TASKS_ROOT;
const irixiAppRoot = process.env.IRIXI_APP_ROOT;
const toyRoot = process.env.IRIXI_INTEGRATION_TOY_ROOT;
if (![tasksRoot, irixiAppRoot, toyRoot].every((value) => typeof value === 'string' && path.isAbsolute(value))) throw new Error('Absolute IRIXI_AUTHORITY_TASKS_ROOT, IRIXI_APP_ROOT and IRIXI_INTEGRATION_TOY_ROOT are required');
const controller = await createIntegrationController({ tasksRoot, irixiAppRoot, toyRoot });
const task = await controller.prepare();
process.stdout.write(`${JSON.stringify({ taskId: task.id, goalVersionId: task.goal.activeVersionId, executionId: task.execution.id, scopeFingerprint: task.projectWorkspace.scopeFingerprint, developerPromptSha256: task.integrationExecutionRequest.promptSha256 })}\n`);
