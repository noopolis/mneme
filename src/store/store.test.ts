import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { JsonlMemoryStore } from "./store.js";
import type { MemoryEventInput } from "../contract/types.js";

const tempRoots: string[] = [];

const tempDir = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "noopolis-mneme-store-"));
  tempRoots.push(directory);
  return directory;
};

test.afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const observed = (text: string): MemoryEventInput => ({
  type: "memory.observed",
  principal: { agentId: "agent-a", scope: "global" },
  scope: "agent:agent-a/scope:global",
  visibility: "global",
  source: "store-test",
  content: { kind: "text", text },
  tags: [],
  entities: [],
  sensitivity: "normal",
  parentEventIds: []
});

const eventsPath = (root: string): string => path.join(root, "memory", "events.jsonl");

test("append assigns a monotonic seq starting at 1 for a fresh store", async () => {
  const root = await tempDir();
  const store = new JsonlMemoryStore(root);

  const first = await store.append(observed("one"));
  const second = await store.append(observed("two"));

  assert.equal(first.seq, 1);
  assert.equal(second.seq, 2);
});

test("appendBatch assigns contiguous increasing seq values", async () => {
  const root = await tempDir();
  const store = new JsonlMemoryStore(root);

  const events = await store.appendBatch([observed("a"), observed("b"), observed("c")]);
  assert.deepEqual(events.map((event) => event.seq), [1, 2, 3]);
});

test("same-path handles serialize concurrent appends into one unique contiguous sequence", async () => {
  const root = await tempDir();
  const stores = Array.from({ length: 4 }, () => new JsonlMemoryStore(root));
  const appended = await Promise.all(Array.from({ length: 64 }, (_value, index) =>
    stores[index % stores.length].append(observed(`concurrent-${index}`))));

  const expected = Array.from({ length: 64 }, (_value, index) => index + 1);
  assert.deepEqual(appended.map((event) => event.seq).sort((left, right) => left - right), expected);
  assert.equal(new Set(appended.map((event) => event.seq)).size, expected.length);

  const persisted = (await readFile(eventsPath(root), "utf8")).trim().split("\n")
    .map((line) => JSON.parse(line) as { id: string; seq: number });
  assert.deepEqual(persisted.map((event) => event.seq), expected);
  assert.equal(new Set(persisted.map((event) => event.id)).size, expected.length);
});

test("seq counter resumes past existing B59-native lines when a new store instance opens the same ledger", async () => {
  const root = await tempDir();
  const first = new JsonlMemoryStore(root);
  await first.append(observed("one"));
  await first.append(observed("two"));

  const second = new JsonlMemoryStore(root);
  const third = await second.append(observed("three"));

  assert.equal(third.seq, 3);
});

test("legacy lines without seq are backfilled from 1-based line order on read, and new appends continue past them", async () => {
  const root = await tempDir();
  const memoryDir = path.join(root, "memory");
  await mkdir(memoryDir, { recursive: true });

  const legacyLineOne = {
    id: "evt_legacy_1",
    type: "memory.observed",
    createdAt: new Date(Date.now() - 10_000).toISOString(),
    principal: { agentId: "agent-a", scope: "global" },
    scope: "agent:agent-a/scope:global",
    visibility: "global",
    source: "legacy",
    content: { kind: "text", text: "legacy one" },
    tags: [],
    entities: [],
    sensitivity: "normal",
    parentEventIds: [],
    checksum: "legacy-checksum-1"
  };
  const legacyLineTwo = {
    ...legacyLineOne,
    id: "evt_legacy_2",
    content: { kind: "text", text: "legacy two" },
    checksum: "legacy-checksum-2"
  };

  await appendFile(
    path.join(memoryDir, "events.jsonl"),
    `${JSON.stringify(legacyLineOne)}\n${JSON.stringify(legacyLineTwo)}\n`,
    { encoding: "utf8" }
  );

  const store = new JsonlMemoryStore(root);
  const readBack = await store.read();
  const byId = new Map(readBack.map((event) => [event.id, event]));

  assert.equal(byId.get("evt_legacy_1")?.seq, 1);
  assert.equal(byId.get("evt_legacy_2")?.seq, 2);
  assert.equal(byId.get("evt_legacy_1")?.memoryId, undefined);
  assert.equal(byId.get("evt_legacy_1")?.origin, undefined);

  const appended = await store.append(observed("first native append after legacy"));
  assert.equal(appended.seq, 3);

  const persisted = (await readFile(eventsPath(root), "utf8")).trim().split("\n")
    .map((line) => JSON.parse(line) as { seq?: number });
  assert.deepEqual(persisted.map((event) => event.seq), [undefined, undefined, 3]);
});

