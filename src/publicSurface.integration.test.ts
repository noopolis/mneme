import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.NOOPOLIS_RUN_ID = "test-public-surface-integration";

test.beforeEach(() => {
  process.env.NOOPOLIS_RUN_ID = "test-public-surface-integration";
});

import {
  createMemoryRuntime,
  MNEME_RECALL_MODE_ENV,
  readMemoryContext,
  resolveScopePlan
} from "./index.js";
import type { MemoryPrincipalRef, MemoryRuntime } from "./index.js";

const MARKER = "PUBLIC_SURFACE_NOVA_MARKER";
const DECOY = "PUBLIC_SURFACE_TONER_DECOY";
const agentId = "public-surface-agent";
const roomPrincipal: MemoryPrincipalRef = {
  agentId,
  scope: "room",
  qualifier: "noopolis:agora"
};
const globalPrincipal: MemoryPrincipalRef = { agentId, scope: "global" };

const context = readMemoryContext({
  id: "context-1",
  kind: "message",
  text: "status",
  context: { networkId: "noopolis", roomId: "agora" }
});

// Seeds a real memory through the kernel (the path an agent's own notes take);
// recordTurn writes turn-audit records, which are never recall candidates.
const seed = async (runtime: MemoryRuntime, principal: MemoryPrincipalRef, eventId: string, text: string) => {
  const args = { scope: "current", kind: "text", content: { kind: "text", text }, visibility: principal.scope, sensitivity: "normal", source_type: "test" };
  const envelope = {
    version: "mneme.memory.tool.v1",
    mode: "awake",
    wake_id: eventId,
    thread_id: "public-surface-thread",
    principal,
    conversation_scope: principal.qualifier ?? principal.scope,
    audience_key: "public-surface",
    policy_version: "test",
    allowed_scope_aliases: ["all", "current", "global"],
    transport: "in_process",
    nonce: `${eventId}:register`,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    capability: "memory"
  } as const;
  if (!runtime.authority) throw new Error("test runtime has no authority");
  const request_id = `${eventId}:register`;
  const result = await runtime.kernel.register({
    request_id,
    tool: "memory.register",
    arguments: args,
    envelope: { ...envelope, authority: runtime.authority.issue({ request_id, tool: "memory.register", arguments: args, envelope }) }
  });
  assert.equal(result.content[0].event_ids.length, 1);
};

const recallForMode = async (mode: "on" | "off" | "shuffled") => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mneme-public-surface-"));
  const previous = process.env[MNEME_RECALL_MODE_ENV];
  process.env[MNEME_RECALL_MODE_ENV] = mode;

  try {
    const runtime = createMemoryRuntime({ agentId, runtimeHomePath: root, tokenBudget: 128 });
    await seed(runtime, roomPrincipal, "daimon:seed-marker", `${MARKER} launch status ${"x".repeat(560)}`);
    await seed(runtime, globalPrincipal, "daimon:seed-decoy", `${DECOY} printer status`);
    return await runtime.prepareTurn({
      context,
      eventId: `daimon:query-${mode}`,
      kind: "message",
      text: "launch status"
    });
  } finally {
    if (previous === undefined) {
      delete process.env[MNEME_RECALL_MODE_ENV];
    } else {
      process.env[MNEME_RECALL_MODE_ENV] = previous;
    }
    await rm(root, { recursive: true, force: true });
  }
};

test("the public barrel supports scoped runtime recall modes", async () => {
  const scopePlan = resolveScopePlan({
    agentId,
    context,
    wake: { id: "scope-1", kind: "message" }
  });
  assert.deepEqual(scopePlan.activePrincipal, roomPrincipal);
  assert.equal(scopePlan.readableScopes.some((scope) => scope.scope === "global"), true);

  const on = await recallForMode("on");
  const off = await recallForMode("off");
  const shuffled = await recallForMode("shuffled");

  assert.equal(on.promptText.includes(MARKER), true);
  assert.equal(off.recall.selectedEventIds.length, 0);
  assert.equal(off.promptText.includes(MARKER), false);
  assert.equal(off.promptText.includes(DECOY), false);
  assert.equal(shuffled.promptText.includes(MARKER), false);
  assert.equal(shuffled.promptText.includes(DECOY), true);
});
