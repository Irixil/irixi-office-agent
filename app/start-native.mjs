#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CURRENT_MACHINE_NATIVE_ROOT =
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../native/upstream-mac-trial-20261004/integration-slice-20261004');
const PRODUCT_ENTRY_RELATIVE_PATH = path.join('product', 'start-product-entry.mjs');
const here = path.dirname(fileURLToPath(import.meta.url));

export function parseStartNativeArgs(argv = [], env = process.env) {
  let cliNativeRoot = null;
  let enableAi = false;
  let zeroModel = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--native-root') {
      assert.equal(cliNativeRoot, null, '--native-root may be supplied only once');
      cliNativeRoot = argv[index + 1] ?? null;
      assert.ok(cliNativeRoot && !cliNativeRoot.startsWith('--'), '--native-root requires a path');
      index += 1;
    } else if (argument === '--enable-ai') {
      enableAi = true;
    } else if (argument === '--zero-model') {
      zeroModel = true;
    } else {
      throw new Error(`Unsupported native-start argument: ${argument}`);
    }
  }

  assert.equal(enableAi && zeroModel, false, '--enable-ai and --zero-model are mutually exclusive');
  const nativeRoot = cliNativeRoot || env.IRIXI_NATIVE_ROOT || CURRENT_MACHINE_NATIVE_ROOT;
  assert.ok(path.isAbsolute(nativeRoot), 'Native root override must be an absolute path');
  return {
    aiEnabled: zeroModel ? false : true,
    modeFlag: zeroModel ? '--zero-model' : '--enable-ai',
    nativeRoot,
  };
}

async function canonicalDirectory(input, label) {
  const details = await fsp.lstat(input);
  assert.equal(details.isDirectory(), true, `${label} must be a directory`);
  assert.equal(details.isSymbolicLink(), false, `${label} must not be a symbolic link`);
  const canonical = await fsp.realpath(input);
  assert.equal(canonical, input, `${label} must be an absolute canonical path`);
  return canonical;
}

async function canonicalRegularFile(input, label) {
  const details = await fsp.lstat(input);
  assert.equal(details.isFile(), true, `${label} must be a regular file`);
  assert.equal(details.isSymbolicLink(), false, `${label} must not be a symbolic link`);
  const canonical = await fsp.realpath(input);
  assert.equal(canonical, input, `${label} must be an absolute canonical path`);
  return canonical;
}

export function buildProductEntryArgs({ productEntry, tasksRoot, desktopRoot, modeFlag }) {
  return [
    productEntry,
    '--tasks-root', tasksRoot,
    '--desktop-root', desktopRoot,
    modeFlag,
  ];
}

export async function resolveNativeStart(argv = process.argv.slice(2), env = process.env) {
  const parsed = parseStartNativeArgs(argv, env);
  const desktopRoot = await canonicalDirectory(path.resolve(here, '..'), 'Desktop root');
  const tasksRoot = await canonicalDirectory(path.join(desktopRoot, 'data', 'tasks'), 'Desktop tasks root');
  const nativeRoot = await canonicalDirectory(parsed.nativeRoot, 'Native integration root');
  const productEntry = await canonicalRegularFile(
    path.join(nativeRoot, PRODUCT_ENTRY_RELATIVE_PATH),
    'Native product entry',
  );
  assert.equal(
    path.relative(nativeRoot, productEntry),
    PRODUCT_ENTRY_RELATIVE_PATH,
    'Native product entry must remain inside the selected integration root',
  );
  return {
    ...parsed,
    desktopRoot,
    tasksRoot,
    nativeRoot,
    productEntry,
    childArgs: buildProductEntryArgs({
      productEntry,
      tasksRoot,
      desktopRoot,
      modeFlag: parsed.modeFlag,
    }),
  };
}

export async function runNativeStart(argv = process.argv.slice(2), env = process.env) {
  const resolved = await resolveNativeStart(argv, env);
  const child = spawn(process.execPath, resolved.childArgs, {
    cwd: resolved.nativeRoot,
    env,
    stdio: 'inherit',
  });

  const signalHandlers = new Map();
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const handler = () => {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    };
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }

  try {
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    if (result.signal) {
      throw Object.assign(new Error(`Native product entry exited from ${result.signal}`), {
        code: 'NATIVE_ENTRY_SIGNAL',
        signal: result.signal,
      });
    }
    process.exitCode = result.code ?? 1;
  } finally {
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
  }
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  runNativeStart().catch((error) => {
    console.error(`[DesktopNativeEntry] ${error instanceof Error ? error.stack || error.message : String(error)}`);
    process.exitCode = 1;
  });
}
