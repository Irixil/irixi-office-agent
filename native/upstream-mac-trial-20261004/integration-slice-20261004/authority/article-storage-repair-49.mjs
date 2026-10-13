import { historicalBindings } from './historical-bindings.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { canonical, sha256 } from './authority-core.mjs';

export const STORAGE_REPAIR49 = historicalBindings.storageRepair49;

export function storage49InputBinding(){return {inputVersion:37,inputCandidateSha256:STORAGE_REPAIR49.candidateSha256,lastConfirmedVersion:28,allowedChangedFiles:[...STORAGE_REPAIR49.allowedChangedFiles],historicalReviewerRequirements:false};}

export async function storageRepair49ReviewBoundary(task,projectFile){
  const r=task?.execution?.repair,binding=r?.storageInputBinding;
  if(!binding||r.batchId!==STORAGE_REPAIR49.nextBatchId)return null;
  const fail=message=>Object.assign(new Error(message),{status:409});
  if(task.goal?.activeVersionId!==STORAGE_REPAIR49.goalVersionId||r.batchId!==STORAGE_REPAIR49.nextBatchId||r.repairOfExecutionId!==STORAGE_REPAIR49.failedExecutionId
    ||r.priorLedgerSha256!==STORAGE_REPAIR49.ledgerSha256||r.repairBriefFile!==STORAGE_REPAIR49.briefFile||r.repairBriefSha256!==STORAGE_REPAIR49.briefSha256
    ||canonical(binding)!==canonical(storage49InputBinding()))throw fail('Storage49 effective scope binding is stale');
  const root=path.dirname(projectFile),file=path.join(root,'evidence',STORAGE_REPAIR49.briefFile),s=await fs.lstat(file);
  if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>48000||await fs.realpath(file)!==file)throw fail('Storage49 brief is not a canonical bounded file');
  const bytes=await fs.readFile(file);
  if(sha256(bytes)!==STORAGE_REPAIR49.briefSha256)throw fail('Storage49 effective brief changed');
  return `Current accepted scope for this exact49 candidate: repair original logical graph2000/array200 guards before compression and after decoding, preserving wire48KiB, identity/CAS and complete histories. Prior48 FAIL is preserved; old malformedJSON/Core/legacy-notice issues are outside49. Only achievements.js storage/read/restore wiring may change; its pure business/API prefix and other source/tests remain readonly. Source37 is rejected; confirmed28 remains distinct. Original second completed fixture is2163 nodes and must not be waived into PASS. Scoped review PASS is not full positive-flow acceptance or confirmation. Trusted brief SHA-256 ${STORAGE_REPAIR49.briefSha256}:\n${bytes.toString('utf8')}`;
}
