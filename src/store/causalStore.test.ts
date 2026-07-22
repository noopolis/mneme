import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { appendMemoryRecalledEvent, CausalEventStore } from "./causalStore.js";
import { canonicalJsonStringify, parseCompleteCausalStream, validateCausalEvent, validateMemoryRecalledCausalEvent } from "../contract/causal.js";

const digest = "a".repeat(64);
const recalledPayload = (id: string) => ({
  memory_id: `evt_${id}`,
  revision_id: `evt_${id}`,
  scope: "agent:agent-a/scope:global",
  content_sha256: digest
});
const outcomePayload = () => ({
  argument_sha256: digest,
  authority_sha256: digest,
  decision: "deny",
  request_sha256: digest,
  tool: "memory.search"
});
const requestPayload = () => ({
  argument_sha256: digest,
  authority_sha256: digest,
  request_sha256: digest,
  tool: "memory.search"
});

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
    principalId: "agent:agent-a",
    causeEventIds: ["moltnet:msg-1"],
    payload: recalledPayload("1")
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
    principalId: "agent:agent-a",
    causeEventIds: ["daimon:wake-first"],
    payload: recalledPayload("first")
  });
  const second = await store.append({
    runId: "run-1",
    streamId: "memory:agent-a",
    type: "memory.recalled",
    principalId: "agent:agent-a",
    causeEventIds: ["daimon:wake-second"],
    payload: recalledPayload("second")
  });
  const otherStream = await store.append({
    runId: "run-1",
    streamId: "memory:agent-b",
    type: "memory.recalled",
    principalId: "agent:agent-b",
    causeEventIds: ["daimon:wake-other-stream"],
    payload: { ...recalledPayload("other-stream"), scope: "agent:agent-b/scope:global" }
  });
  const otherRun = await store.append({
    runId: "run-2",
    streamId: "memory:agent-a",
    type: "memory.recalled",
    principalId: "agent:agent-a",
    causeEventIds: ["daimon:wake-other-run"],
    payload: recalledPayload("other-run")
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
    principalId: "agent:agent-a",
    causeEventIds: ["daimon:wake-resume-first"],
    payload: recalledPayload("resume-first")
  });

  const second = new CausalEventStore(root);
  const resumed = await second.append({
    runId: "run-1",
    streamId: "memory:agent-a",
    type: "memory.recalled",
    principalId: "agent:agent-a",
    causeEventIds: ["daimon:wake-resume-second"],
    payload: recalledPayload("resume-second")
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
    principalId: "agent:agent-a",
    causeEventIds: ["daimon:wake-disk"],
    payload: recalledPayload("disk")
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
    principalId: "agent:agent-a",
    causeEventIds: ["daimon:wake-read-first"],
    payload: recalledPayload("read-first")
  });
  await store.append({
    runId: "run-1",
    streamId: "memory:agent-a",
    type: "memory.recalled",
    principalId: "agent:agent-a",
    causeEventIds: ["daimon:wake-read-second"],
    payload: recalledPayload("read-second")
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
    principalId: "agent:agent-a",
    causeEventIds: ["daimon:wake-1"],
    memoryId: "evt_selected",
    revisionId: "evt_selected",
    scope: "room",
    contentSha256: digest
  });

  assert.equal(event.type, "memory.recalled");
  assert.equal(event.emitter.stream_id, "memory:agent-a");
  assert.deepEqual(event.cause_event_ids, ["daimon:wake-1"]);
  assert.equal(event.payload.memory_id, "evt_selected");
  assert.equal(event.payload.content_sha256, digest);
  assert.equal(validateMemoryRecalledCausalEvent(event), true);
});

test("two instances share one contiguous sequence and a durable final closes the stream", async () => {
  const root = await tempDir();
  const left = new CausalEventStore(root);
  const right = new CausalEventStore(root);
  const append = (store: CausalEventStore) => store.append({
    runId: "run-final", streamId: "memory:agent-a", type: "memory.tool.outcome",
    principalId: "agent:agent-a", causeEventIds: ["daimon:wake-final"], payload: outcomePayload()
  });
  const events = await Promise.all([append(left), append(right), append(left), append(right)]);
  assert.deepEqual(events.map((event) => event.emitter.seq).sort(), [1, 2, 3, 4]);
  await left.finalizeStream("run-final", "memory:agent-a");
  await assert.rejects(() => right.append({
    runId: "run-final", streamId: "memory:agent-a", type: "memory.tool.outcome",
    principalId: "agent:agent-a", causeEventIds: ["daimon:wake-final"], payload: outcomePayload()
  }), /finalized/);
  await right.finalizeStream("run-final", "memory:agent-a");
  const bytes = await new CausalEventStore(root).exportStream("run-final", "memory:agent-a");
  assert.match(new TextDecoder().decode(bytes), /"final_seq":4/);
});

