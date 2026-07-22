import { buildWakePacketText } from "../recall/recall.js";
import { JsonlMemoryStore } from "../store/store.js";
import { createMemoryIndex } from "../store/sqliteIndex.js";
import { appendMemoryRecalledEvent, appendMemoryWrittenEvent, CausalEventStore } from "../store/causalStore.js";
import { memoryScopeId } from "../identity/ids.js";
import { readMemoryContext, resolveScopePlan } from "../identity/scope.js";
import { createMemoryKernel } from "../kernel/kernel.js";
import { createHash } from "node:crypto";
import path from "node:path";
import { createEphemeralMemoryAuthority, createMemoryAuthorityHandoff, type MemoryAuthorityConfig } from "../policy/authority.js";
import { memoryStreamId, resolveCausalRunId } from "../contract/causal.js";
import {
  buildDecisionEvents,
  buildRecallInput,
  clampTokenBudget,
  defaultSource,
  deniedMemoryEvents,
  normalizeScopeIds,
  readByScopes,
  recallableEvents,
  selectToolSummary
} from "./support.js";
import { buildShuffledRecall, guardKernelForRecallMode, resolveRecallMode } from "./recallMode.js";
import type { MemoryRecallMode } from "./recallMode.js";
import type { MemoryEmbeddingProvider } from "../store/embedding.js";
import type {
  MemoryEvent,
  MemoryEventInput,
  MemoryKernel,
  MemoryPrepareTurnResult,
  MemoryRecallRequest,
  MemoryRuntime,
  MemoryTurnRecord,
  WakeMemoryContext
} from "../contract/types.js";

const resolveContextFromRequest = (request: MemoryRecallRequest): WakeMemoryContext => {
  return readMemoryContext({
    kind: request.kind,
    from: request.from,
    text: request.text,
    id: request.eventId,
    context: request.context
  });
};

export interface JsonlMemoryRuntimeConfig {
  agentId: string;
  runtimeHomePath: string;
  source?: string;
  tokenBudget?: number;
  embeddingProvider?: MemoryEmbeddingProvider;
  /** B70 ablation knob; see recallMode.ts. Resolution order: this field, then
   * the MNEME_RECALL_MODE env var, then default "on". */
  recallMode?: MemoryRecallMode;
  /** Trusted deployment adapter may supply a stable verifier across restarts. */
  authority?: MemoryAuthorityConfig;
}

export const memoryAuthorityRuntimeId = (runtimeHomePath: string): string =>
  `runtime:${createHash("sha256").update(path.resolve(runtimeHomePath)).digest("hex")}`;

export class JsonlMemoryRuntime implements MemoryRuntime {
  private readonly store: JsonlMemoryStore;
  private readonly index: ReturnType<typeof createMemoryIndex>;
  private readonly causalStore: CausalEventStore;
  private readonly source: string;
  private readonly defaultTokenBudget: number;
  private readonly embeddingProvider?: MemoryEmbeddingProvider;
  private readonly recallMode: MemoryRecallMode;
  public readonly kernel: MemoryKernel;
  public readonly authority;

  constructor(private readonly options: JsonlMemoryRuntimeConfig) {
    this.store = new JsonlMemoryStore(options.runtimeHomePath);
    this.index = createMemoryIndex({ runtimeHomePath: options.runtimeHomePath });
    this.causalStore = new CausalEventStore(options.runtimeHomePath);
    this.embeddingProvider = options.embeddingProvider;
    this.source = options.source ?? defaultSource(options.agentId);
    this.defaultTokenBudget = clampTokenBudget(options.tokenBudget);
    this.recallMode = resolveRecallMode(options.recallMode);
    const runtimeId = memoryAuthorityRuntimeId(options.runtimeHomePath);
    const generatedAuthority = createEphemeralMemoryAuthority(options.agentId, runtimeId);
    const authority = options.authority ?? generatedAuthority.config;
    if (authority.bankId !== options.agentId || authority.runtimeId !== runtimeId) {
      throw new Error("memory authority does not match this bank/runtime");
    }
    this.authority = options.authority ? createMemoryAuthorityHandoff(authority) : generatedAuthority.handoff;
    this.kernel = guardKernelForRecallMode(
      createMemoryKernel({
        runtimeHomePath: options.runtimeHomePath,
        source: this.source,
        embeddingProvider: this.embeddingProvider,
        // Share this runtime's own CausalEventStore rather than letting the
        // kernel mint a second one against the same causal.jsonl (see
        // kernel/kernel.ts's MemoryKernelConfig.causalStore doc comment).
        causalStore: this.causalStore,
        authority
      }),
      this.recallMode,
      { runtimeHomePath: options.runtimeHomePath, authority, causalStore: this.causalStore }
    );
  }

