import * as z from "zod/v4";

/** B45 replacement for retired `mneme.memory-export.v1`: no memory content. */
export const MNEME_CAUSAL_EVIDENCE_EXPORT_VERSION = "mneme.causal-evidence-export.v1" as const;
export const MNEME_CAUSAL_EVIDENCE_EXPORT_FILE_NAME = "causal-evidence.jsonl" as const;

export interface MnemeCausalEvidenceExport {
  version: typeof MNEME_CAUSAL_EVIDENCE_EXPORT_VERSION;
  run_id: string;
  stream_id: string;
  bytes: Uint8Array;
}

export const mnemeCausalEvidenceExportSchema = z.object({
  version: z.literal(MNEME_CAUSAL_EVIDENCE_EXPORT_VERSION),
  run_id: z.string().min(1),
  stream_id: z.string().min(1),
  bytes: z.instanceof(Uint8Array)
}).strict();
