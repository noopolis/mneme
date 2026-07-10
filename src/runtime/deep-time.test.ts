import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createMemoryRuntime } from "./runtime.js";
import { createDeepTimeSession } from "./deep-time.js";
import { JsonlMemoryStore } from "../store/store.js";
import { memoryScopeId } from "../identity/ids.js";
import type { MemoryPrincipalRef, MemoryVisibility, MemoryEventInput, MemoryToolCall } from "../contract/types.js";

const tempRoots: string[] = [];

const tempDir = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "noopolis-daimon-deep-time-"));
  tempRoots.push(directory);
  return directory;
};

test.afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const principal = (
  agentId: string,
  scope: MemoryPrincipalRef["scope"],
  qualifier?: string
): MemoryPrincipalRef => ({
  agentId,
  scope,
  qualifier
});

const seedText = async (
  store: JsonlMemoryStore,
  input: {
    principal: MemoryPrincipalRef;
    visibility: MemoryVisibility;
    text: string;
    source?: string;
    tags?: string[];
    entities?: string[];
    sensitivity?: MemoryEventInput["sensitivity"];
  }
): Promise<string> => {
  const event: MemoryEventInput = {
    type: "memory.observed",
    principal: input.principal,
    scope: memoryScopeId(input.principal),
    visibility: input.visibility,
    source: input.source ?? "test/seed",
    content: {
      kind: "text",
      text: input.text
    },
    tags: input.tags ?? [input.visibility, input.principal.scope],
    entities: input.entities ?? [input.principal.agentId, input.principal.scope],
    sensitivity: input.sensitivity ?? "normal",
    parentEventIds: []
  };

  return (await store.append(event)).id;
};

const harness = async (agentId: string) => {
  const runtimeHomePath = await tempDir();
  return {
    runtimeHomePath,
    store: new JsonlMemoryStore(runtimeHomePath),
    runtime: createMemoryRuntime({
      agentId,
      runtimeHomePath
    })
  };
};

const toolCall = (
  tool: MemoryToolCall["tool"],
  requester: MemoryPrincipalRef,
  args: Record<string, unknown>
): MemoryToolCall => ({
  request_id: `${tool}-deep-time`,
  tool,
  arguments: args,
	  envelope: {
	    version: "mneme.memory.tool.v1",
	    mode: "awake",
	    wake_id: "deep-time-wake",
    thread_id: "deep-time-thread",
    principal: requester,
    conversation_scope: requester.qualifier ?? requester.scope,
    audience_key: "deep-time",
    policy_version: "test",
	    allowed_scope_aliases: ["all", "current", "global", "current_room", "current_pair", "current_task"],
    transport: "in_process",
    nonce: "deep-time",
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    capability: "memory"
  }
});

test("room A stays isolated from room B and private B memory in a shared identity", async () => {
  const { store, runtime } = await harness("luna");

  await seedText(store, {
    principal: principal("luna", "room", "org-a:room-a"),
    visibility: "room",
    text: "room A status: alpha"
  });
  await seedText(store, {
    principal: principal("luna", "room", "org-b:room-b"),
    visibility: "room",
    text: "room B status: beta"
  });
  await seedText(store, {
    principal: principal("luna", "pair", "lens-architect"),
    visibility: "private",
    text: "pair B secret: beta-private"
  });

  const turn = await runtime.prepareTurn({
    eventId: "evt-room-a",
    kind: "manual",
    text: "report the current status for room A",
    context: {
      networkId: "org-a",
      roomId: "room-a",
      teamId: "org-a:team-a"
    }
  });

  assert.equal(turn.principal.scope, "room");
  assert.equal(turn.principal.qualifier, "org-a:room-a");
  assert.equal(turn.recall.totalCandidates, 1);
  assert.ok(turn.packet.sections.some((section) => section.text.includes("room A status: alpha")));
  assert.ok(turn.packet.sections.every((section) => !section.text.includes("room B status: beta")));
  assert.ok(turn.packet.sections.every((section) => !section.text.includes("pair B secret: beta-private")));
  assert.ok(!turn.promptText.includes("room B status: beta"));
  assert.ok(!turn.promptText.includes("pair B secret: beta-private"));
});

