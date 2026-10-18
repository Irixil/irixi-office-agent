import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

const HEX64 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9_-]{1,160}$/;
const MAX_NOOBI_REGISTERED_READONLY_PNG_BYTES = 2 * 1024 * 1024;
const NOOBI_REGISTERED_READONLY_PNG_PATHS = new Set([
  "public/assets/images/books/book-stack-at-desk.png",
  "public/assets/images/books/book-stack-master.png",
  "public/assets/images/books/book-stack-shelved-patch.png",
  "public/assets/images/irixi/runtime/down.png",
  "public/assets/images/irixi/runtime/irixi-left.png",
  "public/assets/images/irixi/runtime/irixi-right.png",
  "public/assets/images/irixi/runtime/irixi-up.png",
  "public/assets/images/irixi/walk/down/spritesheet.png",
  "public/assets/images/irixi/walk/left/spritesheet.png",
  "public/assets/images/irixi/walk/right/spritesheet.png",
  "public/assets/images/irixi/walk/up/spritesheet.png",
  "public/assets/images/rooms/room-1440x810.png",
]);

export function isAllowedProductSourceFile(projectId: string, sourcePath: string, bytes: number, writable: boolean): boolean {
  if (!Number.isInteger(bytes) || bytes < 0) return false;
  if (bytes <= 512 * 1024) return true;
  return projectId === "noobi-owl-book-sorter-v1" && !writable
    && NOOBI_REGISTERED_READONLY_PNG_PATHS.has(sourcePath)
    && bytes <= MAX_NOOBI_REGISTERED_READONLY_PNG_BYTES;
}

export type ProductProjectRegistry = {
  schemaVersion: 1;
  projectId: string;
  taskId: string;
  goalVersionId: string;
  taskInputBindingSha256: string;
  pipelineBindingSha256: string;
  authorityUrl: string;
  workspace: {
    path: string;
    scopeFingerprint: string;
    sourceSnapshotSha256: string;
    sourceHead: string;
    sourceManifest: Array<{ path: string; bytes: number; sha256: string; mode: number }>;
    allowedWritePaths: string[];
    checks: string[];
  };
  native: {
    backend: string;
    model: string;
    allowedRoles: string[];
    maxModelCalls: number;
    maxDurationMs: number;
    promptBudget: { contextWindowTokens: number; effectiveContextPercent: number; outputTokens: number; protocolTokens: number };
  };
  capabilities: {
    team: boolean;
    worktree: boolean;
    staticPreviewEntries: string[];
    staticPreviewFiles: string[];
    autoMerge: false;
    manualMerge: false;
    commandPreview: false;
  };
};

export type ProductProjectionBinding = {
  taskId: string;
  goalVersionId: string;
  taskInputBindingSha256: string;
  pipelineBindingSha256: string;
  current: boolean;
  execution: null | { id?: string | null };
  workspace: null | { current: boolean; scopeFingerprint: string; sourceSnapshotSha256: string };
};

export type ProductPreviewBinding = {
  taskId: string;
  goalVersionId: string;
  executionId: string;
  registrySha256: string;
  artifactId: string;
  artifactVersion: number;
  candidateSha256: string;
  token: string;
  entry: string;
};

export type ProductPreviewContext = ProductPreviewBinding & {
  root: string;
  entryAbsolute: string;
  status: "pending" | "ready" | "failed";
  error?: string;
};

let productPreviewContext: ProductPreviewContext | null = null;

export function getProductPreviewContext(): ProductPreviewContext | null {
  return productPreviewContext ? { ...productPreviewContext } : null;
}

export function beginProductPreview(context: ProductPreviewContext) {
  productPreviewContext = { ...context, status: "pending" };
}

export function finishProductPreview(token: string, status: "ready" | "failed", error?: string) {
  if (!productPreviewContext || productPreviewContext.token !== token) return null;
  productPreviewContext = { ...productPreviewContext, status, ...(error ? { error } : { error: undefined }) };
  return { ...productPreviewContext };
}

export function clearProductPreview() {
  productPreviewContext = null;
}

