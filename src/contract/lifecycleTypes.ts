/**
 * B59 lifecycle + capability types, split out of contract/types.ts to keep
 * that file under the repo's 400-line limit (see AGENTS.md). Re-exported
 * through contract/types.ts (and transitively contract/index.ts) so
 * consumers keep importing everything from "../contract/types.js" as usual.
 */

/** Kernel-stamped from the validated capability token, never from model args. */
export type MemoryOrigin = "awake" | "dream" | "system";

/**
 * Capability tokens carried on MemoryToolCallEnvelope.capability (see
 * src/policy/capability.ts). `mneme.cap.system.v1` (B62) is the
 * foreign-scope-write escalation checked by src/policy/writeScope.ts; it is
 * never produced by the default tool-descriptor/MCP envelope path and is
 * only ever set by a trusted execution context.
 */
export type MemoryCapability = "mneme.cap.awake.v1" | "mneme.cap.dream.v1" | "mneme.cap.system.v1";

/** Chain-level lifecycle state. Superseded only applies at revision granularity. */
export type MemoryLifecycleState = "active" | "promoted" | "superseded" | "forgotten";

/** The current head revision of one memory chain, as derived by projectLifecycle. */
export interface MemoryHead {
  memoryId: string;
  revisionId: string;
  state: MemoryLifecycleState;
  seq: number;
  scope: string;
  createdAt: string;
  ttl?: string;
}

/** One scope's dirty/consolidation bookkeeping, as derived by selectDirtyScopes. */
export interface DirtyScope {
  scope: string;
  lastConsolidatedSeq: number;
  newContentCount: number;
  latestSeq: number;
}

export interface MemoryPromoteArguments {
  scope: string;
  memory_id: string;
  reason?: string;
}
