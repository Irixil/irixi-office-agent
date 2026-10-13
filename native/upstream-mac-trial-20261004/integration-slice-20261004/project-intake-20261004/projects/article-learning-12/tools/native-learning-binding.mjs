import { historicalBindings } from '../../../../authority/historical-bindings.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';

export const NATIVE_TRIAL_BINDING = historicalBindings.nativeLearning;

export const STATE_ROOT = path.dirname(path.dirname(NATIVE_TRIAL_BINDING.ledgerFile));

export async function resolveLearningBatchBinding(entry) {
  if (!entry || typeof entry.ledgerFile !== 'string') throw new Error('Missing learning batch binding');
  const ledgerFile = path.resolve(entry.ledgerFile);
  const batchRoot = path.dirname(ledgerFile);
  const batchName = path.basename(batchRoot);
  const match = /^learning-([0-9]{2,4})$/.exec(batchName);
  if (!match || Number(match[1]) < 1 || String(Number(match[1])).padStart(2, '0') !== match[1] || entry.ledgerFile !== ledgerFile || path.dirname(batchRoot) !== STATE_ROOT || path.basename(ledgerFile) !== 'model-ledger.json') throw new Error('Learning batch must use its own numbered project ledger');
  for (const dir of [STATE_ROOT, batchRoot]) {
    const stat = await fs.lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(dir) !== dir) throw new Error('Learning batch directory is not the registered real directory');
  }
  try {
    const stat = await fs.lstat(ledgerFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || await fs.realpath(ledgerFile) !== ledgerFile) throw new Error('Learning batch ledger is not a regular project file');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return Object.freeze({ ...NATIVE_TRIAL_BINDING, ledgerFile, trialId: `irixi-article-learning-12-${batchName}-20261005` });
}
