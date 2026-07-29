import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";

import { JsonlMemoryStore } from "../store/store.js";
import { CausalEventStore } from "../store/causalStore.js";
import { createMemoryKernel } from "./kernel.js";
import { memoryScopeId } from "../identity/ids.js";
import { SYSTEM_CAPABILITY } from "../policy/capability.js";
import { createMemoryAuthorityHandoff } from "../policy/authority.js";
import { validateMemoryWrittenCausalEvent } from "../contract/causal.js";
import type { MemoryToolCall, MemoryToolCallEnvelope, MemoryPrincipalRef } from "../contract/types.js";

const tempRoots: string[] = [];
const authorityFor = (bankId: string) => ({ secret: "mutations-test-authority", bankId, runtimeId: "mutations-test-runtime" });
const TEST_AUTHORITY = authorityFor("agent-a");
const tempDir = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "noopolis-daimon-mutations-"));
  tempRoots.push(directory);
  return directory;
};

test.afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const envelope = (
  principal: MemoryPrincipalRef,
  overrides: Partial<MemoryToolCallEnvelope> = {}
): MemoryToolCallEnvelope => ({
  version: "mneme.memory.tool.v1",
  mode: "awake",
  wake_id: "daimon:wake-mutations",
  thread_id: "thread-mutations",
  principal,
  conversation_scope: "noopolis:agora",
  audience_key: "mutations",
  policy_version: "test-1",
  allowed_scope_aliases: ["all", "current", "global"],
  transport: "in_process",
  nonce: "nonce-mutations",
  expires_at: new Date(Date.now() + 60_000).toISOString(),
  capability: "memory",
  ...overrides
});

const call = (
  requestId: string,
  tool: MemoryToolCall["tool"],
  principal: MemoryPrincipalRef,
  args: Record<string, unknown>,
  envelopeOverrides: Partial<MemoryToolCallEnvelope> = {}
): MemoryToolCall => {
  const unsigned = envelopeOverrides.nonce ? envelope(principal, envelopeOverrides) : { ...envelope(principal, envelopeOverrides), nonce: `nonce:${requestId}` };
  const handoff = createMemoryAuthorityHandoff(authorityFor(principal.agentId));
  return { request_id: requestId, tool, arguments: args, envelope: { ...unsigned, authority: handoff.issue({ request_id: requestId, tool, arguments: args, envelope: unsigned }) } };
};

test("B109 register provenance is the wake and authorized head only", async () => {
  const root = await tempDir();
  const store = new JsonlMemoryStore(root);
  const kernel = createMemoryKernel({ runtimeHomePath: root, source: "mutations-test", authority: TEST_AUTHORITY });
  const principal: MemoryPrincipalRef = { agentId: "agent-a", scope: "global" };
  const scope = memoryScopeId(principal);

  const first = await kernel.register(call("reg-1", "memory.register", principal, {
    scope,
    kind: "text",
    content: { kind: "text", text: "revision one" },
    visibility: "global",
    sensitivity: "normal",
    source_type: "test"
  }));
  const rootId = first.content[0].event_ids[0];

  const second = await kernel.register(call("reg-2", "memory.register", principal, {
    scope,
    kind: "text",
    content: { kind: "text", text: "revision two" },
    visibility: "global",
    sensitivity: "normal",
    source_type: "test",
    memory_id: rootId
  }));

  assert.equal(second.decision, "allow_raw");
  const events = await store.read({ scope });
  const revision = events.find((event) => event.id === second.content[0].event_ids[0]);
  const registered = events.find((event) => event.id === rootId);
  assert.deepEqual(registered?.parentEventIds, ["daimon:wake-mutations"]);
  assert.equal(revision?.memoryId, rootId);
  assert.deepEqual(revision?.parentEventIds, ["daimon:wake-mutations", rootId]);
  assert.equal(revision?.origin, "awake");
});

test("register with an unknown memory_id is rejected as malformed", async () => {
  const root = await tempDir();
  const kernel = createMemoryKernel({ runtimeHomePath: root, source: "mutations-test", authority: TEST_AUTHORITY });
  const principal: MemoryPrincipalRef = { agentId: "agent-a", scope: "global" };
  const scope = memoryScopeId(principal);

  const result = await kernel.register(call("reg-unknown", "memory.register", principal, {
    scope,
    kind: "text",
    content: { kind: "text", text: "orphan revision" },
    visibility: "global",
    sensitivity: "normal",
    source_type: "test",
    memory_id: "RAW_SECRET_MEMORY_ID"
  }));

  assert.equal(result.decision, "malformed_request");
  assert.equal(JSON.stringify(result).includes("RAW_SECRET_MEMORY_ID"), false);
});

