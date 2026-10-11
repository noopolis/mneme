import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createMemoryToolEnvelope } from "../contract/toolDescriptors.js";
import { CausalEventStore } from "../store/causalStore.js";
import { JsonlMemoryStore } from "../store/store.js";
import { denyWriteScope } from "./support.js";

process.env.NOOPOLIS_RUN_ID = "test-denial-clocks";

test("public denial writer rejects mixed stores before either ledger write", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mneme-denial-clock-"));
  try {
    const clock = () => Date.parse("2000-01-01T00:00:00Z");
    const store = new JsonlMemoryStore(root, { clock });
    const causalStore = new CausalEventStore(root);
    const call = {
      request_id: "deny-clock", tool: "memory.register" as const, arguments: {},
      envelope: createMemoryToolEnvelope({
        clock, wakeId: "daimon:deny-clock", threadId: "deny-clock",
        principal: { agentId: "agent-a", scope: "global" }, conversationScope: "global"
      })
    };
    await assert.rejects(denyWriteScope(store, causalStore, call, call.tool, "foreign", "test", Date.now()), /dependency clock.*match/);
    assert.deepEqual(await store.read(), []);
    assert.deepEqual(await causalStore.read(), []);
    const matching = new CausalEventStore(root, { clock });
    const result = await denyWriteScope(store, matching, call, call.tool, "foreign", "test", Date.now());
    assert.equal(result.decision, "deny");
    assert.equal((await store.read())[0].createdAt, "2000-01-01T00:00:00.000Z");
    assert.equal((await matching.read())[0].recorded_at, "2000-01-01T00:00:00.000Z");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
