import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { activeGoal, artifactInputIsCurrent, currentInstructionIds, deriveTaskContinuity } from './core.mjs';
import { demoResearch, sourcePackets } from './execution.mjs';

const boundedEnvironmentNumber = (name, fallback, minimum, maximum) => {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, Math.round(parsed))) : fallback;
};
const CODEX_TIMEOUT_MS = boundedEnvironmentNumber('IRIXI_MODEL_CALL_TIMEOUT_MS', 300_000, 60_000, 600_000);
const SYNTHESIS_TIMEOUT_MS = boundedEnvironmentNumber('IRIXI_SYNTHESIS_CALL_TIMEOUT_MS', 420_000, 60_000, 600_000);
const CODEX_MODEL = process.env.IRIXI_CODEX_MODEL || 'gpt-5.6-sol';
const MAX_PROVIDER_OUTPUT = 2_000_000;
const timeoutForWorkItem = (item) => item?.kind === 'synthesis' ? SYNTHESIS_TIMEOUT_MS : CODEX_TIMEOUT_MS;
const providerTimeoutMs = (task, configuredTimeout, respectExecutionDeadline = true) => {
  if (!respectExecutionDeadline) return configuredTimeout;
  const remaining = task.execution?.deadlineAt ? Date.parse(task.execution.deadlineAt) - Date.now() : configuredTimeout;
  return Number.isFinite(remaining) ? Math.max(1_000, Math.min(configuredTimeout, remaining)) : configuredTimeout;
};

function taskContext(task) {
  const goal = activeGoal(task);
  const research = task.workItems?.find((item) => item.role === 'researcher' && item.status === 'completed')?.result || null;
  const materials = sourcePackets(task);
  const excerptById = new Map(materials.map((entry) => [entry.materialId, entry]));
  return {
    type: task.type,
    goal: goal.statement,
    successCriteria: goal.successCriteria,
    boundaries: goal.boundaries,
    materials,
    materialDirectory: task.materials.map((material) => {
      const excerpt = excerptById.get(material.id);
      return {
        id: material.id, name: material.name, source: material.source, status: material.status, bytes: material.bytes,
        metadata: material.generatedEvidence === true ? {
          evidenceType: 'web-read', fetchedAt: material.fetchedAt || null,
          contentSha256: material.evidenceSha256 || null, sourceLocator: material.locator || null,
        } : null,
        totalLines: String(material.text || '').split(/\r?\n/).length,
        excerptIncluded: Boolean(excerpt), excerptLocator: excerpt?.locator || null,
        excerptTruncated: excerpt ? excerpt.truncated : material.status === 'ready',
      };
    }),
    failedMaterials: task.materials.filter((material) => material.status !== 'ready').map((material) => ({ name: material.name, source: material.source, error: material.error })),
    research,
    completedWork: (task.workItems || []).filter((item) => item.status === 'completed' && item.result).map((item) => ({
      stepKey: item.stepKey || item.id, kind: item.kind || item.role, role: item.role, title: item.title,
      result: { summary: item.result.summary || null, artifactId: item.result.artifactId || null, reviewId: item.result.reviewId || null, passed: item.result.passed ?? null },
    })),
    workInstructions: task.suggestions.filter((item) => (item.goalVersionId || goal.id) === goal.id && item.classification === 'support' && item.status === 'routed').map((item) => ({ id: item.id, text: item.text, createdAt: item.createdAt })),
    continuity: deriveTaskContinuity(task),
    projectContext: task.projectContext || { rootTaskId: task.id, rootGoal: { id: goal.id, version: goal.version, statement: goal.statement, successCriteria: goal.successCriteria, boundaries: goal.boundaries }, currentTaskRole: 'root' },
    linkedTasks: task.linkedTaskContext || [],
  };
}

