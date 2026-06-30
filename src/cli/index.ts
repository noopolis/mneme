#!/usr/bin/env node
const printUsage = (): void => {
  process.stderr.write(`Usage:
  mneme mcp --runtime-home <path> --agent-id <id> [options]

Options:
  --agent-scope <scope>          Principal scope. Default: global
  --agent-qualifier <value>      Principal qualifier for room/team/pair/task scopes
  --conversation-scope <scope>   Conversation scope id. Default: principal scope id
  --audience-key <key>           Audience key. Default: agent id
  --policy-version <version>     Policy version. Default: memory-policy.v1
  --source <label>               Source label for generated memory events
  --token-budget <number>        Default recall token budget

Environment:
  MNEME_RUNTIME_HOME
  MNEME_AGENT_ID
  MNEME_AGENT_SCOPE
  MNEME_AGENT_QUALIFIER
  MNEME_CONVERSATION_SCOPE
  MNEME_AUDIENCE_KEY
  MNEME_POLICY_VERSION
  MNEME_SOURCE
  MNEME_TOKEN_BUDGET
`);
};

const main = async (): Promise<void> => {
  const [command, ...args] = process.argv.slice(2);
  if (command === "help" || command === "--help" || command === "-h") {
    printUsage();
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