test("a pair selflet can recall its own private memory raw", async () => {
  const { store, runtime } = await harness("luna");

  await seedText(store, {
    principal: principal("luna", "pair", "lens-steward"),
    visibility: "private",
    text: "pair selflet private note: delta route"
  });

  const turn = await runtime.prepareTurn({
    eventId: "evt-pair-a",
    kind: "manual",
    from: "lens-steward",
    text: "recall the private note",
    context: {
      pairPeers: ["lens-steward"]
    }
  });

  assert.deepStrictEqual(turn.principal, principal("luna", "pair", "lens-steward"));
  assert.equal(turn.recall.totalCandidates, 1);
  assert.equal(turn.recall.selected?.[0]?.decision, "allow_raw");
  assert.ok(turn.packet.sections.some((section) => section.text.includes("pair selflet private note: delta route")));
  assert.ok(turn.promptText.includes("pair selflet private note: delta route"));
});

test("cross-self locate returns an opaque handle without private content", async () => {
  const { store, runtime } = await harness("luna");

  await seedText(store, {
    principal: principal("luna", "pair", "lens-architect"),
    visibility: "private",
    text: "orbit delta is the hidden deployment secret"
  });

  const result = await runtime.kernel.locate(toolCall("memory.locate", principal("luna", "pair", "lens-steward"), {
    query: "orbit delta",
    limit: 3
  }));

  assert.equal(result.decision, "locate_only");
  assert.equal(result.content.length, 1);

  const [handle] = result.content;
  assert.equal(handle.principal?.qualifier, "lens-architect");
  assert.equal(handle.text, undefined);
  assert.equal(handle.event_ids.length, 0);
  assert.ok(!JSON.stringify(handle).includes("hidden deployment secret"));
});

test("room recall includes global identity memory without leaking another organization room", async () => {
  const { store, runtime } = await harness("athena");

  await seedText(store, {
    principal: principal("athena", "global"),
    visibility: "global",
    text: "GLOBAL_IDENTITY_MARKER Athena keeps continuity across all organizations."
  });
  await seedText(store, {
    principal: principal("athena", "room", "org-a:strategy"),
    visibility: "room",
    text: "ORG_A_ROOM_MARKER Strategy room decided to use the blue path."
  });
  await seedText(store, {
    principal: principal("athena", "room", "org-b:strategy"),
    visibility: "room",
    text: "ORG_B_PRIVATE_MARKER Strategy room decided to use the red path."
  });

  const turn = await runtime.prepareTurn({
    eventId: "wake-org-a",
    kind: "schedule",
    text: "Continue the strategy plan.",
    context: {
      networkId: "org-a",
      roomId: "strategy",
      teamId: "planning"
    }
  });

  assert.ok(turn.promptText.includes("GLOBAL_IDENTITY_MARKER"));
  assert.ok(turn.promptText.includes("ORG_A_ROOM_MARKER"));
  assert.equal(turn.promptText.includes("ORG_B_PRIVATE_MARKER"), false);
});

