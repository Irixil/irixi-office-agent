/**
 * Conservative, tokenizer-free admission for prompts sent to a native model
 * backend. Callers must provide the limits resolved for the exact execution
 * model; this module deliberately has no model fallback or cached defaults.
 */

export interface NativePromptBlock {
  /** Stable caller-owned identifier used only for diagnostics. */
  id: string;
  /** The block's semantic responsibility, such as goal or success criteria. */
  purpose: string;
  /** Verbatim prompt text. This module never trims, summarizes, or slices it. */
  content: string;
  /**
   * Explicit permission to remove a later byte-identical repeat. A block is
   * removed only when this group, purpose, and content all match an earlier
   * block. Equal text with another purpose is retained.
   */
  exactDuplicateGroup?: string;
}

export interface NativePromptModelLimits {
  modelId: string;
  contextWindowTokens: number;
  effectiveContextPercent: number;
}

export interface NativePromptReserves {
  outputTokens: number;
  protocolTokens: number;
}

export interface NativePromptBudgetRequest {
  executionModelId: string;
  limits: NativePromptModelLimits;
  reserves: NativePromptReserves;
  blocks: readonly NativePromptBlock[];
  /** Verbatim separator inserted between retained blocks. Defaults to two LF. */
  separator?: string;
}

export interface NativePromptBudgetSnapshot {
  modelId: string;
  contextWindowTokens: number;
  effectiveContextPercent: number;
  effectiveContextTokens: number;
  outputReserveTokens: number;
  protocolReserveTokens: number;
  availablePromptTokens: number;
  promptUtf8Bytes: number;
  promptTokenUpperBound: number;
  estimator: "utf8_bytes_upper_bound";
  /** Count of caller-explicit, byte-identical blocks removed before admission. */
  removedExactDuplicateCount?: number;
}

export interface RemovedExactDuplicate {
  removedBlockId: string;
  retainedBlockId: string;
  exactDuplicateGroup: string;
  purpose: string;
}

export type NativePromptBudgetFailureCode =
  | "MODEL_LIMITS_MISMATCH"
  | "INVALID_BUDGET"
  | "INVALID_BLOCK"
  | "EMPTY_PROMPT"
  | "PROMPT_BUDGET_EXCEEDED";

export interface NativePromptBudgetFailure {
  code: NativePromptBudgetFailureCode;
  message: string;
}

export type NativePromptBudgetResult =
  | {
      ok: true;
      prompt: string;
      keptBlocks: readonly NativePromptBlock[];
      removedExactDuplicates: readonly RemovedExactDuplicate[];
      budget: NativePromptBudgetSnapshot;
    }
  | {
      ok: false;
      reason: NativePromptBudgetFailure;
      keptBlockIds: readonly string[];
      removedExactDuplicates: readonly RemovedExactDuplicate[];
      budget?: NativePromptBudgetSnapshot;
    };

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function invalid(
  code: Exclude<NativePromptBudgetFailureCode, "PROMPT_BUDGET_EXCEEDED">,
  message: string,
  keptBlockIds: readonly string[] = [],
  removedExactDuplicates: readonly RemovedExactDuplicate[] = [],
): NativePromptBudgetResult {
  return { ok: false, reason: { code, message }, keptBlockIds, removedExactDuplicates };
}

/**
 * Prepare and admit a native prompt without estimating more capacity than is
 * safe in the absence of a model tokenizer. Each UTF-8 byte is counted as one
 * possible token, which is a conservative upper bound for byte-level BPE input.
 */
