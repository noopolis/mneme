#!/usr/bin/env node
const printUsage = (): void => {
  process.stderr.write(`Usage:
  mneme mcp --runtime-home <path> --agent-id <id> [options]
  mneme seal --runtime-home <path> --agent-id <id> [--run-id <id>]
  mneme export --runtime-home <path> --agent-id <id> [--run-id <id>]

Options (mcp):
  --agent-scope <scope>          Principal scope. Default: global
  --agent-qualifier <value>      Principal qualifier for room/team/pair/task scopes
  --mode <awake|dream>           MCP wake mode. Default: awake
  --conversation-scope <scope>   Conversation scope id. Default: principal scope id
  --audience-key <key>           Audience key. Default: agent id
  --allowed-scopes <ids>         Comma-separated finite scope ids. Default: current,global
  --policy-version <version>     Policy version. Default: memory-policy.v1
  --source <label>               Source label for generated memory events
  --token-budget <number>        Default recall token budget
  --embedding-provider <name>     Embedding provider. Supported: ollama
  --embedding-model <name>        Embedding model name
  --embedding-base-url <url>      Embedding provider base URL
  --embedding-dimensions <n>      Expected embedding vector dimensions
  --embedding-timeout-ms <ms>     Embedding request timeout

Options (seal/export):
  --run-id <id>                  Causal run id. Required unless NOOPOLIS_RUN_ID is set

  seal writes the Mneme-owned final and exports the exact scoped stream.
  export only re-exports an already-finalized scoped stream. Both write
  mneme.causal-evidence-export.v1 bytes to
  <runtime-home>/memory/causal-evidence.jsonl. Raw memory export is retired.

Environment:
  MNEME_RUNTIME_HOME
  MNEME_AGENT_ID
  NOOPOLIS_RUN_ID
  MNEME_AGENT_SCOPE
  MNEME_AGENT_QUALIFIER
  MNEME_CONVERSATION_SCOPE
  MNEME_AUDIENCE_KEY
  MNEME_ALLOWED_SCOPES
  MNEME_POLICY_VERSION
  MNEME_MODE
  MNEME_SOURCE
  MNEME_TOKEN_BUDGET
  MNEME_EMBEDDING_PROVIDER
  MNEME_EMBEDDING_MODEL
  MNEME_EMBEDDING_BASE_URL
  MNEME_EMBEDDING_DIMENSIONS
  MNEME_EMBEDDING_TIMEOUT_MS
`);
};

const main = async (): Promise<void> => {
  const [command, ...args] = process.argv.slice(2);
  if (command === "help" || command === "--help" || command === "-h") {
    printUsage();
    return;
  }

  if (command === "export" || command === "seal") {
    const { runMnemeExportCommand, runMnemeSealCommand } = await import("./export.js");
    const writtenPath = command === "seal"
      ? await runMnemeSealCommand(args)
      : await runMnemeExportCommand(args);
    process.stdout.write(`${writtenPath}\n`);
    return;
  }

  if (command !== "mcp") {
    printUsage();
    process.exitCode = 2;
    return;
  }

  const { connectMnemeMcpStdio } = await import("../mcp/server.js");
  const { parseMnemeMcpArgs } = await import("../mcp/config.js");
  await connectMnemeMcpStdio(parseMnemeMcpArgs(args));
};

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
