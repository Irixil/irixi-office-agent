import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { patchNoobiInputTiming } from './noobi-input-timing-patch.mjs';

const run = promisify(execFile);
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const product = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(os.homedir(), 'Desktop/自媒体/Noobi-rixi.ai');
const base = path.join(product, '.irixi-runtime/noobi-specialist');
await fs.mkdir(base, { recursive: true });
const build = await fs.mkdtemp(path.join(base, 'build-'));
const originals = {};
async function copyTree(relative) {
  const from = path.join(source, relative); const to = path.join(build, relative);
  const stat = await fs.lstat(from);
  if (stat.isSymbolicLink()) throw new Error(`Noobi source link not copied: ${relative}`);
  if (stat.isDirectory()) {
    await fs.mkdir(to, { recursive: true });
    for (const entry of await fs.readdir(from)) await copyTree(`${relative}/${entry}`);
  } else if (stat.isFile() && !relative.endsWith('.test.ts')) {
    const content = await fs.readFile(from); originals[relative] = hash(content); await fs.writeFile(to, content);
  }
}
await copyTree('src/main'); await copyTree('src/shared'); await copyTree('src/generated');
await fs.writeFile(path.join(build, 'package.json'), JSON.stringify({ name: 'irixi-controlled-noobi', private: true, type: 'module' }));
// Dependencies are provided by the user's confirmed Noobi installation. Build
// output and compatibility changes remain in this dedicated product directory.
await fs.symlink(path.join(source, 'node_modules'), path.join(build, 'node_modules'));
const filename = path.join(build, 'src/main/codexAppServer.ts');
let code = await fs.readFile(filename, 'utf8');
function replace(before, after) {
  if (code.split(before).length !== 2) throw new Error('Noobi source changed; compatibility patch requires review.');
  code = code.replace(before, after);
}
replace('export interface CodexAppServerOptions {', `export interface CodexAppServerOptions {
  hostControl?: {
    binaryPath: string;
    stateDir: string;
    permissionProfiles: { readOnlyId: string; workspaceId: string; args: string[] };
    threadConfig?: Record<string, JsonValue>;
    onProcess?: (pid: number) => Promise<void>;
    onThread?: (record: { id: string; model: string; requestedModel: string | null; ephemeral: boolean; path: null; provider: string; permissionProfile: { id: string; extends: string }; toolIsolation: CodexMcpServerStatus[] }) => Promise<void>;
  };`);
replace('  readonly #configuredCodexHome: string | null;', '  readonly #configuredCodexHome: string | null;\n  readonly #hostControl: CodexAppServerOptions["hostControl"];');
replace('  thread: { id: string };\n  model: string;', '  thread: { id: string; ephemeral?: boolean; path?: string | null };\n  model: string;\n  modelProvider: string;\n  activePermissionProfile?: { id: string; extends: string };\n  runtimeWorkspaceRoots?: string[];');
replace('  connected: boolean;\n  toolCount: number;', '  connected: boolean;\n  toolCount: number;\n  runtimeStatus: string | null;');
replace('    serverInfo: unknown | null;', '    serverInfo: unknown | null;\n    runtimeStatus: string | null;');
replace('  async listMcpServerStatuses(): Promise<CodexMcpServerStatus[]> {', '  async listMcpServerStatuses(threadId?: string): Promise<CodexMcpServerStatus[]> {');
replace("        detail: 'toolsAndAuthOnly',", "        detail: 'toolsAndAuthOnly',\n        ...(threadId ? { threadId } : {}),");
replace('        connected: server.serverInfo !== null,', '        connected: server.serverInfo !== null,\n        runtimeStatus: server.runtimeStatus,');
replace('    return statuses;', "    if (cursor && this.#hostControl) throw new Error('Noobi tool inventory was truncated');\n    return statuses;");
replace('    super();', `    super();
    this.#hostControl = options.hostControl;
    if (this.#hostControl && (!isAbsolute(this.#hostControl.binaryPath) || !isAbsolute(this.#hostControl.stateDir))) throw new Error('Controlled Noobi requires explicit absolute runtime paths');`);
