import fs from 'node:fs/promises';
import path from 'node:path';
import { canonical, sha256 } from './authority-core.mjs';

export const STORAGE_REPAIR48 = Object.freeze({
  goalVersionId:'goal-00000000-0000-4000-8000-000000000016',
  failedExecutionId:'run-00000000-0000-4000-8000-000000000008',
  batchId:'sample-batch-47',nextBatchId:'sample-batch-48',
  candidateSha256:'6d238e086e3791d25662265ee898aef12c63be2ffc9f87cecf92d610fadc7157',
  ledgerSha256:'e49f3d486ac044e13d281f501231a90c4cb523b37fa209ed9d4fb2dfd15ee0fb',
  reviewerOutputSha256:'694ee17181496f4c86e6fa72216891e5a7fadd4340f9d12bf0a68df18e9e4849',
  rootFile:'sample-batch-47-terminal-and-independent-root-result-sample-date.json',
  rootSha256:'79857ac14848af3941a0fa3e54286e7c22c1ef9d9260e4cf576f09dadf5a7b69',
  independentFile:'sample-batch-47-learning-save-limit-local-platform-diagnosis-zero-model-sample-date.json',
  independentSha256:'78715cc6eabdb31fde4c2402599e8e124514e88e7e8157fa425c98d528a31b17',
  briefFile:'SAMPLE-LOSSLESS-LEARNING-SAVE-RESTORE-48-sample-date.md',
  briefSha256:'9965738a0dbccc47a657ca361345be19569ec87c8e43b31da7ab2d45e3ba8621',
  startupGateFile:'tools/sample48-storage-scope-gate-zero-model.mjs',
  startupGateSha256:'1afeab9994bbb5bf6eec67b05b711ff95f8f1bfbb36a9d08f9ffe7060b9611ca',
  gateCommand:'node tools/sample48-storage-scope-gate-zero-model.mjs --workspace "$WORKSPACE" --evidence /tmp/sample48-storage-scope-native-candidate.json',
  gateRequirements:'passed=true, nativeModelCalls=0, productApiCalls=0, businessSourceEditedByGate=false, and all readonly/scope checks passed; this gate alone is not business acceptance',
  scopeNote:'This batch only repairs lossless storage and reopening of a legitimate retest containing the actual preserved old failure. Only achievements.js storage/read/restore wiring may change; its pure business/API prefix and every other file remain byte-identical. Current Developer/Reviewer requirements are solely the storage brief, not prior malformed JSON, Core-interface or legacy-notice verdicts. Keep the existing 48KiB/2000-node/200-item limits and identity/CAS guards, preserve every history value, and do not expand model-send scope. Independent Root background HTML acceptance must prove real save/reopen/another submission; offline compression is insufficient',
  errorLabel:'exact registered lossless learning storage48',
  allowedChangedFiles:Object.freeze(['achievements.js']),
  storageInputOnly:true,
});

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
