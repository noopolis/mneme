import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createMemoryRuntime } from "./runtime.js";
import { JsonlMemoryStore } from "../store/store.js";
import { CausalEventStore } from "../store/causalStore.js";
import { memoryScopeId } from "../identity/ids.js";
import { validateMemoryRecalledCausalEvent, validateMemoryWrittenCausalEvent } from "../contract/causal.js";
import type { MemoryEmbeddingProvider } from "../store/embedding.js";
import type { MemoryPrincipalRef, MemoryRuntime, MemoryToolCall } from "../contract/types.js";

const tempRoots: string[] = [];

test.beforeEach(() => {
  process.env.NOOPOLIS_RUN_ID = "test-runtime-runtime";
});

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
  runtime: MemoryRuntime,
  principal: MemoryPrincipalRef,
  args: Record<string, unknown>,
  tool: MemoryToolCall["tool"] = "memory.search"
): MemoryToolCall => {
  const request_id = `runtime-test-memory-search:${Date.now()}:${Math.random()}`;
  const envelope = {
	    version: "mneme.memory.tool.v1",
	    mode: "awake",
	    wake_id: "daimon:runtime-test-wake",
    thread_id: "runtime-test-thread",
    principal,
    conversation_scope: principal.qualifier ?? principal.scope,
    audience_key: "runtime-test",
    policy_version: "test",
	    allowed_scope_aliases: ["all", "current", "global", "current_room", "current_pair", "current_task"],
    transport: "in_process",
    nonce: request_id,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    capability: "memory"
  } as const;
  if (!runtime.authority) throw new Error("test runtime has no authority");
  return { request_id, tool, arguments: args, envelope: { ...envelope, authority: runtime.authority.issue({ request_id, tool, arguments: args, envelope }) } };
};

