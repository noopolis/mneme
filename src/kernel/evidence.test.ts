import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.NOOPOLIS_RUN_ID = "test-kernel-evidence";

import { memoryScopeId } from "../identity/ids.js";
import { createMemoryAuthorityHandoff, type MemoryAuthorityConfig } from "../policy/authority.js";
import { CausalEventStore } from "../store/causalStore.js";
import { JsonlMemoryStore } from "../store/store.js";
import type {
  MemoryExecutableToolName,
  MemoryPrincipalRef,
  MemoryToolCall,
  MemoryToolDecision,
  MemoryToolResult
} from "../contract/types.js";
import { createMemoryKernel } from "./kernel.js";

const tools: MemoryExecutableToolName[] = [
  "memory.search", "memory.locate", "memory.register", "memory.summarize", "memory.forget", "memory.promote"
];
const decisions = ["success", "deny", "malformed", "unavailable"] as const;
type OutcomeClass = (typeof decisions)[number];

const roots: string[] = [];
const temp = async (): Promise<string> => { const root = await mkdtemp(path.join(os.tmpdir(), "mneme-evidence-matrix-")); roots.push(root); return root; };
test.afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const principal: MemoryPrincipalRef = { agentId: "agent-a", scope: "global" };
const scope = memoryScopeId(principal);
const authority: MemoryAuthorityConfig = { secret: "matrix-trusted-authority", bankId: principal.agentId, runtimeId: "matrix-runtime" };
const handoff = createMemoryAuthorityHandoff(authority);

const seed = async (root: string, marker: string): Promise<string> => (await new JsonlMemoryStore(root).append({
  type: "memory.observed",
  principal,
  scope,
  visibility: "global",
  source: "evidence-matrix",
  content: { kind: "text", text: marker },
  tags: ["matrix"],
  entities: [principal.agentId],
  sensitivity: "normal",
  parentEventIds: []
})).id;

const expectedSuccess: Record<MemoryExecutableToolName, MemoryToolDecision> = {
  "memory.search": "allow_raw",
  "memory.locate": "locate_only",
  "memory.register": "allow_raw",
  "memory.summarize": "allow_summary",
  "memory.forget": "allow_raw",
  "memory.promote": "allow_raw"
};

const setup = async (
  root: string,
  tool: MemoryExecutableToolName,
  outcomeClass: OutcomeClass,
  marker: string
): Promise<Record<string, unknown>> => {
  if (outcomeClass === "malformed") return {};
  if (outcomeClass === "unavailable") {
    await mkdir(path.join(root, "memory", "events.jsonl"), { recursive: true });
  }
  let target = "evt_missing";
  if (outcomeClass === "success" && ["memory.search", "memory.locate", "memory.summarize", "memory.forget", "memory.promote"].includes(tool)) {
    target = await seed(root, marker);
  }
  const selectedScope = outcomeClass === "deny" && ["memory.register", "memory.forget", "memory.promote"].includes(tool)
    ? memoryScopeId({ agentId: "agent-b", scope: "global" })
    : scope;
  switch (tool) {
    case "memory.search": return { scope: "current", query: marker };
    case "memory.locate": return { query: marker };
    case "memory.register": return {
      scope: selectedScope, kind: "text", content: { kind: "text", text: marker }, visibility: "global",
      sensitivity: "normal", source_type: "matrix"
    };
    case "memory.summarize": return { scope: "current", horizon: 5 };
    case "memory.forget": return { scope: selectedScope, event_ids: [target], reason: marker };
    case "memory.promote": return { scope: selectedScope, memory_id: target, reason: marker };
  }
};