export function productPreviewMatches(context: ProductPreviewContext | null, value: {
  taskId?: string; goalVersionId?: string; execution?: { id?: string | null } | null;
  current?: boolean;
  product?: { registrySha256?: string | null; bindingCurrent?: boolean | null } | null;
  artifact?: { id?: string | null; version?: number | null; candidateSha256?: string | null } | null;
} | null | undefined): context is ProductPreviewContext {
  if (!value || value.current !== true || value.product?.bindingCurrent !== true) return false;
  return Boolean(context && value.taskId === context.taskId && value.goalVersionId === context.goalVersionId
    && value.execution?.id === context.executionId && value.product?.registrySha256 === context.registrySha256
    && value.artifact?.id === context.artifactId && value.artifact?.version === context.artifactVersion
    && value.artifact?.candidateSha256 === context.candidateSha256);
}

export function isNoobiBuiltPreviewAsset(projectId: string, value: string): boolean {
  return projectId === "noobi-owl-book-sorter-v1" && typeof value === "string" && value.length <= 240
    && value.startsWith("assets/") && !value.includes("\\") && !value.includes("\0")
    && !path.posix.isAbsolute(value) && path.posix.normalize(value) === value
    && value.split("/").every((part) => part && part !== "." && part !== ".." && !part.startsWith("."));
}

export function productPreviewContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return ext === ".html" || ext === ".htm" ? "text/html; charset=utf-8"
    : ext === ".css" ? "text/css; charset=utf-8"
      : ext === ".js" || ext === ".mjs" ? "application/javascript; charset=utf-8"
        : ext === ".png" ? "image/png"
          : ext === ".svg" ? "image/svg+xml"
            : ext === ".webp" ? "image/webp"
              : ext === ".avif" ? "image/avif"
                : ext === ".gif" ? "image/gif"
                  : ext === ".ico" ? "image/x-icon"
                    : ext === ".json" ? "application/json; charset=utf-8"
                      : ext === ".woff" ? "font/woff"
                        : ext === ".woff2" ? "font/woff2" : "application/octet-stream";
}

function fail(message: string): never {
  throw new Error(`Product project registry rejected: ${message}`);
}

function relativePath(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || path.isAbsolute(value) || value.includes("\0")) fail(`${label} is invalid`);
  const normalized = value.split(path.sep).join("/");
  if (normalized.includes("\\") || normalized.startsWith("/") || path.posix.normalize(normalized) !== normalized
    || normalized.split("/").some((part) => !part || part === "." || part === "..")) fail(`${label} escapes the workspace`);
  return normalized;
}

function stringArray(value: unknown, label: string, max = 128): string[] {
  if (!Array.isArray(value) || value.length > max || value.some((item) => typeof item !== "string" || !item.trim())) fail(`${label} is invalid`);
  return value.map((item) => item.trim());
}

function exactKeys(value: Record<string, unknown>, expected: string[], label: string) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) fail(`${label} fields changed`);
}

export function isAllowedAuthorityUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const endpoint = new URL(value);
    const port = Number(endpoint.port);
    return endpoint.protocol === "http:" && endpoint.hostname === "127.0.0.1"
      && Number.isInteger(port) && port >= 1024 && port <= 65535
      && !endpoint.username && !endpoint.password && endpoint.pathname === "/"
      && !endpoint.search && !endpoint.hash && endpoint.href === value;
  } catch {
    return false;
  }
}

export function productProjectRegistryEnabled(): boolean {
  return Boolean(process.env.OPEN_OFFICE_PRODUCT_REGISTRY_FILE?.trim());
}

