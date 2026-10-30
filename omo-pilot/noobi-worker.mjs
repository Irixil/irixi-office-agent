// Dedicated Electron worker. Never imports Noobi main.js or its original stores.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { noobiPlaytestEvidence, noobiAssetsForReview, NOOBI_PLAYTEST_GUIDANCE } from './noobi-verification.mjs';
import { noobiNotificationFacts } from './noobi-events.mjs';
import { noobiPermissionProfiles, noobiApprovalScopeError } from './noobi-permissions.mjs';

const require = createRequire(import.meta.url);
const { app, BrowserWindow, nativeImage } = require('electron');
// A completed/closed playtest window does not finish the worker's job.
app.on('window-all-closed', () => {});
const input = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
const { jobDirectory, workspace, jobId, projectId } = input;
app.setPath('userData', path.join(jobDirectory, 'electron'));
app.setPath('sessionData', path.join(jobDirectory, 'electron-session'));
app.commandLine.appendSwitch('disk-cache-dir', path.join(jobDirectory, 'browser-cache'));
const controller = new AbortController(), pending = new Map();
let runtime, harness, previews, approvals, routes = new Map(), started = false, stopping;
let eventTail = Promise.resolve();
const ingress = new Set(), ingressErrors = [];
const packet = (kind, value = {}) => ({ kind, projectId, jobId, ...value });
function report(kind, value, acknowledge = false) {
  if (!process.connected) return Promise.reject(new Error('主产品已断开，Noobi 工作停止。'));
  if (!acknowledge) { process.send(packet(kind, value)); return Promise.resolve(); }
  const receiptId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(receiptId); reject(new Error('主产品未保存 Noobi 回执。')); }, 30000);
    pending.set(receiptId, { resolve: () => { clearTimeout(timer); resolve(); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    process.send(packet(kind, { ...value, receiptId }));
  });
}
function event(event) {
  eventTail = eventTail.then(() => report('event', { event: { ...event, at: new Date().toISOString() } }, true))
    .catch((error) => { controller.abort(error); throw error; });
  eventTail.catch(() => {});
}
async function stop() {
  if (stopping) return stopping;
  if (!controller.signal.aborted) controller.abort(new Error('本轮 Noobi 已停止。'));
  approvals?.closeAll();
  stopping = Promise.allSettled([harness?.stop(projectId), runtime?.stop(), previews?.stopAll()]).then(() => {
    for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.destroy();
  });
  return stopping;
}
process.on('disconnect', () => { void stop().finally(() => app.exit(1)); });
process.on('SIGTERM', () => { void stop().finally(() => app.exit(1)); });
process.on('message', (message) => {
  if (message.kind === 'receipt') { pending.get(message.receiptId)?.resolve(); pending.delete(message.receiptId); }
  if (message.kind === 'stop') void stop();
  if (message.kind === 'approval' && !controller.signal.aborted) {
    try {
      if (!approvals) throw new Error('Noobi 确认尚未准备好。');
      approvals.resolve(message.token, ['accept', 'decline', 'cancel'].includes(message.decision) ? message.decision : 'decline', message.answers);
      event({ type: 'noobi_approval_resolved', token: message.token, decision: message.decision });
    } catch (error) {
      event({ type: 'noobi_approval_error', token: message.token, message: error.message });
      void report('failure', { error: `Noobi 未收到有效答复：${error.message}` }).finally(() => stop());
    }
  }
  if (message.kind === 'start' && !started) {
    started = true;
    run().then((result) => report('result', { result }, true)).catch(async (error) => {
      const message = String(error.message || error).replace(/\b(?:sk|rk)-[A-Za-z0-9_-]+/gu, '[redacted]').slice(0, 3000);
      await report('failure', { error: message }).catch(() => {});
    }).finally(async () => { await stop(); for (const waiter of pending.values()) waiter.reject(new Error('Noobi worker closed')); app.exit(0); });
  }
});
const load = (name) => import(pathToFileURL(path.join(input.build, 'dist/main', `${name}.js`)).href);

