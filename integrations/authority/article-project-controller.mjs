import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { canonical, fingerprint, loadIrixiAuthorityHelpers, sha256 } from './authority-core.mjs';
import { ARTICLE_PROJECT_CAPACITY } from './article-project-capacity.mjs';
import { CLEAN_INPUT35, createCleanRepairInputManager } from './article-clean-repair-input.mjs';
import { STORAGE_REPAIR48, storage48InputBinding } from './article-storage-repair-48.mjs';
import { STORAGE_REPAIR49, storage49InputBinding } from './article-storage-repair-49.mjs';

const PROJECT_ID = 'sample-article-project';
const DEVELOPER_TAG = 'ARTICLE_LEARNING_DEVELOPER_12';
const SAFE_FILE = /^(?!\.)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/;
const ALLOWED_EXTENSIONS = new Set(['.html', '.css', '.js', '.json', '.txt', '.md', '.svg']);
const MAX_FILES = ARTICLE_PROJECT_CAPACITY.maxFiles;
const MAX_FILE_BYTES = 256 * 1024;
const EMPTY_SHA256 = sha256('');
// These are independently evidenced, explicitly authorized continuations, not a generic retry path.
const LEARNING_RESUME_PLATFORM_FAILURES = new Map([
  ['run-00000000-0000-4000-8000-000000000007', {
    batchId: 'sample-batch-36', nextBatchId: 'sample-batch-37',
    ledgerSha256: 'd0bbe5d772cec28d64bc312eac7e4bfe05a9ab41f9ebc32f151ac9e8350a27fc',
    reasonCode: 'host_registered_execution_unavailable_before_native',
    rootFile: 'sample-batch-36-root-result-sample-date.json', rootSha256: '1d592ebe14a8786a113f762efb6261dc8e7fd48f7ba31a11ce0ae19dabaa0220',
    independentFile: 'sample36-normal-registered-entry-independent-failure-review-zero-model-sample-date.json', independentSha256: '3cab16faf5f980e1d34679e387fa070ecf0501513f833b74f18c3ea8df10aba9',
    briefFile: 'SAMPLE-REPAIR-BRIEF-sample-date-R16.md', briefSha256: 'b028b5426d31d6f2f1e9e95a0cde76708546fc556300a688fd05a54056c786f2',
  }],
  ['run-00000000-0000-4000-8000-000000000026', {
    batchId: 'sample-batch-37', nextBatchId: 'sample-batch-38',
    ledgerSha256: '567f7fd828990af0561fe49d58b141076c6630e2dd90a31c589f2141ce75f384',
    reasonCode: 'host_developer_run_reservation_rejected_before_native',
    rootFile: 'sample-batch-37-root-result-sample-date.json', rootSha256: '4147016918769aa5e10bcb1ba636b8088d7fd8fb074f399327c349466c6a4b56',
    independentFile: 'sample37-normal-reservation-independent-terminal-stop-review-zero-model-sample-date.json', independentSha256: '0359c78cb5c3f58b2da1922d92ea944eca47681297ffe193f8f8acc420e9fa73',
    briefFile: 'SAMPLE-REPAIR-BRIEF-sample-date-R17.md', briefSha256: '111ba94b3be29f8fc03d75df1a9549ea892bb191ff6ce561cc6452d83a3973a6',
  }],
  ['run-00000000-0000-4000-8000-000000000019', {
    batchId: 'sample-batch-38', nextBatchId: 'sample-batch-39',
    ledgerSha256: '347a7e649b4c0e0234a6a865698dbc89d68506ddfd8b9ab470506c83bdfd5986', reasonCode: 'native_developer_report_invalid',
    expectedCalls: 1, expectedSignal: 'SIGKILL', expectedStdoutSha256: EMPTY_SHA256,
    rootFile: 'sample-batch-38-terminal-observation-root-result-sample-date.json', rootSha256: '1b57ecc77c69f3055b8ba0d0371160ebfbdb2ca92678daeec3a2d3134af43916',
    independentFile: 'sample38-unfinished-resume-root-cause-independent-zero-model-sample-date.json', independentSha256: '7aed52131a1a367e09ad2e077ecce2b6b65b66e325dd35f4ce4dad128aa7ae93',
    additionalEvidence: [
      ['sample-batch-38-post-timeout-diagnosis-root-result-sample-date.json', '81d625782d96438cad2e2871b528cbd25cdee4558bfc4945cad825d0cb9a514d'],
      ['sample38-post-timeout-cas-race-sidecar-zero-model-sample-date.json', '682b871fa21d2d492dd9aa9d367824d2b1d019275258444e971e991a7afa27d1'],
    ],
    allowedChangedFiles: ['achievements.js', 'app.js', 'index.html', 'p0-repair.js'],
    uiGateFile: 'tools/sample39-explicit-resume-ui-regression-zero-model-v2.mjs', uiGateSha256: 'ced820004cef65efd7a9f3af2105531b432e3d2e65e94aa61962657c542e1fa2',
    briefFile: 'SAMPLE-MINIMAL-RETEST-TASK-sample-date.md', briefSha256: '012e58105902e29c9344560015e4f08d69f0725a77a9ab453f6f5ac2bb2b9d08',
  }],
]);
const REVIEW_FAILURE_CONTINUATIONS = new Map([
  [STORAGE_REPAIR48.failedExecutionId,STORAGE_REPAIR48],
  [STORAGE_REPAIR49.failedExecutionId,STORAGE_REPAIR49],
  ['run-00000000-0000-4000-8000-000000000011', {
    batchId: 'sample-batch-39', nextBatchId: 'sample-batch-40', candidateSha256: '3f0187fe0256e1d5316d1e00c7e61b1e77587787cb5de3a59e8534cf012ea163',
    ledgerSha256: 'ad4135074108eb24cafd02394328658a72be9c10fcb403008cf0937430f3bf41', reviewerOutputSha256: 'abb89ccc70a9021eb6b77b3919fb7e1b3ad552156ab6ab35ffec2dcf2ad19a4d',
    rootFile: 'sample-batch-39-terminal-and-independent-root-result-sample-date.json', rootSha256: '987a76f678ea9da97f60a7a0fae6dd9cccbdc5b5def50d6c20c539d4b40a41e5',
    independentFile: 'sample-batch-39-independent-business-audit-zero-model-sample-date.json', independentSha256: '94769839ab3ebcef49348193a53472c066fe061935c3a3097e7ce756bd557cee',
    briefFile: 'SAMPLE-STARTUP-ORDER-REPAIR-TASK-sample-date.md', briefSha256: 'b01014fc80a57afc3fb0e8307c701f98525d0ab35b155b8998a5388374eba644',
    startupGateFile: 'tools/sample40-parser-visible-startup-gate-zero-model.mjs', startupGateSha256: '8c50cc5b31ed9a1cd51c34aaf386b461c757b294e19d20d17b3264f98a00c59d',
    startupGateProofFile: 'sample40-parser-visible-startup-gate-prepared-zero-model-sample-date.json', startupGateProofSha256: '00badd340d2747f8ca66d7872b7e9dd99d5219543e42ecb39381e5f9531d0b25',
    gateCommand: 'node tools/sample40-parser-visible-startup-gate-zero-model.mjs --workspace $WORKSPACE --mode candidate --evidence /tmp/sample40-parser-visible-startup-candidate.json',
    gateRequirements: 'passed=true, nativeModelCalls=0, networkCalls=0, browserLaunches=0, physicalInput=false, and candidate_parser_visible_startup_contract=true',
    scopeNote: 'This batch only repairs the registered startup ordering and DOM binding failure; preserve the already-reviewed pending continuation implementation',
    errorLabel: 'exact registered startup-order',
    allowedChangedFiles: ['achievements.js', 'app.js', 'index.html', 'p0-repair.js'],
  }],
  ['run-00000000-0000-4000-8000-000000000010', {
    batchId: 'sample-batch-40', nextBatchId: 'sample-batch-41', candidateSha256: '03af53da0667a68042673b06d46d8fac38ca4ae5b75cc2ea6f922df7335d0312',
    ledgerSha256: 'f53e20ca0183b1c12124d15a6c62f33f637f4c8fdbe4fcf0ba36d4264a93b92d', reviewerOutputSha256: '9b985f26fc808022c1ebf5dc43a985b1520fbfa84fac514df60029d75d8b9125',
    rootFile: 'sample-batch-40-terminal-and-independent-root-result-sample-date.json', rootSha256: 'c5274649336076f7f86c3bfbc2a83ba5d65d61fda0a938e6a715457a7eb3f540',
    independentFile: 'sample-batch-40-independent-business-audit-zero-model-sample-date.json', independentSha256: '466c5ec3d14fb3280ad6a5dd66115a5e00cc309c8fc255f4a7095e6cf3db4f4f',
    briefFile: 'SAMPLE-COMPLETED-RETEST-DISPOSITION-REPAIR-TASK-sample-date.md', briefSha256: '7aa4265c70ff29bf877d36ec8228a6084bbcab1b526e8d1466668603aa2afdf2',
    startupGateFile: 'tools/sample41-completed-retest-disposition-vm-gate-zero-model.mjs', startupGateSha256: '25d79a27ed27c325f60eede9ce522a7749c9293e92bcf943a4afcd0487c7bd39',
    startupGateProofFile: 'sample41-completed-retest-disposition-prepared-gate-zero-model-sample-date.json', startupGateProofSha256: '707dd10e3c327824b60e43670c7b6b24e1510cf1942f499e9594fb7920c906df',
    gateCommand: 'node tools/sample41-completed-retest-disposition-vm-gate-zero-model.mjs --workspace $WORKSPACE --mode candidate --evidence /tmp/sample41-completed-retest-disposition-vm-candidate.json',
    gateRequirements: "passed=true, sample41Mode='candidate', relationshipSelfcheckApplied=false, nativeModelCalls=0, productApiCalls=0, businessSourceEdited=false, and all six proof-listed requiredPassingCases=true",
    scopeNote: 'This batch only persists the exact completed-replacement disposition relationship while preserving the old failed turn byte-for-byte; independent terminal checking uses tools/sample41-completed-retest-disposition-headless-gate-zero-model.mjs SHA-256 5ebe8d980981bd854b67f4f7873f3afe7db9f34d1aa04a009ec479b0236024ec with prepared proof sample41-completed-retest-disposition-headless-prepared-gate-zero-model-sample-date.json SHA-256 9fc09e803324ebf0db17c08710fce433105bb7b2746606167ca528252ca833b4, and is not a reason to launch Chrome from the Native sandbox',
    errorLabel: 'exact registered completed-retest disposition',
    additionalBoundFiles: [
      { root: 'project', file: 'tools/sample40-parser-visible-startup-gate-zero-model.mjs', sha256: '8c50cc5b31ed9a1cd51c34aaf386b461c757b294e19d20d17b3264f98a00c59d' },
      { root: 'evidence', file: 'sample40-parser-visible-startup-gate-prepared-zero-model-sample-date.json', sha256: '00badd340d2747f8ca66d7872b7e9dd99d5219543e42ecb39381e5f9531d0b25' },
      { root: 'project', file: 'tools/sample40-headless-startup-workflow-gate-v2-zero-model.mjs', sha256: '7289bb7b771f7a1765cef3cd3e49e4cc5ca8f851b9c5b486b818427fdfa3bf84' },
      { root: 'evidence', file: 'sample40-headless-startup-workflow-gate-v2-amendment-zero-model-sample-date.json', sha256: 'd289fd98886f2308fa8836c4542a18fcf6570145fb976b627dd3bdbb1deb13dc' },
      { root: 'project', file: 'tools/sample41-completed-retest-disposition-headless-gate-zero-model.mjs', sha256: '5ebe8d980981bd854b67f4f7873f3afe7db9f34d1aa04a009ec479b0236024ec' },
      { root: 'evidence', file: 'sample41-completed-retest-disposition-headless-prepared-gate-zero-model-sample-date.json', sha256: '9fc09e803324ebf0db17c08710fce433105bb7b2746606167ca528252ca833b4' },
    ],
    allowedChangedFiles: ['achievements.js', 'app.js', 'index.html', 'p0-repair.js'],
  }],
  ['run-00000000-0000-4000-8000-000000000027', {
    batchId: 'sample-batch-41', nextBatchId: 'sample-batch-42', candidateSha256: '8e74508c2acc3cdad3b01e8bd4a8b4bbd3fa2f1af70a4d421502b526ef546910',
    ledgerSha256: 'afa2c0642ffc4936f7181edec001e8c2e7ace12aeebc3c42d8ac1f4a3c4513f6', reviewerOutputSha256: '1f2b5616b7ed3e80134fd04bb1f7c760d29e9f2572bd8ea135f1a64b22d8c545',
    rootFile: 'sample-batch-41-terminal-and-independent-root-result-sample-date.json', rootSha256: '0b76f65d0e360a459f284258e839f79ffdeaefa72b8784cf5026806863771cd6',
    independentFile: 'sample-batch-41-independent-business-audit-zero-model-sample-date.json', independentSha256: 'a379e127ec7f389dff3883edbb016def34e87d8572399aa04d35e60b1e8df381',
    briefFile: 'SAMPLE-HISTORICAL-REREGISTER-MATERIAL-REPAIR-TASK-sample-date.md', briefSha256: '316204758922b8667ec2dad5aa0f9cfd91295967c7389b543e7bb298ee181a92',
    startupGateFile: 'tools/sample42-historical-reregister-vm-gate-zero-model.mjs', startupGateSha256: '8073d38400d1bb127eaa8fc720fa45738a7a641ee0baa577c69554ba219509f2',
    startupGateProofFile: 'sample42-historical-reregister-vm-prepared-gate-zero-model-sample-date.json', startupGateProofSha256: 'ae1e00eace6455e3ea14a5b416a6e980c1196fb233eb3787fc8231092b978195',
    gateCommand: 'node tools/sample42-historical-reregister-vm-gate-zero-model.mjs --workspace $WORKSPACE --mode candidate --evidence /tmp/sample42-historical-reregister-vm-candidate.json',
    gateRequirements: "passed=true, mode='candidate', nativeModelCalls=0, productApiCalls=0, actualBrowser=false, businessSourceEdited=false, and every proof-listed requiredPassingCase=true",
    scopeNote: 'This batch only repairs historical restore after explicit current-material re-registration while preserving the historical record and original request bytes; independent terminal checking uses tools/sample42-historical-reregister-headless-gate-zero-model.mjs SHA-256 dd7f3966362932e24859a23825836db19ce84802b2952dabc6e4f3db2b55c56c with prepared proof sample42-historical-reregister-headless-prepared-gate-zero-model-sample-date.json SHA-256 79a018250a10cd2247cfec957c78ab57d93438bb794b4003ec200714ea238dc3, and is not a reason to launch Chrome from the Native sandbox',
    errorLabel: 'exact registered historical-reregister',
    additionalBoundFiles: [
      { root: 'project', file: 'tools/sample41-completed-retest-disposition-vm-gate-zero-model.mjs', sha256: '25d79a27ed27c325f60eede9ce522a7749c9293e92bcf943a4afcd0487c7bd39' },
      { root: 'evidence', file: 'sample41-completed-retest-disposition-prepared-gate-zero-model-sample-date.json', sha256: '707dd10e3c327824b60e43670c7b6b24e1510cf1942f499e9594fb7920c906df' },
      { root: 'project', file: 'tools/sample41-completed-retest-disposition-headless-gate-zero-model.mjs', sha256: '5ebe8d980981bd854b67f4f7873f3afe7db9f34d1aa04a009ec479b0236024ec' },
      { root: 'evidence', file: 'sample41-completed-retest-disposition-headless-prepared-gate-zero-model-sample-date.json', sha256: '9fc09e803324ebf0db17c08710fce433105bb7b2746606167ca528252ca833b4' },
      { root: 'project', file: 'tools/sample42-historical-reregister-headless-gate-zero-model.mjs', sha256: 'dd7f3966362932e24859a23825836db19ce84802b2952dabc6e4f3db2b55c56c' },
      { root: 'evidence', file: 'sample42-historical-reregister-headless-prepared-gate-zero-model-sample-date.json', sha256: '79a018250a10cd2247cfec957c78ab57d93438bb794b4003ec200714ea238dc3' },
    ],
    allowedChangedFiles: ['achievements.js', 'app.js', 'index.html', 'p0-repair.js'],
  }],
  ['run-00000000-0000-4000-8000-000000000028', {
    batchId: 'sample-batch-42', nextBatchId: 'sample-batch-43', candidateSha256: '0ffde9c44d77aebe53c5b7f53db0cade6d193afb0b8a7cede985f315dd061bf4',
    ledgerSha256: 'eb410037c442189200d07ad63a2ce12806f4fdde955de44648faf2de37bd4a62', reviewerOutputSha256: 'a319d7b2ead8183001331328a787e54cff56416ba4e665a413a3f1c90bd3272b',
    rootFile: 'sample-batch-42-root-diagnosis-final-zero-model-sample-date.json', rootSha256: '6b2ff98ec9b5a757d875e3edf99860b2d5ae779c69ae299dea8eb6e32f4ca9ec',
    independentFile: 'sample-batch-42-independent-business-audit-zero-model-sample-date.json', independentSha256: '713af70cc8de64f42111ec10c37ccbbb0867328de332c04019cbfd0d2bd8258a',
    briefFile: 'SAMPLE-HISTORICAL-MATERIAL-IDENTITY-REPAIR-TASK-sample-date.md', briefSha256: 'c712ed56c92bd1c33554174d2e0a1e3b368bd6e8c700ee5bc94d370c71da0e7a',
    startupGateFile: 'tools/sample43-historical-material-identity-vm-gate-zero-model.mjs', startupGateSha256: '9530c0640384e51972acb789c5cd62a1c8a6faa978f1963758e725f36e26a051',
    startupGateProofFile: 'sample43-historical-material-identity-vm-prepared-gate-zero-model-sample-date.json', startupGateProofSha256: '83d71c7d3693e2280fc2c507a92465d67e8658f5f5a83fd95f84df6a365e955e',
    gateCommand: 'node tools/sample43-historical-material-identity-vm-gate-zero-model.mjs --workspace $WORKSPACE --mode candidate --evidence /tmp/sample43-historical-material-identity-vm-candidate.json',
    gateRequirements: "passed=true, mode='candidate', nativeModelCalls=0, productApiCalls=0, actualBrowser=false, businessSourceEdited=false, and every proof-listed requiredPassingCase=true",
    scopeNote: 'This batch only repairs historical restored-material identity validation before any material POST, local replacement, CAS write, inference, or copy; preserve the original historical record, current material, and request bytes. Apply the current confirmed criteria only: do not invent theoretical boundary cases, loosen or add mastery qualifications, mechanically repeat unrelated Reviewer findings, or assume a PASS. Independent terminal checking uses tools/sample43-historical-material-identity-headless-gate-zero-model.mjs SHA-256 5a928da87e4e12b61a3c947d0a73c2a21f26da1b5af85313cb5022c4e70850fe with prepared proof sample43-historical-material-identity-headless-prepared-gate-zero-model-sample-date.json SHA-256 dcb11fac61cbfdfe76179f80e2bff14249fa2004503fa5e508f6f1156f412aa6, and is not a reason to launch Chrome from the Native sandbox',
    errorLabel: 'exact registered historical-material identity',
    additionalBoundFiles: [
      { root: 'project', file: 'tools/sample43-actual-host-material-fixture-zero-model.mjs', sha256: '93ef9ccdd8ec27ab33ba620459b082c3410c7aca857603dc380faf037f6d8ba5' },
      { root: 'project', file: 'tools/sample43-historical-material-identity-headless-gate-zero-model.mjs', sha256: '5a928da87e4e12b61a3c947d0a73c2a21f26da1b5af85313cb5022c4e70850fe' },
      { root: 'evidence', file: 'sample43-historical-material-identity-headless-prepared-gate-zero-model-sample-date.json', sha256: 'dcb11fac61cbfdfe76179f80e2bff14249fa2004503fa5e508f6f1156f412aa6' },
      { root: 'project', file: 'tools/sample42-historical-reregister-vm-gate-zero-model.mjs', sha256: '8073d38400d1bb127eaa8fc720fa45738a7a641ee0baa577c69554ba219509f2' },
      { root: 'evidence', file: 'sample42-historical-reregister-vm-prepared-gate-zero-model-sample-date.json', sha256: 'ae1e00eace6455e3ea14a5b416a6e980c1196fb233eb3787fc8231092b978195' },
      { root: 'project', file: 'tools/sample42-historical-reregister-headless-gate-zero-model.mjs', sha256: 'dd7f3966362932e24859a23825836db19ce84802b2952dabc6e4f3db2b55c56c' },
      { root: 'evidence', file: 'sample42-historical-reregister-headless-prepared-gate-zero-model-sample-date.json', sha256: '79a018250a10cd2247cfec957c78ab57d93438bb794b4003ec200714ea238dc3' },
    ],
    allowedChangedFiles: ['achievements.js'],
  }],
  ['run-00000000-0000-4000-8000-000000000017', {
    batchId: 'sample-batch-43', nextBatchId: 'sample-batch-44', candidateSha256: '72d5bdff5b154ff0361c450d5b1da8a4e148e5ef53189568170a5d38e2de9d49',
    ledgerSha256: 'c3cb2d1006a3d5ee357f7f7ffc803d4133ddb3ef14482ca49b37ade414e72827', reviewerOutputSha256: '81771a133cde9b80615b3d2da46c6c0293b91f9b1196cdc3845b389c001b05d1',
    rootFile: 'sample-batch-43-terminal-and-independent-root-result-sample-date.json', rootSha256: '8e6ae79a674252872ec04b2d3288af7bd605595b272c1db7f812f3e8e9b1a2dd',
    independentFile: 'sample-batch-43-independent-business-audit-zero-model-sample-date.json', independentSha256: 'fc6a92e3e4cb520e3adc9c9e4ef5ae7b71681de9e2faab1345f342996134eb75',
    briefFile: 'SAMPLE-RESTORE-EXACT-MASTERY-BASELINE-REPAIR-TASK-sample-date.md', briefSha256: '67d75375a605702b50186aa1f3910415eb20903857a0f9dfb75d379040ed23df',
    startupGateFile: 'tools/sample44-exact-progress-scope-gate-zero-model.mjs', startupGateSha256: 'b188f6651bd489da7d48c246485caf889777677bd535a9a8fd290aeb803feec8',
    startupGateProofFile: 'sample44-exact-progress-scope-prepared-gate-zero-model-sample-date.json', startupGateProofSha256: 'e15c832c7689a77d6c37ee89b44d5b01497ce4a1461687bc845ecbd1790a650c',
    gateCommand: 'node tools/sample44-exact-progress-scope-gate-zero-model.mjs --workspace $WORKSPACE --mode candidate --evidence-dir /tmp/sample44-exact-progress-scope-candidate',
    gateRequirements: 'passed=true, nativeModelCalls=0, productApiCalls=0, all three proof-listed requiredCandidateCases=true, and every proof-listed requiredReportField is present',
    scopeNote: 'This batch restores progress() byte-for-byte from the exact sample-batch-42 baseline while preserving the exact sample-batch-43 restore() and every other byte. Only achievements.js may change, and any byte outside progress() must remain unchanged; do not alter host persistence, learning criteria, roles, budgets, capacity, or other product behavior, and do not assume a PASS',
    errorLabel: 'exact registered progress-baseline restoration',
    additionalBoundFiles: [
      { root: 'project', file: 'tools/sample43-historical-material-identity-vm-gate-zero-model.mjs', sha256: '9530c0640384e51972acb789c5cd62a1c8a6faa978f1963758e725f36e26a051' },
      { root: 'project', file: 'tools/sample43-actual-host-material-fixture-zero-model.mjs', sha256: '93ef9ccdd8ec27ab33ba620459b082c3410c7aca857603dc380faf037f6d8ba5' },
      { root: 'evidence', file: 'sample43-historical-material-identity-vm-prepared-gate-zero-model-sample-date.json', sha256: '83d71c7d3693e2280fc2c507a92465d67e8658f5f5a83fd95f84df6a365e955e' },
    ],
    allowedChangedFiles: ['achievements.js'],
  }],
  ['run-00000000-0000-4000-8000-000000000012', {
    batchId: 'sample-batch-44', nextBatchId: 'sample-batch-45', candidateSha256: '431d9d264d0ddc97084cb2ee682885d75f928ae3c10dfc4d854f510d1d536136',
    ledgerSha256: '93060385ffe41b4dcf38a0d77e048b12b498c699e5e1fb6ef9052e3c6c25f967', reviewerOutputSha256: 'ce33ccc776d62bbb9b42dd47f47b822a83328376033d9776eb936d3906b6a9ed',
    rootFile: 'sample-batch-44-terminal-and-independent-root-result-sample-date.json', rootSha256: '98cdf3e2ab58ce673801f97e20d34acc9c1d7dc7474bd601dc899eee4a043ee0',
    independentFile: 'sample-batch-44-risk1-independent-adjudication-zero-model-sample-date.json', independentSha256: '858e6cd6ebb17b8754e3f009e17a35e3930e7e8c55ed3e366dbb5d464a23c0c6',
    briefFile: 'SAMPLE-SAME-CONCEPT-ASSESSMENT-CONSISTENCY-V2-REPAIR-TASK-sample-date.md', briefSha256: '849b5b794cec696f55cbefae616bfdec231a0c41fa1e242c90aa5a465fc36533',
    startupGateFile: 'tools/sample45-assessment-consistency-v2-zero-model.mjs', startupGateSha256: '465b885f2dc13e1f202958bf8b78627d6eb222d6f2c1476ffc2c6172f14a0c23',
    startupGateProofFile: 'sample45-assessment-consistency-v2-prepared-gate-zero-model-sample-date.json', startupGateProofSha256: 'd045d0f320f858fea0ca31d0b4b39c32ac73b9605536be0ce55616f66424f9e1',
    gateCommand: 'node /path/to/integration-slice/sample-project-intake/projects/sample-article-project/tools/sample45-assessment-consistency-v2-zero-model.mjs --workspace /path/to/integration-slice/sample-project-intake/projects/sample-article-project/workspace --mode candidate --evidence /tmp/sample45-assessment-consistency-v2-candidate.json',
    gateRequirements: 'passed=true, nativeModelCalls=0, productApiCalls=0, actualBrowser=false, businessSourceEdited=false, and every proof-listed requiredCandidateCase and requiredReportField is satisfied',
    scopeNote: 'This batch only makes the common assessment qualification path reject verified, mastered, or celebratory outcomes for a concept when that same assessment reports an error or omission for it, while preserving the original model output, user history, and an accessible remediation path. It does not repair cache ordering, invent a new qualification system, or weaken the confirmed criteria. Native runs only the frozen zero-network gate and necessary syntax checks. Independent terminal validation uses tools/sample45-assessment-consistency-headless-zero-model.mjs SHA-256 6cece30b8bf3cad31fdfb2859475fac8056932e9564a3eeb118238fad798497d with prepared proof sample45-assessment-consistency-headless-prepared-amendment-zero-model-sample-date.json SHA-256 183effe5fbf79d4c1db5cc3c6b5010181ce05a049a03703bc6bd87cd7614927e; that gate has HTTP and inference substitutes and does not grant Native network or browser authority',
    errorLabel: 'exact registered same-concept assessment consistency',
    additionalBoundFiles: [
      { root: 'evidence', file: 'sample-batch-44-final-risk-adjudication-zero-model-sample-date.json', sha256: '872416195e7b06551ccc72244d209d5af32c020b6b2079217d80c98cfb1c833d' },
      { root: 'project', file: 'tools/sample45-assessment-consistency-headless-zero-model.mjs', sha256: '6cece30b8bf3cad31fdfb2859475fac8056932e9564a3eeb118238fad798497d' },
      { root: 'evidence', file: 'sample45-assessment-consistency-headless-prepared-amendment-zero-model-sample-date.json', sha256: '183effe5fbf79d4c1db5cc3c6b5010181ce05a049a03703bc6bd87cd7614927e' },
    ],
    allowedChangedFiles: ['achievements.js', 'app.js', 'core.js'],
  }],
  ['run-00000000-0000-4000-8000-000000000020', {
    batchId: 'sample-batch-45', nextBatchId: 'sample-batch-46', candidateSha256: '0c3c165d524d58af599efa7ee74ca7fa9996e446c8ab86ed2554c9e9246dc9d6',
    ledgerSha256: 'd50a2be83a1bcc7fd25e9b53d9d61a880c8f9fbf130830b536d1531e6b7c3abc', reviewerOutputSha256: '967cde76187f7a31229a7634e4c6b92b5c740f8c1a5d9da8bd0fc03fe9cfa06b',
    rootFile: 'p0-sample45-terminal-and-independent-root-result-sample-date.json', rootSha256: '8efbc21265ef199d0e321efd69f2cccd92b56b4b8bd00ee7e4559c185858a720',
    independentFile: 'p0-sample45-independent-business-audit-zero-model-sample-date.json', independentSha256: '8f10b9f5b575168561a5caafed51397c576ccd1e5b667c0d54dacdb7c5e1d16a',
    briefFile: 'SAMPLE-ASSESSMENT-DECISION-EVIDENCE-CONSISTENCY-REPAIR-TASK-sample-date.md', briefSha256: 'f9cca6df06e38dfceef1ff93ab17369ba1784b245f6a4f4be114b4349bdb2a64',
    startupGateFile: 'tools/sample46-assessment-decision-consistency-zero-model.mjs', startupGateSha256: 'a57a5737ae652b7897d6eb4baf2ea306cde6e5ab588b3b99bbc1d652b640b955',
    startupGateProofFile: 'sample46-assessment-decision-consistency-prepared-gates-v2-zero-model-sample-date.json', startupGateProofSha256: '78f3ec4cb2a8445ea3b961827adb09aea0a40bb191a7b3d0034d29ecfc96a284',
    gateCommand: 'node /path/to/integration-slice/sample-project-intake/projects/sample-article-project/tools/sample46-assessment-decision-consistency-zero-model.mjs --workspace /path/to/integration-slice/sample-project-intake/projects/sample-article-project/workspace --mode candidate --evidence /tmp/sample46-native-gate-unique.json',
    gateRequirements: 'the proof-listed required report fields and candidate cases all pass with nativeModelCalls=0, productApiCalls=0, actualBrowser=false, and businessSourceEdited=false',
    scopeNote: 'This batch only establishes a shared accepted-or-rejected assessment decision and reason used consistently by UI, persistence, restoration, and achievements. Preserve the exact original model text and parsed JSON; mark genuinely old records without this decision evidence as missing rather than recomputing or rewriting history. Preserve normal and partial behavior. Do not repair merging, old-turn retry, cache ordering, or add qualification rules. Native runs only the frozen zero-network gate and syntax checks. Independent terminal validation uses tools/sample46-assessment-decision-consistency-headless-v2-zero-model.mjs SHA-256 e21dfc5317a9ad9c01836c812ba030ac8aedf0fb9267009a3e71b1bedbbda1a8 and does not grant Native browser or network authority',
    errorLabel: 'exact registered assessment-decision evidence consistency',
    additionalBoundFiles: [
      { root: 'project', file: 'tools/sample46-assessment-decision-consistency-headless-v2-zero-model.mjs', sha256: 'e21dfc5317a9ad9c01836c812ba030ac8aedf0fb9267009a3e71b1bedbbda1a8' },
      { root: 'evidence', file: 'sample45-assessment-consistency-v2-prepared-gate-zero-model-sample-date.json', sha256: 'd045d0f320f858fea0ca31d0b4b39c32ac73b9605536be0ce55616f66424f9e1' },
    ],
    allowedChangedFiles: ['achievements.js', 'app.js', 'core.js'],
  }],
]);

