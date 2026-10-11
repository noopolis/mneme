import assert from "node:assert/strict";
import test from "node:test";

import {
  CausalEventStore, createDeepTimeSession, createMemoryKernel, createMemoryRuntime,
  createMemoryToolEnvelope, createOffsetClock, JsonlMemoryStore, MemoryAuthorityGuard,
  resolveClock, validateCausalEvent, wallClock, type MemoryClock, type MemoryStore
} from "../index.js";

test("resolveClock preserves no-clock legacy dependencies and requires function identity for injection", () => {
  const clock = () => 0;
  assert.equal(resolveClock(), wallClock);
  assert.equal(resolveClock(undefined, [undefined, {}, { clock: undefined }]), wallClock);
  assert.equal(resolveClock(clock), clock);
  assert.equal(resolveClock(clock, [undefined, { clock }]), clock);
  assert.equal(resolveClock(undefined, [{ clock }, { clock }]), clock);
  for (const configured of [undefined, clock]) {
    for (const dependencies of [[{ clock }, {}], [{}, { clock }], [{ clock }, { clock: () => 0 }]]) {
      assert.throws(() => resolveClock(configured, dependencies), /dependency clock.*match/);
    }
  }
  assert.throws(() => resolveClock(clock, [{}]), /dependency clock.*match/);
  assert.throws(() => resolveClock(wallClock, [{}]), /dependency clock.*match/);
});

test("the public offset clock advances from an explicit anchor and normalizes offsets", () => {
  let realMs = 10_000;
  const clock: MemoryClock = createOffsetClock({
    origin: "2000-01-01T02:00:00+02:00", anchorMs: 9_000, realNow: () => realMs
  });
  assert.equal(clock(), Date.parse("2000-01-01T00:00:01Z"));
  realMs += 250;
  assert.equal(clock(), Date.parse("2000-01-01T00:00:01.250Z"));
});

test("an omitted offset anchor is captured once at construction", () => {
  let realMs = 123;
  const clock = createOffsetClock({ origin: "2000-01-01T00:00:00Z", realNow: () => realMs });
  assert.equal(clock(), Date.parse("2000-01-01T00:00:00Z"));
  realMs += 500;
  assert.equal(clock(), Date.parse("2000-01-01T00:00:00.500Z"));
});

test("zero and negative anchors are valid epoch milliseconds", () => {
  for (const anchorMs of [0, -1]) {
    const clock = createOffsetClock({ origin: "2000-02-29T00:00:00Z", anchorMs, realNow: () => 100 });
    assert.equal(clock(), Date.parse("2000-02-29T00:00:00Z") + 100 - anchorMs);
  }
});

test("offset clocks reject invalid or ambiguous origins", () => {
  for (const origin of ["", "tomorrow", "2000-01-01", "2000-01-01T00:00:00",
    "2000-13-01T00:00:00Z", "2001-02-29T00:00:00Z", "2000-01-01T00:00:00+25:00"]) {
    assert.throws(() => createOffsetClock({ origin }), /clock origin.*ISO-8601.*offset or Z/);
  }
});

test("offset clocks reject non-integer and unsafe anchors", () => {
  for (const anchorMs of [NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => createOffsetClock({ origin: "2000-01-01T00:00:00Z", anchorMs }), /clock anchor.*integer/);
  }
});

test("offset clock boundaries and their envelope expiries pass causal validation", () => {
  const realNow = () => 0;
  for (const initialMs of [Date.parse("0000-01-01T00:00:00Z"), Date.parse("9999-12-31T23:54:59.999Z")]) {
    const clock = createOffsetClock({ origin: "1970-01-01T00:00:00Z", anchorMs: -initialMs, realNow });
    assert.equal(clock(), initialMs);
    assert.equal(resolveClock(clock), clock);
    const envelope = createMemoryToolEnvelope({
      clock, wakeId: "daimon:boundary", threadId: "boundary",
      principal: { agentId: "luna", scope: "global" }, conversationScope: "global"
    });
    assert.equal(Date.parse(envelope.expires_at), initialMs + 300_000);
    for (const timestamp of [new Date(clock()).toISOString(), envelope.expires_at]) {
      const validated = validateCausalEvent({
        version: "noopolis.causal-event.v1", run_id: "boundary", event_id: "mneme:boundary",
        emitter: { system: "mneme", stream_id: "memory:agent-a", seq: 1 },
        type: "memory.tool.outcome", principal_id: "agent:agent-a", recorded_at: timestamp,
        cause_event_ids: [], payload: {}
      });
      assert.equal(validated.success, true, timestamp);
    }
  }
});

