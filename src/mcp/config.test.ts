import assert from "node:assert/strict";
import test from "node:test";

import { parseMnemeMcpArgs } from "./config.js";

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
