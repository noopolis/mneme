import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createMemoryAuthorityHandoff } from "./authority.js";
import { createMemoryKernel } from "../kernel/kernel.js";
import { createMemoryRuntime, memoryAuthorityRuntimeId } from "../runtime/runtime.js";
import { CausalEventStore } from "../store/causalStore.js";
import { JsonlMemoryStore } from "../store/store.js";
import type { MemoryToolCall, MemoryToolCallEnvelope } from "../contract/types.js";
import { hashCanonicalJson } from "../contract/causal.js";

const roots: string[] = [];
const temp = async (): Promise<string> => { const root = await mkdtemp(path.join(os.tmpdir(), "mneme-authority-")); roots.push(root); return root; };
test.afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const authority = {
  secret: "B45 test authority held by trusted adapter",
  bankId: "agent-a",
  runtimeId: "authority-test-runtime"
};
const handoff = createMemoryAuthorityHandoff(authority);
const call = (
  overrides: Partial<MemoryToolCallEnvelope> = {},
  requestId = `req:${Math.random()}`,
  args: Record<string, unknown> = { scope: "current", query: "nothing" }
): MemoryToolCall => {
  const unsigned: Omit<MemoryToolCallEnvelope, "authority"> = {
    version: "mneme.memory.tool.v1", mode: "awake", wake_id: "daimon:trusted-wake", thread_id: "thread-a",
    principal: { agentId: "agent-a", scope: "room", qualifier: "org:room-a" }, conversation_scope: "org:room-a",
    audience_key: "audience-a", policy_version: "policy-a", allowed_scope_aliases: ["current"],
    transport: "in_process", nonce: `nonce:${requestId}`, expires_at: new Date(Date.now() + 60_000).toISOString(), capability: "memory", ...overrides
  };
  const base = { request_id: requestId, tool: "memory.search" as const, arguments: args, envelope: unsigned };
  return { ...base, envelope: { ...unsigned, authority: handoff.issue(base) } };
};

test("B45 direct kernel fails closed without a verifier and attacker envelope fields cannot be forged", async () => {
  const root = await temp();
  const unchecked = createMemoryKernel({ runtimeHomePath: root });
  assert.equal((await unchecked.search(call())).decision, "malformed_request");
  const kernel = createMemoryKernel({ runtimeHomePath: root, authority });
  const forged = call({ audience_key: "attacker", conversation_scope: "attacker", capability: "mneme.cap.system.v1" });
  forged.envelope.authority = "0".repeat(64);
  assert.equal((await kernel.search(forged)).decision, "malformed_request");
  assert.equal((await kernel.search(call({ expires_at: new Date(Date.now() - 1).toISOString() }))).decision, "malformed_request");
  const mutations: Array<(value: MemoryToolCall) => void> = [
    (value) => { value.envelope.principal.agentId = "bank-agent"; },
    (value) => { value.envelope.conversation_scope = "forged-room"; },
    (value) => { value.envelope.thread_id = "forged-session"; },
    (value) => { value.envelope.audience_key = "forged-audience"; },
    (value) => { value.envelope.policy_version = "forged-policy"; },
    (value) => { value.envelope.allowed_scope_aliases = ["all"]; },
    (value) => { value.envelope.capability = "mneme.cap.system.v1"; },
    (value) => { value.envelope.wake_id = "daimon:forged-parent"; },
    (value) => { value.request_id = "forged-request"; }
  ];
  for (const mutate of mutations) {
    const candidate = call(); mutate(candidate);
    assert.equal((await kernel.search(candidate)).decision, "malformed_request");
  }
  const modelArguments = call(); modelArguments.arguments = { scope: "all", query: "ignored", principal: { agentId: "attacker" } };
  assert.equal((await kernel.search(modelArguments)).decision, "malformed_request");
});

test("B45 authority replay is durable across reopen and concurrent kernel callers", async () => {
  const root = await temp(); const first = createMemoryKernel({ runtimeHomePath: root, authority });
  const replay = call({}, "req:replay");
  assert.equal((await first.search(replay)).decision, "deny");
  const reopened = createMemoryKernel({ runtimeHomePath: root, authority });
  assert.equal((await reopened.search(replay)).decision, "malformed_request");
  const concurrent = call({}, "req:concurrent");
  const [left, right] = await Promise.all([first.search(concurrent), reopened.search(concurrent)]);
  assert.deepEqual([left.decision, right.decision].sort(), ["deny", "malformed_request"]);
});

test("B45 produces one content-free authenticated outcome per attempt", async () => {
  const root = await temp(); const kernel = createMemoryKernel({ runtimeHomePath: root, authority });
  const secret = "TOP_SECRET_DO_NOT_EXPORT";
  const args = { scope: "current", query: secret };
  const request = call({}, "req:outcome", args);
  assert.equal((await kernel.search(request)).decision, "deny");
  const outcomes = (await new CausalEventStore(root).read()).filter((event) => event.type === "memory.tool.outcome");
  assert.equal(outcomes.length, 1);
  assert.equal(JSON.stringify(outcomes).includes(secret), false);
  assert.deepEqual(Object.keys(outcomes[0].payload).sort(), ["argument_sha256", "authority_sha256", "decision", "request_sha256", "tool"]);
  assert.equal(outcomes[0].payload.argument_sha256, hashCanonicalJson(args));
  assert.equal((await new JsonlMemoryStore(root).read()).length, 0);
});

