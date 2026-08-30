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

## Branches and pull requests

**Never commit to `main`.** Every change lands through a pull request, without
exception — including one-line fixes, CI configuration, documentation, and
version bumps. Work on a branch, push it, open the PR, and let CI run.

Direct commits to `main` bypass the checks that catch what local runs do not.
A zero-byte receipt store, a package that ships without its native binary, and
a two-week-red pipeline all reached `main` in this ecosystem while every local
gate was green — CI found them the first time it ran over the code.

- Branch names describe the change: `feat/…`, `fix/…`, `ci/…`, `docs/…`.
- Commit messages are conventional and single-line (`feat:`, `fix:`, `docs:`,
  `ci:`, `chore:`, `refactor:`, `test:`).
- Never add co-author lines, sign-offs, or AI attributions.
- Commit as you go rather than in one batch at the end, so history shows how
  the work progressed.
- Merge with a merge commit rather than a squash when the individual commits
  carry meaning; squashing collapses that history irreversibly.