function plannerPrompt(task, { replan = false, failure = null } = {}) {
  const context = taskContext(task);
  const existing = replan ? {
    plan: task.plan,
    team: task.team,
    workItems: (task.workItems || []).map((item) => ({ stepKey: item.stepKey, title: item.title, kind: item.kind, role: item.role, dependsOn: item.dependencyKeys, tools: item.tools, webScope: item.webScope || null, acceptanceCriteria: item.acceptanceCriteria, expectedResult: item.expectedResult, inputFingerprint: item.inputFingerprint, sourceContextFingerprint: item.sourceContextFingerprint, inputMaterialIds: item.inputMaterialIds, inputSuggestionIds: item.inputSuggestionIds, status: item.status, result: item.result ? { summary: item.result.summary || null, artifactId: item.result.artifactId || null, reviewId: item.result.reviewId || null, passed: item.result.passed ?? null } : null, error: item.error })),
    failure,
  } : null;
  return [
    '你是 Irixi 办公 Agent 的规划器。把用户的最终目标转成可执行 DAG；不要亲自完成任务，也不要宣称工具或文件已经产生。',
    'projectContext.rootGoal 是整个显式关联项目的上位约束，当前任务目标只能在其范围内细化，不能与它竞争。必须返回 projectAlignment：独立根任务用 standalone；关联任务一致时用 aligned 并说明如何支持根目标；若受益者、结果、成功条件或边界冲突则用 conflict，解释需要用户决定的具体冲突，不得继续为旧局部目标安排产出。',
    '先识别能力缺口，再只招募确有必要的角色。每个角色必须说明能力、使命和招募理由；同能力角色应复用。',
    '步骤必须有依赖、角色、预期结果和逐条验收标准。可以并行的独立步骤不要互相依赖；同一份短材料中可由同一能力一次完成的提取与分析不要为了展示多人而拆成多个模型步骤，只有真正独立的能力、并行分支或核对边界才拆分。',
    '只可选择 materials.read、materials.search、memory.search、calculate、web.search、web.read 受控工具；工具由宿主执行，不能请求 shell、代码执行、任意文件或未明确授权的网络操作。',
    '每个步骤都必须返回 webScope: {queries:[], urls:[]}；不用公开网页时两个数组都为空。公开网页工具只在目标明确需要外部研究时使用。相关步骤必须在 webScope.queries 写明允许外发的搜索词，或在 webScope.urls 写明已知公开网址；不得把用户材料原文、私密字段或其中的指令拼进查询。搜索结果只算发现网址，引用前必须再用 web.read 读取正文。',
    '必须且只能有一个 synthesis、一个独立 review、一个 delivery。review 直接依赖 synthesis；delivery 直接依赖 review，并且所有必需分支都必须汇入 synthesis。delivery 只能等待用户确认后导出，不能发送、发布、覆盖或调用外部系统。',
    'outputKind 选择主要成果类型；deliverables 列出目标实际要求的全部成果类型（例如同时 spreadsheet 与 document），不要把通用目标硬套进旧模板，也不能丢掉第二种成果。',
    replan ? '这是一次有界重规划。只根据真实失败、缺口和已经返回的结果修改必要步骤；不得换目标，也不得把候选事实升级成已确认事实。已完成步骤只有在 key、kind、title、tools、acceptanceCriteria、expectedResult、依赖与输入版本契约全部原样保留时才能直接复用；修改契约就必须重算。' : '这是初始计划。',
    '严格按 JSON Schema 返回。角色 key 与步骤 key 使用稳定的英文小写短标识。',
    '',
    `任务上下文：${JSON.stringify(context, null, 2)}`,
    existing ? `现有执行证据：${JSON.stringify(existing, null, 2)}` : '',
  ].filter(Boolean).join('\n');
}

