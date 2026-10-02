export function planInputsChanged(task) {
  if (!task || task.plan?.source !== 'model' || !task.workItems?.length) return false;
  const goalId = task.goal?.activeVersionId;
  const materialIds = [...(task.materialContext?.effectiveMaterialIds || (task.materials || []).filter((item) => item.status === 'ready' && item.generatedEvidence !== true).map((item) => item.id))].sort();
  const materialApplicabilityFingerprint = task.materialContext?.fingerprint ?? null;
  const suggestionIds = (task.suggestions || []).filter((item) => (item.goalVersionId || goalId) === goalId && item.classification === 'support' && item.status === 'routed').map((item) => item.id).sort();
  return task.workItems.some((item) => (item.materialApplicabilityFingerprint ?? null) !== materialApplicabilityFingerprint
    || JSON.stringify([...(item.inputMaterialIds || [])].sort()) !== JSON.stringify(materialIds)
    || JSON.stringify([...(item.inputSuggestionIds || [])].sort()) !== JSON.stringify(suggestionIds));
}

export function shouldPollTask(task, { pendingAction = null, pendingActionTaskId = null, planning = false, conversation = false } = {}) {
  if (!task) return false;
  const pendingArtifactAction = ['artifact-review', 'native-refresh'].includes(pendingAction) && pendingActionTaskId === task.id;
  return ['running', 'cancellation_unknown'].includes(task.status) || planning || conversation || pendingArtifactAction;
}

export function materialDecisionExpectation(form) {
  return {
    expectedFingerprint: JSON.parse(form.dataset.expectedFingerprint),
    expectedScope: JSON.parse(form.dataset.expectedScope),
    expectedContentSha256: JSON.parse(form.dataset.expectedContentSha256),
  };
}
