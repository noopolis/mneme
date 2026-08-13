import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CausalEventStore } from "./causalStore.js";
import { causalEvidenceExportFilePath, exportFinalizedCausalEvidence } from "./memoryExport.js";
import * as publicMneme from "../index.js";

const roots: string[] = [];
const temp = async (): Promise<string> => { const value = await mkdtemp(path.join(os.tmpdir(), "mneme-evidence-")); roots.push(value); return value; };
test.afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

test("B45 evidence export requires an explicit finalized causal stream", async () => {
  const root = await temp(); const store = new CausalEventStore(root);
  await store.append({ runId: "run-a", streamId: "memory:agent-a", type: "memory.tool.outcome", principalId: "agent:agent-a", causeEventIds: ["daimon:wake-a"], payload: { argument_sha256: "b".repeat(64), authority_sha256: "c".repeat(64), tool: "memory.search", decision: "deny", request_sha256: "a".repeat(64) } });
  await assert.rejects(exportFinalizedCausalEvidence(root, "run-a", "memory:agent-a"), /not finalized/);
  await store.finalizeStream("run-a", "memory:agent-a");
  const result = await exportFinalizedCausalEvidence(root, "run-a", "memory:agent-a");
  assert.equal(result.path, causalEvidenceExportFilePath(root));
  const text = await readFile(result.path, "utf8");
  assert.equal(text.includes("memory.tool.outcome"), true);
  assert.equal(text.includes("content"), false);
});

test("B45 retires raw memory export symbols", async () => {
  const source = await readFile(new URL("./memoryExport.ts", import.meta.url), "utf8");
  assert.equal(source.includes("exportMemories"), false);
  assert.equal(source.includes("JsonlMemoryStore"), false);
  assert.equal("exportMemories" in publicMneme, false);
  assert.equal(typeof publicMneme.sealAndExportCausalEvidence, "function");
  assert.equal(typeof publicMneme.exportFinalizedCausalEvidence, "function");
});
