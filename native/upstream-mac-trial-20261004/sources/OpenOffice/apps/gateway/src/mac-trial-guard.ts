import { createHash } from "crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "fs";
import path from "path";
import type { Command } from "@office/shared";
import { ARTICLE_PROJECT_CAPACITY } from "./article-project-capacity.js";

export const MAC_TRIAL_MODEL = "gpt-5.6-sol";
const MAX_PROMPT_BYTES = 64 * 1024;
const MAX_HISTORY_BYTES = 1024 * 1024;
const INTAKE_PROTOCOL_TAG = "PROJECT_INTAKE_DISCUSSION_07";
const EXECUTION_PROTOCOL_TAG = "INTEGRATED_TOY_DEVELOPER_05";
const ARTICLE_DEVELOPER_TAG = "ARTICLE_LEARNING_DEVELOPER_12";
const ARTICLE_INFERENCE_TAG = "ARTICLE_LEARNING_INFERENCE_12";
export const MAC_TRIAL_ARCHIVE_ID = "1791112172264-toy-contract-review-20261004";
export const MAC_TRIAL_ARCHIVE_SHA256 = "2691710c5bf09f2442a08f0e44fb78a3b4fb9dded06d6f6a04063b4c56886a96";

export interface MacTrialConfig {
  stateRoot: string;
  workspace: string;
  executionWorkspace: string | null;
  wrapper: string;
  model: typeof MAC_TRIAL_MODEL;
}

function noLinkRealpath(value: string, kind: "directory" | "file", label: string): string {
  if (!path.isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
  const absolute = path.resolve(value);
  const parsed = path.parse(absolute);
  let cursor = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new Error(`${label} must not contain symbolic links`);
  }
  const stat = lstatSync(absolute);
  if (kind === "directory" && !stat.isDirectory()) throw new Error(`${label} must be a directory`);
  if (kind === "file" && (!stat.isFile() || stat.nlink !== 1)) throw new Error(`${label} must be a single-link regular file`);
  const real = realpathSync(absolute);
  if (real !== absolute) throw new Error(`${label} must already be canonical`);
  return real;
}

export function loadMacTrialConfig(env: NodeJS.ProcessEnv = process.env): MacTrialConfig | null {
  if (env.OPEN_OFFICE_MAC_TRIAL !== "1") return null;
  if (env.NO_OPEN !== "1") throw new Error("Mac trial requires NO_OPEN=1");
  const stateRoot = env.OPEN_OFFICE_CONFIG_DIR?.trim();
  const workspace = env.WORKSPACE?.trim();
  const wrapper = env.OPEN_OFFICE_CODEX_WRAPPER?.trim();
  const executionWorkspace = env.OPEN_OFFICE_IRIXI_EXECUTION_WORKSPACE?.trim() || null;
  const model = env.OPEN_OFFICE_CODEX_MODEL?.trim();
  if (!stateRoot || !workspace || !wrapper || !model) {
    throw new Error("Mac trial requires explicit state, workspace, wrapper, and model configuration");
  }
  if (model !== MAC_TRIAL_MODEL) throw new Error(`Mac trial model must be ${MAC_TRIAL_MODEL}`);
  const checkedStateRoot = noLinkRealpath(stateRoot, "directory", "Mac trial state root");
  const checkedWorkspace = noLinkRealpath(workspace, "directory", "Mac trial workspace");
  const checkedExecutionWorkspace = executionWorkspace ? noLinkRealpath(executionWorkspace, "directory", "Mac trial execution workspace") : null;
  const checkedWrapper = noLinkRealpath(wrapper, "file", "Mac trial wrapper");
  if ((lstatSync(checkedWrapper).mode & 0o111) === 0) throw new Error("Mac trial wrapper must be executable");
  if (checkedStateRoot === checkedWorkspace
    || checkedWorkspace.startsWith(`${checkedStateRoot}${path.sep}`)
    || checkedStateRoot.startsWith(`${checkedWorkspace}${path.sep}`)) {
    throw new Error("Mac trial state and workspace roots must be separate");
  }
  if (checkedWrapper.startsWith(`${checkedWorkspace}${path.sep}`)) throw new Error("Mac trial wrapper must be outside the writable workspace");
  if (checkedExecutionWorkspace && (checkedExecutionWorkspace === checkedWorkspace
    || checkedExecutionWorkspace.startsWith(`${checkedStateRoot}${path.sep}`)
    || checkedStateRoot.startsWith(`${checkedExecutionWorkspace}${path.sep}`)
    || checkedWrapper.startsWith(`${checkedExecutionWorkspace}${path.sep}`))) throw new Error("Mac trial execution workspace separation is invalid");
  return { stateRoot: checkedStateRoot, workspace: checkedWorkspace, executionWorkspace: checkedExecutionWorkspace, wrapper: checkedWrapper, model: MAC_TRIAL_MODEL };
}

