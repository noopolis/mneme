import { JsonlMemoryStore } from "../store/store.js";
import { createMemoryIndex } from "../store/sqliteIndex.js";
import { CausalEventStore } from "../store/causalStore.js";
import { appendToolOutcomeEvent, appendToolRequestEvent } from "../store/causalStore.js";
import type { MemoryEmbeddingProvider } from "../store/embedding.js";
import { memoryPolicy } from "../policy/policy.js";
import { MemoryAuthorityGuard, snapshotMemoryToolCall, type MemoryAuthorityConfig } from "../policy/authority.js";
import { createHash } from "node:crypto";
import { resolveCausalRunId } from "../contract/causal.js";
import type {
  MemoryEventInput,
  MemoryKernel,
  MemoryToolCall,
  MemoryToolName,
  MemoryToolResult
} from "../contract/types.js";
import {
  CandidateHandle,
  asNumber,
  canExposeEventId,
  collectTombstones,
  hasInvalidV1Envelope,
  decide,
  eventText,
  isLocateArguments,
  isRecallableMemoryEvent,
  isSearchArguments,
  hashArgumentsForEvidence,
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
  /** A deployment-owned HMAC verifier. Omission is explicitly fail-closed. */
  authority?: MemoryAuthorityConfig;
}

export class JsonlMemoryKernel implements MemoryKernel {
  private readonly store: JsonlMemoryStore;
  private readonly index;
  private readonly causalStore: CausalEventStore;
  private readonly source: string;
  private readonly embeddingProvider?: MemoryEmbeddingProvider;
  private readonly authority: MemoryAuthorityGuard;

  constructor(private readonly config: MemoryKernelConfig) {
    this.store = new JsonlMemoryStore(config.runtimeHomePath);
    this.index = createMemoryIndex({ runtimeHomePath: config.runtimeHomePath });
    this.causalStore = config.causalStore ?? new CausalEventStore(config.runtimeHomePath);
    this.source = this.config.source ?? `mneme/${this.config.runtimeHomePath}`;
    this.embeddingProvider = config.embeddingProvider;
    this.authority = new MemoryAuthorityGuard(config.runtimeHomePath, config.authority);
  }

  private async outcome(call: MemoryToolCall, tool: MemoryToolName, decision: MemoryToolResult["decision"], verified: boolean): Promise<void> {
    const principal = verified ? call.envelope.principal.agentId : "mneme-system";
    await appendToolOutcomeEvent(this.causalStore, {
      runId: resolveCausalRunId(), agentId: principal, principalId: verified ? `agent:${principal}` : "system:mneme",
      causeEventIds: verified ? [call.envelope.wake_id] : [], tool, decision,
      argumentHash: hashArgumentsForEvidence(call.arguments),
      requestHash: createHash("sha256").update(call.request_id).digest("hex"),
      ...(verified && call.envelope.authority ? { authorityHash: createHash("sha256").update(call.envelope.authority).digest("hex") } : {})
    });
  }

  /** MCP has no upstream wake event, so persist its Mneme-owned request fact
   * before any lifecycle or outcome event is allowed to cite it. */
  private async requestParent(call: MemoryToolCall, tool: MemoryToolName): Promise<void> {
    if (call.envelope.transport !== "mcp") return;
    const principal = call.envelope.principal.agentId;
    await appendToolRequestEvent(this.causalStore, {
      runId: resolveCausalRunId(),
      agentId: principal,
      principalId: `agent:${principal}`,
      eventId: call.envelope.wake_id,
      tool,
      argumentHash: hashArgumentsForEvidence(call.arguments),
      requestHash: createHash("sha256").update(call.request_id).digest("hex"),
      authorityHash: createHash("sha256").update(call.envelope.authority ?? "").digest("hex")
    });
  }

