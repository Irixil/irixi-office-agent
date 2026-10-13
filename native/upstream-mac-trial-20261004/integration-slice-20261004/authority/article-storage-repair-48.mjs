import { historicalBindings } from './historical-bindings.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { canonical, sha256 } from './authority-core.mjs';

export const STORAGE_REPAIR48 = historicalBindings.storageRepair48;

export function storage48InputBinding(){return {inputVersion:36,inputCandidateSha256:STORAGE_REPAIR48.candidateSha256,lastConfirmedVersion:28,allowedChangedFiles:[...STORAGE_REPAIR48.allowedChangedFiles],historicalReviewerRequirements:false};}

export async function storageRepair48ReviewBoundary(task,projectFile){
  const r=task?.execution?.repair,binding=r?.storageInputBinding;
  if(!binding)return null;
  const fail=message=>Object.assign(new Error(message),{status:409});
  if(task.goal?.activeVersionId!==STORAGE_REPAIR48.goalVersionId||r.batchId!==STORAGE_REPAIR48.nextBatchId||r.repairOfExecutionId!==STORAGE_REPAIR48.failedExecutionId
    ||r.priorLedgerSha256!==STORAGE_REPAIR48.ledgerSha256||r.repairBriefFile!==STORAGE_REPAIR48.briefFile||r.repairBriefSha256!==STORAGE_REPAIR48.briefSha256
    ||canonical(binding)!==canonical(storage48InputBinding()))throw fail('Storage48 effective scope binding is stale');
  const root=path.dirname(projectFile),file=path.join(root,'evidence',STORAGE_REPAIR48.briefFile),s=await fs.lstat(file);
  if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>48000||await fs.realpath(file)!==file)throw fail('Storage48 brief is not a canonical bounded file');
  const bytes=await fs.readFile(file);
  if(sha256(bytes)!==STORAGE_REPAIR48.briefSha256)throw fail('Storage48 effective brief changed');
  return `Current accepted scope for this exact48 candidate: only lossless learning save/restore/another submission under the registered brief below. Prior47 FAIL remains original history; its malformed JSON/Core/legacy-notice issues are separate known unmodified issues, not48 repair requirements or scoped rejection reasons. Only achievements.js storage/read/restore wiring may change; the original pure business/API prefix, app.js and every existing test are readonly. A scoped PASS is not full P0, real user learning, candidate confirmation or Personal Agent completion. Source input36 is rejected; confirmed28 remains distinct. Brief SHA-256 ${STORAGE_REPAIR48.briefSha256}:\n${bytes.toString('utf8')}`;
}
