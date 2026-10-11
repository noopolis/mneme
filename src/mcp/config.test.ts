import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.NOOPOLIS_RUN_ID = "test-mcp-config";

import { createMcpToolContext, parseMnemeMcpArgs, resolveMnemeMcpConfig } from "./config.js";
import { createMemoryRuntime } from "../runtime/runtime.js";
import { memoryScopeId } from "../identity/ids.js";
import { wallClock } from "../contract/clock.js";
import { createMemoryToolDescriptors } from "../contract/toolDescriptors.js";

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

const clockEnv = { MNEME_RUNTIME_HOME: "/tmp/mneme", MNEME_AGENT_ID: "clock-agent" };

test("clock flags and env produce advancing clocks with flags taking precedence", (t) => {
  let now = 10_000;
  t.mock.method(Date, "now", () => now);
  const env = { ...clockEnv, MNEME_CLOCK_ORIGIN: "2000-01-01T02:00:00+02:00", MNEME_CLOCK_ANCHOR_MS: "9000" };
  const fromEnv = parseMnemeMcpArgs([], env).clock!;
  const fromFlags = parseMnemeMcpArgs(["--clock-origin", "2001-01-01T00:00:00Z", "--clock-anchor-ms", "8000"], env).clock!;
  assert.equal(fromEnv(), Date.parse("2000-01-01T00:00:01Z"));
  assert.equal(fromFlags(), Date.parse("2001-01-01T00:00:02Z"));
  now += 250;
  assert.equal(fromEnv(), Date.parse("2000-01-01T00:00:01.250Z"));
  assert.equal(fromFlags(), Date.parse("2001-01-01T00:00:02.250Z"));
});

test("omitted anchor uses config parse time, not first invocation time", (t) => {
  let now = 10_000;
  t.mock.method(Date, "now", () => now);
  const config = parseMnemeMcpArgs(["--clock-origin", "2000-01-01T00:00:00Z"], clockEnv);
  now += 500;
  assert.equal(config.clock!(), Date.parse("2000-01-01T00:00:00.500Z"));
  assert.equal(parseMnemeMcpArgs([], clockEnv).clock, undefined);
});

test("invalid clock flags and env fail parsing instead of falling back", () => {
  const cases: Array<{ origin?: string; anchor?: string; error: RegExp }> = [
    ...["", "bad", "2000-01-01T00:00:00", "2000-02-30T00:00:00Z"].map((origin) => ({ origin, error: /clock origin/ })),
    ...["", "1.5", "1e3", "12ms", "NaN", "Infinity", "9007199254740992"].map((anchor) => ({ origin: "2000-01-01T00:00:00Z", anchor, error: /clock.*(?:anchor|ANCHOR).*integer/ })),
    { anchor: "123", error: /requires.*clock-origin/ }
  ];
  for (const { origin, anchor, error } of cases) {
    const flags = [...(origin === undefined ? [] : ["--clock-origin", origin]), ...(anchor === undefined ? [] : ["--clock-anchor-ms", anchor])];
    assert.throws(() => parseMnemeMcpArgs(flags, clockEnv), error);
    assert.throws(() => parseMnemeMcpArgs([], { ...clockEnv, MNEME_CLOCK_ORIGIN: origin, MNEME_CLOCK_ANCHOR_MS: anchor }), error);
  }
  assert.throws(() => parseMnemeMcpArgs(["--clock-origin"], clockEnv), /clock origin/);
  assert.throws(() => parseMnemeMcpArgs(["--clock-origin", "2000-01-01T00:00:00Z", "--clock-anchor-ms"], clockEnv), /integer/);
});

