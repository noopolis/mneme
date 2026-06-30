import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createMemoryIndex, type MemoryIndexQuery } from "./sqliteIndex.js";
import { makeChecksum, memoryScopeId } from "../identity/ids.js";
import { JsonlMemoryStore } from "./store.js";
import type { MemoryEvent, MemoryPrincipalRef, MemoryVisibility } from "../contract/types.js";

const tempRoots: string[] = [];

const tempDir = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "noopolis-daimon-sqlite-index-"));
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

const eventSeed = (input: {
  id: string;
  principal: MemoryPrincipalRef;
  type: MemoryEvent["type"];
  visibility: MemoryVisibility;
  text: string;
  tags?: string[];
  entities?: string[];
  createdAt?: string;
}): MemoryEvent => {
  const principalScope = principal(input.principal.agentId, input.principal.scope, input.principal.qualifier);
  const createdAt = input.createdAt ?? new Date().toISOString();
  const event = {
    id: input.id,
    type: input.type,
    createdAt,
    principal: principalScope,
    scope: memoryScopeId(principalScope),
    visibility: input.visibility,
    source: "test/seed",
    content: {
      kind: "text" as const,
      text: input.text
    },
    tags: input.tags ?? [],
    entities: input.entities ?? [],
    sensitivity: "normal" as const,
    parentEventIds: [],
    checksum: ""
  };
  event.checksum = makeChecksum({ ...event, checksum: "", createdAt });
  return event;
};

test("rebuilds from in-memory events and returns filtered query results", async () => {
  const runtimeHomePath = await tempDir();
  const index = createMemoryIndex({ runtimeHomePath });

  const events = [
    eventSeed({
      id: "evt-1",
      principal: principal("luna", "global"),
      type: "memory.observed",
      visibility: "global",
      text: "Global recall anchor",
      tags: ["global"],
      entities: ["luna"]
    }),
    eventSeed({
      id: "evt-2",
      principal: principal("luna", "room", "noopolis:agora"),
      type: "memory.claimed",
      visibility: "room",
      text: "Room recall anchor",
      tags: ["room"],
      entities: ["mapper"]
    })
  ];

  await index.rebuildFromEvents(events);
  const query = await index.query({
    allowedScopes: [memoryScopeId(principal("luna", "room", "noopolis:agora"))]
  });

  assert.equal(query.length, 1);
  assert.equal(query[0].event.id, "evt-2");
  index.close();
});

test("rebuilds from events.jsonl as the source of truth", async () => {
  const runtimeHomePath = await tempDir();
  const store = new JsonlMemoryStore(runtimeHomePath);
  const roomScope = memoryScopeId(principal("luna", "room", "noopolis:agora"));

  await store.append({
    type: "memory.observed",
    principal: principal("luna", "room", "noopolis:agora"),
    scope: roomScope,
    visibility: "room",
    source: "test/seed",
    content: { kind: "text", text: "jsonl backed room memory" },
    tags: ["jsonl"],
    entities: ["luna"],
    sensitivity: "normal",
    parentEventIds: []
  });

  const index = createMemoryIndex({ runtimeHomePath });
  await index.rebuildFromStore();
  const query = await index.query({});
  assert.equal(query.length, 1);
  assert.equal(query[0].event.scope, roomScope);
  index.close();
});

test("performs lexical search with deterministic token matching", async () => {
  const runtimeHomePath = await tempDir();
  const index = createMemoryIndex({ runtimeHomePath });

  const events = [
    eventSeed({
      id: "evt-blue",
      principal: principal("luna", "global"),
      type: "memory.observed",
      visibility: "global",
      text: "Deployment turned blue across the network.",
      tags: ["deploy"],
      entities: ["orion"]
    }),
    eventSeed({
      id: "evt-red",
      principal: principal("luna", "global"),
      type: "memory.claimed",
      visibility: "global",
      text: "Deployment stayed red and stable.",
      tags: ["deploy"],
      entities: ["orion"]
    })
  ];

  await index.rebuildFromEvents(events);
  const hits = await index.query({
    query: "blue network",
    allowedScopes: [memoryScopeId(principal("luna", "global"))]
  });

  assert.equal(hits.length, 1);
  assert.equal(hits[0].event.id, "evt-blue");
  index.close();
});