test("register against a forgotten chain is rejected", async () => {
  const root = await tempDir();
  const kernel = createMemoryKernel({ runtimeHomePath: root, source: "mutations-test", authority: TEST_AUTHORITY });
  const principal: MemoryPrincipalRef = { agentId: "agent-a", scope: "global" };
  const scope = memoryScopeId(principal);

  const first = await kernel.register(call("reg-forget-root", "memory.register", principal, {
    scope,
    kind: "text",
    content: { kind: "text", text: "to be forgotten" },
    visibility: "global",
    sensitivity: "normal",
    source_type: "test"
  }));
  const rootId = first.content[0].event_ids[0];

  await kernel.forget(call("forget-1", "memory.forget", principal, {
    scope,
    event_ids: [rootId],
    reason: "cleanup"
  }));

  const rejected = await kernel.register(call("reg-after-forget", "memory.register", principal, {
    scope,
    kind: "text",
    content: { kind: "text", text: "should not attach" },
    visibility: "global",
    sensitivity: "normal",
    source_type: "test",
    memory_id: rootId
  }));

  assert.equal(rejected.decision, "malformed_request");
});

// Write-side causal event: `memory.written` (see src/contract/causal.ts
// MemoryWrittenPayload doc comment). Mirrors `memory.recalled` — one event
// per successful `memory.register` call, chained via `cause_event_ids` to
// the envelope's `wake_id` (the writing turn), so a memory write is
// reconcilable from causal.jsonl the same way a recall already is.

test("memory.register stamps a schema-valid memory.written event chained to the writing turn for a new memory", async () => {
  const root = await tempDir();
  const causalStore = new CausalEventStore(root);
  const kernel = createMemoryKernel({ runtimeHomePath: root, source: "mutations-test", authority: TEST_AUTHORITY });
  const principal: MemoryPrincipalRef = { agentId: "agent-a", scope: "global" };
  const scope = memoryScopeId(principal);

  const result = await kernel.register(call("reg-written-1", "memory.register", principal, {
    scope,
    kind: "text",
    content: { kind: "text", text: "first write" },
    visibility: "global",
    sensitivity: "normal",
    source_type: "test"
  }, { wake_id: "daimon:wake-writes-turn-1" }));

  const eventId = result.content[0].event_ids[0];

  const causalEvents = await causalStore.read();
  const written = causalEvents.filter((event) => event.type === "memory.written");
  assert.equal(written.length, 1);
  assert.ok(validateMemoryWrittenCausalEvent(written[0]));

  assert.equal(written[0].principal_id, "agent:agent-a");
  assert.equal(written[0].emitter.stream_id, "memory:agent-a");
  assert.deepEqual(written[0].cause_event_ids, ["daimon:wake-writes-turn-1"]);
  // A brand-new memory is its own chain root: memory_id === the register's
  // own event id, same convention runtime.ts uses for memory.recalled
  // (`entry.event.memoryId ?? entry.event.id`).
  assert.equal(written[0].payload.memory_id, eventId);
  assert.equal(written[0].payload.revision_id, eventId);
  assert.equal(written[0].payload.scope, scope);
  assert.ok((written[0].payload.content_sha256 as string).length > 0);
});

test("memory.register stamps memory.written with the chain root as memory_id for a revision, distinct from revision_id", async () => {
  const root = await tempDir();
  const causalStore = new CausalEventStore(root);
  const kernel = createMemoryKernel({ runtimeHomePath: root, source: "mutations-test", authority: TEST_AUTHORITY });
  const principal: MemoryPrincipalRef = { agentId: "agent-a", scope: "global" };
  const scope = memoryScopeId(principal);

  const first = await kernel.register(call("reg-written-root", "memory.register", principal, {
    scope,
    kind: "text",
    content: { kind: "text", text: "revision one" },
    visibility: "global",
    sensitivity: "normal",
    source_type: "test"
  }));
  const rootId = first.content[0].event_ids[0];

  const second = await kernel.register(call("reg-written-revision", "memory.register", principal, {
    scope,
    kind: "text",
    content: { kind: "text", text: "revision two" },
    visibility: "global",
    sensitivity: "normal",
    source_type: "test",
    memory_id: rootId
  }));
  const revisionId = second.content[0].event_ids[0];

  const causalEvents = await causalStore.read();
  const written = causalEvents.filter((event) => event.type === "memory.written");
  // Exactly one memory.written per register call: two calls, two stamps.
  assert.equal(written.length, 2);

  const revisionWritten = written.find((event) => event.payload.revision_id === revisionId);
  assert.ok(revisionWritten);
  assert.ok(validateMemoryWrittenCausalEvent(revisionWritten));
  assert.equal(revisionWritten!.payload.memory_id, rootId);
  assert.notEqual(revisionWritten!.payload.memory_id, revisionWritten!.payload.revision_id);
});

