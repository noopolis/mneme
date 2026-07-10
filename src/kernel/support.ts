import { canonicalScopeKey, memoryScopeId, sanitizePrincipalQualifier } from "../identity/ids.js";
import { memoryStreamId, resolveCausalRunId } from "../contract/causal.js";
import type { CausalEventStore } from "../store/causalStore.js";
import type {
  MemoryDecision,
  MemoryEvent,
  MemoryEventInput,
  MemoryEventType,
  MemoryContent,
  MemoryForgetArguments,
  MemoryLocateArguments,
  MemoryPromoteArguments,
  MemoryRegisterArguments,
  MemorySearchArguments,
  MemorySummarizeArguments,
  MemoryToolCall,
  MemoryToolAudit,
  MemoryToolCallEnvelope,
  MemoryToolDecision,
  MemoryToolName,
  MemoryToolResult,
  MemoryToolResultContent,
  MemoryVisibility,
  MemorySensitivity
} from "../contract/types.js";
import type { JsonlMemoryStore } from "../store/store.js";

export interface CandidateHandle {
  decision: MemoryDecision;
  event: MemoryEvent;
  score: number;
  eventIds: string[];
  scope: string;
}

export type MemoryResultItem = Omit<MemoryToolResultContent, "event_ids" | "redactions"> & {
  event_ids: string[];
  redactions: string[];
};

const isString = (value: unknown): value is string => typeof value === "string";
const hasText = (value: unknown): value is string => isString(value) && value.trim().length > 0;

export const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const asNumber = (value: unknown): number => {
  if (typeof value !== "number" || Number.isNaN(value) || value <= 0) {
    return 0;
  }

  return Math.floor(value);
};

export const isVisibility = (value: unknown): value is MemoryVisibility =>
  value === "private" || value === "pair" || value === "team" || value === "room" || value === "global" || value === "public" || value === "sealed";

export const isSensitivity = (value: unknown): value is MemorySensitivity =>
  value === "normal" || value === "sensitive" || value === "secret";

export const isSearchArguments = (value: Record<string, unknown>): value is Omit<MemorySearchArguments, "scope" | "query"> & { scope: string; query: string } =>
  hasText(value.scope) && hasText(value.query);

export const isLocateArguments = (value: Record<string, unknown>): value is Omit<MemoryLocateArguments, "query"> & { query: string } =>
  hasText(value.query);

export const isSummarizeArguments = (value: Record<string, unknown>): value is Omit<MemorySummarizeArguments, "scope"> & { scope: string } =>
  hasText(value.scope);

const isTextContent = (value: Record<string, unknown>): value is MemoryContent =>
  isPlainObject(value) && value.kind === "text" && hasText(value.text);

const isClaimContent = (value: Record<string, unknown>): value is MemoryContent =>
  isPlainObject(value) &&
  value.kind === "claim" &&
  hasText(value.subject) &&
  hasText(value.predicate) &&
  hasText(value.object);

const isDecisionContent = (value: Record<string, unknown>): value is MemoryContent =>
  isPlainObject(value) &&
  value.kind === "decision" &&
  hasText(value.decision);

const isArtifactContent = (value: Record<string, unknown>): value is MemoryContent =>
  isPlainObject(value) &&
  value.kind === "artifact" &&
  hasText(value.description);

const isRelationshipContent = (value: Record<string, unknown>): value is MemoryContent =>
  isPlainObject(value) &&
  value.kind === "relationship" &&
  hasText(value.from) &&
  hasText(value.relation) &&
  hasText(value.to);

export const isMemoryContent = (value: unknown): value is MemoryContent => {
  if (!isPlainObject(value)) {
    return false;
  }

  if (value.kind === "text") {
    return isTextContent(value);
  }
  if (value.kind === "claim") {
    return isClaimContent(value);
  }
  if (value.kind === "decision") {
    return isDecisionContent(value);
  }
  if (value.kind === "artifact") {
    return isArtifactContent(value);
  }
  if (value.kind === "relationship") {
    return isRelationshipContent(value);
  }

  return false;
};