export function loadProductProjectRegistry(): ProductProjectRegistry | null {
  const configured = process.env.OPEN_OFFICE_PRODUCT_REGISTRY_FILE?.trim();
  if (!configured) return null;
  if (!path.isAbsolute(configured) || !existsSync(configured)) fail("file must be an existing absolute path");
  const stat = lstatSync(configured);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || realpathSync(configured) !== configured) fail("file is not a stable regular file");
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(configured, "utf8")); }
  catch { fail("file is not valid JSON"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("root is invalid");
  const value = raw as Record<string, any>;
  exactKeys(value, ["schemaVersion", "projectId", "taskId", "goalVersionId", "taskInputBindingSha256", "pipelineBindingSha256", "authorityUrl", "workspace", "native", "capabilities"], "root");
  if (value.schemaVersion !== 1 || !SAFE_ID.test(value.projectId) || !SAFE_ID.test(value.taskId) || !SAFE_ID.test(value.goalVersionId)) fail("identity is invalid");
  if (!HEX64.test(value.taskInputBindingSha256) || !HEX64.test(value.pipelineBindingSha256)) fail("binding digest is invalid");
  if (!isAllowedAuthorityUrl(value.authorityUrl)) fail("authority URL must be an explicit HTTP loopback origin on a non-privileged port");

  if (!value.workspace || typeof value.workspace !== "object" || Array.isArray(value.workspace)) fail("workspace is invalid");
  exactKeys(value.workspace, ["path", "scopeFingerprint", "sourceSnapshotSha256", "sourceHead", "sourceManifest", "allowedWritePaths", "checks"], "workspace");
  if (!path.isAbsolute(value.workspace.path) || !existsSync(value.workspace.path) || realpathSync(value.workspace.path) !== value.workspace.path) fail("workspace path is not a real existing absolute path");
  if (!HEX64.test(value.workspace.scopeFingerprint) || !HEX64.test(value.workspace.sourceSnapshotSha256)) fail("workspace binding is invalid");
  if (typeof value.workspace.sourceHead !== "string" || !/^[a-f0-9]{40}$/.test(value.workspace.sourceHead)) fail("workspace source HEAD is invalid");
  if (!Array.isArray(value.workspace.sourceManifest) || !value.workspace.sourceManifest.length || value.workspace.sourceManifest.length > 256) fail("workspace source manifest is invalid");
  value.workspace.allowedWritePaths = stringArray(value.workspace.allowedWritePaths, "allowed write paths").map((item, index) => relativePath(item, `allowedWritePaths[${index}]`));
  value.workspace.sourceManifest = value.workspace.sourceManifest.map((entry: unknown, index: number) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail(`sourceManifest[${index}] is invalid`);
    const item = entry as Record<string, unknown>;
    exactKeys(item, ["path", "bytes", "sha256", "mode"], `sourceManifest[${index}]`);
    const sourcePath = relativePath(item.path, `sourceManifest[${index}].path`);
    const writable = Array.isArray(value.workspace.allowedWritePaths) && value.workspace.allowedWritePaths.includes(sourcePath);
    if (!Number.isInteger(item.bytes) || !isAllowedProductSourceFile(value.projectId, sourcePath, item.bytes as number, writable)
      || !HEX64.test(String(item.sha256 || "")) || !Number.isInteger(item.mode) || Number(item.mode) < 0 || Number(item.mode) > 0o777) {
      fail(`sourceManifest[${index}] is invalid`);
    }
    return { path: sourcePath, bytes: Number(item.bytes), sha256: String(item.sha256), mode: Number(item.mode) };
  });
  if (new Set(value.workspace.sourceManifest.map((entry: { path: string }) => entry.path)).size !== value.workspace.sourceManifest.length) fail("workspace source manifest paths are not unique");
  if (value.workspace.allowedWritePaths.some((entry: string) => !value.workspace.sourceManifest.some((source: { path: string }) => source.path === entry))) fail("writable paths are absent from the source manifest");
  value.workspace.checks = stringArray(value.workspace.checks, "checks", 32);

  if (!value.native || typeof value.native !== "object" || Array.isArray(value.native)) fail("native settings are invalid");
  exactKeys(value.native, ["backend", "model", "allowedRoles", "maxModelCalls", "maxDurationMs", "promptBudget"], "native");
  if (!SAFE_ID.test(value.native.backend) || typeof value.native.model !== "string" || !value.native.model.trim()) fail("native backend/model is invalid");
  value.native.allowedRoles = stringArray(value.native.allowedRoles, "allowed roles", 32);
  if (!Number.isInteger(value.native.maxModelCalls) || value.native.maxModelCalls < 1 || value.native.maxModelCalls > 64) fail("model call budget is invalid");
  if (!Number.isInteger(value.native.maxDurationMs) || value.native.maxDurationMs < 1_000 || value.native.maxDurationMs > 86_400_000) fail("duration budget is invalid");
  const promptBudget = value.native.promptBudget;
  if (!promptBudget || typeof promptBudget !== "object" || Array.isArray(promptBudget)) fail("native prompt budget is invalid");
  exactKeys(promptBudget, ["contextWindowTokens", "effectiveContextPercent", "outputTokens", "protocolTokens"], "native prompt budget");
  if (!Number.isInteger(promptBudget.contextWindowTokens) || promptBudget.contextWindowTokens < 1
    || typeof promptBudget.effectiveContextPercent !== "number" || promptBudget.effectiveContextPercent <= 0 || promptBudget.effectiveContextPercent > 100
    || !Number.isInteger(promptBudget.outputTokens) || promptBudget.outputTokens < 1
    || !Number.isInteger(promptBudget.protocolTokens) || promptBudget.protocolTokens < 1) fail("native prompt budget values are invalid");

  if (!value.capabilities || typeof value.capabilities !== "object" || Array.isArray(value.capabilities)) fail("capabilities are invalid");
  const capabilities = value.capabilities as Record<string, unknown>;
  const capabilityKeys = Object.keys(capabilities).sort();
  const currentCapabilityKeys = ["team", "worktree", "staticPreviewEntries", "staticPreviewFiles", "autoMerge", "manualMerge", "commandPreview"].sort();
  const legacyCapabilityKeys = currentCapabilityKeys.filter((key) => key !== "staticPreviewFiles");
  if (JSON.stringify(capabilityKeys) !== JSON.stringify(currentCapabilityKeys)
    && JSON.stringify(capabilityKeys) !== JSON.stringify(legacyCapabilityKeys)) fail("capabilities fields changed");
  capabilities.staticPreviewFiles ??= [];
  if (typeof value.capabilities.team !== "boolean" || typeof value.capabilities.worktree !== "boolean"
    || value.capabilities.autoMerge !== false || value.capabilities.manualMerge !== false || value.capabilities.commandPreview !== false) {
    fail("merge and command preview must remain disabled");
  }
  value.capabilities.staticPreviewEntries = stringArray(value.capabilities.staticPreviewEntries, "static preview entries", 32)
    .map((item, index) => relativePath(item, `staticPreviewEntries[${index}]`));
  value.capabilities.staticPreviewFiles = stringArray(value.capabilities.staticPreviewFiles, "static preview files", 128)
    .map((item, index) => relativePath(item, `staticPreviewFiles[${index}]`));
  if (value.capabilities.staticPreviewEntries.some((entry: string) => !/\.html?$/i.test(entry)
    || !value.capabilities.staticPreviewFiles.includes(entry) || !value.workspace.sourceManifest.some((source: { path: string }) => source.path === entry))
    || value.capabilities.staticPreviewFiles.some((entry: string) => !value.workspace.sourceManifest.some((source: { path: string }) => source.path === entry))) {
    fail("static preview files must be registered source files and entries must be HTML");
  }
  if (!value.capabilities.team && value.native.allowedRoles.length > 1) fail("multiple roles require the team capability");
  return value as ProductProjectRegistry;
}