test("B45 authority HMAC rejects canonical argument substitution", async () => {
  const root = await temp();
  const kernel = createMemoryKernel({ runtimeHomePath: root, authority });
  const request = call({}, "req:argument-binding", { scope: "current", query: "signed query" });
  request.arguments = { scope: "current", query: "substituted query" };
  assert.equal((await kernel.search(request)).decision, "malformed_request");
});

test("B45 snapshots arguments, nested principal, finite scopes, and mode before authority awaits", async () => {
  const root = await temp();
  const store = new JsonlMemoryStore(root);
  await store.append({
    type: "memory.observed",
    principal: { agentId: "agent-a", scope: "room", qualifier: "org:room-a" },
    scope: "agent:agent-a/scope:room/qualifier:org:room-a",
    visibility: "room",
    source: "test",
    content: { kind: "text", text: "SUBSTITUTED_NEEDLE" },
    tags: [], entities: [], sensitivity: "normal", parentEventIds: []
  });
  const kernel = createMemoryKernel({ runtimeHomePath: root, authority });
  const args = { scope: "current", query: "ORIGINAL_NO_MATCH" };
  const allowedScopes = ["agent:agent-a/scope:room/qualifier:org:room-a"];
  const request = call({ allowed_scopes: allowedScopes }, "req:async-snapshot", args);
  const expectedArgumentHash = hashCanonicalJson(args);

  const pending = kernel.search(request);
  args.query = "SUBSTITUTED_NEEDLE";
  request.envelope.principal.agentId = "attacker";
  allowedScopes[0] = "agent:attacker/scope:global";
  request.envelope.mode = "dream";

  const result = await pending;
  assert.equal(result.decision, "deny");
  assert.equal(result.audit.argument_hash, expectedArgumentHash);
  const outcome = (await new CausalEventStore(root).read()).find((event) => event.type === "memory.tool.outcome");
  assert.equal(outcome?.principal_id, "agent:agent-a");
  assert.equal(outcome?.payload.argument_sha256, expectedArgumentHash);
});

test("B45 authority cannot cross a bank or runtime even when deployments reuse a secret", async () => {
  const root = await temp();
  const otherBank = { ...authority, bankId: "agent-b" };
  const otherRuntime = { ...authority, runtimeId: "other-runtime" };

  assert.throws(() => createMemoryAuthorityHandoff(otherBank).issue({
    request_id: "req:wrong-bank-issue",
    tool: "memory.search",
    arguments: { scope: "current", query: "x" },
    envelope: (() => { const { authority: _ignored, ...unsigned } = call().envelope; return unsigned; })()
  }), /does not own/);

  assert.equal((await createMemoryKernel({ runtimeHomePath: root, authority: otherBank }).search(call({}, "req:cross-bank"))).decision, "malformed_request");
  assert.equal((await createMemoryKernel({ runtimeHomePath: root, authority: otherRuntime }).search(call({}, "req:cross-runtime"))).decision, "malformed_request");

  assert.throws(() => createMemoryRuntime({
    agentId: "agent-a",
    runtimeHomePath: root,
    authority: { ...authority, runtimeId: memoryAuthorityRuntimeId(`${root}-different`) }
  }), /does not match/);
});

test("B45 MCP outcomes cite a persisted authenticated request parent", async () => {
  const root = await temp();
  const kernel = createMemoryKernel({ runtimeHomePath: root, authority });
  const request = call({ transport: "mcp", wake_id: "mneme:mcp-request-proof" }, "req:mcp-parent");
  assert.equal((await kernel.search(request)).decision, "deny");

  const events = await new CausalEventStore(root).read();
  const parent = events.find((event) => event.event_id === request.envelope.wake_id);
  const outcome = events.find((event) => event.type === "memory.tool.outcome");
  assert.equal(parent?.type, "memory.tool.request");
  assert.deepEqual(outcome?.cause_event_ids, [parent?.event_id]);
  const ids = new Set(events.map((event) => event.event_id));
  assert.equal(events.flatMap((event) => event.cause_event_ids).filter((id) => id.startsWith("mneme:")).every((id) => ids.has(id)), true);
});

test("B45 altered authority receipt bytes fail closed", async () => {
  const root = await temp();
  const kernel = createMemoryKernel({ runtimeHomePath: root, authority });
  assert.equal((await kernel.search(call({}, "req:receipt-seed"))).decision, "deny");
  const receiptPath = path.join(root, "memory", "authority-receipts.jsonl");
  const receipt = await readFile(receiptPath, "utf8");
  await writeFile(receiptPath, receipt.replace('{"authority_hash"', '{ "authority_hash"'), "utf8");
  assert.equal((await kernel.search(call({}, "req:receipt-after-tamper"))).decision, "malformed_request");
});

test("B45 authenticated outcome bytes cannot delete their authority digest", async () => {
  const root = await temp();
  const kernel = createMemoryKernel({ runtimeHomePath: root, authority });
  assert.equal((await kernel.search(call({}, "req:outcome-authority-tamper"))).decision, "deny");
  const causalPath = path.join(root, "memory", "causal.jsonl");
  const record = JSON.parse((await readFile(causalPath, "utf8")).trim()) as { payload: Record<string, unknown> };
  delete record.payload.authority_sha256;
  await writeFile(causalPath, `${JSON.stringify(record)}\n`, "utf8");
  await assert.rejects(() => new CausalEventStore(root).read(), /requires authority_sha256/);
});
