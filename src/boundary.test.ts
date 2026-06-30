import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const memorySourceDir = new URL(".", import.meta.url);

const sourceFiles = async (directory: string = memorySourceDir.pathname): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(entryPath);
    }
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [entryPath] : [];
  }));
  return files.flat();
};

test("memory package boundary does not import Daimon core or Pi adapter code", async () => {
  const offenders: string[] = [];
  for (const filePath of await sourceFiles()) {
    const text = await readFile(filePath, "utf8");
    if (text.includes("from \"../core/") || text.includes("from \"../pi/")) {
      offenders.push(path.basename(filePath));
    }
  }

  assert.deepEqual(offenders, []);
});
