import type { AgentStatus } from "@office/shared";

/**
 * Visual metadata for an agent entering the scene.
 * Scene-agnostic — each adapter picks what it needs.
 */
export interface AgentInfo {
  name: string;
  label: string;
  labelColor: string;
  isExternal: boolean;
  palette?: number;
}

/** Bubble type shown above an agent's head */
export type BubbleType = "permission" | "working" | "waiting";

/**
 * Pluggable scene interface — any scene implementation (pixel office, 3D,
 * isometric, list view) can implement these 6 methods to be swapped in.
 */
export interface SceneAdapter {
  addAgent(agentId: string, info: AgentInfo): void;
  removeAgent(agentId: string): void;
  updateAgent(agentId: string, status: AgentStatus, bubble: BubbleType | null, keepSeat?: boolean): void;
  showSpeechBubble(agentId: string, text: string): void;
  selectAgent(agentId: string | null): void;
  dispose(): void;
}

/**
 * Props every scene component must accept.
 * Selection flows through the adapter (via useSceneBridge), not as a prop.
 */
export interface SceneComponentProps {
  onAdapterReady: (adapter: SceneAdapter) => void;
  onAgentClick: (agentId: string) => void;
}