export function prepareNativePrompt(request: NativePromptBudgetRequest): NativePromptBudgetResult {
  if (!request.executionModelId || !request.limits.modelId
    || request.executionModelId !== request.limits.modelId) {
    return invalid(
      "MODEL_LIMITS_MISMATCH",
      "Native prompt limits do not belong to the exact execution model.",
    );
  }

  const { contextWindowTokens, effectiveContextPercent } = request.limits;
  const { outputTokens, protocolTokens } = request.reserves;
  if (!Number.isSafeInteger(contextWindowTokens) || contextWindowTokens <= 0
    || !Number.isFinite(effectiveContextPercent) || effectiveContextPercent <= 0 || effectiveContextPercent > 100
    || !isNonNegativeSafeInteger(outputTokens) || !isNonNegativeSafeInteger(protocolTokens)) {
    return invalid("INVALID_BUDGET", "Native prompt model limits or reserves are invalid.");
  }

  const effectiveContextTokens = Math.floor(contextWindowTokens * effectiveContextPercent / 100);
  const availablePromptTokens = effectiveContextTokens - outputTokens - protocolTokens;
  if (!Number.isSafeInteger(effectiveContextTokens) || availablePromptTokens < 0) {
    return invalid("INVALID_BUDGET", "Native prompt reserves exceed the effective context window.");
  }

  const keptBlocks: NativePromptBlock[] = [];
  const removedExactDuplicates: RemovedExactDuplicate[] = [];
  const explicitGroups = new Map<string, NativePromptBlock[]>();
  for (const block of request.blocks) {
    if (!block || typeof block.id !== "string" || !block.id
      || typeof block.purpose !== "string" || !block.purpose
      || typeof block.content !== "string"
      || (block.exactDuplicateGroup !== undefined
        && (typeof block.exactDuplicateGroup !== "string" || !block.exactDuplicateGroup))) {
      return invalid(
        "INVALID_BLOCK",
        "Every native prompt block needs a non-empty id and purpose plus verbatim string content.",
        keptBlocks.map((item) => item.id),
        removedExactDuplicates,
      );
    }

    if (block.exactDuplicateGroup) {
      const prior = explicitGroups.get(block.exactDuplicateGroup) ?? [];
      const retained = prior.find((item) => item.purpose === block.purpose && item.content === block.content);
      if (retained) {
        removedExactDuplicates.push({
          removedBlockId: block.id,
          retainedBlockId: retained.id,
          exactDuplicateGroup: block.exactDuplicateGroup,
          purpose: block.purpose,
        });
        continue;
      }
      prior.push(block);
      explicitGroups.set(block.exactDuplicateGroup, prior);
    }
    keptBlocks.push(block);
  }

  const separator = request.separator ?? "\n\n";
  if (typeof separator !== "string") {
    return invalid(
      "INVALID_BLOCK",
      "The native prompt separator must be a string.",
      keptBlocks.map((item) => item.id),
      removedExactDuplicates,
    );
  }
  const prompt = keptBlocks.map((block) => block.content).join(separator);
  if (!prompt) {
    return invalid(
      "EMPTY_PROMPT",
      "The native prompt is empty after exact duplicate removal.",
      keptBlocks.map((item) => item.id),
      removedExactDuplicates,
    );
  }

  const promptUtf8Bytes = Buffer.byteLength(prompt, "utf8");
  const budget: NativePromptBudgetSnapshot = {
    modelId: request.limits.modelId,
    contextWindowTokens,
    effectiveContextPercent,
    effectiveContextTokens,
    outputReserveTokens: outputTokens,
    protocolReserveTokens: protocolTokens,
    availablePromptTokens,
    promptUtf8Bytes,
    promptTokenUpperBound: promptUtf8Bytes,
    estimator: "utf8_bytes_upper_bound",
  };
  if (budget.promptTokenUpperBound > availablePromptTokens) {
    return {
      ok: false,
      reason: {
        code: "PROMPT_BUDGET_EXCEEDED",
        message: "Native prompt exceeds the conservative input budget; it was not sliced or submitted.",
      },
      keptBlockIds: keptBlocks.map((item) => item.id),
      removedExactDuplicates,
      budget,
    };
  }

  return { ok: true, prompt, keptBlocks, removedExactDuplicates, budget };
}
