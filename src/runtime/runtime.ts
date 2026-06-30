import { buildWakePacketText } from "../recall/recall.js";
import { JsonlMemoryStore } from "../store/store.js";
import { memoryScopeId } from "../identity/ids.js";
import { readMemoryContext, resolveScopePlan } from "../identity/scope.js";
import { createMemoryKernel } from "../kernel/kernel.js";
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
import type {
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
}

export class JsonlMemoryRuntime implements MemoryRuntime {
  private readonly store: JsonlMemoryStore;
  private readonly source: string;
  private readonly defaultTokenBudget: number;
  public readonly kernel: MemoryKernel;

  constructor(private readonly options: JsonlMemoryRuntimeConfig) {
    this.store = new JsonlMemoryStore(options.runtimeHomePath);
    this.source = options.source ?? defaultSource(options.agentId);
    this.defaultTokenBudget = clampTokenBudget(options.tokenBudget);
    this.kernel = createMemoryKernel({
      runtimeHomePath: options.runtimeHomePath,
      source: this.source
    });
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
    const events = recallableEvents(await readByScopes(this.store, scopeIds));
    const recall = buildRecallInput({
      actor: scopePlan.activePrincipal,
      scopeIds,
      events,
      text: request.text,
      maxTokens: request.tokenBudget ?? this.defaultTokenBudget
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
      packet: recall.packet,
      promptText,
      recall: recall.audit
    };
  }

  async recordTurn(input: MemoryTurnRecord): Promise<void> {
    const scope = memoryScopeId(input.principal);
    const parentEventIds = (await this.store.read({
      principalAgentId: input.principal.agentId,
      principalScope: input.principal.scope
    })).map((event) => event.id);

    const recall = input.recall ?? {
      totalCandidates: 0,
      selectedEventIds: [],
      selected: [],
      decisions: [],
      tokenBudgetUsed: 0,
      redactionCount: 0
    };

    const events: MemoryEventInput[] = buildDecisionEvents({
      principal: input.principal,
      scope,
      source: this.source,
      request: input.request,
      packet: input.prompt,
      recall,
      result: input.result,
      outputText: input.outputText,
      error: input.error,
      parentEventIds
    });

    const toolSummary = selectToolSummary(input.toolEvents ?? []);
    if (toolSummary) {
      toolSummary.parentEventIds = parentEventIds;
      toolSummary.scope = scope;
      toolSummary.principal = input.principal;
      events.push(toolSummary);
    }

    await this.store.appendBatch(events);
  }
}

export const createMemoryRuntime = (options: JsonlMemoryRuntimeConfig): MemoryRuntime =>
  new JsonlMemoryRuntime(options);
