import assert from "node:assert/strict";
import test from "node:test";

import { isTurnAuditEvent, TURN_AUDIT_TAG } from "./turnAudit.js";
import type { MemoryEvent, MemoryEventType } from "../contract/types.js";

const event = (type: MemoryEventType, text: string, overrides: Partial<MemoryEvent> = {}): MemoryEvent => ({
  id: "evt_1",
  type,
  createdAt: new Date().toISOString(),
  principal: { agentId: "luna", scope: "global" },
  scope: "scope-a",
  visibility: "global",
  source: "daimon/luna",
  content: { kind: "text", text },
  tags: [],
  entities: [],
  sensitivity: "normal",
  parentEventIds: [],
  checksum: "checksum-1",
  seq: 1,
  ...overrides
});

test("isTurnAuditEvent recognises the turn-audit tag", () => {
  assert.equal(isTurnAuditEvent(event("memory.observed", "anything", { tags: [TURN_AUDIT_TAG] })), true);
});

test("isTurnAuditEvent recognises untagged legacy turn records by their exact shape", () => {
  assert.equal(isTurnAuditEvent(event("memory.claimed", "Wake request moltnet:msg-1 from editor: Carry out this delivery. <delivery id=d1>")), true);
  assert.equal(isTurnAuditEvent(event("memory.observed", "Agent output: ", { tags: ["output", "completed"] })), true);
  assert.equal(isTurnAuditEvent(event("memory.observed", "room:noopolis:agora: memory.observed: old verdict", { tags: ["section"] })), true);
  assert.equal(isTurnAuditEvent(event("memory.summarized", "Observed 2 tool event(s) during turn.", { tags: ["tool", "summary"], source: "mneme/tool" })), true);
});

test("isTurnAuditEvent never matches kernel-written memories or ordinary notes", () => {
  assert.equal(isTurnAuditEvent(event("memory.claimed", "Wake request x from y: z", { origin: "awake" })), false);
  assert.equal(isTurnAuditEvent(event("memory.observed", "Agent output: decided to ship", { tags: ["output"], origin: "awake" })), false);
  assert.equal(isTurnAuditEvent(event("memory.observed", "Agent output: untagged note")), false);
  assert.equal(isTurnAuditEvent(event("memory.observed", "Decided to ship the roadmap on Friday.")), false);
  assert.equal(isTurnAuditEvent(event("memory.summarized", "Observed 2 tool event(s) during turn.")), false);
});
