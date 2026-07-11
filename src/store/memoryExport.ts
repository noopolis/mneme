import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  MNEME_MEMORY_EXPORT_FILE_NAME,
  MNEME_MEMORY_EXPORT_VERSION,
  parseMnemeMemoryExport
} from "../contract/memoryExport.js";
import type { MnemeMemoryExport, MnemeMemoryExportEntry } from "../contract/memoryExport.js";
import { projectLifecycle } from "./lifecycle.js";
import type { JsonlMemoryStore } from "./store.js";

/**
 * The bank whose durable memories are being exported: `bankId` is this
 * mneme runtime's own `agentId` (a bank is one agent's `runtimeHomePath`,
 * whose `memory/events.jsonl` may span several scopes the agent
 * participates in — see contract/memoryExport.ts doc comment).
 */
export interface MemoryExportBank {
  bankId: string;
  store: JsonlMemoryStore;
}

/**
 * Reads every memory chain in `bank.store` and returns one
 * `mneme.memory-export.v1`-conformant entry per chain, at its LATEST
 * revision. Forgotten (tombstoned) chains are omitted — an export is a
 * snapshot of what the bank currently knows, not a tombstone ledger.
 *
 * `exportedAt` is caller-supplied (an ISO 8601 timestamp) rather than read
 * from `Date.now()` internally, so this function stays deterministic and
 * testable; callers that want "now" pass `new Date().toISOString()`
 * themselves.
 *
 * Ordering is deterministic: by the memory chain's root creation `seq`
 * (ascending), then by `memory_id` as a stable tiebreak — never by
 * `createdAt` wall-clock (see contracts.md's "ordering is causal, never
 * wall-clock" rule) and never by JS Map iteration order.
 */
export const exportMemories = async (
  bank: MemoryExportBank,
  exportedAt: string
): Promise<MnemeMemoryExport> => {
  const events = await bank.store.read();
  const eventsById = new Map(events.map((event) => [event.id, event]));
  const { heads } = projectLifecycle(events);

  const rootSeq = (memoryId: string): number => eventsById.get(memoryId)?.seq ?? Number.MAX_SAFE_INTEGER;

  const memories: MnemeMemoryExportEntry[] = [];
  for (const head of heads.values()) {
    if (head.state === "forgotten") {
      continue;
    }

    const revisionEvent = eventsById.get(head.revisionId);
    if (!revisionEvent) {
      // Defensive: projectLifecycle only ever points a head at a revision id
      // it saw in `events`, so this should be unreachable in practice.
      continue;
    }

    memories.push({
      memory_id: head.memoryId,
      revision_id: head.revisionId,
      scope: head.scope,
      content: revisionEvent.content,
      content_sha256: revisionEvent.checksum
    });
  }

  memories.sort((left, right) => {
    const seqDelta = rootSeq(left.memory_id) - rootSeq(right.memory_id);
    if (seqDelta !== 0) {
      return seqDelta;
    }
    return left.memory_id.localeCompare(right.memory_id);
  });

  return {
    version: MNEME_MEMORY_EXPORT_VERSION,
    bank_id: bank.bankId,
    exported_at: exportedAt,
    memories
  };
};

export const memoryExportFilePath = (runtimeHomePath: string): string =>
  path.join(runtimeHomePath, "memory", MNEME_MEMORY_EXPORT_FILE_NAME);

/**
 * Writes a `mneme.memory-export.v1` document to `memory/export.json` inside
 * the bank's runtime home, beside `events.jsonl` and `causal.jsonl` (same
 * directory convention as `JsonlMemoryStore` / `CausalEventStore`). Egress
 * (the simfile driver / `spawnfile artifacts export`) picks this file up
 * from the bank's durable volume; this function only makes it available.
 *
 * Re-validates the document against the schema before writing so a caller
 * can never write a malformed export to disk.
 */
export const writeMemoryExport = async (
  runtimeHomePath: string,
  exportDocument: MnemeMemoryExport
): Promise<string> => {
  const validated = parseMnemeMemoryExport(exportDocument);
  const filePath = memoryExportFilePath(runtimeHomePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(validated, null, 2)}\n`, { encoding: "utf8" });
  return filePath;
};

/**
 * Convenience wrapper: exports the bank's current memories and writes them
 * to `memory/export.json` in one call, returning the written file path.
 */
export const exportMemoriesToFile = async (
  runtimeHomePath: string,
  bank: MemoryExportBank,
  exportedAt: string
): Promise<string> => {
  const exportDocument = await exportMemories(bank, exportedAt);
  return writeMemoryExport(runtimeHomePath, exportDocument);
};
