import { rankCandidates, runRecall } from "../recall/recall.js";
import { clampTokenBudget } from "./support.js";
import type { MemoryRecallEntry } from "./support.js";
import type {
  MemoryEvent,
  MemoryKernel,
  MemoryPacket,
  MemoryPrincipalRef,
  MemoryRecallAudit,
  MemoryToolCall,
  MemoryToolResult
} from "../contract/types.js";

/**
 * B70 ablation knob: trusted runtime control for the B0 memory-influence
 * ablation, never a model-facing tool. Resolved once per JsonlMemoryRuntime
 * instance (see runtime.ts ctor) from (1) explicit config, (2) the
 * MNEME_RECALL_MODE env var, (3) default "on". A typo in either source
 * throws rather than silently falling back to "on" — a silent fallback
 * would fake a null delta between arms.
 */
export type MemoryRecallMode = "on" | "off" | "shuffled";

export const MNEME_RECALL_MODE_ENV = "MNEME_RECALL_MODE";

const RECALL_MODES: ReadonlySet<string> = new Set(["on", "off", "shuffled"]);

const isMemoryRecallMode = (value: string): value is MemoryRecallMode => RECALL_MODES.has(value);

export const resolveRecallMode = (
  configValue: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): MemoryRecallMode => {
  const configCandidate = configValue !== undefined && configValue.trim().length > 0 ? configValue : undefined;
  const source = configCandidate ?? env[MNEME_RECALL_MODE_ENV];

  if (source === undefined || source.trim().length === 0) {
    return "on";
  }

  const trimmed = source.trim();
  if (!isMemoryRecallMode(trimmed)) {
    throw new Error(
      `invalid ${MNEME_RECALL_MODE_ENV} value "${trimmed}": expected "on", "off", or "shuffled"`
    );
  }

  return trimmed;
};

const estimateRecallTokens = (text: string): number => Math.max(1, Math.ceil(text.length / 4));

/**
 * shuffled-mode substitution: given the full ranked candidate pool C and the
 * "on"-mode selection S, injects up to |S| decoys from P = C\S, other-scope
 * candidates first (so a decoy never shares a scope with anything actually
 * selected under "on"), then stable rank (candidates arrive pre-sorted by
 * rankCandidates and Array.prototype.sort is stable, so ties keep that
 * order). Degenerate (nothing injected) when S or P is empty, or nothing
 * fits the same token budget "on" mode would have used.
 */
export const selectShuffledEntries = (
  candidates: MemoryRecallEntry[],
  selected: MemoryRecallEntry[],
  maxTokens: number
): { selected: MemoryRecallEntry[]; degenerate: boolean } => {
  if (selected.length === 0) {
    return { selected: [], degenerate: true };
  }

  const selectedIds = new Set(selected.map((entry) => entry.event.id));
  const selectedScopes = new Set(selected.map((entry) => entry.scope));
  const pool = candidates.filter((entry) => !selectedIds.has(entry.event.id));

  if (pool.length === 0) {
    return { selected: [], degenerate: true };
  }

  const otherScopeFirst = [...pool].sort((left, right) => {
    const leftOther = selectedScopes.has(left.scope) ? 1 : 0;
    const rightOther = selectedScopes.has(right.scope) ? 1 : 0;
    return leftOther - rightOther;
  });

  const injected: MemoryRecallEntry[] = [];
  let usedTokens = 0;
  for (const candidate of otherScopeFirst) {
    if (injected.length >= selected.length) {
      break;
    }
    const tokens = estimateRecallTokens(candidate.representation);
    if (usedTokens + tokens > maxTokens && injected.length > 0) {
      continue;
    }
    injected.push(candidate);
    usedTokens += tokens;
  }

  return injected.length === 0
    ? { selected: [], degenerate: true }
    : { selected: injected, degenerate: false };
};

export interface RecallModeInput {
  actor: MemoryPrincipalRef;
  scopeIds: string[];
  events: MemoryEvent[];
  text: string;
  maxTokens?: number;
  embeddingScores?: Readonly<Record<string, number>> | ReadonlyMap<string, number>;
}

export interface RecallModeResult {
  packet: MemoryPacket;
  audit: MemoryRecallAudit;
  selected: MemoryRecallEntry[];
  degenerate: boolean;
}

/**
 * Builds the shuffled-mode recall result: runs the same ranking/selection
 * pipeline "on" mode would use to get candidates C and on-selection S, then
 * substitutes the injected decoys from selectShuffledEntries in place of S.
 */
export const buildShuffledRecall = (input: RecallModeInput): RecallModeResult => {
  const maxTokens = clampTokenBudget(input.maxTokens);
  const recallInput = {
    actor: input.actor,
    scopeIds: input.scopeIds,
    events: input.events,
    query: input.text,
    maxTokens,
    embeddingScores: input.embeddingScores
  };

  const candidates: MemoryRecallEntry[] = rankCandidates(recallInput);
  const onSelection = runRecall(recallInput);
  const { selected: injected, degenerate } = selectShuffledEntries(candidates, onSelection.selected, maxTokens);

  const packet: MemoryPacket = {
    principal: input.actor,
    sections: injected.map((entry) => ({
      heading: `${entry.scope}: ${entry.event.type}`,
      text: entry.representation
    })),
    rawHint: degenerate
      ? "shuffled recall mode: no decoy candidates available (degenerate)"
      : `shuffled recall mode: ${injected.length} decoy candidate(s) injected`
  };

  const audit: MemoryRecallAudit = {
    totalCandidates: candidates.length,
    selectedEventIds: injected.map((entry) => entry.event.id),
    selected: injected.map((entry) => ({
      eventId: entry.event.id,
      decision: entry.decision,
      scope: entry.scope,
      representation: entry.representation
    })),
    decisions: injected.map((entry) => ({
      eventId: entry.event.id,
      decision: entry.decision,
      reason: "shuffled recall substitution"
    })),
    tokenBudgetUsed: injected.reduce((total, entry) => total + estimateRecallTokens(entry.representation), 0),
    redactionCount: injected.filter((entry) =>
      entry.decision === "allow_redacted_summary" || entry.decision === "known_but_private"
    ).length
  };

  return { packet, audit, selected: injected, degenerate };
};

/**
 * Kernel read-tool gating for off/shuffled: memory.search and memory.locate
 * always return a well-formed, empty, deny result carrying the same
 * request_id/tool so a wrapped-out agent cannot recover the excluded
 * candidates through the tool surface. Mutating tools (register, summarize,
 * forget, promote) stay live in every mode — the ablation is recall-only.
 */
export const guardKernelForRecallMode = (kernel: MemoryKernel, mode: MemoryRecallMode): MemoryKernel => {
  if (mode === "on") {
    return kernel;
  }

  const emptyResult = (call: MemoryToolCall, tool: "memory.search" | "memory.locate"): MemoryToolResult => ({
    request_id: call.request_id,
    tool,
    decision: "deny",
    content: [],
    audit: {
      request_id: call.request_id,
      requester: call.envelope.principal,
      sources: [],
      transport: call.envelope.transport,
      latency_ms: 0,
      argument_hash: `recall_mode=${mode}`
    }
  });

  return {
    search: async (call) => emptyResult(call, "memory.search"),
    locate: async (call) => emptyResult(call, "memory.locate"),
    register: (call) => kernel.register(call),
    summarize: (call) => kernel.summarize(call),
    forget: (call) => kernel.forget(call),
    promote: (call) => kernel.promote(call)
  };
};
