import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createMemoryRuntime } from "../runtime/runtime.js";
import { JsonlMemoryStore } from "../store/store.js";
import { runMemorySelection, recallableEvents } from "../runtime/support.js";
import { runRecall } from "../recall/recall.js";
import { memoryScopeId } from "../identity/ids.js";
import type {
  MemoryEvent,
  MemoryEventInput,
  MemoryEventType,
  MemoryPrincipalRef,
  MemoryToolCall,
  MemoryVisibility
} from "../contract/types.js";

const tempRoots: string[] = [];

const tempDir = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "noopolis-daimon-memory-tools-"));
  tempRoots.push(directory);
  return directory;
};

type EventSeedInput = {
  principal: MemoryPrincipalRef;
  visibility: MemoryVisibility;
  text: string;
  type?: MemoryEventType;
  tags?: string[];
  entities?: string[];
  parentEventIds?: string[];
};

const principal = (
  agentId: string,
  scope: MemoryPrincipalRef["scope"],
  qualifier?: string
): MemoryPrincipalRef => ({
  agentId,
  scope,
  qualifier
});

const seedMemoryEvent = (
  store: JsonlMemoryStore,
  input: EventSeedInput
): Promise<MemoryEvent> =>
  store.append({
    type: input.type ?? "memory.observed",
    principal: input.principal,
    scope: memoryScopeId(input.principal),
    visibility: input.visibility,
    source: "memory-tool-test",
    content: {
      kind: "text",
      text: input.text
    },
    tags: input.tags ?? [input.visibility],
    entities: input.entities ?? [input.principal.agentId],
    sensitivity: "normal",
    parentEventIds: input.parentEventIds ?? []
  } satisfies MemoryEventInput);

const memoryToolCall = (
  tool: MemoryToolCall["tool"],
  requester: MemoryPrincipalRef,
  args: Record<string, unknown>
): MemoryToolCall => ({
  request_id: `${tool}-contract-test`,
  tool,
  arguments: args,
  envelope: {
    version: "mneme.memory.tool.v1",
    wake_id: "contract-wake",
    thread_id: "contract-thread",
    principal: requester,
    conversation_scope: requester.qualifier ?? requester.scope,
    audience_key: "contract-test",
    policy_version: "test",
    allowed_scope_aliases: ["current", "global", "current_room", "current_pair", "current_task"],
    transport: "in_process",
    nonce: "contract-test",
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    capability: "memory"
  }
});

test.afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("search returns allowed scopes with private pair redaction", async () => {
  const runtimeHomePath = await tempDir();
  const runtime = createMemoryRuntime({
    agentId: "luna",
    runtimeHomePath
  });
  const store = new JsonlMemoryStore(runtimeHomePath);

  const publicPrincipal = principal("luna", "room", "org-a:agora");
  const privatePrincipal = principal("luna", "pair", "agent-shadow");
  const unrelatedPrincipal = principal("luna", "pair", "observer");

  const roomEvent = await seedMemoryEvent(store, {
    principal: publicPrincipal,
    visibility: "room",
    text: "PUBLIC_ROOM_MARKER summary from the agora room."
  });
  const privateEvent = await seedMemoryEvent(store, {
    principal: privatePrincipal,
    visibility: "private",
    text: "PRIVATE_PAIR_MARKER hidden relay route and credentials."
  });
  const blockedEvent = await seedMemoryEvent(store, {
    principal: unrelatedPrincipal,
    visibility: "private",
    text: "UNRELATED_SCOPE_MARKER should stay hidden."
  });

  const events = recallableEvents(await store.read());
  const recall = runRecall({
    actor: publicPrincipal,
    scopeIds: [memoryScopeId(publicPrincipal), memoryScopeId(privatePrincipal)],
    events,
    query: "relay route credentials",
    maxTokens: 500
  });

  const privateSelection = recall.selected.find((entry) => entry.event.id === privateEvent.id);
  const roomSelection = recall.selected.find((entry) => entry.event.id === roomEvent.id);

  assert.ok(roomSelection, "expected room memory to be recalled");
  assert.equal(roomSelection.decision, "allow_raw");
  assert.ok(roomSelection.representation.includes("PUBLIC_ROOM_MARKER"));
  assert.ok(!roomSelection.representation.includes("UNRELATED_SCOPE_MARKER"));

  assert.ok(privateSelection, "expected private pair memory to be represented as private");
  assert.equal(privateSelection?.decision, "known_but_private");
  assert.ok(privateSelection.representation.includes("Related private context"));
  assert.ok(!privateSelection.representation.includes("PRIVATE_PAIR_MARKER"));
  assert.ok(!recall.selected.some((entry) => entry.event.id === blockedEvent.id));
});