replace('      const binaryPath = await locateCodexBinary();', `      const binaryPath = this.#hostControl?.binaryPath ?? await locateCodexBinary();
      const extraConfig: string[] = [];
      if (this.#hostControl) {
        await mkdir(this.#hostControl.stateDir, { recursive: true, mode: 0o700 });
        extraConfig.push('-c', 'sqlite_home=' + JSON.stringify(resolve(this.#hostControl.stateDir, 'database')),
          '-c', 'log_dir=' + JSON.stringify(resolve(this.#hostControl.stateDir, 'logs')),
          '-c', 'history.persistence="none"', '-c', 'project_doc_max_bytes=0',
          '-c', 'features.apps=false', '-c', 'features.plugins=false', '-c', 'features.hooks=false',
          '-c', 'features.multi_agent=false', '-c', 'features.browser_use=false', '-c', 'features.computer_use=false',
          '-c', 'features.skip_host_skill_discovery=true', '-c', 'mcp_servers={}',
          '-c', 'mcp_servers.node_repl={command="/usr/bin/false",enabled=false}');
        extraConfig.push(...this.#hostControl.permissionProfiles.args);
      }`);
replace("['app-server', '--listen', 'stdio://', '--strict-config']", "['app-server', '--listen', 'stdio://', '--strict-config', ...extraConfig]");
replace('      peer.start();', `      peer.start();
      if (this.#hostControl && child.pid) await this.#hostControl.onProcess?.(child.pid);`);
// The first isolated initialization was observed to take 33 seconds. Preserve
// cancellation while allowing startup; this is not a model retry.
replace("          experimentalApi: true,\n        },\n      });\n      this.#assertGeneration(generation);", "          experimentalApi: true,\n        },\n      }, this.#hostControl ? 90_000 : 30_000);\n      this.#assertGeneration(generation);");
replace('      experimentalRawEvents: false,', `      ...(this.#hostControl ? { ephemeral: true, allowProviderModelFallback: false,
        runtimeWorkspaceRoots: [options.cwd], config: this.#hostControl.threadConfig ?? {} } : {}),
      experimentalRawEvents: false,`);
replace("    const result = await this.#request<ThreadResponse>('thread/start', {\n      cwd: options.cwd,\n      ...(options.model ? { model: options.model } : {}),\n      sandbox: options.sandbox ?? 'workspace-write',", `    const result = await this.#request<ThreadResponse>('thread/start', {
      cwd: options.cwd,
      ...(options.model ? { model: options.model } : {}),
      ...(this.#hostControl
        ? { permissions: options.sandbox === 'read-only' ? this.#hostControl.permissionProfiles.readOnlyId : this.#hostControl.permissionProfiles.workspaceId }
        : { sandbox: options.sandbox ?? 'workspace-write' }),`);
const startMarker = '    return result.thread.id;\n  }\n\n  async resumeThread';
replace(startMarker, `    if (this.#hostControl) {
      if (options.model && result.model !== options.model) throw new Error('Noobi selected model differs from the requested model');
      if (result.thread.ephemeral !== true || result.thread.path !== null) throw new Error('Noobi temporary thread isolation was not confirmed');
      const requestedProfile = options.sandbox === 'read-only' ? this.#hostControl.permissionProfiles.readOnlyId : this.#hostControl.permissionProfiles.workspaceId;
      const expectedBase = options.sandbox === 'read-only' ? ':read-only' : ':workspace';
      if (result.activePermissionProfile?.id !== requestedProfile || result.activePermissionProfile.extends !== expectedBase) throw new Error('Noobi native tool permissions were not confirmed');
      if (result.runtimeWorkspaceRoots?.length !== 1 || result.runtimeWorkspaceRoots[0] !== options.cwd) throw new Error('Noobi native tool workspace was not confirmed');
      const toolIsolation = await this.listMcpServerStatuses(result.thread.id);
      if (toolIsolation.some((tool) => tool.runtimeStatus !== 'disabled' || tool.connected || tool.toolCount)) throw new Error('Noobi connection includes tools outside the controlled project boundary');
      await this.#hostControl.onThread?.({ id: result.thread.id, model: result.model, requestedModel: options.model ?? null, ephemeral: true, path: null, provider: result.modelProvider, permissionProfile: result.activePermissionProfile, toolIsolation });
    }
    return result.thread.id;
  }

  async resumeThread`);
