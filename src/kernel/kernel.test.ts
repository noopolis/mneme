import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { JsonlMemoryStore } from "../store/store.js";
import { createMemoryKernel } from "./kernel.js";
import { memoryScopeId } from "../identity/ids.js";
import type { MemoryToolCall } from "../contract/types.js";

type Principal = { agentId: string; scope: "global" | "room" | "pair" | "team" | "role" | "task" | "artifact"; qualifier?: string };

const tempRoots: string[] = [];
const tempDir = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "noopolis-daimon-kernel-"));
  tempRoots.push(directory);
  return directory;
};

test.afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const seedText = async (
  store: JsonlMemoryStore,
  principal: Principal,
  input: { visibility: "private" | "pair" | "team" | "room" | "global" | "public" | "sealed"; scope?: string; text: string }
): Promise<string> =>
  (await store.append({
    type: "memory.observed",
    principal,
    scope: input.scope ?? memoryScopeId(principal),
    visibility: input.visibility,
    source: "kernel-test",
    content: { kind: "text", text: input.text },
    tags: ["seed"],
    entities: [principal.agentId],
    sensitivity: "normal",
    parentEventIds: []
  })).id;

const envelope = (principal: Principal) => ({
  version: "mneme.memory.tool.v1" as const,
  wake_id: "wake-kernel",
  thread_id: "thread-kernel",
  principal,
  conversation_scope: "noopolis:agora",
  audience_key: "kernel",
  policy_version: "test-1",
  allowed_scope_aliases: ["current", "global", "current_room", "current_pair", "current_task", "public_profile", "public_facts"] as Array<
    "current" | "global" | "current_room" | "current_pair" | "current_task" | "public_profile" | "public_facts"
  >,
  transport: "in_process" as const,
  nonce: "nonce-1",
  expires_at: new Date(Date.now() + 60_000).toISOString(),
  capability: "memory",
});

const call = (
  requestId: string,
  tool: MemoryToolCall["tool"],
  principal: Principal,
  args: Record<string, unknown>
): MemoryToolCall => ({
  request_id: requestId,
  tool,
  arguments: args,
  envelope: envelope(principal)
});

test("search and locate do not leak private content", async () => {
  const root = await tempDir();
  const store = new JsonlMemoryStore(root);
  const kernel = createMemoryKernel({ runtimeHomePath: root, source: "kernel-test" });
  const requester: Principal = { agentId: "agent-a", scope: "room", qualifier: "noopolis:agora" };

  const privateId = await seedText(store, {
    agentId: "agent-a",
    scope: "pair",
    qualifier: "agent-b"
  }, {
    visibility: "private",
    text: "PRIVATE_MARKER this should not be exposed"
  });

  await seedText(store, {
    agentId: "agent-a",
    scope: "room",
    qualifier: "noopolis:agora"
  }, {
    visibility: "global",
    text: "GLOBAL_SUMMARY marker available to requester"
  });

  const locateResult = await kernel.locate(call("loc-1", "memory.locate", requester, {
    query: "PRIVATE_MARKER",
    limit: 5
  }));

  assert.equal(locateResult.decision, "locate_only");
  assert.equal(locateResult.content.length > 0, true);
  assert.equal(locateResult.content.some((entry) => entry.text && entry.text.includes("PRIVATE_MARKER")), false);
  assert.equal(locateResult.content.some((entry) => entry.event_ids.includes(privateId)), false);

  const searchResult = await kernel.search(call("search-1", "memory.search", requester, {
    scope: "all",
    query: "PRIVATE_MARKER"
  }));

  assert.equal(searchResult.decision, "known_but_private");
  assert.equal(searchResult.content.some((entry) => entry.text?.includes("PRIVATE_MARKER")), false);
  assert.equal(searchResult.content.every((entry) => !entry.event_ids.includes(privateId)), true);
});

test("register requires evidence to persist", async () => {
  const root = await tempDir();
  const store = new JsonlMemoryStore(root);
  const kernel = createMemoryKernel({ runtimeHomePath: root, source: "kernel-test" });
  const principal: Principal = { agentId: "agent-a", scope: "global" };
  const evidence = await seedText(store, principal, {
    visibility: "global",
    text: "EVIDENCE_MARKER"
  });

  const rejected = await kernel.register(call("reg-1", "memory.register", principal, {
    scope: memoryScopeId(principal),
    kind: "text",
    content: { kind: "text", text: "bad" },
    visibility: "global",
    sensitivity: "normal",
    evidence_event_ids: [],
    source_type: "test"
  }));

  assert.equal(rejected.decision, "malformed_request");

  const accepted = await kernel.register(call("reg-2", "memory.register", principal, {
    scope: memoryScopeId(principal),
    kind: "text",
    content: { kind: "text", text: "recorded memory" },
    visibility: "global",
    sensitivity: "normal",
    evidence_event_ids: [evidence],
    source_type: "test"
  }));

  assert.equal(accepted.decision, "allow_raw");
  const stored = await store.read({ types: ["memory.registered"], principalAgentId: principal.agentId });
  assert.equal(stored.length, 1);
  assert.equal(stored[0].parentEventIds.includes(evidence), true);
});

test("summarize returns provenance and stores a summary event", async () => {
  const root = await tempDir();
  const store = new JsonlMemoryStore(root);
  const kernel = createMemoryKernel({ runtimeHomePath: root, source: "kernel-test" });
  const principal: Principal = { agentId: "agent-a", scope: "global" };
  const scope = memoryScopeId(principal);
  const first = await seedText(store, principal, { visibility: "global", text: "SUMMARY_A marker one" });
  const second = await seedText(store, principal, { visibility: "global", text: "SUMMARY_B marker two" });

  const summary = await kernel.summarize(call("sum-1", "memory.summarize", principal, {
    scope,
    horizon: 5
  }));

  assert.equal(summary.decision, "allow_summary");
  assert.equal(summary.content.length, 1);
  assert.equal(summary.content[0].event_ids.includes(first), true);
  assert.equal(summary.content[0].event_ids.includes(second), true);

  const summaries = await store.read({ scope, principalAgentId: principal.agentId, types: ["memory.summarized"] });
  const storedSummary = summaries[0];
  assert.ok(storedSummary);
  assert.equal(storedSummary.parentEventIds.includes(first), true);
  assert.equal(storedSummary.parentEventIds.includes(second), true);
});

test("forget writes tombstones and suppresses source in search", async () => {
  const root = await tempDir();
  const store = new JsonlMemoryStore(root);
  const kernel = createMemoryKernel({ runtimeHomePath: root, source: "kernel-test" });
  const principal: Principal = { agentId: "agent-a", scope: "global" };
  const scope = memoryScopeId(principal);

  const forgotten = await seedText(store, principal, {
    visibility: "global",
    text: "FORGET_ME marker"
  });

  const forgottenEvent = await kernel.forget(call("forget-1", "memory.forget", principal, {
    scope,
    event_ids: [forgotten],
    reason: "cleanup"
  }));

  assert.equal(forgottenEvent.decision, "allow_raw");
  const tombstones = await store.read({ types: ["memory.forgotten"], principalAgentId: principal.agentId });
  assert.equal(tombstones.length, 1);
  assert.equal(tombstones[0].parentEventIds.includes(forgotten), true);

  const search = await kernel.search(call("search-2", "memory.search", principal, {
    scope: "all",
    query: "FORGET_ME"
  }));

  assert.equal(search.content.every((entry) => !entry.event_ids.includes(forgotten)), true);
});
