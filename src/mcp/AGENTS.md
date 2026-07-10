# Mneme MCP

This folder exposes Mneme through Model Context Protocol.

## Structure

- `config.ts` normalizes server options and CLI/environment input.
- `schemas.ts` defines MCP-facing Zod input schemas.
- `server.ts` registers Mneme tools and starts stdio transport.
- `index.ts` is the public MCP barrel.

## Rules

- Do not implement memory behavior here. Delegate to `createMemoryToolDescriptors`
  and the configured `MemoryKernel`.
- Use provider-safe tool names (`memory_search`, not `memory.search`).
- Keep stdio output reserved for MCP transport messages. CLI diagnostics must go
  to stderr.
- `memory_promote` (B59) is dream-only: `createMemoryToolDescriptors` only
  includes it when `mode: "dream"`, and the capability defaulted onto the
  envelope from that same mode is what the kernel actually enforces — this
  folder does not gate it separately.