  async prepareTurn(request: MemoryRecallRequest): Promise<MemoryPrepareTurnResult> {
    const context = resolveContextFromRequest(request);
    const scopePlan = resolveScopePlan({
      agentId: this.options.agentId,
      context,
      wake: {
        id: request.eventId,
        kind: request.kind,
        from: request.from
      }
    });

    const scopeIds = normalizeScopeIds(scopePlan.readableScopes.map(memoryScopeId));
    const maxTokens = request.tokenBudget ?? this.defaultTokenBudget;

    // off: skip the ledger read and embedding lookup entirely (never touch
    // recall candidates), so buildRecallInput below runs against events:[]
    // and naturally produces an empty packet, zero memory.recalled, and no
    // denial-audit. shuffled still needs the full "on"-mode candidate/
    // selection pipeline to compute the decoy substitution.
    let events: MemoryEvent[] = [];
    let embeddingScores: Map<string, number> | undefined;

    if (this.recallMode !== "off") {
      events = recallableEvents(await readByScopes(this.store, scopeIds));

      if (this.embeddingProvider && request.text.trim().length > 0) {
        try {
          const allEvents = await this.store.read();
          await this.index.rebuildFromEvents(allEvents);
          const queryVector = await this.embeddingProvider.embed(request.text);
          const indexed = await this.index.queryByEmbedding({
            allowedScopes: scopeIds,
            queryVector,
            embeddingProvider: this.embeddingProvider,
            limit: 80
          });

          const recallable = recallableEvents(indexed.map((entry) => entry.event));
          if (recallable.length > 0) {
            events = recallable;
            embeddingScores = new Map(indexed.map((entry) => [entry.event.id, entry.score]));
          }
        } catch (_error) {
          // Keep existing lexical recall behavior when embedding is unavailable.
        }
      }
    }

    let recall: ReturnType<typeof buildRecallInput> | ReturnType<typeof buildShuffledRecall>;
    let degenerate = false;

    if (this.recallMode === "shuffled") {
      const shuffled = buildShuffledRecall({
        actor: scopePlan.activePrincipal,
        scopeIds,
        events,
        text: request.text,
        maxTokens,
        embeddingScores
      });
      recall = shuffled;
      degenerate = shuffled.degenerate;
    } else {
      recall = buildRecallInput({
        actor: scopePlan.activePrincipal,
        scopeIds,
        events,
        text: request.text,
        maxTokens,
        embeddingScores
      });
    }

    // One noopolis.causal-event.v1 `memory.recalled` event per selected
    // memory (see src/contract/causal.ts, specs/CAUSAL.md). cause_event_ids
    // point at the wake request that triggered this recall; principal_id is
    // this runtime's own authenticated agent identity, never model output;
    // run_id comes from NOOPOLIS_RUN_ID, never model output. In "off" mode
    // recall.selected is always empty, so this loop never runs; in
    // "shuffled" mode it stamps the decoys actually injected, never the
    // excluded on-mode selection.
    const causalRunId = resolveCausalRunId();
    // Collected in `recall.selected` order so callers that need to chain
    // `cause_event_ids` to these specific memory.recalled events (e.g.
    // @noopolis/daimon's stampTurnInputSubmitted) can zip them against
    // `recall.selectedEventIds` positionally, though the ids themselves are
    // the only thing that matters for reconciliation (see
    // MemoryPrepareTurnResult.recalledCausalEventIds doc comment).
    const recalledCausalEventIds: string[] = [];
    for (const entry of recall.selected) {
      const recalledEvent = await appendMemoryRecalledEvent(this.causalStore, {
        runId: causalRunId,
        agentId: this.options.agentId,
        principalId: `agent:${this.options.agentId}`,
        causeEventIds: [request.eventId],
        // B70 fix: memory_id must be the chain root, not the (possibly
        // revised) event id. entry.event.memoryId is only set on revision
        // events; a root event carries its own id as its chain root.
        memoryId: entry.event.memoryId ?? entry.event.id,
        revisionId: entry.event.id,
        scope: entry.event.scope,
        contentSha256: entry.event.checksum
      });
      recalledCausalEventIds.push(recalledEvent.event_id);
    }

    // Mode stamp (ledger proof), appended in every mode so an evidence
    // reader can trust the ledger over recall-adjacency: additive causal
    // event type, ignored by root conformance's unknown-type tolerance.
    await this.causalStore.append({
      runId: causalRunId,
      streamId: memoryStreamId(this.options.agentId),
      type: "memory.recall.mode",
      principalId: `agent:${this.options.agentId}`,
      causeEventIds: [request.eventId],
      payload: {
        mode: this.recallMode,
        wake_event_id: request.eventId,
        injected_count: recall.selected.length,
        degenerate
      }
    });

    const denied = deniedMemoryEvents({
      requester: scopePlan.activePrincipal,
      activeScope: scopePlan.activePrincipal,
      events,
      selectedIds: new Set(recall.audit.selectedEventIds)
    });

    if (denied.length > 0) {
      await this.store.appendBatch(denied.map(({ event, reason }) => ({
        type: "memory.denied",
        principal: scopePlan.activePrincipal,
        scope: memoryScopeId(scopePlan.activePrincipal),
        visibility: "private",
        source: this.source,
        content: {
          kind: "text",
          text: `Denied ${event.id}: ${reason}`
        },
        tags: ["denied", "recall"],
        entities: [event.id],
        parentEventIds: [event.id],
        sensitivity: "normal"
      } satisfies MemoryEventInput)));
    }

    const wakeText = [
      "## Wake",
      `id: ${request.eventId}`,
      `kind: ${request.kind}`,
      `from: ${request.from ?? "operator"}`,
      `network: ${context.networkId ?? "global"}`,
      `room: ${context.roomId ?? "global"}`,
      "",
      request.text
    ].join("\n");

    const promptText = buildWakePacketText(context, wakeText, recall.packet);

    return {
      principal: scopePlan.activePrincipal,
      // This is the public trusted handoff for adapter-owned tool contexts;
      // adapters do not need to import Mneme's private scope planner.
      allowedScopes: Object.freeze([...scopeIds]),
      packet: recall.packet,
      promptText,
      recall: recall.audit,
      recalledCausalEventIds
    };
  }

