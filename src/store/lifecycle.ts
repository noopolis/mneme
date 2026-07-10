import type {
  DirtyScope,
  MemoryEvent,
  MemoryEventType,
  MemoryHead,
  MemoryLifecycleState
} from "../contract/types.js";

/**
 * B59 lifecycle projection: a pure, rebuildable read model over the raw
 * MemoryEvent[] ledger (events.jsonl remains the only source of truth).
 * See specs/burnlists B59.md sections 1-2 for the frozen state machine.
 */

export const CONTENT_EVENT_TYPES = [
  "memory.observed",
  "memory.claimed",
  "memory.registered",
  "memory.summarized"
] as const satisfies ReadonlyArray<MemoryEventType>;

export const AUDIT_EVENT_TYPES = [
  "memory.recalled",
  "memory.located",
  "memory.denied"
] as const satisfies ReadonlyArray<MemoryEventType>;

const CONTENT_EVENT_TYPE_SET = new Set<MemoryEventType>(CONTENT_EVENT_TYPES);

/** Transition + content types that dirty a scope when awake-origin. Never includes audit types or "promoted". */
const DIRTYING_EVENT_TYPE_SET = new Set<MemoryEventType>([
  ...CONTENT_EVENT_TYPES,
  "memory.forgotten"
]);

/** DIRTYING(e) = e.origin != "dream" AND e.type in {observed,claimed,registered,summarized,forgotten}. */
export const isDirtyingEvent = (event: MemoryEvent): boolean =>
  event.origin !== "dream" && DIRTYING_EVENT_TYPE_SET.has(event.type);

interface ChainState {
  memoryId: string;
  scope: string;
  headRevisionId: string;
  headSeq: number;
  headCreatedAt: string;
  headTtl?: string;
  state: MemoryLifecycleState;
  /** All revision ids ever accepted into this chain, for fork/cross-chain detection. */
  revisions: Map<string, number>;
}

export interface LifecycleProjection {
  heads: Map<string, MemoryHead>;
  revisionStates: Map<string, MemoryLifecycleState>;
  diagnostics: string[];
}

const bySeqThenId = (left: MemoryEvent, right: MemoryEvent): number => {
  if (left.seq !== right.seq) {
    return left.seq - right.seq;
  }
  return left.id.localeCompare(right.id);
};

/**
 * Replays the raw event ledger into per-memory chain heads and per-revision
 * states. Defensive by design: malformed/racy input (unknown memoryId,
 * cross-chain parents, non-head promotes, revisions against a forgotten
 * chain) is skipped with a diagnostic instead of thrown, because the kernel
 * is the enforcement point at write time — this projection must still
 * replay whatever already landed in the JSONL without crashing.
 */
