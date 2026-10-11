import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CausalEventStore, createDeepTimeSession, createMemoryKernel, createMemoryRuntime,
  createMemoryToolEnvelope, createOffsetClock, JsonlMemoryStore, MemoryAuthorityGuard,
  resolveClock, validateCausalEvent, wallClock, type MemoryClock, type MemoryStore
} from "../index.js";

test("resolveClock preserves legacy wall clocks and compares custom sources through stable wrappers", () => {
  const clock = () => 0;
  const validated = resolveClock(clock);
  assert.equal(resolveClock(), wallClock);
  assert.equal(resolveClock(undefined, [undefined, {}, { clock: undefined }]), wallClock);
  for (const dependencies of [[{}, { clock: wallClock }], [{ clock: wallClock }, {}], [{ clock: wallClock }]]) {
    assert.equal(resolveClock(undefined, dependencies), wallClock);
  }
  assert.notEqual(validated, clock);
  assert.equal(resolveClock(clock), validated);
  assert.equal(resolveClock(validated), validated);
  assert.equal(resolveClock(clock, [undefined, { clock }]), validated);
  assert.equal(resolveClock(undefined, [{ clock }, { clock: validated }]), validated);
  assert.equal(resolveClock(clock, [{ clock: validated }]), validated);
  assert.equal(resolveClock(validated, [{ clock }]), validated);
  for (const configured of [undefined, clock]) {
    for (const dependencies of [[{ clock }, {}], [{}, { clock }], [{ clock }, { clock: () => 0 }],
      [{ clock: validated }, {}], [{ clock: validated }, { clock: wallClock }]]) {
      assert.throws(() => resolveClock(configured, dependencies), /dependency clock.*match/);
    }
  }
  assert.throws(() => resolveClock(clock, [{}]), /dependency clock.*match/);
  assert.throws(() => resolveClock(wallClock, [{}]), /dependency clock.*match/);
});

test("resolved custom clocks validate every read after a valid construction sample", () => {
  let now = 0;
  let reads = 0;
  const source = () => { reads += 1; return now; };
  const clock = resolveClock(source);
  assert.equal(clock(), 0);
  const beforeRead = reads;
  assert.equal(clock(), 0);
  assert.equal(reads, beforeRead + 1);
  for (now of [NaN, Infinity, -Infinity, Date.parse("0000-01-01T00:00:00Z") - 1,
    Date.parse("9999-12-31T23:54:59.999Z") + 1, Date.parse("+010000-01-01T00:00:00Z")]) {
    assert.throws(() => clock(), { name: "RangeError", message: /clock.*date range.*0000–9999/ });
  }
  now = 1;
  assert.equal(clock(), 1);
  assert.equal(resolveClock(source), clock);
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

test("advancing offset clocks reject the first read beyond either supported boundary", () => {
  for (const [origin, step] of [["0000-01-01T00:00:00Z", -1], ["9999-12-31T23:54:59.999Z", 1]] as const) {
    let realMs = 0;
    const clock = createOffsetClock({ origin, realNow: () => realMs });
    assert.equal(clock(), Date.parse(origin));
    realMs += step;
    assert.throws(() => clock(), { name: "RangeError", message: /clock.*date range.*0000–9999/ });
  }
});

test("stores reject advancing clock range errors before appending unsupported timestamps", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mneme-clock-range-"));
  try {
    let realMs = 0;
    const clock = createOffsetClock({ origin: "9999-12-31T23:54:59.999Z", realNow: () => realMs });
    const store = new JsonlMemoryStore(root, { clock });
    const causalStore = new CausalEventStore(root, { clock });
    const appendMemory = () => store.append({
      type: "memory.observed", principal: { agentId: "agent-a", scope: "global" },
      scope: "agent:agent-a/scope:global", visibility: "global", source: "clock-test",
      content: { kind: "text", text: "clock boundary" }
    });
    const appendCausal = () => causalStore.append({
      runId: "clock-boundary", streamId: "memory:agent-a", type: "memory.tool.request",
      principalId: "agent:agent-a", causeEventIds: [],
      payload: { tool: "memory.search", argument_sha256: "a".repeat(64), authority_sha256: "b".repeat(64), request_sha256: "c".repeat(64) }
    });
    await appendMemory();
    await appendCausal();
    const memoryBefore = await store.read();
    const causalBefore = await causalStore.read();
    realMs += 1;
    for (const append of [appendMemory, appendCausal]) {
      await assert.rejects(append, { name: "RangeError", message: /clock.*date range.*0000–9999/ });
    }
    assert.deepEqual(await store.read(), memoryBefore);
    assert.deepEqual(await causalStore.read(), causalBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
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
  assert.equal(createDeepTimeSession(store).clock, store.clock);
  assert.equal(createDeepTimeSession(store, { clock }).clock, store.clock);
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
