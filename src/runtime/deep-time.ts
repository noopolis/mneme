import { selectDirtyScopes } from "../store/lifecycle.js";
import type { MemoryStore } from "../store/store.js";
import type { DirtyScope, MemoryEvent, MemoryEventInput } from "../contract/types.js";

const DEEP_TIME_SOURCE = "mneme/deep-time";
const DEEP_TIME_PRINCIPAL = { agentId: "mneme-deep-time", scope: "global" as const };

export interface DeepTimeConsolidation {
  /** The ledger seq snapshot taken at pass START, for this scope. */
  highWaterSeq: number;
  /**
   * Appends the memory.consolidated marker (system origin) with the
   * pass-start highWaterSeq. Call this LAST, after all dream-pass output
   * writes. If the process crashes before commit() runs, no marker is
   * written and the scope stays dirty — a rerun is safe.
   */
  commit(outputEventIds: string[]): Promise<MemoryEvent>;
}

export interface DeepTimeSession {
  selectDirtyScopes(): Promise<DirtyScope[]>;
  beginConsolidation(scope: string): Promise<DeepTimeConsolidation>;
}

const latestSeqFor = (events: MemoryEvent[]): number =>
  events.reduce((max, event) => (event.seq > max ? event.seq : max), 0);

/**
 * The deep-time (dream) consolidation session: selects dirty scopes and
 * runs one consolidation pass per scope. This is harness code, not a model
 * tool — memory.consolidated markers are written directly through the
 * store, never through the kernel/tool-call envelope path. See
 * specs burnlist B59 section 2 for the transactional high-water-mark rule.
 */
export const createDeepTimeSession = (store: MemoryStore): DeepTimeSession => ({
  async selectDirtyScopes(): Promise<DirtyScope[]> {
    const events = await store.read();
    return selectDirtyScopes(events);
  },

  async beginConsolidation(scope: string): Promise<DeepTimeConsolidation> {
    const events = await store.read({ scope });
    // Snapshot the high-water mark at pass START (not at commit time). Any
    // dirtying event written *during* the pass carries a seq beyond this
    // snapshot and stays dirty afterward — this is what makes concurrent or
    // mid-pass awake writes safely re-appear as dirty on the next pass.
    const highWaterSeq = latestSeqFor(events);

    return {
      highWaterSeq,
      async commit(outputEventIds: string[]): Promise<MemoryEvent> {
        return store.append({
          type: "memory.consolidated",
          principal: DEEP_TIME_PRINCIPAL,
          scope,
          visibility: "private",
          source: DEEP_TIME_SOURCE,
          content: {
            kind: "text",
            text: `Consolidated scope ${scope} through seq ${highWaterSeq} (${outputEventIds.length} output event(s)).`
          },
          tags: ["consolidated"],
          entities: [],
          sensitivity: "normal",
          parentEventIds: outputEventIds,
          origin: "system",
          highWaterSeq
        } satisfies MemoryEventInput);
      }
    };
  }
});