test("offset clocks reject timestamps and expiries beyond the storage range, including anchor and zone offsets", () => {
  const realNow = () => 0;
  for (const options of [
    { origin: "2000-01-01T00:00:00Z", anchorMs: Number.MIN_SAFE_INTEGER },
    { origin: "2000-01-01T00:00:00Z", anchorMs: Number.MAX_SAFE_INTEGER },
    { origin: "1970-01-01T00:00:00Z", anchorMs: -(Date.parse("0000-01-01T00:00:00Z") - 1) },
    { origin: "1970-01-01T00:00:00Z", anchorMs: -(Date.parse("9999-12-31T23:54:59.999Z") + 1) },
    { origin: "+010000-01-01T00:00:00Z" }, { origin: "-000001-01-01T00:00:00Z" },
    { origin: "9999-12-31T23:55:00Z" }, { origin: "0000-01-01T00:00:00+00:01" },
    { origin: "9999-12-31T23:54:59.999Z", anchorMs: -1 }
  ]) {
    assert.throws(() => createOffsetClock({ ...options, realNow }), /clock configuration.*timestamp.*envelope expiry.*date range/);
  }
});

test("injected clocks fail configuration before constructors can write unsupported timestamps", () => {
  for (const now of [NaN, Infinity, Date.parse("-000001-01-01T00:00:00Z"), Date.parse("+010000-01-01T00:00:00Z"), Date.parse("9999-12-31T23:55:00Z")]) {
    const clock = () => now;
    const runtimeHomePath = "/unused-clock-validation";
    for (const construct of [
      () => resolveClock(clock), () => resolveClock(undefined, [{ clock }]),
      () => new JsonlMemoryStore(runtimeHomePath, { clock }),
      () => new CausalEventStore(runtimeHomePath, { clock }),
      () => new MemoryAuthorityGuard(runtimeHomePath, undefined, { clock }),
      () => createMemoryKernel({ runtimeHomePath, clock }),
      () => createMemoryRuntime({ runtimeHomePath, agentId: "agent-a", clock })
    ]) assert.throws(construct, /clock configuration.*date range/);
  }
});

test("deep-time shares its store clock and rejects mismatched or unexposed injection", () => {
  const clock = () => 0;
  const store = new JsonlMemoryStore("/unused-clock-validation", { clock });
  assert.equal(createDeepTimeSession(store).clock, clock);
  assert.equal(createDeepTimeSession(store, { clock }).clock, clock);
  assert.throws(() => createDeepTimeSession(store, { clock: () => 0 }), /dependency clock.*match/);
  const legacy: MemoryStore = {
    append: store.append.bind(store), appendBatch: store.appendBatch.bind(store),
    read: store.read.bind(store), clear: store.clear.bind(store)
  };
  assert.equal(createDeepTimeSession(legacy).clock, wallClock);
  assert.throws(() => createDeepTimeSession(legacy, { clock }), /dependency clock.*match/);
});

test("wallClock and the default realNow keep reading real time", (t) => {
  let realMs = 123;
  t.mock.method(Date, "now", () => realMs);
  const clock = createOffsetClock({ origin: "2000-01-01T00:00:00Z" });
  realMs = 456;
  assert.equal(wallClock(), 456);
  assert.equal(clock(), Date.parse("2000-01-01T00:00:00Z") + 333);
});
