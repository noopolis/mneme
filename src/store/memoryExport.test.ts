import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createMemoryKernel } from "../kernel/kernel.js";
import { memoryScopeId } from "../identity/ids.js";
import {
  MNEME_MEMORY_EXPORT_VERSION,
  validateMnemeMemoryExport
} from "../contract/memoryExport.js";
import { JsonlMemoryStore } from "./store.js";
import { exportMemories, exportMemoriesToFile, memoryExportFilePath } from "./memoryExport.js";
import type { MemoryPrincipalRef, MemoryToolCall, MemoryToolCallEnvelope } from "../contract/types.js";

const tempRoots: string[] = [];

const tempDir = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "noopolis-mneme-memory-export-"));
  tempRoots.push(directory);
  return directory;
};

test.afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const envelope = (
  principal: MemoryPrincipalRef,
  overrides: Partial<MemoryToolCallEnvelope> = {}
): MemoryToolCallEnvelope => ({
  version: "mneme.memory.tool.v1",
  mode: "awake",
  wake_id: "wake-export",
  thread_id: "thread-export",
  principal,
  conversation_scope: "noopolis:agora",
  audience_key: "export-test",
  policy_version: "test-1",
  allowed_scope_aliases: ["all", "current", "global"],
  transport: "in_process",
  nonce: "nonce-export",
  expires_at: new Date(Date.now() + 60_000).toISOString(),
  capability: "memory",
  ...overrides
});

const registerCall = (
  requestId: string,
  principal: MemoryPrincipalRef,
  args: Record<string, unknown>
): MemoryToolCall => ({
  request_id: requestId,
  tool: "memory.register",
  arguments: args,
  envelope: envelope(principal)
});

test("exportMemories returns a schema-valid export with one entry per memory_id at its latest revision", async () => {
  const root = await tempDir();
  const kernel = createMemoryKernel({ runtimeHomePath: root, source: "export-test" });
  const principal: MemoryPrincipalRef = { agentId: "agent-a", scope: "global" };
  const scope = memoryScopeId(principal);

  const first = await kernel.register(registerCall("reg-1", principal, {
    scope,
    kind: "text",
    content: { kind: "text", text: "revision one" },
    visibility: "global",
    sensitivity: "normal",
    evidence_event_ids: ["evt_external"],
    source_type: "test"
  }));
  const rootId = first.content[0].event_ids[0];

  const revision = await kernel.register(registerCall("reg-2", principal, {
    scope,
    kind: "text",
    content: { kind: "text", text: "revision two" },
    visibility: "global",
    sensitivity: "normal",
    evidence_event_ids: ["evt_external_2"],
    source_type: "test",
    memory_id: rootId
  }));
  const revisionId = revision.content[0].event_ids[0];

  const second = await kernel.register(registerCall("reg-3", principal, {
    scope,
    kind: "claim",
    content: { kind: "claim", subject: "eleanor", predicate: "knows", object: "the secret" },
    visibility: "global",
    sensitivity: "normal",
    evidence_event_ids: ["evt_external_3"],
    source_type: "test"
  }));
  const secondId = second.content[0].event_ids[0];

  const store = new JsonlMemoryStore(root);
  const exportedAt = "2026-07-11T00:00:00.000Z";
  const exportDocument = await exportMemories({ bankId: "agent-a", store }, exportedAt);

  const result = validateMnemeMemoryExport(exportDocument);
  assert.equal(result.success, true, result.success ? undefined : JSON.stringify(result.error.issues));

  assert.equal(exportDocument.version, MNEME_MEMORY_EXPORT_VERSION);
  assert.equal(exportDocument.bank_id, "agent-a");
  assert.equal(exportDocument.exported_at, exportedAt);
  assert.equal(exportDocument.memories.length, 2);

  const revisedEntry = exportDocument.memories.find((entry) => entry.memory_id === rootId);
  assert.ok(revisedEntry, "expected the revised chain to have exactly one export entry");
  assert.equal(revisedEntry?.revision_id, revisionId);
  assert.equal(revisedEntry?.scope, scope);
  assert.deepEqual(revisedEntry?.content, { kind: "text", text: "revision two" });

  const secondEntry = exportDocument.memories.find((entry) => entry.memory_id === secondId);
  assert.ok(secondEntry);
  assert.equal(secondEntry?.revision_id, secondId);
  assert.deepEqual(secondEntry?.content, { kind: "claim", subject: "eleanor", predicate: "knows", object: "the secret" });
});

