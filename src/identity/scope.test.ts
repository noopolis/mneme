import assert from "node:assert/strict";
import test from "node:test";

import { readMemoryContext, resolveScopePlan } from "./scope.js";

test("resolves message wake to sender pair scope when from is present", () => {
  const plan = resolveScopePlan({
    agentId: "agent-a",
    context: {
      networkId: "noopolis",
      roomId: "agora",
      teamId: "team-a",
      from: "mapper",
      pairPeers: ["luna", "mapper"]
    },
    wake: {
      id: "evt-1",
      kind: "message",
      from: "mapper"
    }
  });

  assert.deepStrictEqual(plan.activePrincipal, {
    agentId: "agent-a",
    scope: "pair",
    qualifier: "mapper"
  });
  assert.ok(plan.readableScopes.some((scope) => scope.scope === "room" && scope.qualifier === "noopolis:agora"));
  assert.ok(plan.readableScopes.some((scope) => scope.scope === "team" && scope.qualifier === "team-a"));
});

test("reads context from event with from and legacy fields", () => {
  const event = readMemoryContext({
    id: "evt-2",
    kind: "schedule",
    from: "luna",
    text: "check-in",
    context: {
      networkId: "noopolis",
      roomId: "lab",
      artifactPaths: ["repos/product"],
      participants: ["alice"],
      from: "explicit"
    }
  });

  assert.equal(event.from, "luna");
  assert.equal(event.networkId, "noopolis");
  assert.equal(event.roomId, "lab");
  assert.equal(event.artifactPaths?.[0], "repos/product");
  assert.equal(event.participants?.[0], "alice");
  assert.equal(event.pairPeers?.[0], "alice");
});