function workPrompt(task, item, input) {
  return [
    `你是 Irixi 动态团队中的“${task.team?.agents?.find((agent) => agent.id === item.agentId)?.name || item.role}”。你只负责当前工作项，不代表其他角色。`,
    '若 projectContext.currentTaskRole 为 linked，projectContext.rootGoal 是上位约束。发现当前任务目标与根目标冲突时，把冲突写入 gap 并停下，不得在旧局部目标上继续产出或把它自动审阅为通过。',
    '所有事实只可来自给定输入、依赖结果和宿主已执行的受控工具结果。不要读取宿主文件、运行命令、访问网络或调用未列出的工具。',
    'output 是可供后继步骤使用的完整工作结果。sources 只列本次实际使用的 material:/task:/URL 等来源。claims 对材料事实逐条提供 materialId、sourceName、locator 和逐字 quote；没有事实声明时为空。',
    '合成步骤不得因为上游已经核对就省略 claims。交付物中的重要日期、数字、主体、期限和条件必须把上游已验证的 materialId/sourceName/locator/quote 原样结构化传入 claims；只有交付物真的不包含外部事实时才能为空。',
    '网页的 fetchedAt、HTTP 状态、内容哈希和抓取方式是宿主采集元数据：可以按工具结果原样写在来源说明，但不要把它们伪造成材料事实 claim。网页正文事实的 claim 只能使用 web.read 归档后返回的真实 materialId 和带编号 excerpt；绝不能用 task:、URL 或自造值填 materialId。',
    '需要工具时，只能从 workItem.allowedTools 选择，在 toolRequests 返回结构化请求，并保持 summary、output、gap 为空字符串，sources、claims、caveats、acceptanceChecks、deliverables 为空数组；宿主会校验计划授权并返回结果，再让你继续。材料搜索 args 为 {query}；材料读取为 {materialIds}，如果返回 truncated:true，用 {materialIds,startLine:nextStartLine,maxLines}继续读取；记忆搜索为 {query,scope}；公开搜索为 {query}；读公开页为 {url}。materialDirectory 只提供材料目录，正文仍需通过授权工具取得。',
    'calculate 的 args 必须是 {expression,inputs:[{name,value,sourceRef}]}，expression 用输入名写算式；每个数值 sourceRef 必须是 material:<id>#Lx-Ly，宿主会核对原文并确定性计算。不能自行心算代替工具。',
    `只有 toolRequests 为空的最终结果阶段才完成 output。若当前步骤是 synthesis，deliverables 必须逐项覆盖计划要求 ${JSON.stringify(task.plan?.deliverables || [task.type])}；其他步骤 deliverables 返回空数组。最终阶段逐条照抄当前验收标准到 acceptanceChecks，并给出是否通过及具体证据；任何一条未通过都写入 gap。不得重复同一 request id。若工具或协议校验失败，阅读返回错误后在同一会话中修正；最多三轮。`,
    '原生交付物内容约定：document 用 Markdown，Markdown 表格会转成 Word 真实表格；spreadsheet 优先用 JSON 字符串 {"sheets":[{"name":"表名","rows":[[单元格...]]}]}，可用 = 开头的真实公式；presentation 用 JSON 字符串 {"slides":[{"title":"标题","body":"正文","notes":"可选备注"}]}。不得把 JSON/Markdown 文本冒充成原生文件。',
    '业务交付物只写业务事实、结论、限制和“候选供用户审阅”边界；不要在文档、表格或幻灯片中写“尚未生成原生文件”、“已导出”、“已确认”等会随宿主阶段立即过期的系统状态。原生生成、渲染、审阅、确认与导出状态只由宿主元数据和界面表达。',
    '只有当输入不足以达到当前步骤明示验收标准或用户目标时，才在 gap 写阻断性缺口；税费、规格、起算日等未被目标/验收要求的信息应放在 caveats 作为非阻断限制，不得擅自扩大目标。没有阻断性缺口时 gap 为空字符串；禁止用猜测补齐。严格按 JSON Schema 返回。',
    'historicalCompletedEvidence 是同一目标与同一材料/指令版本下的历史已完成证据，不等于当前步骤已完成。你可以在当前验收契约允许时引用它重建结果；若新契约需要额外证据或重算，必须使用当前授权工具或报 gap。',
    '',
    JSON.stringify(input, null, 2),
  ].join('\n');
}

function demoResult(task) {
  const context = taskContext(task);
  const ready = context.materials;
  const sourceNames = ready.map((item) => item.sourceName);
  const research = context.research || demoResearch(task);
  const materialNotes = ready.length
    ? ready.map((item, index) => `${index + 1}. ${item.sourceName}：${item.excerpt.slice(0, 260).replaceAll(/^\d+\|\s*/gm, '').replaceAll(/\s+/g, ' ')}`).join('\n')
    : '尚未加入材料。以下内容只用于体验流程，不能当作基于事实的正式成果。';
  const claims = research.observations || [];

  if (task.type === 'email') {
    return {
      title: `${task.title}｜邮件草稿`,
      summary: '演示提供者生成的邮件结构草稿，需人工补全收件人和事实。',
      content: `主题：${context.goal.slice(0, 48)}\n\n您好，\n\n围绕“${context.goal}”，我整理了以下事项：\n\n${materialNotes}\n\n建议下一步：\n1. 核对事实与收件人。\n2. 补充明确截止时间。\n3. 确认后再从邮件客户端发送。\n\n此致\n`,
      sources: sourceNames,
      claims,
    };
  }
  if (task.type === 'calendar') {
    return {
      title: `${task.title}｜日程草稿`,
      summary: '演示提供者生成的日程说明，时间和参与者仍待确认。',
      content: `# ${context.goal}\n\n## 目的\n${context.goal}\n\n## 待确认\n- 开始与结束时间\n- 参与者\n- 地点或会议链接\n\n## 参考材料\n${materialNotes}\n`,
      sources: sourceNames,
      claims,
    };
  }
  if (task.type === 'presentation') {
    return {
      title: `${task.title}｜演示文稿候选`,
      summary: '演示提供者生成的两页结构候选，只用于验证原生文件与确认流程。',
      content: JSON.stringify({ slides: [
        { title: context.goal, body: `目标\n• ${context.goal}\n\n边界\n• 演示内容不代表真实模型结论` },
        { title: '材料与下一步', body: `材料摘记\n• ${materialNotes.slice(0, 360)}\n\n下一步\n• 切换真实模型并独立核对后再确认` },
      ] }),
      sources: sourceNames,
      claims,
    };
  }
  return {
    title: `${task.title}｜候选稿`,
    summary: `演示提供者根据 ${ready.length} 份可读材料生成结构化候选稿。`,
    content: `# ${context.goal}\n\n> 演示模式候选内容。它用于验证 Irixi 的目标、版本、审阅与确认流程，不代表真实模型研究结果。\n\n## 目标\n${context.goal}\n\n## 成功条件\n${context.successCriteria.length ? context.successCriteria.map((item) => `- ${item}`).join('\n') : '- 尚未填写，建议补充。'}\n\n## 材料摘记\n${materialNotes}\n\n## 初步结论\n当前材料已经被整理到同一目标之下。正式使用前，应切换真实模型提供者，并在审阅台逐项核对事实、缺口与边界。\n\n## 边界\n${context.boundaries.length ? context.boundaries.map((item) => `- ${item}`).join('\n') : '- 不自动发送、发布、覆盖或创建外部事项。'}\n`,
    sources: sourceNames,
    claims,
  };
}

