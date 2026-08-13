import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { JsonlMemoryStore } from "./store.js";
import {
  AUDIT_EVENT_TYPES,
  CONTENT_EVENT_TYPES,
  isDirtyingEvent,
  projectLifecycle,
  selectDirtyScopes
} from "./lifecycle.js";
import type { MemoryEvent, MemoryEventInput, MemoryEventType } from "../contract/types.js";

const tempRoots: string[] = [];

const tempDir = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "noopolis-mneme-lifecycle-"));
  tempRoots.push(directory);
  return directory;
};

test.afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const principal = { agentId: "luna", scope: "global" as const };

const contentInput = (text: string, extra: Partial<MemoryEventInput> = {}): MemoryEventInput => ({
  type: "memory.observed",
  principal,
  scope: "scope-a",
  visibility: "global",
  source: "lifecycle-test",
  content: { kind: "text", text },
  tags: [],
  entities: [],
  sensitivity: "normal",
  parentEventIds: [],
  ...extra
});

// A1 -----------------------------------------------------------------------

test("A1: memory.promoted and memory.consolidated exist as first-class event types, not tags", () => {
  const types: MemoryEventType[] = ["memory.promoted", "memory.consolidated"];
  assert.ok(types.every((type) => !CONTENT_EVENT_TYPES.includes(type as (typeof CONTENT_EVENT_TYPES)[number])));
  assert.ok(types.every((type) => !AUDIT_EVENT_TYPES.includes(type as (typeof AUDIT_EVENT_TYPES)[number])));
});

// A2 -------------------------------------------------------------------------

test("A2: a 3-revision chain keeps a stable memory_id, supersedes prior heads, and a post-promote revision resets to active", async () => {
  const root = await tempDir();
  const store = new JsonlMemoryStore(root);

  const rev1 = await store.append(contentInput("revision one"));
  const rev2 = await store.append(contentInput("revision two", {
    memoryId: rev1.id,
    parentEventIds: [rev1.id]
  }));
  const rev3 = await store.append(contentInput("revision three", {
    memoryId: rev1.id,
    parentEventIds: [rev2.id]
  }));

  const events = await store.read();
  const projection = projectLifecycle(events);

  const head = projection.heads.get(rev1.id);
  assert.ok(head);
  assert.equal(head?.memoryId, rev1.id);
  assert.equal(head?.revisionId, rev3.id);
  assert.equal(head?.state, "active");

  assert.equal(projection.revisionStates.get(rev1.id), "superseded");
  assert.equal(projection.revisionStates.get(rev2.id), "superseded");
  assert.equal(projection.revisionStates.get(rev3.id), "active");

  // Promote the current head, then add a new revision — promotion must not carry across revisions.
  await store.append({
    type: "memory.promoted",
    principal,
    scope: "scope-a",
    visibility: "private",
    source: "lifecycle-test",
    content: { kind: "text", text: "promote" },
    tags: [],
    entities: [],
    sensitivity: "normal",
    parentEventIds: [rev3.id],
    memoryId: rev1.id,
    origin: "dream"
  });

  const afterPromote = projectLifecycle(await store.read());
  assert.equal(afterPromote.heads.get(rev1.id)?.state, "promoted");

  const rev4 = await store.append(contentInput("revision four", {
    memoryId: rev1.id,
    parentEventIds: [rev3.id]
  }));

  const afterRev4 = projectLifecycle(await store.read());
  const finalHead = afterRev4.heads.get(rev1.id);
  assert.equal(finalHead?.revisionId, rev4.id);
  assert.equal(finalHead?.state, "active");
  assert.equal(afterRev4.revisionStates.get(rev3.id), "superseded");
});

// A3 -------------------------------------------------------------------------

test("A3: a fork resolves deterministically — the later-seq sibling wins the head on re-read", async () => {
  const root = await tempDir();
  const store = new JsonlMemoryStore(root);

  const rev1 = await store.append(contentInput("root"));
  const forkA = await store.append(contentInput("fork a", { memoryId: rev1.id, parentEventIds: [rev1.id] }));
  const forkB = await store.append(contentInput("fork b", { memoryId: rev1.id, parentEventIds: [rev1.id] }));

  const projection = projectLifecycle(await store.read());
  const head = projection.heads.get(rev1.id);

  assert.equal(head?.revisionId, forkB.id);
  assert.equal(projection.revisionStates.get(forkA.id), "superseded");
  assert.equal(projection.revisionStates.get(forkB.id), "active");

  // Deterministic across re-reads / shuffled input order.
  const shuffled = [...(await store.read())].reverse();
  const reprojected = projectLifecycle(shuffled);
  assert.equal(reprojected.heads.get(rev1.id)?.revisionId, forkB.id);
});

