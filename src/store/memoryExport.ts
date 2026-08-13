import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { MNEME_CAUSAL_EVIDENCE_EXPORT_FILE_NAME, MNEME_CAUSAL_EVIDENCE_EXPORT_VERSION } from "../contract/memoryExport.js";
import { CausalEventStore } from "./causalStore.js";

/** Safe B45 evidence egress. It exports only a finalized, scoped causal stream. */
export const causalEvidenceExportFilePath = (runtimeHomePath: string): string =>
  path.join(runtimeHomePath, "memory", MNEME_CAUSAL_EVIDENCE_EXPORT_FILE_NAME);

export const exportFinalizedCausalEvidence = async (
  runtimeHomePath: string,
  runId: string,
  streamId: string
): Promise<{ version: typeof MNEME_CAUSAL_EVIDENCE_EXPORT_VERSION; path: string }> => {
  const bytes = await new CausalEventStore(runtimeHomePath).exportStream(runId, streamId);
  const filePath = causalEvidenceExportFilePath(runtimeHomePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, bytes);
  return { version: MNEME_CAUSAL_EVIDENCE_EXPORT_VERSION, path: filePath };
};

/** Mneme-owned sealing surface used by orchestration; no sibling imports internals. */
export const sealAndExportCausalEvidence = async (
  runtimeHomePath: string,
  runId: string,
  streamId: string
): Promise<{ version: typeof MNEME_CAUSAL_EVIDENCE_EXPORT_VERSION; path: string }> => {
  const store = new CausalEventStore(runtimeHomePath);
  await store.finalizeStream(runId, streamId);
  const bytes = await store.exportStream(runId, streamId);
  const filePath = causalEvidenceExportFilePath(runtimeHomePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, bytes);
  return { version: MNEME_CAUSAL_EVIDENCE_EXPORT_VERSION, path: filePath };
};
