import { JsonlMemoryStore } from "../store/store.js";
import { createMemoryIndex } from "../store/sqliteIndex.js";
import { CausalEventStore } from "../store/causalStore.js";
import type { MemoryEmbeddingProvider } from "../store/embedding.js";
import { memoryPolicy } from "../policy/policy.js";
import type {
  MemoryEventInput,
  MemoryKernel,
  MemoryToolCall,
  MemoryToolResult
} from "../contract/types.js";
import {
  CandidateHandle,
  asNumber,
  collectTombstones,
  hasInvalidV1Envelope,
  decide,
  eventText,
  isLocateArguments,
  isRecallableMemoryEvent,
  isSearchArguments,
  makeAudit,
  makeLocateResult,
  makeSearchResult,
  malformed,
  unavailable,
  resolveScope,
  locateCandidateId,
  sanitizePrincipal,
} from "./support.js";
import { prepareSearchCandidates } from "./search.js";
import { forgetMemory, promoteMemory, registerMemory, summarizeMemory } from "./mutations.js";

export interface MemoryKernelConfig {
  runtimeHomePath: string;
  source?: string;
  embeddingProvider?: MemoryEmbeddingProvider;
  /**
   * B62: the causal store the four mutating tools append `memory.write.denied`
   * events to. Callers that already own a CausalEventStore against this same
   * runtimeHomePath (e.g. JsonlMemoryRuntime) MUST pass it here rather than
   * letting the kernel mint its own — two independent CausalEventStore
   * instances against the same causal.jsonl would each bootstrap their own
   * in-memory per-stream seq counter and could stamp colliding seqs.
   */
  causalStore?: CausalEventStore;
}

export class JsonlMemoryKernel implements MemoryKernel {
  private readonly store: JsonlMemoryStore;
  private readonly index;
  private readonly causalStore: CausalEventStore;
  private readonly source: string;
  private readonly embeddingProvider?: MemoryEmbeddingProvider;

  constructor(private readonly config: MemoryKernelConfig) {
    this.store = new JsonlMemoryStore(config.runtimeHomePath);
    this.index = createMemoryIndex({ runtimeHomePath: config.runtimeHomePath });
    this.causalStore = config.causalStore ?? new CausalEventStore(config.runtimeHomePath);
    this.source = this.config.source ?? `mneme/${this.config.runtimeHomePath}`;
    this.embeddingProvider = config.embeddingProvider;
  }

  async search(call: MemoryToolCall): Promise<MemoryToolResult> {
    const startAt = Date.now();
    if (hasInvalidV1Envelope(call.envelope.version)) {
      return malformed(call, "memory.search", "unsupported envelope", startAt);
    }

    const args = call.arguments;
    if (!isSearchArguments(args)) {
      return malformed(call, "memory.search", "memory.search requires { scope, query }", startAt);
    }

    const requester = sanitizePrincipal(call.envelope.principal);
    const scope = resolveScope(args.scope, requester);
    const limit = asNumber(args.limit) || 20;
    const queryText = args.query;

    try {
      const allEvents = await this.store.read();
      await this.index.rebuildFromEvents(allEvents);
      const { candidates: ranked, queryEvents } = await prepareSearchCandidates({
        scope,
        queryText,
        limit,
        allEvents,
        requester,
        embeddingProvider: this.embeddingProvider,
        index: this.index
      });
      const events = queryEvents.map((entry) => entry.event);

      const selected = ranked.slice(0, limit);
      if (selected.length === 0) {
        return {
          request_id: call.request_id,
          tool: "memory.search",
          decision: "deny",
          content: [],
          audit: makeAudit(call, events, startAt)
        };
      }

      return {
        request_id: call.request_id,
        tool: "memory.search",
        decision: decide(selected.map((entry) => entry.decision)),
        content: selected.map((entry) => makeSearchResult(entry.decision, entry.event)),
        audit: makeAudit(call, selected.map((entry) => entry.event), startAt)
      };
    } catch (error) {
      return unavailable(call, "memory.search", String(error instanceof Error ? error.message : error), startAt);
    }
  }

