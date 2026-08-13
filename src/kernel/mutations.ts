import { projectLifecycle } from "../store/lifecycle.js";
import type { JsonlMemoryStore } from "../store/store.js";
import type { CausalEventStore } from "../store/causalStore.js";
import { memoryPolicy } from "../policy/policy.js";
import { assertToolCapability } from "../policy/capability.js";
import { assertWriteScope } from "../policy/writeScope.js";
import type {
  MemoryEventInput,
  MemoryToolCall,
  MemoryToolResult
} from "../contract/types.js";
import {
  asNumber,
  collectTombstones,
  denyWriteScope,
  hasInvalidV1Envelope,
  eventText,
  isRecallableMemoryEvent,
  makeAudit,
  malformed,
  ownsMemoryTarget,
  unavailable,
  policyText,
  resolveScope,
  sanitizePrincipal
} from "./support.js";
import { isForgetArguments, isPromoteArguments, isRegisterArguments, isSummarizeArguments } from "./mutationArguments.js";
import { recordMemoryForgottenEvidence, recordMemoryPromotedEvidence, recordMemorySummaryEvidence, recordMemoryWriteEvidence } from "./mutationEvidence.js";

/** Four capability- and scope-gated mutating memory tools, split from the
 * kernel to keep both production modules bounded. Trusted identity and scope
 * grants always come from the envelope, never model arguments. */

