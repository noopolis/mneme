import { memoryScopeId } from "../identity/ids.js";
import { memoryPolicy } from "../policy/policy.js";
import { runRecall } from "../recall/recall.js";
import { JsonlMemoryStore } from "../store/store.js";
import type {
  MemoryDecision,
  MemoryEvent,
  MemoryEventInput,
  MemoryPacket,
  MemoryPrepareTurnResult,
  MemoryPrincipalRef,
  MemoryRecallAudit,
  MemoryRecallRequest,
  MemoryTurnRecord,
  MemoryVisibility
} from "../contract/types.js";

export interface MemoryRecallEntry {
  event: MemoryEvent;
  decision: MemoryDecision;
  representation: string;
  scope: string;
}

const defaultTokenBudget = 1200;
const defaultSourcePrefix = "daimon";

export const defaultSource = (agentId: string): string => `${defaultSourcePrefix}/${agentId}`;

export const clampTokenBudget = (value: number | undefined): number => {
  if (!value || Number.isNaN(value) || value <= 0) {
    return defaultTokenBudget;
  }
  return Math.max(128, Math.floor(value));
};

const trimText = (value: string, maxLength: number): string => {
  const normalized = value.trim();
  return normalized.length <= maxLength ? normalized : normalized.slice(0, maxLength).trim();
};

export const normalizeScopeIds = (ids: string[]): string[] => {
  return [...new Set(ids.map((value) => value.trim().toLowerCase()).filter(Boolean))];
};

const extractTokens = (text: string): string[] => {
  const payload = `${text}`.toLowerCase();
  return [...new Set(payload
    .split(/[^a-z0-9]+/u)
    .map((value) => value.trim())
    .filter((value) => value.length > 3)
  )].slice(0, 32);
};

export const readByScopes = async (
  store: JsonlMemoryStore,
  scopeIds: string[]
): Promise<MemoryEvent[]> => {
  const queries = await Promise.all(scopeIds.map((scope) => store.read({ scope })));
  const seen = new Set<string>();
  const events: MemoryEvent[] = [];

  for (const event of queries.flat()) {
    if (seen.has(event.id)) {
      continue;
    }
    seen.add(event.id);
    events.push(event);
  }

  return events;
};

export const recallableEvents = (events: MemoryEvent[]): MemoryEvent[] => {
  const forgotten = new Set(
    events
      .filter((event) => event.type === "memory.forgotten")
      .flatMap((event) => event.parentEventIds)
  );

  return events.filter((event) =>
    event.type !== "memory.located" &&
    event.type !== "memory.denied" &&
    event.type !== "memory.forgotten" &&
    !forgotten.has(event.id)
  );
};

export const deniedMemoryEvents = (input: {
  requester: MemoryPrincipalRef;
  activeScope: MemoryPrincipalRef;
  events: MemoryEvent[];
  selectedIds: Set<string>;
}): Array<{ event: MemoryEvent; reason: string }> =>
  input.events.flatMap((event) => {
    if (input.selectedIds.has(event.id)) {
      return [];
    }

    const decision = memoryPolicy({
      request: input.requester,
      activeScope: input.activeScope,
      candidate: event
    });

    return decision.decision === "deny" ? [{ event, reason: decision.reason }] : [];
  });

export const buildRecallInput = (input: {
  actor: MemoryPrincipalRef;
  scopeIds: string[];
  events: MemoryEvent[];
  text: string;
  maxTokens?: number;
  embeddingScores?: Readonly<Record<string, number>> | ReadonlyMap<string, number>;
}): ReturnType<typeof runRecall> => {
  return runRecall({
    actor: input.actor,
    scopeIds: input.scopeIds,
    events: input.events,
    query: input.text,
    maxTokens: clampTokenBudget(input.maxTokens),
    embeddingScores: input.embeddingScores
  });
};

const toDecisionText = (decision: MemoryDecision): string => {
  return decision === "allow_raw" ? "used raw"
    : decision === "allow_summary" ? "used summary"
      : decision === "allow_redacted_summary" ? "used redacted summary"
        : decision === "known_but_private" ? "used private memory via scope policy"
          : decision === "locate_only" ? "used locate-only hint"
            : decision === "unavailable" ? "memory unavailable"
              : decision === "malformed_request" ? "malformed request"
                : "denied by policy";
};

const memoryTagsFromRequest = (
  request: MemoryRecallRequest,
  packet: MemoryPacket,
  result: MemoryPrepareTurnResult
): string[] => {
  const context = request.context ?? {};
  const tokens = [
    ...extractTokens(request.text),
    ...extractTokens(packet.principal.scope),
    request.kind,
    result.principal.scope,
    ...extractTokens(result.principal.qualifier ?? ""),
    ...context.networkId ? [context.networkId] : [],
    ...context.roomId ? [context.roomId] : []
  ];
  return [...new Set(tokens)].slice(0, 64);
};

