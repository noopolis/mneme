# Mneme Working Guide

This repository contains Mneme, the Noopolis scoped memory package.

Mneme owns memory storage, indexing, recall, access policy, tool descriptors,
and MCP transport. It must stay independent from Daimon, Spawnfile, Moltnet,
Pi, OpenClaw, PicoClaw, and other runtime-specific adapters.

## Structure

- `src/contract/` defines runtime-neutral types and tool descriptors.
- `src/identity/` defines principal and scope helpers.
- `src/policy/` decides access and redaction.
- `src/recall/` ranks memory candidates and renders wake packets.
- `src/store/` contains JSONL storage and SQLite indexing.
- `src/kernel/` executes memory tools against storage and policy.
- `src/runtime/` prepares turns and records turn results.
- `src/mcp/` exposes Mneme through Model Context Protocol.
- `src/cli/` contains the `mneme` binary.

## Rules

- Keep runtime-specific glue outside this package.
- Treat JSONL as the source of truth; indexes must remain rebuildable.
- MCP tools must delegate to the same kernel used by in-process integrations.
- Do not write secrets into memory events or package fixtures.
