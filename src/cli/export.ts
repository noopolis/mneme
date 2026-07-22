import { memoryStreamId, NOOPOLIS_RUN_ID_ENV } from "../contract/causal.js";
import { exportFinalizedCausalEvidence, sealAndExportCausalEvidence } from "../store/memoryExport.js";

export interface MnemeExportArgs { runtimeHomePath: string; agentId: string; runId: string; }

/** `mneme export` never reads memory/events.jsonl or accepts a bank selector. */
export const parseMnemeExportArgs = (argv: string[], env: NodeJS.ProcessEnv = process.env): MnemeExportArgs => {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key?.startsWith("--")) continue;
    const value = argv[index + 1];
    if (value && !value.startsWith("--")) { values.set(key.slice(2), value); index += 1; }
  }
  const runtimeHomePath = values.get("runtime-home") ?? env.MNEME_RUNTIME_HOME;
  const agentId = values.get("agent-id") ?? env.MNEME_AGENT_ID;
  const runId = values.get("run-id")?.trim() || env[NOOPOLIS_RUN_ID_ENV]?.trim();
  if (!runtimeHomePath) throw new Error("mneme export requires --runtime-home or MNEME_RUNTIME_HOME");
  if (!agentId) throw new Error("mneme export requires --agent-id or MNEME_AGENT_ID");
  if (!runId) throw new Error("mneme export requires --run-id or NOOPOLIS_RUN_ID");
  return { runtimeHomePath, agentId, runId };
};

export const runMnemeExportCommand = async (argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<string> => {
  const args = parseMnemeExportArgs(argv, env);
  const result = await exportFinalizedCausalEvidence(args.runtimeHomePath, args.runId, memoryStreamId(args.agentId));
  return result.path;
};

/** `mneme seal` writes the authority-owned final, then exports those exact bytes. */
export const runMnemeSealCommand = async (argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<string> => {
  const args = parseMnemeExportArgs(argv, env);
  const result = await sealAndExportCausalEvidence(args.runtimeHomePath, args.runId, memoryStreamId(args.agentId));
  return result.path;
};
