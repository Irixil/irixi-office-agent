import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { CommandSchema } from "@office/shared";
import type { GatewayEvent, Command, UserRole } from "@office/shared";
import { config, AI_EXECUTION_DISABLED, MAC_TRIAL_MODE } from "./config.js";
import { previewServer } from "@bit-office/orchestrator";
import { networkInterfaces, homedir } from "os";
import { readFile, stat, lstat, realpath } from "fs/promises";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, extname, resolve } from "path";
import * as Ably from "ably";
import type { Channel, CommandMeta } from "./transport.js";
import { writePortLock } from "./runtime-state.js";
import { nanoid } from "nanoid";
import { createHash } from "node:crypto";
import { createIrixiIntegration } from "./irixi-integration.js";
import { beginProductPreview, clearProductPreview, finishProductPreview, getProductPreviewContext, loadProductProjectRegistry, productPreviewMatches, productProjectRegistryEnabled } from "./product-project-registry.js";
import { readSmallJson } from "./json-body.js";
import { clientStateErrorStatus } from "./client-state-http.js";
import { prepareNativePrompt } from "../../../packages/orchestrator/src/native-prompt-budget.js";

/**
 * Detect requests arriving through Cloudflare Tunnel.
 * Cloudflare injects CF-Connecting-IP on every proxied request.
 */
function isTunnelRequest(req: IncomingMessage): boolean {
  return !!(req.headers["cf-connecting-ip"] || req.headers["cf-ray"]);
}

let wss: WebSocketServer | null = null;
const clients = new Map<WebSocket, { role: UserRole; clientId: string }>();
let pairCode: string | null = null;
let onCommand: ((cmd: Command, meta: CommandMeta) => void) | null = null;
type ProductRuntimeView = { phase: string | null; leadAgentId: string | null; plan?: { text: string; sha256: string } | null };
let productRuntimeViewProvider: (() => ProductRuntimeView) | null = null;

export function shouldStartFreshProductPlan(state: any): boolean {
  return state?.current === true
    && state?.product?.bindingCurrent === true
    && state?.execution?.phase === "planned"
    && state?.native?.actions?.canRun === true
    && state?.native?.phase !== "create"
    && state?.native?.plan == null
    && Array.isArray(state?.native?.sessions)
    && state.native.sessions.length === 0;
}

export function setProductRuntimeViewProvider(provider: (() => ProductRuntimeView) | null) {
  productRuntimeViewProvider = provider;
}

// In-memory share token store: token → { role } (for public share links)
const shareTokens = new Map<string, { role: "collaborator" | "spectator" }>();

// Session tokens — persisted to disk so they survive gateway restarts
// Instance-scoped to prevent cross-instance auth token leakage
function getSessionTokensFile(): string { return resolve(config.instanceDir, "session-tokens.json"); }

function loadSessionTokens(): Map<string, UserRole> {
  try {
    const f = getSessionTokensFile();
    if (existsSync(f)) {
      const data = JSON.parse(readFileSync(f, "utf-8"));
      return new Map(Object.entries(data) as [string, UserRole][]);
    }
  } catch { /* corrupt file, start fresh */ }
  return new Map();
}