test("clock configuration rejects unrepresentable timestamps and expiry overflow through flags and env", (t) => {
  t.mock.method(Date, "now", () => 0);
  for (const [origin, anchor] of [
    ["2000-01-01T00:00:00Z", "-9007199254740991"],
    ["2000-01-01T00:00:00Z", "9007199254740991"],
    ["1970-01-01T00:00:00Z", "-8639999999700001"],
    ["+275760-09-13T00:00:00Z", undefined],
    ["+010000-01-01T00:00:00Z", undefined], ["-000001-01-01T00:00:00Z", undefined],
    ["9999-12-31T23:55:00Z", undefined],
    ["1970-01-01T00:00:00Z", String(-(Date.parse("0000-01-01T00:00:00Z") - 1))],
    ["1970-01-01T00:00:00Z", String(-(Date.parse("9999-12-31T23:54:59.999Z") + 1))]
  ] as const) {
    const flags = ["--clock-origin", origin, ...(anchor === undefined ? [] : ["--clock-anchor-ms", anchor])];
    const error = /clock configuration.*timestamp.*envelope expiry.*date range/;
    assert.throws(() => parseMnemeMcpArgs(flags, clockEnv), error);
    assert.throws(() => parseMnemeMcpArgs([], {
      ...clockEnv, MNEME_CLOCK_ORIGIN: origin, MNEME_CLOCK_ANCHOR_MS: anchor
    }), error);
  }
});

test("MCP context and constructed runtime share the configured clock", async () => {
  const clock = () => Date.parse("2000-01-01T00:00:00Z");
  const resolved = resolveMnemeMcpConfig({ runtimeHomePath: await temp(), agentId: "luna", clock });
  assert.equal(resolved.runtime.clock, resolved.clock);
  assert.equal(createMcpToolContext(resolved, "memory_search").expiresAt, "2000-01-01T00:05:00.000Z");
  const inherited = resolveMnemeMcpConfig({ runtimeHomePath: resolved.runtimeHomePath, agentId: "luna", runtime: resolved.runtime });
  assert.equal(inherited.clock, resolved.clock);
  const matched = resolveMnemeMcpConfig({ runtimeHomePath: resolved.runtimeHomePath, agentId: "luna", runtime: resolved.runtime, clock });
  assert.equal(matched.runtime, resolved.runtime);
});

test("MCP rejects supplied runtimes with a different or unexposed clock", async () => {
  const root = await temp();
  const clock = () => Date.parse("2000-01-01T00:00:00Z");
  const defaultRuntime = createMemoryRuntime({ runtimeHomePath: root, agentId: "luna" });
  const runtime = createMemoryRuntime({ runtimeHomePath: root, agentId: "luna", clock });
  for (const [supplied, configured] of [
    [defaultRuntime, clock], [runtime, wallClock], [runtime, () => clock()],
    [{ ...runtime, clock: undefined }, clock], [{ ...runtime, clock: undefined }, undefined],
    [{ ...runtime, kernel: defaultRuntime.kernel }, undefined],
    [{ ...runtime, kernel: { ...runtime.kernel, clock: undefined } }, clock]
  ] as const) {
    assert.throws(() => resolveMnemeMcpConfig({
      runtimeHomePath: root, agentId: "luna", runtime: supplied, clock: configured
    }), /dependency clock.*match.*configured clock/);
  }
});

test("MCP preserves legacy no-clock runtimes through descriptor invocation", async () => {
  const root = await temp();
  const runtime = createMemoryRuntime({ runtimeHomePath: root, agentId: "luna" });
  Object.defineProperty(runtime, "clock", { value: undefined });
  Object.defineProperty(runtime.kernel, "clock", { value: undefined });
  const resolved = resolveMnemeMcpConfig({ runtimeHomePath: root, agentId: "luna", runtime });
  assert.equal(resolved.clock, wallClock);
  const context = createMcpToolContext(resolved, "memory_search");
  assert.equal(context.clock, undefined);
  const descriptors = createMemoryToolDescriptors(resolved.runtime.kernel);
  const result = await descriptors[0].invoke({ query: "legacy", scope: "current" }, context);
  assert.equal(result.decision, "deny");
  assert.deepEqual(result.content, []);
  assert.throws(() => resolveMnemeMcpConfig({
    runtimeHomePath: root, agentId: "luna", runtime, clock: wallClock
  }), /dependency clock.*match/);
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