// A4 -------------------------------------------------------------------------

test("A4: forgetting a chain is terminal — later revisions and promotes are rejected and ignored", async () => {
  const root = await tempDir();
  const store = new JsonlMemoryStore(root);

  const rev1 = await store.append(contentInput("root"));
  await store.append({
    type: "memory.forgotten",
    principal,
    scope: "scope-a",
    visibility: "private",
    source: "lifecycle-test",
    content: { kind: "text", text: "forget" },
    tags: [],
    entities: [],
    sensitivity: "normal",
    parentEventIds: [rev1.id],
    origin: "awake"
  });

  const strayRevision = await store.append(contentInput("stray revision", {
    memoryId: rev1.id,
    parentEventIds: [rev1.id]
  }));
  await store.append({
    type: "memory.promoted",
    principal,
    scope: "scope-a",
    visibility: "private",
    source: "lifecycle-test",
    content: { kind: "text", text: "stray promote" },
    tags: [],
    entities: [],
    sensitivity: "normal",
    parentEventIds: [rev1.id],
    memoryId: rev1.id,
    origin: "dream"
  });

  const projection = projectLifecycle(await store.read());
  const head = projection.heads.get(rev1.id);

  assert.equal(head?.state, "forgotten");
  assert.equal(head?.revisionId, rev1.id, "the stray post-forget revision must not become head");
  assert.equal(projection.revisionStates.get(rev1.id), "forgotten");
  assert.equal(projection.revisionStates.get(strayRevision.id), undefined, "stray revision was skipped, never joined the chain");
  assert.ok(projection.diagnostics.some((entry) => entry.startsWith("revision-against-forgotten-chain:")));
});

// A5 -------------------------------------------------------------------------

test("A5: non-head promote is rejected, cross-chain parents are skipped with a diagnostic, unrelated parent ids never throw", async () => {
  const root = await tempDir();
  const store = new JsonlMemoryStore(root);

  const chainA = await store.append(contentInput("chain a root"));
  const chainARev2 = await store.append(contentInput("chain a rev2", {
    memoryId: chainA.id,
    parentEventIds: [chainA.id]
  }));
  const chainB = await store.append(contentInput("chain b root"));

  // Non-head promote: targets the stale rev1 instead of the current head (rev2).
  await store.append({
    type: "memory.promoted",
    principal,
    scope: "scope-a",
    visibility: "private",
    source: "lifecycle-test",
    content: { kind: "text", text: "stale promote" },
    tags: [],
    entities: [],
    sensitivity: "normal",
    parentEventIds: [chainA.id],
    memoryId: chainA.id,
    origin: "dream"
  });

  // Cross-chain: claims to be a revision of chain A but its parent belongs to chain B.
  await store.append(contentInput("cross chain revision", {
    memoryId: chainA.id,
    parentEventIds: [chainB.id]
  }));

  // Root event whose parentEventIds carries unrelated evidence ids (never lifecycle parents for a root).
  const rootWithUnrelatedParents = await store.append(contentInput("root with noise parents", {
    parentEventIds: ["evt_unrelated_evidence_1", "evt_unrelated_evidence_2"]
  }));

  const projection = projectLifecycle(await store.read());

  assert.equal(projection.heads.get(chainA.id)?.revisionId, chainARev2.id, "non-head promote must not change chain state");
  assert.equal(projection.heads.get(chainA.id)?.state, "active");
  assert.ok(projection.diagnostics.some((entry) => entry.startsWith("non-head-promote-rejected:")));
  assert.ok(projection.diagnostics.some((entry) => entry.startsWith("cross-chain-or-unknown-parent:")));

  // Root creation ignores unrelated parentEventIds without throwing.
  assert.equal(projection.heads.get(rootWithUnrelatedParents.id)?.state, "active");
});

// B1/B2 ------------------------------------------------------------------------

