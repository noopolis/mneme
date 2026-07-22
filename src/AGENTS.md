# Mneme Source Guide

This folder is the standalone Noopolis memory package implementation.

## Structure

- `contract/` defines runtime-neutral types and provider-neutral memory tool
  descriptors. `lifecycleTypes.ts` holds the B59 lifecycle/capability types
  (split out of `types.ts` to stay under 400 lines; re-exported from
  `types.ts`). `memoryExport.ts` owns the B45 replacement for the retired
  `mneme.memory-export.v1`: `mneme.causal-evidence-export.v1` exports only a
  finalized, explicitly selected causal stream. It never reads a memory bank
  or emits `MemoryContent`.
- `identity/` defines principal, scope, and canonical id helpers.
- `policy/` decides access/redaction for candidate memories. `capability.ts`
  is the B59 capability guard (awake vs dream tokens, origin stamping); it
  also owns `mneme.cap.system.v1` (B62), the foreign-scope-write escalation
  — never produced by the default mode-derived tool envelope, never
  surfaced in a tool descriptor or the MCP surface, only ever set by a
  trusted execution context (`MemoryToolExecutionContext.capability`).
  `writeScope.ts` is the B62 write-scope guard: `assertWriteScope(principal,
  allowedScopeAliases, resolvedScope, capability)` denies a mutating write
  whose resolved literal scope is not derivable from the trusted envelope
  principal/`allowed_scope_aliases` (own canonical scope, own `global`
  variant, or a trusted-system-only literal scope)
  unless the caller holds `mneme.cap.system.v1`. `principal` and
  `allowedScopeAliases` must always come from `call.envelope`, never from
  tool arguments or model output — mirrors capability.ts's origin
  discipline exactly.
- `recall/` ranks memory candidates and renders wake-time packets.
- `store/` contains the append-only JSONL ledger and rebuildable SQLite index.
  `lifecycle.ts` is the B59 lifecycle projection (chain heads, revision
  states, dirty-scope selection) — a pure, rebuildable read model over the
  ledger, never a second source of truth. `causalStore.ts`'s
  `CausalEventStore` is a per-`(run_id, stream_id)` append-only writer for
  `noopolis.causal-event.v1` records. Instances in one Node process share
  sequencing; each read/export operation validates and consumes one durable
  byte snapshot, never a validate-then-reread pair. Keep one writer process
  per runtime home. `JsonlMemoryRuntime` passes its store into
  `createMemoryKernel({ causalStore })`. `appendMemoryWrittenEvent` is the write-side counterpart to
  `appendMemoryRecalledEvent`: one `memory.written` causal event per
  successful `memory.register` call (see `kernel/mutations.ts`), so a
  durable memory write is reconcilable from `causal.jsonl` the same way a
  recall already is, instead of only from `events.jsonl`.
  `mnemeEvidence.ts` revalidates each Mneme event family, stream owner,
  principal, decision/authority/cause shape, secret-free payload, and ordered
  local-parent closure. Local Mneme parents must already exist in the same
  run and owner stream, and an event cannot cite itself. Summary, forget, and
  promote emit separate content-free write/lifecycle facts.
- `kernel/` executes `memory.*` tools against the store, index, and policy.
  `mutations.ts` holds the four capability-gated mutating tools
  (register/summarize/forget/promote), split out of `kernel.ts` to stay
  under 400 lines. Each one calls `assertToolCapability` and then (B62)
  `assertWriteScope` before touching the store; `support.ts`'s
  `denyWriteScope` is the shared, never-silent denial path for that guard —
  it appends one `memory.denied` ledger line (tags `["denied","write"]`,
  written into the envelope principal's own scope, not the claimed foreign
  scope) plus one `memory.write.denied` causal event (`principal_id` always
  the envelope principal), then returns a `deny` result. Never throws.
  `registerMemory` also stamps one `memory.written` causal event per
  successful write (never on a denied/malformed/unavailable outcome),
  `cause_event_ids` chained to `call.envelope.wake_id` (the writing turn) —
  the write-side counterpart to `runtime.ts`'s `memory.recalled` stamp.
  This causal stamp is independent of the B70 recall-mode ablation: the
  kernel never sees `recallMode` at all, and `guardKernelForRecallMode`
  leaves all four mutating tools live in every mode, so a write is always
  reconcilable from the causal ledger regardless of recall mode.
  `memoryExport.ts` seals or exports one selected `CausalEventStore` stream.
  It writes secret-free canonical bytes
  to `memory/causal-evidence.jsonl`; raw bank-wide memory export is retired.
- `runtime/` prepares wake-time memory packets and records turn output.
  `deep-time.ts` is the B59 dream-mode consolidation session (dirty-scope
  selection + the transactional high-water-mark commit). `recallMode.ts` is
  the B70 recall-mode ablation knob (`on`/`off`/`shuffled`, trusted-runtime-
  only, never a tool): `resolveRecallMode` reads `config.recallMode` then
  the `MNEME_RECALL_MODE` env var then defaults to `on`, throwing on an
  invalid value instead of silently defaulting; `buildShuffledRecall` and
  `selectShuffledEntries` compute the shuffled-mode decoy substitution
  (other-scope-first, then stable rank, same token budget as `on`); and
  `guardKernelForRecallMode` wraps `memory.search`/`memory.locate` into a
  well-formed empty result in `off`/`shuffled` mode while leaving the four
  mutating tools live. `runtime.ts`'s `prepareTurn` stamps a
  `memory.recall.mode` causal event every wake, in every mode, and returns a
  frozen copy of the exact finite `allowedScopes` used for recall. Its
  `recordTurn` accepts only the configured bank's agent and stamps one exact
  `memory.written` causal fact for every persisted domain fact.
- `mcp/` exposes the same tool contract through Model Context Protocol and
  lowers only finite trusted `allowedScopes`; it never grants unrestricted
  `all` through the descriptor/MCP path.
- `cli/` provides the local `mneme` entrypoint. `mneme seal` writes the
  authority-owned final and exports it; `mneme export` re-exports an existing
  final. Both require an explicit `--run-id` or injected `NOOPOLIS_RUN_ID`;
  retrying the exact seal is an idempotent no-op before re-export. Neither
  command can select a bank or dump `events.jsonl`.
- `index.ts` is the public Mneme barrel used by Daimon and future extraction.

## Rules

- Do not import from Daimon, Pi, or any runtime adapter.
- Keep provider-specific conversion code outside this package.
- Memory tool protocol names may use dotted names such as `memory.search`.
  Model-facing names must use provider-safe aliases such as `memory_search`.
- Treat the JSONL ledger as source of truth. Indexes and summaries must be
  rebuildable projections.
- MCP must call the same `MemoryKernel` path as in-process integrations.
- Tool authority signs the complete canonical envelope plus request, tool,
  and argument digest. Kernel and recall-mode guards detach and freeze that
  call before their first await, then execute and emit evidence only from the
  verified snapshot. Evidence exports hashes, never raw args.
