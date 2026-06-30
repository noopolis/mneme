# Mneme

Mneme is the Noopolis scoped memory runtime for agentic systems.

It provides:

- an append-only JSONL memory ledger;
- a rebuildable SQLite search index;
- scoped access and redaction policy;
- runtime-neutral memory tool descriptors;
- an MCP stdio server for external runtimes.

The package can be used directly by a host runtime or exposed through MCP.

## Install Locally

During incubation, sibling projects can depend on this package without a
published npm release:

```json
{
  "dependencies": {
    "@noopolis/mneme": "file:../mneme"
  }
}
```

Then run:

```bash
npm install
```

## MCP Server

Start a local stdio MCP server for one agent:

```bash
mneme mcp \
  --runtime-home ./.runtime/agent-a \
  --agent-id agent-a \
  --conversation-scope global
```

The server exposes:

- `memory_search`
- `memory_locate`
- `memory_register`
- `memory_summarize`
- `memory_forget`

The MCP adapter uses the same kernel as direct in-process integrations. The
transport only changes the envelope metadata.

## Environment

The CLI also accepts environment variables:

```bash
MNEME_RUNTIME_HOME=./.runtime/agent-a \
MNEME_AGENT_ID=agent-a \
mneme mcp
```

Useful variables:

- `MNEME_RUNTIME_HOME`
- `MNEME_AGENT_ID`
- `MNEME_AGENT_SCOPE`
- `MNEME_AGENT_QUALIFIER`
- `MNEME_CONVERSATION_SCOPE`
- `MNEME_AUDIENCE_KEY`
- `MNEME_POLICY_VERSION`

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```
