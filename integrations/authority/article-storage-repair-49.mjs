import fs from 'node:fs/promises';
import path from 'node:path';
import { canonical, sha256 } from './authority-core.mjs';

export const STORAGE_REPAIR49 = Object.freeze({
  goalVersionId:'goal-00000000-0000-4000-8000-000000000016',
  failedExecutionId:'run-00000000-0000-4000-8000-000000000006',
  batchId:'sample-batch-48',nextBatchId:'sample-batch-49',
  candidateSha256:'b8a3718d401a714df23e1f65b8dcf89e4f1b7b9777bd8a0104338fa7b1c0493a',
  ledgerSha256:'65803d6a4ec1874ef3952c857bc10aef0cde37ea04f23b7935829c9b206c565f',
  reviewerOutputSha256:'2f096eb0689b7271aed07adcc1cb584dae2ec950b286fb415c82a54f98c377c3',
  rootFile:'sample-batch-48-terminal-and-independent-storage-acceptance-sample-date.json',
  rootSha256:'c8a68b95f89447581c946409e0c5471e5f5ff5894a215bf61f09b92b17376ba5',
  independentFile:'sample48-logical-guard-counterexamples-preserved-for49-sample-date.json',
  independentSha256:'42a55b1670394ac09a100b73ccd96eca208e909155a9137dbf55a9ddfd098e8e',
  briefFile:'SAMPLE-LOGICAL-STORAGE-GUARDS-49-sample-date.md',
  briefSha256:'0cdb0c7231d8edf786ef5148557e693a750fadb2178c2536161519d890d3ebab',
  startupGateFile:'tools/sample49-storage-scope-gate-zero-model.mjs',
  startupGateSha256:'70d26d92a344eeaff6070986a941937103124b7f18e4a4bf4e7f1bb8c7f933db',
  gateCommand:'node tools/sample49-storage-scope-gate-zero-model.mjs --workspace "$WORKSPACE" --evidence /tmp/sample49-storage-scope-native-candidate.json',
  gateRequirements:'passed=true, nativeModelCalls=0, productApiCalls=0, businessSourceEditedByGate=false, and all readonly/scope checks passed; this gate alone is not business acceptance',
  scopeNote:'Only repair real decoded logical node/array guards before compression and after decoding. Keep lossless values, wire48KiB, identity/CAS and source scope. Prior48 logical bypass is the current failure; prior malformedJSON/Core/legacy issues are separate. The original second completed fixture exceeds2000 nodes and must honestly reject without corrupting saved state; it is not a positive logical-limit exception',
  errorLabel:'exact registered logical learning storage49',
  allowedChangedFiles:Object.freeze(['achievements.js']),
  storageInputOnly:true,
});

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