function researchPrompt(task) {
  const context = taskContext(task);
  return [
    '你是 Irixi 办公 Agent 的研究角色。只处理当前目标与选定材料，不执行外部操作。',
    '为每份可读材料至少返回一条可核对观察。每条观察必须包含材料 ID、材料名称、行号范围和逐字原文；statement 应明确写出其主张的主体、数值和关系，不能用文件名代替内容主体；quote 只抄原文，不包含“1| ”这样的行号前缀；statement 中的价格、日期、周期等数字必须出现在 quote 中。',
    '缺少的比较维度写入 missingFacts，不得编造。严格按 JSON Schema 返回。',
    '',
    JSON.stringify(context, null, 2),
  ].join('\n');
}

function providerPrompt(task) {
  const context = taskContext(task);
  const outputKinds = {
    document: '一份可直接审阅的 Markdown 办公文档',
    research: '一份区分事实、推断、缺口与来源的 Markdown 研究简报',
    email: '一封不虚构收件人、事实或承诺的纯文本邮件草稿',
    calendar: '一份明确标出待确认时间、参与者和地点的 Markdown 日程草稿',
  };
  return [
    '你是 Irixi 办公 Agent 的写作角色。只基于下方目标和材料生成候选成果。',
    '目标优先：不得把补充建议悄悄替换成新目标。材料缺失时明确写“待确认”，不得编造。',
    `成果类型：${outputKinds[task.type]}.`,
    '请严格按所给 JSON Schema 返回 title、summary、content、sources、claims。sources 只能列出实际使用的材料名称或明确 URL。',
    'claims 必须覆盖正文中的价格、日期、交付周期等关键事实；每条写明 statement、materialId、sourceName、locator 和逐字 quote；statement 应明确写出其主张的主体、数值和关系，不能用文件名代替内容主体；quote 不包含行号前缀，数字必须与 quote 一致。',
    '',
    JSON.stringify(context, null, 2),
  ].join('\n');
}

