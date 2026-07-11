import * as z from "zod/v4";

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
    seq: z.number().int().min(1)
  })
  .strict();

export const causalEventSchema = z
  .object({
    version: z.literal(CAUSAL_EVENT_VERSION),
    run_id: z.string().min(1),
    event_id: z.string().regex(/^[^:]+:.+$/, "event_id must be <system>:<local>"),
    emitter: causalEventEmitterSchema,
    type: z.string().min(1),
    principal_id: z.string().min(1),
    recorded_at: z.string().min(1),
    cause_event_ids: z.array(z.string().min(1)),
    payload: z.record(z.string(), z.unknown())
  })
  .strict()
  .superRefine((value, context) => {
    if (Number.isNaN(Date.parse(value.recorded_at))) {
      context.addIssue({
        code: "custom",
        message: "recorded_at must be a valid ISO 8601 timestamp",
        path: ["recorded_at"]
      });
    }

    if (!value.event_id.startsWith(`${value.emitter.system}:`)) {
      context.addIssue({
        code: "custom",
        message: "event_id system prefix must match emitter.system",
        path: ["event_id"]
      });
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
