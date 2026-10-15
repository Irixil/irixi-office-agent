import "dotenv/config";
import { resolve, dirname, isAbsolute } from "path";
import { fileURLToPath } from "url";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import { homedir } from "os";
import { randomBytes } from "crypto";
import { loadMacTrialConfig } from "./mac-trial-guard.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const isDev = process.env.NODE_ENV === "development";
export const AI_EXECUTION_DISABLED = process.env.OPEN_OFFICE_DISABLE_AI === "1";
export const MAC_TRIAL_CONFIG = loadMacTrialConfig();
export const MAC_TRIAL_MODE = MAC_TRIAL_CONFIG !== null;
export const PRODUCT_MODE = Boolean(process.env.OPEN_OFFICE_PRODUCT_REGISTRY_FILE?.trim());
export const LOCAL_ONLY_TRIAL = AI_EXECUTION_DISABLED || MAC_TRIAL_MODE || PRODUCT_MODE;
const configuredStateRoot = process.env.OPEN_OFFICE_CONFIG_DIR?.trim();
if (configuredStateRoot && !isAbsolute(configuredStateRoot)) {
  throw new Error("OPEN_OFFICE_CONFIG_DIR must be an absolute path");
}
if ((AI_EXECUTION_DISABLED || PRODUCT_MODE) && !configuredStateRoot) {
  throw new Error("OPEN_OFFICE_CONFIG_DIR is required for isolated local product execution");
}
export const CONFIG_DIR = configuredStateRoot
  ? resolve(configuredStateRoot)
  : resolve(homedir(), isDev ? ".open-office-dev" : ".open-office");
const CONFIG_FILE = resolve(CONFIG_DIR, "config.json");


interface SavedConfig {
  ablyApiKey?: string;
  /** @deprecated Use telegramBotToken (singular) */
  telegramBotTokens?: (string | null)[];
  telegramBotToken?: string;
  telegramAllowedUsers?: string[];
  detectedBackends?: string[];
  defaultBackend?: string;
  /** Default model per backend (e.g. { "claude": "opus", "gemini": "gemini-2.5-pro" }) */
  defaultModels?: Record<string, string>;
  sandboxMode?: "full" | "safe";
  worktreeEnabled?: boolean;
  autoMergeEnabled?: boolean;
  tunnelBaseUrl?: string;
  tunnelToken?: string;
}

function ensureConfigDir() {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}


function loadSavedConfig(): SavedConfig {
  if (!existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
  } catch {
    return {};
  }
}

export function saveConfig(cfg: SavedConfig) {
  ensureConfigDir();
  const existing = loadSavedConfig();
  const merged = { ...existing, ...cfg };
  // Remove keys explicitly set to undefined (e.g. clearing legacy fields)
  for (const [k, v] of Object.entries(merged)) {
    if (v === undefined) delete (merged as Record<string, unknown>)[k];
  }
  writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), "utf-8");
}

export function hasSetupRun(): boolean {
  return existsSync(CONFIG_FILE);
}

function getOrCreateMachineId(): string {
  ensureConfigDir();
  const idFile = resolve(CONFIG_DIR, "machine-id");

  if (existsSync(idFile)) {
    return readFileSync(idFile, "utf-8").trim();
  }

  const id = `mac-${randomBytes(4).toString("hex")}`;
  writeFileSync(idFile, id, "utf-8");
  console.log(`[Config] Generated machine ID: ${id}`);
  return id;
}

function resolveWebDir(): string {
  if (process.env.WEB_DIR) return process.env.WEB_DIR;
  // Bundled mode: dist/web (next to dist/index.js)
  const bundled = resolve(__dirname, "web");
  if (existsSync(resolve(bundled, "index.html"))) return bundled;
  // Dev mode: apps/web/out (relative to apps/gateway/src/)
  return resolve(__dirname, "../../web/out");
}

function ensureGitRepo(dir: string) {
  try {
    execSync("git rev-parse --is-inside-work-tree", { cwd: dir, stdio: "ignore", timeout: 3000 });
  } catch {
    try {
      execSync("git init", { cwd: dir, stdio: "pipe", timeout: 3000 });
      execSync('git -c user.name=OpenOffice -c user.email=bot@open-office.local commit --allow-empty -m init', { cwd: dir, stdio: "pipe", timeout: 3000 });
      console.log(`[Config] Initialized git repo in ${dir}`);
    } catch { /* ignore */ }
  }
}

