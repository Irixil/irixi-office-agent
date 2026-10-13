import { historicalBindings } from '../../../../authority/historical-bindings.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';

export const NATIVE_TRIAL_BINDING = historicalBindings.nativeDevelopment;

export const STATE_ROOT = path.dirname(path.dirname(NATIVE_TRIAL_BINDING.ledgerFile));

export async function resolveDevelopmentBatchBinding(entry, expectedStateRoot = STATE_ROOT) {
  const stateRoot = path.resolve(expectedStateRoot);
  if (!entry || typeof entry.ledgerFile !== 'string') throw new Error('Missing development batch binding');
  const ledgerFile = path.resolve(entry.ledgerFile), batchRoot = path.dirname(ledgerFile), batchName = path.basename(batchRoot);
  const match = /^development-([0-9]{2,4})$/.exec(batchName);
  if (!match || Number(match[1]) < 1 || String(Number(match[1])).padStart(2, '0') !== match[1] || entry.ledgerFile !== ledgerFile || path.dirname(batchRoot) !== stateRoot || path.basename(ledgerFile) !== 'model-ledger.json') throw new Error('Development batch must use its own numbered project ledger');
  const ordinal = Number(match[1]);
  if (ordinal > 1 && (entry.batchId !== batchName || entry.batchOrdinal !== ordinal || typeof entry.executionId !== 'string' || !/^run-[A-Za-z0-9-]+$/.test(entry.executionId) || typeof entry.repairOfExecutionId !== 'string' || !/^run-[A-Za-z0-9-]+$/.test(entry.repairOfExecutionId) || entry.executionId === entry.repairOfExecutionId || ![entry.priorLedgerSha256, entry.repairInputManifestSha256, entry.scopeFingerprint].every(value => /^[a-f0-9]{64}$/.test(value || '')))) throw new Error('Repair batch requires its explicit failed-execution and snapshot binding');
  for (const dir of [stateRoot, batchRoot]) {
    const stat = await fs.lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(dir) !== dir) throw new Error('Development batch directory is not the registered real directory');
  }
  try {
    const stat = await fs.lstat(ledgerFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || await fs.realpath(ledgerFile) !== ledgerFile) throw new Error('Development batch ledger is not a regular project file');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return Object.freeze({ ...NATIVE_TRIAL_BINDING, ledgerFile, batchId: batchName, batchOrdinal: ordinal, trialId: `irixi-article-learning-12-${batchName}-20261005` });
}
