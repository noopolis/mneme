import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { validateMnemeMemoryExport } from "../contract/memoryExport.js";
import { JsonlMemoryStore } from "../store/store.js";
import { memoryExportFilePath } from "../store/memoryExport.js";
import { parseMnemeExportArgs, runMnemeExportCommand } from "./export.js";

const tempRoots: string[] = [];

const tempDir = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "noopolis-mneme-cli-export-"));
  tempRoots.push(directory);
  return directory;
};

test.afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("parseMnemeExportArgs reads --runtime-home/--agent-id and optional --exported-at", () => {
  const args = parseMnemeExportArgs(["--runtime-home", "/tmp/foo", "--agent-id", "agent-a", "--exported-at", "2026-07-11T00:00:00.000Z"], {});
  assert.deepEqual(args, {
    runtimeHomePath: "/tmp/foo",
    bankId: "agent-a",
    exportedAt: "2026-07-11T00:00:00.000Z"
  });
});

test("parseMnemeExportArgs falls back to MNEME_RUNTIME_HOME / MNEME_AGENT_ID env vars", () => {
  const args = parseMnemeExportArgs([], {
    MNEME_RUNTIME_HOME: "/tmp/env-home",
    MNEME_AGENT_ID: "agent-env"
  } as NodeJS.ProcessEnv);
  assert.equal(args.runtimeHomePath, "/tmp/env-home");
  assert.equal(args.bankId, "agent-env");
  assert.equal(args.exportedAt, undefined);
});

test("parseMnemeExportArgs throws without a runtime home", () => {
  assert.throws(() => parseMnemeExportArgs(["--agent-id", "agent-a"], {}), /--runtime-home/);
});

test("parseMnemeExportArgs throws without an agent id", () => {
  assert.throws(() => parseMnemeExportArgs(["--runtime-home", "/tmp/foo"], {}), /--agent-id/);
});

test("runMnemeExportCommand writes a valid mneme.memory-export.v1 document that re-parses", async () => {
  const root = await tempDir();
  const store = new JsonlMemoryStore(root);
  await store.append({
    type: "memory.observed",
    principal: { agentId: "agent-cli", scope: "global" },
    scope: "scope-a",
    visibility: "global",
    source: "cli-export-test",
    content: { kind: "text", text: "from the cli" },
    tags: [],
    entities: [],
    sensitivity: "normal",
    parentEventIds: []
  });

  const writtenPath = await runMnemeExportCommand(
    ["--runtime-home", root, "--agent-id", "agent-cli", "--exported-at", "2026-07-11T00:00:00.000Z"],
    {} as NodeJS.ProcessEnv
  );

  assert.equal(writtenPath, memoryExportFilePath(root));
  const parsed = JSON.parse(await readFile(writtenPath, "utf8"));
  const result = validateMnemeMemoryExport(parsed);
  assert.equal(result.success, true);
  assert.equal(parsed.bank_id, "agent-cli");
  assert.equal(parsed.exported_at, "2026-07-11T00:00:00.000Z");
  assert.equal(parsed.memories.length, 1);
});
