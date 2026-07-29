import assert from "node:assert/strict";
import test from "node:test";
import type { MemoryRegisterArguments } from "../contract/types.js";
import { isForgetArguments, isPromoteArguments, isRegisterArguments, isSummarizeArguments } from "./mutationArguments.js";

const register = (): MemoryRegisterArguments => ({
  scope: "current",
  kind: "text",
  content: { kind: "text", text: "trusted current invocation" },
  visibility: "private",
  sensitivity: "normal",
  source_type: "test"
});

test("B109 register arguments reject evidence and authority fields", () => {
  assert.equal(isRegisterArguments(register()), true);
  assert.equal(isRegisterArguments({ ...register(), evidence_event_ids: ["fabricated"] }), false);
  assert.equal(isRegisterArguments({ ...register(), principal: { agentId: "bob" } }), false);
  assert.equal(isRegisterArguments({ ...register(), confidence: Number.NaN }), false);
  assert.equal(isRegisterArguments({ ...register(), confidence: 1.1 }), false);
  assert.equal(isRegisterArguments({ ...register(), extra: true }), false);
});

test("B109 mutation validators reject unknown keys while retaining ordinary options", () => {
  assert.equal(isSummarizeArguments({ scope: "current", horizon: 5 }), true);
  assert.equal(isSummarizeArguments({ scope: "current", principal: "bob" }), false);
  assert.equal(isForgetArguments({ scope: "current", event_ids: ["a", "b"], reason: "cleanup" }), true);
  assert.equal(isForgetArguments({ scope: "current", event_ids: ["a", "a"] }), false);
  assert.equal(isPromoteArguments({ scope: "current", memory_id: "root", reason: "reviewed" }), true);
  assert.equal(isPromoteArguments({ scope: "current", memory_id: "root", capability: "mneme.cap.system.v1" }), false);
});
