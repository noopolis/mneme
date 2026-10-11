import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("CLI refuses invalid clock settings before startup or writes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mneme-clock-cli-"));
  const entrypoint = fileURLToPath(new URL("./index.ts", import.meta.url));
  const env = { ...process.env };
  delete env.MNEME_CLOCK_ORIGIN;
  delete env.MNEME_CLOCK_ANCHOR_MS;
  try {
    for (const command of ["mcp", "seal", "export"]) {
      for (const [options, error] of [
        [["--clock-origin", "invalid"], /clock origin/],
        [["--clock-origin", "2000-01-01T00:00:00"], /clock origin/],
        [["--clock-anchor-ms", "123"], /requires.*clock-origin/],
        [["--clock-origin", "2000-01-01T00:00:00Z", "--clock-anchor-ms", "1.5"], /integer/]
      ] as const) {
        const result = spawnSync(process.execPath, [
          "--import", "tsx", entrypoint, command, "--runtime-home", root,
          "--agent-id", "agent-a", "--run-id", "clock-test", ...options
        ], { encoding: "utf8", timeout: 10_000, env });
        assert.equal(result.error, undefined);
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, error);
        assert.equal(result.stdout, "");
      }
    }
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