  async locate(call: MemoryToolCall): Promise<MemoryToolResult> {
    const startAt = Date.now();
    if (hasInvalidV1Envelope(call.envelope.version)) {
      return malformed(call, "memory.locate", "unsupported envelope", startAt);
    }

    const args = call.arguments;
    if (!isLocateArguments(args)) {
      return malformed(call, "memory.locate", "memory.locate requires { query }", startAt);
    }

    const requester = sanitizePrincipal(call.envelope.principal);
    const limit = asNumber(args.limit) || 5;

    try {
      const allEvents = await this.store.read();
      await this.index.rebuildFromEvents(allEvents);
      const query = args.query;
      const candidateEvents = (await this.index.query({
        query,
        limit: Math.max(limit * 8, 40)
      })).map((entry) => entry.event)
        .filter((event) => isRecallableMemoryEvent(event) && !collectTombstones(allEvents).has(event.id));

      const tokens = query.toLowerCase()
        .split(/\W+/u)
        .filter((value) => value.length > 3);

      const byHandle = new Map<string, CandidateHandle>();
      for (const event of candidateEvents) {
        const decision = memoryPolicy({
          request: requester,
          candidate: event,
          activeScope: requester
        }).decision;
        if (decision === "deny" || decision === "unavailable" || decision === "malformed_request") {
          continue;
        }

        const score = tokens.filter((token) => eventText(event).toLowerCase().includes(token)).length;
        const key = locateCandidateId(event);
        const next = byHandle.get(key);
        const handle: CandidateHandle = {
          decision,
          event,
          score,
          eventIds: [event.id],
          scope: event.scope
        };

        if (!next) {
          byHandle.set(key, handle);
          continue;
        }

        next.eventIds.push(event.id);
        next.score = Math.max(next.score, score);
      }

      const selected = [...byHandle.values()]
        .sort((left, right) => right.score - left.score || Date.parse(right.event.createdAt) - Date.parse(left.event.createdAt))
        .slice(0, limit);

      if (selected.length === 0) {
        return { request_id: call.request_id, tool: "memory.locate", decision: "deny", content: [], audit: makeAudit(call, [], startAt) };
      }

      const locatedEvent = await this.store.append({
        type: "memory.located",
        principal: requester,
        scope: resolveScope("current", requester),
        visibility: "private",
        source: this.source,
        content: {
          kind: "text",
          text: `Located ${selected.length} memory candidate(s).`
        },
        tags: ["locate"],
        entities: [requester.agentId, requester.scope],
        sensitivity: "normal",
        parentEventIds: selected.flatMap((entry) => entry.eventIds)
      } satisfies MemoryEventInput);

      return {
        request_id: call.request_id,
        tool: "memory.locate",
        decision: "locate_only",
        content: selected.map((entry) => makeLocateResult(entry)),
        audit: makeAudit(call, [locatedEvent, ...selected.map((entry) => entry.event)], startAt)
      };
    } catch (error) {
      return unavailable(call, "memory.locate", String(error instanceof Error ? error.message : error), startAt);
    }
  }

  register(call: MemoryToolCall): Promise<MemoryToolResult> {
    return registerMemory(this.store, this.causalStore, call);
  }

  summarize(call: MemoryToolCall): Promise<MemoryToolResult> {
    return summarizeMemory(this.store, this.causalStore, this.source, call);
  }

  forget(call: MemoryToolCall): Promise<MemoryToolResult> {
    return forgetMemory(this.store, this.causalStore, this.source, call);
  }

  promote(call: MemoryToolCall): Promise<MemoryToolResult> {
    return promoteMemory(this.store, this.causalStore, this.source, call);
  }
}

export const createMemoryKernel = (config: MemoryKernelConfig): MemoryKernel => new JsonlMemoryKernel(config);
