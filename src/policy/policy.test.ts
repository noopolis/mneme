import assert from "node:assert/strict";
import test from "node:test";

import { memoryPolicy } from "./policy.js";
import type { MemoryEvent, MemoryPrincipalRef } from "../contract/types.js";
import { runRecall } from "../recall/recall.js";

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
  visibility?: MemoryEvent["visibility"];
  sensitivity?: MemoryEvent["sensitivity"];
}): MemoryEvent => ({
  id: "evt-policy",
  type: "memory.observed",
  createdAt: "2026-01-01T00:00:00.000Z",
  principal: input.principal,
  scope: input.scope,
  visibility: input.visibility ?? (input.principal.scope === "team" ? "team" : "room"),
  source: "test",
  content: {
    kind: "text",
    text: input.text ?? "policy test"
  },
  tags: [],
  entities: [],
  sensitivity: input.sensitivity ?? "normal",
  parentEventIds: [],
  checksum: "checksum",
  seq: 1
});

test("B45 pair-visible secret memory never receives a prefix-bearing decision", () => {
  const pair: MemoryPrincipalRef = { agentId: "requester", scope: "pair", qualifier: "agent-b" };
  const matching = event({ principal: principal("pair", "agent-b"), scope: "agent:athena/scope:pair/qualifier:agent-b", visibility: "pair", sensitivity: "secret", text: "PAIR_SECRET_PREFIX" });
  const mismatched = event({ principal: principal("pair", "agent-c"), scope: "agent:athena/scope:pair/qualifier:agent-c", visibility: "pair", sensitivity: "secret", text: "OTHER_PAIR_SECRET_PREFIX" });
  assert.equal(memoryPolicy({ request: pair, candidate: matching }).decision, "allow_redacted_summary");
  assert.equal(memoryPolicy({ request: pair, candidate: mismatched }).decision, "known_but_private");
  const recall = runRecall({ actor: pair, events: [matching], scopeIds: [matching.scope], query: "PAIR_SECRET", maxTokens: 100 });
  assert.equal(recall.packet.sections[0]?.text.includes("PAIR_SECRET_PREFIX"), false);
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
  }).decision, "deny");
});