const baseEventInput = (input: {
  principal: MemoryPrincipalRef;
  scope: string;
  source: string;
  visibility: MemoryVisibility;
  tags: string[];
  entities: string[];
  parentEventIds: string[];
}): Omit<MemoryEventInput, "content" | "type"> => {
  return {
    principal: input.principal,
    scope: input.scope,
    visibility: input.visibility,
    source: input.source,
    parentEventIds: input.parentEventIds,
    tags: input.tags,
    entities: input.entities,
    sensitivity: "normal"
  };
};

const visibilityForPrincipal = (principal: MemoryPrincipalRef): MemoryVisibility => {
  if (
    principal.scope === "global" ||
    principal.scope === "team" ||
    principal.scope === "room" ||
    principal.scope === "pair"
  ) {
    return principal.scope;
  }

  return "private";
};

export const buildDecisionEvents = (input: {
  principal: MemoryPrincipalRef;
  scope: string;
  source: string;
  request: MemoryRecallRequest;
  packet: MemoryPacket;
  recall: MemoryRecallAudit;
  result: MemoryTurnRecord["result"];
  outputText: string;
  error?: string;
  parentEventIds: string[];
}): MemoryEventInput[] => {
  const entities = [
    ...extractTokens(input.request.text),
    ...extractTokens(input.packet.principal.agentId),
    ...extractTokens(input.packet.principal.scope)
  ];

  const tags = memoryTagsFromRequest(input.request, input.packet, {
    principal: input.principal,
    packet: input.packet,
    promptText: input.outputText,
    recall: input.recall
  });

  const base = baseEventInput({
    principal: input.principal,
    scope: input.scope,
    source: input.source,
    visibility: visibilityForPrincipal(input.principal),
    tags,
    entities,
    parentEventIds: input.parentEventIds
  });

  const events: MemoryEventInput[] = [
    {
      ...base,
      type: "memory.claimed",
      content: {
        kind: "text",
        text: `Wake request ${input.request.eventId} from ${input.request.from ?? "operator"}: ${trimText(input.request.text, 480)}`
      }
    },
    {
      ...base,
      type: "memory.observed",
      tags: [...tags, "output", input.result],
      content: {
        kind: "text",
        text: `Agent output: ${trimText(input.outputText, 620)}`
      }
    }
  ];

  for (const selected of input.recall.selected ?? []) {
    events.push({
      ...base,
      type: "memory.recalled",
      tags: [...tags, "memory", selected.decision, selected.scope],
      content: {
        kind: "text",
        text: `Recalled ${selected.eventId}: ${selected.representation}. Decision=${toDecisionText(selected.decision)} (${selected.scope})`
      },
      entities: [...entities, selected.eventId]
    });
  }

  if (input.result === "failed" && input.error) {
    events.push({
      ...base,
      type: "memory.denied",
      tags: [...tags, "failed"],
      content: {
        kind: "text",
        text: `Turn failed: ${trimText(input.error, 480)}`
      }
    });
  }

  if (input.packet.sections.length > 0) {
    for (const section of input.packet.sections) {
      events.push({
        ...base,
        type: "memory.observed",
        tags: [...tags, "section", section.heading.toLowerCase()],
        content: {
          kind: "text",
          text: `${section.heading}: ${trimText(section.text, 420)}`
        },
        entities: [...entities, ...extractTokens(section.heading), ...extractTokens(section.text)]
      });
    }
  }

  return events;
};

export const selectToolSummary = (toolEvents: unknown[]): MemoryEventInput | undefined => {
  if (!Array.isArray(toolEvents) || toolEvents.length === 0) {
    return undefined;
  }

  return {
    principal: {
      agentId: "daimon",
      scope: "global"
    },
    type: "memory.summarized",
    scope: "global",
    visibility: "global",
    source: "mneme/tool",
    content: {
      kind: "text",
      text: `Observed ${toolEvents.length} tool event(s) during turn.`
    },
    tags: ["tool", "summary"],
    entities: ["tool"],
    parentEventIds: []
  };
};

export const runMemorySelection = (input: {
  requester: MemoryPrincipalRef;
  scopeIds: string[];
  events: MemoryEvent[];
  query: string;
  maxResults?: number;
}): MemoryRecallEntry[] => {
  const selection = runRecall({
    actor: input.requester,
    scopeIds: input.scopeIds,
    events: input.events,
    query: input.query,
    maxTokens: clampTokenBudget((input.maxResults ?? 1) * 160)
  });

  const limited = input.maxResults !== undefined ? selection.selected.slice(0, input.maxResults) : selection.selected;
  return limited.map((entry) => ({
    event: entry.event,
    decision: entry.decision,
    representation: entry.representation,
    scope: entry.scope
  }));
};

export { runRecall };