test("B45 an empty stream exports one canonical final and a complete stream exports exact final_seq", async () => {
  const root = await tempDir();
  const store = new CausalEventStore(root);
  await store.finalizeStream("run-empty", "memory:agent-a");
  const bytes = await store.exportStream("run-empty", "memory:agent-a");
  const expectedFinal = {
    version: "noopolis.causal-stream-final.v1",
    run_id: "run-empty",
    emitter: { system: "mneme", stream_id: "memory:agent-a" },
    final_seq: 0
  };
  assert.equal(new TextDecoder().decode(bytes), `${canonicalJsonStringify(expectedFinal)}\n`);
  const parsed = parseCompleteCausalStream(bytes, "run-empty", "memory:agent-a");
  assert.equal(parsed.events.length, 0);
  assert.equal(parsed.final.final_seq, 0);

  // An export must revalidate durable bytes, not reuse a cached final after
  // the ledger was altered by another process.
  await writeFile(path.join(root, "memory", "causal.jsonl"), "", "utf8");
  await assert.rejects(() => store.exportStream("run-empty", "memory:agent-a"), /not finalized/);
});

test("B45 a removed causal parent is detected even by an already-open store", async () => {
  const root = await tempDir();
  const store = new CausalEventStore(root);
  const parent = await store.append({
    runId: "run-parent", streamId: "memory:agent-a", eventId: "mneme:mcp-request-parent",
    type: "memory.tool.request", principalId: "agent:agent-a", causeEventIds: [], payload: requestPayload()
  });
  await store.append({
    runId: "run-parent", streamId: "memory:agent-a", type: "memory.tool.outcome",
    principalId: "agent:agent-a", causeEventIds: [parent.event_id], payload: outcomePayload()
  });
  assert.equal((await store.read()).length, 2);

  const ledgerPath = path.join(root, "memory", "causal.jsonl");
  const lines = (await readFile(ledgerPath, "utf8")).trimEnd().split("\n");
  const child = JSON.parse(lines[1]) as { emitter: { seq: number } };
  child.emitter.seq = 1;
  await writeFile(ledgerPath, `${canonicalJsonStringify(child)}\n`, "utf8");
  await assert.rejects(() => store.read(), /unresolved or out-of-order local Mneme causal parent/);
});

test("B45 read rejects canonical owner forgery and raw secret payload tampering", async () => {
  const root = await tempDir();
  const store = new CausalEventStore(root);
  await store.append({
    runId: "run-tamper", streamId: "memory:agent-a", type: "memory.tool.outcome",
    principalId: "agent:agent-a", causeEventIds: ["daimon:wake"], payload: outcomePayload()
  });
  const ledgerPath = path.join(root, "memory", "causal.jsonl");
  const original = JSON.parse((await readFile(ledgerPath, "utf8")).trim()) as Record<string, unknown>;
  await writeFile(ledgerPath, `${canonicalJsonStringify({ ...original, principal_id: "agent:attacker" })}\n`, "utf8");
  await assert.rejects(() => store.read(), /principal does not match/);

  const payload = { ...(original.payload as Record<string, unknown>), secret: "RAW_SECRET_DO_NOT_EXPORT" };
  await writeFile(ledgerPath, `${canonicalJsonStringify({ ...original, payload })}\n`, "utf8");
  await assert.rejects(() => store.read(), /raw content|secret-like|Unrecognized key/);

  const rawRoot = await tempDir();
  const rawStore = new CausalEventStore(rawRoot);
  await rawStore.append({
    runId: "run-raw", streamId: "memory:agent-a", type: "memory.recalled",
    principalId: "agent:agent-a", causeEventIds: ["daimon:wake"], payload: recalledPayload("raw")
  });
  const rawPath = path.join(rawRoot, "memory", "causal.jsonl");
  const raw = JSON.parse((await readFile(rawPath, "utf8")).trim()) as { payload: Record<string, unknown> };
  raw.payload.scope = "TOP_SECRET_SCOPE_VALUE";
  await writeFile(rawPath, `${canonicalJsonStringify(raw)}\n`, "utf8");
  await assert.rejects(() => rawStore.read(), /secret-like evidence value/);
});

