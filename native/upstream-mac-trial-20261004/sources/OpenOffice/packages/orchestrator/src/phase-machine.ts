// ---------------------------------------------------------------------------
// PhaseMachine — manages team collaboration phase transitions.
//
// Phases: CREATE → DESIGN → EXECUTE → COMPLETE → (loop back to EXECUTE)
//
// Transitions:
//   create  → design:   Leader output contains [PLAN] tag
//   design  → execute:  Explicit approvePlan() call (user approval)
//   execute → complete: isFinalResult on task:done from leader
//   complete → execute: User sends new message (feedback loop)
// ---------------------------------------------------------------------------

import type { TeamPhase } from "./types.js";

export interface TeamPhaseInfo {
  teamId: string;
  phase: TeamPhase;
  leadAgentId: string;
}

export class PhaseMachine {
  private teams = new Map<string, TeamPhaseInfo>();

  // ---------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------

  /**
   * Register a new team at a specific phase.
   * Called on CREATE_TEAM and on state restoration from disk.
   */
  setPhase(teamId: string, phase: TeamPhase, leadAgentId: string): TeamPhaseInfo {
    const info: TeamPhaseInfo = { teamId, phase, leadAgentId };
    this.teams.set(teamId, info);
    return info;
  }

  /**
   * Detect create → design transition from leader output.
   * Returns the new phase info if a transition occurred, null otherwise.
   */
  checkPlanDetected(leadAgentId: string, resultText: string): TeamPhaseInfo | null {
    if (!/\[PLAN\]/i.test(resultText)) return null;

    for (const [teamId, info] of this.teams) {
      if (info.leadAgentId === leadAgentId && info.phase === "create") {
        info.phase = "design";
        console.log(`[PhaseMachine] ${teamId}: create → design (plan detected)`);
        return { ...info };
      }
    }
    return null;
  }

  /**
   * Explicit design → execute transition (user approved the plan).
   * Returns the new phase info, or null if no matching team found.
   */
  approvePlan(leadAgentId: string): TeamPhaseInfo | null {
    for (const [teamId, info] of this.teams) {
      if (info.leadAgentId === leadAgentId) {
        info.phase = "execute";
        console.log(`[PhaseMachine] ${teamId}: ${info.phase} → execute (plan approved)`);
        return { ...info };
      }
    }
    return null;
  }

  /**
   * Detect execute → complete transition from final result.
   * Returns the new phase info if a transition occurred, null otherwise.
   */
  checkFinalResult(leadAgentId: string): TeamPhaseInfo | null {
    for (const [teamId, info] of this.teams) {
      if (info.leadAgentId === leadAgentId && info.phase === "execute") {
        info.phase = "complete";
        console.log(`[PhaseMachine] ${teamId}: execute → complete (final result)`);
        return { ...info };
      }
    }
    return null;
  }

  /**
   * Handle user message in complete phase → transition back to execute.
   * Returns the resolved phase override, phase info, and whether a transition occurred.
   */
  handleUserMessage(leadAgentId: string): { phaseOverride: TeamPhase; phaseInfo: TeamPhaseInfo; transitioned: boolean } | null {
    for (const [teamId, info] of this.teams) {
      if (info.leadAgentId === leadAgentId) {
        if (info.phase === "complete") {
          info.phase = "execute";
          console.log(`[PhaseMachine] ${teamId}: complete → execute (user feedback)`);
          return { phaseOverride: "execute", phaseInfo: { ...info }, transitioned: true };
        }
        return { phaseOverride: info.phase, phaseInfo: { ...info }, transitioned: false };
      }
    }
    return null;
  }

  /**
   * Remove a team (FIRE_TEAM).
   */
  clear(teamId: string): void {
    this.teams.delete(teamId);
  }

  /**
   * Remove all teams.
   */
  clearAll(): void {
    this.teams.clear();
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  /**
   * Get the current phase for a leader agent.
   */
  getPhaseForLeader(leadAgentId: string): TeamPhaseInfo | undefined {
    for (const info of this.teams.values()) {
      if (info.leadAgentId === leadAgentId) return { ...info };
    }
    return undefined;
  }

  /**
   * Get teamId for a leader agent.
   */
  getTeamIdForLeader(leadAgentId: string): string | undefined {
    for (const [teamId, info] of this.teams) {
      if (info.leadAgentId === leadAgentId) return teamId;
    }
    return undefined;
  }

  /**
   * Whether the given leader is in a phase that allows delegation.
   */
  canDelegate(leadAgentId: string): boolean {
    const info = this.getPhaseForLeader(leadAgentId);
    return info?.phase === "execute";
  }

  /**
   * Get all team phase info (for state persistence/broadcasting).
   */
  getAllPhases(): TeamPhaseInfo[] {
    return Array.from(this.teams.values()).map(info => ({ ...info }));
  }

  /**
   * Check if any team exists.
   */
  hasTeams(): boolean {
    return this.teams.size > 0;
  }

  /**
   * Check if a specific teamId exists.
   */
  hasTeam(teamId: string): boolean {
    return this.teams.has(teamId);
  }
}
