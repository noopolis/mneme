import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createMemoryRuntime } from "./runtime.js";
import { JsonlMemoryStore } from "../store/store.js";
import { memoryScopeId } from "../identity/ids.js";
import type { MemoryEmbeddingProvider } from "../store/embedding.js";
import type { MemoryPrincipalRef, MemoryToolCall } from "../contract/types.js";

const tempRoots: string[] = [];

const tempDir = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "noopolis-daimon-memory-"));
  tempRoots.push(directory);
  return directory;
};

const createFakeEmbeddingProvider = (): MemoryEmbeddingProvider => ({
  dimensions: 2,
  embed: async (text: string) => {
    const normalized = text.toLowerCase();
    if (normalized.includes("alpha-drive-marker") || normalized.includes("vehicle-query")) {
      return [1, 0];
    }
    if (normalized.includes("beta-noise-marker") || normalized.includes("ops-marker")) {
      return [0, 1];
    }

    return [0, 1];
  }
});

test.afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const memoryToolCall = (
  principal: MemoryPrincipalRef,
  args: Record<string, unknown>
): MemoryToolCall => ({
  request_id: "runtime-test-memory-search",
  tool: "memory.search",
  arguments: args,
	  envelope: {
	    version: "mneme.memory.tool.v1",
	    mode: "awake",
	    wake_id: "runtime-test-wake",
    thread_id: "runtime-test-thread",
    principal,
    conversation_scope: principal.qualifier ?? principal.scope,
    audience_key: "runtime-test",
    policy_version: "test",
	    allowed_scope_aliases: ["all", "current", "global", "current_room", "current_pair", "current_task"],
    transport: "in_process",
    nonce: "runtime-test",
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    capability: "memory"
  }
});

test("prepares a memory packet and wake prompt for message events", async () => {
  const root = await tempDir();
  const runtime = createMemoryRuntime({
    agentId: "agent-a",
    runtimeHomePath: root,
    tokenBudget: 600
  });

  const turn = await runtime.prepareTurn({
    eventId: "evt-1",
    kind: "message",
    from: "mapper",
    text: "What is the plan for this morning?",
    context: {
      networkId: "noopolis",
      roomId: "agora",
      teamId: "team-a",
      artifactPaths: ["repos/product"]
    }
  });

  assert.equal(turn.principal.scope, "room");
  assert.equal(turn.principal.qualifier, "noopolis:agora");
  assert.ok(turn.promptText.includes("Wake event"));
  assert.ok(turn.packet.sections.length >= 0);
  assert.equal(turn.recall.totalCandidates, 0);
});

test("records turn output and recall artifacts to the jsonl store", async () => {
  const root = await tempDir();
  const runtime = createMemoryRuntime({
    agentId: "agent-a",
    runtimeHomePath: root
  });
  const principal = {
    agentId: "agent-a",
    scope: "room" as const,
    qualifier: "noopolis:agora"
  };

  await runtime.recordTurn({
    principal,
    prompt: {
      principal,
      sections: [{ heading: "Warmup", text: "Context loaded." }],
      rawHint: "none"
    },
    request: {
      eventId: "evt-record",
      kind: "manual",
      text: "Summarize progress.",
      context: {
        networkId: "noopolis",
        roomId: "agora"
      }
    },
    result: "completed",
    outputText: "Done. Progress summarized.",
    toolEvents: []
  });

  const store = new JsonlMemoryStore(root);
  const events = await store.read({ principalAgentId: "agent-a" });

  assert.ok(events.length >= 2);
  assert.ok(events.some((event) => event.type === "memory.claimed"));
  assert.ok(events.some((event) => event.type === "memory.observed"));
  assert.ok(events.some((event) => event.type === "memory.located") === false);
});

test("marks failed turns and still records denied decision", async () => {
  const root = await tempDir();
  const runtime = createMemoryRuntime({
    agentId: "agent-a",
    runtimeHomePath: root
  });
  const principal = {
    agentId: "agent-a",
    scope: "global" as const
  };

  await runtime.recordTurn({
    principal,
    prompt: {
      principal,
      sections: [],
      rawHint: "failed"
    },
    request: {
      eventId: "evt-fail",
      kind: "schedule",
      text: "run",
      from: "operator",
      context: { networkId: "noopolis", roomId: "agora" }
    },
    result: "failed",
    outputText: "",
    error: "simulated runtime error",
    toolEvents: []
  });

  const store = new JsonlMemoryStore(root);
  const events = await store.read({ principalAgentId: "agent-a", types: ["memory.denied"] });
  assert.equal(events.length, 1);
  assert.equal(events[0].content.kind, "text");
  assert.ok(events[0].content.text.includes("simulated runtime error"));
});

