#!/usr/bin/env node
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  assertPortAvailable,
  createOwnedChildSupervisor,
  runProductLauncher,
  waitForHttpReady,
} from './start-product.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const valueArg = (argv, name) => { const index = argv.indexOf(`--${name}`); return index < 0 ? null : argv[index + 1]; };
const hasFlag = (argv, name) => argv.includes(`--${name}`);

async function canonicalDirectory(input, name) {
  assert.ok(input && path.isAbsolute(input), `${name} must be an absolute path`);
  const real = await fsp.realpath(input);
  assert.equal(real, input, `${name} must be canonical`);
  return real;
}

function checkedPort(value) {
  const port = Number(value);
  assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535, '--desktop-port is invalid');
  return port;
}

function installSignals() {
  let rejectSignal;
  const promise = new Promise((_, reject) => { rejectSignal = reject; });
  promise.catch(() => {});
  const handlers = new Map();
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const handler = () => rejectSignal(Object.assign(new Error(`Product entry received ${signal}`), {
      code: 'LAUNCHER_SIGNAL',
      signal,
    }));
    handlers.set(signal, handler);
    process.once(signal, handler);
  }
  return { promise, dispose() { for (const [signal, handler] of handlers) process.removeListener(signal, handler); } };
}

export function desktopEntryReadyMode(value, expectedAiEnabled = null) {
  if (value?.ok !== true) return null;
  if (typeof expectedAiEnabled === 'boolean' && value.aiEnabled !== expectedAiEnabled) return null;
  return ['waiting_task', 'native_product_or_setup'].includes(value.mode) ? value.mode : null;
}

export function resolveDesktopEntryAiEnabled(argv) {
  const enableAi = hasFlag(argv, 'enable-ai');
  const explicitZeroModel = hasFlag(argv, 'zero-model');
  assert.equal(enableAi && explicitZeroModel, false, '--enable-ai and --zero-model are mutually exclusive');
  return enableAi;
}

export async function runProductEntry(argv = process.argv.slice(2)) {
  const taskId = valueArg(argv, 'task');
  const registry = valueArg(argv, 'registry');
  if (Boolean(taskId) !== Boolean(registry)) throw new Error('--task and --registry must be supplied together');
  if (taskId) return runProductLauncher(argv);

  assert.equal(hasFlag(argv, 'native-only') || hasFlag(argv, 'skip-desktop'), false, 'No-task setup must start the Desktop entry');
  const aiEnabled = resolveDesktopEntryAiEnabled(argv);
  const tasksRoot = await canonicalDirectory(valueArg(argv, 'tasks-root'), '--tasks-root');
  const desktopRoot = await canonicalDirectory(valueArg(argv, 'desktop-root'), '--desktop-root');
  const desktopAppRoot = await canonicalDirectory(path.join(desktopRoot, 'app'), 'Desktop app root');
  const port = checkedPort(valueArg(argv, 'desktop-port') || 3847);
  await assertPortAvailable(port);

  // The desktop child may itself own the native launcher, whose graceful stop
  // includes multiple detached service groups. Do not pre-empt that cleanup.
  const supervisor = createOwnedChildSupervisor({ termGraceMs: 20_000, killGraceMs: 5_000 });
  const signals = installSignals();
  const lifecycle = new AbortController();
  try {
    supervisor.start('Desktop native product setup', process.execPath, [path.join(here, 'desktop-product-server.mjs')], here, {
      IRIXI_DESKTOP_ROOT: desktopRoot,
      IRIXI_APP_ROOT: desktopAppRoot,
      IRIXI_DESKTOP_PORT: String(port),
      IRIXI_AUTHORITY_TASKS_ROOT: tasksRoot,
      IRIXI_PRODUCT_ENABLE_AI: aiEnabled ? '1' : '0',
      IRIXI_NATIVE_URL: `http://127.0.0.1:${Number(valueArg(argv, 'openoffice-port') || 9109)}/`,
    });
    const url = `http://127.0.0.1:${port}/`;
    const health = await Promise.race([
      waitForHttpReady(`${url}api/product-health`, {
        label: 'Desktop product setup',
        signal: lifecycle.signal,
        validate: (value) => desktopEntryReadyMode(value, aiEnabled) !== null,
      }),
      supervisor.fatal,
      signals.promise,
    ]);
    console.log(JSON.stringify({
      ok: true,
      mode: desktopEntryReadyMode(health, aiEnabled),
      aiEnabled,
      modelCalls: 0,
      services: { desktop: { ready: true, url } },
      readyServiceCount: 1,
      expectedReadyServiceCount: 1,
      allStartedServicesReady: true,
      desktop: `${url}?backend=openoffice`,
    }));
    await Promise.race([new Promise(() => {}), supervisor.fatal, signals.promise]);
  } catch (error) {
    if (error?.code === 'LAUNCHER_SIGNAL') process.exitCode = error.signal === 'SIGINT' ? 130 : 143;
    else throw error;
  } finally {
    lifecycle.abort(new Error('Product entry is stopping'));
    signals.dispose();
    await supervisor.stop();
  }
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  runProductEntry().catch((error) => {
    console.error(`[ProductEntry] startup failed: ${error instanceof Error ? error.stack || error.message : String(error)}`);
    process.exitCode = 1;
  });
}
