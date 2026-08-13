import assert from "node:assert/strict";
import test from "node:test";

import {
  AWAKE_CAPABILITY,
  DREAM_CAPABILITY,
  SYSTEM_CAPABILITY,
  assertToolCapability,
  normalizeCapability,
  originForCapability,
  originForEnvelope
} from "./capability.js";
import { createMemoryToolEnvelope } from "../contract/toolDescriptors.js";
import type { MemoryToolCallEnvelope } from "../contract/types.js";

const baseEnvelope = (overrides: Partial<MemoryToolCallEnvelope> = {}): MemoryToolCallEnvelope => ({
  version: "mneme.memory.tool.v1",
  mode: "awake",
  wake_id: "wake-1",
  thread_id: "thread-1",
  principal: { agentId: "luna", scope: "global" },
  conversation_scope: "global",
  audience_key: "luna",
  policy_version: "test",
  allowed_scope_aliases: ["all", "current", "global"],
  transport: "in_process",
  nonce: "nonce-1",
  expires_at: new Date(Date.now() + 60_000).toISOString(),
  capability: "memory",
  ...overrides
});

test("normalizeCapability maps the legacy 'memory' token (and unset) to awake", () => {
  assert.equal(normalizeCapability("memory"), AWAKE_CAPABILITY);
  assert.equal(normalizeCapability(undefined), AWAKE_CAPABILITY);
  assert.equal(normalizeCapability(AWAKE_CAPABILITY), AWAKE_CAPABILITY);
  assert.equal(normalizeCapability(DREAM_CAPABILITY), DREAM_CAPABILITY);
  assert.equal(normalizeCapability("not-a-real-capability"), undefined);
});

test("originForCapability / originForEnvelope derive origin only from the capability token", () => {
  assert.equal(originForCapability(AWAKE_CAPABILITY), "awake");
  assert.equal(originForCapability(DREAM_CAPABILITY), "dream");
  assert.equal(originForEnvelope({ capability: "memory" }), "awake");
  assert.equal(originForEnvelope({ capability: DREAM_CAPABILITY }), "dream");
});

test("C2: legacy capability + awake mode is allowed for awake tools", () => {
  const result = assertToolCapability("memory.register", baseEnvelope());
  assert.equal(result.ok, true);
  assert.ok(result.ok && result.origin === "awake");
});

test("C2: awake mode with a dream capability token is a mode/capability mismatch -> malformed", () => {
  const result = assertToolCapability("memory.register", baseEnvelope({ capability: DREAM_CAPABILITY }));
  assert.equal(result.ok, false);
});

test("C2: dream mode with an awake capability token is a mode/capability mismatch -> malformed", () => {
  const result = assertToolCapability("memory.register", baseEnvelope({ mode: "dream", capability: AWAKE_CAPABILITY }));
  assert.equal(result.ok, false);
});

test("C2: an unknown capability token is rejected regardless of mode", () => {
  const result = assertToolCapability("memory.register", baseEnvelope({ capability: "totally-bogus" }));
  assert.equal(result.ok, false);
});

test("C1: awake capability may not call memory.promote", () => {
  const result = assertToolCapability("memory.promote", baseEnvelope());
  assert.equal(result.ok, false);
});

test("C1: dream capability may call memory.promote and stamps origin dream", () => {
  const result = assertToolCapability("memory.promote", baseEnvelope({ mode: "dream", capability: DREAM_CAPABILITY }));
  assert.equal(result.ok, true);
  assert.ok(result.ok && result.origin === "dream");
});

test("dream capability may still call awake-safe mutating tools (register/summarize/forget)", () => {
  for (const tool of ["memory.register", "memory.summarize", "memory.forget"] as const) {
    const result = assertToolCapability(tool, baseEnvelope({ mode: "dream", capability: DREAM_CAPABILITY }));
    assert.equal(result.ok, true, `dream capability should be allowed to call ${tool}`);
  }
});

// B62: mneme.cap.system.v1 (foreign-scope writes)

test("B62: normalizeCapability recognizes mneme.cap.system.v1", () => {
  assert.equal(normalizeCapability(SYSTEM_CAPABILITY), SYSTEM_CAPABILITY);
});

test("B62: originForCapability stamps 'system' for the system capability", () => {
  assert.equal(originForCapability(SYSTEM_CAPABILITY), "system");
});

test("B62: system capability may call all four mutating tools in either mode", () => {
  for (const mode of ["awake", "dream"] as const) {
    for (const tool of ["memory.register", "memory.summarize", "memory.forget", "memory.promote"] as const) {
      const result = assertToolCapability(tool, baseEnvelope({ mode, capability: SYSTEM_CAPABILITY }));
      assert.equal(result.ok, true, `system capability should be allowed to call ${tool} in ${mode} mode`);
    }
  }
});

test("B62: mneme.cap.system.v1 is never produced by the default (mode-derived) tool envelope", () => {
  for (const mode of ["awake", "dream"] as const) {
    const envelope = createMemoryToolEnvelope({
      mode,
      wakeId: "wake-descriptor-check",
      threadId: "thread-descriptor-check",
      principal: { agentId: "luna", scope: "global" },
      conversationScope: "global"
    });
    assert.notEqual(envelope.capability, SYSTEM_CAPABILITY);
  }
});
