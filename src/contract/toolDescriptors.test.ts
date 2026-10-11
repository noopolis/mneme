import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.NOOPOLIS_RUN_ID = "test-contract-tool-descriptors";

import { memoryScopeId } from "../identity/ids.js";
import { createMemoryRuntime } from "../runtime/runtime.js";
import { JsonlMemoryStore } from "../store/store.js";
import { createMemoryAuthorityHandoff } from "../policy/authority.js";
import { wallClock } from "./clock.js";
import {
  createMemoryToolDescriptors,
  createMemoryToolEnvelope,
  getAwakeMemoryToolInstructions,
  getDreamMemoryToolInstructions,
  MEMORY_TOOLS_DREAM_SAFE,
  MEMORY_TOOLS_AWAKE
} from "./toolDescriptors.js";
import type { MemoryKernel, MemoryToolCall, MemoryToolExecutionContext, MemoryToolResult } from "./types.js";

const tempRoots: string[] = [];

const tempDir = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "noopolis-memory-tools-"));
  tempRoots.push(directory);
  return directory;
};

test.afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("tool descriptors reject clock disagreement at construction and invocation", async () => {
  const root = await tempDir();
  const clock = () => Date.parse("2000-01-01T00:00:00Z");
  const runtime = createMemoryRuntime({ runtimeHomePath: root, agentId: "luna", clock });
  const principal = { agentId: "luna", scope: "global" as const };
  const context: MemoryToolExecutionContext = {
    wakeId: "daimon:descriptor-clock", threadId: "descriptor-clock", principal,
    conversationScope: memoryScopeId(principal), authority: runtime.authority
  };
  const args = {
    scope: "current", kind: "text", content: { kind: "text", text: "DESCRIPTOR_CLOCK" },
    visibility: "private", sensitivity: "normal", source_type: "clock-test"
  };
  for (const configured of [undefined, clock]) {
    const descriptor = createMemoryToolDescriptors(runtime.kernel, { clock: configured })
      .find((tool) => tool.name === "memory.register")!;
    for (const clock of [wallClock, () => Date.parse("2000-01-01T00:00:00Z")]) {
      assert.throws(() => descriptor.invoke(args, { ...context, clock }), /dependency clock.*match/);
    }
    assert.equal((await descriptor.invoke(args, { ...context, clock })).decision, "allow_raw");
  }
  assert.throws(() => createMemoryToolDescriptors(runtime.kernel, { clock: wallClock }), /dependency clock.*match/);
  Object.defineProperty(runtime.kernel, "clock", { value: undefined });
  assert.throws(() => createMemoryToolDescriptors(runtime.kernel, { clock }), /dependency clock.*match/);
  const legacyDescriptor = createMemoryToolDescriptors(runtime.kernel)[0];
  assert.throws(() => legacyDescriptor.invoke({}, { ...context, clock }), /dependency clock.*match/);
});

test("tool envelope nonces stay unique with frozen injected or default clocks and preserve explicit values", (t) => {
  const now = Date.parse("2000-01-01T00:00:00Z");
  const context: MemoryToolExecutionContext = {
    wakeId: "clock-wake", threadId: "clock-thread",
    principal: { agentId: "agent-a", scope: "global" }, conversationScope: "global"
  };
  const envelope = createMemoryToolEnvelope({ ...context, clock: () => now });
  assert.notEqual(createMemoryToolEnvelope({ ...context, clock: () => now }).nonce, envelope.nonce);
  assert.ok(envelope.nonce.startsWith(`clock-wake:${now}:`));
  assert.equal(envelope.expires_at, "2000-01-01T00:05:00.000Z");
  const explicit = createMemoryToolEnvelope({
    ...context, clock: () => { throw new Error("explicit fields need no time read"); },
    nonce: "supplied-nonce", expiresAt: "2000-01-01T00:01:00.000Z"
  });
  assert.equal(explicit.nonce, "supplied-nonce");
  assert.equal(explicit.expires_at, "2000-01-01T00:01:00.000Z");
  t.mock.method(Date, "now", () => now);
  const first = createMemoryToolEnvelope(context);
  const second = createMemoryToolEnvelope(context);
  assert.notEqual(first.nonce, second.nonce);
  assert.ok(first.nonce.startsWith(`clock-wake:${now}:`));
  assert.deepEqual({ ...first, nonce: envelope.nonce }, envelope);
});

