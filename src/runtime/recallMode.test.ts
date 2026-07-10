import assert from "node:assert/strict";
import test from "node:test";

import {
  guardKernelForRecallMode,
  MNEME_RECALL_MODE_ENV,
  resolveRecallMode,
  selectShuffledEntries
} from "./recallMode.js";
import type { MemoryRecallEntry } from "./support.js";
import type {
  MemoryEvent,
  MemoryKernel,
  MemoryToolCall,
  MemoryToolCallEnvelope,
  MemoryToolResult
} from "../contract/types.js";

test("resolveRecallMode defaults to on when neither config nor env is set", () => {
  assert.equal(resolveRecallMode(undefined, {}), "on");
});

test("resolveRecallMode reads the env var when config is unset", () => {
  assert.equal(resolveRecallMode(undefined, { [MNEME_RECALL_MODE_ENV]: "off" }), "off");
  assert.equal(resolveRecallMode(undefined, { [MNEME_RECALL_MODE_ENV]: "shuffled" }), "shuffled");
});

test("resolveRecallMode: config beats env", () => {
  assert.equal(resolveRecallMode("on", { [MNEME_RECALL_MODE_ENV]: "off" }), "on");
});

test("resolveRecallMode throws on an invalid config value", () => {
  assert.throws(() => resolveRecallMode("typo", {}), /invalid MNEME_RECALL_MODE value/);
});

test("resolveRecallMode throws on an invalid env value", () => {
  assert.throws(
    () => resolveRecallMode(undefined, { [MNEME_RECALL_MODE_ENV]: "typo" }),
    /invalid MNEME_RECALL_MODE value/
  );
});

const fakeEvent = (id: string, scope: string): MemoryEvent => ({
  id,
  type: "memory.registered",
  createdAt: new Date().toISOString(),
  principal: { agentId: "agent-a", scope: "global" },
  scope,
  visibility: "global",
  source: "test",
  content: { kind: "text", text: `content for ${id}` },
  tags: [],
  entities: [],
  sensitivity: "normal",
  parentEventIds: [],
  checksum: `checksum-${id}`,
  seq: 1
});

const fakeEntry = (id: string, scope: string): MemoryRecallEntry => ({
  event: fakeEvent(id, scope),
  decision: "allow_raw",
  representation: `representation for ${id}`,
  scope
});

test("selectShuffledEntries is degenerate when the on-selection is empty", () => {
  const result = selectShuffledEntries([], [], 1200);
  assert.deepEqual(result, { selected: [], degenerate: true });
});

test("selectShuffledEntries is degenerate when the complement is empty", () => {
  const selected = [fakeEntry("evt-1", "scope-a")];
  const result = selectShuffledEntries(selected, selected, 1200);
  assert.deepEqual(result, { selected: [], degenerate: true });
});

test("selectShuffledEntries prefers other-scope candidates over same-scope ones", () => {
  const selected = [fakeEntry("evt-selected", "scope-a")];
  const sameScope = fakeEntry("evt-same-scope", "scope-a");
  const otherScope = fakeEntry("evt-other-scope", "scope-b");
  const candidates = [...selected, sameScope, otherScope];

  const result = selectShuffledEntries(candidates, selected, 1200);
  assert.equal(result.degenerate, false);
  assert.deepEqual(result.selected.map((entry) => entry.event.id), ["evt-other-scope"]);
});

test("selectShuffledEntries never injects more than the on-selection size", () => {
  const selected = [fakeEntry("evt-selected", "scope-a")];
  const pool = [
    fakeEntry("evt-decoy-1", "scope-b"),
    fakeEntry("evt-decoy-2", "scope-c")
  ];
  const result = selectShuffledEntries([...selected, ...pool], selected, 1200);
  assert.equal(result.selected.length, 1);
});

test("selectShuffledEntries always injects at least one candidate even if it alone exceeds the budget", () => {
  const selected = [fakeEntry("evt-selected", "scope-a")];
  const longEntry: MemoryRecallEntry = {
    ...fakeEntry("evt-decoy-long", "scope-b"),
    representation: "x".repeat(400)
  };
  const result = selectShuffledEntries([...selected, longEntry], selected, 10);
  assert.deepEqual(result, { selected: [longEntry], degenerate: false });
});

