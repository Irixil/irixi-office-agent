import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createArticleProjectController } from '../../../../authority/article-project-controller.mjs';
import { createIntakeController, __test as intakeTest } from '../../../../authority/intake-controller.mjs';

const TASK_ID = 'task-article-learning-12';
const PROJECT_ID = 'article-learning-12';
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

export async function createActualHostMaterialMismatchFixture({ projectRoot }) {
  const root = path.resolve(projectRoot);
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'development43-host-fixture-'));
  const tasksRoot = path.join(temporaryRoot, 'tasks');
  const taskDirectory = path.join(tasksRoot, TASK_ID);
  const projectFile = path.join(temporaryRoot, 'project.json');
  const capabilityFile = path.join(temporaryRoot, 'model-capability.json');
  const oldRecordFile = path.join(root, 'backend/learning09-real-A-terminal-20261006/original-server-state-revision16.json');
  const sourceTaskFile = path.join(root, 'backend/learning-09-preparation/prior-task.json');
  const irixiAppRoot = path.resolve(root, '../../../sources/irixi-20261004/app');
  await fs.mkdir(taskDirectory, { recursive: true });
  await Promise.all([
    fs.copyFile(sourceTaskFile, path.join(taskDirectory, 'task.json')),
    fs.copyFile(path.join(root, 'project.json'), projectFile),
    fs.copyFile(path.join(root, 'state/model-capability.json'), capabilityFile),
  ]);

  const oldRecordBytes = await fs.readFile(oldRecordFile);
  const oldRecord = JSON.parse(oldRecordBytes).state.record;
  const originalTaskBytes = await fs.readFile(sourceTaskFile);
  const sessionId = oldRecord.sessionId;
  const articleBInput = '\ufeff[P1] 完整一致的受控文章 B。\r\n\r\n[P2] 它与历史文章 A 的正文、哈希及材料事件均不同。\r\n';
  const canonicalArticleB = intakeTest.canonicalArticleText(articleBInput);
  const canonicalArticleBSha256 = sha256(canonicalArticleB);
  const intake = await createIntakeController({ tasksRoot, irixiAppRoot, taskId: TASK_ID, articleProjectFile: projectFile, articleCapabilityFile: capabilityFile });
  const article = await createArticleProjectController({ tasksRoot, irixiAppRoot, projectFile, capabilityFile });
  const registered = await intake.registerMaterial({ sessionId, label: '受控文章 B', source: 'development43-temporary-host-fixture', articleText: articleBInput });
  const currentTask = await article.store.get(TASK_ID);
  const currentGoal = article.helpers.activeGoal(currentTask);
  const currentArtifact = (currentTask.artifacts || []).filter((entry) => entry.status === 'confirmed' && article.helpers.projectArtifactIsCurrent(currentTask, entry)).at(-1);
  if (!currentArtifact?.projectCandidate) throw new Error('Temporary host fixture has no current confirmed artifact');
  const state = { schemaVersion: 3, record: structuredClone(oldRecord), cumulative: {} };
  const saved = await article.saveClientState(TASK_ID, {
    projectId: PROJECT_ID,
    sessionId,
    expectedRevision: 0,
    expectedGoalVersionId: currentGoal.id,
    expectedCandidateSha256: currentArtifact.projectCandidate.candidateSha256,
    expectedMaterialEventId: registered.materialEventId,
    state,
  });
  const superseding = await intake.registerMaterial({ sessionId, label: '受控文章 C', source: 'development43-temporary-host-fixture-superseding-current', articleText: '[P1] 仅用于令前一份服务器记录成为历史只读。\n' });
  const response = await article.clientState(TASK_ID, sessionId, { historical: true });
  const mutatedTaskBytes = await fs.readFile(path.join(taskDirectory, 'task.json'));
  const proof = {
    requestedHistoricalSessionId: sessionId,
    oldRecordSha256: sha256(JSON.stringify(oldRecord)),
    oldRecordMaterialEventId: oldRecord.material.materialEventId,
    oldRecordArticleSha256: oldRecord.material.articleSha256,
    registeredMaterialEventId: registered.materialEventId,
    registeredArticleSha256: registered.articleSha256,
    returnedTopLevelMaterialEventId: response.materialEventId,
    returnedMaterialHasMaterialEventId: Object.hasOwn(response.material, 'materialEventId'),
    returnedCanonicalArticleSha256: sha256(intakeTest.canonicalArticleText(response.material.articleText)),
    returnedDeclaredArticleSha256: response.material.articleSha256,
    responseRecordSha256: sha256(JSON.stringify(response.state.record)),
    sourceTaskSha256: sha256(originalTaskBytes),
    temporaryMutatedTaskSha256: sha256(mutatedTaskBytes),
    goalVersionId: currentGoal.id,
    candidateSha256: currentArtifact.projectCandidate.candidateSha256,
    savedRevision: saved.revision,
    supersedingMaterialEventId: superseding.materialEventId,
    responseIsHistorical: response.historical,
    responseIsCurrent: response.current,
  };
  const close = async () => fs.rm(temporaryRoot, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
  return { root: temporaryRoot, taskId: TASK_ID, intake, article, response, oldRecord, oldRecordBytes, canonicalArticleB, proof, close };
}
