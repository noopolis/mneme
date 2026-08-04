import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.NOOPOLIS_RUN_ID = "test-kernel-mutation-identity";
import { CausalEventStore } from "../store/causalStore.js";
import { JsonlMemoryStore } from "../store/store.js";
import { memoryScopeId } from "../identity/ids.js";
import { SYSTEM_CAPABILITY } from "../policy/capability.js";
import { createMemoryAuthorityHandoff } from "../policy/authority.js";
import type { MemoryPrincipalRef, MemoryToolCall, MemoryToolCallEnvelope } from "../contract/types.js";
import { createMemoryKernel } from "./kernel.js";
import { assertMutationPrincipalMatchesEnvelope } from "./mutationEvidence.js";

const roots: string[] = [];
const authorityFor = (bankId: string) => ({ secret: "identity-test-authority", bankId, runtimeId: "identity-test-runtime" });
const tempDir = async (): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mneme-identity-"));
  roots.push(root);
  return root;
};
test.afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const envelope = (principal: MemoryPrincipalRef, overrides: Partial<MemoryToolCallEnvelope> = {}): MemoryToolCallEnvelope => ({
  version: "mneme.memory.tool.v1", mode: "awake", wake_id: "daimon:wake-identity", thread_id: "thread-identity",
  principal, conversation_scope: "noopolis:agora", audience_key: "identity", policy_version: "test-1",
  allowed_scope_aliases: ["all", "current", "global"], transport: "in_process", nonce: "nonce-identity",
  expires_at: new Date(Date.now() + 60_000).toISOString(), capability: "memory", ...overrides
});

const call = (requestId: string, tool: MemoryToolCall["tool"], principal: MemoryPrincipalRef, args: Record<string, unknown>, overrides: Partial<MemoryToolCallEnvelope> = {}): MemoryToolCall => {
  const unsigned = { ...envelope(principal, overrides), nonce: `nonce:${requestId}` };
  const handoff = createMemoryAuthorityHandoff(authorityFor(principal.agentId));
  return { request_id: requestId, tool, arguments: args, envelope: { ...unsigned, authority: handoff.issue({ request_id: requestId, tool, arguments: args, envelope: unsigned }) } };
};

const foreignArgs: Record<"memory.register" | "memory.summarize" | "memory.forget" | "memory.promote", (scope: string) => Record<string, unknown>> = {
  "memory.register": (scope) => ({ scope, kind: "text", content: { kind: "text", text: "cross-scope" }, visibility: "global", sensitivity: "normal", source_type: "test" }),
  "memory.summarize": (scope) => ({ scope, horizon: 5 }),
  "memory.forget": (scope) => ({ scope, event_ids: ["evt_missing"], reason: "test" }),
  "memory.promote": (scope) => ({ scope, memory_id: "evt_missing" })
};

for (const tool of ["memory.register", "memory.summarize", "memory.forget", "memory.promote"] as const) {
  test(`B109 ${tool} denies a normal foreign literal scope`, async () => {
    const root = await tempDir();
    const store = new JsonlMemoryStore(root);
    const causalStore = new CausalEventStore(root);
    const kernel = createMemoryKernel({ runtimeHomePath: root, authority: authorityFor("alice") });
    const alice: MemoryPrincipalRef = { agentId: "alice", scope: "global" };
    const foreignScope = memoryScopeId({ agentId: "bob", scope: "global" });
    const override = tool === "memory.promote" ? { mode: "dream" as const, capability: "mneme.cap.dream.v1" as const } : {};
    const invoke = tool === "memory.register" ? kernel.register.bind(kernel) : tool === "memory.summarize" ? kernel.summarize.bind(kernel) : tool === "memory.forget" ? kernel.forget.bind(kernel) : kernel.promote.bind(kernel);
    const result = await invoke(call(`deny-${tool}`, tool, alice, foreignArgs[tool](foreignScope), override));
    assert.equal(result.decision, "deny");
    assert.deepEqual(await store.read({ scope: foreignScope }), []);
    const denied = await store.read({ principalAgentId: "alice", types: ["memory.denied"] });
    assert.equal(denied.length, 1);
    const events = (await causalStore.read()).filter((event) => event.type === "memory.write.denied");
    assert.equal(events.length, 1);
    assert.equal(events[0].principal_id, "agent:alice");
    assert.equal(events[0].payload.requested_scope_sha256, createHash("sha256").update(foreignScope).digest("hex"));
  });
}

test("B109 trusted system capability preserves the envelope principal across scopes", async () => {
  const root = await tempDir();
  const causalStore = new CausalEventStore(root);
  const store = new JsonlMemoryStore(root);
  const kernel = createMemoryKernel({ runtimeHomePath: root, authority: authorityFor("alice"), causalStore });
  const alice: MemoryPrincipalRef = { agentId: "alice", scope: "global" };
  const foreignScope = memoryScopeId({ agentId: "bob", scope: "global" });
  const result = await kernel.register(call("system", "memory.register", alice, { ...foreignArgs["memory.register"](foreignScope) }, { capability: SYSTEM_CAPABILITY }));
  assert.equal(result.decision, "allow_raw");
  const event = (await store.read({ scope: foreignScope, types: ["memory.registered"] }))[0];
  assert.equal(event.principal.agentId, "alice");
  assert.equal((await causalStore.read()).find((entry) => entry.type === "memory.written")?.principal_id, "agent:alice");
});

test("B109 direct kernel legacy evidence injection is malformed with no memory write", async () => {
  const root = await tempDir();
  const store = new JsonlMemoryStore(root);
  const kernel = createMemoryKernel({ runtimeHomePath: root, authority: authorityFor("alice") });
  const alice: MemoryPrincipalRef = { agentId: "alice", scope: "global" };
  const result = await kernel.register(call("legacy-evidence", "memory.register", alice, {
    scope: "current", kind: "text", content: { kind: "text", text: "must not write" }, visibility: "private",
    sensitivity: "normal", source_type: "test", evidence_event_ids: ["fabricated", "cross-run"]
  }));
  assert.equal(result.decision, "malformed_request");
  assert.deepEqual(await store.read({ types: ["memory.registered"] }), []);
});

test("B109 stored principal mismatch fails before evidence append", () => {
  const callValue = { envelope: { principal: { agentId: "alice", scope: "room", qualifier: "Noopolis:Agora" } } } as MemoryToolCall;
  assert.throws(() => assertMutationPrincipalMatchesEnvelope(callValue, { principal: { agentId: "bob", scope: "room" } } as never));
});
