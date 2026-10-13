export interface RetryState {
  taskId: string;
  originalPrompt: string;
  attempt: number;
  maxRetries: number;
  errors: string[];
}

export class RetryTracker {
  private state = new Map<string, RetryState>();
  private maxRetries: number;
  private escalateToLeader: boolean;

  constructor(maxRetries = 2, escalateToLeader = true) {
    this.maxRetries = maxRetries;
    this.escalateToLeader = escalateToLeader;
  }

  /**
   * Initialize tracking for a task. Call before first attempt.
   */
  track(taskId: string, originalPrompt: string): void {
    this.state.set(taskId, {
      taskId,
      originalPrompt,
      attempt: 0,
      maxRetries: this.maxRetries,
      errors: [],
    });
  }

  /**
   * Check if the task has retries remaining.
   */
  shouldRetry(taskId: string): boolean {
    const s = this.state.get(taskId);
    if (!s) return false;
    return s.attempt < s.maxRetries;
  }

  /**
   * Record a failed attempt. Returns the updated state.
   */
  recordAttempt(taskId: string, error: string): RetryState | undefined {
    const s = this.state.get(taskId);
    if (!s) return undefined;
    s.attempt++;
    s.errors.push(error);
    return { ...s };
  }

  /**
   * Get the original prompt for retrying (with error context appended).
   */
  getRetryPrompt(taskId: string): string | null {
    const s = this.state.get(taskId);
    if (!s) return null;
    const lastError = s.errors[s.errors.length - 1] ?? "unknown error";
    return `${s.originalPrompt}

[RETRY — Attempt ${s.attempt + 1}/${s.maxRetries}]
Previous attempt failed with:
${lastError.slice(0, 500)}

Before retrying, follow this protocol:
1. DIAGNOSE: Read the error carefully. Identify the root cause, not just the symptom.
2. FIX: Address the root cause first (missing dependency, wrong path, syntax error, etc.)
3. VERIFY: After fixing, confirm the fix works before moving on.
Do NOT repeat the same approach that failed.`;
  }

  /**
   * Get escalation prompt for the team lead (when all retries exhausted).
   * Returns null if escalation is disabled or task not tracked.
   */
  getEscalation(taskId: string): { prompt: string } | null {
    if (!this.escalateToLeader) return null;
    const s = this.state.get(taskId);
    if (!s) return null;
    if (s.attempt < s.maxRetries) return null;

    const errorList = s.errors.map((e, i) => `  Attempt ${i + 1}: ${e.slice(0, 200)}`).join("\n");
    const sameError = s.errors.length >= 2 && s.errors.every(e => {
      const key = e.slice(0, 80).toLowerCase();
      return key === s.errors[0].slice(0, 80).toLowerCase();
    });

    return {
      prompt: `[ESCALATION] A task has failed after ${s.attempt} attempts and needs your decision.

Original task: "${s.originalPrompt.slice(0, 300)}"

Failure history:
${errorList}
${sameError ? "\n⚠️ All attempts failed with the SAME error. This is likely a PERMANENT blocker (missing credentials, API limits, service unavailable). Do NOT reassign — report to user.\n" : ""}
Options (choose ONE):
1. If the error is FIXABLE (code bug, wrong path): Reassign to a DIFFERENT team member with revised instructions
2. If the task is too large: Break into smaller pieces and delegate each part
3. If the error is PERMANENT (auth failure, service down, insufficient balance, missing API key): Report the blocker to the user. Do NOT reassign.

IMPORTANT: If the same error keeps repeating, choose option 3. Do not waste resources retrying.`,
    };
  }

  /**
   * Remove tracking for a completed/cancelled task.
   */
  clear(taskId: string): void {
    this.state.delete(taskId);
  }
}