  private async execute(
    call: MemoryToolCall,
    tool: MemoryToolName,
    work: (verifiedCall: MemoryToolCall) => Promise<MemoryToolResult>
  ): Promise<MemoryToolResult> {
    const startAt = Date.now();
    let attemptedCall: MemoryToolCall;
    try {
      // Detach the complete call before the first await. The authority guard
      // canonicalizes once more at its own public boundary and returns the
      // verified frozen value used below.
      attemptedCall = snapshotMemoryToolCall(call);
    } catch (error) {
      const result = malformed(call, tool, error instanceof Error ? error.message : "invalid authority", startAt);
      try { await this.outcome(call, tool, "malformed_request", false); } catch { return unavailable(call, tool, "memory evidence unavailable", startAt); }
      return result;
    }

    if (attemptedCall.tool !== tool) {
      const result = malformed(attemptedCall, tool, "authority tool does not match invocation", startAt);
      try { await this.outcome(attemptedCall, tool, "malformed_request", false); } catch { return unavailable(attemptedCall, tool, "memory evidence unavailable", startAt); }
      return result;
    }

    let verifiedCall: MemoryToolCall;
    try {
      verifiedCall = await this.authority.consume(attemptedCall);
    } catch (error) {
      const result = malformed(attemptedCall, tool, error instanceof Error ? error.message : "invalid authority", startAt);
      try { await this.outcome(attemptedCall, tool, "malformed_request", false); } catch { return unavailable(attemptedCall, tool, "memory evidence unavailable", startAt); }
      return result;
    }

    try {
      await this.requestParent(verifiedCall, tool);
    } catch {
      // An MCP request parent is required before any effect can cite it. If
      // that evidence write fails, do not execute and do not fabricate an
      // unauthenticated system outcome for an authenticated attempt.
      return unavailable(verifiedCall, tool, "memory evidence unavailable", startAt);
    }
    let result: MemoryToolResult;
    try { result = await work(verifiedCall); } catch { result = unavailable(verifiedCall, tool, "memory service unavailable", startAt); }
    try { await this.outcome(verifiedCall, tool, result.decision, true); } catch { return unavailable(verifiedCall, tool, "memory evidence unavailable", startAt); }
    return result;
  }

  async search(call: MemoryToolCall): Promise<MemoryToolResult> {
    return this.execute(call, "memory.search", (verifiedCall) => this.searchAuthorized(verifiedCall));
  }

  private async searchAuthorized(call: MemoryToolCall): Promise<MemoryToolResult> {
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
    const allowedScopes = this.allowedScopes(call, requester);
    if (scope !== "all" && !allowedScopes.includes(scope)) {
      return malformed(call, "memory.search", "scope is not authorized", startAt);
    }
    const limit = asNumber(args.limit) || 20;
    const queryText = args.query;

    try {
      const allEvents = await this.store.read();
      await this.index.rebuildFromEvents(allEvents);
      const { candidates: ranked } = await prepareSearchCandidates({
        scope,
        queryText,
        limit,
        allEvents,
        requester,
        allowedScopes,
        embeddingProvider: this.embeddingProvider,
        index: this.index
      });
      const selected = ranked.slice(0, limit);
      if (selected.length === 0) {
        return {
          request_id: call.request_id,
          tool: "memory.search",
          decision: "deny",
          content: [],
          audit: makeAudit(call, [], startAt)
        };
      }

      return {
        request_id: call.request_id,
        tool: "memory.search",
        decision: decide(selected.map((entry) => entry.decision)),
        content: selected.map((entry) => makeSearchResult(entry.decision, entry.event)),
        audit: makeAudit(call, selected.filter((entry) => canExposeEventId(entry.decision)).map((entry) => entry.event), startAt)
      };
    } catch {
      return unavailable(call, "memory.search", "memory service unavailable", startAt);
    }
  }

  private allowedScopes(call: MemoryToolCall, requester: MemoryToolCall["envelope"]["principal"]): string[] {
    const minted = call.envelope.allowed_scopes;
    if (!minted || minted.length === 0) return [resolveScope("current", requester)];
    return [...new Set(minted.map((scope) => resolveScope(scope, requester)))];
  }

  async locate(call: MemoryToolCall): Promise<MemoryToolResult> {
    return this.execute(call, "memory.locate", (verifiedCall) => this.locateAuthorized(verifiedCall));
  }

  private async locateAuthorized(call: MemoryToolCall): Promise<MemoryToolResult> {
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
        allowedScopes: this.allowedScopes(call, requester),
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
        audit: makeAudit(call, [locatedEvent, ...selected.filter((entry) => canExposeEventId(entry.decision)).map((entry) => entry.event)], startAt)
      };
    } catch {
      return unavailable(call, "memory.locate", "memory service unavailable", startAt);
    }
  }

  async register(call: MemoryToolCall): Promise<MemoryToolResult> {
    return this.execute(call, "memory.register", (verifiedCall) => registerMemory(this.store, this.causalStore, verifiedCall));
  }

  async summarize(call: MemoryToolCall): Promise<MemoryToolResult> {
    return this.execute(call, "memory.summarize", (verifiedCall) => summarizeMemory(this.store, this.causalStore, this.source, verifiedCall));
  }

  async forget(call: MemoryToolCall): Promise<MemoryToolResult> {
    return this.execute(call, "memory.forget", (verifiedCall) => forgetMemory(this.store, this.causalStore, this.source, verifiedCall));
  }

  async promote(call: MemoryToolCall): Promise<MemoryToolResult> {
    return this.execute(call, "memory.promote", (verifiedCall) => promoteMemory(this.store, this.causalStore, this.source, verifiedCall));
  }
}

export const createMemoryKernel = (config: MemoryKernelConfig): MemoryKernel => new JsonlMemoryKernel(config);
