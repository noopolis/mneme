import * as z from "zod/v4";

import {
  MNEME_CAUSAL_SYSTEM,
  parseCausalEvent,
  parseCompleteCausalStream,
  type CausalEvent,
  type CausalStreamFinal
} from "./causal.js";

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const evidenceStringSchema = z.string().min(1).max(512).refine(
  (value) => !/[\u0000-\u001f\u007f]/u.test(value),
  "evidence strings must not contain control characters"
);
const identitySchema = evidenceStringSchema.max(256);
const causalIdSchema = z.string().regex(/^(simfile|moltnet|mneme|daimon):.+$/).max(512);
const memoryToolSchema = z.enum([
  "memory.search",
  "memory.locate",
  "memory.register",
  "memory.summarize",
  "memory.forget",
  "memory.promote"
]);
const mutatingMemoryToolSchema = z.enum([
  "memory.register",
  "memory.summarize",
  "memory.forget",
  "memory.promote"
]);
const toolDecisionSchema = z.enum([
  "allow_raw",
  "allow_summary",
  "allow_redacted_summary",
  "known_but_private",
  "locate_only",
  "deny",
  "unavailable",
  "malformed_request"
]);

const recalledOrWrittenPayloadSchema = z.object({
  memory_id: identitySchema,
  revision_id: identitySchema,
  scope: evidenceStringSchema,
  content_sha256: digestSchema
}).strict();

const toolRequestPayloadSchema = z.object({
  argument_sha256: digestSchema,
  authority_sha256: digestSchema,
  request_sha256: digestSchema,
  tool: memoryToolSchema
}).strict();

const toolOutcomePayloadSchema = z.object({
  argument_sha256: digestSchema,
  authority_sha256: digestSchema.optional(),
  decision: toolDecisionSchema,
  request_sha256: digestSchema,
  tool: memoryToolSchema
}).strict();

const writeDeniedPayloadSchema = z.object({
  reason_code: z.literal("scope-not-authorized"),
  requested_scope_sha256: digestSchema,
  tool: mutatingMemoryToolSchema
}).strict();

const recallModePayloadSchema = z.object({
  degenerate: z.boolean(),
  injected_count: z.number().int().min(0).max(100_000).refine(Number.isSafeInteger),
  mode: z.enum(["on", "off", "shuffled"]),
  wake_event_id: causalIdSchema
}).strict();

const summaryWrittenPayloadSchema = z.object({
  result_memory_id: identitySchema,
  result_revision_id: identitySchema,
  result_sha256: digestSchema,
  scope_sha256: digestSchema,
  source_event_ids: z.array(identitySchema).min(1).max(256),
  source_sha256: digestSchema
}).strict().superRefine((value, context) => {
  if (new Set(value.source_event_ids).size !== value.source_event_ids.length) {
    context.addIssue({ code: "custom", message: "source_event_ids must be unique", path: ["source_event_ids"] });
  }
});

const forgottenPayloadSchema = z.object({
  result_event_id: identitySchema,
  result_sha256: digestSchema,
  scope_sha256: digestSchema,
  target_event_ids: z.array(identitySchema).min(1).max(256),
  target_sha256: digestSchema
}).strict().superRefine((value, context) => {
  if (new Set(value.target_event_ids).size !== value.target_event_ids.length) {
    context.addIssue({ code: "custom", message: "target_event_ids must be unique", path: ["target_event_ids"] });
  }
});

const promotedPayloadSchema = z.object({
  memory_id: identitySchema,
  result_event_id: identitySchema,
  result_sha256: digestSchema,
  scope_sha256: digestSchema,
  target_revision_id: identitySchema,
  target_revision_sha256: digestSchema
}).strict();

const oneCauseAgentFamilies = new Set([
  "memory.recalled",
  "memory.written",
  "memory.tool.outcome",
  "memory.write.denied",
  "memory.recall.mode",
  "memory.summary.written",
  "memory.lifecycle.forgotten",
  "memory.lifecycle.promoted"
]);

const toolForEffect = new Map<string, string>([
  ["memory.written", "memory.register"],
  ["memory.summary.written", "memory.summarize"],
  ["memory.lifecycle.forgotten", "memory.forget"],
  ["memory.lifecycle.promoted", "memory.promote"]
]);