function reviewContinuationFiles(registered) {
  const files = [
    { root: 'evidence', file: registered.rootFile, sha256: registered.rootSha256 },
    { root: 'evidence', file: registered.independentFile, sha256: registered.independentSha256 },
    ...(registered.startupGateProofFile ? [{ root: 'evidence', file: registered.startupGateProofFile, sha256: registered.startupGateProofSha256 }] : []),
    { root: 'project', file: registered.startupGateFile, sha256: registered.startupGateSha256 },
    ...(registered.additionalBoundFiles || []),
  ];
  if (files.some((entry) => !entry.file || !/^[a-f0-9]{64}$/.test(entry.sha256 || '') || !['evidence', 'project'].includes(entry.root))) throw new Error('Review continuation evidence registration is invalid');
  return files;
}

function reviewContinuationPrompt(registered) {
  const proof = registered.startupGateProofFile ? `; prepared gate proof ${registered.startupGateProofFile} SHA-256 ${registered.startupGateProofSha256}` : '';
  return `Required frozen zero-network gate: ${registered.startupGateFile} SHA-256 ${registered.startupGateSha256}${proof}. From P12 run exactly: ${registered.gateCommand}. Report done only when exit is 0 and the report has ${registered.gateRequirements}. ${registered.scopeNote}; do not invoke models, learning inference, deployment, or an independent review yourself.`;
}

function boundHostProofFile(batchId) {
  if (!/^sample-batch-\d{2,4}$/.test(batchId || '')) throw new Error('Development batch binding is invalid');
  return `${batchId}-bound-host-proof-zero-model.json`;
}

async function checkedRoot(root) {
  const absolute = path.resolve(root), stat = await fs.lstat(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(absolute) !== absolute) throw new Error('Article workspace is invalid');
  return absolute;
}

async function manifest(root) {
  const result = [];
  async function walk(dir, prefix = '') {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!SAFE_FILE.test(relative)) throw new Error('Article workspace contains an invalid path');
      const absolute = path.join(dir, entry.name);
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error('Article workspace must not contain links');
      if (stat.isDirectory()) await walk(absolute, relative);
      else {
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_FILE_BYTES || !ALLOWED_EXTENSIONS.has(path.extname(relative).toLowerCase())) throw new Error('Article workspace contains an unauthorized file');
        const bytes = await fs.readFile(absolute);
        result.push({ path: relative, bytes: bytes.length, sha256: sha256(bytes) });
        if (result.length > MAX_FILES) throw new Error('Article workspace file limit exceeded');
      }
    }
  }
  await walk(root); return result.sort((a, b) => a.path.localeCompare(b.path));
}

async function reviewDiff(root, changedFiles) {
  if (!Array.isArray(changedFiles) || !changedFiles.length || changedFiles.length > MAX_FILES || changedFiles.some((f) => !SAFE_FILE.test(f))) throw new Error('Developer result has no bounded changed-file list');
  const snippets = [];
  let sourceBytes = 0;
  for (const relative of changedFiles) {
    const content = await fs.readFile(path.join(root, relative), 'utf8');
    sourceBytes += Buffer.byteLength(content);
    snippets.push(`=== NEW FILE: ${relative} ===\n${content}`);
  }
  const diff = snippets.join('\n\n'), framingBytes = Buffer.byteLength(diff) - sourceBytes;
  if (sourceBytes > ARTICLE_PROJECT_CAPACITY.maxSourceBytes || framingBytes > ARTICLE_PROJECT_CAPACITY.maxFramingBytes) throw new Error(`Complete candidate review input exceeds bounded source/framing limits (source=${sourceBytes}, framing=${framingBytes})`);
  if (!diff || Buffer.byteLength(diff) > ARTICLE_PROJECT_CAPACITY.maxReviewBytes) throw new Error(`Complete candidate review input is empty or exceeds the bounded ${ARTICLE_PROJECT_CAPACITY.maxSourceBytes / 1024} KiB source plus ${ARTICLE_PROJECT_CAPACITY.maxFramingBytes / 1024} KiB framing contract`);
  return diff;
}

function developerRequest(project, goalVersionId, executionId, candidate = null, repair = null, increment = null) {
  const displayPrompt = [
    project.goalDraft.statement,
    `Success criteria:\n${project.goalDraft.successCriteria.map((x) => `- ${x}`).join('\n')}`,
    `Boundaries:\n${project.goalDraft.boundaries.map((x) => `- ${x}`).join('\n')}`,
    `Use the registered material at ${project.material.path}; its SHA-256 is ${project.material.sha256}. This Developer stage is limited to building a local static HTML/JS/CSS candidate and running bounded local static checks. Use at most 8 files. Under FILES_CHANGED report every file you actually created or modified, one path per line; the authority independently enumerates every retained deliverable file and sends the complete candidate to Reviewer. Do not delegate, create subagents, invoke collaboration, run an independent review, invoke a reviewer, use a host skill workflow, publish, install dependencies, start preview, or call learning inference. The platform starts the separately budgeted native readonly Reviewer only after host candidate capture. Report STATUS: failed if any required build or check is still failing, unresolved, skipped, or abandoned at the end of this stage. An intermediate failure that you actually repair does not force a failed terminal: rerun the complete required final checks, preserve the earlier failure and repair in SUMMARY, and report STATUS: done only when those final checks all pass. Never hide, waive, or relabel a remaining failure as done.`,
    `Platform API contract for the generated static client:\n- Register each user-selected full article before inference with POST /api/irixi-materials and JSON {sessionId,label,source,articleText}. Response: {materialEventId,sessionId,label,articleSha256,normalization}. articleText is limited to 60,000 UTF-8 bytes. Use the returned articleSha256. Text identity removes one BOM, converts CRLF/CR to LF, and stores exactly one final LF; do not trim other content.\n- Start a grounded turn with POST /api/irixi-inference and JSON {projectId:"sample-article-project",sessionId,turnId,kind,articleSha256,payload:{articleText,savedLearningRecord,responseContract}}. The JSON payload is limited to 64,000 bytes and the final native learning prompt to 64 KiB. savedLearningRecord must contain only current-turn relevant declared evidence; never send the entire cross-article history to the learning model, and never silently truncate or drop state to fit. responseContract must state the structured fields the client expects; parse and validate them without inventing missing fields. kind is explain, discuss, assess, or summarize. Accepted response: {accepted:true,turnId,remaining}; poll GET /api/irixi-inference?turnId=<id> until done, failed, or stale.\n- Query GET /api/irixi-authority at runtime for current goalVersionId and confirmed artifact.candidateSha256; never hard-code the candidate hash. Query GET /api/irixi-intake for truthful learning remaining/deadline/sealed/running/reason.\n- Persist bounded cumulative client records with default-current GET /api/irixi-client-state?sessionId=<id> and PUT /api/irixi-client-state using {projectId:"sample-article-project",sessionId,expectedGoalVersionId,expectedCandidateSha256,expectedMaterialEventId,expectedRevision,state}. State is limited to 48 KiB, every array to 200 items, and the JSON graph to 2000 nodes. Default read/write rejects old goal, candidate, or material bindings. GET /api/irixi-client-state?scope=project returns exactly {scope:"project",items:[{sessionId,label,goalVersionId,candidateSha256,materialEventId,revision,savedAt,current,historical}],totalSessions,limit:200,truncated}; items has at most 200 latest-per-session metadata rows and never includes state bodies. GET /api/irixi-client-state?sessionId=<id>&historical=true returns exactly {readMode:"history",readOnly:true,current,historical,revision,state,stateSha256,goalVersionId,candidateSha256,materialEventId,savedAt,material:{label,source,articleText,articleSha256,normalization}}; it is read-only and cannot become current without explicit material re-registration and a current CAS save. The server provides persistence only; product code owns merge, deduplication, reward, favorite, work, and achievement meaning.\n- After a successful two-call batch is exhausted, the user may explicitly POST /api/irixi-learning/open-batch with {expectedGoalVersionId,expectedCandidateSha256}. Never open it automatically.\n- Persist local session state without invoking a model on reopen. Treat stale inference as historical only. The fixture article is the first acceptance material, not a hard-coded product limit.`,
    `Current teaching policy basis: ${JSON.stringify(project.policyBasis || {})}. The complete statement, success criteria, and boundaries above are authoritative; do not reduce them to browsing completion, random-question coverage, file existence, or animation.`,
  ].join('\n\n');
  const repairLines = repair ? [
    repair.goalIncrementRepair
      ? `This is an explicitly authorized repair of failed execution ${repair.repairOfExecutionId} under the complete current confirmed goal. Preserve its archive and existing working behavior, repair the current registered goal only, and do not import legacy repair briefs or exclusions from the prior core-goal batches. Under FILES_CHANGED report every file actually created or modified; authority independently enumerates all retained deliverables for complete review.`
      : `This is an explicitly authorized repair of failed execution ${repair.repairOfExecutionId}. Preserve its archive. In the live candidate, remove only the exact known untrusted .impeccable/build/pending.json file, then remove the exact .impeccable/build and .impeccable directories only after confirming each is empty. Do not loosen or bypass the strict manifest. Under FILES_CHANGED report every file actually created or modified and do not report the deleted metadata path; authority independently enumerates all remaining deliverables for complete review.`,
    ...(!repair.goalIncrementRepair ? [`Known read-only zero-model findings to reproduce and repair against the confirmed teaching core: parseModelText does not validate nested conceptResults; unevaluated results with empty evidence can be marked verified in knowledgeState; relations and coverage are received but not used for media or question coverage; reload does not resume a running turn; summarize shows only a notice instead of persisting a report; newSession clears the current ledger without cumulative history. Treat these as issues to verify, not as proof of a fix. The supporting evidence is project evidence/generated-page-zero-model-check-20261005.md. Do not implement pendingDesign rewards in this batch.`] : []),
    ...(repair.priorReviewerFailureText && !repair.cleanInputBinding && !repair.storageInputBinding ? [repair.priorReviewerOutcome === 'INCOMPLETE'
      ? `The prior exact-candidate readonly Reviewer exhausted the shared deadline and returned no verdict. This is INCOMPLETE, not a semantic FAIL or PASS. Reuse the existing candidate, run focused checks quickly, and leave enough shared-batch time for the next readonly Reviewer:\n${repair.priorReviewerFailureText}`
      : `The prior exact-candidate readonly Reviewer returned this binding-preserved FAIL; repair every accepted-contract issue and do not reinterpret it as a passing result:\n${repair.priorReviewerFailureText}`] : []),
    ...(repair.cleanInputBinding ? [`Current effective scope is solely the registered brief below. Rejected candidate35 is the exact code input; confirmed candidate28 remains the last approved version. Preserved sample46 is failed history, not the code input or a candidate. Earlier Reviewer FAIL remains historical evidence at backend/sample-batch-45-exact-native-source-sample-date and evidence/p0-sample45-terminal-and-independent-root-result-sample-date.json; its old-ID/merge claims are not executable requirements. Only app.js, core.js and the necessary assessment-qualification entry in achievements.js may change. test-core.js and all frozen tests are read-only. Do not repair merging, historical registration or cache ordering. A Core-only gate PASS does not establish UI, exact-response evidence, server save or reopen acceptance.`] : []),
    ...(repair.storageInputBinding ? [repair.batchId === STORAGE_REPAIR49.nextBatchId ? `Current49 requirements are exclusively restored real logical state2000-node/200-item guards before compression and after decode; retain48KiB wire limit, all history, model-send scope, identity and CAS. Exact rejected input37 is current; confirmed28 remains distinct. Preserve prior48 evidence; malformedJSON/Core/legacy findings are outside49. Only achievements.js storage/read/restore wiring is writable with pure business/API prefix unchanged; all other source/tests readonly. The original second completion is2163 nodes: reject honestly, do not alter evidence or waive thresholds. Follow trusted49 brief; no other repairs.` : `Current48 requirements are exclusively lossless learning record save/restore and another explicit submission. Exact rejected input36 is the current source; last approved version28 remains distinct. Preserve47 history; do not import its malformedJSON/Core/legacy-notice findings as current repair requirements. Only achievements.js storage/read/restore wiring is writable, with the pure business/API prefix unchanged. Every other source and test is readonly. Follow the trusted storage brief below; no full-goal rebuild or additional repairs.`] : []),
    ...(repair.repairBrief ? [`Trusted registered ${repair.goalIncrementRepair ? 'current-P0' : 'minimal'} repair brief (SHA-256 ${repair.repairBriefSha256}):\n${repair.repairBrief}`] : []),
    ...(repair.learningContractFailure ? [repair.learningContractFailure.batchId === 'learning-08'
      ? `The confirmed candidate produced a valid original inference response that the strict client rejected because authoritative turn context was lost in the client state lifecycle. Repair the authoritative client context across submit, running saves, restoration, and parsing; preserve strict source semantics, and do not blame or alter the valid original raw response to make it pass. Failed candidate SHA-256: ${repair.learningContractFailure.candidateSha256}; sealed learning ledger SHA-256: ${repair.learningContractFailure.ledgerSha256}; zero-model reproduction SHA-256: ${repair.learningContractFailure.evidenceSha256}; failed turn: ${repair.learningContractFailure.turnId}. Observed failure: ${repair.learningContractFailure.actualFailure} Diagnostic: ${repair.learningContractFailure.conclusion} Smallest registered change: ${repair.learningContractFailure.smallestNextChange}`
      : `The confirmed prior candidate produced a real inference response that the unchanged client correctly rejected. Repair only the registered prompt/response-contract source while preserving all semantic validation and teaching rules. Failed candidate SHA-256: ${repair.learningContractFailure.candidateSha256}; sealed learning ledger SHA-256: ${repair.learningContractFailure.ledgerSha256}; zero-model reproduction SHA-256: ${repair.learningContractFailure.evidenceSha256}; failed turn: ${repair.learningContractFailure.turnId}. Observed failure: ${repair.learningContractFailure.actualFailure} Diagnostic: ${repair.learningContractFailure.conclusion} Smallest registered change: ${repair.learningContractFailure.smallestNextChange}`] : []),
    ...(repair.learningResumeFailure ? [`The confirmed candidate was blocked before inference by preserved invalid history; no new Native learning call or output exists. Repair the explicit failure-preserving client resume flow so a user can retain the old invalid record, re-register current material, create a genuinely new retest turn, and preserve strict source and CAS bindings. Do not relabel the old invalid turn, invent a model result, or treat the successful development history as failed. Candidate SHA-256: ${repair.learningResumeFailure.candidateSha256}; sealed zero-call learning ledger SHA-256: ${repair.learningResumeFailure.ledgerSha256}; root evidence SHA-256: ${repair.learningResumeFailure.rootEvidenceSha256}; independent evidence SHA-256: ${repair.learningResumeFailure.independentEvidenceSha256}. Failure: ${repair.learningResumeFailure.actualFailure} Smallest registered change: ${repair.learningResumeFailure.smallestNextChange}`] : []),
    ...(repair.platformContinuationNote ? [repair.platformContinuationNote] : []),
    `IRIXI_DEVELOPMENT_BATCH: ${repair.batchId}`,
    `IRIXI_REPAIR_OF_EXECUTION_ID: ${repair.repairOfExecutionId}`,
    `IRIXI_PRIOR_LEDGER_SHA256: ${repair.priorLedgerSha256}`,
    `IRIXI_SCOPE_FINGERPRINT: ${repair.scopeFingerprint}`,
    `IRIXI_SOURCE_SNAPSHOT_SHA256: ${repair.repairInputManifestSha256}`,
  ] : [];
  const incrementLines = increment ? [
    `This is a new confirmed-goal increment using the previously confirmed candidate ${increment.priorCandidateSha256} as its exact starting input. Preserve the approved core and implement only the newly confirmed goal; pendingDesign and future roadmap items are not authorized.`,
    `IRIXI_DEVELOPMENT_BATCH: ${increment.batchId}`,
    `IRIXI_REPAIR_OF_EXECUTION_ID: ${increment.priorExecutionId}`,
    `IRIXI_PRIOR_LEDGER_SHA256: ${increment.priorLedgerSha256}`,
    `IRIXI_SCOPE_FINGERPRINT: ${increment.scopeFingerprint}`,
    `IRIXI_SOURCE_SNAPSHOT_SHA256: ${increment.sourceManifestSha256}`,
  ] : [];
  const prompt = [displayPrompt, ...repairLines, ...incrementLines, DEVELOPER_TAG, `IRIXI_PROJECT_ID: ${PROJECT_ID}`, `IRIXI_GOAL_VERSION_ID: ${goalVersionId}`, `IRIXI_CANDIDATE_SHA256: ${candidate || 'null'}`, `IRIXI_EXECUTION_ID: ${executionId}`].join('\n');
  return { goalVersionId, executionId, displayPrompt, prompt, promptSha256: sha256(prompt) };
}

function classifyReviewerOutcome(ledger, call, text) {
  if (/(?:^|\n)\s*(?:\*\*)?VERDICT:(?:\*\*)?\s*FAIL\b/im.test(text)) return { verdict: 'FAIL', scopeOutcome: 'contract_failed', text };
  const deadline = Date.parse(ledger?.deadlineAt), started = Date.parse(call?.startedAt), completed = Date.parse(call?.completedAt);
  if (text === '' && call?.stdout?.bytes === 0 && call?.stdout?.sha256 === EMPTY_SHA256 && call?.exitCode === null && call?.signal === 'SIGKILL'
    && Number.isFinite(deadline) && Number.isFinite(started) && Number.isFinite(completed) && started < deadline && completed >= deadline && completed - deadline <= 5_000) {
    return { verdict: 'INCOMPLETE', scopeOutcome: 'incomplete', text: `Reviewer produced no verdict before the shared batch deadline. Started ${call.startedAt}; deadline ${ledger.deadlineAt}; terminated ${call.completedAt} with SIGKILL; stdout was empty (${EMPTY_SHA256}).` };
  }
  return null;
}

