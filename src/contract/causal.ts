import * as z from "zod/v4";
import { createHash } from "node:crypto";
import { canonicalJsonBytes, canonicalJsonStringify, parseCanonicalJson, parseCanonicalJsonBytes } from "./canonicalJson.js";

export { canonicalJsonBytes, canonicalJsonStringify, parseCanonicalJson, parseCanonicalJsonBytes } from "./canonicalJson.js";

/**
 * Mneme's own native copy of the `noopolis.causal-event.v1` wire envelope.
 * This mirrors the canonical shape in `specs/CAUSAL.md` field-for-field but
 * is NOT imported from the root repo — mneme is an independent repo and
 * owns its own type + validator, per the B57 type-sharing rule: the wire
 * JSON is the contract, siblings do not vendor the schema.
 */
export const CAUSAL_EVENT_VERSION = "noopolis.causal-event.v1" as const;

export const CAUSAL_EVENT_SYSTEMS = ["simfile", "moltnet", "mneme", "daimon"] as const;

export type CausalEventSystem = (typeof CAUSAL_EVENT_SYSTEMS)[number];

export const MNEME_CAUSAL_SYSTEM: CausalEventSystem = "mneme";

export interface CausalEventEmitter {
  system: CausalEventSystem;
  stream_id: string;
  seq: number;
}

export interface CausalEvent<TPayload = Record<string, unknown>> {
  version: typeof CAUSAL_EVENT_VERSION;
  run_id: string;
  event_id: string;
  emitter: CausalEventEmitter;
  type: string;
  principal_id: string;
  recorded_at: string;
  cause_event_ids: string[];
  payload: TPayload;
}

export const MEMORY_RECALLED_EVENT_TYPE = "memory.recalled" as const;

/**
 * Payload minimum for `memory.recalled`, per `specs/CAUSAL.md` /
 * `src/ledger/conformance.ts` (root): `memory_id` and `content_sha256` are
 * required; `revision_id` and `scope` are mneme-native additions carried in
 * the B57 family packet's `MemoryRecalledPayload` shape.
 */
export interface MemoryRecalledPayload {
  memory_id: string;
  revision_id: string;
  scope: string;
  content_sha256: string;
}

export type MemoryRecalledCausalEvent = CausalEvent<MemoryRecalledPayload>;

export const MEMORY_WRITTEN_EVENT_TYPE = "memory.written" as const;

/**
 * Payload for `memory.written`, the write-side counterpart to
 * `memory.recalled` (see `MemoryRecalledPayload` doc comment above). Stamped
 * once per successful `memory.register` tool call (see
 * `kernel/mutations.ts` `registerMemory`) so a durable memory write is
 * reconcilable from the causal ledger the same way a recall already is,
 * instead of only from mneme's own `events.jsonl`. `memory_id` is the
 * chain root (own id for a new memory, the existing chain's root id for a
 * new revision); `revision_id` is this specific write's own event id;
 * `content_sha256` mirrors `memory.recalled`'s `content_sha256` field
 * exactly (both are the ledger event's `checksum`).
 */
export interface MemoryWrittenPayload {
  memory_id: string;
  revision_id: string;
  scope: string;
  content_sha256: string;
}

export type MemoryWrittenCausalEvent = CausalEvent<MemoryWrittenPayload>;

const causalEventEmitterSchema = z
  .object({
    system: z.enum(CAUSAL_EVENT_SYSTEMS),
    stream_id: z.string().min(1),
    seq: z.number().int().min(1).refine(Number.isSafeInteger, "seq must be a safe integer")
  })
  .strict();

export const causalEventSchema = z
  .object({
    version: z.literal(CAUSAL_EVENT_VERSION),
    run_id: z.string().min(1),
    event_id: z.string().regex(/^(simfile|moltnet|mneme|daimon):.+$/, "event_id must be <system>:<local>"),
    emitter: causalEventEmitterSchema,
    type: z.string().min(1),
    principal_id: z.string().regex(/^(agent|operator|system):.+$/, "principal_id must be authenticated"),
    recorded_at: z.string().regex(/^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d+)?(?:Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/, "recorded_at must be RFC3339"),
    // B169 D4: cause namespaces are open reconciliation content. The closed
    // event/emitter system list is deliberately not applied here.
    cause_event_ids: z.array(z.string().regex(/^[^:]+:.+$/u)),
    payload: z.record(z.string(), z.unknown())
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.event_id.startsWith(`${value.emitter.system}:`)) {
      context.addIssue({
        code: "custom",
        message: "event_id system prefix must match emitter.system",
        path: ["event_id"]
      });
    }
    if (new Set(value.cause_event_ids).size !== value.cause_event_ids.length) {
      context.addIssue({ code: "custom", message: "cause_event_ids must be unique", path: ["cause_event_ids"] });
    }
    const match = /^(\d{4})-(\d{2})-(\d{2})T/.exec(value.recorded_at);
    if (match) {
      const year = Number(match[1]);
      const month = Number(match[2]);
      const day = Number(match[3]);
      const days = month === 2
        ? ((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28)
        : ([4, 6, 9, 11].includes(month) ? 30 : 31);
      if (day > days) context.addIssue({ code: "custom", message: "recorded_at must be a real calendar date", path: ["recorded_at"] });
    }
  });

export const memoryRecalledPayloadSchema = z
  .object({
    memory_id: z.string().min(1),
    revision_id: z.string().min(1),
    scope: z.string().min(1),
    content_sha256: z.string().min(1)
  })
  .strict();

