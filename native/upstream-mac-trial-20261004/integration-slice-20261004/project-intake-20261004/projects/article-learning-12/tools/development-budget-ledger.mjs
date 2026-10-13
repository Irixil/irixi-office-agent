import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const VERSION = 1;
const CAP = 2;
const WINDOW_MS = 20 * 60 * 1_000;
const ROLE_ORDER = Object.freeze(["developer", "reviewer"]);
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

async function writeAtomic(file, value) {
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temp, file);
}

async function readLedger(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}

function normalizedRoleOrder(roleOrder) {
  const value = roleOrder || ROLE_ORDER;
  if (JSON.stringify(value) !== JSON.stringify(ROLE_ORDER) && JSON.stringify(value) !== JSON.stringify(['reviewer'])) throw new Error('Invalid model-budget role order');
  return value;
}

function validateLedger(ledger, trialId, workspaceRealpath, roleOrder = null) {
  if (!ledger || ledger.version !== VERSION || ledger.cap !== CAP || ledger.windowMs !== WINDOW_MS) throw new Error('Invalid model-budget ledger');
  if (ledger.trialId !== trialId || ledger.workspaceRealpath !== workspaceRealpath) throw new Error('Model-budget ledger binding mismatch');
  const expected = normalizedRoleOrder(roleOrder || ledger.roleOrder);
  if (!Array.isArray(ledger.roleOrder) || JSON.stringify(ledger.roleOrder) !== JSON.stringify(expected)) throw new Error('Model-budget role order mismatch');
  if (!Array.isArray(ledger.calls) || ledger.calls.length > expected.length) throw new Error('Invalid model-budget call history');
}

async function withLedgerLock(ledgerFile, action) {
  const lockDir = `${ledgerFile}.lock`;
  await fs.mkdir(path.dirname(ledgerFile), { recursive: true });
  try { await fs.mkdir(lockDir, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Model-budget ledger is locked; concurrent or interrupted launch rejected'); throw error; }
  try { return await action(); }
  finally { await fs.rmdir(lockDir).catch(() => {}); }
}

function newLedger(trialId, workspaceRealpath, now, roleOrder = ROLE_ORDER) {
  return {
    version: VERSION,
    trialId,
    workspaceRealpath,
    cap: CAP,
    windowMs: WINDOW_MS,
    roleOrder: [...normalizedRoleOrder(roleOrder)],
    startedAt: new Date(now).toISOString(),
    deadlineAt: new Date(now + WINDOW_MS).toISOString(),
    calls: [],
  };
}

export async function reserveModelCall({ ledgerFile, trialId, workspaceRealpath, prompt, roleOrder = ROLE_ORDER, now = Date.now() }) {
  return withLedgerLock(ledgerFile, async () => {
    let ledger = await readLedger(ledgerFile);
    if (!ledger) ledger = newLedger(trialId, workspaceRealpath, now, roleOrder);
    else validateLedger(ledger, trialId, workspaceRealpath, roleOrder);
    if (ledger.sealed) throw new Error('Model batch is sealed after a host or transport failure');
    const deadlineMs = Date.parse(ledger.deadlineAt);
    if (!Number.isFinite(deadlineMs) || now >= deadlineMs) throw new Error('Two-call model window expired');
    if (ledger.calls.some((entry) => entry.status === 'reserved' || entry.status === 'running')) throw new Error('Another model launch is still active');
    if (ledger.calls.some((entry) => entry.status !== 'completed' || entry.exitCode !== 0 || entry.signal || entry.declaredStatus === 'failed')) throw new Error('A previous model call did not complete successfully; later launches are permanently blocked');
    if (ledger.calls.length >= ledger.roleOrder.length) throw new Error('Model role slots exhausted; additional launch rejected');
    const ordinal = ledger.calls.length + 1;
    const expectedRole = ledger.roleOrder[ordinal - 1];
    ledger.calls.push({
      ordinal,
      expectedRole,
      promptSha256: sha256(prompt),
      promptBytes: Buffer.byteLength(prompt),
      reservedAt: new Date(now).toISOString(),
      status: 'reserved',
    });
    await writeAtomic(ledgerFile, ledger);
    return { ordinal, expectedRole, deadlineAt: ledger.deadlineAt, remainingMs: deadlineMs - now };
  });
}

export async function updateModelCall({ ledgerFile, trialId, workspaceRealpath, ordinal, patch }) {
  return withLedgerLock(ledgerFile, async () => {
    const ledger = await readLedger(ledgerFile);
    validateLedger(ledger, trialId, workspaceRealpath);
    const call = ledger.calls.find((entry) => entry.ordinal === ordinal);
    if (!call) throw new Error('Reserved model call is missing');
    Object.assign(call, patch);
    await writeAtomic(ledgerFile, ledger);
    return structuredClone(ledger);
  });
}

export async function sealModelBudget({ ledgerFile, trialId, workspaceRealpath, reasonCode, now = Date.now() }) {
  if (!/^[a-z0-9_]{1,80}$/.test(reasonCode)) throw new Error('Invalid model-budget seal reason');
  return withLedgerLock(ledgerFile, async () => {
    let ledger = await readLedger(ledgerFile);
    if (!ledger) ledger = newLedger(trialId, workspaceRealpath, now);
    else validateLedger(ledger, trialId, workspaceRealpath);
    if (!ledger.sealed) ledger.sealed = { at: new Date(now).toISOString(), reasonCode };
    await writeAtomic(ledgerFile, ledger);
    return structuredClone(ledger);
  });
}

export const MODEL_BUDGET = Object.freeze({ version: VERSION, cap: CAP, windowMs: WINDOW_MS, roleOrder: ROLE_ORDER });
