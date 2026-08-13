import assert from "node:assert/strict";
import test from "node:test";

import { recallableEvents } from "./support.js";
import type { MemoryEvent, MemoryEventType } from "../contract/types.js";

const principal = { agentId: "luna", scope: "global" as const };

let seqCounter = 0;
const makeEvent = (overrides: Partial<MemoryEvent> & { type: MemoryEventType }): MemoryEvent => {
  seqCounter += 1;
  return {
    id: overrides.id ?? `evt_${seqCounter}`,
    type: overrides.type,
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    principal,
    scope: "scope-a",
    visibility: "global",
    source: "support-test",
    content: { kind: "text", text: overrides.id ?? `event ${seqCounter}` },
    tags: [],
    entities: [],
    sensitivity: "normal",
    parentEventIds: overrides.parentEventIds ?? [],
    checksum: `checksum-${seqCounter}`,
    seq: overrides.seq ?? seqCounter,
    memoryId: overrides.memoryId,
    origin: overrides.origin,
    ttl: overrides.ttl,
    highWaterSeq: overrides.highWaterSeq
  };
};

test.beforeEach(() => {
  seqCounter = 0;
});

test("D1: recallableEvents returns only active/promoted chain heads, excluding superseded, forgotten, and ttl-expired heads", () => {
  const root1 = makeEvent({ id: "evt_root1", type: "memory.observed" });
  const root1Rev2 = makeEvent({ id: "evt_root1_rev2", type: "memory.observed", memoryId: "evt_root1", parentEventIds: ["evt_root1"] });

  const forgottenRoot = makeEvent({ id: "evt_forgotten_root", type: "memory.observed" });
  const forgetEvent = makeEvent({ id: "evt_forget", type: "memory.forgotten", parentEventIds: ["evt_forgotten_root"] });

  const expiredRoot = makeEvent({
    id: "evt_expired",
    type: "memory.observed",
    createdAt: new Date(Date.now() - 10_000).toISOString(),
    ttl: "1"
  });

  const freshRoot = makeEvent({ id: "evt_fresh", type: "memory.observed" });

  const auditRecalled = makeEvent({ id: "evt_recalled", type: "memory.recalled" });
  const auditLocated = makeEvent({ id: "evt_located", type: "memory.located" });
  const auditDenied = makeEvent({ id: "evt_denied", type: "memory.denied" });

  const events = [
    root1,
    root1Rev2,
    forgottenRoot,
    forgetEvent,
    expiredRoot,
    freshRoot,
    auditRecalled,
    auditLocated,
    auditDenied
  ];

  const recallable = recallableEvents(events);
  const ids = recallable.map((event) => event.id).sort();

  assert.deepEqual(ids, ["evt_fresh", "evt_root1_rev2"].sort());
  assert.ok(!ids.includes("evt_root1"), "superseded revision must not be recallable");
  assert.ok(!ids.includes("evt_forgotten_root"), "forgotten chain must not be recallable");
  assert.ok(!ids.includes("evt_expired"), "ttl-expired head must not be recallable");
  assert.ok(!ids.includes("evt_recalled"), "audit events are never chain heads");
  assert.ok(!ids.includes("evt_located"), "audit events are never chain heads");
  assert.ok(!ids.includes("evt_denied"), "audit events are never chain heads");
});

test("D1: a promoted head remains recallable", () => {
  const root = makeEvent({ id: "evt_root", type: "memory.observed" });
  const promote = makeEvent({ id: "evt_promote", type: "memory.promoted", memoryId: "evt_root", parentEventIds: ["evt_root"], origin: "dream" });

  const recallable = recallableEvents([root, promote]);
  assert.deepEqual(recallable.map((event) => event.id), ["evt_root"]);
});

test("recallableEvents preserves plain backward-compatible behavior for single-revision events (no chains involved)", () => {
  const a = makeEvent({ id: "evt_a", type: "memory.observed" });
  const b = makeEvent({ id: "evt_b", type: "memory.claimed" });

  const recallable = recallableEvents([a, b]);
  assert.deepEqual(recallable.map((event) => event.id).sort(), ["evt_a", "evt_b"]);
});
