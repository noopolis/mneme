# Daimon Memory Module

This folder is the incubation boundary for the future standalone Noopolis memory
package.

## Structure

- `contract/` defines runtime-neutral types and provider-neutral memory tool
  descriptors.
- `identity/` defines principal, scope, and canonical id helpers.
- `policy/` decides access/redaction for candidate memories.
- `recall/` ranks memory candidates and renders wake-time packets.
- `store/` contains the append-only JSONL ledger and rebuildable SQLite index.
- `kernel/` executes `memory.*` tools against the store, index, and policy.
- `runtime/` prepares wake-time memory packets and records turn output.
- `mcp/` exposes the same tool contract through Model Context Protocol.
- `cli/` provides the local `mneme` entrypoint.
- `index.ts` is the public Mneme barrel used by Daimon and future extraction.

## Rules

- Do not import from Daimon, Pi, or any runtime adapter.
- Keep provider-specific conversion code outside this package.
- Memory tool protocol names may use dotted names such as `memory.search`.
  Model-facing names must use provider-safe aliases such as `memory_search`.
- Treat the JSONL ledger as source of truth. Indexes and summaries must be
  rebuildable projections.
- MCP must call the same `MemoryKernel` path as in-process integrations.
