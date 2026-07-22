import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

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

const seed = async (runtime: MemoryRuntime, principal: MemoryPrincipalRef, eventId: string, text: string) => {
  await runtime.recordTurn({
    outputText: text,
    principal,
    prompt: { principal, rawHint: "seed", sections: [] },
    request: { context, eventId, kind: "manual", text },
    result: "completed",
    toolEvents: []
  });
};

const recallForMode = async (mode: "on" | "off" | "shuffled") => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mneme-public-surface-"));
  const previous = process.env[MNEME_RECALL_MODE_ENV];
  process.env[MNEME_RECALL_MODE_ENV] = mode;

  try {
    const runtime = createMemoryRuntime({ agentId, runtimeHomePath: root, tokenBudget: 128 });
    await seed(runtime, roomPrincipal, "seed-marker", `${MARKER} launch status ${"x".repeat(560)}`);
    await seed(runtime, globalPrincipal, "seed-decoy", `${DECOY} printer status`);
    return await runtime.prepareTurn({
      context,
      eventId: `query-${mode}`,
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