function persistSessionTokens() {
  const dir = resolve(config.instanceDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(getSessionTokensFile(), JSON.stringify(Object.fromEntries(sessionTokens)), "utf-8");
}

const sessionTokens = loadSessionTokens();

function addSessionToken(token: string, role: UserRole) {
  sessionTokens.set(token, role);
  persistSessionTokens();
}

// Pending WS connections awaiting AUTH
const pendingAuth = new Set<WebSocket>();
const AUTH_TIMEOUT_MS = 5000;
export const irixiPublicIntegration = createIrixiIntegration();

function isSameOriginRequest(req: IncomingMessage): boolean {
  if (!req.headers.origin) return true;
  try { return new URL(req.headers.origin).host === req.headers.host; }
  catch { return false; }
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".webp": "image/webp",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".txt": "text/plain",
  ".map": "application/json",
  ".webmanifest": "application/manifest+json",
};

export function setPairCode(code: string) {
  pairCode = code;
}

/** Send an event to a specific client by clientId (unicast) */
export function sendToClient(clientId: string, event: GatewayEvent) {
  const data = JSON.stringify(event);
  for (const [ws, info] of clients) {
    if (info.clientId === clientId && ws.readyState === WebSocket.OPEN) {
      ws.send(data);
      return;
    }
  }
}

export const wsChannel: Channel = {
  name: "WebSocket",

  async init(commandHandler: (cmd: Command, meta: CommandMeta) => void): Promise<boolean> {
    onCommand = commandHandler;

    return new Promise((promiseResolve) => {
      const requestHandler = async (req: IncomingMessage, res: ServerResponse) => {
        const productHttpPath = req.url === "/api/irixi-authority" || req.url === "/api/product-state"
          || req.url?.startsWith("/api/product/") || req.url?.startsWith("/api/irixi-authority/");
        // Product authority state and actions are local same-origin
        // capabilities. Legacy endpoints keep their existing CORS behavior.
        if (!productHttpPath) res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");

        if (req.method === "OPTIONS") {
          if (productHttpPath && !isSameOriginRequest(req)) { res.writeHead(403); res.end(); return; }
          res.writeHead(204);
          res.end();
          return;
        }

        if (req.method === "GET" && (req.url === "/api/irixi-authority" || req.url === "/api/product-state")) {
          if ((!MAC_TRIAL_MODE && !productProjectRegistryEnabled()) || !irixiPublicIntegration || isTunnelRequest(req) || !isSameOriginRequest(req)) {
            res.writeHead(404, { "Content-Type": "application/json", "Cache-Control": "no-store" });
            res.end(JSON.stringify({ error: "Irixi authority is not enabled" }));
            return;
          }
          try {
            const authority = await irixiPublicIntegration.publicProjection();
            const runtimeView = productRuntimeViewProvider?.() || { phase: null, leadAgentId: null };
            const publicAuthority: any = {
              ...authority,
              mode: AI_EXECUTION_DISABLED ? "zero_model_development" : "native_product",
              aiEnabled: !AI_EXECUTION_DISABLED,
              native: authority.native ? { ...authority.native, aiEnabled: !AI_EXECUTION_DISABLED, phase: runtimeView.phase,
                plan: runtimeView.plan || null, actions: {
                ...authority.native.actions,
                phase: runtimeView.phase,
                aiEnabled: !AI_EXECUTION_DISABLED,
                canRun: !AI_EXECUTION_DISABLED && authority.native.actions?.canRun === true,
                canReview: !AI_EXECUTION_DISABLED && authority.native.actions?.canReview === true,
                canResume: !AI_EXECUTION_DISABLED && authority.native.actions?.canResume === true,
                canContinue: !AI_EXECUTION_DISABLED && authority.native.actions?.canResume === true,
                canChat: !AI_EXECUTION_DISABLED && authority.native.actions?.canChat === true,
                canGoal: authority.product?.bindingCurrent === true,
                canInstructions: authority.product?.bindingCurrent === true,
                canMaterials: authority.product?.bindingCurrent === true,
                canApprovePlan: !AI_EXECUTION_DISABLED && runtimeView.phase === "design"
                  && runtimeView.leadAgentId === authority.native.runAgentId && Boolean(runtimeView.plan),
                blockedReason: AI_EXECUTION_DISABLED ? "zero_model_development_mode" : null,
              } } : null,
            };
            const previewContext = getProductPreviewContext();
            const previewMatches = productPreviewMatches(previewContext, authority);
            if (previewContext && !previewMatches) clearProductPreview();
            publicAuthority.preview = previewMatches ? {
              status: previewContext.status, taskId: previewContext.taskId, goalVersionId: previewContext.goalVersionId,
              executionId: previewContext.executionId, registrySha256: previewContext.registrySha256,
              artifactId: previewContext.artifactId, artifactVersion: previewContext.artifactVersion,
              entry: previewContext.entry,
              candidateSha256: previewContext.candidateSha256,
              ...(previewContext.status === "failed" ? { error: previewContext.error || "Preview preparation failed" } : {}),
            } : null;
            publicAuthority.previewLink = previewMatches && previewContext.status === "ready"
              ? "/product-preview/" + encodeURIComponent(previewContext.token) + "/" + previewContext.entry.split("/").map(encodeURIComponent).join("/")
              : null;
            res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
            res.end(JSON.stringify({ ...publicAuthority, links: {
              nativeTask: `/native?taskId=${encodeURIComponent(authority.taskId)}`,
              actions: `/api/product/tasks/${encodeURIComponent(authority.taskId)}/actions`,
              candidate: "/api/product/candidate",
              confirm: "/api/irixi-authority/confirm",
              patch: "/api/irixi-authority/patch",
            } }));
          } catch {
            res.writeHead(409, { "Content-Type": "application/json", "Cache-Control": "no-store" });
            res.end(JSON.stringify({ error: "Current Irixi authority is unavailable or stale" }));
          }
          return;
        }

        if (req.method === "GET" && req.url === "/api/product/candidate") {
          if (!productProjectRegistryEnabled() || !irixiPublicIntegration || isTunnelRequest(req) || !isSameOriginRequest(req)) {
            res.writeHead(404, { "Content-Type": "application/json", "Cache-Control": "no-store" });
            res.end(JSON.stringify({ error: "Product candidate is unavailable" }));
            return;
          }
          try {
            const candidate = await irixiPublicIntegration.productCandidate();
            res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
            res.end(JSON.stringify(candidate));
          } catch (error) {
            res.writeHead(409, { "Content-Type": "application/json", "Cache-Control": "no-store" });
            res.end(JSON.stringify({ error: error instanceof Error ? error.message : "Current product candidate is unavailable" }));
          }
          return;
        }

        const productAction = req.url?.match(/^\/api\/product\/tasks\/([^/]+)\/actions$/);
        if (req.method === "POST" && productAction) {
          if (!productProjectRegistryEnabled() || !irixiPublicIntegration || !onCommand || isTunnelRequest(req) || !isSameOriginRequest(req)) {
            res.writeHead(404, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify({ error: "Product task actions are unavailable" })); return;
          }
          let productPreviewToken: string | null = null;
          try {
            if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers["content-type"] || ""))) throw new Error("Content-Type must be application/json");
            const taskId = decodeURIComponent(productAction[1]);
            const input = await readSmallJson(req, 4 * 1024 * 1024) as Record<string, unknown>;
            const actionAliases: Record<string, string> = { instructions: "support", materials: "material", chat: "converse", continue: "resume" };
            if (typeof input.action === "string" && actionAliases[input.action]) input.action = actionAliases[input.action];
            const publicAction = typeof input.action === "string"
              ? ({ support: "instructions", material: "materials", converse: "chat", resume: "continue" } as Record<string, string>)[input.action] || input.action
              : input.action;
            const state = await irixiPublicIntegration.publicProjection();
            if (state.taskId !== taskId || !state.current || !state.product?.bindingCurrent || !state.execution?.id) throw new Error("Product task binding is stale");
            if (input.expectedGoalVersionId !== state.goalVersionId
              || input.expectedExecutionId !== state.execution?.id
              || input.expectedRegistrySha256 !== state.product.registrySha256) {
              throw new Error("Product action was prepared for an older goal, execution, input, pipeline, or workspace binding");
            }
            const agentId = typeof input.agentId === "string" ? input.agentId : "";
            let command: Command;
            if (input.action === "run") {
              if (AI_EXECUTION_DISABLED) throw new Error("Native AI execution is disabled in the zero-model development launcher");
              const runAgentId = state.native?.runAgentId;
              if (!runAgentId || !state.registeredExecution?.promptSha256 || state.native?.actions?.canRun !== true) throw new Error("Current registered execution or native Lead is unavailable");
              const execution = await irixiPublicIntegration.executionPrompt();
              if (execution.promptSha256 !== state.registeredExecution.promptSha256) throw new Error("Current registered execution prompt changed");
              command = CommandSchema.parse({ type: "RUN_TASK", agentId: runAgentId, taskId: `product-${nanoid(16)}`, prompt: execution.prompt,
                ...(shouldStartFreshProductPlan(state) ? { nativeProductPlanStart: true } : {}) });
            } else if (input.action === "pause") {
              await irixiPublicIntegration.pauseProductExecution({ expectedGoalVersionId: state.goalVersionId,
                expectedExecutionId: state.execution.id, expectedRegistrySha256: state.product.registrySha256 });
              for (const agent of state.team.agents) if (agent?.id) onCommand(CommandSchema.parse({ type: "CANCEL_TASK", agentId: agent.id, taskId: `product-pause-${state.execution.id}` }), { role: "owner", clientId: `product-http:${nanoid(8)}` });
              res.writeHead(202, { "Content-Type": "application/json", "Cache-Control": "no-store" });
              res.end(JSON.stringify({ accepted: true, taskId, action: "pause", stoppedAgentIds: state.team.agents.map((entry: any) => entry.id).filter(Boolean) }));
              return;
            } else if (input.action === "cancel") {
              if (!state.execution?.id) throw new Error("Current execution is required");
              await irixiPublicIntegration.cancelProductExecution({ expectedGoalVersionId: state.goalVersionId,
                expectedExecutionId: state.execution.id, expectedRegistrySha256: state.product.registrySha256 });
              for (const agent of state.team.agents) if (agent?.id) onCommand(CommandSchema.parse({ type: "CANCEL_TASK", agentId: agent.id, taskId: `product-cancel-${state.execution.id}` }), { role: "owner", clientId: `product-http:${nanoid(8)}` });
              res.writeHead(202, { "Content-Type": "application/json", "Cache-Control": "no-store" });
              res.end(JSON.stringify({ accepted: true, taskId, action: "cancel", stoppedAgentIds: state.team.agents.map((entry: any) => entry.id).filter(Boolean) }));
              return;
            } else if (input.action === "goal") {
              if (typeof input.statement !== "string" || !Array.isArray(input.successCriteria) || !Array.isArray(input.boundaries)) throw new Error("Goal statement, success criteria, and boundaries are required");
              await irixiPublicIntegration.replaceProductGoal({ expectedGoalVersionId: state.goalVersionId,
                expectedExecutionId: state.execution.id, expectedRegistrySha256: state.product.registrySha256, statement: input.statement,
                successCriteria: input.successCriteria.map(String), boundaries: input.boundaries.map(String) });
              res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
              res.end(JSON.stringify({ accepted: true, taskId, action: "goal" }));
              return;
            } else if (input.action === "support") {
              if (typeof input.text !== "string") throw new Error("Instruction text is required");
              const result = await irixiPublicIntegration.addProductInstruction({ expectedGoalVersionId: state.goalVersionId,
                expectedExecutionId: state.execution.id, expectedRegistrySha256: state.product.registrySha256, text: input.text });
              res.writeHead(201, { "Content-Type": "application/json", "Cache-Control": "no-store" });
              res.end(JSON.stringify({ accepted: true, taskId, action: publicAction, ...result }));
              return;
            } else if (input.action === "converse") {
              if (typeof input.text !== "string") throw new Error("Conversation text is required");
              const requestedAgentId = typeof input.agentId === "string" ? input.agentId : state.native?.runAgentId;
              const conversationAgent = state.team.agents.find((entry: any) => entry.id === requestedAgentId);
              if (!conversationAgent?.id) throw new Error("The selected native conversation agent is unavailable");
              const saved = await irixiPublicIntegration.addProductConversation({ expectedGoalVersionId: state.goalVersionId,
                expectedExecutionId: state.execution.id, expectedRegistrySha256: state.product.registrySha256,
                agentId: conversationAgent.id, text: input.text });
              if (AI_EXECUTION_DISABLED) throw Object.assign(new Error("Conversation was saved, but the development launcher has AI disabled; no assistant model was started"), { saved });
              if (state.native?.actions?.canChat !== true) throw new Error("Current execution budget, deadline, or stop state does not allow another native conversation");
              const registeredContext = await irixiPublicIntegration.executionPrompt();
              if (registeredContext.promptSha256 !== state.registeredExecution?.promptSha256) throw new Error("Current registered execution prompt changed before conversation");
              command = CommandSchema.parse({ type: "RUN_TASK", agentId: conversationAgent.id, taskId: `product-conversation-${nanoid(16)}`,
                prompt: `IRIXI_PRODUCT_CONVERSATION_V1\nYou are ${conversationAgent.name || conversationAgent.role || conversationAgent.id}, the selected current native teammate. Answer the user's question about the registered task in read-only conversation mode. Do not modify files, run tools that write, review a candidate, or claim work was completed.\n\nCurrent registered task context (read-only):\n${registeredContext.prompt}\n\nUser: ${input.text}` });
            } else if (input.action === "material") {
              if (typeof input.name !== "string" || typeof input.text !== "string") throw new Error("Material name and text are required");
              const result = await irixiPublicIntegration.addProductMaterial({ expectedGoalVersionId: state.goalVersionId,
                expectedExecutionId: state.execution.id, expectedRegistrySha256: state.product.registrySha256,
                name: input.name, kind: typeof input.kind === "string" ? input.kind : "text", text: input.text });
              res.writeHead(201, { "Content-Type": "application/json", "Cache-Control": "no-store" });
              res.end(JSON.stringify({ accepted: true, taskId, action: publicAction, ...result }));
              return;
            } else if (input.action === "revise") {
              const artifact = state.artifact;
              if (!artifact || input.expectedArtifactId !== artifact.id || input.expectedArtifactVersion !== artifact.version
                || state.native?.actions?.canRevise !== true) throw new Error("Revision request candidate version is not current or is already confirmed");
              if (typeof input.reason !== "string" || !input.reason.trim() || input.reason !== input.reason.trim() || input.reason.length > 2_000) {
                throw new Error("Revision reason must be exact non-empty text within 2000 characters");
              }
              const result = await irixiPublicIntegration.addProductInstruction({ expectedGoalVersionId: state.goalVersionId,
                expectedExecutionId: state.execution.id, expectedRegistrySha256: state.product.registrySha256,
                expectedArtifactId: artifact.id, expectedArtifactVersion: artifact.version, text: input.reason });
              res.writeHead(201, { "Content-Type": "application/json", "Cache-Control": "no-store" });
              res.end(JSON.stringify({ accepted: true, taskId, action: "revise", artifactId: artifact.id,
                artifactVersion: artifact.version, requiresReprepare: true, ...result }));
              return;
            } else if (input.action === "resume") {
              if (AI_EXECUTION_DISABLED) throw new Error("Native AI execution is disabled in the zero-model development launcher");
              if (state.native?.actions?.resumeReason === "saved_lead_plan_same_execution_budget_and_deadline") {
                throw new Error("The saved Lead plan must be explicitly approved; do not repeat planning");
              }
              await irixiPublicIntegration.resumeProductExecution({ expectedGoalVersionId: state.goalVersionId,
                expectedExecutionId: state.execution.id, expectedRegistrySha256: state.product.registrySha256 });
              const runAgentId = state.native?.runAgentId;
              if (!runAgentId) throw new Error("Current native Lead is unavailable");
              const execution = await irixiPublicIntegration.executionPrompt();
              command = CommandSchema.parse({ type: "RUN_TASK", agentId: runAgentId, taskId: `product-resume-${nanoid(16)}`, prompt: execution.prompt });
            } else if (input.action === "review") {
              if (AI_EXECUTION_DISABLED) throw new Error("Native AI execution is disabled in the zero-model development launcher");
              const artifact = state.artifact;
              if (!artifact || input.expectedArtifactId !== artifact.id || input.expectedArtifactVersion !== artifact.version) {
                throw new Error("Review candidate version is not current");
              }
              const reviewer = state.team.agents.find((entry: any) => String(entry.role || entry.roleKey || "").toLowerCase().includes("review"));
              if (!reviewer?.id) throw new Error("No registered independent Reviewer is available");
              const review = await irixiPublicIntegration.productReviewRequest({
                expectedGoalVersionId: state.goalVersionId,
                expectedExecutionId: state.execution.id,
                expectedRegistrySha256: state.product.registrySha256,
                expectedArtifactId: artifact.id,
                expectedArtifactVersion: artifact.version,
              });
              command = CommandSchema.parse({ type: "RUN_TASK", agentId: reviewer.id, taskId: `product-review-${nanoid(16)}`, prompt: review.prompt });
            } else if (input.action === "approve_plan") {
              if (AI_EXECUTION_DISABLED) throw new Error("Native AI execution is disabled in the zero-model development launcher");
              const runtimeView = productRuntimeViewProvider?.() || { phase: null, leadAgentId: null };
              if (runtimeView.phase !== "design" || !runtimeView.leadAgentId
                || runtimeView.leadAgentId !== state.native?.runAgentId || !runtimeView.plan
                || input.expectedPlanSha256 !== runtimeView.plan.sha256) {
                throw new Error("The current Lead has no plan awaiting explicit approval");
              }
              if (state.execution?.stopReason) {
                if (state.native?.actions?.resumeReason !== "saved_lead_plan_same_execution_budget_and_deadline") {
                  throw new Error("The saved Lead plan cannot resume this stopped execution");
                }
                const failedLeadSession = [...(state.native?.sessions || [])].reverse().find((entry: any) => entry.role === "lead" && entry.status === "failed");
                if (!failedLeadSession?.sourceTaskId || !failedLeadSession?.attemptId) throw new Error("The saved Lead plan has no failed current Lead reservation");
                await irixiPublicIntegration.recoverProductLeadPlan({ expectedGoalVersionId: state.goalVersionId,
                  expectedExecutionId: state.execution.id, expectedRegistrySha256: state.product.registrySha256,
                  expectedSourceTaskId: failedLeadSession.sourceTaskId, expectedNativeAttemptId: failedLeadSession.attemptId,
                  expectedPlanSha256: runtimeView.plan.sha256, planText: runtimeView.plan.text });
              }
              if (!state.execution?.id || !state.product?.registrySha256 || !state.registeredExecution?.promptSha256) {
                throw new Error("Current execution binding is unavailable for plan approval");
              }
              const execution = await irixiPublicIntegration.executionPrompt();
              if (execution.promptSha256 !== state.registeredExecution.promptSha256) {
                throw new Error("Current registered execution prompt changed before plan approval");
              }
              command = CommandSchema.parse({ type: "APPROVE_PLAN", agentId: runtimeView.leadAgentId,
                productApprovalContext: {
                  taskId, goalVersionId: state.goalVersionId, executionId: state.execution.id,
                  registrySha256: state.product.registrySha256, planSha256: runtimeView.plan.sha256,
                  executionPrompt: execution.prompt, executionPromptSha256: execution.promptSha256,
                } });
            } else if (input.action === "preview") {
              const artifact = state.artifact;
              const execution = state.execution;
              if (!artifact || !execution || !artifact.candidateSha256
                || input.expectedArtifactId !== artifact.id || input.expectedArtifactVersion !== artifact.version
                || input.expectedCandidateSha256 !== artifact.candidateSha256
                || input.expectedGoalVersionId !== state.goalVersionId
                || input.expectedExecutionId !== execution.id
                || input.expectedRegistrySha256 !== state.product.registrySha256
                || typeof input.entry !== "string" || !state.product.capabilities.staticPreviewEntries.includes(input.entry)
                || !state.product.capabilities.staticPreviewFiles.includes(input.entry)) {
                throw new Error("Static preview entry or candidate version is not current");
              }
              const binding = {
                taskId, goalVersionId: state.goalVersionId, executionId: execution.id,
                registrySha256: state.product.registrySha256, artifactId: artifact.id,
                artifactVersion: artifact.version, candidateSha256: artifact.candidateSha256,
                token: nanoid(32), entry: input.entry,
              };
              command = CommandSchema.parse({ type: "SERVE_PREVIEW", filePath: input.entry, productPreview: binding });
              const authorized = await irixiPublicIntegration.authorizeStaticPreview({ ...binding, file: input.entry });
              beginProductPreview({ ...binding, root: authorized.root, entryAbsolute: authorized.entry, status: "pending" });
              productPreviewToken = binding.token;
            } else {
              throw new Error("Supported actions are run, approve_plan, pause, cancel, goal, instructions, chat, materials, continue, review, revise, and preview");
            }
            onCommand(command, { role: "owner", clientId: `product-http:${nanoid(8)}` });
            res.writeHead(202, { "Content-Type": "application/json", "Cache-Control": "no-store" });
            res.end(JSON.stringify({ accepted: true, taskId, action: publicAction, commandType: command.type }));
          } catch (error) {
            if (productPreviewToken) finishProductPreview(productPreviewToken, "failed", error instanceof Error ? error.message : "Preview command could not be queued");
            res.writeHead(409, { "Content-Type": "application/json", "Cache-Control": "no-store" });
            res.end(JSON.stringify({ error: error instanceof Error ? error.message : "Product action rejected",
              ...((error as any)?.saved ? { conversation: (error as any).saved } : {}) }));
          }
          return;
        }

        if (req.method === "POST" && req.url === "/api/irixi-authority/confirm") {
          if ((!MAC_TRIAL_MODE && !productProjectRegistryEnabled()) || !irixiPublicIntegration || isTunnelRequest(req) || !isSameOriginRequest(req)) {
            res.writeHead(404, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify({ error: "Irixi authority is not enabled" })); return;
          }
          try {
            if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers["content-type"] || ""))) throw new Error("Content-Type must be application/json");
            const input = await readSmallJson(req);
            const value = await irixiPublicIntegration.confirmCurrentArtifact(input.artifactId, input.version);
            res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(value));
          } catch (error) {
            res.writeHead(409, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify({ error: error instanceof Error ? error.message : "Irixi confirmation failed" }));
          }
          return;
        }

        if (req.method === "GET" && req.url?.startsWith("/api/irixi-authority/patch?")) {
          if ((!MAC_TRIAL_MODE && !productProjectRegistryEnabled()) || !irixiPublicIntegration || isTunnelRequest(req) || !isSameOriginRequest(req)) {
            res.writeHead(404, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify({ error: "Irixi authority is not enabled" })); return;
          }
          try {
            const url = new URL(req.url, "http://127.0.0.1");
            const value = await irixiPublicIntegration.downloadCurrentPatch(url.searchParams.get("artifactId") || "", url.searchParams.get("approvalId") || "");
            res.writeHead(200, { "Content-Type": value.contentType, "Content-Disposition": value.contentDisposition, "Content-Length": value.bytes.length, "X-Content-Sha256": value.sha256, "Cache-Control": "no-store" }); res.end(value.bytes);
          } catch (error) {
            res.writeHead(409, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify({ error: error instanceof Error ? error.message : "Irixi patch download failed" }));
          }
          return;
        }

        if ((req.method === "GET" || req.method === "POST") && req.url?.startsWith("/api/irixi-intake")) {
          const productIntakeRead = productProjectRegistryEnabled() && req.method === "GET" && req.url === "/api/irixi-intake";
          if ((!MAC_TRIAL_MODE && !productIntakeRead) || !irixiPublicIntegration || isTunnelRequest(req) || !isSameOriginRequest(req)) {
            res.writeHead(404, { "Content-Type": "application/json", "Cache-Control": "no-store" });
            res.end(JSON.stringify({ error: "Irixi project intake is not enabled" }));
            return;
          }
          try {
            let value: unknown;
            if (req.method === "GET" && req.url === "/api/irixi-intake") value = await irixiPublicIntegration.publicIntake();
            else if (req.method === "POST" && (req.url === "/api/irixi-intake/open-discussion" || req.url === "/api/irixi-intake/close-discussion")) {
              if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers["content-type"] || ""))) throw new Error("Content-Type must be application/json");
              await readSmallJson(req);
              value = await irixiPublicIntegration.setIntakeDiscussionEnabled(req.url.endsWith("/open-discussion"));
            }
            else if (req.method === "POST" && req.url === "/api/irixi-intake/message") {
              if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers["content-type"] || ""))) throw new Error("Content-Type must be application/json");
              const input = await readSmallJson(req);
              value = await irixiPublicIntegration.beginIntake(input.concept);
            } else if (req.method === "POST" && req.url === "/api/irixi-intake/confirm") {
              if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers["content-type"] || ""))) throw new Error("Content-Type must be application/json");
              value = await irixiPublicIntegration.confirmIntake(await readSmallJson(req));
            } else if (req.method === "POST" && req.url === "/api/irixi-intake/select-scope") {
              if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers["content-type"] || ""))) throw new Error("Content-Type must be application/json");
              value = await irixiPublicIntegration.selectIntakeScope((await readSmallJson(req)).expectedGoalVersionId);
            } else if (req.method === "POST" && req.url === "/api/irixi-intake/authorize-scope") {
              if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers["content-type"] || ""))) throw new Error("Content-Type must be application/json");
              value = await irixiPublicIntegration.authorizeIntakeScope((await readSmallJson(req)).expectedGoalVersionId);
            } else if (req.method === "POST" && req.url === "/api/irixi-intake/start-new-batch") {
              if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers["content-type"] || ""))) throw new Error("Content-Type must be application/json");
              value = await irixiPublicIntegration.startNewIntakeBatch((await readSmallJson(req)).expectedGoalVersionId);
            } else if (req.method === "POST" && req.url === "/api/irixi-intake/open-repair-batch") {
              if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers["content-type"] || ""))) throw new Error("Content-Type must be application/json");
              value = await irixiPublicIntegration.openRepairBatch(await readSmallJson(req) as any);
            } else if (req.method === "POST" && req.url === "/api/irixi-intake/authorize-goal-increment") {
              if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers["content-type"] || ""))) throw new Error("Content-Type must be application/json");
              value = await irixiPublicIntegration.authorizeGoalIncrement(await readSmallJson(req) as any);
            } else if (req.method === "POST" && req.url === "/api/irixi-intake/host-client-failure") {
              if (!irixiPublicIntegration) throw new Error("Irixi integration unavailable");
              value = await irixiPublicIntegration.recordHostClientFailure(await readSmallJson(req) as any);
            } else if (req.method === "POST" && req.url === "/api/irixi-intake/auto-review-dispatch-failure") {
              if (!irixiPublicIntegration) throw new Error("Irixi integration unavailable");
              value = await irixiPublicIntegration.recordAutoReviewDispatchFailure(await readSmallJson(req) as any);
            } else if (req.method === "POST" && req.url === "/api/irixi-intake/coordinate-sealed-reviewer-result") {
              if (!irixiPublicIntegration) throw new Error("Irixi integration unavailable");
              value = await irixiPublicIntegration.coordinateSealedReviewerResult(await readSmallJson(req) as any);
            } else {
              res.writeHead(404, { "Content-Type": "application/json", "Cache-Control": "no-store" });
              res.end(JSON.stringify({ error: "Not found" }));
              return;
            }
            res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
            res.end(JSON.stringify(value));
          } catch (error) {
            res.writeHead(409, { "Content-Type": "application/json", "Cache-Control": "no-store" });
            res.end(JSON.stringify({ error: error instanceof Error ? error.message : "Project intake request failed" }));
          }
          return;
        }
        if ((req.method === "GET" || req.method === "PUT") && req.url?.startsWith("/api/irixi-client-state")) {
          if ((!MAC_TRIAL_MODE && !productProjectRegistryEnabled()) || !irixiPublicIntegration || isTunnelRequest(req) || !isSameOriginRequest(req)) {
            res.writeHead(404, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify({ error: "Irixi client state is not enabled" })); return;
          }
          try {
            const url = new URL(req.url, "http://127.0.0.1");
            const value = req.method === "GET"
              ? await irixiPublicIntegration.clientState({ sessionId: url.searchParams.get("sessionId") || undefined, scope: url.searchParams.get("scope") === "project" ? "project" : undefined, historical: url.searchParams.get("historical") === "true" })
              : await irixiPublicIntegration.saveClientState(await readSmallJson(req, 64 * 1024));
            res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(value));
          } catch (error) {
            res.writeHead(clientStateErrorStatus(error), { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify({ error: error instanceof Error ? error.message : "Client-state request failed" }));
          }
          return;
        }

        if ((req.method === "GET" || req.method === "POST") && req.url?.startsWith("/api/irixi-inference")) {
          if ((!MAC_TRIAL_MODE && !productProjectRegistryEnabled()) || !irixiPublicIntegration || isTunnelRequest(req) || !isSameOriginRequest(req)) {
            res.writeHead(404, { "Content-Type": "application/json", "Cache-Control": "no-store" });
            res.end(JSON.stringify({ error: "Irixi learning inference is not enabled" })); return;
          }
          try {
            let value: unknown;
            if (req.method === "GET") {
              const url = new URL(req.url, "http://127.0.0.1");
              value = await irixiPublicIntegration.inferenceStatus(url.searchParams.get("turnId") || "");
            } else if (req.url === "/api/irixi-inference/coordinate-sealed-result") {
              if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers["content-type"] || ""))) throw new Error("Content-Type must be application/json");
              value = await irixiPublicIntegration.coordinateSealedInferenceResult(await readSmallJson(req));
            } else if (req.url === "/api/irixi-inference") {
              if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers["content-type"] || ""))) throw new Error("Content-Type must be application/json");
              const productMode = productProjectRegistryEnabled();
              if (productMode && AI_EXECUTION_DISABLED) throw new Error("Native AI execution is disabled");
              const input = await readSmallJson(req, productMode ? 1024 * 1024 : 64 * 1024);
              const runtimeView = productMode ? productRuntimeViewProvider?.() || { phase: null, leadAgentId: null } : null;
              const registeredProject = productMode ? loadProductProjectRegistry() : null;
              const agentId = productMode ? runtimeView?.leadAgentId : process.env.OPEN_OFFICE_IRIXI_INFERENCE_AGENT_ID?.trim();
              if (!agentId || !onCommand) throw new Error("Native inference agent is unavailable");
              if (productMode && !registeredProject?.workspace.path) throw new Error("Registered product inference workspace is unavailable");
              const reservation = await irixiPublicIntegration.beginInference(input);
              const nativeTaskId = reservation.sourceTaskId;
              let prompt = productMode
                ? `IRIXI_PRODUCT_CONVERSATION_V1\nYou are the registered Lead answering one article-learning request in read-only conversation mode. Do not plan or execute project work. Do not use tools, browse, edit files, or claim facts outside the supplied article and saved learning record.\n\n${reservation.prompt}`
                : reservation.prompt;
              if (productMode && registeredProject) {
                const prepared = prepareNativePrompt({
                  executionModelId: registeredProject.native.model,
                  limits: { modelId: registeredProject.native.model, contextWindowTokens: registeredProject.native.promptBudget.contextWindowTokens,
                    effectiveContextPercent: registeredProject.native.promptBudget.effectiveContextPercent },
                  reserves: { outputTokens: registeredProject.native.promptBudget.outputTokens, protocolTokens: registeredProject.native.promptBudget.protocolTokens },
                  blocks: [{ id: "article-learning-request", purpose: "article-learning-inference", content: prompt }],
                });
                if (!prepared.ok) {
                  await irixiPublicIntegration.recordInference("TASK_FAILED", reservation.sourceTaskId, prepared.reason.message);
                  throw Object.assign(new Error(prepared.reason.message), { status: 413 });
                }
                prompt = prepared.prompt;
              }
              try {
                await onCommand({ type: "RUN_TASK", agentId, taskId: nativeTaskId, prompt,
                  repoPath: registeredProject?.workspace.path || process.env.OPEN_OFFICE_IRIXI_EXECUTION_WORKSPACE }, { role: "owner", clientId: "irixi-inference" });
              } catch (error) {
                await irixiPublicIntegration.recordInference("TASK_FAILED", reservation.sourceTaskId,
                  error instanceof Error ? error.message : "Native inference dispatch failed");
                throw error;
              }
              value = { accepted: true, turnId: reservation.turnId, remaining: reservation.remaining };
            } else throw new Error("Not found");
            res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(value));
          } catch (error) {
            res.writeHead(Number((error as { status?: number })?.status) || 409, { "Content-Type": "application/json", "Cache-Control": "no-store" });
            res.end(JSON.stringify({ error: error instanceof Error ? error.message : "Irixi inference request failed" }));
          }
          return;
        }
        if (req.method === "POST" && (req.url === "/api/irixi-materials" || req.url === "/api/irixi-learning/open-batch")) {
          if ((!MAC_TRIAL_MODE && !productProjectRegistryEnabled()) || !irixiPublicIntegration || isTunnelRequest(req) || !isSameOriginRequest(req)) {
            res.writeHead(404, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify({ error: "Irixi learning API is not enabled" })); return;
          }
          try {
            if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers["content-type"] || ""))) throw new Error("Content-Type must be application/json");
            const input = await readSmallJson(req, 64 * 1024);
            const value = req.url === "/api/irixi-materials" ? await irixiPublicIntegration.registerLearningMaterial(input) : await irixiPublicIntegration.openLearningBatch(input);
            res.writeHead(201, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(value));
          } catch (error) {
            res.writeHead(409, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify({ error: error instanceof Error ? error.message : "Irixi learning request failed" }));
          }
          return;
        }

        // Quick connect — local-only, never exposed through tunnel
        if (req.method === "GET" && req.url === "/connect") {
          if (config.ablyApiKey || isTunnelRequest(req)) {
            res.writeHead(403, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Quick connect disabled" }));
            return;
          }
          const sessionToken = nanoid();
          addSessionToken(sessionToken, "owner");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            machineId: config.machineId,
            gatewayId: config.gatewayId,
            wsUrl: `ws://localhost:${config.wsPort}`,
            role: "owner",
            sessionToken,
          }));
          return;
        }

        if (req.method === "POST" && req.url === "/pair/validate") {
          let body = "";
          req.on("data", (chunk) => (body += chunk));
          req.on("end", () => {
            try {
              const { code } = JSON.parse(body);
              if (!pairCode || code !== pairCode) {
                res.writeHead(401, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Invalid pair code" }));
                return;
              }
              const sessionToken = nanoid();
              addSessionToken(sessionToken, "owner");
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({
                machineId: config.machineId,
                wsUrl: `ws://localhost:${config.wsPort}`,
                hasAbly: !!config.ablyApiKey,
                role: "owner",
                sessionToken,
              }));
            } catch {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Bad request" }));
            }
          });
          return;
        }

        // Share link creation (owner-only)
        if (req.method === "POST" && req.url === "/share/create") {
          let body = "";
          req.on("data", (chunk) => (body += chunk));
          req.on("end", () => {
            try {
              const { code, role } = JSON.parse(body);
              if (!pairCode || code !== pairCode) {
                res.writeHead(401, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Invalid pair code" }));
                return;
              }
              const shareRole = role === "collaborator" ? "collaborator" : "spectator";
              const token = nanoid();
              shareTokens.set(token, { role: shareRole });
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ token, role: shareRole }));
            } catch {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Bad request" }));
            }
          });
          return;
        }

        // Share link validation (public users)
        if (req.method === "POST" && req.url === "/share/validate") {
          let body = "";
          req.on("data", (chunk) => (body += chunk));
          req.on("end", () => {
            try {
              const { token } = JSON.parse(body);
              const share = shareTokens.get(token);
              if (!share) {
                res.writeHead(401, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Invalid share token" }));
                return;
              }
              const sessionToken = nanoid();
              addSessionToken(sessionToken, share.role);
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({
                machineId: config.machineId,
                wsUrl: `ws://localhost:${config.wsPort}`,
                hasAbly: !!config.ablyApiKey,
                role: share.role,
                sessionToken,
              }));
            } catch {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Bad request" }));
            }
          });
          return;
        }

        // Ably token endpoint
        if (req.method === "POST" && req.url === "/ably/token") {
          if (!config.ablyApiKey) {
            res.writeHead(503, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Ably not configured" }));
            return;
          }

          let body = "";
          req.on("data", (chunk) => (body += chunk));
          req.on("end", async () => {
            try {
              let targetMachineId = config.machineId;
              let sessionToken: string | undefined;
              try {
                const parsed = JSON.parse(body);
                if (parsed.machineId) targetMachineId = parsed.machineId;
                if (parsed.sessionToken) sessionToken = parsed.sessionToken;
              } catch {
                // no body
              }

              // Require valid sessionToken — derive role from server, never from client
              if (!sessionToken) {
                res.writeHead(401, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Session token required" }));
                return;
              }
              const clientRole = sessionTokens.get(sessionToken);
              if (!clientRole) {
                res.writeHead(401, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Invalid session token" }));
                return;
              }

              if (!targetMachineId) {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "No machine ID" }));
                return;
              }

              // Spectators get subscribe-only (no publish on commands channel)
              const commandsCap: Ably.capabilityOp[] = clientRole === "spectator" ? ["subscribe"] : ["publish"];
              const rest = new Ably.Rest({ key: config.ablyApiKey });
              const tokenRequest = await rest.auth.createTokenRequest({
                clientId: `${clientRole}:${nanoid(8)}`,
                ttl: 5 * 60 * 1000,
                capability: {
                  [`machine:${targetMachineId}:commands`]: commandsCap,
                  [`machine:${targetMachineId}:events`]: ["subscribe"],
                },
              });

              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify(tokenRequest));
            } catch (err) {
              console.error("[WS] Ably token error:", err);
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Token creation failed" }));
            }
          });
          return;
        }

        // --- Preview routes (built-in static serving + command proxy) ---
        const url = req.url ?? "/";

        // Static preview: serve files directly from disk (no child process)
        const staticMatch = url.match(/^\/preview-static(\/.*)?$/);
        if (staticMatch) {
          if (productProjectRegistryEnabled()) {
            if (req.method !== "GET" && req.method !== "HEAD") {
              res.writeHead(405, { "Cache-Control": "no-store", "Allow": "GET, HEAD" }); res.end(); return;
            }
            let relative = "";
            let token = "";
            try {
              const productPath = url.split("?")[0].match(/^\/preview-static\/([A-Za-z0-9_-]{16,128})\/(.+)$/);
              if (!productPath) throw new Error("Preview token or file path is missing");
              token = productPath[1];
              relative = decodeURIComponent(productPath[2]);
            } catch {
              res.writeHead(404, { "Content-Type": "text/plain", "Cache-Control": "no-store" }); res.end("Preview not found"); return;
            }
            const context = getProductPreviewContext();
            const projection = context ? await irixiPublicIntegration?.publicProjection().catch(() => null) : null;
            if (!context || context.status !== "ready" || context.token !== token
              || !productPreviewMatches(context, projection)
              || relative.includes("\\") || relative.startsWith("/")
              || relative.split("/").some((part) => !part || part === "." || part === ".." || part === ".git")) {
              res.writeHead(409, { "Content-Type": "text/plain", "Cache-Control": "no-store" }); res.end("Preview is stale or unavailable"); return;
            }
            try {
              const authorized = await irixiPublicIntegration!.authorizeStaticPreview({ ...context, file: relative });
              const absolute = resolve(authorized.file);
              const fileStat = await lstat(absolute);
              const real = await realpath(absolute);
              const bytes = await readFile(absolute);
              if (authorized.root !== context.root || authorized.entry !== context.entryAbsolute
                || real !== absolute || !fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.nlink !== 1
                || fileStat.size !== authorized.fileBytes || bytes.length !== authorized.fileBytes
                || createHash("sha256").update(bytes).digest("hex") !== authorized.fileSha256) {
                throw new Error("Preview file changed after authorization");
              }
              const ext = extname(absolute).toLowerCase();
              const contentType = ext === ".html" || ext === ".htm" ? "text/html; charset=utf-8"
                : ext === ".css" ? "text/css; charset=utf-8"
                  : ext === ".js" || ext === ".mjs" ? "application/javascript; charset=utf-8" : "application/octet-stream";
              res.writeHead(200, { "Content-Type": contentType, "Content-Length": String(bytes.length),
                "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
                "Content-Security-Policy": "default-src 'self' data: blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'" });
              if (req.method === "HEAD") res.end(); else res.end(bytes);
            } catch {
              res.writeHead(409, { "Content-Type": "text/plain", "Cache-Control": "no-store" }); res.end("Preview is stale or outside the registered candidate");
            }
            return;
          }
          const registeredArticlePreview = process.env.OPEN_OFFICE_IRIXI_PROJECT_ID === "sample-article-project"
            && process.env.OPEN_OFFICE_IRIXI_EXECUTION_WORKSPACE
            && previewServer.staticRoot === process.env.OPEN_OFFICE_IRIXI_EXECUTION_WORKSPACE;
          if (MAC_TRIAL_MODE && !registeredArticlePreview) {
            res.writeHead(403, { "Content-Type": "text/plain" });
            res.end("Preview disabled in Mac trial");
            return;
          }
          const root = previewServer.staticRoot;
          const entry = previewServer.staticEntry;
          if (!root) {
            res.writeHead(404, { "Content-Type": "text/plain" });
            res.end("No static preview configured");
            return;
          }
          if (productProjectRegistryEnabled()) {
            try {
              const authorized = await irixiPublicIntegration!.authorizeStaticPreview(resolve(root, entry ?? "index.html"));
              if (authorized.root !== resolve(root) || authorized.entry !== resolve(root, entry ?? "index.html")) throw new Error("preview state changed");
            } catch {
              res.writeHead(409, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
              res.end("Static preview is stale or outside the current registered task");
              return;
            }
          }
          const reqPath = decodeURIComponent((staticMatch[1] || "/").split("?")[0]);
          const filePath = resolve(root, reqPath === "/" ? (entry ?? "index.html") : reqPath.slice(1));
          // Security: prevent path traversal outside root (trailing sep avoids sibling-prefix bypass)
          const rootWithSep = resolve(root) + "/";
          if (filePath !== resolve(root) && !filePath.startsWith(rootWithSep)) {
            res.writeHead(403, { "Content-Type": "text/plain" });
            res.end("Forbidden");
            return;
          }
          try {
            const fileStat = await stat(filePath);
            if (!fileStat.isFile()) {
              res.writeHead(404, { "Content-Type": "text/plain" });
              res.end("Not found");
              return;
            }
            const ext = extname(filePath).toLowerCase();
            const mime: Record<string, string> = {
              ".html": "text/html", ".htm": "text/html",
              ".css": "text/css", ".js": "application/javascript", ".mjs": "application/javascript",
              ".json": "application/json", ".xml": "application/xml",
              ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
              ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp", ".avif": "image/avif", ".ico": "image/x-icon",
              ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf", ".eot": "application/vnd.ms-fontobject",
              ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
              ".mp4": "video/mp4", ".webm": "video/webm",
              ".wasm": "application/wasm", ".pdf": "application/pdf", ".zip": "application/zip",
              ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv",
              ".ts": "application/javascript", ".tsx": "application/javascript", ".jsx": "application/javascript",
            };
            const contentType = mime[ext] || "application/octet-stream";
            const data = await readFile(filePath);
            res.writeHead(200, {
              "Content-Type": contentType,
              "Content-Length": data.length,
              "Cache-Control": "no-cache",
              "Access-Control-Allow-Origin": "*",
            });
            res.end(data);
          } catch {
            res.writeHead(404, { "Content-Type": "text/plain" });
            res.end("Not found");
          }
          return;
        }

        // Command preview: reverse proxy to COMMAND_PORT with auto-restart on failure
        const appMatch = url.match(/^\/preview-app(\/.*)?$/);
        if (appMatch) {
          if (MAC_TRIAL_MODE || productProjectRegistryEnabled()) {
            res.writeHead(403, { "Content-Type": "text/plain" });
            res.end("Preview disabled in Mac trial");
            return;
          }
          const targetPath = appMatch[1] || "/";
          const targetPort = previewServer.commandPort;
          const chunks: Buffer[] = [];
          req.on("data", (c: Buffer) => chunks.push(c));
          req.on("end", () => {
            const body = Buffer.concat(chunks);
            const send502 = () => {
              res.writeHead(502, { "Content-Type": "text/plain" });
              res.end("Preview app not running");
            };
            const doProxy = (isRetry: boolean) => {
              const proxyReq = httpRequest(
                { hostname: "127.0.0.1", port: targetPort, path: targetPath, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${targetPort}` } },
                (proxyRes) => {
                  const status = proxyRes.statusCode ?? 502;
                  if (status === 502 && !isRetry) {
                    proxyRes.resume();
                    previewServer.ensureCommandRunning().then((ok) => ok ? doProxy(true) : send502());
                    return;
                  }
                  res.writeHead(status, proxyRes.headers);
                  proxyRes.pipe(res, { end: true });
                },
              );
              proxyReq.on("error", () => {
                if (!isRetry) {
                  previewServer.ensureCommandRunning().then((ok) => ok ? doProxy(true) : send502());
                } else {
                  send502();
                }
              });
              if (body.length > 0) proxyReq.write(body);
              proxyReq.end();
            };
            doProxy(false);
          });
          return;
        }

        // --- Static file serving (fallback, production only) ---
        if (process.env.NODE_ENV === "development") {
          // In dev mode, redirect page requests to the Next.js dev server
          const url = req.url?.split("?")[0] ?? "/";
          const isPageRoute = url === "/" || url === "/pair" || url === "/office" || url === "/join" || !url.includes(".");
          if (isPageRoute) {
            const nextPort = process.env.NEXT_DEV_PORT ?? "3000";
            const query = req.url?.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
            res.writeHead(302, { Location: `http://localhost:${nextPort}${url}${query}` });
            res.end();
            return;
          }
          res.writeHead(404);
          res.end("Not Found (dev mode — use Next.js dev server)");
          return;
        }
        await serveStatic(req, res);
      };

      const maxRetries = 10;
      let port = config.wsPort;

      const tryListen = () => {
        const httpServer = createServer(requestHandler);
        httpServer.listen(port, "127.0.0.1", () => {
          // When port=0, OS assigns a random port — read the actual value
          const actualPort = (httpServer.address() as any)?.port ?? port;
          port = actualPort;
          config.wsPort = actualPort;

          // Attach WebSocket server only after successful listen
          wss = new WebSocketServer({ server: httpServer });
          wss.on("connection", (ws) => {
            pendingAuth.add(ws);
            console.log(`[WS] Client connected, awaiting AUTH...`);

            // Disconnect if no AUTH within timeout
            const authTimer = setTimeout(() => {
              if (pendingAuth.has(ws)) {
                console.log(`[WS] AUTH timeout, disconnecting client`);
                pendingAuth.delete(ws);
                ws.close();
              }
            }, AUTH_TIMEOUT_MS);

            ws.on("message", (data) => {
              try {
                const msg = JSON.parse(data.toString());

                // Handle AUTH handshake
                if (pendingAuth.has(ws)) {
                  if (msg.type === "AUTH") {
                    if (msg.sessionToken) {
                      const role = sessionTokens.get(msg.sessionToken);
                      if (role) {
                        const clientId = nanoid(8);
                        clients.set(ws, { role, clientId });
                        pendingAuth.delete(ws);
                        clearTimeout(authTimer);
                        console.log(`[WS] Client authenticated as ${role} (total: ${clients.size})`);
                        return;
                      }
                    }
                    // AUTH with invalid/missing token — tell client and disconnect
                    console.log(`[WS] Invalid AUTH token, rejecting`);
                    ws.send(JSON.stringify({ type: "AUTH_FAILED" }));
                    pendingAuth.delete(ws);
                    clearTimeout(authTimer);
                    ws.close();
                    return;
                  }

                  // No AUTH message — reject unauthenticated client
                  console.log(`[WS] Non-AUTH message from unauthenticated client, rejecting`);
                  ws.send(JSON.stringify({ type: "AUTH_FAILED" }));
                  pendingAuth.delete(ws);
                  clearTimeout(authTimer);
                  ws.close();
                  return;
                }

                const clientInfo = clients.get(ws);
                if (!clientInfo) return; // not authenticated
                const parsed = CommandSchema.parse(msg);
                onCommand?.(parsed, { role: clientInfo.role, clientId: clientInfo.clientId });
              } catch (err) {
                console.error("[WS] Invalid command:", err);
              }
            });

            ws.on("close", () => {
              pendingAuth.delete(ws);
              clients.delete(ws);
              clearTimeout(authTimer);
              console.log(`[WS] Client disconnected (total: ${clients.size})`);
            });
          });

          console.log(`[WS] Server listening on 127.0.0.1:${port}`);
          writePortLock(port);
          printLanAddresses();

          // Signal for Tauri sidecar — Rust parses this to emit port to webview
          console.log(`GATEWAY_READY ${JSON.stringify({ port, gatewayId: config.gatewayId })}`);

          promiseResolve(true);
        });

        httpServer.once("error", (err: NodeJS.ErrnoException) => {
          if (err.code === "EADDRINUSE" && port - config.wsPort < maxRetries) {
            const oldPort = port;
            port++;
            console.log(`[WS] Port ${oldPort} in use, trying ${port}...`);
            tryListen();
          } else {
            console.error(`[WS] Failed to start server:`, err.message);
            promiseResolve(false);
          }
        });
      };

      tryListen();
    });
  },

  broadcast(event: GatewayEvent) {
    const data = JSON.stringify(event);
    for (const [ws] of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    }
  },

  destroy() {
    for (const [ws] of clients) {
      ws.close();
    }
    clients.clear();
    wss?.close();
    wss = null;
  },
};