test("prepares a memory packet and wake prompt for message events", async () => {
  const root = await tempDir();
  const runtime = createMemoryRuntime({
    agentId: "agent-a",
    runtimeHomePath: root,
    tokenBudget: 600
  });

  const turn = await runtime.prepareTurn({
    eventId: "daimon:evt-1",
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
  assert.equal(Object.isFrozen(turn.allowedScopes), true);
  assert.deepEqual(new Set(turn.allowedScopes), new Set([
    "agent:agent-a/scope:global",
    "agent:agent-a/scope:room/qualifier:noopolis:agora",
    "agent:agent-a/scope:team/qualifier:team-a",
    "agent:agent-a/scope:pair/qualifier:mapper"
  ]));
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
      eventId: "daimon:evt-record",
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

  const causalStore = new CausalEventStore(root);
  const causal = await causalStore.read();
  const written = causal.filter((event) => event.type === "memory.written");
  assert.equal(written.length, events.length);
  assert.deepEqual(new Set(written.map((event) => event.payload.revision_id)), new Set(events.map((event) => event.id)));
  assert.equal(written.every((event) => event.principal_id === "agent:agent-a"
    && event.cause_event_ids[0] === "daimon:evt-record"), true);
  await causalStore.finalizeStream(causal[0].run_id, "memory:agent-a");
  assert.match(new TextDecoder().decode(await causalStore.exportStream(causal[0].run_id, "memory:agent-a")), /"final_seq":3/);
});

test("recordTurn rejects a principal outside its configured bank before either ledger mutates", async () => {
  const root = await tempDir();
  const runtime = createMemoryRuntime({ agentId: "agent-a", runtimeHomePath: root });
  const principal = { agentId: "agent-b", scope: "global" as const };
  await assert.rejects(() => runtime.recordTurn({
    principal,
    prompt: { principal, sections: [], rawHint: "none" },
    request: { eventId: "daimon:wrong-bank-turn", kind: "manual", text: "wrong bank", context: {} },
    result: "completed",
    outputText: "must not persist",
    toolEvents: []
  }), /does not own this runtime bank/);
  assert.deepEqual(await new JsonlMemoryStore(root).read(), []);
  assert.deepEqual(await new CausalEventStore(root).read(), []);
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
      eventId: "daimon:evt-fail",
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
      eventId: "daimon:evt-semantics",
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
      eventId: "daimon:evt-noise",
      kind: "manual",
      text: "ops-marker",
      context: { networkId: "noopolis", roomId: "ops" }
    },
    result: "completed",
    outputText: "ops-marker output",
    toolEvents: []
  });

  const turn = await runtime.prepareTurn({
    eventId: "daimon:evt-search",
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
      eventId: "daimon:evt-kernel-match",
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
      eventId: "daimon:evt-kernel-noise",
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
  const result = await runtime.kernel.search(memoryToolCall(runtime, requester, {
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
      eventId: "daimon:evt-source",
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
  const result = await runtime.kernel.search(memoryToolCall(runtime, requester, {
    scope: "all",
    query: "roadmap",
    limit: 2
  }));

  assert.equal(result.tool, "memory.search");
  assert.equal(result.decision, "deny");
  assert.equal(result.content.length, 0);
});

test("prepareTurn emits a schema-valid memory.recalled causal event per selected memory", async () => {
  const root = await tempDir();
  const previousRunId = process.env.NOOPOLIS_RUN_ID;
  process.env.NOOPOLIS_RUN_ID = "test-run-b90";

  try {
    const runtime = createMemoryRuntime({
      agentId: "agent-a",
      runtimeHomePath: root,
      tokenBudget: 600
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
        sections: [{ heading: "Note", text: "Task: map roadmap updates." }],
        rawHint: "seed"
      },
      request: {
        eventId: "daimon:evt-causal-source",
        kind: "manual",
        text: "I updated the roadmap.",
        context: { networkId: "noopolis", roomId: "agora" }
      },
      result: "completed",
      outputText: "Done.",
      toolEvents: []
    });

    const sourceStore = new JsonlMemoryStore(root);
    const sourceEvents = await sourceStore.read({ principalAgentId: "agent-a" });

    const turn = await runtime.prepareTurn({
      eventId: "daimon:evt-wake-causal",
      kind: "message",
      from: "mapper",
      text: "roadmap",
      context: { networkId: "noopolis", roomId: "agora" }
    });

    assert.ok(turn.recall.selectedEventIds.length > 0);

    const causalStore = new CausalEventStore(root);
    const causalEvents = await causalStore.read();
    const recalledEvents = causalEvents.filter((event) => event.type === "memory.recalled");

    assert.equal(recalledEvents.length, turn.recall.selectedEventIds.length);

    // B0 memory->turn causal join fix: prepareTurn must surface the exact
    // mneme:<uuid> event_id of each memory.recalled event it appended, in
    // the same order as recall.selected, so daimon's stampTurnInputSubmitted
    // can chain cause_event_ids to ids that actually resolve in mneme's own
    // causal.jsonl rather than the raw evt_<...> recall ids.
    assert.equal(turn.recalledCausalEventIds.length, recalledEvents.length);
    assert.deepEqual(new Set(turn.recalledCausalEventIds), new Set(recalledEvents.map((event) => event.event_id)));
    for (const causalEventId of turn.recalledCausalEventIds) {
      assert.equal(causalEventId.startsWith("mneme:"), true);
    }

    for (const event of recalledEvents) {
      assert.equal(validateMemoryRecalledCausalEvent(event), true);
      assert.deepEqual(event.cause_event_ids, ["daimon:evt-wake-causal"]);
      assert.equal(event.run_id, "test-run-b90");
      assert.equal(event.principal_id, "agent:agent-a");
      assert.equal(event.emitter.system, "mneme");
      assert.equal(event.emitter.stream_id, "memory:agent-a");
      assert.ok(turn.recall.selectedEventIds.includes(event.payload.memory_id as string));
      assert.equal(event.payload.revision_id, event.payload.memory_id);

      const sourceEvent = sourceEvents.find((candidate) => candidate.id === event.payload.memory_id);
      assert.ok(sourceEvent);
      assert.equal(event.payload.content_sha256, sourceEvent?.checksum);
      assert.equal(event.payload.scope, sourceEvent?.scope);
    }
  } finally {
    if (previousRunId === undefined) {
      process.env.NOOPOLIS_RUN_ID = previousRunId ?? "test-runtime-runtime";
    } else {
      process.env.NOOPOLIS_RUN_ID = previousRunId;
    }
  }
});

test("prepareTurn stamps a contiguous seq per (run_id, stream_id) across repeated wakes", async () => {
  const root = await tempDir();
  const previousRunId = process.env.NOOPOLIS_RUN_ID;
  process.env.NOOPOLIS_RUN_ID = "test-run-b90-seq";

  try {
    const runtime = createMemoryRuntime({
      agentId: "agent-a",
      runtimeHomePath: root,
      tokenBudget: 600
    });
    const principal = {
      agentId: "agent-a",
      scope: "room" as const,
      qualifier: "noopolis:agora"
    };

    await runtime.recordTurn({
      principal,
      prompt: { principal, sections: [], rawHint: "seed" },
      request: {
        eventId: "daimon:evt-seq-source",
        kind: "manual",
        text: "roadmap milestone alpha",
        context: { networkId: "noopolis", roomId: "agora" }
      },
      result: "completed",
      outputText: "Done.",
      toolEvents: []
    });

    await runtime.prepareTurn({
      eventId: "daimon:evt-seq-wake-1",
      kind: "message",
      from: "mapper",
      text: "roadmap",
      context: { networkId: "noopolis", roomId: "agora" }
    });
    await runtime.prepareTurn({
      eventId: "daimon:evt-seq-wake-2",
      kind: "message",
      from: "mapper",
      text: "roadmap",
      context: { networkId: "noopolis", roomId: "agora" }
    });

    const causalStore = new CausalEventStore(root);
    const causalEvents = await causalStore.read();
    const seqs = causalEvents
      .filter((event) => event.emitter.stream_id === "memory:agent-a")
      .map((event) => event.emitter.seq)
      .sort((left, right) => left - right);

    assert.deepEqual(seqs, seqs.map((_value, index) => index + 1));
    assert.ok(seqs.length >= 2);
  } finally {
    if (previousRunId === undefined) {
      process.env.NOOPOLIS_RUN_ID = previousRunId ?? "test-runtime-runtime";
    } else {
      process.env.NOOPOLIS_RUN_ID = previousRunId;
    }
  }
});

// B70: recall-mode ablation knob (recallMode.ts) + the memory_id root fix.

const registerToolCall = (
  runtime: MemoryRuntime,
  principal: MemoryPrincipalRef,
  args: Record<string, unknown>,
  requestId: string
): MemoryToolCall => {
  const envelope = {
    version: "mneme.memory.tool.v1",
    mode: "awake",
    wake_id: "daimon:runtime-test-register",
    thread_id: "runtime-test-register-thread",
    principal,
    conversation_scope: principal.qualifier ?? principal.scope,
    audience_key: "runtime-test",
    policy_version: "test",
    allowed_scope_aliases: ["all", "current", "global"],
    transport: "in_process",
    nonce: requestId,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    capability: "memory"
  } as const;
  if (!runtime.authority) throw new Error("test runtime has no authority");
  return { request_id: requestId, tool: "memory.register", arguments: args, envelope: { ...envelope, authority: runtime.authority.issue({ request_id: requestId, tool: "memory.register", arguments: args, envelope }) } };
};

test("B70: memory.recalled stamps memory_id as the chain root, not the revision id", async () => {
  const root = await tempDir();
  const previousRunId = process.env.NOOPOLIS_RUN_ID;
  process.env.NOOPOLIS_RUN_ID = "test-run-b70-root-fix";

  try {
    const runtime = createMemoryRuntime({ agentId: "agent-a", runtimeHomePath: root, tokenBudget: 600 });
    const principal: MemoryPrincipalRef = { agentId: "agent-a", scope: "global" };

    const first = await runtime.kernel.register(registerToolCall(runtime, principal, {
      scope: "current",
      kind: "text",
      content: { kind: "text", text: "roadmap v1" },
      visibility: "global",
      sensitivity: "normal",
      source_type: "test"
    }, "reg-b70-1"));
    const rootId = first.content[0].event_ids[0];

    const second = await runtime.kernel.register(registerToolCall(runtime, principal, {
      scope: "current",
      kind: "text",
      content: { kind: "text", text: "roadmap v2 (revised)" },
      visibility: "global",
      sensitivity: "normal",
      source_type: "test",
      memory_id: rootId
    }, "reg-b70-2"));
    const headId = second.content[0].event_ids[0];
    assert.notEqual(headId, rootId);

    const turn = await runtime.prepareTurn({
      eventId: "daimon:evt-b70-wake",
      kind: "message",
      from: "mapper",
      text: "roadmap",
      context: { networkId: "noopolis", roomId: "agora" }
    });
    assert.ok(turn.recall.selectedEventIds.includes(headId));

    const causalEvents = await new CausalEventStore(root).read();
    const recalled = causalEvents.filter((event) =>
      event.type === "memory.recalled" && event.payload.revision_id === headId
    );
    assert.equal(recalled.length, 1);
    assert.equal(recalled[0].payload.memory_id, rootId);
    assert.equal(recalled[0].payload.revision_id, headId);
    assert.notEqual(recalled[0].payload.memory_id, recalled[0].payload.revision_id);
  } finally {
    if (previousRunId === undefined) {
      process.env.NOOPOLIS_RUN_ID = previousRunId ?? "test-runtime-runtime";
    } else {
      process.env.NOOPOLIS_RUN_ID = previousRunId;
    }
  }
});

test("B70: off mode never reads memory, stamps zero memory.recalled, and gates kernel search/locate", async () => {
  const root = await tempDir();
  const previousRunId = process.env.NOOPOLIS_RUN_ID;
  process.env.NOOPOLIS_RUN_ID = "test-run-b70-off";

  try {
    const runtime = createMemoryRuntime({
      agentId: "agent-a",
      runtimeHomePath: root,
      tokenBudget: 600,
      recallMode: "off"
    });
    const principal: MemoryPrincipalRef = { agentId: "agent-a", scope: "room", qualifier: "noopolis:agora" };

    await new JsonlMemoryStore(root).appendBatch([{
      type: "memory.registered",
      principal,
      scope: memoryScopeId(principal),
      visibility: "room",
      source: "test",
      content: { kind: "text", text: "canary payload agent should never see in off mode" },
      tags: [],
      entities: [],
      sensitivity: "normal",
      parentEventIds: []
    }]);

    const turn = await runtime.prepareTurn({
      eventId: "daimon:evt-b70-off-wake",
      kind: "message",
      from: "mapper",
      text: "canary",
      context: { networkId: "noopolis", roomId: "agora" }
    });

    assert.deepEqual(turn.recall.selectedEventIds, []);
    assert.equal(turn.recall.totalCandidates, 0);
    assert.ok(!turn.promptText.includes("canary payload"));
    assert.deepEqual(turn.recalledCausalEventIds, []);

    const causalEvents = await new CausalEventStore(root).read();
    assert.equal(causalEvents.filter((event) => event.type === "memory.recalled").length, 0);
    const modeStamps = causalEvents.filter((event) => event.type === "memory.recall.mode");
    assert.equal(modeStamps.length, 1);
    assert.equal(modeStamps[0].payload.mode, "off");
    assert.equal(modeStamps[0].payload.injected_count, 0);
    assert.equal(modeStamps[0].payload.degenerate, false);

    const searchResult = await runtime.kernel.search(memoryToolCall(runtime, principal, {
      scope: "all",
      query: "canary",
      limit: 5
    }));
    assert.equal(searchResult.content.length, 0);
    assert.match(searchResult.audit.argument_hash ?? "", /^[0-9a-f]{64}$/);

    const locateResult = await runtime.kernel.locate(memoryToolCall(runtime, principal, {
      query: "canary",
      limit: 5
    }));
    assert.equal(locateResult.content.length, 0);
  } finally {
    if (previousRunId === undefined) {
      process.env.NOOPOLIS_RUN_ID = previousRunId ?? "test-runtime-runtime";
    } else {
      process.env.NOOPOLIS_RUN_ID = previousRunId;
    }
  }
});

test("B70: shuffled mode injects the other-scope decoy, never the on-mode selection, and stamps what was actually injected", async () => {
  const root = await tempDir();
  const previousRunId = process.env.NOOPOLIS_RUN_ID;
  process.env.NOOPOLIS_RUN_ID = "test-run-b70-shuffled";

  try {
    const canaryPrincipal: MemoryPrincipalRef = { agentId: "agent-a", scope: "room", qualifier: "noopolis:agora" };
    const decoyPrincipal: MemoryPrincipalRef = { agentId: "agent-a", scope: "global" };

    const store = new JsonlMemoryStore(root);
    const [canaryEvent] = await store.appendBatch([{
      type: "memory.registered",
      principal: canaryPrincipal,
      scope: memoryScopeId(canaryPrincipal),
      visibility: "room",
      source: "test",
      content: { kind: "text", text: `canary-shuffled-plasma-${"x".repeat(560)}` },
      tags: [],
      entities: [],
      sensitivity: "normal",
      parentEventIds: []
    }]);
    const [decoyEvent] = await store.appendBatch([{
      type: "memory.registered",
      principal: decoyPrincipal,
      scope: memoryScopeId(decoyPrincipal),
      visibility: "global",
      source: "test",
      content: { kind: "text", text: "decoy-shuffled-noise" },
      tags: [],
      entities: [],
      sensitivity: "normal",
      parentEventIds: []
    }]);

    // A tight token budget matters here: the canary alone (~146 tokens)
    // must consume enough of it that the decoy (~6 tokens) cannot ALSO fit
    // into the "on"-mode selection S, so S={canary} and the decoy is left
    // in the complement P for shuffled mode to inject. Budget for the
    // actual P injection is tracked independently (see selectShuffledEntries)
    // so the decoy fits there even though it did not fit alongside canary.
    const runtime = createMemoryRuntime({
      agentId: "agent-a",
      runtimeHomePath: root,
      recallMode: "shuffled",
      tokenBudget: 150
    });

    const turn = await runtime.prepareTurn({
      eventId: "daimon:evt-b70-shuffled-wake",
      kind: "message",
      from: "mapper",
      text: "canary-shuffled-plasma",
      context: { networkId: "noopolis", roomId: "agora" }
    });

    assert.deepEqual(turn.recall.selectedEventIds, [decoyEvent.id]);
    // The wake's own query text ("canary-shuffled-plasma") is always echoed
    // into the prompt regardless of recall, so assert on content unique to
    // the canary's full registered text (the padding) instead — proving the
    // canary's memory content itself was excluded from the packet.
    assert.ok(!turn.promptText.includes("x".repeat(560)));
    assert.ok(turn.promptText.includes("decoy-shuffled-noise"));

    const causalEvents = await new CausalEventStore(root).read();
    const recalled = causalEvents.filter((event) => event.type === "memory.recalled");
    assert.equal(recalled.length, 1);
    assert.equal(recalled[0].payload.memory_id, decoyEvent.id);
    assert.notEqual(recalled[0].payload.memory_id, canaryEvent.id);
    assert.deepEqual(turn.recalledCausalEventIds, [recalled[0].event_id]);

    const modeStamps = causalEvents.filter((event) => event.type === "memory.recall.mode");
    assert.equal(modeStamps.length, 1);
    assert.equal(modeStamps[0].payload.mode, "shuffled");
    assert.equal(modeStamps[0].payload.injected_count, 1);
    assert.equal(modeStamps[0].payload.degenerate, false);
  } finally {
    if (previousRunId === undefined) {
      process.env.NOOPOLIS_RUN_ID = previousRunId ?? "test-runtime-runtime";
    } else {
      process.env.NOOPOLIS_RUN_ID = previousRunId;
    }
  }
});

test("B70: shuffled mode is degenerate and injects nothing when there is no complement to substitute", async () => {
  const root = await tempDir();
  const canaryPrincipal: MemoryPrincipalRef = { agentId: "agent-a", scope: "room", qualifier: "noopolis:agora" };

  await new JsonlMemoryStore(root).appendBatch([{
    type: "memory.registered",
    principal: canaryPrincipal,
    scope: memoryScopeId(canaryPrincipal),
    visibility: "room",
    source: "test",
    content: { kind: "text", text: "only-candidate-in-the-store" },
    tags: [],
    entities: [],
    sensitivity: "normal",
    parentEventIds: []
  }]);

  const runtime = createMemoryRuntime({
    agentId: "agent-a",
    runtimeHomePath: root,
    recallMode: "shuffled"
  });

  const turn = await runtime.prepareTurn({
    eventId: "daimon:evt-b70-shuffled-degenerate",
    kind: "message",
    from: "mapper",
    text: "only-candidate",
    context: { networkId: "noopolis", roomId: "agora" }
  });

  assert.deepEqual(turn.recall.selectedEventIds, []);

  const causalEvents = await new CausalEventStore(root).read();
  assert.equal(causalEvents.filter((event) => event.type === "memory.recalled").length, 0);
  const modeStamps = causalEvents.filter((event) => event.type === "memory.recall.mode");
  assert.equal(modeStamps.length, 1);
  assert.equal(modeStamps[0].payload.degenerate, true);
  assert.equal(modeStamps[0].payload.injected_count, 0);
});

for (const recallMode of ["on", "off", "shuffled"] as const) {
  test(`memory.written is stamped for a register write regardless of recall mode (${recallMode})`, async () => {
    const root = await tempDir();
    const runtime = createMemoryRuntime({
      agentId: "agent-a",
      runtimeHomePath: root,
      recallMode
    });
    const principal: MemoryPrincipalRef = { agentId: "agent-a", scope: "global" };

    const registerCall: MemoryToolCall = {
      ...memoryToolCall(runtime, principal, {
        scope: memoryScopeId(principal),
        kind: "text",
        content: { kind: "text", text: `write under recall mode ${recallMode}` },
        visibility: "global",
        sensitivity: "normal",
        source_type: "test"
      }, "memory.register")
    };

    const result = await runtime.kernel.register(registerCall);
    assert.equal(result.decision, "allow_raw");

    // guardKernelForRecallMode (see runtime/recallMode.ts) only wraps
    // memory.search/memory.locate; the four mutating tools, including
    // register, stay live and stamp memory.written in every mode — the
    // ablation is recall-only, never write-side.
    const causalEvents = await new CausalEventStore(root).read();
    const written = causalEvents.filter((event) => event.type === "memory.written");
    assert.equal(written.length, 1);
    assert.ok(validateMemoryWrittenCausalEvent(written[0]));
    assert.equal(written[0].cause_event_ids[0], "daimon:runtime-test-wake");
  });
}

test("B70: resolveRecallMode integration — invalid config throws at construction, default stays on", () => {
  assert.throws(() => createMemoryRuntime({
    agentId: "agent-a",
    runtimeHomePath: "/tmp/does-not-need-to-exist-for-this-assertion",
    // @ts-expect-error intentionally invalid to prove the ctor throws rather than silently defaulting
    recallMode: "typo"
  }), /invalid MNEME_RECALL_MODE value/);
});