export async function createArticleProjectController({ tasksRoot, irixiAppRoot, projectFile, capabilityFile }) {
  const helpers = await loadIrixiAuthorityHelpers(irixiAppRoot), store = helpers.createStore(tasksRoot); await store.init();
  const loadProject = async () => JSON.parse(await fs.readFile(projectFile, 'utf8'));
  const loadCapability = async () => JSON.parse(await fs.readFile(capabilityFile, 'utf8'));
  const writeCapability = async (mutate) => {
    const current = await loadCapability(), next = structuredClone(current); await mutate(next);
    const temporary = `${capabilityFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try { await fs.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); await fs.rename(temporary, capabilityFile); }
    finally { await fs.unlink(temporary).catch(() => {}); }
    return next;
  };
  const workspaceRoot = await checkedRoot((await loadProject()).workspace);
  const cleanInputs = createCleanRepairInputManager({ projectFile, capabilityFile, store, helpers, workspaceRoot, manifest, repairInputManifest });

  const prepareCleanRepairInput = (taskId,input) => cleanInputs.prepare(taskId,input);
  const validateCleanRepairInput = (taskId,input) => cleanInputs.validate(taskId,input).then(({record}) => ({ prepared:true, ...record }));
  const openCleanRepairBatch = (taskId,input) => cleanInputs.activate(taskId,input,async (activation) => openRepairBatch(taskId, {
    ...activation.record.expected, acknowledgement:'preserve_failed_batch', maxModelCalls:input.maxModelCalls, maxDurationMs:input.maxDurationMs,
    optInBoundedAutoReview:true, expectedSourceSnapshotSha256:activation.record.inputRepairManifestSha256,
    repairBriefFile:activation.record.briefFile, expectedRepairBriefSha256:activation.record.briefSha256,
  },activation));

  async function registeredExecutionIsCurrent(task, goal, artifact) {
    const request = task.integrationExecutionRequest, execution = task.execution, repair = execution?.repair;
    if (!request || request.goalVersionId !== goal.id || request.executionId !== execution?.id || sha256(request.prompt || '') !== request.promptSha256 || execution.stopReason) return false;
    const authorization = (task.events || []).findLast((entry) => entry.type === 'integration.repair_batch_authorized' && entry.detail?.executionId === execution.id);
    const increment = (task.events || []).findLast((entry) => entry.type === 'project.goal_increment_authorized' && entry.detail?.executionId === execution.id);
    if (!authorization && increment) return !artifact && execution.phase === 'planned' && execution.startedAt === null && execution.deadlineAt === null
      && fingerprint(await manifest(workspaceRoot)) === increment.detail?.sourceManifestSha256 && increment.detail?.scopeFingerprint === task.projectWorkspace?.scopeFingerprint;
    if (!authorization) return !artifact && !['learning_contract', 'learning_resume'].includes(repair?.repairKind);
    if (execution.phase !== 'planned' || execution.startedAt !== null || execution.deadlineAt !== null) return false;
    if (fingerprint(await repairInputManifest(workspaceRoot)) !== authorization.detail?.repairInputManifestSha256
      || authorization.detail?.scopeFingerprint !== task.projectWorkspace?.scopeFingerprint) return false;
    if (!artifact) return !['learning_contract', 'learning_resume'].includes(repair?.repairKind);
    const approval = (task.approvals || []).findLast((entry) => entry.artifactId === artifact.id && entry.status === 'confirmed');
    const confirmedBinding = artifact.status === 'confirmed' && Boolean(approval) && Boolean(matchingPassedReview(task, artifact));
    if (repair?.repairKind === 'learning_resume' && authorization.detail?.repairKind === 'learning_resume') {
      const capability = await loadCapability(), ledgerFile = path.resolve(capability.development?.ledgerFile || '');
      const learningResume = await learningResumeRepairEvidence(task, capability).catch(() => null);
      const platformFailure = LEARNING_RESUME_PLATFORM_FAILURES.get(repair.failedPlatformExecutionId);
      if (!platformFailure || repair.batchId !== platformFailure.nextBatchId) return false;
      const stateRoot = await fs.realpath(path.dirname(capabilityFile)), priorLedgerFile = path.join(stateRoot, platformFailure.batchId, 'model-ledger.json');
      let platformBindingsCurrent = false;
      try {
        const priorStat = await fs.lstat(priorLedgerFile), priorBytes = await fs.readFile(priorLedgerFile);
        const rootBytes = await fs.readFile(path.join(path.dirname(projectFile), 'evidence', platformFailure.rootFile));
        const independentBytes = await fs.readFile(path.join(path.dirname(projectFile), 'evidence', platformFailure.independentFile));
        platformBindingsCurrent = priorStat.isFile() && !priorStat.isSymbolicLink() && priorStat.nlink === 1 && await fs.realpath(priorLedgerFile) === priorLedgerFile
          && sha256(priorBytes) === repair.failedPlatformLedgerSha256 && sha256(priorBytes) === platformFailure.ledgerSha256
          && sha256(rootBytes) === repair.failedPlatformRootEvidenceSha256 && sha256(rootBytes) === platformFailure.rootSha256
          && sha256(independentBytes) === repair.failedPlatformIndependentEvidenceSha256 && sha256(independentBytes) === platformFailure.independentSha256;
      } catch { platformBindingsCurrent = false; }
      return confirmedBinding
        && capability.schemaVersion === 1 && capability.phase === 'real-project-repair-open'
        && capability.projectId === PROJECT_ID && capability.goalVersionId === goal.id
        && capability.development?.cap === 2 && capability.development?.windowMs === 20 * 60_000 && capability.development?.mode === 'developer_reviewer'
        && capability.development?.enabled === true && capability.development?.executionId === execution.id
        && capability.development?.batchId === repair.batchId && ledgerFile === path.resolve(authorization.detail?.ledgerFile || '')
        && capability.development?.batchOrdinal === repair.batchOrdinal && repair.batchOrdinal === Number(repair.batchId.slice('sample-batch-'.length))
        && capability.development?.repairOfExecutionId === repair.repairOfExecutionId && repair.repairOfExecutionId === repair.failedPlatformExecutionId
        && path.dirname(path.dirname(ledgerFile)) === stateRoot && path.basename(path.dirname(ledgerFile)) === repair.batchId
        && capability.learning?.enabled === false
        && capability.development?.priorLedgerSha256 === repair.priorLedgerSha256
        && capability.development?.repairInputManifestSha256 === repair.repairInputManifestSha256
        && capability.development?.scopeFingerprint === repair.scopeFingerprint
        && repair.repairInputManifestSha256 === authorization.detail?.repairInputManifestSha256 && repair.scopeFingerprint === authorization.detail?.scopeFingerprint
        && artifact.projectCandidate?.candidateSha256 === repair.failedLearningCandidateSha256
        && authorization.detail?.failedLearningCandidateSha256 === repair.failedLearningCandidateSha256
        && authorization.detail?.failedLearningLedgerSha256 === repair.failedLearningLedgerSha256
        && authorization.detail?.failedLearningEvidenceSha256 === repair.failedLearningEvidenceSha256
        && authorization.detail?.failedLearningIndependentEvidenceSha256 === repair.failedLearningIndependentEvidenceSha256
        && authorization.detail?.failedLearningSavedEventId === repair.failedLearningSavedEventId
        && authorization.detail?.failedPlatformExecutionId === repair.failedPlatformExecutionId
        && authorization.detail?.failedPlatformLedgerSha256 === repair.failedPlatformLedgerSha256
        && authorization.detail?.failedPlatformRootEvidenceSha256 === repair.failedPlatformRootEvidenceSha256
        && authorization.detail?.failedPlatformIndependentEvidenceSha256 === repair.failedPlatformIndependentEvidenceSha256
        && learningResume?.candidateSha256 === repair.failedLearningCandidateSha256
        && learningResume?.learningLedgerSha256 === repair.failedLearningLedgerSha256
        && learningResume?.rootEvidenceSha256 === repair.failedLearningEvidenceSha256
        && learningResume?.independentEvidenceSha256 === repair.failedLearningIndependentEvidenceSha256
        && learningResume?.savedEventId === repair.failedLearningSavedEventId
        && execution.limits?.maxModelCalls === 2 && execution.limits?.maxDurationMs === 20 * 60_000
        && repair.repairBriefFile === platformFailure.briefFile && repair.repairBriefSha256 === platformFailure.briefSha256
        && platformBindingsCurrent;
    }
    return repair?.repairKind === 'learning_contract' && authorization.detail?.repairKind === 'learning_contract'
      && confirmedBinding
      && artifact.projectCandidate?.candidateSha256 === repair.failedLearningCandidateSha256
      && authorization.detail?.failedLearningCandidateSha256 === repair.failedLearningCandidateSha256
      && authorization.detail?.failedLearningLedgerSha256 === repair.failedLearningLedgerSha256
      && authorization.detail?.failedLearningEvidenceSha256 === repair.failedLearningEvidenceSha256
      && authorization.detail?.failedLearningTurnId === repair.failedLearningTurnId;
  }

  async function state(taskId) {
    const task = await store.get(taskId), goal = helpers.activeGoal(task), project = await loadProject();
    const confirmed = (task.events || []).findLast((e) => e.type === 'intake.goal_confirmed')?.detail?.goalVersionId === goal.id;
    const goalMatchesDraft = canonical({ statement: goal.statement, successCriteria: goal.successCriteria, boundaries: goal.boundaries }) === canonical(project.goalDraft);
    const authorized = confirmed && task.type === 'project' && task.projectWorkspace?.fixtureId === PROJECT_ID && helpers.projectWorkspaceIsCurrent(task);
    const artifact = (task.artifacts || []).filter((a) => ['candidate', 'confirmed'].includes(a.status) && helpers.projectArtifactIsCurrent(task, a)).at(-1);
    let repairProposal = null;
    if (authorized && goalMatchesDraft) {
      const cap = await loadCapability(), ledgerFile = path.resolve(cap.development?.ledgerFile || '');
      try {
        const ledgerBytes = await fs.readFile(ledgerFile), ledger = JSON.parse(ledgerBytes);
        const repairInputSha256 = fingerprint(await repairInputManifest(workspaceRoot));
        const learningContract = await learningContractRepairEvidence(task, cap).catch(() => null);
        const learningResume = await learningResumeRepairEvidence(task, cap).catch(() => null);
        const learningResumeContinuation = await learningResumePreflightContinuationEvidence(task, cap, learningResume).catch(() => null);
        const knownStoppedResume = LEARNING_RESUME_PLATFORM_FAILURES.has(task.execution?.id) && task.execution?.repair?.repairKind === 'learning_resume';
        const successfulDevelopment = (learningContract?.batchId === 'learning-08' || learningResume) && cap.development?.enabled === false && cap.development?.executionId === task.execution?.id
          && ledger.cap === 2 && ledger.windowMs === 20 * 60_000 && !ledger.sealed && ledger.calls?.length === 2
          && ledger.calls.every((call, index) => call.expectedRole === ['developer','reviewer'][index] && call.status === 'completed' && call.exitCode === 0 && !call.signal && call.declaredStatus === 'done');
        if ((task.execution?.stopReason === 'permanent_error' && ledger.sealed || successfulDevelopment) && (!knownStoppedResume || Boolean(learningResumeContinuation))) {
          repairProposal = { expectedGoalVersionId: goal.id, expectedFailedExecutionId: task.execution.id, expectedScopeFingerprint: task.projectWorkspace.scopeFingerprint, expectedPriorLedgerSha256: sha256(ledgerBytes), expectedSourceSnapshotSha256: repairInputSha256, acknowledgement: 'preserve_failed_batch', maxModelCalls: 2, maxDurationMs: 20 * 60_000 };
          if (learningContract) Object.assign(repairProposal, { repairKind: 'learning_contract', acknowledgement: 'preserve_failed_learning_contract', expectedFailedCandidateSha256: learningContract.candidateSha256, expectedLearningLedgerSha256: learningContract.learningLedgerSha256, expectedLearningEvidenceSha256: learningContract.evidenceSha256, expectedFailedTurnId: learningContract.turnId });
          if (learningResume) Object.assign(repairProposal, { repairKind: 'learning_resume', acknowledgement: 'preserve_failed_learning_resume', expectedFailedCandidateSha256: learningResume.candidateSha256, expectedLearningLedgerSha256: learningResume.learningLedgerSha256, expectedRootEvidenceSha256: learningResume.rootEvidenceSha256, expectedIndependentEvidenceSha256: learningResume.independentEvidenceSha256, expectedSavedEventId: learningResume.savedEventId });
          if (learningResumeContinuation) Object.assign(repairProposal, { expectedFailedPlatformExecutionId: learningResumeContinuation.executionId, expectedFailedPlatformLedgerSha256: learningResumeContinuation.ledgerSha256, expectedFailedPlatformRootEvidenceSha256: learningResumeContinuation.rootEvidenceSha256, expectedFailedPlatformIndependentEvidenceSha256: learningResumeContinuation.independentEvidenceSha256 });
          const reusable = await reusableDeveloperEvidence(task, cap);
          if (reusable) Object.assign(repairProposal, { reviewOnlyAvailable: true, expectedCandidateSha256: reusable.candidateSha256 });
        }
      } catch { /* A missing or malformed prior ledger is not repairable. */ }
    }
    const registeredCurrent = authorized && goalMatchesDraft && await registeredExecutionIsCurrent(task, goal, artifact);
    return { id: PROJECT_ID, label: project.title, goal: project.goalDraft.statement, successCriteria: project.goalDraft.successCriteria, boundaries: project.goalDraft.boundaries, files: [], editableFiles: [], cases: [], selected: confirmed, authorized, current: goalMatchesDraft, goalVersionId: goal.id, repairProposal,
      repairBlockedReason: !goalMatchesDraft ? '新增需求尚未通过产品确认目标。' : null,
      scopeFingerprint: authorized ? task.projectWorkspace.scopeFingerprint : null, sourceSnapshotSha256: authorized ? task.projectWorkspace.sourceSnapshotSha256 : null,
      execution: authorized && task.execution ? { id: task.execution.id, phase: task.execution.phase, stopReason: task.execution.stopReason || null } : null,
      registeredExecution: registeredCurrent ? task.integrationExecutionRequest : null };
  }

  async function repairInputManifest(root) {
    const entries = []; let total = 0;
    async function walk(dir, prefix = '') {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name, absolute = path.join(dir, entry.name), stat = await fs.lstat(absolute);
        if (stat.isSymbolicLink()) throw new Error('Repair input may not contain links');
        const knownMetadataDir = relative === '.impeccable' || relative === '.impeccable/build';
        if (stat.isDirectory()) { if (!SAFE_FILE.test(relative) && !knownMetadataDir) throw new Error('Repair input contains an unauthorized directory'); await walk(absolute, relative); }
        else {
          const knownMetadata = relative === '.impeccable/build/pending.json';
          if ((!SAFE_FILE.test(relative) && !knownMetadata) || (!knownMetadata && !ALLOWED_EXTENSIONS.has(path.extname(relative).toLowerCase())) || !stat.isFile() || stat.nlink !== 1 || stat.size > MAX_FILE_BYTES) throw new Error('Repair input contains an invalid file');
          total += stat.size; if (total > 8 * 1024 * 1024) throw new Error('Repair input is too large');
          const bytes = await fs.readFile(absolute); entries.push({ path: relative, bytes: bytes.length, sha256: sha256(bytes), trust: knownMetadata ? 'untrusted-metadata' : 'failed-run-output' });
          if (entries.length > MAX_FILES + 1) throw new Error('Repair input file limit exceeded');
        }
      }
    }
    await walk(root); return entries.sort((a, b) => a.path.localeCompare(b.path));
  }

  async function learningContractRepairEvidence(task, capability) {
    const artifact = (task.artifacts || []).filter((entry) => entry.status === 'confirmed' && helpers.projectArtifactIsCurrent(task, entry)).at(-1);
    const approval = artifact && (task.approvals || []).findLast((entry) => entry.artifactId === artifact.id && entry.status === 'confirmed');
    if (!artifact?.projectCandidate || !approval || capability.candidateSha256 !== artifact.projectCandidate.candidateSha256
      || capability.development?.enabled !== false) return null;
    await assertCandidateCurrent(task, artifact);
    const stateRoot = await fs.realpath(path.dirname(capabilityFile)), ledgerFile = path.resolve(capability.learning?.ledgerFile || '');
    if (path.dirname(path.dirname(ledgerFile)) !== stateRoot || !/learning-\d{2,4}\/model-ledger\.json$/.test(ledgerFile.replaceAll(path.sep, '/'))) return null;
    const stat = await fs.lstat(ledgerFile); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024 || await fs.realpath(ledgerFile) !== ledgerFile) return null;
    const ledgerBytes = await fs.readFile(ledgerFile), ledger = JSON.parse(ledgerBytes), calls = ledger.calls || [];
    const batchId = path.basename(path.dirname(ledgerFile));
    if (batchId === 'learning-08') {
      const fixed = { goalVersionId: 'goal-00000000-0000-4000-8000-000000000016', candidateSha256: '5a0294d6f65717302fe65a3eac4e15ac0601b69528ab5178ea37773733f17989', sessionId: '00000000-0000-4000-8000-000000000021', materialEventId: 'event-00000000-0000-4000-8000-000000000023', turnId: '00000000-0000-4000-8000-000000000003', sourceTaskId: 'learning-00000000-0000-4000-8000-000000000009' };
      if (helpers.activeGoal(task).id !== fixed.goalVersionId || artifact.projectCandidate.candidateSha256 !== fixed.candidateSha256 || !matchingPassedReview(task, artifact)
        || ledger.cap !== 2 || ledger.windowMs !== 20 * 60_000 || ledger.sealed?.reasonCode !== 'host_native_learning_output_contract_invalid'
        || sha256(ledgerBytes) !== '4370af0b75e5ab3ea32ca3c1a23a5b024c64c49038e70bdaaaac8fb4f30c5c38' || calls.length !== 1) return null;
      const call = calls[0];
      if (call.expectedRole !== 'inference' || call.status !== 'completed' || call.exitCode !== 0 || call.signal || call.outputSchema?.kind !== 'assess' || !/^[a-f0-9]{64}$/.test(call.promptSha256 || '')) return null;
      const stdoutFile = path.resolve(path.dirname(ledgerFile), call.stdout?.file || '');
      if (!stdoutFile.startsWith(`${path.dirname(ledgerFile)}${path.sep}`)) return null;
      const stdoutStat = await fs.lstat(stdoutFile); if (!stdoutStat.isFile() || stdoutStat.isSymbolicLink() || stdoutStat.nlink !== 1 || stdoutStat.size > 40_000 || await fs.realpath(stdoutFile) !== stdoutFile) return null;
      const stdoutBytes = await fs.readFile(stdoutFile); if (stdoutBytes.length !== call.stdout?.bytes || sha256(stdoutBytes) !== call.stdout?.sha256) return null;
      const reservation = (task.events || []).findLast((entry) => entry.type === 'learning.inference_reserved' && entry.detail?.sourceTaskId === fixed.sourceTaskId && entry.detail?.turnId === fixed.turnId);
      const result = reservation && (task.events || []).findLast((entry) => entry.type === 'learning.inference_result' && entry.detail?.sourceTaskId === fixed.sourceTaskId && entry.detail?.current === true);
      const saved = (task.events || []).findLast((entry) => entry.type === 'learning.client_state_saved' && entry.detail?.sessionId === fixed.sessionId && entry.detail?.revision === 16);
      if (!reservation || !result || reservation.detail?.kind !== 'assess' || reservation.detail?.sessionId !== fixed.sessionId || reservation.detail?.materialEventId !== fixed.materialEventId
        || reservation.detail?.goalVersionId !== fixed.goalVersionId || reservation.detail?.candidateSha256 !== fixed.candidateSha256 || reservation.detail?.promptSha256 !== call.promptSha256
        || result.detail?.kind !== 'assess' || result.detail?.turnId !== fixed.turnId || result.detail?.sessionId !== fixed.sessionId || result.detail?.materialEventId !== fixed.materialEventId
        || result.detail?.goalVersionId !== fixed.goalVersionId || result.detail?.candidateSha256 !== fixed.candidateSha256 || result.detail?.promptSha256 !== call.promptSha256
        || result.detail?.resultSha256 !== call.stdout.sha256 || sha256(String(result.detail?.text ?? '')) !== call.stdout.sha256 || result.detail?.text !== stdoutBytes.toString('utf8') || !saved) return null;
      const evidenceFile = path.join(path.dirname(projectFile), 'evidence', 'learning08-real-runtime-contract-independent-reproduction-sample-date.json');
      const evidenceStat = await fs.lstat(evidenceFile); if (!evidenceStat.isFile() || evidenceStat.isSymbolicLink() || evidenceStat.nlink !== 1 || evidenceStat.size > 64_000 || await fs.realpath(evidenceFile) !== evidenceFile) return null;
      const evidenceBytes = await fs.readFile(evidenceFile), evidence = JSON.parse(evidenceBytes), currentManifest = await manifest(workspaceRoot);
      const boundCall = { ordinal: 1, kind: 'assess', turnId: fixed.turnId, sourceTaskId: fixed.sourceTaskId, promptSha256: call.promptSha256, stdoutSha256: call.stdout.sha256, resultSha256: result.detail.resultSha256 };
      if (sha256(evidenceBytes) !== 'fc7ad66684d17585f4cdede056186d5607314b35ecf1a134382035a9f27ab4a8' || evidence.projectId !== PROJECT_ID
        || evidence.goalVersionId !== fixed.goalVersionId || evidence.candidateSha256 !== fixed.candidateSha256 || evidence.sessionId !== fixed.sessionId || evidence.materialEventId !== fixed.materialEventId
        || evidence.turnId !== fixed.turnId || evidence.sourceTaskId !== fixed.sourceTaskId || evidence.ledgerSha256 !== sha256(ledgerBytes) || canonical(evidence.calls) !== canonical([boundCall])
        || evidence.nativeModelCalls !== 0 || evidence.originalActualNativeCalls !== 1 || evidence.sourceUnchanged !== true || evidence.actualResponseRejected !== true || evidence.clientState !== 'invalid'
        || evidence.sourceManifestSha256 !== fixed.candidateSha256 || canonical(evidence.sourceManifest) !== canonical(currentManifest)
        || evidence.raw?.actualInputHasCorrectSourceTurnId !== true || evidence.client?.sourceTurnId !== null || evidence.serverState?.revision !== 16
        || evidence.serverState?.eventId !== saved.id || evidence.serverState?.stateSha256 !== saved.detail?.stateSha256 || evidence.serverState?.invalidTurnSaved !== true
        || evidence.serverState?.verified !== 0 || evidence.serverState?.mastered !== false || evidence.serverState?.noMasteryReward !== true
        || evidence.invalidRawNotReused !== true || evidence.originalRevision16NotMutated !== true) return null;
      return { batchId, candidateSha256: fixed.candidateSha256, learningLedgerSha256: sha256(ledgerBytes), evidenceSha256: sha256(evidenceBytes), turnId: fixed.turnId, evidence };
    }
    if (batchId === 'learning-06') {
      const fixed = {
        goalVersionId: 'goal-00000000-0000-4000-8000-000000000016', candidateSha256: '53f8e93601ce4b42d35cf648996646e329ebdd583fc75399e3d4ec8f3685e5d1',
        sessionId: '00000000-0000-4000-8000-000000000022', materialEventId: 'event-00000000-0000-4000-8000-000000000018',
        calls: [
          { kind: 'explain', turnId: '00000000-0000-4000-8000-000000000013', sourceTaskId: 'learning-00000000-0000-4000-8000-000000000014' },
          { kind: 'assess', turnId: '00000000-0000-4000-8000-000000000002', sourceTaskId: 'learning-00000000-0000-4000-8000-000000000001' },
        ],
      };
      if (helpers.activeGoal(task).id !== fixed.goalVersionId || artifact.projectCandidate.candidateSha256 !== fixed.candidateSha256
        || ledger.cap !== 2 || ledger.windowMs !== 20 * 60_000 || ledger.sealed?.reasonCode !== 'host_native_learning_output_contract_invalid'
        || sha256(ledgerBytes) !== 'f72d8f923b7a16dff7435c2abb0b379229de0eda5a4ac01d07038c7e149b955d' || calls.length !== 2) return null;
      const boundCalls = [];
      for (let index = 0; index < 2; index++) {
        const call = calls[index], expected = fixed.calls[index];
        if (call.expectedRole !== 'inference' || call.status !== 'completed' || call.exitCode !== 0 || call.signal || call.outputSchema?.kind !== expected.kind || !/^[a-f0-9]{64}$/.test(call.promptSha256 || '')) return null;
        const stdoutFile = path.resolve(path.dirname(ledgerFile), call.stdout?.file || '');
        if (!stdoutFile.startsWith(`${path.dirname(ledgerFile)}${path.sep}`)) return null;
        const stdoutStat = await fs.lstat(stdoutFile); if (!stdoutStat.isFile() || stdoutStat.isSymbolicLink() || stdoutStat.nlink !== 1 || stdoutStat.size > 40_000 || await fs.realpath(stdoutFile) !== stdoutFile) return null;
        const stdoutBytes = await fs.readFile(stdoutFile); if (stdoutBytes.length !== call.stdout?.bytes || sha256(stdoutBytes) !== call.stdout?.sha256) return null;
        const reservation = (task.events || []).findLast((entry) => entry.type === 'learning.inference_reserved' && entry.detail?.sourceTaskId === expected.sourceTaskId && entry.detail?.turnId === expected.turnId);
        const result = reservation && (task.events || []).findLast((entry) => entry.type === 'learning.inference_result' && entry.detail?.sourceTaskId === expected.sourceTaskId && entry.detail?.current === true);
        if (!reservation || !result || reservation.detail?.kind !== expected.kind || reservation.detail?.sessionId !== fixed.sessionId || reservation.detail?.materialEventId !== fixed.materialEventId
          || reservation.detail?.goalVersionId !== fixed.goalVersionId || reservation.detail?.candidateSha256 !== fixed.candidateSha256 || reservation.detail?.promptSha256 !== call.promptSha256
          || result.detail?.kind !== expected.kind || result.detail?.turnId !== expected.turnId || result.detail?.sessionId !== fixed.sessionId
          || result.detail?.materialEventId !== fixed.materialEventId || result.detail?.goalVersionId !== fixed.goalVersionId
          || result.detail?.candidateSha256 !== fixed.candidateSha256 || result.detail?.promptSha256 !== call.promptSha256
          || result.detail?.resultSha256 !== call.stdout.sha256 || sha256(String(result.detail?.text ?? '')) !== call.stdout.sha256
          || result.detail?.text !== stdoutBytes.toString('utf8')) return null;
        boundCalls.push({ ordinal: index + 1, kind: expected.kind, turnId: expected.turnId, sourceTaskId: expected.sourceTaskId, promptSha256: call.promptSha256, stdoutSha256: call.stdout.sha256, resultSha256: result.detail.resultSha256 });
      }
      const evidenceFile = path.join(path.dirname(projectFile), 'evidence', 'learning06-real-runtime-contract-independent-reproduction-sample-date.json');
      const evidenceStat = await fs.lstat(evidenceFile); if (!evidenceStat.isFile() || evidenceStat.isSymbolicLink() || evidenceStat.nlink !== 1 || evidenceStat.size > 64_000 || await fs.realpath(evidenceFile) !== evidenceFile) return null;
      const evidenceBytes = await fs.readFile(evidenceFile), evidence = JSON.parse(evidenceBytes), currentManifest = await manifest(workspaceRoot);
      if (sha256(evidenceBytes) !== 'cb6c27e25286827ff8506b49fd8eee5845bbfb79d265056c50a397c2230e5813'
        || evidence.projectId !== PROJECT_ID || evidence.goalVersionId !== fixed.goalVersionId || evidence.candidateSha256 !== fixed.candidateSha256 || evidence.sessionId !== fixed.sessionId
        || evidence.materialEventId !== fixed.materialEventId || evidence.ledgerSha256 !== sha256(ledgerBytes) || evidence.nativeModelCalls !== 0 || evidence.sourceUnchanged !== true
        || evidence.actualResponseRejected !== true || evidence.clientState !== 'invalid' || canonical(evidence.calls) !== canonical(boundCalls)
        || evidence.sourceManifestSha256 !== 'a8fb75a55ccb04c2f4f55d4775b21c606ab6e9583517da8fc1bdd592317ac933'
        || canonical([...(evidence.sourceManifest || [])].sort((a, b) => String(a.path).localeCompare(String(b.path)))) !== canonical([...currentManifest].sort((a, b) => String(a.path).localeCompare(String(b.path))))
        || evidence.explain?.clientAccepted !== true || evidence.explain?.fullPlanValidated !== true
        || evidence.assess?.clientAccepted !== false || evidence.assess?.requestedType !== 'recall' || evidence.assess?.semanticType !== 'cause' || evidence.assess?.supported !== true
        || evidence.assess?.qualificationEvidenceSha256 !== 'c2c915c6eb0840aecc870d18b42c847fc82b5d7db041848a0c11023eb22de8dc'
        || evidence.serverState?.revisionUndefined !== true || evidence.serverState?.put409Count !== 6 || evidence.invalidRawNotReused !== true) return null;
      return { candidateSha256: fixed.candidateSha256, learningLedgerSha256: sha256(ledgerBytes), evidenceSha256: sha256(evidenceBytes), turnId: fixed.calls[1].turnId, evidence };
    }
    if (batchId !== 'learning-01') return null;
    if (ledger.cap !== 2 || ledger.windowMs !== 20 * 60_000 || ledger.sealed?.reasonCode !== 'host_native_learning_output_contract_invalid'
      || calls.length !== 1 || calls.some((call) => call.expectedRole !== 'inference' || call.status !== 'completed' || call.exitCode !== 0 || call.signal || !/^[a-f0-9]{64}$/.test(call.promptSha256 || ''))) return null;
    const stdoutFile = path.resolve(path.dirname(ledgerFile), calls[0].stdout?.file || '');
    if (!stdoutFile.startsWith(`${path.dirname(ledgerFile)}${path.sep}`)) return null;
    const stdoutStat = await fs.lstat(stdoutFile); if (!stdoutStat.isFile() || stdoutStat.isSymbolicLink() || stdoutStat.nlink !== 1 || stdoutStat.size > 40_000 || await fs.realpath(stdoutFile) !== stdoutFile) return null;
    const stdoutBytes = await fs.readFile(stdoutFile); if (sha256(stdoutBytes) !== calls[0].stdout?.sha256 || stdoutBytes.length !== calls[0].stdout?.bytes) return null;
    const reservation = (task.events || []).findLast((entry) => entry.type === 'learning.inference_reserved' && entry.detail?.promptSha256 === calls[0].promptSha256 && entry.detail?.candidateSha256 === artifact.projectCandidate.candidateSha256);
    const result = reservation && (task.events || []).findLast((entry) => entry.type === 'learning.inference_result' && entry.detail?.sourceTaskId === reservation.detail.sourceTaskId && entry.detail?.current === true);
    if (!reservation || !result) return null;
    const evidenceFile = path.join(path.dirname(projectFile), 'evidence', 'learning01-real-output-contract-independent-reproduction.json');
    const evidenceStat = await fs.lstat(evidenceFile); if (!evidenceStat.isFile() || evidenceStat.isSymbolicLink() || evidenceStat.nlink !== 1 || evidenceStat.size > 32_000 || await fs.realpath(evidenceFile) !== evidenceFile) return null;
    const evidenceBytes = await fs.readFile(evidenceFile), evidence = JSON.parse(evidenceBytes);
    if (evidence.nativeModelCalls !== 0 || evidence.actualResponseRejected !== true || evidence.originalTurnId !== reservation.detail.turnId
      || evidence.originalStdoutSha256 !== calls[0].stdout?.sha256 || evidence.originalResponseSha256 !== result.detail?.resultSha256
      || evidence.sourceAndSessionUnchanged !== true || evidence.clientState !== 'invalid') return null;
    return { candidateSha256: artifact.projectCandidate.candidateSha256, learningLedgerSha256: sha256(ledgerBytes), evidenceSha256: sha256(evidenceBytes), turnId: reservation.detail.turnId, evidence };
  }

  async function learningResumeRepairEvidence(task, capability) {
    const goal = helpers.activeGoal(task), artifact = (task.artifacts || []).filter((entry) => entry.status === 'confirmed' && helpers.projectArtifactIsCurrent(task, entry)).at(-1);
    const approval = artifact && (task.approvals || []).findLast((entry) => entry.artifactId === artifact.id && entry.status === 'confirmed');
    if (goal.id !== 'goal-00000000-0000-4000-8000-000000000016' || artifact?.projectCandidate?.candidateSha256 !== '14ae7435734c19f4a0d26cf45f89d876a5d927a23b6e93bd6facce3b50fc5de2'
      || !approval || !matchingPassedReview(task, artifact)
      || !(capability.candidateSha256 === artifact.projectCandidate.candidateSha256
        || capability.candidateSha256 === null && (LEARNING_RESUME_PLATFORM_FAILURES.has(task.execution?.id) && task.execution?.id === capability.development?.executionId
          || LEARNING_RESUME_PLATFORM_FAILURES.has(task.execution?.repair?.failedPlatformExecutionId) && capability.development?.executionId === task.execution?.id
            && task.execution.repair.failedLearningCandidateSha256 === artifact.projectCandidate.candidateSha256))
      || !(capability.development?.enabled === false
        || capability.development?.enabled === true && LEARNING_RESUME_PLATFORM_FAILURES.has(task.execution?.repair?.failedPlatformExecutionId)
          && capability.development?.executionId === task.execution?.id && capability.development?.batchId === task.execution?.repair?.batchId)) return null;
    await assertCandidateCurrent(task, artifact);
    const stateRoot = await fs.realpath(path.dirname(capabilityFile)), ledgerFile = path.resolve(capability.learning?.ledgerFile || '');
    if (path.dirname(path.dirname(ledgerFile)) !== stateRoot || path.basename(path.dirname(ledgerFile)) !== 'learning-09') return null;
    const stat = await fs.lstat(ledgerFile); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || await fs.realpath(ledgerFile) !== ledgerFile) return null;
    const ledgerBytes = await fs.readFile(ledgerFile), ledger = JSON.parse(ledgerBytes);
    if (sha256(ledgerBytes) !== '04fa75efb8ce5d67744306458b9068b124d9c73208f55c2723388e5e23184524' || ledger.cap !== 2 || ledger.windowMs !== 20 * 60_000
      || ledger.sealed?.reasonCode !== 'host_learning_resume_invalid_history_blocked' || ledger.calls?.length !== 0) return null;
    const saved = (task.events || []).findLast((entry) => entry.type === 'learning.client_state_saved' && entry.id === 'event-00000000-0000-4000-8000-000000000015');
    if (saved?.detail?.revision !== 16 || saved.detail?.stateSha256 !== '3c7a177a9d5ba6733e6dfe93987e2c3b265f693ad93bd65bce74a47d1e3195f5') return null;
    const evidenceRoot = path.join(path.dirname(projectFile), 'evidence'), rootFile = path.join(evidenceRoot, 'learning09-real-A-premodel-resume-failure-root-result-sample-date.json'), independentFile = path.join(evidenceRoot, 'learning09-real-A-independent-resume-blocker-review-zero-model-sample-date.json');
    for (const file of [rootFile, independentFile]) { const fileStat = await fs.lstat(file); if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.nlink !== 1 || fileStat.size > 128_000 || await fs.realpath(file) !== file) return null; }
    const rootBytes = await fs.readFile(rootFile), independentBytes = await fs.readFile(independentFile), rootEvidence = JSON.parse(rootBytes), independentEvidence = JSON.parse(independentBytes), currentManifest = await manifest(workspaceRoot);
    if (sha256(rootBytes) !== '25aabdb3ec8ed539cbdc5d37358b95f630d3ff5987d0dc31902c9f8ef2c06b28' || sha256(independentBytes) !== 'b8f7d305f95be375f1d445b6e7615e7340afe29093a430639db8b990b7764112'
      || rootEvidence.result !== 'FAIL_REAL_BROWSER_RESUME_BEFORE_INFERENCE_SEALED' || rootEvidence.candidate?.sha256 !== artifact.projectCandidate.candidateSha256 || rootEvidence.terminal?.learning09Calls !== 0
      || rootEvidence.terminal?.ledgerSha256 !== sha256(ledgerBytes) || rootEvidence.preservation?.original08Revision !== 16 || rootEvidence.preservation?.original08StateSha256 !== saved.detail.stateSha256
      || independentEvidence.result !== 'FAIL_REAL_BUSINESS_RESUME_BLOCKER' || independentEvidence.nativeModelCalls !== 0 || independentEvidence.project?.candidateSha256 !== artifact.projectCandidate.candidateSha256
      || independentEvidence.stopBoundary?.ledgerSha256 !== sha256(ledgerBytes) || independentEvidence.stopBoundary?.ledgerCalls !== 0 || independentEvidence.historyIntegrity?.originalLearning08Revision16Sha256 !== 'a005b18ab301748861e74b19cd3198a953f172123796c3c725d1af649289cbbb'
      || fingerprint(currentManifest) !== artifact.projectCandidate.candidateSha256) return null;
    return { candidateSha256: artifact.projectCandidate.candidateSha256, learningLedgerSha256: sha256(ledgerBytes), rootEvidenceSha256: sha256(rootBytes), independentEvidenceSha256: sha256(independentBytes), savedEventId: saved.id, evidence: rootEvidence };
  }

  async function learningResumePreflightContinuationEvidence(task, capability, learningResume) {
    const platformFailure = LEARNING_RESUME_PLATFORM_FAILURES.get(task.execution?.id);
    if (!learningResume || !platformFailure || task.execution?.phase !== 'failed' || task.execution?.stopReason !== 'permanent_error'
      || platformFailure.expectedCalls === undefined && (task.execution.startedAt !== null || task.execution.deadlineAt !== null)
      || capability.schemaVersion !== 1 || capability.projectId !== PROJECT_ID || capability.goalVersionId !== helpers.activeGoal(task).id
      || capability.development?.cap !== 2 || capability.development?.windowMs !== 20 * 60_000 || capability.development?.mode !== 'developer_reviewer'
      || capability.development?.batchId !== platformFailure.batchId || capability.learning?.enabled !== false
      || task.execution?.repair?.repairKind !== 'learning_resume' || capability.development?.executionId !== task.execution.id || capability.development?.enabled !== false) return null;
    const ledgerFile = path.resolve(capability.development?.ledgerFile || ''), stateRoot = await fs.realpath(path.dirname(capabilityFile));
    if (path.dirname(path.dirname(ledgerFile)) !== stateRoot || path.basename(path.dirname(ledgerFile)) !== platformFailure.batchId) return null;
    const ledgerStat = await fs.lstat(ledgerFile); if (!ledgerStat.isFile() || ledgerStat.isSymbolicLink() || ledgerStat.nlink !== 1 || await fs.realpath(ledgerFile) !== ledgerFile) return null;
    const ledgerBytes = await fs.readFile(ledgerFile), ledger = JSON.parse(ledgerBytes);
    if (sha256(ledgerBytes) !== platformFailure.ledgerSha256 || ledger.cap !== 2 || ledger.windowMs !== 20 * 60_000
      || ledger.calls?.length !== (platformFailure.expectedCalls ?? 0) || ledger.sealed?.reasonCode !== platformFailure.reasonCode) return null;
    if (platformFailure.expectedCalls === 1) {
      const call = ledger.calls[0];
      if (call.expectedRole !== 'developer' || call.status !== 'completed' || call.exitCode !== null || call.signal !== platformFailure.expectedSignal
        || call.declaredStatus !== 'failed' || call.semanticFailureReason !== platformFailure.reasonCode || call.stdout?.sha256 !== platformFailure.expectedStdoutSha256
        || call.stdout?.bytes !== 0 || !task.execution?.deadlineAt || Date.parse(call.completedAt) < Date.parse(task.execution.deadlineAt)) return null;
    }
    const evidenceRoot = path.join(path.dirname(projectFile), 'evidence'), rootFile = path.join(evidenceRoot, platformFailure.rootFile), independentFile = path.join(evidenceRoot, platformFailure.independentFile);
    const additionalFiles = (platformFailure.additionalEvidence || []).map(([name]) => path.join(evidenceRoot, name));
    for (const file of [rootFile, independentFile, ...additionalFiles]) { const stat = await fs.lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 128_000 || await fs.realpath(file) !== file) return null; }
    const rootBytes = await fs.readFile(rootFile), independentBytes = await fs.readFile(independentFile);
    if (sha256(rootBytes) !== platformFailure.rootSha256 || sha256(independentBytes) !== platformFailure.independentSha256) return null;
    for (let index = 0; index < additionalFiles.length; index += 1) if (sha256(await fs.readFile(additionalFiles[index])) !== platformFailure.additionalEvidence[index][1]) return null;
    const binding = task.execution.repair;
    if (binding.failedLearningCandidateSha256 !== learningResume.candidateSha256 || binding.failedLearningLedgerSha256 !== learningResume.learningLedgerSha256
      || binding.failedLearningEvidenceSha256 !== learningResume.rootEvidenceSha256) return null;
    return { executionId: task.execution.id, ledgerSha256: sha256(ledgerBytes), rootEvidenceSha256: sha256(rootBytes), independentEvidenceSha256: sha256(independentBytes), ...platformFailure };
  }

  async function reviewerFailureEvidence(task, capability) {
    const artifact = (task.artifacts || []).filter((entry) => ['candidate', 'rejected'].includes(entry.status) && helpers.projectArtifactIsCurrent(task, entry)).at(-1);
    if (!artifact || (task.approvals || []).some((entry) => entry.artifactId === artifact.id && entry.status === 'confirmed')) return null;
    if (capability.development?.executionId && capability.development.executionId !== task.execution?.id) return null;
    if (capability.candidateSha256 !== artifact.projectCandidate?.candidateSha256) return null;
    const reservation = (task.events || []).findLast((entry) => entry.type === 'integration.run_reserved' && entry.detail?.actor === 'reviewer' && entry.detail?.executionId === task.execution?.id && entry.detail?.candidateSha256 === artifact.projectCandidate?.candidateSha256);
    if (!reservation) return null;
    const ledgerFile = path.resolve(capability.development?.ledgerFile || ''), stat = await fs.lstat(ledgerFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024 || await fs.realpath(ledgerFile) !== ledgerFile) return null;
    const ledger = JSON.parse(await fs.readFile(ledgerFile, 'utf8')), call = ledger.calls?.find((entry) => entry.expectedRole === 'reviewer');
    if (ledger.cap !== 2 || ledger.windowMs !== 20 * 60_000 || ledger.sealed?.reasonCode !== 'native_reviewer_not_passed' || call?.status !== 'completed' || call.declaredStatus !== 'failed' || call.semanticFailureReason !== 'native_reviewer_not_passed' || !call.stdout?.file || !/^[a-f0-9]{64}$/.test(call.stdout.sha256 || '')) return null;
    const outputFile = path.resolve(path.dirname(ledgerFile), call.stdout.file);
    if (!outputFile.startsWith(`${path.dirname(ledgerFile)}${path.sep}`)) return null;
    const outputStat = await fs.lstat(outputFile); if (!outputStat.isFile() || outputStat.isSymbolicLink() || outputStat.nlink !== 1 || outputStat.size > 40_000 || await fs.realpath(outputFile) !== outputFile) return null;
    const bytes = await fs.readFile(outputFile), rawText = bytes.toString('utf8');
    if (sha256(bytes) !== call.stdout.sha256 || call.stdout.bytes !== undefined && call.stdout.bytes !== bytes.length) return null;
    const outcome = classifyReviewerOutcome(ledger, call, rawText); if (!outcome) return null;
    return { artifact, reservation, ...outcome, rawTextSha256: sha256(bytes), textSha256: sha256(outcome.text), ledgerSha256: sha256(await fs.readFile(ledgerFile)) };
  }

  async function reviewFailureContinuationEvidence(task, capability, rejected) {
    const registered = REVIEW_FAILURE_CONTINUATIONS.get(task.execution?.id);
    if (!registered || !rejected || task.execution?.phase !== 'failed' || task.execution?.stopReason !== 'permanent_error'
      || task.execution?.repair?.batchId !== registered.batchId || capability.development?.enabled !== false
      || capability.development?.executionId !== task.execution.id || capability.development?.batchId !== registered.batchId
      || rejected.artifact?.projectCandidate?.candidateSha256 !== registered.candidateSha256 || rejected.ledgerSha256 !== registered.ledgerSha256
      || rejected.verdict !== 'FAIL' || rejected.rawTextSha256 !== registered.reviewerOutputSha256) return null;
    await assertCandidateCurrent(task, rejected.artifact);
    const projectRoot = path.dirname(projectFile), evidenceRoot = path.join(projectRoot, 'evidence'), verified = new Map();
    for (const entry of reviewContinuationFiles(registered)) {
      const root = entry.root === 'evidence' ? evidenceRoot : projectRoot, file = path.resolve(root, entry.file);
      if (!file.startsWith(`${root}${path.sep}`)) return null;
      const stat = await fs.lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 128_000 || await fs.realpath(file) !== file) return null;
      const bytes = await fs.readFile(file); if (sha256(bytes) !== entry.sha256) return null; verified.set(`${entry.root}:${entry.file}`, entry.sha256);
    }
    if (fingerprint(await manifest(workspaceRoot)) !== registered.candidateSha256) return null;
    return { ...registered, executionId: task.execution.id, rootEvidenceSha256: verified.get(`evidence:${registered.rootFile}`), independentEvidenceSha256: verified.get(`evidence:${registered.independentFile}`), verifiedBoundFiles: [...verified.values()] };
  }

  async function reusableDeveloperEvidence(task, capability) {
    if ((task.artifacts || []).some((entry) => ['candidate','confirmed'].includes(entry.status) && helpers.projectArtifactIsCurrent(task, entry))) return null;
    const rejectedArtifact = (task.artifacts || []).filter((entry) => entry.status === 'rejected' && helpers.projectArtifactIsCurrent(task, entry)).at(-1);
    const hostFailure = (task.events || []).findLast((entry) => entry.type === 'integration.host_client_check_failed' && entry.detail?.executionId === task.execution?.id);
    const hostRejected = Boolean(rejectedArtifact && hostFailure
      && hostFailure.detail?.artifactId === rejectedArtifact.id
      && hostFailure.detail?.candidateSha256 === rejectedArtifact.projectCandidate?.candidateSha256
      && rejectedArtifact.hostClientAcceptance?.passed === false
      && rejectedArtifact.hostClientAcceptance?.evidenceSha256 === hostFailure.detail?.evidenceSha256
      && rejectedArtifact.hostClientAcceptance?.ledgerSha256 === hostFailure.detail?.ledgerSha256
      && hostFailure.detail?.reasonCode === 'host_native_client_check_failed'
      && hostFailure.detail?.nativeModelCalls === 0 && hostFailure.detail?.actualBrowser === false
      && !(task.approvals || []).some((entry) => entry.artifactId === rejectedArtifact.id && entry.status === 'confirmed'));
    const dispatchFailure = (task.events || []).findLast((entry) => entry.type === 'integration.auto_review_dispatch_failed' && entry.detail?.executionId === task.execution?.id);
    const dispatchRejected = Boolean(rejectedArtifact && dispatchFailure
      && dispatchFailure.detail?.artifactId === rejectedArtifact.id
      && dispatchFailure.detail?.candidateSha256 === rejectedArtifact.projectCandidate?.candidateSha256
      && rejectedArtifact.autoReviewDispatch?.failed === true
      && rejectedArtifact.autoReviewDispatch?.dispatchEventId === dispatchFailure.detail?.dispatchEventId
      && !(task.approvals || []).some((entry) => entry.artifactId === rejectedArtifact.id && entry.status === 'confirmed'));
    if (capability.development?.executionId !== task.execution?.id || (capability.candidateSha256 && (!(hostRejected || dispatchRejected) || capability.candidateSha256 !== rejectedArtifact.projectCandidate.candidateSha256))) return null;
    const done = (task.events || []).findLast((entry) => entry.type === 'integration.observation' && entry.detail?.type === 'TASK_DONE' && entry.detail?.actor === 'developer' && entry.detail?.binding?.executionId === task.execution?.id);
    const reservation = (task.events || []).findLast((entry) => entry.type === 'integration.run_reserved' && entry.detail?.actor === 'developer' && entry.detail?.executionId === task.execution?.id && entry.detail?.sourceTaskId === done?.detail?.sourceTaskId);
    if (!done || !reservation) return null;
    const ledgerFile = path.resolve(capability.development.ledgerFile || ''), bytes = await fs.readFile(ledgerFile), ledger = JSON.parse(bytes), call = ledger.calls?.find((entry) => entry.expectedRole === 'developer');
    const acceptedSeal = ledger.sealed?.reasonCode === 'native_terminal_or_host_rejected'
      || hostRejected && ledger.sealed?.reasonCode === 'host_native_client_check_failed' && sha256(bytes) === hostFailure.detail.ledgerSha256
      || dispatchRejected && ['auto_review_dispatch_failed','platform_auto_review_dispatch_failed'].includes(ledger.sealed?.reasonCode) && sha256(bytes) === dispatchFailure.detail.sealedLedgerSha256;
    if (ledger.cap !== 2 || ledger.windowMs !== 20 * 60_000 || !acceptedSeal || ledger.calls?.length !== 1 || call?.status !== 'completed' || call.exitCode !== 0 || call.signal || call.declaredStatus !== 'done' || call.semanticFailureReason || !call.stdout?.file
      || (hostRejected || dispatchRejected) && (task.events || []).some((entry) => entry.type === 'integration.run_reserved' && entry.detail?.actor === 'reviewer' && entry.detail?.executionId === task.execution?.id)) return null;
    const outputFile = path.resolve(path.dirname(ledgerFile), call.stdout.file);
    if (!outputFile.startsWith(`${path.dirname(ledgerFile)}${path.sep}`)) return null;
    const outputStat = await fs.lstat(outputFile);
    if (!outputStat.isFile() || outputStat.isSymbolicLink() || outputStat.nlink !== 1 || outputStat.size > 40_000 || await fs.realpath(outputFile) !== outputFile) return null;
    const output = await fs.readFile(outputFile);
    if (sha256(output) !== call.stdout.sha256 || call.stdout.bytes !== undefined && call.stdout.bytes !== output.length) return null;
    const current = await manifest(workspaceRoot), candidateSha256 = fingerprint(current);
    if ((hostRejected || dispatchRejected) && candidateSha256 !== rejectedArtifact.projectCandidate.candidateSha256) return null;
    const candidateFiles = current.map((entry) => entry.path).sort(), reportedChangedFiles = [...new Set(done.detail.changedFiles || [])].sort();
    if (!reportedChangedFiles.length || reportedChangedFiles.some((file) => !candidateFiles.includes(file))) return null;
    await reviewDiff(workspaceRoot, candidateFiles);
    return { done, reservation, ledgerSha256: sha256(bytes), developerOutputSha256: call.stdout.sha256, candidateSha256, changedFiles: reportedChangedFiles, candidateFiles };
  }

  function recordRejectedReview(task, evidence) {
    const existing = (task.reviews || []).findLast((entry) => entry.artifactId === evidence.artifact.id && entry.nativeVerdict === evidence.verdict);
    if (existing) return existing;
    const facts = helpers.createTrustedProjectReviewFacts(task, evidence.artifact);
    const checks = [{ name: '已确认教学核心', passed: false, evidence: evidence.verdict === 'FAIL' ? 'Bound native readonly Reviewer returned FAIL for the exact candidate.' : 'Bound native readonly Reviewer did not complete before the shared deadline and returned no verdict.', blocking: true }];
    const review = helpers.recordReview(task, evidence.artifact.id, { checks, summary: evidence.text, provider: 'codex-cli' }, { projectReviewFacts: facts });
    review.nativeVerdict = evidence.verdict; review.scopeOutcome = evidence.scopeOutcome; review.sourceTaskId = evidence.reservation.detail.sourceTaskId; review.fullOutputSha256 = evidence.textSha256; review.rawOutputSha256 = evidence.rawTextSha256 || evidence.textSha256; review.projectCandidateFingerprint = helpers.projectCandidateFingerprint(evidence.artifact.projectCandidate);
    helpers.event(task, 'integration.candidate_rejected', evidence.verdict === 'FAIL' ? '当前精确候选被原生只读Reviewer判定为FAIL；完整原始意见保留，允许显式开启下一有界修复。' : '当前精确候选的只读Reviewer在共享时限内未完成且没有返回判定；候选按未审完历史保留，允许显式开启下一有界修复。', { artifactId: evidence.artifact.id, candidateSha256: evidence.artifact.projectCandidate.candidateSha256, reviewerOutcome: evidence.verdict, reviewSha256: evidence.textSha256, rawOutputSha256: evidence.rawTextSha256 || evidence.textSha256, sourceTaskId: evidence.reservation.detail.sourceTaskId });
    evidence.artifact.status = 'rejected'; evidence.artifact.reviewStatus = 'failed';
    return review;
  }

  async function openRepairBatch(taskId, input, cleanActivation = null) {
    if (cleanActivation) await cleanInputs.assertActive(cleanActivation);
    if (!['preserve_failed_batch','preserve_failed_learning_contract','preserve_failed_learning_resume'].includes(input?.acknowledgement) || input.maxModelCalls !== 2 || input.maxDurationMs !== 20 * 60_000) throw Object.assign(new Error('Repair acknowledgement or budget is invalid'), { status: 400 });
    const task = await store.get(taskId), goal = helpers.activeGoal(task), capabilityBytesAtStart = await fs.readFile(capabilityFile), capability = JSON.parse(capabilityBytesAtStart), project = await loadProject();
    if (task.execution?.id === CLEAN_INPUT35.failedExecutionId && !cleanActivation) throw Object.assign(new Error('Host-rejected sample46 requires the separately prepared clean35 input; no batch was opened'), { status:409 });
    const latestConfirmation = (task.events || []).findLast((entry) => entry.type === 'intake.goal_confirmed');
    if (latestConfirmation?.detail?.goalVersionId !== goal.id || canonical({ statement: goal.statement, successCriteria: goal.successCriteria, boundaries: goal.boundaries }) !== canonical(project.goalDraft)) throw Object.assign(new Error('新增需求尚未通过产品确认目标。'), { status: 409 });
    const expected = ['expectedGoalVersionId','expectedFailedExecutionId','expectedScopeFingerprint','expectedPriorLedgerSha256','expectedSourceSnapshotSha256'];
    if (expected.some((key) => typeof input?.[key] !== 'string')) throw Object.assign(new Error('Repair binding is incomplete'), { status: 400 });
    const repairManifest = await repairInputManifest(workspaceRoot), repairInputManifestSha256 = fingerprint(repairManifest), rejected = await reviewerFailureEvidence(task, capability), reusable = input.reviewOnly === true ? await reusableDeveloperEvidence(task, capability) : null, goalIncrementRepair = Boolean(task.execution?.increment || task.execution?.repair?.goalIncrementRepair);
    const reviewFailureContinuation = await reviewFailureContinuationEvidence(task, capability, rejected);
    if (goalIncrementRepair && input.reviewOnly !== true && typeof input.optInBoundedAutoReview !== 'boolean') throw Object.assign(new Error('Goal-increment repair must explicitly choose bounded automatic review'), { status: 400 });
    const learningContract = input.repairKind === 'learning_contract' ? await learningContractRepairEvidence(task, capability) : null;
    const learningResume = input.repairKind === 'learning_resume' ? await learningResumeRepairEvidence(task, capability) : null;
    const learningResumeContinuation = learningResume ? await learningResumePreflightContinuationEvidence(task, capability, learningResume) : null;
    if (learningResume && LEARNING_RESUME_PLATFORM_FAILURES.has(task.execution?.id) && !learningResumeContinuation) throw Object.assign(new Error('Failed learning-resume platform evidence is stale or incomplete'), { status: 409 });
    const learning08Continuation = learningContract?.batchId === 'learning-08';
    if (input.repairKind === 'learning_contract' && (input.acknowledgement !== 'preserve_failed_learning_contract' || !learningContract || input.expectedFailedCandidateSha256 !== learningContract.candidateSha256
      || input.expectedLearningLedgerSha256 !== learningContract.learningLedgerSha256 || input.expectedLearningEvidenceSha256 !== learningContract.evidenceSha256
      || input.expectedFailedTurnId !== learningContract.turnId)) throw Object.assign(new Error('Learning contract repair binding is stale or unsupported'), { status: 409 });
    if (input.repairKind === 'learning_resume' && (input.acknowledgement !== 'preserve_failed_learning_resume' || !learningResume || input.expectedFailedCandidateSha256 !== learningResume.candidateSha256
      || input.expectedLearningLedgerSha256 !== learningResume.learningLedgerSha256 || input.expectedRootEvidenceSha256 !== learningResume.rootEvidenceSha256
      || input.expectedIndependentEvidenceSha256 !== learningResume.independentEvidenceSha256 || input.expectedSavedEventId !== learningResume.savedEventId)) throw Object.assign(new Error('Learning resume repair binding is stale or unsupported'), { status: 409 });
    if (learningResumeContinuation && (input.expectedFailedPlatformExecutionId !== learningResumeContinuation.executionId || input.expectedFailedPlatformLedgerSha256 !== learningResumeContinuation.ledgerSha256
      || input.expectedFailedPlatformRootEvidenceSha256 !== learningResumeContinuation.rootEvidenceSha256 || input.expectedFailedPlatformIndependentEvidenceSha256 !== learningResumeContinuation.independentEvidenceSha256
      || input.repairBriefFile !== learningResumeContinuation.briefFile || input.expectedRepairBriefSha256 !== learningResumeContinuation.briefSha256)) {
      const briefLabel = /-R(16|17)\.md$/.exec(learningResumeContinuation.briefFile)?.[1];
      throw Object.assign(new Error(`${learningResumeContinuation.nextBatchId} requires the exact registered ${briefLabel ? `R${briefLabel}` : learningResumeContinuation.briefFile} and failed platform-entry binding`), { status: 409 });
    }
    if (learningResume && !learningResumeContinuation && (input.repairBriefFile !== 'SAMPLE-REPAIR-BRIEF-sample-date-R15.md' || input.expectedRepairBriefSha256 !== '759336b02e1bf13dba1fce060bf31a97dda947ce10986945fa063ce5ab28d2d4')) throw Object.assign(new Error('Learning-09 resume repair requires the exact registered R15 brief'), { status: 409 });
    if (learningContract?.evidenceSha256 === 'cb6c27e25286827ff8506b49fd8eee5845bbfb79d265056c50a397c2230e5813'
      && (input.repairBriefFile !== 'SAMPLE-REPAIR-BRIEF-sample-date-R7.md'
        || input.expectedRepairBriefSha256 !== '91bc71bb7de48f07b09bda0da9196f0020aefd01550a0c1c87ad346c5f3d4481')) {
      throw Object.assign(new Error('Learning-06 repair requires the exact registered R7 brief'), { status: 409 });
    }
    if (learning08Continuation && (input.repairBriefFile !== 'SAMPLE-REPAIR-BRIEF-sample-date-R13.md'
      || input.expectedRepairBriefSha256 !== '75a8694e990c09a62cf01c0078ab42efa9bc329b1f167c445a48ae3959a5b4f7')) throw Object.assign(new Error('Learning-08 repair requires the exact registered R13 brief'), { status: 409 });
    if (REVIEW_FAILURE_CONTINUATIONS.has(task.execution?.id) && (!reviewFailureContinuation || input.repairBriefFile !== reviewFailureContinuation.briefFile
      || input.expectedRepairBriefSha256 !== reviewFailureContinuation.briefSha256)) throw Object.assign(new Error(`Review-failure continuation requires the ${REVIEW_FAILURE_CONTINUATIONS.get(task.execution?.id)?.errorLabel || 'exact registered'} evidence and brief`), { status: 409 });
    if (!['learning_contract','learning_resume'].includes(input.repairKind) && input.acknowledgement !== 'preserve_failed_batch') throw Object.assign(new Error('Repair acknowledgement does not match the repair kind'), { status: 400 });
    if (input.reviewOnly === true && (!reusable || input.expectedCandidateSha256 !== reusable.candidateSha256)) throw Object.assign(new Error('Review-only candidate binding is stale or unsupported'), { status: 409 });
    if (goal.id !== input.expectedGoalVersionId || task.execution?.id !== input.expectedFailedExecutionId || (!learning08Continuation && !learningResume && task.execution?.stopReason !== 'permanent_error')
      || task.projectWorkspace?.scopeFingerprint !== input.expectedScopeFingerprint || repairInputManifestSha256 !== input.expectedSourceSnapshotSha256
      || !helpers.projectWorkspaceIsCurrent(task) || capability.development?.enabled !== false) throw Object.assign(new Error('Repair proposal is stale'), { status: 409 });
    if ((task.artifacts || []).some((a) => ['candidate', 'confirmed'].includes(a.status) && helpers.projectArtifactIsCurrent(task, a)) && !rejected && !learningContract && !learningResume) throw Object.assign(new Error('Current candidate is not eligible for this repair'), { status: 409 });
    if (!rejected && !reusable && input.reviewOnly === true) throw Object.assign(new Error('Review-only repair evidence is unavailable'), { status: 409 });
    const priorFile = path.resolve(capability.development.ledgerFile || ''), stateRoot = await fs.realpath(path.dirname(capabilityFile));
    const match = /sample-batch-(\d{2,4})\/model-ledger\.json$/.exec(priorFile.replaceAll(path.sep, '/'));
    if (!match || path.dirname(path.dirname(priorFile)) !== stateRoot) throw new Error('Prior development ledger path is invalid');
    const priorStat = await fs.lstat(priorFile); if (!priorStat.isFile() || priorStat.isSymbolicLink() || priorStat.nlink !== 1 || priorStat.size > 1024 * 1024 || await fs.realpath(priorFile) !== priorFile) throw new Error('Prior development ledger is invalid');
    const priorBytes = await fs.readFile(priorFile), priorLedger = JSON.parse(priorBytes);
    const learning08SuccessfulDevelopment = (learning08Continuation || learningResume) && !priorLedger.sealed && priorLedger.cap === 2 && priorLedger.windowMs === 20 * 60_000 && priorLedger.calls?.length === 2
      && priorLedger.calls.every((call, index) => call.expectedRole === ['developer','reviewer'][index] && call.status === 'completed' && call.exitCode === 0 && !call.signal && call.declaredStatus === 'done')
      && capability.development?.executionId === task.execution?.id && capability.development?.enabled === false;
    if (sha256(priorBytes) !== input.expectedPriorLedgerSha256 || (!priorLedger.sealed && !learning08SuccessfulDevelopment) || priorLedger.calls?.some((call) => ['reserved','running'].includes(call.status))) throw Object.assign(new Error('Prior development ledger is not safely closed at the acknowledged digest'), { status: 409 });
    const ordinal = Number(match[1]) + 1, batchId = `sample-batch-${String(ordinal).padStart(2, '0')}`;
    if (!Number.isInteger(ordinal) || ordinal > 9999 || match[1] !== String(ordinal - 1).padStart(2, '0')) throw new Error('Prior development batch number is invalid');
    const exactDevelopment35 = batchId === 'sample-batch-35' && input.expectedFailedExecutionId === 'run-00000000-0000-4000-8000-000000000025'
      && input.expectedPriorLedgerSha256 === '336b5f93bb74f1ed2998b056f9fcee2ca8439e656cbc92941962313c2d9788ab';
    if (exactDevelopment35 && (input.repairBriefFile !== 'SAMPLE-REPAIR-BRIEF-sample-date-R14.md'
      || input.expectedRepairBriefSha256 !== 'eb58603da37cda8411d1604064ef5912e109af3cc1232f0d07111d5fc6eddd09')) throw Object.assign(new Error('Development-35 requires the exact registered R14 brief'), { status: 409 });
    const allowedP0Briefs = new Set(['SAMPLE-REPAIR-BRIEF-sample-date.md','SAMPLE-REPAIR-BRIEF-sample-date-R2.md','SAMPLE-REPAIR-BRIEF-sample-date-R3.md','SAMPLE-REPAIR-BRIEF-sample-date-R4.md','SAMPLE-REPAIR-BRIEF-sample-date-R5.md','SAMPLE-REPAIR-BRIEF-sample-date-R6.md','SAMPLE-REPAIR-BRIEF-sample-date-R7.md','SAMPLE-REPAIR-BRIEF-sample-date-R8.md','SAMPLE-REPAIR-BRIEF-sample-date-R9.md','SAMPLE-REPAIR-BRIEF-sample-date-R10.md','SAMPLE-REPAIR-BRIEF-sample-date-R11.md','SAMPLE-REPAIR-BRIEF-sample-date-R12.md','SAMPLE-REPAIR-BRIEF-sample-date-R13.md','SAMPLE-REPAIR-BRIEF-sample-date-R14.md','SAMPLE-REPAIR-BRIEF-sample-date-R15.md','SAMPLE-REPAIR-BRIEF-sample-date-R16.md','SAMPLE-REPAIR-BRIEF-sample-date-R17.md']);
    if (learningResumeContinuation?.nextBatchId === 'sample-batch-39') allowedP0Briefs.add('SAMPLE-MINIMAL-RETEST-TASK-sample-date.md');
    if (reviewFailureContinuation) allowedP0Briefs.add(reviewFailureContinuation.briefFile);
    if (cleanActivation) allowedP0Briefs.add(CLEAN_INPUT35.briefFile);
    const repairBriefFile = goalIncrementRepair ? (input.repairBriefFile || 'SAMPLE-REPAIR-BRIEF-sample-date.md') : 'NEXT-MINIMAL-REPAIR-BRIEF-20261005.md';
    if (goalIncrementRepair && !allowedP0Briefs.has(repairBriefFile)) throw Object.assign(new Error('P0 repair brief is not allowlisted'), { status: 400 });
    const briefFile = path.join(path.dirname(projectFile), 'evidence', repairBriefFile);
    let repairBrief = null, repairBriefSha256 = null;
    if (input.reviewOnly !== true) try {
      const briefStat = await fs.lstat(briefFile); if (!briefStat.isFile() || briefStat.isSymbolicLink() || briefStat.nlink !== 1 || briefStat.size > 48_000 || await fs.realpath(briefFile) !== briefFile) throw new Error('Registered repair brief is invalid');
      const briefBytes = await fs.readFile(briefFile); repairBrief = briefBytes.toString('utf8'); repairBriefSha256 = sha256(briefBytes);
      if (goalIncrementRepair && input.expectedRepairBriefSha256 && input.expectedRepairBriefSha256 !== repairBriefSha256) throw Object.assign(new Error('P0 repair brief digest is stale'), { status: 409 });
    } catch (error) { if (goalIncrementRepair || error?.code !== 'ENOENT') throw error; }
    const batchRoot = path.join(stateRoot, batchId), archiveRoot = path.join(batchRoot, cleanActivation ? 'prepared-clean35-input' : 'prior-failed-workspace');
    await fs.mkdir(batchRoot, { recursive: false, mode: 0o700 });
    await fs.cp(workspaceRoot, archiveRoot, { recursive: true, errorOnExist: true, force: false });
    if (fingerprint(await repairInputManifest(archiveRoot)) !== repairInputManifestSha256 || fingerprint(await repairInputManifest(workspaceRoot)) !== repairInputManifestSha256) throw new Error('Repair input changed during archive');
    await fs.writeFile(path.join(batchRoot, 'repair-input-manifest.json'), `${JSON.stringify(repairManifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await fs.writeFile(path.join(batchRoot, 'prior-task-execution.json'), `${JSON.stringify({ taskId, execution: task.execution }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    const nextLedgerFile = path.join(batchRoot, 'model-ledger.json');
    const result = (await store.mutate(taskId, async (current) => {
      const currentGoal = helpers.activeGoal(current), specialLearningRepair = Boolean(learning08Continuation || learningResume), specialBoundRepair = Boolean(specialLearningRepair || reviewFailureContinuation), lockedCapability = specialBoundRepair ? await loadCapability() : null;
      const lockedLearningContract = learning08Continuation ? await learningContractRepairEvidence(current, lockedCapability) : null;
      const lockedLearningResume = learningResume ? await learningResumeRepairEvidence(current, lockedCapability) : null;
      const lockedLearningResumeContinuation = learningResumeContinuation ? await learningResumePreflightContinuationEvidence(current, lockedCapability, lockedLearningResume) : null;
      const lockedRejected = reviewFailureContinuation ? await reviewerFailureEvidence(current, lockedCapability) : null;
      const lockedReviewFailureContinuation = reviewFailureContinuation ? await reviewFailureContinuationEvidence(current, lockedCapability, lockedRejected) : null;
      const lockedPriorBytes = specialBoundRepair ? await fs.readFile(priorFile) : null;
      const lockedPrior = lockedPriorBytes ? JSON.parse(lockedPriorBytes) : null;
      const lockedSuccessfulDevelopment = learningResumeContinuation ? Boolean(lockedLearningResumeContinuation) && sha256(lockedPriorBytes) === input.expectedPriorLedgerSha256
        : reviewFailureContinuation ? Boolean(lockedReviewFailureContinuation) && sha256(lockedPriorBytes) === input.expectedPriorLedgerSha256
        : !specialLearningRepair || sha256(lockedPriorBytes) === input.expectedPriorLedgerSha256 && !lockedPrior.sealed
        && lockedPrior.cap === 2 && lockedPrior.windowMs === 20 * 60_000 && lockedPrior.calls?.length === 2
        && lockedPrior.calls.every((call, index) => call.expectedRole === ['developer','reviewer'][index] && call.status === 'completed' && call.exitCode === 0 && !call.signal && call.declaredStatus === 'done')
        && lockedCapability.development?.enabled === false && lockedCapability.development?.executionId === input.expectedFailedExecutionId;
      const lockedBriefSha256 = exactDevelopment35 ? sha256(await fs.readFile(path.join(path.dirname(projectFile), 'evidence', 'SAMPLE-REPAIR-BRIEF-sample-date-R14.md'))) : null;
      const lockedResumeBriefSha256 = learningResume && !learningResumeContinuation ? sha256(await fs.readFile(path.join(path.dirname(projectFile), 'evidence', 'SAMPLE-REPAIR-BRIEF-sample-date-R15.md'))) : null;
      const lockedResumeContinuationBriefSha256 = learningResumeContinuation ? sha256(await fs.readFile(path.join(path.dirname(projectFile), 'evidence', learningResumeContinuation.briefFile))) : null;
      const lockedReviewContinuationBriefSha256 = reviewFailureContinuation ? sha256(await fs.readFile(path.join(path.dirname(projectFile), 'evidence', reviewFailureContinuation.briefFile))) : null;
      if (currentGoal.id !== goal.id || current.execution?.id !== input.expectedFailedExecutionId || (!specialLearningRepair && current.execution?.stopReason !== 'permanent_error')
        || learning08Continuation && (lockedLearningContract?.evidenceSha256 !== learningContract.evidenceSha256 || lockedLearningContract?.learningLedgerSha256 !== learningContract.learningLedgerSha256)
        || learningResume && (lockedLearningResume?.rootEvidenceSha256 !== learningResume.rootEvidenceSha256 || lockedLearningResume?.independentEvidenceSha256 !== learningResume.independentEvidenceSha256 || lockedLearningResume?.learningLedgerSha256 !== learningResume.learningLedgerSha256)
        || learningResumeContinuation && (lockedLearningResumeContinuation?.executionId !== learningResumeContinuation.executionId || lockedLearningResumeContinuation?.ledgerSha256 !== learningResumeContinuation.ledgerSha256
          || lockedLearningResumeContinuation?.rootEvidenceSha256 !== learningResumeContinuation.rootEvidenceSha256 || lockedLearningResumeContinuation?.independentEvidenceSha256 !== learningResumeContinuation.independentEvidenceSha256)
        || reviewFailureContinuation && (lockedReviewFailureContinuation?.executionId !== reviewFailureContinuation.executionId || lockedReviewFailureContinuation?.ledgerSha256 !== reviewFailureContinuation.ledgerSha256
          || lockedReviewFailureContinuation?.rootEvidenceSha256 !== reviewFailureContinuation.rootEvidenceSha256 || lockedReviewFailureContinuation?.independentEvidenceSha256 !== reviewFailureContinuation.independentEvidenceSha256)
        || !lockedSuccessfulDevelopment
        || exactDevelopment35 && (repairBriefFile !== 'SAMPLE-REPAIR-BRIEF-sample-date-R14.md' || repairBriefSha256 !== lockedBriefSha256 || lockedBriefSha256 !== 'eb58603da37cda8411d1604064ef5912e109af3cc1232f0d07111d5fc6eddd09')
        || learningResume && !learningResumeContinuation && (repairBriefFile !== 'SAMPLE-REPAIR-BRIEF-sample-date-R15.md' || repairBriefSha256 !== lockedResumeBriefSha256 || lockedResumeBriefSha256 !== '759336b02e1bf13dba1fce060bf31a97dda947ce10986945fa063ce5ab28d2d4')
        || learningResumeContinuation && (batchId !== learningResumeContinuation.nextBatchId || repairBriefFile !== learningResumeContinuation.briefFile || repairBriefSha256 !== lockedResumeContinuationBriefSha256 || lockedResumeContinuationBriefSha256 !== learningResumeContinuation.briefSha256)
        || reviewFailureContinuation && (batchId !== reviewFailureContinuation.nextBatchId || repairBriefFile !== reviewFailureContinuation.briefFile || repairBriefSha256 !== lockedReviewContinuationBriefSha256 || lockedReviewContinuationBriefSha256 !== reviewFailureContinuation.briefSha256)
        || current.projectWorkspace?.scopeFingerprint !== input.expectedScopeFingerprint || fingerprint(await repairInputManifest(workspaceRoot)) !== input.expectedSourceSnapshotSha256
        || !helpers.projectWorkspaceIsCurrent(current)) throw Object.assign(new Error('Repair proposal changed during archive'), { status: 409 });
      if (rejected) recordRejectedReview(current, { ...rejected, artifact: (current.artifacts || []).find((entry) => entry.id === rejected.artifact.id) });
      helpers.startExecution(current, goal.id, { maxModelCalls: 2, maxDurationMs: 20 * 60_000, maxAttemptsPerStep: 1, maxPlanRevisions: 0 });
      const repair = { batchId, batchOrdinal: ordinal, repairOfExecutionId: input.expectedFailedExecutionId, priorLedgerSha256: input.expectedPriorLedgerSha256, scopeFingerprint: input.expectedScopeFingerprint, repairInputManifestSha256, goalIncrementRepair, priorReviewerFailureText: rejected?.text || null, priorReviewerOutcome: rejected?.verdict || null, repairBrief, repairBriefFile, repairBriefSha256,
        storageInputBinding: reviewFailureContinuation?.storageInputOnly ? (reviewFailureContinuation.nextBatchId === STORAGE_REPAIR49.nextBatchId ? storage49InputBinding() : storage48InputBinding()) : null,
        cleanInputBinding: cleanActivation ? { preparedId:cleanActivation.record.preparedId, inputCandidateSha256:CLEAN_INPUT35.inputCandidateSha256, failedWorkspaceFingerprint:CLEAN_INPUT35.failedWorkspaceFingerprint, preservedFailedWorkspaceRelativePath:path.relative(path.dirname(projectFile),cleanActivation.archiveRoot), allowedChangedFiles:[...CLEAN_INPUT35.allowedChangedFiles], registrationSha256:cleanActivation.record.registrationSha256 } : null,
        platformContinuationNote: learningResumeContinuation?.nextBatchId === 'sample-batch-39' ? `Current owner authorization supersedes only the repair brief's historical pending-status sentence: this exact sample-batch-39 Developer plus automatic readonly Reviewer batch is authorized for at most two calls in one 20-minute window. Implement code and final static checks only; do not invoke models, learning inference, deployment, or an independent review yourself. Required frozen UI gate: ${learningResumeContinuation.uiGateFile} SHA-256 ${learningResumeContinuation.uiGateSha256}. From P12 run exactly: node tools/sample39-explicit-resume-ui-regression-zero-model-v2.mjs --workspace "$WORKSPACE" --mode candidate --evidence /tmp/sample39-ui-gate-v2-candidate.json. Report done only when exit is 0 and report.passed, productContinuationPassed, every case is true, and completed prepared rows are absent from both live and saved state; also run the unchanged registered sample-batch-34 and sample-batch-35 companion checks.`
          : reviewFailureContinuation ? reviewContinuationPrompt(reviewFailureContinuation) : null,
        learningContractFailure: learningContract ? { batchId: learningContract.batchId || null, candidateSha256: learningContract.candidateSha256, ledgerSha256: learningContract.learningLedgerSha256, evidenceSha256: learningContract.evidenceSha256, turnId: learningContract.turnId, actualFailure: learningContract.evidence.actualFailure, conclusion: learningContract.evidence.conclusion, smallestNextChange: learningContract.evidence.smallestNextChange } : null,
        learningResumeFailure: learningResume ? { candidateSha256: learningResume.candidateSha256, ledgerSha256: learningResume.learningLedgerSha256, rootEvidenceSha256: learningResume.rootEvidenceSha256, independentEvidenceSha256: learningResume.independentEvidenceSha256, actualFailure: learningResume.evidence.actualBusiness?.reason, smallestNextChange: learningResume.evidence.smallestNextChange } : null };
      current.execution.phase = 'planned'; current.execution.startedAt = null; current.execution.deadlineAt = null; current.execution.updatedAt = new Date().toISOString();
      const repairBinding = { batchId, batchOrdinal: ordinal, repairOfExecutionId: input.expectedFailedExecutionId, priorLedgerSha256: input.expectedPriorLedgerSha256, scopeFingerprint: input.expectedScopeFingerprint, repairInputManifestSha256, priorReviewerOutcome: rejected?.verdict || null, priorReviewerFailureSha256: rejected?.textSha256 || null, repairBriefFile, repairBriefSha256, reviewOnly: Boolean(reusable && input.reviewOnly === true), repairKind: learningResume ? 'learning_resume' : learningContract ? 'learning_contract' : 'execution_failure', goalIncrementRepair, optInBoundedAutoReview: goalIncrementRepair && input.reviewOnly !== true ? input.optInBoundedAutoReview : false, failedLearningCandidateSha256: learningResume?.candidateSha256 || learningContract?.candidateSha256 || null, failedLearningLedgerSha256: learningResume?.learningLedgerSha256 || learningContract?.learningLedgerSha256 || null, failedLearningEvidenceSha256: learningResume?.rootEvidenceSha256 || learningContract?.evidenceSha256 || null, failedLearningIndependentEvidenceSha256: learningResume?.independentEvidenceSha256 || null, failedLearningSavedEventId: learningResume?.savedEventId || null, failedLearningTurnId: learningContract?.turnId || null,
        failedPlatformExecutionId: learningResumeContinuation?.executionId || null, failedPlatformLedgerSha256: learningResumeContinuation?.ledgerSha256 || null, failedPlatformRootEvidenceSha256: learningResumeContinuation?.rootEvidenceSha256 || null, failedPlatformIndependentEvidenceSha256: learningResumeContinuation?.independentEvidenceSha256 || null };
      if (cleanActivation) repairBinding.cleanInputBinding = repair.cleanInputBinding;
      if (repair.storageInputBinding) repairBinding.storageInputBinding = repair.storageInputBinding;
      current.execution.repair = { ...repairBinding, sourceManifest: repairManifest, sourceManifestSha256: repairInputManifestSha256 };
      current.integrationExecutionRequest = reusable && input.reviewOnly === true ? null : developerRequest(project, goal.id, current.execution.id, null, repair);
      current.status = 'waiting_user'; current.activeRole = 'writer';
      helpers.event(current, 'project.repair_scope_accepted', cleanActivation ? '用户明确授权精确拒收候选35作为修复输入；46失败现场另存原样，28确认版本与批准保留。' : '用户明确重新授权同一项目的当前失败目录作为有界修复输入；原固定工作区权限未扩大。', { ...repairBinding, executionId: current.execution.id, sourceManifestSha256: repairInputManifestSha256 });
      let reusedCandidate = null;
      if (reusable && input.reviewOnly === true) { current.execution.reviewOnly = true; reusedCandidate = await captureCandidate(current, reusable.changedFiles, { executionId: input.expectedFailedExecutionId, ledgerSha256: reusable.ledgerSha256, developerOutputSha256: reusable.developerOutputSha256, candidateSha256: reusable.candidateSha256 }); }
      helpers.event(current, 'integration.repair_batch_authorized', reusable && input.reviewOnly === true ? '用户明确保留失败批次并授权新的只读审阅批次；复用精确Developer字节，未运行模型。' : '用户明确保留失败批次并授权新的独立修复批次；未自动运行模型。', { ...repairBinding, executionId: current.execution.id, ledgerFile: nextLedgerFile, sourceSnapshotSha256: repairInputManifestSha256, reviewOnly: Boolean(reusedCandidate) });
      return { executionId: current.execution.id, registeredExecution: current.integrationExecutionRequest, repair, reusedCandidate };
    })).result;
    const activateCapability = async () => writeCapability((cap) => { cap.phase = result.reusedCandidate ? 'real-project-review-only-open' : 'real-project-repair-open'; cap.candidateSha256 = result.reusedCandidate?.candidate?.candidateSha256 || null; cap.learning.enabled = false; Object.assign(cap.development, { enabled: true, ledgerFile: nextLedgerFile, batchId, batchOrdinal: ordinal, executionId: result.executionId, repairOfExecutionId: input.expectedFailedExecutionId, priorLedgerSha256: input.expectedPriorLedgerSha256, repairInputManifestSha256, scopeFingerprint: input.expectedScopeFingerprint, mode: result.reusedCandidate ? 'review_only' : 'developer_reviewer', reason: result.reusedCandidate ? '用户显式授权仅审阅复用候选；禁止Developer与第二次Reviewer。' : '用户显式授权独立修复批次；旧失败与归档保留。' }); });
    if (learningResume || reviewFailureContinuation) await store.guardedEffect(taskId, async (latest) => {
      const liveCapabilityBytes = await fs.readFile(capabilityFile), liveCapability = JSON.parse(liveCapabilityBytes);
      if (helpers.activeGoal(latest).id !== goal.id || latest.execution?.id !== result.executionId || learningResume && latest.execution?.repair?.repairKind !== 'learning_resume'
        || latest.projectWorkspace?.scopeFingerprint !== input.expectedScopeFingerprint || fingerprint(await repairInputManifest(workspaceRoot)) !== repairInputManifestSha256
        || sha256(liveCapabilityBytes) !== sha256(capabilityBytesAtStart) || liveCapability.development?.enabled !== false
        || liveCapability.development?.executionId !== input.expectedFailedExecutionId || liveCapability.learning?.enabled !== false
        || path.resolve(liveCapability.learning?.ledgerFile || '') !== path.resolve(capability.learning.ledgerFile || '')) throw Object.assign(new Error('Learning resume authorization changed before capability activation'), { status: 409 });
      await activateCapability();
    }); else {
      const latest = await store.get(taskId); if (helpers.activeGoal(latest).id !== goal.id || latest.execution?.id !== result.executionId || latest.projectWorkspace?.scopeFingerprint !== input.expectedScopeFingerprint || fingerprint(await repairInputManifest(workspaceRoot)) !== repairInputManifestSha256) throw new Error('Repair binding changed before capability activation');
      await activateCapability();
    }
    return { authorized: true, batchId, batchOrdinal: ordinal, ledgerFile: nextLedgerFile, goalVersionId: goal.id, executionId: result.executionId, repairOfExecutionId: input.expectedFailedExecutionId, scopeFingerprint: input.expectedScopeFingerprint, sourceSnapshotSha256: input.expectedSourceSnapshotSha256, repairInputManifestSha256, reviewOnly: Boolean(result.reusedCandidate), maxNativeCalls: result.reusedCandidate ? 1 : 2, candidateSha256: result.reusedCandidate?.candidate?.candidateSha256 || null, registeredExecution: result.registeredExecution };
  }

  async function assertRepairInputCurrent(taskId) {
    const task = await store.get(taskId), repair = (task.events || []).findLast((entry) => entry.type === 'integration.repair_batch_authorized' && entry.detail?.executionId === task.execution?.id)?.detail;
    const increment = (task.events || []).findLast((entry) => entry.type === 'project.goal_increment_authorized' && entry.detail?.executionId === task.execution?.id)?.detail;
    if (!repair && increment && (task.execution?.stopReason || fingerprint(await manifest(workspaceRoot)) !== increment.sourceManifestSha256)) throw Object.assign(new Error('Goal increment input changed after explicit authorization'), { status: 409 });
    if (!repair) return true;
    if (task.execution?.stopReason || fingerprint(await repairInputManifest(workspaceRoot)) !== repair.repairInputManifestSha256) throw Object.assign(new Error('Repair input changed after explicit authorization'), { status: 409 });
    return true;
  }

  async function assertRegisteredExecutionCurrent(taskId) {
    const task = await store.get(taskId), goal = helpers.activeGoal(task);
    const artifact = (task.artifacts || []).filter((entry) => ['candidate','confirmed'].includes(entry.status) && helpers.projectArtifactIsCurrent(task, entry)).at(-1);
    if (!await registeredExecutionIsCurrent(task, goal, artifact)) throw Object.assign(new Error('Registered article execution is stale or not launchable'), { status: 409 });
    return true;
  }

  async function confirmGoal(taskId, input) {
    const project = await loadProject();
    if (project.requirementsStatus !== 'ready' || project.teachingImplementationStarted === true) throw Object.assign(new Error('完整参考方针尚未就绪，不能确认真实业务目标。'), { status: 409 });
    if (canonical(input.statement) !== canonical(project.goalDraft.statement) || canonical(input.successCriteria) !== canonical(project.goalDraft.successCriteria) || canonical(input.boundaries) !== canonical(project.goalDraft.boundaries)) throw new Error('确认内容必须等于最新登记需求。');
    const result = (await store.mutate(taskId, async (task) => {
      const current = helpers.activeGoal(task); if (input.expectedGoalVersionId !== current.id) throw new Error('目标页面已过期。');
      const preservedExecution = task.execution ? structuredClone(task.execution) : null;
      const suggestion = helpers.addSuggestion(task, { text: input.statement, classification: 'replace', author: 'user' });
      const goal = helpers.acceptGoalReplacement(task, suggestion.id, project.goalDraft);
      if (preservedExecution) {
        task.executionHistory = (task.executionHistory || []).filter((entry) => entry.id !== preservedExecution.id);
        task.executionHistory.push(preservedExecution); task.executionHistory = task.executionHistory.slice(-20);
        task.execution = null;
      }
      helpers.event(task, 'intake.goal_confirmed', '用户明确确认最新完整目标；工作区尚未授权。', { goalVersionId: goal.id, projectId: PROJECT_ID, projectFileSha256: sha256(await fs.readFile(projectFile)) });
      return goal;
    })).result;
    await writeCapability((cap) => { cap.goalVersionId = result.id; cap.candidateSha256 = null; cap.phase = 'real-project-goal-confirmed'; cap.development.enabled = false; cap.development.reason = '目标已确认；等待独立工作区授权。'; cap.learning.enabled = false; cap.learning.reason = '候选尚未审阅并确认。'; });
    return result;
  }

  async function authorize(taskId, expectedGoalVersionId) {
    const project = await loadProject(), capability = await loadCapability();
    if (project.requirementsStatus !== 'ready' || capability.projectId !== PROJECT_ID || capability.development?.cap !== 2 || capability.development?.windowMs !== 20 * 60_000) throw new Error('真实项目范围或开发批次配置无效。');
    const result = (await store.mutate(taskId, async (task) => {
      const goal = helpers.activeGoal(task); if (goal.id !== expectedGoalVersionId) throw new Error('目标已变化。');
      if ((task.events || []).findLast((e) => e.type === 'intake.goal_confirmed')?.detail?.goalVersionId !== goal.id) throw new Error('目标尚未明确确认。');
      const sourceManifest = await manifest(workspaceRoot); if (sourceManifest.length) throw new Error('首次授权要求空工作区。');
      task.type = 'project'; const binding = helpers.projectTaskBinding(task), sourceSnapshotSha256 = fingerprint(sourceManifest);
      const scopeFingerprint = fingerprint({ projectId: PROJECT_ID, goalVersionId: goal.id, sourceSnapshotSha256, materialSha256: project.material.sha256, binding });
      const proposalId = `proposal-${crypto.randomUUID()}`;
      task.projectScopeProposal = { id: proposalId, status: 'accepted', fingerprint: scopeFingerprint, acceptedFingerprint: scopeFingerprint, acceptedGoalVersionId: goal.id };
      task.plan = { id: `plan-${crypto.randomUUID()}`, revision: 1 };
      task.projectWorkspace = { policyVersion: 2, fixtureId: PROJECT_ID, label: project.title, executionMode: 'host_integrated_transaction_v1', publicContract: { projectId: PROJECT_ID, materialSha256: project.material.sha256 }, publicContractFingerprint: fingerprint({ projectId: PROJECT_ID, materialSha256: project.material.sha256 }), proposalId, proposalFingerprint: scopeFingerprint, status: 'ready', reason: null, sourceSnapshotId: `source-${crypto.randomUUID()}`, sourceSnapshotSha256, sourceManifest, readablePaths: [], editablePaths: [], checks: [{ id: 'article-static-candidate-v1' }], taskInputBinding: binding, scopeFingerprint, grantedAt: new Date().toISOString(), sandboxCapability: { available: true, fingerprint: fingerprint({ mode: 'native-codex-static-project-v1' }), runtimeFingerprint: fingerprint({ node: process.version, platform: process.platform }) }, candidate: { id: `candidate-${crypto.randomUUID()}`, revision: 1, status: 'ready', sourceSnapshotSha256, candidateSha256: sourceSnapshotSha256, manifest: sourceManifest, taskInputBinding: binding, checks: [], diffSha256: sha256('') } };
      const scope = helpers.event(task, 'project.scope_accepted', '用户明确授权sample-article-project隔离空工作区。', { proposalId, goalVersionId: goal.id, scopeFingerprint, sourceSnapshotSha256, fixtureId: PROJECT_ID });
      helpers.event(task, 'project_workspace.attached', '真实文章学习项目工作区已授权。', { goalVersionId: goal.id, scopeFingerprint, sourceSnapshotSha256, acceptedScopeEventId: scope.id });
      helpers.startExecution(task, goal.id, { maxModelCalls: 2, maxDurationMs: 20 * 60_000, maxAttemptsPerStep: 1, maxPlanRevisions: 0 });
      task.integrationExecutionRequest = developerRequest(project, goal.id, task.execution.id);
      return task;
    })).result;
    await writeCapability((cap) => { cap.goalVersionId = expectedGoalVersionId; cap.candidateSha256 = null; cap.phase = 'real-project-sample-batch-open'; cap.development.enabled = true; cap.development.reason = '用户已确认目标并授权隔离工作区；Developer/Reviewer共享本批。'; cap.learning.enabled = false; });
    return result;
  }

  async function authorizeGoalIncrement(taskId, input = {}) {
    if (input.acknowledgement !== 'preserve_confirmed_candidate_as_increment_input' || input.maxModelCalls !== 2 || input.maxDurationMs !== 20 * 60_000 || typeof input.optInBoundedAutoReview !== 'boolean') throw Object.assign(new Error('Goal increment acknowledgement or budget is invalid'), { status: 400 });
    const project = await loadProject(), capability = await loadCapability(), task = await store.get(taskId), goal = helpers.activeGoal(task);
    const required = ['expectedPriorGoalVersionId','expectedNewGoalVersionId','expectedConfirmedArtifactId','expectedConfirmedCandidateSha256','expectedSourceManifestSha256','expectedPriorLedgerSha256'];
    if (required.some((key) => typeof input[key] !== 'string')) throw Object.assign(new Error('Goal increment binding is incomplete'), { status: 400 });
    const latestConfirmation = (task.events || []).findLast((entry) => entry.type === 'intake.goal_confirmed');
    if (goal.id !== input.expectedNewGoalVersionId || latestConfirmation?.detail?.goalVersionId !== goal.id
      || canonical({ statement: goal.statement, successCriteria: goal.successCriteria, boundaries: goal.boundaries }) !== canonical(project.goalDraft)) throw Object.assign(new Error('The new goal is not the current confirmed registered goal'), { status: 409 });
    const priorArtifact = (task.artifacts || []).find((entry) => entry.id === input.expectedConfirmedArtifactId);
    const priorApproval = priorArtifact && (task.approvals || []).findLast((entry) => entry.artifactId === priorArtifact.id && entry.status === 'confirmed');
    const priorGoal = (task.goal?.versions || []).find((entry) => entry.id === input.expectedPriorGoalVersionId);
    const sourceManifest = await manifest(workspaceRoot), sourceManifestSha256 = fingerprint(sourceManifest);
    if (!priorGoal || !priorArtifact?.projectCandidate || !priorApproval || priorApproval.goalVersionId !== priorGoal.id
      || priorArtifact.projectCandidate.candidateSha256 !== input.expectedConfirmedCandidateSha256
      || sourceManifestSha256 !== input.expectedSourceManifestSha256 || sourceManifestSha256 !== priorArtifact.projectCandidate.candidateSha256
      || capability.development?.enabled !== false) throw Object.assign(new Error('Confirmed increment input is stale'), { status: 409 });
    const priorFile = path.resolve(capability.development.ledgerFile || ''), stateRoot = await fs.realpath(path.dirname(capabilityFile));
    const match = /sample-batch-(\d{2,4})\/model-ledger\.json$/.exec(priorFile.replaceAll(path.sep, '/'));
    if (!match || path.dirname(path.dirname(priorFile)) !== stateRoot) throw new Error('Prior development ledger path is invalid');
    const stat = await fs.lstat(priorFile); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024 || await fs.realpath(priorFile) !== priorFile) throw new Error('Prior development ledger is invalid');
    const priorBytes = await fs.readFile(priorFile), priorLedger = JSON.parse(priorBytes);
    if (sha256(priorBytes) !== input.expectedPriorLedgerSha256 || !priorLedger.sealed || priorLedger.calls?.some((call) => ['reserved','running'].includes(call.status))) throw Object.assign(new Error('Prior development ledger is not sealed at the acknowledged digest'), { status: 409 });
    const ordinal = Number(match[1]) + 1, batchId = `sample-batch-${String(ordinal).padStart(2, '0')}`;
    if (!Number.isInteger(ordinal) || ordinal > 9999 || match[1] !== String(ordinal - 1).padStart(2, '0')) throw new Error('Prior development batch number is invalid');
    const priorExecutionId = capability.development?.executionId;
    const priorAuditExecutionId = priorArtifact.projectCandidate?.projectExecutionAudit?.execution?.runId;
    const preservedExecution = (task.executionHistory || []).findLast((entry) => entry.id === priorExecutionId);
    if (typeof priorExecutionId !== 'string' || !/^run-[0-9a-f-]{36}$/i.test(priorExecutionId) || priorAuditExecutionId !== priorExecutionId || !preservedExecution) throw Object.assign(new Error('Prior confirmed execution binding is unavailable'), { status: 409 });
    const batchRoot = path.join(stateRoot, batchId), archiveRoot = path.join(batchRoot, 'prior-confirmed-workspace');
    await fs.mkdir(batchRoot, { recursive: false, mode: 0o700 });
    await fs.cp(workspaceRoot, archiveRoot, { recursive: true, errorOnExist: true, force: false });
    if (fingerprint(await manifest(archiveRoot)) !== sourceManifestSha256 || fingerprint(await manifest(workspaceRoot)) !== sourceManifestSha256) throw new Error('Increment input changed during archive');
    await fs.writeFile(path.join(batchRoot, 'increment-input-manifest.json'), `${JSON.stringify(sourceManifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    const nextLedgerFile = path.join(batchRoot, 'model-ledger.json');
    const result = (await store.mutate(taskId, async (current) => {
      if (helpers.activeGoal(current).id !== goal.id || fingerprint(await manifest(workspaceRoot)) !== sourceManifestSha256) throw Object.assign(new Error('Increment binding changed during authorization'), { status: 409 });
      const binding = helpers.projectTaskBinding(current), scopeFingerprint = fingerprint({ projectId: PROJECT_ID, goalVersionId: goal.id, sourceManifestSha256, priorCandidateSha256: input.expectedConfirmedCandidateSha256, binding });
      const proposalId = `proposal-${crypto.randomUUID()}`;
      current.type = 'project'; current.projectScopeProposal = { id: proposalId, status: 'accepted', fingerprint: scopeFingerprint, acceptedFingerprint: scopeFingerprint, acceptedGoalVersionId: goal.id };
      current.projectWorkspace = { ...current.projectWorkspace, status: 'ready', reason: null, proposalId, proposalFingerprint: scopeFingerprint, scopeFingerprint, sourceSnapshotId: `source-${crypto.randomUUID()}`, sourceSnapshotSha256: sourceManifestSha256, sourceManifest, taskInputBinding: binding, grantedAt: new Date().toISOString(), candidate: { ...current.projectWorkspace.candidate, status: 'ready', sourceSnapshotSha256: sourceManifestSha256, candidateSha256: sourceManifestSha256, manifest: sourceManifest, taskInputBinding: binding } };
      const currentBinding = helpers.projectTaskBinding(current), currentScopeFingerprint = fingerprint({ projectId: PROJECT_ID, goalVersionId: goal.id, sourceManifestSha256, priorCandidateSha256: input.expectedConfirmedCandidateSha256, binding: currentBinding });
      current.projectScopeProposal.fingerprint = currentScopeFingerprint; current.projectScopeProposal.acceptedFingerprint = currentScopeFingerprint;
      Object.assign(current.projectWorkspace, { proposalFingerprint: currentScopeFingerprint, scopeFingerprint: currentScopeFingerprint, taskInputBinding: currentBinding }); current.projectWorkspace.candidate.taskInputBinding = currentBinding;
      helpers.startExecution(current, goal.id, { maxModelCalls: 2, maxDurationMs: 20 * 60_000, maxAttemptsPerStep: 1, maxPlanRevisions: 0 });
      current.execution.phase = 'planned'; current.execution.startedAt = null; current.execution.deadlineAt = null; current.execution.increment = { priorGoalVersionId: priorGoal.id, priorArtifactId: priorArtifact.id, priorCandidateSha256: input.expectedConfirmedCandidateSha256, sourceManifestSha256, optInBoundedAutoReview: input.optInBoundedAutoReview };
      const increment = { batchId, priorExecutionId, priorLedgerSha256: input.expectedPriorLedgerSha256, scopeFingerprint: currentScopeFingerprint, sourceManifestSha256, priorCandidateSha256: input.expectedConfirmedCandidateSha256 };
      current.integrationExecutionRequest = developerRequest(project, goal.id, current.execution.id, null, null, increment);
      current.status = 'waiting_user'; current.activeRole = 'writer';
      helpers.event(current, 'project.goal_increment_authorized', '用户明确授权以旧目标已确认候选为输入的新目标有界增量开发；旧批准、候选和账本保留为历史。', { executionId: current.execution.id, batchId, batchOrdinal: ordinal, priorExecutionId, priorLedgerSha256: input.expectedPriorLedgerSha256, priorGoalVersionId: priorGoal.id, newGoalVersionId: goal.id, priorArtifactId: priorArtifact.id, priorCandidateSha256: input.expectedConfirmedCandidateSha256, sourceManifestSha256, scopeFingerprint: currentScopeFingerprint, optInBoundedAutoReview: input.optInBoundedAutoReview });
      return { executionId: current.execution.id, scopeFingerprint: currentScopeFingerprint, registeredExecution: current.integrationExecutionRequest };
    })).result;
    await writeCapability((cap) => { cap.goalVersionId = goal.id; cap.candidateSha256 = null; cap.phase = 'real-project-goal-increment-open'; cap.learning.enabled = false; Object.assign(cap.development, { enabled: true, ledgerFile: nextLedgerFile, batchId, batchOrdinal: ordinal, executionId: result.executionId, repairOfExecutionId: priorExecutionId, priorLedgerSha256: input.expectedPriorLedgerSha256, repairInputManifestSha256: sourceManifestSha256, scopeFingerprint: result.scopeFingerprint, mode: 'developer_reviewer', reason: '用户已授权新目标增量批次；旧确认候选仅作为精确输入。' }); });
    return { authorized: true, mode: 'goal_increment', batchId, batchOrdinal: ordinal, ledgerFile: nextLedgerFile, goalVersionId: goal.id, executionId: result.executionId, scopeFingerprint: result.scopeFingerprint, sourceManifestSha256, priorArtifactId: priorArtifact.id, priorCandidateSha256: input.expectedConfirmedCandidateSha256, maxNativeCalls: 2, maxDurationMs: 20 * 60_000, optInBoundedAutoReview: input.optInBoundedAutoReview, registeredExecution: result.registeredExecution };
  }

  async function clientState(taskId, sessionId, options = {}) {
    const task = await store.get(taskId), goal = helpers.activeGoal(task), artifact = (task.artifacts || []).filter((entry) => entry.status === 'confirmed' && helpers.projectArtifactIsCurrent(task, entry)).at(-1);
    if (options.scope === 'project') {
      const all = (task.events || []).filter((entry) => entry.type === 'learning.client_state_saved'), sessionIds = new Set(all.map((entry) => entry.detail?.sessionId).filter(Boolean)), seen = new Set(), items = [];
      for (const saved of [...all].reverse()) {
        const id = saved.detail?.sessionId; if (typeof id !== 'string' || seen.has(id)) continue; seen.add(id);
        const material = (task.events || []).find((entry) => entry.id === saved.detail?.materialEventId && entry.type === 'learning.material_registered');
        const latestMaterial = (task.events || []).findLast((entry) => entry.type === 'learning.material_registered' && entry.detail?.sessionId === id);
        const current = Boolean(artifact && latestMaterial?.id === material?.id && saved.detail?.goalVersionId === goal.id && saved.detail?.candidateSha256 === artifact.projectCandidate.candidateSha256 && material?.detail?.goalVersionId === goal.id && material?.detail?.candidateSha256 === artifact.projectCandidate.candidateSha256);
        items.push({ sessionId: id, label: material?.detail?.label || null, goalVersionId: saved.detail?.goalVersionId || null, candidateSha256: saved.detail?.candidateSha256 || null, materialEventId: saved.detail?.materialEventId || null, revision: saved.detail?.revision || 0, savedAt: saved.at, current, historical: !current });
        if (items.length === 200) break;
      }
      return { scope: 'project', items, totalSessions: sessionIds.size, truncated: sessionIds.size > items.length, limit: 200 };
    }
    if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(sessionId)) throw Object.assign(new Error('Client-state session is invalid'), { status: 400 });
    if (options.historical === true) {
      const saved = (task.events || []).findLast((entry) => entry.type === 'learning.client_state_saved' && entry.detail?.sessionId === sessionId);
      const material = saved && (task.events || []).find((entry) => entry.id === saved.detail?.materialEventId && entry.type === 'learning.material_registered');
      const latestMaterial = (task.events || []).findLast((entry) => entry.type === 'learning.material_registered' && entry.detail?.sessionId === sessionId);
      if (!saved || !material || typeof material.detail?.articleText !== 'string' || sha256(material.detail.articleText) !== material.detail.canonicalTextSha256) throw Object.assign(new Error('Historical client-state snapshot is unavailable'), { status: 404 });
      const current = Boolean(artifact && latestMaterial?.id === material.id && saved.detail?.goalVersionId === goal.id && saved.detail?.candidateSha256 === artifact.projectCandidate.candidateSha256 && material.detail?.goalVersionId === goal.id && material.detail?.candidateSha256 === artifact.projectCandidate.candidateSha256);
      return { readMode: 'history', readOnly: true, historical: !current, current, revision: saved.detail.revision, state: saved.detail.state, stateSha256: saved.detail.stateSha256, goalVersionId: saved.detail.goalVersionId, candidateSha256: saved.detail.candidateSha256, materialEventId: material.id, savedAt: saved.at, material: { label: material.detail.label, source: material.detail.source, articleText: material.detail.articleText, articleSha256: material.detail.articleSha256, normalization: material.detail.normalization } };
    }
    const material = (task.events || []).findLast((entry) => entry.type === 'learning.material_registered' && entry.detail?.sessionId === sessionId);
    const materialCurrent = material && material.detail?.goalVersionId === goal.id && material.detail?.candidateSha256 === artifact?.projectCandidate?.candidateSha256
      && typeof material.detail?.articleText === 'string' && sha256(material.detail.articleText) === material.detail?.canonicalTextSha256;
    const saved = (task.events || []).findLast((entry) => entry.type === 'learning.client_state_saved' && entry.detail?.sessionId === sessionId && entry.detail?.goalVersionId === goal.id && entry.detail?.candidateSha256 === artifact?.projectCandidate?.candidateSha256 && entry.detail?.materialEventId === material?.id);
    if (!artifact || !materialCurrent) throw Object.assign(new Error('Current confirmed candidate and a newly registered current-goal material are required'), { status: 409 });
    const binding = { goalVersionId: goal.id, candidateSha256: artifact.projectCandidate.candidateSha256, materialEventId: material.id, material: { label: material.detail.label, source: material.detail.source, articleText: material.detail.articleText, articleSha256: material.detail.articleSha256, normalization: material.detail.normalization } };
    return saved ? { revision: saved.detail.revision, state: saved.detail.state, stateSha256: saved.detail.stateSha256, ...binding } : { revision: 0, state: null, stateSha256: null, ...binding };
  }

  async function saveClientState(taskId, input = {}) {
    if (input.projectId !== PROJECT_ID || typeof input.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(input.sessionId) || typeof input.expectedRevision !== 'number' || !Number.isInteger(input.expectedRevision) || input.expectedRevision < 0 || typeof input.state !== 'object' || input.state === null || Array.isArray(input.state)) throw Object.assign(new Error('Client-state input is invalid'), { status: 400 });
    const bytes = Buffer.byteLength(canonical(input.state)); if (bytes > 48 * 1024) throw Object.assign(new Error('Client-state exceeds 48 KiB'), { status: 413 });
    let nodes = 0; const visit = (value) => { if (++nodes > 2000) throw Object.assign(new Error('Client-state is too complex'), { status: 413 }); if (Array.isArray(value)) { if (value.length > 200) throw Object.assign(new Error('Client-state collection exceeds 200 items'), { status: 413 }); value.forEach(visit); } else if (value && typeof value === 'object') Object.values(value).forEach(visit); }; visit(input.state);
    return (await store.mutate(taskId, async (task) => {
      const goal = helpers.activeGoal(task), artifact = (task.artifacts || []).filter((entry) => entry.status === 'confirmed' && helpers.projectArtifactIsCurrent(task, entry)).at(-1), material = (task.events || []).findLast((entry) => entry.type === 'learning.material_registered' && entry.detail?.sessionId === input.sessionId);
      const materialCurrent = material?.detail?.goalVersionId === goal.id && material?.detail?.candidateSha256 === artifact?.projectCandidate?.candidateSha256
        && typeof material?.detail?.articleText === 'string' && sha256(material.detail.articleText) === material.detail.canonicalTextSha256;
      if (goal.id !== input.expectedGoalVersionId || artifact?.projectCandidate?.candidateSha256 !== input.expectedCandidateSha256 || material?.id !== input.expectedMaterialEventId || !materialCurrent) throw Object.assign(new Error('Client-state binding is stale; register the full material again for the current goal and candidate'), { status: 409 });
      const prior = (task.events || []).findLast((entry) => entry.type === 'learning.client_state_saved' && entry.detail?.sessionId === input.sessionId && entry.detail?.goalVersionId === goal.id && entry.detail?.candidateSha256 === artifact.projectCandidate.candidateSha256 && entry.detail?.materialEventId === material.id), revision = (prior?.detail?.revision || 0) + 1;
      if ((prior?.detail?.revision || 0) !== input.expectedRevision) throw Object.assign(new Error('Client-state revision conflict'), { status: 409 });
      const state = structuredClone(input.state), stateSha256 = sha256(canonical(state));
      helpers.event(task, 'learning.client_state_saved', '客户端保存了当前目标、候选、材料绑定的累计学习状态；服务端不推断奖励。', { sessionId: input.sessionId, goalVersionId: goal.id, candidateSha256: artifact.projectCandidate.candidateSha256, materialEventId: material.id, revision, stateSha256, state });
      return { revision, stateSha256, goalVersionId: goal.id, candidateSha256: artifact.projectCandidate.candidateSha256, materialEventId: material.id };
    })).result;
  }

  async function captureCandidate(task, changedFiles, reusedDeveloper = null) {
    const current = await manifest(workspaceRoot);
    if (!current.length || !current.some((f) => /^index\.html$/i.test(f.path))) throw new Error('Static candidate must include index.html');
    const candidateFiles = current.map((entry) => entry.path).sort(), reportedChangedFiles = [...new Set(changedFiles || [])].sort();
    if (!reportedChangedFiles.length || reportedChangedFiles.some((file) => !candidateFiles.includes(file))) throw new Error('Reported changed files are not a non-empty subset of the current candidate');
    const continuation = task.execution?.repair?.cleanInputBinding || LEARNING_RESUME_PLATFORM_FAILURES.get(task.execution?.repair?.failedPlatformExecutionId)
      || REVIEW_FAILURE_CONTINUATIONS.get(task.execution?.repair?.repairOfExecutionId);
    if (continuation?.allowedChangedFiles) {
      const baseline = new Map((task.execution.repair.sourceManifest || []).map((entry) => [entry.path, entry.sha256]));
      const actualChangedFiles = current.filter((entry) => baseline.get(entry.path) !== entry.sha256).map((entry) => entry.path).sort();
      if (candidateFiles.some((file) => !baseline.has(file)) || [...baseline.keys()].some((file) => !candidateFiles.includes(file))
        || actualChangedFiles.some((file) => !continuation.allowedChangedFiles.includes(file))
        || canonical(actualChangedFiles) !== canonical(reportedChangedFiles)) throw new Error('Developer actual and reported changed files exceed or mismatch the exact registered continuation scope');
    }
    const diff = await reviewDiff(workspaceRoot, candidateFiles), candidateSha256 = fingerprint(current), diffSha256 = sha256(diff);
    if (['learning_contract', 'learning_resume'].includes(task.execution?.repair?.repairKind) && candidateSha256 === task.execution.repair.failedLearningCandidateSha256) throw new Error('Learning repair did not produce a changed candidate');
    if (task.execution?.increment?.priorCandidateSha256 === candidateSha256) throw new Error('Goal increment did not produce a changed candidate');
    const check = { id: 'article-static-candidate-v1', passed: true, caseTotal: 1, casePassed: 1, candidateSha256, resultDigest: fingerprint({ candidateSha256, candidateFiles, reportedChangedFiles }) };
    const integrityBody = { baseline: [], current, outsideUnchanged: true }, integritySha256 = fingerprint(integrityBody);
    const auditBody = { mode: 'host_integrated_transaction_v1', plan: { ...task.plan }, execution: { runId: task.execution.id }, binding: helpers.projectTaskBinding(task), calls: [], reusedDeveloper }, auditSha256 = fingerprint(auditBody);
    const projectCandidate = { sourceSnapshotSha256: task.projectWorkspace.sourceSnapshotSha256, workspaceScopeFingerprint: task.projectWorkspace.scopeFingerprint, candidateId: task.projectWorkspace.candidate.id, candidateSha256, diffSha256, patchSha256: diffSha256, patch: diff, changes: candidateFiles, reportedChangedFiles, checks: [check], taskInputBinding: helpers.projectTaskBinding(task), sourceIntegrity: { ...integrityBody, integritySha256 }, sourceIntegritySha256: integritySha256, projectExecutionAudit: { ...auditBody, auditSha256 }, projectExecutionAuditSha256: auditSha256, sandboxCapabilityFingerprint: task.projectWorkspace.sandboxCapability.fingerprint, runtimeFingerprint: task.projectWorkspace.sandboxCapability.runtimeFingerprint };
    task.projectWorkspace.candidate = { ...task.projectWorkspace.candidate, candidateSha256, manifest: current, checks: [check], diffSha256 };
    const receipt = 'The exact static code candidate is retained in the bound project candidate patch and manifest for independent review.';
    const artifact = helpers.createArtifact(task, { title: 'Article learning static candidate', summary: reusedDeveloper ? 'Exact prior Developer bytes recaptured for readonly review only.' : 'Exact bounded static candidate awaiting independent review.', content: receipt, sources: [], claims: [], caveats: ['Local candidate only; not published.'], projectCandidate }, 'codex-cli');
    if (!helpers.projectArtifactIsCurrent(task, artifact)) throw new Error('Candidate evidence is not current');
    task.status = 'waiting_user'; task.activeRole = 'reviewer';
    helpers.event(task, 'integration.host_checked', reusedDeveloper ? '已精确复用上一封存批次的Developer字节并重新绑定候选；新批仅允许只读Reviewer。' : '当前静态候选与manifest已绑定。', { artifactId: artifact.id, candidateSha256, diffSha256, reusedDeveloper });
    return { passed: true, artifactId: artifact.id, candidate: projectCandidate };
  }

  async function hostCheck(taskId) {
    const result = (await store.mutate(taskId, async (task) => {
      if (!helpers.projectWorkspaceIsCurrent(task) || task.projectWorkspace.fixtureId !== PROJECT_ID || task.execution?.stopReason) throw new Error('Article execution binding is stale');
      const done = (task.events || []).findLast((e) => e.type === 'integration.observation' && e.detail?.type === 'TASK_DONE' && e.detail?.actor === 'developer' && e.detail?.binding?.executionId === task.execution.id);
      const captured = await captureCandidate(task, done?.detail?.changedFiles);
      if (task.execution?.increment?.optInBoundedAutoReview === true || task.execution?.repair?.optInBoundedAutoReview === true) {
        let reserved = (task.events || []).findLast((entry) => entry.type === 'integration.review_dispatch_reserved' && entry.detail?.executionId === task.execution.id && entry.detail?.candidateSha256 === captured.candidate.candidateSha256);
        if (!reserved) reserved = helpers.event(task, 'integration.review_dispatch_reserved', 'Developer终态、authority持久化与host候选检查均通过；为同批唯一独立Reviewer保留一次幂等派发。', { executionId: task.execution.id, candidateSha256: captured.candidate.candidateSha256, sourceTaskId: done.detail.sourceTaskId, changedFiles: captured.candidate.changes, entryFile: done.detail.entryFile || 'index.html' });
        captured.autoReview = { dispatchEventId: reserved.id, executionId: task.execution.id, candidateSha256: captured.candidate.candidateSha256, sourceTaskId: done.detail.sourceTaskId, changedFiles: captured.candidate.changes, entryFile: done.detail.entryFile || 'index.html' };
      }
      return captured;
    })).result;
    await writeCapability((cap) => { cap.candidateSha256 = result.candidate.candidateSha256; cap.phase = 'real-project-review-open'; cap.development.enabled = true; cap.development.reason = 'Developer候选已绑定；本批仅余当前候选只读Reviewer。'; cap.learning.enabled = false; });
    return result;
  }

  async function assertCandidateCurrent(task, artifact = (task.artifacts || []).filter((a) => ['candidate', 'confirmed'].includes(a.status)).at(-1)) {
    if (!artifact?.projectCandidate || !helpers.projectArtifactIsCurrent(task, artifact)) throw new Error('No current article candidate');
    const current = await manifest(workspaceRoot); if (fingerprint(current) !== artifact.projectCandidate.candidateSha256) throw new Error('Article candidate changed after host capture');
    if (sha256(await reviewDiff(workspaceRoot, artifact.projectCandidate.changes)) !== artifact.projectCandidate.diffSha256) throw new Error('Article review input changed');
    return { artifact, candidate: artifact.projectCandidate };
  }

  function matchingPassedReview(task, artifact) {
    if (!artifact?.projectCandidate) return null;
    const goal = helpers.activeGoal(task), expectedFingerprint = helpers.projectCandidateFingerprint(artifact.projectCandidate);
    const review = (task.reviews || []).filter((entry) => entry.artifactId === artifact.id).at(-1);
    return review?.passed === true && review.nativeVerdict === 'PASS' && review.scopeOutcome === 'passed'
      && review.goalVersionId === goal.id && review.projectCandidateFingerprint === expectedFingerprint
      && /^[a-f0-9]{64}$/.test(review.fullOutputSha256 || '') ? review : null;
  }

  async function recordReviewer(taskId, sourceTaskId, reviewText) {
    const result = (await store.mutate(taskId, async (task) => {
      const { artifact } = await assertCandidateCurrent(task); const text = String(reviewText || '').slice(0, 40_000);
      const started = (task.events || []).findLast((e) => e.type === 'integration.observation' && e.detail?.type === 'TASK_STARTED' && e.detail?.actor === 'reviewer' && e.detail?.sourceTaskId === sourceTaskId && e.detail?.binding?.candidateSha256 === artifact.projectCandidate.candidateSha256);
      const verdict = text.match(/(?:^|\n)\s*(?:\*\*)?VERDICT:(?:\*\*)?\s*(PASS|FAIL)\b/im)?.[1]?.toUpperCase();
      if (!started || !verdict) throw new Error('Current candidate has no bound native review verdict');
      if (verdict === 'FAIL') {
        const review = recordRejectedReview(task, { artifact, reservation: { detail: { sourceTaskId } }, verdict: 'FAIL', scopeOutcome: 'contract_failed', text, textSha256: sha256(text) });
        task.execution.stopReason = 'permanent_error'; task.execution.phase = 'failed'; task.status = 'failed';
        return review;
      }
      const facts = helpers.createTrustedProjectReviewFacts(task, artifact);
      const checks = ['目标符合度', '完整性', '来源核对', '边界遵守', '文件可用性'].map((name) => ({ name, passed: true, evidence: 'Independent native reviewer returned PASS for the exact current candidate.', blocking: true }));
      const review = helpers.recordReview(task, artifact.id, { checks, summary: text, provider: 'codex-cli' }, { projectReviewFacts: facts });
      review.nativeVerdict = 'PASS'; review.scopeOutcome = 'passed'; review.sourceTaskId = sourceTaskId; review.fullOutputSha256 = sha256(text); review.projectCandidateFingerprint = helpers.projectCandidateFingerprint(artifact.projectCandidate);
      return review;
    })).result;
    if (result.nativeVerdict === 'FAIL') await writeCapability((cap) => { cap.phase = 'real-project-sample-batch-stopped-preserving-failure'; cap.development.enabled = false; cap.development.reason = '原生reviewer失败；当前候选与完整FAIL已保留，等待显式下一修复批次。'; cap.learning.enabled = false; });
    return result;
  }

  async function confirm(taskId, artifactId, version) {
    const result = (await store.mutate(taskId, async (task) => {
      const artifact = (task.artifacts || []).find((a) => a.id === artifactId && a.version === version); await assertCandidateCurrent(task, artifact);
      const review = (task.reviews || []).filter((r) => r.artifactId === artifact.id).at(-1);
      if (!review?.passed || review.projectCandidateFingerprint !== helpers.projectCandidateFingerprint(artifact.projectCandidate)) throw new Error('Current candidate has no matching review');
      const existing = (task.approvals || []).findLast((entry) => entry.artifactId === artifact.id && entry.status === 'confirmed');
      if (artifact.status === 'confirmed' && existing) return { approval: existing, candidateSha256: artifact.projectCandidate.candidateSha256 };
      return { approval: helpers.confirmArtifact(task, artifact.id), candidateSha256: artifact.projectCandidate.candidateSha256 };
    })).result;
    const latest = await store.get(taskId), contractRepair = latest.execution?.repair?.cleanInputBinding || ['learning_contract', 'learning_resume'].includes(latest.execution?.repair?.repairKind) || REVIEW_FAILURE_CONTINUATIONS.has(latest.execution?.repair?.repairOfExecutionId) ? latest.execution.repair : null;
    await writeCapability((cap) => { cap.candidateSha256 = result.candidateSha256; cap.development.enabled = false; cap.development.reason = '当前候选已独立审阅并确认。';
      cap.phase = contractRepair ? REVIEW_FAILURE_CONTINUATIONS.has(contractRepair.repairOfExecutionId) ? 'real-project-review-failure-repair-confirmed' : contractRepair.repairKind === 'learning_resume' ? 'real-project-learning-resume-repair-confirmed' : 'real-project-learning-contract-repair-confirmed' : 'real-project-learning-open';
      cap.learning.enabled = !contractRepair; cap.learning.reason = contractRepair ? '学习契约修复候选已确认；等待显式开启独立验收批次，旧失败批次保持封存。' : '当前目标与候选已确认；允许本批两次tools-off学习推理。'; });
    return result;
  }

  async function openLearningBatch(taskId, expectedGoalVersionId, expectedCandidateSha256, acceptance = {}) {
    const task = await store.get(taskId), goal = helpers.activeGoal(task);
    const artifact = (task.artifacts || []).filter((entry) => ['candidate', 'confirmed'].includes(entry.status) && helpers.projectArtifactIsCurrent(task, entry)).at(-1);
    const approval = artifact && (task.approvals || []).findLast((entry) => entry.artifactId === artifact.id && entry.status === 'confirmed');
    const passedReview = artifact && matchingPassedReview(task, artifact);
    if (goal.id !== expectedGoalVersionId || !approval || !passedReview || artifact?.projectCandidate?.candidateSha256 !== expectedCandidateSha256 || !helpers.projectArtifactIsCurrent(task, artifact)) throw new Error('目标、独立审阅或已确认候选已变化。');
    await assertCandidateCurrent(task, artifact);
    const capabilityBytes = await fs.readFile(capabilityFile), capability = JSON.parse(capabilityBytes), currentFile = path.resolve(capability.learning?.ledgerFile || '');
    const stateRoot = path.dirname(capabilityFile), match = /learning-(\d{2,4})\/model-ledger\.json$/.exec(currentFile.replaceAll(path.sep, '/'));
    if (!match || !currentFile.startsWith(`${stateRoot}${path.sep}`)) throw new Error('当前学习批次路径无效。');
    const ledgerBytes = await fs.readFile(currentFile), ledger = JSON.parse(ledgerBytes);
    const directContractExecution = task.execution?.repair?.repairKind === 'learning_contract' ? task.execution : null;
    const executionLineage = [...(task.executionHistory || []), task.execution].filter(Boolean);
    const ancestralContractExecution = executionLineage.findLast((entry) => entry.goalVersionId === goal.id && entry.repair?.repairKind === 'learning_contract'
      && entry.repair?.failedLearningLedgerSha256 === acceptance.expectedPriorLearningLedgerSha256);
    const contractExecution = directContractExecution || ancestralContractExecution, contractRepair = contractExecution?.repair || null;
    const contractIndex = contractExecution ? executionLineage.findIndex((entry) => entry.id === contractExecution.id) : -1;
    const ancestryCurrent = Boolean(contractExecution && contractIndex >= 0 && executionLineage.slice(contractIndex + 1).every((entry, offset) => entry.goalVersionId === goal.id
      && entry.repair?.repairOfExecutionId === executionLineage[contractIndex + offset].id));
    const reconciled = (task.events || []).findLast((entry) => entry.type === 'learning.inference_transport_reconciled' && entry.detail?.candidateSha256 === expectedCandidateSha256);
    let reconciledProofCurrent = false;
    if (reconciled && acceptance?.acknowledgement === 'preserve_reconciled_sealed_learning_batch' && acceptance.expectedHostProofSha256 === reconciled.detail?.hostProofSha256) {
      const proofFile = path.join(path.dirname(projectFile), 'evidence', reconciled.detail.hostProofFile || ''), proofStat = await fs.lstat(proofFile);
      if (proofStat.isFile() && !proofStat.isSymbolicLink() && proofStat.nlink === 1 && proofStat.size <= 256 * 1024 && await fs.realpath(proofFile) === proofFile) reconciledProofCurrent = sha256(await fs.readFile(proofFile)) === acceptance.expectedHostProofSha256;
    }
    const reconciledAcceptance = acceptance?.acknowledgement === 'preserve_reconciled_sealed_learning_batch'
      && capability.learning?.enabled === false && acceptance.expectedReconciledEventId === reconciled?.id
      && acceptance.expectedPriorLearningLedgerSha256 === sha256(await fs.readFile(currentFile))
      && acceptance.expectedPriorLearningLedgerSha256 === reconciled?.detail?.ledgerSha256
      && ledger.sealed?.reasonCode === 'host_native_learning_output_contract_invalid'
      && ledger.calls?.length === 1 && ledger.calls[0]?.status === 'completed' && ledger.calls[0]?.exitCode === 0 && !ledger.calls[0]?.signal
      && !ledger.calls.some((call) => ['reserved','running'].includes(call.status)) && reconciledProofCurrent;
    const repairedAcceptance = acceptance?.acknowledgement === 'new_reviewed_candidate_learning_acceptance'
      && contractRepair && contractRepair.failedLearningCandidateSha256 !== expectedCandidateSha256
      && (directContractExecution || (ancestryCurrent
        && acceptance.expectedRepairExecutionId === contractExecution.id
        && acceptance.expectedRepairSourceManifestSha256 === contractRepair.sourceManifestSha256
        && fingerprint(contractRepair.sourceManifest || []) === contractRepair.sourceManifestSha256
        && acceptance.expectedRepairEvidenceSha256 === contractRepair.failedLearningEvidenceSha256))
      && acceptance.expectedFailedCandidateSha256 === contractRepair.failedLearningCandidateSha256
      && acceptance.expectedPriorLearningLedgerSha256 === contractRepair.failedLearningLedgerSha256
      && ledger.sealed?.reasonCode === 'host_native_learning_output_contract_invalid'
      && sha256(await fs.readFile(currentFile)) === contractRepair.failedLearningLedgerSha256
      && !ledger.calls?.some((call) => ['reserved','running'].includes(call.status));
    let schemaRepairAcceptance = false, schemaRepairProof = null;
    if (acceptance?.acknowledgement === 'preserve_platform_schema_contract_failure') {
      const batchId = `learning-${match?.[1] || ''}`, proofName = `${batchId}-platform-schema-repair-zero-model.json`;
      if (batchId !== 'learning-05') throw Object.assign(new Error('Platform schema repair continuation is only registered for the preserved learning-05 failure'), { status: 409 });
      if (acceptance.expectedSchemaRepairProofFile !== proofName || !/^[a-f0-9]{64}$/.test(acceptance.expectedSchemaRepairProofSha256 || '')) throw Object.assign(new Error('Platform schema repair proof binding is invalid'), { status: 400 });
      const proofFile = path.join(path.dirname(projectFile), 'evidence', proofName), proofStat = await fs.lstat(proofFile);
      if (!proofStat.isFile() || proofStat.isSymbolicLink() || proofStat.nlink !== 1 || proofStat.size > 256 * 1024 || await fs.realpath(proofFile) !== proofFile) throw new Error('Platform schema repair proof is invalid');
      const proofBytes = await fs.readFile(proofFile); schemaRepairProof = JSON.parse(proofBytes);
      const schemaRoot = path.join(path.dirname(projectFile), 'config', 'inference-output-schemas');
      const oldSchemaRoot = path.join(path.dirname(projectFile), 'backend', 'learning-05-platform-schema-repair', 'registered-schema-before');
      const [oldExplainBytes, oldAssessBytes, newExplainBytes, newAssessBytes] = await Promise.all([
        fs.readFile(path.join(oldSchemaRoot, 'explain.json')), fs.readFile(path.join(oldSchemaRoot, 'assess.json')),
        fs.readFile(path.join(schemaRoot, 'explain.json')), fs.readFile(path.join(schemaRoot, 'assess.json')),
      ]);
      const [oldExplainSchema, oldAssessSchema, newExplainSchema, newAssessSchema] = [oldExplainBytes, oldAssessBytes, newExplainBytes, newAssessBytes].map((bytes) => JSON.parse(bytes));
      const ledgerSha256 = sha256(await fs.readFile(currentFile)), reservation = (task.events || []).findLast((entry) => entry.type === 'learning.inference_reserved' && entry.detail?.turnId === acceptance.expectedFailedTurnId);
      const invalidResult = reservation && (task.events || []).findLast((entry) => entry.type === 'learning.inference_result' && entry.detail?.sourceTaskId === reservation.detail?.sourceTaskId);
      const material = reservation && (task.events || []).find((entry) => entry.type === 'learning.material_registered' && entry.id === reservation.detail?.materialEventId);
      const latestMaterial = material && (task.events || []).findLast((entry) => entry.type === 'learning.material_registered' && entry.detail?.sessionId === material.detail?.sessionId);
      const stdoutFile = path.resolve(path.dirname(currentFile), ledger.calls?.[0]?.stdout?.file || '');
      const stdoutInBatch = stdoutFile.startsWith(`${path.dirname(currentFile)}${path.sep}`);
      let stdoutBytes = null, rawJson = null;
      if (stdoutInBatch) {
        const stdoutStat = await fs.lstat(stdoutFile);
        if (stdoutStat.isFile() && !stdoutStat.isSymbolicLink() && stdoutStat.nlink === 1 && stdoutStat.size <= 40_000 && await fs.realpath(stdoutFile) === stdoutFile) {
          stdoutBytes = await fs.readFile(stdoutFile);
          try { rawJson = JSON.parse(stdoutBytes.toString('utf8')); } catch { /* Invalid JSON cannot establish this exact schema mismatch. */ }
        }
      }
      const strictObject = (schema) => schema?.type === 'object' && schema.additionalProperties === false && Array.isArray(schema.required) && schema.properties && typeof schema.properties === 'object';
      const oldSchemaMismatchExact = strictObject(oldExplainSchema) && !oldExplainSchema.required.includes('plan') && !Object.hasOwn(oldExplainSchema.properties, 'plan')
        && strictObject(oldAssessSchema) && !oldAssessSchema.required.includes('activityQualification') && !Object.hasOwn(oldAssessSchema.properties, 'activityQualification');
      const newSchemaContractExact = strictObject(newExplainSchema) && newExplainSchema.required.includes('plan') && Object.hasOwn(newExplainSchema.properties, 'plan')
        && strictObject(newAssessSchema) && newAssessSchema.required.includes('activityQualification') && Object.hasOwn(newAssessSchema.properties, 'activityQualification');
      schemaRepairAcceptance = sha256(proofBytes) === acceptance.expectedSchemaRepairProofSha256
        && capability.learning?.enabled === false && ledger.sealed?.reasonCode === 'host_native_learning_output_contract_invalid'
        && ledgerSha256 === acceptance.expectedPriorLearningLedgerSha256 && ledger.calls?.length === 1 && ledger.calls[0]?.expectedRole === 'inference'
        && ledger.calls[0]?.status === 'completed' && ledger.calls[0]?.exitCode === 0 && !ledger.calls[0]?.signal && !ledger.calls.some((call) => ['reserved','running'].includes(call.status))
        && reservation?.detail?.kind === 'explain' && reservation.detail?.promptSha256 === ledger.calls[0]?.promptSha256
        && ledger.calls[0]?.outputSchema?.kind === 'explain' && ledger.calls[0]?.outputSchema?.sha256 === sha256(oldExplainBytes)
        && stdoutBytes && stdoutBytes.length === ledger.calls[0]?.stdout?.bytes && sha256(stdoutBytes) === ledger.calls[0]?.stdout?.sha256
        && rawJson && !Object.hasOwn(rawJson, 'plan') && invalidResult?.detail?.text?.trim() === stdoutBytes.toString('utf8').trim()
        && invalidResult.detail?.resultSha256 === sha256(invalidResult.detail.text)
        && reservation?.detail?.candidateSha256 === expectedCandidateSha256 && reservation.detail?.goalVersionId === goal.id
        && reservation.detail?.materialEventId === acceptance.expectedMaterialEventId && reservation.detail?.sourceTaskId === acceptance.expectedSourceTaskId
        && material?.id === latestMaterial?.id && material.detail?.goalVersionId === goal.id && material.detail?.candidateSha256 === expectedCandidateSha256
        && invalidResult?.detail?.current === true && schemaRepairProof.projectId === PROJECT_ID && schemaRepairProof.goalVersionId === goal.id && schemaRepairProof.candidateSha256 === expectedCandidateSha256
        && schemaRepairProof.materialEventId === acceptance.expectedMaterialEventId && schemaRepairProof.turnId === acceptance.expectedFailedTurnId
        && schemaRepairProof.sourceTaskId === acceptance.expectedSourceTaskId && schemaRepairProof.priorLedgerSha256 === ledgerSha256
        && schemaRepairProof.nativeModelCalls === 0 && schemaRepairProof.sourceUnchanged === true && schemaRepairProof.invalidRawNotReused === true
        && schemaRepairProof.invalidRawStdoutSha256 === ledger.calls[0]?.stdout?.sha256
        && schemaRepairProof.invalidResultSha256 === invalidResult.detail?.resultSha256
        && oldSchemaMismatchExact && newSchemaContractExact
        && schemaRepairProof.oldExplainSchemaSha256 === sha256(oldExplainBytes) && schemaRepairProof.newExplainSchemaSha256 === sha256(newExplainBytes)
        && schemaRepairProof.oldAssessSchemaSha256 === sha256(oldAssessBytes) && schemaRepairProof.newAssessSchemaSha256 === sha256(newAssessBytes)
        && schemaRepairProof.oldExplainSchemaSha256 !== schemaRepairProof.newExplainSchemaSha256 && schemaRepairProof.oldAssessSchemaSha256 !== schemaRepairProof.newAssessSchemaSha256;
      if (!schemaRepairAcceptance) throw Object.assign(new Error('Platform schema repair proof is stale or incomplete'), { status: 409 });
    }
    if (!schemaRepairAcceptance && !repairedAcceptance && !reconciledAcceptance && (ledger.sealed || !Array.isArray(ledger.calls) || ledger.calls.length !== 2 || ledger.calls.some((call) => call.status !== 'completed' || call.exitCode !== 0 || call.signal))) throw new Error('只有成功用完或已精确协调的学习批次可以显式续开；失败或未完成批次保持停止。');
    const currentOrdinal = Number(match[1]);
    if (!Number.isInteger(currentOrdinal) || currentOrdinal < 1 || currentOrdinal > 9999 || match[1] !== String(currentOrdinal).padStart(2, '0')) throw new Error('当前学习批次编号无效。');
    const ordinal = currentOrdinal + 1; if (ordinal > 9999) throw new Error('学习批次数量超限。');
    const nextFile = path.join(stateRoot, `learning-${String(ordinal).padStart(2, '0')}`, 'model-ledger.json');
    const eventType = schemaRepairAcceptance ? 'learning.platform_schema_repair_batch_opened' : repairedAcceptance ? 'learning.repaired_candidate_batch_opened' : reconciledAcceptance ? 'learning.reconciled_batch_opened' : 'learning.batch_opened';
    const initialTaskSha256 = sha256(canonical(task)); let directoryCreated = false, capabilityWritten = false, taskCommitted = false, enabledWritten = false, openingEvent = null, pendingCapabilitySha256 = null;
    try {
      await store.mutate(taskId, async (current) => {
        const lockedGoal = helpers.activeGoal(current), lockedArtifact = (current.artifacts || []).filter((entry) => ['candidate', 'confirmed'].includes(entry.status) && helpers.projectArtifactIsCurrent(current, entry)).at(-1);
        const lockedApproval = lockedArtifact && (current.approvals || []).findLast((entry) => entry.artifactId === lockedArtifact.id && entry.status === 'confirmed');
        const lockedReview = lockedArtifact && matchingPassedReview(current, lockedArtifact);
        if (sha256(canonical(current)) !== initialTaskSha256 || lockedGoal.id !== expectedGoalVersionId || !lockedApproval || !lockedReview
          || lockedArtifact?.projectCandidate?.candidateSha256 !== expectedCandidateSha256 || !helpers.projectArtifactIsCurrent(current, lockedArtifact)) throw Object.assign(new Error('Learning batch binding changed before commit'), { status: 409 });
        await assertCandidateCurrent(current, lockedArtifact);
        const lockedCapabilityBytes = await fs.readFile(capabilityFile), lockedCapability = JSON.parse(lockedCapabilityBytes);
        const lockedLedgerBytes = await fs.readFile(currentFile);
        if (!lockedCapability.learning || lockedCapability.learning.enabled !== capability.learning.enabled || path.resolve(lockedCapability.learning.ledgerFile || '') !== currentFile
          || sha256(lockedCapabilityBytes) !== sha256(capabilityBytes) || sha256(lockedLedgerBytes) !== sha256(ledgerBytes)) throw Object.assign(new Error('Learning capability or ledger changed before commit'), { status: 409 });
        if (schemaRepairAcceptance) {
          const lockedReservation = (current.events || []).findLast((entry) => entry.type === 'learning.inference_reserved' && entry.detail?.turnId === acceptance.expectedFailedTurnId);
          const lockedMaterial = lockedReservation && (current.events || []).find((entry) => entry.type === 'learning.material_registered' && entry.id === lockedReservation.detail?.materialEventId);
          const lockedLatestMaterial = lockedMaterial && (current.events || []).findLast((entry) => entry.type === 'learning.material_registered' && entry.detail?.sessionId === lockedMaterial.detail?.sessionId);
          if (lockedReservation?.detail?.sourceTaskId !== acceptance.expectedSourceTaskId || lockedMaterial?.id !== acceptance.expectedMaterialEventId || lockedLatestMaterial?.id !== lockedMaterial.id) throw Object.assign(new Error('Learning schema repair material changed before commit'), { status: 409 });
        }
        await fs.mkdir(path.dirname(nextFile), { recursive: false, mode: 0o700 }); directoryCreated = true;
        await writeCapability((cap) => { cap.phase = `real-project-learning-${String(ordinal).padStart(2, '0')}-pending`; cap.learning.enabled = false; cap.learning.ledgerFile = nextFile; cap.learning.reason = '学习批次授权正在持久化；模型权限尚未开启。'; }); capabilityWritten = true; pendingCapabilitySha256 = sha256(await fs.readFile(capabilityFile));
        return helpers.event(current, eventType, schemaRepairAcceptance ? '已在平台输出schema修复证据精确绑定后显式开启新学习批次；旧无效输出未协调或复用。' : repairedAcceptance ? '已为重新审阅确认且字节已变化的候选显式开启新学习验收批次；旧失败批次完整保留。' : reconciledAcceptance ? '已在原有效结果精确协调后显式开启下一独立学习批次；旧封存批次完整保留。' : '用户显式开启下一独立学习批次。', { ordinal, ledgerFile: nextFile, goalVersionId: goal.id, candidateSha256: expectedCandidateSha256, priorLedgerFile: currentFile, failedCandidateSha256: repairedAcceptance ? contractRepair.failedLearningCandidateSha256 : null, priorLedgerSha256: schemaRepairAcceptance ? acceptance.expectedPriorLearningLedgerSha256 : repairedAcceptance ? contractRepair.failedLearningLedgerSha256 : reconciledAcceptance ? reconciled.detail.ledgerSha256 : null, repairExecutionId: repairedAcceptance ? contractExecution.id : null, repairSourceManifestSha256: repairedAcceptance ? contractRepair.sourceManifestSha256 : null, reconciledEventId: reconciledAcceptance ? reconciled.id : null, schemaRepairProofSha256: schemaRepairAcceptance ? acceptance.expectedSchemaRepairProofSha256 : null, failedTurnId: schemaRepairAcceptance ? acceptance.expectedFailedTurnId : null, materialEventId: schemaRepairAcceptance ? acceptance.expectedMaterialEventId : null });
      }).then(({ result }) => { openingEvent = result; taskCommitted = true; });
      await store.guardedEffect(taskId, async (current) => {
        const lockedGoal = helpers.activeGoal(current), lockedArtifact = (current.artifacts || []).filter((entry) => ['candidate', 'confirmed'].includes(entry.status) && helpers.projectArtifactIsCurrent(current, entry)).at(-1);
        const lockedApproval = lockedArtifact && (current.approvals || []).findLast((entry) => entry.artifactId === lockedArtifact.id && entry.status === 'confirmed');
        const lockedReview = lockedArtifact && matchingPassedReview(current, lockedArtifact);
        const eventCurrent = (current.events || []).some((entry) => entry.id === openingEvent?.id && entry.type === eventType && entry.detail?.ledgerFile === nextFile && entry.detail?.goalVersionId === expectedGoalVersionId && entry.detail?.candidateSha256 === expectedCandidateSha256);
        const pendingBytes = await fs.readFile(capabilityFile), pending = JSON.parse(pendingBytes);
        if (!eventCurrent || lockedGoal.id !== expectedGoalVersionId || !lockedApproval || !lockedReview || lockedArtifact?.projectCandidate?.candidateSha256 !== expectedCandidateSha256 || !helpers.projectArtifactIsCurrent(current, lockedArtifact)
          || sha256(pendingBytes) !== pendingCapabilitySha256
          || pending.learning?.enabled !== false || path.resolve(pending.learning?.ledgerFile || '') !== nextFile || pending.phase !== `real-project-learning-${String(ordinal).padStart(2, '0')}-pending`) throw Object.assign(new Error('Learning batch authorization changed before enable'), { status: 409 });
        await assertCandidateCurrent(current, lockedArtifact);
        await writeCapability((cap) => { cap.phase = `real-project-learning-${String(ordinal).padStart(2, '0')}-open`; cap.learning.enabled = true; cap.learning.reason = schemaRepairAcceptance ? '用户在平台输出schema修复证据绑定后显式开启独立学习批次；旧无效原始结果与封存批次保留且不复用。' : repairedAcceptance ? '用户为已重新审阅确认的变更候选显式开启独立学习验收批次；旧失败批次保留。' : reconciledAcceptance ? '用户在精确协调原有效学习结果后显式开启下一独立学习批次；旧封存批次保持不变。' : '用户显式开启下一独立两次/20分钟学习批次；旧批次保留。'; }); enabledWritten = true;
      });
    } catch (error) {
      if (capabilityWritten && !enabledWritten) {
        await store.guardedEffect(taskId, async (current) => {
          const liveBytes = await fs.readFile(capabilityFile);
          if (sha256(liveBytes) !== pendingCapabilitySha256 || sha256(canonical(current)) !== initialTaskSha256) return false;
          const temporary = `${capabilityFile}.${process.pid}.${crypto.randomUUID()}.rollback.tmp`;
          try { await fs.writeFile(temporary, capabilityBytes, { flag: 'wx', mode: 0o600 }); await fs.rename(temporary, capabilityFile); }
          finally { await fs.unlink(temporary).catch(() => {}); }
          return true;
        });
      }
      if (directoryCreated && !taskCommitted) await fs.rmdir(path.dirname(nextFile)).catch(() => {});
      throw error;
    }
    return { ordinal, ledgerFile: nextFile, cap: 2, windowMs: 20 * 60_000 };
  }
  async function authorizePreview(taskId, entryFile) {
    if (!SAFE_FILE.test(entryFile || '') || !/\.html?$/i.test(entryFile)) throw new Error('Preview entry is invalid');
    const task = await store.get(taskId), artifact = (task.artifacts || []).filter((entry) => ['candidate', 'confirmed'].includes(entry.status) && helpers.projectArtifactIsCurrent(task, entry)).at(-1);
    const approval = artifact && (task.approvals || []).findLast((entry) => entry.artifactId === artifact.id && entry.status === 'confirmed');
    if (!approval || !artifact.projectCandidate.changes.includes(entryFile)) throw new Error('Preview entry is not part of the current confirmed candidate');
    await assertCandidateCurrent(task, artifact);
    return { entryFile, candidateSha256: artifact.projectCandidate.candidateSha256 };
  }

  async function recordNativeFailure(taskId, actor, sourceTaskId) {
    const cap = await loadCapability(), before = await store.get(taskId), reviewerFailure = await reviewerFailureEvidence(before, cap);
    const stage = reviewerFailure?.reservation?.detail?.sourceTaskId === sourceTaskId ? 'reviewer' : actor;
    const result = (await store.mutate(taskId, (task) => { if (!task.execution) throw new Error('No execution'); if (reviewerFailure) recordRejectedReview(task, { ...reviewerFailure, artifact: (task.artifacts || []).find((entry) => entry.id === reviewerFailure.artifact.id) }); task.execution.stopReason = 'permanent_error'; task.execution.phase = 'failed'; task.status = 'failed'; return helpers.event(task, 'integration.native_failed', `原生 ${stage} 失败；没有自动重试。`, { actor: stage, reportedActor: actor, sourceTaskId, executionId: task.execution.id, reviewerFailureSha256: reviewerFailure?.textSha256 || null }); })).result;
    const ledgerFile = path.resolve(cap.development?.ledgerFile || '');
    try {
      const stat = await fs.lstat(ledgerFile); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024) throw new Error('Development ledger is invalid');
      const ledger = JSON.parse(await fs.readFile(ledgerFile, 'utf8'));
      if (!ledger.sealed) { ledger.sealed = { at: new Date().toISOString(), reasonCode: 'native_terminal_or_host_rejected' }; const temporary = `${ledgerFile}.${process.pid}.${crypto.randomUUID()}.tmp`; await fs.writeFile(temporary, `${JSON.stringify(ledger, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); await fs.rename(temporary, ledgerFile); }
    } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    await writeCapability((current) => { current.phase = 'real-project-sample-batch-stopped-preserving-failure'; current.development.enabled = false; current.development.reason = `原生${stage}失败；当前独立批次停止且不会自动重试。`; current.learning.enabled = false; });
    return result;
  }

  async function recordAutoReviewDispatchFailure(taskId, input) {
    const required = ['expectedGoalVersionId','expectedExecutionId','expectedCandidateSha256','expectedLedgerSha256','expectedDispatchEventId'];
    if (input?.acknowledgement !== 'preserve_auto_review_dispatch_failure' || required.some((key) => typeof input?.[key] !== 'string')
      || ![input.expectedCandidateSha256,input.expectedLedgerSha256].every((value) => /^[a-f0-9]{64}$/.test(value))) throw Object.assign(new Error('Automatic review dispatch failure binding is invalid'), { status: 400 });
    const cap = await loadCapability(), before = await store.get(taskId), goal = helpers.activeGoal(before);
    const artifact = (before.artifacts || []).filter((entry) => entry.status === 'candidate' && helpers.projectArtifactIsCurrent(before, entry)).at(-1);
    const dispatch = (before.events || []).findLast((entry) => entry.type === 'integration.review_dispatch_reserved' && entry.id === input.expectedDispatchEventId);
    const done = (before.events || []).findLast((entry) => entry.type === 'integration.observation' && entry.detail?.type === 'TASK_DONE' && entry.detail?.actor === 'developer' && entry.detail?.binding?.executionId === input.expectedExecutionId);
    const hostChecked = (before.events || []).findLast((entry) => entry.type === 'integration.host_checked' && entry.detail?.artifactId === artifact?.id && entry.detail?.candidateSha256 === input.expectedCandidateSha256);
    const isBoundReviewerActivity = (entry) => (entry.detail?.executionId || entry.detail?.binding?.executionId) === input.expectedExecutionId
      && ((entry.type === 'integration.run_reserved' && entry.detail?.actor === 'reviewer')
        || (entry.type === 'integration.observation' && entry.detail?.actor === 'reviewer' && ['TASK_STARTED','TASK_DONE','TASK_FAILED'].includes(entry.detail?.type)));
    const reviewerActivity = (before.events || []).some(isBoundReviewerActivity);
    if (goal.id !== input.expectedGoalVersionId || before.execution?.id !== input.expectedExecutionId || before.execution.stopReason
      || artifact?.projectCandidate?.candidateSha256 !== input.expectedCandidateSha256 || cap.development?.executionId !== input.expectedExecutionId
      || cap.candidateSha256 !== input.expectedCandidateSha256 || !done || !hostChecked || !dispatch
      || dispatch.detail?.executionId !== input.expectedExecutionId || dispatch.detail?.candidateSha256 !== input.expectedCandidateSha256 || reviewerActivity) {
      throw Object.assign(new Error('Automatic review dispatch failure binding is stale'), { status: 409 });
    }
    await assertCandidateCurrent(before, artifact);
    const ledgerFile = path.resolve(cap.development?.ledgerFile || ''), ledgerStat = await fs.lstat(ledgerFile);
    if (!ledgerStat.isFile() || ledgerStat.isSymbolicLink() || ledgerStat.nlink !== 1 || ledgerStat.size > 1024 * 1024 || await fs.realpath(ledgerFile) !== ledgerFile) throw new Error('Development ledger is invalid');
    const ledgerBytes = await fs.readFile(ledgerFile), ledger = JSON.parse(ledgerBytes), calls = ledger.calls || [], developer = calls[0];
    if (sha256(ledgerBytes) !== input.expectedLedgerSha256 || ledger.cap !== 2 || ledger.windowMs !== 20 * 60_000 || calls.length !== 1
      || developer?.expectedRole !== 'developer' || developer.status !== 'completed' || developer.exitCode !== 0 || developer.signal || developer.declaredStatus !== 'done'
      || calls.some((call) => ['reserved','running'].includes(call.status)) || (ledger.sealed && !['auto_review_dispatch_failed','platform_auto_review_dispatch_failed'].includes(ledger.sealed.reasonCode))) {
      throw Object.assign(new Error('Automatic review dispatch failure ledger is not an exact successful Developer-only batch'), { status: 409 });
    }
    if (!ledger.sealed && (!Number.isFinite(Date.parse(ledger.deadlineAt)) || Date.now() < Date.parse(ledger.deadlineAt))) throw Object.assign(new Error('Automatic review dispatch window has not expired and is not sealed'), { status: 409 });
    if (!ledger.sealed) {
      ledger.sealed = { at: new Date().toISOString(), reasonCode: 'platform_auto_review_dispatch_failed' };
      const temporary = `${ledgerFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
      try { await fs.writeFile(temporary, `${JSON.stringify(ledger, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); await fs.rename(temporary, ledgerFile); }
      finally { await fs.unlink(temporary).catch(() => {}); }
    }
    const sealedBytes = await fs.readFile(ledgerFile), sealedLedgerSha256 = sha256(sealedBytes);
    const result = (await store.mutate(taskId, async (task) => {
      const currentGoal = helpers.activeGoal(task), currentArtifact = (task.artifacts || []).find((entry) => entry.id === artifact.id);
      if (currentGoal.id !== input.expectedGoalVersionId || task.execution?.id !== input.expectedExecutionId || task.execution.stopReason
        || !currentArtifact || !helpers.projectArtifactIsCurrent(task, currentArtifact)
        || (task.events || []).some(isBoundReviewerActivity)) throw Object.assign(new Error('Automatic review dispatch binding changed before recording'), { status: 409 });
      currentArtifact.status = 'rejected'; currentArtifact.reviewStatus = 'not_started';
      currentArtifact.autoReviewDispatch = { failed: true, dispatchEventId: input.expectedDispatchEventId, reason: 'gateway_observation_envelope_not_unwrapped', priorLedgerSha256: input.expectedLedgerSha256, sealedLedgerSha256 };
      task.execution.phase = 'failed'; task.execution.stopReason = 'permanent_error'; task.execution.updatedAt = new Date().toISOString(); task.status = 'failed'; task.activeRole = 'reviewer';
      return helpers.event(task, 'integration.auto_review_dispatch_failed', 'Developer候选和host检查已保存，但平台未派发已保留的自动Reviewer；批次按平台故障封存，可显式只读复用同一候选。', { executionId: input.expectedExecutionId, artifactId: currentArtifact.id, candidateSha256: input.expectedCandidateSha256, dispatchEventId: input.expectedDispatchEventId, priorLedgerSha256: input.expectedLedgerSha256, sealedLedgerSha256, failureCode: 'gateway_observation_envelope_not_unwrapped', nativeReviewerCalls: 0 });
    })).result;
    await writeCapability((current) => { current.phase = 'real-project-auto-review-dispatch-failed'; current.development.enabled = false; current.development.reason = '自动Reviewer平台派发失败；Developer候选与原批次已保留，等待显式review-only批次。'; current.learning.enabled = false; });
    return { recorded: true, eventId: result.id, executionId: input.expectedExecutionId, candidateSha256: input.expectedCandidateSha256, dispatchEventId: input.expectedDispatchEventId, priorLedgerSha256: input.expectedLedgerSha256, sealedLedgerSha256, reviewerCalls: 0 };
  }

  async function recordHostClientFailure(taskId, input) {
    const required = ['expectedGoalVersionId', 'expectedExecutionId', 'expectedCandidateSha256', 'evidenceFile', 'evidenceSha256'];
    if (required.some((key) => typeof input?.[key] !== 'string') || !/^sample-batch-[0-9]{2,4}-bound-native-client-failure\.json$/.test(input.evidenceFile)
      || !/^[a-f0-9]{64}$/.test(input.evidenceSha256)) throw Object.assign(new Error('Host client failure binding is invalid'), { status: 400 });
    const evidenceFile = path.join(path.dirname(projectFile), 'evidence', input.evidenceFile), evidenceStat = await fs.lstat(evidenceFile);
    if (!evidenceStat.isFile() || evidenceStat.isSymbolicLink() || evidenceStat.nlink !== 1 || evidenceStat.size > 256 * 1024 || await fs.realpath(evidenceFile) !== evidenceFile) throw new Error('Registered host client evidence is invalid');
    const evidenceBytes = await fs.readFile(evidenceFile), evidence = JSON.parse(evidenceBytes);
    if (sha256(evidenceBytes) !== input.evidenceSha256 || evidence.candidateSha256 !== input.expectedCandidateSha256 || evidence.passed !== false
      || evidence.sourceUnchanged !== true || evidence.nativeModelCalls !== 0 || evidence.actualBrowser !== false) throw Object.assign(new Error('Host client evidence does not prove a bound zero-model failure'), { status: 409 });
    const cap = await loadCapability(), ledgerFile = path.resolve(cap.development?.ledgerFile || ''), ledgerStat = await fs.lstat(ledgerFile);
    if (!ledgerStat.isFile() || ledgerStat.isSymbolicLink() || ledgerStat.nlink !== 1 || ledgerStat.size > 1024 * 1024 || await fs.realpath(ledgerFile) !== ledgerFile) throw new Error('Development ledger is invalid');
    const ledgerBytes = await fs.readFile(ledgerFile), ledger = JSON.parse(ledgerBytes), calls = ledger.calls || [];
    const developer = calls.find((call) => call.expectedRole === 'developer');
    if (ledger.sealed?.reasonCode !== 'host_native_client_check_failed' || calls.some((call) => ['reserved', 'running'].includes(call.status))
      || !developer || developer.status !== 'completed' || developer.exitCode !== 0 || developer.signal || developer.declaredStatus !== 'done'
      || calls.some((call) => call.expectedRole === 'reviewer')) throw Object.assign(new Error('Development ledger is not a sealed Developer-only host-check failure'), { status: 409 });
    const before = await store.get(taskId), goal = helpers.activeGoal(before), artifact = (before.artifacts || []).filter((entry) => entry.status === 'candidate' && helpers.projectArtifactIsCurrent(before, entry)).at(-1);
    if (goal.id !== input.expectedGoalVersionId || before.execution?.id !== input.expectedExecutionId || before.execution.stopReason
      || artifact?.projectCandidate?.candidateSha256 !== input.expectedCandidateSha256 || cap.development?.executionId !== before.execution.id
      || cap.candidateSha256 !== input.expectedCandidateSha256 || (before.events || []).some((entry) => entry.type === 'integration.run_reserved' && entry.detail?.actor === 'reviewer' && entry.detail?.executionId === before.execution.id)) {
      throw Object.assign(new Error('Host client failure binding is stale'), { status: 409 });
    }
    await assertCandidateCurrent(before, artifact);
    const currentManifest = await manifest(workspaceRoot), byPath = new Map(currentManifest.map((entry) => [entry.path, entry.sha256]));
    if (evidence.appSha256 !== byPath.get('app.js') || evidence.coreSha256 !== byPath.get('core.js')) throw Object.assign(new Error('Host client evidence source hashes do not match the current candidate'), { status: 409 });
    const result = (await store.mutate(taskId, (task) => {
      const currentGoal = helpers.activeGoal(task), currentArtifact = (task.artifacts || []).find((entry) => entry.id === artifact.id);
      if (currentGoal.id !== goal.id || task.execution?.id !== input.expectedExecutionId || task.execution.stopReason || !currentArtifact || !helpers.projectArtifactIsCurrent(task, currentArtifact)) throw Object.assign(new Error('Host client failure binding changed before recording'), { status: 409 });
      currentArtifact.status = 'rejected'; currentArtifact.reviewStatus = 'failed';
      currentArtifact.hostClientAcceptance = { passed: false, evidenceFile: input.evidenceFile, evidenceSha256: input.evidenceSha256, ledgerSha256: sha256(ledgerBytes), nativeModelCalls: 0, actualBrowser: false };
      task.execution.phase = 'failed'; task.execution.stopReason = 'permanent_error'; task.execution.updatedAt = new Date().toISOString(); task.status = 'failed'; task.activeRole = 'writer';
      return helpers.event(task, 'integration.host_client_check_failed', '当前精确候选未通过独立宿主客户端验收；原始零模型证据与已封存ledger保持不变。', { executionId: task.execution.id, artifactId: currentArtifact.id, candidateSha256: input.expectedCandidateSha256, evidenceFile: input.evidenceFile, evidenceSha256: input.evidenceSha256, ledgerSha256: sha256(ledgerBytes), reasonCode: ledger.sealed.reasonCode, nativeModelCalls: 0, actualBrowser: false });
    })).result;
    await writeCapability((current) => { current.phase = 'real-project-host-client-check-failed'; current.development.enabled = false; current.development.reason = '当前候选未通过绑定的宿主客户端验收；批次已封存且不会自动重试。'; current.learning.enabled = false; current.learning.reason = '候选未通过宿主客户端验收。'; });
    return { recorded: true, eventId: result.id, executionId: input.expectedExecutionId, candidateSha256: input.expectedCandidateSha256, evidenceSha256: input.evidenceSha256, ledgerSha256: sha256(ledgerBytes), nativeModelCalls: 0 };
  }

  async function coordinateSealedReviewerResult(taskId, input) {
    const fields = ['expectedGoalVersionId', 'expectedExecutionId', 'expectedCandidateSha256', 'sourceTaskId', 'expectedLedgerSha256', 'expectedStdoutSha256'];
    if (fields.some((key) => typeof input?.[key] !== 'string') || !/^review-[A-Za-z0-9_-]{1,120}$/.test(input.sourceTaskId)
      || ![input.expectedCandidateSha256, input.expectedLedgerSha256, input.expectedStdoutSha256].every((value) => /^[a-f0-9]{64}$/.test(value))) throw Object.assign(new Error('Sealed Reviewer result binding is invalid'), { status: 400 });
    const cap = await loadCapability(), ledgerFile = path.resolve(cap.development?.ledgerFile || ''), ledgerStat = await fs.lstat(ledgerFile);
    if (!ledgerStat.isFile() || ledgerStat.isSymbolicLink() || ledgerStat.nlink !== 1 || ledgerStat.size > 1024 * 1024 || await fs.realpath(ledgerFile) !== ledgerFile) throw new Error('Development ledger is invalid');
    const ledgerBytes = await fs.readFile(ledgerFile), ledger = JSON.parse(ledgerBytes);
    const dualCall = canonical(ledger.roleOrder) === canonical(['developer','reviewer']) && ledger.calls?.length === 2;
    const call = dualCall ? ledger.calls[1] : ledger.calls?.[0], developerCall = dualCall ? ledger.calls[0] : null;
    if (sha256(ledgerBytes) !== input.expectedLedgerSha256 || ledger.sealed?.reasonCode !== 'native_terminal_or_host_rejected'
      || (!dualCall && canonical(ledger.roleOrder) !== canonical(['reviewer'])) || (!dualCall && ledger.calls?.length !== 1) || call?.expectedRole !== 'reviewer'
      || call.status !== 'completed' || call.exitCode !== 0 || call.signal || call.declaredStatus !== 'done' || call.semanticFailureReason
      || !call.stdout?.file || call.stdout.sha256 !== input.expectedStdoutSha256) throw Object.assign(new Error('Sealed Reviewer ledger is not an exact successful review-only result'), { status: 409 });
    if (dualCall && (developerCall?.expectedRole !== 'developer' || developerCall.status !== 'completed' || developerCall.exitCode !== 0 || developerCall.signal
      || developerCall.declaredStatus !== 'done' || developerCall.semanticFailureReason || !developerCall.stdout?.file
      || input.expectedDeveloperStdoutSha256 !== developerCall.stdout.sha256 || typeof input.expectedSourceManifestSha256 !== 'string'
      || input.hostProofFile !== boundHostProofFile(cap.development?.batchId)
      || !/^[a-f0-9]{64}$/.test(input.hostProofSha256 || ''))) throw Object.assign(new Error('Sealed Developer evidence is incomplete'), { status: 409 });
    const stdoutFile = path.resolve(path.dirname(ledgerFile), call.stdout.file);
    if (!stdoutFile.startsWith(`${path.dirname(ledgerFile)}${path.sep}`)) throw new Error('Reviewer stdout path is invalid');
    const stdoutStat = await fs.lstat(stdoutFile);
    if (!stdoutStat.isFile() || stdoutStat.isSymbolicLink() || stdoutStat.nlink !== 1 || stdoutStat.size > 40_000 || await fs.realpath(stdoutFile) !== stdoutFile) throw new Error('Reviewer stdout is invalid');
    const stdoutBytes = await fs.readFile(stdoutFile), text = stdoutBytes.toString('utf8');
    if (sha256(stdoutBytes) !== input.expectedStdoutSha256 || call.stdout.bytes !== stdoutBytes.length || !/(?:^|\n)\s*(?:\*\*)?VERDICT:(?:\*\*)?\s*PASS\b/im.test(text)) throw Object.assign(new Error('Sealed Reviewer stdout is not the bound PASS'), { status: 409 });
    const task = await store.get(taskId), goal = helpers.activeGoal(task), artifact = (task.artifacts || []).filter((entry) => entry.status === 'candidate' && helpers.projectArtifactIsCurrent(task, entry)).at(-1);
    const reservation = (task.events || []).findLast((entry) => entry.type === 'integration.run_reserved' && entry.detail?.actor === 'reviewer' && entry.detail?.sourceTaskId === input.sourceTaskId && entry.detail?.executionId === input.expectedExecutionId && entry.detail?.candidateSha256 === input.expectedCandidateSha256);
    const started = (task.events || []).findLast((entry) => entry.type === 'integration.observation' && entry.detail?.type === 'TASK_STARTED' && entry.detail?.actor === 'reviewer' && entry.detail?.sourceTaskId === input.sourceTaskId && entry.detail?.binding?.executionId === input.expectedExecutionId && entry.detail?.binding?.candidateSha256 === input.expectedCandidateSha256);
    const transportFailure = (task.events || []).findLast((entry) => entry.type === 'integration.native_failed' && entry.detail?.actor === 'reviewer' && entry.detail?.sourceTaskId === input.sourceTaskId && entry.detail?.executionId === input.expectedExecutionId);
    if (dualCall) {
      const developerStdoutFile = path.resolve(path.dirname(ledgerFile), developerCall.stdout.file);
      if (!developerStdoutFile.startsWith(`${path.dirname(ledgerFile)}${path.sep}`)) throw new Error('Developer stdout path is invalid');
      const developerStdoutStat = await fs.lstat(developerStdoutFile);
      if (!developerStdoutStat.isFile() || developerStdoutStat.isSymbolicLink() || developerStdoutStat.nlink !== 1 || developerStdoutStat.size > 40_000 || await fs.realpath(developerStdoutFile) !== developerStdoutFile) throw new Error('Developer stdout is invalid');
      const developerStdoutBytes = await fs.readFile(developerStdoutFile);
      if (sha256(developerStdoutBytes) !== input.expectedDeveloperStdoutSha256 || developerStdoutBytes.length !== developerCall.stdout.bytes) throw Object.assign(new Error('Developer stdout digest changed'), { status: 409 });
      const developerDone = (task.events || []).findLast((entry) => entry.type === 'integration.observation' && entry.detail?.type === 'TASK_DONE' && entry.detail?.actor === 'developer' && entry.detail?.binding?.executionId === input.expectedExecutionId && entry.detail?.resultSha256 === input.expectedDeveloperStdoutSha256);
      const developerReservation = (task.events || []).findLast((entry) => entry.type === 'integration.run_reserved' && entry.detail?.actor === 'developer' && entry.detail?.executionId === input.expectedExecutionId && entry.detail?.sourceTaskId === developerDone?.detail?.sourceTaskId);
      const developerStarted = (task.events || []).findLast((entry) => entry.type === 'integration.observation' && entry.detail?.type === 'TASK_STARTED' && entry.detail?.actor === 'developer' && entry.detail?.sourceTaskId === developerDone?.detail?.sourceTaskId && entry.detail?.binding?.executionId === input.expectedExecutionId);
      if (!developerReservation || !developerStarted || !developerDone || artifact?.projectCandidate?.candidateSha256 !== input.expectedSourceManifestSha256) throw Object.assign(new Error('Developer execution provenance is not exact'), { status: 409 });
      const proofFile = path.join(path.dirname(projectFile), 'evidence', input.hostProofFile), proofStat = await fs.lstat(proofFile);
      if (!proofStat.isFile() || proofStat.isSymbolicLink() || proofStat.nlink !== 1 || proofStat.size > 256 * 1024 || await fs.realpath(proofFile) !== proofFile) throw new Error('Registered sample-batch-20 host proof is invalid');
      const proofBytes = await fs.readFile(proofFile), proof = JSON.parse(proofBytes);
      if (sha256(proofBytes) !== input.hostProofSha256 || proof.batchId && proof.batchId !== cap.development.batchId || proof.executionId !== input.expectedExecutionId || proof.candidateSha256 !== input.expectedCandidateSha256
        || proof.sourceManifestSha256 !== input.expectedSourceManifestSha256 || proof.developerStdoutSha256 !== input.expectedDeveloperStdoutSha256
        || proof.hostChecksPassed !== true || proof.sourceUnchanged !== true || proof.nativeModelCalls !== 0) throw Object.assign(new Error('Development-20 host proof does not match the sealed candidate'), { status: 409 });
    }
    if (goal.id !== input.expectedGoalVersionId || task.execution?.id !== input.expectedExecutionId || task.execution?.phase !== 'failed' || task.execution?.stopReason !== 'permanent_error'
      || artifact?.projectCandidate?.candidateSha256 !== input.expectedCandidateSha256 || cap.development?.executionId !== input.expectedExecutionId || cap.candidateSha256 !== input.expectedCandidateSha256
      || !reservation || !started || !transportFailure || (task.reviews || []).some((entry) => entry.artifactId === artifact.id)) throw Object.assign(new Error('Sealed Reviewer result no longer matches the preserved transport failure'), { status: 409 });
    await assertCandidateCurrent(task, artifact);
    const review = (await store.mutate(taskId, (current) => {
      const currentArtifact = (current.artifacts || []).find((entry) => entry.id === artifact.id);
      if (!currentArtifact || !helpers.projectArtifactIsCurrent(current, currentArtifact) || current.execution?.id !== input.expectedExecutionId || current.execution?.stopReason !== 'permanent_error') throw Object.assign(new Error('Sealed Reviewer result binding changed'), { status: 409 });
      const facts = helpers.createTrustedProjectReviewFacts(current, currentArtifact);
      const checks = ['目标符合度', '完整性', '来源核对', '边界遵守', '文件可用性'].map((name) => ({ name, passed: true, evidence: 'Bound sealed native readonly Reviewer returned PASS for the exact current candidate.', blocking: true }));
      const result = helpers.recordReview(current, currentArtifact.id, { checks, summary: text, provider: 'codex-cli' }, { projectReviewFacts: facts });
      result.nativeVerdict = 'PASS'; result.scopeOutcome = 'passed'; result.sourceTaskId = input.sourceTaskId; result.fullOutputSha256 = input.expectedStdoutSha256; result.projectCandidateFingerprint = helpers.projectCandidateFingerprint(currentArtifact.projectCandidate); result.coordinatedFromSealedTransportFailure = true;
      helpers.event(current, 'integration.sealed_reviewer_result_coordinated', '已将封存批次中原始只读Reviewer PASS与当前精确候选协调；原transport失败事件和ledger保持不变。', { executionId: input.expectedExecutionId, artifactId: currentArtifact.id, candidateSha256: input.expectedCandidateSha256, sourceTaskId: input.sourceTaskId, ledgerSha256: input.expectedLedgerSha256, stdoutSha256: input.expectedStdoutSha256 });
      return result;
    })).result;
    await writeCapability((current) => { current.phase = 'real-project-review-pass-awaiting-confirmation'; current.development.enabled = false; current.development.reason = '封存批次的原始只读Reviewer PASS已与当前候选精确协调；等待候选确认。'; current.learning.enabled = false; });
    return { coordinated: true, reviewId: review.id, artifactId: artifact.id, candidateSha256: input.expectedCandidateSha256, nativeVerdict: 'PASS', ledgerSha256: input.expectedLedgerSha256, stdoutSha256: input.expectedStdoutSha256 };
  }
  return { store, helpers, state, confirmGoal, authorize, authorizeGoalIncrement, openRepairBatch, prepareCleanRepairInput, validateCleanRepairInput, openCleanRepairBatch, assertRepairInputCurrent, assertRegisteredExecutionCurrent, hostCheck, recordReviewer, recordNativeFailure, recordAutoReviewDispatchFailure, recordHostClientFailure, coordinateSealedReviewerResult, confirm, openLearningBatch, clientState, saveClientState, authorizePreview, assertCandidateCurrent, workspaceRoot };
}

export const __test = { PROJECT_ID, DEVELOPER_TAG, ARTICLE_PROJECT_CAPACITY, manifest, reviewDiff, developerRequest, classifyReviewerOutcome, boundHostProofFile };
