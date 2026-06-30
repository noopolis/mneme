import { JsonlMemoryStore } from "../store/store.js";
import { memoryPolicy } from "../policy/policy.js";
import { createMemoryIndex } from "../store/sqliteIndex.js";
import { runRecall } from "../recall/recall.js";
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
  isForgetArguments,
  isLocateArguments,
  isRegisterArguments,
  isRecallableMemoryEvent,
  isSearchArguments,
  isSummarizeArguments,
  makeAudit,
  matchesQuery,
  makeLocateResult,
  makeSearchResult,
  malformed,
  unavailable,
  policyText,
  resolveScope,
  locateCandidateId,
  sanitizePrincipal,
} from "./support.js";

export interface MemoryKernelConfig {
  runtimeHomePath: string;
  source?: string;
}

export class JsonlMemoryKernel implements MemoryKernel {
  private readonly store: JsonlMemoryStore;
  private readonly index;
  private readonly source: string;

  constructor(private readonly config: MemoryKernelConfig) {
    this.store = new JsonlMemoryStore(config.runtimeHomePath);
    this.index = createMemoryIndex({ runtimeHomePath: config.runtimeHomePath });
    this.source = this.config.source ?? `mneme/${this.config.runtimeHomePath}`;
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

    try {
      const allEvents = await this.store.read();
      await this.index.rebuildFromEvents(allEvents);
      const indexed = await this.index.query({
        allowedScopes: scope === "all" ? undefined : [scope],
        query: args.query,
        limit: Math.max(limit * 4, 40)
      });

      const events = indexed.map((entry) => entry.event);
      const tombstones = collectTombstones(allEvents);
      const filteredEvents = events
        .filter((event) => isRecallableMemoryEvent(event) && !tombstones.has(event.id))
        .filter((event) => matchesQuery(event, args.query));

      const selections = scope === "all"
        ? filteredEvents.map((event) => ({
          event,
          decision: memoryPolicy({ request: requester, candidate: event, activeScope: requester }).decision
        })).filter((entry) => entry.decision !== "deny")
          .sort((left, right) => Date.parse(right.event.createdAt) - Date.parse(left.event.createdAt))
        : runRecall({
          actor: requester,
          scopeIds: [scope],
          events: filteredEvents,
          query: args.query,
          maxTokens: limit * 80
        }).selected.map((entry) => ({ event: entry.event, decision: entry.decision }));

      const selected = selections.slice(0, limit);
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

  async register(call: MemoryToolCall): Promise<MemoryToolResult> {
    const startAt = Date.now();
    if (hasInvalidV1Envelope(call.envelope.version)) {
      return malformed(call, "memory.register", "unsupported envelope", startAt);
    }
    const args = call.arguments;
    if (!isRegisterArguments(args)) {
      return malformed(call, "memory.register", "memory.register requires evidence and content fields", startAt);
    }

    const principal = args.principal
      ? sanitizePrincipal(args.principal)
      : sanitizePrincipal(call.envelope.principal);
    try {
      const event = await this.store.append({
        type: "memory.registered",
        principal,
        scope: resolveScope(args.scope, principal),
        visibility: args.visibility,
        source: args.source_type,
        content: args.content,
        tags: ["registered", principal.scope, args.visibility],
        entities: [principal.agentId, principal.scope],
        sensitivity: args.sensitivity,
        parentEventIds: args.evidence_event_ids,
        confidence: args.confidence
      } satisfies MemoryEventInput);

      return {
        request_id: call.request_id,
        tool: "memory.register",
        decision: "allow_raw",
        content: [{
          kind: "memory",
          text: "Registered memory with explicit evidence.",
          event_ids: [event.id],
          scope: event.scope,
          principal: event.principal,
          redactions: [],
          confidence: args.confidence
        }],
        audit: makeAudit(call, [event], startAt)
      };
    } catch (error) {
      return unavailable(call, "memory.register", String(error instanceof Error ? error.message : error), startAt);
    }
  }

  async summarize(call: MemoryToolCall): Promise<MemoryToolResult> {
    const startAt = Date.now();
    if (hasInvalidV1Envelope(call.envelope.version)) {
      return malformed(call, "memory.summarize", "unsupported envelope", startAt);
    }

    const args = call.arguments;
    if (!isSummarizeArguments(args)) {
      return malformed(call, "memory.summarize", "memory.summarize requires { scope }", startAt);
    }

    const requester = sanitizePrincipal(call.envelope.principal);
    const scope = resolveScope(args.scope, requester);
    const horizon = Math.min(asNumber(args.horizon) || 12, 40);

    try {
      const events = await this.store.read({ scope });
      const tombstones = collectTombstones(events);
      const sourceIds: string[] = [];

      const lines = events
        .filter((event) => isRecallableMemoryEvent(event) && !tombstones.has(event.id))
        .map((event) => ({
          event,
          decision: memoryPolicy({ request: requester, candidate: event, activeScope: requester }).decision
        }))
        .filter((entry) => entry.decision !== "deny")
        .slice(0, horizon)
        .map((entry) => {
          sourceIds.push(entry.event.id);
          return `${entry.event.createdAt}: ${policyText(entry.decision, eventText(entry.event))}`;
        });

      if (sourceIds.length === 0) {
        return { request_id: call.request_id, tool: "memory.summarize", decision: "deny", content: [], audit: makeAudit(call, [], startAt) };
      }

      const summary = await this.store.append({
        type: "memory.summarized",
        principal: requester,
        scope,
        visibility: "private",
        source: this.source,
        content: { kind: "text", text: lines.join("\n") },
        tags: ["summary", ...sourceIds],
        entities: [requester.agentId, requester.scope],
        sensitivity: "normal",
        confidence: 1,
        parentEventIds: sourceIds
      } satisfies MemoryEventInput);

      return {
        request_id: call.request_id,
        tool: "memory.summarize",
        decision: "allow_summary",
        content: [{
          kind: "narrative",
          text: lines.join("\n"),
          event_ids: sourceIds,
          scope,
          principal: requester,
          redactions: [],
          confidence: 1
        }],
        audit: makeAudit(call, [summary], startAt)
      };
    } catch (error) {
      return unavailable(call, "memory.summarize", String(error instanceof Error ? error.message : error), startAt);
    }
  }

  async forget(call: MemoryToolCall): Promise<MemoryToolResult> {
    const startAt = Date.now();
    if (hasInvalidV1Envelope(call.envelope.version)) {
      return malformed(call, "memory.forget", "unsupported envelope", startAt);
    }
    const args = call.arguments;
    if (!isForgetArguments(args)) {
      return malformed(call, "memory.forget", "memory.forget requires { scope, event_ids }", startAt);
    }

    const requester = sanitizePrincipal(call.envelope.principal);
    try {
      const event = await this.store.append({
        type: "memory.forgotten",
        principal: requester,
        scope: resolveScope(args.scope, requester),
        visibility: "private",
        source: this.source,
        content: {
          kind: "text",
          text: `Tombstone for ${args.event_ids.length} event(s).`
        },
        tags: ["forget", "tombstone"],
        entities: [requester.agentId, requester.scope],
        sensitivity: "secret",
        confidence: 1,
        parentEventIds: args.event_ids
      } satisfies MemoryEventInput);

      return {
        request_id: call.request_id,
        tool: "memory.forget",
        decision: "allow_raw",
        content: [{
          kind: "memory",
          text: `Tombstone written for ${args.event_ids.length} event(s).`,
          event_ids: [event.id],
          scope: event.scope,
          principal: event.principal,
          redactions: ["content-redacted"],
          confidence: 1
        }],
        audit: makeAudit(call, [event], startAt)
      };
    } catch (error) {
      return unavailable(call, "memory.forget", String(error instanceof Error ? error.message : error), startAt);
    }
  }
}

export const createMemoryKernel = (config: MemoryKernelConfig): MemoryKernel => new JsonlMemoryKernel(config);