test("private selflet memory is hinted across scopes and raw only inside its pair context", async () => {
  const { store, runtime } = await harness("athena");

  await seedText(store, {
    principal: principal("athena", "pair", "athena-org-b"),
    visibility: "private",
    text: "SELFLET_RAW_MARKER org-b knows the migration password changed."
  });

  const roomLocateResult = await runtime.kernel.locate(toolCall("memory.locate", principal("athena", "room", "org-a:strategy"), {
    query: "migration password",
    limit: 2
  }));

  assert.equal(roomLocateResult.content.length, 1);
  assert.equal(roomLocateResult.decision, "locate_only");
  assert.equal(roomLocateResult.content[0].principal?.qualifier, "athena-org-b");
  assert.equal(roomLocateResult.content[0].text, undefined);
  assert.equal(JSON.stringify(roomLocateResult.content[0]).includes("SELFLET_RAW_MARKER"), false);

  const pairTurn = await runtime.prepareTurn({
    eventId: "wake-pair",
    kind: "message",
    from: "athena-org-b",
    text: "What does the org-b selflet know about migration password?",
    context: {
      from: "athena-org-b",
      pairPeers: ["athena-org-b"]
    }
  });

  assert.equal(pairTurn.principal.scope, "pair");
  assert.equal(pairTurn.principal.qualifier, "athena-org-b");
  assert.ok(pairTurn.promptText.includes("SELFLET_RAW_MARKER"));
});

test("sealed memories never leak and locate returns no handle", async () => {
  const { store, runtime } = await harness("athena");

  const sealedId = await seedText(store, {
    principal: principal("athena", "global"),
    visibility: "sealed",
    text: "SEALED_MARKER this should never appear in prompts or envelopes.",
    sensitivity: "secret"
  });

  const turn = await runtime.prepareTurn({
    eventId: "wake-sealed",
    kind: "schedule",
    text: "Do we know anything about SEALED_MARKER?",
    context: {
      networkId: "org-a",
      roomId: "strategy"
    }
  });

  assert.equal(turn.promptText.includes("SEALED_MARKER this should never appear"), false);
  assert.equal(turn.recall.selectedEventIds.includes(sealedId), false);
  const prepareAudits = await store.read({
    principalAgentId: "athena",
    types: ["memory.denied"]
  });
  const prepareAudit = prepareAudits.find((event) => event.parentEventIds.includes(sealedId));
  assert.ok(prepareAudit);
  assert.equal(JSON.stringify(prepareAudit.content).includes("SEALED_MARKER this should never appear"), false);

  const locateResult = await runtime.kernel.locate(toolCall("memory.locate", principal("athena", "global"), {
    query: "SEALED_MARKER",
    limit: 4
  }));

  assert.equal(locateResult.content.some((entry) => entry.event_ids.includes(sealedId)), false);
  assert.equal(JSON.stringify(locateResult.content).includes("SEALED_MARKER"), false);

  const audits = await store.read({
    principalAgentId: "athena",
    types: ["memory.denied"]
  });
  const sealedAudit = audits.find((event) => event.parentEventIds.includes(sealedId));
  assert.ok(sealedAudit);
  assert.equal(JSON.stringify(sealedAudit.content).includes("SEALED_MARKER this should never appear"), false);
});

test("schedule wakes do not implicitly load private pair memory", async () => {
  const { store, runtime } = await harness("athena");

  await seedText(store, {
    principal: principal("athena", "pair", "athena-org-b"),
    visibility: "private",
    text: "SCHEDULE_PAIR_SECRET should stay outside scheduled room context."
  });

  const turn = await runtime.prepareTurn({
    eventId: "wake-schedule",
    kind: "schedule",
    text: "Review the room without interrupting private pair channels.",
    context: {
      networkId: "org-a",
      roomId: "strategy",
      pairPeers: ["athena-org-b"]
    }
  });

  assert.equal(turn.principal.scope, "room");
  assert.equal(turn.promptText.includes("SCHEDULE_PAIR_SECRET"), false);
  assert.equal(turn.recall.totalCandidates, 0);
});

