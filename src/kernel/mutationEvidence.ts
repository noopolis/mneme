import { resolveCausalRunId } from "../contract/causal.js";
import type { MemoryEvent, MemoryToolCall } from "../contract/types.js";
import { appendMemoryWrittenEvent, type CausalEventStore } from "../store/causalStore.js";
import { appendMemoryForgottenEvidence, appendMemoryPromotedEvidence, appendMemorySummaryEvidence } from "../store/lifecycleEvidence.js";

export const recordMemoryWriteEvidence = (
  causalStore: CausalEventStore,
  call: MemoryToolCall,
  event: MemoryEvent
): Promise<unknown> => appendMemoryWrittenEvent(causalStore, {
  runId: resolveCausalRunId(),
  agentId: event.principal.agentId,
  principalId: `agent:${event.principal.agentId}`,
  causeEventIds: [call.envelope.wake_id],
  memoryId: event.memoryId ?? event.id,
  revisionId: event.id,
  scope: event.scope,
  contentSha256: event.checksum
});

export const recordMemorySummaryEvidence = (
  causalStore: CausalEventStore,
  call: MemoryToolCall,
  result: MemoryEvent,
  sources: readonly MemoryEvent[]
): Promise<unknown> => appendMemorySummaryEvidence(causalStore, {
  runId: resolveCausalRunId(),
  agentId: result.principal.agentId,
  principalId: `agent:${result.principal.agentId}`,
  causeEventIds: [call.envelope.wake_id],
  resultEventId: result.id,
  resultMemoryId: result.memoryId ?? result.id,
  resultSha256: result.checksum,
  scope: result.scope,
  sources: sources.map((source) => ({ eventId: source.id, contentSha256: source.checksum }))
});

export const recordMemoryForgottenEvidence = (
  causalStore: CausalEventStore,
  call: MemoryToolCall,
  result: MemoryEvent,
  targets: readonly MemoryEvent[]
): Promise<unknown> => appendMemoryForgottenEvidence(causalStore, {
  runId: resolveCausalRunId(),
  agentId: result.principal.agentId,
  principalId: `agent:${result.principal.agentId}`,
  causeEventIds: [call.envelope.wake_id],
  resultEventId: result.id,
  resultSha256: result.checksum,
  scope: result.scope,
  targets: targets.map((target) => ({ eventId: target.id, contentSha256: target.checksum }))
});

export const recordMemoryPromotedEvidence = (
  causalStore: CausalEventStore,
  call: MemoryToolCall,
  result: MemoryEvent,
  target: MemoryEvent,
  memoryId: string
): Promise<unknown> => appendMemoryPromotedEvidence(causalStore, {
  runId: resolveCausalRunId(),
  agentId: result.principal.agentId,
  principalId: `agent:${result.principal.agentId}`,
  causeEventIds: [call.envelope.wake_id],
  resultEventId: result.id,
  resultSha256: result.checksum,
  scope: result.scope,
  memoryId,
  targetRevisionId: target.id,
  targetRevisionSha256: target.checksum
});
