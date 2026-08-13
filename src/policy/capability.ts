import type {
  MemoryCapability,
  MemoryOrigin,
  MemoryToolCallEnvelope,
  MemoryToolName
} from "../contract/types.js";

/**
 * B59 capability guard (pairs with B27). Called at the top of every
 * mutating memory tool (register/summarize/forget/promote) in
 * src/kernel/kernel.ts. Mneme's job here is narrow: refuse writes the
 * capability does not allow, and stamp `origin` from the *validated*
 * capability — never from model-supplied arguments. Withholding downstream
 * (e.g. Moltnet) credentials from dream-mode calls is B27's job, not this
 * module's.
 */

export const AWAKE_CAPABILITY: MemoryCapability = "mneme.cap.awake.v1";
export const DREAM_CAPABILITY: MemoryCapability = "mneme.cap.dream.v1";
/**
 * B62 foreign-scope-write escalation. Unlike AWAKE/DREAM, this capability is
 * never produced by createMemoryToolEnvelope's mode-derived default and
 * never appears in a tool descriptor or MCP surface — it is only ever set
 * by a trusted execution context explicitly passing
 * `MemoryToolExecutionContext.capability`, never by model output or tool
 * arguments. See policy/writeScope.ts, the guard this capability bypasses.
 */
export const SYSTEM_CAPABILITY: MemoryCapability = "mneme.cap.system.v1";

/** Legacy envelopes (pre-B59) always carried the literal string "memory". */
const LEGACY_CAPABILITY_TOKEN = "memory";

const AWAKE_ALLOWED_TOOLS: ReadonlySet<MemoryToolName> = new Set([
  "memory.search",
  "memory.locate",
  "memory.register",
  "memory.summarize",
  "memory.forget"
]);

const DREAM_ALLOWED_TOOLS: ReadonlySet<MemoryToolName> = new Set([
  ...AWAKE_ALLOWED_TOOLS,
  "memory.promote"
]);

/** System capability only ever reaches the four mutating tools it exists to unblock. */
const SYSTEM_ALLOWED_TOOLS: ReadonlySet<MemoryToolName> = new Set([
  "memory.register",
  "memory.summarize",
  "memory.forget",
  "memory.promote"
]);

const ALLOWED_TOOLS_BY_CAPABILITY: Record<MemoryCapability, ReadonlySet<MemoryToolName>> = {
  [AWAKE_CAPABILITY]: AWAKE_ALLOWED_TOOLS,
  [DREAM_CAPABILITY]: DREAM_ALLOWED_TOOLS,
  [SYSTEM_CAPABILITY]: SYSTEM_ALLOWED_TOOLS
};

/** Maps a raw envelope capability string onto a known capability token, defaulting legacy "memory" (and any unset value) to awake. */
export const normalizeCapability = (raw: string | undefined): MemoryCapability | undefined => {
  if (raw === AWAKE_CAPABILITY || raw === DREAM_CAPABILITY || raw === SYSTEM_CAPABILITY) {
    return raw;
  }
  if (raw === undefined || raw === LEGACY_CAPABILITY_TOKEN) {
    return AWAKE_CAPABILITY;
  }
  return undefined;
};

export const originForCapability = (capability: MemoryCapability): MemoryOrigin => {
  if (capability === DREAM_CAPABILITY) {
    return "dream";
  }
  if (capability === SYSTEM_CAPABILITY) {
    return "system";
  }
  return "awake";
};

/** Derives origin straight from the envelope's capability, defaulting unknown/legacy tokens to awake. Never reads mode or args. */
export const originForEnvelope = (envelope: Pick<MemoryToolCallEnvelope, "capability">): MemoryOrigin =>
  originForCapability(normalizeCapability(envelope.capability) ?? AWAKE_CAPABILITY);

export type CapabilityCheckResult =
  | { ok: true; capability: MemoryCapability; origin: MemoryOrigin }
  | { ok: false; reason: string };

/**
 * Validates that `tool` may run under `envelope`'s capability, and that the
 * envelope's declared mode agrees with that capability (a dream-mode call
 * carrying an awake capability, or vice versa, is malformed — this is the
 * only place origin is decided, and it is always derived here, never from
 * tool arguments).
 */
export const assertToolCapability = (
  tool: MemoryToolName,
  envelope: MemoryToolCallEnvelope
): CapabilityCheckResult => {
  const capability = normalizeCapability(envelope.capability);
  if (!capability) {
    return { ok: false, reason: `unknown capability token: ${envelope.capability}` };
  }

  if (envelope.mode === "dream" && capability === AWAKE_CAPABILITY) {
    return { ok: false, reason: "dream mode requires a dream capability token" };
  }
  if (envelope.mode === "awake" && capability === DREAM_CAPABILITY) {
    return { ok: false, reason: "awake mode may not use a dream capability token" };
  }

  if (!ALLOWED_TOOLS_BY_CAPABILITY[capability].has(tool)) {
    return { ok: false, reason: `capability ${capability} may not call ${tool}` };
  }

  return { ok: true, capability, origin: originForCapability(capability) };
};