test("B45 append rejects unresolved local parents while finalized export retains external parents", async () => {
  const root = await tempDir();
  const external = new CausalEventStore(root);
  await external.append({
    runId: "run-external", streamId: "memory:agent-a", type: "memory.tool.outcome",
    principalId: "agent:agent-a", causeEventIds: ["daimon:wake"], payload: outcomePayload()
  });
  await external.finalizeStream("run-external", "memory:agent-a");
  assert.match(new TextDecoder().decode(await external.exportStream("run-external", "memory:agent-a")), /daimon:wake/);

  const unresolvedRoot = await tempDir();
  const unresolved = new CausalEventStore(unresolvedRoot);
  await assert.rejects(() => unresolved.append({
    runId: "run-unresolved", streamId: "memory:agent-a", type: "memory.tool.outcome",
    principalId: "agent:agent-a", causeEventIds: ["mneme:missing-parent"], payload: outcomePayload()
  }), /unresolved or out-of-order local Mneme causal parent/);
});

test("B45 enforces the exact agent/system event-family authority matrix", async () => {
  const root = await tempDir();
  const store = new CausalEventStore(root);
  const systemOutcome = { ...outcomePayload(), decision: "malformed_request" } as Record<string, unknown>;
  delete systemOutcome.authority_sha256;

  await assert.rejects(() => store.append({
    runId: "run-matrix", streamId: "memory:agent-a", type: "memory.tool.outcome",
    principalId: "agent:agent-a", causeEventIds: ["daimon:wake"],
    payload: { ...systemOutcome, decision: "deny" }
  }), /requires authority_sha256/);
  await assert.rejects(() => store.append({
    runId: "run-matrix", streamId: "memory:mneme-system", type: "memory.written",
    principalId: "system:mneme", causeEventIds: ["daimon:wake"], payload: recalledPayload("system-write")
  }), /only accepts malformed tool outcomes/);
  await assert.rejects(() => store.append({
    runId: "run-matrix", streamId: "memory:mneme-system", type: "memory.tool.outcome",
    principalId: "system:mneme", causeEventIds: [], payload: { ...systemOutcome, decision: "deny" }
  }), /invalid unauthenticated/);
  await assert.rejects(() => store.append({
    runId: "run-matrix", streamId: "memory:mneme-system", type: "memory.tool.outcome",
    principalId: "system:mneme", causeEventIds: ["daimon:wake"], payload: systemOutcome
  }), /invalid unauthenticated/);
  const accepted = await store.append({
    runId: "run-matrix", streamId: "memory:mneme-system", type: "memory.tool.outcome",
    principalId: "system:mneme", causeEventIds: [], payload: systemOutcome
  });
  assert.equal(accepted.emitter.seq, 1);
});

test("B45 local Mneme parents must precede children in the same run and owner", async () => {
  const root = await tempDir();
  const store = new CausalEventStore(root);
  await assert.rejects(() => store.append({
    runId: "run-parent-order", streamId: "memory:agent-a", type: "memory.tool.outcome",
    principalId: "agent:agent-a", causeEventIds: ["mneme:future"], payload: outcomePayload()
  }), /unresolved or out-of-order/);
  await assert.rejects(() => store.append({
    runId: "run-parent-order", streamId: "memory:agent-a", eventId: "mneme:self",
    type: "memory.tool.outcome", principalId: "agent:agent-a", causeEventIds: ["mneme:self"], payload: outcomePayload()
  }), /cannot cause itself/);

  const parent = await store.append({
    runId: "run-parent-order", streamId: "memory:agent-a", eventId: "mneme:request",
    type: "memory.tool.request", principalId: "agent:agent-a", causeEventIds: [], payload: requestPayload()
  });
  await assert.rejects(() => store.append({
    runId: "run-other", streamId: "memory:agent-a", type: "memory.tool.outcome",
    principalId: "agent:agent-a", causeEventIds: [parent.event_id], payload: outcomePayload()
  }), /cross-run/);
  await assert.rejects(() => store.append({
    runId: "run-parent-order", streamId: "memory:agent-b", type: "memory.tool.outcome",
    principalId: "agent:agent-b", causeEventIds: [parent.event_id], payload: outcomePayload()
  }), /cross-owner/);
  await assert.rejects(() => store.append({
    runId: "run-parent-order", streamId: "memory:agent-a", type: "memory.tool.outcome",
    principalId: "agent:agent-a", causeEventIds: [parent.event_id],
    payload: { ...outcomePayload(), request_sha256: "b".repeat(64) }
  }), /does not match request request_sha256/);
});
