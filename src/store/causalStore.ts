import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import {
  CAUSAL_EVENT_VERSION,
  MEMORY_RECALLED_EVENT_TYPE,
  MEMORY_WRITTEN_EVENT_TYPE,
  MNEME_CAUSAL_SYSTEM,
  memoryStreamId,
  mnemeCausalEventId
} from "../contract/causal.js";
import { canonicalJsonStringify, parseCanonicalJson, parseCausalStreamFinal } from "../contract/causal.js";
import {
  assertMnemeParentReferences,
  assertResolvedMnemeParents,
  assertSecretFreeMnemeEvidence,
  parseCompleteMnemeCausalStream,
  parseMnemeCausalEvent
} from "../contract/mnemeEvidence.js";
import type {
  CausalEvent,
  MemoryRecalledCausalEvent,
  MemoryRecalledPayload,
  MemoryWrittenCausalEvent,
  MemoryWrittenPayload
} from "../contract/causal.js";

interface CausalStoreState {
  initialized: boolean;
  seqByStream: Map<string, number>;
  finals: Map<string, number>;
  eventsById: Map<string, CausalEvent>;
}

interface CausalLedgerSnapshot {
  events: CausalEvent[];
  seqByStream: Map<string, number>;
  finals: Map<string, number>;
  eventsById: Map<string, CausalEvent>;
}

const freezeEvidence = <T>(value: T): T => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.values(value).forEach(freezeEvidence);
  return Object.freeze(value);
};

export interface CausalAppendInput<TPayload = Record<string, unknown>> {
  runId: string;
  streamId: string;
  /** Optional authority-owned id, used when this append persists a pre-minted request fact. */
  eventId?: string;
  type: string;
  principalId: string;
  causeEventIds: string[];
  payload: TPayload;
}

export interface ToolRequestAppendInput {
  runId: string;
  agentId: string;
  principalId: string;
  eventId: string;
  tool: string;
  argumentHash: string;
  requestHash: string;
  authorityHash: string;
}

/** Persists the Mneme-owned MCP request fact before anything cites it. */
export const appendToolRequestEvent = (
  store: CausalEventStore,
  input: ToolRequestAppendInput
): Promise<CausalEvent> => store.append({
  runId: input.runId,
  streamId: memoryStreamId(input.agentId),
  eventId: input.eventId,
  type: "memory.tool.request",
  principalId: input.principalId,
  causeEventIds: [],
  payload: {
    argument_sha256: input.argumentHash,
    authority_sha256: input.authorityHash,
    request_sha256: input.requestHash,
    tool: input.tool
  }
});

export interface ToolOutcomeAppendInput {
  runId: string;
  agentId: string;
  principalId: string;
  causeEventIds: string[];
  tool: string;
  decision: string;
  argumentHash: string;
  requestHash: string;
  authorityHash?: string;
}

/** Content-free attempt evidence. Lifecycle facts remain their own events. */
export const appendToolOutcomeEvent = (
  store: CausalEventStore,
  input: ToolOutcomeAppendInput
): Promise<CausalEvent> => store.append({
  runId: input.runId,
  streamId: memoryStreamId(input.agentId),
  type: "memory.tool.outcome",
  principalId: input.principalId,
  causeEventIds: input.causeEventIds,
  payload: {
    argument_sha256: input.argumentHash,
    tool: input.tool,
    decision: input.decision,
    request_sha256: input.requestHash,
    ...(input.authorityHash ? { authority_sha256: input.authorityHash } : {})
  }
});

/**
 * Append-only writer for `noopolis.causal-event.v1` records, kept beside
 * `events.jsonl` (the domain-level MemoryEvent ledger) in the same
 * `memory/` directory. The causal JSONL is a separate, additive stream:
 * it never replaces `events.jsonl` as source of truth for MemoryEvents.
 *
 * Maintains a per-(run_id, stream_id) contiguous seq counter, bootstrapped
 * from any records already on disk so contiguity survives process
 * restarts against the same runtime home.
 */
export class CausalEventStore {
  private static queues = new Map<string, Promise<void>>();
  private static states = new Map<string, CausalStoreState>();
  private readonly causalPath: string;
  private readonly dirPath: string;

  constructor(runtimeHomePath: string) {
    this.dirPath = path.join(runtimeHomePath, "memory");
    this.causalPath = path.join(this.dirPath, "causal.jsonl");
  }

  private streamKey(runId: string, streamId: string): string {
    return `${runId}::${MNEME_CAUSAL_SYSTEM}:${streamId}`;
  }

  private state(): CausalStoreState {
    let state = CausalEventStore.states.get(this.causalPath);
    if (!state) {
      state = { initialized: false, seqByStream: new Map(), finals: new Map(), eventsById: new Map() };
      CausalEventStore.states.set(this.causalPath, state);
    }
    return state;
  }

