import { canonicalPrincipalKey } from "../identity/ids.js";
import { memoryPriority, memoryPolicy } from "../policy/policy.js";
import type {
  MemoryEvent,
  MemoryPrincipalRef,
  MemoryRecallAudit,
  MemoryDecision,
  WakeMemoryContext,
  MemoryPacket
} from "../contract/types.js";

export interface RecallInput {
  actor: MemoryPrincipalRef;
  scopeIds: string[];
  events: MemoryEvent[];
  query: string;
  maxTokens: number;
}

export interface RecallSelection {
  packet: MemoryPacket;
  audit: MemoryRecallAudit;
  selected: Array<{ event: MemoryEvent; decision: MemoryDecision; representation: string; scope: string }>;
}

const estimateTokens = (text: string): number => Math.max(1, Math.ceil(text.length / 4));

const textFromEvent = (event: MemoryEvent): string => {
  const fallback = JSON.stringify(event.content);
  if (event.content.kind === "text") {
    return event.content.text.trim();
  }
  if (event.content.kind === "decision") {
    return `${event.content.decision}${event.content.rationale ? ` — ${event.content.rationale}` : ""}`;
  }
  if (event.content.kind === "artifact") {
    return event.content.description;
  }
  if (event.content.kind === "relationship") {
    return `${event.content.from} ${event.content.relation} ${event.content.to}`;
  }
  if (event.content.kind === "claim") {
    return `${event.content.subject} ${event.content.predicate} ${event.content.object}`;
  }
  return fallback;
};

const buildRepresentation = (decision: MemoryDecision, event: MemoryEvent): string => {
  const base = textFromEvent(event);
  if (decision === "allow_raw") {
    return base;
  }
  if (decision === "allow_summary") {
    const summary = base.slice(0, 140);
    return summary.length < base.length ? `${summary}...` : summary;
  }
  if (decision === "allow_redacted_summary") {
    return `[redacted] ${base.slice(0, 100)}...`;
  }
  if (decision === "known_but_private") {
    return "Related private context is available behind policy.";
  }
  return "Memory was blocked by policy.";
};

const scoreEvent = (actor: MemoryPrincipalRef, candidateScope: string, event: MemoryEvent, queryText: string): number => {
  const text = textFromEvent(event).toLowerCase();
  const overlap = queryText
    .split(" ")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 2)
    .reduce((total, token) => total + (text.includes(token) ? 2 : 0), 0);

  const scopeScore = memoryPriority(actor, candidateScope ? { ...event.principal, scope: event.principal.scope } : event.principal);
  const freshness = Date.parse(event.createdAt) / 1000_000;
  return overlap + scopeScore + (freshness % 30_000) / 1000;
};

export const rankCandidates = (input: RecallInput): Array<{ event: MemoryEvent; decision: MemoryDecision; score: number; representation: string; scope: string } > => {
  const allowedScopeSet = new Set(input.scopeIds);
  const query = input.query.toLowerCase();

  const candidateRows: Array<{ event: MemoryEvent; decision: MemoryDecision; score: number; representation: string; scope: string }> = [];

  for (const event of input.events) {
    const policy = memoryPolicy({
      request: input.actor,
      activeScope: input.actor,
      candidate: event
    });

    if (!allowedScopeSet.has(event.scope)) {
      continue;
    }

    if (policy.decision === "deny") {
      continue;
    }

    const representation = buildRepresentation(policy.decision, event);
    candidateRows.push({
      event,
      decision: policy.decision,
      scope: event.scope,
      score: scoreEvent(input.actor, event.scope, event, query),
      representation
    });
  }

  return candidateRows
    .sort((left, right) => {
      const scoreDelta = right.score - left.score;
      if (scoreDelta !== 0) {
        return scoreDelta;
      }

      const timeDelta = Date.parse(right.event.createdAt) - Date.parse(left.event.createdAt);
      if (timeDelta !== 0) {
        return timeDelta;
      }

      const scopeDelta = left.scope.localeCompare(right.scope);
      if (scopeDelta !== 0) {
        return scopeDelta;
      }

      const idDelta = left.event.id.localeCompare(right.event.id);
      if (idDelta !== 0) {
        return idDelta;
      }

      return left.event.checksum.localeCompare(right.event.checksum);
    })
    .map((row) => ({
      event: row.event,
      decision: row.decision,
      score: row.score,
      representation: row.representation,
      scope: row.scope
    }));
};

export const runRecall = (input: RecallInput): RecallSelection => {
  const candidates = rankCandidates(input);
  const selected = [] as RecallSelection["selected"];
  const auditDecisions: MemoryRecallAudit["decisions"] = [];

  let usedTokens = 0;
  let redactions = 0;
  for (const candidate of candidates) {
    const tokens = estimateTokens(candidate.representation);
    if (usedTokens + tokens > input.maxTokens && selected.length > 0) {
      continue;
    }

    selected.push({
      event: candidate.event,
      decision: candidate.decision,
      representation: candidate.representation,
      scope: candidate.scope
    });

    usedTokens += tokens;
    if (candidate.decision === "allow_redacted_summary" || candidate.decision === "known_but_private") {
      redactions += 1;
    }

    auditDecisions.push({
      eventId: candidate.event.id,
      decision: candidate.decision,
      reason: "policy + recall ranking"
    });
  }

  return {
    packet: {
      principal: input.actor,
      sections: selected.map((entry) => ({
        heading: `${entry.scope}: ${entry.event.type}`,
        text: entry.representation
      })),
      rawHint: queryHint(selected, input.actor, input.scopeIds)
    },
    selected,
    audit: {
      totalCandidates: candidates.length,
      selectedEventIds: selected.map((entry) => entry.event.id),
      selected: selected.map((entry) => ({
        eventId: entry.event.id,
        decision: entry.decision,
        scope: entry.scope,
        representation: entry.representation
      })),
      decisions: auditDecisions,
      tokenBudgetUsed: usedTokens,
      redactionCount: redactions
    }
  };
};

const queryHint = (
  selections: Array<{ event: MemoryEvent; decision: MemoryDecision; representation: string; scope: string }>,
  actor: MemoryPrincipalRef,
  scopeIds: string[]
): string => {
  const pending = scopeIds.filter((scope) =>
    !selections.some((selection) => selection.scope === scope)
  );

  if (pending.length > 0) {
    return `Active memory principal ${canonicalPrincipalKey(actor)} has access to ${scopeIds.length} scopes. Missing active data in: ${pending.join(", ")}`;
  }

  return `Active memory principal ${canonicalPrincipalKey(actor)} has no known denials.`;
};

export const buildWakePacketText = (context: WakeMemoryContext, wakeText: string, packet: MemoryPacket): string => {
  const room = context.roomId ? `${context.networkId ?? "unknown"}/${context.roomId}` : "global";
  const lines = [
    "## Memory context",
    `Agent: ${packet.principal.agentId}`,
    `Active scope: ${packet.principal.scope}${packet.principal.qualifier ? ` (${packet.principal.qualifier})` : ""}`,
    `Active room: ${room}`,
    "",
    ...packet.sections.map((section) => `- ${section.heading}\n${section.text}`),
    packet.rawHint ? `\nHints: ${packet.rawHint}` : "",
    "",
    "Wake event:",
    wakeText
  ];

  return lines.filter((line) => line.length > 0).join("\n\n");
};