test("locate returns candidate handles without private content", async () => {
  const runtimeHomePath = await tempDir();
  const runtime = createMemoryRuntime({
    agentId: "luna",
    runtimeHomePath
  });
  const store = new JsonlMemoryStore(runtimeHomePath);

  const publicPrincipal = principal("luna", "room", "org-a:agora");
  const privatePrincipal = principal("luna", "pair", "agent-shadow");

  const publicEvent = await seedMemoryEvent(store, {
    principal: publicPrincipal,
    visibility: "room",
    text: "PUBLIC_LOCATE_MARKER council agenda was rotated."
  });
  const privateEvent = await seedMemoryEvent(store, {
    principal: privatePrincipal,
    visibility: "private",
    text: "PRIVATE_LOCATE_MARKER hidden credential was rotated."
  });

  const events = recallableEvents(await store.read());
  const selection = runMemorySelection({
    requester: publicPrincipal,
    scopeIds: [memoryScopeId(publicPrincipal), memoryScopeId(privatePrincipal)],
    events,
    query: "rotated",
    maxResults: 4
  });

  const privateChoice = selection.find((entry) => entry.event.id === privateEvent.id);
  const publicChoice = selection.find((entry) => entry.event.id === publicEvent.id);

  assert.equal(typeof selection[0]?.scope, "string");
  assert.ok(privateChoice);
  assert.equal(privateChoice.decision, "known_but_private");
  assert.ok(privateChoice.representation.includes("Related private context"));
  assert.ok(!privateChoice.representation.includes("PRIVATE_LOCATE_MARKER"));

  assert.ok(publicChoice);
  assert.equal(publicChoice?.decision, "allow_raw");
  assert.ok(publicChoice?.representation.includes("PUBLIC_LOCATE_MARKER"));

  const location = await runtime.kernel.locate(memoryToolCall("memory.locate", publicPrincipal, {
    query: "council agenda rotate",
    limit: 2
  }));

  const handleMatch = location.content.find((entry) => entry.event_ids.includes(publicEvent.id));
  assert.ok(handleMatch, "expected locate handle for public memory");
  assert.equal(handleMatch.scope, memoryScopeId(publicPrincipal));
  assert.ok(!handleMatch.text?.includes("UNRELATED"));
});

test("register + forget keeps recall boundary-safe by suppressing forgotten evidence", async () => {
  const runtimeHomePath = await tempDir();
  const runtime = createMemoryRuntime({
    agentId: "luna",
    runtimeHomePath
  });
  const store = new JsonlMemoryStore(runtimeHomePath);

  const actor = principal("luna", "room", "org-a:agora");
  const evidence = await seedMemoryEvent(store, {
    principal: actor,
    visibility: "room",
    text: "FORGET_TARGET_MARKER should disappear after forget."
  });

  await store.append({
    type: "memory.forgotten",
    principal: actor,
    scope: memoryScopeId(actor),
    visibility: "private",
    source: "memory-tool-test",
    content: {
      kind: "text",
      text: "Forget request for outdated plan evidence."
    },
    tags: ["forget", "regression"],
    entities: ["forget", actor.agentId],
    parentEventIds: [evidence.id]
  });

  const turn = await runtime.prepareTurn({
    eventId: "wake-forget",
    kind: "manual",
    text: "What old plan did we forget?",
    context: {
      networkId: "org-a",
      roomId: "agora"
    }
  });

  assert.equal(turn.recall.totalCandidates, 0);
  assert.equal(turn.packet.sections.length, 0);

  const discarded = await store.read({
    principalAgentId: "luna",
    types: ["memory.forgotten"]
  });
  assert.equal(discarded.length, 1);
  assert.equal(discarded[0].content.kind, "text");
  assert.ok(discarded[0].content.text.includes("Forget request"));
});

test("activity tool summaries do not leak tool payload text", async () => {
  const runtimeHomePath = await tempDir();
  const runtime = createMemoryRuntime({
    agentId: "luna",
    runtimeHomePath
  });
  const store = new JsonlMemoryStore(runtimeHomePath);
  const actor = principal("luna", "room", "org-a:agora");
  const prompt = {
    principal: actor,
    sections: [{ heading: "Setup", text: "Collect tool evidence." }],
    rawHint: "tool-check"
  };
  const request = {
    eventId: "wake-tool-boundary",
    kind: "message" as const,
    from: "orchestrator",
    text: "Can you inspect private pair and room context?",
    context: {
      networkId: "org-a",
      roomId: "agora",
      pairPeers: ["agent-shadow"]
    }
  };

  await runtime.recordTurn({
    principal: actor,
    prompt,
    request,
    result: "completed",
    outputText: "ok",
    toolEvents: [
      { type: "memory_tool", event: "search", payload: "PUBLIC_TOOL_PAYLOAD_MARKER" },
      { type: "memory_tool", event: "locate", payload: "PRIVATE_TOOL_MARKER hidden secrets" }
    ]
  });

  const events = await store.read({ principalAgentId: "luna", types: ["memory.summarized"] });
  assert.equal(events.length, 1);
  assert.equal(events[0].content.kind, "text");
  assert.ok(events[0].content.text.includes("Observed 2 tool event(s) during turn."));
  assert.ok(!events[0].content.text.includes("PUBLIC_TOOL_PAYLOAD_MARKER"));
  assert.ok(!events[0].content.text.includes("PRIVATE_TOOL_MARKER"));
});