test("B1: audit events (recalled/located/denied) are never dirtying, regardless of origin", () => {
  const auditEvent = (type: MemoryEventType, origin: MemoryEventInput["origin"]): MemoryEvent => ({
    id: `evt_${type}_${origin}`,
    type,
    createdAt: new Date().toISOString(),
    principal,
    scope: "scope-a",
    visibility: "private",
    source: "test",
    content: { kind: "text", text: "audit" },
    tags: [],
    entities: [],
    sensitivity: "normal",
    parentEventIds: [],
    checksum: "audit-checksum",
    seq: 1,
    origin
  });

  for (const type of AUDIT_EVENT_TYPES) {
    assert.equal(isDirtyingEvent(auditEvent(type, "awake")), false);
    assert.equal(isDirtyingEvent(auditEvent(type, "dream")), false);
    assert.equal(isDirtyingEvent(auditEvent(type, undefined)), false);
  }
});

test("B2: dream-origin content/forget writes never dirty; awake-origin (and legacy no-origin) writes do", () => {
  const event = (type: MemoryEventType, origin: MemoryEventInput["origin"]): MemoryEvent => ({
    id: `evt_${type}_${origin}`,
    type,
    createdAt: new Date().toISOString(),
    principal,
    scope: "scope-a",
    visibility: "private",
    source: "test",
    content: { kind: "text", text: "content" },
    tags: [],
    entities: [],
    sensitivity: "normal",
    parentEventIds: [],
    checksum: "content-checksum",
    seq: 1,
    origin
  });

  for (const type of [...CONTENT_EVENT_TYPES, "memory.forgotten" as const]) {
    assert.equal(isDirtyingEvent(event(type, "dream")), false, `${type} dream-origin must never dirty`);
    assert.equal(isDirtyingEvent(event(type, "awake")), true, `${type} awake-origin must dirty`);
    assert.equal(isDirtyingEvent(event(type, undefined)), true, `${type} legacy (no origin) must dirty`);
  }

  assert.equal(isDirtyingEvent(event("memory.promoted", "awake")), false, "promotion transitions never dirty");
});

test("selectDirtyScopes reports scopes with awake content past the high-water mark, and clears once consolidated", async () => {
  const root = await tempDir();
  const store = new JsonlMemoryStore(root);

  await store.append(contentInput("first"));
  await store.append(contentInput("second"));

  const dirtyBefore = selectDirtyScopes(await store.read());
  const scopeEntry = dirtyBefore.find((entry) => entry.scope === "scope-a");
  assert.ok(scopeEntry);
  assert.equal(scopeEntry?.newContentCount, 2);
  assert.equal(scopeEntry?.lastConsolidatedSeq, 0);

  const eventsSoFar = await store.read({ scope: "scope-a" });
  const latestSeq = Math.max(...eventsSoFar.map((event) => event.seq));

  await store.append({
    type: "memory.consolidated",
    principal,
    scope: "scope-a",
    visibility: "private",
    source: "deep-time-test",
    content: { kind: "text", text: "consolidated" },
    tags: [],
    entities: [],
    sensitivity: "normal",
    parentEventIds: [],
    origin: "system",
    highWaterSeq: latestSeq
  });

  const dirtyAfter = selectDirtyScopes(await store.read());
  assert.equal(dirtyAfter.some((entry) => entry.scope === "scope-a"), false, "scope must be clean after consolidation");
});

// E1 -------------------------------------------------------------------------

test("E1: a pre-B59 legacy fixture (no seq/memoryId/origin) projects cleanly as independent single-revision chains", async () => {
  const root = await tempDir();
  const store = new JsonlMemoryStore(root);
  const memoryDir = path.join(root, "memory");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(memoryDir, { recursive: true }));

  const legacyEvent = (id: string, text: string) => ({
    id,
    type: "memory.observed",
    createdAt: new Date().toISOString(),
    principal,
    scope: "scope-a",
    visibility: "global",
    source: "legacy",
    content: { kind: "text", text },
    tags: [],
    entities: [],
    sensitivity: "normal",
    parentEventIds: [],
    checksum: `checksum-${id}`
  });

  const { appendFile } = await import("node:fs/promises");
  await appendFile(
    path.join(memoryDir, "events.jsonl"),
    `${JSON.stringify(legacyEvent("evt_legacy_a", "legacy a"))}\n${JSON.stringify(legacyEvent("evt_legacy_b", "legacy b"))}\n`,
    { encoding: "utf8" }
  );

  const events = await store.read();
  const projection = projectLifecycle(events);

  assert.equal(projection.heads.get("evt_legacy_a")?.state, "active");
  assert.equal(projection.heads.get("evt_legacy_b")?.state, "active");
  assert.equal(projection.diagnostics.length, 0);

  const appended = await store.append(contentInput("native append after legacy"));
  assert.ok(appended.seq > 2);
});