async function serveStatic(req: IncomingMessage, res: ServerResponse) {
  const url = decodeURIComponent(req.url?.split("?")[0] ?? "/");

  const routeMap: Record<string, string> = {
    "/": "/index.html",
    "/pair": "/pair.html",
    "/office": "/office.html",
    "/join": "/join.html",
  };

  let filePath: string;
  if (routeMap[url]) {
    filePath = join(config.webDir, routeMap[url]);
  } else {
    filePath = join(config.webDir, url);
  }

  // Security: prevent path traversal outside webDir
  const webRoot = resolve(config.webDir);
  const resolvedPath = resolve(filePath);
  if (resolvedPath !== webRoot && !resolvedPath.startsWith(webRoot + "/")) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Forbidden");
    return;
  }

  try {
    const stats = await stat(filePath);
    if (stats.isDirectory()) {
      filePath = join(filePath, "index.html");
    }
    const content = await readFile(filePath);
    const ext = extname(filePath);
    const mime = MIME_TYPES[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": mime });
    res.end(content);
  } catch {
    try {
      const htmlPath = filePath + ".html";
      const content = await readFile(htmlPath);
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(content);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    }
  }
}

function printLanAddresses() {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === "IPv4" && !net.internal) {
        console.log(`[WS] LAN: http://${net.address}:${config.wsPort}`);
      }
    }
  }
}