export const isRegisterArguments = (value: unknown): value is MemoryRegisterArguments =>
  isPlainObject(value)
  && hasText(value.scope)
  && hasText(value.kind)
  && hasText(value.visibility)
  && hasText(value.sensitivity)
  && hasText(value.source_type)
  && isVisibility(value.visibility)
  && isSensitivity(value.sensitivity)
  && isPlainObject(value.content)
  && isMemoryContent(value.content)
  && Array.isArray(value.evidence_event_ids)
  && value.evidence_event_ids.length > 0
  && value.evidence_event_ids.every((id) => isString(id))
  && (value.memory_id === undefined || hasText(value.memory_id));

export const isPromoteArguments = (value: unknown): value is MemoryPromoteArguments =>
  isPlainObject(value) && hasText(value.scope) && hasText(value.memory_id);

export const isForgetArguments = (value: unknown): value is MemoryForgetArguments => {
  if (!isPlainObject(value)) {
    return false;
  }

  return hasText(value.scope)
    && Array.isArray(value.event_ids)
    && value.event_ids.length > 0
    && value.event_ids.every((id) => isString(id));
};

export const makeAudit = (
  call: MemoryToolCall,
  sources: MemoryEvent[],
  startAt: number
): MemoryToolAudit => ({
  request_id: call.request_id,
  requester: call.envelope.principal,
  sources: sources.map((event) => event.principal),
  transport: call.envelope.transport,
  latency_ms: Date.now() - startAt,
  argument_hash: canonicalScopeKey(JSON.stringify(call.arguments))
});

export const malformed = (call: MemoryToolCall, tool: MemoryToolName, error: string, startAt: number): MemoryToolResult => ({
  request_id: call.request_id,
  tool,
  decision: "malformed_request",
  content: [],
  audit: makeAudit(call, [], startAt),
  error
});

export const unavailable = (call: MemoryToolCall, tool: MemoryToolName, error: string, startAt: number): MemoryToolResult => ({
  request_id: call.request_id,
  tool,
  decision: "unavailable",
  content: [],
  audit: makeAudit(call, [], startAt),
  error
});

export const eventText = (event: MemoryEvent): string => {
  if (event.content.kind === "text") {
    return event.content.text;
  }
  if (event.content.kind === "claim") return `${event.content.subject} ${event.content.predicate} ${event.content.object}`;
  if (event.content.kind === "decision") return `${event.content.decision} ${event.content.rationale ?? ""}`.trim();
  if (event.content.kind === "artifact") return event.content.description;
  return `${event.content.from} ${event.content.relation} ${event.content.to}`;
};

export const resultKind = (kind: MemoryEventType | MemoryEvent["content"]["kind"]): MemoryToolResultContent["kind"] => {
  if (kind === "text") return "memory";
  if (kind === "decision") return "claim";
  return kind as MemoryToolResultContent["kind"];
};

export const policyText = (decision: MemoryDecision, text: string): string => {
  if (decision === "allow_raw") return text;
  if (decision === "allow_summary" || decision === "allow_redacted_summary") {
    return text.length > 150 ? `${text.slice(0, 147)}...` : text;
  }
  if (decision === "known_but_private") {
    return "Related private context is available behind policy.";
  }
  if (decision === "locate_only") {
    return "Locate candidates are known, but content is omitted.";
  }

  return "Memory was blocked by policy.";
};

export const decide = (decisions: MemoryDecision[]): MemoryToolDecision => {
  if (decisions.includes("allow_raw")) return "allow_raw";
  if (decisions.includes("allow_summary")) return "allow_summary";
  if (decisions.includes("allow_redacted_summary")) return "allow_redacted_summary";
  if (decisions.includes("locate_only")) return "locate_only";
  if (decisions.includes("known_but_private")) return "known_but_private";
  return "deny";
};

export const resolveScope = (scopeInput: string, requester: MemoryToolCallEnvelope["principal"]): string => {
  const scope = canonicalScopeKey(scopeInput.trim().toLowerCase());
  if (scope === "all") {
    return "all";
  }
  if (scope === "current") {
    return memoryScopeId(requester);
  }
  if (scope === "global") {
    return memoryScopeId({ ...requester, scope: "global" });
  }

  return canonicalScopeKey(scopeInput);
};