// A persisted old thread is never resumed by the isolated specialist. The
// product supplies its own saved requirements, files and previous result.
replace('  async resumeThread(threadId: string, options: StartThreadOptions): Promise<string> {\n    await this.start();', `  async resumeThread(threadId: string, options: StartThreadOptions): Promise<string> {
    if (this.#hostControl) return this.startThread(options);
    await this.start();`);
await fs.writeFile(filename, code);
// The public manifest belongs to the editable workspace. Its parse failure
// must reach the specialist's existing repair loop, not abort before repair.
const harnessFile = path.join(build, 'src/main/gameHarness.ts');
let harnessCode = await fs.readFile(harnessFile, 'utf8');
function patchHarness(before, after) {
  if (harnessCode.split(before).length !== 2) throw new Error('Noobi harness changed; manifest recovery patch requires review.');
  harnessCode = harnessCode.replace(before, after);
}
patchHarness("export type HostImageGenerationRequirement =\n  | { state: 'fresh-generation-required' }", "export type HostImageGenerationRequirement =\n  | { state: 'manifest-repair-required' }\n  | { state: 'fresh-generation-required' }");
patchHarness("  const hostStatus = requirement.state === 'fresh-generation-required'", "  const hostStatus = requirement.state === 'manifest-repair-required'\n    ? '<host_attestation status=\"unverified-manifest\">The editable asset manifest is malformed or belongs to the wrong project. Repair its schema and register existing images with noobi_asset_register before requesting fresh generation. Existing private generation receipts are preserved, but no asset is accepted until the host rechecks its bytes and production use. Reviewer must return repair while the manifest is invalid.</host_attestation>'\n    : requirement.state === 'fresh-generation-required'");
patchHarness("function normalizeImageGenerationRequirement(\n  input: HostImageGenerationRequirement,\n): HostImageGenerationRequirement {", "function normalizeImageGenerationRequirement(\n  input: HostImageGenerationRequirement,\n): HostImageGenerationRequirement {\n  if (input.state === 'manifest-repair-required') return { state: 'manifest-repair-required' };");
// Run the first controlled host delivery gate before the first Reviewer.
patchHarness("      this.#setPhase(active, 'reviewer');\n      this.#throwIfStopped(active);\n      reviewerThreadId = await this.#runtime.startThread({", "      this.#setPhase(active, 'reviewer');\n      this.#throwIfStopped(active);\n      // The first Reviewer needs current host evidence, just like every\n      // post-repair Reviewer. Keep the same callback and cancellation boundary.\n      const initialHostDelivery = await validateHostDelivery(active, options);\n      this.#throwIfStopped(active);\n      if (initialHostDelivery) {\n        this.#emitAgentEvent(active, {\n          kind: initialHostDelivery.ok ? 'assistant' : 'error',\n          title: initialHostDelivery.ok ? 'Host delivery · passed' : 'Host delivery · repair required',\n          message: initialHostDelivery.ok\n            ? 'The current implementation passed deterministic host checks; the Reviewer will inspect this fresh evidence.'\n            : formatReviewMessage(hostDeliveryRepairReview(initialHostDelivery)),\n          stage: 'verify',\n          method: initialHostDelivery.ok ? 'harness/host-delivery/pass' : 'harness/host-delivery/repair',\n        });\n      }\n      reviewerThreadId = await this.#runtime.startThread({");
patchHarness("      let reviewer = summarizeTurn(reviewerThreadId, reviewerTurn);\n      let review = parseReview(reviewer.text);\n      this.#emitAgentEvent(active, {", "      let reviewer = summarizeTurn(reviewerThreadId, reviewerTurn);\n      let review = parseReview(reviewer.text);\n      const initialReviewerVerdict = review.verdict;\n      if (initialHostDelivery && !initialHostDelivery.ok) {\n        const hostReview = hostDeliveryRepairReview(initialHostDelivery);\n        review = review.verdict === 'pass' ? hostReview : mergePendingReviewWithHostFindings(review, hostReview);\n      }\n      this.#emitAgentEvent(active, {");
patchHarness("      let findingAuthority: 'reviewer' | 'host' | 'mixed' = 'reviewer';\n      let hostValidatedForCurrentWorkspace = false;", "      let findingAuthority: 'reviewer' | 'host' | 'mixed' = initialHostDelivery && !initialHostDelivery.ok\n        ? initialReviewerVerdict === 'pass' ? 'host' : 'mixed'\n        : 'reviewer';\n      let hostValidatedForCurrentWorkspace = initialHostDelivery?.ok === true;");
patchHarness("          buildReviewerPrompt(\n            options.prompt,\n            planner.text,\n            implementation.text,\n            imageGenerationRequirement,\n            targetFrameRate,\n            imageGenerationRoute,\n            audioGenerationRequirement,\n          ),", "          buildReviewerPrompt(\n            options.prompt,\n            planner.text,\n            implementation.text,\n            imageGenerationRequirement,\n            targetFrameRate,\n            imageGenerationRoute,\n            audioGenerationRequirement,\n          ) + (initialHostDelivery\n            ? `\\n\\n<current_host_delivery status=\"${initialHostDelivery.ok ? 'passed-pending-review' : 'repair-required'}\">${JSON.stringify(initialHostDelivery)}</current_host_delivery>\\nThe host has just checked this workspace before your review. Inspect artifacts/playtest/latest/report.json and its referenced screenshots when present. Verify the actual evidence; a host pass alone cannot force your verdict. A missing fresh report must not be described as a completed playtest.`\n            : ''),");
await fs.writeFile(harnessFile, harnessCode);
const evaluatorFile = path.join(build, 'src/main/gameplayExperienceEvaluator.ts');
const evaluatorCode = patchNoobiInputTiming(await fs.readFile(evaluatorFile, 'utf8'), '55b044410458d15bec305f1c88f20adc3ce68dc162c90a007361c062b217f8e7');
await fs.writeFile(evaluatorFile, evaluatorCode);
const entries = ['gameHarness', 'assetStore', 'assetPlanStore', 'mediaToolBroker', 'imageGenerationAttestation',
  'previewServer', 'webProductionBuild', 'gameplayExperienceEvaluator', 'visualAssetCoverage', 'eventMapper', 'imageGenerationSkillPolicy', 'approvalBroker'];