function reviewPrompt(task, artifact) {
  const goal = activeGoal(task);
  const research = task.workItems?.find((item) => item.role === 'researcher' && item.result)?.result || null;
  const auditFacts = {
    artifactStoredInTaskSnapshot: task.artifacts.some((item) => item.id === artifact.id),
    artifactId: artifact.id,
    artifactTitlePresent: Boolean(artifact.title),
    artifactContentCharacters: artifact.content.length,
    approvalCount: task.approvals.length,
    externalActionEvents: task.events.filter((item) => /export|send|publish|delete|payment|permission/i.test(item.type)).map((item) => ({ type: item.type, at: item.at, message: item.message })),
  };
  const dynamicReviewEvidence = task.agentSessions?.filter((session) => session.workItemId === task.workItems?.find((item) => item.kind === 'review' && item.status === 'running')?.id).at(-1) || null;
  return [
    '你是独立审阅角色，不继承起草者的完成结论。逐项检查目标符合度、完整性、来源可追溯、边界遵守和文件可用性。',
    '若这是关联任务，checks 必须另列一项，名称明确写“项目根目标符合度”，以 projectContext.rootGoal 为上位约束核对任务目标、候选和 projectContext.acceptedInstructions；任何冲突或漏掉根任务有效交代都属于阻塞项，不能并入普通“目标符合度”后通过。',
    '每项检查必须给出证据。事实或关键材料不足时应失败。对候选事实与引用中的每条 claim，必须返回且只返回一个 claimChecks 项：claimIndex 使用从 0 开始的原顺序，materialId 和 locator 必须照抄对应 claim；逐句判断 statement 的主体、数值和关系是否由该行原文支持。supported 表示原文支持完整主张，unsupported 表示不支持或错配，uncertain 表示原文不足以判断；unsupported 或 uncertain 都必须阻止通过。文件名只是来源标签，不能当作内容主体证据；即使一句话同时出现多个名称和正确数字，也要核对它实际把条件归给了谁。',
    '自然语言审阅可能出错；不能确定时返回 uncertain，不要为了让候选通过而猜测。严格按 JSON Schema 返回。',
    '这里审阅的是确认前的候选记录：DOCX/XLSX/PPTX 要求在候选阶段已实际生成、绑定内容摘要并渲染出可视页面；这仍是隔离候选文件，不是用户已确认的正式导出。任一必需交付物缺失、生成失败或没有渲染记录都应判失败。',
    '合成步骤可能留下“尚未生成原生文件”的当时说明；审阅时以宿主后续写入的 nativeFiles 实时记录为准，不得因已被 ready 记录取代的历史说明而判失败。相反，只有文本宣称、没有 ready 记录仍必须失败。',
    '即使 claims 为空，也不能自动判定来源通过；必须把全部 deliverables 中的重要事实与材料原文、依赖结果和动态审阅预检逐项对照。发现重要事实未进入 claims 时，应在来源核对证据中说明你实际核查了哪些内容。',
    '公开页面的 metadata 由宿主 web.read 写入，与页面正文 excerpt 分开。候选中的抓取时间、最终 URL、HTTP 状态或内容哈希若与对应 material.metadata 精确一致，可以作为宿主采集元数据通过；不要去正文行号中寻找这些采集字段，也不要把它们当成网页自述的业务日期。',
    '边界遵守以给出的任务事件与确认记录为准；不要自行在运行目录寻找项目文件，也不要把“没有正式文件”或“没有额外操作日志”当成已经发生外部动作。',
    '',
    `目标：${goal.statement}`,
    `成功条件：${JSON.stringify(goal.successCriteria)}`,
    `边界：${JSON.stringify(goal.boundaries)}`,
    `当前目标下已路由的工作交代与修改要求：${JSON.stringify(taskContext(task).workInstructions.map((item) => ({ id: item.id, text: item.text })))}`,
    `项目关系与根目标：${JSON.stringify(taskContext(task).projectContext, null, 2)}`,
    `材料原文片段（行号可定位）：${JSON.stringify(sourcePackets(task), null, 2)}`,
    `研究结果：${JSON.stringify(research, null, 2)}`,
    `动态审阅会话的受控工具调用与预检查：${JSON.stringify(dynamicReviewEvidence ? { toolCalls: dynamicReviewEvidence.toolCalls, reviewEvidence: dynamicReviewEvidence.reviewEvidence } : null, null, 2)}`,
    `候选与动作审计事实：${JSON.stringify(auditFacts, null, 2)}`,
    `候选成果标题：${artifact.title}`,
    `候选事实与引用：${JSON.stringify(artifact.claims, null, 2)}`,
    `全部候选交付物：${JSON.stringify(artifact.deliverables || [], null, 2)}`,
    `原生候选文件生成与渲染记录：${JSON.stringify((artifact.nativeFiles || []).map((file) => ({ kind: file.kind, format: file.format, filename: file.filename, status: file.status, sha256: file.sha256, contentSha256: file.contentSha256, bytes: file.bytes, previewCount: file.previewPaths?.length || 0, error: file.error || null })), null, 2)}`,
    `候选成果：\n${artifact.content}`,
  ].join('\n');
}

