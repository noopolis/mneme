import { exportMemoriesToFile } from "../store/memoryExport.js";
import { JsonlMemoryStore } from "../store/store.js";

/**
 * `mneme export` — the CLI entrypoint for the `mneme.memory-export.v1`
 * min-slice (see `.local/plan/contracts.md`'s "Mneme memory export" row and
 * `contract/memoryExport.ts`). Thin by design (per this repo's CLI
 * philosophy): all business logic lives in `store/memoryExport.ts`; this
 * module only parses argv/env into a bank + writes the file.
 */
export interface MnemeExportArgs {
  runtimeHomePath: string;
  bankId: string;
  exportedAt?: string;
}

export const parseMnemeExportArgs = (
  argv: string[],
  env: NodeJS.ProcessEnv = process.env
): MnemeExportArgs => {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith("--")) {
      continue;
    }
    const key = current.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      values.set(key, "true");
      continue;
    }
    values.set(key, next);
    index += 1;
  }

  const runtimeHomePath = values.get("runtime-home") ?? env.MNEME_RUNTIME_HOME;
  const bankId = values.get("agent-id") ?? env.MNEME_AGENT_ID;
  if (!runtimeHomePath) {
    throw new Error("mneme export requires --runtime-home or MNEME_RUNTIME_HOME");
  }
  if (!bankId) {
    throw new Error("mneme export requires --agent-id or MNEME_AGENT_ID");
  }

  return {
    runtimeHomePath,
    bankId,
    exportedAt: values.get("exported-at")
  };
};

/**
 * Runs the export end to end: parses args, reads the bank's durable
 * `JsonlMemoryStore`, and writes `memory/export.json`. Returns the written
 * file path. `exportedAt` defaults to "now" only at this CLI boundary —
 * `exportMemories`/`exportMemoriesToFile` themselves never call
 * `Date.now()` so they stay deterministic for callers that pass their own
 * timestamp (tests, or a future simfile driver call).
 */
export const runMnemeExportCommand = async (
  argv: string[],
  env: NodeJS.ProcessEnv = process.env
): Promise<string> => {
  const args = parseMnemeExportArgs(argv, env);
  const store = new JsonlMemoryStore(args.runtimeHomePath);
  const exportedAt = args.exportedAt ?? new Date().toISOString();
  return exportMemoriesToFile(args.runtimeHomePath, { bankId: args.bankId, store }, exportedAt);
};