  private async withQueue<T>(work: () => Promise<T>): Promise<T> {
    const previous = CausalEventStore.queues.get(this.causalPath) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    CausalEventStore.queues.set(this.causalPath, queued);
    await previous;
    try { return await work(); } finally {
      release();
      if (CausalEventStore.queues.get(this.causalPath) === queued) CausalEventStore.queues.delete(this.causalPath);
    }
  }

  private async readPayload(): Promise<string> {
    try {
      return await readFile(this.causalPath, "utf8");
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return "";
      throw error;
    }
  }

  private parseSnapshot(payload: string): CausalLedgerSnapshot {
    const snapshot: CausalLedgerSnapshot = {
      events: [], seqByStream: new Map(), finals: new Map(), eventsById: new Map()
    };
    try {
      if (payload && !payload.endsWith("\n")) throw new Error("missing terminal LF");
      for (const line of payload ? payload.slice(0, -1).split("\n") : []) {
        if (!line) throw new Error("empty record");
        const record = parseCanonicalJson(line);
        if (canonicalJsonStringify(record) !== line) throw new Error("noncanonical causal record");
        if (typeof record === "object" && record !== null && (record as { version?: unknown }).version === "noopolis.causal-stream-final.v1") {
          const final = parseCausalStreamFinal(record);
          if (final.emitter.system !== MNEME_CAUSAL_SYSTEM || !/^memory:.+$/u.test(final.emitter.stream_id)) throw new Error("foreign stream final");
          const key = this.streamKey(final.run_id, final.emitter.stream_id);
          const seq = snapshot.seqByStream.get(key) ?? 0;
          if (final.final_seq !== seq || snapshot.finals.has(key)) throw new Error("invalid or duplicate stream final");
          snapshot.finals.set(key, final.final_seq);
          continue;
        }
        const event = freezeEvidence(parseMnemeCausalEvent(record));
        const key = this.streamKey(event.run_id, event.emitter.stream_id);
        if (snapshot.finals.has(key)) throw new Error("event after stream final");
        if (snapshot.eventsById.has(event.event_id)) throw new Error("duplicate causal event id");
        const expected = (snapshot.seqByStream.get(key) ?? 0) + 1;
        if (event.emitter.seq !== expected) throw new Error("causal stream sequence gap");
        assertMnemeParentReferences(event, snapshot.eventsById);
        snapshot.seqByStream.set(key, event.emitter.seq);
        snapshot.eventsById.set(event.event_id, event);
        snapshot.events.push(event);
      }
      // Keep the whole-stream assertion as a second, independent invariant
      // check over the exact bytes parsed above.
      assertResolvedMnemeParents(snapshot.events);
      return snapshot;
    } catch (error) {
      throw new Error(`invalid causal ledger: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private applySnapshot(snapshot: CausalLedgerSnapshot): void {
    const state = this.state();
    state.seqByStream = new Map(snapshot.seqByStream);
    state.finals = new Map(snapshot.finals);
    state.eventsById = new Map(snapshot.eventsById);
    state.initialized = true;
  }

  private async loadDurableSnapshot(): Promise<CausalLedgerSnapshot> {
    try {
      const snapshot = this.parseSnapshot(await this.readPayload());
      this.applySnapshot(snapshot);
      return snapshot;
    } catch (error) {
      this.state().initialized = false;
      throw error;
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.state().initialized) await this.loadDurableSnapshot();
  }

  private async nextSeq(runId: string, streamId: string): Promise<number> {
    await this.ensureInitialized();
    const key = this.streamKey(runId, streamId);
    const state = this.state();
    if (state.finals.has(key)) throw new Error("causal stream is finalized");
    return (state.seqByStream.get(key) ?? 0) + 1;
  }

  async append<TPayload = Record<string, unknown>>(
    input: CausalAppendInput<TPayload>
  ): Promise<CausalEvent<TPayload>> {
    // Detach caller-owned arrays/payloads before queueing behind any await.
    const durableInput = parseCanonicalJson(canonicalJsonStringify(input)) as unknown as CausalAppendInput<TPayload>;
    return this.withQueue(async () => {
      await mkdir(this.dirPath, { recursive: true });
      assertSecretFreeMnemeEvidence(durableInput.payload);
      const seq = await this.nextSeq(durableInput.runId, durableInput.streamId);
      const eventId = durableInput.eventId ?? mnemeCausalEventId(randomUUID());
      const state = this.state();
      if (state.eventsById.has(eventId)) throw new Error("duplicate causal event id");
      const event: CausalEvent<TPayload> = {
        version: CAUSAL_EVENT_VERSION, run_id: durableInput.runId, event_id: eventId,
        emitter: { system: MNEME_CAUSAL_SYSTEM, stream_id: durableInput.streamId, seq },
        type: durableInput.type, principal_id: durableInput.principalId,
        recorded_at: new Date().toISOString(), cause_event_ids: durableInput.causeEventIds,
        payload: durableInput.payload
      };
      const validated = freezeEvidence(parseMnemeCausalEvent(event));
      assertMnemeParentReferences(validated, state.eventsById);
      await appendFile(this.causalPath, `${canonicalJsonStringify(validated)}\n`, { encoding: "utf8" });
      state.seqByStream.set(this.streamKey(durableInput.runId, durableInput.streamId), seq);
      state.eventsById.set(eventId, validated);
      return validated as CausalEvent<TPayload>;
    });
  }

  async read(): Promise<CausalEvent[]> {
    return this.withQueue(async () => (await this.loadDurableSnapshot()).events);
  }

  /** Seals one durable stream; an exact retry is a successful no-op. */
  async finalizeStream(runId: string, streamId: string): Promise<void> {
    await this.withQueue(async () => {
      const snapshot = await this.loadDurableSnapshot();
      const key = this.streamKey(runId, streamId);
      const state = this.state();
      if (snapshot.finals.has(key)) return;
      await mkdir(this.dirPath, { recursive: true });
      const final = { version: "noopolis.causal-stream-final.v1" as const, run_id: runId, emitter: { system: MNEME_CAUSAL_SYSTEM, stream_id: streamId }, final_seq: snapshot.seqByStream.get(key) ?? 0 };
      await appendFile(this.causalPath, `${canonicalJsonStringify(final)}\n`, { encoding: "utf8" });
      state.finals.set(key, final.final_seq);
    });
  }

  /** Emits a B41 complete stream: canonical events then exactly one final LF. */
  async exportStream(runId: string, streamId: string): Promise<Uint8Array> {
    return this.withQueue(async () => {
      // One read produces both the validated events and the final used below;
      // there is no validate-then-reread substitution window.
      const snapshot = await this.loadDurableSnapshot();
      const events = snapshot.events.filter((event) => event.run_id === runId && event.emitter.stream_id === streamId)
        .sort((left, right) => left.emitter.seq - right.emitter.seq);
      const finalSeq = snapshot.finals.get(this.streamKey(runId, streamId));
      if (finalSeq === undefined) throw new Error("causal stream is not finalized");
      events.forEach((event, index) => { if (event.emitter.seq !== index + 1) throw new Error("causal stream has a gap"); });
      const final = { version: "noopolis.causal-stream-final.v1" as const, run_id: runId, emitter: { system: MNEME_CAUSAL_SYSTEM, stream_id: streamId }, final_seq: finalSeq };
      const bytes = new TextEncoder().encode([...events.map(canonicalJsonStringify), canonicalJsonStringify(final)].join("\n") + "\n");
      parseCompleteMnemeCausalStream(bytes, runId, streamId);
      return bytes;
    });
  }
}

export interface MemoryRecalledAppendInput {
  runId: string;
  agentId: string;
  principalId: string;
  causeEventIds: string[];
  memoryId: string;
  revisionId: string;
  scope: string;
  contentSha256: string;
}

/**
 * Appends one `memory.recalled` causal event for a single selected memory.
 * Callers (runtime.ts `prepareTurn`) emit one of these per selected memory,
 * with `stream_id="memory:<agentId>"` per the B57/B90 packet.
 */
export const appendMemoryRecalledEvent = (
  store: CausalEventStore,
  input: MemoryRecalledAppendInput
): Promise<MemoryRecalledCausalEvent> =>
  store.append<MemoryRecalledPayload>({
    runId: input.runId,
    streamId: memoryStreamId(input.agentId),
    type: MEMORY_RECALLED_EVENT_TYPE,
    principalId: input.principalId,
    causeEventIds: input.causeEventIds,
    payload: {
      memory_id: input.memoryId,
      revision_id: input.revisionId,
      scope: input.scope,
      content_sha256: input.contentSha256
    }
  }) as Promise<MemoryRecalledCausalEvent>;

export interface MemoryWrittenAppendInput {
  runId: string;
  agentId: string;
  principalId: string;
  causeEventIds: string[];
  memoryId: string;
  revisionId: string;
  scope: string;
  contentSha256: string;
}

/**
 * Appends one `memory.written` causal event for a single durably-registered
 * memory. Callers (`kernel/mutations.ts` `registerMemory`) emit one of these
 * per successful `memory.register` call, with
 * `stream_id="memory:<agentId>"` — the same stream `memory.recalled` uses —
 * so writes and recalls for one agent share a single ordered causal stream.
 */
export const appendMemoryWrittenEvent = (
  store: CausalEventStore,
  input: MemoryWrittenAppendInput
): Promise<MemoryWrittenCausalEvent> =>
  store.append<MemoryWrittenPayload>({
    runId: input.runId,
    streamId: memoryStreamId(input.agentId),
    type: MEMORY_WRITTEN_EVENT_TYPE,
    principalId: input.principalId,
    causeEventIds: input.causeEventIds,
    payload: {
      memory_id: input.memoryId,
      revision_id: input.revisionId,
      scope: input.scope,
      content_sha256: input.contentSha256
    }
  }) as Promise<MemoryWrittenCausalEvent>;