test("restart revalidates the durable ledger and resumes from its exact final sequence", async () => {
  const root = await tempDir();
  await new JsonlMemoryStore(root).appendBatch([observed("one"), observed("two")]);

  const restarted = new JsonlMemoryStore(root);
  assert.deepEqual((await restarted.read()).map((event) => event.seq).sort((a, b) => a - b), [1, 2]);
  assert.equal((await restarted.append(observed("three"))).seq, 3);
  assert.deepEqual((await new JsonlMemoryStore(root).read()).map((event) => event.seq).sort((a, b) => a - b), [1, 2, 3]);
});

test("malformed, truncated, and blank records fail closed without changing the ledger", async () => {
  const root = await tempDir();
  const store = new JsonlMemoryStore(root);
  const valid = await store.append(observed("valid"));
  const { principal: _principal, ...missingPrincipal } = valid;
  const cases = [
    `${JSON.stringify(valid)}\n{"id":`,
    JSON.stringify(valid),
    `${JSON.stringify(valid)}\n\n`,
    `${JSON.stringify(valid).replace('"seq":1', '"seq":1,"seq":1')}\n`,
    `${JSON.stringify({ ...valid, unexpected: true })}\n`,
    `${JSON.stringify(missingPrincipal)}\n`,
    "null\n"
  ];

  for (const payload of cases) {
    await writeFile(eventsPath(root), payload, "utf8");
    await assert.rejects(store.read(), /Invalid Mneme memory ledger/u);
    await assert.rejects(store.append(observed("must-not-append")), /Invalid Mneme memory ledger/u);
    assert.equal(await readFile(eventsPath(root), "utf8"), payload);
  }
});

test("duplicate, gapped, reordered, and post-native legacy sequences fail closed", async () => {
  const root = await tempDir();
  const store = new JsonlMemoryStore(root);
  const first = await store.append(observed("one"));
  const second = { ...first, id: "evt_second", seq: 2 };
  const { seq: _seq, ...legacySecond } = second;
  const cases = [
    [first, { ...second, seq: 1 }],
    [first, { ...second, seq: 3 }],
    [{ ...first, seq: 2 }],
    [second, first],
    [first, legacySecond]
  ];

  for (const records of cases) {
    const payload = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
    await writeFile(eventsPath(root), payload, "utf8");
    await assert.rejects(store.read(), /Invalid Mneme memory ledger/u);
    await assert.rejects(store.append(observed("must-not-repair")), /Invalid Mneme memory ledger/u);
    assert.equal(await readFile(eventsPath(root), "utf8"), payload);
  }
});

test("legacy compatibility permits only a valid prefix followed by exact native sequence", async () => {
  const root = await tempDir();
  const store = new JsonlMemoryStore(root);
  const native = await store.append(observed("seed"));
  const { seq: _seq, ...legacy } = native;
  const nativeTwo = { ...native, id: "evt_native_two", seq: 2 };
  await writeFile(eventsPath(root), `${JSON.stringify(legacy)}\n${JSON.stringify(nativeTwo)}\n`, "utf8");

  const compatible = await store.read();
  assert.deepEqual(compatible.map((event) => event.seq).sort((a, b) => a - b), [1, 2]);
  assert.equal((await store.append(observed("native-three"))).seq, 3);
});

test("clear resets the seq counter for the next append", async () => {
  const root = await tempDir();
  const store = new JsonlMemoryStore(root);

  await store.append(observed("one"));
  await store.append(observed("two"));
  await store.clear();

  const afterClear = await store.append(observed("three"));
  assert.equal(afterClear.seq, 1);
});

test("memoryId and origin round-trip through append and read", async () => {
  const root = await tempDir();
  const store = new JsonlMemoryStore(root);

  const root1 = await store.append(observed("root revision"));
  const revision = await store.append({
    ...observed("second revision"),
    memoryId: root1.id,
    origin: "dream",
    parentEventIds: [root1.id]
  });

  const events = await store.read();
  const readRevision = events.find((event) => event.id === revision.id);
  assert.equal(readRevision?.memoryId, root1.id);
  assert.equal(readRevision?.origin, "dream");
});
