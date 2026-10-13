import { historicalBindings } from './historical-bindings.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { canonical, fingerprint, sha256 } from './authority-core.mjs';

// One evidenced input selection. This is preparation, not authorization to run.
export const CLEAN_INPUT35 = historicalBindings.cleanInput35;

const fail = (message) => Object.assign(new Error(message), { status: 409 });
async function regular(file, max = 8 * 1024 * 1024) {
  const absolute = path.resolve(file), stat = await fs.lstat(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > max || await fs.realpath(absolute) !== absolute) throw fail('Clean input evidence is not a bounded canonical regular file');
  return fs.readFile(absolute);
}

export async function cleanRepairReviewBoundary(task,projectFile) {
  const repair = task?.execution?.repair, binding = repair?.cleanInputBinding;
  if (!binding) return null;
  const root = path.dirname(projectFile), registrationBytes = await regular(path.join(root,'evidence','clean-input35-fixed-acceptance-registration-20261007.json'),48_000), registration = JSON.parse(registrationBytes);
  const brief = await regular(path.join(root,'evidence',CLEAN_INPUT35.briefFile),48_000);
  if (sha256(registrationBytes) !== CLEAN_INPUT35.registrationSha256 || binding.registrationSha256 !== CLEAN_INPUT35.registrationSha256
    || binding.inputCandidateSha256 !== CLEAN_INPUT35.inputCandidateSha256 || binding.failedWorkspaceFingerprint !== CLEAN_INPUT35.failedWorkspaceFingerprint
    || canonical(binding.allowedChangedFiles) !== canonical([...CLEAN_INPUT35.allowedChangedFiles]) || repair.repairBriefFile !== CLEAN_INPUT35.briefFile
    || sha256(brief) !== registration.briefSha256 || sha256(brief) !== repair.repairBriefSha256) throw fail('Effective clean Reviewer scope is stale');
  return `Additional accepted scope of this exact repair: review the candidate against the finite F1 decision/UI/evidence/save/reopen contract below, with app.js explicitly writable and test-core.js read-only. Record unchanged F2 or unrelated historical theories separately; they do not authorize changes or new qualification rules. Do not reuse obsolete Reviewer commands. A scoped repair PASS is not complete Personal Agent or live-learning acceptance. Registered brief SHA-256 ${repair.repairBriefSha256}:\n${brief.toString('utf8')}`;
}

