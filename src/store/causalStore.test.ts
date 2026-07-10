import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { appendMemoryRecalledEvent, CausalEventStore } from "./causalStore.js";
import { validateCausalEvent, validateMemoryRecalledCausalEvent } from "../contract/causal.js";

const tempRoots: string[] = [];

const tempDir = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "noopolis-mneme-causal-"));
  tempRoots.push(directory);
  return directory;
};

test.afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("append writes a schema-valid causal event with seq 1 for a new stream", async () => {
  const root = await tempDir();
  const store = new CausalEventStore(root);

  const event = await store.append({
    runId: "run-1",
    streamId: "memory:agent-a",
    type: "memory.recalled",
    principalId: "agent-a",
    causeEventIds: ["moltnet:msg-1"],
    payload: { memory_id: "evt_1", revision_id: "evt_1", scope: "room", content_sha256: "abc123" }
  });

  assert.equal(event.emitter.seq, 1);
  assert.equal(event.emitter.system, "mneme");
  assert.equal(event.emitter.stream_id, "memory:agent-a");
  assert.equal(event.version, "noopolis.causal-event.v1");
  assert.ok(event.event_id.startsWith("mneme:"));

  const validated = validateCausalEvent(event);
  assert.equal(validated.success, true);
});

test("append is contiguous per (run_id, stream_id) across calls", async () => {
  const root = await tempDir();
  const store = new CausalEventStore(root);

  const first = await store.append({
    runId: "run-1",
    streamId: "memory:agent-a",
    type: "memory.recalled",
    principalId: "agent-a",
    causeEventIds: [],
    payload: {}
  });
  const second = await store.append({
    runId: "run-1",
    streamId: "memory:agent-a",
    type: "memory.recalled",
    principalId: "agent-a",
    causeEventIds: [],
    payload: {}
  });
  const otherStream = await store.append({
    runId: "run-1",
    streamId: "memory:agent-b",
    type: "memory.recalled",
    principalId: "agent-b",
    causeEventIds: [],
    payload: {}
  });
  const otherRun = await store.append({
    runId: "run-2",
    streamId: "memory:agent-a",
    type: "memory.recalled",
    principalId: "agent-a",
    causeEventIds: [],
    payload: {}
  });

  assert.equal(first.emitter.seq, 1);
  assert.equal(second.emitter.seq, 2);
  assert.equal(otherStream.emitter.seq, 1);
  assert.equal(otherRun.emitter.seq, 1);
});

test("seq counter resumes contiguously when a new store instance reads an existing ledger", async () => {
  const root = await tempDir();
  const first = new CausalEventStore(root);
  await first.append({
    runId: "run-1",
    streamId: "memory:agent-a",
    type: "memory.recalled",
    principalId: "agent-a",
    causeEventIds: [],
    payload: {}
  });

  const second = new CausalEventStore(root);
  const resumed = await second.append({
    runId: "run-1",
    streamId: "memory:agent-a",
    type: "memory.recalled",
    principalId: "agent-a",
    causeEventIds: [],
    payload: {}
  });

  assert.equal(resumed.emitter.seq, 2);
});

test("appends land beside events.jsonl in the memory/ directory as causal.jsonl", async () => {
  const root = await tempDir();
  const store = new CausalEventStore(root);
  await store.append({
    runId: "run-1",
    streamId: "memory:agent-a",
    type: "memory.recalled",
    principalId: "agent-a",
    causeEventIds: [],
    payload: {}
  });

  const raw = await readFile(path.join(root, "memory", "causal.jsonl"), "utf8");
  const lines = raw.trim().split("\n");
  assert.equal(lines.length, 1);
  assert.doesNotThrow(() => JSON.parse(lines[0]));
});

test("read returns previously appended causal events", async () => {
  const root = await tempDir();
  const store = new CausalEventStore(root);
  await store.append({
    runId: "run-1",
    streamId: "memory:agent-a",
    type: "memory.recalled",
    principalId: "agent-a",
    causeEventIds: [],
    payload: {}
  });
  await store.append({
    runId: "run-1",
    streamId: "memory:agent-a",
    type: "memory.recalled",
    principalId: "agent-a",
    causeEventIds: [],
    payload: {}
  });

  const events = await store.read();
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((event) => event.emitter.seq), [1, 2]);
});

test("read returns an empty list when no causal.jsonl exists yet", async () => {
  const root = await tempDir();
  const store = new CausalEventStore(root);
  assert.deepEqual(await store.read(), []);
});

test("appendMemoryRecalledEvent stamps the memory.recalled payload minimum and is schema-valid", async () => {
  const root = await tempDir();
  const store = new CausalEventStore(root);

  const event = await appendMemoryRecalledEvent(store, {
    runId: "run-1",
    agentId: "agent-a",
    principalId: "agent-a",
    causeEventIds: ["daimon:wake-1"],
    memoryId: "evt_selected",
    revisionId: "evt_selected",
    scope: "room",
    contentSha256: "deadbeef"
  });

  assert.equal(event.type, "memory.recalled");
  assert.equal(event.emitter.stream_id, "memory:agent-a");
  assert.deepEqual(event.cause_event_ids, ["daimon:wake-1"]);
  assert.equal(event.payload.memory_id, "evt_selected");
  assert.equal(event.payload.content_sha256, "deadbeef");
  assert.equal(validateMemoryRecalledCausalEvent(event), true);
});
