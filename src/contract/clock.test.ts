import assert from "node:assert/strict";
import test from "node:test";

import { createMemoryToolEnvelope, createOffsetClock, wallClock, type MemoryClock } from "../index.js";

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

test("offset clocks reject unrepresentable initial timestamps and envelope expiries", () => {
  const dateLimit = 8_640_000_000_000_000;
  const realNow = () => 0;
  for (const initialMs of [-dateLimit, dateLimit - 300_000]) {
    const clock = createOffsetClock({ origin: "1970-01-01T00:00:00Z", anchorMs: -initialMs, realNow });
    assert.equal(clock(), initialMs);
    const envelope = createMemoryToolEnvelope({
      clock, wakeId: "daimon:boundary", threadId: "boundary",
      principal: { agentId: "luna", scope: "global" }, conversationScope: "global"
    });
    assert.equal(Date.parse(envelope.expires_at), initialMs + 300_000);
  }
  for (const options of [
    { origin: "2000-01-01T00:00:00Z", anchorMs: Number.MIN_SAFE_INTEGER },
    { origin: "2000-01-01T00:00:00Z", anchorMs: Number.MAX_SAFE_INTEGER },
    { origin: "1970-01-01T00:00:00Z", anchorMs: dateLimit + 1 },
    { origin: "1970-01-01T00:00:00Z", anchorMs: -(dateLimit - 300_000 + 1) },
    { origin: "+275760-09-13T00:00:00Z" }
  ]) {
    assert.throws(() => createOffsetClock({ ...options, realNow }), /clock configuration.*timestamp.*envelope expiry.*date range/);
  }
});

test("wallClock and the default realNow keep reading real time", (t) => {
  let realMs = 123;
  t.mock.method(Date, "now", () => realMs);
  const clock = createOffsetClock({ origin: "2000-01-01T00:00:00Z" });
  realMs = 456;
  assert.equal(wallClock(), 456);
  assert.equal(clock(), Date.parse("2000-01-01T00:00:00Z") + 333);
});