export function sameMacTrialPath(value: unknown, expected: string): boolean {
  if (typeof value !== "string" || !path.isAbsolute(value) || !existsSync(value)) return false;
  try { return noLinkRealpath(value, "directory", "Command workspace") === expected; } catch { return false; }
}

function checkedProjectFile(workspace: string, value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0 || path.isAbsolute(value)) return false;
  const resolved = path.resolve(workspace, value);
  if (!resolved.startsWith(`${workspace}${path.sep}`) || !existsSync(resolved)) return false;
  try {
    const relative = path.relative(workspace, noLinkRealpath(resolved, "file", "Review file"));
    return relative === value && !relative.startsWith("..") && !path.isAbsolute(relative);
  } catch { return false; }
}

const ALLOWED_COMMANDS = new Set([
  "PING", "GET_CONFIG", "CREATE_AGENT", "RUN_TASK", "CANCEL_TASK", "FIRE_AGENT",
  "REQUEST_REVIEW", "SYNC_CHAT_HISTORY", "LOAD_CHAT_HISTORY",
  "LIST_PROJECTS", "LOAD_PROJECT", "SERVE_PREVIEW",
]);

export function assertMacTrialArchive(projectId: unknown, guard: MacTrialConfig): void {
  if (projectId !== MAC_TRIAL_ARCHIVE_ID) throw new Error("Mac trial archive is not authorized");
  const archive = path.join(guard.stateRoot, "data", "project-history", `${MAC_TRIAL_ARCHIVE_ID}.json`);
  const checked = noLinkRealpath(archive, "file", "Mac trial archive");
  const bytes = readFileSync(checked);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== MAC_TRIAL_ARCHIVE_SHA256) throw new Error("Mac trial archive hash mismatch");
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf-8")); } catch { throw new Error("Mac trial archive is malformed"); }
  if (!parsed || typeof parsed !== "object" || (parsed as { id?: unknown }).id !== MAC_TRIAL_ARCHIVE_ID) {
    throw new Error("Mac trial archive identity mismatch");
  }
}