const forbiddenEvidenceKey = /^(content|text|secret|token|password|credential|api[_-]?key|authorization)$/i;
const secretLikeValue = /(?:(?:raw|top)[_ -]?secret|bearer\s+[A-Za-z0-9._~-]+|sk-[A-Za-z0-9_-]{10,}|ghp_[A-Za-z0-9]{10,}|AIza[0-9A-Za-z_-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;

/** Rejects raw content/credentials before Mneme evidence is persisted or read. */
export const assertSecretFreeMnemeEvidence = (value: unknown, at = "payload", depth = 0): void => {
  if (depth > 16) throw new Error(`${at}: evidence nesting is too deep`);
  if (typeof value === "string") {
    if (value.length > 512) throw new Error(`${at}: unbounded evidence string`);
    if (secretLikeValue.test(value)) throw new Error(`${at}: secret-like evidence value`);
    return;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean" || value === undefined) return;
  if (Array.isArray(value)) {
    if (value.length > 256) throw new Error(`${at}: evidence array is too large`);
    value.forEach((entry, index) => assertSecretFreeMnemeEvidence(entry, `${at}[${index}]`, depth + 1));
    return;
  }
  if (typeof value !== "object") throw new Error(`${at}: invalid evidence value`);
  for (const [key, entry] of Object.entries(value)) {
    if (forbiddenEvidenceKey.test(key)) throw new Error(`${at}.${key}: raw content is forbidden in evidence`);
    assertSecretFreeMnemeEvidence(entry, `${at}.${key}`, depth + 1);
  }
};

const parseKnownPayload = (event: CausalEvent): void => {
  const parse = (schema: z.ZodType): void => {
    const result = schema.safeParse(event.payload);
    if (!result.success) {
      throw new Error(`invalid ${event.type} payload: ${result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
    }
  };

  if (event.type === "memory.recalled" || event.type === "memory.written") return parse(recalledOrWrittenPayloadSchema);
  if (event.type === "memory.tool.request") return parse(toolRequestPayloadSchema);
  if (event.type === "memory.tool.outcome") return parse(toolOutcomePayloadSchema);
  if (event.type === "memory.write.denied") return parse(writeDeniedPayloadSchema);
  if (event.type === "memory.recall.mode") return parse(recallModePayloadSchema);
  if (event.type === "memory.summary.written") return parse(summaryWrittenPayloadSchema);
  if (event.type === "memory.lifecycle.forgotten") return parse(forgottenPayloadSchema);
  if (event.type === "memory.lifecycle.promoted") return parse(promotedPayloadSchema);
  throw new Error(`unsupported Mneme causal event type: ${event.type}`);
};

/** Applies Mneme-owned payload and stream/principal invariants over B41. */
export const parseMnemeCausalEvent = (value: unknown): CausalEvent => {
  const event = parseCausalEvent(value);
  if (event.emitter.system !== MNEME_CAUSAL_SYSTEM || !event.emitter.stream_id.startsWith("memory:")) {
    throw new Error("invalid Mneme causal stream owner");
  }
  const owner = event.emitter.stream_id.slice("memory:".length);
  assertSecretFreeMnemeEvidence(event.payload);
  parseKnownPayload(event);

  if (!owner) throw new Error("Mneme causal stream has no owner");
  if (owner === "mneme-system") {
    if (event.principal_id !== "system:mneme") throw new Error("Mneme system stream principal does not match its owner");
    if (event.type !== "memory.tool.outcome") throw new Error("Mneme system stream only accepts malformed tool outcomes");
    const payload = event.payload as Record<string, unknown>;
    if (payload.decision !== "malformed_request"
      || Object.prototype.hasOwnProperty.call(payload, "authority_sha256")
      || event.cause_event_ids.length !== 0) {
      throw new Error("invalid unauthenticated Mneme tool outcome");
    }
    return event;
  }

  if (event.principal_id !== `agent:${owner}`) {
    throw new Error("Mneme stream principal does not match its owner");
  }

  if (event.type === "memory.tool.request") {
    if (event.cause_event_ids.length !== 0) throw new Error("Mneme tool request must be a causal root");
  } else if (oneCauseAgentFamilies.has(event.type)) {
    if (event.cause_event_ids.length !== 1) throw new Error(`${event.type} requires exactly one causal parent`);
  }

  if (event.type === "memory.tool.outcome"
    && !Object.prototype.hasOwnProperty.call(event.payload, "authority_sha256")) {
    throw new Error("authenticated Mneme tool outcome requires authority_sha256");
  }

  if (event.type === "memory.recall.mode"
    && event.payload.wake_event_id !== event.cause_event_ids[0]) {
    throw new Error("memory.recall.mode cause must match wake_event_id");
  }
  return event;
};

const assertMatchingToolRequest = (event: CausalEvent, parent: CausalEvent): void => {
  if (parent.type !== "memory.tool.request") throw new Error("local Mneme tool effect parent is not a tool request");
  const request = parent.payload as Record<string, unknown>;
  const payload = event.payload as Record<string, unknown>;
  if (event.type === "memory.tool.outcome") {
    for (const key of ["argument_sha256", "authority_sha256", "request_sha256", "tool"] as const) {
      if (payload[key] !== request[key]) throw new Error(`Mneme tool outcome does not match request ${key}`);
    }
    return;
  }
  if (event.type === "memory.write.denied" && payload.tool !== request.tool) {
    throw new Error("Mneme write denial does not match its request tool");
  }
  const expectedTool = toolForEffect.get(event.type);
  if (expectedTool && request.tool !== expectedTool) {
    throw new Error(`${event.type} does not match its request tool`);
  }
};

/** Enforces local parent order, run/owner identity, and request correlation. */
export const assertMnemeParentReferences = (
  event: CausalEvent,
  priorEvents: ReadonlyMap<string, CausalEvent>
): void => {
  for (const cause of event.cause_event_ids) {
    if (cause === event.event_id) throw new Error("Mneme causal event cannot cause itself");
    if (!cause.startsWith("mneme:")) continue;
    const parent = priorEvents.get(cause);
    if (!parent) throw new Error(`unresolved or out-of-order local Mneme causal parent: ${cause}`);
    if (parent.run_id !== event.run_id) throw new Error(`cross-run local Mneme causal parent: ${cause}`);
    if (parent.emitter.stream_id !== event.emitter.stream_id) throw new Error(`cross-owner local Mneme causal parent: ${cause}`);
    assertMatchingToolRequest(event, parent);
  }
};

/** Local Mneme parents must precede children in the same run and owner. */
export const assertResolvedMnemeParents = (events: readonly CausalEvent[]): void => {
  const priorEvents = new Map<string, CausalEvent>();
  for (const event of events) {
    assertMnemeParentReferences(event, priorEvents);
    priorEvents.set(event.event_id, event);
  }
};

export const parseCompleteMnemeCausalStream = (
  bytes: Uint8Array,
  runId: string,
  streamId: string
): { events: CausalEvent[]; final: CausalStreamFinal } => {
  const complete = parseCompleteCausalStream(bytes, runId, streamId);
  const events = complete.events.map(parseMnemeCausalEvent);
  assertResolvedMnemeParents(events);
  return { events, final: complete.final };
};