export const projectLifecycle = (events: MemoryEvent[]): LifecycleProjection => {
  const ordered = [...events].sort(bySeqThenId);
  const chains = new Map<string, ChainState>();
  const revisionToChain = new Map<string, string>();
  const diagnostics: string[] = [];

  const forgetRevision = (revisionId: string): void => {
    const memoryId = revisionToChain.get(revisionId);
    if (!memoryId) {
      return;
    }
    const chain = chains.get(memoryId);
    if (chain) {
      chain.state = "forgotten";
    }
  };

  for (const event of ordered) {
    if (CONTENT_EVENT_TYPE_SET.has(event.type)) {
      const memoryId = event.memoryId ?? event.id;

      if (!event.memoryId) {
        if (chains.has(memoryId)) {
          diagnostics.push(`duplicate-root:${event.id}`);
          continue;
        }
        chains.set(memoryId, {
          memoryId,
          scope: event.scope,
          headRevisionId: event.id,
          headSeq: event.seq,
          headCreatedAt: event.createdAt,
          headTtl: event.ttl,
          state: "active",
          revisions: new Map([[event.id, event.seq]])
        });
        revisionToChain.set(event.id, memoryId);
        continue;
      }

      const chain = chains.get(memoryId);
      if (!chain) {
        diagnostics.push(`unknown-memory-id:${event.id}->${memoryId}`);
        continue;
      }
      if (chain.state === "forgotten") {
        diagnostics.push(`revision-against-forgotten-chain:${event.id}`);
        continue;
      }

      const referencesKnownRevision = event.parentEventIds.some((parentId) => chain.revisions.has(parentId));
      if (!referencesKnownRevision) {
        diagnostics.push(`cross-chain-or-unknown-parent:${event.id}`);
        continue;
      }

      chain.revisions.set(event.id, event.seq);
      chain.headRevisionId = event.id;
      chain.headSeq = event.seq;
      chain.headCreatedAt = event.createdAt;
      chain.headTtl = event.ttl;
      // Promotion does not carry across revisions.
      chain.state = "active";
      revisionToChain.set(event.id, memoryId);
      continue;
    }

    if (event.type === "memory.promoted") {
      const memoryId = event.memoryId;
      if (!memoryId) {
        diagnostics.push(`promote-missing-memory-id:${event.id}`);
        continue;
      }
      const chain = chains.get(memoryId);
      if (!chain) {
        diagnostics.push(`promote-unknown-chain:${event.id}`);
        continue;
      }
      if (chain.state === "forgotten") {
        diagnostics.push(`promote-against-forgotten-chain:${event.id}`);
        continue;
      }
      const targetsHead = event.parentEventIds.includes(chain.headRevisionId);
      if (!targetsHead) {
        diagnostics.push(`non-head-promote-rejected:${event.id}`);
        continue;
      }
      chain.state = "promoted";
      continue;
    }

    if (event.type === "memory.forgotten") {
      // Legacy semantics: parentEventIds carries the tombstoned target ids.
      // Any target that is a known chain revision marks the whole chain
      // forgotten (terminal), regardless of whether it was the head.
      for (const targetId of event.parentEventIds) {
        forgetRevision(targetId);
      }
      continue;
    }

    // Audit types (recalled/located/denied) and memory.consolidated markers
    // have no lifecycle effect; unknown/future types are ignored no-throw.
  }

  const heads = new Map<string, MemoryHead>();
  const revisionStates = new Map<string, MemoryLifecycleState>();

  for (const chain of chains.values()) {
    heads.set(chain.memoryId, {
      memoryId: chain.memoryId,
      revisionId: chain.headRevisionId,
      state: chain.state,
      seq: chain.headSeq,
      scope: chain.scope,
      createdAt: chain.headCreatedAt,
      ttl: chain.headTtl
    });

    for (const revisionId of chain.revisions.keys()) {
      if (chain.state === "forgotten") {
        revisionStates.set(revisionId, "forgotten");
      } else if (revisionId === chain.headRevisionId) {
        revisionStates.set(revisionId, chain.state);
      } else {
        revisionStates.set(revisionId, "superseded");
      }
    }
  }

  return { heads, revisionStates, diagnostics };
};

/**
 * hwm(scope) = max highWaterSeq over memory.consolidated events for scope, else 0.
 * dirty(scope) iff exists e: e.scope==scope AND e.seq > hwm(scope) AND DIRTYING(e).
 * Returns only scopes that are currently dirty, sorted by newContentCount desc.
 */
export const selectDirtyScopes = (events: MemoryEvent[]): DirtyScope[] => {
  const hwmByScope = new Map<string, number>();
  const latestSeqByScope = new Map<string, number>();

  for (const event of events) {
    const latest = latestSeqByScope.get(event.scope) ?? 0;
    if (event.seq > latest) {
      latestSeqByScope.set(event.scope, event.seq);
    }

    if (event.type === "memory.consolidated") {
      const highWaterSeq = event.highWaterSeq ?? 0;
      const currentHwm = hwmByScope.get(event.scope) ?? 0;
      if (highWaterSeq > currentHwm) {
        hwmByScope.set(event.scope, highWaterSeq);
      }
    }
  }

  const dirtyCountByScope = new Map<string, number>();
  for (const event of events) {
    if (!isDirtyingEvent(event)) {
      continue;
    }
    const hwm = hwmByScope.get(event.scope) ?? 0;
    if (event.seq > hwm) {
      dirtyCountByScope.set(event.scope, (dirtyCountByScope.get(event.scope) ?? 0) + 1);
    }
  }

  const result: DirtyScope[] = [];
  for (const [scope, newContentCount] of dirtyCountByScope) {
    if (newContentCount === 0) {
      continue;
    }
    result.push({
      scope,
      lastConsolidatedSeq: hwmByScope.get(scope) ?? 0,
      newContentCount,
      latestSeq: latestSeqByScope.get(scope) ?? 0
    });
  }

  return result.sort((left, right) =>
    right.newContentCount - left.newContentCount || left.scope.localeCompare(right.scope)
  );
};