function resolveDefaultWorkspace(): string {
  if (isDev) {
    // Dev mode: use ~/.open-office-dev/projects/ (outside git repo so Claude Code
    // doesn't resolve to the source tree as its working directory)
    const ws = resolve(CONFIG_DIR, "projects");
    if (!existsSync(ws)) {
      mkdirSync(ws, { recursive: true });
      console.log(`[Config] Created default workspace: ${ws}`);
    }
    ensureGitRepo(ws);
    return ws;
  }
  // Published mode: use the directory where the user ran the command
  // Tauri sidecar runs with cwd="/", fall back to ~/.open-office/projects/
  const cwd = process.cwd();
  if (cwd === "/" || cwd === "C:\\") {
    const ws = resolve(CONFIG_DIR, "projects");
    if (!existsSync(ws)) {
      mkdirSync(ws, { recursive: true });
      console.log(`[Config] Created default workspace: ${ws}`);
    }
    ensureGitRepo(ws);
    return ws;
  }
  return cwd;
}

/**
 * Resolve a stable gateway instance ID.
 * - GATEWAY_ID env var takes precedence (e.g. Tauri sets "desktop")
 * - Falls back to "port-{wsPort}" so different ports auto-isolate
 *
 * Each gateway instance gets its own state directory under
 * ~/.open-office[-dev]/data/instances/{gatewayId}/ to prevent cross-instance
 * context contamination (e.g. Tauri vs Web vs CLI all running separately).
 */
function resolveGatewayId(): string {
  if (process.env.GATEWAY_ID) return process.env.GATEWAY_ID;
  const port = Number(process.env.WS_PORT) || 9090;
  return `port-${port}`;
}

function resolveInstanceDir(gatewayId: string): string {
  const dir = resolve(CONFIG_DIR, "data", "instances", gatewayId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function buildConfig() {
  ensureConfigDir();
  const saved = loadSavedConfig();
  const gatewayId = resolveGatewayId();
  const instanceDir = resolveInstanceDir(gatewayId);
  return {
    machineId: getOrCreateMachineId(),
    /** Unique identifier for this gateway instance (isolates state from other instances) */
    gatewayId,
    /** Per-instance state directory: ~/.open-office[-dev]/data/instances/{gatewayId}/ */
    instanceDir,
    defaultWorkspace: (() => {
      if (MAC_TRIAL_CONFIG) return MAC_TRIAL_CONFIG.workspace;
      const envWs = process.env.WORKSPACE;
      if (AI_EXECUTION_DISABLED && (!envWs || !isAbsolute(envWs) || !existsSync(envWs))) {
        throw new Error("WORKSPACE must be an existing absolute path when AI execution is disabled");
      }
      if (envWs && existsSync(envWs)) return envWs;
      if (envWs) console.log(`[Config] WORKSPACE="${envWs}" does not exist, using default`);
      return resolveDefaultWorkspace();
    })(),
    wsPort: Number(process.env.WS_PORT) || (isDev ? 9099 : 9090),
    ablyApiKey: LOCAL_ONLY_TRIAL ? undefined : process.env.ABLY_API_KEY || saved.ablyApiKey || undefined,
    webDir: resolveWebDir(),
    telegramBotToken: LOCAL_ONLY_TRIAL ? undefined :
      process.env.TELEGRAM_BOT_TOKEN
      || saved.telegramBotToken
      || (process.env.TELEGRAM_BOT_TOKENS?.split(",")[0]?.trim())
      || (saved.telegramBotTokens?.[0] ?? undefined)
      || undefined,
    telegramAllowedUsers: LOCAL_ONLY_TRIAL ? [] : (
      process.env.TELEGRAM_ALLOWED_USERS
        ? process.env.TELEGRAM_ALLOWED_USERS.split(",").map((s) => s.trim()).filter(Boolean)
        : saved.telegramAllowedUsers ?? []
    ),
    detectedBackends: MAC_TRIAL_MODE ? ["codex"] : saved.detectedBackends ?? [],
    defaultBackend: MAC_TRIAL_MODE ? "codex" : saved.defaultBackend ?? "claude",
    defaultModels: MAC_TRIAL_CONFIG ? { codex: MAC_TRIAL_CONFIG.model } : saved.defaultModels ?? { claude: "opus" },
    sandboxMode: (LOCAL_ONLY_TRIAL ? "safe" : saved.sandboxMode ?? "safe") as "full" | "safe",
    worktreeEnabled: LOCAL_ONLY_TRIAL ? false : saved.worktreeEnabled ?? true,
    autoMergeEnabled: LOCAL_ONLY_TRIAL ? false : saved.autoMergeEnabled ?? true,
    tunnelBaseUrl: LOCAL_ONLY_TRIAL ? undefined : (process.env.TUNNEL_BASE_URL || saved.tunnelBaseUrl || "").replace(/\/+$/, "") || undefined,
    tunnelToken: LOCAL_ONLY_TRIAL ? undefined : process.env.TUNNEL_TOKEN || saved.tunnelToken || undefined,
  };
}

export const config = buildConfig();

/** Reload config from saved file (after setup wizard) */
export function reloadConfig() {
  const fresh = buildConfig();
  Object.assign(config, fresh);
}