function conversationPrompt(task, role, message) {
  const context = taskContext(task);
  const goal = activeGoal(task);
  const artifact = task.artifacts?.filter((item) => item.goalVersionId === goal.id
    && ['candidate', 'confirmed'].includes(item.status) && artifactInputIsCurrent(task, item)).at(-1) || null;
  const review = artifact ? task.reviews?.filter((item) => item.artifactId === artifact.id).at(-1) || null : null;
  const conversation = (task.events || [])
    .filter((item) => ['conversation.user', 'conversation.reply'].includes(item.type)
      && item.detail?.role === role
      && (item.detail?.goalVersionId === goal.id || (!item.detail?.goalVersionId && task.goal.versions.length === 1))
      && (!task.projectRootTaskId || (item.detail?.projectRootGoalVersionId === task.projectRootGoalVersionId
        && item.detail?.projectRootInputFingerprint === task.projectRootInputFingerprint))
      && (item.detail?.instructionIds
        ? JSON.stringify([...item.detail.instructionIds].sort()) === JSON.stringify(currentInstructionIds(task).slice().sort())
        : currentInstructionIds(task).length === 0))
    .map((item) => ({
      speaker: item.type === 'conversation.user' ? 'user' : 'assistant',
      text: String(item.detail?.content || item.message || '').slice(0, 1_200),
    }));
  if (conversation.at(-1)?.speaker === 'user' && conversation.at(-1)?.text === String(message).slice(0, 1_200)) conversation.pop();
  return [
    `你是 Irixi 办公室中的 ${role} 同事，正在围绕同一项真实办公任务与用户交谈。`,
    '若这是关联任务，必须把 projectContext.rootGoal 作为上位约束；任务目标与根目标冲突时明确指出并要求对齐，不能把旧局部目标说成仍可继续。',
    '直接回答用户这句话；不要假装已经执行尚未执行的操作，也不要把固定状态回执冒充模型判断。',
    '事实只来自给定目标、材料、工作状态和候选成果。材料不足时明确说不能确定，并提出最小澄清问题。',
    'sourceRefs 只列实际支持本次回答的材料名称与行号；纯进度回答可以为空。严格按 JSON Schema 返回。',
    '',
    `用户消息：${String(message).slice(0, 2_000)}`,
    `同一目标、同一角色的最近对话：${JSON.stringify(conversation.slice(-8))}`,
    `任务状态：${task.status}；当前角色：${task.activeRole}`,
    `工作项：${JSON.stringify((task.workItems || []).map((item) => ({ role: item.role, title: item.title, status: item.status, result: item.result?.summary || item.result?.title || null, error: item.error || null })))}`,
    `当前计划与审阅：${JSON.stringify({ planRevision: task.plan?.revision || null, planReason: task.plan?.reason || null, review: review ? { passed: review.passed, summary: review.summary, failedBlockingChecks: review.checks.filter((item) => item.blocking && !item.passed) } : null })}`,
    `上下文：${JSON.stringify(context, null, 2)}`,
    `当前候选成果：${artifact ? JSON.stringify({ title: artifact.title, version: artifact.version, status: artifact.status, reviewStatus: artifact.reviewStatus, summary: artifact.summary, content: artifact.content.slice(0, 8_000) }, null, 2) : '无'}`,
  ].join('\n');
}

async function executableExists(executable) {
  if (executable.includes('/')) {
    try { await fs.access(executable); return true; } catch { return false; }
  }
  return new Promise((resolve) => {
    const child = spawn('/usr/bin/which', [executable], { stdio: 'ignore' });
    child.once('close', (code) => resolve(code === 0));
    child.once('error', () => resolve(false));
  });
}

function runProcess(command, args, { cwd, input, timeoutMs = CODEX_TIMEOUT_MS, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    let killed = false;
    let cancelled = false;
    const stop = () => {
      cancelled = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
    };
    if (signal?.aborted) stop();
    else signal?.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { if (stdout.length < MAX_PROVIDER_OUTPUT) stdout += chunk; });
    child.stderr.on('data', (chunk) => { if (stderr.length < MAX_PROVIDER_OUTPUT) stderr += chunk; });
    child.once('error', (error) => { clearTimeout(timer); signal?.removeEventListener('abort', stop); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      if (cancelled) { const error = new Error('本地模型进程已按取消请求终止。'); error.code = 'cancelled'; return reject(error); }
      if (killed) return reject(new Error('真实模型运行超时，任务已安全停止。'));
      if (code !== 0) return reject(new Error(`Codex CLI 运行失败：${stderr.trim().slice(-900) || `退出码 ${code}`}`));
      resolve({ stdout, stderr });
    });
    child.stdin.end(input);
  });
}

function codexExecArgs(schemaPath, outputPath, runRoot) {
  return [
    'exec', '-', '--ephemeral', '--sandbox', 'read-only', '--skip-git-repo-check',
    '--model', CODEX_MODEL,
    '--ignore-user-config', '--ignore-rules', '-c', 'web_search="disabled"', '--output-schema', schemaPath,
    '--enable', 'skip_host_skill_discovery',
    '--disable', 'shell_tool', '--disable', 'unified_exec', '--disable', 'apps', '--disable', 'plugins',
    '--disable', 'browser_use', '--disable', 'browser_use_external', '--disable', 'browser_use_full_cdp_access',
    '--disable', 'computer_use', '--disable', 'multi_agent', '--disable', 'hooks', '--disable', 'skill_search',
    '--disable', 'code_mode_host', '--disable', 'image_generation', '--disable', 'in_app_browser',
    '--disable', 'workspace_dependencies', '--disable', 'tool_suggest', '--disable', 'tool_call_mcp_elicitation',
    '--color', 'never', '-o', outputPath, '-C', runRoot,
  ];
}

