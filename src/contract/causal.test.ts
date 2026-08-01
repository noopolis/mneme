import assert from "node:assert/strict";
import test from "node:test";

import {
  CAUSAL_EVENT_VERSION,
  memoryStreamId,
  mnemeCausalEventId,
  parseCausalEvent,
  resolveCausalRunId,
  validateCausalEvent,
  validateMemoryRecalledCausalEvent
} from "./causal.js";
import type { MemoryRecalledCausalEvent } from "./causal.js";

const goldenMemoryRecalled = (): MemoryRecalledCausalEvent => ({
  version: CAUSAL_EVENT_VERSION,
  run_id: "run-1",
  event_id: mnemeCausalEventId("evt-1"),
  emitter: { system: "mneme", stream_id: memoryStreamId("agent-a"), seq: 1 },
  type: "memory.recalled",
  principal_id: "agent:agent-a",
  recorded_at: new Date().toISOString(),
  cause_event_ids: ["daimon:wake-1"],
  payload: {
    memory_id: "evt_selected",
    revision_id: "evt_selected",
    scope: "room",
    content_sha256: "deadbeef"
  }
});

test("a golden memory.recalled record validates against the schema", () => {
  const result = validateCausalEvent(goldenMemoryRecalled());
  assert.equal(result.success, true);
});

test("validateMemoryRecalledCausalEvent accepts a well-formed record", () => {
  assert.equal(validateMemoryRecalledCausalEvent(goldenMemoryRecalled()), true);
});

test("validateMemoryRecalledCausalEvent rejects a payload missing memory_id", () => {
  const event = goldenMemoryRecalled();
  const { memory_id: _omit, ...payloadWithoutMemoryId } = event.payload;
  const broken = { ...event, payload: payloadWithoutMemoryId };
  assert.equal(validateMemoryRecalledCausalEvent(broken), false);
});

test("validateMemoryRecalledCausalEvent rejects a payload missing content_sha256", () => {
  const event = goldenMemoryRecalled();
  const { content_sha256: _omit, ...payloadWithoutSha } = event.payload;
  const broken = { ...event, payload: payloadWithoutSha };
  assert.equal(validateMemoryRecalledCausalEvent(broken), false);
});

test("causalEventSchema rejects an event_id whose system prefix does not match emitter.system", () => {
  const event = goldenMemoryRecalled();
  const broken = { ...event, event_id: "daimon:evt-1" };
  const result = validateCausalEvent(broken);
  assert.equal(result.success, false);
});

test("causalEventSchema rejects a seq below 1", () => {
  const event = goldenMemoryRecalled();
  const broken = { ...event, emitter: { ...event.emitter, seq: 0 } };
  const result = validateCausalEvent(broken);
  assert.equal(result.success, false);
});

test("causalEventSchema rejects an unknown emitter.system", () => {
  const event = goldenMemoryRecalled();
  const broken = { ...event, emitter: { ...event.emitter, system: "unknown-system" } };
  const result = validateCausalEvent(broken);
  assert.equal(result.success, false);
});

test("causalEventSchema accepts a foreign cause namespace unchanged", () => {
  const event = { ...goldenMemoryRecalled(), cause_event_ids: ["driver:turn:7"] };
  const result = validateCausalEvent(event);
  assert.equal(result.success, true);
  assert.deepEqual(result.success && result.data.cause_event_ids, ["driver:turn:7"]);
});

test("causalEventSchema rejects a bare cause id", () => {
  const event = { ...goldenMemoryRecalled(), cause_event_ids: ["fixture-turn-1"] };
  assert.equal(validateCausalEvent(event).success, false);
});

test("causalEventSchema rejects additional properties (strict envelope)", () => {
  const event = goldenMemoryRecalled();
  const broken = { ...event, unexpected_field: "nope" };
  const result = validateCausalEvent(broken);
  assert.equal(result.success, false);
});

test("parseCausalEvent throws with a readable message for an invalid record", () => {
  assert.throws(() => parseCausalEvent({ not: "an event" }), /invalid causal event/);
});

test("resolveCausalRunId reads NOOPOLIS_RUN_ID from the given environment", () => {
  assert.equal(resolveCausalRunId({ NOOPOLIS_RUN_ID: " run-abc " } as NodeJS.ProcessEnv), "run-abc");
});

test("resolveCausalRunId falls back to a stable placeholder when unset", () => {
  assert.equal(resolveCausalRunId({} as NodeJS.ProcessEnv), "unset-run");
});

test("mnemeCausalEventId and memoryStreamId produce the documented formats", () => {
  assert.equal(mnemeCausalEventId("abc"), "mneme:abc");
  assert.equal(memoryStreamId("agent-a"), "memory:agent-a");
});