export const registerMemory = async (
  store: JsonlMemoryStore,
  causalStore: CausalEventStore,
  call: MemoryToolCall
): Promise<MemoryToolResult> => {
  const startAt = Date.now();
  if (hasInvalidV1Envelope(call.envelope.version)) {
    return malformed(call, "memory.register", "unsupported envelope", startAt);
  }
  const capabilityCheck = assertToolCapability("memory.register", call.envelope);
  if (!capabilityCheck.ok) {
    return malformed(call, "memory.register", capabilityCheck.reason, startAt);
  }
  const args = call.arguments;
  if (!isRegisterArguments(args)) {
    return malformed(call, "memory.register", "memory.register requires content fields", startAt);
  }

  const principal = sanitizePrincipal(call.envelope.principal);
  const scope = resolveScope(args.scope, principal);

  const writeScopeCheck = assertWriteScope(
    call.envelope.principal,
    call.envelope.allowed_scope_aliases,
    scope,
    capabilityCheck.capability
  );
  if (!writeScopeCheck.ok) {
    return denyWriteScope(store, causalStore, call, "memory.register", scope, writeScopeCheck.reason, startAt);
  }

  try {
    const trustedEvidenceEventIds = [call.envelope.wake_id];
    let parentEventIds = trustedEvidenceEventIds;
    if (args.memory_id) {
      const existing = await store.read({ scope });
      const head = projectLifecycle(existing).heads.get(args.memory_id);
      if (!head) {
        return malformed(call, "memory.register", "memory target was not found", startAt);
      }
      if (head.state === "forgotten") {
        return malformed(call, "memory.register", "memory target is not active", startAt);
      }
      const revision = existing.find((event) => event.id === head.revisionId);
      if (!ownsMemoryTarget(revision, scope, principal)) {
        return malformed(call, "memory.register", "memory revision target is not authorized", startAt);
      }
      parentEventIds = [...new Set([...trustedEvidenceEventIds, head.revisionId])];
    }

    const event = await store.append({
      type: "memory.registered",
      principal,
      scope,
      visibility: args.visibility,
      source: args.source_type,
      content: args.content,
      tags: ["registered", principal.scope, args.visibility],
      entities: [principal.agentId, principal.scope],
      sensitivity: args.sensitivity,
      parentEventIds,
      confidence: args.confidence,
      memoryId: args.memory_id,
      origin: capabilityCheck.origin
    } satisfies MemoryEventInput);

    // Write-side counterpart to `memory.recalled` (see
    // src/contract/causal.ts `MemoryWrittenPayload` doc comment): one
    // `memory.written` causal event per successful register, so a memory
    // write is reconcilable from causal.jsonl the same way a recall already
    // is. `cause_event_ids` chains to `call.envelope.wake_id`, the same
    // turn/wake context `runtime.ts` `prepareTurn` chains `memory.recalled`
    // to via `request.eventId` — the only turn-identifying id available on
    // this tool-call path. Stamped once per register call regardless of
    // recall mode: this kernel path never sees `recallMode` (see
    // `runtime/recallMode.ts` `guardKernelForRecallMode`, which leaves all
    // four mutating tools live in every mode), so a write is never gated by
    // the recall ablation.
    await recordMemoryWriteEvidence(causalStore, call, event);

    return {
      request_id: call.request_id,
      tool: "memory.register",
      decision: "allow_raw",
      content: [{
        kind: "memory",
        text: "Registered memory with authenticated invocation provenance.",
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
};

export const summarizeMemory = async (
  store: JsonlMemoryStore,
  causalStore: CausalEventStore,
  source: string,
  call: MemoryToolCall
): Promise<MemoryToolResult> => {
  const startAt = Date.now();
  if (hasInvalidV1Envelope(call.envelope.version)) {
    return malformed(call, "memory.summarize", "unsupported envelope", startAt);
  }
  const capabilityCheck = assertToolCapability("memory.summarize", call.envelope);
  if (!capabilityCheck.ok) {
    return malformed(call, "memory.summarize", capabilityCheck.reason, startAt);
  }

  const args = call.arguments;
  if (!isSummarizeArguments(args)) {
    return malformed(call, "memory.summarize", "memory.summarize requires { scope }", startAt);
  }

  const requester = sanitizePrincipal(call.envelope.principal);
  const scope = resolveScope(args.scope, requester);

  const writeScopeCheck = assertWriteScope(
    call.envelope.principal,
    call.envelope.allowed_scope_aliases,
    scope,
    capabilityCheck.capability
  );
  if (!writeScopeCheck.ok) {
    return denyWriteScope(store, causalStore, call, "memory.summarize", scope, writeScopeCheck.reason, startAt);
  }

  const horizon = Math.min(asNumber(args.horizon) || 12, 40);

  try {
    const events = await store.read({ scope });
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

    const summary = await store.append({
      type: "memory.summarized",
      principal: requester,
      scope,
      visibility: "private",
      source,
      content: { kind: "text", text: lines.join("\n") },
      tags: ["summary", ...sourceIds],
      entities: [requester.agentId, requester.scope],
      sensitivity: "normal",
      confidence: 1,
      parentEventIds: sourceIds,
      origin: capabilityCheck.origin
    } satisfies MemoryEventInput);

    const sourceById = new Map(events.map((event) => [event.id, event]));
    await recordMemorySummaryEvidence(causalStore, call, summary, sourceIds.map((id) => sourceById.get(id)!));

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
};

export const forgetMemory = async (
  store: JsonlMemoryStore,
  causalStore: CausalEventStore,
  source: string,
  call: MemoryToolCall
): Promise<MemoryToolResult> => {
  const startAt = Date.now();
  if (hasInvalidV1Envelope(call.envelope.version)) {
    return malformed(call, "memory.forget", "unsupported envelope", startAt);
  }
  const capabilityCheck = assertToolCapability("memory.forget", call.envelope);
  if (!capabilityCheck.ok) {
    return malformed(call, "memory.forget", capabilityCheck.reason, startAt);
  }
  const args = call.arguments;
  if (!isForgetArguments(args)) {
    return malformed(call, "memory.forget", "memory.forget requires { scope, event_ids }", startAt);
  }

  const requester = sanitizePrincipal(call.envelope.principal);
  const scope = resolveScope(args.scope, requester);

  const writeScopeCheck = assertWriteScope(
    call.envelope.principal,
    call.envelope.allowed_scope_aliases,
    scope,
    capabilityCheck.capability
  );
  if (!writeScopeCheck.ok) {
    return denyWriteScope(store, causalStore, call, "memory.forget", scope, writeScopeCheck.reason, startAt);
  }

  try {
    const targets = await store.read({ scope });
    const targetById = new Map(targets.map((event) => [event.id, event]));
    if (!args.event_ids.every((id) => ownsMemoryTarget(targetById.get(id), scope, requester))) {
      return malformed(call, "memory.forget", "memory forget target is not authorized", startAt);
    }
    const event = await store.append({
      type: "memory.forgotten",
      principal: requester,
      scope,
      visibility: "private",
      source,
      content: {
        kind: "text",
        text: `Tombstone for ${args.event_ids.length} event(s).`
      },
      tags: ["forget", "tombstone"],
      entities: [requester.agentId, requester.scope],
      sensitivity: "secret",
      confidence: 1,
      parentEventIds: args.event_ids,
      origin: capabilityCheck.origin
    } satisfies MemoryEventInput);

    await recordMemoryForgottenEvidence(causalStore, call, event, args.event_ids.map((id) => targetById.get(id)!));

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
};

export const promoteMemory = async (
  store: JsonlMemoryStore,
  causalStore: CausalEventStore,
  source: string,
  call: MemoryToolCall
): Promise<MemoryToolResult> => {
  const startAt = Date.now();
  if (hasInvalidV1Envelope(call.envelope.version)) {
    return malformed(call, "memory.promote", "unsupported envelope", startAt);
  }
  const capabilityCheck = assertToolCapability("memory.promote", call.envelope);
  if (!capabilityCheck.ok) {
    return malformed(call, "memory.promote", capabilityCheck.reason, startAt);
  }
  const args = call.arguments;
  if (!isPromoteArguments(args)) {
    return malformed(call, "memory.promote", "memory.promote requires { scope, memory_id }", startAt);
  }

  const requester = sanitizePrincipal(call.envelope.principal);
  const scope = resolveScope(args.scope, requester);

  const writeScopeCheck = assertWriteScope(
    call.envelope.principal,
    call.envelope.allowed_scope_aliases,
    scope,
    capabilityCheck.capability
  );
  if (!writeScopeCheck.ok) {
    return denyWriteScope(store, causalStore, call, "memory.promote", scope, writeScopeCheck.reason, startAt);
  }

  try {
    const existing = await store.read({ scope });
    const head = projectLifecycle(existing).heads.get(args.memory_id);
    if (!head) {
      return malformed(call, "memory.promote", "memory target was not found", startAt);
    }
    if (head.state === "forgotten") {
      return malformed(call, "memory.promote", "memory target is not active", startAt);
    }
    const revision = existing.find((event) => event.id === head.revisionId);
    if (!ownsMemoryTarget(revision, scope, requester)) {
      return malformed(call, "memory.promote", "memory promote target is not authorized", startAt);
    }

    const event = await store.append({
      type: "memory.promoted",
      principal: requester,
      scope,
      visibility: "private",
      source,
      content: {
        kind: "text",
        text: `Promoted memory ${args.memory_id}${args.reason ? `: ${args.reason}` : ""}.`
      },
      tags: ["promote"],
      entities: [requester.agentId, requester.scope],
      sensitivity: "normal",
      parentEventIds: [head.revisionId],
      memoryId: args.memory_id,
      origin: capabilityCheck.origin
    } satisfies MemoryEventInput);

    await recordMemoryPromotedEvidence(causalStore, call, event, revision, args.memory_id);

    return {
      request_id: call.request_id,
      tool: "memory.promote",
      decision: "allow_raw",
      content: [{
        kind: "memory",
        text: `Promoted memory ${args.memory_id}.`,
        event_ids: [event.id],
        scope: event.scope,
        principal: event.principal,
        redactions: [],
        confidence: 1
      }],
      audit: makeAudit(call, [event], startAt)
    };
  } catch (error) {
    return unavailable(call, "memory.promote", String(error instanceof Error ? error.message : error), startAt);
  }
};