test("filters by tags, entities, and event types", async () => {
  const runtimeHomePath = await tempDir();
  const index = createMemoryIndex({ runtimeHomePath });

  const events = [
    eventSeed({
      id: "evt-tag-one",
      principal: principal("luna", "team", "team-1"),
      type: "memory.observed",
      visibility: "team",
      text: "Team marker for policy updates.",
      tags: ["policy", "important"],
      entities: ["luna", "mapper"],
      createdAt: "2026-06-29T10:10:00.000Z"
    }),
    eventSeed({
      id: "evt-tag-two",
      principal: principal("lena", "team", "team-1"),
      type: "memory.claimed",
      visibility: "team",
      text: "Unrelated team update.",
      tags: ["note"],
      entities: ["luna", "mentor"],
      createdAt: "2026-06-29T10:11:00.000Z"
    })
  ];

  await index.rebuildFromEvents(events);
  const query: MemoryIndexQuery = {
    allowedScopes: [memoryScopeId(principal("luna", "team", "team-1"))],
    tags: ["policy", "important"],
    entities: ["mapper"],
    types: ["memory.observed"]
  };

  const filtered = await index.query(query);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].event.id, "evt-tag-one");
  index.close();
});

test("keeps ranking deterministic for equal scores with recency tie-breaks", async () => {
  const runtimeHomePath = await tempDir();
  const index = createMemoryIndex({ runtimeHomePath });
  const timestamp = "2026-06-29T12:00:00.000Z";

  const events = [
    eventSeed({
      id: "evt-c",
      principal: principal("luna", "global"),
      type: "memory.observed",
      visibility: "global",
      text: "recall ranking tie test",
      createdAt: timestamp
    }),
    eventSeed({
      id: "evt-b",
      principal: principal("luna", "global"),
      type: "memory.observed",
      visibility: "global",
      text: "recall ranking tie test",
      createdAt: timestamp
    }),
    eventSeed({
      id: "evt-a",
      principal: principal("luna", "global"),
      type: "memory.observed",
      visibility: "global",
      text: "recall ranking tie test",
      createdAt: timestamp
    })
  ];

  await index.rebuildFromEvents(events);
  const ranked = await index.query({
    query: "recall tie",
    allowedScopes: [memoryScopeId(principal("luna", "global"))],
    principalAgentId: "luna"
  });

  assert.deepStrictEqual(ranked.map((entry) => entry.event.id), ["evt-a", "evt-b", "evt-c"]);
  index.close();
});

test("does not leak forbidden scopes even when query text matches", async () => {
  const runtimeHomePath = await tempDir();
  const index = createMemoryIndex({ runtimeHomePath });
  const allowed = memoryScopeId(principal("luna", "room", "noopolis:agora"));
  const blocked = memoryScopeId(principal("luna", "room", "noopolis:ops"));

  const events = [
    eventSeed({
      id: "evt-allowed",
      principal: principal("luna", "room", "noopolis:agora"),
      type: "memory.observed",
      visibility: "room",
      text: "AGORA: secret plan",
      tags: ["ops"]
    }),
    eventSeed({
      id: "evt-blocked",
      principal: principal("luna", "room", "noopolis:ops"),
      type: "memory.claimed",
      visibility: "room",
      text: "OPS: sensitive plan",
      tags: ["ops"]
    })
  ];

  await index.rebuildFromEvents(events);
  const result = await index.query({
    query: "plan",
    allowedScopes: [allowed],
    tags: ["ops"]
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].event.id, "evt-allowed");
  index.close();
});