async function run() {
  await app.whenReady(); app.dock?.hide(); controller.signal.throwIfAborted();
  const [{ CodexAppServer }, { GameHarness }, { AssetStore }, { AssetPlanStore }, { MediaToolBroker, MEDIA_DYNAMIC_TOOLS },
    { MediaGenerationService }, { ImageGenerationAttestationStore }, { PreviewServer }, { GameplayExperienceEvaluator },
    { verifyWebProductionBuild }, { verifyVisualAssetCoverage }, { ApprovalBroker }, { notificationToEvent, routeThreadId }] = await Promise.all(
    ['codexAppServer', 'gameHarness', 'assetStore', 'assetPlanStore', 'mediaToolBroker', 'mediaGenerationService',
      'imageGenerationAttestation', 'previewServer', 'gameplayExperienceEvaluator', 'webProductionBuild', 'visualAssetCoverage', 'approvalBroker', 'eventMapper'].map(load));
  const projectState = path.join(path.dirname(path.dirname(jobDirectory)), 'projects', projectId);
  await fs.mkdir(projectState, { recursive: true, mode: 0o700 });
  const codexHome = await fs.realpath(input.codexHome);
  const skillPath = await fs.realpath(path.join(codexHome, 'skills/.system/imagegen/SKILL.md'));
  const permissionProfiles = noobiPermissionProfiles(codexHome, path.dirname(skillPath), jobId);
  runtime = new CodexAppServer({ codexHome: input.codexHome, hostControl: {
    binaryPath: input.executable, stateDir: path.join(jobDirectory, 'app-server'),
    permissionProfiles,
    threadConfig: { 'project_doc_max_bytes': 0, 'features.skip_host_skill_discovery': true },
    onProcess: (pid) => report('process', { pid }, true),
    onThread: async (record) => { event({ type: 'noobi_thread', ...record }); await eventTail; },
  } });
  harness = new GameHarness(runtime); previews = new PreviewServer();
  const assetStore = new AssetStore(), assetPlanStore = new AssetPlanStore(path.join(projectState, 'asset-plans.json'));
  const attestations = new ImageGenerationAttestationStore(path.join(projectState, 'attestations.json'));
  await attestations.init();
  // This integration explicitly uses the existing Desktop ImageGen connection.
  // It neither imports Noobi's private media settings nor selects a paid API.
  const generation = new MediaGenerationService({ assetStore, providerStore: { withActiveProvider: async () => null } });
  const media = new MediaToolBroker({ server: runtime, assetStore, assetPlanStore, generationService: generation,
    resolveProject: async (threadId) => !controller.signal.aborted && routes.has(threadId) ? { id: projectId, root: workspace } : null,
    onAssetsChanged: async (_id, assets) => event({ type: 'noobi_assets', count: assets.length }),
  });
  approvals = new ApprovalBroker(runtime, (threadId) => routes.has(threadId) ? projectId : null);
  approvals.on('approval', (approval) => { event({ type: 'noobi_waiting_approval', title: approval.title }); void report('approval', { approval }).catch(() => stop()); });
  approvals.on('expired', (approval) => event({ type: 'noobi_approval_expired', token: approval.token, title: '确认已过期，未扩大权限' }));
  runtime.on('serverRequest', (request) => { void (async () => {
    if (controller.signal.aborted) { try { runtime.rejectServerRequest(request.id, -32000, 'Work stopped'); } catch {} return; }
    if (request.method !== 'currentTime/read' && !routes.has(request.params?.threadId)) { runtime.rejectServerRequest(request.id, -32000, 'No active Noobi job owns this request'); return; }
    const scopeError = await noobiApprovalScopeError(request, { workspace, temporary: path.join(jobDirectory, 'tmp'), imageSkillDirectory: path.dirname(skillPath) });
    if (scopeError) {
      runtime.respondToServerRequest(request.id, request.method === 'item/permissions/requestApproval' ? { scope: 'turn', permissions: {} } : { decision: 'decline' });
      event({ type: 'noobi_permission_denied', title: scopeError }); return;
    }
    if (controller.signal.aborted) { runtime.rejectServerRequest(request.id, -32000, 'Work stopped'); return; }
    if (!media.handle(request)) approvals.handle(request);
  })().catch((error) => { event({ type: 'noobi_request_error', title: '工具请求未执行', message: error.message }); void stop(); }); });
  harness.on('thread', (route) => { routes.set(route.threadId, { ...route, ephemeral: true }); event({ type: 'noobi_role', ...route, ephemeral: true }); });
  harness.on('event', (value) => event({ type: 'noobi_progress', title: value.title, message: value.message, phase: value.stage, method: value.method }));
  harness.on('state', (value) => event({ type: 'noobi_state', state: value.state, phase: value.phase }));
  runtime.on('notification', (notification) => {
    const params = notification.params || {}, route = routes.get(routeThreadId(notification));
    if (notification.method === 'serverRequest/resolved' && ['string', 'number'].includes(typeof params.requestId)) approvals.resolveFromServer(params.requestId);
    if (!route || controller.signal.aborted) return;
    const facts = noobiNotificationFacts(notification);
    const mapped = facts.persistProgress ? notificationToEvent(notification, route, 'build') : null;
    if (mapped) event({ type: 'noobi_tool', title: mapped.title, message: mapped.message, method: mapped.method });
    // Image ingestion is independent of progress filtering.
    const item = facts.generatedImage;
    if (!item) return;
    const job = (async () => {
      const outputRoot = await fs.realpath(path.join(input.codexHome, 'generated_images'));
      const sourcePath = await fs.realpath(item.savedPath);
      if (!sourcePath.startsWith(outputRoot + path.sep)) throw new Error('图片回执不属于受控生成输出。');
      controller.signal.throwIfAborted();
      const asset = await assetStore.ingestGeneratedImage({ projectId, root: workspace, sourcePath, provider: 'codex-imagegen', prompt: item.revisedPrompt });
      controller.signal.throwIfAborted();
      await attestations.record({ projectId, relativePath: asset.relativePath, sha256: asset.sha256, provider: 'codex-imagegen' });
      const plans = (await assetPlanStore.list(projectId)).filter((p) => p.kind === 'image' && p.status === 'waiting-agent' && p.route === 'codex-imagegen');
      const match = plans.find((p) => p.prompt === item.revisedPrompt) || (plans.length === 1 ? plans[0] : null);
      if (match) await assetPlanStore.generated(projectId, match.id, asset, 'codex-imagegen');
      event({ type: 'noobi_asset_saved', path: asset.relativePath, sha256: asset.sha256 });
    })();
    ingress.add(job); job.catch((error) => ingressErrors.push(error.message)).finally(() => ingress.delete(job));
  });
  event({ type: 'noobi_connecting', title: '正在连接小游戏制作工具' }); await eventTail;
  controller.signal.throwIfAborted();
  const status = await runtime.start(); controller.signal.throwIfAborted();
  if (!status.account) throw new Error('现有模型连接尚未登录，未开始小游戏制作。');
  const selected = status.models.find((m) => m.id === input.modelSelection.model || m.model === input.modelSelection.model);
  if (!selected || !selected.efforts.includes(input.modelSelection.effort)) throw new Error('Noobi 当前连接不支持所选模型或推理档位。');
  if (!status.capabilities.imageGeneration) throw new Error('当前连接未提供 Noobi 所需图像生成能力，未开始制作。');
  const skillBytes = await fs.readFile(skillPath);
  event({ type: 'noobi_connection', model: input.modelSelection, mediaRoute: 'codex-imagegen', skill: { id: 'imagegen', path: skillPath, sha256: crypto.createHash('sha256').update(skillBytes).digest('hex') } });
  await eventTail;
  const settleAssets = async () => { while (ingress.size) await Promise.allSettled([...ingress]); controller.signal.throwIfAborted(); if (ingressErrors.length) throw new Error(ingressErrors.join('; ')); };
  const imageRequirement = async () => {
    await settleAssets();
    const listing = await noobiAssetsForReview(assetStore, projectId, workspace);
    if (listing.error) return { state: 'manifest-repair-required' };
    const verification = await attestations.verify({ projectId, root: workspace, assets: listing.assets });
    return verification.ok ? { state: 'trusted-and-referenced', relativePath: verification.asset.relativePath }
      : verification.reason === 'missing-production-reference' ? { state: 'trusted-reference-required', relativePaths: verification.candidatePaths } : { state: 'fresh-generation-required' };
  };
  const loadedUrls = new Set();
  const evaluator = new GameplayExperienceEvaluator({ createWindow: (options) => {
    const window = new BrowserWindow(options);
    window.webContents.session.webRequest.onCompleted({ urls: ['http://127.0.0.1/*'] }, (details) => {
      if (details.statusCode >= 200 && details.statusCode < 300) loadedUrls.add(details.url);
    });
    return window;
  }, decodePng: (png) => nativeImage.createFromBuffer(png) });
  let lastVerification;
  const validateHostDelivery = async (signal) => {
    await settleAssets(); signal.throwIfAborted();
    const findings = [], build = await verifyWebProductionBuild(workspace, { signal });
    if (!build.ok) findings.push(`WEB_BUILD: ${build.detail}`);
    const listing = await noobiAssetsForReview(assetStore, projectId, workspace);
    if (listing.error) {
      lastVerification = { ok: false, findings: [...findings, listing.error], build, checkedFiles: {} };
      await fs.writeFile(path.join(jobDirectory, 'host-verification.json'), JSON.stringify(lastVerification, null, 2));
      return { ok: false, findings: lastVerification.findings };
    }
    const assets = listing.assets;
    const plans = await assetPlanStore.reconcile(projectId, workspace, assets);
    const unfinished = plans.filter((p) => p.required && p.status !== 'ready');
    if (unfinished.length) findings.push(`ASSET_PLANS: ${unfinished.map((p) => `${p.id}/${p.status}`).join(', ')}`);
    const visual = await verifyVisualAssetCoverage({ name: input.name, idea: input.prompt, engine: 'web', root: workspace, assets });
    if (!visual.ok) findings.push(`VISUAL_COVERAGE: ${visual.detail}`);
    const image = await attestations.verify({ projectId, root: workspace, assets });
    if (!image.ok) findings.push(`IMAGE_GENERATION: ${image.reason}`);
    let playtest = null, checkedFiles = {};
    if (build.ok) {
      loadedUrls.clear();
      event({ type: 'noobi_playtest', title: '正在打开正式成品并实际试玩' }); await eventTail;
      try {
        const previewUrl = await previews.start(projectId, workspace, { sourceFallback: false, sourceAssetOverlay: false });
        playtest = await evaluator.evaluate({ projectRoot: workspace, previewUrl, expectedEngine: 'web', expectedEntrypoint: 'dist/index.html', signal });
        const evidence = await noobiPlaytestEvidence({ playtest, root: workspace, previewUrl, loadedUrls, signal });
        checkedFiles = evidence.checkedFiles; findings.push(...evidence.findings);
      } finally { await previews.stop(projectId); }
    }
    signal.throwIfAborted();
    lastVerification = { ok: findings.length === 0, findings, build, visual, image, playtest, assets, checkedFiles };
    await fs.writeFile(path.join(jobDirectory, 'host-verification.json'), JSON.stringify(lastVerification, null, 2));
    return { ok: lastVerification.ok, findings };
  };
  const result = await harness.run({ projectId, cwd: workspace, prompt: input.prompt + (input.previousResult ? `\n上一轮记录（只作来源，当前指令优先）：${JSON.stringify(input.previousResult)}` : ''),
    model: input.modelSelection.model, effort: input.modelSelection.effort, threadId: null, dynamicTools: MEDIA_DYNAMIC_TOOLS,
    imageGenerationSkill: { name: 'imagegen', path: skillPath }, imageGenerationRoute: 'codex-imagegen',
    imageGenerationRequirement: await imageRequirement(), refreshImageGenerationRequirement: imageRequirement,
    audioGenerationRequirement: { state: 'not-required' }, targetFrameRate: 60, validateHostDelivery,
    promptAdditions: Object.fromEntries(['planner', 'implementer', 'reviewer', 'repair'].map((role) => [role,
      NOOBI_PLAYTEST_GUIDANCE + `\n临时校验脚本和实验输出使用本作业的授权临时目录 ${JSON.stringify(path.join(jobDirectory, 'tmp'))}，不要放进项目 tmp/、scripts/ 或 src/ 冒充交付代码。它们会保存在本作业记录中，不是游戏入口，也不计作已试玩代码。实际源码、构建依赖和运行依赖仍留在项目并经过相应检查。处理旧工作副本时，先核对文件用途；只有确认纯辅助校验、不会被源码/构建/游戏调用的脚本，才可保留原字节到该临时目录后移出项目。不能靠移动未测模块绕过检查。用途不明则保留并报告具体缺口。` + '\n当前是在 IRiXI 内完成已授权的 Web 小游戏。只操作当前工作副本，不读取其他用户项目、凭证或历史库。当前图像路线明确为现有 Desktop Codex ImageGen，不开通其他服务。保持 Noobi 的生产构建、素材与真实试玩要求，交付 dist/index.html。实现需要的源码、构建及 .noobi/playtest.json。若源码经过打包转换，构建须生成带 sourcesContent 的外部 sourcemap（例如 Vite build.sourcemap=true），供宿主核对实际试玩与源码版本；直接拷贝的源码不需要转换映射。审批请求交给宿主处理，不绕过。素材先用 noobi_asset_list 检查、用 noobi_asset_register 登记，不自行猜清单格式或覆盖宿主登记。若清单已损坏，保留旧文件为诊断副本，写入正确空清单后使用登记工具重新登记已有图片；这不替代宿主私有来源校验。正确空清单为：' + JSON.stringify({ version: 1, projectId, assets: [], updatedAt: new Date().toISOString() })])),
  });
  await settleAssets(); await eventTail; controller.signal.throwIfAborted();
  if (!lastVerification?.ok) throw new Error('Noobi 返回后仍缺少通过的宿主检查。');
  return { status: 'completed', projectId, jobId, buildVersion: input.buildVersion, modelSelection: input.modelSelection,
    mediaRoute: 'codex-imagegen', ephemeral: true, result, entrypoint: 'dist/index.html', verification: lastVerification,
    continuation: 'Product-owned context and files; next run starts a linked new temporary thread.' };
}