test("memory.register denied by the write-scope guard stamps memory.write.denied but never memory.written", async () => {
  const root = await tempDir();
  const causalStore = new CausalEventStore(root);
  const kernel = createMemoryKernel({ runtimeHomePath: root, source: "mutations-test", authority: authorityFor("alice") });
  const alice: MemoryPrincipalRef = { agentId: "alice", scope: "global" };
  const bob: MemoryPrincipalRef = { agentId: "bob", scope: "global" };
  const foreignScope = memoryScopeId(bob);

  const result = await kernel.register(call("reg-written-denied", "memory.register", alice, {
    scope: foreignScope,
    kind: "text",
    content: { kind: "text", text: "cross-scope write attempt" },
    visibility: "global",
    sensitivity: "normal",
    source_type: "test"
  }));

  assert.equal(result.decision, "deny");

  const causalEvents = await causalStore.read();
  assert.equal(causalEvents.filter((event) => event.type === "memory.written").length, 0);
  assert.equal(causalEvents.filter((event) => event.type === "memory.write.denied").length, 1);
});

test("C1: awake capability is refused for memory.promote", async () => {
  const root = await tempDir();
  const kernel = createMemoryKernel({ runtimeHomePath: root, source: "mutations-test", authority: TEST_AUTHORITY });
  const principal: MemoryPrincipalRef = { agentId: "agent-a", scope: "global" };
  const scope = memoryScopeId(principal);

  const registered = await kernel.register(call("reg-for-promote", "memory.register", principal, {
    scope,
    kind: "text",
    content: { kind: "text", text: "candidate for promotion" },
    visibility: "global",
    sensitivity: "normal",
    source_type: "test"
  }));
  const memoryId = registered.content[0].event_ids[0];

  const result = await kernel.promote(call("promote-awake", "memory.promote", principal, {
    scope,
    memory_id: memoryId
  }));

  assert.equal(result.decision, "malformed_request");
});

test("C1: dream capability promotes the head and stamps origin dream", async () => {
  const root = await tempDir();
  const store = new JsonlMemoryStore(root);
  const kernel = createMemoryKernel({ runtimeHomePath: root, source: "mutations-test", authority: TEST_AUTHORITY });
  const principal: MemoryPrincipalRef = { agentId: "agent-a", scope: "global" };
  const scope = memoryScopeId(principal);

  const registered = await kernel.register(call("reg-for-dream-promote", "memory.register", principal, {
    scope,
    kind: "text",
    content: { kind: "text", text: "candidate for dream promotion" },
    visibility: "global",
    sensitivity: "normal",
    source_type: "test"
  }));
  const memoryId = registered.content[0].event_ids[0];

  const result = await kernel.promote(call("promote-dream", "memory.promote", principal, {
    scope,
    memory_id: memoryId,
    reason: "reviewed during consolidation"
  }, { mode: "dream", capability: "mneme.cap.dream.v1" }));

  assert.equal(result.decision, "allow_raw");
  const events = await store.read({ scope, types: ["memory.promoted"] });
  assert.equal(events.length, 1);
  assert.equal(events[0].origin, "dream");
  assert.equal(events[0].memoryId, memoryId);
});

test("C2: dream mode with an awake capability token is malformed for a mutating tool", async () => {
  const root = await tempDir();
  const kernel = createMemoryKernel({ runtimeHomePath: root, source: "mutations-test", authority: TEST_AUTHORITY });
  const principal: MemoryPrincipalRef = { agentId: "agent-a", scope: "global" };
  const scope = memoryScopeId(principal);

  const result = await kernel.forget(call("forget-mismatch", "memory.forget", principal, {
    scope,
    event_ids: ["evt_whatever"]
  }, { mode: "dream", capability: "mneme.cap.awake.v1" }));

  assert.equal(result.decision, "malformed_request");
});

test("B45 forget rejects more than 256 targets before any domain mutation", async () => {
  const root = await tempDir();
  const store = new JsonlMemoryStore(root);
  const kernel = createMemoryKernel({ runtimeHomePath: root, source: "mutations-test", authority: TEST_AUTHORITY });
  const principal: MemoryPrincipalRef = { agentId: "agent-a", scope: "global" };
  const result = await kernel.forget(call("forget-too-many", "memory.forget", principal, {
    scope: memoryScopeId(principal),
    event_ids: Array.from({ length: 257 }, (_, index) => `evt_${index}`),
    reason: "bounded hostile test"
  }));

  assert.equal(result.decision, "malformed_request");
  assert.deepEqual(await store.read(), []);
  assert.equal((await new CausalEventStore(root).read()).filter((event) => event.type === "memory.tool.outcome").length, 1);
});

test("promote against an unknown memory_id is malformed", async () => {
  const root = await tempDir();
  const kernel = createMemoryKernel({ runtimeHomePath: root, source: "mutations-test", authority: TEST_AUTHORITY });
  const principal: MemoryPrincipalRef = { agentId: "agent-a", scope: "global" };
  const scope = memoryScopeId(principal);

  const result = await kernel.promote(call("promote-unknown", "memory.promote", principal, {
    scope,
    memory_id: "RAW_SECRET_PROMOTE_ID"
  }, { mode: "dream", capability: "mneme.cap.dream.v1" }));

  assert.equal(result.decision, "malformed_request");
  assert.equal(JSON.stringify(result).includes("RAW_SECRET_PROMOTE_ID"), false);
});
