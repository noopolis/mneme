import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createMcpToolContext, parseMnemeMcpArgs, resolveMnemeMcpConfig } from "./config.js";
import { createMemoryRuntime } from "../runtime/runtime.js";
import { memoryScopeId } from "../identity/ids.js";

const roots: string[] = [];
const temp = async (): Promise<string> => { const root = await mkdtemp(path.join(os.tmpdir(), "mneme-mcp-config-")); roots.push(root); return root; };
test.afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

test("parseMnemeMcpArgs reads embedding options", () => {
  const config = parseMnemeMcpArgs([
    "mcp",
    "--runtime-home",
    "/tmp/mneme",
    "--agent-id",
    "luna",
    "--embedding-provider",
    "ollama",
    "--embedding-model",
    "qwen3-embedding:0.6b",
    "--embedding-base-url",
    "http://127.0.0.1:11434",
    "--embedding-dimensions",
    "1024",
    "--embedding-timeout-ms",
    "2500"
  ], {});

  assert.deepEqual(config.embedding, {
    baseUrl: "http://127.0.0.1:11434",
    dimensions: 1024,
    model: "qwen3-embedding:0.6b",
    provider: "ollama",
    timeoutMs: 2500
  });

  assert.equal(config.mode, "awake");
});

test("parseMnemeMcpArgs reads wake mode from CLI and env", () => {
  const config = parseMnemeMcpArgs([
    "--runtime-home",
    "/tmp/mneme",
    "--agent-id",
    "luna",
    "--mode",
    "dream"
  ], {});

  assert.equal(config.mode, "dream");

  const envConfig = parseMnemeMcpArgs([], {
    MNEME_RUNTIME_HOME: "/tmp/mneme",
    MNEME_AGENT_ID: "luna",
    MNEME_MODE: "dream"
  });

  assert.equal(envConfig.mode, "dream");
});

test("parseMnemeMcpArgs rejects invalid wake mode", () => {
  assert.throws(() =>
    parseMnemeMcpArgs([
      "--runtime-home",
      "/tmp/mneme",
      "--agent-id",
      "luna",
      "--mode",
      "offline"
    ], {}),
  /mneme mcp mode must be \"awake\" or \"dream\"/);
});

test("B45 MCP rejects a runtime authority from another bank or runtime home", async () => {
  const first = await temp();
  const second = await temp();
  const runtime = createMemoryRuntime({ agentId: "luna", runtimeHomePath: first });
  assert.throws(() => resolveMnemeMcpConfig({ runtimeHomePath: second, agentId: "luna", runtime }), /does not match/);
  assert.throws(() => resolveMnemeMcpConfig({ runtimeHomePath: first, agentId: "attacker", runtime }), /does not match/);
});

test("B45 MCP parses and lowers a finite allowed-scope set without all", async () => {
  const root = await temp();
  const principal = { agentId: "luna", scope: "room" as const, qualifier: "network:room" };
  const current = memoryScopeId(principal);
  const global = memoryScopeId({ agentId: "luna", scope: "global" });
  const parsed = parseMnemeMcpArgs([
    "--runtime-home", root,
    "--agent-id", "luna",
    "--allowed-scopes", `${current},${global}`
  ], {});
  assert.deepEqual(parsed.allowedScopes, [current, global]);

  const runtime = createMemoryRuntime({ agentId: "luna", runtimeHomePath: root });
  const resolved = resolveMnemeMcpConfig({
    ...parsed,
    agentScope: "room",
    agentQualifier: "network:room",
    runtime
  });
  assert.deepEqual(resolved.allowedScopes, [current, global]);
  assert.deepEqual(createMcpToolContext(resolved, "memory_search").allowedScopes, [current, global]);
  assert.throws(() => resolveMnemeMcpConfig({ runtimeHomePath: root, agentId: "luna", runtime, allowedScopes: ["all"] }), /finite allowed-scope/);
});