test("locate records provenance audit without disclosing content", async () => {
  const { store, runtime } = await harness("athena");

  const roomEventId = await seedText(store, {
    principal: principal("athena", "room", "org-a:strategy"),
    visibility: "room",
    text: "ROOM_SUMMARY_MARKER the blue path needs a dry run."
  });

  const result = await runtime.kernel.locate(toolCall("memory.locate", principal("athena", "room", "org-a:strategy"), {
    query: "blue path dry run",
    limit: 2
  }));

  assert.ok(result.content.some((entry) => entry.event_ids.includes(roomEventId)));

  const located = await store.read({
    principalAgentId: "athena",
    types: ["memory.located"]
  });
  const audit = located.find((event) => event.parentEventIds.includes(roomEventId));
  assert.ok(audit);
  assert.equal(audit.content.kind, "text");
  assert.ok(audit.content.text.includes("Located"));
  assert.equal(audit.content.text.includes("ROOM_SUMMARY_MARKER"), false);
});

// B3/B4 — createDeepTimeSession's transactional high-water-mark rule -------

test("B3: awake writes dirty a scope; committing a consolidation pass clears it; a mid-pass awake write stays dirty", async () => {
  const { store } = await harness("luna");
  const session = createDeepTimeSession(store);

  await seedText(store, {
    principal: principal("luna", "global"),
    visibility: "global",
    text: "first awake fact"
  });

  const dirtyBefore = await session.selectDirtyScopes();
  const scopeEntry = dirtyBefore.find((entry) => entry.scope === memoryScopeId(principal("luna", "global")));
  assert.ok(scopeEntry, "scope with an awake write must be dirty");
  assert.equal(scopeEntry?.newContentCount, 1);

  const scope = memoryScopeId(principal("luna", "global"));
  const consolidation = await session.beginConsolidation(scope);
  assert.ok(consolidation.highWaterSeq > 0);

  // Mid-pass: a new awake write lands with a seq past the snapshot.
  await seedText(store, {
    principal: principal("luna", "global"),
    visibility: "global",
    text: "second awake fact written during the pass"
  });

  await consolidation.commit(["evt_consolidation_output"]);

  const dirtyAfter = await session.selectDirtyScopes();
  const scopeAfter = dirtyAfter.find((entry) => entry.scope === scope);
  assert.ok(scopeAfter, "the mid-pass write must keep the scope dirty even after commit");
  assert.equal(scopeAfter?.newContentCount, 1);
  assert.equal(scopeAfter?.lastConsolidatedSeq, consolidation.highWaterSeq);
});

test("B3: a scope with no writes after the marker is clean", async () => {
  const { store } = await harness("luna");
  const session = createDeepTimeSession(store);
  const scope = memoryScopeId(principal("luna", "global"));

  await seedText(store, {
    principal: principal("luna", "global"),
    visibility: "global",
    text: "only awake fact"
  });

  const consolidation = await session.beginConsolidation(scope);
  await consolidation.commit([]);

  const dirtyAfter = await session.selectDirtyScopes();
  assert.equal(dirtyAfter.some((entry) => entry.scope === scope), false);
});

test("B4: crash-sim — if commit() never runs, the scope stays dirty and a rerun is safe (no duplicate marker)", async () => {
  const { store } = await harness("luna");
  const session = createDeepTimeSession(store);
  const scope = memoryScopeId(principal("luna", "global"));

  await seedText(store, {
    principal: principal("luna", "global"),
    visibility: "global",
    text: "fact before the simulated crash"
  });

  // Simulate a crash: beginConsolidation ran, but commit() never did.
  await session.beginConsolidation(scope);

  const dirtyAfterCrash = await session.selectDirtyScopes();
  assert.ok(dirtyAfterCrash.some((entry) => entry.scope === scope), "no marker was written, so the scope must still be dirty");

  // Rerun: begin again and this time commit — must be idempotent-safe.
  const rerun = await session.beginConsolidation(scope);
  await rerun.commit(["evt_rerun_output"]);

  const dirtyAfterRerun = await session.selectDirtyScopes();
  assert.equal(dirtyAfterRerun.some((entry) => entry.scope === scope), false);

  const markers = (await store.read({ scope, types: ["memory.consolidated"] }));
  assert.equal(markers.length, 1, "the crashed pass must not have left a stray marker");
});