  async recordTurn(input: MemoryTurnRecord): Promise<void> {
    // Detach the trusted record synchronously so caller mutations cannot
    // change bank identity or evidence inputs across the reads below.
    const record = structuredClone(input);
    if (record.principal.agentId !== this.options.agentId) {
      throw new Error("memory turn principal does not own this runtime bank");
    }
    if (!/^(simfile|moltnet|mneme|daimon):.+$/u.test(record.request.eventId)) {
      throw new Error("memory turn requires a causal request event id");
    }
    const causalRunId = resolveCausalRunId();
    const scope = memoryScopeId(record.principal);
    const parentEventIds = (await this.store.read({
      principalAgentId: record.principal.agentId,
      principalScope: record.principal.scope
    })).map((event) => event.id);

    const recall = record.recall ?? {
      totalCandidates: 0,
      selectedEventIds: [],
      selected: [],
      decisions: [],
      tokenBudgetUsed: 0,
      redactionCount: 0
    };

    const events: MemoryEventInput[] = buildDecisionEvents({
      principal: record.principal,
      scope,
      source: this.source,
      request: record.request,
      packet: record.prompt,
      recall,
      result: record.result,
      outputText: record.outputText,
      error: record.error,
      parentEventIds
    });

    const toolSummary = selectToolSummary(record.toolEvents ?? []);
    if (toolSummary) {
      toolSummary.parentEventIds = parentEventIds;
      toolSummary.scope = scope;
      toolSummary.principal = record.principal;
      events.push(toolSummary);
    }

    const persisted = await this.store.appendBatch(events);
    for (const event of persisted) {
      await appendMemoryWrittenEvent(this.causalStore, {
        runId: causalRunId,
        agentId: this.options.agentId,
        principalId: `agent:${this.options.agentId}`,
        causeEventIds: [record.request.eventId],
        memoryId: event.memoryId ?? event.id,
        revisionId: event.id,
        scope: event.scope,
        contentSha256: event.checksum
      });
    }
  }
}

export const createMemoryRuntime = (options: JsonlMemoryRuntimeConfig): MemoryRuntime =>
  new JsonlMemoryRuntime(options);
