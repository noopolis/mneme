import assert from "node:assert/strict";
import test from "node:test";

import { memoryPolicy } from "./policy.js";
import type { MemoryEvent, MemoryPrincipalRef } from "../contract/types.js";

const principal = (
  scope: MemoryPrincipalRef["scope"],
  qualifier?: string
): MemoryPrincipalRef => ({
  agentId: "athena",
  scope,
  qualifier
});

const event = (input: {
  principal: MemoryPrincipalRef;
  scope: string;
  text?: string;
}): MemoryEvent => ({
  id: "evt-policy",
  type: "memory.observed",
  createdAt: "2026-01-01T00:00:00.000Z",
  principal: input.principal,
  scope: input.scope,
  visibility: input.principal.scope === "team" ? "team" : "room",
  source: "test",
  content: {
    kind: "text",
    text: input.text ?? "policy test"
  },
  tags: [],
  entities: [],
  sensitivity: "normal",
  parentEventIds: [],
  checksum: "checksum",
  seq: 1
});

test("team and room memories require stored scope to match their source principal", () => {
  const request = principal("room", "org-a:strategy");

  assert.equal(memoryPolicy({
    request,
    candidate: event({
      principal: principal("team", "org-b:planning"),
      scope: "agent:athena/scope:team/qualifier:org-a:planning"
    })
  }).decision, "deny");

  assert.equal(memoryPolicy({
    request,
    candidate: event({
      principal: principal("team", "org-a:planning"),
      scope: "agent:athena/scope:team/qualifier:org-a:planning"
    })
  }).decision, "allow_summary");
});
