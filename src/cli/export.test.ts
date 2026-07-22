import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CausalEventStore } from "../store/causalStore.js";
import { causalEvidenceExportFilePath } from "../store/memoryExport.js";
import { parseMnemeExportArgs, runMnemeExportCommand, runMnemeSealCommand } from "./export.js";

const roots: string[] = [];
const temp = async (): Promise<string> => { const value = await mkdtemp(path.join(os.tmpdir(), "mneme-cli-evidence-")); roots.push(value); return value; };
test.afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

test("mneme export parses only an evidence stream selector", () => {
  assert.deepEqual(parseMnemeExportArgs(["--runtime-home", "/tmp/a", "--agent-id", "agent-a", "--run-id", "run-a"], {}), { runtimeHomePath: "/tmp/a", agentId: "agent-a", runId: "run-a" });
  assert.deepEqual(parseMnemeExportArgs(["--runtime-home", "/tmp/a", "--agent-id", "agent-a"], { NOOPOLIS_RUN_ID: " run-env " }), { runtimeHomePath: "/tmp/a", agentId: "agent-a", runId: "run-env" });
  assert.throws(() => parseMnemeExportArgs(["--agent-id", "agent-a"], {}), /runtime-home/);
  assert.throws(() => parseMnemeExportArgs(["--runtime-home", "/tmp/a", "--agent-id", "agent-a"], {}), /run-id or NOOPOLIS_RUN_ID/);
});

test("mneme export writes finalized evidence, never raw memory content", async () => {
  const root = await temp(); const store = new CausalEventStore(root);
  await store.append({ runId: "run-a", streamId: "memory:agent-a", type: "memory.tool.outcome", principalId: "agent:agent-a", causeEventIds: ["daimon:wake"], payload: { argument_sha256: "a".repeat(64), authority_sha256: "c".repeat(64), tool: "memory.search", decision: "deny", request_sha256: "b".repeat(64) } });
  const sealed = await runMnemeSealCommand(["--runtime-home", root, "--agent-id", "agent-a", "--run-id", "run-a"], {});
  assert.equal(sealed, causalEvidenceExportFilePath(root));
  const firstBytes = await readFile(sealed, "utf8");
  // Simulate a crash after the durable final but before/after publishing the
  // export file. The exact retry must recreate the same selected bytes.
  await rm(sealed);
  const retried = await runMnemeSealCommand(["--runtime-home", root, "--agent-id", "agent-a", "--run-id", "run-a"], {});
  assert.equal(retried, sealed);
  assert.equal(await readFile(retried, "utf8"), firstBytes);
  const written = await runMnemeExportCommand(["--runtime-home", root, "--agent-id", "agent-a", "--run-id", "run-a"], {});
  assert.equal(written, causalEvidenceExportFilePath(root));
  assert.equal((await readFile(written, "utf8")).includes("content"), false);
});

test("mneme seal uses the injected CLI environment run id", async () => {
  const root = await temp();
  const written = await runMnemeSealCommand(["--runtime-home", root, "--agent-id", "agent-a"], { NOOPOLIS_RUN_ID: "run-from-env" });
  assert.match(await readFile(written, "utf8"), /"run_id":"run-from-env"/);
});

test("mneme seal emits an explicit empty stream final", async () => {
  const root = await temp();
  const written = await runMnemeSealCommand(["--runtime-home", root, "--agent-id", "agent-a", "--run-id", "run-empty"], {});
  assert.match(await readFile(written, "utf8"), /"final_seq":0/);
});