await fs.writeFile(path.join(build, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
  target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', lib: ['ES2022'], strict: true,
  skipLibCheck: true, esModuleInterop: true, rootDir: 'src', outDir: 'dist', types: ['node'],
}, files: [...entries.map((name) => `src/main/${name}.ts`), 'src/main/three-stdlib.d.ts'] }, null, 2));
await run(process.execPath, [path.join(source, 'node_modules/typescript/bin/tsc'), '-p', path.join(build, 'tsconfig.json')], { cwd: build, maxBuffer: 1024 * 1024 });
const outputs = {};
async function index(relative) {
  for (const e of await fs.readdir(path.join(build, relative), { withFileTypes: true })) {
    const name = `${relative}/${e.name}`;
    if (e.isDirectory()) await index(name); else outputs[name] = hash(await fs.readFile(path.join(build, name)));
  }
}
await index('dist');
const manifest = { source, createdAt: new Date().toISOString(), originals, compatibilityVersion: 1,
  patchedSource: { 'src/main/codexAppServer.ts': hash(code), 'src/main/gameHarness.ts': hash(harnessCode), 'src/main/gameplayExperienceEvaluator.ts': hash(evaluatorCode) }, outputs,
  version: hash(JSON.stringify({ originals, outputs })), modules: entries,
  dependencyDirectory: path.join(source, 'node_modules'),
  limits: ['Controlled ephemeral threads; continuation is product-owned, not old-thread resume.', 'Real model, media, cancellation and gameplay checks still required.'] };
await fs.writeFile(path.join(build, 'manifest.json'), JSON.stringify(manifest, null, 2));
await fs.writeFile(path.join(base, 'selected.json'), JSON.stringify({ directory: path.basename(build), version: manifest.version }));
console.log(JSON.stringify({ build, version: manifest.version, originalFiles: Object.keys(originals).length, compiledFiles: Object.keys(outputs).length }));