export function assertMacTrialCommand(command: Command, guard: MacTrialConfig): void {
  if (!ALLOWED_COMMANDS.has(command.type)) throw new Error(`Mac trial rejects command ${command.type}`);
  switch (command.type) {
    case "CREATE_AGENT":
      if (command.name !== "Rex" || !command.role.startsWith("Senior Developer")) throw new Error("Mac trial only permits the built-in Developer");
      if (command.backend !== "codex" || (command.model !== undefined && command.model !== guard.model)) throw new Error("Mac trial agent backend/model mismatch");
      if (!sameMacTrialPath(command.workDir, guard.workspace)) throw new Error("Mac trial agent workspace mismatch");
      if (command.teamId || (command.skillFiles?.length ?? 0) > 0) throw new Error("Mac trial agent cannot join a team or load skills");
      break;
    case "RUN_TASK":
      { const isIntake = command.prompt.startsWith(`${INTAKE_PROTOCOL_TAG}\n`);
      const isExecution = command.prompt.includes(EXECUTION_PROTOCOL_TAG) || command.prompt.includes(ARTICLE_DEVELOPER_TAG);
      const isInference = command.prompt.startsWith(`${ARTICLE_INFERENCE_TAG}\n`);
      if (guard.executionWorkspace) {
        if ([isIntake, isExecution, isInference].filter(Boolean).length !== 1) throw new Error("Mac trial task protocol is missing or ambiguous");
        if (isIntake && !sameMacTrialPath(command.repoPath, guard.workspace)) throw new Error("Mac trial intake workspace mismatch");
        if ((isExecution || isInference) && !sameMacTrialPath(command.repoPath, guard.executionWorkspace)) throw new Error("Mac trial execution workspace mismatch");
      } else if (!sameMacTrialPath(command.repoPath, guard.workspace)) throw new Error("Mac trial task workspace mismatch");
      if (command.backend || command.teamId || command.personality || (command.name !== undefined && command.name !== "Rex") || (command.role !== undefined && !command.role.startsWith("Senior Developer"))) {
        throw new Error("Mac trial task cannot override agent registration");
      }
      const promptLimit = isExecution && command.prompt.includes(ARTICLE_DEVELOPER_TAG) ? ARTICLE_PROJECT_CAPACITY.maxNativePromptBytes : MAX_PROMPT_BYTES;
      if (!command.prompt.trim() || Buffer.byteLength(command.prompt) > promptLimit) throw new Error("Mac trial task prompt is empty or oversized");
      }
      break;
    case "REQUEST_REVIEW":
      { const reviewRoot = guard.executionWorkspace && sameMacTrialPath(command.projectDir, guard.executionWorkspace) ? guard.executionWorkspace : guard.workspace;
      if (command.backend !== "codex" || !sameMacTrialPath(command.projectDir, reviewRoot)) throw new Error("Mac trial review binding mismatch");
      if (command.changedFiles.length === 0 || command.changedFiles.length > 8 || !command.changedFiles.every((file) => checkedProjectFile(reviewRoot, file))) {
        throw new Error("Mac trial review files must be existing authorized workspace files");
      }
      if (command.entryFile && !checkedProjectFile(reviewRoot, command.entryFile)) throw new Error("Mac trial review entry file is unauthorized");
      }
      break;
    case "SERVE_PREVIEW":
      if (!guard.executionWorkspace || command.previewCmd || command.previewPort || command.cwd) throw new Error("Mac trial permits only registered static preview");
      if (typeof command.filePath !== "string" || ![".html", ".htm"].includes(path.extname(command.filePath).toLowerCase())) throw new Error("Mac trial preview entry must be HTML");
      { const absolute = path.resolve(command.filePath);
        if (!absolute.startsWith(`${guard.executionWorkspace}${path.sep}`) || !existsSync(absolute)) throw new Error("Mac trial preview entry is outside the execution workspace");
        noLinkRealpath(absolute, "file", "Preview entry"); }
      break;
    case "SYNC_CHAT_HISTORY":
      if (Buffer.byteLength(command.data) > MAX_HISTORY_BYTES) throw new Error("Mac trial chat history is oversized");
      break;
    case "LOAD_PROJECT":
      assertMacTrialArchive(command.projectId, guard);
      break;
    default:
      break;
  }
}

export function macTrialRestoredAgentAllowed(agent: {
  backend?: string; model?: string; teamId?: string; workDir?: string; name?: string; role?: string; skillFiles?: string[];
}, guard: MacTrialConfig): boolean {
  return agent.name === "Rex"
    && Boolean(agent.role?.startsWith("Senior Developer"))
    && agent.backend === "codex"
    && agent.model === guard.model
    && !agent.teamId
    && (agent.skillFiles?.length ?? 0) === 0
    && sameMacTrialPath(agent.workDir, guard.workspace);
}
