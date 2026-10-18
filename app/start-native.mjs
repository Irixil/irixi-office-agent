#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CURRENT_MACHINE_NATIVE_ROOT =
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../native/upstream-mac-trial-20261004/integration-slice-20261004');
const PRODUCT_ENTRY_RELATIVE_PATH = path.join('product', 'start-product-entry.mjs');
const XERJ_BINARY_RELATIVE_PATH = path.join('.irixi-runtime', 'xerj-1.0.0-rc.95-aarch64-apple-darwin', 'xerj');
const XERJ_DATA_RELATIVE_PATH = path.join('.irixi-runtime', 'xerj-v1.0.0-rc.95', 'data');
const XERJ_URL = 'http://127.0.0.1:19200';
const here = path.dirname(fileURLToPath(import.meta.url));

async function privateAdminKey(dataDir) {
  try {
    const file = path.join(dataDir, 'admin.key');
    const stat = await fsp.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) return null;
    const key = (await fsp.readFile(file, 'utf8')).trim();
    return /^[a-f0-9]{64}$/i.test(key) ? key : null;
  } catch { return null; }
}

async function healthyXerj(url, key, fetchImpl) {
  if (!key) return false;
  try {
    const response = await fetchImpl(new URL('/_cluster/health', url), {
      headers: { authorization: `ApiKey ${key}`, accept: 'application/json' },
      signal: AbortSignal.timeout(900),
    });
    if (!response.ok) return false;
    const health = await response.json();
    return health?.cluster_name === 'xerj' && ['green', 'yellow'].includes(health.status)
      && Number.isInteger(health.number_of_nodes) && health.number_of_nodes > 0;
  } catch { return false; }
}

function portIsOccupied(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const finish = (occupied) => { socket.destroy(); resolve(occupied); };
    socket.setTimeout(500, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

function warnXerj(warn, reason) {
  warn(`[DesktopMemory] XERJ unavailable; Desktop will continue with local memory only (${reason}).`);
}

export async function ensureXerj({ desktopRoot, env = process.env, spawnImpl = spawn, fetchImpl = fetch, warn = console.warn,
  portOccupied = portIsOccupied } = {}) {
  if (env.IRIXI_XERJ_URL) return { child: null, reused: true, custom: true };
  const binaryPath = path.join(desktopRoot, XERJ_BINARY_RELATIVE_PATH);
  const dataDir = path.join(desktopRoot, XERJ_DATA_RELATIVE_PATH);
  try {
    await canonicalRegularFile(binaryPath, 'XERJ binary');
    await canonicalDirectory(dataDir, 'XERJ data directory');
  } catch (error) {
    warnXerj(warn, error instanceof Error ? error.message : 'installed runtime files are missing');
    return { child: null, reused: false, custom: false };
  }

  const adminKey = await privateAdminKey(dataDir);
  if (await healthyXerj(XERJ_URL, adminKey, fetchImpl)) return { child: null, reused: true, custom: false };
  if (await portOccupied(19200) || await portOccupied(19201) || await portOccupied(19202)) {
    warnXerj(warn, 'the default XERJ ports are occupied by an unverified service');
    return { child: null, reused: false, custom: false };
  }

  try {
    let warned = false;
    const warnOnce = (reason) => {
      if (!warned) { warned = true; warnXerj(warn, reason); }
    };
    const child = spawnImpl(binaryPath, ['--bind', '127.0.0.1', '--port', '19200', '--data-dir', dataDir, '--embed-mode', 'lexical'], {
      cwd: desktopRoot, env, stdio: 'ignore',
    });
    child.once('error', () => warnOnce('the installed XERJ process could not start'));
    child.once('exit', (code) => {
      if (code !== 0) warnOnce('the XERJ process exited before remaining available');
    });
    return { child, reused: false, custom: false };
  } catch (error) {
    warnXerj(warn, error instanceof Error ? error.message : 'the installed XERJ process could not start');
    return { child: null, reused: false, custom: false };
  }
}

export async function stopOwnedXerj(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = () => { if (!settled) { settled = true; if (timer) clearTimeout(timer); resolve(); } };
    child.once('exit', finish);
    timer = setTimeout(() => { child.kill('SIGKILL'); finish(); }, 3_000);
    child.kill('SIGTERM');
  });
}

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

export async function runNativeStart(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const resolved = await resolveNativeStart(argv, env);
  let xerj = { child: null };
  let child;
  let requestedSignal = null;

  const signalHandlers = new Map();
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const handler = () => {
      if (child && child.exitCode === null && child.signalCode === null) child.kill(signal);
      else requestedSignal = signal;
    };
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }

  try {
    try {
      xerj = await (deps.ensureXerj || ensureXerj)({ desktopRoot: resolved.desktopRoot, env, ...deps });
    } catch (error) {
      warnXerj(deps.warn || console.warn, error instanceof Error ? error.message : 'XERJ startup failed');
    }
    if (requestedSignal) throw Object.assign(new Error(`Native product entry interrupted by ${requestedSignal}`), {
      code: 'NATIVE_ENTRY_SIGNAL', signal: requestedSignal,
    });
    child = (deps.spawnImpl || spawn)(process.execPath, resolved.childArgs, {
      cwd: resolved.nativeRoot,
      env,
      stdio: 'inherit',
    });
    deps.onDesktopStart?.(child);
    if (requestedSignal && child.exitCode === null && child.signalCode === null) child.kill(requestedSignal);
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
    await (deps.stopOwnedXerj || stopOwnedXerj)(xerj?.child || null);
  }
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  runNativeStart().catch((error) => {
    console.error(`[DesktopNativeEntry] ${error instanceof Error ? error.stack || error.message : String(error)}`);
    process.exitCode = 1;
  });
}
