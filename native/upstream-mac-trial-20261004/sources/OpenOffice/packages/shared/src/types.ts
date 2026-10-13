import { z } from "zod";

export const AgentStatusEnum = z.enum([
  "idle", "working", "waiting_approval", "done", "error",
]);
export type AgentStatus = z.infer<typeof AgentStatusEnum>;

export const RiskLevelEnum = z.enum(["low", "med", "high"]);
export type RiskLevel = z.infer<typeof RiskLevelEnum>;

export const DecisionEnum = z.enum(["yes", "no"]);
export type Decision = z.infer<typeof DecisionEnum>;

export const TeamPhaseEnum = z.enum(["create", "design", "execute", "complete"]);
export type TeamPhase = z.infer<typeof TeamPhaseEnum>;

export const UserRoleEnum = z.enum(["owner", "collaborator", "spectator"]);
export type UserRole = z.infer<typeof UserRoleEnum>;