test("prepareTurn uses semantic retrieval when lexical overlap is absent", async () => {
  const root = await tempDir();
  const runtime = createMemoryRuntime({
    agentId: "agent-a",
    runtimeHomePath: root,
    embeddingProvider: createFakeEmbeddingProvider()
  });

  await runtime.recordTurn({
    principal: {
      agentId: "agent-a",
      scope: "room",
      qualifier: "noopolis:agora"
    },
    prompt: {
      principal: {
        agentId: "agent-a",
        scope: "room",
        qualifier: "noopolis:agora"
      },
      sections: [],
      rawHint: "seed"
    },
    request: {
      eventId: "evt-semantics",
      kind: "manual",
      text: "alpha-drive-marker",
      context: { networkId: "noopolis", roomId: "agora" }
    },
    result: "completed",
    outputText: "alpha-drive-marker output",
    toolEvents: []
  });

  await runtime.recordTurn({
    principal: {
      agentId: "agent-a",
      scope: "room",
      qualifier: "noopolis:ops"
    },
    prompt: {
      principal: {
        agentId: "agent-a",
        scope: "room",
        qualifier: "noopolis:ops"
      },
      sections: [],
      rawHint: "seed"
    },
    request: {
      eventId: "evt-noise",
      kind: "manual",
      text: "ops-marker",
      context: { networkId: "noopolis", roomId: "ops" }
    },
    result: "completed",
    outputText: "ops-marker output",
    toolEvents: []
  });

  const turn = await runtime.prepareTurn({
    eventId: "evt-search",
    kind: "message",
    from: "mapper",
    text: "vehicle-query",
    context: {
      networkId: "noopolis",
      roomId: "agora"
    }
  });

  assert.equal(turn.recall.totalCandidates > 0, true);
  assert.equal(turn.packet.sections.some((section) => section.text.includes("alpha-drive-marker")), true);
  assert.equal(turn.packet.sections.some((section) => section.text.includes("ops-marker")), false);
});

test("kernel search uses embeddings with scope filtering", async () => {
  const root = await tempDir();
  const runtime = createMemoryRuntime({
    agentId: "agent-a",
    runtimeHomePath: root,
    embeddingProvider: createFakeEmbeddingProvider()
  });

  await runtime.recordTurn({
    principal: {
      agentId: "agent-a",
      scope: "room",
      qualifier: "noopolis:agora"
    },
    prompt: {
      principal: {
        agentId: "agent-a",
        scope: "room",
        qualifier: "noopolis:agora"
      },
      sections: [],
      rawHint: "seed"
    },
    request: {
      eventId: "evt-kernel-match",
      kind: "manual",
      text: "alpha-drive-marker",
      context: { networkId: "noopolis", roomId: "agora" }
    },
    result: "completed",
    outputText: "alpha-drive-marker output",
    toolEvents: []
  });

  await runtime.recordTurn({
    principal: {
      agentId: "agent-a",
      scope: "room",
      qualifier: "noopolis:ops"
    },
    prompt: {
      principal: {
        agentId: "agent-a",
        scope: "room",
        qualifier: "noopolis:ops"
      },
      sections: [],
      rawHint: "seed"
    },
    request: {
      eventId: "evt-kernel-noise",
      kind: "manual",
      text: "beta-noise-marker",
      context: { networkId: "noopolis", roomId: "ops" }
    },
    result: "completed",
    outputText: "beta-noise-marker output",
    toolEvents: []
  });

  const requester: MemoryPrincipalRef = {
    agentId: "agent-a",
    scope: "room",
    qualifier: "noopolis:agora"
  };

  const scope = memoryScopeId(requester);
  const result = await runtime.kernel.search(memoryToolCall(requester, {
    scope,
    query: "vehicle-query",
    limit: 5
  }));

  assert.equal(result.tool, "memory.search");
  assert.equal(result.content.length > 0, true);
  assert.equal(result.content.some((entry) => entry.text?.includes("alpha-drive-marker")), true);
  assert.equal(result.content.some((entry) => entry.text?.includes("beta-noise-marker")), false);
});

test("kernel search returns matching events by requested scope", async () => {
  const root = await tempDir();
  const runtime = createMemoryRuntime({
    agentId: "agent-a",
    runtimeHomePath: root
  });
  const storedPrincipal = {
    agentId: "agent-a",
    scope: "room" as const,
    qualifier: "noopolis:agora"
  };

  await runtime.recordTurn({
    principal: storedPrincipal,
    prompt: {
      principal: storedPrincipal,
      sections: [{ heading: "Note", text: "Task: map roadmap updates." }],
      rawHint: "seed"
    },
    request: {
      eventId: "evt-source",
      kind: "manual",
      text: "I updated the roadmap.",
      context: {
        networkId: "noopolis",
        roomId: "agora"
      }
    },
    result: "completed",
    outputText: "Done.",
    toolEvents: []
  });

  const requester = {
    agentId: "agent-a",
    scope: "pair" as const,
    qualifier: "mapper"
  };
  const result = await runtime.kernel.search(memoryToolCall(requester, {
    scope: "all",
    query: "roadmap",
    limit: 2
  }));

  assert.equal(result.tool, "memory.search");
  assert.ok(result.content.length >= 1);
  assert.ok(result.content.some((entry) => entry.text?.includes("roadmap")));
  assert.ok(result.audit.sources.some((source) =>
    source.agentId === "agent-a" &&
    source.scope === "room" &&
    source.qualifier === "noopolis:agora"
  ));
});
