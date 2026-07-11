import * as z from "zod/v4";

import type { MemoryContent } from "./types.js";

/**
 * Mneme's versioned, minimum-slice structured memory export, per
 * `.local/plan/contracts.md`'s "Mneme memory export" registry row
 * (`mneme.memory-export.v1` — minimum slice now, full later at Phase H).
 *
 * This replaces `simfile observe` reading mneme's raw internal
 * `memory/events.jsonl` directly (an unversioned internal format the
 * contract registry forbids exchanging) with a pinned, versioned document:
 * one entry per memory chain, at its latest revision, scope-tagged, with a
 * content checksum — no embeddings, no revision history, no provenance
 * (those are Phase H). Field names mirror `contract/causal.ts`'s
 * `MemoryWrittenPayload` (`memory_id`, `revision_id`, `scope`,
 * `content_sha256`) so the two contracts stay vocabulary-compatible.
 */
export const MNEME_MEMORY_EXPORT_VERSION = "mneme.memory-export.v1" as const;

export interface MnemeMemoryExportEntry {
  memory_id: string;
  revision_id: string;
  scope: string;
  content: MemoryContent;
  content_sha256: string;
}

export interface MnemeMemoryExport {
  version: typeof MNEME_MEMORY_EXPORT_VERSION;
  /** The exporting bank's identity (the mneme runtime's agentId). */
  bank_id: string;
  /** ISO 8601 timestamp. Caller-supplied (see `exportMemories`), never `Date.now()` internally, so export is testable/deterministic. */
  exported_at: string;
  memories: MnemeMemoryExportEntry[];
}

const memoryExportContentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string() }).strict(),
  z.object({ kind: z.literal("claim"), subject: z.string(), predicate: z.string(), object: z.string() }).strict(),
  z.object({ kind: z.literal("decision"), decision: z.string(), rationale: z.string().optional() }).strict(),
  z
    .object({
      kind: z.literal("artifact"),
      path: z.string().optional(),
      uri: z.string().optional(),
      description: z.string()
    })
    .strict(),
  z.object({ kind: z.literal("relationship"), from: z.string(), relation: z.string(), to: z.string() }).strict()
]);

export const mnemeMemoryExportEntrySchema = z
  .object({
    memory_id: z.string().min(1),
    revision_id: z.string().min(1),
    scope: z.string().min(1),
    content: memoryExportContentSchema,
    content_sha256: z.string().min(1)
  })
  .strict();

export const mnemeMemoryExportSchema = z
  .object({
    version: z.literal(MNEME_MEMORY_EXPORT_VERSION),
    bank_id: z.string().min(1),
    exported_at: z.string().min(1),
    memories: z.array(mnemeMemoryExportEntrySchema)
  })
  .strict()
  .superRefine((value, context) => {
    if (Number.isNaN(Date.parse(value.exported_at))) {
      context.addIssue({
        code: "custom",
        message: "exported_at must be a valid ISO 8601 timestamp",
        path: ["exported_at"]
      });
    }
  });

export const validateMnemeMemoryExport = (value: unknown) => mnemeMemoryExportSchema.safeParse(value);

export const parseMnemeMemoryExport = (value: unknown): MnemeMemoryExport => {
  const result = validateMnemeMemoryExport(value);
  if (!result.success) {
    throw new Error(
      `invalid mneme memory export: ${result.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`
    );
  }

  return result.data as MnemeMemoryExport;
};

export const MNEME_MEMORY_EXPORT_FILE_NAME = "export.json" as const;
