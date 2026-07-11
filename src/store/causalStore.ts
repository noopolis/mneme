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
import type {
  CausalEvent,
  MemoryRecalledCausalEvent,
  MemoryRecalledPayload,
  MemoryWrittenCausalEvent,
  MemoryWrittenPayload
} from "../contract/causal.js";

export interface CausalAppendInput<TPayload = Record<string, unknown>> {
  runId: string;
  streamId: string;
  type: string;
  principalId: string;
  causeEventIds: string[];
  payload: TPayload;
}

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
  private readonly causalPath: string;
  private readonly dirPath: string;
  private readonly seqByStream = new Map<string, number>();
  private initialized = false;

  constructor(runtimeHomePath: string) {
    this.dirPath = path.join(runtimeHomePath, "memory");
    this.causalPath = path.join(this.dirPath, "causal.jsonl");
  }

  private streamKey(runId: string, streamId: string): string {
    return `${runId}::${MNEME_CAUSAL_SYSTEM}:${streamId}`;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }
    this.initialized = true;

    let payload = "";
    try {
      payload = await readFile(this.causalPath, "utf8");
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return;
      }
      throw error;
    }

    for (const line of payload.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      try {
        const event = JSON.parse(trimmed) as CausalEvent;
        const key = this.streamKey(event.run_id, event.emitter.stream_id);
        const currentMax = this.seqByStream.get(key) ?? 0;
        if (event.emitter.seq > currentMax) {
          this.seqByStream.set(key, event.emitter.seq);
        }
      } catch {
        // Bootstrapping the in-memory seq counter only; malformed lines are
        // skipped here rather than validated. Schema validation belongs to
        // the root conformance harness (src/ledger/conformance.ts).
      }
    }
  }

  private async nextSeq(runId: string, streamId: string): Promise<number> {
    await this.ensureInitialized();
    const key = this.streamKey(runId, streamId);
    const next = (this.seqByStream.get(key) ?? 0) + 1;
    this.seqByStream.set(key, next);
    return next;
  }

  async append<TPayload = Record<string, unknown>>(
    input: CausalAppendInput<TPayload>
  ): Promise<CausalEvent<TPayload>> {
    await mkdir(this.dirPath, { recursive: true });
    const seq = await this.nextSeq(input.runId, input.streamId);

    const event: CausalEvent<TPayload> = {
      version: CAUSAL_EVENT_VERSION,
      run_id: input.runId,
      event_id: mnemeCausalEventId(randomUUID()),
      emitter: {
        system: MNEME_CAUSAL_SYSTEM,
        stream_id: input.streamId,
        seq
      },
      type: input.type,
      principal_id: input.principalId,
      recorded_at: new Date().toISOString(),
      cause_event_ids: input.causeEventIds,
      payload: input.payload
    };

    await appendFile(this.causalPath, `${JSON.stringify(event)}\n`, { encoding: "utf8" });
    return event;
  }

  async read(): Promise<CausalEvent[]> {
    let payload = "";
    try {
      payload = await readFile(this.causalPath, "utf8");
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const events: CausalEvent[] = [];
    for (const line of payload.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      events.push(JSON.parse(trimmed) as CausalEvent);
    }
    return events;
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
