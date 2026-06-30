import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { memoryScopeId } from "../identity/ids.js";
import { createMemoryRuntime } from "../runtime/runtime.js";
import { JsonlMemoryStore } from "../store/store.js";
import { createMemoryToolDescriptors } from "./toolDescriptors.js";
import type { MemoryToolExecutionContext } from "./types.js";

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

