import assert from "node:assert/strict";
import test from "node:test";
import { registerInputSchema, schemaForModelToolName } from "./schemas.js";

const validRegister = {
  scope: "current",
  kind: "text",
  content: { kind: "text", text: "schema marker" },
  visibility: "private",
  sensitivity: "normal",
  source_type: "test"
};

test("B109 register schema binds provenance and rejects evidence or authority injection", () => {
  assert.equal(registerInputSchema.safeParse(validRegister).success, true);
  assert.equal(registerInputSchema.safeParse({ ...validRegister, evidence_event_ids: ["evt_external"] }).success, false);
  assert.equal(registerInputSchema.safeParse({ ...validRegister, principal: { agentId: "bob" } }).success, false);
  assert.match(registerInputSchema.description ?? "", /authenticated current invocation/);
  assert.equal(schemaForModelToolName("memory_register"), registerInputSchema);
});

test("B109 every model tool schema is strict", () => {
  for (const name of ["memory_search", "memory_locate", "memory_register", "memory_summarize", "memory_forget", "memory_promote"]) {
    assert.equal(schemaForModelToolName(name).safeParse({ authority: "forged" }).success, false);
  }
});
