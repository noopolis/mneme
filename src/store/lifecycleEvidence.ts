import { createHash } from "node:crypto";

import { canonicalJsonBytes, memoryStreamId } from "../contract/causal.js";
import type { CausalEvent } from "../contract/causal.js";
import type { CausalEventStore } from "./causalStore.js";

const digest = (value: unknown): string =>
  createHash("sha256").update(canonicalJsonBytes(value)).digest("hex");

interface LifecycleEvidenceBase {
  runId: string;
  agentId: string;
  principalId: string;
  causeEventIds: string[];
  resultEventId: string;
  resultSha256: string;
  scope: string;
}

export interface MemorySummaryEvidenceInput extends LifecycleEvidenceBase {
  resultMemoryId: string;
  sources: Array<{ eventId: string; contentSha256: string }>;
}

/** Content-free authoritative summary write, distinct from tool outcome. */
export const appendMemorySummaryEvidence = (
  store: CausalEventStore,
  input: MemorySummaryEvidenceInput
): Promise<CausalEvent> => {
  const sources = [...new Map(input.sources.map((source) => [source.eventId, source])).values()]
    .sort((left, right) => left.eventId.localeCompare(right.eventId));
  return store.append({
    runId: input.runId,
    streamId: memoryStreamId(input.agentId),
    type: "memory.summary.written",
    principalId: input.principalId,
    causeEventIds: input.causeEventIds,
    payload: {
      result_memory_id: input.resultMemoryId,
      result_revision_id: input.resultEventId,
      result_sha256: input.resultSha256,
      scope_sha256: digest(input.scope),
      source_event_ids: sources.map((source) => source.eventId),
      source_sha256: digest(sources.map((source) => ({ content_sha256: source.contentSha256, event_id: source.eventId })))
    }
  });
};

export interface MemoryForgottenEvidenceInput extends LifecycleEvidenceBase {
  targets: Array<{ eventId: string; contentSha256: string }>;
}

/** Content-free authoritative tombstone effect, distinct from tool outcome. */
export const appendMemoryForgottenEvidence = (
  store: CausalEventStore,
  input: MemoryForgottenEvidenceInput
): Promise<CausalEvent> => {
  const targets = [...new Map(input.targets.map((target) => [target.eventId, target])).values()]
    .sort((left, right) => left.eventId.localeCompare(right.eventId));
  const targetEventIds = targets.map((target) => target.eventId);
  return store.append({
    runId: input.runId,
    streamId: memoryStreamId(input.agentId),
    type: "memory.lifecycle.forgotten",
    principalId: input.principalId,
    causeEventIds: input.causeEventIds,
    payload: {
      result_event_id: input.resultEventId,
      result_sha256: input.resultSha256,
      scope_sha256: digest(input.scope),
      target_event_ids: targetEventIds,
      target_sha256: digest(targets.map((target) => ({
        content_sha256: target.contentSha256,
        event_id: target.eventId
      })))
    }
  });
};

export interface MemoryPromotedEvidenceInput extends LifecycleEvidenceBase {
  memoryId: string;
  targetRevisionId: string;
  targetRevisionSha256: string;
}

/** Content-free authoritative promotion effect, distinct from tool outcome. */
export const appendMemoryPromotedEvidence = (
  store: CausalEventStore,
  input: MemoryPromotedEvidenceInput
): Promise<CausalEvent> => store.append({
  runId: input.runId,
  streamId: memoryStreamId(input.agentId),
  type: "memory.lifecycle.promoted",
  principalId: input.principalId,
  causeEventIds: input.causeEventIds,
  payload: {
    memory_id: input.memoryId,
    result_event_id: input.resultEventId,
    result_sha256: input.resultSha256,
    scope_sha256: digest(input.scope),
    target_revision_id: input.targetRevisionId,
    target_revision_sha256: input.targetRevisionSha256
  }
});