export function assertProductProjection(registry: ProductProjectRegistry, value: ProductProjectionBinding) {
  if (!productProjectionMatches(registry, value)) {
    fail("current Irixi task, goal, input, pipeline, execution, or workspace binding changed");
  }
}

export function productProjectionMatches(registry: ProductProjectRegistry, value: ProductProjectionBinding): boolean {
  return Boolean(value.current && value.taskId === registry.taskId && value.goalVersionId === registry.goalVersionId
    && value.taskInputBindingSha256 === registry.taskInputBindingSha256 && value.pipelineBindingSha256 === registry.pipelineBindingSha256
    && value.execution?.id && value.workspace?.current && value.workspace.scopeFingerprint === registry.workspace.scopeFingerprint
    && value.workspace.sourceSnapshotSha256 === registry.workspace.sourceSnapshotSha256);
}

export function assertProductWorkspace(registry: ProductProjectRegistry, candidate: string | undefined) {
  if (!candidate || !path.isAbsolute(candidate) || !existsSync(candidate) || realpathSync(candidate) !== registry.workspace.path) {
    fail("native work directory is outside the registered workspace");
  }
}

export function assertProductAgent(registry: ProductProjectRegistry, input: { role?: string; backend?: string; model?: string; teamId?: string | null; workDir?: string }) {
  const role = String(input.role || "").split(/\s*[—–]\s*/)[0].trim().toLowerCase();
  if (!registry.native.allowedRoles.some((item) => item.toLowerCase() === role)) fail("agent role is not registered");
  if ((input.backend || registry.native.backend) !== registry.native.backend || (input.model || registry.native.model) !== registry.native.model) fail("agent backend or model changed");
  if (input.teamId && !registry.capabilities.team) fail("team execution is not registered");
  assertProductWorkspace(registry, input.workDir || registry.workspace.path);
}

export function productRegistrySha256(registry: ProductProjectRegistry): string {
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object") {
      const object = value as Record<string, unknown>;
      return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
  };
  return createHash("sha256").update(canonical(registry)).digest("hex");
}
