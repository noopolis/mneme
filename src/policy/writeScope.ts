import type { MemoryCapability } from "../contract/lifecycleTypes.js";
import type { MemoryPrincipalRef, MemoryToolCallEnvelope } from "../contract/types.js";
import { memoryScopeId } from "../identity/ids.js";
import { SYSTEM_CAPABILITY } from "./capability.js";

/**
 * B62 write-scope guard (pairs with B59's capability.ts). Closes the hole in
 * kernel/support.ts's `resolveScope`: outside the "all"/"current"/"global"
 * aliases, that function passes a literal, model-supplied `args.scope`
 * straight through as the resolved write scope with zero check — a
 * mutating tool call can name another agent's scope verbatim and write
 * into it. Called from kernel/mutations.ts, after `assertToolCapability`,
 * in all four mutating tools (register/summarize/forget/promote).
 *
 * `principal` and `allowedScopeAliases` MUST be read from the trusted
 * envelope (`call.envelope.principal` / `call.envelope.allowed_scope_aliases`)
 * — never from tool arguments or model output. This mirrors capability.ts's
 * origin discipline exactly: the envelope is minted by the trusted harness
 * (see MemoryToolExecutionContext), tool arguments are not. `resolvedScope`
 * is the (possibly attacker-influenced) literal scope string already
 * computed by kernel/support.ts's `resolveScope`; `capability` is the
 * validated capability token returned by `assertToolCapability`.
 */

export type WriteScopeCheckResult =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * The set of scope strings a principal can legitimately produce through
 * `resolveScope`, given the trusted envelope's own alias grants: its own
 * canonical scope (the "current" alias) and its own global variant when the
 * envelope grants the "global" alias. The literal "all" wildcard is never a
 * normal write grant; only the trusted system capability may cross scopes.
 * Any resolved scope outside this set was not derived from this principal's
 * own identity.
 */
const derivableWriteScopes = (
  principal: MemoryPrincipalRef,
  allowedScopeAliases: MemoryToolCallEnvelope["allowed_scope_aliases"]
): Set<string> => {
  const scopes = new Set<string>([memoryScopeId(principal)]);

  if (allowedScopeAliases.includes("global")) {
    scopes.add(memoryScopeId({ agentId: principal.agentId, scope: "global" }));
  }
  return scopes;
};

/**
 * Denies whenever `resolvedScope` is not derivable from `principal` (and
 * the envelope's own alias grants) — unless `capability` is
 * `mneme.cap.system.v1`, the one authority allowed to write across scopes.
 * That capability is never defaulted by tool descriptors and never reaches
 * the model; it is only ever set by a trusted execution context.
 */
export const assertWriteScope = (
  principal: MemoryPrincipalRef,
  allowedScopeAliases: MemoryToolCallEnvelope["allowed_scope_aliases"],
  resolvedScope: string,
  capability: MemoryCapability
): WriteScopeCheckResult => {
  if (capability === SYSTEM_CAPABILITY) {
    return { ok: true };
  }

  if (derivableWriteScopes(principal, allowedScopeAliases).has(resolvedScope)) {
    return { ok: true };
  }

  return {
    ok: false,
    reason: `scope "${resolvedScope}" is not derivable from principal "${principal.agentId}" and requires ${SYSTEM_CAPABILITY}`
  };
};