test("exportMemories reads the events checksum as content_sha256", async () => {
  const root = await tempDir();
  const store = new JsonlMemoryStore(root);
  const principal: MemoryPrincipalRef = { agentId: "agent-b", scope: "global" };

  const event = await store.append({
    type: "memory.observed",
    principal,
    scope: "scope-a",
    visibility: "global",
    source: "export-test",
    content: { kind: "text", text: "hello" },
    tags: [],
    entities: [],
    sensitivity: "normal",
    parentEventIds: []
  });

  const exportDocument = await exportMemories({ bankId: "agent-b", store }, "2026-07-11T00:00:00.000Z");
  assert.equal(exportDocument.memories.length, 1);
  assert.equal(exportDocument.memories[0].content_sha256, event.checksum);
  assert.equal(exportDocument.memories[0].memory_id, event.id);
  assert.equal(exportDocument.memories[0].revision_id, event.id);
  assert.equal(exportDocument.memories[0].scope, "scope-a");
});

test("exportMemories orders entries deterministically by root creation order, not insertion/Map order", async () => {
  const root = await tempDir();
  const store = new JsonlMemoryStore(root);
  const principal: MemoryPrincipalRef = { agentId: "agent-c", scope: "global" };

  const contentInput = (text: string) => ({
    type: "memory.observed" as const,
    principal,
    scope: "scope-a",
    visibility: "global" as const,
    source: "export-test",
    content: { kind: "text" as const, text },
    tags: [],
    entities: [],
    sensitivity: "normal" as const,
    parentEventIds: []
  });

  const first = await store.append(contentInput("first"));
  const second = await store.append(contentInput("second"));
  // Revise the first chain after the second chain already exists; the
  // export's ordering must still reflect root creation order (first, then
  // second), not the order the head revisions were last touched.
  await store.append({ ...contentInput("first revised"), memoryId: first.id, parentEventIds: [first.id] });

  const exportDocument = await exportMemories({ bankId: "agent-c", store }, "2026-07-11T00:00:00.000Z");
  assert.deepEqual(exportDocument.memories.map((entry) => entry.memory_id), [first.id, second.id]);

  const repeat = await exportMemories({ bankId: "agent-c", store }, "2026-07-11T00:00:00.000Z");
  assert.deepEqual(repeat, exportDocument);
});

test("exportMemories omits forgotten (tombstoned) chains", async () => {
  const root = await tempDir();
  const store = new JsonlMemoryStore(root);
  const principal: MemoryPrincipalRef = { agentId: "agent-d", scope: "global" };

  const memory = await store.append({
    type: "memory.observed",
    principal,
    scope: "scope-a",
    visibility: "global",
    source: "export-test",
    content: { kind: "text", text: "to be forgotten" },
    tags: [],
    entities: [],
    sensitivity: "normal",
    parentEventIds: []
  });

  await store.append({
    type: "memory.forgotten",
    principal,
    scope: "scope-a",
    visibility: "private",
    source: "export-test",
    content: { kind: "text", text: "tombstone" },
    tags: ["forget"],
    entities: [],
    sensitivity: "secret",
    parentEventIds: [memory.id]
  });

  const exportDocument = await exportMemories({ bankId: "agent-d", store }, "2026-07-11T00:00:00.000Z");
  assert.equal(exportDocument.memories.length, 0);
});