/**
 * B62: emits the never-silent denial pair for a write-scope violation
 * (see policy/writeScope.ts) — one `memory.denied` ledger line (tags
 * `["denied","write"]`, mirroring the recall-side denial precedent above)
 * plus one `memory.write.denied` causal event — then returns a `deny`
 * result to the caller. Never throws. The stamped principal on both the
 * ledger event and the causal event's `principal_id` is always the
 * envelope's own (trusted) principal, never the claimed foreign scope's
 * owner: the ledger event is written into the envelope principal's own
 * scope, not the scope the call tried to reach.
 */
export const denyWriteScope = async (
  store: JsonlMemoryStore,
  causalStore: CausalEventStore,
  call: MemoryToolCall,
  tool: MemoryToolName,
  scope: string,
  reason: string,
  startAt: number
): Promise<MemoryToolResult> => {
  const principal = sanitizePrincipal(call.envelope.principal);
  const ownScope = resolveScope("current", principal);

  await store.append({
    type: "memory.denied",
    principal,
    scope: ownScope,
    visibility: "private",
    source: "mneme/policy",
    content: {
      kind: "text",
      text: `Denied ${tool} write to scope ${scope}: ${reason}`
    },
    tags: ["denied", "write"],
    entities: [principal.agentId, scope],
    sensitivity: "normal",
    parentEventIds: []
  } satisfies MemoryEventInput);

  await causalStore.append({
    runId: resolveCausalRunId(),
    streamId: memoryStreamId(principal.agentId),
    type: "memory.write.denied",
    principalId: `agent:${principal.agentId}`,
    causeEventIds: [],
    payload: {
      tool,
      requested_scope: scope,
      reason
    }
  });

  return {
    request_id: call.request_id,
    tool,
    decision: "deny",
    content: [],
    audit: makeAudit(call, [], startAt),
    error: reason
  };
};

export const sanitizePrincipal = (principal: MemoryToolCallEnvelope["principal"]) => ({
  ...principal,
  qualifier: principal.qualifier ? sanitizePrincipalQualifier(principal.qualifier) : undefined
});

export const collectTombstones = (events: MemoryEvent[]): Set<string> => {
  const redacted = new Set<string>();
  for (const event of events) {
    if (event.type === "memory.forgotten") {
      for (const id of event.parentEventIds) {
        redacted.add(id);
      }
    }
  }
  return redacted;
};

export const isRecallableMemoryEvent = (event: MemoryEvent): boolean =>
  event.type !== "memory.located" &&
  event.type !== "memory.denied" &&
  event.type !== "memory.forgotten";

export const matchesQuery = (event: MemoryEvent, query: string): boolean => {
  const normalized = eventText(event).toLowerCase();
  const tokens = query.toLowerCase()
    .split(/\W+/u)
    .map((value) => value.trim())
    .filter((value) => value.length > 2);
  if (tokens.length === 0) {
    return true;
  }
  return tokens.some((token) => normalized.includes(token));
};

export const canExposeEventId = (decision: MemoryDecision): boolean =>
  decision === "allow_raw" || decision === "allow_summary" || decision === "allow_redacted_summary";

export const locateCandidateId = (event: MemoryEvent): string =>
  `${event.principal.agentId}|${event.principal.scope}|${event.principal.qualifier ?? ""}`;

export const hasInvalidV1Envelope = (version: string): boolean => version !== "mneme.memory.tool.v1";

export const makeSearchResult = (decision: MemoryDecision, event: MemoryEvent) => ({
  kind: resultKind(event.content.kind),
  text: policyText(decision, eventText(event)),
  event_ids: canExposeEventId(decision) ? [event.id] : [],
  scope: event.scope,
  principal: event.principal,
  confidence: 1,
  redactions: decision === "allow_redacted_summary" || decision === "known_but_private" ? ["redacted"] : []
});

export const makeLocateResult = (entry: CandidateHandle) => ({
  kind: "locate" as const,
  event_ids: canExposeEventId(entry.decision) ? entry.eventIds : [],
  scope: entry.scope,
  principal: entry.event.principal,
  confidence: Math.min(1, entry.score / 10),
  redactions: ["content-omitted"]
});