const makeCall = (
  tool: MemoryExecutableToolName,
  outcomeClass: OutcomeClass,
  args: Record<string, unknown>,
  marker: string
): MemoryToolCall => {
  const requestId = `req:${tool}:${outcomeClass}:${marker}`;
  const dream = tool === "memory.promote";
  const unsigned = {
    version: "mneme.memory.tool.v1" as const,
    mode: dream ? "dream" as const : "awake" as const,
    wake_id: `mneme:mcp-${tool.slice("memory.".length)}-${outcomeClass}`,
    thread_id: "thread:matrix",
    principal,
    conversation_scope: scope,
    audience_key: "audience:matrix",
    policy_version: "memory-policy.v1",
    allowed_scope_aliases: ["all", "current", "global"] as const,
    transport: "mcp" as const,
    nonce: `nonce:${tool}:${outcomeClass}`,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    capability: dream ? "mneme.cap.dream.v1" : "memory"
  };
  const base = { request_id: requestId, tool, arguments: args, envelope: unsigned };
  return { ...base, envelope: { ...unsigned, authority: handoff.issue(base) } };
};

const invoke = (kernel: ReturnType<typeof createMemoryKernel>, call: MemoryToolCall): Promise<MemoryToolResult> => {
  switch (call.tool) {
    case "memory.search": return kernel.search(call);
    case "memory.locate": return kernel.locate(call);
    case "memory.register": return kernel.register(call);
    case "memory.summarize": return kernel.summarize(call);
    case "memory.forget": return kernel.forget(call);
    case "memory.promote": return kernel.promote(call);
    default: throw new Error(`non-executable tool ${call.tool}`);
  }
};

for (const tool of tools) {
  for (const outcomeClass of decisions) {
    test(`B45 ${tool} emits one authenticated, content-free ${outcomeClass} outcome`, async () => {
      const root = await temp();
      const marker = `TOP_SECRET_${tool}_${outcomeClass}`;
      const args = await setup(root, tool, outcomeClass, marker);
      const call = makeCall(tool, outcomeClass, args, marker);
      const result = await invoke(createMemoryKernel({ runtimeHomePath: root, source: "matrix", authority }), call);
      const expected = outcomeClass === "success" ? expectedSuccess[tool]
        : outcomeClass === "deny" ? "deny"
          : outcomeClass === "malformed" ? "malformed_request"
            : "unavailable";
      assert.equal(result.decision, expected);

      const events = await new CausalEventStore(root).read();
      const requestHash = createHash("sha256").update(call.request_id).digest("hex");
      const outcomes = events.filter((event) => event.type === "memory.tool.outcome" && event.payload.request_sha256 === requestHash);
      assert.equal(outcomes.length, 1);
      assert.equal(outcomes[0].payload.tool, tool);
      assert.equal(outcomes[0].payload.decision, expected);
      assert.equal(outcomes[0].principal_id, `agent:${principal.agentId}`);
      assert.deepEqual(outcomes[0].cause_event_ids, [call.envelope.wake_id]);
      assert.equal(events.some((event) => event.event_id === call.envelope.wake_id && event.type === "memory.tool.request"), true);
      assert.equal(JSON.stringify(events).includes(marker), false);
      if (outcomeClass === "success" && tool === "memory.summarize") {
        const writes = events.filter((event) => event.type === "memory.summary.written");
        assert.equal(writes.length, 1);
        assert.deepEqual(Object.keys(writes[0].payload).sort(), ["result_memory_id", "result_revision_id", "result_sha256", "scope_sha256", "source_event_ids", "source_sha256"]);
      }
      if (outcomeClass === "success" && tool === "memory.forget") {
        const effects = events.filter((event) => event.type === "memory.lifecycle.forgotten");
        assert.equal(effects.length, 1);
        assert.deepEqual(Object.keys(effects[0].payload).sort(), ["result_event_id", "result_sha256", "scope_sha256", "target_event_ids", "target_sha256"]);
      }
      if (outcomeClass === "success" && tool === "memory.promote") {
        const effects = events.filter((event) => event.type === "memory.lifecycle.promoted");
        assert.equal(effects.length, 1);
        assert.deepEqual(Object.keys(effects[0].payload).sort(), ["memory_id", "result_event_id", "result_sha256", "scope_sha256", "target_revision_id", "target_revision_sha256"]);
      }
    });
  }
}
