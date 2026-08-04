import assert from "node:assert/strict";
import test from "node:test";
import {
  forgetInputSchema,
  locateInputSchema,
  promoteInputSchema,
  registerInputSchema,
  schemaForModelToolName,
  searchInputSchema,
  summarizeInputSchema
} from "./schemas.js";

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
  const schemas = {
    memory_search: searchInputSchema,
    memory_locate: locateInputSchema,
    memory_register: registerInputSchema,
    memory_summarize: summarizeInputSchema,
    memory_forget: forgetInputSchema,
    memory_promote: promoteInputSchema
  } as const;
  for (const [name, schema] of Object.entries(schemas)) {
    assert.equal(schemaForModelToolName(name), schema);
    assert.equal(schemaForModelToolName(name).safeParse({ authority: "forged" }).success, false);
  }
  assert.throws(() => schemaForModelToolName("memory_typo"), /memory_typo/u);
});