test("frozen clock permits two calls in the same wake and thread but rejects an actual replay", async (t) => {
  const root = await tempDir();
  const clock = () => Date.parse("2000-01-01T00:00:00Z");
  const runtime = createMemoryRuntime({ agentId: "luna", runtimeHomePath: root, clock, recallMode: "on" });
  const principal = { agentId: "luna", scope: "global" as const };
  const context: MemoryToolExecutionContext = {
    wakeId: "daimon:frozen-wake", threadId: "frozen-thread", principal,
    conversationScope: memoryScopeId(principal), authority: runtime.authority
  };
  let captured: MemoryToolCall | undefined;
  const register = runtime.kernel.register.bind(runtime.kernel);
  t.mock.method(runtime.kernel, "register", (call: MemoryToolCall) => {
    captured = call;
    return register(call);
  });
  const descriptors = createMemoryToolDescriptors(runtime.kernel);
  const registered = await descriptors.find((tool) => tool.name === "memory.register")!.invoke({
    scope: "current", kind: "text", content: { kind: "text", text: "FROZEN_NONCE_MARKER" },
    visibility: "private", sensitivity: "normal", source_type: "clock-test"
  }, context);
  assert.equal(registered.decision, "allow_raw");
  const searched = await descriptors.find((tool) => tool.name === "memory.search")!.invoke({
    scope: "current", query: "FROZEN_NONCE_MARKER"
  }, context);
  assert.equal(searched.decision, "allow_raw");
  assert.ok(searched.content.some((entry) => entry.text?.includes("FROZEN_NONCE_MARKER")));
  assert.ok(captured);
  const replay = await register(captured);
  assert.equal(replay.decision, "malformed_request");
  assert.equal(replay.error, "replayed authority envelope");
  assert.equal((await new JsonlMemoryStore(root).read({ types: ["memory.registered"] })).length, 1);
});

test("tool descriptors expose provider-safe model names and execute through the kernel", async () => {
  const root = await tempDir();
  const principal = { agentId: "luna", scope: "room" as const, qualifier: "noopolis:agora" };
  await new JsonlMemoryStore(root).append({
    type: "memory.observed",
    principal,
    scope: memoryScopeId(principal),
    visibility: "room",
    source: "descriptor-test",
    content: { kind: "text", text: "DESCRIPTOR_MARKER maps a memory tool call." },
    tags: ["descriptor"],
    entities: ["descriptor"],
    sensitivity: "normal",
    parentEventIds: []
  });

  const runtime = createMemoryRuntime({ agentId: "luna", runtimeHomePath: root });
  const descriptors = createMemoryToolDescriptors(runtime.kernel);
  const search = descriptors.find((descriptor) => descriptor.name === "memory.search");
  assert.ok(search);
  assert.equal(search.modelName, "memory_search");
  assert.equal(search.modelName.includes("."), false);
  assert.equal(search.description, getAwakeMemoryToolInstructions()["memory.search"].description);

  const context: MemoryToolExecutionContext = {
    wakeId: "daimon:wake-1",
    threadId: "noopolis:agora",
    principal,
    conversationScope: memoryScopeId(principal),
    audienceKey: "agora",
    authority: runtime.authority
  };
  const result = await search.invoke({ scope: "current", query: "DESCRIPTOR_MARKER" }, context);

  assert.equal(result.tool, "memory.search");
  assert.ok(result.content.some((entry) => entry.text?.includes("DESCRIPTOR_MARKER")));
});

test("createMemoryToolDescriptors supports dream mode with maintenance-focused instruction text", async () => {
  const root = await tempDir();
  const runtime = createMemoryRuntime({ agentId: "luna", runtimeHomePath: root });
  const descriptors = createMemoryToolDescriptors(runtime.kernel, { mode: "dream" });
  const names = descriptors.map((descriptor) => descriptor.name);

  assert.deepEqual(names, [...MEMORY_TOOLS_DREAM_SAFE]);
  assert.ok(MEMORY_TOOLS_DREAM_SAFE.includes("memory.search"));
  assert.equal(descriptors[0]?.description, getDreamMemoryToolInstructions()["memory.search"].description);
  assert.ok(descriptors[0]?.description.includes("maintenance"));
});

