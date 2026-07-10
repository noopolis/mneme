import assert from "node:assert/strict";
import test from "node:test";

import { AWAKE_CAPABILITY, DREAM_CAPABILITY, SYSTEM_CAPABILITY } from "./capability.js";
import { assertWriteScope } from "./writeScope.js";
import { memoryScopeId } from "../identity/ids.js";
import type { MemoryPrincipalRef, MemoryToolCallEnvelope } from "../contract/types.js";

const alice: MemoryPrincipalRef = { agentId: "alice", scope: "global" };
const bob: MemoryPrincipalRef = { agentId: "bob", scope: "global" };

const aliasesAll: MemoryToolCallEnvelope["allowed_scope_aliases"] = ["all", "current", "global"];
const aliasesCurrentOnly: MemoryToolCallEnvelope["allowed_scope_aliases"] = ["current"];

test("own current scope is always derivable", () => {
  const result = assertWriteScope(alice, aliasesCurrentOnly, memoryScopeId(alice), AWAKE_CAPABILITY);
  assert.equal(result.ok, true);
});

test("own global-variant scope is derivable only when the envelope grants the global alias", () => {
  const ownGlobal = memoryScopeId({ agentId: alice.agentId, scope: "global" });

  const granted = assertWriteScope(
    { agentId: alice.agentId, scope: "room", qualifier: "x" },
    aliasesAll,
    ownGlobal,
    AWAKE_CAPABILITY
  );
  assert.equal(granted.ok, true);

  const notGranted = assertWriteScope(
    { agentId: alice.agentId, scope: "room", qualifier: "x" },
    aliasesCurrentOnly,
    ownGlobal,
    AWAKE_CAPABILITY
  );
  assert.equal(notGranted.ok, false);
});

test("literal 'all' is derivable only when the envelope grants the all alias", () => {
  const granted = assertWriteScope(alice, aliasesAll, "all", AWAKE_CAPABILITY);
  assert.equal(granted.ok, true);

  const notGranted = assertWriteScope(alice, aliasesCurrentOnly, "all", AWAKE_CAPABILITY);
  assert.equal(notGranted.ok, false);
});

test("T1: a literal scope naming another agent's own scope is denied", () => {
  const foreignScope = memoryScopeId(bob);
  const result = assertWriteScope(alice, aliasesAll, foreignScope, AWAKE_CAPABILITY);
  assert.equal(result.ok, false);
  assert.ok(result.ok === false && result.reason.includes(SYSTEM_CAPABILITY));
});

test("dream capability does not by itself grant cross-scope writes", () => {
  const foreignScope = memoryScopeId(bob);
  const result = assertWriteScope(alice, aliasesAll, foreignScope, DREAM_CAPABILITY);
  assert.equal(result.ok, false);
});

test("mneme.cap.system.v1 always allows cross-scope writes", () => {
  const foreignScope = memoryScopeId(bob);
  const result = assertWriteScope(alice, aliasesCurrentOnly, foreignScope, SYSTEM_CAPABILITY);
  assert.equal(result.ok, true);
});
