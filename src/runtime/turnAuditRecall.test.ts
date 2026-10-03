import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createMemoryRuntime } from "./runtime.js";
import { TURN_AUDIT_TAG } from "./turnAudit.js";
import { JsonlMemoryStore } from "../store/store.js";
import { memoryScopeId } from "../identity/ids.js";
import type { MemoryPrincipalRef, MemoryRuntime, MemoryToolCall } from "../contract/types.js";

const roots: string[] = [];
const agora: MemoryPrincipalRef = { agentId: "agent-a", scope: "room", qualifier: "noopolis:agora" };
const wakeContext = { networkId: "noopolis", roomId: "agora" };

test.beforeEach(() => {
  process.env.NOOPOLIS_RUN_ID = "test-turn-audit-recall";
});

test.afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const newRuntime = async (): Promise<{ root: string; runtime: MemoryRuntime }> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mneme-turn-audit-"));
  roots.push(root);
  return { root, runtime: createMemoryRuntime({ agentId: "agent-a", runtimeHomePath: root, tokenBudget: 1200 }) };
};

const registerNote = async (runtime: MemoryRuntime, text: string): Promise<string> => {
  const requestId = `reg-${Math.random()}`;
  const args = { scope: "current", kind: "text", content: { kind: "text", text }, visibility: "room", sensitivity: "normal", source_type: "test" };
  const envelope = {
    version: "mneme.memory.tool.v1",
    mode: "awake",
    wake_id: "daimon:turn-audit-register",
    thread_id: "turn-audit-thread",
    principal: agora,
    conversation_scope: "noopolis:agora",
    audience_key: "turn-audit-test",
    policy_version: "test",
    allowed_scope_aliases: ["all", "current", "global"],
    transport: "in_process",
    nonce: requestId,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    capability: "memory"
  } as const;
  if (!runtime.authority) throw new Error("test runtime has no authority");
  const call: MemoryToolCall = {
    request_id: requestId,
    tool: "memory.register",
    arguments: args,
    envelope: { ...envelope, authority: runtime.authority.issue({ request_id: requestId, tool: "memory.register", arguments: args, envelope }) }
  };
  const result = await runtime.kernel.register(call);
  return result.content[0].event_ids[0];
};

const envelopeText = "Carry out this delivery. <delivery id=dlv-1 from=editor>roadmap verdict: rejected</delivery>";

test("a recorded wake keeps its envelope in the audit ledger but never as a recall candidate", async () => {
  const { root, runtime } = await newRuntime();
  const noteId = await registerNote(runtime, "Decision: the roadmap ships on Friday.");

  const first = await runtime.prepareTurn({ eventId: "moltnet:wake-1", kind: "message", from: "editor", text: envelopeText, context: wakeContext });
  await runtime.recordTurn({
    principal: first.principal,
    prompt: first.packet,
    request: { eventId: "moltnet:wake-1", kind: "message", from: "editor", text: envelopeText, context: wakeContext },
    recall: first.recall,
    result: "completed",
    outputText: "",
    toolEvents: [{ tool: "memory_search" }, { tool: "send_message" }]
  });

  const ledger = await new JsonlMemoryStore(root).read({ principalAgentId: "agent-a" });
  const auditRecords = ledger.filter((event) => event.tags.includes(TURN_AUDIT_TAG));
  assert.ok(auditRecords.some((event) => event.content.kind === "text" && event.content.text.includes("Carry out this delivery")));
  assert.ok(auditRecords.some((event) => event.content.kind === "text" && event.content.text.startsWith("Agent output:")));

  const next = await runtime.prepareTurn({ eventId: "moltnet:wake-2", kind: "message", from: "editor", text: "roadmap delivery verdict", context: wakeContext });
  assert.deepEqual(next.recall.selectedEventIds, [noteId]);
  const recalledText = next.packet.sections.map((section) => section.text).join("\n");
  assert.doesNotMatch(recalledText, /Carry out this delivery|Agent output:|tool event\(s\)/u);
});

test("recall ignores raw-envelope turn records already present in a pre-existing ledger", async () => {
  const { root, runtime } = await newRuntime();
  const noteId = await registerNote(runtime, "Decision: the roadmap ships on Friday.");
  const scope = memoryScopeId(agora);
  const legacy = { principal: agora, scope, visibility: "room" as const, source: "daimon/agent-a", entities: ["roadmap"], parentEventIds: [] };
  await new JsonlMemoryStore(root).appendBatch([
    { ...legacy, type: "memory.claimed", tags: ["roadmap"], content: { kind: "text", text: `Wake request moltnet:old-1 from editor: ${envelopeText}` } },
    { ...legacy, type: "memory.observed", tags: ["roadmap", "output", "completed"], content: { kind: "text", text: "Agent output: " } },
    { ...legacy, type: "memory.observed", tags: ["roadmap", "section"], content: { kind: "text", text: `${scope}: memory.claimed: Wake request moltnet:old-0 from editor: roadmap verdict` } },
    { ...legacy, type: "memory.summarized", source: "mneme/tool", tags: ["tool", "summary"], content: { kind: "text", text: "Observed 2 tool event(s) during turn." } }
  ]);

  const turn = await runtime.prepareTurn({ eventId: "moltnet:wake-3", kind: "message", from: "editor", text: "roadmap delivery verdict tool output", context: wakeContext });
  assert.deepEqual(turn.recall.selectedEventIds, [noteId]);
});