test("B109 register instructions bind provenance to the authenticated invocation", () => {
  for (const instructions of [getAwakeMemoryToolInstructions(), getDreamMemoryToolInstructions()]) {
    const register = instructions["memory.register"];
    const text = [register.description, register.promptSnippet, ...register.promptGuidelines].join("\n");
    assert.match(text, /authenticated invocation/);
    assert.match(text, /attached automatically/);
    assert.match(text, /Do not supply evidence ids or identity fields/);
    assert.doesNotMatch(text, /explicit evidence/i);
  }
});

test("C3: AWAKE stays 5 tools, DREAM_SAFE becomes 6 — memory.promote is dream-only", () => {
  assert.equal(MEMORY_TOOLS_AWAKE.length, 5);
  assert.equal(MEMORY_TOOLS_DREAM_SAFE.length, 6);
  assert.equal((MEMORY_TOOLS_AWAKE as readonly string[]).includes("memory.promote"), false);
  assert.ok(MEMORY_TOOLS_DREAM_SAFE.includes("memory.promote"));
  for (const tool of MEMORY_TOOLS_AWAKE) {
    assert.ok((MEMORY_TOOLS_DREAM_SAFE as readonly string[]).includes(tool), `dream must be a superset covering ${tool}`);
  }
});

test("tool descriptors can be narrowed by options", async () => {
  const root = await tempDir();
  const runtime = createMemoryRuntime({ agentId: "luna", runtimeHomePath: root });
  const descriptors = createMemoryToolDescriptors(runtime.kernel, {
    mode: "dream",
    toolNames: ["memory.search", "memory.forget"]
  });

  assert.deepEqual(
    descriptors.map((descriptor) => descriptor.name),
    ["memory.search", "memory.forget"]
  );
});

test("tool envelopes preserve awake and dream modes", async () => {
  let captured: MemoryToolCall | undefined;
  const result: MemoryToolResult = {
    request_id: "result",
    tool: "memory.search",
    decision: "allow_raw",
    content: [],
    audit: {
      request_id: "result",
      requester: { agentId: "luna", scope: "global" },
      sources: [],
      transport: "in_process",
      latency_ms: 0
    }
  };
  const kernel: MemoryKernel = {
    async search(call) {
      captured = call;
      return result;
    },
    async locate() { return result; },
    async register() { return result; },
    async summarize() { return result; },
    async forget() { return result; },
    async promote() { return result; }
  };
  const [descriptor] = createMemoryToolDescriptors(kernel, { mode: "dream", toolNames: ["memory.search"] });
  assert.ok(descriptor);

  await descriptor.invoke({ scope: "current", query: "maintenance" }, {
    mode: "dream",
    wakeId: "wake-dream",
    threadId: "dream:wake-dream-abc123",
    principal: { agentId: "luna", scope: "global" },
    conversationScope: "global",
    audienceKey: "luna",
    authority: createMemoryAuthorityHandoff({
      secret: "descriptor-capture",
      bankId: "luna",
      runtimeId: "descriptor-test-runtime"
    })
  });

  assert.equal(captured?.envelope.mode, "dream");
  assert.equal(captured?.envelope.thread_id, "dream:wake-dream-abc123");
});

test("B45 execution contexts lower only finite current/global scope grants", () => {
  const principal = { agentId: "luna", scope: "room" as const, qualifier: "noopolis:agora" };
  const base: MemoryToolExecutionContext = {
    wakeId: "daimon:wake-scopes",
    threadId: "thread-scopes",
    principal,
    conversationScope: memoryScopeId(principal)
  };
  const current = memoryScopeId(principal);
  const global = memoryScopeId({ agentId: principal.agentId, scope: "global" });
  const envelope = createMemoryToolEnvelope({ ...base, allowedScopes: [current, global, current] });
  assert.deepEqual(envelope.allowed_scopes, [current, global]);
  assert.equal(envelope.allowed_scope_aliases.includes("all"), false);
  assert.throws(() => createMemoryToolEnvelope({ ...base, allowedScopes: ["all"] }), /unrestricted scope/);
  assert.throws(() => createMemoryToolEnvelope({ ...base, allowedScopeAliases: ["all"] }), /unrestricted all alias/);
});
