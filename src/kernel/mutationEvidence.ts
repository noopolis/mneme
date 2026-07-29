import { resolveCausalRunId } from "../contract/causal.js";
import type { MemoryEvent, MemoryPrincipalRef, MemoryToolCall } from "../contract/types.js";
import { appendMemoryWrittenEvent, type CausalEventStore } from "../store/causalStore.js";
import { appendMemoryForgottenEvidence, appendMemoryPromotedEvidence, appendMemorySummaryEvidence } from "../store/lifecycleEvidence.js";
import { sanitizePrincipal } from "./support.js";

export const assertMutationPrincipalMatchesEnvelope = (
  call: MemoryToolCall,
  event: MemoryEvent
): MemoryPrincipalRef => {
  const principal = sanitizePrincipal(call.envelope.principal);
  if (event.principal.agentId !== principal.agentId
    || event.principal.scope !== principal.scope
    || event.principal.qualifier !== principal.qualifier) {
    throw new Error("stored mutation principal does not match authenticated envelope");
  }
  return principal;
};

export const recordMemoryWriteEvidence = (
  causalStore: CausalEventStore,
  call: MemoryToolCall,
  event: MemoryEvent
): Promise<unknown> => {
  const principal = assertMutationPrincipalMatchesEnvelope(call, event);
  return appendMemoryWrittenEvent(causalStore, {
  runId: resolveCausalRunId(),
  agentId: principal.agentId,
  principalId: `agent:${principal.agentId}`,
  causeEventIds: [call.envelope.wake_id],
  memoryId: event.memoryId ?? event.id,
  revisionId: event.id,
  scope: event.scope,
  contentSha256: event.checksum
  });
};

export const recordMemorySummaryEvidence = (
  causalStore: CausalEventStore,
  call: MemoryToolCall,
  result: MemoryEvent,
  sources: readonly MemoryEvent[]
): Promise<unknown> => {
  const principal = assertMutationPrincipalMatchesEnvelope(call, result);
  return appendMemorySummaryEvidence(causalStore, {
  runId: resolveCausalRunId(),
  agentId: principal.agentId,
  principalId: `agent:${principal.agentId}`,
  causeEventIds: [call.envelope.wake_id],
  resultEventId: result.id,
  resultMemoryId: result.memoryId ?? result.id,
  resultSha256: result.checksum,
  scope: result.scope,
  sources: sources.map((source) => ({ eventId: source.id, contentSha256: source.checksum }))
  });
};

export const recordMemoryForgottenEvidence = (
  causalStore: CausalEventStore,
  call: MemoryToolCall,
  result: MemoryEvent,
  targets: readonly MemoryEvent[]
): Promise<unknown> => {
  const principal = assertMutationPrincipalMatchesEnvelope(call, result);
  return appendMemoryForgottenEvidence(causalStore, {
  runId: resolveCausalRunId(),
  agentId: principal.agentId,
  principalId: `agent:${principal.agentId}`,
  causeEventIds: [call.envelope.wake_id],
  resultEventId: result.id,
  resultSha256: result.checksum,
  scope: result.scope,
  targets: targets.map((target) => ({ eventId: target.id, contentSha256: target.checksum }))
  });
};

export const recordMemoryPromotedEvidence = (
  causalStore: CausalEventStore,
  call: MemoryToolCall,
  result: MemoryEvent,
  target: MemoryEvent,
  memoryId: string
): Promise<unknown> => {
  const principal = assertMutationPrincipalMatchesEnvelope(call, result);
  return appendMemoryPromotedEvidence(causalStore, {
  runId: resolveCausalRunId(),
  agentId: principal.agentId,
  principalId: `agent:${principal.agentId}`,
  causeEventIds: [call.envelope.wake_id],
  resultEventId: result.id,
  resultSha256: result.checksum,
  scope: result.scope,
  memoryId,
  targetRevisionId: target.id,
  targetRevisionSha256: target.checksum
  });
};
