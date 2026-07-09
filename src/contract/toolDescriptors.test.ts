import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { memoryScopeId } from "../identity/ids.js";
import { createMemoryRuntime } from "../runtime/runtime.js";
import { JsonlMemoryStore } from "../store/store.js";
import {
  createMemoryToolDescriptors,
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
    wakeId: "wake-1",
    threadId: "noopolis:agora",
    principal,
    conversationScope: memoryScopeId(principal),
    audienceKey: "agora"
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
  assert.deepEqual(MEMORY_TOOLS_DREAM_SAFE, MEMORY_TOOLS_AWAKE);
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
    async forget() { return result; }
  };
  const [descriptor] = createMemoryToolDescriptors(kernel, { mode: "dream", toolNames: ["memory.search"] });
  assert.ok(descriptor);

  await descriptor.invoke({ scope: "current", query: "maintenance" }, {
    mode: "dream",
    wakeId: "wake-dream",
    threadId: "dream:wake-dream-abc123",
    principal: { agentId: "luna", scope: "global" },
    conversationScope: "global",
    audienceKey: "luna"
  });

  assert.equal(captured?.envelope.mode, "dream");
  assert.equal(captured?.envelope.thread_id, "dream:wake-dream-abc123");
});