test("exportMemories never emits credential-shaped fields (no token/secret/apiKey/embedding KEYS anywhere in the document)", async () => {
  // Deliberately registers free-text content that itself mentions "secret" /
  // "token" as ordinary memetics-experiment content: this test asserts the
  // document has no credential-shaped FIELD NAMES (per contracts.md's "No
  // credentials in exchanged artifacts" rule), which is a structural
  // guarantee about the schema's own keys, not a claim that user content
  // must avoid those words.
  const root = await tempDir();
  const store = new JsonlMemoryStore(root);
  const principal: MemoryPrincipalRef = { agentId: "agent-e", scope: "global" };

  await store.append({
    type: "memory.observed",
    principal,
    scope: "scope-a",
    visibility: "global",
    source: "export-test",
    content: { kind: "text", text: "the secret token is out" },
    tags: [],
    entities: [],
    sensitivity: "normal",
    parentEventIds: []
  });

  const exportDocument = await exportMemories({ bankId: "agent-e", store }, "2026-07-11T00:00:00.000Z");

  const forbiddenKeys = ["token", "secret", "apikey", "api_key", "password", "credential", "embedding"];
  const collectKeys = (value: unknown, keys: Set<string>): void => {
    if (Array.isArray(value)) {
      for (const entry of value) {
        collectKeys(entry, keys);
      }
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        keys.add(key.toLowerCase());
        collectKeys(nested, keys);
      }
    }
  };

  const keys = new Set<string>();
  collectKeys(exportDocument, keys);

  for (const forbidden of forbiddenKeys) {
    assert.equal(keys.has(forbidden), false, `export document unexpectedly has a "${forbidden}" key`);
  }
});

test("a golden export round-trips through the zod schema (parse -> serialize -> parse)", async () => {
  const root = await tempDir();
  const store = new JsonlMemoryStore(root);
  const principal: MemoryPrincipalRef = { agentId: "agent-f", scope: "global" };

  await store.append({
    type: "memory.observed",
    principal,
    scope: "scope-a",
    visibility: "global",
    source: "export-test",
    content: { kind: "decision", decision: "ship it", rationale: "tests pass" },
    tags: [],
    entities: [],
    sensitivity: "normal",
    parentEventIds: []
  });

  const exportDocument = await exportMemories({ bankId: "agent-f", store }, "2026-07-11T00:00:00.000Z");
  const roundTripped = JSON.parse(JSON.stringify(exportDocument));
  const result = validateMnemeMemoryExport(roundTripped);
  assert.equal(result.success, true);
  assert.deepEqual(result.success ? result.data : undefined, exportDocument);
});

test("validateMnemeMemoryExport rejects a document with an unknown version", () => {
  const broken = {
    version: "mneme.memory-export.v0",
    bank_id: "agent-x",
    exported_at: "2026-07-11T00:00:00.000Z",
    memories: []
  };
  assert.equal(validateMnemeMemoryExport(broken).success, false);
});

test("validateMnemeMemoryExport rejects additional properties (strict envelope)", async () => {
  const root = await tempDir();
  const store = new JsonlMemoryStore(root);
  const exportDocument = await exportMemories({ bankId: "agent-g", store }, "2026-07-11T00:00:00.000Z");
  const broken = { ...exportDocument, unexpected_field: "nope" };
  assert.equal(validateMnemeMemoryExport(broken).success, false);
});

test("exportMemoriesToFile writes a valid mneme.memory-export.v1 document to disk that re-parses", async () => {
  const root = await tempDir();
  const store = new JsonlMemoryStore(root);
  const principal: MemoryPrincipalRef = { agentId: "agent-h", scope: "global" };

  await store.append({
    type: "memory.observed",
    principal,
    scope: "scope-a",
    visibility: "global",
    source: "export-test",
    content: { kind: "text", text: "on disk" },
    tags: [],
    entities: [],
    sensitivity: "normal",
    parentEventIds: []
  });

  const writtenPath = await exportMemoriesToFile(root, { bankId: "agent-h", store }, "2026-07-11T00:00:00.000Z");
  assert.equal(writtenPath, memoryExportFilePath(root));

  const raw = await readFile(writtenPath, "utf8");
  const parsed = JSON.parse(raw);
  const result = validateMnemeMemoryExport(parsed);
  assert.equal(result.success, true);
  assert.equal(parsed.memories.length, 1);
  assert.equal(parsed.memories[0].content.text, "on disk");
});