test("selectShuffledEntries stops injecting once the budget is exhausted beyond the first item", () => {
  const selected = [fakeEntry("evt-selected-1", "scope-a"), fakeEntry("evt-selected-2", "scope-a")];
  const smallDecoy: MemoryRecallEntry = {
    ...fakeEntry("evt-decoy-small", "scope-b"),
    representation: "x".repeat(20)
  };
  const largeDecoy: MemoryRecallEntry = {
    ...fakeEntry("evt-decoy-large", "scope-c"),
    representation: "x".repeat(400)
  };
  const result = selectShuffledEntries([...selected, smallDecoy, largeDecoy], selected, 10);
  assert.equal(result.degenerate, false);
  assert.deepEqual(result.selected.map((entry) => entry.event.id), ["evt-decoy-small"]);
});

const envelope = (): MemoryToolCallEnvelope => ({
  version: "mneme.memory.tool.v1",
  mode: "awake",
  wake_id: "wake-recallmode-test",
  thread_id: "thread-recallmode-test",
  principal: { agentId: "agent-a", scope: "global" },
  conversation_scope: "global",
  audience_key: "recallmode-test",
  policy_version: "test",
  allowed_scope_aliases: ["all", "current", "global"],
  transport: "in_process",
  nonce: "recallmode-test",
  expires_at: new Date(Date.now() + 60_000).toISOString(),
  capability: "memory"
});

const toolCall = (tool: MemoryToolCall["tool"]): MemoryToolCall => ({
  request_id: `req-${tool}`,
  tool,
  arguments: {},
  envelope: envelope()
});

const countingResult = (tool: MemoryToolCall["tool"]): MemoryToolResult => ({
  request_id: `req-${tool}`,
  tool,
  decision: "allow_raw",
  content: [],
  audit: {
    request_id: `req-${tool}`,
    requester: envelope().principal,
    sources: [],
    transport: "in_process",
    latency_ms: 0
  }
});

const makeCountingKernel = (): { kernel: MemoryKernel; calls: string[] } => {
  const calls: string[] = [];
  const kernel: MemoryKernel = {
    search: async (call) => { calls.push("search"); return countingResult(call.tool); },
    locate: async (call) => { calls.push("locate"); return countingResult(call.tool); },
    register: async (call) => { calls.push("register"); return countingResult(call.tool); },
    summarize: async (call) => { calls.push("summarize"); return countingResult(call.tool); },
    forget: async (call) => { calls.push("forget"); return countingResult(call.tool); },
    promote: async (call) => { calls.push("promote"); return countingResult(call.tool); }
  };
  return { kernel, calls };
};

test("guardKernelForRecallMode passes the kernel through unchanged in on mode", () => {
  const { kernel } = makeCountingKernel();
  assert.equal(guardKernelForRecallMode(kernel, "on"), kernel);
});

test("guardKernelForRecallMode returns well-formed empty search/locate results in off mode", async () => {
  const { kernel, calls } = makeCountingKernel();
  const guarded = guardKernelForRecallMode(kernel, "off");

  const searchResult = await guarded.search(toolCall("memory.search"));
  assert.equal(searchResult.request_id, "req-memory.search");
  assert.equal(searchResult.tool, "memory.search");
  assert.equal(searchResult.decision, "deny");
  assert.deepEqual(searchResult.content, []);
  assert.equal(searchResult.audit.argument_hash, "recall_mode=off");

  const locateResult = await guarded.locate(toolCall("memory.locate"));
  assert.equal(locateResult.tool, "memory.locate");
  assert.equal(locateResult.decision, "deny");
  assert.deepEqual(locateResult.content, []);

  assert.deepEqual(calls, []);
});

test("guardKernelForRecallMode keeps mutating tools live in off and shuffled mode", async () => {
  for (const mode of ["off", "shuffled"] as const) {
    const { kernel, calls } = makeCountingKernel();
    const guarded = guardKernelForRecallMode(kernel, mode);

    await guarded.register(toolCall("memory.register"));
    await guarded.summarize(toolCall("memory.summarize"));
    await guarded.forget(toolCall("memory.forget"));
    await guarded.promote(toolCall("memory.promote"));

    assert.deepEqual(calls, ["register", "summarize", "forget", "promote"]);
  }
});