export const memoryWrittenPayloadSchema = z
  .object({
    memory_id: z.string().min(1),
    revision_id: z.string().min(1),
    scope: z.string().min(1),
    content_sha256: z.string().min(1)
  })
  .strict();

export const validateCausalEvent = (value: unknown) => causalEventSchema.safeParse(value);

export const parseCausalEvent = (value: unknown): CausalEvent => {
  const result = validateCausalEvent(value);
  if (!result.success) {
    throw new Error(
      `invalid causal event: ${result.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`
    );
  }

  return result.data as CausalEvent;
};

export const hashCausalEvent = (event: CausalEvent): string =>
  createHash("sha256").update(canonicalJsonBytes(parseCausalEvent(event))).digest("hex");

export const hashCanonicalJson = (value: unknown): string =>
  createHash("sha256").update(canonicalJsonBytes(value)).digest("hex");

export const CAUSAL_STREAM_FINAL_VERSION = "noopolis.causal-stream-final.v1" as const;
export interface CausalStreamFinal {
  version: typeof CAUSAL_STREAM_FINAL_VERSION;
  run_id: string;
  emitter: { system: CausalEventSystem; stream_id: string };
  final_seq: number;
}
export const causalStreamFinalSchema = z.object({
  version: z.literal(CAUSAL_STREAM_FINAL_VERSION), run_id: z.string().min(1),
  emitter: z.object({ system: z.enum(CAUSAL_EVENT_SYSTEMS), stream_id: z.string().min(1) }).strict(),
  final_seq: z.number().int().min(0).refine(Number.isSafeInteger, "final_seq must be a safe integer")
}).strict();
export const parseCausalStreamFinal = (value: unknown): CausalStreamFinal => {
  const result = causalStreamFinalSchema.safeParse(value);
  if (!result.success) throw new Error(`invalid stream final: ${result.error.issues.map((issue) => issue.message).join("; ")}`);
  return result.data;
};
export const validateCausalStreamFinal = (value: unknown) => causalStreamFinalSchema.safeParse(value);

/** Strict B41 preflight for Mneme's exported JSONL stream. */
export const parseCompleteCausalStream = (bytes: Uint8Array, runId: string, streamId: string): { events: CausalEvent[]; final: CausalStreamFinal } => {
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  if (text.startsWith("\ufeff") || !text.endsWith("\n")) throw new Error("stream must have exactly one terminal LF and no BOM");
  const lines = text.slice(0, -1).split("\n");
  if (!lines.length || lines.some((line) => !line)) throw new Error("stream contains an empty record");
  const records = lines.map((line) => parseCanonicalJson(line));
  const final = parseCausalStreamFinal(records.at(-1));
  if (final.run_id !== runId || final.emitter.system !== MNEME_CAUSAL_SYSTEM || final.emitter.stream_id !== streamId) throw new Error("wrong stream final");
  const events = records.slice(0, -1).map(parseCausalEvent);
  if (events.length !== final.final_seq) throw new Error("stream final is incomplete");
  const ids = new Set<string>();
  events.forEach((event, index) => {
    if (event.run_id !== runId || event.emitter.system !== MNEME_CAUSAL_SYSTEM || event.emitter.stream_id !== streamId || event.emitter.seq !== index + 1) throw new Error("stream event is not contiguous");
    if (ids.has(event.event_id)) throw new Error("duplicate event id");
    ids.add(event.event_id);
  });
  return { events, final };
};

/**
 * Validates a fully-formed `memory.recalled` causal event: the envelope
 * shape plus the `memory.recalled` payload minimum. Used by tests and by
 * `emitCausalFixture` to assert schema validity before writing JSONL.
 */
export const validateMemoryRecalledCausalEvent = (
  value: unknown
): value is MemoryRecalledCausalEvent => {
  const envelope = validateCausalEvent(value);
  if (!envelope.success) {
    return false;
  }

  if (envelope.data.type !== MEMORY_RECALLED_EVENT_TYPE) {
    return false;
  }

  return memoryRecalledPayloadSchema.safeParse(envelope.data.payload).success;
};

/**
 * Validates a fully-formed `memory.written` causal event: the envelope
 * shape plus the `memory.written` payload minimum. Mirrors
 * `validateMemoryRecalledCausalEvent` above.
 */
export const validateMemoryWrittenCausalEvent = (
  value: unknown
): value is MemoryWrittenCausalEvent => {
  const envelope = validateCausalEvent(value);
  if (!envelope.success) {
    return false;
  }

  if (envelope.data.type !== MEMORY_WRITTEN_EVENT_TYPE) {
    return false;
  }

  return memoryWrittenPayloadSchema.safeParse(envelope.data.payload).success;
};

export const NOOPOLIS_RUN_ID_ENV = "NOOPOLIS_RUN_ID";

/**
 * Resolves the shared run id every Noopolis authority stamps into its
 * causal events. Sourced from the `NOOPOLIS_RUN_ID` environment variable
 * (injected into every container by the root compiler), never from model
 * output. Falls back to a stable placeholder so standalone/local runs
 * (outside a compiled container) still produce schema-valid envelopes
 * instead of throwing.
 */
export const resolveCausalRunId = (env: NodeJS.ProcessEnv = process.env): string =>
  env[NOOPOLIS_RUN_ID_ENV]?.trim() || "unset-run";

export const memoryStreamId = (agentId: string): string => `memory:${agentId}`;

export const mnemeCausalEventId = (localId: string): string => `${MNEME_CAUSAL_SYSTEM}:${localId}`;
