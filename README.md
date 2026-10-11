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
  --mode awake \
  --conversation-scope global
```

The server exposes:

- `memory_search`
- `memory_locate`
- `memory_register`
- `memory_summarize`
- `memory_forget`

`--mode` controls the tool surface and is accepted as either `awake` (default) or
`dream` (maintenance / consolidation-audit surface). Both modes share the same MCP
server binary and transport; only tool descriptions and guidance differ.
Callers should install or inject the awake Mneme skill for normal work and the
dream Mneme skill for one-off consolidation sessions. Dream mode is a session
contract, not a second memory store.

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
- `MNEME_MODE`
- `MNEME_MODE=awake|dream`
- `MNEME_CLOCK_ORIGIN`
- `MNEME_CLOCK_ANCHOR_MS`

## Task clock

All clocks default to wall time. To replay a historical moment, pass a `clock`
option. The public `MemoryClock` type is `() => number`, returning epoch
milliseconds. Use a fixed function for a frozen instant, or `createOffsetClock`
for an advancing clock:

```ts
import { createMemoryRuntime, createOffsetClock } from "@noopolis/mneme";

const clock = createOffsetClock({ origin: "2000-01-01T00:00:00Z" });
const runtime = createMemoryRuntime({
  agentId: "agent-a", runtimeHomePath: "./.runtime/agent-a", clock
});
```

The runtime passes its clock to its kernel, stores and authority checks. It
controls event `createdAt`, causal `recorded_at`, authority `consumed_at`, TTL
visibility, envelope expiry and nonce timestamps. Generated nonces also include
a random UUID so repeated calls stay distinct when the clock is frozen.
Explicit nonces are preserved. Latency measurements and embedding request
timeouts always use real time.

Standalone construction accepts the same option:

- `createMemoryKernel({ runtimeHomePath, clock, ... })`
- `createMnemeMcpServer({ runtimeHomePath, agentId, clock, ... })`
- `new JsonlMemoryStore(runtimeHomePath, { clock })`
- `new CausalEventStore(runtimeHomePath, { clock })`
- `new MemoryAuthorityGuard(runtimeHomePath, authority, { clock })`

Deep-time sessions inherit the clock of the store passed to
`createDeepTimeSession(store)`. Tool descriptors inherit their kernel's clock;
`createMemoryToolDescriptors(kernel, { clock })` and the execution context's
`clock` can override it (context wins). Direct envelope/call builders accept
`clock` in the execution context. MCP inherits a supplied runtime's clock, and
the kernel inherits a supplied causal store's public `clock`. If an explicit
clock is also configured, it must be the same function object as the dependency's
clock or construction throws. Supplied MCP runtimes must expose their clock.
Independently constructed authority guards must use that same clock as well.

For `mneme mcp`, `mneme seal` and `mneme export`, the matching process options are
`--clock-origin` / `MNEME_CLOCK_ORIGIN` and
`--clock-anchor-ms` / `MNEME_CLOCK_ANCHOR_MS`. Each flag takes precedence over its
environment variable. For example:

```bash
mneme mcp \
  --runtime-home ./.runtime/agent-a \
  --agent-id agent-a \
  --clock-origin 2000-01-01T00:00:00Z
```

The clock advances as `origin + (realNow - anchorMs)`. The origin must be an
ISO-8601 instant with an explicit offset or `Z`; the optional anchor must be a
safe integer of epoch milliseconds. Without an anchor, the CLI captures the
time when it starts parsing configuration; the helper captures its construction
time. The helper also accepts `realNow` for deterministic tests. The initial
effective timestamp and its five-minute envelope expiry must both fit within
JavaScript's representable date range. Invalid values, missing flag values and
an anchor without an origin fail startup. Sealing writes
a final record without a timestamp; export copies existing evidence. Both
preserve existing event timestamps.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```