export function createProviders({ projectRoot, store }) {
  const schemaRoot = path.join(projectRoot, 'app', 'schemas');
  const codexPath = process.env.IRIXI_CODEX_PATH || path.join(os.homedir(), '.local', 'bin', 'codex');
  const connectionFile = path.join(store.root, '.connections.json');

  async function readConnectionState() {
    try { return JSON.parse(await fs.readFile(connectionFile, 'utf8')); }
    catch { return {}; }
  }

  async function writeConnectionState(value) {
    await fs.mkdir(path.dirname(connectionFile), { recursive: true });
    const temp = `${connectionFile}.${Date.now()}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temp, connectionFile);
  }

  async function runCodex(task, schemaName, prompt, label, signal, configuredTimeout = CODEX_TIMEOUT_MS, respectExecutionDeadline = true) {
    if (!(await executableExists(codexPath))) throw new Error('没有找到 Codex CLI，请先在连接中心检查真实模型。');
    const runRoot = path.join(store.taskDir(task.id), 'runs', `${Date.now()}-${label}`);
    await fs.mkdir(runRoot, { recursive: true });
    const outputPath = path.join(runRoot, 'result.json');
    const schemaPath = path.join(schemaRoot, schemaName);
    const args = codexExecArgs(schemaPath, outputPath, runRoot);
    await fs.writeFile(path.join(runRoot, 'request.txt'), prompt, { mode: 0o600 });
    const timeoutMs = providerTimeoutMs(task, configuredTimeout, respectExecutionDeadline);
    await runProcess(codexPath, args, { cwd: runRoot, input: prompt, signal, timeoutMs });
    const raw = await fs.readFile(outputPath, 'utf8');
    if (raw.length > MAX_PROVIDER_OUTPUT) throw new Error('真实模型返回内容超过安全上限。');
    try {
      const parsed = JSON.parse(raw);
      if (label === 'generate') {
        const checkedAt = new Date().toISOString();
        const saved = await readConnectionState();
        await writeConnectionState({ ...saved, codexCli: { ...saved.codexCli, generationVerified: true, generationVerifiedAt: checkedAt, verifiedAt: checkedAt } });
      }
      return { ...parsed, _providerMeta: { usage: 'unknown' } };
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error('真实模型没有返回符合结构的结果。');
      throw error;
    }
  }

  return {
    async status() {
      const saved = await readConnectionState();
      return {
        demo: { id: 'demo', available: true, verified: true, label: '演示提供者', boundary: '本地生成固定结构，仅用于体验流程；不是智能模型。' },
        codex: {
          id: 'codex-cli', available: await executableExists(codexPath), verified: Boolean(saved.codexCli?.generationVerified),
          runtimeVerified: Boolean(saved.codexCli?.runtimeVerified),
          label: 'Codex CLI', boundary: '“已发现”只表示本机程序可启动；只有真实生成成功后才标记模型已验证。选用后，当前任务目标与受控工具结果会发送给 Codex 服务；子进程显式关闭 shell、浏览器、应用、插件、多代理与宿主技能发现，文件与网络只经 Irixi 白名单执行。',
          model: CODEX_MODEL,
          callTimeoutMs: CODEX_TIMEOUT_MS,
          verifiedAt: saved.codexCli?.verifiedAt || null,
          version: saved.codexCli?.version || null,
        },
      };
    },
    async verifyCodex() {
      const available = await executableExists(codexPath);
      if (!available) return { ok: false, message: '没有找到 Codex CLI。' };
      try {
        const { stdout } = await runProcess(codexPath, ['--version'], { cwd: projectRoot, input: '', timeoutMs: 10_000 });
        const version = stdout.trim() || 'Codex CLI 可运行。';
        const checkedAt = new Date().toISOString();
        await writeConnectionState({ ...(await readConnectionState()), codexCli: { ...(await readConnectionState()).codexCli, runtimeVerified: true, runtimeVerifiedAt: checkedAt, version } });
        return { ok: true, runtimeVerified: true, generationVerified: false, message: `${version}；程序可启动，但尚未用当前办公室任务完成真实生成。` };
      } catch (error) {
        return { ok: false, message: error.message };
      }
    },
    async generate(task, { signal } = {}) {
      if (task.provider === 'codex-cli') return runCodex(task, 'generate.json', providerPrompt(task), 'generate', signal);
      return demoResult(task);
    },
    async plan(task, { signal } = {}) {
      if (task.provider !== 'codex-cli') throw new Error('演示提供者不冒充真实规划模型。');
      return runCodex(task, 'plan.json', plannerPrompt(task), 'plan', signal, CODEX_TIMEOUT_MS, false);
    },
    async replan(task, failure, { signal } = {}) {
      if (task.provider !== 'codex-cli') throw new Error('演示提供者不冒充真实重规划模型。');
      return runCodex(task, 'plan.json', plannerPrompt(task, { replan: true, failure }), 'replan', signal);
    },
    async executeWork(task, item, input, { signal } = {}) {
      if (task.provider !== 'codex-cli') {
        return {
          summary: `演示工作项：${item.title}`, output: `这是“${item.title}”的固定演示结果，不是模型判断。`, sources: [], claims: [], gap: '', caveats: [], toolRequests: [],
          deliverables: item.kind === 'synthesis' ? (task.plan?.deliverables || [task.type]).map((kind) => ({ kind, title: task.title, content: `这是“${item.title}”的固定演示结果，不是模型判断。` })) : [],
          acceptanceChecks: (item.acceptanceCriteria || []).map((criterion) => ({ criterion, passed: true, evidence: '固定演示流程只证明状态闭环，不证明模型能力。' })),
        };
      }
      return runCodex(task, 'work.json', workPrompt(task, item, input), `work-${item.stepKey || item.id}`, signal, timeoutForWorkItem(item));
    },
    async research(task, { signal } = {}) {
      if (task.provider === 'codex-cli') return runCodex(task, 'research.json', researchPrompt(task), 'research', signal);
      return demoResearch(task);
    },
    async review(task, artifact, { signal } = {}) {
      if (task.provider === 'codex-cli') {
        const result = await runCodex(task, 'review.json', reviewPrompt(task, artifact), 'review', signal);
        return { ...result, provider: 'codex-cli-independent-review' };
      }
      const goal = activeGoal(task);
      const readyMaterials = task.materials.filter((item) => item.status === 'ready');
      const hasSourceGap = task.materials.some((item) => item.status === 'failed');
      const checks = [
        { name: '目标符合度', passed: artifact.goalVersionId === goal.id && artifact.content.includes(goal.statement), evidence: '成果绑定当前目标版本，正文包含目标表述。', blocking: true },
        ...(task.projectRootTaskId ? [{ name: '项目根目标符合度', passed: false, evidence: '演示提供者不能可靠判断关联任务与项目根目标的语义一致性，请改用真实模型规划与独立审阅。', blocking: true }] : []),
        { name: '完整性', passed: artifact.content.trim().length >= 120, evidence: `正文长度 ${artifact.content.trim().length} 字符。`, blocking: true },
        { name: '来源可追溯', passed: readyMaterials.length === 0 || artifact.sources.length > 0, evidence: readyMaterials.length ? `记录 ${artifact.sources.length} 条来源。` : '没有提供事实材料，成果已标注演示限制。', blocking: true },
        { name: '材料读取', passed: !hasSourceGap, evidence: hasSourceGap ? '至少一份材料读取失败，需处理后再确认。' : '选定材料均处于可读状态。', blocking: true },
        { name: '边界遵守', passed: true, evidence: '没有执行发送、发布、覆盖或创建外部事项。', blocking: true },
        { name: '文件可用性', passed: Boolean(artifact.title && artifact.content), evidence: '标题与正文均存在，可生成新文件。', blocking: true },
      ];
      const compact = (value) => String(value || '').replaceAll(/\s+/g, '');
      const claimChecks = artifact.claims.map((claim, claimIndex) => {
        const exactQuoteRepeated = compact(claim.statement).includes(compact(claim.quote));
        return {
          claimIndex,
          materialId: claim.materialId,
          locator: claim.locator,
          verdict: exactQuoteRepeated ? 'supported' : 'uncertain',
          evidence: exactQuoteRepeated
            ? '演示候选的该结论逐字包含引用原文；这只验证演示闭环，不是模型语义核验。'
            : '演示提供者不能可靠判断改写后的自然语言关系。',
        };
      });
      const passed = checks.every((item) => item.passed) && claimChecks.every((item) => item.verdict === 'supported');
      return { summary: passed ? '演示审阅通过，可等待用户确认。' : '演示审阅发现阻塞项。', checks, claimChecks, provider: 'deterministic-independent-review' };
    },
    async converse(task, role, message, { signal } = {}) {
      if (task.provider === 'codex-cli') return runCodex(task, 'conversation.json', conversationPrompt(task, role, message), 'conversation', signal);
      const item = task.workItems?.find((work) => work.role === role);
      return {
        reply: `这是演示回执，不是模型回答。当前任务为“${task.status}”${item ? `，${item.title}为“${item.status}”` : '，本次计划尚未安排这一角色'}。`,
        kind: 'progress',
        sourceRefs: [],
      };
    },
  };
}

export const __test = { demoResult, researchPrompt, providerPrompt, reviewPrompt, conversationPrompt, plannerPrompt, workPrompt, codexExecArgs, timeoutForWorkItem, providerTimeoutMs };