export function createCleanRepairInputManager({ projectFile, capabilityFile, store, helpers, workspaceRoot, manifest, repairInputManifest }) {
  const projectRoot = path.dirname(projectFile), preparationRoot = path.join(path.dirname(capabilityFile), 'repair-input-preparations');
  let active = null, activationQueue = Promise.resolve();
  async function inspect(taskId, input, activated = false) {
    const policy = CLEAN_INPUT35, task = await store.get(taskId), capabilityBytes = await regular(capabilityFile), cap = JSON.parse(capabilityBytes);
    const goal = helpers.activeGoal(task), project = JSON.parse(await regular(projectFile));
    if (goal.id !== policy.goalVersionId || (task.events || []).findLast(e => e.type === 'intake.goal_confirmed')?.detail?.goalVersionId !== goal.id
      || canonical({ statement: goal.statement, successCriteria: goal.successCriteria, boundaries: goal.boundaries }) !== canonical(project.goalDraft)
      || task.execution?.id !== policy.failedExecutionId || task.execution?.phase !== 'failed' || task.execution?.stopReason !== 'permanent_error'
      || cap.development?.enabled !== false || cap.learning?.enabled !== false || cap.development?.executionId !== task.execution.id
      || !helpers.projectWorkspaceIsCurrent(task)) throw fail('Clean input preparation requires the exact stopped development46 and current goal');
    const expected = { expectedGoalVersionId: goal.id, expectedFailedExecutionId: task.execution.id, expectedConfirmedCandidateSha256: policy.confirmedCandidateSha256,
      expectedSourceCandidateSha256: policy.inputCandidateSha256, expectedFailedWorkspaceFingerprint: policy.failedWorkspaceFingerprint,
      expectedPriorLedgerSha256: policy.failedLedgerSha256, expectedScopeFingerprint: task.projectWorkspace.scopeFingerprint };
    if (Object.entries(expected).some(([k,v]) => input?.[k] !== v)) throw fail('Clean input selection binding is stale or incomplete');
    const confirmed = (task.artifacts || []).find(a => a.version === policy.confirmedVersion && a.status === 'confirmed' && a.goalVersionId === goal.id);
    const source = (task.artifacts || []).find(a => a.version === policy.inputVersion && a.status === 'rejected' && a.goalVersionId === goal.id);
    if (confirmed?.projectCandidate?.candidateSha256 !== policy.confirmedCandidateSha256 || source?.projectCandidate?.candidateSha256 !== policy.inputCandidateSha256
      || !(task.approvals || []).some(a => a.artifactId === confirmed.id && a.status === 'confirmed')
      || !(task.reviews || []).some(r => r.artifactId === confirmed.id && r.passed === true && r.nativeVerdict === 'PASS')
      || !(task.reviews || []).some(r => r.artifactId === source.id && r.passed === false && r.nativeVerdict === 'FAIL')) throw fail('Confirmed28 and rejected35 must remain distinct evidenced versions of the same goal');
    const ledgerFile = path.resolve(cap.development.ledgerFile), ledgerBytes = await regular(ledgerFile), ledger = JSON.parse(ledgerBytes);
    if (ledgerFile !== path.join(path.dirname(capabilityFile), 'development-46', 'model-ledger.json') || sha256(ledgerBytes) !== policy.failedLedgerSha256
      || ledger.sealed?.reasonCode !== 'native_terminal_or_host_rejected' || ledger.calls?.length !== 1
      || ledger.calls[0].expectedRole !== 'developer' || ledger.calls[0].status !== 'completed') throw fail('Exact failed46 ledger must stay sealed without a Reviewer');
    for (const [file,hash] of [[policy.inputManifestFile,policy.inputManifestSha256],[policy.failedManifestFile,policy.failedManifestSha256],[policy.failedReportFile,policy.failedReportSha256]])
      if (sha256(await regular(path.join(projectRoot,file))) !== hash) throw fail('Clean input historical evidence changed');
    const inputManifest = await manifest(path.join(projectRoot,policy.inputSource)), failedRoot = activated ? active?.archiveRoot : workspaceRoot;
    if (!failedRoot || fingerprint(inputManifest) !== policy.inputCandidateSha256 || fingerprint(await manifest(failedRoot)) !== policy.failedWorkspaceFingerprint
      || canonical(inputManifest) !== canonical(source.projectCandidate.sourceIntegrity?.current)) throw fail('Clean35 source or preserved46 workspace does not match its exact manifest');
    const briefBytes = await regular(path.join(projectRoot,'evidence',policy.briefFile),48_000);
    const registrationBytes = await regular(path.join(projectRoot,'evidence','clean-input35-fixed-acceptance-registration-20261007.json'),48_000), registration = JSON.parse(registrationBytes);
    if (sha256(registrationBytes) !== policy.registrationSha256 || registration.schemaVersion !== 1 || registration.goalVersionId !== goal.id || registration.inputCandidateSha256 !== policy.inputCandidateSha256
      || registration.briefFile !== policy.briefFile || registration.briefSha256 !== sha256(briefBytes)
      || canonical(registration.allowedChangedFiles) !== canonical([...policy.allowedChangedFiles]) || registration.newModelCalls !== 0) throw fail('Clean input active brief or fixed acceptance registration changed');
    for (const gate of registration.gates || []) if (!gate.file.startsWith('tools/') || gate.file.includes('..') || sha256(await regular(path.join(projectRoot,gate.file),256_000)) !== gate.sha256) throw fail('Clean input fixed gate changed');
    if (!registration.gates?.length) throw fail('Clean input fixed acceptance gates are absent');
    return { task, cap, expected, taskFingerprint:fingerprint(task), capabilitySha256:sha256(capabilityBytes), projectSha256:sha256(await regular(projectFile)), confirmed, source, inputManifest,
      inputRepairManifest:await repairInputManifest(path.join(projectRoot,policy.inputSource)), briefSha256:sha256(briefBytes), registrationSha256:sha256(registrationBytes), registration };
  }
  async function prepare(taskId,input) {
    if (input?.acknowledgement !== 'prepare_clean_input_only') throw fail('Preparation does not authorize opening a model batch');
    return store.guardedEffect(taskId,async () => {
      const context = await inspect(taskId,input), id = `clean35-after46-${context.taskFingerprint.slice(0,16)}`, dir = path.join(preparationRoot,id);
      await fs.mkdir(preparationRoot,{recursive:true,mode:0o700});
      if (await fs.realpath(preparationRoot) !== preparationRoot) throw fail('Clean input preparation root contains a link');
      await fs.mkdir(dir,{recursive:false,mode:0o700});
      const sourceRoot = path.join(dir,'source');
      await fs.cp(path.join(projectRoot,CLEAN_INPUT35.inputSource),sourceRoot,{recursive:true,errorOnExist:true,force:false});
      if (fingerprint(await manifest(sourceRoot)) !== CLEAN_INPUT35.inputCandidateSha256) throw fail('Prepared source copy changed');
      const body = { schemaVersion:1, preparedId:id, preparedAt:new Date().toISOString(), taskId, goalVersionId:context.task.goal.activeVersionId,
        expected:context.expected, taskFingerprint:context.taskFingerprint, capabilitySha256:context.capabilitySha256, projectSha256:context.projectSha256,
        confirmedArtifactId:context.confirmed.id, confirmedVersion:28, inputArtifactId:context.source.id, inputVersion:35, inputStatus:'rejected', inputIsConfirmed:false,
        failedWorkspaceFingerprint:CLEAN_INPUT35.failedWorkspaceFingerprint, inputCandidateSha256:CLEAN_INPUT35.inputCandidateSha256,
        inputManifest:context.inputManifest, inputRepairManifest:context.inputRepairManifest, inputRepairManifestSha256:fingerprint(context.inputRepairManifest),
        briefFile:CLEAN_INPUT35.briefFile, briefSha256:context.briefSha256, registrationSha256:context.registrationSha256,
        allowedChangedFiles:[...CLEAN_INPUT35.allowedChangedFiles], historicalReviewerInstruction:'reference_only_not_execution_requirements',
        actualModelCalls:0, batchOpened:false, developmentEnabled:false, learningEnabled:false };
      const bytes = Buffer.from(`${JSON.stringify(body,null,2)}\n`), file = path.join(dir,'preparation.json'); await fs.writeFile(file,bytes,{flag:'wx',mode:0o600});
      return { ...body, preparationSha256:sha256(bytes), sourceRoot, preparationFile:file };
    });
  }
  async function validate(taskId,input) {
    if (!/^clean35-after46-[a-f0-9]{16}$/.test(input?.preparedId || '') || !/^[a-f0-9]{64}$/.test(input?.expectedPreparationSha256 || '')) throw fail('Prepared clean input identity is invalid');
    const dir = path.join(preparationRoot,input.preparedId), bytes = await regular(path.join(dir,'preparation.json')), record = JSON.parse(bytes);
    if (sha256(bytes) !== input.expectedPreparationSha256 || record.preparedId !== input.preparedId || record.taskId !== taskId) throw fail('Prepared clean input digest is stale');
    const context = await inspect(taskId,record.expected);
    if (record.taskFingerprint !== context.taskFingerprint || record.capabilitySha256 !== context.capabilitySha256 || record.projectSha256 !== context.projectSha256
      || record.briefSha256 !== context.briefSha256 || record.registrationSha256 !== context.registrationSha256
      || canonical(record.inputManifest) !== canonical(context.inputManifest) || fingerprint(await manifest(path.join(dir,'source'))) !== CLEAN_INPUT35.inputCandidateSha256) throw fail('Prepared clean input changed or its stopped-state binding is stale');
    return {record,dir,context};
  }
  async function activateOnce(taskId,input,open) {
    if (input?.acknowledgement !== 'open_clean_prepared_repair' || input.maxModelCalls !== 2 || input.maxDurationMs !== 20*60_000 || input.optInBoundedAutoReview !== true) throw fail('A clean input batch requires a separate explicit two-call authorization');
    const {record,dir,context} = await validate(taskId,input), activationDir = path.join(dir,`activation-${crypto.randomUUID()}`), stagedRoot = path.join(activationDir,'clean-source');
    await fs.mkdir(activationDir,{recursive:false,mode:0o700});
    await fs.cp(path.join(dir,'source'),stagedRoot,{recursive:true,errorOnExist:true,force:false});
    if (fingerprint(await manifest(stagedRoot)) !== CLEAN_INPUT35.inputCandidateSha256) throw fail('Activation staging changed');
    const fresh = await inspect(taskId,record.expected);
    if (fresh.taskFingerprint !== context.taskFingerprint || fresh.capabilitySha256 !== context.capabilitySha256) throw fail('Stopped state changed before input activation');
    const archiveRoot = path.join(activationDir,'preserved-failed46-workspace');
    await fs.rename(workspaceRoot,archiveRoot);
    try {
      await fs.rename(stagedRoot,workspaceRoot);
      active = {record,archiveRoot,activationDir};
      return await open(active);
    } catch (error) {
      // Roll back only our untouched copy. Never overwrite concurrent edits.
      const currentTask = await store.get(taskId), currentCap = await regular(capabilityFile);
      const currentManifest = await manifest(workspaceRoot).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
      if (fingerprint(currentTask) === context.taskFingerprint && sha256(currentCap) === context.capabilitySha256
        && (!currentManifest || fingerprint(currentManifest) === CLEAN_INPUT35.inputCandidateSha256)) {
        if (currentManifest) await fs.rename(workspaceRoot,path.join(activationDir,'unactivated-clean-source'));
        await fs.rename(archiveRoot,workspaceRoot);
      } else error.message += '; activation retained: concurrent or registered state must not be overwritten';
      throw error;
    } finally { active = null; }
  }
  async function activate(taskId,input,open) {
    const previous = activationQueue; let release;
    activationQueue = new Promise(resolve => { release = resolve; });
    await previous;
    try { return await activateOnce(taskId,input,open); } finally { release(); }
  }
  async function assertActive(binding) {
    if (!active || binding !== active) throw fail('Clean activation binding was not issued by this preparation manager');
    await inspect(active.record.taskId,active.record.expected,true);
    if (fingerprint(await manifest(workspaceRoot)) !== CLEAN_INPUT35.inputCandidateSha256) throw fail('Active clean input changed before registration');
  }
  return { prepare, validate, activate, assertActive };
}
